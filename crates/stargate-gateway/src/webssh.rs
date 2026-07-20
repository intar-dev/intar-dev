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
use futures_util::{
    SinkExt, StreamExt,
    stream::{SplitSink, SplitStream},
};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};
use stargate_core::{RouteRecord, SessionKind, StargateError};
use time::{Duration as TimeDuration, OffsetDateTime};
use tokio::{
    sync::mpsc::{self, Receiver, Sender},
    time::{self as tokio_time, Instant},
};

use crate::{
    GatewayHttpError, GatewayState, SessionLease,
    outbound::{BridgeEvent, PtyBridgeControl, PtyBridgeOptions, spawn_pty_bridge},
};

const MAX_FRAME_BYTES: usize = 64 * 1024;
const SOCKET_OUTPUT_CAPACITY: usize = 32;
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

struct SocketOutput {
    message: Message,
    close_after: bool,
}

impl SocketOutput {
    fn message(message: Message) -> Self {
        Self {
            message,
            close_after: false,
        }
    }

    fn final_message(message: Message) -> Self {
        Self {
            message,
            close_after: true,
        }
    }
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
    // Register before the route lookup so a concurrent assist revoke or
    // workspace teardown cannot fall between authorization and the WebSocket
    // upgrade. A cancelled admission lease is carried into the socket task.
    let lease = state
        .sessions
        .register(route_username.clone(), SessionKind::BrowserTerminal, None);
    let admission_cancel = lease.token();
    let route = tokio::select! {
        _ = admission_cancel.cancelled() => None,
        route = state.store.get_route(&route_username) => route?,
    }
    .ok_or(StargateError::Unauthorized)?;
    if admission_cancel.is_cancelled() {
        return Err(GatewayHttpError(StargateError::Unauthorized));
    }

    Ok(ws
        .max_frame_size(MAX_FRAME_BYTES)
        .max_message_size(MAX_FRAME_BYTES)
        .on_upgrade(move |socket| handle_socket(socket, route, lease)))
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

async fn handle_socket(socket: WebSocket, route: RouteRecord, lease: SessionLease) {
    if let Err(error) = run_terminal_socket(socket, route, lease).await {
        tracing::warn!(error = %error, "browser terminal websocket failed");
    }
}

async fn run_terminal_socket(
    socket: WebSocket,
    route: RouteRecord,
    lease: SessionLease,
) -> Result<(), StargateError> {
    let cancel = lease.token();
    let expires_at = route.expires_at;
    let (socket_sink, socket_stream) = socket.split();
    let (output_tx, output_rx) = mpsc::channel(SOCKET_OUTPUT_CAPACITY);
    let (activity_tx, activity_rx) = mpsc::channel(1);

    let input = pump_socket_input(
        socket_stream,
        route,
        cancel.clone(),
        output_tx.clone(),
        activity_tx,
    );
    let output = pump_socket_output(socket_sink, output_rx, cancel.clone());
    let idle = wait_for_idle(activity_rx, cancel.clone());
    let expiry = wait_until(expires_at);
    tokio::pin!(input);
    tokio::pin!(output);
    tokio::pin!(idle);
    tokio::pin!(expiry);

    let result = tokio::select! {
        _ = cancel.cancelled() => Ok(()),
        result = &mut input => result,
        result = &mut output => result,
        _ = &mut idle => Ok(()),
        _ = &mut expiry => Ok(()),
    };
    cancel.cancel();
    result
}

async fn wait_until(expires_at: OffsetDateTime) {
    let remaining = expires_at - OffsetDateTime::now_utc();
    let Ok(remaining) = Duration::try_from(remaining) else {
        return;
    };
    tokio_time::sleep(remaining).await;
}

async fn pump_socket_input(
    mut socket: SplitStream<WebSocket>,
    route: RouteRecord,
    cancel: tokio_util::sync::CancellationToken,
    output_tx: Sender<SocketOutput>,
    activity_tx: Sender<()>,
) -> Result<(), StargateError> {
    let result =
        pump_socket_input_inner(&mut socket, &route, &cancel, &output_tx, &activity_tx).await;

    if result.is_err()
        && send_control(
            &output_tx,
            &cancel,
            &ServerControlMessage::Error {
                message: "terminal session failed",
            },
            true,
        )
        .await
        .is_ok()
    {
        cancel.cancelled().await;
    }

    result
}

async fn pump_socket_input_inner(
    socket: &mut SplitStream<WebSocket>,
    route: &RouteRecord,
    cancel: &tokio_util::sync::CancellationToken,
    output_tx: &Sender<SocketOutput>,
    activity_tx: &Sender<()>,
) -> Result<(), StargateError> {
    let mut bridge: Option<PtyBridgeControl> = None;

    loop {
        let message = tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            message = socket.next() => message,
        };

        match message {
            Some(Ok(Message::Binary(data))) => {
                let Some(controller) = bridge.as_ref() else {
                    return Err(StargateError::Validation(
                        "terminal must be opened before input".to_owned(),
                    ));
                };
                controller.send_input(data.to_vec()).await;
                record_activity(activity_tx);
            }
            Some(Ok(Message::Text(text))) => {
                handle_client_control(
                    route,
                    cancel,
                    output_tx,
                    activity_tx,
                    &mut bridge,
                    text.as_str(),
                )
                .await?;
                record_activity(activity_tx);
            }
            Some(Ok(Message::Ping(payload))) => {
                send_socket_output(
                    output_tx,
                    cancel,
                    SocketOutput::message(Message::Pong(payload)),
                )
                .await?;
                record_activity(activity_tx);
            }
            Some(Ok(Message::Pong(_))) => record_activity(activity_tx),
            Some(Ok(Message::Close(_))) | None => return Ok(()),
            Some(Err(error)) => return Err(StargateError::Internal(error.to_string())),
        }
    }
}

async fn pump_socket_output(
    mut socket: SplitSink<WebSocket, Message>,
    mut output_rx: Receiver<SocketOutput>,
    cancel: tokio_util::sync::CancellationToken,
) -> Result<(), StargateError> {
    let mut ping_interval = tokio_time::interval(PING_INTERVAL);
    ping_interval.set_missed_tick_behavior(tokio_time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            _ = ping_interval.tick() => {
                socket
                    .send(Message::Ping(Bytes::new()))
                    .await
                    .map_err(|error| StargateError::Internal(error.to_string()))?;
            }
            output = output_rx.recv() => {
                let Some(output) = output else {
                    return Ok(());
                };
                socket
                    .send(output.message)
                    .await
                    .map_err(|error| StargateError::Internal(error.to_string()))?;
                if output.close_after {
                    let _ = socket.close().await;
                    cancel.cancel();
                    return Ok(());
                }
            }
        }
    }
}

async fn forward_bridge_events(
    mut events: Receiver<BridgeEvent>,
    output_tx: Sender<SocketOutput>,
    activity_tx: Sender<()>,
    cancel: tokio_util::sync::CancellationToken,
) {
    loop {
        let event = tokio::select! {
            _ = cancel.cancelled() => return,
            event = events.recv() => event,
        };
        match event {
            Some(BridgeEvent::Stdout(data)) | Some(BridgeEvent::Stderr(data)) => {
                record_activity(&activity_tx);
                if send_socket_output(
                    &output_tx,
                    &cancel,
                    SocketOutput::message(Message::Binary(Bytes::from(data))),
                )
                .await
                .is_err()
                {
                    return;
                }
            }
            Some(BridgeEvent::Exit(code)) => {
                let Ok(message) = control_message(&ServerControlMessage::Exit { code }) else {
                    return;
                };
                let _ =
                    send_socket_output(&output_tx, &cancel, SocketOutput::final_message(message))
                        .await;
                return;
            }
            None => {
                let _ = send_socket_output(
                    &output_tx,
                    &cancel,
                    SocketOutput::final_message(Message::Close(None)),
                )
                .await;
                return;
            }
        }
    }
}

async fn handle_client_control(
    route: &RouteRecord,
    cancel: &tokio_util::sync::CancellationToken,
    output_tx: &Sender<SocketOutput>,
    activity_tx: &Sender<()>,
    bridge: &mut Option<PtyBridgeControl>,
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
                PtyBridgeOptions {
                    term: DEFAULT_TERM.to_owned(),
                    cols: cols.max(1),
                    rows: rows.max(1),
                    command: None,
                },
                cancel.clone(),
            )
            .map_err(|error| StargateError::Internal(error.to_string()))?;
            send_control(output_tx, cancel, &ServerControlMessage::Ready, false).await?;
            std::mem::drop(tokio::spawn(forward_bridge_events(
                events,
                output_tx.clone(),
                activity_tx.clone(),
                cancel.clone(),
            )));
            *bridge = Some(controller);
        }
        ClientControlMessage::Resize { cols, rows } => {
            let Some(controller) = bridge.as_ref() else {
                return Err(StargateError::Validation("terminal is not open".to_owned()));
            };
            controller.resize(cols.max(1), rows.max(1)).await;
        }
        ClientControlMessage::Close => {
            if let Some(controller) = bridge.as_ref() {
                controller.terminate();
            }
        }
    }
    Ok(())
}

async fn send_control(
    output_tx: &Sender<SocketOutput>,
    cancel: &tokio_util::sync::CancellationToken,
    message: &ServerControlMessage<'_>,
    close_after: bool,
) -> Result<(), StargateError> {
    let message = control_message(message)?;
    let output = if close_after {
        SocketOutput::final_message(message)
    } else {
        SocketOutput::message(message)
    };
    send_socket_output(output_tx, cancel, output).await
}

fn control_message(message: &ServerControlMessage<'_>) -> Result<Message, StargateError> {
    Ok(Message::Text(serde_json::to_string(message)?.into()))
}

async fn send_socket_output(
    output_tx: &Sender<SocketOutput>,
    cancel: &tokio_util::sync::CancellationToken,
    output: SocketOutput,
) -> Result<(), StargateError> {
    tokio::select! {
        _ = cancel.cancelled() => Err(StargateError::Internal("terminal session cancelled".to_owned())),
        result = output_tx.send(output) => result
            .map_err(|_| StargateError::Internal("terminal websocket output closed".to_owned())),
    }
}

fn record_activity(activity_tx: &Sender<()>) {
    let _ = activity_tx.try_send(());
}

async fn wait_for_idle(mut activity_rx: Receiver<()>, cancel: tokio_util::sync::CancellationToken) {
    let deadline = tokio_time::sleep(IDLE_TIMEOUT);
    tokio::pin!(deadline);

    loop {
        tokio::select! {
            _ = cancel.cancelled() => return,
            _ = &mut deadline => return,
            activity = activity_rx.recv() => {
                if activity.is_none() {
                    return;
                }
                deadline.as_mut().reset(Instant::now() + IDLE_TIMEOUT);
            }
        }
    }
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

#[cfg(test)]
mod tests {
    use std::{task::Poll, time::Duration};

    use futures_util::{pin_mut, poll};
    use tokio::sync::mpsc;
    use tokio_util::sync::CancellationToken;

    use stargate_core::SessionKind;

    use crate::SessionRegistry;

    use super::{BridgeEvent, Message, forward_bridge_events};

    #[tokio::test]
    async fn route_revoke_cancels_a_pre_upgrade_browser_admission() {
        let registry = SessionRegistry::default();
        let lease = registry.register(
            "workshop-helper-route".to_owned(),
            SessionKind::BrowserTerminal,
            None,
        );
        let cancelled = lease.token();

        registry.terminate_username("workshop-helper-route").await;

        assert!(cancelled.is_cancelled());
    }

    #[tokio::test]
    async fn browser_output_progresses_while_target_input_is_permanently_blocked() {
        let (target_input_tx, _blocked_target_input_rx) = mpsc::channel(1);
        target_input_tx
            .send(vec![1_u8])
            .await
            .expect("target input queue should accept its first message");
        let blocked_input = target_input_tx.send(vec![2_u8]);
        pin_mut!(blocked_input);
        assert!(matches!(poll!(blocked_input.as_mut()), Poll::Pending));

        let (bridge_event_tx, bridge_event_rx) = mpsc::channel(1);
        bridge_event_tx
            .send(BridgeEvent::Stdout(vec![42]))
            .await
            .expect("bridge event queue should accept output");
        let (socket_output_tx, mut socket_output_rx) = mpsc::channel(1);
        let (activity_tx, _activity_rx) = mpsc::channel(1);
        let cancel = CancellationToken::new();
        let forwarder_cancel = cancel.clone();
        let forwarder = tokio::spawn(forward_bridge_events(
            bridge_event_rx,
            socket_output_tx,
            activity_tx,
            forwarder_cancel,
        ));

        let output = tokio::time::timeout(Duration::from_secs(1), socket_output_rx.recv())
            .await
            .expect("browser output must not wait for target input")
            .expect("browser output channel should stay open");
        let Message::Binary(data) = output.message else {
            panic!("expected binary terminal output");
        };
        assert_eq!(data.as_ref(), &[42]);
        assert!(matches!(poll!(blocked_input.as_mut()), Poll::Pending));

        cancel.cancel();
        forwarder.await.expect("bridge event forwarder should stop");
    }
}
