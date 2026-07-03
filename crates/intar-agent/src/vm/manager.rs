#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result};
use axum::http::StatusCode;
use cloud_hypervisor_client::{
    Client as ChClient, ConsoleConfig, CpusConfig, DiskConfig, DiskImageType, MemoryConfig,
    NetConfig, PayloadConfig, SerialConfig, VmConfig, VsockConfig,
};
use futures_util::stream::{self, StreamExt as _, TryStreamExt as _};
use getrandom::fill as getrandom_fill;
use intar_contracts::guest::RECORDING_DISK_LABEL;
use reqwest::Client as HttpClient;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt as _;
use tokio::net::TcpStream;
use tokio::process::Command;
use tokio::sync::{Mutex, OwnedMutexGuard, RwLock, Semaphore, broadcast};
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tracing::{debug, error, info, warn};

use crate::config::{
    AgentConfig, BridgeConfig, ImageRegistryConfig, SshAccessConfig, VmDefaultsConfig,
};
use crate::db::{ArchiveJobRow, Db, VmProbeStateRow, VmRow};
use crate::image_cache;
use crate::kino_probe::{ProbeCollectionState, ProbeSnapshotView, ProbeUpdateEnvelope};
#[cfg(target_os = "linux")]
use crate::kino_probe::{ProbePollResult, decode_probe_snapshot};

use super::{kino_recording, mac, replay_media, runtime_disk};

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateVmResources {
    pub vcpus: u32,
    pub memory_mib: u32,
    pub disk_mib: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateScenarioVmRequest {
    pub name: String,
    pub run_id: String,
    pub image: String,
    pub resources: Option<CreateVmResources>,
    pub hostname: Option<String>,
    pub lease_duration_seconds: Option<u64>,
    pub runtime: CreateScenarioVmRuntime,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateScenarioVmRuntime {
    pub ssh_authorized_keys_openssh: Vec<String>,
    pub network: Option<CreateScenarioVmRuntimeNetwork>,
    pub kino: Option<CreateScenarioVmRuntimeKino>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateScenarioVmRuntimeNetwork {
    pub guest_ip_cidr: String,
    pub gateway: Option<String>,
    pub dns: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateScenarioVmRuntimeKino {
    pub vsock_cid: u32,
    pub vsock_port: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct CreateVmNetwork {
    pub guest_ip_cidr: String,
    pub gateway: String,
    pub dns: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CreateVmResponse {
    pub name: String,
    pub state: VmLifecycleState,
}

#[derive(Debug, Clone, Serialize)]
pub struct VmStatusResponse {
    pub name: String,
    pub state: VmLifecycleState,
    pub created_at: String,
    pub updated_at: String,
    pub details: Option<VmDetails>,
    pub error: Option<String>,
    pub lease_duration_seconds: Option<u64>,
    pub lease_expires_at: Option<String>,
    #[serde(skip_serializing)]
    created_at_s: i64,
    #[serde(skip_serializing)]
    updated_at_s: i64,
    #[serde(skip_serializing)]
    running_at_s: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VmDetails {
    pub run_id: Option<String>,
    pub root_disk_path: String,
    pub seed_disk_path: String,
    pub recording_disk_path: Option<String>,
    pub spool_dir: Option<String>,
    pub mac: String,
    pub guest_ip: Option<String>,
    pub guest_ip_cidr: Option<String>,
    pub gateway: Option<String>,
    pub bridge_name: Option<String>,
    pub ssh_public_port: Option<u16>,
    pub tap_name: Option<String>,
    pub ch_socket_path: Option<String>,
    pub ch_pid: Option<u32>,
    pub kino_vsock_cid: Option<u32>,
    pub kino_vsock_port: Option<u32>,
    pub kino_vsock_path: Option<String>,
    pub ssh_host_keys_openssh: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PruneVmsResponse {
    pub requested: usize,
    pub deleted: usize,
    pub failed: usize,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VmLifecycleState {
    Queued,
    CachingImage,
    PreparingDisks,
    CreatingVm,
    BootingVm,
    Running,
    DeletingVm,
    ArchivingArtifacts,
    Failed,
    DeleteFailed,
}

impl VmLifecycleState {
    fn as_str(self) -> &'static str {
        match self {
            VmLifecycleState::Queued => "queued",
            VmLifecycleState::CachingImage => "caching_image",
            VmLifecycleState::PreparingDisks => "preparing_disks",
            VmLifecycleState::CreatingVm => "creating_vm",
            VmLifecycleState::BootingVm => "booting_vm",
            VmLifecycleState::Running => "running",
            VmLifecycleState::DeletingVm => "deleting_vm",
            VmLifecycleState::ArchivingArtifacts => "archiving_artifacts",
            VmLifecycleState::Failed => "failed",
            VmLifecycleState::DeleteFailed => "delete_failed",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s {
            "queued" => Some(VmLifecycleState::Queued),
            "caching_image" => Some(VmLifecycleState::CachingImage),
            "preparing_disks" => Some(VmLifecycleState::PreparingDisks),
            "creating_vm" => Some(VmLifecycleState::CreatingVm),
            "booting_vm" => Some(VmLifecycleState::BootingVm),
            "running" => Some(VmLifecycleState::Running),
            "deleting_vm" => Some(VmLifecycleState::DeletingVm),
            "archiving_artifacts" => Some(VmLifecycleState::ArchivingArtifacts),
            "failed" => Some(VmLifecycleState::Failed),
            "delete_failed" => Some(VmLifecycleState::DeleteFailed),
            _ => None,
        }
    }

    fn is_failure(self) -> bool {
        matches!(
            self,
            VmLifecycleState::Failed | VmLifecycleState::DeleteFailed
        )
    }
}

impl VmStatusResponse {
    fn to_db_row(&self) -> VmRow {
        VmRow {
            name: self.name.clone(),
            state: self.state.as_str().to_string(),
            created_at_s: self.created_at_s,
            updated_at_s: self.updated_at_s,
            running_at_s: self.running_at_s,
            error: self.error.clone(),
            root_disk_path: self.details.as_ref().map(|d| d.root_disk_path.clone()),
            seed_disk_path: self.details.as_ref().map(|d| d.seed_disk_path.clone()),
            mac: self.details.as_ref().map(|d| d.mac.clone()),
            lease_duration_seconds: self.lease_duration_seconds.map(|v| v as i64),
            guest_ip: self.details.as_ref().and_then(|d| d.guest_ip.clone()),
            guest_ip_cidr: self.details.as_ref().and_then(|d| d.guest_ip_cidr.clone()),
            gateway: self.details.as_ref().and_then(|d| d.gateway.clone()),
            bridge_name: self.details.as_ref().and_then(|d| d.bridge_name.clone()),
            ssh_public_port: self
                .details
                .as_ref()
                .and_then(|d| d.ssh_public_port)
                .map(i64::from),
            tap_name: self.details.as_ref().and_then(|d| d.tap_name.clone()),
            ch_socket_path: self.details.as_ref().and_then(|d| d.ch_socket_path.clone()),
            ch_pid: self.details.as_ref().and_then(|d| d.ch_pid).map(i64::from),
            kino_vsock_cid: self
                .details
                .as_ref()
                .and_then(|d| d.kino_vsock_cid)
                .map(i64::from),
            kino_vsock_port: self
                .details
                .as_ref()
                .and_then(|d| d.kino_vsock_port)
                .map(i64::from),
            kino_vsock_path: self
                .details
                .as_ref()
                .and_then(|d| d.kino_vsock_path.clone()),
            ssh_host_keys_openssh_json: self.details.as_ref().and_then(|d| {
                if d.ssh_host_keys_openssh.is_empty() {
                    None
                } else {
                    serde_json::to_string(&d.ssh_host_keys_openssh).ok()
                }
            }),
            run_id: self.details.as_ref().and_then(|d| d.run_id.clone()),
            recording_disk_path: self
                .details
                .as_ref()
                .and_then(|d| d.recording_disk_path.clone()),
            spool_dir: self.details.as_ref().and_then(|d| d.spool_dir.clone()),
        }
    }

    fn is_expired(&self, now_s: i64) -> bool {
        let lease_duration_seconds = match self.lease_duration_seconds {
            Some(v) => v,
            None => return false,
        };
        let running_at_s = match self.running_at_s {
            Some(v) => v,
            None => return false,
        };

        let lease_expires_at_s =
            (running_at_s as i128).saturating_add(lease_duration_seconds as i128);
        (now_s as i128) >= lease_expires_at_s
    }
}

struct QueueVmCreateRequest {
    requested_name: String,
    requested_run_id: String,
    requested_image: String,
    requested_resources: Option<CreateVmResources>,
    requested_hostname: Option<String>,
    lease_duration_seconds: Option<u64>,
    runtime: CreateScenarioVmRuntime,
}

const LEASE_EXPIRY_ERROR_LOG_INTERVAL_S: i64 = 60;
const NFT_VM_NET_TABLE: &str = "intar";
const NFT_VM_NET_LEGACY_TABLE: &str = "intar_agent_vm_net";
const RUN_SUBNET_PREFIX: u8 = 28;
const KINO_VSOCK_PORT: u32 = 18_080;
const KINO_HOST_READY_PORT: u32 = 18_081;
const KINO_VSOCK_CID_MIN: u32 = 10_000;
const RECORDING_DISK_BYTES: u64 = 256 * 1024 * 1024;
const ARTIFACT_UPLOAD_PART_BYTES: usize = 16 * 1024 * 1024;
const ARTIFACT_UPLOAD_CONCURRENCY: usize = 4;
const ARCHIVE_JOB_BATCH_SIZE: usize = 4;
const ARCHIVE_RETRY_BASE_MS: i64 = 5_000;
const ARCHIVE_RETRY_MAX_MS: i64 = 5 * 60 * 1000;
const DELETE_SHUTDOWN_GRACE_SECONDS: u64 = 5;
const PROBE_POLL_INTERVAL_SECONDS: u64 = 2;
const TERMINAL_PENDING_POLL_INTERVAL_MILLIS: u64 = 500;
const TERMINAL_READY_POLL_INTERVAL_SECONDS: u64 = 5;
const SCENARIO_READY_TIMEOUT_SECONDS: u64 = 45;
const SCENARIO_READY_POLL_INTERVAL_MILLIS: u64 = 500;
#[cfg(target_os = "linux")]
const MAX_KINO_READY_FRAME_BYTES: usize = 2 * 1024 * 1024;
const CLOUD_HYPERVISOR_STDERR_LOG_NAME: &str = "cloud-hypervisor.stderr.log";
const RUNTIME_DISK_FILENAME: &str = "runtime.img";
const RUNTIME_DISK_ID_SUFFIX: &str = "runtime";

#[derive(Debug, Clone, PartialEq, Eq)]
struct LeaseExpiryErrorLogState {
    signature: String,
    last_logged_at_s: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CleanupOutcome {
    Deleted,
    Missing,
    SkippedNotExpired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StartupCleanupMode {
    Archive,
    DropLocal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StartupReconcileOutcome {
    ResumingReadiness,
    ArchivedStale,
    DroppedStale,
    KeptInconclusive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrackedVmRuntimeStatus {
    Live(TrackedVmLiveState),
    Dead,
    Inconclusive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrackedVmLiveState {
    Created,
    Running,
    Paused,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CleanupMode {
    ArchiveArtifacts,
    LocalOnly,
}

#[derive(Debug)]
struct VmProbeTask {
    join: JoinHandle<()>,
}

#[derive(Debug)]
struct VmTerminalTask {
    join: JoinHandle<()>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VmTerminalStateKind {
    Pending,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VmTerminalTarget {
    pub host: Option<String>,
    pub port: u16,
    pub username: String,
    pub checked_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VmTerminalState {
    pub run_id: String,
    pub vm_name: String,
    pub state: VmTerminalStateKind,
    pub terminal_target: Option<VmTerminalTarget>,
    pub reason: Option<String>,
    pub observed_at: i64,
}

impl VmTerminalState {
    pub fn fingerprint(&self) -> String {
        let terminal_target = self.terminal_target.as_ref().map(|target| {
            json!({
                "host": target.host,
                "port": target.port,
                "username": target.username,
            })
        });
        let payload = json!({
            "state": self.state,
            "terminalTarget": terminal_target,
            "reason": self.reason,
        });
        let mut hasher = Sha256::new();
        hasher.update(payload.to_string().as_bytes());
        base16ct::lower::encode_string(&hasher.finalize())
    }
}

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub message: String,
}

impl ApiError {
    fn bad_request(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: msg.into(),
        }
    }

    fn not_found(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: msg.into(),
        }
    }

    fn conflict(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            message: msg.into(),
        }
    }

    fn internal(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: msg.into(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct VmManager {
    inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
    ch_binary: String,
    ch_spawn_timeout_seconds: u64,
    bridge: BridgeConfig,
    ssh_access: SshAccessConfig,
    db: Db,
    http: HttpClient,
    image_registry: ImageRegistryConfig,
    defaults: VmDefaultsConfig,
    states: RwLock<BTreeMap<String, VmStatusResponse>>,
    lease_expiry_error_log: RwLock<BTreeMap<String, LeaseExpiryErrorLogState>>,
    probe_tasks: Mutex<BTreeMap<String, VmProbeTask>>,
    probe_updates_tx: broadcast::Sender<ProbeUpdateEnvelope>,
    terminal_tasks: Mutex<BTreeMap<String, VmTerminalTask>>,
    terminal_state_fingerprints: Mutex<BTreeMap<String, String>>,
    terminal_updates_tx: broadcast::Sender<VmTerminalState>,
    kino_vsock_cid_lock: Mutex<()>,
    create_sem: Arc<Semaphore>,
    delete_requests: Mutex<BTreeSet<String>>,
    cleanup_locks: Mutex<BTreeMap<String, Arc<Mutex<()>>>>,
    archive_jobs_lock: Mutex<()>,
}

impl VmManager {
    pub fn new(cfg: &AgentConfig, db: Db, persisted: Vec<VmRow>) -> Self {
        let mut states = BTreeMap::new();
        for row in persisted {
            match vm_status_from_row(row) {
                Ok(vm) => {
                    states.insert(vm.name.clone(), vm);
                }
                Err(e) => {
                    warn!(error = %e, "skipping invalid vm row from sqlite");
                }
            }
        }

        let (probe_updates_tx, _) = broadcast::channel(256);
        let (terminal_updates_tx, _) = broadcast::channel(256);
        let inner = Inner {
            ch_binary: cfg.cloud_hypervisor.binary.clone(),
            ch_spawn_timeout_seconds: cfg.cloud_hypervisor.spawn_timeout_seconds,
            bridge: cfg.bridge.clone(),
            ssh_access: cfg.ssh_access.clone(),
            db,
            http: HttpClient::new(),
            image_registry: cfg.image_registry.clone(),
            defaults: cfg.vm_defaults.clone(),
            states: RwLock::new(states),
            lease_expiry_error_log: RwLock::new(BTreeMap::new()),
            probe_tasks: Mutex::new(BTreeMap::new()),
            probe_updates_tx,
            terminal_tasks: Mutex::new(BTreeMap::new()),
            terminal_state_fingerprints: Mutex::new(BTreeMap::new()),
            terminal_updates_tx,
            kino_vsock_cid_lock: Mutex::new(()),
            create_sem: Arc::new(Semaphore::new(8)),
            delete_requests: Mutex::new(BTreeSet::new()),
            cleanup_locks: Mutex::new(BTreeMap::new()),
            archive_jobs_lock: Mutex::new(()),
        };
        Self {
            inner: Arc::new(inner),
        }
    }

    pub async fn ensure_host_networking(&self) -> Result<()> {
        ensure_vm_network_reconciled(&self.inner).await
    }

    pub fn subscribe_probe_updates(&self) -> broadcast::Receiver<ProbeUpdateEnvelope> {
        self.inner.probe_updates_tx.subscribe()
    }

    pub fn spawn_kino_ready_listener(&self) {
        spawn_kino_ready_listener(Arc::clone(&self.inner));
    }

    pub fn subscribe_terminal_updates(&self) -> broadcast::Receiver<VmTerminalState> {
        self.inner.terminal_updates_tx.subscribe()
    }

    pub async fn reconcile_tracked_vms(&self) -> Result<()> {
        let names = {
            let states = self.inner.states.read().await;
            states.keys().cloned().collect::<Vec<_>>()
        };

        let mut resuming_readiness = 0usize;
        let mut archived_stale = 0usize;
        let mut dropped_stale = 0usize;
        let mut kept_inconclusive = 0usize;

        for name in names {
            match reconcile_tracked_vm_on_startup(&self.inner, &name).await {
                Ok(StartupReconcileOutcome::ResumingReadiness) => {
                    resuming_readiness = resuming_readiness.saturating_add(1);
                }
                Ok(StartupReconcileOutcome::ArchivedStale) => {
                    archived_stale = archived_stale.saturating_add(1);
                }
                Ok(StartupReconcileOutcome::DroppedStale) => {
                    dropped_stale = dropped_stale.saturating_add(1);
                }
                Ok(StartupReconcileOutcome::KeptInconclusive) => {
                    kept_inconclusive = kept_inconclusive.saturating_add(1);
                }
                Err(error) => {
                    warn!(vm = name, error = %error, "failed to reconcile tracked vm on startup");
                }
            }
        }

        info!(
            resuming_readiness,
            archived_stale,
            dropped_stale,
            kept_inconclusive,
            "reconciled tracked vm state on startup"
        );

        Ok(())
    }

    pub async fn restore_probe_workers(&self) -> Result<()> {
        let running_vms = {
            let states = self.inner.states.read().await;
            states
                .values()
                .filter(|vm| vm.state == VmLifecycleState::Running)
                .cloned()
                .collect::<Vec<_>>()
        };

        for vm in running_vms {
            let Some(details) = vm.details.as_ref() else {
                warn!(vm = vm.name, "skipping probe restore; vm has no details");
                continue;
            };
            let Some(_) = details.kino_vsock_path.as_ref() else {
                warn!(
                    vm = vm.name,
                    "skipping probe restore; missing kino_vsock_path"
                );
                continue;
            };

            if let Err(e) = start_probe_worker(&self.inner, &vm.name, details).await {
                warn!(error = %e, vm = vm.name, "failed to restore probe worker");
            }
            if let Err(e) = start_terminal_worker(&self.inner, &vm.name).await {
                warn!(error = %e, vm = vm.name, "failed to restore terminal worker");
            }
        }

        Ok(())
    }

    pub async fn retry_archive_jobs(&self) -> Result<()> {
        retry_archive_jobs(&self.inner).await
    }

    pub async fn create_scenario_vm(
        &self,
        req: CreateScenarioVmRequest,
    ) -> Result<CreateVmResponse, ApiError> {
        let ssh_authorized_keys_openssh = req
            .runtime
            .ssh_authorized_keys_openssh
            .into_iter()
            .map(|key| key.trim().to_string())
            .filter(|key| !key.is_empty())
            .collect::<Vec<_>>();
        if ssh_authorized_keys_openssh.is_empty() {
            return Err(ApiError::bad_request(
                "runtime.ssh_authorized_keys_openssh must not be empty",
            ));
        }

        let runtime = CreateScenarioVmRuntime {
            ssh_authorized_keys_openssh,
            network: req.runtime.network,
            kino: req.runtime.kino,
        };

        self.queue_vm_create(QueueVmCreateRequest {
            requested_name: req.name,
            requested_run_id: req.run_id,
            requested_image: req.image,
            requested_resources: req.resources,
            requested_hostname: req.hostname,
            lease_duration_seconds: req.lease_duration_seconds,
            runtime,
        })
        .await
    }

    async fn queue_vm_create(
        &self,
        req: QueueVmCreateRequest,
    ) -> Result<CreateVmResponse, ApiError> {
        let QueueVmCreateRequest {
            requested_name,
            requested_run_id,
            requested_image,
            requested_resources,
            requested_hostname,
            lease_duration_seconds,
            runtime,
        } = req;

        let name = requested_name.trim().to_string();
        if name.is_empty() {
            return Err(ApiError::bad_request("name must not be empty"));
        }
        if !is_safe_key(&name) {
            return Err(ApiError::bad_request("name must match [A-Za-z0-9_-]+"));
        }
        let run_id = requested_run_id.trim().to_string();
        if run_id.is_empty() {
            return Err(ApiError::bad_request("run_id must not be empty"));
        }
        if !is_safe_key(&run_id) {
            return Err(ApiError::bad_request("run_id must match [A-Za-z0-9_-]+"));
        }

        let image_key = requested_image.trim().to_string();
        if image_key.is_empty() {
            return Err(ApiError::bad_request("image must not be empty"));
        }
        if !is_safe_key(&image_key) {
            return Err(ApiError::bad_request("image must match [A-Za-z0-9_-]+"));
        }

        {
            let states = self.inner.states.read().await;
            if states.contains_key(&name) {
                return Err(ApiError::conflict(format!("vm \"{name}\" already exists")));
            }
        }

        let permit = self
            .inner
            .create_sem
            .clone()
            .try_acquire_owned()
            .map_err(|_| ApiError::conflict("another vm create is already in progress"))?;

        let tap_prefix = self.inner.defaults.tap.trim().to_string();
        if tap_prefix.is_empty() {
            return Err(ApiError::internal("vm_defaults.tap is not configured"));
        }

        let resources = requested_resources.unwrap_or(CreateVmResources {
            vcpus: self.inner.defaults.resources.vcpus,
            memory_mib: self.inner.defaults.resources.memory_mib,
            disk_mib: None,
        });
        if resources.vcpus == 0 {
            return Err(ApiError::bad_request("resources.vcpus must be >= 1"));
        }
        if resources.memory_mib == 0 {
            return Err(ApiError::bad_request("resources.memory_mib must be >= 1"));
        }
        if let Some(disk_mib) = resources.disk_mib
            && disk_mib == 0
        {
            return Err(ApiError::bad_request("resources.disk_mib must be >= 1"));
        }

        let scenario_runtime = &runtime;
        let (mut network, bridge_name) = match scenario_runtime.network.as_ref() {
            Some(runtime_network) => {
                let guest_ip_cidr = runtime_network.guest_ip_cidr.clone();
                let gateway = match runtime_network.gateway.clone() {
                    Some(gateway) => gateway,
                    None => gateway_for_guest_cidr(&guest_ip_cidr).map_err(|e| {
                        ApiError::bad_request(format!("invalid scenario runtime network: {e}"))
                    })?,
                };
                (
                    CreateVmNetwork {
                        guest_ip_cidr,
                        gateway,
                        dns: runtime_network
                            .dns
                            .clone()
                            .unwrap_or_else(|| self.inner.defaults.network.dns.clone()),
                    },
                    run_bridge_name(&run_id),
                )
            }
            None => allocate_run_network(&self.inner, &run_id, &name).await?,
        };
        let normalized_guest_cidr = validate_network(&network).map_err(|e| {
            if scenario_runtime.network.is_some() {
                ApiError::bad_request(format!("invalid scenario runtime network: {e}"))
            } else {
                ApiError::internal(format!("invalid vm_defaults.network: {e}"))
            }
        })?;
        network.guest_ip_cidr = normalized_guest_cidr;
        ensure_guest_ip_available(&self.inner, &network.guest_ip_cidr).await?;
        let guest_ip = extract_guest_ip(&network.guest_ip_cidr)
            .map_err(|e| ApiError::internal(format!("failed to derive guest ip: {e}")))?;
        let tap_name = allocate_tap_name(&self.inner, &name, &tap_prefix).await;

        const MAX_LEASE_DURATION_SECONDS: u64 = 30 * 24 * 60 * 60;
        if let Some(secs) = lease_duration_seconds {
            if secs == 0 {
                return Err(ApiError::bad_request("lease_duration_seconds must be >= 1"));
            }
            if secs > MAX_LEASE_DURATION_SECONDS {
                return Err(ApiError::bad_request(format!(
                    "lease_duration_seconds must be <= {MAX_LEASE_DURATION_SECONDS}"
                )));
            }
        }

        let hostname = requested_hostname
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&name)
            .to_string();

        let created_at_s = now_unix_s();
        let created_at = format_rfc3339_s(created_at_s);
        let updated_at_s = created_at_s;

        let work_dir = resolve_work_dir(&self.inner.defaults)
            .map_err(|e| ApiError::internal(format!("failed to resolve vm work dir: {e}")))?;
        let vm_dir = work_dir.join("vms").join(&name);
        let spool_dir = vm_spool_dir(&work_dir, &run_id, &name);
        let recording_disk_path = spool_dir.join("recordings.vfat");

        match tokio::fs::metadata(&vm_dir).await {
            Ok(_) => {
                return Err(ApiError::conflict(format!(
                    "vm dir exists at {}",
                    vm_dir.display()
                )));
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(ApiError::internal(format!(
                    "failed to stat vm dir {}: {e}",
                    vm_dir.display()
                )));
            }
        }
        tokio::fs::create_dir_all(&vm_dir)
            .await
            .with_context(|| format!("failed to create vm dir at {}", vm_dir.display()))
            .map_err(|e| ApiError::internal(e.to_string()))?;
        tokio::fs::create_dir_all(spool_dir.join("artifacts"))
            .await
            .with_context(|| format!("failed to create run spool at {}", spool_dir.display()))
            .map_err(|e| ApiError::internal(e.to_string()))?;

        let root_disk_path = vm_dir.join("root.raw");
        let config_disk_path = vm_dir.join(RUNTIME_DISK_FILENAME);
        let ch_socket_path = vm_dir.join("cloud-hypervisor.sock");
        let ch_stderr_path = vm_dir.join(CLOUD_HYPERVISOR_STDERR_LOG_NAME);
        let kino_vsock_path = vm_dir.join("kino.vsock");
        let recording_disk_path_for_create = recording_disk_path.clone();
        tokio::task::spawn_blocking(move || create_recording_disk(&recording_disk_path_for_create))
            .await
            .context("recording disk task panicked")
            .map_err(|e| ApiError::internal(e.to_string()))?
            .with_context(|| {
                format!(
                    "failed to create recording disk at {}",
                    recording_disk_path.display()
                )
            })
            .map_err(|e| ApiError::internal(e.to_string()))?;
        let cid_guard = self.inner.kino_vsock_cid_lock.lock().await;
        let kino_vsock_cid = match scenario_runtime.kino.as_ref().map(|kino| kino.vsock_cid) {
            Some(vsock_cid) => {
                ensure_kino_vsock_cid_available(&self.inner, vsock_cid).await?;
                vsock_cid
            }
            None => allocate_kino_vsock_cid(&self.inner).await?,
        };
        let kino_vsock_port = scenario_runtime
            .kino
            .as_ref()
            .and_then(|kino| kino.vsock_port)
            .unwrap_or(KINO_VSOCK_PORT);
        if kino_vsock_port == 0 {
            return Err(ApiError::bad_request(
                "runtime.kino.vsock_port must be >= 1",
            ));
        }

        let mac = mac::generate_local_unicast_mac();

        let details = VmDetails {
            run_id: Some(run_id.clone()),
            root_disk_path: root_disk_path.display().to_string(),
            seed_disk_path: config_disk_path.display().to_string(),
            recording_disk_path: Some(recording_disk_path.display().to_string()),
            spool_dir: Some(spool_dir.display().to_string()),
            mac: mac.clone(),
            guest_ip: Some(guest_ip.clone()),
            guest_ip_cidr: Some(network.guest_ip_cidr.clone()),
            gateway: Some(network.gateway.clone()),
            bridge_name: Some(bridge_name.clone()),
            ssh_public_port: if self.inner.ssh_access.enabled {
                Some(allocate_ssh_public_port(&self.inner).await?)
            } else {
                None
            },
            tap_name: Some(tap_name.clone()),
            ch_socket_path: Some(ch_socket_path.display().to_string()),
            ch_pid: None,
            kino_vsock_cid: Some(kino_vsock_cid),
            kino_vsock_port: Some(kino_vsock_port),
            kino_vsock_path: Some(kino_vsock_path.display().to_string()),
            ssh_host_keys_openssh: Vec::new(),
        };

        let status = VmStatusResponse {
            name: name.clone(),
            state: VmLifecycleState::Queued,
            created_at: created_at.clone(),
            updated_at: created_at,
            details: Some(details.clone()),
            error: None,
            lease_duration_seconds,
            lease_expires_at: None,
            created_at_s,
            updated_at_s,
            running_at_s: None,
        };

        {
            let mut states = self.inner.states.write().await;
            states.insert(name.clone(), status.clone());
        }
        drop(cid_guard);

        if let Err(e) = self.inner.db.upsert_vm(status.to_db_row()).await {
            error!(error = %e, "failed to persist vm status (queued)");
        }
        if let Err(error) = ensure_vm_network_reconciled(&self.inner).await {
            warn!(
                error = %error,
                vm = name,
                "failed to reconcile ssh forwarding after queueing vm"
            );
        }

        let resp_name = name.clone();
        let inner = Arc::clone(&self.inner);
        let network_for_task = network.clone();
        let bridge_name_for_task = bridge_name.clone();
        let name_for_task = name.clone();
        let image_key_for_task = image_key.clone();
        let hostname_for_task = hostname.clone();
        let runtime_for_task = runtime.clone();
        let tap_for_task = tap_name.clone();
        let ch_socket_path_for_task = ch_socket_path.clone();
        let ch_stderr_path_for_task = ch_stderr_path.clone();
        let kino_vsock_path_for_task = kino_vsock_path.clone();

        tokio::spawn(async move {
            let _permit = permit;
            let span =
                tracing::info_span!("vm_create", vm = %name_for_task, image = %image_key_for_task);
            let _g = span.enter();

            let create_input = RunCreateInput {
                name: &name_for_task,
                image_key: &image_key_for_task,
                runtime: &runtime_for_task,
                tap: &tap_for_task,
                ch_socket_path: &ch_socket_path_for_task,
                ch_stderr_path: &ch_stderr_path_for_task,
                kino_vsock_cid,
                kino_vsock_port,
                kino_host_ready_port: KINO_HOST_READY_PORT,
                kino_vsock_path: &kino_vsock_path_for_task,
                vcpus: resources.vcpus,
                memory_mib: resources.memory_mib,
                disk_mib: resources.disk_mib,
                hostname: &hostname_for_task,
                mac: &mac,
                root_disk_path: &root_disk_path,
                config_disk_path: &config_disk_path,
                recording_disk_path: &recording_disk_path,
                network: &network_for_task,
                bridge_name: &bridge_name_for_task,
            };

            let create_result = run_create(&inner, create_input).await;
            if take_delete_request(&inner, &name_for_task).await {
                stop_booting_vm(&inner, &name_for_task).await;
                match cleanup_tracked_vm(&inner, &name_for_task, false).await {
                    Ok(_) => {
                        info!(
                            vm = name_for_task,
                            "cleaned up vm after delete request during create"
                        );
                    }
                    Err(error) => {
                        let err = error_chain_to_string(&error);
                        error!(
                            error = %err,
                            error_debug = ?error,
                            vm = name_for_task,
                            "failed to clean up vm after delete request during create"
                        );
                        mark_vm_failed(&inner, &name_for_task, err).await;
                    }
                }
                return;
            }

            if let Err(e) = create_result {
                let err = error_chain_to_string(&e);
                stop_booting_vm(&inner, &name_for_task).await;
                error!(error = %err, error_debug = ?e, "vm create failed");
                mark_vm_failed(&inner, &name_for_task, err).await;
            }
        });

        Ok(CreateVmResponse {
            name: resp_name,
            state: VmLifecycleState::Queued,
        })
    }

    pub async fn get_vm(&self, name: &str) -> Option<VmStatusResponse> {
        let states = self.inner.states.read().await;
        states.get(name).cloned()
    }

    pub async fn list_vms(&self) -> Vec<VmStatusResponse> {
        let states = self.inner.states.read().await;
        states.values().cloned().collect()
    }

    pub async fn delete_vm(&self, name: &str) -> Result<(), ApiError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(ApiError::bad_request("name must not be empty"));
        }

        let vm = {
            let states = self.inner.states.read().await;
            states.get(name).cloned()
        };
        let Some(vm) = vm else {
            return Err(ApiError::not_found("vm not found"));
        };

        if is_create_in_progress_state(vm.state) {
            request_delete(&self.inner, name).await;
            stop_booting_vm(&self.inner, name).await;
            return Ok(());
        }

        if matches!(
            vm.state,
            VmLifecycleState::DeletingVm | VmLifecycleState::ArchivingArtifacts
        ) {
            return Ok(());
        }

        set_state(&self.inner, name, VmLifecycleState::DeletingVm).await;
        stop_terminal_worker(&self.inner, name).await;
        publish_terminal_state_update(&self.inner, name, false).await;
        spawn_vm_cleanup_task(Arc::clone(&self.inner), name.to_string(), false);
        Ok(())
    }

    pub async fn delete_vm_by_run_id(&self, run_id: &str) -> Result<(), ApiError> {
        let run_id = run_id.trim();
        if run_id.is_empty() {
            return Err(ApiError::bad_request("run_id must not be empty"));
        }

        let names = {
            let states = self.inner.states.read().await;
            matching_vm_names_for_run_id(&states, run_id)
        };

        if names.is_empty() {
            return Err(ApiError::not_found("vm not found"));
        }

        let mut first_error = None;
        for name in names {
            match self.delete_vm(&name).await {
                Ok(()) => {}
                Err(err) if err.status == StatusCode::NOT_FOUND => {}
                Err(err) => {
                    if first_error.is_none() {
                        first_error = Some(err);
                    }
                }
            }
        }

        match first_error {
            Some(err) => Err(err),
            None => Ok(()),
        }
    }

    pub async fn cleanup_expired_leases(&self) -> Result<()> {
        let now_s = now_unix_s();
        let expired: Vec<VmStatusResponse> = {
            let states = self.inner.states.read().await;
            states
                .values()
                .filter(|vm| vm.is_expired(now_s))
                .cloned()
                .collect()
        };

        for vm in expired {
            match cleanup_tracked_vm(&self.inner, &vm.name, true).await {
                Ok(_) => {
                    self.clear_lease_expiry_error_log(&vm.name).await;
                }
                Err(e) => {
                    self.log_lease_expiry_error(&vm.name, &e).await;
                }
            }
        }

        Ok(())
    }

    pub async fn prune_vms(&self) -> PruneVmsResponse {
        let names: Vec<String> = {
            let states = self.inner.states.read().await;
            states.keys().cloned().collect()
        };

        let requested = names.len();
        let mut deleted = 0usize;
        let mut failed = 0usize;

        for name in names {
            let vm = {
                let states = self.inner.states.read().await;
                states.get(&name).cloned()
            };
            if vm
                .as_ref()
                .is_some_and(|vm| is_create_in_progress_state(vm.state))
            {
                failed = failed.saturating_add(1);
                warn!(
                    vm = name,
                    "skipping vm prune while create is still in progress"
                );
                continue;
            }

            match cleanup_tracked_vm(&self.inner, &name, false).await {
                Ok(CleanupOutcome::Deleted | CleanupOutcome::Missing) => {
                    deleted = deleted.saturating_add(1);
                    self.clear_lease_expiry_error_log(&name).await;
                }
                Ok(CleanupOutcome::SkippedNotExpired) => {
                    failed = failed.saturating_add(1);
                    warn!(vm = name, "skipping vm prune due to non-expired lease");
                }
                Err(e) => {
                    failed = failed.saturating_add(1);
                    warn!(vm = name, error = %e, "failed to prune tracked vm");
                }
            }
        }

        PruneVmsResponse {
            requested,
            deleted,
            failed,
        }
    }

    async fn clear_lease_expiry_error_log(&self, name: &str) {
        let mut lease_expiry_error_log = self.inner.lease_expiry_error_log.write().await;
        lease_expiry_error_log.remove(name);
    }

    async fn log_lease_expiry_error(&self, name: &str, err: &anyhow::Error) {
        let signature = error_chain_to_string(err);
        let now_s = now_unix_s();

        let should_log = {
            let mut lease_expiry_error_log = self.inner.lease_expiry_error_log.write().await;
            let prev = lease_expiry_error_log.get(name);
            let (should_log, next_state) =
                next_lease_expiry_error_log_state(prev, &signature, now_s);
            lease_expiry_error_log.insert(name.to_string(), next_state);
            should_log
        };

        if should_log {
            warn!(
                error = %signature,
                vm = name,
                "failed to clean up lease-expired vm"
            );
        }
    }
}

struct RunCreateInput<'a> {
    name: &'a str,
    image_key: &'a str,
    runtime: &'a CreateScenarioVmRuntime,
    tap: &'a str,
    ch_socket_path: &'a Path,
    ch_stderr_path: &'a Path,
    kino_vsock_cid: u32,
    kino_vsock_port: u32,
    kino_host_ready_port: u32,
    kino_vsock_path: &'a Path,
    vcpus: u32,
    memory_mib: u32,
    disk_mib: Option<u32>,
    hostname: &'a str,
    mac: &'a str,
    root_disk_path: &'a Path,
    config_disk_path: &'a Path,
    recording_disk_path: &'a Path,
    network: &'a CreateVmNetwork,
    bridge_name: &'a str,
}

struct CloudHypervisorVmConfigInput<'a> {
    name: &'a str,
    cached_image: &'a image_cache::CachedImage,
    vcpus: u32,
    memory_mib: u32,
    tap: &'a str,
    mac: &'a str,
    root_disk_path: &'a Path,
    config_disk_path: &'a Path,
    recording_disk_path: &'a Path,
    kino_vsock_cid: u32,
    kino_vsock_path: &'a Path,
}

fn build_cloud_hypervisor_vm_config(input: CloudHypervisorVmConfigInput<'_>) -> Result<VmConfig> {
    let vm_dir = input
        .root_disk_path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("root disk path has no parent"))?;

    Ok(VmConfig {
        cpus: Some(CpusConfig {
            boot_vcpus: input.vcpus,
            max_vcpus: input.vcpus,
        }),
        memory: Some(MemoryConfig {
            size: (input.memory_mib as i64) * 1024 * 1024,
        }),
        payload: PayloadConfig {
            kernel: Some(input.cached_image.kernel_path.display().to_string()),
            initramfs: Some(input.cached_image.initrd_path.display().to_string()),
            cmdline: Some(input.cached_image.cmdline.clone()),
            ..PayloadConfig::default()
        },
        serial: Some(SerialConfig {
            file: Some(vm_dir.join("serial.log").display().to_string()),
            mode: "File".to_string(),
            iommu: false,
            socket: None,
        }),
        console: Some(ConsoleConfig {
            file: Some(vm_dir.join("console.log").display().to_string()),
            mode: "File".to_string(),
            iommu: false,
            socket: None,
        }),
        disks: Some(vec![
            DiskConfig {
                path: input.root_disk_path.display().to_string(),
                readonly: false,
                id: Some(format!("{}-root", input.name)),
                image_type: Some(DiskImageType::Raw),
            },
            DiskConfig {
                path: input.config_disk_path.display().to_string(),
                readonly: true,
                id: Some(format!("{}-{RUNTIME_DISK_ID_SUFFIX}", input.name)),
                image_type: Some(DiskImageType::Raw),
            },
            DiskConfig {
                path: input.recording_disk_path.display().to_string(),
                readonly: false,
                id: Some(format!("{}-recordings", input.name)),
                image_type: Some(DiskImageType::Raw),
            },
        ]),
        net: Some(vec![NetConfig {
            tap: input.tap.to_string(),
            mac: Some(input.mac.to_string()),
            ip: None,
            mask: None,
        }]),
        vsock: Some(VsockConfig {
            cid: u64::from(input.kino_vsock_cid),
            socket: input.kino_vsock_path.display().to_string(),
            iommu: false,
            pci_segment: None,
            id: Some(format!("{}-kino-vsock", input.name)),
        }),
    })
}

async fn run_create(inner: &Arc<Inner>, req: RunCreateInput<'_>) -> Result<()> {
    set_state(inner, req.name, VmLifecycleState::CachingImage).await;

    let cache_root =
        image_cache::default_cache_root().context("failed to determine image cache root")?;
    let cached_image = image_cache::ensure_cached_image(
        req.image_key,
        &inner.image_registry,
        Some(&inner.bridge),
        &cache_root,
        &inner.http,
    )
    .await
    .context("failed to ensure image and boot artifacts are cached")?;
    let base_path = cached_image.raw_path.clone();
    ensure_create_not_deleted(inner, req.name).await?;

    set_state(inner, req.name, VmLifecycleState::PreparingDisks).await;

    info!(
        base_path = %base_path.display(),
        root_path = %req.root_disk_path.display(),
        "creating CoW root disk from cached raw image"
    );
    let base_virtual_size_bytes = cached_image.virtual_size_bytes;

    copy_root_disk_reflink(&base_path, req.root_disk_path)
        .await
        .context("failed to create root disk from cached raw image")?;

    if let Some(target_disk_mib) = req.disk_mib {
        let target_bytes = u64::from(target_disk_mib) * 1024 * 1024;
        if target_bytes < base_virtual_size_bytes {
            anyhow::bail!(
                "requested disk_mib {} MiB is smaller than the base image size {} MiB",
                target_disk_mib,
                base_virtual_size_bytes / (1024 * 1024)
            );
        }
        if target_bytes > base_virtual_size_bytes {
            tokio::fs::OpenOptions::new()
                .write(true)
                .open(req.root_disk_path)
                .await
                .with_context(|| format!("failed to open {}", req.root_disk_path.display()))?
                .set_len(target_bytes)
                .await
                .context("failed to resize root disk")?;
        }
    }
    ensure_create_not_deleted(inner, req.name).await?;

    let runtime = req.runtime;
    info!(
        path = %req.config_disk_path.display(),
        "writing scenario runtime disk"
    );
    let config_disk_path = req.config_disk_path.to_path_buf();
    let ssh_authorized_keys_openssh = runtime.ssh_authorized_keys_openssh.clone();
    let kino_vsock_cid = req.kino_vsock_cid;
    let kino_vsock_port = req.kino_vsock_port;
    let kino_host_ready_port = req.kino_host_ready_port;
    let network = req.network.clone();
    let hostname = req.hostname.to_string();
    tokio::task::spawn_blocking(move || {
        runtime_disk::write_runtime_disk(&runtime_disk::RuntimeDiskInput {
            path: &config_disk_path,
            ssh_authorized_keys_openssh: &ssh_authorized_keys_openssh,
            kino_vsock_cid,
            kino_vsock_port,
            kino_host_ready_port,
            hostname: &hostname,
            network: &network,
        })
    })
    .await
    .context("scenario runtime disk task panicked")?
    .context("failed to write scenario runtime disk")?;
    ensure_create_not_deleted(inner, req.name).await?;

    set_state(inner, req.name, VmLifecycleState::CreatingVm).await;

    ensure_tap_ready(req.bridge_name, req.tap).await?;
    ensure_create_not_deleted(inner, req.name).await?;

    let vm_cfg = build_cloud_hypervisor_vm_config(CloudHypervisorVmConfigInput {
        name: req.name,
        cached_image: &cached_image,
        vcpus: req.vcpus,
        memory_mib: req.memory_mib,
        tap: req.tap,
        mac: req.mac,
        root_disk_path: req.root_disk_path,
        config_disk_path: req.config_disk_path,
        recording_disk_path: req.recording_disk_path,
        kino_vsock_cid: req.kino_vsock_cid,
        kino_vsock_path: req.kino_vsock_path,
    })?;

    let ch_pid =
        spawn_cloud_hypervisor(&inner.ch_binary, req.ch_socket_path, req.ch_stderr_path).await?;
    {
        let persisted = {
            let mut states = inner.states.write().await;
            let Some(vm) = states.get_mut(req.name) else {
                return Ok(());
            };
            if let Some(details) = vm.details.as_mut() {
                details.ch_pid = Some(ch_pid);
            }
            vm.clone()
        };
        if let Err(e) = inner.db.upsert_vm(persisted.to_db_row()).await {
            warn!(error = %e, vm = req.name, "failed to persist vm runtime pid");
        }
    }

    let ch = wait_for_ch_ready(req.ch_socket_path, inner.ch_spawn_timeout_seconds).await?;

    debug!("calling cloud-hypervisor vm.create");
    ch.vm_create(&vm_cfg)
        .await
        .context("cloud-hypervisor vm.create failed")?;

    set_state(inner, req.name, VmLifecycleState::BootingVm).await;

    debug!("calling cloud-hypervisor vm.boot");
    ch.vm_boot()
        .await
        .context("cloud-hypervisor vm.boot failed")?;
    ensure_create_not_deleted(inner, req.name).await?;

    let details = VmDetails {
        run_id: {
            let states = inner.states.read().await;
            states
                .get(req.name)
                .and_then(|vm| vm.details.as_ref())
                .and_then(|details| details.run_id.clone())
        },
        root_disk_path: req.root_disk_path.display().to_string(),
        seed_disk_path: req.config_disk_path.display().to_string(),
        recording_disk_path: Some(req.recording_disk_path.display().to_string()),
        spool_dir: {
            let states = inner.states.read().await;
            states
                .get(req.name)
                .and_then(|vm| vm.details.as_ref())
                .and_then(|details| details.spool_dir.clone())
        },
        mac: req.mac.to_string(),
        guest_ip: Some(extract_guest_ip(&req.network.guest_ip_cidr)?),
        guest_ip_cidr: Some(req.network.guest_ip_cidr.clone()),
        gateway: Some(req.network.gateway.clone()),
        bridge_name: Some(req.bridge_name.to_string()),
        ssh_public_port: {
            let states = inner.states.read().await;
            states
                .get(req.name)
                .and_then(|vm| vm.details.as_ref())
                .and_then(|details| details.ssh_public_port)
        },
        tap_name: Some(req.tap.to_string()),
        ch_socket_path: Some(req.ch_socket_path.display().to_string()),
        ch_pid: None,
        kino_vsock_cid: Some(req.kino_vsock_cid),
        kino_vsock_port: Some(req.kino_vsock_port),
        kino_vsock_path: Some(req.kino_vsock_path.display().to_string()),
        ssh_host_keys_openssh: current_ssh_host_keys(inner, req.name).await,
    };
    let ready = wait_for_scenario_runtime_ready(inner, req.name, &ch, &details)
        .await
        .context("scenario runtime did not become ready")?;
    persist_probe_update(inner, &ready).await;
    let _ = inner.probe_updates_tx.send(ready);
    ensure_create_not_deleted(inner, req.name).await?;
    set_state(inner, req.name, VmLifecycleState::Running).await;
    publish_terminal_state_update(inner, req.name, false).await;
    start_terminal_worker(inner, req.name)
        .await
        .context("failed to start vm terminal worker")?;
    start_probe_worker(inner, req.name, &details)
        .await
        .context("failed to start vm probe worker")?;
    info!("vm booted");

    Ok(())
}

async fn copy_root_disk_reflink(src: &Path, dest: &Path) -> Result<()> {
    if let Err(error) = tokio::fs::remove_file(dest).await
        && error.kind() != std::io::ErrorKind::NotFound
    {
        return Err(error)
            .with_context(|| format!("failed to remove stale root disk {}", dest.display()));
    }

    let reflink = Command::new("cp")
        .arg("--reflink=always")
        .arg("--sparse=always")
        .arg(src)
        .arg(dest)
        .output()
        .await
        .context("failed to execute cp --reflink=always")?;
    if reflink.status.success() {
        info!(
            src = %src.display(),
            dest = %dest.display(),
            "created reflink root disk"
        );
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&reflink.stderr).trim().to_string();
    warn!(
        src = %src.display(),
        dest = %dest.display(),
        error = %stderr,
        "root disk reflink failed; falling back to sparse copy"
    );

    let sparse = Command::new("cp")
        .arg("--sparse=always")
        .arg(src)
        .arg(dest)
        .output()
        .await
        .context("failed to execute cp --sparse=always")?;
    if !sparse.status.success() {
        let stderr = String::from_utf8_lossy(&sparse.stderr).trim().to_string();
        anyhow::bail!("cp --sparse=always failed: {stderr}");
    }

    Ok(())
}

async fn wait_for_scenario_runtime_ready(
    inner: &Arc<Inner>,
    vm_name: &str,
    ch: &ChClient,
    details: &VmDetails,
) -> Result<ProbeUpdateEnvelope> {
    let run_id = details
        .run_id
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("vm details missing run_id"))?;
    let kino_vsock_path = details
        .kino_vsock_path
        .as_ref()
        .map(PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("vm details missing kino_vsock_path"))?;
    let deadline = Instant::now() + Duration::from_secs(SCENARIO_READY_TIMEOUT_SECONDS);
    let mut saw_kino_vsock_socket = false;
    let mut updates = inner.probe_updates_tx.subscribe();
    let mut ch_interval =
        tokio::time::interval(Duration::from_millis(SCENARIO_READY_POLL_INTERVAL_MILLIS));
    ch_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_error = None;

    loop {
        ensure_create_not_deleted(inner, vm_name).await?;

        tokio::select! {
            update = updates.recv() => {
                match update {
                    Ok(update) if update.vm_name == vm_name && update.run_id == run_id => {
                        if update.collection_state == ProbeCollectionState::Ok {
                            return Ok(update);
                        }
                        last_error = Some(anyhow::anyhow!(
                            update.collection_error.unwrap_or_else(|| "Kino readiness push reported an error".to_string())
                        ));
                    }
                    Ok(_) => {}
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        debug!(vm = vm_name, skipped, "lagged while waiting for Kino readiness push");
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        anyhow::bail!("Kino readiness update channel closed");
                    }
                }
            }
            _ = ch_interval.tick() => {
                let socket_exists = kino_vsock_path.exists();
                if socket_exists && !saw_kino_vsock_socket {
                    info!(
                        vm = vm_name,
                        path = %kino_vsock_path.display(),
                        "cloud-hypervisor created Kino vsock socket"
                    );
                    saw_kino_vsock_socket = true;
                }

                match ch.vm_info().await {
                    Ok(info) => {
                        if matches!(info.state, cloud_hypervisor_client::VmState::Shutdown) {
                            stop_booting_vm(inner, vm_name).await;
                            anyhow::bail!("scenario vm shut down before runtime became ready");
                        }
                    }
                    Err(cloud_hypervisor_client::Error::HttpStatus { status: 404, .. }) => {
                        stop_booting_vm(inner, vm_name).await;
                        anyhow::bail!("scenario vm disappeared before runtime became ready");
                    }
                    Err(error) => {
                        debug!(
                            vm = vm_name,
                            error = %error,
                            "cloud-hypervisor vm_info failed while waiting for scenario readiness"
                        );
                    }
                }

                if Instant::now() >= deadline {
                    stop_booting_vm(inner, vm_name).await;
                    let error = last_error.unwrap_or_else(|| {
                        anyhow::anyhow!(
                            "timed out waiting for Kino readiness push on host vsock port {KINO_HOST_READY_PORT}"
                        )
                    });
                    return Err(error).context(scenario_runtime_timeout_context(
                        &kino_vsock_path,
                        saw_kino_vsock_socket,
                    ));
                }
            }
        }
    }
}

async fn stop_booting_vm(inner: &Arc<Inner>, vm_name: &str) {
    let details = {
        let states = inner.states.read().await;
        states
            .get(vm_name)
            .and_then(|vm| vm.details.as_ref())
            .cloned()
    };

    if let Some(details) = details.as_ref() {
        stop_cloud_hypervisor(details, vm_name).await;
    }
}

async fn cleanup_tracked_vm(
    inner: &Inner,
    name: &str,
    require_expired: bool,
) -> Result<CleanupOutcome> {
    cleanup_tracked_vm_with_mode(inner, name, require_expired, CleanupMode::ArchiveArtifacts).await
}

async fn cleanup_tracked_vm_local_only(inner: &Inner, name: &str) -> Result<CleanupOutcome> {
    cleanup_tracked_vm_with_mode(inner, name, false, CleanupMode::LocalOnly).await
}

fn spawn_vm_cleanup_task(inner: Arc<Inner>, name: String, require_expired: bool) {
    tokio::spawn(async move {
        match cleanup_tracked_vm(&inner, &name, require_expired).await {
            Ok(CleanupOutcome::Deleted | CleanupOutcome::Missing) => {}
            Ok(CleanupOutcome::SkippedNotExpired) => {
                warn!(
                    vm = name,
                    "skipped queued vm cleanup because the lease is still active"
                );
            }
            Err(error) => {
                warn!(error = %error, vm = name, "queued vm cleanup failed");
            }
        }
    });
}

async fn cleanup_tracked_vm_with_mode(
    inner: &Inner,
    name: &str,
    require_expired: bool,
    cleanup_mode: CleanupMode,
) -> Result<CleanupOutcome> {
    let _cleanup_guard = acquire_vm_cleanup_lock(inner, name).await;
    let vm = {
        let states = inner.states.read().await;
        states.get(name).cloned()
    };
    let Some(vm) = vm else {
        return Ok(CleanupOutcome::Missing);
    };

    if require_expired && !vm.is_expired(now_unix_s()) {
        return Ok(CleanupOutcome::SkippedNotExpired);
    }

    if cleanup_mode == CleanupMode::ArchiveArtifacts {
        set_state(inner, &vm.name, VmLifecycleState::DeletingVm).await;
    }

    if cleanup_mode == CleanupMode::LocalOnly {
        teardown_vm_runtime(inner, &vm).await;
        local_cleanup_tracked_vm(inner, &vm, true).await;
        return Ok(CleanupOutcome::Deleted);
    }

    let prepared = match prepare_vm_for_delete(inner, &vm).await {
        Ok(prepared) => prepared,
        Err(e) => {
            let message = error_chain_to_string(&e);
            mark_vm_delete_failed(inner, &vm.name, message).await;
            return Err(e);
        }
    };

    if inner.bridge.enabled {
        set_state(inner, &vm.name, VmLifecycleState::ArchivingArtifacts).await;
        if let Err(e) = queue_archive_job(inner, &prepared).await {
            let message = error_chain_to_string(&e);
            mark_vm_delete_failed(inner, &vm.name, message).await;
            return Err(e);
        }
        local_cleanup_tracked_vm(inner, &vm, false).await;
        return Ok(CleanupOutcome::Deleted);
    }

    local_cleanup_tracked_vm(inner, &vm, true).await;
    Ok(CleanupOutcome::Deleted)
}

async fn reconcile_tracked_vm_on_startup(
    inner: &Arc<Inner>,
    name: &str,
) -> Result<StartupReconcileOutcome> {
    let vm = {
        let states = inner.states.read().await;
        states.get(name).cloned()
    };
    let Some(vm) = vm else {
        return Ok(StartupReconcileOutcome::DroppedStale);
    };

    match detect_tracked_vm_runtime(inner, &vm).await? {
        TrackedVmRuntimeStatus::Live(live_state) => {
            if should_resume_live_vm_on_startup(vm.state) {
                resume_tracked_vm_on_startup(inner, vm, live_state).await?;
                Ok(StartupReconcileOutcome::ResumingReadiness)
            } else {
                let cleanup_mode = startup_cleanup_mode(&vm);
                match cleanup_mode {
                    StartupCleanupMode::Archive => {
                        let _ = cleanup_tracked_vm(inner, &vm.name, false).await?;
                        Ok(StartupReconcileOutcome::ArchivedStale)
                    }
                    StartupCleanupMode::DropLocal => {
                        let _ = cleanup_tracked_vm_local_only(inner, &vm.name).await?;
                        Ok(StartupReconcileOutcome::DroppedStale)
                    }
                }
            }
        }
        TrackedVmRuntimeStatus::Dead => {
            let cleanup_mode = startup_cleanup_mode(&vm);
            match cleanup_mode {
                StartupCleanupMode::Archive => {
                    let _ = cleanup_tracked_vm(inner, &vm.name, false).await?;
                    Ok(StartupReconcileOutcome::ArchivedStale)
                }
                StartupCleanupMode::DropLocal => {
                    let _ = cleanup_tracked_vm_local_only(inner, &vm.name).await?;
                    Ok(StartupReconcileOutcome::DroppedStale)
                }
            }
        }
        TrackedVmRuntimeStatus::Inconclusive => {
            let details = vm.details.as_ref();
            let pid = details.and_then(|value| value.ch_pid);
            let socket = details.and_then(|value| value.ch_socket_path.as_deref());
            let message = if let Some(pid) = pid {
                format!("startup reconcile could not reattach to live cloud-hypervisor pid {pid}")
            } else if let Some(socket) = socket {
                format!("startup reconcile could not reattach to cloud-hypervisor at {socket}")
            } else {
                "startup reconcile could not determine vm runtime state".to_string()
            };
            mark_vm_failed(inner, &vm.name, message).await;
            Ok(StartupReconcileOutcome::KeptInconclusive)
        }
    }
}

fn should_resume_live_vm_on_startup(state: VmLifecycleState) -> bool {
    matches!(
        state,
        VmLifecycleState::BootingVm | VmLifecycleState::Running
    )
}

fn startup_resume_reenters_booting(state: VmLifecycleState) -> bool {
    matches!(state, VmLifecycleState::BootingVm)
}

fn startup_cleanup_mode(vm: &VmStatusResponse) -> StartupCleanupMode {
    match vm.state {
        VmLifecycleState::Running
        | VmLifecycleState::DeletingVm
        | VmLifecycleState::ArchivingArtifacts
        | VmLifecycleState::DeleteFailed => StartupCleanupMode::Archive,
        VmLifecycleState::Queued
        | VmLifecycleState::CachingImage
        | VmLifecycleState::PreparingDisks
        | VmLifecycleState::CreatingVm
        | VmLifecycleState::BootingVm
        | VmLifecycleState::Failed => StartupCleanupMode::DropLocal,
    }
}

async fn detect_tracked_vm_runtime(
    inner: &Arc<Inner>,
    vm: &VmStatusResponse,
) -> Result<TrackedVmRuntimeStatus> {
    let Some(details) = vm.details.as_ref() else {
        return Ok(TrackedVmRuntimeStatus::Dead);
    };

    if let Some(ch_socket_path) = details.ch_socket_path.as_deref()
        && Path::new(ch_socket_path).exists()
    {
        match ChClient::new(ch_socket_path.to_string()) {
            Ok(client) => {
                if client.ping().await.is_ok() {
                    return match client.vm_info().await {
                        Ok(info) => match info.state {
                            cloud_hypervisor_client::VmState::Created => {
                                Ok(TrackedVmRuntimeStatus::Live(TrackedVmLiveState::Created))
                            }
                            cloud_hypervisor_client::VmState::Running => {
                                Ok(TrackedVmRuntimeStatus::Live(TrackedVmLiveState::Running))
                            }
                            cloud_hypervisor_client::VmState::Paused => {
                                Ok(TrackedVmRuntimeStatus::Live(TrackedVmLiveState::Paused))
                            }
                            cloud_hypervisor_client::VmState::Shutdown => {
                                Ok(TrackedVmRuntimeStatus::Dead)
                            }
                        },
                        Err(cloud_hypervisor_client::Error::HttpStatus { status: 404, .. }) => {
                            Ok(TrackedVmRuntimeStatus::Dead)
                        }
                        Err(error) => {
                            warn!(
                                vm = vm.name,
                                socket = ch_socket_path,
                                error = %error,
                                "cloud-hypervisor vm_info was inconclusive during startup reconcile"
                            );
                            Ok(TrackedVmRuntimeStatus::Inconclusive)
                        }
                    };
                }
            }
            Err(error) => {
                warn!(
                    vm = vm.name,
                    socket = ch_socket_path,
                    error = %error,
                    "failed to create cloud-hypervisor client during startup reconcile"
                );
            }
        }
    }

    if let Some(ch_pid) = details.ch_pid
        && process_looks_like(ch_pid, &inner.ch_binary).await?
    {
        return Ok(TrackedVmRuntimeStatus::Inconclusive);
    }

    Ok(TrackedVmRuntimeStatus::Dead)
}

async fn resume_tracked_vm_on_startup(
    inner: &Arc<Inner>,
    vm: VmStatusResponse,
    live_state: TrackedVmLiveState,
) -> Result<()> {
    let details = vm
        .details
        .clone()
        .ok_or_else(|| anyhow::anyhow!("vm {} has no details to resume", vm.name))?;
    let ch_socket_path = details
        .ch_socket_path
        .clone()
        .ok_or_else(|| anyhow::anyhow!("vm {} missing cloud-hypervisor socket", vm.name))?;

    if startup_resume_reenters_booting(vm.state) {
        set_state(inner, &vm.name, VmLifecycleState::BootingVm).await;
    }
    stop_probe_worker(inner, &vm.name).await;
    stop_terminal_worker(inner, &vm.name).await;

    let inner_for_task = Arc::clone(inner);
    let vm_name = vm.name.clone();
    tokio::spawn(async move {
        let result = async {
            let ch = wait_for_ch_ready(
                Path::new(&ch_socket_path),
                inner_for_task.ch_spawn_timeout_seconds,
            )
            .await
            .with_context(|| {
                format!(
                    "failed to reconnect to cloud-hypervisor at {}",
                    ch_socket_path
                )
            })?;

            if live_state == TrackedVmLiveState::Created {
                debug!(vm = vm_name, "restarting boot for startup-recovered vm");
                ch.vm_boot()
                    .await
                    .context("cloud-hypervisor vm.boot failed during startup resume")?;
            }

            let ready =
                wait_for_scenario_runtime_ready(&inner_for_task, &vm_name, &ch, &details).await?;
            persist_probe_update(&inner_for_task, &ready).await;
            let _ = inner_for_task.probe_updates_tx.send(ready);
            set_state(&inner_for_task, &vm_name, VmLifecycleState::Running).await;
            publish_terminal_state_update(&inner_for_task, &vm_name, false).await;
            start_terminal_worker(&inner_for_task, &vm_name)
                .await
                .context("failed to restart vm terminal worker after startup resume")?;
            start_probe_worker(&inner_for_task, &vm_name, &details)
                .await
                .context("failed to restart vm probe worker after startup resume")?;
            Ok::<(), anyhow::Error>(())
        }
        .await;

        if take_delete_request(&inner_for_task, &vm_name).await {
            stop_booting_vm(&inner_for_task, &vm_name).await;
            match cleanup_tracked_vm(&inner_for_task, &vm_name, false).await {
                Ok(_) => {
                    info!(
                        vm = vm_name,
                        "cleaned up vm after delete request during startup resume"
                    );
                }
                Err(error) => {
                    let err = error_chain_to_string(&error);
                    error!(
                        error = %err,
                        error_debug = ?error,
                        vm = vm_name,
                        "failed to clean up vm after delete request during startup resume"
                    );
                    mark_vm_failed(&inner_for_task, &vm_name, err).await;
                }
            }
            return;
        }

        if let Err(error) = result {
            let err = error_chain_to_string(&error);
            stop_booting_vm(&inner_for_task, &vm_name).await;
            error!(
                error = %err,
                error_debug = ?error,
                vm = vm_name,
                "failed to resume vm readiness on startup"
            );
            mark_vm_failed(&inner_for_task, &vm_name, err).await;
        }
    });

    Ok(())
}

#[derive(Debug, Clone)]
struct PreparedVmDeletion {
    run_id: String,
    vm_name: String,
    vm_created_at_ms: i64,
    delete_requested_at_ms: i64,
    deleted_at_ms: i64,
    artifacts_dir: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunUploadBeginRequest {
    run_id: String,
    vm_name: String,
    created_at_ms: i64,
    delete_requested_at_ms: i64,
    deleted_at_ms: i64,
    artifacts: Vec<RunUploadArtifactDescriptor>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunUploadArtifactDescriptor {
    ordinal: u32,
    kind: String,
    filename: String,
    content_type: String,
    size_bytes: u64,
    sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MultipartBeginResponse {
    done: bool,
    next_expected_part: u32,
}

#[derive(Debug, Clone)]
struct LocalArtifact {
    ordinal: u32,
    kind: String,
    filename: String,
    content_type: String,
    size_bytes: u64,
    sha256: String,
    path: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArchiveUploadOutcome {
    Uploaded,
    DiscardedMissingRemote,
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
}

async fn queue_archive_job(inner: &Inner, prepared: &PreparedVmDeletion) -> Result<()> {
    let now = now_unix_ms();
    inner
        .db
        .upsert_archive_job(ArchiveJobRow {
            run_id: prepared.run_id.clone(),
            vm_name: prepared.vm_name.clone(),
            vm_created_at_ms: prepared.vm_created_at_ms,
            delete_requested_at_ms: prepared.delete_requested_at_ms,
            deleted_at_ms: prepared.deleted_at_ms,
            artifacts_dir: prepared.artifacts_dir.display().to_string(),
            next_attempt_at_ms: now,
            retry_count: 0,
            last_error: None,
            created_at_ms: now,
            updated_at_ms: now,
        })
        .await
        .context("failed to persist archive job")?;
    Ok(())
}

async fn retry_archive_jobs(inner: &Inner) -> Result<()> {
    let _guard = inner.archive_jobs_lock.lock().await;
    let jobs = inner
        .db
        .load_due_archive_jobs(now_unix_ms(), ARCHIVE_JOB_BATCH_SIZE)
        .await
        .context("failed to load due archive jobs")?;

    for job in jobs {
        process_archive_job(inner, job).await?;
    }

    Ok(())
}

async fn process_archive_job(inner: &Inner, job: ArchiveJobRow) -> Result<()> {
    match upload_archive_job(inner, &job).await {
        Ok(outcome) => {
            inner
                .db
                .delete_archive_job(job.run_id.clone(), job.vm_name.clone())
                .await
                .context("failed to delete completed archive job")?;
            if let Err(error) = delete_archive_spool(&job.artifacts_dir).await {
                warn!(
                    error = %error,
                    vm = job.vm_name,
                    run_id = job.run_id,
                    path = job.artifacts_dir,
                    "failed to delete archive spool after upload"
                );
            }
            match outcome {
                ArchiveUploadOutcome::Uploaded => {
                    info!(
                        vm = job.vm_name,
                        run_id = job.run_id,
                        "uploaded archived vm artifacts"
                    );
                }
                ArchiveUploadOutcome::DiscardedMissingRemote => {
                    info!(
                        vm = job.vm_name,
                        run_id = job.run_id,
                        "discarded archived vm artifacts because the remote run/vm no longer exists"
                    );
                }
            }
        }
        Err(error) => {
            let retry_count = job.retry_count.saturating_add(1);
            let next_attempt_at_ms = archive_retry_at(now_unix_ms(), retry_count);
            let message = error_chain_to_string(&error);
            inner
                .db
                .update_archive_job_retry(
                    job.run_id.clone(),
                    job.vm_name.clone(),
                    next_attempt_at_ms,
                    retry_count,
                    Some(message.clone()),
                    now_unix_ms(),
                )
                .await
                .context("failed to update archive job retry state")?;
            warn!(
                error = %message,
                vm = job.vm_name,
                run_id = job.run_id,
                retry_count,
                next_attempt_at_ms,
                "archive job failed and will be retried"
            );
        }
    }

    Ok(())
}

async fn upload_archive_job(inner: &Inner, job: &ArchiveJobRow) -> Result<ArchiveUploadOutcome> {
    let prepared = PreparedVmDeletion {
        run_id: job.run_id.clone(),
        vm_name: job.vm_name.clone(),
        vm_created_at_ms: job.vm_created_at_ms,
        delete_requested_at_ms: job.delete_requested_at_ms,
        deleted_at_ms: job.deleted_at_ms,
        artifacts_dir: PathBuf::from(&job.artifacts_dir),
    };
    upload_vm_run_artifacts(inner, &job.vm_name, &prepared).await
}

async fn delete_archive_spool(artifacts_dir: &str) -> Result<()> {
    let artifacts_path = PathBuf::from(artifacts_dir);
    let target = artifacts_path.parent().unwrap_or(artifacts_path.as_path());
    match tokio::fs::remove_dir_all(target).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(anyhow::anyhow!(
            "failed to delete archive spool {}: {error}",
            target.display()
        )),
    }
}

fn archive_retry_at(now_ms: i64, retry_count: i64) -> i64 {
    let exponent = retry_count.saturating_sub(1).clamp(0, 10) as u32;
    let backoff = ARCHIVE_RETRY_BASE_MS
        .saturating_mul(1_i64.checked_shl(exponent).unwrap_or(i64::MAX))
        .min(ARCHIVE_RETRY_MAX_MS);
    now_ms.saturating_add(backoff)
}

async fn prepare_vm_for_delete(inner: &Inner, vm: &VmStatusResponse) -> Result<PreparedVmDeletion> {
    let details = vm
        .details
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("vm {} has no details", vm.name))?;
    let run_id = details
        .run_id
        .clone()
        .ok_or_else(|| anyhow::anyhow!("vm {} details missing run_id", vm.name))?;
    let delete_requested_at_ms = now_unix_ms();

    teardown_vm_runtime(inner, vm).await;

    let spool_dir = details
        .spool_dir
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let work_dir =
                resolve_work_dir(&inner.defaults).unwrap_or_else(|_| PathBuf::from("/tmp"));
            run_spool_dir(&work_dir, &run_id)
        });
    let artifacts_dir = spool_dir.join("artifacts");
    tokio::fs::create_dir_all(&artifacts_dir)
        .await
        .with_context(|| {
            format!(
                "failed to create artifact spool at {}",
                artifacts_dir.display()
            )
        })?;

    copy_vm_log_to_spool(vm, "console.log", &artifacts_dir.join("console.log")).await?;
    copy_vm_log_to_spool(vm, "serial.log", &artifacts_dir.join("serial.log")).await?;
    copy_vm_log_to_spool(
        vm,
        CLOUD_HYPERVISOR_STDERR_LOG_NAME,
        &artifacts_dir.join(CLOUD_HYPERVISOR_STDERR_LOG_NAME),
    )
    .await?;

    if let Some(recording_disk_path) = details.recording_disk_path.as_deref() {
        extract_recordings_to_spool(Path::new(recording_disk_path), &artifacts_dir).await?;
        replay_media::create_primary_replay_cast(&artifacts_dir)
            .await
            .context("failed to build primary replay cast")?;
        if let Err(e) = tokio::fs::remove_file(recording_disk_path).await
            && e.kind() != std::io::ErrorKind::NotFound
        {
            warn!(
                error = %e,
                vm = vm.name,
                path = recording_disk_path,
                "failed to remove extracted recording disk"
            );
        }
    }

    if let Some(vm_dir) = vm_dir_for_status(vm) {
        match tokio::fs::remove_dir_all(&vm_dir).await {
            Ok(()) => {
                info!(vm = vm.name, path = %vm_dir.display(), "deleted vm dir");
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(anyhow::anyhow!(
                    "failed to delete vm dir {}: {e}",
                    vm_dir.display()
                ));
            }
        }
    }

    Ok(PreparedVmDeletion {
        run_id,
        vm_name: vm.name.clone(),
        vm_created_at_ms: vm.created_at_s.saturating_mul(1000),
        delete_requested_at_ms,
        deleted_at_ms: now_unix_ms(),
        artifacts_dir,
    })
}

async fn teardown_vm_runtime(inner: &Inner, vm: &VmStatusResponse) {
    stop_probe_worker(inner, &vm.name).await;
    stop_terminal_worker(inner, &vm.name).await;

    let Some(details) = vm.details.as_ref() else {
        return;
    };

    stop_cloud_hypervisor(details, &vm.name).await;

    if let Some(tap_name) = details.tap_name.as_deref()
        && let Err(e) = destroy_tap(tap_name).await
    {
        warn!(error = %e, vm = vm.name, tap = tap_name, "failed to remove tap device");
    }
}

async fn upload_vm_run_artifacts(
    inner: &Inner,
    vm_name: &str,
    prepared: &PreparedVmDeletion,
) -> Result<ArchiveUploadOutcome> {
    let access_token = bootstrap_agent_access_token(&inner.bridge, &inner.http).await?;
    let artifacts = collect_local_artifacts(&prepared.artifacts_dir).await?;

    let begin_request = RunUploadBeginRequest {
        run_id: prepared.run_id.clone(),
        vm_name: prepared.vm_name.clone(),
        created_at_ms: prepared.vm_created_at_ms,
        delete_requested_at_ms: prepared.delete_requested_at_ms,
        deleted_at_ms: prepared.deleted_at_ms,
        artifacts: artifacts
            .iter()
            .map(|artifact| RunUploadArtifactDescriptor {
                ordinal: artifact.ordinal,
                kind: artifact.kind.clone(),
                filename: artifact.filename.clone(),
                content_type: artifact.content_type.clone(),
                size_bytes: artifact.size_bytes,
                sha256: artifact.sha256.clone(),
            })
            .collect(),
    };

    let begin_url = format!("{}/agent/runs/begin", inner.bridge.base_url);
    let begin_response = inner
        .http
        .post(&begin_url)
        .bearer_auth(&access_token)
        .json(&begin_request)
        .send()
        .await
        .with_context(|| format!("failed to call run begin endpoint at {begin_url}"))?;
    if !begin_response.status().is_success() {
        let status = begin_response.status();
        let body = begin_response.text().await.unwrap_or_default();
        if is_missing_remote_run_vm_begin_response(status, &body) {
            warn!(
                vm = vm_name,
                run_id = prepared.run_id,
                "remote run/vm missing during artifact upload begin; skipping upload and treating vm as orphaned local state"
            );
            return Ok(ArchiveUploadOutcome::DiscardedMissingRemote);
        }
        anyhow::bail!("run begin failed with status {status}: {body}");
    }
    let prepared = prepared.clone();
    let vm_name = vm_name.to_string();
    stream::iter(artifacts.into_iter().map(|artifact| {
        let prepared = prepared.clone();
        let access_token = access_token.clone();
        let vm_name = vm_name.clone();
        async move {
            upload_single_artifact(inner, &prepared, &artifact, &access_token)
                .await
                .with_context(|| format!("failed to upload {} for {}", artifact.filename, vm_name))
        }
    }))
    .buffer_unordered(ARTIFACT_UPLOAD_CONCURRENCY)
    .try_collect::<Vec<_>>()
    .await?;

    let run_id_segment = encode_url_path_segment(&prepared.run_id);
    let vm_name_segment = encode_url_path_segment(&prepared.vm_name);
    let complete_url = format!(
        "{}/agent/runs/{}/vms/{}/complete",
        inner.bridge.base_url, run_id_segment, vm_name_segment
    );
    let response = inner
        .http
        .post(&complete_url)
        .bearer_auth(&access_token)
        .send()
        .await
        .with_context(|| format!("failed to complete run upload at {complete_url}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("run complete failed with status {status}: {body}");
    }

    Ok(ArchiveUploadOutcome::Uploaded)
}

async fn upload_single_artifact(
    inner: &Inner,
    prepared: &PreparedVmDeletion,
    artifact: &LocalArtifact,
    access_token: &str,
) -> Result<()> {
    let run_id_segment = encode_url_path_segment(&prepared.run_id);
    let vm_name_segment = encode_url_path_segment(&prepared.vm_name);
    let begin_url = format!(
        "{}/agent/runs/{}/vms/{}/artifacts/{}/multipart-begin",
        inner.bridge.base_url, run_id_segment, vm_name_segment, artifact.ordinal
    );
    let begin_response = inner
        .http
        .post(&begin_url)
        .bearer_auth(access_token)
        .send()
        .await
        .with_context(|| format!("failed to start artifact upload at {begin_url}"))?;
    if !begin_response.status().is_success() {
        let status = begin_response.status();
        let body = begin_response.text().await.unwrap_or_default();
        anyhow::bail!("artifact begin failed with status {status}: {body}");
    }
    let begin_payload = begin_response
        .json::<MultipartBeginResponse>()
        .await
        .context("failed to decode artifact begin response")?;
    if begin_payload.done {
        return Ok(());
    }

    let mut file = tokio::fs::File::open(&artifact.path)
        .await
        .with_context(|| format!("failed to open artifact {}", artifact.path.display()))?;
    let start_offset = u64::from(begin_payload.next_expected_part.saturating_sub(1))
        * ARTIFACT_UPLOAD_PART_BYTES as u64;
    if start_offset > 0 {
        use tokio::io::AsyncSeekExt as _;
        file.seek(std::io::SeekFrom::Start(start_offset))
            .await
            .with_context(|| format!("failed to seek artifact {}", artifact.path.display()))?;
    }

    let mut part_number = begin_payload.next_expected_part.max(1);
    let mut buffer = vec![0_u8; ARTIFACT_UPLOAD_PART_BYTES];
    loop {
        use tokio::io::AsyncReadExt as _;
        let read = file
            .read(&mut buffer)
            .await
            .with_context(|| format!("failed to read artifact {}", artifact.path.display()))?;
        if read == 0 {
            break;
        }

        let part_url = format!(
            "{}/agent/runs/{}/vms/{}/artifacts/{}/parts/{}",
            inner.bridge.base_url, run_id_segment, vm_name_segment, artifact.ordinal, part_number
        );
        let response = inner
            .http
            .put(&part_url)
            .bearer_auth(access_token)
            .body(buffer[..read].to_vec())
            .send()
            .await
            .with_context(|| format!("failed to upload artifact part at {part_url}"))?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!("artifact part upload failed with status {status}: {body}");
        }
        part_number = part_number.saturating_add(1);
    }

    let complete_url = format!(
        "{}/agent/runs/{}/vms/{}/artifacts/{}/complete",
        inner.bridge.base_url, run_id_segment, vm_name_segment, artifact.ordinal
    );
    let response = inner
        .http
        .post(&complete_url)
        .bearer_auth(access_token)
        .send()
        .await
        .with_context(|| format!("failed to complete artifact upload at {complete_url}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("artifact complete failed with status {status}: {body}");
    }

    Ok(())
}

fn encode_url_path_segment(input: &str) -> String {
    let mut encoded = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(char::from(byte));
            }
            _ => {
                encoded.push('%');
                encoded.push(hex_upper(byte >> 4));
                encoded.push(hex_upper(byte & 0x0f));
            }
        }
    }
    encoded
}

fn hex_upper(nibble: u8) -> char {
    match nibble {
        0..=9 => char::from(b'0' + nibble),
        10..=15 => char::from(b'A' + (nibble - 10)),
        _ => '0',
    }
}

async fn local_cleanup_tracked_vm(inner: &Inner, vm: &VmStatusResponse, remove_spool_dir: bool) {
    clear_delete_request(inner, &vm.name).await;
    stop_terminal_worker(inner, &vm.name).await;

    if let Some(vm_dir) = vm_dir_for_status(vm) {
        match tokio::fs::remove_dir_all(&vm_dir).await {
            Ok(_) => {
                info!(vm = vm.name, path = %vm_dir.display(), "deleted vm dir");
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                error!(error = %e, vm = vm.name, path = %vm_dir.display(), "failed to delete vm dir");
            }
        }
    }

    if let Some(details) = vm.details.as_ref() {
        if let Some(recording_disk_path) = details.recording_disk_path.as_deref()
            && let Err(e) = tokio::fs::remove_file(recording_disk_path).await
            && e.kind() != std::io::ErrorKind::NotFound
        {
            error!(
                error = %e,
                vm = vm.name,
                path = recording_disk_path,
                "failed to delete recording disk"
            );
        }
        if remove_spool_dir
            && let Some(spool_dir) = details.spool_dir.as_deref()
            && let Err(e) = tokio::fs::remove_dir_all(spool_dir).await
            && e.kind() != std::io::ErrorKind::NotFound
        {
            error!(
                error = %e,
                vm = vm.name,
                path = spool_dir,
                "failed to delete run spool dir"
            );
        }
    }

    {
        let mut states = inner.states.write().await;
        states.remove(&vm.name);
    }
    {
        let mut fingerprints = inner.terminal_state_fingerprints.lock().await;
        fingerprints.remove(&vm.name);
    }

    if let Err(e) = inner.db.delete_vm(vm.name.clone()).await {
        error!(error = %e, vm = vm.name, "failed to delete vm row from sqlite");
    }
    if let Err(error) = ensure_vm_network_reconciled(inner).await {
        warn!(
            error = %error,
            vm = vm.name,
            "failed to reconcile ssh forwarding after vm cleanup"
        );
    }

    info!(vm = vm.name, "cleaned up tracked vm");
}

fn is_create_in_progress_state(state: VmLifecycleState) -> bool {
    matches!(
        state,
        VmLifecycleState::Queued
            | VmLifecycleState::CachingImage
            | VmLifecycleState::PreparingDisks
            | VmLifecycleState::CreatingVm
            | VmLifecycleState::BootingVm
    )
}

async fn request_delete(inner: &Inner, name: &str) {
    let mut delete_requests = inner.delete_requests.lock().await;
    delete_requests.insert(name.to_string());
}

async fn take_delete_request(inner: &Inner, name: &str) -> bool {
    let mut delete_requests = inner.delete_requests.lock().await;
    delete_requests.remove(name)
}

async fn clear_delete_request(inner: &Inner, name: &str) {
    let mut delete_requests = inner.delete_requests.lock().await;
    delete_requests.remove(name);
}

async fn acquire_vm_cleanup_lock(inner: &Inner, name: &str) -> OwnedMutexGuard<()> {
    let lock = {
        let mut locks = inner.cleanup_locks.lock().await;
        Arc::clone(
            locks
                .entry(name.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(()))),
        )
    };

    lock.lock_owned().await
}

async fn is_delete_requested(inner: &Inner, name: &str) -> bool {
    let delete_requests = inner.delete_requests.lock().await;
    delete_requests.contains(name)
}

async fn ensure_create_not_deleted(inner: &Inner, name: &str) -> Result<()> {
    if is_delete_requested(inner, name).await {
        anyhow::bail!("vm create cancelled by delete request");
    }
    Ok(())
}

async fn stop_cloud_hypervisor(details: &VmDetails, vm_name: &str) {
    if let Some(ch_socket_path) = details.ch_socket_path.as_deref()
        && Path::new(ch_socket_path).exists()
    {
        match ChClient::new(ch_socket_path.to_string()) {
            Ok(client) => {
                if let Err(e) = client.vm_shutdown().await {
                    warn!(
                        error = %e,
                        vm = vm_name,
                        socket = ch_socket_path,
                        "failed to request cloud-hypervisor shutdown"
                    );
                } else {
                    tokio::time::sleep(Duration::from_secs(DELETE_SHUTDOWN_GRACE_SECONDS)).await;
                }
            }
            Err(e) => {
                warn!(
                    error = %e,
                    vm = vm_name,
                    socket = ch_socket_path,
                    "failed to create cloud-hypervisor client for shutdown"
                );
            }
        }
    }

    if let Some(ch_pid) = details.ch_pid
        && let Err(e) = kill_process_force(ch_pid).await
    {
        warn!(
            error = %e,
            vm = vm_name,
            ch_pid,
            "failed to kill cloud-hypervisor process"
        );
    }
}

async fn copy_vm_log_to_spool(
    vm: &VmStatusResponse,
    source_name: &str,
    destination: &Path,
) -> Result<()> {
    if destination.exists() {
        return Ok(());
    }

    let Some(vm_dir) = vm_dir_for_status(vm) else {
        return Ok(());
    };
    let source = vm_dir.join(source_name);
    match tokio::fs::copy(&source, destination).await {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(anyhow::anyhow!(
            "failed to copy {} to {}: {e}",
            source.display(),
            destination.display()
        )),
    }
}

async fn extract_recordings_to_spool(
    recording_disk_path: &Path,
    artifacts_dir: &Path,
) -> Result<()> {
    if !recording_disk_path.exists() {
        return Ok(());
    }

    let recording_disk_path = recording_disk_path.to_path_buf();
    let artifacts_dir = artifacts_dir.to_path_buf();
    tokio::task::spawn_blocking(move || {
        extract_recordings_to_spool_blocking(&recording_disk_path, &artifacts_dir)
    })
    .await
    .context("recording extraction task panicked")?
}

fn extract_recordings_to_spool_blocking(
    recording_disk_path: &Path,
    artifacts_dir: &Path,
) -> Result<()> {
    std::fs::create_dir_all(artifacts_dir)
        .with_context(|| format!("failed to create artifact dir {}", artifacts_dir.display()))?;
    let image = std::fs::OpenOptions::new()
        .read(true)
        .open(recording_disk_path)
        .with_context(|| {
            format!(
                "failed to open recording disk {}",
                recording_disk_path.display()
            )
        })?;
    let fs = fatfs::FileSystem::new(image, fatfs::FsOptions::new())
        .context("failed to open recording filesystem")?;
    let root = fs.root_dir();
    for entry in root.iter() {
        let entry = entry.context("failed to read recording directory entry")?;
        if !entry.is_file() {
            continue;
        }

        let file_name = entry.file_name();
        if file_name.ends_with(".cast") {
            let destination = artifacts_dir.join(&file_name);
            if destination.exists() {
                continue;
            }

            let mut source = entry.to_file();
            let mut destination_file = std::fs::File::create(&destination)
                .with_context(|| format!("failed to create {}", destination.display()))?;
            std::io::copy(&mut source, &mut destination_file)
                .with_context(|| format!("failed to extract {}", destination.display()))?;
            continue;
        }

        if file_name.ends_with(".krec") {
            let raw_destination = artifacts_dir.join(&file_name);
            if !raw_destination.exists() {
                let mut source = entry.to_file();
                let mut destination_file = std::fs::File::create(&raw_destination)
                    .with_context(|| format!("failed to create {}", raw_destination.display()))?;
                std::io::copy(&mut source, &mut destination_file)
                    .with_context(|| format!("failed to extract {}", raw_destination.display()))?;
            }

            let cast_destination_name = file_name.trim_end_matches(".krec").to_owned() + ".cast";
            let cast_destination = artifacts_dir.join(cast_destination_name);
            if !cast_destination.exists() {
                let source = entry.to_file();
                let destination_file = std::fs::File::create(&cast_destination)
                    .with_context(|| format!("failed to create {}", cast_destination.display()))?;
                kino_recording::convert_raw_recording_to_cast(source, destination_file)
                    .with_context(|| format!("failed to convert {}", cast_destination.display()))?;
            }
        }
    }

    Ok(())
}

async fn collect_local_artifacts(artifacts_dir: &Path) -> Result<Vec<LocalArtifact>> {
    let mut artifacts = Vec::new();
    let mut ordinal = 1_u32;

    let primary_replay_path = artifacts_dir.join(replay_media::PRIMARY_REPLAY_FILENAME);
    if primary_replay_path.exists() {
        artifacts.push(
            describe_local_artifact(
                ordinal,
                replay_media::PRIMARY_REPLAY_KIND,
                &primary_replay_path,
                "application/x-asciicast; charset=utf-8",
            )
            .await?,
        );
        ordinal = ordinal.saturating_add(1);
    }

    for (kind, path, content_type) in [
        (
            "console_log",
            artifacts_dir.join("console.log"),
            "text/plain; charset=utf-8",
        ),
        (
            "serial_log",
            artifacts_dir.join("serial.log"),
            "text/plain; charset=utf-8",
        ),
        (
            "cloud_hypervisor_stderr_log",
            artifacts_dir.join(CLOUD_HYPERVISOR_STDERR_LOG_NAME),
            "text/plain; charset=utf-8",
        ),
    ] {
        if !path.exists() {
            continue;
        }
        artifacts.push(describe_local_artifact(ordinal, kind, &path, content_type).await?);
        ordinal = ordinal.saturating_add(1);
    }

    let mut recording_paths = Vec::new();
    let mut dir = match tokio::fs::read_dir(artifacts_dir).await {
        Ok(dir) => dir,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(artifacts),
        Err(e) => {
            return Err(anyhow::anyhow!(
                "failed to read artifact directory {}: {e}",
                artifacts_dir.display()
            ));
        }
    };
    while let Some(entry) = dir
        .next_entry()
        .await
        .context("failed to iterate artifact dir")?
    {
        let path = entry.path();
        match path.extension().and_then(|ext| ext.to_str()) {
            Some("cast") | Some("krec")
                if path.file_name().and_then(|value| value.to_str())
                    != Some(replay_media::PRIMARY_REPLAY_FILENAME) =>
            {
                recording_paths.push(path)
            }
            _ => {}
        }
    }
    recording_paths.sort_by(|a, b| {
        recording_sort_key(a)
            .cmp(&recording_sort_key(b))
            .then_with(|| a.file_name().cmp(&b.file_name()))
    });

    for path in recording_paths {
        let extension = path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or_default();
        let (kind, content_type) = match extension {
            "cast" => (
                replay_media::REPLAY_SEGMENT_KIND,
                "application/x-asciicast; charset=utf-8",
            ),
            "krec" => (
                "ssh_recording_raw",
                "application/x-kino-raw-event-log; charset=utf-8",
            ),
            _ => continue,
        };
        artifacts.push(describe_local_artifact(ordinal, kind, &path, content_type).await?);
        ordinal = ordinal.saturating_add(1);
    }

    Ok(artifacts)
}

fn recording_sort_key(path: &Path) -> (String, u8) {
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or_default()
        .to_owned();
    let extension_rank = match path.extension().and_then(|ext| ext.to_str()) {
        Some("cast") => 0,
        Some("krec") => 1,
        _ => 2,
    };
    (stem, extension_rank)
}

async fn describe_local_artifact(
    ordinal: u32,
    kind: &str,
    path: &Path,
    content_type: &str,
) -> Result<LocalArtifact> {
    let metadata = tokio::fs::metadata(path)
        .await
        .with_context(|| format!("failed to stat artifact {}", path.display()))?;
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| anyhow::anyhow!("artifact path has no utf-8 filename: {}", path.display()))?
        .to_string();
    let sha256 = sha256_file(path).await?;

    Ok(LocalArtifact {
        ordinal,
        kind: kind.to_string(),
        filename,
        content_type: content_type.to_string(),
        size_bytes: metadata.len(),
        sha256,
        path: path.to_path_buf(),
    })
}

async fn sha256_file(path: &Path) -> Result<String> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut file = std::fs::File::open(&path)
            .with_context(|| format!("failed to open {}", path.display()))?;
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = std::io::Read::read(&mut file, &mut buffer)
                .with_context(|| format!("failed to read {}", path.display()))?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        Ok::<_, anyhow::Error>(base16ct::lower::encode_string(&hasher.finalize()))
    })
    .await
    .context("sha256 file task panicked")?
}

async fn bootstrap_agent_access_token(cfg: &BridgeConfig, http: &HttpClient) -> Result<String> {
    if !cfg.enabled {
        anyhow::bail!("bridge uploads require bridge.enabled = true");
    }
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

    let payload = response
        .json::<AgentBootstrapResponse>()
        .await
        .context("failed to parse bootstrap response")?;
    Ok(payload.access_token)
}

fn vm_dir_for_status(vm: &VmStatusResponse) -> Option<PathBuf> {
    vm.details
        .as_ref()
        .map(|details| PathBuf::from(&details.root_disk_path))
        .and_then(|root_disk_path| root_disk_path.parent().map(Path::to_path_buf))
}

fn is_missing_remote_run_vm_begin_response(status: StatusCode, body: &str) -> bool {
    if status != StatusCode::NOT_FOUND {
        return false;
    }

    body.contains("\"error\":\"run VM not found\"")
        || body.contains("\"error\": \"run VM not found\"")
}

#[cfg(target_os = "linux")]
fn spawn_kino_ready_listener(inner: Arc<Inner>) {
    tokio::spawn(async move {
        if let Err(error) = run_kino_ready_listener(inner).await {
            error!(error = %error, "Kino readiness push listener stopped");
        }
    });
}

#[cfg(not(target_os = "linux"))]
fn spawn_kino_ready_listener(_inner: Arc<Inner>) {
    warn!("Kino readiness push listener is only available on Linux");
}

#[cfg(target_os = "linux")]
async fn run_kino_ready_listener(inner: Arc<Inner>) -> Result<()> {
    use tokio_vsock::{VMADDR_CID_HOST, VsockAddr, VsockListener};

    let listener = VsockListener::bind(VsockAddr::new(VMADDR_CID_HOST, KINO_HOST_READY_PORT))
        .with_context(|| {
            format!("failed to bind Kino readiness listener on vsock port {KINO_HOST_READY_PORT}")
        })?;
    info!(
        port = KINO_HOST_READY_PORT,
        "listening for guest-initiated Kino readiness pushes"
    );

    loop {
        let (stream, peer) = listener
            .accept()
            .await
            .context("failed to accept Kino readiness push connection")?;
        let peer_cid = peer.cid();
        let inner_for_task = Arc::clone(&inner);
        tokio::spawn(async move {
            if let Err(error) = handle_kino_ready_stream(inner_for_task, peer_cid, stream).await {
                warn!(
                    error = %error,
                    peer_cid,
                    "Kino readiness push connection failed"
                );
            }
        });
    }
}

#[cfg(target_os = "linux")]
async fn handle_kino_ready_stream(
    inner: Arc<Inner>,
    peer_cid: u32,
    mut stream: tokio_vsock::VsockStream,
) -> Result<()> {
    use std::io::ErrorKind;
    use tokio::io::AsyncReadExt as _;

    loop {
        let mut len_buf = [0_u8; 4];
        match stream.read_exact(&mut len_buf).await {
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::UnexpectedEof => return Ok(()),
            Err(error) => return Err(error).context("failed to read Kino readiness frame length"),
        }
        let len = u32::from_be_bytes(len_buf) as usize;
        anyhow::ensure!(len > 0, "Kino readiness frame was empty");
        anyhow::ensure!(
            len <= MAX_KINO_READY_FRAME_BYTES,
            "Kino readiness frame too large: {len} bytes"
        );

        let mut frame = vec![0_u8; len];
        stream
            .read_exact(&mut frame)
            .await
            .context("failed to read Kino readiness frame body")?;

        let result = decode_probe_snapshot(&frame)?;
        apply_kino_ready_snapshot(&inner, peer_cid, result).await?;
    }
}

#[cfg(target_os = "linux")]
async fn apply_kino_ready_snapshot(
    inner: &Arc<Inner>,
    peer_cid: u32,
    result: ProbePollResult,
) -> Result<()> {
    let (vm_name, run_id) = vm_identity_for_kino_cid(inner, peer_cid)
        .await
        .ok_or_else(|| anyhow::anyhow!("no tracked VM owns Kino vsock CID {peer_cid}"))?;

    update_vm_ssh_host_keys(inner, &vm_name, result.ssh_host_keys_openssh.clone()).await;
    let update = ProbeUpdateEnvelope::from_poll_result(&vm_name, &run_id, result);
    persist_probe_update(inner, &update).await;
    let _ = inner.probe_updates_tx.send(update);
    Ok(())
}

#[cfg(target_os = "linux")]
async fn vm_identity_for_kino_cid(inner: &Inner, peer_cid: u32) -> Option<(String, String)> {
    let states = inner.states.read().await;
    states.iter().find_map(|(name, vm)| {
        let details = vm.details.as_ref()?;
        (details.kino_vsock_cid == Some(peer_cid)).then(|| {
            let run_id = details.run_id.clone().unwrap_or_default();
            (name.clone(), run_id)
        })
    })
}

#[cfg(target_os = "linux")]
async fn update_vm_ssh_host_keys(inner: &Inner, vm_name: &str, keys: Vec<String>) {
    let keys = normalize_ssh_host_keys(keys);
    if keys.is_empty() {
        return;
    }

    let now_s = now_unix_s();
    let updated_at = format_rfc3339_s(now_s);
    let persisted = {
        let mut states = inner.states.write().await;
        let Some(vm) = states.get_mut(vm_name) else {
            return;
        };
        let Some(details) = vm.details.as_mut() else {
            return;
        };
        if details.ssh_host_keys_openssh == keys {
            return;
        }
        details.ssh_host_keys_openssh = keys;
        vm.updated_at_s = now_s;
        vm.updated_at = updated_at;
        vm.lease_expires_at = compute_lease_expires_at(vm.running_at_s, vm.lease_duration_seconds);
        vm.clone()
    };

    if let Err(error) = inner.db.upsert_vm(persisted.to_db_row()).await {
        warn!(error = %error, vm = vm_name, "failed to persist ssh host keys");
    }
}

async fn start_probe_worker(inner: &Arc<Inner>, vm_name: &str, details: &VmDetails) -> Result<()> {
    let run_id = details
        .run_id
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("vm details missing run_id"))?;
    let kino_vsock_path = details
        .kino_vsock_path
        .as_ref()
        .map(PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("vm details missing kino_vsock_path"))?;
    let kino_vsock_port = details.kino_vsock_port.unwrap_or(KINO_VSOCK_PORT);

    stop_probe_worker(inner, vm_name).await;

    let vm_name_owned = vm_name.to_string();
    let inner_for_task = Arc::clone(inner);
    let join = tokio::spawn(async move {
        run_probe_worker_task(
            inner_for_task,
            vm_name_owned,
            run_id,
            kino_vsock_path,
            kino_vsock_port,
        )
        .await;
    });

    let mut tasks = inner.probe_tasks.lock().await;
    tasks.insert(vm_name.to_string(), VmProbeTask { join });
    Ok(())
}

async fn stop_probe_worker(inner: &Inner, vm_name: &str) {
    let existing = {
        let mut tasks = inner.probe_tasks.lock().await;
        tasks.remove(vm_name)
    };

    if let Some(task) = existing {
        task.join.abort();
    }
}

async fn start_terminal_worker(inner: &Arc<Inner>, vm_name: &str) -> Result<()> {
    let vm = {
        let states = inner.states.read().await;
        states.get(vm_name).cloned()
    }
    .ok_or_else(|| anyhow::anyhow!("vm {vm_name} not found for terminal worker"))?;
    let run_id = vm
        .details
        .as_ref()
        .and_then(|details| details.run_id.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| anyhow::anyhow!("vm details missing run_id"))?;

    stop_terminal_worker(inner, vm_name).await;

    let vm_name_owned = vm_name.to_string();
    let inner_for_task = Arc::clone(inner);
    let join = tokio::spawn(async move {
        run_terminal_worker_task(inner_for_task, vm_name_owned, run_id).await;
    });

    let mut tasks = inner.terminal_tasks.lock().await;
    tasks.insert(vm_name.to_string(), VmTerminalTask { join });
    Ok(())
}

async fn stop_terminal_worker(inner: &Inner, vm_name: &str) {
    let existing = {
        let mut tasks = inner.terminal_tasks.lock().await;
        tasks.remove(vm_name)
    };

    if let Some(task) = existing {
        task.join.abort();
    }
}

async fn run_terminal_worker_task(inner: Arc<Inner>, vm_name: String, run_id: String) {
    let mut ready_seen = false;

    loop {
        let state = match current_terminal_state_for_vm(&inner, &vm_name, Some(&run_id)).await {
            Ok(Some(state)) => state,
            Ok(None) => break,
            Err(error) => {
                warn!(
                    error = %error,
                    vm = vm_name,
                    "failed to compute current terminal state"
                );
                break;
            }
        };

        if state.state == VmTerminalStateKind::Ready {
            ready_seen = true;
        }
        emit_terminal_state_update(&inner, state, false).await;

        let sleep_duration = if ready_seen {
            Duration::from_secs(TERMINAL_READY_POLL_INTERVAL_SECONDS)
        } else {
            Duration::from_millis(TERMINAL_PENDING_POLL_INTERVAL_MILLIS)
        };
        tokio::time::sleep(sleep_duration).await;
    }
}

async fn publish_terminal_state_update(inner: &Inner, vm_name: &str, force: bool) {
    match current_terminal_state_for_vm(inner, vm_name, None).await {
        Ok(Some(state)) => emit_terminal_state_update(inner, state, force).await,
        Ok(None) => {}
        Err(error) => {
            warn!(error = %error, vm = vm_name, "failed to publish terminal state update");
        }
    }
}

async fn emit_terminal_state_update(inner: &Inner, state: VmTerminalState, force: bool) {
    let fingerprint = state.fingerprint();
    let should_send = {
        let mut fingerprints = inner.terminal_state_fingerprints.lock().await;
        let changed = fingerprints
            .get(&state.vm_name)
            .map(|current| current != &fingerprint)
            .unwrap_or(true);
        if force || changed {
            fingerprints.insert(state.vm_name.clone(), fingerprint);
            true
        } else {
            false
        }
    };

    if should_send {
        let _ = inner.terminal_updates_tx.send(state);
    }
}

async fn run_probe_worker_task(
    inner: Arc<Inner>,
    vm_name: String,
    run_id: String,
    _kino_vsock_path: PathBuf,
    _kino_vsock_port: u32,
) {
    match inner.db.load_vm_probe_state(vm_name.clone()).await {
        Ok(Some(row)) if row.run_id == run_id => {
            if let Some(update) = probe_update_from_state_row(&row) {
                let _ = inner.probe_updates_tx.send(update);
            }
        }
        Ok(_) => {}
        Err(error) => {
            warn!(error = %error, vm = vm_name, "failed to load persisted probe state");
        }
    }

    let mut interval = tokio::time::interval(Duration::from_secs(PROBE_POLL_INTERVAL_SECONDS));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        interval.tick().await;

        let should_continue = {
            let states = inner.states.read().await;
            match states.get(&vm_name) {
                Some(vm) => {
                    vm.state == VmLifecycleState::Running
                        && vm
                            .details
                            .as_ref()
                            .and_then(|details| details.run_id.as_ref())
                            .is_some_and(|current| current == &run_id)
                }
                None => false,
            }
        };
        if !should_continue {
            break;
        }
    }
}

async fn persist_probe_update(inner: &Inner, update: &ProbeUpdateEnvelope) {
    let summary_json = match serde_json::to_string(&update.summary) {
        Ok(value) => value,
        Err(error) => {
            warn!(error = %error, vm = update.vm_name, "failed to serialize probe summary");
            return;
        }
    };
    let snapshot_json = match serde_json::to_string(update) {
        Ok(value) => value,
        Err(error) => {
            warn!(error = %error, vm = update.vm_name, "failed to serialize current probe snapshot");
            return;
        }
    };
    let state_row = VmProbeStateRow {
        vm_name: update.vm_name.clone(),
        run_id: update.run_id.clone(),
        fingerprint: update.fingerprint.clone(),
        collection_state: match &update.collection_state {
            ProbeCollectionState::Ok => "ok".to_string(),
            ProbeCollectionState::Error => "error".to_string(),
        },
        collection_error: update.collection_error.clone(),
        summary_json,
        snapshot_json,
        generated_at_ms: update.generated_at_ms,
        updated_at_ms: now_unix_ms(),
    };
    if let Err(error) = inner.db.upsert_vm_probe_state(state_row).await {
        warn!(error = %error, vm = update.vm_name, "failed to persist current probe state");
    }
}

fn probe_snapshot_from_state_row(row: &VmProbeStateRow) -> Option<ProbeSnapshotView> {
    serde_json::from_str::<ProbeSnapshotView>(&row.snapshot_json)
        .ok()
        .or_else(|| {
            serde_json::from_str::<ProbeUpdateEnvelope>(&row.snapshot_json)
                .ok()
                .map(|update| update.snapshot_view())
        })
}

fn probe_update_from_state_row(row: &VmProbeStateRow) -> Option<ProbeUpdateEnvelope> {
    if let Ok(update) = serde_json::from_str::<ProbeUpdateEnvelope>(&row.snapshot_json) {
        return Some(update);
    }

    let snapshot = probe_snapshot_from_state_row(row)?;
    Some(ProbeUpdateEnvelope {
        update_id: format!(
            "replay:{}:{}:{}",
            row.vm_name, row.fingerprint, row.generated_at_ms
        ),
        vm_name: row.vm_name.clone(),
        run_id: row.run_id.clone(),
        generated_at_ms: row.generated_at_ms,
        fingerprint: row.fingerprint.clone(),
        collection_state: match row.collection_state.trim() {
            "ok" => ProbeCollectionState::Ok,
            "error" => ProbeCollectionState::Error,
            _ => return None,
        },
        collection_error: row.collection_error.clone(),
        summary: serde_json::from_str(&row.summary_json).ok()?,
        ssh_host_keys_openssh: Vec::new(),
        probes: snapshot.probes,
    })
}

async fn spawn_cloud_hypervisor(
    binary: &str,
    socket_path: &Path,
    stderr_path: &Path,
) -> Result<u32> {
    if let Err(e) = tokio::fs::remove_file(socket_path).await
        && e.kind() != std::io::ErrorKind::NotFound
    {
        warn!(
            error = %e,
            path = %socket_path.display(),
            "failed to remove stale cloud-hypervisor socket"
        );
    }

    let stderr = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(stderr_path)
        .with_context(|| {
            format!(
                "failed to open cloud-hypervisor stderr log at {}",
                stderr_path.display()
            )
        })?;

    let mut command = Command::new(binary);
    command
        .arg("--api-socket")
        .arg(socket_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr));

    let child = command
        .spawn()
        .with_context(|| format!("failed to spawn {binary}"))?;

    child
        .id()
        .ok_or_else(|| anyhow::anyhow!("spawned cloud-hypervisor process has no pid"))
}

async fn wait_for_ch_ready(socket_path: &Path, timeout_seconds: u64) -> Result<ChClient> {
    let deadline = Instant::now() + Duration::from_secs(timeout_seconds);

    loop {
        if socket_path.exists() {
            let socket = socket_path.display().to_string();
            if let Ok(client) = ChClient::new(socket)
                && client.ping().await.is_ok()
            {
                return Ok(client);
            }
        }

        if Instant::now() >= deadline {
            anyhow::bail!(
                "cloud-hypervisor socket did not become ready in {}s at {}",
                timeout_seconds,
                socket_path.display()
            );
        }

        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn ensure_tap_ready(bridge: &str, tap_name: &str) -> Result<()> {
    let _ = destroy_tap(tap_name).await;

    run_command(
        "ip",
        &["tuntap", "add", "dev", tap_name, "mode", "tap"],
        "create tap device",
    )
    .await?;
    run_command(
        "ip",
        &["link", "set", tap_name, "master", bridge],
        "attach tap to bridge",
    )
    .await?;
    run_command("ip", &["link", "set", tap_name, "up"], "bring tap up").await?;

    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RunNftNetwork {
    run_id: String,
    bridge_name: String,
    subnet_cidr: String,
    gateway: Ipv4Addr,
    prefix: u8,
    ssh_forwards: Vec<SshForwardRule>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SshForwardRule {
    vm_name: String,
    public_port: u16,
    guest_ip: Ipv4Addr,
}

async fn ensure_vm_network_reconciled(inner: &Inner) -> Result<()> {
    let run_networks = collect_run_networks(inner).await?;
    for network in &run_networks {
        ensure_bridge_ready(&network.bridge_name, network.gateway, network.prefix).await?;
    }

    ensure_ipv4_forwarding_enabled().await?;
    let egress_if = detect_default_interface().await?;
    let egress_ipv4 = detect_interface_ipv4(&egress_if).await?;
    if inner.ssh_access.enabled && egress_ipv4.is_none() {
        warn!(
            egress_if,
            "default egress interface has no IPv4 address; SSH DNAT will be constrained by interface only"
        );
    }
    let ruleset = render_vm_nft_ruleset(
        &run_networks,
        &egress_if,
        egress_ipv4,
        inner.ssh_access.enabled,
    );
    apply_vm_nft_ruleset(&ruleset).await?;

    let ssh_forward_count: usize = run_networks
        .iter()
        .map(|network| network.ssh_forwards.len())
        .sum();

    info!(
        run_network_count = run_networks.len(),
        egress_if,
        egress_ipv4 = egress_ipv4.map(|ip| ip.to_string()),
        ssh_forward_count = if inner.ssh_access.enabled {
            ssh_forward_count
        } else {
            0
        },
        "reconciled vm host networking for guest egress and ssh forwarding"
    );
    Ok(())
}

async fn collect_run_networks(inner: &Inner) -> Result<Vec<RunNftNetwork>> {
    let states = inner.states.read().await;
    let mut networks = BTreeMap::<String, RunNftNetwork>::new();

    for vm in states.values() {
        let Some(details) = vm.details.as_ref() else {
            continue;
        };
        let Some(run_id) = details.run_id.as_deref().filter(|value| !value.is_empty()) else {
            continue;
        };
        let Some(bridge_name) = details
            .bridge_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let Some(guest_ip_cidr) = details
            .guest_ip_cidr
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let Some(gateway_raw) = details
            .gateway
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let (guest_ip, prefix) = parse_ipv4_cidr(guest_ip_cidr, "vm.guest_ip_cidr")
            .with_context(|| format!("invalid persisted network for vm {}", vm.name))?;
        if prefix > 30 {
            anyhow::bail!("vm {} has unusable guest subnet prefix /{prefix}", vm.name);
        }
        let gateway = gateway_raw
            .parse::<Ipv4Addr>()
            .with_context(|| format!("vm {} has invalid gateway {gateway_raw}", vm.name))?;
        let subnet = ipv4_network_u32(guest_ip, prefix);
        let subnet_cidr = format!("{}/{prefix}", Ipv4Addr::from(subnet));
        let key = run_id.to_string();

        let entry = networks
            .entry(key.clone())
            .or_insert_with(|| RunNftNetwork {
                run_id: key,
                bridge_name: bridge_name.to_string(),
                subnet_cidr: subnet_cidr.clone(),
                gateway,
                prefix,
                ssh_forwards: Vec::new(),
            });
        if entry.bridge_name != bridge_name
            || entry.subnet_cidr != subnet_cidr
            || entry.gateway != gateway
            || entry.prefix != prefix
        {
            anyhow::bail!(
                "run {run_id} has inconsistent network state across VMs; refusing to render nftables"
            );
        }

        if let Some(public_port) = details.ssh_public_port {
            entry.ssh_forwards.push(SshForwardRule {
                vm_name: vm.name.clone(),
                public_port,
                guest_ip,
            });
        }
    }

    Ok(networks.into_values().collect())
}

async fn ensure_bridge_ready(bridge: &str, gateway: Ipv4Addr, prefix: u8) -> Result<()> {
    let link_status = Command::new("ip")
        .arg("link")
        .arg("show")
        .arg("dev")
        .arg(bridge)
        .output()
        .await
        .context("failed to execute ip link show")?;
    if !link_status.status.success() {
        let stderr = String::from_utf8_lossy(&link_status.stderr)
            .trim()
            .to_string();
        if stderr.contains("does not exist") || stderr.contains("Cannot find device") {
            run_command(
                "ip",
                &["link", "add", bridge, "type", "bridge"],
                "create vm bridge",
            )
            .await?;
            info!(bridge, "created vm bridge");
        } else {
            anyhow::bail!("failed to inspect vm bridge {bridge}: {stderr}");
        }
    }

    let cidr = format!("{gateway}/{prefix}");
    let addr_status = Command::new("ip")
        .arg("-4")
        .arg("addr")
        .arg("show")
        .arg("dev")
        .arg(bridge)
        .output()
        .await
        .context("failed to execute ip -4 addr show")?;
    if !addr_status.status.success() {
        let stderr = String::from_utf8_lossy(&addr_status.stderr)
            .trim()
            .to_string();
        anyhow::bail!("failed to inspect bridge address for {bridge}: {stderr}");
    }
    let stdout = String::from_utf8_lossy(&addr_status.stdout);
    if !stdout.contains(&format!("inet {cidr}")) {
        run_command(
            "ip",
            &["addr", "add", &cidr, "dev", bridge],
            "assign vm bridge gateway",
        )
        .await?;
        info!(bridge, gateway = %cidr, "assigned vm bridge gateway");
    }

    run_command("ip", &["link", "set", bridge, "up"], "bring vm bridge up").await?;
    Ok(())
}

async fn ensure_ipv4_forwarding_enabled() -> Result<()> {
    const IPV4_FORWARD_PATH: &str = "/proc/sys/net/ipv4/ip_forward";

    let current = tokio::fs::read_to_string(IPV4_FORWARD_PATH)
        .await
        .context("failed to read IPv4 forwarding kernel setting")?;
    if current.trim() == "1" {
        return Ok(());
    }

    tokio::fs::write(IPV4_FORWARD_PATH, b"1\n")
        .await
        .context("failed to enable IPv4 forwarding")?;

    let updated = tokio::fs::read_to_string(IPV4_FORWARD_PATH)
        .await
        .context("failed to verify IPv4 forwarding kernel setting")?;
    if updated.trim() != "1" {
        anyhow::bail!(
            "failed to enable IPv4 forwarding; expected 1 at {IPV4_FORWARD_PATH}, got {}",
            updated.trim()
        );
    }

    Ok(())
}

fn render_vm_nft_ruleset(
    run_networks: &[RunNftNetwork],
    egress_if: &str,
    egress_ipv4: Option<Ipv4Addr>,
    ssh_access_enabled: bool,
) -> String {
    const BLOCKED_GUEST_DESTINATIONS: &[&str] = &[
        "169.254.0.0/16",
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "100.64.0.0/10",
    ];

    let egress_if = nft_string(egress_if);
    let mut out = String::new();
    out.push_str(&format!("table ip {NFT_VM_NET_TABLE} {{\n"));
    out.push_str("  chain forward {\n");
    out.push_str("    type filter hook forward priority filter; policy accept;\n");
    out.push_str("    ct state established,related accept\n");
    for network in run_networks {
        let bridge = nft_string(&network.bridge_name);
        let intra_run_comment = nft_string(&format!("intar run {} intra-run", network.run_id));
        out.push_str(&format!(
            "    iifname {bridge} oifname {bridge} accept comment {intra_run_comment}\n"
        ));
        for destination in BLOCKED_GUEST_DESTINATIONS {
            out.push_str(&format!(
                "    iifname {bridge} ip daddr {destination} drop\n"
            ));
        }
        out.push_str(&format!(
            "    iifname {bridge} oifname {egress_if} accept\n"
        ));
        out.push_str(&format!(
            "    iifname {egress_if} oifname {bridge} ct status dnat accept\n"
        ));
        out.push_str(&format!("    iifname {bridge} drop\n"));
        out.push_str(&format!("    oifname {bridge} drop\n"));
    }
    out.push_str("  }\n\n");

    out.push_str("  chain input {\n");
    out.push_str("    type filter hook input priority filter; policy accept;\n");
    for network in run_networks {
        out.push_str(&format!(
            "    iifname {} drop\n",
            nft_string(&network.bridge_name)
        ));
    }
    out.push_str("  }\n\n");

    out.push_str("  chain prerouting {\n");
    out.push_str("    type nat hook prerouting priority dstnat; policy accept;\n");
    if ssh_access_enabled {
        for network in run_networks {
            for forward in &network.ssh_forwards {
                let daddr = egress_ipv4
                    .map(|ip| format!(" ip daddr {ip}"))
                    .unwrap_or_default();
                let ssh_comment = nft_string(&format!("intar ssh {}", forward.vm_name));
                out.push_str(&format!(
                    "    iifname {egress_if}{daddr} tcp dport {} dnat to {}:22 comment {ssh_comment}\n",
                    forward.public_port, forward.guest_ip
                ));
            }
        }
    }
    out.push_str("  }\n\n");

    out.push_str("  chain postrouting {\n");
    out.push_str("    type nat hook postrouting priority srcnat; policy accept;\n");
    for network in run_networks {
        out.push_str(&format!(
            "    ip saddr {} oifname {egress_if} masquerade\n",
            network.subnet_cidr
        ));
    }
    out.push_str("  }\n");
    out.push_str("}\n\n");

    out.push_str(&format!("table ip6 {NFT_VM_NET_TABLE} {{\n"));
    out.push_str("  chain forward {\n");
    out.push_str("    type filter hook forward priority filter; policy accept;\n");
    for network in run_networks {
        let bridge = nft_string(&network.bridge_name);
        out.push_str(&format!("    iifname {bridge} drop\n"));
        out.push_str(&format!("    oifname {bridge} drop\n"));
    }
    out.push_str("  }\n\n");
    out.push_str("  chain input {\n");
    out.push_str("    type filter hook input priority filter; policy accept;\n");
    for network in run_networks {
        out.push_str(&format!(
            "    iifname {} drop\n",
            nft_string(&network.bridge_name)
        ));
    }
    out.push_str("  }\n");
    out.push_str("}\n");

    out
}

fn nft_string(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

async fn apply_vm_nft_ruleset(ruleset: &str) -> Result<()> {
    for (family, table) in [
        ("ip", NFT_VM_NET_TABLE),
        ("ip6", NFT_VM_NET_TABLE),
        ("ip", NFT_VM_NET_LEGACY_TABLE),
    ] {
        let _ = Command::new("nft")
            .arg("delete")
            .arg("table")
            .arg(family)
            .arg(table)
            .output()
            .await;
    }

    let mut child = Command::new("nft")
        .arg("-f")
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("failed to execute nft -f -")?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow::anyhow!("failed to open nft stdin"))?;
    stdin
        .write_all(ruleset.as_bytes())
        .await
        .context("failed to write nft ruleset")?;
    drop(stdin);

    let output = child
        .wait_with_output()
        .await
        .context("failed to wait for nft ruleset apply")?;
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    anyhow::bail!("nft ruleset apply failed: {stderr}\n{ruleset}");
}

async fn detect_default_interface() -> Result<String> {
    let output = Command::new("ip")
        .arg("-4")
        .arg("route")
        .arg("show")
        .arg("default")
        .output()
        .await
        .context("failed to execute ip -4 route show default")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        anyhow::bail!("ip -4 route show default failed: {stderr}");
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    if let Some(iface) = parse_default_route_interface(&stdout) {
        return Ok(iface);
    }

    let output = Command::new("ip")
        .arg("-4")
        .arg("route")
        .arg("get")
        .arg("1.1.1.1")
        .output()
        .await
        .context("failed to execute ip -4 route get 1.1.1.1")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        anyhow::bail!("ip -4 route get 1.1.1.1 failed: {stderr}");
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_default_route_interface(&stdout)
        .ok_or_else(|| anyhow::anyhow!("failed to detect default route interface"))
}

fn parse_default_route_interface(raw_routes: &str) -> Option<String> {
    for line in raw_routes.lines() {
        let mut parts = line.split_whitespace();
        while let Some(part) = parts.next() {
            if part == "dev" {
                let iface = parts.next()?.trim();
                if !iface.is_empty() {
                    return Some(iface.to_string());
                }
            }
        }
    }
    None
}

async fn detect_interface_ipv4(interface: &str) -> Result<Option<Ipv4Addr>> {
    let output = Command::new("ip")
        .arg("-4")
        .arg("-o")
        .arg("addr")
        .arg("show")
        .arg("dev")
        .arg(interface)
        .output()
        .await
        .with_context(|| format!("failed to execute ip -4 -o addr show dev {interface}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        anyhow::bail!("ip -4 -o addr show dev {interface} failed: {stderr}");
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let mut parts = line.split_whitespace();
        while let Some(part) = parts.next() {
            if part == "inet"
                && let Some(cidr) = parts.next()
                && let Some((ip, _prefix)) = cidr.split_once('/')
                && let Ok(parsed) = ip.parse::<Ipv4Addr>()
            {
                return Ok(Some(parsed));
            }
        }
    }

    Ok(None)
}

async fn destroy_tap(tap_name: &str) -> Result<()> {
    let output = Command::new("ip")
        .arg("link")
        .arg("del")
        .arg(tap_name)
        .output()
        .await
        .context("failed to execute ip link del")?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.contains("Cannot find device") {
        return Ok(());
    }

    anyhow::bail!("ip link del failed: {stderr}");
}

async fn run_command(bin: &str, args: &[&str], context: &str) -> Result<()> {
    let output = Command::new(bin)
        .args(args)
        .output()
        .await
        .with_context(|| format!("failed to execute {bin} for {context}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    anyhow::bail!("{context} failed: {stderr}");
}

async fn kill_process_force(pid: u32) -> Result<()> {
    let output = Command::new("kill")
        .arg("-9")
        .arg(pid.to_string())
        .output()
        .await
        .context("failed to execute kill -9")?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.contains("No such process") {
        return Ok(());
    }

    anyhow::bail!("kill -9 failed: {stderr}");
}

async fn process_looks_like(pid: u32, binary: &str) -> Result<bool> {
    let cmdline_path = format!("/proc/{pid}/cmdline");
    let raw = match tokio::fs::read(&cmdline_path).await {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(anyhow::anyhow!(
                "failed to read process cmdline {cmdline_path}: {error}"
            ));
        }
    };
    if raw.is_empty() {
        return Ok(false);
    }

    let process_name = raw
        .split(|byte| *byte == 0)
        .next()
        .and_then(|value| std::str::from_utf8(value).ok())
        .and_then(|value| Path::new(value).file_name().and_then(|name| name.to_str()))
        .unwrap_or_default();
    let expected_name = Path::new(binary)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(binary);

    Ok(process_name == expected_name)
}

fn random_hex_suffix(bytes_len: usize) -> String {
    let mut bytes = vec![0_u8; bytes_len];
    getrandom_fill(&mut bytes).expect("OS randomness unavailable for suffix generation");
    bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
}

fn extract_guest_ip(cidr: &str) -> Result<String> {
    let (ip, _prefix) = cidr
        .split_once('/')
        .ok_or_else(|| anyhow::anyhow!("guest_ip_cidr must include prefix"))?;
    let ip: IpAddr = ip
        .parse()
        .with_context(|| format!("invalid guest IP in CIDR: {cidr}"))?;
    Ok(ip.to_string())
}

async fn allocate_tap_name(inner: &Inner, vm_name: &str, tap_prefix: &str) -> String {
    let used = {
        let states = inner.states.read().await;
        states
            .values()
            .filter_map(|vm| vm.details.as_ref().and_then(|d| d.tap_name.clone()))
            .collect::<std::collections::BTreeSet<String>>()
    };

    for _ in 0..64 {
        let mut tap_name = format!("{tap_prefix}{}", random_hex_suffix(2));
        if tap_name.len() > 15 {
            tap_name = tap_name.chars().take(15).collect();
        }
        if !used.contains(&tap_name) {
            return tap_name;
        }
    }

    let mut fallback = format!("{}{}", tap_prefix, vm_name.replace('-', ""));
    if fallback.len() > 15 {
        fallback = fallback.chars().take(15).collect();
    }
    fallback
}

async fn allocate_ssh_public_port(inner: &Inner) -> Result<u16, ApiError> {
    let start = inner.ssh_access.public_port_start;
    let end = inner.ssh_access.public_port_end;
    if start == 0 || end == 0 || end < start {
        return Err(ApiError::internal(
            "ssh_access public port range is not configured correctly",
        ));
    }

    let used = {
        let states = inner.states.read().await;
        states
            .values()
            .filter_map(|vm| {
                vm.details
                    .as_ref()
                    .and_then(|details| details.ssh_public_port)
            })
            .collect::<BTreeSet<u16>>()
    };

    for port in start..=end {
        if !used.contains(&port) {
            return Ok(port);
        }
    }

    Err(ApiError::conflict("ssh public port pool exhausted"))
}

async fn current_terminal_state_for_vm(
    inner: &Inner,
    vm_name: &str,
    expected_run_id: Option<&str>,
) -> Result<Option<VmTerminalState>> {
    let vm = {
        let states = inner.states.read().await;
        states.get(vm_name).cloned()
    };
    let Some(vm) = vm else {
        return Ok(None);
    };

    if let Some(expected_run_id) = expected_run_id {
        let actual_run_id = vm
            .details
            .as_ref()
            .and_then(|details| details.run_id.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if actual_run_id != Some(expected_run_id) {
            return Ok(None);
        }
    }

    build_terminal_state_from_status(&vm, &inner.ssh_access).await
}

async fn build_terminal_state_from_status(
    vm: &VmStatusResponse,
    ssh_access: &SshAccessConfig,
) -> Result<Option<VmTerminalState>> {
    let ssh_ready = ssh_terminal_target_ready(vm).await;
    Ok(terminal_state_from_vm(
        vm,
        ssh_access,
        ssh_ready,
        now_unix_ms(),
    ))
}

fn terminal_state_from_vm(
    vm: &VmStatusResponse,
    ssh_access: &SshAccessConfig,
    ssh_ready: bool,
    observed_at: i64,
) -> Option<VmTerminalState> {
    let details = vm.details.as_ref()?;
    let run_id = details
        .run_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_string();

    let advertised_host = ssh_access
        .advertised_host
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let error_reason = vm
        .error
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let terminal_target =
        if vm.state == VmLifecycleState::Running && ssh_access.enabled && ssh_ready {
            details.ssh_public_port.map(|port| VmTerminalTarget {
                host: advertised_host,
                port,
                username: "ubuntu".to_string(),
                checked_at: observed_at,
            })
        } else {
            None
        };
    let (state, reason) = if terminal_target.is_some() {
        (VmTerminalStateKind::Ready, None)
    } else {
        match vm.state {
            VmLifecycleState::Failed | VmLifecycleState::DeleteFailed => (
                VmTerminalStateKind::Failed,
                error_reason.or_else(|| Some("vm failed".to_string())),
            ),
            VmLifecycleState::DeletingVm | VmLifecycleState::ArchivingArtifacts => {
                (VmTerminalStateKind::Pending, Some("destroying".to_string()))
            }
            _ => (VmTerminalStateKind::Pending, None),
        }
    };

    Some(VmTerminalState {
        run_id,
        vm_name: vm.name.clone(),
        state,
        terminal_target,
        reason,
        observed_at,
    })
}

async fn ssh_terminal_target_ready(vm: &VmStatusResponse) -> bool {
    if !matches!(vm.state, VmLifecycleState::Running) {
        return false;
    }

    let guest_ip = match vm
        .details
        .as_ref()
        .and_then(|details| details.guest_ip.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(value) => value,
        None => return false,
    };

    timeout(
        Duration::from_millis(750),
        TcpStream::connect((guest_ip, 22)),
    )
    .await
    .is_ok_and(|result| result.is_ok())
}

async fn allocate_run_network(
    inner: &Inner,
    run_id: &str,
    vm_name: &str,
) -> Result<(CreateVmNetwork, String), ApiError> {
    let pool_cidr = inner.defaults.network.guest_cidr.trim();
    let (pool_ip, pool_prefix) = parse_ipv4_cidr(pool_cidr, "vm_defaults.network.guest_cidr")
        .map_err(|e| ApiError::internal(e.to_string()))?;
    if pool_prefix > RUN_SUBNET_PREFIX {
        return Err(ApiError::internal(format!(
            "vm_defaults.network.guest_cidr prefix must be <= {RUN_SUBNET_PREFIX} for per-run /{RUN_SUBNET_PREFIX} allocation"
        )));
    }

    let pool_network = ipv4_network_u32(pool_ip, pool_prefix);
    let pool_subnet_count = 1_u32 << u32::from(RUN_SUBNET_PREFIX - pool_prefix);
    let run_bridge = run_bridge_name(run_id);

    let (used_ips, used_run_subnets, existing_run_network) = {
        let states = inner.states.read().await;
        let mut used_ips = BTreeSet::new();
        let mut used_run_subnets = BTreeSet::new();
        let mut existing_run_network = None;

        for vm in states.values() {
            let Some(details) = vm.details.as_ref() else {
                continue;
            };
            if let Some(guest_ip) = details.guest_ip.as_deref()
                && let Ok(ip) = guest_ip.parse::<Ipv4Addr>()
            {
                used_ips.insert(u32::from(ip));
            }
            let Some(guest_ip_cidr) = details.guest_ip_cidr.as_deref() else {
                continue;
            };
            let Ok((guest_ip, guest_prefix)) = parse_ipv4_cidr(guest_ip_cidr, "vm.guest_ip_cidr")
            else {
                continue;
            };
            let run_subnet = ipv4_network_u32(guest_ip, RUN_SUBNET_PREFIX);
            if ipv4_in_prefix(run_subnet, pool_network, pool_prefix) {
                used_run_subnets.insert(run_subnet);
            }
            if details.run_id.as_deref() == Some(run_id)
                && let Some(gateway) = details
                    .gateway
                    .as_deref()
                    .and_then(|value| value.parse::<Ipv4Addr>().ok())
            {
                existing_run_network = Some((
                    ipv4_network_u32(guest_ip, guest_prefix),
                    guest_prefix,
                    gateway,
                ));
            }
        }

        (used_ips, used_run_subnets, existing_run_network)
    };

    if let Some((network, prefix, gateway)) = existing_run_network {
        let guest_ip = allocate_guest_ip_in_subnet(network, prefix, vm_name, &used_ips, gateway)
            .ok_or_else(|| ApiError::conflict(format!("run {run_id} guest subnet exhausted")))?;
        return Ok((
            CreateVmNetwork {
                guest_ip_cidr: format!("{guest_ip}/{prefix}"),
                gateway: gateway.to_string(),
                dns: inner.defaults.network.dns.clone(),
            },
            run_bridge,
        ));
    }

    let subnet_size = 1_u32 << u32::from(32_u8 - RUN_SUBNET_PREFIX);
    let start_index = stable_u64(&[run_id]) % u64::from(pool_subnet_count);
    for offset in 0..pool_subnet_count {
        let index = ((start_index + u64::from(offset)) % u64::from(pool_subnet_count)) as u32;
        let subnet = pool_network.saturating_add(index.saturating_mul(subnet_size));
        if used_run_subnets.contains(&subnet) {
            continue;
        }

        let gateway = Ipv4Addr::from(subnet.saturating_add(1));
        let guest_ip =
            allocate_guest_ip_in_subnet(subnet, RUN_SUBNET_PREFIX, vm_name, &used_ips, gateway)
                .ok_or_else(|| ApiError::conflict("guest IP pool exhausted"))?;
        return Ok((
            CreateVmNetwork {
                guest_ip_cidr: format!("{guest_ip}/{RUN_SUBNET_PREFIX}"),
                gateway: gateway.to_string(),
                dns: inner.defaults.network.dns.clone(),
            },
            run_bridge,
        ));
    }

    Err(ApiError::conflict("per-run guest subnet pool exhausted"))
}

fn run_bridge_name(run_id: &str) -> String {
    format!("intar{}", stable_hex(&[run_id], 5))
}

fn stable_hex(parts: &[&str], bytes: usize) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update([0]);
    }
    let digest = hasher.finalize();
    base16ct::lower::encode_string(&digest[..bytes])
}

fn stable_u64(parts: &[&str]) -> u64 {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update([0]);
    }
    let digest = hasher.finalize();
    u64::from_be_bytes(
        digest[..8]
            .try_into()
            .expect("sha256 digest always has at least 8 bytes"),
    )
}

fn parse_ipv4_cidr(cidr: &str, label: &str) -> Result<(Ipv4Addr, u8)> {
    let (ip_raw, prefix_raw) = cidr
        .trim()
        .split_once('/')
        .ok_or_else(|| anyhow::anyhow!("{label} must be IPv4 CIDR"))?;
    let ip = ip_raw
        .parse::<Ipv4Addr>()
        .with_context(|| format!("{label} must use an IPv4 address"))?;
    let prefix = prefix_raw
        .parse::<u8>()
        .with_context(|| format!("{label} has invalid prefix"))?;
    if prefix > 32 {
        anyhow::bail!("{label} prefix must be <= 32");
    }
    Ok((ip, prefix))
}

fn ipv4_mask(prefix: u8) -> u32 {
    if prefix == 0 {
        0
    } else {
        u32::MAX << u32::from(32_u8 - prefix)
    }
}

fn ipv4_network_u32(ip: Ipv4Addr, prefix: u8) -> u32 {
    u32::from(ip) & ipv4_mask(prefix)
}

fn ipv4_in_prefix(ip: u32, network: u32, prefix: u8) -> bool {
    (ip & ipv4_mask(prefix)) == network
}

fn allocate_guest_ip_in_subnet(
    network: u32,
    prefix: u8,
    vm_name: &str,
    used_ips: &BTreeSet<u32>,
    gateway: Ipv4Addr,
) -> Option<Ipv4Addr> {
    if prefix > 30 {
        return None;
    }

    let capacity = 1_u32 << u32::from(32_u8 - prefix);
    let first_guest_offset = 2_u32;
    let last_guest_offset = capacity.checked_sub(2)?;
    if last_guest_offset < first_guest_offset {
        return None;
    }

    let gateway_u32 = u32::from(gateway);
    let candidate_count = last_guest_offset - first_guest_offset + 1;
    let start = stable_u64(&[vm_name]) % u64::from(candidate_count);
    for offset in 0..candidate_count {
        let host_offset =
            first_guest_offset + ((start + u64::from(offset)) % u64::from(candidate_count)) as u32;
        let candidate = network.saturating_add(host_offset);
        if candidate == gateway_u32 || used_ips.contains(&candidate) {
            continue;
        }
        return Some(Ipv4Addr::from(candidate));
    }

    None
}

fn gateway_for_guest_cidr(cidr: &str) -> Result<String> {
    let (guest_ip, prefix) = parse_ipv4_cidr(cidr, "network.guest_ip_cidr")?;
    if prefix > 30 {
        anyhow::bail!("network.guest_ip_cidr prefix must leave room for a gateway");
    }
    let network = ipv4_network_u32(guest_ip, prefix);
    Ok(Ipv4Addr::from(network.saturating_add(1)).to_string())
}

fn next_lease_expiry_error_log_state(
    prev: Option<&LeaseExpiryErrorLogState>,
    signature: &str,
    now_s: i64,
) -> (bool, LeaseExpiryErrorLogState) {
    let next = LeaseExpiryErrorLogState {
        signature: signature.to_string(),
        last_logged_at_s: now_s,
    };

    match prev {
        None => (true, next),
        Some(prev) if prev.signature != signature => (true, next),
        Some(prev)
            if now_s.saturating_sub(prev.last_logged_at_s) >= LEASE_EXPIRY_ERROR_LOG_INTERVAL_S =>
        {
            (true, next)
        }
        Some(prev) => (false, prev.clone()),
    }
}

async fn set_state(inner: &Inner, name: &str, state: VmLifecycleState) {
    let now_s = now_unix_s();
    let updated_at = format_rfc3339_s(now_s);

    let persisted = {
        let mut states = inner.states.write().await;
        let Some(vm) = states.get_mut(name) else {
            return;
        };

        vm.state = state;
        vm.updated_at_s = now_s;
        vm.updated_at = updated_at;
        if !state.is_failure() {
            vm.error = None;
        }

        if state == VmLifecycleState::Running && vm.running_at_s.is_none() {
            vm.running_at_s = Some(now_s);
        }
        vm.lease_expires_at = compute_lease_expires_at(vm.running_at_s, vm.lease_duration_seconds);

        vm.clone()
    };

    if let Err(e) = inner.db.upsert_vm(persisted.to_db_row()).await {
        error!(error = %e, vm = persisted.name, "failed to persist vm status");
    }
    if matches!(
        state,
        VmLifecycleState::Running
            | VmLifecycleState::DeletingVm
            | VmLifecycleState::ArchivingArtifacts
    ) {
        publish_terminal_state_update(inner, name, false).await;
    }
}

async fn mark_vm_failed(inner: &Inner, name: &str, message: String) {
    let now_s = now_unix_s();
    let updated_at = format_rfc3339_s(now_s);

    let persisted = {
        let mut states = inner.states.write().await;
        let Some(vm) = states.get_mut(name) else {
            return;
        };

        vm.state = VmLifecycleState::Failed;
        vm.updated_at_s = now_s;
        vm.updated_at = updated_at;
        vm.error = Some(message);
        vm.lease_expires_at = compute_lease_expires_at(vm.running_at_s, vm.lease_duration_seconds);

        vm.clone()
    };

    if let Err(e) = inner.db.upsert_vm(persisted.to_db_row()).await {
        error!(error = %e, vm = persisted.name, "failed to persist vm status");
    }
    stop_terminal_worker(inner, name).await;
    publish_terminal_state_update(inner, name, false).await;
}

async fn mark_vm_delete_failed(inner: &Inner, name: &str, message: String) {
    let now_s = now_unix_s();
    let updated_at = format_rfc3339_s(now_s);

    let persisted = {
        let mut states = inner.states.write().await;
        let Some(vm) = states.get_mut(name) else {
            return;
        };

        vm.state = VmLifecycleState::DeleteFailed;
        vm.updated_at_s = now_s;
        vm.updated_at = updated_at;
        vm.error = Some(message);
        vm.lease_expires_at = compute_lease_expires_at(vm.running_at_s, vm.lease_duration_seconds);

        vm.clone()
    };

    if let Err(e) = inner.db.upsert_vm(persisted.to_db_row()).await {
        error!(error = %e, vm = persisted.name, "failed to persist vm upload failure");
    }
    stop_terminal_worker(inner, name).await;
    publish_terminal_state_update(inner, name, false).await;
}

fn vm_status_from_row(row: VmRow) -> Result<VmStatusResponse> {
    let state = VmLifecycleState::parse(&row.state)
        .ok_or_else(|| anyhow::anyhow!("unknown vm state \"{}\"", row.state))?;

    let details = match (&row.root_disk_path, &row.seed_disk_path, &row.mac) {
        (Some(root_disk_path), Some(seed_disk_path), Some(mac)) => Some(VmDetails {
            run_id: row.run_id.clone(),
            root_disk_path: root_disk_path.clone(),
            seed_disk_path: seed_disk_path.clone(),
            recording_disk_path: row.recording_disk_path.clone(),
            spool_dir: row.spool_dir.clone(),
            mac: mac.clone(),
            guest_ip: row.guest_ip.clone(),
            guest_ip_cidr: row.guest_ip_cidr.clone(),
            gateway: row.gateway.clone(),
            bridge_name: row.bridge_name.clone(),
            ssh_public_port: row.ssh_public_port.and_then(|v| u16::try_from(v).ok()),
            tap_name: row.tap_name.clone(),
            ch_socket_path: row.ch_socket_path.clone(),
            ch_pid: row.ch_pid.and_then(|v| u32::try_from(v).ok()),
            kino_vsock_cid: row.kino_vsock_cid.and_then(|v| u32::try_from(v).ok()),
            kino_vsock_port: row
                .kino_vsock_port
                .and_then(|v| u32::try_from(v).ok())
                .or_else(|| row.kino_vsock_cid.map(|_| KINO_VSOCK_PORT)),
            kino_vsock_path: row.kino_vsock_path.clone(),
            ssh_host_keys_openssh: parse_ssh_host_keys_json(
                row.ssh_host_keys_openssh_json.as_deref(),
            ),
        }),
        _ => None,
    };

    let running_at_s = match (state, row.running_at_s) {
        (
            VmLifecycleState::Running
            | VmLifecycleState::DeletingVm
            | VmLifecycleState::ArchivingArtifacts
            | VmLifecycleState::DeleteFailed,
            None,
        ) => Some(row.updated_at_s),
        (_, other) => other,
    };

    let lease_duration_seconds = row
        .lease_duration_seconds
        .and_then(|v| u64::try_from(v).ok())
        .filter(|v| *v > 0);
    let lease_expires_at = compute_lease_expires_at(running_at_s, lease_duration_seconds);

    Ok(VmStatusResponse {
        name: row.name,
        state,
        created_at: format_rfc3339_s(row.created_at_s),
        updated_at: format_rfc3339_s(row.updated_at_s),
        details,
        error: row.error,
        lease_duration_seconds,
        lease_expires_at,
        created_at_s: row.created_at_s,
        updated_at_s: row.updated_at_s,
        running_at_s,
    })
}

async fn current_ssh_host_keys(inner: &Inner, vm_name: &str) -> Vec<String> {
    let states = inner.states.read().await;
    states
        .get(vm_name)
        .and_then(|vm| vm.details.as_ref())
        .map(|details| details.ssh_host_keys_openssh.clone())
        .unwrap_or_default()
}

fn parse_ssh_host_keys_json(raw: Option<&str>) -> Vec<String> {
    let Some(raw) = raw else {
        return Vec::new();
    };
    match serde_json::from_str::<Vec<String>>(raw) {
        Ok(keys) => normalize_ssh_host_keys(keys),
        Err(error) => {
            warn!(error = %error, "discarding invalid persisted ssh host keys");
            Vec::new()
        }
    }
}

fn normalize_ssh_host_keys(keys: Vec<String>) -> Vec<String> {
    let mut keys = keys
        .into_iter()
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
        .collect::<Vec<_>>();
    keys.sort();
    keys.dedup();
    keys
}

fn now_unix_ms() -> i64 {
    let millis = time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
    i64::try_from(millis).unwrap_or(i64::MAX)
}

fn now_unix_s() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

fn format_rfc3339_s(ts: i64) -> String {
    use time::format_description::well_known::Rfc3339;

    let dt = match time::OffsetDateTime::from_unix_timestamp(ts) {
        Ok(v) => v,
        Err(_) => return "unknown".to_string(),
    };

    match dt.format(&Rfc3339) {
        Ok(s) => s,
        Err(_) => "unknown".to_string(),
    }
}

fn compute_lease_expires_at(
    running_at_s: Option<i64>,
    lease_duration_seconds: Option<u64>,
) -> Option<String> {
    let running_at_s = running_at_s?;
    let lease_duration_seconds = lease_duration_seconds?;

    let lease_expires_at_s: i128 =
        (running_at_s as i128).saturating_add(lease_duration_seconds as i128);
    let lease_expires_at_s: i64 = match i64::try_from(lease_expires_at_s) {
        Ok(v) => v,
        Err(_) => return None,
    };

    Some(format_rfc3339_s(lease_expires_at_s))
}

fn is_safe_key(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn run_spool_dir(work_dir: &Path, run_id: &str) -> PathBuf {
    work_dir.join("run-spool").join(run_id)
}

fn vm_spool_dir(work_dir: &Path, run_id: &str, vm_name: &str) -> PathBuf {
    run_spool_dir(work_dir, run_id).join(vm_name)
}

fn matching_vm_names_for_run_id(
    states: &BTreeMap<String, VmStatusResponse>,
    run_id: &str,
) -> Vec<String> {
    states
        .iter()
        .filter_map(|(name, vm)| {
            let candidate = vm
                .details
                .as_ref()
                .and_then(|details| details.run_id.as_deref())?;
            (candidate == run_id).then(|| name.clone())
        })
        .collect()
}

fn resolve_work_dir(defaults: &VmDefaultsConfig) -> Result<PathBuf> {
    if let Some(p) = defaults.work_dir.as_ref() {
        return Ok(p.clone());
    }
    let base = dirs::cache_dir().ok_or_else(|| anyhow::anyhow!("cache dir unavailable"))?;
    Ok(base.join("intar-agent"))
}

fn create_recording_disk(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }

    let mut image = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
        .with_context(|| format!("failed to create recording disk at {}", path.display()))?;
    image
        .set_len(RECORDING_DISK_BYTES)
        .with_context(|| format!("failed to size recording disk at {}", path.display()))?;
    let options = fatfs::FormatVolumeOptions::new().volume_label(RECORDING_DISK_LABEL);
    fatfs::format_volume(&mut image, options).context("failed to format recording disk as vfat")?;
    Ok(())
}

async fn ensure_guest_ip_available(inner: &Inner, guest_ip_cidr: &str) -> Result<(), ApiError> {
    let guest_ip = extract_guest_ip(guest_ip_cidr)
        .map_err(|e| ApiError::bad_request(format!("invalid scenario runtime network: {e}")))?;

    let conflict = {
        let states = inner.states.read().await;
        states
            .values()
            .filter_map(|vm| {
                vm.details
                    .as_ref()
                    .and_then(|details| details.guest_ip.as_deref())
            })
            .any(|current| current == guest_ip)
    };

    if conflict {
        return Err(ApiError::conflict(format!(
            "guest IP {guest_ip} is already in use"
        )));
    }

    Ok(())
}

async fn allocate_kino_vsock_cid(inner: &Inner) -> Result<u32, ApiError> {
    let used = {
        let states = inner.states.read().await;
        states
            .values()
            .filter_map(|vm| vm.details.as_ref().and_then(|d| d.kino_vsock_cid))
            .collect::<BTreeSet<_>>()
    };

    for cid in KINO_VSOCK_CID_MIN..=u32::MAX {
        if !used.contains(&cid) {
            return Ok(cid);
        }
    }

    Err(ApiError::internal("exhausted kino vsock CID range"))
}

async fn ensure_kino_vsock_cid_available(
    inner: &Inner,
    requested_cid: u32,
) -> Result<(), ApiError> {
    if requested_cid < KINO_VSOCK_CID_MIN {
        return Err(ApiError::bad_request(format!(
            "runtime.kino.vsock_cid must be >= {KINO_VSOCK_CID_MIN}"
        )));
    }

    let conflict = {
        let states = inner.states.read().await;
        states
            .values()
            .filter_map(|vm| {
                vm.details
                    .as_ref()
                    .and_then(|details| details.kino_vsock_cid)
            })
            .any(|current| current == requested_cid)
    };

    if conflict {
        return Err(ApiError::conflict(format!(
            "Kino vsock CID {requested_cid} is already in use"
        )));
    }

    Ok(())
}

fn error_chain_to_string(err: &anyhow::Error) -> String {
    let mut out = err.to_string();
    for cause in err.chain().skip(1) {
        out.push_str(": ");
        out.push_str(&cause.to_string());
    }
    out
}

fn scenario_runtime_timeout_context(kino_vsock_path: &Path, saw_kino_vsock_socket: bool) -> String {
    let mut message = format!(
        "timed out after {SCENARIO_READY_TIMEOUT_SECONDS}s waiting for scenario runtime readiness"
    );
    if saw_kino_vsock_socket {
        message.push_str(" after Cloud Hypervisor created the Kino vsock socket at ");
        message.push_str(&kino_vsock_path.display().to_string());
    } else {
        message.push_str(" because Cloud Hypervisor never created the Kino vsock socket at ");
        message.push_str(&kino_vsock_path.display().to_string());
        if let Some(vm_dir) = kino_vsock_path.parent() {
            message.push_str("; inspect ");
            message.push_str(
                &vm_dir
                    .join(CLOUD_HYPERVISOR_STDERR_LOG_NAME)
                    .display()
                    .to_string(),
            );
        }
    }
    message
}

fn validate_network(net: &CreateVmNetwork) -> Result<String> {
    let guest = net.guest_ip_cidr.trim();
    if guest.is_empty() {
        anyhow::bail!("network.guest_ip_cidr must not be empty");
    }
    let (ip_str, prefix_str) = guest
        .split_once('/')
        .ok_or_else(|| anyhow::anyhow!("network.guest_ip_cidr must be CIDR like 10.0.0.2/24"))?;
    let ip: IpAddr = ip_str
        .parse()
        .with_context(|| format!("invalid guest IP address {ip_str}"))?;
    let prefix: u8 = prefix_str
        .parse()
        .with_context(|| format!("invalid guest IP prefix length {prefix_str}"))?;
    match ip {
        IpAddr::V4(_) if prefix <= 32 => {}
        IpAddr::V6(_) if prefix <= 128 => {}
        _ => anyhow::bail!("invalid CIDR prefix length for {ip}"),
    }

    let gateway_str = net.gateway.trim();
    if gateway_str.is_empty() {
        anyhow::bail!("network.gateway must not be empty");
    }
    let gateway: IpAddr = gateway_str
        .parse()
        .with_context(|| format!("invalid gateway IP address {gateway_str}"))?;
    if std::mem::discriminant(&ip) != std::mem::discriminant(&gateway) {
        anyhow::bail!("guest IP and gateway must be the same address family");
    }

    if net.dns.is_empty() {
        anyhow::bail!("network.dns must include at least one DNS server");
    }
    for d in &net.dns {
        let d = d.trim();
        if d.is_empty() {
            anyhow::bail!("network.dns contains an empty entry");
        }
        let dns_ip: IpAddr = d
            .parse()
            .with_context(|| format!("invalid DNS IP address {d}"))?;
        if std::mem::discriminant(&ip) != std::mem::discriminant(&dns_ip) {
            anyhow::bail!("all DNS servers must match the guest IP address family");
        }
    }

    Ok(format!("{ip_str}/{prefix}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kino_probe::{ProbeSummary, ProbeView};
    use cloud_hypervisor_client::Error as ChError;
    use serde_json::json;

    fn ch_is_not_created_error(err: &ChError) -> bool {
        matches!(err, ChError::HttpStatus { status: 404, .. })
    }

    fn ch_is_not_started_error(err: &ChError) -> bool {
        matches!(err, ChError::HttpStatus { status: 405, .. })
    }

    fn ch_vm_info_is_absent_status(status: u16) -> bool {
        status == 404
    }

    fn ch_vm_info_is_ambiguous_status(status: u16) -> bool {
        !ch_vm_info_is_absent_status(status) && status >= 500
    }

    fn ch_delete_confirms_absence_status(status: u16) -> bool {
        status == 204 || status == 404
    }

    fn test_vm_status(name: &str, run_id: Option<&str>) -> VmStatusResponse {
        VmStatusResponse {
            name: name.to_string(),
            state: VmLifecycleState::Queued,
            created_at: "1970-01-01T00:00:00Z".to_string(),
            updated_at: "1970-01-01T00:00:00Z".to_string(),
            details: Some(VmDetails {
                run_id: run_id.map(str::to_string),
                root_disk_path: format!("/tmp/{name}/root.raw"),
                seed_disk_path: format!("/tmp/{name}/runtime.img"),
                recording_disk_path: None,
                spool_dir: None,
                mac: "02:00:00:00:00:01".to_string(),
                guest_ip: None,
                guest_ip_cidr: None,
                gateway: None,
                bridge_name: None,
                ssh_public_port: None,
                tap_name: None,
                ch_socket_path: None,
                ch_pid: None,
                kino_vsock_cid: None,
                kino_vsock_port: None,
                kino_vsock_path: None,
                ssh_host_keys_openssh: Vec::new(),
            }),
            error: None,
            lease_duration_seconds: None,
            lease_expires_at: None,
            created_at_s: 0,
            updated_at_s: 0,
            running_at_s: None,
        }
    }

    fn test_ssh_access_config() -> SshAccessConfig {
        SshAccessConfig {
            enabled: true,
            public_port_start: 2200,
            public_port_end: 2299,
            advertised_host: Some("bridge.example.test".to_string()),
        }
    }

    #[test]
    fn run_bridge_name_is_stable_and_fits_linux_interface_limit() {
        let first = run_bridge_name("run-alpha");
        let second = run_bridge_name("run-alpha");
        let other = run_bridge_name("run-beta");

        assert_eq!(first, second);
        assert_ne!(first, other);
        assert!(first.starts_with("intar"));
        assert!(first.len() <= 15);
    }

    #[test]
    fn gateway_for_guest_cidr_uses_first_host_in_subnet() {
        assert_eq!(
            gateway_for_guest_cidr("10.77.12.8/28").expect("gateway"),
            "10.77.12.1"
        );
    }

    #[test]
    fn allocate_guest_ip_in_subnet_skips_gateway_and_used_ips() {
        let subnet = u32::from(Ipv4Addr::new(10, 77, 12, 0));
        let gateway = Ipv4Addr::new(10, 77, 12, 1);
        let first = allocate_guest_ip_in_subnet(subnet, 28, "web", &BTreeSet::new(), gateway)
            .expect("first guest ip");
        let mut used = BTreeSet::new();
        used.insert(u32::from(first));

        let second = allocate_guest_ip_in_subnet(subnet, 28, "web", &used, gateway)
            .expect("second guest ip");

        assert_ne!(first, gateway);
        assert_ne!(second, gateway);
        assert_ne!(first, second);
    }

    #[test]
    fn render_vm_nft_ruleset_isolates_runs_and_constrains_ssh_dnat() {
        let ruleset = render_vm_nft_ruleset(
            &[RunNftNetwork {
                run_id: "run-1".to_string(),
                bridge_name: "intarabc123".to_string(),
                subnet_cidr: "10.77.12.0/28".to_string(),
                gateway: Ipv4Addr::new(10, 77, 12, 1),
                prefix: 28,
                ssh_forwards: vec![SshForwardRule {
                    vm_name: "web".to_string(),
                    public_port: 2201,
                    guest_ip: Ipv4Addr::new(10, 77, 12, 2),
                }],
            }],
            "eth0",
            Some(Ipv4Addr::new(203, 0, 113, 10)),
            true,
        );

        assert!(ruleset.contains("table ip intar"));
        assert!(ruleset.contains("table ip6 intar"));
        assert!(ruleset.contains("iifname \"intarabc123\" oifname \"intarabc123\" accept"));
        assert!(ruleset.contains("ip daddr 169.254.0.0/16 drop"));
        assert!(ruleset.contains("ip daddr 10.0.0.0/8 drop"));
        assert!(ruleset.contains("ip daddr 172.16.0.0/12 drop"));
        assert!(ruleset.contains("ip daddr 192.168.0.0/16 drop"));
        assert!(ruleset.contains("ip daddr 100.64.0.0/10 drop"));
        assert!(ruleset.contains("iifname \"eth0\" oifname \"intarabc123\" ct status dnat accept"));
        assert!(ruleset.contains(
            "iifname \"eth0\" ip daddr 203.0.113.10 tcp dport 2201 dnat to 10.77.12.2:22"
        ));
        assert!(ruleset.contains("ip saddr 10.77.12.0/28 oifname \"eth0\" masquerade"));
        assert!(ruleset.contains("iifname \"intarabc123\" drop"));
    }

    #[test]
    fn ch_not_created_error_matches_only_404() {
        let e404 = ChError::HttpStatus {
            status: 404,
            body: "not found".to_string(),
        };
        assert!(ch_is_not_created_error(&e404));

        let e500 = ChError::HttpStatus {
            status: 500,
            body: r#"["Error from API","The VM info is not available","VM is not created"]"#
                .to_string(),
        };
        assert!(!ch_is_not_created_error(&e500));
    }

    #[test]
    fn ch_not_started_error_matches_only_405() {
        let e405 = ChError::HttpStatus {
            status: 405,
            body: "vm not started".to_string(),
        };
        assert!(ch_is_not_started_error(&e405));

        let e500 = ChError::HttpStatus {
            status: 500,
            body: r#"["Error from API","The VM could not shutdown","VM is not running"]"#
                .to_string(),
        };
        assert!(!ch_is_not_started_error(&e500));
    }

    #[test]
    fn vm_info_status_classification() {
        assert!(ch_vm_info_is_absent_status(404));
        assert!(!ch_vm_info_is_absent_status(500));

        assert!(ch_vm_info_is_ambiguous_status(500));
        assert!(ch_vm_info_is_ambiguous_status(503));
        assert!(!ch_vm_info_is_ambiguous_status(404));
        assert!(!ch_vm_info_is_ambiguous_status(405));
    }

    #[test]
    fn delete_status_confirms_absence() {
        assert!(ch_delete_confirms_absence_status(204));
        assert!(ch_delete_confirms_absence_status(404));
        assert!(!ch_delete_confirms_absence_status(500));
    }

    #[test]
    fn run_begin_missing_remote_vm_matches_expected_404_payload() {
        assert!(is_missing_remote_run_vm_begin_response(
            StatusCode::NOT_FOUND,
            r#"{"error":"run VM not found"}"#
        ));
        assert!(is_missing_remote_run_vm_begin_response(
            StatusCode::NOT_FOUND,
            r#"{"error": "run VM not found"}"#
        ));
        assert!(!is_missing_remote_run_vm_begin_response(
            StatusCode::NOT_FOUND,
            r#"{"error":"scenario run not found"}"#
        ));
        assert!(!is_missing_remote_run_vm_begin_response(
            StatusCode::CONFLICT,
            r#"{"error":"run VM not found"}"#
        ));
    }

    #[test]
    fn vm_spool_dir_is_nested_under_run_id() {
        let work_dir = Path::new("/var/cache/intar-agent");

        assert_eq!(
            vm_spool_dir(work_dir, "run-1", "vm-1"),
            PathBuf::from("/var/cache/intar-agent/run-spool/run-1/vm-1")
        );
    }

    #[test]
    fn matching_vm_names_for_run_id_returns_all_matches() {
        let mut states = BTreeMap::new();
        states.insert("vm-b".to_string(), test_vm_status("vm-b", Some("run-1")));
        states.insert("vm-a".to_string(), test_vm_status("vm-a", Some("run-1")));
        states.insert("vm-c".to_string(), test_vm_status("vm-c", Some("run-2")));
        states.insert("vm-d".to_string(), test_vm_status("vm-d", None));

        assert_eq!(
            matching_vm_names_for_run_id(&states, "run-1"),
            vec!["vm-a".to_string(), "vm-b".to_string()]
        );
    }

    #[test]
    fn probe_replay_preserves_stored_envelope_payload() {
        let stored = ProbeUpdateEnvelope {
            update_id: "update-1".to_string(),
            vm_name: "vm-1".to_string(),
            run_id: "run-1".to_string(),
            generated_at_ms: 123,
            collection_state: ProbeCollectionState::Ok,
            collection_error: None,
            fingerprint: "fp-1".to_string(),
            summary: ProbeSummary {
                total: 1,
                pass: 1,
                fail: 0,
                unknown: 0,
            },
            ssh_host_keys_openssh: vec!["ssh-ed25519 AAAAHOST host".to_string()],
            probes: vec![ProbeView {
                id: "boot".to_string(),
                kind: "probe".to_string(),
                status: "pass".to_string(),
                every_seconds: 5,
                last_attempt_at_ms: Some(120),
                last_success_at_ms: Some(120),
                last_duration_ms: 10,
                error: None,
                value: json!({"ok": true}),
            }],
        };
        let row = VmProbeStateRow {
            vm_name: stored.vm_name.clone(),
            run_id: stored.run_id.clone(),
            fingerprint: stored.fingerprint.clone(),
            collection_state: "ok".to_string(),
            collection_error: None,
            summary_json: serde_json::to_string(&stored.summary).expect("summary json"),
            snapshot_json: serde_json::to_string(&stored).expect("envelope json"),
            generated_at_ms: stored.generated_at_ms,
            updated_at_ms: 125,
        };

        let replayed = probe_update_from_state_row(&row).expect("replayed envelope");

        assert_eq!(replayed.update_id, stored.update_id);
        assert_eq!(replayed.vm_name, stored.vm_name);
        assert_eq!(replayed.run_id, stored.run_id);
        assert_eq!(replayed.generated_at_ms, stored.generated_at_ms);
        assert_eq!(replayed.fingerprint, stored.fingerprint);
        assert_eq!(replayed.summary, stored.summary);
        assert_eq!(replayed.ssh_host_keys_openssh, stored.ssh_host_keys_openssh);
        assert_eq!(replayed.probes, stored.probes);
    }

    #[test]
    fn startup_resume_only_applies_to_booting_or_running_vms() {
        assert!(should_resume_live_vm_on_startup(
            VmLifecycleState::BootingVm
        ));
        assert!(should_resume_live_vm_on_startup(VmLifecycleState::Running));
        assert!(!should_resume_live_vm_on_startup(VmLifecycleState::Queued));
        assert!(!should_resume_live_vm_on_startup(
            VmLifecycleState::DeletingVm
        ));
        assert!(!should_resume_live_vm_on_startup(
            VmLifecycleState::ArchivingArtifacts
        ));
        assert!(!should_resume_live_vm_on_startup(VmLifecycleState::Failed));
        assert!(!should_resume_live_vm_on_startup(
            VmLifecycleState::DeleteFailed
        ));
    }

    #[test]
    fn startup_resume_reenters_booting_only_for_booting_vms() {
        assert!(startup_resume_reenters_booting(VmLifecycleState::BootingVm));
        assert!(!startup_resume_reenters_booting(VmLifecycleState::Running));
        assert!(!startup_resume_reenters_booting(
            VmLifecycleState::DeletingVm
        ));
    }

    #[test]
    fn startup_cleanup_mode_archives_delete_path_states() {
        let mut running = test_vm_status("vm-running", Some("run-1"));
        running.state = VmLifecycleState::Running;
        assert_eq!(startup_cleanup_mode(&running), StartupCleanupMode::Archive);

        let mut deleting = test_vm_status("vm-deleting", Some("run-1"));
        deleting.state = VmLifecycleState::DeletingVm;
        assert_eq!(startup_cleanup_mode(&deleting), StartupCleanupMode::Archive);

        let mut archiving = test_vm_status("vm-archiving", Some("run-1"));
        archiving.state = VmLifecycleState::ArchivingArtifacts;
        assert_eq!(
            startup_cleanup_mode(&archiving),
            StartupCleanupMode::Archive
        );

        let mut delete_failed = test_vm_status("vm-delete-failed", Some("run-1"));
        delete_failed.state = VmLifecycleState::DeleteFailed;
        assert_eq!(
            startup_cleanup_mode(&delete_failed),
            StartupCleanupMode::Archive
        );

        let mut failed = test_vm_status("vm-failed", Some("run-1"));
        failed.state = VmLifecycleState::Failed;
        assert_eq!(startup_cleanup_mode(&failed), StartupCleanupMode::DropLocal);
    }

    #[test]
    fn vm_status_from_row_backfills_running_at_for_delete_path_states() {
        for state in [
            VmLifecycleState::DeletingVm,
            VmLifecycleState::ArchivingArtifacts,
            VmLifecycleState::DeleteFailed,
        ] {
            let mut status = test_vm_status("vm-delete-path", Some("run-1"));
            status.state = state;
            status.updated_at_s = 42;
            status.updated_at = format_rfc3339_s(42);
            status.running_at_s = None;

            let parsed = vm_status_from_row(status.to_db_row()).expect("parsed vm row");
            assert_eq!(parsed.running_at_s, Some(42));
        }
    }

    #[test]
    fn scenario_runtime_timeout_context_reports_missing_vsock_socket() {
        let message = scenario_runtime_timeout_context(
            Path::new("/var/cache/intar-agent/vms/demo/kino.vsock"),
            false,
        );

        assert!(message.contains("never created the Kino vsock socket"));
        assert!(message.contains("cloud-hypervisor.stderr.log"));
    }

    #[test]
    fn scenario_runtime_timeout_context_reports_existing_vsock_socket() {
        let message = scenario_runtime_timeout_context(
            Path::new("/var/cache/intar-agent/vms/demo/kino.vsock"),
            true,
        );

        assert!(message.contains("created the Kino vsock socket"));
        assert!(!message.contains("cloud-hypervisor.stderr.log"));
    }

    #[test]
    fn cloud_hypervisor_config_uses_direct_boot_payload_and_stable_disks() {
        let cached_image = image_cache::CachedImage {
            raw_path: PathBuf::from("/cache/images/broken.raw"),
            kernel_path: PathBuf::from("/cache/artifacts/vmlinuz"),
            initrd_path: PathBuf::from("/cache/artifacts/initrd.img"),
            cmdline: "root=/dev/vda rw console=ttyS0 quiet loglevel=4".to_string(),
            virtual_size_bytes: 2 * 1024 * 1024 * 1024,
        };

        let cfg = build_cloud_hypervisor_vm_config(CloudHypervisorVmConfigInput {
            name: "vm-demo",
            cached_image: &cached_image,
            vcpus: 2,
            memory_mib: 768,
            tap: "intar-tap0",
            mac: "02:00:00:00:00:01",
            root_disk_path: Path::new("/work/vms/vm-demo/root.raw"),
            config_disk_path: Path::new("/work/vms/vm-demo/runtime.vfat"),
            recording_disk_path: Path::new("/work/runs/run-1/vm-demo/recordings.vfat"),
            kino_vsock_cid: 10_042,
            kino_vsock_path: Path::new("/work/vms/vm-demo/kino.vsock"),
        })
        .expect("vm config should render");

        assert_eq!(cfg.payload.firmware, None);
        assert_eq!(
            cfg.payload.kernel.as_deref(),
            Some("/cache/artifacts/vmlinuz")
        );
        assert_eq!(
            cfg.payload.initramfs.as_deref(),
            Some("/cache/artifacts/initrd.img")
        );
        assert_eq!(
            cfg.payload.cmdline.as_deref(),
            Some("root=/dev/vda rw console=ttyS0 quiet loglevel=4")
        );

        let cpus = cfg.cpus.as_ref().expect("cpus");
        assert_eq!(cpus.boot_vcpus, 2);
        assert_eq!(cpus.max_vcpus, 2);
        assert_eq!(
            cfg.memory.as_ref().expect("memory").size,
            768_i64 * 1024 * 1024
        );
        assert_eq!(
            cfg.serial
                .as_ref()
                .and_then(|serial| serial.file.as_deref()),
            Some("/work/vms/vm-demo/serial.log")
        );
        assert_eq!(
            cfg.console
                .as_ref()
                .and_then(|console| console.file.as_deref()),
            Some("/work/vms/vm-demo/console.log")
        );

        let disks = cfg.disks.as_ref().expect("disks");
        assert_eq!(disks.len(), 3);
        assert_eq!(disks[0].path, "/work/vms/vm-demo/root.raw");
        assert!(!disks[0].readonly);
        assert_eq!(disks[0].id.as_deref(), Some("vm-demo-root"));
        assert!(matches!(
            disks[0].image_type.as_ref(),
            Some(DiskImageType::Raw)
        ));
        assert_eq!(disks[1].path, "/work/vms/vm-demo/runtime.vfat");
        assert!(disks[1].readonly);
        assert_eq!(disks[1].id.as_deref(), Some("vm-demo-runtime"));
        assert!(matches!(
            disks[1].image_type.as_ref(),
            Some(DiskImageType::Raw)
        ));
        assert_eq!(disks[2].path, "/work/runs/run-1/vm-demo/recordings.vfat");
        assert!(!disks[2].readonly);
        assert_eq!(disks[2].id.as_deref(), Some("vm-demo-recordings"));
        assert!(matches!(
            disks[2].image_type.as_ref(),
            Some(DiskImageType::Raw)
        ));

        let net = cfg.net.as_ref().expect("net");
        assert_eq!(net[0].tap, "intar-tap0");
        assert_eq!(net[0].mac.as_deref(), Some("02:00:00:00:00:01"));
        let vsock = cfg.vsock.as_ref().expect("vsock");
        assert_eq!(vsock.cid, 10_042);
        assert_eq!(vsock.socket, "/work/vms/vm-demo/kino.vsock");
        assert_eq!(vsock.id.as_deref(), Some("vm-demo-kino-vsock"));
    }

    #[test]
    fn lease_expiry_error_log_state_is_throttled_per_vm_signature() {
        let (log_first, state_first) = next_lease_expiry_error_log_state(None, "err-a", 100);
        assert!(log_first);
        assert_eq!(
            state_first,
            LeaseExpiryErrorLogState {
                signature: "err-a".to_string(),
                last_logged_at_s: 100,
            }
        );

        let (log_second, state_second) =
            next_lease_expiry_error_log_state(Some(&state_first), "err-a", 110);
        assert!(!log_second);
        assert_eq!(state_second, state_first);

        let (log_third, state_third) =
            next_lease_expiry_error_log_state(Some(&state_first), "err-a", 161);
        assert!(log_third);
        assert_eq!(
            state_third,
            LeaseExpiryErrorLogState {
                signature: "err-a".to_string(),
                last_logged_at_s: 161,
            }
        );

        let (log_changed, state_changed) =
            next_lease_expiry_error_log_state(Some(&state_first), "err-b", 111);
        assert!(log_changed);
        assert_eq!(
            state_changed,
            LeaseExpiryErrorLogState {
                signature: "err-b".to_string(),
                last_logged_at_s: 111,
            }
        );
    }

    #[test]
    fn create_scenario_vm_request_accepts_runtime() {
        let req: CreateScenarioVmRequest = serde_json::from_value(json!({
            "name": "demo",
            "run_id": "abc123demo",
            "image": "broken-nginx-webserver-amd64",
            "runtime": {
                "ssh_authorized_keys_openssh": ["ssh-ed25519 AAAATEST stargate-target"],
                "network": {
                    "guest_ip_cidr": "10.200.0.44/24",
                    "gateway": "10.200.0.1",
                    "dns": ["1.1.1.1", "8.8.8.8"]
                },
                "kino": {
                    "vsock_cid": 10044,
                    "vsock_port": 19090
                }
            },
            "lease_duration_seconds": 300
        }))
        .expect("request should parse");

        assert_eq!(req.lease_duration_seconds, Some(300));
        assert_eq!(
            req.runtime.ssh_authorized_keys_openssh,
            vec!["ssh-ed25519 AAAATEST stargate-target".to_string()]
        );
        assert_eq!(
            req.runtime
                .network
                .as_ref()
                .expect("network override should parse")
                .guest_ip_cidr,
            "10.200.0.44/24"
        );
        assert_eq!(
            req.runtime
                .kino
                .as_ref()
                .expect("kino override should parse")
                .vsock_port,
            Some(19090)
        );
    }

    #[test]
    fn create_scenario_vm_request_rejects_missing_runtime() {
        let err = serde_json::from_value::<CreateScenarioVmRequest>(json!({
            "name": "demo",
            "run_id": "abc123demo",
            "image": "broken-nginx-webserver-amd64"
        }))
        .expect_err("missing runtime field should be rejected");

        let msg = err.to_string();
        assert!(
            msg.contains("missing field `runtime`"),
            "unexpected serde error: {msg}"
        );
    }

    #[test]
    fn create_scenario_vm_request_rejects_unknown_field() {
        let err = serde_json::from_value::<CreateScenarioVmRequest>(json!({
            "name": "demo",
            "run_id": "abc123demo",
            "image": "broken-nginx-webserver-amd64",
            "runtime": {
                "ssh_authorized_keys_openssh": ["ssh-ed25519 AAAATEST stargate-target"]
            },
            "unknown_field": 300
        }))
        .expect_err("unknown field should be rejected");

        let msg = err.to_string();
        assert!(
            msg.contains("unknown field `unknown_field`"),
            "unexpected serde error: {msg}"
        );
    }

    #[test]
    fn create_scenario_vm_request_rejects_legacy_network_field() {
        let err = serde_json::from_value::<CreateScenarioVmRequest>(json!({
            "name": "demo",
            "run_id": "abc123demo",
            "image": "broken-nginx-webserver-amd64",
            "runtime": {
                "ssh_authorized_keys_openssh": ["ssh-ed25519 AAAATEST stargate-target"]
            },
            "network": {
                "guest_ip_cidr": "10.0.0.2/24",
                "gateway": "10.0.0.1",
                "dns": ["1.1.1.1"]
            }
        }))
        .expect_err("legacy network field should be rejected");

        let msg = err.to_string();
        assert!(
            msg.contains("unknown field `network`"),
            "unexpected serde error: {msg}"
        );
    }

    #[test]
    fn parse_default_route_interface_extracts_device_from_default_route() {
        let raw = "default via 51.159.109.1 dev ens3 proto dhcp src 51.159.109.212 metric 100";
        let iface = parse_default_route_interface(raw);
        assert_eq!(iface.as_deref(), Some("ens3"));
    }

    #[test]
    fn parse_default_route_interface_extracts_device_from_route_get() {
        let raw = "1.1.1.1 via 10.200.0.1 dev br0 src 10.200.0.10 uid 0\n    cache";
        let iface = parse_default_route_interface(raw);
        assert_eq!(iface.as_deref(), Some("br0"));
    }

    #[test]
    fn terminal_state_reports_ready_when_running_and_ssh_is_ready() {
        let mut vm = test_vm_status("vm-ready", Some("run-1"));
        vm.state = VmLifecycleState::Running;
        vm.details.as_mut().expect("details").ssh_public_port = Some(2222);

        let state = terminal_state_from_vm(&vm, &test_ssh_access_config(), true, 1234)
            .expect("terminal state");

        assert_eq!(state.run_id, "run-1");
        assert_eq!(state.vm_name, "vm-ready");
        assert_eq!(state.state, VmTerminalStateKind::Ready);
        assert_eq!(state.reason, None);
        assert_eq!(
            state.terminal_target,
            Some(VmTerminalTarget {
                host: Some("bridge.example.test".to_string()),
                port: 2222,
                username: "ubuntu".to_string(),
                checked_at: 1234,
            })
        );
    }

    #[test]
    fn terminal_state_reports_destroying_pending_when_vm_is_deleting() {
        let mut vm = test_vm_status("vm-deleting", Some("run-1"));
        vm.state = VmLifecycleState::DeletingVm;
        vm.details.as_mut().expect("details").ssh_public_port = Some(2222);

        let state = terminal_state_from_vm(&vm, &test_ssh_access_config(), true, 1234)
            .expect("terminal state");

        assert_eq!(state.state, VmTerminalStateKind::Pending);
        assert_eq!(state.reason.as_deref(), Some("destroying"));
        assert_eq!(state.terminal_target, None);
    }

    #[test]
    fn terminal_state_reports_failed_with_vm_error() {
        let mut vm = test_vm_status("vm-failed", Some("run-1"));
        vm.state = VmLifecycleState::Failed;
        vm.error = Some("boot failed".to_string());

        let state = terminal_state_from_vm(&vm, &test_ssh_access_config(), false, 1234)
            .expect("terminal state");

        assert_eq!(state.state, VmTerminalStateKind::Failed);
        assert_eq!(state.reason.as_deref(), Some("boot failed"));
        assert_eq!(state.terminal_target, None);
    }
}
