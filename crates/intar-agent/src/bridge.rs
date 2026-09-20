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
    BRIDGE_PROTOCOL_VERSION, BridgeMessageV8, CachedGuestToolsStateV1, CachedImageStateV1,
    ClientHelloV8, DesiredStateV8, DesiredVmPhase, DesiredVmV2, HOST_DESIRED_STATE_SCHEMA_VERSION,
    HOST_STATE_REPORT_SCHEMA_VERSION, HostCapabilitiesV2, HostCapacityV2, HostDesiredStateV2,
    HostRoleV1, HostStateReportV2, ImageCachePhase, StateReportV8, SyncRequestReason,
    SyncRequestV8, VM_REPORT_SCHEMA_VERSION, VmActualStateV2, VmArchivePhase, VmArchiveStateV1,
    VmGuestToolsStateV1, VmNetworkStateV1, VmPhase, VmProbeSnapshotV1, VmProbeStatus, VmReportV2,
    VmReportV8, VmResourceStateV3, VmResourcesV3, VmRuntimeConstraintsV2, VmSandboxStateV1,
    VmTerminalStateKindV1, VmTerminalStateV1, VmTerminalTargetV1,
};
use intar_contracts::catalog::{ImageArchitecture, ImageKey, Mib, ProbePhase};
use intar_jailer_protocol::{JailerCapabilities, SandboxHealth, VmInspection};
use reqwest::Client as HttpClient;
use serde::{Deserialize, Serialize};
use tokio::sync::{RwLock, mpsc, watch};
use tokio::time::{MissedTickBehavior, interval, sleep, timeout};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::Message;
use tracing::{debug, info, warn};

use crate::config::{BridgeConfig, normalize_sha256};
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
const RUN_CLI_ACCESS_REFRESH_INTERVAL_SECS: u64 = 60;
const RUN_CLI_ACCESS_REFRESH_TIMEOUT_SECS: u64 = 5;
const INVENTORY_REPORT_JAILER_BUDGET_MS: u64 = 50;
const OUTBOUND_SEND_BUDGET_MS: u64 = 25;
#[cfg(test)]
const INVENTORY_DELIVERY_TARGET_MS: u64 = 250;
const URGENT_OUTBOUND_CAPACITY: usize = 8;
const INVENTORY_OUTBOUND_CAPACITY: usize = 1;
const NORMAL_OUTBOUND_CAPACITY: usize = 64;
const DEFAULT_KINO_VSOCK_PORT: u32 = 18_080;

#[derive(Clone)]
struct BridgeReportCache {
    host_profile: Arc<RwLock<host_profile::HostProfile>>,
    jailer_capabilities: Arc<RwLock<Option<JailerCapabilities>>>,
    host_capabilities: Arc<RwLock<HostCapabilitiesV2>>,
    cached_images: Arc<RwLock<Vec<CachedImageStateV1>>>,
    cached_guest_tools: Arc<RwLock<Vec<CachedGuestToolsStateV1>>>,
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
            cached_guest_tools: Arc::new(RwLock::new(Vec::new())),
        }
    }
}

#[derive(Clone)]
struct BridgeOutbound {
    urgent: mpsc::Sender<BridgeMessageV8>,
    inventory: mpsc::Sender<BridgeMessageV8>,
    normal: mpsc::Sender<BridgeMessageV8>,
}

#[derive(Clone)]
struct BridgeReportSources {
    cfg: BridgeConfig,
    vm: VmManager,
    db: Db,
    disk_probe_path: PathBuf,
    cache: BridgeReportCache,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentBootstrapRequest<'a> {
    host_id: &'a str,
    bootstrap_token: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentBootstrapResponse {
    pub(crate) access_token: String,
    pub(crate) ws_url: Option<String>,
    host_id: String,
    owner_user_id: String,
    scope: intar_contracts::bridge::HostScope,
    credential_generation: u64,
}

pub async fn run(cfg: BridgeConfig, vm: VmManager, db: Db, disk_probe_path: PathBuf) {
    let http = match HttpClient::builder()
        .redirect(reqwest::redirect::Policy::none())
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
    // Cached identity is restart evidence, not permission to create new work.
    // Reconcile only after this control connection receives current desired state.
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
    vm.cache_run_cli_access_token(&bootstrap.access_token).await;
    crate::image_cache::cache_registry_access_token(&bootstrap.access_token).await;
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
        &BridgeMessageV8::ClientHello(ClientHelloV8 {
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
                    BridgeMessageV8::ServerHello(server_hello) => break Ok(server_hello),
                    other => {
                        anyhow::bail!("expected server_hello, got {}", bridge_message_type(&other))
                    }
                }
            }
        }
    })
    .await
    .context("timed out waiting for server_hello")??;
    anyhow::ensure!(
        !server_hello.session_id.trim().is_empty(),
        "missing bridge session identity"
    );
    validate_relay_identity(cfg, &server_hello.session_id, server_hello.relay.as_ref())?;
    info!(
        host_id = %server_hello.host_id,
        desired_version = server_hello.desired_version,
        "bridge v8 handshake complete"
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
    // Terminal transitions no longer advance inventory until their targeted
    // report is queued, so this subscription must also precede the snapshot.
    let mut probe_updates = vm.subscribe_probe_updates();
    let mut terminal_updates = vm.subscribe_terminal_updates();
    let inventory_updates = vm.subscribe_inventory_updates();
    let mut relay_updates = vm.subscribe_inventory_updates();
    let mut relay = crate::relay::RelayRunner::new();
    let mut relay_status = relay.subscribe();
    vm.set_relay_status(relay_status.clone());
    vm.set_control_connected(true);
    let mut relay_credentials = server_hello.relay;
    // Wait for a current desired state on this authenticated connection before
    // granting relay access to any records recovered from disk.
    let mut received_desired = false;
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
    let (urgent_tx, urgent_rx) = mpsc::channel(URGENT_OUTBOUND_CAPACITY);
    let (inventory_tx, inventory_rx) = mpsc::channel(INVENTORY_OUTBOUND_CAPACITY);
    let (normal_tx, normal_rx) = mpsc::channel(NORMAL_OUTBOUND_CAPACITY);
    let outbound = BridgeOutbound {
        urgent: urgent_tx,
        inventory: inventory_tx,
        normal: normal_tx,
    };

    // One task owns the websocket sink. Generation-fenced terminal transitions
    // have the highest-priority queue, inventory snapshots remain ahead of
    // ordinary traffic, and every individual socket send is bounded. A sealed
    // terminal-ready report therefore cannot remain queued behind the inventory
    // snapshot emitted by the same atomic ready publication.
    let mut writer_task =
        tokio::spawn(run_bridge_writer(write, urgent_rx, inventory_rx, normal_rx));
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
        let mut run_cli_access_refresh = interval(Duration::from_secs(
            RUN_CLI_ACCESS_REFRESH_INTERVAL_SECS,
        ));
        run_cli_access_refresh.set_missed_tick_behavior(MissedTickBehavior::Delay);
        run_cli_access_refresh.tick().await;
        loop {
            tokio::select! {
                inbound = read.next() => {
                    let Some(inbound) = inbound else {
                        anyhow::bail!("bridge websocket closed");
                    };
                    let inbound = inbound.context("failed reading bridge message")?;
                    if let Some(message) = parse_bridge_message(inbound)? {
                        validate_bridge_message(&message, &cfg.host_id)?;
                        if let BridgeMessageV8::DesiredState(desired) = &message {
                            validate_desired_state(cfg, &desired.desired_state)?;
                            validate_relay_identity(cfg, &server_hello.session_id, desired.relay.as_ref())?;
                            if !desired_state_is_stale(current_desired_state.as_ref(), &desired.desired_state) {
                                relay_credentials = desired.relay.clone();
                                received_desired = true;
                            }
                        }
                        handle_server_message(
                            &outbound.normal,
                            &report_sources,
                            current_desired_state,
                            &desired_state_tx,
                            message,
                        ).await?;
                        if received_desired {
                            update_relay(&mut relay, cfg, vm, relay_credentials.clone(), current_desired_state.as_ref()).await?;
                        }
                    }
                }
                changed = relay_status.changed() => {
                    changed.context("relay status channel closed")?;
                    relay_status.borrow_and_update();
                    vm.request_inventory_update();
                }
                changed = relay_updates.changed() => {
                    changed.context("relay inventory channel closed")?;
                    if received_desired {
                        update_relay(&mut relay, cfg, vm, relay_credentials.clone(), current_desired_state.as_ref()).await?;
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
                _ = run_cli_access_refresh.tick() => {
                    let access = refresh_agent_access(cfg, http).await?;
                    vm.cache_run_cli_access_token(&access.access_token).await;
                    crate::image_cache::cache_registry_access_token(&access.access_token).await;
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
                                send_vm_report(&outbound.urgent, &cfg.host_id, report).await?;
                                // Queue the targeted generation-fenced report
                                // before waking the independent inventory
                                // builder. Writer priority can now guarantee
                                // that a queued boot snapshot cannot overtake
                                // this terminal transition.
                                vm.request_inventory_update();
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                            warn!(
                                skipped,
                                "terminal update channel lagged; requesting authoritative inventory resync"
                            );
                            // Drop the retained stale tail. Otherwise strict
                            // urgent priority could replay it ahead of the
                            // authoritative cached inventory requested below.
                            terminal_updates = vm.subscribe_terminal_updates();
                            vm.request_inventory_update();
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                            anyhow::bail!("terminal update channel closed");
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

    relay.close();
    vm.set_control_connected(false);
    vm.clear_run_cli_access_token().await;
    crate::image_cache::clear_registry_access_token().await;
    writer_task.abort();
    inventory_task.abort();
    connection_result
}

async fn handle_server_message(
    outbound: &mpsc::Sender<BridgeMessageV8>,
    sources: &BridgeReportSources,
    current_desired_state: &mut Option<HostDesiredStateV2>,
    desired_state_tx: &watch::Sender<Option<HostDesiredStateV2>>,
    message: BridgeMessageV8,
) -> Result<()> {
    let cfg = &sources.cfg;
    let vm = &sources.vm;
    let db = &sources.db;
    match message {
        BridgeMessageV8::DesiredState(message) => {
            validate_desired_state(cfg, &message.desired_state)?;
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
            validate_desired_transition(current_desired_state.as_ref(), &desired_state)?;
            let refresh_cache =
                required_cache_pins_changed(current_desired_state.as_ref(), &desired_state);
            cache_desired_state(db, &desired_state)
                .await
                .context("failed to cache desired state")?;
            if refresh_cache {
                crate::image_cache::wake_cache_refresh();
            }
            let failure_reports = apply_desired_state(cfg, vm, &message).await?;
            *current_desired_state = Some(desired_state);
            desired_state_tx.send_replace(current_desired_state.clone());
            for report in failure_reports {
                send_vm_report(outbound, &cfg.host_id, report).await?;
            }
            send_state_report(outbound, sources, current_desired_state.as_ref()).await?;
        }
        BridgeMessageV8::SyncRequest(_) => {
            send_state_report(outbound, sources, current_desired_state.as_ref()).await?;
        }
        BridgeMessageV8::ServerHello(_) => {
            anyhow::bail!("received duplicate server_hello after handshake");
        }
        BridgeMessageV8::ClientHello(_)
        | BridgeMessageV8::StateReport(_)
        | BridgeMessageV8::VmReport(_)
        | BridgeMessageV8::BuildReport(_) => {
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

#[derive(Debug, Default, Eq, PartialEq)]
struct RequiredCachePins {
    images: BTreeSet<(String, String, String, String)>,
    guest_tools: BTreeSet<(String, u64, String, u16)>,
}

fn required_cache_pins(desired: &HostDesiredStateV2) -> RequiredCachePins {
    let mut pins = RequiredCachePins::default();
    for image in &desired.cached_images {
        pins.images
            .insert(image_cache_pin(&image.image_key, &image.image_id));
    }
    for tools in &desired.cached_guest_tools {
        pins.guest_tools.insert(guest_tools_cache_pin(tools));
    }
    for vm in desired
        .vms
        .iter()
        .filter(|vm| vm.desired_phase == DesiredVmPhase::Running)
    {
        pins.images
            .insert(image_cache_pin(&vm.image_key, &vm.image_id));
        pins.guest_tools
            .insert(guest_tools_cache_pin(&vm.guest_tools));
    }
    pins
}

fn image_cache_pin(
    image_key: &intar_contracts::catalog::ImageKey,
    image_id: &str,
) -> (String, String, String, String) {
    (
        image_key.scenario.clone(),
        image_key.vm.clone(),
        image_architecture_slug(&image_key.arch).to_string(),
        normalized_cache_pin_digest(image_id),
    )
}

fn required_cache_pins_changed(
    current: Option<&HostDesiredStateV2>,
    incoming: &HostDesiredStateV2,
) -> bool {
    current.is_none_or(|current| required_cache_pins(current) != required_cache_pins(incoming))
}

fn guest_tools_cache_pin(
    tools: &intar_contracts::bridge::DesiredGuestToolsV1,
) -> (String, u64, String, u16) {
    (
        normalized_cache_pin_digest(&tools.tools_disk_sha256),
        tools.tools_disk_size_bytes,
        normalized_cache_pin_digest(&tools.kino_sha256),
        tools.bootstrap_abi,
    )
}

fn normalized_cache_pin_digest(value: &str) -> String {
    normalize_sha256(value).unwrap_or_else(|| value.trim().to_ascii_lowercase())
}

pub(crate) async fn load_cached_desired_state(
    cfg: &BridgeConfig,
    db: &Db,
) -> Option<HostDesiredStateV2> {
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
    if row.version < 0 || desired_state.version != row.version as u64 {
        return None;
    }
    if let Err(error) = validate_desired_state(cfg, &desired_state) {
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
    message: &DesiredStateV8,
) -> Result<Vec<VmReportV2>> {
    validate_desired_state(cfg, &message.desired_state)?;
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
    if desired_vm.lease_expires_at_unix_ms <= now {
        delete_vm_if_present(vm, &desired_vm.vm_name).await;
        anyhow::bail!("desired VM lease expired");
    }
    if let Some(existing) = vm.get_vm(&desired_vm.vm_name).await {
        let existing_run_id = local_run_id(&existing);
        if existing_run_id.as_deref() == Some(desired_vm.run_id.as_str())
            && existing.details.as_ref().is_some_and(|d| {
                d.owner_user_id == desired_vm.owner_user_id
                    && d.runtime_execution_id == desired_vm.runtime_execution_id
                    && d.generation == desired_vm.generation
            })
        {
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
        owner_user_id: desired_vm.owner_user_id.clone(),
        runtime_execution_id: desired_vm.runtime_execution_id.clone(),
        generation: desired_vm.generation,
        name: desired_vm.vm_name.clone(),
        run_id: desired_vm.run_id.clone(),
        image: image_cache_key(&desired_vm.image_key),
        image_sha256: desired_vm.image_id.clone(),
        guest_tools: desired_vm.guest_tools.clone(),
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

mod reporting;
use reporting::*;
mod transport;
pub(crate) use transport::bootstrap_agent_access;
use transport::*;
#[cfg(test)]
mod tests;

/// Refuse startup before any cache, networking, readiness or VM work if local
/// records cannot be attributed to the current enrolled host and assignment.
pub(crate) async fn validate_restart(
    cfg: &BridgeConfig,
    db: &Db,
    rows: &[crate::db::VmRow],
) -> Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let desired = load_cached_desired_state(cfg, db)
        .await
        .context("persisted VMs require a valid desired state for this host")?;
    for row in rows {
        cfg.validate_owner(
            &row.owner_user_id,
            &row.runtime_execution_id,
            u64::try_from(row.generation).context("invalid persisted generation")?,
        )?;
        anyhow::ensure!(
            desired.vms.iter().any(|vm| vm.vm_name == row.name
                && Some(vm.run_id.as_str()) == row.run_id.as_deref()
                && vm.owner_user_id == row.owner_user_id
                && vm.runtime_execution_id == row.runtime_execution_id
                && vm.generation == row.generation as u64),
            "persisted VM execution differs from desired state"
        );
    }
    Ok(())
}

fn validate_relay_identity(
    cfg: &BridgeConfig,
    session_id: &str,
    credentials: Option<&intar_contracts::bridge::HostRelayCredentials>,
) -> Result<()> {
    if let Some(credentials) = credentials {
        anyhow::ensure!(
            credentials.identity.host_id == cfg.host_id
                && credentials.identity.credential_generation == cfg.credential_generation
                && credentials.identity.session_id == session_id,
            "relay control session identity mismatch"
        );
    }
    Ok(())
}

async fn update_relay(
    relay: &mut crate::relay::RelayRunner,
    cfg: &BridgeConfig,
    vm: &VmManager,
    credentials: Option<intar_contracts::bridge::HostRelayCredentials>,
    desired: Option<&HostDesiredStateV2>,
) -> Result<()> {
    use intar_contracts::stargate::{RelayService, RelayTarget};
    let mut assignments = Vec::new();
    if let Some(credentials) = &credentials {
        anyhow::ensure!(
            credentials.identity.host_id == cfg.host_id
                && credentials.identity.credential_generation == cfg.credential_generation,
            "relay host identity mismatch"
        );
        if let Some(desired) = desired {
            for target in &desired.vms {
                if target.desired_phase != DesiredVmPhase::Running
                    || target.lease_expires_at_unix_ms <= now_ms()
                {
                    continue;
                }
                let Some(local) = vm.get_vm(&target.vm_name).await else {
                    continue;
                };
                let Some(details) = local.details.as_ref() else {
                    continue;
                };
                if details.run_id.as_deref() != Some(target.run_id.as_str())
                    || details.owner_user_id != target.owner_user_id
                    || details.runtime_execution_id != target.runtime_execution_id
                    || details.generation != target.generation
                {
                    continue;
                }
                let Some(terminal) = vm.committed_terminal_state(&target.vm_name).await else {
                    continue;
                };
                if terminal.state != VmTerminalStateKind::Ready {
                    continue;
                }
                let Some(ip) = details.guest_ip.as_deref() else {
                    continue;
                };
                let address =
                    std::net::SocketAddr::new(ip.parse().context("invalid local guest IP")?, 22);
                let remaining = target.lease_expires_at_unix_ms.saturating_sub(now_ms());
                if remaining <= 0 {
                    continue;
                }
                assignments.push((
                    RelayTarget {
                        host: credentials.identity.clone(),
                        owner_id: target.owner_user_id.clone(),
                        execution_id: target.runtime_execution_id.clone(),
                        execution_generation: target.generation,
                        vm_id: target.vm_id.clone(),
                        service: RelayService::Ssh,
                    },
                    address,
                    tokio::time::Instant::now() + Duration::from_millis(remaining as u64),
                ));
            }
        }
    }
    relay.apply(credentials, assignments).await
}

fn validate_desired_transition(
    current: Option<&HostDesiredStateV2>,
    incoming: &HostDesiredStateV2,
) -> Result<()> {
    let Some(current) = current else {
        return Ok(());
    };
    anyhow::ensure!(
        incoming.version != current.version || incoming == current,
        "desired state changed without a version increment"
    );
    for vm in &incoming.vms {
        for previous in current.vms.iter().filter(|old| old.run_id == vm.run_id) {
            anyhow::ensure!(
                vm.owner_user_id == previous.owner_user_id && vm.generation >= previous.generation,
                "desired execution owner or generation regressed"
            );
            anyhow::ensure!(
                vm.generation != previous.generation
                    || vm.runtime_execution_id == previous.runtime_execution_id,
                "desired execution identity changed within one generation"
            );
        }
    }
    Ok(())
}
