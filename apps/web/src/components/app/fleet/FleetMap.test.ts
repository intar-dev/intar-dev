import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FleetMap } from "./FleetMap";
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
  selectedIndex = null,
  unlocatedHostCount = 0,
  pendingHostCount = 0,
  pendingStalled = false,
  truncatedHostCount = 0,
}: {
  hosts?: FleetMapHost[];
  selectedIndex?: number | null;
  unlocatedHostCount?: number;
  pendingHostCount?: number;
  pendingStalled?: boolean;
  truncatedHostCount?: number;
} = {}) {
  return renderToStaticMarkup(
    createElement(FleetMap, {
      hosts,
      selectedIndex,
      onSelect: () => {},
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
    expect(markup).toContain("Report on time");
    expect(markup).toContain("CPU 64 vCPU");
    expect(markup).toContain("memory 256 GiB");
    expect(markup).toContain("sponsored by Hetzner");
    expect(markup).not.toMatch(/agent-\d/u);
    expect(markup).not.toMatch(/\d+\.\d+\.\d+\.\d+/u);
  });

  it("marks only the selected pin as current", () => {
    const markup = renderMap({
      hosts: [host(), host({ city: "Falkenstein/Vogtl." })],
      selectedIndex: 1,
    });

    expect(markup.match(/aria-current="true"/gu)).toHaveLength(1);
  });

  it("keeps normal operation quiet", () => {
    const markup = renderMap();

    expect(markup).not.toContain("animate-ping");
    expect(markup).not.toContain("animate-pulse");
  });

  it("keeps the hover preview out of the pointer's way", () => {
    const markup = renderMap({
      hosts: [host({ city: "Frankfurt am Main" }), host({ city: "Frankfurt am Main" })],
    });

    // The preview shows one place name on hover. It must never take a click
    // from the pin under it, and it must stay inside the map box.
    expect(markup.match(/pointer-events-none[^"]*max-w-44/gu)).toHaveLength(2);
  });

  it("describes the states as report recency, not as workload health", () => {
    const markup = renderMap();

    expect(markup).toContain("Report on time");
    expect(markup).toContain("Report overdue");
    expect(markup).toContain("No report yet");
    expect(markup).toContain("A report arrived in the last minute.");
    expect(markup).toContain("The newest report is older than one minute.");
    expect(markup).toContain("This host has not reported yet.");
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
