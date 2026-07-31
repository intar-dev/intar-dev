use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};
use serde_json::json;
use stargate_core::{
    IssueTerminalSessionRequest, IssueTerminalSessionResponse, IssueWorkspaceAppSessionRequest,
    IssueWorkspaceAppSessionResponse, NativeTerminalAuthMode, NativeTerminalSession, StargateError,
    TerminalSessionMode, validate_terminal_session_request, validate_workspace_app_session_request,
};

use crate::{GatewayHttpError, GatewayState, webssh};

pub async fn healthz(
    State(state): State<GatewayState>,
) -> Result<Json<serde_json::Value>, GatewayHttpError> {
    state.store.healthcheck().await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn issue_terminal_session(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    Json(request): Json<IssueTerminalSessionRequest>,
) -> Result<Json<IssueTerminalSessionResponse>, GatewayHttpError> {
    state.admin_auth.validate_headers(&headers).await?;
    let (route, mode) = validate_terminal_session_request(request)?;

    let response = match mode {
        TerminalSessionMode::Browser => {
            let stored = state.store.upsert_route(route).await?;
            let websocket_url = webssh::build_terminal_websocket_url(&state, &stored)?;
            IssueTerminalSessionResponse {
                route_username: stored.route_username,
                expires_at: stored.expires_at.unix_timestamp(),
                browser: Some(stargate_core::BrowserTerminalSession { websocket_url }),
                native: None,
            }
        }
        TerminalSessionMode::Native => {
            if route.authorized_client_public_keys_openssh.is_empty() {
                return Err(GatewayHttpError(StargateError::Validation(
                    "authorized_client_public_keys_openssh must not be empty for native sessions"
                        .to_owned(),
                )));
            }
            let stored = state.store.upsert_route(route).await?;
            IssueTerminalSessionResponse {
                route_username: stored.route_username.clone(),
                expires_at: stored.expires_at.unix_timestamp(),
                browser: None,
                native: Some(build_native_session(&state, &stored)),
            }
        }
    };

    Ok(Json(response))
}

pub async fn issue_workspace_app_session(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    Json(request): Json<IssueWorkspaceAppSessionRequest>,
) -> Result<Json<IssueWorkspaceAppSessionResponse>, GatewayHttpError> {
    state.admin_auth.validate_headers(&headers).await?;
    crate::workspace_app::ensure_workspace_app_origin_configured(&state)?;
    let route = validate_workspace_app_session_request(request)?;
    let bootstrap = crate::workspace_app::new_workspace_app_bootstrap(
        route.expires_at,
        state.public_web.workspace_app_bootstrap_ttl_seconds,
    )?;
    // Construct and validate the public capability URL before rotating any
    // persisted route authorization. A bad origin configuration must leave an
    // existing route and its browser sessions untouched.
    let url =
        crate::workspace_app::build_workspace_app_url(&state, &route.route_id, &bootstrap.token)?;
    let stored = state
        .store
        .upsert_workspace_app_route(route, &bootstrap.token_sha256, bootstrap.expires_at)
        .await?;
    // An upsert is also a route authorization rotation. Close any HTTP or
    // WebSocket tunnel that was established under the replaced credentials.
    state.sessions.terminate_username(&stored.route_id).await;
    state
        .workspace_app_tunnels
        .invalidate(&stored.route_id)
        .await;
    Ok(Json(IssueWorkspaceAppSessionResponse {
        route_id: stored.route_id,
        url,
        bootstrap_expires_at: bootstrap.expires_at.unix_timestamp(),
        expires_at: stored.expires_at.unix_timestamp(),
    }))
}

pub async fn delete_route(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    Path(username): Path<String>,
) -> Result<axum::http::StatusCode, GatewayHttpError> {
    state.admin_auth.validate_headers(&headers).await?;
    if !state.store.delete_route(&username).await? {
        return Err(GatewayHttpError(StargateError::RouteNotFound(username)));
    }
    state.sessions.terminate_username(&username).await;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

pub async fn delete_workspace_app_route(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    Path(route_id): Path<String>,
) -> Result<axum::http::StatusCode, GatewayHttpError> {
    state.admin_auth.validate_headers(&headers).await?;
    if !state.store.delete_workspace_app_route(&route_id).await? {
        return Err(GatewayHttpError(StargateError::RouteNotFound(route_id)));
    }
    state.sessions.terminate_username(&route_id).await;
    state.workspace_app_tunnels.invalidate(&route_id).await;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

fn build_native_session(
    state: &GatewayState,
    route: &stargate_core::RouteRecord,
) -> NativeTerminalSession {
    let ssh_host = state.public_web.public_ssh_host.to_string();
    let ssh_port = state.public_web.public_ssh_port;
    let known_hosts_host = if ssh_port == 22 {
        ssh_host.clone()
    } else {
        format!("[{ssh_host}]:{ssh_port}")
    };
    let command = if ssh_port == 22 {
        format!("ssh {}@{ssh_host}", route.route_username)
    } else {
        format!("ssh -p {ssh_port} {}@{ssh_host}", route.route_username)
    };
    NativeTerminalSession {
        auth_mode: NativeTerminalAuthMode::ProfileKeys,
        authorized_key_count: route.authorized_client_public_keys_openssh.len(),
        ssh_host,
        ssh_port,
        username: route.route_username.clone(),
        public_host_key_openssh: state.public_web.public_ssh_host_key_openssh.to_string(),
        public_host_key_fingerprint_sha256: state
            .public_web
            .public_ssh_host_key_fingerprint_sha256
            .to_string(),
        known_hosts_line: format!(
            "{known_hosts_host} {}",
            state.public_web.public_ssh_host_key_openssh
        ),
        command,
    }
}
