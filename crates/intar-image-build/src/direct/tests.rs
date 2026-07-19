#![allow(clippy::unwrap_used)]

#[cfg(unix)]
use std::io::{BufRead as _, BufReader, Write as _};
#[cfg(unix)]
use std::os::unix::net::{UnixListener, UnixStream};
#[cfg(unix)]
use std::path::PathBuf;
#[cfg(unix)]
use std::process::{Command, Stdio};
#[cfg(unix)]
use std::thread;
use std::time::Duration;
#[cfg(unix)]
use std::time::Instant;

use tempfile::{TempDir, tempdir};

use super::{
    DIRECT_PROVISION_COMMAND, DirectBuildPrepareInput, DirectBuildRequest, QEMU_EXIT_POLL_INTERVAL,
    QMP_IO_TIMEOUT, QMP_READ_POLL_INTERVAL, RenderedDirectBuild, SSH_POLL_INTERVAL,
    connect_qmp_socket, prepare_direct_build_inputs, render_direct_build, wait_for_qemu_shutdown,
};
use crate::config::QemuBuildConfig;
use crate::kino::KinoArtifact;

fn render_test_direct_build(directory: &TempDir, config: QemuBuildConfig) -> RenderedDirectBuild {
    render_test_direct_build_in_work_root(directory, config, directory.path().join(".work"))
}

fn render_test_direct_build_in_work_root(
    directory: &TempDir,
    mut config: QemuBuildConfig,
    work_root: PathBuf,
) -> RenderedDirectBuild {
    let scenario = intar_image_scenario::Scenario::parse(
        r#"
scenario "broken-nginx" {
  title = "Broken Nginx"
  category = "web"
  tags = ["nginx"]
  difficulty = "easy"
  estimated_minutes = 15
  description = "Fix nginx"
  briefing = "Restore nginx service availability."
  solution { body = "Start nginx." }

  image "debian-13-minimal" {
base = "trixie"
  }

  kino {
probe "svc" {
  kind = "service"
  service = "nginx"
  state = "running"
  description = "Nginx"
}
  }

  vm "web" {
image = "debian-13-minimal"
probes = ["svc"]
  }
}
"#,
    )
    .unwrap();
    let catalog = intar_image_scenario::BaseImageCatalog::parse(
        r#"
base_image "trixie" {
  suite          = "trixie"
  mirror         = "https://deb.debian.org/debian"
  arch           = "amd64"
  kernel_package = "linux-image-cloud-amd64"
  packages       = ["openssh-server", "ca-certificates", "sudo", "zstd"]
}
"#,
    )
    .unwrap();
    config.output_root = directory.path().join("dist");
    config.work_root = work_root;

    render_direct_build(&DirectBuildRequest {
        scenario_path: "scenarios/broken-nginx/scenario.hcl".into(),
        scenario,
        vm_name: "web".to_string(),
        config,
        base_image: catalog.base_image_by_name("trixie").unwrap().clone(),
        kino: KinoArtifact {
            binary_path: "/tmp/kino".into(),
            version: "0.1.24".to_string(),
        },
    })
    .unwrap()
}

#[test]
fn ssh_readiness_poll_does_not_hammer_guest_limits() {
    assert_eq!(SSH_POLL_INTERVAL, std::time::Duration::from_secs(2));
}

#[test]
fn direct_provisioning_requires_success_before_host_poweroff() {
    assert_eq!(
        DIRECT_PROVISION_COMMAND,
        "sudo bash /tmp/intar-provision.sh"
    );
    assert!(!DIRECT_PROVISION_COMMAND.contains("shutdown"));
    assert!(!DIRECT_PROVISION_COMMAND.contains("&&"));
}

#[test]
fn qemu_exit_poll_is_independent_from_ssh_readiness_backoff() {
    assert_eq!(QEMU_EXIT_POLL_INTERVAL, Duration::from_millis(100));
    assert!(QEMU_EXIT_POLL_INTERVAL < SSH_POLL_INTERVAL);
}

#[cfg(unix)]
fn write_qmp_message(stream: &mut UnixStream, message: &serde_json::Value) {
    serde_json::to_writer(&mut *stream, message).unwrap();
    stream.write_all(b"\n").unwrap();
    stream.flush().unwrap();
}

#[cfg(unix)]
fn read_qmp_command(reader: &mut BufReader<UnixStream>, expected: &str) -> String {
    let mut command = String::new();
    reader.read_line(&mut command).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&command).unwrap(),
        serde_json::json!({ "execute": expected, "id": expected })
    );
    command
}

#[cfg(unix)]
fn write_qmp_success(stream: &mut UnixStream, command: &str) {
    write_qmp_message(stream, &serde_json::json!({ "return": {}, "id": command }));
}

#[cfg(unix)]
fn write_guest_shutdown_event(stream: &mut UnixStream) {
    write_qmp_message(
        stream,
        &serde_json::json!({
            "event": "SHUTDOWN",
            "data": { "guest": true, "reason": "guest-shutdown" }
        }),
    );
}

#[cfg(unix)]
fn write_qmp_greeting(stream: &mut UnixStream) {
    write_qmp_message(
        stream,
        &serde_json::json!({
            "QMP": {
                "version": {
                    "qemu": { "major": 9, "minor": 0, "micro": 0 },
                    "package": ""
                },
                "capabilities": []
            }
        }),
    );
}

#[cfg(unix)]
fn serve_acknowledged_powerdown(
    listener: UnixListener,
    exit_marker: Option<PathBuf>,
) -> Vec<String> {
    let (mut stream, _) = listener.accept().unwrap();
    let reader_stream = stream.try_clone().unwrap();
    let mut reader = BufReader::new(reader_stream);
    write_qmp_greeting(&mut stream);

    let commands = vec![read_qmp_command(&mut reader, "qmp_capabilities"), {
        write_qmp_success(&mut stream, "qmp_capabilities");
        read_qmp_command(&mut reader, "system_powerdown")
    }];
    write_qmp_success(&mut stream, "system_powerdown");
    write_guest_shutdown_event(&mut stream);
    if let Some(exit_marker) = exit_marker {
        std::fs::write(exit_marker, "powerdown").unwrap();
    }
    commands
}

#[cfg(unix)]
fn run_qmp_flood_case(payload: &'static [u8]) -> (String, Duration, usize) {
    let directory = tempdir().unwrap();
    let rendered = render_test_direct_build(&directory, QemuBuildConfig::default());
    let listener = UnixListener::bind(&rendered.paths.qmp_socket_path).unwrap();
    let qmp_server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let reader_stream = stream.try_clone().unwrap();
        let mut reader = BufReader::new(reader_stream);
        write_qmp_greeting(&mut stream);
        read_qmp_command(&mut reader, "qmp_capabilities");
        let mut writes = 0;
        loop {
            if stream
                .write_all(payload)
                .and_then(|()| stream.flush())
                .is_err()
            {
                break;
            }
            writes += 1;
            thread::sleep(Duration::from_millis(10));
        }
        writes
    });
    let mut qemu = Command::new("sh")
        .args(["-c", "sleep 60"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let started_at = Instant::now();

    let error = wait_for_qemu_shutdown(&mut qemu, &rendered).unwrap_err();
    let elapsed = started_at.elapsed();
    let writes = qmp_server.join().unwrap();
    assert!(qemu.try_wait().unwrap().is_some());
    (format!("{error:#}"), elapsed, writes)
}

mod qmp;
mod render;
