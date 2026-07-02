#![allow(clippy::missing_errors_doc)]

use url::Url;

use crate::error::{Error, Result};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ImageUploadConfig {
    pub publish_url: String,
    pub token: String,
}

impl ImageUploadConfig {
    #[must_use]
    pub fn new(publish_url: impl Into<String>, token: impl Into<String>) -> Self {
        Self {
            publish_url: publish_url.into(),
            token: token.into(),
        }
    }

    pub fn validate(&self) -> Result<()> {
        let endpoint = self.endpoint()?;

        if endpoint.host_str().is_none_or(str::is_empty) {
            return Err(Error::InvalidConfig("publish url must include a host"));
        }

        if !matches!(endpoint.scheme(), "http" | "https") {
            return Err(Error::InvalidConfig("publish url must use http or https"));
        }

        if self.token.trim().is_empty() {
            return Err(Error::InvalidConfig("publish token must not be empty"));
        }

        Ok(())
    }

    pub(crate) fn endpoint(&self) -> Result<Url> {
        let trimmed = self.publish_url.trim();
        if trimmed.is_empty() {
            return Err(Error::InvalidConfig("publish url must not be empty"));
        }

        Ok(Url::parse(trimmed)?)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::ImageUploadConfig;

    #[test]
    fn accepts_http_publish_endpoint() {
        let config = ImageUploadConfig::new("https://intar.dev/registry/v1/publish", "secret");

        assert_eq!(
            config.endpoint().unwrap().as_str(),
            "https://intar.dev/registry/v1/publish"
        );
        config.validate().unwrap();
    }

    #[test]
    fn rejects_ssh_publish_endpoint() {
        let config = ImageUploadConfig::new("ssh://legacy.example/releases", "secret");

        let error = config.validate().unwrap_err();
        assert!(error.to_string().contains("http or https"));
    }
}
