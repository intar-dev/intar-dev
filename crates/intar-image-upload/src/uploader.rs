#![allow(clippy::missing_errors_doc)]

use std::io::Read as _;
use std::path::{Path, PathBuf};

use intar_contracts::catalog::ScenarioManifestV2;
use reqwest::blocking::multipart::Form;

use crate::config::ImageUploadConfig;
use crate::error::{Error, Result};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PublishImageFile {
    pub vm_name: String,
    pub source_path: PathBuf,
    pub filename: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PublishArtifactFile {
    pub sha256: String,
    pub source_path: PathBuf,
    pub filename: String,
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
    pub image_sha256: String,
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

    #[must_use]
    pub fn config(&self) -> &ImageUploadConfig {
        &self.config
    }

    pub fn publish_manifest(
        &self,
        manifest: &ScenarioManifestV2,
        images: &[PublishImageFile],
    ) -> Result<PublishReceipt> {
        self.publish_manifest_with_artifacts(manifest, images, &[])
    }

    /// Publish a scenario manifest. Image and boot artifact payloads are
    /// uploaded ahead of the manifest as chunked multipart uploads: the
    /// registry sits behind Cloudflare, whose per-request body limit is far
    /// below typical image sizes, so a single multipart form with inline
    /// payloads is rejected with 413.
    pub fn publish_manifest_with_artifacts(
        &self,
        manifest: &ScenarioManifestV2,
        images: &[PublishImageFile],
        artifacts: &[PublishArtifactFile],
    ) -> Result<PublishReceipt> {
        if images.is_empty() {
            return Err(Error::InvalidConfig("publish requires at least one image"));
        }

        for image in images {
            let create_body = image_upload_body(manifest, image)?;
            self.upload_blob(&create_body, &image.source_path)?;
        }
        for artifact in artifacts {
            let sha256 = normalize_sha256(&artifact.sha256)?;
            let create_body = serde_json::json!({
                "kind": "artifact",
                "sha256": sha256,
            });
            self.upload_blob(&create_body, &artifact.source_path)?;
        }

        let form = Form::new().text("manifest", serde_json::to_string(manifest)?);
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

/// R2 multipart parts must share one size (only the final part may be
/// smaller); 64 MiB stays comfortably under Cloudflare request body limits.
const UPLOAD_PART_BYTES: u64 = 64 * 1024 * 1024;

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

fn image_upload_body(
    manifest: &ScenarioManifestV2,
    image: &PublishImageFile,
) -> Result<serde_json::Value> {
    let vm = manifest
        .vms
        .iter()
        .find(|vm| vm.name.trim() == image.vm_name.trim())
        .ok_or(Error::InvalidConfig("manifest has no vm for publish image"))?;
    let sha256 = normalize_sha256(&vm.image_sha256)?;
    let image_key = image
        .filename
        .strip_suffix(".raw.zst")
        .ok_or(Error::InvalidConfig("publish image filename is invalid"))?;
    Ok(serde_json::json!({
        "kind": "image",
        "sha256": sha256,
        "image_key": image_key,
        "scenario_id": manifest.scenario_id.trim(),
        "vm_name": vm.name.trim(),
    }))
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

impl PublishImageFile {
    pub fn new(
        vm_name: impl Into<String>,
        source_path: impl AsRef<Path>,
        filename: impl Into<String>,
    ) -> Result<Self> {
        let source_path = source_path.as_ref();
        if !source_path.is_file() {
            return Err(Error::InvalidPath(source_path.display().to_string()));
        }

        Ok(Self {
            vm_name: vm_name.into(),
            source_path: source_path.to_path_buf(),
            filename: normalize_filename(&filename.into())?,
        })
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
            filename: format!("{sha256}.artifact"),
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

fn normalize_filename(value: &str) -> Result<String> {
    let filename = value.trim();
    if filename.is_empty() || filename.contains('/') || filename.contains('\\') {
        return Err(Error::InvalidKey(value.to_owned()));
    }
    if !filename.ends_with(".raw.zst") {
        return Err(Error::InvalidKey(value.to_owned()));
    }
    Ok(filename.to_owned())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::{PublishArtifactFile, PublishImageFile, normalize_filename, normalize_sha256};

    #[test]
    fn accepts_raw_zstd_publish_file() {
        let temp = tempfile::NamedTempFile::new().unwrap();
        let file = PublishImageFile::new("web", temp.path(), "broken-nginx-web-x86_64.raw.zst")
            .expect("file should be valid");

        assert_eq!(file.vm_name, "web");
        assert_eq!(file.filename, "broken-nginx-web-x86_64.raw.zst");
    }

    #[test]
    fn rejects_nested_publish_filename() {
        let error = normalize_filename("../image.raw.zst").unwrap_err();
        assert!(error.to_string().contains("invalid upload key"));
    }

    #[test]
    fn accepts_boot_artifact_file() {
        let temp = tempfile::NamedTempFile::new().unwrap();
        let sha256 = "a".repeat(64);
        let file = PublishArtifactFile::new(temp.path(), &sha256).expect("file should be valid");

        assert_eq!(file.sha256, sha256);
        assert_eq!(file.filename, format!("{}.artifact", "a".repeat(64)));
    }

    #[test]
    fn normalizes_sha256() {
        assert_eq!(normalize_sha256(&"A".repeat(64)).unwrap(), "a".repeat(64));
        assert!(normalize_sha256("not-a-sha").is_err());
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
