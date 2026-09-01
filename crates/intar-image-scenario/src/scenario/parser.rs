use super::*;

pub(super) fn parse_image(block: &hcl::Block) -> Result<ImageSpec, ScenarioError> {
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

pub(super) fn parse_kino(block: &hcl::Block) -> Result<KinoDefinition, ScenarioError> {
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

pub(super) fn parse_kino_defaults(block: &hcl::Block) -> Result<KinoDefaults, ScenarioError> {
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

pub(super) fn parse_kino_probe(block: &hcl::Block) -> Result<KinoProbeDefinition, ScenarioError> {
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

pub(super) fn parse_hint(block: &hcl::Block) -> Result<ScenarioHint, ScenarioError> {
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

pub(super) fn parse_solution(block: &hcl::Block) -> Result<ScenarioSolution, ScenarioError> {
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

pub(super) fn parse_probe_phase(
    name: &str,
    expr: &hcl::Expression,
) -> Result<ProbePhase, ScenarioError> {
    let value = extract_string(expr)?;
    match value.as_str() {
        "boot" => Ok(ProbePhase::Boot),
        "scenario" => Ok(ProbePhase::Scenario),
        other => Err(ScenarioError::InvalidScenario(format!(
            "probe '{name}' phase must be 'boot' or 'scenario', got '{other}'"
        ))),
    }
}

pub(super) fn parse_vm(
    block: &hcl::Block,
    cpu_literal: Option<&str>,
) -> Result<VmDefinition, ScenarioError> {
    let name = required_single_label(block, "vm", "missing vm name")?;

    let mut cpu_millis = 1_000;
    let mut vcpu_count = None;
    let mut memory: u32 = 1024;
    let mut disk: u32 = 10;
    let mut image = String::new();
    let mut packages = Vec::new();
    let mut steps = Vec::new();
    let mut probes = Vec::new();

    for attr in block.body.attributes() {
        match attr.key.as_str() {
            "cpu" => {
                let literal = cpu_literal.ok_or_else(|| {
                    ScenarioError::InvalidScenario(format!(
                        "vm '{name}' cpu literal was not preserved"
                    ))
                })?;
                cpu_millis = parse_cpu_millis(literal).map_err(|message| {
                    ScenarioError::InvalidScenario(format!("vm '{name}' cpu {message}"))
                })?;
            }
            "vcpus" => vcpu_count = Some(extract_u16(&attr.expr)?),
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

    if cpu_millis == 0 {
        return Err(ScenarioError::InvalidScenario(format!(
            "vm '{name}' cpu must be > 0"
        )));
    }

    let vcpu_count = match vcpu_count {
        Some(0) => {
            return Err(ScenarioError::InvalidScenario(format!(
                "vm '{name}' vcpus must be > 0"
            )));
        }
        Some(value) => value,
        None => u16::try_from(cpu_millis.div_ceil(1_000)).map_err(|_| {
            ScenarioError::InvalidScenario(format!(
                "vm '{name}' cpu requires more than {} vcpus",
                u16::MAX
            ))
        })?,
    };

    let vcpu_capacity_millis = u32::from(vcpu_count) * 1_000;
    if cpu_millis > vcpu_capacity_millis {
        return Err(ScenarioError::InvalidScenario(format!(
            "vm '{name}' cpu ({cpu_millis} millicores) exceeds vcpus capacity ({vcpu_capacity_millis} millicores)"
        )));
    }

    Ok(VmDefinition {
        name,
        cpu_millis,
        vcpu_count,
        memory,
        disk,
        image,
        packages,
        steps,
        probes,
    })
}

pub(super) fn extract_vm_cpu_literals(content: &str) -> Result<Vec<Option<String>>, ScenarioError> {
    let body = hcl_edit::parser::parse_body(content)
        .map_err(|error| ScenarioError::HclParse(error.to_string()))?;
    let mut literals = Vec::new();

    for scenario in body.get_blocks("scenario") {
        for vm in scenario.body.get_blocks("vm") {
            let literal = vm
                .body
                .get_attribute("cpu")
                .map(|attribute| match &attribute.value {
                    hcl_edit::expr::Expression::Number(number) => number
                        .as_repr()
                        .map(|representation| String::from(&**representation))
                        .ok_or_else(|| {
                            ScenarioError::InvalidScenario(
                                "cpu number is missing its source representation".into(),
                            )
                        }),
                    expression => Err(ScenarioError::InvalidScenario(format!(
                        "expected cpu number, got {expression:?}"
                    ))),
                })
                .transpose()?;
            literals.push(literal);
        }
    }

    Ok(literals)
}

pub(super) fn parse_cpu_millis(literal: &str) -> Result<u32, String> {
    if literal.contains('e') || literal.contains('E') {
        return Err("must not use exponent notation".into());
    }

    let (whole, fraction) = match literal.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (literal, None),
    };
    if whole.is_empty() || !whole.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("must be a positive integer or decimal literal".into());
    }
    let fraction_millis = match fraction {
        None => 0,
        Some(fraction) if fraction.is_empty() || fraction.len() > 3 => {
            return Err("must have at most three fractional digits".into());
        }
        Some(fraction) if !fraction.bytes().all(|byte| byte.is_ascii_digit()) => {
            return Err("must be a positive integer or decimal literal".into());
        }
        Some(fraction) => {
            let value = fraction
                .parse::<u32>()
                .map_err(|_| "has an invalid fractional component".to_string())?;
            let digits = u32::try_from(fraction.len())
                .map_err(|_| "has too many fractional digits".to_string())?;
            let padding = 3_u32.saturating_sub(digits);
            value * 10_u32.pow(padding)
        }
    };
    let whole = whole
        .parse::<u64>()
        .map_err(|_| "is too large".to_string())?;
    let millis = whole
        .checked_mul(1_000)
        .and_then(|value| value.checked_add(u64::from(fraction_millis)))
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| "is too large".to_string())?;

    if millis == 0 {
        return Err("must be > 0".into());
    }
    Ok(millis)
}

pub(super) fn parse_vm_step(block: &hcl::Block) -> Result<VmStep, ScenarioError> {
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

pub(super) fn parse_vm_action(block: &hcl::Block) -> Result<VmAction, ScenarioError> {
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

pub(super) fn parse_systemctl_action(action: &str) -> Result<SystemctlAction, ScenarioError> {
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

pub(super) fn extract_string(expr: &hcl::Expression) -> Result<String, ScenarioError> {
    match expr {
        hcl::Expression::String(value) => Ok(value.clone()),
        hcl::Expression::TemplateExpr(value) => Ok(value.to_string().trim_matches('"').to_string()),
        _ => Err(ScenarioError::InvalidScenario(format!(
            "expected string, got {expr:?}"
        ))),
    }
}

pub(super) fn extract_bool(expr: &hcl::Expression) -> Result<bool, ScenarioError> {
    match expr {
        hcl::Expression::Bool(value) => Ok(*value),
        _ => Err(ScenarioError::InvalidScenario(format!(
            "expected bool, got {expr:?}"
        ))),
    }
}

pub(super) fn extract_u32(expr: &hcl::Expression) -> Result<u32, ScenarioError> {
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

pub(super) fn extract_u64(expr: &hcl::Expression) -> Result<u64, ScenarioError> {
    match expr {
        hcl::Expression::Number(number) => number
            .as_u64()
            .ok_or_else(|| ScenarioError::InvalidScenario("invalid number".into())),
        _ => Err(ScenarioError::InvalidScenario(format!(
            "expected number, got {expr:?}"
        ))),
    }
}

pub(super) fn extract_u16(expr: &hcl::Expression) -> Result<u16, ScenarioError> {
    let value = extract_u32(expr)?;
    u16::try_from(value).map_err(|_| ScenarioError::InvalidScenario("invalid number".into()))
}

pub(super) fn extract_optional_attr_string(
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

pub(super) fn required_single_label(
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

pub(super) fn reject_labels(block: &hcl::Block) -> Result<(), ScenarioError> {
    if !block.labels.is_empty() {
        return Err(ScenarioError::InvalidScenario(format!(
            "{} block does not support labels",
            block.identifier
        )));
    }
    Ok(())
}

pub(super) fn reject_unknown_attrs(
    block: &hcl::Block,
    allowed: &[&str],
) -> Result<(), ScenarioError> {
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

pub(super) fn reject_nested_blocks(block: &hcl::Block) -> Result<(), ScenarioError> {
    if let Some(inner_block) = block.body.blocks().next() {
        return Err(ScenarioError::InvalidScenario(format!(
            "{} block does not support nested block '{}'",
            block.identifier, inner_block.identifier
        )));
    }
    Ok(())
}

pub(super) fn extract_required_attr_string(
    block: &hcl::Block,
    key: &str,
) -> Result<String, ScenarioError> {
    extract_optional_attr_string(block, key)?.ok_or_else(|| {
        ScenarioError::InvalidScenario(format!(
            "{} block missing required attribute '{key}'",
            block.identifier
        ))
    })
}

pub(super) fn extract_optional_attr_u32(
    block: &hcl::Block,
    key: &str,
) -> Result<Option<u32>, ScenarioError> {
    block
        .body
        .attributes()
        .find(|attr| attr.key.as_str() == key)
        .map(|attr| extract_u32(&attr.expr))
        .transpose()
}

pub(super) fn extract_required_attr_u32(
    block: &hcl::Block,
    key: &str,
) -> Result<u32, ScenarioError> {
    extract_optional_attr_u32(block, key)?.ok_or_else(|| {
        ScenarioError::InvalidScenario(format!(
            "{} block missing required attribute '{key}'",
            block.identifier
        ))
    })
}

pub(super) fn extract_optional_attr_u16(
    block: &hcl::Block,
    key: &str,
) -> Result<Option<u16>, ScenarioError> {
    block
        .body
        .attributes()
        .find(|attr| attr.key.as_str() == key)
        .map(|attr| extract_u16(&attr.expr))
        .transpose()
}

pub(super) fn extract_required_attr_u16(
    block: &hcl::Block,
    key: &str,
) -> Result<u16, ScenarioError> {
    extract_optional_attr_u16(block, key)?.ok_or_else(|| {
        ScenarioError::InvalidScenario(format!(
            "{} block missing required attribute '{key}'",
            block.identifier
        ))
    })
}

pub(super) fn extract_optional_attr_bool(
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

pub(super) fn extract_string_map(
    expr: &hcl::Expression,
) -> Result<HashMap<String, String>, ScenarioError> {
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

pub(super) fn extract_optional_attr_string_map(
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

pub(super) fn extract_required_attr_string_map(
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

pub(super) fn step_default_app_label(block: &hcl::Block) -> String {
    block
        .body
        .attributes()
        .find(|attr| attr.key.as_str() == "name")
        .map_or_else(
            || "app".into(),
            |attr| extract_string(&attr.expr).unwrap_or_else(|_| "app".into()),
        )
}

pub(super) fn extract_string_array(expr: &hcl::Expression) -> Result<Vec<String>, ScenarioError> {
    match expr {
        hcl::Expression::Array(array) => array.iter().map(extract_string).collect(),
        _ => Err(ScenarioError::InvalidScenario(format!(
            "expected array, got {expr:?}"
        ))),
    }
}

pub(super) fn expr_to_json(expr: &hcl::Expression) -> Result<serde_json::Value, ScenarioError> {
    match expr {
        hcl::Expression::String(value) => Ok(serde_json::Value::String(value.clone())),
        hcl::Expression::TemplateExpr(_) => Ok(serde_json::Value::String(extract_string(expr)?)),
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
