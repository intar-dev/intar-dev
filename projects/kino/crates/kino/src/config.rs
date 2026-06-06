use jsonpath_rust::parser::parse_json_path;
use serde::Deserialize;
use serde_json::Value as JsonValue;
use std::collections::BTreeMap;
use std::fs;
use std::net::SocketAddr;
use std::num::NonZeroU64;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::Duration;
use thiserror::Error;

#[derive(Debug, Clone)]
pub(crate) struct AppConfig {
    pub(crate) server_bind: ServerBind,
    pub(crate) recording: Option<RecordingConfig>,
    pub(crate) probes: Vec<ProbeConfig>,
}

#[derive(Debug, Clone)]
pub(crate) enum ServerBind {
    Tcp(SocketAddr),
    Unix(PathBuf),
    Vsock { cid: u32, port: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RecordingConfig {
    pub(crate) output_dir: PathBuf,
    pub(crate) real_shell: PathBuf,
}

#[derive(Debug, Clone)]
pub(crate) struct ProbeConfig {
    pub(crate) id: String,
    pub(crate) every: Duration,
    pub(crate) timeout: Duration,
    pub(crate) kind: ProbeKindConfig,
}

#[derive(Debug, Clone)]
pub(crate) enum ProbeKindConfig {
    FileExists {
        path: PathBuf,
    },
    FileRegexCapture {
        path: PathBuf,
        pattern: String,
    },
    PortOpen {
        host: String,
        port: u16,
        protocol: PortProtocol,
    },
    K8sPodState {
        namespace: String,
        selector: String,
        desired_state: DesiredPodState,
        kubeconfig: PathBuf,
        kube_context: Option<String>,
    },
    CommandJsonPath {
        argv: Vec<String>,
        json_path: String,
        expected: Option<JsonValue>,
    },
    Service {
        service: String,
        state: ServiceState,
    },
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PortProtocol {
    Tcp,
    Udp,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ServiceState {
    Running,
    Stopped,
    Enabled,
    Disabled,
}

impl ServiceState {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Stopped => "stopped",
            Self::Enabled => "enabled",
            Self::Disabled => "disabled",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DesiredPodState {
    Phase(PodPhase),
    Condition(PodCondition),
}

impl DesiredPodState {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Phase(phase) => phase.as_str(),
            Self::Condition(condition) => condition.as_str(),
        }
    }
}

impl FromStr for DesiredPodState {
    type Err = DesiredPodStateParseError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let Some((kind, raw)) = value.split_once(':') else {
            return Err(DesiredPodStateParseError::MissingPrefix {
                value: value.to_owned(),
            });
        };

        match kind {
            "phase" => PodPhase::from_str(raw).map(Self::Phase),
            "condition" => PodCondition::from_str(raw).map(Self::Condition),
            _ => Err(DesiredPodStateParseError::UnknownPrefix {
                prefix: kind.to_owned(),
                value: value.to_owned(),
            }),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PodPhase {
    Pending,
    Running,
    Succeeded,
    Failed,
    Unknown,
}

impl PodPhase {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "phase:Pending",
            Self::Running => "phase:Running",
            Self::Succeeded => "phase:Succeeded",
            Self::Failed => "phase:Failed",
            Self::Unknown => "phase:Unknown",
        }
    }
}

impl FromStr for PodPhase {
    type Err = DesiredPodStateParseError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "Pending" => Ok(Self::Pending),
            "Running" => Ok(Self::Running),
            "Succeeded" => Ok(Self::Succeeded),
            "Failed" => Ok(Self::Failed),
            "Unknown" => Ok(Self::Unknown),
            _ => Err(DesiredPodStateParseError::UnknownPhase {
                value: value.to_owned(),
            }),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PodCondition {
    Ready,
    ContainersReady,
    Initialized,
    PodScheduled,
}

impl PodCondition {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "condition:Ready",
            Self::ContainersReady => "condition:ContainersReady",
            Self::Initialized => "condition:Initialized",
            Self::PodScheduled => "condition:PodScheduled",
        }
    }
}

impl FromStr for PodCondition {
    type Err = DesiredPodStateParseError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "Ready" => Ok(Self::Ready),
            "ContainersReady" => Ok(Self::ContainersReady),
            "Initialized" => Ok(Self::Initialized),
            "PodScheduled" => Ok(Self::PodScheduled),
            _ => Err(DesiredPodStateParseError::UnknownCondition {
                value: value.to_owned(),
            }),
        }
    }
}

#[derive(Debug, Error)]
pub(crate) enum ConfigError {
    #[error("failed to read config file '{path}': {source}")]
    ReadFile {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to parse HCL config: {source}")]
    ParseHcl { source: hcl::Error },
    #[error("invalid config: {message}")]
    Validation { message: String },
}

#[derive(Debug, Error)]
pub(crate) enum DesiredPodStateParseError {
    #[error("desired_state '{value}' must use '<phase|condition>:<value>'")]
    MissingPrefix { value: String },
    #[error("desired_state '{value}' uses unknown prefix '{prefix}'")]
    UnknownPrefix { prefix: String, value: String },
    #[error("unknown phase value '{value}'")]
    UnknownPhase { value: String },
    #[error("unknown condition value '{value}'")]
    UnknownCondition { value: String },
}

#[derive(Debug, Deserialize)]
struct RawConfig {
    server: RawServer,
    defaults: Option<RawDefaults>,
    recording: Option<RawRecording>,
    #[serde(default)]
    probe: BTreeMap<String, RawProbe>,
}

#[derive(Debug, Deserialize)]
struct RawServer {
    bind: String,
}

#[derive(Debug, Deserialize, Default)]
struct RawDefaults {
    every_seconds: Option<u64>,
    timeout_seconds: Option<u64>,
    kubeconfig: Option<PathBuf>,
    kube_context: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawRecording {
    output_dir: PathBuf,
    real_shell: Option<PathBuf>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum RawProbe {
    FileExists {
        path: PathBuf,
        every_seconds: Option<u64>,
        timeout_seconds: Option<u64>,
    },
    FileRegexCapture {
        path: PathBuf,
        pattern: String,
        every_seconds: Option<u64>,
        timeout_seconds: Option<u64>,
    },
    PortOpen {
        host: String,
        port: u16,
        protocol: PortProtocol,
        every_seconds: Option<u64>,
        timeout_seconds: Option<u64>,
    },
    Service {
        service: String,
        state: ServiceState,
        every_seconds: Option<u64>,
        timeout_seconds: Option<u64>,
    },
    K8sPodState {
        namespace: String,
        selector: String,
        desired_state: String,
        kubeconfig: Option<PathBuf>,
        kube_context: Option<String>,
        every_seconds: Option<u64>,
        timeout_seconds: Option<u64>,
    },
    CommandJsonPath {
        argv: Vec<String>,
        json_path: String,
        expected: Option<JsonValue>,
        every_seconds: Option<u64>,
        timeout_seconds: Option<u64>,
    },
}

#[derive(Debug, Clone)]
struct EffectiveDefaults {
    every_seconds: NonZeroU64,
    timeout_seconds: NonZeroU64,
    kubeconfig: Option<PathBuf>,
    kube_context: Option<String>,
}

pub(crate) fn load_from_file(path: &Path) -> Result<AppConfig, ConfigError> {
    let content = fs::read_to_string(path).map_err(|source| ConfigError::ReadFile {
        path: path.to_path_buf(),
        source,
    })?;

    let raw: RawConfig =
        hcl::from_str(&content).map_err(|source| ConfigError::ParseHcl { source })?;

    let defaults = normalize_defaults(raw.defaults)?;
    let server_bind = resolve_server_bind(&raw.server)?;
    let recording = raw.recording.map(build_recording_config).transpose()?;

    let probes = raw
        .probe
        .into_iter()
        .map(|(id, raw_probe)| build_probe_config(id, raw_probe, &defaults))
        .collect::<Result<Vec<_>, _>>()?;

    Ok(AppConfig {
        server_bind,
        recording,
        probes,
    })
}

fn resolve_server_bind(raw_server: &RawServer) -> Result<ServerBind, ConfigError> {
    parse_server_bind_uri(&raw_server.bind)
}

fn parse_server_bind_uri(value: &str) -> Result<ServerBind, ConfigError> {
    let (scheme, address) = value.split_once("://").ok_or_else(|| ConfigError::Validation {
        message: format!(
            "server.bind '{value}' must use one of: tcp://<ip:port>, unix://<absolute-path>, vsock://<cid>:<port>"
        ),
    })?;

    match scheme {
        "tcp" => {
            let addr = address
                .parse::<SocketAddr>()
                .map_err(|error| ConfigError::Validation {
                    message: format!(
                        "server.bind '{value}' has invalid tcp address '{address}': {error}"
                    ),
                })?;
            Ok(ServerBind::Tcp(addr))
        }
        "unix" => {
            let path = PathBuf::from(address);
            if address.is_empty() || !path.is_absolute() {
                return Err(ConfigError::Validation {
                    message: format!(
                        "server.bind '{value}' has invalid unix path; use unix://<absolute-path>"
                    ),
                });
            }

            Ok(ServerBind::Unix(path))
        }
        "vsock" => {
            let (cid, port) = address
                .split_once(':')
                .ok_or_else(|| ConfigError::Validation {
                    message: format!(
                        "server.bind '{value}' has invalid vsock format; use vsock://<cid>:<port>"
                    ),
                })?;

            let parsed_cid = cid
                .parse::<u32>()
                .map_err(|error| ConfigError::Validation {
                    message: format!(
                        "server.bind '{value}' has invalid vsock cid '{cid}': {error}"
                    ),
                })?;
            let parsed_port = port
                .parse::<u32>()
                .map_err(|error| ConfigError::Validation {
                    message: format!(
                        "server.bind '{value}' has invalid vsock port '{port}': {error}"
                    ),
                })?;

            Ok(ServerBind::Vsock {
                cid: parsed_cid,
                port: parsed_port,
            })
        }
        _ => Err(ConfigError::Validation {
            message: format!(
                "server.bind '{value}' uses unsupported scheme '{scheme}'; supported: tcp, unix, vsock"
            ),
        }),
    }
}

fn normalize_defaults(raw_defaults: Option<RawDefaults>) -> Result<EffectiveDefaults, ConfigError> {
    let defaults = raw_defaults.unwrap_or_default();

    let every_seconds = non_zero_or_default(defaults.every_seconds, 5, "defaults.every_seconds")?;
    let timeout_seconds =
        non_zero_or_default(defaults.timeout_seconds, 2, "defaults.timeout_seconds")?;

    Ok(EffectiveDefaults {
        every_seconds,
        timeout_seconds,
        kubeconfig: defaults.kubeconfig,
        kube_context: defaults.kube_context,
    })
}

fn non_zero_or_default(
    value: Option<u64>,
    default: u64,
    field: &str,
) -> Result<NonZeroU64, ConfigError> {
    let selected = value.unwrap_or(default);

    NonZeroU64::new(selected).ok_or_else(|| ConfigError::Validation {
        message: format!("{field} must be greater than 0"),
    })
}

fn build_recording_config(raw_recording: RawRecording) -> Result<RecordingConfig, ConfigError> {
    if !raw_recording.output_dir.is_absolute() {
        return Err(ConfigError::Validation {
            message: format!(
                "recording.output_dir '{}' must be an absolute path",
                raw_recording.output_dir.display()
            ),
        });
    }

    let real_shell = raw_recording
        .real_shell
        .unwrap_or_else(|| PathBuf::from("/bin/bash"));

    if real_shell.as_os_str().is_empty() {
        return Err(ConfigError::Validation {
            message: "recording.real_shell must not be empty".to_owned(),
        });
    }

    Ok(RecordingConfig {
        output_dir: raw_recording.output_dir,
        real_shell,
    })
}

struct K8sPodStateArgs {
    namespace: String,
    selector: String,
    desired_state: String,
    kubeconfig: Option<PathBuf>,
    kube_context: Option<String>,
    every_seconds: Option<u64>,
    timeout_seconds: Option<u64>,
}

struct CommandJsonPathArgs {
    argv: Vec<String>,
    json_path: String,
    expected: Option<JsonValue>,
    every_seconds: Option<u64>,
    timeout_seconds: Option<u64>,
}

fn build_probe_config(
    id: String,
    raw_probe: RawProbe,
    defaults: &EffectiveDefaults,
) -> Result<ProbeConfig, ConfigError> {
    let (every, timeout, kind) = match raw_probe {
        RawProbe::FileExists {
            path,
            every_seconds,
            timeout_seconds,
        } => {
            let (every, timeout) =
                resolve_probe_timing(every_seconds, timeout_seconds, defaults, &id)?;
            let kind = ProbeKindConfig::FileExists { path };
            (every, timeout, kind)
        }
        RawProbe::FileRegexCapture {
            path,
            pattern,
            every_seconds,
            timeout_seconds,
        } => {
            let (every, timeout) =
                resolve_probe_timing(every_seconds, timeout_seconds, defaults, &id)?;
            let kind = ProbeKindConfig::FileRegexCapture { path, pattern };
            (every, timeout, kind)
        }
        RawProbe::PortOpen {
            host,
            port,
            protocol,
            every_seconds,
            timeout_seconds,
        } => {
            let (every, timeout) =
                resolve_probe_timing(every_seconds, timeout_seconds, defaults, &id)?;
            let kind = ProbeKindConfig::PortOpen {
                host,
                port,
                protocol,
            };
            (every, timeout, kind)
        }
        RawProbe::Service {
            service,
            state,
            every_seconds,
            timeout_seconds,
        } => {
            let (every, timeout) =
                resolve_probe_timing(every_seconds, timeout_seconds, defaults, &id)?;
            let kind = ProbeKindConfig::Service { service, state };
            (every, timeout, kind)
        }
        RawProbe::K8sPodState {
            namespace,
            selector,
            desired_state,
            kubeconfig,
            kube_context,
            every_seconds,
            timeout_seconds,
        } => build_k8s_pod_state_probe(
            &id,
            defaults,
            K8sPodStateArgs {
                namespace,
                selector,
                desired_state,
                kubeconfig,
                kube_context,
                every_seconds,
                timeout_seconds,
            },
        )?,
        RawProbe::CommandJsonPath {
            argv,
            json_path,
            expected,
            every_seconds,
            timeout_seconds,
        } => build_command_json_path_probe(
            &id,
            defaults,
            CommandJsonPathArgs {
                argv,
                json_path,
                expected,
                every_seconds,
                timeout_seconds,
            },
        )?,
    };

    Ok(ProbeConfig {
        id,
        every,
        timeout,
        kind,
    })
}

fn resolve_probe_timing(
    every_seconds: Option<u64>,
    timeout_seconds: Option<u64>,
    defaults: &EffectiveDefaults,
    probe_id: &str,
) -> Result<(Duration, Duration), ConfigError> {
    let every = every_or_default(every_seconds, defaults.every_seconds, probe_id)?;
    let timeout = timeout_or_default(timeout_seconds, defaults.timeout_seconds, probe_id)?;
    Ok((every, timeout))
}

fn build_k8s_pod_state_probe(
    probe_id: &str,
    defaults: &EffectiveDefaults,
    args: K8sPodStateArgs,
) -> Result<(Duration, Duration, ProbeKindConfig), ConfigError> {
    let (every, timeout) =
        resolve_probe_timing(args.every_seconds, args.timeout_seconds, defaults, probe_id)?;

    let parsed_desired_state = DesiredPodState::from_str(&args.desired_state).map_err(|error| {
        ConfigError::Validation {
            message: format!("probe '{probe_id}' has invalid desired_state: {error}"),
        }
    })?;

    let resolved_kubeconfig = args
        .kubeconfig
        .or_else(|| defaults.kubeconfig.clone())
        .ok_or_else(|| ConfigError::Validation {
            message: format!(
                "probe '{probe_id}' is kind 'k8s_pod_state' but no kubeconfig is set (probe.kubeconfig or defaults.kubeconfig)"
            ),
        })?;

    let kind = ProbeKindConfig::K8sPodState {
        namespace: args.namespace,
        selector: args.selector,
        desired_state: parsed_desired_state,
        kubeconfig: resolved_kubeconfig,
        kube_context: args.kube_context.or_else(|| defaults.kube_context.clone()),
    };

    Ok((every, timeout, kind))
}

fn build_command_json_path_probe(
    probe_id: &str,
    defaults: &EffectiveDefaults,
    args: CommandJsonPathArgs,
) -> Result<(Duration, Duration, ProbeKindConfig), ConfigError> {
    let (every, timeout) =
        resolve_probe_timing(args.every_seconds, args.timeout_seconds, defaults, probe_id)?;
    validate_command_argv(&args.argv, probe_id)?;
    validate_json_path(&args.json_path, probe_id)?;

    let kind = ProbeKindConfig::CommandJsonPath {
        argv: args.argv,
        json_path: args.json_path,
        expected: args.expected,
    };

    Ok((every, timeout, kind))
}

fn every_or_default(
    value: Option<u64>,
    default: NonZeroU64,
    probe_id: &str,
) -> Result<Duration, ConfigError> {
    let every = value.unwrap_or_else(|| default.get());
    let non_zero = NonZeroU64::new(every).ok_or_else(|| ConfigError::Validation {
        message: format!("probe '{probe_id}' has every_seconds = 0"),
    })?;

    Ok(Duration::from_secs(non_zero.get()))
}

fn validate_command_argv(argv: &[String], probe_id: &str) -> Result<(), ConfigError> {
    if argv.is_empty() {
        return Err(ConfigError::Validation {
            message: format!("probe '{probe_id}' kind 'command_json_path' requires argv"),
        });
    }

    if argv.iter().any(String::is_empty) {
        return Err(ConfigError::Validation {
            message: format!("probe '{probe_id}' kind 'command_json_path' has an empty argv item"),
        });
    }

    Ok(())
}

fn validate_json_path(json_path: &str, probe_id: &str) -> Result<(), ConfigError> {
    if json_path.trim().is_empty() {
        return Err(ConfigError::Validation {
            message: format!("probe '{probe_id}' kind 'command_json_path' requires json_path"),
        });
    }

    parse_json_path(json_path).map_err(|error| ConfigError::Validation {
        message: format!(
            "probe '{probe_id}' kind 'command_json_path' has invalid json_path '{json_path}': {error}"
        ),
    })?;

    Ok(())
}

fn timeout_or_default(
    value: Option<u64>,
    default: NonZeroU64,
    probe_id: &str,
) -> Result<Duration, ConfigError> {
    let timeout = value.unwrap_or_else(|| default.get());
    let non_zero = NonZeroU64::new(timeout).ok_or_else(|| ConfigError::Validation {
        message: format!("probe '{probe_id}' has timeout_seconds = 0"),
    })?;

    Ok(Duration::from_secs(non_zero.get()))
}

#[cfg(test)]
mod tests {
    use super::{DesiredPodState, ServerBind, load_from_file};
    use std::fs;
    use std::str::FromStr;

    #[test]
    fn parses_probe_blocks_from_hcl() {
        let temp = tempfile::tempdir();
        assert!(temp.is_ok());
        let dir = match temp {
            Ok(value) => value,
            Err(error) => panic!("failed to create tempdir: {error}"),
        };

        let config_path = dir.path().join("kino.hcl");
        let hcl = r#"
            server {
              bind = "tcp://127.0.0.1:9000"
            }

            defaults {
              every_seconds = 5
              timeout_seconds = 2
              kubeconfig = "/tmp/kubeconfig"
            }

            recording {
              output_dir = "/tmp/kino-recordings"
              real_shell = "/bin/sh"
            }

            probe "hosts" {
              kind = "file_exists"
              path = "/etc/hosts"
            }

            probe "ssh" {
              kind = "port_open"
              host = "127.0.0.1"
              port = 22
              protocol = "tcp"
            }

            probe "netbird_ssh" {
              kind = "command_json_path"
              argv = ["netbird", "status", "--json"]
              json_path = "$.sshServer.enabled"
              expected = true
            }
        "#;

        let write_result = fs::write(&config_path, hcl);
        assert!(write_result.is_ok());

        let loaded = load_from_file(&config_path);
        assert!(loaded.is_ok());
        let config = match loaded {
            Ok(value) => value,
            Err(error) => panic!("failed to parse config: {error}"),
        };

        match config.server_bind {
            ServerBind::Tcp(addr) => assert_eq!(addr.port(), 9000),
            ServerBind::Unix(path) => panic!("unexpected unix socket binding: {}", path.display()),
            ServerBind::Vsock { cid, port } => {
                panic!("unexpected vsock binding: cid={cid}, port={port}")
            }
        }
        assert_eq!(
            config
                .recording
                .as_ref()
                .map(|recording| recording.output_dir.as_path()),
            Some(std::path::Path::new("/tmp/kino-recordings"))
        );
        assert_eq!(
            config
                .recording
                .as_ref()
                .map(|recording| recording.real_shell.as_path()),
            Some(std::path::Path::new("/bin/sh"))
        );
        assert_eq!(config.probes.len(), 3);
    }

    #[test]
    fn parses_unix_socket_server_binding() {
        let temp = tempfile::tempdir();
        assert!(temp.is_ok());
        let dir = match temp {
            Ok(value) => value,
            Err(error) => panic!("failed to create tempdir: {error}"),
        };

        let socket_path = dir.path().join("kino.sock");
        let config_path = dir.path().join("kino.hcl");
        let hcl = format!(
            r#"
            server {{
              bind = "unix://{}"
            }}
        "#,
            socket_path.display()
        );

        let write_result = fs::write(&config_path, hcl);
        assert!(write_result.is_ok());

        let loaded = load_from_file(&config_path);
        assert!(loaded.is_ok());
        let config = match loaded {
            Ok(value) => value,
            Err(error) => panic!("failed to parse config: {error}"),
        };

        match config.server_bind {
            ServerBind::Unix(path) => assert_eq!(path, socket_path),
            ServerBind::Tcp(addr) => panic!("unexpected tcp binding: {addr}"),
            ServerBind::Vsock { cid, port } => {
                panic!("unexpected vsock binding: cid={cid}, port={port}")
            }
        }
    }

    #[test]
    fn parses_vsock_server_binding() {
        let temp = tempfile::tempdir();
        assert!(temp.is_ok());
        let dir = match temp {
            Ok(value) => value,
            Err(error) => panic!("failed to create tempdir: {error}"),
        };

        let config_path = dir.path().join("kino.hcl");
        let hcl = r#"
            server {
              bind = "vsock://3:8080"
            }
        "#;

        let write_result = fs::write(&config_path, hcl);
        assert!(write_result.is_ok());

        let loaded = load_from_file(&config_path);
        assert!(loaded.is_ok());
        let config = match loaded {
            Ok(value) => value,
            Err(error) => panic!("failed to parse config: {error}"),
        };

        match config.server_bind {
            ServerBind::Vsock { cid, port } => {
                assert_eq!(cid, 3);
                assert_eq!(port, 8080);
            }
            ServerBind::Tcp(addr) => panic!("unexpected tcp binding: {addr}"),
            ServerBind::Unix(path) => panic!("unexpected unix binding: {}", path.display()),
        }
    }

    #[test]
    fn rejects_server_binding_when_missing_bind() {
        let temp = tempfile::tempdir();
        assert!(temp.is_ok());
        let dir = match temp {
            Ok(value) => value,
            Err(error) => panic!("failed to create tempdir: {error}"),
        };

        let config_path = dir.path().join("kino.hcl");
        let hcl = r"
            server {}
        ";

        let write_result = fs::write(&config_path, hcl);
        assert!(write_result.is_ok());

        let loaded = load_from_file(&config_path);
        assert!(loaded.is_err());
    }

    #[test]
    fn rejects_invalid_desired_state_values() {
        let parsed = DesiredPodState::from_str("condition:NotARealState");
        assert!(parsed.is_err());
    }

    #[test]
    fn recording_defaults_real_shell() {
        let temp = tempfile::tempdir();
        assert!(temp.is_ok());
        let dir = match temp {
            Ok(value) => value,
            Err(error) => panic!("failed to create tempdir: {error}"),
        };

        let config_path = dir.path().join("kino.hcl");
        let hcl = r#"
            server {
              bind = "tcp://127.0.0.1:9000"
            }

            recording {
              output_dir = "/tmp/kino-recordings"
            }
        "#;

        let write_result = fs::write(&config_path, hcl);
        assert!(write_result.is_ok());

        let loaded = load_from_file(&config_path);
        assert!(loaded.is_ok());
        let config = match loaded {
            Ok(value) => value,
            Err(error) => panic!("failed to parse config: {error}"),
        };

        assert_eq!(
            config
                .recording
                .as_ref()
                .map(|recording| recording.real_shell.as_path()),
            Some(std::path::Path::new("/bin/bash"))
        );
    }

    #[test]
    fn rejects_relative_recording_output_dir() {
        let temp = tempfile::tempdir();
        assert!(temp.is_ok());
        let dir = match temp {
            Ok(value) => value,
            Err(error) => panic!("failed to create tempdir: {error}"),
        };

        let config_path = dir.path().join("kino.hcl");
        let hcl = r#"
            server {
              bind = "tcp://127.0.0.1:9000"
            }

            recording {
              output_dir = "relative-recordings"
            }
        "#;

        let write_result = fs::write(&config_path, hcl);
        assert!(write_result.is_ok());

        let loaded = load_from_file(&config_path);
        assert!(loaded.is_err());
    }

    #[test]
    fn rejects_command_json_path_without_argv() {
        let temp = tempfile::tempdir();
        assert!(temp.is_ok());
        let dir = match temp {
            Ok(value) => value,
            Err(error) => panic!("failed to create tempdir: {error}"),
        };

        let config_path = dir.path().join("kino.hcl");
        let hcl = r#"
            server {
              bind = "tcp://127.0.0.1:9000"
            }

            probe "netbird" {
              kind = "command_json_path"
              argv = []
              json_path = "$.sshServer.enabled"
              expected = true
            }
        "#;

        let write_result = fs::write(&config_path, hcl);
        assert!(write_result.is_ok());

        let loaded = load_from_file(&config_path);
        assert!(loaded.is_err());
    }

    #[test]
    fn rejects_command_json_path_without_json_path() {
        let temp = tempfile::tempdir();
        assert!(temp.is_ok());
        let dir = match temp {
            Ok(value) => value,
            Err(error) => panic!("failed to create tempdir: {error}"),
        };

        let config_path = dir.path().join("kino.hcl");
        let hcl = r#"
            server {
              bind = "tcp://127.0.0.1:9000"
            }

            probe "netbird" {
              kind = "command_json_path"
              argv = ["netbird", "status", "--json"]
              json_path = "   "
            }
        "#;

        let write_result = fs::write(&config_path, hcl);
        assert!(write_result.is_ok());

        let loaded = load_from_file(&config_path);
        assert!(loaded.is_err());
    }

    #[test]
    fn rejects_command_json_path_with_invalid_json_path() {
        let temp = tempfile::tempdir();
        assert!(temp.is_ok());
        let dir = match temp {
            Ok(value) => value,
            Err(error) => panic!("failed to create tempdir: {error}"),
        };

        let config_path = dir.path().join("kino.hcl");
        let hcl = r#"
            server {
              bind = "tcp://127.0.0.1:9000"
            }

            probe "netbird" {
              kind = "command_json_path"
              argv = ["netbird", "status", "--json"]
              json_path = "$["
            }
        "#;

        let write_result = fs::write(&config_path, hcl);
        assert!(write_result.is_ok());

        let loaded = load_from_file(&config_path);
        assert!(loaded.is_err());
    }
}
