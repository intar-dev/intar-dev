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

pub fn render_base_provision_script() -> Result<String> {
    let mut script = String::new();
    let required_packages = [
        String::from("ca-certificates"),
        String::from("curl"),
        String::from("openssh-server"),
        String::from("python3"),
    ];

    writeln!(script, "#!/usr/bin/env bash").context("format error")?;
    writeln!(script, "set -euo pipefail").context("format error")?;
    writeln!(script).context("format error")?;
    append_package_helpers(&mut script, &required_packages, &[], true)?;
    writeln!(script, "install -d -m 0755 /usr/share/keyrings").context("format error")?;
    writeln!(script, "ensure_package_lists_updated").context("format error")?;
    writeln!(script, "log_phase dist_upgrade start").context("format error")?;
    writeln!(
        script,
        "DEBIAN_FRONTEND=noninteractive apt-get dist-upgrade -y"
    )
    .context("format error")?;
    writeln!(script, "log_phase dist_upgrade end").context("format error")?;
    writeln!(
        script,
        "install_packages base_packages \"${{required_packages[@]}}\""
    )
    .context("format error")?;
    append_apt_cleanup_config(&mut script)?;
    append_base_cloud_init_cleanup(&mut script)?;
    append_final_cleanup(&mut script)?;
    Ok(script)
}

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
    append_package_helpers(&mut script, &vm.packages, &step_scripts, false)?;
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

    writeln!(script, "systemctl daemon-reload").context("format error")?;
    writeln!(script, "systemctl enable intar-scenario.service").context("format error")?;
    writeln!(
        script,
        "systemctl enable ssh.service >/dev/null 2>&1 || systemctl enable sshd.service >/dev/null 2>&1 || true"
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
    // Disable additional services for faster boot
    writeln!(
        script,
        "for unit in apt-daily.service apt-daily-upgrade.service apt-daily.timer apt-daily-upgrade.timer man-db.timer popularity-contest.service motd-news.service fstrim.timer; do systemctl disable \"$unit\" >/dev/null 2>&1 || true; done"
    )
    .context("format error")?;
    writeln!(script, "systemctl set-default multi-user.target").context("format error")?;
    writeln!(script, "install -d -m 0755 /etc/cloud").context("format error")?;
    writeln!(script, "touch /etc/cloud/cloud-init.disabled").context("format error")?;
    writeln!(script, "rm -f /etc/netplan/50-cloud-init.yaml").context("format error")?;
    append_final_cleanup(script)
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

fn append_base_cloud_init_cleanup(script: &mut String) -> Result<()> {
    writeln!(script, "log_phase cloud_init_cleanup start").context("format error")?;
    writeln!(script, "cloud-init clean --logs --seed || true").context("format error")?;
    writeln!(script, "rm -rf /var/lib/cloud/* || true").context("format error")?;
    writeln!(script, "log_phase cloud_init_cleanup end").context("format error")?;
    writeln!(script).context("format error")?;
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
    writeln!(script, "set -euo pipefail").context("format error")?;
    writeln!(script, "runtime_device=\"/dev/disk/by-label/INTARRUN\"").context("format error")?;
    writeln!(script, "recording_device=\"/dev/disk/by-label/INTARREC\"").context("format error")?;
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
    writeln!(script, "wait_for_block_device() {{").context("format error")?;
    writeln!(script, "  local device=\"$1\"").context("format error")?;
    writeln!(script, "  local label=\"$2\"").context("format error")?;
    writeln!(script, "  for _ in {{1..100}}; do").context("format error")?;
    writeln!(script, "    if [ -e \"$device\" ]; then").context("format error")?;
    writeln!(script, "      return 0").context("format error")?;
    writeln!(script, "    fi").context("format error")?;
    writeln!(script, "    sleep 0.1").context("format error")?;
    writeln!(script, "  done").context("format error")?;
    writeln!(
        script,
        "  echo \"missing $label block device at $device\" >&2"
    )
    .context("format error")?;
    writeln!(script, "  return 1").context("format error")?;
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
    writeln!(script, "wait_for_vsock_ready() {{").context("format error")?;
    writeln!(script, "  for _ in {{1..100}}; do").context("format error")?;
    writeln!(script, "    if [ -c /dev/vsock ]; then").context("format error")?;
    writeln!(script, "      return 0").context("format error")?;
    writeln!(script, "    fi").context("format error")?;
    writeln!(script, "    modprobe vsock >/dev/null 2>&1 || true").context("format error")?;
    writeln!(
        script,
        "    modprobe vmw_vsock_virtio_transport_common >/dev/null 2>&1 || true"
    )
    .context("format error")?;
    writeln!(
        script,
        "    modprobe vmw_vsock_virtio_transport >/dev/null 2>&1 || true"
    )
    .context("format error")?;
    writeln!(script, "    modprobe virtio_vsock >/dev/null 2>&1 || true")
        .context("format error")?;
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
    writeln!(script, "127.0.1.1 $INTAR_VM_HOSTNAME").context("format error")?;
    writeln!(script, "::1 localhost ip6-localhost ip6-loopback").context("format error")?;
    writeln!(script, "ff02::1 ip6-allnodes").context("format error")?;
    writeln!(script, "ff02::2 ip6-allrouters").context("format error")?;
    writeln!(script, "EOF_HOSTS").context("format error")?;
    writeln!(script, "  chmod 0644 /etc/hosts").context("format error")?;
    writeln!(script, "  hostname \"$INTAR_VM_HOSTNAME\"").context("format error")?;
    writeln!(script, "  guest_iface=\"$(find_guest_interface)\"").context("format error")?;
    writeln!(
        script,
        "  [ -n \"$guest_iface\" ] || {{ echo 'failed to determine guest interface' >&2; exit 1; }}"
    )
    .context("format error")?;
    writeln!(script, "  ip link set dev \"$guest_iface\" up").context("format error")?;
    writeln!(
        script,
        "  ip addr flush dev \"$guest_iface\" scope global || true"
    )
    .context("format error")?;
    writeln!(
        script,
        "  ip addr add \"$INTAR_GUEST_IP_CIDR\" dev \"$guest_iface\""
    )
    .context("format error")?;
    writeln!(
        script,
        "  ip route replace default via \"$INTAR_GATEWAY\" dev \"$guest_iface\""
    )
    .context("format error")?;
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
    writeln!(script, "  while IFS= read -r key; do").context("format error")?;
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
        "  if compgen -G '/etc/ssh/ssh_host_*_key.pub' >/dev/null; then"
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
    writeln!(script, "  ssh-keygen -A").context("format error")?;
    writeln!(
        script,
        "  if ! compgen -G '/etc/ssh/ssh_host_*_key.pub' >/dev/null; then"
    )
    .context("format error")?;
    writeln!(
        script,
        "    echo 'ssh-keygen -A did not create public host keys' >&2"
    )
    .context("format error")?;
    writeln!(script, "    exit 1").context("format error")?;
    writeln!(script, "  fi").context("format error")?;
    writeln!(script, "  log_phase ssh_host_keys end").context("format error")?;
    writeln!(script, "}}").context("format error")?;
    writeln!(script).context("format error")?;
    writeln!(script, "start_sshd() {{").context("format error")?;
    writeln!(script, "  log_phase ssh_boot start").context("format error")?;
    writeln!(script, "  generate_ssh_host_keys").context("format error")?;
    writeln!(script, "  systemctl restart ssh.service >/dev/null 2>&1 || systemctl restart sshd.service >/dev/null 2>&1 || true").context("format error")?;
    writeln!(script, "  for _ in {{1..100}}; do").context("format error")?;
    writeln!(script, "    if systemctl is-active --quiet ssh.service || systemctl is-active --quiet sshd.service; then").context("format error")?;
    writeln!(script, "      log_phase ssh_boot end").context("format error")?;
    writeln!(script, "      return 0").context("format error")?;
    writeln!(script, "    fi").context("format error")?;
    writeln!(script, "    sleep 0.1").context("format error")?;
    writeln!(script, "  done").context("format error")?;
    writeln!(
        script,
        "  systemctl status ssh.service >/dev/null 2>&1 && systemctl status ssh.service || true"
    )
    .context("format error")?;
    writeln!(
        script,
        "  systemctl status sshd.service >/dev/null 2>&1 && systemctl status sshd.service || true"
    )
    .context("format error")?;
    writeln!(
        script,
        "  echo 'timed out waiting for ssh service to become active' >&2"
    )
    .context("format error")?;
    writeln!(script, "  exit 1").context("format error")?;
    writeln!(script, "}}").context("format error")?;
    writeln!(script).context("format error")?;
    writeln!(script, "log_phase runtime_disk start").context("format error")?;
    writeln!(script, "wait_for_block_device \"$runtime_device\" runtime")
        .context("format error")?;
    writeln!(script, "install -d -m 0755 \"$runtime_mount_path\"").context("format error")?;
    writeln!(script, "mount -t vfat -o ro,nosuid,nodev,noexec,utf8=1,shortname=mixed \"$runtime_device\" \"$runtime_mount_path\"").context("format error")?;
    writeln!(script, "[ -f \"$runtime_env_path\" ] || {{ echo \"missing runtime env at $runtime_env_path\" >&2; exit 1; }}").context("format error")?;
    writeln!(script, "set -a").context("format error")?;
    writeln!(script, ". \"$runtime_env_path\"").context("format error")?;
    writeln!(script, "set +a").context("format error")?;
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
        "wait_for_block_device \"$recording_device\" recording"
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
    writeln!(script).context("format error")?;
    writeln!(script, "[Service]").context("format error")?;
    writeln!(script, "Type=simple").context("format error")?;
    writeln!(script, "ExecStart={INTAR_SCENARIO_SUPERVISOR_PATH}").context("format error")?;
    writeln!(script, "KillMode=mixed").context("format error")?;
    writeln!(script, "TimeoutStartSec=30").context("format error")?;
    writeln!(script, "StandardOutput=journal+console").context("format error")?;
    writeln!(script, "StandardError=journal+console").context("format error")?;
    writeln!(script, "FailureAction=poweroff-force").context("format error")?;
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
    writeln!(output, "{}", scenario.description.trim()).context("format error")?;
    writeln!(output).context("format error")?;
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

    use intar_image_scenario::Scenario;

    use super::{render_base_provision_script, render_scenario_provision_script};

    #[test]
    fn provision_script_contains_runtime_assets() {
        let scenario = Scenario::parse(
            r#"
scenario "broken-nginx" {
  category = "web"
  description = "Fix nginx"

  image "debian-12-minimal" {
    base = "trixie"
  }

  kino {
    probe "nginx-running" {
      kind = "service"
      service = "nginx"
      state = "running"
      description = "Nginx should be running"
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
                assert!(script.contains("runtime_device=\"/dev/disk/by-label/INTARRUN\""));
                assert!(script.contains("recording_device=\"/dev/disk/by-label/INTARREC\""));
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
                assert!(script.contains("Fix nginx"));
                assert!(script.contains("- Nginx should be running"));
                assert!(
                    script.contains("find /etc/update-motd.d -maxdepth 1 -type f -exec chmod -x")
                );
                assert!(script.contains("rm -f /run/motd.dynamic /var/run/motd.dynamic"));
                assert!(script.contains("sed -i '/pam_motd\\.so/d' \"$pam_file\""));
                assert!(script.contains("session optional pam_motd.so motd=/etc/motd"));
                assert!(!script.contains("show_motd() {"));
                assert!(!script.contains("cat /etc/motd"));
                assert!(script.contains("cat >/etc/hosts <<EOF_HOSTS"));
                assert!(script.contains("127.0.1.1 $INTAR_VM_HOSTNAME"));
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
                assert!(
                    script.contains("rm -f /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub")
                );
                assert!(script.contains("generate_ssh_host_keys() {"));
                assert!(script.contains("ssh-keygen -A"));
                assert!(!script.contains("INTAR_STARGATE_TARGET_PUBLIC_KEY_OPENSSH"));
                assert!(script.contains("wait -n \"$KINO_PID\" || true"));
                assert!(script.contains("start_sshd"));
                assert!(script.contains("touch /etc/cloud/cloud-init.disabled"));
                assert!(script.contains("rm -f /etc/netplan/50-cloud-init.yaml"));
                assert!(!script.contains("cloud-init clean --logs --seed"));
                assert!(!script.contains("dist_upgrade"));
                assert!(!script.contains("apt-get update"));
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

    #[test]
    fn base_provision_script_contains_upgrade_and_common_packages() {
        let script = render_base_provision_script().unwrap();

        assert!(script.contains("dist_upgrade"));
        assert!(script.contains("apt-get update"));
        assert!(script.contains("install_packages base_packages \"${required_packages[@]}\""));
        assert!(script.contains("ca-certificates"));
        assert!(script.contains("openssh-server"));
        assert!(script.contains("cloud-init clean --logs --seed || true"));
        assert!(script.contains("rm -rf /var/lib/cloud/* || true"));
        assert!(!script.contains("/var/lib/apt/lists/*"));
        assert!(!script.contains("touch /etc/cloud/cloud-init.disabled"));
    }
}
