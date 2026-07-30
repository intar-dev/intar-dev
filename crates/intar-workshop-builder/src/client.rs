use std::sync::RwLock;
use std::time::Duration;

use anyhow::{Context as _, Result, bail};
use intar_image_upload::{ImageUploadConfig, ImageUploader, PublishArtifactFile, UploadImageBlob};
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use url::Url;

use crate::config::{BuilderExecutionMode, RegistryConfig};
use crate::contracts::{WorkshopPublicationClaim, WorkshopPublicationResult};

const AGENT_BOOTSTRAP_PATH: &str = "/api/agent/bootstrap";

#[allow(async_fn_in_trait)]
pub trait PublicationRegistry {
    async fn refresh_auth(&self) -> Result<()>;

    async fn claim_next(&self) -> Result<Option<WorkshopPublicationClaim>>;

    async fn download_bundle(&self, bundle_url: &str, max_bytes: u64) -> Result<Vec<u8>>;

    async fn post_result(
        &self,
        publication_id: &str,
        result: &WorkshopPublicationResult,
    ) -> Result<()>;
}

pub trait WorkshopBlobPublisher {
    fn upload_image(&self, image: &UploadImageBlob) -> Result<()>;

    fn upload_artifact(&self, artifact: &PublishArtifactFile) -> Result<()>;
}

pub struct WorkshopRegistryClient {
    base_url: Url,
    host_id: String,
    bootstrap_token: String,
    execution_mode: BuilderExecutionMode,
    client: Client,
}

pub struct AuthenticatedWorkshopRegistry {
    base_url: Url,
    host_id: String,
    bootstrap_token: String,
    access_token: RwLock<String>,
    execution_mode: BuilderExecutionMode,
    client: Client,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapRequest<'a> {
    host_id: &'a str,
    bootstrap_token: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapResponse {
    access_token: String,
}

impl WorkshopRegistryClient {
    pub fn new(config: &RegistryConfig) -> Result<Self> {
        Self::new_with_execution_mode(config, BuilderExecutionMode::AgentKvm)
    }

    pub fn new_with_execution_mode(
        config: &RegistryConfig,
        execution_mode: BuilderExecutionMode,
    ) -> Result<Self> {
        let base_url = Url::parse(config.base_url.trim()).context("invalid registry base URL")?;
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(config.http_timeout_seconds.max(1)))
            .user_agent(concat!(
                "intar-workshop-builder/",
                env!("CARGO_PKG_VERSION")
            ))
            .build()
            .context("failed to create workshop registry HTTP client")?;
        Ok(Self {
            base_url,
            host_id: config.host_id.trim().to_owned(),
            bootstrap_token: config.bootstrap_token.trim().to_owned(),
            execution_mode,
            client,
        })
    }

    pub async fn authenticate(&self) -> Result<AuthenticatedWorkshopRegistry> {
        let url = endpoint(&self.base_url, AGENT_BOOTSTRAP_PATH)?;
        let response = self
            .client
            .post(url.clone())
            .json(&BootstrapRequest {
                host_id: &self.host_id,
                bootstrap_token: &self.bootstrap_token,
            })
            .send()
            .await
            .with_context(|| format!("failed to authenticate workshop builder at {url}"))?;
        let status = response.status();
        let body = response
            .bytes()
            .await
            .context("failed to read builder authentication response")?;
        if !status.is_success() {
            bail!(
                "builder authentication failed with HTTP {status}: {}",
                body_excerpt(&body)
            );
        }
        let bootstrap: BootstrapResponse = serde_json::from_slice(&body)
            .context("builder authentication response is invalid JSON")?;
        if bootstrap.access_token.trim().is_empty() {
            bail!("builder authentication returned an empty access token");
        }
        Ok(AuthenticatedWorkshopRegistry {
            base_url: self.base_url.clone(),
            host_id: self.host_id.clone(),
            bootstrap_token: self.bootstrap_token.clone(),
            access_token: RwLock::new(bootstrap.access_token),
            execution_mode: self.execution_mode,
            client: self.client.clone(),
        })
    }
}

impl PublicationRegistry for AuthenticatedWorkshopRegistry {
    async fn refresh_auth(&self) -> Result<()> {
        let url = endpoint(&self.base_url, AGENT_BOOTSTRAP_PATH)?;
        let response = self
            .client
            .post(url.clone())
            .json(&BootstrapRequest {
                host_id: &self.host_id,
                bootstrap_token: &self.bootstrap_token,
            })
            .send()
            .await
            .with_context(|| format!("failed to refresh workshop builder auth at {url}"))?;
        let status = response.status();
        let body = response
            .bytes()
            .await
            .context("failed to read builder auth refresh response")?;
        if !status.is_success() {
            bail!(
                "builder auth refresh failed with HTTP {status}: {}",
                body_excerpt(&body)
            );
        }
        let bootstrap: BootstrapResponse = serde_json::from_slice(&body)
            .context("builder auth refresh response is invalid JSON")?;
        if bootstrap.access_token.trim().is_empty() {
            bail!("builder auth refresh returned an empty access token");
        }
        *self
            .access_token
            .write()
            .map_err(|_| anyhow::anyhow!("builder access-token lock is poisoned"))? =
            bootstrap.access_token;
        Ok(())
    }

    async fn claim_next(&self) -> Result<Option<WorkshopPublicationClaim>> {
        let url = publication_claim_endpoint(&self.base_url, self.execution_mode)?;
        let response = self
            .client
            .get(url.clone())
            .bearer_auth(self.access_token()?)
            .send()
            .await
            .with_context(|| format!("failed to claim workshop publication from {url}"))?;
        if response.status() == StatusCode::NO_CONTENT {
            return Ok(None);
        }
        let status = response.status();
        let body = response
            .bytes()
            .await
            .context("failed to read workshop publication claim")?;
        if !status.is_success() {
            bail!(
                "workshop publication claim failed with HTTP {status}: {}",
                body_excerpt(&body)
            );
        }
        let claim =
            serde_json::from_slice(&body).context("workshop publication claim is invalid JSON")?;
        Ok(Some(claim))
    }

    async fn download_bundle(&self, bundle_url: &str, max_bytes: u64) -> Result<Vec<u8>> {
        let url = self
            .base_url
            .join(bundle_url)
            .with_context(|| format!("invalid claimed bundle URL '{bundle_url}'"))?;
        if !same_origin(&self.base_url, &url) {
            bail!("refusing to send builder credentials to a cross-origin bundle URL");
        }
        let response = self
            .client
            .get(url.clone())
            .bearer_auth(self.access_token()?)
            .send()
            .await
            .with_context(|| format!("failed to download workshop bundle from {url}"))?;
        let status = response.status();
        if let Some(length) = response.content_length()
            && length > max_bytes
        {
            bail!("workshop bundle exceeds the {max_bytes} byte download limit");
        }
        let body = response
            .bytes()
            .await
            .context("failed to read workshop bundle response")?;
        if !status.is_success() {
            bail!(
                "workshop bundle download failed with HTTP {status}: {}",
                body_excerpt(&body)
            );
        }
        let length = u64::try_from(body.len()).context("bundle response length overflow")?;
        if length == 0 || length > max_bytes {
            bail!("workshop bundle is empty or exceeds the {max_bytes} byte download limit");
        }
        Ok(body.to_vec())
    }

    async fn post_result(
        &self,
        publication_id: &str,
        result: &WorkshopPublicationResult,
    ) -> Result<()> {
        let encoded_id: String =
            url::form_urlencoded::byte_serialize(publication_id.as_bytes()).collect();
        let url = endpoint(
            &self.base_url,
            &format!("/agent/registry/workshop-publications/{encoded_id}/result"),
        )?;
        let response = self
            .client
            .post(url.clone())
            .bearer_auth(self.access_token()?)
            .json(result)
            .send()
            .await
            .with_context(|| format!("failed to report workshop publication result to {url}"))?;
        let status = response.status();
        let body = response
            .bytes()
            .await
            .context("failed to read workshop publication result response")?;
        if !status.is_success() {
            bail!(
                "workshop publication result failed with HTTP {status}: {}",
                body_excerpt(&body)
            );
        }
        Ok(())
    }
}

fn publication_claim_endpoint(base_url: &Url, execution_mode: BuilderExecutionMode) -> Result<Url> {
    let mut url = endpoint(base_url, "/agent/registry/workshop-publications/next")?;
    if execution_mode == BuilderExecutionMode::DirectProviderOnly {
        url.query_pairs_mut()
            .append_pair("execution_mode", "direct_provider_only");
    }
    Ok(url)
}

impl WorkshopBlobPublisher for AuthenticatedWorkshopRegistry {
    fn upload_image(&self, image: &UploadImageBlob) -> Result<()> {
        self.uploader()?
            .upload_image_blob(image)
            .map(|_| ())
            .map_err(anyhow::Error::from)
    }

    fn upload_artifact(&self, artifact: &PublishArtifactFile) -> Result<()> {
        self.uploader()?
            .upload_artifact_blob(artifact)
            .map(|_| ())
            .map_err(anyhow::Error::from)
    }
}

impl AuthenticatedWorkshopRegistry {
    fn access_token(&self) -> Result<String> {
        self.access_token
            .read()
            .map(|token| token.clone())
            .map_err(|_| anyhow::anyhow!("builder access-token lock is poisoned"))
    }

    fn uploader(&self) -> Result<ImageUploader> {
        let publish_url = endpoint(&self.base_url, "/registry/v1/publish")?;
        ImageUploader::new(ImageUploadConfig::new(
            publish_url.to_string(),
            self.access_token()?,
        ))
        .map_err(anyhow::Error::from)
    }
}

fn endpoint(base_url: &Url, path: &str) -> Result<Url> {
    base_url
        .join(path)
        .with_context(|| format!("failed to resolve registry endpoint '{path}'"))
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

fn body_excerpt(body: &[u8]) -> String {
    String::from_utf8_lossy(&body[..body.len().min(4_096)]).into_owned()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    use super::{
        AGENT_BOOTSTRAP_PATH, WorkshopRegistryClient, endpoint, publication_claim_endpoint,
        same_origin,
    };
    use crate::config::{BuilderExecutionMode, RegistryConfig};

    #[test]
    fn endpoints_are_root_relative() {
        let base = url::Url::parse("https://intar.dev/nested/").unwrap();
        assert_eq!(
            endpoint(&base, "/agent/registry/workshop-publications/next")
                .unwrap()
                .as_str(),
            "https://intar.dev/agent/registry/workshop-publications/next"
        );
        assert_eq!(
            publication_claim_endpoint(&base, BuilderExecutionMode::AgentKvm)
                .unwrap()
                .as_str(),
            "https://intar.dev/agent/registry/workshop-publications/next"
        );
        assert_eq!(
            publication_claim_endpoint(&base, BuilderExecutionMode::DirectProviderOnly)
                .unwrap()
                .as_str(),
            "https://intar.dev/agent/registry/workshop-publications/next?execution_mode=direct_provider_only"
        );
    }

    #[tokio::test]
    async fn authentication_uses_the_canonical_agent_bootstrap_endpoint() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            loop {
                let mut chunk = [0_u8; 1_024];
                let count = stream.read(&mut chunk).await.unwrap();
                assert!(count > 0, "client closed before sending request headers");
                request.extend_from_slice(&chunk[..count]);
                assert!(request.len() <= 16 * 1_024, "request headers are too large");
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let request = String::from_utf8(request).unwrap();
            assert_eq!(
                request.lines().next(),
                Some("POST /api/agent/bootstrap HTTP/1.1")
            );
            let body = r#"{"accessToken":"test-access-token"}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });

        let client = WorkshopRegistryClient::new(&RegistryConfig {
            base_url: format!("http://{address}/nested/"),
            host_id: "builder-01".to_owned(),
            bootstrap_token: "bootstrap-token".to_owned(),
            http_timeout_seconds: 5,
        })
        .unwrap();
        let authenticated = client.authenticate().await.unwrap();
        assert_eq!(authenticated.access_token().unwrap(), "test-access-token");
        server.await.unwrap();
        assert_eq!(AGENT_BOOTSTRAP_PATH, "/api/agent/bootstrap");
    }

    #[test]
    fn bundle_credentials_are_same_origin_only() {
        let base = url::Url::parse("https://intar.dev").unwrap();
        assert!(same_origin(
            &base,
            &url::Url::parse("https://intar.dev/a").unwrap()
        ));
        assert!(!same_origin(
            &base,
            &url::Url::parse("https://evil.example/a").unwrap()
        ));
    }
}
