#![allow(clippy::unwrap_used)]

use std::collections::HashMap;
use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::net::TcpListener;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use intar_contracts::oci::{
    Architecture, OCI_MANIFEST_MEDIA_TYPE, OciDescriptorV1, OciDigest, OciManifestV1,
};
use sha2::{Digest as _, Sha256};

use super::{Error, RecordedImage, RegistryPusher};
use crate::PipelineSession;

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
        .push_build(dir.path(), &manifest, "build-1", 1, Architecture::Amd64)
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
        .push_build(dir.path(), &manifest, "build-1", 1, Architecture::Amd64)
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
        .push_build(dir.path(), &manifest, "build-7", 3, Architecture::Amd64)
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
    assert_eq!(result.path, "/registry/v1/builds/build-7/result?attempt=3");
    let body: serde_json::Value = serde_json::from_slice(&result.body).unwrap();
    assert_eq!(
        body,
        serde_json::json!({ "image_digest": manifest.as_str() })
    );

    // The arm64 image of the same attempt is recorded as that.
    registry
        .pusher()
        .push_build(dir.path(), &manifest, "build-7", 3, Architecture::Arm64)
        .unwrap();
    assert_eq!(
        registry.calls().last().unwrap().path,
        "/registry/v1/builds/build-7/result?attempt=3&arch=arm64"
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
        .push_build(dir.path(), &manifest, "build-1", 1, Architecture::Amd64)
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
fn a_paused_registry_is_waited_out_with_a_fresh_session() {
    // A website deploy holds the registry: the blob check, a HEAD, is refused
    // with a 409 that carries no body, and a write with one that names why.
    // Blobs are pushed side by side and a refusal stops the others, so only
    // the first blob's check is refused: every pass makes that one.
    let dir = tempfile::tempdir().unwrap();
    let (manifest, blobs) = image(dir.path());
    let first_blob = format!("/registry/v1/blobs/{}", blobs[0].0.as_str());
    let refused = first_blob.clone();
    let registry = FakeRegistry::start(move |request, seen| match request.method.as_str() {
        "HEAD" if request.path == refused && seen < 2 => (409, String::new()),
        "HEAD" => (404, String::new()),
        "PUT" if request.path.contains("/manifests/") && seen == 0 => (
            409,
            r#"{"error":"registry sweep is in progress","code":"registry_sweep_in_progress"}"#
                .to_owned(),
        ),
        _ => (201, "{}".to_owned()),
    });
    registry
        .pusher()
        .push_build(dir.path(), &manifest, "build-1", 1, Architecture::Amd64)
        .unwrap();

    let calls = registry.calls();
    // The push started over three times: twice at the refused blob check
    // and once at the refused manifest, each time from the first blob.
    let heads = calls
        .iter()
        .filter(|call| call.method == "HEAD" && call.path == first_blob)
        .count();
    assert_eq!(heads, 4, "{first_blob}");
    assert!(
        calls
            .iter()
            .any(|call| call.path.contains("/builds/build-1/result"))
    );
}

#[test]
fn a_registry_that_stays_paused_fails_the_push_in_the_end() {
    let registry = FakeRegistry::start(|request, _| match request.method.as_str() {
        "HEAD" => (409, String::new()),
        _ => (201, "{}".to_owned()),
    });
    let dir = tempfile::tempdir().unwrap();
    let (manifest, _) = image(dir.path());
    let error = registry
        .pusher()
        .push_build(dir.path(), &manifest, "build-1", 1, Architecture::Amd64)
        .unwrap_err();
    assert!(
        matches!(error, Error::HttpStatus { status, .. } if status.as_u16() == 409),
        "{error}"
    );
    assert!(!registry.calls().iter().any(|call| call.method == "PUT"));
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
        .push_build(dir.path(), &manifest, "build-1", 1, Architecture::Amd64)
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
        .push_build(dir.path(), &manifest, "build-1", 1, Architecture::Amd64)
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

/// Refuses the result POST with `body`; everything else succeeds.
fn result_refused(body: String) -> FakeRegistry {
    FakeRegistry::start(move |request, _| match request.method.as_str() {
        "HEAD" => (200, String::new()),
        "POST" => (409, body.clone()),
        _ => (201, "{}".to_owned()),
    })
}

#[test]
fn a_result_the_attempt_recorded_before_ends_the_push_with_that_image() {
    // The builder restarted and built the image again: the registry keeps
    // the one this attempt recorded and names it.
    let recorded = digest_of(b"the image of the first run");
    let registry = result_refused(format!(
        r#"{{"error":"this attempt already recorded another image","code":"build_result_recorded","image_digest":"{}"}}"#,
        recorded.as_str()
    ));
    let dir = tempfile::tempdir().unwrap();
    let (manifest, _) = image(dir.path());
    assert_ne!(manifest, recorded);
    for architecture in [Architecture::Amd64, Architecture::Arm64] {
        let pushed = registry
            .pusher()
            .push_build(dir.path(), &manifest, "build-1", 1, architecture)
            .unwrap();
        assert_eq!(pushed, recorded);
    }
    // The refusal is an answer: the result is not posted again.
    let posts = registry
        .calls()
        .iter()
        .filter(|call| call.method == "POST")
        .count();
    assert_eq!(posts, 2);

    // A push that records its own image answers that one.
    let pushed = FakeRegistry::start(missing)
        .pusher()
        .push_build(dir.path(), &manifest, "build-1", 1, Architecture::Amd64)
        .unwrap();
    assert_eq!(pushed, manifest);
}

#[test]
fn any_other_refused_result_fails_the_push() {
    let dir = tempfile::tempdir().unwrap();
    let (manifest, _) = image(dir.path());
    for body in [
        // A registry from before the refusal named the image.
        r#"{"error":"this attempt already recorded another image","code":"build_result_recorded"}"#,
        r#"{"code":"build_result_recorded","image_digest":"sha256:nope"}"#,
        r#"{"code":"build_superseded","image_digest":"sha256:0000000000000000000000000000000000000000000000000000000000000000"}"#,
        "not json",
    ] {
        let error = result_refused(body.to_owned())
            .pusher()
            .push_build(dir.path(), &manifest, "build-1", 1, Architecture::Amd64)
            .unwrap_err();
        assert!(
            matches!(error, Error::HttpStatus { status, .. } if status.as_u16() == 409),
            "{body}: {error}"
        );
    }
}

#[test]
fn the_recorded_image_of_an_attempt_is_read_without_a_session() {
    let recorded = digest_of(b"the image of the first run");
    let answer = format!(
        r#"{{"image_digest":"{}","arm64_image_digest":null}}"#,
        recorded.as_str()
    );
    let registry = FakeRegistry::start(move |_, _| (200, answer.clone()));
    assert_eq!(
        registry.pusher().recorded_image("build-7", 3).unwrap(),
        Some(recorded)
    );
    let requests = registry.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 1, "{requests:?}");
    assert_eq!(requests[0].method, "GET");
    assert_eq!(
        requests[0].path,
        "/registry/v1/builds/build-7/result?attempt=3"
    );
    assert_eq!(requests[0].headers["authorization"], "Bearer token");

    let nothing = FakeRegistry::start(|_, _| {
        (
            200,
            r#"{"image_digest":null,"arm64_image_digest":null}"#.to_owned(),
        )
    });
    assert_eq!(nothing.pusher().recorded_image("build-7", 3).unwrap(), None);
    // A registry from before the route, or one that fences the caller out.
    for status in [405, 409] {
        let refusing = FakeRegistry::start(move |_, _| (status, "{}".to_owned()));
        assert!(refusing.pusher().recorded_image("build-7", 3).is_err());
    }
}

/// Every blob is there; the result answers `status` and `body`.
fn result_answers(status: u16, body: String) -> FakeRegistry {
    FakeRegistry::start(move |request, _| match request.method.as_str() {
        "POST" => (status, body.clone()),
        _ => (200, "{}".to_owned()),
    })
}

#[test]
fn a_pipelines_result_names_its_architecture_and_no_attempt() {
    let dir = tempfile::tempdir().unwrap();
    let (manifest, _) = image(dir.path());
    let registry = result_answers(
        201,
        serde_json::json!({ "ok": true, "image_digest": manifest.as_str() }).to_string(),
    );
    let key = "b".repeat(64);
    for (architecture, query) in [
        (Architecture::Amd64, "arch=amd64"),
        (Architecture::Arm64, "arch=arm64"),
    ] {
        let recorded = registry
            .pusher()
            .push_image(dir.path(), &manifest, &key, architecture)
            .unwrap();
        assert_eq!(
            recorded,
            RecordedImage {
                image: manifest.clone(),
                first: true
            }
        );
        let calls = registry.calls();
        let result = calls.last().unwrap();
        assert_eq!(
            result.path,
            format!("/registry/v1/builds/{key}/result?{query}")
        );
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&result.body).unwrap(),
            serde_json::json!({ "image_digest": manifest.as_str() })
        );
        // The manifest is always put: the service takes a result only for one
        // pushed in the session.
        assert!(calls.iter().any(|call| call.method == "PUT"
            && call.path == format!("/registry/v1/manifests/{}", manifest.as_str())));
    }
}

#[test]
fn a_key_that_already_has_an_image_ends_the_push_with_that_image() {
    let dir = tempfile::tempdir().unwrap();
    let (manifest, _) = image(dir.path());
    let standing = digest_of(b"the image another run recorded first");
    let registry = result_answers(
        200,
        serde_json::json!({ "ok": true, "image_digest": standing.as_str(), "recorded": true })
            .to_string(),
    );
    let recorded = registry
        .pusher()
        .push_image(dir.path(), &manifest, &"b".repeat(64), Architecture::Amd64)
        .unwrap();
    assert_eq!(
        recorded,
        RecordedImage {
            image: standing,
            first: false
        }
    );
}

#[test]
fn a_write_whose_lease_ran_out_is_sent_again() {
    let dir = tempfile::tempdir().unwrap();
    let (manifest, _) = image(dir.path());
    let answer = serde_json::json!({ "ok": true, "image_digest": manifest.as_str() }).to_string();
    let registry = FakeRegistry::start(move |request, seen| {
        match (request.method.as_str(), seen) {
            // The manifest and the result each find their lease run out once.
            ("PUT" | "POST", 0) if !request.path.contains("/blobs/") => (
                409,
                r#"{"error":"push again","code":"registry_writer_expired"}"#.to_owned(),
            ),
            ("POST", _) => (201, answer.clone()),
            _ => (200, "{}".to_owned()),
        }
    });
    registry
        .pusher()
        .push_image(dir.path(), &manifest, &"b".repeat(64), Architecture::Amd64)
        .unwrap();
    let calls = registry.calls();
    let count = |method: &str, part: &str| {
        calls
            .iter()
            .filter(|call| call.method == method && call.path.contains(part))
            .count()
    };
    assert_eq!(count("PUT", "/manifests/"), 2, "{calls:?}");
    assert_eq!(count("POST", "/result"), 2, "{calls:?}");
}

#[test]
fn a_key_of_another_commit_fails_the_push() {
    let dir = tempfile::tempdir().unwrap();
    let (manifest, _) = image(dir.path());
    let registry = FakeRegistry::start(|request, _| match request.method.as_str() {
        "PUT" if request.path.contains("/manifests/") => (
            403,
            r#"{"error":"no","code":"build_key_not_in_bundle"}"#.to_owned(),
        ),
        _ => (200, "{}".to_owned()),
    });
    let error = registry
        .pusher()
        .push_image(dir.path(), &manifest, &"b".repeat(64), Architecture::Amd64)
        .unwrap_err();
    assert!(
        matches!(&error, Error::HttpStatus { status, .. } if status.as_u16() == 403),
        "{error}"
    );
    assert!(
        !registry
            .calls()
            .iter()
            .any(|call| call.path.contains("/result"))
    );
}

#[test]
fn a_pipeline_session_waits_for_its_bundle_and_closes_with_its_own_token() {
    let registry = FakeRegistry::start(|request, seen| match (request.path.as_str(), seen) {
        ("/registry/v1/pipeline/sessions", 0) => (
            409,
            r#"{"error":"still read","code":"bundle_pending"}"#.to_owned(),
        ),
        ("/registry/v1/pipeline/sessions", _) => (
            201,
            r#"{"ok":true,"token":"ips_secret","expires_at_unix_ms":1,"max_bytes":2}"#.to_owned(),
        ),
        _ => (200, r#"{"ok":true}"#.to_owned()),
    });
    let session =
        PipelineSession::open_with(&registry.url, oidc, "rev-1", Duration::from_millis(1)).unwrap();
    assert_eq!(session.token(), "ips_secret");
    session.close().unwrap();

    let calls = registry.calls();
    assert_eq!(calls.len(), 3, "{calls:?}");
    for open in &calls[..2] {
        assert_eq!(open.method, "POST");
        assert_eq!(open.headers["authorization"], "Bearer oidc");
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&open.body).unwrap(),
            serde_json::json!({ "rev": "rev-1" })
        );
    }
    assert_eq!(calls[2].path, "/registry/v1/pipeline/sessions/close");
    assert_eq!(calls[2].headers["authorization"], "Bearer ips_secret");
}

#[test]
fn a_refused_pipeline_session_is_not_asked_for_again() {
    for (status, code) in [
        (409, "superseded"),
        (401, "unauthorized"),
        (429, "pipeline_session_limit"),
    ] {
        let registry = FakeRegistry::start(move |_, _| {
            (status, format!(r#"{{"error":"no","code":"{code}"}}"#))
        });
        let Err(error) =
            PipelineSession::open_with(&registry.url, oidc, "rev-1", Duration::from_millis(1))
        else {
            panic!("the session must not open");
        };
        assert!(
            matches!(&error, Error::HttpStatus { status: answered, body } if answered.as_u16() == status && body.contains(code)),
            "{error}"
        );
        // A source whose sessions are all taken is the one refusal worth
        // waiting out, as long as a bundle that is still read.
        assert_eq!(
            registry.calls().len(),
            if status == 429 { 40 } else { 1 },
            "{status}"
        );
    }
}

/// The token of a caller that was handed one.
fn oidc() -> std::result::Result<String, String> {
    Ok("oidc".to_owned())
}

#[test]
fn every_try_of_a_session_open_asks_for_a_new_token() {
    let registry = FakeRegistry::start(|request, seen| match (request.path.as_str(), seen) {
        ("/registry/v1/pipeline/sessions", 0 | 1) => (
            409,
            r#"{"error":"still read","code":"bundle_pending"}"#.to_owned(),
        ),
        _ => (201, r#"{"ok":true,"token":"ips_secret"}"#.to_owned()),
    });
    let asked = std::sync::atomic::AtomicUsize::new(0);
    PipelineSession::open_with(
        &registry.url,
        || {
            Ok(format!(
                "t{}",
                asked.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            ))
        },
        "rev-1",
        Duration::from_millis(1),
    )
    .unwrap();
    let tokens: Vec<String> = registry
        .calls()
        .iter()
        .map(|call| call.headers["authorization"].clone())
        .collect();
    assert_eq!(tokens, ["Bearer t0", "Bearer t1", "Bearer t2"]);

    // A source that cannot give one ends the open without asking the service.
    let silent = FakeRegistry::start(|_, _| (500, String::new()));
    let Err(error) = PipelineSession::open_with(
        &silent.url,
        || Err("the runner gave none".to_owned()),
        "rev-1",
        Duration::from_millis(1),
    ) else {
        panic!("the session must not open");
    };
    assert!(matches!(error, Error::Token(_)), "{error}");
    assert!(silent.calls().is_empty());
}

#[test]
fn a_cluster_is_pushed_in_one_session_and_recorded_as_one_set() {
    let dir = tempfile::tempdir().unwrap();
    let (first, _) = image(dir.path());
    // A second image of the same blobs, in another order.
    let blobs = dir.path().join("sha256");
    let mut parsed: OciManifestV1 =
        serde_json::from_slice(&std::fs::read(blobs.join(first.hex())).unwrap()).unwrap();
    parsed.layers.reverse();
    let bytes = serde_json::to_vec(&parsed).unwrap();
    let second = digest_of(&bytes);
    std::fs::write(blobs.join(second.hex()), &bytes).unwrap();
    let keys = [digest_of(b"key one"), digest_of(b"key two")];
    let images: std::collections::BTreeMap<_, _> = [
        (keys[0].clone(), first.clone()),
        (keys[1].clone(), second.clone()),
    ]
    .into();
    let answer = serde_json::json!({
        "ok": true,
        "images": { keys[0].as_str(): first.as_str(), keys[1].as_str(): second.as_str() },
        "recorded": true,
    })
    .to_string();
    let registry = result_answers(200, answer);
    let cluster = "c".repeat(64);
    let recorded = registry
        .pusher()
        .push_cluster(dir.path(), &images, &cluster, Architecture::Arm64)
        .unwrap();
    assert!(!recorded.first);
    assert_eq!(recorded.images, images);
    let calls = registry.calls();
    let puts: Vec<_> = calls
        .iter()
        .filter(|call| call.method == "PUT" && call.path.contains("/manifests/"))
        .map(|call| call.path.clone())
        .collect();
    assert_eq!(puts.len(), 2);
    let result = calls.last().unwrap();
    assert_eq!(
        result.path,
        format!("/registry/v1/clusters/{cluster}/result?arch=arm64")
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&result.body).unwrap(),
        serde_json::json!({ "images": images
            .iter()
            .map(|(key, manifest)| serde_json::json!({
                "build_key": key.as_str(), "image_digest": manifest.as_str(),
            }))
            .collect::<Vec<_>>() })
    );
    let opened = registry
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|request| request.method == "POST" && request.path.ends_with("/upload-sessions"))
        .count();
    assert_eq!(opened, 1);
}
