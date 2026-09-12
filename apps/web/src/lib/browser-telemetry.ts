import { ErrorsInstrumentation, SessionInstrumentation, WebVitalsInstrumentation, initializeFaro } from "@grafana/faro-web-sdk";
import { TracingInstrumentation } from "@grafana/faro-web-tracing";
import { sanitizeBrowserTelemetry } from "./browser-telemetry-privacy";

/** The collector ID is public and restricted to this origin in Grafana. */
export function initializeBrowserTelemetry() {
  if (location.origin !== "https://intar.dev") return;
  try {
    const faro = initializeFaro({
      url: "https://faro-collector-prod-eu-west-2.grafana.net/collect/267676b3afb447820d9a46f07140de07",
      app: { name: "intar-web", version: import.meta.env.PUBLIC_RELEASE_VERSION || "development", environment: "production" },
      sessionTracking: { enabled: true, persistent: false, samplingRate: 1 },
      beforeSend: sanitizeBrowserTelemetry,
      instrumentations: [
        new ErrorsInstrumentation(), new SessionInstrumentation(), new WebVitalsInstrumentation(),
        new TracingInstrumentation({
          omitTraceContextForUnsampledSessions: true,
          instrumentationOptions: { propagateTraceHeaderCorsUrls: [] },
        }),
      ],
    });
    // Existing boot marks contain only stage times and correlation IDs.
    const stages = new Set(["start-click", "start-request", "start-accepted", "status-ready", "terminal-module", "terminal-font", "terminal-session-request", "terminal-session", "terminal-websocket-open", "terminal-connected", "terminal-first-output", "terminal-input", "terminal-input-output"]);
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const stage = entry.name.replace(/^intar:vm-boot:/u, "");
        const detail = (entry as PerformanceMark).detail;
        if (!entry.name.startsWith("intar:vm-boot:") || !stages.has(stage) || !detail) continue;
        const duration = detail.unixMs - detail.startUnixMs;
        if (Number.isFinite(duration) && duration >= 0 && duration < 3_600_000) {
          faro.api.pushMeasurement({ type: "vm_boot", values: { [stage]: duration } });
          if (typeof detail.runId === "string" && /^[a-zA-Z0-9_-]{1,128}$/u.test(detail.runId)) {
            const tracer = faro.api.getOTEL()?.trace.getTracer("intar-web");
            const span = tracer?.startSpan("browser.vm_boot_stage", {
              startTime: new Date(detail.startUnixMs),
              attributes: { "intar.run.id": detail.runId, "intar.stage": stage },
            });
            span?.end(new Date(detail.unixMs));
          }
        }
      }
    });
    observer.observe({ type: "mark", buffered: true });
  } catch { /* Telemetry must not stop application or terminal startup. */ }
}
