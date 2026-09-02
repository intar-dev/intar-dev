import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { accessAllowlist, member, user } from "@/db/schema";
import { appError } from "@/lib/app-error";
import { createAppId } from "@/lib/id";

const ID_MAX_LENGTH = 255;

interface PlatformUserDeletionInput {
  d1: D1Database;
  targetUserId: string;
  actorUserId: string;
  now?: number;
}

export async function listPlatformUsers(d1: D1Database) {
  return drizzle(d1)
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      username: user.username,
      role: user.role,
      banned: user.banned,
      createdAt: user.createdAt,
    })
    .from(user)
    .where(isNull(user.deletedAt))
    .orderBy(desc(user.createdAt))
    .limit(200);
}

/**
 * Checks the irreversible account-deletion boundary before operational cleanup
 * starts. The same predicates are rechecked inside the final D1 batch.
 */
export async function assertPlatformUserDeletionAllowed(
  input: PlatformUserDeletionInput,
): Promise<void> {
  const targetUserId = requiredId(input.targetUserId, "target user");
  const actorUserId = requiredId(input.actorUserId, "actor user");
  if (targetUserId === actorUserId) {
    throw appError(
      409,
      "platform_user_self_delete_forbidden",
      "Use another administrator to delete this user",
    );
  }

  const db = drizzle(input.d1);
  const [target, actor, targetIsAdmin, otherAdmin, soleOwnedOrganization] =
    await Promise.all([
      db
        .select({ id: user.id, deletedAt: user.deletedAt })
        .from(user)
        .where(eq(user.id, targetUserId))
        .limit(1),
      db
        .select({ id: user.id })
        .from(user)
        .innerJoin(
          accessAllowlist,
          and(
            eq(accessAllowlist.userId, user.id),
            eq(accessAllowlist.state, "active"),
          ),
        )
        .where(
          and(
            eq(user.id, actorUserId),
            sql`${user.deletedAt} is null`,
            sql`coalesce(${user.banned}, 0) = 0`,
            platformAdminRole(user.role),
          ),
        )
        .limit(1),
      db
        .select({ id: user.id })
        .from(user)
        .innerJoin(
          accessAllowlist,
          and(
            eq(accessAllowlist.userId, user.id),
            eq(accessAllowlist.state, "active"),
          ),
        )
        .where(
          and(
            eq(user.id, targetUserId),
            sql`${user.deletedAt} is null`,
            sql`coalesce(${user.banned}, 0) = 0`,
            platformAdminRole(user.role),
          ),
        )
        .limit(1),
      db
        .select({ id: user.id })
        .from(user)
        .innerJoin(
          accessAllowlist,
          and(
            eq(accessAllowlist.userId, user.id),
            eq(accessAllowlist.state, "active"),
          ),
        )
        .where(
          and(
            sql`${user.id} <> ${targetUserId}`,
            sql`${user.deletedAt} is null`,
            sql`coalesce(${user.banned}, 0) = 0`,
            platformAdminRole(user.role),
          ),
        )
        .limit(1),
      db
        .select({ organizationId: member.organizationId })
        .from(member)
        .where(
          and(
            eq(member.userId, targetUserId),
            organizationOwnerRole(member.role),
            sql`not exists (
              select 1
              from member as other_owner
              where other_owner.organization_id = ${member.organizationId}
                and other_owner.user_id <> ${targetUserId}
                and instr(
                  ',' || replace(lower(coalesce(other_owner.role, '')), ' ', '') || ',',
                  ',owner,'
                ) > 0
            )`,
          ),
        )
        .limit(1),
    ]);

  if (!target[0] || target[0].deletedAt) {
    throw appError(404, "user_not_found", "User not found");
  }
  if (!actor[0]) {
    throw appError(
      403,
      "admin_required",
      "Active beta administrator access is required",
    );
  }
  if (targetIsAdmin[0] && !otherAdmin[0]) {
    throw appError(
      409,
      "last_active_admin",
      "The last active platform administrator cannot be deleted",
    );
  }
  if (soleOwnedOrganization[0]) {
    throw appError(
      409,
      "platform_user_owns_organization",
      "Transfer or delete this user's organization before deleting the user",
    );
  }
}

/**
 * Irreversibly removes the user's authentication and authorization records.
 * The user row becomes an anonymous tombstone so retained runtime,
 * and security history keeps valid foreign keys without retaining profile data.
 */
export async function finalizePlatformUserDeletion(
  input: PlatformUserDeletionInput,
): Promise<void> {
  const targetUserId = requiredId(input.targetUserId, "target user");
  const actorUserId = requiredId(input.actorUserId, "actor user");
  const now = validNow(input.now);
  await assertPlatformUserDeletionAllowed({
    ...input,
    targetUserId,
    actorUserId,
    now,
  });

  const eventId = createAppId();
  const deletedEmail = `deleted-${createAppId()}@deleted.invalid`;
  const eventGuard = `exists (
    select 1 from access_events
    where id = ?2 and event_type = 'user.deleted'
  )`;

  const statements = [
    input.d1
      .prepare(
        `INSERT INTO access_events (
           id, event_type, subject_user_id, github_account_id,
           actor_user_id, reason, created_at
         )
         SELECT ?1, 'user.deleted', target.id, access.github_account_id,
                ?3, 'admin_deleted', ?4
         FROM user AS target
         LEFT JOIN access_allowlist AS access ON access.user_id = target.id
         WHERE target.id = ?2
           AND target.deleted_at IS NULL
           AND ?2 <> ?3
           AND EXISTS (
             SELECT 1
             FROM access_allowlist AS actor_access
             INNER JOIN user AS actor_identity
               ON actor_identity.id = actor_access.user_id
             WHERE actor_access.user_id = ?3
               AND actor_access.state = 'active'
               AND actor_identity.deleted_at IS NULL
               AND coalesce(actor_identity.banned, 0) = 0
               AND instr(
                 ',' || replace(lower(coalesce(actor_identity.role, '')), ' ', '') || ',',
                 ',admin,'
               ) > 0
           )
           AND (
             NOT EXISTS (
               SELECT 1
               FROM access_allowlist AS target_access
               INNER JOIN user AS target_identity
                 ON target_identity.id = target_access.user_id
               WHERE target_access.user_id = ?2
                 AND target_access.state = 'active'
                 AND target_identity.deleted_at IS NULL
                 AND coalesce(target_identity.banned, 0) = 0
                 AND instr(
                   ',' || replace(lower(coalesce(target_identity.role, '')), ' ', '') || ',',
                   ',admin,'
                 ) > 0
             )
             OR EXISTS (
               SELECT 1
               FROM access_allowlist AS other_access
               INNER JOIN user AS other_identity
                 ON other_identity.id = other_access.user_id
               WHERE other_access.state = 'active'
                 AND other_access.user_id <> ?2
                 AND other_identity.deleted_at IS NULL
                 AND coalesce(other_identity.banned, 0) = 0
                 AND instr(
                   ',' || replace(lower(coalesce(other_identity.role, '')), ' ', '') || ',',
                   ',admin,'
                 ) > 0
             )
           )
           AND NOT EXISTS (
             SELECT 1
             FROM member AS target_owner
             WHERE target_owner.user_id = ?2
               AND instr(
                 ',' || replace(lower(coalesce(target_owner.role, '')), ' ', '') || ',',
                 ',owner,'
               ) > 0
               AND NOT EXISTS (
                 SELECT 1
                 FROM member AS other_owner
                 WHERE other_owner.organization_id = target_owner.organization_id
                   AND other_owner.user_id <> ?2
                   AND instr(
                     ',' || replace(lower(coalesce(other_owner.role, '')), ' ', '') || ',',
                     ',owner,'
                   ) > 0
               )
           )
           AND (
             access.user_id IS NULL
             OR (
               access.state = 'blocked'
               AND access.revocation_cleanup_completed_at IS NOT NULL
             )
           )`,
      )
      .bind(eventId, targetUserId, actorUserId, now),
    guardedDelete(input.d1, "access_allowlist", "user_id = ?1", eventGuard).bind(
      targetUserId,
      eventId,
    ),
    guardedDelete(input.d1, "oauth_access_token", "user_id = ?1", eventGuard).bind(
      targetUserId,
      eventId,
    ),
    guardedDelete(input.d1, "oauth_refresh_token", "user_id = ?1", eventGuard).bind(
      targetUserId,
      eventId,
    ),
    guardedDelete(input.d1, "oauth_consent", "user_id = ?1", eventGuard).bind(
      targetUserId,
      eventId,
    ),
    guardedDelete(input.d1, "oauth_client", "user_id = ?1", eventGuard).bind(
      targetUserId,
      eventId,
    ),
    guardedDelete(input.d1, "active_runtime_slots", "user_id = ?1", eventGuard).bind(
      targetUserId,
      eventId,
    ),
    guardedDelete(input.d1, "session", "user_id = ?1", eventGuard).bind(
      targetUserId,
      eventId,
    ),
    guardedDelete(input.d1, "account", "user_id = ?1", eventGuard).bind(
      targetUserId,
      eventId,
    ),
    guardedDelete(input.d1, "user_ssh_keys", "user_id = ?1", eventGuard).bind(
      targetUserId,
      eventId,
    ),
    guardedDelete(input.d1, "member", "user_id = ?1", eventGuard).bind(
      targetUserId,
      eventId,
    ),
    input.d1
      .prepare(
        `DELETE FROM invitation
         WHERE ${eventGuard}
           AND (
             inviter_id = ?1
             OR lower(email) = lower((SELECT email FROM user WHERE id = ?1))
           )`,
      )
      .bind(targetUserId, eventId),
    input.d1
      .prepare(
        `DELETE FROM verification
         WHERE ${eventGuard}
           AND (
             identifier = ?1
             OR identifier = (SELECT email FROM user WHERE id = ?1)
             OR (
               json_valid(value)
               AND json_extract(value, '$.userId') = ?1
             )
           )`,
      )
      .bind(targetUserId, eventId),
    input.d1
      .prepare(
        `UPDATE user
         SET name = 'Deleted user',
             email = ?3,
             image = NULL,
             username = NULL,
             display_username = NULL,
             role = NULL,
             banned = 1,
             ban_reason = 'Deleted by administrator',
             ban_expires = NULL,
             deleted_at = ?4,
             updated_at = ?4
         WHERE id = ?1 AND ${eventGuard}`,
      )
      .bind(targetUserId, eventId, deletedEmail, now),
    input.d1
      .prepare(
        `SELECT id, deleted_at AS deletedAt
         FROM user
         WHERE id = ?1 AND deleted_at = ?3 AND ${eventGuard}`,
      )
      .bind(targetUserId, eventId, now),
  ];

  const results = await input.d1.batch<{
    id?: unknown;
    deletedAt?: unknown;
  }>(statements);
  const verified = results.at(-1)?.results[0];
  if (verified?.id === targetUserId && verified.deletedAt === now) return;
  await throwPlatformUserDeletionFailure({
    d1: input.d1,
    targetUserId,
    actorUserId,
  });
}

function guardedDelete(
  d1: D1Database,
  table: string,
  predicate: string,
  eventGuard: string,
): D1PreparedStatement {
  return d1.prepare(`DELETE FROM ${table} WHERE ${predicate} AND ${eventGuard}`);
}

async function throwPlatformUserDeletionFailure(
  input: Omit<PlatformUserDeletionInput, "now">,
): Promise<never> {
  await assertPlatformUserDeletionAllowed(input);
  const access = await drizzle(input.d1)
    .select({
      state: accessAllowlist.state,
      cleanupCompletedAt: accessAllowlist.revocationCleanupCompletedAt,
    })
    .from(accessAllowlist)
    .where(eq(accessAllowlist.userId, input.targetUserId))
    .limit(1);
  if (access[0]?.state === "active") {
    throw appError(
      409,
      "platform_user_access_active",
      "Revoke beta access before deleting this user",
    );
  }
  if (access[0] && access[0].cleanupCompletedAt == null) {
    throw appError(
      409,
      "platform_user_cleanup_incomplete",
      "User cleanup must finish before deletion",
    );
  }
  throw appError(
    409,
    "platform_user_delete_conflict",
    "The user changed during deletion; refresh and try again",
  );
}

function platformAdminRole(column: typeof user.role) {
  return sql`instr(
    ',' || replace(lower(coalesce(${column}, '')), ' ', '') || ',',
    ',admin,'
  ) > 0`;
}

function organizationOwnerRole(column: typeof member.role) {
  return sql`instr(
    ',' || replace(lower(coalesce(${column}, '')), ' ', '') || ',',
    ',owner,'
  ) > 0`;
}

function requiredId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > ID_MAX_LENGTH) {
    throw appError(400, "invalid_user_id", `${label} id is invalid`);
  }
  return normalized;
}

function validNow(value: number | undefined): number {
  const now = value ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw appError(500, "clock_invalid", "The server clock is invalid");
  }
  return now;
}
