// Pure view logic for the fleet page: which hosts the list shows and how the
// summary counts them.
//
// Selection keys are snapshot indices, because the payload carries no host
// identity. This module therefore answers with indices, not host objects, so a
// filtered list keeps the index of the host it selected.

import type { HostProvider } from "@/db/schema/shared";
import { HOST_PROVIDERS } from "@/lib/host-provider";
import type { HostHealth } from "@/lib/host-health";
import { formatLocation } from "./format";
import type { FleetMapHost } from "./types";

export interface FleetHostFilter {
  /** Free text, matched against the place name of a host. */
  search: string;
  status: HostHealth | null;
  provider: HostProvider | null;
}

export const EMPTY_FLEET_HOST_FILTER: FleetHostFilter = {
  search: "",
  status: null,
  provider: null,
};

export function isFleetHostFilterActive(filter: FleetHostFilter): boolean {
  return (
    filter.search.trim().length > 0 ||
    filter.status !== null ||
    filter.provider !== null
  );
}

/**
 * The snapshot indices of the hosts that match, in snapshot order. The payload
 * already arrives sorted by place, so the list needs no second sort.
 */
export function filterFleetHostIndices(
  hosts: readonly FleetMapHost[],
  filter: FleetHostFilter,
): number[] {
  const needle = filter.search.trim().toLowerCase();
  const indices: number[] = [];
  hosts.forEach((host, index) => {
    if (filter.status !== null && host.state !== filter.status) return;
    if (filter.provider !== null && host.provider !== filter.provider) return;
    if (needle) {
      const place = formatLocation(host.city, host.country).toLowerCase();
      if (!place.includes(needle)) return;
    }
    indices.push(index);
  });
  return indices;
}

export function countFleetHostStates(
  hosts: readonly FleetMapHost[],
): Record<HostHealth, number> {
  const counts: Record<HostHealth, number> = {
    healthy: 0,
    degraded: 0,
    unknown: 0,
  };
  for (const host of hosts) counts[host.state] += 1;
  return counts;
}

/** Distinct places, not hosts: two hosts in one city count once. */
export function countFleetLocations(hosts: readonly FleetMapHost[]): number {
  return new Set(
    hosts.map((host) => `${host.city ?? ""}\u0000${host.country ?? ""}`),
  ).size;
}

/** The sponsors that appear in the snapshot, in the canonical order. */
export function fleetProvidersPresent(
  hosts: readonly FleetMapHost[],
): HostProvider[] {
  const present = new Set<HostProvider>();
  for (const host of hosts) {
    if (host.provider !== null) present.add(host.provider);
  }
  return HOST_PROVIDERS.filter((provider) => present.has(provider));
}
