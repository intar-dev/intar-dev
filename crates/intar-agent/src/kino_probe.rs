#![forbid(unsafe_code)]

#[cfg(target_os = "linux")]
use anyhow::{Context as _, Result};
#[cfg(target_os = "linux")]
use prost::Message as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[cfg(any(test, target_os = "linux"))]
use serde_json::json;
#[cfg(any(test, target_os = "linux"))]
use sha2::{Digest, Sha256};

#[cfg(target_os = "linux")]
use crate::proto::kino_v1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProbeCollectionState {
    Ok,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProbeSummary {
    pub total: u32,
    pub pass: u32,
    pub fail: u32,
    pub unknown: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProbeView {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub every_seconds: u64,
    pub last_attempt_at_ms: Option<i64>,
    pub last_success_at_ms: Option<i64>,
    pub last_duration_ms: u64,
    pub error: Option<String>,
    pub value: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProbeSnapshotView {
    pub generated_at_ms: Option<i64>,
    pub summary: ProbeSummary,
    pub probes: Vec<ProbeView>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProbeUpdateEnvelope {
    pub update_id: String,
    pub vm_name: String,
    pub run_id: String,
    pub generated_at_ms: i64,
    pub collection_state: ProbeCollectionState,
    pub collection_error: Option<String>,
    pub fingerprint: String,
    pub summary: ProbeSummary,
    pub ssh_host_keys_openssh: Vec<String>,
    pub probes: Vec<ProbeView>,
}

#[derive(Debug, Clone)]
#[cfg(target_os = "linux")]
pub struct ProbePollResult {
    pub generated_at_ms: Option<i64>,
    pub summary: ProbeSummary,
    pub ssh_host_keys_openssh: Vec<String>,
    pub probes: Vec<ProbeView>,
    pub fingerprint: String,
}

#[cfg(target_os = "linux")]
pub fn decode_probe_snapshot(raw: &[u8]) -> Result<ProbePollResult> {
    let snapshot = kino_v1::ProbesSnapshotV1::decode(raw)
        .context("failed to decode Kino protobuf snapshot")?;
    Ok(normalize_snapshot(snapshot))
}

#[cfg(target_os = "linux")]
pub fn build_probe_snapshot_view(result: &ProbePollResult) -> ProbeSnapshotView {
    ProbeSnapshotView {
        generated_at_ms: result.generated_at_ms,
        summary: result.summary.clone(),
        probes: result.probes.clone(),
    }
}

impl ProbeUpdateEnvelope {
    #[cfg(target_os = "linux")]
    pub fn from_poll_result(vm_name: &str, run_id: &str, result: ProbePollResult) -> Self {
        let snapshot = build_probe_snapshot_view(&result);
        let generated_at_ms = result.generated_at_ms.unwrap_or_else(now_unix_ms);
        Self {
            update_id: random_update_id(),
            vm_name: vm_name.to_string(),
            run_id: run_id.to_string(),
            generated_at_ms,
            collection_state: ProbeCollectionState::Ok,
            collection_error: None,
            fingerprint: result.fingerprint,
            summary: snapshot.summary,
            ssh_host_keys_openssh: result.ssh_host_keys_openssh,
            probes: snapshot.probes,
        }
    }

    #[cfg(target_os = "linux")]
    pub fn snapshot_view(&self) -> ProbeSnapshotView {
        ProbeSnapshotView {
            generated_at_ms: Some(self.generated_at_ms),
            summary: self.summary.clone(),
            probes: self.probes.clone(),
        }
    }
}

#[cfg(test)]
pub fn fingerprint_for_state(
    collection_state: ProbeCollectionState,
    collection_error: Option<&str>,
    snapshot: &ProbeSnapshotView,
) -> String {
    fingerprint_for_state_with_host_keys(collection_state, collection_error, snapshot, &[])
}

#[cfg(any(test, target_os = "linux"))]
fn fingerprint_for_state_with_host_keys(
    collection_state: ProbeCollectionState,
    collection_error: Option<&str>,
    snapshot: &ProbeSnapshotView,
    ssh_host_keys_openssh: &[String],
) -> String {
    let normalized = json!({
        "collectionState": collection_state,
        "collectionError": collection_error.unwrap_or_default(),
        "sshHostKeysOpenSsh": ssh_host_keys_openssh,
        "probes": snapshot.probes.iter().map(|probe| {
            json!({
                "id": probe.id,
                "kind": probe.kind,
                "status": probe.status,
                "error": probe.error,
                "value": probe.value,
            })
        }).collect::<Vec<_>>(),
    });
    hash_json(&normalized)
}

#[cfg(target_os = "linux")]
fn normalize_snapshot(snapshot: kino_v1::ProbesSnapshotV1) -> ProbePollResult {
    let generated_at_ms = optional_u64_to_i64(snapshot.generated_at_unix_ms);
    let ssh_host_keys_openssh = normalize_ssh_host_keys(snapshot.ssh_host_keys_openssh);
    let probes = snapshot
        .probes
        .into_iter()
        .map(normalize_probe)
        .collect::<Vec<_>>();
    let summary = summarize(&probes);
    let snapshot = ProbeSnapshotView {
        generated_at_ms,
        summary: summary.clone(),
        probes: probes.clone(),
    };
    let fingerprint = fingerprint_for_state_with_host_keys(
        ProbeCollectionState::Ok,
        None,
        &snapshot,
        &ssh_host_keys_openssh,
    );

    ProbePollResult {
        generated_at_ms,
        summary,
        ssh_host_keys_openssh,
        probes,
        fingerprint,
    }
}

#[cfg(target_os = "linux")]
fn normalize_ssh_host_keys(keys: Vec<String>) -> Vec<String> {
    let mut keys = keys
        .into_iter()
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
        .collect::<Vec<_>>();
    keys.sort();
    keys.dedup();
    keys
}

#[cfg(target_os = "linux")]
fn normalize_probe(probe: kino_v1::ProbeSnapshot) -> ProbeView {
    let value = match probe.value {
        Some(kino_v1::probe_snapshot::Value::FileExists(v)) => {
            json!({ "path": v.path, "exists": v.exists })
        }
        Some(kino_v1::probe_snapshot::Value::FileRegexCapture(v)) => json!({
            "path": v.path,
            "pattern": v.pattern,
            "matched": v.matched,
            "fullMatch": empty_to_none(v.full_match),
            "captures": v.captures,
            "fileContent": empty_to_none(v.file_content),
        }),
        Some(kino_v1::probe_snapshot::Value::PortOpen(v)) => json!({
            "host": v.host,
            "port": v.port,
            "protocol": v.protocol,
            "open": v.open,
            "detail": empty_to_none(v.detail),
        }),
        Some(kino_v1::probe_snapshot::Value::Service(v)) => json!({
            "service": v.service,
            "desiredState": v.desired_state,
            "actualState": empty_to_none(v.actual_state),
            "stateSatisfied": v.state_satisfied,
        }),
        Some(kino_v1::probe_snapshot::Value::K8sPodState(v)) => json!({
            "namespace": v.namespace,
            "selector": v.selector,
            "desiredState": v.desired_state,
            "matchedPods": v.matched_pods,
            "matchingPodNames": v.matching_pod_names,
            "stateSatisfied": v.state_satisfied,
        }),
        Some(kino_v1::probe_snapshot::Value::CommandJsonPath(v)) => json!({
            "argv": v.argv,
            "jsonPath": v.json_path,
            "expectedJson": empty_to_none(v.expected_json),
            "matched": v.matched,
            "matchedValues": v.matched_values,
            "stdout": empty_to_none(v.stdout),
            "stderr": empty_to_none(v.stderr),
            "exitCode": v.exit_code,
        }),
        None => Value::Null,
    };

    ProbeView {
        id: probe.id,
        kind: normalize_probe_kind(probe.kind),
        status: normalize_probe_status(probe.status),
        every_seconds: probe.every_seconds,
        last_attempt_at_ms: optional_u64_to_i64(probe.last_attempt_unix_ms),
        last_success_at_ms: optional_u64_to_i64(probe.last_success_unix_ms),
        last_duration_ms: probe.last_duration_ms,
        error: empty_to_none(probe.error),
        value,
    }
}

#[cfg(target_os = "linux")]
fn summarize(probes: &[ProbeView]) -> ProbeSummary {
    let mut summary = ProbeSummary {
        total: u32::try_from(probes.len()).unwrap_or(u32::MAX),
        pass: 0,
        fail: 0,
        unknown: 0,
    };
    for probe in probes {
        match probe.status.as_str() {
            "pass" => summary.pass = summary.pass.saturating_add(1),
            "fail" => summary.fail = summary.fail.saturating_add(1),
            _ => summary.unknown = summary.unknown.saturating_add(1),
        }
    }
    summary
}

#[cfg(target_os = "linux")]
fn normalize_probe_kind(kind: i32) -> String {
    match kino_v1::ProbeKind::try_from(kind).unwrap_or(kino_v1::ProbeKind::Unspecified) {
        kino_v1::ProbeKind::FileExists => "file_exists",
        kino_v1::ProbeKind::FileRegexCapture => "file_regex_capture",
        kino_v1::ProbeKind::Service => "service",
        kino_v1::ProbeKind::PortOpen => "port_open",
        kino_v1::ProbeKind::K8sPodState => "k8s_pod_state",
        kino_v1::ProbeKind::CommandJsonPath => "command_json_path",
        kino_v1::ProbeKind::Unspecified => "unknown",
    }
    .to_string()
}

#[cfg(target_os = "linux")]
fn normalize_probe_status(status: i32) -> String {
    match kino_v1::ProbeStatus::try_from(status).unwrap_or(kino_v1::ProbeStatus::Unknown) {
        kino_v1::ProbeStatus::Pass => "pass",
        kino_v1::ProbeStatus::Fail => "fail",
        kino_v1::ProbeStatus::Unknown => "unknown",
    }
    .to_string()
}

#[cfg(target_os = "linux")]
fn optional_u64_to_i64(value: u64) -> Option<i64> {
    if value == 0 {
        None
    } else {
        i64::try_from(value).ok()
    }
}

#[cfg(target_os = "linux")]
fn empty_to_none(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(any(test, target_os = "linux"))]
fn hash_json(value: &Value) -> String {
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(target_os = "linux")]
fn now_unix_ms() -> i64 {
    let millis = time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
    i64::try_from(millis).unwrap_or(i64::MAX)
}

#[cfg(target_os = "linux")]
fn random_update_id() -> String {
    let mut bytes = [0_u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        return format!("probe-{}", now_unix_ms());
    }
    bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

#[cfg(test)]
mod tests {
    use super::{
        ProbeCollectionState, ProbeSnapshotView, ProbeSummary, ProbeView, fingerprint_for_state,
    };
    use serde_json::json;

    #[test]
    fn error_fingerprint_ignores_timing_fields() {
        let snapshot = ProbeSnapshotView {
            generated_at_ms: Some(1_700_000_000_000),
            summary: ProbeSummary {
                total: 1,
                pass: 1,
                fail: 0,
                unknown: 0,
            },
            probes: vec![ProbeView {
                id: "kino_config_present".to_string(),
                kind: "file_exists".to_string(),
                status: "pass".to_string(),
                every_seconds: 5,
                last_attempt_at_ms: Some(1),
                last_success_at_ms: Some(1),
                last_duration_ms: 5,
                error: None,
                value: json!({"path": "/etc/kino/kino.hcl", "exists": true}),
            }],
        };

        let left = fingerprint_for_state(
            ProbeCollectionState::Error,
            Some("connect failed"),
            &snapshot,
        );
        let mut changed = snapshot.clone();
        changed.generated_at_ms = Some(1_700_000_123_456);
        changed.probes[0].last_attempt_at_ms = Some(999);
        changed.probes[0].last_duration_ms = 999;
        let right = fingerprint_for_state(
            ProbeCollectionState::Error,
            Some("connect failed"),
            &changed,
        );
        assert_eq!(left, right);
    }

    #[test]
    fn ok_fingerprint_includes_ssh_host_keys() {
        let snapshot = ProbeSnapshotView {
            generated_at_ms: Some(1_700_000_000_000),
            summary: ProbeSummary {
                total: 0,
                pass: 0,
                fail: 0,
                unknown: 0,
            },
            probes: Vec::new(),
        };

        let without_key = super::fingerprint_for_state_with_host_keys(
            ProbeCollectionState::Ok,
            None,
            &snapshot,
            &[],
        );
        let with_key = super::fingerprint_for_state_with_host_keys(
            ProbeCollectionState::Ok,
            None,
            &snapshot,
            &["ssh-ed25519 AAAAHOST host".to_string()],
        );

        assert_ne!(without_key, with_key);
    }
}
