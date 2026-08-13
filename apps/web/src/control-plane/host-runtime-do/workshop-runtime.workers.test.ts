/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { and, asc, eq } from "drizzle-orm";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import {
  agentHosts,
  hostResourceReservations,
  member,
  organization,
  runtimeExecutions,
  runtimeVmAccessKeys,
  runtimeVmActualState,
  runtimeVms,
  workshopModuleProgress,
  workshopSessionMembers,
  workshopSessions,
  workshopTemplateRevisions,
  workshopTemplates,
  workshopWorkspaceGenerations,
  workshopWorkspaces,
  type WorkshopManifestV2,
} from "@/db/schema";
import type { BridgeMessageV6, VmProbeSnapshotV1 } from "@/generated/bridge";
import { upsertDesiredVm } from "@/lib/desired-state";
import { mutateStoredHostDesiredState } from "@/lib/desired-state-store";
import {
  archiveRuntimeExecution,
  createRuntimeExecution,
  createRuntimeRecoveryGeneration,
  type RuntimeVmSpec,
} from "@/lib/runtime-executions";
import { ensureRuntimeVmAccessKeys } from "@/lib/runtime-vm-state";
import { recordWorkshopGenerationState } from "@/lib/workshops/provisioning";
import {
  actualVm,
  connectHost,
  drizzle,
  env,
  resetHostRuntimeTestDatabase,
  seedHost,
  seedRun,
  sendBridge,
  sleep,
  stateReport,
  vmReport,
  waitForBridgeMessage,
  waitForRunState,
} from "./test-fixtures";

describe("HostRuntimeDO generic runtime projection", () => {
  beforeEach(resetHostRuntimeTestDatabase);

  it("projects current workshop VM state, terminal access, reservation, generation, and latched probes", async () => {
    const now = Date.now();
    const fixture = await seedWorkshopRuntime({
      hostId: "host-workshop-current",
      executionId: "workshop-execution-current",
      now,
    });
    const { messages, ws } = await connectHost(fixture.hostId);
    await waitForBridgeMessage(
      messages,
      (message) => message.type === "server_hello",
    );

    sendBridge(
      ws,
      workshopVmReport({
        hostId: fixture.hostId,
        executionId: fixture.executionId,
        runtimeVmName: fixture.runtimeVmName,
        observedAt: now + 100,
        probes: [
          probe("workspace-ready", "pass", now + 100),
          probe("service-ready", "pass", now + 100),
        ],
      }),
    );

    await waitUntil(async () => {
      const [execution, progress] = await Promise.all([
        fixture.db
          .select({ state: runtimeExecutions.state })
          .from(runtimeExecutions)
          .where(eq(runtimeExecutions.id, fixture.executionId)),
        fixture.db
          .select({
            technicalStatus: workshopModuleProgress.technicalStatus,
            currentHealth: workshopModuleProgress.currentHealth,
          })
          .from(workshopModuleProgress)
          .where(
            and(
              eq(workshopModuleProgress.sessionId, fixture.sessionId),
              eq(workshopModuleProgress.moduleId, "01-service"),
            ),
          ),
      ]);
      return (
        execution[0]?.state === "ready" &&
        progress[0]?.technicalStatus === "verified" &&
        progress[0]?.currentHealth === "passing"
      );
    });

    const [
      actualRows,
      accessRows,
      runtimeVmRows,
      reservationRows,
      generationRows,
      workspaceRows,
      memberRows,
      progressRows,
    ] = await Promise.all([
      fixture.db
        .select()
        .from(runtimeVmActualState)
        .where(eq(runtimeVmActualState.executionId, fixture.executionId)),
      fixture.db
        .select()
        .from(runtimeVmAccessKeys)
        .where(eq(runtimeVmAccessKeys.executionId, fixture.executionId)),
      fixture.db
        .select()
        .from(runtimeVms)
        .where(eq(runtimeVms.executionId, fixture.executionId)),
      fixture.db
        .select()
        .from(hostResourceReservations)
        .where(eq(hostResourceReservations.executionId, fixture.executionId)),
      fixture.db
        .select()
        .from(workshopWorkspaceGenerations)
        .where(eq(workshopWorkspaceGenerations.id, fixture.generationId)),
      fixture.db
        .select()
        .from(workshopWorkspaces)
        .where(eq(workshopWorkspaces.id, fixture.workspaceId)),
      fixture.db
        .select()
        .from(workshopSessionMembers)
        .where(eq(workshopSessionMembers.id, fixture.memberId)),
      fixture.db
        .select()
        .from(workshopModuleProgress)
        .where(eq(workshopModuleProgress.sessionId, fixture.sessionId))
        .orderBy(asc(workshopModuleProgress.moduleId)),
    ]);
    expect(actualRows).toHaveLength(1);
    expect(actualRows[0]).toMatchObject({
      hostId: fixture.hostId,
      phase: "ready",
      desiredVersion: 1,
      observedAt: now + 100,
    });
    expect(accessRows).toHaveLength(1);
    expect(accessRows[0]?.publicKeyOpenssh).toMatch(/^ssh-ed25519 /);
    expect(runtimeVmRows[0]).toMatchObject({
      terminalHost: "203.0.113.9",
      terminalPort: 2222,
      terminalUsername: "ubuntu",
      terminalObservedAt: now + 100,
    });
    expect(runtimeVmRows[0]?.terminalHostKeyOpenssh).toContain(
      fixture.runtimeVmName,
    );
    expect(runtimeVmRows[0]?.terminalPrivateKeyCiphertextB64).toBeTruthy();
    expect(runtimeVmRows[0]?.terminalPrivateKeyIvB64).toBeTruthy();
    expect(reservationRows[0]?.state).toBe("committed");
    expect(generationRows[0]).toMatchObject({
      state: "ready",
      readyAt: now + 100,
    });
    expect(workspaceRows[0]?.state).toBe("ready");
    expect(memberRows[0]?.provisionState).toBe("ready");
    expect(progressRows).toHaveLength(2);
    expect(
      progressRows.map((row) => ({
        moduleId: row.moduleId,
        technicalStatus: row.technicalStatus,
        currentHealth: row.currentHealth,
        firstVerifiedAt: row.firstVerifiedAt,
      })),
    ).toEqual([
      {
        moduleId: "00-setup",
        technicalStatus: "verified",
        currentHealth: "passing",
        firstVerifiedAt: now + 100,
      },
      {
        moduleId: "01-service",
        technicalStatus: "verified",
        currentHealth: "passing",
        firstVerifiedAt: now + 100,
      },
    ]);

    sendBridge(
      ws,
      workshopVmReport({
        hostId: fixture.hostId,
        executionId: fixture.executionId,
        runtimeVmName: fixture.runtimeVmName,
        observedAt: now + 200,
        probes: [
          probe("workspace-ready", "pass", now + 200),
          probe("service-ready", "fail", now + 200),
        ],
      }),
    );
    await waitUntil(async () => {
      const rows = await fixture.db
        .select({
          technicalStatus: workshopModuleProgress.technicalStatus,
          currentHealth: workshopModuleProgress.currentHealth,
        })
        .from(workshopModuleProgress)
        .where(
          and(
            eq(workshopModuleProgress.sessionId, fixture.sessionId),
            eq(workshopModuleProgress.moduleId, "01-service"),
          ),
        );
      return (
        rows[0]?.technicalStatus === "verified" &&
        rows[0]?.currentHealth === "failing"
      );
    });
    const [regressed] = await fixture.db
      .select()
      .from(workshopModuleProgress)
      .where(
        and(
          eq(workshopModuleProgress.sessionId, fixture.sessionId),
          eq(workshopModuleProgress.moduleId, "01-service"),
        ),
      );
    expect(regressed).toMatchObject({
      technicalStatus: "verified",
      currentHealth: "failing",
      firstVerifiedAt: now + 100,
      healthObservedAt: now + 200,
    });

    const heartbeatBeforeStale = await hostHeartbeat(fixture.hostId);
    await sleep(2);
    sendBridge(
      ws,
      workshopVmReport({
        hostId: fixture.hostId,
        executionId: fixture.executionId,
        runtimeVmName: fixture.runtimeVmName,
        observedAt: now + 150,
        probes: [
          probe("workspace-ready", "pass", now + 150),
          probe("service-ready", "pass", now + 150),
        ],
      }),
    );
    await waitUntil(
      async () => (await hostHeartbeat(fixture.hostId)) > heartbeatBeforeStale,
    );
    const [[afterStaleActual], [afterStaleProgress]] = await Promise.all([
      fixture.db
        .select()
        .from(runtimeVmActualState)
        .where(eq(runtimeVmActualState.executionId, fixture.executionId)),
      fixture.db
        .select()
        .from(workshopModuleProgress)
        .where(
          and(
            eq(workshopModuleProgress.sessionId, fixture.sessionId),
            eq(workshopModuleProgress.moduleId, "01-service"),
          ),
        ),
    ]);
    expect(afterStaleActual?.observedAt).toBe(now + 200);
    expect(afterStaleProgress).toMatchObject({
      technicalStatus: "verified",
      currentHealth: "failing",
      healthObservedAt: now + 200,
    });

    sendBridge(
      ws,
      workshopVmReport({
        hostId: fixture.hostId,
        executionId: fixture.executionId,
        runtimeVmName: fixture.runtimeVmName,
        observedAt: now + 300,
        probes: [],
      }),
    );
    await waitUntil(async () => {
      const rows = await fixture.db
        .select({
          technicalStatus: workshopModuleProgress.technicalStatus,
          currentHealth: workshopModuleProgress.currentHealth,
        })
        .from(workshopModuleProgress)
        .where(
          and(
            eq(workshopModuleProgress.sessionId, fixture.sessionId),
            eq(workshopModuleProgress.moduleId, "01-service"),
          ),
        );
      return (
        rows[0]?.technicalStatus === "verified" &&
        rows[0]?.currentHealth === "unknown"
      );
    });
    const [missingSnapshot] = await fixture.db
      .select()
      .from(workshopModuleProgress)
      .where(
        and(
          eq(workshopModuleProgress.sessionId, fixture.sessionId),
          eq(workshopModuleProgress.moduleId, "01-service"),
        ),
      );
    expect(missingSnapshot).toMatchObject({
      technicalStatus: "verified",
      currentHealth: "unknown",
      firstVerifiedAt: now + 100,
      healthObservedAt: now + 300,
    });

    ws.close();
  });

  it("projects periodic workshop inventory probes and clears lost probe health", async () => {
    const now = Date.now();
    const fixture = await seedWorkshopRuntime({
      hostId: "host-workshop-inventory",
      executionId: "workshop-execution-inventory",
      now,
    });
    const { messages, ws } = await connectHost(fixture.hostId);
    await waitForBridgeMessage(
      messages,
      (message) => message.type === "server_hello",
    );

    const passing = actualVm(
      fixture.executionId,
      fixture.runtimeVmName,
      now + 100,
    );
    passing.probes = [
      probe("workspace-ready", "pass", now + 100),
      probe("service-ready", "pass", now + 100),
    ];
    sendBridge(
      ws,
      stateReport(fixture.hostId, {
        observedAt: now + 100,
        appliedDesiredVersion: 0,
        vms: [passing],
      }),
    );
    await waitUntil(async () => {
      const [progress] = await fixture.db
        .select({ health: workshopModuleProgress.currentHealth })
        .from(workshopModuleProgress)
        .where(
          and(
            eq(workshopModuleProgress.sessionId, fixture.sessionId),
            eq(workshopModuleProgress.moduleId, "01-service"),
          ),
        );
      return progress?.health === "passing";
    });

    const withoutProbes = {
      ...passing,
      probes: [],
      updated_at_unix_ms: now + 200,
    };
    sendBridge(
      ws,
      stateReport(fixture.hostId, {
        observedAt: now + 200,
        appliedDesiredVersion: 0,
        vms: [withoutProbes],
      }),
    );
    await waitUntil(async () => {
      const [progress] = await fixture.db
        .select({ health: workshopModuleProgress.currentHealth })
        .from(workshopModuleProgress)
        .where(
          and(
            eq(workshopModuleProgress.sessionId, fixture.sessionId),
            eq(workshopModuleProgress.moduleId, "01-service"),
          ),
        );
      return progress?.health === "unknown";
    });
    ws.close();
  });

  it("fails a current workshop VM missing from an applied authoritative inventory", async () => {
    const now = Date.now();
    const fixture = await seedWorkshopRuntime({
      hostId: "host-workshop-missing",
      executionId: "workshop-execution-missing",
      now,
    });
    await mutateStoredHostDesiredState(
      drizzleD1(env.DB),
      fixture.hostId,
      now,
      (draft) => {
        upsertDesiredVm(draft, {
          run_id: fixture.executionId,
          vm_name: fixture.runtimeVmName,
          desired_phase: "running",
          image_key: {
            scenario: "platform-engineering",
            vm: "workspace",
            arch: "x86_64",
          },
          image_sha256: "b".repeat(64),
          resources: {
            cpu_millis: 4_000,
            vcpu_count: 4,
            memory_mib: 16_384,
            disk_mib: 102_400,
          },
          ssh_authorized_keys_openssh: [],
          lease_expires_at_unix_ms: now + 5 * 60 * 60_000,
        });
      },
    );
    const { messages, ws } = await connectHost(fixture.hostId);
    const hello = await waitForBridgeMessage(
      messages,
      (message) => message.type === "server_hello",
    );
    if (hello.type !== "server_hello") {
      throw new Error("expected server hello");
    }
    sendBridge(
      ws,
      stateReport(fixture.hostId, {
        observedAt: now + 100,
        appliedDesiredVersion: hello.desired_version,
        vms: [],
      }),
    );
    await waitUntil(async () => {
      const [generation] = await fixture.db
        .select({ state: workshopWorkspaceGenerations.state })
        .from(workshopWorkspaceGenerations)
        .where(eq(workshopWorkspaceGenerations.id, fixture.generationId));
      return generation?.state === "failed";
    });
    const [actual] = await fixture.db
      .select({ phase: runtimeVmActualState.phase })
      .from(runtimeVmActualState)
      .where(eq(runtimeVmActualState.executionId, fixture.executionId));
    expect(actual?.phase).toBe("absent");
    ws.close();
  });

  it("does not resurrect an archived execution or ended workshop generation", async () => {
    const now = Date.now();
    const fixture = await seedWorkshopRuntime({
      hostId: "host-workshop-ended",
      executionId: "workshop-execution-ended",
      now,
    });
    await fixture.db
      .update(workshopSessions)
      .set({ state: "ended", endedAt: now + 10, updatedAt: now + 10 })
      .where(eq(workshopSessions.id, fixture.sessionId));
    await archiveRuntimeExecution({
      executionId: fixture.executionId,
      expectedGeneration: 1,
      endedAt: now + 10,
    });
    await recordWorkshopGenerationState({
      generationId: fixture.generationId,
      update: {
        state: "archived",
        runtimeExecutionId: fixture.executionId,
        observedAt: now + 10,
      },
    });
    const { messages, ws } = await connectHost(fixture.hostId);
    await waitForBridgeMessage(
      messages,
      (message) => message.type === "server_hello",
    );
    sendBridge(
      ws,
      workshopVmReport({
        hostId: fixture.hostId,
        executionId: fixture.executionId,
        runtimeVmName: fixture.runtimeVmName,
        observedAt: now + 100,
        probes: [probe("workspace-ready", "pass", now + 100)],
      }),
    );
    await sleep(25);
    const [[execution], [generation]] = await Promise.all([
      fixture.db
        .select({ state: runtimeExecutions.state })
        .from(runtimeExecutions)
        .where(eq(runtimeExecutions.id, fixture.executionId)),
      fixture.db
        .select({ state: workshopWorkspaceGenerations.state })
        .from(workshopWorkspaceGenerations)
        .where(eq(workshopWorkspaceGenerations.id, fixture.generationId)),
    ]);
    expect(execution?.state).toBe("archived");
    expect(generation?.state).toBe("archived");
    ws.close();
  });

  it("does not resurrect an expired pending resource reservation", async () => {
    const now = Date.now();
    const fixture = await seedWorkshopRuntime({
      hostId: "host-expired-reservation",
      executionId: "workshop-expired-reservation",
      now,
    });
    await fixture.db
      .update(hostResourceReservations)
      .set({ expiresAt: now - 1, updatedAt: now })
      .where(eq(hostResourceReservations.executionId, fixture.executionId));
    const { messages, ws } = await connectHost(fixture.hostId);
    await waitForBridgeMessage(
      messages,
      (message) => message.type === "server_hello",
    );

    sendBridge(
      ws,
      workshopVmReport({
        hostId: fixture.hostId,
        executionId: fixture.executionId,
        runtimeVmName: fixture.runtimeVmName,
        observedAt: now + 100,
        probes: [probe("workspace-ready", "pass", now + 100)],
      }),
    );
    await waitUntil(async () => {
      const rows = await fixture.db
        .select({ state: runtimeExecutions.state })
        .from(runtimeExecutions)
        .where(eq(runtimeExecutions.id, fixture.executionId));
      return rows[0]?.state === "ready";
    });

    const [reservation] = await fixture.db
      .select({ state: hostResourceReservations.state })
      .from(hostResourceReservations)
      .where(eq(hostResourceReservations.executionId, fixture.executionId));
    expect(reservation?.state).toBe("pending");
    ws.close();
  });

  it("fences stale workshop generations and reports from the wrong host", async () => {
    const now = Date.now();
    const fixture = await seedWorkshopRuntime({
      hostId: "host-generation-current",
      executionId: "workshop-generation-one",
      now,
    });
    const currentConnection = await connectHost(fixture.hostId);
    await waitForBridgeMessage(
      currentConnection.messages,
      (message) => message.type === "server_hello",
    );

    const recovered = await createRuntimeRecoveryGeneration({
      sourceExecutionId: fixture.executionId,
      expectedGeneration: 1,
      executionId: "workshop-generation-two",
      hostId: fixture.hostId,
      checkpointId: "checkpoint-01",
      vms: [runtimeVmSpec("workshop-generation-two")],
      now: now + 100,
    });
    await ensureRuntimeVmAccessKeys({
      executionId: recovered.executionId,
      expectedGeneration: 2,
      now: now + 100,
    });
    await fixture.db.insert(workshopWorkspaceGenerations).values({
      id: "workspace-generation-two",
      workspaceId: fixture.workspaceId,
      ordinal: 2,
      runtimeExecutionId: recovered.executionId,
      checkpointId: "checkpoint-01",
      hostId: fixture.hostId,
      state: "provisioning",
      requestedAt: now + 100,
      provisioningStartedAt: now + 100,
      createdAt: now + 100,
      updatedAt: now + 100,
    });
    await Promise.all([
      fixture.db
        .update(workshopWorkspaces)
        .set({
          currentGenerationId: "workspace-generation-two",
          state: "recovering",
          recoveryMessage: "Restored from checkpoint 01",
          updatedAt: now + 100,
        })
        .where(eq(workshopWorkspaces.id, fixture.workspaceId)),
      fixture.db
        .update(workshopSessionMembers)
        .set({
          provisionState: "provisioning",
          provisionError: null,
          updatedAt: now + 100,
        })
        .where(eq(workshopSessionMembers.id, fixture.memberId)),
    ]);

    await recordWorkshopGenerationState({
      generationId: fixture.generationId,
      update: {
        state: "failed",
        runtimeExecutionId: fixture.executionId,
        hostId: fixture.hostId,
        error: "late failure from generation one",
        observedAt: now + 200,
      },
    });
    const [[oldGeneration], [workspace], [sessionMember]] = await Promise.all([
      fixture.db
        .select()
        .from(workshopWorkspaceGenerations)
        .where(eq(workshopWorkspaceGenerations.id, fixture.generationId)),
      fixture.db
        .select()
        .from(workshopWorkspaces)
        .where(eq(workshopWorkspaces.id, fixture.workspaceId)),
      fixture.db
        .select()
        .from(workshopSessionMembers)
        .where(eq(workshopSessionMembers.id, fixture.memberId)),
    ]);
    expect(oldGeneration).toMatchObject({
      state: "failed",
      error: "late failure from generation one",
    });
    expect(workspace).toMatchObject({
      currentGenerationId: "workspace-generation-two",
      state: "recovering",
      recoveryMessage: "Restored from checkpoint 01",
    });
    expect(sessionMember).toMatchObject({
      provisionState: "provisioning",
      provisionError: null,
    });

    const oldHeartbeat = await hostHeartbeat(fixture.hostId);
    await sleep(2);
    sendBridge(
      currentConnection.ws,
      workshopVmReport({
        hostId: fixture.hostId,
        executionId: fixture.executionId,
        runtimeVmName: fixture.runtimeVmName,
        observedAt: now + 300,
        probes: [probe("workspace-ready", "pass", now + 300)],
      }),
    );
    await waitUntil(
      async () => (await hostHeartbeat(fixture.hostId)) > oldHeartbeat,
    );
    expect(
      await fixture.db
        .select()
        .from(runtimeVmActualState)
        .where(eq(runtimeVmActualState.executionId, fixture.executionId)),
    ).toEqual([]);

    const wrongHostId = "host-generation-wrong";
    await seedHost(wrongHostId);
    const wrongConnection = await connectHost(wrongHostId);
    await waitForBridgeMessage(
      wrongConnection.messages,
      (message) => message.type === "server_hello",
    );
    const wrongHostHeartbeat = await hostHeartbeat(wrongHostId);
    await sleep(2);
    sendBridge(
      wrongConnection.ws,
      workshopVmReport({
        hostId: wrongHostId,
        executionId: recovered.executionId,
        runtimeVmName: recovered.vms[0]!.runtimeVmName,
        observedAt: now + 400,
        probes: [probe("workspace-ready", "pass", now + 400)],
      }),
    );
    await waitUntil(
      async () => (await hostHeartbeat(wrongHostId)) > wrongHostHeartbeat,
    );
    expect(
      await fixture.db
        .select()
        .from(runtimeVmActualState)
        .where(eq(runtimeVmActualState.executionId, recovered.executionId)),
    ).toEqual([]);
    const [workspaceAfterWrongHost] = await fixture.db
      .select()
      .from(workshopWorkspaces)
      .where(eq(workshopWorkspaces.id, fixture.workspaceId));
    expect(workspaceAfterWrongHost).toMatchObject({
      currentGenerationId: "workspace-generation-two",
      state: "recovering",
    });

    currentConnection.ws.close();
    wrongConnection.ws.close();
  });

  it("mirrors scenario VM actual and terminal state without changing scenario projection", async () => {
    const hostId = "host-scenario-runtime-mirror";
    const runId = "scenario-runtime-mirror";
    const runtimeVmName = "runtime-web";
    const now = Date.now();
    await seedHost(hostId);
    const { messages, ws } = await connectHost(hostId);
    await waitForBridgeMessage(
      messages,
      (message) => message.type === "server_hello",
    );
    const db = drizzle(env.DB);
    await seedRun({ db, hostId, runId, runtimeVmName, now });
    await db.insert(runtimeVms).values({
      id: "scenario-runtime-vm",
      executionId: runId,
      vmId: "vm-1",
      ordinal: 0,
      runtimeVmName,
      imageKeyJson: { scenario: "broken-nginx", vm: "webserver" },
      imageSha256: "2".repeat(64),
      cpuMillis: 1_000,
      memoryMib: 512,
      diskMib: 4_096,
      createdAt: now,
      updatedAt: now,
    });
    await ensureRuntimeVmAccessKeys({
      executionId: runId,
      expectedGeneration: 1,
      now,
    });

    sendBridge(
      ws,
      vmReport(
        hostId,
        runId,
        runtimeVmName,
        "ready",
        now + 100,
        22022,
        "10.77.0.2",
      ),
    );
    await Promise.all([
      waitForRunState(
        db,
        runId,
        (state) =>
          state.phase === "active_full" &&
          state.vms[0]?.runtimeObservedAt === now + 100,
      ),
      waitUntil(async () => {
        const rows = await db
          .select()
          .from(runtimeVmActualState)
          .where(eq(runtimeVmActualState.executionId, runId));
        return rows[0]?.phase === "ready";
      }),
    ]);

    const [[actual], [runtimeVm]] = await Promise.all([
      db
        .select()
        .from(runtimeVmActualState)
        .where(eq(runtimeVmActualState.executionId, runId)),
      db.select().from(runtimeVms).where(eq(runtimeVms.executionId, runId)),
    ]);
    expect(actual).toMatchObject({
      hostId,
      phase: "ready",
      observedAt: now + 100,
    });
    expect(runtimeVm).toMatchObject({
      terminalHost: "203.0.113.9",
      terminalPort: 22022,
      terminalUsername: "ubuntu",
      terminalObservedAt: now + 100,
    });

    ws.close();
  });
});

type WorkshopRuntimeFixture = {
  db: ReturnType<typeof drizzle>;
  hostId: string;
  executionId: string;
  runtimeVmName: string;
  sessionId: string;
  memberId: string;
  workspaceId: string;
  generationId: string;
};

async function seedWorkshopRuntime(input: {
  hostId: string;
  executionId: string;
  now: number;
}): Promise<WorkshopRuntimeFixture> {
  await seedHost(input.hostId);
  const db = drizzle(env.DB);
  await db.insert(organization).values({
    id: "workshop-organization",
    name: "Workshop Organization",
    slug: "workshop-organization",
    createdAt: new Date(input.now),
  });
  await db.insert(member).values({
    id: "workshop-organization-member",
    organizationId: "workshop-organization",
    userId: "user-1",
    role: "member",
    createdAt: new Date(input.now),
  });
  await db.insert(workshopTemplates).values({
    id: "workshop-template",
    organizationId: "workshop-organization",
    slug: "platform-engineering",
    title: "Platform Engineering",
    summary: "A workshop",
    currentRevisionId: "workshop-revision",
    createdBy: "user-1",
    createdAt: input.now,
    updatedAt: input.now,
  });
  await db.insert(workshopTemplateRevisions).values({
    id: "workshop-revision",
    templateId: "workshop-template",
    revision: 1,
    sourceRevision: "source-revision",
    contentHash: "a".repeat(64),
    manifestJson: workshopManifest,
    publishedBy: "user-1",
    publishedAt: input.now,
  });
  await db.insert(workshopSessions).values({
    id: "workshop-session",
    organizationId: "workshop-organization",
    templateRevisionId: "workshop-revision",
    title: "Platform Engineering live",
    state: "live",
    scheduledStartAt: input.now,
    lobbyOpensAt: input.now - 30 * 60_000,
    currentModuleId: "00-setup",
    currentSlideId: "slide-opening",
    releasedModuleIdsJson: ["00-setup", "01-service"],
    createdBy: "user-1",
    startedAt: input.now,
    createdAt: input.now,
    updatedAt: input.now,
  });
  await db.insert(workshopSessionMembers).values({
    id: "workshop-session-member",
    sessionId: "workshop-session",
    userId: "user-1",
    role: "participant",
    workspaceEnabled: true,
    checkedInAt: input.now,
    provisionState: "provisioning",
    assignedBy: "user-1",
    createdAt: input.now,
    updatedAt: input.now,
  });
  await db.insert(workshopWorkspaces).values({
    id: "workshop-workspace",
    sessionId: "workshop-session",
    userId: "user-1",
    state: "provisioning",
    lastCheckpointId: "checkpoint-00",
    terminalRouteUsernamesJson: [],
    applicationRouteIdsJson: [],
    createdAt: input.now,
    updatedAt: input.now,
  });

  await db.insert(workshopWorkspaceGenerations).values({
    id: "workspace-generation-one",
    workspaceId: "workshop-workspace",
    ordinal: 1,
    checkpointId: "checkpoint-00",
    hostId: input.hostId,
    state: "provisioning",
    requestedAt: input.now,
    provisioningStartedAt: input.now,
    createdAt: input.now,
    updatedAt: input.now,
  });
  await db
    .update(workshopWorkspaces)
    .set({ currentGenerationId: "workspace-generation-one" })
    .where(eq(workshopWorkspaces.id, "workshop-workspace"));

  const runtimeVm = runtimeVmSpec(input.executionId);
  await createRuntimeExecution({
    executionId: input.executionId,
    userId: "user-1",
    organizationId: "workshop-organization",
    hostId: input.hostId,
    domainKind: "workshop",
    domainId: "workshop-workspace",
    checkpointId: "checkpoint-00",
    leaseExpiresAt: input.now + 5 * 60 * 60_000,
    vms: [runtimeVm],
    claimActiveSlot: true,
    reservationState: "pending",
    now: input.now,
  });
  await ensureRuntimeVmAccessKeys({
    executionId: input.executionId,
    expectedGeneration: 1,
    now: input.now,
  });
  await db
    .update(workshopWorkspaceGenerations)
    .set({ runtimeExecutionId: input.executionId })
    .where(eq(workshopWorkspaceGenerations.id, "workspace-generation-one"));

  return {
    db,
    hostId: input.hostId,
    executionId: input.executionId,
    runtimeVmName: runtimeVm.runtimeVmName,
    sessionId: "workshop-session",
    memberId: "workshop-session-member",
    workspaceId: "workshop-workspace",
    generationId: "workspace-generation-one",
  };
}

function runtimeVmSpec(executionId: string): RuntimeVmSpec {
  return {
    vmId: "workspace",
    ordinal: 0,
    runtimeVmName: `${executionId}-workspace`,
    imageKey: { workshop: "platform-engineering", checkpoint: "checkpoint-00" },
    imageSha256: "b".repeat(64),
    cpuMillis: 4_000,
    memoryMib: 16_384,
    diskMib: 102_400,
  };
}

function probe(
  id: string,
  status: VmProbeSnapshotV1["status"],
  observedAt: number,
): VmProbeSnapshotV1 {
  return {
    id,
    phase: "scenario",
    status,
    checked_at_unix_ms: observedAt,
  };
}

function workshopVmReport(input: {
  hostId: string;
  executionId: string;
  runtimeVmName: string;
  observedAt: number;
  probes: VmProbeSnapshotV1[];
}): BridgeMessageV6 {
  const message = vmReport(
    input.hostId,
    input.executionId,
    input.runtimeVmName,
    "ready",
    input.observedAt,
    2222,
    "10.77.0.2",
  );
  if (message.type !== "vm_report") {
    throw new Error("vmReport fixture returned an unexpected message");
  }
  return {
    ...message,
    report: { ...message.report, probes: input.probes },
  };
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 1_500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await predicate()) return;
    await sleep(10);
  }
  throw new Error("timed out waiting for runtime projection");
}

async function hostHeartbeat(hostId: string): Promise<number> {
  const db = drizzle(env.DB);
  const [row] = await db
    .select({ lastHeartbeatAt: agentHosts.lastHeartbeatAt })
    .from(agentHosts)
    .where(eq(agentHosts.id, hostId));
  return row?.lastHeartbeatAt ?? -1;
}

const workshopManifest = {
  schemaVersion: 2,
  workshop: {
    slug: "platform-engineering",
    title: "Platform Engineering",
    summary: "A workshop",
    prerequisites: [],
    attribution: {
      title: "Test fixture",
      url: "https://example.test/workshop",
      license: "Apache-2.0",
    },
    defaultLobbyMinutes: 30,
  },
  workspace: {
    leaseGraceMinutes: 60,
    vms: [
      {
        id: "workspace",
        name: "Workspace",
        cpuMillis: 4_000,
        memoryMib: 16_384,
        diskMib: 102_400,
      },
    ],
    runtimeProfiles: [
      {
        id: "agent-x86",
        provider: "agent_kvm",
        vmId: "workspace",
        requestedSystemImage: "platform-engineering",
        immutableSystemImage: "platform-engineering",
        locations: [],
        hardware: {
          architecture: "x86_64",
          cpuMillis: 4_000,
          providerCpuCount: 4,
          memoryMib: 16_384,
          diskMib: 102_400,
        },
      },
    ],
    checkpoints: [
      {
        id: "checkpoint-00",
        label: "Initial",
        vmImages: [
          {
            vmId: "workspace",
            imageKey: {
              scenario: "platform-engineering-checkpoint-00",
              vm: "workspace",
              arch: "x86_64",
            },
            imageSha256: "b".repeat(64),
          },
        ],
      },
      {
        id: "checkpoint-01",
        label: "Service",
        vmImages: [
          {
            vmId: "workspace",
            imageKey: {
              scenario: "platform-engineering-checkpoint-01",
              vm: "workspace",
              arch: "x86_64",
            },
            imageSha256: "c".repeat(64),
          },
        ],
      },
    ],
    initialCheckpointId: "checkpoint-00",
    applications: [],
  },
  modules: [
    {
      id: "00-setup",
      title: "Setup",
      tier: "gate",
      outcome: "The workspace is ready",
      dependsOn: [],
      participantMarkdown: "Prepare the workspace.",
      facilitatorNotesMarkdown: "Observe setup.",
      hints: [],
      solutionMarkdown: "Run the verifier.",
      probeIds: ["workspace-ready"],
      catchUpCheckpointId: "checkpoint-00",
    },
    {
      id: "01-service",
      title: "Service",
      tier: "core",
      outcome: "The service is ready",
      dependsOn: ["00-setup"],
      participantMarkdown: "Build the service.",
      facilitatorNotesMarkdown: "Observe service health.",
      hints: [],
      solutionMarkdown: "Run the verifier.",
      probeIds: ["service-ready"],
      catchUpCheckpointId: "checkpoint-01",
    },
  ],
  agenda: [
    {
      id: "opening",
      kind: "briefing",
      title: "Opening",
      durationMinutes: 15,
      scheduled: true,
      slideIds: ["slide-opening"],
      release: "automatic",
    },
  ],
  presentation: {
    slides: [
      {
        id: "slide-opening",
        layout: "title",
        title: "Opening",
        bodyMarkdown: "Welcome",
      },
    ],
  },
  durationMinutes: 15,
} satisfies WorkshopManifestV2;
