use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::catalog::Mib;
use crate::source::SourceCompileErrorCode;

/// The host state report schema before bridge 9. The Worker still reads it
/// in reports stored before the bridge 9 deploy.
pub const HOST_STATE_REPORT_SCHEMA_VERSION: u16 = 7;

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

/// The builder's result body when a source compile fails.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SourceCompileFailureV1 {
    pub compile_id: String,
    pub attempt: u32,
    pub errors: Vec<SourceCompileErrorV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SourceCompileErrorV1 {
    /// Repository-relative path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    pub code: SourceCompileErrorCode,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DesiredVmPhase {
    Running,
    Absent,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "snake_case")]
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
#[serde(deny_unknown_fields, rename_all = "snake_case")]
pub struct VmResourceStateV3 {
    #[schemars(range(min = 1))]
    pub cpu_millis: u32,
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
#[serde(deny_unknown_fields, rename_all = "snake_case")]
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
pub enum ImageCachePhase {
    Missing,
    Queued,
    Downloading,
    Ready,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "snake_case")]
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
#[serde(deny_unknown_fields, rename_all = "snake_case")]
pub struct VmTerminalTargetV1 {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub checked_at_unix_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "snake_case")]
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
#[serde(deny_unknown_fields, rename_all = "snake_case")]
pub struct VmRuntimeConstraintsV2 {
    /// Jailer-owned generation to which every quota and ingress attestation
    /// in this object applies. The breaking v2 contract never accepts
    /// generation-less quota evidence.
    pub generation: String,
    #[schemars(range(min = 1))]
    pub cpu_millis: u32,
    /// Timestamp of the authoritative live cgroup readback. Required by the
    /// control plane before a verified runtime can expose a terminal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quota_verified_at_unix_ms: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "snake_case")]
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_compile_failure_omits_unknown_locations() {
        let failure = SourceCompileFailureV1 {
            compile_id: "compile-1".to_owned(),
            attempt: 2,
            errors: vec![
                SourceCompileErrorV1 {
                    path: None,
                    line: None,
                    code: SourceCompileErrorCode::ManifestMissing,
                    message: "intar.yaml is missing".to_owned(),
                },
                SourceCompileErrorV1 {
                    path: Some("courses/k8s/lecture.md".to_owned()),
                    line: Some(3),
                    code: SourceCompileErrorCode::CompileFailed,
                    message: "bad frontmatter".to_owned(),
                },
            ],
        };

        let actual = serde_json::to_value(failure).expect("failure should serialize");

        assert_eq!(
            actual,
            serde_json::json!({
                "compile_id": "compile-1",
                "attempt": 2,
                "errors": [
                    { "code": "manifest_missing", "message": "intar.yaml is missing" },
                    {
                        "path": "courses/k8s/lecture.md",
                        "line": 3,
                        "code": "compile_failed",
                        "message": "bad frontmatter",
                    },
                ],
            })
        );
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HostScope {
    #[default]
    Personal,
    Platform,
    Organization,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HostRelayCredentials {
    pub websocket_url: String,
    pub token: String,
    pub gateway_host_key_openssh: String,
    pub identity: crate::stargate::HostRelayIdentity,
    pub expires_at_unix_ms: i64,
}
