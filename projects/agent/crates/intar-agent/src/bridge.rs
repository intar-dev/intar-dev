#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context as _, Result};
use futures_util::{SinkExt, StreamExt};
use reqwest::Client as HttpClient;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio::time::{MissedTickBehavior, interval, sleep, timeout};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Error as WebSocketError;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::Message;
use tracing::{debug, info, warn};

use crate::bridge_core::{InboundBatchPlan, plan_inbound_batch};
use crate::config::BridgeConfig;
use crate::db::{
    Db, InventorySnapshotRow, RPC_DIRECTION_HOST_TO_SERVER, RPC_DIRECTION_SERVER_TO_HOST,
    RPC_KIND_REQUEST, RPC_KIND_RESPONSE, RpcCallRow, RpcEnvelopeInput, RpcEnvelopeRow,
};
use crate::host_profile;
use crate::vm::{CreateScenarioVmRequest, VmManager, VmTerminalState};

const PROTOCOL_VERSION: i64 = 3;
const OUTBOUND_BATCH_LIMIT: usize = 64;
const RETRY_MIN_MS: u64 = 1_000;
const RETRY_MAX_MS: u64 = 30_000;
const DB_RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const SERVER_HELLO_TIMEOUT_SECS: u64 = 10;

#[derive(Debug, Clone, PartialEq, Eq)]
enum InventorySnapshotDecision {
    Skip,
    Reuse(InventorySnapshotRow),
    Store(InventorySnapshotRow),
}

struct ProbeSnapshotEvent<'a> {
    run_id: &'a str,
    vm_name: &'a str,
    generated_at_ms: i64,
    fingerprint: &'a str,
    payload_json: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VmTerminalStateRequest {
    run_id: String,
    vm_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentBootstrapRequest<'a> {
    host_id: &'a str,
    bootstrap_token: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentBootstrapResponse {
    access_token: String,
    ws_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ServerMessage {
    ServerHello(ServerHelloMessage),
    ServerBatch(ServerBatchMessage),
    HostAck(HostAckMessage),
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMessage {
    ClientHello(ClientHelloMessage),
    Telemetry(TelemetryMessage),
    HostBatch(HostBatchMessage),
    ServerAck(ServerAckMessage),
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientHelloMessage {
    protocol_version: i64,
    host_id: String,
    session_id: String,
    agent_version: String,
    host_transport_id: String,
    server_transport_id: Option<String>,
    server_acked_seq: i64,
    host_acked_seq: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerHelloMessage {
    protocol_version: i64,
    host_id: String,
    session_id: String,
    server_transport_id: String,
    host_transport_id: String,
    server_acked_seq: i64,
    host_acked_seq: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TelemetryMessage {
    session_id: String,
    message_id: String,
    method: String,
    occurred_at: i64,
    payload: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerBatchMessage {
    session_id: String,
    first_seq: i64,
    last_seq: i64,
    host_ack_upto: i64,
    envelopes: Vec<RpcEnvelope>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostBatchMessage {
    session_id: String,
    first_seq: i64,
    last_seq: i64,
    server_ack_upto: i64,
    envelopes: Vec<RpcEnvelope>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerAckMessage {
    session_id: String,
    ack_upto: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostAckMessage {
    session_id: String,
    ack_upto: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RpcEnvelope {
    message_id: String,
    call_id: Option<String>,
    kind: String,
    method: String,
    occurred_at: i64,
    payload: Map<String, Value>,
}

pub async fn run(cfg: BridgeConfig, vm: VmManager, db: Db, disk_probe_path: PathBuf) {
    let http = match HttpClient::builder()
        .timeout(Duration::from_secs(30))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            warn!(error = %error, "bridge http client init failed");
            return;
        }
    };

    let mut retry_ms = RETRY_MIN_MS;
    let mut last_probe_fingerprints = BTreeMap::<String, String>::new();
    let mut last_terminal_report_fingerprints = BTreeMap::<String, String>::new();

    loop {
        match connect_once(
            &cfg,
            &http,
            &vm,
            &db,
            &disk_probe_path,
            &mut last_probe_fingerprints,
            &mut last_terminal_report_fingerprints,
        )
        .await
        {
            Ok(()) => retry_ms = RETRY_MIN_MS,
            Err(error) => {
                warn!(error = %error, retry_ms, "bridge connection loop failed");
                let error_json = json!({
                    "code": "bridge_disconnected",
                    "message": error.to_string(),
                })
                .to_string();
                if let Err(fail_error) = db
                    .fail_running_inbound_calls(now_ms(), now_ms(), error_json)
                    .await
                {
                    warn!(error = %fail_error, "failed to fail running inbound calls");
                }
                sleep(Duration::from_millis(retry_ms)).await;
                retry_ms = (retry_ms.saturating_mul(2)).min(RETRY_MAX_MS);
            }
        }
    }
}

async fn connect_once(
    cfg: &BridgeConfig,
    http: &HttpClient,
    vm: &VmManager,
    db: &Db,
    disk_probe_path: &Path,
    last_probe_fingerprints: &mut BTreeMap<String, String>,
    last_terminal_report_fingerprints: &mut BTreeMap<String, String>,
) -> Result<()> {
    let bootstrap = bootstrap_agent_access(cfg, http).await?;
    let ws_url = bootstrap
        .ws_url
        .unwrap_or_else(|| default_ws_url(&cfg.base_url, &cfg.host_id));

    let mut request = ws_url
        .into_client_request()
        .context("failed to build websocket request")?;
    request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {}", bootstrap.access_token))
            .context("failed to build websocket auth header")?,
    );

    let (ws_stream, _) = connect_async(request)
        .await
        .context("failed to connect bridge websocket")?;
    info!(host_id = %cfg.host_id, "bridge websocket connected");

    let (mut write, mut read) = ws_stream.split();
    let transport = db.load_transport_state().await?;
    let session_id = new_session_id();
    let host_transport_id = match transport.host_transport_id.clone() {
        Some(existing) if !existing.trim().is_empty() => existing,
        _ => {
            let generated = new_transport_id("host");
            db.ensure_host_transport_id(generated.clone()).await?
        }
    };

    send_client_message(
        &mut write,
        &ClientMessage::ClientHello(ClientHelloMessage {
            protocol_version: PROTOCOL_VERSION,
            host_id: cfg.host_id.clone(),
            session_id: session_id.clone(),
            agent_version: env!("CARGO_PKG_VERSION").to_string(),
            host_transport_id,
            server_transport_id: transport.server_transport_id.clone(),
            server_acked_seq: transport.server_acked_seq,
            host_acked_seq: transport.host_acked_seq,
        }),
    )
    .await?;
    let server_hello = await_server_hello(&mut read, &mut write, &cfg.host_id, &session_id).await?;
    let transport_sync = db
        .sync_transport_after_server_hello(
            Some(server_hello.server_transport_id.clone()),
            server_hello.server_acked_seq,
            Some(server_hello.host_transport_id.clone()),
            server_hello.host_acked_seq,
            now_ms(),
        )
        .await?;
    if transport_sync.server_reset || transport_sync.host_reset {
        warn!(
            server_transport_id = ?transport_sync.server_transport_id,
            host_transport_id = ?transport_sync.host_transport_id,
            server_acked_seq = transport_sync.server_acked_seq,
            host_acked_seq = transport_sync.host_acked_seq,
            server_reset = transport_sync.server_reset,
            host_reset = transport_sync.host_reset,
            "transport reset inferred from server hello"
        );
    } else {
        debug!(
            server_transport_id = ?transport_sync.server_transport_id,
            host_transport_id = ?transport_sync.host_transport_id,
            server_acked_seq = transport_sync.server_acked_seq,
            host_acked_seq = transport_sync.host_acked_seq,
            "synchronized transport cursors from server hello"
        );
    }

    execute_runnable_calls(db, vm).await?;
    send_heartbeat_telemetry(&mut write, &session_id, disk_probe_path).await?;
    send_inventory_telemetry(db, &mut write, &session_id, vm, true).await?;
    send_probe_snapshot_telemetry(db, &mut write, &session_id, last_probe_fingerprints, true)
        .await?;
    send_terminal_state_reports(db, vm, last_terminal_report_fingerprints, true).await?;
    flush_outbound_batches(db, &mut write, &session_id).await?;
    let mut probe_updates = vm.subscribe_probe_updates();
    let mut terminal_updates = vm.subscribe_terminal_updates();

    let heartbeat_secs = cfg.heartbeat_interval_seconds.max(1);
    let mut heartbeat_tick = interval(Duration::from_secs(heartbeat_secs));
    heartbeat_tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut flush_tick = interval(Duration::from_secs(1));
    flush_tick.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            maybe_message = read.next() => {
                let message = match maybe_message {
                    Some(message) => message.context("bridge websocket stream error")?,
                    None => anyhow::bail!("bridge websocket closed"),
                };
                handle_server_message(db, vm, &session_id, &mut write, message).await?;
            }
            _ = heartbeat_tick.tick() => {
                execute_runnable_calls(db, vm).await?;
                flush_outbound_batches(db, &mut write, &session_id).await?;
                send_heartbeat_telemetry(&mut write, &session_id, disk_probe_path).await?;
                send_inventory_telemetry(db, &mut write, &session_id, vm, false).await?;
                send_probe_snapshot_telemetry(
                    db,
                    &mut write,
                    &session_id,
                    last_probe_fingerprints,
                    false,
                )
                .await?;
                let _ = db.prune_rpc_state(now_ms() - DB_RETENTION_MS).await;
            }
            probe_update = probe_updates.recv() => {
                match probe_update {
                    Ok(update) => {
                        send_probe_snapshot_update_telemetry(
                            &mut write,
                            &session_id,
                            last_probe_fingerprints,
                            &update,
                            false,
                        )
                            .await?;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        send_probe_snapshot_telemetry(
                            db,
                            &mut write,
                            &session_id,
                            last_probe_fingerprints,
                            false,
                        )
                        .await?;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        anyhow::bail!("probe update channel closed");
                    }
                }
            }
            terminal_update = terminal_updates.recv() => {
                match terminal_update {
                    Ok(update) => {
                        queue_terminal_state_report(
                            db,
                            last_terminal_report_fingerprints,
                            &update,
                            false,
                        )
                        .await?;
                        flush_outbound_batches(db, &mut write, &session_id).await?;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        send_terminal_state_reports(
                            db,
                            vm,
                            last_terminal_report_fingerprints,
                            false,
                        )
                        .await?;
                        flush_outbound_batches(db, &mut write, &session_id).await?;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        anyhow::bail!("terminal update channel closed");
                    }
                }
            }
            _ = flush_tick.tick() => {
                execute_runnable_calls(db, vm).await?;
                flush_outbound_batches(db, &mut write, &session_id).await?;
            }
        }
    }
}

async fn handle_server_message<S>(
    db: &Db,
    vm: &VmManager,
    session_id: &str,
    write: &mut S,
    message: Message,
) -> Result<()>
where
    S: SinkExt<Message> + Unpin,
    <S as futures_util::Sink<Message>>::Error: std::error::Error + Send + Sync + 'static,
{
    match message {
        Message::Text(text) => handle_server_text(db, vm, session_id, write, &text).await?,
        Message::Binary(data) => {
            let text =
                String::from_utf8(data.to_vec()).context("binary server message was not utf-8")?;
            handle_server_text(db, vm, session_id, write, &text).await?;
        }
        Message::Ping(payload) => {
            write
                .send(Message::Pong(payload))
                .await
                .context("failed to pong server")?;
        }
        Message::Pong(_) => {}
        Message::Close(frame) => {
            anyhow::bail!("bridge websocket closed by server: {:?}", frame);
        }
        Message::Frame(_) => {}
    }
    Ok(())
}

async fn handle_server_text<S>(
    db: &Db,
    vm: &VmManager,
    session_id: &str,
    write: &mut S,
    text: &str,
) -> Result<()>
where
    S: SinkExt<Message> + Unpin,
    <S as futures_util::Sink<Message>>::Error: std::error::Error + Send + Sync + 'static,
{
    let parsed = serde_json::from_str::<ServerMessage>(text)
        .with_context(|| format!("failed to parse server message: {text}"))?;
    match parsed {
        ServerMessage::ServerHello(_) => {
            anyhow::bail!("received unexpected server_hello after handshake");
        }
        ServerMessage::HostAck(ack) => {
            let now = now_ms();
            db.mark_outbound_acked(ack.ack_upto, now).await?;
        }
        ServerMessage::ServerBatch(batch) => {
            let now = now_ms();
            if batch.host_ack_upto > 0 {
                db.mark_outbound_acked(batch.host_ack_upto, now).await?;
            }
            apply_server_batch(db, &batch, now).await?;
            send_client_message(
                write,
                &ClientMessage::ServerAck(ServerAckMessage {
                    session_id: session_id.to_string(),
                    ack_upto: db.load_transport_state().await?.server_acked_seq,
                }),
            )
            .await?;
            execute_runnable_calls(db, vm).await?;
        }
    }
    Ok(())
}

async fn await_server_hello<R, S>(
    read: &mut R,
    write: &mut S,
    expected_host_id: &str,
    expected_session_id: &str,
) -> Result<ServerHelloMessage>
where
    R: StreamExt<Item = std::result::Result<Message, WebSocketError>> + Unpin,
    S: SinkExt<Message> + Unpin,
    <S as futures_util::Sink<Message>>::Error: std::error::Error + Send + Sync + 'static,
{
    timeout(Duration::from_secs(SERVER_HELLO_TIMEOUT_SECS), async {
        loop {
            let message = match read.next().await {
                Some(message) => message.context("bridge websocket stream error")?,
                None => anyhow::bail!("bridge websocket closed before server hello"),
            };

            match message {
                Message::Text(text) => {
                    let parsed = serde_json::from_str::<ServerMessage>(&text)
                        .with_context(|| format!("failed to parse server message: {text}"))?;
                    match parsed {
                        ServerMessage::ServerHello(hello) => {
                            validate_server_hello(
                                &hello,
                                expected_session_id,
                                Some(expected_host_id),
                            )?;
                            return Ok(hello);
                        }
                        ServerMessage::HostAck(_) => {
                            anyhow::bail!("received host_ack before server hello");
                        }
                        ServerMessage::ServerBatch(_) => {
                            anyhow::bail!("received server_batch before server hello");
                        }
                    }
                }
                Message::Binary(data) => {
                    let text = String::from_utf8(data.to_vec())
                        .context("binary server message was not utf-8")?;
                    let parsed = serde_json::from_str::<ServerMessage>(&text)
                        .with_context(|| format!("failed to parse server message: {text}"))?;
                    match parsed {
                        ServerMessage::ServerHello(hello) => {
                            validate_server_hello(
                                &hello,
                                expected_session_id,
                                Some(expected_host_id),
                            )?;
                            return Ok(hello);
                        }
                        ServerMessage::HostAck(_) => {
                            anyhow::bail!("received host_ack before server hello");
                        }
                        ServerMessage::ServerBatch(_) => {
                            anyhow::bail!("received server_batch before server hello");
                        }
                    }
                }
                Message::Ping(payload) => {
                    write
                        .send(Message::Pong(payload))
                        .await
                        .context("failed to pong server while waiting for hello")?;
                }
                Message::Pong(_) => {}
                Message::Close(frame) => {
                    anyhow::bail!("bridge websocket closed by server: {:?}", frame);
                }
                Message::Frame(_) => {}
            }
        }
    })
    .await
    .context("timed out waiting for server hello")?
}

fn validate_server_hello(
    hello: &ServerHelloMessage,
    expected_session_id: &str,
    expected_host_id: Option<&str>,
) -> Result<()> {
    if hello.protocol_version != PROTOCOL_VERSION {
        anyhow::bail!(
            "protocol version mismatch: server={}, agent={}",
            hello.protocol_version,
            PROTOCOL_VERSION
        );
    }
    if hello.session_id != expected_session_id {
        anyhow::bail!(
            "server hello session mismatch: server={}, agent={}",
            hello.session_id,
            expected_session_id
        );
    }
    if let Some(expected_host_id) = expected_host_id
        && hello.host_id != expected_host_id
    {
        anyhow::bail!(
            "server hello host mismatch: server={}, agent={}",
            hello.host_id,
            expected_host_id
        );
    }
    debug!(
        host_id = %hello.host_id,
        session_id = %hello.session_id,
        server_acked_seq = hello.server_acked_seq,
        host_acked_seq = hello.host_acked_seq,
        "received server hello"
    );
    Ok(())
}

async fn apply_server_batch(db: &Db, batch: &ServerBatchMessage, applied_at_ms: i64) -> Result<()> {
    let transport = db.load_transport_state().await?;
    let plan = plan_inbound_batch(
        transport.server_acked_seq,
        batch.first_seq,
        batch.last_seq,
        batch.envelopes.len(),
    )
    .map_err(anyhow::Error::msg)?;

    match plan {
        InboundBatchPlan::AckOnly => return Ok(()),
        InboundBatchPlan::Gap => {
            anyhow::bail!(
                "server batch gap detected: acked={}, first={}, last={}",
                transport.server_acked_seq,
                batch.first_seq,
                batch.last_seq
            );
        }
        InboundBatchPlan::Process { start_index } => {
            for (index, envelope) in batch.envelopes.iter().enumerate().skip(start_index) {
                let seq = batch.first_seq + i64::try_from(index).unwrap_or(i64::MAX);
                let payload_json = Value::Object(envelope.payload.clone()).to_string();
                let envelope_input = RpcEnvelopeInput {
                    direction: RPC_DIRECTION_SERVER_TO_HOST.to_string(),
                    message_id: envelope.message_id.clone(),
                    call_id: envelope.call_id.clone(),
                    kind: envelope.kind.clone(),
                    method: envelope.method.clone(),
                    payload_json: payload_json.clone(),
                    occurred_at_ms: envelope.occurred_at,
                    expires_at_ms: extract_expires_at(&payload_json),
                };

                let call = if envelope.kind == RPC_KIND_REQUEST {
                    Some(RpcCallRow {
                        call_id: envelope
                            .call_id
                            .clone()
                            .unwrap_or_else(|| envelope.message_id.clone()),
                        direction: RPC_DIRECTION_SERVER_TO_HOST.to_string(),
                        method: envelope.method.clone(),
                        request_message_id: Some(envelope.message_id.clone()),
                        response_message_id: None,
                        request_json: payload_json,
                        status: "request_acked".to_string(),
                        request_acked_at_ms: Some(applied_at_ms),
                        response_acked_at_ms: None,
                        started_at_ms: None,
                        finished_at_ms: None,
                        deadline_at_ms: extract_deadline_at(&envelope_input.payload_json),
                        expires_at_ms: envelope_input.expires_at_ms,
                        response_json: None,
                        error_json: None,
                        updated_at_ms: applied_at_ms,
                    })
                } else {
                    None
                };

                let _ = db
                    .apply_inbound_envelope(seq, envelope_input, call, applied_at_ms)
                    .await?;
            }
        }
    }

    Ok(())
}

async fn execute_runnable_calls(db: &Db, vm: &VmManager) -> Result<()> {
    let calls = db.load_runnable_inbound_calls().await?;
    for call in calls {
        execute_single_call(db, vm, call).await?;
    }
    Ok(())
}

async fn execute_single_call(db: &Db, vm: &VmManager, mut call: RpcCallRow) -> Result<()> {
    let started_at_ms = now_ms();
    call.status = "running".to_string();
    call.started_at_ms = Some(started_at_ms);
    call.updated_at_ms = started_at_ms;
    db.upsert_rpc_call(call.clone()).await?;

    let (status, result, error) = match call.method.as_str() {
        "vm.launch" => match serde_json::from_str::<CreateScenarioVmRequest>(&call.request_json) {
            Ok(request) => match vm.create_scenario_vm(request).await {
                Ok(result) => ("succeeded", Some(serde_json::to_value(result)?), None),
                Err(error) => ("failed", None, Some(api_error_to_json(&error.message))),
            },
            Err(error) => (
                "failed",
                None,
                Some(json!({
                    "code": "invalid_request",
                    "message": error.to_string(),
                })),
            ),
        },
        "vm.destroy" => {
            let payload: Value =
                serde_json::from_str(&call.request_json).unwrap_or_else(|_| json!({}));
            let name = payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            if name.is_empty() {
                (
                    "failed",
                    None,
                    Some(json!({
                        "code": "invalid_request",
                        "message": "missing vm name",
                    })),
                )
            } else {
                match vm.delete_vm(&name).await {
                    Ok(()) => (
                        "succeeded",
                        Some(json!({
                            "name": name,
                            "state": "deleting_vm",
                        })),
                        None,
                    ),
                    Err(error) => ("failed", None, Some(api_error_to_json(&error.message))),
                }
            }
        }
        "vm.list" => {
            let vms = vm.list_vms().await;
            let generated_at = now_ms();
            let payload = json!({
                "generatedAt": generated_at,
                "generation": digest_json(&json!({ "vms": vms })),
                "vms": vms,
            });
            ("succeeded", Some(payload), None)
        }
        "vm.terminal.get" => {
            match serde_json::from_str::<VmTerminalStateRequest>(&call.request_json) {
                Ok(request) => match vm
                    .get_terminal_state(request.run_id.trim(), request.vm_name.trim())
                    .await
                {
                    Ok(result) => ("succeeded", Some(serde_json::to_value(result)?), None),
                    Err(error) => ("failed", None, Some(api_error_to_json(&error.message))),
                },
                Err(error) => (
                    "failed",
                    None,
                    Some(json!({
                        "code": "invalid_request",
                        "message": error.to_string(),
                    })),
                ),
            }
        }
        "host.ping" => {
            let tracked_vms = vm.list_vms().await.len();
            (
                "succeeded",
                Some(json!({
                    "ok": true,
                    "trackedVms": tracked_vms,
                })),
                None,
            )
        }
        other => (
            "failed",
            None,
            Some(json!({
                "code": "unsupported_method",
                "message": format!("unsupported RPC method {other}"),
            })),
        ),
    };

    let finished_at_ms = now_ms();
    let response_message_id = format!("response:{}", call.call_id);
    let response_payload = {
        let mut payload = json!({
            "status": status,
            "startedAt": started_at_ms,
            "finishedAt": finished_at_ms,
        });
        if call.method == "host.ping" {
            payload["rttMs"] = json!(0);
        }
        if let Some(ref result) = result {
            payload["result"] = result.clone();
        }
        if let Some(ref error) = error {
            payload["error"] = error.clone();
        }
        payload
    };

    call.status = status.to_string();
    call.response_message_id = Some(response_message_id.clone());
    call.finished_at_ms = Some(finished_at_ms);
    call.response_json = result.as_ref().map(Value::to_string);
    call.error_json = error.as_ref().map(Value::to_string);
    call.updated_at_ms = finished_at_ms;

    let envelope = RpcEnvelopeInput {
        direction: RPC_DIRECTION_HOST_TO_SERVER.to_string(),
        message_id: response_message_id,
        call_id: Some(call.call_id.clone()),
        kind: RPC_KIND_RESPONSE.to_string(),
        method: call.method.clone(),
        payload_json: response_payload.to_string(),
        occurred_at_ms: finished_at_ms,
        expires_at_ms: call.expires_at_ms,
    };

    db.persist_rpc_call_with_outbound_envelope(call, Some(envelope))
        .await?;
    Ok(())
}

async fn flush_outbound_batches<S>(db: &Db, write: &mut S, session_id: &str) -> Result<()>
where
    S: SinkExt<Message> + Unpin,
    <S as futures_util::Sink<Message>>::Error: std::error::Error + Send + Sync + 'static,
{
    let pending = db
        .load_pending_outbound_envelopes(OUTBOUND_BATCH_LIMIT)
        .await?;
    if pending.is_empty() {
        return Ok(());
    }

    let first = pending.first().context("missing first outbound envelope")?;
    let last = pending.last().context("missing last outbound envelope")?;
    let ack_upto = db.load_transport_state().await?.server_acked_seq;
    let envelopes = pending
        .iter()
        .map(outbound_row_to_envelope)
        .collect::<Result<Vec<_>>>()?;

    send_client_message(
        write,
        &ClientMessage::HostBatch(HostBatchMessage {
            session_id: session_id.to_string(),
            first_seq: first.seq,
            last_seq: last.seq,
            server_ack_upto: ack_upto,
            envelopes,
        }),
    )
    .await?;

    Ok(())
}

async fn send_terminal_state_reports(
    db: &Db,
    vm: &VmManager,
    last_terminal_report_fingerprints: &mut BTreeMap<String, String>,
    force: bool,
) -> Result<()> {
    for state in vm.list_terminal_states().await {
        queue_terminal_state_report(db, last_terminal_report_fingerprints, &state, force).await?;
    }
    Ok(())
}

async fn queue_terminal_state_report(
    db: &Db,
    last_terminal_report_fingerprints: &mut BTreeMap<String, String>,
    state: &VmTerminalState,
    force: bool,
) -> Result<()> {
    let key = probe_fingerprint_key(&state.run_id, &state.vm_name);
    let fingerprint = state.fingerprint();
    let changed = last_terminal_report_fingerprints
        .get(&key)
        .map(|current| current != &fingerprint)
        .unwrap_or(true);
    if !force && !changed {
        return Ok(());
    }
    last_terminal_report_fingerprints.insert(key, fingerprint);

    let occurred_at_ms = state.observed_at;
    let call_id = new_rpc_call_id("terminal-report");
    let request_json =
        serde_json::to_string(state).context("serialize terminal state report request")?;
    let row = RpcCallRow {
        call_id: call_id.clone(),
        direction: RPC_DIRECTION_HOST_TO_SERVER.to_string(),
        method: "vm.terminal.report".to_string(),
        request_message_id: None,
        response_message_id: None,
        request_json: request_json.clone(),
        status: "queued".to_string(),
        request_acked_at_ms: None,
        response_acked_at_ms: None,
        started_at_ms: None,
        finished_at_ms: None,
        deadline_at_ms: None,
        expires_at_ms: Some(occurred_at_ms.saturating_add(DB_RETENTION_MS)),
        response_json: None,
        error_json: None,
        updated_at_ms: occurred_at_ms,
    };
    let envelope = RpcEnvelopeInput {
        direction: RPC_DIRECTION_HOST_TO_SERVER.to_string(),
        message_id: format!("terminal-report:{call_id}"),
        call_id: Some(call_id),
        kind: RPC_KIND_REQUEST.to_string(),
        method: "vm.terminal.report".to_string(),
        payload_json: request_json,
        occurred_at_ms,
        expires_at_ms: row.expires_at_ms,
    };

    db.persist_rpc_call_with_outbound_envelope(row, Some(envelope))
        .await
}

async fn send_heartbeat_telemetry<S>(
    write: &mut S,
    session_id: &str,
    disk_probe_path: &Path,
) -> Result<()>
where
    S: SinkExt<Message> + Unpin,
    <S as futures_util::Sink<Message>>::Error: std::error::Error + Send + Sync + 'static,
{
    let occurred_at_ms = now_ms();
    let host_info = host_profile::collect(disk_probe_path);
    let payload = value_to_map(json!({
        "heartbeatAt": occurred_at_ms,
        "hostInfo": host_info,
    }))?;
    send_telemetry_message(
        write,
        TelemetryMessage {
            session_id: session_id.to_string(),
            message_id: format!("heartbeat:{occurred_at_ms}"),
            method: "host.heartbeat".to_string(),
            occurred_at: occurred_at_ms,
            payload,
        },
    )
    .await
}

async fn send_inventory_telemetry<S>(
    db: &Db,
    write: &mut S,
    session_id: &str,
    vm: &VmManager,
    force: bool,
) -> Result<()>
where
    S: SinkExt<Message> + Unpin,
    <S as futures_util::Sink<Message>>::Error: std::error::Error + Send + Sync + 'static,
{
    let occurred_at_ms = now_ms();
    let vms =
        serde_json::to_value(vm.list_inventory_vms().await?).context("serialize inventory vms")?;
    let existing = db.load_inventory_snapshot().await?;
    let snapshot = match prepare_inventory_snapshot(existing.as_ref(), vms, occurred_at_ms, force) {
        InventorySnapshotDecision::Skip => return Ok(()),
        InventorySnapshotDecision::Reuse(row) => row,
        InventorySnapshotDecision::Store(row) => {
            db.upsert_inventory_snapshot(row.clone()).await?;
            row
        }
    };

    send_telemetry_message(
        write,
        TelemetryMessage {
            session_id: session_id.to_string(),
            message_id: snapshot.message_id.clone(),
            method: "host.inventory.snapshot".to_string(),
            occurred_at: snapshot.occurred_at_ms,
            payload: parse_payload_json(&snapshot.payload_json)?,
        },
    )
    .await
}

fn prepare_inventory_snapshot(
    existing: Option<&InventorySnapshotRow>,
    vms: Value,
    occurred_at_ms: i64,
    force: bool,
) -> InventorySnapshotDecision {
    let generation = digest_json(&json!({ "vms": vms }));
    if let Some(existing) = existing
        && existing.generation == generation
    {
        return if force {
            InventorySnapshotDecision::Reuse(existing.clone())
        } else {
            InventorySnapshotDecision::Skip
        };
    }

    let payload_json = json!({
        "generatedAt": occurred_at_ms,
        "generation": generation,
        "vms": vms,
    })
    .to_string();
    let message_id = format!("inventory:{generation}");
    InventorySnapshotDecision::Store(InventorySnapshotRow {
        generation,
        message_id,
        payload_json,
        occurred_at_ms,
    })
}

async fn send_probe_snapshot_telemetry<S>(
    db: &Db,
    write: &mut S,
    session_id: &str,
    last_probe_fingerprints: &mut BTreeMap<String, String>,
    force: bool,
) -> Result<()>
where
    S: SinkExt<Message> + Unpin,
    <S as futures_util::Sink<Message>>::Error: std::error::Error + Send + Sync + 'static,
{
    let rows = db.load_all_vm_probe_states().await?;
    for row in rows {
        send_probe_snapshot_payload_telemetry(
            write,
            session_id,
            last_probe_fingerprints,
            ProbeSnapshotEvent {
                run_id: &row.run_id,
                vm_name: &row.vm_name,
                generated_at_ms: row.generated_at_ms,
                fingerprint: &row.fingerprint,
                payload_json: row.snapshot_json.clone(),
            },
            force,
        )
        .await?;
    }
    Ok(())
}

async fn send_probe_snapshot_update_telemetry<S>(
    write: &mut S,
    session_id: &str,
    last_probe_fingerprints: &mut BTreeMap<String, String>,
    update: &crate::kino_probe::ProbeUpdateEnvelope,
    force: bool,
) -> Result<()>
where
    S: SinkExt<Message> + Unpin,
    <S as futures_util::Sink<Message>>::Error: std::error::Error + Send + Sync + 'static,
{
    let payload_json = serde_json::to_string(update).context("serialize probe update envelope")?;
    send_probe_snapshot_payload_telemetry(
        write,
        session_id,
        last_probe_fingerprints,
        ProbeSnapshotEvent {
            run_id: &update.run_id,
            vm_name: &update.vm_name,
            generated_at_ms: update.generated_at_ms,
            fingerprint: &update.fingerprint,
            payload_json,
        },
        force,
    )
    .await
}

async fn send_probe_snapshot_payload_telemetry<S>(
    write: &mut S,
    session_id: &str,
    last_probe_fingerprints: &mut BTreeMap<String, String>,
    probe: ProbeSnapshotEvent<'_>,
    force: bool,
) -> Result<()>
where
    S: SinkExt<Message> + Unpin,
    <S as futures_util::Sink<Message>>::Error: std::error::Error + Send + Sync + 'static,
{
    let key = probe_fingerprint_key(probe.run_id, probe.vm_name);
    let changed = last_probe_fingerprints
        .get(&key)
        .map(|current| current != probe.fingerprint)
        .unwrap_or(true);
    if !force && !changed {
        return Ok(());
    }

    last_probe_fingerprints.insert(key, probe.fingerprint.to_string());
    send_telemetry_message(
        write,
        TelemetryMessage {
            session_id: session_id.to_string(),
            message_id: probe_message_id(
                probe.run_id,
                probe.vm_name,
                probe.generated_at_ms,
                probe.fingerprint,
            ),
            method: "run.probe.snapshot".to_string(),
            occurred_at: probe.generated_at_ms,
            payload: parse_payload_json(&probe.payload_json)?,
        },
    )
    .await
}

async fn send_telemetry_message<S>(write: &mut S, message: TelemetryMessage) -> Result<()>
where
    S: SinkExt<Message> + Unpin,
    <S as futures_util::Sink<Message>>::Error: std::error::Error + Send + Sync + 'static,
{
    send_client_message(write, &ClientMessage::Telemetry(message)).await
}

fn parse_payload_json(payload_json: &str) -> Result<Map<String, Value>> {
    let parsed = serde_json::from_str::<Value>(payload_json)
        .with_context(|| format!("failed to parse telemetry payload: {payload_json}"))?;
    value_to_map(parsed)
}

fn value_to_map(value: Value) -> Result<Map<String, Value>> {
    match value {
        Value::Object(map) => Ok(map),
        _ => anyhow::bail!("telemetry payload must be a JSON object"),
    }
}

async fn send_client_message<S>(write: &mut S, message: &ClientMessage) -> Result<()>
where
    S: SinkExt<Message> + Unpin,
    <S as futures_util::Sink<Message>>::Error: std::error::Error + Send + Sync + 'static,
{
    let text = serde_json::to_string(message).context("failed to serialize client message")?;
    write
        .send(Message::Text(text.into()))
        .await
        .context("failed to send websocket message")?;
    Ok(())
}

async fn bootstrap_agent_access(
    cfg: &BridgeConfig,
    http: &HttpClient,
) -> Result<AgentBootstrapResponse> {
    let url = format!("{}/agent/bootstrap", cfg.base_url);
    let request = AgentBootstrapRequest {
        host_id: &cfg.host_id,
        bootstrap_token: &cfg.bootstrap_token,
    };

    let response = http
        .post(&url)
        .json(&request)
        .send()
        .await
        .with_context(|| format!("failed to call bootstrap endpoint at {url}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("bootstrap request failed with status {status}: {body}");
    }

    response
        .json::<AgentBootstrapResponse>()
        .await
        .context("failed to parse bootstrap response")
}

fn outbound_row_to_envelope(row: &RpcEnvelopeRow) -> Result<RpcEnvelope> {
    let payload = serde_json::from_str::<Value>(&row.payload_json)
        .context("failed to parse outbound envelope payload")?;
    let Value::Object(payload) = payload else {
        anyhow::bail!("outbound envelope payload must be a JSON object");
    };
    Ok(RpcEnvelope {
        message_id: row.message_id.clone(),
        call_id: row.call_id.clone(),
        kind: row.kind.clone(),
        method: row.method.clone(),
        occurred_at: row.occurred_at_ms,
        payload,
    })
}

fn api_error_to_json(error: impl std::fmt::Display) -> Value {
    json!({
        "code": "vm_error",
        "message": error.to_string(),
    })
}

fn default_ws_url(base_url: &str, host_id: &str) -> String {
    let scheme = if base_url.starts_with("https://") {
        "wss://"
    } else {
        "ws://"
    };
    let without_scheme = base_url
        .strip_prefix("https://")
        .or_else(|| base_url.strip_prefix("http://"))
        .unwrap_or(base_url);
    format!("{scheme}{without_scheme}/agent/connect?hostId={host_id}")
}

fn digest_json(value: &Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.to_string().as_bytes());
    base16ct::lower::encode_string(&hasher.finalize())
}

fn extract_deadline_at(payload_json: &str) -> Option<i64> {
    serde_json::from_str::<Value>(payload_json)
        .ok()
        .and_then(|value| value.get("deadlineAt").and_then(Value::as_i64))
}

fn extract_expires_at(payload_json: &str) -> Option<i64> {
    serde_json::from_str::<Value>(payload_json)
        .ok()
        .and_then(|value| value.get("expiresAt").and_then(Value::as_i64))
}

fn new_session_id() -> String {
    let random = getrandom::u64().unwrap_or(0);
    format!("agent-{:x}-{:x}", now_ms(), random)
}

fn new_transport_id(prefix: &str) -> String {
    let random = getrandom::u64().unwrap_or(0);
    format!("{prefix}-{:x}-{:x}", now_ms(), random)
}

fn new_rpc_call_id(prefix: &str) -> String {
    let random = getrandom::u64().unwrap_or(0);
    format!("{prefix}-{:x}-{:x}", now_ms(), random)
}

fn probe_fingerprint_key(run_id: &str, vm_name: &str) -> String {
    format!("{run_id}:{vm_name}")
}

fn probe_message_id(
    run_id: &str,
    vm_name: &str,
    generated_at_ms: i64,
    fingerprint: &str,
) -> String {
    format!("probe:{run_id}:{vm_name}:{generated_at_ms}:{fingerprint}")
}

fn now_ms() -> i64 {
    let duration = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepare_inventory_snapshot_skips_unchanged_snapshot_without_force() {
        let empty_generation = digest_json(&json!({ "vms": [] }));
        let existing = InventorySnapshotRow {
            generation: empty_generation.clone(),
            message_id: format!("inventory:{empty_generation}"),
            payload_json: json!({
                "generatedAt": 100,
                "generation": empty_generation,
                "vms": [],
            })
            .to_string(),
            occurred_at_ms: 100,
        };
        let vms = json!([]);

        let decision = prepare_inventory_snapshot(Some(&existing), vms, 200, false);

        assert_eq!(decision, InventorySnapshotDecision::Skip);
    }

    #[test]
    fn prepare_inventory_snapshot_reuses_existing_payload_for_forced_reconnect() {
        let empty_generation = digest_json(&json!({ "vms": [] }));
        let existing = InventorySnapshotRow {
            generation: empty_generation.clone(),
            message_id: format!("inventory:{empty_generation}"),
            payload_json: json!({
                "generatedAt": 100,
                "generation": empty_generation,
                "vms": [],
            })
            .to_string(),
            occurred_at_ms: 100,
        };
        let vms = json!([]);

        let decision = prepare_inventory_snapshot(Some(&existing), vms, 200, true);

        assert_eq!(decision, InventorySnapshotDecision::Reuse(existing));
    }

    #[test]
    fn prepare_inventory_snapshot_stores_new_payload_when_generation_changes() {
        let empty_generation = digest_json(&json!({ "vms": [] }));
        let existing = InventorySnapshotRow {
            generation: empty_generation.clone(),
            message_id: format!("inventory:{empty_generation}"),
            payload_json: json!({
                "generatedAt": 100,
                "generation": empty_generation,
                "vms": [],
            })
            .to_string(),
            occurred_at_ms: 100,
        };
        let vms = json!([{ "name": "vm-1" }]);

        let decision = prepare_inventory_snapshot(Some(&existing), vms.clone(), 200, true);

        let InventorySnapshotDecision::Store(next) = decision else {
            panic!("expected Store decision");
        };
        let expected_generation = digest_json(&json!({ "vms": vms }));
        assert_eq!(next.generation, expected_generation);
        assert_eq!(next.message_id, format!("inventory:{expected_generation}"));
        assert_eq!(next.occurred_at_ms, 200);

        let payload = serde_json::from_str::<Value>(&next.payload_json).expect("parse payload");
        assert_eq!(
            payload.get("generatedAt").and_then(Value::as_i64),
            Some(200)
        );
        assert_eq!(
            payload.get("generation").and_then(Value::as_str),
            Some(expected_generation.as_str())
        );
        assert_eq!(payload.get("vms"), Some(&json!([{ "name": "vm-1" }])));
    }

    #[test]
    fn probe_message_id_is_stable_and_fingerprint_sensitive() {
        let first = probe_message_id("run-1", "vm-1", 123, "abc");
        let second = probe_message_id("run-1", "vm-1", 123, "abc");
        let changed = probe_message_id("run-1", "vm-1", 123, "def");

        assert_eq!(first, second);
        assert_ne!(first, changed);
    }

    #[test]
    fn validate_server_hello_rejects_session_mismatch() {
        let error = validate_server_hello(
            &ServerHelloMessage {
                protocol_version: PROTOCOL_VERSION,
                host_id: "host-1".to_string(),
                session_id: "server-session".to_string(),
                server_transport_id: "server-transport-1".to_string(),
                host_transport_id: "host-transport-1".to_string(),
                server_acked_seq: 0,
                host_acked_seq: 0,
            },
            "agent-session",
            Some("host-1"),
        )
        .expect_err("session mismatch should fail");

        assert!(
            error.to_string().contains("server hello session mismatch"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn validate_server_hello_accepts_matching_host_and_session() {
        validate_server_hello(
            &ServerHelloMessage {
                protocol_version: PROTOCOL_VERSION,
                host_id: "host-1".to_string(),
                session_id: "session-1".to_string(),
                server_transport_id: "server-transport-1".to_string(),
                host_transport_id: "host-transport-1".to_string(),
                server_acked_seq: 12,
                host_acked_seq: 8,
            },
            "session-1",
            Some("host-1"),
        )
        .expect("matching server hello should succeed");
    }
}
