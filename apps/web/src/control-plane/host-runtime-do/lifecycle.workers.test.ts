/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { beforeEach, describe, expect, it, vi } from "vitest";

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
  vmReport,
  env,
  eq,
  drizzle,
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

describe("HostRuntimeDO run lifecycle projection", () => {
  beforeEach(resetHostRuntimeTestDatabase);

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
      upsertDesiredVm(draft, {
        run_id: runId,
        vm_name: runtimeVmName,
        desired_phase: "running",
        image_key: testImageKey,
        image_id: "2".repeat(64),
        guest_tools: testGuestTools,
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
      protocol_version: 7,
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
      guestBootstrapAbi: 1,
      kernelSha256: "a".repeat(64),
      initrdSha256: "b".repeat(64),
      bootCmdline: "console=ttyS0 root=/dev/vda rw",
      cpuMillis: 1_000,
      vcpuCount: 1,
      memoryMib: 512,
      diskMib: 1_024,
    }),
  ]);
}
