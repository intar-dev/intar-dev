#![allow(clippy::too_many_lines)]

use anyhow::{Context, Result};
use intar_contracts::guest::RUNTIME_AUTHORIZED_KEYS_FILENAME;
use intar_image_scenario::{
    KINO_VSOCK_CID_PLACEHOLDER, KINO_VSOCK_PORT_PLACEHOLDER, KinoProbeKind, Scenario, VmAction,
    VmDefinition, VmStep,
};
use std::fmt::Write as _;

use crate::rootfs::{
    BASE_RUNTIME_MODULES, INTAR_ACPI_EVENT_PATH, INTAR_ACPI_EVENT_RULE, INTAR_ACPI_POWEROFF_PATH,
    INTAR_ACPI_POWEROFF_SCRIPT, KUBERNETES_RUNTIME_MODULES,
};

const DEFAULT_USERNAME: &str = "ubuntu";
const RECORDING_MOUNT_PATH: &str = "/var/lib/kino-recordings";
const RECORDING_CONFIG_PATH: &str = "/etc/kino/ssh-recording.hcl";
const KINO_SHELL_PATH: &str = "/usr/local/bin/kino-shell";
const INTAR_SCENARIO_SUPERVISOR_PATH: &str = "/usr/local/bin/intar-scenario-supervisor.sh";
const INTAR_BOOTSTRAP_SCRIPT_PATH: &str = "/usr/local/bin/intar-bootstrap.sh";
const EPHEMERAL_APT_CONFIG_PATH: &str = "/etc/apt/apt.conf.d/99intar-ephemeral";
const KINO_RUNTIME_CONFIG_PATH: &str = "/run/intar/kino.hcl";
const FAILED_STEP_LOG_TAIL_BYTES: usize = 64 * 1024;
// The virtio-net device and its final udev name are not guaranteed to exist
// when the scenario supervisor first runs. Bound discovery and configuration
// by monotonic wall time so fractional CPU quotas cannot turn a transient boot
// race into either an immediate poweroff or an unbounded startup.
const GUEST_NETWORK_READY_TIMEOUT_SECONDS: u64 = 30;
// At 125 millicores the old nominal ten-second retry loop has an approximately
// 80-second CPU-scaled budget. Allow 50% headroom, measured against monotonic
// uptime. Capping this phase at 120 seconds leaves a nominal 240 seconds of the
// agent's 360-second whole-runtime window for the other first-boot phases.
const GUEST_SSH_READY_TIMEOUT_SECONDS: u64 = 2 * 60;

pub fn render_scenario_provision_script(scenario: &Scenario, vm: &VmDefinition) -> Result<String> {
    let mut script = String::new();
    let derived_kino = scenario
        .derive_kino_config_for_vm(&vm.name)
        .context("failed to derive Kino config")?;
    let kino_template = derived_kino.config_hcl.clone();
    let scenario_motd = render_scenario_motd(scenario, &derived_kino.probe_descriptors)
        .context("failed to render scenario motd")?;
    let requires_kubernetes_modules = derived_kino
        .probe_descriptors
        .iter()
        .any(|probe| probe.kind == KinoProbeKind::K8sPodState)
        || vm
            .steps
            .iter()
            .flat_map(|step| &step.actions)
            .any(|action| {
                matches!(
                    action,
                    VmAction::K8sApply { .. }
                        | VmAction::K8sNamespace { .. }
                        | VmAction::K8sDeployment { .. }
                        | VmAction::K8sService { .. }
                        | VmAction::K8sScaleDeployment { .. }
                )
            });
    let step_scripts = render_vm_step_scripts(vm)?;

    writeln!(script, "#!/usr/bin/env bash").context("format error")?;
    writeln!(script, "set -euo pipefail").context("format error")?;
    writeln!(script).context("format error")?;
    writeln!(
        script,
        "bootstrap_username={}",
        shell_quote(DEFAULT_USERNAME)
    )
    .context("format error")?;
    writeln!(
        script,
        "kino_vsock_cid_placeholder={}",
        shell_quote(KINO_VSOCK_CID_PLACEHOLDER)
    )
    .context("format error")?;
    writeln!(
        script,
        "kino_vsock_port_placeholder={}",
        shell_quote(KINO_VSOCK_PORT_PLACEHOLDER)
    )
    .context("format error")?;
    writeln!(script).context("format error")?;
    // The mmdebstrap base rootfs ships without apt package lists, so package
    // installs must be able to lazily run apt-get update first.
    append_package_helpers(&mut script, &vm.packages, &step_scripts, true)?;
    append_script_body(
        &mut script,
        &kino_template,
        &scenario_motd,
        &step_scripts,
        vm,
        requires_kubernetes_modules,
    )?;
    Ok(script)
}

fn append_package_helpers(
    script: &mut String,
    required_packages: &[String],
    step_scripts: &[GeneratedStepScript],
    allow_apt_update: bool,
) -> Result<()> {
    writeln!(script, "log_phase() {{").context("format error")?;
    writeln!(script, "  local phase=\"$1\"").context("format error")?;
    writeln!(script, "  local status=\"$2\"").context("format error")?;
    writeln!(
        script,
        "  printf '[intar-build] ts=%s phase=%s status=%s\\n' \"$(date -Ins)\" \"$phase\" \"$status\""
    )
    .context("format error")?;
    writeln!(script, "}}").context("format error")?;
    writeln!(script).context("format error")?;
    if allow_apt_update {
        writeln!(script, "apt_lists_updated=0").context("format error")?;
        writeln!(script).context("format error")?;
        writeln!(script, "ensure_package_lists_updated() {{").context("format error")?;
        writeln!(script, "  if [ \"$apt_lists_updated\" -eq 1 ]; then").context("format error")?;
        writeln!(script, "    return").context("format error")?;
        writeln!(script, "  fi").context("format error")?;
        writeln!(script, "  log_phase apt_update start").context("format error")?;
        writeln!(script, "  apt-get update").context("format error")?;
        writeln!(script, "  log_phase apt_update end").context("format error")?;
        writeln!(script, "  apt_lists_updated=1").context("format error")?;
        writeln!(script, "}}").context("format error")?;
        writeln!(script).context("format error")?;
    }
    writeln!(script, "install_packages() {{").context("format error")?;
    writeln!(script, "  local phase=\"$1\"").context("format error")?;
    writeln!(script, "  shift").context("format error")?;
    writeln!(script, "  if [ \"$#\" -eq 0 ]; then").context("format error")?;
    writeln!(script, "    return").context("format error")?;
    writeln!(script, "  fi").context("format error")?;
    if allow_apt_update {
        writeln!(script, "  ensure_package_lists_updated").context("format error")?;
    }
    writeln!(script, "  log_phase \"$phase\" start").context("format error")?;
    writeln!(
        script,
        "  DEBIAN_FRONTEND=noninteractive apt-get install -y \"$@\""
    )
    .context("format error")?;
    writeln!(script, "  log_phase \"$phase\" end").context("format error")?;
    writeln!(script, "}}").context("format error")?;
    writeln!(script).context("format error")?;
    writeln!(script, "write_text_file() {{").context("format error")?;
    writeln!(script, "  local path=\"$1\"").context("format error")?;
    writeln!(script, "  local mode=\"$2\"").context("format error")?;
    writeln!(script, "  local marker=\"$3\"").context("format error")?;
    writeln!(script, "  install -d -m 0755 \"$(dirname -- \"$path\")\"").context("format error")?;
    writeln!(script, "  cat >\"$path\" <<EOF_TEXT").context("format error")?;
    writeln!(script, "$marker").context("format error")?;
    writeln!(script, "EOF_TEXT").context("format error")?;
    writeln!(script, "  chmod \"$mode\" \"$path\"").context("format error")?;
    writeln!(script, "}}").context("format error")?;
    writeln!(script).context("format error")?;
    let mut required_packages = required_packages.to_vec();
    required_packages.sort();
    required_packages.dedup();

    writeln!(
        script,
        "required_packages=({})",
        required_packages
            .iter()
            .map(|package| shell_quote(package))
            .collect::<Vec<_>>()
            .join(" ")
    )
    .context("format error")?;
    writeln!(script, "step_script_paths=()").context("format error")?;
    for generated in step_scripts {
        writeln!(
            script,
            "step_script_paths+=({})",
            shell_quote(&generated.path)
        )
        .context("format error")?;
    }
    writeln!(script).context("format error")?;
    Ok(())
}

fn append_script_body(
    script: &mut String,
    kino_template: &str,
    scenario_motd: &str,
    step_scripts: &[GeneratedStepScript],
    vm: &VmDefinition,
    requires_kubernetes_modules: bool,
) -> Result<()> {
    writeln!(script, "install -d -m 0755 /usr/share/keyrings").context("format error")?;
    writeln!(
        script,
        "initial_boot_files=\"$(find /boot -mindepth 1 -maxdepth 1 -printf '%P\\n' 2>/dev/null | sort || true)\""
    )
    .context("format error")?;
    writeln!(script).context("format error")?;
    writeln!(
        script,
        "install_packages scenario_packages \"${{required_packages[@]}}\""
    )
    .context("format error")?;
    append_apt_cleanup_config(script)?;
    writeln!(
        script,
        "install -d -m 0770 {}",
        shell_quote(RECORDING_MOUNT_PATH)
    )
    .context("format error")?;

    append_step_scripts(script, step_scripts)?;

    append_runtime_assets(
        script,
        kino_template,
        scenario_motd,
        vm,
        requires_kubernetes_modules,
    )?;

    writeln!(
        script,
        "install -d -o root -g root -m 0755 /etc/systemd/system/ssh.service.d"
    )
    .context("format error")?;
    writeln!(
        script,
        "cat >/etc/systemd/system/ssh.service.d/10-intar-gate.conf <<'EOF_SSH_GATE'"
    )
    .context("format error")?;
    writeln!(script, "[Unit]").context("format error")?;
    writeln!(script, "ConditionPathExists=/run/intar/ssh-ready").context("format error")?;
    writeln!(script, "StartLimitIntervalSec=120s").context("format error")?;
    writeln!(script, "StartLimitBurst=3").context("format error")?;
    writeln!(script).context("format error")?;
    writeln!(script, "[Service]").context("format error")?;
    writeln!(script, "RestartSec=2s").context("format error")?;
    writeln!(script, "EOF_SSH_GATE").context("format error")?;
    writeln!(
        script,
        "chown root:root /etc/systemd/system/ssh.service.d/10-intar-gate.conf"
    )
    .context("format error")?;
    writeln!(
        script,
        "chmod 0644 /etc/systemd/system/ssh.service.d/10-intar-gate.conf"
    )
    .context("format error")?;
    writeln!(script, "systemctl daemon-reload").context("format error")?;
    writeln!(script, "systemctl enable intar-scenario.service").context("format error")?;
    writeln!(
        script,
        "systemctl disable ssh.service sshd.service ssh.socket >/dev/null 2>&1 || true"
    )
    .context("format error")?;
    writeln!(script, "systemctl mask ssh.socket >/dev/null").context("format error")?;
    writeln!(
        script,
        "if [ \"$(systemctl is-enabled ssh.service 2>/dev/null || true)\" != disabled ]; then echo 'failed to disable automatic SSH service activation' >&2; exit 1; fi"
    )
    .context("format error")?;
    writeln!(
        script,
        "sshd_enablement=\"$(systemctl is-enabled sshd.service 2>/dev/null || true)\""
    )
    .context("format error")?;
    writeln!(script, "case \"$sshd_enablement\" in").context("format error")?;
    writeln!(script, "  alias|disabled|not-found) ;;").context("format error")?;
    writeln!(
        script,
        "  *) echo \"unsafe sshd.service enablement state: $sshd_enablement\" >&2; exit 1 ;;"
    )
    .context("format error")?;
    writeln!(script, "esac").context("format error")?;
    writeln!(
        script,
        "if [ \"$(systemctl is-enabled ssh.socket 2>/dev/null || true)\" != masked ]; then echo 'failed to mask SSH socket activation' >&2; exit 1; fi"
    )
    .context("format error")?;
    writeln!(
        script,
        "rm -f /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub"
    )
    .context("format error")?;
    writeln!(
        script,
        "for unit in systemd-networkd-wait-online.service NetworkManager-wait-online.service; do systemctl disable \"$unit\" >/dev/null 2>&1 || true; done"
    )
    .context("format error")?;
    writeln!(script, "systemctl set-default multi-user.target").context("format error")?;
    append_scenario_image_finalization(script)?;
    append_final_cleanup(script)
}

fn append_scenario_image_finalization(script: &mut String) -> Result<()> {
    writeln!(script, "log_phase image_finalize start").context("format error")?;
    writeln!(
        script,
        "systemctl disable intar-build.service >/dev/null 2>&1 || true"
    )
    .context("format error")?;
    writeln!(
        script,
        "rm -f /etc/systemd/system/intar-build.service /usr/local/sbin/intar-build-start /etc/pam.d/intar-build"
    )
    .context("format error")?;
    writeln!(
        script,
        "rm -f /home/${{bootstrap_username}}/.ssh/authorized_keys"
    )
    .context("format error")?;
    writeln!(
        script,
        "final_boot_files=\"$(find /boot -mindepth 1 -maxdepth 1 -printf '%P\\n' 2>/dev/null | sort || true)\""
    )
    .context("format error")?;
    writeln!(
        script,
        "if [ \"$final_boot_files\" != \"$initial_boot_files\" ]; then"
    )
    .context("format error")?;
    writeln!(
        script,
        "  echo 'scenario provisioning changed /boot; installing kernels in scenarios is not supported' >&2"
    )
    .context("format error")?;
    writeln!(
        script,
        "  printf 'before:\\n%s\\nafter:\\n%s\\n' \"$initial_boot_files\" \"$final_boot_files\" >&2"
    )
    .context("format error")?;
    writeln!(script, "  exit 1").context("format error")?;
    writeln!(script, "fi").context("format error")?;
    writeln!(script, "fstrim -v / || true").context("format error")?;
    writeln!(script, "log_phase image_finalize end").context("format error")?;
    Ok(())
}

fn append_step_scripts(script: &mut String, step_scripts: &[GeneratedStepScript]) -> Result<()> {
    for generated in step_scripts {
        writeln!(
            script,
            "cat <<'{}' > {}",
            generated.marker,
            shell_quote(&generated.path)
        )
        .context("format error")?;
        script.push_str(&generated.content);
        if !generated.content.ends_with('\n') {
            script.push('\n');
        }
        writeln!(script, "{}", generated.marker).context("format error")?;
        writeln!(script, "chmod 0755 {}", shell_quote(&generated.path)).context("format error")?;
        writeln!(
            script,
            "log_phase {} start",
            shell_quote(&generated.phase_name)
        )
        .context("format error")?;
        if generated.hidden {
            writeln!(script, "bash {}", shell_quote(&generated.path)).context("format error")?;
            writeln!(
                script,
                "log_phase {} end",
                shell_quote(&generated.phase_name)
            )
            .context("format error")?;
        } else {
            let log_path = generated
                .log_path
                .as_deref()
                .context("visible scenario step is missing its log path")?;
            writeln!(script, "if bash {}; then", shell_quote(&generated.path))
                .context("format error")?;
            writeln!(
                script,
                "  log_phase {} end",
                shell_quote(&generated.phase_name)
            )
            .context("format error")?;
            writeln!(script, "else").context("format error")?;
            writeln!(script, "  step_status=$?").context("format error")?;
            writeln!(script, "  step_log={}", shell_quote(log_path)).context("format error")?;
            writeln!(
                script,
                "  printf '[intar-build] scenario step failed: phase=%s status=%s log=%s; showing last {FAILED_STEP_LOG_TAIL_BYTES} bytes\\n' {} \"$step_status\" \"$step_log\" >&2",
                shell_quote(&generated.phase_name)
            )
            .context("format error")?;
            writeln!(script, "  if [ -f \"$step_log\" ]; then").context("format error")?;
            writeln!(
                script,
                "    tail -c {FAILED_STEP_LOG_TAIL_BYTES} -- \"$step_log\" >&2 || true"
            )
            .context("format error")?;
            writeln!(script, "  else").context("format error")?;
            writeln!(
                script,
                "    printf '[intar-build] scenario step log unavailable: %s\\n' \"$step_log\" >&2"
            )
            .context("format error")?;
            writeln!(script, "  fi").context("format error")?;
            writeln!(
                script,
                "  printf '\\n[intar-build] end scenario step failure log: phase=%s\\n' {} >&2",
                shell_quote(&generated.phase_name)
            )
            .context("format error")?;
            writeln!(script, "  exit \"$step_status\"").context("format error")?;
            writeln!(script, "fi").context("format error")?;
        }
        if generated.hidden {
            writeln!(script, "rm -f {}", shell_quote(&generated.path)).context("format error")?;
        }
        writeln!(script).context("format error")?;
    }
    Ok(())
}

fn append_apt_cleanup_config(script: &mut String) -> Result<()> {
    // Remove unnecessary packages to reduce image size
    writeln!(script, "log_phase package_cleanup start").context("format error")?;
    writeln!(
        script,
        "DEBIAN_FRONTEND=noninteractive apt-get remove -y --purge man-db manpages vim-common vim-tiny popularity-contest installation-report laptop-detect 2>/dev/null || true"
    )
    .context("format error")?;
    writeln!(script, "apt-get autoremove -y --purge || true").context("format error")?;
    writeln!(script, "log_phase package_cleanup end").context("format error")?;
    writeln!(script).context("format error")?;
    writeln!(
        script,
        "cat >{} <<'EOF_APT'",
        shell_quote(EPHEMERAL_APT_CONFIG_PATH)
    )
    .context("format error")?;
    writeln!(script, "APT::Periodic::Enable \"0\";").context("format error")?;
    writeln!(script, "APT::Periodic::Update-Package-Lists \"0\";").context("format error")?;
    writeln!(
        script,
        "APT::Periodic::Download-Upgradeable-Packages \"0\";"
    )
    .context("format error")?;
    writeln!(script, "APT::Periodic::AutocleanInterval \"0\";").context("format error")?;
    writeln!(script, "APT::Periodic::Unattended-Upgrade \"0\";").context("format error")?;
    writeln!(script, "Acquire::Languages \"none\";").context("format error")?;
    writeln!(script, "Acquire::PDiffs \"false\";").context("format error")?;
    writeln!(script, "Acquire::Retries \"3\";").context("format error")?;
    writeln!(
        script,
        "Binary::apt::APT::Keep-Downloaded-Packages \"false\";"
    )
    .context("format error")?;
    writeln!(script, "EOF_APT").context("format error")?;
    writeln!(
        script,
        "chmod 0644 {}",
        shell_quote(EPHEMERAL_APT_CONFIG_PATH)
    )
    .context("format error")?;
    writeln!(script).context("format error")?;
    Ok(())
}

fn append_final_cleanup(script: &mut String) -> Result<()> {
    writeln!(script).context("format error")?;
    writeln!(script, "log_phase acpi_poweroff_handler start").context("format error")?;
    writeln!(
        script,
        "install -d -o root -g root -m 0755 /etc/acpi/events"
    )
    .context("format error")?;
    writeln!(
        script,
        "cat >{} <<'EOF_INTAR_ACPI_EVENT'",
        shell_quote(INTAR_ACPI_EVENT_PATH)
    )
    .context("format error")?;
    script.push_str(INTAR_ACPI_EVENT_RULE);
    writeln!(script, "EOF_INTAR_ACPI_EVENT").context("format error")?;
    writeln!(
        script,
        "cat >{} <<'EOF_INTAR_ACPI_POWEROFF'",
        shell_quote(INTAR_ACPI_POWEROFF_PATH)
    )
    .context("format error")?;
    script.push_str(INTAR_ACPI_POWEROFF_SCRIPT);
    writeln!(script, "EOF_INTAR_ACPI_POWEROFF").context("format error")?;
    writeln!(
        script,
        "chown root:root {} {}",
        shell_quote(INTAR_ACPI_EVENT_PATH),
        shell_quote(INTAR_ACPI_POWEROFF_PATH)
    )
    .context("format error")?;
    writeln!(script, "chmod 0644 {}", shell_quote(INTAR_ACPI_EVENT_PATH))
        .context("format error")?;
    writeln!(
        script,
        "chmod 0755 {}",
        shell_quote(INTAR_ACPI_POWEROFF_PATH)
    )
    .context("format error")?;
    writeln!(script, "systemctl enable acpid.service >/dev/null").context("format error")?;
    writeln!(script, "if ! systemctl restart acpid.service; then").context("format error")?;
    writeln!(
        script,
        "  systemctl status --no-pager --full acpid.service >&2 || true"
    )
    .context("format error")?;
    writeln!(
        script,
        "  echo 'failed to restart ACPI poweroff handler' >&2"
    )
    .context("format error")?;
    writeln!(script, "  exit 1").context("format error")?;
    writeln!(script, "fi").context("format error")?;
    writeln!(
        script,
        "if ! systemctl is-active --quiet acpid.service; then"
    )
    .context("format error")?;
    writeln!(
        script,
        "  systemctl status --no-pager --full acpid.service >&2 || true"
    )
    .context("format error")?;
    writeln!(script, "  echo 'ACPI poweroff handler is not active' >&2").context("format error")?;
    writeln!(script, "  exit 1").context("format error")?;
    writeln!(script, "fi").context("format error")?;
    writeln!(script, "log_phase acpi_poweroff_handler end").context("format error")?;
    writeln!(script).context("format error")?;
    writeln!(script, "log_phase cleanup start").context("format error")?;
    writeln!(script, "apt-get clean || true").context("format error")?;
    writeln!(
        script,
        "rm -rf /usr/share/doc/* /usr/share/man/* /tmp/* /var/tmp/* || true"
    )
    .context("format error")?;
    writeln!(script, "journalctl --rotate || true").context("format error")?;
    writeln!(script, "journalctl --vacuum-time=1s || true").context("format error")?;
    writeln!(
        script,
        "find /var/log -type f -exec truncate -s 0 {{}} + || true"
    )
    .context("format error")?;
    writeln!(script, "truncate -s 0 /etc/machine-id").context("format error")?;
    writeln!(script, "rm -f /var/lib/dbus/machine-id").context("format error")?;
    writeln!(script, "log_phase cleanup end").context("format error")?;
    writeln!(script, "sync").context("format error")?;
    Ok(())
}

mod runtime_assets;
use runtime_assets::*;
mod steps;
use steps::*;
#[cfg(test)]
mod tests;
