import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import {
  workshopAssistGrants,
  workshopHelpRequests,
  workshopWorkspaces,
} from "@/db/schema";
import { appError, errorChainMatches } from "@/lib/app-error";
import { createAppId } from "@/lib/id";
import { deleteStargateRoute } from "@/lib/stargate";
import {
  appendWorkshopEvent,
  loadWorkshopManifestForSession,
  requireManifestModule,
  requireWorkshopHelper,
  requireWorkshopSessionMember,
  workshopDb,
} from "./shared";
import { revokeWorkshopRouteIssuanceIntents } from "./route-issuance-intents";
import type {
  WorkshopAssistGrantRecord,
  WorkshopHelpRequestRecord,
} from "./types";
import { validateHelpMessage } from "./validation";

const INITIAL_ASSIST_MS = 15 * 60 * 1_000;
const MAX_ASSIST_MS = 30 * 60 * 1_000;

export async function createWorkshopHelpRequest(params: {
  sessionId: string;
  userId: string;
  moduleId?: string | null;
  message: string;
}): Promise<WorkshopHelpRequestRecord> {
  const access = await requireWorkshopSessionMember(params);
  if (access.role !== "participant") {
    throw appError(
      403,
      "workshop_participant_required",
      "only workshop participants can request help",
    );
  }
  if (access.state !== "lobby" && access.state !== "live") {
    throw appError(
      409,
      "workshop_help_closed",
      "workshop help requests are closed",
    );
  }
  const moduleId = params.moduleId?.trim() || null;
  if (moduleId) {
    const { manifest } = await loadWorkshopManifestForSession(params.sessionId);
    requireManifestModule(manifest, moduleId);
  }
  const message = validateHelpMessage(params.message);
  const id = createAppId();
  const now = Date.now();
  const db = workshopDb();
  try {
    await db.insert(workshopHelpRequests).values({
      id,
      sessionId: params.sessionId,
      requesterUserId: params.userId,
      moduleId,
      message,
      status: "open",
      activeKey: `${params.sessionId}:${params.userId}`,
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    if (errorChainMatches(error, /UNIQUE constraint failed/i)) {
      throw appError(
        409,
        "workshop_help_request_active",
        "this participant already has an active help request",
      );
    }
    throw error;
  }
  await appendWorkshopEvent(db, {
    organizationId: access.organizationId,
    sessionId: params.sessionId,
    actorUserId: params.userId,
    type: "help.requested",
    payload: { helpRequestId: id, moduleId },
    createdAt: now,
  });
  return {
    id,
    requesterUserId: params.userId,
    moduleId,
    message,
    status: "open",
    claimedBy: null,
    claimedAt: null,
    resolvedAt: null,
    cancelledAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function claimWorkshopHelpRequest(params: {
  sessionId: string;
  helpRequestId: string;
  helperUserId: string;
}): Promise<WorkshopHelpRequestRecord> {
  const access = await requireWorkshopHelper({
    sessionId: params.sessionId,
    userId: params.helperUserId,
  });
  if (access.state !== "lobby" && access.state !== "live") {
    throw appError(
      409,
      "workshop_help_closed",
      "workshop help requests are closed",
    );
  }
  const now = Date.now();
  const db = workshopDb();
  const rows = await db
    .update(workshopHelpRequests)
    .set({
      status: "claimed",
      claimedBy: params.helperUserId,
      claimedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(workshopHelpRequests.id, params.helpRequestId),
        eq(workshopHelpRequests.sessionId, params.sessionId),
        eq(workshopHelpRequests.status, "open"),
        sql`EXISTS (
          SELECT 1
          FROM workshop_sessions session
          JOIN workshop_session_members helper_roster
            ON helper_roster.session_id = session.id
           AND helper_roster.user_id = ${params.helperUserId}
           AND helper_roster.role IN ('helper', 'facilitator')
          JOIN member helper_member
            ON helper_member.organization_id = session.organization_id
           AND helper_member.user_id = ${params.helperUserId}
          WHERE session.id = ${params.sessionId}
            AND session.state IN ('lobby', 'live')
            AND helper_member.workshop_access_revoking_at IS NULL
        )`,
      ),
    )
    .returning();
  const row = rows[0];
  if (!row) {
    const existing = await loadHelpRequest(params.sessionId, params.helpRequestId);
    if (existing.claimedBy === params.helperUserId && existing.status === "claimed") {
      return existing;
    }
    throw appError(
      409,
      "workshop_help_request_unavailable",
      "help request is no longer available",
    );
  }
  await appendWorkshopEvent(db, {
    organizationId: access.organizationId,
    sessionId: params.sessionId,
    actorUserId: params.helperUserId,
    type: "help.claimed",
    payload: { helpRequestId: params.helpRequestId },
    createdAt: now,
  });
  return helpRequestRecord(row);
}

export async function closeWorkshopHelpRequest(params: {
  sessionId: string;
  helpRequestId: string;
  actorUserId: string;
  action: "resolve" | "cancel";
}): Promise<WorkshopHelpRequestRecord> {
  const access = await requireWorkshopSessionMember({
    sessionId: params.sessionId,
    userId: params.actorUserId,
  });
  const request = await loadHelpRequest(params.sessionId, params.helpRequestId);
  const canResolve =
    params.action === "resolve" &&
    (access.role === "facilitator" ||
      access.role === "helper") &&
    request.claimedBy === params.actorUserId;
  const canCancel =
    params.action === "cancel" && request.requesterUserId === params.actorUserId;
  if (!canResolve && !canCancel) {
    throw appError(
      403,
      "workshop_help_request_forbidden",
      "this workshop help request cannot be changed by the current user",
    );
  }
  if (request.status !== "open" && request.status !== "claimed") {
    await revokeWorkshopHelpRequestAssist({
      sessionId: params.sessionId,
      helpRequestId: params.helpRequestId,
      actorUserId: params.actorUserId,
    });
    return request;
  }
  if (access.state !== "lobby" && access.state !== "live") {
    throw appError(
      409,
      "workshop_help_closed",
      "workshop help requests are closed",
    );
  }
  await revokeWorkshopHelpRequestAssist({
    sessionId: params.sessionId,
    helpRequestId: params.helpRequestId,
    actorUserId: params.actorUserId,
  });
  const now = Date.now();
  const status = params.action === "resolve" ? "resolved" : "cancelled";
  const db = workshopDb();
  const actorGuard =
    params.action === "resolve"
      ? sql`EXISTS (
          SELECT 1
          FROM workshop_sessions session
          JOIN workshop_session_members actor_roster
            ON actor_roster.session_id = session.id
           AND actor_roster.user_id = ${params.actorUserId}
           AND actor_roster.role IN ('helper', 'facilitator')
          JOIN member actor_member
            ON actor_member.organization_id = session.organization_id
           AND actor_member.user_id = ${params.actorUserId}
          WHERE session.id = ${params.sessionId}
            AND session.state IN ('lobby', 'live')
            AND actor_member.workshop_access_revoking_at IS NULL
            AND ${workshopHelpRequests.claimedBy} = ${params.actorUserId}
        )`
      : sql`EXISTS (
          SELECT 1
          FROM workshop_sessions session
          JOIN workshop_session_members actor_roster
            ON actor_roster.session_id = session.id
           AND actor_roster.user_id = ${params.actorUserId}
           AND actor_roster.role = 'participant'
          JOIN member actor_member
            ON actor_member.organization_id = session.organization_id
           AND actor_member.user_id = ${params.actorUserId}
          WHERE session.id = ${params.sessionId}
            AND session.state IN ('lobby', 'live')
            AND actor_member.workshop_access_revoking_at IS NULL
            AND ${workshopHelpRequests.requesterUserId} = ${params.actorUserId}
        )`;
  const rows = await db
    .update(workshopHelpRequests)
    .set({
      status,
      activeKey: null,
      resolvedAt: status === "resolved" ? now : null,
      cancelledAt: status === "cancelled" ? now : null,
      updatedAt: now,
    })
    .where(
      and(
        eq(workshopHelpRequests.id, params.helpRequestId),
        eq(workshopHelpRequests.sessionId, params.sessionId),
        inArray(workshopHelpRequests.status, ["open", "claimed"]),
        actorGuard,
      ),
    )
    .returning();
  const result = rows[0]
    ? helpRequestRecord(rows[0])
    : await loadHelpRequest(params.sessionId, params.helpRequestId);
  if (
    !rows[0] &&
    (result.status === "open" || result.status === "claimed")
  ) {
    throw appError(
      409,
      "workshop_help_request_unavailable",
      "help request authorization changed before it could be updated",
    );
  }
  if (rows[0]) {
    await appendWorkshopEvent(db, {
      organizationId: access.organizationId,
      sessionId: params.sessionId,
      actorUserId: params.actorUserId,
      type: `help.${status}`,
      payload: { helpRequestId: params.helpRequestId },
      createdAt: now,
    });
  }
  return result;
}

export async function grantWorkshopAssist(params: {
  sessionId: string;
  helpRequestId: string;
  learnerUserId: string;
}): Promise<WorkshopAssistGrantRecord> {
  const access = await requireWorkshopSessionMember({
    sessionId: params.sessionId,
    userId: params.learnerUserId,
  });
  if (access.role !== "participant") {
    throw appError(
      403,
      "workshop_participant_required",
      "only the workspace owner can grant helper access",
    );
  }
  if (access.state !== "lobby" && access.state !== "live") {
    throw appError(
      409,
      "workshop_assist_closed",
      "workshop assistance is closed",
    );
  }
  const db = workshopDb();
  const [requests, workspaces] = await Promise.all([
    db
      .select()
      .from(workshopHelpRequests)
      .where(
        and(
          eq(workshopHelpRequests.id, params.helpRequestId),
          eq(workshopHelpRequests.sessionId, params.sessionId),
          eq(workshopHelpRequests.requesterUserId, params.learnerUserId),
        ),
      )
      .limit(1),
    db
      .select({ id: workshopWorkspaces.id })
      .from(workshopWorkspaces)
      .where(
        and(
          eq(workshopWorkspaces.sessionId, params.sessionId),
          eq(workshopWorkspaces.userId, params.learnerUserId),
          eq(workshopWorkspaces.state, "ready"),
        ),
      )
      .limit(1),
  ]);
  const request = requests[0];
  const workspace = workspaces[0];
  if (!request || request.status !== "claimed" || !request.claimedBy) {
    throw appError(
      409,
      "workshop_help_request_not_claimed",
      "a helper must claim the help request before access can be granted",
    );
  }
  if (!workspace) {
    throw appError(
      409,
      "workshop_workspace_not_ready",
      "workshop workspace is not ready",
    );
  }
  const now = Date.now();
  const expiresAt = now + INITIAL_ASSIST_MS;
  const id = createAppId();
  try {
    await db.insert(workshopAssistGrants).values({
      id,
      sessionId: params.sessionId,
      workspaceId: workspace.id,
      helpRequestId: params.helpRequestId,
      learnerUserId: params.learnerUserId,
      helperUserId: request.claimedBy,
      grantedAt: now,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    if (errorChainMatches(error, /UNIQUE constraint failed/i)) {
      throw appError(
        409,
        "workshop_assist_already_granted",
        "this help request already has an assistance grant",
      );
    }
    throw error;
  }
  await appendWorkshopEvent(db, {
    organizationId: access.organizationId,
    sessionId: params.sessionId,
    actorUserId: params.learnerUserId,
    type: "assist.granted",
    payload: {
      grantId: id,
      workspaceId: workspace.id,
      helperUserId: request.claimedBy,
      expiresAt,
    },
    createdAt: now,
  });
  return {
    id,
    sessionId: params.sessionId,
    workspaceId: workspace.id,
    helpRequestId: params.helpRequestId,
    learnerUserId: params.learnerUserId,
    helperUserId: request.claimedBy,
    grantedAt: now,
    expiresAt,
    revokedAt: null,
    revokedBy: null,
    active: true,
  };
}

export async function extendWorkshopAssist(params: {
  sessionId: string;
  grantId: string;
  learnerUserId: string;
}): Promise<WorkshopAssistGrantRecord> {
  const access = await requireWorkshopSessionMember({
    sessionId: params.sessionId,
    userId: params.learnerUserId,
  });
  const grant = await loadAssistGrant(params.sessionId, params.grantId);
  if (grant.learnerUserId !== params.learnerUserId) {
    throw appError(
      403,
      "workshop_assist_owner_required",
      "only the workspace owner can extend helper access",
    );
  }
  const now = Date.now();
  if (!grant.active || grant.expiresAt <= now) {
    throw appError(
      409,
      "workshop_assist_expired",
      "expired or revoked assistance cannot be extended",
    );
  }
  const expiresAt = grant.grantedAt + MAX_ASSIST_MS;
  if (grant.expiresAt >= expiresAt) return grant;
  const db = workshopDb();
  const updated = await db
    .update(workshopAssistGrants)
    .set({ expiresAt, updatedAt: now })
    .where(
      and(
        eq(workshopAssistGrants.id, params.grantId),
        eq(workshopAssistGrants.expiresAt, grant.expiresAt),
        isNull(workshopAssistGrants.revokedAt),
        gt(workshopAssistGrants.expiresAt, now),
      ),
    )
    .returning({ id: workshopAssistGrants.id });
  if (updated.length) {
    await appendWorkshopEvent(db, {
      organizationId: access.organizationId,
      sessionId: params.sessionId,
      actorUserId: params.learnerUserId,
      type: "assist.extended",
      payload: {
        grantId: params.grantId,
        workspaceId: grant.workspaceId,
        helperUserId: grant.helperUserId,
        previousExpiresAt: grant.expiresAt,
        expiresAt,
      },
      createdAt: now,
    });
  }
  return loadAssistGrant(params.sessionId, params.grantId, now);
}

export function canExtendWorkshopAssist(
  grant: WorkshopAssistGrantRecord,
): boolean {
  return grant.active && grant.expiresAt < grant.grantedAt + MAX_ASSIST_MS;
}

export async function revokeWorkshopAssist(params: {
  sessionId: string;
  grantId: string;
  actorUserId: string;
}): Promise<WorkshopAssistGrantRecord> {
  const access = await requireWorkshopSessionMember({
    sessionId: params.sessionId,
    userId: params.actorUserId,
  });
  const grant = await loadAssistGrant(params.sessionId, params.grantId);
  if (
    grant.learnerUserId !== params.actorUserId &&
    grant.helperUserId !== params.actorUserId
  ) {
    throw appError(
      403,
      "workshop_assist_revoke_forbidden",
      "only the learner or assigned helper can revoke assistance",
    );
  }
  const db = workshopDb();
  const routeRows = await db
    .select({
      routeUsernames: workshopAssistGrants.terminalRouteUsernamesJson,
    })
    .from(workshopAssistGrants)
    .where(eq(workshopAssistGrants.id, params.grantId))
    .limit(1);
  const routeUsernames = routeRows[0]?.routeUsernames ?? [];
  const now = Date.now();
  if (grant.revokedAt === null) {
    await db
      .update(workshopAssistGrants)
      .set({ revokedAt: now, revokedBy: params.actorUserId, updatedAt: now })
      .where(
        and(
          eq(workshopAssistGrants.id, params.grantId),
          isNull(workshopAssistGrants.revokedAt),
        ),
      );
    await appendWorkshopEvent(db, {
      organizationId: access.organizationId,
      sessionId: params.sessionId,
      actorUserId: params.actorUserId,
      type: "assist.revoked",
      payload: { grantId: params.grantId, routeUsernames },
      createdAt: now,
    });
  }
  await revokeWorkshopAssistRoutes({
    grantId: params.grantId,
    workspaceId: grant.workspaceId,
    helperUserId: grant.helperUserId,
    routeUsernames,
    now,
  });
  return loadAssistGrant(params.sessionId, params.grantId, now);
}

export async function findWorkshopAssistGrantForRevocation(params: {
  sessionId: string;
  actorUserId: string;
  now?: number;
}): Promise<WorkshopAssistGrantRecord | null> {
  await requireWorkshopSessionMember({
    sessionId: params.sessionId,
    userId: params.actorUserId,
  });
  const now = params.now ?? Date.now();
  const rows = await workshopDb()
    .select()
    .from(workshopAssistGrants)
    .where(
      and(
        eq(workshopAssistGrants.sessionId, params.sessionId),
        or(
          eq(workshopAssistGrants.learnerUserId, params.actorUserId),
          eq(workshopAssistGrants.helperUserId, params.actorUserId),
        ),
        or(
          and(
            isNull(workshopAssistGrants.revokedAt),
            gt(workshopAssistGrants.expiresAt, now),
          ),
          sql`json_array_length(${workshopAssistGrants.terminalRouteUsernamesJson}) > 0`,
        ),
      ),
    )
    .orderBy(desc(workshopAssistGrants.updatedAt))
    .limit(1);
  return rows[0] ? assistGrantRecord(rows[0], now) : null;
}

export async function revokeWorkshopSessionAssistRoutes(params: {
  sessionId: string;
  now?: number;
}): Promise<void> {
  const now = params.now ?? Date.now();
  const rows = await workshopDb()
    .select({
      id: workshopAssistGrants.id,
      workspaceId: workshopAssistGrants.workspaceId,
      helperUserId: workshopAssistGrants.helperUserId,
      routeUsernames: workshopAssistGrants.terminalRouteUsernamesJson,
    })
    .from(workshopAssistGrants)
    .where(eq(workshopAssistGrants.sessionId, params.sessionId))
    .orderBy(workshopAssistGrants.createdAt);
  for (const row of rows) {
    await revokeWorkshopAssistRoutes({
      grantId: row.id,
      workspaceId: row.workspaceId,
      helperUserId: row.helperUserId,
      routeUsernames: row.routeUsernames,
      now,
    });
  }
}

export async function requireActiveWorkshopAssistGrant(params: {
  sessionId: string;
  workspaceId: string;
  helperUserId: string;
  now?: number;
}): Promise<WorkshopAssistGrantRecord> {
  await requireWorkshopHelper({
    sessionId: params.sessionId,
    userId: params.helperUserId,
  });
  const now = params.now ?? Date.now();
  const rows = await workshopDb()
    .select()
    .from(workshopAssistGrants)
    .where(
      and(
        eq(workshopAssistGrants.sessionId, params.sessionId),
        eq(workshopAssistGrants.workspaceId, params.workspaceId),
        eq(workshopAssistGrants.helperUserId, params.helperUserId),
        isNull(workshopAssistGrants.revokedAt),
        gt(workshopAssistGrants.expiresAt, now),
      ),
    )
    .orderBy(desc(workshopAssistGrants.expiresAt))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw appError(
      403,
      "workshop_assist_grant_required",
      "an active learner assistance grant is required",
    );
  }
  return assistGrantRecord(row, now);
}

export async function listWorkshopHelpRequests(
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
          )
        : eq(workshopHelpRequests.sessionId, sessionId),
    )
    .orderBy(desc(workshopHelpRequests.createdAt));
  return rows.map(helpRequestRecord);
}

export async function listActiveWorkshopAssistGrants(params: {
  sessionId: string;
  userId?: string;
  now?: number;
}): Promise<WorkshopAssistGrantRecord[]> {
  const now = params.now ?? Date.now();
  const rows = await workshopDb()
    .select()
    .from(workshopAssistGrants)
    .where(
      and(
        eq(workshopAssistGrants.sessionId, params.sessionId),
        isNull(workshopAssistGrants.revokedAt),
        gt(workshopAssistGrants.expiresAt, now),
        params.userId
          ? inArray(workshopAssistGrants.learnerUserId, [params.userId])
          : undefined,
      ),
    );
  return rows.map((row) => assistGrantRecord(row, now));
}

async function loadHelpRequest(
  sessionId: string,
  id: string,
): Promise<WorkshopHelpRequestRecord> {
  const rows = await workshopDb()
    .select()
    .from(workshopHelpRequests)
    .where(
      and(
        eq(workshopHelpRequests.id, id),
        eq(workshopHelpRequests.sessionId, sessionId),
      ),
    )
    .limit(1);
  if (!rows[0]) {
    throw appError(
      404,
      "workshop_help_request_not_found",
      "workshop help request not found",
    );
  }
  return helpRequestRecord(rows[0]);
}

async function loadAssistGrant(
  sessionId: string,
  id: string,
  now = Date.now(),
): Promise<WorkshopAssistGrantRecord> {
  const rows = await workshopDb()
    .select()
    .from(workshopAssistGrants)
    .where(
      and(
        eq(workshopAssistGrants.id, id),
        eq(workshopAssistGrants.sessionId, sessionId),
      ),
    )
    .limit(1);
  if (!rows[0]) {
    throw appError(
      404,
      "workshop_assist_grant_not_found",
      "workshop assistance grant not found",
    );
  }
  return assistGrantRecord(rows[0], now);
}

async function revokeWorkshopHelpRequestAssist(params: {
  sessionId: string;
  helpRequestId: string;
  actorUserId: string;
}): Promise<void> {
  const grants = await workshopDb()
    .select({ id: workshopAssistGrants.id })
    .from(workshopAssistGrants)
    .where(
      and(
        eq(workshopAssistGrants.sessionId, params.sessionId),
        eq(workshopAssistGrants.helpRequestId, params.helpRequestId),
      ),
    )
    .orderBy(desc(workshopAssistGrants.createdAt));
  for (const grant of grants) {
    await revokeWorkshopAssist({
      sessionId: params.sessionId,
      grantId: grant.id,
      actorUserId: params.actorUserId,
    });
  }
}

async function revokeWorkshopAssistRoutes(params: {
  grantId: string;
  workspaceId: string;
  helperUserId: string;
  routeUsernames: readonly string[];
  now: number;
}): Promise<void> {
  const routeUsernames = [...new Set(params.routeUsernames)];
  const [intentCleanup, recordedRouteCleanup] = await Promise.allSettled([
    revokeWorkshopRouteIssuanceIntents({
      workspaceId: params.workspaceId,
      actorUserId: params.helperUserId,
      kind: "terminal",
    }),
    Promise.all(
      routeUsernames.map((routeUsername) => deleteStargateRoute(routeUsername)),
    ),
  ]);
  if (recordedRouteCleanup.status === "rejected") {
    throw recordedRouteCleanup.reason;
  }
  if (!routeUsernames.length) {
    if (intentCleanup.status === "rejected") throw intentCleanup.reason;
    return;
  }

  const routesJson = JSON.stringify(routeUsernames);
  const db = workshopDb();
  await db.batch([
    db
      .update(workshopAssistGrants)
      .set({ terminalRouteUsernamesJson: [], updatedAt: params.now })
      .where(eq(workshopAssistGrants.id, params.grantId)),
    db
      .update(workshopWorkspaces)
      .set({
        terminalRouteUsernamesJson: sql`coalesce(
          (
            select json_group_array(value)
            from json_each(${workshopWorkspaces.terminalRouteUsernamesJson})
            where value not in (select value from json_each(${routesJson}))
          ),
          '[]'
        )`,
        updatedAt: params.now,
      })
      .where(eq(workshopWorkspaces.id, params.workspaceId)),
  ]);
  if (intentCleanup.status === "rejected") throw intentCleanup.reason;
}

function helpRequestRecord(
  row: typeof workshopHelpRequests.$inferSelect,
): WorkshopHelpRequestRecord {
  return {
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
  };
}

function assistGrantRecord(
  row: typeof workshopAssistGrants.$inferSelect,
  now = Date.now(),
): WorkshopAssistGrantRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    workspaceId: row.workspaceId,
    helpRequestId: row.helpRequestId,
    learnerUserId: row.learnerUserId,
    helperUserId: row.helperUserId,
    grantedAt: row.grantedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    revokedBy: row.revokedBy,
    active: row.revokedAt === null && row.expiresAt > now,
  };
}
