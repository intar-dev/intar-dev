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

/// `intar check` can wait for one scheduled execution and then perform one
/// fresh execution. Keeping an individual probe at or below 120 seconds keeps
/// that bounded pair inside Kino's 300-second local control deadline.
pub(crate) const MAX_MANUAL_PROBE_TIMEOUT_SECONDS: u64 = 120;

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
    pub(crate) intar: IntarProbeMetadata,
    pub(crate) kind: ProbeKindConfig,
}

/// Metadata written by Intar's image generators. It is deliberately optional:
/// Kino still accepts older images, while newer control-plane clients can use
/// this data to select learner-visible probes without deriving labels from a
/// raw probe ID.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct IntarProbeMetadata {
    pub(crate) alias: Option<String>,
    pub(crate) label: Option<String>,
    pub(crate) phase: Option<IntarProbePhase>,
    pub(crate) module: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum IntarProbePhase {
    Boot,
    Scenario,
    Workshop,
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
        intar_alias: Option<String>,
        intar_label: Option<String>,
        intar_phase: Option<String>,
        intar_module: Option<String>,
    },
    FileRegexCapture {
        path: PathBuf,
        pattern: String,
        every_seconds: Option<u64>,
        timeout_seconds: Option<u64>,
        intar_alias: Option<String>,
        intar_label: Option<String>,
        intar_phase: Option<String>,
        intar_module: Option<String>,
    },
    PortOpen {
        host: String,
        port: u16,
        protocol: PortProtocol,
        every_seconds: Option<u64>,
        timeout_seconds: Option<u64>,
        intar_alias: Option<String>,
        intar_label: Option<String>,
        intar_phase: Option<String>,
        intar_module: Option<String>,
    },
    Service {
        service: String,
        state: ServiceState,
        every_seconds: Option<u64>,
        timeout_seconds: Option<u64>,
        intar_alias: Option<String>,
        intar_label: Option<String>,
        intar_phase: Option<String>,
        intar_module: Option<String>,
    },
    K8sPodState {
        namespace: String,
        selector: String,
        desired_state: String,
        kubeconfig: Option<PathBuf>,
        kube_context: Option<String>,
        every_seconds: Option<u64>,
        timeout_seconds: Option<u64>,
        intar_alias: Option<String>,
        intar_label: Option<String>,
        intar_phase: Option<String>,
        intar_module: Option<String>,
    },
    CommandJsonPath {
        argv: Vec<String>,
        json_path: String,
        expected: Option<JsonValue>,
        every_seconds: Option<u64>,
        timeout_seconds: Option<u64>,
        intar_alias: Option<String>,
        intar_label: Option<String>,
        intar_phase: Option<String>,
        intar_module: Option<String>,
    },
}

#[derive(Clone, Debug, Default)]
struct RawIntarProbeMetadata {
    alias: Option<String>,
    label: Option<String>,
    phase: Option<String>,
    module: Option<String>,
}

impl RawProbe {
    fn intar_metadata(&self) -> RawIntarProbeMetadata {
        match self {
            Self::FileExists {
                intar_alias,
                intar_label,
                intar_phase,
                intar_module,
                ..
            }
            | Self::FileRegexCapture {
                intar_alias,
                intar_label,
                intar_phase,
                intar_module,
                ..
            }
            | Self::PortOpen {
                intar_alias,
                intar_label,
                intar_phase,
                intar_module,
                ..
            }
            | Self::Service {
                intar_alias,
                intar_label,
                intar_phase,
                intar_module,
                ..
            }
            | Self::K8sPodState {
                intar_alias,
                intar_label,
                intar_phase,
                intar_module,
                ..
            }
            | Self::CommandJsonPath {
                intar_alias,
                intar_label,
                intar_phase,
                intar_module,
                ..
            } => RawIntarProbeMetadata {
                alias: intar_alias.clone(),
                label: intar_label.clone(),
                phase: intar_phase.clone(),
                module: intar_module.clone(),
            },
        }
    }
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
    if timeout_seconds.get() > MAX_MANUAL_PROBE_TIMEOUT_SECONDS {
        return Err(ConfigError::Validation {
            message: format!(
                "defaults.timeout_seconds must be at most {MAX_MANUAL_PROBE_TIMEOUT_SECONDS} so a fresh Intar check can complete"
            ),
        });
    }

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
    let intar = build_intar_probe_metadata(&id, raw_probe.intar_metadata())?;
    let (every, timeout, kind) = match raw_probe {
        RawProbe::FileExists {
            path,
            every_seconds,
            timeout_seconds,
            ..
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
            ..
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
            ..
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
            ..
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
            ..
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
            ..
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
        intar,
        kind,
    })
}

fn build_intar_probe_metadata(
    probe_id: &str,
    raw: RawIntarProbeMetadata,
) -> Result<IntarProbeMetadata, ConfigError> {
    let alias = raw
        .alias
        .map(|value| validate_intar_alias(probe_id, value))
        .transpose()?;
    let label = raw
        .label
        .map(|value| validate_intar_label(probe_id, "intar_label", value))
        .transpose()?;
    let module = raw
        .module
        .map(|value| validate_intar_identifier(probe_id, "intar_module", value))
        .transpose()?;
    let phase = raw
        .phase
        .map(|value| parse_intar_phase(probe_id, value))
        .transpose()?;

    if module.is_some() && phase.is_some_and(|phase| phase != IntarProbePhase::Workshop) {
        return Err(ConfigError::Validation {
            message: format!(
                "probe '{probe_id}' has intar_module but intar_phase is not 'workshop'"
            ),
        });
    }

    Ok(IntarProbeMetadata {
        alias,
        label,
        phase,
        module,
    })
}

fn validate_intar_identifier(
    probe_id: &str,
    field: &str,
    value: String,
) -> Result<String, ConfigError> {
    let valid = !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')
        });
    if valid {
        Ok(value)
    } else {
        Err(ConfigError::Validation {
            message: format!(
                "probe '{probe_id}' has invalid {field}; use 1-64 lowercase letters, digits, '-' or '_', starting with a letter or digit"
            ),
        })
    }
}

fn validate_intar_alias(probe_id: &str, value: String) -> Result<String, ConfigError> {
    let valid = !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    if valid {
        Ok(value)
    } else {
        Err(ConfigError::Validation {
            message: format!(
                "probe '{probe_id}' has invalid intar_alias; use 1-128 lowercase letters, digits or '-', starting with a letter or digit"
            ),
        })
    }
}

fn validate_intar_label(probe_id: &str, field: &str, value: String) -> Result<String, ConfigError> {
    let has_terminal_controls = value.chars().any(|character| {
        character.is_control()
            || matches!(
                character,
                '\u{061c}'
                    | '\u{200e}'
                    | '\u{200f}'
                    | '\u{202a}'..='\u{202e}'
                    | '\u{2066}'..='\u{2069}'
            )
    });
    if value.trim().is_empty() || value.chars().count() > 160 || has_terminal_controls {
        return Err(ConfigError::Validation {
            message: format!(
                "probe '{probe_id}' has invalid {field}; it must be a visible string of at most 160 characters"
            ),
        });
    }
    Ok(value)
}

fn parse_intar_phase(probe_id: &str, value: String) -> Result<IntarProbePhase, ConfigError> {
    match value.as_str() {
        "boot" => Ok(IntarProbePhase::Boot),
        "scenario" => Ok(IntarProbePhase::Scenario),
        "workshop" => Ok(IntarProbePhase::Workshop),
        _ => Err(ConfigError::Validation {
            message: format!(
                "probe '{probe_id}' has invalid intar_phase '{value}'; supported: boot, scenario, workshop"
            ),
        }),
    }
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

    if non_zero.get() > MAX_MANUAL_PROBE_TIMEOUT_SECONDS {
        return Err(ConfigError::Validation {
            message: format!(
                "probe '{probe_id}' has timeout_seconds = {}; maximum is {MAX_MANUAL_PROBE_TIMEOUT_SECONDS} so a fresh Intar check can complete",
                non_zero.get()
            ),
        });
    }

    Ok(Duration::from_secs(non_zero.get()))
}

#[cfg(test)]
mod tests;
