import { describe, expect, it } from "vitest";
import { TransportItemType, type TransportItem } from "@grafana/faro-web-sdk";
import { sanitizeBrowserTelemetry, telemetryUrl } from "./browser-telemetry-privacy";

describe("browser telemetry privacy", () => {
  const secret = "secret-token-and-terminal-output";
  it("preserves Faro sampling admission while removing arbitrary session data", () => {
    for (const isSampled of ["true", "false"]) {
      const result = sanitizeBrowserTelemetry({ type: TransportItemType.EVENT,
        meta: { session: { id: "sample-session", attributes: { isSampled, private: secret } } },
        payload: { name: "session_start", timestamp: "2026-09-12T00:00:00Z", attributes: {} },
      });
      expect(result?.meta.session).toEqual({ id: "sample-session", attributes: { isSampled } });
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });
  it("removes credentials and arbitrary URL segments", () => {
    expect(telemetryUrl(`https://intar.dev/api/auth/sso/${secret}?token=${secret}#${secret}`)).toBe("https://intar.dev/api/auth/sso/:id");
    expect(telemetryUrl(`https://${secret}.example/path`)).toBe("external");
  });
  it("drops console records and arbitrary DOM events", () => {
    expect(sanitizeBrowserTelemetry({ type: TransportItemType.LOG, meta: {}, payload: { message: secret, timestamp: "", level: "info" } } as TransportItem)).toBeNull();
    expect(sanitizeBrowserTelemetry({ type: TransportItemType.EVENT, meta: {}, payload: { name: "click", timestamp: "", attributes: { text: secret } } })).toBeNull();
  });
  it("keeps source locations and removes error text, user data, and URL credentials", () => {
    const result = sanitizeBrowserTelemetry({ type: TransportItemType.EXCEPTION,
      meta: { user: { email: secret }, page: { url: `https://intar.dev/runs/${secret}?token=${secret}` } },
      payload: { timestamp: "2026-09-12T00:00:00Z", type: "TypeError", value: secret, context: { request: secret },
        stacktrace: { frames: [{ filename: `https://intar.dev/_astro/app.abc.js?token=${secret}`, function: secret, lineno: 42 }] } },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).toContain('"lineno":42');
    expect(JSON.stringify(result)).toContain("app.abc.js");
  });
  it("keeps request timings and trace IDs while dropping headers, events and error messages", () => {
    const result = sanitizeBrowserTelemetry({ type: TransportItemType.TRACE, meta: {}, payload: {
      resourceSpans: [{ resource: { attributes: [{ key: "url.full", value: { stringValue: secret } }], droppedAttributesCount: 0 }, scopeSpans: [{ spans: [{
        name: secret, traceId: "1234", spanId: "5678", kind: 3, startTimeUnixNano: "1000", endTimeUnixNano: "2000",
        attributes: [{ key: "http.url", value: { stringValue: `https://intar.dev/api/scenarios/${secret}?token=${secret}` } }, { key: "http.request.header.authorization", value: { stringValue: secret } }],
        events: [{ name: secret, timeUnixNano: "1", attributes: [], droppedAttributesCount: 0 }], links: [],
        droppedAttributesCount: 0, droppedEventsCount: 0, droppedLinksCount: 0, status: { code: 2, message: secret },
      }] }] }],
    } });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).toContain('"traceId":"1234"');
    expect(JSON.stringify(result)).toContain('"endTimeUnixNano":"2000"');
  });
});
