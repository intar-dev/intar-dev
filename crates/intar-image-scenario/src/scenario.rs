#![allow(clippy::missing_errors_doc)]
#![allow(clippy::missing_panics_doc)]

use crate::{KinoDefaults, KinoDefinition, KinoProbeDefinition, ScenarioError};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;

const INTAR_MANAGED_KINO_PATHS: &[&str] = &[
    "/etc/apt/apt.conf.d/99intar-ephemeral",
    "/etc/bash.bashrc",
    "/etc/cloud/cloud-init.disabled",
    "/etc/kino/kino.hcl.tpl",
    "/etc/kino/ssh-recording.hcl",
    "/etc/ssh/sshd_config.d/90-intar-kino-shell.conf",
    "/etc/systemd/system/intar-build.service.d/10-intar-build-seed.conf",
    "/etc/systemd/system/intar-scenario.service",
    "/etc/systemd/system/intar-scenario.service.d/10-intar-runtime-disk.conf",
    "/etc/systemd/system/ssh.service.d/10-intar-gate.conf",
    "/usr/local/bin/intar-bootstrap.sh",
    "/usr/local/bin/intar-scenario-supervisor.sh",
    "/usr/local/bin/intar",
    "/usr/local/bin/kino",
    "/usr/local/bin/kino-shell",
    "/usr/share/intar/completions/intar.bash",
    "/run/intar/kino-control.sock",
    "/run/intar/run-cli-broker",
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
    pub title: String,
    pub category: String,
    pub tags: Vec<String>,
    pub difficulty: Option<ScenarioDifficulty>,
    pub estimated_minutes: Option<u32>,
    pub description: String,
    pub briefing: String,
    pub hints: Vec<ScenarioHint>,
    pub solution: Option<ScenarioSolution>,
    pub images: HashMap<String, ImageSpec>,
    pub kino: KinoDefinition,
    pub vms: Vec<VmDefinition>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScenarioDifficulty {
    Easy,
    Medium,
    Hard,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScenarioHint {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScenarioSolution {
    pub body: String,
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

impl ProbePhase {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Boot => "boot",
            Self::Scenario => "scenario",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VmDefinition {
    pub name: String,
    pub cpu_millis: u32,
    pub vcpu_count: u16,
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
        let mut vm_cpu_literals: VecDeque<_> = extract_vm_cpu_literals(content)?.into();
        let body: hcl::Body =
            hcl::from_str(content).map_err(|error| ScenarioError::HclParse(error.to_string()))?;

        let mut scenario_name = String::new();
        let mut saw_scenario_block = false;
        let mut title = String::new();
        let mut category = String::new();
        let mut tags = Vec::new();
        let mut difficulty = None;
        let mut estimated_minutes = None;
        let mut description = String::new();
        let mut briefing = String::new();
        let mut hints = Vec::new();
        let mut solution = None;
        let mut images = HashMap::new();
        let mut kino = KinoDefinition::default();
        let mut vms = Vec::new();

        for block in body.blocks() {
            if block.identifier.as_str() != "scenario" {
                continue;
            }
            if saw_scenario_block {
                return Err(ScenarioError::InvalidScenario(
                    "only one scenario block is supported".into(),
                ));
            }
            saw_scenario_block = true;

            scenario_name = required_single_label(block, "scenario", "missing scenario name")?;

            for attr in block.body.attributes() {
                match attr.key.as_str() {
                    "title" => title = extract_string(&attr.expr)?,
                    "category" => category = extract_string(&attr.expr)?,
                    "tags" => tags = extract_string_array(&attr.expr)?,
                    "difficulty" => difficulty = Some(parse_difficulty(&attr.expr)?),
                    "estimated_minutes" => estimated_minutes = Some(extract_u32(&attr.expr)?),
                    "description" => description = extract_string(&attr.expr)?,
                    "briefing" => briefing = extract_string(&attr.expr)?,
                    other => {
                        return Err(ScenarioError::InvalidScenario(format!(
                            "scenario '{scenario_name}' does not support attribute '{other}'"
                        )));
                    }
                }
            }

            for inner_block in block.body.blocks() {
                match inner_block.identifier.as_str() {
                    "hint" => {
                        hints.push(parse_hint(inner_block)?);
                    }
                    "solution" => {
                        if solution.is_some() {
                            return Err(ScenarioError::InvalidScenario(format!(
                                "scenario '{scenario_name}' may only contain one solution block"
                            )));
                        }
                        solution = Some(parse_solution(inner_block)?);
                    }
                    "image" => {
                        let image = parse_image(inner_block)?;
                        let image_name = image.name.clone();
                        if images.insert(image_name.clone(), image).is_some() {
                            return Err(ScenarioError::InvalidScenario(format!(
                                "duplicate image '{image_name}'"
                            )));
                        }
                    }
                    "kino" => {
                        kino = parse_kino(inner_block)?;
                    }
                    "vm" => {
                        let cpu_literal = vm_cpu_literals.pop_front().ok_or_else(|| {
                            ScenarioError::InvalidScenario(
                                "internal VM CPU literal/parser ordering mismatch".into(),
                            )
                        })?;
                        let vm = parse_vm(inner_block, cpu_literal.as_deref())?;
                        if vms
                            .iter()
                            .any(|existing: &VmDefinition| existing.name == vm.name)
                        {
                            return Err(ScenarioError::InvalidScenario(format!(
                                "duplicate vm '{}'",
                                vm.name
                            )));
                        }
                        vms.push(vm);
                    }
                    other => {
                        return Err(ScenarioError::InvalidScenario(format!(
                            "unsupported block '{other}' in scenario '{scenario_name}'"
                        )));
                    }
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
            title,
            category,
            tags,
            difficulty,
            estimated_minutes,
            description,
            briefing,
            hints,
            solution,
            images,
            kino,
            vms,
        })
    }

    pub fn validate(&self) -> Result<(), ScenarioError> {
        validate_safe_identifier("scenario name", &self.name)?;
        for image in self.images.values() {
            validate_safe_identifier("image name", &image.name)?;
            validate_safe_identifier("base image reference", &image.base)?;
        }

        let mut vm_names = HashSet::new();
        for vm in &self.vms {
            validate_safe_identifier("vm name", &vm.name)?;
            if !vm_names.insert(vm.name.as_str()) {
                return Err(ScenarioError::InvalidScenario(format!(
                    "duplicate vm '{}'",
                    vm.name
                )));
            }
            if !self.images.contains_key(&vm.image) {
                return Err(ScenarioError::ImageNotFound(vm.image.clone()));
            }
            validate_safe_identifier("vm image reference", &vm.image)?;
            let mut step_names = HashSet::new();
            for step in &vm.steps {
                validate_safe_identifier("step name", &step.name)?;
                if !step_names.insert(step.name.as_str()) {
                    return Err(ScenarioError::InvalidScenario(format!(
                        "vm '{}' has duplicate step '{}'",
                        vm.name, step.name
                    )));
                }
            }
            for probe_name in &vm.probes {
                validate_safe_identifier("probe reference", probe_name)?;
                if !self.kino.probes.contains_key(probe_name) {
                    return Err(ScenarioError::ProbeNotFound(probe_name.clone()));
                }
            }
        }
        for probe in self.kino.probes.values() {
            validate_safe_identifier("probe name", &probe.name)?;
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
            validate_intar_probe_label(&probe.name, description)?;
            probe.validate()?;
            validate_hint_scope(&format!("probe '{}'", probe.name), &probe.hints, true)?;
        }

        validate_hint_scope("scenario", &self.hints, true)?;

        for vm in &self.vms {
            for step in &vm.steps {
                for action in &step.actions {
                    validate_vm_action(vm, step, action)?;
                }
            }
        }

        self.validate_authoring_fields()?;

        Ok(())
    }

    fn validate_authoring_fields(&self) -> Result<(), ScenarioError> {
        validate_required_scenario_text("title", &self.title)?;
        validate_required_scenario_text("description", &self.description)?;
        if self.description.lines().count() > 1 {
            return Err(ScenarioError::InvalidScenarioField {
                field: "description".to_string(),
                message: "must be a single line".to_string(),
            });
        }
        validate_required_scenario_text("briefing", &self.briefing)?;
        if self.difficulty.is_none() {
            return Err(ScenarioError::MissingScenarioField {
                field: "difficulty".to_string(),
            });
        }
        match self.estimated_minutes {
            Some(value) if value > 0 => {}
            Some(_) => {
                return Err(ScenarioError::InvalidScenarioField {
                    field: "estimated_minutes".to_string(),
                    message: "must be greater than zero".to_string(),
                });
            }
            None => {
                return Err(ScenarioError::MissingScenarioField {
                    field: "estimated_minutes".to_string(),
                });
            }
        }
        match &self.solution {
            Some(solution) if !solution.body.trim().is_empty() => {}
            Some(_) => {
                return Err(ScenarioError::InvalidScenarioField {
                    field: "solution.body".to_string(),
                    message: "must not be empty".to_string(),
                });
            }
            None => {
                return Err(ScenarioError::MissingScenarioField {
                    field: "solution".to_string(),
                });
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

fn validate_required_scenario_text(field: &str, value: &str) -> Result<(), ScenarioError> {
    if value.trim().is_empty() {
        return Err(ScenarioError::MissingScenarioField {
            field: field.to_string(),
        });
    }
    Ok(())
}

fn validate_intar_probe_label(probe: &str, value: &str) -> Result<(), ScenarioError> {
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
    if value.chars().count() > 160 || has_terminal_controls {
        return Err(ScenarioError::InvalidScenarioField {
            field: format!("kino.probe.{probe}.description"),
            message: "must be visible terminal text of at most 160 characters".to_string(),
        });
    }
    Ok(())
}

pub(crate) fn validate_safe_identifier(label: &str, value: &str) -> Result<(), ScenarioError> {
    if (1..=128).contains(&value.len())
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Ok(());
    }

    Err(ScenarioError::InvalidScenario(format!(
        "invalid {label} '{value}' (expected 1-128 safe slug characters)"
    )))
}

fn validate_hint_scope(
    scope: &str,
    hints: &[ScenarioHint],
    require_body: bool,
) -> Result<(), ScenarioError> {
    let mut seen = HashSet::new();
    for hint in hints {
        validate_safe_identifier(&format!("{scope} hint id"), &hint.id)?;
        if !seen.insert(hint.id.as_str()) {
            return Err(ScenarioError::DuplicateHintId {
                scope: scope.to_string(),
                id: hint.id.clone(),
            });
        }
        if require_body && hint.body.trim().is_empty() {
            return Err(ScenarioError::InvalidScenarioField {
                field: format!("{scope}.hint.{}.body", hint.id),
                message: "must not be empty".to_string(),
            });
        }
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

mod parser;
use parser::*;
#[cfg(test)]
mod tests;
