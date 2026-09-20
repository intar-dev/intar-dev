//! Host-level leased authorization. The data path never calls the control plane.
use crate::{GatewayHttpError, GatewayState, host_relay::RelayAuthorization};
use axum::{
    Json,
    extract::{
        State,
        ws::{Message, WebSocketUpgrade},
    },
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use http::{HeaderMap, StatusCode};
use serde::{Deserialize, Serialize};
use stargate_core::{
    StargateError,
    relay::{HostRelayIdentity, RELAY_FRAME_BYTES, RelayTarget, websocket_bytes},
};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

const MAX_HOSTS: usize = 4096;
const LEASE_MS: i64 = 120_000;

#[derive(Clone, Default)]
pub(crate) struct RelayGrants(
    Arc<Mutex<HashMap<String, Grant>>>,
    Arc<Mutex<HashMap<HostRelayIdentity, tokio::time::Instant>>>,
    Arc<Mutex<HashMap<String, (u64, tokio::time::Instant)>>>,
);
struct Grant {
    authorization: Arc<RelayAuthorization>,
    token: String,
    session_started_at: i64,
    revision: i64,
    connected: bool,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct GrantRequest {
    pub identity: HostRelayIdentity,
    pub targets: HashSet<RelayTarget>,
    pub session_started_at_unix_ms: i64,
    pub issued_at_unix_ms: i64,
    pub expires_at_unix_ms: i64,
}
#[derive(Serialize, Deserialize)]
pub(crate) struct GrantResponse {
    pub identity: HostRelayIdentity,
    pub websocket_url: String,
    pub token: String,
    pub gateway_host_key_openssh: String,
    pub expires_at_unix_ms: i64,
}
fn invalid(message: &str) -> GatewayHttpError {
    StargateError::Validation(message.into()).into()
}
fn conflict() -> GatewayHttpError {
    StargateError::TerminalRouteConflict("relay grant is stale or revoked".into()).into()
}
fn now_ms() -> i64 {
    (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}

pub(crate) async fn grant(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    Json(request): Json<GrantRequest>,
) -> Result<Json<GrantResponse>, GatewayHttpError> {
    state.admin_auth.validate_headers(&headers).await?;
    request
        .identity
        .validate()
        .map_err(|_| invalid("invalid relay identity"))?;
    let now = now_ms();
    if request.issued_at_unix_ms > now + 5_000
        || request.issued_at_unix_ms < now - LEASE_MS
        || request.expires_at_unix_ms <= now
        || request.expires_at_unix_ms > request.issued_at_unix_ms + LEASE_MS
        || request.session_started_at_unix_ms > request.issued_at_unix_ms
        || request.session_started_at_unix_ms <= 0
    {
        return Err(invalid("invalid relay lease"));
    }
    let expires = tokio::time::Instant::now()
        + Duration::from_millis((request.expires_at_unix_ms - now) as u64);
    let mut url = state
        .public_web
        .public_base_url
        .join("/v1/host-relay/ws")
        .map_err(|_| invalid("invalid gateway URL"))?;
    if url.scheme() != "https" {
        return Err(invalid("host relay requires HTTPS"));
    }
    url.set_scheme("wss")
        .map_err(|_| invalid("invalid gateway URL"))?;
    let token;
    {
        let mut grants = state.relay_grants.0.lock().expect("relay grants lock");
        let mut revoked = state.relay_grants.1.lock().expect("revoked relay lock");
        revoked.retain(|_, deadline| *deadline > tokio::time::Instant::now());
        let mut credentials = state
            .relay_grants
            .2
            .lock()
            .expect("revoked credentials lock");
        credentials.retain(|_, (_, deadline)| *deadline > tokio::time::Instant::now());
        if revoked.contains_key(&request.identity)
            || credentials
                .get(&request.identity.host_id)
                .is_some_and(|(generation, _)| {
                    *generation >= request.identity.credential_generation
                })
        {
            return Err(conflict());
        }
        drop(credentials);
        drop(revoked);
        grants.retain(|_, g| {
            let live = g.authorization.expires() > tokio::time::Instant::now();
            if !live {
                g.authorization.cancel.cancel();
            }
            live
        });
        if let Some(old) = grants.get(&request.identity.host_id) {
            if old.authorization.identity == request.identity {
                if old.authorization.cancel.is_cancelled()
                    || request.issued_at_unix_ms < old.revision
                    || (request.issued_at_unix_ms == old.revision
                        && !old.authorization.matches_targets(&request.targets))
                {
                    return Err(conflict());
                }
            } else if request.identity.credential_generation
                < old.authorization.identity.credential_generation
                || request.session_started_at_unix_ms <= old.session_started_at
            {
                return Err(conflict());
            }
        }
        let same = grants
            .get(&request.identity.host_id)
            .is_some_and(|g| g.authorization.identity == request.identity);
        if same {
            let existing = grants
                .get_mut(&request.identity.host_id)
                .expect("grant exists");
            existing
                .authorization
                .refresh(request.targets, expires)
                .map_err(|e| invalid(&e.to_string()))?;
            existing.revision = request.issued_at_unix_ms;
            token = existing.token.clone();
        } else {
            if grants.len() >= MAX_HOSTS && !grants.contains_key(&request.identity.host_id) {
                return Err(invalid("relay host limit reached"));
            }
            let authorization = Arc::new(
                RelayAuthorization::new(
                    request.identity.clone(),
                    request.targets,
                    expires,
                    CancellationToken::new(),
                )
                .map_err(|e| invalid(&e.to_string()))?,
            );
            token = format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            );
            if let Some(old) = grants.insert(
                request.identity.host_id.clone(),
                Grant {
                    authorization: authorization.clone(),
                    token: token.clone(),
                    session_started_at: request.session_started_at_unix_ms,
                    revision: request.issued_at_unix_ms,
                    connected: false,
                },
            ) {
                old.authorization.cancel.cancel();
                state.host_relays.revoke(&old.authorization.identity);
            }
            // One bounded task per host lease. Refresh changes the deadline;
            // revocation or expiry closes every stream, including idle ones.
            tokio::spawn(async move {
                tokio::select! { _=authorization.cancel.cancelled()=>{}, _=authorization.expired()=>{authorization.cancel.cancel();} }
            });
        }
    }
    Ok(Json(GrantResponse {
        identity: request.identity,
        websocket_url: url.to_string(),
        token,
        gateway_host_key_openssh: state
            .relay_key
            .public_key()
            .to_openssh()
            .map_err(|e| invalid(&e.to_string()))?,
        expires_at_unix_ms: request.expires_at_unix_ms,
    }))
}

pub(crate) async fn revoke(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    Json(identity): Json<HostRelayIdentity>,
) -> Result<StatusCode, GatewayHttpError> {
    state.admin_auth.validate_headers(&headers).await?;
    let grants = state.relay_grants.0.lock().expect("relay grants lock");
    if let Some(grant) = grants.get(&identity.host_id)
        && grant.authorization.identity == identity
    {
        grant.authorization.cancel.cancel();
        state.host_relays.revoke(&identity);
    }
    let mut revoked = state.relay_grants.1.lock().expect("revoked relay lock");
    revoked.retain(|_, deadline| *deadline > tokio::time::Instant::now());
    if revoked.len() >= MAX_HOSTS && !revoked.contains_key(&identity) {
        return Err(invalid("relay revocation limit reached"));
    }
    revoked.insert(
        identity,
        tokio::time::Instant::now() + Duration::from_millis((LEASE_MS + 5_000) as u64),
    );
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn websocket(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response, GatewayHttpError> {
    // A bearer is never accepted in a URL or browser subprotocol.
    if headers.contains_key(http::header::ORIGIN) {
        return Err(StargateError::Unauthorized.into());
    }
    let bearer = headers
        .get(http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|v| v.len() == 64)
        .ok_or(StargateError::Unauthorized)?;
    let authorization = {
        let mut grants = state.relay_grants.0.lock().expect("relay grants lock");
        // Hash both tokens before comparison: comparison does not expose a
        // matching secret prefix. At most MAX_HOSTS live grants are scanned.
        use sha2::{Digest, Sha256};
        let hash = Sha256::digest(bearer.as_bytes());
        let grant = grants
            .values_mut()
            .find(|g| Sha256::digest(g.token.as_bytes()) == hash)
            .ok_or(StargateError::Unauthorized)?;
        if grant.connected
            || grant.authorization.cancel.is_cancelled()
            || grant.authorization.expires() <= tokio::time::Instant::now()
        {
            return Err(StargateError::Unauthorized.into());
        }
        grant.connected = true;
        grant.authorization.clone()
    };
    let failed = authorization.clone();
    Ok(ws
        .max_frame_size(RELAY_FRAME_BYTES)
        .max_message_size(RELAY_FRAME_BYTES)
        .write_buffer_size(0)
        .max_write_buffer_size(RELAY_FRAME_BYTES * 2)
        .on_failed_upgrade(move |_| {
            failed.cancel.cancel();
        })
        .on_upgrade(move |socket| async move {
            let adapted = socket
                .with(|data: Vec<u8>| {
                    futures_util::future::ready(Ok::<_, axum::Error>(Message::Binary(data.into())))
                })
                .filter_map(|message| {
                    futures_util::future::ready(match message {
                        Ok(Message::Binary(data)) => Some(Ok(data.to_vec())),
                        Ok(Message::Ping(_) | Message::Pong(_)) => None,
                        _ => Some(Err(axum::Error::new(std::io::Error::from(
                            std::io::ErrorKind::ConnectionAborted,
                        )))),
                    })
                });
            let _ = state
                .host_relays
                .serve_authorized(
                    websocket_bytes(adapted),
                    authorization.clone(),
                    (*state.relay_key).clone(),
                )
                .await;
            let mut grants = state.relay_grants.0.lock().expect("relay grants lock");
            if let Some(grant) = grants.get_mut(&authorization.identity.host_id)
                && Arc::ptr_eq(&grant.authorization, &authorization)
            {
                grant.connected = false;
            }
        }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RevokeCredentials {
    host_id: String,
    credential_generation: u64,
}
pub(crate) async fn revoke_credentials(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    Json(input): Json<RevokeCredentials>,
) -> Result<StatusCode, GatewayHttpError> {
    state.admin_auth.validate_headers(&headers).await?;
    let grants = state.relay_grants.0.lock().expect("relay grants lock");
    if let Some(grant) = grants.get(&input.host_id)
        && grant.authorization.identity.credential_generation <= input.credential_generation
    {
        grant.authorization.cancel.cancel();
        state.host_relays.revoke(&grant.authorization.identity);
    }
    let mut revoked = state
        .relay_grants
        .2
        .lock()
        .expect("revoked credentials lock");
    revoked.retain(|_, (_, deadline)| *deadline > tokio::time::Instant::now());
    if revoked.len() >= MAX_HOSTS && !revoked.contains_key(&input.host_id) {
        return Err(invalid("relay revocation limit reached"));
    }
    let previous = revoked.get(&input.host_id).map(|v| v.0).unwrap_or(0);
    revoked.insert(
        input.host_id,
        (
            previous.max(input.credential_generation),
            tokio::time::Instant::now() + Duration::from_millis((LEASE_MS + 5_000) as u64),
        ),
    );
    Ok(StatusCode::NO_CONTENT)
}
