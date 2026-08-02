import {
  and,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";
import {
  member,
  workshopEvents,
  workshopModuleProgress,
  workshopSessionMembers,
  workshopSessions,
  workshopWorkspaceGenerations,
  workshopWorkspaces,
} from "@/db/schema";
import { appError, errorChainMatches } from "@/lib/app-error";
import { createAppId } from "@/lib/id";
import {
  deleteStargateRoute,
  deleteStargateWorkspaceAppRoute,
} from "@/lib/stargate";
import {
  appendWorkshopEvent,
  loadWorkshopManifestForSession,
  requireWorkshopManager,
  requireWorkshopSessionMember,
  workshopCheckpointRequiredPrefixIds,
  workshopDb,
  workshopReleaseIncludesPrefix,
} from "./shared";
import { recordWorkshopModuleObservation } from "./progress";
import { requireFreshWorkshopProviderPreflight } from "./provider-preflight-state";
import { revokeWorkshopRouteIssuanceIntents } from "./route-issuance-intents";
import type {
  WorkshopGenerationStateUpdate,
  WorkshopProvisioningRequest,
} from "./types";

export async function prepareCheckedInWorkshopWorkspaces(params: {
  sessionId: string;
  actorUserId: string;
}): Promise<{
  requests: WorkshopProvisioningRequest[];
  alreadyProvisionedUserIds: string[];
}> {
  const access = await requireWorkshopManager({
    sessionId: params.sessionId,
    userId: params.actorUserId,
  });
  if (access.state !== "lobby" && access.state !== "live") {
    throw appError(
      409,
      "workshop_provisioning_closed",
      "workshop workspaces can only be provisioned in the lobby or live session",
    );
  }
  await requireFreshWorkshopProviderPreflight({ sessionId: params.sessionId });
  const context = await loadWorkshopManifestForSession(params.sessionId);
  const db = workshopDb();
  const participants = await db
    .select({ userId: workshopSessionMembers.userId })
    .from(workshopSessionMembers)
    .innerJoin(
      workshopSessions,
      eq(workshopSessionMembers.sessionId, workshopSessions.id),
    )
    .innerJoin(
      member,
      and(
        eq(member.organizationId, workshopSessions.organizationId),
        eq(member.userId, workshopSessionMembers.userId),
        isNull(member.workshopAccessRevokingAt),
      ),
    )
    .where(
      and(
        eq(workshopSessionMembers.sessionId, params.sessionId),
        eq(workshopSessionMembers.workspaceEnabled, true),
        isNotNull(workshopSessionMembers.checkedInAt),
      ),
    );
  if (!participants.length) {
    return { requests: [], alreadyProvisionedUserIds: [] };
  }

  const existing = await db
    .select({
      id: workshopWorkspaces.id,
      userId: workshopWorkspaces.userId,
      state: workshopWorkspaces.state,
      currentGenerationId: workshopWorkspaces.currentGenerationId,
    })
    .from(workshopWorkspaces)
    .where(
      and(
        eq(workshopWorkspaces.sessionId, params.sessionId),
        inArray(
          workshopWorkspaces.userId,
          participants.map((entry) => entry.userId),
        ),
      ),
    );
  const workspaceByUser = new Map(
    existing.map((entry) => [entry.userId, entry]),
  );
  const currentGenerationIds = existing.flatMap((entry) =>
    entry.currentGenerationId ? [entry.currentGenerationId] : [],
  );
  const currentGenerations = currentGenerationIds.length
    ? await db
        .select({
          id: workshopWorkspaceGenerations.id,
          ordinal: workshopWorkspaceGenerations.ordinal,
          checkpointId: workshopWorkspaceGenerations.checkpointId,
          runtimeExecutionId: workshopWorkspaceGenerations.runtimeExecutionId,
        })
        .from(workshopWorkspaceGenerations)
        .where(inArray(workshopWorkspaceGenerations.id, currentGenerationIds))
    : [];
  const generationById = new Map(
    currentGenerations.map((entry) => [entry.id, entry]),
  );
  const requests: WorkshopProvisioningRequest[] = [];
  const alreadyProvisionedUserIds: string[] = [];
  const now = Date.now();

  for (const participant of participants) {
    const workspace = workspaceByUser.get(participant.userId);
    const currentGeneration = workspace?.currentGenerationId
      ? generationById.get(workspace.currentGenerationId)
      : undefined;
    if (workspace && ["ready", "ending"].includes(workspace.state)) {
      alreadyProvisionedUserIds.push(participant.userId);
      continue;
    }
    if (
      workspace &&
      currentGeneration &&
      ["queued", "provisioning", "recovering"].includes(workspace.state)
    ) {
      requests.push({
        organizationId: context.organizationId,
        sessionId: params.sessionId,
        templateRevisionId: context.templateRevisionId,
        participantUserId: participant.userId,
        workspaceId: workspace.id,
        generationId: currentGeneration.id,
        generationOrdinal: currentGeneration.ordinal,
        checkpointId:
          currentGeneration.checkpointId ??
          context.manifest.workspace.initialCheckpointId,
        manifest: context.manifest,
      });
      continue;
    }
    if (
      workspace &&
      currentGeneration &&
      !currentGeneration.runtimeExecutionId &&
      ["queued", "provisioning", "failed"].includes(workspace.state)
    ) {
      await db.batch([
        db
          .update(workshopWorkspaceGenerations)
          .set({ state: "queued", error: null, failedAt: null, updatedAt: now })
          .where(eq(workshopWorkspaceGenerations.id, currentGeneration.id)),
        db
          .update(workshopWorkspaces)
          .set({ state: "queued", recoveryMessage: null, updatedAt: now })
          .where(eq(workshopWorkspaces.id, workspace.id)),
        db
          .update(workshopSessionMembers)
          .set({
            provisionState: "queued",
            provisionError: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(workshopSessionMembers.sessionId, params.sessionId),
              eq(workshopSessionMembers.userId, participant.userId),
            ),
          ),
      ]);
      requests.push({
        organizationId: context.organizationId,
        sessionId: params.sessionId,
        templateRevisionId: context.templateRevisionId,
        participantUserId: participant.userId,
        workspaceId: workspace.id,
        generationId: currentGeneration.id,
        generationOrdinal: currentGeneration.ordinal,
        checkpointId:
          currentGeneration.checkpointId ??
          context.manifest.workspace.initialCheckpointId,
        manifest: context.manifest,
      });
      continue;
    }
    const workspaceId = workspace?.id ?? createAppId();
    const ordinal = workspace ? await nextGenerationOrdinal(workspace.id) : 1;
    const generationId = createAppId();
    try {
      if (!workspace) {
        await db.batch([
          db.insert(workshopWorkspaces).values({
            id: workspaceId,
            sessionId: params.sessionId,
            userId: participant.userId,
            state: "queued",
            currentGenerationId: generationId,
            lastCheckpointId: context.manifest.workspace.initialCheckpointId,
            createdAt: now,
            updatedAt: now,
          }),
          db.insert(workshopWorkspaceGenerations).values({
            id: generationId,
            workspaceId,
            ordinal,
            checkpointId: context.manifest.workspace.initialCheckpointId,
            state: "queued",
            requestedAt: now,
            createdAt: now,
            updatedAt: now,
          }),
          db
            .update(workshopSessionMembers)
            .set({
              provisionState: "queued",
              provisionError: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(workshopSessionMembers.sessionId, params.sessionId),
                eq(workshopSessionMembers.userId, participant.userId),
              ),
            ),
        ]);
      } else {
        await db.batch([
          db
            .update(workshopWorkspaces)
            .set({
              state: "recovering",
              currentGenerationId: generationId,
              lastCheckpointId: context.manifest.workspace.initialCheckpointId,
              recoveryMessage: null,
              endedAt: null,
              updatedAt: now,
            })
            .where(eq(workshopWorkspaces.id, workspaceId)),
          db.insert(workshopWorkspaceGenerations).values({
            id: generationId,
            workspaceId,
            ordinal,
            checkpointId: context.manifest.workspace.initialCheckpointId,
            state: "queued",
            requestedAt: now,
            createdAt: now,
            updatedAt: now,
          }),
          db
            .update(workshopSessionMembers)
            .set({
              provisionState: "queued",
              provisionError: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(workshopSessionMembers.sessionId, params.sessionId),
                eq(workshopSessionMembers.userId, participant.userId),
              ),
            ),
        ]);
      }
    } catch (error) {
      if (errorChainMatches(error, /UNIQUE constraint failed/i)) {
        throw appError(
          409,
          "workshop_provisioning_conflict",
          "workshop workspace provisioning was started concurrently",
        );
      }
      throw error;
    }
    requests.push({
      organizationId: context.organizationId,
      sessionId: params.sessionId,
      templateRevisionId: context.templateRevisionId,
      participantUserId: participant.userId,
      workspaceId,
      generationId,
      generationOrdinal: ordinal,
      checkpointId: context.manifest.workspace.initialCheckpointId,
      manifest: context.manifest,
    });
  }
  if (requests.length) {
    await appendWorkshopEvent(db, {
      organizationId: access.organizationId,
      sessionId: params.sessionId,
      actorUserId: params.actorUserId,
      type: "workspace.provisioning_requested",
      payload: {
        participantUserIds: requests.map((entry) => entry.participantUserId),
      },
      createdAt: now,
    });
  }
  return { requests, alreadyProvisionedUserIds };
}

export async function prepareWorkshopCheckpointRestore(params: {
  sessionId: string;
  workspaceId: string;
  checkpointId: string;
  actorUserId: string;
}): Promise<WorkshopProvisioningRequest> {
  const context = await loadWorkshopManifestForSession(params.sessionId);
  if (
    !context.manifest.workspace.checkpoints.some(
      (checkpoint) => checkpoint.id === params.checkpointId,
    )
  ) {
    throw appError(
      404,
      "workshop_checkpoint_not_found",
      "workshop checkpoint not found",
    );
  }
  const caughtUpModuleIds =
    workshopCheckpointRequiredPrefixIds(
      context.manifest,
      params.checkpointId,
    ) ?? [];
  const db = workshopDb();
  const workspaces = await db
    .select({
      userId: workshopWorkspaces.userId,
      currentGenerationId: workshopWorkspaces.currentGenerationId,
      routeUsernames: workshopWorkspaces.terminalRouteUsernamesJson,
      applicationRouteIds: workshopWorkspaces.applicationRouteIdsJson,
    })
    .from(workshopWorkspaces)
    .where(
      and(
        eq(workshopWorkspaces.id, params.workspaceId),
        eq(workshopWorkspaces.sessionId, params.sessionId),
      ),
    )
    .limit(1);
  const workspace = workspaces[0];
  if (!workspace) {
    throw appError(
      404,
      "workshop_workspace_not_found",
      "workshop workspace not found",
    );
  }
  const actorAccess =
    workspace.userId === params.actorUserId
      ? await requireWorkshopSessionMember({
          sessionId: params.sessionId,
          userId: params.actorUserId,
        })
      : await requireWorkshopManager({
          sessionId: params.sessionId,
          userId: params.actorUserId,
        });
  if (
    workspace.userId === params.actorUserId &&
    "role" in actorAccess &&
    !actorAccess.workspaceEnabled
  ) {
    throw appError(
      403,
      "workshop_participant_required",
      "only a participant can restore their own workspace",
    );
  }
  if (actorAccess.state !== "lobby" && actorAccess.state !== "live") {
    throw appError(
      409,
      "workshop_restore_closed",
      "checkpoint restore is only available in the lobby or live session",
    );
  }
  const currentGeneration = workspace.currentGenerationId
    ? (
        await db
          .select({
            id: workshopWorkspaceGenerations.id,
            ordinal: workshopWorkspaceGenerations.ordinal,
            checkpointId: workshopWorkspaceGenerations.checkpointId,
            state: workshopWorkspaceGenerations.state,
            runtimeExecutionId: workshopWorkspaceGenerations.runtimeExecutionId,
          })
          .from(workshopWorkspaceGenerations)
          .where(
            and(
              eq(
                workshopWorkspaceGenerations.id,
                workspace.currentGenerationId,
              ),
              eq(workshopWorkspaceGenerations.workspaceId, params.workspaceId),
            ),
          )
          .limit(1)
      )[0]
    : undefined;
  const reusableGeneration =
    currentGeneration &&
    !currentGeneration.runtimeExecutionId &&
    (currentGeneration.state === "queued" ||
      currentGeneration.state === "failed")
      ? currentGeneration
      : undefined;
  if (
    reusableGeneration &&
    reusableGeneration.checkpointId !== params.checkpointId
  ) {
    throw appError(
      409,
      "workshop_restore_already_pending",
      "retry the pending checkpoint restore before selecting another checkpoint",
    );
  }
  const ordinal =
    reusableGeneration?.ordinal ??
    (await nextGenerationOrdinal(params.workspaceId));
  const generationId = reusableGeneration?.id ?? createAppId();
  const now = Date.now();
  const resetOrInsertGeneration = reusableGeneration
    ? db
        .update(workshopWorkspaceGenerations)
        .set({
          state: "queued",
          error: null,
          failedAt: null,
          requestedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(workshopWorkspaceGenerations.id, generationId),
            eq(workshopWorkspaceGenerations.workspaceId, params.workspaceId),
            isNull(workshopWorkspaceGenerations.runtimeExecutionId),
            inArray(workshopWorkspaceGenerations.state, ["queued", "failed"]),
          ),
        )
    : db.insert(workshopWorkspaceGenerations).values({
        id: generationId,
        workspaceId: params.workspaceId,
        ordinal,
        checkpointId: params.checkpointId,
        state: "queued",
        requestedAt: now,
        createdAt: now,
        updatedAt: now,
      });
  const expectedCurrentGeneration = reusableGeneration
    ? eq(workshopWorkspaces.currentGenerationId, generationId)
    : workspace.currentGenerationId
      ? eq(
          workshopWorkspaces.currentGenerationId,
          workspace.currentGenerationId,
        )
      : isNull(workshopWorkspaces.currentGenerationId);
  const commonMutations = [
    db
      .update(workshopWorkspaces)
      .set({
        state: "recovering",
        currentGenerationId: generationId,
        lastCheckpointId: params.checkpointId,
        recoveryMessage: "Restoring the selected canonical checkpoint",
        updatedAt: now,
      })
      .where(
        and(
          eq(workshopWorkspaces.id, params.workspaceId),
          expectedCurrentGeneration,
        ),
      ),
    db
      .update(workshopSessionMembers)
      .set({
        provisionState: "queued",
        provisionError: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(workshopSessionMembers.sessionId, params.sessionId),
          eq(workshopSessionMembers.userId, workspace.userId),
        ),
      ),
    db
      .insert(workshopEvents)
      .values({
        id: workshopGenerationEventId("checkpoint-restore", generationId),
        organizationId: actorAccess.organizationId,
        sessionId: params.sessionId,
        actorUserId: params.actorUserId,
        type: "workspace.checkpoint_restore_requested",
        payloadJson: {
          generationId,
          workspaceId: params.workspaceId,
          participantUserId: workspace.userId,
          checkpointId: params.checkpointId,
          generationOrdinal: ordinal,
          caughtUpModuleIds,
        },
        createdAt: now,
      })
      .onConflictDoNothing(),
  ] as const;
  if (reusableGeneration) {
    const results = await db.batch([
      resetOrInsertGeneration,
      ...commonMutations,
    ]);
    if (results[0].meta.changes !== 1) {
      throw appError(
        409,
        "workshop_restore_request_stale",
        "the pending checkpoint restore changed; reload before retrying",
      );
    }
  } else {
    await db.batch([
      db
        .update(workshopWorkspaceGenerations)
        .set({
          state: "archiving",
          archiveRequestedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(workshopWorkspaceGenerations.workspaceId, params.workspaceId),
            inArray(workshopWorkspaceGenerations.state, [
              "queued",
              "provisioning",
              "ready",
              "failed",
            ]),
          ),
        ),
      resetOrInsertGeneration,
      ...commonMutations,
    ]);
  }
  await markWorkshopCheckpointCoverageCaughtUp({
    sessionId: params.sessionId,
    participantUserId: workspace.userId,
    actorUserId: params.actorUserId,
    moduleIds: caughtUpModuleIds,
    observedAt: now,
  });
  const [intentCleanup, recordedRouteCleanup] = await Promise.allSettled([
    revokeWorkshopRouteIssuanceIntents({ workspaceId: params.workspaceId }),
    Promise.all([
      ...workspace.routeUsernames.map((route) => deleteStargateRoute(route)),
      ...workspace.applicationRouteIds.map((route) =>
        deleteStargateWorkspaceAppRoute(route),
      ),
    ]),
  ]);
  if (recordedRouteCleanup.status === "rejected") {
    throw recordedRouteCleanup.reason;
  }
  if (workspace.routeUsernames.length || workspace.applicationRouteIds.length) {
    await db
      .update(workshopWorkspaces)
      .set({
        terminalRouteUsernamesJson: [],
        applicationRouteIdsJson: [],
        updatedAt: now,
      })
      .where(
        and(
          eq(workshopWorkspaces.id, params.workspaceId),
          eq(workshopWorkspaces.currentGenerationId, generationId),
        ),
      );
  }
  if (intentCleanup.status === "rejected") throw intentCleanup.reason;
  return {
    organizationId: context.organizationId,
    sessionId: params.sessionId,
    templateRevisionId: context.templateRevisionId,
    participantUserId: workspace.userId,
    workspaceId: params.workspaceId,
    generationId,
    generationOrdinal: ordinal,
    checkpointId: params.checkpointId,
    manifest: context.manifest,
  };
}

export async function prepareWorkshopLateJoin(params: {
  sessionId: string;
  participantUserId: string;
  checkpointId: string;
  actorUserId: string;
}): Promise<WorkshopProvisioningRequest> {
  const access = await requireWorkshopManager({
    sessionId: params.sessionId,
    userId: params.actorUserId,
  });
  if (access.state !== "lobby" && access.state !== "live") {
    throw appError(
      409,
      "workshop_late_join_closed",
      "late-join catch-up is available only while the workshop room is open",
    );
  }
  const context = await loadWorkshopManifestForSession(params.sessionId);
  if (
    !context.manifest.workspace.checkpoints.some(
      (checkpoint) => checkpoint.id === params.checkpointId,
    )
  ) {
    throw appError(
      404,
      "workshop_checkpoint_not_found",
      "workshop checkpoint not found",
    );
  }
  const db = workshopDb();
  const sessions = await db
    .select({ releasedModuleIds: workshopSessions.releasedModuleIdsJson })
    .from(workshopSessions)
    .where(eq(workshopSessions.id, params.sessionId))
    .limit(1);
  const requiredModuleIds = workshopCheckpointRequiredPrefixIds(
    context.manifest,
    params.checkpointId,
  );
  if (
    !requiredModuleIds ||
    !workshopReleaseIncludesPrefix(
      sessions[0]?.releasedModuleIds ?? [],
      requiredModuleIds,
    )
  ) {
    throw appError(
      409,
      "workshop_checkpoint_not_released",
      "this workshop checkpoint has not been released",
    );
  }
  const participants = await db
    .select({ id: workshopSessionMembers.id })
    .from(workshopSessionMembers)
    .where(
      and(
        eq(workshopSessionMembers.sessionId, params.sessionId),
        eq(workshopSessionMembers.userId, params.participantUserId),
        eq(workshopSessionMembers.workspaceEnabled, true),
      ),
    )
    .limit(1);
  if (!participants[0]) {
    throw appError(
      404,
      "workshop_participant_not_found",
      "workshop participant not found",
    );
  }
  const existing = await db
    .select({ id: workshopWorkspaces.id })
    .from(workshopWorkspaces)
    .where(
      and(
        eq(workshopWorkspaces.sessionId, params.sessionId),
        eq(workshopWorkspaces.userId, params.participantUserId),
      ),
    )
    .limit(1);
  const now = Date.now();
  let request: WorkshopProvisioningRequest;
  if (existing[0]) {
    request = await prepareWorkshopCheckpointRestore({
      sessionId: params.sessionId,
      workspaceId: existing[0].id,
      checkpointId: params.checkpointId,
      actorUserId: params.actorUserId,
    });
  } else {
    const workspaceId = createAppId();
    const generationId = createAppId();
    await db.batch([
      db.insert(workshopWorkspaces).values({
        id: workspaceId,
        sessionId: params.sessionId,
        userId: params.participantUserId,
        state: "queued",
        currentGenerationId: generationId,
        lastCheckpointId: params.checkpointId,
        recoveryMessage: `Joining from canonical checkpoint ${params.checkpointId}`,
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(workshopWorkspaceGenerations).values({
        id: generationId,
        workspaceId,
        ordinal: 1,
        checkpointId: params.checkpointId,
        state: "queued",
        requestedAt: now,
        createdAt: now,
        updatedAt: now,
      }),
      db
        .update(workshopSessionMembers)
        .set({
          checkedInAt: sql`coalesce(${workshopSessionMembers.checkedInAt}, ${now})`,
          provisionState: "queued",
          provisionError: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(workshopSessionMembers.sessionId, params.sessionId),
            eq(workshopSessionMembers.userId, params.participantUserId),
          ),
        ),
    ]);
    request = {
      organizationId: context.organizationId,
      sessionId: params.sessionId,
      templateRevisionId: context.templateRevisionId,
      participantUserId: params.participantUserId,
      workspaceId,
      generationId,
      generationOrdinal: 1,
      checkpointId: params.checkpointId,
      manifest: context.manifest,
    };
  }
  const predecessorIndex = context.manifest.modules.reduce(
    (latest, module, index) =>
      module.catchUpCheckpointId === params.checkpointId ? index : latest,
    -1,
  );
  const caughtUpModuleIds = context.manifest.modules
    .slice(0, predecessorIndex + 1)
    .map((module) => module.id);
  if (!existing[0]) {
    await markWorkshopCheckpointCoverageCaughtUp({
      sessionId: params.sessionId,
      participantUserId: params.participantUserId,
      actorUserId: params.actorUserId,
      moduleIds: caughtUpModuleIds,
      observedAt: now,
    });
  }
  await appendWorkshopEvent(db, {
    organizationId: access.organizationId,
    sessionId: params.sessionId,
    actorUserId: params.actorUserId,
    type: "workspace.late_join_catch_up_requested",
    payload: {
      participantUserId: params.participantUserId,
      workspaceId: request.workspaceId,
      generationId: request.generationId,
      checkpointId: params.checkpointId,
      caughtUpModuleIds,
    },
    createdAt: now,
  });
  return request;
}

export async function recordWorkshopGenerationState(params: {
  generationId: string;
  update: WorkshopGenerationStateUpdate;
}): Promise<void> {
  const db = workshopDb();
  const rows = await db
    .select({
      generationId: workshopWorkspaceGenerations.id,
      generationRuntimeExecutionId:
        workshopWorkspaceGenerations.runtimeExecutionId,
      generationHostId: workshopWorkspaceGenerations.hostId,
      workspaceId: workshopWorkspaces.id,
      workspaceState: workshopWorkspaces.state,
      currentGenerationId: workshopWorkspaces.currentGenerationId,
      recoveryMessage: workshopWorkspaces.recoveryMessage,
      sessionId: workshopWorkspaces.sessionId,
      sessionState: workshopSessions.state,
      userId: workshopWorkspaces.userId,
      organizationId: workshopSessions.organizationId,
      provisioningStartedAt: workshopWorkspaceGenerations.provisioningStartedAt,
      readyAt: workshopWorkspaceGenerations.readyAt,
      archiveRequestedAt: workshopWorkspaceGenerations.archiveRequestedAt,
      archivedAt: workshopWorkspaceGenerations.archivedAt,
      failedAt: workshopWorkspaceGenerations.failedAt,
    })
    .from(workshopWorkspaceGenerations)
    .innerJoin(
      workshopWorkspaces,
      eq(workshopWorkspaceGenerations.workspaceId, workshopWorkspaces.id),
    )
    .innerJoin(
      workshopSessions,
      eq(workshopWorkspaces.sessionId, workshopSessions.id),
    )
    .where(eq(workshopWorkspaceGenerations.id, params.generationId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw appError(
      404,
      "workshop_generation_not_found",
      "workshop workspace generation not found",
    );
  }
  const now = params.update.observedAt ?? Date.now();
  const state = params.update.state;
  if (
    params.update.runtimeExecutionId &&
    row.generationRuntimeExecutionId &&
    params.update.runtimeExecutionId !== row.generationRuntimeExecutionId
  ) {
    throw appError(
      409,
      "workshop_generation_runtime_mismatch",
      "workshop generation is already linked to another runtime execution",
    );
  }
  if (
    params.update.hostId &&
    row.generationHostId &&
    params.update.hostId !== row.generationHostId
  ) {
    throw appError(
      409,
      "workshop_generation_host_mismatch",
      "workshop generation is already linked to another runner",
    );
  }
  const isCurrent = row.currentGenerationId === params.generationId;
  const cleanupProjection = state === "archiving" || state === "archived";
  const activeSessionFence = () =>
    exists(
      db
        .select({ id: workshopSessions.id })
        .from(workshopSessions)
        .innerJoin(
          member,
          and(
            eq(member.organizationId, workshopSessions.organizationId),
            eq(member.userId, row.userId),
            isNull(member.workshopAccessRevokingAt),
          ),
        )
        .where(
          and(
            eq(workshopSessions.id, row.sessionId),
            inArray(workshopSessions.state, ["lobby", "live"]),
          ),
        ),
    );
  const generationUpdate = db
    .update(workshopWorkspaceGenerations)
    .set({
      state,
      runtimeExecutionId:
        params.update.runtimeExecutionId ?? row.generationRuntimeExecutionId,
      hostId: params.update.hostId ?? row.generationHostId,
      error: params.update.error ?? null,
      provisioningStartedAt:
        state === "provisioning" ? now : row.provisioningStartedAt,
      readyAt: state === "ready" ? now : row.readyAt,
      archiveRequestedAt: state === "archiving" ? now : row.archiveRequestedAt,
      archivedAt: state === "archived" ? now : row.archivedAt,
      failedAt: state === "failed" ? now : row.failedAt,
      updatedAt: now,
    })
    .where(
      and(
        eq(workshopWorkspaceGenerations.id, params.generationId),
        cleanupProjection ? undefined : activeSessionFence(),
      ),
    );
  if (!isCurrent) {
    const result = await generationUpdate;
    if (!cleanupProjection && result.meta.changes !== 1) {
      throw appError(
        409,
        "workshop_generation_stale",
        "workshop generation is no longer active",
      );
    }
    await appendWorkshopEvent(db, {
      organizationId: row.organizationId,
      sessionId: row.sessionId,
      type: `workspace.generation_${state}`,
      payload: {
        generationId: params.generationId,
        workspaceId: row.workspaceId,
        runtimeExecutionId:
          params.update.runtimeExecutionId ?? row.generationRuntimeExecutionId,
        hostId: params.update.hostId ?? row.generationHostId,
        staleGeneration: true,
      },
      createdAt: now,
    });
    return;
  }
  const results = await db.batch([
    generationUpdate,
    db
      .update(workshopWorkspaces)
      .set({
        state:
          row.sessionState === "ended" || row.sessionState === "cancelled"
            ? state === "archived"
              ? "ended"
              : "ending"
            : state === "ready"
              ? "ready"
              : state === "failed"
                ? "failed"
                : state === "archiving"
                  ? "ending"
                  : state === "archived"
                    ? "ended"
                    : row.workspaceState === "recovering"
                      ? "recovering"
                      : "provisioning",
        recoveryMessage:
          state === "failed"
            ? (params.update.error ?? row.recoveryMessage)
            : row.recoveryMessage,
        updatedAt: now,
      })
      .where(
        and(
          eq(workshopWorkspaces.id, row.workspaceId),
          eq(workshopWorkspaces.currentGenerationId, params.generationId),
          cleanupProjection ? undefined : activeSessionFence(),
        ),
      ),
    db
      .update(workshopSessionMembers)
      .set({
        provisionState:
          row.sessionState === "ended" || row.sessionState === "cancelled"
            ? "ended"
            : state === "ready"
              ? "ready"
              : state === "failed"
                ? "failed"
                : state === "archived"
                  ? "ended"
                  : "provisioning",
        provisionError:
          state === "failed" ? (params.update.error ?? null) : null,
        updatedAt: now,
      })
      .where(
        and(
          eq(workshopSessionMembers.sessionId, row.sessionId),
          eq(workshopSessionMembers.userId, row.userId),
          exists(
            db
              .select({ id: workshopWorkspaces.id })
              .from(workshopWorkspaces)
              .where(
                and(
                  eq(workshopWorkspaces.id, row.workspaceId),
                  eq(
                    workshopWorkspaces.currentGenerationId,
                    params.generationId,
                  ),
                ),
              ),
          ),
          cleanupProjection ? undefined : activeSessionFence(),
        ),
      ),
  ]);
  if (!cleanupProjection && results[0].meta.changes !== 1) {
    throw appError(
      409,
      "workshop_generation_stale",
      "workshop generation is no longer active",
    );
  }
  await appendWorkshopEvent(db, {
    organizationId: row.organizationId,
    sessionId: row.sessionId,
    type: `workspace.generation_${state}`,
    payload: {
      generationId: params.generationId,
      workspaceId: row.workspaceId,
      runtimeExecutionId: params.update.runtimeExecutionId ?? null,
      hostId: params.update.hostId ?? null,
      error: params.update.error ?? null,
      currentGeneration: row.currentGenerationId === params.generationId,
    },
    createdAt: now,
  });
  if (state === "ready") {
    await applyCheckpointCatchUpAfterReady({
      generationId: params.generationId,
      organizationId: row.organizationId,
      sessionId: row.sessionId,
      participantUserId: row.userId,
      observedAt: now,
    });
  }
}

async function applyCheckpointCatchUpAfterReady(params: {
  generationId: string;
  organizationId: string;
  sessionId: string;
  participantUserId: string;
  observedAt: number;
}): Promise<void> {
  const db = workshopDb();
  const requests = await db
    .select({
      actorUserId: workshopEvents.actorUserId,
      payload: workshopEvents.payloadJson,
    })
    .from(workshopEvents)
    .where(
      and(
        eq(workshopEvents.sessionId, params.sessionId),
        inArray(workshopEvents.type, [
          "workspace.checkpoint_restore_requested",
          "workspace.late_join_catch_up_requested",
        ]),
      ),
    )
    .orderBy(desc(workshopEvents.createdAt));
  const request = requests.find(
    (event) => event.payload.generationId === params.generationId,
  );
  if (!request) return;

  const appliedEvents = await db
    .select({ payload: workshopEvents.payloadJson })
    .from(workshopEvents)
    .where(
      and(
        eq(workshopEvents.sessionId, params.sessionId),
        eq(workshopEvents.type, "workspace.checkpoint_catch_up_applied"),
      ),
    );
  if (
    appliedEvents.some(
      (event) => event.payload.generationId === params.generationId,
    )
  ) {
    return;
  }

  const requestedModuleIds = Array.isArray(request.payload.caughtUpModuleIds)
    ? request.payload.caughtUpModuleIds.filter(
        (moduleId): moduleId is string => typeof moduleId === "string",
      )
    : [];
  const existing = requestedModuleIds.length
    ? await db
        .select({
          moduleId: workshopModuleProgress.moduleId,
          technicalStatus: workshopModuleProgress.technicalStatus,
          caughtUpAt: workshopModuleProgress.caughtUpAt,
        })
        .from(workshopModuleProgress)
        .where(
          and(
            eq(workshopModuleProgress.sessionId, params.sessionId),
            eq(workshopModuleProgress.userId, params.participantUserId),
            inArray(workshopModuleProgress.moduleId, requestedModuleIds),
          ),
        )
    : [];
  const existingByModule = new Map(existing.map((row) => [row.moduleId, row]));
  for (const moduleId of requestedModuleIds) {
    const progress = existingByModule.get(moduleId);
    if (
      progress &&
      (progress.technicalStatus === "verified" || progress.caughtUpAt !== null)
    ) {
      continue;
    }
    await recordWorkshopModuleObservation({
      sessionId: params.sessionId,
      participantUserId: params.participantUserId,
      moduleId,
      actorUserId: request.actorUserId,
      technicalStatus: "caught_up",
      observedAt: params.observedAt,
    });
  }
  await appendWorkshopEvent(db, {
    organizationId: params.organizationId,
    sessionId: params.sessionId,
    actorUserId: request.actorUserId,
    type: "workspace.checkpoint_catch_up_applied",
    payload: {
      participantUserId: params.participantUserId,
      generationId: params.generationId,
      caughtUpModuleIds: requestedModuleIds,
    },
    createdAt: params.observedAt,
  });
}

async function markWorkshopCheckpointCoverageCaughtUp(params: {
  sessionId: string;
  participantUserId: string;
  actorUserId: string | null;
  moduleIds: readonly string[];
  observedAt: number;
}): Promise<void> {
  for (const moduleId of params.moduleIds) {
    await recordWorkshopModuleObservation({
      sessionId: params.sessionId,
      participantUserId: params.participantUserId,
      moduleId,
      actorUserId: params.actorUserId,
      technicalStatus: "caught_up",
      observedAt: params.observedAt,
    });
  }
}

async function nextGenerationOrdinal(workspaceId: string): Promise<number> {
  const rows = await workshopDb()
    .select({ ordinal: workshopWorkspaceGenerations.ordinal })
    .from(workshopWorkspaceGenerations)
    .where(eq(workshopWorkspaceGenerations.workspaceId, workspaceId))
    .orderBy(desc(workshopWorkspaceGenerations.ordinal))
    .limit(1);
  return (rows[0]?.ordinal ?? 0) + 1;
}

function workshopGenerationEventId(kind: string, generationId: string): string {
  return `workshop-${kind}-${generationId}`;
}
