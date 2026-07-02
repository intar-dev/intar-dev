use crate::config::{
    DesiredPodState, PodCondition, PodPhase, PortProtocol, ProbeConfig, ProbeKindConfig,
    ServiceState,
};
use jsonpath_rust::JsonPath;
use k8s_openapi::api::core::v1::Pod;
use kube::api::ListParams;
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Api, Client, Config as KubeClientConfig};
use regex::Regex;
use serde_json::Value as JsonValue;
use std::path::Path;
use std::time::Duration;
use thiserror::Error;
use tokio::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProbeKind {
    FileExists,
    FileRegexCapture,
    PortOpen,
    K8sPodState,
    CommandJsonPath,
    Service,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProbeStatus {
    Unknown,
    Pass,
    Fail,
}

#[derive(Clone)]
pub(crate) struct ProbeDefinition {
    id: String,
    kind: ProbeKind,
    every: Duration,
    timeout: Duration,
    runner: ProbeRunner,
}

impl ProbeDefinition {
    pub(crate) fn id(&self) -> &str {
        &self.id
    }

    pub(crate) fn kind(&self) -> ProbeKind {
        self.kind
    }

    pub(crate) fn every(&self) -> Duration {
        self.every
    }

    pub(crate) fn timeout(&self) -> Duration {
        self.timeout
    }

    pub(crate) fn initial_value(&self) -> ProbeValue {
        self.runner.initial_value()
    }

    pub(crate) async fn run(&self) -> ProbeRunResult {
        self.runner.run().await
    }
}

#[derive(Debug, Clone)]
pub(crate) enum ProbeValue {
    FileExists(FileExistsValue),
    FileRegexCapture(FileRegexCaptureValue),
    PortOpen(PortOpenValue),
    K8sPodState(K8sPodStateValue),
    CommandJsonPath(CommandJsonPathValue),
    Service(ServiceValue),
}

#[derive(Debug, Clone)]
pub(crate) struct FileExistsValue {
    pub(crate) path: String,
    pub(crate) exists: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct FileRegexCaptureValue {
    pub(crate) path: String,
    pub(crate) pattern: String,
    pub(crate) matched: bool,
    pub(crate) full_match: String,
    pub(crate) captures: Vec<String>,
    pub(crate) file_content: String,
}

#[derive(Debug, Clone)]
pub(crate) struct PortOpenValue {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) protocol: PortProtocol,
    pub(crate) open: bool,
    pub(crate) detail: String,
}

#[derive(Debug, Clone)]
pub(crate) struct K8sPodStateValue {
    pub(crate) namespace: String,
    pub(crate) selector: String,
    pub(crate) desired_state: String,
    pub(crate) matched_pods: u32,
    pub(crate) matching_pod_names: Vec<String>,
    pub(crate) state_satisfied: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct CommandJsonPathValue {
    pub(crate) argv: Vec<String>,
    pub(crate) json_path: String,
    pub(crate) expected_json: String,
    pub(crate) matched: bool,
    pub(crate) matched_values: Vec<String>,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) exit_code: i32,
}

#[derive(Debug, Clone)]
pub(crate) struct ServiceValue {
    pub(crate) service: String,
    pub(crate) desired_state: String,
    pub(crate) actual_state: String,
    pub(crate) state_satisfied: bool,
}

#[derive(Debug)]
pub(crate) struct ProbeRunResult {
    pub(crate) status: ProbeStatus,
    pub(crate) value: ProbeValue,
    pub(crate) error: Option<String>,
}

#[derive(Debug, Error)]
pub(crate) enum ProbeBuildError {
    #[error("probe '{probe_id}' has invalid regex '{pattern}': {source}")]
    InvalidRegex {
        probe_id: String,
        pattern: String,
        source: regex::Error,
    },
    #[error("probe '{probe_id}' kubeconfig '{path}' could not be loaded: {source}")]
    ReadKubeconfig {
        probe_id: String,
        path: String,
        source: kube::config::KubeconfigError,
    },
    #[error("probe '{probe_id}' kube client configuration failed: {source}")]
    BuildKubeConfig {
        probe_id: String,
        source: kube::config::KubeconfigError,
    },
    #[error("probe '{probe_id}' kube client build failed: {source}")]
    BuildKubeClient {
        probe_id: String,
        source: kube::Error,
    },
}

#[derive(Clone)]
enum ProbeRunner {
    FileExists(FileExistsProbe),
    FileRegexCapture(FileRegexCaptureProbe),
    PortOpen(PortOpenProbe),
    K8sPodState(K8sPodStateProbe),
    CommandJsonPath(CommandJsonPathProbe),
    Service(ServiceProbe),
}

impl ProbeRunner {
    fn initial_value(&self) -> ProbeValue {
        match self {
            Self::FileExists(probe) => ProbeValue::FileExists(FileExistsValue {
                path: path_string(&probe.path),
                exists: false,
            }),
            Self::FileRegexCapture(probe) => ProbeValue::FileRegexCapture(FileRegexCaptureValue {
                path: path_string(&probe.path),
                pattern: probe.pattern.clone(),
                matched: false,
                full_match: String::new(),
                captures: Vec::new(),
                file_content: String::new(),
            }),
            Self::PortOpen(probe) => ProbeValue::PortOpen(PortOpenValue {
                host: probe.host.clone(),
                port: probe.port,
                protocol: probe.protocol,
                open: false,
                detail: String::new(),
            }),
            Self::K8sPodState(probe) => ProbeValue::K8sPodState(K8sPodStateValue {
                namespace: probe.namespace.clone(),
                selector: probe.selector.clone(),
                desired_state: probe.desired_state.as_str().to_owned(),
                matched_pods: 0,
                matching_pod_names: Vec::new(),
                state_satisfied: false,
            }),
            Self::CommandJsonPath(probe) => ProbeValue::CommandJsonPath(CommandJsonPathValue {
                argv: probe.argv.clone(),
                json_path: probe.json_path.clone(),
                expected_json: probe
                    .expected
                    .as_ref()
                    .map_or_else(String::new, json_value_string),
                matched: false,
                matched_values: Vec::new(),
                stdout: String::new(),
                stderr: String::new(),
                exit_code: 0,
            }),
            Self::Service(probe) => ProbeValue::Service(ServiceValue {
                service: probe.service.clone(),
                desired_state: probe.state.as_str().to_owned(),
                actual_state: String::new(),
                state_satisfied: false,
            }),
        }
    }

    async fn run(&self) -> ProbeRunResult {
        match self {
            Self::FileExists(probe) => probe.run().await,
            Self::FileRegexCapture(probe) => probe.run().await,
            Self::PortOpen(probe) => probe.run().await,
            Self::K8sPodState(probe) => probe.run().await,
            Self::CommandJsonPath(probe) => probe.run().await,
            Self::Service(probe) => probe.run().await,
        }
    }
}

#[derive(Debug, Clone)]
struct FileExistsProbe {
    path: std::path::PathBuf,
}

impl FileExistsProbe {
    async fn run(&self) -> ProbeRunResult {
        match tokio::fs::metadata(&self.path).await {
            Ok(_) => ProbeRunResult {
                status: ProbeStatus::Pass,
                value: ProbeValue::FileExists(FileExistsValue {
                    path: path_string(&self.path),
                    exists: true,
                }),
                error: None,
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => ProbeRunResult {
                status: ProbeStatus::Fail,
                value: ProbeValue::FileExists(FileExistsValue {
                    path: path_string(&self.path),
                    exists: false,
                }),
                error: None,
            },
            Err(error) => ProbeRunResult {
                status: ProbeStatus::Fail,
                value: ProbeValue::FileExists(FileExistsValue {
                    path: path_string(&self.path),
                    exists: false,
                }),
                error: Some(error.to_string()),
            },
        }
    }
}

#[derive(Debug, Clone)]
struct FileRegexCaptureProbe {
    path: std::path::PathBuf,
    pattern: String,
    regex: Regex,
}

impl FileRegexCaptureProbe {
    async fn run(&self) -> ProbeRunResult {
        let bytes = match tokio::fs::read(&self.path).await {
            Ok(value) => value,
            Err(error) => {
                return ProbeRunResult {
                    status: ProbeStatus::Fail,
                    value: ProbeValue::FileRegexCapture(FileRegexCaptureValue {
                        path: path_string(&self.path),
                        pattern: self.pattern.clone(),
                        matched: false,
                        full_match: String::new(),
                        captures: Vec::new(),
                        file_content: String::new(),
                    }),
                    error: Some(error.to_string()),
                };
            }
        };

        let file_content = String::from_utf8_lossy(&bytes).into_owned();

        match self.regex.captures(&file_content) {
            Some(captures) => {
                let full_match = captures
                    .get(0)
                    .map_or_else(String::new, |matched| matched.as_str().to_owned());
                let capture_values = captures
                    .iter()
                    .skip(1)
                    .map(|capture| {
                        capture.map_or_else(String::new, |matched| matched.as_str().to_owned())
                    })
                    .collect::<Vec<_>>();

                ProbeRunResult {
                    status: ProbeStatus::Pass,
                    value: ProbeValue::FileRegexCapture(FileRegexCaptureValue {
                        path: path_string(&self.path),
                        pattern: self.pattern.clone(),
                        matched: true,
                        full_match,
                        captures: capture_values,
                        file_content,
                    }),
                    error: None,
                }
            }
            None => ProbeRunResult {
                status: ProbeStatus::Fail,
                value: ProbeValue::FileRegexCapture(FileRegexCaptureValue {
                    path: path_string(&self.path),
                    pattern: self.pattern.clone(),
                    matched: false,
                    full_match: String::new(),
                    captures: Vec::new(),
                    file_content,
                }),
                error: None,
            },
        }
    }
}

#[derive(Debug, Clone)]
struct PortOpenProbe {
    host: String,
    port: u16,
    protocol: PortProtocol,
}

impl PortOpenProbe {
    async fn run(&self) -> ProbeRunResult {
        match self.protocol {
            PortProtocol::Tcp => self.run_tcp().await,
            PortProtocol::Udp => self.run_udp().await,
        }
    }

    async fn run_tcp(&self) -> ProbeRunResult {
        match tokio::net::TcpStream::connect((self.host.as_str(), self.port)).await {
            Ok(_stream) => ProbeRunResult {
                status: ProbeStatus::Pass,
                value: ProbeValue::PortOpen(PortOpenValue {
                    host: self.host.clone(),
                    port: self.port,
                    protocol: self.protocol,
                    open: true,
                    detail: "TCP connect succeeded".to_owned(),
                }),
                error: None,
            },
            Err(error) => ProbeRunResult {
                status: ProbeStatus::Fail,
                value: ProbeValue::PortOpen(PortOpenValue {
                    host: self.host.clone(),
                    port: self.port,
                    protocol: self.protocol,
                    open: false,
                    detail: String::new(),
                }),
                error: Some(error.to_string()),
            },
        }
    }

    async fn run_udp(&self) -> ProbeRunResult {
        let bind_addr = if self.host.contains(':') {
            "[::]:0"
        } else {
            "0.0.0.0:0"
        };

        let socket = match tokio::net::UdpSocket::bind(bind_addr).await {
            Ok(value) => value,
            Err(error) => {
                return ProbeRunResult {
                    status: ProbeStatus::Fail,
                    value: ProbeValue::PortOpen(PortOpenValue {
                        host: self.host.clone(),
                        port: self.port,
                        protocol: self.protocol,
                        open: false,
                        detail: String::new(),
                    }),
                    error: Some(error.to_string()),
                };
            }
        };

        if let Err(error) = socket.connect((self.host.as_str(), self.port)).await {
            return ProbeRunResult {
                status: ProbeStatus::Fail,
                value: ProbeValue::PortOpen(PortOpenValue {
                    host: self.host.clone(),
                    port: self.port,
                    protocol: self.protocol,
                    open: false,
                    detail: String::new(),
                }),
                error: Some(error.to_string()),
            };
        }

        match socket.send(b"kino").await {
            Ok(bytes_sent) => ProbeRunResult {
                status: ProbeStatus::Pass,
                value: ProbeValue::PortOpen(PortOpenValue {
                    host: self.host.clone(),
                    port: self.port,
                    protocol: self.protocol,
                    open: true,
                    detail: format!("UDP datagram send succeeded ({bytes_sent} bytes)"),
                }),
                error: None,
            },
            Err(error) => ProbeRunResult {
                status: ProbeStatus::Fail,
                value: ProbeValue::PortOpen(PortOpenValue {
                    host: self.host.clone(),
                    port: self.port,
                    protocol: self.protocol,
                    open: false,
                    detail: String::new(),
                }),
                error: Some(error.to_string()),
            },
        }
    }
}

#[derive(Clone)]
struct K8sPodStateProbe {
    namespace: String,
    selector: String,
    desired_state: DesiredPodState,
    client: Client,
}

impl K8sPodStateProbe {
    async fn run(&self) -> ProbeRunResult {
        let api: Api<Pod> = Api::namespaced(self.client.clone(), &self.namespace);
        let params = ListParams::default().labels(&self.selector);

        let list_result = api.list(&params).await;
        let pods = match list_result {
            Ok(value) => value,
            Err(error) => {
                return ProbeRunResult {
                    status: ProbeStatus::Fail,
                    value: ProbeValue::K8sPodState(K8sPodStateValue {
                        namespace: self.namespace.clone(),
                        selector: self.selector.clone(),
                        desired_state: self.desired_state.as_str().to_owned(),
                        matched_pods: 0,
                        matching_pod_names: Vec::new(),
                        state_satisfied: false,
                    }),
                    error: Some(error.to_string()),
                };
            }
        };

        let total_pods = saturating_u32(pods.items.len());
        let matching_pod_names = pods
            .items
            .iter()
            .filter(|pod| pod_matches_desired_state(&self.desired_state, pod))
            .map(pod_name)
            .collect::<Vec<_>>();

        let state_satisfied = !matching_pod_names.is_empty();
        let status = if state_satisfied {
            ProbeStatus::Pass
        } else {
            ProbeStatus::Fail
        };

        ProbeRunResult {
            status,
            value: ProbeValue::K8sPodState(K8sPodStateValue {
                namespace: self.namespace.clone(),
                selector: self.selector.clone(),
                desired_state: self.desired_state.as_str().to_owned(),
                matched_pods: total_pods,
                matching_pod_names,
                state_satisfied,
            }),
            error: None,
        }
    }
}

#[derive(Debug, Clone)]
struct CommandJsonPathProbe {
    argv: Vec<String>,
    json_path: String,
    expected: Option<JsonValue>,
}

impl CommandJsonPathProbe {
    async fn run(&self) -> ProbeRunResult {
        let output = match Command::new(&self.argv[0])
            .args(&self.argv[1..])
            .output()
            .await
        {
            Ok(value) => value,
            Err(error) => {
                return ProbeRunResult {
                    status: ProbeStatus::Fail,
                    value: ProbeValue::CommandJsonPath(self.value(
                        String::new(),
                        String::new(),
                        -1,
                    )),
                    error: Some(error.to_string()),
                };
            }
        };

        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        let exit_code = output.status.code().unwrap_or(-1);
        let mut value = self.value(stdout.clone(), stderr.clone(), exit_code);

        if !output.status.success() {
            return ProbeRunResult {
                status: ProbeStatus::Fail,
                value: ProbeValue::CommandJsonPath(value),
                error: Some(format!("command exited with status {}", output.status)),
            };
        }

        let json = match serde_json::from_slice::<JsonValue>(&output.stdout) {
            Ok(value) => value,
            Err(error) => {
                return ProbeRunResult {
                    status: ProbeStatus::Fail,
                    value: ProbeValue::CommandJsonPath(value),
                    error: Some(format!("failed to parse stdout as JSON: {error}")),
                };
            }
        };

        let matches = match json.query(&self.json_path) {
            Ok(value) => value,
            Err(error) => {
                return ProbeRunResult {
                    status: ProbeStatus::Fail,
                    value: ProbeValue::CommandJsonPath(value),
                    error: Some(format!(
                        "failed to evaluate json_path '{}': {error}",
                        self.json_path
                    )),
                };
            }
        };

        value.matched_values = matches
            .iter()
            .map(|matched| json_value_string(matched))
            .collect::<Vec<_>>();
        value.matched = if let Some(expected) = &self.expected {
            matches.contains(&expected)
        } else {
            !matches.is_empty()
        };

        let status = if value.matched {
            ProbeStatus::Pass
        } else {
            ProbeStatus::Fail
        };

        ProbeRunResult {
            status,
            value: ProbeValue::CommandJsonPath(value),
            error: None,
        }
    }

    fn value(&self, stdout: String, stderr: String, exit_code: i32) -> CommandJsonPathValue {
        CommandJsonPathValue {
            argv: self.argv.clone(),
            json_path: self.json_path.clone(),
            expected_json: self
                .expected
                .as_ref()
                .map_or_else(String::new, json_value_string),
            matched: false,
            matched_values: Vec::new(),
            stdout,
            stderr,
            exit_code,
        }
    }
}

#[derive(Debug, Clone)]
struct ServiceProbe {
    service: String,
    state: ServiceState,
}

impl ServiceProbe {
    async fn run(&self) -> ProbeRunResult {
        let mut command = Command::new("systemctl");
        match self.state {
            ServiceState::Running | ServiceState::Stopped => {
                command.args(["is-active", &self.service]);
            }
            ServiceState::Enabled | ServiceState::Disabled => {
                command.args(["is-enabled", &self.service]);
            }
        }

        let output = match command.output().await {
            Ok(value) => value,
            Err(error) => {
                return ProbeRunResult {
                    status: ProbeStatus::Fail,
                    value: ProbeValue::Service(self.value(String::new(), false)),
                    error: Some(error.to_string()),
                };
            }
        };

        let status = output.status.success();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let actual_state = if stdout.is_empty() { stderr } else { stdout };

        let state_satisfied = match self.state {
            ServiceState::Running | ServiceState::Enabled => status,
            ServiceState::Stopped | ServiceState::Disabled => !status,
        };

        ProbeRunResult {
            status: if state_satisfied {
                ProbeStatus::Pass
            } else {
                ProbeStatus::Fail
            },
            value: ProbeValue::Service(self.value(actual_state, state_satisfied)),
            error: None,
        }
    }

    fn value(&self, actual_state: String, state_satisfied: bool) -> ServiceValue {
        ServiceValue {
            service: self.service.clone(),
            desired_state: self.state.as_str().to_owned(),
            actual_state,
            state_satisfied,
        }
    }
}

fn pod_matches_desired_state(desired_state: &DesiredPodState, pod: &Pod) -> bool {
    match desired_state {
        DesiredPodState::Phase(expected_phase) => pod_matches_phase(*expected_phase, pod),
        DesiredPodState::Condition(expected_condition) => {
            pod_matches_condition(*expected_condition, pod)
        }
    }
}

fn pod_matches_phase(expected_phase: PodPhase, pod: &Pod) -> bool {
    let expected = match expected_phase {
        PodPhase::Pending => "Pending",
        PodPhase::Running => "Running",
        PodPhase::Succeeded => "Succeeded",
        PodPhase::Failed => "Failed",
        PodPhase::Unknown => "Unknown",
    };

    pod.status
        .as_ref()
        .and_then(|status| status.phase.as_ref())
        .is_some_and(|phase| phase == expected)
}

fn pod_matches_condition(expected_condition: PodCondition, pod: &Pod) -> bool {
    let expected = match expected_condition {
        PodCondition::Ready => "Ready",
        PodCondition::ContainersReady => "ContainersReady",
        PodCondition::Initialized => "Initialized",
        PodCondition::PodScheduled => "PodScheduled",
    };

    pod.status
        .as_ref()
        .and_then(|status| status.conditions.as_ref())
        .is_some_and(|conditions| {
            conditions
                .iter()
                .any(|condition| condition.type_ == expected && condition.status == "True")
        })
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn json_value_string(value: &JsonValue) -> String {
    value.to_string()
}

fn pod_name(pod: &Pod) -> String {
    pod.metadata
        .name
        .clone()
        .unwrap_or_else(|| "<unknown-pod-name>".to_owned())
}

fn saturating_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

pub(crate) async fn build_probes(
    configs: &[ProbeConfig],
) -> Result<Vec<ProbeDefinition>, ProbeBuildError> {
    let mut probes = Vec::with_capacity(configs.len());

    for config in configs {
        let probe = match &config.kind {
            ProbeKindConfig::FileExists { path } => ProbeDefinition {
                id: config.id.clone(),
                kind: ProbeKind::FileExists,
                every: config.every,
                timeout: config.timeout,
                runner: ProbeRunner::FileExists(FileExistsProbe { path: path.clone() }),
            },
            ProbeKindConfig::FileRegexCapture { path, pattern } => {
                let regex =
                    Regex::new(pattern).map_err(|source| ProbeBuildError::InvalidRegex {
                        probe_id: config.id.clone(),
                        pattern: pattern.clone(),
                        source,
                    })?;

                ProbeDefinition {
                    id: config.id.clone(),
                    kind: ProbeKind::FileRegexCapture,
                    every: config.every,
                    timeout: config.timeout,
                    runner: ProbeRunner::FileRegexCapture(FileRegexCaptureProbe {
                        path: path.clone(),
                        pattern: pattern.clone(),
                        regex,
                    }),
                }
            }
            ProbeKindConfig::PortOpen {
                host,
                port,
                protocol,
            } => ProbeDefinition {
                id: config.id.clone(),
                kind: ProbeKind::PortOpen,
                every: config.every,
                timeout: config.timeout,
                runner: ProbeRunner::PortOpen(PortOpenProbe {
                    host: host.clone(),
                    port: *port,
                    protocol: *protocol,
                }),
            },
            ProbeKindConfig::K8sPodState {
                namespace,
                selector,
                desired_state,
                kubeconfig,
                kube_context,
            } => {
                let client = kube_client(&config.id, kubeconfig, kube_context.as_deref()).await?;

                ProbeDefinition {
                    id: config.id.clone(),
                    kind: ProbeKind::K8sPodState,
                    every: config.every,
                    timeout: config.timeout,
                    runner: ProbeRunner::K8sPodState(K8sPodStateProbe {
                        namespace: namespace.clone(),
                        selector: selector.clone(),
                        desired_state: desired_state.clone(),
                        client,
                    }),
                }
            }
            ProbeKindConfig::CommandJsonPath {
                argv,
                json_path,
                expected,
            } => ProbeDefinition {
                id: config.id.clone(),
                kind: ProbeKind::CommandJsonPath,
                every: config.every,
                timeout: config.timeout,
                runner: ProbeRunner::CommandJsonPath(CommandJsonPathProbe {
                    argv: argv.clone(),
                    json_path: json_path.clone(),
                    expected: expected.clone(),
                }),
            },
            ProbeKindConfig::Service { service, state } => ProbeDefinition {
                id: config.id.clone(),
                kind: ProbeKind::Service,
                every: config.every,
                timeout: config.timeout,
                runner: ProbeRunner::Service(ServiceProbe {
                    service: service.clone(),
                    state: *state,
                }),
            },
        };

        probes.push(probe);
    }

    Ok(probes)
}

async fn kube_client(
    probe_id: &str,
    kubeconfig_path: &Path,
    context: Option<&str>,
) -> Result<Client, ProbeBuildError> {
    let kubeconfig = Kubeconfig::read_from(kubeconfig_path).map_err(|source| {
        ProbeBuildError::ReadKubeconfig {
            probe_id: probe_id.to_owned(),
            path: kubeconfig_path.to_string_lossy().into_owned(),
            source,
        }
    })?;

    let options = KubeConfigOptions {
        context: context.map(ToOwned::to_owned),
        ..KubeConfigOptions::default()
    };

    let client_config = KubeClientConfig::from_custom_kubeconfig(kubeconfig, &options)
        .await
        .map_err(|source| ProbeBuildError::BuildKubeConfig {
            probe_id: probe_id.to_owned(),
            source,
        })?;

    Client::try_from(client_config).map_err(|source| ProbeBuildError::BuildKubeClient {
        probe_id: probe_id.to_owned(),
        source,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        CommandJsonPathProbe, FileRegexCaptureProbe, PortOpenProbe, ProbeStatus, ProbeValue,
        pod_matches_condition, pod_matches_phase,
    };
    use crate::config::{PodCondition, PodPhase, PortProtocol};
    use k8s_openapi::api::core::v1::{Pod, PodCondition as K8sPodCondition, PodStatus};
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
    use serde_json::json;
    use std::fs;

    #[tokio::test]
    async fn regex_probe_captures_multiline_content() {
        let temp = tempfile::tempdir();
        assert!(temp.is_ok());
        let dir = match temp {
            Ok(value) => value,
            Err(error) => panic!("failed to create tempdir: {error}"),
        };

        let file_path = dir.path().join("config.txt");
        let write_result = fs::write(&file_path, "first line\nvalue=abc123\nthird line\n");
        assert!(write_result.is_ok());

        let regex = regex::Regex::new(r"value=(\w+)");
        assert!(regex.is_ok());
        let compiled = match regex {
            Ok(value) => value,
            Err(error) => panic!("failed to compile regex: {error}"),
        };

        let probe = FileRegexCaptureProbe {
            path: file_path,
            pattern: "value=(\\w+)".to_owned(),
            regex: compiled,
        };

        let result = probe.run().await;
        assert_eq!(result.status, ProbeStatus::Pass);

        match result.value {
            ProbeValue::FileRegexCapture(value) => {
                assert!(value.matched);
                assert_eq!(value.full_match, "value=abc123");
                assert_eq!(value.captures, vec!["abc123".to_owned()]);
                assert!(value.file_content.contains("first line"));
            }
            _ => panic!("unexpected probe value type"),
        }
    }

    #[tokio::test]
    async fn tcp_port_probe_passes_when_listener_is_available() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await;
        assert!(listener.is_ok());
        let tcp_listener = match listener {
            Ok(value) => value,
            Err(error) => panic!("failed to bind tcp listener: {error}"),
        };

        let local_addr = tcp_listener.local_addr();
        assert!(local_addr.is_ok());
        let port = match local_addr {
            Ok(value) => value.port(),
            Err(error) => panic!("failed to read tcp listener addr: {error}"),
        };

        let probe = PortOpenProbe {
            host: "127.0.0.1".to_owned(),
            port,
            protocol: PortProtocol::Tcp,
        };

        let result = probe.run().await;
        assert_eq!(result.status, ProbeStatus::Pass);

        match result.value {
            ProbeValue::PortOpen(value) => {
                assert!(value.open);
                assert_eq!(value.port, port);
            }
            _ => panic!("unexpected probe value type"),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn command_json_path_probe_matches_expected_value() {
        let temp = tempfile::tempdir();
        assert!(temp.is_ok());
        let dir = match temp {
            Ok(value) => value,
            Err(error) => panic!("failed to create tempdir: {error}"),
        };

        let file_path = dir.path().join("netbird-status.json");
        let write_result = fs::write(
            &file_path,
            r#"{"peers":{"connected":1},"sshServer":{"enabled":true}}"#,
        );
        assert!(write_result.is_ok());

        let probe = CommandJsonPathProbe {
            argv: vec![
                "/bin/cat".to_owned(),
                file_path.to_string_lossy().into_owned(),
            ],
            json_path: "$.sshServer.enabled".to_owned(),
            expected: Some(json!(true)),
        };

        let result = probe.run().await;
        assert_eq!(result.status, ProbeStatus::Pass);

        match result.value {
            ProbeValue::CommandJsonPath(value) => {
                assert!(value.matched);
                assert_eq!(value.matched_values, vec!["true".to_owned()]);
                assert_eq!(value.expected_json, "true");
            }
            _ => panic!("unexpected probe value type"),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn command_json_path_probe_passes_when_path_exists() {
        let temp = tempfile::tempdir();
        assert!(temp.is_ok());
        let dir = match temp {
            Ok(value) => value,
            Err(error) => panic!("failed to create tempdir: {error}"),
        };

        let file_path = dir.path().join("netbird-status.json");
        let write_result = fs::write(
            &file_path,
            r#"{"sshServer":{"sessions":[{"remoteAddress":"10.48.162.109:39148"}]}}"#,
        );
        assert!(write_result.is_ok());

        let probe = CommandJsonPathProbe {
            argv: vec![
                "/bin/cat".to_owned(),
                file_path.to_string_lossy().into_owned(),
            ],
            json_path: "$.sshServer.sessions[*].remoteAddress".to_owned(),
            expected: None,
        };

        let result = probe.run().await;
        assert_eq!(result.status, ProbeStatus::Pass);

        match result.value {
            ProbeValue::CommandJsonPath(value) => {
                assert!(value.matched);
                assert_eq!(
                    value.matched_values,
                    vec!["\"10.48.162.109:39148\"".to_owned()]
                );
            }
            _ => panic!("unexpected probe value type"),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn command_json_path_probe_fails_when_expected_value_is_missing() {
        let temp = tempfile::tempdir();
        assert!(temp.is_ok());
        let dir = match temp {
            Ok(value) => value,
            Err(error) => panic!("failed to create tempdir: {error}"),
        };

        let file_path = dir.path().join("netbird-status.json");
        let write_result = fs::write(&file_path, r#"{"sshServer":{"enabled":false}}"#);
        assert!(write_result.is_ok());

        let probe = CommandJsonPathProbe {
            argv: vec![
                "/bin/cat".to_owned(),
                file_path.to_string_lossy().into_owned(),
            ],
            json_path: "$.sshServer.enabled".to_owned(),
            expected: Some(json!(true)),
        };

        let result = probe.run().await;
        assert_eq!(result.status, ProbeStatus::Fail);
        assert!(result.error.is_none());

        match result.value {
            ProbeValue::CommandJsonPath(value) => {
                assert!(!value.matched);
                assert_eq!(value.matched_values, vec!["false".to_owned()]);
                assert_eq!(value.expected_json, "true");
            }
            _ => panic!("unexpected probe value type"),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn command_json_path_probe_fails_when_stdout_is_not_json() {
        let temp = tempfile::tempdir();
        assert!(temp.is_ok());
        let dir = match temp {
            Ok(value) => value,
            Err(error) => panic!("failed to create tempdir: {error}"),
        };

        let file_path = dir.path().join("not-json.txt");
        let write_result = fs::write(&file_path, "definitely not json");
        assert!(write_result.is_ok());

        let probe = CommandJsonPathProbe {
            argv: vec![
                "/bin/cat".to_owned(),
                file_path.to_string_lossy().into_owned(),
            ],
            json_path: "$.sshServer.enabled".to_owned(),
            expected: Some(json!(true)),
        };

        let result = probe.run().await;
        assert_eq!(result.status, ProbeStatus::Fail);
        assert!(
            result
                .error
                .as_deref()
                .is_some_and(|error| error.contains("failed to parse stdout as JSON"))
        );

        match result.value {
            ProbeValue::CommandJsonPath(value) => {
                assert!(!value.matched);
                assert_eq!(value.stdout, "definitely not json");
                assert_eq!(value.exit_code, 0);
            }
            _ => panic!("unexpected probe value type"),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn command_json_path_probe_fails_when_command_exits_non_zero() {
        let probe = CommandJsonPathProbe {
            argv: vec![
                "/bin/sh".to_owned(),
                "-c".to_owned(),
                "printf '{\"sshServer\":{\"enabled\":true}}'; exit 7".to_owned(),
            ],
            json_path: "$.sshServer.enabled".to_owned(),
            expected: Some(json!(true)),
        };

        let result = probe.run().await;
        assert_eq!(result.status, ProbeStatus::Fail);
        assert!(
            result
                .error
                .as_deref()
                .is_some_and(|error| error.contains("command exited with status"))
        );

        match result.value {
            ProbeValue::CommandJsonPath(value) => {
                assert!(!value.matched);
                assert_eq!(value.stdout, "{\"sshServer\":{\"enabled\":true}}");
                assert_eq!(value.exit_code, 7);
            }
            _ => panic!("unexpected probe value type"),
        }
    }

    #[test]
    fn phase_match_uses_pod_status_phase() {
        let pod = Pod {
            metadata: ObjectMeta {
                name: Some("api-0".to_owned()),
                ..ObjectMeta::default()
            },
            status: Some(PodStatus {
                phase: Some("Running".to_owned()),
                ..PodStatus::default()
            }),
            ..Pod::default()
        };

        assert!(pod_matches_phase(PodPhase::Running, &pod));
        assert!(!pod_matches_phase(PodPhase::Succeeded, &pod));
    }

    #[test]
    fn condition_match_checks_true_condition() {
        let pod = Pod {
            metadata: ObjectMeta {
                name: Some("api-0".to_owned()),
                ..ObjectMeta::default()
            },
            status: Some(PodStatus {
                conditions: Some(vec![K8sPodCondition {
                    type_: "Ready".to_owned(),
                    status: "True".to_owned(),
                    ..K8sPodCondition::default()
                }]),
                ..PodStatus::default()
            }),
            ..Pod::default()
        };

        assert!(pod_matches_condition(PodCondition::Ready, &pod));
        assert!(!pod_matches_condition(PodCondition::Initialized, &pod));
    }
}
