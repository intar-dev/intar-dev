mod admin;
mod auth;
mod outbound;
mod runtime;
mod session_registry;
mod ssh;
mod store;
mod terminal_registry;
mod webssh;
mod workspace_app;

use std::sync::Arc;

use axum::{
    Json, Router, middleware,
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use http::StatusCode;
use serde_json::json;
use stargate_core::{
    AdminAuthSettings, Result, StargateError, TerminalTarget, TerminalTokenSettings,
};

use crate::outbound::WorkspaceAppTunnelPool;

pub use auth::AssertionValidator;
pub use runtime::{load_settings, run};
pub use session_registry::{SessionLease, SessionRegistry};
pub use ssh::run_public_ssh_server;
pub use store::{ActivateOutcome, GenerationDeleteOutcome, SqliteRouteStore, StageOutcome};
pub use terminal_registry::{
    TerminalRouteTargetRegistry, TerminalSocketClaim, TerminalSocketRegistry,
};

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
    pub workspace_app_base_domain: Option<Arc<str>>,
    pub workspace_app_bootstrap_ttl_seconds: u64,
    pub workspace_app_session_ttl_seconds: u64,
}

#[derive(Clone)]
pub struct GatewayState {
    pub store: SqliteRouteStore,
    pub sessions: SessionRegistry,
    // Terminal route updates replace authorization as well as connection
    // details. Keep the read, replacement, and revocation together so two
    // concurrent issuers cannot decide from different previous records.
    //
    // Contract: this mutex serializes the stage and activate read-modify-write
    // pair inside ONE gateway process, which is how the gateway is deployed.
    // Two processes sharing one database file are not supported: SQLite can
    // raise SQLITE_BUSY between the read and the write of a deferred
    // transaction. The busy timeout on the connection bounds that wait, and it
    // does not make the pair atomic across processes. A second process needs a
    // real multi-writer design, not this lock.
    pub(crate) terminal_route_mutation: Arc<tokio::sync::Mutex<()>>,
    // A pending browser route waits here for its attach, and one live browser
    // socket holds each route generation.
    pub(crate) terminal_route_targets: TerminalRouteTargetRegistry,
    pub(crate) terminal_sockets: TerminalSocketRegistry,
    pub(crate) workspace_app_tunnels: WorkspaceAppTunnelPool,
    pub admin_auth: AssertionValidator,
    pub public_web: PublicGatewayState,
}

impl GatewayState {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        store: SqliteRouteStore,
        admin_auth: AdminAuthSettings,
        web: &stargate_core::WebSettings,
        public_host_key: russh::keys::ssh_key::PublicKey,
        terminal_tokens: TerminalTokenSettings,
    ) -> Result<Self> {
        Ok(Self {
            store,
            sessions: SessionRegistry::default(),
            terminal_route_mutation: Arc::new(tokio::sync::Mutex::new(())),
            terminal_route_targets: TerminalRouteTargetRegistry::default(),
            terminal_sockets: TerminalSocketRegistry::default(),
            workspace_app_tunnels: WorkspaceAppTunnelPool::default(),
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
                workspace_app_base_domain: web
                    .workspace_app_base_domain
                    .as_deref()
                    .map(Arc::<str>::from),
                workspace_app_bootstrap_ttl_seconds: web.workspace_app_bootstrap_ttl_seconds,
                workspace_app_session_ttl_seconds: web.workspace_app_session_ttl_seconds,
            },
        })
    }

    /// Stage a target on a pending route. The call stores a validated target
    /// and returns its attachment identifier. Nothing becomes visible: the
    /// route is still not ready, no waiter wakes, and no socket dials. This is
    /// what keeps the guest untouched until the control plane activates.
    pub async fn stage_target(
        &self,
        route_username: &str,
        run_id: &str,
        vm_id: &str,
        user_id: &str,
        generation: &str,
        target: TerminalTarget,
    ) -> Result<StageOutcome> {
        let _terminal_route_mutation = self.terminal_route_mutation.lock().await;
        self.store
            .stage_route_target(route_username, run_id, vm_id, user_id, generation, target)
            .await
    }

    /// Activate the staged attachment that the control plane names. Only this
    /// call makes the target ready, and only then does a waiter wake.
    pub async fn activate_staged_target(
        &self,
        route_username: &str,
        run_id: &str,
        vm_id: &str,
        user_id: &str,
        generation: &str,
        attachment_id: &str,
    ) -> Result<ActivateOutcome> {
        let _terminal_route_mutation = self.terminal_route_mutation.lock().await;
        let outcome = self
            .store
            .activate_route_target(
                route_username,
                run_id,
                vm_id,
                user_id,
                generation,
                attachment_id,
            )
            .await?;
        if matches!(
            outcome,
            ActivateOutcome::Activated | ActivateOutcome::AlreadyActive
        ) {
            self.terminal_route_targets.notify(route_username);
        }
        Ok(outcome)
    }
}

pub fn build_admin_router(state: GatewayState) -> Router {
    Router::new()
        .route("/healthz", get(admin::healthz))
        .route("/v1/terminal-sessions", post(admin::issue_terminal_session))
        .route(
            "/v1/terminal-sessions/{route_username}/target",
            post(admin::stage_terminal_target),
        )
        .route(
            "/v1/terminal-sessions/{route_username}/activate",
            post(admin::activate_terminal_target),
        )
        .route(
            "/v1/workspace-app-sessions",
            post(admin::issue_workspace_app_session),
        )
        .route("/v1/routes/{username}", delete(admin::delete_route))
        .route(
            "/v1/workspace-app-routes/{route_id}",
            delete(admin::delete_workspace_app_route),
        )
        .with_state(state)
}

pub fn build_public_router(state: GatewayState) -> Router {
    let mut router = Router::new()
        .route("/healthz", get(admin::healthz))
        .route(TERMINAL_WS_PATH, get(webssh::terminal_websocket));
    // Path multiplexing is intentionally a local-HTTP development fallback.
    // HTTPS installations must use isolated first-level application origins.
    if state.public_web.workspace_app_base_domain.is_none()
        && state.public_web.public_base_url.scheme() == "http"
    {
        router = router
            .route(
                "/v1/workspace-apps/{route_id}",
                axum::routing::any(workspace_app::proxy_workspace_app_root),
            )
            .route(
                "/v1/workspace-apps/{route_id}/",
                axum::routing::any(workspace_app::proxy_workspace_app_root),
            )
            .route(
                "/v1/workspace-apps/{route_id}/{*path}",
                axum::routing::any(workspace_app::proxy_workspace_app_path),
            );
    }
    router
        .fallback(|| async { StatusCode::NOT_FOUND })
        .with_state(state.clone())
        .layer(middleware::from_fn_with_state(
            state,
            workspace_app::dispatch_public_request,
        ))
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
            StargateError::RouteNotFound(_) => StatusCode::NOT_FOUND,
            StargateError::WorkspaceAppRouteAlreadyExists(_)
            | StargateError::TerminalRouteConflict(_)
            | StargateError::TerminalSocketAlreadyOpen => StatusCode::CONFLICT,
            StargateError::Unauthorized => StatusCode::UNAUTHORIZED,
            StargateError::Database(_)
            | StargateError::Internal(_)
            | StargateError::TerminalTargetTimeout => StatusCode::INTERNAL_SERVER_ERROR,
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
        StargateError::RouteNotFound(_) => "route not found",
        StargateError::WorkspaceAppRouteAlreadyExists(_) => {
            "workspace application route already exists"
        }
        StargateError::TerminalRouteConflict(_) => "terminal route target conflict",
        StargateError::TerminalSocketAlreadyOpen => "terminal socket already open",
        StargateError::Unauthorized => "unauthorized",
        StargateError::Database(_)
        | StargateError::Internal(_)
        | StargateError::TerminalTargetTimeout => "internal server error",
        StargateError::Io(_)
        | StargateError::SshKey(_)
        | StargateError::PublicKey(_)
        | StargateError::Utf8(_)
        | StargateError::Json(_) => "bad request",
    }
}
