#![allow(clippy::too_many_lines)]

use anyhow::{Context, Result};
use intar_image_scenario::{
    KINO_VSOCK_CID_PLACEHOLDER, KINO_VSOCK_PORT_PLACEHOLDER, Scenario, VmAction, VmDefinition,
    VmStep,
};
use std::fmt::Write as _;

const DEFAULT_USERNAME: &str = "ubuntu";
const RECORDING_MOUNT_PATH: &str = "/var/lib/kino-recordings";
const RECORDING_CONFIG_PATH: &str = "/etc/kino/ssh-recording.hcl";
const KINO_SHELL_PATH: &str = "/usr/local/bin/kino-shell";
const INTAR_SCENARIO_SUPERVISOR_PATH: &str = "/usr/local/bin/intar-scenario-supervisor.sh";
const INTAR_BOOTSTRAP_SCRIPT_PATH: &str = "/usr/local/bin/intar-bootstrap.sh";
const EPHEMERAL_APT_CONFIG_PATH: &str = "/etc/apt/apt.conf.d/99intar-ephemeral";
const KINO_RUNTIME_CONFIG_PATH: &str = "/run/intar/kino.hcl";
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
        scenario,
        vm,
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
    _scenario: &Scenario,
    vm: &VmDefinition,
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

    append_runtime_assets(script, kino_template, scenario_motd, vm)?;

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
        "rm -f /etc/systemd/system/intar-build.service /usr/local/sbin/intar-build-start"
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
        writeln!(script, "bash {}", shell_quote(&generated.path)).context("format error")?;
        writeln!(
            script,
            "log_phase {} end",
            shell_quote(&generated.phase_name)
        )
        .context("format error")?;
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
    writeln!(script, "sync").context("format error")?;
    writeln!(script, "truncate -s 0 /etc/machine-id").context("format error")?;
    writeln!(script, "rm -f /var/lib/dbus/machine-id").context("format error")?;
    writeln!(script, "log_phase cleanup end").context("format error")?;
    Ok(())
}

fn append_runtime_assets(
    script: &mut String,
    kino_template: &str,
    scenario_motd: &str,
    _vm: &VmDefinition,
) -> Result<()> {
    writeln!(script, "install -d -m 0755 /etc/kino /etc/intar").context("format error")?;
    writeln!(script).context("format error")?;

    writeln!(
        script,
        "cat >{} <<'EOF_KINO_TEMPLATE'",
        shell_quote("/etc/kino/kino.hcl.tpl")
    )
    .context("format error")?;
    script.push_str(kino_template);
    if !kino_template.ends_with('\n') {
        script.push('\n');
    }
    writeln!(script, "EOF_KINO_TEMPLATE").context("format error")?;
    writeln!(
        script,
        "chmod 0644 {}",
        shell_quote("/etc/kino/kino.hcl.tpl")
    )
    .context("format error")?;
    writeln!(script).context("format error")?;

    writeln!(
        script,
        "cat >{} <<'EOF_REC_CFG'",
        shell_quote(RECORDING_CONFIG_PATH)
    )
    .context("format error")?;
    writeln!(script, "server {{").context("format error")?;
    writeln!(script, "  bind = \"tcp://127.0.0.1:8080\"").context("format error")?;
    writeln!(script, "}}").context("format error")?;
    writeln!(script).context("format error")?;
    writeln!(script, "recording {{").context("format error")?;
    writeln!(script, "  output_dir = \"{RECORDING_MOUNT_PATH}\"").context("format error")?;
    writeln!(script, "  real_shell = \"/bin/bash\"").context("format error")?;
    writeln!(script, "}}").context("format error")?;
    writeln!(script, "EOF_REC_CFG").context("format error")?;
    writeln!(script, "chmod 0644 {}", shell_quote(RECORDING_CONFIG_PATH))
        .context("format error")?;
    writeln!(script).context("format error")?;

    writeln!(script, "cat >/etc/motd <<'EOF_MOTD'").context("format error")?;
    script.push_str(scenario_motd);
    if !scenario_motd.ends_with('\n') {
        script.push('\n');
    }
    writeln!(script, "EOF_MOTD").context("format error")?;
    writeln!(script, "chmod 0644 /etc/motd").context("format error")?;
    writeln!(script, "install -d -m 0755 /etc/update-motd.d").context("format error")?;
    writeln!(
        script,
        "find /etc/update-motd.d -maxdepth 1 -type f -exec chmod -x {{}} + >/dev/null 2>&1 || true"
    )
    .context("format error")?;
    writeln!(script, "rm -f /run/motd.dynamic /var/run/motd.dynamic").context("format error")?;
    writeln!(
        script,
        "for pam_file in /etc/pam.d/login /etc/pam.d/sshd; do"
    )
    .context("format error")?;
    writeln!(script, "  [ -f \"$pam_file\" ] || continue").context("format error")?;
    writeln!(script, "  sed -i '/pam_motd\\.so/d' \"$pam_file\"").context("format error")?;
    writeln!(
        script,
        "  printf '%s\\n' 'session optional pam_motd.so motd=/etc/motd' >>\"$pam_file\""
    )
    .context("format error")?;
    writeln!(script, "done").context("format error")?;
    writeln!(script).context("format error")?;

    writeln!(
        script,
        "cat >{} <<'EOF_KINO_SHELL'",
        shell_quote(KINO_SHELL_PATH)
    )
    .context("format error")?;
    writeln!(script, "#!/bin/sh").context("format error")?;
    writeln!(script, "set -eu").context("format error")?;
    writeln!(script, "config_path=\"{RECORDING_CONFIG_PATH}\"").context("format error")?;
    writeln!(script, "if [ -n \"${{SSH_ORIGINAL_COMMAND:-}}\" ]; then").context("format error")?;
    writeln!(script, "  if [ -t 0 ] && [ -t 1 ]; then").context("format error")?;
    writeln!(script, "    exec /usr/local/bin/kino record-ssh --config \"$config_path\" --shell-startup interactive --command \"$SSH_ORIGINAL_COMMAND\"").context("format error")?;
    writeln!(script, "  fi").context("format error")?;
    writeln!(script, "  exec /usr/local/bin/kino record-command --config \"$config_path\" --command \"$SSH_ORIGINAL_COMMAND\"").context("format error")?;
    writeln!(script, "fi").context("format error")?;
    writeln!(script, "if [ \"${{1:-}}\" = \"-c\" ]; then").context("format error")?;
    writeln!(script, "  if [ -t 0 ] && [ -t 1 ]; then").context("format error")?;
    writeln!(
        script,
        "    exec /usr/local/bin/kino record-ssh --config \"$config_path\" --shell-startup interactive --command \"${{2:-}}\""
    )
    .context("format error")?;
    writeln!(script, "  fi").context("format error")?;
    writeln!(
        script,
        "  exec /usr/local/bin/kino record-command --config \"$config_path\" --command \"${{2:-}}\""
    )
    .context("format error")?;
    writeln!(script, "fi").context("format error")?;
    writeln!(
        script,
        "exec /usr/local/bin/kino record-ssh --config \"$config_path\" --shell-startup interactive"
    )
    .context("format error")?;
    writeln!(script, "EOF_KINO_SHELL").context("format error")?;
    writeln!(script, "chmod 0755 {}", shell_quote(KINO_SHELL_PATH)).context("format error")?;
    writeln!(
        script,
        "grep -qxF {} /etc/shells || printf '%s\\n' {} >> /etc/shells",
        shell_quote(KINO_SHELL_PATH),
        shell_quote(KINO_SHELL_PATH)
    )
    .context("format error")?;
    writeln!(
        script,
        "usermod -s {} {}",
        shell_quote(KINO_SHELL_PATH),
        shell_quote(DEFAULT_USERNAME)
    )
    .context("format error")?;
    writeln!(script).context("format error")?;

    writeln!(
        script,
        "cat >{} <<'EOF_BOOTSTRAP'",
        shell_quote(INTAR_BOOTSTRAP_SCRIPT_PATH)
    )
    .context("format error")?;
    writeln!(script, "#!/usr/bin/env bash").context("format error")?;
    writeln!(script, "set -euo pipefail").context("format error")?;
    writeln!(script, "log_phase() {{").context("format error")?;
    writeln!(
        script,
        "  printf '[intar-runtime] ts=%s phase=%s status=%s\\n' \"$(date -Ins)\" \"$1\" \"$2\""
    )
    .context("format error")?;
    writeln!(script, "}}").context("format error")?;
    writeln!(script).context("format error")?;
    writeln!(script, "install_kino() {{").context("format error")?;
    writeln!(script, "  log_phase kino_install start").context("format error")?;
    writeln!(script, "  install -m 0755 /tmp/kino /usr/local/bin/kino").context("format error")?;
    writeln!(script, "  /usr/local/bin/kino --help >/dev/null 2>&1").context("format error")?;
    writeln!(script, "  log_phase kino_install end").context("format error")?;
    writeln!(script, "}}").context("format error")?;
    writeln!(script).context("format error")?;
    writeln!(script, "install_kino").context("format error")?;
    writeln!(script, "EOF_BOOTSTRAP").context("format error")?;
    writeln!(
        script,
        "chmod 0755 {}",
        shell_quote(INTAR_BOOTSTRAP_SCRIPT_PATH)
    )
    .context("format error")?;
    writeln!(script, "{}", shell_quote(INTAR_BOOTSTRAP_SCRIPT_PATH)).context("format error")?;
    writeln!(script).context("format error")?;

    writeln!(
        script,
        "cat >{} <<'EOF_RUNTIME'",
        shell_quote(INTAR_SCENARIO_SUPERVISOR_PATH)
    )
    .context("format error")?;
    writeln!(script, "#!/usr/bin/env bash").context("format error")?;
    writeln!(script, "set -Eeuo pipefail").context("format error")?;
    writeln!(script, "root_device=\"/dev/vda\"").context("format error")?;
    writeln!(script, "runtime_device=\"/dev/vdb\"").context("format error")?;
    writeln!(script, "recording_device=\"/dev/vdc\"").context("format error")?;
    writeln!(script, "runtime_mount_path=\"/run/intar-runtime\"").context("format error")?;
    writeln!(script, "runtime_state_path=\"/run/intar\"").context("format error")?;
    writeln!(
        script,
        "runtime_env_path=\"$runtime_mount_path/runtime.env\""
    )
    .context("format error")?;
    writeln!(script, "kino_config_path=\"{KINO_RUNTIME_CONFIG_PATH}\"").context("format error")?;
    writeln!(script, "kino_log_path=\"$runtime_state_path/kino.log\"").context("format error")?;
    writeln!(script, "recording_mount_path=\"{RECORDING_MOUNT_PATH}\"").context("format error")?;
    writeln!(script, "recording_user=\"{DEFAULT_USERNAME}\"").context("format error")?;
    writeln!(
        script,
        "ssh_ready_timeout_seconds={GUEST_SSH_READY_TIMEOUT_SECONDS}"
    )
    .context("format error")?;
    writeln!(
        script,
        "network_ready_timeout_seconds={GUEST_NETWORK_READY_TIMEOUT_SECONDS}"
    )
    .context("format error")?;
    writeln!(script, "KINO_PID=\"\"").context("format error")?;
    writeln!(script).context("format error")?;
    writeln!(script, "log_phase() {{").context("format error")?;
    writeln!(
        script,
        "  printf '[intar-runtime] ts=%s phase=%s status=%s\\n' \"$(date -Ins)\" \"$1\" \"$2\""
    )
    .context("format error")?;
    writeln!(script, "}}").context("format error")?;
    writeln!(script).context("format error")?;
    writeln!(script, "report_runtime_error() {{").context("format error")?;
    writeln!(script, "  local status=\"$1\"").context("format error")?;
    writeln!(script, "  local line=\"$2\"").context("format error")?;
    writeln!(script, "  local command=\"$3\"").context("format error")?;
    writeln!(script, "  trap - ERR").context("format error")?;
    writeln!(
        script,
        "  printf '[intar-runtime] ts=%s error=command_failed status=%s line=%s command=%q\\n' \"$(date -Ins)\" \"$status\" \"$line\" \"$command\" >&2"
    )
    .context("format error")?;
    writeln!(script, "  return \"$status\"").context("format error")?;
    writeln!(script, "}}").context("format error")?;
    writeln!(
        script,
        "trap 'report_runtime_error \"$?\" \"$LINENO\" \"$BASH_COMMAND\"' ERR"
    )
    .context("format error")?;
    writeln!(script).context("format error")?;
    writeln!(script, "monotonic_seconds() {{").context("format error")?;
    writeln!(script, "  local uptime").context("format error")?;
    writeln!(script, "  read -r uptime _ </proc/uptime").context("format error")?;
    writeln!(script, "  printf '%s\\n' \"${{uptime%%.*}}\"").context("format error")?;
    writeln!(script, "}}").context("format error")?;
    writeln!(script).context("format error")?;
    writeln!(script, "wait_for_block_device() {{").context("format error")?;
    writeln!(script, "  local device=\"$1\"").context("format error")?;
    writeln!(script, "  local label=\"$2\"").context("format error")?;
    writeln!(script, "  for _ in {{1..100}}; do").context("format error")?;
    writeln!(script, "    if [ -e \"$device\" ]; then").context("format error")?;
    writeln!(script, "      local actual_label").context("format error")?;
    writeln!(
        script,
        "      actual_label=\"$(blkid -s LABEL -o value \"$device\" 2>/dev/null || true)\""
    )
    .context("format error")?;
    writeln!(script, "      if [ \"$actual_label\" = \"$label\" ]; then")
        .context("format error")?;
    writeln!(script, "        return 0").context("format error")?;
    writeln!(script, "      fi").context("format error")?;
    writeln!(script, "    fi").context("format error")?;
    writeln!(script, "    sleep 0.1").context("format error")?;
    writeln!(script, "  done").context("format error")?;
    writeln!(
        script,
        "  echo \"missing $label block device at $device or label did not match\" >&2"
    )
    .context("format error")?;
    writeln!(script, "  return 1").context("format error")?;
    writeln!(script, "}}").context("format error")?;
    writeln!(script).context("format error")?;
    writeln!(script, "grow_root_filesystem() {{").context("format error")?;
    writeln!(script, "  log_phase root_resize start").context("format error")?;
    writeln!(
        script,
        "  resize2fs \"$root_device\" >/dev/null 2>&1 || resize2fs \"$root_device\""
    )
    .context("format error")?;
    writeln!(script, "  log_phase root_resize end").context("format error")?;
    writeln!(script, "}}").context("format error")?;
    writeln!(script).context("format error")?;
    writeln!(script, "find_guest_interface() {{").context("format error")?;
    writeln!(script, "  local path iface").context("format error")?;
    writeln!(script, "  for path in /sys/class/net/*; do").context("format error")?;
    writeln!(script, "    iface=\"${{path##*/}}\"").context("format error")?;
    writeln!(script, "    [ \"$iface\" = \"lo\" ] && continue").context("format error")?;
    writeln!(script, "    printf '%s\\n' \"$iface\"").context("format error")?;
    writeln!(script, "    return 0").context("format error")?;
    writeln!(script, "  done").context("format error")?;
    writeln!(script, "  return 1").context("format error")?;
    writeln!(script, "}}").context("format error")?;
    writeln!(script).context("format error")?;
    writeln!(script, "network_config_error=\"\"").context("format error")?;
    writeln!(script, "try_configure_guest_interface() {{").context("format error")?;
    writeln!(script, "  local guest_iface=\"$1\"").context("format error")?;
    writeln!(script, "  local command_error=\"\"").context("format error")?;
    writeln!(
        script,
        "  if ! command_error=\"$(ip link set dev \"$guest_iface\" up 2>&1)\"; then"
    )
    .context("format error")?;
    writeln!(
        script,
        "    network_config_error=\"ip link set dev $guest_iface up failed: $command_error\""
    )
    .context("format error")?;
    writeln!(script, "    return 1").context("format error")?;
    writeln!(script, "  fi").context("format error")?;
    writeln!(
        script,
        "  if ! command_error=\"$(ip addr flush dev \"$guest_iface\" scope global 2>&1)\"; then"
    )
    .context("format error")?;
    writeln!(
        script,
        "    network_config_error=\"ip addr flush dev $guest_iface scope global failed: $command_error\""
    )
    .context("format error")?;
    writeln!(script, "    return 1").context("format error")?;
    writeln!(script, "  fi").context("format error")?;
    writeln!(
        script,
        "  if ! command_error=\"$(ip addr replace \"$INTAR_GUEST_IP_CIDR\" dev \"$guest_iface\" 2>&1)\"; then"
    )
    .context("format error")?;
    writeln!(
        script,
        "    network_config_error=\"ip addr replace $INTAR_GUEST_IP_CIDR dev $guest_iface failed: $command_error\""
    )
    .context("format error")?;
    writeln!(script, "    return 1").context("format error")?;
    writeln!(script, "  fi").context("format error")?;
    writeln!(
        script,
        "  if ! command_error=\"$(ip route replace default via \"$INTAR_GATEWAY\" dev \"$guest_iface\" 2>&1)\"; then"
    )
    .context("format error")?;
    writeln!(
        script,
        "    network_config_error=\"ip route replace default via $INTAR_GATEWAY dev $guest_iface failed: $command_error\""
    )
    .context("format error")?;
    writeln!(script, "    return 1").context("format error")?;
    writeln!(script, "  fi").context("format error")?;
    writeln!(script, "  return 0").context("format error")?;
    writeln!(script, "}}").context("format error")?;
    writeln!(script).context("format error")?;
    writeln!(script, "wait_for_guest_network() {{").context("format error")?;
    writeln!(script, "  local deadline_seconds guest_iface now_seconds").context("format error")?;
    writeln!(
        script,
        "  deadline_seconds=$(( $(monotonic_seconds) + network_ready_timeout_seconds ))"
    )
    .context("format error")?;
    writeln!(script, "  while true; do").context("format error")?;
    writeln!(script, "    guest_iface=\"\"").context("format error")?;
    writeln!(
        script,
        "    if guest_iface=\"$(find_guest_interface)\"; then"
    )
    .context("format error")?;
    writeln!(
        script,
        "      if try_configure_guest_interface \"$guest_iface\"; then"
    )
    .context("format error")?;
    writeln!(script, "        return 0").context("format error")?;
    writeln!(script, "      fi").context("format error")?;
    writeln!(script, "    else").context("format error")?;
    writeln!(
        script,
        "      network_config_error='no non-loopback interface is present'"
    )
    .context("format error")?;
    writeln!(script, "    fi").context("format error")?;
    writeln!(script, "    now_seconds=\"$(monotonic_seconds)\"").context("format error")?;
    writeln!(
        script,
        "    if [ \"$now_seconds\" -ge \"$deadline_seconds\" ]; then"
    )
    .context("format error")?;
    writeln!(script, "      break").context("format error")?;
    writeln!(script, "    fi").context("format error")?;
    writeln!(script, "    sleep 0.1").context("format error")?;
    writeln!(script, "  done").context("format error")?;
    writeln!(
        script,
        "  echo \"timed out after ${{network_ready_timeout_seconds}}s waiting to configure a non-loopback guest interface\" >&2"
    )
    .context("format error")?;
    writeln!(
        script,
        "  echo \"last network configuration error: $network_config_error\" >&2"
    )
    .context("format error")?;
    writeln!(script, "  ip -details link show >&2 || true").context("format error")?;
    writeln!(script, "  ip -details address show >&2 || true").context("format error")?;
    writeln!(script, "  ip route show table all >&2 || true").context("format error")?;
    writeln!(script, "  return 1").context("format error")?;
    writeln!(script, "}}").context("format error")?;
    writeln!(script).context("format error")?;
    writeln!(script, "wait_for_vsock_ready() {{").context("format error")?;
    writeln!(script, "  for _ in {{1..100}}; do").context("format error")?;
    writeln!(script, "    if [ -c /dev/vsock ]; then").context("format error")?;
    writeln!(script, "      return 0").context("format error")?;
    writeln!(script, "    fi").context("format error")?;
    writeln!(script, "    sleep 0.1").context("format error")?;
    writeln!(script, "  done").context("format error")?;
    writeln!(script, "  echo 'vsock transport did not become ready' >&2")
        .context("format error")?;
    writeln!(script, "  return 1").context("format error")?;
    writeln!(script, "}}").context("format error")?;
    writeln!(script).context("format error")?;
    writeln!(script, "cleanup() {{").context("format error")?;
    writeln!(script, "  local status=$?").context("format error")?;
    writeln!(script, "  if [ -n \"$KINO_PID\" ] && kill -0 \"$KINO_PID\" >/dev/null 2>&1; then kill \"$KINO_PID\" >/dev/null 2>&1 || true; fi").context("format error")?;
    writeln!(script, "  if mountpoint -q \"$runtime_mount_path\"; then umount \"$runtime_mount_path\" >/dev/null 2>&1 || true; fi").context("format error")?;
    writeln!(script, "  if mountpoint -q \"$recording_mount_path\"; then umount \"$recording_mount_path\" >/dev/null 2>&1 || true; fi").context("format error")?;
    writeln!(script, "  exit \"$status\"").context("format error")?;
    writeln!(script, "}}").context("format error")?;
    writeln!(script, "trap cleanup EXIT INT TERM").context("format error")?;
    writeln!(script).context("format error")?;
    writeln!(script, "start_kino() {{").context("format error")?;
    writeln!(script, "  log_phase kino_boot start").context("format error")?;
    writeln!(script, "  install -d -m 0755 \"$runtime_state_path\"").context("format error")?;
    writeln!(
        script,
        "  sed -e \"s/{KINO_VSOCK_CID_PLACEHOLDER}/${{KINO_VSOCK_CID}}/g\" -e \"s/{KINO_VSOCK_PORT_PLACEHOLDER}/${{KINO_VSOCK_PORT}}/g\" /etc/kino/kino.hcl.tpl >\"$kino_config_path\"",
    )
    .context("format error")?;
    writeln!(script, "  chmod 0644 \"$kino_config_path\"").context("format error")?;
    writeln!(script, "  wait_for_vsock_ready").context("format error")?;
    writeln!(script, "  for _ in {{1..100}}; do").context("format error")?;
    writeln!(script, "    : >\"$kino_log_path\"").context("format error")?;
    writeln!(
        script,
        "    /usr/local/bin/kino --config \"$kino_config_path\" >\"$kino_log_path\" 2>&1 &"
    )
    .context("format error")?;
    writeln!(script, "    KINO_PID=\"$!\"").context("format error")?;
    writeln!(script, "    sleep 0.2").context("format error")?;
    writeln!(script, "    if kill -0 \"$KINO_PID\" >/dev/null 2>&1; then")
        .context("format error")?;
    writeln!(script, "      log_phase kino_boot end").context("format error")?;
    writeln!(script, "      return 0").context("format error")?;
    writeln!(script, "    fi").context("format error")?;
    writeln!(script, "    wait \"$KINO_PID\" || true").context("format error")?;
    writeln!(
        script,
        "    if grep -q 'failed to bind vsock://' \"$kino_log_path\"; then"
    )
    .context("format error")?;
    writeln!(script, "      sleep 0.1").context("format error")?;
    writeln!(script, "      continue").context("format error")?;
    writeln!(script, "    fi").context("format error")?;
    writeln!(script, "    cat \"$kino_log_path\" >&2 || true").context("format error")?;
    writeln!(script, "    echo 'kino exited during startup' >&2").context("format error")?;
    writeln!(script, "    exit 1").context("format error")?;
    writeln!(script, "  done").context("format error")?;
    writeln!(script, "  cat \"$kino_log_path\" >&2 || true").context("format error")?;
    writeln!(script, "  echo 'timed out waiting for kino vsock bind' >&2")
        .context("format error")?;
    writeln!(script, "  exit 1").context("format error")?;
    writeln!(script, "}}").context("format error")?;
    writeln!(script).context("format error")?;
    writeln!(script, "configure_guest_network() {{").context("format error")?;
    writeln!(script, "  log_phase network_config start").context("format error")?;
    writeln!(
        script,
        "  printf '%s\\n' \"$INTAR_VM_HOSTNAME\" >/etc/hostname"
    )
    .context("format error")?;
    writeln!(script, "  cat >/etc/hosts <<EOF_HOSTS").context("format error")?;
    writeln!(script, "127.0.0.1 localhost").context("format error")?;
    // Map the VM's own name to its run-network address (not 127.0.1.1) so
    // every VM in a run resolves a given VM name to the same address —
    // cluster software that advertises the resolved hostname address needs
    // this to hand out a peer-reachable IP.
    writeln!(script, "${{INTAR_GUEST_IP_CIDR%%/*}} $INTAR_VM_HOSTNAME").context("format error")?;
    writeln!(script, "::1 localhost ip6-localhost ip6-loopback").context("format error")?;
    writeln!(script, "ff02::1 ip6-allnodes").context("format error")?;
    writeln!(script, "ff02::2 ip6-allrouters").context("format error")?;
    writeln!(script, "EOF_HOSTS").context("format error")?;
    writeln!(
        script,
        "  if [ -n \"${{INTAR_PEER_HOSTS_B64:-}}\" ]; then printf '%s' \"$INTAR_PEER_HOSTS_B64\" | base64 -d >>/etc/hosts; fi"
    )
    .context("format error")?;
    writeln!(script, "  chmod 0644 /etc/hosts").context("format error")?;
    writeln!(script, "  hostname \"$INTAR_VM_HOSTNAME\"").context("format error")?;
    writeln!(script, "  wait_for_guest_network").context("format error")?;
    writeln!(script, "  rm -f /etc/resolv.conf").context("format error")?;
    writeln!(script, "  dns_servers=($INTAR_DNS_SERVERS)").context("format error")?;
    writeln!(script, "  [ \"${{#dns_servers[@]}}\" -gt 0 ] || {{ echo 'INTAR_DNS_SERVERS produced no nameservers' >&2; exit 1; }}").context("format error")?;
    writeln!(script, "  for dns_server in \"${{dns_servers[@]}}\"; do printf 'nameserver %s\\n' \"$dns_server\" >>/etc/resolv.conf; done").context("format error")?;
    writeln!(script, "  chmod 0644 /etc/resolv.conf").context("format error")?;
    writeln!(script, "  log_phase network_config end").context("format error")?;
    writeln!(script, "}}").context("format error")?;
    writeln!(script).context("format error")?;
    writeln!(script, "configure_ssh_access() {{").context("format error")?;
    writeln!(script, "  log_phase ssh_access start").context("format error")?;
    writeln!(
        script,
        "  local home_dir authorized_keys tmp_path decoded_keys key"
    )
    .context("format error")?;
    writeln!(
        script,
        "  home_dir=\"$(getent passwd \"$recording_user\" | cut -d: -f6)\""
    )
    .context("format error")?;
    writeln!(script, "  [ -n \"$home_dir\" ] || {{ echo \"failed to resolve home for $recording_user\" >&2; exit 1; }}").context("format error")?;
    writeln!(
        script,
        "  install -d -m 0700 -o \"$recording_user\" -g \"$recording_user\" \"$home_dir/.ssh\""
    )
    .context("format error")?;
    writeln!(
        script,
        "  authorized_keys=\"$home_dir/.ssh/authorized_keys\""
    )
    .context("format error")?;
    writeln!(script, "  tmp_path=\"$(mktemp)\"").context("format error")?;
    writeln!(
        script,
        "  if [ -f \"$authorized_keys\" ]; then cat \"$authorized_keys\" >\"$tmp_path\"; fi"
    )
    .context("format error")?;
    writeln!(script, "  decoded_keys=\"$(mktemp)\"").context("format error")?;
    writeln!(
        script,
        "  printf '%s' \"$INTAR_SSH_AUTHORIZED_KEYS_B64\" | base64 -d >\"$decoded_keys\""
    )
    .context("format error")?;
    writeln!(script, "  [ -s \"$decoded_keys\" ] || {{ echo 'INTAR_SSH_AUTHORIZED_KEYS_B64 decoded no keys' >&2; exit 1; }}").context("format error")?;
    // `|| [ -n "$key" ]` processes a final line with no trailing newline,
    // which a plain `while read` would otherwise drop.
    writeln!(script, "  while IFS= read -r key || [ -n \"$key\" ]; do").context("format error")?;
    writeln!(script, "    [ -n \"$key\" ] || continue").context("format error")?;
    writeln!(script, "    if ! grep -qxF \"$key\" \"$tmp_path\" 2>/dev/null; then printf '%s\\n' \"$key\" >>\"$tmp_path\"; fi").context("format error")?;
    writeln!(script, "  done <\"$decoded_keys\"").context("format error")?;
    writeln!(script, "  install -m 0600 -o \"$recording_user\" -g \"$recording_user\" \"$tmp_path\" \"$authorized_keys\"").context("format error")?;
    writeln!(script, "  rm -f \"$tmp_path\" \"$decoded_keys\"").context("format error")?;
    writeln!(script, "  log_phase ssh_access end").context("format error")?;
    writeln!(script, "}}").context("format error")?;
    writeln!(script).context("format error")?;
    writeln!(script, "generate_ssh_host_keys() {{").context("format error")?;
    writeln!(script, "  log_phase ssh_host_keys start").context("format error")?;
    writeln!(
        script,
        "  if [ -s /etc/ssh/ssh_host_ed25519_key.pub ]; then"
    )
    .context("format error")?;
    writeln!(script, "    log_phase ssh_host_keys end").context("format error")?;
    writeln!(script, "    return 0").context("format error")?;
    writeln!(script, "  fi").context("format error")?;
    writeln!(
        script,
        "  rm -f /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub"
    )
    .context("format error")?;
    writeln!(
        script,
        "  ssh-keygen -t ed25519 -N '' -f /etc/ssh/ssh_host_ed25519_key >/dev/null"
    )
    .context("format error")?;
    writeln!(
        script,
        "  if [ ! -s /etc/ssh/ssh_host_ed25519_key.pub ]; then"
    )
    .context("format error")?;
    writeln!(
        script,
        "    echo 'failed to create ed25519 SSH host key' >&2"
    )
    .context("format error")?;
    writeln!(script, "    exit 1").context("format error")?;
    writeln!(script, "  fi").context("format error")?;
    writeln!(script, "  log_phase ssh_host_keys end").context("format error")?;
    writeln!(script, "}}").context("format error")?;
    writeln!(script).context("format error")?;
    writeln!(script, "print_sshd_diagnostics() {{").context("format error")?;
    writeln!(
        script,
        "  systemctl status --no-pager --full ssh.service >&2 || true"
    )
    .context("format error")?;
    writeln!(
        script,
        "  journalctl --no-pager --full --unit ssh.service --lines 100 >&2 || true"
    )
    .context("format error")?;
    writeln!(script, "}}").context("format error")?;
    writeln!(script).context("format error")?;
    writeln!(script, "start_sshd() {{").context("format error")?;
    writeln!(script, "  local deadline_seconds now_seconds ssh_active_state ssh_job ssh_properties property value").context("format error")?;
    writeln!(
        script,
        "  deadline_seconds=$(( $(monotonic_seconds) + ssh_ready_timeout_seconds ))"
    )
    .context("format error")?;
    writeln!(script, "  log_phase ssh_boot start").context("format error")?;
    writeln!(script, "  generate_ssh_host_keys").context("format error")?;
    writeln!(script, "  install -d -o root -g root -m 0755 /run/sshd").context("format error")?;
    writeln!(script, "  if ! /usr/sbin/sshd -t; then").context("format error")?;
    writeln!(
        script,
        "    echo 'generated SSH host keys failed sshd configuration validation' >&2"
    )
    .context("format error")?;
    writeln!(script, "    print_sshd_diagnostics").context("format error")?;
    writeln!(script, "    return 1").context("format error")?;
    writeln!(script, "  fi").context("format error")?;
    writeln!(
        script,
        "  install -D -o root -g root -m 0600 /dev/null /run/intar/ssh-ready"
    )
    .context("format error")?;
    writeln!(
        script,
        "  if ! systemctl start --no-block ssh.service; then"
    )
    .context("format error")?;
    writeln!(script, "    echo 'failed to enqueue ssh.service start' >&2")
        .context("format error")?;
    writeln!(script, "    print_sshd_diagnostics").context("format error")?;
    writeln!(script, "    return 1").context("format error")?;
    writeln!(script, "  fi").context("format error")?;
    writeln!(script, "  while true; do").context("format error")?;
    writeln!(script, "    ssh_active_state=unknown").context("format error")?;
    writeln!(script, "    ssh_job=unknown").context("format error")?;
    writeln!(
        script,
        "    ssh_properties=\"$(systemctl show ssh.service --property=ActiveState --property=Job 2>/dev/null || true)\""
    )
    .context("format error")?;
    writeln!(script, "    while IFS='=' read -r property value; do").context("format error")?;
    writeln!(script, "      case \"$property\" in").context("format error")?;
    writeln!(
        script,
        "        ActiveState) ssh_active_state=\"$value\" ;;"
    )
    .context("format error")?;
    writeln!(script, "        Job) ssh_job=\"$value\" ;;").context("format error")?;
    writeln!(script, "      esac").context("format error")?;
    writeln!(script, "    done <<<\"$ssh_properties\"").context("format error")?;
    writeln!(script, "    if [ -z \"$ssh_job\" ]; then").context("format error")?;
    writeln!(script, "      case \"$ssh_active_state\" in").context("format error")?;
    writeln!(script, "        active)").context("format error")?;
    writeln!(script, "          log_phase ssh_boot end").context("format error")?;
    writeln!(script, "          return 0").context("format error")?;
    writeln!(script, "          ;;").context("format error")?;
    writeln!(script, "        failed)").context("format error")?;
    writeln!(
        script,
        "          echo 'ssh.service entered failed state during startup' >&2"
    )
    .context("format error")?;
    writeln!(script, "          print_sshd_diagnostics").context("format error")?;
    writeln!(script, "          return 1").context("format error")?;
    writeln!(script, "          ;;").context("format error")?;
    writeln!(script, "      esac").context("format error")?;
    writeln!(script, "    fi").context("format error")?;
    writeln!(script, "    now_seconds=\"$(monotonic_seconds)\"").context("format error")?;
    writeln!(
        script,
        "    if [ \"$now_seconds\" -ge \"$deadline_seconds\" ]; then"
    )
    .context("format error")?;
    writeln!(script, "      break").context("format error")?;
    writeln!(script, "    fi").context("format error")?;
    writeln!(script, "    sleep 1").context("format error")?;
    writeln!(script, "  done").context("format error")?;
    writeln!(script, "  print_sshd_diagnostics").context("format error")?;
    writeln!(
        script,
        "  echo \"timed out after ${{ssh_ready_timeout_seconds}}s waiting for ssh service to become active\" >&2"
    )
    .context("format error")?;
    writeln!(script, "  return 1").context("format error")?;
    writeln!(script, "}}").context("format error")?;
    writeln!(script).context("format error")?;
    writeln!(script, "grow_root_filesystem").context("format error")?;
    writeln!(script, "log_phase runtime_disk start").context("format error")?;
    writeln!(script, "wait_for_block_device \"$runtime_device\" INTARRUN")
        .context("format error")?;
    writeln!(script, "install -d -m 0755 \"$runtime_mount_path\"").context("format error")?;
    writeln!(script, "mount -t vfat -o ro,nosuid,nodev,noexec,utf8=1,shortname=mixed \"$runtime_device\" \"$runtime_mount_path\"").context("format error")?;
    writeln!(script, "[ -f \"$runtime_env_path\" ] || {{ echo \"missing runtime env at $runtime_env_path\" >&2; exit 1; }}").context("format error")?;
    writeln!(script, "set -a").context("format error")?;
    writeln!(script, ". \"$runtime_env_path\"").context("format error")?;
    writeln!(script, "set +a").context("format error")?;
    // Peer addresses live only in the supervisor's environment; publish them
    // to login shells so scenario text can reference $INTAR_PEER_<VM>_IP in
    // the user's terminal.
    writeln!(script, "{{").context("format error")?;
    writeln!(
        script,
        "  echo '# generated by the intar supervisor: same-run peer VM addresses'"
    )
    .context("format error")?;
    writeln!(
        script,
        "  for peer_env_name in $(compgen -v INTAR_PEER_ || true); do"
    )
    .context("format error")?;
    writeln!(
        script,
        "    printf 'export %s=%q\\n' \"$peer_env_name\" \"${{!peer_env_name}}\""
    )
    .context("format error")?;
    writeln!(script, "  done").context("format error")?;
    writeln!(script, "}} > /etc/profile.d/intar-peers.sh").context("format error")?;
    writeln!(script, "chmod 0644 /etc/profile.d/intar-peers.sh").context("format error")?;
    writeln!(script, "log_phase runtime_disk end").context("format error")?;
    writeln!(
        script,
        ": \"${{INTAR_SSH_AUTHORIZED_KEYS_B64:?INTAR_SSH_AUTHORIZED_KEYS_B64 is required}}\""
    )
    .context("format error")?;
    writeln!(
        script,
        ": \"${{KINO_VSOCK_CID:?KINO_VSOCK_CID is required}}\""
    )
    .context("format error")?;
    writeln!(
        script,
        ": \"${{KINO_VSOCK_PORT:?KINO_VSOCK_PORT is required}}\""
    )
    .context("format error")?;
    writeln!(
        script,
        ": \"${{KINO_HOST_READY_PORT:?KINO_HOST_READY_PORT is required}}\""
    )
    .context("format error")?;
    writeln!(
        script,
        ": \"${{INTAR_VM_HOSTNAME:?INTAR_VM_HOSTNAME is required}}\""
    )
    .context("format error")?;
    writeln!(
        script,
        ": \"${{INTAR_GUEST_IP_CIDR:?INTAR_GUEST_IP_CIDR is required}}\""
    )
    .context("format error")?;
    writeln!(
        script,
        ": \"${{INTAR_GATEWAY:?INTAR_GATEWAY is required}}\""
    )
    .context("format error")?;
    writeln!(
        script,
        ": \"${{INTAR_DNS_SERVERS:?INTAR_DNS_SERVERS is required}}\""
    )
    .context("format error")?;
    writeln!(script).context("format error")?;
    writeln!(script, "log_phase recording_mount start").context("format error")?;
    writeln!(
        script,
        "wait_for_block_device \"$recording_device\" INTARREC"
    )
    .context("format error")?;
    writeln!(script, "recording_uid=\"$(id -u \"$recording_user\")\"").context("format error")?;
    writeln!(script, "recording_gid=\"$(id -g \"$recording_user\")\"").context("format error")?;
    writeln!(script, "install -d -m 0770 \"$recording_mount_path\"").context("format error")?;
    writeln!(
        script,
        "if mountpoint -q \"$recording_mount_path\"; then umount \"$recording_mount_path\"; fi"
    )
    .context("format error")?;
    writeln!(script, "mount -t vfat -o \"rw,sync,dirsync,uid=${{recording_uid}},gid=${{recording_gid}},utf8=1,fmask=0117,dmask=0007,shortname=mixed\" \"$recording_device\" \"$recording_mount_path\"").context("format error")?;
    writeln!(script, "log_phase recording_mount end").context("format error")?;
    writeln!(script, "log_phase recording_canary start").context("format error")?;
    writeln!(
        script,
        "canary_path=\"$recording_mount_path/.intar-kino-write-check\""
    )
    .context("format error")?;
    writeln!(script, "/usr/bin/setpriv --reuid=\"$recording_uid\" --regid=\"$recording_gid\" --clear-groups /bin/sh -c \"umask 077; printf 'ok\\n' >\\\"$canary_path\\\" && rm -f \\\"$canary_path\\\"\"").context("format error")?;
    writeln!(script, "log_phase recording_canary end").context("format error")?;
    writeln!(script).context("format error")?;
    writeln!(script, "configure_guest_network").context("format error")?;
    writeln!(script, "configure_ssh_access").context("format error")?;
    writeln!(script, "start_sshd").context("format error")?;
    writeln!(script, "start_kino").context("format error")?;
    writeln!(script, "log_phase ready end").context("format error")?;
    writeln!(script, "wait -n \"$KINO_PID\" || true").context("format error")?;
    writeln!(script, "if ! kill -0 \"$KINO_PID\" >/dev/null 2>&1; then cat \"$kino_log_path\" >&2 || true; echo 'kino exited unexpectedly' >&2; exit 1; fi").context("format error")?;
    writeln!(script, "echo 'runtime supervisor exited unexpectedly' >&2")
        .context("format error")?;
    writeln!(script, "exit 1").context("format error")?;
    writeln!(script, "EOF_RUNTIME").context("format error")?;
    writeln!(
        script,
        "chmod 0755 {}",
        shell_quote(INTAR_SCENARIO_SUPERVISOR_PATH)
    )
    .context("format error")?;
    writeln!(script).context("format error")?;

    writeln!(
        script,
        "cat >/etc/systemd/system/intar-scenario.service <<'EOF_RUNTIME_UNIT'"
    )
    .context("format error")?;
    writeln!(script, "[Unit]").context("format error")?;
    writeln!(script, "Description=Intar scenario supervisor").context("format error")?;
    writeln!(script, "After=local-fs.target systemd-udev-trigger.service")
        .context("format error")?;
    writeln!(script, "Before=multi-user.target").context("format error")?;
    writeln!(script, "FailureAction=poweroff-force").context("format error")?;
    writeln!(script).context("format error")?;
    writeln!(script, "[Service]").context("format error")?;
    writeln!(script, "Type=simple").context("format error")?;
    writeln!(script, "ExecStart={INTAR_SCENARIO_SUPERVISOR_PATH}").context("format error")?;
    writeln!(script, "KillMode=mixed").context("format error")?;
    writeln!(script, "TimeoutStartSec=30").context("format error")?;
    writeln!(script, "StandardOutput=journal+console").context("format error")?;
    writeln!(script, "StandardError=journal+console").context("format error")?;
    writeln!(script).context("format error")?;
    writeln!(script, "[Install]").context("format error")?;
    writeln!(script, "WantedBy=multi-user.target").context("format error")?;
    writeln!(script, "EOF_RUNTIME_UNIT").context("format error")?;
    writeln!(script).context("format error")?;

    Ok(())
}

fn render_scenario_motd(
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
struct GeneratedStepScript {
    content: String,
    hidden: bool,
    marker: String,
    path: String,
    phase_name: String,
}

fn render_vm_step_scripts(vm: &VmDefinition) -> Result<Vec<GeneratedStepScript>> {
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
        let marker = format!("INTAR_STEP_SCRIPT_{index}");
        let content = render_step_script(&vm_slug, &step_slug, step, hidden)?;
        scripts.push(GeneratedStepScript {
            content,
            hidden,
            marker,
            path,
            phase_name: format!("step_{vm_slug}_{step_slug}"),
        });
    }

    Ok(scripts)
}

fn render_step_script(
    vm_slug: &str,
    step_slug: &str,
    step: &VmStep,
    hidden: bool,
) -> Result<String> {
    let mut script = String::new();
    writeln!(script, "#!/usr/bin/env bash").context("format error")?;
    writeln!(script, "set -euo pipefail").context("format error")?;

    if hidden {
        writeln!(script, "trap 'rm -f -- \"$0\"' EXIT").context("format error")?;
        writeln!(script, "exec >/dev/null 2>&1").context("format error")?;
    } else {
        writeln!(script, "LOG_DIR=/var/log/intar").context("format error")?;
        writeln!(script, "mkdir -p \"$LOG_DIR\"").context("format error")?;
        writeln!(
            script,
            "exec >\"$LOG_DIR/step-{vm_slug}-{step_slug}.log\" 2>&1"
        )
        .context("format error")?;
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

fn render_step_action(
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

fn render_k8s_apply(
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

fn is_hidden_step(step: &VmStep) -> bool {
    let name = step.name.to_lowercase();
    name.starts_with("break") || name.contains("break-") || name.contains("break_")
}

fn slugify(input: &str) -> String {
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

fn shell_quote(value: &str) -> String {
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

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::io::Write as _;
    use std::process::{Command, Output, Stdio};
    use std::thread;
    use std::time::{Duration, Instant};

    use intar_image_scenario::Scenario;

    use super::{render_scenario_provision_script, shell_quote};

    fn render_minimal_provision_script() -> String {
        let scenario = Scenario::parse(
            r#"
scenario "ssh-readiness" {
  title = "SSH Readiness"
  category = "linux"
  tags = ["ssh"]
  difficulty = "easy"
  estimated_minutes = 5
  description = "Verify SSH readiness"
  briefing = "Wait for SSH."
  solution { body = "SSH starts automatically." }

  image "debian-13-minimal" {
    base = "trixie"
  }

  kino {
    probe "ssh-running" {
      kind = "service"
      service = "ssh"
      state = "running"
      description = "SSH should be running"
    }
  }

  vm "server" {
    image = "debian-13-minimal"
    probes = ["ssh-running"]
  }
}
"#,
        )
        .unwrap();
        let vm = scenario.vm_by_name("server").unwrap();
        render_scenario_provision_script(&scenario, vm).unwrap()
    }

    fn render_minimal_supervisor() -> String {
        let provision = render_minimal_provision_script();
        let (_, runtime_and_rest) = provision.split_once("<<'EOF_RUNTIME'\n").unwrap();
        let (runtime, _) = runtime_and_rest.split_once("\nEOF_RUNTIME\n").unwrap();
        format!("{runtime}\n")
    }

    fn render_minimal_supervisor_prefix() -> String {
        let runtime = render_minimal_supervisor();
        let (prefix, _) = runtime.split_once("\ngrow_root_filesystem\n").unwrap();
        format!("{prefix}\n")
    }

    fn run_bash(script: &str, syntax_only: bool) -> Output {
        let mut command = Command::new("bash");
        if syntax_only {
            command.arg("-n");
        }
        let mut child = command
            .arg("-s")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(script.as_bytes()).unwrap();
        drop(stdin);

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if child.try_wait().unwrap().is_some() {
                return child.wait_with_output().unwrap();
            }
            if Instant::now() >= deadline {
                child.kill().unwrap();
                let output = child.wait_with_output().unwrap();
                panic!(
                    "bash harness exceeded five seconds: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn scenario_supervisor_uses_a_monotonic_ssh_readiness_deadline() {
        let script = render_minimal_provision_script();
        assert!(script.contains("ssh_ready_timeout_seconds=120"));
        assert!(script.contains("read -r uptime _ </proc/uptime"));

        let disable_ssh = script
            .find("systemctl disable ssh.service sshd.service ssh.socket")
            .unwrap();
        let install_ssh_gate = script
            .find("/etc/systemd/system/ssh.service.d/10-intar-gate.conf")
            .unwrap();
        let daemon_reload = script.find("systemctl daemon-reload").unwrap();
        let mask_ssh_socket = script.find("systemctl mask ssh.socket").unwrap();
        let remove_host_keys = script
            .rfind("rm -f /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub")
            .unwrap();
        assert!(disable_ssh < remove_host_keys);
        assert!(install_ssh_gate < daemon_reload);
        assert!(daemon_reload < disable_ssh);
        assert!(disable_ssh < mask_ssh_socket);
        assert!(mask_ssh_socket < remove_host_keys);
        assert!(script.contains("systemctl is-enabled ssh.service"));
        assert!(script.contains("sshd_enablement=\"$(systemctl is-enabled sshd.service"));
        assert!(script.contains("alias|disabled|not-found)"));
        assert!(script.contains("unsafe sshd.service enablement state"));
        assert!(script.contains("systemctl is-enabled ssh.socket"));
        assert!(!script.contains("systemctl enable ssh.service"));
        assert!(!script.contains("systemctl enable sshd.service"));
        assert!(!script.contains("systemctl mask --now"));
        assert!(script.contains("[Unit]\nConditionPathExists=/run/intar/ssh-ready\nStartLimitIntervalSec=120s\nStartLimitBurst=3\n\n[Service]\nRestartSec=2s"));
        assert!(
            script.contains("chown root:root /etc/systemd/system/ssh.service.d/10-intar-gate.conf")
        );
        assert!(script.contains("chmod 0644 /etc/systemd/system/ssh.service.d/10-intar-gate.conf"));

        let (_, start_sshd_and_rest) = script.split_once("start_sshd() {\n").unwrap();
        let (start_sshd, _) = start_sshd_and_rest
            .split_once("\n}\n\ngrow_root_filesystem")
            .unwrap();
        assert!(
            start_sshd.contains(
                "deadline_seconds=$(( $(monotonic_seconds) + ssh_ready_timeout_seconds ))"
            )
        );
        assert!(start_sshd.contains("while true; do"));
        assert!(start_sshd.contains("systemctl start --no-block ssh.service"));
        assert!(!start_sshd.contains("systemctl restart"));
        assert!(!start_sshd.contains("systemctl reset-failed"));
        let generate_keys = start_sshd.find("generate_ssh_host_keys").unwrap();
        let create_sshd_runtime = start_sshd
            .find("install -d -o root -g root -m 0755 /run/sshd")
            .unwrap();
        let validate_sshd = start_sshd.find("/usr/sbin/sshd -t").unwrap();
        let create_ready_gate = start_sshd
            .find("install -D -o root -g root -m 0600 /dev/null /run/intar/ssh-ready")
            .unwrap();
        let start_service = start_sshd
            .find("systemctl start --no-block ssh.service")
            .unwrap();
        assert!(generate_keys < create_sshd_runtime);
        assert!(create_sshd_runtime < validate_sshd);
        assert!(validate_sshd < create_ready_gate);
        assert!(create_ready_gate < start_service);
        assert!(start_sshd.contains(
            "install -D -o root -g root -m 0600 /dev/null /run/intar/ssh-ready\n  if ! systemctl start --no-block ssh.service"
        ));
        assert_eq!(start_sshd.matches("systemctl show ssh.service").count(), 1);
        assert!(
            start_sshd.contains("systemctl show ssh.service --property=ActiveState --property=Job")
        );
        assert!(start_sshd.contains("while IFS='=' read -r property value; do"));
        assert!(start_sshd.contains("done <<<\"$ssh_properties\""));
        assert!(start_sshd.contains("ssh_job=unknown"));
        assert!(start_sshd.contains("if [ -z \"$ssh_job\" ]; then"));
        let (_, drained_job_and_rest) = start_sshd
            .split_once("if [ -z \"$ssh_job\" ]; then\n")
            .unwrap();
        let (drained_job, _) = drained_job_and_rest
            .split_once("\n    fi\n    now_seconds=")
            .unwrap();
        assert!(drained_job.contains("case \"$ssh_active_state\" in"));
        assert!(drained_job.contains("active)"));
        assert!(drained_job.contains("failed)"));
        assert!(!start_sshd.contains("systemctl is-active"));
        assert!(start_sshd.contains("failed)"));
        assert!(start_sshd.contains("print_sshd_diagnostics"));
        assert!(start_sshd.contains("sleep 1"));
        assert!(!start_sshd.contains("sleep 0.1"));
        assert!(!start_sshd.contains("sshd.service"));
        assert!(start_sshd.contains("now_seconds=\"$(monotonic_seconds)\""));
        assert!(start_sshd.contains("-ge \"$deadline_seconds\""));
        assert!(start_sshd.find("deadline_seconds=").unwrap() < generate_keys);
        assert!(start_sshd.contains(
            "timed out after ${ssh_ready_timeout_seconds}s waiting for ssh service to become active"
        ));
        assert!(!start_sshd.contains("for _ in {1..100}"));
        assert!(script.contains("systemctl status --no-pager --full ssh.service >&2"));
        assert!(script.contains("journalctl --no-pager --full --unit ssh.service --lines 100 >&2"));

        let configure_network = script.rfind("\nconfigure_guest_network\n").unwrap();
        let configure_access = script.rfind("\nconfigure_ssh_access\n").unwrap();
        let start_sshd_call = script.rfind("\nstart_sshd\n").unwrap();
        assert!(configure_network < configure_access);
        assert!(configure_access < start_sshd_call);
    }

    #[test]
    fn scenario_supervisor_waits_for_guest_network_and_reports_command_failures() {
        let script = render_minimal_provision_script();

        assert!(script.contains("network_ready_timeout_seconds=30"));
        assert!(script.contains("set -Eeuo pipefail"));
        assert!(
            script.contains("trap 'report_runtime_error \"$?\" \"$LINENO\" \"$BASH_COMMAND\"' ERR")
        );
        assert!(script.contains("error=command_failed status=%s line=%s command=%q\\n"));
        assert!(script.contains("After=local-fs.target systemd-udev-trigger.service"));

        let (_, runtime_unit_and_rest) = script
            .split_once("cat >/etc/systemd/system/intar-scenario.service <<'EOF_RUNTIME_UNIT'\n")
            .unwrap();
        let (runtime_unit, _) = runtime_unit_and_rest
            .split_once("\nEOF_RUNTIME_UNIT")
            .unwrap();
        let (unit_section, service_section) = runtime_unit.split_once("\n[Service]\n").unwrap();
        assert!(unit_section.contains("FailureAction=poweroff-force"));
        assert!(!service_section.contains("FailureAction=poweroff-force"));

        let (_, configure_attempt_and_rest) = script
            .split_once("try_configure_guest_interface() {\n")
            .unwrap();
        let (configure_attempt, _) = configure_attempt_and_rest
            .split_once("\n}\n\nwait_for_guest_network")
            .unwrap();
        assert!(configure_attempt.contains("ip link set dev \"$guest_iface\" up"));
        assert!(configure_attempt.contains("ip addr flush dev \"$guest_iface\" scope global"));
        assert!(
            configure_attempt
                .contains("ip addr replace \"$INTAR_GUEST_IP_CIDR\" dev \"$guest_iface\"")
        );
        assert!(
            configure_attempt
                .contains("ip route replace default via \"$INTAR_GATEWAY\" dev \"$guest_iface\"")
        );
        assert!(!configure_attempt.contains("ip addr add"));
        assert_eq!(configure_attempt.matches("return 1").count(), 4);

        let (_, network_wait_and_rest) = script.split_once("wait_for_guest_network() {\n").unwrap();
        let (network_wait, _) = network_wait_and_rest
            .split_once("\n}\n\nwait_for_vsock_ready")
            .unwrap();
        assert!(network_wait.contains(
            "deadline_seconds=$(( $(monotonic_seconds) + network_ready_timeout_seconds ))"
        ));
        assert!(network_wait.contains("while true; do"));
        assert!(network_wait.contains("if guest_iface=\"$(find_guest_interface)\"; then"));
        assert!(network_wait.contains("if try_configure_guest_interface \"$guest_iface\"; then"));
        assert!(network_wait.contains("now_seconds=\"$(monotonic_seconds)\""));
        assert!(network_wait.contains("-ge \"$deadline_seconds\""));
        assert!(network_wait.contains("sleep 0.1"));
        assert!(network_wait.contains(
            "timed out after ${network_ready_timeout_seconds}s waiting to configure a non-loopback guest interface"
        ));
        assert!(network_wait.contains("last network configuration error: $network_config_error"));
        assert!(network_wait.contains("ip -details link show >&2 || true"));
        assert!(network_wait.contains("ip -details address show >&2 || true"));
        assert!(network_wait.contains("ip route show table all >&2 || true"));

        let (_, configure_network_and_rest) =
            script.split_once("configure_guest_network() {\n").unwrap();
        let (configure_network, _) = configure_network_and_rest
            .split_once("\n}\n\nconfigure_ssh_access")
            .unwrap();
        let hostname = configure_network
            .find("hostname \"$INTAR_VM_HOSTNAME\"")
            .unwrap();
        let wait_for_network = configure_network.find("wait_for_guest_network").unwrap();
        let replace_resolver = configure_network.find("rm -f /etc/resolv.conf").unwrap();
        assert!(hostname < wait_for_network);
        assert!(wait_for_network < replace_resolver);
        assert!(!configure_network.contains("guest_iface=\"$(find_guest_interface)\""));
    }

    #[test]
    fn rendered_scenario_supervisor_is_valid_bash() {
        let output = run_bash(&render_minimal_supervisor(), true);
        assert!(
            output.status.success(),
            "bash -n rejected the rendered supervisor: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn scenario_supervisor_retries_interface_discovery_and_rename_failures() {
        let temp = tempfile::tempdir().unwrap();
        let iface_attempts = temp.path().join("iface-attempts");
        let link_attempts = temp.path().join("link-attempts");
        let monotonic_calls = temp.path().join("monotonic-calls");
        let ip_calls = temp.path().join("ip-calls");
        std::fs::write(&iface_attempts, "0\n").unwrap();
        std::fs::write(&link_attempts, "0\n").unwrap();
        std::fs::write(&monotonic_calls, "0\n").unwrap();

        let harness = r#"
trap - EXIT INT TERM
iface_attempts=__IFACE_ATTEMPTS__
link_attempts=__LINK_ATTEMPTS__
monotonic_calls=__MONOTONIC_CALLS__
ip_calls=__IP_CALLS__
INTAR_GUEST_IP_CIDR='10.77.0.2/28'
INTAR_GATEWAY='10.77.0.1'
find_guest_interface() {
  local attempt
  attempt="$(cat "$iface_attempts")"
  attempt=$((attempt + 1))
  printf '%s\n' "$attempt" >"$iface_attempts"
  if [ "$attempt" -eq 2 ]; then
    printf '%s\n' eth0
    return 0
  fi
  if [ "$attempt" -ge 3 ]; then
    printf '%s\n' ens3
    return 0
  fi
  return 1
}
ip() {
  local attempt
  printf '%s\n' "$*" >>"$ip_calls"
  if [ "$1" = link ]; then
    attempt="$(cat "$link_attempts")"
    attempt=$((attempt + 1))
    printf '%s\n' "$attempt" >"$link_attempts"
    if [ "$attempt" -eq 1 ]; then
      echo 'device renamed during configuration' >&2
      return 1
    fi
  fi
  return 0
}
monotonic_seconds() {
  local value
  value="$(cat "$monotonic_calls")"
  value=$((value + 1))
  printf '%s\n' "$value" >"$monotonic_calls"
  printf '%s\n' "$value"
}
sleep() { :; }
wait_for_guest_network
test "$(cat "$iface_attempts")" -eq 3
test "$(cat "$link_attempts")" -eq 2
grep -F 'addr replace 10.77.0.2/28 dev ens3' "$ip_calls" >/dev/null
grep -F 'route replace default via 10.77.0.1 dev ens3' "$ip_calls" >/dev/null
"#
        .replace(
            "__IFACE_ATTEMPTS__",
            &shell_quote(&iface_attempts.display().to_string()),
        )
        .replace(
            "__LINK_ATTEMPTS__",
            &shell_quote(&link_attempts.display().to_string()),
        )
        .replace(
            "__MONOTONIC_CALLS__",
            &shell_quote(&monotonic_calls.display().to_string()),
        )
        .replace(
            "__IP_CALLS__",
            &shell_quote(&ip_calls.display().to_string()),
        );
        let output = run_bash(&(render_minimal_supervisor_prefix() + &harness), false);
        assert!(
            output.status.success(),
            "network retry harness failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn scenario_supervisor_network_timeout_reports_last_error_and_err_trap() {
        let temp = tempfile::tempdir().unwrap();
        let monotonic_calls = temp.path().join("monotonic-calls");
        std::fs::write(&monotonic_calls, "0\n").unwrap();

        let harness = r#"
trap - EXIT INT TERM
monotonic_calls=__MONOTONIC_CALLS__
INTAR_GUEST_IP_CIDR='10.77.0.2/28'
INTAR_GATEWAY='10.77.0.1'
network_ready_timeout_seconds=1
find_guest_interface() { printf '%s\n' eth0; }
ip() {
  if [ "$1" = link ]; then
    echo 'device renamed during configuration' >&2
    return 1
  fi
  return 0
}
monotonic_seconds() {
  local value
  value="$(cat "$monotonic_calls")"
  value=$((value + 1))
  printf '%s\n' "$value" >"$monotonic_calls"
  printf '%s\n' "$value"
}
sleep() { :; }
wait_for_guest_network
"#
        .replace(
            "__MONOTONIC_CALLS__",
            &shell_quote(&monotonic_calls.display().to_string()),
        );
        let output = run_bash(&(render_minimal_supervisor_prefix() + &harness), false);
        assert!(!output.status.success());
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains("timed out after 1s waiting to configure"));
        assert!(stderr.contains(
            "last network configuration error: ip link set dev eth0 up failed: device renamed during configuration"
        ));
        assert!(stderr.contains("error=command_failed"));
        assert!(
            stderr.contains("command=return\\ 1")
                || stderr.contains("command=wait_for_guest_network")
        );
    }

    #[test]
    fn provision_script_contains_runtime_assets() {
        let scenario = Scenario::parse(
            r#"
scenario "broken-nginx" {
  title = "Broken Nginx"
  category = "web"
  tags = ["nginx", "systemd"]
  difficulty = "easy"
  estimated_minutes = 15
  description = "Fix nginx"
  briefing = "Briefing should stay on the website only."

  hint "service-state" {
    body = "Hint should not be baked into the VM."
  }

  solution {
    body = "Solution should stay gated on the server."
  }

  image "debian-12-minimal" {
    base = "trixie"
  }

  kino {
    probe "nginx-running" {
      kind = "service"
      service = "nginx"
      state = "running"
      description = "Nginx should be running"
      title = "Start nginx"
      body = "Probe body should remain website-only."

      hint "status" {
        body = "Probe hint should not be in the VM."
      }
    }
  }

  vm "web" {
    image = "debian-12-minimal"
    probes = ["nginx-running"]
    packages = ["nginx"]
  }
}
"#,
        );

        let scenario = match scenario {
            Ok(scenario) => scenario,
            Err(error) => panic!("scenario should parse: {error}"),
        };
        let Some(vm) = scenario.vm_by_name("web") else {
            panic!("vm should exist");
        };
        let script = render_scenario_provision_script(&scenario, vm);
        match script {
            Ok(script) => {
                assert!(script.contains("/etc/kino/kino.hcl.tpl"));
                assert!(script.contains("INTAR_GUEST_IP_CIDR is required"));
                assert!(script.contains("FailureAction=poweroff-force"));
                assert!(script.contains("wait_for_vsock_ready"));
                assert!(script.contains("if mountpoint -q \"$recording_mount_path\"; then umount \"$recording_mount_path\"; fi"));
                assert!(script.contains("if mountpoint -q \"$runtime_mount_path\"; then umount \"$runtime_mount_path\" >/dev/null 2>&1 || true; fi"));
                assert!(script.contains("log_phase recording_canary start"));
                assert!(script.contains("/usr/bin/setpriv --reuid=\"$recording_uid\" --regid=\"$recording_gid\" --clear-groups /bin/sh -c"));
                assert!(script.contains("StandardOutput=journal+console"));
                assert!(script.contains("systemctl enable intar-scenario.service"));
                assert!(script.contains(
                    "systemd-networkd-wait-online.service NetworkManager-wait-online.service"
                ));
                assert!(script.contains("systemctl set-default multi-user.target"));
                assert!(script.contains("cat >/etc/motd <<'EOF_MOTD'"));
                assert!(script.contains("Broken Nginx"));
                assert!(script.contains("Fix nginx"));
                assert!(script.contains("- Nginx should be running"));
                assert!(!script.contains("Briefing should stay on the website only."));
                assert!(!script.contains("Hint should not be baked into the VM."));
                assert!(!script.contains("Solution should stay gated on the server."));
                assert!(!script.contains("Start nginx"));
                assert!(!script.contains("Probe body should remain website-only."));
                assert!(!script.contains("Probe hint should not be in the VM."));
                assert!(
                    script.contains("find /etc/update-motd.d -maxdepth 1 -type f -exec chmod -x")
                );
                assert!(script.contains("rm -f /run/motd.dynamic /var/run/motd.dynamic"));
                assert!(script.contains("sed -i '/pam_motd\\.so/d' \"$pam_file\""));
                assert!(script.contains("session optional pam_motd.so motd=/etc/motd"));
                assert!(!script.contains("show_motd() {"));
                assert!(!script.contains("cat /etc/motd"));
                assert!(script.contains("cat >/etc/hosts <<EOF_HOSTS"));
                assert!(script.contains("${INTAR_GUEST_IP_CIDR%%/*} $INTAR_VM_HOSTNAME"));
                assert!(!script.contains("127.0.1.1"));
                assert!(
                    script
                        .contains("printf '%s' \"$INTAR_PEER_HOSTS_B64\" | base64 -d >>/etc/hosts")
                );
                assert!(script.contains("grep -qxF '/usr/local/bin/kino-shell' /etc/shells"));
                assert!(script.contains("usermod -s '/usr/local/bin/kino-shell' 'ubuntu'"));
                assert!(script.contains("install -m 0755 /tmp/kino /usr/local/bin/kino"));
                assert!(!script.contains("curl -fsSL"));
                assert!(script.contains(
                    "kino record-ssh --config \"$config_path\" --shell-startup interactive"
                ));
                assert!(script.contains("configure_ssh_access() {"));
                assert!(script.contains("INTAR_SSH_AUTHORIZED_KEYS_B64 is required"));
                assert!(script.contains("KINO_HOST_READY_PORT is required"));
                assert!(script.contains("root_device=\"/dev/vda\""));
                assert!(script.contains("runtime_device=\"/dev/vdb\""));
                assert!(script.contains("recording_device=\"/dev/vdc\""));
                assert!(script.contains("actual_label=\"$(blkid -s LABEL -o value"));
                assert!(script.contains("grow_root_filesystem() {"));
                assert!(script.contains("resize2fs \"$root_device\""));
                assert!(script.contains("wait_for_block_device \"$runtime_device\" INTARRUN"));
                assert!(script.contains("wait_for_block_device \"$recording_device\" INTARREC"));
                assert!(script.contains("compgen -v INTAR_PEER_"));
                assert!(script.contains("> /etc/profile.d/intar-peers.sh"));
                assert!(
                    script.contains("rm -f /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub")
                );
                assert!(script.contains("generate_ssh_host_keys() {"));
                assert!(
                    script.contains("ssh-keygen -t ed25519 -N '' -f /etc/ssh/ssh_host_ed25519_key")
                );
                assert!(!script.contains("ssh-keygen -A"));
                assert!(!script.contains("modprobe vsock"));
                assert!(script.contains("After=local-fs.target systemd-udev-trigger.service"));
                assert!(!script.contains("INTAR_STARGATE_TARGET_PUBLIC_KEY_OPENSSH"));
                assert!(script.contains("wait -n \"$KINO_PID\" || true"));
                assert!(script.contains("start_sshd"));
                assert!(script.contains("initial_boot_files=\"$(find /boot"));
                assert!(script.contains("systemctl disable intar-build.service"));
                assert!(script.contains(
                    "rm -f /etc/systemd/system/intar-build.service /usr/local/sbin/intar-build-start"
                ));
                assert!(script.contains("rm -f /home/${bootstrap_username}/.ssh/authorized_keys"));
                assert!(script.contains("final_boot_files=\"$(find /boot"));
                assert!(script.contains(
                    "scenario provisioning changed /boot; installing kernels in scenarios is not supported"
                ));
                assert!(script.contains("fstrim -v / || true"));
                assert!(!script.contains("touch /etc/cloud/cloud-init.disabled"));
                assert!(!script.contains("rm -f /etc/netplan/50-cloud-init.yaml"));
                assert!(!script.contains("cloud-init clean --logs --seed"));
                assert!(!script.contains("dist_upgrade"));
                assert!(script.contains("ensure_package_lists_updated"));
                assert!(script.contains("apt-get update"));
                assert!(script.contains("apt-get clean"));
                assert!(!script.contains("/var/lib/apt/lists/*"));
                assert!(!script.contains("dd if=/dev/zero of=/EMPTY"));
                assert!(!script.contains("/etc/intar/runtime.env"));
                assert!(!script.contains("INTAR_VM_MAC"));
                assert!(!script.contains("network_env"));
                assert!(!script.contains("systemctl enable intar-runtime-configure.service"));
                assert!(!script.contains("purge_installed_packages"));
                assert!(!script.contains("systemctl start kino.service"));
                assert!(!script.contains("setup-key"));
                assert!(!script.contains("ForceCommand /usr/local/bin/kino-shell"));
                assert!(!script.contains("exec /usr/sbin/sshd -D -e"));
            }
            Err(error) => panic!("script should render: {error}"),
        }
    }

    #[test]
    fn provision_script_renders_k8s_scale_deployment_action() {
        let scenario = Scenario::parse(
            r#"
scenario "workshop-cluster" {
  category = "kubernetes"
  description = "Restore the workshop application"

  image "debian-12-minimal" {
    base = "trixie"
  }

  kino {
    probe "k3s-running" {
      kind = "service"
      service = "k3s"
      state = "running"
      description = "k3s should be running"
    }
  }

  vm "control-plane" {
    image = "debian-12-minimal"
    probes = ["k3s-running"]

    step "break-workload" {
      k8s_scale_deployment {
        name = "hello-web"
        namespace = "workshop"
        replicas = 0
      }
    }
  }
}
"#,
        )
        .unwrap();
        let vm = scenario.vm_by_name("control-plane").unwrap();
        let script = render_scenario_provision_script(&scenario, vm).unwrap();
        assert!(script.contains("export KUBECONFIG=/etc/rancher/k3s/k3s.yaml"));
        assert!(
            script.contains(
                "kubectl scale 'deployment/hello-web' --replicas=0 --namespace 'workshop'"
            )
        );
    }
}
