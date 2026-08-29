use super::{
    CommandJsonPathProbe, FileRegexCaptureProbe, PortOpenProbe, ProbeStatus, ProbeValue,
    pod_matches_condition, pod_matches_phase,
};
use crate::config::{PodCondition, PodPhase, PortProtocol};
use k8s_openapi::api::core::v1::{Pod, PodCondition as K8sPodCondition, PodStatus};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use serde_json::json;
use std::fs;

#[tokio::test]
async fn regex_probe_captures_multiline_content() {
    let temp = tempfile::tempdir();
    assert!(temp.is_ok());
    let dir = match temp {
        Ok(value) => value,
        Err(error) => panic!("failed to create tempdir: {error}"),
    };

    let file_path = dir.path().join("config.txt");
    let write_result = fs::write(&file_path, "first line\nvalue=abc123\nthird line\n");
    assert!(write_result.is_ok());

    let regex = regex::Regex::new(r"value=(\w+)");
    assert!(regex.is_ok());
    let compiled = match regex {
        Ok(value) => value,
        Err(error) => panic!("failed to compile regex: {error}"),
    };

    let probe = FileRegexCaptureProbe {
        path: file_path,
        pattern: "value=(\\w+)".to_owned(),
        regex: compiled,
    };

    let result = probe.run().await;
    assert_eq!(result.status, ProbeStatus::Pass);

    match result.value {
        ProbeValue::FileRegexCapture(value) => {
            assert!(value.matched);
            assert_eq!(value.full_match, "value=abc123");
            assert_eq!(value.captures, vec!["abc123".to_owned()]);
            assert!(value.file_content.contains("first line"));
        }
        _ => panic!("unexpected probe value type"),
    }
}

#[tokio::test]
async fn tcp_port_probe_passes_when_listener_is_available() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await;
    assert!(listener.is_ok());
    let tcp_listener = match listener {
        Ok(value) => value,
        Err(error) => panic!("failed to bind tcp listener: {error}"),
    };

    let local_addr = tcp_listener.local_addr();
    assert!(local_addr.is_ok());
    let port = match local_addr {
        Ok(value) => value.port(),
        Err(error) => panic!("failed to read tcp listener addr: {error}"),
    };

    let probe = PortOpenProbe {
        host: "127.0.0.1".to_owned(),
        port,
        protocol: PortProtocol::Tcp,
    };

    let result = probe.run().await;
    assert_eq!(result.status, ProbeStatus::Pass);

    match result.value {
        ProbeValue::PortOpen(value) => {
            assert!(value.open);
            assert_eq!(value.port, port);
        }
        _ => panic!("unexpected probe value type"),
    }
}

#[cfg(unix)]
#[tokio::test]
async fn command_json_path_probe_matches_expected_value() {
    let temp = tempfile::tempdir();
    assert!(temp.is_ok());
    let dir = match temp {
        Ok(value) => value,
        Err(error) => panic!("failed to create tempdir: {error}"),
    };

    let file_path = dir.path().join("service-status.json");
    let write_result = fs::write(
        &file_path,
        r#"{"peers":{"connected":1},"service":{"enabled":true}}"#,
    );
    assert!(write_result.is_ok());

    let probe = CommandJsonPathProbe {
        argv: vec![
            "/bin/cat".to_owned(),
            file_path.to_string_lossy().into_owned(),
        ],
        json_path: "$.service.enabled".to_owned(),
        expected: Some(json!(true)),
    };

    let result = probe.run().await;
    assert_eq!(result.status, ProbeStatus::Pass);

    match result.value {
        ProbeValue::CommandJsonPath(value) => {
            assert!(value.matched);
            assert_eq!(value.matched_values, vec!["true".to_owned()]);
            assert_eq!(value.expected_json, "true");
        }
        _ => panic!("unexpected probe value type"),
    }
}

#[cfg(unix)]
#[tokio::test]
async fn command_json_path_probe_passes_when_path_exists() {
    let temp = tempfile::tempdir();
    assert!(temp.is_ok());
    let dir = match temp {
        Ok(value) => value,
        Err(error) => panic!("failed to create tempdir: {error}"),
    };

    let file_path = dir.path().join("service-status.json");
    let write_result = fs::write(
        &file_path,
        r#"{"service":{"sessions":[{"remoteAddress":"10.48.162.109:39148"}]}}"#,
    );
    assert!(write_result.is_ok());

    let probe = CommandJsonPathProbe {
        argv: vec![
            "/bin/cat".to_owned(),
            file_path.to_string_lossy().into_owned(),
        ],
        json_path: "$.service.sessions[*].remoteAddress".to_owned(),
        expected: None,
    };

    let result = probe.run().await;
    assert_eq!(result.status, ProbeStatus::Pass);

    match result.value {
        ProbeValue::CommandJsonPath(value) => {
            assert!(value.matched);
            assert_eq!(
                value.matched_values,
                vec!["\"10.48.162.109:39148\"".to_owned()]
            );
        }
        _ => panic!("unexpected probe value type"),
    }
}

#[cfg(unix)]
#[tokio::test]
async fn command_json_path_probe_fails_when_expected_value_is_missing() {
    let temp = tempfile::tempdir();
    assert!(temp.is_ok());
    let dir = match temp {
        Ok(value) => value,
        Err(error) => panic!("failed to create tempdir: {error}"),
    };

    let file_path = dir.path().join("service-status.json");
    let write_result = fs::write(&file_path, r#"{"service":{"enabled":false}}"#);
    assert!(write_result.is_ok());

    let probe = CommandJsonPathProbe {
        argv: vec![
            "/bin/cat".to_owned(),
            file_path.to_string_lossy().into_owned(),
        ],
        json_path: "$.service.enabled".to_owned(),
        expected: Some(json!(true)),
    };

    let result = probe.run().await;
    assert_eq!(result.status, ProbeStatus::Fail);
    assert!(result.error.is_none());

    match result.value {
        ProbeValue::CommandJsonPath(value) => {
            assert!(!value.matched);
            assert_eq!(value.matched_values, vec!["false".to_owned()]);
            assert_eq!(value.expected_json, "true");
        }
        _ => panic!("unexpected probe value type"),
    }
}

#[cfg(unix)]
#[tokio::test]
async fn command_json_path_probe_fails_when_stdout_is_not_json() {
    let temp = tempfile::tempdir();
    assert!(temp.is_ok());
    let dir = match temp {
        Ok(value) => value,
        Err(error) => panic!("failed to create tempdir: {error}"),
    };

    let file_path = dir.path().join("not-json.txt");
    let write_result = fs::write(&file_path, "definitely not json");
    assert!(write_result.is_ok());

    let probe = CommandJsonPathProbe {
        argv: vec![
            "/bin/cat".to_owned(),
            file_path.to_string_lossy().into_owned(),
        ],
        json_path: "$.sshServer.enabled".to_owned(),
        expected: Some(json!(true)),
    };

    let result = probe.run().await;
    assert_eq!(result.status, ProbeStatus::Fail);
    assert!(
        result
            .error
            .as_deref()
            .is_some_and(|error| error.contains("failed to parse stdout as JSON"))
    );

    match result.value {
        ProbeValue::CommandJsonPath(value) => {
            assert!(!value.matched);
            assert_eq!(value.stdout, "definitely not json");
            assert_eq!(value.exit_code, 0);
        }
        _ => panic!("unexpected probe value type"),
    }
}

#[cfg(unix)]
#[tokio::test]
async fn command_json_path_probe_fails_when_command_exits_non_zero() {
    let probe = CommandJsonPathProbe {
        argv: vec![
            "/bin/sh".to_owned(),
            "-c".to_owned(),
            "printf '{\"sshServer\":{\"enabled\":true}}'; exit 7".to_owned(),
        ],
        json_path: "$.sshServer.enabled".to_owned(),
        expected: Some(json!(true)),
    };

    let result = probe.run().await;
    assert_eq!(result.status, ProbeStatus::Fail);
    assert!(
        result
            .error
            .as_deref()
            .is_some_and(|error| error.contains("command exited with status"))
    );

    match result.value {
        ProbeValue::CommandJsonPath(value) => {
            assert!(!value.matched);
            assert_eq!(value.stdout, "{\"sshServer\":{\"enabled\":true}}");
            assert_eq!(value.exit_code, 7);
        }
        _ => panic!("unexpected probe value type"),
    }
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn cancelling_a_command_probe_kills_its_process_group_and_grandchild() {
    use rustix::process::{Pid, test_kill_process};
    use tokio::time::{Duration, sleep};

    let temp = tempfile::tempdir().expect("tempdir");
    let shell_pid = temp.path().join("shell.pid");
    let child_pid = temp.path().join("child.pid");
    let script = format!(
        "printf '%s' \"$$\" > '{}'; sleep 10 & child=$!; printf '%s' \"$child\" > '{}'; wait",
        shell_pid.display(),
        child_pid.display(),
    );
    let probe = CommandJsonPathProbe {
        argv: vec!["/bin/sh".to_owned(), "-c".to_owned(), script],
        json_path: "$.passed".to_owned(),
        expected: Some(json!(true)),
    };
    let task = tokio::spawn(async move { probe.run().await });
    tokio::time::timeout(Duration::from_secs(1), async {
        while !shell_pid.exists() || !child_pid.exists() {
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("shell and child start");
    let shell = std::fs::read_to_string(&shell_pid)
        .expect("shell pid")
        .trim()
        .parse::<i32>()
        .expect("parse shell pid");
    let child = std::fs::read_to_string(&child_pid)
        .expect("child pid")
        .trim()
        .parse::<i32>()
        .expect("parse child pid");
    task.abort();
    let _ = task.await;

    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let shell_alive =
                Pid::from_raw(shell).is_some_and(|pid| test_kill_process(pid).is_ok());
            let child_alive =
                Pid::from_raw(child).is_some_and(|pid| test_kill_process(pid).is_ok());
            if !shell_alive && !child_alive {
                break;
            }
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("process group is gone after cancellation");
}

#[test]
fn phase_match_uses_pod_status_phase() {
    let pod = Pod {
        metadata: ObjectMeta {
            name: Some("api-0".to_owned()),
            ..ObjectMeta::default()
        },
        status: Some(PodStatus {
            phase: Some("Running".to_owned()),
            ..PodStatus::default()
        }),
        ..Pod::default()
    };

    assert!(pod_matches_phase(PodPhase::Running, &pod));
    assert!(!pod_matches_phase(PodPhase::Succeeded, &pod));
}

#[test]
fn condition_match_checks_true_condition() {
    let pod = Pod {
        metadata: ObjectMeta {
            name: Some("api-0".to_owned()),
            ..ObjectMeta::default()
        },
        status: Some(PodStatus {
            conditions: Some(vec![K8sPodCondition {
                type_: "Ready".to_owned(),
                status: "True".to_owned(),
                ..K8sPodCondition::default()
            }]),
            ..PodStatus::default()
        }),
        ..Pod::default()
    };

    assert!(pod_matches_condition(PodCondition::Ready, &pod));
    assert!(!pod_matches_condition(PodCondition::Initialized, &pod));
}
