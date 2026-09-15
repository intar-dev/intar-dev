#![allow(clippy::missing_errors_doc)]

use std::collections::BTreeMap;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

use intar_contracts::catalog::{
    ImageArchitecture, ImageChunkManifestV1, ImageChunkV1, ScenarioManifestV5,
};
use reqwest::blocking::multipart::Form;
use sha2::{Digest as _, Sha256};

use crate::config::ImageUploadConfig;
use crate::error::{Error, Result};
use crate::session::{
    BeatFailure, SESSION_COMPLETE_ACTION, SESSION_HEADER, SESSION_HEARTBEAT_ACTION, SESSION_ROUTE,
    SessionHeartbeat, classify_beat_failure, heartbeat_interval, session_code,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PublishImageChunkFile {
    pub raw_sha256: String,
    pub encoded_sha256: String,
    pub raw_size_bytes: u32,
    pub encoded_size_bytes: u64,
    pub source_path: Option<PathBuf>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ImageChunkLookup {
    pub raw_sha256: String,
    pub raw_size_bytes: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize)]
pub struct ExistingImageChunk {
    pub raw_sha256: String,
    pub raw_size_bytes: u32,
    pub encoded_sha256: String,
    pub encoded_size_bytes: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PublishChunkedImage {
    pub vm_name: String,
    pub image_id: String,
    pub chunk_manifest_sha256: String,
    pub chunk_manifest_path: PathBuf,
    pub chunks: Vec<PublishImageChunkFile>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PublishArtifactFile {
    pub sha256: String,
    pub source_path: PathBuf,
}

/// Identity of the control-plane build assignment authorizing a builder
/// publish. Operator-token publishes deliberately omit this context; builder
/// agent JWTs are accepted by the registry only when these fields still match
/// an active assignment for the authenticated host.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PublishBuildIdentity {
    pub build_id: String,
    pub rev: String,
    pub content_hash: String,
    pub architecture: ImageArchitecture,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize)]
pub struct PublishReceipt {
    pub ok: bool,
    pub scenario_id: String,
    pub images: Vec<PublishedImage>,
    #[serde(default)]
    pub artifacts: Vec<PublishedArtifact>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize)]
pub struct PublishedImage {
    pub image_key: String,
    pub image_id: String,
    pub object_key: String,
    pub bytes: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize)]
pub struct PublishedArtifact {
    pub sha256: String,
    pub object_key: String,
    pub bytes: u64,
    pub reused: bool,
}

#[derive(Clone)]
pub struct ImageUploader {
    config: ImageUploadConfig,
    endpoint: url::Url,
    client: reqwest::blocking::Client,
}

impl ImageUploader {
    pub fn new(config: ImageUploadConfig) -> Result<Self> {
        config.validate()?;
        let endpoint = config.endpoint()?;

        Ok(Self {
            config,
            endpoint,
            client: reqwest::blocking::Client::new(),
        })
    }

    /// Publish a scenario manifest. Image and boot artifact payloads are
    /// uploaded ahead of the manifest as chunked multipart uploads: the
    /// registry sits behind Cloudflare, whose per-request body limit is far
    /// below typical image sizes, so a single multipart form with inline
    /// payloads is rejected with 413.
    pub fn publish_manifest_with_artifacts(
        &self,
        manifest: &ScenarioManifestV5,
        images: &[PublishChunkedImage],
        artifacts: &[PublishArtifactFile],
    ) -> Result<PublishReceipt> {
        self.publish_manifest_with_optional_identity(manifest, images, artifacts, None)
    }

    pub fn publish_build_manifest_with_artifacts(
        &self,
        manifest: &ScenarioManifestV5,
        images: &[PublishChunkedImage],
        artifacts: &[PublishArtifactFile],
        identity: &PublishBuildIdentity,
    ) -> Result<PublishReceipt> {
        validate_build_identity(identity)?;
        self.publish_manifest_with_optional_identity(manifest, images, artifacts, Some(identity))
    }

    /// Publish inside the caller-owned session that covered the reusable-chunk
    /// probe, without restarting it. The caller completes the session itself.
    /// When the registry stops admitting that session the publish fails with
    /// the session named, because only the caller can re-probe its own reuse
    /// decisions.
    pub fn publish_build_manifest_with_session(
        &self,
        manifest: &ScenarioManifestV5,
        images: &[PublishChunkedImage],
        artifacts: &[PublishArtifactFile],
        identity: &PublishBuildIdentity,
        session: &RegistryUploadSession,
    ) -> Result<PublishReceipt> {
        validate_build_identity(identity)?;
        self.publish_with_session(manifest, images, artifacts, Some(identity), session)
    }

    fn publish_with_session(
        &self,
        manifest: &ScenarioManifestV5,
        images: &[PublishChunkedImage],
        artifacts: &[PublishArtifactFile],
        identity: Option<&PublishBuildIdentity>,
        session: &RegistryUploadSession,
    ) -> Result<PublishReceipt> {
        if images.is_empty() {
            return Err(Error::InvalidConfig("publish requires at least one image"));
        }
        for image in images {
            validate_chunked_image(manifest, image)?;
        }
        let result = self.upload_and_publish(manifest, images, artifacts, identity, session);
        shared_session_result(session, result)
    }

    fn publish_manifest_with_optional_identity(
        &self,
        manifest: &ScenarioManifestV5,
        images: &[PublishChunkedImage],
        artifacts: &[PublishArtifactFile],
        identity: Option<&PublishBuildIdentity>,
    ) -> Result<PublishReceipt> {
        if images.is_empty() {
            return Err(Error::InvalidConfig("publish requires at least one image"));
        }

        for image in images {
            validate_chunked_image(manifest, image)?;
        }

        // One session covers the whole upload: the first registry call is the
        // chunk-existence probe and the last is the stored manifest, so a
        // concurrent cleanup cannot delete an object this publish still needs.
        self.with_upload_session("image-publish", |session| {
            self.upload_and_publish(manifest, images, artifacts, identity, session)
        })
    }

    fn upload_and_publish(
        &self,
        manifest: &ScenarioManifestV5,
        images: &[PublishChunkedImage],
        artifacts: &[PublishArtifactFile],
        identity: Option<&PublishBuildIdentity>,
        session: &RegistryUploadSession,
    ) -> Result<PublishReceipt> {
        for image in images {
            self.upload_chunked_image(image, session)?;
        }
        for artifact in artifacts {
            let sha256 = normalize_sha256(&artifact.sha256)?;
            let create_body = serde_json::json!({
                "kind": "artifact",
                "sha256": sha256,
            });
            self.upload_blob(&create_body, &artifact.source_path, session)?;
        }

        require_live_session(session)?;
        let mut form = Form::new().text("manifest", serde_json::to_string(manifest)?);
        if let Some(identity) = identity {
            form = form
                .text("build_id", identity.build_id.clone())
                .text("rev", identity.rev.clone())
                .text("content_hash", identity.content_hash.clone())
                .text(
                    "architecture",
                    architecture_name(&identity.architecture).to_owned(),
                );
        }
        let response = self
            .client
            .post(self.endpoint.clone())
            .bearer_auth(self.config.token.trim())
            .header(SESSION_HEADER, &session.id)
            .multipart(form)
            .send()?;
        let status = response.status();
        let body = response.text()?;
        if !status.is_success() {
            return Err(Error::HttpStatus { status, body });
        }

        Ok(serde_json::from_str(&body)?)
    }

    fn upload_chunked_image(
        &self,
        image: &PublishChunkedImage,
        session: &RegistryUploadSession,
    ) -> Result<()> {
        let lookups = image
            .chunks
            .iter()
            .map(|chunk| ImageChunkLookup {
                raw_sha256: chunk.raw_sha256.clone(),
                raw_size_bytes: chunk.raw_size_bytes,
            })
            .collect::<Vec<_>>();
        let existing = self.find_existing_image_chunks_in_session(&lookups, session)?;

        let mut missing_by_hash = BTreeMap::<&str, &PublishImageChunkFile>::new();
        for chunk in &image.chunks {
            if existing.contains_key(&chunk.raw_sha256) {
                continue;
            }
            match missing_by_hash.entry(&chunk.raw_sha256) {
                std::collections::btree_map::Entry::Vacant(entry) => {
                    entry.insert(chunk);
                }
                std::collections::btree_map::Entry::Occupied(mut entry)
                    if entry.get().source_path.is_none() && chunk.source_path.is_some() =>
                {
                    entry.insert(chunk);
                }
                std::collections::btree_map::Entry::Occupied(_) => {}
            }
        }
        let missing = missing_by_hash.into_values().collect::<Vec<_>>();
        for batch in missing.chunks(CHUNK_UPLOAD_CONCURRENCY) {
            std::thread::scope(|scope| {
                let handles = batch
                    .iter()
                    .map(|chunk| scope.spawn(|| self.upload_image_chunk(chunk, session)))
                    .collect::<Vec<_>>();
                for handle in handles {
                    handle.join().map_err(|_| {
                        Error::InvalidConfig("image chunk uploader thread panicked")
                    })??;
                }
                Ok::<(), Error>(())
            })?;
        }

        require_live_session(session)?;
        let manifest_bytes = std::fs::read(&image.chunk_manifest_path).map_err(Error::Io)?;
        let mut url = sibling_endpoint(&self.endpoint, "image-manifests")?;
        url.path_segments_mut()
            .map_err(|()| Error::InvalidConfig("publish url cannot be a base URL"))?
            .push(&format!("{}.json", image.chunk_manifest_sha256));
        let response = self
            .client
            .put(url)
            .bearer_auth(self.config.token.trim())
            .header("content-type", "application/json")
            .header("x-intar-manifest-sha256", &image.chunk_manifest_sha256)
            .header(SESSION_HEADER, &session.id)
            .body(manifest_bytes)
            .send()?;
        require_success(response)?;
        Ok(())
    }

    /// Probe the chunks the registry already stores inside a caller-owned
    /// session. Passing the same session to the session-aware publish keeps
    /// every chunk this probe answered for out of a concurrent cleanup.
    pub fn find_existing_image_chunks_in_session(
        &self,
        chunks: &[ImageChunkLookup],
        session: &RegistryUploadSession,
    ) -> Result<BTreeMap<String, ExistingImageChunk>> {
        let mut expected = BTreeMap::new();
        for chunk in chunks {
            let raw_sha256 = normalize_sha256(&chunk.raw_sha256)?;
            if chunk.raw_size_bytes == 0 || chunk.raw_size_bytes > 4 * 1024 * 1024 {
                return Err(Error::InvalidConfig("invalid raw image chunk size"));
            }
            if let Some(previous) = expected.insert(raw_sha256, chunk.raw_size_bytes)
                && previous != chunk.raw_size_bytes
            {
                return Err(Error::InvalidConfig(
                    "one raw image chunk hash has conflicting sizes",
                ));
            }
        }

        let hashes = expected.keys().cloned().collect::<Vec<_>>();
        let mut existing = BTreeMap::new();
        for batch in hashes.chunks(CHUNK_EXISTS_BATCH_SIZE) {
            let response: ExistingChunksResponse = self.post_json(
                sibling_endpoint(&self.endpoint, "image-chunks/exists")?,
                &serde_json::json!({ "raw_sha256": batch }),
                session,
            )?;
            for mut chunk in response.existing {
                chunk.raw_sha256 = normalize_sha256(&chunk.raw_sha256)?;
                chunk.encoded_sha256 = normalize_sha256(&chunk.encoded_sha256)?;
                if expected.get(&chunk.raw_sha256) != Some(&chunk.raw_size_bytes)
                    || chunk.encoded_size_bytes == 0
                {
                    return Err(Error::InvalidConfig(
                        "registry returned inconsistent image chunk metadata",
                    ));
                }
                if let Some(previous) = existing.insert(chunk.raw_sha256.clone(), chunk.clone())
                    && previous != chunk
                {
                    return Err(Error::InvalidConfig(
                        "registry returned conflicting image chunk metadata",
                    ));
                }
            }
        }
        Ok(existing)
    }

    fn upload_image_chunk(
        &self,
        chunk: &PublishImageChunkFile,
        session: &RegistryUploadSession,
    ) -> Result<()> {
        require_live_session(session)?;
        let _permit = CHUNK_UPLOAD_GATE.acquire();
        let mut url = sibling_endpoint(&self.endpoint, "image-chunks")?;
        url.path_segments_mut()
            .map_err(|()| Error::InvalidConfig("publish url cannot be a base URL"))?
            .push(&chunk.raw_sha256);
        let source_path =
            chunk
                .source_path
                .as_ref()
                .ok_or_else(|| Error::MissingImageChunkPayload {
                    raw_sha256: chunk.raw_sha256.clone(),
                })?;
        let body = std::fs::read(source_path).map_err(Error::Io)?;
        if body.len() as u64 != chunk.encoded_size_bytes {
            return Err(Error::InvalidPath(format!(
                "{} has size {}, expected {}",
                source_path.display(),
                body.len(),
                chunk.encoded_size_bytes
            )));
        }
        let response = self
            .client
            .put(url)
            .bearer_auth(self.config.token.trim())
            .header("content-type", "application/zstd")
            .header("x-intar-raw-sha256", &chunk.raw_sha256)
            .header("x-intar-encoded-sha256", &chunk.encoded_sha256)
            .header("x-intar-raw-size", chunk.raw_size_bytes)
            .header("x-intar-encoded-size", chunk.encoded_size_bytes)
            .header(SESSION_HEADER, &session.id)
            .body(body)
            .send()?;
        require_success(response)
    }

    fn upload_blob(
        &self,
        create_body: &serde_json::Value,
        source_path: &Path,
        session: &RegistryUploadSession,
    ) -> Result<()> {
        let uploads_url = sibling_endpoint(&self.endpoint, "uploads")?;
        let create: UploadCreateResponse =
            self.post_json(uploads_url.clone(), create_body, session)?;
        if create.already_exists {
            return Ok(());
        }
        let upload_id = create
            .upload_id
            .ok_or(Error::InvalidConfig("upload create returned no upload_id"))?;

        let file = std::fs::File::open(source_path).map_err(Error::Io)?;
        let mut reader = std::io::BufReader::new(file);
        let mut parts = Vec::new();
        let mut part_number: u32 = 1;
        loop {
            let chunk = read_chunk(&mut reader, UPLOAD_PART_BYTES)?;
            let last = (chunk.len() as u64) < UPLOAD_PART_BYTES;
            if chunk.is_empty() && part_number > 1 {
                break;
            }

            let mut part_url = sibling_endpoint(&self.endpoint, "uploads/parts")?;
            part_url
                .query_pairs_mut()
                .append_pair("object_key", &create.object_key)
                .append_pair("upload_id", &upload_id)
                .append_pair("part_number", &part_number.to_string());
            let response = self
                .client
                .put(part_url)
                .bearer_auth(self.config.token.trim())
                .header(SESSION_HEADER, &session.id)
                .body(chunk)
                .send()?;
            let status = response.status();
            let body = response.text()?;
            if !status.is_success() {
                return Err(Error::HttpStatus { status, body });
            }
            let uploaded: UploadPartResponse = serde_json::from_str(&body)?;
            parts.push(serde_json::json!({
                "part_number": uploaded.part_number,
                "etag": uploaded.etag,
            }));

            if last {
                break;
            }
            part_number += 1;
        }

        let complete_url = sibling_endpoint(&self.endpoint, "uploads/complete")?;
        let _: UploadCompleteResponse = self.post_json(
            complete_url,
            &serde_json::json!({
                "object_key": create.object_key,
                "upload_id": upload_id,
                "parts": parts,
            }),
            session,
        )?;
        Ok(())
    }

    fn post_json<T: serde::de::DeserializeOwned>(
        &self,
        url: url::Url,
        body: &serde_json::Value,
        session: &RegistryUploadSession,
    ) -> Result<T> {
        require_live_session(session)?;
        let response = self
            .client
            .post(url)
            .bearer_auth(self.config.token.trim())
            .header(SESSION_HEADER, &session.id)
            .json(body)
            .send()?;
        let status = response.status();
        let text = response.text()?;
        if !status.is_success() {
            return Err(Error::HttpStatus { status, body: text });
        }
        Ok(serde_json::from_str(&text)?)
    }

    /// Run one registry upload under a single admission session.
    ///
    /// A superseded session protects nothing: the upload is discarded, a fresh
    /// session is opened, and the work starts again so the chunk-exists probe
    /// runs before any write. That restart is cheap, because chunks the
    /// registry already stores come back as existing on the second attempt.
    fn with_upload_session<T>(
        &self,
        intent: &str,
        work: impl Fn(&RegistryUploadSession) -> Result<T>,
    ) -> Result<T> {
        let mut attempt: u32 = 0;
        loop {
            attempt += 1;
            let session = self.open_upload_session(intent)?;
            let result = work(&session);
            let beat = session.heartbeat.stop();
            let superseded = matches!(beat, Some(BeatFailure::Superseded))
                || matches!(&result, Err(error) if reports_lost_session(error));

            let outcome = if result.is_ok() {
                UploadOutcome::Published
            } else {
                UploadOutcome::Abandoned
            };
            let session_id = session.id.clone();
            let finish = session.complete(outcome);

            if superseded && result.is_err() && attempt <= SESSION_RESTARTS {
                continue;
            }
            return self.settle_upload_session(session_id, result, beat, finish);
        }
    }

    /// Terminate the session and keep the primary result. A failed close is
    /// reported as its own error, and on the failure path it wraps the upload
    /// error instead of replacing it.
    fn settle_upload_session<T>(
        &self,
        session_id: String,
        result: Result<T>,
        beat: Option<BeatFailure>,
        finish: Result<()>,
    ) -> Result<T> {
        let result = match (result, beat) {
            (Ok(_), Some(failure)) => Err(stopped_protecting(&session_id, &failure)),
            (result, _) => result,
        };
        match (result, finish) {
            (result, Ok(())) => result,
            (Ok(_), Err(termination)) => Err(Error::SessionBroken {
                session_id,
                detail: format!(
                    "the registry accepted the publish but did not complete the upload session ({termination}); re-run the publish to close it"
                ),
                cause: None,
            }),
            (Err(primary), Err(termination)) => Err(Error::SessionBroken {
                session_id,
                detail: format!("the registry did not complete the upload session ({termination})"),
                cause: Some(Box::new(primary)),
            }),
        }
    }

    /// Start an admission session for a registry upload.
    ///
    /// A caller that writes to the registry itself starts a session, sends
    /// REGISTRY_SESSION_HEADER on every call, and completes it when the upload
    /// ends.
    pub fn start_session(&self, intent: &str) -> Result<RegistryUploadSession> {
        self.open_upload_session(intent)
    }

    fn open_upload_session(&self, intent: &str) -> Result<RegistryUploadSession> {
        let url = self.session_url(None)?;
        let body = serde_json::json!({ "intent": intent });
        let mut attempt: u32 = 1;
        loop {
            let response = self
                .client
                .post(url.clone())
                .bearer_auth(self.config.token.trim())
                .json(&body)
                .send()?;
            let status = response.status();
            let retry_after = retry_after_delay(response.headers());
            let text = response.text()?;
            if status.is_success() {
                let opened: SessionOpenResponse = serde_json::from_str(&text)?;
                let session_id = opened.session_id.trim().to_owned();
                if session_id.is_empty() {
                    return Err(Error::InvalidConfig(
                        "registry opened an upload session without a usable id",
                    ));
                }
                if opened
                    .protocol
                    .as_ref()
                    .is_some_and(|protocol| protocol.version != REGISTRY_ADMISSION_PROTOCOL_VERSION)
                {
                    return Err(Error::InvalidConfig(
                        "registry admission protocol version does not match this uploader",
                    ));
                }
                let interval = heartbeat_interval(opened.heartbeat_interval_ms);
                let heartbeat = self.start_heartbeat(
                    &session_id,
                    self.session_url(Some(SESSION_HEARTBEAT_ACTION))?,
                    interval,
                );
                return Ok(RegistryUploadSession {
                    id: session_id,
                    heartbeat,
                    complete_url: self.session_url(Some(SESSION_COMPLETE_ACTION))?,
                    client: self.client.clone(),
                    token: self.config.token.trim().to_owned(),
                });
            }
            if attempt >= SESSION_OPEN_ATTEMPTS || !is_retryable_session_status(status) {
                return Err(Error::HttpStatus { status, body: text });
            }
            std::thread::sleep(
                retry_after.unwrap_or_else(|| {
                    (SESSION_OPEN_BACKOFF * attempt).min(SESSION_OPEN_BACKOFF_CAP)
                }),
            );
            attempt += 1;
        }
    }

    fn start_heartbeat(
        &self,
        session_id: &str,
        url: url::Url,
        interval: Duration,
    ) -> SessionHeartbeat {
        let client = self.client.clone();
        let token = self.config.token.trim().to_owned();
        let session_id = session_id.to_owned();
        SessionHeartbeat::start(interval, move || {
            beat_session(&client, &url, &token, &session_id)
        })
    }

    fn session_url(&self, action: Option<&str>) -> Result<url::Url> {
        let mut url = sibling_endpoint(&self.endpoint, SESSION_ROUTE)?;
        if let Some(action) = action {
            url.path_segments_mut()
                .map_err(|()| Error::InvalidConfig("publish url cannot be a base URL"))?
                .push(action);
        }
        Ok(url)
    }
}

/// An error body that carries a registry session code means the session no
/// longer protected the work that produced it.
fn reports_lost_session(error: &Error) -> bool {
    matches!(
        error,
        Error::HttpStatus { status, body } if session_code(*status, body).is_some()
    )
}

/// The registry stopped admitting this session, so the upload did not reach a
/// protected end. The unresolved writer row keeps blocking deletion until an
/// operator resolves it, which is why the client reports this instead of
/// letting the caller read a success.
fn stopped_protecting(session_id: &str, failure: &BeatFailure) -> Error {
    Error::SessionBroken {
        session_id: session_id.to_owned(),
        detail: format!(
            "the registry stopped admitting the session ({}); the upload did not run to a protected end",
            failure.detail()
        ),
        cause: None,
    }
}

/// A caller-owned session is never replaced behind the caller's back: the
/// reuse decisions taken under it must be re-probed by the caller before the
/// upload continues.
fn shared_session_result<T>(session: &RegistryUploadSession, result: Result<T>) -> Result<T> {
    let lost = session.heartbeat.failure().or_else(|| match &result {
        Err(error) if reports_lost_session(error) => Some(BeatFailure::Superseded),
        _ => None,
    });
    match (result, lost) {
        (Ok(_), Some(failure)) => Err(stopped_protecting(&session.id, &failure)),
        (Err(primary), Some(failure)) => Err(Error::SessionBroken {
            session_id: session.id.clone(),
            detail: format!(
                "the registry stopped admitting the session ({}); restart the upload from its chunk-exists probe",
                failure.detail()
            ),
            cause: Some(Box::new(primary)),
        }),
        (result, None) => result,
    }
}

/// A failed heartbeat means the registry no longer protects this upload, so
/// the caller stops instead of writing against a stale session.
fn require_live_session(session: &RegistryUploadSession) -> Result<()> {
    match session.heartbeat.failure() {
        Some(failure) => Err(Error::SessionBroken {
            session_id: session.id.clone(),
            detail: format!(
                "the registry stopped admitting the session ({}); the upload stopped before its next registry call",
                failure.detail()
            ),
            cause: None,
        }),
        None => Ok(()),
    }
}

fn beat_session(
    client: &reqwest::blocking::Client,
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

/// A cleanup sweep in progress refuses new writers with a retryable status.
fn is_retryable_session_status(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 409 | 423 | 429 | 503)
}

fn retry_after_delay(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    let seconds = headers
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()?;
    Some(Duration::from_secs(seconds.min(RETRY_AFTER_CAP_SECONDS)))
}

/// Header that carries the admission session on every registry write.
pub const REGISTRY_SESSION_HEADER: &str = SESSION_HEADER;

/// Outcome recorded when an upload session ends. Published releases the session
/// as completed; Abandoned records that the upload did not finish.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UploadOutcome {
    Published,
    Abandoned,
}

impl UploadOutcome {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Published => "published",
            Self::Abandoned => "abandoned",
        }
    }
}

/// An open registry admission session.
///
/// Uploads this crate performs hold one internally. A caller that writes to the
/// registry itself, such as the image CLI uploading a bundle with its own
/// request, starts a session, sends REGISTRY_SESSION_HEADER on every registry
/// call, and completes the session with the outcome of the upload.
pub struct RegistryUploadSession {
    id: String,
    heartbeat: SessionHeartbeat,
    complete_url: url::Url,
    client: reqwest::blocking::Client,
    token: String,
}

impl RegistryUploadSession {
    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Close the session. The heartbeat stops first, so nothing keeps the
    /// session admitted after the caller has finished.
    pub fn complete(&self, outcome: UploadOutcome) -> Result<()> {
        // Stopping twice is harmless: the second call sees a stopped heartbeat.
        self.heartbeat.stop();
        let response = self
            .client
            .post(self.complete_url.clone())
            .bearer_auth(self.token.trim())
            .header(SESSION_HEADER, &self.id)
            .json(&serde_json::json!({ "outcome": outcome.as_str() }))
            .send()?;
        require_success(response)
    }
}

#[derive(Debug, serde::Deserialize)]
struct SessionOpenResponse {
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    heartbeat_interval_ms: Option<u64>,
    #[serde(default)]
    protocol: Option<SessionProtocol>,
}

#[derive(Debug, serde::Deserialize)]
struct SessionProtocol {
    #[serde(default)]
    version: u32,
}

fn validate_chunked_image(
    scenario_manifest: &ScenarioManifestV5,
    image: &PublishChunkedImage,
) -> Result<()> {
    let vm = scenario_manifest
        .vms
        .iter()
        .find(|vm| vm.name == image.vm_name)
        .ok_or(Error::InvalidConfig("manifest has no vm for chunked image"))?;
    if normalize_sha256(&vm.image_id)? != normalize_sha256(&image.image_id)? {
        return Err(Error::InvalidConfig(
            "chunked image id does not match scenario manifest",
        ));
    }
    if normalize_sha256(&vm.chunk_manifest_sha256)?
        != normalize_sha256(&image.chunk_manifest_sha256)?
    {
        return Err(Error::InvalidConfig(
            "chunk manifest digest does not match scenario manifest",
        ));
    }

    let bytes = std::fs::read(&image.chunk_manifest_path).map_err(Error::Io)?;
    if sha256_hex(&bytes) != image.chunk_manifest_sha256 {
        return Err(Error::InvalidConfig("chunk manifest SHA-256 mismatch"));
    }
    let manifest: ImageChunkManifestV1 = serde_json::from_slice(&bytes)?;
    manifest
        .validate()
        .map_err(|_| Error::InvalidConfig("chunk manifest validation failed"))?;
    if manifest.image_id != image.image_id {
        return Err(Error::InvalidConfig("chunk manifest image id mismatch"));
    }
    if manifest.chunks.len() != image.chunks.len() {
        return Err(Error::InvalidConfig(
            "chunk file count does not match manifest",
        ));
    }
    for (descriptor, file) in manifest.chunks.iter().zip(&image.chunks) {
        if descriptor.raw_sha256 != file.raw_sha256
            || descriptor.encoded_sha256 != file.encoded_sha256
            || descriptor.raw_size_bytes != file.raw_size_bytes
            || descriptor.encoded_size_bytes != file.encoded_size_bytes
        {
            return Err(Error::InvalidConfig("chunk file does not match manifest"));
        }
        validate_chunk_file(file)?;
    }
    Ok(())
}

fn validate_chunk_file(chunk: &PublishImageChunkFile) -> Result<()> {
    normalize_sha256(&chunk.raw_sha256)?;
    normalize_sha256(&chunk.encoded_sha256)?;
    if chunk.raw_size_bytes == 0 || chunk.raw_size_bytes > 4 * 1024 * 1024 {
        return Err(Error::InvalidConfig("invalid raw image chunk size"));
    }
    if chunk.encoded_size_bytes == 0 {
        return Err(Error::InvalidConfig("invalid encoded image chunk size"));
    }
    if let Some(source_path) = &chunk.source_path
        && !source_path.is_file()
    {
        return Err(Error::InvalidPath(source_path.display().to_string()));
    }
    Ok(())
}

impl PublishBuildIdentity {
    pub fn new(
        build_id: impl Into<String>,
        rev: impl Into<String>,
        content_hash: impl Into<String>,
        architecture: ImageArchitecture,
    ) -> Result<Self> {
        let identity = Self {
            build_id: build_id.into(),
            rev: rev.into(),
            content_hash: content_hash.into(),
            architecture,
        };
        validate_build_identity(&identity)?;
        Ok(identity)
    }
}

fn validate_build_identity(identity: &PublishBuildIdentity) -> Result<()> {
    if !is_safe_identity_slug(&identity.build_id) {
        return Err(Error::InvalidKey(identity.build_id.clone()));
    }
    if !is_safe_identity_slug(&identity.rev) {
        return Err(Error::InvalidKey(identity.rev.clone()));
    }
    normalize_sha256(&identity.content_hash)?;
    Ok(())
}

fn is_safe_identity_slug(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

const fn architecture_name(architecture: &ImageArchitecture) -> &'static str {
    match architecture {
        ImageArchitecture::X86_64 => "x86_64",
        ImageArchitecture::Aarch64 => "aarch64",
    }
}

/// R2 multipart parts must share one size (only the final part may be
/// smaller); 64 MiB stays comfortably under Cloudflare request body limits.
const UPLOAD_PART_BYTES: u64 = 64 * 1024 * 1024;
/// A sweep in progress refuses new sessions, so registration retries before
/// the upload gives up. The registry's `retry-after` wins when it sends one.
const SESSION_OPEN_ATTEMPTS: u32 = 6;
const SESSION_OPEN_BACKOFF: Duration = Duration::from_millis(500);
const SESSION_OPEN_BACKOFF_CAP: Duration = Duration::from_secs(5);
/// A superseded session makes the upload restart from its chunk-exists probe.
/// The budget is small: a lease that lapses twice is an operator problem, not
/// something a third attempt will fix.
const SESSION_RESTARTS: u32 = 2;
/// The admission protocol this uploader speaks.
const REGISTRY_ADMISSION_PROTOCOL_VERSION: u32 = 1;
const HEARTBEAT_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const RETRY_AFTER_CAP_SECONDS: u64 = 30;
const CHUNK_EXISTS_BATCH_SIZE: usize = 512;
const CHUNK_UPLOAD_CONCURRENCY: usize = 8;
static CHUNK_UPLOAD_GATE: ChunkUploadGate = ChunkUploadGate::new(CHUNK_UPLOAD_CONCURRENCY);

struct ChunkUploadGate {
    available: Mutex<usize>,
    changed: Condvar,
}

impl ChunkUploadGate {
    const fn new(limit: usize) -> Self {
        Self {
            available: Mutex::new(limit),
            changed: Condvar::new(),
        }
    }

    fn acquire(&self) -> ChunkUploadPermit<'_> {
        let mut available = self
            .available
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        while *available == 0 {
            available = self
                .changed
                .wait(available)
                .unwrap_or_else(|error| error.into_inner());
        }
        *available -= 1;
        ChunkUploadPermit { gate: self }
    }
}

struct ChunkUploadPermit<'a> {
    gate: &'a ChunkUploadGate,
}

impl Drop for ChunkUploadPermit<'_> {
    fn drop(&mut self) {
        *self
            .gate
            .available
            .lock()
            .unwrap_or_else(|error| error.into_inner()) += 1;
        self.gate.changed.notify_one();
    }
}

#[derive(Debug, serde::Deserialize)]
struct ExistingChunksResponse {
    existing: Vec<ExistingImageChunk>,
}

#[derive(Debug, serde::Deserialize)]
struct UploadCreateResponse {
    object_key: String,
    #[serde(default)]
    upload_id: Option<String>,
    #[serde(default)]
    already_exists: bool,
}

#[derive(Debug, serde::Deserialize)]
struct UploadPartResponse {
    part_number: u32,
    etag: String,
}

#[derive(Debug, serde::Deserialize)]
struct UploadCompleteResponse {
    #[allow(dead_code)]
    ok: bool,
}

fn read_chunk(reader: &mut impl std::io::Read, limit: u64) -> Result<Vec<u8>> {
    let mut chunk = Vec::new();
    reader
        .take(limit)
        .read_to_end(&mut chunk)
        .map_err(Error::Io)?;
    Ok(chunk)
}

fn sibling_endpoint(endpoint: &url::Url, name: &str) -> Result<url::Url> {
    let path = endpoint.path();
    let base = path
        .strip_suffix("/publish")
        .ok_or(Error::InvalidConfig("publish url must end with /publish"))?;
    let mut sibling = endpoint.clone();
    sibling.set_path(&format!("{base}/{name}"));
    sibling.set_query(None);
    Ok(sibling)
}

impl PublishImageChunkFile {
    pub fn from_optional_path(
        descriptor: &ImageChunkV1,
        source_path: Option<&Path>,
    ) -> Result<Self> {
        let file = Self {
            raw_sha256: normalize_sha256(&descriptor.raw_sha256)?,
            encoded_sha256: normalize_sha256(&descriptor.encoded_sha256)?,
            raw_size_bytes: descriptor.raw_size_bytes,
            encoded_size_bytes: descriptor.encoded_size_bytes,
            source_path: source_path.map(Path::to_path_buf),
        };
        validate_chunk_file(&file)?;
        Ok(file)
    }
}

impl PublishChunkedImage {
    pub fn new(
        vm_name: impl Into<String>,
        image_id: impl Into<String>,
        chunk_manifest_sha256: impl Into<String>,
        chunk_manifest_path: impl AsRef<Path>,
        chunks: Vec<PublishImageChunkFile>,
    ) -> Result<Self> {
        let image = Self {
            vm_name: vm_name.into(),
            image_id: normalize_sha256(&image_id.into())?,
            chunk_manifest_sha256: normalize_sha256(&chunk_manifest_sha256.into())?,
            chunk_manifest_path: chunk_manifest_path.as_ref().to_path_buf(),
            chunks,
        };
        if !image.chunk_manifest_path.is_file() {
            return Err(Error::InvalidPath(
                image.chunk_manifest_path.display().to_string(),
            ));
        }
        Ok(image)
    }
}

impl PublishArtifactFile {
    pub fn new(source_path: impl AsRef<Path>, sha256: impl Into<String>) -> Result<Self> {
        let source_path = source_path.as_ref();
        if !source_path.is_file() {
            return Err(Error::InvalidPath(source_path.display().to_string()));
        }
        let sha256 = normalize_sha256(&sha256.into())?;

        Ok(Self {
            sha256,
            source_path: source_path.to_path_buf(),
        })
    }
}

fn normalize_sha256(value: &str) -> Result<String> {
    let sha256 = value.trim().to_lowercase();
    if sha256.len() == 64 && sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Ok(sha256);
    }
    Err(Error::InvalidKey(value.to_owned()))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn require_success(response: reqwest::blocking::Response) -> Result<()> {
    let status = response.status();
    let body = response.text()?;
    if status.is_success() {
        Ok(())
    } else {
        Err(Error::HttpStatus { status, body })
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::sync::{Arc, mpsc};
    use std::time::Duration;

    use intar_contracts::catalog::ImageArchitecture;

    use super::{PublishArtifactFile, PublishBuildIdentity, architecture_name, normalize_sha256};

    #[test]
    fn accepts_boot_artifact_file() {
        let temp = tempfile::NamedTempFile::new().unwrap();
        let sha256 = "a".repeat(64);
        let file = PublishArtifactFile::new(temp.path(), &sha256).expect("file should be valid");

        assert_eq!(file.sha256, sha256);
    }

    #[test]
    fn normalizes_sha256() {
        assert_eq!(normalize_sha256(&"A".repeat(64)).unwrap(), "a".repeat(64));
        assert!(normalize_sha256("not-a-sha").is_err());
    }

    #[test]
    fn validates_builder_publish_identity() {
        let identity = PublishBuildIdentity::new(
            "build-1",
            "rev-1",
            "A".repeat(64),
            ImageArchitecture::X86_64,
        )
        .unwrap();
        assert_eq!(identity.build_id, "build-1");
        assert_eq!(architecture_name(&identity.architecture), "x86_64");

        assert!(
            PublishBuildIdentity::new(
                "../escape",
                "rev-1",
                "a".repeat(64),
                ImageArchitecture::X86_64,
            )
            .is_err()
        );
        assert!(
            PublishBuildIdentity::new(
                "build-1",
                "../escape",
                "a".repeat(64),
                ImageArchitecture::X86_64,
            )
            .is_err()
        );
        assert!(
            PublishBuildIdentity::new("build-1", "rev-1", "not-a-sha", ImageArchitecture::X86_64,)
                .is_err()
        );
    }

    #[test]
    fn derives_upload_endpoints_from_publish_url() {
        let endpoint = url::Url::parse("https://intar.dev/registry/v1/publish").unwrap();
        assert_eq!(
            super::sibling_endpoint(&endpoint, "uploads")
                .unwrap()
                .as_str(),
            "https://intar.dev/registry/v1/uploads"
        );
        assert_eq!(
            super::sibling_endpoint(&endpoint, "uploads/complete")
                .unwrap()
                .as_str(),
            "https://intar.dev/registry/v1/uploads/complete"
        );
    }

    #[test]
    fn rejects_publish_urls_without_publish_suffix() {
        let endpoint = url::Url::parse("https://intar.dev/registry/v1/other").unwrap();
        assert!(super::sibling_endpoint(&endpoint, "uploads").is_err());
    }

    #[test]
    fn reads_chunks_up_to_the_part_size() {
        let data = vec![7u8; 10];
        let mut reader = std::io::Cursor::new(data);
        assert_eq!(super::read_chunk(&mut reader, 4).unwrap().len(), 4);
        assert_eq!(super::read_chunk(&mut reader, 4).unwrap().len(), 4);
        assert_eq!(super::read_chunk(&mut reader, 4).unwrap().len(), 2);
        assert!(super::read_chunk(&mut reader, 4).unwrap().is_empty());
    }

    #[test]
    fn chunk_upload_gate_limits_parallel_uploads() {
        let gate = Arc::new(super::ChunkUploadGate::new(1));
        let first = gate.acquire();
        let (events_tx, events_rx) = mpsc::channel();
        let waiting_gate = Arc::clone(&gate);
        let waiter = std::thread::spawn(move || {
            events_tx.send("waiting").unwrap();
            let _second = waiting_gate.acquire();
            events_tx.send("acquired").unwrap();
        });

        assert_eq!(events_rx.recv().unwrap(), "waiting");
        assert!(events_rx.recv_timeout(Duration::from_millis(25)).is_err());
        drop(first);
        assert_eq!(
            events_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            "acquired"
        );
        waiter.join().unwrap();
    }
}
