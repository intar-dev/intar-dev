import { env } from "cloudflare:workers";
import { and, count, desc, eq, inArray, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  account,
  agentHosts,
  hostEnrollments,
  imageBuildBundles,
  imageBuilds,
  member,
  organization,
  organizationMemberRemovals,
  organizationMemberRemovedLogins,
  personalImagePreparations,
  scenarioRuns,
  ssoProvider,
  user,
  vmScenarios,
} from "@/db/schema";
import { activeAdminSql } from "@/lib/account-access";
import { signOutQueries } from "@/lib/account-sign-out";
import { appError, errorChainMatches } from "@/lib/app-error";
import { createAppId } from "@/lib/id";
import {
  canCreateOrganization,
  hasReachedOwnedOrganizationLimit,
} from "@/lib/organization-access";
import {
  activeAdministrator,
  adminRequiredError,
  isActiveAdmin,
} from "@/lib/platform-admin-authority";
import type { FeatureToggleService } from "@/lib/feature-toggles";

export type OrganizationRole = "owner" | "admin" | "member";

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  role: OrganizationRole;
  memberCount: number;
  createdAt: number;
}

export interface OrganizationMemberRecord {
  memberId: string;
  userId: string;
  name: string;
  email: string;
  githubUsername: string | null;
  role: OrganizationRole;
  joinedAt: number;
}

/** Someone an admin removed; the organization's provider can't sign them in. */
export interface OrganizationRemovedMemberRecord {
  userId: string;
  name: string;
  email: string;
  githubUsername: string | null;
  removedAt: number;
}

const ORGANIZATION_NAME_MAX = 60;

export function isOrganizationAdminRole(role: OrganizationRole): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Drizzle condition that holds while `userId` is an owner or admin of the
 * organization, for writes that recheck their actor in the statement.
 */
function administersOrganization(organizationId: string, userId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM member actor WHERE actor.organization_id = ${organizationId}
    AND actor.user_id = ${userId} AND actor.role IN ('owner', 'admin'))`;
}

export async function requireOrganizationRole(params: {
  organizationId: string;
  userId: string;
  admin?: boolean;
}): Promise<OrganizationRole> {
  const rows = await drizzle(env.DB)
    .select({ role: member.role })
    .from(member)
    .where(
      and(
        eq(member.organizationId, params.organizationId),
        eq(member.userId, params.userId),
      ),
    )
    .limit(1);
  const role = rows[0]?.role as OrganizationRole | undefined;
  if (!role) {
    throw appError(404, "organization_not_found", "organization not found");
  }
  if (params.admin && !isOrganizationAdminRole(role)) {
    throw appError(
      403,
      "organization_admin_required",
      "organization admin role required",
    );
  }
  return role;
}

export async function resolveOrganizationId(
  organizationKey: string,
): Promise<string | null> {
  const key = organizationKey.trim();
  if (!key) return null;
  const rows = await drizzle(env.DB)
    .select({ id: organization.id })
    .from(organization)
    .where(or(eq(organization.id, key), eq(organization.slug, key)))
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function createOrganization(params: {
  name: string;
  ownerUserId: string;
  featureToggleService?: FeatureToggleService;
}): Promise<OrganizationSummary> {
  if (
    !(await canCreateOrganization(
      params.ownerUserId,
      params.featureToggleService,
    ))
  ) {
    throw appError(
      403,
      "organization_creation_disabled",
      "organization creation is not enabled for this account",
    );
  }
  if (await hasReachedOwnedOrganizationLimit(params.ownerUserId)) {
    throw appError(
      409,
      "organization_limit_reached",
      "this account already owns an organization",
    );
  }

  const name = validateOrganizationName(params.name);
  const id = createAppId();
  const baseSlug = slugifyOrganizationName(name) || "organization";
  const slug = `${baseSlug}-${id.slice(0, 6)}`;
  const now = Date.now();
  const db = drizzle(env.DB);

  try {
    await db.batch([
      db.insert(organization).values({
        id,
        name,
        slug,
        createdAt: new Date(now),
      }),
      db.insert(member).values({
        id: createAppId(),
        organizationId: id,
        userId: params.ownerUserId,
        role: "owner",
        createdAt: new Date(now),
      }),
    ]);
  } catch (error) {
    if (
      errorChainMatches(
        error,
        /member owner limit reached|member\.user_id|member_single_owner_uidx/i,
      )
    ) {
      throw appError(
        409,
        "organization_limit_reached",
        "this account already owns an organization",
      );
    }
    throw error;
  }

  return {
    id,
    name,
    slug,
    role: "owner",
    memberCount: 1,
    createdAt: now,
  };
}

export async function listOrganizationsForUser(params: {
  userId: string;
}): Promise<OrganizationSummary[]> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      role: member.role,
      createdAt: organization.createdAt,
    })
    .from(member)
    .innerJoin(organization, eq(member.organizationId, organization.id))
    .where(eq(member.userId, params.userId))
    .orderBy(desc(organization.createdAt));

  if (!rows.length) return [];
  const counts = await db
    .select({ organizationId: member.organizationId, memberCount: count() })
    .from(member)
    .where(
      inArray(
        member.organizationId,
        rows.map((row) => row.id),
      ),
    )
    .groupBy(member.organizationId);
  const countByOrganization = new Map(
    counts.map((row) => [row.organizationId, row.memberCount]),
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    role: row.role as OrganizationRole,
    memberCount: countByOrganization.get(row.id) ?? 1,
    createdAt: row.createdAt.getTime(),
  }));
}

export async function getOrganizationDetail(params: {
  organizationKey: string;
  userId: string;
}): Promise<{
  id: string;
  name: string;
  slug: string;
  createdAt: number;
  role: OrganizationRole;
  members: OrganizationMemberRecord[];
  /** Only organization admins see who was removed. */
  removedMembers: OrganizationRemovedMemberRecord[];
}> {
  const organizationId = await resolveOrganizationId(params.organizationKey);
  if (!organizationId) {
    throw appError(404, "organization_not_found", "organization not found");
  }
  const role = await requireOrganizationRole({
    organizationId,
    userId: params.userId,
  });
  const db = drizzle(env.DB);
  const [organizations, members, removedMembers] = await Promise.all([
    db
      .select()
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1),
    db
      .select({
        memberId: member.id,
        userId: member.userId,
        name: user.name,
        email: user.email,
        githubUsername: user.username,
        role: member.role,
        joinedAt: member.createdAt,
      })
      .from(member)
      .innerJoin(user, eq(member.userId, user.id))
      .where(eq(member.organizationId, organizationId))
      .orderBy(member.createdAt),
    isOrganizationAdminRole(role)
      ? listOrganizationRemovedMembers(organizationId)
      : Promise.resolve([]),
  ]);
  const record = organizations[0];
  if (!record) {
    throw appError(404, "organization_not_found", "organization not found");
  }

  return {
    id: record.id,
    name: record.name,
    slug: record.slug,
    createdAt: record.createdAt.getTime(),
    role,
    members: members.map((entry) => ({
      ...entry,
      role: entry.role as OrganizationRole,
      joinedAt: entry.joinedAt.getTime(),
    })),
    removedMembers,
  };
}

export async function updateOrganizationName(params: {
  organizationId: string;
  actorUserId: string;
  name: string;
}): Promise<{ id: string; name: string }> {
  await requireOrganizationRole({
    organizationId: params.organizationId,
    userId: params.actorUserId,
    admin: true,
  });
  const name = validateOrganizationName(params.name);
  await drizzle(env.DB)
    .update(organization)
    .set({ name })
    .where(eq(organization.id, params.organizationId));
  return { id: params.organizationId, name };
}

export async function deleteOrganization(params: {
  organizationId: string;
  actorUserId: string;
}): Promise<void> {
  const role = await requireOrganizationRole({
    organizationId: params.organizationId,
    userId: params.actorUserId,
  });
  if (role !== "owner") {
    throw appError(
      403,
      "owner_required",
      "only the organization owner can delete the organization",
    );
  }
  if (await organizationHasOwnedResources(params.organizationId)) {
    throw appError(
      409,
      "organization_not_empty",
      "remove the organization servers, scenarios, builds, and runs before deleting it",
    );
  }
  await drizzle(env.DB)
    .delete(organization)
    .where(eq(organization.id, params.organizationId));
}

export async function leaveOrganization(params: {
  organizationId: string;
  userId: string;
}): Promise<void> {
  const role = await requireOrganizationRole(params);
  if (role === "owner") {
    throw appError(
      400,
      "owner_cannot_leave",
      "transfer ownership or delete the organization first",
    );
  }
  const db = drizzle(env.DB);
  const [removed, runs] = await db.batch([
    db.delete(member)
    .where(
      and(
        eq(member.organizationId, params.organizationId),
        eq(member.userId, params.userId),
        ne(member.role, "owner"),
      ),
    ).returning({ id: member.id }),
    requestRemovedMemberRunShutdown(db, params),
    revokeUnauthorizedOrganizationEnrollments(db, params),
    deleteRemovedMemberImagePreparation(db, params),
  ]);
  if (removed.length !== 1) {
    throw appError(409, "organization_membership_changed", "organization membership changed while it was being removed");
  }
  await finishRemovedMemberRunShutdown(params.userId, runs);
}

export async function transferOrganizationOwnership(params: {
  organizationId: string;
  actorUserId: string;
  targetMemberId: string;
}): Promise<void> {
  const role = await requireOrganizationRole({
    organizationId: params.organizationId,
    userId: params.actorUserId,
  });
  if (role !== "owner") {
    throw appError(
      403,
      "owner_required",
      "only the organization owner can transfer ownership",
    );
  }
  const db = drizzle(env.DB);
  const targets = await db
    .select({ userId: member.userId })
    .from(member)
    .where(
      and(
        eq(member.id, params.targetMemberId),
        eq(member.organizationId, params.organizationId),
      ),
    )
    .limit(1);
  const target = targets[0];
  if (!target) throw appError(404, "member_not_found", "member not found");
  if (target.userId === params.actorUserId) {
    throw appError(
      400,
      "cannot_transfer_to_self",
      "you already own this organization",
    );
  }
  if (await hasReachedOwnedOrganizationLimit(target.userId)) {
    throw appError(
      409,
      "target_organization_limit_reached",
      "the selected member already owns an organization",
    );
  }

  const transferred = await env.DB.prepare(
    `WITH transfer_pair(target_id, owner_id) AS MATERIALIZED (
       SELECT transfer_target.id, current_owner.id
       FROM member transfer_target
       JOIN member current_owner
         ON current_owner.organization_id = transfer_target.organization_id
       WHERE transfer_target.id = ?
         AND transfer_target.organization_id = ?
         AND transfer_target.role <> 'owner'
         AND current_owner.user_id = ?
         AND current_owner.role = 'owner'
     )
     UPDATE member
     SET role = CASE
       WHEN id = (SELECT target_id FROM transfer_pair) THEN 'owner'
       WHEN id = (SELECT owner_id FROM transfer_pair) THEN 'admin'
       ELSE role
     END
     WHERE organization_id = ?
       AND id IN (
         SELECT target_id FROM transfer_pair
         UNION ALL
         SELECT owner_id FROM transfer_pair
       )
     RETURNING id, role`,
  )
    .bind(
      params.targetMemberId,
      params.organizationId,
      params.actorUserId,
      params.organizationId,
    )
    .all<{ id: string; role: string }>();
  if (
    transferred.results.length !== 2 ||
    !transferred.results.some(
      (entry) => entry.id === params.targetMemberId && entry.role === "owner",
    )
  ) {
    throw appError(
      409,
      "ownership_transfer_changed",
      "organization ownership changed while the transfer was being committed",
    );
  }
}

export async function updateOrganizationMemberRole(params: {
  organizationId: string;
  actorUserId: string;
  memberId: string;
  role: "admin" | "member";
}): Promise<void> {
  await requireOrganizationRole({
    organizationId: params.organizationId,
    userId: params.actorUserId,
    admin: true,
  });
  const db = drizzle(env.DB);
  const rows = await db
    .select({ role: member.role, userId: member.userId })
    .from(member)
    .where(
      and(
        eq(member.id, params.memberId),
        eq(member.organizationId, params.organizationId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw appError(404, "member_not_found", "member not found");
  if (rows[0].role === "owner") {
    throw appError(
      400,
      "cannot_change_owner_role",
      "transfer ownership to change the owner role",
    );
  }
  const [updated] = await db.batch([db
    .update(member)
    .set({ role: params.role })
    .where(
      and(
        eq(member.id, params.memberId),
        eq(member.organizationId, params.organizationId),
        ne(member.role, "owner"),
        administersOrganization(params.organizationId, params.actorUserId),
      ),
    )
    .returning({ id: member.id }),
    revokeUnauthorizedOrganizationEnrollments(db, { organizationId: params.organizationId, userId: rows[0].userId }),
  ]);
  if (updated.length !== 1) {
    throw appError(
      409,
      "organization_membership_changed",
      "organization membership or administrative authority changed while the role was being updated",
    );
  }
}

export async function removeOrganizationMember(params: {
  organizationId: string;
  memberId: string;
  actorUserId: string;
}): Promise<void> {
  await requireOrganizationRole({
    organizationId: params.organizationId,
    userId: params.actorUserId,
    admin: true,
  });
  const db = drizzle(env.DB);
  const rows = await db
    .select({ role: member.role, userId: member.userId })
    .from(member)
    .where(
      and(
        eq(member.id, params.memberId),
        eq(member.organizationId, params.organizationId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw appError(404, "member_not_found", "member not found");
  if (rows[0].role === "owner") {
    throw appError(
      400,
      "cannot_remove_owner",
      "the organization owner cannot be removed",
    );
  }
  const removedUserId = rows[0].userId;
  // A removal sticks, so removing yourself would lock you out of an
  // organization you can leave and rejoin instead.
  if (removedUserId === params.actorUserId) {
    throw appError(
      400,
      "cannot_remove_self",
      "leave the organization instead of removing yourself",
    );
  }
  const removable = and(
    eq(member.id, params.memberId),
    eq(member.organizationId, params.organizationId),
    ne(member.role, "owner"),
    ne(member.userId, params.actorUserId),
    administersOrganization(params.organizationId, params.actorUserId),
  );
  const removedAt = Date.now();
  // Holds once this batch has written its removal row, and only then.
  const removalWritten = sql`EXISTS (SELECT 1 FROM organization_member_removals AS written
    WHERE written.organization_id = ${params.organizationId}
      AND written.user_id = ${removedUserId}
      AND written.removed_by = ${params.actorUserId}
      AND written.removed_at = ${removedAt})`;
  const [, removed, runs] = await db.batch([
    // Removal sticks: the organization's identity provider can neither sign
    // the person in nor add them back until an admin restores them. The row
    // uses the delete's own predicate, so both apply or neither does.
    db
      .insert(organizationMemberRemovals)
      .select(
        db
          .select({
            organizationId: member.organizationId,
            userId: member.userId,
            removedBy: sql<string>`${params.actorUserId}`.as("removed_by"),
            removedAt: sql<number>`${removedAt}`.as("removed_at"),
          })
          .from(member)
          .where(removable),
      )
      .onConflictDoUpdate({
        target: [
          organizationMemberRemovals.organizationId,
          organizationMemberRemovals.userId,
        ],
        set: { removedBy: params.actorUserId, removedAt },
      }),
    db.delete(member).where(removable).returning({ id: member.id }),
    requestRemovedMemberRunShutdown(db, { organizationId: params.organizationId, userId: removedUserId }),
    revokeUnauthorizedOrganizationEnrollments(db, { organizationId: params.organizationId, userId: removedUserId }),
    deleteRemovedMemberImagePreparation(db, { organizationId: params.organizationId, userId: removedUserId }),
    // Their logins at the organization's providers stay removed even once
    // this account no longer holds them.
    db
      .insert(organizationMemberRemovedLogins)
      .select(
        db
          .select({
            organizationId: sql<string>`${params.organizationId}`.as("organization_id"),
            userId: account.userId,
            issuer: ssoProvider.issuer,
            subject: account.accountId,
          })
          .from(account)
          .innerJoin(ssoProvider, eq(ssoProvider.providerId, account.providerId))
          .where(
            and(
              eq(account.userId, removedUserId),
              eq(ssoProvider.organizationId, params.organizationId),
              removalWritten,
            ),
          ),
      )
      .onConflictDoNothing(),
    // With the removal written, someone with an identity at its provider is
    // signed out in the same transaction: a session doesn't record which
    // identity opened it, so any of theirs may be one the provider opened.
    // Platform admins sign in with GitHub only, so none of theirs is.
    ...signOutQueries(
      db,
      (userColumn) => sql`${userColumn} = ${removedUserId}
        AND ${removalWritten}
        AND NOT EXISTS (SELECT 1 FROM ${user} AS removed_user
          WHERE removed_user.id = ${removedUserId}
            AND ${sql.raw(activeAdminSql("removed_user"))})
        AND EXISTS (SELECT 1 FROM account AS organization_identity
          JOIN sso_provider AS identity_provider
            ON identity_provider.provider_id = organization_identity.provider_id
          WHERE organization_identity.user_id = ${removedUserId}
            AND identity_provider.organization_id = ${params.organizationId})`,
    ),
  ]);
  if (removed.length !== 1) {
    throw appError(409, "organization_membership_changed", "organization membership changed while it was being removed");
  }
  await finishRemovedMemberRunShutdown(removedUserId, runs);
}

/** Lifts a removal while `guard` holds; whether it lifted one. */
async function liftRemoval(
  params: { organizationId: string; userId: string },
  guard: SQL,
): Promise<boolean> {
  const restored = await drizzle(env.DB)
    .delete(organizationMemberRemovals)
    .where(
      and(
        eq(organizationMemberRemovals.organizationId, params.organizationId),
        eq(organizationMemberRemovals.userId, params.userId),
        guard,
      ),
    )
    .returning({ userId: organizationMemberRemovals.userId });
  return restored.length === 1;
}

function removedMemberNotFound() {
  return appError(404, "removed_member_not_found", "removed member not found");
}

/** Lets a removed person sign in through the organization's provider again. */
export async function restoreOrganizationMember(params: {
  organizationId: string;
  userId: string;
  actorUserId: string;
}): Promise<void> {
  if (
    await liftRemoval(
      params,
      administersOrganization(params.organizationId, params.actorUserId),
    )
  ) {
    return;
  }
  // Refused: name whether the actor isn't an admin.
  await requireOrganizationRole({
    organizationId: params.organizationId,
    userId: params.actorUserId,
    admin: true,
  });
  throw removedMemberNotFound();
}

/**
 * Lifts a removal for a platform admin, who needs no membership. Nobody else
 * can restore someone an organization's admins removed.
 */
export async function restoreRemovedMemberAsPlatformAdmin(params: {
  organizationId: string;
  userId: string;
  actorUserId: string;
}): Promise<void> {
  if (await liftRemoval(params, activeAdministrator(params.actorUserId))) {
    return;
  }
  if (!(await isActiveAdmin(params.actorUserId, env.DB))) {
    throw adminRequiredError();
  }
  throw removedMemberNotFound();
}

/** The people an organization's admins removed, most recent first. */
export async function listOrganizationRemovedMembers(
  organizationId: string,
): Promise<OrganizationRemovedMemberRecord[]> {
  return drizzle(env.DB)
    .select({
      userId: organizationMemberRemovals.userId,
      name: user.name,
      email: user.email,
      githubUsername: user.username,
      removedAt: organizationMemberRemovals.removedAt,
    })
    .from(organizationMemberRemovals)
    .innerJoin(user, eq(organizationMemberRemovals.userId, user.id))
    .where(eq(organizationMemberRemovals.organizationId, organizationId))
    .orderBy(desc(organizationMemberRemovals.removedAt));
}

function revokeUnauthorizedOrganizationEnrollments(
  db: ReturnType<typeof drizzle>,
  params: { organizationId: string; userId: string },
) {
  return db.update(hostEnrollments).set({ revokedAt: Date.now() }).where(and(
    eq(hostEnrollments.organizationId, params.organizationId),
    eq(hostEnrollments.userId, params.userId),
    eq(hostEnrollments.scope, "organization"),
    sql`${hostEnrollments.claimedAt} IS NULL AND ${hostEnrollments.revokedAt} IS NULL`,
    sql`NOT EXISTS (SELECT 1 FROM member remaining WHERE remaining.organization_id = ${params.organizationId}
      AND remaining.user_id = ${params.userId} AND remaining.role IN ('owner', 'admin'))`,
  ));
}

function deleteRemovedMemberImagePreparation(
  db: ReturnType<typeof drizzle>,
  params: { organizationId: string; userId: string },
) {
  return db.delete(personalImagePreparations).where(and(
    eq(personalImagePreparations.userId, params.userId),
    sql`json_extract(${personalImagePreparations.accessJson}, '$.organizationId') = ${params.organizationId}`,
    sql`NOT EXISTS (SELECT 1 FROM member remaining WHERE remaining.organization_id = ${params.organizationId}
      AND remaining.user_id = ${params.userId})`,
  ));
}

function requestRemovedMemberRunShutdown(
  db: ReturnType<typeof drizzle>,
  params: { organizationId: string; userId: string },
) {
  const now = Date.now();
  // This durable intent lands with membership deletion. A rejoin cannot turn
  // the old run back into an authorized workload. DO content checks also read
  // delete_requested_at on reconnect, dispatch, and alarm retries.
  return db.update(scenarioRuns).set({
    deleteRequestedAt: sql`coalesce(${scenarioRuns.deleteRequestedAt}, ${now})`,
    updatedAt: now,
  }).where(and(
    eq(scenarioRuns.organizationId, params.organizationId),
    eq(scenarioRuns.userId, params.userId),
    notInArray(scenarioRuns.state, ["completed", "failed"]),
    sql`NOT EXISTS (SELECT 1 FROM member remaining WHERE remaining.organization_id = ${params.organizationId}
      AND remaining.user_id = ${params.userId})`,
  )).returning({ runId: scenarioRuns.runId, hostId: scenarioRuns.hostId });
}

async function finishRemovedMemberRunShutdown(
  userId: string,
  runs: Array<{ runId: string; hostId: string }>,
): Promise<void> {
  if (!runs.length) return;
  const { destroyScenarioRunForUser } = await import("@/lib/scenario-runs/lifecycle");
  const { wakeHostRuntime } = await import("@/lib/host-runtime-wake");
  const cleanup = await Promise.allSettled(runs.map(run => destroyScenarioRunForUser({ runId: run.runId, userId })));
  // A desired-state or route failure must not prevent the independent DO
  // authorization check from running for the other affected hosts.
  const wakes = await Promise.allSettled([...new Set(runs.map(run => run.hostId))].map(hostId => wakeHostRuntime(hostId)));
  if ([...cleanup, ...wakes].some(result => result.status === "rejected")) {
    console.warn(JSON.stringify({ event: "organization_run_cleanup_pending", userId, runIds: runs.map(run => run.runId) }));
    throw appError(503, "organization_run_cleanup_pending", "Membership was removed. Run shutdown is pending.");
  }
}

async function organizationHasOwnedResources(
  organizationId: string,
): Promise<boolean> {
  const db = drizzle(env.DB);
  const results = await db.batch([
    db.select({ id: agentHosts.id }).from(agentHosts)
      .where(eq(agentHosts.organizationId, organizationId)).limit(1),
    db
      .select({ id: ssoProvider.id })
      .from(ssoProvider)
      .where(eq(ssoProvider.organizationId, organizationId))
      .limit(1),
    db
      .select({ id: vmScenarios.scenarioId })
      .from(vmScenarios)
      .where(eq(vmScenarios.organizationId, organizationId))
      .limit(1),
    db
      .select({ id: imageBuildBundles.rev })
      .from(imageBuildBundles)
      .where(eq(imageBuildBundles.organizationId, organizationId))
      .limit(1),
    db
      .select({ id: imageBuilds.id })
      .from(imageBuilds)
      .where(eq(imageBuilds.organizationId, organizationId))
      .limit(1),
    db
      .select({ id: scenarioRuns.runId })
      .from(scenarioRuns)
      .where(eq(scenarioRuns.organizationId, organizationId))
      .limit(1),
  ]);
  return results.some((rows) => rows.length > 0);
}

function validateOrganizationName(raw: string): string {
  const name = raw.trim().slice(0, ORGANIZATION_NAME_MAX);
  if (name.length < 2) {
    throw appError(
      400,
      "invalid_organization_name",
      "organization name must be at least 2 characters",
    );
  }
  return name;
}

function slugifyOrganizationName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
