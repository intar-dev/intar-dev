import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FleetHostList } from "./FleetHostList";
import type { FleetMapHost } from "./types";

function host(overrides: Partial<FleetMapHost> = {}): FleetMapHost {
  return {
    latitude: 49.4521,
    longitude: 11.0767,
    city: "Nuremberg",
    country: "Germany",
    state: "healthy",
    cpuMillis: 64_000,
    memoryMib: 262_144,
    provider: "hetzner",
    ...overrides,
  };
}

describe("fleet host list", () => {
  it("reaches every host that the pins may overlap", () => {
    const markup = renderToStaticMarkup(
      createElement(FleetHostList, {
        hosts: [
          host(),
          host({
            city: "Falkenstein/Vogtl.",
            state: "degraded",
            cpuMillis: 32_000,
            memoryMib: 131_072,
            provider: null,
          }),
        ],
      }),
    );

    expect(markup).toContain("Every placed agent host");
    expect(markup).toContain("Nuremberg, Germany");
    expect(markup).toContain("Falkenstein/Vogtl., Germany");
    expect(markup).toContain("Report out of date");
    expect(markup).toContain("64 vCPU");
    expect(markup).toContain("256 GiB");
    expect(markup).toContain("alt=\"Hetzner\"");
  });

  it("publishes no machine identity", () => {
    const markup = renderToStaticMarkup(
      createElement(FleetHostList, { hosts: [host()] }),
    );

    expect(markup).not.toMatch(/agent-\d/u);
    expect(markup).not.toMatch(/\d+\.\d+\.\d+\.\d+/u);
  });

  it("names a host that reports no capacity once", () => {
    const markup = renderToStaticMarkup(
      createElement(FleetHostList, {
        hosts: [host({ cpuMillis: null, memoryMib: null, provider: null })],
      }),
    );

    expect(markup).toContain("Capacity not reported");
    expect(markup).not.toContain("Not reported");
  });
});
