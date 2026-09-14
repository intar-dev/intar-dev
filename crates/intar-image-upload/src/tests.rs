#![allow(clippy::unwrap_used)]

//! Protocol tests for the registry admission session.
//!
//! A small threaded HTTP server stands in for the registry. It lets each test
//! assert the exact call sequence, the auth header, the session header, the
//! heartbeat behaviour, and how the client reacts to a registry that refuses,
//! loses, or supersedes the session.

use std::collections::BTreeMap;
use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use intar_contracts::catalog::{
    IMAGE_CHUNK_ENCODING, IMAGE_CHUNK_SIZE_BYTES, ImageArchitecture, ImageChunkManifestV1,
    ImageChunkV1, ImageFormat, ImageKey, Mib, ScenarioDifficulty, ScenarioManifestV4,
    ScenarioVmBootManifestV4, ScenarioVmManifestV4,
};
use sha2::{Digest as _, Sha256};

use crate::error::Error;
use crate::{
    ImageChunkLookup, ImageUploadConfig, ImageUploader, PublishArtifactFile, PublishBuildIdentity,
    PublishChunkedImage, PublishImageChunkFile,
};

/// The control-plane build assignment that authorizes the builder publish path.
fn fixture_identity() -> PublishBuildIdentity {
    PublishBuildIdentity::new(
        "build-1",
        "rev-1",
        "a".repeat(64),
        ImageArchitecture::X86_64,
    )
    .unwrap()
}

/// The same chunk without its local payload: the form a builder uses for a
/// chunk the registry already stores.
fn reused_chunk(chunk: &PublishImageChunkFile) -> PublishImageChunkFile {
    PublishImageChunkFile::from_optional_path(
        &ImageChunkV1 {
            index: 0,
            raw_size_bytes: chunk.raw_size_bytes,
            raw_sha256: chunk.raw_sha256.clone(),
            encoded_size_bytes: chunk.encoded_size_bytes,
            encoded_sha256: chunk.encoded_sha256.clone(),
        },
        None,
    )
    .unwrap()
}

/// A session whose lease is short enough that a slow test upload must beat.
const OPENED_SESSION: &str = concat!(
    r#"{"ok":true,"session_id":"session-1","state":"open","expires_at_unix_ms":1,"#,
    r#""heartbeat_interval_ms":300,"protocol":{"version":1,"session_required":true,"enforcement":"enforce"}}"#,
);
/// A session that outlives the test, so nothing beats during the upload.
const QUIET_SESSION: &str = concat!(
    r#"{"ok":true,"session_id":"session-1","state":"open","expires_at_unix_ms":1,"#,
    r#""heartbeat_interval_ms":60000,"protocol":{"version":1,"session_required":true,"enforcement":"enforce"}}"#,
);
/// The replacement session a superseded upload restarts on.
const SECOND_SESSION: &str = concat!(
    r#"{"ok":true,"session_id":"session-2","state":"open","expires_at_unix_ms":1,"#,
    r#""heartbeat_interval_ms":60000,"protocol":{"version":1,"session_required":true,"enforcement":"enforce"}}"#,
);
/// The conflict a sweep returns while it holds the registry.
const SWEEP_IN_PROGRESS: &str =
    r#"{"error":"registry sweep in progress","code":"registry_sweep_in_progress"}"#;
const SESSION_SUPERSEDED: &str =
    r#"{"error":"session superseded","code":"registry_session_superseded"}"#;
const SESSION_CLOSED: &str = r#"{"error":"registry upload session is closed","code":"registry_session_closed","state":"reaped"}"#;

#[derive(Clone, Debug)]
struct RecordedRequest {
    method: String,
    path: String,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

impl RecordedRequest {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }

    fn session(&self) -> Option<&str> {
        self.header("x-intar-registry-session")
    }

    fn json_body(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).unwrap()
    }

    /// Short label for the call, so a test can assert the whole sequence.
    fn marker(&self) -> &'static str {
        let path = self.path.as_str();
        if path == "/registry/v1/upload-sessions" {
            "open"
        } else if path.ends_with("/heartbeat") {
            "heartbeat"
        } else if path == "/registry/v1/uploads/complete" {
            "upload-complete"
        } else if path.ends_with("/complete") {
            "complete"
        } else if path == "/registry/v1/image-chunks/exists" {
            "exists"
        } else if path.starts_with("/registry/v1/image-chunks/") {
            "chunk"
        } else if path.starts_with("/registry/v1/image-manifests/") {
            "manifest"
        } else if path == "/registry/v1/uploads" {
            "upload-create"
        } else if path.starts_with("/registry/v1/uploads/parts") {
            "upload-part"
        } else if path == "/registry/v1/publish" {
            "publish"
        } else {
            "other"
        }
    }
}

struct MockResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
    delay: Duration,
}

impl MockResponse {
    fn json(status: u16, body: impl Into<String>) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: body.into(),
            delay: Duration::ZERO,
        }
    }

    fn delayed(mut self, delay: Duration) -> Self {
        self.delay = delay;
        self
    }

    fn with_header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_owned(), value.to_owned()));
        self
    }
}

struct MockRegistry {
    base_url: String,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
}

impl MockRegistry {
    fn start<F>(routes: F) -> Self
    where
        F: Fn(&RecordedRequest) -> MockResponse + Send + Sync + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let routes: Arc<dyn Fn(&RecordedRequest) -> MockResponse + Send + Sync> = Arc::new(routes);
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&requests);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let routes = Arc::clone(&routes);
                let recorded = Arc::clone(&recorded);
                // One thread per connection: a delayed response must not block
                // the heartbeat request that runs while it is in flight.
                std::thread::spawn(move || {
                    let Some(request) = read_request(&mut stream) else {
                        return;
                    };
                    let response = routes(&request);
                    recorded.lock().unwrap().push(request);
                    if !response.delay.is_zero() {
                        std::thread::sleep(response.delay);
                    }
                    write_response(&mut stream, &response);
                });
            }
        });
        Self { base_url, requests }
    }

    fn uploader(&self) -> ImageUploader {
        ImageUploader::new(ImageUploadConfig::new(
            format!("{}/registry/v1/publish", self.base_url),
            "publish-token",
        ))
        .unwrap()
    }

    fn recorded(&self) -> Vec<RecordedRequest> {
        self.requests.lock().unwrap().clone()
    }

    fn markers(&self) -> Vec<&'static str> {
        self.recorded()
            .iter()
            .map(RecordedRequest::marker)
            .collect()
    }

    /// How many admission sessions the upload opened.
    fn open_count(&self) -> usize {
        self.markers()
            .iter()
            .filter(|marker| **marker == "open")
            .count()
    }

    fn sessions_used(&self, marker: &str) -> Vec<String> {
        self.recorded()
            .iter()
            .filter(|request| request.marker() == marker)
            .map(|request| {
                request
                    .session()
                    .unwrap_or_else(|| panic!("{marker} carried no session header"))
                    .to_owned()
            })
            .collect()
    }

    fn outcome(&self) -> String {
        self.outcomes()
            .into_iter()
            .next()
            .unwrap_or_else(|| panic!("the client never completed the upload session"))
    }

    fn outcomes(&self) -> Vec<String> {
        self.recorded()
            .iter()
            .filter(|request| request.marker() == "complete")
            .map(|request| request.json_body()["outcome"].as_str().unwrap().to_owned())
            .collect()
    }
}

fn read_request(stream: &mut TcpStream) -> Option<RecordedRequest> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).ok()? == 0 {
        return None;
    }
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?.to_owned();
    let path = parts.next()?.to_owned();

    let mut headers = BTreeMap::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).ok()? == 0 {
            break;
        }
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_owned());
        }
    }

    let mut body = Vec::new();
    if headers
        .get("transfer-encoding")
        .is_some_and(|value| value.eq_ignore_ascii_case("chunked"))
    {
        loop {
            let mut size_line = String::new();
            if reader.read_line(&mut size_line).ok()? == 0 {
                break;
            }
            let size = usize::from_str_radix(size_line.trim(), 16).ok()?;
            if size == 0 {
                let mut trailer = String::new();
                let _ = reader.read_line(&mut trailer);
                break;
            }
            let mut chunk = vec![0u8; size];
            reader.read_exact(&mut chunk).ok()?;
            body.extend_from_slice(&chunk);
            let mut crlf = [0u8; 2];
            reader.read_exact(&mut crlf).ok()?;
        }
    } else if let Some(length) = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
    {
        body.resize(length, 0);
        reader.read_exact(&mut body).ok()?;
    }

    Some(RecordedRequest {
        method,
        path,
        headers,
        body,
    })
}

fn write_response(stream: &mut TcpStream, response: &MockResponse) {
    let mut head = format!(
        "HTTP/1.1 {} {}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n",
        response.status,
        reason(response.status),
        response.body.len(),
    );
    for (name, value) in &response.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(response.body.as_bytes());
    let _ = stream.flush();
}

const fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        409 => "Conflict",
        410 => "Gone",
        423 => "Locked",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Status",
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

struct PublishFixture {
    manifest: ScenarioManifestV4,
    image: PublishChunkedImage,
    artifacts: Vec<PublishArtifactFile>,
    _dir: tempfile::TempDir,
}

fn publish_fixture() -> PublishFixture {
    let dir = tempfile::tempdir().unwrap();
    let raw = b"raw-image-chunk";
    let encoded = b"encoded-image-chunk";
    let mut chunk_manifest = ImageChunkManifestV1 {
        schema_version: 1,
        image_id: String::new(),
        virtual_size_bytes: raw.len() as u64,
        chunk_size_bytes: IMAGE_CHUNK_SIZE_BYTES,
        encoding: IMAGE_CHUNK_ENCODING.to_owned(),
        chunks: vec![ImageChunkV1 {
            index: 0,
            raw_size_bytes: raw.len() as u32,
            raw_sha256: sha256_hex(raw),
            encoded_size_bytes: encoded.len() as u64,
            encoded_sha256: sha256_hex(encoded),
        }],
    };
    chunk_manifest.image_id = chunk_manifest.compute_image_id().unwrap();
    let manifest_bytes = serde_json::to_vec(&chunk_manifest).unwrap();
    let chunk_manifest_sha256 = sha256_hex(&manifest_bytes);
    let chunk_manifest_path = dir.path().join("chunk-manifest.json");
    std::fs::write(&chunk_manifest_path, &manifest_bytes).unwrap();
    let encoded_path = dir.path().join("chunk-0.zst");
    std::fs::write(&encoded_path, encoded).unwrap();
    let artifact_path = dir.path().join("vmlinuz");
    std::fs::write(&artifact_path, b"kernel-image").unwrap();

    let manifest = ScenarioManifestV4 {
        schema_version: 4,
        scenario_id: "scenario-1".to_owned(),
        name: "Scenario One".to_owned(),
        title: "Scenario One".to_owned(),
        category: "kubernetes".to_owned(),
        description: "protocol fixture".to_owned(),
        difficulty: ScenarioDifficulty::Easy,
        estimated_minutes: 10,
        tags: vec![],
        briefing_markdown: String::new(),
        solution_markdown: String::new(),
        hints: vec![],
        vms: vec![ScenarioVmManifestV4 {
            name: "vm-1".to_owned(),
            image_key: ImageKey {
                scenario: "scenario-1".to_owned(),
                vm: "vm-1".to_owned(),
                arch: ImageArchitecture::X86_64,
            },
            image_id: chunk_manifest.image_id.clone(),
            image_format: ImageFormat::RawChunksV1,
            image_virtual_size_bytes: chunk_manifest.virtual_size_bytes,
            chunk_manifest_sha256: chunk_manifest_sha256.clone(),
            guest_bootstrap_abi: 1,
            boot: ScenarioVmBootManifestV4 {
                kernel_sha256: sha256_hex(b"kernel-image"),
                initrd_sha256: "b".repeat(64),
                cmdline: "console=ttyS0".to_owned(),
            },
            cpu_millis: 1000,
            vcpu_count: 1,
            memory_mib: Mib(512),
            disk_mib: Mib(1024),
            probes: vec![],
        }],
    };
    let image = PublishChunkedImage::new(
        "vm-1",
        &chunk_manifest.image_id,
        &chunk_manifest_sha256,
        &chunk_manifest_path,
        vec![
            PublishImageChunkFile::from_optional_path(
                &chunk_manifest.chunks[0],
                Some(&encoded_path),
            )
            .unwrap(),
        ],
    )
    .unwrap();

    PublishFixture {
        manifest,
        image,
        artifacts: vec![
            PublishArtifactFile::new(&artifact_path, sha256_hex(b"kernel-image")).unwrap(),
        ],
        _dir: dir,
    }
}

const PUBLISH_RECEIPT: &str = concat!(
    r#"{"ok":true,"scenario_id":"scenario-1","images":[{"image_key":"scenario-1-vm-1-x86_64","#,
    r#""image_id":"1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a","#,
    r#""object_key":"images/scenario-1-vm-1-x86_64/1a1a.raw.zst","bytes":19}],"artifacts":[]}"#,
);

/// Routes for one full publish. The chunk delay lets a test hold the upload
/// open long enough for a heartbeat to run.
fn publishing_routes(
    heartbeat_status: u16,
    heartbeat_body: &'static str,
    chunk_delay: Duration,
    session: &'static str,
) -> impl Fn(&RecordedRequest) -> MockResponse + Send + Sync + 'static {
    move |request| match request.marker() {
        "open" => MockResponse::json(201, session),
        "heartbeat" => MockResponse::json(heartbeat_status, heartbeat_body),
        "exists" => MockResponse::json(200, r#"{"existing":[]}"#),
        "chunk" => MockResponse::json(201, r#"{"ok":true}"#).delayed(chunk_delay),
        "manifest" => MockResponse::json(201, r#"{"ok":true}"#),
        "upload-create" => MockResponse::json(
            201,
            r#"{"object_key":"artifacts/kernel","upload_id":"upload-1","already_exists":false}"#,
        ),
        "upload-part" => MockResponse::json(200, r#"{"part_number":1,"etag":"etag-1"}"#),
        "upload-complete" => MockResponse::json(200, r#"{"ok":true,"bytes":12}"#),
        "publish" => MockResponse::json(201, PUBLISH_RECEIPT),
        "complete" => MockResponse::json(200, r#"{"ok":true,"state":"completed"}"#),
        other => MockResponse::json(400, format!(r#"{{"error":"unexpected {other}"}}"#)),
    }
}

#[test]
fn publishes_every_object_under_one_admitted_session() {
    let fixture = publish_fixture();
    let registry = MockRegistry::start(publishing_routes(
        200,
        r#"{"ok":true}"#,
        Duration::ZERO,
        QUIET_SESSION,
    ));
    let uploader = registry.uploader();

    let receipt = uploader
        .publish_manifest_with_artifacts(&fixture.manifest, &[fixture.image], &fixture.artifacts)
        .unwrap();
    assert!(receipt.ok);

    assert_eq!(
        registry.markers(),
        vec![
            "open",
            "exists",
            "chunk",
            "manifest",
            "upload-create",
            "upload-part",
            "upload-complete",
            "publish",
            "complete",
        ]
    );
    assert_eq!(registry.open_count(), 1);
    assert_eq!(registry.sessions_used("exists"), vec!["session-1"]);

    for request in registry.recorded() {
        assert_eq!(
            request.header("authorization"),
            Some("Bearer publish-token"),
            "{} {} must carry the upload credentials",
            request.method,
            request.path
        );
        let expected = if request.marker() == "open" {
            // The session is named by the open response, so it cannot be sent.
            None
        } else {
            Some("session-1")
        };
        assert_eq!(
            request.session(),
            expected,
            "{} {} carried the wrong session header",
            request.method,
            request.path
        );
    }
    assert_eq!(registry.outcome(), "published");
}

#[test]
fn keeps_a_long_upload_admitted_with_heartbeats() {
    let fixture = publish_fixture();
    let registry = MockRegistry::start(publishing_routes(
        200,
        r#"{"ok":true}"#,
        Duration::from_millis(1600),
        OPENED_SESSION,
    ));
    let uploader = registry.uploader();

    uploader
        .publish_manifest_with_artifacts(&fixture.manifest, &[fixture.image], &fixture.artifacts)
        .unwrap();

    assert!(
        registry.markers().contains(&"heartbeat"),
        "a slow upload must heartbeat before it finishes"
    );
    assert!(
        registry
            .sessions_used("heartbeat")
            .iter()
            .all(|session| session == "session-1"),
        "every beat must name the open session"
    );
    assert_eq!(registry.outcome(), "published");
}

#[test]
fn stops_the_upload_when_the_heartbeat_fails() {
    let fixture = publish_fixture();
    let registry = MockRegistry::start(publishing_routes(
        503,
        r#"{"error":"admission unavailable"}"#,
        Duration::from_millis(1600),
        OPENED_SESSION,
    ));
    let uploader = registry.uploader();

    let error = uploader
        .publish_manifest_with_artifacts(&fixture.manifest, &[fixture.image], &fixture.artifacts)
        .unwrap_err();

    assert!(
        matches!(error, Error::SessionBroken { .. }),
        "a lost heartbeat must stop the upload, got {error}"
    );
    let markers = registry.markers();
    assert!(markers.contains(&"heartbeat"));
    assert!(
        !markers.contains(&"manifest") && !markers.contains(&"publish"),
        "the client wrote after the registry stopped admitting it: {markers:?}"
    );
    assert_eq!(registry.outcome(), "abandoned");
}

#[test]
fn restarts_on_a_superseded_session_before_any_further_write() {
    let fixture = publish_fixture();
    let opens = Arc::new(AtomicU32::new(0));
    let counted = Arc::clone(&opens);
    let registry = MockRegistry::start(move |request| match request.marker() {
        "open" => {
            let attempt = counted.fetch_add(1, Ordering::SeqCst);
            MockResponse::json(
                201,
                if attempt == 0 {
                    OPENED_SESSION
                } else {
                    SECOND_SESSION
                },
            )
        }
        // The first session is superseded while the chunk is in flight.
        "heartbeat" if request.session() == Some("session-1") => {
            MockResponse::json(409, SESSION_SUPERSEDED)
        }
        "heartbeat" => MockResponse::json(200, r#"{"ok":true}"#),
        "exists" => MockResponse::json(200, r#"{"existing":[]}"#),
        "chunk" => {
            let delay = if request.session() == Some("session-1") {
                Duration::from_millis(900)
            } else {
                Duration::ZERO
            };
            MockResponse::json(201, r#"{"ok":true}"#).delayed(delay)
        }
        "manifest" => MockResponse::json(201, r#"{"ok":true}"#),
        "upload-create" => MockResponse::json(
            201,
            r#"{"object_key":"artifacts/kernel","upload_id":"upload-1","already_exists":false}"#,
        ),
        "upload-part" => MockResponse::json(200, r#"{"part_number":1,"etag":"etag-1"}"#),
        "upload-complete" => MockResponse::json(200, r#"{"ok":true,"bytes":12}"#),
        "publish" => MockResponse::json(201, PUBLISH_RECEIPT),
        "complete" => MockResponse::json(200, r#"{"ok":true,"state":"completed"}"#),
        other => MockResponse::json(400, format!(r#"{{"error":"unexpected {other}"}}"#)),
    });
    let uploader = registry.uploader();

    let receipt = uploader
        .publish_manifest_with_artifacts(&fixture.manifest, &[fixture.image], &fixture.artifacts)
        .unwrap();
    assert!(receipt.ok, "the replacement session must carry the publish");

    assert_eq!(
        registry.markers(),
        vec![
            "open",
            "exists",
            "chunk",
            "heartbeat",
            "complete",
            "open",
            "exists",
            "chunk",
            "manifest",
            "upload-create",
            "upload-part",
            "upload-complete",
            "publish",
            "complete",
        ]
    );
    // The replacement session probes the chunks again before it writes.
    assert_eq!(
        registry.sessions_used("exists"),
        vec!["session-1", "session-2"]
    );
    assert_eq!(registry.sessions_used("manifest"), vec!["session-2"]);
    assert_eq!(registry.sessions_used("publish"), vec!["session-2"]);
    assert_eq!(registry.outcomes(), vec!["abandoned", "published"]);
}

#[test]
fn restarts_when_a_write_reports_the_session_is_gone() {
    let fixture = publish_fixture();
    let opens = Arc::new(AtomicU32::new(0));
    let counted = Arc::clone(&opens);
    let registry = MockRegistry::start(move |request| match request.marker() {
        "open" => {
            let attempt = counted.fetch_add(1, Ordering::SeqCst);
            MockResponse::json(
                201,
                if attempt == 0 {
                    QUIET_SESSION
                } else {
                    SECOND_SESSION
                },
            )
        }
        "heartbeat" => MockResponse::json(200, r#"{"ok":true}"#),
        "exists" => MockResponse::json(200, r#"{"existing":[]}"#),
        // A reaped session is closed for writing, so the upload restarts.
        "chunk" if request.session() == Some("session-1") => {
            MockResponse::json(409, SESSION_CLOSED)
        }
        "chunk" => MockResponse::json(201, r#"{"ok":true}"#),
        "manifest" => MockResponse::json(201, r#"{"ok":true}"#),
        "upload-create" => MockResponse::json(
            201,
            r#"{"object_key":"artifacts/kernel","upload_id":"upload-1","already_exists":false}"#,
        ),
        "upload-part" => MockResponse::json(200, r#"{"part_number":1,"etag":"etag-1"}"#),
        "upload-complete" => MockResponse::json(200, r#"{"ok":true,"bytes":12}"#),
        "publish" => MockResponse::json(201, PUBLISH_RECEIPT),
        "complete" => MockResponse::json(200, r#"{"ok":true,"state":"completed"}"#),
        other => MockResponse::json(400, format!(r#"{{"error":"unexpected {other}"}}"#)),
    });
    let uploader = registry.uploader();

    uploader
        .publish_manifest_with_artifacts(&fixture.manifest, &[fixture.image], &fixture.artifacts)
        .unwrap();

    assert_eq!(registry.open_count(), 2);
    assert_eq!(registry.sessions_used("publish"), vec!["session-2"]);
    assert_eq!(registry.outcomes(), vec!["abandoned", "published"]);
}

#[test]
fn gives_up_after_the_restart_budget() {
    let fixture = publish_fixture();
    let registry = MockRegistry::start(|request| match request.marker() {
        "open" => MockResponse::json(201, OPENED_SESSION),
        "heartbeat" => MockResponse::json(409, SESSION_SUPERSEDED),
        "exists" => MockResponse::json(200, r#"{"existing":[]}"#),
        "chunk" => MockResponse::json(201, r#"{"ok":true}"#).delayed(Duration::from_millis(900)),
        "complete" => MockResponse::json(200, r#"{"ok":true}"#),
        other => MockResponse::json(400, format!(r#"{{"error":"unexpected {other}"}}"#)),
    });
    let uploader = registry.uploader();

    let error = uploader
        .publish_manifest_with_artifacts(&fixture.manifest, &[fixture.image], &fixture.artifacts)
        .unwrap_err();

    // One attempt plus two restarts, then the upload reports the failure
    // instead of replacing the session forever.
    assert_eq!(registry.open_count(), 3);
    assert!(!registry.markers().contains(&"publish"));
    assert!(
        error.to_string().contains("session"),
        "the failure must name the lost session, got {error}"
    );
}

#[test]
fn refuses_to_continue_when_a_write_rejects_the_session() {
    let fixture = publish_fixture();
    let registry = MockRegistry::start(|request| match request.marker() {
        "open" => MockResponse::json(201, QUIET_SESSION),
        "exists" => MockResponse::json(200, r#"{"existing":[]}"#),
        "chunk" => MockResponse::json(410, r#"{"error":"unknown upload session"}"#),
        "complete" => MockResponse::json(200, r#"{"ok":true}"#),
        other => MockResponse::json(400, format!(r#"{{"error":"unexpected {other}"}}"#)),
    });
    let uploader = registry.uploader();

    let error = uploader
        .publish_manifest_with_artifacts(&fixture.manifest, &[fixture.image], &fixture.artifacts)
        .unwrap_err();

    assert!(
        matches!(
            error,
            Error::HttpStatus {
                status: reqwest::StatusCode::GONE,
                ..
            }
        ),
        "a rejected session must surface as the registry response, got {error}"
    );
    let markers = registry.markers();
    assert!(!markers.contains(&"manifest"));
    assert!(!markers.contains(&"publish"));
    assert_eq!(registry.outcome(), "abandoned");
}

#[test]
fn retries_registration_while_cleanup_holds_the_registry() {
    let attempts = Arc::new(AtomicU32::new(0));
    let counted = Arc::clone(&attempts);
    let registry = MockRegistry::start(move |request| match request.marker() {
        "open" => {
            if counted.fetch_add(1, Ordering::SeqCst) == 0 {
                MockResponse::json(409, SWEEP_IN_PROGRESS).with_header("retry-after", "1")
            } else {
                MockResponse::json(201, QUIET_SESSION)
            }
        }
        "exists" => MockResponse::json(200, r#"{"existing":[]}"#),
        "complete" => MockResponse::json(200, r#"{"ok":true}"#),
        other => MockResponse::json(400, format!(r#"{{"error":"unexpected {other}"}}"#)),
    });
    let uploader = registry.uploader();

    let session = uploader.start_session("image_chunk_lookup").unwrap();
    let existing = uploader
        .find_existing_image_chunks_in_session(
            &[ImageChunkLookup {
                raw_sha256: "c".repeat(64),
                raw_size_bytes: 4096,
            }],
            &session,
        )
        .unwrap();
    session.complete(crate::UploadOutcome::Published).unwrap();

    assert!(existing.is_empty());
    assert_eq!(attempts.load(Ordering::SeqCst), 2);
    assert_eq!(
        registry.markers(),
        vec!["open", "open", "exists", "complete"],
        "the client must retry the refused registration"
    );
    assert_eq!(registry.outcome(), "published");
}

#[test]
fn a_chunk_lookup_runs_inside_the_callers_session() {
    let registry = MockRegistry::start(|request| match request.marker() {
        "open" => MockResponse::json(201, QUIET_SESSION),
        "exists" => MockResponse::json(200, r#"{"existing":[]}"#),
        "complete" => MockResponse::json(200, r#"{"ok":true}"#),
        other => MockResponse::json(400, format!(r#"{{"error":"unexpected {other}"}}"#)),
    });
    let uploader = registry.uploader();

    let session = uploader.start_session("image_chunk_lookup").unwrap();
    assert!(
        uploader
            .find_existing_image_chunks_in_session(
                &[ImageChunkLookup {
                    raw_sha256: "d".repeat(64),
                    raw_size_bytes: 4096,
                }],
                &session,
            )
            .unwrap()
            .is_empty()
    );
    session.complete(crate::UploadOutcome::Published).unwrap();

    assert_eq!(registry.markers(), vec!["open", "exists", "complete"]);
    assert_eq!(registry.sessions_used("exists"), vec!["session-1"]);
    assert_eq!(registry.open_count(), 1);
}

/// A builder probes reusable chunks while it prepares, then publishes much
/// later. One session must cover both, or a cleanup that runs in the gap
/// deletes the chunks the publish planned to reuse. The mock reports the chunk
/// as stored only to the first session, which is exactly that cleanup.
#[test]
fn keeps_probed_chunks_protected_across_the_prepare_publish_gap() {
    let fixture = publish_fixture();
    let descriptor = fixture.image.chunks[0].clone();
    let (raw_sha256, raw_size_bytes) = (descriptor.raw_sha256.clone(), descriptor.raw_size_bytes);
    let existing = format!(
        r#"{{"existing":[{{"raw_sha256":"{}","raw_size_bytes":{},"encoded_sha256":"{}","encoded_size_bytes":{}}}]}}"#,
        descriptor.raw_sha256,
        descriptor.raw_size_bytes,
        descriptor.encoded_sha256,
        descriptor.encoded_size_bytes,
    );
    let opens = Arc::new(AtomicU32::new(0));
    let counted = Arc::clone(&opens);
    let registry = MockRegistry::start(move |request| match request.marker() {
        "open" => MockResponse::json(
            201,
            if counted.fetch_add(1, Ordering::SeqCst) == 0 {
                QUIET_SESSION
            } else {
                SECOND_SESSION
            },
        ),
        // Only the session that probed the chunk still sees it: any other
        // session arrives after a cleanup deleted it.
        "exists" => MockResponse::json(
            200,
            if request.session() == Some("session-1") {
                existing.clone()
            } else {
                r#"{"existing":[]}"#.to_owned()
            },
        ),
        "chunk" => MockResponse::json(400, r#"{"error":"no local payload left"}"#),
        "manifest" => MockResponse::json(201, r#"{"ok":true}"#),
        "upload-create" => MockResponse::json(
            201,
            r#"{"object_key":"artifacts/kernel","upload_id":"upload-1","already_exists":false}"#,
        ),
        "upload-part" => MockResponse::json(200, r#"{"part_number":1,"etag":"etag-1"}"#),
        "upload-complete" => MockResponse::json(200, r#"{"ok":true,"bytes":12}"#),
        "publish" => MockResponse::json(201, PUBLISH_RECEIPT),
        "complete" => MockResponse::json(200, r#"{"ok":true,"state":"completed"}"#),
        other => MockResponse::json(400, format!(r#"{{"error":"unexpected {other}"}}"#)),
    });
    let uploader = registry.uploader();

    // Preparation: probe the reusable chunks under one session.
    let session = uploader.start_session("image_prepare").unwrap();
    let reused = uploader
        .find_existing_image_chunks_in_session(
            &[ImageChunkLookup {
                raw_sha256: raw_sha256.clone(),
                raw_size_bytes,
            }],
            &session,
        )
        .unwrap();
    assert_eq!(reused.len(), 1);

    // The publish reuses the probed chunk, so it has no local payload to fall
    // back on: only the shared session keeps that chunk out of a cleanup.
    let reused_image = PublishChunkedImage::new(
        &fixture.image.vm_name,
        &fixture.image.image_id,
        &fixture.image.chunk_manifest_sha256,
        &fixture.image.chunk_manifest_path,
        vec![reused_chunk(&fixture.image.chunks[0])],
    )
    .unwrap();
    let receipt = uploader
        .publish_build_manifest_with_session(
            &fixture.manifest,
            &[reused_image],
            &fixture.artifacts,
            &fixture_identity(),
            &session,
        )
        .unwrap();
    assert!(receipt.ok);
    session.complete(crate::UploadOutcome::Published).unwrap();

    // The chunk was never uploaded, because the probe under the same session
    // proved the registry still stores it.
    let markers = registry.markers();
    assert!(!markers.contains(&"chunk"), "{markers:?}");
    // The preparation probe and the publish's own probe, one session.
    assert_eq!(
        registry.sessions_used("exists"),
        vec!["session-1", "session-1"]
    );
    assert_eq!(registry.sessions_used("publish"), vec!["session-1"]);
    assert_eq!(registry.open_count(), 1);
    assert_eq!(registry.outcomes(), vec!["published"]);
}

/// The negative control for the test above: a publish that arrives on a later
/// session finds the probed chunk deleted, and fails instead of publishing an
/// image whose chunks are missing.
#[test]
fn a_later_session_cannot_reuse_chunks_probed_by_an_earlier_one() {
    let fixture = publish_fixture();
    let descriptor = fixture.image.chunks[0].clone();
    let existing = format!(
        r#"{{"existing":[{{"raw_sha256":"{}","raw_size_bytes":{},"encoded_sha256":"{}","encoded_size_bytes":{}}}]}}"#,
        descriptor.raw_sha256,
        descriptor.raw_size_bytes,
        descriptor.encoded_sha256,
        descriptor.encoded_size_bytes,
    );
    let opens = Arc::new(AtomicU32::new(0));
    let counted = Arc::clone(&opens);
    let registry = MockRegistry::start(move |request| match request.marker() {
        "open" => MockResponse::json(
            201,
            if counted.fetch_add(1, Ordering::SeqCst) == 0 {
                QUIET_SESSION
            } else {
                SECOND_SESSION
            },
        ),
        "exists" => MockResponse::json(
            200,
            if request.session() == Some("session-1") {
                existing.clone()
            } else {
                r#"{"existing":[]}"#.to_owned()
            },
        ),
        "upload-create" => MockResponse::json(
            201,
            r#"{"object_key":"artifacts/kernel","upload_id":"upload-1","already_exists":true}"#,
        ),
        "complete" => MockResponse::json(200, r#"{"ok":true}"#),
        other => MockResponse::json(400, format!(r#"{{"error":"unexpected {other}"}}"#)),
    });
    let uploader = registry.uploader();

    let session = uploader.start_session("image_prepare").unwrap();
    assert_eq!(
        uploader
            .find_existing_image_chunks_in_session(
                &[ImageChunkLookup {
                    raw_sha256: descriptor.raw_sha256.clone(),
                    raw_size_bytes: descriptor.raw_size_bytes,
                }],
                &session,
            )
            .unwrap()
            .len(),
        1
    );
    session.complete(crate::UploadOutcome::Published).unwrap();

    // A later publish opens its own session, so the reuse decision no longer
    // holds and the publish reports it instead of writing an incomplete image.
    let late = uploader.start_session("image_publish").unwrap();
    let reused_image = PublishChunkedImage::new(
        &fixture.image.vm_name,
        &fixture.image.image_id,
        &fixture.image.chunk_manifest_sha256,
        &fixture.image.chunk_manifest_path,
        vec![reused_chunk(&descriptor)],
    )
    .unwrap();
    let error = uploader
        .publish_build_manifest_with_session(
            &fixture.manifest,
            &[reused_image],
            &fixture.artifacts,
            &fixture_identity(),
            &late,
        )
        .unwrap_err();
    late.complete(crate::UploadOutcome::Abandoned).unwrap();

    assert!(
        matches!(
            error,
            Error::MissingImageChunkPayload { ref raw_sha256 }
                if raw_sha256 == &descriptor.raw_sha256
        ),
        "the publish must name the reusable chunk it cannot recover, got {error}"
    );
}

#[test]
fn reports_a_session_that_cannot_be_completed_after_a_publish() {
    let fixture = publish_fixture();
    let registry = MockRegistry::start(|request| match request.marker() {
        "open" => MockResponse::json(201, QUIET_SESSION),
        "exists" => MockResponse::json(200, r#"{"existing":[]}"#),
        "chunk" => MockResponse::json(201, r#"{"ok":true}"#),
        "manifest" => MockResponse::json(201, r#"{"ok":true}"#),
        "upload-create" => MockResponse::json(
            201,
            r#"{"object_key":"artifacts/kernel","upload_id":"upload-1","already_exists":false}"#,
        ),
        "upload-part" => MockResponse::json(200, r#"{"part_number":1,"etag":"etag-1"}"#),
        "upload-complete" => MockResponse::json(200, r#"{"ok":true,"bytes":12}"#),
        "publish" => MockResponse::json(201, PUBLISH_RECEIPT),
        "complete" => MockResponse::json(500, r#"{"error":"session store unavailable"}"#),
        other => MockResponse::json(400, format!(r#"{{"error":"unexpected {other}"}}"#)),
    });
    let uploader = registry.uploader();

    let error = uploader
        .publish_manifest_with_artifacts(&fixture.manifest, &[fixture.image], &fixture.artifacts)
        .unwrap_err();

    let Error::SessionBroken { detail, .. } = &error else {
        panic!("a stored publish with an open session must be reported, got {error}");
    };
    assert!(
        detail.contains("did not complete"),
        "the error must name the unfinished session: {detail}"
    );
}

#[test]
fn keeps_the_upload_error_when_the_session_cannot_be_completed() {
    let fixture = publish_fixture();
    let registry = MockRegistry::start(|request| match request.marker() {
        "open" => MockResponse::json(201, QUIET_SESSION),
        "exists" => MockResponse::json(200, r#"{"existing":[]}"#),
        "chunk" => MockResponse::json(410, r#"{"error":"unknown upload session"}"#),
        "complete" => MockResponse::json(500, r#"{"error":"session store unavailable"}"#),
        other => MockResponse::json(400, format!(r#"{{"error":"unexpected {other}"}}"#)),
    });
    let uploader = registry.uploader();

    let error = uploader
        .publish_manifest_with_artifacts(&fixture.manifest, &[fixture.image], &fixture.artifacts)
        .unwrap_err();

    let Error::SessionBroken { cause, .. } = &error else {
        panic!("a failed completion must report the session, got {error}");
    };
    let cause = cause.as_deref().expect("the upload error is kept");
    assert!(
        matches!(
            cause,
            Error::HttpStatus {
                status: reqwest::StatusCode::GONE,
                ..
            }
        ),
        "the upload error must survive a failed completion, got {cause}"
    );
}
