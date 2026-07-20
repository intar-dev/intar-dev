import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  member,
  user,
  workshopAssistGrants,
  workshopEvents,
  workshopHelpRequests,
  workshopSessionMembers,
  workshopSessions,
  workshopTemplateRevisions,
  workshopTemplates,
  workshopWorkspaceGenerations,
  workshopWorkspaces,
  type WorkshopSessionRole,
  type WorkshopSessionState,
} from "@/db/schema";
import { appError } from "@/lib/app-error";
import { createAppId } from "@/lib/id";
import { requireOrganizationRole } from "@/lib/organizations";
import { revokeWorkshopSessionAssistRoutes } from "./assistance";
import { teardownWorkshopSessionRuntimes } from "./runtime-orchestrator";
import {
  appendWorkshopEvent,
  loadWorkshopManifestForSession,
  requireManifestModule,
  requireWorkshopManager,
  requireWorkshopSessionMember,
  workshopManagerMutationGuard,
  workshopDb,
} from "./shared";
import type {
  WorkshopRosterMemberRecord,
  WorkshopSessionRecord,
} from "./types";
import { validateSessionTitle } from "./validation";

const MINUTE_MS = 60 * 1_000;

const ALLOWED_TRANSITIONS: Record<
  WorkshopSessionState,
  WorkshopSessionState[]
> = {
  draft: ["lobby", "cancelled"],
  lobby: ["live", "cancelled"],
  live: ["ended", "cancelled"],
  ended: [],
  cancelled: [],
};

export interface WorkshopSessionListEntry {
  session: WorkshopSessionRecord;
  membership: {
    role: WorkshopSessionRole;
    checkedInAt: number | null;
    provisionState:
      | "not_ready"
      | "queued"
      | "provisioning"
      | "ready"
      | "failed"
      | "ended";
  };
}

export async function listWorkshopSessionsForUser(params: {
  userId: string;
}): Promise<WorkshopSessionListEntry[]> {
  const db = workshopDb();
  const [rows, memberships] = await Promise.all([
    db
      .select({
        ...sessionSelection(),
        role: workshopSessionMembers.role,
        checkedInAt: workshopSessionMembers.checkedInAt,
        provisionState: workshopSessionMembers.provisionState,
      })
      .from(workshopSessionMembers)
      .innerJoin(
        workshopSessions,
        eq(workshopSessionMembers.sessionId, workshopSessions.id),
      )
      .innerJoin(
        workshopTemplateRevisions,
        eq(workshopSessions.templateRevisionId, workshopTemplateRevisions.id),
      )
      .innerJoin(
        workshopTemplates,
        eq(workshopTemplateRevisions.templateId, workshopTemplates.id),
      )
      .where(eq(workshopSessionMembers.userId, params.userId))
      .orderBy(desc(workshopSessions.scheduledStartAt)),
    db
      .select({ organizationId: member.organizationId })
      .from(member)
      .where(
        and(
          eq(member.userId, params.userId),
          isNull(member.workshopAccessRevokingAt),
        ),
      ),
  ]);
  const currentOrganizationIds = new Set(
    memberships.map((entry) => entry.organizationId),
  );
  return rows
    .filter(
      (row) =>
        currentOrganizationIds.has(row.organizationId) ||
        ((row.state === "ended" || row.state === "cancelled") &&
          row.role === "participant"),
    )
    .map((row) => ({
      session: sessionRecord(row),
      membership: {
        role: row.role,
        checkedInAt: row.checkedInAt,
        provisionState: row.provisionState,
      },
    }));
}

export async function listOrganizationWorkshopSessions(params: {
  organizationId: string;
  userId: string;
}): Promise<WorkshopSessionRecord[]> {
  await requireOrganizationRole({
    organizationId: params.organizationId,
    userId: params.userId,
    admin: true,
  });
  const rows = await workshopDb()
    .select(sessionSelection())
    .from(workshopSessions)
    .innerJoin(
      workshopTemplateRevisions,
      eq(workshopSessions.templateRevisionId, workshopTemplateRevisions.id),
    )
    .innerJoin(
      workshopTemplates,
      eq(workshopTemplateRevisions.templateId, workshopTemplates.id),
    )
    .where(eq(workshopSessions.organizationId, params.organizationId))
    .orderBy(desc(workshopSessions.scheduledStartAt));
  return rows.map(sessionRecord);
}

export async function createWorkshopSession(params: {
  organizationId: string;
  actorUserId: string;
  templateRevisionId: string;
  title: string;
  scheduledStartAt: number;
  lobbyOpensAt?: number;
}): Promise<WorkshopSessionRecord> {
  await requireOrganizationRole({
    organizationId: params.organizationId,
    userId: params.actorUserId,
    admin: true,
  });
  const title = validateSessionTitle(params.title);
  const scheduledStartAt = requireUnixMs(
    params.scheduledStartAt,
    "scheduled start",
  );
  const db = workshopDb();
  const revisions = await db
    .select({
      revisionId: workshopTemplateRevisions.id,
      templateId: workshopTemplates.id,
      templateSlug: workshopTemplates.slug,
      templateTitle: workshopTemplates.title,
      manifest: workshopTemplateRevisions.manifestJson,
    })
    .from(workshopTemplateRevisions)
    .innerJoin(
      workshopTemplates,
      eq(workshopTemplateRevisions.templateId, workshopTemplates.id),
    )
    .where(
      and(
        eq(workshopTemplateRevisions.id, params.templateRevisionId),
        eq(workshopTemplates.organizationId, params.organizationId),
      ),
    )
    .limit(1);
  const revision = revisions[0];
  if (!revision) {
    throw appError(
      404,
      "workshop_template_revision_not_found",
      "workshop template revision not found",
    );
  }
  const lobbyOpensAt =
    params.lobbyOpensAt === undefined
      ? requireUnixMs(
          scheduledStartAt -
            revision.manifest.workshop.defaultLobbyMinutes * MINUTE_MS,
          "lobby open time",
        )
      : requireUnixMs(params.lobbyOpensAt, "lobby open time");
  if (lobbyOpensAt > scheduledStartAt) {
    throw appError(
      400,
      "workshop_lobby_time_invalid",
      "lobby must open no later than the scheduled start",
    );
  }
  const sessionId = createAppId();
  const now = Date.now();
  await db.batch([
    db.insert(workshopSessions).values({
      id: sessionId,
      organizationId: params.organizationId,
      templateRevisionId: params.templateRevisionId,
      title,
      state: "draft",
      version: 1,
      scheduledStartAt,
      lobbyOpensAt,
      createdBy: params.actorUserId,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(workshopSessionMembers).values({
      id: createAppId(),
      sessionId,
      userId: params.actorUserId,
      role: "facilitator",
      assignedBy: params.actorUserId,
      createdAt: now,
      updatedAt: now,
    }),
  ]);
  await appendWorkshopEvent(db, {
    organizationId: params.organizationId,
    sessionId,
    actorUserId: params.actorUserId,
    type: "session.created",
    payload: { templateRevisionId: params.templateRevisionId },
    createdAt: now,
  });
  return {
    id: sessionId,
    organizationId: params.organizationId,
    templateRevisionId: params.templateRevisionId,
    templateId: revision.templateId,
    templateSlug: revision.templateSlug,
    templateTitle: revision.templateTitle,
    title,
    state: "draft",
    version: 1,
    scheduledStartAt,
    lobbyOpensAt,
    currentAgendaItemId: null,
    currentModuleId: null,
    currentSlideId: null,
    releasedModuleIds: [],
    revealedHintIds: [],
    revealedSolutionModuleIds: [],
    timerStartedAt: null,
    timerEndsAt: null,
    timerPausedAt: null,
    timerRemainingMs: null,
    announcement: null,
    startedAt: null,
    endedAt: null,
    cancelledAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function replaceWorkshopRoster(params: {
  sessionId: string;
  actorUserId: string;
  members: Array<{ userId: string; role: WorkshopSessionRole }>;
  expectedVersion?: number;
  draftOnly?: boolean;
}): Promise<WorkshopRosterMemberRecord[]> {
  const access = await requireWorkshopManager({
    sessionId: params.sessionId,
    userId: params.actorUserId,
  });
  if (
    (params.draftOnly && access.state !== "draft") ||
    (!params.draftOnly && access.state !== "draft" && access.state !== "lobby")
  ) {
    throw appError(
      409,
      "workshop_roster_locked",
      "workshop roster is locked after the session starts",
    );
  }
  if (
    params.expectedVersion !== undefined &&
    params.expectedVersion !== access.version
  ) {
    throw versionConflict();
  }
  if (!params.members.length) {
    throw appError(
      400,
      "workshop_roster_empty",
      "workshop roster must contain at least one member",
    );
  }
  const memberByUser = new Map<string, WorkshopSessionRole>();
  for (const entry of params.members) {
    const userId = entry.userId.trim();
    if (!userId || !isWorkshopSessionRole(entry.role)) {
      throw appError(
        400,
        "workshop_roster_invalid",
        "workshop roster contains an invalid member",
      );
    }
    if (memberByUser.has(userId)) {
      throw appError(
        400,
        "workshop_roster_duplicate",
        "workshop roster contains the same member more than once",
      );
    }
    memberByUser.set(userId, entry.role);
  }
  if (![...memberByUser.values()].includes("facilitator")) {
    throw appError(
      400,
      "workshop_facilitator_missing",
      "workshop roster must contain at least one facilitator",
    );
  }

  const db = workshopDb();
  const existingWorkspace = await db
    .select({ id: workshopWorkspaces.id })
    .from(workshopWorkspaces)
    .where(eq(workshopWorkspaces.sessionId, params.sessionId))
    .limit(1);
  if (existingWorkspace[0]) {
    throw appError(
      409,
      "workshop_roster_provisioned",
      "the workshop roster cannot change after workspace provisioning starts",
    );
  }
  const userIds = [...memberByUser.keys()];
  const organizationMembers = await db
    .select({ userId: member.userId })
    .from(member)
    .where(
      and(
        eq(member.organizationId, access.organizationId),
        inArray(member.userId, userIds),
        isNull(member.workshopAccessRevokingAt),
      ),
    );
  if (organizationMembers.length !== userIds.length) {
    throw appError(
      400,
      "workshop_roster_non_member",
      "every workshop roster entry must be an organization member",
    );
  }
  const existing = await db
    .select({
      id: workshopSessionMembers.id,
      userId: workshopSessionMembers.userId,
      checkedInAt: workshopSessionMembers.checkedInAt,
      provisionState: workshopSessionMembers.provisionState,
    })
    .from(workshopSessionMembers)
    .where(eq(workshopSessionMembers.sessionId, params.sessionId));
  const existingByUser = new Map(
    existing.map((entry) => [entry.userId, entry]),
  );
  const now = Date.now();
  const upserts = userIds.map((userId) => {
    const existingMember = existingByUser.get(userId);
    return db
      .insert(workshopSessionMembers)
      .values({
        id: existingMember?.id ?? createAppId(),
        sessionId: params.sessionId,
        userId,
        role: memberByUser.get(userId) ?? "participant",
        checkedInAt: existingMember?.checkedInAt ?? null,
        provisionState: existingMember?.provisionState ?? "not_ready",
        assignedBy: params.actorUserId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          workshopSessionMembers.sessionId,
          workshopSessionMembers.userId,
        ],
        set: {
          role: memberByUser.get(userId) ?? "participant",
          assignedBy: params.actorUserId,
          updatedAt: now,
        },
      });
  });
  const removedIds = existing
    .filter((entry) => !memberByUser.has(entry.userId))
    .map((entry) => entry.id);
  const firstUpsert = upserts[0];
  if (!firstUpsert) {
    throw appError(
      400,
      "workshop_roster_empty",
      "workshop roster must contain at least one member",
    );
  }
  const eventInsert = db.insert(workshopEvents).values({
    id: createAppId(),
    organizationId: access.organizationId,
    sessionId: params.sessionId,
    actorUserId: params.actorUserId,
    type: "roster.replaced",
    payloadJson: { memberCount: userIds.length },
    createdAt: now,
  });
  const removal = removedIds.length
    ? db
        .delete(workshopSessionMembers)
        .where(inArray(workshopSessionMembers.id, removedIds))
    : null;
  const expectedVersion = params.expectedVersion;
  const versionMatches =
    expectedVersion === undefined
      ? sql`1 = 1`
      : sql`${workshopSessions.version} = ${expectedVersion}`;
  const nextVersion =
    expectedVersion === undefined
      ? sql`${workshopSessions.version}`
      : sql`${expectedVersion + 1}`;
  // This statement is deliberately first in the D1 batch. The session's
  // positive-version CHECK becomes a rollback sentinel when either the
  // optimistic version or the actor's commit-time authority has changed.
  const casUpdate = db
    .update(workshopSessions)
    .set({
      version: sql`CASE
        WHEN ${versionMatches}
         AND EXISTS (
           SELECT 1
           FROM member actor_membership
           WHERE actor_membership.organization_id = ${workshopSessions.organizationId}
             AND actor_membership.user_id = ${params.actorUserId}
             AND actor_membership.workshop_access_revoking_at IS NULL
             AND (
               actor_membership.role IN ('owner', 'admin')
               OR EXISTS (
                 SELECT 1
                 FROM workshop_session_members actor_roster
                 WHERE actor_roster.session_id = ${workshopSessions.id}
                   AND actor_roster.user_id = ${params.actorUserId}
                   AND actor_roster.role = 'facilitator'
               )
             )
         )
        THEN ${nextVersion}
        ELSE 0
      END`,
      updatedAt: now,
    })
    .where(eq(workshopSessions.id, params.sessionId));
  try {
    if (removal) {
      await db.batch([
        casUpdate,
        firstUpsert,
        ...upserts.slice(1),
        removal,
        eventInsert,
      ]);
    } else {
      await db.batch([
        casUpdate,
        firstUpsert,
        ...upserts.slice(1),
        eventInsert,
      ]);
    }
  } catch (error) {
    if (expectedVersion !== undefined) {
      const currentVersion = await db
        .select({ version: workshopSessions.version })
        .from(workshopSessions)
        .where(eq(workshopSessions.id, params.sessionId))
        .limit(1);
      if (currentVersion[0]?.version !== expectedVersion) {
        throw versionConflict();
      }
    }
    throw error;
  }
  return listWorkshopRoster(params.sessionId);
}

export async function listWorkshopRoster(
  sessionId: string,
): Promise<WorkshopRosterMemberRecord[]> {
  const rows = await workshopDb()
    .select({
      id: workshopSessionMembers.id,
      userId: workshopSessionMembers.userId,
      name: user.name,
      role: workshopSessionMembers.role,
      checkedInAt: workshopSessionMembers.checkedInAt,
      lastSeenAt: workshopSessionMembers.lastSeenAt,
      provisionState: workshopSessionMembers.provisionState,
      provisionError: workshopSessionMembers.provisionError,
      createdAt: workshopSessionMembers.createdAt,
      updatedAt: workshopSessionMembers.updatedAt,
    })
    .from(workshopSessionMembers)
    .innerJoin(user, eq(workshopSessionMembers.userId, user.id))
    .where(eq(workshopSessionMembers.sessionId, sessionId))
    .orderBy(asc(user.name));
  return rows;
}

export async function checkInToWorkshop(params: {
  sessionId: string;
  userId: string;
}): Promise<{ checkedInAt: number }> {
  const access = await requireWorkshopSessionMember(params);
  if (access.role !== "participant") {
    throw appError(
      403,
      "workshop_participant_required",
      "only workshop participants check in for a workspace",
    );
  }
  if (access.state !== "lobby" && access.state !== "live") {
    throw appError(
      409,
      "workshop_check_in_closed",
      "workshop check-in is not open",
    );
  }
  const now = Date.now();
  const rows = await workshopDb()
    .update(workshopSessionMembers)
    .set({ checkedInAt: now, updatedAt: now })
    .where(
      and(
        eq(workshopSessionMembers.sessionId, params.sessionId),
        eq(workshopSessionMembers.userId, params.userId),
      ),
    )
    .returning({ checkedInAt: workshopSessionMembers.checkedInAt });
  const checkedInAt = rows[0]?.checkedInAt ?? now;
  await appendWorkshopEvent(workshopDb(), {
    organizationId: access.organizationId,
    sessionId: params.sessionId,
    actorUserId: params.userId,
    type: "participant.checked_in",
    createdAt: now,
  });
  return { checkedInAt };
}

export async function updateWorkshopSession(params: {
  sessionId: string;
  actorUserId: string;
  expectedVersion: number;
  state?: WorkshopSessionState;
  currentAgendaItemId?: string | null;
  currentModuleId?: string | null;
  currentSlideId?: string | null;
  timer?: { startedAt: number; endsAt: number } | null;
  announcement?: string | null;
}): Promise<WorkshopSessionRecord> {
  const access = await requireWorkshopManager({
    sessionId: params.sessionId,
    userId: params.actorUserId,
  });
  const current = await loadWorkshopSession(params.sessionId);
  if (params.expectedVersion !== current.version) {
    throw versionConflict();
  }
  const nextState = params.state ?? current.state;
  if (
    nextState !== current.state &&
    !ALLOWED_TRANSITIONS[current.state].includes(nextState)
  ) {
    throw appError(
      409,
      "workshop_state_transition_invalid",
      `cannot transition workshop session from ${current.state} to ${nextState}`,
    );
  }
  if (
    (current.state === "ended" || current.state === "cancelled") &&
    nextState === current.state
  ) {
    if (!isTerminalCleanupRetry(params, current.state)) {
      throw appError(
        409,
        "workshop_session_terminal",
        "workshop session has already ended",
      );
    }
    await cleanupWorkshopSessionWithAudit({
      db: workshopDb(),
      organizationId: access.organizationId,
      sessionId: params.sessionId,
      actorUserId: params.actorUserId,
      terminalState: current.state,
      now: Date.now(),
      retry: true,
    });
    return loadWorkshopSession(params.sessionId);
  }
  const { manifest } = await loadWorkshopManifestForSession(params.sessionId);
  const releasedGateModuleIds =
    current.state !== "lobby" && nextState === "lobby"
      ? manifest.modules
          .filter((module) => module.tier === "gate")
          .map((module) => module.id)
      : [];
  const releasedModuleIds = releasedGateModuleIds.length
    ? [...new Set([...current.releasedModuleIds, ...releasedGateModuleIds])]
    : current.releasedModuleIds;
  const currentAgendaItemId =
    params.currentAgendaItemId === undefined
      ? current.currentAgendaItemId
      : params.currentAgendaItemId;
  if (
    currentAgendaItemId &&
    !manifest.agenda.some((item) => item.id === currentAgendaItemId)
  ) {
    throw appError(
      404,
      "workshop_agenda_item_not_found",
      "workshop agenda item not found",
    );
  }
  const currentModuleId =
    params.currentModuleId === undefined
      ? current.currentModuleId
      : params.currentModuleId;
  if (currentModuleId) requireManifestModule(manifest, currentModuleId);
  const currentSlideId =
    params.currentSlideId === undefined
      ? current.currentSlideId
      : params.currentSlideId;
  if (
    currentSlideId &&
    !manifest.presentation.slides.some((slide) => slide.id === currentSlideId)
  ) {
    throw appError(404, "workshop_slide_not_found", "workshop slide not found");
  }
  const announcement =
    params.announcement === undefined
      ? current.announcement
      : validateAnnouncement(params.announcement);
  let timerStartedAt = current.timerStartedAt;
  let timerEndsAt = current.timerEndsAt;
  let timerPausedAt = current.timerPausedAt;
  let timerRemainingMs = current.timerRemainingMs;
  if (
    params.timer === null ||
    nextState === "ended" ||
    nextState === "cancelled"
  ) {
    timerStartedAt = null;
    timerEndsAt = null;
    timerPausedAt = null;
    timerRemainingMs = null;
  } else if (params.timer) {
    timerStartedAt = requireUnixMs(params.timer.startedAt, "timer start");
    timerEndsAt = requireUnixMs(params.timer.endsAt, "timer end");
    timerPausedAt = null;
    timerRemainingMs = null;
    if (timerEndsAt <= timerStartedAt) {
      throw appError(
        400,
        "workshop_timer_invalid",
        "timer end must be after its start",
      );
    }
  }
  const now = Date.now();
  const startedAt =
    nextState === "live" && current.startedAt === null
      ? now
      : current.startedAt;
  const endedAt = nextState === "ended" ? now : current.endedAt;
  const cancelledAt = nextState === "cancelled" ? now : current.cancelledAt;
  const db = workshopDb();
  const updated = await db
    .update(workshopSessions)
    .set({
      state: nextState,
      version: current.version + 1,
      releasedModuleIdsJson: releasedModuleIds,
      currentAgendaItemId,
      currentModuleId,
      currentSlideId,
      timerStartedAt,
      timerEndsAt,
      timerPausedAt,
      timerRemainingMs,
      announcement,
      startedAt,
      endedAt,
      cancelledAt,
      updatedAt: now,
    })
    .where(
      and(
        eq(workshopSessions.id, params.sessionId),
        eq(workshopSessions.version, params.expectedVersion),
        workshopManagerMutationGuard(
          params.sessionId,
          params.actorUserId,
        ),
      ),
    )
    .returning({ id: workshopSessions.id });
  if (!updated[0]) throw versionConflict();

  await appendWorkshopEvent(db, {
    organizationId: access.organizationId,
    sessionId: params.sessionId,
    actorUserId: params.actorUserId,
    type:
      nextState !== current.state
        ? `session.${nextState}`
        : "session.control_updated",
    payload: {
      previousState: current.state,
      version: current.version + 1,
      currentAgendaItemId,
      currentModuleId,
      currentSlideId,
      timerEndsAt,
      ...(releasedGateModuleIds.length
        ? {
            automatic: false,
            releasedGateModuleIds,
          }
        : {}),
    },
    createdAt: now,
  });
  if (nextState === "ended" || nextState === "cancelled") {
    await cleanupWorkshopSessionWithAudit({
      db,
      organizationId: access.organizationId,
      sessionId: params.sessionId,
      actorUserId: params.actorUserId,
      terminalState: nextState,
      now,
      retry: false,
    });
  }
  return loadWorkshopSession(params.sessionId);
}

export async function loadWorkshopSession(
  sessionId: string,
): Promise<WorkshopSessionRecord> {
  const rows = await workshopDb()
    .select(sessionSelection())
    .from(workshopSessions)
    .innerJoin(
      workshopTemplateRevisions,
      eq(workshopSessions.templateRevisionId, workshopTemplateRevisions.id),
    )
    .innerJoin(
      workshopTemplates,
      eq(workshopTemplateRevisions.templateId, workshopTemplates.id),
    )
    .where(eq(workshopSessions.id, sessionId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw appError(
      404,
      "workshop_session_not_found",
      "workshop session not found",
    );
  }
  return sessionRecord(row);
}

async function cleanupWorkshopSessionWithAudit(params: {
  db: ReturnType<typeof workshopDb>;
  organizationId: string;
  sessionId: string;
  actorUserId: string;
  terminalState: "ended" | "cancelled";
  now: number;
  retry: boolean;
}): Promise<void> {
  if (params.retry) {
    await appendWorkshopCleanupEvent(params, "session.cleanup_retried");
  }
  try {
    await closeWorkshopSessionResources(params);
  } catch (error) {
    await appendWorkshopCleanupEvent(params, "session.cleanup_failed", {
      error: workshopCleanupErrorMessage(error),
    });
    throw error;
  }
  await appendWorkshopCleanupEvent(params, "session.cleanup_completed");
}

async function appendWorkshopCleanupEvent(
  params: {
    db: ReturnType<typeof workshopDb>;
    organizationId: string;
    sessionId: string;
    actorUserId: string;
    terminalState: "ended" | "cancelled";
    now: number;
  },
  type: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  try {
    await appendWorkshopEvent(params.db, {
      organizationId: params.organizationId,
      sessionId: params.sessionId,
      actorUserId: params.actorUserId,
      type,
      payload: { terminalState: params.terminalState, ...payload },
      createdAt: params.now,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "workshop_session_cleanup_audit_failed",
        sessionId: params.sessionId,
        type,
        error: workshopCleanupErrorMessage(error),
      }),
    );
  }
}

async function closeWorkshopSessionResources(params: {
  db: ReturnType<typeof workshopDb>;
  sessionId: string;
  actorUserId: string;
  now: number;
}) {
  await params.db.batch([
    params.db
      .update(workshopSessionMembers)
      .set({ provisionState: "ended", updatedAt: params.now })
      .where(eq(workshopSessionMembers.sessionId, params.sessionId)),
    params.db
      .update(workshopWorkspaces)
      .set({ state: "ending", endedAt: params.now, updatedAt: params.now })
      .where(
        and(
          eq(workshopWorkspaces.sessionId, params.sessionId),
          inArray(workshopWorkspaces.state, [
            "queued",
            "provisioning",
            "ready",
            "recovering",
            "failed",
          ]),
        ),
      ),
    params.db
      .update(workshopWorkspaceGenerations)
      .set({
        state: "archiving",
        archiveRequestedAt: params.now,
        updatedAt: params.now,
      })
      .where(
        and(
          inArray(
            workshopWorkspaceGenerations.workspaceId,
            params.db
              .select({ id: workshopWorkspaces.id })
              .from(workshopWorkspaces)
              .where(eq(workshopWorkspaces.sessionId, params.sessionId)),
          ),
          inArray(workshopWorkspaceGenerations.state, [
            "queued",
            "provisioning",
            "ready",
            "failed",
          ]),
        ),
      ),
    params.db
      .update(workshopAssistGrants)
      .set({
        revokedAt: params.now,
        revokedBy: params.actorUserId,
        updatedAt: params.now,
      })
      .where(
        and(
          eq(workshopAssistGrants.sessionId, params.sessionId),
          isNull(workshopAssistGrants.revokedAt),
        ),
      ),
    params.db
      .update(workshopHelpRequests)
      .set({
        status: "cancelled",
        activeKey: null,
        cancelledAt: params.now,
        updatedAt: params.now,
      })
      .where(
        and(
          eq(workshopHelpRequests.sessionId, params.sessionId),
          inArray(workshopHelpRequests.status, ["open", "claimed"]),
        ),
      ),
  ]);
  await revokeWorkshopSessionAssistRoutes({
    sessionId: params.sessionId,
    now: params.now,
  });
  await teardownWorkshopSessionRuntimes({
    sessionId: params.sessionId,
    now: params.now,
  });
}

function isTerminalCleanupRetry(
  params: {
    state?: WorkshopSessionState;
    currentAgendaItemId?: string | null;
    currentModuleId?: string | null;
    currentSlideId?: string | null;
    timer?: { startedAt: number; endsAt: number } | null;
    announcement?: string | null;
  },
  currentState: "ended" | "cancelled",
): boolean {
  return (
    params.state === currentState &&
    params.currentAgendaItemId === undefined &&
    params.currentModuleId === undefined &&
    params.currentSlideId === undefined &&
    params.timer === undefined &&
    params.announcement === undefined
  );
}

function workshopCleanupErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "unknown error";
}

function sessionSelection() {
  return {
    id: workshopSessions.id,
    organizationId: workshopSessions.organizationId,
    templateRevisionId: workshopSessions.templateRevisionId,
    templateId: workshopTemplates.id,
    templateSlug: workshopTemplates.slug,
    templateTitle: workshopTemplates.title,
    title: workshopSessions.title,
    state: workshopSessions.state,
    version: workshopSessions.version,
    scheduledStartAt: workshopSessions.scheduledStartAt,
    lobbyOpensAt: workshopSessions.lobbyOpensAt,
    currentAgendaItemId: workshopSessions.currentAgendaItemId,
    currentModuleId: workshopSessions.currentModuleId,
    currentSlideId: workshopSessions.currentSlideId,
    releasedModuleIds: workshopSessions.releasedModuleIdsJson,
    revealedHintIds: workshopSessions.revealedHintIdsJson,
    revealedSolutionModuleIds: workshopSessions.revealedSolutionModuleIdsJson,
    timerStartedAt: workshopSessions.timerStartedAt,
    timerEndsAt: workshopSessions.timerEndsAt,
    timerPausedAt: workshopSessions.timerPausedAt,
    timerRemainingMs: workshopSessions.timerRemainingMs,
    announcement: workshopSessions.announcement,
    startedAt: workshopSessions.startedAt,
    endedAt: workshopSessions.endedAt,
    cancelledAt: workshopSessions.cancelledAt,
    createdAt: workshopSessions.createdAt,
    updatedAt: workshopSessions.updatedAt,
  };
}

function sessionRecord(row: WorkshopSessionRecord): WorkshopSessionRecord {
  return row;
}

function isWorkshopSessionRole(value: string): value is WorkshopSessionRole {
  return (
    value === "participant" || value === "helper" || value === "facilitator"
  );
}

function requireUnixMs(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw appError(
      400,
      "workshop_time_invalid",
      `${label} must be a Unix millisecond timestamp`,
    );
  }
  return value;
}

function validateAnnouncement(value: string | null): string | null {
  if (value === null) return null;
  const announcement = value.trim();
  if (announcement.length > 1_000) {
    throw appError(
      400,
      "workshop_announcement_invalid",
      "workshop announcement must be at most 1000 characters",
    );
  }
  return announcement || null;
}

function versionConflict() {
  return appError(
    409,
    "workshop_version_conflict",
    "workshop session was changed by another facilitator",
  );
}
