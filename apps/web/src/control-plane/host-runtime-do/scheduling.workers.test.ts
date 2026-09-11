/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { beforeEach, describe, expect, it } from "vitest";
import {
  testImageKey,
  seedHost,
  connectHost,
  sendBridge,
  waitForBridgeMessage,
  runNextScheduledAlarm,
  waitForMessageCount,
  waitForHostActualState,
  sleep,
  seedEnabledScenario,
  stateReport,
  env,
  eq,
  drizzle,
  hostActualState,
  hostCpuReservations,
  scenarioRuns,
  user,
  upsertDesiredCachedImage,
  mutateStoredHostDesiredState,
  startScenarioRunForUser,
  resetHostRuntimeTestDatabase,
  betaAdmissionForHostFixture,
} from "./test-fixtures";
import {
  hostResourceReservations,
  runtimeExecutions,
  runtimeVms,
} from "@/db/schema";
import { destroyScenarioRunForUserWithDependencies } from "@/lib/scenario-runs/lifecycle";
import { markRunVmsAbsentInDesiredState } from "@/lib/scenario-runs/start";

/**
 * Seed a live run that belongs to another user on `hostId`, holding the host's
 * memory and worst-case disk budget while leaving CPU far below the boot quota.
 */
async function seedOtherUserActiveReservation(input: {
  hostId: string;
  executionId: string;
  now: number;
  memoryMib: number;
  worstCaseDiskMib: number;
}): Promise<void> {
  const db = drizzle(env.DB);
  await db
    .insert(user)
    .values({
      id: "user-2",
      name: "Other User",
      email: "other-user@example.com",
      emailVerified: true,
      createdAt: new Date(input.now),
      updatedAt: new Date(input.now),
    })
    .onConflictDoNothing();
  await db.insert(runtimeExecutions).values({
    id: input.executionId,
    userId: "user-2",
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
    runtimeVmName: "runtime-web",
    imageKeyJson: {},
    imageSha256: "2".repeat(64),
    cpuMillis: 125,
    memoryMib: input.memoryMib,
    diskMib: input.worstCaseDiskMib,
    createdAt: input.now,
    updatedAt: input.now,
  });
  await db.insert(hostResourceReservations).values({
    executionId: input.executionId,
    hostId: input.hostId,
    cpuMillis: 125,
    memoryMib: input.memoryMib,
    worstCaseDiskMib: input.worstCaseDiskMib,
    state: "pending",
    expiresAt: input.now + 60_000,
    createdAt: input.now,
    updatedAt: input.now,
  });
}

describe("HostRuntimeDO scheduling and capacity", () => {
  beforeEach(resetHostRuntimeTestDatabase);

  it("keeps stale actual-state hosts out of automatic scenario scheduling", async () => {
    const hostId = "host-degraded-scheduling";
    const now = Date.now();
    await seedHost(hostId);
    const { ws } = await connectHost(hostId);
    await seedEnabledScenario(drizzle(env.DB), now);

    sendBridge(
      ws,
      stateReport(hostId, {
        observedAt: now,
        appliedDesiredVersion: 0,
        cachedImages: [
          {
            image_key: testImageKey,
            image_id: "2".repeat(64),
            phase: "ready",
            updated_at_unix_ms: now,
          },
        ],
      }),
    );
    await waitForHostActualState(
      drizzle(env.DB),
      hostId,
      (row) => row.observedAt === now,
    );

    // Health derives from the server-set receipt time, not the
    // agent-reported observation clock; backdate it to simulate a host
    // whose last report landed over 60s ago.
    await drizzle(env.DB)
      .update(hostActualState)
      .set({ updatedAt: now - 60_001 })
      .where(eq(hostActualState.hostId, hostId));

    await expect(
      startScenarioRunForUser({
        scenarioId: "broken-nginx",
        userId: "user-1",
        betaAdmission: await betaAdmissionForHostFixture("user-1"),
      }),
    ).rejects.toMatchObject({ code: "scenario_host_unavailable" });
    ws.close();
  });

  it("returns boot_capacity_pending for a pinned saturated host", async () => {
    const hostId = "host-pinned-saturated";
    const now = Date.now();
    await seedHost(hostId);
    const { stub, ws } = await connectHost(hostId);
    await seedEnabledScenario(drizzle(env.DB), now);
    sendBridge(
      ws,
      stateReport(hostId, {
        observedAt: now,
        appliedDesiredVersion: 0,
        schedulableCpuMillis: 2_000,
        cachedImages: [
          {
            image_key: testImageKey,
            image_id: "2".repeat(64),
            phase: "ready",
            updated_at_unix_ms: now,
          },
        ],
      }),
    );
    await waitForHostActualState(
      drizzle(env.DB),
      hostId,
      (row) => row.observedAt === now,
    );
    const fill = await stub.fetch(
      "http://host-runtime/_internal/cpu-reservations/reserve",
      {
        method: "POST",
        body: JSON.stringify({
          hostId,
          runId: "capacity-fill",
          steadyCpuMillisByVm: [125],
        }),
      },
    );
    expect(fill.status).toBe(201);

    await expect(
      startScenarioRunForUser({
        scenarioId: "broken-nginx",
        userId: "user-1",
        betaAdmission: await betaAdmissionForHostFixture("user-1"),
        hostId,
      }),
    ).rejects.toMatchObject({ code: "boot_capacity_pending" });
    ws.close();
  });

  it("starts a new foreground run while an accepted teardown remains in background", async () => {
    const hostId = "host-overlap-capable";
    const now = Date.now();
    await seedHost(hostId);
    const { ws } = await connectHost(hostId);
    await seedEnabledScenario(drizzle(env.DB), now);
    sendBridge(
      ws,
      stateReport(hostId, {
        observedAt: now,
        appliedDesiredVersion: 0,
        schedulableCpuMillis: 6_000,
        cachedImages: [
          {
            image_key: testImageKey,
            image_id: "2".repeat(64),
            phase: "ready",
            updated_at_unix_ms: now,
          },
        ],
      }),
    );
    await waitForHostActualState(
      drizzle(env.DB),
      hostId,
      (row) => row.observedAt === now,
    );

    const first = await startScenarioRunForUser({
      scenarioId: "broken-nginx",
      userId: "user-1",
      betaAdmission: await betaAdmissionForHostFixture("user-1"),
      hostId,
    });
    const ending = await destroyScenarioRunForUserWithDependencies(
      { runId: first.runId, userId: "user-1" },
      {
        markVmsAbsent: markRunVmsAbsentInDesiredState,
        revokeRoutes: async () => {},
        wakeHostRuntime: async () => {},
      },
    );
    const second = await startScenarioRunForUser({
      scenarioId: "broken-nginx",
      userId: "user-1",
      betaAdmission: await betaAdmissionForHostFixture("user-1"),
      hostId,
    });

    expect(ending.run).toMatchObject({
      id: first.runId,
      activity: "background",
    });
    expect(second.run).toMatchObject({
      id: second.runId,
      activity: "foreground",
    });
    expect(second.runId).not.toBe(first.runId);
    ws.close();
  });

  it("retries the next ranked host when the first CPU reservation is exhausted", async () => {
    const now = Date.now();
    const firstHostId = "host-ranked-first";
    const secondHostId = "host-ranked-second";
    await seedHost(firstHostId);
    await seedHost(secondHostId);
    const first = await connectHost(firstHostId);
    const second = await connectHost(secondHostId);
    await seedEnabledScenario(drizzle(env.DB), now);

    sendBridge(
      second.ws,
      stateReport(secondHostId, {
        observedAt: now,
        appliedDesiredVersion: 0,
        schedulableCpuMillis: 2_000,
        cachedImages: [
          {
            image_key: testImageKey,
            image_id: "2".repeat(64),
            phase: "ready",
            updated_at_unix_ms: now,
          },
        ],
      }),
    );
    sendBridge(
      first.ws,
      stateReport(firstHostId, {
        observedAt: now + 1,
        appliedDesiredVersion: 0,
        schedulableCpuMillis: 2_000,
        cachedImages: [
          {
            image_key: testImageKey,
            image_id: "2".repeat(64),
            phase: "ready",
            updated_at_unix_ms: now,
          },
        ],
      }),
    );
    await Promise.all([
      waitForHostActualState(
        drizzle(env.DB),
        firstHostId,
        (row) => row.observedAt === now + 1,
      ),
      waitForHostActualState(
        drizzle(env.DB),
        secondHostId,
        (row) => row.observedAt === now,
      ),
    ]);

    const fill = await first.stub.fetch(
      "http://host-runtime/_internal/cpu-reservations/reserve",
      {
        method: "POST",
        body: JSON.stringify({
          hostId: firstHostId,
          runId: "first-host-fill",
          steadyCpuMillisByVm: [2_000],
        }),
      },
    );
    expect(fill.status).toBe(201);

    const started = await startScenarioRunForUser({
      scenarioId: "broken-nginx",
      userId: "user-1",
      betaAdmission: await betaAdmissionForHostFixture("user-1"),
    });
    expect(started.run).toMatchObject({
      id: started.runId,
      active: true,
      activity: "foreground",
      replayState: "not_started",
    });
    const [run] = await drizzle(env.DB)
      .select({ hostId: scenarioRuns.hostId })
      .from(scenarioRuns)
      .where(eq(scenarioRuns.runId, started.runId));
    expect(run?.hostId).toBe(secondHostId);
    await destroyScenarioRunForUserWithDependencies(
      { runId: started.runId, userId: "user-1" },
      {
        markVmsAbsent: markRunVmsAbsentInDesiredState,
        revokeRoutes: async () => {},
        wakeHostRuntime: async () => {},
      },
    );
    const [reservationAfterAcceptance] = await drizzle(env.DB)
      .select({ state: hostCpuReservations.state })
      .from(hostCpuReservations)
      .where(eq(hostCpuReservations.runId, started.runId));
    expect(reservationAfterAcceptance?.state).toBe("committed");
    await expect(
      startScenarioRunForUser({
        scenarioId: "broken-nginx",
        userId: "user-1",
        betaAdmission: await betaAdmissionForHostFixture("user-1"),
      }),
    ).rejects.toMatchObject({ code: "boot_capacity_pending" });

    first.ws.close();
    second.ws.close();
  });

  it("selects a fitting host while another user's reservations block saturated candidates", async () => {
    const now = Date.now();
    const reservedHostId = "host-reserved-memory";
    const unrelatedHostId = "host-unrelated-memory";
    const openHostId = "host-open-memory";
    await seedHost(reservedHostId);
    await seedHost(unrelatedHostId);
    await seedHost(openHostId);
    const reserved = await connectHost(reservedHostId);
    const unrelated = await connectHost(unrelatedHostId);
    const open = await connectHost(openHostId);
    await seedEnabledScenario(drizzle(env.DB), now);

    for (const [hostId, ws, observedAt] of [
      [reservedHostId, reserved.ws, now],
      [unrelatedHostId, unrelated.ws, now + 1],
      [openHostId, open.ws, now + 2],
    ] as const) {
      sendBridge(
        ws,
        stateReport(hostId, {
          observedAt,
          appliedDesiredVersion: 0,
          schedulableCpuMillis: 4_000,
          cachedImages: [
            {
              image_key: testImageKey,
              image_id: "2".repeat(64),
              phase: "ready",
              updated_at_unix_ms: now,
            },
          ],
        }),
      );
    }
    await Promise.all([
      waitForHostActualState(drizzle(env.DB), reservedHostId, (row) => row.observedAt === now),
      waitForHostActualState(drizzle(env.DB), unrelatedHostId, (row) => row.observedAt === now + 1),
      waitForHostActualState(drizzle(env.DB), openHostId, (row) => row.observedAt === now + 2),
    ]);

    // Another user's live run consumes the whole memory and worst-case disk
    // budget while leaving the CPU allowance far above the boot quota.
    await seedOtherUserActiveReservation({
      hostId: reservedHostId,
      executionId: "exec-reserved-memory",
      now,
      memoryMib: 4_096,
      worstCaseDiskMib: 80_000,
    });
    await seedOtherUserActiveReservation({
      hostId: unrelatedHostId,
      executionId: "exec-unrelated-memory",
      now,
      memoryMib: 4_096,
      worstCaseDiskMib: 80_000,
    });

    await expect(
      startScenarioRunForUser({
        scenarioId: "broken-nginx",
        userId: "user-1",
        betaAdmission: await betaAdmissionForHostFixture("user-1"),
        hostId: reservedHostId,
      }),
    ).rejects.toMatchObject({ code: "scenario_host_unavailable" });

    const started = await startScenarioRunForUser({
      scenarioId: "broken-nginx",
      userId: "user-1",
      betaAdmission: await betaAdmissionForHostFixture("user-1"),
    });
    const [run] = await drizzle(env.DB)
      .select({ hostId: scenarioRuns.hostId })
      .from(scenarioRuns)
      .where(eq(scenarioRuns.runId, started.runId));
    expect(run?.hostId).toBe(openHostId);

    reserved.ws.close();
    unrelated.ws.close();
    open.ws.close();
  });

  it("re-pushes a lagging desired version from the alarm loop after the dispatch threshold", async () => {
    const hostId = "host-lag-repush";
    await seedHost(hostId);
    const { messages, stub, ws } = await connectHost(hostId);
    await waitForBridgeMessage(
      messages,
      (message) => message.type === "server_hello",
    );

    const db = drizzle(env.DB);
    await mutateStoredHostDesiredState(db, hostId, Date.now(), (draft) => {
      upsertDesiredCachedImage(draft, {
        image_key: testImageKey,
        image_id: "4".repeat(64),
      });
    });

    sendBridge(ws, {
      type: "sync_request",
      protocol_version: 7,
      host_id: hostId,
      reason: "operator_requested",
    });
    await waitForBridgeMessage(
      messages,
      (message) =>
        message.type === "desired_state" && message.desired_state.version === 1,
    );

    sendBridge(
      ws,
      stateReport(hostId, {
        observedAt: Date.now(),
        appliedDesiredVersion: 0,
      }),
    );
    await waitForHostActualState(
      db,
      hostId,
      (row) => row.appliedDesiredVersion === 0,
    );
    await sleep(10_050);

    await runNextScheduledAlarm(stub);
    expect(
      await waitForMessageCount(
        messages,
        (message) =>
          message.type === "desired_state" &&
          message.desired_state.version === 1,
        2,
        2_000,
      ),
    ).toBe(2);
    ws.close();
  }, 15_000);
});
