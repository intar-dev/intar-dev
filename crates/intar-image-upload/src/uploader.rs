#![allow(clippy::missing_errors_doc)]

use std::path::{Path, PathBuf};

use intar_contracts::catalog::ScenarioManifestV1;
use reqwest::blocking::multipart::{Form, Part};

use crate::config::ImageUploadConfig;
use crate::error::{Error, Result};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PublishImageFile {
    pub vm_name: String,
    pub source_path: PathBuf,
    pub filename: String,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize)]
pub struct PublishReceipt {
    pub ok: bool,
    pub scenario_id: String,
    pub images: Vec<PublishedImage>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize)]
pub struct PublishedImage {
    pub image_key: String,
    pub image_sha256: String,
    pub object_key: String,
    pub bytes: u64,
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
        manifest: &ScenarioManifestV1,
        images: &[PublishImageFile],
    ) -> Result<PublishReceipt> {
        if images.is_empty() {
            return Err(Error::InvalidConfig("publish requires at least one image"));
        }

        let mut form = Form::new().text("manifest", serde_json::to_string(manifest)?);
        for image in images {
            let field_name = format!("image:{}", normalize_field_component(&image.vm_name)?);
            let part = Part::file(&image.source_path)
                .map_err(Error::Io)?
                .file_name(image.filename.clone())
                .mime_str("application/octet-stream")?;
            form = form.part(field_name, part);
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

fn normalize_field_component(value: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(Error::InvalidKey(String::from("<empty>")));
    }
    if !trimmed
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Err(Error::InvalidKey(value.to_owned()));
    }
    Ok(trimmed.to_owned())
}

fn normalize_filename(value: &str) -> Result<String> {
    let filename = value.trim();
    if filename.is_empty() || filename.contains('/') || filename.contains('\\') {
        return Err(Error::InvalidKey(value.to_owned()));
    }
    if !filename.ends_with(".qcow2") {
        return Err(Error::InvalidKey(value.to_owned()));
    }
    Ok(filename.to_owned())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::{PublishImageFile, normalize_filename};

    #[test]
    fn accepts_qcow2_publish_file() {
        let temp = tempfile::NamedTempFile::new().unwrap();
        let file = PublishImageFile::new("web", temp.path(), "broken-nginx-web-x86_64.qcow2")
            .expect("file should be valid");

        assert_eq!(file.vm_name, "web");
        assert_eq!(file.filename, "broken-nginx-web-x86_64.qcow2");
    }

    #[test]
    fn rejects_nested_publish_filename() {
        let error = normalize_filename("../image.qcow2").unwrap_err();
        assert!(error.to_string().contains("invalid upload key"));
    }
}
