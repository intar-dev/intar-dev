import { env } from "cloudflare:workers";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  member,
  workshopEvents,
  workshopSessionMembers,
  workshopSessions,
  workshopTemplateRevisions,
  workshopTemplates,
  type WorkshopManifestV1,
  type WorkshopSessionRole,
  type WorkshopSessionState,
} from "@/db/schema";
import { appError } from "@/lib/app-error";
import { createAppId } from "@/lib/id";
import {
  isOrganizationAdminRole,
  type OrganizationRole,
} from "@/lib/organizations";

export type WorkshopDb = ReturnType<typeof drizzle>;

export function workshopDb(): WorkshopDb {
  return drizzle(env.DB);
}

export interface WorkshopSessionAccess {
  sessionId: string;
  organizationId: string;
  templateRevisionId: string;
  state: WorkshopSessionState;
  version: number;
  role: WorkshopSessionRole;
  organizationRole: OrganizationRole | null;
}

export interface WorkshopManagerAccess {
  sessionId: string;
  organizationId: string;
  templateRevisionId: string;
  state: WorkshopSessionState;
  version: number;
  organizationRole: OrganizationRole;
  sessionRole: WorkshopSessionRole | null;
}

export async function requireWorkshopSessionMember(params: {
  sessionId: string;
  userId: string;
}): Promise<WorkshopSessionAccess> {
  const rows = await workshopDb()
    .select({
      sessionId: workshopSessions.id,
      organizationId: workshopSessions.organizationId,
      templateRevisionId: workshopSessions.templateRevisionId,
      state: workshopSessions.state,
      version: workshopSessions.version,
      role: workshopSessionMembers.role,
      organizationMembershipId: member.id,
      organizationRole: member.role,
    })
    .from(workshopSessionMembers)
    .innerJoin(
      workshopSessions,
      eq(workshopSessionMembers.sessionId, workshopSessions.id),
    )
    .leftJoin(
      member,
      and(
        eq(member.organizationId, workshopSessions.organizationId),
        eq(member.userId, params.userId),
        isNull(member.workshopAccessRevokingAt),
      ),
    )
    .where(
      and(
        eq(workshopSessionMembers.sessionId, params.sessionId),
        eq(workshopSessionMembers.userId, params.userId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw appError(
      404,
      "workshop_session_not_found",
      "workshop session not found",
    );
  }
  const archived = row.state === "ended" || row.state === "cancelled";
  const canReadLearnerHistory = archived && row.role === "participant";
  if (!row.organizationMembershipId && !canReadLearnerHistory) {
    throw appError(
      404,
      "workshop_session_not_found",
      "workshop session not found",
    );
  }
  return {
    sessionId: row.sessionId,
    organizationId: row.organizationId,
    templateRevisionId: row.templateRevisionId,
    state: row.state,
    version: row.version,
    role: row.role,
    organizationRole: (row.organizationRole as OrganizationRole | null) ?? null,
  };
}

export async function requireWorkshopManager(params: {
  sessionId: string;
  userId: string;
}): Promise<WorkshopManagerAccess> {
  const db = workshopDb();
  const sessions = await db
    .select({
      sessionId: workshopSessions.id,
      organizationId: workshopSessions.organizationId,
      templateRevisionId: workshopSessions.templateRevisionId,
      state: workshopSessions.state,
      version: workshopSessions.version,
    })
    .from(workshopSessions)
    .where(eq(workshopSessions.id, params.sessionId))
    .limit(1);
  const session = sessions[0];
  if (!session) {
    throw appError(
      404,
      "workshop_session_not_found",
      "workshop session not found",
    );
  }
  const [memberships, roster] = await Promise.all([
    db
      .select({ role: member.role })
      .from(member)
      .where(
        and(
          eq(member.organizationId, session.organizationId),
          eq(member.userId, params.userId),
          isNull(member.workshopAccessRevokingAt),
        ),
      )
      .limit(1),
    db
      .select({ role: workshopSessionMembers.role })
      .from(workshopSessionMembers)
      .where(
        and(
          eq(workshopSessionMembers.sessionId, params.sessionId),
          eq(workshopSessionMembers.userId, params.userId),
        ),
      )
      .limit(1),
  ]);
  const organizationRole = memberships[0]?.role as OrganizationRole | undefined;
  if (!organizationRole) {
    throw appError(
      404,
      "workshop_session_not_found",
      "workshop session not found",
    );
  }
  const sessionRole = roster[0]?.role ?? null;
  if (
    !isOrganizationAdminRole(organizationRole) &&
    sessionRole !== "facilitator"
  ) {
    throw appError(
      403,
      "workshop_facilitator_required",
      "workshop facilitator role required",
    );
  }
  return { ...session, organizationRole, sessionRole };
}

export async function requireWorkshopHelper(params: {
  sessionId: string;
  userId: string;
}): Promise<WorkshopSessionAccess> {
  const access = await requireWorkshopSessionMember(params);
  if (access.role !== "helper" && access.role !== "facilitator") {
    throw appError(
      403,
      "workshop_helper_required",
      "workshop helper role required",
    );
  }
  return access;
}

export function workshopManagerMutationGuard(
  sessionId: string,
  actorUserId: string,
): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM workshop_sessions guard_session
    JOIN member actor_member
      ON actor_member.organization_id = guard_session.organization_id
     AND actor_member.user_id = ${actorUserId}
    WHERE guard_session.id = ${sessionId}
      AND actor_member.workshop_access_revoking_at IS NULL
      AND (
        actor_member.role IN ('owner', 'admin')
        OR EXISTS (
          SELECT 1
          FROM workshop_session_members actor_roster
          WHERE actor_roster.session_id = guard_session.id
            AND actor_roster.user_id = ${actorUserId}
            AND actor_roster.role = 'facilitator'
        )
      )
  )`;
}

export function workshopHelperMutationGuard(
  sessionId: string,
  actorUserId: string,
): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM workshop_sessions guard_session
    JOIN workshop_session_members actor_roster
      ON actor_roster.session_id = guard_session.id
     AND actor_roster.user_id = ${actorUserId}
     AND actor_roster.role IN ('helper', 'facilitator')
    JOIN member actor_member
      ON actor_member.organization_id = guard_session.organization_id
     AND actor_member.user_id = ${actorUserId}
    WHERE guard_session.id = ${sessionId}
      AND actor_member.workshop_access_revoking_at IS NULL
  )`;
}

export async function loadWorkshopManifestForSession(
  sessionId: string,
): Promise<{
  organizationId: string;
  templateId: string;
  templateRevisionId: string;
  manifest: WorkshopManifestV1;
}> {
  const rows = await workshopDb()
    .select({
      organizationId: workshopSessions.organizationId,
      templateId: workshopTemplates.id,
      templateRevisionId: workshopTemplateRevisions.id,
      manifest: workshopTemplateRevisions.manifestJson,
    })
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
  return row;
}

export function requireManifestModule(
  manifest: WorkshopManifestV1,
  moduleId: string,
): WorkshopManifestV1["modules"][number] {
  const module = manifest.modules.find((entry) => entry.id === moduleId);
  if (!module) {
    throw appError(
      404,
      "workshop_module_not_found",
      "workshop module not found",
    );
  }
  return module;
}

export function workshopModuleRequiredPrefixIds(
  manifest: WorkshopManifestV1,
  moduleId: string,
): string[] | null {
  const ordinal = manifest.modules.findIndex((module) => module.id === moduleId);
  return ordinal < 0
    ? null
    : manifest.modules.slice(0, ordinal + 1).map((module) => module.id);
}

export function workshopCheckpointRequiredPrefixIds(
  manifest: WorkshopManifestV1,
  checkpointId: string,
): string[] | null {
  if (checkpointId === manifest.workspace.initialCheckpointId) return [];
  let ownerOrdinal = -1;
  for (const [ordinal, module] of manifest.modules.entries()) {
    if (module.catchUpCheckpointId === checkpointId) ownerOrdinal = ordinal;
  }
  return ownerOrdinal < 0
    ? null
    : manifest.modules.slice(0, ownerOrdinal + 1).map((module) => module.id);
}

export function workshopReleaseIncludesPrefix(
  releasedModuleIds: readonly string[],
  requiredModuleIds: readonly string[],
): boolean {
  const released = new Set(releasedModuleIds);
  return requiredModuleIds.every((moduleId) => released.has(moduleId));
}

export async function appendWorkshopEvent(
  db: WorkshopDb,
  params: {
    organizationId: string;
    sessionId: string;
    actorUserId?: string | null;
    type: string;
    payload?: Record<string, unknown>;
    createdAt?: number;
  },
): Promise<void> {
  await db.insert(workshopEvents).values({
    id: createAppId(),
    organizationId: params.organizationId,
    sessionId: params.sessionId,
    actorUserId: params.actorUserId ?? null,
    type: params.type,
    payloadJson: params.payload ?? {},
    createdAt: params.createdAt ?? Date.now(),
  });
}
