#![allow(clippy::unwrap_used)]

use std::io::Write as _;
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use intar_image_scenario::Scenario;
use tempfile::tempdir;

use super::{
    FAILED_STEP_LOG_TAIL_BYTES, GeneratedStepScript, INTAR_RUN_CLI_COMPLETION_PATH,
    INTAR_RUN_CLI_PATH, RuntimeActivationInput, append_step_scripts,
    render_runtime_activation_script, render_scenario_provision_script, shell_quote,
};

fn render_minimal_provision_script() -> String {
    render_minimal_provision_script_with_cpu("1")
}

fn render_minimal_provision_script_with_cpu(cpu: &str) -> String {
    let source = r#"
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
cpu = __CPU__
image = "debian-13-minimal"
probes = ["ssh-running"]
  }
}
"#
    .replace("__CPU__", cpu);
    let scenario = Scenario::parse(&source).unwrap();
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
    let (prefix, _) = runtime.split_once("\n# intar-runtime-main\n").unwrap();
    format!("{prefix}\n")
}

fn render_minimal_runtime_activation() -> String {
    render_runtime_activation_script(RuntimeActivationInput {
        kino_template: r#"server {
  bind = "vsock://__INTAR_KINO_CID__:__INTAR_KINO_PORT__"
}

probe "check-one" {
  kind = "service"
  service = "nginx"
  state = "running"
  intar_alias = "check-1"
  intar_label = "Nginx should be running"
  intar_phase = "scenario"
}
"#,
        motd: "Intar workshop runtime\n",
        cpu_millis: 1_000,
        requires_kubernetes_modules: true,
    })
    .unwrap()
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

fn unit_conditions_allow(drop_in: &str, present_paths: &[&str]) -> bool {
    drop_in
        .lines()
        .filter_map(|line| line.strip_prefix("ConditionPathExists="))
        .all(|condition| {
            let (expects_present, path) = match condition.strip_prefix('!') {
                Some(path) => (false, path),
                None => (true, condition),
            };
            let is_present = present_paths.contains(&path);
            is_present == expects_present
        })
}

#[test]
fn runtime_activation_script_is_valid_bash_and_selects_one_boot_path() {
    let script = render_minimal_runtime_activation();

    assert!(script.starts_with("#!/usr/bin/env bash\nset -euo pipefail\n"));
    assert!(script.contains("install -m 0755 /tmp/kino /usr/local/bin/kino"));
    assert!(script.contains("ln -sfn kino '/usr/local/bin/intar'"));
    assert!(script.contains("'/usr/local/bin/intar' help >/dev/null 2>&1"));
    assert!(!script.contains("'/usr/local/bin/intar' --"));
    assert!(script.contains("/usr/share/intar/completions/intar.bash"));
    assert!(script.contains("/run/intar/run-cli-broker"));
    assert!(script.contains("vsock://2:18082"));
    assert!(script.contains("KINO_CONTROL_SOCKET=\"$kino_control_socket\""));
    assert!(script.contains("systemctl enable intar-scenario.service"));
    assert!(!script.contains("systemctl disable intar-build.service"));
    assert!(!script.contains("rm -f /etc/systemd/system/intar-build.service"));

    let (_, runtime_drop_in_and_rest) = script.split_once("<<'EOF_INTAR_RUNTIME_DISK'\n").unwrap();
    let (runtime_drop_in, _) = runtime_drop_in_and_rest
        .split_once("\nEOF_INTAR_RUNTIME_DISK")
        .unwrap();
    assert_eq!(
        runtime_drop_in,
        "[Unit]\nConditionPathExists=/dev/disk/by-label/INTARRUN\nConditionPathExists=!/dev/disk/by-label/INTARBUILD"
    );

    let (_, build_drop_in_and_rest) = script.split_once("<<'EOF_INTAR_BUILD_SEED'\n").unwrap();
    let (build_drop_in, _) = build_drop_in_and_rest
        .split_once("\nEOF_INTAR_BUILD_SEED")
        .unwrap();
    assert_eq!(
        build_drop_in,
        "[Unit]\nConditionPathExists=/dev/disk/by-label/INTARBUILD\nConditionPathExists=!/dev/disk/by-label/INTARRUN"
    );
    let runtime_disk = "/dev/disk/by-label/INTARRUN";
    let build_seed = "/dev/disk/by-label/INTARBUILD";
    assert!(unit_conditions_allow(runtime_drop_in, &[runtime_disk]));
    assert!(unit_conditions_allow(build_drop_in, &[build_seed]));
    assert!(!unit_conditions_allow(
        runtime_drop_in,
        &[runtime_disk, build_seed]
    ));
    assert!(!unit_conditions_allow(
        build_drop_in,
        &[runtime_disk, build_seed]
    ));

    let syntax = run_bash(&script, true);
    assert!(
        syntax.status.success(),
        "bash -n rejected runtime activation script: {}",
        String::from_utf8_lossy(&syntax.stderr)
    );
}

#[test]
fn runtime_activation_bash_completion_loads_and_keeps_dynamic_calls_bounded() {
    let script = render_minimal_runtime_activation();
    let (_, completion_and_rest) = script.split_once("<<'EOF_INTAR_COMPLETION'\n").unwrap();
    let (completion, _) = completion_and_rest
        .split_once("\nEOF_INTAR_COMPLETION")
        .unwrap();
    let (_, bashrc_and_rest) = script
        .split_once("<<'EOF_INTAR_BASH_COMPLETION'\n")
        .unwrap();
    let (bashrc, _) = bashrc_and_rest
        .split_once("\nEOF_INTAR_BASH_COMPLETION")
        .unwrap();

    assert!(
        completion
            .contains("/usr/bin/timeout --signal=KILL 0.25s '/usr/local/bin/intar' __complete")
    );
    assert!(completion.contains("\"$COMP_CWORD\" \"${COMP_WORDS[@]}\" 2>/dev/null"));
    assert!(completion.contains("^[a-z0-9][a-z0-9-]*$"));
    assert!(!completion.contains("--yes"));
    assert!(!completion.contains("--version"));

    let temporary = tempdir().unwrap();
    let completion_path = temporary.path().join("intar.bash");
    let bashrc_path = temporary.path().join("bashrc");
    std::fs::write(&completion_path, completion).unwrap();
    let completion_path = completion_path.to_string_lossy().into_owned();
    let bashrc = bashrc.replace(
        &shell_quote(INTAR_RUN_CLI_COMPLETION_PATH),
        &shell_quote(&completion_path),
    );
    std::fs::write(&bashrc_path, bashrc).unwrap();
    let bashrc_path = bashrc_path.to_string_lossy().into_owned();

    let output = Command::new("bash")
        .args([
            "--noprofile",
            "--rcfile",
            &bashrc_path,
            "-ic",
            "COMP_WORDS=(intar hi); COMP_CWORD=1; _intar_complete; printf '%s\\n' \"${COMPREPLY[*]}\"; complete -p intar",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "bash completion harness failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("hints hint"));
    assert!(stdout.contains("complete -F _intar_complete intar"));
}

#[test]
fn runtime_activation_bash_completion_kills_term_ignoring_helpers() {
    let script = render_minimal_runtime_activation();
    let (_, completion_and_rest) = script.split_once("<<'EOF_INTAR_COMPLETION'\n").unwrap();
    let (completion, _) = completion_and_rest
        .split_once("\nEOF_INTAR_COMPLETION")
        .unwrap();
    let timeout_command = ["timeout", "gtimeout"]
        .into_iter()
        .find(|candidate| {
            matches!(
                Command::new(candidate).arg("--version").output(),
                Ok(output) if output.status.success()
            )
        })
        .expect("completion timeout test requires GNU timeout");

    let temporary = tempdir().unwrap();
    let fake_intar_path = temporary.path().join("intar");
    std::fs::write(&fake_intar_path, "#!/bin/sh\ntrap '' TERM\nexec sleep 30\n").unwrap();
    let chmod = Command::new("chmod")
        .args(["0755", fake_intar_path.to_string_lossy().as_ref()])
        .output()
        .unwrap();
    assert!(
        chmod.status.success(),
        "failed to mark fake completion helper executable: {}",
        String::from_utf8_lossy(&chmod.stderr)
    );

    let completion_path = temporary.path().join("intar.bash");
    let completion = completion
        .replace("/usr/bin/timeout", timeout_command)
        .replace(
            &shell_quote(INTAR_RUN_CLI_PATH),
            &shell_quote(fake_intar_path.to_string_lossy().as_ref()),
        );
    std::fs::write(&completion_path, completion).unwrap();

    let started = Instant::now();
    let output = Command::new("bash")
        .args([
            "--noprofile",
            "--norc",
            "-c",
            &format!(
                "source {}; COMP_WORDS=(intar hint); COMP_CWORD=2; _intar_complete; (( ${{#COMPREPLY[@]}} == 0 ))",
                shell_quote(completion_path.to_string_lossy().as_ref()),
            ),
        ])
        .output()
        .unwrap();
    let elapsed = started.elapsed();

    assert!(
        output.status.success(),
        "TERM-ignoring completion helper was not handled: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        elapsed < Duration::from_secs(2),
        "completion waited {elapsed:?} for a TERM-ignoring helper"
    );
}

#[test]
fn visible_step_failure_emits_bounded_log_tail_and_preserves_status() {
    let directory = tempdir().unwrap();
    let step_path = directory.path().join("visible-step.sh");
    let log_path = directory.path().join("visible-step.log");
    let step_path = step_path.to_string_lossy().into_owned();
    let log_path = log_path.to_string_lossy().into_owned();
    let generated = GeneratedStepScript {
        content: format!(
            "#!/usr/bin/env bash\nset -euo pipefail\nexec >{} 2>&1\nhead -c 70000 /dev/zero | tr '\\0' x\nprintf '\\nsuffix\\n'\nexit 37\n",
            shell_quote(&log_path)
        ),
        hidden: false,
        log_path: Some(log_path.clone()),
        marker: "INTAR_TEST_VISIBLE_STEP".to_string(),
        path: step_path,
        phase_name: "step_server_configure".to_string(),
    };
    let mut script = "#!/usr/bin/env bash\nset -euo pipefail\nlog_phase() { :; }\n".to_string();
    append_step_scripts(&mut script, &[generated]).unwrap();

    assert!(script.contains("if bash "));
    assert!(script.contains(&format!(
        "tail -c {FAILED_STEP_LOG_TAIL_BYTES} -- \"$step_log\" >&2 || true"
    )));
    assert!(script.contains("exit \"$step_status\""));
    assert!(
        !script
            .lines()
            .any(|line| line.starts_with("trap ") && line.contains("ERR"))
    );

    let stderr_path = directory.path().join("provision.stderr");
    let stderr_file = std::fs::File::create(&stderr_path).unwrap();
    let mut child = Command::new("bash")
        .arg("-s")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr_file))
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(script.as_bytes())
        .unwrap();
    let status = child.wait().unwrap();
    assert_eq!(status.code(), Some(37));
    let stderr = std::fs::read_to_string(stderr_path).unwrap();
    let header = format!(
        "[intar-build] scenario step failed: phase=step_server_configure status=37 log={log_path}; showing last {FAILED_STEP_LOG_TAIL_BYTES} bytes\n"
    );
    let footer = "\n[intar-build] end scenario step failure log: phase=step_server_configure\n";
    let (_, after_header) = stderr.split_once(&header).unwrap();
    let (log_tail, after_footer) = after_header.split_once(footer).unwrap();
    assert_eq!(log_tail.len(), FAILED_STEP_LOG_TAIL_BYTES);
    assert!(log_tail.ends_with("\nsuffix\n"));
    assert!(after_footer.is_empty());
}

#[test]
fn hidden_step_failure_output_remains_suppressed() {
    let directory = tempdir().unwrap();
    let step_path = directory.path().join("hidden-step.sh");
    let generated = GeneratedStepScript {
        content: "#!/usr/bin/env bash\nset -euo pipefail\ntrap 'rm -f -- \"$0\"' EXIT\nexec >/dev/null 2>&1\nprintf 'hidden failure output\\n'\nexit 42\n"
            .to_string(),
        hidden: true,
        log_path: None,
        marker: "INTAR_TEST_HIDDEN_STEP".to_string(),
        path: step_path.to_string_lossy().into_owned(),
        phase_name: "step_server_break-app".to_string(),
    };
    let mut script = "#!/usr/bin/env bash\nset -euo pipefail\nlog_phase() { :; }\n".to_string();
    append_step_scripts(&mut script, &[generated]).unwrap();

    assert!(!script.contains("scenario step failed"));
    assert!(!script.contains("tail -c"));

    let output = run_bash(&script, false);
    assert_eq!(output.status.code(), Some(42));
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
}

#[test]
fn provision_reasserts_acpi_poweroff_handler_before_machine_id_cleanup() {
    let script = render_minimal_provision_script();

    let image_finalize_end = script.find("log_phase image_finalize end").unwrap();
    let handler_start = script
        .find("log_phase acpi_poweroff_handler start")
        .unwrap();
    let event_rule = script
        .find("cat >'/etc/acpi/events/90-intar-power-button' <<'EOF_INTAR_ACPI_EVENT'")
        .unwrap();
    let poweroff_script = script
        .find("cat >'/usr/local/sbin/intar-acpi-poweroff' <<'EOF_INTAR_ACPI_POWEROFF'")
        .unwrap();
    let enable_service = script
        .find("systemctl enable acpid.service >/dev/null")
        .unwrap();
    let restart_service = script
        .find("if ! systemctl restart acpid.service; then")
        .unwrap();
    let verify_service = script
        .find("if ! systemctl is-active --quiet acpid.service; then")
        .unwrap();
    let handler_end = script.find("log_phase acpi_poweroff_handler end").unwrap();
    let machine_id = script.find("truncate -s 0 /etc/machine-id").unwrap();
    let cleanup_end = script.find("log_phase cleanup end").unwrap();
    let final_sync = script.rfind("\nsync\n").unwrap();

    assert!(image_finalize_end < handler_start);
    assert!(handler_start < event_rule);
    assert!(event_rule < poweroff_script);
    assert!(poweroff_script < enable_service);
    assert!(enable_service < restart_service);
    assert!(restart_service < verify_service);
    assert!(verify_service < handler_end);
    assert!(handler_end < machine_id);
    assert!(machine_id < cleanup_end);
    assert!(cleanup_end < final_sync);
    assert!(script.contains(
        "event=button[ /]power\naction=/usr/local/sbin/intar-acpi-poweroff\nEOF_INTAR_ACPI_EVENT"
    ));

    let (_, poweroff_and_rest) = script.split_once("<<'EOF_INTAR_ACPI_POWEROFF'\n").unwrap();
    let (poweroff, _) = poweroff_and_rest
        .split_once("EOF_INTAR_ACPI_POWEROFF\n")
        .unwrap();
    assert_eq!(poweroff, "#!/bin/bash\nset -eu\nkill -s RTMIN+4 1\n");
    assert!(!poweroff.contains("systemctl"));
    assert!(!poweroff.contains("shutdown"));
    assert!(!poweroff.contains("poweroff"));
    assert!(!poweroff.contains("machine-id"));
    assert!(!poweroff.contains("dbus"));
    assert!(script.contains(
        "chown root:root '/etc/acpi/events/90-intar-power-button' '/usr/local/sbin/intar-acpi-poweroff'"
    ));
    assert!(script.contains("chmod 0644 '/etc/acpi/events/90-intar-power-button'"));
    assert!(script.contains("chmod 0755 '/usr/local/sbin/intar-acpi-poweroff'"));

    let syntax = run_bash(&script, true);
    assert!(
        syntax.status.success(),
        "bash -n rejected the rendered provision script: {}",
        String::from_utf8_lossy(&syntax.stderr)
    );
}

#[test]
fn scenario_supervisor_uses_blocking_ssh_start_at_normal_cpu() {
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
        .split_once("\n}\n\n# intar-runtime-main")
        .unwrap();
    assert!(start_sshd.contains("systemctl start ssh.service"));
    assert!(start_sshd.contains("systemctl is-active --quiet ssh.service"));
    assert!(!start_sshd.contains("systemctl start --no-block ssh.service"));
    assert!(!start_sshd.contains("systemctl show ssh.service"));
    assert!(!start_sshd.contains("while true; do"));
    assert!(!start_sshd.contains("sleep 1"));
    assert!(!start_sshd.contains("deadline_seconds="));
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
    let start_service = start_sshd.find("systemctl start ssh.service").unwrap();
    assert!(generate_keys < create_sshd_runtime);
    assert!(create_sshd_runtime < validate_sshd);
    assert!(validate_sshd < create_ready_gate);
    assert!(create_ready_gate < start_service);
    assert!(start_sshd.contains(
        "install -D -o root -g root -m 0600 /dev/null /run/intar/ssh-ready\n  if ! systemctl start ssh.service"
    ));
    assert!(start_sshd.contains("log_phase ssh_boot end"));
    assert!(start_sshd.contains("print_sshd_diagnostics"));
    assert!(!start_sshd.contains("sshd.service"));
    assert!(script.contains("systemctl status --no-pager --full ssh.service >&2"));
    assert!(script.contains("journalctl --no-pager --full --unit ssh.service --lines 100 >&2"));

    let configure_network = script.rfind("\nconfigure_guest_network\n").unwrap();
    let configure_access = script.rfind("\nconfigure_ssh_access\n").unwrap();
    let start_sshd_call = script.rfind("\nstart_sshd\n").unwrap();
    assert!(configure_network < configure_access);
    assert!(configure_access < start_sshd_call);
}

#[test]
fn scenario_supervisor_retains_bounded_async_ssh_start_for_fractional_cpu() {
    let script = render_minimal_provision_script_with_cpu("0.125");
    assert!(script.contains("vm_cpu_millis=125"));

    let (_, start_sshd_and_rest) = script.split_once("start_sshd() {\n").unwrap();
    let (start_sshd, _) = start_sshd_and_rest
        .split_once("\n}\n\n# intar-runtime-main")
        .unwrap();
    assert!(
        start_sshd
            .contains("deadline_seconds=$(( $(monotonic_seconds) + ssh_ready_timeout_seconds ))")
    );
    assert!(start_sshd.contains("systemctl start --no-block ssh.service"));
    assert!(
        start_sshd.contains("systemctl show ssh.service --property=ActiveState --property=Job")
    );
    assert!(start_sshd.contains("while true; do"));
    assert!(start_sshd.contains("sleep 0.1"));
    assert!(!start_sshd.contains("sleep 1"));
    assert!(start_sshd.contains("now_seconds=\"$(monotonic_seconds)\""));
    assert!(start_sshd.contains("-ge \"$deadline_seconds\""));
    assert!(start_sshd.contains(
        "timed out after ${ssh_ready_timeout_seconds}s waiting for ssh service to become active"
    ));
    assert!(!start_sshd.contains("if ! systemctl start ssh.service; then"));
    assert!(!start_sshd.contains("systemctl is-active"));
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
    assert!(script.contains("After=local-fs.target"));
    assert!(!script.contains("systemd-udev-trigger.service"));

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
        configure_attempt.contains("ip addr replace \"$INTAR_GUEST_IP_CIDR\" dev \"$guest_iface\"")
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
    assert!(
        network_wait.contains(
            "deadline_seconds=$(( $(monotonic_seconds) + network_ready_timeout_seconds ))"
        )
    );
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
    let supervisor = render_minimal_supervisor();
    assert!(!supervisor.contains("date -Ins"));
    assert!(supervisor.contains("ts=boot+%ss phase=%s status=%s"));
    assert!(supervisor.contains("read -r uptime _ </proc/uptime"));

    let output = run_bash(&supervisor, true);
    assert!(
        output.status.success(),
        "bash -n rejected the rendered supervisor: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn scenario_supervisor_resizes_root_only_when_runtime_flag_requires_it() {
    let temp = tempfile::tempdir().unwrap();
    let resize_calls = temp.path().join("resize-calls");
    std::fs::write(&resize_calls, "").unwrap();

    let harness = r#"
trap - EXIT INT TERM
resize_calls=__RESIZE_CALLS__
log_phase() { :; }
resize2fs() { printf 'resize\n' >>"$resize_calls"; }

INTAR_ROOT_RESIZE_REQUIRED=false
grow_root_filesystem
test ! -s "$resize_calls"

INTAR_ROOT_RESIZE_REQUIRED=true
grow_root_filesystem
test "$(wc -l <"$resize_calls")" -eq 1

unset INTAR_ROOT_RESIZE_REQUIRED
grow_root_filesystem
test "$(wc -l <"$resize_calls")" -eq 2

INTAR_ROOT_RESIZE_REQUIRED=invalid
if grow_root_filesystem; then
  echo 'invalid resize flag was accepted' >&2
  exit 1
fi
"#
    .replace(
        "__RESIZE_CALLS__",
        &shell_quote(&resize_calls.display().to_string()),
    );
    let output = run_bash(&(render_minimal_supervisor_prefix() + &harness), false);
    assert!(
        output.status.success(),
        "root resize flag harness failed: {}",
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
        stderr.contains("command=return\\ 1") || stderr.contains("command=wait_for_guest_network")
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
            assert!(script.contains("find /etc/update-motd.d -maxdepth 1 -type f -exec chmod -x"));
            assert!(script.contains("rm -f /run/motd.dynamic /var/run/motd.dynamic"));
            assert!(script.contains("sed -i '/pam_motd\\.so/d' \"$pam_file\""));
            assert!(script.contains("session optional pam_motd.so motd=/etc/motd"));
            assert!(!script.contains("show_motd() {"));
            assert!(!script.contains("cat /etc/motd"));
            assert!(script.contains("cat >/etc/hosts <<EOF_HOSTS"));
            assert!(script.contains("${INTAR_GUEST_IP_CIDR%%/*} $INTAR_VM_HOSTNAME"));
            assert!(!script.contains("127.0.1.1"));
            assert!(
                script.contains("printf '%s' \"$INTAR_PEER_HOSTS_B64\" | base64 -d >>/etc/hosts")
            );
            assert!(script.contains("grep -qxF '/usr/local/bin/kino-shell' /etc/shells"));
            assert!(script.contains("usermod -s '/usr/local/bin/kino-shell' 'ubuntu'"));
            assert!(script.contains("install -m 0755 /tmp/kino /usr/local/bin/kino"));
            assert!(!script.contains("curl -fsSL"));
            assert!(
                script.contains(
                    "kino record-ssh --config \"$config_path\" --shell-startup interactive"
                )
            );
            assert!(script.contains("configure_ssh_access() {"));
            assert!(
                script.contains(
                    "runtime_authorized_keys_path=\"$runtime_mount_path/authorized_keys\""
                )
            );
            assert!(script.contains("mv -f \"$tmp_path\" \"$authorized_keys\""));
            assert!(!script.contains("INTAR_SSH_AUTHORIZED_KEYS_B64 is required"));
            assert!(script.contains("KINO_HOST_READY_PORT is required"));
            assert!(script.contains("root_device=\"/dev/vda\""));
            assert!(script.contains("runtime_device=\"/dev/vdb\""));
            assert!(script.contains("recording_device=\"/dev/vdc\""));
            assert!(script.contains("actual_label=\"$(blkid -s LABEL -o value"));
            assert!(script.contains("grow_root_filesystem() {"));
            assert!(script.contains("resize2fs \"$root_device\""));
            assert!(script.contains("${INTAR_ROOT_RESIZE_REQUIRED:-1}"));
            assert!(script.contains("0|false)"));
            assert!(script.contains("log_phase root_resize skipped"));
            assert!(script.contains("wait_for_block_device \"$runtime_device\" INTARRUN"));
            assert!(script.contains("wait_for_block_device \"$recording_device\" INTARREC"));
            assert!(script.contains("compgen -v INTAR_PEER_"));
            assert!(script.contains("> /etc/profile.d/intar-peers.sh"));
            assert!(script.contains("rm -f /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub"));
            assert!(script.contains("generate_ssh_host_keys() {"));
            assert!(
                script.contains("ssh-keygen -t ed25519 -N '' -f /etc/ssh/ssh_host_ed25519_key")
            );
            assert!(!script.contains("ssh-keygen -A"));
            assert!(!script.contains("modprobe vsock"));
            assert!(script.contains("After=local-fs.target"));
            assert!(!script.contains("systemd-udev-trigger.service"));
            let (_, modules_and_rest) = script.split_once("<<'EOF_RUNTIME_MODULES'\n").unwrap();
            let (modules, _) = modules_and_rest
                .split_once("\nEOF_RUNTIME_MODULES")
                .unwrap();
            assert_eq!(modules, "nf_tables");
            assert!(!script.contains("INTAR_STARGATE_TARGET_PUBLIC_KEY_OPENSSH"));
            assert!(script.contains("wait -n \"$KINO_PID\" || true"));
            assert!(script.contains("start_sshd"));
            assert!(script.contains("initial_boot_files=\"$(find /boot"));
            assert!(script.contains("systemctl disable intar-build.service"));
            assert!(script.contains(
                "rm -f /etc/systemd/system/intar-build.service /etc/systemd/system/intar-build.service.d/10-intar-build-seed.conf /usr/local/sbin/intar-build-start /etc/pam.d/intar-build"
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
        script.contains("kubectl scale 'deployment/hello-web' --replicas=0 --namespace 'workshop'")
    );
    let (_, modules_and_rest) = script.split_once("<<'EOF_RUNTIME_MODULES'\n").unwrap();
    let (modules, _) = modules_and_rest
        .split_once("\nEOF_RUNTIME_MODULES")
        .unwrap();
    assert_eq!(modules, "nf_tables\noverlay\nbr_netfilter\nvxlan");
}
