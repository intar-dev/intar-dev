/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import {
  activeRuntimeSlots,
  agentHosts,
  hostResourceReservations,
  organization,
  runtimeExecutions,
  runtimeVms,
  scenarioRuns,
  user,
  workshopSessionMembers,
  workshopSessions,
  workshopTemplateRevisions,
  workshopTemplates,
  workshopWorkspaceGenerations,
  workshopWorkspaces,
  type WorkshopManifestV2,
} from "@/db/schema";
import { errorChainMatches } from "@/lib/app-error";
import {
  archiveRuntimeExecution,
  createRuntimeExecution,
  createRuntimeRecoveryGeneration,
  loadCurrentRuntimeVmTerminalTarget,
  recordRuntimeVmTerminalTarget,
  updateRuntimeExecutionState,
  type RuntimeVmSpec,
} from "@/lib/runtime-executions";
import { resetD1Database } from "@/test/d1-migrations";

describe("domain-neutral runtime executions", () => {
  beforeEach(async () => {
    await resetD1Database();
    await seedRuntimeOwner();
  });

  it("enforces one active slot across workshop and scenario domains", async () => {
    const db = drizzle(env.DB);
    const workshop = await createRuntimeExecution({
      executionId: "workshop-execution",
      userId: "learner",
      organizationId: "academy",
      hostId: "runtime-host",
      domainKind: "workshop",
      domainId: "workspace-a",
      checkpointId: "checkpoint-00",
      vms: [runtimeVm()],
      claimActiveSlot: true,
      now: 1_000,
    });

    let scenarioConflict: unknown;
    try {
      await db.insert(scenarioRuns).values(scenarioRun("scenario-run-a"));
    } catch (error) {
      scenarioConflict = error;
    }
    expect(
      errorChainMatches(scenarioConflict, /scenario_runs\.active_key/),
    ).toBe(true);

    await archiveRuntimeExecution({
      executionId: workshop.executionId,
      expectedGeneration: 1,
      endedAt: 2_000,
    });
    await db.insert(scenarioRuns).values(scenarioRun("scenario-run-a"));

    const [scenarioExecution, slots] = await Promise.all([
      db
        .select({
          executionId: scenarioRuns.runtimeExecutionId,
          activeKey: scenarioRuns.activeKey,
        })
        .from(scenarioRuns)
        .where(eq(scenarioRuns.runId, "scenario-run-a")),
      db.select().from(activeRuntimeSlots),
    ]);
    expect(scenarioExecution).toEqual([
      { executionId: "scenario-run-a", activeKey: "learner" },
    ]);
    expect(slots).toEqual([
      {
        userId: "learner",
        executionId: "scenario-run-a",
        acquiredAt: 3_000,
      },
    ]);

    await expect(
      createRuntimeExecution({
        executionId: "workshop-execution-b",
        userId: "learner",
        organizationId: "academy",
        hostId: "runtime-host",
        domainKind: "workshop",
        domainId: "workspace-b",
        checkpointId: "checkpoint-00",
        vms: [runtimeVm()],
        claimActiveSlot: true,
        now: 4_000,
      }),
    ).rejects.toMatchObject({ code: "runtime_active_slot_conflict" });

    await db
      .update(scenarioRuns)
      .set({
        state: "completed",
        stateRank: 8,
        activeKey: null,
        completedAt: 5_000,
        updatedAt: 5_000,
      })
      .where(eq(scenarioRuns.runId, "scenario-run-a"));
    const [scenarioRuntime, releasedSlots] = await Promise.all([
      db
        .select({
          state: runtimeExecutions.state,
          endedAt: runtimeExecutions.endedAt,
        })
        .from(runtimeExecutions)
        .where(eq(runtimeExecutions.id, "scenario-run-a")),
      db.select().from(activeRuntimeSlots),
    ]);
    expect(scenarioRuntime).toEqual([{ state: "archived", endedAt: 5_000 }]);
    expect(releasedSlots).toEqual([]);
  });

  it("records a conservative admission reservation without changing VM entitlements", async () => {
    const db = drizzle(env.DB);
    const execution = await createRuntimeExecution({
      executionId: "scenario-boot-reservation",
      userId: "learner",
      organizationId: "academy",
      hostId: "runtime-host",
      domainKind: "scenario",
      domainId: "scenario-boot-reservation",
      vms: [runtimeVm({ cpuMillis: 500, memoryMib: 1_024, diskMib: 8_192 })],
      reservationState: "pending",
      reservationExpiresAt: 61_000,
      reservationResources: {
        cpuMillis: 2_000,
        memoryMib: 1_024,
        worstCaseDiskMib: 8_192,
      },
      now: 1_000,
    });

    expect(execution.resources).toEqual({
      cpuMillis: 500,
      memoryMib: 1_024,
      worstCaseDiskMib: 8_192,
    });
    await expect(db.select().from(hostResourceReservations)).resolves.toEqual([
      expect.objectContaining({
        executionId: "scenario-boot-reservation",
        cpuMillis: 2_000,
        memoryMib: 1_024,
        worstCaseDiskMib: 8_192,
        state: "pending",
      }),
    ]);

    await expect(
      createRuntimeExecution({
        executionId: "undersized-reservation",
        userId: "learner",
        organizationId: "academy",
        hostId: "runtime-host",
        domainKind: "scenario",
        domainId: "undersized-reservation",
        vms: [runtimeVm()],
        reservationResources: {
          cpuMillis: 999,
          memoryMib: 1_024,
          worstCaseDiskMib: 8_192,
        },
        now: 2_000,
      }),
    ).rejects.toMatchObject({ code: "runtime_execution_invalid" });
  });

  it("creates generation-one executions and slots for clean-schema scenario runs", async () => {
    await resetD1Database();
    await seedRuntimeOwner(false);
    const db = drizzle(env.DB);
    await env.DB.batch([
      legacyScenarioRunInsert({
        runId: "active-scenario",
        state: "queued",
        stateRank: 0,
        activeKey: "learner",
        completedAt: null,
      }),
      legacyScenarioRunInsert({
        runId: "archived-scenario",
        state: "completed",
        stateRank: 8,
        activeKey: null,
        completedAt: 4_000,
      }),
    ]);

    const [runs, executions, slots] = await Promise.all([
      db
        .select({
          runId: scenarioRuns.runId,
          runtimeExecutionId: scenarioRuns.runtimeExecutionId,
        })
        .from(scenarioRuns)
        .orderBy(asc(scenarioRuns.runId)),
      db
        .select({
          id: runtimeExecutions.id,
          domainKind: runtimeExecutions.domainKind,
          domainId: runtimeExecutions.domainId,
          generation: runtimeExecutions.generation,
          state: runtimeExecutions.state,
        })
        .from(runtimeExecutions)
        .orderBy(asc(runtimeExecutions.id)),
      db.select().from(activeRuntimeSlots),
    ]);
    expect(runs).toEqual([
      { runId: "active-scenario", runtimeExecutionId: "active-scenario" },
      {
        runId: "archived-scenario",
        runtimeExecutionId: "archived-scenario",
      },
    ]);
    expect(executions).toEqual([
      {
        id: "active-scenario",
        domainKind: "scenario",
        domainId: "active-scenario",
        generation: 1,
        state: "queued",
      },
      {
        id: "archived-scenario",
        domainKind: "scenario",
        domainId: "archived-scenario",
        generation: 1,
        state: "archived",
      },
    ]);
    expect(slots).toEqual([
      {
        userId: "learner",
        executionId: "active-scenario",
        acquiredAt: 3_000,
      },
    ]);
  });

  it("creates a recovery generation without changing domain identity", async () => {
    const db = drizzle(env.DB);
    const original = await createRuntimeExecution({
      executionId: "execution-generation-1",
      userId: "learner",
      organizationId: "academy",
      hostId: "runtime-host",
      domainKind: "workshop",
      domainId: "workspace-a",
      checkpointId: "checkpoint-00",
      leaseExpiresAt: 50_000,
      vms: [runtimeVm()],
      claimActiveSlot: true,
      reservationState: "committed",
      now: 1_000,
    });
    await recordRuntimeVmTerminalTarget({
      executionId: original.executionId,
      expectedGeneration: 1,
      vmId: "workspace",
      target: terminalTarget(),
      observedAt: 1_500,
    });

    const recovered = await createRuntimeRecoveryGeneration({
      sourceExecutionId: original.executionId,
      expectedGeneration: 1,
      executionId: "execution-generation-2",
      checkpointId: "checkpoint-05",
      leaseExpiresAt: 80_000,
      vms: [
        runtimeVm({
          imageKey: { workshop: "platform", checkpoint: "checkpoint-05" },
          imageSha256: "b".repeat(64),
          cpuMillis: 2_000,
          memoryMib: 2_048,
          diskMib: 16_384,
        }),
      ],
      reservationState: "committed",
      now: 2_000,
    });

    const [executions, slots, reservations, vms] = await Promise.all([
      db
        .select()
        .from(runtimeExecutions)
        .orderBy(asc(runtimeExecutions.generation)),
      db.select().from(activeRuntimeSlots),
      db
        .select()
        .from(hostResourceReservations)
        .orderBy(asc(hostResourceReservations.createdAt)),
      db.select().from(runtimeVms).orderBy(asc(runtimeVms.createdAt)),
    ]);

    expect(recovered).toMatchObject({
      executionId: "execution-generation-2",
      generation: 2,
      sourceExecutionId: "execution-generation-1",
      domainKind: "workshop",
      domainId: "workspace-a",
      userId: "learner",
      organizationId: "academy",
      hostId: "runtime-host",
      checkpointId: "checkpoint-05",
      resources: {
        cpuMillis: 2_000,
        memoryMib: 2_048,
        worstCaseDiskMib: 16_384,
      },
    });
    expect(
      executions.map((execution) => ({
        id: execution.id,
        domainKind: execution.domainKind,
        domainId: execution.domainId,
        generation: execution.generation,
        sourceExecutionId: execution.sourceExecutionId,
        state: execution.state,
      })),
    ).toEqual([
      {
        id: "execution-generation-1",
        domainKind: "workshop",
        domainId: "workspace-a",
        generation: 1,
        sourceExecutionId: null,
        state: "archived",
      },
      {
        id: "execution-generation-2",
        domainKind: "workshop",
        domainId: "workspace-a",
        generation: 2,
        sourceExecutionId: "execution-generation-1",
        state: "queued",
      },
    ]);
    expect(slots).toEqual([
      {
        userId: "learner",
        executionId: "execution-generation-2",
        acquiredAt: 2_000,
      },
    ]);
    expect(
      reservations.map((reservation) => ({
        executionId: reservation.executionId,
        state: reservation.state,
        cpuMillis: reservation.cpuMillis,
        memoryMib: reservation.memoryMib,
        worstCaseDiskMib: reservation.worstCaseDiskMib,
      })),
    ).toEqual([
      {
        executionId: "execution-generation-1",
        state: "released",
        cpuMillis: 1_000,
        memoryMib: 1_024,
        worstCaseDiskMib: 8_192,
      },
      {
        executionId: "execution-generation-2",
        state: "committed",
        cpuMillis: 2_000,
        memoryMib: 2_048,
        worstCaseDiskMib: 16_384,
      },
    ]);
    expect(vms.map((vm) => [vm.executionId, vm.imageSha256])).toEqual([
      ["execution-generation-1", "a".repeat(64)],
      ["execution-generation-2", "b".repeat(64)],
    ]);
  });

  it("reclaims the active slot when recovering an archived current generation", async () => {
    const original = await createRuntimeExecution({
      executionId: "archived-generation-1",
      userId: "learner",
      organizationId: "academy",
      hostId: "runtime-host",
      domainKind: "workshop",
      domainId: "workspace-archived",
      checkpointId: "checkpoint-00",
      vms: [runtimeVm()],
      claimActiveSlot: true,
      now: 1_000,
    });
    await archiveRuntimeExecution({
      executionId: original.executionId,
      expectedGeneration: 1,
      endedAt: 2_000,
    });
    const db = drizzle(env.DB);
    expect(await db.select().from(activeRuntimeSlots)).toEqual([]);

    const recovered = await createRuntimeRecoveryGeneration({
      sourceExecutionId: original.executionId,
      expectedGeneration: 1,
      executionId: "archived-generation-2",
      checkpointId: "checkpoint-01",
      vms: [runtimeVm()],
      now: 3_000,
    });

    expect(recovered.generation).toBe(2);
    expect(await db.select().from(activeRuntimeSlots)).toEqual([
      {
        userId: "learner",
        executionId: "archived-generation-2",
        acquiredAt: 3_000,
      },
    ]);
  });

  it("does not recover an archived generation over another active domain", async () => {
    const original = await createRuntimeExecution({
      executionId: "blocked-generation-1",
      userId: "learner",
      organizationId: "academy",
      hostId: "runtime-host",
      domainKind: "workshop",
      domainId: "workspace-blocked",
      checkpointId: "checkpoint-00",
      vms: [runtimeVm()],
      claimActiveSlot: true,
      now: 1_000,
    });
    await archiveRuntimeExecution({
      executionId: original.executionId,
      expectedGeneration: 1,
      endedAt: 2_000,
    });
    await createRuntimeExecution({
      executionId: "other-active-domain",
      userId: "learner",
      organizationId: "academy",
      hostId: "runtime-host",
      domainKind: "scenario",
      domainId: "other-scenario",
      vms: [runtimeVm()],
      claimActiveSlot: true,
      now: 3_000,
    });

    await expect(
      createRuntimeRecoveryGeneration({
        sourceExecutionId: original.executionId,
        expectedGeneration: 1,
        executionId: "blocked-generation-2",
        checkpointId: "checkpoint-01",
        vms: [runtimeVm()],
        now: 4_000,
      }),
    ).rejects.toMatchObject({ code: "runtime_active_slot_conflict" });

    const db = drizzle(env.DB);
    expect(
      await db
        .select({ id: runtimeExecutions.id })
        .from(runtimeExecutions)
        .where(eq(runtimeExecutions.domainId, "workspace-blocked"))
        .orderBy(asc(runtimeExecutions.generation)),
    ).toEqual([{ id: "blocked-generation-1" }]);
    expect(await db.select().from(activeRuntimeSlots)).toEqual([
      {
        userId: "learner",
        executionId: "other-active-domain",
        acquiredAt: 3_000,
      },
    ]);
  });

  it("rejects stale reports and mutations after recovery", async () => {
    const original = await createRuntimeExecution({
      executionId: "execution-generation-1",
      userId: "learner",
      organizationId: "academy",
      hostId: "runtime-host",
      domainKind: "workshop",
      domainId: "workspace-a",
      checkpointId: "checkpoint-00",
      vms: [runtimeVm()],
      claimActiveSlot: true,
      now: 1_000,
    });
    const recovered = await createRuntimeRecoveryGeneration({
      sourceExecutionId: original.executionId,
      expectedGeneration: 1,
      executionId: "execution-generation-2",
      checkpointId: "checkpoint-05",
      vms: [runtimeVm()],
      now: 2_000,
    });

    await expect(
      updateRuntimeExecutionState({
        executionId: original.executionId,
        expectedGeneration: 1,
        state: "ready",
        observedAt: 3_000,
      }),
    ).rejects.toMatchObject({ code: "runtime_generation_stale" });
    await expect(
      recordRuntimeVmTerminalTarget({
        executionId: original.executionId,
        expectedGeneration: 1,
        vmId: "workspace",
        target: terminalTarget(),
        observedAt: 3_000,
      }),
    ).rejects.toMatchObject({ code: "runtime_generation_stale" });
    await expect(
      archiveRuntimeExecution({
        executionId: original.executionId,
        expectedGeneration: 1,
        endedAt: 3_000,
      }),
    ).rejects.toMatchObject({ code: "runtime_generation_stale" });

    await recordRuntimeVmTerminalTarget({
      executionId: recovered.executionId,
      expectedGeneration: 2,
      vmId: "workspace",
      target: terminalTarget(),
      observedAt: 3_100,
    });
    await expect(
      loadCurrentRuntimeVmTerminalTarget({
        executionId: recovered.executionId,
        expectedGeneration: 2,
      }),
    ).resolves.toMatchObject({
      executionId: "execution-generation-2",
      generation: 2,
      domainKind: "workshop",
      domainId: "workspace-a",
      vmId: "workspace",
      target: {
        host: "192.0.2.10",
        port: 22,
        username: "ubuntu",
        hostKeyOpenssh: "ssh-ed25519 host-key",
        privateKeyOpenssh: "private-key",
        observedAt: 3_100,
      },
    });
  });

  it("keeps an archived current generation terminal", async () => {
    const execution = await createRuntimeExecution({
      executionId: "terminal-generation",
      userId: "learner",
      organizationId: "academy",
      hostId: "runtime-host",
      domainKind: "workshop",
      domainId: "terminal-workspace",
      checkpointId: "checkpoint-00",
      vms: [runtimeVm()],
      claimActiveSlot: true,
      now: 1_000,
    });
    await archiveRuntimeExecution({
      executionId: execution.executionId,
      expectedGeneration: 1,
      endedAt: 2_000,
    });

    await expect(
      updateRuntimeExecutionState({
        executionId: execution.executionId,
        expectedGeneration: 1,
        state: "ready",
        observedAt: 3_000,
      }),
    ).rejects.toMatchObject({ code: "runtime_generation_stale" });
    await expect(
      recordRuntimeVmTerminalTarget({
        executionId: execution.executionId,
        expectedGeneration: 1,
        vmId: "workspace",
        target: terminalTarget(),
        observedAt: 3_000,
      }),
    ).rejects.toMatchObject({ code: "runtime_generation_stale" });
  });
});

async function seedRuntimeOwner(seedWorkshopDomains = true) {
  const db = drizzle(env.DB);
  const createdAt = new Date(1_000);
  await db.insert(user).values({
    id: "learner",
    name: "Learner",
    email: "learner@example.com",
    emailVerified: true,
    createdAt: new Date(1_000),
    updatedAt: new Date(1_000),
  });
  await db.insert(organization).values({
    id: "academy",
    name: "Academy",
    slug: "academy",
    createdAt: new Date(1_000),
  });
  await env.DB.prepare(
    `INSERT INTO member (id, organization_id, user_id, role, created_at)
     VALUES ('academy-learner', 'academy', 'learner', 'member', ?)`,
  )
    .bind(createdAt.getTime())
    .run();
  if (seedWorkshopDomains) {
    await db.insert(workshopTemplates).values({
    id: "runtime-workshop-template",
    organizationId: "academy",
    slug: "runtime-workshop",
    title: "Runtime workshop",
    summary: "Runtime execution test fixture",
    createdBy: "learner",
    createdAt: 1_000,
    updatedAt: 1_000,
  });
  await db.insert(workshopTemplateRevisions).values({
    id: "runtime-workshop-revision",
    templateId: "runtime-workshop-template",
    revision: 1,
    sourceRevision: "test",
    contentHash: "a".repeat(64),
    manifestJson: runtimeWorkshopManifest(),
    publishedBy: "learner",
    publishedAt: 1_000,
  });
  const workspaceIds = [
    "workspace-a",
    "workspace-b",
    "workspace-archived",
    "workspace-blocked",
    "terminal-workspace",
  ];
  await db.insert(workshopSessions).values(
    workspaceIds.map((workspaceId) => ({
      id: `session-${workspaceId}`,
      organizationId: "academy",
      templateRevisionId: "runtime-workshop-revision",
      title: workspaceId,
      state: "live" as const,
      version: 1,
      scheduledStartAt: 1_000,
      lobbyOpensAt: 1_000,
      createdBy: "learner",
      startedAt: 1_000,
      createdAt: 1_000,
      updatedAt: 1_000,
    })),
  );
  await db.insert(workshopSessionMembers).values(
    workspaceIds.map((workspaceId) => ({
      id: `roster-${workspaceId}`,
      sessionId: `session-${workspaceId}`,
      userId: "learner",
      role: "participant" as const,
      assignedBy: "learner",
      createdAt: 1_000,
      updatedAt: 1_000,
    })),
  );
    await db.insert(workshopWorkspaces).values(
      workspaceIds.map((workspaceId) => ({
        id: workspaceId,
        sessionId: `session-${workspaceId}`,
        userId: "learner",
        state: "queued" as const,
        createdAt: 1_000,
        updatedAt: 1_000,
      })),
    );
    for (const workspaceId of workspaceIds) {
      const generationId = `generation-${workspaceId}`;
      await db.insert(workshopWorkspaceGenerations).values({
        id: generationId,
        workspaceId,
        ordinal: 1,
        checkpointId: "checkpoint-00",
        state: "queued",
        requestedAt: 1_000,
        createdAt: 1_000,
        updatedAt: 1_000,
      });
      await db
        .update(workshopWorkspaces)
        .set({ currentGenerationId: generationId })
        .where(eq(workshopWorkspaces.id, workspaceId));
    }
  }
  await db.insert(agentHosts).values({
    id: "runtime-host",
    userId: "learner",
    organizationId: "academy",
    name: "Runtime host",
    role: "agent",
    createdAt: 1_000,
    updatedAt: 1_000,
  });
}

function runtimeWorkshopManifest(): WorkshopManifestV2 {
  return {
    schemaVersion: 2,
    workshop: {
      slug: "runtime-workshop",
      title: "Runtime workshop",
      summary: "Runtime execution test fixture",
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
      vms: [],
      runtimeProfiles: [],
      checkpoints: [],
      initialCheckpointId: "checkpoint-00",
      applications: [],
    },
    modules: [],
    agenda: [],
    presentation: { slides: [] },
    durationMinutes: 0,
  };
}

function runtimeVm(overrides: Partial<RuntimeVmSpec> = {}): RuntimeVmSpec {
  return {
    vmId: "workspace",
    ordinal: 0,
    runtimeVmName: "workshop-workspace",
    imageKey: { workshop: "platform", checkpoint: "checkpoint-00" },
    imageSha256: "a".repeat(64),
    cpuMillis: 1_000,
    memoryMib: 1_024,
    diskMib: 8_192,
    ...overrides,
  };
}

function terminalTarget() {
  return {
    host: "192.0.2.10",
    port: 22,
    username: "ubuntu",
    hostKeyOpenssh: "ssh-ed25519 host-key",
    privateKeyOpenssh: "private-key",
  };
}

function scenarioRun(
  runId: string,
  overrides: Partial<typeof scenarioRuns.$inferInsert> = {},
): typeof scenarioRuns.$inferInsert {
  return {
    runId,
    userId: "learner",
    organizationId: "academy",
    hostId: "runtime-host",
    scenarioId: "scenario-a",
    scenarioName: "scenario-a",
    title: "Scenario A",
    tagline: "",
    briefingMarkdown: "",
    objectivesJson: "[]",
    difficulty: "easy",
    estimatedMinutes: 10,
    tagsJson: [],
    hintsJson: [],
    solutionMarkdown: "",
    vmCount: 1,
    state: "queued",
    stateRank: 0,
    activeKey: "learner",
    stateJson: "{}",
    createdAt: 3_000,
    updatedAt: 3_000,
    ...overrides,
  };
}

function legacyScenarioRunInsert(input: {
  runId: string;
  state: string;
  stateRank: number;
  activeKey: string | null;
  completedAt: number | null;
  stateJson?: string;
}) {
  return env.DB.prepare(
    `INSERT INTO scenario_runs (
       run_id, user_id, organization_id, host_id, scenario_id, scenario_name,
       title, tagline, briefing_markdown, objectives_json, difficulty,
       estimated_minutes, tags_json, hints_json, solution_markdown, vm_count,
       state, state_rank, active_key, state_json, completed_at, created_at,
       updated_at
     ) VALUES (?, 'learner', 'academy', 'runtime-host', 'scenario-a',
       'scenario-a', 'Scenario A', '', '', '[]', 'easy', 10, '[]', '[]', '',
       1, ?, ?, ?, ?, ?, 3000, 3000)`,
  ).bind(
    input.runId,
    input.state,
    input.stateRank,
    input.activeKey,
    input.stateJson ?? "{}",
    input.completedAt,
  );
}
