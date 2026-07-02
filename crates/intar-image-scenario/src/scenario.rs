#![allow(clippy::missing_errors_doc)]
#![allow(clippy::missing_panics_doc)]

use crate::{KinoDefaults, KinoDefinition, KinoProbeDefinition, ScenarioError};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;

const INTAR_MANAGED_KINO_PATHS: &[&str] = &[
    "/etc/apt/apt.conf.d/99intar-ephemeral",
    "/etc/cloud/cloud-init.disabled",
    "/etc/kino/kino.hcl.tpl",
    "/etc/kino/ssh-recording.hcl",
    "/etc/ssh/sshd_config.d/90-intar-kino-shell.conf",
    "/etc/systemd/system/intar-scenario.service",
    "/usr/local/bin/intar-bootstrap.sh",
    "/usr/local/bin/intar-scenario-supervisor.sh",
    "/usr/local/bin/kino",
    "/usr/local/bin/kino-shell",
    "/etc/shells",
];

const INTAR_MANAGED_KINO_UNITS: &[&str] = &[
    "intar-scenario",
    "intar-scenario.service",
    "ssh",
    "ssh.service",
    "sshd",
    "sshd.service",
];

const INTAR_ALWAYS_BLOCKED_KINO_COMMANDS: &[&str] = &["usermod", "chsh"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Scenario {
    pub name: String,
    pub category: String,
    pub description: String,
    pub images: HashMap<String, ImageSpec>,
    pub kino: KinoDefinition,
    pub vms: Vec<VmDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageSpec {
    pub name: String,
    pub base: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ProbePhase {
    Boot,
    #[default]
    Scenario,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VmDefinition {
    pub name: String,
    pub cpu: u32,
    pub memory: u32,
    pub disk: u32,
    pub image: String,
    #[serde(default)]
    pub packages: Vec<String>,
    #[serde(default)]
    pub steps: Vec<VmStep>,
    pub probes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VmStep {
    pub name: String,
    pub actions: Vec<VmAction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum VmAction {
    FileDelete {
        path: String,
    },
    FileWrite {
        path: String,
        content: String,
        permissions: Option<String>,
    },
    FileReplace {
        path: String,
        pattern: String,
        replacement: String,
        #[serde(default)]
        regex: bool,
    },
    Systemctl {
        unit: String,
        action: SystemctlAction,
    },
    Command {
        cmd: String,
    },
    K8sApply {
        manifest: String,
        kubeconfig: Option<String>,
    },
    K8sNamespace {
        name: String,
        kubeconfig: Option<String>,
    },
    K8sDeployment {
        name: String,
        namespace: String,
        image: String,
        replicas: u32,
        labels: HashMap<String, String>,
        container_port: u16,
        kubeconfig: Option<String>,
    },
    K8sService {
        name: String,
        namespace: String,
        selector: HashMap<String, String>,
        port: u16,
        target_port: u16,
        kubeconfig: Option<String>,
    },
    K8sScaleDeployment {
        name: String,
        namespace: String,
        replicas: u32,
        kubeconfig: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SystemctlAction {
    Start,
    Stop,
    Restart,
    Enable,
    Disable,
    EnableNow,
}

impl Scenario {
    pub fn from_file(path: &Path) -> Result<Self, ScenarioError> {
        let content = std::fs::read_to_string(path)?;
        Self::parse(&content)
    }

    pub fn parse(content: &str) -> Result<Self, ScenarioError> {
        let body: hcl::Body =
            hcl::from_str(content).map_err(|error| ScenarioError::HclParse(error.to_string()))?;

        let mut scenario_name = String::new();
        let mut category = String::new();
        let mut description = String::new();
        let mut images = HashMap::new();
        let mut kino = KinoDefinition::default();
        let mut vms = Vec::new();

        for block in body.blocks() {
            if block.identifier.as_str() != "scenario" {
                continue;
            }

            scenario_name = block
                .labels
                .first()
                .map(|label| label.as_str().to_string())
                .ok_or_else(|| ScenarioError::InvalidScenario("missing scenario name".into()))?;

            if let Some(attr) = block
                .body
                .attributes()
                .find(|attr| attr.key.as_str() == "category")
            {
                category = extract_string(&attr.expr)?;
            }

            if let Some(attr) = block
                .body
                .attributes()
                .find(|attr| attr.key.as_str() == "description")
            {
                description = extract_string(&attr.expr)?;
            }

            for inner_block in block.body.blocks() {
                match inner_block.identifier.as_str() {
                    "image" => {
                        let image = parse_image(inner_block)?;
                        images.insert(image.name.clone(), image);
                    }
                    "kino" => {
                        kino = parse_kino(inner_block)?;
                    }
                    "vm" => {
                        let vm = parse_vm(inner_block)?;
                        vms.push(vm);
                    }
                    _ => {}
                }
            }
        }

        if scenario_name.is_empty() {
            return Err(ScenarioError::InvalidScenario(
                "no scenario block found".into(),
            ));
        }

        if category.is_empty() {
            return Err(ScenarioError::InvalidScenario(
                "scenario block missing required attribute 'category'".into(),
            ));
        }

        Ok(Self {
            name: scenario_name,
            category,
            description,
            images,
            kino,
            vms,
        })
    }

    pub fn validate(&self) -> Result<(), ScenarioError> {
        for vm in &self.vms {
            if !self.images.contains_key(&vm.image) {
                return Err(ScenarioError::ImageNotFound(vm.image.clone()));
            }
            for probe_name in &vm.probes {
                if !self.kino.probes.contains_key(probe_name) {
                    return Err(ScenarioError::ProbeNotFound(probe_name.clone()));
                }
            }
        }
        Ok(())
    }

    pub fn validate_for_repo(&self) -> Result<(), ScenarioError> {
        self.validate_for_builder_arch("amd64")
    }

    pub fn validate_for_builder_arch(&self, target_arch: &str) -> Result<(), ScenarioError> {
        assert_supported_builder_arch(target_arch)?;
        self.validate()?;

        self.kino.defaults.validate()?;

        for probe in self.kino.probes.values() {
            let description = probe
                .description
                .as_deref()
                .map(str::trim)
                .unwrap_or_default();
            if description.is_empty() {
                return Err(ScenarioError::MissingProbeDescription {
                    probe: probe.name.clone(),
                });
            }
            probe.validate()?;
        }

        for vm in &self.vms {
            for step in &vm.steps {
                for action in &step.actions {
                    validate_vm_action(vm, step, action)?;
                }
            }
        }

        Ok(())
    }

    pub fn validate_for_builder(&self) -> Result<(), ScenarioError> {
        self.validate_for_builder_arch("amd64")
    }

    #[must_use]
    pub fn total_probe_count(&self) -> usize {
        self.vms.iter().map(|vm| vm.probes.len()).sum()
    }

    #[must_use]
    pub fn vm_by_name(&self, vm_name: &str) -> Option<&VmDefinition> {
        self.vms.iter().find(|vm| vm.name == vm_name)
    }

    #[must_use]
    pub fn image_by_name(&self, image_name: &str) -> Option<&ImageSpec> {
        self.images.get(image_name)
    }
}

#[must_use]
pub fn normalize_arch(arch: &str) -> &str {
    match arch {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        other => other,
    }
}

pub fn assert_supported_builder_arch(target_arch: &str) -> Result<&str, ScenarioError> {
    let normalized_arch = normalize_arch(target_arch);
    if normalized_arch != "amd64" {
        return Err(ScenarioError::UnsupportedBuilderArch {
            arch: normalized_arch.to_string(),
        });
    }

    Ok(normalized_arch)
}

#[must_use]
pub fn is_managed_path(path: &str) -> bool {
    let trimmed = path.trim();
    INTAR_MANAGED_KINO_PATHS.contains(&trimmed)
}

#[must_use]
pub fn is_managed_unit(unit: &str) -> bool {
    let normalized = unit.trim().to_lowercase();
    INTAR_MANAGED_KINO_UNITS.contains(&normalized.as_str())
}

#[must_use]
pub fn text_references_managed_assets(value: &str) -> bool {
    let normalized = value.trim().to_lowercase();
    if normalized.is_empty() {
        return false;
    }

    if INTAR_MANAGED_KINO_PATHS
        .iter()
        .any(|item| normalized.contains(&item.to_lowercase()))
    {
        return true;
    }

    if normalized.contains("usermod ") || normalized.contains("chsh ") {
        return true;
    }

    let command_regex = Regex::new(r"\b(?:systemctl|service)\b").expect("regex must compile");
    if !command_regex.is_match(&normalized) {
        return false;
    }

    INTAR_MANAGED_KINO_UNITS.iter().any(|unit| {
        let pattern = format!(r"\b{}\b", regex::escape(unit));
        Regex::new(&pattern)
            .expect("regex must compile")
            .is_match(&normalized)
    })
}

pub fn validate_managed_path(path: &str, context: &str) -> Result<(), ScenarioError> {
    if is_managed_path(path) {
        return Err(ScenarioError::ManagedPath {
            context: context.to_string(),
            path: path.trim().to_string(),
        });
    }
    Ok(())
}

pub fn validate_managed_unit(unit: &str, context: &str) -> Result<(), ScenarioError> {
    if is_managed_unit(unit) {
        return Err(ScenarioError::ManagedUnit {
            context: context.to_string(),
            unit: unit.trim().to_string(),
        });
    }
    Ok(())
}

pub fn validate_managed_command(command: &str, context: &str) -> Result<(), ScenarioError> {
    let normalized = command.trim().to_lowercase();
    if normalized.is_empty() {
        return Ok(());
    }

    let first_token = normalized.split_whitespace().next().unwrap_or_default();
    let blocked = INTAR_ALWAYS_BLOCKED_KINO_COMMANDS.contains(&first_token);

    if blocked || text_references_managed_assets(&normalized) {
        return Err(ScenarioError::ManagedCommand {
            context: context.to_string(),
        });
    }

    Ok(())
}

pub fn validate_managed_text(value: &str, context: &str) -> Result<(), ScenarioError> {
    if text_references_managed_assets(value) {
        return Err(ScenarioError::ManagedText {
            context: context.to_string(),
        });
    }
    Ok(())
}

fn validate_vm_action(
    vm: &VmDefinition,
    step: &VmStep,
    action: &VmAction,
) -> Result<(), ScenarioError> {
    let step_prefix = format!("vm '{}' step '{}'", vm.name, step.name);
    match action {
        VmAction::FileDelete { path } => {
            validate_managed_path(path, &format!("{step_prefix} file_delete path"))?;
        }
        VmAction::FileWrite { path, content, .. } => {
            validate_managed_path(path, &format!("{step_prefix} file_write path"))?;
            validate_managed_text(content, &format!("{step_prefix} file_write content"))?;
        }
        VmAction::FileReplace { path, .. } => {
            validate_managed_path(path, &format!("{step_prefix} file_replace path"))?;
        }
        VmAction::Systemctl { unit, .. } => {
            validate_managed_unit(unit, &format!("{step_prefix} systemctl unit"))?;
        }
        VmAction::Command { cmd } => {
            validate_managed_command(cmd, &format!("{step_prefix} command"))?;
        }
        VmAction::K8sApply { .. }
        | VmAction::K8sNamespace { .. }
        | VmAction::K8sDeployment { .. }
        | VmAction::K8sService { .. }
        | VmAction::K8sScaleDeployment { .. } => {}
    }
    Ok(())
}

fn parse_image(block: &hcl::Block) -> Result<ImageSpec, ScenarioError> {
    let name = block
        .labels
        .first()
        .map(|label| label.as_str().to_string())
        .ok_or_else(|| ScenarioError::InvalidScenario("missing image name".into()))?;
    let mut base = String::new();

    for attr in block.body.attributes() {
        match attr.key.as_str() {
            "base" => base = extract_string(&attr.expr)?,
            other => {
                return Err(ScenarioError::InvalidScenario(format!(
                    "image '{name}' does not support attribute '{other}'"
                )));
            }
        }
    }

    if let Some(inner_block) = block.body.blocks().next() {
        return Err(ScenarioError::InvalidScenario(format!(
            "image '{name}' does not support nested block '{}'; use base-images.hcl for sources",
            inner_block.identifier
        )));
    }

    if base.is_empty() {
        return Err(ScenarioError::InvalidScenario(format!(
            "image '{name}' missing required attribute 'base'"
        )));
    }

    Ok(ImageSpec { name, base })
}

fn parse_kino(block: &hcl::Block) -> Result<KinoDefinition, ScenarioError> {
    if block.body.attributes().next().is_some() {
        return Err(ScenarioError::InvalidScenario(
            "kino block does not support attributes; use nested defaults and probe blocks".into(),
        ));
    }

    let mut defaults = KinoDefaults::default();
    let mut probes = HashMap::new();
    let mut seen_defaults = false;

    for inner_block in block.body.blocks() {
        match inner_block.identifier.as_str() {
            "defaults" => {
                if seen_defaults {
                    return Err(ScenarioError::InvalidScenario(
                        "kino block may only contain one defaults block".into(),
                    ));
                }
                defaults = parse_kino_defaults(inner_block)?;
                seen_defaults = true;
            }
            "probe" => {
                let probe = parse_kino_probe(inner_block)?;
                let probe_name = probe.name.clone();
                if probes.insert(probe_name.clone(), probe).is_some() {
                    return Err(ScenarioError::InvalidScenario(format!(
                        "duplicate kino probe '{probe_name}'"
                    )));
                }
            }
            other => {
                return Err(ScenarioError::InvalidScenario(format!(
                    "unsupported block '{other}' inside kino"
                )));
            }
        }
    }

    Ok(KinoDefinition { defaults, probes })
}

fn parse_kino_defaults(block: &hcl::Block) -> Result<KinoDefaults, ScenarioError> {
    let mut defaults = KinoDefaults::default();

    for attr in block.body.attributes() {
        match attr.key.as_str() {
            "every_seconds" => defaults.every_seconds = Some(extract_u64(&attr.expr)?),
            "timeout_seconds" => defaults.timeout_seconds = Some(extract_u64(&attr.expr)?),
            other => {
                return Err(ScenarioError::InvalidScenario(format!(
                    "kino.defaults does not support attribute '{other}'"
                )));
            }
        }
    }

    if block.body.blocks().next().is_some() {
        return Err(ScenarioError::InvalidScenario(
            "kino.defaults does not support nested blocks".into(),
        ));
    }

    Ok(defaults)
}

fn parse_kino_probe(block: &hcl::Block) -> Result<KinoProbeDefinition, ScenarioError> {
    let name = block
        .labels
        .first()
        .map(|label| label.as_str().to_string())
        .ok_or_else(|| ScenarioError::InvalidScenario("missing kino probe name".into()))?;

    if block.body.blocks().next().is_some() {
        return Err(ScenarioError::InvalidScenario(format!(
            "kino probe '{name}' does not support nested blocks"
        )));
    }

    let mut description = None;
    let mut phase = ProbePhase::Scenario;
    let mut config = HashMap::new();

    for attr in block.body.attributes() {
        match attr.key.as_str() {
            "description" => description = Some(extract_string(&attr.expr)?),
            "phase" => phase = parse_probe_phase(&name, &attr.expr)?,
            _ => {
                config.insert(attr.key.to_string(), expr_to_json(&attr.expr)?);
            }
        }
    }

    KinoProbeDefinition::from_definition(&name, &config, description, phase)
}

fn parse_probe_phase(name: &str, expr: &hcl::Expression) -> Result<ProbePhase, ScenarioError> {
    let value = extract_string(expr)?;
    match value.as_str() {
        "boot" => Ok(ProbePhase::Boot),
        "scenario" => Ok(ProbePhase::Scenario),
        other => Err(ScenarioError::InvalidScenario(format!(
            "probe '{name}' phase must be 'boot' or 'scenario', got '{other}'"
        ))),
    }
}

fn parse_vm(block: &hcl::Block) -> Result<VmDefinition, ScenarioError> {
    let name = block
        .labels
        .first()
        .map(|label| label.as_str().to_string())
        .ok_or_else(|| ScenarioError::InvalidScenario("missing vm name".into()))?;

    let mut cpu: u32 = 1;
    let mut memory: u32 = 1024;
    let mut disk: u32 = 10;
    let mut image = String::new();
    let mut packages = Vec::new();
    let mut steps = Vec::new();
    let mut probes = Vec::new();

    for attr in block.body.attributes() {
        match attr.key.as_str() {
            "cpu" => cpu = extract_u32(&attr.expr)?,
            "memory" => memory = extract_u32(&attr.expr)?,
            "disk" => disk = extract_u32(&attr.expr)?,
            "image" => image = extract_string(&attr.expr)?,
            "packages" => packages = extract_string_array(&attr.expr)?,
            "probes" => probes = extract_string_array(&attr.expr)?,
            _ => {}
        }
    }

    for inner_block in block.body.blocks() {
        match inner_block.identifier.as_str() {
            "step" => steps.push(parse_vm_step(inner_block)?),
            other => {
                return Err(ScenarioError::InvalidScenario(format!(
                    "unsupported block '{other}' in vm '{name}'"
                )));
            }
        }
    }

    let mut seen_step_names = HashSet::new();
    for step in &steps {
        if !seen_step_names.insert(step.name.as_str()) {
            return Err(ScenarioError::InvalidScenario(format!(
                "vm '{name}' has duplicate step '{}'",
                step.name
            )));
        }
    }

    if image.is_empty() {
        return Err(ScenarioError::InvalidScenario(format!(
            "vm '{name}' missing image"
        )));
    }

    if cpu == 0 {
        return Err(ScenarioError::InvalidScenario(format!(
            "vm '{name}' cpu must be > 0"
        )));
    }

    Ok(VmDefinition {
        name,
        cpu,
        memory,
        disk,
        image,
        packages,
        steps,
        probes,
    })
}

fn parse_vm_step(block: &hcl::Block) -> Result<VmStep, ScenarioError> {
    let name = block
        .labels
        .first()
        .map(|label| label.as_str().to_string())
        .ok_or_else(|| ScenarioError::InvalidScenario("step block missing name".into()))?;

    let mut actions = Vec::new();
    for inner_block in block.body.blocks() {
        actions.push(parse_vm_action(inner_block)?);
    }

    if actions.is_empty() {
        return Err(ScenarioError::InvalidScenario(format!(
            "step '{name}' must contain at least one action block"
        )));
    }

    Ok(VmStep { name, actions })
}

fn parse_vm_action(block: &hcl::Block) -> Result<VmAction, ScenarioError> {
    match block.identifier.as_str() {
        "file_delete" => Ok(VmAction::FileDelete {
            path: extract_required_attr_string(block, "path")?,
        }),
        "file_write" => Ok(VmAction::FileWrite {
            path: extract_required_attr_string(block, "path")?,
            content: extract_required_attr_string(block, "content")?,
            permissions: extract_optional_attr_string(block, "permissions")?,
        }),
        "file_replace" => Ok(VmAction::FileReplace {
            path: extract_required_attr_string(block, "path")?,
            pattern: extract_required_attr_string(block, "pattern")?,
            replacement: extract_required_attr_string(block, "replacement")?,
            regex: extract_optional_attr_bool(block, "regex")?.unwrap_or(false),
        }),
        "systemctl" => Ok(VmAction::Systemctl {
            unit: extract_required_attr_string(block, "unit")?,
            action: parse_systemctl_action(&extract_required_attr_string(block, "action")?)?,
        }),
        "command" => Ok(VmAction::Command {
            cmd: extract_required_attr_string(block, "cmd")?,
        }),
        "k8s_apply" => {
            reject_attr(block, "kubectl")?;
            Ok(VmAction::K8sApply {
                manifest: extract_required_attr_string(block, "manifest")?,
                kubeconfig: extract_optional_attr_string(block, "kubeconfig")?,
            })
        }
        "k8s_namespace" => {
            reject_attr(block, "kubectl")?;
            Ok(VmAction::K8sNamespace {
                name: extract_required_attr_string(block, "name")?,
                kubeconfig: extract_optional_attr_string(block, "kubeconfig")?,
            })
        }
        "k8s_deployment" => {
            reject_attr(block, "kubectl")?;
            Ok(VmAction::K8sDeployment {
                name: extract_required_attr_string(block, "name")?,
                namespace: extract_required_attr_string(block, "namespace")?,
                image: extract_required_attr_string(block, "image")?,
                replicas: extract_optional_attr_u32(block, "replicas")?.unwrap_or(1),
                labels: extract_optional_attr_string_map(block, "labels")?.unwrap_or_else(|| {
                    HashMap::from([("app".into(), step_default_app_label(block))])
                }),
                container_port: extract_required_attr_u16(block, "container_port")?,
                kubeconfig: extract_optional_attr_string(block, "kubeconfig")?,
            })
        }
        "k8s_service" => {
            reject_attr(block, "kubectl")?;
            Ok(VmAction::K8sService {
                name: extract_required_attr_string(block, "name")?,
                namespace: extract_required_attr_string(block, "namespace")?,
                selector: extract_required_attr_string_map(block, "selector")?,
                port: extract_required_attr_u16(block, "port")?,
                target_port: extract_optional_attr_u16(block, "target_port")?
                    .unwrap_or(extract_required_attr_u16(block, "port")?),
                kubeconfig: extract_optional_attr_string(block, "kubeconfig")?,
            })
        }
        "k8s_scale_deployment" => {
            reject_attr(block, "kubectl")?;
            Ok(VmAction::K8sScaleDeployment {
                name: extract_required_attr_string(block, "name")?,
                namespace: extract_required_attr_string(block, "namespace")?,
                replicas: extract_required_attr_u32(block, "replicas")?,
                kubeconfig: extract_optional_attr_string(block, "kubeconfig")?,
            })
        }
        other => Err(ScenarioError::InvalidScenario(format!(
            "unknown action '{other}' in step block"
        ))),
    }
}

fn parse_systemctl_action(action: &str) -> Result<SystemctlAction, ScenarioError> {
    match action {
        "start" => Ok(SystemctlAction::Start),
        "stop" => Ok(SystemctlAction::Stop),
        "restart" => Ok(SystemctlAction::Restart),
        "enable" => Ok(SystemctlAction::Enable),
        "disable" => Ok(SystemctlAction::Disable),
        "enable_now" => Ok(SystemctlAction::EnableNow),
        other => Err(ScenarioError::InvalidScenario(format!(
            "unknown systemctl action '{other}' (expected start|stop|restart|enable|disable|enable_now)"
        ))),
    }
}

fn extract_string(expr: &hcl::Expression) -> Result<String, ScenarioError> {
    match expr {
        hcl::Expression::String(value) => Ok(value.clone()),
        hcl::Expression::TemplateExpr(value) => Ok(value.to_string().trim_matches('"').to_string()),
        _ => Err(ScenarioError::InvalidScenario(format!(
            "expected string, got {expr:?}"
        ))),
    }
}

fn extract_bool(expr: &hcl::Expression) -> Result<bool, ScenarioError> {
    match expr {
        hcl::Expression::Bool(value) => Ok(*value),
        _ => Err(ScenarioError::InvalidScenario(format!(
            "expected bool, got {expr:?}"
        ))),
    }
}

fn extract_u32(expr: &hcl::Expression) -> Result<u32, ScenarioError> {
    match expr {
        hcl::Expression::Number(number) => number
            .as_u64()
            .ok_or_else(|| ScenarioError::InvalidScenario("invalid number".into()))
            .and_then(|value| {
                u32::try_from(value)
                    .map_err(|_| ScenarioError::InvalidScenario("invalid number".into()))
            }),
        _ => Err(ScenarioError::InvalidScenario(format!(
            "expected number, got {expr:?}"
        ))),
    }
}

fn extract_u64(expr: &hcl::Expression) -> Result<u64, ScenarioError> {
    match expr {
        hcl::Expression::Number(number) => number
            .as_u64()
            .ok_or_else(|| ScenarioError::InvalidScenario("invalid number".into())),
        _ => Err(ScenarioError::InvalidScenario(format!(
            "expected number, got {expr:?}"
        ))),
    }
}

fn extract_u16(expr: &hcl::Expression) -> Result<u16, ScenarioError> {
    let value = extract_u32(expr)?;
    u16::try_from(value).map_err(|_| ScenarioError::InvalidScenario("invalid number".into()))
}

fn extract_optional_attr_string(
    block: &hcl::Block,
    key: &str,
) -> Result<Option<String>, ScenarioError> {
    block
        .body
        .attributes()
        .find(|attr| attr.key.as_str() == key)
        .map(|attr| extract_string(&attr.expr))
        .transpose()
}

fn reject_attr(block: &hcl::Block, key: &str) -> Result<(), ScenarioError> {
    if block.body.attributes().any(|attr| attr.key.as_str() == key) {
        return Err(ScenarioError::InvalidScenario(format!(
            "{} block does not support attribute '{key}'",
            block.identifier
        )));
    }
    Ok(())
}

fn extract_required_attr_string(block: &hcl::Block, key: &str) -> Result<String, ScenarioError> {
    extract_optional_attr_string(block, key)?.ok_or_else(|| {
        ScenarioError::InvalidScenario(format!(
            "{} block missing required attribute '{key}'",
            block.identifier
        ))
    })
}

fn extract_optional_attr_u32(block: &hcl::Block, key: &str) -> Result<Option<u32>, ScenarioError> {
    block
        .body
        .attributes()
        .find(|attr| attr.key.as_str() == key)
        .map(|attr| extract_u32(&attr.expr))
        .transpose()
}

fn extract_required_attr_u32(block: &hcl::Block, key: &str) -> Result<u32, ScenarioError> {
    extract_optional_attr_u32(block, key)?.ok_or_else(|| {
        ScenarioError::InvalidScenario(format!(
            "{} block missing required attribute '{key}'",
            block.identifier
        ))
    })
}

fn extract_optional_attr_u16(block: &hcl::Block, key: &str) -> Result<Option<u16>, ScenarioError> {
    block
        .body
        .attributes()
        .find(|attr| attr.key.as_str() == key)
        .map(|attr| extract_u16(&attr.expr))
        .transpose()
}

fn extract_required_attr_u16(block: &hcl::Block, key: &str) -> Result<u16, ScenarioError> {
    extract_optional_attr_u16(block, key)?.ok_or_else(|| {
        ScenarioError::InvalidScenario(format!(
            "{} block missing required attribute '{key}'",
            block.identifier
        ))
    })
}

fn extract_optional_attr_bool(
    block: &hcl::Block,
    key: &str,
) -> Result<Option<bool>, ScenarioError> {
    block
        .body
        .attributes()
        .find(|attr| attr.key.as_str() == key)
        .map(|attr| extract_bool(&attr.expr))
        .transpose()
}

fn extract_string_map(expr: &hcl::Expression) -> Result<HashMap<String, String>, ScenarioError> {
    match expr {
        hcl::Expression::Object(object) => object
            .iter()
            .map(|(key, value)| Ok((key.to_string(), extract_string(value)?)))
            .collect(),
        _ => Err(ScenarioError::InvalidScenario(format!(
            "expected object, got {expr:?}"
        ))),
    }
}

fn extract_optional_attr_string_map(
    block: &hcl::Block,
    key: &str,
) -> Result<Option<HashMap<String, String>>, ScenarioError> {
    block
        .body
        .attributes()
        .find(|attr| attr.key.as_str() == key)
        .map(|attr| extract_string_map(&attr.expr))
        .transpose()
}

fn extract_required_attr_string_map(
    block: &hcl::Block,
    key: &str,
) -> Result<HashMap<String, String>, ScenarioError> {
    extract_optional_attr_string_map(block, key)?.ok_or_else(|| {
        ScenarioError::InvalidScenario(format!(
            "{} block missing required attribute '{key}'",
            block.identifier
        ))
    })
}

fn step_default_app_label(block: &hcl::Block) -> String {
    block
        .body
        .attributes()
        .find(|attr| attr.key.as_str() == "name")
        .map_or_else(
            || "app".into(),
            |attr| extract_string(&attr.expr).unwrap_or_else(|_| "app".into()),
        )
}

fn extract_string_array(expr: &hcl::Expression) -> Result<Vec<String>, ScenarioError> {
    match expr {
        hcl::Expression::Array(array) => array.iter().map(extract_string).collect(),
        _ => Err(ScenarioError::InvalidScenario(format!(
            "expected array, got {expr:?}"
        ))),
    }
}

fn expr_to_json(expr: &hcl::Expression) -> Result<serde_json::Value, ScenarioError> {
    match expr {
        hcl::Expression::String(value) => Ok(serde_json::Value::String(value.clone())),
        hcl::Expression::Number(number) => {
            if let Some(integer) = number.as_i64() {
                Ok(serde_json::Value::Number(integer.into()))
            } else if let Some(float) = number.as_f64() {
                Ok(serde_json::json!(float))
            } else {
                Ok(serde_json::Value::Null)
            }
        }
        hcl::Expression::Bool(value) => Ok(serde_json::Value::Bool(*value)),
        hcl::Expression::Array(array) => {
            let values: Result<Vec<_>, _> = array.iter().map(expr_to_json).collect();
            Ok(serde_json::Value::Array(values?))
        }
        hcl::Expression::Object(object) => {
            let mut values = serde_json::Map::new();
            for (key, value) in object {
                values.insert(key.to_string(), expr_to_json(value)?);
            }
            Ok(serde_json::Value::Object(values))
        }
        _ => Ok(serde_json::Value::String(format!("{expr:?}"))),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;
    use crate::{KinoProbeKind, ScenarioError};

    fn supported_hcl() -> &'static str {
        r#"
scenario "broken-nginx" {
  category = "web"
  description = "Fix a misconfigured nginx server"

  image "debian-12-minimal" {
    base = "trixie"
  }

  kino {
    defaults {
      every_seconds = 2
      timeout_seconds = 3
    }

    probe "nginx-running" {
      kind        = "service"
      service     = "nginx"
      state       = "running"
      description = "Nginx should be running"
      phase       = "boot"
    }

    probe "port-80-open" {
      kind            = "port_open"
      host            = "127.0.0.1"
      port            = 80
      protocol        = "tcp"
      description     = "HTTP port 80 should be listening"
      every_seconds   = 5
      timeout_seconds = 1
    }

    probe "default-site-enabled" {
      kind        = "file_exists"
      path        = "/etc/nginx/sites-enabled/default"
      description = "Default site should be enabled"
    }

    probe "ssh-server-enabled" {
      kind        = "command_json_path"
      argv        = ["/usr/bin/env", "python3", "-c", "import json; print(json.dumps({'sshServer': {'enabled': True}}))"]
      json_path   = "$.sshServer.enabled"
      expected    = true
      description = "SSH server should be enabled"
    }

  }

  vm "webserver" {
    cpu    = 1
    memory = 512
    disk   = 2
    image  = "debian-12-minimal"
    packages = ["nginx"]

    step "break-nginx" {
      systemctl {
        unit   = "nginx"
        action = "stop"
      }

      file_delete {
        path = "/etc/nginx/sites-enabled/default"
      }
    }

    probes = ["nginx-running", "port-80-open", "default-site-enabled", "ssh-server-enabled"]
  }
}
"#
    }

    #[test]
    fn parses_and_validates_supported_scenario() {
        let scenario = Scenario::parse(supported_hcl()).unwrap();
        scenario.validate_for_repo().unwrap();

        assert_eq!(scenario.name, "broken-nginx");
        assert_eq!(scenario.category, "web");
        assert_eq!(scenario.total_probe_count(), 4);
        assert_eq!(scenario.images["debian-12-minimal"].base, "trixie");
    }

    #[test]
    fn derives_kino_config_from_vm_probes() {
        let scenario = Scenario::parse(supported_hcl()).unwrap();
        scenario.validate_for_repo().unwrap();

        let kino = scenario.derive_kino_config_for_vm("webserver").unwrap();
        assert!(
            kino.config_hcl
                .contains("bind = \"vsock://__INTAR_KINO_CID__:__INTAR_KINO_PORT__\"")
        );
        assert!(kino.config_hcl.contains("every_seconds = 2"));
        assert!(kino.config_hcl.contains("timeout_seconds = 3"));
        assert!(kino.config_hcl.contains("probe \"nginx-running\""));
        assert!(kino.config_hcl.contains("kind = \"service\""));
        assert!(kino.config_hcl.contains("probe \"port-80-open\""));
        assert!(kino.config_hcl.contains("kind = \"port_open\""));
        assert!(kino.config_hcl.contains("host = \"127.0.0.1\""));
        assert!(kino.config_hcl.contains("kind = \"command_json_path\""));
        assert!(
            kino.config_hcl
                .contains("json_path = \"$.sshServer.enabled\"")
        );
        assert_eq!(kino.probe_descriptors.len(), 4);
        assert_eq!(kino.probe_descriptors[0].kind, KinoProbeKind::Service);
        assert_eq!(
            kino.probe_descriptors[0].label,
            "Nginx should be running".to_string()
        );
        assert_eq!(kino.probe_descriptors[0].phase, ProbePhase::Boot);
    }

    #[test]
    fn errors_on_missing_probe_description() {
        let hcl = r#"
scenario "missing-description" {
  category = "test"
  image "debian-12-minimal" {
    base = "trixie"
  }

  kino {
    probe "nginx-running" {
      kind    = "service"
      service = "nginx"
      state   = "running"
    }
  }

  vm "web" {
    image  = "debian-12-minimal"
    probes = ["nginx-running"]
  }
}
"#;

        let scenario = Scenario::parse(hcl).unwrap();
        let error = scenario.validate_for_repo().unwrap_err();
        assert!(matches!(
            error,
            ScenarioError::MissingProbeDescription { probe } if probe == "nginx-running"
        ));
    }

    #[test]
    fn parses_vm_packages_from_root_attributes() {
        let hcl = r#"
scenario "vm-packages" {
  category = "test"
  image "debian-12-minimal" {
    base = "trixie"
  }

  kino {
    probe "nginx-running" {
      kind        = "service"
      service     = "nginx"
      state       = "running"
      description = "Nginx should be running"
    }
  }

  vm "web" {
    image = "debian-12-minimal"
    packages = ["nginx", "curl"]
    probes = ["nginx-running"]
  }
}
"#;

        let scenario = Scenario::parse(hcl).unwrap();
        let vm = scenario.vm_by_name("web").unwrap();
        assert_eq!(vm.packages, vec!["nginx", "curl"]);
    }

    #[test]
    fn errors_on_managed_paths_units_and_commands() {
        let hcl = r#"
scenario "managed-assets" {
  category = "test"
  image "debian-12-minimal" {
    base = "trixie"
  }

  kino {
    probe "nginx-running" {
      kind        = "service"
      service     = "nginx"
      state       = "running"
      description = "Nginx should be running"
    }
  }

  vm "web" {
    image = "debian-12-minimal"

    step "blocked" {
      file_write {
        path    = "/etc/kino/kino.hcl.tpl"
        content = "bind = \\\"tcp://127.0.0.1:9000\\\""
      }
    }

    probes = ["nginx-running"]
  }
}
"#;

        let scenario = Scenario::parse(hcl).unwrap();
        let error = scenario.validate_for_repo().unwrap_err();
        assert!(matches!(error, ScenarioError::ManagedPath { .. }));

        let hcl = r#"
scenario "managed-unit" {
  category = "test"
  image "debian-12-minimal" {
    base = "trixie"
  }

  kino {
    probe "nginx-running" {
      kind        = "service"
      service     = "nginx"
      state       = "running"
      description = "Nginx should be running"
    }
  }

  vm "web" {
    image = "debian-12-minimal"

    step "blocked" {
      systemctl {
        unit   = "intar-scenario.service"
        action = "restart"
      }
    }

    probes = ["nginx-running"]
  }
}
"#;

        let scenario = Scenario::parse(hcl).unwrap();
        let error = scenario.validate_for_repo().unwrap_err();
        assert!(matches!(error, ScenarioError::ManagedUnit { .. }));

        let hcl = r#"
scenario "managed-command" {
  category = "test"
  image "debian-12-minimal" {
    base = "trixie"
  }

  kino {
    probe "nginx-running" {
      kind        = "service"
      service     = "nginx"
      state       = "running"
      description = "Nginx should be running"
    }
  }

  vm "web" {
    image = "debian-12-minimal"

    step "blocked" {
      command {
        cmd = "systemctl restart sshd.service"
      }
    }

    probes = ["nginx-running"]
  }
}
"#;

        let scenario = Scenario::parse(hcl).unwrap();
        let error = scenario.validate_for_repo().unwrap_err();
        assert!(matches!(error, ScenarioError::ManagedCommand { .. }));
    }

    #[test]
    fn errors_on_invalid_kino_timing() {
        let hcl = r#"
scenario "invalid-kino-timing" {
  category = "test"
  image "debian-12-minimal" {
    base = "trixie"
  }

  kino {
    defaults {
      every_seconds = 0
    }

    probe "port-80-open" {
      kind        = "port_open"
      host        = "127.0.0.1"
      port        = 80
      protocol    = "tcp"
      description = "HTTP port 80 should be open"
    }
  }

  vm "web" {
    image  = "debian-12-minimal"
    probes = ["port-80-open"]
  }
}
"#;

        let scenario = Scenario::parse(hcl).unwrap();
        let error = scenario.validate_for_repo().unwrap_err();
        assert!(matches!(error, ScenarioError::InvalidKinoDefaults { .. }));
    }

    #[test]
    fn errors_on_invalid_command_json_path_probe() {
        let hcl = r#"
scenario "invalid-command-json-path" {
  category = "test"
  image "debian-12-minimal" {
    base = "trixie"
  }

  kino {
    probe "check-command" {
      kind        = "command_json_path"
      argv        = []
      json_path   = ""
      description = "Command should succeed"
    }
  }

  vm "web" {
    image  = "debian-12-minimal"
    probes = ["check-command"]
  }
}
"#;

        let scenario = Scenario::parse(hcl).unwrap();
        let error = scenario.validate_for_repo().unwrap_err();
        assert!(matches!(
            error,
            ScenarioError::InvalidProbeConfig { probe, .. } if probe == "check-command"
        ));
    }

    #[test]
    fn errors_on_invalid_desired_state() {
        let hcl = r#"
scenario "invalid-desired-state" {
  category = "test"
  image "debian-12-minimal" {
    base = "trixie"
  }

  kino {
    probe "api-ready" {
      kind          = "k8s_pod_state"
      namespace     = "default"
      selector      = "app=api"
      desired_state = "phase:NotARealPhase"
      kubeconfig    = "/tmp/kubeconfig"
      description   = "API pod should be ready"
    }
  }

  vm "web" {
    image  = "debian-12-minimal"
    probes = ["api-ready"]
  }
}
"#;

        let scenario = Scenario::parse(hcl).unwrap();
        let error = scenario.validate_for_repo().unwrap_err();
        assert!(matches!(
            error,
            ScenarioError::InvalidProbeConfig { probe, .. } if probe == "api-ready"
        ));
    }

    #[test]
    fn errors_on_missing_vm_probe_reference() {
        let hcl = r#"
scenario "missing-vm-probe" {
  category = "test"
  image "debian-12-minimal" {
    base = "trixie"
  }

  kino {
    probe "nginx-running" {
      kind        = "service"
      service     = "nginx"
      state       = "running"
      description = "Nginx should be running"
    }
  }

  vm "web" {
    image  = "debian-12-minimal"
    probes = ["missing-probe"]
  }
}
"#;

        let scenario = Scenario::parse(hcl).unwrap();
        let error = scenario.validate_for_repo().unwrap_err();
        assert!(matches!(
            error,
            ScenarioError::ProbeNotFound(probe) if probe == "missing-probe"
        ));
    }

    #[test]
    fn parses_k8s_scale_deployment_action() {
        let hcl = r#"
scenario "scale-action" {
  category = "test"
  image "debian-12-minimal" {
    base = "trixie"
  }

  kino {
    probe "api-ready" {
      kind          = "k8s_pod_state"
      namespace     = "workshop"
      selector      = "app=api"
      desired_state = "condition:Ready"
      description   = "API pod should be ready"
    }
  }

  vm "control-plane" {
    image = "debian-12-minimal"

    step "break-workload" {
      k8s_scale_deployment {
        name      = "api"
        namespace = "workshop"
        replicas  = 0
      }
    }

    probes = ["api-ready"]
  }
}
"#;

        let scenario = Scenario::parse(hcl).unwrap();
        scenario.validate_for_repo().unwrap();

        let vm = scenario.vm_by_name("control-plane").unwrap();
        assert!(matches!(
            &vm.steps[0].actions[0],
            VmAction::K8sScaleDeployment {
                name,
                namespace,
                replicas,
                kubeconfig: None,
            } if name == "api" && namespace == "workshop" && *replicas == 0
        ));
    }

    #[test]
    fn errors_on_invalid_k8s_scale_deployment_action() {
        let hcl = r#"
scenario "invalid-scale-action" {
  category = "test"
  image "debian-12-minimal" {
    base = "trixie"
  }

  kino {
    probe "api-ready" {
      kind          = "k8s_pod_state"
      namespace     = "workshop"
      selector      = "app=api"
      desired_state = "condition:Ready"
      description   = "API pod should be ready"
    }
  }

  vm "control-plane" {
    image = "debian-12-minimal"

    step "break-workload" {
      k8s_scale_deployment {
        name      = "api"
        namespace = "workshop"
      }
    }

    probes = ["api-ready"]
  }
}
"#;

        let error = Scenario::parse(hcl).unwrap_err();
        assert!(
            matches!(error, ScenarioError::InvalidScenario(message) if message.contains("k8s_scale_deployment block missing required attribute 'replicas'"))
        );

        let hcl = r#"
scenario "invalid-scale-action-kubectl" {
  category = "test"
  image "debian-12-minimal" {
    base = "trixie"
  }

  kino {
    probe "api-ready" {
      kind          = "k8s_pod_state"
      namespace     = "workshop"
      selector      = "app=api"
      desired_state = "condition:Ready"
      description   = "API pod should be ready"
    }
  }

  vm "control-plane" {
    image = "debian-12-minimal"

    step "break-workload" {
      k8s_scale_deployment {
        name      = "api"
        namespace = "workshop"
        replicas  = 0
        kubectl   = "scale deployment/api --replicas=0"
      }
    }

    probes = ["api-ready"]
  }
}
"#;

        let error = Scenario::parse(hcl).unwrap_err();
        assert!(
            matches!(error, ScenarioError::InvalidScenario(message) if message.contains("k8s_scale_deployment block does not support attribute 'kubectl'"))
        );
    }
}
