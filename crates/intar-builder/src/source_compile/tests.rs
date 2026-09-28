#![allow(clippy::unwrap_used)]

use std::collections::VecDeque;
use std::io::{Read as _, Write as _};
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use flate2::Compression;
use flate2::write::GzEncoder;
use intar_contracts::bridge::{
    DesiredSourceCompileV1, SourceCompileErrorV1, SourceCompileFailureV1,
};
use intar_contracts::catalog::ImageArchitecture;
use intar_contracts::source::SourceCompileErrorCode;
use tokio::sync::watch;

use super::{CompileSourceCommand, compile_source, run_supervisor, unpack_snapshot};
use crate::config::BridgeConfig;
use clap::Parser as _;

const TOP: &str = "acme-scenarios-0123456789abcdef0123456789abcdef01234567";
const REV: &str = "git-1-0123456789abcdef0123456789abcdef01234567-p00000000";
const MANIFEST: &[u8] = b"version: 1\nscope: public\n";
const CHILD_ARGS_ENV: &str = "INTAR_BUILDER_TEST_COMPILE_SOURCE_ARGS";

/// A repository archive laid out like GitHub's: every entry sits below one
/// top-level directory.
struct Snapshot(tar::Builder<GzEncoder<Vec<u8>>>);

impl Snapshot {
    fn new() -> Self {
        let mut snapshot = Self(tar::Builder::new(GzEncoder::new(
            Vec::new(),
            Compression::default(),
        )));
        snapshot.dir("");
        snapshot
    }

    /// What codeload sends: a pax global header naming the commit first.
    fn codeload() -> Self {
        let mut builder = tar::Builder::new(GzEncoder::new(Vec::new(), Compression::default()));
        let comment = b"52 comment=0123456789abcdef0123456789abcdef01234567\n";
        let mut header = tar::Header::new_ustar();
        header.set_path("pax_global_header").unwrap();
        header.set_entry_type(tar::EntryType::XGlobalHeader);
        header.set_size(comment.len() as u64);
        header.set_cksum();
        builder.append(&header, &comment[..]).unwrap();
        let mut snapshot = Self(builder);
        snapshot.dir("");
        snapshot
    }

    fn entry(&mut self, path: &str, kind: tar::EntryType, data: &[u8]) -> &mut Self {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(kind);
        header.set_size(data.len() as u64);
        header.set_mode(0o644);
        self.0
            .append_data(&mut header, format!("{TOP}/{path}"), data)
            .unwrap();
        self
    }

    fn file(&mut self, path: &str, data: &[u8]) -> &mut Self {
        self.entry(path, tar::EntryType::Regular, data)
    }

    fn dir(&mut self, path: &str) -> &mut Self {
        self.entry(path, tar::EntryType::Directory, b"")
    }

    /// The release smoke course, which compiles against the platform catalog.
    fn course(&mut self) -> &mut Self {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../intar-image-build/fixtures/release-smoke/courses");
        self.0
            .append_dir_all(format!("{TOP}/courses"), fixture)
            .unwrap();
        self
    }

    fn write(self, path: &Path) {
        std::fs::write(path, self.0.into_inner().unwrap().finish().unwrap()).unwrap();
    }
}

fn unpack(snapshot: Snapshot) -> (tempfile::TempDir, Result<(), super::SourceCompileError>) {
    let temp = tempfile::tempdir().unwrap();
    snapshot.write(&temp.path().join("source.tar.gz"));
    let result = unpack_snapshot(
        &temp.path().join("source.tar.gz"),
        &temp.path().join("tree"),
    );
    (temp, result)
}

fn refusal(result: Result<(), super::SourceCompileError>) -> (SourceCompileErrorCode, String) {
    let error = result.unwrap_err();
    (error.code, format!("{:#}", error.error))
}

#[test]
fn unpacks_only_the_manifest_gitmodules_and_courses_below_the_top_level() {
    for mut snapshot in [Snapshot::codeload(), Snapshot::new()] {
        snapshot
            .file(".github/workflows/intar.yml", b"on: push\n")
            .file(".gitmodules", b"[submodule \"docs\"]\n\tpath = docs\n")
            .dir("courses")
            .dir("courses/linux")
            .file("courses/linux/course.md", b"course")
            .dir("docs")
            .file("intar.yaml", MANIFEST)
            .file("README.md", b"readme");
        let (temp, result) = unpack(snapshot);
        result.unwrap();

        let tree = temp.path().join("tree");
        let mut kept = walk(&tree);
        kept.sort();
        assert_eq!(
            kept,
            [
                ".gitmodules",
                "courses",
                "courses/linux",
                "courses/linux/course.md",
                "intar.yaml",
            ]
        );
    }
}

#[test]
fn a_pax_path_longer_than_100_characters_unpacks_in_full() {
    let long = format!("courses/{}/course.md", "a".repeat(120));
    let mut snapshot = Snapshot::codeload();
    snapshot.file("intar.yaml", MANIFEST);
    snapshot
        .0
        .append_pax_extensions([("path", format!("{TOP}/{long}").as_bytes())])
        .unwrap();
    // The pax path replaces this name, which is outside the courses root.
    let mut header = tar::Header::new_ustar();
    header.set_path(format!("{TOP}/README.md")).unwrap();
    header.set_size(6);
    header.set_mode(0o644);
    header.set_cksum();
    snapshot.0.append(&header, &b"course"[..]).unwrap();
    let (temp, result) = unpack(snapshot);
    result.unwrap();

    assert_eq!(
        std::fs::read(temp.path().join("tree").join(long)).unwrap(),
        b"course"
    );
    assert!(!temp.path().join("tree/README.md").exists());
}

#[test]
fn reads_intar_yaml_before_it_unpacks_anything() {
    // The manifest comes last, as in git's tree order, and still decides
    // what is kept.
    let mut snapshot = Snapshot::new();
    snapshot
        .dir("courses")
        .file("courses/course.md", b"skipped")
        .dir("lessons")
        .file("lessons/course.md", b"kept")
        .file(
            "intar.yaml",
            b"version: 1\nscope: public\ncourses_root: lessons\n",
        );
    let (temp, result) = unpack(snapshot);
    result.unwrap();
    assert!(temp.path().join("tree/lessons/course.md").is_file());
    assert!(!temp.path().join("tree/courses").exists());

    for courses_root in ["/etc", "../x"] {
        let mut snapshot = Snapshot::new();
        snapshot.dir("x").file("x/course.md", b"x").file(
            "intar.yaml",
            format!("version: 1\nscope: public\ncourses_root: {courses_root}\n").as_bytes(),
        );
        let (temp, result) = unpack(snapshot);
        assert_eq!(refusal(result).0, SourceCompileErrorCode::ManifestInvalid);
        assert!(!temp.path().join("tree").exists());
    }

    let mut snapshot = Snapshot::new();
    snapshot.dir("courses").file("courses/course.md", b"x");
    assert_eq!(
        refusal(unpack(snapshot).1).0,
        SourceCompileErrorCode::ManifestMissing
    );
}

#[test]
fn rejects_links_and_devices_it_would_keep() {
    for kind in [
        tar::EntryType::Symlink,
        tar::EntryType::Link,
        tar::EntryType::Char,
        tar::EntryType::Block,
        tar::EntryType::Fifo,
    ] {
        let mut snapshot = Snapshot::new();
        snapshot
            .file("intar.yaml", MANIFEST)
            .dir("courses")
            .entry("courses/course.md", kind, b"");
        let (code, message) = refusal(unpack(snapshot).1);
        assert_eq!(code, SourceCompileErrorCode::CompileFailed, "{kind:?}");
        assert!(
            message.contains("'courses/course.md' is a link"),
            "{message}"
        );
    }

    // Outside the kept paths a link is never written, so it is ignored.
    let mut snapshot = Snapshot::new();
    snapshot
        .file("intar.yaml", MANIFEST)
        .entry("README.md", tar::EntryType::Symlink, b"");
    unpack(snapshot).1.unwrap();
}

#[test]
fn holds_the_expanded_size_limit_on_kept_files() {
    let half = vec![b'x'; 2 * 1024 * 1024];
    let mut snapshot = Snapshot::new();
    snapshot
        .file("intar.yaml", MANIFEST)
        .file("assets/big.bin", &half)
        .file("assets/bigger.bin", &half)
        .dir("courses")
        .file("courses/a.md", &half)
        .file("courses/b.md", &half[..half.len() - MANIFEST.len()]);
    unpack(snapshot).1.unwrap();

    let mut snapshot = Snapshot::new();
    snapshot
        .file("intar.yaml", MANIFEST)
        .dir("courses")
        .file("courses/a.md", &half)
        .file("courses/b.md", &half[..half.len() - MANIFEST.len() + 1]);
    assert_eq!(
        refusal(unpack(snapshot).1).0,
        SourceCompileErrorCode::BundleTooLarge
    );
}

/// Runs the child entry in this process and reads what it wrote.
fn compile_in_process(
    snapshot: Snapshot,
) -> (tempfile::TempDir, Option<Vec<SourceCompileErrorV1>>) {
    let temp = tempfile::tempdir().unwrap();
    let archive = temp.path().join("source.tar.gz");
    snapshot.write(&archive);
    compile_source(&CompileSourceCommand {
        snapshot: archive,
        out: temp.path().to_path_buf(),
        rev: REV.to_owned(),
        arch: "x86_64".to_owned(),
    })
    .unwrap();
    let errors = std::fs::read(temp.path().join("errors.json"))
        .ok()
        .map(|errors| serde_json::from_slice(&errors).unwrap());
    (temp, errors)
}

#[test]
fn the_child_entry_compiles_a_repository_snapshot() {
    let mut snapshot = Snapshot::codeload();
    snapshot.file("intar.yaml", MANIFEST).course();
    let (temp, errors) = compile_in_process(snapshot);

    assert!(errors.is_none(), "{errors:?}");
    let meta: serde_json::Value =
        serde_json::from_slice(&std::fs::read(temp.path().join("meta.json")).unwrap()).unwrap();
    assert_eq!(meta["rev"], REV);
    assert_eq!(meta["source"]["scope"], "public");
    assert!(temp.path().join("bundle.tar.gz").is_file());
}

#[test]
fn an_empty_directory_under_the_courses_root_is_a_submodule() {
    // A gitlink shows up in an archive only as an empty directory entry.
    let mut snapshot = Snapshot::codeload();
    snapshot
        .file("intar.yaml", MANIFEST)
        .course()
        .dir("courses/vendored");
    let (_temp, errors) = compile_in_process(snapshot);

    let errors = errors.unwrap();
    assert_eq!(errors[0].code, SourceCompileErrorCode::SubmoduleUnsupported);
    assert!(
        errors[0].message.contains("'courses/vendored'"),
        "{errors:?}"
    );
}

#[test]
fn diagnostics_carry_no_unpack_root() {
    let mut snapshot = Snapshot::codeload();
    snapshot
        .file("intar.yaml", MANIFEST)
        .dir("courses")
        .dir("courses/linux")
        .file("courses/linux/course.md", b"no frontmatter\n");
    let (temp, errors) = compile_in_process(snapshot);

    let errors = errors.unwrap();
    assert_eq!(errors[0].code, SourceCompileErrorCode::CompileFailed);
    assert!(
        errors[0].message.contains("courses/linux/course.md"),
        "{errors:?}"
    );
    let root = temp.path().display().to_string();
    assert!(!errors[0].message.contains(&root), "{errors:?}");
}

/// The supervisor tests' real child: `stack_overflow_…` runs the compile in
/// a re-run of this test binary.
#[test]
fn child_process_entry() {
    let Ok(args) = std::env::var(CHILD_ARGS_ENV) else {
        return;
    };
    compile_source(&CompileSourceCommand::try_parse_from(args.split(' ')).unwrap()).unwrap();
}

#[derive(Debug)]
struct Request {
    target: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    fn body_text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// A local Worker: bootstrap, the snapshot route and the result route, which
/// answers from `results` and then with 200.
struct Worker {
    base_url: String,
    requests: Arc<Mutex<Vec<Request>>>,
}

impl Worker {
    fn serve(snapshot: Vec<u8>, results: Vec<(u16, &'static str, &'static str)>) -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&requests);
        let mut results = VecDeque::from(results);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let Some(request) = read_request(&mut stream) else {
                    continue;
                };
                let (status, extra, body) = if request.target == "/api/agent/bootstrap" {
                    (200, "", br#"{"accessToken":"token"}"#.to_vec())
                } else if request.target.contains("/result?") {
                    let (status, extra, body) = results.pop_front().unwrap_or((200, "", "{}"));
                    (status, extra, body.as_bytes().to_vec())
                } else {
                    (200, "", snapshot.clone())
                };
                recorded.lock().unwrap().push(request);
                let head = format!(
                    "HTTP/1.1 {status} X\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&body);
            }
        });
        Self { base_url, requests }
    }

    fn results(&self) -> Vec<Request> {
        self.requests
            .lock()
            .unwrap()
            .drain(..)
            .filter(|request| request.target.contains("/result?"))
            .collect()
    }

    fn snapshot_fetches(&self) -> usize {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| {
                request.target.starts_with("/agent/registry/sources/")
                    && !request.target.contains("/result?")
            })
            .count()
    }

    fn result_count(&self) -> usize {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.target.contains("/result?"))
            .count()
    }
}

fn read_request(stream: &mut std::net::TcpStream) -> Option<Request> {
    let mut data = Vec::new();
    let mut chunk = [0_u8; 8192];
    let header_end = loop {
        if let Some(end) = data.windows(4).position(|window| window == b"\r\n\r\n") {
            break end;
        }
        let read = stream.read(&mut chunk).ok().filter(|read| *read > 0)?;
        data.extend_from_slice(&chunk[..read]);
    };
    let head = String::from_utf8_lossy(&data[..header_end]).into_owned();
    let mut lines = head.split("\r\n");
    let target = lines.next()?.split(' ').nth(1)?.to_owned();
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(key, value)| (key.trim().to_owned(), value.trim().to_owned()))
        .collect::<Vec<_>>();
    let length = headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = data[header_end + 4..].to_vec();
    while body.len() < length {
        let read = stream.read(&mut chunk).ok().filter(|read| *read > 0)?;
        body.extend_from_slice(&chunk[..read]);
    }
    Some(Request {
        target,
        headers,
        body,
    })
}

/// A supervisor whose child is `script`, a shell script that gets the
/// child's argv: `compile-source --snapshot <file> --out <dir> --rev=<rev>
/// --arch <arch>`, so `$3` is the snapshot and `$5` the output directory.
struct Supervisor {
    temp: tempfile::TempDir,
    work_dir: PathBuf,
    worker: Worker,
    desired: watch::Sender<Vec<DesiredSourceCompileV1>>,
    task: tokio::task::JoinHandle<()>,
}

impl Supervisor {
    fn start(script: &str, worker: Worker) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let program = temp.path().join("child.sh");
        std::fs::write(
            &program,
            format!(
                "#!/bin/sh\nPIDS='{}'\n{script}\n",
                temp.path().join("pids").display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        let work_dir = temp.path().join("work");
        let bridge = BridgeConfig {
            base_url: worker.base_url.clone(),
            host_id: "builder-1".to_owned(),
            bootstrap_token: "bootstrap".to_owned(),
            ..BridgeConfig::default()
        };
        let (desired, receiver) = watch::channel(Vec::new());
        let task = tokio::spawn(run_supervisor(bridge, work_dir.clone(), program, receiver));
        Self {
            temp,
            work_dir,
            worker,
            desired,
            task,
        }
    }

    fn pids(&self) -> Vec<String> {
        std::fs::read_to_string(self.temp.path().join("pids"))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }
}

fn compile(compile_id: &str, validate_only: bool) -> DesiredSourceCompileV1 {
    DesiredSourceCompileV1 {
        compile_id: compile_id.to_owned(),
        attempt: 3,
        rev: REV.to_owned(),
        validate_only,
        arch: ImageArchitecture::X86_64,
    }
}

async fn eventually(what: &str, condition: impl Fn() -> bool) {
    for _ in 0..500 {
        if condition() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("timed out waiting until {what}");
}

fn alive(pid: &str) -> bool {
    std::process::Command::new("kill")
        .args(["-0", pid])
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap()
        .success()
}

const COMPILED: &str = r#"mkdir -p "$5/tree"
printf '{"snapshot_bytes":%s}' "$(wc -c < "$3" | tr -d ' ')" > "$5/meta.json"
printf 'archive' > "$5/bundle.tar.gz""#;
const REFUSED: &str = r#"mkdir -p "$5/tree"
printf '[{"code":"manifest_missing","message":"intar.yaml is missing"}]' > "$5/errors.json""#;
const HANGS: &str = r#"mkdir -p "$5/tree"
echo $$ >> "$PIDS"
exec sleep 30"#;

#[tokio::test]
async fn posts_a_compiled_result_as_multipart_with_a_content_length() {
    let supervisor = Supervisor::start(COMPILED, Worker::serve(b"snapshot".to_vec(), Vec::new()));
    supervisor
        .desired
        .send_replace(vec![compile("compile-1", false)]);
    eventually("the result is posted", || {
        supervisor.worker.result_count() == 1
    })
    .await;
    eventually("the work directory is removed", || {
        !supervisor.work_dir.exists()
    })
    .await;

    let fetches = supervisor.worker.requests.lock().unwrap();
    assert!(fetches.iter().any(|request| request.target
        == "/agent/registry/sources/compile-1?attempt=3"
        && request.header("authorization") == Some("Bearer token")));
    drop(fetches);
    let [result] = <[Request; 1]>::try_from(supervisor.worker.results()).unwrap();
    assert_eq!(
        result.target,
        "/agent/registry/sources/compile-1/result?attempt=3"
    );
    assert_eq!(result.header("authorization"), Some("Bearer token"));
    assert!(
        result
            .header("content-type")
            .unwrap()
            .starts_with("multipart/form-data; boundary=")
    );
    assert_eq!(
        result.header("content-length"),
        Some(result.body.len().to_string().as_str())
    );
    assert_eq!(result.header("transfer-encoding"), None);
    let body = result.body_text();
    assert!(
        body.contains(
            "Content-Disposition: form-data; name=\"meta\"\r\n\r\n{\"snapshot_bytes\":8}\r\n"
        ),
        "{body}"
    );
    assert!(body.contains(&format!("Content-Disposition: form-data; name=\"bundle\"; filename=\"{REV}.tar.gz\"\r\nContent-Type: application/gzip\r\n\r\narchive\r\n")), "{body}");
    assert!(!supervisor.task.is_finished());
}

#[tokio::test]
async fn validate_only_posts_the_meta_without_the_archive() {
    let supervisor = Supervisor::start(COMPILED, Worker::serve(b"snapshot".to_vec(), Vec::new()));
    supervisor
        .desired
        .send_replace(vec![compile("compile-1", true)]);
    eventually("the result is posted", || {
        supervisor.worker.result_count() == 1
    })
    .await;

    let body = supervisor.worker.results()[0].body_text();
    assert!(body.contains("name=\"meta\""), "{body}");
    assert!(!body.contains("name=\"bundle\""), "{body}");
}

#[tokio::test]
async fn posts_a_refused_compile_as_json() {
    let supervisor = Supervisor::start(REFUSED, Worker::serve(b"snapshot".to_vec(), Vec::new()));
    supervisor
        .desired
        .send_replace(vec![compile("compile-1", false)]);
    eventually("the result is posted", || {
        supervisor.worker.result_count() == 1
    })
    .await;
    eventually("the work directory is removed", || {
        !supervisor.work_dir.exists()
    })
    .await;

    let [result] = <[Request; 1]>::try_from(supervisor.worker.results()).unwrap();
    assert_eq!(
        result.target,
        "/agent/registry/sources/compile-1/result?attempt=3"
    );
    assert_eq!(result.header("content-type"), Some("application/json"));
    assert_eq!(
        result.header("content-length"),
        Some(result.body.len().to_string().as_str())
    );
    let failure: SourceCompileFailureV1 = serde_json::from_slice(&result.body).unwrap();
    assert_eq!(failure.compile_id, "compile-1");
    assert_eq!(failure.attempt, 3);
    assert_eq!(
        failure.errors[0].code,
        SourceCompileErrorCode::ManifestMissing
    );
}

#[tokio::test]
async fn drops_a_refused_result_and_retries_an_unavailable_worker() {
    let refusal = include_str!("../../../intar-contracts/fixtures/source/source-refusal-v1.json");
    let supervisor = Supervisor::start(
        COMPILED,
        Worker::serve(
            b"snapshot".to_vec(),
            vec![
                (503, "Retry-After: 0\r\n", "maintenance"),
                (200, "", "{}"),
                (409, "", refusal),
            ],
        ),
    );
    supervisor
        .desired
        .send_replace(vec![compile("compile-1", false)]);
    eventually("the result is posted twice", || {
        supervisor.worker.result_count() == 2
    })
    .await;
    assert_eq!(
        supervisor.worker.snapshot_fetches(),
        1,
        "a 503 re-posts without recompiling"
    );

    supervisor.desired.send_replace(vec![
        compile("compile-1", false),
        compile("compile-2", false),
    ]);
    eventually("the refused result is posted", || {
        supervisor.worker.result_count() == 3
    })
    .await;
    tokio::time::sleep(super::RETRY_DELAY * 5).await;
    assert_eq!(supervisor.worker.result_count(), 3, "a 409 is not retried");
    assert_eq!(supervisor.worker.snapshot_fetches(), 2);
}

#[tokio::test]
async fn a_crashed_child_is_posted_as_a_compile_failure() {
    let supervisor = Supervisor::start(
        "mkdir -p \"$5/tree\"\nkill -SEGV $$",
        Worker::serve(b"snapshot".to_vec(), Vec::new()),
    );
    supervisor
        .desired
        .send_replace(vec![compile("compile-1", false)]);
    eventually("the result is posted", || {
        supervisor.worker.result_count() == 1
    })
    .await;
    eventually("the work directory is removed", || {
        !supervisor.work_dir.exists()
    })
    .await;

    let failure: SourceCompileFailureV1 =
        serde_json::from_slice(&supervisor.worker.results()[0].body).unwrap();
    assert_eq!(
        failure.errors[0].code,
        SourceCompileErrorCode::CompileFailed
    );
    assert!(
        failure.errors[0].message.contains("the compiler stopped"),
        "{failure:?}"
    );
    assert!(!supervisor.task.is_finished());
}

#[tokio::test]
async fn the_timeout_kills_the_child_and_posts_a_failure() {
    let supervisor = Supervisor::start(HANGS, Worker::serve(b"snapshot".to_vec(), Vec::new()));
    supervisor
        .desired
        .send_replace(vec![compile("compile-1", false)]);
    eventually("the child starts", || supervisor.pids().len() == 1).await;
    eventually("the result is posted", || {
        supervisor.worker.result_count() == 1
    })
    .await;
    eventually("the work directory is removed", || {
        !supervisor.work_dir.exists()
    })
    .await;

    assert!(!alive(&supervisor.pids()[0]));
    let failure: SourceCompileFailureV1 =
        serde_json::from_slice(&supervisor.worker.results()[0].body).unwrap();
    assert!(
        failure.errors[0].message.contains("did not finish"),
        "{failure:?}"
    );
}

#[tokio::test]
async fn leaving_the_desired_state_kills_the_child_without_a_result() {
    let supervisor = Supervisor::start(HANGS, Worker::serve(b"snapshot".to_vec(), Vec::new()));
    supervisor
        .desired
        .send_replace(vec![compile("compile-1", false)]);
    eventually("the child starts", || supervisor.pids().len() == 1).await;
    assert!(supervisor.work_dir.join("source.tar.gz").is_file());
    assert!(supervisor.work_dir.join("tree").is_dir());

    supervisor.desired.send_replace(Vec::new());
    eventually("the work directory is removed", || {
        !supervisor.work_dir.exists()
    })
    .await;
    assert!(!alive(&supervisor.pids()[0]));
    assert_eq!(supervisor.worker.result_count(), 0);
}

#[tokio::test]
async fn ten_head_moves_leave_at_most_one_live_child() {
    let supervisor = Supervisor::start(HANGS, Worker::serve(b"snapshot".to_vec(), Vec::new()));
    for head in 0..10 {
        supervisor
            .desired
            .send_replace(vec![compile(&format!("compile-{head}"), false)]);
        eventually("the next child starts", || {
            supervisor.pids().len() == head + 1
        })
        .await;
        let pids = supervisor.pids();
        let live = pids.iter().filter(|pid| alive(pid)).collect::<Vec<_>>();
        assert_eq!(live, [&pids[head]]);
    }
    supervisor.desired.send_replace(Vec::new());
    eventually("the work directory is removed", || {
        !supervisor.work_dir.exists()
    })
    .await;
    assert!(supervisor.pids().iter().all(|pid| !alive(pid)));
    assert_eq!(supervisor.worker.result_count(), 0);
}

#[tokio::test]
async fn a_stack_overflow_in_the_compiler_is_a_compile_failure() {
    // hcl-edit has no depth limit, so this overflows the child's stack.
    let deep = format!(
        "scenario \"deep\" {{\n  meta = {}1{}\n}}\n",
        "[".repeat(100_000),
        "]".repeat(100_000)
    );
    let mut snapshot = Snapshot::codeload();
    snapshot.file("intar.yaml", MANIFEST).course().file(
        "courses/release-smoke/01-broken-nginx/scenario.hcl",
        deep.as_bytes(),
    );
    let temp = tempfile::tempdir().unwrap();
    snapshot.write(&temp.path().join("snapshot.tar.gz"));
    let script = format!(
        "{CHILD_ARGS_ENV}=\"$*\" exec '{}' --exact source_compile::tests::child_process_entry --test-threads=1",
        std::env::current_exe().unwrap().display()
    );
    let supervisor = Supervisor::start(
        &script,
        Worker::serve(
            std::fs::read(temp.path().join("snapshot.tar.gz")).unwrap(),
            Vec::new(),
        ),
    );
    supervisor
        .desired
        .send_replace(vec![compile("compile-1", false)]);
    eventually("the result is posted", || {
        supervisor.worker.result_count() == 1
    })
    .await;
    eventually("the work directory is removed", || {
        !supervisor.work_dir.exists()
    })
    .await;

    let failure: SourceCompileFailureV1 =
        serde_json::from_slice(&supervisor.worker.results()[0].body).unwrap();
    assert_eq!(
        failure.errors[0].code,
        SourceCompileErrorCode::CompileFailed
    );
    assert!(
        failure.errors[0]
            .message
            .starts_with("the compiler stopped: signal"),
        "{failure:?}"
    );
    assert!(!supervisor.task.is_finished(), "the builder keeps running");
}

fn walk(root: &Path) -> Vec<String> {
    let mut paths = Vec::new();
    for entry in std::fs::read_dir(root).unwrap() {
        let path = entry.unwrap().path();
        let relative = path.strip_prefix(root).unwrap().display().to_string();
        if path.is_dir() {
            paths.extend(
                walk(&path)
                    .into_iter()
                    .map(|child| format!("{relative}/{child}")),
            );
        }
        paths.push(relative);
    }
    paths
}
