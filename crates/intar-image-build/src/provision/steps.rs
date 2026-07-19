use super::*;

pub(super) fn render_scenario_motd(
    scenario: &Scenario,
    probe_descriptors: &[intar_image_scenario::KinoProbeDescriptor],
) -> Result<String> {
    let mut output = String::new();
    let title = scenario.title.trim();
    let description = scenario.description.trim();
    let mut wrote_header = false;

    if !title.is_empty() {
        writeln!(output, "{title}").context("format error")?;
        wrote_header = true;
    }

    if !description.is_empty() {
        if wrote_header {
            writeln!(output).context("format error")?;
        }
        writeln!(output, "{description}").context("format error")?;
        wrote_header = true;
    }

    if wrote_header {
        writeln!(output).context("format error")?;
    }

    for probe in probe_descriptors {
        writeln!(output, "- {}", probe.label.trim()).context("format error")?;
    }
    Ok(output)
}

#[derive(Debug, Clone)]
pub(super) struct GeneratedStepScript {
    pub(super) content: String,
    pub(super) hidden: bool,
    pub(super) log_path: Option<String>,
    pub(super) marker: String,
    pub(super) path: String,
    pub(super) phase_name: String,
}

pub(super) fn render_vm_step_scripts(vm: &VmDefinition) -> Result<Vec<GeneratedStepScript>> {
    let mut scripts = Vec::new();
    let vm_slug = slugify(&vm.name);

    for (index, step) in vm.steps.iter().enumerate() {
        let step_slug = slugify(&step.name);
        let hidden = is_hidden_step(step);
        let path = if hidden {
            format!("/run/intar-step-{vm_slug}-{step_slug}.sh")
        } else {
            format!("/usr/local/bin/intar-step-{vm_slug}-{step_slug}.sh")
        };
        let log_path = (!hidden).then(|| format!("/var/log/intar/step-{vm_slug}-{step_slug}.log"));
        let marker = format!("INTAR_STEP_SCRIPT_{index}");
        let content = render_step_script(&vm_slug, &step_slug, step, hidden, log_path.as_deref())?;
        scripts.push(GeneratedStepScript {
            content,
            hidden,
            log_path,
            marker,
            path,
            phase_name: format!("step_{vm_slug}_{step_slug}"),
        });
    }

    Ok(scripts)
}

pub(super) fn render_step_script(
    vm_slug: &str,
    step_slug: &str,
    step: &VmStep,
    hidden: bool,
    log_path: Option<&str>,
) -> Result<String> {
    let mut script = String::new();
    writeln!(script, "#!/usr/bin/env bash").context("format error")?;
    writeln!(script, "set -euo pipefail").context("format error")?;

    if hidden {
        writeln!(script, "trap 'rm -f -- \"$0\"' EXIT").context("format error")?;
        writeln!(script, "exec >/dev/null 2>&1").context("format error")?;
    } else {
        let log_path = log_path.context("visible scenario step is missing its log path")?;
        writeln!(script, "LOG_DIR=/var/log/intar").context("format error")?;
        writeln!(script, "mkdir -p \"$LOG_DIR\"").context("format error")?;
        writeln!(script, "exec >{} 2>&1", shell_quote(log_path)).context("format error")?;
        writeln!(
            script,
            "echo \"[intar] step {vm_slug}/{step_slug} starting\""
        )
        .context("format error")?;
    }

    for (index, action) in step.actions.iter().enumerate() {
        render_step_action(&mut script, step_slug, index, action)?;
    }

    if !hidden {
        writeln!(
            script,
            "echo \"[intar] step {vm_slug}/{step_slug} complete\""
        )
        .context("format error")?;
    }

    Ok(script)
}

pub(super) fn render_step_action(
    script: &mut String,
    step_slug: &str,
    index: usize,
    action: &VmAction,
) -> Result<()> {
    match action {
        VmAction::FileDelete { path } => {
            writeln!(script, "rm -f -- {}", shell_quote(path)).context("format error")?;
        }
        VmAction::FileWrite {
            path,
            content,
            permissions,
        } => {
            let marker = format!("INTAR_STEP_FILE_{step_slug}_{index}");
            writeln!(
                script,
                "install -d -m 0755 -- \"$(dirname -- {})\"",
                shell_quote(path)
            )
            .context("format error")?;
            writeln!(script, "cat <<'{marker}' > {}", shell_quote(path)).context("format error")?;
            script.push_str(content);
            if !content.ends_with('\n') {
                script.push('\n');
            }
            writeln!(script, "{marker}").context("format error")?;
            if let Some(permissions) = permissions.as_deref() {
                writeln!(script, "chmod {permissions} -- {}", shell_quote(path))
                    .context("format error")?;
            }
        }
        VmAction::FileReplace {
            path,
            pattern,
            replacement,
            regex,
        } => {
            let path_value = serde_json::to_string(path).context("failed to encode path")?;
            let pattern_value =
                serde_json::to_string(pattern).context("failed to encode pattern")?;
            let replacement_value =
                serde_json::to_string(replacement).context("failed to encode replacement")?;
            writeln!(script, "python3 - <<'PY'").context("format error")?;
            writeln!(script, "from pathlib import Path").context("format error")?;
            writeln!(script, "import re").context("format error")?;
            writeln!(script, "path = {path_value}").context("format error")?;
            writeln!(script, "pattern = {pattern_value}").context("format error")?;
            writeln!(script, "replacement = {replacement_value}").context("format error")?;
            writeln!(script, "data = Path(path).read_text(encoding='utf-8')")
                .context("format error")?;
            if *regex {
                writeln!(
                    script,
                    "new = re.sub(pattern, replacement, data, flags=re.MULTILINE)"
                )
                .context("format error")?;
            } else {
                writeln!(script, "new = data.replace(pattern, replacement)")
                    .context("format error")?;
            }
            writeln!(script, "Path(path).write_text(new, encoding='utf-8')")
                .context("format error")?;
            writeln!(script, "PY").context("format error")?;
        }
        VmAction::Systemctl { unit, action } => {
            let action_value = match action {
                intar_image_scenario::SystemctlAction::Start => "start",
                intar_image_scenario::SystemctlAction::Stop => "stop",
                intar_image_scenario::SystemctlAction::Restart => "restart",
                intar_image_scenario::SystemctlAction::Enable => "enable",
                intar_image_scenario::SystemctlAction::Disable => "disable",
                intar_image_scenario::SystemctlAction::EnableNow => "enable --now",
            };
            writeln!(script, "systemctl {action_value} {}", shell_quote(unit))
                .context("format error")?;
        }
        VmAction::Command { cmd } => {
            script.push('\n');
            script.push_str(cmd);
            if !cmd.ends_with('\n') {
                script.push('\n');
            }
        }
        VmAction::K8sApply {
            manifest,
            kubeconfig,
        } => {
            render_k8s_apply(script, step_slug, index, manifest, kubeconfig.as_deref())?;
        }
        VmAction::K8sNamespace { name, kubeconfig } => {
            let manifest = serde_json::to_string_pretty(&serde_json::json!({
                "apiVersion": "v1",
                "kind": "Namespace",
                "metadata": { "name": name },
            }))
            .context("failed to encode namespace manifest")?;
            render_k8s_apply(script, step_slug, index, &manifest, kubeconfig.as_deref())?;
        }
        VmAction::K8sDeployment {
            name,
            namespace,
            image,
            replicas,
            labels,
            container_port,
            kubeconfig,
        } => {
            let manifest = serde_json::to_string_pretty(&serde_json::json!({
                "apiVersion": "apps/v1",
                "kind": "Deployment",
                "metadata": { "name": name, "namespace": namespace },
                "spec": {
                    "replicas": replicas,
                    "selector": { "matchLabels": labels },
                    "template": {
                        "metadata": { "labels": labels },
                        "spec": {
                            "containers": [{
                                "name": name,
                                "image": image,
                                "ports": [{ "containerPort": container_port }],
                            }]
                        }
                    }
                }
            }))
            .context("failed to encode deployment manifest")?;
            render_k8s_apply(script, step_slug, index, &manifest, kubeconfig.as_deref())?;
        }
        VmAction::K8sService {
            name,
            namespace,
            selector,
            port,
            target_port,
            kubeconfig,
        } => {
            let manifest = serde_json::to_string_pretty(&serde_json::json!({
                "apiVersion": "v1",
                "kind": "Service",
                "metadata": { "name": name, "namespace": namespace },
                "spec": {
                    "selector": selector,
                    "ports": [{ "port": port, "targetPort": target_port }],
                }
            }))
            .context("failed to encode service manifest")?;
            render_k8s_apply(script, step_slug, index, &manifest, kubeconfig.as_deref())?;
        }
        VmAction::K8sScaleDeployment {
            name,
            namespace,
            replicas,
            kubeconfig,
        } => {
            if let Some(kubeconfig) = kubeconfig {
                writeln!(script, "export KUBECONFIG={}", shell_quote(kubeconfig))
                    .context("format error")?;
            } else {
                writeln!(script, "if [ -z \"${{KUBECONFIG:-}}\" ]; then")
                    .context("format error")?;
                writeln!(script, "  if [ -f /etc/rancher/k3s/k3s.yaml ]; then")
                    .context("format error")?;
                writeln!(script, "    export KUBECONFIG=/etc/rancher/k3s/k3s.yaml")
                    .context("format error")?;
                writeln!(script, "  elif [ -f /etc/kubernetes/admin.conf ]; then")
                    .context("format error")?;
                writeln!(script, "    export KUBECONFIG=/etc/kubernetes/admin.conf")
                    .context("format error")?;
                writeln!(script, "  fi").context("format error")?;
                writeln!(script, "fi").context("format error")?;
            }

            writeln!(
                script,
                "kubectl scale {} --replicas={} --namespace {}",
                shell_quote(&format!("deployment/{name}")),
                replicas,
                shell_quote(namespace)
            )
            .context("format error")?;
        }
    }

    Ok(())
}

pub(super) fn render_k8s_apply(
    script: &mut String,
    step_slug: &str,
    index: usize,
    manifest: &str,
    kubeconfig: Option<&str>,
) -> Result<()> {
    if let Some(kubeconfig) = kubeconfig {
        writeln!(script, "export KUBECONFIG={}", shell_quote(kubeconfig))
            .context("format error")?;
    } else {
        writeln!(script, "if [ -z \"${{KUBECONFIG:-}}\" ]; then").context("format error")?;
        writeln!(script, "  if [ -f /etc/rancher/k3s/k3s.yaml ]; then").context("format error")?;
        writeln!(script, "    export KUBECONFIG=/etc/rancher/k3s/k3s.yaml")
            .context("format error")?;
        writeln!(script, "  elif [ -f /etc/kubernetes/admin.conf ]; then")
            .context("format error")?;
        writeln!(script, "    export KUBECONFIG=/etc/kubernetes/admin.conf")
            .context("format error")?;
        writeln!(script, "  fi").context("format error")?;
        writeln!(script, "fi").context("format error")?;
    }

    let marker = format!("INTAR_K8S_MANIFEST_{step_slug}_{index}");
    writeln!(script, "cat <<'{marker}' | kubectl apply -f -").context("format error")?;
    script.push_str(manifest);
    if !manifest.ends_with('\n') {
        script.push('\n');
    }
    writeln!(script, "{marker}").context("format error")?;
    Ok(())
}

pub(super) fn is_hidden_step(step: &VmStep) -> bool {
    let name = step.name.to_lowercase();
    name.starts_with("break") || name.contains("break-") || name.contains("break_")
}

pub(super) fn slugify(input: &str) -> String {
    let mut output = String::new();
    let mut last_dash = false;

    for character in input.chars() {
        let normalized = if character.is_ascii_alphanumeric() {
            Some(character.to_ascii_lowercase())
        } else if character == '-' || character == '_' {
            Some(character)
        } else {
            None
        };

        match normalized {
            Some(character) => {
                output.push(character);
                last_dash = false;
            }
            None if !output.is_empty() && !last_dash => {
                output.push('-');
                last_dash = true;
            }
            None => {}
        }
    }

    while output.ends_with('-') {
        output.pop();
    }

    if output.is_empty() {
        String::from("step")
    } else {
        output
    }
}

pub(super) fn shell_quote(value: &str) -> String {
    let mut output = String::with_capacity(value.len() + 2);
    output.push('\'');
    for character in value.chars() {
        if character == '\'' {
            output.push_str("'\\''");
        } else {
            output.push(character);
        }
    }
    output.push('\'');
    output
}
