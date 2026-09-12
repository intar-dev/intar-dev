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
