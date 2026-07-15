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

impl VmLaunchRequest {
    pub fn validate(&self) -> Result<CpuQuota, ValidationError> {
        self.validate_inner(false)
    }

    fn validate_inner(
        &self,
        allow_prepared_boot_artifacts: bool,
    ) -> Result<CpuQuota, ValidationError> {
        if self.vcpu_count == 0 {
            return Err(ValidationError::ZeroVcpus);
        }
        if u64::from(self.cpu_millis) > u64::from(self.vcpu_count) * 1_000 {
            return Err(ValidationError::QuotaExceedsTopology);
        }
        if self.memory_mib == 0 {
            return Err(ValidationError::ZeroMemory);
        }
        if self.root_disk_size_bytes == 0 {
            return Err(ValidationError::ZeroRootDiskSize);
        }
        validate_tap_name(&self.tap_name)?;
        validate_mac(&self.mac_address)?;
        parse_cidr(&self.guest_ip_cidr)?;
        if self.ssh_public_port == Some(0) {
            return Err(ValidationError::InvalidSshPort);
        }
        if self.vsock_cid < 3 {
            return Err(ValidationError::InvalidVsockCid);
        }
        if self.artifacts.kernel.access != ArtifactAccess::ReadOnly
            || self
                .artifacts
                .initrd
                .as_ref()
                .is_some_and(|source| source.access != ArtifactAccess::ReadOnly)
            || self.artifacts.root_disk.access != ArtifactAccess::ReadWrite
            || self.artifacts.runtime_disk.access != ArtifactAccess::ReadOnly
            || self.artifacts.recording_disk.access != ArtifactAccess::ReadWrite
        {
            return Err(ValidationError::InvalidArtifactAccess);
        }
        for source in [
            Some(&self.artifacts.kernel),
            self.artifacts.initrd.as_ref(),
            Some(&self.artifacts.root_disk),
            Some(&self.artifacts.runtime_disk),
            Some(&self.artifacts.recording_disk),
        ]
        .into_iter()
        .flatten()
        {
            source.validate()?;
        }
        let boot_artifacts = [
            Some(&self.artifacts.root_disk),
            Some(&self.artifacts.kernel),
            self.artifacts.initrd.as_ref(),
        ];
        if !allow_prepared_boot_artifacts
            && boot_artifacts
                .into_iter()
                .flatten()
                .any(|source| source.source_root == PREPARED_IMAGE_SOURCE_ROOT)
        {
            return Err(ValidationError::TemplateLaunchRequiresV2);
        }
        if self.artifacts.runtime_disk.source_root == PREPARED_IMAGE_SOURCE_ROOT
            || self.artifacts.recording_disk.source_root == PREPARED_IMAGE_SOURCE_ROOT
        {
            return Err(ValidationError::InvalidTemplateRuntimeSource);
        }
        if self.artifacts.kernel.sha256.is_none()
            || self
                .artifacts
                .initrd
                .as_ref()
                .is_some_and(|source| source.sha256.is_none())
        {
            return Err(ValidationError::MissingBootArtifactHash);
        }
        CpuQuota::from_millis(self.cpu_millis)
    }
}

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

impl JailerdConfig {
    pub fn validate(&self) -> Result<(), ValidationError> {
        for path in [
            &self.jail_root,
            &self.cloud_hypervisor_binary,
            &self.jailer_binary,
            &self.socket_path,
            &self.netns_root,
        ] {
            if !path.is_absolute() {
                return Err(ValidationError::PathNotAbsolute(path.clone()));
            }
            if !is_normal_absolute_path(path) {
                return Err(ValidationError::UnsafePrivilegedPath(path.clone()));
            }
        }
        if self.uid_gid_start < 1_000 || self.uid_gid_start > self.uid_gid_end {
            return Err(ValidationError::InvalidIdentityRange);
        }
        if self.agent_uid == 0 || self.agent_gid == 0 {
            return Err(ValidationError::RootAgentIdentity);
        }
        if self.cloud_hypervisor_sha256.as_str() != CLOUD_HYPERVISOR_SHA256 {
            return Err(ValidationError::UnpinnedRuntime);
        }
        if self.vmm_file_size_limit_bytes == Some(0) {
            return Err(ValidationError::InvalidFileSizeLimit);
        }
        CpuQuota::from_millis(self.boot_cpu_millis)?;
        if self.boot_cpu_lease_ms == 0 || self.boot_cpu_lease_ms > DEFAULT_BOOT_CPU_LEASE_MS {
            return Err(ValidationError::InvalidBootCpuLease);
        }
        if self.allowed_source_roots.is_empty()
            || self
                .allowed_source_roots
                .iter()
                .any(|path| !is_normal_absolute_path(path))
        {
            return Err(ValidationError::InvalidSourceRoots);
        }
        validate_guest_network_pool(&self.guest_network_pool)?;
        validate_ssh_public_port_range(self.ssh_public_port_start, self.ssh_public_port_end)?;
        Ok(())
    }

    /// Validate a typed run network against root-owned host policy.
    pub fn validate_run_network_request(
        &self,
        request: &EnsureRunNetworkRequest,
    ) -> Result<(), ValidationError> {
        request.validate()?;
        let (pool, pool_prefix) = parse_ipv4_cidr(&self.guest_network_pool)?;
        let (network, prefix) = parse_ipv4_cidr(&request.guest_cidr)?;
        if prefix != RUN_GUEST_NETWORK_PREFIX
            || !ipv4_subnet_contains(pool, pool_prefix, network, prefix)
        {
            return Err(ValidationError::RunNetworkOutsideConfiguredPool);
        }
        let expected_gateway = u32::from(network)
            .checked_add(1)
            .map(std::net::Ipv4Addr::from)
            .ok_or(ValidationError::InvalidGateway)?;
        if request.gateway.parse::<std::net::Ipv4Addr>().ok() != Some(expected_gateway) {
            return Err(ValidationError::InvalidGateway);
        }
        Ok(())
    }

    /// Validate an optional SSH DNAT port against root-owned host policy.
    pub fn validate_ssh_public_port(&self, port: Option<u16>) -> Result<(), ValidationError> {
        if port.is_some_and(|port| {
            port < self.ssh_public_port_start || port > self.ssh_public_port_end
        }) {
            return Err(ValidationError::SshPortOutsideConfiguredRange);
        }
        Ok(())
    }
}

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

fn encode_frame<T: Serialize>(value: &T) -> Result<Vec<u8>, FrameError> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge);
    }
    Ok(bytes)
}

fn decode_frame<T: for<'de> Deserialize<'de>>(bytes: &[u8]) -> Result<T, FrameError> {
    if bytes.is_empty() {
        return Err(FrameError::Empty);
    }
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge);
    }
    Ok(serde_json::from_slice(bytes)?)
}

fn validate_tap_name(value: &str) -> Result<(), ValidationError> {
    if value.is_empty()
        || value.len() > 15
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(ValidationError::InvalidTapName);
    }
    Ok(())
}

fn is_normal_absolute_path(path: &Path) -> bool {
    let bytes = path.as_os_str().as_bytes();
    bytes.first() == Some(&b'/')
        && (bytes.len() == 1
            || bytes[1..]
                .split(|byte| *byte == b'/')
                .all(|component| !component.is_empty() && component != b"." && component != b".."))
}

fn validate_mac(value: &str) -> Result<(), ValidationError> {
    let valid = value.len() == 17
        && value == value.to_ascii_lowercase()
        && value
            .split(':')
            .all(|part| part.len() == 2 && part.bytes().all(|byte| byte.is_ascii_hexdigit()));
    let unicast = value
        .get(..2)
        .and_then(|octet| u8::from_str_radix(octet, 16).ok())
        .is_some_and(|octet| octet & 1 == 0);
    if !valid || !unicast {
        return Err(ValidationError::InvalidMacAddress);
    }
    Ok(())
}

fn parse_cidr(value: &str) -> Result<(std::net::IpAddr, u8), ValidationError> {
    let Some((address, prefix)) = value.rsplit_once('/') else {
        return Err(ValidationError::InvalidGuestCidr);
    };
    let address: std::net::IpAddr = address
        .parse()
        .map_err(|_| ValidationError::InvalidGuestCidr)?;
    let prefix: u8 = prefix
        .parse()
        .map_err(|_| ValidationError::InvalidGuestCidr)?;
    if !address.is_ipv4() || prefix > 32 {
        return Err(ValidationError::InvalidGuestCidr);
    }
    Ok((address, prefix))
}

fn parse_ipv4_cidr(value: &str) -> Result<(std::net::Ipv4Addr, u8), ValidationError> {
    let (address, prefix) = parse_cidr(value)?;
    let std::net::IpAddr::V4(address) = address else {
        return Err(ValidationError::InvalidGuestCidr);
    };
    Ok((address, prefix))
}

fn ipv4_mask(prefix: u8) -> u32 {
    if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - u32::from(prefix))
    }
}

fn ipv4_subnet_contains(
    outer: std::net::Ipv4Addr,
    outer_prefix: u8,
    inner: std::net::Ipv4Addr,
    inner_prefix: u8,
) -> bool {
    inner_prefix >= outer_prefix
        && (u32::from(outer) & ipv4_mask(outer_prefix))
            == (u32::from(inner) & ipv4_mask(outer_prefix))
}

fn validate_guest_network_pool(value: &str) -> Result<(), ValidationError> {
    let (network, prefix) =
        parse_ipv4_cidr(value).map_err(|_| ValidationError::InvalidGuestNetworkPool)?;
    let (intar_network, intar_prefix) = parse_ipv4_cidr(DEFAULT_GUEST_NETWORK_POOL)
        .expect("compiled-in guest network pool is valid");
    if prefix < intar_prefix
        || prefix > RUN_GUEST_NETWORK_PREFIX
        || u32::from(network) & !ipv4_mask(prefix) != 0
        || !ipv4_subnet_contains(intar_network, intar_prefix, network, prefix)
    {
        return Err(ValidationError::InvalidGuestNetworkPool);
    }
    Ok(())
}

fn validate_ssh_public_port_range(start: u16, end: u16) -> Result<(), ValidationError> {
    if start < MIN_SSH_PUBLIC_PORT || end > MAX_SSH_PUBLIC_PORT || end < start {
        return Err(ValidationError::InvalidSshPortRange);
    }
    Ok(())
}

/// Async, serialized client for the local `SOCK_SEQPACKET` protocol.
pub struct AsyncSeqpacketClient {
    io: AsyncFd<OwnedFd>,
    next_request_id: u64,
}

impl AsyncSeqpacketClient {
    pub fn connect(path: &Path) -> Result<Self, ClientError> {
        #[cfg(target_os = "linux")]
        let flags = SocketFlags::CLOEXEC;
        #[cfg(not(target_os = "linux"))]
        let flags = SocketFlags::empty();
        let fd = socket_with(AddressFamily::UNIX, SocketType::SEQPACKET, flags, None)?;
        let address = SocketAddrUnix::new(path)?;
        connect(&fd, &address)?;
        #[cfg(target_os = "linux")]
        if rustix::net::sockopt::socket_peercred(&fd)?.uid != rustix::process::Uid::ROOT {
            return Err(ClientError::UnauthorizedPeer);
        }
        #[cfg(not(target_os = "linux"))]
        rustix::io::fcntl_setfd(&fd, rustix::io::FdFlags::CLOEXEC)?;
        rustix::fs::fcntl_setfl(&fd, rustix::fs::OFlags::NONBLOCK)?;
        Ok(Self {
            io: AsyncFd::new(fd)?,
            next_request_id: 1,
        })
    }

    pub async fn request(&mut self, request: Request) -> Result<Response, ClientError> {
        let request_id = self.next_request_id;
        self.next_request_id = self.next_request_id.wrapping_add(1).max(1);
        let frame = RequestEnvelope::new(request_id, request).encode()?;

        loop {
            let mut ready = self.io.writable().await?;
            match ready.try_io(|fd| {
                send(fd, &frame, SendFlags::empty())
                    .map_err(|error| std::io::Error::from_raw_os_error(error.raw_os_error()))
            }) {
                Ok(Ok(written)) if written == frame.len() => break,
                Ok(Ok(_)) => return Err(ClientError::TruncatedPacket),
                Ok(Err(error)) => return Err(error.into()),
                Err(_) => continue,
            }
        }

        let mut buffer = vec![0_u8; MAX_FRAME_BYTES + 1];
        let length = loop {
            let mut ready = self.io.readable().await?;
            match ready.try_io(|fd| {
                recv(fd, &mut buffer, RecvFlags::empty())
                    .map_err(|error| std::io::Error::from_raw_os_error(error.raw_os_error()))
            }) {
                Ok(Ok((_, length))) => break length,
                Ok(Err(error)) => return Err(error.into()),
                Err(_) => continue,
            }
        };
        if length > MAX_FRAME_BYTES {
            return Err(ClientError::Frame(FrameError::TooLarge));
        }
        let response = ResponseEnvelope::decode(&buffer[..length])?;
        if response.version != PROTOCOL_VERSION {
            return Err(ClientError::UnsupportedVersion(response.version));
        }
        if response.request_id != request_id {
            return Err(ClientError::MismatchedRequestId {
                expected: request_id,
                actual: response.request_id,
            });
        }
        Ok(response.response)
    }
}

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
mod tests {
    use super::*;

    #[test]
    fn quota_for_one_eighth_cpu_is_exact() {
        let quota = CpuQuota::from_millis(125).expect("valid quota");
        assert_eq!(quota.quota_micros, 12_500);
        assert_eq!(quota.cpu_max(), "12500 100000");
    }

    #[test]
    fn boot_cpu_defaults_are_root_owned_and_bounded() {
        let config = JailerdConfig::default();
        assert_eq!(config.boot_cpu_millis, 2_000);
        assert_eq!(config.boot_cpu_lease_ms, 45_000);

        let mut invalid = JailerdConfig {
            agent_uid: 991,
            agent_gid: 991,
            ..config
        };
        invalid.boot_cpu_lease_ms = 0;
        assert_eq!(
            invalid.validate(),
            Err(ValidationError::InvalidBootCpuLease)
        );
        invalid.boot_cpu_lease_ms = 1;
        invalid.boot_cpu_millis = 0;
        assert_eq!(invalid.validate(), Err(ValidationError::ZeroCpu));
        invalid.boot_cpu_millis = 1;
        invalid.boot_cpu_lease_ms = DEFAULT_BOOT_CPU_LEASE_MS + 1;
        assert_eq!(
            invalid.validate(),
            Err(ValidationError::InvalidBootCpuLease)
        );
    }

    #[test]
    fn run_network_repair_is_a_distinct_typed_operation() {
        let run_id = ValidatedId::parse("run").expect("run ID");
        let request = RequestEnvelope::new(
            6,
            Request::RepairRunNetwork(EnsureRunNetworkRequest {
                run_id: run_id.clone(),
                guest_cidr: "10.77.0.0/28".to_owned(),
                gateway: "10.77.0.1".to_owned(),
            }),
        );
        assert_eq!(
            RequestEnvelope::decode(&request.encode().expect("encode")).expect("decode"),
            request
        );

        let response = ResponseEnvelope::new(
            6,
            Response::RepairRunNetwork(RunNetworkResult {
                run_id,
                namespace_name: "intar-ns-run".to_owned(),
                namespace_inode: 17,
                bridge_name: "ibr-run".to_owned(),
                host_veth_name: "ivh-run".to_owned(),
                namespace_veth_name: "ivn-run".to_owned(),
                host_transit_cidr: "198.18.0.1/30".to_owned(),
                namespace_transit_cidr: "198.18.0.2/30".to_owned(),
            }),
        );
        assert_eq!(
            ResponseEnvelope::decode(&response.encode().expect("encode")).expect("decode"),
            response
        );
    }

    #[test]
    fn finalize_boot_is_generation_fenced_and_rejects_extra_authority() {
        let generation = ValidatedId::parse("generation-1").expect("generation");
        let envelope = RequestEnvelope::new(
            7,
            Request::FinalizeVmBoot(FinalizeVmBootRequest {
                generation: generation.clone(),
            }),
        );
        assert_eq!(
            RequestEnvelope::decode(&envelope.encode().expect("encode")).expect("decode"),
            envelope
        );
        let with_quota = br#"{"version":1,"request_id":7,"request":{"operation":"finalize_vm_boot","parameters":{"generation":"generation-1","cpu_millis":4000}}}"#;
        assert!(RequestEnvelope::decode(with_quota).is_err());

        let steady_quota = CpuQuota::from_millis(1_000).expect("steady quota");
        let cpu_runtime = VmCpuRuntimeState {
            phase: VmCpuPhase::Steady,
            steady_quota,
            effective_quota: steady_quota,
            boot_deadline_unix_ms: None,
            attestation: Some(CpuQuotaAttestation {
                quota: steady_quota,
                cpu_max: steady_quota.cpu_max(),
                cpu_max_burst: 0,
                verified_at_unix_ms: 124,
            }),
        };
        let response = ResponseEnvelope::new(
            7,
            Response::FinalizeVmBoot(FinalizeVmBootResult {
                generation: generation.clone(),
                changed: true,
                ssh_forward_active: true,
                cpu_runtime,
            }),
        );
        assert_eq!(
            ResponseEnvelope::decode(&response.encode().expect("encode")).expect("decode"),
            response
        );
    }

    #[test]
    fn prepare_image_v2_is_hash_bound_and_cannot_reimport_templates() {
        let digest = Sha256Digest::parse("a".repeat(64)).expect("digest");
        let source = |path: &str| ArtifactSource {
            source_root: 0,
            relative_path: PathBuf::from(path),
            sha256: Some(digest.clone()),
            access: ArtifactAccess::ReadOnly,
        };
        let request = PrepareImageV2Request {
            image_sha256: digest.clone(),
            virtual_size_bytes: 4 * 1024 * 1024 * 1024,
            root_disk: source("images/root.raw"),
            kernel: source("artifacts/kernel"),
            initrd: Some(source("artifacts/initrd")),
        };
        request.validate().expect("valid prepared image request");
        let envelope = RequestEnvelope::new(9, Request::PrepareImageV2(Box::new(request.clone())));
        assert_eq!(
            RequestEnvelope::decode(&envelope.encode().expect("encode")).expect("decode"),
            envelope
        );

        let mut invalid = request;
        invalid.root_disk.source_root = PREPARED_IMAGE_SOURCE_ROOT;
        assert_eq!(
            invalid.validate(),
            Err(ValidationError::InvalidTemplateSource)
        );
        invalid.root_disk.source_root = 0;
        invalid.root_disk.sha256 = None;
        assert_eq!(
            invalid.validate(),
            Err(ValidationError::MissingTemplateArtifactHash)
        );
    }

    #[test]
    fn launch_vm_v2_is_template_bound_and_v1_rejects_prepared_sources() {
        let image_sha256 = Sha256Digest::parse("b".repeat(64)).expect("image digest");
        let artifact_sha256 = Sha256Digest::parse("c".repeat(64)).expect("artifact digest");
        let prepared = |name: &str, access| ArtifactSource {
            source_root: PREPARED_IMAGE_SOURCE_ROOT,
            relative_path: PathBuf::from(image_sha256.as_str()).join(name),
            sha256: Some(artifact_sha256.clone()),
            access,
        };
        let agent_owned = |name: &str, access| ArtifactSource {
            source_root: 0,
            relative_path: PathBuf::from(name),
            sha256: None,
            access,
        };
        let launch = VmLaunchRequest {
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
                kernel: prepared("kernel", ArtifactAccess::ReadOnly),
                initrd: Some(prepared("initrd", ArtifactAccess::ReadOnly)),
                root_disk: prepared("root.raw", ArtifactAccess::ReadWrite),
                runtime_disk: agent_owned("runtime.raw", ArtifactAccess::ReadOnly),
                recording_disk: agent_owned("recordings.vfat", ArtifactAccess::ReadWrite),
            },
        };
        assert_eq!(
            launch.validate(),
            Err(ValidationError::TemplateLaunchRequiresV2)
        );

        let request = LaunchVmV2Request {
            image_sha256,
            virtual_size_bytes: 4 * 1024 * 1024 * 1024,
            launch,
        };
        request.validate().expect("valid v2 launch");
        let mut undersized = request.clone();
        undersized.launch.root_disk_size_bytes = undersized.virtual_size_bytes - 1;
        assert_eq!(
            undersized.validate(),
            Err(ValidationError::RootDiskSmallerThanTemplate)
        );
        let envelope = RequestEnvelope::new(10, Request::LaunchVmV2(Box::new(request.clone())));
        assert_eq!(
            RequestEnvelope::decode(&envelope.encode().expect("encode")).expect("decode"),
            envelope
        );

        let mut wrong_bundle = request;
        wrong_bundle.launch.artifacts.kernel.relative_path =
            PathBuf::from(wrong_bundle.image_sha256.as_str()).join("other-kernel");
        assert_eq!(
            wrong_bundle.validate(),
            Err(ValidationError::InvalidPreparedLaunchArtifact)
        );
    }

    #[test]
    fn identifiers_cannot_escape_paths_or_units() {
        for invalid in ["", ".", "../vm", "vm/name", "vm.name", "vm name"] {
            assert!(ValidatedId::parse(invalid).is_err(), "accepted {invalid:?}");
        }
        assert_eq!(
            ValidatedId::parse("run_01-vm").expect("valid ID").as_str(),
            "run_01-vm"
        );
    }

    #[test]
    fn unknown_envelope_fields_are_rejected() {
        let json = br#"{"version":1,"request_id":1,"request":{"operation":"capabilities"},"surprise":true}"#;
        assert!(RequestEnvelope::decode(json).is_err());
    }

    #[test]
    fn protocol_v2_rejects_legacy_handshake_authority() {
        assert_eq!(PROTOCOL_VERSION, 2);
        let legacy = RequestEnvelope::decode(
            br#"{"version":1,"request_id":1,"request":{"operation":"capabilities"}}"#,
        )
        .expect("legacy envelope remains syntactically decodable");
        assert_ne!(legacy.version, PROTOCOL_VERSION);
    }

    #[test]
    fn protocol_v2_capabilities_require_every_fast_launch_attestation() {
        let capabilities = JailerCapabilities {
            protocol_version: PROTOCOL_VERSION,
            cloud_hypervisor_version: CLOUD_HYPERVISOR_VERSION.to_owned(),
            cloud_hypervisor_sha256: CLOUD_HYPERVISOR_SHA256.to_owned(),
            total_cpu_millis: 8_000,
            reserved_cpu_millis: 1_000,
            schedulable_cpu_millis: 7_000,
            committed_cpu_millis: 2_000,
            supports_jailer_v2: true,
            supports_template_backed_launch: true,
            fast_template_store: true,
            supports_hard_cpu_quota: true,
            supports_boot_cpu_lease: true,
            boot_cpu_millis: DEFAULT_BOOT_CPU_MILLIS,
            boot_cpu_lease_ms: DEFAULT_BOOT_CPU_LEASE_MS,
            supports_landlock: true,
            supports_cgroup_v2: true,
            uid_gid_start: 200_000,
            uid_gid_end: 265_535,
            uid_gid_range_collision_free: true,
            config_trusted: true,
            source_roots_trusted: true,
            jailer_binary_trusted: true,
            runtime_hash_verified: true,
            runtime_statically_linked: true,
            systemd_version: Some("systemd 252".to_string()),
            supports_systemd_transient_units: true,
            seccomp_supported: true,
            landlock_abi: Some(3),
            privileged_self_test_passed: true,
            kvm_accounting_proven: true,
            allow_uid_gid_collisions: false,
            allowed_source_roots: vec![PathBuf::from("/var/lib/intar/source")],
            posix_acl_supported: true,
            guest_network_pool: DEFAULT_GUEST_NETWORK_POOL.to_string(),
            run_guest_network_prefix: RUN_GUEST_NETWORK_PREFIX,
            ssh_public_port_start: DEFAULT_SSH_PUBLIC_PORT_START,
            ssh_public_port_end: DEFAULT_SSH_PUBLIC_PORT_END,
        };
        let encoded = serde_json::to_value(capabilities).expect("serialize capabilities");
        for required in [
            "supports_jailer_v2",
            "supports_template_backed_launch",
            "fast_template_store",
        ] {
            let mut missing = encoded.clone();
            missing
                .as_object_mut()
                .expect("capability object")
                .remove(required);
            assert!(
                serde_json::from_value::<JailerCapabilities>(missing).is_err(),
                "missing {required} was accepted"
            );
        }
    }

    #[test]
    fn unknown_run_network_fields_are_rejected() {
        for operation in ["ensure_run_network", "repair_run_network"] {
            let json = format!(
                r#"{{"version":1,"request_id":1,"request":{{"operation":"{operation}","parameters":{{"run_id":"run","guest_cidr":"10.77.0.0/28","gateway":"10.77.0.1","host_route":"0.0.0.0/0"}}}}}}"#
            );
            assert!(RequestEnvelope::decode(json.as_bytes()).is_err());
        }
    }

    #[test]
    fn unknown_response_fields_are_rejected() {
        let json = br#"{"version":1,"request_id":1,"response":{"result":"stop_vm","value":{"changed":true},"surprise":true}}"#;
        assert!(ResponseEnvelope::decode(json).is_err());
    }

    #[test]
    fn invalid_ids_cannot_enter_through_deserialization() {
        let json = br#"{"version":1,"request_id":1,"request":{"operation":"destroy_vm","parameters":{"generation":"../escape"}}}"#;
        assert!(RequestEnvelope::decode(json).is_err());
    }

    #[test]
    fn oversized_frames_are_rejected_before_json_parsing() {
        let bytes = vec![b' '; MAX_FRAME_BYTES + 1];
        assert!(matches!(
            RequestEnvelope::decode(&bytes),
            Err(FrameError::TooLarge)
        ));
    }

    #[test]
    fn launch_validation_enforces_aggregate_topology_limit() {
        let request = VmLaunchRequest {
            run_id: ValidatedId::parse("run").expect("run ID"),
            vm_id: ValidatedId::parse("vm").expect("VM ID"),
            cpu_millis: 1_001,
            vcpu_count: 1,
            memory_mib: 512,
            root_disk_size_bytes: 4 * 1024 * 1024 * 1024,
            tap_name: "tap0".to_owned(),
            mac_address: "02:00:00:00:00:01".to_owned(),
            guest_ip_cidr: "10.77.0.2/28".to_owned(),
            ssh_public_port: Some(22000),
            vsock_cid: 3,
            artifacts: SourceArtifacts {
                kernel: source("/trusted/kernel", ArtifactAccess::ReadOnly),
                initrd: None,
                root_disk: source("/trusted/root.raw", ArtifactAccess::ReadWrite),
                runtime_disk: source("/trusted/runtime.raw", ArtifactAccess::ReadOnly),
                recording_disk: source("/trusted/recordings.vfat", ArtifactAccess::ReadWrite),
            },
        };
        assert_eq!(
            request.validate(),
            Err(ValidationError::QuotaExceedsTopology)
        );
    }

    #[test]
    fn artifact_sources_are_root_indexed_and_traversal_free() {
        for invalid in ["", "/absolute/kernel", "../kernel", "boot/../kernel"] {
            let artifact = ArtifactSource {
                source_root: 0,
                relative_path: PathBuf::from(invalid),
                sha256: Some(Sha256Digest::parse("a".repeat(64)).expect("digest")),
                access: ArtifactAccess::ReadOnly,
            };
            assert_eq!(
                artifact.validate(),
                Err(ValidationError::InvalidRelativeArtifactPath),
                "accepted {invalid:?}"
            );
        }
    }

    #[test]
    fn vm_selectors_are_exactly_generation_or_logical_identity() {
        let generation = ValidatedId::parse("generation").expect("generation");
        assert!(
            VmIdentityRequest::by_generation(generation)
                .validate()
                .is_ok()
        );
        assert!(
            VmIdentityRequest::by_logical_id(
                ValidatedId::parse("run").expect("run"),
                ValidatedId::parse("vm").expect("vm"),
            )
            .validate()
            .is_ok()
        );
        assert_eq!(
            VmIdentityRequest {
                generation: None,
                run_id: None,
                vm_id: None,
            }
            .validate(),
            Err(ValidationError::InvalidVmSelector)
        );
    }

    #[test]
    fn jailerd_config_rejects_runtime_hash_overrides() {
        let config = JailerdConfig {
            agent_uid: 991,
            agent_gid: 991,
            cloud_hypervisor_sha256: Sha256Digest::parse("a".repeat(64))
                .expect("syntactically valid digest"),
            ..JailerdConfig::default()
        };
        assert_eq!(config.validate(), Err(ValidationError::UnpinnedRuntime));
    }

    #[test]
    fn root_network_policy_rejects_route_hijacks_and_topology_drift() {
        let config = JailerdConfig {
            agent_uid: 991,
            agent_gid: 991,
            ..JailerdConfig::default()
        };
        let request = |guest_cidr: &str, gateway: &str| EnsureRunNetworkRequest {
            run_id: ValidatedId::parse("run").expect("run ID"),
            guest_cidr: guest_cidr.to_owned(),
            gateway: gateway.to_owned(),
        };

        assert!(
            config
                .validate_run_network_request(&request("10.77.12.0/28", "10.77.12.1"))
                .is_ok()
        );
        for invalid in [
            request("0.0.0.0/0", "0.0.0.1"),
            request("10.76.0.0/28", "10.76.0.1"),
            request("10.77.0.0/24", "10.77.0.1"),
            request("10.77.0.16/28", "10.77.0.18"),
        ] {
            assert!(config.validate_run_network_request(&invalid).is_err());
        }
    }

    #[test]
    fn root_network_policy_can_narrow_pool_and_ssh_port_range() {
        let config = JailerdConfig {
            agent_uid: 991,
            agent_gid: 991,
            guest_network_pool: "10.77.128.0/17".to_owned(),
            ssh_public_port_start: 22_500,
            ssh_public_port_end: 22_599,
            ..JailerdConfig::default()
        };
        config.validate().expect("valid narrowed policy");
        let inside = EnsureRunNetworkRequest {
            run_id: ValidatedId::parse("inside").expect("run ID"),
            guest_cidr: "10.77.128.0/28".to_owned(),
            gateway: "10.77.128.1".to_owned(),
        };
        let outside = EnsureRunNetworkRequest {
            run_id: ValidatedId::parse("outside").expect("run ID"),
            guest_cidr: "10.77.0.0/28".to_owned(),
            gateway: "10.77.0.1".to_owned(),
        };
        assert!(config.validate_run_network_request(&inside).is_ok());
        assert_eq!(
            config.validate_run_network_request(&outside),
            Err(ValidationError::RunNetworkOutsideConfiguredPool)
        );
        assert!(config.validate_ssh_public_port(None).is_ok());
        assert!(config.validate_ssh_public_port(Some(22_500)).is_ok());
        assert!(config.validate_ssh_public_port(Some(22_599)).is_ok());
        assert_eq!(
            config.validate_ssh_public_port(Some(22_499)),
            Err(ValidationError::SshPortOutsideConfiguredRange)
        );
        assert_eq!(
            config.validate_ssh_public_port(Some(22_600)),
            Err(ValidationError::SshPortOutsideConfiguredRange)
        );
    }

    #[test]
    fn jailerd_config_rejects_unsafe_network_policy() {
        let mut config = JailerdConfig {
            agent_uid: 991,
            agent_gid: 991,
            ..JailerdConfig::default()
        };
        config.guest_network_pool = "192.168.0.0/16".to_owned();
        assert_eq!(
            config.validate(),
            Err(ValidationError::InvalidGuestNetworkPool)
        );
        config.guest_network_pool = DEFAULT_GUEST_NETWORK_POOL.to_owned();
        config.ssh_public_port_start = 22;
        assert_eq!(config.validate(), Err(ValidationError::InvalidSshPortRange));
        config.ssh_public_port_start = 23_000;
        config.ssh_public_port_end = 22_999;
        assert_eq!(config.validate(), Err(ValidationError::InvalidSshPortRange));
    }

    #[test]
    fn privileged_paths_reject_lexical_traversal() {
        let mut config = JailerdConfig {
            agent_uid: 991,
            agent_gid: 991,
            ..JailerdConfig::default()
        };
        config.jail_root = PathBuf::from("/var/lib/intar/../escape");
        assert_eq!(
            config.validate(),
            Err(ValidationError::UnsafePrivilegedPath(
                config.jail_root.clone()
            ))
        );

        let spec = JailSpecV1 {
            version: PROTOCOL_VERSION,
            generation: ValidatedId::parse("generation").expect("generation"),
            uid: 200_000,
            gid: 200_000,
            jail_root: PathBuf::from("/var/lib/intar/jails/generation/root"),
            netns_path: PathBuf::from("/run/netns/../host"),
            netns_inode: 17,
            nofile_limit: 2_048,
            file_size_limit: None,
        };
        assert_eq!(
            spec.validate(),
            Err(ValidationError::UnsafePrivilegedPath(
                spec.netns_path.clone()
            ))
        );
    }

    #[test]
    fn jail_spec_rejects_zero_file_size_limit() {
        let spec = JailSpecV1 {
            version: PROTOCOL_VERSION,
            generation: ValidatedId::parse("generation").expect("generation"),
            uid: 200_000,
            gid: 200_000,
            jail_root: PathBuf::from("/var/lib/intar/jails/generation/root"),
            netns_path: PathBuf::from("/run/netns/intar-generation"),
            netns_inode: 17,
            nofile_limit: 2_048,
            file_size_limit: Some(0),
        };
        assert_eq!(spec.validate(), Err(ValidationError::InvalidFileSizeLimit));
    }

    #[test]
    fn jail_spec_rejects_zero_network_namespace_inode() {
        let spec = JailSpecV1 {
            version: PROTOCOL_VERSION,
            generation: ValidatedId::parse("generation").expect("generation"),
            uid: 200_000,
            gid: 200_000,
            jail_root: PathBuf::from("/var/lib/intar/jails/generation/root"),
            netns_path: PathBuf::from("/run/netns/intar-generation"),
            netns_inode: 0,
            nofile_limit: 2_048,
            file_size_limit: None,
        };
        assert_eq!(
            spec.validate(),
            Err(ValidationError::InvalidNetworkNamespaceInode)
        );
    }

    fn source(path: &str, access: ArtifactAccess) -> ArtifactSource {
        ArtifactSource {
            source_root: 0,
            relative_path: PathBuf::from(path.trim_start_matches("/trusted/")),
            sha256: None,
            access,
        }
    }
}
