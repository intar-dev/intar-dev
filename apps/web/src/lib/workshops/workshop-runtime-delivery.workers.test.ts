/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";

const cleanupMocks = vi.hoisted(() => ({
  failDesiredStateMutationOnce: false,
  failExecutionStateUpdateOnce: false,
  beforeRuntimeExecutionCreatedOnce: null as (() => Promise<void>) | null,
  afterRuntimeExecutionCreatedOnce: null as (() => Promise<void>) | null,
  beforeDesiredStateMutationOnce: null as (() => Promise<void>) | null,
  deleteStargateRoute: vi.fn(),
  deleteStargateWorkspaceAppRoute: vi.fn(),
}));

vi.mock("@/lib/desired-state-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/desired-state-store")>();
  return {
    ...actual,
    mutateStoredHostDesiredState: vi.fn(
      async (
        ...args: Parameters<typeof actual.mutateStoredHostDesiredState>
      ) => {
        const hook = cleanupMocks.beforeDesiredStateMutationOnce;
        cleanupMocks.beforeDesiredStateMutationOnce = null;
        if (hook) await hook();
        if (cleanupMocks.failDesiredStateMutationOnce) {
          cleanupMocks.failDesiredStateMutationOnce = false;
          throw new Error("injected desired-state cleanup failure");
        }
        return actual.mutateStoredHostDesiredState(...args);
      },
    ),
  };
});

vi.mock("@/lib/runtime-executions", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/runtime-executions")>();
  return {
    ...actual,
    createRuntimeExecution: vi.fn(
      async (...args: Parameters<typeof actual.createRuntimeExecution>) => {
        const beforeHook = cleanupMocks.beforeRuntimeExecutionCreatedOnce;
        cleanupMocks.beforeRuntimeExecutionCreatedOnce = null;
        if (beforeHook) await beforeHook();
        const execution = await actual.createRuntimeExecution(...args);
        const hook = cleanupMocks.afterRuntimeExecutionCreatedOnce;
        cleanupMocks.afterRuntimeExecutionCreatedOnce = null;
        if (hook) await hook();
        return execution;
      },
    ),
    updateRuntimeExecutionState: vi.fn(
      async (
        ...args: Parameters<typeof actual.updateRuntimeExecutionState>
      ) => {
        if (cleanupMocks.failExecutionStateUpdateOnce) {
          cleanupMocks.failExecutionStateUpdateOnce = false;
          throw new Error("injected post-desired-state failure");
        }
        return actual.updateRuntimeExecutionState(...args);
      },
    ),
  };
});

vi.mock("@/lib/stargate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stargate")>()),
  deleteStargateRoute: cleanupMocks.deleteStargateRoute,
  deleteStargateWorkspaceAppRoute: cleanupMocks.deleteStargateWorkspaceAppRoute,
}));
import {
  activeRuntimeSlots,
  agentHosts,
  hostActualState,
  hostDesiredState,
  hostResourceReservations,
  member,
  organization,
  runtimeExecutions,
  runtimeVmAccessKeys,
  runtimeVmActualState,
  user,
  workshopModuleProgress,
  workshopEvents,
  workshopPublications,
  workshopRegistryTokens,
  workshopRuntimeProfileCertifications,
  workshopRuntimeProfiles,
  workshopSessions,
  workshopWorkspaceGenerations,
  workshopWorkspaces,
  type WorkshopManifestV2,
} from "@/db/schema";
import type { HostStateReportV2, VmActualStateV2 } from "@/generated/bridge";
import { WORKSHOP_HOST_FAILURE_RECOVERY_AFTER_MS } from "@/control-plane/host-runtime-do";
import { runNextScheduledAlarm } from "@/control-plane/host-runtime-do/test-fixtures";
import { expireOverdueRuntimeExecutions } from "@/lib/runtime-lease-expiry";
import { removeOrganizationMember } from "@/lib/organizations";
import { loadCurrentRuntimeVmTerminalTarget } from "@/lib/runtime-executions";
import {
  loadActiveRuntimeResourceSnapshot,
  RUNTIME_PENDING_RESOURCE_RESERVATION_TTL_MS,
} from "@/lib/runtime-capacity";
import { recordRuntimeVmActualState } from "@/lib/runtime-vm-state";
import { grantFixtureBetaAccess } from "@/test/beta-access-fixtures";
import { resetD1Database } from "@/test/d1-migrations";
import {
  checkInToWorkshop,
  createWorkshopSession,
  replaceWorkshopRoster,
  updateWorkshopSession,
} from "./sessions";
import { createWorkshopTemplate } from "./templates";
import {
  prepareCheckedInWorkshopWorkspaces,
  prepareWorkshopCheckpointRestore,
  prepareWorkshopLateJoin,
  recordWorkshopGenerationState,
} from "./provisioning";
import { getWorkshopCapacityPreflight } from "./capacity";
import { performWorkshopSessionAction } from "./actions";
import { recordWorkshopModuleObservation } from "./progress";
import {
  provisionWorkshopRequest,
  provisionWorkshopRequests,
  recoverWorkshopRuntimesFromFailedHost,
  teardownWorkshopSessionRuntimes,
} from "./runtime-orchestrator";

describe("workshop runtime delivery", () => {
  beforeEach(async () => {
    cleanupMocks.failDesiredStateMutationOnce = false;
    cleanupMocks.failExecutionStateUpdateOnce = false;
    cleanupMocks.beforeRuntimeExecutionCreatedOnce = null;
    cleanupMocks.afterRuntimeExecutionCreatedOnce = null;
    cleanupMocks.beforeDesiredStateMutationOnce = null;
    cleanupMocks.deleteStargateRoute.mockReset();
    cleanupMocks.deleteStargateWorkspaceAppRoute.mockReset();
    cleanupMocks.deleteStargateRoute.mockResolvedValue(undefined);
    cleanupMocks.deleteStargateWorkspaceAppRoute.mockResolvedValue(undefined);
    await resetD1Database();
    await seedIdentityAndRunner();
  });

  it("preflights all resources and provisions a generation into DesiredVmV2", async () => {
    const fixture = await workshopFixture();
    const capacity = await getWorkshopCapacityPreflight({
      sessionId: fixture.sessionId,
    });
    expect(capacity).toMatchObject({
      seatsTotal: 2,
      seatsAvailable: 2,
      seatsRequired: 1,
      checkedIn: 1,
      provisioned: 0,
      imagesReady: true,
      healthyRunners: 1,
      seatResources: {
        cpuMillis: 4_000,
        memoryMib: 16_384,
        worstCaseDiskMib: 102_400,
      },
    });

    const prepared = await prepareCheckedInWorkshopWorkspaces({
      sessionId: fixture.sessionId,
      actorUserId: "owner",
    });
    const request = prepared.requests[0];
    if (!request) throw new Error("provisioning request missing");
    const execution = await provisionWorkshopRequest(request);
    expect(execution).toMatchObject({
      domainKind: "workshop",
      domainId: request.workspaceId,
      generation: 1,
      hostId: "runner",
      checkpointId: "checkpoint-00",
    });

    const db = drizzle(env.DB);
    const [generation, slots, reservations, keys, desired] = await Promise.all([
      db
        .select({
          state: workshopWorkspaceGenerations.state,
          executionId: workshopWorkspaceGenerations.runtimeExecutionId,
          hostId: workshopWorkspaceGenerations.hostId,
        })
        .from(workshopWorkspaceGenerations)
        .where(eq(workshopWorkspaceGenerations.id, request.generationId)),
      db.select().from(activeRuntimeSlots),
      db.select().from(hostResourceReservations),
      db.select().from(runtimeVmAccessKeys),
      db
        .select()
        .from(hostDesiredState)
        .where(eq(hostDesiredState.hostId, "runner")),
    ]);
    expect(generation).toEqual([
      {
        state: "provisioning",
        executionId: execution.executionId,
        hostId: "runner",
      },
    ]);
    expect(slots).toEqual([
      expect.objectContaining({
        userId: "learner",
        executionId: execution.executionId,
      }),
    ]);
    expect(reservations).toEqual([
      expect.objectContaining({
        executionId: execution.executionId,
        cpuMillis: 4_000,
        memoryMib: 16_384,
        worstCaseDiskMib: 102_400,
        state: "committed",
        expiresAt: null,
      }),
    ]);
    expect(keys).toHaveLength(1);
    expect(keys[0]?.publicKeyOpenssh).toMatch(/^ssh-ed25519 /);
    expect(desired[0]?.docJson.cached_images).toEqual([
      {
        image_key: checkpointImageKey("00"),
        image_sha256: "a".repeat(64),
      },
    ]);
    expect(desired[0]?.docJson.vms).toEqual([
      expect.objectContaining({
        run_id: execution.executionId,
        desired_phase: "running",
        image_key: checkpointImageKey("00"),
        resources: {
          cpu_millis: 4_000,
          vcpu_count: 4,
          memory_mib: 16_384,
          disk_mib: 102_400,
        },
      }),
    ]);
  });

  it("keeps durable desired VMs reserved without a first host report", async () => {
    const fixture = await workshopFixture();
    const prepared = await prepareCheckedInWorkshopWorkspaces({
      sessionId: fixture.sessionId,
      actorUserId: "owner",
    });
    const request = prepared.requests[0];
    if (!request) throw new Error("provisioning request missing");
    const execution = await provisionWorkshopRequest(request);

    const db = drizzle(env.DB);
    expect(await db.select().from(runtimeVmActualState)).toEqual([]);
    const afterPendingTtl = await loadActiveRuntimeResourceSnapshot(
      Date.now() + RUNTIME_PENDING_RESOURCE_RESERVATION_TTL_MS + 1,
    );
    expect(afterPendingTtl.reservations).toEqual([
      expect.objectContaining({
        execution_id: execution.executionId,
        state: "committed",
        expires_at: null,
        worst_case_disk_mib: 102_400,
      }),
    ]);

    await expect(provisionWorkshopRequest(request)).resolves.toMatchObject({
      executionId: execution.executionId,
      generation: 1,
    });
    expect(await db.select().from(hostResourceReservations)).toHaveLength(1);
  });

  it("expires workshop executions and releases routes, slots, and reservations", async () => {
    const fixture = await workshopFixture();
    const prepared = await prepareCheckedInWorkshopWorkspaces({
      sessionId: fixture.sessionId,
      actorUserId: "owner",
    });
    const request = prepared.requests[0];
    if (!request) throw new Error("provisioning request missing");
    const execution = await provisionWorkshopRequest(request);
    const now = Date.now();
    const db = drizzle(env.DB);
    await Promise.all([
      db
        .update(runtimeExecutions)
        .set({ leaseExpiresAt: now - 1, updatedAt: now })
        .where(eq(runtimeExecutions.id, execution.executionId)),
      db
        .update(workshopWorkspaces)
        .set({
          terminalRouteUsernamesJson: ["expired-terminal-route"],
          applicationRouteIdsJson: ["expired-application-route"],
          updatedAt: now,
        })
        .where(eq(workshopWorkspaces.id, request.workspaceId)),
    ]);

    await expect(
      expireOverdueRuntimeExecutions("runner", now),
    ).resolves.toEqual({
      expiredExecutionIds: [execution.executionId],
      failedExecutionIds: [],
    });
    expect(cleanupMocks.deleteStargateRoute).toHaveBeenCalledWith(
      "expired-terminal-route",
    );
    expect(cleanupMocks.deleteStargateWorkspaceAppRoute).toHaveBeenCalledWith(
      "expired-application-route",
    );
    expect(await runtimeCleanupState(execution.executionId)).toMatchObject({
      workspace: {
        state: "ended",
        terminalRoutes: [],
        applicationRoutes: [],
      },
      generation: { state: "archived" },
      execution: { state: "archived" },
      slots: 0,
      reservationStates: ["released"],
      desiredPhases: ["absent"],
    });
  });

  it("restores by creating a new execution and tears every runtime resource down", async () => {
    const fixture = await workshopFixture();
    const prepared = await prepareCheckedInWorkshopWorkspaces({
      sessionId: fixture.sessionId,
      actorUserId: "owner",
    });
    const initialRequest = prepared.requests[0];
    if (!initialRequest) throw new Error("initial request missing");
    const initial = await provisionWorkshopRequest(initialRequest);

    const restoreRequest = await prepareWorkshopCheckpointRestore({
      sessionId: fixture.sessionId,
      workspaceId: initialRequest.workspaceId,
      checkpointId: "checkpoint-01",
      actorUserId: "learner",
    });
    const recovered = await provisionWorkshopRequest(restoreRequest);
    expect(recovered).toMatchObject({
      generation: 2,
      sourceExecutionId: initial.executionId,
      checkpointId: "checkpoint-01",
    });

    const db = drizzle(env.DB);
    const beforeEnd = await db
      .select({ id: runtimeExecutions.id, state: runtimeExecutions.state })
      .from(runtimeExecutions)
      .orderBy(asc(runtimeExecutions.generation));
    expect(beforeEnd).toEqual([
      { id: initial.executionId, state: "archived" },
      { id: recovered.executionId, state: "provisioning" },
    ]);
    const desiredBeforeEnd = await db
      .select({ doc: hostDesiredState.docJson })
      .from(hostDesiredState)
      .where(eq(hostDesiredState.hostId, "runner"));
    expect(
      desiredBeforeEnd[0]?.doc.vms.map((vm) => [vm.run_id, vm.desired_phase]),
    ).toEqual(
      expect.arrayContaining([
        [initial.executionId, "absent"],
        [recovered.executionId, "running"],
      ]),
    );

    await teardownWorkshopSessionRuntimes({ sessionId: fixture.sessionId });
    const [executions, slots, reservations, workspace, generations, desired] =
      await Promise.all([
        db
          .select({ state: runtimeExecutions.state })
          .from(runtimeExecutions)
          .orderBy(asc(runtimeExecutions.generation)),
        db.select().from(activeRuntimeSlots),
        db
          .select({ state: hostResourceReservations.state })
          .from(hostResourceReservations)
          .orderBy(asc(hostResourceReservations.createdAt)),
        db
          .select({ state: workshopWorkspaces.state })
          .from(workshopWorkspaces)
          .where(eq(workshopWorkspaces.id, initialRequest.workspaceId)),
        db
          .select({ state: workshopWorkspaceGenerations.state })
          .from(workshopWorkspaceGenerations)
          .where(
            eq(
              workshopWorkspaceGenerations.workspaceId,
              initialRequest.workspaceId,
            ),
          )
          .orderBy(asc(workshopWorkspaceGenerations.ordinal)),
        db
          .select({ doc: hostDesiredState.docJson })
          .from(hostDesiredState)
          .where(eq(hostDesiredState.hostId, "runner")),
      ]);
    expect(executions).toEqual([{ state: "archived" }, { state: "archived" }]);
    expect(slots).toEqual([]);
    expect(reservations).toEqual([
      { state: "released" },
      { state: "released" },
    ]);
    expect(workspace).toEqual([{ state: "ended" }]);
    expect(generations).toEqual([{ state: "archived" }, { state: "archived" }]);
    expect(
      desired[0]?.doc.vms.every((vm) => vm.desired_phase === "absent"),
    ).toBe(true);
  });

  it("cleans recorded routes before surfacing a fresh pending issuance and finishes on retry", async () => {
    const fixture = await workshopFixture();
    const prepared = await prepareCheckedInWorkshopWorkspaces({
      sessionId: fixture.sessionId,
      actorUserId: "owner",
    });
    const request = prepared.requests[0];
    if (!request) throw new Error("provisioning request missing");
    const execution = await provisionWorkshopRequest(request);
    const db = drizzle(env.DB);
    await db
      .update(workshopWorkspaces)
      .set({
        terminalRouteUsernamesJson: ["recorded-terminal-route"],
        applicationRouteIdsJson: ["recorded-application-route"],
      })
      .where(eq(workshopWorkspaces.id, request.workspaceId));
    const createdAt = Date.now();
    await env.DB.prepare(
      `INSERT INTO workshop_route_issuance_intents
         (id, organization_id, session_id, workspace_id, generation_id,
          actor_user_id, kind, route_key, state, capability_expires_at,
          created_at, updated_at)
       VALUES ('pending-end-route', 'org', ?, ?, ?, 'learner', 'application',
               'pending-application-route', 'pending', ?, ?, ?)`,
    )
      .bind(
        fixture.sessionId,
        request.workspaceId,
        request.generationId,
        createdAt + 15 * 60_000,
        createdAt,
        createdAt,
      )
      .run();

    await expect(
      teardownWorkshopSessionRuntimes({ sessionId: fixture.sessionId }),
    ).rejects.toMatchObject({ code: "workshop_route_issuance_in_progress" });
    expect(cleanupMocks.deleteStargateRoute).toHaveBeenCalledWith(
      "recorded-terminal-route",
    );
    expect(cleanupMocks.deleteStargateWorkspaceAppRoute).toHaveBeenCalledWith(
      "recorded-application-route",
    );
    await expect(
      db
        .select({
          terminal: workshopWorkspaces.terminalRouteUsernamesJson,
          applications: workshopWorkspaces.applicationRouteIdsJson,
        })
        .from(workshopWorkspaces)
        .where(eq(workshopWorkspaces.id, request.workspaceId)),
    ).resolves.toEqual([{ terminal: [], applications: [] }]);

    await env.DB.prepare(
      `UPDATE workshop_route_issuance_intents
       SET state = 'issued', updated_at = ?
       WHERE id = 'pending-end-route'`,
    )
      .bind(Date.now())
      .run();
    await teardownWorkshopSessionRuntimes({ sessionId: fixture.sessionId });
    expect(cleanupMocks.deleteStargateWorkspaceAppRoute).toHaveBeenCalledWith(
      "pending-application-route",
    );
    await expect(runtimeCleanupState(execution.executionId)).resolves.toMatchObject({
      execution: { state: "archived" },
      slots: 0,
      reservationStates: ["released"],
    });
    await expect(
      env.DB.prepare(
        "SELECT id FROM workshop_route_issuance_intents WHERE workspace_id = ?",
      )
        .bind(request.workspaceId)
        .all(),
    ).resolves.toMatchObject({ results: [] });
  });

  it("reuses the pending generation when restore route cleanup is retried", async () => {
    const fixture = await workshopFixture();
    const prepared = await prepareCheckedInWorkshopWorkspaces({
      sessionId: fixture.sessionId,
      actorUserId: "owner",
    });
    const initialRequest = prepared.requests[0];
    if (!initialRequest) throw new Error("initial request missing");
    const initial = await provisionWorkshopRequest(initialRequest);
    await performWorkshopSessionAction({
      sessionId: fixture.sessionId,
      actorUserId: "owner",
      action: "release_module",
      expectedVersion: 2,
      payload: { moduleId: "setup" },
    });
    const db = drizzle(env.DB);
    await db
      .update(workshopWorkspaces)
      .set({ terminalRouteUsernamesJson: ["restore-route"] })
      .where(eq(workshopWorkspaces.id, initialRequest.workspaceId));

    cleanupMocks.deleteStargateRoute.mockRejectedValueOnce(
      new Error("injected restore route cleanup failure"),
    );
    const restore = () =>
      performWorkshopSessionAction({
        sessionId: fixture.sessionId,
        actorUserId: "learner",
        action: "restore_checkpoint",
        payload: { checkpointId: "checkpoint-01", confirmed: true },
      });
    await expect(restore()).rejects.toThrow(
      "injected restore route cleanup failure",
    );

    const pending = await db
      .select({
        id: workshopWorkspaceGenerations.id,
        ordinal: workshopWorkspaceGenerations.ordinal,
        runtimeExecutionId: workshopWorkspaceGenerations.runtimeExecutionId,
        state: workshopWorkspaceGenerations.state,
      })
      .from(workshopWorkspaceGenerations)
      .where(
        eq(
          workshopWorkspaceGenerations.workspaceId,
          initialRequest.workspaceId,
        ),
      )
      .orderBy(asc(workshopWorkspaceGenerations.ordinal));
    expect(pending).toEqual([
      {
        id: initialRequest.generationId,
        ordinal: 1,
        runtimeExecutionId: initial.executionId,
        state: "archiving",
      },
      {
        id: expect.any(String),
        ordinal: 2,
        runtimeExecutionId: null,
        state: "queued",
      },
    ]);
    const pendingGenerationId = pending[1]?.id;
    if (!pendingGenerationId)
      throw new Error("pending restore generation missing");

    await expect(restore()).resolves.toEqual({
      kind: "provisioning",
      generationIds: [pendingGenerationId],
    });
    const [generations, executions, restoreEvents] = await Promise.all([
      db
        .select({
          id: workshopWorkspaceGenerations.id,
          ordinal: workshopWorkspaceGenerations.ordinal,
          runtimeExecutionId: workshopWorkspaceGenerations.runtimeExecutionId,
          state: workshopWorkspaceGenerations.state,
        })
        .from(workshopWorkspaceGenerations)
        .where(
          eq(
            workshopWorkspaceGenerations.workspaceId,
            initialRequest.workspaceId,
          ),
        )
        .orderBy(asc(workshopWorkspaceGenerations.ordinal)),
      db
        .select({ generation: runtimeExecutions.generation })
        .from(runtimeExecutions)
        .orderBy(asc(runtimeExecutions.generation)),
      db
        .select({
          type: workshopEvents.type,
          payload: workshopEvents.payloadJson,
        })
        .from(workshopEvents)
        .where(
          eq(workshopEvents.type, "workspace.checkpoint_restore_requested"),
        ),
    ]);
    expect(generations).toEqual([
      expect.objectContaining({ ordinal: 1, state: "archived" }),
      expect.objectContaining({
        id: pendingGenerationId,
        ordinal: 2,
        runtimeExecutionId: expect.any(String),
        state: "provisioning",
      }),
    ]);
    expect(executions).toEqual([{ generation: 1 }, { generation: 2 }]);
    expect(restoreEvents).toEqual([
      {
        type: "workspace.checkpoint_restore_requested",
        payload: expect.objectContaining({
          generationId: pendingGenerationId,
          workspaceId: initialRequest.workspaceId,
          checkpointId: "checkpoint-01",
        }),
      },
    ]);
    expect(cleanupMocks.deleteStargateRoute).toHaveBeenCalledTimes(2);
  });

  it("keeps the source execution reserved and retryable when restore cleanup fails", async () => {
    const fixture = await workshopFixture();
    const prepared = await prepareCheckedInWorkshopWorkspaces({
      sessionId: fixture.sessionId,
      actorUserId: "owner",
    });
    const initialRequest = prepared.requests[0];
    if (!initialRequest) throw new Error("initial request missing");
    const initial = await provisionWorkshopRequest(initialRequest);
    const restoreRequest = await prepareWorkshopCheckpointRestore({
      sessionId: fixture.sessionId,
      workspaceId: initialRequest.workspaceId,
      checkpointId: "checkpoint-01",
      actorUserId: "learner",
    });

    cleanupMocks.failDesiredStateMutationOnce = true;
    await expect(provisionWorkshopRequest(restoreRequest)).rejects.toThrow(
      "injected desired-state cleanup failure",
    );

    const db = drizzle(env.DB);
    const [executions, slots, reservations, generations, desired] =
      await Promise.all([
        db
          .select({ id: runtimeExecutions.id, state: runtimeExecutions.state })
          .from(runtimeExecutions),
        db
          .select({ executionId: activeRuntimeSlots.executionId })
          .from(activeRuntimeSlots),
        db
          .select({ state: hostResourceReservations.state })
          .from(hostResourceReservations)
          .where(eq(hostResourceReservations.executionId, initial.executionId)),
        db
          .select({
            ordinal: workshopWorkspaceGenerations.ordinal,
            state: workshopWorkspaceGenerations.state,
          })
          .from(workshopWorkspaceGenerations)
          .where(
            eq(
              workshopWorkspaceGenerations.workspaceId,
              initialRequest.workspaceId,
            ),
          )
          .orderBy(asc(workshopWorkspaceGenerations.ordinal)),
        db
          .select({ doc: hostDesiredState.docJson })
          .from(hostDesiredState)
          .where(eq(hostDesiredState.hostId, "runner")),
      ]);
    expect(executions).toEqual([
      { id: initial.executionId, state: "provisioning" },
    ]);
    expect(slots).toEqual([{ executionId: initial.executionId }]);
    expect(reservations).toEqual([{ state: "committed" }]);
    expect(generations).toEqual([
      { ordinal: 1, state: "archiving" },
      { ordinal: 2, state: "failed" },
    ]);
    expect(
      desired[0]?.doc.vms.find((vm) => vm.run_id === initial.executionId)
        ?.desired_phase,
    ).toBe("running");

    const recovered = await provisionWorkshopRequest(restoreRequest);
    expect(recovered).toMatchObject({
      generation: 2,
      sourceExecutionId: initial.executionId,
      checkpointId: "checkpoint-01",
    });
  });

  it("releases a committed reservation after a post-desired failure and retries", async () => {
    const fixture = await workshopFixture();
    const prepared = await prepareCheckedInWorkshopWorkspaces({
      sessionId: fixture.sessionId,
      actorUserId: "owner",
    });
    const request = prepared.requests[0];
    if (!request) throw new Error("provisioning request missing");

    cleanupMocks.failExecutionStateUpdateOnce = true;
    await expect(provisionWorkshopRequest(request)).rejects.toThrow(
      "injected post-desired-state failure",
    );

    const db = drizzle(env.DB);
    const [failedGeneration] = await db
      .select({
        executionId: workshopWorkspaceGenerations.runtimeExecutionId,
      })
      .from(workshopWorkspaceGenerations)
      .where(eq(workshopWorkspaceGenerations.id, request.generationId));
    if (!failedGeneration?.executionId) {
      throw new Error("failed generation execution missing");
    }
    expect(
      await runtimeCleanupState(failedGeneration.executionId),
    ).toMatchObject({
      generation: { state: "failed" },
      execution: { state: "archived" },
      slots: 0,
      reservationStates: ["released"],
      desiredPhases: ["absent"],
    });

    const retry = await prepareCheckedInWorkshopWorkspaces({
      sessionId: fixture.sessionId,
      actorUserId: "owner",
    });
    const retryRequest = retry.requests[0];
    if (!retryRequest) throw new Error("retry request missing");
    expect(retryRequest).toMatchObject({ generationOrdinal: 2 });
    const recovered = await provisionWorkshopRequest(retryRequest);
    expect(recovered).toMatchObject({
      generation: 2,
      sourceExecutionId: expect.any(String),
    });
    expect(
      await db
        .select({ state: hostResourceReservations.state })
        .from(hostResourceReservations)
        .orderBy(asc(hostResourceReservations.createdAt)),
    ).toEqual([{ state: "released" }, { state: "committed" }]);
    expect(
      await db
        .select({ executionId: activeRuntimeSlots.executionId })
        .from(activeRuntimeSlots),
    ).toEqual([{ executionId: recovered.executionId }]);
  });

  it("cleans a runtime created while terminal session cleanup snapshots an unlinked generation", async () => {
    const fixture = await workshopFixture();
    const prepared = await prepareCheckedInWorkshopWorkspaces({
      sessionId: fixture.sessionId,
      actorUserId: "owner",
    });
    const request = prepared.requests[0];
    if (!request) throw new Error("provisioning request missing");

    cleanupMocks.afterRuntimeExecutionCreatedOnce = async () => {
      await updateWorkshopSession({
        sessionId: fixture.sessionId,
        actorUserId: "owner",
        expectedVersion: 2,
        state: "cancelled",
      });
    };

    await expect(provisionWorkshopRequest(request)).rejects.toMatchObject({
      code: "workshop_provisioning_request_stale",
    });

    const db = drizzle(env.DB);
    const [execution] = await db
      .select({ id: runtimeExecutions.id })
      .from(runtimeExecutions);
    if (!execution) throw new Error("racing execution missing");
    expect(await runtimeCleanupState(execution.id)).toMatchObject({
      session: { state: "cancelled" },
      workspace: {
        state: "ended",
        terminalRoutes: [],
        applicationRoutes: [],
      },
      generation: { state: "archived" },
      execution: { state: "archived" },
      slots: 0,
      reservationStates: ["released"],
    });
  });

  it("cannot insert a runtime after terminal cleanup completed before allocation commit", async () => {
    const fixture = await workshopFixture();
    const prepared = await prepareCheckedInWorkshopWorkspaces({
      sessionId: fixture.sessionId,
      actorUserId: "owner",
    });
    const request = prepared.requests[0];
    if (!request) throw new Error("provisioning request missing");

    cleanupMocks.beforeRuntimeExecutionCreatedOnce = async () => {
      await updateWorkshopSession({
        sessionId: fixture.sessionId,
        actorUserId: "owner",
        expectedVersion: 2,
        state: "cancelled",
      });
    };

    await expect(provisionWorkshopRequest(request)).rejects.toMatchObject({
      code: "workshop_provisioning_request_stale",
    });

    const db = drizzle(env.DB);
    const [sessions, workspaces, generations, executions, slots, reservations] =
      await Promise.all([
        db
          .select({ state: workshopSessions.state })
          .from(workshopSessions)
          .where(eq(workshopSessions.id, fixture.sessionId)),
        db
          .select({ state: workshopWorkspaces.state })
          .from(workshopWorkspaces)
          .where(eq(workshopWorkspaces.id, request.workspaceId)),
        db
          .select({ state: workshopWorkspaceGenerations.state })
          .from(workshopWorkspaceGenerations)
          .where(eq(workshopWorkspaceGenerations.id, request.generationId)),
        db.select().from(runtimeExecutions),
        db.select().from(activeRuntimeSlots),
        db.select().from(hostResourceReservations),
      ]);
    expect(sessions).toEqual([{ state: "cancelled" }]);
    expect(workspaces).toEqual([{ state: "ended" }]);
    expect(generations).toEqual([{ state: "archived" }]);
    expect(executions).toEqual([]);
    expect(slots).toEqual([]);
    expect(reservations).toEqual([]);
  });

  it("cannot publish a running desired VM after organization removal wins the write race", async () => {
    const fixture = await workshopFixture();
    const prepared = await prepareCheckedInWorkshopWorkspaces({
      sessionId: fixture.sessionId,
      actorUserId: "owner",
    });
    const request = prepared.requests[0];
    if (!request) throw new Error("provisioning request missing");

    cleanupMocks.beforeDesiredStateMutationOnce = async () => {
      await removeOrganizationMember({
        organizationId: "org",
        memberId: "member-learner",
        actorUserId: "owner",
      });
    };

    await expect(provisionWorkshopRequest(request)).rejects.toMatchObject({
      code: "workshop_provisioning_request_stale",
    });

    const db = drizzle(env.DB);
    const [execution] = await db
      .select({ id: runtimeExecutions.id })
      .from(runtimeExecutions);
    if (!execution) throw new Error("racing execution missing");
    const desired = await db
      .select({ doc: hostDesiredState.docJson })
      .from(hostDesiredState)
      .where(eq(hostDesiredState.hostId, "runner"));
    expect(
      desired.flatMap((row) => row.doc.vms).every(
        (vm) => vm.run_id !== execution.id || vm.desired_phase === "absent",
      ),
    ).toBe(true);
    expect(await runtimeCleanupState(execution.id)).toMatchObject({
      workspace: { state: "ended" },
      generation: { state: "archived" },
      execution: { state: "archived" },
      slots: 0,
      reservationStates: ["released"],
    });
    await expect(
      db.select().from(member).where(eq(member.id, "member-learner")),
    ).resolves.toEqual([]);
  });

  it("retries terminal cleanup after Stargate and desired-state failures", async () => {
    const fixture = await workshopFixture();
    const prepared = await prepareCheckedInWorkshopWorkspaces({
      sessionId: fixture.sessionId,
      actorUserId: "owner",
    });
    const request = prepared.requests[0];
    if (!request) throw new Error("provisioning request missing");
    const execution = await provisionWorkshopRequest(request);
    const db = drizzle(env.DB);
    await db
      .update(workshopWorkspaces)
      .set({
        terminalRouteUsernamesJson: ["terminal-route"],
        applicationRouteIdsJson: ["application-route"],
      })
      .where(eq(workshopWorkspaces.id, request.workspaceId));
    const live = await updateWorkshopSession({
      sessionId: fixture.sessionId,
      actorUserId: "owner",
      expectedVersion: 2,
      state: "live",
    });

    cleanupMocks.deleteStargateRoute.mockRejectedValueOnce(
      new Error("injected Stargate cleanup failure"),
    );
    cleanupMocks.failDesiredStateMutationOnce = true;
    await expect(
      updateWorkshopSession({
        sessionId: fixture.sessionId,
        actorUserId: "owner",
        expectedVersion: live.version,
        state: "ended",
      }),
    ).rejects.toThrow("injected Stargate cleanup failure");

    expect(await runtimeCleanupState(execution.executionId)).toMatchObject({
      session: { state: "ended", version: 4 },
      workspace: {
        state: "ending",
        terminalRoutes: ["terminal-route"],
        applicationRoutes: ["application-route"],
      },
      generation: { state: "archiving" },
      execution: { state: "provisioning" },
      slots: 1,
      reservationStates: ["committed"],
    });

    await expect(
      updateWorkshopSession({
        sessionId: fixture.sessionId,
        actorUserId: "owner",
        expectedVersion: 4,
        state: "ended",
      }),
    ).rejects.toThrow("injected desired-state cleanup failure");
    expect(await runtimeCleanupState(execution.executionId)).toMatchObject({
      session: { state: "ended", version: 4 },
      workspace: {
        state: "ending",
        terminalRoutes: [],
        applicationRoutes: [],
      },
      generation: { state: "archiving" },
      execution: { state: "provisioning" },
      slots: 1,
      reservationStates: ["committed"],
    });

    const ended = await updateWorkshopSession({
      sessionId: fixture.sessionId,
      actorUserId: "owner",
      expectedVersion: 4,
      state: "ended",
    });
    expect(ended).toMatchObject({ state: "ended", version: 4 });
    expect(await runtimeCleanupState(execution.executionId)).toMatchObject({
      session: { state: "ended", version: 4 },
      workspace: {
        state: "ended",
        terminalRoutes: [],
        applicationRoutes: [],
      },
      generation: { state: "archived" },
      execution: { state: "archived" },
      slots: 0,
      reservationStates: ["released"],
      desiredPhases: ["absent"],
    });
    expect(cleanupMocks.deleteStargateRoute).toHaveBeenCalledTimes(2);
    expect(cleanupMocks.deleteStargateWorkspaceAppRoute).toHaveBeenCalledTimes(
      2,
    );

    const cleanupEvents = await db
      .select({ type: workshopEvents.type })
      .from(workshopEvents)
      .where(eq(workshopEvents.sessionId, fixture.sessionId));
    expect(
      cleanupEvents.filter((event) => event.type === "session.ended"),
    ).toHaveLength(1);
    expect(
      cleanupEvents.filter((event) => event.type === "session.cleanup_failed"),
    ).toHaveLength(2);
    expect(
      cleanupEvents.filter((event) => event.type === "session.cleanup_retried"),
    ).toHaveLength(2);
    expect(
      cleanupEvents.filter(
        (event) => event.type === "session.cleanup_completed",
      ),
    ).toHaveLength(1);
  });

  it("fences VM reports by host session, generation, and observed timestamp", async () => {
    const fixture = await workshopFixture();
    const prepared = await prepareCheckedInWorkshopWorkspaces({
      sessionId: fixture.sessionId,
      actorUserId: "owner",
    });
    const request = prepared.requests[0];
    if (!request) throw new Error("request missing");
    const execution = await provisionWorkshopRequest(request);
    const vm = execution.vms[0];
    if (!vm) throw new Error("runtime VM missing");
    const observedAt = Date.now() + 1_000;
    const report = readyVmReport(
      execution.executionId,
      vm.runtimeVmName,
      observedAt,
    );
    await expect(
      recordRuntimeVmActualState({
        executionId: execution.executionId,
        expectedGeneration: 1,
        vmId: vm.vmId,
        hostId: "runner",
        expectedHostSessionId: "runner-session",
        report,
      }),
    ).resolves.toBe("updated");
    await expect(
      recordRuntimeVmActualState({
        executionId: execution.executionId,
        expectedGeneration: 1,
        vmId: vm.vmId,
        hostId: "runner",
        expectedHostSessionId: "stale-session",
        report: {
          ...report,
          phase: "failed",
          updated_at_unix_ms: observedAt + 1,
        },
      }),
    ).resolves.toBe("stale");
    await expect(
      recordRuntimeVmActualState({
        executionId: execution.executionId,
        expectedGeneration: 1,
        vmId: vm.vmId,
        hostId: "runner",
        expectedHostSessionId: "runner-session",
        report: {
          ...report,
          phase: "failed",
          updated_at_unix_ms: observedAt - 1,
        },
      }),
    ).resolves.toBe("stale");

    const db = drizzle(env.DB);
    const actual = await db.select().from(runtimeVmActualState);
    expect(actual).toEqual([
      expect.objectContaining({ phase: "ready", observedAt }),
    ]);
    await expect(
      loadCurrentRuntimeVmTerminalTarget({
        executionId: execution.executionId,
        expectedGeneration: 1,
        vmId: vm.vmId,
      }),
    ).resolves.toMatchObject({
      target: {
        host: "192.0.2.50",
        port: 22,
        username: "learner",
        observedAt,
      },
    });
  });

  it("recovers a failed-host workspace on another organization runner", async () => {
    await seedRunner("runner-b");
    const fixture = await workshopFixture();
    const prepared = await prepareCheckedInWorkshopWorkspaces({
      sessionId: fixture.sessionId,
      actorUserId: "owner",
    });
    const request = prepared.requests[0];
    if (!request) throw new Error("request missing");
    const initial = await provisionWorkshopRequest(request);
    expect(initial.hostId).toBe("runner");

    const outcomes = await recoverWorkshopRuntimesFromFailedHost({
      hostId: "runner",
    });
    expect(outcomes).toEqual([
      expect.objectContaining({
        participantUserId: "learner",
        ok: true,
        hostId: "runner-b",
      }),
    ]);
    const db = drizzle(env.DB);
    const [workspace, generations, executions] = await Promise.all([
      db
        .select({
          state: workshopWorkspaces.state,
          recoveryMessage: workshopWorkspaces.recoveryMessage,
        })
        .from(workshopWorkspaces)
        .where(eq(workshopWorkspaces.id, request.workspaceId)),
      db
        .select({
          ordinal: workshopWorkspaceGenerations.ordinal,
          state: workshopWorkspaceGenerations.state,
          hostId: workshopWorkspaceGenerations.hostId,
        })
        .from(workshopWorkspaceGenerations)
        .where(
          eq(workshopWorkspaceGenerations.workspaceId, request.workspaceId),
        )
        .orderBy(asc(workshopWorkspaceGenerations.ordinal)),
      db
        .select({
          state: runtimeExecutions.state,
          hostId: runtimeExecutions.hostId,
        })
        .from(runtimeExecutions)
        .orderBy(asc(runtimeExecutions.generation)),
    ]);
    expect(workspace).toEqual([
      {
        state: "recovering",
        recoveryMessage: expect.stringContaining(
          "work since that checkpoint may be lost",
        ),
      },
    ]);
    expect(generations).toEqual([
      { ordinal: 1, state: "archived", hostId: "runner" },
      { ordinal: 2, state: "provisioning", hostId: "runner-b" },
    ]);
    expect(executions).toEqual([
      { state: "archived", hostId: "runner" },
      { state: "provisioning", hostId: "runner-b" },
    ]);
  });

  it("reuses a failed-host recovery generation after route cleanup fails", async () => {
    await seedRunner("runner-b");
    const fixture = await workshopFixture();
    const prepared = await prepareCheckedInWorkshopWorkspaces({
      sessionId: fixture.sessionId,
      actorUserId: "owner",
    });
    const request = prepared.requests[0];
    if (!request) throw new Error("request missing");
    await provisionWorkshopRequest(request);
    const db = drizzle(env.DB);
    await db
      .update(workshopWorkspaces)
      .set({ terminalRouteUsernamesJson: ["failed-host-route"] })
      .where(eq(workshopWorkspaces.id, request.workspaceId));
    cleanupMocks.deleteStargateRoute.mockRejectedValueOnce(
      new Error("injected failed-host route cleanup failure"),
    );

    const first = await recoverWorkshopRuntimesFromFailedHost({
      hostId: "runner",
    });
    expect(first).toEqual([
      expect.objectContaining({
        participantUserId: "learner",
        ok: false,
        error: "injected failed-host route cleanup failure",
      }),
    ]);
    const pending = await db
      .select({
        id: workshopWorkspaceGenerations.id,
        ordinal: workshopWorkspaceGenerations.ordinal,
        runtimeExecutionId: workshopWorkspaceGenerations.runtimeExecutionId,
        state: workshopWorkspaceGenerations.state,
      })
      .from(workshopWorkspaceGenerations)
      .where(eq(workshopWorkspaceGenerations.workspaceId, request.workspaceId))
      .orderBy(asc(workshopWorkspaceGenerations.ordinal));
    const pendingGenerationId = pending[1]?.id;
    expect(pending).toEqual([
      expect.objectContaining({ ordinal: 1, state: "archiving" }),
      {
        id: pendingGenerationId,
        ordinal: 2,
        runtimeExecutionId: null,
        state: "queued",
      },
    ]);
    expect(first[0]?.generationId).toBe(pendingGenerationId);

    const retry = await recoverWorkshopRuntimesFromFailedHost({
      hostId: "runner",
    });
    expect(retry).toEqual([
      expect.objectContaining({
        generationId: pendingGenerationId,
        participantUserId: "learner",
        ok: true,
        hostId: "runner-b",
      }),
    ]);
    const [generations, executions, recoveryEvents] = await Promise.all([
      db
        .select({
          id: workshopWorkspaceGenerations.id,
          ordinal: workshopWorkspaceGenerations.ordinal,
          state: workshopWorkspaceGenerations.state,
        })
        .from(workshopWorkspaceGenerations)
        .where(
          eq(workshopWorkspaceGenerations.workspaceId, request.workspaceId),
        )
        .orderBy(asc(workshopWorkspaceGenerations.ordinal)),
      db
        .select({ generation: runtimeExecutions.generation })
        .from(runtimeExecutions)
        .orderBy(asc(runtimeExecutions.generation)),
      db
        .select({ type: workshopEvents.type })
        .from(workshopEvents)
        .where(
          eq(workshopEvents.type, "workspace.host_failure_recovery_requested"),
        ),
    ]);
    expect(generations).toEqual([
      expect.objectContaining({ ordinal: 1, state: "archived" }),
      {
        id: pendingGenerationId,
        ordinal: 2,
        state: "provisioning",
      },
    ]);
    expect(executions).toEqual([{ generation: 1 }, { generation: 2 }]);
    expect(recoveryEvents).toHaveLength(1);
    expect(cleanupMocks.deleteStargateRoute).toHaveBeenCalledTimes(2);
  });

  it("reuses an unallocated failed-host generation when capacity returns", async () => {
    await seedRunner("runner-b");
    const fixture = await workshopFixture();
    const prepared = await prepareCheckedInWorkshopWorkspaces({
      sessionId: fixture.sessionId,
      actorUserId: "owner",
    });
    const request = prepared.requests[0];
    if (!request) throw new Error("request missing");
    await provisionWorkshopRequest(request);
    const db = drizzle(env.DB);
    const unavailableAt = Date.now();
    await db
      .update(hostActualState)
      .set({
        reportJson: {
          ...hostReport(unavailableAt, "runner-b"),
          cached_images: [],
        },
        observedAt: unavailableAt,
        updatedAt: unavailableAt,
      })
      .where(eq(hostActualState.hostId, "runner-b"));

    const first = await recoverWorkshopRuntimesFromFailedHost({
      hostId: "runner",
    });
    expect(first).toEqual([
      expect.objectContaining({
        participantUserId: "learner",
        ok: false,
        error: expect.stringContaining("images"),
      }),
    ]);
    const [failedGeneration] = await db
      .select({
        id: workshopWorkspaceGenerations.id,
        ordinal: workshopWorkspaceGenerations.ordinal,
        runtimeExecutionId: workshopWorkspaceGenerations.runtimeExecutionId,
        state: workshopWorkspaceGenerations.state,
      })
      .from(workshopWorkspaceGenerations)
      .where(eq(workshopWorkspaceGenerations.ordinal, 2));
    expect(failedGeneration).toMatchObject({
      ordinal: 2,
      runtimeExecutionId: null,
      state: "failed",
    });

    const availableAt = Date.now();
    await db
      .update(hostActualState)
      .set({
        reportJson: hostReport(availableAt, "runner-b"),
        observedAt: availableAt,
        updatedAt: availableAt,
      })
      .where(eq(hostActualState.hostId, "runner-b"));
    const retry = await recoverWorkshopRuntimesFromFailedHost({
      hostId: "runner",
    });
    expect(retry).toEqual([
      expect.objectContaining({
        generationId: failedGeneration?.id,
        participantUserId: "learner",
        ok: true,
        hostId: "runner-b",
      }),
    ]);
    expect(
      await db
        .select({ ordinal: workshopWorkspaceGenerations.ordinal })
        .from(workshopWorkspaceGenerations)
        .where(
          eq(workshopWorkspaceGenerations.workspaceId, request.workspaceId),
        ),
    ).toHaveLength(2);
  });

  it("recovers only from the contiguous completed checkpoint prefix", async () => {
    await seedRunner("runner-b");
    const fixture = await workshopFixture(branchedRecoveryManifest());
    const prepared = await prepareCheckedInWorkshopWorkspaces({
      sessionId: fixture.sessionId,
      actorUserId: "owner",
    });
    const request = prepared.requests[0];
    if (!request) throw new Error("request missing");
    await provisionWorkshopRequest(request);
    await recordWorkshopModuleObservation({
      sessionId: fixture.sessionId,
      participantUserId: "learner",
      moduleId: "setup",
      technicalStatus: "verified",
      currentHealth: "passing",
    });
    await recordWorkshopModuleObservation({
      sessionId: fixture.sessionId,
      participantUserId: "learner",
      moduleId: "stretch-07",
      technicalStatus: "verified",
      currentHealth: "passing",
    });

    await recoverWorkshopRuntimesFromFailedHost({ hostId: "runner" });
    const generations = await drizzle(env.DB)
      .select({
        ordinal: workshopWorkspaceGenerations.ordinal,
        checkpointId: workshopWorkspaceGenerations.checkpointId,
      })
      .from(workshopWorkspaceGenerations)
      .where(eq(workshopWorkspaceGenerations.workspaceId, request.workspaceId))
      .orderBy(asc(workshopWorkspaceGenerations.ordinal));
    expect(generations).toEqual([
      { ordinal: 1, checkpointId: "checkpoint-00" },
      { ordinal: 2, checkpointId: "checkpoint-01" },
    ]);
  });

  it("recovers a persistently disconnected host from the runtime alarm exactly once", async () => {
    await seedRunner("runner-b");
    const fixture = await workshopFixture();
    const prepared = await prepareCheckedInWorkshopWorkspaces({
      sessionId: fixture.sessionId,
      actorUserId: "owner",
    });
    const request = prepared.requests[0];
    if (!request) throw new Error("request missing");
    const initial = await provisionWorkshopRequest(request);
    expect(initial.hostId).toBe("runner");

    const db = drizzle(env.DB);
    const disconnectedAt = Date.now();
    await db
      .update(agentHosts)
      .set({
        connected: false,
        activeSessionId: null,
        disconnectedAt,
        lastHeartbeatAt: disconnectedAt,
        updatedAt: disconnectedAt,
      })
      .where(eq(agentHosts.id, "runner"));

    const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName("runner"));
    const wake = await stub.fetch("http://host-runtime/_internal/wake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: "runner" }),
    });
    expect(wake.status).toBe(202);
    await runNextScheduledAlarm(stub);
    expect(
      await db
        .select()
        .from(workshopWorkspaceGenerations)
        .where(
          eq(workshopWorkspaceGenerations.workspaceId, request.workspaceId),
        ),
    ).toHaveLength(1);

    const recoveryDueAt =
      Date.now() - WORKSHOP_HOST_FAILURE_RECOVERY_AFTER_MS - 1;
    await db
      .update(agentHosts)
      .set({
        disconnectedAt: recoveryDueAt,
        lastHeartbeatAt: recoveryDueAt,
        updatedAt: recoveryDueAt,
      })
      .where(eq(agentHosts.id, "runner"));
    await runNextScheduledAlarm(stub);
    const generationsAfterRecovery = await db
      .select({
        ordinal: workshopWorkspaceGenerations.ordinal,
        state: workshopWorkspaceGenerations.state,
        hostId: workshopWorkspaceGenerations.hostId,
      })
      .from(workshopWorkspaceGenerations)
      .where(eq(workshopWorkspaceGenerations.workspaceId, request.workspaceId))
      .orderBy(asc(workshopWorkspaceGenerations.ordinal));
    expect(generationsAfterRecovery).toEqual([
      { ordinal: 1, state: "archived", hostId: "runner" },
      { ordinal: 2, state: "provisioning", hostId: "runner-b" },
    ]);

    await stub.fetch("http://host-runtime/_internal/wake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: "runner" }),
    });
    await runNextScheduledAlarm(stub);
    const generationsAfterRetry = await db
      .select({ id: workshopWorkspaceGenerations.id })
      .from(workshopWorkspaceGenerations)
      .where(eq(workshopWorkspaceGenerations.workspaceId, request.workspaceId));
    expect(generationsAfterRetry).toHaveLength(2);
  });

  it("re-arms the failed-host alarm after a successor runtime fails post-allocation", async () => {
    await seedRunner("runner-b");
    const fixture = await workshopFixture();
    const prepared = await prepareCheckedInWorkshopWorkspaces({
      sessionId: fixture.sessionId,
      actorUserId: "owner",
    });
    const request = prepared.requests[0];
    if (!request) throw new Error("request missing");
    await provisionWorkshopRequest(request);

    const db = drizzle(env.DB);
    const recoveryDueAt =
      Date.now() - WORKSHOP_HOST_FAILURE_RECOVERY_AFTER_MS - 1;
    await db
      .update(agentHosts)
      .set({
        connected: false,
        activeSessionId: null,
        disconnectedAt: recoveryDueAt,
        lastHeartbeatAt: recoveryDueAt,
        updatedAt: recoveryDueAt,
      })
      .where(eq(agentHosts.id, "runner"));
    cleanupMocks.failExecutionStateUpdateOnce = true;

    const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName("runner"));
    const wake = await stub.fetch("http://host-runtime/_internal/wake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: "runner" }),
    });
    expect(wake.status).toBe(202);
    await runNextScheduledAlarm(stub);
    const afterFailure = await db
      .select({
        ordinal: workshopWorkspaceGenerations.ordinal,
        state: workshopWorkspaceGenerations.state,
      })
      .from(workshopWorkspaceGenerations)
      .where(eq(workshopWorkspaceGenerations.workspaceId, request.workspaceId))
      .orderBy(asc(workshopWorkspaceGenerations.ordinal));
    expect(afterFailure).toEqual([
      { ordinal: 1, state: "archived" },
      { ordinal: 2, state: "failed" },
    ]);

    await runNextScheduledAlarm(stub);
    const afterRetry = await db
      .select({
        ordinal: workshopWorkspaceGenerations.ordinal,
        state: workshopWorkspaceGenerations.state,
        hostId: workshopWorkspaceGenerations.hostId,
      })
      .from(workshopWorkspaceGenerations)
      .where(eq(workshopWorkspaceGenerations.workspaceId, request.workspaceId))
      .orderBy(asc(workshopWorkspaceGenerations.ordinal));
    expect(afterRetry).toEqual([
      { ordinal: 1, state: "archived", hostId: "runner" },
      { ordinal: 2, state: "archived", hostId: "runner-b" },
      { ordinal: 3, state: "provisioning", hostId: "runner-b" },
    ]);
  });

  it("retries only the failed portion of bulk provisioning", async () => {
    const db = drizzle(env.DB);
    const now = Date.now();
    await db
      .update(hostActualState)
      .set({
        reportJson: { ...hostReport(now, "runner"), cached_images: [] },
        observedAt: now,
        updatedAt: now,
      })
      .where(eq(hostActualState.hostId, "runner"));
    const fixture = await workshopFixture();
    const first = await prepareCheckedInWorkshopWorkspaces({
      sessionId: fixture.sessionId,
      actorUserId: "owner",
    });
    const firstRequest = first.requests[0];
    if (!firstRequest) throw new Error("first request missing");
    const failed = await provisionWorkshopRequests(first.requests);
    expect(failed).toEqual([
      expect.objectContaining({
        ok: false,
        generationId: firstRequest.generationId,
      }),
    ]);
    const failedGeneration = await db
      .select({
        state: workshopWorkspaceGenerations.state,
        runtimeExecutionId: workshopWorkspaceGenerations.runtimeExecutionId,
      })
      .from(workshopWorkspaceGenerations)
      .where(eq(workshopWorkspaceGenerations.id, firstRequest.generationId));
    expect(failedGeneration).toEqual([
      { state: "failed", runtimeExecutionId: null },
    ]);

    const readyAt = now + 1;
    await db
      .update(hostActualState)
      .set({
        reportJson: hostReport(readyAt, "runner"),
        observedAt: readyAt,
        updatedAt: readyAt,
      })
      .where(eq(hostActualState.hostId, "runner"));
    const retry = await prepareCheckedInWorkshopWorkspaces({
      sessionId: fixture.sessionId,
      actorUserId: "owner",
    });
    expect(retry.requests).toEqual([
      expect.objectContaining({
        generationId: firstRequest.generationId,
        generationOrdinal: 1,
      }),
    ]);
    await expect(provisionWorkshopRequests(retry.requests)).resolves.toEqual([
      expect.objectContaining({
        ok: true,
        generationId: firstRequest.generationId,
      }),
    ]);
  });

  it("marks checkpoint-covered late-join work caught up before probes can verify it", async () => {
    const fixture = await workshopFixture();
    await performWorkshopSessionAction({
      sessionId: fixture.sessionId,
      actorUserId: "owner",
      action: "release_module",
      expectedVersion: 2,
      payload: { moduleId: "setup" },
    });
    const request = await prepareWorkshopLateJoin({
      sessionId: fixture.sessionId,
      participantUserId: "late",
      checkpointId: "checkpoint-01",
      actorUserId: "owner",
    });
    const db = drizzle(env.DB);
    const readProgress = () =>
      db
        .select({
          moduleId: workshopModuleProgress.moduleId,
          technicalStatus: workshopModuleProgress.technicalStatus,
          firstVerifiedAt: workshopModuleProgress.firstVerifiedAt,
          caughtUpAt: workshopModuleProgress.caughtUpAt,
        })
        .from(workshopModuleProgress)
        .where(eq(workshopModuleProgress.userId, "late"));
    await expect(readProgress()).resolves.toEqual([
      {
        moduleId: "setup",
        technicalStatus: "caught_up",
        firstVerifiedAt: null,
        caughtUpAt: expect.any(Number),
      },
    ]);

    const execution = await provisionWorkshopRequest(request);
    await expect(readProgress()).resolves.toEqual([
      expect.objectContaining({
        moduleId: "setup",
        technicalStatus: "caught_up",
        firstVerifiedAt: null,
      }),
    ]);
    await recordWorkshopGenerationState({
      generationId: request.generationId,
      update: {
        state: "ready",
        runtimeExecutionId: execution.executionId,
        hostId: execution.hostId,
      },
    });
    await recordWorkshopModuleObservation({
      sessionId: fixture.sessionId,
      participantUserId: "late",
      moduleId: "setup",
      technicalStatus: "verified",
      currentHealth: "passing",
    });
    const [progress, workspace] = await Promise.all([
      readProgress(),
      db
        .select({
          checkpointId: workshopWorkspaces.lastCheckpointId,
          state: workshopWorkspaces.state,
        })
        .from(workshopWorkspaces)
        .where(eq(workshopWorkspaces.userId, "late")),
    ]);
    expect(progress).toEqual([
      {
        moduleId: "setup",
        technicalStatus: "caught_up",
        firstVerifiedAt: null,
        caughtUpAt: expect.any(Number),
      },
    ]);
    expect(workspace).toEqual([
      { checkpointId: "checkpoint-01", state: "ready" },
    ]);
  });
});

async function runtimeCleanupState(executionId: string) {
  const db = drizzle(env.DB);
  const [
    sessions,
    workspaces,
    generations,
    executions,
    slots,
    reservations,
    desired,
  ] = await Promise.all([
    db
      .select({
        state: workshopSessions.state,
        version: workshopSessions.version,
      })
      .from(workshopSessions),
    db
      .select({
        state: workshopWorkspaces.state,
        terminalRoutes: workshopWorkspaces.terminalRouteUsernamesJson,
        applicationRoutes: workshopWorkspaces.applicationRouteIdsJson,
      })
      .from(workshopWorkspaces),
    db
      .select({ state: workshopWorkspaceGenerations.state })
      .from(workshopWorkspaceGenerations),
    db
      .select({ state: runtimeExecutions.state })
      .from(runtimeExecutions)
      .where(eq(runtimeExecutions.id, executionId)),
    db
      .select({ executionId: activeRuntimeSlots.executionId })
      .from(activeRuntimeSlots),
    db
      .select({ state: hostResourceReservations.state })
      .from(hostResourceReservations)
      .where(eq(hostResourceReservations.executionId, executionId)),
    db.select({ doc: hostDesiredState.docJson }).from(hostDesiredState),
  ]);
  return {
    session: sessions[0],
    workspace: workspaces[0],
    generation: generations[0],
    execution: executions[0],
    slots: slots.length,
    reservationStates: reservations.map((row) => row.state),
    desiredPhases: desired.flatMap((row) =>
      row.doc.vms
        .filter((vm) => vm.run_id === executionId)
        .map((vm) => vm.desired_phase),
    ),
  };
}

async function workshopFixture(workshopManifest = manifest()) {
  const created = await createWorkshopTemplate({
    organizationId: "org",
    actorUserId: "owner",
    sourceRevision: "test-source",
    contentHash: "f".repeat(64),
    manifest: workshopManifest,
  });
  const now = Date.now();
  const runtimeProfileId = `profile-${created.revision.id}`;
  const profile = workshopManifest.workspace.runtimeProfiles[0];
  if (!profile || profile.provider !== "agent_kvm") {
    throw new Error("test fixture requires an agent_kvm runtime profile");
  }
  const db = drizzle(env.DB);
  await db.batch([
    db.insert(workshopRuntimeProfiles).values({
      id: runtimeProfileId,
      templateRevisionId: created.revision.id,
      profileId: profile.id,
      providerKind: profile.provider,
      vmId: profile.vmId,
      systemImage: profile.requestedSystemImage,
      architecture: profile.hardware.architecture,
      cpuMillis: profile.hardware.cpuMillis,
      memoryMib: profile.hardware.memoryMib,
      diskMib: profile.hardware.diskMib,
      locationsJson: [],
      configurationJson: {},
      createdAt: now,
    }),
    db.insert(workshopRuntimeProfileCertifications).values({
      id: `cert-${created.revision.id}`,
      runtimeProfileId,
      state: "verified",
      evidenceJson: { source: "test-fixture" },
      verifiedAt: now,
      deletionConfirmedAt: now,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(workshopRegistryTokens).values({
      id: `registry-token-${created.revision.id}`,
      organizationId: "org",
      name: "Published fixture token",
      tokenPrefix: "intar_fixture",
      tokenHash: `hash-${created.revision.id}`,
      createdBy: "owner",
      createdAt: now,
    }),
    db.insert(workshopPublications).values({
      id: `publication-${created.revision.id}`,
      organizationId: "org",
      workshopSlug: workshopManifest.workshop.slug,
      contentHash: created.revision.contentHash,
      sourceR2Key: `workshops/${created.revision.id}/source.tar.zst`,
      compiledManifestJson: workshopManifest as unknown as Record<
        string,
        unknown
      >,
      requiredCheckpointIdsJson: workshopManifest.workspace.checkpoints.map(
        (checkpoint) => checkpoint.id,
      ),
      status: "published",
      submittedBy: "owner",
      registryTokenId: `registry-token-${created.revision.id}`,
      publishedRevisionId: created.revision.id,
      certificationState: "verified",
      finishedAt: now,
      createdAt: now,
      updatedAt: now,
    }),
  ]);
  const session = await createWorkshopSession({
    organizationId: "org",
    actorUserId: "owner",
    templateRevisionId: created.revision.id,
    runtimeProvider: { profileId: "agent-x86" },
    title: "Runtime delivery",
    scheduledStartAt: Date.now() + 10 * 60_000,
  });
  await replaceWorkshopRoster({
    sessionId: session.id,
    actorUserId: "owner",
    members: [
      { userId: "owner", role: "facilitator" },
      { userId: "learner", role: "participant" },
      { userId: "late", role: "participant" },
    ],
  });
  await updateWorkshopSession({
    sessionId: session.id,
    actorUserId: "owner",
    expectedVersion: 1,
    state: "lobby",
  });
  await checkInToWorkshop({ sessionId: session.id, userId: "learner" });
  return { sessionId: session.id };
}

async function seedIdentityAndRunner() {
  const db = drizzle(env.DB);
  const now = Date.now();
  await db.batch([
    db
      .insert(user)
      .values([userRow("owner"), userRow("learner"), userRow("late")]),
    db.insert(organization).values({
      id: "org",
      name: "Organization",
      slug: "org",
      createdAt: new Date(now),
    }),
    db.insert(member).values([
      {
        id: "member-owner",
        organizationId: "org",
        userId: "owner",
        role: "owner",
        createdAt: new Date(now),
      },
      {
        id: "member-learner",
        organizationId: "org",
        userId: "learner",
        role: "member",
        createdAt: new Date(now),
      },
      {
        id: "member-late",
        organizationId: "org",
        userId: "late",
        role: "member",
        createdAt: new Date(now),
      },
    ]),
    db.insert(agentHosts).values({
      id: "runner",
      userId: "owner",
      organizationId: "org",
      name: "Runner",
      role: "agent",
      scenarioEnabled: true,
      disabled: false,
      connected: true,
      activeSessionId: "runner-session",
      lastHeartbeatAt: now,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(hostActualState).values({
      hostId: "runner",
      appliedDesiredVersion: 0,
      observedAt: now,
      reportJson: hostReport(now, "runner"),
      createdAt: now,
      updatedAt: now,
    }),
  ]);
  await grantFixtureBetaAccess({ d1: env.DB, userId: "owner", now });
}

async function seedRunner(hostId: string) {
  const db = drizzle(env.DB);
  const now = Date.now();
  await db.batch([
    db.insert(agentHosts).values({
      id: hostId,
      userId: "owner",
      organizationId: "org",
      name: hostId,
      role: "agent",
      scenarioEnabled: true,
      disabled: false,
      connected: true,
      activeSessionId: `${hostId}-session`,
      lastHeartbeatAt: now,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(hostActualState).values({
      hostId,
      appliedDesiredVersion: 0,
      observedAt: now,
      reportJson: hostReport(now, hostId),
      createdAt: now,
      updatedAt: now,
    }),
  ]);
}

function userRow(id: string): typeof user.$inferInsert {
  return {
    id,
    name: id,
    email: `${id}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function manifest(): WorkshopManifestV2 {
  return {
    schemaVersion: 2,
    workshop: {
      slug: "runtime-delivery",
      title: "Runtime delivery",
      summary: "Exercise runtime delivery.",
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
          requestedSystemImage: "runtime-delivery",
          immutableSystemImage: "runtime-delivery",
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
        checkpoint("checkpoint-00", "00", "a".repeat(64)),
        checkpoint("checkpoint-01", "01", "b".repeat(64)),
      ],
      initialCheckpointId: "checkpoint-00",
      applications: [],
    },
    modules: [
      {
        id: "setup",
        title: "Setup",
        tier: "gate",
        outcome: "Workspace is ready.",
        dependsOn: [],
        participantMarkdown: "Prepare the workspace.",
        facilitatorNotesMarkdown: "Observe readiness.",
        hints: [],
        solutionMarkdown: "Use the canonical setup.",
        probeIds: ["workspace-ready"],
        catchUpCheckpointId: "checkpoint-01",
      },
    ],
    agenda: [
      {
        id: "setup-agenda",
        kind: "lab",
        title: "Setup",
        durationMinutes: 60,
        scheduled: true,
        moduleId: "setup",
        slideIds: ["setup-slide"],
        release: "facilitator",
      },
    ],
    presentation: {
      slides: [
        {
          id: "setup-slide",
          layout: "content",
          title: "Setup",
          bodyMarkdown: "Prepare the workspace.",
          moduleId: "setup",
        },
      ],
    },
    durationMinutes: 60,
  };
}

function branchedRecoveryManifest(): WorkshopManifestV2 {
  const result = manifest();
  result.workspace.checkpoints.push(
    checkpoint("checkpoint-06", "06", "c".repeat(64)),
    checkpoint("checkpoint-07", "07", "d".repeat(64)),
  );
  result.modules.push(
    {
      id: "stretch-06",
      title: "Stretch 06",
      tier: "stretch",
      outcome: "Complete stretch 06.",
      dependsOn: ["setup"],
      participantMarkdown: "Build stretch 06.",
      facilitatorNotesMarkdown: "Coach stretch 06.",
      hints: [],
      solutionMarkdown: "Apply stretch 06.",
      probeIds: [],
      catchUpCheckpointId: "checkpoint-06",
    },
    {
      id: "stretch-07",
      title: "Stretch 07",
      tier: "stretch",
      outcome: "Complete stretch 07.",
      dependsOn: ["setup"],
      participantMarkdown: "Build stretch 07.",
      facilitatorNotesMarkdown: "Coach stretch 07.",
      hints: [],
      solutionMarkdown: "Apply stretch 07.",
      probeIds: [],
      catchUpCheckpointId: "checkpoint-07",
    },
  );
  for (const moduleId of ["stretch-06", "stretch-07"]) {
    result.agenda.push({
      id: `${moduleId}-agenda`,
      kind: "tinker",
      title: moduleId,
      durationMinutes: 0,
      scheduled: false,
      moduleId,
      slideIds: [`${moduleId}-slide`],
      release: "pool",
    });
    result.presentation.slides.push({
      id: `${moduleId}-slide`,
      layout: "content",
      title: moduleId,
      bodyMarkdown: `Build ${moduleId}.`,
      moduleId,
    });
  }
  return result;
}

function checkpoint(id: string, image: string, sha: string) {
  return {
    id,
    label: id,
    vmImages: [
      {
        vmId: "workspace",
        imageKey: checkpointImageKey(image),
        imageSha256: sha,
      },
    ],
  };
}

function checkpointImageKey(image: string) {
  return {
    scenario: `workshop-runtime-${image}`,
    vm: "workspace",
    arch: "x86_64" as const,
  };
}

function hostReport(now: number, hostId: string): HostStateReportV2 {
  return {
    schema_version: 2,
    host_id: hostId,
    observed_at_unix_ms: now,
    applied_desired_version: 0,
    capacity: {
      total_cpu_millis: 10_000,
      reserved_cpu_millis: 2_000,
      schedulable_cpu_millis: 8_000,
      committed_cpu_millis: 0,
      memory_total_mib: 65_536,
      memory_available_mib: 32_768,
      disk_probe_path: "/var/lib/intar",
      disk_total_mib: 409_600,
      disk_available_mib: 204_800,
    },
    capabilities: {
      arch: "x86_64",
      cloud_hypervisor_sha256: "c".repeat(64),
      boot_cpu_millis: 2_000,
      boot_cpu_lease_ms: 45_000,
      supports_kvm: true,
      supports_vsock: true,
      supports_reflink: true,
      supports_nftables: true,
      supports_jailer_v2: true,
      supports_boot_cpu_lease: true,
      supports_template_backed_launch: true,
      fast_template_store: true,
      supports_hard_cpu_quota: true,
      supports_landlock: true,
      supports_cgroup_v2: true,
      supports_run_cli_v1: true,
      supports_run_cli_completion_v1: true,
    },
    cached_images: [
      {
        image_key: checkpointImageKey("00"),
        image_sha256: "a".repeat(64),
        phase: "ready",
        updated_at_unix_ms: now,
      },
      {
        image_key: checkpointImageKey("01"),
        image_sha256: "b".repeat(64),
        phase: "ready",
        updated_at_unix_ms: now,
      },
    ],
    vms: [],
    builds: [],
  };
}

function readyVmReport(
  executionId: string,
  runtimeVmName: string,
  observedAt: number,
): VmActualStateV2 {
  return {
    run_id: executionId,
    vm_name: runtimeVmName,
    desired_version: 1,
    phase: "ready",
    image_key: checkpointImageKey("00"),
    image_sha256: "a".repeat(64),
    terminal: {
      state: "ready",
      target: {
        host: "192.0.2.50",
        port: 22,
        username: "learner",
        checked_at_unix_ms: observedAt,
      },
      observed_at_unix_ms: observedAt,
    },
    ssh_host_keys_openssh: ["ssh-ed25519 host-key"],
    probes: [],
    updated_at_unix_ms: observedAt,
  };
}
