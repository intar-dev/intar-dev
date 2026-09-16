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

function renderList({
  hosts,
  indices,
  selectedIndex = null,
}: {
  hosts: FleetMapHost[];
  indices: number[];
  selectedIndex?: number | null;
}) {
  return renderToStaticMarkup(
    createElement(FleetHostList, {
      hosts,
      indices,
      selectedIndex,
      onSelect: () => {},
      emptyMessage: "No host matches these filters.",
    }),
  );
}

describe("fleet host list", () => {
  const twoHosts = [
    host(),
    host({
      city: "Falkenstein/Vogtl.",
      state: "degraded",
      cpuMillis: 32_000,
      memoryMib: 131_072,
      provider: null,
    }),
  ];

  it("reaches every host that the pins may overlap", () => {
    const markup = renderList({ hosts: twoHosts, indices: [0, 1] });

    expect(markup).toContain("Nuremberg, Germany");
    expect(markup).toContain("Falkenstein/Vogtl., Germany");
    expect(markup).toContain("Report overdue");
    expect(markup).toContain("64 vCPU");
    expect(markup).toContain("256 GiB");
    expect(markup).toContain('alt="Hetzner"');
  });

  it("shows only the hosts that the filter matches", () => {
    const markup = renderList({ hosts: twoHosts, indices: [1] });

    expect(markup).toContain("Falkenstein/Vogtl., Germany");
    expect(markup).not.toContain("Nuremberg");
  });

  it("marks the selected row as current", () => {
    const markup = renderList({
      hosts: twoHosts,
      indices: [0, 1],
      selectedIndex: 1,
    });

    expect(markup.match(/aria-current="true"/gu)).toHaveLength(1);
  });

  it("explains an empty result instead of showing a bare list", () => {
    const markup = renderList({ hosts: twoHosts, indices: [] });

    expect(markup).toContain("No host matches these filters.");
    expect(markup).not.toContain("<ul");
  });

  it("publishes no machine identity", () => {
    const markup = renderList({ hosts: [host()], indices: [0] });

    expect(markup).not.toMatch(/agent-\d/u);
    expect(markup).not.toMatch(/\d+\.\d+\.\d+\.\d+/u);
  });

  it("names a host that reports no capacity once", () => {
    const markup = renderList({
      hosts: [host({ cpuMillis: null, memoryMib: null, provider: null })],
      indices: [0],
    });

    expect(markup).toContain("Capacity not reported");
    expect(markup).not.toContain("Not reported");
  });
});
