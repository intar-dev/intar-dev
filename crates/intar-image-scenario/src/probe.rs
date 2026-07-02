#![allow(clippy::missing_errors_doc)]

use crate::ScenarioError;
use crate::scenario::ProbePhase;
use jsonpath_rust::parser::parse_json_path;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::HashMap;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct KinoDefinition {
    pub defaults: KinoDefaults,
    pub probes: HashMap<String, KinoProbeDefinition>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct KinoDefaults {
    pub every_seconds: Option<u64>,
    pub timeout_seconds: Option<u64>,
}

impl KinoDefaults {
    pub fn validate(&self) -> Result<(), ScenarioError> {
        validate_default_timing(self.every_seconds, "kino.defaults.every_seconds")?;
        validate_default_timing(self.timeout_seconds, "kino.defaults.timeout_seconds")?;
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KinoProbeKind {
    FileExists,
    FileRegexCapture,
    PortOpen,
    K8sPodState,
    CommandJsonPath,
    Service,
}

impl KinoProbeKind {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FileExists => "file_exists",
            Self::FileRegexCapture => "file_regex_capture",
            Self::PortOpen => "port_open",
            Self::K8sPodState => "k8s_pod_state",
            Self::CommandJsonPath => "command_json_path",
            Self::Service => "service",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PortProtocol {
    Tcp,
    Udp,
}

impl PortProtocol {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Tcp => "tcp",
            Self::Udp => "udp",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ServiceState {
    Running,
    Stopped,
    Enabled,
    Disabled,
}

impl ServiceState {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Stopped => "stopped",
            Self::Enabled => "enabled",
            Self::Disabled => "disabled",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct KinoProbeDefinition {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub phase: ProbePhase,
    pub config: KinoProbeConfig,
}

impl KinoProbeDefinition {
    pub fn from_definition(
        probe_name: &str,
        config: &HashMap<String, JsonValue>,
        description: Option<String>,
        phase: ProbePhase,
    ) -> Result<Self, ScenarioError> {
        let parsed = serde_json::from_value::<KinoProbeConfig>(serde_json::Value::Object(
            config
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
        ))
        .map_err(|error| ScenarioError::InvalidProbeConfig {
            probe: probe_name.to_string(),
            message: error.to_string(),
        })?;

        Ok(Self {
            name: probe_name.to_string(),
            description,
            phase,
            config: parsed,
        })
    }

    pub fn validate(&self) -> Result<(), ScenarioError> {
        self.config.validate(&self.name)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum KinoProbeConfig {
    FileExists {
        path: String,
        #[serde(default)]
        every_seconds: Option<u64>,
        #[serde(default)]
        timeout_seconds: Option<u64>,
    },
    FileRegexCapture {
        path: String,
        pattern: String,
        #[serde(default)]
        every_seconds: Option<u64>,
        #[serde(default)]
        timeout_seconds: Option<u64>,
    },
    PortOpen {
        host: String,
        port: u16,
        protocol: PortProtocol,
        #[serde(default)]
        every_seconds: Option<u64>,
        #[serde(default)]
        timeout_seconds: Option<u64>,
    },
    Service {
        service: String,
        state: ServiceState,
        #[serde(default)]
        every_seconds: Option<u64>,
        #[serde(default)]
        timeout_seconds: Option<u64>,
    },
    K8sPodState {
        namespace: String,
        selector: String,
        desired_state: String,
        #[serde(default)]
        kubeconfig: Option<String>,
        #[serde(default)]
        kube_context: Option<String>,
        #[serde(default)]
        every_seconds: Option<u64>,
        #[serde(default)]
        timeout_seconds: Option<u64>,
    },
    CommandJsonPath {
        argv: Vec<String>,
        json_path: String,
        #[serde(default)]
        expected: Option<JsonValue>,
        #[serde(default)]
        every_seconds: Option<u64>,
        #[serde(default)]
        timeout_seconds: Option<u64>,
    },
}

impl KinoProbeConfig {
    #[must_use]
    pub fn kind(&self) -> KinoProbeKind {
        match self {
            Self::FileExists { .. } => KinoProbeKind::FileExists,
            Self::FileRegexCapture { .. } => KinoProbeKind::FileRegexCapture,
            Self::PortOpen { .. } => KinoProbeKind::PortOpen,
            Self::Service { .. } => KinoProbeKind::Service,
            Self::K8sPodState { .. } => KinoProbeKind::K8sPodState,
            Self::CommandJsonPath { .. } => KinoProbeKind::CommandJsonPath,
        }
    }

    #[must_use]
    pub fn every_seconds(&self) -> Option<u64> {
        match self {
            Self::FileExists { every_seconds, .. }
            | Self::FileRegexCapture { every_seconds, .. }
            | Self::PortOpen { every_seconds, .. }
            | Self::Service { every_seconds, .. }
            | Self::K8sPodState { every_seconds, .. }
            | Self::CommandJsonPath { every_seconds, .. } => *every_seconds,
        }
    }

    #[must_use]
    pub fn timeout_seconds(&self) -> Option<u64> {
        match self {
            Self::FileExists {
                timeout_seconds, ..
            }
            | Self::FileRegexCapture {
                timeout_seconds, ..
            }
            | Self::PortOpen {
                timeout_seconds, ..
            }
            | Self::Service {
                timeout_seconds, ..
            }
            | Self::K8sPodState {
                timeout_seconds, ..
            }
            | Self::CommandJsonPath {
                timeout_seconds, ..
            } => *timeout_seconds,
        }
    }

    pub fn validate(&self, probe_name: &str) -> Result<(), ScenarioError> {
        validate_probe_timing(self.every_seconds(), probe_name, "every_seconds")?;
        validate_probe_timing(self.timeout_seconds(), probe_name, "timeout_seconds")?;

        match self {
            Self::FileExists { path, .. } => validate_non_empty_str(path, probe_name, "path"),
            Self::FileRegexCapture { path, pattern, .. } => {
                validate_non_empty_str(path, probe_name, "path")?;
                validate_non_empty_str(pattern, probe_name, "pattern")
            }
            Self::PortOpen { host, .. } => validate_non_empty_str(host, probe_name, "host"),
            Self::Service { service, .. } => validate_non_empty_str(service, probe_name, "service"),
            Self::K8sPodState {
                namespace,
                selector,
                desired_state,
                kubeconfig,
                kube_context,
                ..
            } => {
                validate_non_empty_str(namespace, probe_name, "namespace")?;
                validate_non_empty_str(selector, probe_name, "selector")?;
                validate_desired_state(desired_state, probe_name)?;
                if let Some(kubeconfig) = kubeconfig {
                    validate_non_empty_str(kubeconfig, probe_name, "kubeconfig")?;
                }
                if let Some(kube_context) = kube_context {
                    validate_non_empty_str(kube_context, probe_name, "kube_context")?;
                }
                Ok(())
            }
            Self::CommandJsonPath {
                argv, json_path, ..
            } => {
                validate_command_argv(argv, probe_name)?;
                validate_json_path(json_path, probe_name)
            }
        }
    }
}

fn validate_default_timing(value: Option<u64>, context: &str) -> Result<(), ScenarioError> {
    if value == Some(0) {
        return Err(ScenarioError::InvalidKinoDefaults {
            message: format!("{context} must be greater than 0"),
        });
    }
    Ok(())
}

fn validate_probe_timing(
    value: Option<u64>,
    probe_name: &str,
    field: &str,
) -> Result<(), ScenarioError> {
    if value == Some(0) {
        return Err(ScenarioError::InvalidProbeConfig {
            probe: probe_name.to_string(),
            message: format!("{field} must be greater than 0"),
        });
    }
    Ok(())
}

fn validate_non_empty_str(value: &str, probe_name: &str, field: &str) -> Result<(), ScenarioError> {
    if value.trim().is_empty() {
        return Err(ScenarioError::InvalidProbeConfig {
            probe: probe_name.to_string(),
            message: format!("requires non-empty {field}"),
        });
    }
    Ok(())
}

fn validate_command_argv(argv: &[String], probe_name: &str) -> Result<(), ScenarioError> {
    if argv.is_empty() {
        return Err(ScenarioError::InvalidProbeConfig {
            probe: probe_name.to_string(),
            message: "kind 'command_json_path' requires argv".to_string(),
        });
    }

    if argv.iter().any(|item| item.trim().is_empty()) {
        return Err(ScenarioError::InvalidProbeConfig {
            probe: probe_name.to_string(),
            message: "kind 'command_json_path' has an empty argv item".to_string(),
        });
    }

    Ok(())
}

fn validate_json_path(json_path: &str, probe_name: &str) -> Result<(), ScenarioError> {
    if json_path.trim().is_empty() {
        return Err(ScenarioError::InvalidProbeConfig {
            probe: probe_name.to_string(),
            message: "kind 'command_json_path' requires json_path".to_string(),
        });
    }

    parse_json_path(json_path).map_err(|error| ScenarioError::InvalidProbeConfig {
        probe: probe_name.to_string(),
        message: format!("kind 'command_json_path' has invalid json_path '{json_path}': {error}"),
    })?;

    Ok(())
}

fn validate_desired_state(value: &str, probe_name: &str) -> Result<(), ScenarioError> {
    let Some((kind, raw)) = value.split_once(':') else {
        return Err(ScenarioError::InvalidProbeConfig {
            probe: probe_name.to_string(),
            message: format!("desired_state '{value}' must use '<phase|condition>:<value>'"),
        });
    };

    match kind {
        "phase" => {
            if !matches!(
                raw,
                "Pending" | "Running" | "Succeeded" | "Failed" | "Unknown"
            ) {
                return Err(ScenarioError::InvalidProbeConfig {
                    probe: probe_name.to_string(),
                    message: format!("desired_state '{value}' uses unknown phase '{raw}'"),
                });
            }
        }
        "condition" => {
            if !matches!(
                raw,
                "Ready" | "ContainersReady" | "Initialized" | "PodScheduled"
            ) {
                return Err(ScenarioError::InvalidProbeConfig {
                    probe: probe_name.to_string(),
                    message: format!("desired_state '{value}' uses unknown condition '{raw}'"),
                });
            }
        }
        other => {
            return Err(ScenarioError::InvalidProbeConfig {
                probe: probe_name.to_string(),
                message: format!("desired_state '{value}' uses unknown prefix '{other}'"),
            });
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    #[test]
    fn parses_service_probe_from_definition() {
        let mut config = HashMap::new();
        config.insert("kind".to_string(), JsonValue::String("service".to_string()));
        config.insert(
            "service".to_string(),
            JsonValue::String("nginx".to_string()),
        );
        config.insert(
            "state".to_string(),
            JsonValue::String("running".to_string()),
        );

        let probe =
            KinoProbeDefinition::from_definition("nginx-running", &config, None, ProbePhase::Boot)
                .unwrap();
        assert!(matches!(probe.config, KinoProbeConfig::Service { .. }));
        assert_eq!(probe.config.kind(), KinoProbeKind::Service);
    }

    #[test]
    fn parses_command_json_path_probe_from_definition() {
        let mut config = HashMap::new();
        config.insert(
            "kind".to_string(),
            JsonValue::String("command_json_path".to_string()),
        );
        config.insert(
            "argv".to_string(),
            JsonValue::Array(vec![
                JsonValue::String("systemctl".to_string()),
                JsonValue::String("show".to_string()),
                JsonValue::String("nginx".to_string()),
            ]),
        );
        config.insert(
            "json_path".to_string(),
            JsonValue::String("$.ActiveState".to_string()),
        );

        let probe =
            KinoProbeDefinition::from_definition("service-state", &config, None, ProbePhase::Boot)
                .unwrap();
        probe.validate().unwrap();
        assert!(matches!(
            probe.config,
            KinoProbeConfig::CommandJsonPath { .. }
        ));
    }
}
