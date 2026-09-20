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
use stargate_core::{SessionKind, StargateError, StoredTerminalRoute};
use time::{Duration as TimeDuration, OffsetDateTime};
use tokio::{
    sync::mpsc,
    time::{self as tokio_time, Instant},
};

use crate::{
    GatewayHttpError, GatewayState, SessionLease,
    outbound::{BridgeEvent, PtyBridgeOptions, spawn_pty_bridge},
};

const MAX_FRAME_BYTES: usize = 64 * 1024;
const SOCKET_OUTPUT_CAPACITY: usize = 32;
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);
const PING_INTERVAL: Duration = Duration::from_secs(30);
/// How long a browser socket waits for the admin attach before it stops.
pub const TARGET_ATTACH_TIMEOUT: Duration = Duration::from_secs(45);
const TERMINAL_TOKEN_TTL_SECONDS: i64 = 5 * 60;
const TERMINAL_TOKEN_SUBJECT: &str = "browser-terminal";
const DEFAULT_TERM: &str = "xterm-256color";
const MAX_TERMINAL_COLS: u16 = 1000;
const MAX_TERMINAL_ROWS: u16 = 1000;

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
    /// The route exists and the socket is open. The target has not attached
    /// yet, so the gateway has not dialled the guest.
    Pending,
    /// The PTY is open and the recording is intact.
    Ready,
    Exit {
        code: u32,
    },
    Error {
        message: &'a str,
    },
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
    /// The route generation this token was minted for. The claim is mandatory
    /// and has no default, so a token from an older gateway fails to decode.
    generation: String,
    exp: u64,
    iat: u64,
    jti: String,
}

/// The route a terminal token authorizes. A token is bound to one generation
/// of one route: the route name alone would let a token that was minted before
/// a replacement open the replacement route.
struct TerminalTokenRoute {
    route_username: String,
    generation: String,
}

/// The terminal size the browser asked for. The reader holds the latest value,
/// so a resize that arrives while the route is pending is not lost.
#[derive(Clone, Copy)]
struct TerminalSize {
    cols: u16,
    rows: u16,
}

#[tracing::instrument(name = "terminal.authenticate", skip_all)]
pub async fn terminal_websocket(
    ws: WebSocketUpgrade,
    State(state): State<GatewayState>,
    headers: HeaderMap,
    Query(query): Query<TerminalWebSocketQuery>,
) -> Result<Response, GatewayHttpError> {
    validate_origin(&headers, &state).inspect_err(|_| {
        tracing::warn!(
            event = "security.webssh_auth",
            outcome = "rejected",
            reason = "origin_not_allowed",
            "browser terminal admission rejected"
        );
    })?;
    let token_route = validate_terminal_token(&state, query.token.as_deref())
        .await
        .inspect_err(|_| {
            tracing::warn!(
                event = "security.webssh_auth",
                outcome = "rejected",
                reason = "invalid_token",
                "browser terminal admission rejected"
            );
        })?;
    let route_username = token_route.route_username.clone();
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
    .ok_or(StargateError::Unauthorized)
    .inspect_err(|_| {
        tracing::warn!(
            event = "security.webssh_auth",
            outcome = "rejected",
            reason = "route_unavailable",
            "browser terminal admission rejected"
        );
    })?;
    if admission_cancel.is_cancelled() {
        tracing::warn!(
            event = "security.webssh_auth",
            outcome = "rejected",
            reason = "route_revoked",
            "browser terminal admission rejected"
        );
        return Err(GatewayHttpError(StargateError::Unauthorized));
    }
    // Compare the generation before the socket claim and the upgrade. The
    // route that the control plane replaced has its own authorization, and a
    // token minted for the previous generation proves nothing about it. This
    // also keeps the rejected attempt from taking the socket slot or leaving a
    // live lease behind.
    if route.generation != token_route.generation {
        tracing::warn!(
            event = "security.webssh_auth",
            outcome = "rejected",
            reason = "generation_mismatch",
            route_username,
            "browser terminal admission rejected"
        );
        return Err(GatewayHttpError(StargateError::Unauthorized));
    }
    // One live socket per route generation. A second browser tab for the same
    // generation is refused here, before the upgrade, so it can not race the
    // first socket for one PTY.
    let Some(socket_claim) = state
        .terminal_sockets
        .open(route.route_username.clone(), route.generation.clone())
    else {
        tracing::warn!(
            event = "security.webssh_auth",
            outcome = "rejected",
            reason = "duplicate_socket",
            route_username,
            "browser terminal admission rejected"
        );
        return Err(GatewayHttpError(StargateError::TerminalSocketAlreadyOpen));
    };
    tracing::info!(
        event = "security.webssh_auth",
        outcome = "accepted",
        route_username,
        "browser terminal admitted"
    );

    Ok(ws
        .max_frame_size(MAX_FRAME_BYTES)
        .max_message_size(MAX_FRAME_BYTES)
        .on_upgrade(move |socket| handle_socket(socket, state, route, lease, socket_claim)))
}

pub(crate) fn build_terminal_websocket_url(
    state: &GatewayState,
    route: &StoredTerminalRoute,
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

async fn handle_socket(
    socket: WebSocket,
    state: GatewayState,
    route: StoredTerminalRoute,
    lease: SessionLease,
    socket_claim: crate::TerminalSocketClaim,
) {
    if let Err(error) = run_terminal_socket(socket, state, route, lease).await {
        tracing::warn!(error = %error, "browser terminal websocket failed");
    }
    // The claim releases its own slot by identity. A socket that already lost
    // the slot can not evict the socket that replaced it.
    drop(socket_claim);
}

#[tracing::instrument(name = "terminal.session", skip_all, fields(route_username = route.route_username))]
async fn run_terminal_socket(
    socket: WebSocket,
    state: GatewayState,
    route: StoredTerminalRoute,
    lease: SessionLease,
) -> Result<(), StargateError> {
    let cancel = lease.token();
    let expires_at = route.expires_at;
    let (socket_sink, socket_stream) = socket.split();
    let (output_tx, output_rx) = mpsc::channel(SOCKET_OUTPUT_CAPACITY);
    let (activity_tx, activity_rx) = mpsc::channel(1);
    // The reader owns the PTY, so the socket tells the reader when the browser
    // asked for a terminal. The channel holds one value: the latest size.
    let (open_tx, open_rx) = mpsc::channel::<TerminalSize>(1);
    // Terminal input travels on its own bounded channel. The reader stops
    // reading the socket when this channel is full, so a slow guest applies
    // backpressure instead of an unbounded queue.
    let (input_tx, input_rx) = mpsc::channel::<Vec<u8>>(SOCKET_OUTPUT_CAPACITY);

    send_control(&output_tx, &cancel, &ServerControlMessage::Pending, false).await?;

    let input = pump_socket_input(
        socket_stream,
        cancel.clone(),
        output_tx.clone(),
        activity_tx,
        open_tx,
        input_tx,
    );
    let output = pump_socket_output(socket_sink, output_rx, cancel.clone());
    let idle = wait_for_idle(activity_rx, cancel.clone());
    let expiry = wait_until(expires_at);
    let terminal = run_attached_terminal(
        state,
        route,
        &lease,
        cancel.clone(),
        open_rx,
        input_rx,
        output_tx,
    );
    tokio::pin!(input);
    tokio::pin!(output);
    tokio::pin!(idle);
    tokio::pin!(expiry);
    tokio::pin!(terminal);

    let result = tokio::select! {
        _ = cancel.cancelled() => Ok(()),
        result = &mut input => result,
        result = &mut output => result,
        _ = &mut idle => Ok(()),
        _ = &mut expiry => Ok(()),
        result = &mut terminal => result,
    };
    cancel.cancel();
    result
}

/// Wait for the route target, then wait for the browser to ask for a PTY, then
/// open the shift. The order is the point of the cutover: the dial, the PTY,
/// and the recording all start after the target is attached and after the
/// browser is listening.
async fn run_attached_terminal(
    state: GatewayState,
    route: StoredTerminalRoute,
    lease: &SessionLease,
    cancel: tokio_util::sync::CancellationToken,
    mut open_rx: mpsc::Receiver<TerminalSize>,
    mut input_rx: mpsc::Receiver<Vec<u8>>,
    output_tx: mpsc::Sender<SocketOutput>,
) -> Result<(), StargateError> {
    // The stored route carries the active target that activation authorized.
    // The dial uses exactly that value, never a target that a socket supplied.
    let route = match wait_for_target(&state, &route.route_username, &cancel).await {
        Ok(route) => route,
        Err(StargateError::TerminalTargetTimeout) => {
            let _ = send_control(
                &output_tx,
                &cancel,
                &ServerControlMessage::Error {
                    message: "terminal target timeout",
                },
                true,
            )
            .await;
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    let Some(size) = wait_for_open(&mut open_rx, &cancel).await else {
        return Ok(());
    };
    // Register the PTY as a child of the socket admission. A route delete or
    // revoke between the admission check and this point must stop the shift,
    // and `register_child` fails in exactly that case.
    let Some(bridge_lease) = lease.register_child(SessionKind::BrowserTerminal, None) else {
        return Ok(());
    };
    let (controller, mut events) = spawn_pty_bridge(
        state.host_relays.clone(),
        route,
        PtyBridgeOptions {
            term: DEFAULT_TERM.to_owned(),
            cols: size.cols,
            rows: size.rows,
            command: None,
        },
        bridge_lease.token(),
    )
    .map_err(|error| StargateError::Internal(error.to_string()))?;

    // Report `ready` only when the shift is intact: a bridge that fails during
    // its handshake is an error, not a working terminal.
    tokio::select! {
        _ = cancel.cancelled() => return Ok(()),
        result = send_control(&output_tx, &cancel, &ServerControlMessage::Ready, false) => {
            result?;
        }
        event = events.recv() => {
            if !matches!(event, Some(BridgeEvent::Stdout(_))) {
                let _ = send_control(
                    &output_tx,
                    &cancel,
                    &ServerControlMessage::Error {
                        message: "terminal session failed",
                    },
                    true,
                )
                .await;
                return Ok(());
            }
        }
    }

    let resize = async {
        while let Some(size) = open_rx.recv().await {
            controller.resize(size.cols, size.rows).await;
        }
    };
    let keyboard = async {
        while let Some(data) = input_rx.recv().await {
            controller.send_input(data).await;
        }
    };
    tokio::select! {
        _ = cancel.cancelled() => {}
        _ = forward_bridge_events(events, output_tx, cancel.clone()) => {}
        _ = keyboard => {}
        _ = resize => {}
    }
    controller.terminate();
    Ok(())
}

/// Subscribe, then read the stored route. An activation that lands between the
/// two steps is visible in the read, so no notification is lost. The call
/// returns the route only when the target is ACTIVE: a staged target keeps the
/// socket waiting, which is what holds the SSH dial until the control plane
/// activates it.
async fn wait_for_target(
    state: &GatewayState,
    route_username: &str,
    cancel: &tokio_util::sync::CancellationToken,
) -> Result<StoredTerminalRoute, StargateError> {
    let mut attach = state.terminal_route_targets.subscribe(route_username);
    let deadline = tokio_time::Instant::now() + TARGET_ATTACH_TIMEOUT;
    loop {
        match state.store.get_route(route_username).await? {
            None => return Err(StargateError::Unauthorized),
            Some(stored) => {
                if stored.ready_target().is_some() {
                    return Ok(stored);
                }
            }
        }
        tokio::select! {
            _ = cancel.cancelled() => return Err(StargateError::Unauthorized),
            _ = attach.changed() => {}
            _ = tokio_time::sleep_until(deadline) => {
                return Err(StargateError::TerminalTargetTimeout);
            }
        }
    }
}

/// Return the size of the PTY the browser asked for. `None` means the socket
/// closed before the browser asked for a terminal.
async fn wait_for_open(
    open_rx: &mut mpsc::Receiver<TerminalSize>,
    cancel: &tokio_util::sync::CancellationToken,
) -> Option<TerminalSize> {
    tokio::select! {
        _ = cancel.cancelled() => None,
        size = open_rx.recv() => size,
    }
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
    cancel: tokio_util::sync::CancellationToken,
    output_tx: mpsc::Sender<SocketOutput>,
    activity_tx: mpsc::Sender<()>,
    open_tx: mpsc::Sender<TerminalSize>,
    input_tx: mpsc::Sender<Vec<u8>>,
) -> Result<(), StargateError> {
    let result = pump_socket_input_inner(
        &mut socket,
        &cancel,
        &output_tx,
        &activity_tx,
        &open_tx,
        &input_tx,
    )
    .await;

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
    cancel: &tokio_util::sync::CancellationToken,
    output_tx: &mpsc::Sender<SocketOutput>,
    activity_tx: &mpsc::Sender<()>,
    open_tx: &mpsc::Sender<TerminalSize>,
    input_tx: &mpsc::Sender<Vec<u8>>,
) -> Result<(), StargateError> {
    // The browser may ask for its PTY before the target attaches. The request
    // is held here as one bounded value, so no queue can grow.
    let mut requested = false;

    loop {
        let message = tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            message = socket.next() => message,
        };

        match message {
            // Terminal input has no meaning before the PTY exists. Drop it: a
            // queue here would replay stale keystrokes into a later shift.
            Some(Ok(Message::Binary(data))) => {
                if requested {
                    tokio::select! {
                        _ = cancel.cancelled() => return Ok(()),
                        sent = input_tx.send(data.to_vec()) => {
                            if sent.is_err() {
                                return Ok(());
                            }
                        }
                    }
                    record_activity(activity_tx);
                }
            }
            Some(Ok(Message::Text(text))) => {
                let message: ClientControlMessage = serde_json::from_str(text.as_str())?;
                match message {
                    ClientControlMessage::Open { cols, rows } => {
                        if requested {
                            return Err(StargateError::Validation(
                                "terminal is already open".to_owned(),
                            ));
                        }
                        requested = true;
                        let _ = open_tx.try_send(clamp_size(cols, rows));
                    }
                    ClientControlMessage::Resize { cols, rows } => {
                        if requested {
                            let _ = open_tx.try_send(clamp_size(cols, rows));
                        }
                    }
                    ClientControlMessage::Close => return Ok(()),
                }
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

fn clamp_size(cols: u16, rows: u16) -> TerminalSize {
    TerminalSize {
        cols: cols.clamp(1, MAX_TERMINAL_COLS),
        rows: rows.clamp(1, MAX_TERMINAL_ROWS),
    }
}

async fn pump_socket_output(
    mut socket: SplitSink<WebSocket, Message>,
    mut output_rx: mpsc::Receiver<SocketOutput>,
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
    mut events: mpsc::Receiver<BridgeEvent>,
    output_tx: mpsc::Sender<SocketOutput>,
    cancel: tokio_util::sync::CancellationToken,
) {
    loop {
        let event = tokio::select! {
            _ = cancel.cancelled() => return,
            event = events.recv() => event,
        };
        match event {
            Some(BridgeEvent::Stdout(data)) | Some(BridgeEvent::Stderr(data)) => {
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

async fn send_control(
    output_tx: &mpsc::Sender<SocketOutput>,
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
    output_tx: &mpsc::Sender<SocketOutput>,
    cancel: &tokio_util::sync::CancellationToken,
    output: SocketOutput,
) -> Result<(), StargateError> {
    tokio::select! {
        _ = cancel.cancelled() => Err(StargateError::Internal(
            "terminal session cancelled".to_owned(),
        )),
        result = output_tx.send(output) => result.map_err(|_| {
            StargateError::Internal("terminal websocket output closed".to_owned())
        }),
    }
}

fn record_activity(activity_tx: &mpsc::Sender<()>) {
    let _ = activity_tx.try_send(());
}

async fn wait_for_idle(
    mut activity_rx: mpsc::Receiver<()>,
    cancel: tokio_util::sync::CancellationToken,
) {
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
) -> Result<TerminalTokenRoute, GatewayHttpError> {
    let token = token.ok_or(StargateError::Unauthorized)?;
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_required_spec_claims(&["exp", "iss", "aud", "sub", "generation"]);
    validation.set_issuer(&[state.public_web.terminal_token_issuer.as_ref()]);
    validation.set_audience(&[state.public_web.terminal_token_audience.as_ref()]);

    let decoded = decode::<TerminalTokenClaims>(
        token,
        &DecodingKey::from_secret(state.public_web.terminal_token_secret.as_bytes()),
        &validation,
    )
    .map_err(|_| GatewayHttpError(StargateError::Unauthorized))?;
    // The audience is checked, and the subject is checked here: the decoder
    // only requires that `sub` is present.
    if decoded.claims.sub != TERMINAL_TOKEN_SUBJECT {
        return Err(GatewayHttpError(StargateError::Unauthorized));
    }

    Ok(TerminalTokenRoute {
        route_username: decoded.claims.route_username,
        generation: decoded.claims.generation,
    })
}

fn mint_terminal_token(
    state: &GatewayState,
    route: &StoredTerminalRoute,
) -> Result<String, StargateError> {
    let now = OffsetDateTime::now_utc();
    let expiry = std::cmp::min(
        route.expires_at.unix_timestamp(),
        (now + TimeDuration::seconds(TERMINAL_TOKEN_TTL_SECONDS)).unix_timestamp(),
    );
    let claims = TerminalTokenClaims {
        iss: state.public_web.terminal_token_issuer.to_string(),
        aud: state.public_web.terminal_token_audience.to_string(),
        sub: TERMINAL_TOKEN_SUBJECT.to_owned(),
        route_username: route.route_username.clone(),
        generation: route.generation.clone(),
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
    use std::{net::SocketAddr, time::Duration};

    use stargate_core::{
        AdminAuthSettings, RouteMetadata, StoredTarget, StoredTerminalRoute, TerminalSessionMode,
        TerminalTarget, TerminalTokenSettings, WebSettings,
    };
    use time::OffsetDateTime;

    use crate::{GatewayState, SqliteRouteStore};

    use super::{
        TERMINAL_TOKEN_SUBJECT, TerminalSize, clamp_size, mint_terminal_token,
        validate_terminal_token, wait_for_target,
    };

    /// Mint a terminal token by hand, so a test can send a claim set that the
    /// gateway no longer issues.
    fn hand_minted_token(claims: serde_json::Value) -> String {
        let mut header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256);
        header.typ = Some("JWT".to_owned());
        jsonwebtoken::encode(
            &header,
            &claims,
            &jsonwebtoken::EncodingKey::from_secret("terminal-secret".as_bytes()),
        )
        .expect("hand minted token")
    }

    fn token_claims(generation: Option<&str>, subject: &str) -> serde_json::Value {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let mut claims = serde_json::json!({
            "iss": "stargate",
            "aud": "stargate-terminal",
            "sub": subject,
            "route_username": "run-01-web",
            "exp": now + 300,
            "iat": now,
            "jti": "00000000-0000-4000-8000-000000000000",
        });
        if let Some(generation) = generation {
            claims["generation"] = serde_json::json!(generation);
        }
        claims
    }

    /// The route name alone is not authorization. A token from an older
    /// gateway carries no generation, and it must not open a route at all.
    #[tokio::test]
    async fn a_token_without_a_generation_claim_is_refused() -> anyhow::Result<()> {
        let (_temp_dir, state) = test_gateway_state().await?;
        let token = hand_minted_token(token_claims(None, TERMINAL_TOKEN_SUBJECT));

        assert!(
            validate_terminal_token(&state, Some(&token)).await.is_err(),
            "a token without a generation claim was accepted"
        );
        Ok(())
    }

    /// `sub` is only required to be present during decoding, so the gateway
    /// checks its value itself.
    #[tokio::test]
    async fn a_token_with_another_subject_is_refused() -> anyhow::Result<()> {
        let (_temp_dir, state) = test_gateway_state().await?;
        let token = hand_minted_token(token_claims(Some("exec-01:7"), "browser"));

        assert!(
            validate_terminal_token(&state, Some(&token)).await.is_err(),
            "a token with another subject was accepted"
        );
        Ok(())
    }

    /// A minted token names the route and the generation it is bound to, and
    /// the gateway takes both values from it.
    #[tokio::test]
    async fn a_minted_token_names_its_route_and_generation() -> anyhow::Result<()> {
        let (_temp_dir, state) = test_gateway_state().await?;
        let route = pending_route();
        let token = mint_terminal_token(&state, &route)?;

        let decoded = validate_terminal_token(&state, Some(&token))
            .await
            .expect("a minted token must validate");

        assert_eq!(decoded.route_username, route.route_username);
        assert_eq!(decoded.generation, route.generation);
        Ok(())
    }

    #[test]
    fn terminal_size_is_bounded() {
        let TerminalSize { cols, rows } = clamp_size(0, 0);
        assert_eq!((cols, rows), (1, 1));
        let TerminalSize { cols, rows } = clamp_size(u16::MAX, u16::MAX);
        assert_eq!((cols, rows), (1000, 1000));
        let TerminalSize { cols, rows } = clamp_size(120, 40);
        assert_eq!((cols, rows), (120, 40));
    }

    #[tokio::test]
    async fn a_pending_route_keeps_the_socket_waiting_without_a_target() -> anyhow::Result<()> {
        let (_temp_dir, state) = test_gateway_state().await?;
        state.store.upsert_route(pending_route()).await?;

        let cancel = tokio_util::sync::CancellationToken::new();
        let wait = wait_for_target(&state, "run-01-web", &cancel);
        tokio::pin!(wait);
        assert!(
            tokio::time::timeout(Duration::from_millis(50), wait.as_mut())
                .await
                .is_err(),
            "a pending route must wait for the attach instead of returning a target"
        );

        cancel.cancel();
        assert!(wait.await.is_err());
        Ok(())
    }

    /// The two phases, end to end at the socket boundary. A stage stores the
    /// target and the waiting socket stays parked, so nothing dials the guest.
    /// Only the activation wakes it.
    #[tokio::test]
    async fn only_activation_wakes_the_waiting_socket() -> anyhow::Result<()> {
        let (_temp_dir, state) = test_gateway_state().await?;
        state.store.upsert_route(pending_route()).await?;
        let target = ready_target();

        let cancel = tokio_util::sync::CancellationToken::new();
        let wait = tokio::spawn({
            let state = state.clone();
            let cancel = cancel.clone();
            async move { wait_for_target(&state, "run-01-web", &cancel).await }
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        let staged = state
            .stage_target(
                "run-01-web",
                "run-01",
                "vm-01",
                "user-01",
                "exec-01:7",
                target.clone(),
            )
            .await?;
        let attachment_id = match staged {
            crate::StageOutcome::Staged { attachment_id } => attachment_id,
            other => anyhow::bail!("stage returned {other:?}"),
        };

        // The stage is stored, and the socket is still waiting: no dial, no
        // PTY, and no recording before the control plane activates.
        let stored = state
            .store
            .get_route("run-01-web")
            .await?
            .expect("route stays");
        assert!(stored.ready_target().is_none());
        assert_eq!(stored.target.attachment_id(), Some(attachment_id.as_str()));

        state
            .activate_staged_target(
                "run-01-web",
                "run-01",
                "vm-01",
                "user-01",
                "exec-01:7",
                &attachment_id,
            )
            .await?;

        let activated = tokio::time::timeout(Duration::from_secs(1), wait)
            .await
            .expect("the waiting socket must wake on the activation")??;
        assert_eq!(
            activated.ready_target(),
            Some(&target),
            "the socket must read the active target"
        );

        // A socket that reads after the activation must still find it.
        let late = wait_for_target(&state, "run-01-web", &cancel).await?;
        assert_eq!(late.ready_target(), Some(&target));
        Ok(())
    }

    /// Concurrent stages and concurrent activations are idempotent inside one
    /// gateway process. The route mutation mutex serializes each read-modify-
    /// write pair, so exactly one attachment wins and every other call returns
    /// the same answer. Two processes sharing one database file are outside
    /// this contract; the busy timeout on the connection only bounds the wait.
    #[tokio::test]
    async fn concurrent_stages_and_activations_are_idempotent() -> anyhow::Result<()> {
        let (_temp_dir, state) = test_gateway_state().await?;
        state.store.upsert_route(pending_route()).await?;
        let target = ready_target();

        let (first, second) = tokio::join!(
            state.stage_target(
                "run-01-web",
                "run-01",
                "vm-01",
                "user-01",
                "exec-01:7",
                target.clone()
            ),
            state.stage_target(
                "run-01-web",
                "run-01",
                "vm-01",
                "user-01",
                "exec-01:7",
                target.clone()
            ),
        );
        let ids = [first?, second?]
            .into_iter()
            .map(|outcome| match outcome {
                crate::StageOutcome::Staged { attachment_id }
                | crate::StageOutcome::AlreadyStaged { attachment_id } => Ok(attachment_id),
                other => anyhow::bail!("a concurrent stage returned {other:?}"),
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        assert_eq!(
            ids[0], ids[1],
            "concurrent stages must agree on one attachment"
        );

        let (first, second) = tokio::join!(
            state.activate_staged_target(
                "run-01-web",
                "run-01",
                "vm-01",
                "user-01",
                "exec-01:7",
                &ids[0]
            ),
            state.activate_staged_target(
                "run-01-web",
                "run-01",
                "vm-01",
                "user-01",
                "exec-01:7",
                &ids[0]
            ),
        );
        for outcome in [first?, second?] {
            assert!(
                matches!(
                    outcome,
                    crate::ActivateOutcome::Activated | crate::ActivateOutcome::AlreadyActive
                ),
                "a concurrent activation returned {outcome:?}"
            );
        }

        let stored = state
            .store
            .get_route("run-01-web")
            .await?
            .expect("route stays");
        assert_eq!(stored.ready_target(), Some(&target));
        assert_eq!(stored.target.attachment_id(), Some(ids[0].as_str()));
        Ok(())
    }

    #[tokio::test]
    async fn a_stage_with_another_identity_leaves_the_route_pending() -> anyhow::Result<()> {
        let (_temp_dir, state) = test_gateway_state().await?;
        state.store.upsert_route(pending_route()).await?;
        let target = ready_target();

        for (run_id, vm_id, user_id, generation) in [
            ("run-02", "vm-01", "user-01", "exec-01:7"),
            ("run-01", "vm-02", "user-01", "exec-01:7"),
            ("run-01", "vm-01", "user-02", "exec-01:7"),
            ("run-01", "vm-01", "user-01", "exec-01:8"),
            ("", "vm-01", "user-01", "exec-01:7"),
        ] {
            assert_eq!(
                state
                    .stage_target(
                        "run-01-web",
                        run_id,
                        vm_id,
                        user_id,
                        generation,
                        target.clone()
                    )
                    .await?,
                crate::StageOutcome::IdentityMismatch,
                "a stage with another identity must not stage"
            );
        }
        let stored = state
            .store
            .get_route("run-01-web")
            .await?
            .expect("route stays");
        assert!(stored.ready_target().is_none());
        Ok(())
    }

    #[tokio::test]
    async fn a_deleted_route_can_not_be_staged_or_waited_on() -> anyhow::Result<()> {
        let (_temp_dir, state) = test_gateway_state().await?;
        state.store.upsert_route(pending_route()).await?;
        let target = ready_target();
        assert!(state.store.delete_route("run-01-web").await?);

        assert_eq!(
            state
                .stage_target(
                    "run-01-web",
                    "run-01",
                    "vm-01",
                    "user-01",
                    "exec-01:7",
                    target
                )
                .await?,
            crate::StageOutcome::RouteNotFound,
            "a deleted route can not be staged"
        );
        let cancel = tokio_util::sync::CancellationToken::new();
        assert!(
            wait_for_target(&state, "run-01-web", &cancel)
                .await
                .is_err()
        );
        Ok(())
    }

    fn pending_route() -> StoredTerminalRoute {
        let now = OffsetDateTime::now_utc();
        StoredTerminalRoute {
            route_username: "run-01-web".to_owned(),
            generation: "exec-01:7".to_owned(),
            expires_at: now + time::Duration::hours(1),
            mode: TerminalSessionMode::Browser,
            metadata: RouteMetadata {
                host_id: "host-01".to_owned(),
                run_id: "run-01".to_owned(),
                vm_id: "vm-01".to_owned(),
                user_id: "user-01".to_owned(),
            },
            target: StoredTarget::Missing,
            created_at: now,
            updated_at: now,
        }
    }

    fn ready_target() -> TerminalTarget {
        let mut rng = russh::keys::key::safe_rng();
        let host_key =
            russh::keys::PrivateKey::random(&mut rng, russh::keys::ssh_key::Algorithm::Ed25519)
                .expect("host key");
        let private_key =
            russh::keys::PrivateKey::random(&mut rng, russh::keys::ssh_key::Algorithm::Ed25519)
                .expect("private key");
        let client_key =
            russh::keys::PrivateKey::random(&mut rng, russh::keys::ssh_key::Algorithm::Ed25519)
                .expect("client key");
        TerminalTarget {
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
            authorized_client_public_keys_openssh: vec![
                client_key.public_key().to_openssh().expect("client key"),
            ],
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
