import { beforeEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agentHosts, hostActualState, hostResourceReservations, runtimeExecutions, runtimeVms, user } from "@/db/schema";
import { actualVm, drizzle, env, resetHostRuntimeTestDatabase, seedHost, stateReport, type HostStateReportV2 } from "@/control-plane/host-runtime-do/test-fixtures";
import { loadScenarioCapacity, loadScenarioCapacityPressure } from "./start";

const now = 1_800_000_000_000;
const unknownCapacity = { capacityPressure: null, resourceCapacity: null };

beforeEach(resetHostRuntimeTestDatabase);

async function host(hostId: string, change?: (report: HostStateReportV2) => void) {
  await seedHost(hostId);
  const db = drizzle(env.DB);
  await db.update(user).set({ metalPlacement: "platform" }).where(eq(user.id, "user-1"));
  await db.update(agentHosts).set({ scope: "platform", connected: true, lastHeartbeatAt: now }).where(eq(agentHosts.id, hostId));
  const message = stateReport(hostId, { observedAt: now, appliedDesiredVersion: 0 });
  if (message.type !== "state_report") throw new Error("Expected report");
  change?.(message.report);
  await db.insert(hostActualState).values({
    hostId, appliedDesiredVersion: 0, observedAt: now, reportJson: message.report, updatedAt: now,
  });
}

async function capacity() {
  const result = await loadScenarioCapacity("user-1", now, false);
  expect(await loadScenarioCapacityPressure("user-1", now, false)).toBe(result.capacityPressure);
  return result;
}

it("sums host amounts before calculating pressure", async () => {
  await host("small", report => {
    report.capacity.committed_cpu_millis = 3000;
    report.capacity.memory_available_mib = 2048;
  });
  await host("large", report => {
    report.capacity.total_cpu_millis = 13_000;
    report.capacity.schedulable_cpu_millis = 12_000;
    report.capacity.memory_total_mib = 24_576;
    report.capacity.memory_available_mib = 18_432;
  });
  expect(await capacity()).toEqual({
    capacityPressure: 38,
    resourceCapacity: {
      cpu: { availableMillis: 13_000, totalMillis: 16_000 },
      memory: { availableMib: 20_480, totalMib: 32_768 },
    },
  });
});

it("charges pending and committed reservations without counting reported CPU twice", async () => {
  await host("runner", report => {
    report.capacity.committed_cpu_millis = 1000;
    report.vms = [actualVm("committed", "runtime-web", now)];
  });
  const db = drizzle(env.DB);
  for (const [id, state, expiresAt, cpuMillis, memoryMib] of [
    ["committed", "committed", now - 1, 1500, 1024],
    ["pending", "pending", now + 1, 500, 512],
    ["expired", "pending", now, 4000, 8192],
    ["released", "released", null, 4000, 8192],
  ] as const) {
    await db.insert(runtimeExecutions).values({
      id, userId: "user-1", hostId: "runner", domainKind: "scenario", domainId: id,
      generation: 1, state: "provisioning", createdAt: now, updatedAt: now,
    });
    await db.insert(runtimeVms).values({
      id: `${id}-vm`, executionId: id, vmId: "web", ordinal: 0,
      runtimeVmName: "runtime-web", imageKeyJson: {}, imageSha256: "2".repeat(64),
      cpuMillis, memoryMib, diskMib: 1024, createdAt: now, updatedAt: now,
    });
    await db.insert(hostResourceReservations).values({
      executionId: id, hostId: "runner", cpuMillis, memoryMib, worstCaseDiskMib: 1024,
      state, expiresAt, createdAt: now, updatedAt: now,
    });
  }
  expect(await capacity()).toEqual({
    capacityPressure: 69,
    resourceCapacity: {
      cpu: { availableMillis: 2000, totalMillis: 4000 },
      memory: { availableMib: 2560, totalMib: 8192 },
    },
  });
  await db.update(hostResourceReservations).set({ cpuMillis: 8000, memoryMib: 16_384 }).where(eq(hostResourceReservations.executionId, "pending"));
  expect(await capacity()).toEqual({
    capacityPressure: 100,
    resourceCapacity: {
      cpu: { availableMillis: 0, totalMillis: 4000 },
      memory: { availableMib: 0, totalMib: 8192 },
    },
  });
});

it.each([
  ["CPU", { committed_cpu_millis: 4000 }, 0, 4096],
  ["memory", { memory_available_mib: 0 }, 4000, 0],
  ["disk", { disk_available_mib: 0 }, 4000, 4096],
] as const)("keeps full %s hosts in the totals", async (_, change, cpu, memory) => {
  await host("full", report => Object.assign(report.capacity, change));
  expect(await capacity()).toEqual({
    capacityPressure: 100,
    resourceCapacity: {
      cpu: { availableMillis: cpu, totalMillis: 4000 },
      memory: { availableMib: memory, totalMib: 8192 },
    },
  });
});

it("preserves pressure rounding below full capacity", async () => {
  await host("almost-full", report => { report.capacity.committed_cpu_millis = 3999; });
  expect((await capacity()).capacityPressure).toBe(99);
});

it.each([
  ["connected", 0],
  ["disabled", 1],
  ["scenario_enabled", 0],
  ["role", "builder"],
  ["last_heartbeat_at", now - 100_000],
] as const)("excludes hosts with unavailable %s", async (column, value) => {
  await host("offline");
  await env.DB.prepare(`UPDATE agent_hosts SET ${column} = ? WHERE id = 'offline'`).bind(value).run();
  expect(await capacity()).toEqual(unknownCapacity);
});

it("returns unknown for missing or stale reports", async () => {
  expect(await capacity()).toEqual(unknownCapacity);
  await host("stale");
  await drizzle(env.DB).update(hostActualState).set({ updatedAt: now - 300_000 });
  expect(await capacity()).toEqual(unknownCapacity);
  await drizzle(env.DB).delete(hostActualState);
  expect(await capacity()).toEqual(unknownCapacity);
});

it.each([
  ["$.capacity.memory_total_mib", 0],
  ["$.capacity.disk_total_mib", 0],
  ["$.capacity.schedulable_cpu_millis", -1],
  ["$.capacity.committed_cpu_millis", 4001],
  ["$.capacity.total_cpu_millis", Number.MAX_SAFE_INTEGER + 1],
  ["$.capabilities.supports_hard_cpu_quota", 0],
  ["$.capabilities.supports_raw_chunks_v1", 0],
  ["$.vms", null],
] as const)("excludes invalid %s = %s", async (path, value) => {
  await host("invalid");
  await env.DB.prepare("UPDATE host_actual_state SET report_json = json_set(report_json, ?, json(?)) WHERE host_id = 'invalid'").bind(path, JSON.stringify(value)).run();
  expect(await capacity()).toEqual(unknownCapacity);
  await host("valid");
  expect(await capacity()).toEqual({
    capacityPressure: 50,
    resourceCapacity: {
      cpu: { availableMillis: 4000, totalMillis: 4000 },
      memory: { availableMib: 4096, totalMib: 8192 },
    },
  });
});

it.each([
  ["$.capacity.memory_available_mib", -1, 100, 75],
  ["$.capacity.memory_available_mib", 9000, 20, 20],
  ["$.capacity.memory_available_mib", 1.5, null, null],
  ["$.capacity.memory_available_mib", "4096", 50, 50],
  ["$.capacity.memory_available_mib", null, 100, 75],
  ["$.capacity.disk_available_mib", -1, 100, 60],
  ["$.capacity.disk_available_mib", 100_001, 50, 50],
] as const)("preserves pressure but withholds invalid availability %s = %s", async (path, value, pressure, mixedPressure) => {
  await host("invalid");
  await env.DB.prepare("UPDATE host_actual_state SET report_json = json_set(report_json, ?, json(?)) WHERE host_id = 'invalid'").bind(path, JSON.stringify(value)).run();
  expect(await capacity()).toEqual({ capacityPressure: pressure, resourceCapacity: null });
  await host("valid");
  expect(await capacity()).toEqual({ capacityPressure: mixedPressure, resourceCapacity: null });
});

it("returns unknown when aggregate amounts overflow", async () => {
  for (const id of ["large-a", "large-b"]) {
    await host(id, report => {
      report.capacity.memory_total_mib = Number.MAX_SAFE_INTEGER;
      report.capacity.memory_available_mib = Number.MAX_SAFE_INTEGER;
    });
  }
  expect(await capacity()).toEqual(unknownCapacity);
});
