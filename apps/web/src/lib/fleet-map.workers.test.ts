/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentHosts, hostActualState, hostGeoLocations, user } from "@/db/schema";
import type { HostStateReportV2 } from "@/generated/bridge";
import { FLEET_MAP_HOST_LIMIT, loadFleetMap } from "@/lib/fleet-map";
import {
  GEO_LOOKUP_LIMIT_PER_REQUEST,
  type HostGeoLocation,
} from "@/lib/host-geo";
import { resetD1Database } from "@/test/d1-migrations";

const NOW = 1_762_041_660_000;
const NUREMBERG: HostGeoLocation = {
  latitude: 49.4521,
  longitude: 11.0767,
  city: "Nuremberg",
  country: "Germany",
};
const FALKENSTEIN: HostGeoLocation = {
  latitude: 50.4773,
  longitude: 12.3692,
  city: "Falkenstein/Vogtl.",
  country: "Germany",
};

describe("fleet map snapshot", () => {
  beforeEach(async () => {
    await resetD1Database();
  });

  it("places the agent hosts and hides the builders, the disabled, and the identity", async () => {
    await seedFleet();
    const resolver = vi.fn(async (ip: string) =>
      ip === "198.51.100.10" ? NUREMBERG : FALKENSTEIN,
    );

    const snapshot = await loadFleetMap({ now: NOW, resolver });

    // Falkenstein sorts before Nuremberg, and the disabled agent and the
    // builder never reach the map at all.
    expect(snapshot.hosts).toEqual([
      {
        ...FALKENSTEIN,
        state: "degraded",
        cpuMillis: 32_000,
        memoryMib: 131_072,
        provider: null,
      },
      {
        ...NUREMBERG,
        state: "healthy",
        cpuMillis: 64_000,
        memoryMib: 262_144,
        provider: "hetzner",
      },
    ]);
    expect(snapshot.unlocatedHostCount).toBe(1);
    expect(snapshot.generatedAt).toBe(NOW);
    expect(snapshot.pendingHostCount).toBe(0);
    expect(snapshot.truncatedHostCount).toBe(0);

    const payload = JSON.stringify(snapshot);
    expect(payload).not.toContain("agent-01-gq5kkxas");
    expect(payload).not.toContain("agent-02-fcho1ysq");
    expect(payload).not.toContain("198.51.100.10");
    expect(payload).not.toContain("2001:db8::1");
    expect(payload).not.toContain("203.0.113.9");
  });

  it("keeps the addresses other people host on out of the payload", async () => {
    await seedFleet();
    const resolver = vi.fn(async () => NUREMBERG);

    const snapshot = await loadFleetMap({ now: NOW, resolver });

    expect(snapshot.hosts).toHaveLength(2);
    for (const host of snapshot.hosts) {
      expect(Object.keys(host).sort()).toEqual([
        "city",
        "country",
        "cpuMillis",
        "latitude",
        "longitude",
        "memoryMib",
        "provider",
        "state",
      ]);
    }
  });

  it("reads the cache on the next load", async () => {
    await seedFleet();
    const resolver = vi.fn(async (ip: string) =>
      ip === "198.51.100.10" ? NUREMBERG : FALKENSTEIN,
    );

    await loadFleetMap({ now: NOW, resolver });
    expect(resolver).toHaveBeenCalledTimes(2);

    const second = await loadFleetMap({ now: NOW + 60_000, resolver });

    expect(resolver).toHaveBeenCalledTimes(2);
    expect(second.hosts).toHaveLength(2);

    const rows = await drizzle(env.DB).select().from(hostGeoLocations);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "resolved")).toBe(true);
    expect(
      rows.map((row) => row.ip).sort(),
    ).toEqual(["198.51.100.10", "2001:db8::1"]);
  });

  it("keeps the map up when the service fails, then retries after the short life", async () => {
    await seedFleet();
    const resolver = vi.fn<() => Promise<HostGeoLocation | null>>(async () => {
      throw new Error("ipwho.is is unreachable");
    });

    const failed = await loadFleetMap({ now: NOW, resolver });

    expect(failed.hosts).toEqual([]);
    expect(failed.unlocatedHostCount).toBe(3);
    const rows = await drizzle(env.DB).select().from(hostGeoLocations);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "unresolved")).toBe(true);

    // A fresh refusal is inside the six hour life, so the next page load is
    // quiet. An expired one asks again.
    await loadFleetMap({ now: NOW + 60_000, resolver });
    expect(resolver).toHaveBeenCalledTimes(2);

    const aged = NOW - 7 * 60 * 60 * 1000;
    await drizzle(env.DB)
      .update(hostGeoLocations)
      .set({ resolvedAt: aged })
      .where(eq(hostGeoLocations.ip, "198.51.100.10"));
    await loadFleetMap({ now: NOW, resolver });
    expect(resolver).toHaveBeenCalledTimes(3);
  });

  it("counts a host whose place nobody can resolve", async () => {
    await seedFleet();
    const resolver = vi.fn(async (ip: string) =>
      ip === "198.51.100.10" ? NUREMBERG : null,
    );

    const snapshot = await loadFleetMap({ now: NOW, resolver });

    expect(snapshot.hosts.map((host) => host.city)).toEqual(["Nuremberg"]);
    expect(snapshot.unlocatedHostCount).toBe(2);
  });

  it("reads a cache wider than one D1 parameter list", async () => {
    // D1 allows 100 bound parameters per query. Sixty dual stack hosts send
    // 120 addresses into the cache read, which must not fail the whole map.
    await seedOwner();
    const db = drizzle(env.DB);
    for (let index = 0; index < 60; index += 1) {
      const ipv4 = `198.51.100.${index + 10}`;
      const ipv6 = `2001:db8:${index.toString(16)}::1`;
      await db.insert(agentHosts).values({
        id: `wide-host-${index}`,
        userId: "fleet-owner",
        name: `wide host ${index}`,
        role: "agent",
        createdAt: 1,
        updatedAt: 1,
      });
      await db.insert(hostActualState).values({
        hostId: `wide-host-${index}`,
        appliedDesiredVersion: 1,
        observedAt: NOW,
        reportJson: report({
          ipv4,
          ipv6,
          cpuMillis: 4_000,
          memoryMib: 8_192,
        }),
        createdAt: 1,
        updatedAt: NOW,
      });
      for (const ip of [ipv4, ipv6]) {
        await db.insert(hostGeoLocations).values({
          ip,
          status: "resolved",
          latitude: NUREMBERG.latitude,
          longitude: NUREMBERG.longitude,
          city: NUREMBERG.city,
          country: NUREMBERG.country,
          resolvedAt: NOW,
          updatedAt: NOW,
        });
      }
    }

    const resolver = vi.fn(async () => null);
    const snapshot = await loadFleetMap({ now: NOW, resolver });

    expect(snapshot.hosts).toHaveLength(60);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("keeps the last known place when a refresh fails", async () => {
    await seedOwner();
    const db = drizzle(env.DB);
    const expiredAt = NOW - 31 * 24 * 60 * 60 * 1000;
    await db.insert(agentHosts).values({
      id: "stale-host",
      userId: "fleet-owner",
      name: "stale host",
      role: "agent",
      provider: "hetzner",
      createdAt: 1,
      updatedAt: 1,
    });
    await db.insert(hostActualState).values({
      hostId: "stale-host",
      appliedDesiredVersion: 1,
      observedAt: NOW,
      reportJson: report({
        ipv4: "198.51.100.10",
        ipv6: null,
        cpuMillis: 64_000,
        memoryMib: 262_144,
      }),
      createdAt: 1,
      updatedAt: NOW,
    });
    await db.insert(hostGeoLocations).values({
      ip: "198.51.100.10",
      status: "resolved",
      latitude: NUREMBERG.latitude,
      longitude: NUREMBERG.longitude,
      city: NUREMBERG.city,
      country: NUREMBERG.country,
      resolvedAt: expiredAt,
      updatedAt: expiredAt,
    });

    const resolver = vi.fn(async () => {
      throw new Error("ipwho.is is unreachable");
    });
    const snapshot = await loadFleetMap({ now: NOW, resolver });

    expect(snapshot.hosts).toHaveLength(1);
    expect(snapshot.hosts[0]).toMatchObject({
      city: NUREMBERG.city,
      latitude: NUREMBERG.latitude,
    });
    expect(snapshot.unlocatedHostCount).toBe(0);

    const [row] = await db.select().from(hostGeoLocations);
    expect(row).toMatchObject({
      ip: "198.51.100.10",
      status: "resolved",
      city: NUREMBERG.city,
    });
    // The retry waits one short lifetime instead of hammering the service or
    // dropping the place for six hours.
    expect(row!.resolvedAt).toBe(NOW - (30 * 24 * 60 * 60 * 1000 - 6 * 60 * 60 * 1000));
  });

  it("reports the lookups left for a later load", async () => {
    await seedOwner();
    const db = drizzle(env.DB);
    for (let index = 0; index < 8; index += 1) {
      const ipv4 = `203.0.113.${index + 10}`;
      await db.insert(agentHosts).values({
        id: `crowd-host-${index}`,
        userId: "fleet-owner",
        name: `crowd host ${index}`,
        role: "agent",
        createdAt: 1,
        updatedAt: 1,
      });
      await db.insert(hostActualState).values({
        hostId: `crowd-host-${index}`,
        appliedDesiredVersion: 1,
        observedAt: NOW,
        reportJson: report({
          ipv4,
          ipv6: null,
          cpuMillis: 4_000,
          memoryMib: 8_192,
        }),
        createdAt: 1,
        updatedAt: NOW,
      });
    }

    const resolver = vi.fn(async () => NUREMBERG);
    const first = await loadFleetMap({ now: NOW, resolver });

    expect(first.hosts).toHaveLength(GEO_LOOKUP_LIMIT_PER_REQUEST);
    expect(first.pendingHostCount).toBe(8 - GEO_LOOKUP_LIMIT_PER_REQUEST);
    expect(resolver).toHaveBeenCalledTimes(GEO_LOOKUP_LIMIT_PER_REQUEST);

    const second = await loadFleetMap({ now: NOW + 3_000, resolver });

    expect(second.hosts).toHaveLength(8);
    expect(second.pendingHostCount).toBe(0);
  });

  it("reports hosts beyond the read limit", async () => {
    await seedOwner();
    const db = drizzle(env.DB);
    for (let index = 0; index < FLEET_MAP_HOST_LIMIT + 1; index += 1) {
      await db.insert(agentHosts).values({
        id: `over-host-${index}`,
        userId: "fleet-owner",
        name: `over host ${index}`,
        role: "agent",
        createdAt: 1,
        updatedAt: 1,
      });
    }

    const snapshot = await loadFleetMap({
      now: NOW,
      resolver: vi.fn(async () => NUREMBERG),
    });

    expect(snapshot.hosts).toEqual([]);
    expect(snapshot.truncatedHostCount).toBe(1);
    expect(snapshot.unlocatedHostCount).toBe(FLEET_MAP_HOST_LIMIT);
  });
});

interface SeededHost {
  id: string;
  name: string;
  provider: "hetzner" | "namespace" | "other" | null;
  ipv4: string | null;
  ipv6: string | null;
  cpuMillis: number;
  memoryMib: number;
  reportedAt: number | null;
  disabled?: boolean;
}

async function seedOwner() {
  await drizzle(env.DB).insert(user).values({
    id: "fleet-owner",
    name: "Fleet owner",
    email: "fleet-owner@example.test",
    username: "fleet-owner",
  });
}

async function seedFleet() {
  const db = drizzle(env.DB);
  await seedOwner();

  const hosts: SeededHost[] = [
    {
      id: "agent-a",
      name: "agent-01-gq5kkxas",
      provider: "hetzner",
      ipv4: "198.51.100.10",
      ipv6: null,
      cpuMillis: 64_000,
      memoryMib: 262_144,
      reportedAt: NOW - 10_000,
    },
    {
      id: "agent-b",
      name: "agent-02-fcho1ysq",
      provider: null,
      ipv4: null,
      ipv6: "2001:db8::1",
      cpuMillis: 32_000,
      memoryMib: 131_072,
      reportedAt: NOW - 120_000,
    },
    {
      id: "agent-silent",
      name: "agent-03-silent",
      provider: "other",
      ipv4: null,
      ipv6: null,
      cpuMillis: 8_000,
      memoryMib: 16_384,
      reportedAt: null,
    },
    {
      id: "agent-off",
      name: "agent-04-off",
      provider: "hetzner",
      ipv4: "203.0.113.9",
      ipv6: null,
      cpuMillis: 8_000,
      memoryMib: 16_384,
      reportedAt: NOW - 10_000,
      disabled: true,
    },
  ];

  for (const host of hosts) {
    await db.insert(agentHosts).values({
      id: host.id,
      userId: "fleet-owner",
      name: host.name,
      role: "agent",
      provider: host.provider,
      disabled: host.disabled ?? false,
      createdAt: 1,
      updatedAt: 1,
    });
    if (host.reportedAt === null) continue;
    await db.insert(hostActualState).values({
      hostId: host.id,
      appliedDesiredVersion: 1,
      observedAt: host.reportedAt,
      reportJson: report(host),
      createdAt: 1,
      updatedAt: host.reportedAt,
    });
  }

  await db.insert(agentHosts).values({
    id: "builder-a",
    userId: "fleet-owner",
    name: "builder-01-fcho1ysq",
    role: "builder",
    createdAt: 1,
    updatedAt: 1,
  });
  await db.insert(hostActualState).values({
    hostId: "builder-a",
    appliedDesiredVersion: 1,
    observedAt: NOW,
    reportJson: report({
      ipv4: "203.0.113.40",
      ipv6: null,
      cpuMillis: 4_000,
      memoryMib: 4_096,
    }),
    createdAt: 1,
    updatedAt: NOW,
  });
}

function report(capacity: {
  ipv4: string | null;
  ipv6: string | null;
  cpuMillis: number;
  memoryMib: number;
}): HostStateReportV2 {
  return {
    schema_version: 6,
    host_id: "host",
    observed_at_unix_ms: NOW,
    applied_desired_version: 1,
    capacity: {
      total_cpu_millis: capacity.cpuMillis,
      reserved_cpu_millis: 1_000,
      schedulable_cpu_millis: capacity.cpuMillis - 1_000,
      committed_cpu_millis: 0,
      memory_total_mib: capacity.memoryMib,
      memory_available_mib: capacity.memoryMib - 1_024,
      disk_probe_path: "/",
      disk_total_mib: 102_400,
      disk_available_mib: 92_160,
      load_avg_1m: 0.5,
      load_avg_5m: 0.4,
      load_avg_15m: 0.3,
      primary_ipv4: capacity.ipv4,
      primary_ipv6: capacity.ipv6,
    },
    capabilities: {
      arch: "x86_64",
      cloud_hypervisor_sha256: null,
      supports_kvm: true,
      supports_vsock: true,
      supports_reflink: true,
      supports_nftables: true,
      supports_jailer_v2: true,
      supports_template_backed_launch: true,
      fast_template_store: false,
      supports_hard_cpu_quota: true,
      supports_landlock: true,
      supports_cgroup_v2: true,
    },
    cached_images: [],
    vms: [],
    builds: [],
  };
}
