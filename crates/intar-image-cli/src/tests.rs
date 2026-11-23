use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::thread::JoinHandle;

use clap::{CommandFactory, Parser, error::ErrorKind};
use intar_contracts::source::{
    SOURCE_BUNDLE_FIELD, SOURCE_BUNDLES_PATH, SOURCE_META_FIELD, SourceBundleV2, SourceRefusalCode,
    SourceRefusalV1,
};

use super::{
    BundleCommand, BundleUploadTarget, Cli, Command, bundle_command, compile_digest,
    default_bundle_output_path, exit_code, upload_bundle,
};
use crate::bundle_command::parse_bundle_upload_response;

#[test]
fn exposes_package_version_from_root_cli() {
    assert_eq!(
        Cli::command().get_version(),
        Some(env!("CARGO_PKG_VERSION"))
    );
    let error = Cli::try_parse_from(["intar-image-cli", "--version"]).expect_err("exits");
    assert_eq!(error.kind(), ErrorKind::DisplayVersion);
}

#[test]
fn default_bundle_path_uses_the_requested_revision() {
    assert_eq!(
        default_bundle_output_path("release-1"),
        PathBuf::from("dist/bundles/release-1.json.gz")
    );
}

const GIT_REV: &str = "git-1-0123456789abcdef0123456789abcdef01234567-p08e31612";

fn bundle_args(argv: &[&str]) -> BundleCommand {
    let cli = Cli::try_parse_from([&["intar-image-cli", "bundle"], argv].concat())
        .expect("bundle parses");
    let Command::Bundle(args) = cli.command else {
        panic!("expected bundle command");
    };
    args
}

#[test]
fn parses_the_frozen_workflow_argv() {
    // scenario-publish.yml: `validate` with no flags, and this `bundle`.
    let cli = Cli::try_parse_from(["intar-image-cli", "validate"]).expect("validate parses");
    assert!(matches!(cli.command, Command::Validate(args) if args.root == Path::new(".")));
    let args = bundle_args(&[
        "--url",
        "https://intar.dev/registry/v1/sources/bundles",
        "--token",
        "token",
        "--rev",
        GIT_REV,
        "--output",
        "bundle.tar.gz",
    ]);
    assert_eq!(args.rev.as_deref(), Some(GIT_REV));
    assert_eq!(args.output, Some(PathBuf::from("bundle.tar.gz")));
    assert!(!args.no_upload);
    assert_eq!(compile_digest(), "p08e31612");
    // The legacy lane's flags are gone.
    for gone in ["--courses-root", "--base-images", "--config"] {
        assert!(Cli::try_parse_from(["intar-image-cli", "bundle", gone, "x"]).is_err());
    }
    for gone in [
        "render",
        "build",
        "build-all",
        "hash",
        "build-base",
        "reconstruct",
    ] {
        assert!(
            Cli::try_parse_from(["intar-image-cli", gone]).is_err(),
            "{gone}"
        );
    }
}

/// The in-repository example, copied without the old builder's files.
pub(crate) fn example() -> tempfile::TempDir {
    let content = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../content");
    let temp = tempfile::tempdir().expect("tempdir");
    for file in [
        "intar.hcl",
        "scenarios/broken-nginx/scenario.hcl",
        "courses/linux-operations/course.md",
        "courses/linux-operations/00-operating-model/lecture.md",
        "courses/linux-operations/01-broken-nginx/lecture.md",
    ] {
        let to = temp.path().join(file);
        std::fs::create_dir_all(to.parent().expect("parent")).expect("mkdir");
        std::fs::copy(content.join(file), to).expect("copy");
    }
    temp
}

/// A request that [`serve_once`] captured.
struct Captured {
    head: String,
    body: Vec<u8>,
}

impl Captured {
    fn header(&self, name: &str) -> Option<&str> {
        self.head.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case(name).then_some(value.trim())
        })
    }

    /// The value of one `multipart/form-data` field.
    fn field(&self, name: &str) -> &[u8] {
        let find = |from: usize, needle: &[u8]| {
            from + self.body[from..]
                .windows(needle.len())
                .position(|window| window == needle)
                .expect("the needle is in the body")
        };
        let boundary = self.header("content-type").expect("a content type");
        let boundary = boundary.split_once("boundary=").expect("a boundary").1;
        let start = find(0, format!("name=\"{name}\"").as_bytes());
        let start = find(start, b"\r\n\r\n") + 4;
        &self.body[start..find(start, format!("\r\n--{boundary}").as_bytes())]
    }
}

/// Answers one request to `path` with `status` and `body`.
fn serve_once(
    path: &str,
    status: &'static str,
    body: &'static str,
) -> (String, JoinHandle<Captured>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let url = format!(
        "http://{}{path}",
        listener.local_addr().expect("an address")
    );
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept");
        let mut reader = BufReader::new(stream.try_clone().expect("clone"));
        let mut head = String::new();
        while !head.ends_with("\r\n\r\n") {
            assert_ne!(reader.read_line(&mut head).expect("read"), 0);
        }
        let mut captured = Captured {
            head,
            body: Vec::new(),
        };
        // Without a Content-Length the body stays unread and the test fails.
        let length = captured
            .header("content-length")
            .map_or(0, |value| value.parse().expect("a length"));
        captured.body.resize(length, 0);
        reader.read_exact(&mut captured.body).expect("the body");
        write!(
            stream,
            "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        )
        .expect("answer");
        captured
    });
    (url, server)
}

#[test]
fn bundle_uploads_the_gzipped_v2_bundle() {
    let repository = example();
    let output = repository.path().join("out/bundle.tar.gz");
    let (url, server) = serve_once(
        SOURCE_BUNDLES_PATH,
        "202 Accepted",
        r#"{"ok":true,"rev":"git-1-0123456789abcdef0123456789abcdef01234567-p08e31612","queued":0,"assigned":[]}"#,
    );
    let root = repository.path().to_string_lossy().into_owned();
    let output_text = output.to_string_lossy().into_owned();
    let args = bundle_args(&[
        "--url",
        &url,
        "--token",
        "token",
        "--rev",
        GIT_REV,
        "--output",
        &output_text,
        "--root",
        &root,
    ]);
    bundle_command(&args).expect("uploads");

    let request = server.join().expect("the server ends");
    assert!(
        request
            .head
            .starts_with(&format!("POST {SOURCE_BUNDLES_PATH} HTTP/1.1\r\n")),
        "{}",
        request.head
    );
    assert_eq!(request.header("authorization"), Some("Bearer token"));
    assert_eq!(
        request.header("content-length"),
        Some(request.body.len().to_string().as_str())
    );
    let written = std::fs::read(&output).expect("the bundle file");
    assert_eq!(request.field(SOURCE_BUNDLE_FIELD), written);
    let meta: serde_json::Value =
        serde_json::from_slice(request.field(SOURCE_META_FIELD)).expect("meta is JSON");
    assert_eq!(meta, serde_json::json!({ "rev": GIT_REV }));
    let mut json = Vec::new();
    flate2::read::GzDecoder::new(written.as_slice())
        .read_to_end(&mut json)
        .expect("gunzip");
    let bundle: SourceBundleV2 = serde_json::from_slice(&json).expect("a v2 bundle");
    assert_eq!(bundle.scenarios[0].slug, "broken-nginx");
}

#[test]
fn an_upload_needs_a_token() {
    let args = bundle_args(&["--url", "https://intar.dev/x", "--rev", "r1"]);
    let error = bundle_command(&args).expect_err("refused");
    assert!(error.to_string().contains("--token"), "{error}");
}

#[test]
fn maps_upload_outcomes_to_exit_codes() {
    let refusal = |code| {
        serde_json::to_string(&SourceRefusalV1 {
            error: "refused".to_owned(),
            code,
        })
        .expect("serializes")
    };
    let exit = |status: u16, body: &str| match parse_bundle_upload_response(
        reqwest::StatusCode::from_u16(status).expect("a status"),
        body,
        GIT_REV,
    ) {
        Ok(_) => 0,
        Err(error) => exit_code(&error),
    };

    // A re-upload of an accepted rev is a no-op 202, and still a success.
    assert_eq!(
        exit(
            202,
            &format!(r#"{{"ok":true,"rev":"{GIT_REV}","queued":0,"assigned":[]}}"#)
        ),
        0
    );
    assert_eq!(exit(409, &refusal(SourceRefusalCode::Superseded)), 3);
    assert_eq!(
        exit(
            409,
            include_str!("../../intar-contracts/fixtures/source/source-refusal-v1.json")
        ),
        4
    );
    assert_eq!(exit(409, &refusal(SourceRefusalCode::Fenced)), 1);
    assert_eq!(exit(401, &refusal(SourceRefusalCode::IssuerUnsupported)), 1);
    assert_eq!(exit(409, r#"{"error":"conflict"}"#), 1);
    assert_eq!(exit(400, r#"{"error":"invalid meta"}"#), 1);
    // A maintenance window answers HTML, so the status alone decides.
    for status in [429, 500, 503] {
        assert_eq!(exit(status, "<html>maintenance</html>"), 75, "{status}");
    }

    let archive = tempfile::NamedTempFile::new().expect("a file");
    let target = |listener: &TcpListener| {
        BundleUploadTarget::new(
            &format!(
                "http://{}{SOURCE_BUNDLES_PATH}",
                listener.local_addr().expect("an address")
            ),
            Some("token"),
        )
        .expect("a target")
    };
    // A misconfigured target fails the same on every retry.
    for (url, token) in [
        ("not a url", "token"),
        ("ftp://127.0.0.1/registry/v1/sources/bundles", "token"),
        ("http://127.0.0.1:1/registry/v1/sources/bundles", "to\nken"),
    ] {
        let misconfigured = BundleUploadTarget::new(url, Some(token)).expect("a target");
        let error = upload_bundle(&misconfigured, archive.path(), GIT_REV).expect_err("fails");
        assert_eq!(exit_code(&error), 1, "{url}: {error:?}");
    }
    // A refused connection.
    let closed = TcpListener::bind("127.0.0.1:0").expect("bind");
    let refused = target(&closed);
    drop(closed);
    let error = upload_bundle(&refused, archive.path(), GIT_REV).expect_err("fails");
    assert_eq!(exit_code(&error), 75, "{error:?}");
    // A server that never answers runs into the client timeout.
    let silent = TcpListener::bind("127.0.0.1:0").expect("bind");
    let hanging = target(&silent);
    let server = std::thread::spawn(move || {
        let (mut stream, _) = silent.accept().expect("accept");
        // Holds the connection until the client gives up.
        let _ = std::io::copy(&mut stream, &mut std::io::sink());
    });
    let error = upload_bundle(&hanging, archive.path(), GIT_REV).expect_err("fails");
    assert_eq!(exit_code(&error), 75, "{error:?}");
    server.join().expect("the server ends");
}

mod pipeline {
    use std::path::Path;

    use clap::Parser;
    use intar_contracts::scenario::build_keys;
    use intar_contracts::source::SOURCE_BUNDLES_PATH;
    use intar_image_scenario::loader::compile;

    use super::{GIT_REV, example, serve_once};
    use crate::bundle_command::{MissingImage, PipelineReceipt, parse_bundle_upload_response};
    use crate::plan_command::{plan_command, plan_of};
    use crate::push_command::BuiltImage;
    use crate::{Cli, Command, exit_code};

    /// The build key of the example's one machine.
    fn example_key(root: &Path) -> String {
        let (bundle, _) = compile(root).expect("the example compiles");
        let keys = build_keys(&bundle.scenarios[0], &bundle.images).expect("keys");
        keys.machines
            .values()
            .next()
            .expect("a machine")
            .as_str()
            .to_owned()
    }

    fn missing(key: &str, architecture: &str) -> MissingImage {
        MissingImage {
            build_key: key.to_owned(),
            architecture: architecture.to_owned(),
        }
    }

    #[test]
    fn a_receipt_without_a_plan_is_a_builders() {
        let body = format!(r#"{{"ok":true,"rev":"{GIT_REV}","queued":0,"assigned":[]}}"#);
        let receipt = parse_bundle_upload_response(reqwest::StatusCode::ACCEPTED, &body, GIT_REV)
            .expect("a receipt");
        assert_eq!(receipt.pipeline, None);
        let repository = example();
        let (bundle, _) = compile(repository.path()).expect("compiles");
        let plan =
            serde_json::to_value(plan_of(&bundle, GIT_REV, None).expect("a plan")).expect("json");
        assert_eq!(
            plan,
            serde_json::json!({ "rev": GIT_REV, "producer": "builder", "jobs": [], "images": [] })
        );
    }

    #[test]
    fn the_missing_images_become_targets_of_build() {
        let repository = example();
        let key = example_key(repository.path());
        let body = format!(
            r#"{{"ok":true,"rev":"{GIT_REV}","queued":0,"assigned":[],"pipeline":{{"architectures":["amd64","arm64"],"missing":[{{"build_key":"{key}","architecture":"amd64"}},{{"build_key":"{key}","architecture":"arm64"}}]}}}}"#
        );
        let receipt = parse_bundle_upload_response(reqwest::StatusCode::ACCEPTED, &body, GIT_REV)
            .expect("a receipt");
        let (bundle, _) = compile(repository.path()).expect("compiles");
        let plan = serde_json::to_value(
            plan_of(&bundle, GIT_REV, receipt.pipeline.as_ref()).expect("a plan"),
        )
        .expect("json");
        assert_eq!(
            plan,
            serde_json::json!({
                "rev": GIT_REV,
                "producer": "pipeline",
                "jobs": [
                    { "target": "broken-nginx/webserver", "build_key": key, "arch": "amd64" },
                    { "target": "broken-nginx/webserver", "build_key": key, "arch": "arm64" },
                ],
                "images": [
                    { "target": "broken-nginx/webserver", "build_key": key, "archs": ["amd64", "arm64"] },
                ],
            })
        );

        // Nothing missing is a pipeline's plan with nothing to do.
        let nothing = PipelineReceipt {
            architectures: vec!["amd64".to_owned()],
            missing: Vec::new(),
        };
        let plan = serde_json::to_value(plan_of(&bundle, GIT_REV, Some(&nothing)).expect("a plan"))
            .expect("json");
        assert_eq!(plan["producer"], "pipeline");
        assert_eq!(plan["jobs"], serde_json::json!([]));

        // A key no machine of the commit has is the service's mistake, not a job.
        let unknown = PipelineReceipt {
            architectures: vec!["amd64".to_owned()],
            missing: vec![missing(&format!("sha256:{}", "f".repeat(64)), "amd64")],
        };
        let error = plan_of(&bundle, GIT_REV, Some(&unknown)).expect_err("refused");
        assert!(error.to_string().contains("no machine"), "{error}");
    }

    #[test]
    fn a_cluster_missing_any_key_is_one_target_per_architecture() {
        use intar_contracts::scenario::{
            ClusterRole, ClusterV1, MachineClusterV1, PLATFORM_BASE_IMAGE, TALOS_BASE_IMAGE,
        };
        let repository = example();
        let (mut bundle, _) = compile(repository.path()).expect("compiles");
        let scenario = &mut bundle.scenarios[0];
        let template = scenario.machines[0].clone();
        let member = |name: &str, from: &str, role| {
            let mut machine = template.clone();
            machine.name = name.to_owned();
            machine.from = from.to_owned();
            machine.cluster = Some(MachineClusterV1 {
                cluster: "lab".to_owned(),
                role,
            });
            machine
        };
        scenario.machines.extend([
            member("cp1", TALOS_BASE_IMAGE, ClusterRole::Controlplane),
            member("wk1", TALOS_BASE_IMAGE, ClusterRole::Worker),
            member("mgmt", PLATFORM_BASE_IMAGE, ClusterRole::Management),
        ]);
        scenario.clusters = vec![ClusterV1 {
            name: "lab".to_owned(),
            talos: "v1.15.0-beta.0".to_owned(),
            kubernetes: "v1.37.1".to_owned(),
            patches: Vec::new(),
        }];
        let keys = build_keys(scenario, &bundle.images).expect("keys");
        let cluster = keys.clusters["lab"].as_str().to_owned();
        let mut members: Vec<String> = ["cp1", "wk1", "mgmt"]
            .iter()
            .map(|name| keys.machines[*name].as_str().to_owned())
            .collect();
        members.sort();
        let receipt = PipelineReceipt {
            architectures: vec!["amd64".to_owned(), "arm64".to_owned()],
            missing: vec![
                missing(&members[0], "amd64"),
                missing(&members[1], "amd64"),
                missing(&members[2], "arm64"),
            ],
        };
        let plan = serde_json::to_value(plan_of(&bundle, GIT_REV, Some(&receipt)).expect("a plan"))
            .expect("json");
        assert_eq!(
            plan["jobs"],
            serde_json::json!([
                { "target": "cluster:broken-nginx/lab", "build_key": cluster, "build_keys": members, "arch": "amd64" },
                { "target": "cluster:broken-nginx/lab", "build_key": cluster, "build_keys": members, "arch": "arm64" },
            ])
        );
        assert_eq!(
            plan["images"],
            serde_json::json!([
                { "target": "cluster:broken-nginx/lab", "build_key": cluster, "build_keys": members, "archs": ["amd64", "arm64"] },
            ])
        );
    }

    #[test]
    fn a_plan_field_that_is_no_plan_fails_the_upload() {
        let body = format!(
            r#"{{"ok":true,"rev":"{GIT_REV}","queued":0,"assigned":[],"pipeline":{{"missing":"all"}}}}"#
        );
        let error = parse_bundle_upload_response(reqwest::StatusCode::ACCEPTED, &body, GIT_REV)
            .expect_err("refused");
        assert!(format!("{error:#}").contains("pipeline"), "{error:#}");
    }

    #[test]
    fn plan_uploads_the_bundle_and_writes_the_step_outputs() {
        let repository = example();
        let key = example_key(repository.path());
        let body: &'static str = Box::leak(
            format!(
                r#"{{"ok":true,"rev":"{GIT_REV}","queued":0,"assigned":[],"pipeline":{{"architectures":["amd64","arm64"],"missing":[{{"build_key":"{key}","architecture":"arm64"}}]}}}}"#
            )
            .into_boxed_str(),
        );
        let (url, server) = serve_once(SOURCE_BUNDLES_PATH, "202 Accepted", body);
        let root = repository.path().to_string_lossy().into_owned();
        let bundle = repository.path().join("out/bundle.json.gz");
        let outputs = repository.path().join("github-output");
        std::fs::write(&outputs, "earlier=1\n").expect("write");
        let cli = Cli::try_parse_from([
            "intar-image-cli",
            "plan",
            "--url",
            &url,
            "--token",
            "oidc",
            "--rev",
            GIT_REV,
            "--root",
            &root,
            "--output",
            &bundle.to_string_lossy(),
            "--github-output",
            &outputs.to_string_lossy(),
        ])
        .expect("plan parses");
        let Command::Plan(args) = cli.command else {
            panic!("expected plan");
        };
        plan_command(&args).expect("plans");

        let request = server.join().expect("the server ends");
        assert_eq!(request.header("authorization"), Some("Bearer oidc"));
        assert!(bundle.is_file());
        let written = std::fs::read_to_string(&outputs).expect("the outputs");
        assert_eq!(
            written,
            format!(
                "earlier=1\nrev={GIT_REV}\nproducer=pipeline\nimages=[{{\"target\":\"broken-nginx/webserver\",\"build_key\":\"{key}\",\"archs\":[\"arm64\"]}}]\njobs=[{{\"target\":\"broken-nginx/webserver\",\"build_key\":\"{key}\",\"arch\":\"arm64\"}}]\n"
            )
        );
    }

    #[test]
    fn plan_ends_like_bundle_when_the_commit_is_superseded() {
        let repository = example();
        let (url, server) = serve_once(
            SOURCE_BUNDLES_PATH,
            "409 Conflict",
            r#"{"error":"This commit is no longer the head of the default branch.","code":"superseded"}"#,
        );
        let root = repository.path().to_string_lossy().into_owned();
        let bundle = repository.path().join("bundle.json.gz");
        let cli = Cli::try_parse_from([
            "intar-image-cli",
            "plan",
            "--url",
            &url,
            "--token",
            "oidc",
            "--rev",
            GIT_REV,
            "--root",
            &root,
            "--output",
            &bundle.to_string_lossy(),
        ])
        .expect("plan parses");
        let Command::Plan(args) = cli.command else {
            panic!("expected plan");
        };
        let error = plan_command(&args).expect_err("refused");
        server.join().expect("the server ends");
        assert_eq!(exit_code(&error), 3, "{error:#}");
    }

    #[test]
    fn push_reads_what_build_wrote_and_ends_with_the_workflows_exit_codes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let built = BuiltImage {
            build_key: format!("sha256:{}", "b".repeat(64))
                .try_into()
                .expect("a digest"),
            manifest: format!("sha256:{}", "c".repeat(64))
                .try_into()
                .expect("a digest"),
            arch: "arm64".to_owned(),
        };
        built.write(dir.path()).expect("written");
        let text = std::fs::read_to_string(dir.path().join("image.json")).expect("image.json");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&text).expect("json"),
            serde_json::json!({
                "build_key": format!("sha256:{}", "b".repeat(64)),
                "manifest": format!("sha256:{}", "c".repeat(64)),
                "arch": "arm64",
            })
        );

        let image = dir.path().to_string_lossy().into_owned();
        let push = |url: &str| {
            let cli = Cli::try_parse_from([
                "intar-image-cli",
                "push",
                "--image",
                &image,
                "--url",
                url,
                "--token",
                "oidc",
                "--rev",
                GIT_REV,
            ])
            .expect("push parses");
            let Command::Push(args) = cli.command else {
                panic!("expected push");
            };
            crate::push_command::push_command(&args)
        };
        // The session open answers; nothing else is asked after a refusal.
        for (status, body, code) in [
            ("409 Conflict", r#"{"error":"gone","code":"superseded"}"#, 3),
            (
                "409 Conflict",
                r#"{"error":"off","code":"pipeline_images_disabled"}"#,
                1,
            ),
            (
                "401 Unauthorized",
                r#"{"error":"unauthorized","code":"unauthorized"}"#,
                1,
            ),
            (
                "403 Forbidden",
                r#"{"error":"branch","code":"ref_not_default_branch"}"#,
                1,
            ),
        ] {
            let (url, server) = serve_once("/registry/v1/pipeline/sessions", status, body);
            let origin = url
                .trim_end_matches("/registry/v1/pipeline/sessions")
                .to_owned();
            let error = push(&origin).expect_err("refused");
            let request = server.join().expect("the server ends");
            assert_eq!(request.header("authorization"), Some("Bearer oidc"));
            assert_eq!(exit_code(&error), code, "{status} {body}: {error:#}");
        }
        // What may pass on another try ends with 75; what the image or the
        // commit is refused for ends with 1.
        for (status, body, code) in [
            (503, "{}", 75),
            (429, r#"{"code":"pipeline_session_limit"}"#, 75),
            (409, r#"{"code":"registry_paused"}"#, 75),
            (409, r#"{"code":"bundle_pending"}"#, 75),
            (409, r#"{"code":"registry_session_closed"}"#, 75),
            // A paused registry's answer to the blob check has no body.
            (409, "", 75),
            (401, r#"{"error":"unauthorized"}"#, 1),
            (403, r#"{"code":"build_key_not_in_bundle"}"#, 1),
            (413, r#"{"code":"pipeline_session_bytes"}"#, 1),
            (409, r#"{"code":"build_key_mismatch"}"#, 1),
            (409, r#"{"code":"scope_storage_exceeded"}"#, 1),
        ] {
            let error = crate::push_command::failed(intar_image_upload::Error::HttpStatus {
                status: reqwest::StatusCode::from_u16(status).expect("a status"),
                body: body.to_owned(),
            });
            assert_eq!(exit_code(&error), code, "{status} {body}");
        }
        let broken = crate::push_command::failed(intar_image_upload::Error::SessionBroken {
            session_id: "s".to_owned(),
            detail: "the heartbeat stopped".to_owned(),
            cause: None,
        });
        assert_eq!(exit_code(&broken), 75);

        // Without image.json there is nothing to push, and nobody is asked.
        std::fs::remove_file(dir.path().join("image.json")).expect("removed");
        let error = push("http://127.0.0.1:1").expect_err("refused");
        assert_eq!(exit_code(&error), 1);
        assert!(format!("{error:#}").contains("image.json"), "{error:#}");
    }

    /// A service on a local port for a whole push: `answer` decides each
    /// request from its method and path; every request is kept as
    /// `METHOD path token`.
    fn serve(
        answer: impl Fn(&str, &str) -> (u16, String) + Send + 'static,
    ) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use std::io::{BufRead as _, BufReader, Read as _, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let url = format!("http://{}", listener.local_addr().expect("an address"));
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let kept = std::sync::Arc::clone(&seen);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut reader = BufReader::new(stream.try_clone().expect("clone"));
                let mut head = String::new();
                while !head.ends_with("\r\n\r\n") {
                    if reader.read_line(&mut head).unwrap_or(0) == 0 {
                        break;
                    }
                }
                let header = |name: &str| {
                    head.lines().find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.eq_ignore_ascii_case(name)
                            .then(|| value.trim().to_owned())
                    })
                };
                let length = header("content-length")
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(0);
                let mut body = vec![0; length];
                if reader.read_exact(&mut body).is_err() {
                    continue;
                }
                let mut line = head.split_whitespace();
                let (method, path) = (
                    line.next().unwrap_or_default(),
                    line.next().unwrap_or_default(),
                );
                kept.lock().expect("the lock").push(format!(
                    "{method} {path} {}",
                    header("authorization")
                        .unwrap_or_default()
                        .trim_start_matches("Bearer ")
                ));
                let (status, body) = answer(method, path);
                let length = if method == "HEAD" { 0 } else { body.len() };
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {length}\r\nconnection: close\r\n\r\n{}",
                    if method == "HEAD" { "" } else { &body }
                );
            }
        });
        (url, seen)
    }

    /// A directory as `build --out` leaves it: one config, one layer, the
    /// manifest and `image.json`.
    fn built_image() -> (tempfile::TempDir, String) {
        use intar_contracts::oci::{
            OCI_MANIFEST_MEDIA_TYPE, OciDescriptorV1, OciDigest, OciManifestV1,
        };
        let dir = tempfile::tempdir().expect("tempdir");
        let blobs = dir.path().join("sha256");
        std::fs::create_dir_all(&blobs).expect("mkdir");
        let put = |bytes: &[u8]| {
            let scratch = blobs.join("scratch");
            std::fs::write(&scratch, bytes).expect("write");
            let hex = intar_image_build::sha256_file_hex(&scratch).expect("hash");
            let digest: OciDigest = format!("sha256:{hex}").try_into().expect("a digest");
            std::fs::rename(&scratch, blobs.join(digest.hex())).expect("rename");
            digest
        };
        let descriptor = |bytes: &[u8]| OciDescriptorV1 {
            media_type: "application/octet-stream".to_owned(),
            digest: put(bytes),
            size: bytes.len() as u64,
        };
        let manifest = serde_json::to_vec(&OciManifestV1 {
            schema_version: 2,
            media_type: OCI_MANIFEST_MEDIA_TYPE.to_owned(),
            artifact_type: "application/vnd.intar.machine.v1".to_owned(),
            config: descriptor(b"{}"),
            layers: vec![descriptor(b"layer")],
        })
        .expect("json");
        let manifest = put(&manifest);
        BuiltImage {
            build_key: format!("sha256:{}", "b".repeat(64))
                .try_into()
                .expect("a digest"),
            manifest: manifest.clone(),
            arch: "amd64".to_owned(),
        }
        .write(dir.path())
        .expect("image.json");
        (dir, manifest.as_str().to_owned())
    }

    fn push_to(url: &str, image: &Path) -> anyhow::Result<()> {
        let cli = Cli::try_parse_from([
            "intar-image-cli",
            "push",
            "--image",
            &image.to_string_lossy(),
            "--url",
            url,
            "--token",
            "oidc",
            "--rev",
            GIT_REV,
        ])
        .expect("push parses");
        let Command::Push(args) = cli.command else {
            panic!("expected push");
        };
        crate::push_command::push_command(&args)
    }

    #[test]
    fn push_opens_its_session_pushes_records_and_closes() {
        let (dir, manifest) = built_image();
        let recorded = format!(r#"{{"ok":true,"image_digest":"{manifest}"}}"#);
        let (url, seen) = serve(move |method, path| match (method, path) {
            ("POST", "/registry/v1/pipeline/sessions") => {
                (201, r#"{"ok":true,"token":"ips_s"}"#.to_owned())
            }
            ("POST", "/registry/v1/upload-sessions") => (200, r#"{"session_id":"a-1"}"#.to_owned()),
            ("HEAD", _) => (404, String::new()),
            ("POST", path) if path.contains("/result") => (201, recorded.clone()),
            _ => (200, r#"{"ok":true}"#.to_owned()),
        });
        push_to(&url, dir.path()).expect("pushed");

        let seen = seen.lock().expect("the lock").clone();
        assert_eq!(
            seen.first().map(String::as_str),
            Some("POST /registry/v1/pipeline/sessions oidc")
        );
        assert_eq!(
            seen.last().map(String::as_str),
            Some("POST /registry/v1/pipeline/sessions/close ips_s")
        );
        let result = format!(
            "POST /registry/v1/builds/{}/result?arch=amd64 ips_s",
            "b".repeat(64)
        );
        assert!(seen.contains(&result), "{seen:?}");
        assert!(
            seen.contains(&format!("PUT /registry/v1/manifests/{manifest} ips_s")),
            "{seen:?}"
        );
        // Only the open carries the OIDC token.
        assert_eq!(
            seen.iter().filter(|line| line.ends_with(" oidc")).count(),
            1,
            "{seen:?}"
        );
    }

    #[test]
    fn push_closes_its_session_when_the_image_is_refused() {
        let (dir, _) = built_image();
        let (url, seen) = serve(|method, path| match (method, path) {
            ("POST", "/registry/v1/pipeline/sessions") => {
                (201, r#"{"ok":true,"token":"ips_s"}"#.to_owned())
            }
            ("POST", "/registry/v1/upload-sessions") => (200, r#"{"session_id":"a-1"}"#.to_owned()),
            ("PUT", path) if path.contains("/manifests/") => (
                403,
                r#"{"error":"no","code":"build_key_not_in_bundle"}"#.to_owned(),
            ),
            _ => (200, r#"{"ok":true}"#.to_owned()),
        });
        let error = push_to(&url, dir.path()).expect_err("refused");
        assert_eq!(exit_code(&error), 1, "{error:#}");
        let seen = seen.lock().expect("the lock").clone();
        assert_eq!(
            seen.last().map(String::as_str),
            Some("POST /registry/v1/pipeline/sessions/close ips_s")
        );
        assert!(
            !seen.iter().any(|line| line.contains("/result")),
            "{seen:?}"
        );
    }

    #[test]
    fn an_image_file_of_an_earlier_build_is_forgotten() {
        let (dir, _) = built_image();
        BuiltImage::forget(dir.path()).expect("removed");
        assert!(!dir.path().join("image.json").exists());
        BuiltImage::forget(dir.path()).expect("nothing to remove is fine");
    }
}

mod setup {
    use std::collections::HashMap;
    use std::io::{BufRead as _, BufReader, Write as _};
    use std::path::Path;

    use clap::Parser;
    use intar_image_build::tools::{
        BUILDKIT_ARCHIVE_SHA256, BUILDKIT_IMAGE, BUILDKIT_VERSION, UMOCI_SHA256, UMOCI_VERSION,
    };
    use intar_image_build::{BuildArch, QemuBuildConfig, sha256_file_hex};

    use crate::setup_command::{
        BUILDKIT_ARCHIVE_SHA256_ARM64, Sources, UMOCI_SHA256_ARM64, install, qemu_version, qemus,
    };
    use crate::{Cli, Command};

    /// A gzipped tar with one file.
    fn archive(member: &str, content: &[u8]) -> Vec<u8> {
        let mut tar = tar::Builder::new(flate2::write::GzEncoder::new(
            Vec::new(),
            flate2::Compression::fast(),
        ));
        let mut header = tar::Header::new_gnu();
        header.set_size(content.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        tar.append_data(&mut header, member, content)
            .expect("append");
        tar.into_inner().expect("tar").finish().expect("gzip")
    }

    fn sha256(bytes: &[u8]) -> String {
        let scratch = tempfile::NamedTempFile::new().expect("tempfile");
        std::fs::write(scratch.path(), bytes).expect("write");
        sha256_file_hex(scratch.path()).expect("hash")
    }

    /// Serves `files` by path; anything else is a 404.
    fn serve(files: HashMap<String, Vec<u8>>) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let url = format!("http://{}", listener.local_addr().expect("an address"));
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut reader = BufReader::new(stream.try_clone().expect("clone"));
                let mut head = String::new();
                while !head.ends_with("\r\n\r\n") {
                    if reader.read_line(&mut head).unwrap_or(0) == 0 {
                        break;
                    }
                }
                let path = head.split_whitespace().nth(1).unwrap_or_default();
                let (status, body) = files
                    .get(path)
                    .map_or((404, Vec::new()), |body| (200, body.clone()));
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} X\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(&body);
            }
        });
        url
    }

    struct Fixture {
        sources: Sources,
        descriptor: serde_json::Value,
    }

    /// A server with every download a computer of `host` makes and the
    /// descriptor that names its Kinos. Any other tool's name is a 404.
    fn fixture_for(host: BuildArch) -> Fixture {
        let name = host.debian();
        let buildkit = archive("bin/buildctl", b"buildctl");
        let umoci = b"umoci".to_vec();
        let kino_amd64 = archive("kino", b"kino for amd64");
        let kino_arm64 = archive("kino", b"kino for arm64");
        let descriptor = serde_json::json!({
            "cli_version": "0.15.0",
            "sha256": {},
            "digest": "p00000000",
            "kino": {
                "amd64": { "version": "0.12.0", "sha256": sha256(&kino_amd64) },
                "arm64": { "version": "0.12.0", "sha256": sha256(&kino_arm64) },
            },
        });
        let sources = Sources {
            host,
            buildkit_sha256: sha256(&buildkit),
            umoci_sha256: sha256(&umoci),
            github: serve(HashMap::from([
                (
                    format!("/moby/buildkit/releases/download/{BUILDKIT_VERSION}/buildkit-{BUILDKIT_VERSION}.linux-{name}.tar.gz"),
                    buildkit,
                ),
                (
                    format!("/opencontainers/umoci/releases/download/{UMOCI_VERSION}/umoci.linux.{name}"),
                    umoci,
                ),
                (
                    "/intar-dev/intar-dev/releases/download/kino%2Fv0.12.0/kino_0.12.0_linux_amd64.tar.gz".to_owned(),
                    kino_amd64,
                ),
                (
                    "/intar-dev/intar-dev/releases/download/kino%2Fv0.12.0/kino_0.12.0_linux_arm64.tar.gz".to_owned(),
                    kino_arm64,
                ),
            ])),
        };
        Fixture {
            sources,
            descriptor,
        }
    }

    fn fixture() -> Fixture {
        fixture_for(BuildArch::Amd64)
    }

    fn args(
        dir: &Path,
        descriptor: &serde_json::Value,
        cache: Option<&Path>,
    ) -> crate::setup_command::SetupCommand {
        let file = dir.join("descriptor.json");
        std::fs::create_dir_all(dir).expect("mkdir");
        std::fs::write(&file, descriptor.to_string()).expect("write");
        let mut argv = vec![
            "intar-image-cli".to_owned(),
            "setup".to_owned(),
            "--dir".to_owned(),
            dir.join("intar").to_string_lossy().into_owned(),
            "--descriptor".to_owned(),
            file.to_string_lossy().into_owned(),
        ];
        if let Some(cache) = cache {
            argv.extend(["--cache".to_owned(), cache.to_string_lossy().into_owned()]);
        }
        let Command::Setup(args) = Cli::try_parse_from(argv).expect("setup parses").command else {
            panic!("expected setup");
        };
        args
    }

    #[test]
    fn setup_lays_out_the_tools_and_a_configuration_build_reads() {
        let fixture = fixture();
        let temp = tempfile::tempdir().expect("tempdir");
        let cache = temp.path().join("volume");
        let installed = install(
            &args(temp.path(), &fixture.descriptor, Some(&cache)),
            &fixture.sources,
        )
        .expect("installed");

        let dir = temp.path().join("intar");
        let read = |path: &Path| std::fs::read(path).expect("the file");
        assert_eq!(read(&dir.join("bin/buildctl")), b"buildctl");
        assert_eq!(read(&dir.join("bin/umoci")), b"umoci");
        assert_eq!(read(&installed.kino_amd64), b"kino for amd64");
        assert_eq!(read(&installed.kino_arm64), b"kino for arm64");
        assert_eq!(installed.kino_arm64, dir.join("kino/arm64/kino"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(dir.join("bin/buildctl"))
                .expect("metadata")
                .permissions()
                .mode();
            assert_eq!(mode & 0o111, 0o111);
        }

        // The configuration is one `build` takes, with nothing in the checkout.
        let config: QemuBuildConfig =
            serde_json::from_slice(&read(&installed.config)).expect("a build configuration");
        assert_eq!(config.arch(), BuildArch::Amd64);
        assert_eq!(config.qemu_binary, Path::new("qemu-system-x86_64"));
        assert_eq!(config.work_root, dir.join("work"));
        assert_eq!(config.layered.buildctl_binary, dir.join("bin/buildctl"));
        assert_eq!(config.layered.umoci_binary, dir.join("bin/umoci"));
        assert_eq!(config.layered.oci_cache_root, Some(cache.join("oci")));
        assert_eq!(
            config.layered.checkpoint_cache_root,
            Some(cache.join("checkpoints"))
        );
        assert!(config.layered.use_cache);
        // A job's cache volume keeps little free: the builder host's 20 GiB
        // would have the cache evict what the same job just stored.
        assert_eq!(config.layered.minimum_free_bytes, 4 * 1024 * 1024 * 1024);

        // The daemon is the pinned image, on the socket `build` looks for.
        assert_eq!(installed.buildkit_socket, cache.join("oci/buildkitd.sock"));
        assert_eq!(
            installed.buildkit_run,
            format!(
                "{BUILDKIT_IMAGE} --addr unix://{} --root {} --config {}",
                cache.join("oci/buildkitd.sock").display(),
                cache.join("buildkit").display(),
                cache.join("oci/buildkitd.toml").display()
            )
        );
        assert!(
            String::from_utf8(read(&cache.join("oci/buildkitd.toml")))
                .expect("text")
                .contains("maxUsedSpace = 6442450944")
        );
    }

    #[test]
    fn setup_on_arm64_brings_arm64_tools_and_builds_arm64_natively() {
        let fixture = fixture_for(BuildArch::Arm64);
        let temp = tempfile::tempdir().expect("tempdir");
        let installed = install(
            &args(temp.path(), &fixture.descriptor, None),
            &fixture.sources,
        )
        .expect("installed");
        let dir = temp.path().join("intar");
        assert_eq!(
            std::fs::read(dir.join("bin/buildctl")).expect("buildctl"),
            b"buildctl"
        );
        let config: QemuBuildConfig =
            serde_json::from_slice(&std::fs::read(&installed.config).expect("the configuration"))
                .expect("a build configuration");
        assert_eq!(config.arch(), BuildArch::Arm64);
        assert_eq!(config.qemu_binary, Path::new("qemu-system-aarch64"));
        assert_eq!(config.accelerator, "kvm");
        // No checkpoints there: a guest stalls after one's pause.
        assert!(!config.layered.use_cache);
        // amd64 from there is the other QEMU, beside this one.
        assert_eq!(
            config.for_arch(BuildArch::Amd64).qemu_binary,
            Path::new("qemu-system-x86_64")
        );
    }

    #[test]
    fn each_host_has_its_own_pins_and_its_own_kvm() {
        let amd64 = Sources::pinned(BuildArch::Amd64);
        assert_eq!(amd64.buildkit_sha256, BUILDKIT_ARCHIVE_SHA256);
        assert_eq!(amd64.umoci_sha256, UMOCI_SHA256);
        let arm64 = Sources::pinned(BuildArch::Arm64);
        assert_eq!(arm64.buildkit_sha256, BUILDKIT_ARCHIVE_SHA256_ARM64);
        assert_eq!(arm64.umoci_sha256, UMOCI_SHA256_ARM64);
        assert_eq!(arm64.github, "https://github.com");

        // The host's own QEMU is started with KVM, the other emulated.
        for host in [BuildArch::Amd64, BuildArch::Arm64] {
            let [(native, _, native_machine), (_, _, foreign_machine)] = qemus(host);
            assert_eq!(native, host.qemu_binary());
            assert!(native_machine.contains("-accel kvm -cpu host"), "{host:?}");
            assert!(foreign_machine.contains("-accel tcg"), "{host:?}");
        }
    }

    #[test]
    fn a_download_with_another_hash_is_refused_and_not_kept() {
        let mut fixture = fixture();
        fixture.sources.umoci_sha256 = "0".repeat(64);
        let temp = tempfile::tempdir().expect("tempdir");
        let error = install(
            &args(temp.path(), &fixture.descriptor, None),
            &fixture.sources,
        )
        .expect_err("refused");
        assert!(format!("{error:#}").contains("not the pinned"), "{error:#}");
        assert!(!temp.path().join("intar/bin/umoci").exists());

        // The same for a Kino the descriptor names with another hash.
        let mut fixture = self::fixture();
        fixture.descriptor["kino"]["arm64"]["sha256"] = serde_json::json!("1".repeat(64));
        let temp = tempfile::tempdir().expect("tempdir");
        let error = install(
            &args(temp.path(), &fixture.descriptor, None),
            &fixture.sources,
        )
        .expect_err("refused");
        assert!(format!("{error:#}").contains("not the pinned"), "{error:#}");
        assert!(!temp.path().join("intar/kino/arm64/kino").exists());
    }

    #[test]
    fn a_descriptor_without_a_pinned_kino_downloads_nothing() {
        let mut fixture = fixture();
        fixture
            .descriptor
            .as_object_mut()
            .expect("an object")
            .remove("kino");
        let temp = tempfile::tempdir().expect("tempdir");
        let error = install(
            &args(temp.path(), &fixture.descriptor, None),
            &fixture.sources,
        )
        .expect_err("refused");
        assert!(
            format!("{error:#}").contains("names no amd64 Kino yet"),
            "{error:#}"
        );
        assert!(!temp.path().join("intar").exists());

        // A version that could leave the release's path is no version.
        let mut fixture = self::fixture();
        fixture.descriptor["kino"]["amd64"]["version"] = serde_json::json!("0.12.0/../x");
        let error = install(
            &args(temp.path(), &fixture.descriptor, None),
            &fixture.sources,
        )
        .expect_err("refused");
        assert!(
            format!("{error:#}").contains("is not a version"),
            "{error:#}"
        );
    }

    #[test]
    fn reads_a_qemu_version() {
        assert_eq!(
            qemu_version("QEMU emulator version 8.2.2 (Debian 1:8.2.2+ds-0ubuntu1.4)\nCopyright"),
            Some((8, 2))
        );
        assert_eq!(qemu_version("QEMU emulator version 11.1.3"), Some((11, 1)));
        assert_eq!(qemu_version("something else"), None);
        assert!((6, 2) < (8, 2) && (10, 0) > (8, 2));
    }
}
