use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::catalog::{ImageArchitecture, ImageKey, Mib, ProbePhase};

pub const BRIDGE_PROTOCOL_VERSION: u16 = 6;
pub const HOST_DESIRED_STATE_SCHEMA_VERSION: u16 = 3;
pub const HOST_STATE_REPORT_SCHEMA_VERSION: u16 = 4;
pub const BUILD_REPORT_SCHEMA_VERSION: u16 = 1;
pub const VM_REPORT_SCHEMA_VERSION: u16 = 3;

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[allow(clippy::large_enum_variant)]
pub enum BridgeMessageV6 {
    ClientHello(ClientHelloV6),
    ServerHello(ServerHelloV6),
    DesiredState(DesiredStateV6),
    StateReport(StateReportV6),
    VmReport(VmReportV6),
    BuildReport(BuildReportV6),
    SyncRequest(SyncRequestV6),
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ClientHelloV6 {
    #[schemars(range(min = 6, max = 6))]
    pub protocol_version: u16,
    pub host_id: String,
    pub agent_version: String,
    pub role: HostRoleV1,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_applied_desired_version: Option<u64>,
    pub capabilities: HostCapabilitiesV2,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ServerHelloV6 {
    #[schemars(range(min = 6, max = 6))]
    pub protocol_version: u16,
    pub host_id: String,
    pub desired_version: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DesiredStateV6 {
    #[schemars(range(min = 6, max = 6))]
    pub protocol_version: u16,
    pub host_id: String,
    pub desired_state: HostDesiredStateV2,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct StateReportV6 {
    #[schemars(range(min = 6, max = 6))]
    pub protocol_version: u16,
    pub host_id: String,
    pub report: HostStateReportV2,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct VmReportV6 {
    #[schemars(range(min = 6, max = 6))]
    pub protocol_version: u16,
    pub host_id: String,
    pub report: VmReportV2,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct BuildReportV6 {
    #[schemars(range(min = 6, max = 6))]
    pub protocol_version: u16,
    pub host_id: String,
    pub report: BuildReportV1,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SyncRequestV6 {
    #[schemars(range(min = 6, max = 6))]
    pub protocol_version: u16,
    pub host_id: String,
    pub reason: SyncRequestReason,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HostRoleV1 {
    Agent,
    Builder,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncRequestReason {
    Connect,
    Reconnect,
    DesiredVersionLag,
    OperatorRequested,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct HostDesiredStateV2 {
    #[schemars(range(min = 3, max = 3))]
    pub schema_version: u16,
    pub host_id: String,
    pub version: u64,
    pub generated_at_unix_ms: i64,
    pub cached_images: Vec<DesiredCachedImageV1>,
    pub vms: Vec<DesiredVmV2>,
    pub builds: Vec<DesiredBuildV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DesiredCachedImageV1 {
    pub image_key: ImageKey,
    pub image_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DesiredBuildV1 {
    pub build_id: String,
    pub scenario_id: String,
    pub arch: ImageArchitecture,
    pub rev: String,
    pub content_hash: String,
    pub bundle_ref: String,
    pub kino_version: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DesiredVmV2 {
    pub run_id: String,
    pub vm_name: String,
    pub desired_phase: DesiredVmPhase,
    pub image_key: ImageKey,
    pub image_sha256: String,
    pub resources: VmResourcesV2,
    pub ssh_authorized_keys_openssh: Vec<String>,
    pub lease_expires_at_unix_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DesiredVmPhase {
    Running,
    Absent,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct VmResourcesV2 {
    #[schemars(range(min = 1))]
    pub cpu_millis: u32,
    #[schemars(range(min = 1))]
    pub vcpu_count: u16,
    pub memory_mib: Mib,
    pub disk_mib: Mib,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct HostStateReportV2 {
    #[schemars(range(min = 4, max = 4))]
    pub schema_version: u16,
    pub host_id: String,
    pub observed_at_unix_ms: i64,
    pub applied_desired_version: u64,
    pub capacity: HostCapacityV2,
    pub capabilities: HostCapabilitiesV2,
    pub cached_images: Vec<CachedImageStateV1>,
    pub vms: Vec<VmActualStateV2>,
    pub builds: Vec<BuildReportV1>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct HostCapacityV2 {
    pub total_cpu_millis: u32,
    pub reserved_cpu_millis: u32,
    pub schedulable_cpu_millis: u32,
    pub committed_cpu_millis: u32,
    pub memory_total_mib: Mib,
    pub memory_available_mib: Mib,
    /// Filesystem the disk figures were probed on (the VM/image data root).
    pub disk_probe_path: String,
    pub disk_total_mib: Mib,
    pub disk_available_mib: Mib,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load_avg_1m: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load_avg_5m: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load_avg_15m: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_ipv4: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_ipv6: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct HostCapabilitiesV2 {
    pub arch: ImageArchitecture,
    /// Root-owned runtime identity and lease policy. `None` means the host has
    /// no live jailerd attestation and is never performance-ready.
    pub cloud_hypervisor_sha256: Option<String>,
    pub boot_cpu_millis: Option<u32>,
    pub boot_cpu_lease_ms: Option<u64>,
    pub supports_kvm: bool,
    pub supports_vsock: bool,
    pub supports_reflink: bool,
    pub supports_nftables: bool,
    pub supports_jailer_v1: bool,
    pub supports_jailer_v2: bool,
    pub supports_boot_cpu_lease: bool,
    pub supports_template_backed_launch: bool,
    pub fast_template_store: bool,
    pub supports_hard_cpu_quota: bool,
    pub supports_landlock: bool,
    pub supports_cgroup_v2: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct VmResourceStateV2 {
    #[schemars(range(min = 1))]
    pub cpu_millis: u32,
    #[schemars(range(min = 1))]
    pub vcpu_count: u16,
    #[schemars(range(min = 1))]
    pub cpu_quota_us: u64,
    #[schemars(range(min = 1))]
    pub cpu_period_us: u64,
    pub cpu_usage_usec: u64,
    pub cpu_user_usec: u64,
    pub cpu_system_usec: u64,
    pub cpu_nr_periods: u64,
    pub cpu_nr_throttled: u64,
    pub cpu_throttled_usec: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct VmSandboxStateV1 {
    pub healthy: bool,
    pub generation: String,
    pub systemd_unit: String,
    pub cgroup_path: String,
    pub seccomp_enabled: bool,
    pub landlock_enabled: bool,
    pub no_new_privs: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct CachedImageStateV1 {
    pub image_key: ImageKey,
    pub image_sha256: String,
    pub phase: ImageCachePhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_on_disk: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub updated_at_unix_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageCachePhase {
    Missing,
    Queued,
    Downloading,
    Ready,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct VmActualStateV2 {
    pub run_id: String,
    pub vm_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desired_version: Option<u64>,
    pub phase: VmPhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_key: Option<ImageKey>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<VmNetworkStateV1>,
    /// Explicit shell-readiness evidence. Network metadata alone is not a
    /// readiness signal because the forward may be reserved before ingress is
    /// published.
    pub terminal: VmTerminalStateV1,
    /// Live CPU-boundary evidence for the VM process tree. This is distinct
    /// from the guest vCPU topology and from periodic usage accounting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_constraints: Option<VmRuntimeConstraintsV1>,
    /// Generation-fenced, best-effort host measurements captured during the
    /// v2 boot path. These observations are benchmark evidence only: missing
    /// telemetry must never hold the CPU lease open or suppress readiness.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boot_evidence: Option<VmBootEvidenceV1>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_state: Option<VmResourceStateV2>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<VmSandboxStateV1>,
    pub ssh_host_keys_openssh: Vec<String>,
    pub probes: Vec<VmProbeSnapshotV1>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archive: Option<VmArchiveStateV1>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub updated_at_unix_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VmPhase {
    Pending,
    PullingImage,
    CreatingDisks,
    Booting,
    Running,
    Ready,
    Solved,
    Stopping,
    Stopped,
    Failed,
    Absent,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct VmNetworkStateV1 {
    pub bridge_name: String,
    pub guest_ip: String,
    pub guest_cidr: String,
    pub gateway: String,
    /// Publicly routable address of the agent host's SSH forward for this VM
    /// (the agent's advertised host). The guest IP is only reachable within
    /// the agent's internal VM network.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh_host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_host_port: Option<u16>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VmTerminalStateKindV1 {
    Pending,
    Ready,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct VmTerminalTargetV1 {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub checked_at_unix_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct VmTerminalStateV1 {
    pub state: VmTerminalStateKindV1,
    /// Present only when `state` is `ready`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<VmTerminalTargetV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub observed_at_unix_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VmRuntimeConstraintPhaseV1 {
    BootBurst,
    Steady,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct VmRuntimeConstraintsV1 {
    /// Jailer-owned generation to which every quota and ingress attestation
    /// in this object applies. The breaking v2 contract never accepts
    /// generation-less quota evidence.
    pub generation: String,
    pub phase: VmRuntimeConstraintPhaseV1,
    #[schemars(range(min = 1))]
    pub steady_cpu_millis: u32,
    #[schemars(range(min = 1))]
    pub effective_cpu_millis: u32,
    /// Timestamp of the authoritative live cgroup readback. Required by the
    /// control plane before a `steady` runtime can expose a terminal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quota_verified_at_unix_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease_expires_at_unix_ms: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct VmBootEvidenceV1 {
    /// Jailer-owned generation shared by every CPU sample in this object.
    pub generation: String,
    pub started_at_unix_ms: i64,
    pub ready_at_unix_ms: i64,
    pub phases: VmBootPhaseDurationsV1,
    /// Best-effort samples. A point can be absent when the 50 ms telemetry
    /// budget expires; readiness and quota sealing never wait for a retry.
    pub cpu_samples: Vec<VmBootCpuSampleV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct VmBootPhaseDurationsV1 {
    /// Image preparation plus runtime-disk staging work. Runtime-disk and
    /// network construction overlap, so this excludes `network_ms`.
    pub image_disk_ms: u64,
    /// Network construction plus the jailer/VMM path through `vm.boot`
    /// acceptance. This may overlap the runtime-disk portion above.
    pub network_jailer_vmm_ms: u64,
    pub guest_to_kino_ms: u64,
    pub seal_ssh_publish_ms: u64,
    pub total_ms: u64,
    /// Component durations retained so a regression can be attributed without
    /// introducing another launch-time inspection.
    pub image_cache_ms: u64,
    pub runtime_disk_ms: u64,
    pub network_ms: u64,
    pub jailer_stage_ms: u64,
    pub vmm_start_ms: u64,
    pub vm_api_ms: u64,
    pub quota_seal_ms: u64,
    pub ssh_verify_ms: u64,
    pub terminal_publish_ms: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VmBootCpuSamplePointV1 {
    VmBootAccepted,
    KinoReady,
    PreSeal,
    PostSeal,
    TerminalPublished,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct VmBootCpuSampleV1 {
    pub point: VmBootCpuSamplePointV1,
    pub sampled_at_unix_ms: i64,
    pub phase: VmRuntimeConstraintPhaseV1,
    #[schemars(range(min = 1))]
    pub steady_cpu_millis: u32,
    #[schemars(range(min = 1))]
    pub effective_cpu_millis: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boot_deadline_unix_ms: Option<i64>,
    pub cpu_max: String,
    pub cpu_max_burst: u64,
    pub quota_verified_at_unix_ms: i64,
    pub usage_usec: u64,
    pub user_usec: u64,
    pub system_usec: u64,
    pub nr_periods: u64,
    pub nr_throttled: u64,
    pub throttled_usec: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct VmProbeSnapshotV1 {
    pub id: String,
    pub phase: ProbePhase,
    pub status: VmProbeStatus,
    pub checked_at_unix_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VmProbeStatus {
    Unknown,
    Pass,
    Fail,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct VmArchiveStateV1 {
    pub phase: VmArchivePhase,
    pub artifact_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VmArchivePhase {
    None,
    Pending,
    Uploading,
    Complete,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct VmReportV2 {
    #[schemars(range(min = 3, max = 3))]
    pub schema_version: u16,
    pub host_id: String,
    pub run_id: String,
    pub vm_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desired_version: Option<u64>,
    pub observed_at_unix_ms: i64,
    pub phase: VmPhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<VmNetworkStateV1>,
    pub terminal: VmTerminalStateV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_constraints: Option<VmRuntimeConstraintsV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boot_evidence: Option<VmBootEvidenceV1>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_state: Option<VmResourceStateV2>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<VmSandboxStateV1>,
    pub ssh_host_keys_openssh: Vec<String>,
    pub probes: Vec<VmProbeSnapshotV1>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archive: Option<VmArchiveStateV1>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct BuildReportV1 {
    pub schema_version: u16,
    pub host_id: String,
    pub build_id: String,
    pub scenario_id: String,
    pub content_hash: String,
    pub observed_at_unix_ms: i64,
    pub phase: BuildPhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_vm: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at_unix_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at_unix_ms: Option<i64>,
    pub attempt: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BuildPhase {
    Queued,
    FetchingSources,
    BuildingBase,
    Building,
    Publishing,
    UploadingLogs,
    Succeeded,
    Failed,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_request_message_uses_flat_snake_case_tag() {
        let message = BridgeMessageV6::SyncRequest(SyncRequestV6 {
            protocol_version: BRIDGE_PROTOCOL_VERSION,
            host_id: "host-1".to_owned(),
            reason: SyncRequestReason::Reconnect,
        });

        let actual = serde_json::to_value(message).expect("message should serialize");

        assert_eq!(
            actual,
            serde_json::json!({
                "type": "sync_request",
                "protocol_version": 6,
                "host_id": "host-1",
                "reason": "reconnect",
            })
        );
    }
}
