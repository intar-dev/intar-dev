use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
};
use serde::Deserialize;
use serde_json::json;
use stargate_core::{
    ActivateTerminalTargetRequest, BrowserTerminalSession, IssueTerminalSessionRequest,
    IssueTerminalSessionResponse, IssueWorkspaceAppSessionRequest,
    IssueWorkspaceAppSessionResponse, NativeTerminalAuthMode, NativeTerminalSession,
    StageTerminalTargetRequest, StageTerminalTargetResponse, StargateError, StoredTarget,
    StoredTerminalRoute, TerminalSessionMode, TerminalTarget, validate_activate_request,
    validate_stage_request, validate_terminal_session_request,
    validate_workspace_app_session_request,
};

use crate::{
    ActivateOutcome, GatewayHttpError, GatewayState, StageOutcome,
    store::{GenerationDeleteOutcome, RouteRotationPrevious},
    webssh,
};

pub async fn healthz(
    State(state): State<GatewayState>,
) -> Result<Json<serde_json::Value>, GatewayHttpError> {
    state.store.healthcheck().await?;
    Ok(Json(json!({ "ok": true })))
}

/// Create one terminal route. A browser route is created pending: it holds the
/// run identity and no guest endpoint, and the browser socket waits for the
/// admin attach. A native route carries its ready target in this call.
pub async fn issue_terminal_session(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    Json(request): Json<IssueTerminalSessionRequest>,
) -> Result<Json<IssueTerminalSessionResponse>, GatewayHttpError> {
    state.admin_auth.validate_headers(&headers).await?;
    let route = validate_terminal_session_request(request)?;

    let response = match route.mode {
        TerminalSessionMode::Browser => {
            let stored = replace_terminal_route(&state, route).await?;
            let websocket_url = webssh::build_terminal_websocket_url(&state, &stored)?;
            IssueTerminalSessionResponse {
                route_username: stored.route_username.clone(),
                expires_at: stored.expires_at.unix_timestamp(),
                browser: Some(BrowserTerminalSession { websocket_url }),
                native: None,
            }
        }
        TerminalSessionMode::Native => {
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

/// Stage the ready target on a pending browser route, and answer with the
/// attachment identifier. The route is not ready after this call: no waiter
/// wakes and no socket dials. The control plane activates the attachment after
/// its own admission fence.
pub async fn stage_terminal_target(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    Path(route_username): Path<String>,
    Json(request): Json<StageTerminalTargetRequest>,
) -> Result<Json<StageTerminalTargetResponse>, GatewayHttpError> {
    state.admin_auth.validate_headers(&headers).await?;
    let target = validate_stage_request(request.clone())?;
    let outcome = state
        .stage_target(
            &route_username,
            &request.run_id,
            &request.vm_id,
            &request.user_id,
            &request.generation,
            target,
        )
        .await?;
    match outcome {
        // An identical repeat returns the same attachment, so a retry of a
        // request whose answer was lost is safe.
        StageOutcome::Staged { attachment_id } | StageOutcome::AlreadyStaged { attachment_id } => {
            Ok(Json(StageTerminalTargetResponse { attachment_id }))
        }
        StageOutcome::TargetConflict => Err(GatewayHttpError(
            StargateError::TerminalRouteConflict("route already holds another target".to_owned()),
        )),
        StageOutcome::IdentityMismatch => {
            Err(GatewayHttpError(StargateError::TerminalRouteConflict(
                "route identity does not match the stage call".to_owned(),
            )))
        }
        StageOutcome::RouteNotFound => Err(GatewayHttpError(StargateError::RouteNotFound(
            route_username,
        ))),
    }
}

/// Activate exactly the staged attachment that the control plane names. Only
/// this call makes the route ready and wakes the waiting browser socket, so the
/// SSH shift can not start before the control plane has confirmed the run.
pub async fn activate_terminal_target(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    Path(route_username): Path<String>,
    Json(request): Json<ActivateTerminalTargetRequest>,
) -> Result<StatusCode, GatewayHttpError> {
    state.admin_auth.validate_headers(&headers).await?;
    validate_activate_request(request.clone())?;
    let outcome = state
        .activate_staged_target(
            &route_username,
            &request.run_id,
            &request.vm_id,
            &request.user_id,
            &request.generation,
            &request.attachment_id,
        )
        .await?;
    match outcome {
        // An exact repeat with the same attachment gives the same result as the
        // first activation, so an ambiguous retry is safe.
        ActivateOutcome::Activated | ActivateOutcome::AlreadyActive => Ok(StatusCode::NO_CONTENT),
        ActivateOutcome::StaleAttachment => {
            Err(GatewayHttpError(StargateError::TerminalRouteConflict(
                "attachment_id is not the staged attachment".to_owned(),
            )))
        }
        ActivateOutcome::NothingStaged => Err(GatewayHttpError(
            StargateError::TerminalRouteConflict("route has no staged target".to_owned()),
        )),
        ActivateOutcome::IdentityMismatch => {
            Err(GatewayHttpError(StargateError::TerminalRouteConflict(
                "route identity does not match the activation call".to_owned(),
            )))
        }
        ActivateOutcome::RouteNotFound => Err(GatewayHttpError(StargateError::RouteNotFound(
            route_username,
        ))),
    }
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
    Query(query): Query<DeleteRouteQuery>,
) -> Result<StatusCode, GatewayHttpError> {
    state.admin_auth.validate_headers(&headers).await?;
    let _terminal_route_mutation = state.terminal_route_mutation.lock().await;
    let Some(generation) = query.generation.as_deref() else {
        // A native or workspace route delete names no generation, and the
        // route it deletes is the one it just read. Keep this path for those
        // product routes.
        if !state.store.delete_route(&username).await? {
            return Err(GatewayHttpError(StargateError::RouteNotFound(username)));
        }
        state.sessions.terminate_username(&username).await;
        return Ok(StatusCode::NO_CONTENT);
    };
    validate_generation(generation)?;
    match state
        .store
        .delete_route_if_generation(&username, generation)
        .await?
    {
        GenerationDeleteOutcome::Deleted => {
            state.sessions.terminate_username(&username).await;
            Ok(StatusCode::NO_CONTENT)
        }
        // The route was reissued for another generation after this delete was
        // prepared. Refuse it, and leave the new generation and every session
        // it authorized alone.
        GenerationDeleteOutcome::GenerationMismatch => {
            Err(GatewayHttpError(StargateError::TerminalRouteConflict(
                "route generation does not match the delete call".to_owned(),
            )))
        }
        GenerationDeleteOutcome::Missing => {
            Err(GatewayHttpError(StargateError::RouteNotFound(username)))
        }
    }
}

#[derive(Debug, Deserialize, Default)]
pub struct DeleteRouteQuery {
    /// Opaque route generation. When present, the delete applies only to a
    /// route that still carries this exact generation.
    generation: Option<String>,
}

fn validate_generation(generation: &str) -> Result<(), GatewayHttpError> {
    if generation.is_empty() || generation.len() > 128 {
        return Err(GatewayHttpError(StargateError::Validation(
            "generation must be 1..=128 characters".to_owned(),
        )));
    }
    Ok(())
}

pub async fn delete_workspace_app_route(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    Path(route_id): Path<String>,
) -> Result<StatusCode, GatewayHttpError> {
    state.admin_auth.validate_headers(&headers).await?;
    if !state.store.delete_workspace_app_route(&route_id).await? {
        return Err(GatewayHttpError(StargateError::RouteNotFound(route_id)));
    }
    state.sessions.terminate_username(&route_id).await;
    state.workspace_app_tunnels.invalidate(&route_id).await;
    Ok(StatusCode::NO_CONTENT)
}

async fn replace_terminal_route(
    state: &GatewayState,
    route: StoredTerminalRoute,
) -> Result<StoredTerminalRoute, GatewayHttpError> {
    // The mutex covers all of the decision and invalidation. Without it, two
    // issuers can both compare against an old record, and the last write can
    // leave a session authorized under the intermediate authorization alive.
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
    current: &StoredTerminalRoute,
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

    // Authorized client keys are stored in their normalized form, and an
    // OpenSSH comment never survives normalization, so a plain comparison of
    // the two targets and the two identities is exact.
    if previous.metadata != current.metadata || previous.mode != current.mode {
        return true;
    }
    match (&previous.target, &current.target) {
        // Two targets of the same readiness class compare by their data. An
        // identical active reissue keeps its live session; a staged-to-active
        // move, or a route that gained or lost its target, is a change.
        (
            StoredTarget::Active {
                target: previous, ..
            },
            StoredTarget::Active {
                target: current, ..
            },
        ) => target_authorization_changed(previous, current),
        (StoredTarget::Missing, StoredTarget::Missing) => false,
        _ => true,
    }
}

/// Compare one target against the stored one. Only key *material* is
/// authorization: an OpenSSH comment can change across a browser refresh
/// without changing the key, and it must not revoke a live session. A key that
/// does not parse is a change, so a broken record fails closed.
fn target_authorization_changed(previous: &TerminalTarget, current: &TerminalTarget) -> bool {
    if previous.username != current.username
        || previous.transport != current.transport
        || previous.private_key_openssh != current.private_key_openssh
    {
        return true;
    }
    if key_material(&previous.host_key_openssh) != key_material(&current.host_key_openssh) {
        return true;
    }
    client_key_material(&previous.authorized_client_public_keys_openssh)
        != client_key_material(&current.authorized_client_public_keys_openssh)
}

/// A public key's material, as a SHA-256 fingerprint. The fingerprint covers
/// the algorithm and the key bytes and never the OpenSSH comment.
fn key_material(value: &str) -> Option<String> {
    russh::keys::ssh_key::PublicKey::from_openssh(value)
        .ok()
        .map(|key| format!("{}", key.fingerprint(russh::keys::ssh_key::HashAlg::Sha256)))
}

/// Key material as a set: the order of the list is not authorization, and a
/// duplicate is already removed by validation.
fn client_key_material(values: &[String]) -> Option<std::collections::BTreeSet<String>> {
    values.iter().map(|value| key_material(value)).collect()
}

fn build_native_session(
    state: &GatewayState,
    route: &StoredTerminalRoute,
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
    let authorized_key_count = route
        .ready_target()
        .map(|target| target.authorized_client_public_keys_openssh.len())
        .unwrap_or_default();
    NativeTerminalSession {
        auth_mode: NativeTerminalAuthMode::ProfileKeys,
        authorized_key_count,
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
        AdminAuthSettings, RouteMetadata, SessionKind, StoredTarget, StoredTerminalRoute,
        TerminalSessionMode, TerminalTarget, TerminalTokenSettings, WebSettings,
    };
    use time::OffsetDateTime;

    use super::{replace_terminal_route, terminal_route_authorization_changed};
    use crate::{GatewayState, SqliteRouteStore, store::RouteRotationPrevious};

    const FIRST_KEY: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBklzf1Qy77LwsjmDlGvCAhBpCkhpti25927fAnOMEIR";
    const SECOND_KEY: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA8ax6Yk1ZMSRpAkk8cIriNXtVufy6mxst2stQk66n+d";

    /// The active target of a test route, so a test can change one field.
    fn active_target(route: &mut StoredTerminalRoute) -> &mut TerminalTarget {
        match &mut route.target {
            StoredTarget::Active { target, .. } => target,
            other => panic!("the test route must carry an active target, not {other:?}"),
        }
    }

    #[tokio::test]
    async fn concurrent_reissues_revoke_a_session_for_the_intermediate_key() -> anyhow::Result<()> {
        let (_temp_dir, state) = test_gateway_state().await?;
        let first = route_with_keys(&[FIRST_KEY]);
        state.store.upsert_route(first.clone()).await?;

        // Queue two competing issuers in a defined order. The first writes
        // SECOND_KEY; before the second is polled, a client authenticates
        // under that intermediate authorization. The second must see that
        // actual record, restore FIRST_KEY, and revoke the client.
        let held = state.terminal_route_mutation.lock().await;
        let mut write_second = Box::pin(replace_terminal_route(
            &state,
            route_with_keys(&[SECOND_KEY]),
        ));
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
    fn the_same_route_and_key_material_keeps_sessions() {
        let route = route_with_keys(&[FIRST_KEY]);
        let previous = route.clone();
        // The keys are compared in their stored, normalized form, so a comment
        // that a client added to its own copy is not authorization material.
        let current = route;

        assert!(!terminal_route_authorization_changed(
            &RouteRotationPrevious::Present(Box::new(previous)),
            &current,
        ));
    }

    /// A browser refresh re-sends the same key with a different OpenSSH
    /// comment. Only the key material is authorization, so the route must
    /// compare equal and the live SSH session must survive the reissue.
    #[tokio::test]
    async fn a_key_comment_change_does_not_revoke_a_live_session() -> anyhow::Result<()> {
        let (_temp_dir, state) = test_gateway_state().await?;
        let stored = state
            .store
            .upsert_route(route_with_keys(&[FIRST_KEY]))
            .await?;
        let previous = state
            .store
            .get_route_for_rotation(&stored.route_username)
            .await?;
        // The same route and the same key material, with a comment that a
        // browser refresh added to its own copy of the public key.
        let mut current = stored.clone();
        active_target(&mut current).authorized_client_public_keys_openssh =
            vec![format!("{FIRST_KEY} browser-refresh")];

        assert!(
            !terminal_route_authorization_changed(&previous, &current),
            "a comment-only key change must not revoke the live session"
        );

        // A different key still revokes, and a broken record fails closed.
        let mut rotated = stored.clone();
        active_target(&mut rotated).authorized_client_public_keys_openssh =
            vec![SECOND_KEY.to_owned()];
        assert!(terminal_route_authorization_changed(&previous, &rotated));

        let mut broken = stored.clone();
        active_target(&mut broken).authorized_client_public_keys_openssh =
            vec!["ssh-ed25519 not-a-key".to_owned()];
        assert!(terminal_route_authorization_changed(&previous, &broken));
        Ok(())
    }

    #[test]
    fn target_identity_and_mode_changes_revoke_sessions() {
        let base = route_with_keys(&[FIRST_KEY]);
        let previous = RouteRotationPrevious::Present(Box::new(base.clone()));
        let mut changes = Vec::new();

        let mut other_key = base.clone();
        active_target(&mut other_key).authorized_client_public_keys_openssh =
            vec![SECOND_KEY.to_owned()];
        changes.push(other_key);

        let mut metadata = base.clone();
        metadata.metadata.vm_id = "vm-02".to_owned();
        changes.push(metadata);

        let mut mode = base.clone();
        mode.mode = TerminalSessionMode::Browser;
        changes.push(mode);

        let mut target = base.clone();
        active_target(&mut target).transport = stargate_core::SshTargetTransport::Direct {
            host: "127.0.0.2".to_owned(),
            port: 22,
        };
        changes.push(target);

        for current in changes {
            assert!(terminal_route_authorization_changed(&previous, &current));
        }
    }

    #[test]
    fn a_malformed_prior_record_forces_revocation() {
        let current = route_with_keys(&[SECOND_KEY]);

        assert!(terminal_route_authorization_changed(
            &RouteRotationPrevious::Malformed,
            &current,
        ));
    }

    /// A teardown for run A must not delete the route that the same name was
    /// reissued to for run B, and it must not cancel the sessions that run B
    /// authorized.
    #[tokio::test]
    async fn a_generation_fenced_delete_spares_a_reissued_route() -> anyhow::Result<()> {
        let (_temp_dir, state) = test_gateway_state().await?;
        let mut current = route_with_keys(&[FIRST_KEY]);
        current.generation = "exec-02:1".to_owned();
        state.store.upsert_route(current).await?;
        let live = state
            .sessions
            .register("run-01-web".to_owned(), SessionKind::NativeSsh, None);
        let live_cancel = live.token();

        assert_eq!(
            state
                .store
                .delete_route_if_generation("run-01-web", "exec-01:7")
                .await?,
            crate::GenerationDeleteOutcome::GenerationMismatch
        );
        assert!(
            state.store.get_route("run-01-web").await?.is_some(),
            "a stale generation delete removed the live route"
        );
        assert!(
            !live_cancel.is_cancelled(),
            "a stale generation delete cancelled a live session"
        );

        assert_eq!(
            state
                .store
                .delete_route_if_generation("run-01-web", "exec-02:1")
                .await?,
            crate::GenerationDeleteOutcome::Deleted
        );
        assert!(state.store.get_route("run-01-web").await?.is_none());
        assert_eq!(
            state
                .store
                .delete_route_if_generation("run-01-web", "exec-02:1")
                .await?,
            crate::GenerationDeleteOutcome::Missing
        );
        Ok(())
    }

    fn route_with_keys(keys: &[&str]) -> StoredTerminalRoute {
        let mut rng = russh::keys::key::safe_rng();
        let host_key =
            russh::keys::PrivateKey::random(&mut rng, russh::keys::ssh_key::Algorithm::Ed25519)
                .expect("host key");
        let private_key =
            russh::keys::PrivateKey::random(&mut rng, russh::keys::ssh_key::Algorithm::Ed25519)
                .expect("private key");
        let now = OffsetDateTime::now_utc();
        StoredTerminalRoute {
            route_username: "run-01-web".to_owned(),
            generation: "exec-01:7".to_owned(),
            expires_at: now + time::Duration::hours(1),
            mode: TerminalSessionMode::Native,
            metadata: RouteMetadata {
                host_id: "host-01".to_owned(),
                run_id: "run-01".to_owned(),
                vm_id: "vm-01".to_owned(),
                user_id: "user-01".to_owned(),
            },
            target: StoredTarget::Active {
                attachment_id: "attachment-01".to_owned(),
                target: TerminalTarget {
                    username: "ubuntu".to_owned(),
                    transport: stargate_core::SshTargetTransport::Direct {
                        host: "127.0.0.1".to_owned(),
                        port: 22,
                    },
                    host_key_openssh: host_key.public_key().to_openssh().expect("host key"),
                    private_key_openssh: private_key
                        .to_openssh(russh::keys::ssh_key::LineEnding::LF)
                        .expect("private key")
                        .to_string(),
                    authorized_client_public_keys_openssh: keys
                        .iter()
                        .map(|key| (*key).to_owned())
                        .collect(),
                },
            },
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
