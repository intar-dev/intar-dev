use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};
use serde_json::json;
use stargate_core::{
    IssueTerminalSessionRequest, IssueTerminalSessionResponse, NativeTerminalAuthMode,
    NativeTerminalSession, StargateError, TerminalSessionMode, validate_terminal_session_request,
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
