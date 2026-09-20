/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Behavioural tests for the durable desired-state dispatch outbox.
 *
 * The outbox record is the committed host_desired_state row and the ack is the
 * applied version that the host reports. These tests use the real D1 schema,
 * the real sweep, and the real host runtime durable object. The test client
 * records the wake calls at the HOST_RUNTIME binding so a test can prove which
 * hosts were woken and that the durable object answered.
 */

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentHosts,
  hostActualState,
  hostDesiredState,
  user,
} from "@/db/schema";
import { createEmptyHostDesiredState } from "@/lib/desired-state";
import { HOST_STATE_REPORT_SCHEMA_VERSION } from "@/generated/constants";
import {
  HOST_DESIRED_DISPATCH_SWEEP_LIMIT,
  HOST_DESIRED_DISPATCH_SWEEP_MIN_LAG_MS,
  listHostsWithUndeliveredDesiredState,
  sweepUndeliveredHostDesiredState,
  wakeUndeliveredHostDesiredState,
  type UndeliveredHostRow,
} from "@/lib/host-runtime-dispatch-outbox";
import { resetD1Database } from "@/test/d1-migrations";

const wakeRecorder = vi.hoisted(() => {
  const state = { events: [] as string[] };
  return {
    state,
    reset() {
      // Cleared in place: the mocked module keeps a reference to this array.
      state.events.length = 0;
    },
    wokenHostIds(): string[] {
      return state.events
        .filter((event) => event.startsWith("host-runtime-id:"))
        .map((event) => event.slice("host-runtime-id:".length));
    },
    responses(): string[] {
      return state.events.filter((event) => event.startsWith("host-runtime-response:"));
    },
  };
});

vi.mock("cloudflare:workers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("cloudflare:workers")>();
  const events = wakeRecorder.state.events;

  const facadeEnv = new Proxy(
    actual.env as unknown as Record<string | symbol, unknown>,
    {
      get(target, property) {
        if (property !== "HOST_RUNTIME") {
          return Reflect.get(target, property);
        }
        const namespace = Reflect.get(target, property) as DurableObjectNamespace;
        return new Proxy(namespace as unknown as Record<string | symbol, unknown>, {
          get(namespaceTarget, namespaceProperty) {
            const value = Reflect.get(namespaceTarget, namespaceProperty);
            if (typeof value !== "function") {
              return value;
            }
            return (...args: unknown[]) => {
              const result = (value as (...args: unknown[]) => unknown).apply(
                namespaceTarget,
                args,
              );
              if (namespaceProperty === "idFromName") {
                events.push(`host-runtime-id:${String(args[0])}`);
              } else if (
                namespaceProperty === "get" ||
                namespaceProperty === "getByName"
              ) {
                events.push("host-runtime-stub");
                return recordStubFetch(result as DurableObjectStub);
              }
              return result;
            };
          },
        });
      },
    },
  ) as unknown as typeof actual.env;

  function recordStubFetch(stub: DurableObjectStub): DurableObjectStub {
    return new Proxy(stub as unknown as Record<string | symbol, unknown>, {
      get(stubTarget, stubProperty) {
        const value = Reflect.get(stubTarget, stubProperty);
        if (typeof value !== "function") {
          return value;
        }
        if (stubProperty !== "fetch") {
          return (...args: unknown[]) =>
            (value as (...args: unknown[]) => unknown).apply(stubTarget, args);
        }
        return async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(
            typeof input === "string" || input instanceof URL
              ? String(input)
              : input.url,
          );
          const method =
            init?.method ??
            (typeof input === "object" && "method" in input
              ? input.method
              : "GET");
          events.push(`host-runtime-request:${method}:${url.pathname}`);
          const response = (await (
            value as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
          ).call(stubTarget, input, init)) as Response;
          events.push(`host-runtime-response:${response.status}`);
          return response;
        };
      },
    }) as unknown as DurableObjectStub;
  }

  return { ...actual, env: facadeEnv };
});

const OWNER_USER_ID = "dispatch-owner";

describe("host desired-state dispatch outbox", () => {
  beforeEach(async () => {
    wakeRecorder.reset();
    await resetD1Database();
    await seedOwner();
  });

  it("selects only connected, enabled hosts with a lagging applied version", async () => {
    const now = Date.now();
    await seedHosts([
      { hostId: "lagging-host", desiredVersion: 4, appliedVersion: 2, desiredUpdatedAt: now - 60_000 },
      { hostId: "never-applied-host", desiredVersion: 3, appliedVersion: null, desiredUpdatedAt: now - 50_000 },
      { hostId: "current-host", desiredVersion: 4, appliedVersion: 4, desiredUpdatedAt: now - 60_000 },
      { hostId: "ahead-host", desiredVersion: 2, appliedVersion: 5, desiredUpdatedAt: now - 60_000 },
      { hostId: "recent-host", desiredVersion: 5, appliedVersion: 0, desiredUpdatedAt: now },
      { hostId: "disconnected-host", connected: false, desiredVersion: 5, appliedVersion: 0, desiredUpdatedAt: now - 60_000 },
      { hostId: "disabled-host", disabled: true, desiredVersion: 5, appliedVersion: 0, desiredUpdatedAt: now - 60_000 },
      { hostId: "no-desired-host", withDesiredState: false },
    ]);

    await expect(
      listHostsWithUndeliveredDesiredState({ now }),
    ).resolves.toEqual([
      { host_id: "lagging-host", desired_version: 4, applied_version: 2 },
      { host_id: "never-applied-host", desired_version: 3, applied_version: null },
    ]);
  });

  it("wakes each lagging host one time through the host runtime", async () => {
    const now = Date.now();
    await seedHosts([
      { hostId: "lagging-host", desiredVersion: 4, appliedVersion: 2, desiredUpdatedAt: now - 60_000 },
      { hostId: "never-applied-host", desiredVersion: 3, appliedVersion: null, desiredUpdatedAt: now - 50_000 },
      { hostId: "current-host", desiredVersion: 4, appliedVersion: 4, desiredUpdatedAt: now - 60_000 },
    ]);
    expect(HOST_DESIRED_DISPATCH_SWEEP_LIMIT).toBeGreaterThan(0);

    await expect(sweepUndeliveredHostDesiredState({ now })).resolves.toEqual({
      scanned: 2,
      woken: 2,
    });

    expect(wakeRecorder.wokenHostIds()).toEqual([
      "lagging-host",
      "never-applied-host",
    ]);
    // One real wake per lagging host, and each one answered by the host
    // runtime durable object.
    expect(wakeRecorder.responses()).toEqual([
      "host-runtime-response:202",
      "host-runtime-response:202",
    ]);
    expect(
      wakeRecorder.state.events.filter(
        (event) => event === "host-runtime-request:POST:/_internal/wake",
      ),
    ).toHaveLength(2);

    // The wake is a hint only: the durable record stays until the host
    // reports a matching applied version.
    await expect(sweepUndeliveredHostDesiredState({ now })).resolves.toEqual({
      scanned: 2,
      woken: 2,
    });
  });

  it("does not wake a host that already applied the committed version", async () => {
    const now = Date.now();
    await seedHosts([
      { hostId: "current-host", desiredVersion: 7, appliedVersion: 7, desiredUpdatedAt: now - 60_000 },
      { hostId: "ahead-host", desiredVersion: 7, appliedVersion: 9, desiredUpdatedAt: now - 60_000 },
    ]);

    await expect(sweepUndeliveredHostDesiredState({ now })).resolves.toEqual({
      scanned: 0,
      woken: 0,
    });
    expect(wakeRecorder.state.events).toEqual([]);
  });

  it("keeps the sweep bounded and wakes the oldest gaps first", async () => {
    const now = Date.now();
    await seedHosts([
      { hostId: "gap-oldest-host", desiredVersion: 2, appliedVersion: 0, desiredUpdatedAt: now - 40_000 },
      { hostId: "gap-old-host", desiredVersion: 2, appliedVersion: 0, desiredUpdatedAt: now - 30_000 },
      { hostId: "gap-new-host", desiredVersion: 2, appliedVersion: 0, desiredUpdatedAt: now - 20_000 },
      { hostId: "gap-newest-host", desiredVersion: 2, appliedVersion: 0, desiredUpdatedAt: now - 16_000 },
    ]);

    await expect(
      sweepUndeliveredHostDesiredState({ now, limit: 2 }),
    ).resolves.toEqual({ scanned: 2, woken: 2 });
    expect(wakeRecorder.wokenHostIds()).toEqual([
      "gap-oldest-host",
      "gap-old-host",
    ]);

    await expect(
      sweepUndeliveredHostDesiredState({ now, limit: 2 }),
    ).resolves.toEqual({ scanned: 2, woken: 2 });
    // The sweep is bounded and oldest-first. A host is woken again until it
    // reports the applied version, so the same two oldest gaps stay first.
    expect(wakeRecorder.wokenHostIds()).toEqual([
      "gap-oldest-host",
      "gap-old-host",
      "gap-oldest-host",
      "gap-old-host",
    ]);

    // A larger limit takes the next gaps in the same oldest-first order.
    await expect(
      sweepUndeliveredHostDesiredState({ now, limit: 3 }),
    ).resolves.toEqual({ scanned: 3, woken: 3 });
    expect(wakeRecorder.wokenHostIds().slice(4)).toEqual([
      "gap-oldest-host",
      "gap-old-host",
      "gap-new-host",
    ]);
  });

  it("waits for the minimum lag before it wakes a just-committed version", async () => {
    const now = Date.now();
    await seedHosts([
      {
        hostId: "fresh-host",
        desiredVersion: 1,
        appliedVersion: null,
        desiredUpdatedAt: now - HOST_DESIRED_DISPATCH_SWEEP_MIN_LAG_MS + 1,
      },
    ]);

    await expect(
      listHostsWithUndeliveredDesiredState({ now }),
    ).resolves.toEqual([]);
    await expect(sweepUndeliveredHostDesiredState({ now })).resolves.toEqual({
      scanned: 0,
      woken: 0,
    });

    const lagged: UndeliveredHostRow[] = await listHostsWithUndeliveredDesiredState({
      now: now + 1,
    });
    expect(lagged).toEqual([
      { host_id: "fresh-host", desired_version: 1, applied_version: null },
    ]);
  });

  it("wakes a lagging host through the real durable object", async () => {
    const now = Date.now();
    await seedHosts([
      { hostId: "lagging-host", desiredVersion: 6, appliedVersion: 1, desiredUpdatedAt: now - 60_000 },
    ]);

    await wakeUndeliveredHostDesiredState("lagging-host");

    expect(wakeRecorder.state.events).toEqual([
      "host-runtime-id:lagging-host",
      "host-runtime-stub",
      "host-runtime-request:POST:/_internal/wake",
      "host-runtime-response:202",
    ]);
  });
});

interface HostSeed {
  hostId: string;
  connected?: boolean;
  disabled?: boolean;
  desiredVersion?: number;
  appliedVersion?: number | null;
  desiredUpdatedAt?: number;
  withDesiredState?: boolean;
}

async function seedOwner(): Promise<void> {
  const now = Date.now();
  await drizzle(env.DB).insert(user).values({
    id: OWNER_USER_ID,
    name: "Dispatch owner",
    email: "dispatch-owner@example.test",
    emailVerified: true,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  });
}

async function seedHosts(seeds: HostSeed[]): Promise<void> {
  const now = Date.now();
  const db = drizzle(env.DB);
  for (const seed of seeds) {
    await db.insert(agentHosts).values({
      id: seed.hostId,
      userId: OWNER_USER_ID,
      name: seed.hostId,
      role: "agent",
      scenarioEnabled: true,
      disabled: seed.disabled ?? false,
      connected: seed.connected ?? true,
      createdAt: now,
      updatedAt: now,
    });
    if (seed.withDesiredState !== false) {
      const version = seed.desiredVersion ?? 1;
      await db.insert(hostDesiredState).values({
        hostId: seed.hostId,
        version,
        docJson: {
          ...createEmptyHostDesiredState({ ownerUserId: OWNER_USER_ID, scope: "platform", hostId: seed.hostId, nowUnixMs: now }),
          version,
        },
        createdAt: now,
        updatedAt: seed.desiredUpdatedAt ?? now,
      });
    }
    if (seed.appliedVersion !== null && seed.appliedVersion !== undefined) {
      await db.insert(hostActualState).values({
        hostId: seed.hostId,
        appliedDesiredVersion: seed.appliedVersion,
        observedAt: now,
        reportJson: { relay_connected: true,
          schema_version: HOST_STATE_REPORT_SCHEMA_VERSION,
          host_id: seed.hostId,
          observed_at_unix_ms: now,
          applied_desired_version: seed.appliedVersion,
          capacity: {
            total_cpu_millis: 0,
            reserved_cpu_millis: 0,
            schedulable_cpu_millis: 0,
            committed_cpu_millis: 0,
            memory_total_mib: 0,
            memory_available_mib: 0,
            disk_probe_path: "/var/lib/intar-agent",
            disk_total_mib: 0,
            disk_available_mib: 0,
          },
          capabilities: {},
          cached_images: [],
          vms: [],
          builds: [],
        } as unknown as typeof hostActualState.$inferInsert.reportJson,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
}
