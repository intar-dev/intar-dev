import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  max,
  or,
} from "drizzle-orm";
import {
  agentHosts,
  hostActualState,
  hostResourceReservations,
  providerConnections,
  runtimeActualState,
  runtimeExecutions,
  runtimeGuestReports,
  runtimeProviderCostLedger,
  runtimeVmActualState,
  runtimeVms,
  user,
  workshopSessionCostForecasts,
  workshopSessionCostSummaries,
  workshopSessions,
  workshopSessionRuntimeSelections,
  workshopSessionMembers,
  workshopAssistGrants,
  workshopHelpRequests,
  workshopModuleProgress,
  workshopWorkspaceGenerations,
  workshopWorkspaces,
  type WorkshopManifestV2,
  type WorkshopTechnicalStatus,
  type WorkshopWorkspaceState,
} from "@/db/schema";
import { isOrganizationAdminRole } from "@/lib/organizations";
import {
  workshopStatusDigest,
  type WorkshopSessionStatusResponse,
} from "./status-contract";
import {
  canExtendWorkshopAssist,
  listActiveWorkshopAssistGrants,
} from "./assistance";
import { getWorkshopCapacityPreflight } from "./capacity";
import { workshopPresenceState } from "./presence";
import { listWorkshopProgress } from "./progress";
import {
  loadWorkshopManifestForSession,
  requireWorkshopSessionMember,
  type WorkshopSessionAccess,
  workshopCheckpointRequiredPrefixIds,
  workshopDb,
  workshopReleaseIncludesPrefix,
} from "./shared";
import { loadWorkshopSession } from "./sessions";
import type { WorkshopHelpRequestRecord } from "./types";

const STATUS_TIME_BUCKET_MS = 15_000;

export interface WorkshopSessionStatusPreflight {
  version: string;
  managerVersion: string | null;
  requiresFullRefresh: boolean;
  observedAt: number;
  access: WorkshopSessionAccess;
  canFacilitate: boolean;
  canAssist: boolean;
  canSeeRoomProgress: boolean;
  canSeeManagerOperations: boolean;
}

export async function getWorkshopSessionStatus(params: {
  sessionId: string;
  userId: string;
  knownSessionVersion?: number | null;
  knownManagerVersion?: string | null;
  preflight?: WorkshopSessionStatusPreflight;
}): Promise<WorkshopSessionStatusResponse> {
  const preflight =
    params.preflight ?? (await getWorkshopSessionStatusPreflight(params));
  const {
    access,
    canFacilitate,
    canAssist,
    canSeeRoomProgress,
    observedAt,
  } = preflight;
  const progressUserId = canSeeRoomProgress ? undefined : params.userId;
  const workspaceUserId = canSeeRoomProgress ? undefined : params.userId;

  const [
    session,
    context,
    roster,
    progress,
    workspaces,
    helpRequests,
    activeGrants,
    runtimeSelectionRows,
  ] = await Promise.all([
    loadWorkshopSession(params.sessionId),
    loadWorkshopManifestForSession(params.sessionId),
    loadWorkshopStatusRoster(params.sessionId, progressUserId),
    listWorkshopProgress(params.sessionId, progressUserId),
    loadWorkshopStatusWorkspaces(params.sessionId, workspaceUserId),
    loadActiveWorkshopStatusHelpRequests(
      params.sessionId,
      canSeeRoomProgress ? undefined : params.userId,
    ),
    listActiveWorkshopAssistGrants({
      sessionId: params.sessionId,
      ...(canSeeRoomProgress ? {} : { userId: params.userId }),
      now: observedAt,
    }),
    workshopDb()
      .select({
        kind: workshopSessionRuntimeSelections.providerKind,
      })
      .from(workshopSessionRuntimeSelections)
      .where(eq(workshopSessionRuntimeSelections.sessionId, params.sessionId))
      .limit(1),
  ]);

  const activeHelpRequests = helpRequests;
  const probes =
    canSeeRoomProgress || access.workspaceEnabled
      ? await loadCurrentWorkshopProbeReports({
          sessionId: params.sessionId,
          manifest: context.manifest,
          ...(canSeeRoomProgress ? {} : { userId: params.userId }),
        })
      : new Map<string, CurrentWorkshopProbeReport>();
  const capacity =
    canFacilitate &&
    (session.state === "lobby" || session.state === "live") &&
    runtimeSelectionRows[0]?.kind === "agent_kvm"
      ? await getWorkshopCapacityPreflight({
          sessionId: params.sessionId,
          now: observedAt,
        })
      : undefined;
  const managerVersion = preflight.managerVersion;
  const ownHelp =
    activeHelpRequests.find(
      (request) => request.requesterUserId === params.userId,
    ) ?? null;
  const ownGrant =
    activeGrants.find((grant) => grant.learnerUserId === params.userId) ??
    null;
  const ownWorkspace =
    workspaces.find((workspace) => workspace.userId === params.userId) ?? null;
  const userNames = new Map(roster.map((entry) => [entry.userId, entry.name]));
  const referencedUserIds = [ownHelp?.claimedBy, ownGrant?.helperUserId].flatMap(
    (userId) => (userId && !userNames.has(userId) ? [userId] : []),
  );
  if (referencedUserIds.length) {
    const nameRows = await workshopDb()
      .select({ id: user.id, name: user.name })
      .from(user)
      .where(inArray(user.id, referencedUserIds));
    for (const entry of nameRows) userNames.set(entry.id, entry.name);
  }
  const probeReports = probes;

  const snapshot = {
    managerVersion,
    session: {
      id: session.id,
      version: session.version,
      state: session.state,
      observedAt,
      currentAgendaItemId: session.currentAgendaItemId,
      currentModuleId: session.currentModuleId,
      currentSlideId: session.currentSlideId,
      releasedModuleIds: [...session.releasedModuleIds],
      revealedSolutionModuleIds: [...session.revealedSolutionModuleIds],
      announcement: session.announcement,
      timer:
        session.timerStartedAt !== null || session.timerPausedAt !== null
          ? {
              startedAt: session.timerStartedAt,
              endsAt: session.timerEndsAt,
              pausedAt: session.timerPausedAt,
              remainingMs: session.timerRemainingMs,
            }
          : null,
    },
    viewer: {
      userId: params.userId,
      role: access.role,
      workspaceEnabled: access.workspaceEnabled,
      checkedIn:
        roster.find((entry) => entry.userId === params.userId)?.checkedInAt !=
        null,
      canFacilitate,
      canPresent: canFacilitate,
      canAssist,
    },
    modules: projectWorkshopStatusModules({
      manifest: context.manifest,
      session,
      progress,
      ...(access.workspaceEnabled
        ? { participantUserId: params.userId }
        : {}),
      facilitator: canFacilitate,
      verificationExpected:
        access.workspaceEnabled && ownWorkspace?.state === "ready",
      probeReport: access.workspaceEnabled
        ? (probeReports.get(params.userId) ?? null)
        : null,
    }),
    agenda: projectWorkshopStatusAgenda({
      manifest: context.manifest,
      session,
      progress: progress.filter((entry) => entry.userId === params.userId),
    }),
    checkpoints: context.manifest.workspace.checkpoints.map((checkpoint) => ({
      id: checkpoint.id,
      released: workshopReleaseIncludesPrefix(
        session.releasedModuleIds,
        workshopCheckpointRequiredPrefixIds(context.manifest, checkpoint.id) ??
          [],
      ),
    })),
    slides: context.manifest.presentation.slides.map((slide) => ({
      id: slide.id,
      released: workshopSlideReleased({
        manifest: context.manifest,
        session,
        slide,
        facilitator: canFacilitate,
      }),
    })),
    workspace: ownWorkspace
      ? projectWorkshopStatusWorkspace(
          ownWorkspace,
          context.manifest,
          session.releasedModuleIds,
        )
      : null,
    helpRequest: ownHelp
      ? {
          id: ownHelp.id,
          state:
            ownHelp.status === "claimed"
              ? "claimed"
              : ownHelp.status === "open"
                ? "open"
                : "resolved",
          message: ownHelp.message,
          moduleId: ownHelp.moduleId,
          requestedAt: ownHelp.createdAt,
          claimedByName: ownHelp.claimedBy
            ? (userNames.get(ownHelp.claimedBy) ?? null)
            : null,
        }
      : null,
    assistGrant: ownGrant
      ? {
          id: ownGrant.id,
          helperName:
            userNames.get(ownGrant.helperUserId) ?? "Workshop helper",
          expiresAt: ownGrant.expiresAt,
          revokedAt: ownGrant.revokedAt,
          canExtend: canExtendWorkshopAssist(ownGrant),
        }
      : null,
    roster: canSeeRoomProgress
      ? roster.map((member) =>
          projectWorkshopStatusRosterMember({
            member,
            progress: progress.filter((entry) => entry.userId === member.userId),
            workspace:
              workspaces.find((workspace) => workspace.userId === member.userId) ??
              null,
            helpRequest:
              activeHelpRequests.find(
                (request) => request.requesterUserId === member.userId,
              ) ?? null,
            assistGrant:
              activeGrants.find(
                (grant) =>
                  grant.learnerUserId === member.userId &&
                  grant.helperUserId === params.userId,
              ) ?? null,
            viewerUserId: params.userId,
            session,
            manifest: context.manifest,
            probeReport: probeReports.get(member.userId) ?? null,
            observedAt,
          }),
        )
      : [],
    ...(capacity === undefined ? {} : { capacity: projectWorkshopCapacity(capacity) }),
  } satisfies Omit<
    WorkshopSessionStatusResponse,
    "version" | "requiresFullRefresh"
  >;
  return {
    ...snapshot,
    version: preflight.version,
    requiresFullRefresh: preflight.requiresFullRefresh,
  };
}

/**
 * Cheaply detects whether any live room input changed. This intentionally uses
 * indexed aggregates instead of loading the manifest, room projection, probe
 * bodies, or capacity details on every poll.
 */
export async function getWorkshopSessionStatusPreflight(params: {
  sessionId: string;
  userId: string;
  knownSessionVersion?: number | null;
  knownManagerVersion?: string | null;
}): Promise<WorkshopSessionStatusPreflight> {
  const access = await requireWorkshopSessionMember(params);
  const hasActiveOrganizationMembership = access.organizationRole !== null;
  const canFacilitate =
    hasActiveOrganizationMembership &&
    (access.role === "facilitator" ||
      (access.organizationRole !== null &&
        isOrganizationAdminRole(access.organizationRole)));
  const canAssist =
    hasActiveOrganizationMembership &&
    (access.role === "facilitator" || access.role === "helper");
  const canSeeRoomProgress =
    canFacilitate ||
    (hasActiveOrganizationMembership && access.role === "helper");
  const canSeeManagerOperations =
    hasActiveOrganizationMembership &&
    access.organizationRole !== null &&
    isOrganizationAdminRole(access.organizationRole);
  const observedAt = Date.now();
  const scopedUserId = canSeeRoomProgress ? undefined : params.userId;
  const db = workshopDb();
  const memberScope = scopedUserId
    ? and(
        eq(workshopSessionMembers.sessionId, params.sessionId),
        eq(workshopSessionMembers.userId, scopedUserId),
      )
    : eq(workshopSessionMembers.sessionId, params.sessionId);
  const progressScope = scopedUserId
    ? and(
        eq(workshopModuleProgress.sessionId, params.sessionId),
        eq(workshopModuleProgress.userId, scopedUserId),
      )
    : eq(workshopModuleProgress.sessionId, params.sessionId);
  const workspaceScope = scopedUserId
    ? and(
        eq(workshopWorkspaces.sessionId, params.sessionId),
        eq(workshopWorkspaces.userId, scopedUserId),
      )
    : eq(workshopWorkspaces.sessionId, params.sessionId);
  const helpScope = scopedUserId
    ? and(
        eq(workshopHelpRequests.sessionId, params.sessionId),
        eq(workshopHelpRequests.requesterUserId, scopedUserId),
        inArray(workshopHelpRequests.status, ["open", "claimed"]),
      )
    : and(
        eq(workshopHelpRequests.sessionId, params.sessionId),
        inArray(workshopHelpRequests.status, ["open", "claimed"]),
      );
  const grantScope = scopedUserId
    ? and(
        eq(workshopAssistGrants.sessionId, params.sessionId),
        eq(workshopAssistGrants.learnerUserId, scopedUserId),
        isNull(workshopAssistGrants.revokedAt),
        gt(workshopAssistGrants.expiresAt, observedAt),
      )
    : and(
        eq(workshopAssistGrants.sessionId, params.sessionId),
        isNull(workshopAssistGrants.revokedAt),
        gt(workshopAssistGrants.expiresAt, observedAt),
      );
  const [
    sessionRows,
    selectionRows,
    roster,
    progress,
    workspaces,
    generations,
    helpRequests,
    grants,
    vmProbeState,
    guestProbeState,
  ] = await Promise.all([
    db
      .select({
        version: workshopSessions.version,
        updatedAt: workshopSessions.updatedAt,
      })
      .from(workshopSessions)
      .where(eq(workshopSessions.id, params.sessionId))
      .limit(1),
    db
      .select({
        kind: workshopSessionRuntimeSelections.providerKind,
        updatedAt: workshopSessionRuntimeSelections.updatedAt,
        connectionId: workshopSessionRuntimeSelections.connectionId,
      })
      .from(workshopSessionRuntimeSelections)
      .where(eq(workshopSessionRuntimeSelections.sessionId, params.sessionId))
      .limit(1),
    db
      .select({
        count: count(),
        updatedAt: max(workshopSessionMembers.updatedAt),
        lastSeenAt: max(workshopSessionMembers.lastSeenAt),
        userUpdatedAt: max(user.updatedAt),
      })
      .from(workshopSessionMembers)
      .innerJoin(user, eq(user.id, workshopSessionMembers.userId))
      .where(memberScope),
    db
      .select({
        count: count(),
        updatedAt: max(workshopModuleProgress.updatedAt),
      })
      .from(workshopModuleProgress)
      .where(progressScope),
    db
      .select({
        count: count(),
        updatedAt: max(workshopWorkspaces.updatedAt),
      })
      .from(workshopWorkspaces)
      .where(workspaceScope),
    db
      .select({
        count: count(),
        updatedAt: max(workshopWorkspaceGenerations.updatedAt),
      })
      .from(workshopWorkspaceGenerations)
      .innerJoin(
        workshopWorkspaces,
        eq(workshopWorkspaceGenerations.workspaceId, workshopWorkspaces.id),
      )
      .where(workspaceScope),
    db
      .select({
        count: count(),
        updatedAt: max(workshopHelpRequests.updatedAt),
        claimedByUpdatedAt: max(user.updatedAt),
      })
      .from(workshopHelpRequests)
      .leftJoin(user, eq(user.id, workshopHelpRequests.claimedBy))
      .where(helpScope),
    db
      .select({
        count: count(),
        updatedAt: max(workshopAssistGrants.updatedAt),
        expiresAt: max(workshopAssistGrants.expiresAt),
        helperUpdatedAt: max(user.updatedAt),
      })
      .from(workshopAssistGrants)
      .leftJoin(user, eq(user.id, workshopAssistGrants.helperUserId))
      .where(grantScope),
    db
      .select({
        count: count(),
        updatedAt: max(runtimeVmActualState.updatedAt),
        observedAt: max(runtimeVmActualState.observedAt),
        vmUpdatedAt: max(runtimeVms.updatedAt),
      })
      .from(workshopWorkspaces)
      .innerJoin(
        workshopWorkspaceGenerations,
        and(
          eq(
            workshopWorkspaceGenerations.id,
            workshopWorkspaces.currentGenerationId,
          ),
          eq(workshopWorkspaceGenerations.workspaceId, workshopWorkspaces.id),
        ),
      )
      .innerJoin(
        runtimeVmActualState,
        eq(
          runtimeVmActualState.executionId,
          workshopWorkspaceGenerations.runtimeExecutionId,
        ),
      )
      .innerJoin(
        runtimeVms,
        eq(runtimeVms.id, runtimeVmActualState.runtimeVmId),
      )
      .where(workspaceScope),
    db
      .select({
        count: count(),
        updatedAt: max(runtimeActualState.updatedAt),
        observedAt: max(runtimeActualState.observedAt),
        reportReceivedAt: max(runtimeGuestReports.receivedAt),
      })
      .from(workshopWorkspaces)
      .innerJoin(
        workshopWorkspaceGenerations,
        and(
          eq(
            workshopWorkspaceGenerations.id,
            workshopWorkspaces.currentGenerationId,
          ),
          eq(workshopWorkspaceGenerations.workspaceId, workshopWorkspaces.id),
        ),
      )
      .innerJoin(
        runtimeActualState,
        and(
          eq(
            runtimeActualState.executionId,
            workshopWorkspaceGenerations.runtimeExecutionId,
          ),
          eq(
            runtimeActualState.generation,
            workshopWorkspaceGenerations.ordinal,
          ),
        ),
      )
      .leftJoin(
        runtimeGuestReports,
        and(
          eq(runtimeGuestReports.id, runtimeActualState.latestReportId),
          eq(runtimeGuestReports.executionId, runtimeActualState.executionId),
        ),
      )
      .where(workspaceScope),
  ]);
  const sessionVersion = sessionRows[0]?.version ?? access.version;
  const selection = selectionRows[0] ?? null;
  const capacity =
    canFacilitate &&
    (access.state === "lobby" || access.state === "live") &&
    selection?.kind === "agent_kvm"
      ? await getWorkshopCapacityStatusRevision({
          organizationId: access.organizationId,
          observedAt,
        })
      : null;
  const managerVersion = canSeeManagerOperations
    ? await getWorkshopManagerStatusVersion(params.sessionId, observedAt)
    : null;
  const version = await workshopStatusDigest({
    session: sessionRows[0] ?? { version: access.version, updatedAt: null },
    selection,
    roster: roster[0] ?? null,
    progress: progress[0] ?? null,
    workspaces: workspaces[0] ?? null,
    generations: generations[0] ?? null,
    activeHelpRequests: helpRequests[0] ?? null,
    activeAssistGrants: grants[0] ?? null,
    vmProbeState: vmProbeState[0] ?? null,
    guestProbeState: guestProbeState[0] ?? null,
    capacity,
    managerVersion,
    access: {
      role: access.role,
      workspaceEnabled: access.workspaceEnabled,
      organizationRole: access.organizationRole,
    },
    // Presence and host-health transitions are time-derived even when no row
    // is written, so re-evaluate them at a bounded cadence.
    timeBucket: Math.floor(observedAt / STATUS_TIME_BUCKET_MS),
  });
  const requiresFullRefresh =
    (params.knownSessionVersion !== undefined &&
      params.knownSessionVersion !== null &&
      params.knownSessionVersion !== sessionVersion) ||
    (managerVersion !== null &&
      params.knownManagerVersion !== undefined &&
      params.knownManagerVersion !== null &&
      params.knownManagerVersion !== managerVersion);
  return {
    version,
    managerVersion,
    requiresFullRefresh,
    observedAt,
    access,
    canFacilitate,
    canAssist,
    canSeeRoomProgress,
    canSeeManagerOperations,
  };
}

async function getWorkshopCapacityStatusRevision(params: {
  organizationId: string;
  observedAt: number;
}) {
  const db = workshopDb();
  const activeReservationScope = and(
    inArray(hostResourceReservations.state, ["pending", "committed"]),
    or(
      eq(hostResourceReservations.state, "committed"),
      isNull(hostResourceReservations.expiresAt),
      gt(hostResourceReservations.expiresAt, params.observedAt),
    ),
  );
  const [hosts, reservations, reservedVms] = await Promise.all([
    db
      .select({
        count: count(),
        updatedAt: max(agentHosts.updatedAt),
        heartbeatAt: max(agentHosts.lastHeartbeatAt),
        actualUpdatedAt: max(hostActualState.updatedAt),
        actualObservedAt: max(hostActualState.observedAt),
      })
      .from(agentHosts)
      .leftJoin(hostActualState, eq(hostActualState.hostId, agentHosts.id))
      .where(
        and(
          eq(agentHosts.organizationId, params.organizationId),
          eq(agentHosts.role, "agent"),
        ),
      ),
    db
      .select({
        count: count(),
        updatedAt: max(hostResourceReservations.updatedAt),
        expiresAt: max(hostResourceReservations.expiresAt),
      })
      .from(hostResourceReservations)
      .where(activeReservationScope),
    db
      .select({
        count: count(),
        updatedAt: max(runtimeVms.updatedAt),
      })
      .from(runtimeVms)
      .innerJoin(
        hostResourceReservations,
        eq(hostResourceReservations.executionId, runtimeVms.executionId),
      )
      .where(activeReservationScope),
  ]);
  return {
    hosts: hosts[0] ?? null,
    reservations: reservations[0] ?? null,
    reservedVms: reservedVms[0] ?? null,
  };
}

async function loadWorkshopStatusWorkspaces(
  sessionId: string,
  userId?: string,
): Promise<WorkshopStatusWorkspaceRecord[]> {
  const rows = await workshopDb()
    .select({
      id: workshopWorkspaces.id,
      userId: workshopWorkspaces.userId,
      state: workshopWorkspaces.state,
      currentGenerationId: workshopWorkspaces.currentGenerationId,
      lastCheckpointId: workshopWorkspaces.lastCheckpointId,
      recoveryMessage: workshopWorkspaces.recoveryMessage,
      generationId: workshopWorkspaceGenerations.id,
      generationOrdinal: workshopWorkspaceGenerations.ordinal,
      runtimeExecutionId: workshopWorkspaceGenerations.runtimeExecutionId,
      generationCheckpointId: workshopWorkspaceGenerations.checkpointId,
      generationReadyAt: workshopWorkspaceGenerations.readyAt,
    })
    .from(workshopWorkspaces)
    .leftJoin(
      workshopWorkspaceGenerations,
      and(
        eq(
          workshopWorkspaceGenerations.id,
          workshopWorkspaces.currentGenerationId,
        ),
        eq(workshopWorkspaceGenerations.workspaceId, workshopWorkspaces.id),
      ),
    )
    .where(
      userId
        ? and(
            eq(workshopWorkspaces.sessionId, sessionId),
            eq(workshopWorkspaces.userId, userId),
          )
        : eq(workshopWorkspaces.sessionId, sessionId),
    );
  return rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    state: row.state,
    lastCheckpointId: row.lastCheckpointId,
    recoveryMessage: row.recoveryMessage,
    generation:
      row.generationId === null || row.generationOrdinal === null
        ? null
        : {
            id: row.generationId,
            ordinal: row.generationOrdinal,
            runtimeExecutionId: row.runtimeExecutionId,
            checkpointId: row.generationCheckpointId,
            readyAt: row.generationReadyAt,
          },
  }));
}

async function loadActiveWorkshopStatusHelpRequests(
  sessionId: string,
  requesterUserId?: string,
): Promise<WorkshopHelpRequestRecord[]> {
  const rows = await workshopDb()
    .select()
    .from(workshopHelpRequests)
    .where(
      requesterUserId
        ? and(
            eq(workshopHelpRequests.sessionId, sessionId),
            eq(workshopHelpRequests.requesterUserId, requesterUserId),
            inArray(workshopHelpRequests.status, ["open", "claimed"]),
          )
        : and(
            eq(workshopHelpRequests.sessionId, sessionId),
            inArray(workshopHelpRequests.status, ["open", "claimed"]),
          ),
    )
    .orderBy(desc(workshopHelpRequests.createdAt));
  return rows.map((row) => ({
    id: row.id,
    requesterUserId: row.requesterUserId,
    moduleId: row.moduleId,
    message: row.message,
    status: row.status,
    claimedBy: row.claimedBy,
    claimedAt: row.claimedAt,
    resolvedAt: row.resolvedAt,
    cancelledAt: row.cancelledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

async function loadWorkshopStatusRoster(sessionId: string, userId?: string) {
  return workshopDb()
    .select({
      id: workshopSessionMembers.id,
      userId: workshopSessionMembers.userId,
      name: user.name,
      role: workshopSessionMembers.role,
      workspaceEnabled: workshopSessionMembers.workspaceEnabled,
      checkedInAt: workshopSessionMembers.checkedInAt,
      lastSeenAt: workshopSessionMembers.lastSeenAt,
      provisionState: workshopSessionMembers.provisionState,
      provisionError: workshopSessionMembers.provisionError,
      createdAt: workshopSessionMembers.createdAt,
      updatedAt: workshopSessionMembers.updatedAt,
    })
    .from(workshopSessionMembers)
    .innerJoin(user, eq(workshopSessionMembers.userId, user.id))
    .where(
      userId
        ? and(
            eq(workshopSessionMembers.sessionId, sessionId),
            eq(workshopSessionMembers.userId, userId),
          )
        : eq(workshopSessionMembers.sessionId, sessionId),
    )
    .orderBy(asc(user.name));
}

interface WorkshopStatusWorkspaceRecord {
  id: string;
  userId: string;
  state: WorkshopWorkspaceState;
  lastCheckpointId: string | null;
  recoveryMessage: string | null;
  generation: {
    id: string;
    ordinal: number;
    runtimeExecutionId: string | null;
    checkpointId: string | null;
    readyAt: number | null;
  } | null;
}

function projectWorkshopStatusModules(params: {
  manifest: WorkshopManifestV2;
  session: Awaited<ReturnType<typeof loadWorkshopSession>>;
  progress: Awaited<ReturnType<typeof listWorkshopProgress>>;
  participantUserId?: string;
  facilitator: boolean;
  verificationExpected: boolean;
  probeReport: CurrentWorkshopProbeReport | null;
}) {
  return params.manifest.modules.map((module) => {
    const progress = params.participantUserId
      ? params.progress.find(
          (entry) =>
            entry.userId === params.participantUserId &&
            entry.moduleId === module.id,
        )
      : undefined;
    const released = params.session.releasedModuleIds.includes(module.id);
    return {
      id: module.id,
      state: projectWorkshopModuleState(
        progress?.technicalStatus ?? "not_started",
        released,
      ),
      health: progress?.currentHealth ?? "unknown",
      released,
      solutionRevealed:
        released && params.session.revealedSolutionModuleIds.includes(module.id),
      explainBackCompletedAt: progress?.explainBackCompletedAt ?? null,
      verifiedAt: progress?.firstVerifiedAt ?? null,
      ...(module.probeIds.length > 0 && params.verificationExpected
        ? {
            verificationUnavailable: currentWorkshopProbeReportUnavailable(
              params.probeReport,
            ),
          }
        : {}),
      hints: module.hints.map((hint) => ({
        id: hint.id,
        revealed:
          params.facilitator ||
          (released && Boolean(progress?.revealedHintIds.includes(hint.id))),
      })),
      probes: module.probeIds.map((probeId) => {
        const snapshot = params.probeReport?.probes.get(probeId);
        return {
          id: probeId,
          status:
            snapshot?.status ??
            (params.probeReport?.hasValidReport
              ? ("pending" as const)
              : progress?.currentHealth === "passing"
                ? ("pass" as const)
                : progress?.currentHealth === "failing"
                  ? ("fail" as const)
                  : ("unknown" as const)),
          detail: snapshot?.detail ?? null,
        };
      }),
    };
  });
}

function projectWorkshopStatusAgenda(params: {
  manifest: WorkshopManifestV2;
  session: Awaited<ReturnType<typeof loadWorkshopSession>>;
  progress: Awaited<ReturnType<typeof listWorkshopProgress>>;
}) {
  return params.manifest.agenda.map((item) => {
    const released = item.moduleId
      ? params.session.releasedModuleIds.includes(item.moduleId)
      : item.release === "automatic"
        ? params.session.state !== "draft"
        : params.session.currentSlideId !== null &&
          item.slideIds.includes(params.session.currentSlideId);
    const progress = item.moduleId
      ? params.progress.find((entry) => entry.moduleId === item.moduleId)
      : undefined;
    return {
      id: item.id,
      released,
      active:
        params.session.currentAgendaItemId === item.id ||
        (params.session.currentAgendaItemId === null &&
          ((item.moduleId !== undefined &&
            item.moduleId === params.session.currentModuleId) ||
            (params.session.currentModuleId === null &&
              params.session.currentSlideId !== null &&
              item.slideIds.includes(params.session.currentSlideId)))),
      completed: progress
        ? isCompletedTechnicalStatus(progress.technicalStatus)
        : false,
    };
  });
}

function projectWorkshopStatusWorkspace(
  workspace: WorkshopStatusWorkspaceRecord,
  manifest: WorkshopManifestV2,
  releasedModuleIds: string[],
) {
  const generation = workspace.generation;
  return {
    id: workspace.id,
    state: projectWorkshopWorkspaceState(workspace.state),
    generation: generation?.ordinal ?? 0,
    checkpointId:
      generation?.checkpointId ??
      workspace.lastCheckpointId ??
      manifest.workspace.initialCheckpointId,
    vmName: manifest.workspace.vms[0]?.name ?? "workspace",
    terminalAvailable:
      workspace.state === "ready" && Boolean(generation?.runtimeExecutionId),
    lastHealthyAt: generation?.readyAt ?? null,
    recoveryMessage: workspace.recoveryMessage,
    applications: manifest.workspace.applications.map((application) => ({
      id: application.id,
      label: application.label,
      url: null,
      available:
        workspace.state === "ready" &&
        Boolean(generation?.runtimeExecutionId) &&
        (!application.releaseModuleId ||
          releasedModuleIds.includes(application.releaseModuleId)),
      releaseModuleId: application.releaseModuleId ?? null,
    })),
  };
}

function projectWorkshopStatusRosterMember(params: {
  member: Awaited<ReturnType<typeof loadWorkshopStatusRoster>>[number];
  progress: Awaited<ReturnType<typeof listWorkshopProgress>>;
  workspace: WorkshopStatusWorkspaceRecord | null;
  helpRequest: Awaited<
    ReturnType<typeof loadActiveWorkshopStatusHelpRequests>
  >[number] | null;
  assistGrant: Awaited<ReturnType<typeof listActiveWorkshopAssistGrants>>[number] | null;
  viewerUserId: string;
  session: Awaited<ReturnType<typeof loadWorkshopSession>>;
  manifest: WorkshopManifestV2;
  probeReport: CurrentWorkshopProbeReport | null;
  observedAt: number;
}) {
  const working = params.progress.find(
    (progress) => progress.technicalStatus === "working",
  );
  return {
    userId: params.member.userId,
    name: params.member.name,
    role: params.member.role,
    workspaceEnabled: params.member.workspaceEnabled,
    checkedInAt: params.member.checkedInAt,
    lastSeenAt: params.member.lastSeenAt,
    presenceState: workshopPresenceState(
      params.member.lastSeenAt,
      params.observedAt,
    ),
    provisionState: params.member.provisionState,
    provisionError: params.member.provisionError,
    workspaceState: params.workspace
      ? projectWorkshopWorkspaceState(params.workspace.state)
      : null,
    currentModuleId: working?.moduleId ?? params.session.currentModuleId,
    helpState:
      params.helpRequest?.status === "claimed"
        ? ("claimed" as const)
        : params.helpRequest?.status === "open"
          ? ("open" as const)
          : ("none" as const),
    helpAssignedToViewer:
      params.helpRequest?.status === "claimed" &&
      params.helpRequest.claimedBy === params.viewerUserId,
    assistGrant: params.assistGrant
      ? {
          id: params.assistGrant.id,
          workspaceId: params.assistGrant.workspaceId,
          expiresAt: params.assistGrant.expiresAt,
        }
      : null,
    progress: params.manifest.modules.map((module) => {
      const progress = params.progress.find(
        (entry) => entry.moduleId === module.id,
      );
      const released = params.session.releasedModuleIds.includes(module.id);
      return {
        moduleId: module.id,
        state: projectWorkshopModuleState(
          progress?.technicalStatus ?? "not_started",
          released,
        ),
        health: progress?.currentHealth ?? ("unknown" as const),
        explainBackStatus:
          progress?.explainBackStatus ??
          (module.explainBackPrompt
            ? ("pending" as const)
            : ("not_required" as const)),
        ...(module.probeIds.length > 0 && params.workspace?.state === "ready"
          ? {
              verificationUnavailable: currentWorkshopProbeReportUnavailable(
                params.probeReport,
              ),
            }
          : {}),
        probes: module.probeIds.map((probeId, probeOrdinal) => {
          const snapshot = params.probeReport?.probes.get(probeId);
          return {
            id: probeId,
            label: `Verification objective ${probeOrdinal + 1}`,
            status:
              snapshot?.status ??
              (params.probeReport?.hasValidReport
                ? ("pending" as const)
                : ("unknown" as const)),
            detail: snapshot?.detail ?? null,
          };
        }),
      };
    }),
  };
}

function projectWorkshopCapacity(
  capacity: Awaited<ReturnType<typeof getWorkshopCapacityPreflight>>,
) {
  return {
    seatsTotal: capacity.seatsTotal,
    seatsAvailable: capacity.seatsAvailable,
    seatsRequired: capacity.seatsRequired,
    checkedIn: capacity.checkedIn,
    provisioned: capacity.provisioned,
    imagesReady: capacity.imagesReady,
    healthyRunners: capacity.healthyRunners,
    seatResources: { ...capacity.seatResources },
    runners: capacity.runners.map((runner) => ({
      ...runner,
      missingImageVmIds: [...runner.missingImageVmIds],
      available: { ...runner.available },
    })),
    allocationFailures: capacity.allocationFailures.map((failure) => ({
      ...failure,
    })),
  };
}

function workshopSlideReleased(params: {
  manifest: WorkshopManifestV2;
  session: Awaited<ReturnType<typeof loadWorkshopSession>>;
  slide: WorkshopManifestV2["presentation"]["slides"][number];
  facilitator: boolean;
}) {
  if (params.facilitator) return true;
  const opensAutomatically = params.manifest.agenda.some(
    (item) =>
      item.slideIds.includes(params.slide.id) && item.release === "automatic",
  );
  return params.slide.moduleId
    ? params.session.releasedModuleIds.includes(params.slide.moduleId)
    : opensAutomatically
      ? params.session.state !== "draft"
      : params.slide.id === params.session.currentSlideId;
}

function projectWorkshopModuleState(
  status: WorkshopTechnicalStatus,
  released: boolean,
) {
  return status === "not_started"
    ? released
      ? ("available" as const)
      : ("locked" as const)
    : status;
}

function projectWorkshopWorkspaceState(state: WorkshopWorkspaceState) {
  return state === "ending" ? ("ended" as const) : state;
}

function isCompletedTechnicalStatus(status: WorkshopTechnicalStatus) {
  return (
    status === "verified" ||
    status === "caught_up" ||
    status === "manually_completed" ||
    status === "skipped"
  );
}

async function getWorkshopManagerStatusVersion(
  sessionId: string,
  observedAt: number,
): Promise<string> {
  const db = workshopDb();
  const [selectionRows, forecastRows, summaryRows, ledgerRows] =
    await Promise.all([
    db
      .select({
        selectionUpdatedAt: workshopSessionRuntimeSelections.updatedAt,
        preflightCheckedAt: workshopSessionRuntimeSelections.preflightCheckedAt,
        grossCeilingOverrideAt:
          workshopSessionRuntimeSelections.grossCeilingOverrideAt,
        connectionUpdatedAt: providerConnections.updatedAt,
      })
      .from(workshopSessionRuntimeSelections)
      .leftJoin(
        providerConnections,
        eq(
          providerConnections.id,
          workshopSessionRuntimeSelections.connectionId,
        ),
      )
      .where(eq(workshopSessionRuntimeSelections.sessionId, sessionId))
      .limit(1),
    db
      .select({
        version: workshopSessionCostForecasts.version,
        createdAt: workshopSessionCostForecasts.createdAt,
      })
      .from(workshopSessionCostForecasts)
      .where(eq(workshopSessionCostForecasts.sessionId, sessionId))
      .orderBy(desc(workshopSessionCostForecasts.version))
      .limit(1),
    db
      .select({ updatedAt: workshopSessionCostSummaries.updatedAt })
      .from(workshopSessionCostSummaries)
      .where(eq(workshopSessionCostSummaries.sessionId, sessionId))
      .limit(1),
    db
      .select({
        id: runtimeProviderCostLedger.id,
        updatedAt: runtimeProviderCostLedger.updatedAt,
      })
      .from(runtimeProviderCostLedger)
      .innerJoin(
        runtimeExecutions,
        eq(runtimeExecutions.id, runtimeProviderCostLedger.executionId),
      )
      .innerJoin(
        workshopWorkspaces,
        and(
          eq(runtimeExecutions.domainKind, "workshop"),
          eq(workshopWorkspaces.id, runtimeExecutions.domainId),
        ),
      )
      .where(eq(workshopWorkspaces.sessionId, sessionId))
      .orderBy(desc(runtimeProviderCostLedger.updatedAt))
      .limit(1),
  ]);
  return workshopStatusDigest({
    selection: selectionRows[0] ?? null,
    forecast: forecastRows[0] ?? null,
    summary: summaryRows[0] ?? null,
    ledger: ledgerRows[0] ?? null,
    // The live cost card is time-derived. Revalidate it at a bounded rate
    // without turning every two-second status request into a full projection.
    costEpoch: Math.floor(observedAt / 30_000),
  });
}

interface CurrentWorkshopProbeSnapshot {
  status: "pass" | "fail" | "unknown";
  detail: string | null;
  checkedAt: number;
  observedAt: number;
}

interface CurrentWorkshopProbeReport {
  hasValidReport: boolean;
  probes: Map<string, CurrentWorkshopProbeSnapshot>;
}

async function loadCurrentWorkshopProbeReports(params: {
  sessionId: string;
  manifest: WorkshopManifestV2;
  userId?: string;
}): Promise<Map<string, CurrentWorkshopProbeReport>> {
  const db = workshopDb();
  const workspaceScope = params.userId
    ? and(
        eq(workshopWorkspaces.sessionId, params.sessionId),
        eq(workshopWorkspaces.userId, params.userId),
      )
    : eq(workshopWorkspaces.sessionId, params.sessionId);
  const [vmRows, providerRows] = await Promise.all([
    db
      .select({
        userId: workshopWorkspaces.userId,
        executionId: runtimeVmActualState.executionId,
        runtimeVmName: runtimeVms.runtimeVmName,
        report: runtimeVmActualState.reportJson,
        observedAt: runtimeVmActualState.observedAt,
      })
      .from(workshopWorkspaces)
      .innerJoin(
        workshopWorkspaceGenerations,
        and(
          eq(
            workshopWorkspaceGenerations.id,
            workshopWorkspaces.currentGenerationId,
          ),
          eq(workshopWorkspaceGenerations.workspaceId, workshopWorkspaces.id),
        ),
      )
      .innerJoin(
        runtimeVmActualState,
        eq(
          runtimeVmActualState.executionId,
          workshopWorkspaceGenerations.runtimeExecutionId,
        ),
      )
      .innerJoin(
        runtimeVms,
        and(
          eq(runtimeVms.id, runtimeVmActualState.runtimeVmId),
          eq(
            runtimeVms.executionId,
            workshopWorkspaceGenerations.runtimeExecutionId,
          ),
        ),
      )
      .where(workspaceScope),
    db
      .select({
        userId: workshopWorkspaces.userId,
        probes: runtimeGuestReports.probesJson,
        observedAt: runtimeActualState.observedAt,
      })
      .from(workshopWorkspaces)
      .innerJoin(
        workshopWorkspaceGenerations,
        and(
          eq(
            workshopWorkspaceGenerations.id,
            workshopWorkspaces.currentGenerationId,
          ),
          eq(workshopWorkspaceGenerations.workspaceId, workshopWorkspaces.id),
        ),
      )
      .innerJoin(
        runtimeActualState,
        and(
          eq(
            runtimeActualState.executionId,
            workshopWorkspaceGenerations.runtimeExecutionId,
          ),
          eq(
            runtimeActualState.generation,
            workshopWorkspaceGenerations.ordinal,
          ),
        ),
      )
      .innerJoin(
        runtimeGuestReports,
        and(
          eq(runtimeGuestReports.id, runtimeActualState.latestReportId),
          eq(runtimeGuestReports.executionId, runtimeActualState.executionId),
        ),
      )
      .where(workspaceScope),
  ]);
  const knownProbeIds = new Set(
    params.manifest.modules.flatMap((module) => module.probeIds),
  );
  const reports = new Map<string, CurrentWorkshopProbeReport>();
  for (const row of vmRows) {
    mergeCurrentWorkshopProbeReport(
      reports,
      row.userId,
      parseCurrentWorkshopProbeReport({
        report: row.report,
        executionId: row.executionId,
        runtimeVmName: row.runtimeVmName,
        observedAt: row.observedAt,
        knownProbeIds,
      }),
    );
  }
  for (const row of providerRows) {
    mergeCurrentWorkshopProbeReport(
      reports,
      row.userId,
      parseCurrentProviderProbeReport({
        probes: row.probes,
        observedAt: row.observedAt,
        knownProbeIds,
      }),
    );
  }
  return reports;
}

function mergeCurrentWorkshopProbeReport(
  reports: Map<string, CurrentWorkshopProbeReport>,
  userId: string,
  parsed: Map<string, CurrentWorkshopProbeSnapshot> | null,
) {
  const aggregate = reports.get(userId) ?? {
    hasValidReport: false,
    probes: new Map<string, CurrentWorkshopProbeSnapshot>(),
  };
  reports.set(userId, aggregate);
  if (!parsed) return;
  aggregate.hasValidReport = true;
  for (const [probeId, snapshot] of parsed) {
    const existing = aggregate.probes.get(probeId);
    if (
      !existing ||
      snapshot.checkedAt > existing.checkedAt ||
      (snapshot.checkedAt === existing.checkedAt &&
        snapshot.observedAt >= existing.observedAt)
    ) {
      aggregate.probes.set(probeId, snapshot);
    }
  }
}

function parseCurrentProviderProbeReport(params: {
  probes: unknown;
  observedAt: number;
  knownProbeIds: ReadonlySet<string>;
}): Map<string, CurrentWorkshopProbeSnapshot> | null {
  if (!Array.isArray(params.probes)) return null;
  const snapshots = new Map<string, CurrentWorkshopProbeSnapshot>();
  for (const candidate of params.probes) {
    if (!isRecord(candidate)) continue;
    const id = candidate.id;
    const status = candidate.status;
    const checkedAt = candidate.observed_at_unix_ms;
    const error = candidate.error;
    if (
      typeof id !== "string" ||
      !params.knownProbeIds.has(id) ||
      (status !== "pass" && status !== "fail" && status !== "unknown") ||
      typeof checkedAt !== "number" ||
      !Number.isSafeInteger(checkedAt) ||
      checkedAt < 0 ||
      (error !== undefined && error !== null && typeof error !== "string")
    ) {
      continue;
    }
    const snapshot = {
      status,
      detail: typeof error === "string" ? error : null,
      checkedAt,
      observedAt: params.observedAt,
    } as const;
    const existing = snapshots.get(id);
    if (!existing || snapshot.checkedAt >= existing.checkedAt) {
      snapshots.set(id, snapshot);
    }
  }
  return snapshots;
}

function parseCurrentWorkshopProbeReport(params: {
  report: unknown;
  executionId: string;
  runtimeVmName: string;
  observedAt: number;
  knownProbeIds: ReadonlySet<string>;
}): Map<string, CurrentWorkshopProbeSnapshot> | null {
  if (
    !isRecord(params.report) ||
    params.report.run_id !== params.executionId ||
    params.report.vm_name !== params.runtimeVmName ||
    !Array.isArray(params.report.probes)
  ) {
    return null;
  }
  const snapshots = new Map<string, CurrentWorkshopProbeSnapshot>();
  for (const candidate of params.report.probes) {
    if (!isRecord(candidate)) continue;
    const id = candidate.id;
    const status = candidate.status;
    const phase = candidate.phase;
    const checkedAt = candidate.checked_at_unix_ms;
    const message = candidate.message;
    if (
      typeof id !== "string" ||
      !params.knownProbeIds.has(id) ||
      (phase !== "boot" && phase !== "scenario") ||
      (status !== "pass" && status !== "fail" && status !== "unknown") ||
      typeof checkedAt !== "number" ||
      !Number.isSafeInteger(checkedAt) ||
      checkedAt < 0 ||
      (message !== undefined && message !== null && typeof message !== "string")
    ) {
      continue;
    }
    const snapshot = {
      status,
      detail: typeof message === "string" ? message : null,
      checkedAt,
      observedAt: params.observedAt,
    } as const;
    const existing = snapshots.get(id);
    if (!existing || snapshot.checkedAt >= existing.checkedAt) {
      snapshots.set(id, snapshot);
    }
  }
  return snapshots;
}

function currentWorkshopProbeReportUnavailable(
  report: CurrentWorkshopProbeReport | null,
) {
  return !report?.hasValidReport;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
