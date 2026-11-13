//! Bridge protocol 9 (#307 §5.4), the agent's side: the hello, the desired
//! VMs and what a host reports about them. Every type refuses unknown
//! fields. The builder's messages join with the builder's own change.
//!
//! It lives beside `bridge` (protocol 8) until the agent and the Worker
//! have both moved.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::bridge::{
    DesiredVmPhase, HostCapacityV2, HostRelayCredentials, HostRoleV1, HostScope, ImageCachePhase,
    SyncRequestReason, VmArchiveStateV1, VmNetworkStateV1, VmResourceStateV3,
    VmRuntimeConstraintsV2, VmSandboxStateV1, VmTerminalStateV1,
};
use crate::oci::OciDigest;
use crate::scenario::SpecMode;

pub const BRIDGE_PROTOCOL_VERSION_9: u16 = 9;
pub const HOST_DESIRED_STATE_SCHEMA_VERSION_7: u16 = 7;
pub const HOST_STATE_REPORT_SCHEMA_VERSION_8: u16 = 8;
pub const VM_REPORT_SCHEMA_VERSION_7: u16 = 7;

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[allow(
    clippy::large_enum_variant,
    reason = "messages are built once and sent; boxing would only move the allocation"
)]
pub enum BridgeMessageV9 {
    ClientHello(ClientHelloV9),
    ServerHello(ServerHelloV9),
    DesiredState(DesiredStateV9),
    StateReport(StateReportV9),
    VmReport(VmReportV9),
    SyncRequest(SyncRequestV9),
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ClientHelloV9 {
    #[schemars(range(min = 9, max = 9))]
    pub protocol_version: u16,
    pub host_id: String,
    pub agent_version: String,
    pub role: HostRoleV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_applied_desired_version: Option<u64>,
    /// Picks the host's Kino and gates placement.
    pub guest_contract: u32,
    pub hardware: HostHardwareV1,
}

/// What the host can do. Facts only: no rollout switches.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HostHardwareV1 {
    /// Root-owned runtime identity. `None` means the host has no live
    /// jailerd attestation and is never performance-ready.
    pub cloud_hypervisor_sha256: Option<String>,
    pub kvm: bool,
    pub vsock: bool,
    pub reflink: bool,
    pub landlock: bool,
    pub cgroup_v2: bool,
    pub hard_cpu_quota: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ServerHelloV9 {
    pub session_id: String,
    #[schemars(range(min = 9, max = 9))]
    pub protocol_version: u16,
    pub host_id: String,
    pub desired_version: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay: Option<HostRelayCredentials>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DesiredStateV9 {
    #[schemars(range(min = 9, max = 9))]
    pub protocol_version: u16,
    pub host_id: String,
    pub desired_state: HostDesiredStateV3,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay: Option<HostRelayCredentials>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StateReportV9 {
    #[schemars(range(min = 9, max = 9))]
    pub protocol_version: u16,
    pub host_id: String,
    pub report: HostStateReportV3,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VmReportV9 {
    #[schemars(range(min = 9, max = 9))]
    pub protocol_version: u16,
    pub host_id: String,
    pub report: VmReportV3,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SyncRequestV9 {
    #[schemars(range(min = 9, max = 9))]
    pub protocol_version: u16,
    pub host_id: String,
    pub reason: SyncRequestReason,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HostDesiredStateV3 {
    pub scope: HostScope,
    pub owner_user_id: String,
    #[schemars(range(min = 7, max = 7))]
    pub schema_version: u16,
    pub host_id: String,
    pub version: u64,
    pub generated_at_unix_ms: i64,
    /// Machine images to hold, by manifest digest.
    pub cached_images: Vec<OciDigest>,
    /// The newest Kino of this host's guest contract; `None` when there is
    /// none, and then the host is not placed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kino_pin: Option<OciDigest>,
    pub vms: Vec<DesiredVmV3>,
}

/// One VM to run. It carries no address: the host allocates the run's
/// network.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DesiredVmV3 {
    pub vm_id: String,
    /// The machine's name in its scenario.
    pub name: String,
    pub run_id: String,
    pub runtime_execution_id: String,
    pub owner_user_id: String,
    #[schemars(range(min = 1))]
    pub generation: u64,
    pub desired_phase: DesiredVmPhase,
    pub lease_expires_at_unix_ms: i64,
    /// The machine image's manifest.
    pub image: OciDigest,
    /// The Kino manifest this run was pinned to at its start.
    pub kino: OciDigest,
    /// The machine spec blob for `mode`.
    pub spec: OciDigest,
    pub mode: SpecMode,
    #[schemars(range(min = 1))]
    pub cpu_millis: u32,
    pub memory_mib: u32,
    pub disk_mib: u32,
    /// The run's other machines, by name.
    pub peers: Vec<String>,
    pub ssh_authorized_keys: Vec<String>,
    /// False for a helper machine: no SSH, no recording disk.
    pub terminal: bool,
    /// Internet behind the floor; otherwise only the run's own network.
    pub egress: bool,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HostStateReportV3 {
    #[schemars(range(min = 8, max = 8))]
    pub schema_version: u16,
    pub host_id: String,
    pub observed_at_unix_ms: i64,
    pub applied_desired_version: u64,
    pub relay_connected: bool,
    pub guest_contract: u32,
    pub hardware: HostHardwareV1,
    pub capacity: HostCapacityV2,
    pub cached_images: Vec<CachedImageStateV2>,
    pub vms: Vec<VmStateV3>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CachedImageStateV2 {
    pub image: OciDigest,
    pub phase: ImageCachePhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes_on_disk: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub updated_at_unix_ms: i64,
}

/// A VM report is one VM's state, sent as soon as it changes.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VmReportV3 {
    #[schemars(range(min = 7, max = 7))]
    pub schema_version: u16,
    pub host_id: String,
    pub observed_at_unix_ms: i64,
    pub vm: VmStateV3,
}

/// `Ready` means SSH is up and a terminal can open; the lab's own state is
/// `lab`. The host decides nothing about tasks.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VmPhaseV2 {
    Pending,
    PullingImage,
    CreatingDisks,
    Booting,
    Running,
    Ready,
    Stopping,
    Stopped,
    Failed,
    Absent,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VmStateV3 {
    pub owner_user_id: String,
    pub runtime_execution_id: String,
    #[schemars(range(min = 1))]
    pub generation: u64,
    pub run_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desired_version: Option<u64>,
    pub phase: VmPhaseV2,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<OciDigest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kino: Option<OciDigest>,
    /// How the VM was started; absent until it was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<VmStartV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network: Option<VmNetworkStateV1>,
    pub terminal: VmTerminalStateV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_constraints: Option<VmRuntimeConstraintsV2>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_state: Option<VmResourceStateV3>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<VmSandboxStateV1>,
    pub ssh_host_keys_openssh: Vec<String>,
    /// Absent until Kino's first report for this run's `boot.json`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lab: Option<VmLabV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archive: Option<VmArchiveStateV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub updated_at_unix_ms: i64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VmStartPath {
    Cold,
    Wake,
    /// A wake that did not report in time; the VM was cold-booted instead.
    WakeFallback,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VmStartV1 {
    pub path: VmStartPath,
    /// Why not a wake, or why the wake fell back; for operators.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// From the VMM's start to Kino's first report for this run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_report_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LabState {
    Preparing,
    Ready,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    Pending,
    Pass,
    Fail,
    Error,
}

/// What Kino reported, re-truncated on the host. Only `tasks` is for
/// learners; tails and `failure` are for admins.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VmLabV1 {
    pub state: LabState,
    pub kino_version: String,
    pub ready: Vec<VmReadyV1>,
    pub tasks: Vec<VmTaskV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verify: Option<VmVerifyV1>,
    /// Guest uptime in ms at each step.
    pub timings_ms: BTreeMap<String, u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VmReadyV1 {
    pub name: String,
    pub status: CheckStatus,
    pub tail: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VmTaskV1 {
    pub id: String,
    pub status: CheckStatus,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passed_at_unix_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VmVerifyV1 {
    pub steps: Vec<VmVerifyStepV1>,
    pub done: bool,
    pub passed: bool,
    pub pre_done: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VmVerifyStepV1 {
    pub task_id: String,
    pub pre: CheckStatus,
    pub solve_exit: i32,
    pub post: CheckStatus,
    pub duration_ms: u32,
    pub tail: String,
    pub waiting_for: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest(digit: &str) -> String {
        format!("sha256:{}", digit.repeat(64))
    }

    fn desired_vm() -> serde_json::Value {
        serde_json::json!({
            "vm_id": "vm-1", "name": "control-plane", "run_id": "run-1",
            "runtime_execution_id": "exec-1", "owner_user_id": "user-1", "generation": 1,
            "desired_phase": "running", "lease_expires_at_unix_ms": 1,
            "image": digest("a"), "kino": digest("b"), "spec": digest("c"), "mode": "learn",
            "cpu_millis": 2000, "memory_mib": 3072, "disk_mib": 8192,
            "peers": ["web"], "ssh_authorized_keys": ["ssh-ed25519 AAAA run"],
            "terminal": true, "egress": false,
        })
    }

    #[test]
    fn a_desired_vm_round_trips_and_carries_no_address() -> Result<(), serde_json::Error> {
        let json = desired_vm();
        let vm: DesiredVmV3 = serde_json::from_value(json.clone())?;
        assert_eq!(serde_json::to_value(&vm)?, json);
        for extra in ["network", "image_key", "guest_tools", "later"] {
            let mut unknown = json.clone();
            unknown[extra] = true.into();
            assert!(
                serde_json::from_value::<DesiredVmV3>(unknown).is_err(),
                "{extra}"
            );
        }
        let mut path = json;
        path["image"] = "sha256:../x".into();
        assert!(serde_json::from_value::<DesiredVmV3>(path).is_err());
        Ok(())
    }

    #[test]
    fn messages_are_tagged_and_strict() -> Result<(), serde_json::Error> {
        let hello = serde_json::json!({
            "type": "client_hello", "protocol_version": 9, "host_id": "host-1",
            "agent_version": "1.0.0", "role": "agent", "guest_contract": 3,
            "hardware": {"cloud_hypervisor_sha256": null, "kvm": true, "vsock": true,
                "reflink": true, "landlock": true, "cgroup_v2": true, "hard_cpu_quota": true},
        });
        let message: BridgeMessageV9 = serde_json::from_value(hello.clone())?;
        assert_eq!(serde_json::to_value(&message)?, hello);
        // The capability booleans of protocol 8 are gone, not ignored.
        let mut old = hello;
        old["hardware"]["supports_run_cli_v1"] = true.into();
        assert!(serde_json::from_value::<BridgeMessageV9>(old).is_err());
        Ok(())
    }
}
