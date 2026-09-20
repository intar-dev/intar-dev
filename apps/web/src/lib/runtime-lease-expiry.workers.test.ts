/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { beforeEach, expect, it, vi } from "vitest";
import {
  desiredRunningVm, drizzle, env, eq, hostDesiredState,
  mutateStoredHostDesiredState, resetHostRuntimeTestDatabase,
  seedHost, seedRun, upsertDesiredVm,
} from "@/control-plane/host-runtime-do/test-fixtures";
import { hostResourceReservations, runtimeExecutions } from "@/db/schema";
import { expireOverdueRuntimeExecutions } from "./runtime-lease-expiry";
import { loadRunRow, updateRunState } from "./scenario-runs/storage";
import { selectOverdueRunLeases } from "./scenario-run-leases";

const effects = vi.hoisted(() => ({ revokeRoute: vi.fn() }));
vi.mock("@/lib/stargate", async (original) => ({
  ...await original<typeof import("@/lib/stargate")>(),
  deleteStargateRoute: effects.revokeRoute,
}));

const hostId = "lease-host";
const runId = "lease-run";
const now = 1_800_000_000_000;

beforeEach(async () => {
  vi.resetAllMocks();
  effects.revokeRoute.mockResolvedValue(undefined);
  await resetHostRuntimeTestDatabase();
  await seedHost(hostId);
  const db = drizzle(env.DB);
  await seedRun({ db, hostId, runId, now });
  await updateRunState(runId, {
    mutate: (current) => ({
      ...current,
      phase: "teardown_requested",
      vms: current.vms.map((vm) => ({ ...vm, runtimeState: "running", runtimeObservedAt: now - 100 })),
    }),
    deleteRequestedAt: now - 50,
  });
  await db.update(runtimeExecutions).set({ leaseExpiresAt: now }).where(eq(runtimeExecutions.id, runId));
  await db.insert(hostResourceReservations).values({
    executionId: runId, hostId, cpuMillis: 1_000, memoryMib: 512,
    worstCaseDiskMib: 4_096, state: "committed", createdAt: now, updatedAt: now,
  });
  await mutateStoredHostDesiredState(db, hostId, now, (draft) => {
    upsertDesiredVm(draft, {
      ...desiredRunningVm(runId, "runtime-web", now),
      desired_phase: "absent", lease_expires_at_unix_ms: now,
    });
  });
});

it("finalizes an expired desired-absent run without inventing VM absence", async () => {
  const [desired] = await drizzle(env.DB).select().from(hostDesiredState).where(eq(hostDesiredState.hostId, hostId));
  expect(selectOverdueRunLeases(desired!.docJson, now + 1)).toEqual([]);
  const before = await loadRunRow(runId);

  expect(await expireOverdueRuntimeExecutions(hostId, now)).toEqual({
    expiredExecutionIds: [runId], failedExecutionIds: [],
  });
  const after = await loadRunRow(runId);
  expect(after).toMatchObject({ activeKey: null, failedAt: expect.any(Number), state: { phase: "failed" } });
  expect(after?.state.vms).toEqual(before?.state.vms);
  expect(await env.DB.prepare("SELECT state FROM runtime_executions WHERE id = ?").bind(runId).first())
    .toEqual({ state: "archived" });
  expect(await env.DB.prepare("SELECT state FROM host_resource_reservations WHERE execution_id = ?").bind(runId).first())
    .toEqual({ state: "released" });
  expect(await env.DB.prepare("SELECT execution_id FROM active_runtime_slots WHERE execution_id = ?").bind(runId).first())
    .toBeNull();
  expect(effects.revokeRoute).toHaveBeenCalledTimes(3);
});

it("leaves an already archived execution and its run unchanged on retry", async () => {
  await expireOverdueRuntimeExecutions(hostId, now);
  const before = await loadRunRow(runId);
  const execution = await env.DB.prepare("SELECT * FROM runtime_executions WHERE id = ?").bind(runId).first();
  effects.revokeRoute.mockClear();

  expect(await expireOverdueRuntimeExecutions(hostId, now + 1)).toEqual({
    expiredExecutionIds: [], failedExecutionIds: [],
  });
  expect(await loadRunRow(runId)).toEqual(before);
  expect(await env.DB.prepare("SELECT * FROM runtime_executions WHERE id = ?").bind(runId).first()).toEqual(execution);
  expect(effects.revokeRoute).not.toHaveBeenCalled();
});

it("retries route failure before finalizing the run or releasing reservations", async () => {
  effects.revokeRoute.mockRejectedValueOnce(new Error("gateway unavailable"));
  expect(await expireOverdueRuntimeExecutions(hostId, now)).toEqual({
    expiredExecutionIds: [], failedExecutionIds: [runId],
  });
  expect((await loadRunRow(runId))?.state.phase).toBe("teardown_requested");
  expect(await env.DB.prepare("SELECT state FROM host_resource_reservations WHERE execution_id = ?").bind(runId).first())
    .toEqual({ state: "committed" });
  expect(await expireOverdueRuntimeExecutions(hostId, now + 1)).toEqual({
    expiredExecutionIds: [runId], failedExecutionIds: [],
  });
});

it("preserves an existing failure outcome while archiving its execution", async () => {
  await updateRunState(runId, { mutate: (current) => ({ ...current, phase: "failed", phaseDetail: "Original failure" }) });
  const before = await loadRunRow(runId);
  await expireOverdueRuntimeExecutions(hostId, now);
  const after = await loadRunRow(runId);
  expect(after?.state).toEqual(before?.state);
  expect(after?.failedAt).toBe(before?.failedAt);
  expect(after?.activeKey).toBeNull();
});
