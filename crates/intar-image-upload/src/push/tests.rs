#![allow(clippy::unwrap_used)]

use std::collections::HashMap;
use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::net::TcpListener;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use intar_contracts::oci::{OCI_MANIFEST_MEDIA_TYPE, OciDescriptorV1, OciDigest, OciManifestV1};
use sha2::{Digest as _, Sha256};

use super::{Error, RegistryPusher};

#[derive(Clone, Debug)]
struct Request {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

type Answer = Box<dyn Fn(&Request, usize) -> (u16, String) + Send + Sync>;

/// A registry on a local port: it records every request and answers the
/// session routes itself; `answer` decides the rest, given how often the
/// same method and path came before.
struct FakeRegistry {
    url: String,
    requests: Arc<Mutex<Vec<Request>>>,
}

impl FakeRegistry {
    fn start(answer: impl Fn(&Request, usize) -> (u16, String) + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::<Request>::new()));
        let answer: Arc<Answer> = Arc::new(Box::new(answer));
        let recorded = Arc::clone(&requests);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let recorded = Arc::clone(&recorded);
                let answer = Arc::clone(&answer);
                std::thread::spawn(move || {
                    let Some(request) = read_request(&mut stream) else {
                        return;
                    };
                    let seen = {
                        let mut all = recorded.lock().unwrap();
                        let seen = all
                            .iter()
                            .filter(|old| old.method == request.method && old.path == request.path)
                            .count();
                        all.push(request.clone());
                        seen
                    };
                    let (status, body) = if request.path.contains("/upload-sessions") {
                        (
                            200,
                            r#"{"session_id":"s-1","heartbeat_interval_ms":60000,"protocol":{"version":1}}"#
                                .to_owned(),
                        )
                    } else {
                        answer(&request, seen)
                    };
                    let response = format!(
                        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        if request.method == "HEAD" {
                            0
                        } else {
                            body.len()
                        }
                    );
                    let _ = stream.write_all(response.as_bytes());
                });
            }
        });
        Self { url, requests }
    }

    /// The requests that are no session call, in arrival order.
    fn calls(&self) -> Vec<Request> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| !request.path.contains("/upload-sessions"))
            .cloned()
            .collect()
    }

    fn pusher(&self) -> RegistryPusher {
        RegistryPusher::new(&self.url, "token")
            .unwrap()
            .with_backoff(Duration::from_millis(1))
    }
}

fn read_request(stream: &mut std::net::TcpStream) -> Option<Request> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_owned();
    let path = parts.next()?.to_owned();
    let mut headers = HashMap::new();
    loop {
        let mut header = String::new();
        reader.read_line(&mut header).ok()?;
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        let (name, value) = header.split_once(':')?;
        headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_owned());
    }
    let length = headers
        .get("content-length")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let mut body = vec![0; length];
    reader.read_exact(&mut body).ok()?;
    Some(Request {
        method,
        path,
        headers,
        body,
    })
}

fn digest_of(bytes: &[u8]) -> OciDigest {
    OciDigest::from_sha256(&Sha256::digest(bytes).into())
}

/// An image of a config and two layers in `dir`, and its manifest digest.
fn image(dir: &Path) -> (OciDigest, Vec<(OciDigest, Vec<u8>)>) {
    let blobs = dir.join("sha256");
    std::fs::create_dir_all(&blobs).unwrap();
    let mut written = Vec::new();
    let mut descriptor = |bytes: Vec<u8>| {
        let digest = digest_of(&bytes);
        std::fs::write(blobs.join(digest.hex()), &bytes).unwrap();
        let size = bytes.len() as u64;
        written.push((digest.clone(), bytes));
        OciDescriptorV1 {
            media_type: "application/octet-stream".to_owned(),
            digest,
            size,
        }
    };
    let config = descriptor(b"{\"config\":1}".to_vec());
    let layers = vec![descriptor(vec![1; 70_000]), descriptor(vec![2; 3])];
    let manifest = serde_json::to_vec(&OciManifestV1 {
        schema_version: 2,
        media_type: OCI_MANIFEST_MEDIA_TYPE.to_owned(),
        artifact_type: "application/vnd.intar.machine.v1".to_owned(),
        config,
        layers,
    })
    .unwrap();
    let digest = digest_of(&manifest);
    std::fs::write(blobs.join(digest.hex()), &manifest).unwrap();
    (digest, written)
}

/// HEAD answers 404, so every blob is put; everything else succeeds.
fn missing(request: &Request, _seen: usize) -> (u16, String) {
    match request.method.as_str() {
        "HEAD" => (404, String::new()),
        _ => (201, "{}".to_owned()),
    }
}

#[test]
fn a_blob_the_registry_has_is_not_put() {
    let registry = FakeRegistry::start(|request, _| match request.method.as_str() {
        "HEAD" => (200, String::new()),
        _ => (201, "{}".to_owned()),
    });
    let dir = tempfile::tempdir().unwrap();
    let (manifest, blobs) = image(dir.path());
    registry
        .pusher()
        .push_build(dir.path(), &manifest, "build-1")
        .unwrap();

    let calls = registry.calls();
    let heads = calls.iter().filter(|call| call.method == "HEAD").count();
    assert_eq!(heads, blobs.len());
    assert!(
        !calls
            .iter()
            .any(|call| call.method == "PUT" && call.path.contains("/blobs/")),
        "{calls:?}"
    );
    for call in &calls {
        assert_eq!(call.headers["x-intar-registry-session"], "s-1");
        assert_eq!(call.headers["authorization"], "Bearer token");
    }
}

#[test]
fn a_missing_blob_is_put_with_its_bytes_under_its_digest() {
    let registry = FakeRegistry::start(missing);
    let dir = tempfile::tempdir().unwrap();
    let (manifest, blobs) = image(dir.path());
    registry
        .pusher()
        .push_build(dir.path(), &manifest, "build-1")
        .unwrap();

    let calls = registry.calls();
    for (digest, bytes) in &blobs {
        let put = calls
            .iter()
            .find(|call| {
                call.method == "PUT"
                    && call.path == format!("/registry/v1/blobs/{}", digest.as_str())
            })
            .unwrap();
        assert_eq!(&put.body, bytes);
        assert_eq!(&digest_of(&put.body), digest);
        assert_eq!(put.headers["content-type"], "application/octet-stream");
    }
}

#[test]
fn the_manifest_follows_every_blob_and_the_result_names_it() {
    let registry = FakeRegistry::start(missing);
    let dir = tempfile::tempdir().unwrap();
    let (manifest, _) = image(dir.path());
    registry
        .pusher()
        .push_build(dir.path(), &manifest, "build-7")
        .unwrap();

    let calls = registry.calls();
    let manifest_at = calls
        .iter()
        .position(|call| {
            call.method == "PUT"
                && call.path == format!("/registry/v1/manifests/{}", manifest.as_str())
        })
        .unwrap();
    let last_blob = calls
        .iter()
        .rposition(|call| call.path.contains("/blobs/"))
        .unwrap();
    assert!(last_blob < manifest_at, "{calls:?}");
    assert_eq!(
        calls[manifest_at].headers["content-type"],
        OCI_MANIFEST_MEDIA_TYPE
    );
    assert_eq!(
        calls[manifest_at].body,
        std::fs::read(dir.path().join("sha256").join(manifest.hex())).unwrap()
    );

    let result = calls.last().unwrap();
    assert_eq!(result.method, "POST");
    assert_eq!(result.path, "/registry/v1/builds/build-7/result");
    let body: serde_json::Value = serde_json::from_slice(&result.body).unwrap();
    assert_eq!(
        body,
        serde_json::json!({ "image_digest": manifest.as_str() })
    );
}

#[test]
fn a_conflict_fails_the_push_before_the_manifest() {
    let registry = FakeRegistry::start(|request, _| match request.method.as_str() {
        "HEAD" => (404, String::new()),
        "PUT" if request.path.contains("/blobs/") => (409, r#"{"code":"conflict"}"#.to_owned()),
        _ => (201, "{}".to_owned()),
    });
    let dir = tempfile::tempdir().unwrap();
    let (manifest, _) = image(dir.path());
    let error = registry
        .pusher()
        .push_build(dir.path(), &manifest, "build-1")
        .unwrap_err();

    assert!(
        matches!(error, Error::HttpStatus { status, .. } if status.as_u16() == 409),
        "{error}"
    );
    let calls = registry.calls();
    assert!(!calls.iter().any(|call| call.path.contains("/manifests/")));
    assert!(!calls.iter().any(|call| call.path.contains("/builds/")));
    // A conflict is not retried.
    let puts = calls.iter().filter(|call| call.method == "PUT").count();
    assert!(puts <= 3, "{calls:?}");
}

#[test]
fn a_transient_failure_is_retried() {
    let registry = FakeRegistry::start(|request, seen| match request.method.as_str() {
        "HEAD" if seen == 0 => (503, String::new()),
        "HEAD" => (404, String::new()),
        "PUT" if seen == 0 => (502, String::new()),
        "POST" if seen == 0 => (429, String::new()),
        _ => (201, "{}".to_owned()),
    });
    let dir = tempfile::tempdir().unwrap();
    let (manifest, blobs) = image(dir.path());
    registry
        .pusher()
        .push_build(dir.path(), &manifest, "build-1")
        .unwrap();

    let calls = registry.calls();
    for (digest, _) in &blobs {
        let path = format!("/registry/v1/blobs/{}", digest.as_str());
        let count = |method: &str| {
            calls
                .iter()
                .filter(|call| call.method == method && call.path == path)
                .count()
        };
        assert_eq!((count("HEAD"), count("PUT")), (2, 2), "{path}");
    }
    let posts = calls.iter().filter(|call| call.method == "POST").count();
    assert_eq!(posts, 2);
}

#[test]
fn a_refused_token_is_not_retried() {
    let registry = FakeRegistry::start(|_, _| (401, String::new()));
    let dir = tempfile::tempdir().unwrap();
    let (manifest, _) = image(dir.path());
    registry
        .pusher()
        .push_build(dir.path(), &manifest, "build-1")
        .unwrap_err();
    // Each blob's HEAD may have left before the first refusal; none again.
    let calls = registry.calls();
    for call in &calls {
        let same = calls.iter().filter(|other| other.path == call.path).count();
        assert_eq!(same, 1, "{calls:?}");
    }
}

#[test]
fn the_registry_url_must_be_http() {
    assert!(RegistryPusher::new("ssh://example", "token").is_err());
    assert!(RegistryPusher::new("https://intar.dev", " ").is_err());
}
