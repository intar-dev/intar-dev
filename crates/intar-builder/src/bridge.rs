//! Bridge protocol 9 for a builder: it takes desired builds and source
//! compiles, and sends a report whenever a build moves.

use std::fs;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, UdpSocket};
#[cfg(unix)]
use std::os::unix::fs::FileTypeExt as _;
use std::path::Path;
use std::time::Duration;

use anyhow::{Context as _, Result};
use fs2::{available_space, total_space};
use futures_util::{Sink, SinkExt, StreamExt};
use intar_contracts::bridge::{HostCapacityV2, HostRoleV1, SyncRequestReason};
use intar_contracts::bridge_v9::{
    BRIDGE_PROTOCOL_VERSION_9 as BRIDGE_PROTOCOL_VERSION, BridgeMessageV9, BuildReportV2,
    BuildReportV9, BuilderHelloV1, ClientHelloV9, DesiredSourceCompileV2,
    HOST_DESIRED_STATE_SCHEMA_VERSION_7 as HOST_DESIRED_STATE_SCHEMA_VERSION,
    HOST_STATE_REPORT_SCHEMA_VERSION_8 as HOST_STATE_REPORT_SCHEMA_VERSION, HostDesiredStateV3,
    HostHardwareV1, HostStateReportV3, StateReportV9, SyncRequestV9,
};
use intar_contracts::catalog::{ImageArchitecture, Mib};
use intar_contracts::guest::GUEST_CONTRACT;
use intar_contracts::oci::IMAGE_FORMAT;
use intar_contracts::source::{SOURCE_COMPILER_VERSION_V2, source_compile_digest};
use reqwest::Client as HttpClient;
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, watch};
use tokio::time::{MissedTickBehavior, interval, sleep, timeout};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::Message;
use tracing::{debug, info, warn};

use crate::config::{BridgeConfig, BuilderConfig};
use crate::db::BuilderDb;

const RETRY_MIN_MS: u64 = 1_000;
const RETRY_MAX_MS: u64 = 30_000;
/// After the Worker refuses this protocol: long enough that a fleet of old
/// builders never hot-loops against it.
const UPGRADE_RETRY_MS: u64 = 10 * 60 * 1_000;
const BRIDGE_PROTOCOL_HEADER: &str = "Intar-Bridge-Protocol";
/// The Worker's close code for a refused protocol.
const CLOSE_UPGRADE_REQUIRED: u16 = 4426;
const SERVER_HELLO_TIMEOUT_SECS: u64 = 10;
const BYTES_PER_MIB: u64 = 1024 * 1024;
const PRIMARY_IPV4_PROBE: (Ipv4Addr, u16) = (Ipv4Addr::new(1, 1, 1, 1), 80);
const PRIMARY_IPV6_PROBE: (Ipv6Addr, u16) = (
    Ipv6Addr::new(0x2606, 0x4700, 0x4700, 0, 0, 0, 0, 0x1111),
    80,
);

/// The Worker refused this builder's bridge protocol (HTTP 426 or close 4426).
#[derive(Debug, thiserror::Error)]
#[error("the Worker refused bridge protocol {BRIDGE_PROTOCOL_VERSION}: upgrade required")]
pub(crate) struct UpgradeRequired;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BuilderBootstrapRequest<'a> {
    host_id: &'a str,
    bootstrap_token: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuilderBootstrapResponse {
    access_token: String,
    ws_url: Option<String>,
}

/// Where an applied desired state goes: the build workers wait for `ready`
/// to move, and the source compile supervisor follows `source_compiles`.
pub struct DesiredStateSenders {
    pub ready: watch::Sender<u64>,
    pub source_compiles: watch::Sender<Vec<DesiredSourceCompileV2>>,
}

pub async fn run(
    cfg: BuilderConfig,
    db: BuilderDb,
    mut build_reports: mpsc::Receiver<BuildReportV2>,
    desired: DesiredStateSenders,
) -> Result<()> {
    let http = HttpClient::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .context("failed to initialize bridge http client")?;
    let mut current = load_cached_desired_state(&cfg.bridge, &db);
    if let Some(state) = &current
        && let Err(error) = db.reconcile(&state.builds, now_ms())
    {
        warn!(error = %error, "failed to reconcile the cached builder desired state");
    }
    let mut retry_ms = RETRY_MIN_MS;
    let mut reconnect = false;
    loop {
        let result = connect_once(
            &cfg,
            &http,
            &db,
            &mut build_reports,
            &mut current,
            &desired,
            reconnect,
        )
        .await;
        reconnect = true;
        let Err(error) = result else {
            retry_ms = RETRY_MIN_MS;
            continue;
        };
        let upgrade_required = error.downcast_ref::<UpgradeRequired>().is_some();
        let (wait_ms, next_ms) = retry_after_failure(retry_ms, upgrade_required);
        if upgrade_required {
            warn!(
                retry_ms = wait_ms,
                protocol = BRIDGE_PROTOCOL_VERSION,
                "the Worker requires another bridge protocol; waiting for a builder rollout"
            );
        } else {
            warn!(error = %format!("{error:#}"), retry_ms = wait_ms, "builder bridge connection failed");
        }
        sleep(Duration::from_millis(wait_ms)).await;
        retry_ms = next_ms;
    }
}

/// How long to wait after a failed connection, and the next backoff. A
/// refused protocol waits long and keeps the backoff at its ceiling.
fn retry_after_failure(retry_ms: u64, upgrade_required: bool) -> (u64, u64) {
    if upgrade_required {
        (UPGRADE_RETRY_MS, RETRY_MAX_MS)
    } else {
        (retry_ms, retry_ms.saturating_mul(2).min(RETRY_MAX_MS))
    }
}

async fn connect_once(
    cfg: &BuilderConfig,
    http: &HttpClient,
    db: &BuilderDb,
    build_reports: &mut mpsc::Receiver<BuildReportV2>,
    current: &mut Option<HostDesiredStateV3>,
    desired: &DesiredStateSenders,
    reconnect: bool,
) -> Result<()> {
    let bootstrap = bootstrap_builder_access(&cfg.bridge, http).await?;
    let ws_url = bootstrap
        .ws_url
        .unwrap_or_else(|| default_ws_url(&cfg.bridge.base_url, &cfg.bridge.host_id));
    let mut request = ws_url
        .into_client_request()
        .context("failed to build builder websocket request")?;
    request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {}", bootstrap.access_token))
            .context("failed to build builder websocket auth header")?,
    );
    request.headers_mut().insert(
        BRIDGE_PROTOCOL_HEADER,
        HeaderValue::from(BRIDGE_PROTOCOL_VERSION),
    );
    let (ws_stream, _) = match connect_async(request).await {
        Ok(connected) => connected,
        Err(tokio_tungstenite::tungstenite::Error::Http(response))
            if response.status() == reqwest::StatusCode::UPGRADE_REQUIRED.as_u16() =>
        {
            return Err(UpgradeRequired.into());
        }
        Err(error) => return Err(error).context("failed to connect builder bridge websocket"),
    };
    info!(host_id = %cfg.bridge.host_id, "builder bridge websocket connected");

    let (mut write, mut read) = ws_stream.split();
    send_bridge_message(
        &mut write,
        &builder_client_hello(
            cfg,
            // A process restart must apply a live desired state before any
            // requeued build runs, so nothing is advertised until then.
            advertised_desired_version(current.as_ref(), *desired.ready.borrow() > 0),
        ),
    )
    .await?;

    let server_hello = timeout(Duration::from_secs(SERVER_HELLO_TIMEOUT_SECS), async {
        loop {
            let Some(message) = read.next().await else {
                anyhow::bail!("websocket closed before server hello");
            };
            let message = message.context("failed reading builder bridge server hello")?;
            if let Some(message) = parse_bridge_message(message)? {
                validate_bridge_message(&message, &cfg.bridge.host_id)?;
                match message {
                    BridgeMessageV9::ServerHello(server_hello) => break Ok(server_hello),
                    other => anyhow::bail!("expected server_hello, got {}", message_type(&other)),
                }
            }
        }
    })
    .await
    .context("timed out waiting for builder bridge server_hello")??;
    info!(
        host_id = %server_hello.host_id,
        desired_version = server_hello.desired_version,
        "builder bridge v9 handshake complete"
    );

    send_bridge_message(
        &mut write,
        &BridgeMessageV9::SyncRequest(SyncRequestV9 {
            protocol_version: BRIDGE_PROTOCOL_VERSION,
            host_id: cfg.bridge.host_id.clone(),
            reason: if reconnect {
                SyncRequestReason::Reconnect
            } else {
                SyncRequestReason::Connect
            },
        }),
    )
    .await?;
    send_state(&mut write, cfg, db, current.as_ref()).await?;

    let mut state_report_interval = interval(Duration::from_secs(
        cfg.bridge.heartbeat_interval_seconds.max(1),
    ));
    state_report_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    state_report_interval.tick().await;
    loop {
        tokio::select! {
            inbound = read.next() => {
                let Some(inbound) = inbound else {
                    anyhow::bail!("builder bridge websocket closed");
                };
                let inbound = inbound.context("failed reading builder bridge message")?;
                if let Some(message) = parse_bridge_message(inbound)? {
                    validate_bridge_message(&message, &cfg.bridge.host_id)?;
                    handle_server_message(&mut write, cfg, db, current, desired, message).await?;
                }
            }
            _ = state_report_interval.tick() => {
                send_state(&mut write, cfg, db, current.as_ref()).await?;
            }
            report = build_reports.recv() => match report {
                Some(report) => send_build_report(&mut write, &cfg.bridge.host_id, report).await?,
                None => debug!("builder worker report channel closed"),
            },
        }
    }
}

async fn handle_server_message<W>(
    write: &mut W,
    cfg: &BuilderConfig,
    db: &BuilderDb,
    current: &mut Option<HostDesiredStateV3>,
    desired: &DesiredStateSenders,
    message: BridgeMessageV9,
) -> Result<()>
where
    W: Sink<Message> + Unpin,
    W::Error: std::error::Error + Send + Sync + 'static,
{
    match message {
        BridgeMessageV9::DesiredState(message) => {
            let state = message.desired_state;
            validate_desired_state(&cfg.bridge.host_id, &state)
                .context("refused the builder desired state")?;
            db.save_desired_state(state.version, &serde_json::to_string(&state)?)?;
            let queued = db.reconcile(&state.builds, now_ms())?;
            info!(
                version = state.version,
                builds = state.builds.len(),
                queued,
                source_compiles = state.source_compiles.len(),
                "applied builder desired state"
            );
            desired
                .source_compiles
                .send_replace(state.source_compiles.clone());
            *current = Some(state);
            desired
                .ready
                .send_modify(|revision| *revision = revision.saturating_add(1));
            send_state(write, cfg, db, current.as_ref()).await
        }
        BridgeMessageV9::SyncRequest(_) => send_state(write, cfg, db, current.as_ref()).await,
        BridgeMessageV9::ServerHello(_) => {
            anyhow::bail!("received duplicate server_hello after handshake")
        }
        BridgeMessageV9::ClientHello(_)
        | BridgeMessageV9::StateReport(_)
        | BridgeMessageV9::VmReport(_)
        | BridgeMessageV9::BuildReport(_) => {
            anyhow::bail!("server sent a host-originated bridge message")
        }
    }
}

fn advertised_desired_version(
    current: Option<&HostDesiredStateV3>,
    has_fresh_desired_state: bool,
) -> Option<u64> {
    has_fresh_desired_state
        .then(|| current.map(|state| state.version))
        .flatten()
}

fn load_cached_desired_state(cfg: &BridgeConfig, db: &BuilderDb) -> Option<HostDesiredStateV3> {
    let json = match db.load_desired_state() {
        Ok(json) => json?,
        Err(error) => {
            warn!(error = %error, "failed to load the cached builder desired state");
            return None;
        }
    };
    let state = serde_json::from_str::<HostDesiredStateV3>(&json)
        .map_err(anyhow::Error::from)
        .and_then(|state| validate_desired_state(&cfg.host_id, &state).map(|()| state));
    match state {
        Ok(state) => Some(state),
        Err(error) => {
            warn!(error = %format!("{error:#}"), "ignoring the cached builder desired state");
            None
        }
    }
}

/// The state report, then a report of every desired build: the Worker learns
/// each build's phase again after any reconnect.
async fn send_state<W>(
    write: &mut W,
    cfg: &BuilderConfig,
    db: &BuilderDb,
    desired: Option<&HostDesiredStateV3>,
) -> Result<()>
where
    W: Sink<Message> + Unpin,
    W::Error: std::error::Error + Send + Sync + 'static,
{
    send_bridge_message(
        write,
        &BridgeMessageV9::StateReport(StateReportV9 {
            protocol_version: BRIDGE_PROTOCOL_VERSION,
            host_id: cfg.bridge.host_id.clone(),
            report: host_state_report(cfg, desired),
        }),
    )
    .await?;
    for report in db.reports()? {
        send_build_report(write, &cfg.bridge.host_id, report).await?;
    }
    Ok(())
}

async fn send_build_report<W>(write: &mut W, host_id: &str, report: BuildReportV2) -> Result<()>
where
    W: Sink<Message> + Unpin,
    W::Error: std::error::Error + Send + Sync + 'static,
{
    send_bridge_message(
        write,
        &BridgeMessageV9::BuildReport(BuildReportV9 {
            protocol_version: BRIDGE_PROTOCOL_VERSION,
            host_id: host_id.to_owned(),
            report,
        }),
    )
    .await
}

fn host_state_report(
    cfg: &BuilderConfig,
    desired: Option<&HostDesiredStateV3>,
) -> HostStateReportV3 {
    HostStateReportV3 {
        schema_version: HOST_STATE_REPORT_SCHEMA_VERSION,
        host_id: cfg.bridge.host_id.clone(),
        observed_at_unix_ms: now_ms(),
        applied_desired_version: desired.map_or(0, |state| state.version),
        relay_connected: false,
        guest_contract: GUEST_CONTRACT,
        hardware: builder_hardware(cfg),
        capacity: collect_builder_capacity(cfg),
        cached_images: Vec::new(),
        vms: Vec::new(),
    }
}

fn builder_client_hello(cfg: &BuilderConfig, last_applied: Option<u64>) -> BridgeMessageV9 {
    BridgeMessageV9::ClientHello(ClientHelloV9 {
        protocol_version: BRIDGE_PROTOCOL_VERSION,
        host_id: cfg.bridge.host_id.clone(),
        agent_version: env!("CARGO_PKG_VERSION").to_owned(),
        role: HostRoleV1::Builder,
        last_applied_desired_version: last_applied,
        guest_contract: GUEST_CONTRACT,
        hardware: builder_hardware(cfg),
        builder: Some(BuilderHelloV1 {
            image_format: IMAGE_FORMAT.to_owned(),
            source_compile_digest: source_compile_digest(IMAGE_FORMAT, SOURCE_COMPILER_VERSION_V2),
        }),
    })
}

fn builder_hardware(cfg: &BuilderConfig) -> HostHardwareV1 {
    HostHardwareV1 {
        cloud_hypervisor_sha256: None,
        kvm: cfg.qemu.accelerator == "kvm" && can_open_char_device(Path::new("/dev/kvm")),
        vsock: can_open_char_device(Path::new("/dev/vhost-vsock")),
        reflink: false,
        landlock: false,
        cgroup_v2: false,
        hard_cpu_quota: false,
    }
}

pub fn host_architecture() -> ImageArchitecture {
    if cfg!(target_arch = "aarch64") {
        ImageArchitecture::Aarch64
    } else {
        ImageArchitecture::X86_64
    }
}

/// A short-lived access token for the builder's HTTP routes.
pub async fn bootstrap_builder_access_token(cfg: &BridgeConfig) -> Result<String> {
    let http = HttpClient::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .context("failed to initialize builder bootstrap http client")?;
    Ok(bootstrap_builder_access(cfg, &http).await?.access_token)
}

async fn bootstrap_builder_access(
    cfg: &BridgeConfig,
    http: &HttpClient,
) -> Result<BuilderBootstrapResponse> {
    let url = format!("{}/api/agent/bootstrap", cfg.base_url.trim_end_matches('/'));
    let response = http
        .post(&url)
        .header(BRIDGE_PROTOCOL_HEADER, BRIDGE_PROTOCOL_VERSION)
        .json(&BuilderBootstrapRequest {
            host_id: &cfg.host_id,
            bootstrap_token: &cfg.bootstrap_token,
        })
        .send()
        .await
        .with_context(|| format!("failed to bootstrap builder against {url}"))?;
    let status = response.status();
    if status == reqwest::StatusCode::UPGRADE_REQUIRED {
        return Err(UpgradeRequired.into());
    }
    if !status.is_success() {
        anyhow::bail!("builder bootstrap failed with HTTP {status}");
    }
    response
        .json::<BuilderBootstrapResponse>()
        .await
        .context("failed to parse builder bootstrap response")
}

fn default_ws_url(base_url: &str, host_id: &str) -> String {
    let base = base_url.trim_end_matches('/');
    let ws_base = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        base.to_owned()
    };
    format!("{ws_base}/agent/connect?hostId={host_id}")
}

async fn send_bridge_message<W>(write: &mut W, message: &BridgeMessageV9) -> Result<()>
where
    W: Sink<Message> + Unpin,
    W::Error: std::error::Error + Send + Sync + 'static,
{
    let raw = serde_json::to_string(message).context("failed to serialize bridge message")?;
    write
        .send(Message::Text(raw.into()))
        .await
        .context("failed to send builder bridge websocket message")
}

fn parse_bridge_message(message: Message) -> Result<Option<BridgeMessageV9>> {
    let raw = match message {
        Message::Text(raw) => raw.to_string(),
        Message::Binary(raw) => {
            String::from_utf8(raw.to_vec()).context("bridge binary message is not utf-8")?
        }
        Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => return Ok(None),
        Message::Close(frame) => {
            if frame
                .as_ref()
                .is_some_and(|frame| u16::from(frame.code) == CLOSE_UPGRADE_REQUIRED)
            {
                return Err(UpgradeRequired.into());
            }
            anyhow::bail!("builder bridge websocket closed by peer: {frame:?}");
        }
    };
    serde_json::from_str(&raw)
        .context("invalid bridge v9 JSON message")
        .map(Some)
}

fn validate_bridge_message(message: &BridgeMessageV9, host_id: &str) -> Result<()> {
    let (version, message_host_id) = match message {
        BridgeMessageV9::ClientHello(message) => (message.protocol_version, &message.host_id),
        BridgeMessageV9::ServerHello(message) => (message.protocol_version, &message.host_id),
        BridgeMessageV9::DesiredState(message) => (message.protocol_version, &message.host_id),
        BridgeMessageV9::StateReport(message) => (message.protocol_version, &message.host_id),
        BridgeMessageV9::VmReport(message) => (message.protocol_version, &message.host_id),
        BridgeMessageV9::BuildReport(message) => (message.protocol_version, &message.host_id),
        BridgeMessageV9::SyncRequest(message) => (message.protocol_version, &message.host_id),
    };
    anyhow::ensure!(
        version == BRIDGE_PROTOCOL_VERSION,
        "invalid bridge protocol version {version}; expected {BRIDGE_PROTOCOL_VERSION}"
    );
    anyhow::ensure!(
        message_host_id == host_id,
        "bridge message host mismatch: expected {host_id}, got {message_host_id}"
    );
    Ok(())
}

fn validate_desired_state(host_id: &str, desired: &HostDesiredStateV3) -> Result<()> {
    anyhow::ensure!(
        desired.schema_version == HOST_DESIRED_STATE_SCHEMA_VERSION,
        "unsupported desired state schema version {}; expected {HOST_DESIRED_STATE_SCHEMA_VERSION}",
        desired.schema_version
    );
    anyhow::ensure!(
        desired.host_id == host_id,
        "desired state host mismatch: expected {host_id}, got {}",
        desired.host_id
    );
    anyhow::ensure!(desired.vms.is_empty(), "a builder runs no VMs");
    for build in &desired.builds {
        build.validate().map_err(anyhow::Error::msg)?;
    }
    for compile in &desired.source_compiles {
        compile.validate().map_err(anyhow::Error::msg)?;
    }
    Ok(())
}

fn message_type(message: &BridgeMessageV9) -> &'static str {
    match message {
        BridgeMessageV9::ClientHello(_) => "client_hello",
        BridgeMessageV9::ServerHello(_) => "server_hello",
        BridgeMessageV9::DesiredState(_) => "desired_state",
        BridgeMessageV9::StateReport(_) => "state_report",
        BridgeMessageV9::VmReport(_) => "vm_report",
        BridgeMessageV9::BuildReport(_) => "build_report",
        BridgeMessageV9::SyncRequest(_) => "sync_request",
    }
}

#[cfg(unix)]
fn can_open_char_device(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.file_type().is_char_device() {
        return false;
    }
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .is_ok()
}

#[cfg(not(unix))]
fn can_open_char_device(_path: &Path) -> bool {
    false
}

fn collect_builder_capacity(cfg: &BuilderConfig) -> HostCapacityV2 {
    let (memory_total_mib, memory_available_mib) = read_memory_mib();
    let disk_probe_path = &cfg.builder.cache_root;
    let load = read_load_averages();
    let total_cpu_millis = u32::from(available_cpu_count()) * 1_000;
    HostCapacityV2 {
        total_cpu_millis,
        reserved_cpu_millis: 0,
        schedulable_cpu_millis: total_cpu_millis,
        committed_cpu_millis: 0,
        memory_total_mib: Mib(memory_total_mib.unwrap_or(0)),
        memory_available_mib: Mib(memory_available_mib.unwrap_or(0)),
        disk_probe_path: disk_probe_path.display().to_string(),
        disk_total_mib: Mib(read_disk_total_mib(disk_probe_path).unwrap_or(0)),
        disk_available_mib: Mib(read_disk_available_mib(disk_probe_path).unwrap_or(0)),
        load_avg_1m: load.map(|values| values.0),
        load_avg_5m: load.map(|values| values.1),
        load_avg_15m: load.map(|values| values.2),
        primary_ipv4: detect_primary_ipv4(),
        primary_ipv6: detect_primary_ipv6(),
    }
}

// Same technique as intar-agent's host_profile: a connected UDP socket picks
// the interface the default route would use, without sending any packets.
fn detect_primary_ipv4() -> Option<String> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect(PRIMARY_IPV4_PROBE).ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(ip) if !ip.is_unspecified() => Some(ip.to_string()),
        _ => None,
    }
}

fn detect_primary_ipv6() -> Option<String> {
    let socket = UdpSocket::bind((Ipv6Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect(PRIMARY_IPV6_PROBE).ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V6(ip) if !ip.is_unspecified() => Some(ip.to_string()),
        _ => None,
    }
}

fn read_load_averages() -> Option<(f64, f64, f64)> {
    let loadavg = fs::read_to_string("/proc/loadavg").ok()?;
    let mut parts = loadavg.split_whitespace();
    Some((
        parts.next()?.parse::<f64>().ok()?,
        parts.next()?.parse::<f64>().ok()?,
        parts.next()?.parse::<f64>().ok()?,
    ))
}

fn read_memory_mib() -> (Option<u32>, Option<u32>) {
    let Ok(meminfo) = fs::read_to_string("/proc/meminfo") else {
        return (None, None);
    };
    let (total_kib, available_kib) = parse_meminfo_kib(&meminfo);
    (
        total_kib.and_then(kib_to_mib_u32),
        available_kib.and_then(kib_to_mib_u32),
    )
}

fn parse_meminfo_kib(meminfo: &str) -> (Option<u64>, Option<u64>) {
    let mut total_kib = None;
    let mut available_kib = None;

    for line in meminfo.lines() {
        let mut parts = line.split_whitespace();
        let key = parts.next().unwrap_or_default();
        let value = parts.next().and_then(|raw| raw.parse::<u64>().ok());
        match key {
            "MemTotal:" => total_kib = value,
            "MemAvailable:" => available_kib = value,
            _ => {}
        }
    }

    (total_kib, available_kib)
}

fn read_disk_total_mib(path: &Path) -> Option<u32> {
    total_space(path).ok().and_then(bytes_to_mib_u32)
}

fn read_disk_available_mib(path: &Path) -> Option<u32> {
    available_space(path).ok().and_then(bytes_to_mib_u32)
}

fn kib_to_mib_u32(kib: u64) -> Option<u32> {
    u32::try_from(kib / 1024).ok().filter(|value| *value > 0)
}

fn bytes_to_mib_u32(bytes: u64) -> Option<u32> {
    u32::try_from(bytes / BYTES_PER_MIB)
        .ok()
        .filter(|value| *value > 0)
}

fn available_cpu_count() -> u16 {
    std::thread::available_parallelism()
        .map(usize::from)
        .ok()
        .and_then(|count| u16::try_from(count).ok())
        .unwrap_or(0)
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests;
