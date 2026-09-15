import { env } from "cloudflare:workers";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { agentHosts, hostActualState } from "@/db/schema";
import { resolveHostLocations, type HostGeoResolver } from "@/lib/host-geo";
import { hostHealth } from "@/lib/host-health";
import type {
  FleetMapHost,
  FleetMapSnapshot,
} from "@/components/app/fleet/types";

/**
 * The fleet map reads the placed agent hosts in one query. The ceiling matches
 * the operator fleet limit: this is a bound against an unexpected account, not
 * a page size. The payload reports what it left out.
 */
export const FLEET_MAP_HOST_LIMIT = 100;

export interface LoadFleetMapOptions {
  now?: number;
  resolver?: HostGeoResolver;
}

export async function loadFleetMap(
  options: LoadFleetMapOptions = {},
): Promise<FleetMapSnapshot> {
  const now = options.now ?? Date.now();
  const db = drizzle(env.DB);
  const scope = and(eq(agentHosts.role, "agent"), eq(agentHosts.disabled, false));

  const rows = await db
    .select({
      id: agentHosts.id,
      provider: agentHosts.provider,
      reportedAt: hostActualState.updatedAt,
      ipv4: capacityField("$.capacity.primary_ipv4"),
      ipv6: capacityField("$.capacity.primary_ipv6"),
      cpuMillis: capacityField("$.capacity.total_cpu_millis"),
      memoryMib: capacityField("$.capacity.memory_total_mib"),
    })
    .from(agentHosts)
    .leftJoin(hostActualState, eq(hostActualState.hostId, agentHosts.id))
    .where(scope)
    .orderBy(asc(agentHosts.id))
    .limit(FLEET_MAP_HOST_LIMIT);
  const [totals] = await db
    .select({ total: count() })
    .from(agentHosts)
    .where(scope);

  const addressesByHost = new Map<string, string[]>();
  const hostAddresses: string[] = [];
  for (const row of rows) {
    const addresses = [readText(row.ipv4), readText(row.ipv6)].filter(
      (address): address is string => address !== null,
    );
    if (!addresses.length) continue;
    addressesByHost.set(row.id, addresses);
    hostAddresses.push(...addresses);
  }

  const resolveOptions = options.resolver ? { now, resolver: options.resolver } : { now };
  const { locations, deferred } = await resolveHostLocations(
    hostAddresses,
    resolveOptions,
  );

  const hosts: FleetMapHost[] = [];
  let unlocatedHostCount = 0;
  let pendingHostCount = 0;
  for (const row of rows) {
    const addresses = addressesByHost.get(row.id) ?? [];
    const location = addresses
      .map((address) => locations.get(address))
      .find((entry) => entry !== undefined);
    if (!location) {
      if (addresses.some((address) => deferred.has(address))) {
        pendingHostCount += 1;
      } else {
        unlocatedHostCount += 1;
      }
      continue;
    }
    hosts.push({
      latitude: location.latitude,
      longitude: location.longitude,
      city: location.city,
      country: location.country,
      state: hostHealth(row.reportedAt, now),
      cpuMillis: readNumber(row.cpuMillis),
      memoryMib: readNumber(row.memoryMib),
      provider: row.provider,
    });
  }

  hosts.sort(
    (left, right) =>
      compareText(left.city, right.city) ||
      compareText(left.country, right.country),
  );

  return {
    generatedAt: now,
    hosts,
    unlocatedHostCount,
    pendingHostCount,
    truncatedHostCount: Math.max((totals?.total ?? rows.length) - rows.length, 0),
  };
}

/**
 * Reads one capacity value inside D1. Returning the whole report JSON would
 * transfer and parse megabytes of VM inventory for four numbers.
 */
function capacityField(path: string) {
  return sql<string | number | null>`case
    when ${hostActualState.reportJson} is null then null
    when json_valid(${hostActualState.reportJson}) = 0 then null
    else json_extract(${hostActualState.reportJson}, ${path})
  end`;
}

function readText(value: string | number | null): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(value: string | number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function compareText(left: string | null, right: string | null): number {
  const leftText = left ?? "";
  const rightText = right ?? "";
  if (leftText === rightText) return 0;
  return leftText < rightText ? -1 : 1;
}
