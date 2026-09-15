import { env } from "cloudflare:workers";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { hostGeoLocations } from "@/db/schema";

/** A datacentre address rarely moves, so a resolved row stays valid for long. */
export const GEO_RESOLVED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A failure or a reserved address retries sooner, so a service blip heals. */
export const GEO_UNRESOLVED_TTL_MS = 6 * 60 * 60 * 1000;
/** One page load may reach the upstream service for at most this many IPs. */
export const GEO_LOOKUP_LIMIT_PER_REQUEST = 5;
const GEO_LOOKUP_TIMEOUT_MS = 3_000;
const GEO_ENDPOINT = "https://ipwho.is";
/** D1 allows 100 bound parameters per query, so one read carries fewer. */
const GEO_CACHE_READ_CHUNK = 50;

export interface HostGeoLocation {
  latitude: number;
  longitude: number;
  city: string | null;
  country: string | null;
}

/**
 * Resolves one address. `null` means "no location", and the caller caches that
 * refusal for the shorter lifetime instead of asking again on every page load.
 */
export type HostGeoResolver = (ip: string) => Promise<HostGeoLocation | null>;

export interface ResolveHostLocationsResult {
  /** Every address this load can place, including a stale last known place. */
  locations: Map<string, HostGeoLocation>;
  /** Addresses left for a later load because the lookup budget ran out. */
  deferred: Set<string>;
}

export interface ResolveHostLocationsOptions {
  now?: number;
  resolver?: HostGeoResolver;
}

/**
 * Reads the cached location for each address and fills the gaps from the
 * upstream service. Lookups are bounded and run together, and a failure never
 * fails the caller: a known place stays on the map and simply retries later.
 */
export async function resolveHostLocations(
  ips: readonly string[],
  options: ResolveHostLocationsOptions = {},
): Promise<ResolveHostLocationsResult> {
  const now = options.now ?? Date.now();
  const resolver = options.resolver ?? defaultHostGeoResolver;
  const db = drizzle(env.DB);
  const unique = [...new Set(ips.map((ip) => ip.trim()).filter(Boolean))];
  const locations = new Map<string, HostGeoLocation>();
  if (!unique.length) return { locations, deferred: new Set() };

  const cached = await readCachedLocations(db, unique);
  const expired: string[] = [];
  for (const ip of unique) {
    const entry = cached.get(ip);
    const ttl = entry && entry.location ? GEO_RESOLVED_TTL_MS : GEO_UNRESOLVED_TTL_MS;
    const fresh = entry !== undefined && now - entry.resolvedAt <= ttl;
    if (!fresh && entry?.location) {
      // The place is still the best answer we have. Serve it while the
      // refresh below runs, or until a later load can afford the lookup.
      locations.set(ip, entry.location);
    }
    if (fresh) {
      if (entry?.location) locations.set(ip, entry.location);
      continue;
    }
    expired.push(ip);
  }

  const claimed = expired.slice(0, GEO_LOOKUP_LIMIT_PER_REQUEST);
  const deferred = new Set(
    expired.slice(claimed.length).filter((ip) => !locations.has(ip)),
  );
  if (!claimed.length) return { locations, deferred };

  const settled = await Promise.allSettled(claimed.map((ip) => resolver(ip)));
  const writes: GeoWrite[] = [];
  settled.forEach((result, index) => {
    const ip = claimed[index]!;
    const location = result.status === "fulfilled" ? result.value : null;
    if (location) {
      locations.set(ip, location);
      writes.push({ ...location, ip, status: "resolved", resolvedAt: now });
      return;
    }
    const known = locations.get(ip);
    if (known) {
      // Keep the last known place and retry in one short lifetime, so a
      // transient upstream failure never moves or removes a host.
      writes.push({
        ...known,
        ip,
        status: "resolved",
        resolvedAt: now - (GEO_RESOLVED_TTL_MS - GEO_UNRESOLVED_TTL_MS),
      });
      return;
    }
    writes.push({
      ip,
      status: "unresolved",
      latitude: null,
      longitude: null,
      city: null,
      country: null,
      resolvedAt: now,
    });
  });

  await writeCachedLocations(db, writes);
  return { locations, deferred };
}

interface GeoWrite {
  ip: string;
  status: "resolved" | "unresolved";
  latitude: number | null;
  longitude: number | null;
  city: string | null;
  country: string | null;
  resolvedAt: number;
}

async function readCachedLocations(
  db: ReturnType<typeof drizzle>,
  ips: readonly string[],
) {
  const cached = new Map<
    string,
    { resolvedAt: number; location: HostGeoLocation | null }
  >();
  for (let index = 0; index < ips.length; index += GEO_CACHE_READ_CHUNK) {
    const rows = await db
      .select({
        ip: hostGeoLocations.ip,
        status: hostGeoLocations.status,
        latitude: hostGeoLocations.latitude,
        longitude: hostGeoLocations.longitude,
        city: hostGeoLocations.city,
        country: hostGeoLocations.country,
        resolvedAt: hostGeoLocations.resolvedAt,
      })
      .from(hostGeoLocations)
      .where(
        inArray(
          hostGeoLocations.ip,
          ips.slice(index, index + GEO_CACHE_READ_CHUNK),
        ),
      );
    for (const row of rows) {
      const location: HostGeoLocation | null =
        row.status === "resolved" &&
        row.latitude !== null &&
        row.longitude !== null
          ? {
              latitude: row.latitude,
              longitude: row.longitude,
              city: row.city,
              country: row.country,
            }
          : null;
      cached.set(row.ip, { resolvedAt: row.resolvedAt, location });
    }
  }
  return cached;
}

async function writeCachedLocations(
  db: ReturnType<typeof drizzle>,
  writes: readonly GeoWrite[],
) {
  try {
    for (const write of writes) {
      await db
        .insert(hostGeoLocations)
        .values(write)
        .onConflictDoUpdate({
          target: hostGeoLocations.ip,
          set: {
            status: write.status,
            latitude: write.latitude,
            longitude: write.longitude,
            city: write.city,
            country: write.country,
            resolvedAt: write.resolvedAt,
            updatedAt: Date.now(),
          },
        });
    }
  } catch (error) {
    // A cache write must never fail the map. The next request retries it.
    console.warn(
      JSON.stringify({
        message: "host geo cache write failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/** The free ipwho.is endpoint needs no key and answers with plain JSON. */
export const defaultHostGeoResolver: HostGeoResolver = async (ip) => {
  const response = await fetch(`${GEO_ENDPOINT}/${encodeURIComponent(ip)}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(GEO_LOOKUP_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const body: unknown = await response.json().catch(() => null);
  if (!isRecord(body) || body.success !== true) return null;
  const latitude = boundedCoordinate(body.latitude, 90);
  const longitude = boundedCoordinate(body.longitude, 180);
  if (latitude === null || longitude === null) return null;
  return {
    latitude,
    longitude,
    city: trimmedOrNull(body.city),
    country: trimmedOrNull(body.country),
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedCoordinate(value: unknown, limit: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.abs(value) <= limit ? value : null;
}

function trimmedOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
