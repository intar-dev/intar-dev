// DTO types for the signed-in fleet map. The payload mirrors GET /api/fleet/map,
// which deliberately carries no host name, no host id, and no IP address.

import type { HostProvider } from "@/db/schema/shared";
import type { HostHealth } from "@/lib/host-health";

export interface FleetMapHost {
  latitude: number;
  longitude: number;
  city: string | null;
  country: string | null;
  state: HostHealth;
  cpuMillis: number | null;
  memoryMib: number | null;
  provider: HostProvider | null;
}

export interface FleetMapSnapshot {
  generatedAt: number;
  hosts: FleetMapHost[];
  /** Agent hosts with no address or no known location. */
  unlocatedHostCount: number;
  /** Agent hosts whose first lookup waits for a later page load. */
  pendingHostCount: number;
  /** Eligible agent hosts beyond the read limit, which the map omits. */
  truncatedHostCount: number;
}
