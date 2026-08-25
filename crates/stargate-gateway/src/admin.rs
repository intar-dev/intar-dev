use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};
use serde_json::json;
use stargate_core::{
    IssueTerminalSessionRequest, IssueTerminalSessionResponse, IssueWorkspaceAppSessionRequest,
    IssueWorkspaceAppSessionResponse, NativeTerminalAuthMode, NativeTerminalSession,
    RegisteredRoute, RouteRecord, StargateError, TerminalSessionMode,
    validate_terminal_session_request, validate_workspace_app_session_request,
};

use crate::{GatewayHttpError, GatewayState, store::RouteRotationPrevious, webssh};

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
            let stored = replace_terminal_route(&state, route).await?;
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
            let stored = replace_terminal_route(&state, route).await?;
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
    let create_only = route.create_only;
    let stored = state
        .store
        .upsert_workspace_app_route(route, &bootstrap.token_sha256, bootstrap.expires_at)
        .await?;
    if !create_only {
        // An upsert is also a route authorization rotation. Close any HTTP or
        // WebSocket tunnel that was established under replaced credentials.
        state.sessions.terminate_username(&stored.route_id).await;
        state
            .workspace_app_tunnels
            .invalidate(&stored.route_id)
            .await;
    }
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
    let _terminal_route_mutation = state.terminal_route_mutation.lock().await;
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

async fn replace_terminal_route(
    state: &GatewayState,
    route: RegisteredRoute,
) -> Result<RouteRecord, GatewayHttpError> {
    // The mutex covers all of the decision and invalidation. Without it, two
    // issuers can both compare against an old record, and the last write can
    // leave a session authenticated under the intermediate key set alive.
    let _terminal_route_mutation = state.terminal_route_mutation.lock().await;
    let previous = state
        .store
        .get_route_for_rotation(&route.route_username)
        .await?;
    let must_terminate = terminal_route_authorization_changed(&previous, &route);
    let stored = state.store.upsert_route(route).await?;
    if must_terminate {
        state
            .sessions
            .terminate_username(&stored.route_username)
            .await;
    }
    Ok(stored)
}

fn terminal_route_authorization_changed(
    previous: &RouteRotationPrevious,
    current: &RegisteredRoute,
) -> bool {
    let previous = match previous {
        RouteRotationPrevious::Missing => return false,
        RouteRotationPrevious::Malformed => {
            // The old authorization cannot be verified, so fail closed after
            // writing the valid replacement.
            tracing::warn!("revoking terminal sessions for malformed prior route record");
            return true;
        }
        RouteRotationPrevious::Present(previous) => previous,
    };

    if terminal_route_target_changed(previous, current) {
        return true;
    }

    match authorized_key_material_changed(previous, current) {
        Ok(changed) => changed,
        Err(error) => {
            // Do not let a historical bad key make a successful replacement
            // return after its route changed but before session revocation.
            tracing::warn!(error = %error, "revoking terminal sessions for malformed prior key");
            true
        }
    }
}

fn terminal_route_target_changed(previous: &RouteRecord, current: &RegisteredRoute) -> bool {
    previous.target_username != current.target_username
        || previous.target_ip != current.target_ip
        || previous.target_port != current.target_port
        || previous.target_host_key_openssh != current.target_host_key_openssh
        || previous.target_private_key_openssh != current.target_private_key_openssh
        || previous.metadata != current.metadata
}

fn authorized_key_material_changed(
    previous: &RouteRecord,
    current: &RegisteredRoute,
) -> Result<bool, StargateError> {
    let previous_keys = previous.authorized_client_public_keys()?;
    let current_keys = current
        .authorized_client_public_keys_openssh
        .iter()
        .map(|value| {
            russh::keys::ssh_key::PublicKey::from_openssh(value).map_err(|_| {
                StargateError::Validation(
                    "authorized_client_public_keys_openssh contains an invalid key".to_owned(),
                )
            })
        })
        .collect::<Result<Vec<_>, _>>()?;

    Ok(previous_keys.iter().any(|previous_key| {
        !current_keys
            .iter()
            .any(|current_key| previous_key.key_data() == current_key.key_data())
    }) || current_keys.iter().any(|current_key| {
        !previous_keys
            .iter()
            .any(|previous_key| previous_key.key_data() == current_key.key_data())
    }))
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

#[cfg(test)]
mod tests {
    use std::{net::SocketAddr, task::Poll};

    use futures_util::poll;
    use stargate_core::{
        AdminAuthSettings, RouteMetadata, SessionKind, TerminalTokenSettings, WebSettings,
    };
    use time::OffsetDateTime;

    use super::{
        GatewayState, RegisteredRoute, RouteRecord, replace_terminal_route,
        terminal_route_authorization_changed,
    };
    use crate::{SqliteRouteStore, store::RouteRotationPrevious};

    const FIRST_KEY: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBklzf1Qy77LwsjmDlGvCAhBpCkhpti25927fAnOMEIR";
    const SECOND_KEY: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA8ax6Yk1ZMSRpAkk8cIriNXtVufy6mxst2stQk66n+d";

    #[tokio::test]
    async fn concurrent_reissues_revoke_a_session_for_the_intermediate_key() -> anyhow::Result<()> {
        let (_temp_dir, state) = test_gateway_state().await?;
        let first = test_route(FIRST_KEY);
        state.store.upsert_route(first.clone()).await?;

        // Queue two competing issuers in a defined order. The first writes
        // SECOND_KEY; before the second is polled, a client authenticates
        // under that intermediate authorization. The second must see that
        // actual record, restore FIRST_KEY, and revoke the client.
        let held = state.terminal_route_mutation.lock().await;
        let mut write_second = Box::pin(replace_terminal_route(&state, test_route(SECOND_KEY)));
        assert!(matches!(poll!(write_second.as_mut()), Poll::Pending));
        let mut write_first = Box::pin(replace_terminal_route(&state, first));
        assert!(matches!(poll!(write_first.as_mut()), Poll::Pending));
        drop(held);

        assert!(write_second.await.is_ok());
        let intermediate =
            state
                .sessions
                .register("run-01-web".to_owned(), SessionKind::NativeSsh, None);
        let intermediate_cancel = intermediate.token();
        assert!(!intermediate_cancel.is_cancelled());

        assert!(write_first.await.is_ok());
        assert!(
            intermediate_cancel.is_cancelled(),
            "the final reissue left a session authorized by the intermediate key alive"
        );
        Ok(())
    }

    #[test]
    fn exact_same_route_and_key_material_keeps_sessions() {
        let previous = stored_route(&test_route(FIRST_KEY));
        let mut current = test_route(FIRST_KEY);
        // SSH key comments are not authorization material and can differ
        // after a browser refresh without rotating the temporary key.
        current.authorized_client_public_keys_openssh = vec![format!("{FIRST_KEY} refreshed")];

        assert!(!terminal_route_authorization_changed(
            &RouteRotationPrevious::Present(Box::new(previous)),
            &current,
        ));
    }

    #[test]
    fn target_credentials_and_metadata_changes_revoke_sessions() {
        let base = test_route(FIRST_KEY);
        let previous = stored_route(&base);
        let mut changes = Vec::new();

        let mut target_username = base.clone();
        target_username.target_username = "other-user".to_owned();
        changes.push(target_username);

        let mut target_ip = base.clone();
        target_ip.target_ip = "127.0.0.2".to_owned();
        changes.push(target_ip);

        let mut target_port = base.clone();
        target_port.target_port = 2222;
        changes.push(target_port);

        let mut target_host_key = base.clone();
        target_host_key.target_host_key_openssh = "other-host-key".to_owned();
        changes.push(target_host_key);

        let mut target_private_key = base.clone();
        target_private_key.target_private_key_openssh = "other-private-key".to_owned();
        changes.push(target_private_key);

        let mut metadata = base.clone();
        metadata.metadata.vm_id = Some("vm-02".to_owned());
        changes.push(metadata);

        for current in changes {
            assert!(terminal_route_authorization_changed(
                &RouteRotationPrevious::Present(Box::new(previous.clone())),
                &current,
            ));
        }
    }

    #[test]
    fn malformed_prior_key_or_record_forces_revocation() {
        let current = test_route(SECOND_KEY);
        let mut malformed_key = stored_route(&test_route(FIRST_KEY));
        malformed_key.authorized_client_public_keys_openssh =
            vec!["ssh-ed25519 not-a-key".to_owned()];

        assert!(terminal_route_authorization_changed(
            &RouteRotationPrevious::Present(Box::new(malformed_key)),
            &current,
        ));
        assert!(terminal_route_authorization_changed(
            &RouteRotationPrevious::Malformed,
            &current,
        ));
    }

    fn test_route(key: &str) -> RegisteredRoute {
        RegisteredRoute {
            route_username: "run-01-web".to_owned(),
            target_username: "ubuntu".to_owned(),
            target_ip: "127.0.0.1".to_owned(),
            target_port: 22,
            authorized_client_public_keys_openssh: vec![key.to_owned()],
            target_host_key_openssh: "target-host-key".to_owned(),
            target_private_key_openssh: "target-private-key".to_owned(),
            expires_at: OffsetDateTime::now_utc() + time::Duration::hours(1),
            metadata: RouteMetadata {
                host_id: Some("host-01".to_owned()),
                run_id: Some("run-01".to_owned()),
                vm_id: Some("vm-01".to_owned()),
                user_id: Some("user-01".to_owned()),
            },
        }
    }

    fn stored_route(route: &RegisteredRoute) -> RouteRecord {
        let now = OffsetDateTime::now_utc();
        RouteRecord {
            route_username: route.route_username.clone(),
            target_username: route.target_username.clone(),
            target_ip: route.target_ip.clone(),
            target_port: route.target_port,
            authorized_client_public_keys_openssh: route
                .authorized_client_public_keys_openssh
                .clone(),
            target_host_key_openssh: route.target_host_key_openssh.clone(),
            target_private_key_openssh: route.target_private_key_openssh.clone(),
            expires_at: route.expires_at,
            metadata: route.metadata.clone(),
            created_at: now,
            updated_at: now,
        }
    }

    async fn test_gateway_state() -> anyhow::Result<(tempfile::TempDir, GatewayState)> {
        let temp_dir = tempfile::tempdir()?;
        let store = SqliteRouteStore::connect(temp_dir.path().join("stargate.db")).await?;
        let mut rng = russh::keys::key::safe_rng();
        let public_host_key =
            russh::keys::PrivateKey::random(&mut rng, russh::keys::ssh_key::Algorithm::Ed25519)?;
        let web = WebSettings {
            bind: "127.0.0.1:0".parse::<SocketAddr>()?,
            public_base_url: "https://stargate.example.test".parse()?,
            public_ssh_host: "stargate.example.test".to_owned(),
            public_ssh_port: 22,
            allowed_origins: vec!["https://intar.example.test".to_owned()],
            workspace_app_base_domain: None,
            workspace_app_bootstrap_ttl_seconds: 60,
            workspace_app_session_ttl_seconds: 60,
        };
        let state = GatewayState::new(
            store,
            AdminAuthSettings {
                assertion_header: "x-stargate-admin-assertion".to_owned(),
                audience: "stargate-admin".to_owned(),
                issuer: "https://issuer.example.test".to_owned(),
                jwks_url: None,
                hs256_secret: Some("test-secret".to_owned()),
            },
            &web,
            public_host_key.public_key().clone(),
            TerminalTokenSettings {
                issuer: "stargate".to_owned(),
                audience: "stargate-terminal".to_owned(),
                hs256_secret: "terminal-secret".to_owned(),
            },
        )?;
        Ok((temp_dir, state))
    }
}
