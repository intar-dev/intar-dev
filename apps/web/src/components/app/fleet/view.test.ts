import { describe, expect, it } from "vitest";
import {
  EMPTY_FLEET_HOST_FILTER,
  countFleetHostStates,
  countFleetLocations,
  filterFleetHostIndices,
  fleetProvidersPresent,
  isFleetHostFilterActive,
} from "./view";
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

const HOSTS: FleetMapHost[] = [
  host(),
  host({
    city: "Falkenstein",
    country: "Germany",
    state: "degraded",
    provider: "namespace",
  }),
  host({ city: "Hillsboro", country: "United States", state: "unknown", provider: null }),
  host({ city: "Nuremberg", country: "Germany", provider: "namespace" }),
];

describe("fleet host filter", () => {
  it("keeps the snapshot index of every match", () => {
    expect(
      filterFleetHostIndices(HOSTS, {
        ...EMPTY_FLEET_HOST_FILTER,
        status: "degraded",
      }),
    ).toEqual([1]);
  });

  it("matches free text against the whole place name", () => {
    expect(
      filterFleetHostIndices(HOSTS, {
        ...EMPTY_FLEET_HOST_FILTER,
        search: "united",
      }),
    ).toEqual([2]);
  });

  it("matches one sponsor and keeps the snapshot order", () => {
    expect(
      filterFleetHostIndices(HOSTS, {
        ...EMPTY_FLEET_HOST_FILTER,
        provider: "namespace",
      }),
    ).toEqual([1, 3]);
  });

  it("combines the search with a state filter", () => {
    expect(
      filterFleetHostIndices(HOSTS, {
        search: "germany",
        status: "degraded",
        provider: null,
      }),
    ).toEqual([1]);
  });

  it("returns every host when nothing is set", () => {
    expect(filterFleetHostIndices(HOSTS, EMPTY_FLEET_HOST_FILTER)).toEqual([
      0, 1, 2, 3,
    ]);
  });

  it("reports whether it changes the list", () => {
    expect(isFleetHostFilterActive(EMPTY_FLEET_HOST_FILTER)).toBe(false);
    expect(
      isFleetHostFilterActive({ ...EMPTY_FLEET_HOST_FILTER, search: "  " }),
    ).toBe(false);
    expect(
      isFleetHostFilterActive({ ...EMPTY_FLEET_HOST_FILTER, search: " n " }),
    ).toBe(true);
    expect(
      isFleetHostFilterActive({ ...EMPTY_FLEET_HOST_FILTER, status: "unknown" }),
    ).toBe(true);
  });
});

describe("fleet summary counts", () => {
  it("counts each state", () => {
    expect(countFleetHostStates(HOSTS)).toEqual({
      healthy: 2,
      degraded: 1,
      unknown: 1,
    });
  });

  it("counts distinct places, so two hosts in one city count once", () => {
    expect(countFleetLocations(HOSTS)).toBe(3);
  });

  it("lists the sponsors that appear, in the canonical order", () => {
    expect(fleetProvidersPresent(HOSTS)).toEqual(["hetzner", "namespace"]);
  });

  it("has no sponsors for an empty fleet", () => {
    expect(fleetProvidersPresent([])).toEqual([]);
  });
});
