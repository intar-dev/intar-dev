/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { beforeEach, describe, expect, it, vi } from "vitest";
import { expireOverdueRuntimeExecutions } from "@/lib/runtime-lease-expiry";
import type { HostStateReportV2 } from "@/generated/bridge";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";

const stargateMocks = vi.hoisted(() => ({
  deleteStargateRoute: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/stargate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stargate")>()),
  deleteStargateRoute: stargateMocks.deleteStargateRoute,
}));
import {
  activeRuntimeSlots,
  hostResourceReservations,
  runtimeExecutions,
  runtimeVms,
} from "@/db/schema";
import {
  testImageKey,
  testGuestTools,
  desiredRunningVm,
  seedHost,
  connectHost,
  sendBridge,
  waitForBridgeMessage,
  runNextScheduledAlarm,
  waitForMessageCount,
  waitForRunState,
  waitForHostActualState,
  sleep,
  seedRun,
  stateReport,
  actualVm,
  vmReport,
  env,
  eq,
  drizzle,
  courseCatalogs,
  hostDesiredState,
  scenarioRuns,
  vmScenarios,
  vmScenarioVms,
  upsertDesiredCachedImage,
  upsertDesiredVm,
  mutateStoredHostDesiredState,
  type RunStateDocument,
  resetHostRuntimeTestDatabase,
} from "./test-fixtures";

// Workerd eviction drains active requests for up to five seconds per eviction.
vi.setConfig({ testTimeout: 20_000 });

describe("HostRuntimeDO run lifecycle projection", () => {
  beforeEach(resetHostRuntimeTestDatabase);

  it("restores its alarm when a slow retirement clears a concurrent wake", async () => {
    const hostId = "late-retirement";
    await seedHost(hostId);
    const leaseExpiry = Date.now() + 120_000;
    await seedRun({ db: drizzle(env.DB), hostId, runId: "run", runtimeVmName: "vm", now: Date.now() });
    await drizzle(env.DB).update(runtimeExecutions).set({ leaseExpiresAt: leaseExpiry }).where(eq(runtimeExecutions.id, "run"));
    await mutateStoredHostDesiredState(drizzle(env.DB), hostId, Date.now(), draft => {
      upsertDesiredVm(draft, { ...desiredRunningVm("run", "vm", Date.now()), lease_expires_at_unix_ms: leaseExpiry });
    });
    const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName(hostId));
    await runInDurableObject(stub, async (instance, state) => {
      const runtime = instance as unknown as { fetch(request: Request): Promise<Response> };
      let reached!: () => void;
      let resume!: () => void;
      const clearing = new Promise<void>(resolve => { reached = resolve; });
      const release = new Promise<void>(resolve => { resume = resolve; });
      const deleteAll = state.storage.deleteAll.bind(state.storage);
      const spy = vi.spyOn(state.storage, "deleteAll").mockImplementationOnce(async () => {
        reached();
        await release;
        return deleteAll();
      });
      const retirement = runtime.fetch(new Request("http://host-runtime/_internal/retire", {
        method: "POST", headers: { "x-agent-host-id": hostId },
      }));
      try {
        await clearing;
        const wake = await runtime.fetch(new Request("http://host-runtime/_internal/wake", {
          method: "POST", body: JSON.stringify({ hostId }),
        }));
        expect(wake.status).toBe(202);
        await wake.text();
        expect(await state.storage.getAlarm()).not.toBeNull();
      } finally {
        resume();
        spy.mockRestore();
      }
      const retired = await retirement;
      expect(retired.status).toBe(200);
      await retired.text();
      expect(await state.storage.getAlarm()).not.toBeNull();
      expect(await state.storage.getAlarm()).toBeLessThanOrEqual(leaseExpiry + 1);
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance, state) => {
      const runtime = instance as unknown as { loadKnownHostId(): Promise<string | null> };
      expect(await runtime.loadKnownHostId()).toBe(hostId);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  it.each(["stop-read", "alarm-read"] as const)("returns 503 and retains a cleanup alarm after a retirement %s failure", async failure => {
    const hostId = `retire-${failure}`;
    await seedHost(hostId);
    await seedRun({ db: drizzle(env.DB), hostId, runId: "run", runtimeVmName: "vm", now: Date.now() });
    await drizzle(env.DB).update(runtimeExecutions).set({ leaseExpiresAt: Date.now() + 60_000 }).where(eq(runtimeExecutions.id, "run"));
    await mutateStoredHostDesiredState(drizzle(env.DB), hostId, Date.now(), draft => {
      upsertDesiredVm(draft, desiredRunningVm("run", "vm", Date.now()));
    });
    const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName(hostId));
    await runInDurableObject(stub, async (instance, state) => {
      const runtime = instance as unknown as {
        env: { DB: D1Database };
        fetch(request: Request): Promise<Response>;
        computeNextAlarm(hostId: string): Promise<number | null>;
      };
      const error = new Error("injected D1 read failure");
      const spy = failure === "stop-read"
        ? vi.spyOn(runtime.env.DB, "prepare").mockImplementationOnce(() => { throw error; })
        : vi.spyOn(runtime, "computeNextAlarm").mockRejectedValueOnce(error);
      try {
        const response = await runtime.fetch(new Request("http://host-runtime/_internal/retire", {
          method: "POST", headers: { "x-agent-host-id": hostId },
        }));
        expect(response.status).toBe(503);
        await response.text();
        expect(await state.storage.getAlarm()).not.toBeNull();
      } finally { spy.mockRestore(); }
    });
  });

  it.each(["personal", "platform"] as const)("sends a final stop-only frame to a revoked %s host and restores lease cleanup after clearing storage", async scope => {
    const hostId = `retire-${scope}`;
    const now = Date.now();
    await seedHost(hostId);
    await env.DB.prepare("UPDATE agent_hosts SET scope = ? WHERE id = ?").bind(scope, hostId).run();
    const { messages, stub, ws } = await connectHost(hostId);
    await waitForBridgeMessage(messages, frame => frame.type === "desired_state");
    const db = drizzle(env.DB);
    await seedRun({ db, hostId, runId: "run", now });
    const leaseExpiry = Date.now() + 120_000;
    await db.update(runtimeExecutions).set({ leaseExpiresAt: leaseExpiry }).where(eq(runtimeExecutions.id, "run"));
    const retained = await mutateStoredHostDesiredState(db, hostId, now, draft => {
      upsertDesiredVm(draft, { ...desiredRunningVm("run", "runtime-web", now), lease_expires_at_unix_ms: leaseExpiry });
      upsertDesiredVm(draft, { ...desiredRunningVm("run", "already-absent", now), desired_phase: "absent" });
      draft.cached_images = [{ image_key: testImageKey, image_id: "2".repeat(64) }];
      draft.cached_guest_tools = [testGuestTools];
      draft.builds = [{ build_id: "build", scenario_id: "scenario", arch: "x86_64", rev: "revision", content_hash: "3".repeat(64), bundle_ref: "bundle" }];
    });
    const before = await env.DB.prepare("SELECT state, state_json, updated_at FROM scenario_runs WHERE run_id = 'run'").first();
    const executionBefore = await env.DB.prepare("SELECT state, ended_at FROM runtime_executions WHERE id = 'run'").first();
    // Reproduce the ordering used by revocation: fence reports before retirement.
    await env.DB.prepare("UPDATE agent_hosts SET disabled = 1, credential_generation = 2, active_session_id = NULL WHERE id = ?").bind(hostId).run();
    const close = new Promise<number>(resolve => ws.addEventListener("close", event => resolve(event.code), { once: true }));
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("unrelated-old-state", "must be cleared");
    });
    await evictDurableObject(stub);
    const response = await stub.fetch("http://host-runtime/_internal/retire", {
      method: "POST", headers: { "x-agent-host-id": hostId },
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(await close).toBe(1001);
    const stop = await waitForBridgeMessage(messages, frame => frame.type === "desired_state" && frame.desired_state.version === retained.version + 1);
    if (stop.type !== "desired_state") throw new Error("expected stop state");
    expect(stop.desired_state.vms.map(vm => [vm.vm_name, vm.desired_phase])).toEqual([
      ["already-absent", "absent"], ["runtime-web", "absent"],
    ]);
    expect(stop.desired_state).toMatchObject({ cached_images: [], cached_guest_tools: [], builds: [] });
    const [stored] = await db.select().from(hostDesiredState).where(eq(hostDesiredState.hostId, hostId));
    expect(stored?.docJson).toEqual(stop.desired_state);
    expect(stop.desired_state.vms.map(vm => vm.lease_expires_at_unix_ms))
      .toEqual(retained.vms.map(vm => vm.lease_expires_at_unix_ms));
    // Sending the stop is not evidence that a physical VM stopped.
    expect(await env.DB.prepare("SELECT state, state_json, updated_at FROM scenario_runs WHERE run_id = 'run'").first()).toEqual(before);
    expect(await env.DB.prepare("SELECT state, ended_at FROM runtime_executions WHERE id = 'run'").first()).toEqual(executionBefore);
    // No follow-up wake: retirement must repair its own alarm even if its
    // caller timed out before this operation completed.
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get("unrelated-old-state")).toBeUndefined();
      expect(await state.storage.getAlarm()).not.toBeNull();
      expect(await state.storage.getAlarm()).toBeLessThanOrEqual(leaseExpiry + 1);
    });
    // Reach the retained lease deadline without waiting for any host report.
    const clock = vi.spyOn(Date, "now").mockReturnValue(leaseExpiry + 1);
    try { await runNextScheduledAlarm(stub); } finally { clock.mockRestore(); }
    expect(await env.DB.prepare("SELECT state FROM scenario_runs WHERE run_id = 'run'").first()).toEqual({ state: "failed" });
    expect(await env.DB.prepare("SELECT state FROM runtime_executions WHERE id = 'run'").first()).toEqual({ state: "archived" });
  });

  it("does not revive an execution archived after full-report acceptance", async () => {
    const hostId = "host-report-expiry-race";
    const runId = "run-report-expiry-race";
    const now = Date.now();
    await seedHost(hostId);
    await env.DB.prepare("UPDATE agent_hosts SET scope = 'platform' WHERE id = ?").bind(hostId).run();
    const db = drizzle(env.DB);
    await seedRun({ db, hostId, runId, now });
    const leaseExpiry = now + 120_000;
    await db.update(runtimeExecutions).set({ leaseExpiresAt: leaseExpiry }).where(eq(runtimeExecutions.id, runId));
    const { stub, ws, messages } = await connectHost(hostId);
    await waitForBridgeMessage(messages, frame => frame.type === "desired_state");
    const message = stateReport(hostId, { observedAt: now + 1, appliedDesiredVersion: 0,
      vms: [actualVm(runId, "runtime-web", now + 1)] });
    if (message.type !== "state_report") throw new Error("expected full report");
    await runInDurableObject(stub, async instance => {
      const runtime = instance as unknown as {
        persistRunState(...args: unknown[]): Promise<unknown>;
        applyBridgeStateReport(hostId: string, report: HostStateReportV2, sessionId: string, generation: number): Promise<void>;
      };
      const session = await env.DB.prepare("SELECT active_session_id FROM agent_hosts WHERE id = ?").bind(hostId).first<{active_session_id:string}>();
      const persist = runtime.persistRunState.bind(runtime);
      let expiredState: unknown;
      const spy = vi.spyOn(runtime, "persistRunState").mockImplementationOnce(async (...args) => {
        // The inventory INSERT succeeded; expiry now wins before the run CAS.
        expect(await env.DB.prepare("SELECT observed_at FROM host_actual_state WHERE host_id = ?").bind(hostId).first())
          .toEqual({ observed_at: now + 1 });
        expect(await expireOverdueRuntimeExecutions(hostId, leaseExpiry + 1))
          .toEqual({ expiredExecutionIds: [runId], failedExecutionIds: [] });
        expiredState = await env.DB.prepare("SELECT state, state_json, updated_at FROM scenario_runs WHERE run_id = ?").bind(runId).first();
        return persist(...args);
      });
      try {
        await runtime.applyBridgeStateReport(hostId, message.report, session!.active_session_id, 1);
        expect(spy).toHaveBeenCalledOnce();
        expect(await env.DB.prepare("SELECT state, state_json, updated_at FROM scenario_runs WHERE run_id = ?").bind(runId).first()).toEqual(expiredState);
      } finally { spy.mockRestore(); }
    });
    expect(await db.select({ state: runtimeExecutions.state }).from(runtimeExecutions).where(eq(runtimeExecutions.id, runId)))
      .toEqual([{ state: "archived" }]);
    expect(await db.select().from(activeRuntimeSlots).where(eq(activeRuntimeSlots.executionId, runId))).toEqual([]);
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
      seedRuntimeVms: false,
    });
    await db.batch([
      db
        .update(runtimeExecutions)
        .set({ leaseExpiresAt: now - 1, updatedAt: now })
        .where(eq(runtimeExecutions.id, runId)),
      db.insert(runtimeVms).values({
        id: "runtime-vm-expired",
        executionId: runId,
        vmId: "vm-1",
        ordinal: 0,
        runtimeVmName,
        imageKeyJson: testImageKey,
        imageSha256: "2".repeat(64),
        cpuMillis: 1_000,
        memoryMib: 512,
        diskMib: 4_096,
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(hostResourceReservations).values({
        executionId: runId,
        hostId,
        cpuMillis: 1_000,
        memoryMib: 512,
        worstCaseDiskMib: 4_096,
        state: "committed",
        createdAt: now,
        updatedAt: now,
      }),
    ]);
    await mutateStoredHostDesiredState(db, hostId, now, (draft) => {
      upsertDesiredVm(draft, { owner_user_id: "user-1", runtime_execution_id: runId, generation: 1, vm_id: runtimeVmName,
        run_id: runId,
        vm_name: runtimeVmName,
        desired_phase: "running",
        image_key: testImageKey,
        image_id: "2".repeat(64),
        guest_tools: testGuestTools,
        resources: {
          cpu_millis: 1_000,
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

    const [[execution], slots, [reservation]] = await Promise.all([
      db
        .select({ state: runtimeExecutions.state })
        .from(runtimeExecutions)
        .where(eq(runtimeExecutions.id, runId)),
      db
        .select({ executionId: activeRuntimeSlots.executionId })
        .from(activeRuntimeSlots),
      db
        .select({ state: hostResourceReservations.state })
        .from(hostResourceReservations)
        .where(eq(hostResourceReservations.executionId, runId)),
    ]);
    expect(execution?.state).toBe("archived");
    expect(slots).toEqual([]);
    expect(reservation?.state).toBe("released");

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
    unsealed.report.phase = "booting";
    unsealed.report.runtime_constraints = {
      generation: "generation-runtime-web",
      cpu_millis: 1_000,
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
      terminalReason: "Waiting for CPU limit verification.",
      runtimeConstraints: {
        cpuMillis: 1_000,
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
        cpuMillis: 1_000,
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
    await env.DB.prepare("UPDATE agent_hosts SET scope = 'platform' WHERE id = ?").bind(hostId).run();
    await seedCatalogImage("3".repeat(64));
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
        image_id: "3".repeat(64),
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
      protocol_version: 8,
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
    ).toBeGreaterThanOrEqual(2);

    sendBridge(
      ws,
      stateReport(hostId, {
        observedAt: Date.now(),
        appliedDesiredVersion: 1,
        cachedImages: [
          {
            image_key: testImageKey,
            image_id: "3".repeat(64),
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

  it("seeds a host registered after publication before its first desired-state dispatch", async () => {
    const hostId = "host-created-after-publication";
    const sha256 = "4".repeat(64);
    await seedHost(hostId);
    await env.DB.prepare("UPDATE agent_hosts SET scope = 'platform' WHERE id = ?").bind(hostId).run();
    await seedCatalogImage(sha256);

    const { messages, ws } = await connectHost(hostId);
    await waitForBridgeMessage(
      messages,
      (message) => message.type === "server_hello",
    );
    const desired = await waitForBridgeMessage(
      messages,
      (message) =>
        message.type === "desired_state" &&
        message.desired_state.cached_images.some(
          (entry) => entry.image_id === sha256,
        ),
    );

    expect(desired).toMatchObject({
      type: "desired_state",
      desired_state: {
        version: 1,
        cached_images: [
          {
            image_key: testImageKey,
            image_id: sha256,
          },
        ],
      },
    });
    expect(messages.slice(0, 2).map((message) => message.type)).toEqual([
      "server_hello",
      "desired_state",
    ]);
    ws.close();
  });

  it("periodically repairs catalog cache drift on an already connected host", async () => {
    const hostId = "host-periodic-image-repair";
    const sha256 = "5".repeat(64);
    await seedHost(hostId);
    await env.DB.prepare("UPDATE agent_hosts SET scope = 'platform' WHERE id = ?").bind(hostId).run();
    await seedCatalogImage(sha256);
    const { messages, ws } = await connectHost(hostId);
    await waitForBridgeMessage(
      messages,
      (message) =>
        message.type === "desired_state" &&
        message.desired_state.cached_images[0]?.image_id === sha256,
    );

    const db = drizzle(env.DB);
    const cleared = await mutateStoredHostDesiredState(
      db,
      hostId,
      Date.now(),
      (draft) => {
        draft.cached_images = [];
      },
    );
    sendBridge(
      ws,
      stateReport(hostId, {
        observedAt: Date.now(),
        appliedDesiredVersion: cleared.version,
        cachedImages: [],
      }),
    );

    const repaired = await waitForBridgeMessage(
      messages,
      (message) =>
        message.type === "desired_state" &&
        message.desired_state.version > cleared.version &&
        message.desired_state.cached_images[0]?.image_id === sha256,
    );
    expect(repaired).toMatchObject({ type: "desired_state" });
    ws.close();
  });
});

async function seedCatalogImage(sha256: string): Promise<void> {
  const db = drizzle(env.DB);
  const now = Date.now();
  await db.batch([
    db.insert(courseCatalogs).values({
      scopeKey: "public",
      organizationId: null,
      catalogJson: {
        version: 2,
        courses: [
          {
            courseId: "host-runtime-cache",
            title: "Host runtime cache",
            summary: "Cache test course.",
            bodyMarkdown: "Cache test course body.",
            sequential: false,
            lectures: [
              {
                lectureId: "cache-image",
                title: "Cache image",
                summary: "Cache image test lecture.",
                bodyMarkdown: "Cache image test lecture body.",
                category: "test",
                tags: [],
                difficulty: "easy",
                estimatedMinutes: 10,
                scenarioId: testImageKey.scenario,
              },
            ],
          },
        ],
      },
      sourceRevision: "fixture",
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(vmScenarios).values({
      scenarioId: testImageKey.scenario,
      organizationId: null,
      title: "Broken nginx",
      category: "test",
      description: "host image reconciliation test",
      difficulty: "easy",
      estimatedMinutes: 10,
      tagsJson: [],
      briefingMarkdown: "briefing",
      solutionMarkdown: "solution",
      hintsJson: [],
      enabled: true,
      enabledAt: now,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(vmScenarioVms).values({
      id: `${testImageKey.scenario}:${testImageKey.vm}`,
      scenarioId: testImageKey.scenario,
      ordinal: 0,
      vmName: testImageKey.vm,
      image: "broken-nginx-webserver-x86_64.chunks.json",
      imageKeyJson: testImageKey,
      imageSha256: sha256,
      imageFormat: "raw_chunks_v1",
      imageVirtualSizeBytes: 1_024,
      chunkManifestSha256: "d".repeat(64),
      guestBootstrapAbi: 2,
      kernelSha256: "a".repeat(64),
      initrdSha256: "b".repeat(64),
      bootCmdline: "console=ttyS0 root=/dev/vda rw",
      cpuMillis: 1_000,
      memoryMib: 512,
      diskMib: 1_024,
    }),
  ]);
}
