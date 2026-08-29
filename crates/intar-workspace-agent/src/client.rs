use crate::config::AgentConfig;
use crate::model::{
    AgentReport, ArtifactGrantRequest, ArtifactUploadGrant, BootstrapRequest, BootstrapResponse,
    CONTRACT_VERSION, ExecutionIdentity, ReportResponse,
};
use crate::secrets::SecretString;
use futures_util::future::BoxFuture;
use intar_contracts::run_cli::{RunCliRequestV1, RunCliResponseV1};
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderValue};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;

const MAX_CONTROL_RESPONSE_BYTES: usize = 1024 * 1024;

#[derive(Deserialize)]
#[serde(untagged)]
enum ArtifactGrantOutcome {
    AlreadyUploaded {
        identity: ExecutionIdentity,
        artifact_id: String,
        already_uploaded: bool,
    },
    Grant(ArtifactUploadGrant),
}

pub trait ControlPlane: Send + Sync {
    fn bootstrap<'a>(
        &'a self,
        identity: &'a ExecutionIdentity,
        capability: &'a SecretString,
    ) -> BoxFuture<'a, Result<BootstrapResponse, ClientError>>;

    fn report<'a>(
        &'a self,
        credential: &'a SecretString,
        report: &'a AgentReport,
    ) -> BoxFuture<'a, Result<ReportResponse, ClientError>>;

    fn upload_artifact<'a>(
        &'a self,
        credential: &'a SecretString,
        identity: &'a ExecutionIdentity,
        kind: &'a str,
        path: &'a Path,
        max_bytes: u64,
    ) -> BoxFuture<'a, Result<String, ClientError>>;

    /// Forward one learner CLI action with the generation-scoped report
    /// credential. The credential remains in the privileged agent; callers
    /// supply only the safe, framed local request.
    fn run_cli<'a>(
        &'a self,
        credential: &'a SecretString,
        request: &'a RunCliRequestV1,
    ) -> BoxFuture<'a, Result<RunCliResponseV1, ClientError>>;
}

#[derive(Clone, Debug)]
pub struct HttpControlPlane {
    client: reqwest::Client,
    bootstrap_url: url::Url,
    reports_url: url::Url,
    artifact_grants_url: url::Url,
    run_cli_url: url::Url,
}

impl HttpControlPlane {
    pub fn new(config: &AgentConfig) -> Result<Self, ClientError> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(45))
            .user_agent(concat!("intar-workspace-agent/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(ClientError::Build)?;
        Ok(Self {
            client,
            bootstrap_url: config.endpoint("bootstrap").map_err(ClientError::Config)?,
            reports_url: config.endpoint("reports").map_err(ClientError::Config)?,
            artifact_grants_url: config
                .endpoint("artifacts/grants")
                .map_err(ClientError::Config)?,
            run_cli_url: config.endpoint("cli").map_err(ClientError::Config)?,
        })
    }

    pub fn http_client(&self) -> reqwest::Client {
        self.client.clone()
    }

    async fn decode_json<T: serde::de::DeserializeOwned>(
        response: reqwest::Response,
    ) -> Result<T, ClientError> {
        let response = response.error_for_status().map_err(ClientError::Request)?;
        if response.content_length().is_some_and(|size| {
            size > u64::try_from(MAX_CONTROL_RESPONSE_BYTES).unwrap_or(u64::MAX)
        }) {
            return Err(ClientError::ResponseTooLarge);
        }
        let bytes = response.bytes().await.map_err(ClientError::Request)?;
        if bytes.len() > MAX_CONTROL_RESPONSE_BYTES {
            return Err(ClientError::ResponseTooLarge);
        }
        serde_json::from_slice(&bytes).map_err(ClientError::Decode)
    }

    fn bearer(value: &SecretString) -> Result<HeaderValue, ClientError> {
        HeaderValue::from_str(&format!("Bearer {}", value.expose()))
            .map_err(|_| ClientError::InvalidCredential)
    }

    fn bootstrap_authorization(value: &SecretString) -> Result<HeaderValue, ClientError> {
        HeaderValue::from_str(&format!("Intar-Bootstrap {}", value.expose()))
            .map_err(|_| ClientError::InvalidCredential)
    }
}

impl ControlPlane for HttpControlPlane {
    fn bootstrap<'a>(
        &'a self,
        identity: &'a ExecutionIdentity,
        capability: &'a SecretString,
    ) -> BoxFuture<'a, Result<BootstrapResponse, ClientError>> {
        Box::pin(async move {
            let response = self
                .client
                .post(self.bootstrap_url.clone())
                .header(AUTHORIZATION, Self::bootstrap_authorization(capability)?)
                .json(&BootstrapRequest::new(identity.clone()))
                .send()
                .await
                .map_err(ClientError::Request)?;
            Self::decode_json(response).await
        })
    }

    fn report<'a>(
        &'a self,
        credential: &'a SecretString,
        report: &'a AgentReport,
    ) -> BoxFuture<'a, Result<ReportResponse, ClientError>> {
        Box::pin(async move {
            let response = self
                .client
                .post(self.reports_url.clone())
                .header(AUTHORIZATION, Self::bearer(credential)?)
                .json(report)
                .send()
                .await
                .map_err(ClientError::Request)?;
            Self::decode_json(response).await
        })
    }

    fn upload_artifact<'a>(
        &'a self,
        credential: &'a SecretString,
        identity: &'a ExecutionIdentity,
        kind: &'a str,
        path: &'a Path,
        max_bytes: u64,
    ) -> BoxFuture<'a, Result<String, ClientError>> {
        Box::pin(async move {
            if kind.is_empty()
                || kind.len() > 64
                || !kind
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            {
                return Err(ClientError::InvalidArtifactKind);
            }
            let metadata = tokio::fs::symlink_metadata(path).await.map_err(|source| {
                ClientError::ReadArtifact {
                    path: path.to_path_buf(),
                    source,
                }
            })?;
            if !metadata.file_type().is_file() {
                return Err(ClientError::InvalidArtifactFile);
            }
            if metadata.len() == 0 || metadata.len() > max_bytes {
                return Err(ClientError::ArtifactTooLarge {
                    actual: metadata.len(),
                    limit: max_bytes,
                });
            }
            let bytes =
                tokio::fs::read(path)
                    .await
                    .map_err(|source| ClientError::ReadArtifact {
                        path: path.to_path_buf(),
                        source,
                    })?;
            let size_bytes = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
            if size_bytes == 0 || size_bytes > max_bytes {
                return Err(ClientError::ArtifactTooLarge {
                    actual: size_bytes,
                    limit: max_bytes,
                });
            }
            let sha256 = base16ct::lower::encode_string(&Sha256::digest(&bytes));
            let request = ArtifactGrantRequest {
                contract_version: CONTRACT_VERSION,
                identity: identity.clone(),
                kind: kind.to_owned(),
                sha256: sha256.clone(),
                size_bytes,
            };
            let grant_response = self
                .client
                .post(self.artifact_grants_url.clone())
                .header(AUTHORIZATION, Self::bearer(credential)?)
                .json(&request)
                .send()
                .await
                .map_err(ClientError::Request)?;
            let outcome = Self::decode_json::<ArtifactGrantOutcome>(grant_response).await?;
            let grant = match outcome {
                ArtifactGrantOutcome::AlreadyUploaded {
                    identity: response_identity,
                    artifact_id,
                    already_uploaded,
                } => {
                    if !already_uploaded
                        || &response_identity != identity
                        || !valid_artifact_id(&artifact_id)
                    {
                        return Err(ClientError::InvalidGrant(
                            "idempotent artifact response is invalid".to_owned(),
                        ));
                    }
                    return Ok(artifact_id);
                }
                ArtifactGrantOutcome::Grant(grant) => grant,
            };
            grant
                .validate_for(identity, unix_time_ms())
                .map_err(ClientError::InvalidGrant)?;

            self.client
                .put(grant.signed_upload_url.expose())
                .header(CONTENT_TYPE, "application/octet-stream")
                .header("x-intar-artifact-sha256", &sha256)
                .body(bytes)
                .send()
                .await
                .map_err(ClientError::Request)?
                .error_for_status()
                .map_err(ClientError::Request)?;
            Ok(grant.artifact_id)
        })
    }

    fn run_cli<'a>(
        &'a self,
        credential: &'a SecretString,
        request: &'a RunCliRequestV1,
    ) -> BoxFuture<'a, Result<RunCliResponseV1, ClientError>> {
        Box::pin(async move {
            request
                .validate()
                .map_err(|error| ClientError::InvalidRunCliRequest(error.to_string()))?;
            let response = self
                .client
                .post(self.run_cli_url.clone())
                .header(AUTHORIZATION, Self::bearer(credential)?)
                .json(request)
                .send()
                .await
                .map_err(ClientError::Request)?;
            let response = Self::decode_json::<RunCliResponseV1>(response).await?;
            response
                .validate_for_action(&request.action)
                .map_err(|error| ClientError::InvalidRunCliResponse(error.to_string()))?;
            if response.request_id != request.request_id {
                return Err(ClientError::InvalidRunCliResponse(
                    "response request ID does not match request".to_owned(),
                ));
            }
            Ok(response)
        })
    }
}

fn valid_artifact_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn unix_time_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or_default()
}

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("failed to build control-plane HTTP client: {0}")]
    Build(reqwest::Error),
    #[error("invalid control-plane endpoint: {0}")]
    Config(crate::config::ConfigError),
    #[error("control-plane request failed: {0}")]
    Request(reqwest::Error),
    #[error("control-plane response exceeded the size limit")]
    ResponseTooLarge,
    #[error("failed to decode control-plane response: {0}")]
    Decode(serde_json::Error),
    #[error("credential cannot be represented as a safe HTTP header")]
    InvalidCredential,
    #[error("artifact kind is invalid")]
    InvalidArtifactKind,
    #[error("artifact must be a regular file, not a directory or symbolic link")]
    InvalidArtifactFile,
    #[error("failed to read artifact {path}: {source}")]
    ReadArtifact {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("artifact is {actual} bytes; limit is {limit}")]
    ArtifactTooLarge { actual: u64, limit: u64 },
    #[error("control plane returned an invalid artifact grant: {0}")]
    InvalidGrant(String),
    #[error("run CLI request is invalid: {0}")]
    InvalidRunCliRequest(String),
    #[error("control plane returned an invalid run CLI response: {0}")]
    InvalidRunCliResponse(String),
}

#[cfg(test)]
mod tests {
    use super::{ControlPlane, HttpControlPlane};
    use crate::model::{CONTRACT_VERSION, ExecutionIdentity};
    use crate::secrets::SecretString;
    use axum::extract::State;
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::{IntoResponse, Response};
    use axum::routing::post;
    use axum::{Json, Router};
    use intar_contracts::run_cli::{
        RUN_CLI_PROTOCOL_VERSION, RunCliActionV1, RunCliErrorCodeV1, RunCliRequestV1,
        RunCliResultV1,
    };
    use serde_json::{Value, json};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use url::Url;

    #[tokio::test]
    async fn bootstrap_exchange_uses_header_capability_and_replay_fails_closed() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test listener");
        let address = listener.local_addr().expect("listener address");
        let calls = Arc::new(AtomicUsize::new(0));
        let router = Router::new()
            .route("/bootstrap", post(bootstrap_handler))
            .with_state(calls);
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.expect("test server");
        });

        let endpoint = |path: &str| {
            Url::parse(&format!("http://{address}/{path}")).expect("test endpoint should be valid")
        };
        let client = HttpControlPlane {
            client: reqwest::Client::new(),
            bootstrap_url: endpoint("bootstrap"),
            reports_url: endpoint("reports"),
            artifact_grants_url: endpoint("artifacts/grants"),
            run_cli_url: endpoint("cli"),
        };
        let identity = ExecutionIdentity {
            execution_id: "exec-1".to_owned(),
            workspace_id: "workspace-1".to_owned(),
            generation: 3,
        };
        let capability = SecretString::new("one-use-capability");

        let response = client
            .bootstrap(&identity, &capability)
            .await
            .expect("first bootstrap succeeds");
        assert_eq!(response.identity, identity);
        assert!(client.bootstrap(&identity, &capability).await.is_err());
        server.abort();
    }

    #[tokio::test]
    async fn run_cli_uses_the_internal_report_bearer_without_serializing_it() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test listener");
        let address = listener.local_addr().expect("listener address");
        let router = Router::new().route("/cli", post(run_cli_handler));
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.expect("test server");
        });

        let endpoint = |path: &str| {
            Url::parse(&format!("http://{address}/{path}")).expect("test endpoint should be valid")
        };
        let client = HttpControlPlane {
            client: reqwest::Client::new(),
            bootstrap_url: endpoint("bootstrap"),
            reports_url: endpoint("reports"),
            artifact_grants_url: endpoint("artifacts/grants"),
            run_cli_url: endpoint("cli"),
        };
        let request = RunCliRequestV1 {
            protocol_version: RUN_CLI_PROTOCOL_VERSION,
            request_id: "request-1".to_owned(),
            action: RunCliActionV1::Status,
        };
        let credential = SecretString::new("generation-report-credential");

        let response = client
            .run_cli(&credential, &request)
            .await
            .expect("run CLI request succeeds");
        assert_eq!(response.request_id, request.request_id);
        let RunCliResultV1::Error { error } = response.result else {
            panic!("locked control-plane response must remain structured");
        };
        assert_eq!(error.code, RunCliErrorCodeV1::Locked);
        server.abort();
    }

    async fn bootstrap_handler(
        State(calls): State<Arc<AtomicUsize>>,
        headers: HeaderMap,
        Json(body): Json<Value>,
    ) -> Response {
        if calls.fetch_add(1, Ordering::SeqCst) != 0 {
            return StatusCode::CONFLICT.into_response();
        }
        if headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            != Some("Intar-Bootstrap one-use-capability")
            || body.pointer("/identity/generation").and_then(Value::as_u64) != Some(3)
            || body.get("contract_version").and_then(Value::as_u64)
                != Some(u64::from(CONTRACT_VERSION))
        {
            return StatusCode::BAD_REQUEST.into_response();
        }

        Json(json!({
            "contract_version": CONTRACT_VERSION,
            "identity": {
                "execution_id": "exec-1",
                "workspace_id": "workspace-1",
                "generation": 3
            },
            "report_credential": "generation-report-credential",
            "checkpoint": {
                "checkpoint_id": "00",
                "signed_url": "https://assets.intar.dev/checkpoints/00?signature=secret",
                "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "size_bytes": 100,
                "compression": "zstd",
                "signature_b64": base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    [0_u8; 64],
                ),
                "signing_key_id": "runtime-v1",
                "expires_at_unix_ms": 4102444800000_i64
            }
        }))
        .into_response()
    }

    async fn run_cli_handler(headers: HeaderMap, Json(body): Json<Value>) -> Response {
        let serialized = serde_json::to_string(&body).expect("serialize request body");
        if headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            != Some("Bearer generation-report-credential")
            || serialized.contains("generation-report-credential")
            || body.get("request_id").and_then(Value::as_str) != Some("request-1")
            || body
                .get("action")
                .and_then(Value::as_object)
                .and_then(|action| action.get("kind"))
                .and_then(Value::as_str)
                != Some("status")
        {
            return StatusCode::BAD_REQUEST.into_response();
        }
        Json(json!({
            "protocol_version": RUN_CLI_PROTOCOL_VERSION,
            "request_id": "request-1",
            "result": {
                "kind": "error",
                "error": {
                    "code": "locked",
                    "message": "Only the workshop facilitator can release the solution.",
                    "retryable": false
                }
            }
        }))
        .into_response()
    }
}
