mod admin;
mod auth;
mod outbound;
mod session_registry;
mod ssh;
mod webssh;

use std::{path::PathBuf, sync::Arc};

use axum::{
    Json, Router,
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use http::StatusCode;
use serde_json::json;
use stargate_core::{AdminAuthSettings, Result, StargateError, TerminalTokenSettings};
use stargate_store_sqlite::SqliteRouteStore;

pub use auth::AssertionValidator;
pub use session_registry::{SessionLease, SessionRegistry};
pub use ssh::run_public_ssh_server;

const TERMINAL_WS_PATH: &str = "/v1/terminal/ws";

#[derive(Clone)]
pub struct PublicGatewayState {
    pub public_base_url: url::Url,
    pub public_ssh_host: Arc<str>,
    pub public_ssh_port: u16,
    pub public_ssh_host_key_openssh: Arc<str>,
    pub public_ssh_host_key_fingerprint_sha256: Arc<str>,
    pub allowed_origins: Arc<[String]>,
    pub terminal_token_issuer: Arc<str>,
    pub terminal_token_audience: Arc<str>,
    pub terminal_token_secret: Arc<str>,
}

#[derive(Clone)]
pub struct GatewayState {
    pub store: SqliteRouteStore,
    pub sessions: SessionRegistry,
    pub admin_auth: AssertionValidator,
    pub public_web: PublicGatewayState,
    pub ssh_binary: PathBuf,
    pub ssh_keyscan_binary: PathBuf,
    pub target_ssh_key_path: PathBuf,
}

impl GatewayState {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        store: SqliteRouteStore,
        admin_auth: AdminAuthSettings,
        web: &stargate_core::WebSettings,
        public_host_key: russh::keys::ssh_key::PublicKey,
        terminal_tokens: TerminalTokenSettings,
        ssh_binary: PathBuf,
        ssh_keyscan_binary: PathBuf,
        target_ssh_key_path: PathBuf,
    ) -> Result<Self> {
        Ok(Self {
            store,
            sessions: SessionRegistry::default(),
            admin_auth: AssertionValidator::new(admin_auth)?,
            public_web: PublicGatewayState {
                public_base_url: web.public_base_url.clone(),
                public_ssh_host: web.public_ssh_host.clone().into(),
                public_ssh_port: web.public_ssh_port,
                public_ssh_host_key_openssh: public_host_key.to_openssh()?.into(),
                public_ssh_host_key_fingerprint_sha256: format!(
                    "{}",
                    public_host_key.fingerprint(russh::keys::ssh_key::HashAlg::Sha256)
                )
                .into(),
                allowed_origins: web.allowed_origins.clone().into(),
                terminal_token_issuer: terminal_tokens.issuer.into(),
                terminal_token_audience: terminal_tokens.audience.into(),
                terminal_token_secret: terminal_tokens.hs256_secret.into(),
            },
            ssh_binary,
            ssh_keyscan_binary,
            target_ssh_key_path,
        })
    }
}

pub fn build_admin_router(state: GatewayState) -> Router {
    Router::new()
        .route("/healthz", get(admin::healthz))
        .route("/v1/terminal-sessions", post(admin::issue_terminal_session))
        .route("/v1/routes/{username}", delete(admin::delete_route))
        .with_state(state)
}

pub fn build_public_router(state: GatewayState) -> Router {
    Router::new()
        .route("/healthz", get(admin::healthz))
        .route(TERMINAL_WS_PATH, get(webssh::terminal_websocket))
        .with_state(state)
}

#[derive(Debug)]
pub struct GatewayHttpError(pub StargateError);

impl From<StargateError> for GatewayHttpError {
    fn from(value: StargateError) -> Self {
        Self(value)
    }
}

impl From<anyhow::Error> for GatewayHttpError {
    fn from(value: anyhow::Error) -> Self {
        Self(StargateError::Internal(value.to_string()))
    }
}

impl IntoResponse for GatewayHttpError {
    fn into_response(self) -> Response {
        let status = match &self.0 {
            StargateError::Validation(_) => StatusCode::UNPROCESSABLE_ENTITY,
            StargateError::RouteAlreadyExists(_) => StatusCode::CONFLICT,
            StargateError::RouteNotFound(_) => StatusCode::NOT_FOUND,
            StargateError::Unauthorized => StatusCode::UNAUTHORIZED,
            StargateError::Database(_) | StargateError::Internal(_) => {
                StatusCode::INTERNAL_SERVER_ERROR
            }
            StargateError::Io(_)
            | StargateError::SshKey(_)
            | StargateError::PublicKey(_)
            | StargateError::Utf8(_)
            | StargateError::Json(_) => StatusCode::BAD_REQUEST,
        };
        if matches!(
            &self.0,
            StargateError::Database(_)
                | StargateError::Internal(_)
                | StargateError::Io(_)
                | StargateError::SshKey(_)
                | StargateError::PublicKey(_)
                | StargateError::Utf8(_)
                | StargateError::Json(_)
        ) {
            tracing::warn!(error = %self.0, "request failed");
        }
        let body = Json(json!({ "error": public_error_message(&self.0) }));
        (status, body).into_response()
    }
}

pub(crate) fn terminal_websocket_path() -> &'static str {
    TERMINAL_WS_PATH
}

fn public_error_message(error: &StargateError) -> &'static str {
    match error {
        StargateError::Validation(_) => "validation error",
        StargateError::RouteAlreadyExists(_) => "route already exists",
        StargateError::RouteNotFound(_) => "route not found",
        StargateError::Unauthorized => "unauthorized",
        StargateError::Database(_) | StargateError::Internal(_) => "internal server error",
        StargateError::Io(_)
        | StargateError::SshKey(_)
        | StargateError::PublicKey(_)
        | StargateError::Utf8(_)
        | StargateError::Json(_) => "bad request",
    }
}
