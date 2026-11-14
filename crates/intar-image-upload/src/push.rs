//! The push of one built machine image to `/registry/v1`, under one
//! admission session:
//!
//! 1. `HEAD /registry/v1/blobs/<digest>` for the config and every layer, and
//!    `PUT` the same URL with the blob's bytes when the HEAD answers 404;
//!    at most [`BLOB_CONCURRENCY`] blobs at a time.
//! 2. `PUT /registry/v1/manifests/<digest>` once every blob is stored.
//! 3. `POST /registry/v1/builds/<build_id>/result?attempt=<n>` with
//!    `{"image_digest"}`; the attempt fences out a superseded one.
//!
//! Every call carries the bearer token and the session header. A transport
//! error, a 429 or a 5xx is retried; a 409 and every other refusal fail the
//! push. A session the registry stops admitting restarts the push from its
//! HEADs.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use intar_contracts::oci::{OCI_MANIFEST_MEDIA_TYPE, OciDigest, OciManifestV1};
use reqwest::Method;
use reqwest::StatusCode;
use reqwest::blocking::{Body, Client, RequestBuilder, Response};

use crate::error::{Error, Result};
use crate::session::{
    BeatFailure, SESSION_COMPLETE_ACTION, SESSION_HEADER, SESSION_HEARTBEAT_ACTION, SESSION_ROUTE,
    SessionHeartbeat, classify_beat_failure, heartbeat_interval, session_code,
};

/// Header that carries the admission session on every registry call.
pub const REGISTRY_SESSION_HEADER: &str = SESSION_HEADER;
/// Blobs in flight at once.
pub const BLOB_CONCURRENCY: usize = 8;
/// What a build's push tells the registry it is for.
const PUSH_INTENT: &str = "image_build";
/// Tries of one registry call before the push fails.
const CALL_ATTEMPTS: u32 = 5;
const BACKOFF_CAP: Duration = Duration::from_secs(5);
/// A sweep in progress refuses new sessions, so opening one retries longer.
const SESSION_OPEN_ATTEMPTS: u32 = 6;
/// A lease that lapses twice is an operator problem, not a third attempt's.
const SESSION_RESTARTS: u32 = 2;
const REGISTRY_ADMISSION_PROTOCOL_VERSION: u32 = 1;
const HEARTBEAT_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const RETRY_AFTER_CAP: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

/// Pushes built images for one bearer token.
pub struct RegistryPusher {
    /// `<base>/registry/v1/`.
    root: url::Url,
    token: String,
    client: Client,
    /// The first retry's wait; later ones grow linearly to [`BACKOFF_CAP`].
    backoff: Duration,
}

impl RegistryPusher {
    /// # Errors
    /// Returns an error when `base_url` is no http(s) URL or the token is
    /// empty.
    pub fn new(base_url: &str, token: &str) -> Result<Self> {
        let root = url::Url::parse(&format!(
            "{}/registry/v1/",
            base_url.trim().trim_end_matches('/')
        ))?;
        if !matches!(root.scheme(), "http" | "https") || root.host_str().is_none() {
            return Err(Error::InvalidConfig("the registry URL must be http(s)"));
        }
        if token.trim().is_empty() {
            return Err(Error::InvalidConfig("the registry token is empty"));
        }
        Ok(Self {
            root,
            token: token.trim().to_owned(),
            client: Client::builder().timeout(REQUEST_TIMEOUT).build()?,
            backoff: Duration::from_millis(500),
        })
    }

    #[cfg(test)]
    pub(crate) fn with_backoff(mut self, backoff: Duration) -> Self {
        self.backoff = backoff;
        self
    }

    /// Push the image `manifest` from `dir` (`sha256/<hex>` blobs) and record
    /// it as the result of `attempt` of `build_id`.
    ///
    /// # Errors
    /// Returns the first call that failed for good.
    pub fn push_build(
        &self,
        dir: &Path,
        manifest: &OciDigest,
        build_id: &str,
        attempt: u32,
    ) -> Result<()> {
        let blobs = dir.join("sha256");
        let manifest_bytes = std::fs::read(blobs.join(manifest.hex()))?;
        let parsed: OciManifestV1 = serde_json::from_slice(&manifest_bytes)?;
        let mut digests = vec![parsed.config.digest];
        for layer in parsed.layers {
            if !digests.contains(&layer.digest) {
                digests.push(layer.digest);
            }
        }
        let result_url = self
            .root
            .join(&format!("builds/{build_id}/result?attempt={attempt}"))?;
        let mut restarts = 0;
        loop {
            let session = self.open_session()?;
            let result = self.push_in(
                &session,
                &blobs,
                &digests,
                manifest,
                &manifest_bytes,
                &result_url,
            );
            let beat = session.heartbeat.stop();
            let lost = matches!(beat, Some(BeatFailure::Superseded))
                || matches!(&result, Err(error) if reports_lost_session(error));
            let finish = session.complete(if result.is_ok() {
                "published"
            } else {
                "abandoned"
            });
            if lost && result.is_err() && restarts < SESSION_RESTARTS {
                restarts += 1;
                continue;
            }
            return settle(session.id, result, beat, finish);
        }
    }

    fn push_in(
        &self,
        session: &Session,
        blobs: &Path,
        digests: &[OciDigest],
        manifest: &OciDigest,
        manifest_bytes: &[u8],
        result_url: &url::Url,
    ) -> Result<()> {
        self.push_blobs(session, blobs, digests)?;
        let url = self
            .root
            .join(&format!("manifests/{}", manifest.as_str()))?;
        self.call(session, || {
            Ok(self
                .client
                .put(url.clone())
                .header(reqwest::header::CONTENT_TYPE, OCI_MANIFEST_MEDIA_TYPE)
                .body(manifest_bytes.to_vec()))
        })?;
        let body = serde_json::json!({ "image_digest": manifest.as_str() });
        self.call(session, || {
            Ok(self.client.post(result_url.clone()).json(&body))
        })?;
        Ok(())
    }

    /// HEAD each blob and PUT the missing ones, [`BLOB_CONCURRENCY`] at a
    /// time; the first failure stops the rest.
    fn push_blobs(&self, session: &Session, blobs: &Path, digests: &[OciDigest]) -> Result<()> {
        let next = AtomicUsize::new(0);
        let failed = AtomicBool::new(false);
        let first_error = Mutex::new(None);
        std::thread::scope(|scope| {
            for _ in 0..BLOB_CONCURRENCY.min(digests.len()) {
                scope.spawn(|| {
                    while !failed.load(Ordering::SeqCst) {
                        let Some(digest) = digests.get(next.fetch_add(1, Ordering::SeqCst)) else {
                            return;
                        };
                        if let Err(error) =
                            self.push_blob(session, &blobs.join(digest.hex()), digest)
                        {
                            failed.store(true, Ordering::SeqCst);
                            first_error
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner)
                                .get_or_insert(error);
                        }
                    }
                });
            }
        });
        match first_error
            .into_inner()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
        {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn push_blob(&self, session: &Session, path: &Path, digest: &OciDigest) -> Result<()> {
        let url = self.root.join(&format!("blobs/{}", digest.as_str()))?;
        let head = self.send(session, || Ok(self.client.head(url.clone())), true)?;
        if head.status().is_success() {
            return Ok(());
        }
        let path: PathBuf = path.to_owned();
        self.call(session, || {
            let file = std::fs::File::open(&path)?;
            let length = file.metadata()?.len();
            Ok(self
                .client
                .request(Method::PUT, url.clone())
                .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
                .body(Body::sized(file, length)))
        })?;
        Ok(())
    }

    /// One call that must succeed.
    fn call(
        &self,
        session: &Session,
        request: impl Fn() -> Result<RequestBuilder>,
    ) -> Result<Response> {
        self.send(session, request, false)
    }

    /// Send with the token and session, retrying what may pass on a retry.
    /// With `head`, a 404 is an answer, not a failure.
    fn send(
        &self,
        session: &Session,
        request: impl Fn() -> Result<RequestBuilder>,
        head: bool,
    ) -> Result<Response> {
        let mut attempt = 1;
        loop {
            session.require_live()?;
            let sent = request()?
                .bearer_auth(&self.token)
                .header(SESSION_HEADER, &session.id)
                .send();
            let wait = match sent {
                Ok(response) if response.status().is_success() => return Ok(response),
                Ok(response) if head && response.status() == StatusCode::NOT_FOUND => {
                    return Ok(response);
                }
                Ok(response) => {
                    let status = response.status();
                    let retry_after = retry_after(response.headers());
                    let body = response.text().unwrap_or_default();
                    let retryable =
                        status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error();
                    if !retryable || attempt >= CALL_ATTEMPTS {
                        return Err(Error::HttpStatus { status, body });
                    }
                    retry_after.unwrap_or_else(|| self.backoff_for(attempt))
                }
                Err(error) if attempt >= CALL_ATTEMPTS || error.is_builder() => {
                    return Err(Error::Http(error));
                }
                Err(_) => self.backoff_for(attempt),
            };
            std::thread::sleep(wait);
            attempt += 1;
        }
    }

    fn backoff_for(&self, attempt: u32) -> Duration {
        (self.backoff * attempt).min(BACKOFF_CAP)
    }

    fn session_url(&self, action: Option<&str>) -> Result<url::Url> {
        let path = match action {
            Some(action) => format!("{SESSION_ROUTE}/{action}"),
            None => SESSION_ROUTE.to_owned(),
        };
        Ok(self.root.join(&path)?)
    }

    fn open_session(&self) -> Result<Session> {
        let url = self.session_url(None)?;
        let body = serde_json::json!({ "intent": PUSH_INTENT });
        let mut attempt = 1;
        loop {
            let response = self
                .client
                .post(url.clone())
                .bearer_auth(&self.token)
                .json(&body)
                .send()?;
            let status = response.status();
            let wait = retry_after(response.headers());
            let text = response.text()?;
            if status.is_success() {
                let opened: SessionOpenResponse = serde_json::from_str(&text)?;
                let id = opened.session_id.trim().to_owned();
                if id.is_empty() {
                    return Err(Error::InvalidConfig(
                        "the registry opened a session without an id",
                    ));
                }
                if opened
                    .protocol
                    .is_some_and(|protocol| protocol.version != REGISTRY_ADMISSION_PROTOCOL_VERSION)
                {
                    return Err(Error::InvalidConfig(
                        "the registry speaks another admission protocol",
                    ));
                }
                let (client, token, beat_url, beat_id) = (
                    self.client.clone(),
                    self.token.clone(),
                    self.session_url(Some(SESSION_HEARTBEAT_ACTION))?,
                    id.clone(),
                );
                let heartbeat = SessionHeartbeat::start(
                    heartbeat_interval(opened.heartbeat_interval_ms),
                    move || beat(&client, &beat_url, &token, &beat_id),
                );
                return Ok(Session {
                    id,
                    heartbeat,
                    complete_url: self.session_url(Some(SESSION_COMPLETE_ACTION))?,
                    client: self.client.clone(),
                    token: self.token.clone(),
                });
            }
            let retryable = matches!(status.as_u16(), 409 | 423 | 429 | 503);
            if attempt >= SESSION_OPEN_ATTEMPTS || !retryable {
                return Err(Error::HttpStatus { status, body: text });
            }
            std::thread::sleep(wait.unwrap_or_else(|| self.backoff_for(attempt)));
            attempt += 1;
        }
    }
}

/// An open admission session and its heartbeat.
struct Session {
    id: String,
    heartbeat: SessionHeartbeat,
    complete_url: url::Url,
    client: Client,
    token: String,
}

impl Session {
    /// A session whose heartbeat failed protects nothing: stop before the
    /// next call.
    fn require_live(&self) -> Result<()> {
        match self.heartbeat.failure() {
            Some(failure) => Err(Error::SessionBroken {
                session_id: self.id.clone(),
                detail: format!(
                    "the registry stopped admitting the session ({})",
                    failure.detail()
                ),
                cause: None,
            }),
            None => Ok(()),
        }
    }

    /// Stop the heartbeat, then close the session with `outcome`.
    fn complete(&self, outcome: &str) -> Result<()> {
        self.heartbeat.stop();
        let response = self
            .client
            .post(self.complete_url.clone())
            .bearer_auth(&self.token)
            .header(SESSION_HEADER, &self.id)
            .json(&serde_json::json!({ "outcome": outcome }))
            .send()?;
        let status = response.status();
        let body = response.text()?;
        if status.is_success() {
            Ok(())
        } else {
            Err(Error::HttpStatus { status, body })
        }
    }
}

#[derive(serde::Deserialize)]
struct SessionOpenResponse {
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    heartbeat_interval_ms: Option<u64>,
    #[serde(default)]
    protocol: Option<SessionProtocol>,
}

#[derive(serde::Deserialize)]
struct SessionProtocol {
    #[serde(default)]
    version: u32,
}

/// Keep the push's own error; a failed close is reported, wrapping it.
fn settle(
    session_id: String,
    result: Result<()>,
    beat: Option<BeatFailure>,
    finish: Result<()>,
) -> Result<()> {
    let result = match (result, beat) {
        (Ok(()), Some(failure)) => Err(Error::SessionBroken {
            session_id: session_id.clone(),
            detail: format!(
                "the registry stopped admitting the session ({}) before the push ended",
                failure.detail()
            ),
            cause: None,
        }),
        (result, _) => result,
    };
    match (result, finish) {
        (result, Ok(())) => result,
        (Ok(()), Err(termination)) => Err(Error::SessionBroken {
            session_id,
            detail: format!("the push finished but the session did not close ({termination})"),
            cause: None,
        }),
        (Err(primary), Err(termination)) => Err(Error::SessionBroken {
            session_id,
            detail: format!("the session did not close ({termination})"),
            cause: Some(Box::new(primary)),
        }),
    }
}

/// A body with a session code: the session no longer protected the call.
fn reports_lost_session(error: &Error) -> bool {
    matches!(error, Error::HttpStatus { status, body } if session_code(*status, body).is_some())
}

fn beat(
    client: &Client,
    url: &url::Url,
    token: &str,
    session_id: &str,
) -> std::result::Result<(), BeatFailure> {
    let response = client
        .post(url.clone())
        .bearer_auth(token)
        .header(SESSION_HEADER, session_id)
        .timeout(HEARTBEAT_REQUEST_TIMEOUT)
        .send()
        .map_err(|error| BeatFailure::Fatal(error.to_string()))?;
    let status = response.status();
    let body = response
        .text()
        .map_err(|error| BeatFailure::Fatal(error.to_string()))?;
    if status.is_success() {
        return Ok(());
    }
    Err(classify_beat_failure(status, &body))
}

fn retry_after(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    let seconds: u64 = headers
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse()
        .ok()?;
    Some(Duration::from_secs(seconds).min(RETRY_AFTER_CAP))
}

#[cfg(test)]
mod tests;
