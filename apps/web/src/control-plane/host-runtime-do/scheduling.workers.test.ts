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
  upsertDesiredCachedImage,
  mutateStoredHostDesiredState,
  startScenarioRunForUser,
  resetHostRuntimeTestDatabase,
} from "./test-fixtures";
import { destroyScenarioRunForUserWithDependencies } from "@/lib/scenario-runs/lifecycle";
import { markRunVmsAbsentInDesiredState } from "@/lib/scenario-runs/start";

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
            image_sha256: "2".repeat(64),
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
            image_sha256: "2".repeat(64),
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
            image_sha256: "2".repeat(64),
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
            image_sha256: "2".repeat(64),
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
            image_sha256: "2".repeat(64),
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
      }),
    ).rejects.toMatchObject({ code: "boot_capacity_pending" });

    first.ws.close();
    second.ws.close();
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
        image_sha256: "4".repeat(64),
      });
    });

    sendBridge(ws, {
      type: "sync_request",
      protocol_version: 6,
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
