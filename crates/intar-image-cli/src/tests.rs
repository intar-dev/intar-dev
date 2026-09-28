#![allow(clippy::unwrap_used)]

use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::thread::JoinHandle;

use clap::{CommandFactory, Parser, error::ErrorKind};
use intar_contracts::source::{
    SOURCE_BUNDLE_FIELD, SOURCE_BUNDLES_PATH, SOURCE_META_FIELD, SourceRefusalCode, SourceRefusalV1,
};
use intar_image_build::source_bundle::{CompileBundleInput, compile_bundle};

use super::{
    BundleCommand, BundleUploadTarget, Cli, Command, CompileMode, ScenarioCommand, bundle_command,
    compile_mode, default_bundle_output_path, exit_code, parse_bundle_upload_response,
    publish_url_from_bundle_url, upload_bundle, validate_command,
};

#[test]
fn derives_the_admission_route_from_a_bundle_target() {
    // A registry bundle target holds an admission session, so the uploader is
    // built from its sibling publish route.
    assert_eq!(
        publish_url_from_bundle_url("https://intar.dev/registry/v1/bundles").as_deref(),
        Some("https://intar.dev/registry/v1/publish")
    );
    assert_eq!(
        publish_url_from_bundle_url(" https://intar.dev/registry/v1/bundles/ ").as_deref(),
        Some("https://intar.dev/registry/v1/publish")
    );
    // Any other target has no admission to hold and uploads as before.
    assert_eq!(
        publish_url_from_bundle_url("https://mirror.example/upload"),
        None
    );
}

#[test]
fn exposes_package_version_from_root_cli() {
    assert_eq!(
        Cli::command().get_version(),
        Some(env!("CARGO_PKG_VERSION"))
    );
    let error = Cli::try_parse_from(["intar-image-cli", "--version"]).unwrap_err();
    assert_eq!(error.kind(), ErrorKind::DisplayVersion);
}

#[test]
fn uses_a_markdown_courses_root_for_all_course_commands() {
    let command = Cli::try_parse_from([
        "intar-image-cli",
        "hash",
        "repair-nginx",
        "--courses-root",
        "/sources/courses",
    ])
    .unwrap();
    let Command::Hash(args) = command.command else {
        panic!("expected hash command");
    };
    assert_eq!(args.scenario.as_deref(), Some("repair-nginx"));
    assert_eq!(
        args.courses_root,
        std::path::PathBuf::from("/sources/courses")
    );
}

#[test]
fn local_build_commands_accept_no_cache() {
    let command = Cli::try_parse_from(["intar-image-cli", "build", "--no-cache"]).unwrap();
    let Command::Build(args) = command.command else {
        panic!("expected build command");
    };
    assert!(args.no_cache);

    let command = Cli::try_parse_from(["intar-image-cli", "build-all", "--no-cache"]).unwrap();
    let Command::BuildAll(args) = command.command else {
        panic!("expected build-all command");
    };
    assert!(args.no_cache);
}

#[test]
fn default_bundle_path_uses_the_requested_revision() {
    assert_eq!(
        default_bundle_output_path("release-1"),
        std::path::PathBuf::from("dist/bundles/release-1.tar.gz")
    );
}

const GIT_REV: &str = "git-1-0123456789abcdef0123456789abcdef01234567-pe845f1ac";

/// The release smoke fixture, which also carries an `intar.yaml`.
fn release_smoke() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../intar-image-build/fixtures/release-smoke")
}

fn bundle_args(argv: &[&str]) -> BundleCommand {
    let cli = Cli::try_parse_from([&["intar-image-cli", "bundle"], argv].concat()).unwrap();
    let Command::Bundle(args) = cli.command else {
        panic!("expected bundle command");
    };
    args
}

fn validate_args(argv: &[&str]) -> ScenarioCommand {
    let cli = Cli::try_parse_from([&["intar-image-cli", "validate"], argv].concat()).unwrap();
    let Command::Validate(args) = cli.command else {
        panic!("expected validate command");
    };
    args
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
                .unwrap()
        };
        let boundary = self.header("content-type").unwrap();
        let boundary = boundary.split_once("boundary=").unwrap().1;
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
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}{path}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut head = String::new();
        while !head.ends_with("\r\n\r\n") {
            assert_ne!(reader.read_line(&mut head).unwrap(), 0);
        }
        let mut captured = Captured {
            head,
            body: Vec::new(),
        };
        // Without a Content-Length the body stays unread and the test fails.
        let length = captured
            .header("content-length")
            .map_or(0, |value| value.parse().unwrap());
        captured.body.resize(length, 0);
        reader.read_exact(&mut captured.body).unwrap();
        write!(
            stream,
            "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
        captured
    });
    (url, server)
}

#[test]
fn selects_the_compile_mode() {
    let repository = tempfile::tempdir().unwrap();
    let legacy = |courses_root: &str, base_images: &str| CompileMode::Legacy {
        courses_root: PathBuf::from(courses_root),
        base_images: PathBuf::from(base_images),
    };
    // No flags and no intar.yaml: the defaults `just validate-images` uses.
    assert_eq!(
        compile_mode(None, None, repository.path()),
        legacy("content/courses", "content/scenarios/base-images.hcl")
    );

    std::fs::write(repository.path().join("intar.yaml"), "version: 1\n").unwrap();
    assert_eq!(
        compile_mode(None, None, repository.path()),
        CompileMode::Source
    );
    // Either explicit flag keeps 0.8.2's token lane next to an intar.yaml.
    assert_eq!(
        compile_mode(Some(Path::new("courses")), None, repository.path()),
        legacy("courses", "content/scenarios/base-images.hcl")
    );
    assert_eq!(
        compile_mode(None, Some(Path::new("base.hcl")), repository.path()),
        legacy("content/courses", "base.hcl")
    );
}

#[test]
fn parses_the_token_lane_and_workflow_argv() {
    // 0.8.2's token lane.
    let args = bundle_args(&[
        "broken-nginx",
        "--courses-root",
        "courses",
        "--base-images",
        "base-images.hcl",
        "--url",
        "https://intar.dev/registry/v1/bundles",
        "--token",
        "token",
    ]);
    assert_eq!(args.scenario.as_deref(), Some("broken-nginx"));
    assert_eq!(args.courses_root, Some(PathBuf::from("courses")));
    assert_eq!(args.base_images, Some(PathBuf::from("base-images.hcl")));
    let args = validate_args(&["--courses-root", "courses", "--base-images", "b.hcl"]);
    assert_eq!(args.courses_root, Some(PathBuf::from("courses")));
    assert_eq!(args.base_images, Some(PathBuf::from("b.hcl")));

    // The frozen scenario-publish argv leaves both flags unset.
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
    assert_eq!((args.courses_root, args.base_images), (None, None));
    let args = validate_args(&[]);
    assert_eq!((args.courses_root, args.base_images), (None, None));
}

#[test]
fn legacy_flags_bundle_as_before_next_to_an_intar_yaml() {
    let fixture = release_smoke();
    let output = tempfile::tempdir().unwrap();
    let output = output.path().join("bundle.tar.gz");
    let (url, server) = serve_once(
        "/upload",
        "202 Accepted",
        r#"{"ok":true,"rev":"release-smoke","queued":1,"assigned":[]}"#,
    );
    let args = bundle_args(&[
        "--courses-root",
        fixture.join("courses").to_str().unwrap(),
        "--base-images",
        fixture.join("base-images.hcl").to_str().unwrap(),
        "--rev",
        "release-smoke",
        "--output",
        output.to_str().unwrap(),
        "--url",
        &url,
        "--token",
        "token",
    ]);
    bundle_command(&args, &fixture).unwrap();

    let expected = compile_bundle(&CompileBundleInput {
        courses_root: &fixture.join("courses"),
        base_images: &fixture.join("base-images.hcl"),
        rev: "release-smoke",
        target_arch: "amd64",
        scenario: None,
    })
    .unwrap();
    let request = server.join().unwrap();
    assert_eq!(std::fs::read(&output).unwrap(), expected.archive);
    assert_eq!(request.field(SOURCE_BUNDLE_FIELD), expected.archive);
    let meta: serde_json::Value = serde_json::from_slice(request.field(SOURCE_META_FIELD)).unwrap();
    assert_eq!(meta, expected.meta);
    assert!(meta.get("source").is_none());
}

#[test]
fn source_mode_uploads_the_intar_yaml_bundle() {
    let fixture = release_smoke();
    let output = tempfile::tempdir().unwrap();
    let output = output.path().join("bundle.tar.gz");
    let (url, server) = serve_once(
        SOURCE_BUNDLES_PATH,
        "202 Accepted",
        r#"{"ok":true,"rev":"git-1-0123456789abcdef0123456789abcdef01234567-pe845f1ac","queued":0,"assigned":[]}"#,
    );
    // The source route holds no admission session, so the only request is the
    // bundle POST.
    assert_eq!(publish_url_from_bundle_url(&url), None);
    let args = bundle_args(&[
        "--url",
        &url,
        "--token",
        "token",
        "--rev",
        GIT_REV,
        "--output",
        output.to_str().unwrap(),
    ]);
    bundle_command(&args, &fixture).unwrap();

    let request = server.join().unwrap();
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
    assert_eq!(
        request.field(SOURCE_BUNDLE_FIELD),
        std::fs::read(&output).unwrap()
    );
    let meta: serde_json::Value = serde_json::from_slice(request.field(SOURCE_META_FIELD)).unwrap();
    assert_eq!(meta["rev"], GIT_REV);
    assert_eq!(meta["source"]["scope"], "public");
    assert_eq!(meta["source"]["courses_root"], "courses");
}

#[test]
fn source_mode_validates_the_whole_repository() {
    let fixture = release_smoke();
    validate_command(&validate_args(&[]), &fixture).unwrap();
    assert!(validate_command(&validate_args(&["broken-nginx"]), &fixture).is_err());
}

#[test]
fn maps_upload_outcomes_to_exit_codes() {
    let refusal = |code| {
        serde_json::to_string(&SourceRefusalV1 {
            error: "refused".to_owned(),
            code,
        })
        .unwrap()
    };
    let exit = |status: u16, body: &str| match parse_bundle_upload_response(
        reqwest::StatusCode::from_u16(status).unwrap(),
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

    let archive = tempfile::NamedTempFile::new().unwrap();
    let meta = serde_json::json!({ "rev": GIT_REV });
    let target = |listener: &TcpListener| BundleUploadTarget {
        url: format!(
            "http://{}{SOURCE_BUNDLES_PATH}",
            listener.local_addr().unwrap()
        ),
        token: "token".to_owned(),
    };
    // A refused connection.
    let closed = TcpListener::bind("127.0.0.1:0").unwrap();
    let refused = target(&closed);
    drop(closed);
    let error = upload_bundle(None, &refused, archive.path(), GIT_REV, &meta).unwrap_err();
    assert_eq!(exit_code(&error), 75, "{error:?}");
    // A server that never answers runs into the client timeout.
    let silent = TcpListener::bind("127.0.0.1:0").unwrap();
    let hanging = target(&silent);
    let server = std::thread::spawn(move || {
        let (mut stream, _) = silent.accept().unwrap();
        // Holds the connection until the client gives up.
        let _ = std::io::copy(&mut stream, &mut std::io::sink());
    });
    let error = upload_bundle(None, &hanging, archive.path(), GIT_REV, &meta).unwrap_err();
    assert_eq!(exit_code(&error), 75, "{error:?}");
    server.join().unwrap();
}
