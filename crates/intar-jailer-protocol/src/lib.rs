#![forbid(unsafe_code)]

//! Versioned local control protocol between `intar-agent` and `intar-jailerd`.
//!
//! The transport is an AF_UNIX `SOCK_SEQPACKET` socket. Every JSON envelope is
//! one packet and is bounded by [`MAX_FRAME_BYTES`]. The server authenticates
//! each connection with `SO_PEERCRED`; credentials are never part of the JSON.

use std::fmt;
use std::os::fd::OwnedFd;
use std::os::unix::ffi::OsStrExt as _;
use std::path::{Path, PathBuf};

use rustix::net::{
    AddressFamily, RecvFlags, SendFlags, SocketAddrUnix, SocketFlags, SocketType, connect, recv,
    send, socket_with,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use thiserror::Error;
use tokio::io::unix::AsyncFd;

/// Current on-wire protocol version.
pub const PROTOCOL_VERSION: u16 = 2;
/// Maximum request or response packet, including its JSON envelope.
pub const MAX_FRAME_BYTES: usize = 64 * 1024;
/// Reserved source-root selector for artifacts in jailerd's root-owned image
/// template store. It is never an index into `allowed_source_roots`.
pub const PREPARED_IMAGE_SOURCE_ROOT: u16 = u16::MAX;
/// Fixed cgroup-v2 CPU period used by Intar VM units.
pub const CPU_PERIOD_MICROS: u64 = 100_000;
/// Root-owned default aggregate VMM quota while a VM boots.
pub const DEFAULT_BOOT_CPU_MILLIS: u32 = 2_000;
/// Root-owned maximum duration of a boot CPU lease.
pub const DEFAULT_BOOT_CPU_LEASE_MS: u64 = 45_000;
/// Root-owned default pool reserved for per-run guest networks.
pub const DEFAULT_GUEST_NETWORK_POOL: &str = "10.77.0.0/16";
/// Prefix allocated to each run by the unprivileged agent.
pub const RUN_GUEST_NETWORK_PREFIX: u8 = 28;
/// Default root-owned SSH DNAT allocation range.
pub const DEFAULT_SSH_PUBLIC_PORT_START: u16 = 22_000;
pub const DEFAULT_SSH_PUBLIC_PORT_END: u16 = 22_999;
/// Jailerd never accepts a privileged or Linux ephemeral SSH DNAT port.
pub const MIN_SSH_PUBLIC_PORT: u16 = 1_024;
pub const MAX_SSH_PUBLIC_PORT: u16 = 32_767;
/// Pinned Cloud Hypervisor release.
pub const CLOUD_HYPERVISOR_VERSION: &str = "v53.0";
/// SHA-256 of the upstream `cloud-hypervisor-static` v53.0 release asset.
pub const CLOUD_HYPERVISOR_SHA256: &str =
    "448af3d4e59b22c2987f7df94c213ad40fb53a10d437e42b5ee6c4fce7c29ecc";

/// Identifier accepted at the privileged boundary.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct ValidatedId(String);

impl ValidatedId {
    /// Validate an identifier. IDs are deliberately safe as path and unit-name components.
    pub fn parse(value: impl Into<String>) -> Result<Self, ValidationError> {
        let value = value.into();
        if value.is_empty() || value.len() > 64 {
            return Err(ValidationError::InvalidId(value));
        }
        if !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(ValidationError::InvalidId(value));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ValidatedId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for ValidatedId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(value).map_err(serde::de::Error::custom)
    }
}

/// Lowercase SHA-256 digest.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct Sha256Digest(String);

impl Sha256Digest {
    pub fn parse(value: impl Into<String>) -> Result<Self, ValidationError> {
        let value = value.into();
        if value.len() != 64
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        {
            return Err(ValidationError::InvalidSha256);
        }
        Ok(Self(value))
    }

    pub fn for_bytes(bytes: &[u8]) -> Self {
        let digest = Sha256::digest(bytes);
        let mut encoded = String::with_capacity(64);
        for byte in digest {
            use std::fmt::Write as _;
            let _ = write!(encoded, "{byte:02x}");
        }
        Self(encoded)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for Sha256Digest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(value).map_err(serde::de::Error::custom)
    }
}

/// A hard CPU quota expressed in millicores and cgroup-v2 units.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CpuQuota {
    pub cpu_millis: u32,
    pub quota_micros: u64,
    pub period_micros: u64,
}

impl CpuQuota {
    pub fn from_millis(cpu_millis: u32) -> Result<Self, ValidationError> {
        if cpu_millis == 0 {
            return Err(ValidationError::ZeroCpu);
        }
        let quota_micros = u64::from(cpu_millis)
            .checked_mul(CPU_PERIOD_MICROS)
            .and_then(|value| value.checked_div(1_000))
            .ok_or(ValidationError::CpuOverflow)?;
        Ok(Self {
            cpu_millis,
            quota_micros,
            period_micros: CPU_PERIOD_MICROS,
        })
    }

    pub fn cpu_max(&self) -> String {
        format!("{} {}", self.quota_micros, self.period_micros)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactAccess {
    ReadOnly,
    ReadWrite,
}

/// Typed source accepted for staging. The daemon must resolve `path` beneath
/// one of its configured trusted source roots before opening it.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactSource {
    /// Index into `JailerCapabilities::allowed_source_roots`.
    pub source_root: u16,
    /// Relative path below the selected trusted root. Absolute paths, `..`,
    /// platform prefixes, and empty paths are rejected during deserialization
    /// and again at the privileged boundary.
    pub relative_path: PathBuf,
    pub sha256: Option<Sha256Digest>,
    pub access: ArtifactAccess,
}

impl ArtifactSource {
    pub fn validate(&self) -> Result<(), ValidationError> {
        let mut saw_component = false;
        for component in self.relative_path.components() {
            match component {
                std::path::Component::Normal(_) => saw_component = true,
                _ => return Err(ValidationError::InvalidRelativeArtifactPath),
            }
        }
        if !saw_component {
            return Err(ValidationError::InvalidRelativeArtifactPath);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SourceArtifacts {
    pub kernel: ArtifactSource,
    pub initrd: Option<ArtifactSource>,
    pub root_disk: ArtifactSource,
    pub runtime_disk: ArtifactSource,
    pub recording_disk: ArtifactSource,
}

/// Import a verified agent-cache boot bundle into jailerd's root-owned,
/// content-addressed template store.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PrepareImageV2Request {
    /// Registry image identity. The raw disk has its own digest because the
    /// registry identity covers the compressed image payload.
    pub image_sha256: Sha256Digest,
    pub virtual_size_bytes: u64,
    pub root_disk: ArtifactSource,
    pub kernel: ArtifactSource,
    pub initrd: Option<ArtifactSource>,
}

impl PrepareImageV2Request {
    pub fn validate(&self) -> Result<(), ValidationError> {
        if self.virtual_size_bytes == 0 {
            return Err(ValidationError::ZeroImageSize);
        }
        for source in [
            Some(&self.root_disk),
            Some(&self.kernel),
            self.initrd.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            source.validate()?;
            if source.source_root == PREPARED_IMAGE_SOURCE_ROOT {
                return Err(ValidationError::InvalidTemplateSource);
            }
            if source.access != ArtifactAccess::ReadOnly {
                return Err(ValidationError::InvalidTemplateArtifactAccess);
            }
            if source.sha256.is_none() {
                return Err(ValidationError::MissingTemplateArtifactHash);
            }
        }
        Ok(())
    }
}

/// Root-owned sources returned by `PrepareImageV2`. These descriptors are
/// accepted only through `LaunchVmV2Request`; jailerd resolves the reserved
/// source root without exposing its filesystem path to the agent.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PreparedImageV2Result {
    pub image_sha256: Sha256Digest,
    pub virtual_size_bytes: u64,
    pub root_disk: ArtifactSource,
    pub kernel: ArtifactSource,
    pub initrd: Option<ArtifactSource>,
    pub fast_template_store: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EnsureRunNetworkRequest {
    pub run_id: ValidatedId,
    pub guest_cidr: String,
    pub gateway: String,
}

impl EnsureRunNetworkRequest {
    pub fn validate(&self) -> Result<(), ValidationError> {
        let (network, prefix) = parse_cidr(&self.guest_cidr)?;
        let gateway: std::net::Ipv4Addr = self
            .gateway
            .parse()
            .map_err(|_| ValidationError::InvalidGateway)?;
        let std::net::IpAddr::V4(network) = network else {
            return Err(ValidationError::InvalidGateway);
        };
        if prefix > 30 {
            return Err(ValidationError::InvalidGateway);
        }
        let mask = if prefix == 0 {
            0
        } else {
            u32::MAX << (32 - u32::from(prefix))
        };
        let network = u32::from(network);
        let gateway = u32::from(gateway);
        let broadcast = network | !mask;
        if network & !mask != 0
            || network & mask != gateway & mask
            || gateway == network
            || gateway == broadcast
        {
            return Err(ValidationError::InvalidGateway);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VmLaunchRequest {
    pub run_id: ValidatedId,
    pub vm_id: ValidatedId,
    pub cpu_millis: u32,
    pub vcpu_count: u16,
    pub memory_mib: u32,
    /// Exact size of the mutable generation root disk. For V2 launches this
    /// may exceed the immutable prepared image size, but it may never shrink
    /// the prepared filesystem image.
    pub root_disk_size_bytes: u64,
    pub tap_name: String,
    pub mac_address: String,
    pub guest_ip_cidr: String,
    pub ssh_public_port: Option<u16>,
    pub vsock_cid: u32,
    pub artifacts: SourceArtifacts,
}

mod request_validation;
/// Capability-gated template-backed launch. The image identity and size bind
/// the prepared boot descriptors to one root-owned template generation; the
/// mutable/runtime artifacts remain in the regular launch request.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LaunchVmV2Request {
    pub image_sha256: Sha256Digest,
    pub virtual_size_bytes: u64,
    pub launch: VmLaunchRequest,
}

impl LaunchVmV2Request {
    pub fn validate(&self) -> Result<CpuQuota, ValidationError> {
        if self.virtual_size_bytes == 0 {
            return Err(ValidationError::ZeroImageSize);
        }
        if self.launch.root_disk_size_bytes < self.virtual_size_bytes {
            return Err(ValidationError::RootDiskSmallerThanTemplate);
        }
        let quota = self.launch.validate_inner(true)?;
        for (source, file_name, expected_access) in [
            (
                &self.launch.artifacts.root_disk,
                "root.raw",
                ArtifactAccess::ReadWrite,
            ),
            (
                &self.launch.artifacts.kernel,
                "kernel",
                ArtifactAccess::ReadOnly,
            ),
        ] {
            validate_prepared_launch_artifact(
                source,
                &self.image_sha256,
                file_name,
                expected_access,
            )?;
        }
        if let Some(initrd) = &self.launch.artifacts.initrd {
            validate_prepared_launch_artifact(
                initrd,
                &self.image_sha256,
                "initrd",
                ArtifactAccess::ReadOnly,
            )?;
        }
        Ok(quota)
    }
}

fn validate_prepared_launch_artifact(
    source: &ArtifactSource,
    image_sha256: &Sha256Digest,
    file_name: &str,
    expected_access: ArtifactAccess,
) -> Result<(), ValidationError> {
    if source.source_root != PREPARED_IMAGE_SOURCE_ROOT
        || source.relative_path != PathBuf::from(image_sha256.as_str()).join(file_name)
        || source.sha256.is_none()
        || source.access != expected_access
    {
        return Err(ValidationError::InvalidPreparedLaunchArtifact);
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VmIdentityRequest {
    pub generation: Option<ValidatedId>,
    pub run_id: Option<ValidatedId>,
    pub vm_id: Option<ValidatedId>,
}

/// A generation-fenced request to complete the privileged portion of VM boot.
///
/// The unprivileged caller cannot select either quota. Jailerd derives both
/// from its root-owned configuration and the persisted launch request.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FinalizeVmBootRequest {
    pub generation: ValidatedId,
}

impl VmIdentityRequest {
    pub fn by_generation(generation: ValidatedId) -> Self {
        Self {
            generation: Some(generation),
            run_id: None,
            vm_id: None,
        }
    }

    pub fn by_logical_id(run_id: ValidatedId, vm_id: ValidatedId) -> Self {
        Self {
            generation: None,
            run_id: Some(run_id),
            vm_id: Some(vm_id),
        }
    }

    pub fn validate(&self) -> Result<(), ValidationError> {
        match (&self.generation, &self.run_id, &self.vm_id) {
            (Some(_), None, None) | (None, Some(_), Some(_)) => Ok(()),
            _ => Err(ValidationError::InvalidVmSelector),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DestroyRunNetworkRequest {
    pub run_id: ValidatedId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    deny_unknown_fields,
    tag = "operation",
    content = "parameters",
    rename_all = "snake_case"
)]
pub enum Request {
    Capabilities,
    PrepareImageV2(Box<PrepareImageV2Request>),
    EnsureRunNetwork(EnsureRunNetworkRequest),
    RepairRunNetwork(EnsureRunNetworkRequest),
    LaunchVmV2(Box<LaunchVmV2Request>),
    FinalizeVmBoot(FinalizeVmBootRequest),
    InspectVm(VmIdentityRequest),
    StopVm(VmIdentityRequest),
    DestroyVm(VmIdentityRequest),
    DestroyRunNetwork(DestroyRunNetworkRequest),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RequestEnvelope {
    pub version: u16,
    pub request_id: u64,
    pub request: Request,
}

impl RequestEnvelope {
    pub fn new(request_id: u64, request: Request) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            request_id,
            request,
        }
    }

    pub fn encode(&self) -> Result<Vec<u8>, FrameError> {
        encode_frame(self)
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, FrameError> {
        decode_frame(bytes)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct JailerCapabilities {
    pub protocol_version: u16,
    pub cloud_hypervisor_version: String,
    pub cloud_hypervisor_sha256: String,
    pub total_cpu_millis: u64,
    pub reserved_cpu_millis: u64,
    pub schedulable_cpu_millis: u64,
    pub committed_cpu_millis: u64,
    /// Breaking v2 launch and readiness contract. These attestations are
    /// required on the v2 wire; an old daemon cannot decode as performance
    /// ready by omission.
    pub supports_jailer_v2: bool,
    pub supports_template_backed_launch: bool,
    pub fast_template_store: bool,
    pub supports_hard_cpu_quota: bool,
    pub supports_boot_cpu_lease: bool,
    pub boot_cpu_millis: u32,
    pub boot_cpu_lease_ms: u64,
    pub supports_landlock: bool,
    pub supports_cgroup_v2: bool,
    pub uid_gid_start: u32,
    pub uid_gid_end: u32,
    pub uid_gid_range_collision_free: bool,
    pub config_trusted: bool,
    pub source_roots_trusted: bool,
    pub jailer_binary_trusted: bool,
    pub runtime_hash_verified: bool,
    pub runtime_statically_linked: bool,
    pub systemd_version: Option<String>,
    pub supports_systemd_transient_units: bool,
    pub seccomp_supported: bool,
    pub landlock_abi: Option<u32>,
    pub privileged_self_test_passed: bool,
    pub kvm_accounting_proven: bool,
    pub allow_uid_gid_collisions: bool,
    pub allowed_source_roots: Vec<PathBuf>,
    pub posix_acl_supported: bool,
    pub guest_network_pool: String,
    pub run_guest_network_prefix: u8,
    pub ssh_public_port_start: u16,
    pub ssh_public_port_end: u16,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VmCpuPhase {
    BootBurst,
    #[default]
    Steady,
}

/// Live cgroup readback produced only by the privileged daemon.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CpuQuotaAttestation {
    pub quota: CpuQuota,
    pub cpu_max: String,
    pub cpu_max_burst: u64,
    pub verified_at_unix_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VmCpuRuntimeState {
    pub phase: VmCpuPhase,
    pub steady_quota: CpuQuota,
    pub effective_quota: CpuQuota,
    pub boot_deadline_unix_ms: Option<u64>,
    pub attestation: Option<CpuQuotaAttestation>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct JailPathMap {
    pub host_jail_root: PathBuf,
    pub host_api_socket: PathBuf,
    pub host_vsock_socket: PathBuf,
    pub host_kernel: PathBuf,
    pub host_initrd: Option<PathBuf>,
    pub host_root_disk: PathBuf,
    pub host_runtime_disk: PathBuf,
    pub host_recording_disk: PathBuf,
    pub jailed_api_socket: PathBuf,
    pub jailed_vsock_socket: PathBuf,
    pub jailed_kernel: PathBuf,
    pub jailed_initrd: Option<PathBuf>,
    pub jailed_root_disk: PathBuf,
    pub jailed_runtime_disk: PathBuf,
    pub jailed_recording_disk: PathBuf,
    pub host_serial_log: PathBuf,
    pub host_console_log: PathBuf,
    pub host_stderr_log: PathBuf,
    pub jailed_serial_log: PathBuf,
    pub jailed_console_log: PathBuf,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VmLaunchResult {
    pub generation: ValidatedId,
    pub unit_name: String,
    pub pid: Option<u32>,
    pub cgroup_path: Option<PathBuf>,
    pub uid: u32,
    pub gid: u32,
    pub netns_name: String,
    pub netns_inode: u64,
    pub host_boot_id: Option<String>,
    pub pid_start_time_ticks: Option<u64>,
    pub jail_root_inode: Option<u64>,
    pub cloud_hypervisor_sha256: String,
    pub cpu_runtime: VmCpuRuntimeState,
    pub paths: JailPathMap,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SandboxHealth {
    Preparing,
    Healthy,
    Stopping,
    Quarantined,
    Exited,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CpuStat {
    pub usage_usec: u64,
    pub user_usec: u64,
    pub system_usec: u64,
    pub nr_periods: u64,
    pub nr_throttled: u64,
    pub throttled_usec: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VmInspection {
    pub generation: ValidatedId,
    pub unit_name: String,
    pub pid: Option<u32>,
    pub cgroup_path: Option<PathBuf>,
    pub uid: u32,
    pub gid: u32,
    pub netns_name: String,
    pub netns_inode: u64,
    pub host_boot_id: Option<String>,
    pub pid_start_time_ticks: Option<u64>,
    pub jail_root_inode: Option<u64>,
    pub cloud_hypervisor_sha256: String,
    pub cpu_quota: CpuQuota,
    pub cpu_runtime: VmCpuRuntimeState,
    pub vcpu_count: u16,
    pub health: SandboxHealth,
    pub cpu_stat: Option<CpuStat>,
    pub seccomp_enabled: bool,
    pub landlock_enabled: bool,
    pub no_new_privs: bool,
    pub capabilities_empty: bool,
    pub paths: JailPathMap,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FinalizeVmBootResult {
    pub generation: ValidatedId,
    pub changed: bool,
    pub ssh_forward_active: bool,
    pub cpu_runtime: VmCpuRuntimeState,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RunNetworkResult {
    pub run_id: ValidatedId,
    pub namespace_name: String,
    pub namespace_inode: u64,
    pub bridge_name: String,
    pub host_veth_name: String,
    pub namespace_veth_name: String,
    pub host_transit_cidr: String,
    pub namespace_transit_cidr: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OperationResult {
    pub changed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    deny_unknown_fields,
    tag = "result",
    content = "value",
    rename_all = "snake_case"
)]
pub enum Response {
    Capabilities(JailerCapabilities),
    PrepareImageV2(PreparedImageV2Result),
    EnsureRunNetwork(RunNetworkResult),
    RepairRunNetwork(RunNetworkResult),
    LaunchVmV2(VmLaunchResult),
    FinalizeVmBoot(FinalizeVmBootResult),
    InspectVm(VmInspection),
    StopVm(OperationResult),
    DestroyVm(OperationResult),
    DestroyRunNetwork(OperationResult),
    Error(ProtocolError),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ResponseEnvelope {
    pub version: u16,
    pub request_id: u64,
    pub response: Response,
}

impl ResponseEnvelope {
    pub fn new(request_id: u64, response: Response) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            request_id,
            response,
        }
    }

    pub fn encode(&self) -> Result<Vec<u8>, FrameError> {
        encode_frame(self)
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, FrameError> {
        decode_frame(bytes)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProtocolError {
    pub code: String,
    pub message: String,
}

impl ProtocolError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

/// Root-owned jailer configuration.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct JailerdConfig {
    pub jail_root: PathBuf,
    pub cloud_hypervisor_binary: PathBuf,
    pub cloud_hypervisor_sha256: Sha256Digest,
    pub jailer_binary: PathBuf,
    pub socket_path: PathBuf,
    pub agent_uid: u32,
    pub agent_gid: u32,
    pub allow_uid_gid_collisions: bool,
    pub cpu_reserved_millis: u64,
    /// Aggregate VMM-process quota used only during the bounded boot phase.
    pub boot_cpu_millis: u32,
    /// Maximum boot phase duration before jailerd seals the VM to steady CPU.
    pub boot_cpu_lease_ms: u64,
    pub vmm_file_size_limit_bytes: Option<u64>,
    pub uid_gid_start: u32,
    pub uid_gid_end: u32,
    pub allowed_source_roots: Vec<PathBuf>,
    pub netns_root: PathBuf,
    /// Root-owned address pool from which the agent may request per-run /28s.
    pub guest_network_pool: String,
    /// Root-owned range from which the agent may request public SSH DNAT ports.
    pub ssh_public_port_start: u16,
    pub ssh_public_port_end: u16,
}

impl Default for JailerdConfig {
    fn default() -> Self {
        Self {
            jail_root: PathBuf::from("/var/lib/intar/jails"),
            cloud_hypervisor_binary: PathBuf::from("/usr/lib/intar/cloud-hypervisor-v53.0"),
            cloud_hypervisor_sha256: Sha256Digest(CLOUD_HYPERVISOR_SHA256.to_owned()),
            jailer_binary: PathBuf::from("/usr/lib/intar/intar-jailer"),
            socket_path: PathBuf::from("/run/intar-jailerd/control.sock"),
            agent_uid: 0,
            agent_gid: 0,
            allow_uid_gid_collisions: false,
            cpu_reserved_millis: 1_000,
            boot_cpu_millis: DEFAULT_BOOT_CPU_MILLIS,
            boot_cpu_lease_ms: DEFAULT_BOOT_CPU_LEASE_MS,
            vmm_file_size_limit_bytes: None,
            uid_gid_start: 200_000,
            uid_gid_end: 265_535,
            allowed_source_roots: vec![PathBuf::from("/var/cache/intar-agent")],
            netns_root: PathBuf::from("/run/netns"),
            guest_network_pool: DEFAULT_GUEST_NETWORK_POOL.to_owned(),
            ssh_public_port_start: DEFAULT_SSH_PUBLIC_PORT_START,
            ssh_public_port_end: DEFAULT_SSH_PUBLIC_PORT_END,
        }
    }
}

mod config_impl;
/// Internal root-only handoff consumed by `intar-jailer`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct JailSpecV1 {
    pub version: u16,
    pub generation: ValidatedId,
    pub uid: u32,
    pub gid: u32,
    pub jail_root: PathBuf,
    pub netns_path: PathBuf,
    pub netns_inode: u64,
    pub nofile_limit: u64,
    pub file_size_limit: Option<u64>,
}

impl JailSpecV1 {
    pub fn validate(&self) -> Result<(), ValidationError> {
        if self.version != PROTOCOL_VERSION {
            return Err(ValidationError::UnsupportedVersion(self.version));
        }
        if self.uid == 0 || self.gid == 0 {
            return Err(ValidationError::RootVmIdentity);
        }
        if !self.jail_root.is_absolute() || !self.netns_path.is_absolute() {
            return Err(ValidationError::PathNotAbsolute(
                if !self.jail_root.is_absolute() {
                    self.jail_root.clone()
                } else {
                    self.netns_path.clone()
                },
            ));
        }
        if !is_normal_absolute_path(&self.jail_root) || !is_normal_absolute_path(&self.netns_path) {
            return Err(ValidationError::UnsafePrivilegedPath(
                if !is_normal_absolute_path(&self.jail_root) {
                    self.jail_root.clone()
                } else {
                    self.netns_path.clone()
                },
            ));
        }
        if self.netns_inode == 0 {
            return Err(ValidationError::InvalidNetworkNamespaceInode);
        }
        if self.nofile_limit < 64 {
            return Err(ValidationError::InvalidNofileLimit);
        }
        if self.file_size_limit == Some(0) {
            return Err(ValidationError::InvalidFileSizeLimit);
        }
        Ok(())
    }
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum ValidationError {
    #[error("invalid privileged-boundary identifier: {0}")]
    InvalidId(String),
    #[error("invalid lowercase SHA-256 digest")]
    InvalidSha256,
    #[error("CPU entitlement must be positive")]
    ZeroCpu,
    #[error("CPU quota arithmetic overflow")]
    CpuOverflow,
    #[error("vCPU count must be positive")]
    ZeroVcpus,
    #[error("CPU entitlement exceeds the selected vCPU topology")]
    QuotaExceedsTopology,
    #[error("memory must be positive")]
    ZeroMemory,
    #[error("generation root disk size must be positive")]
    ZeroRootDiskSize,
    #[error("generation root disk cannot be smaller than its prepared image template")]
    RootDiskSmallerThanTemplate,
    #[error("invalid TAP interface name")]
    InvalidTapName,
    #[error("invalid MAC address")]
    InvalidMacAddress,
    #[error("invalid guest IP CIDR")]
    InvalidGuestCidr,
    #[error("invalid run-network gateway")]
    InvalidGateway,
    #[error("SSH public port must be nonzero")]
    InvalidSshPort,
    #[error("SSH public port range must be within 1024..=32767 and ordered")]
    InvalidSshPortRange,
    #[error("SSH public port is outside the root-owned configured range")]
    SshPortOutsideConfiguredRange,
    #[error("guest network pool must be a canonical subnet within 10.77.0.0/16")]
    InvalidGuestNetworkPool,
    #[error("run network must be a canonical /28 inside the root-owned guest network pool")]
    RunNetworkOutsideConfiguredPool,
    #[error("vsock CID must be at least 3")]
    InvalidVsockCid,
    #[error(
        "kernel, initrd, and runtime disk must be read-only; root and recording disks must be read-write"
    )]
    InvalidArtifactAccess,
    #[error("artifact path must be a non-empty relative path without traversal")]
    InvalidRelativeArtifactPath,
    #[error("kernel and initrd artifacts require SHA-256 digests")]
    MissingBootArtifactHash,
    #[error("prepared image virtual size must be positive")]
    ZeroImageSize,
    #[error("image preparation sources cannot reference the root-owned template store")]
    InvalidTemplateSource,
    #[error("image preparation artifacts must be read-only")]
    InvalidTemplateArtifactAccess,
    #[error("image preparation artifacts require SHA-256 digests")]
    MissingTemplateArtifactHash,
    #[error("root-owned prepared boot artifacts require launch_vm_v2")]
    TemplateLaunchRequiresV2,
    #[error("runtime and recording artifacts cannot reference the root-owned template store")]
    InvalidTemplateRuntimeSource,
    #[error("launch_vm_v2 boot descriptors must exactly reference one prepared image template")]
    InvalidPreparedLaunchArtifact,
    #[error("VM selector must contain either a generation or a run/VM logical ID")]
    InvalidVmSelector,
    #[error("path must be absolute: {0}")]
    PathNotAbsolute(PathBuf),
    #[error("privileged path must be absolute and contain no traversal components: {0}")]
    UnsafePrivilegedPath(PathBuf),
    #[error("invalid UID/GID allocation range")]
    InvalidIdentityRange,
    #[error("configured agent UID/GID must be non-root")]
    RootAgentIdentity,
    #[error("Cloud Hypervisor runtime hash must match the pinned v53.0 release")]
    UnpinnedRuntime,
    #[error("allowed source roots must be non-empty absolute paths")]
    InvalidSourceRoots,
    #[error("unsupported protocol version {0}")]
    UnsupportedVersion(u16),
    #[error("VM identity cannot be root")]
    RootVmIdentity,
    #[error("run network namespace inode must be nonzero")]
    InvalidNetworkNamespaceInode,
    #[error("RLIMIT_NOFILE must be at least 64")]
    InvalidNofileLimit,
    #[error("configured RLIMIT_FSIZE must be positive")]
    InvalidFileSizeLimit,
    #[error("boot CPU lease duration must be within 1..=45000 milliseconds")]
    InvalidBootCpuLease,
}

#[derive(Debug, Error)]
pub enum FrameError {
    #[error("empty protocol frame")]
    Empty,
    #[error("protocol frame exceeds {MAX_FRAME_BYTES} bytes")]
    TooLarge,
    #[error("invalid protocol JSON: {0}")]
    Json(#[from] serde_json::Error),
}

mod validation;
use validation::*;
/// Async, serialized client for the local `SOCK_SEQPACKET` protocol.
pub struct AsyncSeqpacketClient {
    io: AsyncFd<OwnedFd>,
    next_request_id: u64,
}

mod client_impl;
#[derive(Debug, Error)]
pub enum ClientError {
    #[error("protocol I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Errno(#[from] rustix::io::Errno),
    #[error(transparent)]
    Frame(#[from] FrameError),
    #[error("SOCK_SEQPACKET send was unexpectedly truncated")]
    TruncatedPacket,
    #[error("server returned protocol version {0}")]
    UnsupportedVersion(u16),
    #[error("response request ID mismatch: expected {expected}, got {actual}")]
    MismatchedRequestId { expected: u64, actual: u64 },
    #[error("jailerd control peer is not root")]
    UnauthorizedPeer,
}

#[cfg(test)]
mod tests;
