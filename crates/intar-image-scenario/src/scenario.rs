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
                        let vm = parse_vm(inner_block)?;
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

fn parse_image(block: &hcl::Block) -> Result<ImageSpec, ScenarioError> {
    let name = required_single_label(block, "image", "missing image name")?;
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
    reject_labels(block)?;
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
    reject_labels(block)?;
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
    let name = required_single_label(block, "kino probe", "missing kino probe name")?;

    let mut description = None;
    let mut title = None;
    let mut body = None;
    let mut hints = Vec::new();
    let mut phase = ProbePhase::Scenario;
    let mut config = HashMap::new();

    for attr in block.body.attributes() {
        match attr.key.as_str() {
            "description" => description = Some(extract_string(&attr.expr)?),
            "title" => title = Some(extract_string(&attr.expr)?),
            "body" => body = Some(extract_string(&attr.expr)?),
            "phase" => phase = parse_probe_phase(&name, &attr.expr)?,
            _ => {
                config.insert(attr.key.to_string(), expr_to_json(&attr.expr)?);
            }
        }
    }

    for inner_block in block.body.blocks() {
        match inner_block.identifier.as_str() {
            "hint" => hints.push(parse_hint(inner_block)?),
            other => {
                return Err(ScenarioError::InvalidScenario(format!(
                    "unsupported block '{other}' in kino probe '{name}'"
                )));
            }
        }
    }

    KinoProbeDefinition::from_definition(&name, &config, description, title, body, hints, phase)
}

fn parse_hint(block: &hcl::Block) -> Result<ScenarioHint, ScenarioError> {
    let id = required_single_label(block, "hint", "hint block missing id")?;
    let mut title = None;
    let mut body = String::new();

    for attr in block.body.attributes() {
        match attr.key.as_str() {
            "title" => title = Some(extract_string(&attr.expr)?),
            "body" => body = extract_string(&attr.expr)?,
            other => {
                return Err(ScenarioError::InvalidScenario(format!(
                    "hint '{id}' does not support attribute '{other}'"
                )));
            }
        }
    }

    if let Some(inner_block) = block.body.blocks().next() {
        return Err(ScenarioError::InvalidScenario(format!(
            "hint '{id}' does not support nested block '{}'",
            inner_block.identifier
        )));
    }

    Ok(ScenarioHint { id, title, body })
}

fn parse_solution(block: &hcl::Block) -> Result<ScenarioSolution, ScenarioError> {
    if !block.labels.is_empty() {
        return Err(ScenarioError::InvalidScenario(
            "solution block does not support labels".into(),
        ));
    }
    let mut body = String::new();
    for attr in block.body.attributes() {
        match attr.key.as_str() {
            "body" => body = extract_string(&attr.expr)?,
            other => {
                return Err(ScenarioError::InvalidScenario(format!(
                    "solution block does not support attribute '{other}'"
                )));
            }
        }
    }
    if let Some(inner_block) = block.body.blocks().next() {
        return Err(ScenarioError::InvalidScenario(format!(
            "solution block does not support nested block '{}'",
            inner_block.identifier
        )));
    }
    Ok(ScenarioSolution { body })
}

fn parse_difficulty(expr: &hcl::Expression) -> Result<ScenarioDifficulty, ScenarioError> {
    let value = extract_string(expr)?;
    match value.as_str() {
        "easy" => Ok(ScenarioDifficulty::Easy),
        "medium" => Ok(ScenarioDifficulty::Medium),
        "hard" => Ok(ScenarioDifficulty::Hard),
        other => Err(ScenarioError::InvalidScenarioField {
            field: "difficulty".to_string(),
            message: format!("must be 'easy', 'medium', or 'hard', got '{other}'"),
        }),
    }
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
    let name = required_single_label(block, "vm", "missing vm name")?;

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
            other => {
                return Err(ScenarioError::InvalidScenario(format!(
                    "vm '{name}' does not support attribute '{other}'"
                )));
            }
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
    let name = required_single_label(block, "step", "step block missing name")?;

    if let Some(attr) = block.body.attributes().next() {
        return Err(ScenarioError::InvalidScenario(format!(
            "step '{name}' does not support attribute '{}'",
            attr.key
        )));
    }

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
    reject_labels(block)?;

    match block.identifier.as_str() {
        "file_delete" => {
            reject_unknown_attrs(block, &["path"])?;
            reject_nested_blocks(block)?;
            Ok(VmAction::FileDelete {
                path: extract_required_attr_string(block, "path")?,
            })
        }
        "file_write" => {
            reject_unknown_attrs(block, &["path", "content", "permissions"])?;
            reject_nested_blocks(block)?;
            Ok(VmAction::FileWrite {
                path: extract_required_attr_string(block, "path")?,
                content: extract_required_attr_string(block, "content")?,
                permissions: extract_optional_attr_string(block, "permissions")?,
            })
        }
        "file_replace" => {
            reject_unknown_attrs(block, &["path", "pattern", "replacement", "regex"])?;
            reject_nested_blocks(block)?;
            Ok(VmAction::FileReplace {
                path: extract_required_attr_string(block, "path")?,
                pattern: extract_required_attr_string(block, "pattern")?,
                replacement: extract_required_attr_string(block, "replacement")?,
                regex: extract_optional_attr_bool(block, "regex")?.unwrap_or(false),
            })
        }
        "systemctl" => {
            reject_unknown_attrs(block, &["unit", "action"])?;
            reject_nested_blocks(block)?;
            Ok(VmAction::Systemctl {
                unit: extract_required_attr_string(block, "unit")?,
                action: parse_systemctl_action(&extract_required_attr_string(block, "action")?)?,
            })
        }
        "command" => {
            reject_unknown_attrs(block, &["cmd"])?;
            reject_nested_blocks(block)?;
            Ok(VmAction::Command {
                cmd: extract_required_attr_string(block, "cmd")?,
            })
        }
        "k8s_apply" => {
            reject_unknown_attrs(block, &["manifest", "kubeconfig"])?;
            reject_nested_blocks(block)?;
            Ok(VmAction::K8sApply {
                manifest: extract_required_attr_string(block, "manifest")?,
                kubeconfig: extract_optional_attr_string(block, "kubeconfig")?,
            })
        }
        "k8s_namespace" => {
            reject_unknown_attrs(block, &["name", "kubeconfig"])?;
            reject_nested_blocks(block)?;
            Ok(VmAction::K8sNamespace {
                name: extract_required_attr_string(block, "name")?,
                kubeconfig: extract_optional_attr_string(block, "kubeconfig")?,
            })
        }
        "k8s_deployment" => {
            reject_unknown_attrs(
                block,
                &[
                    "name",
                    "namespace",
                    "image",
                    "replicas",
                    "labels",
                    "container_port",
                    "kubeconfig",
                ],
            )?;
            reject_nested_blocks(block)?;
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
            reject_unknown_attrs(
                block,
                &[
                    "name",
                    "namespace",
                    "selector",
                    "port",
                    "target_port",
                    "kubeconfig",
                ],
            )?;
            reject_nested_blocks(block)?;
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
            reject_unknown_attrs(block, &["name", "namespace", "replicas", "kubeconfig"])?;
            reject_nested_blocks(block)?;
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

fn required_single_label(
    block: &hcl::Block,
    context: &str,
    missing_message: &str,
) -> Result<String, ScenarioError> {
    match block.labels.len() {
        0 => Err(ScenarioError::InvalidScenario(missing_message.into())),
        1 => Ok(block.labels[0].as_str().to_string()),
        _ => Err(ScenarioError::InvalidScenario(format!(
            "{context} block expects exactly one label"
        ))),
    }
}

fn reject_labels(block: &hcl::Block) -> Result<(), ScenarioError> {
    if !block.labels.is_empty() {
        return Err(ScenarioError::InvalidScenario(format!(
            "{} block does not support labels",
            block.identifier
        )));
    }
    Ok(())
}

fn reject_unknown_attrs(block: &hcl::Block, allowed: &[&str]) -> Result<(), ScenarioError> {
    for attr in block.body.attributes() {
        if allowed.contains(&attr.key.as_str()) {
            continue;
        }
        return Err(ScenarioError::InvalidScenario(format!(
            "{} block does not support attribute '{}'",
            block.identifier, attr.key
        )));
    }
    Ok(())
}

fn reject_nested_blocks(block: &hcl::Block) -> Result<(), ScenarioError> {
    if let Some(inner_block) = block.body.blocks().next() {
        return Err(ScenarioError::InvalidScenario(format!(
            "{} block does not support nested block '{}'",
            block.identifier, inner_block.identifier
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
  title = "Broken Nginx"
  category = "web"
  tags = ["nginx", "systemd", "linux"]
  difficulty = "easy"
  estimated_minutes = 15
  description = "Fix a misconfigured nginx server"
  briefing = <<-MD
    Nginx should be serving the default site, but the service was broken during cleanup.
  MD

  hint "check-service" {
    title = "Start with systemd"
    body  = "Check the nginx service state first."
  }

  solution {
    body = <<-MD
      Start nginx and restore the default site symlink.
    MD
  }

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
      title       = "Bring nginx back"
      body        = "The service must be active before the site can answer traffic."
      phase       = "boot"

      hint "status" {
        body = "systemctl status nginx shows whether the service is active."
      }
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
        assert_eq!(scenario.title, "Broken Nginx");
        assert_eq!(scenario.category, "web");
        assert_eq!(scenario.tags, vec!["nginx", "systemd", "linux"]);
        assert_eq!(scenario.difficulty, Some(ScenarioDifficulty::Easy));
        assert_eq!(scenario.estimated_minutes, Some(15));
        assert_eq!(scenario.hints[0].id, "check-service");
        assert!(
            scenario
                .solution
                .as_ref()
                .unwrap()
                .body
                .contains("Start nginx")
        );
        let probe = scenario.kino.probes.get("nginx-running").unwrap();
        assert_eq!(probe.title.as_deref(), Some("Bring nginx back"));
        assert_eq!(probe.hints[0].id, "status");
        assert_eq!(scenario.total_probe_count(), 4);
        assert_eq!(scenario.images["debian-12-minimal"].base, "trixie");
    }

    #[test]
    fn errors_on_unknown_scenario_attribute() {
        let hcl = supported_hcl().replace(
            r#"  description = "Fix a misconfigured nginx server""#,
            r#"  typo_description = "This should not be silently ignored"
  description = "Fix a misconfigured nginx server""#,
        );
        let error = Scenario::parse(&hcl).unwrap_err();
        assert!(
            matches!(error, ScenarioError::InvalidScenario(message) if message.contains("does not support attribute 'typo_description'"))
        );
    }

    #[test]
    fn errors_on_unknown_vm_attribute() {
        let hcl = supported_hcl().replace(
            r#"    packages = ["nginx"]"#,
            r#"    package = ["nginx"]
    packages = ["nginx"]"#,
        );

        let error = Scenario::parse(&hcl).unwrap_err();

        assert!(
            matches!(error, ScenarioError::InvalidScenario(message) if message.contains("vm 'webserver' does not support attribute 'package'"))
        );
    }

    #[test]
    fn errors_on_unknown_step_attribute() {
        let hcl = supported_hcl().replace(
            r#"    step "break-nginx" {"#,
            r#"    step "break-nginx" {
      summary = "This should not be accepted""#,
        );

        let error = Scenario::parse(&hcl).unwrap_err();

        assert!(
            matches!(error, ScenarioError::InvalidScenario(message) if message.contains("step 'break-nginx' does not support attribute 'summary'"))
        );
    }

    #[test]
    fn errors_on_unknown_vm_action_attribute() {
        let hcl = supported_hcl().replace(
            r#"        path = "/etc/nginx/sites-enabled/default""#,
            r#"        target = "/etc/nginx/sites-enabled/default"
        path = "/etc/nginx/sites-enabled/default""#,
        );

        let error = Scenario::parse(&hcl).unwrap_err();

        assert!(
            matches!(error, ScenarioError::InvalidScenario(message) if message.contains("file_delete block does not support attribute 'target'"))
        );
    }

    #[test]
    fn errors_on_nested_vm_action_block() {
        let hcl = supported_hcl().replace(
            r#"      file_delete {
        path = "/etc/nginx/sites-enabled/default"
      }"#,
            r#"      file_delete {
        path = "/etc/nginx/sites-enabled/default"
        nested {}
      }"#,
        );

        let error = Scenario::parse(&hcl).unwrap_err();

        assert!(
            matches!(error, ScenarioError::InvalidScenario(message) if message.contains("file_delete block does not support nested block 'nested'"))
        );
    }

    #[test]
    fn errors_on_extra_named_block_label() {
        let hcl = supported_hcl().replace(
            r#"scenario "broken-nginx" {"#,
            r#"scenario "broken-nginx" "extra" {"#,
        );
        let error = Scenario::parse(&hcl).unwrap_err();
        assert!(
            matches!(error, ScenarioError::InvalidScenario(message) if message.contains("scenario block expects exactly one label"))
        );

        let hcl = supported_hcl().replace(
            r#"    probe "nginx-running" {"#,
            r#"    probe "nginx-running" "extra" {"#,
        );
        let error = Scenario::parse(&hcl).unwrap_err();
        assert!(
            matches!(error, ScenarioError::InvalidScenario(message) if message.contains("kino probe block expects exactly one label"))
        );
    }

    #[test]
    fn errors_on_label_free_block_labels() {
        let hcl = supported_hcl().replace(r#"  kino {"#, r#"  kino "checks" {"#);
        let error = Scenario::parse(&hcl).unwrap_err();
        assert!(
            matches!(error, ScenarioError::InvalidScenario(message) if message.contains("kino block does not support labels"))
        );

        let hcl = supported_hcl().replace(r#"      systemctl {"#, r#"      systemctl "stop" {"#);
        let error = Scenario::parse(&hcl).unwrap_err();
        assert!(
            matches!(error, ScenarioError::InvalidScenario(message) if message.contains("systemctl block does not support labels"))
        );
    }

    #[test]
    fn errors_on_duplicate_hint_ids_per_scope() {
        let hcl = supported_hcl().replace(
            "  solution {",
            r#"  hint "check-service" {
    body = "Read the systemd state again."
  }

  solution {"#,
        );
        let scenario = Scenario::parse(&hcl).unwrap();
        let error = scenario.validate_for_repo().unwrap_err();
        assert!(matches!(
            error,
            ScenarioError::DuplicateHintId { scope, id }
                if scope == "scenario" && id == "check-service"
        ));

        let hcl = supported_hcl().replace(
            r#"      hint "status" {
        body = "systemctl status nginx shows whether the service is active."
      }"#,
            r#"      hint "status" {
        body = "systemctl status nginx shows whether the service is active."
      }

      hint "status" {
        body = "Check the service status again."
      }"#,
        );
        let scenario = Scenario::parse(&hcl).unwrap();
        let error = scenario.validate_for_repo().unwrap_err();
        assert!(matches!(
            error,
            ScenarioError::DuplicateHintId { scope, id }
                if scope == "probe 'nginx-running'" && id == "status"
        ));
    }

    #[test]
    fn errors_on_unsafe_scenario_identifiers() {
        let hcl =
            supported_hcl().replace(r#"scenario "broken-nginx" {"#, r#"scenario "../escape" {"#);
        let scenario = Scenario::parse(&hcl).unwrap();
        let error = scenario.validate_for_repo().unwrap_err();
        assert!(
            matches!(error, ScenarioError::InvalidScenario(message) if message.contains("invalid scenario name"))
        );

        let hcl = supported_hcl().replace(r#"vm "webserver" {"#, r#"vm "../web" {"#);
        let scenario = Scenario::parse(&hcl).unwrap();
        let error = scenario.validate_for_repo().unwrap_err();
        assert!(
            matches!(error, ScenarioError::InvalidScenario(message) if message.contains("invalid vm name"))
        );
    }

    #[test]
    fn errors_on_duplicate_image_and_vm_labels() {
        let hcl = supported_hcl().replace(
            r#"  kino {"#,
            r#"  image "debian-12-minimal" {
    base = "trixie"
  }

  kino {"#,
        );
        let error = Scenario::parse(&hcl).unwrap_err();
        assert!(
            matches!(error, ScenarioError::InvalidScenario(message) if message.contains("duplicate image 'debian-12-minimal'"))
        );

        let hcl = supported_hcl().replace(
            r#"  vm "webserver" {"#,
            r#"  vm "webserver" {
    image = "debian-12-minimal"
    probes = ["nginx-running"]
  }

  vm "webserver" {"#,
        );
        let error = Scenario::parse(&hcl).unwrap_err();
        assert!(
            matches!(error, ScenarioError::InvalidScenario(message) if message.contains("duplicate vm 'webserver'"))
        );
    }

    #[test]
    fn errors_on_multiline_description() {
        let hcl = supported_hcl().replace(
            r#"description = "Fix a misconfigured nginx server""#,
            r#"description = <<-MD
    Fix a misconfigured nginx server.
    Keep the tagline on one line.
  MD"#,
        );
        let scenario = Scenario::parse(&hcl).unwrap();
        let error = scenario.validate_for_repo().unwrap_err();
        assert!(matches!(
            error,
            ScenarioError::InvalidScenarioField { field, message }
                if field == "description" && message.contains("single line")
        ));
    }

    #[test]
    fn authoring_prose_may_reference_managed_commands() {
        let hcl = supported_hcl()
            .replace(
                "Nginx should be serving the default site, but the service was broken during cleanup.",
                "As prose, mention `systemctl status intar-scenario.service` without making it executable.",
            )
            .replace(
                "Check the nginx service state first.",
                "The hint can mention `systemctl restart sshd.service` as text.",
            )
            .replace(
                "Start nginx and restore the default site symlink.",
                "The solution may discuss why `chsh ubuntu` would be wrong without running it.",
            );
        let scenario = Scenario::parse(&hcl).unwrap();
        scenario.validate_for_repo().unwrap();
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
        assert!(!kino.config_hcl.contains("Bring nginx back"));
        assert!(!kino.config_hcl.contains("systemctl status nginx"));
        assert!(!kino.config_hcl.contains("Start nginx and restore"));
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
  title = "Scale Action"
  category = "test"
  tags = ["kubernetes"]
  difficulty = "medium"
  estimated_minutes = 20
  image "debian-12-minimal" {
    base = "trixie"
  }
  description = "Scale a deployment"
  briefing = "Restore the expected deployment replica count."
  solution { body = "Scale the api deployment back to one replica." }

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
