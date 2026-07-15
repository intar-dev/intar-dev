#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
#[cfg(all(test, unix))]
use std::os::unix::fs::FileTypeExt as _;
#[cfg(unix)]
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use anyhow::{Context as _, Result};
use futures_util::{Sink, SinkExt, StreamExt, future::join_all};
use intar_contracts::bridge::{
    BRIDGE_PROTOCOL_VERSION, BridgeMessageV6, CachedImageStateV1, ClientHelloV6, DesiredStateV6,
    DesiredVmPhase, DesiredVmV2, HOST_DESIRED_STATE_SCHEMA_VERSION,
    HOST_STATE_REPORT_SCHEMA_VERSION, HostCapabilitiesV2, HostCapacityV2, HostDesiredStateV2,
    HostRoleV1, HostStateReportV2, ImageCachePhase, StateReportV6, SyncRequestReason,
    SyncRequestV6, VM_REPORT_SCHEMA_VERSION, VmActualStateV2, VmArchivePhase, VmArchiveStateV1,
    VmBootEvidenceV1, VmNetworkStateV1, VmPhase, VmProbeSnapshotV1, VmProbeStatus, VmReportV2,
    VmReportV6, VmResourceStateV2, VmResourcesV2, VmRuntimeConstraintPhaseV1,
    VmRuntimeConstraintsV1, VmSandboxStateV1, VmTerminalStateKindV1, VmTerminalStateV1,
    VmTerminalTargetV1,
};
use intar_contracts::catalog::{ImageArchitecture, ImageKey, Mib, ProbePhase};
use intar_jailer_protocol::{JailerCapabilities, SandboxHealth, VmCpuPhase, VmInspection};
use reqwest::Client as HttpClient;
use serde::{Deserialize, Serialize};
use tokio::sync::{RwLock, mpsc, watch};
use tokio::time::{MissedTickBehavior, interval, sleep, timeout};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::Message;
use tracing::{debug, info, warn};

use crate::config::BridgeConfig;
use crate::db::{Db, DesiredStateRow, VmProbeStateRow};
use crate::host_profile;
use crate::kino_probe::{ProbeUpdateEnvelope, ProbeView};
use crate::vm::{
    CreateScenarioVmRequest, CreateScenarioVmRuntime, CreateScenarioVmRuntimeKino,
    CreateScenarioVmRuntimeNetwork, CreateVmResources, VmLifecycleState, VmManager,
    VmStatusResponse, VmTerminalState, VmTerminalStateKind,
};

const RETRY_MIN_MS: u64 = 1_000;
const RETRY_MAX_MS: u64 = 30_000;
const SERVER_HELLO_TIMEOUT_SECS: u64 = 10;
const STATE_REPORT_INTERVAL_SECS: u64 = 20;
const INVENTORY_REPORT_JAILER_BUDGET_MS: u64 = 50;
const OUTBOUND_SEND_BUDGET_MS: u64 = 75;
#[cfg(test)]
const INVENTORY_DELIVERY_TARGET_MS: u64 = 250;
const INVENTORY_OUTBOUND_CAPACITY: usize = 1;
const NORMAL_OUTBOUND_CAPACITY: usize = 64;
const DEFAULT_KINO_VSOCK_PORT: u32 = 18_080;

#[derive(Clone)]
struct BridgeReportCache {
    host_profile: Arc<RwLock<host_profile::HostProfile>>,
    jailer_capabilities: Arc<RwLock<Option<JailerCapabilities>>>,
    host_capabilities: Arc<RwLock<HostCapabilitiesV2>>,
    cached_images: Arc<RwLock<Vec<CachedImageStateV1>>>,
}

impl BridgeReportCache {
    fn new(
        host_profile: host_profile::HostProfile,
        jailer_capabilities: Option<JailerCapabilities>,
        host_capabilities: HostCapabilitiesV2,
    ) -> Self {
        Self {
            host_profile: Arc::new(RwLock::new(host_profile)),
            jailer_capabilities: Arc::new(RwLock::new(jailer_capabilities)),
            host_capabilities: Arc::new(RwLock::new(host_capabilities)),
            cached_images: Arc::new(RwLock::new(Vec::new())),
        }
    }
}

#[derive(Clone)]
struct BridgeOutbound {
    inventory: mpsc::Sender<BridgeMessageV6>,
    normal: mpsc::Sender<BridgeMessageV6>,
}

#[derive(Clone)]
struct BridgeReportSources {
    cfg: BridgeConfig,
    vm: VmManager,
    db: Db,
    disk_probe_path: PathBuf,
    cache: BridgeReportCache,
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
    current_desired_state: &mut Option<HostDesiredStateV2>,
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
    let hello_jailer = vm.jailer_capabilities().await.ok();
    let hello_capabilities = collect_host_capabilities(hello_jailer.as_ref());
    send_bridge_message(
        &mut write,
        &BridgeMessageV6::ClientHello(ClientHelloV6 {
            protocol_version: BRIDGE_PROTOCOL_VERSION,
            host_id: cfg.host_id.clone(),
            agent_version: env!("CARGO_PKG_VERSION").to_string(),
            role: HostRoleV1::Agent,
            last_applied_desired_version: current_desired_state.as_ref().map(|state| state.version),
            capabilities: hello_capabilities.clone(),
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
                    BridgeMessageV6::ServerHello(server_hello) => break Ok(server_hello),
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
        "bridge v6 handshake complete"
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
    // Subscribe before either report builder starts so a mutation that races
    // the initial full snapshot remains pending for the independent fast path.
    let inventory_updates = vm.subscribe_inventory_updates();
    let (desired_state_tx, desired_state_rx) = watch::channel(current_desired_state.clone());
    let report_cache = BridgeReportCache::new(
        host_profile::collect(disk_probe_path),
        hello_jailer.clone(),
        hello_capabilities,
    );
    let report_sources = BridgeReportSources {
        cfg: cfg.clone(),
        vm: vm.clone(),
        db: db.clone(),
        disk_probe_path: disk_probe_path.to_path_buf(),
        cache: report_cache,
    };
    let (inventory_tx, inventory_rx) = mpsc::channel(INVENTORY_OUTBOUND_CAPACITY);
    let (normal_tx, normal_rx) = mpsc::channel(NORMAL_OUTBOUND_CAPACITY);
    let outbound = BridgeOutbound {
        inventory: inventory_tx,
        normal: normal_tx,
    };

    // One task owns the websocket sink. Inventory reports have a dedicated
    // queue and strict priority, while every individual socket send is bounded
    // so a blocked ordinary report cannot consume the 250 ms freshness budget.
    let mut writer_task = tokio::spawn(run_bridge_writer(write, inventory_rx, normal_rx));
    let mut inventory_task = tokio::spawn(run_inventory_reporter(
        report_sources.clone(),
        inventory_updates,
        desired_state_rx,
        outbound.inventory.clone(),
    ));

    let connection_result = async {
        send_state_report(
            &outbound.normal,
            &report_sources,
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
                            &outbound.normal,
                            &report_sources,
                            current_desired_state,
                            &desired_state_tx,
                            message,
                        ).await?;
                    }
                }
                _ = state_report_interval.tick() => {
                    send_state_report(
                        &outbound.normal,
                        &report_sources,
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
                                send_vm_report(&outbound.normal, &cfg.host_id, report).await?;
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
                                if !terminal_update_matches_status(&update, &status) {
                                    warn!(
                                        vm = update.vm_name,
                                        run_id = update.run_id,
                                        update_generation = ?update.runtime_constraints.as_ref().map(|constraints| &constraints.generation),
                                        current_generation = ?status.details.as_ref().and_then(|details| details.jail_generation.as_deref()),
                                        "dropping stale-generation terminal projection"
                                    );
                                    continue;
                                }
                                let probes = load_probe_snapshots_for_vm(
                                    db,
                                    &update.run_id,
                                    &update.vm_name,
                                    update
                                        .runtime_constraints
                                        .as_ref()
                                        .map(|constraints| constraints.generation.as_str()),
                                )
                                .await;
                                let report = build_vm_report_from_status(
                                    &cfg.host_id,
                                    vm.ssh_advertised_host().as_deref(),
                                    current_desired_state.as_ref(),
                                    status,
                                    probes,
                                    None,
                                    Some(&update),
                                );
                                send_vm_report(&outbound.normal, &cfg.host_id, report).await?;
                            }
                        }
                        Err(error) => {
                            debug!(error = %error, "terminal update channel lagged");
                        }
                    }
                }
                result = &mut writer_task => {
                    result.context("bridge writer task panicked")??;
                    anyhow::bail!("bridge writer task exited");
                }
                result = &mut inventory_task => {
                    result.context("inventory reporter task panicked")??;
                    anyhow::bail!("inventory reporter task exited");
                }
            }
        }
    }
    .await;

    writer_task.abort();
    inventory_task.abort();
    connection_result
}

async fn handle_server_message(
    outbound: &mpsc::Sender<BridgeMessageV6>,
    sources: &BridgeReportSources,
    current_desired_state: &mut Option<HostDesiredStateV2>,
    desired_state_tx: &watch::Sender<Option<HostDesiredStateV2>>,
    message: BridgeMessageV6,
) -> Result<()> {
    let cfg = &sources.cfg;
    let vm = &sources.vm;
    let db = &sources.db;
    match message {
        BridgeMessageV6::DesiredState(message) => {
            let desired_state = message.desired_state.clone();
            if desired_state_is_stale(current_desired_state.as_ref(), &desired_state) {
                let current_version = current_desired_state
                    .as_ref()
                    .map(|current| current.version)
                    .unwrap_or_default();
                warn!(
                    incoming_version = desired_state.version,
                    current_version, "ignoring stale desired state"
                );
                send_state_report(outbound, sources, current_desired_state.as_ref()).await?;
                return Ok(());
            }
            cache_desired_state(db, &desired_state)
                .await
                .context("failed to cache desired state")?;
            let failure_reports = apply_desired_state(cfg, vm, &message).await?;
            *current_desired_state = Some(desired_state);
            desired_state_tx.send_replace(current_desired_state.clone());
            for report in failure_reports {
                send_vm_report(outbound, &cfg.host_id, report).await?;
            }
            send_state_report(outbound, sources, current_desired_state.as_ref()).await?;
        }
        BridgeMessageV6::SyncRequest(_) => {
            send_state_report(outbound, sources, current_desired_state.as_ref()).await?;
        }
        BridgeMessageV6::ServerHello(_) => {
            anyhow::bail!("received duplicate server_hello after handshake");
        }
        BridgeMessageV6::ClientHello(_)
        | BridgeMessageV6::StateReport(_)
        | BridgeMessageV6::VmReport(_)
        | BridgeMessageV6::BuildReport(_) => {
            anyhow::bail!("server sent agent-originated bridge message");
        }
    }
    Ok(())
}

fn desired_state_is_stale(
    current: Option<&HostDesiredStateV2>,
    incoming: &HostDesiredStateV2,
) -> bool {
    current.is_some_and(|current| incoming.version < current.version)
}

async fn load_cached_desired_state(cfg: &BridgeConfig, db: &Db) -> Option<HostDesiredStateV2> {
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

    let desired_state = match serde_json::from_str::<HostDesiredStateV2>(&row.doc_json) {
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
    desired_state: HostDesiredStateV2,
) -> Result<()> {
    let version = desired_state.version;
    let failure_reports = apply_desired_state(
        cfg,
        vm,
        &DesiredStateV6 {
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

async fn cache_desired_state(db: &Db, desired_state: &HostDesiredStateV2) -> Result<()> {
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
    message: &DesiredStateV6,
) -> Result<Vec<VmReportV2>> {
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
    desired: &HostDesiredStateV2,
    desired_vm: &DesiredVmV2,
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
    let peer_vm_aliases = desired_peer_vm_aliases(desired, desired_vm);

    vm.create_scenario_vm(CreateScenarioVmRequest {
        name: desired_vm.vm_name.clone(),
        run_id: desired_vm.run_id.clone(),
        image: image_cache_key(&desired_vm.image_key),
        image_sha256: desired_vm.image_sha256.clone(),
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
            peer_vm_names: peer_vm_aliases.keys().cloned().collect(),
            peer_vm_aliases,
        },
    })
    .await
    .map(|_| ())
    .map_err(|error| anyhow::anyhow!("{}", error.message))
}

fn desired_peer_vm_aliases(
    desired: &HostDesiredStateV2,
    desired_vm: &DesiredVmV2,
) -> BTreeMap<String, String> {
    desired
        .vms
        .iter()
        .filter(|vm| vm.desired_phase == DesiredVmPhase::Running)
        .filter(|vm| vm.run_id == desired_vm.run_id && vm.vm_name != desired_vm.vm_name)
        .map(|vm| (vm.vm_name.clone(), vm.image_key.vm.clone()))
        .collect()
}

async fn delete_vm_if_present(vm: &VmManager, vm_name: &str) {
    match vm.delete_vm(vm_name).await {
        Ok(()) => {}
        Err(error) if error.status == axum::http::StatusCode::NOT_FOUND => {}
        Err(error) => warn!(vm = %vm_name, error = %error.message, "failed to delete vm"),
    }
}

async fn run_bridge_writer<W>(
    mut write: W,
    mut inventory: mpsc::Receiver<BridgeMessageV6>,
    mut normal: mpsc::Receiver<BridgeMessageV6>,
) -> Result<()>
where
    W: Sink<Message> + Unpin,
    W::Error: std::error::Error + Send + Sync + 'static,
{
    while let Some(message) = next_outbound_message(&mut inventory, &mut normal).await {
        timeout(
            Duration::from_millis(OUTBOUND_SEND_BUDGET_MS),
            send_bridge_message(&mut write, &message),
        )
        .await
        .context("bridge websocket send exceeded bounded writer budget")??;
    }
    Ok(())
}

async fn next_outbound_message(
    inventory: &mut mpsc::Receiver<BridgeMessageV6>,
    normal: &mut mpsc::Receiver<BridgeMessageV6>,
) -> Option<BridgeMessageV6> {
    tokio::select! {
        biased;
        message = inventory.recv() => message,
        message = normal.recv() => message,
    }
}

async fn run_inventory_reporter(
    sources: BridgeReportSources,
    mut inventory_updates: watch::Receiver<u64>,
    mut desired_state: watch::Receiver<Option<HostDesiredStateV2>>,
    outbound: mpsc::Sender<BridgeMessageV6>,
) -> Result<()> {
    loop {
        tokio::select! {
            update = inventory_updates.changed() => {
                update.context("VM inventory update channel closed")?;
            }
            update = desired_state.changed() => {
                update.context("desired-state report channel closed")?;
            }
        }
        let desired = desired_state.borrow().clone();
        send_inventory_state_report(&outbound, &sources, desired.as_ref()).await?;
    }
}

async fn enqueue_bridge_message(
    outbound: &mpsc::Sender<BridgeMessageV6>,
    message: BridgeMessageV6,
) -> Result<()> {
    outbound
        .send(message)
        .await
        .map_err(|_| anyhow::anyhow!("bridge writer channel closed"))
}

async fn send_state_report(
    outbound: &mpsc::Sender<BridgeMessageV6>,
    sources: &BridgeReportSources,
    desired: Option<&HostDesiredStateV2>,
) -> Result<()> {
    let report = build_host_state_report(
        &sources.cfg.host_id,
        &sources.vm,
        &sources.db,
        &sources.disk_probe_path,
        desired,
        true,
        &sources.cache,
    )
    .await;
    enqueue_bridge_message(
        outbound,
        BridgeMessageV6::StateReport(StateReportV6 {
            protocol_version: BRIDGE_PROTOCOL_VERSION,
            host_id: sources.cfg.host_id.clone(),
            report,
        }),
    )
    .await
}

async fn send_inventory_state_report(
    outbound: &mpsc::Sender<BridgeMessageV6>,
    sources: &BridgeReportSources,
    desired: Option<&HostDesiredStateV2>,
) -> Result<()> {
    // Lifecycle-triggered snapshots use the generation-fenced state already
    // committed by VmManager. Full process/cgroup inspection is deliberately
    // left to the periodic report so readiness publication never inherits an
    // InspectVm round trip.
    let report = build_host_state_report(
        &sources.cfg.host_id,
        &sources.vm,
        &sources.db,
        &sources.disk_probe_path,
        desired,
        false,
        &sources.cache,
    )
    .await;
    enqueue_bridge_message(
        outbound,
        BridgeMessageV6::StateReport(StateReportV6 {
            protocol_version: BRIDGE_PROTOCOL_VERSION,
            host_id: sources.cfg.host_id.clone(),
            report,
        }),
    )
    .await
}

async fn send_vm_report(
    outbound: &mpsc::Sender<BridgeMessageV6>,
    host_id: &str,
    report: VmReportV2,
) -> Result<()> {
    enqueue_bridge_message(
        outbound,
        BridgeMessageV6::VmReport(VmReportV6 {
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

async fn build_host_state_report(
    host_id: &str,
    vm: &VmManager,
    db: &Db,
    disk_probe_path: &Path,
    desired: Option<&HostDesiredStateV2>,
    inspect_runtime: bool,
    report_cache: &BridgeReportCache,
) -> HostStateReportV2 {
    let now = now_ms();
    let profile = if inspect_runtime {
        let profile = host_profile::collect(disk_probe_path);
        *report_cache.host_profile.write().await = profile.clone();
        profile
    } else {
        // statfs and route discovery are synchronous host probes. Reuse the
        // last periodic snapshot so they cannot consume inventory latency.
        report_cache.host_profile.read().await.clone()
    };
    let probe_rows = if inspect_runtime {
        match db.load_all_vm_probe_states().await {
            Ok(rows) => rows,
            Err(error) => {
                warn!(error = %error, "failed to load persisted probe state for bridge report");
                Vec::new()
            }
        }
    } else {
        // Probe transitions already have their own targeted VM report. Avoid
        // putting SQLite actor latency in the inventory freshness path.
        Vec::new()
    };
    let probes_by_vm = probe_snapshots_by_vm(probe_rows);
    let ssh_host = vm.ssh_advertised_host();
    let statuses = vm.list_vms().await;
    let profile_total_cpu_millis = u32::try_from(profile.cpu_cores)
        .unwrap_or(u32::MAX / 1_000)
        .saturating_mul(1_000);
    let local_committed_cpu_millis = statuses
        .iter()
        .filter_map(|status| status.details.as_ref()?.cpu_millis)
        .fold(0_u32, u32::saturating_add);
    let live_jailer = if inspect_runtime {
        vm.jailer_capabilities().await.ok()
    } else {
        match timeout(
            Duration::from_millis(INVENTORY_REPORT_JAILER_BUDGET_MS),
            vm.jailer_capabilities(),
        )
        .await
        {
            Ok(Ok(capabilities)) => Some(capabilities),
            Ok(Err(error)) => {
                warn!(error = %error, "failed to refresh jailer capacity for inventory report");
                None
            }
            Err(_) => {
                warn!(
                    budget_ms = INVENTORY_REPORT_JAILER_BUDGET_MS,
                    "timed out refreshing jailer capacity for inventory report"
                );
                None
            }
        }
    };
    if let Some(capabilities) = live_jailer.as_ref() {
        *report_cache.jailer_capabilities.write().await = Some(capabilities.clone());
    }
    // Feature and template-store attestations are immutable for a jailerd
    // process lifetime. A short capacity refresh timeout must not make a
    // performance-ready host flap, while mutable capacity below still fails
    // closed by using only the live response.
    let cached_jailer = report_cache.jailer_capabilities.read().await.clone();
    let attested_jailer = preserve_last_attestation(live_jailer.as_ref(), cached_jailer.as_ref());
    let (total_cpu_millis, reserved_cpu_millis, schedulable_cpu_millis, committed_cpu_millis) =
        live_jailer.as_ref().map_or_else(
            || {
                // Helper unavailability is fail-closed: advertise no
                // schedulable CPU even when the host profile is otherwise
                // healthy.
                (
                    profile_total_cpu_millis,
                    profile_total_cpu_millis,
                    0,
                    local_committed_cpu_millis,
                )
            },
            |capabilities| {
                (
                    saturating_u64_to_u32(capabilities.total_cpu_millis),
                    saturating_u64_to_u32(capabilities.reserved_cpu_millis),
                    saturating_u64_to_u32(capabilities.schedulable_cpu_millis),
                    saturating_u64_to_u32(capabilities.committed_cpu_millis),
                )
            },
        );
    let observations = join_all(statuses.iter().map(|status| async {
        let generation = status
            .details
            .as_ref()
            .and_then(|details| details.jail_generation.as_deref());
        let inspection = match (inspect_runtime, generation) {
            (true, Some(generation)) => match vm.inspect_jailed_vm(generation).await {
                Ok(inspection) => inspection,
                Err(error) => {
                    warn!(vm = status.name, generation, error = %error, "failed to inspect jailed VM for host report");
                    None
                }
            },
            (false, _) | (true, None) => None,
        };
        // Never recreate terminal readiness from a direct TCP probe. The event
        // cache is empty after restart until resumed Kino readiness and
        // FinalizeVmBoot publish a fresh generation-matched terminal event.
        let terminal = vm.committed_terminal_state(&status.name).await;
        (inspection, terminal)
    }))
    .await;
    let (reported_capabilities, reported_cached_images) = if inspect_runtime {
        let capabilities = collect_host_capabilities(attested_jailer.as_ref());
        let cached_images = desired
            .map(|state| {
                cached_image_states(
                    state,
                    now,
                    attested_jailer.as_ref().is_some_and(|capabilities| {
                        capabilities.supports_template_backed_launch
                            && capabilities.fast_template_store
                    }),
                )
            })
            .unwrap_or_default();
        *report_cache.host_capabilities.write().await = capabilities.clone();
        *report_cache.cached_images.write().await = cached_images.clone();
        (capabilities, cached_images)
    } else {
        (
            report_cache.host_capabilities.read().await.clone(),
            report_cache.cached_images.read().await.clone(),
        )
    };

    HostStateReportV2 {
        schema_version: HOST_STATE_REPORT_SCHEMA_VERSION,
        host_id: host_id.to_string(),
        observed_at_unix_ms: now,
        applied_desired_version: desired.map(|state| state.version).unwrap_or(0),
        capacity: HostCapacityV2 {
            total_cpu_millis,
            reserved_cpu_millis,
            schedulable_cpu_millis,
            committed_cpu_millis,
            memory_total_mib: mib_from_u64(profile.memory_total_mib.unwrap_or(0)),
            memory_available_mib: mib_from_u64(profile.memory_available_mib.unwrap_or(0)),
            disk_probe_path: profile.disk_probe_path,
            disk_total_mib: mib_from_u64(profile.disk_total_mib.unwrap_or(0)),
            disk_available_mib: mib_from_u64(profile.disk_available_mib.unwrap_or(0)),
            load_avg_1m: profile.load_avg1m,
            load_avg_5m: profile.load_avg5m,
            load_avg_15m: profile.load_avg15m,
            primary_ipv4: profile.primary_ipv4,
            primary_ipv6: profile.primary_ipv6,
        },
        capabilities: reported_capabilities,
        cached_images: reported_cached_images,
        vms: statuses
            .into_iter()
            .zip(observations)
            .map(|(status, (inspection, terminal))| {
                let run_id = local_run_id(&status).unwrap_or_default();
                let current_generation = status
                    .details
                    .as_ref()
                    .and_then(|details| details.jail_generation.as_deref());
                let probes = probes_by_vm
                    .get(&(run_id.clone(), status.name.clone()))
                    .filter(|(generation, _)| generation.as_deref() == current_generation)
                    .map(|(_, probes)| probes.clone())
                    .unwrap_or_default();
                actual_state_from_status(
                    host_id,
                    ssh_host.as_deref(),
                    desired,
                    status,
                    probes,
                    inspection.as_ref(),
                    terminal.as_ref(),
                )
            })
            .collect(),
        builds: Vec::new(),
    }
}

async fn build_vm_report_from_probe_update(
    host_id: &str,
    vm: &VmManager,
    desired: Option<&HostDesiredStateV2>,
    update: &ProbeUpdateEnvelope,
) -> Option<VmReportV2> {
    let status = vm.get_vm(&update.vm_name).await?;
    let current_generation = status
        .details
        .as_ref()
        .and_then(|details| details.jail_generation.as_deref());
    if Some(update.jail_generation.as_str()) != current_generation {
        warn!(
            vm = update.vm_name,
            run_id = update.run_id,
            update_generation = ?update.jail_generation,
            current_generation = ?current_generation,
            "dropping stale-generation Kino projection"
        );
        return None;
    }
    let terminal = vm.committed_terminal_state(&status.name).await;
    Some(build_vm_report_from_status(
        host_id,
        vm.ssh_advertised_host().as_deref(),
        desired,
        status,
        probe_snapshots_from_update(update),
        None,
        terminal.as_ref(),
    ))
}

fn build_vm_report_from_status(
    host_id: &str,
    ssh_host: Option<&str>,
    desired: Option<&HostDesiredStateV2>,
    status: VmStatusResponse,
    probes: Vec<VmProbeSnapshotV1>,
    inspection: Option<&VmInspection>,
    terminal: Option<&VmTerminalState>,
) -> VmReportV2 {
    let actual = actual_state_from_status(
        host_id, ssh_host, desired, status, probes, inspection, terminal,
    );
    VmReportV2 {
        schema_version: VM_REPORT_SCHEMA_VERSION,
        host_id: host_id.to_string(),
        run_id: actual.run_id,
        vm_name: actual.vm_name,
        desired_version: actual.desired_version,
        observed_at_unix_ms: actual.updated_at_unix_ms,
        phase: actual.phase,
        network: actual.network,
        terminal: actual.terminal,
        runtime_constraints: actual.runtime_constraints,
        boot_evidence: actual.boot_evidence,
        resource_state: actual.resource_state,
        sandbox: actual.sandbox,
        ssh_host_keys_openssh: actual.ssh_host_keys_openssh,
        probes: actual.probes,
        archive: actual.archive,
        error: actual.error,
    }
}

fn actual_state_from_status(
    _host_id: &str,
    ssh_host: Option<&str>,
    desired: Option<&HostDesiredStateV2>,
    status: VmStatusResponse,
    probes: Vec<VmProbeSnapshotV1>,
    inspection: Option<&VmInspection>,
    terminal: Option<&VmTerminalState>,
) -> VmActualStateV2 {
    let run_id = local_run_id(&status).unwrap_or_default();
    let desired_vm = desired.and_then(|state| {
        state
            .vms
            .iter()
            .find(|vm| vm.run_id == run_id && vm.vm_name == status.name)
    });

    let status_updated_at = parse_rfc3339_ms(&status.updated_at).unwrap_or_else(now_ms);
    let terminal_state = terminal.map_or_else(
        || terminal_state_from_status_fallback(&status, status_updated_at),
        terminal_state_from_manager,
    );
    let runtime_constraints = terminal
        .and_then(|state| state.runtime_constraints.clone())
        .or_else(|| runtime_constraints_from_status(&status));
    let boot_evidence = boot_evidence_from_status(&status);
    let updated_at_unix_ms = terminal.map_or(status_updated_at, |state| {
        state.observed_at.max(status_updated_at)
    });

    VmActualStateV2 {
        run_id,
        vm_name: status.name.clone(),
        desired_version: desired_vm.and_then(|_| desired.map(|state| state.version)),
        phase: vm_phase_from_status(&status, &probes),
        image_key: desired_vm.map(|vm| vm.image_key.clone()),
        image_sha256: desired_vm.map(|vm| vm.image_sha256.clone()),
        network: network_state_from_status(&status, ssh_host),
        terminal: terminal_state,
        runtime_constraints,
        boot_evidence,
        resource_state: resource_state_from_status(&status, inspection),
        sandbox: sandbox_state_from_status(&status, inspection),
        ssh_host_keys_openssh: status
            .details
            .as_ref()
            .map(|details| details.ssh_host_keys_openssh.clone())
            .unwrap_or_default(),
        probes,
        archive: archive_state_from_status(&status),
        error: status.error.clone(),
        updated_at_unix_ms,
    }
}

fn failed_vm_report(
    host_id: &str,
    desired: &HostDesiredStateV2,
    vm: &DesiredVmV2,
    observed_at_unix_ms: i64,
    error: String,
) -> VmReportV2 {
    VmReportV2 {
        schema_version: VM_REPORT_SCHEMA_VERSION,
        host_id: host_id.to_string(),
        run_id: vm.run_id.clone(),
        vm_name: vm.vm_name.clone(),
        desired_version: Some(desired.version),
        observed_at_unix_ms,
        phase: VmPhase::Failed,
        network: None,
        terminal: VmTerminalStateV1 {
            state: VmTerminalStateKindV1::Failed,
            target: None,
            reason: Some(error.clone()),
            observed_at_unix_ms,
        },
        runtime_constraints: None,
        boot_evidence: None,
        resource_state: None,
        sandbox: None,
        ssh_host_keys_openssh: Vec::new(),
        probes: Vec::new(),
        archive: None,
        error: Some(error),
    }
}

fn terminal_state_from_status_fallback(
    status: &VmStatusResponse,
    observed_at_unix_ms: i64,
) -> VmTerminalStateV1 {
    let (state, reason) = match status.state {
        VmLifecycleState::Failed | VmLifecycleState::DeleteFailed => (
            VmTerminalStateKindV1::Failed,
            Some(
                status
                    .error
                    .clone()
                    .unwrap_or_else(|| "vm failed".to_string()),
            ),
        ),
        VmLifecycleState::DeletingVm | VmLifecycleState::ArchivingArtifacts => (
            VmTerminalStateKindV1::Pending,
            Some("destroying".to_string()),
        ),
        _ => (
            VmTerminalStateKindV1::Pending,
            Some("terminal readiness pending".to_string()),
        ),
    };
    VmTerminalStateV1 {
        state,
        target: None,
        reason,
        observed_at_unix_ms,
    }
}

fn boot_evidence_from_status(status: &VmStatusResponse) -> Option<VmBootEvidenceV1> {
    let details = status.details.as_ref()?;
    let generation = details.jail_generation.as_deref()?;
    details
        .boot_evidence
        .as_ref()
        .filter(|evidence| evidence.generation == generation)
        .cloned()
}

fn runtime_constraints_from_status(status: &VmStatusResponse) -> Option<VmRuntimeConstraintsV1> {
    let details = status.details.as_ref()?;
    let generation = details.jail_generation.clone()?;
    let runtime = details.cpu_runtime.as_ref()?;
    Some(VmRuntimeConstraintsV1 {
        generation,
        phase: match runtime.phase {
            VmCpuPhase::BootBurst => VmRuntimeConstraintPhaseV1::BootBurst,
            VmCpuPhase::Steady => VmRuntimeConstraintPhaseV1::Steady,
        },
        steady_cpu_millis: runtime.steady_quota.cpu_millis,
        effective_cpu_millis: runtime.effective_quota.cpu_millis,
        quota_verified_at_unix_ms: runtime
            .attestation
            .as_ref()
            .and_then(|attestation| i64::try_from(attestation.verified_at_unix_ms).ok()),
        lease_expires_at_unix_ms: runtime
            .boot_deadline_unix_ms
            .and_then(|deadline| i64::try_from(deadline).ok()),
    })
}

fn terminal_state_from_manager(state: &VmTerminalState) -> VmTerminalStateV1 {
    let target = state.terminal_target.as_ref().and_then(|target| {
        let host = target
            .host
            .as_deref()
            .map(str::trim)
            .filter(|host| !host.is_empty())?;
        (state.state == VmTerminalStateKind::Ready).then(|| VmTerminalTargetV1 {
            host: host.to_string(),
            port: target.port,
            username: target.username.clone(),
            checked_at_unix_ms: target.checked_at,
        })
    });
    let (kind, reason) = match state.state {
        VmTerminalStateKind::Ready if target.is_some() => (VmTerminalStateKindV1::Ready, None),
        VmTerminalStateKind::Ready => (
            VmTerminalStateKindV1::Pending,
            Some("advertised ssh host unavailable".to_string()),
        ),
        VmTerminalStateKind::Pending => (VmTerminalStateKindV1::Pending, state.reason.clone()),
        VmTerminalStateKind::Failed => (VmTerminalStateKindV1::Failed, state.reason.clone()),
    };
    VmTerminalStateV1 {
        state: kind,
        target,
        reason,
        observed_at_unix_ms: state.observed_at,
    }
}

fn vm_phase_from_status(status: &VmStatusResponse, probes: &[VmProbeSnapshotV1]) -> VmPhase {
    match status.state {
        VmLifecycleState::Queued => VmPhase::Pending,
        VmLifecycleState::CachingImage => VmPhase::PullingImage,
        VmLifecycleState::PreparingDisks => VmPhase::CreatingDisks,
        VmLifecycleState::CreatingVm => {
            creating_vm_report_phase(runtime_constraints_from_status(status).is_some())
        }
        VmLifecycleState::BootingVm => VmPhase::Booting,
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

fn creating_vm_report_phase(has_runtime_constraints: bool) -> VmPhase {
    if has_runtime_constraints {
        VmPhase::Booting
    } else {
        // The external Booting phase requires a generation and live CPU
        // contract. Keep the pre-jailer launch window in disk/staging state;
        // persist_jail_launch emits another inventory revision as soon as the
        // boot quota is available.
        VmPhase::CreatingDisks
    }
}

fn network_state_from_status(
    status: &VmStatusResponse,
    ssh_host: Option<&str>,
) -> Option<VmNetworkStateV1> {
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
        ssh_host: ssh_host
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
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
    generation: Option<&str>,
) -> Vec<VmProbeSnapshotV1> {
    match db.load_vm_probe_state(vm_name.to_string()).await {
        Ok(Some(row))
            if row.run_id == run_id
                && probe_generation_from_state_row(&row).as_deref() == generation =>
        {
            probe_snapshots_from_state_row(&row)
        }
        Ok(_) => Vec::new(),
        Err(error) => {
            warn!(error = %error, run_id, vm = vm_name, "failed to load vm probe state");
            Vec::new()
        }
    }
}

fn probe_snapshots_by_vm(
    rows: Vec<VmProbeStateRow>,
) -> BTreeMap<(String, String), (Option<String>, Vec<VmProbeSnapshotV1>)> {
    rows.into_iter()
        .map(|row| {
            (
                (row.run_id.clone(), row.vm_name.clone()),
                (
                    probe_generation_from_state_row(&row),
                    probe_snapshots_from_state_row(&row),
                ),
            )
        })
        .collect()
}

fn probe_generation_from_state_row(row: &VmProbeStateRow) -> Option<String> {
    serde_json::from_str::<ProbeUpdateEnvelope>(&row.snapshot_json)
        .ok()
        .map(|update| update.jail_generation)
}

fn probe_snapshots_from_state_row(row: &VmProbeStateRow) -> Vec<VmProbeSnapshotV1> {
    serde_json::from_str::<ProbeUpdateEnvelope>(&row.snapshot_json)
        .map(|update| probe_snapshots_from_update(&update))
        .unwrap_or_default()
}

fn probe_snapshots_from_update(update: &ProbeUpdateEnvelope) -> Vec<VmProbeSnapshotV1> {
    probe_snapshots_from_probes(update.generated_at_ms, &update.probes)
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

fn cached_image_states(
    desired: &HostDesiredStateV2,
    now: i64,
    require_template: bool,
) -> Vec<CachedImageStateV1> {
    let cache_root = crate::image_cache::default_cache_root().ok();
    cached_image_states_with_cache_root(desired, now, cache_root.as_deref(), require_template)
}

fn cached_image_states_with_cache_root(
    desired: &HostDesiredStateV2,
    now: i64,
    cache_root: Option<&Path>,
    require_template: bool,
) -> Vec<CachedImageStateV1> {
    desired
        .cached_images
        .iter()
        .map(|desired_image| {
            let key = image_cache_key(&desired_image.image_key);
            let metadata = cache_root.and_then(|root| {
                crate::image_cache::verified_cached_image_metadata(
                    root,
                    &key,
                    &desired_image.image_sha256,
                    require_template,
                )
            });
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

fn collect_host_capabilities(jailer: Option<&JailerCapabilities>) -> HostCapabilitiesV2 {
    let supports_cgroup_v2 = fs::read_to_string("/sys/fs/cgroup/cgroup.controllers")
        .is_ok_and(|value| value.split_whitespace().any(|item| item == "cpu"));
    let supports_jailer_v1 = jailer.is_some_and(|capabilities| capabilities.supports_jailer_v1);
    let supports_jailer_v2 = jailer.is_some_and(|capabilities| capabilities.supports_jailer_v2);
    HostCapabilitiesV2 {
        arch: host_architecture(),
        cloud_hypervisor_sha256: jailer
            .map(|capabilities| capabilities.cloud_hypervisor_sha256.clone()),
        boot_cpu_millis: jailer.map(|capabilities| capabilities.boot_cpu_millis),
        boot_cpu_lease_ms: jailer.map(|capabilities| capabilities.boot_cpu_lease_ms),
        // The service deliberately runs with PrivateDevices=true. A successful
        // jailerd readiness attestation, not agent-visible device access, is
        // the authority for KVM availability and complete helper accounting.
        supports_kvm: supports_jailer_v2,
        supports_vsock: true,
        supports_reflink: supports_reflink_for_image_cache(),
        supports_nftables: command_exists("nft"),
        supports_jailer_v1,
        supports_jailer_v2,
        supports_boot_cpu_lease: jailer
            .is_some_and(|capabilities| capabilities.supports_boot_cpu_lease),
        supports_template_backed_launch: jailer
            .is_some_and(|capabilities| capabilities.supports_template_backed_launch),
        fast_template_store: jailer.is_some_and(|capabilities| capabilities.fast_template_store),
        supports_hard_cpu_quota: jailer
            .is_some_and(|capabilities| capabilities.supports_hard_cpu_quota),
        supports_landlock: jailer.is_some_and(|capabilities| capabilities.supports_landlock),
        supports_cgroup_v2: jailer.map_or(supports_cgroup_v2, |capabilities| {
            capabilities.supports_cgroup_v2
        }),
    }
}

fn resource_state_from_status(
    status: &VmStatusResponse,
    inspection: Option<&VmInspection>,
) -> Option<VmResourceStateV2> {
    let details = status.details.as_ref()?;
    let inspection = inspection?;
    if details.jail_generation.as_deref() != Some(inspection.generation.as_str()) {
        return None;
    }
    let cpu_stat = inspection.cpu_stat.as_ref();
    Some(VmResourceStateV2 {
        cpu_millis: inspection.cpu_quota.cpu_millis,
        vcpu_count: inspection.vcpu_count,
        cpu_quota_us: inspection.cpu_quota.quota_micros,
        cpu_period_us: inspection.cpu_quota.period_micros,
        cpu_usage_usec: cpu_stat.map_or(0, |stat| stat.usage_usec),
        cpu_user_usec: cpu_stat.map_or(0, |stat| stat.user_usec),
        cpu_system_usec: cpu_stat.map_or(0, |stat| stat.system_usec),
        cpu_nr_periods: cpu_stat.map_or(0, |stat| stat.nr_periods),
        cpu_nr_throttled: cpu_stat.map_or(0, |stat| stat.nr_throttled),
        cpu_throttled_usec: cpu_stat.map_or(0, |stat| stat.throttled_usec),
    })
}

fn sandbox_state_from_status(
    status: &VmStatusResponse,
    inspection: Option<&VmInspection>,
) -> Option<VmSandboxStateV1> {
    let details = status.details.as_ref()?;
    let inspection_matches = inspection.is_some_and(|inspection| {
        details.jail_generation.as_deref() == Some(inspection.generation.as_str())
            && details.jail_unit_name.as_deref() == Some(inspection.unit_name.as_str())
            && details.jail_cgroup_path.as_deref()
                == inspection.cgroup_path.as_deref().and_then(Path::to_str)
    });
    Some(VmSandboxStateV1 {
        healthy: inspection_matches
            && inspection.is_some_and(|inspection| {
                inspection.health == SandboxHealth::Healthy
                    && inspection.seccomp_enabled
                    && inspection.landlock_enabled
                    && inspection.no_new_privs
                    && inspection.capabilities_empty
            }),
        generation: details.jail_generation.clone()?,
        systemd_unit: details.jail_unit_name.clone()?,
        cgroup_path: details.jail_cgroup_path.clone()?,
        seccomp_enabled: inspection_matches
            && inspection.is_some_and(|inspection| inspection.seccomp_enabled),
        landlock_enabled: inspection_matches
            && inspection.is_some_and(|inspection| inspection.landlock_enabled),
        no_new_privs: inspection_matches
            && inspection.is_some_and(|inspection| inspection.no_new_privs),
    })
}

#[cfg(all(test, unix))]
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

#[cfg(all(test, not(unix)))]
fn can_open_char_device(_path: &Path) -> bool {
    false
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
        // coreutils >= 9.2 rejects --reflink=always combined with
        // --sparse=always; reflink clones share extents, so sparseness is
        // preserved without an explicit sparse mode.
        .arg("--reflink=always")
        .arg("--sparse=auto")
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

async fn send_bridge_message<W>(write: &mut W, message: &BridgeMessageV6) -> Result<()>
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

fn parse_bridge_message(message: Message) -> Result<Option<BridgeMessageV6>> {
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
    if !desired.builds.is_empty() {
        anyhow::bail!(
            "agent desired state must not contain build assignments; received {}",
            desired.builds.len()
        );
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

fn local_run_id(status: &VmStatusResponse) -> Option<String> {
    status
        .details
        .as_ref()
        .and_then(|details| details.run_id.as_deref())
        .map(str::trim)
        .filter(|run_id| !run_id.is_empty())
        .map(ToOwned::to_owned)
}

fn preserve_last_attestation<T: Clone>(live: Option<&T>, cached: Option<&T>) -> Option<T> {
    live.or(cached).cloned()
}

fn terminal_update_matches_status(update: &VmTerminalState, status: &VmStatusResponse) -> bool {
    let update_generation = update
        .runtime_constraints
        .as_ref()
        .map(|constraints| constraints.generation.as_str());
    let current_generation = status
        .details
        .as_ref()
        .and_then(|details| details.jail_generation.as_deref());
    terminal_identities_match(
        &update.run_id,
        update_generation,
        &update.state,
        local_run_id(status).as_deref(),
        current_generation,
    )
}

fn terminal_identities_match(
    update_run_id: &str,
    update_generation: Option<&str>,
    update_state: &VmTerminalStateKind,
    current_run_id: Option<&str>,
    current_generation: Option<&str>,
) -> bool {
    if current_run_id != Some(update_run_id) {
        return false;
    }
    match (update_generation, current_generation) {
        (Some(update), Some(current)) => update == current,
        // A pre-launch failure or deletion can legitimately have no jail
        // generation. Ready is never accepted without an explicit fence.
        (None, None) => *update_state != VmTerminalStateKind::Ready,
        _ => false,
    }
}

fn resources_from_desired(resources: &VmResourcesV2) -> CreateVmResources {
    CreateVmResources {
        cpu_millis: resources.cpu_millis,
        vcpus: u32::from(resources.vcpu_count),
        memory_mib: resources.memory_mib.0,
        disk_mib: Some(resources.disk_mib.0),
    }
}

fn desired_lease_duration_seconds(vm: &DesiredVmV2, now_ms: i64) -> Result<u64> {
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

fn kino_vsock_cid(desired_version: u64, vm: &DesiredVmV2) -> u32 {
    let mut hash = desired_version;
    for byte in vm.run_id.bytes().chain(vm.vm_name.bytes()) {
        hash = hash.wrapping_mul(16_777_619) ^ u64::from(byte);
    }
    10_000 + u32::try_from(hash % 50_000).unwrap_or(0)
}

fn mib_from_u64(value: u64) -> Mib {
    Mib(u32::try_from(value).unwrap_or(u32::MAX))
}

fn saturating_u64_to_u32(value: u64) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
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
    use intar_contracts::bridge::DesiredCachedImageV1;

    use crate::vm::VmTerminalTarget;

    use super::*;

    fn desired_vm() -> DesiredVmV2 {
        DesiredVmV2 {
            run_id: "run-1".to_string(),
            vm_name: "web".to_string(),
            desired_phase: DesiredVmPhase::Running,
            image_key: ImageKey {
                scenario: "broken-nginx".to_string(),
                vm: "web".to_string(),
                arch: ImageArchitecture::X86_64,
            },
            image_sha256: "a".repeat(64),
            resources: VmResourcesV2 {
                cpu_millis: 125,
                vcpu_count: 1,
                memory_mib: Mib(512),
                disk_mib: Mib(4096),
            },
            ssh_authorized_keys_openssh: vec!["ssh-ed25519 AAAATEST run".to_string()],
            lease_expires_at_unix_ms: now_ms() + 60_000,
        }
    }

    fn empty_desired_state(version: u64) -> HostDesiredStateV2 {
        HostDesiredStateV2 {
            schema_version: HOST_DESIRED_STATE_SCHEMA_VERSION,
            host_id: "host-1".to_string(),
            version,
            generated_at_unix_ms: 123,
            cached_images: Vec::new(),
            vms: Vec::new(),
            builds: Vec::new(),
        }
    }

    #[test]
    fn char_device_probe_rejects_missing_and_regular_files() {
        let regular = tempfile::NamedTempFile::new().expect("tempfile");

        assert!(!can_open_char_device(Path::new(
            "/tmp/intar-agent-missing-char-device"
        )));
        assert!(!can_open_char_device(regular.path()));
    }

    #[cfg(unix)]
    #[test]
    fn char_device_probe_accepts_openable_char_devices() {
        assert!(can_open_char_device(Path::new("/dev/null")));
    }

    #[test]
    fn parses_only_v6_bridge_messages() {
        let message = BridgeMessageV6::SyncRequest(SyncRequestV6 {
            protocol_version: BRIDGE_PROTOCOL_VERSION,
            host_id: "host-1".to_string(),
            reason: SyncRequestReason::Connect,
        });
        let raw = serde_json::to_string(&message).expect("serialize");

        assert!(parse_bridge_json(&raw).is_ok());

        let raw_v5 = raw.replace("\"protocol_version\":6", "\"protocol_version\":5");
        let error = parse_bridge_json(&raw_v5).expect_err("v5 should fail");
        assert!(error.to_string().contains("expected v6"));
    }

    #[tokio::test]
    async fn outbound_writer_prioritizes_inventory_reports() {
        let (inventory_tx, mut inventory_rx) = mpsc::channel(1);
        let (normal_tx, mut normal_rx) = mpsc::channel(1);
        normal_tx
            .send(BridgeMessageV6::SyncRequest(SyncRequestV6 {
                protocol_version: BRIDGE_PROTOCOL_VERSION,
                host_id: "normal".to_string(),
                reason: SyncRequestReason::Connect,
            }))
            .await
            .expect("queue normal message");
        inventory_tx
            .send(BridgeMessageV6::SyncRequest(SyncRequestV6 {
                protocol_version: BRIDGE_PROTOCOL_VERSION,
                host_id: "inventory".to_string(),
                reason: SyncRequestReason::Reconnect,
            }))
            .await
            .expect("queue inventory message");

        let next = timeout(
            Duration::from_millis(INVENTORY_DELIVERY_TARGET_MS),
            next_outbound_message(&mut inventory_rx, &mut normal_rx),
        )
        .await
        .expect("priority dequeue stays inside inventory budget")
        .expect("queued message");

        assert_eq!(bridge_message_host_id(&next), "inventory");
    }

    #[test]
    fn bounded_inventory_path_fits_delivery_target() {
        let worst_case_ms = INVENTORY_REPORT_JAILER_BUDGET_MS
            .saturating_add(OUTBOUND_SEND_BUDGET_MS)
            .saturating_add(OUTBOUND_SEND_BUDGET_MS);
        assert!(worst_case_ms < INVENTORY_DELIVERY_TARGET_MS);
    }

    #[test]
    fn terminal_updates_are_run_and_generation_fenced() {
        assert!(terminal_identities_match(
            "run-1",
            Some("generation-2"),
            &VmTerminalStateKind::Ready,
            Some("run-1"),
            Some("generation-2"),
        ));
        assert!(!terminal_identities_match(
            "run-1",
            Some("generation-1"),
            &VmTerminalStateKind::Ready,
            Some("run-1"),
            Some("generation-2"),
        ));
        assert!(!terminal_identities_match(
            "run-old",
            Some("generation-2"),
            &VmTerminalStateKind::Ready,
            Some("run-new"),
            Some("generation-2"),
        ));
        assert!(!terminal_identities_match(
            "run-1",
            None,
            &VmTerminalStateKind::Ready,
            Some("run-1"),
            None,
        ));
        assert!(terminal_identities_match(
            "run-1",
            None,
            &VmTerminalStateKind::Failed,
            Some("run-1"),
            None,
        ));
    }

    #[test]
    fn immutable_attestation_survives_transient_live_refresh_failure() {
        assert_eq!(preserve_last_attestation(None, Some(&42_u8)), Some(42));
        assert_eq!(
            preserve_last_attestation(Some(&7_u8), Some(&42_u8)),
            Some(7)
        );
        assert_eq!(preserve_last_attestation::<u8>(None, None), None);
    }

    #[test]
    fn explicit_terminal_contract_exposes_targets_only_when_ready() {
        let ready = terminal_state_from_manager(&VmTerminalState {
            run_id: "run-1".to_string(),
            vm_name: "web".to_string(),
            state: VmTerminalStateKind::Ready,
            terminal_target: Some(VmTerminalTarget {
                host: Some("203.0.113.7".to_string()),
                port: 22_001,
                username: "ubuntu".to_string(),
                checked_at: 2_000,
            }),
            reason: None,
            observed_at: 2_000,
            runtime_constraints: None,
        });
        assert_eq!(ready.state, VmTerminalStateKindV1::Ready);
        assert_eq!(
            ready.target.as_ref().map(|target| target.port),
            Some(22_001)
        );

        let pending = terminal_state_from_manager(&VmTerminalState {
            run_id: "run-1".to_string(),
            vm_name: "web".to_string(),
            state: VmTerminalStateKind::Pending,
            terminal_target: Some(VmTerminalTarget {
                host: Some("203.0.113.7".to_string()),
                port: 22_001,
                username: "ubuntu".to_string(),
                checked_at: 2_000,
            }),
            reason: Some("sealing CPU quota".to_string()),
            observed_at: 2_000,
            runtime_constraints: None,
        });
        assert_eq!(pending.state, VmTerminalStateKindV1::Pending);
        assert_eq!(pending.target, None);
    }

    #[test]
    fn agent_desired_state_rejects_build_assignments() {
        let mut desired = empty_desired_state(1);
        validate_desired_state("host-1", &desired).expect("empty builds should be valid");

        desired
            .builds
            .push(intar_contracts::bridge::DesiredBuildV1 {
                build_id: "build-1".to_string(),
                scenario_id: "broken-nginx".to_string(),
                arch: ImageArchitecture::X86_64,
                rev: "abc123".to_string(),
                content_hash: "f".repeat(64),
                bundle_ref: "builds/bundles/abc123.tar.gz".to_string(),
                kino_version: "0.1.24".to_string(),
            });
        let error = validate_desired_state("host-1", &desired)
            .expect_err("agents must reject builder assignments");
        assert!(format!("{error:#}").contains("must not contain build assignments"));
    }

    #[test]
    fn desired_state_versions_never_regress() {
        let current = empty_desired_state(7);

        assert!(desired_state_is_stale(
            Some(&current),
            &empty_desired_state(6)
        ));
        assert!(!desired_state_is_stale(
            Some(&current),
            &empty_desired_state(7)
        ));
        assert!(!desired_state_is_stale(
            Some(&current),
            &empty_desired_state(8)
        ));
        assert!(!desired_state_is_stale(None, &empty_desired_state(1)));
    }

    #[test]
    fn image_cache_key_matches_committed_catalog_format() {
        assert_eq!(
            image_cache_key(&desired_vm().image_key),
            "broken-nginx-web-x86_64"
        );
    }

    #[test]
    fn creating_vm_is_booting_only_after_runtime_constraints_exist() {
        assert_eq!(creating_vm_report_phase(false), VmPhase::CreatingDisks);
        assert_eq!(creating_vm_report_phase(true), VmPhase::Booting);
    }

    #[test]
    fn desired_peer_aliases_map_runtime_names_to_manifest_vm_names() {
        let mut web = desired_vm();
        web.run_id = "run-pair".to_string();
        web.vm_name = "pair-ping-web-bv1xgh-1".to_string();
        web.image_key.scenario = "pair-ping".to_string();
        web.image_key.vm = "web".to_string();

        let mut db = web.clone();
        db.vm_name = "pair-ping-db-bv1xgh-2".to_string();
        db.image_key.vm = "db".to_string();

        let mut absent = web.clone();
        absent.vm_name = "pair-ping-cache-bv1xgh-3".to_string();
        absent.image_key.vm = "cache".to_string();
        absent.desired_phase = DesiredVmPhase::Absent;

        let mut other_run = web.clone();
        other_run.run_id = "other-run".to_string();
        other_run.vm_name = "pair-ping-other-abcdef-1".to_string();
        other_run.image_key.vm = "other".to_string();

        let desired = HostDesiredStateV2 {
            schema_version: HOST_DESIRED_STATE_SCHEMA_VERSION,
            host_id: "host-1".to_string(),
            version: 1,
            generated_at_unix_ms: 123,
            cached_images: Vec::new(),
            vms: vec![web.clone(), db.clone(), absent, other_run],
            builds: Vec::new(),
        };

        assert_eq!(
            desired_peer_vm_aliases(&desired, &web),
            BTreeMap::from([(db.vm_name, "db".to_string())])
        );
    }

    #[tokio::test]
    async fn cached_image_state_requires_verified_launch_descriptor() {
        let temp = tempfile::tempdir().expect("tempdir");
        let vm = desired_vm();
        let image_sha256 = vm.image_sha256.clone();
        let cache_key = image_cache_key(&vm.image_key);
        let image_dir = temp.path().join(&cache_key);
        std::fs::create_dir_all(&image_dir).expect("image cache dir");
        let raw_path = image_dir.join(format!("{image_sha256}.raw"));
        std::fs::write(&raw_path, b"raw").expect("raw cache file");
        let desired = HostDesiredStateV2 {
            schema_version: HOST_DESIRED_STATE_SCHEMA_VERSION,
            host_id: "host-1".to_string(),
            version: 1,
            generated_at_unix_ms: 123,
            cached_images: vec![DesiredCachedImageV1 {
                image_key: vm.image_key.clone(),
                image_sha256: image_sha256.clone(),
            }],
            vms: Vec::new(),
            builds: Vec::new(),
        };

        let unverified =
            cached_image_states_with_cache_root(&desired, 456, Some(temp.path()), false);
        assert_eq!(unverified[0].phase, ImageCachePhase::Missing);
        assert_eq!(unverified[0].bytes_on_disk, None);

        std::fs::write(
            image_dir.join(format!("{image_sha256}.raw.verified.json")),
            format!(
                r#"{{"schema_version":3,"image_key":"{cache_key}","image_sha256":"{image_sha256}","image_virtual_size_bytes":3,"raw_sha256":"{}","kernel_sha256":"{}","initrd_sha256":"{}","cmdline":"root=/dev/vda rw"}}"#,
                "a".repeat(64),
                "b".repeat(64),
                "c".repeat(64),
            ),
        )
        .expect("raw cache marker");

        let verified = cached_image_states_with_cache_root(&desired, 789, Some(temp.path()), false);
        assert_eq!(verified[0].phase, ImageCachePhase::Ready);
        assert_eq!(verified[0].bytes_on_disk, Some(3));

        let template_missing =
            cached_image_states_with_cache_root(&desired, 790, Some(temp.path()), true);
        assert_eq!(template_missing[0].phase, ImageCachePhase::Missing);
        let artifacts = temp.path().join("artifacts");
        std::fs::create_dir_all(&artifacts).expect("boot artifact cache");
        let kernel_sha256 = "b".repeat(64);
        let initrd_sha256 = "c".repeat(64);
        let raw_sha256 = "a".repeat(64);
        let kernel_path = artifacts.join(&kernel_sha256);
        let initrd_path = artifacts.join(&initrd_sha256);
        std::fs::write(&kernel_path, b"kernel").expect("cached kernel artifact");
        std::fs::write(&initrd_path, b"initrd").expect("cached initrd artifact");
        let prepared_source =
            |name: &str, sha256: &str, access: intar_jailer_protocol::ArtifactAccess| {
                intar_jailer_protocol::ArtifactSource {
                    source_root: intar_jailer_protocol::PREPARED_IMAGE_SOURCE_ROOT,
                    relative_path: PathBuf::from(&image_sha256).join(name),
                    sha256: Some(
                        intar_jailer_protocol::Sha256Digest::parse(sha256.to_string())
                            .expect("prepared digest"),
                    ),
                    access,
                }
            };
        let cached = crate::image_cache::CachedImage {
            image_key: cache_key,
            image_sha256: image_sha256.clone(),
            raw_path,
            raw_sha256: raw_sha256.clone(),
            kernel_path,
            initrd_path,
            kernel_sha256: kernel_sha256.clone(),
            initrd_sha256: initrd_sha256.clone(),
            cmdline: "root=/dev/vda rw".to_string(),
            virtual_size_bytes: 3,
        };
        let prepared = intar_jailer_protocol::PreparedImageV2Result {
            image_sha256: intar_jailer_protocol::Sha256Digest::parse(image_sha256.clone())
                .expect("image digest"),
            virtual_size_bytes: 3,
            root_disk: prepared_source(
                "root.raw",
                &raw_sha256,
                intar_jailer_protocol::ArtifactAccess::ReadWrite,
            ),
            kernel: prepared_source(
                "kernel",
                &kernel_sha256,
                intar_jailer_protocol::ArtifactAccess::ReadOnly,
            ),
            initrd: Some(prepared_source(
                "initrd",
                &initrd_sha256,
                intar_jailer_protocol::ArtifactAccess::ReadOnly,
            )),
            fast_template_store: true,
        };
        crate::image_cache::mark_template_ready(&cached, &prepared)
            .await
            .expect("publish launch descriptor");
        let template_ready =
            cached_image_states_with_cache_root(&desired, 791, Some(temp.path()), true);
        assert_eq!(template_ready[0].phase, ImageCachePhase::Ready);
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
