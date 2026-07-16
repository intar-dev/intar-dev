use super::*;

pub(super) fn append_runtime_assets(
    script: &mut String,
    kino_template: &str,
    scenario_motd: &str,
    vm: &VmDefinition,
    requires_kubernetes_modules: bool,
) -> Result<()> {
    writeln!(script, "install -d -m 0755 /etc/kino /etc/intar").context("format error")?;
    writeln!(script).context("format error")?;

    writeln!(
        script,
        "cat >/etc/modules-load.d/90-intar-runtime.conf <<'EOF_RUNTIME_MODULES'"
    )
    .context("format error")?;
    for module in BASE_RUNTIME_MODULES {
        writeln!(script, "{module}").context("format error")?;
    }
    if requires_kubernetes_modules {
        for module in KUBERNETES_RUNTIME_MODULES {
            writeln!(script, "{module}").context("format error")?;
        }
    }
    writeln!(script, "EOF_RUNTIME_MODULES").context("format error")?;
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
    writeln!(
        script,
        "runtime_authorized_keys_path=\"$runtime_mount_path/{RUNTIME_AUTHORIZED_KEYS_FILENAME}\""
    )
    .context("format error")?;
    writeln!(script, "kino_config_path=\"{KINO_RUNTIME_CONFIG_PATH}\"").context("format error")?;
    writeln!(script, "kino_log_path=\"$runtime_state_path/kino.log\"").context("format error")?;
    writeln!(script, "recording_mount_path=\"{RECORDING_MOUNT_PATH}\"").context("format error")?;
    writeln!(script, "recording_user=\"{DEFAULT_USERNAME}\"").context("format error")?;
    writeln!(script, "vm_cpu_millis={}", vm.cpu_millis).context("format error")?;
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
    writeln!(script, "  local uptime").context("format error")?;
    writeln!(script, "  read -r uptime _ </proc/uptime").context("format error")?;
    writeln!(
        script,
        "  printf '[intar-runtime] ts=boot+%ss phase=%s status=%s\\n' \"$uptime\" \"$1\" \"$2\""
    )
    .context("format error")?;
    writeln!(script, "}}").context("format error")?;
    writeln!(script).context("format error")?;
    writeln!(script, "report_runtime_error() {{").context("format error")?;
    writeln!(script, "  local status=\"$1\"").context("format error")?;
    writeln!(script, "  local line=\"$2\"").context("format error")?;
    writeln!(script, "  local command=\"$3\"").context("format error")?;
    writeln!(script, "  local uptime").context("format error")?;
    writeln!(script, "  trap - ERR").context("format error")?;
    writeln!(script, "  read -r uptime _ </proc/uptime").context("format error")?;
    writeln!(
        script,
        "  printf '[intar-runtime] ts=boot+%ss error=command_failed status=%s line=%s command=%q\\n' \"$uptime\" \"$status\" \"$line\" \"$command\" >&2"
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
    writeln!(script, "  case \"${{INTAR_ROOT_RESIZE_REQUIRED:-1}}\" in").context("format error")?;
    writeln!(script, "    0|false)").context("format error")?;
    writeln!(script, "      log_phase root_resize skipped").context("format error")?;
    writeln!(script, "      return 0").context("format error")?;
    writeln!(script, "      ;;").context("format error")?;
    writeln!(script, "    1|true) ;;").context("format error")?;
    writeln!(script, "    *)").context("format error")?;
    writeln!(
        script,
        "      echo \"invalid INTAR_ROOT_RESIZE_REQUIRED value: $INTAR_ROOT_RESIZE_REQUIRED\" >&2"
    )
    .context("format error")?;
    writeln!(script, "      return 1").context("format error")?;
    writeln!(script, "      ;;").context("format error")?;
    writeln!(script, "  esac").context("format error")?;
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
    writeln!(script, "  local home_dir authorized_keys tmp_path").context("format error")?;
    writeln!(script, "  home_dir=\"/home/$recording_user\"").context("format error")?;
    writeln!(
        script,
        "  [ -d \"$home_dir\" ] || {{ echo \"missing home for $recording_user\" >&2; exit 1; }}"
    )
    .context("format error")?;
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
    writeln!(script, "  [ -s \"$runtime_authorized_keys_path\" ] || {{ echo 'runtime disk authorized_keys is empty' >&2; exit 1; }}").context("format error")?;
    writeln!(
        script,
        "  tmp_path=\"$home_dir/.ssh/.authorized_keys.intar.$$\""
    )
    .context("format error")?;
    writeln!(script, "  rm -f \"$tmp_path\"").context("format error")?;
    writeln!(script, "  install -m 0600 -o \"$recording_user\" -g \"$recording_user\" \"$runtime_authorized_keys_path\" \"$tmp_path\"").context("format error")?;
    writeln!(script, "  mv -f \"$tmp_path\" \"$authorized_keys\"").context("format error")?;
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
    if vm.cpu_millis < 1_000 {
        writeln!(script, "  local deadline_seconds now_seconds ssh_active_state ssh_job ssh_properties property value").context("format error")?;
        writeln!(
            script,
            "  deadline_seconds=$(( $(monotonic_seconds) + ssh_ready_timeout_seconds ))"
        )
        .context("format error")?;
    }
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
    if vm.cpu_millis >= 1_000 {
        // `systemctl start` waits for the job to finish. The distribution unit's
        // TimeoutStartSec bounds the wait, and a single postcondition check avoids
        // adding up to one second of polling latency to normal-capacity guests.
        writeln!(script, "  if ! systemctl start ssh.service; then").context("format error")?;
        writeln!(script, "    echo 'failed to start ssh.service' >&2").context("format error")?;
        writeln!(script, "    print_sshd_diagnostics").context("format error")?;
        writeln!(script, "    return 1").context("format error")?;
        writeln!(script, "  fi").context("format error")?;
        writeln!(
            script,
            "  if ! systemctl is-active --quiet ssh.service; then"
        )
        .context("format error")?;
        writeln!(
            script,
            "    echo 'ssh.service did not become active after its start job completed' >&2"
        )
        .context("format error")?;
        writeln!(script, "    print_sshd_diagnostics").context("format error")?;
        writeln!(script, "    return 1").context("format error")?;
        writeln!(script, "  fi").context("format error")?;
        writeln!(script, "  log_phase ssh_boot end").context("format error")?;
    } else {
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
        writeln!(script, "    sleep 0.1").context("format error")?;
        writeln!(script, "  done").context("format error")?;
        writeln!(script, "  print_sshd_diagnostics").context("format error")?;
        writeln!(
            script,
            "  echo \"timed out after ${{ssh_ready_timeout_seconds}}s waiting for ssh service to become active\" >&2"
        )
        .context("format error")?;
        writeln!(script, "  return 1").context("format error")?;
    }
    writeln!(script, "}}").context("format error")?;
    writeln!(script).context("format error")?;
    writeln!(script, "# intar-runtime-main").context("format error")?;
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
    writeln!(script, "grow_root_filesystem").context("format error")?;
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
    writeln!(script, "After=local-fs.target").context("format error")?;
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
