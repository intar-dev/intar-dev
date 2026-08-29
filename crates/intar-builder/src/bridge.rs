#![allow(clippy::missing_errors_doc)]

use std::fs;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, UdpSocket};
#[cfg(unix)]
use std::os::unix::fs::FileTypeExt as _;
use std::path::Path;
use std::time::Duration;

use anyhow::{Context as _, Result};
use fs2::{available_space, total_space};
use futures_util::{Sink, SinkExt, StreamExt};
use intar_contracts::bridge::{
    BRIDGE_PROTOCOL_VERSION, BUILD_REPORT_SCHEMA_VERSION, BridgeMessageV6, BuildPhase,
    BuildReportV1, ClientHelloV6, DesiredStateV6, HOST_DESIRED_STATE_SCHEMA_VERSION,
    HOST_STATE_REPORT_SCHEMA_VERSION, HostCapabilitiesV2, HostCapacityV2, HostDesiredStateV2,
    HostRoleV1, HostStateReportV2, StateReportV6, SyncRequestReason, SyncRequestV6,
};
use intar_contracts::catalog::{ImageArchitecture, Mib};
use reqwest::Client as HttpClient;
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, watch};
use tokio::time::{MissedTickBehavior, interval, sleep, timeout};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::Message;
use tracing::{debug, info, warn};

use crate::bundle::validate_desired_build_identity;
use crate::config::{BridgeConfig, BuilderConfig};
use crate::db::{BuildJobRow, BuilderDb};
use crate::jobs::reconcile_desired_builds;

const RETRY_MIN_MS: u64 = 1_000;
const RETRY_MAX_MS: u64 = 30_000;
const SERVER_HELLO_TIMEOUT_SECS: u64 = 10;
const BYTES_PER_MIB: u64 = 1024 * 1024;
const PRIMARY_IPV4_PROBE: (Ipv4Addr, u16) = (Ipv4Addr::new(1, 1, 1, 1), 80);
const PRIMARY_IPV6_PROBE: (Ipv6Addr, u16) = (
    Ipv6Addr::new(0x2606, 0x4700, 0x4700, 0, 0, 0, 0, 0x1111),
    80,
);

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

pub async fn run(
    cfg: BuilderConfig,
    db: BuilderDb,
    mut build_reports: mpsc::Receiver<BuildReportV1>,
    desired_ready: watch::Sender<bool>,
) -> Result<()> {
    let http = HttpClient::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .context("failed to initialize bridge http client")?;

    let mut retry_ms = RETRY_MIN_MS;
    let mut current_desired_state = load_cached_desired_state(&cfg.bridge, &db);
    if let Some(desired_state) = current_desired_state.as_ref()
        && let Err(error) = reconcile_cached_desired_state(&db, desired_state)
    {
        warn!(error = %error, "failed to reconcile cached builder desired state");
    }
    let mut reconnect = false;

    loop {
        match connect_once(
            &cfg,
            &http,
            &db,
            &mut build_reports,
            &mut current_desired_state,
            &desired_ready,
            reconnect,
        )
        .await
        {
            Ok(()) => {
                retry_ms = RETRY_MIN_MS;
                reconnect = true;
            }
            Err(error) => {
                warn!(error = %error, retry_ms, "builder bridge connection loop failed");
                sleep(Duration::from_millis(retry_ms)).await;
                retry_ms = (retry_ms.saturating_mul(2)).min(RETRY_MAX_MS);
                reconnect = true;
            }
        }
    }
}

async fn connect_once(
    cfg: &BuilderConfig,
    http: &HttpClient,
    db: &BuilderDb,
    build_reports: &mut mpsc::Receiver<BuildReportV1>,
    current_desired_state: &mut Option<HostDesiredStateV2>,
    desired_ready: &watch::Sender<bool>,
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

    let (ws_stream, _) = connect_async(request)
        .await
        .context("failed to connect builder bridge websocket")?;
    info!(host_id = %cfg.bridge.host_id, "builder bridge websocket connected");

    let (mut write, mut read) = ws_stream.split();
    let capabilities = collect_builder_capabilities(cfg);
    send_bridge_message(
        &mut write,
        &builder_client_hello(BuilderClientHelloInput {
            host_id: &cfg.bridge.host_id,
            agent_version: env!("CARGO_PKG_VERSION"),
            arch: capabilities.arch,
            supports_kvm: capabilities.supports_kvm,
            supports_vsock: capabilities.supports_vsock,
            // A process restart must receive and apply authoritative desired
            // state before any reset local job may run. Advertising no applied
            // version until this process applies a live update forces that
            // refresh even when a cached document has the current version or
            // the first connection attempt fails.
            last_applied_desired_version: advertised_desired_version(
                current_desired_state.as_ref(),
                *desired_ready.borrow(),
            ),
        }),
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
                    BridgeMessageV6::ServerHello(server_hello) => break Ok(server_hello),
                    other => {
                        anyhow::bail!("expected server_hello, got {}", bridge_message_type(&other))
                    }
                }
            }
        }
    })
    .await
    .context("timed out waiting for builder bridge server_hello")??;
    info!(
        host_id = %server_hello.host_id,
        desired_version = server_hello.desired_version,
        "builder bridge v6 handshake complete"
    );

    send_sync_request(
        &mut write,
        &cfg.bridge.host_id,
        if reconnect {
            SyncRequestReason::Reconnect
        } else {
            SyncRequestReason::Connect
        },
    )
    .await?;
    send_state_report(&mut write, cfg, db, current_desired_state.as_ref()).await?;

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
                    handle_server_message(
                        &mut write,
                        cfg,
                        db,
                        current_desired_state,
                        desired_ready,
                        message,
                    ).await?;
                }
            }
            _ = state_report_interval.tick() => {
                send_state_report(&mut write, cfg, db, current_desired_state.as_ref()).await?;
            }
            report = build_reports.recv() => {
                match report {
                    Some(report) => {
                        send_build_report(&mut write, &cfg.bridge.host_id, report).await?;
                    }
                    None => {
                        debug!("builder worker report channel closed");
                    }
                }
            }
        }
    }
}

async fn handle_server_message<W>(
    write: &mut W,
    cfg: &BuilderConfig,
    db: &BuilderDb,
    current_desired_state: &mut Option<HostDesiredStateV2>,
    desired_ready: &watch::Sender<bool>,
    message: BridgeMessageV6,
) -> Result<()>
where
    W: Sink<Message> + Unpin,
    W::Error: std::error::Error + Send + Sync + 'static,
{
    match message {
        BridgeMessageV6::DesiredState(message) => {
            let desired_state = message.desired_state.clone();
            apply_desired_state(&cfg.bridge, db, &message)
                .context("failed to apply builder desired state")?;
            *current_desired_state = Some(desired_state);
            desired_ready.send_replace(true);
            send_state_report(write, cfg, db, current_desired_state.as_ref()).await?;
        }
        BridgeMessageV6::SyncRequest(_) => {
            send_state_report(write, cfg, db, current_desired_state.as_ref()).await?;
        }
        BridgeMessageV6::ServerHello(_) => {
            anyhow::bail!("received duplicate server_hello after handshake");
        }
        BridgeMessageV6::ClientHello(_)
        | BridgeMessageV6::StateReport(_)
        | BridgeMessageV6::VmReport(_)
        | BridgeMessageV6::BuildReport(_) => {
            anyhow::bail!("server sent builder-originated bridge message");
        }
    }
    Ok(())
}

fn advertised_desired_version(
    current: Option<&HostDesiredStateV2>,
    has_fresh_desired_state: bool,
) -> Option<u64> {
    has_fresh_desired_state
        .then(|| current.map(|state| state.version))
        .flatten()
}

fn load_cached_desired_state(cfg: &BridgeConfig, db: &BuilderDb) -> Option<HostDesiredStateV2> {
    let row = match db.load_desired_state() {
        Ok(Some(row)) => row,
        Ok(None) => return None,
        Err(error) => {
            warn!(error = %error, "failed to load cached builder desired state");
            return None;
        }
    };

    let desired_state = match serde_json::from_str::<HostDesiredStateV2>(&row.doc_json) {
        Ok(value) => value,
        Err(error) => {
            warn!(error = %error, "cached builder desired state is invalid JSON");
            return None;
        }
    };
    if let Err(error) = validate_desired_state(&cfg.host_id, &desired_state) {
        warn!(error = %error, version = row.version, "cached builder desired state failed validation");
        return None;
    }

    info!(
        host_id = %cfg.host_id,
        version = desired_state.version,
        updated_at_ms = row.updated_at_ms,
        "loaded cached builder desired state"
    );
    Some(desired_state)
}

fn reconcile_cached_desired_state(
    db: &BuilderDb,
    desired_state: &HostDesiredStateV2,
) -> Result<()> {
    let inserted = reconcile_desired_builds(db, &desired_state.builds, now_ms())?;
    if inserted > 0 {
        info!(
            version = desired_state.version,
            inserted, "reconciled cached builder desired builds"
        );
    }
    Ok(())
}

fn apply_desired_state(cfg: &BridgeConfig, db: &BuilderDb, message: &DesiredStateV6) -> Result<()> {
    validate_desired_state(&cfg.host_id, &message.desired_state)?;
    cache_desired_state(db, &message.desired_state)?;
    let inserted = reconcile_desired_builds(db, &message.desired_state.builds, now_ms())?;
    info!(
        version = message.desired_state.version,
        desired_builds = message.desired_state.builds.len(),
        inserted,
        "applied builder desired state"
    );
    Ok(())
}

fn cache_desired_state(db: &BuilderDb, desired_state: &HostDesiredStateV2) -> Result<()> {
    let doc_json = serde_json::to_string(desired_state)
        .context("failed to serialize builder desired state")?;
    db.save_desired_state(desired_state.version, &doc_json, now_ms())
}

async fn send_state_report<W>(
    write: &mut W,
    cfg: &BuilderConfig,
    db: &BuilderDb,
    desired: Option<&HostDesiredStateV2>,
) -> Result<()>
where
    W: Sink<Message> + Unpin,
    W::Error: std::error::Error + Send + Sync + 'static,
{
    let report = build_host_state_report(cfg, db, desired)?;
    send_bridge_message(
        write,
        &BridgeMessageV6::StateReport(StateReportV6 {
            protocol_version: BRIDGE_PROTOCOL_VERSION,
            host_id: cfg.bridge.host_id.clone(),
            report,
        }),
    )
    .await
}

async fn send_build_report<W>(write: &mut W, host_id: &str, report: BuildReportV1) -> Result<()>
where
    W: Sink<Message> + Unpin,
    W::Error: std::error::Error + Send + Sync + 'static,
{
    send_bridge_message(
        write,
        &BridgeMessageV6::BuildReport(intar_contracts::bridge::BuildReportV6 {
            protocol_version: BRIDGE_PROTOCOL_VERSION,
            host_id: host_id.to_string(),
            report,
        }),
    )
    .await
}

async fn send_sync_request<W>(write: &mut W, host_id: &str, reason: SyncRequestReason) -> Result<()>
where
    W: Sink<Message> + Unpin,
    W::Error: std::error::Error + Send + Sync + 'static,
{
    send_bridge_message(
        write,
        &BridgeMessageV6::SyncRequest(SyncRequestV6 {
            protocol_version: BRIDGE_PROTOCOL_VERSION,
            host_id: host_id.to_string(),
            reason,
        }),
    )
    .await
}

fn build_host_state_report(
    cfg: &BuilderConfig,
    db: &BuilderDb,
    desired: Option<&HostDesiredStateV2>,
) -> Result<HostStateReportV2> {
    let now = now_ms();
    let builds = db
        .list_build_jobs()?
        .into_iter()
        .map(|row| build_report_from_job(&cfg.bridge.host_id, row))
        .collect();

    Ok(HostStateReportV2 {
        schema_version: HOST_STATE_REPORT_SCHEMA_VERSION,
        host_id: cfg.bridge.host_id.clone(),
        observed_at_unix_ms: now,
        applied_desired_version: desired.map(|state| state.version).unwrap_or(0),
        capacity: collect_builder_capacity(cfg),
        capabilities: collect_builder_capabilities(cfg),
        cached_images: Vec::new(),
        vms: Vec::new(),
        builds,
    })
}

pub fn build_report_from_job(host_id: &str, row: BuildJobRow) -> BuildReportV1 {
    let (phase, phase_error) = build_phase_from_str(&row.phase);
    BuildReportV1 {
        schema_version: BUILD_REPORT_SCHEMA_VERSION,
        host_id: host_id.to_string(),
        build_id: row.build_id,
        scenario_id: row.scenario_id,
        content_hash: row.content_hash,
        observed_at_unix_ms: row.updated_at_ms,
        phase,
        current_vm: row.current_vm,
        started_at_unix_ms: row.started_at_ms,
        finished_at_unix_ms: row.finished_at_ms,
        attempt: row.attempt,
        error: row.error.or(phase_error),
    }
}

fn build_phase_from_str(value: &str) -> (BuildPhase, Option<String>) {
    match value {
        "queued" => (BuildPhase::Queued, None),
        "fetching_sources" => (BuildPhase::FetchingSources, None),
        "building_base" => (BuildPhase::BuildingBase, None),
        "building" => (BuildPhase::Building, None),
        "publishing" => (BuildPhase::Publishing, None),
        "uploading_logs" => (BuildPhase::UploadingLogs, None),
        "succeeded" | "built" => (BuildPhase::Succeeded, None),
        "failed" => (BuildPhase::Failed, None),
        other => (
            BuildPhase::Failed,
            Some(format!("unknown local builder phase '{other}'")),
        ),
    }
}

fn collect_builder_capabilities(cfg: &BuilderConfig) -> HostCapabilitiesV2 {
    HostCapabilitiesV2 {
        arch: host_architecture(),
        cloud_hypervisor_sha256: None,
        boot_cpu_millis: None,
        boot_cpu_lease_ms: None,
        supports_kvm: cfg.qemu.accelerator == "kvm" && can_open_char_device(Path::new("/dev/kvm")),
        supports_vsock: can_open_char_device(Path::new("/dev/vhost-vsock")),
        supports_reflink: false,
        supports_nftables: false,
        supports_jailer_v2: false,
        supports_boot_cpu_lease: false,
        supports_template_backed_launch: false,
        fast_template_store: false,
        supports_hard_cpu_quota: false,
        supports_landlock: false,
        supports_cgroup_v2: false,
        // Builder hosts never broker learner run CLI requests.
        supports_run_cli_v1: false,
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

pub fn builder_client_hello(input: BuilderClientHelloInput<'_>) -> BridgeMessageV6 {
    BridgeMessageV6::ClientHello(ClientHelloV6 {
        protocol_version: BRIDGE_PROTOCOL_VERSION,
        host_id: input.host_id.to_string(),
        agent_version: input.agent_version.to_string(),
        role: HostRoleV1::Builder,
        last_applied_desired_version: input.last_applied_desired_version,
        capabilities: HostCapabilitiesV2 {
            arch: input.arch,
            cloud_hypervisor_sha256: None,
            boot_cpu_millis: None,
            boot_cpu_lease_ms: None,
            supports_kvm: input.supports_kvm,
            supports_vsock: input.supports_vsock,
            supports_reflink: false,
            supports_nftables: false,
            supports_jailer_v2: false,
            supports_boot_cpu_lease: false,
            supports_template_backed_launch: false,
            fast_template_store: false,
            supports_hard_cpu_quota: false,
            supports_landlock: false,
            supports_cgroup_v2: false,
            // Builder hosts never broker learner run CLI requests.
            supports_run_cli_v1: false,
        },
    })
}

#[derive(Debug, Clone)]
pub struct BuilderClientHelloInput<'a> {
    pub host_id: &'a str,
    pub agent_version: &'a str,
    pub arch: ImageArchitecture,
    pub supports_kvm: bool,
    pub supports_vsock: bool,
    pub last_applied_desired_version: Option<u64>,
}

pub fn host_architecture() -> ImageArchitecture {
    if cfg!(target_arch = "aarch64") {
        ImageArchitecture::Aarch64
    } else {
        ImageArchitecture::X86_64
    }
}

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
        .json(&BuilderBootstrapRequest {
            host_id: &cfg.host_id,
            bootstrap_token: &cfg.bootstrap_token,
        })
        .send()
        .await
        .with_context(|| format!("failed to bootstrap builder against {url}"))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("builder bootstrap failed with HTTP {status}: {body}");
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
        base.to_string()
    };
    format!("{ws_base}/agent/connect?hostId={host_id}")
}

async fn send_bridge_message<W>(write: &mut W, message: &BridgeMessageV6) -> Result<()>
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

fn parse_bridge_message(message: Message) -> Result<Option<BridgeMessageV6>> {
    match message {
        Message::Text(raw) => parse_bridge_json(&raw).map(Some),
        Message::Binary(raw) => {
            let raw = std::str::from_utf8(&raw).context("bridge binary message is not utf-8")?;
            parse_bridge_json(raw).map(Some)
        }
        Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => Ok(None),
        Message::Close(frame) => {
            anyhow::bail!("builder bridge websocket closed by peer: {:?}", frame);
        }
    }
}

fn parse_bridge_json(raw: &str) -> Result<BridgeMessageV6> {
    let message =
        serde_json::from_str::<BridgeMessageV6>(raw).context("invalid bridge v6 JSON message")?;
    if !message_has_v6_protocol(&message) {
        anyhow::bail!("invalid bridge protocol version; expected v6");
    }
    Ok(message)
}

fn validate_bridge_message(message: &BridgeMessageV6, host_id: &str) -> Result<()> {
    if !message_has_v6_protocol(message) {
        anyhow::bail!("invalid bridge protocol version; expected v6");
    }
    let message_host_id = bridge_message_host_id(message);
    if message_host_id != host_id {
        anyhow::bail!("bridge message host mismatch: expected {host_id}, got {message_host_id}");
    }
    Ok(())
}

fn validate_desired_state(host_id: &str, desired: &HostDesiredStateV2) -> Result<()> {
    if desired.schema_version != HOST_DESIRED_STATE_SCHEMA_VERSION {
        anyhow::bail!(
            "unsupported desired state schema version {}; expected {}",
            desired.schema_version,
            HOST_DESIRED_STATE_SCHEMA_VERSION
        );
    }
    if desired.host_id != host_id {
        anyhow::bail!(
            "desired state host mismatch: expected {host_id}, got {}",
            desired.host_id
        );
    }
    for build in &desired.builds {
        validate_desired_build_identity(build)?;
    }
    Ok(())
}

fn message_has_v6_protocol(message: &BridgeMessageV6) -> bool {
    match message {
        BridgeMessageV6::ClientHello(message) => {
            message.protocol_version == BRIDGE_PROTOCOL_VERSION
        }
        BridgeMessageV6::ServerHello(message) => {
            message.protocol_version == BRIDGE_PROTOCOL_VERSION
        }
        BridgeMessageV6::DesiredState(message) => {
            message.protocol_version == BRIDGE_PROTOCOL_VERSION
        }
        BridgeMessageV6::StateReport(message) => {
            message.protocol_version == BRIDGE_PROTOCOL_VERSION
        }
        BridgeMessageV6::VmReport(message) => message.protocol_version == BRIDGE_PROTOCOL_VERSION,
        BridgeMessageV6::BuildReport(message) => {
            message.protocol_version == BRIDGE_PROTOCOL_VERSION
        }
        BridgeMessageV6::SyncRequest(message) => {
            message.protocol_version == BRIDGE_PROTOCOL_VERSION
        }
    }
}

fn bridge_message_host_id(message: &BridgeMessageV6) -> &str {
    match message {
        BridgeMessageV6::ClientHello(message) => &message.host_id,
        BridgeMessageV6::ServerHello(message) => &message.host_id,
        BridgeMessageV6::DesiredState(message) => &message.host_id,
        BridgeMessageV6::StateReport(message) => &message.host_id,
        BridgeMessageV6::VmReport(message) => &message.host_id,
        BridgeMessageV6::BuildReport(message) => &message.host_id,
        BridgeMessageV6::SyncRequest(message) => &message.host_id,
    }
}

fn bridge_message_type(message: &BridgeMessageV6) -> &'static str {
    match message {
        BridgeMessageV6::ClientHello(_) => "client_hello",
        BridgeMessageV6::ServerHello(_) => "server_hello",
        BridgeMessageV6::DesiredState(_) => "desired_state",
        BridgeMessageV6::StateReport(_) => "state_report",
        BridgeMessageV6::VmReport(_) => "vm_report",
        BridgeMessageV6::BuildReport(_) => "build_report",
        BridgeMessageV6::SyncRequest(_) => "sync_request",
    }
}

fn available_cpu_count() -> u16 {
    std::thread::available_parallelism()
        .map(usize::from)
        .ok()
        .and_then(|count| u16::try_from(count).ok())
        .unwrap_or(0)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::path::Path;

    use intar_contracts::bridge::{BridgeMessageV6, HostRoleV1};
    use intar_contracts::catalog::ImageArchitecture;

    use crate::config::{BridgeConfig, BuilderConfig};
    use crate::db::BuilderDb;

    use super::{
        BuilderClientHelloInput, advertised_desired_version, build_host_state_report,
        builder_client_hello, can_open_char_device, parse_meminfo_kib, validate_desired_state,
    };

    #[test]
    fn char_device_probe_rejects_missing_and_regular_files() {
        let regular = tempfile::NamedTempFile::new().unwrap();

        assert!(!can_open_char_device(Path::new(
            "/tmp/intar-builder-missing-char-device"
        )));
        assert!(!can_open_char_device(regular.path()));
    }

    #[cfg(unix)]
    #[test]
    fn char_device_probe_accepts_openable_char_devices() {
        assert!(can_open_char_device(Path::new("/dev/null")));
    }

    #[test]
    fn builder_hello_uses_builder_role() {
        let message = builder_client_hello(BuilderClientHelloInput {
            host_id: "builder-1",
            agent_version: "0.1.0",
            arch: ImageArchitecture::X86_64,
            supports_kvm: true,
            supports_vsock: false,
            last_applied_desired_version: Some(7),
        });

        let BridgeMessageV6::ClientHello(hello) = message else {
            panic!("expected client hello");
        };
        assert_eq!(hello.role, HostRoleV1::Builder);
        assert_eq!(hello.host_id, "builder-1");
        assert_eq!(hello.last_applied_desired_version, Some(7));
        assert!(hello.capabilities.supports_kvm);
        assert!(!hello.capabilities.supports_vsock);
        assert!(!hello.capabilities.supports_run_cli_v1);
    }

    #[test]
    fn process_start_forces_fresh_desired_state_before_workers_run() {
        let desired = intar_contracts::bridge::HostDesiredStateV2 {
            schema_version: intar_contracts::bridge::HOST_DESIRED_STATE_SCHEMA_VERSION,
            host_id: "builder-1".to_string(),
            version: 7,
            generated_at_unix_ms: 1000,
            cached_images: Vec::new(),
            vms: Vec::new(),
            builds: Vec::new(),
        };

        assert_eq!(advertised_desired_version(Some(&desired), false), None);
        assert_eq!(advertised_desired_version(Some(&desired), true), Some(7));
        assert_eq!(advertised_desired_version(None, true), None);
    }

    #[test]
    fn builder_state_report_includes_build_reports() {
        let db = BuilderDb::open_in_memory().unwrap();
        let build = intar_contracts::bridge::DesiredBuildV1 {
            build_id: "build-1".to_string(),
            scenario_id: "broken-nginx".to_string(),
            arch: ImageArchitecture::X86_64,
            rev: "abc123".to_string(),
            content_hash: "f".repeat(64),
            bundle_ref: "builds/bundles/abc123.tar.gz".to_string(),
            kino_version: "0.1.24".to_string(),
        };
        db.upsert_build_job(&build, "queued", 0, None, 1000)
            .unwrap();
        db.update_build_job_phase("build-1", "building", Some("web"), 1, None, 2000)
            .unwrap();
        let cfg = BuilderConfig {
            bridge: BridgeConfig {
                host_id: "builder-1".to_string(),
                ..BridgeConfig::default()
            },
            ..BuilderConfig::default()
        };

        let report = build_host_state_report(&cfg, &db, None).unwrap();

        assert_eq!(report.host_id, "builder-1");
        assert_eq!(report.builds.len(), 1);
        assert_eq!(report.builds[0].build_id, "build-1");
        assert_eq!(report.builds[0].current_vm.as_deref(), Some("web"));
    }

    #[test]
    fn parses_linux_meminfo_capacity_fields() {
        let (total, available) = parse_meminfo_kib(
            "MemTotal:       32768000 kB\nMemFree:         1024000 kB\nMemAvailable:   24576000 kB\n",
        );

        assert_eq!(total, Some(32_768_000));
        assert_eq!(available, Some(24_576_000));
    }

    #[test]
    fn builder_state_report_includes_local_capacity() {
        let cache_root = tempfile::tempdir().unwrap();
        let db = BuilderDb::open_in_memory().unwrap();
        let cfg = BuilderConfig {
            bridge: BridgeConfig {
                host_id: "builder-1".to_string(),
                ..BridgeConfig::default()
            },
            builder: crate::config::BuilderRuntimeConfig {
                cache_root: cache_root.path().to_path_buf(),
                ..crate::config::BuilderRuntimeConfig::default()
            },
            ..BuilderConfig::default()
        };

        let report = build_host_state_report(&cfg, &db, None).unwrap();

        assert!(report.capacity.total_cpu_millis >= 1_000);
        assert_eq!(
            report.capacity.schedulable_cpu_millis,
            report.capacity.total_cpu_millis
        );
        assert!(report.capacity.disk_total_mib.0 > 0);
        assert!(report.capacity.disk_available_mib.0 > 0);
    }

    #[test]
    fn desired_state_rejects_invalid_build_identity() {
        let mut desired = intar_contracts::bridge::HostDesiredStateV2 {
            schema_version: intar_contracts::bridge::HOST_DESIRED_STATE_SCHEMA_VERSION,
            host_id: "builder-1".to_string(),
            version: 1,
            generated_at_unix_ms: 1000,
            cached_images: Vec::new(),
            vms: Vec::new(),
            builds: vec![intar_contracts::bridge::DesiredBuildV1 {
                build_id: "build-1".to_string(),
                scenario_id: "broken-nginx".to_string(),
                arch: ImageArchitecture::X86_64,
                rev: "abc123".to_string(),
                content_hash: "f".repeat(64),
                bundle_ref: "builds/bundles/abc123.tar.gz".to_string(),
                kino_version: "0.1.24".to_string(),
            }],
        };
        validate_desired_state("builder-1", &desired).unwrap();

        desired.builds[0].content_hash = "not-a-sha".to_string();
        let error = validate_desired_state("builder-1", &desired).unwrap_err();
        assert!(format!("{error:#}").contains("invalid content hash"));

        desired.builds[0].content_hash = "f".repeat(64);
        desired.builds[0].scenario_id = "..".to_string();
        let error = validate_desired_state("builder-1", &desired).unwrap_err();
        assert!(format!("{error:#}").contains("invalid scenario id"));
    }
}
