use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::catalog::{ImageArchitecture, ImageKey, Mib, ProbePhase};

pub const BRIDGE_PROTOCOL_VERSION: u16 = 5;
pub const HOST_DESIRED_STATE_SCHEMA_VERSION: u16 = 2;
pub const HOST_STATE_REPORT_SCHEMA_VERSION: u16 = 2;
pub const BUILD_REPORT_SCHEMA_VERSION: u16 = 1;
pub const VM_REPORT_SCHEMA_VERSION: u16 = 1;

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BridgeMessageV5 {
    ClientHello(ClientHelloV5),
    ServerHello(ServerHelloV5),
    DesiredState(DesiredStateV5),
    StateReport(StateReportV5),
    VmReport(VmReportV5),
    BuildReport(BuildReportV5),
    SyncRequest(SyncRequestV5),
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ClientHelloV5 {
    pub protocol_version: u16,
    pub host_id: String,
    pub agent_version: String,
    pub role: HostRoleV1,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_applied_desired_version: Option<u64>,
    pub capabilities: HostCapabilitiesV1,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ServerHelloV5 {
    pub protocol_version: u16,
    pub host_id: String,
    pub desired_version: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DesiredStateV5 {
    pub protocol_version: u16,
    pub host_id: String,
    pub desired_state: HostDesiredStateV1,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct StateReportV5 {
    pub protocol_version: u16,
    pub host_id: String,
    pub report: HostStateReportV1,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct VmReportV5 {
    pub protocol_version: u16,
    pub host_id: String,
    pub report: VmReportV1,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct BuildReportV5 {
    pub protocol_version: u16,
    pub host_id: String,
    pub report: BuildReportV1,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SyncRequestV5 {
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
pub struct HostDesiredStateV1 {
    pub schema_version: u16,
    pub host_id: String,
    pub version: u64,
    pub generated_at_unix_ms: i64,
    pub cached_images: Vec<DesiredCachedImageV1>,
    pub vms: Vec<DesiredVmV1>,
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
pub struct DesiredVmV1 {
    pub run_id: String,
    pub vm_name: String,
    pub desired_phase: DesiredVmPhase,
    pub image_key: ImageKey,
    pub image_sha256: String,
    pub resources: VmResourcesV1,
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
pub struct VmResourcesV1 {
    pub cpu_count: u16,
    pub memory_mib: Mib,
    pub disk_mib: Mib,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct HostStateReportV1 {
    pub schema_version: u16,
    pub host_id: String,
    pub observed_at_unix_ms: i64,
    pub applied_desired_version: u64,
    pub capacity: HostCapacityV1,
    pub capabilities: HostCapabilitiesV1,
    pub cached_images: Vec<CachedImageStateV1>,
    pub vms: Vec<VmActualStateV1>,
    pub builds: Vec<BuildReportV1>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct HostCapacityV1 {
    pub cpu_count: u16,
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
pub struct HostCapabilitiesV1 {
    pub arch: ImageArchitecture,
    pub supports_kvm: bool,
    pub supports_vsock: bool,
    pub supports_reflink: bool,
    pub supports_nftables: bool,
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
pub struct VmActualStateV1 {
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
pub struct VmReportV1 {
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
        let message = BridgeMessageV5::SyncRequest(SyncRequestV5 {
            protocol_version: BRIDGE_PROTOCOL_VERSION,
            host_id: "host-1".to_owned(),
            reason: SyncRequestReason::Reconnect,
        });

        let actual = serde_json::to_value(message).expect("message should serialize");

        assert_eq!(
            actual,
            serde_json::json!({
                "type": "sync_request",
                "protocol_version": 5,
                "host_id": "host-1",
                "reason": "reconnect",
            })
        );
    }
}
