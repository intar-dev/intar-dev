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
use intar_contracts::bridge::{VmRuntimeConstraintPhaseV1, VmRuntimeConstraintsV1};
use intar_jailer_protocol::{
    ArtifactAccess, ArtifactSource, AsyncSeqpacketClient, DestroyRunNetworkRequest,
    EnsureRunNetworkRequest, FinalizeVmBootRequest, FinalizeVmBootResult, JailPathMap,
    JailerCapabilities, LaunchVmV2Request, PREPARED_IMAGE_SOURCE_ROOT, PrepareImageV2Request,
    PreparedImageV2Result, Request as JailerRequest, Response as JailerResponse, RunNetworkResult,
    SandboxHealth, Sha256Digest, SourceArtifacts, ValidatedId, VmCpuPhase, VmCpuRuntimeState,
    VmIdentityRequest, VmInspection, VmLaunchRequest, VmLaunchResult,
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
use tokio::sync::{Mutex, Notify, OnceCell, OwnedMutexGuard, RwLock, Semaphore, broadcast, watch};
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
const ARCHIVE_HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const ARCHIVE_HTTP_READ_TIMEOUT: Duration = Duration::from_secs(30);
const ARCHIVE_HTTP_TOTAL_TIMEOUT: Duration = Duration::from_secs(120);
const ARCHIVE_STAGE_REPORT_TIMEOUT: Duration = Duration::from_secs(10);
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
    terminal_states: RwLock<BTreeMap<String, VmTerminalState>>,
    terminal_updates_tx: broadcast::Sender<VmTerminalState>,
    /// Monotonic, coalescing notification for changes that must be reflected
    /// in the host's actual VM inventory. The bridge owns the receiver and
    /// publishes a fresh state report immediately instead of waiting for the
    /// periodic repair/report loop.
    inventory_updates_tx: watch::Sender<u64>,
    kino_vsock_cid_lock: Mutex<()>,
    create_sem: Arc<Semaphore>,
    delete_requests: Mutex<BTreeSet<String>>,
    cleanup_locks: Mutex<BTreeMap<String, Arc<Mutex<()>>>>,
    run_cleanup_locks: Mutex<BTreeMap<String, Arc<Mutex<()>>>>,
    archive_jobs_lock: Mutex<()>,
    /// A permit is retained when the archive worker is between waits, so a
    /// durable queue insertion never has to wait for the ten-second sweep.
    archive_jobs_notify: Notify,
}

mod api;
mod launch;
use launch::*;
mod readiness;
use readiness::*;
mod archive;
use archive::*;
mod cleanup;
use cleanup::*;
mod probes;
use probes::*;
mod jailer_network;
use jailer_network::*;
mod network_allocation;
use network_allocation::*;
mod state;
use state::*;
#[cfg(test)]
mod tests;
