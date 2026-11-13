//! Bridge protocol 9 (#307 §5.4): the hello, the desired VMs, builds and
//! source compiles, and what a host reports about them. Every type refuses
//! unknown fields.
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
    BuildReport(BuildReportV9),
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
    /// What a builder builds and compiles for; absent on an agent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub builder: Option<BuilderHelloV1>,
}

/// A builder is assigned only builds of its `image_format` and compiles of
/// its `source_compile_digest`.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BuilderHelloV1 {
    pub image_format: String,
    /// `source_compile_digest(image_format, compiler version)`.
    pub source_compile_digest: String,
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
pub struct BuildReportV9 {
    #[schemars(range(min = 9, max = 9))]
    pub protocol_version: u16,
    pub host_id: String,
    pub report: BuildReportV2,
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
    /// Empty for an agent.
    pub builds: Vec<DesiredBuildV2>,
    /// Empty for an agent.
    pub source_compiles: Vec<DesiredSourceCompileV2>,
}

/// One image to build out of a stored bundle, and push.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DesiredBuildV2 {
    pub build_id: String,
    /// The key the builder recomputes from the bundle; a mismatch refuses
    /// the build.
    pub build_key: OciDigest,
    pub bundle_rev: String,
    pub target: BuildTargetV1,
    #[schemars(range(min = 1))]
    pub attempt: u32,
}

/// What a build builds: a repository image (`trixie` is the platform base)
/// or a scenario's machine.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum BuildTargetV1 {
    Image { name: String },
    Machine { scenario: String, machine: String },
}

/// One repository snapshot to compile into a bundle, or only validate.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DesiredSourceCompileV2 {
    pub compile_id: String,
    #[schemars(range(min = 1))]
    pub attempt: u32,
    pub rev: String,
    pub validate_only: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BuildPhaseV2 {
    Queued,
    FetchingSources,
    Building,
    Pushing,
    Succeeded,
    Failed,
}

/// One build's state, sent as soon as it changes. `image_digest` is the
/// pushed manifest, present exactly when the build succeeded.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BuildReportV2 {
    pub build_id: String,
    pub build_key: OciDigest,
    pub attempt: u32,
    pub phase: BuildPhaseV2,
    pub observed_at_unix_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at_unix_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at_unix_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_digest: Option<OciDigest>,
}

/// 1 to 128 of `[A-Za-z0-9._-]`, not `.` or `..`: ids and revs name files
/// and request paths.
#[must_use]
pub fn is_safe_name(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

impl DesiredBuildV2 {
    /// Every name the builder puts in a path, a URL or a log.
    ///
    /// # Errors
    /// Returns the first unsafe name.
    pub fn validate(&self) -> Result<(), String> {
        let names: &[(&str, &str)] = match &self.target {
            BuildTargetV1::Image { name } => &[("image", name)],
            BuildTargetV1::Machine { scenario, machine } => {
                &[("scenario", scenario), ("machine", machine)]
            }
        };
        for (label, value) in [
            ("build id", self.build_id.as_str()),
            ("bundle rev", &self.bundle_rev),
        ]
        .into_iter()
        .chain(names.iter().copied())
        {
            if !is_safe_name(value) {
                return Err(format!("invalid {label} '{value}'"));
            }
        }
        if self.attempt == 0 {
            return Err("a build attempt starts at 1".to_owned());
        }
        Ok(())
    }
}

impl DesiredSourceCompileV2 {
    /// The compile id and rev go into a request path and a child's argv.
    ///
    /// # Errors
    /// Returns the first unsafe name.
    pub fn validate(&self) -> Result<(), String> {
        for (label, value) in [("compile id", &self.compile_id), ("bundle rev", &self.rev)] {
            if !is_safe_name(value) {
                return Err(format!("invalid {label} '{value}'"));
            }
        }
        Ok(())
    }
}

impl BuildReportV2 {
    /// A succeeded build names its image and nothing else does.
    ///
    /// # Errors
    /// Returns what is inconsistent.
    pub fn validate(&self) -> Result<(), String> {
        match (self.phase, &self.image_digest) {
            (BuildPhaseV2::Succeeded, None) => {
                Err("a succeeded build names its image digest".to_owned())
            }
            (BuildPhaseV2::Succeeded, Some(_)) | (_, None) => Ok(()),
            (_, Some(_)) => Err("only a succeeded build names an image digest".to_owned()),
        }
    }
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

    fn desired_build() -> serde_json::Value {
        serde_json::json!({
            "build_id": "build-1", "build_key": digest("a"), "bundle_rev": "git-1-abc-p0011",
            "target": {"kind": "machine", "scenario": "broken-nginx", "machine": "web"},
            "attempt": 1,
        })
    }

    #[test]
    fn a_desired_build_round_trips_strictly_and_validates_its_names()
    -> Result<(), serde_json::Error> {
        let json = desired_build();
        let build: DesiredBuildV2 = serde_json::from_value(json.clone())?;
        assert_eq!(serde_json::to_value(&build)?, json);
        assert_eq!(build.validate(), Ok(()));
        let image: DesiredBuildV2 = serde_json::from_value(serde_json::json!({
            "build_id": "build-2", "build_key": digest("b"), "bundle_rev": "rev",
            "target": {"kind": "image", "name": "nginx"}, "attempt": 2,
        }))?;
        assert_eq!(image.validate(), Ok(()));
        // The v1 build's fields, and unknown target fields, are refused.
        for (field, value) in [
            ("content_hash", serde_json::json!("a")),
            ("bundle_ref", serde_json::json!("builds/x")),
            ("arch", serde_json::json!("x86_64")),
        ] {
            let mut unknown = json.clone();
            unknown[field] = value;
            assert!(
                serde_json::from_value::<DesiredBuildV2>(unknown).is_err(),
                "{field}"
            );
        }
        let mut target = json.clone();
        target["target"]["name"] = "web".into();
        assert!(serde_json::from_value::<DesiredBuildV2>(target).is_err());
        let mut key = json.clone();
        key["build_key"] = "f".repeat(64).into();
        assert!(serde_json::from_value::<DesiredBuildV2>(key).is_err());

        for (change, expected) in [
            (("build_id", "../x"), "invalid build id"),
            (("bundle_rev", "a b"), "invalid bundle rev"),
        ] {
            let mut broken = build.clone();
            match change.0 {
                "build_id" => broken.build_id = change.1.to_owned(),
                _ => broken.bundle_rev = change.1.to_owned(),
            }
            assert!(
                broken
                    .validate()
                    .is_err_and(|error| error.contains(expected))
            );
        }
        let mut machine = build.clone();
        machine.target = BuildTargetV1::Machine {
            scenario: "..".to_owned(),
            machine: "web".to_owned(),
        };
        assert!(
            machine
                .validate()
                .is_err_and(|error| error.contains("invalid scenario"))
        );
        let mut attempt = build;
        attempt.attempt = 0;
        assert!(attempt.validate().is_err());
        Ok(())
    }

    #[test]
    fn a_build_report_names_its_image_only_on_success() -> Result<(), serde_json::Error> {
        let json = serde_json::json!({
            "type": "build_report", "protocol_version": 9, "host_id": "builder-1",
            "report": {"build_id": "build-1", "build_key": digest("a"), "attempt": 1,
                "phase": "succeeded", "observed_at_unix_ms": 3, "started_at_unix_ms": 1,
                "finished_at_unix_ms": 3, "image_digest": digest("c")},
        });
        let message: BridgeMessageV9 = serde_json::from_value(json.clone())?;
        assert_eq!(serde_json::to_value(&message)?, json);
        let BridgeMessageV9::BuildReport(message) = message else {
            panic!("a build report");
        };
        let mut report = message.report;
        assert_eq!(report.validate(), Ok(()));
        report.image_digest = None;
        assert!(report.validate().is_err());
        report.phase = BuildPhaseV2::Failed;
        report.error = Some("boom".to_owned());
        assert_eq!(report.validate(), Ok(()));
        report.image_digest = Some(serde_json::from_value(digest("c").into())?);
        assert!(report.validate().is_err());
        Ok(())
    }

    #[test]
    fn a_builder_hello_states_its_image_format_and_compile_digest() -> Result<(), serde_json::Error>
    {
        let hello = serde_json::json!({
            "type": "client_hello", "protocol_version": 9, "host_id": "builder-1",
            "agent_version": "1.0.0", "role": "builder", "guest_contract": 3,
            "hardware": {"cloud_hypervisor_sha256": null, "kvm": true, "vsock": false,
                "reflink": false, "landlock": false, "cgroup_v2": false, "hard_cpu_quota": false},
            "builder": {"image_format": "intar-image-3", "source_compile_digest": "p0011aabb"},
        });
        let message: BridgeMessageV9 = serde_json::from_value(hello.clone())?;
        assert_eq!(serde_json::to_value(&message)?, hello);
        let mut unknown = hello;
        unknown["builder"]["arch"] = "x86_64".into();
        assert!(serde_json::from_value::<BridgeMessageV9>(unknown).is_err());
        Ok(())
    }

    #[test]
    fn a_desired_state_carries_builds_and_compiles() -> Result<(), serde_json::Error> {
        let json = serde_json::json!({
            "scope": "platform", "owner_user_id": "owner", "schema_version": 7,
            "host_id": "builder-1", "version": 1, "generated_at_unix_ms": 1,
            "cached_images": [], "vms": [], "builds": [desired_build()],
            "source_compiles": [{"compile_id": "compile-1", "attempt": 1, "rev": "git-1",
                "validate_only": false}],
        });
        let state: HostDesiredStateV3 = serde_json::from_value(json.clone())?;
        assert_eq!(serde_json::to_value(&state)?, json);
        assert_eq!(state.source_compiles[0].validate(), Ok(()));
        // Both lists are required, even when empty.
        let mut missing = json;
        missing
            .as_object_mut()
            .map(|object| object.remove("builds"));
        assert!(serde_json::from_value::<HostDesiredStateV3>(missing).is_err());
        Ok(())
    }
}
