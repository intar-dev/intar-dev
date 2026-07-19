use super::*;

#[cfg(unix)]
#[test]
fn host_qmp_powerdown_accepts_a_clean_bounded_qemu_exit() {
    let directory = tempdir().unwrap();
    let rendered = render_test_direct_build(
        &directory,
        QemuBuildConfig {
            qemu_exit_timeout_seconds: 1,
            ..QemuBuildConfig::default()
        },
    );
    let listener = UnixListener::bind(&rendered.paths.qmp_socket_path).unwrap();
    let exit_marker = directory.path().join("qemu-exit");
    let server_marker = exit_marker.clone();
    let qmp_server =
        thread::spawn(move || serve_acknowledged_powerdown(listener, Some(server_marker)));
    let mut qemu = Command::new("sh")
        .args([
            "-c",
            "while [ ! -e \"$1\" ]; do sleep 0.01; done",
            "qemu-test",
        ])
        .arg(&exit_marker)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();

    wait_for_qemu_shutdown(&mut qemu, &rendered).unwrap();

    assert_eq!(
        qmp_server.join().unwrap(),
        vec![
            "{\"execute\":\"qmp_capabilities\",\"id\":\"qmp_capabilities\"}\n",
            "{\"execute\":\"system_powerdown\",\"id\":\"system_powerdown\"}\n",
        ]
    );
    assert!(qemu.try_wait().unwrap().unwrap().success());
}

#[cfg(unix)]
#[test]
fn host_qmp_powerdown_connects_beneath_an_overlong_work_path() {
    let directory = tempdir().unwrap();
    let long_work_root = directory.path().join("w".repeat(120));
    let rendered = render_test_direct_build_in_work_root(
        &directory,
        QemuBuildConfig {
            qemu_exit_timeout_seconds: 1,
            ..QemuBuildConfig::default()
        },
        long_work_root,
    );
    assert!(
        rendered
            .paths
            .qmp_socket_path
            .as_os_str()
            .as_encoded_bytes()
            .len()
            > 108
    );

    // Model QEMU's relative bind: the kernel creates qmp.sock in the long
    // work directory even though the pathname passed to bind(2) stays short.
    let qemu_work_alias = directory.path().join("qmp-work");
    std::os::unix::fs::symlink(&rendered.paths.work_root, &qemu_work_alias).unwrap();
    let qemu_socket_alias = qemu_work_alias.join("qmp.sock");
    assert!(qemu_socket_alias.as_os_str().as_encoded_bytes().len() < 108);
    let listener = UnixListener::bind(qemu_socket_alias).unwrap();

    let exit_marker = directory.path().join("qemu-exit-long-path");
    let server_marker = exit_marker.clone();
    let qmp_server =
        thread::spawn(move || serve_acknowledged_powerdown(listener, Some(server_marker)));
    let mut qemu = Command::new("sh")
        .args([
            "-c",
            "while [ ! -e \"$1\" ]; do sleep 0.01; done",
            "qemu-test",
        ])
        .arg(&exit_marker)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();

    wait_for_qemu_shutdown(&mut qemu, &rendered).unwrap();

    assert_eq!(
        qmp_server.join().unwrap(),
        vec![
            "{\"execute\":\"qmp_capabilities\",\"id\":\"qmp_capabilities\"}\n",
            "{\"execute\":\"system_powerdown\",\"id\":\"system_powerdown\"}\n",
        ]
    );
    assert!(qemu.try_wait().unwrap().unwrap().success());
}

#[cfg(unix)]
#[test]
fn qmp_client_resolves_a_relative_socket_before_creating_its_alias() {
    let relative_directory = tempfile::Builder::new()
        .prefix("intar-qmp-relative-")
        .tempdir_in(".")
        .unwrap();
    let relative_root = PathBuf::from(relative_directory.path().file_name().unwrap());
    let relative_socket_path = relative_root.join("qmp.sock");
    assert!(relative_socket_path.is_relative());
    let listener = UnixListener::bind(&relative_socket_path).unwrap();

    let client = connect_qmp_socket(&relative_socket_path).unwrap();
    let (server, _) = listener.accept().unwrap();

    drop(client);
    drop(server);
}

#[cfg(unix)]
#[test]
fn host_poweroff_fails_closed_when_qmp_is_unavailable() {
    let directory = tempdir().unwrap();
    let rendered = render_test_direct_build(&directory, QemuBuildConfig::default());
    let mut qemu = Command::new("sh")
        .args(["-c", "sleep 60"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let started_at = Instant::now();

    let error = wait_for_qemu_shutdown(&mut qemu, &rendered).unwrap_err();
    let error = format!("{error:#}");

    assert!(started_at.elapsed() < Duration::from_secs(3));
    assert!(error.contains("failed to complete QMP guest powerdown handshake after provisioning"));
    assert!(error.contains("failed to connect to QMP socket"));
    assert!(error.contains("was terminated and reaped"));
    assert!(qemu.try_wait().unwrap().is_some());
}

#[cfg(unix)]
#[test]
fn host_poweroff_rejects_clean_qemu_exit_before_acknowledgement() {
    let directory = tempdir().unwrap();
    let rendered = render_test_direct_build(&directory, QemuBuildConfig::default());
    let mut qemu = Command::new("sh")
        .args(["-c", "exit 0"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    assert!(qemu.wait().unwrap().success());

    let error = wait_for_qemu_shutdown(&mut qemu, &rendered).unwrap_err();

    assert!(format!("{error:#}").contains(
        "QEMU exited with status exit status: 0 before the host requested acknowledged QMP powerdown"
    ));
    assert!(qemu.try_wait().unwrap().is_some());
}

#[cfg(unix)]
#[test]
fn host_poweroff_fails_closed_when_qmp_returns_an_error() {
    let directory = tempdir().unwrap();
    let rendered = render_test_direct_build(&directory, QemuBuildConfig::default());
    let listener = UnixListener::bind(&rendered.paths.qmp_socket_path).unwrap();
    let qmp_server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let reader_stream = stream.try_clone().unwrap();
        let mut reader = BufReader::new(reader_stream);
        write_qmp_greeting(&mut stream);
        let command = read_qmp_command(&mut reader, "qmp_capabilities");
        write_qmp_message(
            &mut stream,
            &serde_json::json!({
                "error": { "class": "CommandNotFound", "desc": "disabled" },
                "id": "qmp_capabilities"
            }),
        );
        command
    });
    let mut qemu = Command::new("sh")
        .args(["-c", "sleep 60"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();

    let error = wait_for_qemu_shutdown(&mut qemu, &rendered).unwrap_err();
    let error = format!("{error:#}");

    assert_eq!(
        qmp_server.join().unwrap(),
        "{\"execute\":\"qmp_capabilities\",\"id\":\"qmp_capabilities\"}\n"
    );
    assert!(error.contains("QMP qmp_capabilities command failed"));
    assert!(error.contains("CommandNotFound"));
    assert!(error.contains("was terminated and reaped"));
    assert!(qemu.try_wait().unwrap().is_some());
}

#[cfg(unix)]
#[test]
fn host_poweroff_requires_a_system_powerdown_acknowledgement() {
    let directory = tempdir().unwrap();
    let rendered = render_test_direct_build(&directory, QemuBuildConfig::default());
    let listener = UnixListener::bind(&rendered.paths.qmp_socket_path).unwrap();
    let qmp_server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let reader_stream = stream.try_clone().unwrap();
        let mut reader = BufReader::new(reader_stream);
        write_qmp_greeting(&mut stream);
        let capabilities = read_qmp_command(&mut reader, "qmp_capabilities");
        write_qmp_success(&mut stream, "qmp_capabilities");
        let powerdown = read_qmp_command(&mut reader, "system_powerdown");
        write_qmp_message(
            &mut stream,
            &serde_json::json!({
                "error": { "class": "GenericError", "desc": "powerdown rejected" },
                "id": "system_powerdown"
            }),
        );
        vec![capabilities, powerdown]
    });
    let mut qemu = Command::new("sh")
        .args(["-c", "sleep 60"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();

    let error = wait_for_qemu_shutdown(&mut qemu, &rendered).unwrap_err();
    let error = format!("{error:#}");

    assert_eq!(qmp_server.join().unwrap().len(), 2);
    assert!(error.contains("QMP system_powerdown command failed"));
    assert!(error.contains("powerdown rejected"));
    assert!(error.contains("was terminated and reaped"));
    assert!(qemu.try_wait().unwrap().is_some());
}

#[cfg(unix)]
#[test]
fn host_poweroff_requires_a_guest_shutdown_event_after_acknowledgement() {
    let directory = tempdir().unwrap();
    let rendered = render_test_direct_build(
        &directory,
        QemuBuildConfig {
            qemu_exit_timeout_seconds: 1,
            ..QemuBuildConfig::default()
        },
    );
    let listener = UnixListener::bind(&rendered.paths.qmp_socket_path).unwrap();
    let qmp_server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let reader_stream = stream.try_clone().unwrap();
        let mut reader = BufReader::new(reader_stream);
        write_qmp_greeting(&mut stream);
        read_qmp_command(&mut reader, "qmp_capabilities");
        write_qmp_success(&mut stream, "qmp_capabilities");
        read_qmp_command(&mut reader, "system_powerdown");
        write_qmp_success(&mut stream, "system_powerdown");
        thread::sleep(Duration::from_millis(1_100));
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
    let error = format!("{error:#}");

    qmp_server.join().unwrap();
    assert!(started_at.elapsed() >= Duration::from_millis(900));
    assert!(started_at.elapsed() < Duration::from_secs(3));
    assert!(error.contains("QMP deadline expired while waiting for guest SHUTDOWN event"));
    assert!(error.contains("was terminated and reaped"));
    assert!(qemu.try_wait().unwrap().is_some());
}

#[cfg(unix)]
#[test]
fn host_poweroff_rejects_a_non_guest_shutdown_event() {
    let directory = tempdir().unwrap();
    let rendered = render_test_direct_build(&directory, QemuBuildConfig::default());
    let listener = UnixListener::bind(&rendered.paths.qmp_socket_path).unwrap();
    let qmp_server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let reader_stream = stream.try_clone().unwrap();
        let mut reader = BufReader::new(reader_stream);
        write_qmp_greeting(&mut stream);
        read_qmp_command(&mut reader, "qmp_capabilities");
        write_qmp_success(&mut stream, "qmp_capabilities");
        read_qmp_command(&mut reader, "system_powerdown");
        write_qmp_success(&mut stream, "system_powerdown");
        write_qmp_message(
            &mut stream,
            &serde_json::json!({
                "event": "SHUTDOWN",
                "data": { "guest": false, "reason": "host-qmp-quit" }
            }),
        );
    });
    let mut qemu = Command::new("sh")
        .args(["-c", "sleep 60"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();

    let error = wait_for_qemu_shutdown(&mut qemu, &rendered).unwrap_err();
    let error = format!("{error:#}");

    qmp_server.join().unwrap();
    assert!(
        error.contains("QMP reported a non-guest or unexpected SHUTDOWN event"),
        "unexpected error: {error}"
    );
    assert!(error.contains("host-qmp-quit"));
    assert!(error.contains("was terminated and reaped"));
    assert!(qemu.try_wait().unwrap().is_some());
}

#[cfg(unix)]
#[test]
fn host_poweroff_rejects_shutdown_buffered_before_system_powerdown_ack() {
    let directory = tempdir().unwrap();
    let rendered = render_test_direct_build(&directory, QemuBuildConfig::default());
    let listener = UnixListener::bind(&rendered.paths.qmp_socket_path).unwrap();
    let qmp_server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let reader_stream = stream.try_clone().unwrap();
        let mut reader = BufReader::new(reader_stream);
        write_qmp_greeting(&mut stream);
        read_qmp_command(&mut reader, "qmp_capabilities");
        write_qmp_success(&mut stream, "qmp_capabilities");
        // Queueing a shutdown before the client can send system_powerdown
        // must not be accepted as proof that the request was honored.
        write_guest_shutdown_event(&mut stream);
        read_qmp_command(&mut reader, "system_powerdown");
        write_qmp_success(&mut stream, "system_powerdown");
    });
    let mut qemu = Command::new("sh")
        .args(["-c", "sleep 60"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();

    let error = wait_for_qemu_shutdown(&mut qemu, &rendered).unwrap_err();
    let error = format!("{error:#}");

    qmp_server.join().unwrap();
    assert!(
        error.contains("QMP reported shutdown before acknowledging system_powerdown"),
        "unexpected error: {error}"
    );
    assert!(error.contains("was terminated and reaped"));
    assert!(qemu.try_wait().unwrap().is_some());
}

#[cfg(unix)]
#[test]
fn host_poweroff_ignores_unrelated_events_after_acknowledgement() {
    let directory = tempdir().unwrap();
    let rendered = render_test_direct_build(
        &directory,
        QemuBuildConfig {
            qemu_exit_timeout_seconds: 1,
            ..QemuBuildConfig::default()
        },
    );
    let listener = UnixListener::bind(&rendered.paths.qmp_socket_path).unwrap();
    let exit_marker = directory.path().join("qemu-exit");
    let server_marker = exit_marker.clone();
    let qmp_server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let reader_stream = stream.try_clone().unwrap();
        let mut reader = BufReader::new(reader_stream);
        write_qmp_greeting(&mut stream);
        read_qmp_command(&mut reader, "qmp_capabilities");
        write_qmp_success(&mut stream, "qmp_capabilities");
        read_qmp_command(&mut reader, "system_powerdown");
        write_qmp_success(&mut stream, "system_powerdown");
        write_qmp_message(
            &mut stream,
            &serde_json::json!({ "event": "DEVICE_DELETED", "data": {} }),
        );
        write_guest_shutdown_event(&mut stream);
        std::fs::write(server_marker, "powerdown").unwrap();
    });
    let mut qemu = Command::new("sh")
        .args([
            "-c",
            "while [ ! -e \"$1\" ]; do sleep 0.01; done",
            "qemu-test",
        ])
        .arg(&exit_marker)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();

    wait_for_qemu_shutdown(&mut qemu, &rendered).unwrap();

    qmp_server.join().unwrap();
    assert!(qemu.try_wait().unwrap().unwrap().success());
}

#[cfg(unix)]
#[test]
fn host_poweroff_preserves_qmp_lines_fragmented_across_read_polls() {
    let directory = tempdir().unwrap();
    let rendered = render_test_direct_build(
        &directory,
        QemuBuildConfig {
            qemu_exit_timeout_seconds: 1,
            ..QemuBuildConfig::default()
        },
    );
    let listener = UnixListener::bind(&rendered.paths.qmp_socket_path).unwrap();
    let exit_marker = directory.path().join("qemu-exit");
    let server_marker = exit_marker.clone();
    let qmp_server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let reader_stream = stream.try_clone().unwrap();
        let mut reader = BufReader::new(reader_stream);
        write_qmp_greeting(&mut stream);
        read_qmp_command(&mut reader, "qmp_capabilities");
        write_qmp_success(&mut stream, "qmp_capabilities");
        read_qmp_command(&mut reader, "system_powerdown");
        write_qmp_success(&mut stream, "system_powerdown");
        stream.write_all(b"{\"event\":\"SHUT").unwrap();
        stream.flush().unwrap();
        thread::sleep(QMP_READ_POLL_INTERVAL + Duration::from_millis(50));
        stream
            .write_all(b"DOWN\",\"data\":{\"guest\":true,\"reason\":\"guest-shutdown\"}}\n")
            .unwrap();
        stream.flush().unwrap();
        std::fs::write(server_marker, "powerdown").unwrap();
    });
    let mut qemu = Command::new("sh")
        .args([
            "-c",
            "while [ ! -e \"$1\" ]; do sleep 0.01; done",
            "qemu-test",
        ])
        .arg(&exit_marker)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();

    wait_for_qemu_shutdown(&mut qemu, &rendered).unwrap();

    qmp_server.join().unwrap();
    assert!(qemu.try_wait().unwrap().unwrap().success());
}

#[cfg(unix)]
#[test]
fn host_poweroff_fails_when_qmp_closes_after_powerdown_ack() {
    let directory = tempdir().unwrap();
    let rendered = render_test_direct_build(&directory, QemuBuildConfig::default());
    let listener = UnixListener::bind(&rendered.paths.qmp_socket_path).unwrap();
    let qmp_server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let reader_stream = stream.try_clone().unwrap();
        let mut reader = BufReader::new(reader_stream);
        write_qmp_greeting(&mut stream);
        read_qmp_command(&mut reader, "qmp_capabilities");
        write_qmp_success(&mut stream, "qmp_capabilities");
        read_qmp_command(&mut reader, "system_powerdown");
        write_qmp_success(&mut stream, "system_powerdown");
    });
    let mut qemu = Command::new("sh")
        .args(["-c", "sleep 60"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();

    let error = wait_for_qemu_shutdown(&mut qemu, &rendered).unwrap_err();
    let error = format!("{error:#}");

    qmp_server.join().unwrap();
    assert!(
        error.contains("QMP socket closed before the guest SHUTDOWN event response"),
        "unexpected error: {error}"
    );
    assert!(error.contains("was terminated and reaped"));
    assert!(qemu.try_wait().unwrap().is_some());
}

#[cfg(unix)]
#[test]
fn host_poweroff_rejects_a_mismatched_qmp_response_id() {
    let directory = tempdir().unwrap();
    let rendered = render_test_direct_build(&directory, QemuBuildConfig::default());
    let listener = UnixListener::bind(&rendered.paths.qmp_socket_path).unwrap();
    let qmp_server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let reader_stream = stream.try_clone().unwrap();
        let mut reader = BufReader::new(reader_stream);
        write_qmp_greeting(&mut stream);
        read_qmp_command(&mut reader, "qmp_capabilities");
        write_qmp_message(
            &mut stream,
            &serde_json::json!({ "return": {}, "id": "wrong-command" }),
        );
    });
    let mut qemu = Command::new("sh")
        .args(["-c", "sleep 60"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();

    let error = wait_for_qemu_shutdown(&mut qemu, &rendered).unwrap_err();
    let error = format!("{error:#}");

    qmp_server.join().unwrap();
    assert!(error.contains("missing or mismatched id"));
    assert!(error.contains("wrong-command"));
    assert!(error.contains("was terminated and reaped"));
    assert!(qemu.try_wait().unwrap().is_some());
}

#[cfg(unix)]
#[test]
fn host_poweroff_fails_closed_when_qmp_closes_without_acknowledging() {
    let directory = tempdir().unwrap();
    let rendered = render_test_direct_build(&directory, QemuBuildConfig::default());
    let listener = UnixListener::bind(&rendered.paths.qmp_socket_path).unwrap();
    let qmp_server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let reader_stream = stream.try_clone().unwrap();
        let mut reader = BufReader::new(reader_stream);
        write_qmp_greeting(&mut stream);
        read_qmp_command(&mut reader, "qmp_capabilities")
    });
    let mut qemu = Command::new("sh")
        .args(["-c", "sleep 60"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();

    let error = wait_for_qemu_shutdown(&mut qemu, &rendered).unwrap_err();
    let error = format!("{error:#}");

    assert_eq!(
        qmp_server.join().unwrap(),
        "{\"execute\":\"qmp_capabilities\",\"id\":\"qmp_capabilities\"}\n"
    );
    assert!(error.contains("QMP socket closed before the qmp_capabilities response"));
    assert!(error.contains("was terminated and reaped"));
    assert!(qemu.try_wait().unwrap().is_some());
}

#[cfg(unix)]
#[test]
fn host_poweroff_fails_closed_when_qmp_reply_is_malformed() {
    let directory = tempdir().unwrap();
    let rendered = render_test_direct_build(&directory, QemuBuildConfig::default());
    let listener = UnixListener::bind(&rendered.paths.qmp_socket_path).unwrap();
    let qmp_server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let reader_stream = stream.try_clone().unwrap();
        let mut reader = BufReader::new(reader_stream);
        write_qmp_greeting(&mut stream);
        let command = read_qmp_command(&mut reader, "qmp_capabilities");
        stream.write_all(b"{not-json}\n").unwrap();
        stream.flush().unwrap();
        command
    });
    let mut qemu = Command::new("sh")
        .args(["-c", "sleep 60"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();

    let error = wait_for_qemu_shutdown(&mut qemu, &rendered).unwrap_err();
    let error = format!("{error:#}");

    assert_eq!(
        qmp_server.join().unwrap(),
        "{\"execute\":\"qmp_capabilities\",\"id\":\"qmp_capabilities\"}\n"
    );
    assert!(error.contains("QMP qmp_capabilities response was not valid JSON"));
    assert!(error.contains("was terminated and reaped"));
    assert!(qemu.try_wait().unwrap().is_some());
}

#[cfg(unix)]
#[test]
fn host_poweroff_fails_closed_when_qmp_never_acknowledges() {
    let directory = tempdir().unwrap();
    let rendered = render_test_direct_build(
        &directory,
        QemuBuildConfig {
            qemu_exit_timeout_seconds: 3,
            ..QemuBuildConfig::default()
        },
    );
    let listener = UnixListener::bind(&rendered.paths.qmp_socket_path).unwrap();
    let (release_qmp_tx, release_qmp_rx) = std::sync::mpsc::channel();
    let qmp_server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let reader_stream = stream.try_clone().unwrap();
        let mut reader = BufReader::new(reader_stream);
        write_qmp_greeting(&mut stream);
        let command = read_qmp_command(&mut reader, "qmp_capabilities");
        release_qmp_rx.recv().unwrap();
        command
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
    let error = format!("{error:#}");
    release_qmp_tx.send(()).unwrap();

    assert_eq!(
        qmp_server.join().unwrap(),
        "{\"execute\":\"qmp_capabilities\",\"id\":\"qmp_capabilities\"}\n"
    );
    assert!(started_at.elapsed() >= QMP_IO_TIMEOUT);
    assert!(started_at.elapsed() < Duration::from_secs(4));
    assert!(
        error.contains("QMP deadline expired while waiting for qmp_capabilities"),
        "{error}"
    );
    assert!(error.contains("was terminated and reaped"), "{error}");
    assert!(qemu.try_wait().unwrap().is_some());
}

#[cfg(unix)]
#[test]
fn host_poweroff_has_an_absolute_deadline_during_qmp_floods() {
    for payload in [
        b"{\"event\":\"DEVICE_DELETED\"}\n".as_slice(),
        b"\n".as_slice(),
    ] {
        let (error, elapsed, writes) = run_qmp_flood_case(payload);

        assert!(elapsed >= QMP_IO_TIMEOUT);
        assert!(elapsed < Duration::from_secs(4));
        assert!(writes > 10);
        assert!(error.contains("QMP deadline expired while waiting for qmp_capabilities"));
        assert!(error.contains("was terminated and reaped"));
    }
}

#[cfg(unix)]
#[test]
fn host_poweroff_fails_closed_when_acknowledged_qemu_stays_alive() {
    let directory = tempdir().unwrap();
    let rendered = render_test_direct_build(
        &directory,
        QemuBuildConfig {
            qemu_exit_timeout_seconds: 1,
            ..QemuBuildConfig::default()
        },
    );
    let listener = UnixListener::bind(&rendered.paths.qmp_socket_path).unwrap();
    let qmp_server = thread::spawn(move || serve_acknowledged_powerdown(listener, None));
    let mut qemu = Command::new("sh")
        .args(["-c", "sleep 60"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let started_at = Instant::now();

    let error = wait_for_qemu_shutdown(&mut qemu, &rendered).unwrap_err();
    let error = format!("{error:#}");

    assert_eq!(qmp_server.join().unwrap().len(), 2);
    assert!(started_at.elapsed() >= Duration::from_millis(900));
    assert!(started_at.elapsed() < Duration::from_secs(3));
    assert!(error.contains(
        "timed out waiting 1s for QEMU to exit after a guest-originated QMP shutdown event"
    ));
    assert!(error.contains("was terminated and reaped"));
    assert!(qemu.try_wait().unwrap().is_some());
}

#[cfg(unix)]
#[test]
fn host_poweroff_rejects_nonzero_qemu_exit_after_acknowledgement() {
    let directory = tempdir().unwrap();
    let rendered = render_test_direct_build(
        &directory,
        QemuBuildConfig {
            qemu_exit_timeout_seconds: 1,
            ..QemuBuildConfig::default()
        },
    );
    let listener = UnixListener::bind(&rendered.paths.qmp_socket_path).unwrap();
    let exit_marker = directory.path().join("qemu-exit");
    let server_marker = exit_marker.clone();
    let qmp_server =
        thread::spawn(move || serve_acknowledged_powerdown(listener, Some(server_marker)));
    let mut qemu = Command::new("sh")
        .args([
            "-c",
            "while [ ! -e \"$1\" ]; do sleep 0.01; done; exit 7",
            "qemu-test",
        ])
        .arg(&exit_marker)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();

    let error = wait_for_qemu_shutdown(&mut qemu, &rendered).unwrap_err();

    assert_eq!(qmp_server.join().unwrap().len(), 2);
    let error = format!("{error:#}");
    assert!(
        error.contains("QEMU exited with status exit status: 7"),
        "unexpected error: {error}"
    );
    assert!(qemu.try_wait().unwrap().is_some());
}
