//! The commands end to end on a temporary repository, exit codes included.

use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::net::TcpListener;
use std::path::Path;
use std::process::{Command, Output};

fn cli(root: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_intar-image-cli"))
        .args(args)
        .current_dir(root)
        // shellcheck findings are warnings; keep the run independent of it.
        .env("PATH", "/usr/bin:/bin")
        .output()
        .expect("the CLI runs")
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// The in-repository example, with a course that links it.
fn repository() -> tempfile::TempDir {
    let content = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../content");
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path();
    let write = |path: &str, body: &str| {
        let path = root.join(path);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(path, body).expect("write");
    };
    let read = |path: &str| std::fs::read_to_string(content.join(path)).expect("read");
    write("intar.hcl", &read("intar.hcl"));
    write(
        "scenarios/broken-nginx/scenario.hcl",
        &read("scenarios/broken-nginx/scenario.hcl"),
    );
    write(
        "courses/linux/course.md",
        "---\ntitle: Linux\nsummary: Repair things.\nsequential: true\n---\n\nBody.\n",
    );
    write(
        "courses/linux/01-nginx/lecture.md",
        "---\ntitle: Nginx\nsummary: Fix it.\ncategory: web\ntags: [nginx]\nestimated_minutes: 15\nscenario: broken-nginx\n---\n\nFix.\n",
    );
    temp
}

#[test]
fn validate_reports_every_problem_with_its_place() {
    let temp = repository();
    let ok = cli(temp.path(), &["validate"]);
    assert!(ok.status.success(), "{}", text(&ok.stderr));
    let stdout = text(&ok.stdout);
    assert!(
        stdout.contains("validated 1 scenarios, 0 images, 1 courses"),
        "{stdout}"
    );
    assert!(stdout.contains("compile digest: pefcf1cdb"), "{stdout}");

    let scenario = temp.path().join("scenarios/broken-nginx/scenario.hcl");
    let body = std::fs::read_to_string(&scenario).expect("read");
    std::fs::write(
        &scenario,
        body.replacen(
            "minutes    = 10",
            "minutes    = 10\n  colour     = \"red\"",
            1,
        ),
    )
    .expect("write");
    std::fs::write(temp.path().join("courses/linux/notes.txt"), "x").expect("write");
    let broken = cli(temp.path(), &["validate"]);
    assert_eq!(broken.status.code(), Some(1));
    let stderr = text(&broken.stderr);
    assert!(
        stderr.contains(
            "scenarios/broken-nginx/scenario.hcl:6:3: `scenario`: unknown field `colour`"
        ),
        "{stderr}"
    );
    assert!(
        stderr.contains("courses/linux/notes.txt: a course holds"),
        "{stderr}"
    );
}

#[test]
fn fmt_checks_and_rewrites() {
    let temp = repository();
    let clean = cli(temp.path(), &["fmt", "--check"]);
    assert!(clean.status.success(), "{}", text(&clean.stderr));

    std::fs::write(temp.path().join("intar.hcl"), "repository {\n}\n").expect("write");
    let dirty = cli(temp.path(), &["fmt", "--check"]);
    assert_eq!(dirty.status.code(), Some(1));
    assert_eq!(text(&dirty.stdout), "intar.hcl\n");
    let fixed = cli(temp.path(), &["fmt"]);
    assert!(fixed.status.success());
    assert_eq!(
        std::fs::read_to_string(temp.path().join("intar.hcl"))
            .ok()
            .as_deref(),
        Some("repository {}\n")
    );
    assert!(cli(temp.path(), &["fmt", "--check"]).status.success());
}

#[test]
fn spec_prints_the_lowered_scripts() {
    let temp = repository();
    let learn = cli(temp.path(), &["spec", "broken-nginx"]);
    assert!(learn.status.success(), "{}", text(&learn.stderr));
    let stdout = text(&learn.stdout);
    assert!(
        stdout.contains("# machine webserver: setup break-nginx"),
        "{stdout}"
    );
    assert!(stdout.contains("systemctl is-active --quiet"), "{stdout}");
    assert!(!stdout.contains("systemctl enable --now nginx"), "{stdout}");
    let verify = cli(temp.path(), &["spec", "broken-nginx", "--verify"]);
    assert!(text(&verify.stdout).contains("systemctl enable --now nginx"));
    assert_eq!(cli(temp.path(), &["spec", "nope"]).status.code(), Some(1));
}

#[test]
fn bundle_writes_without_uploading() {
    let temp = repository();
    let out = cli(
        temp.path(),
        &[
            "bundle",
            "--rev",
            "release-smoke",
            "--output",
            "b.tar.gz",
            "--no-upload",
        ],
    );
    assert!(out.status.success(), "{}", text(&out.stderr));
    let bytes = std::fs::read(temp.path().join("b.tar.gz")).expect("the bundle");
    assert_eq!(&bytes[..2], [0x1f, 0x8b], "gzip");
    // A bad rev never names a file.
    let bad = cli(temp.path(), &["bundle", "--rev", "../x", "--no-upload"]);
    assert_eq!(bad.status.code(), Some(1));
}

#[test]
fn a_refused_upload_exits_with_the_workflow_code() {
    let temp = repository();
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let url = format!(
        "http://{}/registry/v1/sources/bundles",
        listener.local_addr().expect("an address")
    );
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept");
        // The whole request, so the client never sees a reset.
        let mut reader = BufReader::new(stream.try_clone().expect("clone"));
        let mut length = 0;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).expect("read");
            if let Some((name, value)) = line.split_once(':')
                && name.eq_ignore_ascii_case("content-length")
            {
                length = value.trim().parse().expect("a length");
            }
            if line == "\r\n" || line.is_empty() {
                break;
            }
        }
        let mut body = vec![0; length];
        reader.read_exact(&mut body).expect("the body");
        let body = r#"{"error":"outdated","code":"compiler_outdated"}"#;
        write!(
            stream,
            "HTTP/1.1 409 Conflict\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        )
        .expect("answer");
    });
    let out = cli(
        temp.path(),
        &[
            "bundle", "--url", &url, "--token", "t", "--rev", "r1", "--output", "b.tar.gz",
        ],
    );
    server.join().expect("the server ends");
    assert_eq!(out.status.code(), Some(4), "{}", text(&out.stderr));
}
