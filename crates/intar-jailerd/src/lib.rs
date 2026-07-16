#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet};
#[cfg(any(target_os = "linux", test))]
use std::ffi::OsString;
use std::ffi::{CStr, CString};
use std::fs::{File, OpenOptions};
use std::io::{Read as _, Seek as _, SeekFrom, Write as _};
use std::os::fd::OwnedFd;
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result, bail, ensure};
#[cfg(target_os = "linux")]
use intar_jailer_protocol::CpuStat;
use intar_jailer_protocol::{
    ArtifactAccess, ArtifactSource, CLOUD_HYPERVISOR_SHA256, CLOUD_HYPERVISOR_VERSION, CpuQuota,
    CpuQuotaAttestation, DestroyRunNetworkRequest, EnsureRunNetworkRequest, FinalizeVmBootRequest,
    FinalizeVmBootResult, JailPathMap, JailSpecV1, JailerCapabilities, JailerdConfig,
    LaunchVmV2Request, OperationResult, PREPARED_IMAGE_SOURCE_ROOT, PROTOCOL_VERSION,
    PrepareImageV2Request, PreparedImageV2Result, ProtocolError, Request, Response,
    RunNetworkResult, SandboxHealth, Sha256Digest, SourceArtifacts, ValidatedId, VmCpuPhase,
    VmCpuRuntimeState, VmIdentityRequest, VmInspection, VmLaunchRequest, VmLaunchResult,
};
use rustix::fs::{Mode, OFlags, open};
#[cfg(target_os = "linux")]
use rustix::fs::{ResolveFlags, openat2};
use serde::{Deserialize, Serialize};
use serde_json::to_writer;
use sha2::{Digest as _, Sha256};
use thiserror::Error;
use uuid::Uuid;

#[cfg(target_os = "linux")]
mod network;
#[cfg(target_os = "linux")]
use network::NetworkManager;
pub mod self_test;

#[cfg(any(target_os = "linux", test))]
const CAP_SYS_PTRACE_BIT: u32 = 19;
#[cfg(target_os = "linux")]
const VMM_START_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(target_os = "linux")]
const BOOT_CPU_GUARDIAN_START_TIMEOUT: Duration = Duration::from_secs(2);

/// A launch description which maps directly to a systemd transient service.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UnitLaunchSpec {
    pub generation: ValidatedId,
    pub unit_name: String,
    pub description: String,
    pub jailer_binary: PathBuf,
    pub jail_spec_path: PathBuf,
    pub api_socket_path: PathBuf,
    pub cpu_quota: CpuQuota,
    pub steady_cpu_quota: CpuQuota,
    pub boot_cpu_lease_ms: Option<u64>,
    /// Exact identity of the template-backed Cloud Hypervisor clone. V2
    /// launches use this for the one launch-time process check; recovery and
    /// periodic inspection deliberately retain full digest verification.
    pub vmm_executable_identity: Option<RuntimeFileIdentity>,
    pub uid: u32,
    pub gid: u32,
    pub device_allow: Vec<&'static str>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BootCpuGuardianRequest {
    generation: ValidatedId,
    unit_name: String,
    steady_quota: CpuQuota,
    deadline_uptime_millis: u64,
}

impl BootCpuGuardianRequest {
    pub fn new(
        generation: ValidatedId,
        unit_name: String,
        steady_quota: CpuQuota,
        deadline_uptime_millis: u64,
    ) -> Result<Self> {
        let expected_unit_name = vm_unit_name(&generation);
        if unit_name != expected_unit_name {
            bail!("boot CPU guardian unit mismatch: expected {expected_unit_name}, got {unit_name}")
        }
        if deadline_uptime_millis == 0 {
            bail!("boot CPU guardian deadline must be positive")
        }
        Ok(Self {
            generation,
            unit_name,
            steady_quota,
            deadline_uptime_millis,
        })
    }

    pub fn generation(&self) -> &ValidatedId {
        &self.generation
    }

    pub fn unit_name(&self) -> &str {
        &self.unit_name
    }

    pub fn steady_quota(&self) -> CpuQuota {
        self.steady_quota
    }

    pub fn deadline_uptime_millis(&self) -> u64 {
        self.deadline_uptime_millis
    }
}

mod systemd_backend;
use systemd_backend::*;
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeFileIdentity {
    pub device: u64,
    pub inode: u64,
    pub bytes: u64,
}

const JAIL_DEVICE_ALLOW: &[&str] = &[
    "/dev/kvm rwm",
    "/dev/net/tun rwm",
    "/dev/urandom rm",
    "/dev/null rwm",
];

impl UnitLaunchSpec {
    /// Properties required on the transient unit. Backends must apply all of
    /// them atomically or fail the launch.
    pub fn required_properties(&self) -> BTreeMap<&'static str, String> {
        let mut properties = BTreeMap::from([
            ("Slice", "intar-vms.slice".to_owned()),
            (
                "CPUQuotaPerSecUSec",
                (u64::from(self.cpu_quota.cpu_millis) * 1_000).to_string(),
            ),
            (
                "CPUQuotaPeriodUSec",
                self.cpu_quota.period_micros.to_string(),
            ),
            ("KillMode", "control-group".to_owned()),
            ("Restart", "no".to_owned()),
            ("ExitType", "cgroup".to_owned()),
            ("RestrictRealtime", "yes".to_owned()),
            ("LimitRTPRIO", "0".to_owned()),
            ("DevicePolicy", "closed".to_owned()),
            ("NoNewPrivileges", "no".to_owned()),
        ]);
        if self.boot_cpu_lease_ms.is_some() {
            properties.insert("BindsTo", boot_cpu_guardian_unit_name(&self.generation));
        }
        properties
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StartedUnit {
    pub unit_name: String,
    pub pid: Option<u32>,
    pub cgroup_path: Option<PathBuf>,
    pub host_boot_id: Option<String>,
    pub pid_start_time_ticks: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BackendInspection {
    pub pid: Option<u32>,
    pub cgroup_path: Option<PathBuf>,
    pub host_boot_id: Option<String>,
    pub pid_start_time_ticks: Option<u64>,
    pub netns_inode: Option<u64>,
    pub jail_root_inode: Option<u64>,
    pub executable_sha256: Option<String>,
    pub health: SandboxHealth,
    pub cpu_stat: Option<intar_jailer_protocol::CpuStat>,
    pub seccomp_enabled: bool,
    pub landlock_enabled: bool,
    pub no_new_privs: bool,
    pub capabilities_empty: bool,
}

/// Privileged host operations. The production implementation must use the
/// systemd D-Bus API and netlink/nftables APIs; it must never interpolate a
/// request into a shell command.
pub trait HostBackend: Send {
    fn production_ready(&self) -> bool;
    fn start_unit(&mut self, spec: &UnitLaunchSpec) -> Result<StartedUnit>;
    fn inspect_unit(&mut self, unit_name: &str) -> Result<BackendInspection>;
    /// Atomically update the unit quota and read back both `cpu.max` and
    /// `cpu.max.burst`. Success is a privileged live attestation.
    fn update_unit_cpu_quota(
        &mut self,
        unit_name: &str,
        cgroup_path: &Path,
        quota: CpuQuota,
    ) -> Result<()>;
    fn stop_unit(&mut self, unit_name: &str) -> Result<bool>;
    /// Remove an already-drained unit. Implementations must return `false`
    /// only when the unit no longer exists and must refuse active units.
    fn destroy_unit(&mut self, unit_name: &str) -> Result<bool>;
    fn ensure_run_network(&mut self, request: &EnsureRunNetworkRequest)
    -> Result<RunNetworkResult>;
    /// Reconstruct and re-render a previously tracked run even when its
    /// launch-time exact-hit marker is current.
    fn repair_run_network(&mut self, request: &EnsureRunNetworkRequest)
    -> Result<RunNetworkResult>;
    fn ensure_vm_network(
        &mut self,
        run: &EnsureRunNetworkRequest,
        request: &VmLaunchRequest,
        generation: &ValidatedId,
        uid: u32,
        gid: u32,
    ) -> Result<()>;
    fn recover_vm_network(
        &mut self,
        run: &EnsureRunNetworkRequest,
        request: &VmLaunchRequest,
        generation: &ValidatedId,
        uid: u32,
        gid: u32,
    ) -> Result<()> {
        self.ensure_vm_network(run, request, generation, uid, gid)
    }
    /// Activate or revoke the reserved public SSH forwarding rule. The TAP
    /// remains attached in either state.
    fn set_vm_ssh_forwarding(
        &mut self,
        run_id: &ValidatedId,
        generation: &ValidatedId,
        active: bool,
    ) -> Result<bool>;
    fn destroy_vm_network(
        &mut self,
        run_id: &ValidatedId,
        generation: &ValidatedId,
    ) -> Result<bool>;
    fn destroy_run_network(&mut self, request: &DestroyRunNetworkRequest) -> Result<bool>;
}

/// Fail-closed production placeholder until the D-Bus/netlink backend is
/// linked. Capabilities accurately report that VM launches are unavailable.
#[derive(Default)]
pub struct UnavailableHostBackend;

/// systemd transient-unit backend. Networking remains a separate fail-closed
/// boundary until the netlink/nftables implementation is available.
#[cfg(target_os = "linux")]
#[derive(Clone)]
pub struct SystemdHostBackend {
    network: Arc<Mutex<NetworkManager>>,
    system_bus: zbus::blocking::Connection,
    cloud_hypervisor_sha256: Sha256Digest,
    guardian_binary: PathBuf,
    landlock_attested: bool,
}

mod host_validation;
#[cfg(any(target_os = "linux", test))]
use host_validation::*;
#[derive(Clone, Debug)]
pub struct PreparedJail {
    pub generation: ValidatedId,
    pub uid: u32,
    pub gid: u32,
    pub spec_path: PathBuf,
    pub jail_root_inode: Option<u64>,
    pub vmm_executable_identity: Option<RuntimeFileIdentity>,
    pub paths: JailPathMap,
}

pub trait JailPreparer: Send {
    /// Whether this preparer can guarantee clone-only template staging on the
    /// configured jail filesystem.
    fn fast_template_store(&mut self, _config: &JailerdConfig) -> bool {
        false
    }
    /// Cheap live validation used when publishing capabilities. Production
    /// checks the pinned source/template inode identities so post-prewarm
    /// tampering immediately withdraws the fast-launch capability.
    fn fast_template_store_ready(&self, _config: &JailerdConfig) -> bool {
        true
    }
    fn prepare_image_v2(
        &mut self,
        _config: &JailerdConfig,
        _request: &PrepareImageV2Request,
    ) -> Result<PreparedImageV2Result> {
        bail!("template-backed image preparation is unavailable")
    }
    fn validate_prepared_launch(
        &mut self,
        _config: &JailerdConfig,
        _request: &LaunchVmV2Request,
    ) -> Result<()> {
        bail!("template-backed VM launch is unavailable")
    }
    fn prepare(
        &mut self,
        config: &JailerdConfig,
        request: &VmLaunchRequest,
        run_network: &RunNetworkResult,
        generation: &ValidatedId,
        uid: u32,
        gid: u32,
    ) -> Result<PreparedJail>;
    fn prepare_v2(
        &mut self,
        config: &JailerdConfig,
        request: &VmLaunchRequest,
        run_network: &RunNetworkResult,
        generation: &ValidatedId,
        uid: u32,
        gid: u32,
    ) -> Result<PreparedJail> {
        self.prepare(config, request, run_network, generation, uid, gid)
    }
    fn destroy(&mut self, config: &JailerdConfig, generation: &ValidatedId) -> Result<bool>;
    fn quarantine(&mut self, config: &JailerdConfig, generation: &ValidatedId) -> Result<()>;
    fn grant_agent_runtime_access(
        &mut self,
        _config: &JailerdConfig,
        _generation: &ValidatedId,
        _uid: u32,
        _gid: u32,
    ) -> Result<()>;
    fn persist(&mut self, _config: &JailerdConfig, _record: &VmRecord) -> Result<()> {
        Ok(())
    }
    fn recover(&mut self, _config: &JailerdConfig) -> Result<Vec<VmRecord>> {
        Ok(Vec::new())
    }
    fn export_recording(&mut self, _config: &JailerdConfig, _record: &VmRecord) -> Result<()> {
        Ok(())
    }
    fn reserve_identity(
        &mut self,
        _config: &JailerdConfig,
        _generation: &ValidatedId,
        _uid: u32,
        _gid: u32,
    ) -> Result<()> {
        Ok(())
    }
    fn release_identity_reservation(
        &mut self,
        _config: &JailerdConfig,
        _generation: &ValidatedId,
    ) -> Result<()> {
        Ok(())
    }
    fn recover_reserved_identities(&mut self, _config: &JailerdConfig) -> Result<BTreeSet<u32>> {
        Ok(BTreeSet::new())
    }
}

#[derive(Clone, Default)]
pub struct FileSystemJailPreparer {
    host_template: Option<HostTemplateMetadataV2>,
    fast_store_attestation: Option<FastTemplateStoreAttestation>,
}

mod jail_preparer;
use jail_preparer::*;
const VM_RECORD_METADATA_VERSION: u16 = 2;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VmRecord {
    schema_version: u16,
    generation: ValidatedId,
    request: VmLaunchRequest,
    request_fingerprint: Sha256Digest,
    run_network: RunNetworkRecord,
    unit_name: String,
    uid: u32,
    gid: u32,
    #[serde(rename = "steady_quota")]
    quota: CpuQuota,
    effective_quota: CpuQuota,
    cpu_phase: VmCpuPhase,
    #[serde(deserialize_with = "deserialize_required_option")]
    boot_deadline_unix_ms: Option<u64>,
    /// Same-daemon hard deadline for live lease enforcement. This is runtime
    /// state only: the Unix deadline remains the durable/reporting identity,
    /// while recovery seals every reattached boot-phase record immediately.
    #[serde(skip)]
    boot_deadline_monotonic: Option<Instant>,
    #[serde(deserialize_with = "deserialize_required_option")]
    quota_attestation: Option<CpuQuotaAttestation>,
    ssh_forward_active: bool,
    vcpu_count: u16,
    paths: JailPathMap,
    cgroup_path: Option<PathBuf>,
    netns_name: String,
    host_boot_id: Option<String>,
    pid_start_time_ticks: Option<u64>,
    jail_root_inode: Option<u64>,
    cloud_hypervisor_sha256: String,
}

#[derive(Debug, Error)]
#[error(
    "boot CPU capacity pending: committed={committed} requested={requested} steady={steady} schedulable={schedulable}"
)]
struct BootCapacityPendingError {
    committed: u64,
    requested: u32,
    steady: u32,
    schedulable: u64,
}

impl VmRecord {
    fn effective_quota(&self) -> CpuQuota {
        self.effective_quota
    }

    fn cpu_runtime(&self) -> VmCpuRuntimeState {
        VmCpuRuntimeState {
            phase: self.cpu_phase,
            steady_quota: self.quota,
            effective_quota: self.effective_quota(),
            boot_deadline_unix_ms: self.boot_deadline_unix_ms,
            attestation: self.quota_attestation.clone(),
        }
    }
}

fn remaining_boot_cpu_lease_ms(deadline: Instant, now: Instant) -> Result<u64> {
    let remaining = deadline
        .checked_duration_since(now)
        .filter(|remaining| !remaining.is_zero())
        .context("boot CPU lease expired before transient unit start")?;
    let remaining_ms = u64::try_from(remaining.as_millis())
        .context("remaining boot CPU lease milliseconds overflow")?;
    ensure!(
        remaining_ms > 0,
        "boot CPU lease expired before transient unit start"
    );
    Ok(remaining_ms)
}

fn boot_cpu_lease_expired(
    monotonic_deadline: Option<Instant>,
    unix_deadline_ms: Option<u64>,
    monotonic_now: Instant,
    unix_now_ms: u64,
) -> bool {
    monotonic_deadline.map_or_else(
        || unix_deadline_ms.is_some_and(|deadline| deadline <= unix_now_ms),
        |deadline| deadline <= monotonic_now,
    )
}

fn deserialize_required_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

fn decode_vm_record_v2(bytes: &[u8]) -> Result<VmRecord> {
    let record: VmRecord =
        serde_json::from_slice(bytes).context("parse persisted v2 jail metadata")?;
    if record.schema_version != VM_RECORD_METADATA_VERSION {
        bail!(
            "unsupported jail metadata schema version {}",
            record.schema_version
        )
    }
    Ok(record)
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct RunNetworkRecord {
    request: EnsureRunNetworkRequest,
    result: RunNetworkResult,
}

#[derive(Clone, Debug)]
struct UnresolvedRecovery {
    run_id: ValidatedId,
    generation: ValidatedId,
    unit_name: String,
    uid: u32,
    gid: u32,
}

/// Capacity and identity reserved for a V2 launch whose filesystem, network,
/// and transient-unit work is executing outside the lifecycle-state lock.
/// Keeping the complete immutable input here fences the eventual commit and
/// prevents a concurrent retry from creating a second generation.
#[derive(Clone, Debug, Eq, PartialEq)]
struct LaunchReservation {
    generation: ValidatedId,
    request: VmLaunchRequest,
    request_fingerprint: Sha256Digest,
    run_network: RunNetworkRecord,
    uid: u32,
    gid: u32,
    quota: CpuQuota,
    effective_quota: CpuQuota,
    boot_deadline_unix_ms: u64,
    boot_deadline_monotonic: Instant,
}

pub struct JailerdCore<B, P> {
    config: JailerdConfig,
    backend: B,
    preparer: P,
    total_cpu_millis: u64,
    records: BTreeMap<ValidatedId, VmRecord>,
    /// Capacity charged before StartTransientUnit. It is transferred to
    /// `records` only after the unit identity is durably persisted, and is
    /// retained if cgroup drain cannot be proven.
    pending_cpu_reservations: BTreeMap<ValidatedId, CpuQuota>,
    /// V2 launches executing without the lifecycle lock. Entries are inserted
    /// atomically with their CPU charge and removed only by a generation-fenced
    /// success/failure commit.
    inflight_launches: BTreeMap<ValidatedId, LaunchReservation>,
    /// Failed launches and recovered generations whose complete containment
    /// still needs to be retried by the lease watchdog. These entries are
    /// deliberately independent from `records`: untrusted persisted metadata
    /// must never become an addressable live VM merely to make cleanup
    /// retryable.
    unresolved_recoveries: BTreeMap<ValidatedId, UnresolvedRecovery>,
    allocated_identities: BTreeSet<u32>,
    run_networks: BTreeMap<ValidatedId, RunNetworkRecord>,
    readiness: HostReadiness,
    fast_template_store: bool,
}

enum DetachedLaunchAdmission<B, P> {
    Existing(Box<DetachedExistingLaunchTask<B, P>>),
    Reserved(Box<DetachedLaunchTask<B, P>>),
}

struct DetachedExistingLaunchTask<B, P> {
    config: JailerdConfig,
    backend: B,
    preparer: P,
    record: VmRecord,
}

enum DetachedExistingLaunchOutcome {
    Success {
        record: VmRecord,
        inspection: BackendInspection,
    },
    InspectionFailed {
        record: VmRecord,
        error: anyhow::Error,
    },
    IdentityMismatch {
        record: VmRecord,
        error: anyhow::Error,
        containment: RecoveryContainmentOutcome,
    },
}

struct DetachedLaunchTask<B, P> {
    config: JailerdConfig,
    backend: B,
    preparer: P,
    reservation: LaunchReservation,
    prepared_request: LaunchVmV2Request,
}

struct DetachedLaunchSuccess {
    reservation: LaunchReservation,
    record: VmRecord,
    result: VmLaunchResult,
}

struct DetachedLaunchFailure {
    reservation: LaunchReservation,
    error: anyhow::Error,
    cgroup_drain_proven: bool,
    cleanup_failures: Vec<String>,
    identity_released: bool,
}

enum DetachedLaunchOutcome {
    Success(Box<DetachedLaunchSuccess>),
    Failure(Box<DetachedLaunchFailure>),
}

#[derive(Default)]
struct DetachedLaunchProgress {
    identity_reserved: bool,
    jail_prepare_attempted: bool,
    network_prepare_attempted: bool,
    unit_start_attempted: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct HostReadiness {
    pub uid_gid_range_collision_free: bool,
    pub config_trusted: bool,
    pub source_roots_trusted: bool,
    pub jailer_binary_trusted: bool,
    pub runtime_hash_verified: bool,
    pub runtime_statically_linked: bool,
    pub systemd_version: Option<String>,
    pub supports_systemd_transient_units: bool,
    pub supports_cgroup_v2: bool,
    pub seccomp_supported: bool,
    pub landlock_abi: Option<u32>,
    pub privileged_self_test_passed: bool,
    pub kvm_accounting_proven: bool,
    pub posix_acl_supported: bool,
}

impl HostReadiness {
    #[cfg(target_os = "linux")]
    pub fn probe(config: &JailerdConfig, config_path: &Path) -> Self {
        let systemd_version = systemd_version();
        let self_test = self_test::load_verified(config).ok().flatten();
        Self {
            uid_gid_range_collision_free: identity_range_is_free(config),
            config_trusted: path_is_root_trusted(config_path, false),
            source_roots_trusted: config
                .allowed_source_roots
                .iter()
                .all(|path| path_is_trusted_source_root(path, config.agent_uid, config.agent_gid)),
            jailer_binary_trusted: path_is_root_trusted(&config.jailer_binary, false),
            runtime_hash_verified: path_is_root_trusted(&config.cloud_hypervisor_binary, false)
                && file_digest_matches(
                    &config.cloud_hypervisor_binary,
                    &config.cloud_hypervisor_sha256,
                ),
            runtime_statically_linked: path_is_root_trusted(&config.cloud_hypervisor_binary, false)
                && elf_has_no_interpreter(&config.cloud_hypervisor_binary),
            supports_systemd_transient_units: systemd_version
                .as_deref()
                .and_then(systemd_major_version)
                .is_some_and(|version| version >= 252),
            systemd_version,
            supports_cgroup_v2: std::fs::read_to_string("/sys/fs/cgroup/cgroup.controllers")
                .is_ok_and(|controllers| {
                    controllers.split_whitespace().any(|value| value == "cpu")
                }),
            seccomp_supported: Path::new("/proc/sys/kernel/seccomp/actions_avail").is_file(),
            landlock_abi: self_test.as_ref().map(|value| value.landlock_abi),
            privileged_self_test_passed: self_test.as_ref().is_some_and(|value| {
                value.quota_verified
                    && value.burst_verified
                    && value.boot_quota_transition_verified
                    && value.network_verified
                    && value.landlock_negative_access
                    && value.cloud_hypervisor_lifecycle_verified
            }),
            kvm_accounting_proven: self_test
                .as_ref()
                .is_some_and(|value| value.kvm_accounting_proven),
            posix_acl_supported: ["/usr/bin/setfacl", "/usr/sbin/setfacl"]
                .iter()
                .any(|path| path_is_root_trusted(Path::new(path), false)),
        }
    }
}

mod detached_launch;
use detached_launch::*;
mod core_admission;
mod core_lifecycle;

/// Execute a V2 launch without holding the lifecycle-state mutex across
/// template validation, generation staging, networking, systemd activation,
/// or VMM readiness polling. Admission and completion remain short,
/// generation-fenced critical sections, and the boot quota is charged for the
/// entire unlocked interval.
pub fn launch_vm_v2_response<B, P>(
    core: &Arc<Mutex<JailerdCore<B, P>>>,
    request: LaunchVmV2Request,
) -> Response
where
    B: HostBackend + Clone,
    P: JailPreparer + Clone,
{
    if let Err(error) = request.validate() {
        return Response::Error(ProtocolError::new("invalid_request", error.to_string()));
    }

    let admission = {
        let mut core = match core.lock() {
            Ok(core) => core,
            Err(_) => {
                return Response::Error(ProtocolError::new(
                    "host_operation_failed",
                    "jailerd lifecycle state lock poisoned",
                ));
            }
        };
        if let Err(error) = core
            .config
            .validate_ssh_public_port(request.launch.ssh_public_port)
        {
            return Response::Error(ProtocolError::new("invalid_request", error.to_string()));
        }
        let capabilities = core.capabilities();
        if !(capabilities.supports_jailer_v2
            && capabilities.supports_template_backed_launch
            && capabilities.fast_template_store)
        {
            return Response::Error(ProtocolError::new(
                "host_not_ready",
                "host readiness attestation does not permit template-backed VM launches",
            ));
        }
        match core.begin_detached_launch_vm_v2(request) {
            Ok(admission) => admission,
            Err(error) => return protocol_error_response(error),
        }
    };

    match admission {
        DetachedLaunchAdmission::Existing(task) => {
            let DetachedExistingLaunchTask {
                config,
                mut backend,
                mut preparer,
                record,
            } = *task;
            let outcome = execute_existing_launch(&config, &mut backend, &mut preparer, record);
            let result = match core.lock() {
                Ok(mut core) => core.complete_detached_existing_launch(outcome),
                Err(_) => {
                    return Response::Error(ProtocolError::new(
                        "host_operation_failed",
                        "jailerd lifecycle state lock poisoned during idempotent launch commit",
                    ));
                }
            };
            match result {
                Ok(result) => Response::LaunchVmV2(result),
                Err(error) => protocol_error_response(error),
            }
        }
        DetachedLaunchAdmission::Reserved(task) => {
            let outcome = task.execute();
            let result = match core.lock() {
                Ok(mut core) => core.complete_detached_launch_vm_v2(outcome),
                Err(_) => {
                    return Response::Error(ProtocolError::new(
                        "host_operation_failed",
                        "jailerd lifecycle state lock poisoned during launch commit",
                    ));
                }
            };
            match result {
                Ok(result) => Response::LaunchVmV2(result),
                Err(error) => protocol_error_response(error),
            }
        }
    }
}

fn protocol_error_response(error: anyhow::Error) -> Response {
    let message = format!("{error:#}");
    Response::Error(ProtocolError::new(
        classify_protocol_error(&error, &message),
        message,
    ))
}

/// Execute the long-running, stateless template import after production
/// dispatch has released `JailerdCore`'s lifecycle mutex.
pub fn prepare_image_v2_response(
    config: &JailerdConfig,
    request: PrepareImageV2Request,
) -> Response {
    if let Err(error) = request.validate() {
        return Response::Error(ProtocolError::new("invalid_request", error.to_string()));
    }
    if let Err(error) = probe_fast_template_store(config) {
        return Response::Error(ProtocolError::new(
            "host_not_ready",
            format!("fast image template store is unavailable: {error:#}"),
        ));
    }
    let host_template = match read_optional_host_template_metadata(config) {
        Ok(Some(metadata)) => metadata,
        Ok(None) => {
            return Response::Error(ProtocolError::new(
                "host_not_ready",
                "root-owned host runtime template is unavailable",
            ));
        }
        Err(error) => {
            return Response::Error(ProtocolError::new(
                "host_not_ready",
                format!("host runtime template metadata is unavailable: {error:#}"),
            ));
        }
    };
    if let Err(error) = validate_host_template(config, &host_template) {
        return Response::Error(ProtocolError::new(
            "host_not_ready",
            format!("host runtime template validation failed: {error:#}"),
        ));
    }
    match prepare_image_template(config, &request) {
        Ok(result) => Response::PrepareImageV2(result),
        Err(error) => Response::Error(ProtocolError::new(
            "image_prepare_failed",
            format!("{error:#}"),
        )),
    }
}

fn validate_protocol_request(request: &Request) -> Result<()> {
    match request {
        Request::PrepareImageV2(request) => request.validate().map_err(Into::into),
        Request::EnsureRunNetwork(request) | Request::RepairRunNetwork(request) => {
            request.validate().map_err(Into::into)
        }
        Request::LaunchVmV2(request) => request.validate().map(|_| ()).map_err(Into::into),
        Request::FinalizeVmBoot(_) => Ok(()),
        Request::InspectVm(request) | Request::StopVm(request) | Request::DestroyVm(request) => {
            request.validate().map_err(Into::into)
        }
        Request::Capabilities | Request::DestroyRunNetwork(_) => Ok(()),
    }
}

fn classify_protocol_error(error: &anyhow::Error, message: &str) -> &'static str {
    if error.downcast_ref::<BootCapacityPendingError>().is_some() {
        "boot_capacity_pending"
    } else if message.contains("unknown jail generation") {
        "not_found"
    } else if message.contains("readiness attestation") {
        "host_not_ready"
    } else if message.contains("still has VM generations")
        || message.contains("refusing to destroy populated")
    {
        "resource_busy"
    } else if message.contains("already exists with a different")
        || message.contains("already allocated")
    {
        "conflict"
    } else if message.contains("allocation range is exhausted") {
        "identity_exhausted"
    } else {
        "host_operation_failed"
    }
}

pub fn host_cpu_capacity_millis() -> Result<u64> {
    let cpus = std::thread::available_parallelism().context("detect host CPU count")?;
    u64::try_from(cpus.get())
        .ok()
        .and_then(|value| value.checked_mul(1_000))
        .context("host CPU capacity overflow")
}

mod recovery;
use recovery::*;
const IMAGE_TEMPLATE_METADATA_VERSION: u16 = 2;
const HOST_TEMPLATE_METADATA_VERSION: u16 = 2;
const HOST_TEMPLATE_POINTER: &str = "host-v2-current.json";
const HOST_TEMPLATE_DIRECTORY: &str = "host-v2";
const BLANK_RECORDING_BYTES: u64 = 256 * 1024 * 1024;
const BLANK_RECORDING_LABEL: [u8; 11] = *b"INTARREC   ";
const BLANK_RECORDING_DISPLAY_LABEL: &[u8] = b"INTARREC";
const BLANK_RECORDING_VOLUME_ID: u32 = 0x494e_5441;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct ImageTemplateArtifactV2 {
    sha256: Sha256Digest,
    bytes: u64,
    device: u64,
    inode: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct ImageTemplateMetadataV2 {
    schema_version: u16,
    image_sha256: Sha256Digest,
    virtual_size_bytes: u64,
    root_disk: ImageTemplateArtifactV2,
    kernel: ImageTemplateArtifactV2,
    initrd: Option<ImageTemplateArtifactV2>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct SourceFileIdentityV2 {
    device: u64,
    inode: u64,
    bytes: u64,
    modified_seconds: i64,
    modified_nanoseconds: i64,
    changed_seconds: i64,
    changed_nanoseconds: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct HostTemplateArtifactV2 {
    sha256: Sha256Digest,
    identity: SourceFileIdentityV2,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct HostTemplateMetadataV2 {
    schema_version: u16,
    bundle_sha256: Sha256Digest,
    cloud_hypervisor_source: SourceFileIdentityV2,
    jailer_source: SourceFileIdentityV2,
    cloud_hypervisor: HostTemplateArtifactV2,
    jailer: HostTemplateArtifactV2,
    blank_recording: HostTemplateArtifactV2,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct HostTemplateBundleMetadataV2 {
    schema_version: u16,
    bundle_sha256: Sha256Digest,
    cloud_hypervisor: HostTemplateArtifactV2,
    jailer: HostTemplateArtifactV2,
    blank_recording: HostTemplateArtifactV2,
}

impl From<&HostTemplateMetadataV2> for HostTemplateBundleMetadataV2 {
    fn from(metadata: &HostTemplateMetadataV2) -> Self {
        Self {
            schema_version: metadata.schema_version,
            bundle_sha256: metadata.bundle_sha256.clone(),
            cloud_hypervisor: metadata.cloud_hypervisor.clone(),
            jailer: metadata.jailer.clone(),
            blank_recording: metadata.blank_recording.clone(),
        }
    }
}

mod host_templates;
use host_templates::*;
mod image_templates;
use image_templates::*;
mod staging;
use staging::*;
mod lifecycle_fs;
use lifecycle_fs::*;
mod permissions;
use permissions::*;
#[cfg(test)]
mod tests;
