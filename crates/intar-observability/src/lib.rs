//! Service logs go to journald. Optional spans go to the local Alloy receiver.
use std::time::Duration;

use opentelemetry::{KeyValue, trace::TracerProvider as _};
use opentelemetry_otlp::{Protocol, WithExportConfig};
use opentelemetry_sdk::{
    Resource,
    trace::{BatchConfigBuilder, BatchSpanProcessor, SdkTracerProvider},
};
use tracing_subscriber::{EnvFilter, Layer, filter::filter_fn, prelude::*};

/// Keep this guard alive for the service lifetime to flush bounded pending spans.
pub struct TelemetryGuard(Option<SdkTracerProvider>);

impl Drop for TelemetryGuard {
    fn drop(&mut self) {
        if let Some(provider) = self.0.take() {
            // The blocking HTTP client must be dropped outside a Tokio runtime.
            let _ = std::thread::spawn(move || {
                let _ = provider.shutdown_with_timeout(Duration::from_secs(2));
            })
            .join();
        }
    }
}

pub fn init(
    service: &'static str,
    version: &'static str,
    default_filter: &str,
    json: bool,
) -> anyhow::Result<TelemetryGuard> {
    let configured =
        std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT").is_ok_and(|value| !value.trim().is_empty());
    // Construct the blocking exporter on its own thread, for both sync and Tokio services.
    let provider = if configured {
        match std::thread::spawn(move || build_provider(service, version)).join() {
            Ok(Ok(provider)) => Some(provider),
            _ => {
                eprintln!(
                    "intar-observability: trace exporter setup failed; service logs remain enabled"
                );
                None
            }
        }
    } else {
        None
    };
    let telemetry = provider.as_ref().map(|provider| {
        tracing_opentelemetry::layer()
            .with_tracer(provider.tracer(service))
            // Existing log messages can contain data unsuitable for trace attributes.
            .with_filter(filter_fn(|metadata| metadata.is_span()))
    });
    let subscriber = tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(default_filter)))
        .with(telemetry);
    if json {
        subscriber
            .with(tracing_subscriber::fmt::layer().json())
            .try_init()?;
    } else {
        subscriber
            .with(tracing_subscriber::fmt::layer())
            .try_init()?;
    }
    Ok(TelemetryGuard(provider))
}

fn build_provider(
    service: &'static str,
    version: &'static str,
) -> anyhow::Result<SdkTracerProvider> {
    let exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_http()
        .with_protocol(Protocol::HttpBinary)
        .with_timeout(Duration::from_secs(2))
        .build()?;
    let processor = BatchSpanProcessor::builder(exporter)
        .with_batch_config(
            BatchConfigBuilder::default()
                .with_max_queue_size(2048)
                .with_max_export_batch_size(256)
                .with_scheduled_delay(Duration::from_secs(5))
                .build(),
        )
        .build();
    Ok(SdkTracerProvider::builder()
        .with_span_processor(processor)
        .with_resource(
            Resource::builder()
                .with_service_name(service)
                .with_attribute(KeyValue::new("service.version", version))
                .build(),
        )
        .with_max_attributes_per_span(32)
        .with_max_events_per_span(0)
        .build())
}
