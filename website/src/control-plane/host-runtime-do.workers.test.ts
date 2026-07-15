/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentHosts,
  hostActualState,
  hostBenchmarkLeases,
  hostCpuReservations,
  hostDesiredState,
  scenarioRuns,
  user,
  vmScenarioVms,
  vmScenarios,
} from "@/db/schema";
import type {
  BridgeMessageV6,
  DesiredVmV2,
  HostDesiredStateV2,
  HostStateReportV2,
  VmActualStateV2,
  VmPhase,
  VmReportV2,
} from "@/generated/bridge";
import type { ImageKey } from "@/generated/catalog";
import { HOST_STATE_REPORT_SCHEMA_VERSION } from "@/generated/constants";
import { upsertDesiredCachedImage, upsertDesiredVm } from "@/lib/desired-state";
import { mutateStoredHostDesiredState } from "@/lib/desired-state-store";
import {
  RUN_PHASE_ORDER,
  buildInitialRunState,
  recomputeRunState,
  type RunStateDocument,
} from "@/lib/run-state";
import { startScenarioRunForUser } from "@/lib/scenario-runs";
import { resetD1Database } from "@/test/d1-migrations";

describe("HostRuntimeDO workers integration", () => {
  beforeEach(async () => {
    await resetD1Database();
  });

  it("retires durable runtime state and cancels its alarm", async () => {
    const hostId = "host-retired";
    const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName(hostId));
    const wake = await stub.fetch("http://host-runtime/_internal/wake", {
      method: "POST",
      body: JSON.stringify({ hostId }),
    });
    expect(wake.status).toBe(202);

    const retired = await stub.fetch("http://host-runtime/_internal/retire", {
      method: "POST",
      headers: { "x-agent-host-id": hostId },
    });
    expect(retired.status).toBe(200);
    await expect(retired.json()).resolves.toEqual({ ok: true, hostId });

    expect(await runDurableObjectAlarm(stub)).toBe(false);
    const wakeWithoutIdentity = await stub.fetch(
      "http://host-runtime/_internal/wake",
      { method: "POST" },
    );
    expect(wakeWithoutIdentity.status).toBe(409);
  });

  it("dispatches a changed desired state on alarm to the active bridge socket", async () => {
    const hostId = "host-alarm-dispatch";
    await seedHost(hostId);
    const { messages, stub, ws } = await connectHost(hostId);

    expect(
      await waitForBridgeMessage(
        messages,
        (message) => message.type === "server_hello",
      ),
    ).toMatchObject({ type: "server_hello", desired_version: 0 });
    expect(
      await waitForBridgeMessage(
        messages,
        (message) =>
          message.type === "desired_state" &&
          message.desired_state.version === 0,
      ),
    ).toMatchObject({ type: "desired_state" });

    const db = drizzle(env.DB);
    await mutateStoredHostDesiredState(db, hostId, Date.now(), (draft) => {
      upsertDesiredCachedImage(draft, {
        image_key: testImageKey,
        image_sha256: "1".repeat(64),
      });
    });

    await runNextScheduledAlarm(stub);
    const desired = await waitForBridgeMessage(
      messages,
      (message) =>
        message.type === "desired_state" && message.desired_state.version === 1,
    );
    expect(desired).toMatchObject({
      type: "desired_state",
      desired_state: {
        cached_images: [
          {
            image_key: testImageKey,
            image_sha256: "1".repeat(64),
          },
        ],
      },
    });

    ws.close();
  });

  it("dispatches a changed desired state immediately when the host is woken", async () => {
    const hostId = "host-wake-dispatch";
    await seedHost(hostId);
    const { messages, stub, ws } = await connectHost(hostId);

    await waitForBridgeMessage(
      messages,
      (message) => message.type === "server_hello",
    );
    await waitForBridgeMessage(
      messages,
      (message) =>
        message.type === "desired_state" && message.desired_state.version === 0,
    );

    const db = drizzle(env.DB);
    await mutateStoredHostDesiredState(db, hostId, Date.now(), (draft) => {
      upsertDesiredCachedImage(draft, {
        image_key: testImageKey,
        image_sha256: "1".repeat(64),
      });
    });
    expect(
      messages.some(
        (message) =>
          message.type === "desired_state" &&
          message.desired_state.version === 1,
      ),
    ).toBe(false);

    const wake = await stub.fetch("http://host-runtime/_internal/wake", {
      method: "POST",
      body: JSON.stringify({ hostId }),
    });
    expect(wake.status).toBe(202);
    await expect(wake.json()).resolves.toEqual({ ok: true, hostId });

    const desired = await waitForBridgeMessage(
      messages,
      (message) =>
        message.type === "desired_state" && message.desired_state.version === 1,
    );
    expect(desired).toMatchObject({
      type: "desired_state",
      desired_state: {
        cached_images: [
          {
            image_key: testImageKey,
            image_sha256: "1".repeat(64),
          },
        ],
      },
    });

    ws.close();
  });

  it("does not dispatch a desired VM until its first timing record is durable", async () => {
    const hostId = "host-durable-dispatch-timing";
    const runId = "run-durable-dispatch-timing";
    const now = Date.now();
    await seedHost(hostId);
    const { messages, stub, ws } = await connectHost(hostId);
    await waitForBridgeMessage(
      messages,
      (message) => message.type === "server_hello",
    );
    await waitForBridgeMessage(
      messages,
      (message) =>
        message.type === "desired_state" && message.desired_state.version === 0,
    );

    const db = drizzle(env.DB);
    await seedRun({ db, hostId, runId, now });
    const desired = await mutateStoredHostDesiredState(
      db,
      hostId,
      now + 1,
      (draft) => {
        upsertDesiredVm(draft, desiredRunningVm(runId, "runtime-web", now));
      },
    );
    await runInDurableObject(stub, async (instance, state) => {
      vi.spyOn(state.storage, "put").mockRejectedValueOnce(
        new Error("injected dispatch timing persistence failure"),
      );
      const send = vi.fn();
      const socket = {
        send,
        serializeAttachment: vi.fn(),
      } as unknown as WebSocket;
      const runtime = instance as unknown as {
        sendBridgeDesiredState: (
          ws: WebSocket,
          attachment: {
            hostId: string;
            sessionId: string;
            connectedAt: number;
            helloReceived: true;
            bridgeProtocol: "v6";
            lastDesiredVersionSent: number;
            lastDesiredDispatchAtMs: number;
          },
          hostId: string,
          state: HostDesiredStateV2,
        ) => Promise<void>;
      };
      await expect(
        runtime.sendBridgeDesiredState(
          socket,
          {
            hostId,
            sessionId: "v6:test-session",
            connectedAt: now,
            helloReceived: true,
            bridgeProtocol: "v6",
            lastDesiredVersionSent: 0,
            lastDesiredDispatchAtMs: now,
          },
          hostId,
          desired,
        ),
      ).rejects.toThrow("injected dispatch timing persistence failure");
      expect(send).not.toHaveBeenCalled();
    });
    await sleep(50);
    expect(
      messages.some(
        (message) =>
          message.type === "desired_state" &&
          message.desired_state.version === 1,
      ),
    ).toBe(false);

    const retry = await stub.fetch("http://host-runtime/_internal/wake", {
      method: "POST",
    });
    expect(retry.status).toBe(202);
    await expect(
      waitForBridgeMessage(
        messages,
        (message) =>
          message.type === "desired_state" &&
          message.desired_state.version === 1,
      ),
    ).resolves.toMatchObject({ type: "desired_state" });

    await mutateStoredHostDesiredState(db, hostId, now + 2, (draft) => {
      upsertDesiredCachedImage(draft, {
        image_key: testImageKey,
        image_sha256: "5".repeat(64),
      });
    });
    const versionTwoWake = await stub.fetch(
      "http://host-runtime/_internal/wake",
      { method: "POST" },
    );
    expect(versionTwoWake.status).toBe(202);
    await waitForBridgeMessage(
      messages,
      (message) =>
        message.type === "desired_state" && message.desired_state.version === 2,
    );
    await runInDurableObject(stub, async (_instance, state) => {
      await expect(
        state.storage.get<{ desiredVersion: number }>(
          `desired-dispatch:${encodeURIComponent(runId)}`,
        ),
      ).resolves.toMatchObject({ desiredVersion: 1 });
    });

    const laterVersionReady = vmReport(
      hostId,
      runId,
      "runtime-web",
      "ready",
      now + 100,
      22_001,
      "10.77.0.2",
    );
    if (laterVersionReady.type !== "vm_report") {
      throw new Error("expected VM report");
    }
    laterVersionReady.report.desired_version = 2;
    sendBridge(ws, laterVersionReady);
    const state = await waitForRunState(
      db,
      runId,
      (candidate) => candidate.vms[0]?.runtimeObservedAt === now + 100,
    );
    expect(state.vms[0]?.terminalPhase).toBe("ready");
    expect(state.vms[0]?.workerDesiredDispatchAt).toBeUndefined();
    expect(state.vms[0]?.workerTerminalProjectionAckAt).toBeUndefined();
    ws.close();
  });

  it("never dispatches a desired version older than the socket has seen", async () => {
    const hostId = "host-monotonic-dispatch";
    await seedHost(hostId);
    const { messages, stub, ws } = await connectHost(hostId);
    await waitForBridgeMessage(
      messages,
      (message) =>
        message.type === "desired_state" && message.desired_state.version === 0,
    );

    const db = drizzle(env.DB);
    const desiredV1 = await mutateStoredHostDesiredState(
      db,
      hostId,
      Date.now(),
      (draft) => {
        upsertDesiredCachedImage(draft, {
          image_key: testImageKey,
          image_sha256: "1".repeat(64),
        });
      },
    );
    await stub.fetch("http://host-runtime/_internal/wake", {
      method: "POST",
      body: JSON.stringify({ hostId }),
    });
    await waitForBridgeMessage(
      messages,
      (message) =>
        message.type === "desired_state" && message.desired_state.version === 1,
    );

    await db
      .update(hostDesiredState)
      .set({
        version: 0,
        docJson: { ...desiredV1, version: 0 },
        updatedAt: Date.now(),
      })
      .where(eq(hostDesiredState.hostId, hostId));
    const desiredCount = messages.filter(
      (message) => message.type === "desired_state",
    ).length;

    const staleWake = await stub.fetch("http://host-runtime/_internal/wake", {
      method: "POST",
      body: JSON.stringify({ hostId }),
    });
    expect(staleWake.status).toBe(202);
    await sleep(20);
    expect(
      messages.filter((message) => message.type === "desired_state"),
    ).toHaveLength(desiredCount);

    ws.close();
  });

  it("keeps VM-report projection free of desired reloads with a durable alarm fallback", async () => {
    const hostId = "host-vm-report-dispatch";
    const runId = "run-vm-report-dispatch";
    const observedAt = Date.now() + 10;
    await seedHost(hostId);
    const { messages, stub, ws } = await connectHost(hostId);
    await waitForBridgeMessage(
      messages,
      (message) => message.type === "server_hello",
    );
    await waitForBridgeMessage(
      messages,
      (message) =>
        message.type === "desired_state" && message.desired_state.version === 0,
    );

    const db = drizzle(env.DB);
    await seedRun({ db, hostId, runId, now: Date.now() });
    await mutateStoredHostDesiredState(db, hostId, Date.now(), (draft) => {
      upsertDesiredCachedImage(draft, {
        image_key: testImageKey,
        image_sha256: "1".repeat(64),
      });
    });
    expect(
      messages.some(
        (message) =>
          message.type === "desired_state" &&
          message.desired_state.version === 1,
      ),
    ).toBe(false);

    sendBridge(
      ws,
      vmReport(
        hostId,
        runId,
        "runtime-web",
        "booting",
        observedAt,
        22_001,
        "10.77.0.2",
      ),
    );

    await waitForRunState(
      db,
      runId,
      (state) => state.vms[0]?.runtimeObservedAt === observedAt,
    );
    await sleep(20);
    expect(
      messages.some(
        (message) =>
          message.type === "desired_state" &&
          message.desired_state.version === 1,
      ),
    ).toBe(false);

    await runNextScheduledAlarm(stub);
    await expect(
      waitForBridgeMessage(
        messages,
        (message) =>
          message.type === "desired_state" &&
          message.desired_state.version === 1,
      ),
    ).resolves.toMatchObject({ type: "desired_state" });
    ws.close();
  });

  it("projects a VM report before heartbeat maintenance and records Worker-local timing", async () => {
    const hostId = "host-vm-report-order";
    const runId = "run-vm-report-order";
    const now = Date.now();
    const observedAt = now + 100;
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await seedHost(hostId);
    const { messages, stub, ws } = await connectHost(hostId);
    await waitForBridgeMessage(
      messages,
      (message) => message.type === "server_hello",
    );
    const db = drizzle(env.DB);
    await seedRun({ db, hostId, runId, now });
    await mutateStoredHostDesiredState(db, hostId, now + 1, (draft) => {
      upsertDesiredVm(draft, desiredRunningVm(runId, "runtime-web", now));
    });
    const wake = await stub.fetch("http://host-runtime/_internal/wake", {
      method: "POST",
    });
    expect(wake.status).toBe(202);
    await waitForBridgeMessage(
      messages,
      (message) =>
        message.type === "desired_state" && message.desired_state.version === 1,
    );
    const firstDispatchLatest = Date.now();
    await sleep(20);
    sendBridge(ws, {
      type: "sync_request",
      protocol_version: 6,
      host_id: hostId,
      reason: "operator_requested",
    });
    await expect(
      waitForMessageCount(
        messages,
        (message) =>
          message.type === "desired_state" &&
          message.desired_state.version === 1,
        2,
      ),
    ).resolves.toBe(2);

    await env.DB.prepare(
      `CREATE TABLE vm_report_projection_order (
        host_id TEXT NOT NULL,
        runtime_observed_at INTEGER
      )`,
    ).run();
    await env.DB.prepare(
      `CREATE TRIGGER vm_report_projection_before_heartbeat
       AFTER UPDATE OF last_heartbeat_at ON agent_hosts
       WHEN NEW.id = '${hostId}'
       BEGIN
         INSERT INTO vm_report_projection_order (host_id, runtime_observed_at)
         SELECT NEW.id, json_extract(state_json, '$.vms[0].runtimeObservedAt')
         FROM scenario_runs
         WHERE run_id = '${runId}';
       END`,
    ).run();

    try {
      sendBridge(
        ws,
        vmReport(
          hostId,
          runId,
          "runtime-web",
          "ready",
          observedAt,
          22_001,
          "10.77.0.2",
        ),
      );
      let state = await waitForRunState(
        db,
        runId,
        (state) =>
          state.vms[0]?.runtimeObservedAt === observedAt &&
          state.vms[0]?.workerTerminalProjectionGeneration ===
            "generation-runtime-web" &&
          typeof state.vms[0]?.workerTerminalProjectionAckAt === "number",
      );
      const firstTiming = {
        workerDesiredDispatchAt: state.vms[0]?.workerDesiredDispatchAt,
        workerDesiredDispatchVersion:
          state.vms[0]?.workerDesiredDispatchVersion,
        workerTerminalReportReceivedAt:
          state.vms[0]?.workerTerminalReportReceivedAt,
        workerTerminalProjectionAckAt:
          state.vms[0]?.workerTerminalProjectionAckAt,
        workerTerminalReceiptToProjectionAckMs:
          state.vms[0]?.workerTerminalReceiptToProjectionAckMs,
        workerTerminalProjectionGeneration:
          state.vms[0]?.workerTerminalProjectionGeneration,
        workerTerminalDesiredVersion:
          state.vms[0]?.workerTerminalDesiredVersion,
      };
      expect(firstTiming).toMatchObject({
        workerDesiredDispatchAt: expect.any(Number),
        workerDesiredDispatchVersion: 1,
        workerTerminalReportReceivedAt: expect.any(Number),
        workerTerminalProjectionAckAt: expect.any(Number),
        workerTerminalReceiptToProjectionAckMs: expect.any(Number),
        workerTerminalProjectionGeneration: "generation-runtime-web",
        workerTerminalDesiredVersion: 1,
      });
      expect(
        Number(firstTiming.workerTerminalReportReceivedAt),
      ).toBeGreaterThanOrEqual(Number(firstTiming.workerDesiredDispatchAt));
      expect(Number(firstTiming.workerDesiredDispatchAt)).toBeLessThanOrEqual(
        firstDispatchLatest,
      );
      expect(
        Number(firstTiming.workerTerminalProjectionAckAt),
      ).toBeGreaterThanOrEqual(
        Number(firstTiming.workerTerminalReportReceivedAt),
      );
      expect(
        Number(firstTiming.workerTerminalReceiptToProjectionAckMs),
      ).toBeGreaterThanOrEqual(0);

      const deadline = Date.now() + 1_000;
      let orderRow: { runtime_observed_at: number | null } | null = null;
      while (Date.now() <= deadline) {
        orderRow = await env.DB.prepare(
          `SELECT runtime_observed_at
           FROM vm_report_projection_order
           WHERE host_id = ?
           ORDER BY rowid DESC
           LIMIT 1`,
        )
          .bind(hostId)
          .first<{ runtime_observed_at: number | null }>();
        if (orderRow) {
          break;
        }
        await sleep(10);
      }
      expect(orderRow?.runtime_observed_at).toBe(observedAt);

      const timing = info.mock.calls
        .map(([value]) => {
          if (typeof value !== "string") {
            return null;
          }
          try {
            return JSON.parse(value) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .find(
          (value) =>
            value?.message === "bridge vm report projected" &&
            value.runId === runId,
        );
      expect(timing).toMatchObject({
        hostId,
        runId,
        vmName: "runtime-web",
        generation: "generation-runtime-web",
        observedAtUnixMs: observedAt,
        projectionOutcome: "updated",
      });
      expect(timing?.workerReceivedAtUnixMs).toEqual(expect.any(Number));
      expect(timing?.workerProjectionAckAtUnixMs).toEqual(expect.any(Number));
      expect(timing?.receiptToProjectionAckMs).toEqual(expect.any(Number));
      expect(
        Number(timing?.workerProjectionAckAtUnixMs),
      ).toBeGreaterThanOrEqual(Number(timing?.workerReceivedAtUnixMs));
      expect(Number(timing?.receiptToProjectionAckMs)).toBeGreaterThanOrEqual(
        0,
      );

      await sleep(20);
      sendBridge(ws, {
        type: "sync_request",
        protocol_version: 6,
        host_id: hostId,
        reason: "operator_requested",
      });
      await expect(
        waitForMessageCount(
          messages,
          (message) =>
            message.type === "desired_state" &&
            message.desired_state.version === 1,
          3,
        ),
      ).resolves.toBe(3);
      const repeatedObservedAt = observedAt + 1;
      sendBridge(
        ws,
        vmReport(
          hostId,
          runId,
          "runtime-web",
          "ready",
          repeatedObservedAt,
          22_001,
          "10.77.0.2",
        ),
      );
      state = await waitForRunState(
        db,
        runId,
        (candidate) =>
          candidate.vms[0]?.runtimeObservedAt === repeatedObservedAt,
      );
      expect({
        workerDesiredDispatchAt: state.vms[0]?.workerDesiredDispatchAt,
        workerDesiredDispatchVersion:
          state.vms[0]?.workerDesiredDispatchVersion,
        workerTerminalReportReceivedAt:
          state.vms[0]?.workerTerminalReportReceivedAt,
        workerTerminalProjectionAckAt:
          state.vms[0]?.workerTerminalProjectionAckAt,
        workerTerminalReceiptToProjectionAckMs:
          state.vms[0]?.workerTerminalReceiptToProjectionAckMs,
        workerTerminalProjectionGeneration:
          state.vms[0]?.workerTerminalProjectionGeneration,
        workerTerminalDesiredVersion:
          state.vms[0]?.workerTerminalDesiredVersion,
      }).toEqual(firstTiming);

      const nextGeneration = vmReport(
        hostId,
        runId,
        "runtime-web",
        "booting",
        observedAt + 10,
        22_001,
        "10.77.0.2",
      );
      if (
        nextGeneration.type !== "vm_report" ||
        !nextGeneration.report.runtime_constraints
      ) {
        throw new Error("expected generation-aware VM report");
      }
      nextGeneration.report.runtime_constraints.generation =
        "generation-runtime-web-2";
      sendBridge(ws, nextGeneration);
      state = await waitForRunState(
        db,
        runId,
        (candidate) => candidate.vms[0]?.runtimeObservedAt === observedAt + 10,
      );
      expect(state.vms[0]?.workerDesiredDispatchAt).toBeUndefined();
      expect(state.vms[0]?.workerDesiredDispatchVersion).toBeUndefined();
      expect(state.vms[0]?.workerTerminalProjectionGeneration).toBeUndefined();

      sendBridge(
        ws,
        vmReport(
          hostId,
          runId,
          "runtime-web",
          "ready",
          observedAt + 20,
          22_001,
          "10.77.0.2",
        ),
      );
      await sleep(50);
      const [afterRetiredGeneration] = await db
        .select({ stateJson: scenarioRuns.stateJson })
        .from(scenarioRuns)
        .where(eq(scenarioRuns.runId, runId));
      state = JSON.parse(
        afterRetiredGeneration?.stateJson ?? "{}",
      ) as RunStateDocument;
      expect(state.vms[0]?.runtimeObservedAt).toBe(observedAt + 10);
      expect(state.vms[0]?.workerTerminalProjectionGeneration).toBeUndefined();
    } finally {
      ws.close();
      info.mockRestore();
      await env.DB.prepare(
        "DROP TRIGGER IF EXISTS vm_report_projection_before_heartbeat",
      ).run();
      await env.DB.prepare(
        "DROP TABLE IF EXISTS vm_report_projection_order",
      ).run();
    }
  });

  it("rejects VM reports from a replaced bridge session before projection", async () => {
    const hostId = "host-replaced-vm-report";
    const runId = "run-replaced-vm-report";
    const now = Date.now();
    const fencedHeartbeat = now + 5_000;
    await seedHost(hostId);
    const { messages, ws } = await connectHost(hostId);
    await waitForBridgeMessage(
      messages,
      (message) => message.type === "server_hello",
    );
    const db = drizzle(env.DB);
    await seedRun({ db, hostId, runId, now });
    await db
      .update(agentHosts)
      .set({
        activeSessionId: "v6:replacement-session",
        lastHeartbeatAt: fencedHeartbeat,
        updatedAt: fencedHeartbeat,
      })
      .where(eq(agentHosts.id, hostId));

    sendBridge(
      ws,
      vmReport(
        hostId,
        runId,
        "runtime-web",
        "ready",
        now + 100,
        22_001,
        "10.77.0.2",
      ),
    );
    await sleep(50);

    const [run] = await db
      .select({ stateJson: scenarioRuns.stateJson })
      .from(scenarioRuns)
      .where(eq(scenarioRuns.runId, runId));
    const state = JSON.parse(run?.stateJson ?? "{}") as RunStateDocument;
    expect(state.vms[0]?.runtimeObservedAt).toBeNull();
    const [host] = await db
      .select({ lastHeartbeatAt: agentHosts.lastHeartbeatAt })
      .from(agentHosts)
      .where(eq(agentHosts.id, hostId));
    expect(host?.lastHeartbeatAt).toBe(fencedHeartbeat);
    ws.close();
  });

  it("rejects a VM report when its bridge session is replaced during the projection CAS", async () => {
    const hostId = "host-replaced-during-vm-projection";
    const runId = "run-replaced-during-vm-projection";
    const replacementSessionId = "v6:replacement-during-vm-projection";
    const now = Date.now();
    await seedHost(hostId);
    const { messages, ws } = await connectHost(hostId);
    await waitForBridgeMessage(
      messages,
      (message) => message.type === "server_hello",
    );
    const db = drizzle(env.DB);
    await seedRun({ db, hostId, runId, now });
    const [hostBefore] = await db
      .select({ lastHeartbeatAt: agentHosts.lastHeartbeatAt })
      .from(agentHosts)
      .where(eq(agentHosts.id, hostId));

    await env.DB.prepare(
      `CREATE TRIGGER replace_vm_report_session_before_projection
       BEFORE UPDATE ON scenario_runs
       WHEN OLD.run_id = '${runId}'
       BEGIN
         UPDATE agent_hosts
         SET active_session_id = '${replacementSessionId}'
         WHERE id = '${hostId}';
         SELECT RAISE(IGNORE);
       END`,
    ).run();

    try {
      sendBridge(
        ws,
        vmReport(
          hostId,
          runId,
          "runtime-web",
          "ready",
          now + 100,
          22_001,
          "10.77.0.2",
        ),
      );

      const deadline = Date.now() + 1_000;
      let activeSessionId: string | null | undefined;
      while (Date.now() <= deadline) {
        const [host] = await db
          .select({ activeSessionId: agentHosts.activeSessionId })
          .from(agentHosts)
          .where(eq(agentHosts.id, hostId));
        activeSessionId = host?.activeSessionId;
        if (activeSessionId === replacementSessionId) break;
        await sleep(10);
      }
      expect(activeSessionId).toBe(replacementSessionId);
      await sleep(20);

      const [run] = await db
        .select({ stateJson: scenarioRuns.stateJson })
        .from(scenarioRuns)
        .where(eq(scenarioRuns.runId, runId));
      const state = JSON.parse(run?.stateJson ?? "{}") as RunStateDocument;
      expect(state.vms[0]?.runtimeObservedAt).toBeNull();
      expect(state.vms[0]?.workerTerminalProjectionGeneration).toBeUndefined();

      const [hostAfter] = await db
        .select({ lastHeartbeatAt: agentHosts.lastHeartbeatAt })
        .from(agentHosts)
        .where(eq(agentHosts.id, hostId));
      expect(hostAfter?.lastHeartbeatAt).toBe(hostBefore?.lastHeartbeatAt);
    } finally {
      ws.close();
      await env.DB.prepare(
        "DROP TRIGGER IF EXISTS replace_vm_report_session_before_projection",
      ).run();
    }
  });

  it("rejects a state-report projection when its bridge session is replaced during the run CAS", async () => {
    const hostId = "host-replaced-during-state-projection";
    const runId = "run-replaced-during-state-projection";
    const replacementSessionId = "v6:replacement-during-state-projection";
    const now = Date.now();
    await seedHost(hostId);
    const { messages, ws } = await connectHost(hostId);
    await waitForBridgeMessage(
      messages,
      (message) => message.type === "server_hello",
    );
    const db = drizzle(env.DB);
    await seedRun({ db, hostId, runId, now });

    await env.DB.prepare(
      `CREATE TRIGGER replace_state_report_session_before_projection
       BEFORE UPDATE ON scenario_runs
       WHEN OLD.run_id = '${runId}'
       BEGIN
         UPDATE agent_hosts
         SET active_session_id = '${replacementSessionId}'
         WHERE id = '${hostId}';
         SELECT RAISE(IGNORE);
       END`,
    ).run();

    try {
      sendBridge(
        ws,
        stateReport(hostId, {
          observedAt: now + 100,
          appliedDesiredVersion: 0,
          vms: [actualVm(runId, "runtime-web", now + 100)],
        }),
      );

      const deadline = Date.now() + 1_000;
      let activeSessionId: string | null | undefined;
      while (Date.now() <= deadline) {
        const [host] = await db
          .select({ activeSessionId: agentHosts.activeSessionId })
          .from(agentHosts)
          .where(eq(agentHosts.id, hostId));
        activeSessionId = host?.activeSessionId;
        if (activeSessionId === replacementSessionId) break;
        await sleep(10);
      }
      expect(activeSessionId).toBe(replacementSessionId);
      await sleep(20);

      const [run] = await db
        .select({ stateJson: scenarioRuns.stateJson })
        .from(scenarioRuns)
        .where(eq(scenarioRuns.runId, runId));
      const state = JSON.parse(run?.stateJson ?? "{}") as RunStateDocument;
      expect(state.vms[0]?.runtimeObservedAt).toBeNull();
      expect(state.vms[0]?.runtimeConstraints).toBeNull();
    } finally {
      ws.close();
      await env.DB.prepare(
        "DROP TRIGGER IF EXISTS replace_state_report_session_before_projection",
      ).run();
    }
  });

  it("dispatches desired state only after the CPU reservation commit succeeds", async () => {
    const hostId = "host-commit-dispatch";
    const runId = "run-commit-dispatch";
    const now = Date.now();
    await seedHost(hostId);
    const { messages, stub, ws } = await connectHost(hostId);
    await waitForBridgeMessage(
      messages,
      (message) => message.type === "server_hello",
    );
    await waitForBridgeMessage(
      messages,
      (message) =>
        message.type === "desired_state" && message.desired_state.version === 0,
    );
    sendBridge(
      ws,
      stateReport(hostId, {
        observedAt: now,
        appliedDesiredVersion: 0,
        schedulableCpuMillis: 4_000,
      }),
    );
    const db = drizzle(env.DB);
    await waitForHostActualState(db, hostId, (row) => row.observedAt === now);

    const reserved = await stub.fetch(
      "http://host-runtime/_internal/cpu-reservations/reserve",
      {
        method: "POST",
        body: JSON.stringify({
          hostId,
          runId,
          steadyCpuMillisByVm: [1_000],
        }),
      },
    );
    expect(reserved.status).toBe(201);
    await mutateStoredHostDesiredState(db, hostId, now + 1, (draft) => {
      upsertDesiredCachedImage(draft, {
        image_key: testImageKey,
        image_sha256: "1".repeat(64),
      });
    });

    const committed = await stub.fetch(
      "http://host-runtime/_internal/cpu-reservations/commit",
      {
        method: "POST",
        body: JSON.stringify({ hostId, runId }),
      },
    );
    expect(committed.status).toBe(200);
    await expect(committed.json()).resolves.toEqual({ ok: true });
    await expect(
      waitForBridgeMessage(
        messages,
        (message) =>
          message.type === "desired_state" &&
          message.desired_state.version === 1,
      ),
    ).resolves.toMatchObject({ type: "desired_state" });
    await expect(
      db
        .select({ state: hostCpuReservations.state })
        .from(hostCpuReservations)
        .where(eq(hostCpuReservations.runId, runId)),
    ).resolves.toEqual([{ state: "committed" }]);

    await mutateStoredHostDesiredState(db, hostId, now + 2, (draft) => {
      upsertDesiredCachedImage(draft, {
        image_key: testImageKey,
        image_sha256: "3".repeat(64),
      });
    });
    const missingCommit = await stub.fetch(
      "http://host-runtime/_internal/cpu-reservations/commit",
      {
        method: "POST",
        body: JSON.stringify({ hostId, runId: "missing-reservation" }),
      },
    );
    await expect(missingCommit.json()).resolves.toEqual({ ok: false });
    await sleep(20);
    expect(
      messages.some(
        (message) =>
          message.type === "desired_state" &&
          message.desired_state.version === 2,
      ),
    ).toBe(false);
    ws.close();
  });

  it("dispatches a committed reservation only through the newest bridge session", async () => {
    const hostId = "host-commit-replacement-dispatch";
    const runId = "run-commit-replacement-dispatch";
    const now = Date.now();
    await seedHost(hostId);
    const first = await connectHost(hostId);
    await waitForBridgeMessage(
      first.messages,
      (message) => message.type === "server_hello",
    );
    await sleep(2);
    const replacement = await connectHost(hostId);
    await waitForBridgeMessage(
      replacement.messages,
      (message) => message.type === "server_hello",
    );
    await waitForBridgeMessage(
      replacement.messages,
      (message) =>
        message.type === "desired_state" && message.desired_state.version === 0,
    );

    sendBridge(
      replacement.ws,
      stateReport(hostId, {
        observedAt: now,
        appliedDesiredVersion: 0,
        schedulableCpuMillis: 4_000,
      }),
    );
    const db = drizzle(env.DB);
    await waitForHostActualState(db, hostId, (row) => row.observedAt === now);
    const reserved = await replacement.stub.fetch(
      "http://host-runtime/_internal/cpu-reservations/reserve",
      {
        method: "POST",
        body: JSON.stringify({
          hostId,
          runId,
          steadyCpuMillisByVm: [1_000],
        }),
      },
    );
    expect(reserved.status).toBe(201);
    await mutateStoredHostDesiredState(db, hostId, now + 1, (draft) => {
      upsertDesiredCachedImage(draft, {
        image_key: testImageKey,
        image_sha256: "1".repeat(64),
      });
    });
    expect(
      replacement.messages.some(
        (message) =>
          message.type === "desired_state" &&
          message.desired_state.version === 1,
      ),
    ).toBe(false);

    const committed = await replacement.stub.fetch(
      "http://host-runtime/_internal/cpu-reservations/commit",
      {
        method: "POST",
        body: JSON.stringify({ hostId, runId }),
      },
    );
    await expect(committed.json()).resolves.toEqual({ ok: true });
    await expect(
      waitForBridgeMessage(
        replacement.messages,
        (message) =>
          message.type === "desired_state" &&
          message.desired_state.version === 1,
      ),
    ).resolves.toMatchObject({ type: "desired_state" });
    expect(
      first.messages.some(
        (message) =>
          message.type === "desired_state" &&
          message.desired_state.version === 1,
      ),
    ).toBe(false);

    first.ws.close();
    replacement.ws.close();
  });

  it("expires overdue run leases from a durable-object alarm", async () => {
    const hostId = "host-lease-expiry";
    const runId = "run-expired";
    const runtimeVmName = "runtime-web";
    const now = Date.now();
    await seedHost(hostId);
    const { messages, stub, ws } = await connectHost(hostId);
    await waitForBridgeMessage(
      messages,
      (message) => message.type === "server_hello",
    );

    const db = drizzle(env.DB);
    await seedRun({
      db,
      hostId,
      runId,
      runtimeVmName,
      now,
    });
    await mutateStoredHostDesiredState(db, hostId, now, (draft) => {
      upsertDesiredVm(draft, {
        run_id: runId,
        vm_name: runtimeVmName,
        desired_phase: "running",
        image_key: testImageKey,
        image_sha256: "2".repeat(64),
        resources: {
          cpu_millis: 1_000,
          vcpu_count: 1,
          memory_mib: 512,
          disk_mib: 4096,
        },
        ssh_authorized_keys_openssh: ["ssh-ed25519 AAAATEST user@test"],
        lease_expires_at_unix_ms: now - 1,
      });
    });

    const wake = await stub.fetch("http://host-runtime/_internal/wake", {
      method: "POST",
    });
    expect(wake.status).toBe(202);
    await runNextScheduledAlarm(stub);

    const [run] = await db
      .select()
      .from(scenarioRuns)
      .where(eq(scenarioRuns.runId, runId));
    expect(run?.state).toBe("failed");
    expect(run?.activeKey).toBeNull();
    expect(run?.failedAt).not.toBeNull();
    const state = JSON.parse(run?.stateJson ?? "{}") as RunStateDocument;
    expect(state.phase).toBe("failed");
    expect(state.vms[0]?.phase).toBe("failed");
    expect(state.vms[0]?.terminalReason).toBe("The run lease expired.");

    const [desiredRow] = await db
      .select({ docJson: hostDesiredState.docJson })
      .from(hostDesiredState)
      .where(eq(hostDesiredState.hostId, hostId));
    const desiredVm = desiredRow?.docJson.vms.find(
      (vm) => vm.run_id === runId && vm.vm_name === runtimeVmName,
    );
    expect(desiredVm?.desired_phase).toBe("absent");

    ws.close();
  });

  it("applies interleaved two-vm reports without cross-vm or stale-report regressions", async () => {
    const hostId = "host-two-vm-reports";
    const runId = "run-two-vm";
    const now = Date.now();
    await seedHost(hostId);
    const { ws } = await connectHost(hostId);
    const db = drizzle(env.DB);
    await seedRun({
      db,
      hostId,
      runId,
      now,
      vms: [
        {
          id: "vm-web",
          scenarioVmId: "scenario-vm-web",
          scenarioVmName: "web",
          runtimeVmName: "runtime-web",
          hostname: "web",
        },
        {
          id: "vm-db",
          scenarioVmId: "scenario-vm-db",
          scenarioVmName: "db",
          runtimeVmName: "runtime-db",
          hostname: "db",
        },
      ],
    });

    sendBridge(
      ws,
      vmReport(
        hostId,
        runId,
        "runtime-db",
        "ready",
        now + 100,
        22002,
        "10.77.0.3",
      ),
    );
    sendBridge(
      ws,
      vmReport(
        hostId,
        runId,
        "runtime-web",
        "booting",
        now + 90,
        22001,
        "10.77.0.2",
      ),
    );
    sendBridge(
      ws,
      vmReport(
        hostId,
        runId,
        "runtime-web",
        "ready",
        now + 110,
        22001,
        "10.77.0.2",
      ),
    );
    sendBridge(
      ws,
      vmReport(
        hostId,
        runId,
        "runtime-web",
        "running",
        now + 95,
        22001,
        "10.77.0.2",
      ),
    );
    sendBridge(
      ws,
      vmReport(
        hostId,
        runId,
        "unknown-vm",
        "failed",
        now + 120,
        22999,
        "10.77.0.99",
      ),
    );

    const state = await waitForRunState(db, runId, (state) => {
      const web = state.vms.find((vm) => vm.runtimeVmName === "runtime-web");
      const dbVm = state.vms.find((vm) => vm.runtimeVmName === "runtime-db");
      return (
        web?.runtimeObservedAt === now + 110 &&
        dbVm?.runtimeObservedAt === now + 100
      );
    });
    const web = state.vms.find((vm) => vm.runtimeVmName === "runtime-web");
    const dbVm = state.vms.find((vm) => vm.runtimeVmName === "runtime-db");
    expect(web).toMatchObject({
      phase: "ready",
      runtimeState: "ready",
      runtimeObservedAt: now + 110,
      terminalTarget: { host: "203.0.113.9", port: 22001 },
    });
    expect(dbVm).toMatchObject({
      phase: "ready",
      runtimeState: "ready",
      runtimeObservedAt: now + 100,
      terminalTarget: { host: "203.0.113.9", port: 22002 },
    });

    ws.close();
  });

  it("keeps SSH closed until explicit ready and exact steady quota evidence arrive", async () => {
    const hostId = "host-explicit-terminal-ready";
    const runId = "run-explicit-terminal-ready";
    const now = Date.now();
    await seedHost(hostId);
    const { ws } = await connectHost(hostId);
    const db = drizzle(env.DB);
    await seedRun({ db, hostId, runId, now });

    const legacy = vmReport(
      hostId,
      runId,
      "runtime-web",
      "ready",
      now + 10,
      22_001,
      "10.77.0.2",
    );
    if (legacy.type !== "vm_report") {
      throw new Error("expected vm report");
    }
    legacy.report.terminal = {
      state: "pending",
      observed_at_unix_ms: now + 10,
    };
    legacy.report.phase = "pending";
    delete legacy.report.runtime_constraints;
    sendBridge(ws, legacy);

    let state = await waitForRunState(
      db,
      runId,
      (candidate) => candidate.vms[0]?.runtimeObservedAt === now + 10,
    );
    expect(state.vms[0]).toMatchObject({
      terminalPhase: "pending",
      canOpenTerminal: false,
      terminalTarget: { host: null, port: 22 },
    });

    const unsealed = vmReport(
      hostId,
      runId,
      "runtime-web",
      "ready",
      now + 20,
      22_001,
      "10.77.0.2",
    );
    if (unsealed.type !== "vm_report" || !unsealed.report.runtime_constraints) {
      throw new Error("expected runtime constraints");
    }
    unsealed.report.runtime_constraints = {
      generation: "generation-runtime-web",
      phase: "boot_burst",
      steady_cpu_millis: 1_000,
      effective_cpu_millis: 2_000,
      lease_expires_at_unix_ms: now + 45_000,
    };
    sendBridge(ws, unsealed);

    state = await waitForRunState(
      db,
      runId,
      (candidate) => candidate.vms[0]?.runtimeObservedAt === now + 20,
    );
    expect(state.vms[0]).toMatchObject({
      terminalPhase: "pending",
      canOpenTerminal: false,
      terminalReason: "Waiting for verified steady CPU quota.",
      runtimeConstraints: {
        phase: "boot_burst",
        steadyCpuMillis: 1_000,
        effectiveCpuMillis: 2_000,
      },
    });

    sendBridge(
      ws,
      vmReport(
        hostId,
        runId,
        "runtime-web",
        "ready",
        now + 30,
        22_001,
        "10.77.0.2",
      ),
    );
    state = await waitForRunState(
      db,
      runId,
      (candidate) => candidate.vms[0]?.canOpenTerminal === true,
    );
    expect(state.vms[0]).toMatchObject({
      terminalPhase: "ready",
      canOpenTerminal: true,
      terminalTarget: { host: "203.0.113.9", port: 22_001 },
      runtimeConstraints: {
        phase: "steady",
        steadyCpuMillis: 1_000,
        effectiveCpuMillis: 1_000,
        quotaVerifiedAt: now + 29,
      },
    });

    sendBridge(
      ws,
      vmReport(
        hostId,
        runId,
        "runtime-web",
        "failed",
        now + 25,
        22_001,
        "10.77.0.2",
      ),
    );
    await sleep(30);
    const afterStale = await waitForRunState(
      db,
      runId,
      (candidate) => candidate.vms[0]?.runtimeObservedAt === now + 30,
    );
    expect(afterStale.vms[0]).toMatchObject({
      terminalPhase: "ready",
      canOpenTerminal: true,
      runtimeObservedAt: now + 30,
    });

    ws.close();
  });

  it("re-pushes desired state after reconnect sync and persists applied version catch-up", async () => {
    const hostId = "host-reconnect-sync";
    await seedHost(hostId);
    const first = await connectHost(hostId);
    await waitForBridgeMessage(
      first.messages,
      (message) => message.type === "server_hello",
    );
    first.ws.close();

    const db = drizzle(env.DB);
    await mutateStoredHostDesiredState(db, hostId, Date.now(), (draft) => {
      upsertDesiredCachedImage(draft, {
        image_key: testImageKey,
        image_sha256: "3".repeat(64),
      });
    });

    const { messages, ws } = await connectHost(hostId, {
      lastAppliedDesiredVersion: 0,
    });
    expect(
      await waitForBridgeMessage(
        messages,
        (message) =>
          message.type === "desired_state" &&
          message.desired_state.version === 1,
      ),
    ).toMatchObject({ type: "desired_state" });

    sendBridge(ws, {
      type: "sync_request",
      protocol_version: 6,
      host_id: hostId,
      reason: "reconnect",
    });
    expect(
      await waitForMessageCount(
        messages,
        (message) =>
          message.type === "desired_state" &&
          message.desired_state.version === 1,
        2,
      ),
    ).toBe(2);

    sendBridge(
      ws,
      stateReport(hostId, {
        observedAt: Date.now(),
        appliedDesiredVersion: 1,
        cachedImages: [
          {
            image_key: testImageKey,
            image_sha256: "3".repeat(64),
            phase: "ready",
            updated_at_unix_ms: Date.now(),
          },
        ],
      }),
    );

    await waitForHostActualState(
      db,
      hostId,
      (row) => row.appliedDesiredVersion === 1,
    );
    ws.close();
  });

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

  it("requires benchmark image evidence and lets atomic admission reject an unknown host", async () => {
    const hostId = "host-benchmark-contract";
    const now = Date.now();
    await seedHost(hostId);
    const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName(hostId));
    const missingImages = await stub.fetch(
      "http://host-runtime/_internal/cpu-reservations/benchmark-acquire",
      {
        method: "POST",
        body: JSON.stringify({
          hostId,
          runId: "run-benchmark-contract",
          userId: "user-1",
          steadyCpuMillisByVm: [1_000],
        }),
      },
    );
    expect(missingImages.status).toBe(400);
    await expect(missingImages.json()).resolves.toEqual({
      error:
        "steadyCpuMillisByVm, guestVcpuCountByVm, userId, requiredImages, and the credential window are required",
    });

    const unknownHostId = "host-benchmark-unknown";
    const unknownStub = env.HOST_RUNTIME.get(
      env.HOST_RUNTIME.idFromName(unknownHostId),
    );
    const unknown = await unknownStub.fetch(
      "http://host-runtime/_internal/cpu-reservations/benchmark-acquire",
      {
        method: "POST",
        body: JSON.stringify({
          hostId: unknownHostId,
          runId: "run-benchmark-unknown",
          userId: "user-1",
          steadyCpuMillisByVm: [1_000],
          guestVcpuCountByVm: [1],
          requiredImages: [
            {
              imageKey: testImageKey,
              imageSha256: "2".repeat(64),
            },
          ],
          credentialNotBeforeUnixMs: now - 60_000,
          credentialExpiresAtUnixMs: now + 60_000,
        }),
      },
    );
    expect(unknown.status).toBe(409);
    await expect(unknown.json()).resolves.toMatchObject({
      ok: false,
      reason: "host_not_ready",
    });
  });

  it("admits a pinned benchmark only on a scheduling-disabled, actual-state-drained host", async () => {
    const hostId = "host-isolated-benchmark";
    const now = Date.now();
    await seedHost(hostId);
    const { ws } = await connectHost(hostId);
    await seedEnabledScenario(drizzle(env.DB), now);
    const cachedImages = [
      {
        image_key: testImageKey,
        image_sha256: "2".repeat(64),
        phase: "ready" as const,
        updated_at_unix_ms: now,
      },
    ];

    sendBridge(
      ws,
      stateReport(hostId, {
        observedAt: now,
        appliedDesiredVersion: 0,
        cachedImages,
      }),
    );
    await waitForHostActualState(
      drizzle(env.DB),
      hostId,
      (row) => row.observedAt === now,
    );

    await expect(
      startScenarioRunForUser({
        scenarioId: "broken-nginx",
        userId: "user-1",
        hostId,
        admissionMode: "benchmark",
        benchmarkCredentialWindow: {
          notBeforeUnixMs: now - 60_000,
          expiresAtUnixMs: now + 60_000,
        },
      }),
    ).rejects.toMatchObject({ code: "benchmark_host_not_drained" });

    await drizzle(env.DB)
      .update(agentHosts)
      .set({ scenarioEnabled: false, updatedAt: now + 1 })
      .where(eq(agentHosts.id, hostId));

    await expect(
      startScenarioRunForUser({
        scenarioId: "broken-nginx",
        userId: "user-1",
      }),
    ).rejects.toMatchObject({ code: "scenario_host_unavailable" });
    await expect(
      startScenarioRunForUser({
        scenarioId: "broken-nginx",
        userId: "user-1",
        hostId,
      }),
    ).rejects.toMatchObject({ code: "scenario_host_not_launchable" });

    const benchmarkDesired = await mutateStoredHostDesiredState(
      drizzle(env.DB),
      hostId,
      now + 1,
      (draft) => {
        upsertDesiredCachedImage(draft, {
          image_key: testImageKey,
          image_sha256: "2".repeat(64),
        });
      },
    );

    sendBridge(
      ws,
      stateReport(hostId, {
        observedAt: now + 1,
        appliedDesiredVersion: benchmarkDesired.version,
        cachedImages,
        vms: [actualVm("", "unattributed-vm", now + 1)],
      }),
    );
    await waitForHostActualState(
      drizzle(env.DB),
      hostId,
      (row) => row.observedAt === now + 1,
    );
    await expect(
      startScenarioRunForUser({
        scenarioId: "broken-nginx",
        userId: "user-1",
        hostId,
        admissionMode: "benchmark",
        benchmarkCredentialWindow: {
          notBeforeUnixMs: now - 60_000,
          expiresAtUnixMs: now + 60_000,
        },
      }),
    ).rejects.toMatchObject({ code: "benchmark_host_not_drained" });

    sendBridge(
      ws,
      stateReport(hostId, {
        observedAt: now + 2,
        appliedDesiredVersion: benchmarkDesired.version,
        cachedImages,
      }),
    );
    await waitForHostActualState(
      drizzle(env.DB),
      hostId,
      (row) => row.observedAt === now + 2,
    );
    const started = await startScenarioRunForUser({
      scenarioId: "broken-nginx",
      userId: "user-1",
      hostId,
      admissionMode: "benchmark",
      benchmarkCredentialWindow: {
        notBeforeUnixMs: now - 60_000,
        expiresAtUnixMs: now + 60_000,
      },
    });
    const [run] = await drizzle(env.DB)
      .select({ hostId: scenarioRuns.hostId })
      .from(scenarioRuns)
      .where(eq(scenarioRuns.runId, started.runId));
    expect(run?.hostId).toBe(hostId);
    await expect(
      drizzle(env.DB)
        .select()
        .from(hostBenchmarkLeases)
        .where(eq(hostBenchmarkLeases.hostId, hostId)),
    ).resolves.toEqual([
      expect.objectContaining({
        hostId,
        runId: started.runId,
        userId: "user-1",
      }),
    ]);
    await expect(
      drizzle(env.DB)
        .select()
        .from(hostCpuReservations)
        .where(eq(hostCpuReservations.runId, started.runId)),
    ).resolves.toEqual([
      expect.objectContaining({
        hostId,
        runId: started.runId,
        state: "committed",
        bootCpuMillis: 2_000,
        steadyCpuMillis: 125,
      }),
    ]);
    await expect(
      startScenarioRunForUser({
        scenarioId: "broken-nginx",
        userId: "user-1",
        hostId,
        admissionMode: "benchmark",
        benchmarkCredentialWindow: {
          notBeforeUnixMs: now - 60_000,
          expiresAtUnixMs: now + 60_000,
        },
      }),
    ).rejects.toMatchObject({ code: "benchmark_host_not_drained" });
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
    const [run] = await drizzle(env.DB)
      .select({ hostId: scenarioRuns.hostId })
      .from(scenarioRuns)
      .where(eq(scenarioRuns.runId, started.runId));
    expect(run?.hostId).toBe(secondHostId);

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

const testImageKey = {
  scenario: "broken-nginx",
  vm: "webserver",
  arch: "x86_64",
} satisfies ImageKey;

function desiredRunningVm(
  runId: string,
  vmName: string,
  now: number,
): DesiredVmV2 {
  return {
    run_id: runId,
    vm_name: vmName,
    desired_phase: "running",
    image_key: testImageKey,
    image_sha256: "2".repeat(64),
    resources: {
      cpu_millis: 1_000,
      vcpu_count: 1,
      memory_mib: 512,
      disk_mib: 4_096,
    },
    ssh_authorized_keys_openssh: [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIrunkey user@example",
    ],
    lease_expires_at_unix_ms: now + 60_000,
  };
}

async function seedHost(hostId: string): Promise<void> {
  const db = drizzle(env.DB);
  const now = Date.now();
  await db
    .insert(user)
    .values({
      id: "user-1",
      name: "Test User",
      email: "test@example.com",
      emailVerified: true,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    })
    .onConflictDoNothing();
  await db.insert(agentHosts).values({
    id: hostId,
    userId: "user-1",
    name: hostId,
    role: "agent",
    scenarioEnabled: true,
    disabled: false,
    connected: false,
    createdAt: now,
    updatedAt: now,
  });
}

async function connectHost(
  hostId: string,
  options?: { lastAppliedDesiredVersion?: number | null },
): Promise<{
  messages: BridgeMessageV6[];
  stub: DurableObjectStub;
  ws: WebSocket;
}> {
  const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName(hostId));
  const response = await stub.fetch("http://host-runtime/connect", {
    headers: {
      upgrade: "websocket",
      "x-agent-host-id": hostId,
    },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket;
  expect(ws).not.toBeNull();
  if (!ws) {
    throw new Error("missing websocket");
  }
  const messages: BridgeMessageV6[] = [];
  ws.accept();
  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      messages.push(JSON.parse(event.data) as BridgeMessageV6);
    }
  });
  ws.send(JSON.stringify(clientHello(hostId, options)));
  return { messages, stub, ws };
}

function clientHello(
  hostId: string,
  options?: { lastAppliedDesiredVersion?: number | null },
): Extract<BridgeMessageV6, { type: "client_hello" }> {
  const message: Extract<BridgeMessageV6, { type: "client_hello" }> = {
    type: "client_hello",
    protocol_version: 6,
    host_id: hostId,
    agent_version: "test-agent",
    role: "agent",
    capabilities: {
      arch: "x86_64",
      cloud_hypervisor_sha256:
        "448af3d4e59b22c2987f7df94c213ad40fb53a10d437e42b5ee6c4fce7c29ecc",
      boot_cpu_millis: 2_000,
      boot_cpu_lease_ms: 45_000,
      supports_kvm: true,
      supports_vsock: true,
      supports_reflink: true,
      supports_nftables: true,
      supports_jailer_v1: false,
      supports_jailer_v2: true,
      supports_boot_cpu_lease: true,
      supports_template_backed_launch: true,
      fast_template_store: true,
      supports_hard_cpu_quota: true,
      supports_landlock: true,
      supports_cgroup_v2: true,
    },
  };
  if (options && "lastAppliedDesiredVersion" in options) {
    message.last_applied_desired_version =
      options.lastAppliedDesiredVersion ?? null;
  }
  return message;
}

function sendBridge(ws: WebSocket, message: BridgeMessageV6): void {
  ws.send(JSON.stringify(message));
}

async function waitForBridgeMessage(
  messages: BridgeMessageV6[],
  predicate: (message: BridgeMessageV6) => boolean,
  timeoutMs = 1_000,
): Promise<BridgeMessageV6> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const match = messages.find(predicate);
    if (match) {
      return match;
    }
    await sleep(10);
  }
  throw new Error(
    `timed out waiting for bridge message; got ${JSON.stringify(messages)}`,
  );
}

async function runNextScheduledAlarm(
  stub: DurableObjectStub,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await runDurableObjectAlarm(stub)) {
      return;
    }
    await sleep(10);
  }
  throw new Error("timed out waiting for Durable Object alarm");
}

async function waitForMessageCount(
  messages: BridgeMessageV6[],
  predicate: (message: BridgeMessageV6) => boolean,
  expected: number,
  timeoutMs = 1_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const count = messages.filter(predicate).length;
    if (count >= expected) {
      return count;
    }
    await sleep(10);
  }
  throw new Error(
    `timed out waiting for ${expected} bridge messages; got ${JSON.stringify(messages)}`,
  );
}

async function waitForRunState(
  db: ReturnType<typeof drizzle>,
  runId: string,
  predicate: (state: RunStateDocument) => boolean,
  timeoutMs = 1_000,
): Promise<RunStateDocument> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const [row] = await db
      .select({ stateJson: scenarioRuns.stateJson })
      .from(scenarioRuns)
      .where(eq(scenarioRuns.runId, runId));
    if (row) {
      const state = JSON.parse(row.stateJson) as RunStateDocument;
      if (predicate(state)) {
        return state;
      }
    }
    await sleep(10);
  }
  throw new Error(`timed out waiting for run state ${runId}`);
}

async function waitForHostActualState(
  db: ReturnType<typeof drizzle>,
  hostId: string,
  predicate: (row: typeof hostActualState.$inferSelect) => boolean,
  timeoutMs = 1_000,
): Promise<typeof hostActualState.$inferSelect> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const [row] = await db
      .select()
      .from(hostActualState)
      .where(eq(hostActualState.hostId, hostId));
    if (row && predicate(row)) {
      return row;
    }
    await sleep(10);
  }
  throw new Error(`timed out waiting for actual state ${hostId}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function seedRun(input: {
  db: ReturnType<typeof drizzle>;
  hostId: string;
  runId: string;
  runtimeVmName?: string;
  now: number;
  vms?: Array<{
    id: string;
    ordinal?: number;
    scenarioVmId: string;
    scenarioVmName: string;
    runtimeVmName: string;
    hostname: string;
  }>;
}): Promise<void> {
  const vms = input.vms ?? [
    {
      id: "vm-1",
      ordinal: 0,
      scenarioVmId: "scenario-vm-web",
      scenarioVmName: "webserver",
      runtimeVmName: input.runtimeVmName ?? "runtime-web",
      hostname: "webserver",
    },
  ];
  const initial = buildInitialRunState({
    vms: vms.map((vm, index) => ({
      id: vm.id,
      ordinal: vm.ordinal ?? index,
      scenarioVmId: vm.scenarioVmId,
      scenarioVmName: vm.scenarioVmName,
      runtimeVmName: vm.runtimeVmName,
      hostname: vm.hostname,
      launchSummary: {
        scenarioVmName: vm.scenarioVmName,
        hostname: vm.hostname,
        probePhaseMap: {},
        probeDescriptors: [],
      },
    })),
  });
  const state = recomputeRunState({
    ...initial,
    vms: initial.vms.map((vm) => ({
      ...vm,
      phase: "booting",
      provisioning: {
        image: `broken-nginx-${vm.scenarioVmName}-x86_64`,
        imageKey: testImageKey,
        imageSha256: "2".repeat(64),
        resources: {
          cpuMillis: 1_000,
          vcpuCount: 1,
          memoryMib: 512,
          diskMib: 4096,
        },
        leaseDurationSeconds: 1,
        groupName: null,
        groupId: null,
        setupKeyId: null,
        status: "queued",
        error: null,
      },
    })),
  });

  await input.db.insert(scenarioRuns).values({
    runId: input.runId,
    userId: "user-1",
    hostId: input.hostId,
    scenarioId: "broken-nginx",
    scenarioName: "broken-nginx",
    title: "Broken Nginx",
    tagline: "",
    briefingMarkdown: "",
    objectivesJson: "[]",
    difficulty: "easy",
    estimatedMinutes: 1,
    tagsJson: [],
    hintsJson: [],
    solutionMarkdown: "",
    vmCount: vms.length,
    state: state.phase,
    stateRank: RUN_PHASE_ORDER[state.phase],
    activeKey: "user-1",
    stateJson: JSON.stringify(state),
    createdAt: input.now,
    updatedAt: input.now,
  });
}

async function seedEnabledScenario(
  db: ReturnType<typeof drizzle>,
  now: number,
): Promise<void> {
  await db.insert(vmScenarios).values({
    scenarioId: "broken-nginx",
    title: "Broken Nginx",
    description: "Repair nginx.",
    difficulty: "easy",
    estimatedMinutes: 1,
    tagsJson: [],
    briefingMarkdown: "Repair nginx.",
    solutionMarkdown: "Start nginx.",
    hintsJson: [],
    enabled: true,
    enabledAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(vmScenarioVms).values({
    id: "scenario-vm-web",
    scenarioId: "broken-nginx",
    ordinal: 0,
    vmName: "webserver",
    image: "debian-13-generic",
    imageKeyJson: testImageKey,
    imageSha256: "2".repeat(64),
    imageFormat: "raw_zstd",
    imageVirtualSizeBytes: 1_073_741_824,
    kernelSha256: "a".repeat(64),
    initrdSha256: "b".repeat(64),
    bootCmdline: "root=/dev/vda rw",
    cpuMillis: 125,
    vcpuCount: 1,
    memoryMib: 512,
    diskMib: 4096,
  });
}

function stateReport(
  hostId: string,
  input: {
    observedAt: number;
    appliedDesiredVersion: number;
    cachedImages?: HostStateReportV2["cached_images"];
    vms?: HostStateReportV2["vms"];
    schedulableCpuMillis?: number;
  },
): BridgeMessageV6 {
  return {
    type: "state_report",
    protocol_version: 6,
    host_id: hostId,
    report: {
      schema_version: HOST_STATE_REPORT_SCHEMA_VERSION,
      host_id: hostId,
      observed_at_unix_ms: input.observedAt,
      applied_desired_version: input.appliedDesiredVersion,
      capacity: {
        total_cpu_millis: (input.schedulableCpuMillis ?? 4_000) + 1_000,
        reserved_cpu_millis: 1_000,
        schedulable_cpu_millis: input.schedulableCpuMillis ?? 4_000,
        committed_cpu_millis: 0,
        memory_total_mib: 8192,
        memory_available_mib: 4096,
        disk_probe_path: "/var/lib/intar-agent",
        disk_total_mib: 100_000,
        disk_available_mib: 80_000,
      },
      capabilities: {
        arch: "x86_64",
        cloud_hypervisor_sha256:
          "448af3d4e59b22c2987f7df94c213ad40fb53a10d437e42b5ee6c4fce7c29ecc",
        boot_cpu_millis: 2_000,
        boot_cpu_lease_ms: 45_000,
        supports_kvm: true,
        supports_vsock: true,
        supports_reflink: true,
        supports_nftables: true,
        supports_jailer_v1: false,
        supports_jailer_v2: true,
        supports_boot_cpu_lease: true,
        supports_template_backed_launch: true,
        fast_template_store: true,
        supports_hard_cpu_quota: true,
        supports_landlock: true,
        supports_cgroup_v2: true,
      },
      cached_images: input.cachedImages ?? [],
      vms: input.vms ?? [],
      builds: [],
    },
  };
}

function actualVm(
  runId: string,
  vmName: string,
  observedAt: number,
): VmActualStateV2 {
  return {
    run_id: runId,
    vm_name: vmName,
    phase: "running",
    terminal: {
      state: "pending",
      observed_at_unix_ms: observedAt,
    },
    runtime_constraints: {
      generation: `generation-${vmName}`,
      phase: "steady",
      steady_cpu_millis: 1_000,
      effective_cpu_millis: 1_000,
      quota_verified_at_unix_ms: observedAt,
    },
    ssh_host_keys_openssh: [],
    probes: [],
    updated_at_unix_ms: observedAt,
  };
}

function vmReport(
  hostId: string,
  runId: string,
  vmName: string,
  phase: VmPhase,
  observedAt: number,
  sshHostPort: number,
  guestIp: string,
): BridgeMessageV6 {
  const terminalReady = phase === "ready" || phase === "solved";
  const terminalFailed = phase === "failed";
  return {
    type: "vm_report",
    protocol_version: 6,
    host_id: hostId,
    report: {
      schema_version: 3,
      host_id: hostId,
      run_id: runId,
      vm_name: vmName,
      desired_version: 1,
      observed_at_unix_ms: observedAt,
      phase,
      network: {
        bridge_name: "intar-run-test",
        guest_ip: guestIp,
        guest_cidr: `${guestIp}/28`,
        gateway: "10.77.0.1",
        ssh_host: "203.0.113.9",
        ssh_host_port: sshHostPort,
      },
      terminal: {
        state: terminalReady ? "ready" : terminalFailed ? "failed" : "pending",
        ...(terminalReady
          ? {
              target: {
                host: "203.0.113.9",
                port: sshHostPort,
                username: "ubuntu",
                checked_at_unix_ms: observedAt,
              },
            }
          : {}),
        observed_at_unix_ms: observedAt,
      },
      runtime_constraints: {
        generation: `generation-${vmName}`,
        phase: terminalReady ? "steady" : "boot_burst",
        steady_cpu_millis: 1_000,
        effective_cpu_millis: terminalReady ? 1_000 : 2_000,
        ...(terminalReady
          ? { quota_verified_at_unix_ms: observedAt - 1 }
          : { lease_expires_at_unix_ms: observedAt + 45_000 }),
      },
      ssh_host_keys_openssh: [
        `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${vmName} host-key`,
      ],
      probes: [],
      archive: {
        phase: "none",
        artifact_count: 0,
      },
    } satisfies VmReportV2,
  };
}
