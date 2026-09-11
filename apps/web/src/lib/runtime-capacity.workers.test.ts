/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { beforeEach, describe, expect, it } from "vitest";
import {
  hostResourceReservations,
  runtimeExecutions,
  runtimeVms,
} from "@/db/schema";
import {
  availableRuntimeHostResources,
  loadActiveRuntimeResourceSnapshot,
  runtimeResourcesFit,
} from "@/lib/runtime-capacity";
import {
  drizzle,
  env,
  resetHostRuntimeTestDatabase,
  seedHost,
  stateReport,
  type HostStateReportV2,
} from "@/control-plane/host-runtime-do/test-fixtures";

/** Host state report fixture with an explicit schedulable CPU allowance. */
function hostReport(hostId: string, now: number, schedulableCpuMillis: number): HostStateReportV2 {
  const message = stateReport(hostId, {
    observedAt: now,
    appliedDesiredVersion: 0,
    schedulableCpuMillis,
  });
  if (message.type !== "state_report") {
    throw new Error("state report fixture is not a state report");
  }
  return message.report;
}

/**
 * Seed one host's reservation ledger entry together with the execution and VM
 * rows the reserved-VM query joins on. A committed row stays charged after its
 * expiry, which is how teardown keeps holding capacity until it is observed.
 */
async function seedReservation(input: {
  hostId: string;
  executionId: string;
  state: "pending" | "committed";
  expiresAt: number | null;
  now: number;
  cpuMillis?: number;
  memoryMib?: number;
  worstCaseDiskMib?: number;
  runtimeVmName?: string;
}): Promise<void> {
  const db = drizzle(env.DB);
  const cpuMillis = input.cpuMillis ?? 125;
  const memoryMib = input.memoryMib ?? 512;
  const worstCaseDiskMib = input.worstCaseDiskMib ?? 4_096;
  await db.insert(runtimeExecutions).values({
    id: input.executionId,
    userId: "user-1",
    hostId: input.hostId,
    domainKind: "scenario",
    domainId: input.executionId,
    generation: 1,
    state: "provisioning",
    createdAt: input.now,
    updatedAt: input.now,
  });
  await db.insert(runtimeVms).values({
    id: `${input.executionId}-vm`,
    executionId: input.executionId,
    vmId: "vm-1",
    ordinal: 0,
    runtimeVmName: input.runtimeVmName ?? "runtime-web",
    imageKeyJson: {},
    imageSha256: "2".repeat(64),
    cpuMillis,
    memoryMib,
    diskMib: worstCaseDiskMib,
    createdAt: input.now,
    updatedAt: input.now,
  });
  await db.insert(hostResourceReservations).values({
    executionId: input.executionId,
    hostId: input.hostId,
    cpuMillis,
    memoryMib,
    worstCaseDiskMib,
    state: input.state,
    expiresAt: input.expiresAt,
    createdAt: input.now,
    updatedAt: input.now,
  });
}

describe("host-scoped runtime resource snapshot", () => {
  beforeEach(resetHostRuntimeTestDatabase);

  it("returns an empty snapshot for an empty host scope", async () => {
    const now = Date.now();
    await seedHost("host-scope-empty");
    await seedReservation({
      hostId: "host-scope-empty",
      executionId: "exec-scope-empty",
      state: "committed",
      expiresAt: null,
      now,
    });

    await expect(loadActiveRuntimeResourceSnapshot(now, [])).resolves.toEqual({
      reservations: [],
      reservedVms: [],
    });
  });

  it("deduplicates the host scope and excludes every other host", async () => {
    const now = Date.now();
    await seedHost("host-scope-a");
    await seedHost("host-scope-b");
    await seedReservation({
      hostId: "host-scope-a",
      executionId: "exec-scope-a",
      state: "committed",
      expiresAt: null,
      now,
      memoryMib: 1_024,
    });
    await seedReservation({
      hostId: "host-scope-b",
      executionId: "exec-scope-b",
      state: "committed",
      expiresAt: null,
      now,
    });

    const snapshot = await loadActiveRuntimeResourceSnapshot(now, [
      "host-scope-a",
      "host-scope-a",
    ]);

    expect(snapshot.reservations.map((reservation) => reservation.host_id)).toEqual([
      "host-scope-a",
    ]);
    expect(snapshot.reservations.map((reservation) => reservation.execution_id)).toEqual([
      "exec-scope-a",
    ]);
    expect(snapshot.reservations[0]?.memory_mib).toBe(1_024);
    expect(snapshot.reservedVms.map((vm) => vm.execution_id)).toEqual(["exec-scope-a"]);
    expect(snapshot.reservedVms.map((vm) => vm.runtime_vm_name)).toEqual(["runtime-web"]);
  });

  it("loads a host scope larger than the D1 bound-parameter limit", async () => {
    const now = Date.now();
    const hostIds = Array.from({ length: 120 }, (_, index) => `host-scope-${index}`);
    const firstHostId = hostIds[0]!;
    const lastHostId = hostIds.at(-1)!;
    await seedHost(firstHostId);
    await seedHost(lastHostId);
    await seedReservation({
      hostId: firstHostId,
      executionId: "exec-scope-first",
      state: "pending",
      expiresAt: now + 60_000,
      now,
    });
    await seedReservation({
      hostId: lastHostId,
      executionId: "exec-scope-last",
      state: "committed",
      expiresAt: null,
      now,
    });

    const snapshot = await loadActiveRuntimeResourceSnapshot(now, hostIds);

    expect(
      snapshot.reservations.map((reservation) => reservation.execution_id).sort(),
    ).toEqual(["exec-scope-first", "exec-scope-last"]);
    expect(snapshot.reservedVms.map((vm) => vm.execution_id).sort()).toEqual([
      "exec-scope-first",
      "exec-scope-last",
    ]);
  });

  it("keeps committed rows charged while expired pending rows release capacity", async () => {
    const now = Date.now();
    const hostId = "host-scope-expiry";
    await seedHost(hostId);
    await seedReservation({
      hostId,
      executionId: "exec-expired-pending",
      state: "pending",
      expiresAt: now - 1,
      now,
      memoryMib: 2_048,
      worstCaseDiskMib: 32_768,
    });
    await seedReservation({
      hostId,
      executionId: "exec-open-pending",
      state: "pending",
      expiresAt: null,
      now,
      memoryMib: 256,
      worstCaseDiskMib: 1_024,
    });
    await seedReservation({
      hostId,
      executionId: "exec-expired-committed",
      state: "committed",
      expiresAt: now - 1,
      now,
      cpuMillis: 1_000,
      memoryMib: 1_024,
      worstCaseDiskMib: 8_192,
    });

    const snapshot = await loadActiveRuntimeResourceSnapshot(now, [hostId]);

    expect(snapshot.reservations.map((reservation) => reservation.execution_id).sort()).toEqual([
      "exec-expired-committed",
      "exec-open-pending",
    ]);

    const report = hostReport(hostId, now, 4_000);
    const available = availableRuntimeHostResources({ hostId, report, snapshot });
    expect(available).toEqual({
      cpuMillis: 4_000 - 1_000 - 125,
      memoryMib: report.capacity.memory_available_mib - 1_024 - 256,
      worstCaseDiskMib: report.capacity.disk_available_mib - 8_192 - 1_024,
    });
    expect(
      runtimeResourcesFit(
        { cpuMillis: 2_000, memoryMib: 512, worstCaseDiskMib: 4_096 },
        available!,
      ),
    ).toBe(true);
  });

  it("reports a candidate as unfit when its own active reservations consume the boot resources", async () => {
    const now = Date.now();
    const saturatedHostId = "host-scope-saturated";
    const openHostId = "host-scope-open";
    await seedHost(saturatedHostId);
    await seedHost(openHostId);
    await seedReservation({
      hostId: saturatedHostId,
      executionId: "exec-saturated",
      state: "pending",
      expiresAt: now + 60_000,
      now,
      memoryMib: 4_096,
      worstCaseDiskMib: 80_000,
    });

    const snapshot = await loadActiveRuntimeResourceSnapshot(now, [
      saturatedHostId,
      openHostId,
    ]);
    const required = { cpuMillis: 2_000, memoryMib: 512, worstCaseDiskMib: 4_096 };
    const saturated = availableRuntimeHostResources({
      hostId: saturatedHostId,
      report: hostReport(saturatedHostId, now, 4_000),
      snapshot,
    });
    const open = availableRuntimeHostResources({
      hostId: openHostId,
      report: hostReport(openHostId, now, 4_000),
      snapshot,
    });

    // CPU is untouched, so memory and worst-case disk are what reject it.
    expect(saturated).toMatchObject({ cpuMillis: 4_000 - 125, memoryMib: 0 });
    expect(runtimeResourcesFit(required, saturated!)).toBe(false);
    expect(runtimeResourcesFit(required, open!)).toBe(true);
  });
});
