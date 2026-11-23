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
//!
//! A pipeline's push (`push_image`) is the same under its session token; its
//! result names no attempt, and the first image recorded for a key stands:
//! a later one is answered with it.
//!
//! One refusal of step 3 ends the push well: `build_result_recorded` with the
//! `image_digest` this attempt recorded before. The builder restarted in the
//! middle of the job and built the image again; the recorded one stands.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use intar_contracts::oci::{Architecture, OCI_MANIFEST_MEDIA_TYPE, OciDigest, OciManifestV1};
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
/// How often a push starts over while the registry refuses writers: a website
/// deploy holds it for a couple of minutes and a clean-up sweep for longer.
/// Ending the push instead fails the build, and a build with warm caches
/// burns every attempt before a deploy is over. With the default backoff this
/// is twenty minutes.
const BUSY_RESTARTS: u32 = 80;
/// The wait before each of those, in units of the first retry's backoff.
const BUSY_BACKOFFS: u32 = 30;
const BUSY_WAIT_CAP: Duration = Duration::from_secs(15);
const REGISTRY_PAUSED_CODE: &str = "registry_paused";
const REGISTRY_SWEEP_CODE: &str = "registry_sweep_in_progress";
const RESULT_RECORDED_CODE: &str = "build_result_recorded";
/// A pipeline's write found its writer's lease run out: nothing was written,
/// and the same call passes again.
const WRITER_EXPIRED_CODE: &str = "registry_writer_expired";
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
    /// it as the `architecture` result of `attempt` of `build_id`. Returns
    /// the image the attempt has recorded for that architecture: `manifest`,
    /// or another one when an earlier run of the same attempt recorded it.
    ///
    /// # Errors
    /// Returns the first call that failed for good.
    pub fn push_build(
        &self,
        dir: &Path,
        manifest: &OciDigest,
        build_id: &str,
        attempt: u32,
        architecture: Architecture,
    ) -> Result<OciDigest> {
        let result_url = self.root.join(&format!(
            "builds/{build_id}/result?attempt={attempt}{}",
            // A result is the amd64 one unless it says otherwise.
            match architecture {
                Architecture::Amd64 => "",
                Architecture::Arm64 => "&arch=arm64",
            }
        ))?;
        let body = serde_json::json!({ "image_digest": manifest.as_str() });
        self.push_to(dir, std::slice::from_ref(manifest), &result_url, &body)
            .map(|(image, _)| image)
    }

    /// Push the image `manifest` from `dir` as a pipeline does and record it
    /// as its scope's `architecture` image of the build key `build_id` (its
    /// hex). The first image recorded for a key stands, so the answer is the
    /// recorded one, which is `manifest` when this push recorded it.
    ///
    /// # Errors
    /// Returns the first call that failed for good.
    pub fn push_image(
        &self,
        dir: &Path,
        manifest: &OciDigest,
        build_id: &str,
        architecture: Architecture,
    ) -> Result<RecordedImage> {
        #[derive(serde::Deserialize)]
        struct Answer {
            image_digest: OciDigest,
            #[serde(default)]
            recorded: bool,
        }
        let result_url = self.root.join(&format!(
            "builds/{build_id}/result?arch={}",
            match architecture {
                Architecture::Amd64 => "amd64",
                Architecture::Arm64 => "arm64",
            }
        ))?;
        let body = serde_json::json!({ "image_digest": manifest.as_str() });
        let (_, body) = self.push_to(dir, std::slice::from_ref(manifest), &result_url, &body)?;
        let answer: Answer = serde_json::from_str(&body)?;
        Ok(RecordedImage {
            first: !answer.recorded,
            image: answer.image_digest,
        })
    }

    /// Push every image of one Talos cluster's bake from `dir` in one
    /// session and record them as one set: its scope's `architecture` images
    /// of the cluster `cluster_id` (the cluster key's hex), each machine key
    /// with its manifest in `images`. A set that already stands is the
    /// answer, as for one image.
    ///
    /// # Errors
    /// Returns the first call that failed for good.
    pub fn push_cluster(
        &self,
        dir: &Path,
        images: &BTreeMap<OciDigest, OciDigest>,
        cluster_id: &str,
        architecture: Architecture,
    ) -> Result<RecordedCluster> {
        #[derive(serde::Deserialize)]
        struct Answer {
            images: BTreeMap<OciDigest, OciDigest>,
            #[serde(default)]
            recorded: bool,
        }
        let result_url = self.root.join(&format!(
            "clusters/{cluster_id}/result?arch={}",
            match architecture {
                Architecture::Amd64 => "amd64",
                Architecture::Arm64 => "arm64",
            }
        ))?;
        let body = serde_json::json!({
            "images": images
                .iter()
                .map(|(key, manifest)| serde_json::json!({
                    "build_key": key.as_str(), "image_digest": manifest.as_str(),
                }))
                .collect::<Vec<_>>(),
        });
        let manifests: Vec<OciDigest> = images.values().cloned().collect();
        let (_, body) = self.push_to(dir, &manifests, &result_url, &body)?;
        let answer: Answer = serde_json::from_str(&body)?;
        Ok(RecordedCluster {
            first: !answer.recorded,
            images: answer.images,
        })
    }

    /// The push itself: every blob of `manifests`, then each manifest, then
    /// the result `body`. The first manifest and the body of the result's
    /// answer.
    fn push_to(
        &self,
        dir: &Path,
        manifests: &[OciDigest],
        result_url: &url::Url,
        body: &serde_json::Value,
    ) -> Result<(OciDigest, String)> {
        let blobs = dir.join("sha256");
        let mut pushed = Vec::new();
        let mut digests = Vec::new();
        for manifest in manifests {
            let bytes = std::fs::read(blobs.join(manifest.hex()))?;
            let parsed: OciManifestV1 = serde_json::from_slice(&bytes)?;
            for digest in std::iter::once(parsed.config.digest)
                .chain(parsed.layers.into_iter().map(|layer| layer.digest))
            {
                if !digests.contains(&digest) {
                    digests.push(digest);
                }
            }
            pushed.push((manifest.clone(), bytes));
        }
        let mut restarts = 0;
        let mut busy_restarts = 0;
        loop {
            let session = match self.open_session() {
                Err(error) if registry_busy(&error) && busy_restarts < BUSY_RESTARTS => {
                    busy_restarts += 1;
                    std::thread::sleep(self.busy_wait());
                    continue;
                }
                opened => opened?,
            };
            let result = self.push_in(&session, &blobs, &digests, &pushed, result_url, body);
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
            // Every step is repeatable: a blob that is stored is found by its
            // HEAD, and a recorded result answers the same again.
            if matches!(&result, Err(error) if registry_busy(error))
                && busy_restarts < BUSY_RESTARTS
            {
                busy_restarts += 1;
                std::thread::sleep(self.busy_wait());
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
        manifests: &[(OciDigest, Vec<u8>)],
        result_url: &url::Url,
        body: &serde_json::Value,
    ) -> Result<(OciDigest, String)> {
        self.push_blobs(session, blobs, digests)?;
        for (manifest, bytes) in manifests {
            let url = self
                .root
                .join(&format!("manifests/{}", manifest.as_str()))?;
            self.call(session, || {
                Ok(self
                    .client
                    .put(url.clone())
                    .header(reqwest::header::CONTENT_TYPE, OCI_MANIFEST_MEDIA_TYPE)
                    .body(bytes.clone()))
            })?;
        }
        let first = manifests
            .first()
            .map(|(manifest, _)| manifest.clone())
            .ok_or(Error::InvalidConfig("a push names at least one image"))?;
        match self.call(session, || {
            Ok(self.client.post(result_url.clone()).json(body))
        }) {
            // The result is recorded once it is answered: a body that cannot
            // be read does not undo it. A pipeline's push reads the body and
            // fails on an empty one.
            Ok(response) => Ok((first, response.text().unwrap_or_default())),
            Err(error) => recorded_before(&error)
                .map(|image| (image, String::new()))
                .ok_or(error),
        }
    }

    /// The amd64 image `attempt` of `build_id` has recorded, if any: a job
    /// that runs again after a restart need not build it again. Asked once,
    /// without a session: it reads, and its caller can do without the answer.
    ///
    /// # Errors
    /// Returns an error when the registry does not answer the attempt's own
    /// builder with its result.
    pub fn recorded_image(&self, build_id: &str, attempt: u32) -> Result<Option<OciDigest>> {
        #[derive(serde::Deserialize)]
        struct Recorded {
            image_digest: Option<OciDigest>,
        }
        let url = self
            .root
            .join(&format!("builds/{build_id}/result?attempt={attempt}"))?;
        let response = self.client.get(url).bearer_auth(&self.token).send()?;
        let status = response.status();
        let body = response.text()?;
        if !status.is_success() {
            return Err(Error::HttpStatus { status, body });
        }
        Ok(serde_json::from_str::<Recorded>(&body)?.image_digest)
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
                    let retryable = status == StatusCode::TOO_MANY_REQUESTS
                        || status.is_server_error()
                        || writer_expired(status, &body);
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

    fn busy_wait(&self) -> Duration {
        (self.backoff * BUSY_BACKOFFS).min(BUSY_WAIT_CAP)
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
fn settle<T>(
    session_id: String,
    result: Result<T>,
    beat: Option<BeatFailure>,
    finish: Result<()>,
) -> Result<T> {
    let result = match (result, beat) {
        (Ok(_), Some(failure)) => Err(Error::SessionBroken {
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
        (Ok(_), Err(termination)) => Err(Error::SessionBroken {
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
/// The registry refuses writers for now: it is paused (a website deploy holds
/// it) or a clean-up sweep runs. Its answer is a 409 naming one of the two,
/// or a 409 without a body: the blob check is a HEAD, which carries none, and
/// that route's own answers are only 200 and 404.
fn registry_busy(error: &Error) -> bool {
    let Error::HttpStatus { status, body } = error else {
        return false;
    };
    if *status != StatusCode::CONFLICT {
        return false;
    }
    if body.trim().is_empty() {
        return true;
    }
    serde_json::from_str::<serde_json::Value>(body).is_ok_and(|value| {
        matches!(
            value.get("code").and_then(serde_json::Value::as_str),
            Some(REGISTRY_PAUSED_CODE | REGISTRY_SWEEP_CODE)
        )
    })
}

/// What a pipeline's cluster push left recorded: each machine key's image.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecordedCluster {
    pub images: BTreeMap<OciDigest, OciDigest>,
    /// This push recorded the set; false when it already stood.
    pub first: bool,
}

/// What a pipeline's push left recorded for its key.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecordedImage {
    pub image: OciDigest,
    /// This push recorded it; false when the key already had an image.
    pub first: bool,
}

fn writer_expired(status: StatusCode, body: &str) -> bool {
    status == StatusCode::CONFLICT
        && serde_json::from_str::<serde_json::Value>(body).is_ok_and(|value| {
            value.get("code").and_then(serde_json::Value::as_str) == Some(WRITER_EXPIRED_CODE)
        })
}

/// The image a refused result says this attempt recorded before. The registry
/// names it only to the attempt's own builder.
fn recorded_before(error: &Error) -> Option<OciDigest> {
    #[derive(serde::Deserialize)]
    struct Refusal {
        code: String,
        image_digest: OciDigest,
    }
    let Error::HttpStatus { status, body } = error else {
        return None;
    };
    if *status != StatusCode::CONFLICT {
        return None;
    }
    let refusal: Refusal = serde_json::from_str(body).ok()?;
    (refusal.code == RESULT_RECORDED_CODE).then_some(refusal.image_digest)
}

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
