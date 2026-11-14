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

const GIT_REV: &str = "git-1-0123456789abcdef0123456789abcdef01234567-pefcf1cdb";

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
    assert_eq!(compile_digest(), "pefcf1cdb");
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
        r#"{"ok":true,"rev":"git-1-0123456789abcdef0123456789abcdef01234567-pefcf1cdb","queued":0,"assigned":[]}"#,
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
