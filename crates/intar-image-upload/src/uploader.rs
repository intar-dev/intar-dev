#![allow(clippy::missing_errors_doc)]

use std::collections::BTreeMap;
use std::io::Read as _;
use std::path::{Path, PathBuf};

use intar_contracts::catalog::{
    ImageArchitecture, ImageChunkManifestV1, ImageChunkV1, ScenarioManifestV4,
};
use reqwest::blocking::multipart::Form;
use sha2::{Digest as _, Sha256};

use crate::config::ImageUploadConfig;
use crate::error::{Error, Result};

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
        manifest: &ScenarioManifestV4,
        images: &[PublishChunkedImage],
        artifacts: &[PublishArtifactFile],
    ) -> Result<PublishReceipt> {
        self.publish_manifest_with_optional_identity(manifest, images, artifacts, None)
    }

    pub fn publish_build_manifest_with_artifacts(
        &self,
        manifest: &ScenarioManifestV4,
        images: &[PublishChunkedImage],
        artifacts: &[PublishArtifactFile],
        identity: &PublishBuildIdentity,
    ) -> Result<PublishReceipt> {
        validate_build_identity(identity)?;
        self.publish_manifest_with_optional_identity(manifest, images, artifacts, Some(identity))
    }

    fn publish_manifest_with_optional_identity(
        &self,
        manifest: &ScenarioManifestV4,
        images: &[PublishChunkedImage],
        artifacts: &[PublishArtifactFile],
        identity: Option<&PublishBuildIdentity>,
    ) -> Result<PublishReceipt> {
        if images.is_empty() {
            return Err(Error::InvalidConfig("publish requires at least one image"));
        }

        for image in images {
            validate_chunked_image(manifest, image)?;
            self.upload_chunked_image(image)?;
        }
        for artifact in artifacts {
            let sha256 = normalize_sha256(&artifact.sha256)?;
            let create_body = serde_json::json!({
                "kind": "artifact",
                "sha256": sha256,
            });
            self.upload_blob(&create_body, &artifact.source_path)?;
        }

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
            .multipart(form)
            .send()?;
        let status = response.status();
        let body = response.text()?;
        if !status.is_success() {
            return Err(Error::HttpStatus { status, body });
        }

        Ok(serde_json::from_str(&body)?)
    }

    fn upload_chunked_image(&self, image: &PublishChunkedImage) -> Result<()> {
        let lookups = image
            .chunks
            .iter()
            .map(|chunk| ImageChunkLookup {
                raw_sha256: chunk.raw_sha256.clone(),
                raw_size_bytes: chunk.raw_size_bytes,
            })
            .collect::<Vec<_>>();
        let existing = self.find_existing_image_chunks(&lookups)?;

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
                    .map(|chunk| scope.spawn(|| self.upload_image_chunk(chunk)))
                    .collect::<Vec<_>>();
                for handle in handles {
                    handle.join().map_err(|_| {
                        Error::InvalidConfig("image chunk uploader thread panicked")
                    })??;
                }
                Ok::<(), Error>(())
            })?;
        }

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
            .body(manifest_bytes)
            .send()?;
        require_success(response)?;
        Ok(())
    }

    pub fn find_existing_image_chunks(
        &self,
        chunks: &[ImageChunkLookup],
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

    fn upload_image_chunk(&self, chunk: &PublishImageChunkFile) -> Result<()> {
        let mut url = sibling_endpoint(&self.endpoint, "image-chunks")?;
        url.path_segments_mut()
            .map_err(|()| Error::InvalidConfig("publish url cannot be a base URL"))?
            .push(&chunk.raw_sha256);
        let source_path = chunk.source_path.as_ref().ok_or(Error::InvalidConfig(
            "missing image chunk has no local payload",
        ))?;
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
            .body(body)
            .send()?;
        require_success(response)
    }

    fn upload_blob(&self, create_body: &serde_json::Value, source_path: &Path) -> Result<()> {
        let uploads_url = sibling_endpoint(&self.endpoint, "uploads")?;
        let create: UploadCreateResponse = self.post_json(uploads_url.clone(), create_body)?;
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
        )?;
        Ok(())
    }

    fn post_json<T: serde::de::DeserializeOwned>(
        &self,
        url: url::Url,
        body: &serde_json::Value,
    ) -> Result<T> {
        let response = self
            .client
            .post(url)
            .bearer_auth(self.config.token.trim())
            .json(body)
            .send()?;
        let status = response.status();
        let text = response.text()?;
        if !status.is_success() {
            return Err(Error::HttpStatus { status, body: text });
        }
        Ok(serde_json::from_str(&text)?)
    }
}

fn validate_chunked_image(
    scenario_manifest: &ScenarioManifestV4,
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
const CHUNK_EXISTS_BATCH_SIZE: usize = 512;
const CHUNK_UPLOAD_CONCURRENCY: usize = 8;

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
}
