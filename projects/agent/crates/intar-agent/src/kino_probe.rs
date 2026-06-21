#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use anyhow::{Context as _, Result};
use prost::Message as _;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt as _, AsyncReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::net::UnixStream;
use tokio::time::timeout;

use crate::proto::kino_v1;

const FETCH_TIMEOUT: Duration = Duration::from_secs(4);

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
    pub probes: Vec<ProbeView>,
}

#[derive(Debug, Clone)]
pub struct ProbePollResult {
    pub generated_at_ms: Option<i64>,
    pub summary: ProbeSummary,
    pub probes: Vec<ProbeView>,
    pub fingerprint: String,
}

pub async fn fetch_probe_snapshot(vsock_path: &Path, port: u32) -> Result<ProbePollResult> {
    let raw = timeout(FETCH_TIMEOUT, fetch_probe_snapshot_inner(vsock_path, port))
        .await
        .context("timed out fetching Kino probes")??;

    let snapshot = kino_v1::ProbesSnapshotV1::decode(raw.as_slice())
        .context("failed to decode Kino protobuf snapshot")?;
    Ok(normalize_snapshot(snapshot))
}

pub fn build_probe_snapshot_view(result: &ProbePollResult) -> ProbeSnapshotView {
    ProbeSnapshotView {
        generated_at_ms: result.generated_at_ms,
        summary: result.summary.clone(),
        probes: result.probes.clone(),
    }
}

impl ProbeUpdateEnvelope {
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
            probes: snapshot.probes,
        }
    }

    pub fn from_error_with_snapshot(
        vm_name: &str,
        run_id: &str,
        message: impl Into<String>,
        snapshot: Option<ProbeSnapshotView>,
    ) -> Self {
        let message = message.into();
        let snapshot = snapshot.unwrap_or_else(|| ProbeSnapshotView {
            generated_at_ms: None,
            summary: ProbeSummary {
                total: 0,
                pass: 0,
                fail: 0,
                unknown: 0,
            },
            probes: Vec::new(),
        });

        Self {
            update_id: random_update_id(),
            vm_name: vm_name.to_string(),
            run_id: run_id.to_string(),
            generated_at_ms: now_unix_ms(),
            collection_state: ProbeCollectionState::Error,
            collection_error: Some(message.clone()),
            fingerprint: fingerprint_for_state(
                ProbeCollectionState::Error,
                Some(&message),
                &snapshot,
            ),
            summary: snapshot.summary,
            probes: snapshot.probes,
        }
    }

    pub fn snapshot_view(&self) -> ProbeSnapshotView {
        ProbeSnapshotView {
            generated_at_ms: Some(self.generated_at_ms),
            summary: self.summary.clone(),
            probes: self.probes.clone(),
        }
    }
}

pub fn fingerprint_for_state(
    collection_state: ProbeCollectionState,
    collection_error: Option<&str>,
    snapshot: &ProbeSnapshotView,
) -> String {
    let normalized = json!({
        "collectionState": collection_state,
        "collectionError": collection_error.unwrap_or_default(),
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

async fn fetch_probe_snapshot_inner(vsock_path: &Path, port: u32) -> Result<Vec<u8>> {
    let mut stream = UnixStream::connect(vsock_path).await.with_context(|| {
        format!(
            "failed to connect Kino vsock socket at {}",
            vsock_path.display()
        )
    })?;

    stream
        .write_all(format!("CONNECT {port}\n").as_bytes())
        .await
        .context("failed to write Cloud Hypervisor CONNECT preamble")?;
    stream
        .flush()
        .await
        .context("failed to flush Cloud Hypervisor CONNECT preamble")?;

    let mut reader = BufReader::new(stream);
    let mut connect_line = String::new();
    reader
        .read_line(&mut connect_line)
        .await
        .context("failed to read Cloud Hypervisor CONNECT response")?;
    validate_connect_response(&connect_line)?;

    reader
        .get_mut()
        .write_all(
            b"GET /probes HTTP/1.1\r\nHost: kino\r\nAccept: application/x-protobuf\r\nConnection: close\r\n\r\n",
        )
        .await
        .context("failed to write Kino probe HTTP request")?;
    reader
        .get_mut()
        .flush()
        .await
        .context("failed to flush Kino probe request")?;

    let mut status_line = String::new();
    reader
        .read_line(&mut status_line)
        .await
        .context("failed to read Kino probe status line")?;
    let status_code = parse_status_code(&status_line)?;

    let mut headers = BTreeMap::new();
    loop {
        let mut line = String::new();
        let bytes = reader
            .read_line(&mut line)
            .await
            .context("failed to read Kino probe response header")?;
        if bytes == 0 {
            anyhow::bail!("unexpected EOF while reading Kino probe headers");
        }
        if line == "\r\n" {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }

    if status_code != 200 {
        let mut body = Vec::new();
        reader
            .read_to_end(&mut body)
            .await
            .context("failed to read Kino error response body")?;
        let body_text = String::from_utf8_lossy(&body).trim().to_string();
        anyhow::bail!("Kino /probes returned HTTP {status_code}: {body_text}");
    }

    let content_type = headers
        .get("content-type")
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    if !content_type.starts_with("application/x-protobuf") {
        anyhow::bail!("unexpected Kino content type: {content_type}");
    }

    let mut body = Vec::new();
    reader
        .read_to_end(&mut body)
        .await
        .context("failed to read Kino probe response body")?;

    Ok(body)
}

fn parse_status_code(line: &str) -> Result<u16> {
    let mut parts = line.split_whitespace();
    let Some(proto) = parts.next() else {
        anyhow::bail!("missing HTTP version in status line");
    };
    if !proto.starts_with("HTTP/") {
        anyhow::bail!("invalid HTTP status line: {line}");
    }
    let Some(code) = parts.next() else {
        anyhow::bail!("missing HTTP status code in status line");
    };
    code.parse::<u16>()
        .with_context(|| format!("invalid HTTP status code: {code}"))
}

fn validate_connect_response(line: &str) -> Result<()> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        anyhow::bail!("empty Cloud Hypervisor CONNECT response");
    }
    if trimmed == "OK" || trimmed.starts_with("OK ") {
        return Ok(());
    }
    anyhow::bail!("Cloud Hypervisor CONNECT failed: {trimmed}");
}

fn normalize_snapshot(snapshot: kino_v1::ProbesSnapshotV1) -> ProbePollResult {
    let generated_at_ms = optional_u64_to_i64(snapshot.generated_at_unix_ms);
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
    let fingerprint = fingerprint_for_state(ProbeCollectionState::Ok, None, &snapshot);

    ProbePollResult {
        generated_at_ms,
        summary,
        probes,
        fingerprint,
    }
}

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

fn normalize_probe_status(status: i32) -> String {
    match kino_v1::ProbeStatus::try_from(status).unwrap_or(kino_v1::ProbeStatus::Unknown) {
        kino_v1::ProbeStatus::Pass => "pass",
        kino_v1::ProbeStatus::Fail => "fail",
        kino_v1::ProbeStatus::Unknown => "unknown",
    }
    .to_string()
}

fn optional_u64_to_i64(value: u64) -> Option<i64> {
    if value == 0 {
        None
    } else {
        i64::try_from(value).ok()
    }
}

fn empty_to_none(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn hash_json(value: &Value) -> String {
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn now_unix_ms() -> i64 {
    let millis = time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
    i64::try_from(millis).unwrap_or(i64::MAX)
}

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
        ProbeCollectionState, ProbePollResult, ProbeSummary, ProbeView, build_probe_snapshot_view,
        fingerprint_for_state, validate_connect_response,
    };
    use serde_json::json;

    #[test]
    fn error_fingerprint_ignores_timing_fields() {
        let snapshot = build_probe_snapshot_view(&ProbePollResult {
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
            fingerprint: "ignored".to_string(),
        });

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
    fn connect_response_accepts_ok_handshake() {
        assert!(validate_connect_response("OK 1073741834\n").is_ok());
        assert!(validate_connect_response("OK\n").is_ok());
    }

    #[test]
    fn connect_response_rejects_non_ok_handshake() {
        let err = validate_connect_response("ERR permission denied\n")
            .expect_err("non-ok handshake should fail");
        let message = err.to_string();
        assert!(
            message.contains("Cloud Hypervisor CONNECT failed"),
            "unexpected connect handshake error: {message}"
        );
    }
}
