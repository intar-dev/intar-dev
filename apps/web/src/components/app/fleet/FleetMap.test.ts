import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FleetMap, FleetMapCard } from "./FleetMap";
import type { FleetMapHost } from "./types";

// A host that carries the identity values the map must never publish.
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

function renderMap({
  hosts = [host()],
  unlocatedHostCount = 0,
  pendingHostCount = 0,
  pendingStalled = false,
  truncatedHostCount = 0,
}: {
  hosts?: FleetMapHost[];
  unlocatedHostCount?: number;
  pendingHostCount?: number;
  pendingStalled?: boolean;
  truncatedHostCount?: number;
} = {}) {
  return renderToStaticMarkup(
    createElement(FleetMap, {
      hosts,
      unlocatedHostCount,
      pendingHostCount,
      pendingStalled,
      truncatedHostCount,
    }),
  );
}

describe("fleet map markup", () => {
  it("names every fact on the pin and hides the machine identity", () => {
    const markup = renderMap();

    expect(markup).toContain("Nuremberg, Germany");
    expect(markup).toContain("Healthy");
    expect(markup).toContain("CPU 64 vCPU");
    expect(markup).toContain("memory 256 GiB");
    expect(markup).toContain("sponsored by Hetzner");
    expect(markup).not.toMatch(/agent-\d/u);
    expect(markup).not.toMatch(/\d+\.\d+\.\d+\.\d+/u);
  });

  it("draws the sponsor mark on the card", () => {
    const markup = renderToStaticMarkup(
      createElement(FleetMapCard, { host: host(), placement: "below" }),
    );

    expect(markup).toContain("Infrastructure by");
    expect(markup).toContain("alt=\"Hetzner\"");
    expect(markup).toContain("64 vCPU");
    expect(markup).toContain("256 GiB");
    expect(markup).toContain("Nuremberg, Germany");
  });

  it("omits the sponsor line when nobody set a sponsor", () => {
    const markup = renderToStaticMarkup(
      createElement(FleetMapCard, {
        host: host({ provider: null }),
        placement: "above",
      }),
    );

    expect(markup).not.toContain("Infrastructure by");
  });

  it("hides the sponsor line for a provider without a mark", () => {
    const markup = renderToStaticMarkup(
      createElement(FleetMapCard, {
        host: host({ provider: "other" }),
        placement: "below",
      }),
    );

    expect(markup).not.toContain("Infrastructure by");
  });

  it("states each value when a host reports no capacity", () => {
    const markup = renderToStaticMarkup(
      createElement(FleetMapCard, {
        host: host({ cpuMillis: null, memoryMib: null, provider: null }),
        placement: "below",
      }),
    );

    expect(markup).toContain("Not reported");
  });

  it("names both pin colors in the legend", () => {
    const markup = renderMap();

    expect(markup).toContain("Healthy");
    expect(markup).toContain("Report out of date");
  });

  it("counts the hosts without a location", () => {
    expect(renderMap({ unlocatedHostCount: 2 })).toContain(
      "2 agent hosts have no location yet.",
    );
  });

  it("says when a first lookup is still running", () => {
    expect(renderMap({ pendingHostCount: 1 })).toContain(
      "1 agent host is still being placed.",
    );
  });

  it("says when the follow-up reads stopped", () => {
    expect(renderMap({ pendingHostCount: 2, pendingStalled: true })).toContain(
      "2 agent hosts are still being placed. Reload the page for the rest.",
    );
  });

  it("says when the read limit hides hosts", () => {
    expect(renderMap({ truncatedHostCount: 3 })).toContain(
      "3 agent hosts are beyond the map read limit and are not shown.",
    );
  });

  it("hides the location note when every host is placed", () => {
    const markup = renderMap();

    expect(markup).not.toContain("no location yet");
    expect(markup).not.toContain("still being placed");
    expect(markup).not.toContain("beyond the map read limit");
  });
});
