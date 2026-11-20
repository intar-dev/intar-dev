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
    let scenario = temp.path().join("scenarios/broken-nginx");
    std::fs::create_dir_all(&scenario).expect("mkdir");
    std::fs::copy(content.join("intar.hcl"), temp.path().join("intar.hcl")).expect("copy");
    std::fs::copy(
        content.join("scenarios/broken-nginx/scenario.hcl"),
        scenario.join("scenario.hcl"),
    )
    .expect("copy");
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
                "earlier=1\nimages=[{{\"target\":\"broken-nginx/webserver\",\"build_key\":\"{key}\",\"archs\":[\"arm64\"]}}]\njobs=[{{\"target\":\"broken-nginx/webserver\",\"build_key\":\"{key}\",\"arch\":\"arm64\"}}]\n"
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
        // What may pass on another try ends with 75.
        for (status, body) in [
            (503, "{}"),
            (429, r#"{"code":"pipeline_session_limit"}"#),
            (409, r#"{"code":"registry_paused"}"#),
            (409, r#"{"code":"bundle_pending"}"#),
        ] {
            let error = crate::push_command::failed(intar_image_upload::Error::HttpStatus {
                status: reqwest::StatusCode::from_u16(status).expect("a status"),
                body: body.to_owned(),
            });
            assert_eq!(exit_code(&error), 75, "{status} {body}");
        }

        // Without image.json there is nothing to push, and nobody is asked.
        std::fs::remove_file(dir.path().join("image.json")).expect("removed");
        let error = push("http://127.0.0.1:1").expect_err("refused");
        assert_eq!(exit_code(&error), 1);
        assert!(format!("{error:#}").contains("image.json"), "{error:#}");
    }
}
