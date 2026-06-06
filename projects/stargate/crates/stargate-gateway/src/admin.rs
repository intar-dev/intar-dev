use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};
use serde_json::json;
use stargate_core::{
    IssueTerminalSessionRequest, IssueTerminalSessionResponse, NativeTerminalAuthMode,
    NativeTerminalSession, RegisteredRoute, StargateError, TerminalSessionMode,
};
use tokio::process::Command;

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
    let (mut route, mode) = request.validate()?;
    route = finalize_route(&state, route).await?;

    let response = match mode {
        TerminalSessionMode::Browser => {
            let stored = state.store.upsert_route(route).await?;
            let websocket_url = webssh::build_terminal_websocket_url(&state, &stored)?;
            IssueTerminalSessionResponse {
                route_username: stored.route_username,
                expires_at: stored.expires_at,
                browser: Some(stargate_core::BrowserTerminalSession { websocket_url }),
                native: None,
            }
        }
        TerminalSessionMode::Native => {
            let native_auth = if route.authorized_client_public_keys_openssh.is_empty() {
                let (public_key, private_key) = generate_native_client_keypair()?;
                route.authorized_client_public_keys_openssh = vec![public_key];
                NativeAuthSession::IssuedKey { private_key }
            } else {
                NativeAuthSession::ProfileKeys
            };
            let stored = state.store.upsert_route(route).await?;
            IssueTerminalSessionResponse {
                route_username: stored.route_username.clone(),
                expires_at: stored.expires_at,
                browser: None,
                native: Some(build_native_session(&state, &stored, native_auth)),
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

async fn finalize_route(
    state: &GatewayState,
    mut route: RegisteredRoute,
) -> Result<RegisteredRoute, GatewayHttpError> {
    if route.target_host_key_openssh.is_none() {
        route.target_host_key_openssh = Some(discover_target_host_key(state, &route).await?);
    }

    Ok(route)
}

fn build_native_session(
    state: &GatewayState,
    route: &stargate_core::RouteRecord,
    native_auth: NativeAuthSession,
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
    let (auth_mode, private_key_openssh) = match native_auth {
        NativeAuthSession::ProfileKeys => (NativeTerminalAuthMode::ProfileKeys, None),
        NativeAuthSession::IssuedKey { private_key } => {
            (NativeTerminalAuthMode::IssuedKey, Some(private_key))
        }
    };

    NativeTerminalSession {
        auth_mode,
        authorized_key_count: route.authorized_client_public_keys_openssh.len(),
        ssh_host,
        ssh_port,
        username: route.route_username.clone(),
        private_key_openssh,
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

enum NativeAuthSession {
    ProfileKeys,
    IssuedKey { private_key: String },
}

fn generate_native_client_keypair() -> std::result::Result<(String, String), GatewayHttpError> {
    let private_key = russh::keys::PrivateKey::random(
        &mut russh::keys::ssh_key::rand_core::OsRng,
        russh::keys::ssh_key::Algorithm::Ed25519,
    )
    .map_err(StargateError::from)
    .map_err(GatewayHttpError)?;
    let public_key = private_key
        .public_key()
        .to_openssh()
        .map_err(StargateError::from)
        .map_err(GatewayHttpError)?;
    let private_key_openssh = private_key
        .to_openssh(russh::keys::ssh_key::LineEnding::LF)
        .map_err(StargateError::from)
        .map_err(GatewayHttpError)?
        .to_string();
    Ok((public_key, private_key_openssh))
}

async fn discover_target_host_key(
    state: &GatewayState,
    route: &RegisteredRoute,
) -> Result<String, GatewayHttpError> {
    let output = Command::new(&state.ssh_keyscan_binary)
        .arg("-p")
        .arg(route.target_port.to_string())
        .arg(&route.target_ip)
        .output()
        .await
        .map_err(StargateError::Io)?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GatewayHttpError(StargateError::Internal(format!(
            "ssh-keyscan failed for {}:{}: {}",
            route.target_ip,
            route.target_port,
            stderr.trim()
        ))));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let _host = parts.next();
        let algorithm = parts.next();
        let encoded = parts.next();
        if let (Some(algorithm), Some(encoded)) = (algorithm, encoded) {
            let candidate = format!("{algorithm} {encoded}");
            russh::keys::ssh_key::PublicKey::from_openssh(&candidate).map_err(|_| {
                GatewayHttpError(StargateError::Validation(
                    "target_host_key_openssh is invalid".to_owned(),
                ))
            })?;
            return Ok(candidate);
        }
    }

    Err(GatewayHttpError(StargateError::Internal(format!(
        "ssh-keyscan returned no host keys for {}:{}",
        route.target_ip, route.target_port
    ))))
}
