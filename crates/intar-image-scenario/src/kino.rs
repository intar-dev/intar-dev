#![allow(clippy::missing_errors_doc)]

use crate::{
    KinoProbeConfig, KinoProbeDefinition, KinoProbeKind, ProbePhase, Scenario, ScenarioError,
    VmDefinition,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const KINO_VSOCK_CID_PLACEHOLDER: &str = "__INTAR_KINO_CID__";
pub const KINO_VSOCK_PORT_PLACEHOLDER: &str = "__INTAR_KINO_PORT__";
pub const KINO_DEFAULT_EVERY_SECONDS: u64 = 5;
pub const KINO_DEFAULT_TIMEOUT_SECONDS: u64 = 2;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KinoProbeDescriptor {
    pub id: String,
    pub source_probe: String,
    /// Stable learner-facing alias. Raw Kino probe IDs remain an internal
    /// transport detail so the guest CLI never needs to print them.
    pub intar_alias: String,
    pub label: String,
    pub kind: KinoProbeKind,
    pub phase: ProbePhase,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DerivedKinoConfig {
    pub vm_name: String,
    pub config_hcl: String,
    pub probe_phase_map: HashMap<String, ProbePhase>,
    pub probe_descriptors: Vec<KinoProbeDescriptor>,
}

impl Scenario {
    pub fn derive_kino_config_for_vm(
        &self,
        vm_name: &str,
    ) -> Result<DerivedKinoConfig, ScenarioError> {
        let vm = self
            .vms
            .iter()
            .find(|vm| vm.name == vm_name)
            .ok_or_else(|| ScenarioError::VmNotFound(vm_name.to_string()))?;
        self.derive_kino_config(vm)
    }

    pub fn derive_kino_config(
        &self,
        vm: &VmDefinition,
    ) -> Result<DerivedKinoConfig, ScenarioError> {
        let effective_every = self
            .kino
            .defaults
            .every_seconds
            .unwrap_or(KINO_DEFAULT_EVERY_SECONDS);
        let effective_timeout = self
            .kino
            .defaults
            .timeout_seconds
            .unwrap_or(KINO_DEFAULT_TIMEOUT_SECONDS);

        let mut lines = vec![
            "server {".to_string(),
            format!(
                "  bind = {}",
                hcl_string(&format!(
                    "vsock://{KINO_VSOCK_CID_PLACEHOLDER}:{KINO_VSOCK_PORT_PLACEHOLDER}"
                ))
            ),
            "}".to_string(),
            String::new(),
            "defaults {".to_string(),
            format!("  every_seconds = {effective_every}"),
            format!("  timeout_seconds = {effective_timeout}"),
            "}".to_string(),
            String::new(),
        ];

        let mut probe_phase_map = HashMap::new();
        let mut probe_descriptors = Vec::new();

        for (index, probe_name) in vm.probes.iter().enumerate() {
            let definition = self
                .kino
                .probes
                .get(probe_name)
                .ok_or_else(|| ScenarioError::ProbeNotFound(probe_name.clone()))?;
            let intar_alias = format!("check-{}", index + 1);
            probe_phase_map.insert(definition.name.clone(), definition.phase);
            probe_descriptors.push(KinoProbeDescriptor {
                id: definition.name.clone(),
                source_probe: definition.name.clone(),
                intar_alias: intar_alias.clone(),
                label: definition
                    .description
                    .clone()
                    .unwrap_or_else(|| definition.name.clone()),
                kind: definition.config.kind(),
                phase: definition.phase,
            });

            render_probe_block(&mut lines, definition, &intar_alias);
        }

        Ok(DerivedKinoConfig {
            vm_name: vm.name.clone(),
            config_hcl: format!("{}\n", lines.join("\n").trim_end()),
            probe_phase_map,
            probe_descriptors,
        })
    }
}

fn render_probe_block(
    lines: &mut Vec<String>,
    definition: &KinoProbeDefinition,
    intar_alias: &str,
) {
    lines.push(format!("probe {} {{", hcl_string(&definition.name)));
    lines.push(format!(
        "  kind = {}",
        hcl_string(definition.config.kind().as_str())
    ));
    // These fields are intentionally generated rather than authored. Kino
    // exposes only this bounded metadata to the run CLI, which keeps raw
    // probe IDs and scenario authoring-only text out of learner output.
    lines.push(format!("  intar_alias = {}", hcl_string(intar_alias)));
    lines.push(format!(
        "  intar_label = {}",
        hcl_string(
            definition
                .description
                .as_deref()
                .unwrap_or(definition.name.as_str())
        )
    ));
    lines.push(format!(
        "  intar_phase = {}",
        hcl_string(definition.phase.as_str())
    ));

    match &definition.config {
        KinoProbeConfig::FileExists {
            path,
            every_seconds,
            timeout_seconds,
        } => {
            lines.push(format!("  path = {}", hcl_string(path)));
            push_timing(lines, *every_seconds, *timeout_seconds);
        }
        KinoProbeConfig::FileRegexCapture {
            path,
            pattern,
            every_seconds,
            timeout_seconds,
        } => {
            lines.push(format!("  path = {}", hcl_string(path)));
            lines.push(format!("  pattern = {}", hcl_string(pattern)));
            push_timing(lines, *every_seconds, *timeout_seconds);
        }
        KinoProbeConfig::PortOpen {
            host,
            port,
            protocol,
            every_seconds,
            timeout_seconds,
        } => {
            lines.push(format!("  host = {}", hcl_string(host)));
            lines.push(format!("  port = {port}"));
            lines.push(format!("  protocol = {}", hcl_string(protocol.as_str())));
            push_timing(lines, *every_seconds, *timeout_seconds);
        }
        KinoProbeConfig::Service {
            service,
            state,
            every_seconds,
            timeout_seconds,
        } => {
            lines.push(format!("  service = {}", hcl_string(service)));
            lines.push(format!("  state = {}", hcl_string(state.as_str())));
            push_timing(lines, *every_seconds, *timeout_seconds);
        }
        KinoProbeConfig::K8sPodState {
            namespace,
            selector,
            desired_state,
            kubeconfig,
            kube_context,
            every_seconds,
            timeout_seconds,
        } => {
            lines.push(format!("  namespace = {}", hcl_string(namespace)));
            lines.push(format!("  selector = {}", hcl_string(selector)));
            lines.push(format!("  desired_state = {}", hcl_string(desired_state)));
            if let Some(kubeconfig) = kubeconfig {
                lines.push(format!("  kubeconfig = {}", hcl_string(kubeconfig)));
            }
            if let Some(kube_context) = kube_context {
                lines.push(format!("  kube_context = {}", hcl_string(kube_context)));
            }
            push_timing(lines, *every_seconds, *timeout_seconds);
        }
        KinoProbeConfig::CommandJsonPath {
            argv,
            json_path,
            expected,
            every_seconds,
            timeout_seconds,
        } => {
            lines.push(format!("  argv = {}", hcl_json(argv)));
            lines.push(format!("  json_path = {}", hcl_string(json_path)));
            if let Some(expected) = expected {
                lines.push(format!("  expected = {}", hcl_json(expected)));
            }
            push_timing(lines, *every_seconds, *timeout_seconds);
        }
    }

    lines.push("}".to_string());
    lines.push(String::new());
}

fn push_timing(lines: &mut Vec<String>, every_seconds: Option<u64>, timeout_seconds: Option<u64>) {
    if let Some(every_seconds) = every_seconds {
        lines.push(format!("  every_seconds = {every_seconds}"));
    }
    if let Some(timeout_seconds) = timeout_seconds {
        lines.push(format!("  timeout_seconds = {timeout_seconds}"));
    }
}

fn hcl_string(value: &str) -> String {
    serde_json::to_string(value).expect("string serialization cannot fail")
}

fn hcl_json<T>(value: &T) -> String
where
    T: Serialize,
{
    serde_json::to_string(value).expect("json serialization cannot fail")
}
