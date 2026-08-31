use super::{DesiredPodState, ServerBind, load_from_file};
use std::fs;
use std::str::FromStr;

#[test]
fn parses_probe_blocks_from_hcl() {
    let temp = tempfile::tempdir();
    assert!(temp.is_ok());
    let dir = match temp {
        Ok(value) => value,
        Err(error) => panic!("failed to create tempdir: {error}"),
    };

    let config_path = dir.path().join("kino.hcl");
    let hcl = r#"
        server {
          bind = "tcp://127.0.0.1:9000"
        }

        defaults {
          every_seconds = 5
          timeout_seconds = 2
          kubeconfig = "/tmp/kubeconfig"
        }

        recording {
          output_dir = "/tmp/kino-recordings"
          real_shell = "/bin/sh"
        }

        probe "hosts" {
          kind = "file_exists"
          path = "/etc/hosts"
        }

        probe "ssh" {
          kind = "port_open"
          host = "127.0.0.1"
          port = 22
          protocol = "tcp"
        }

        probe "ssh_status" {
          kind = "command_json_path"
          argv = ["statusctl", "ssh", "--json"]
          json_path = "$.enabled"
          expected = true
        }
    "#;

    let write_result = fs::write(&config_path, hcl);
    assert!(write_result.is_ok());

    let loaded = load_from_file(&config_path);
    assert!(loaded.is_ok());
    let config = match loaded {
        Ok(value) => value,
        Err(error) => panic!("failed to parse config: {error}"),
    };

    match config.server_bind {
        ServerBind::Tcp(addr) => assert_eq!(addr.port(), 9000),
        ServerBind::Unix(path) => panic!("unexpected unix socket binding: {}", path.display()),
        ServerBind::Vsock { cid, port } => {
            panic!("unexpected vsock binding: cid={cid}, port={port}")
        }
    }
    assert_eq!(
        config
            .recording
            .as_ref()
            .map(|recording| recording.output_dir.as_path()),
        Some(std::path::Path::new("/tmp/kino-recordings"))
    );
    assert_eq!(
        config
            .recording
            .as_ref()
            .map(|recording| recording.real_shell.as_path()),
        Some(std::path::Path::new("/bin/sh"))
    );
    assert_eq!(config.probes.len(), 3);
}

#[test]
fn parses_unix_socket_server_binding() {
    let temp = tempfile::tempdir();
    assert!(temp.is_ok());
    let dir = match temp {
        Ok(value) => value,
        Err(error) => panic!("failed to create tempdir: {error}"),
    };

    let socket_path = dir.path().join("kino.sock");
    let config_path = dir.path().join("kino.hcl");
    let hcl = format!(
        r#"
        server {{
          bind = "unix://{}"
        }}
    "#,
        socket_path.display()
    );

    let write_result = fs::write(&config_path, hcl);
    assert!(write_result.is_ok());

    let loaded = load_from_file(&config_path);
    assert!(loaded.is_ok());
    let config = match loaded {
        Ok(value) => value,
        Err(error) => panic!("failed to parse config: {error}"),
    };

    match config.server_bind {
        ServerBind::Unix(path) => assert_eq!(path, socket_path),
        ServerBind::Tcp(addr) => panic!("unexpected tcp binding: {addr}"),
        ServerBind::Vsock { cid, port } => {
            panic!("unexpected vsock binding: cid={cid}, port={port}")
        }
    }
}

#[test]
fn parses_vsock_server_binding() {
    let temp = tempfile::tempdir();
    assert!(temp.is_ok());
    let dir = match temp {
        Ok(value) => value,
        Err(error) => panic!("failed to create tempdir: {error}"),
    };

    let config_path = dir.path().join("kino.hcl");
    let hcl = r#"
        server {
          bind = "vsock://3:8080"
        }
    "#;

    let write_result = fs::write(&config_path, hcl);
    assert!(write_result.is_ok());

    let loaded = load_from_file(&config_path);
    assert!(loaded.is_ok());
    let config = match loaded {
        Ok(value) => value,
        Err(error) => panic!("failed to parse config: {error}"),
    };

    match config.server_bind {
        ServerBind::Vsock { cid, port } => {
            assert_eq!(cid, 3);
            assert_eq!(port, 8080);
        }
        ServerBind::Tcp(addr) => panic!("unexpected tcp binding: {addr}"),
        ServerBind::Unix(path) => panic!("unexpected unix binding: {}", path.display()),
    }
}

#[test]
fn rejects_server_binding_when_missing_bind() {
    let temp = tempfile::tempdir();
    assert!(temp.is_ok());
    let dir = match temp {
        Ok(value) => value,
        Err(error) => panic!("failed to create tempdir: {error}"),
    };

    let config_path = dir.path().join("kino.hcl");
    let hcl = r"
        server {}
    ";

    let write_result = fs::write(&config_path, hcl);
    assert!(write_result.is_ok());

    let loaded = load_from_file(&config_path);
    assert!(loaded.is_err());
}

#[test]
fn rejects_invalid_desired_state_values() {
    let parsed = DesiredPodState::from_str("condition:NotARealState");
    assert!(parsed.is_err());
}

#[test]
fn recording_defaults_real_shell() {
    let temp = tempfile::tempdir();
    assert!(temp.is_ok());
    let dir = match temp {
        Ok(value) => value,
        Err(error) => panic!("failed to create tempdir: {error}"),
    };

    let config_path = dir.path().join("kino.hcl");
    let hcl = r#"
        server {
          bind = "tcp://127.0.0.1:9000"
        }

        recording {
          output_dir = "/tmp/kino-recordings"
        }
    "#;

    let write_result = fs::write(&config_path, hcl);
    assert!(write_result.is_ok());

    let loaded = load_from_file(&config_path);
    assert!(loaded.is_ok());
    let config = match loaded {
        Ok(value) => value,
        Err(error) => panic!("failed to parse config: {error}"),
    };

    assert_eq!(
        config
            .recording
            .as_ref()
            .map(|recording| recording.real_shell.as_path()),
        Some(std::path::Path::new("/bin/bash"))
    );
}

#[test]
fn rejects_relative_recording_output_dir() {
    let temp = tempfile::tempdir();
    assert!(temp.is_ok());
    let dir = match temp {
        Ok(value) => value,
        Err(error) => panic!("failed to create tempdir: {error}"),
    };

    let config_path = dir.path().join("kino.hcl");
    let hcl = r#"
        server {
          bind = "tcp://127.0.0.1:9000"
        }

        recording {
          output_dir = "relative-recordings"
        }
    "#;

    let write_result = fs::write(&config_path, hcl);
    assert!(write_result.is_ok());

    let loaded = load_from_file(&config_path);
    assert!(loaded.is_err());
}

#[test]
fn rejects_command_json_path_without_argv() {
    let temp = tempfile::tempdir();
    assert!(temp.is_ok());
    let dir = match temp {
        Ok(value) => value,
        Err(error) => panic!("failed to create tempdir: {error}"),
    };

    let config_path = dir.path().join("kino.hcl");
    let hcl = r#"
        server {
          bind = "tcp://127.0.0.1:9000"
        }

        probe "service_status" {
          kind = "command_json_path"
          argv = []
          json_path = "$.sshServer.enabled"
          expected = true
        }
    "#;

    let write_result = fs::write(&config_path, hcl);
    assert!(write_result.is_ok());

    let loaded = load_from_file(&config_path);
    assert!(loaded.is_err());
}

#[test]
fn rejects_command_json_path_without_json_path() {
    let temp = tempfile::tempdir();
    assert!(temp.is_ok());
    let dir = match temp {
        Ok(value) => value,
        Err(error) => panic!("failed to create tempdir: {error}"),
    };

    let config_path = dir.path().join("kino.hcl");
    let hcl = r#"
        server {
          bind = "tcp://127.0.0.1:9000"
        }

        probe "service_status" {
          kind = "command_json_path"
          argv = ["statusctl", "ssh", "--json"]
          json_path = "   "
        }
    "#;

    let write_result = fs::write(&config_path, hcl);
    assert!(write_result.is_ok());

    let loaded = load_from_file(&config_path);
    assert!(loaded.is_err());
}

#[test]
fn rejects_command_json_path_with_invalid_json_path() {
    let temp = tempfile::tempdir();
    assert!(temp.is_ok());
    let dir = match temp {
        Ok(value) => value,
        Err(error) => panic!("failed to create tempdir: {error}"),
    };

    let config_path = dir.path().join("kino.hcl");
    let hcl = r#"
        server {
          bind = "tcp://127.0.0.1:9000"
        }

        probe "service_status" {
          kind = "command_json_path"
          argv = ["statusctl", "ssh", "--json"]
          json_path = "$["
        }
    "#;

    let write_result = fs::write(&config_path, hcl);
    assert!(write_result.is_ok());

    let loaded = load_from_file(&config_path);
    assert!(loaded.is_err());
}

#[test]
fn ignores_legacy_intar_probe_attributes() {
    let dir = tempfile::tempdir().expect("tempdir");
    let config_path = dir.path().join("kino.hcl");
    let hcl = r#"
        server { bind = "tcp://127.0.0.1:9000" }
        probe "legacy" {
          kind = "file_exists"
          path = "/dev/null"
          intar_alias = "check_1"
          intar_label = " "
          intar_phase = "retired"
          intar_module = "_retired"
        }
    "#;
    fs::write(&config_path, hcl).expect("write config");

    let config = load_from_file(&config_path).expect("parse config");
    assert_eq!(config.probes.len(), 1);
    assert_eq!(config.probes[0].id, "legacy");
}

#[test]
fn accepts_the_manual_check_timeout_boundary_and_rejects_unfinishable_values() {
    let temp = tempfile::tempdir().expect("tempdir");
    let accepted = temp.path().join("accepted.hcl");
    fs::write(
        &accepted,
        r#"
            server { bind = "tcp://127.0.0.1:9000" }
            probe "boundary" {
              kind = "file_exists"
              path = "/dev/null"
              timeout_seconds = 120
            }
        "#,
    )
    .expect("write accepted config");
    assert!(load_from_file(&accepted).is_ok());

    let rejected = temp.path().join("rejected.hcl");
    fs::write(
        &rejected,
        r#"
            server { bind = "tcp://127.0.0.1:9000" }
            probe "too-slow" {
              kind = "file_exists"
              path = "/dev/null"
              timeout_seconds = 121
            }
        "#,
    )
    .expect("write rejected config");
    let error = load_from_file(&rejected).expect_err("timeout beyond control budget must fail");
    assert!(error.to_string().contains("maximum is 120"));
}
