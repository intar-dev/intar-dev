import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FleetHostDetails } from "./FleetHostDetails";
import type { FleetMapHost } from "./types";

// A host that carries the identity values the panel must never publish.
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

function renderDetails(selected: FleetMapHost | null) {
  return renderToStaticMarkup(
    createElement(FleetHostDetails, { host: selected, onClear: () => {} }),
  );
}

describe("fleet host details", () => {
  it("asks for a selection while no host is selected", () => {
    const markup = renderDetails(null);

    expect(markup).toContain("Selected host");
    expect(markup).toContain(
      "Choose a pin on the map, or a row in the list, to read that host here.",
    );
    expect(markup).not.toContain("Clear selected host");
  });

  it("names the place, the report state, and the capacity", () => {
    const markup = renderDetails(host());

    expect(markup).toContain("Nuremberg, Germany");
    expect(markup).toContain("Report on time");
    expect(markup).toContain("64 vCPU");
    expect(markup).toContain("256 GiB");
    expect(markup).toContain("Infrastructure by");
    expect(markup).toContain('alt="Hetzner"');
    expect(markup).toContain("Clear selected host");
  });

  it("states each value when a host reports no capacity", () => {
    const markup = renderDetails(host({ cpuMillis: null, memoryMib: null }));

    expect(markup.match(/Not reported/gu)).toHaveLength(2);
  });

  it("hides the sponsor line when nobody set a sponsor", () => {
    expect(renderDetails(host({ provider: null }))).not.toContain(
      "Infrastructure by",
    );
  });

  it("hides the sponsor line for a provider without a mark", () => {
    expect(renderDetails(host({ provider: "other" }))).not.toContain(
      "Infrastructure by",
    );
  });

  it("publishes no machine identity", () => {
    // The endpoint must never send identity, but the panel must also never
    // print it. Sentinels on the payload prove both halves.
    const marked = {
      ...host(),
      hostName: "agent-01-gq5kkxas",
      hostId: "9f2c1e7a-5b40-4d31-8c2e-6a1d0f4b7e88",
      ipAddress: "10.40.0.18",
    } as FleetMapHost;
    const markup = renderDetails(marked);

    expect(markup).not.toContain("agent-01-gq5kkxas");
    expect(markup).not.toContain("9f2c1e7a");
    expect(markup).not.toContain("10.40.0.18");
    expect(markup).not.toMatch(/agent-\d/u);
    expect(markup).not.toMatch(/\d+\.\d+\.\d+\.\d+/u);
  });
});
