//! A hangup (browser terminal closed, SSH session torn down) must not lose
//! recorded session output: kino drains what the shell produced, writes the
//! exit event, and syncs the recording before exiting.

#![cfg(target_os = "linux")]

use std::fs;
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use pty_process::Size as PtySize;
use pty_process::blocking::{Command as PtyCommand, open as open_pty};
use rustix::event::{PollFd, PollFlags, Timespec, poll};
use rustix::fs::{OFlags, fcntl_getfl, fcntl_setfl};
use rustix::io::{Errno, read as fd_read, write as fd_write};
use rustix::process::{Pid, Signal, kill_process};
use serde_json::Value;

#[test]
fn hangup_preserves_recorded_output_and_exit_event() {
    let temp = tempfile::tempdir().expect("tempdir");
    let output_dir = temp.path().join("recordings");
    fs::create_dir_all(&output_dir).expect("recording dir");
    let config_path = temp.path().join("kino.hcl");
    fs::write(
        &config_path,
        format!(
            "server {{\n  bind = \"tcp://127.0.0.1:0\"\n}}\n\nrecording {{\n  output_dir = \"{}\"\n  real_shell = \"/bin/sh\"\n}}\n",
            output_dir.display()
        ),
    )
    .expect("config write");

    let (pty, pts) = open_pty().expect("pty");
    pty.resize(PtySize::new(24, 80)).expect("pty size");
    let flags = fcntl_getfl(&pty).expect("pty flags");
    fcntl_setfl(&pty, flags | OFlags::NONBLOCK).expect("pty nonblock");

    let mut child = PtyCommand::new(env!("CARGO_BIN_EXE_kino"))
        .args([
            "record-ssh",
            "--config",
            config_path.to_str().expect("config path utf8"),
            "--shell-startup",
            "interactive",
        ])
        .spawn(pts)
        .expect("spawn kino record-ssh");
    let kino_pid = Pid::from_raw(i32::try_from(child.id()).expect("pid")).expect("nonzero pid");

    let mut captured = Vec::new();

    // Let the shell start, then produce output that must survive the hangup.
    drain_into(&pty, Duration::from_millis(1_500), &mut captured);
    fd_write(&pty, b"printf 'TAIL_MARKER_%s\\n' SURVIVES; sleep 30\n").expect("send input");
    drain_into(&pty, Duration::from_millis(1_500), &mut captured);

    // Simulate sshd tearing the session down mid-run.
    kill_process(kino_pid, Signal::HUP).expect("send SIGHUP");

    // Diagnostic probe: with the hangup observed, stdin must be ignored, so
    // this input may never appear in the recording.
    drain_into(&pty, Duration::from_millis(1_000), &mut captured);
    let _ = fd_write(&pty, b"echo AFTER_HUP_PROBE\n");

    let deadline = Instant::now() + Duration::from_secs(10);
    let exited = loop {
        // Keep draining so kino never blocks on a full outer pty buffer.
        drain_into(&pty, Duration::from_millis(50), &mut captured);
        match child.try_wait() {
            Ok(Some(_)) => break true,
            Ok(None) if Instant::now() < deadline => {}
            Ok(None) => break false,
            Err(error) => panic!("failed waiting for kino: {error}"),
        }
    };
    if !exited {
        let _ = kill_process(kino_pid, Signal::KILL);
        let _ = child.wait();
    }

    let recording = fs::read_dir(&output_dir)
        .expect("read recordings")
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .find(|path| path.extension().is_some_and(|ext| ext == "krec"))
        .map(|path| fs::read_to_string(&path).expect("read recording"))
        .unwrap_or_default();
    let terminal_output = String::from_utf8_lossy(&captured).into_owned();

    assert!(
        exited,
        "kino did not exit within the hangup drain deadline\n--- terminal output:\n{terminal_output}\n--- recording:\n{recording}"
    );

    let mut has_marker_output = false;
    let mut has_exit_event = false;
    for line in recording.lines().skip(1) {
        let event: Value = serde_json::from_str(line).expect("valid event line");
        match event["event"].as_str() {
            Some("o") => {
                let data = BASE64_STANDARD
                    .decode(event["data_b64"].as_str().unwrap_or_default())
                    .expect("valid base64");
                if String::from_utf8_lossy(&data).contains("TAIL_MARKER_SURVIVES") {
                    has_marker_output = true;
                }
            }
            Some("x") => has_exit_event = true,
            _ => {}
        }
    }

    assert!(
        has_marker_output,
        "recording lost the shell output produced before the hangup:\n{recording}"
    );
    assert!(
        has_exit_event,
        "recording is missing the exit event after the hangup:\n{recording}"
    );
}

fn drain_into(pty: &pty_process::blocking::Pty, duration: Duration, captured: &mut Vec<u8>) {
    let deadline = Instant::now() + duration;
    let mut buffer = [0_u8; 4096];
    while Instant::now() < deadline {
        let mut poll_fds = [PollFd::new(pty, PollFlags::IN)];
        let timeout = Timespec::try_from(Duration::from_millis(50)).expect("timeout");
        let _ = poll(&mut poll_fds, Some(&timeout));
        match fd_read(pty, &mut buffer) {
            Ok(0) => return,
            Ok(count) => captured.extend_from_slice(&buffer[..count]),
            Err(Errno::AGAIN) | Err(Errno::INTR) => {}
            Err(_) => return,
        }
    }
}
