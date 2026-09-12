//! Set OTEL_EXPORTER_OTLP_ENDPOINT to a test receiver before running this probe.
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _telemetry = intar_observability::init(
        "intar-observability-check",
        env!("CARGO_PKG_VERSION"),
        "info",
        true,
    )?;
    {
        let span = tracing::info_span!("otel_validation", validation = true);
        let _entered = span.enter();
        tracing::info!("test-log-only-marker");
    }
    Ok(())
}
