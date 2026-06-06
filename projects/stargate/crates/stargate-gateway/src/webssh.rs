use std::time::Duration;

use axum::{
    extract::{
        Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, header},
    response::Response,
};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt, future::pending};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};
use stargate_core::{RouteRecord, SessionKind, StargateError};
use time::{Duration as TimeDuration, OffsetDateTime};
use tokio::{
    sync::mpsc::UnboundedReceiver,
    time::{self as tokio_time, Instant},
};

use crate::{
    GatewayHttpError, GatewayState,
    outbound::{BridgeEvent, PtyBridgeControl, PtyBridgeOptions, spawn_pty_bridge},
};

const MAX_FRAME_BYTES: usize = 64 * 1024;
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);
const PING_INTERVAL: Duration = Duration::from_secs(30);
const TERMINAL_TOKEN_TTL_SECONDS: i64 = 5 * 60;
const DEFAULT_TERM: &str = "xterm-256color";

#[derive(Debug, Deserialize, Default)]
pub struct TerminalWebSocketQuery {
    token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientControlMessage {
    Open { cols: u16, rows: u16 },
    Resize { cols: u16, rows: u16 },
    Close,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ServerControlMessage<'a> {
    Ready,
    Exit { code: u32 },
    Error { message: &'a str },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct TerminalTokenClaims {
    iss: String,
    aud: String,
    sub: String,
    route_username: String,
    exp: u64,
    iat: u64,
    jti: String,
}

pub async fn terminal_websocket(
    ws: WebSocketUpgrade,
    State(state): State<GatewayState>,
    headers: HeaderMap,
    Query(query): Query<TerminalWebSocketQuery>,
) -> Result<Response, GatewayHttpError> {
    validate_origin(&headers, &state)?;
    let route_username = validate_terminal_token(&state, query.token.as_deref()).await?;
    let route = state
        .store
        .get_route(&route_username)
        .await?
        .ok_or(StargateError::Unauthorized)?;

    Ok(ws
        .max_frame_size(MAX_FRAME_BYTES)
        .max_message_size(MAX_FRAME_BYTES)
        .on_upgrade(move |socket| handle_socket(socket, state, route)))
}

pub(crate) fn build_terminal_websocket_url(
    state: &GatewayState,
    route: &RouteRecord,
) -> Result<String, StargateError> {
    let token = mint_terminal_token(state, route)?;
    let mut url = state
        .public_web
        .public_base_url
        .join(crate::terminal_websocket_path())
        .map_err(|error| StargateError::Internal(error.to_string()))?;
    match url.scheme() {
        "https" => {
            url.set_scheme("wss")
                .map_err(|_| StargateError::Internal("failed to build websocket url".to_owned()))?;
        }
        "http" => {
            url.set_scheme("ws")
                .map_err(|_| StargateError::Internal("failed to build websocket url".to_owned()))?;
        }
        _ => {
            return Err(StargateError::Internal(
                "public_base_url must use http or https".to_owned(),
            ));
        }
    }
    url.query_pairs_mut().append_pair("token", &token);
    Ok(url.to_string())
}

async fn handle_socket(mut socket: WebSocket, state: GatewayState, route: RouteRecord) {
    if let Err(error) = run_terminal_socket(&mut socket, &state, route).await {
        tracing::warn!(error = %error, "browser terminal websocket failed");
        let _ = send_control(
            &mut socket,
            &ServerControlMessage::Error {
                message: "terminal session failed",
            },
        )
        .await;
        let _ = socket.close().await;
    }
}

async fn run_terminal_socket(
    socket: &mut WebSocket,
    state: &GatewayState,
    route: RouteRecord,
) -> Result<(), StargateError> {
    let lease = state.sessions.register(
        route.route_username.clone(),
        SessionKind::BrowserTerminal,
        None,
    );
    let cancel = lease.token();
    let mut bridge: Option<(PtyBridgeControl, UnboundedReceiver<BridgeEvent>)> = None;
    let mut ping_interval = tokio_time::interval(PING_INTERVAL);
    ping_interval.set_missed_tick_behavior(tokio_time::MissedTickBehavior::Delay);

    let idle_deadline = tokio_time::sleep(IDLE_TIMEOUT);
    tokio::pin!(idle_deadline);

    loop {
        tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            _ = &mut idle_deadline => return Ok(()),
            _ = ping_interval.tick() => {
                socket
                    .send(Message::Ping(Bytes::new()))
                    .await
                    .map_err(|error| StargateError::Internal(error.to_string()))?;
            }
            message = socket.next() => {
                match message {
                    Some(Ok(Message::Binary(data))) => {
                        let Some((controller, _)) = bridge.as_ref() else {
                            return Err(StargateError::Validation(
                                "terminal must be opened before input".to_owned(),
                            ));
                        };
                        controller.send_input(data.to_vec());
                        idle_deadline.as_mut().reset(Instant::now() + IDLE_TIMEOUT);
                    }
                    Some(Ok(Message::Text(text))) => {
                        handle_client_control(socket, state, &route, &cancel, &mut bridge, text.as_str()).await?;
                        idle_deadline.as_mut().reset(Instant::now() + IDLE_TIMEOUT);
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        socket
                            .send(Message::Pong(payload))
                            .await
                            .map_err(|error| StargateError::Internal(error.to_string()))?;
                        idle_deadline.as_mut().reset(Instant::now() + IDLE_TIMEOUT);
                    }
                    Some(Ok(Message::Pong(_))) => {
                        idle_deadline.as_mut().reset(Instant::now() + IDLE_TIMEOUT);
                    }
                    Some(Ok(Message::Close(_))) | None => return Ok(()),
                    Some(Err(error)) => return Err(StargateError::Internal(error.to_string())),
                }
            }
            event = next_bridge_event(&mut bridge) => {
                match event {
                    Some(BridgeEvent::Stdout(data)) | Some(BridgeEvent::Stderr(data)) => {
                        socket
                            .send(Message::Binary(Bytes::from(data)))
                            .await
                            .map_err(|error| StargateError::Internal(error.to_string()))?;
                        idle_deadline.as_mut().reset(Instant::now() + IDLE_TIMEOUT);
                    }
                    Some(BridgeEvent::Exit(code)) => {
                        send_control(socket, &ServerControlMessage::Exit { code }).await?;
                        return Ok(());
                    }
                    None => return Ok(()),
                }
            }
        }
    }
}

async fn next_bridge_event(
    bridge: &mut Option<(PtyBridgeControl, UnboundedReceiver<BridgeEvent>)>,
) -> Option<BridgeEvent> {
    match bridge {
        Some((_, events)) => events.recv().await,
        None => pending().await,
    }
}

async fn handle_client_control(
    socket: &mut WebSocket,
    state: &GatewayState,
    route: &RouteRecord,
    cancel: &tokio_util::sync::CancellationToken,
    bridge: &mut Option<(PtyBridgeControl, UnboundedReceiver<BridgeEvent>)>,
    raw: &str,
) -> Result<(), StargateError> {
    let message = serde_json::from_str::<ClientControlMessage>(raw)?;
    match message {
        ClientControlMessage::Open { cols, rows } => {
            if bridge.is_some() {
                return Err(StargateError::Validation(
                    "terminal is already open".to_owned(),
                ));
            }
            let (controller, events) = spawn_pty_bridge(
                route.clone(),
                &state.ssh_binary,
                &state.target_ssh_key_path,
                PtyBridgeOptions {
                    term: DEFAULT_TERM.to_owned(),
                    cols: cols.max(1),
                    rows: rows.max(1),
                    command: None,
                },
                cancel.clone(),
            )
            .map_err(|error| StargateError::Internal(error.to_string()))?;
            *bridge = Some((controller, events));
            send_control(socket, &ServerControlMessage::Ready).await?;
        }
        ClientControlMessage::Resize { cols, rows } => {
            let Some((controller, _)) = bridge.as_ref() else {
                return Err(StargateError::Validation("terminal is not open".to_owned()));
            };
            controller.resize(cols.max(1), rows.max(1));
        }
        ClientControlMessage::Close => {
            if let Some((controller, _)) = bridge.as_ref() {
                controller.terminate();
            }
        }
    }
    Ok(())
}

async fn send_control(
    socket: &mut WebSocket,
    message: &ServerControlMessage<'_>,
) -> Result<(), StargateError> {
    let payload = serde_json::to_string(message)?;
    socket
        .send(Message::Text(payload.into()))
        .await
        .map_err(|error| StargateError::Internal(error.to_string()))
}

async fn validate_terminal_token(
    state: &GatewayState,
    token: Option<&str>,
) -> Result<String, GatewayHttpError> {
    let token = token.ok_or(StargateError::Unauthorized)?;
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
    validation.set_issuer(&[state.public_web.terminal_token_issuer.as_ref()]);
    validation.set_audience(&[state.public_web.terminal_token_audience.as_ref()]);

    let decoded = decode::<TerminalTokenClaims>(
        token,
        &DecodingKey::from_secret(state.public_web.terminal_token_secret.as_bytes()),
        &validation,
    )
    .map_err(|_| GatewayHttpError(StargateError::Unauthorized))?;

    Ok(decoded.claims.route_username)
}

fn mint_terminal_token(state: &GatewayState, route: &RouteRecord) -> Result<String, StargateError> {
    let now = OffsetDateTime::now_utc();
    let expiry = std::cmp::min(
        route.expires_at.unix_timestamp(),
        (now + TimeDuration::seconds(TERMINAL_TOKEN_TTL_SECONDS)).unix_timestamp(),
    );
    let claims = TerminalTokenClaims {
        iss: state.public_web.terminal_token_issuer.to_string(),
        aud: state.public_web.terminal_token_audience.to_string(),
        sub: "browser-terminal".to_owned(),
        route_username: route.route_username.clone(),
        exp: u64::try_from(expiry)
            .map_err(|_| StargateError::Internal("terminal token expiry overflowed".to_owned()))?,
        iat: u64::try_from(now.unix_timestamp())
            .map_err(|_| StargateError::Internal("terminal token iat overflowed".to_owned()))?,
        jti: uuid::Uuid::new_v4().to_string(),
    };

    encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(state.public_web.terminal_token_secret.as_bytes()),
    )
    .map_err(|error| StargateError::Internal(error.to_string()))
}

fn validate_origin(headers: &HeaderMap, state: &GatewayState) -> Result<(), GatewayHttpError> {
    let origin = headers
        .get(header::ORIGIN)
        .ok_or(StargateError::Unauthorized)?
        .to_str()
        .map_err(|_| StargateError::Unauthorized)?;
    if state
        .public_web
        .allowed_origins
        .iter()
        .any(|allowed| allowed == origin)
    {
        Ok(())
    } else {
        Err(GatewayHttpError(StargateError::Unauthorized))
    }
}
