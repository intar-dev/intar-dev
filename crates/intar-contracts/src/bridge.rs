use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::catalog::{ImageArchitecture, ImageKey, Mib, ProbePhase};

pub const BRIDGE_PROTOCOL_VERSION: u16 = 4;
pub const HOST_DESIRED_STATE_SCHEMA_VERSION: u16 = 1;
pub const HOST_STATE_REPORT_SCHEMA_VERSION: u16 = 1;
pub const VM_REPORT_SCHEMA_VERSION: u16 = 1;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BridgeMessageV4 {
    ClientHello(ClientHelloV4),
    ServerHello(ServerHelloV4),
    DesiredState(DesiredStateV4),
    StateReport(StateReportV4),
    VmReport(VmReportV4),
    SyncRequest(SyncRequestV4),
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ClientHelloV4 {
    pub protocol_version: u16,
    pub host_id: String,
    pub agent_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_applied_desired_version: Option<u64>,
    pub capabilities: HostCapabilitiesV1,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ServerHelloV4 {
    pub protocol_version: u16,
    pub host_id: String,
    pub desired_version: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DesiredStateV4 {
    pub protocol_version: u16,
    pub host_id: String,
    pub desired_state: HostDesiredStateV1,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct StateReportV4 {
    pub protocol_version: u16,
    pub host_id: String,
    pub report: HostStateReportV1,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct VmReportV4 {
    pub protocol_version: u16,
    pub host_id: String,
    pub report: VmReportV1,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SyncRequestV4 {
    pub protocol_version: u16,
    pub host_id: String,
    pub reason: SyncRequestReason,
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
    #[serde(default)]
    pub cached_images: Vec<DesiredCachedImageV1>,
    #[serde(default)]
    pub vms: Vec<DesiredVmV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DesiredCachedImageV1 {
    pub image_key: ImageKey,
    pub image_sha256: String,
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
    #[serde(default)]
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

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct HostStateReportV1 {
    pub schema_version: u16,
    pub host_id: String,
    pub observed_at_unix_ms: i64,
    pub applied_desired_version: u64,
    pub capacity: HostCapacityV1,
    pub capabilities: HostCapabilitiesV1,
    #[serde(default)]
    pub cached_images: Vec<CachedImageStateV1>,
    #[serde(default)]
    pub vms: Vec<VmActualStateV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct HostCapacityV1 {
    pub cpu_count: u16,
    pub memory_total_mib: Mib,
    pub memory_available_mib: Mib,
    pub disk_total_mib: Mib,
    pub disk_available_mib: Mib,
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
    #[serde(default)]
    pub ssh_host_keys_openssh: Vec<String>,
    #[serde(default)]
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
    #[serde(default)]
    pub ssh_host_keys_openssh: Vec<String>,
    #[serde(default)]
    pub probes: Vec<VmProbeSnapshotV1>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archive: Option<VmArchiveStateV1>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_request_message_uses_flat_snake_case_tag() {
        let message = BridgeMessageV4::SyncRequest(SyncRequestV4 {
            protocol_version: BRIDGE_PROTOCOL_VERSION,
            host_id: "host-1".to_owned(),
            reason: SyncRequestReason::Reconnect,
        });

        let actual = serde_json::to_value(message).expect("message should serialize");

        assert_eq!(
            actual,
            serde_json::json!({
                "type": "sync_request",
                "protocol_version": 4,
                "host_id": "host-1",
                "reason": "reconnect",
            })
        );
    }
}
