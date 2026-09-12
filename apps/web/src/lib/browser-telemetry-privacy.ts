import type { EventEvent, ExceptionEvent, MeasurementEvent, TraceEvent, TransportItem } from "@grafana/faro-web-sdk";

const ROUTE_PARTS = new Set(["api", "auth", "sign-in", "sign-out", "social", "sso", "callback", "github", "get-session", "scenarios", "courses", "runs", "admin", "organizations", "access", "settings", "profile", "start", "stop", "status", "terminal", "session", "join", "learn"]);

/** Remove query strings, fragments, user names, and arbitrary path values. */
export function telemetryUrl(value: string): string {
  try {
    const url = new URL(value, "https://intar.dev");
    if (url.origin !== "https://intar.dev") return "external";
    return `${url.origin}/${url.pathname.split("/").filter(Boolean).map((part) => ROUTE_PARTS.has(part) ? part : ":id").join("/")}`;
  } catch { return "invalid"; }
}

const SPAN_ATTRIBUTES = new Set(["http.method", "http.request.method", "http.status_code", "http.response.status_code", "http.response_content_length", "http.response.body.size", "component", "service.name", "service.version", "deployment.environment.name", "faro.session.id", "intar.run.id", "intar.stage"]);

export function sanitizeBrowserTelemetry(item: TransportItem): TransportItem | null {
  if (item.type === "log") return null;
  const meta = {
    ...(item.meta.app ? { app: item.meta.app } : {}),
    ...(item.meta.sdk ? { sdk: item.meta.sdk } : {}),
    ...(item.meta.session?.id ? { session: {
      id: item.meta.session.id,
      // Faro checks this after beforeSend and removes it before transport.
      attributes: { isSampled: item.meta.session.attributes?.isSampled === "true" ? "true" : "false" },
    } } : {}),
    page: { url: telemetryUrl(item.meta.page?.url ?? "/") },
  };
  if (item.type === "exception") {
    const error = item.payload as ExceptionEvent;
    return { type: item.type, meta, payload: {
      timestamp: error.timestamp,
      type: /^(TypeError|RangeError|ReferenceError|SyntaxError|URIError|Error)$/u.test(error.type) ? error.type : "Error",
      value: "Unhandled browser error",
      stacktrace: { frames: (error.stacktrace?.frames ?? []).slice(0, 20).map((frame) => ({
        // Only built application chunks can identify source locations.
        filename: /^https:\/\/intar\.dev\/_astro\/[a-zA-Z0-9_.-]+\.js(?:[?#].*)?$/u.test(frame.filename)
          ? frame.filename.split(/[?#]/u)[0] ?? "application" : "application",
        function: "", ...(frame.lineno === undefined ? {} : { lineno: frame.lineno }),
        ...(frame.colno === undefined ? {} : { colno: frame.colno }),
      })) },
    } };
  }
  if (item.type === "measurement") {
    const measurement = item.payload as MeasurementEvent;
    return { type: item.type, meta, payload: {
      type: measurement.type, timestamp: measurement.timestamp,
      values: Object.fromEntries(Object.entries(measurement.values).filter(([key, value]) => /^[a-zA-Z0-9_.-]{1,64}$/u.test(key) && Number.isFinite(value))),
    } };
  }
  if (item.type === "event") {
    const event = item.payload as EventEvent;
    if (!/^(session_(start|resume|extend)|view_changed)$/u.test(event.name)) return null;
    return { type: item.type, meta, payload: { name: event.name, timestamp: event.timestamp, attributes: {} } };
  }
  if (item.type === "trace") {
    const trace = item.payload as TraceEvent;
    return { type: item.type, meta, payload: {
      resourceSpans: (trace.resourceSpans ?? []).map((resource) => ({
        resource: { attributes: (resource.resource?.attributes ?? []).filter((attribute) => SPAN_ATTRIBUTES.has(attribute.key)), droppedAttributesCount: 0 },
        scopeSpans: (resource.scopeSpans ?? []).map((scope) => ({
          scope: { name: scope.scope?.name ?? "browser" },
          spans: (scope.spans ?? []).map((span) => ({
            traceId: span.traceId, spanId: span.spanId,
            ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
            name: span.name === "browser.vm_boot_stage" ? span.name : "browser.http", kind: span.kind, startTimeUnixNano: span.startTimeUnixNano,
            endTimeUnixNano: span.endTimeUnixNano, status: { code: span.status?.code },
            attributes: span.attributes.flatMap((attribute) => {
              if (["http.url", "url.full"].includes(attribute.key)) {
                return [{ key: attribute.key, value: { stringValue: telemetryUrl(attribute.value?.stringValue ?? "") } }];
              }
              return SPAN_ATTRIBUTES.has(attribute.key) ? [attribute] : [];
            }),
            events: [], links: [], droppedAttributesCount: 0, droppedEventsCount: 0, droppedLinksCount: 0,
          })),
        })),
      })),
    } };
  }
  return null;
}
