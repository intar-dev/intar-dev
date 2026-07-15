#![forbid(unsafe_code)]

use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result};
use axum::http::StatusCode;
use cloud_hypervisor_client::{
    Client as ChClient, ConsoleConfig, CpusConfig, DiskConfig, DiskImageType, MemoryConfig,
    NetConfig, PayloadConfig, SerialConfig, VmConfig, VsockConfig,
};
use futures_util::stream::{self, StreamExt as _, TryStreamExt as _};
use getrandom::fill as getrandom_fill;
use intar_contracts::bridge::{
    VmBootCpuSamplePointV1, VmBootCpuSampleV1, VmBootEvidenceV1, VmBootPhaseDurationsV1,
    VmRuntimeConstraintPhaseV1, VmRuntimeConstraintsV1,
};
use intar_jailer_protocol::{
    ArtifactAccess, ArtifactSource, AsyncSeqpacketClient, DestroyRunNetworkRequest,
    EnsureRunNetworkRequest, FinalizeVmBootRequest, FinalizeVmBootResult, JailPathMap,
    JailerCapabilities, LaunchVmV2Request, PREPARED_IMAGE_SOURCE_ROOT, PrepareImageV2Request,
    PreparedImageV2Result, Request as JailerRequest, Response as JailerResponse, RunNetworkResult,
    SampleVmCpuRequest, SandboxHealth, Sha256Digest, SourceArtifacts, ValidatedId, VmCpuPhase,
    VmCpuRuntimeState, VmCpuSample, VmIdentityRequest, VmInspection, VmLaunchRequest,
    VmLaunchResult,
};
use reqwest::Client as HttpClient;
use russh::{
    Disconnect, Preferred,
    client::{self as ssh_client},
    kex,
    keys::ssh_key::PublicKey,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::net::TcpStream;
use tokio::sync::{Mutex, OnceCell, OwnedMutexGuard, RwLock, Semaphore, broadcast};
use tokio::task::{AbortHandle, JoinHandle};
use tokio::time::timeout;
use tracing::{debug, error, info, warn};

use crate::config::{
    AgentConfig, BridgeConfig, SshAccessConfig, VmDefaultsConfig, normalize_sha256,
};
use crate::db::{ArchiveJobRow, Db, VmProbeStateRow, VmRow};
use crate::image_cache;
use crate::kino_probe::{ProbeCollectionState, ProbeUpdateEnvelope};
#[cfg(target_os = "linux")]
use crate::kino_probe::{ProbePollResult, decode_probe_snapshot};

use super::{mac, replay_media, runtime_disk};

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateVmResources {
    pub cpu_millis: u32,
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
    pub image_sha256: String,
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
    #[serde(default)]
    pub peer_vm_names: Vec<String>,
    #[serde(default)]
    pub peer_vm_aliases: BTreeMap<String, String>,
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
    #[serde(skip_serializing)]
    pub image_key: Option<String>,
    #[serde(skip_serializing)]
    pub image_sha256: Option<String>,
    pub run_id: Option<String>,
    pub root_disk_path: String,
    pub seed_disk_path: String,
    pub recording_disk_path: Option<String>,
    pub spool_dir: Option<String>,
    pub mac: String,
    pub cpu_millis: Option<u32>,
    pub vcpu_count: Option<u16>,
    pub guest_ip: Option<String>,
    pub guest_ip_cidr: Option<String>,
    pub gateway: Option<String>,
    pub bridge_name: Option<String>,
    pub ssh_public_port: Option<u16>,
    pub tap_name: Option<String>,
    pub ch_socket_path: Option<String>,
    pub ch_pid: Option<u32>,
    pub ch_start_time_ticks: Option<u64>,
    pub host_boot_id: Option<String>,
    pub ch_executable_sha256: Option<String>,
    pub jail_generation: Option<String>,
    pub jail_unit_name: Option<String>,
    pub jail_cgroup_path: Option<String>,
    pub jail_root_path: Option<String>,
    pub jail_root_inode: Option<u64>,
    pub jail_uid: Option<u32>,
    pub jail_gid: Option<u32>,
    pub jail_netns_name: Option<String>,
    pub kino_vsock_cid: Option<u32>,
    pub kino_vsock_port: Option<u32>,
    pub kino_vsock_path: Option<String>,
    pub ssh_host_keys_openssh: Vec<String>,
    #[serde(skip_serializing)]
    pub cpu_runtime: Option<VmCpuRuntimeState>,
    /// In-memory boot evidence for the live generation. It is deliberately
    /// absent after recovery: recovery attests the current sandbox and quota,
    /// but cannot recreate measurements it did not observe.
    #[serde(skip_serializing)]
    pub boot_evidence: Option<VmBootEvidenceV1>,
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
            image_key: self.details.as_ref().and_then(|d| d.image_key.clone()),
            image_sha256: self.details.as_ref().and_then(|d| d.image_sha256.clone()),
            created_at_s: self.created_at_s,
            updated_at_s: self.updated_at_s,
            running_at_s: self.running_at_s,
            error: self.error.clone(),
            root_disk_path: self.details.as_ref().map(|d| d.root_disk_path.clone()),
            seed_disk_path: self.details.as_ref().map(|d| d.seed_disk_path.clone()),
            mac: self.details.as_ref().map(|d| d.mac.clone()),
            cpu_millis: self
                .details
                .as_ref()
                .and_then(|d| d.cpu_millis)
                .map(i64::from),
            vcpu_count: self
                .details
                .as_ref()
                .and_then(|d| d.vcpu_count)
                .map(i64::from),
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
            ch_start_time_ticks: self
                .details
                .as_ref()
                .and_then(|d| d.ch_start_time_ticks)
                .and_then(|value| i64::try_from(value).ok()),
            host_boot_id: self.details.as_ref().and_then(|d| d.host_boot_id.clone()),
            ch_executable_sha256: self
                .details
                .as_ref()
                .and_then(|d| d.ch_executable_sha256.clone()),
            jail_generation: self
                .details
                .as_ref()
                .and_then(|d| d.jail_generation.clone()),
            jail_unit_name: self.details.as_ref().and_then(|d| d.jail_unit_name.clone()),
            jail_cgroup_path: self
                .details
                .as_ref()
                .and_then(|d| d.jail_cgroup_path.clone()),
            jail_root_path: self.details.as_ref().and_then(|d| d.jail_root_path.clone()),
            jail_root_inode: self
                .details
                .as_ref()
                .and_then(|d| d.jail_root_inode)
                .and_then(|value| i64::try_from(value).ok()),
            jail_uid: self
                .details
                .as_ref()
                .and_then(|d| d.jail_uid)
                .map(i64::from),
            jail_gid: self
                .details
                .as_ref()
                .and_then(|d| d.jail_gid)
                .map(i64::from),
            jail_netns_name: self
                .details
                .as_ref()
                .and_then(|d| d.jail_netns_name.clone()),
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
    requested_image_sha256: String,
    requested_resources: Option<CreateVmResources>,
    requested_hostname: Option<String>,
    lease_duration_seconds: Option<u64>,
    runtime: CreateScenarioVmRuntime,
}

const LEASE_EXPIRY_ERROR_LOG_INTERVAL_S: i64 = 60;
const RUN_SUBNET_PREFIX: u8 = 28;
const KINO_VSOCK_PORT: u32 = 18_080;
const KINO_HOST_READY_PORT: u32 = 18_081;
const KINO_VSOCK_CID_MIN: u32 = 10_000;
const ARTIFACT_UPLOAD_PART_BYTES: usize = 16 * 1024 * 1024;
const ARTIFACT_UPLOAD_CONCURRENCY: usize = 4;
const ARCHIVE_JOB_BATCH_SIZE: usize = 4;
const ARCHIVE_RETRY_BASE_MS: i64 = 5_000;
const ARCHIVE_RETRY_MAX_MS: i64 = 5 * 60 * 1000;
const DELETE_SHUTDOWN_GRACE_SECONDS: u64 = 5;
const PROBE_POLL_INTERVAL_SECONDS: u64 = 2;
const TERMINAL_PENDING_POLL_INTERVAL_MILLIS: u64 = 500;
const TERMINAL_READY_POLL_INTERVAL_SECONDS: u64 = 5;
// Treat the historical 45-second deadline as a one-core CPU-time budget. A
// hard fractional quota deliberately stretches guest boot wall time, so using
// the same wall-clock deadline for every quota makes otherwise healthy 125m
// guests fail during their first boot. Keep a finite ceiling so a malformed or
// impractically small quota cannot hold one readiness attempt indefinitely.
const SCENARIO_READY_BASE_TIMEOUT_SECONDS: u64 = 45;
const SCENARIO_READY_REFERENCE_CPU_MILLIS: u32 = 1_000;
const SCENARIO_READY_MAX_TIMEOUT_SECONDS: u64 = 6 * 60;
const JAILER_PREPARE_IMAGE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const SCENARIO_READY_PROCESS_POLL_INTERVAL_MILLIS: u64 = 500;
const SCENARIO_READY_API_POLL_INTERVAL_SECONDS: u64 = 3;
const SCENARIO_READY_API_PROBE_TIMEOUT_SECONDS: u64 = 2;
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

#[derive(Debug, thiserror::Error)]
#[error("jailerd boot capacity is temporarily unavailable: {message}")]
struct BootCapacityPending {
    message: String,
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

struct AbortTaskOnDrop(AbortHandle);

impl Drop for AbortTaskOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
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
    pub runtime_constraints: Option<VmRuntimeConstraintsV1>,
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
            "runtimeConstraints": self.runtime_constraints,
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
    ch_spawn_timeout_seconds: u64,
    jailer_socket: PathBuf,
    jailer_request_timeout_seconds: u64,
    jailer_launch_capabilities: OnceCell<JailerCapabilities>,
    bridge: BridgeConfig,
    ssh_access: SshAccessConfig,
    db: Db,
    http: HttpClient,
    defaults: VmDefaultsConfig,
    states: RwLock<BTreeMap<String, VmStatusResponse>>,
    lease_expiry_error_log: RwLock<BTreeMap<String, LeaseExpiryErrorLogState>>,
    probe_tasks: Mutex<BTreeMap<String, VmProbeTask>>,
    /// Guest readiness is an internal launch signal. It is deliberately
    /// separate from `probe_updates_tx`, whose subscribers project data to the
    /// control plane only after the ready boundary is durably committed.
    kino_readiness_tx: broadcast::Sender<ProbeUpdateEnvelope>,
    probe_updates_tx: broadcast::Sender<ProbeUpdateEnvelope>,
    terminal_tasks: Mutex<BTreeMap<String, VmTerminalTask>>,
    terminal_state_fingerprints: Mutex<BTreeMap<String, String>>,
    terminal_updates_tx: broadcast::Sender<VmTerminalState>,
    kino_vsock_cid_lock: Mutex<()>,
    create_sem: Arc<Semaphore>,
    delete_requests: Mutex<BTreeSet<String>>,
    cleanup_locks: Mutex<BTreeMap<String, Arc<Mutex<()>>>>,
    run_cleanup_locks: Mutex<BTreeMap<String, Arc<Mutex<()>>>>,
    archive_jobs_lock: Mutex<()>,
}

impl VmManager {
    pub fn new(cfg: &AgentConfig, db: Db, persisted: Vec<VmRow>) -> Result<Self> {
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

        let (kino_readiness_tx, _) = broadcast::channel(256);
        let (probe_updates_tx, _) = broadcast::channel(256);
        let (terminal_updates_tx, _) = broadcast::channel(256);
        let inner = Inner {
            ch_spawn_timeout_seconds: cfg.cloud_hypervisor.spawn_timeout_seconds,
            jailer_socket: cfg.jailer.socket.clone(),
            jailer_request_timeout_seconds: cfg.jailer.request_timeout_seconds,
            jailer_launch_capabilities: OnceCell::new(),
            bridge: cfg.bridge.clone(),
            ssh_access: cfg.ssh_access.clone(),
            db,
            http: HttpClient::new(),
            defaults: cfg.vm_defaults.clone(),
            states: RwLock::new(states),
            lease_expiry_error_log: RwLock::new(BTreeMap::new()),
            probe_tasks: Mutex::new(BTreeMap::new()),
            kino_readiness_tx,
            probe_updates_tx,
            terminal_tasks: Mutex::new(BTreeMap::new()),
            terminal_state_fingerprints: Mutex::new(BTreeMap::new()),
            terminal_updates_tx,
            kino_vsock_cid_lock: Mutex::new(()),
            create_sem: Arc::new(Semaphore::new(8)),
            delete_requests: Mutex::new(BTreeSet::new()),
            cleanup_locks: Mutex::new(BTreeMap::new()),
            run_cleanup_locks: Mutex::new(BTreeMap::new()),
            archive_jobs_lock: Mutex::new(()),
        };
        Ok(Self {
            inner: Arc::new(inner),
        })
    }

    /// Run the full jailerd-owned repair path for every persisted run.
    /// VM launch uses the separate O(1) `EnsureRunNetwork` exact-hit path.
    pub async fn repair_host_networking(&self) -> Result<()> {
        repair_vm_networks(&self.inner).await
    }

    pub fn subscribe_probe_updates(&self) -> broadcast::Receiver<ProbeUpdateEnvelope> {
        self.inner.probe_updates_tx.subscribe()
    }

    pub fn subscribe_terminal_updates(&self) -> broadcast::Receiver<VmTerminalState> {
        self.inner.terminal_updates_tx.subscribe()
    }

    pub async fn terminal_state(&self, vm_name: &str) -> Result<Option<VmTerminalState>> {
        current_terminal_state_for_vm(&self.inner, vm_name, None).await
    }

    /// Publicly routable address for this host's per-VM SSH forwards, from
    /// `[ssh_access] advertised_host`.
    #[must_use]
    pub fn ssh_advertised_host(&self) -> Option<String> {
        self.inner
            .ssh_access
            .advertised_host
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    }

    pub async fn jailer_capabilities(&self) -> Result<JailerCapabilities> {
        match request_jailerd(&self.inner, JailerRequest::Capabilities).await? {
            JailerResponse::Capabilities(capabilities) => Ok(capabilities),
            JailerResponse::Error(error) => {
                anyhow::bail!("jailerd {}: {}", error.code, error.message)
            }
            response => anyhow::bail!(
                "jailerd returned unexpected response to capabilities request: {response:?}"
            ),
        }
    }

    /// Ensure a cached boot bundle is also present in jailerd's root-owned
    /// clone-only template store. A missing v2 capability is a hard launch
    /// incompatibility; this breaking path never downgrades to v1.
    pub async fn ensure_cached_image_template(
        &self,
        image: &image_cache::CachedImage,
    ) -> Result<PreparedImageV2Result> {
        ensure_jailer_image_template(&self.inner, image).await
    }

    pub async fn inspect_jailed_vm(&self, generation: &str) -> Result<Option<VmInspection>> {
        jailer_identity_request(&self.inner, generation, JailerIdentityOperation::Inspect).await
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
        let (peer_vm_names, peer_vm_aliases) = normalize_peer_vm_topology(
            &req.name,
            req.runtime.peer_vm_names,
            req.runtime.peer_vm_aliases,
        )?;

        let runtime = CreateScenarioVmRuntime {
            ssh_authorized_keys_openssh,
            network: req.runtime.network,
            kino: req.runtime.kino,
            peer_vm_names,
            peer_vm_aliases,
        };

        self.queue_vm_create(QueueVmCreateRequest {
            requested_name: req.name,
            requested_run_id: req.run_id,
            requested_image: req.image,
            requested_image_sha256: req.image_sha256,
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
            requested_image_sha256,
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
        let image_sha256 = normalize_sha256(requested_image_sha256.trim())
            .ok_or_else(|| ApiError::bad_request("image_sha256 must be a SHA-256 digest"))?;

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
            cpu_millis: self.inner.defaults.resources.vcpus.saturating_mul(1_000),
            vcpus: self.inner.defaults.resources.vcpus,
            memory_mib: self.inner.defaults.resources.memory_mib,
            disk_mib: None,
        });
        if resources.vcpus == 0 {
            return Err(ApiError::bad_request("resources.vcpus must be >= 1"));
        }
        if resources.cpu_millis == 0 {
            return Err(ApiError::bad_request("resources.cpu_millis must be >= 1"));
        }
        if resources.cpu_millis > resources.vcpus.saturating_mul(1_000) {
            return Err(ApiError::bad_request(
                "resources.cpu_millis must not exceed resources.vcpus * 1000",
            ));
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
        let (mut network, bridge_name, peer_guest_ips) = match scenario_runtime.network.as_ref() {
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
                    BTreeMap::new(),
                )
            }
            None => {
                allocate_run_network(
                    &self.inner,
                    &run_id,
                    &name,
                    &scenario_runtime.peer_vm_names,
                    &scenario_runtime.peer_vm_aliases,
                )
                .await?
            }
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

        // Reserve every in-memory-only resource before creating staging
        // files. The CID guard stays held until the queued row is durable (or
        // its provisional state is rolled back), so a concurrent request
        // cannot reuse the same CID while persistence is in flight.
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
        let ssh_public_port = if self.inner.ssh_access.enabled {
            Some(allocate_ssh_public_port(&self.inner).await?)
        } else {
            None
        };

        let work_dir = resolve_work_dir(&self.inner.defaults)
            .map_err(|e| ApiError::internal(format!("failed to resolve vm work dir: {e}")))?;
        let vm_dir = work_dir.join("vms").join(&name);
        let spool_dir = vm_spool_dir(&work_dir, &run_id, &name);
        let recording_disk_path = spool_dir.join("recordings.vfat");

        for (kind, path) in [("vm dir", &vm_dir), ("vm spool", &spool_dir)] {
            match tokio::fs::metadata(path).await {
                Ok(_) => {
                    return Err(ApiError::conflict(format!(
                        "{kind} exists at {}",
                        path.display()
                    )));
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    return Err(ApiError::internal(format!(
                        "failed to stat {kind} {}: {e}",
                        path.display()
                    )));
                }
            }
        }
        let root_disk_path = vm_dir.join("root.raw");
        let config_disk_path = vm_dir.join(RUNTIME_DISK_FILENAME);
        let ch_socket_path = vm_dir.join("cloud-hypervisor.sock");
        let kino_vsock_path = vm_dir.join("kino.vsock");

        let details = VmDetails {
            image_key: Some(image_key.clone()),
            image_sha256: Some(image_sha256.clone()),
            run_id: Some(run_id.clone()),
            root_disk_path: root_disk_path.display().to_string(),
            seed_disk_path: config_disk_path.display().to_string(),
            recording_disk_path: Some(recording_disk_path.display().to_string()),
            spool_dir: Some(spool_dir.display().to_string()),
            mac: mac.clone(),
            cpu_millis: Some(resources.cpu_millis),
            vcpu_count: u16::try_from(resources.vcpus).ok(),
            guest_ip: Some(guest_ip.clone()),
            guest_ip_cidr: Some(network.guest_ip_cidr.clone()),
            gateway: Some(network.gateway.clone()),
            bridge_name: Some(bridge_name.clone()),
            ssh_public_port,
            tap_name: Some(tap_name.clone()),
            ch_socket_path: Some(ch_socket_path.display().to_string()),
            ch_pid: None,
            ch_start_time_ticks: None,
            host_boot_id: None,
            ch_executable_sha256: None,
            jail_generation: None,
            jail_unit_name: None,
            jail_cgroup_path: None,
            jail_root_path: None,
            jail_root_inode: None,
            jail_uid: None,
            jail_gid: None,
            jail_netns_name: None,
            kino_vsock_cid: Some(kino_vsock_cid),
            kino_vsock_port: Some(kino_vsock_port),
            kino_vsock_path: Some(kino_vsock_path.display().to_string()),
            ssh_host_keys_openssh: Vec::new(),
            cpu_runtime: None,
            boot_evidence: None,
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

        let reserved = {
            let mut states = self.inner.states.write().await;
            reserve_vm_state(&mut states, status.clone())
        };
        if !reserved {
            return Err(ApiError::conflict(format!("vm \"{name}\" already exists")));
        }

        if let Err(error) = self.inner.db.upsert_vm(status.to_db_row()).await {
            error!(error = %error, vm = name, "failed to persist vm status (queued); rolling back create");
            if remove_matching_tracked_vm_state(&self.inner, &status).await {
                clear_delete_request(&self.inner, &status.name).await;
            }
            let delete_error = self.inner.db.delete_vm(status.name.clone()).await.err();
            drop(cid_guard);
            return Err(ApiError::internal(match delete_error {
                Some(delete_error) => format!(
                    "failed to persist queued VM before launch: {error:#}; ambiguous-row delete also failed: {delete_error:#}"
                ),
                None => format!("failed to persist queued VM before launch: {error:#}"),
            }));
        }
        drop(cid_guard);

        let staging_result = async {
            tokio::fs::create_dir_all(&vm_dir)
                .await
                .with_context(|| format!("failed to create vm dir at {}", vm_dir.display()))?;
            tokio::fs::create_dir_all(spool_dir.join("artifacts"))
                .await
                .with_context(|| {
                    format!("failed to create run spool at {}", spool_dir.display())
                })?;

            Ok::<(), anyhow::Error>(())
        }
        .await;
        if let Err(error) = staging_result {
            let rollback_error =
                rollback_persisted_queued_vm(&self.inner, &status, &vm_dir, &spool_dir)
                    .await
                    .err();
            let rollback_failed = rollback_error.is_some();
            let message = match rollback_error {
                Some(rollback_error) => format!(
                    "failed to stage queued VM: {error:#}; rollback also failed: {rollback_error:#}"
                ),
                None => format!("failed to stage queued VM: {error:#}"),
            };
            if rollback_failed {
                mark_vm_failed(&self.inner, &status.name, message.clone()).await;
                if take_delete_request(&self.inner, &status.name).await {
                    spawn_vm_cleanup_task(Arc::clone(&self.inner), status.name.clone(), false);
                }
            }
            return Err(ApiError::internal(message));
        }
        let resp_name = name.clone();
        let inner = Arc::clone(&self.inner);
        let network_for_task = network.clone();
        let peer_guest_ips_for_task = peer_guest_ips.clone();
        let name_for_task = name.clone();
        let image_key_for_task = image_key.clone();
        let image_sha256_for_task = image_sha256.clone();
        let hostname_for_task = hostname.clone();
        let runtime_for_task = runtime.clone();
        let tap_for_task = tap_name.clone();

        tokio::spawn(async move {
            let _permit = permit;
            let span =
                tracing::info_span!("vm_create", vm = %name_for_task, image = %image_key_for_task);
            let _g = span.enter();

            let create_input = RunCreateInput {
                name: &name_for_task,
                run_id: &run_id,
                image_key: &image_key_for_task,
                expected_image_sha256: &image_sha256_for_task,
                runtime: &runtime_for_task,
                tap: &tap_for_task,
                ssh_public_port,
                kino_vsock_cid,
                kino_vsock_port,
                kino_host_ready_port: KINO_HOST_READY_PORT,
                cpu_millis: resources.cpu_millis,
                vcpus: resources.vcpus,
                memory_mib: resources.memory_mib,
                disk_mib: resources.disk_mib,
                hostname: &hostname_for_task,
                mac: &mac,
                root_disk_path: &root_disk_path,
                config_disk_path: &config_disk_path,
                recording_disk_path: &recording_disk_path,
                network: &network_for_task,
                peer_guest_ips: &peer_guest_ips_for_task,
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
                let _run_cleanup_guard =
                    acquire_run_cleanup_lock(&inner.run_cleanup_locks, &run_id).await;
                if let Err(cleanup_error) =
                    cleanup_jailed_vm_by_logical_id(&inner, &run_id, &name_for_task).await
                {
                    error!(
                        error = %cleanup_error,
                        vm = name_for_task,
                        run_id,
                        "failed to destroy jailed runtime after VM create failure"
                    );
                }
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
    run_id: &'a str,
    image_key: &'a str,
    expected_image_sha256: &'a str,
    runtime: &'a CreateScenarioVmRuntime,
    tap: &'a str,
    ssh_public_port: Option<u16>,
    kino_vsock_cid: u32,
    kino_vsock_port: u32,
    kino_host_ready_port: u32,
    cpu_millis: u32,
    vcpus: u32,
    memory_mib: u32,
    disk_mib: Option<u32>,
    hostname: &'a str,
    mac: &'a str,
    root_disk_path: &'a Path,
    config_disk_path: &'a Path,
    recording_disk_path: &'a Path,
    network: &'a CreateVmNetwork,
    peer_guest_ips: &'a BTreeMap<String, String>,
}

struct CloudHypervisorVmConfigInput<'a> {
    name: &'a str,
    cmdline: &'a str,
    paths: &'a JailPathMap,
    vcpus: u32,
    memory_mib: u32,
    tap: &'a str,
    mac: &'a str,
    kino_vsock_cid: u32,
}

fn build_cloud_hypervisor_vm_config(input: CloudHypervisorVmConfigInput<'_>) -> Result<VmConfig> {
    Ok(VmConfig {
        cpus: Some(CpusConfig {
            boot_vcpus: input.vcpus,
            max_vcpus: input.vcpus,
        }),
        memory: Some(MemoryConfig {
            size: (input.memory_mib as i64) * 1024 * 1024,
        }),
        payload: PayloadConfig {
            kernel: Some(input.paths.jailed_kernel.display().to_string()),
            initramfs: input
                .paths
                .jailed_initrd
                .as_ref()
                .map(|path| path.display().to_string()),
            cmdline: Some(input.cmdline.to_string()),
            ..PayloadConfig::default()
        },
        serial: Some(SerialConfig {
            file: Some(input.paths.jailed_serial_log.display().to_string()),
            mode: "File".to_string(),
            iommu: false,
            socket: None,
        }),
        console: Some(ConsoleConfig {
            file: Some(input.paths.jailed_console_log.display().to_string()),
            mode: "File".to_string(),
            iommu: false,
            socket: None,
        }),
        disks: Some(vec![
            DiskConfig {
                path: input.paths.jailed_root_disk.display().to_string(),
                readonly: false,
                id: Some(format!("{}-root", input.name)),
                image_type: Some(DiskImageType::Raw),
            },
            DiskConfig {
                path: input.paths.jailed_runtime_disk.display().to_string(),
                readonly: true,
                id: Some(format!("{}-{RUNTIME_DISK_ID_SUFFIX}", input.name)),
                image_type: Some(DiskImageType::Raw),
            },
            DiskConfig {
                path: input.paths.jailed_recording_disk.display().to_string(),
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
            socket: input.paths.jailed_vsock_socket.display().to_string(),
            iommu: false,
            pci_segment: None,
            id: Some(format!("{}-kino-vsock", input.name)),
        }),
        landlock_enable: Some(true),
    })
}

async fn cached_jailer_launch_capabilities(inner: &Inner) -> Result<&JailerCapabilities> {
    inner
        .jailer_launch_capabilities
        .get_or_try_init(|| async {
            match request_jailerd(inner, JailerRequest::Capabilities).await? {
                JailerResponse::Capabilities(capabilities) => Ok(capabilities),
                JailerResponse::Error(error) => {
                    anyhow::bail!("jailerd {}: {}", error.code, error.message)
                }
                response => anyhow::bail!(
                    "jailerd returned unexpected response to capabilities request: {response:?}"
                ),
            }
        })
        .await
}

async fn ensure_jailer_image_template(
    inner: &Inner,
    image: &image_cache::CachedImage,
) -> Result<PreparedImageV2Result> {
    let capabilities = cached_jailer_launch_capabilities(inner).await?;
    if !(capabilities.supports_jailer_v2
        && capabilities.supports_template_backed_launch
        && capabilities.fast_template_store)
    {
        anyhow::bail!("jailerd does not attest the mandatory template-backed v2 launch contract");
    }

    let request = PrepareImageV2Request {
        image_sha256: Sha256Digest::parse(image.image_sha256.to_ascii_lowercase())
            .context("validate prepared image identity")?,
        virtual_size_bytes: image.virtual_size_bytes,
        root_disk: artifact_source(
            &image.raw_path,
            &capabilities.allowed_source_roots,
            Some(&image.raw_sha256),
            ArtifactAccess::ReadOnly,
        )?,
        kernel: artifact_source(
            &image.kernel_path,
            &capabilities.allowed_source_roots,
            Some(&image.kernel_sha256),
            ArtifactAccess::ReadOnly,
        )?,
        initrd: Some(artifact_source(
            &image.initrd_path,
            &capabilities.allowed_source_roots,
            Some(&image.initrd_sha256),
            ArtifactAccess::ReadOnly,
        )?),
    };
    request
        .validate()
        .context("validate prepared image request")?;
    let result = match request_jailerd_with_timeout(
        inner,
        JailerRequest::PrepareImageV2(Box::new(request.clone())),
        JAILER_PREPARE_IMAGE_TIMEOUT,
    )
    .await?
    {
        JailerResponse::PrepareImageV2(result) => result,
        JailerResponse::Error(error) => {
            anyhow::bail!("jailerd {}: {}", error.code, error.message)
        }
        response => {
            anyhow::bail!("jailerd returned unexpected response to prepare_image_v2: {response:?}")
        }
    };
    validate_prepared_image_result(&request, &result)?;
    image_cache::mark_template_ready(image, &result)
        .await
        .context("persist prepared jail template readiness")?;
    Ok(result)
}

fn validate_prepared_image_result(
    request: &PrepareImageV2Request,
    result: &PreparedImageV2Result,
) -> Result<()> {
    anyhow::ensure!(
        result.image_sha256 == request.image_sha256
            && result.virtual_size_bytes == request.virtual_size_bytes
            && result.fast_template_store,
        "jailerd prepared image identity or fast-store attestation mismatch"
    );
    let expected = [
        (
            &result.root_disk,
            "root.raw",
            request.root_disk.sha256.as_ref(),
            ArtifactAccess::ReadWrite,
        ),
        (
            &result.kernel,
            "kernel",
            request.kernel.sha256.as_ref(),
            ArtifactAccess::ReadOnly,
        ),
    ];
    for (source, name, sha256, access) in expected {
        anyhow::ensure!(
            source.source_root == PREPARED_IMAGE_SOURCE_ROOT
                && source.relative_path == PathBuf::from(request.image_sha256.as_str()).join(name)
                && source.sha256.as_ref() == sha256
                && source.access == access,
            "jailerd returned an invalid prepared {name} descriptor"
        );
    }
    match (&request.initrd, &result.initrd) {
        (Some(request_source), Some(source)) => anyhow::ensure!(
            source.source_root == PREPARED_IMAGE_SOURCE_ROOT
                && source.relative_path
                    == PathBuf::from(request.image_sha256.as_str()).join("initrd")
                && source.sha256 == request_source.sha256
                && source.access == ArtifactAccess::ReadOnly,
            "jailerd returned an invalid prepared initrd descriptor"
        ),
        (None, None) => {}
        _ => anyhow::bail!("jailerd prepared image initrd shape mismatch"),
    }
    Ok(())
}

fn build_jailer_launch_operation(
    request: VmLaunchRequest,
    prepared_image: Option<&PreparedImageV2Result>,
) -> Result<JailerRequest> {
    let prepared = prepared_image
        .context("prepared v2 image is mandatory; this breaking launch path has no v1 fallback")?;
    let request = LaunchVmV2Request {
        image_sha256: prepared.image_sha256.clone(),
        virtual_size_bytes: prepared.virtual_size_bytes,
        launch: request,
    };
    request
        .validate()
        .context("validate jailer template-backed launch request")?;
    Ok(JailerRequest::LaunchVmV2(Box::new(request)))
}

async fn request_v2_launch_with_single_retry<F, Fut>(
    operation: JailerRequest,
    mut send: F,
) -> Result<JailerResponse>
where
    F: FnMut(JailerRequest) -> Fut,
    Fut: Future<Output = Result<JailerResponse>>,
{
    anyhow::ensure!(
        matches!(operation, JailerRequest::LaunchVmV2(_)),
        "v2 launch retry requires an exact LaunchVmV2 operation"
    );
    let retry_operation = operation.clone();
    match send(operation).await {
        Ok(response) => Ok(response),
        Err(first_error) => send(retry_operation).await.with_context(|| {
            format!(
                "identical LaunchVmV2 retry failed after the first transport attempt failed: {first_error:#}"
            )
        }),
    }
}

async fn launch_jailed_cloud_hypervisor(
    inner: &Inner,
    req: &RunCreateInput<'_>,
    cached_image: &image_cache::CachedImage,
    prepared: &PreparedImageV2Result,
) -> Result<VmLaunchResult> {
    let run_id = ValidatedId::parse(req.run_id.to_string()).context("validate jailer run ID")?;
    let vm_id = ValidatedId::parse(req.name.to_string()).context("validate jailer VM ID")?;

    let capabilities = cached_jailer_launch_capabilities(inner).await?;

    let root_disk_size_bytes = req
        .disk_mib
        .map(|target_disk_mib| u64::from(target_disk_mib) * 1024 * 1024)
        .unwrap_or(cached_image.virtual_size_bytes);
    let artifacts = SourceArtifacts {
        kernel: prepared.kernel.clone(),
        initrd: prepared.initrd.clone(),
        root_disk: prepared.root_disk.clone(),
        runtime_disk: artifact_source(
            req.config_disk_path,
            &capabilities.allowed_source_roots,
            None,
            ArtifactAccess::ReadOnly,
        )?,
        recording_disk: artifact_source(
            req.recording_disk_path,
            &capabilities.allowed_source_roots,
            None,
            ArtifactAccess::ReadWrite,
        )?,
    };

    let request = VmLaunchRequest {
        run_id,
        vm_id,
        cpu_millis: req.cpu_millis,
        vcpu_count: u16::try_from(req.vcpus).context("vCPU count exceeds jailer contract")?,
        memory_mib: req.memory_mib,
        root_disk_size_bytes,
        tap_name: req.tap.to_string(),
        mac_address: req.mac.to_string(),
        guest_ip_cidr: req.network.guest_ip_cidr.clone(),
        ssh_public_port: req.ssh_public_port,
        vsock_cid: req.kino_vsock_cid,
        artifacts,
    };
    let launch_operation = build_jailer_launch_operation(request, Some(prepared))?;

    // A transport timeout can occur after jailerd committed the launch but
    // before the response arrived. Replay the byte-equivalent v2 operation so
    // jailerd's fingerprint and generation fences remain authoritative. Never
    // synthesize success from InspectVm, which cannot attest the request.
    let launch_response = request_v2_launch_with_single_retry(launch_operation, |operation| {
        request_jailerd(inner, operation)
    })
    .await?;

    match launch_response {
        JailerResponse::LaunchVmV2(result) => Ok(result),
        JailerResponse::Error(error) if error.code == "boot_capacity_pending" => {
            Err(BootCapacityPending {
                message: error.message,
            }
            .into())
        }
        JailerResponse::Error(error) => {
            anyhow::bail!("jailerd {}: {}", error.code, error.message)
        }
        response => {
            anyhow::bail!("jailerd returned unexpected response to v2 launch: {response:?}")
        }
    }
}

async fn ensure_jailed_run_network(
    inner: &Inner,
    run_id: &str,
    network: &CreateVmNetwork,
) -> Result<RunNetworkResult> {
    let run_id = ValidatedId::parse(run_id.to_string()).context("validate jailer run ID")?;
    let (guest_ip, prefix) = parse_ipv4_cidr(&network.guest_ip_cidr, "network.guest_ip_cidr")?;
    let run_cidr = format!(
        "{}/{prefix}",
        Ipv4Addr::from(ipv4_network_u32(guest_ip, prefix))
    );
    match request_jailerd(
        inner,
        JailerRequest::EnsureRunNetwork(EnsureRunNetworkRequest {
            run_id,
            guest_cidr: run_cidr,
            gateway: network.gateway.clone(),
        }),
    )
    .await?
    {
        JailerResponse::EnsureRunNetwork(result) => Ok(result),
        JailerResponse::Error(error) => {
            anyhow::bail!("jailerd {}: {}", error.code, error.message)
        }
        response => anyhow::bail!(
            "jailerd returned unexpected response to ensure_run_network: {response:?}"
        ),
    }
}

async fn finalize_jailed_vm_boot(
    inner: &Inner,
    generation: &ValidatedId,
    expect_ssh_forward: bool,
) -> Result<FinalizeVmBootResult> {
    let response = request_jailerd(
        inner,
        JailerRequest::FinalizeVmBoot(FinalizeVmBootRequest {
            generation: generation.clone(),
        }),
    )
    .await?;
    let result = match response {
        JailerResponse::FinalizeVmBoot(result) => result,
        JailerResponse::Error(error) => {
            anyhow::bail!("jailerd {}: {}", error.code, error.message)
        }
        response => {
            anyhow::bail!("jailerd returned unexpected response to finalize_vm_boot: {response:?}")
        }
    };
    anyhow::ensure!(
        result.generation == *generation,
        "jailerd finalized a different VM generation"
    );
    anyhow::ensure!(
        result.cpu_runtime.phase == VmCpuPhase::Steady,
        "jailerd finalized VM without entering steady CPU phase"
    );
    let attestation = result
        .cpu_runtime
        .attestation
        .as_ref()
        .context("jailerd finalized VM without quota readback attestation")?;
    anyhow::ensure!(
        attestation.quota == result.cpu_runtime.steady_quota
            && result.cpu_runtime.effective_quota == result.cpu_runtime.steady_quota
            && attestation.cpu_max == result.cpu_runtime.steady_quota.cpu_max()
            && attestation.cpu_max_burst == 0,
        "jailerd steady quota attestation did not match the recorded entitlement"
    );
    anyhow::ensure!(
        !expect_ssh_forward || result.ssh_forward_active,
        "jailerd finalized VM without activating its reserved SSH forward"
    );
    Ok(result)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum VmCpuSamplePoint {
    VmBootAccepted,
    KinoReady,
    PreSeal,
    PostSeal,
    TerminalPublished,
}

impl VmCpuSamplePoint {
    const fn as_str(self) -> &'static str {
        match self {
            Self::VmBootAccepted => "vm_boot_accepted",
            Self::KinoReady => "kino_ready",
            Self::PreSeal => "pre_seal",
            Self::PostSeal => "post_seal",
            Self::TerminalPublished => "terminal_published",
        }
    }

    const fn contract(self) -> VmBootCpuSamplePointV1 {
        match self {
            Self::VmBootAccepted => VmBootCpuSamplePointV1::VmBootAccepted,
            Self::KinoReady => VmBootCpuSamplePointV1::KinoReady,
            Self::PreSeal => VmBootCpuSamplePointV1::PreSeal,
            Self::PostSeal => VmBootCpuSamplePointV1::PostSeal,
            Self::TerminalPublished => VmBootCpuSamplePointV1::TerminalPublished,
        }
    }
}

const fn vm_cpu_phase_label(phase: VmCpuPhase) -> &'static str {
    match phase {
        VmCpuPhase::BootBurst => "boot_burst",
        VmCpuPhase::Steady => "steady",
    }
}

fn validate_vm_cpu_sample(expected_generation: &ValidatedId, sample: &VmCpuSample) -> Result<()> {
    anyhow::ensure!(
        sample.generation == *expected_generation,
        "jailerd sampled a different VM generation"
    );
    let attestation = sample
        .cpu_runtime
        .attestation
        .as_ref()
        .context("jailerd CPU sample omitted live quota attestation")?;
    anyhow::ensure!(
        attestation.quota == sample.cpu_runtime.effective_quota
            && attestation.cpu_max == sample.cpu_runtime.effective_quota.cpu_max()
            && attestation.cpu_max_burst == 0
            && attestation.verified_at_unix_ms == sample.sampled_at_unix_ms,
        "jailerd CPU sample quota attestation did not match the live runtime state"
    );
    Ok(())
}

fn validate_vm_cpu_sample_point(point: VmCpuSamplePoint, sample: &VmCpuSample) -> Result<()> {
    let expected_phase = match point {
        VmCpuSamplePoint::VmBootAccepted
        | VmCpuSamplePoint::KinoReady
        | VmCpuSamplePoint::PreSeal => VmCpuPhase::BootBurst,
        VmCpuSamplePoint::PostSeal | VmCpuSamplePoint::TerminalPublished => VmCpuPhase::Steady,
    };
    anyhow::ensure!(
        sample.cpu_runtime.phase == expected_phase,
        "CPU sample point {} observed {} instead of {}",
        point.as_str(),
        vm_cpu_phase_label(sample.cpu_runtime.phase),
        vm_cpu_phase_label(expected_phase),
    );
    Ok(())
}

fn accept_vm_cpu_sample(
    name: &str,
    generation: &ValidatedId,
    point: VmCpuSamplePoint,
    sample: &VmCpuSample,
) -> Option<VmBootCpuSampleV1> {
    if let Err(error) = validate_vm_cpu_sample(generation, sample)
        .and_then(|()| validate_vm_cpu_sample_point(point, sample))
    {
        warn!(
            vm = name,
            generation = %generation,
            sample_point = point.as_str(),
            error = %format!("{error:#}"),
            "rejected invalid VM CPU sample"
        );
        return None;
    }
    let runtime = &sample.cpu_runtime;
    let attestation = runtime
        .attestation
        .as_ref()
        .expect("validated CPU sample includes an attestation");
    info!(
        event = "vm_cpu_sample",
        vm = name,
        generation = %sample.generation,
        sample_point = point.as_str(),
        sampled_at_unix_ms = sample.sampled_at_unix_ms,
        cpu_phase = vm_cpu_phase_label(runtime.phase),
        steady_cpu_millis = runtime.steady_quota.cpu_millis,
        effective_cpu_millis = runtime.effective_quota.cpu_millis,
        boot_deadline_unix_ms = ?runtime.boot_deadline_unix_ms,
        cpu_max = %attestation.cpu_max,
        cpu_max_burst = attestation.cpu_max_burst,
        quota_verified_at_unix_ms = attestation.verified_at_unix_ms,
        usage_usec = sample.cpu_stat.usage_usec,
        user_usec = sample.cpu_stat.user_usec,
        system_usec = sample.cpu_stat.system_usec,
        nr_periods = sample.cpu_stat.nr_periods,
        nr_throttled = sample.cpu_stat.nr_throttled,
        throttled_usec = sample.cpu_stat.throttled_usec,
        "captured VM CPU runtime sample"
    );
    let sampled_at_unix_ms = match i64::try_from(sample.sampled_at_unix_ms) {
        Ok(value) => value,
        Err(_) => {
            warn!(
                vm = name,
                generation = %generation,
                sample_point = point.as_str(),
                "discarding VM CPU sample with out-of-range timestamp"
            );
            return None;
        }
    };
    let quota_verified_at_unix_ms = match i64::try_from(attestation.verified_at_unix_ms) {
        Ok(value) => value,
        Err(_) => {
            warn!(
                vm = name,
                generation = %generation,
                sample_point = point.as_str(),
                "discarding VM CPU sample with out-of-range quota timestamp"
            );
            return None;
        }
    };
    Some(VmBootCpuSampleV1 {
        point: point.contract(),
        sampled_at_unix_ms,
        phase: match runtime.phase {
            VmCpuPhase::BootBurst => VmRuntimeConstraintPhaseV1::BootBurst,
            VmCpuPhase::Steady => VmRuntimeConstraintPhaseV1::Steady,
        },
        steady_cpu_millis: runtime.steady_quota.cpu_millis,
        effective_cpu_millis: runtime.effective_quota.cpu_millis,
        boot_deadline_unix_ms: runtime
            .boot_deadline_unix_ms
            .and_then(|value| i64::try_from(value).ok()),
        cpu_max: attestation.cpu_max.clone(),
        cpu_max_burst: attestation.cpu_max_burst,
        quota_verified_at_unix_ms,
        usage_usec: sample.cpu_stat.usage_usec,
        user_usec: sample.cpu_stat.user_usec,
        system_usec: sample.cpu_stat.system_usec,
        nr_periods: sample.cpu_stat.nr_periods,
        nr_throttled: sample.cpu_stat.nr_throttled,
        throttled_usec: sample.cpu_stat.throttled_usec,
    })
}

async fn capture_vm_cpu_sample(
    inner: &Inner,
    name: &str,
    generation: &ValidatedId,
    point: VmCpuSamplePoint,
) -> Option<VmBootCpuSampleV1> {
    // Telemetry must never extend the privileged boot lease. A healthy local
    // SOCK_SEQPACKET/cgroup read completes in a few milliseconds; abandon the
    // sample if the daemon is busy and let quota finalization proceed.
    let response = match timeout(
        Duration::from_millis(50),
        request_jailerd(
            inner,
            JailerRequest::SampleVmCpu(SampleVmCpuRequest {
                generation: generation.clone(),
            }),
        ),
    )
    .await
    {
        Ok(response) => response,
        Err(_) => {
            warn!(
                vm = name,
                generation = %generation,
                sample_point = point.as_str(),
                "skipping VM CPU sample because the 50ms telemetry budget expired"
            );
            return None;
        }
    };
    let sample = match response {
        Ok(JailerResponse::SampleVmCpu(sample)) => sample,
        Ok(JailerResponse::Error(error)) => {
            warn!(
                vm = name,
                generation = %generation,
                sample_point = point.as_str(),
                error_code = %error.code,
                error_message = %error.message,
                "failed to capture VM CPU sample"
            );
            return None;
        }
        Ok(response) => {
            warn!(
                vm = name,
                generation = %generation,
                sample_point = point.as_str(),
                response = ?response,
                "jailerd returned an unexpected VM CPU sample response"
            );
            return None;
        }
        Err(error) => {
            warn!(
                vm = name,
                generation = %generation,
                sample_point = point.as_str(),
                error = %format!("{error:#}"),
                "failed to request VM CPU sample"
            );
            return None;
        }
    };
    accept_vm_cpu_sample(name, generation, point, &sample)
}

async fn commit_ready_vm_and_probe(
    inner: &Inner,
    name: &str,
    generation: &ValidatedId,
    ready: &ProbeUpdateEnvelope,
) -> Result<()> {
    anyhow::ensure!(
        ready.vm_name == name,
        "Kino ready snapshot identifies a different VM"
    );
    anyhow::ensure!(
        ready.jail_generation == generation.as_str(),
        "Kino ready snapshot generation does not match the live generation"
    );
    anyhow::ensure!(
        ready.collection_state == ProbeCollectionState::Ok,
        "Kino ready snapshot is not successful"
    );
    let probe_row = probe_state_row(ready)?;
    let now_s = now_unix_s();
    let observed_at = now_unix_ms();

    // Hold the state generation fence until SQLite acknowledges both rows.
    // This prevents a delete/recreate from being overwritten by a stale ready
    // commit while keeping external publication strictly after durability.
    let mut states = inner.states.write().await;
    let current = states
        .get_mut(name)
        .ok_or_else(|| anyhow::anyhow!("VM state disappeared during ready commit"))?;
    let mut committed = current.clone();
    let details = committed
        .details
        .as_mut()
        .context("VM details disappeared during ready commit")?;
    anyhow::ensure!(
        details.run_id.as_deref() == Some(ready.run_id.as_str()),
        "Kino ready snapshot run does not match the live VM"
    );
    anyhow::ensure!(
        details.jail_generation.as_deref() == Some(generation.as_str()),
        "VM generation changed during ready commit"
    );
    let runtime = details
        .cpu_runtime
        .as_ref()
        .context("VM has no live CPU quota attestation during ready commit")?;
    anyhow::ensure!(
        runtime.phase == VmCpuPhase::Steady
            && runtime.effective_quota == runtime.steady_quota
            && runtime.attestation.is_some(),
        "VM CPU quota is not attested steady during ready commit"
    );
    details.ssh_host_keys_openssh = normalize_ssh_host_keys(ready.ssh_host_keys_openssh.clone());
    committed.state = VmLifecycleState::Running;
    committed.updated_at_s = now_s;
    committed.updated_at = format_rfc3339_s(now_s);
    committed.error = None;
    committed.running_at_s.get_or_insert(now_s);
    committed.lease_expires_at =
        compute_lease_expires_at(committed.running_at_s, committed.lease_duration_seconds);

    let terminal = terminal_state_from_vm(&committed, &inner.ssh_access, true, observed_at)
        .context("ready VM is missing terminal identity")?;
    if committed
        .details
        .as_ref()
        .and_then(|details| details.ssh_public_port)
        .is_some()
    {
        anyhow::ensure!(
            terminal.state == VmTerminalStateKind::Ready && terminal.terminal_target.is_some(),
            "authenticated SSH did not produce a terminal-ready state"
        );
    }

    inner
        .db
        .upsert_ready_vm_and_probe_state(committed.to_db_row(), probe_row)
        .await
        .context("atomically persist running VM and Kino snapshot")?;
    *current = committed;
    Ok(())
}

async fn terminal_state_for_attested_ready(
    inner: &Inner,
    name: &str,
    generation: &ValidatedId,
    boot_evidence: Option<VmBootEvidenceV1>,
) -> Result<VmTerminalState> {
    if let Some(evidence) = &boot_evidence {
        anyhow::ensure!(
            evidence.generation == generation.as_str(),
            "VM boot evidence generation does not match the live generation"
        );
    }
    let mut states = inner.states.write().await;
    let vm = states
        .get_mut(name)
        .context("VM state disappeared before terminal-ready publication")?;
    let expects_terminal = {
        let details = vm
            .details
            .as_mut()
            .context("VM details disappeared before terminal-ready publication")?;
        anyhow::ensure!(
            details.jail_generation.as_deref() == Some(generation.as_str()),
            "VM generation changed before terminal-ready publication"
        );
        details.boot_evidence = boot_evidence;
        details.ssh_public_port.is_some()
    };
    anyhow::ensure!(
        vm.state == VmLifecycleState::Running,
        "VM is not durably running before terminal-ready publication"
    );
    let terminal = terminal_state_from_vm(vm, &inner.ssh_access, true, now_unix_ms())
        .context("ready VM is missing terminal identity")?;
    if expects_terminal {
        anyhow::ensure!(
            terminal.state == VmTerminalStateKind::Ready && terminal.terminal_target.is_some(),
            "authenticated SSH did not produce a terminal-ready state"
        );
    }
    Ok(terminal)
}

async fn persist_cpu_runtime(
    inner: &Inner,
    name: &str,
    generation: &ValidatedId,
    runtime: VmCpuRuntimeState,
) -> Result<()> {
    let persisted = {
        let mut states = inner.states.write().await;
        let vm = states
            .get_mut(name)
            .ok_or_else(|| anyhow::anyhow!("VM state disappeared during CPU quota finalization"))?;
        let details = vm.details.as_mut().ok_or_else(|| {
            anyhow::anyhow!("VM details disappeared during CPU quota finalization")
        })?;
        anyhow::ensure!(
            details.jail_generation.as_deref() == Some(generation.as_str()),
            "VM generation changed during CPU quota finalization"
        );
        details.cpu_runtime = Some(runtime);
        vm.clone()
    };
    inner
        .db
        .upsert_vm(persisted.to_db_row())
        .await
        .context("persist finalized VM CPU runtime")
}

async fn seal_ready_vm_cpu(
    inner: &Inner,
    name: &str,
    generation: &ValidatedId,
    expect_ssh_forward: bool,
) -> Result<FinalizeVmBootResult> {
    let host_keys = {
        let states = inner.states.read().await;
        let details = states
            .get(name)
            .and_then(|vm| vm.details.as_ref())
            .context("VM details disappeared before CPU quota finalization")?;
        anyhow::ensure!(
            details.jail_generation.as_deref() == Some(generation.as_str()),
            "VM generation changed before CPU quota finalization"
        );
        details.ssh_host_keys_openssh.clone()
    };
    if expect_ssh_forward {
        anyhow::ensure!(
            !host_keys.is_empty(),
            "Kino readiness did not include an SSH host key"
        );
    }
    let finalized = finalize_jailed_vm_boot(inner, generation, expect_ssh_forward)
        .await
        .context("seal VM boot CPU and activate steady-state ingress")?;
    persist_cpu_runtime(inner, name, generation, finalized.cpu_runtime.clone())
        .await
        .context("persist steady CPU quota evidence")?;
    Ok(finalized)
}

fn artifact_source(
    path: &Path,
    allowed_source_roots: &[PathBuf],
    sha256: Option<&str>,
    access: ArtifactAccess,
) -> Result<ArtifactSource> {
    let (source_root, relative_path) = allowed_source_roots
        .iter()
        .enumerate()
        .find_map(|(index, root)| {
            let relative = path.strip_prefix(root).ok()?;
            (!relative.as_os_str().is_empty()
                && relative
                    .components()
                    .all(|component| matches!(component, std::path::Component::Normal(_))))
            .then(|| (index, relative.to_path_buf()))
        })
        .context("jailer artifact path is outside the configured trusted source roots")?;
    let source_root = u16::try_from(source_root).context("too many jailer source roots")?;
    let sha256 = sha256
        .map(|value| Sha256Digest::parse(value.to_ascii_lowercase()))
        .transpose()
        .context("validate jailer artifact SHA-256")?;
    Ok(ArtifactSource {
        source_root,
        relative_path,
        sha256,
        access,
    })
}

async fn persist_jail_launch(
    inner: &Inner,
    name: &str,
    launch: &VmLaunchResult,
    run_network: &RunNetworkResult,
) -> Result<()> {
    let persisted = {
        let mut states = inner.states.write().await;
        let vm = states
            .get_mut(name)
            .ok_or_else(|| anyhow::anyhow!("VM state disappeared during jailed launch"))?;
        let details = vm
            .details
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("VM details disappeared during jailed launch"))?;
        details.root_disk_path = launch.paths.host_root_disk.display().to_string();
        details.seed_disk_path = launch.paths.host_runtime_disk.display().to_string();
        // Keep the trusted agent-side export path. Jailerd owns the live disk
        // and copies it back to this path only after StopVm has drained the
        // unit; the unprivileged agent never opens a jail disk directly.
        details.ch_socket_path = Some(launch.paths.host_api_socket.display().to_string());
        details.ch_pid = launch.pid;
        details.ch_start_time_ticks = launch.pid_start_time_ticks;
        details.host_boot_id = launch.host_boot_id.clone();
        details.ch_executable_sha256 = Some(launch.cloud_hypervisor_sha256.clone());
        details.jail_generation = Some(launch.generation.as_str().to_string());
        details.jail_unit_name = Some(launch.unit_name.clone());
        details.jail_cgroup_path = launch
            .cgroup_path
            .as_ref()
            .map(|path| path.display().to_string());
        details.jail_root_path = Some(launch.paths.host_jail_root.display().to_string());
        details.jail_root_inode = launch.jail_root_inode;
        details.jail_uid = Some(launch.uid);
        details.jail_gid = Some(launch.gid);
        details.jail_netns_name = Some(launch.netns_name.clone());
        details.cpu_runtime = Some(launch.cpu_runtime.clone());
        details.bridge_name = Some(run_network.bridge_name.clone());
        details.kino_vsock_path = Some(launch.paths.host_vsock_socket.display().to_string());
        vm.clone()
    };
    inner
        .db
        .upsert_vm(persisted.to_db_row())
        .await
        .context("persist jailed VM runtime identity")
}

async fn remove_agent_launch_sources(req: &RunCreateInput<'_>) -> Result<()> {
    let root_parent = req
        .root_disk_path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("root disk staging path has no parent"))?;
    if req.config_disk_path.parent() != Some(root_parent) {
        anyhow::bail!("root and runtime disk staging paths do not share a VM directory");
    }

    match tokio::fs::remove_dir_all(root_parent).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(anyhow::anyhow!(
                "failed to remove staged VM sources {}: {error}",
                root_parent.display()
            ));
        }
    }
    match tokio::fs::remove_file(req.recording_disk_path).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(anyhow::anyhow!(
                "failed to remove staged recording disk {}: {error}",
                req.recording_disk_path.display()
            ));
        }
    }
    Ok(())
}

async fn run_create(inner: &Arc<Inner>, req: RunCreateInput<'_>) -> Result<()> {
    let create_started_at = Instant::now();
    let create_started_at_unix_ms = now_unix_ms();
    let mut cpu_samples = Vec::with_capacity(5);
    set_state(inner, req.name, VmLifecycleState::CachingImage).await;

    // New-run network construction and descriptor validation are independent.
    // Hold the per-run lifecycle fence while both proceed so a concurrent
    // cleanup cannot remove topology underneath this launch.
    let run_launch_guard = acquire_run_cleanup_lock(&inner.run_cleanup_locks, req.run_id).await;
    ensure_create_not_deleted(inner, req.name).await?;
    let cache_root =
        image_cache::default_cache_root().context("failed to determine image cache root")?;
    let network_inner = Arc::clone(inner);
    let network_run_id = req.run_id.to_string();
    let network_config = req.network.clone();
    let network_task = tokio::spawn(async move {
        let result =
            ensure_jailed_run_network(&network_inner, &network_run_id, &network_config).await;
        (result, Instant::now())
    });
    let _network_abort = AbortTaskOnDrop(network_task.abort_handle());
    let ready_image = image_cache::require_ready_image_launch(
        &cache_root,
        req.image_key,
        Some(req.expected_image_sha256),
    )
    .await
    .context("image is not eligible for foreground launch")?;
    let image_ready_at = Instant::now();
    let cached_image = ready_image.image;
    let prepared_image = ready_image.prepared_image;
    if let Err(error) = image_cache::touch_cached_image(&inner.db, &cached_image).await {
        warn!(
            error = %error,
            vm = req.name,
            image = %cached_image.image_key,
            "failed to update image cache access metadata"
        );
    }
    {
        let persisted = {
            let mut states = inner.states.write().await;
            let Some(vm) = states.get_mut(req.name) else {
                return Ok(());
            };
            if let Some(details) = vm.details.as_mut() {
                details.image_key = Some(cached_image.image_key.clone());
                details.image_sha256 = Some(cached_image.image_sha256.clone());
            }
            vm.clone()
        };
        if let Err(error) = inner.db.upsert_vm(persisted.to_db_row()).await {
            warn!(
                error = %error,
                vm = req.name,
                "failed to persist vm cached image identity"
            );
        }
    }
    ensure_create_not_deleted(inner, req.name).await?;
    set_state(inner, req.name, VmLifecycleState::PreparingDisks).await;

    let base_virtual_size_bytes = cached_image.virtual_size_bytes;
    if let Some(target_disk_mib) = req.disk_mib {
        let target_bytes = u64::from(target_disk_mib) * 1024 * 1024;
        if target_bytes < base_virtual_size_bytes {
            anyhow::bail!(
                "requested disk_mib {} MiB is smaller than the base image size {} MiB",
                target_disk_mib,
                base_virtual_size_bytes / (1024 * 1024)
            );
        }
    }
    let root_resize_required = req.disk_mib.is_some_and(|target_disk_mib| {
        u64::from(target_disk_mib) * 1024 * 1024 > base_virtual_size_bytes
    });

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
    let peer_guest_ips = req.peer_guest_ips.clone();
    let hostname = req.hostname.to_string();
    let runtime_disk_task = tokio::task::spawn_blocking(move || {
        let result = runtime_disk::write_runtime_disk(&runtime_disk::RuntimeDiskInput {
            path: &config_disk_path,
            ssh_authorized_keys_openssh: &ssh_authorized_keys_openssh,
            kino_vsock_cid,
            kino_vsock_port,
            kino_host_ready_port,
            hostname: &hostname,
            network: &network,
            root_resize_required,
            peer_guest_ips: &peer_guest_ips,
        });
        (result, Instant::now())
    });
    let (runtime_disk_result, network_result) = tokio::join!(runtime_disk_task, network_task);
    let (runtime_disk_result, runtime_disk_ready_at) =
        runtime_disk_result.context("scenario runtime disk task panicked")?;
    let (run_network, network_ready_at) = network_result.context("run network task panicked")?;
    let run_network = run_network.context("failed to ensure jailed run network")?;
    runtime_disk_result.context("failed to write scenario runtime disk")?;
    ensure_create_not_deleted(inner, req.name).await?;
    let disks_ready_at = Instant::now();

    set_state(inner, req.name, VmLifecycleState::CreatingVm).await;

    let launch_deadline = Instant::now() + Duration::from_secs(SCENARIO_READY_MAX_TIMEOUT_SECONDS);
    let mut capacity_attempt = 0_u32;
    let launch = loop {
        match launch_jailed_cloud_hypervisor(inner, &req, &cached_image, &prepared_image).await {
            Ok(result) => break result,
            Err(error) if error.downcast_ref::<BootCapacityPending>().is_some() => {
                ensure_create_not_deleted(inner, req.name).await?;
                if Instant::now() >= launch_deadline {
                    return Err(error).context("timed out waiting for jailerd boot CPU capacity");
                }
                let delay = boot_capacity_retry_delay(capacity_attempt);
                capacity_attempt = capacity_attempt.saturating_add(1);
                debug!(
                    vm = req.name,
                    attempt = capacity_attempt,
                    delay_ms = delay.as_millis(),
                    "waiting for capacity-accounted VM boot CPU"
                );
                tokio::time::sleep(delay).await;
            }
            Err(error) => return Err(error),
        }
    };
    persist_jail_launch(inner, req.name, &launch, &run_network).await?;
    drop(run_launch_guard);

    remove_agent_launch_sources(&req)
        .await
        .context("remove unprivileged launch staging files")?;
    ensure_create_not_deleted(inner, req.name).await?;
    let jail_ready_at = Instant::now();

    let vm_cfg = build_cloud_hypervisor_vm_config(CloudHypervisorVmConfigInput {
        name: req.name,
        cmdline: &cached_image.cmdline,
        paths: &launch.paths,
        vcpus: req.vcpus,
        memory_mib: req.memory_mib,
        tap: req.tap,
        mac: req.mac,
        kino_vsock_cid: req.kino_vsock_cid,
    })?;

    // LaunchVm returns only after jailerd has pinned and pinged the API socket.
    // Repeating the readiness loop here adds another VMM API request and up to
    // one polling interval to every boot. Recovery still uses the bounded
    // readiness helper because it does not inherit that launch attestation.
    let ch = ChClient::new(launch.paths.host_api_socket.display().to_string())
        .context("open jailerd-attested cloud-hypervisor API socket")?;
    let vmm_ready_at = Instant::now();

    debug!("calling cloud-hypervisor vm.create");
    ch.vm_create(&vm_cfg)
        .await
        .context("cloud-hypervisor vm.create failed")?;

    set_state(inner, req.name, VmLifecycleState::BootingVm).await;

    let mut details = {
        let states = inner.states.read().await;
        states
            .get(req.name)
            .and_then(|vm| vm.details.clone())
            .ok_or_else(|| anyhow::anyhow!("VM state disappeared after jailed launch"))?
    };
    details.ssh_host_keys_openssh = current_ssh_host_keys(inner, req.name).await;
    let readiness_updates = inner.kino_readiness_tx.subscribe();
    // Bind and activate the guest-initiated readiness socket before boot. A
    // fast guest's first Kino push must not race listener startup and fall
    // through to Kino's reconnect interval.
    start_probe_worker(inner, req.name, &details)
        .await
        .context("failed to start vm probe worker")?;

    debug!("calling cloud-hypervisor vm.boot");
    ch.vm_boot()
        .await
        .context("cloud-hypervisor vm.boot failed")?;
    ensure_create_not_deleted(inner, req.name).await?;
    let boot_accepted_at = Instant::now();
    if let Some(sample) = capture_vm_cpu_sample(
        inner,
        req.name,
        &launch.generation,
        VmCpuSamplePoint::VmBootAccepted,
    )
    .await
    {
        cpu_samples.push(sample);
    }

    let ready = wait_for_scenario_runtime_ready(inner, req.name, &ch, &details, readiness_updates)
        .await
        .context("scenario runtime did not become ready")?;
    ensure_create_not_deleted(inner, req.name).await?;
    let guest_ready_at = Instant::now();
    if let Some(sample) = capture_vm_cpu_sample(
        inner,
        req.name,
        &launch.generation,
        VmCpuSamplePoint::KinoReady,
    )
    .await
    {
        cpu_samples.push(sample);
    }
    let finalized = seal_ready_vm_cpu(
        inner,
        req.name,
        &launch.generation,
        req.ssh_public_port.is_some(),
    )
    .await?;
    let quota_sealed_at = Instant::now();
    if let Some(sample) = finalized.pre_seal_cpu_sample.as_ref().and_then(|sample| {
        accept_vm_cpu_sample(
            req.name,
            &launch.generation,
            VmCpuSamplePoint::PreSeal,
            sample,
        )
    }) {
        cpu_samples.push(sample);
    }
    if let Some(sample) = finalized.post_seal_cpu_sample.as_ref().and_then(|sample| {
        accept_vm_cpu_sample(
            req.name,
            &launch.generation,
            VmCpuSamplePoint::PostSeal,
            sample,
        )
    }) {
        cpu_samples.push(sample);
    }
    if req.ssh_public_port.is_some() {
        wait_for_guest_ssh_before_running(inner, req.name, &launch.generation).await?;
    }
    ensure_create_not_deleted(inner, req.name).await?;
    let ssh_verified_at = Instant::now();

    // The VM can become externally ready only after jailerd has live-read the
    // steady cgroup quota, activated DNAT, and the agent has authenticated the
    // guest host key. Capture the final quota boundary, atomically commit
    // Running + Kino state, then emit exactly one composite ready event.
    if let Some(sample) = capture_vm_cpu_sample(
        inner,
        req.name,
        &launch.generation,
        VmCpuSamplePoint::TerminalPublished,
    )
    .await
    {
        cpu_samples.push(sample);
    }
    commit_ready_vm_and_probe(inner, req.name, &launch.generation, &ready)
        .await
        .context("durably commit sealed VM readiness")?;
    let terminal_ready_at = Instant::now();
    let ready_at_unix_ms = now_unix_ms();
    let phases = VmBootTimeline {
        create_started_at,
        image_ready_at,
        runtime_disk_ready_at,
        network_ready_at,
        disks_ready_at,
        jail_ready_at,
        vmm_ready_at,
        boot_accepted_at,
        guest_ready_at,
        quota_sealed_at,
        ssh_verified_at,
        terminal_ready_at,
    }
    .phase_durations();
    let boot_evidence = VmBootEvidenceV1 {
        generation: launch.generation.as_str().to_string(),
        started_at_unix_ms: create_started_at_unix_ms,
        ready_at_unix_ms,
        phases,
        cpu_samples,
    };
    let terminal =
        terminal_state_for_attested_ready(inner, req.name, &launch.generation, Some(boot_evidence))
            .await
            .context("build generation-fenced terminal-ready projection")?;
    emit_terminal_state_update(inner, terminal, false).await;
    start_terminal_worker(inner, req.name)
        .await
        .context("failed to start vm terminal worker")?;
    info!(
        image_cache_ms = image_ready_at.duration_since(create_started_at).as_millis(),
        disk_stage_ms = disks_ready_at.duration_since(image_ready_at).as_millis(),
        jail_launch_ms = jail_ready_at.duration_since(disks_ready_at).as_millis(),
        vmm_start_ms = vmm_ready_at.duration_since(jail_ready_at).as_millis(),
        vm_api_ms = boot_accepted_at.duration_since(vmm_ready_at).as_millis(),
        guest_ready_ms = guest_ready_at.duration_since(boot_accepted_at).as_millis(),
        quota_seal_ms = quota_sealed_at.duration_since(guest_ready_at).as_millis(),
        ssh_verify_ms = ssh_verified_at.duration_since(quota_sealed_at).as_millis(),
        terminal_publish_ms = terminal_ready_at
            .duration_since(ssh_verified_at)
            .as_millis(),
        total_ms = terminal_ready_at
            .duration_since(create_started_at)
            .as_millis(),
        "vm booted"
    );

    Ok(())
}

#[derive(Clone, Copy, Debug)]
struct VmBootTimeline {
    create_started_at: Instant,
    image_ready_at: Instant,
    runtime_disk_ready_at: Instant,
    network_ready_at: Instant,
    disks_ready_at: Instant,
    jail_ready_at: Instant,
    vmm_ready_at: Instant,
    boot_accepted_at: Instant,
    guest_ready_at: Instant,
    quota_sealed_at: Instant,
    ssh_verified_at: Instant,
    terminal_ready_at: Instant,
}

impl VmBootTimeline {
    fn phase_durations(self) -> VmBootPhaseDurationsV1 {
        let network_ms = duration_ms(
            self.network_ready_at
                .saturating_duration_since(self.create_started_at),
        );
        VmBootPhaseDurationsV1 {
            image_disk_ms: duration_ms(self.image_ready_at - self.create_started_at)
                .saturating_add(duration_ms(
                    self.runtime_disk_ready_at - self.image_ready_at,
                )),
            network_jailer_vmm_ms: network_ms
                .saturating_add(duration_ms(self.jail_ready_at - self.disks_ready_at))
                .saturating_add(duration_ms(self.vmm_ready_at - self.jail_ready_at))
                .saturating_add(duration_ms(self.boot_accepted_at - self.vmm_ready_at)),
            guest_to_kino_ms: duration_ms(self.guest_ready_at - self.boot_accepted_at),
            seal_ssh_publish_ms: duration_ms(self.terminal_ready_at - self.guest_ready_at),
            total_ms: duration_ms(self.terminal_ready_at - self.create_started_at),
            image_cache_ms: duration_ms(self.image_ready_at - self.create_started_at),
            runtime_disk_ms: duration_ms(self.runtime_disk_ready_at - self.image_ready_at),
            network_ms,
            jailer_stage_ms: duration_ms(self.jail_ready_at - self.disks_ready_at),
            vmm_start_ms: duration_ms(self.vmm_ready_at - self.jail_ready_at),
            vm_api_ms: duration_ms(self.boot_accepted_at - self.vmm_ready_at),
            quota_seal_ms: duration_ms(self.quota_sealed_at - self.guest_ready_at),
            ssh_verify_ms: duration_ms(self.ssh_verified_at - self.quota_sealed_at),
            terminal_publish_ms: duration_ms(self.terminal_ready_at - self.ssh_verified_at),
        }
    }
}

fn duration_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn boot_capacity_retry_delay(attempt: u32) -> Duration {
    let exponent = attempt.min(3);
    let base_ms = 100_u64.saturating_mul(1_u64 << exponent);
    let mut jitter_bytes = [0_u8; 2];
    let _ = getrandom_fill(&mut jitter_bytes);
    let jitter_ms = u64::from(u16::from_le_bytes(jitter_bytes)) % 201;
    Duration::from_millis(base_ms.saturating_add(jitter_ms).min(1_000))
}

async fn wait_for_scenario_runtime_ready(
    inner: &Arc<Inner>,
    vm_name: &str,
    ch: &ChClient,
    details: &VmDetails,
    mut updates: broadcast::Receiver<ProbeUpdateEnvelope>,
) -> Result<ProbeUpdateEnvelope> {
    let run_id = details
        .run_id
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("vm details missing run_id"))?;
    let jail_generation = details
        .jail_generation
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("vm details missing jail_generation"))?;
    let kino_vsock_path = details
        .kino_vsock_path
        .as_ref()
        .map(PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("vm details missing kino_vsock_path"))?;
    let cpu_millis = details
        .cpu_millis
        .ok_or_else(|| anyhow::anyhow!("vm details missing cpu_millis"))?;
    let ready_timeout = scenario_runtime_ready_timeout(cpu_millis)?;
    let mut saw_kino_vsock_socket = false;
    let mut process_interval = tokio::time::interval(Duration::from_millis(
        SCENARIO_READY_PROCESS_POLL_INTERVAL_MILLIS,
    ));
    process_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Consume Tokio's immediate first tick: vm.boot has just succeeded and the
    // readiness push is the primary signal, so neither liveness path needs to
    // steal quota from the VMM at t=0.
    process_interval.tick().await;
    let mut ch_interval = tokio::time::interval(Duration::from_secs(
        SCENARIO_READY_API_POLL_INTERVAL_SECONDS,
    ));
    ch_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ch_interval.tick().await;
    let mut last_error = None;

    let wait_result = timeout(ready_timeout, async {
        loop {
            ensure_create_not_deleted(inner, vm_name).await?;

            tokio::select! {
                update = updates.recv() => {
                    match update {
                        Ok(update)
                            if update.vm_name == vm_name
                                && update.run_id == run_id
                                && update.jail_generation == jail_generation => {
                            if update.collection_state == ProbeCollectionState::Ok {
                                ensure_scenario_runtime_process_live(vm_name, details).await?;
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
                _ = process_interval.tick() => {
                    ensure_scenario_runtime_process_live(vm_name, details).await?;

                    let socket_exists = kino_vsock_path.exists();
                    if socket_exists && !saw_kino_vsock_socket {
                        info!(
                            vm = vm_name,
                            path = %kino_vsock_path.display(),
                            "cloud-hypervisor created Kino vsock socket"
                        );
                        saw_kino_vsock_socket = true;
                    }

                }
                _ = ch_interval.tick() => {
                    match timeout(
                        Duration::from_secs(SCENARIO_READY_API_PROBE_TIMEOUT_SECONDS),
                        ch.vm_info(),
                    )
                    .await
                    {
                        Ok(Ok(info)) => {
                            if matches!(info.state, cloud_hypervisor_client::VmState::Shutdown) {
                                anyhow::bail!("scenario vm shut down before runtime became ready");
                            }
                        }
                        Ok(Err(cloud_hypervisor_client::Error::HttpStatus { status: 404, .. })) => {
                            anyhow::bail!("scenario vm disappeared before runtime became ready");
                        }
                        Ok(Err(error)) => {
                            debug!(
                                vm = vm_name,
                                error = %error,
                                "cloud-hypervisor vm_info failed while waiting for scenario readiness"
                            );
                        }
                        Err(_) => {
                            debug!(
                                vm = vm_name,
                                timeout_seconds = SCENARIO_READY_API_PROBE_TIMEOUT_SECONDS,
                                "cloud-hypervisor vm_info timed out while waiting for scenario readiness"
                            );
                        }
                    }
                }
            }
        }
    })
    .await;

    match wait_result {
        Ok(result) => result,
        Err(_) => {
            let error = last_error.unwrap_or_else(|| {
                anyhow::anyhow!(
                    "timed out waiting for Kino readiness push on {}",
                    kino_ready_socket_path(&kino_vsock_path).display()
                )
            });
            Err(error).context(scenario_runtime_timeout_context(
                &kino_vsock_path,
                saw_kino_vsock_socket,
                ready_timeout,
            ))
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ScenarioRuntimeProcessLiveness {
    Alive,
    Dead(String),
    Inconclusive,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ScenarioRuntimeProcessObservation {
    Present { state: char, start_time_ticks: u64 },
    Missing,
    Unavailable,
}

// `InspectVm` is an adoption authority, not a health-poll endpoint: jailerd
// deliberately quarantines a healthy unit when its API ping cannot prove the
// persisted identity. Poll the already-persisted process identity here so a
// transient API stall stays retryable while an exited/reused VMM fails fast.
// The caller's existing typed StopVm/DestroyVm path still owns all cleanup;
// this check never signals a persisted numeric PID.
async fn ensure_scenario_runtime_process_live(vm_name: &str, details: &VmDetails) -> Result<()> {
    match observe_scenario_runtime_process_liveness(vm_name, details).await {
        ScenarioRuntimeProcessLiveness::Alive | ScenarioRuntimeProcessLiveness::Inconclusive => {
            Ok(())
        }
        ScenarioRuntimeProcessLiveness::Dead(reason) => {
            anyhow::bail!("scenario VMM became unavailable before runtime readiness: {reason}")
        }
    }
}

async fn observe_scenario_runtime_process_liveness(
    vm_name: &str,
    details: &VmDetails,
) -> ScenarioRuntimeProcessLiveness {
    let Some(pid) = details.ch_pid else {
        return ScenarioRuntimeProcessLiveness::Inconclusive;
    };

    let proc_stat_path = PathBuf::from(format!("/proc/{pid}/stat"));
    let observation = match tokio::fs::read_to_string(&proc_stat_path).await {
        Ok(value) => match parse_linux_proc_stat(&value) {
            Some((state, start_time_ticks)) => ScenarioRuntimeProcessObservation::Present {
                state,
                start_time_ticks,
            },
            None => {
                debug!(
                    vm = vm_name,
                    pid,
                    path = %proc_stat_path.display(),
                    "could not parse scenario VMM process identity"
                );
                ScenarioRuntimeProcessObservation::Unavailable
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // A cross-UID process can be hidden from /proc by hidepid=2 or
            // ProtectProc=invisible. `kill(pid, 0)` does not send a signal;
            // it only distinguishes an absent PID (ESRCH) from a process
            // which exists but is either visible or permission-protected.
            let existence = i32::try_from(pid)
                .ok()
                .and_then(rustix::process::Pid::from_raw)
                .map(rustix::process::test_kill_process);
            if let Some(Err(error)) = existence.as_ref()
                && !matches!(*error, rustix::io::Errno::SRCH | rustix::io::Errno::PERM)
            {
                debug!(
                    vm = vm_name,
                    pid,
                    error = %error,
                    "could not disambiguate hidden scenario VMM process identity"
                );
            }
            classify_missing_proc_entry(existence)
        }
        Err(error) => {
            debug!(
                vm = vm_name,
                pid,
                error = %error,
                "could not read scenario VMM process identity"
            );
            ScenarioRuntimeProcessObservation::Unavailable
        }
    };

    classify_scenario_runtime_process_liveness(pid, details.ch_start_time_ticks, observation)
}

fn classify_missing_proc_entry(
    existence: Option<rustix::io::Result<()>>,
) -> ScenarioRuntimeProcessObservation {
    match existence {
        Some(Err(rustix::io::Errno::SRCH)) => ScenarioRuntimeProcessObservation::Missing,
        Some(Ok(())) | Some(Err(_)) | None => ScenarioRuntimeProcessObservation::Unavailable,
    }
}

fn classify_scenario_runtime_process_liveness(
    pid: u32,
    expected_start_time_ticks: Option<u64>,
    observation: ScenarioRuntimeProcessObservation,
) -> ScenarioRuntimeProcessLiveness {
    let ScenarioRuntimeProcessObservation::Present {
        state,
        start_time_ticks,
    } = observation
    else {
        return match observation {
            ScenarioRuntimeProcessObservation::Missing => {
                ScenarioRuntimeProcessLiveness::Dead(format!("VMM pid {pid} exited"))
            }
            ScenarioRuntimeProcessObservation::Unavailable => {
                ScenarioRuntimeProcessLiveness::Inconclusive
            }
            ScenarioRuntimeProcessObservation::Present { .. } => unreachable!(),
        };
    };

    if matches!(state, 'Z' | 'X' | 'x') {
        return ScenarioRuntimeProcessLiveness::Dead(format!(
            "VMM pid {pid} is no longer executable (process state {state})"
        ));
    }
    let Some(expected) = expected_start_time_ticks else {
        return ScenarioRuntimeProcessLiveness::Inconclusive;
    };
    if expected != start_time_ticks {
        return ScenarioRuntimeProcessLiveness::Dead(format!(
            "VMM pid {pid} was reused (expected start time {expected}, observed {start_time_ticks})"
        ));
    }
    ScenarioRuntimeProcessLiveness::Alive
}

fn parse_linux_proc_stat(value: &str) -> Option<(char, u64)> {
    let (_, fields) = value.rsplit_once(") ")?;
    let mut fields = fields.split_ascii_whitespace();
    let state = fields.next()?.chars().next()?;
    let start_time_ticks = fields.nth(18)?.parse().ok()?;
    Some((state, start_time_ticks))
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
        stop_cloud_hypervisor(inner, details, vm_name).await;
    }
}

async fn cleanup_jailed_vm_by_logical_id(inner: &Inner, run_id: &str, vm_name: &str) -> Result<()> {
    let selector = VmIdentityRequest::by_logical_id(
        ValidatedId::parse(run_id.to_owned()).context("validate logical cleanup run ID")?,
        ValidatedId::parse(vm_name.to_owned()).context("validate logical cleanup VM ID")?,
    );
    cleanup_jailed_vm_by_selector(inner, selector).await
}

async fn cleanup_jailed_vm_by_selector(inner: &Inner, selector: VmIdentityRequest) -> Result<()> {
    let stop_error =
        jailer_vm_selector_request(inner, selector.clone(), JailerIdentityOperation::Stop)
            .await
            .err()
            .map(|error| format!("logical VM stop request failed: {error:#}"));

    // Always follow StopVm with DestroyVm, including after a not-found stop.
    // Both operations resolve the same typed (run_id, vm_id) selector, and a
    // not-found response is an idempotent success. Avoid InspectVm here:
    // inspection is an adoption/liveness operation whose API-ping checks may
    // quarantine a partially launched VM before cleanup can drain it.
    let destroy_error =
        jailer_vm_selector_request(inner, selector, JailerIdentityOperation::Destroy)
            .await
            .err()
            .map(|error| format!("logical VM destroy request failed: {error:#}"));

    match (stop_error, destroy_error) {
        (None, None) => Ok(()),
        (Some(stop), None) => anyhow::bail!("{stop}"),
        (None, Some(destroy)) => anyhow::bail!("{destroy}"),
        (Some(stop), Some(destroy)) => anyhow::bail!("{stop}; {destroy}"),
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
        // Serialize the privileged release and durable local removal for every
        // VM in a run. Without this guard, two concurrent cleanups can both
        // observe the other tracked VM and both skip the shared run-network
        // destroy. Holding it until the SQLite row is removed makes the next
        // cleanup observe the completed predecessor, while a queued sibling
        // that is not being deleted still keeps the network alive.
        let _run_cleanup_guard = acquire_vm_run_cleanup_lock(inner, &vm).await;
        if let Err(e) = release_jailed_runtime(inner, &vm)
            .await
            .context("release jailed VM runtime during local cleanup")
        {
            let message = error_chain_to_string(&e);
            mark_vm_delete_failed(inner, &vm.name, message).await;
            return Err(e);
        }
        if let Err(e) = local_cleanup_tracked_vm(inner, &vm, true).await {
            let message = error_chain_to_string(&e);
            mark_vm_delete_failed(inner, &vm.name, message).await;
            return Err(e);
        }
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

    // Artifact capture and VMM shutdown can proceed concurrently, but the
    // generation/network release decision and local state removal must be one
    // ordered per-run operation. Failed release/archive work leaves the VM row
    // tracked, so a later retry still protects or removes the shared network.
    let _run_cleanup_guard = acquire_vm_run_cleanup_lock(inner, &vm).await;
    if let Err(e) = release_jailed_runtime(inner, &vm).await {
        let message = error_chain_to_string(&e);
        mark_vm_delete_failed(inner, &vm.name, message).await;
        return Err(e);
    }

    if inner.bridge.enabled {
        set_state(inner, &vm.name, VmLifecycleState::ArchivingArtifacts).await;
        if let Err(e) = queue_archive_job(inner, &prepared).await {
            let message = error_chain_to_string(&e);
            mark_vm_delete_failed(inner, &vm.name, message).await;
            return Err(e);
        }
        if let Err(e) = local_cleanup_tracked_vm(inner, &vm, false).await {
            let message = error_chain_to_string(&e);
            mark_vm_delete_failed(inner, &vm.name, message).await;
            return Err(e);
        }
        return Ok(CleanupOutcome::Deleted);
    }

    if let Err(e) = local_cleanup_tracked_vm(inner, &vm, true).await {
        let message = error_chain_to_string(&e);
        mark_vm_delete_failed(inner, &vm.name, message).await;
        return Err(e);
    }
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

    let Some(generation) = details.jail_generation.as_deref() else {
        // VMs created before the V6 jailer boundary are deliberately not
        // adoptable. The coordinated rollout drains them before upgrading;
        // incomplete pre-launch rows are safe to clean as dead state.
        return Ok(TrackedVmRuntimeStatus::Dead);
    };

    let Some(inspection) =
        jailer_identity_request(inner, generation, JailerIdentityOperation::Inspect).await?
    else {
        return Ok(TrackedVmRuntimeStatus::Dead);
    };

    if !inspection_matches_persisted(details, &inspection) {
        warn!(
            vm = vm.name,
            generation,
            "jailerd runtime identity does not match persisted VM identity; refusing reattach"
        );
        return Ok(TrackedVmRuntimeStatus::Inconclusive);
    }

    // Inspection is adoption evidence only. Never activate ingress merely
    // because SQLite says Running: the resumed worker must receive fresh Kino
    // readiness for this generation and execute the normal secure finalizer.
    let cpu_runtime = inspection.cpu_runtime.clone();
    {
        let mut states = inner.states.write().await;
        if let Some(current) = states.get_mut(&vm.name)
            && let Some(details) = current.details.as_mut()
        {
            details.cpu_runtime = Some(cpu_runtime);
        }
    }

    match inspection.health {
        SandboxHealth::Exited => return Ok(TrackedVmRuntimeStatus::Dead),
        SandboxHealth::Quarantined => return Ok(TrackedVmRuntimeStatus::Inconclusive),
        SandboxHealth::Preparing | SandboxHealth::Healthy | SandboxHealth::Stopping => {}
    }

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

    // jailerd still owns a matching unit/cgroup, but its API did not prove VM
    // identity and health. Keep the generation for quarantine/retry instead of
    // inferring liveness from a reusable numeric PID.
    Ok(TrackedVmRuntimeStatus::Inconclusive)
}

fn inspection_matches_persisted(details: &VmDetails, inspection: &VmInspection) -> bool {
    let same_optional_path = |persisted: Option<&str>, actual: Option<&Path>| match persisted {
        Some(persisted) => actual.is_some_and(|actual| actual == Path::new(persisted)),
        None => true,
    };

    details
        .jail_generation
        .as_deref()
        .is_some_and(|value| value == inspection.generation.as_str())
        && details
            .jail_unit_name
            .as_deref()
            .is_none_or(|value| value == inspection.unit_name)
        && same_optional_path(
            details.jail_cgroup_path.as_deref(),
            inspection.cgroup_path.as_deref(),
        )
        && details
            .ch_pid
            .is_none_or(|value| Some(value) == inspection.pid)
        && details
            .ch_start_time_ticks
            .is_none_or(|value| Some(value) == inspection.pid_start_time_ticks)
        && details
            .host_boot_id
            .as_deref()
            .is_none_or(|value| inspection.host_boot_id.as_deref() == Some(value))
        && details
            .ch_executable_sha256
            .as_deref()
            .is_some_and(|value| value == inspection.cloud_hypervisor_sha256)
        && details
            .jail_root_inode
            .is_none_or(|value| inspection.jail_root_inode == Some(value))
        && details.jail_uid.is_none_or(|value| value == inspection.uid)
        && details.jail_gid.is_none_or(|value| value == inspection.gid)
        && details
            .jail_netns_name
            .as_deref()
            .is_none_or(|value| value == inspection.netns_name)
        && details
            .jail_root_path
            .as_deref()
            .is_none_or(|value| Path::new(value) == inspection.paths.host_jail_root)
        && details
            .ch_socket_path
            .as_deref()
            .is_none_or(|value| Path::new(value) == inspection.paths.host_api_socket)
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

            let readiness_updates = inner_for_task.kino_readiness_tx.subscribe();
            start_probe_worker(&inner_for_task, &vm_name, &details)
                .await
                .context("failed to restart vm probe worker after startup resume")?;

            if live_state == TrackedVmLiveState::Created {
                debug!(vm = vm_name, "restarting boot for startup-recovered vm");
                ch.vm_boot()
                    .await
                    .context("cloud-hypervisor vm.boot failed during startup resume")?;
            }

            let ready = wait_for_scenario_runtime_ready(
                &inner_for_task,
                &vm_name,
                &ch,
                &details,
                readiness_updates,
            )
            .await?;
            let generation = ValidatedId::parse(
                details
                    .jail_generation
                    .clone()
                    .context("startup-recovered VM is missing its jail generation")?,
            )
            .context("validate startup-recovered jail generation")?;
            let expect_ssh_forward = details.ssh_public_port.is_some();
            seal_ready_vm_cpu(&inner_for_task, &vm_name, &generation, expect_ssh_forward)
                .await
                .context("securely finalize startup-recovered VM")?;
            if expect_ssh_forward {
                wait_for_guest_ssh_before_running(&inner_for_task, &vm_name, &generation).await?;
            }
            ensure_create_not_deleted(&inner_for_task, &vm_name).await?;
            commit_ready_vm_and_probe(&inner_for_task, &vm_name, &generation, &ready)
                .await
                .context("durably commit recovered VM readiness")?;
            let terminal =
                terminal_state_for_attested_ready(&inner_for_task, &vm_name, &generation, None)
                    .await
                    .context("build recovered terminal-ready projection")?;
            emit_terminal_state_update(&inner_for_task, terminal, false).await;
            start_terminal_worker(&inner_for_task, &vm_name)
                .await
                .context("failed to restart vm terminal worker after startup resume")?;
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
        if details.jail_generation.is_some() && !Path::new(recording_disk_path).is_file() {
            anyhow::bail!(
                "jailerd did not publish the drained recording export at {}",
                recording_disk_path
            );
        }
        extract_recordings_to_spool(Path::new(recording_disk_path), &artifacts_dir).await?;
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

    stop_cloud_hypervisor(inner, details, &vm.name).await;
}

async fn release_jailed_runtime(inner: &Inner, vm: &VmStatusResponse) -> Result<()> {
    let Some(details) = vm.details.as_ref() else {
        return Ok(());
    };

    if let Some(generation) = details.jail_generation.as_deref() {
        jailer_identity_request(inner, generation, JailerIdentityOperation::Destroy)
            .await
            .with_context(|| format!("destroy jail generation {generation}"))?;
    } else if let Some(selector) = generationless_v6_launch_cleanup_selector(vm)? {
        // A process crash can leave SQLite in any prelaunch state after
        // jailerd has committed LaunchVm but before persist_jail_launch records
        // the fresh generation (an earlier state transition may itself have
        // failed to persist). Resolve only that narrow V6 window by the
        // protocol's typed logical identity and drain it before considering
        // the shared run network. Historical generation-less rows do not
        // carry the V6 resource markers and deliberately stay local-only.
        cleanup_jailed_vm_by_selector(inner, selector)
            .await
            .context("destroy generation-less jailed launch")?;
    }

    let Some(run_id) = details.run_id.as_deref() else {
        return Ok(());
    };
    let has_other_vm = {
        let states = inner.states.read().await;
        has_other_tracked_vm_for_run(&states, &vm.name, run_id)
    };
    if has_other_vm {
        return Ok(());
    }

    let run_id = ValidatedId::parse(run_id.to_string()).context("validate persisted run ID")?;
    match request_jailerd(
        inner,
        JailerRequest::DestroyRunNetwork(DestroyRunNetworkRequest { run_id }),
    )
    .await?
    {
        JailerResponse::DestroyRunNetwork(_) => Ok(()),
        JailerResponse::Error(error) if error.code == "not_found" => Ok(()),
        JailerResponse::Error(error) => {
            anyhow::bail!("jailerd {}: {}", error.code, error.message)
        }
        response => anyhow::bail!(
            "jailerd returned unexpected response to destroy_run_network: {response:?}"
        ),
    }
}

fn generationless_v6_launch_cleanup_selector(
    vm: &VmStatusResponse,
) -> Result<Option<VmIdentityRequest>> {
    let Some(details) = vm.details.as_ref() else {
        return Ok(None);
    };
    if details.jail_generation.is_some()
        || details.cpu_millis.is_none()
        || details.vcpu_count.is_none()
    {
        return Ok(None);
    }

    let run_id = details
        .run_id
        .as_deref()
        .map(str::trim)
        .filter(|run_id| !run_id.is_empty())
        .context("generation-less V6 launch is missing its run ID")?;
    Ok(Some(VmIdentityRequest::by_logical_id(
        ValidatedId::parse(run_id.to_string())
            .context("validate generation-less V6 launch run ID")?,
        ValidatedId::parse(vm.name.clone()).context("validate generation-less V6 launch VM ID")?,
    )))
}

fn has_other_tracked_vm_for_run(
    states: &BTreeMap<String, VmStatusResponse>,
    vm_name: &str,
    run_id: &str,
) -> bool {
    states.iter().any(|(name, status)| {
        name != vm_name
            && status
                .details
                .as_ref()
                .and_then(|details| details.run_id.as_deref())
                == Some(run_id)
    })
}

async fn upload_vm_run_artifacts(
    inner: &Inner,
    vm_name: &str,
    prepared: &PreparedVmDeletion,
) -> Result<ArchiveUploadOutcome> {
    let access_token = bootstrap_agent_access_token(&inner.bridge, &inner.http).await?;
    let mut artifacts = collect_local_artifacts(&prepared.artifacts_dir).await?;

    if !begin_run_upload(inner, prepared, &artifacts, &access_token).await? {
        warn!(
            vm = vm_name,
            run_id = prepared.run_id,
            "remote run/vm missing during artifact upload begin; skipping upload and treating vm as orphaned local state"
        );
        return Ok(ArchiveUploadOutcome::DiscardedMissingRemote);
    }
    upload_artifact_set(inner, vm_name, prepared, &artifacts, &access_token).await?;

    // Render and attach session media before sealing the run. Once completion
    // is acknowledged the control plane rejects every new artifact mutation,
    // which makes hard deletion race-free with respect to this archive job.
    match render_replay_artifacts(&prepared.artifacts_dir, next_artifact_ordinal(&artifacts)).await
    {
        Ok(Some((casts, timeline))) => {
            let new_start = artifacts.len();
            artifacts.extend(casts);
            if !begin_run_upload(inner, prepared, &artifacts, &access_token).await? {
                warn!(
                    vm = vm_name,
                    run_id = prepared.run_id,
                    "remote run/vm vanished during replay registration; treating vm as orphaned local state"
                );
                return Ok(ArchiveUploadOutcome::DiscardedMissingRemote);
            }
            upload_artifact_set(
                inner,
                vm_name,
                prepared,
                &artifacts[new_start..],
                &access_token,
            )
            .await?;
            if let Err(error) = submit_run_timeline(inner, prepared, &timeline, &access_token).await
            {
                warn!(
                    error = %error,
                    vm = vm_name,
                    run_id = prepared.run_id,
                    "failed to submit session timeline; archiving run without one"
                );
            }
        }
        Ok(None) => {}
        Err(error) => {
            warn!(
                error = %error,
                vm = vm_name,
                run_id = prepared.run_id,
                "failed to render session media; archiving run without a replay"
            );
        }
    }

    complete_run_upload(inner, prepared, &access_token).await?;

    Ok(ArchiveUploadOutcome::Uploaded)
}

async fn complete_run_upload(
    inner: &Inner,
    prepared: &PreparedVmDeletion,
    access_token: &str,
) -> Result<()> {
    let run_id_segment = encode_url_path_segment(&prepared.run_id);
    let vm_name_segment = encode_url_path_segment(&prepared.vm_name);
    let complete_url = format!(
        "{}/agent/runs/{}/vms/{}/complete",
        inner.bridge.base_url, run_id_segment, vm_name_segment
    );
    let response = inner
        .http
        .post(&complete_url)
        .bearer_auth(access_token)
        .send()
        .await
        .with_context(|| format!("failed to complete run upload at {complete_url}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("run complete failed with status {status}: {body}");
    }
    Ok(())
}

/// Registers `artifacts` with the run upload. The endpoint merges by
/// ordinal, so calling this again with a superset only adds the new entries.
/// Returns `false` when the remote run/vm no longer exists.
async fn begin_run_upload(
    inner: &Inner,
    prepared: &PreparedVmDeletion,
    artifacts: &[LocalArtifact],
    access_token: &str,
) -> Result<bool> {
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
        .bearer_auth(access_token)
        .json(&begin_request)
        .send()
        .await
        .with_context(|| format!("failed to call run begin endpoint at {begin_url}"))?;
    if !begin_response.status().is_success() {
        let status = begin_response.status();
        let body = begin_response.text().await.unwrap_or_default();
        if is_run_purged_remote_response(status, &body) {
            return Ok(false);
        }
        anyhow::bail!("run begin failed with status {status}: {body}");
    }
    Ok(true)
}

async fn upload_artifact_set(
    inner: &Inner,
    vm_name: &str,
    prepared: &PreparedVmDeletion,
    artifacts: &[LocalArtifact],
    access_token: &str,
) -> Result<()> {
    stream::iter(artifacts.iter().cloned().map(|artifact| {
        let prepared = prepared.clone();
        let access_token = access_token.to_string();
        let vm_name = vm_name.to_string();
        async move {
            upload_single_artifact(inner, &prepared, &artifact, &access_token)
                .await
                .with_context(|| format!("failed to upload {} for {}", artifact.filename, vm_name))
        }
    }))
    .buffer_unordered(ARTIFACT_UPLOAD_CONCURRENCY)
    .try_collect::<Vec<_>>()
    .await?;
    Ok(())
}

fn next_artifact_ordinal(artifacts: &[LocalArtifact]) -> u32 {
    artifacts
        .iter()
        .map(|artifact| artifact.ordinal)
        .max()
        .unwrap_or(0)
        .saturating_add(1)
}

async fn render_replay_artifacts(
    artifacts_dir: &Path,
    first_ordinal: u32,
) -> Result<Option<(Vec<LocalArtifact>, replay_media::TimelineDocument)>> {
    let Some(rendered) = replay_media::render_session_media(artifacts_dir).await? else {
        return Ok(None);
    };
    let mut artifacts = Vec::with_capacity(rendered.cast_paths.len());
    let mut ordinal = first_ordinal;
    for path in &rendered.cast_paths {
        artifacts.push(
            describe_local_artifact(
                ordinal,
                replay_media::SESSION_CAST_KIND,
                path,
                "application/x-asciicast; charset=utf-8",
            )
            .await?,
        );
        ordinal = ordinal.saturating_add(1);
    }
    Ok(Some((artifacts, rendered.timeline)))
}

/// Hands the rendered timeline (session metadata + transcripts) to the
/// control plane, which stores it in its database — it never touches R2.
async fn submit_run_timeline(
    inner: &Inner,
    prepared: &PreparedVmDeletion,
    timeline: &replay_media::TimelineDocument,
    access_token: &str,
) -> Result<()> {
    let run_id_segment = encode_url_path_segment(&prepared.run_id);
    let vm_name_segment = encode_url_path_segment(&prepared.vm_name);
    let timeline_url = format!(
        "{}/agent/runs/{}/vms/{}/timeline",
        inner.bridge.base_url, run_id_segment, vm_name_segment
    );
    let response = inner
        .http
        .post(&timeline_url)
        .bearer_auth(access_token)
        .json(timeline)
        .send()
        .await
        .with_context(|| format!("failed to submit run timeline at {timeline_url}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("timeline submission failed with status {status}: {body}");
    }
    Ok(())
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

async fn remove_vm_staging_paths(vm_name: &str, vm_dir: &Path, spool_dir: &Path) -> Result<()> {
    let mut failures = Vec::new();
    for (kind, path) in [("vm dir", vm_dir), ("vm spool", spool_dir)] {
        match tokio::fs::remove_dir_all(path).await {
            Ok(()) => {
                info!(vm = vm_name, path = %path.display(), "removed staged {kind}");
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                failures.push(format!(
                    "failed to remove {kind} {}: {error}",
                    path.display()
                ));
            }
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        anyhow::bail!(failures.join("; "))
    }
}

async fn rollback_persisted_queued_vm(
    inner: &Inner,
    vm: &VmStatusResponse,
    vm_dir: &Path,
    spool_dir: &Path,
) -> Result<()> {
    remove_vm_staging_paths(&vm.name, vm_dir, spool_dir).await?;
    inner
        .db
        .delete_vm(vm.name.clone())
        .await
        .context("delete queued VM row during staging rollback")?;
    if !remove_matching_tracked_vm_state(inner, vm).await {
        anyhow::bail!("queued VM state changed during staging rollback")
    }
    clear_delete_request(inner, &vm.name).await;
    Ok(())
}

async fn remove_matching_tracked_vm_state(inner: &Inner, expected: &VmStatusResponse) -> bool {
    let mut states = inner.states.write().await;
    remove_matching_vm_state(&mut states, expected)
}

fn remove_matching_vm_state(
    states: &mut BTreeMap<String, VmStatusResponse>,
    expected: &VmStatusResponse,
) -> bool {
    let expected_run_id = expected
        .details
        .as_ref()
        .and_then(|details| details.run_id.as_deref());
    let matches = states.get(&expected.name).is_some_and(|current| {
        current.created_at_s == expected.created_at_s
            && current
                .details
                .as_ref()
                .and_then(|details| details.run_id.as_deref())
                == expected_run_id
    });
    if matches {
        states.remove(&expected.name);
    }
    matches
}

fn reserve_vm_state(
    states: &mut BTreeMap<String, VmStatusResponse>,
    status: VmStatusResponse,
) -> bool {
    if states.contains_key(&status.name) {
        return false;
    }
    states.insert(status.name.clone(), status);
    true
}

async fn local_cleanup_tracked_vm(
    inner: &Inner,
    vm: &VmStatusResponse,
    remove_spool_dir: bool,
) -> Result<()> {
    clear_delete_request(inner, &vm.name).await;
    stop_terminal_worker(inner, &vm.name).await;

    let mut filesystem_failures = Vec::new();

    if let Some(vm_dir) = agent_owned_vm_dir_for_status(vm) {
        match tokio::fs::remove_dir_all(&vm_dir).await {
            Ok(_) => {
                info!(vm = vm.name, path = %vm_dir.display(), "deleted vm dir");
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                filesystem_failures
                    .push(format!("failed to delete vm dir {}: {e}", vm_dir.display()));
            }
        }
    }

    if let Some(details) = vm.details.as_ref() {
        if details.jail_generation.is_none()
            && let Some(recording_disk_path) = details.recording_disk_path.as_deref()
            && let Err(e) = tokio::fs::remove_file(recording_disk_path).await
            && e.kind() != std::io::ErrorKind::NotFound
        {
            filesystem_failures.push(format!(
                "failed to delete recording disk {recording_disk_path}: {e}"
            ));
        }
        if remove_spool_dir
            && let Some(spool_dir) = details.spool_dir.as_deref()
            && let Err(e) = tokio::fs::remove_dir_all(spool_dir).await
            && e.kind() != std::io::ErrorKind::NotFound
        {
            filesystem_failures.push(format!("failed to delete run spool dir {spool_dir}: {e}"));
        }
    }

    if !filesystem_failures.is_empty() {
        anyhow::bail!(filesystem_failures.join("; "))
    }

    // Keep the in-memory row (and therefore sibling/network protection) until
    // SQLite has durably removed this VM. Db::delete_vm acknowledges the
    // actual SQL statement rather than merely queueing it to the DB thread.
    inner
        .db
        .delete_vm(vm.name.clone())
        .await
        .with_context(|| format!("delete VM {} from sqlite", vm.name))?;

    if !remove_matching_tracked_vm_state(inner, vm).await {
        warn!(
            vm = vm.name,
            "VM state changed after durable sqlite removal"
        );
    }
    {
        let mut fingerprints = inner.terminal_state_fingerprints.lock().await;
        fingerprints.remove(&vm.name);
    }

    info!(vm = vm.name, "cleaned up tracked vm");
    Ok(())
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
    acquire_cleanup_lock(&inner.cleanup_locks, name).await
}

async fn acquire_vm_run_cleanup_lock(
    inner: &Inner,
    vm: &VmStatusResponse,
) -> Option<OwnedMutexGuard<()>> {
    let run_id = vm
        .details
        .as_ref()
        .and_then(|details| details.run_id.as_deref())
        .map(str::trim)
        .filter(|run_id| !run_id.is_empty())?;
    Some(acquire_run_cleanup_lock(&inner.run_cleanup_locks, run_id).await)
}

async fn acquire_run_cleanup_lock(
    run_cleanup_locks: &Mutex<BTreeMap<String, Arc<Mutex<()>>>>,
    run_id: &str,
) -> OwnedMutexGuard<()> {
    acquire_cleanup_lock(run_cleanup_locks, run_id).await
}

async fn acquire_cleanup_lock(
    locks: &Mutex<BTreeMap<String, Arc<Mutex<()>>>>,
    key: &str,
) -> OwnedMutexGuard<()> {
    let lock = {
        let mut locks = locks.lock().await;
        Arc::clone(
            locks
                .entry(key.to_string())
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

async fn stop_cloud_hypervisor(inner: &Inner, details: &VmDetails, vm_name: &str) {
    if let Some(ch_socket_path) = details.ch_socket_path.as_deref()
        && Path::new(ch_socket_path).exists()
    {
        match ChClient::new(ch_socket_path.to_string()) {
            Ok(client) => {
                match timeout(
                    Duration::from_secs(DELETE_SHUTDOWN_GRACE_SECONDS),
                    client.vm_shutdown(),
                )
                .await
                {
                    Ok(Ok(())) => {
                        tokio::time::sleep(Duration::from_secs(DELETE_SHUTDOWN_GRACE_SECONDS))
                            .await;
                    }
                    Ok(Err(e)) => {
                        warn!(
                            error = %e,
                            vm = vm_name,
                            socket = ch_socket_path,
                            "failed to request cloud-hypervisor shutdown"
                        );
                    }
                    Err(_) => {
                        warn!(
                            vm = vm_name,
                            socket = ch_socket_path,
                            timeout_seconds = DELETE_SHUTDOWN_GRACE_SECONDS,
                            "timed out requesting cloud-hypervisor shutdown"
                        );
                    }
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

    if let Some(generation) = details.jail_generation.as_deref() {
        match jailer_identity_request(inner, generation, JailerIdentityOperation::Stop).await {
            Ok(_) => {}
            Err(error) => warn!(
                error = %error,
                vm = vm_name,
                generation,
                "failed to stop jailed cloud-hypervisor cgroup"
            ),
        }
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

    let Some(details) = vm.details.as_ref() else {
        return Ok(());
    };
    let source = if let Some(jail_root) = details.jail_root_path.as_deref() {
        PathBuf::from(jail_root).join("logs").join(source_name)
    } else if let Some(vm_dir) = agent_owned_vm_dir_for_status(vm) {
        vm_dir.join(source_name)
    } else {
        return Ok(());
    };
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
        if file_name.ends_with(".krec") {
            let raw_destination = artifacts_dir.join(&file_name);
            if !raw_destination.exists() {
                let mut source = entry.to_file();
                let mut destination_file = std::fs::File::create(&raw_destination)
                    .with_context(|| format!("failed to create {}", raw_destination.display()))?;
                std::io::copy(&mut source, &mut destination_file)
                    .with_context(|| format!("failed to extract {}", raw_destination.display()))?;
            }
        }
    }

    Ok(())
}

/// Collects everything except the rendered session casts, which are
/// rendered and registered separately after these artifacts are already
/// uploaded.
async fn collect_local_artifacts(artifacts_dir: &Path) -> Result<Vec<LocalArtifact>> {
    let mut artifacts = Vec::new();
    let mut ordinal = 1_u32;

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
        if path.extension().and_then(|ext| ext.to_str()) == Some("krec") {
            recording_paths.push(path);
        }
    }
    // Session files are named ssh-session-<start-ms>-<pid>.krec, so the
    // lexicographic order is the chronological order.
    recording_paths.sort();

    for path in recording_paths {
        artifacts.push(
            describe_local_artifact(
                ordinal,
                "ssh_recording_raw",
                &path,
                "application/x-kino-raw-event-log; charset=utf-8",
            )
            .await?,
        );
        ordinal = ordinal.saturating_add(1);
    }

    Ok(artifacts)
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

fn agent_owned_vm_dir_for_status(vm: &VmStatusResponse) -> Option<PathBuf> {
    vm.details
        .as_ref()
        .filter(|details| details.jail_generation.is_none())
        .map(|details| PathBuf::from(&details.root_disk_path))
        .and_then(|root_disk_path| root_disk_path.parent().map(Path::to_path_buf))
}

fn is_run_purged_remote_response(status: StatusCode, body: &str) -> bool {
    if !status.is_client_error() {
        return false;
    }

    #[derive(Deserialize)]
    struct ErrorBody {
        code: Option<String>,
    }

    serde_json::from_str::<ErrorBody>(body)
        .ok()
        .and_then(|body| body.code)
        .is_some_and(|code| code == "run_purged")
}

#[cfg(not(target_os = "linux"))]
async fn run_probe_worker_task(
    inner: Arc<Inner>,
    vm_name: String,
    run_id: String,
    jail_generation: String,
    _kino_vsock_path: PathBuf,
    _kino_vsock_port: u32,
    _jail_uid: u32,
) {
    warn!(
        vm = vm_name,
        "Kino readiness push listener is only available on Linux"
    );
    let mut interval = tokio::time::interval(Duration::from_secs(PROBE_POLL_INTERVAL_SECONDS));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        let should_continue = {
            let states = inner.states.read().await;
            match states.get(&vm_name) {
                Some(vm) => {
                    vm.state == VmLifecycleState::Running
                        && vm.details.as_ref().is_some_and(|details| {
                            details.run_id.as_deref() == Some(run_id.as_str())
                                && details.jail_generation.as_deref()
                                    == Some(jail_generation.as_str())
                        })
                }
                None => false,
            }
        };
        if !should_continue {
            break;
        }
    }
}

#[cfg(target_os = "linux")]
async fn handle_kino_ready_stream(
    inner: Arc<Inner>,
    vm_name: &str,
    run_id: &str,
    jail_generation: &str,
    mut stream: tokio::net::UnixStream,
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
        apply_kino_ready_snapshot(&inner, vm_name, run_id, jail_generation, result).await?;
    }
}

#[cfg(target_os = "linux")]
async fn apply_kino_ready_snapshot(
    inner: &Arc<Inner>,
    vm_name: &str,
    run_id: &str,
    jail_generation: &str,
    result: ProbePollResult,
) -> Result<()> {
    let current_run_matches = {
        let states = inner.states.read().await;
        states.get(vm_name).is_some_and(|vm| {
            vm.details.as_ref().is_some_and(|details| {
                details.run_id.as_deref() == Some(run_id)
                    && details.jail_generation.as_deref() == Some(jail_generation)
            })
        })
    };
    anyhow::ensure!(
        current_run_matches,
        "dropping Kino readiness snapshot for stale run/generation {run_id}/{jail_generation} of vm {vm_name}"
    );

    stage_vm_ssh_host_keys(
        inner,
        vm_name,
        jail_generation,
        result.ssh_host_keys_openssh.clone(),
    )
    .await;
    let still_current = {
        let states = inner.states.read().await;
        states.get(vm_name).is_some_and(|vm| {
            vm.details.as_ref().is_some_and(|details| {
                details.run_id.as_deref() == Some(run_id)
                    && details.jail_generation.as_deref() == Some(jail_generation)
            })
        })
    };
    anyhow::ensure!(
        still_current,
        "dropping Kino readiness snapshot after generation changed"
    );
    let update = ProbeUpdateEnvelope::from_poll_result(vm_name, run_id, jail_generation, result);
    // Always wake the generation-fenced launch waiter internally. Projection
    // is permitted only for an already committed steady VM; the first ready
    // snapshot is published through the atomic ready transaction instead.
    let _ = inner.kino_readiness_tx.send(update.clone());
    let may_project = {
        let states = inner.states.read().await;
        let Some(vm) = states.get(vm_name) else {
            return Ok(());
        };
        let committed = vm.state == VmLifecycleState::Running
            && vm.details.as_ref().is_some_and(|details| {
                details.run_id.as_deref() == Some(run_id)
                    && details.jail_generation.as_deref() == Some(jail_generation)
                    && details.cpu_runtime.as_ref().is_some_and(|runtime| {
                        runtime.phase == VmCpuPhase::Steady
                            && runtime.effective_quota == runtime.steady_quota
                            && runtime.attestation.is_some()
                    })
            });
        if committed {
            // Persist host-key changes and their Kino snapshot in the same
            // transaction used by the initial ready boundary. Holding the
            // read fence prevents a concurrent generation replacement.
            inner
                .db
                .upsert_ready_vm_and_probe_state(vm.to_db_row(), probe_state_row(&update)?)
                .await
                .context("atomically persist post-ready Kino snapshot")?;
        }
        committed
    };
    if may_project {
        let _ = inner.probe_updates_tx.send(update);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
async fn stage_vm_ssh_host_keys(
    inner: &Inner,
    vm_name: &str,
    jail_generation: &str,
    keys: Vec<String>,
) {
    let keys = normalize_ssh_host_keys(keys);
    if keys.is_empty() {
        return;
    }

    let now_s = now_unix_s();
    let updated_at = format_rfc3339_s(now_s);
    {
        let mut states = inner.states.write().await;
        let Some(vm) = states.get_mut(vm_name) else {
            return;
        };
        let Some(details) = vm.details.as_mut() else {
            return;
        };
        if details.jail_generation.as_deref() != Some(jail_generation) {
            return;
        }
        if details.ssh_host_keys_openssh == keys {
            return;
        }
        details.ssh_host_keys_openssh = keys;
        vm.updated_at_s = now_s;
        vm.updated_at = updated_at;
        vm.lease_expires_at = compute_lease_expires_at(vm.running_at_s, vm.lease_duration_seconds);
    }
}

async fn start_probe_worker(inner: &Arc<Inner>, vm_name: &str, details: &VmDetails) -> Result<()> {
    let run_id = details
        .run_id
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("vm details missing run_id"))?;
    let jail_generation = details
        .jail_generation
        .as_ref()
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("vm details missing jail_generation"))?;
    let kino_vsock_path = details
        .kino_vsock_path
        .as_ref()
        .map(PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("vm details missing kino_vsock_path"))?;
    #[cfg(not(target_os = "linux"))]
    let kino_vsock_port = details.kino_vsock_port.unwrap_or(KINO_VSOCK_PORT);
    let jail_uid = details
        .jail_uid
        .ok_or_else(|| anyhow::anyhow!("vm details missing jail_uid"))?;

    stop_probe_worker(inner, vm_name).await;

    #[cfg(target_os = "linux")]
    let (ready_listener, ready_socket_path) =
        prepare_kino_ready_listener(&kino_vsock_path, jail_uid).await?;

    let vm_name_owned = vm_name.to_string();
    let inner_for_task = Arc::clone(inner);
    #[cfg(target_os = "linux")]
    let join = tokio::spawn(async move {
        run_probe_worker_task(
            inner_for_task,
            vm_name_owned,
            run_id,
            jail_generation,
            jail_uid,
            ready_listener,
            ready_socket_path,
        )
        .await;
    });
    #[cfg(not(target_os = "linux"))]
    let join = tokio::spawn(async move {
        run_probe_worker_task(
            inner_for_task,
            vm_name_owned,
            run_id,
            jail_generation,
            kino_vsock_path,
            kino_vsock_port,
            jail_uid,
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

/// Filesystem path where cloud-hypervisor surfaces guest-initiated vsock
/// connections to `KINO_HOST_READY_PORT`. Cloud Hypervisor implements the
/// Firecracker-style hybrid vsock scheme: a guest connect to host CID 2 port
/// P is forwarded to the unix socket `<vsock-socket>_P` on the host, so the
/// agent must listen there — a host AF_VSOCK listener never sees it.
fn kino_ready_socket_path(kino_vsock_path: &Path) -> PathBuf {
    let mut os = kino_vsock_path.as_os_str().to_owned();
    os.push(format!("_{KINO_HOST_READY_PORT}"));
    PathBuf::from(os)
}

#[cfg(target_os = "linux")]
async fn prepare_kino_ready_listener(
    kino_vsock_path: &Path,
    jail_uid: u32,
) -> Result<(tokio::net::UnixListener, PathBuf)> {
    let ready_socket_path = kino_ready_socket_path(kino_vsock_path);
    let _ = tokio::fs::remove_file(&ready_socket_path).await;
    let listener = tokio::net::UnixListener::bind(&ready_socket_path).with_context(|| {
        format!(
            "bind Kino readiness listener at {}",
            ready_socket_path.display()
        )
    })?;
    if let Err(error) = activate_kino_ready_socket(&ready_socket_path, jail_uid).await {
        let _ = tokio::fs::remove_file(&ready_socket_path).await;
        return Err(error).context("activate Kino readiness socket ACL mask");
    }
    Ok((listener, ready_socket_path))
}

#[cfg(target_os = "linux")]
async fn run_probe_worker_task(
    inner: Arc<Inner>,
    vm_name: String,
    run_id: String,
    jail_generation: String,
    jail_uid: u32,
    listener: tokio::net::UnixListener,
    ready_socket_path: PathBuf,
) {
    match inner.db.load_vm_probe_state(vm_name.clone()).await {
        Ok(Some(row)) if row.run_id == run_id => {
            if let Some(update) = probe_update_from_state_row(&row)
                && update.jail_generation == jail_generation
            {
                // A recovered durable snapshot is an internal readiness input.
                // Recovery must reseal and re-attest SSH before any external
                // projection is emitted.
                let _ = inner.kino_readiness_tx.send(update);
            }
        }
        Ok(_) => {}
        Err(error) => {
            warn!(error = %error, vm = vm_name, "failed to load persisted probe state");
        }
    }

    info!(
        vm = vm_name,
        vm_uid = jail_uid,
        path = %ready_socket_path.display(),
        "listening for guest-initiated Kino readiness pushes"
    );

    let mut interval = tokio::time::interval(Duration::from_secs(PROBE_POLL_INTERVAL_SECONDS));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut connection_task: Option<JoinHandle<()>> = None;

    loop {
        tokio::select! {
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _)) => {
                        // Kino keeps a single persistent push connection; a
                        // new connection supersedes the previous one.
                        if let Some(task) = connection_task.take() {
                            task.abort();
                        }
                        let inner_for_task = Arc::clone(&inner);
                        let vm_name_for_task = vm_name.clone();
                        let run_id_for_task = run_id.clone();
                        let generation_for_task = jail_generation.clone();
                        connection_task = Some(tokio::spawn(async move {
                            if let Err(error) = handle_kino_ready_stream(
                                inner_for_task,
                                &vm_name_for_task,
                                &run_id_for_task,
                                &generation_for_task,
                                stream,
                            )
                            .await
                            {
                                warn!(
                                    error = %error,
                                    vm = vm_name_for_task,
                                    "Kino readiness push connection failed"
                                );
                            }
                        }));
                    }
                    Err(error) => {
                        warn!(
                            error = %error,
                            vm = vm_name,
                            "failed to accept Kino readiness push connection"
                        );
                    }
                }
            }
            _ = interval.tick() => {
                let should_continue = {
                    let states = inner.states.read().await;
                    match states.get(&vm_name) {
                        Some(vm) => {
                            matches!(
                                vm.state,
                                VmLifecycleState::CreatingVm
                                    | VmLifecycleState::BootingVm
                                    | VmLifecycleState::Running
                            ) && vm.details.as_ref().is_some_and(|details| {
                                details.run_id.as_deref() == Some(run_id.as_str())
                                    && details.jail_generation.as_deref()
                                        == Some(jail_generation.as_str())
                            })
                        }
                        None => false,
                    }
                };
                if !should_continue {
                    break;
                }
            }
        }
    }

    if let Some(task) = connection_task.take() {
        task.abort();
    }
    let _ = tokio::fs::remove_file(&ready_socket_path).await;
}

#[cfg(target_os = "linux")]
async fn activate_kino_ready_socket(path: &Path, jail_uid: u32) -> Result<()> {
    use rustix::fs::{Mode, OFlags, ResolveFlags, openat2};
    use std::os::fd::AsRawFd as _;
    use std::os::unix::fs::{FileTypeExt as _, MetadataExt as _, PermissionsExt as _};

    // The run directory's default ACL names the unique VM UID. UnixListener
    // creation can collapse that ACL's mask under the service's 0077 umask, so
    // reactivate only the group-class mask. No permission is granted to other.
    let file_name = path
        .file_name()
        .filter(|name| !name.is_empty())
        .context("Kino readiness socket path has no file name")?;
    let parent_path = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .context("Kino readiness socket path has no parent")?;
    let parent = openat2(
        rustix::fs::CWD,
        parent_path,
        OFlags::PATH | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
        ResolveFlags::NO_MAGICLINKS | ResolveFlags::NO_SYMLINKS,
    )
    .context("pin Kino readiness socket parent")?;
    let parent_stat = rustix::fs::fstat(&parent)?;
    anyhow::ensure!(
        rustix::fs::FileType::from_raw_mode(parent_stat.st_mode) == rustix::fs::FileType::Directory
            && parent_stat.st_uid == jail_uid
            && parent_stat.st_gid == jail_uid,
        "Kino readiness socket parent identity changed"
    );
    let socket = openat2(
        &parent,
        file_name,
        OFlags::PATH | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
        ResolveFlags::BENEATH
            | ResolveFlags::NO_MAGICLINKS
            | ResolveFlags::NO_SYMLINKS
            | ResolveFlags::NO_XDEV,
    )
    .context("pin Kino readiness socket")?;
    let before = rustix::fs::fstat(&socket)?;
    anyhow::ensure!(
        rustix::fs::FileType::from_raw_mode(before.st_mode) == rustix::fs::FileType::Socket
            && before.st_uid != 0
            && before.st_uid != jail_uid
            && before.st_nlink == 1,
        "Kino readiness socket identity is unsafe"
    );
    let pinned_path = PathBuf::from(format!("/proc/self/fd/{}", socket.as_raw_fd()));
    tokio::fs::set_permissions(&pinned_path, std::fs::Permissions::from_mode(0o760))
        .await
        .with_context(|| format!("set permissions on {}", path.display()))?;
    let after = rustix::fs::fstat(&socket)?;
    anyhow::ensure!(
        before.st_dev == after.st_dev
            && before.st_ino == after.st_ino
            && before.st_uid == after.st_uid
            && before.st_gid == after.st_gid
            && after.st_nlink == 1,
        "pinned Kino readiness socket identity changed"
    );
    let metadata = tokio::fs::symlink_metadata(path)
        .await
        .with_context(|| format!("inspect {} after permission update", path.display()))?;
    anyhow::ensure!(
        metadata.file_type().is_socket(),
        "Kino readiness path is not a Unix socket"
    );
    anyhow::ensure!(
        metadata.dev() == after.st_dev
            && metadata.ino() == after.st_ino
            && metadata.uid() == after.st_uid
            && metadata.gid() == after.st_gid,
        "Kino readiness socket path was replaced"
    );
    anyhow::ensure!(
        metadata.nlink() == 1,
        "Kino readiness socket must have exactly one link"
    );
    anyhow::ensure!(
        metadata.mode() & 0o077 == 0o060,
        "Kino readiness socket ACL mask or other-user permissions are unsafe"
    );
    Ok(())
}

fn probe_state_row(update: &ProbeUpdateEnvelope) -> Result<VmProbeStateRow> {
    let summary_json = serde_json::to_string(&update.summary).context("serialize probe summary")?;
    let snapshot_json =
        serde_json::to_string(update).context("serialize current probe snapshot")?;
    Ok(VmProbeStateRow {
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
    })
}

#[cfg(target_os = "linux")]
fn probe_update_from_state_row(row: &VmProbeStateRow) -> Option<ProbeUpdateEnvelope> {
    serde_json::from_str::<ProbeUpdateEnvelope>(&row.snapshot_json).ok()
}

async fn request_jailerd(inner: &Inner, request: JailerRequest) -> Result<JailerResponse> {
    let timeout_duration = Duration::from_secs(inner.jailer_request_timeout_seconds);
    request_jailerd_with_timeout(inner, request, timeout_duration).await
}

async fn request_jailerd_with_timeout(
    inner: &Inner,
    request: JailerRequest,
    timeout_duration: Duration,
) -> Result<JailerResponse> {
    let socket = inner.jailer_socket.clone();
    timeout(timeout_duration, async move {
        let mut client = AsyncSeqpacketClient::connect(&socket)
            .with_context(|| format!("connect to intar-jailerd at {}", socket.display()))?;
        client
            .request(request)
            .await
            .context("send intar-jailerd request")
    })
    .await
    .with_context(|| {
        format!(
            "intar-jailerd request timed out after {} milliseconds",
            timeout_duration.as_millis()
        )
    })?
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum JailerIdentityOperation {
    Inspect,
    Stop,
    Destroy,
}

async fn jailer_identity_request(
    inner: &Inner,
    generation: &str,
    operation: JailerIdentityOperation,
) -> Result<Option<VmInspection>> {
    let identity = VmIdentityRequest::by_generation(
        ValidatedId::parse(generation.to_string()).context("validate persisted jail generation")?,
    );
    jailer_vm_selector_request(inner, identity, operation).await
}

async fn jailer_vm_selector_request(
    inner: &Inner,
    identity: VmIdentityRequest,
    operation: JailerIdentityOperation,
) -> Result<Option<VmInspection>> {
    identity.validate().context("validate jailer VM selector")?;
    let request = match operation {
        JailerIdentityOperation::Inspect => JailerRequest::InspectVm(identity),
        JailerIdentityOperation::Stop => JailerRequest::StopVm(identity),
        JailerIdentityOperation::Destroy => JailerRequest::DestroyVm(identity),
    };

    classify_jailer_identity_response(operation, request_jailerd(inner, request).await?)
}

fn classify_jailer_identity_response(
    operation: JailerIdentityOperation,
    response: JailerResponse,
) -> Result<Option<VmInspection>> {
    match (operation, response) {
        (JailerIdentityOperation::Inspect, JailerResponse::InspectVm(inspection)) => {
            Ok(Some(inspection))
        }
        (JailerIdentityOperation::Stop, JailerResponse::StopVm(_))
        | (JailerIdentityOperation::Destroy, JailerResponse::DestroyVm(_)) => Ok(None),
        (JailerIdentityOperation::Inspect, JailerResponse::Error(error))
            if error.code == "not_found" =>
        {
            Ok(None)
        }
        (
            JailerIdentityOperation::Stop | JailerIdentityOperation::Destroy,
            JailerResponse::Error(error),
        ) if error.code == "not_found" => Ok(None),
        (_, JailerResponse::Error(error)) => {
            anyhow::bail!("jailerd {}: {}", error.code, error.message)
        }
        (_, response) => {
            anyhow::bail!("jailerd returned unexpected response to {operation:?}: {response:?}")
        }
    }
}

async fn wait_for_ch_ready(socket_path: &Path, timeout_seconds: u64) -> Result<ChClient> {
    let deadline = Instant::now() + Duration::from_secs(timeout_seconds);
    let mut last_error = "socket path has not appeared".to_owned();

    loop {
        if socket_path.exists() {
            let socket = socket_path.display().to_string();
            match ChClient::new(socket) {
                Ok(client) => {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    match tokio::time::timeout(remaining, client.ping()).await {
                        Ok(Ok(_)) => return Ok(client),
                        Ok(Err(error)) => {
                            last_error = format!("API ping failed: {error}");
                        }
                        Err(_) => {
                            last_error =
                                "API ping exceeded the remaining readiness deadline".to_owned();
                        }
                    }
                }
                Err(error) => {
                    last_error = format!("socket validation failed: {error}");
                }
            }
        }

        if Instant::now() >= deadline {
            anyhow::bail!(
                "cloud-hypervisor socket did not become ready in {}s at {}; last error: {}",
                timeout_seconds,
                socket_path.display(),
                last_error,
            );
        }

        tokio::time::sleep(
            Duration::from_millis(200).min(deadline.saturating_duration_since(Instant::now())),
        )
        .await;
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RunNftNetwork {
    run_id: String,
    bridge_name: String,
    subnet_cidr: String,
    gateway: Ipv4Addr,
    prefix: u8,
}

async fn repair_vm_networks(inner: &Inner) -> Result<()> {
    let run_networks = collect_run_networks(inner).await?;
    let mut failures = Vec::new();
    for network in &run_networks {
        let run_id = match ValidatedId::parse(network.run_id.clone()) {
            Ok(run_id) => run_id,
            Err(error) => {
                failures.push(format!(
                    "run {} has an invalid persisted ID: {error}",
                    network.run_id
                ));
                continue;
            }
        };
        match request_jailerd(
            inner,
            JailerRequest::RepairRunNetwork(EnsureRunNetworkRequest {
                run_id,
                guest_cidr: network.subnet_cidr.clone(),
                gateway: network.gateway.to_string(),
            }),
        )
        .await
        {
            Ok(JailerResponse::RepairRunNetwork(_)) => {}
            Ok(JailerResponse::Error(error)) => failures.push(format!(
                "run {}: jailerd {}: {}",
                network.run_id, error.code, error.message
            )),
            Ok(response) => failures.push(format!(
                "run {}: jailerd returned unexpected response to repair_run_network: {response:?}",
                network.run_id
            )),
            Err(error) => {
                failures.push(format!("run {}: {error:#}", network.run_id));
            }
        }
    }
    if !failures.is_empty() {
        anyhow::bail!(
            "one or more run network repairs failed: {}",
            failures.join("; ")
        )
    }
    debug!(
        run_network_count = run_networks.len(),
        "repaired run networks through intar-jailerd"
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
        // Queued or failed-before-launch rows can carry provisional network
        // fields without ever having crossed the jailer generation boundary.
        // Repair is intentionally not an implicit ensure/create fallback.
        if details.jail_generation.is_none() {
            continue;
        }
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
    }

    Ok(networks.into_values().collect())
}

#[cfg(test)]
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
    let runtime_constraints = runtime_constraints_from_details(details);
    let steady_quota_verified = runtime_constraints.as_ref().is_some_and(|constraints| {
        constraints.phase == VmRuntimeConstraintPhaseV1::Steady
            && constraints.effective_cpu_millis == constraints.steady_cpu_millis
            && constraints.quota_verified_at_unix_ms.is_some()
    });
    let terminal_target = if vm.state == VmLifecycleState::Running
        && ssh_access.enabled
        && ssh_ready
        && steady_quota_verified
    {
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
        runtime_constraints,
    })
}

fn runtime_constraints_from_details(details: &VmDetails) -> Option<VmRuntimeConstraintsV1> {
    let runtime = details.cpu_runtime.as_ref()?;
    let generation = details.jail_generation.clone()?;
    let phase = match runtime.phase {
        VmCpuPhase::BootBurst => VmRuntimeConstraintPhaseV1::BootBurst,
        VmCpuPhase::Steady => VmRuntimeConstraintPhaseV1::Steady,
    };
    Some(VmRuntimeConstraintsV1 {
        generation,
        phase,
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

struct StrictGuestHostKeys {
    expected: Arc<[PublicKey]>,
    mismatch_observed: Arc<AtomicBool>,
}

impl ssh_client::Handler for StrictGuestHostKeys {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        // OpenSSH comments are not part of the key sent over the wire. Kino
        // reports the contents of /etc/ssh/ssh_host_*.pub, so compare only
        // authenticated key material rather than full PublicKey equality.
        let accepted = self
            .expected
            .iter()
            .any(|expected| expected.key_data() == server_public_key.key_data());
        if !accepted {
            self.mismatch_observed.store(true, Ordering::Release);
        }
        Ok(accepted)
    }
}

fn parse_guest_ssh_host_keys(raw_keys: &[String]) -> Result<Arc<[PublicKey]>> {
    anyhow::ensure!(
        !raw_keys.is_empty(),
        "Kino readiness did not include an SSH host key"
    );
    raw_keys
        .iter()
        .enumerate()
        .map(|(index, raw)| {
            PublicKey::from_openssh(raw)
                .with_context(|| format!("Kino reported invalid SSH host key at index {index}"))
        })
        .collect::<Result<Vec<_>>>()
        .map(Arc::from)
}

fn guest_ssh_readiness_client_config() -> Arc<ssh_client::Config> {
    // Keep the same conservative KEX set as Stargate's outbound SSH client.
    // OpenSSH 10 guests and russh otherwise choose incompatible post-quantum
    // algorithms before the host-key check can run.
    let preferred = Preferred {
        kex: Cow::Borrowed(&[kex::CURVE25519, kex::CURVE25519_PRE_RFC_8731]),
        ..Preferred::DEFAULT
    };
    Arc::new(ssh_client::Config {
        client_id: russh::SshId::Standard("SSH-2.0-Intar-Agent-Readiness".into()),
        inactivity_timeout: Some(Duration::from_millis(500)),
        nodelay: true,
        preferred,
        ..Default::default()
    })
}

async fn wait_for_guest_ssh_before_running(
    inner: &Inner,
    vm_name: &str,
    generation: &ValidatedId,
) -> Result<()> {
    let (guest_ip, raw_host_keys) = {
        let states = inner.states.read().await;
        let details = states
            .get(vm_name)
            .and_then(|vm| vm.details.as_ref())
            .context("VM details missing for SSH readiness")?;
        anyhow::ensure!(
            details.jail_generation.as_deref() == Some(generation.as_str()),
            "VM generation changed before SSH readiness verification"
        );
        let guest_ip = details
            .guest_ip
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .context("VM details missing guest IP for SSH readiness")?;
        (guest_ip, details.ssh_host_keys_openssh.clone())
    };
    let expected_host_keys = parse_guest_ssh_host_keys(&raw_host_keys)?;
    let client_config = guest_ssh_readiness_client_config();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let mismatch_observed = Arc::new(AtomicBool::new(false));
        let attempt = timeout(
            Duration::from_millis(500),
            ssh_client::connect(
                Arc::clone(&client_config),
                (guest_ip.as_str(), 22),
                StrictGuestHostKeys {
                    expected: Arc::clone(&expected_host_keys),
                    mismatch_observed: Arc::clone(&mismatch_observed),
                },
            ),
        )
        .await;
        match attempt {
            Ok(Ok(session)) => {
                let _ = session
                    .disconnect(Disconnect::ByApplication, "", "en")
                    .await;
                let states = inner.states.read().await;
                let generation_is_current = states
                    .get(vm_name)
                    .and_then(|vm| vm.details.as_ref())
                    .is_some_and(|details| {
                        details.jail_generation.as_deref() == Some(generation.as_str())
                    });
                anyhow::ensure!(
                    generation_is_current,
                    "VM generation changed during SSH readiness verification"
                );
                return Ok(());
            }
            _ if mismatch_observed.load(Ordering::Acquire) => {
                anyhow::bail!(
                    "guest SSH presented a host key that was not reported by Kino; refusing to publish terminal readiness"
                )
            }
            _ if Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            _ => {
                anyhow::bail!(
                    "guest SSH did not complete a Kino-attested host-key handshake after steady quota sealing"
                )
            }
        }
    }
}

fn normalize_peer_vm_topology(
    current_vm_name: &str,
    raw_peer_vm_names: Vec<String>,
    raw_peer_vm_aliases: BTreeMap<String, String>,
) -> Result<(Vec<String>, BTreeMap<String, String>), ApiError> {
    let mut peer_vm_names = Vec::new();
    for peer_name in raw_peer_vm_names {
        let peer_name = peer_name.trim().to_string();
        if peer_name.is_empty() || peer_name == current_vm_name {
            continue;
        }
        if !is_safe_key(&peer_name) {
            return Err(ApiError::bad_request(
                "runtime.peer_vm_names entries must match [A-Za-z0-9_-]+",
            ));
        }
        if !peer_vm_names.contains(&peer_name) {
            peer_vm_names.push(peer_name);
        }
    }

    let known_peer_names = peer_vm_names.iter().cloned().collect::<BTreeSet<_>>();
    let mut peer_vm_aliases = BTreeMap::new();
    for (runtime_name, logical_name) in raw_peer_vm_aliases {
        let runtime_name = runtime_name.trim().to_string();
        let logical_name = logical_name.trim().to_string();
        if !is_safe_key(&runtime_name) {
            return Err(ApiError::bad_request(
                "runtime.peer_vm_aliases keys must match [A-Za-z0-9_-]+",
            ));
        }
        if !known_peer_names.contains(&runtime_name) {
            return Err(ApiError::bad_request(format!(
                "runtime.peer_vm_aliases key {runtime_name:?} does not name a runtime peer"
            )));
        }
        if !is_safe_key(&logical_name) {
            return Err(ApiError::bad_request(
                "runtime.peer_vm_aliases values must match [A-Za-z0-9_-]+",
            ));
        }
        if peer_vm_aliases
            .insert(runtime_name.clone(), logical_name)
            .is_some()
        {
            return Err(ApiError::bad_request(format!(
                "runtime.peer_vm_aliases contains duplicate normalized key {runtime_name:?}"
            )));
        }
    }

    let mut logical_peer_names = BTreeSet::new();
    let mut logical_peer_env_names = BTreeSet::new();
    for runtime_name in &peer_vm_names {
        let logical_name = peer_vm_aliases.get(runtime_name).unwrap_or(runtime_name);
        if !logical_peer_names.insert(logical_name.clone()) {
            return Err(ApiError::bad_request(format!(
                "runtime peer aliases produce duplicate logical peer name {logical_name:?}"
            )));
        }
        let logical_env_name = peer_env_name_identity(logical_name);
        if !logical_peer_env_names.insert(logical_env_name.clone()) {
            return Err(ApiError::bad_request(format!(
                "runtime peer aliases produce duplicate environment peer name {logical_env_name:?}"
            )));
        }
    }

    Ok((peer_vm_names, peer_vm_aliases))
}

fn peer_env_name_identity(peer_name: &str) -> String {
    peer_name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect()
}

async fn allocate_run_network(
    inner: &Inner,
    run_id: &str,
    vm_name: &str,
    peer_vm_names: &[String],
    peer_vm_aliases: &BTreeMap<String, String>,
) -> Result<(CreateVmNetwork, String, BTreeMap<String, String>), ApiError> {
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
    let allocation_names = run_allocation_vm_names(vm_name, peer_vm_names);

    let (used_ips, used_run_subnets, existing_run_network, existing_run_guest_ips) = {
        let states = inner.states.read().await;
        let mut used_ips = BTreeSet::new();
        let mut used_run_subnets = BTreeSet::new();
        let mut existing_run_network = None;
        let mut existing_run_guest_ips = BTreeMap::new();

        for vm in states.values() {
            let Some(details) = vm.details.as_ref() else {
                continue;
            };
            let is_same_run = details.run_id.as_deref() == Some(run_id);
            if let Some(guest_ip) = details.guest_ip.as_deref()
                && let Ok(ip) = guest_ip.parse::<Ipv4Addr>()
            {
                used_ips.insert(u32::from(ip));
                if is_same_run {
                    existing_run_guest_ips.insert(vm.name.clone(), ip);
                }
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
            if is_same_run
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

        (
            used_ips,
            used_run_subnets,
            existing_run_network,
            existing_run_guest_ips,
        )
    };

    if let Some((network, prefix, gateway)) = existing_run_network {
        let allocations = allocate_run_guest_ips(
            network,
            prefix,
            gateway,
            &used_ips,
            &existing_run_guest_ips,
            &allocation_names,
        )
        .ok_or_else(|| ApiError::conflict(format!("run {run_id} guest subnet exhausted")))?;
        let guest_ip = allocations
            .get(vm_name)
            .copied()
            .ok_or_else(|| ApiError::conflict(format!("run {run_id} guest subnet exhausted")))?;
        return Ok((
            CreateVmNetwork {
                guest_ip_cidr: format!("{guest_ip}/{prefix}"),
                gateway: gateway.to_string(),
                dns: inner.defaults.network.dns.clone(),
            },
            run_bridge,
            peer_guest_ip_strings(peer_vm_names, vm_name, &allocations, peer_vm_aliases)?,
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
        let allocations = allocate_run_guest_ips(
            subnet,
            RUN_SUBNET_PREFIX,
            gateway,
            &used_ips,
            &existing_run_guest_ips,
            &allocation_names,
        )
        .ok_or_else(|| ApiError::conflict("guest IP pool exhausted"))?;
        let guest_ip = allocations
            .get(vm_name)
            .copied()
            .ok_or_else(|| ApiError::conflict("guest IP pool exhausted"))?;
        return Ok((
            CreateVmNetwork {
                guest_ip_cidr: format!("{guest_ip}/{RUN_SUBNET_PREFIX}"),
                gateway: gateway.to_string(),
                dns: inner.defaults.network.dns.clone(),
            },
            run_bridge,
            peer_guest_ip_strings(peer_vm_names, vm_name, &allocations, peer_vm_aliases)?,
        ));
    }

    Err(ApiError::conflict("per-run guest subnet pool exhausted"))
}

fn run_allocation_vm_names(vm_name: &str, peer_vm_names: &[String]) -> BTreeSet<String> {
    let mut names = BTreeSet::from([vm_name.to_string()]);
    names.extend(
        peer_vm_names
            .iter()
            .map(|name| name.trim())
            .filter(|name| !name.is_empty())
            .map(ToOwned::to_owned),
    );
    names
}

fn allocate_run_guest_ips(
    network: u32,
    prefix: u8,
    gateway: Ipv4Addr,
    used_ips: &BTreeSet<u32>,
    existing_run_guest_ips: &BTreeMap<String, Ipv4Addr>,
    allocation_names: &BTreeSet<String>,
) -> Option<BTreeMap<String, Ipv4Addr>> {
    let mut allocations = BTreeMap::new();
    let mut reserved = used_ips.clone();
    for (name, ip) in existing_run_guest_ips {
        if allocation_names.contains(name) {
            allocations.insert(name.clone(), *ip);
            reserved.insert(u32::from(*ip));
        }
    }
    for name in allocation_names {
        if allocations.contains_key(name) {
            continue;
        }
        let guest_ip = allocate_guest_ip_in_subnet(network, prefix, name, &reserved, gateway)?;
        reserved.insert(u32::from(guest_ip));
        allocations.insert(name.clone(), guest_ip);
    }
    Some(allocations)
}

fn peer_guest_ip_strings(
    peer_vm_names: &[String],
    current_vm_name: &str,
    allocations: &BTreeMap<String, Ipv4Addr>,
    peer_vm_aliases: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, ApiError> {
    let mut peers = BTreeMap::new();
    for runtime_name in peer_vm_names
        .iter()
        .filter(|name| name.as_str() != current_vm_name)
    {
        let Some(ip) = allocations.get(runtime_name) else {
            continue;
        };
        let logical_name = peer_vm_aliases
            .get(runtime_name)
            .unwrap_or(runtime_name)
            .clone();
        if peers.insert(logical_name.clone(), ip.to_string()).is_some() {
            return Err(ApiError::bad_request(format!(
                "runtime peer aliases produce duplicate logical peer name {logical_name:?}"
            )));
        }
    }
    Ok(peers)
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
    debug_assert_ne!(
        state,
        VmLifecycleState::Running,
        "Running must use the generation-fenced atomic ready commit"
    );
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

        vm.lease_expires_at = compute_lease_expires_at(vm.running_at_s, vm.lease_duration_seconds);

        vm.clone()
    };

    if let Err(e) = inner.db.upsert_vm(persisted.to_db_row()).await {
        error!(error = %e, vm = persisted.name, "failed to persist vm status");
    }
    if matches!(
        state,
        VmLifecycleState::DeletingVm | VmLifecycleState::ArchivingArtifacts
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
            image_key: row.image_key.clone(),
            image_sha256: row.image_sha256.clone(),
            run_id: row.run_id.clone(),
            root_disk_path: root_disk_path.clone(),
            seed_disk_path: seed_disk_path.clone(),
            recording_disk_path: row.recording_disk_path.clone(),
            spool_dir: row.spool_dir.clone(),
            mac: mac.clone(),
            cpu_millis: row.cpu_millis.and_then(|value| u32::try_from(value).ok()),
            vcpu_count: row.vcpu_count.and_then(|value| u16::try_from(value).ok()),
            guest_ip: row.guest_ip.clone(),
            guest_ip_cidr: row.guest_ip_cidr.clone(),
            gateway: row.gateway.clone(),
            bridge_name: row.bridge_name.clone(),
            ssh_public_port: row.ssh_public_port.and_then(|v| u16::try_from(v).ok()),
            tap_name: row.tap_name.clone(),
            ch_socket_path: row.ch_socket_path.clone(),
            ch_pid: row.ch_pid.and_then(|v| u32::try_from(v).ok()),
            ch_start_time_ticks: row
                .ch_start_time_ticks
                .and_then(|value| u64::try_from(value).ok()),
            host_boot_id: row.host_boot_id.clone(),
            ch_executable_sha256: row.ch_executable_sha256.clone(),
            jail_generation: row.jail_generation.clone(),
            jail_unit_name: row.jail_unit_name.clone(),
            jail_cgroup_path: row.jail_cgroup_path.clone(),
            jail_root_path: row.jail_root_path.clone(),
            jail_root_inode: row
                .jail_root_inode
                .and_then(|value| u64::try_from(value).ok()),
            jail_uid: row.jail_uid.and_then(|value| u32::try_from(value).ok()),
            jail_gid: row.jail_gid.and_then(|value| u32::try_from(value).ok()),
            jail_netns_name: row.jail_netns_name.clone(),
            kino_vsock_cid: row.kino_vsock_cid.and_then(|v| u32::try_from(v).ok()),
            kino_vsock_port: row
                .kino_vsock_port
                .and_then(|v| u32::try_from(v).ok())
                .or_else(|| row.kino_vsock_cid.map(|_| KINO_VSOCK_PORT)),
            kino_vsock_path: row.kino_vsock_path.clone(),
            ssh_host_keys_openssh: parse_ssh_host_keys_json(
                row.ssh_host_keys_openssh_json.as_deref(),
            ),
            cpu_runtime: None,
            boot_evidence: None,
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

fn scenario_runtime_ready_timeout(cpu_millis: u32) -> Result<Duration> {
    anyhow::ensure!(cpu_millis > 0, "vm details cpu_millis must be positive");
    let cpu_millis = u64::from(cpu_millis);
    let quota_scaled_seconds = SCENARIO_READY_BASE_TIMEOUT_SECONDS
        .saturating_mul(u64::from(SCENARIO_READY_REFERENCE_CPU_MILLIS))
        .div_ceil(cpu_millis);
    Ok(Duration::from_secs(quota_scaled_seconds.clamp(
        SCENARIO_READY_BASE_TIMEOUT_SECONDS,
        SCENARIO_READY_MAX_TIMEOUT_SECONDS,
    )))
}

fn scenario_runtime_timeout_context(
    kino_vsock_path: &Path,
    saw_kino_vsock_socket: bool,
    timeout: Duration,
) -> String {
    let mut message = format!(
        "timed out after {}s waiting for scenario runtime readiness",
        timeout.as_secs()
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
    #[cfg(target_os = "linux")]
    use crate::kino_probe::{ProbeSummary, ProbeView};
    use cloud_hypervisor_client::Error as ChError;
    use intar_jailer_protocol::{CpuQuota, CpuQuotaAttestation, CpuStat};
    use russh::client::Handler as _;
    use serde_json::json;
    use tempfile::tempdir;

    fn ch_is_not_created_error(err: &ChError) -> bool {
        matches!(err, ChError::HttpStatus { status: 404, .. })
    }

    fn launch_operation_fixture() -> (VmLaunchRequest, PreparedImageV2Result) {
        let image_sha256 = Sha256Digest::parse("e".repeat(64)).expect("image digest");
        let artifact_sha256 = Sha256Digest::parse("f".repeat(64)).expect("artifact digest");
        let prepared_source = |name: &str, access| ArtifactSource {
            source_root: PREPARED_IMAGE_SOURCE_ROOT,
            relative_path: PathBuf::from(image_sha256.as_str()).join(name),
            sha256: Some(artifact_sha256.clone()),
            access,
        };
        let agent_source = |name: &str, access| ArtifactSource {
            source_root: 0,
            relative_path: PathBuf::from(name),
            sha256: None,
            access,
        };
        let prepared = PreparedImageV2Result {
            image_sha256: image_sha256.clone(),
            virtual_size_bytes: 4 * 1024 * 1024 * 1024,
            root_disk: prepared_source("root.raw", ArtifactAccess::ReadWrite),
            kernel: prepared_source("kernel", ArtifactAccess::ReadOnly),
            initrd: Some(prepared_source("initrd", ArtifactAccess::ReadOnly)),
            fast_template_store: true,
        };
        let request = VmLaunchRequest {
            run_id: ValidatedId::parse("run-1").expect("run ID"),
            vm_id: ValidatedId::parse("vm-1").expect("VM ID"),
            cpu_millis: 1_000,
            vcpu_count: 1,
            memory_mib: 512,
            root_disk_size_bytes: 4 * 1024 * 1024 * 1024,
            tap_name: "tap-test".to_string(),
            mac_address: "02:00:00:00:00:01".to_string(),
            guest_ip_cidr: "10.77.0.2/28".to_string(),
            ssh_public_port: Some(22_000),
            vsock_cid: 3,
            artifacts: SourceArtifacts {
                root_disk: prepared.root_disk.clone(),
                kernel: prepared.kernel.clone(),
                initrd: prepared.initrd.clone(),
                runtime_disk: agent_source("runtime.raw", ArtifactAccess::ReadOnly),
                recording_disk: agent_source("recordings.vfat", ArtifactAccess::ReadWrite),
            },
        };
        (request, prepared)
    }

    #[test]
    fn launch_requires_a_prepared_v2_image_and_never_downgrades() {
        let (prepared_request, prepared) = launch_operation_fixture();
        let operation =
            build_jailer_launch_operation(prepared_request, Some(&prepared)).expect("v2 request");
        assert!(matches!(operation, JailerRequest::LaunchVmV2(_)));

        let (mut regular_request, _) = launch_operation_fixture();
        let regular = |name: &str, access, sha256: Option<Sha256Digest>| ArtifactSource {
            source_root: 0,
            relative_path: PathBuf::from(name),
            sha256,
            access,
        };
        let boot_digest = Sha256Digest::parse("1".repeat(64)).expect("boot digest");
        regular_request.artifacts.root_disk = regular("root.raw", ArtifactAccess::ReadWrite, None);
        regular_request.artifacts.kernel = regular(
            "kernel",
            ArtifactAccess::ReadOnly,
            Some(boot_digest.clone()),
        );
        regular_request.artifacts.initrd = Some(regular(
            "initrd",
            ArtifactAccess::ReadOnly,
            Some(boot_digest),
        ));
        let error = build_jailer_launch_operation(regular_request, None)
            .expect_err("missing prepared template must fail instead of selecting v1");
        assert!(error.to_string().contains("no v1 fallback"));
    }

    #[tokio::test]
    async fn v2_launch_transport_retry_replays_the_exact_request_and_preserves_conflict() {
        let (request, prepared) = launch_operation_fixture();
        let operation =
            build_jailer_launch_operation(request, Some(&prepared)).expect("v2 operation");
        let expected = operation.clone();
        let sent = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sent_by_request = Arc::clone(&sent);

        let response = request_v2_launch_with_single_retry(operation, move |operation| {
            let attempt = {
                let mut sent = sent_by_request.lock().expect("sent requests");
                sent.push(operation);
                sent.len()
            };
            async move {
                if attempt == 1 {
                    Err(anyhow::anyhow!("injected lost launch response"))
                } else {
                    Ok(JailerResponse::Error(
                        intar_jailer_protocol::ProtocolError::new(
                            "conflict",
                            "logical VM already exists with a different launch request",
                        ),
                    ))
                }
            }
        })
        .await
        .expect("retry response");

        assert!(matches!(
            response,
            JailerResponse::Error(ref error) if error.code == "conflict"
        ));
        let sent = sent.lock().expect("sent requests");
        assert_eq!(sent.as_slice(), &[expected.clone(), expected]);
        assert!(
            sent.iter()
                .all(|request| matches!(request, JailerRequest::LaunchVmV2(_)))
        );
    }

    #[tokio::test]
    async fn v2_launch_transport_retry_fails_closed_after_two_transport_errors() {
        let (request, prepared) = launch_operation_fixture();
        let operation =
            build_jailer_launch_operation(request, Some(&prepared)).expect("v2 operation");
        let sent = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sent_by_request = Arc::clone(&sent);

        let error = request_v2_launch_with_single_retry(operation, move |operation| {
            let attempt = {
                let mut sent = sent_by_request.lock().expect("sent requests");
                sent.push(operation);
                sent.len()
            };
            async move { Err(anyhow::anyhow!("injected transport failure {attempt}")) }
        })
        .await
        .expect_err("two transport failures must fail closed");

        let message = format!("{error:#}");
        assert!(message.contains("first transport attempt failed"));
        assert!(message.contains("injected transport failure 1"));
        assert!(message.contains("injected transport failure 2"));
        let sent = sent.lock().expect("sent requests");
        assert_eq!(sent.len(), 2);
        assert!(
            sent.iter()
                .all(|request| matches!(request, JailerRequest::LaunchVmV2(_)))
        );
        assert_eq!(sent[0], sent[1]);
    }

    #[test]
    fn cpu_sample_validation_is_generation_fenced_and_attestation_bound() {
        let generation = ValidatedId::parse("generation-1").expect("generation");
        let steady_quota = CpuQuota::from_millis(1_000).expect("steady quota");
        let effective_quota = CpuQuota::from_millis(2_000).expect("boot quota");
        let mut sample = VmCpuSample {
            generation: generation.clone(),
            sampled_at_unix_ms: 123,
            cpu_runtime: VmCpuRuntimeState {
                phase: VmCpuPhase::BootBurst,
                steady_quota,
                effective_quota,
                boot_deadline_unix_ms: Some(45_123),
                attestation: Some(CpuQuotaAttestation {
                    quota: effective_quota,
                    cpu_max: effective_quota.cpu_max(),
                    cpu_max_burst: 0,
                    verified_at_unix_ms: 123,
                }),
            },
            cpu_stat: CpuStat {
                usage_usec: 10,
                user_usec: 7,
                system_usec: 3,
                nr_periods: 2,
                nr_throttled: 1,
                throttled_usec: 4,
            },
        };

        validate_vm_cpu_sample(&generation, &sample).expect("valid CPU sample");
        validate_vm_cpu_sample_point(VmCpuSamplePoint::VmBootAccepted, &sample)
            .expect("boot acceptance is sampled under the boot quota");
        validate_vm_cpu_sample_point(VmCpuSamplePoint::KinoReady, &sample)
            .expect("Kino readiness is sampled under the boot quota");
        validate_vm_cpu_sample_point(VmCpuSamplePoint::PreSeal, &sample)
            .expect("pre-seal is sampled under the boot quota");
        let evidence =
            accept_vm_cpu_sample("vm-1", &generation, VmCpuSamplePoint::PreSeal, &sample)
                .expect("valid protocol sample becomes bridge evidence");
        assert_eq!(evidence.point, VmBootCpuSamplePointV1::PreSeal);
        assert_eq!(evidence.phase, VmRuntimeConstraintPhaseV1::BootBurst);
        assert_eq!(evidence.steady_cpu_millis, 1_000);
        assert_eq!(evidence.effective_cpu_millis, 2_000);
        assert_eq!(evidence.cpu_max, "200000 100000");
        assert_eq!(evidence.cpu_max_burst, 0);
        assert_eq!(evidence.usage_usec, 10);
        assert!(validate_vm_cpu_sample_point(VmCpuSamplePoint::PostSeal, &sample).is_err());
        sample.cpu_runtime.phase = VmCpuPhase::Steady;
        validate_vm_cpu_sample_point(VmCpuSamplePoint::PostSeal, &sample)
            .expect("post-seal evidence is steady");
        validate_vm_cpu_sample_point(VmCpuSamplePoint::TerminalPublished, &sample)
            .expect("terminal publication evidence is steady");
        sample.cpu_runtime.phase = VmCpuPhase::BootBurst;
        assert_eq!(vm_cpu_phase_label(sample.cpu_runtime.phase), "boot_burst");
        assert_eq!(
            VmCpuSamplePoint::VmBootAccepted.as_str(),
            "vm_boot_accepted"
        );
        assert_eq!(VmCpuSamplePoint::KinoReady.as_str(), "kino_ready");
        assert_eq!(VmCpuSamplePoint::PreSeal.as_str(), "pre_seal");
        assert_eq!(VmCpuSamplePoint::PostSeal.as_str(), "post_seal");
        assert_eq!(
            VmCpuSamplePoint::TerminalPublished.as_str(),
            "terminal_published"
        );
        assert_eq!(
            VmCpuSamplePoint::VmBootAccepted.contract(),
            VmBootCpuSamplePointV1::VmBootAccepted
        );
        assert_eq!(
            VmCpuSamplePoint::KinoReady.contract(),
            VmBootCpuSamplePointV1::KinoReady
        );
        assert_eq!(
            VmCpuSamplePoint::PreSeal.contract(),
            VmBootCpuSamplePointV1::PreSeal
        );
        assert_eq!(
            VmCpuSamplePoint::PostSeal.contract(),
            VmBootCpuSamplePointV1::PostSeal
        );
        assert_eq!(
            VmCpuSamplePoint::TerminalPublished.contract(),
            VmBootCpuSamplePointV1::TerminalPublished
        );

        let stale_generation = ValidatedId::parse("generation-2").expect("different generation");
        assert!(validate_vm_cpu_sample(&stale_generation, &sample).is_err());

        sample
            .cpu_runtime
            .attestation
            .as_mut()
            .expect("attestation")
            .cpu_max_burst = 1;
        assert!(validate_vm_cpu_sample(&generation, &sample).is_err());
    }

    #[test]
    fn boot_phase_evidence_preserves_overlapped_network_and_disk_work() {
        let base = Instant::now();
        let at = |milliseconds| base + Duration::from_millis(milliseconds);
        let phases = VmBootTimeline {
            create_started_at: base,
            image_ready_at: at(250),
            runtime_disk_ready_at: at(380),
            network_ready_at: at(430),
            disks_ready_at: at(430),
            jail_ready_at: at(1_030),
            vmm_ready_at: at(1_230),
            boot_accepted_at: at(1_350),
            guest_ready_at: at(6_150),
            quota_sealed_at: at(6_230),
            ssh_verified_at: at(6_580),
            terminal_ready_at: at(6_670),
        }
        .phase_durations();

        assert_eq!(phases.image_cache_ms, 250);
        assert_eq!(phases.runtime_disk_ms, 130);
        assert_eq!(phases.network_ms, 430);
        assert_eq!(phases.image_disk_ms, 380);
        assert_eq!(phases.network_jailer_vmm_ms, 1_350);
        assert_eq!(phases.guest_to_kino_ms, 4_800);
        assert_eq!(phases.seal_ssh_publish_ms, 520);
        assert_eq!(phases.total_ms, 6_670);
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

    #[tokio::test]
    async fn ssh_readiness_accepts_only_kino_reported_host_key_material() {
        let reported = vec![
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBklzf1Qy77LwsjmDlGvCAhBpCkhpti25927fAnOMEIR root@broken-nginx"
                .to_string(),
        ];
        let expected = parse_guest_ssh_host_keys(&reported).expect("reported key parses");
        let wire_key = PublicKey::from_openssh(
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBklzf1Qy77LwsjmDlGvCAhBpCkhpti25927fAnOMEIR",
        )
        .expect("matching wire key parses");
        let other_key = PublicKey::from_openssh(
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA8ax6Yk1ZMSRpAkk8cIriNXtVufy6mxst2stQk66n+d",
        )
        .expect("other wire key parses");

        let mismatch_observed = Arc::new(AtomicBool::new(false));
        let mut verifier = StrictGuestHostKeys {
            expected: Arc::clone(&expected),
            mismatch_observed: Arc::clone(&mismatch_observed),
        };
        assert!(
            verifier
                .check_server_key(&wire_key)
                .await
                .expect("host-key check succeeds")
        );
        assert!(!mismatch_observed.load(Ordering::Acquire));

        let mismatch_observed = Arc::new(AtomicBool::new(false));
        let mut verifier = StrictGuestHostKeys {
            expected,
            mismatch_observed: Arc::clone(&mismatch_observed),
        };
        assert!(
            !verifier
                .check_server_key(&other_key)
                .await
                .expect("host-key check succeeds")
        );
        assert!(mismatch_observed.load(Ordering::Acquire));
    }

    #[test]
    fn ssh_readiness_rejects_missing_or_malformed_kino_host_keys() {
        let missing = parse_guest_ssh_host_keys(&[]).expect_err("missing keys must fail closed");
        assert!(
            missing
                .to_string()
                .contains("did not include an SSH host key")
        );

        let malformed = parse_guest_ssh_host_keys(&["ssh-ed25519 not-base64".to_string()])
            .expect_err("malformed key must fail closed");
        assert!(
            malformed
                .to_string()
                .contains("invalid SSH host key at index 0")
        );
    }

    fn test_vm_status(name: &str, run_id: Option<&str>) -> VmStatusResponse {
        VmStatusResponse {
            name: name.to_string(),
            state: VmLifecycleState::Queued,
            created_at: "1970-01-01T00:00:00Z".to_string(),
            updated_at: "1970-01-01T00:00:00Z".to_string(),
            details: Some(VmDetails {
                image_key: None,
                image_sha256: None,
                run_id: run_id.map(str::to_string),
                root_disk_path: format!("/tmp/{name}/root.raw"),
                seed_disk_path: format!("/tmp/{name}/runtime.img"),
                recording_disk_path: None,
                spool_dir: None,
                mac: "02:00:00:00:00:01".to_string(),
                cpu_millis: Some(125),
                vcpu_count: Some(1),
                guest_ip: None,
                guest_ip_cidr: None,
                gateway: None,
                bridge_name: None,
                ssh_public_port: None,
                tap_name: None,
                ch_socket_path: None,
                ch_pid: None,
                ch_start_time_ticks: None,
                host_boot_id: None,
                ch_executable_sha256: None,
                jail_generation: None,
                jail_unit_name: None,
                jail_cgroup_path: None,
                jail_root_path: None,
                jail_root_inode: None,
                jail_uid: None,
                jail_gid: None,
                jail_netns_name: None,
                kino_vsock_cid: None,
                kino_vsock_port: None,
                kino_vsock_path: None,
                ssh_host_keys_openssh: Vec::new(),
                cpu_runtime: None,
                boot_evidence: None,
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
    fn peer_vm_topology_keeps_runtime_names_and_validates_logical_aliases() {
        let db_runtime_name = "pair-ping-db-abc123-2".to_string();
        let (peer_vm_names, peer_vm_aliases) = normalize_peer_vm_topology(
            "pair-ping-web-abc123-1",
            vec![db_runtime_name.clone()],
            BTreeMap::from([(db_runtime_name.clone(), "db".to_string())]),
        )
        .expect("peer topology");

        assert_eq!(peer_vm_names, vec![db_runtime_name.clone()]);
        assert_eq!(
            peer_vm_aliases.get(&db_runtime_name).map(String::as_str),
            Some("db")
        );

        for aliases in [
            BTreeMap::from([("../runtime-db".to_string(), "db".to_string())]),
            BTreeMap::from([(db_runtime_name.clone(), "../db".to_string())]),
        ] {
            let error = normalize_peer_vm_topology(
                "pair-ping-web-abc123-1",
                vec![db_runtime_name.clone()],
                aliases,
            )
            .expect_err("unsafe alias topology must fail");
            assert_eq!(error.status, StatusCode::BAD_REQUEST);
            assert!(error.message.contains("must match [A-Za-z0-9_-]+"));
        }

        let error = normalize_peer_vm_topology(
            "pair-ping-web-abc123-1",
            vec![db_runtime_name],
            BTreeMap::from([("pair-ping-cache-abc123-3".to_string(), "cache".to_string())]),
        )
        .expect_err("unknown runtime peer alias must fail");
        assert!(error.message.contains("does not name a runtime peer"));
    }

    #[test]
    fn peer_vm_topology_rejects_duplicate_and_fallback_alias_collisions() {
        let db_runtime_name = "pair-ping-db-abc123-2".to_string();
        let cache_runtime_name = "pair-ping-cache-abc123-3".to_string();
        let error = normalize_peer_vm_topology(
            "pair-ping-web-abc123-1",
            vec![db_runtime_name.clone(), cache_runtime_name.clone()],
            BTreeMap::from([
                (db_runtime_name, "backend".to_string()),
                (cache_runtime_name, "backend".to_string()),
            ]),
        )
        .expect_err("duplicate logical aliases must fail");
        assert!(
            error
                .message
                .contains("duplicate logical peer name \"backend\"")
        );

        let db_runtime_name = "pair-ping-db-abc123-2".to_string();
        let error = normalize_peer_vm_topology(
            "pair-ping-web-abc123-1",
            vec!["db".to_string(), db_runtime_name.clone()],
            BTreeMap::from([(db_runtime_name, "db".to_string())]),
        )
        .expect_err("alias colliding with a fallback runtime name must fail");
        assert!(error.message.contains("duplicate logical peer name \"db\""));
    }

    #[test]
    fn peer_vm_topology_rejects_duplicate_normalized_alias_keys() {
        let runtime_name = "pair-ping-db-abc123-2".to_string();
        let error = normalize_peer_vm_topology(
            "pair-ping-web-abc123-1",
            vec![runtime_name.clone()],
            BTreeMap::from([
                (runtime_name.clone(), "db".to_string()),
                (format!(" {runtime_name} "), "database".to_string()),
            ]),
        )
        .expect_err("duplicate normalized alias keys must fail");
        assert!(error.message.contains("duplicate normalized key"));
    }

    #[test]
    fn peer_vm_topology_rejects_lossy_environment_alias_collisions() {
        let redis_dash_runtime_name = "pair-ping-redis-dash-abc123-2".to_string();
        let redis_underscore_runtime_name = "pair-ping-redis-underscore-abc123-3".to_string();
        let error = normalize_peer_vm_topology(
            "pair-ping-web-abc123-1",
            vec![
                redis_dash_runtime_name.clone(),
                redis_underscore_runtime_name.clone(),
            ],
            BTreeMap::from([
                (redis_dash_runtime_name, "redis-cache".to_string()),
                (redis_underscore_runtime_name, "redis_cache".to_string()),
            ]),
        )
        .expect_err("aliases that render the same environment key must fail");

        assert!(
            error
                .message
                .contains("duplicate environment peer name \"REDIS_CACHE\"")
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
    fn allocate_run_guest_ips_reserves_existing_peer_addresses() {
        let subnet = u32::from(Ipv4Addr::new(10, 77, 12, 0));
        let gateway = Ipv4Addr::new(10, 77, 12, 1);
        let existing_db = Ipv4Addr::new(10, 77, 12, 3);
        let used = BTreeSet::from([u32::from(gateway), u32::from(existing_db)]);
        let web_runtime_name = "pair-ping-web-abc123-1";
        let db_runtime_name = "pair-ping-db-abc123-2".to_string();
        let redis_runtime_name = "pair-ping-redis-cache-abc123-3".to_string();
        let peer_vm_names = vec![db_runtime_name.clone(), redis_runtime_name.clone()];
        let peer_vm_aliases = BTreeMap::from([
            (db_runtime_name.clone(), "db".to_string()),
            (redis_runtime_name.clone(), "redis-cache".to_string()),
        ]);
        let existing = BTreeMap::from([(db_runtime_name.clone(), existing_db)]);
        let names = run_allocation_vm_names(web_runtime_name, &peer_vm_names);

        let allocations = allocate_run_guest_ips(subnet, 28, gateway, &used, &existing, &names)
            .expect("run addresses");

        assert_eq!(allocations.get(&db_runtime_name), Some(&existing_db));
        assert_ne!(
            allocations.get(web_runtime_name),
            allocations.get(&db_runtime_name)
        );
        assert_ne!(
            allocations.get(&redis_runtime_name),
            allocations.get(&db_runtime_name)
        );
        assert_eq!(
            peer_guest_ip_strings(
                &peer_vm_names,
                web_runtime_name,
                &allocations,
                &peer_vm_aliases,
            )
            .expect("logical peer map")
            .keys()
            .cloned()
            .collect::<Vec<_>>(),
            vec!["db".to_string(), "redis-cache".to_string()]
        );
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
    fn run_begin_purged_remote_vm_matches_structured_payload() {
        assert!(is_run_purged_remote_response(
            StatusCode::GONE,
            r#"{"code":"run_purged","error":"remote run is gone"}"#
        ));
        assert!(is_run_purged_remote_response(
            StatusCode::NOT_FOUND,
            r#"{"code":"run_purged","error":"remote run is gone"}"#
        ));
        assert!(!is_run_purged_remote_response(
            StatusCode::NOT_FOUND,
            r#"{"error":"remote run is gone"}"#
        ));
        assert!(!is_run_purged_remote_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            r#"{"code":"run_purged","error":"remote run is gone"}"#
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
    fn generationless_v6_cleanup_uses_only_typed_logical_identity() {
        let mut vm = test_vm_status("vm-prelaunch", Some("run-1"));

        for state in [
            VmLifecycleState::Queued,
            VmLifecycleState::CachingImage,
            VmLifecycleState::PreparingDisks,
            VmLifecycleState::CreatingVm,
            VmLifecycleState::BootingVm,
            VmLifecycleState::Running,
            VmLifecycleState::DeletingVm,
            VmLifecycleState::ArchivingArtifacts,
            VmLifecycleState::Failed,
            VmLifecycleState::DeleteFailed,
        ] {
            vm.state = state;
            let selector = generationless_v6_launch_cleanup_selector(&vm)
                .expect("valid selector")
                .expect("V6 generation-less row is eligible in every retry state");
            assert_eq!(selector.generation, None);
            assert_eq!(
                selector.run_id.as_ref().map(ValidatedId::as_str),
                Some("run-1")
            );
            assert_eq!(
                selector.vm_id.as_ref().map(ValidatedId::as_str),
                Some("vm-prelaunch")
            );
        }

        vm.details.as_mut().expect("details").jail_generation = Some("generation-1".to_string());
        assert!(
            generationless_v6_launch_cleanup_selector(&vm)
                .expect("generation selector check")
                .is_none(),
            "persisted generations must use generation identity"
        );

        let mut historical = test_vm_status("vm-historical", Some("run-1"));
        let details = historical.details.as_mut().expect("details");
        details.cpu_millis = None;
        details.vcpu_count = None;
        assert!(
            generationless_v6_launch_cleanup_selector(&historical)
                .expect("historical selector check")
                .is_none(),
            "pre-V6 generation-less rows must remain local-only"
        );
    }

    #[test]
    fn generationless_v6_cleanup_rejects_missing_or_invalid_logical_ids() {
        let mut missing_run = test_vm_status("vm-prelaunch", None);
        missing_run.state = VmLifecycleState::CreatingVm;
        assert!(generationless_v6_launch_cleanup_selector(&missing_run).is_err());

        let invalid_vm = test_vm_status("vm/invalid", Some("run-1"));
        assert!(generationless_v6_launch_cleanup_selector(&invalid_vm).is_err());
    }

    #[test]
    fn logical_cleanup_treats_not_found_stop_and_destroy_as_idempotent_success() {
        for operation in [
            JailerIdentityOperation::Stop,
            JailerIdentityOperation::Destroy,
        ] {
            let response = JailerResponse::Error(intar_jailer_protocol::ProtocolError::new(
                "not_found",
                "logical VM is already absent",
            ));
            assert!(
                classify_jailer_identity_response(operation, response)
                    .expect("not-found cleanup is successful")
                    .is_none()
            );
        }
    }

    #[test]
    fn logical_cleanup_failure_is_not_misclassified_as_absence() {
        let response = JailerResponse::Error(intar_jailer_protocol::ProtocolError::new(
            "resource_busy",
            "unit still populated",
        ));
        assert!(
            classify_jailer_identity_response(JailerIdentityOperation::Destroy, response).is_err()
        );
    }

    #[test]
    fn provisional_state_reservation_is_atomic_and_rollback_preserves_siblings() {
        let first = test_vm_status("vm-1", Some("run-1"));
        let duplicate = first.clone();
        let sibling = test_vm_status("vm-2", Some("run-1"));
        let replacement = {
            let mut replacement = first.clone();
            replacement.created_at_s = replacement.created_at_s.saturating_add(1);
            replacement
        };
        let mut states = BTreeMap::new();

        assert!(reserve_vm_state(&mut states, first.clone()));
        assert!(!reserve_vm_state(&mut states, duplicate));
        assert!(reserve_vm_state(&mut states, sibling.clone()));
        assert!(remove_matching_vm_state(&mut states, &first));
        assert!(states.contains_key(&sibling.name));

        assert!(reserve_vm_state(&mut states, replacement));
        assert!(!remove_matching_vm_state(&mut states, &first));
        assert!(states.contains_key(&first.name));
    }

    #[tokio::test]
    async fn staging_rollback_removes_only_the_reserved_vm_paths() {
        let temp = tempdir().expect("temp dir");
        let vm_dir = temp.path().join("vms").join("vm-1");
        let spool_dir = temp.path().join("run-spool").join("run-1").join("vm-1");
        let sibling_dir = temp.path().join("vms").join("vm-2");
        tokio::fs::create_dir_all(&vm_dir).await.expect("vm dir");
        tokio::fs::create_dir_all(spool_dir.join("artifacts"))
            .await
            .expect("spool dir");
        tokio::fs::create_dir_all(&sibling_dir)
            .await
            .expect("sibling dir");

        remove_vm_staging_paths("vm-1", &vm_dir, &spool_dir)
            .await
            .expect("rollback paths");

        assert!(!vm_dir.exists());
        assert!(!spool_dir.exists());
        assert!(sibling_dir.exists());
    }

    #[test]
    fn generationless_cleanup_keeps_run_network_until_sibling_row_is_removed() {
        let orphan = test_vm_status("vm-orphan", Some("run-1"));
        let sibling = test_vm_status("vm-sibling", Some("run-1"));
        let mut states = BTreeMap::from([
            (orphan.name.clone(), orphan.clone()),
            (sibling.name.clone(), sibling.clone()),
        ]);

        assert!(
            generationless_v6_launch_cleanup_selector(&orphan)
                .expect("selector")
                .is_some()
        );
        assert!(has_other_tracked_vm_for_run(&states, &orphan.name, "run-1"));

        states.remove(&sibling.name);
        assert!(!has_other_tracked_vm_for_run(
            &states,
            &orphan.name,
            "run-1"
        ));
    }

    #[test]
    fn pending_same_run_sibling_keeps_shared_network_tracked() {
        let deleting = test_vm_status("vm-deleting", Some("run-1"));
        let mut pending = test_vm_status("vm-pending", Some("run-1"));
        pending.state = VmLifecycleState::CachingImage;
        assert_eq!(
            pending
                .details
                .as_ref()
                .and_then(|details| details.jail_generation.as_deref()),
            None,
            "fixture must represent a sibling not yet committed to jailerd"
        );
        let states = BTreeMap::from([
            (deleting.name.clone(), deleting),
            (pending.name.clone(), pending),
        ]);

        assert!(has_other_tracked_vm_for_run(
            &states,
            "vm-deleting",
            "run-1"
        ));
    }

    #[test]
    fn ordered_same_run_cleanup_recognizes_the_last_vm_after_predecessor_removal() {
        let first = test_vm_status("vm-first", Some("run-1"));
        let last = test_vm_status("vm-last", Some("run-1"));
        let mut states = BTreeMap::from([(first.name.clone(), first), (last.name.clone(), last)]);

        assert!(has_other_tracked_vm_for_run(&states, "vm-first", "run-1"));
        states.remove("vm-first");
        assert!(!has_other_tracked_vm_for_run(&states, "vm-last", "run-1"));
    }

    #[tokio::test]
    async fn run_lock_serializes_cleanup_and_launch_without_blocking_other_runs() {
        let locks = Arc::new(Mutex::new(BTreeMap::new()));
        let cleanup_guard = acquire_run_cleanup_lock(&locks, "run-1").await;

        let (attempting_tx, attempting_rx) = tokio::sync::oneshot::channel();
        let (acquired_tx, mut acquired_rx) = tokio::sync::oneshot::channel();
        let same_run_locks = Arc::clone(&locks);
        let launch_task = tokio::spawn(async move {
            let _ = attempting_tx.send(());
            let _launch_guard = acquire_run_cleanup_lock(&same_run_locks, "run-1").await;
            let _ = acquired_tx.send(());
        });
        attempting_rx.await.expect("same-run launch started");

        assert!(
            timeout(Duration::from_millis(25), &mut acquired_rx)
                .await
                .is_err(),
            "same-run launch acquired its lock before cleanup completed"
        );

        let other_run_guard = timeout(
            Duration::from_secs(1),
            acquire_run_cleanup_lock(&locks, "run-2"),
        )
        .await
        .expect("another run's launch must not wait behind run-1 cleanup");
        drop(other_run_guard);

        drop(cleanup_guard);
        timeout(Duration::from_secs(1), &mut acquired_rx)
            .await
            .expect("same-run launch should continue after cleanup")
            .expect("same-run launch should report lock acquisition");
        launch_task.await.expect("same-run launch completed");
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn probe_replay_preserves_stored_envelope_payload() {
        let stored = ProbeUpdateEnvelope {
            update_id: "update-1".to_string(),
            vm_name: "vm-1".to_string(),
            run_id: "run-1".to_string(),
            jail_generation: "generation-1".to_string(),
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
    fn scenario_runtime_ready_timeout_scales_with_fractional_quota() -> Result<()> {
        assert_eq!(
            scenario_runtime_ready_timeout(2_000)?,
            Duration::from_secs(45)
        );
        assert_eq!(
            scenario_runtime_ready_timeout(1_000)?,
            Duration::from_secs(45)
        );
        assert_eq!(
            scenario_runtime_ready_timeout(999)?,
            Duration::from_secs(46)
        );
        assert_eq!(
            scenario_runtime_ready_timeout(500)?,
            Duration::from_secs(90)
        );
        assert_eq!(
            scenario_runtime_ready_timeout(125)?,
            Duration::from_secs(360)
        );
        assert_eq!(
            scenario_runtime_ready_timeout(124)?,
            Duration::from_secs(360)
        );
        assert_eq!(
            scenario_runtime_ready_timeout(126)?,
            Duration::from_secs(358)
        );
        assert_eq!(scenario_runtime_ready_timeout(1)?, Duration::from_secs(360));
        assert_eq!(
            scenario_runtime_ready_timeout(u32::MAX)?,
            Duration::from_secs(45)
        );
        assert!(scenario_runtime_ready_timeout(0).is_err());
        Ok(())
    }

    #[test]
    fn scenario_runtime_proc_stat_parser_handles_parentheses_in_process_name() {
        let value = concat!(
            "42 (cloud hyper)visor) S ",
            "1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 ",
            "987654 20 21"
        );

        assert_eq!(parse_linux_proc_stat(value), Some(('S', 987_654)));
        assert_eq!(parse_linux_proc_stat("not a proc stat record"), None);
    }

    #[test]
    fn scenario_runtime_liveness_fails_only_on_definitive_process_loss() {
        let alive = ScenarioRuntimeProcessObservation::Present {
            state: 'S',
            start_time_ticks: 123,
        };
        assert_eq!(
            classify_scenario_runtime_process_liveness(42, Some(123), alive),
            ScenarioRuntimeProcessLiveness::Alive
        );

        let disappeared = classify_scenario_runtime_process_liveness(
            42,
            Some(123),
            ScenarioRuntimeProcessObservation::Missing,
        );
        assert!(matches!(
            disappeared,
            ScenarioRuntimeProcessLiveness::Dead(ref reason) if reason.contains("pid 42 exited")
        ));

        let zombie = classify_scenario_runtime_process_liveness(
            42,
            Some(123),
            ScenarioRuntimeProcessObservation::Present {
                state: 'Z',
                start_time_ticks: 123,
            },
        );
        assert!(matches!(
            zombie,
            ScenarioRuntimeProcessLiveness::Dead(ref reason) if reason.contains("process state Z")
        ));

        let reused = classify_scenario_runtime_process_liveness(
            42,
            Some(123),
            ScenarioRuntimeProcessObservation::Present {
                state: 'S',
                start_time_ticks: 124,
            },
        );
        assert!(matches!(
            reused,
            ScenarioRuntimeProcessLiveness::Dead(ref reason) if reason.contains("was reused")
        ));

        assert_eq!(
            classify_scenario_runtime_process_liveness(
                42,
                None,
                ScenarioRuntimeProcessObservation::Present {
                    state: 'S',
                    start_time_ticks: 123,
                },
            ),
            ScenarioRuntimeProcessLiveness::Inconclusive
        );
    }

    #[test]
    fn scenario_runtime_liveness_keeps_transient_observation_errors_inconclusive() {
        assert_eq!(
            classify_scenario_runtime_process_liveness(
                42,
                Some(123),
                ScenarioRuntimeProcessObservation::Unavailable,
            ),
            ScenarioRuntimeProcessLiveness::Inconclusive
        );
    }

    #[test]
    fn hidden_proc_entry_is_missing_only_when_pid_probe_reports_esrch() {
        assert_eq!(
            classify_missing_proc_entry(Some(Err(rustix::io::Errno::SRCH))),
            ScenarioRuntimeProcessObservation::Missing
        );
        assert_eq!(
            classify_missing_proc_entry(Some(Err(rustix::io::Errno::PERM))),
            ScenarioRuntimeProcessObservation::Unavailable
        );
        assert_eq!(
            classify_missing_proc_entry(Some(Ok(()))),
            ScenarioRuntimeProcessObservation::Unavailable
        );
        assert_eq!(
            classify_missing_proc_entry(None),
            ScenarioRuntimeProcessObservation::Unavailable
        );
    }

    #[test]
    fn scenario_runtime_timeout_context_reports_missing_vsock_socket() {
        let message = scenario_runtime_timeout_context(
            Path::new("/var/cache/intar-agent/vms/demo/kino.vsock"),
            false,
            Duration::from_secs(360),
        );

        assert!(message.contains("timed out after 360s"));
        assert!(message.contains("never created the Kino vsock socket"));
        assert!(message.contains("cloud-hypervisor.stderr.log"));
    }

    #[test]
    fn scenario_runtime_timeout_context_reports_existing_vsock_socket() {
        let message = scenario_runtime_timeout_context(
            Path::new("/var/cache/intar-agent/vms/demo/kino.vsock"),
            true,
            Duration::from_secs(360),
        );

        assert!(message.contains("timed out after 360s"));
        assert!(message.contains("created the Kino vsock socket"));
        assert!(!message.contains("cloud-hypervisor.stderr.log"));
    }

    #[test]
    fn cloud_hypervisor_config_uses_direct_boot_payload_and_stable_disks() {
        let cached_image = image_cache::CachedImage {
            image_key: "broken".to_string(),
            image_sha256: "a".repeat(64),
            raw_path: PathBuf::from("/cache/images/broken.raw"),
            raw_sha256: "d".repeat(64),
            kernel_path: PathBuf::from("/cache/artifacts/vmlinuz"),
            initrd_path: PathBuf::from("/cache/artifacts/initrd.img"),
            kernel_sha256: "b".repeat(64),
            initrd_sha256: "c".repeat(64),
            cmdline: "root=/dev/vda rw console=ttyS0 quiet loglevel=4".to_string(),
            virtual_size_bytes: 2 * 1024 * 1024 * 1024,
        };
        let paths = JailPathMap {
            host_jail_root: PathBuf::from("/work/jails/vm-demo/root"),
            host_api_socket: PathBuf::from("/work/jails/vm-demo/root/run/cloud-hypervisor.sock"),
            host_vsock_socket: PathBuf::from("/work/jails/vm-demo/root/run/kino.vsock"),
            host_kernel: cached_image.kernel_path.clone(),
            host_initrd: Some(cached_image.initrd_path.clone()),
            host_root_disk: PathBuf::from("/work/vms/vm-demo/root.raw"),
            host_runtime_disk: PathBuf::from("/work/vms/vm-demo/runtime.vfat"),
            host_recording_disk: PathBuf::from("/work/runs/run-1/vm-demo/recordings.vfat"),
            jailed_api_socket: PathBuf::from("/run/cloud-hypervisor.sock"),
            jailed_vsock_socket: PathBuf::from("/run/kino.vsock"),
            jailed_kernel: PathBuf::from("/boot/kernel"),
            jailed_initrd: Some(PathBuf::from("/boot/initrd")),
            jailed_root_disk: PathBuf::from("/disks/root.raw"),
            jailed_runtime_disk: PathBuf::from("/disks/runtime.vfat"),
            jailed_recording_disk: PathBuf::from("/disks/recordings.vfat"),
            host_serial_log: PathBuf::from("/work/jails/vm-demo/root/logs/serial.log"),
            host_console_log: PathBuf::from("/work/jails/vm-demo/root/logs/console.log"),
            host_stderr_log: PathBuf::from(
                "/work/jails/vm-demo/root/logs/cloud-hypervisor.stderr.log",
            ),
            jailed_serial_log: PathBuf::from("/logs/serial.log"),
            jailed_console_log: PathBuf::from("/logs/console.log"),
        };

        let cfg = build_cloud_hypervisor_vm_config(CloudHypervisorVmConfigInput {
            name: "vm-demo",
            cmdline: &cached_image.cmdline,
            paths: &paths,
            vcpus: 2,
            memory_mib: 768,
            tap: "intar-tap0",
            mac: "02:00:00:00:00:01",
            kino_vsock_cid: 10_042,
        })
        .expect("vm config should render");

        assert_eq!(cfg.landlock_enable, Some(true));
        assert_eq!(cfg.payload.firmware, None);
        assert_eq!(cfg.payload.kernel.as_deref(), Some("/boot/kernel"));
        assert_eq!(cfg.payload.initramfs.as_deref(), Some("/boot/initrd"));
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
            Some("/logs/serial.log")
        );
        assert_eq!(
            cfg.console
                .as_ref()
                .and_then(|console| console.file.as_deref()),
            Some("/logs/console.log")
        );

        let disks = cfg.disks.as_ref().expect("disks");
        assert_eq!(disks.len(), 3);
        assert_eq!(disks[0].path, "/disks/root.raw");
        assert!(!disks[0].readonly);
        assert_eq!(disks[0].id.as_deref(), Some("vm-demo-root"));
        assert!(matches!(
            disks[0].image_type.as_ref(),
            Some(DiskImageType::Raw)
        ));
        assert_eq!(disks[1].path, "/disks/runtime.vfat");
        assert!(disks[1].readonly);
        assert_eq!(disks[1].id.as_deref(), Some("vm-demo-runtime"));
        assert!(matches!(
            disks[1].image_type.as_ref(),
            Some(DiskImageType::Raw)
        ));
        assert_eq!(disks[2].path, "/disks/recordings.vfat");
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
        assert_eq!(vsock.socket, "/run/kino.vsock");
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
            "image_sha256": "a".repeat(64),
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
        assert_eq!(req.image_sha256, "a".repeat(64));
        assert!(req.runtime.peer_vm_names.is_empty());
        assert!(req.runtime.peer_vm_aliases.is_empty());
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
            "image": "broken-nginx-webserver-amd64",
            "image_sha256": "a".repeat(64)
        }))
        .expect_err("missing runtime field should be rejected");

        let msg = err.to_string();
        assert!(
            msg.contains("missing field `runtime`"),
            "unexpected serde error: {msg}"
        );
    }

    #[test]
    fn create_scenario_vm_request_rejects_missing_image_digest() {
        let error = serde_json::from_value::<CreateScenarioVmRequest>(json!({
            "name": "demo",
            "run_id": "abc123demo",
            "image": "broken-nginx-webserver-amd64",
            "runtime": {
                "ssh_authorized_keys_openssh": ["ssh-ed25519 AAAATEST stargate-target"]
            }
        }))
        .expect_err("the v2 launch descriptor digest must be explicit");
        assert!(error.to_string().contains("image_sha256"));
    }

    #[test]
    fn create_scenario_vm_request_rejects_unknown_field() {
        let err = serde_json::from_value::<CreateScenarioVmRequest>(json!({
            "name": "demo",
            "run_id": "abc123demo",
            "image": "broken-nginx-webserver-amd64",
            "image_sha256": "a".repeat(64),
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
            "image_sha256": "a".repeat(64),
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
        let quota = CpuQuota::from_millis(125).expect("quota");
        let details = vm.details.as_mut().expect("details");
        details.ssh_public_port = Some(2222);
        details.jail_generation = Some("generation-1".to_string());
        details.cpu_runtime = Some(VmCpuRuntimeState {
            phase: VmCpuPhase::Steady,
            steady_quota: quota,
            effective_quota: quota,
            boot_deadline_unix_ms: None,
            attestation: Some(CpuQuotaAttestation {
                quota,
                cpu_max: quota.cpu_max(),
                cpu_max_burst: 0,
                verified_at_unix_ms: 1_200,
            }),
        });

        let state = terminal_state_from_vm(&vm, &test_ssh_access_config(), true, 1234)
            .expect("terminal state");

        assert_eq!(state.run_id, "run-1");
        assert_eq!(state.vm_name, "vm-ready");
        assert_eq!(state.state, VmTerminalStateKind::Ready);
        assert_eq!(state.reason, None);
        assert_eq!(
            state
                .runtime_constraints
                .as_ref()
                .map(|constraints| constraints.phase.clone()),
            Some(VmRuntimeConstraintPhaseV1::Steady)
        );
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
    fn terminal_state_stays_pending_without_steady_quota_attestation() {
        let mut vm = test_vm_status("vm-unsealed", Some("run-1"));
        vm.state = VmLifecycleState::Running;
        vm.details.as_mut().expect("details").ssh_public_port = Some(2222);

        let state = terminal_state_from_vm(&vm, &test_ssh_access_config(), true, 1234)
            .expect("terminal state");

        assert_eq!(state.state, VmTerminalStateKind::Pending);
        assert_eq!(state.terminal_target, None);
        assert_eq!(state.runtime_constraints, None);
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
