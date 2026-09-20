use std::process::Command;

#[test]
fn trace_exporter_starts_with_the_agents_tls_features() {
    // A child process proves startup order without a provider installed by other tests.
    let output = Command::new(env!("CARGO_BIN_EXE_intar-agent"))
        .arg("--help")
        .env("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:9")
        .output()
        .expect("start agent");
    assert!(output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!stderr.contains("trace exporter setup failed"), "{stderr}");
    assert!(!stderr.contains("panicked"), "{stderr}");
}

#[cfg(target_os = "linux")]
#[test]
fn offline_status_is_one_json_document_and_drain_survives_restart() {
    let directory = tempfile::tempdir().expect("status command fixture");
    let config = directory.path().join("config.toml");
    std::fs::write(&config, "[server]\nbind = \"127.0.0.1:1\"\n[image_registry]\nurl = \"https://example.test/images\"\n").expect("status command fixture");
    let run = |argument: &str| {
        Command::new(env!("CARGO_BIN_EXE_intar-agent"))
            .args([
                "--config",
                config.to_str().expect("status command fixture"),
                argument,
            ])
            .env("XDG_STATE_HOME", directory.path())
            .env_remove("OTEL_EXPORTER_OTLP_ENDPOINT")
            .output()
            .expect("status command fixture")
    };
    assert!(run("--drain").status.success());
    let output = run("--status");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let status: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("status command fixture");
    assert_eq!(status["draining"], true);
    assert_eq!(status["trackedVms"], 0);
    assert_eq!(status["ready"], false);
    assert!(String::from_utf8_lossy(&output.stderr).contains("opening sqlite db"));
    assert!(run("--resume").status.success());
    let resumed: serde_json::Value =
        serde_json::from_slice(&run("--status").stdout).expect("status command fixture");
    assert_eq!(resumed["draining"], false);
}
