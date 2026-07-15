/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import {
  agentHosts,
  hostActualState,
  hostDesiredState,
  scenarioRuns,
  user,
  vmScenarioVms,
  vmScenarios,
} from "@/db/schema";
import type {
  BridgeMessageV6,
  HostStateReportV2,
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

  it("keeps desired delivery on the lightweight VM-report path", async () => {
    const hostId = "host-vm-report-dispatch";
    await seedHost(hostId);
    const { messages, ws } = await connectHost(hostId);
    await waitForBridgeMessage(
      messages,
      (message) => message.type === "server_hello",
    );
    await waitForBridgeMessage(
      messages,
      (message) =>
        message.type === "desired_state" && message.desired_state.version === 0,
    );

    await mutateStoredHostDesiredState(
      drizzle(env.DB),
      hostId,
      Date.now(),
      (draft) => {
        upsertDesiredCachedImage(draft, {
          image_key: testImageKey,
          image_sha256: "1".repeat(64),
        });
      },
    );
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
        "missing-run",
        "runtime-web",
        "booting",
        Date.now(),
        22_001,
        "10.77.0.2",
      ),
    );

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
