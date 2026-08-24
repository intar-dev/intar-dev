import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HostHeartbeatMetric,
  hostMetricsGridClassName,
} from "./Hosts";

describe("host capacity metrics", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the host card width before adding more metric columns", () => {
    expect(hostMetricsGridClassName).toContain("grid-cols-1");
    expect(hostMetricsGridClassName).toContain(
      "@2xl/host-card:grid-cols-2",
    );
    expect(hostMetricsGridClassName).toContain(
      "@4xl/host-card:grid-cols-3",
    );
    expect(hostMetricsGridClassName).toContain(
      "@7xl/host-card:grid-cols-5",
    );
    expect(hostMetricsGridClassName).not.toContain("xl:grid-cols-5");
  });

  it("shows a short heartbeat while exposing its full timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T12:02:00.000Z"));

    const markup = renderToStaticMarkup(
      createElement(HostHeartbeatMetric, {
        heartbeatAt: "2026-08-24T12:00:00.000Z",
        detail: "Bridge connected",
      }),
    );

    expect(markup).toContain('dateTime="2026-08-24T12:00:00.000Z"');
    expect(markup).toMatch(/title="Last heartbeat: [^"]+"/);
    expect(markup).toMatch(/aria-label="Last heartbeat: [^"]+"/);
    expect(markup).not.toContain("truncate");
  });
});
