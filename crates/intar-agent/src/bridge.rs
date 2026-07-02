#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{Context as _, Result};
use futures_util::{Sink, SinkExt, StreamExt};
use intar_contracts::bridge::{
    BRIDGE_PROTOCOL_VERSION, BridgeMessageV4, CachedImageStateV1, ClientHelloV4, DesiredStateV4,
    DesiredVmPhase, DesiredVmV1, HOST_DESIRED_STATE_SCHEMA_VERSION,
    HOST_STATE_REPORT_SCHEMA_VERSION, HostCapabilitiesV1, HostCapacityV1, HostDesiredStateV1,
    HostStateReportV1, ImageCachePhase, StateReportV4, SyncRequestReason, SyncRequestV4,
    VM_REPORT_SCHEMA_VERSION, VmActualStateV1, VmArchivePhase, VmArchiveStateV1, VmNetworkStateV1,
    VmPhase, VmProbeSnapshotV1, VmProbeStatus, VmReportV1, VmReportV4, VmResourcesV1,
};
use intar_contracts::catalog::{ImageArchitecture, ImageKey, Mib, ProbePhase};
use reqwest::Client as HttpClient;
use serde::{Deserialize, Serialize};
use tokio::time::{MissedTickBehavior, interval, sleep, timeout};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::Message;
use tracing::{debug, info, warn};

use crate::config::BridgeConfig;
use crate::db::{Db, DesiredStateRow, VmProbeStateRow};
use crate::host_profile;
use crate::kino_probe::{ProbeSnapshotView, ProbeUpdateEnvelope, ProbeView};
use crate::vm::{
    CreateScenarioVmRequest, CreateScenarioVmRuntime, CreateScenarioVmRuntimeKino,
    CreateScenarioVmRuntimeNetwork, CreateVmResources, VmLifecycleState, VmManager,
    VmStatusResponse,
};

const RETRY_MIN_MS: u64 = 1_000;
const RETRY_MAX_MS: u64 = 30_000;
const SERVER_HELLO_TIMEOUT_SECS: u64 = 10;
const STATE_REPORT_INTERVAL_SECS: u64 = 20;
const DEFAULT_KINO_VSOCK_PORT: u32 = 18_080;

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
    let mut current_desired_state = load_cached_desired_state(&cfg, &db).await;
    if let Some(desired_state) = current_desired_state.clone()
        && let Err(error) = apply_cached_desired_state(&cfg, &vm, desired_state).await
    {
        warn!(error = %error, "failed to apply cached desired state");
    }
    let mut reconnect = false;

    loop {
        match connect_once(
            &cfg,
            &http,
            &vm,
            &db,
            &disk_probe_path,
            &mut current_desired_state,
            reconnect,
        )
        .await
        {
            Ok(()) => {
                retry_ms = RETRY_MIN_MS;
                reconnect = true;
            }
            Err(error) => {
                warn!(error = %error, retry_ms, "bridge connection loop failed");
                sleep(Duration::from_millis(retry_ms)).await;
                retry_ms = (retry_ms.saturating_mul(2)).min(RETRY_MAX_MS);
                reconnect = true;
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
    current_desired_state: &mut Option<HostDesiredStateV1>,
    reconnect: bool,
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
    send_bridge_message(
        &mut write,
        &BridgeMessageV4::ClientHello(ClientHelloV4 {
            protocol_version: BRIDGE_PROTOCOL_VERSION,
            host_id: cfg.host_id.clone(),
            agent_version: env!("CARGO_PKG_VERSION").to_string(),
            last_applied_desired_version: current_desired_state.as_ref().map(|state| state.version),
            capabilities: collect_host_capabilities(),
        }),
    )
    .await?;

    let server_hello = timeout(Duration::from_secs(SERVER_HELLO_TIMEOUT_SECS), async {
        loop {
            let Some(message) = read.next().await else {
                anyhow::bail!("websocket closed before server hello");
            };
            let message = message.context("failed reading bridge server hello")?;
            if let Some(message) = parse_bridge_message(message)? {
                validate_bridge_message(&message, &cfg.host_id)?;
                match message {
                    BridgeMessageV4::ServerHello(server_hello) => break Ok(server_hello),
                    other => {
                        anyhow::bail!("expected server_hello, got {}", bridge_message_type(&other))
                    }
                }
            }
        }
    })
    .await
    .context("timed out waiting for server_hello")??;
    info!(
        host_id = %server_hello.host_id,
        desired_version = server_hello.desired_version,
        "bridge v4 handshake complete"
    );

    send_sync_request(
        &mut write,
        &cfg.host_id,
        if reconnect {
            SyncRequestReason::Reconnect
        } else {
            SyncRequestReason::Connect
        },
    )
    .await?;
    send_state_report(
        &mut write,
        cfg,
        vm,
        db,
        disk_probe_path,
        current_desired_state.as_ref(),
    )
    .await?;

    let mut state_report_interval = interval(Duration::from_secs(STATE_REPORT_INTERVAL_SECS));
    state_report_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    state_report_interval.tick().await;
    let mut probe_updates = vm.subscribe_probe_updates();
    let mut terminal_updates = vm.subscribe_terminal_updates();

    loop {
        tokio::select! {
            inbound = read.next() => {
                let Some(inbound) = inbound else {
                    anyhow::bail!("bridge websocket closed");
                };
                let inbound = inbound.context("failed reading bridge message")?;
                if let Some(message) = parse_bridge_message(inbound)? {
                    validate_bridge_message(&message, &cfg.host_id)?;
                    handle_server_message(
                        &mut write,
                        cfg,
                        vm,
                        db,
                        disk_probe_path,
                        current_desired_state,
                        message,
                    ).await?;
                }
            }
            _ = state_report_interval.tick() => {
                send_state_report(
                    &mut write,
                    cfg,
                    vm,
                    db,
                    disk_probe_path,
                    current_desired_state.as_ref(),
                )
                .await?;
            }
            update = probe_updates.recv() => {
                match update {
                    Ok(update) => {
                        if let Some(report) = build_vm_report_from_probe_update(
                            &cfg.host_id,
                            vm,
                            current_desired_state.as_ref(),
                            &update,
                        )
                        .await {
                            send_vm_report(&mut write, &cfg.host_id, report).await?;
                        }
                    }
                    Err(error) => {
                        debug!(error = %error, "probe update channel lagged");
                    }
                }
            }
            update = terminal_updates.recv() => {
                match update {
                    Ok(update) => {
                        if let Some(status) = vm.get_vm(&update.vm_name).await {
                            let probes = load_probe_snapshots_for_vm(db, &update.run_id, &update.vm_name).await;
                            let report = build_vm_report_from_status(
                                &cfg.host_id,
                                current_desired_state.as_ref(),
                                status,
                                probes,
                            );
                            send_vm_report(&mut write, &cfg.host_id, report).await?;
                        }
                    }
                    Err(error) => {
                        debug!(error = %error, "terminal update channel lagged");
                    }
                }
            }
        }
    }
}

async fn handle_server_message<W>(
    write: &mut W,
    cfg: &BridgeConfig,
    vm: &VmManager,
    db: &Db,
    disk_probe_path: &Path,
    current_desired_state: &mut Option<HostDesiredStateV1>,
    message: BridgeMessageV4,
) -> Result<()>
where
    W: Sink<Message> + Unpin,
    W::Error: std::error::Error + Send + Sync + 'static,
{
    match message {
        BridgeMessageV4::DesiredState(message) => {
            let desired_state = message.desired_state.clone();
            cache_desired_state(db, &desired_state)
                .await
                .context("failed to cache desired state")?;
            let failure_reports = apply_desired_state(cfg, vm, &message).await?;
            *current_desired_state = Some(desired_state);
            for report in failure_reports {
                send_vm_report(write, &cfg.host_id, report).await?;
            }
            send_state_report(
                write,
                cfg,
                vm,
                db,
                disk_probe_path,
                current_desired_state.as_ref(),
            )
            .await?;
        }
        BridgeMessageV4::SyncRequest(_) => {
            send_state_report(
                write,
                cfg,
                vm,
                db,
                disk_probe_path,
                current_desired_state.as_ref(),
            )
            .await?;
        }
        BridgeMessageV4::ServerHello(_) => {
            anyhow::bail!("received duplicate server_hello after handshake");
        }
        BridgeMessageV4::ClientHello(_)
        | BridgeMessageV4::StateReport(_)
        | BridgeMessageV4::VmReport(_) => {
            anyhow::bail!("server sent agent-originated bridge message");
        }
    }
    Ok(())
}

async fn load_cached_desired_state(cfg: &BridgeConfig, db: &Db) -> Option<HostDesiredStateV1> {
    let row = match db.load_desired_state().await {
        Ok(Some(row)) => row,
        Ok(None) => return None,
        Err(error) => {
            warn!(error = %error, "failed to load cached desired state");
            return None;
        }
    };
    if row.host_id != cfg.host_id {
        warn!(
            cached_host_id = %row.host_id,
            configured_host_id = %cfg.host_id,
            "ignoring cached desired state for another host"
        );
        return None;
    }

    let desired_state = match serde_json::from_str::<HostDesiredStateV1>(&row.doc_json) {
        Ok(value) => value,
        Err(error) => {
            warn!(error = %error, "cached desired state is invalid JSON");
            return None;
        }
    };
    if let Err(error) = validate_desired_state(&cfg.host_id, &desired_state) {
        warn!(error = %error, version = row.version, "cached desired state failed validation");
        return None;
    }

    info!(
        host_id = %cfg.host_id,
        version = desired_state.version,
        updated_at_ms = row.updated_at_ms,
        "loaded cached desired state"
    );
    Some(desired_state)
}

async fn apply_cached_desired_state(
    cfg: &BridgeConfig,
    vm: &VmManager,
    desired_state: HostDesiredStateV1,
) -> Result<()> {
    let version = desired_state.version;
    let failure_reports = apply_desired_state(
        cfg,
        vm,
        &DesiredStateV4 {
            protocol_version: BRIDGE_PROTOCOL_VERSION,
            host_id: cfg.host_id.clone(),
            desired_state,
        },
    )
    .await?;
    if failure_reports.is_empty() {
        info!(version, "applied cached desired state");
    } else {
        warn!(
            version,
            failure_count = failure_reports.len(),
            "cached desired state produced vm failure reports while offline"
        );
    }
    Ok(())
}

async fn cache_desired_state(db: &Db, desired_state: &HostDesiredStateV1) -> Result<()> {
    let version = i64::try_from(desired_state.version)
        .context("desired state version exceeds sqlite INTEGER range")?;
    let doc_json =
        serde_json::to_string(desired_state).context("failed to serialize desired state")?;
    db.upsert_desired_state(DesiredStateRow {
        host_id: desired_state.host_id.clone(),
        version,
        doc_json,
        updated_at_ms: now_ms(),
    })
    .await
}

async fn apply_desired_state(
    cfg: &BridgeConfig,
    vm: &VmManager,
    message: &DesiredStateV4,
) -> Result<Vec<VmReportV1>> {
    validate_desired_state(&cfg.host_id, &message.desired_state)?;
    let desired = &message.desired_state;
    let now = now_ms();
    let mut failures = Vec::new();
    let desired_identities = desired
        .vms
        .iter()
        .map(|vm| (vm.run_id.as_str(), vm.vm_name.as_str()))
        .collect::<BTreeSet<_>>();
    let desired_absent = desired
        .vms
        .iter()
        .filter(|vm| vm.desired_phase == DesiredVmPhase::Absent)
        .map(|vm| (vm.run_id.as_str(), vm.vm_name.as_str()))
        .collect::<BTreeSet<_>>();

    for local in vm.list_vms().await {
        let Some(local_run_id) = local_run_id(&local) else {
            warn!(vm = %local.name, "destroying local vm without run identity");
            delete_vm_if_present(vm, &local.name).await;
            continue;
        };
        let identity = (local_run_id.as_str(), local.name.as_str());
        if desired_absent.contains(&identity) || !desired_identities.contains(&identity) {
            info!(
                run_id = %local_run_id,
                vm = %local.name,
                "destroying vm absent from desired state"
            );
            delete_vm_if_present(vm, &local.name).await;
        }
    }

    for desired_vm in desired
        .vms
        .iter()
        .filter(|vm| vm.desired_phase == DesiredVmPhase::Running)
    {
        match reconcile_desired_vm(cfg, vm, desired, desired_vm, now).await {
            Ok(()) => {}
            Err(error) => {
                warn!(
                    error = %error,
                    run_id = %desired_vm.run_id,
                    vm = %desired_vm.vm_name,
                    "failed to reconcile desired vm"
                );
                failures.push(failed_vm_report(
                    &cfg.host_id,
                    desired,
                    desired_vm,
                    now,
                    error.to_string(),
                ));
            }
        }
    }

    Ok(failures)
}

async fn reconcile_desired_vm(
    _cfg: &BridgeConfig,
    vm: &VmManager,
    desired: &HostDesiredStateV1,
    desired_vm: &DesiredVmV1,
    now: i64,
) -> Result<()> {
    if let Some(existing) = vm.get_vm(&desired_vm.vm_name).await {
        let existing_run_id = local_run_id(&existing);
        if existing_run_id.as_deref() == Some(desired_vm.run_id.as_str()) {
            return Ok(());
        }
        warn!(
            vm = %desired_vm.vm_name,
            desired_run_id = %desired_vm.run_id,
            existing_run_id = ?existing_run_id,
            "desired vm name is occupied by another run; deleting existing vm first"
        );
        delete_vm_if_present(vm, &desired_vm.vm_name).await;
        return Ok(());
    }

    let authorized_keys = desired_vm
        .ssh_authorized_keys_openssh
        .iter()
        .map(|key| key.trim())
        .filter(|key| !key.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    if authorized_keys.is_empty() {
        anyhow::bail!("desired vm has no ssh_authorized_keys_openssh entry");
    }
    let lease_duration_seconds = desired_lease_duration_seconds(desired_vm, now)?;

    vm.create_scenario_vm(CreateScenarioVmRequest {
        name: desired_vm.vm_name.clone(),
        run_id: desired_vm.run_id.clone(),
        image: image_cache_key(&desired_vm.image_key),
        resources: Some(resources_from_desired(&desired_vm.resources)),
        hostname: Some(desired_vm.vm_name.clone()),
        lease_duration_seconds: Some(lease_duration_seconds),
        runtime: CreateScenarioVmRuntime {
            ssh_authorized_keys_openssh: authorized_keys,
            network: None::<CreateScenarioVmRuntimeNetwork>,
            kino: Some(CreateScenarioVmRuntimeKino {
                vsock_cid: kino_vsock_cid(desired.version, desired_vm),
                vsock_port: Some(DEFAULT_KINO_VSOCK_PORT),
            }),
        },
    })
    .await
    .map(|_| ())
    .map_err(|error| anyhow::anyhow!("{}", error.message))
}

async fn delete_vm_if_present(vm: &VmManager, vm_name: &str) {
    match vm.delete_vm(vm_name).await {
        Ok(()) => {}
        Err(error) if error.status == axum::http::StatusCode::NOT_FOUND => {}
        Err(error) => warn!(vm = %vm_name, error = %error.message, "failed to delete vm"),
    }
}

async fn send_state_report<W>(
    write: &mut W,
    cfg: &BridgeConfig,
    vm: &VmManager,
    db: &Db,
    disk_probe_path: &Path,
    desired: Option<&HostDesiredStateV1>,
) -> Result<()>
where
    W: Sink<Message> + Unpin,
    W::Error: std::error::Error + Send + Sync + 'static,
{
    let report = build_host_state_report(&cfg.host_id, vm, db, disk_probe_path, desired).await;
    send_bridge_message(
        write,
        &BridgeMessageV4::StateReport(StateReportV4 {
            protocol_version: BRIDGE_PROTOCOL_VERSION,
            host_id: cfg.host_id.clone(),
            report,
        }),
    )
    .await
}

async fn send_vm_report<W>(write: &mut W, host_id: &str, report: VmReportV1) -> Result<()>
where
    W: Sink<Message> + Unpin,
    W::Error: std::error::Error + Send + Sync + 'static,
{
    send_bridge_message(
        write,
        &BridgeMessageV4::VmReport(VmReportV4 {
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
        &BridgeMessageV4::SyncRequest(SyncRequestV4 {
            protocol_version: BRIDGE_PROTOCOL_VERSION,
            host_id: host_id.to_string(),
            reason,
        }),
    )
    .await
}

async fn build_host_state_report(
    host_id: &str,
    vm: &VmManager,
    db: &Db,
    disk_probe_path: &Path,
    desired: Option<&HostDesiredStateV1>,
) -> HostStateReportV1 {
    let now = now_ms();
    let profile = host_profile::collect(disk_probe_path);
    let probe_rows = match db.load_all_vm_probe_states().await {
        Ok(rows) => rows,
        Err(error) => {
            warn!(error = %error, "failed to load persisted probe state for bridge report");
            Vec::new()
        }
    };
    let probes_by_vm = probe_snapshots_by_vm(probe_rows);

    HostStateReportV1 {
        schema_version: HOST_STATE_REPORT_SCHEMA_VERSION,
        host_id: host_id.to_string(),
        observed_at_unix_ms: now,
        applied_desired_version: desired.map(|state| state.version).unwrap_or(0),
        capacity: HostCapacityV1 {
            cpu_count: usize_to_u16(profile.cpu_cores),
            memory_total_mib: mib_from_u64(profile.memory_total_mib.unwrap_or(0)),
            memory_available_mib: mib_from_u64(profile.memory_available_mib.unwrap_or(0)),
            disk_total_mib: mib_from_u64(profile.disk_total_mib.unwrap_or(0)),
            disk_available_mib: mib_from_u64(profile.disk_available_mib.unwrap_or(0)),
        },
        capabilities: collect_host_capabilities(),
        cached_images: desired
            .map(|state| cached_image_states(state, now))
            .unwrap_or_default(),
        vms: vm
            .list_vms()
            .await
            .into_iter()
            .map(|status| {
                let run_id = local_run_id(&status).unwrap_or_default();
                let probes = probes_by_vm
                    .get(&(run_id.clone(), status.name.clone()))
                    .cloned()
                    .unwrap_or_default();
                actual_state_from_status(host_id, desired, status, probes)
            })
            .collect(),
    }
}

async fn build_vm_report_from_probe_update(
    host_id: &str,
    vm: &VmManager,
    desired: Option<&HostDesiredStateV1>,
    update: &ProbeUpdateEnvelope,
) -> Option<VmReportV1> {
    let status = vm.get_vm(&update.vm_name).await?;
    Some(build_vm_report_from_status(
        host_id,
        desired,
        status,
        probe_snapshots_from_update(update),
    ))
}

fn build_vm_report_from_status(
    host_id: &str,
    desired: Option<&HostDesiredStateV1>,
    status: VmStatusResponse,
    probes: Vec<VmProbeSnapshotV1>,
) -> VmReportV1 {
    let actual = actual_state_from_status(host_id, desired, status, probes);
    VmReportV1 {
        schema_version: VM_REPORT_SCHEMA_VERSION,
        host_id: host_id.to_string(),
        run_id: actual.run_id,
        vm_name: actual.vm_name,
        desired_version: actual.desired_version,
        observed_at_unix_ms: actual.updated_at_unix_ms,
        phase: actual.phase,
        network: actual.network,
        ssh_host_keys_openssh: actual.ssh_host_keys_openssh,
        probes: actual.probes,
        archive: actual.archive,
        error: actual.error,
    }
}

fn actual_state_from_status(
    _host_id: &str,
    desired: Option<&HostDesiredStateV1>,
    status: VmStatusResponse,
    probes: Vec<VmProbeSnapshotV1>,
) -> VmActualStateV1 {
    let run_id = local_run_id(&status).unwrap_or_default();
    let desired_vm = desired.and_then(|state| {
        state
            .vms
            .iter()
            .find(|vm| vm.run_id == run_id && vm.vm_name == status.name)
    });

    VmActualStateV1 {
        run_id,
        vm_name: status.name.clone(),
        desired_version: desired_vm.and_then(|_| desired.map(|state| state.version)),
        phase: vm_phase_from_status(&status, &probes),
        image_key: desired_vm.map(|vm| vm.image_key.clone()),
        image_sha256: desired_vm.map(|vm| vm.image_sha256.clone()),
        network: network_state_from_status(&status),
        ssh_host_keys_openssh: status
            .details
            .as_ref()
            .map(|details| details.ssh_host_keys_openssh.clone())
            .unwrap_or_default(),
        probes,
        archive: archive_state_from_status(&status),
        error: status.error.clone(),
        updated_at_unix_ms: parse_rfc3339_ms(&status.updated_at).unwrap_or_else(now_ms),
    }
}

fn failed_vm_report(
    host_id: &str,
    desired: &HostDesiredStateV1,
    vm: &DesiredVmV1,
    observed_at_unix_ms: i64,
    error: String,
) -> VmReportV1 {
    VmReportV1 {
        schema_version: VM_REPORT_SCHEMA_VERSION,
        host_id: host_id.to_string(),
        run_id: vm.run_id.clone(),
        vm_name: vm.vm_name.clone(),
        desired_version: Some(desired.version),
        observed_at_unix_ms,
        phase: VmPhase::Failed,
        network: None,
        ssh_host_keys_openssh: Vec::new(),
        probes: Vec::new(),
        archive: None,
        error: Some(error),
    }
}

fn vm_phase_from_status(status: &VmStatusResponse, probes: &[VmProbeSnapshotV1]) -> VmPhase {
    match status.state {
        VmLifecycleState::Queued => VmPhase::Pending,
        VmLifecycleState::CachingImage => VmPhase::PullingImage,
        VmLifecycleState::PreparingDisks => VmPhase::CreatingDisks,
        VmLifecycleState::CreatingVm | VmLifecycleState::BootingVm => VmPhase::Booting,
        VmLifecycleState::Running => {
            if !probes.is_empty()
                && probes
                    .iter()
                    .all(|probe| probe.status == VmProbeStatus::Pass)
            {
                VmPhase::Solved
            } else if status
                .details
                .as_ref()
                .and_then(|details| details.ssh_public_port)
                .is_some()
            {
                VmPhase::Ready
            } else {
                VmPhase::Running
            }
        }
        VmLifecycleState::DeletingVm | VmLifecycleState::ArchivingArtifacts => VmPhase::Stopping,
        VmLifecycleState::Failed | VmLifecycleState::DeleteFailed => VmPhase::Failed,
    }
}

fn network_state_from_status(status: &VmStatusResponse) -> Option<VmNetworkStateV1> {
    let details = status.details.as_ref()?;
    let guest_ip = details.guest_ip.as_ref()?.trim();
    if guest_ip.is_empty() {
        return None;
    }
    let guest_cidr = details.guest_ip_cidr.as_ref()?.trim();
    let gateway = details.gateway.as_ref()?.trim();
    let bridge_name = details.bridge_name.as_ref()?.trim();
    if guest_cidr.is_empty() || gateway.is_empty() || bridge_name.is_empty() {
        return None;
    }
    Some(VmNetworkStateV1 {
        bridge_name: bridge_name.to_string(),
        guest_ip: guest_ip.to_string(),
        guest_cidr: guest_cidr.to_string(),
        gateway: gateway.to_string(),
        ssh_host_port: details.ssh_public_port,
    })
}

fn archive_state_from_status(status: &VmStatusResponse) -> Option<VmArchiveStateV1> {
    match status.state {
        VmLifecycleState::ArchivingArtifacts => Some(VmArchiveStateV1 {
            phase: VmArchivePhase::Uploading,
            artifact_count: 0,
            error: None,
        }),
        VmLifecycleState::DeletingVm => Some(VmArchiveStateV1 {
            phase: VmArchivePhase::Pending,
            artifact_count: 0,
            error: None,
        }),
        VmLifecycleState::DeleteFailed => Some(VmArchiveStateV1 {
            phase: VmArchivePhase::Failed,
            artifact_count: 0,
            error: status.error.clone(),
        }),
        _ => None,
    }
}

async fn load_probe_snapshots_for_vm(
    db: &Db,
    run_id: &str,
    vm_name: &str,
) -> Vec<VmProbeSnapshotV1> {
    match db.load_vm_probe_state(vm_name.to_string()).await {
        Ok(Some(row)) if row.run_id == run_id => probe_snapshots_from_state_row(&row),
        Ok(_) => Vec::new(),
        Err(error) => {
            warn!(error = %error, run_id, vm = vm_name, "failed to load vm probe state");
            Vec::new()
        }
    }
}

fn probe_snapshots_by_vm(
    rows: Vec<VmProbeStateRow>,
) -> BTreeMap<(String, String), Vec<VmProbeSnapshotV1>> {
    rows.into_iter()
        .map(|row| {
            (
                (row.run_id.clone(), row.vm_name.clone()),
                probe_snapshots_from_state_row(&row),
            )
        })
        .collect()
}

fn probe_snapshots_from_state_row(row: &VmProbeStateRow) -> Vec<VmProbeSnapshotV1> {
    if let Ok(update) = serde_json::from_str::<ProbeUpdateEnvelope>(&row.snapshot_json) {
        return probe_snapshots_from_update(&update);
    }
    serde_json::from_str::<ProbeSnapshotView>(&row.snapshot_json)
        .map(|snapshot| probe_snapshots_from_snapshot(row.generated_at_ms, &snapshot))
        .unwrap_or_default()
}

fn probe_snapshots_from_update(update: &ProbeUpdateEnvelope) -> Vec<VmProbeSnapshotV1> {
    probe_snapshots_from_probes(update.generated_at_ms, &update.probes)
}

fn probe_snapshots_from_snapshot(
    fallback_observed_at_unix_ms: i64,
    snapshot: &ProbeSnapshotView,
) -> Vec<VmProbeSnapshotV1> {
    probe_snapshots_from_probes(
        snapshot
            .generated_at_ms
            .unwrap_or(fallback_observed_at_unix_ms),
        &snapshot.probes,
    )
}

fn probe_snapshots_from_probes(
    observed_at_unix_ms: i64,
    probes: &[ProbeView],
) -> Vec<VmProbeSnapshotV1> {
    probes
        .iter()
        .filter(|probe| !probe.id.trim().is_empty())
        .map(|probe| VmProbeSnapshotV1 {
            id: probe.id.clone(),
            phase: ProbePhase::Scenario,
            status: probe_status(&probe.status),
            checked_at_unix_ms: probe.last_attempt_at_ms.unwrap_or(observed_at_unix_ms),
            message: probe.error.clone(),
            value: if probe.value.is_null() {
                None
            } else {
                Some(probe.value.clone())
            },
        })
        .collect()
}

fn probe_status(status: &str) -> VmProbeStatus {
    match status.trim().to_ascii_lowercase().as_str() {
        "pass" | "passed" | "ready" | "ok" | "succeeded" | "success" => VmProbeStatus::Pass,
        "fail" | "failed" | "error" | "errored" => VmProbeStatus::Fail,
        _ => VmProbeStatus::Unknown,
    }
}

fn cached_image_states(desired: &HostDesiredStateV1, now: i64) -> Vec<CachedImageStateV1> {
    let cache_root = crate::image_cache::default_cache_root().ok();
    desired
        .cached_images
        .iter()
        .map(|desired_image| {
            let key = image_cache_key(&desired_image.image_key);
            let image_path = cache_root.as_ref().map(|root| {
                root.join(&key)
                    .join(format!("{}.raw", desired_image.image_sha256))
            });
            let metadata = image_path
                .as_ref()
                .and_then(|path| std::fs::metadata(path).ok());
            CachedImageStateV1 {
                image_key: desired_image.image_key.clone(),
                image_sha256: desired_image.image_sha256.clone(),
                phase: if metadata.is_some() {
                    ImageCachePhase::Ready
                } else {
                    ImageCachePhase::Missing
                },
                bytes_on_disk: metadata.map(|meta| meta.len()),
                error: None,
                updated_at_unix_ms: now,
            }
        })
        .collect()
}

fn collect_host_capabilities() -> HostCapabilitiesV1 {
    HostCapabilitiesV1 {
        arch: host_architecture(),
        supports_kvm: Path::new("/dev/kvm").exists(),
        supports_vsock: Path::new("/dev/vhost-vsock").exists(),
        supports_reflink: supports_reflink_for_image_cache(),
        supports_nftables: command_exists("nft"),
    }
}

fn supports_reflink_for_image_cache() -> bool {
    static SUPPORTS_REFLINK: OnceLock<bool> = OnceLock::new();
    *SUPPORTS_REFLINK.get_or_init(probe_reflink_for_image_cache)
}

fn probe_reflink_for_image_cache() -> bool {
    let Ok(cache_root) = crate::image_cache::default_cache_root() else {
        return false;
    };
    let probe_dir = cache_root.join(".capabilities");
    if std::fs::create_dir_all(&probe_dir).is_err() {
        return false;
    }

    let src = probe_dir.join("reflink-src");
    let dst = probe_dir.join("reflink-dst");
    let _ = std::fs::remove_file(&dst);
    if std::fs::write(&src, b"intar reflink probe\n").is_err() {
        return false;
    }

    let supported = Command::new("cp")
        .arg("--reflink=always")
        .arg("--sparse=always")
        .arg(&src)
        .arg(&dst)
        .status()
        .is_ok_and(|status| status.success());

    let _ = std::fs::remove_file(&src);
    let _ = std::fs::remove_file(&dst);
    supported
}

fn host_architecture() -> ImageArchitecture {
    if cfg!(target_arch = "aarch64") {
        ImageArchitecture::Aarch64
    } else {
        ImageArchitecture::X86_64
    }
}

fn command_exists(command: &str) -> bool {
    std::env::var_os("PATH")
        .and_then(|path| {
            std::env::split_paths(&path)
                .map(|dir| dir.join(command))
                .find(|path| path.is_file())
        })
        .is_some()
}

async fn bootstrap_agent_access(
    cfg: &BridgeConfig,
    http: &HttpClient,
) -> Result<AgentBootstrapResponse> {
    let url = format!("{}/api/agent/bootstrap", cfg.base_url.trim_end_matches('/'));
    let response = http
        .post(&url)
        .json(&AgentBootstrapRequest {
            host_id: &cfg.host_id,
            bootstrap_token: &cfg.bootstrap_token,
        })
        .send()
        .await
        .with_context(|| format!("failed to bootstrap agent against {url}"))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("agent bootstrap failed with HTTP {status}: {body}");
    }

    response
        .json::<AgentBootstrapResponse>()
        .await
        .context("failed to parse bootstrap response")
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
    format!("{ws_base}/api/agent/bridge/{host_id}")
}

async fn send_bridge_message<W>(write: &mut W, message: &BridgeMessageV4) -> Result<()>
where
    W: Sink<Message> + Unpin,
    W::Error: std::error::Error + Send + Sync + 'static,
{
    let raw = serde_json::to_string(message).context("failed to serialize bridge message")?;
    write
        .send(Message::Text(raw.into()))
        .await
        .context("failed to send bridge websocket message")
}

fn parse_bridge_message(message: Message) -> Result<Option<BridgeMessageV4>> {
    match message {
        Message::Text(raw) => parse_bridge_json(&raw).map(Some),
        Message::Binary(raw) => {
            let raw = std::str::from_utf8(&raw).context("bridge binary message is not utf-8")?;
            parse_bridge_json(raw).map(Some)
        }
        Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => Ok(None),
        Message::Close(frame) => {
            anyhow::bail!("bridge websocket closed by peer: {:?}", frame);
        }
    }
}

fn parse_bridge_json(raw: &str) -> Result<BridgeMessageV4> {
    let message =
        serde_json::from_str::<BridgeMessageV4>(raw).context("invalid bridge v4 JSON message")?;
    if !message_has_v4_protocol(&message) {
        anyhow::bail!("invalid bridge protocol version; expected v4");
    }
    Ok(message)
}

fn validate_bridge_message(message: &BridgeMessageV4, host_id: &str) -> Result<()> {
    if !message_has_v4_protocol(message) {
        anyhow::bail!("invalid bridge protocol version; expected v4");
    }
    let message_host_id = bridge_message_host_id(message);
    if message_host_id != host_id {
        anyhow::bail!("bridge message host mismatch: expected {host_id}, got {message_host_id}");
    }
    Ok(())
}

fn validate_desired_state(host_id: &str, desired: &HostDesiredStateV1) -> Result<()> {
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
    Ok(())
}

fn message_has_v4_protocol(message: &BridgeMessageV4) -> bool {
    match message {
        BridgeMessageV4::ClientHello(message) => {
            message.protocol_version == BRIDGE_PROTOCOL_VERSION
        }
        BridgeMessageV4::ServerHello(message) => {
            message.protocol_version == BRIDGE_PROTOCOL_VERSION
        }
        BridgeMessageV4::DesiredState(message) => {
            message.protocol_version == BRIDGE_PROTOCOL_VERSION
        }
        BridgeMessageV4::StateReport(message) => {
            message.protocol_version == BRIDGE_PROTOCOL_VERSION
        }
        BridgeMessageV4::VmReport(message) => message.protocol_version == BRIDGE_PROTOCOL_VERSION,
        BridgeMessageV4::SyncRequest(message) => {
            message.protocol_version == BRIDGE_PROTOCOL_VERSION
        }
    }
}

fn bridge_message_host_id(message: &BridgeMessageV4) -> &str {
    match message {
        BridgeMessageV4::ClientHello(message) => &message.host_id,
        BridgeMessageV4::ServerHello(message) => &message.host_id,
        BridgeMessageV4::DesiredState(message) => &message.host_id,
        BridgeMessageV4::StateReport(message) => &message.host_id,
        BridgeMessageV4::VmReport(message) => &message.host_id,
        BridgeMessageV4::SyncRequest(message) => &message.host_id,
    }
}

fn bridge_message_type(message: &BridgeMessageV4) -> &'static str {
    match message {
        BridgeMessageV4::ClientHello(_) => "client_hello",
        BridgeMessageV4::ServerHello(_) => "server_hello",
        BridgeMessageV4::DesiredState(_) => "desired_state",
        BridgeMessageV4::StateReport(_) => "state_report",
        BridgeMessageV4::VmReport(_) => "vm_report",
        BridgeMessageV4::SyncRequest(_) => "sync_request",
    }
}

fn local_run_id(status: &VmStatusResponse) -> Option<String> {
    status
        .details
        .as_ref()
        .and_then(|details| details.run_id.as_deref())
        .map(str::trim)
        .filter(|run_id| !run_id.is_empty())
        .map(ToOwned::to_owned)
}

fn resources_from_desired(resources: &VmResourcesV1) -> CreateVmResources {
    CreateVmResources {
        vcpus: u32::from(resources.cpu_count),
        memory_mib: resources.memory_mib.0,
        disk_mib: Some(resources.disk_mib.0),
    }
}

fn desired_lease_duration_seconds(vm: &DesiredVmV1, now_ms: i64) -> Result<u64> {
    let remaining_ms = vm.lease_expires_at_unix_ms.saturating_sub(now_ms);
    let seconds = u64::try_from((remaining_ms / 1_000).max(1)).unwrap_or(u64::MAX);
    Ok(seconds)
}

fn image_cache_key(image_key: &ImageKey) -> String {
    format!(
        "{}-{}-{}",
        image_key.scenario,
        image_key.vm,
        image_architecture_slug(&image_key.arch)
    )
}

fn image_architecture_slug(arch: &ImageArchitecture) -> &'static str {
    match arch {
        ImageArchitecture::X86_64 => "x86_64",
        ImageArchitecture::Aarch64 => "aarch64",
    }
}

fn kino_vsock_cid(desired_version: u64, vm: &DesiredVmV1) -> u32 {
    let mut hash = desired_version;
    for byte in vm.run_id.bytes().chain(vm.vm_name.bytes()) {
        hash = hash.wrapping_mul(16_777_619) ^ u64::from(byte);
    }
    10_000 + u32::try_from(hash % 50_000).unwrap_or(0)
}

fn usize_to_u16(value: usize) -> u16 {
    u16::try_from(value).unwrap_or(u16::MAX)
}

fn mib_from_u64(value: u64) -> Mib {
    Mib(u32::try_from(value).unwrap_or(u32::MAX))
}

fn parse_rfc3339_ms(value: &str) -> Option<i64> {
    let parsed =
        time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).ok()?;
    i64::try_from(parsed.unix_timestamp_nanos() / 1_000_000).ok()
}

fn now_ms() -> i64 {
    let millis = time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
    i64::try_from(millis).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn desired_vm() -> DesiredVmV1 {
        DesiredVmV1 {
            run_id: "run-1".to_string(),
            vm_name: "web".to_string(),
            desired_phase: DesiredVmPhase::Running,
            image_key: ImageKey {
                scenario: "broken-nginx".to_string(),
                vm: "web".to_string(),
                arch: ImageArchitecture::X86_64,
            },
            image_sha256: "a".repeat(64),
            resources: VmResourcesV1 {
                cpu_count: 1,
                memory_mib: Mib(512),
                disk_mib: Mib(4096),
            },
            ssh_authorized_keys_openssh: vec!["ssh-ed25519 AAAATEST run".to_string()],
            lease_expires_at_unix_ms: now_ms() + 60_000,
        }
    }

    #[test]
    fn parses_only_v4_bridge_messages() {
        let message = BridgeMessageV4::SyncRequest(SyncRequestV4 {
            protocol_version: BRIDGE_PROTOCOL_VERSION,
            host_id: "host-1".to_string(),
            reason: SyncRequestReason::Connect,
        });
        let raw = serde_json::to_string(&message).expect("serialize");

        assert!(parse_bridge_json(&raw).is_ok());

        let raw_v3 = raw.replace("\"protocol_version\":4", "\"protocol_version\":3");
        let error = parse_bridge_json(&raw_v3).expect_err("v3 should fail");
        assert!(error.to_string().contains("expected v4"));
    }

    #[test]
    fn image_cache_key_matches_committed_catalog_format() {
        assert_eq!(
            image_cache_key(&desired_vm().image_key),
            "broken-nginx-web-x86_64"
        );
    }

    #[test]
    fn desired_lease_duration_has_minimum_one_second() {
        let mut vm = desired_vm();
        vm.lease_expires_at_unix_ms = now_ms() - 1_000;
        assert_eq!(
            desired_lease_duration_seconds(&vm, now_ms()).expect("lease"),
            1
        );
    }
}
