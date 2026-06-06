use crate::probe::{
    CommandJsonPathValue, FileExistsValue, FileRegexCaptureValue, K8sPodStateValue, PortOpenValue,
    ProbeDefinition, ProbeKind, ProbeStatus, ProbeValue, ServiceValue,
};
use crate::proto::kino_v1;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::RwLock;

#[derive(Clone)]
pub(crate) struct ProbeStore {
    inner: Arc<RwLock<BTreeMap<String, ProbeState>>>,
}

#[derive(Debug, Clone)]
struct ProbeState {
    id: String,
    kind: ProbeKind,
    every_seconds: u64,
    status: ProbeStatus,
    last_attempt_unix_ms: Option<u64>,
    last_success_unix_ms: Option<u64>,
    last_duration_ms: u64,
    error: Option<String>,
    value: ProbeValue,
}

#[derive(Debug)]
pub(crate) struct ProbeUpdate {
    pub(crate) status: ProbeStatus,
    pub(crate) value: Option<ProbeValue>,
    pub(crate) error: Option<String>,
    pub(crate) attempted_at_unix_ms: u64,
    pub(crate) duration_ms: u64,
}

impl ProbeStore {
    pub(crate) fn new(probes: &[Arc<ProbeDefinition>]) -> Self {
        let map = probes
            .iter()
            .map(|probe| {
                (
                    probe.id().to_owned(),
                    ProbeState {
                        id: probe.id().to_owned(),
                        kind: probe.kind(),
                        every_seconds: probe.every().as_secs(),
                        status: ProbeStatus::Unknown,
                        last_attempt_unix_ms: None,
                        last_success_unix_ms: None,
                        last_duration_ms: 0,
                        error: None,
                        value: probe.initial_value(),
                    },
                )
            })
            .collect::<BTreeMap<_, _>>();

        Self {
            inner: Arc::new(RwLock::new(map)),
        }
    }

    pub(crate) async fn apply_update(&self, probe_id: &str, update: ProbeUpdate) {
        let mut state = self.inner.write().await;

        if let Some(entry) = state.get_mut(probe_id) {
            entry.status = update.status;
            entry.last_attempt_unix_ms = Some(update.attempted_at_unix_ms);
            entry.last_duration_ms = update.duration_ms;
            entry.error = update.error;

            if update.status == ProbeStatus::Pass {
                entry.last_success_unix_ms = Some(update.attempted_at_unix_ms);
            }

            if let Some(value) = update.value {
                entry.value = value;
            }
        }
    }

    pub(crate) async fn snapshot_proto(&self) -> kino_v1::ProbesSnapshotV1 {
        let generated_at_unix_ms = unix_time_ms(SystemTime::now());
        let state = self.inner.read().await;

        let probes = state
            .values()
            .map(|entry| {
                let value = match &entry.value {
                    ProbeValue::FileExists(value) => Some(
                        kino_v1::probe_snapshot::Value::FileExists(file_exists_proto(value)),
                    ),
                    ProbeValue::FileRegexCapture(value) => {
                        Some(kino_v1::probe_snapshot::Value::FileRegexCapture(
                            file_regex_capture_proto(value),
                        ))
                    }
                    ProbeValue::PortOpen(value) => Some(kino_v1::probe_snapshot::Value::PortOpen(
                        port_open_proto(value),
                    )),
                    ProbeValue::K8sPodState(value) => Some(
                        kino_v1::probe_snapshot::Value::K8sPodState(k8s_pod_state_proto(value)),
                    ),
                    ProbeValue::CommandJsonPath(value) => {
                        Some(kino_v1::probe_snapshot::Value::CommandJsonPath(
                            command_json_path_proto(value),
                        ))
                    }
                    ProbeValue::Service(value) => Some(kino_v1::probe_snapshot::Value::Service(
                        service_proto(value),
                    )),
                };

                kino_v1::ProbeSnapshot {
                    id: entry.id.clone(),
                    kind: probe_kind_to_proto(entry.kind),
                    status: probe_status_to_proto(entry.status),
                    every_seconds: entry.every_seconds,
                    last_attempt_unix_ms: entry.last_attempt_unix_ms.unwrap_or_default(),
                    last_success_unix_ms: entry.last_success_unix_ms.unwrap_or_default(),
                    last_duration_ms: entry.last_duration_ms,
                    error: entry.error.clone().unwrap_or_default(),
                    value,
                }
            })
            .collect::<Vec<_>>();

        kino_v1::ProbesSnapshotV1 {
            generated_at_unix_ms,
            probes,
        }
    }
}

pub(crate) fn unix_time_ms(time: SystemTime) -> u64 {
    let duration = match time.duration_since(UNIX_EPOCH) {
        Ok(value) => value,
        Err(_) => Duration::ZERO,
    };

    duration_millis_u64(duration)
}

pub(crate) fn duration_millis_u64(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn probe_kind_to_proto(kind: ProbeKind) -> i32 {
    match kind {
        ProbeKind::FileExists => 1,
        ProbeKind::FileRegexCapture => 2,
        ProbeKind::PortOpen => 3,
        ProbeKind::K8sPodState => 4,
        ProbeKind::CommandJsonPath => 5,
        ProbeKind::Service => 6,
    }
}

fn probe_status_to_proto(status: ProbeStatus) -> i32 {
    match status {
        ProbeStatus::Unknown => 0,
        ProbeStatus::Pass => 1,
        ProbeStatus::Fail => 2,
    }
}

fn file_exists_proto(value: &FileExistsValue) -> kino_v1::FileExistsValue {
    kino_v1::FileExistsValue {
        path: value.path.clone(),
        exists: value.exists,
    }
}

fn file_regex_capture_proto(value: &FileRegexCaptureValue) -> kino_v1::FileRegexCaptureValue {
    kino_v1::FileRegexCaptureValue {
        path: value.path.clone(),
        pattern: value.pattern.clone(),
        matched: value.matched,
        full_match: value.full_match.clone(),
        captures: value.captures.clone(),
        file_content: value.file_content.clone(),
    }
}

fn port_open_proto(value: &PortOpenValue) -> kino_v1::PortOpenValue {
    kino_v1::PortOpenValue {
        host: value.host.clone(),
        port: u32::from(value.port),
        protocol: match value.protocol {
            crate::config::PortProtocol::Tcp => "tcp".to_owned(),
            crate::config::PortProtocol::Udp => "udp".to_owned(),
        },
        open: value.open,
        detail: value.detail.clone(),
    }
}

fn k8s_pod_state_proto(value: &K8sPodStateValue) -> kino_v1::K8sPodStateValue {
    kino_v1::K8sPodStateValue {
        namespace: value.namespace.clone(),
        selector: value.selector.clone(),
        desired_state: value.desired_state.clone(),
        matched_pods: value.matched_pods,
        matching_pod_names: value.matching_pod_names.clone(),
        state_satisfied: value.state_satisfied,
    }
}

fn command_json_path_proto(value: &CommandJsonPathValue) -> kino_v1::CommandJsonPathValue {
    kino_v1::CommandJsonPathValue {
        argv: value.argv.clone(),
        json_path: value.json_path.clone(),
        expected_json: value.expected_json.clone(),
        matched: value.matched,
        matched_values: value.matched_values.clone(),
        stdout: value.stdout.clone(),
        stderr: value.stderr.clone(),
        exit_code: value.exit_code,
    }
}

fn service_proto(value: &ServiceValue) -> kino_v1::ServiceValue {
    kino_v1::ServiceValue {
        service: value.service.clone(),
        desired_state: value.desired_state.clone(),
        actual_state: value.actual_state.clone(),
        state_satisfied: value.state_satisfied,
    }
}

#[cfg(test)]
mod tests {
    use super::duration_millis_u64;
    use std::time::Duration;

    #[test]
    fn duration_conversion_saturates() {
        let huge = Duration::MAX;
        let value = duration_millis_u64(huge);
        assert_eq!(value, u64::MAX);
    }
}
