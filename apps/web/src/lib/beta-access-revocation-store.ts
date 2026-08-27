import { and, eq, isNull, notExists, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  accessAllowlist,
  accessEvents,
  type AccessEventType,
} from "@/db/schema/application";
import { user } from "@/db/schema/core";
import { appError } from "@/lib/app-error";
import { createAppId } from "@/lib/id";

export type BetaRevocationCleanupClaim =
  | {
      status: "acquired";
      cleanupAttemptId: string;
      startedAt: number;
    }
  | {
      status: "completed";
      cleanupAttemptId: string;
      startedAt: number;
      completedAt: number;
    };

export async function revokeBetaUser(params: {
  d1: D1Database;
  userId: string;
  actorUserId: string;
  reason: string;
  now?: number;
}): Promise<{ revocationId: string }> {
  const db = drizzle(params.d1);
  const now = validTimestamp(params.now ?? Date.now());
  const userId = validId(params.userId, "user");
  const actorUserId = validId(params.actorUserId, "actor");
  const reason = validReason(params.reason);
  const revocationId = createAppId();
  const blockedEventId = createAppId();
  const [updated] = await db.batch([
    db
      .update(accessAllowlist)
      .set({
        state: "blocked",
        revocationId,
        revokedBy: actorUserId,
        revocationReason: reason,
        revokedAt: now,
        revocationCleanupAttemptId: null,
        revocationCleanupStartedAt: null,
        revocationCleanupCompletedAt: null,
      })
      .where(
        and(
          eq(accessAllowlist.userId, userId),
          eq(accessAllowlist.state, "active"),
          activeAdministratorPredicate(actorUserId),
          lastAdministratorSafePredicate(userId),
        ),
      )
      .returning({ userId: accessAllowlist.userId }),
    db.insert(accessEvents).select(
      db
        .select({
          id: sql<string>`${blockedEventId}`.as("id"),
          eventType: sql<AccessEventType>`'access.blocked'`.as("event_type"),
          inviteId: accessAllowlist.sourceInviteId,
          subjectUserId: accessAllowlist.userId,
          githubAccountId: accessAllowlist.githubAccountId,
          actorUserId: accessAllowlist.revokedBy,
          revocationId: accessAllowlist.revocationId,
          cleanupAttemptId: sql<string | null>`null`.as("cleanup_attempt_id"),
          runId: sql<string | null>`null`.as("run_id"),
          reason: accessAllowlist.revocationReason,
          createdAt: accessAllowlist.revokedAt,
        })
        .from(accessAllowlist)
        .where(
          and(
            eq(accessAllowlist.userId, userId),
            eq(accessAllowlist.state, "blocked"),
            eq(accessAllowlist.revocationId, revocationId),
            eq(accessAllowlist.revokedBy, actorUserId),
            eq(accessAllowlist.revocationReason, reason),
            eq(accessAllowlist.revokedAt, now),
          ),
        ),
    ),
  ]);
  if (updated[0]?.userId === userId) return { revocationId };
  if (!(await isActiveAdministrator(params.d1, actorUserId))) {
    throw administratorRequired();
  }
  if (
    (await isActiveAdministrator(params.d1, userId)) &&
    !(await hasOtherActiveAdministrator(params.d1, userId))
  ) {
    throw appError(
      409,
      "last_beta_admin",
      "The last active beta administrator cannot be revoked",
    );
  }
  throw appError(409, "beta_user_not_active", "Beta access is not active");
}

export async function acquireBetaRevocationCleanup(params: {
  d1: D1Database;
  userId: string;
  revocationId: string;
  now?: number;
}): Promise<BetaRevocationCleanupClaim> {
  const db = drizzle(params.d1);
  const now = validTimestamp(params.now ?? Date.now());
  const userId = validId(params.userId, "user");
  const revocationId = validId(params.revocationId, "revocation");
  const cleanupAttemptId = createAppId();
  const updated = await db
    .update(accessAllowlist)
    .set({
      revocationCleanupAttemptId: cleanupAttemptId,
      revocationCleanupStartedAt: now,
    })
    .where(
      and(
        eq(accessAllowlist.userId, userId),
        eq(accessAllowlist.state, "blocked"),
        eq(accessAllowlist.revocationId, revocationId),
        isNull(accessAllowlist.revocationCleanupAttemptId),
        isNull(accessAllowlist.revocationCleanupStartedAt),
        isNull(accessAllowlist.revocationCleanupCompletedAt),
      ),
    )
    .returning({
      cleanupAttemptId: accessAllowlist.revocationCleanupAttemptId,
      startedAt: accessAllowlist.revocationCleanupStartedAt,
    });
  if (
    updated[0]?.cleanupAttemptId === cleanupAttemptId &&
    updated[0].startedAt === now
  ) {
    return { status: "acquired", cleanupAttemptId, startedAt: now };
  }

  const current = await db
    .select({
      revocationId: accessAllowlist.revocationId,
      cleanupAttemptId: accessAllowlist.revocationCleanupAttemptId,
      startedAt: accessAllowlist.revocationCleanupStartedAt,
      completedAt: accessAllowlist.revocationCleanupCompletedAt,
    })
    .from(accessAllowlist)
    .where(
      and(
        eq(accessAllowlist.userId, userId),
        eq(accessAllowlist.state, "blocked"),
      ),
    )
    .limit(1);
  const row = current[0];
  if (
    row?.revocationId === revocationId &&
    row.cleanupAttemptId &&
    row.startedAt != null &&
    row.completedAt != null
  ) {
    return {
      status: "completed",
      cleanupAttemptId: row.cleanupAttemptId,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
    };
  }
  if (row?.revocationId === revocationId && row.cleanupAttemptId) {
    throw appError(
      409,
      "beta_revocation_cleanup_in_progress",
      "Revocation cleanup is already running",
    );
  }
  throw staleRevocation();
}

export async function completeBetaRevocationCleanup(params: {
  d1: D1Database;
  userId: string;
  revocationId: string;
  cleanupAttemptId: string;
  now?: number;
}): Promise<void> {
  const db = drizzle(params.d1);
  const now = validTimestamp(params.now ?? Date.now());
  const userId = validId(params.userId, "user");
  const revocationId = validId(params.revocationId, "revocation");
  const cleanupAttemptId = validId(params.cleanupAttemptId, "cleanup attempt");
  const completedEventId = createAppId();
  const [updated] = await db.batch([
    db
      .update(accessAllowlist)
      .set({ revocationCleanupCompletedAt: now })
      .where(
        and(
          eq(accessAllowlist.userId, userId),
          eq(accessAllowlist.state, "blocked"),
          eq(accessAllowlist.revocationId, revocationId),
          eq(accessAllowlist.revocationCleanupAttemptId, cleanupAttemptId),
          isNull(accessAllowlist.revocationCleanupCompletedAt),
        ),
      )
      .returning({ userId: accessAllowlist.userId }),
    db.insert(accessEvents).select(
      db
        .select({
          id: sql<string>`${completedEventId}`.as("id"),
          eventType:
            sql<AccessEventType>`'access.revocation_cleanup_completed'`.as(
              "event_type",
            ),
          inviteId: accessAllowlist.sourceInviteId,
          subjectUserId: accessAllowlist.userId,
          githubAccountId: accessAllowlist.githubAccountId,
          actorUserId: sql<string | null>`null`.as("actor_user_id"),
          revocationId: accessAllowlist.revocationId,
          cleanupAttemptId: accessAllowlist.revocationCleanupAttemptId,
          runId: sql<string | null>`null`.as("run_id"),
          reason: sql<string>`'cleanup_completed'`.as("reason"),
          createdAt: accessAllowlist.revocationCleanupCompletedAt,
        })
        .from(accessAllowlist)
        .where(
          and(
            eq(accessAllowlist.userId, userId),
            eq(accessAllowlist.state, "blocked"),
            eq(accessAllowlist.revocationId, revocationId),
            eq(accessAllowlist.revocationCleanupAttemptId, cleanupAttemptId),
            eq(accessAllowlist.revocationCleanupCompletedAt, now),
            notExists(
              db
                .select({ id: accessEvents.id })
                .from(accessEvents)
                .where(
                  and(
                    eq(
                      accessEvents.eventType,
                      "access.revocation_cleanup_completed",
                    ),
                    eq(accessEvents.subjectUserId, userId),
                    eq(accessEvents.revocationId, revocationId),
                    eq(accessEvents.cleanupAttemptId, cleanupAttemptId),
                  ),
                ),
            ),
          ),
        ),
    ),
  ]);
  if (updated[0]?.userId === userId) return;

  const current = await db
    .select({
      cleanupAttemptId: accessAllowlist.revocationCleanupAttemptId,
      completedAt: accessAllowlist.revocationCleanupCompletedAt,
    })
    .from(accessAllowlist)
    .where(
      and(
        eq(accessAllowlist.userId, userId),
        eq(accessAllowlist.state, "blocked"),
        eq(accessAllowlist.revocationId, revocationId),
      ),
    )
    .limit(1);
  if (
    current[0]?.cleanupAttemptId === cleanupAttemptId &&
    current[0].completedAt != null
  ) {
    return;
  }
  throw staleRevocation();
}

export async function recordBetaRevocationCleanupFailure(params: {
  d1: D1Database;
  userId: string;
  revocationId: string;
  cleanupAttemptId: string;
  reason: string;
  actorUserId?: string | null;
  now?: number;
}): Promise<void> {
  const now = validTimestamp(params.now ?? Date.now());
  const userId = validId(params.userId, "user");
  const revocationId = validId(params.revocationId, "revocation");
  const cleanupAttemptId = validId(params.cleanupAttemptId, "cleanup attempt");
  const eventId = createAppId();
  const actorUserId = optionalId(params.actorUserId, "actor");
  const reason = validReason(params.reason);
  const db = drizzle(params.d1);
  const [recorded] = await db.batch([
    db
      .insert(accessEvents)
      .select(
        cleanupEventSelect({
          db,
          eventId,
          eventType: "access.revocation_cleanup_failed",
          userId,
          revocationId,
          cleanupAttemptId,
          actorUserId,
          reason,
          now,
        }),
      )
      .returning({ id: accessEvents.id }),
    db
      .update(accessAllowlist)
      .set({
        revocationCleanupAttemptId: null,
        revocationCleanupStartedAt: null,
      })
      .where(
        and(
          eq(accessAllowlist.userId, userId),
          eq(accessAllowlist.state, "blocked"),
          eq(accessAllowlist.revocationId, revocationId),
          eq(accessAllowlist.revocationCleanupAttemptId, cleanupAttemptId),
          sql`exists (
            select 1 from ${accessEvents}
            where ${accessEvents.id} = ${eventId}
              and ${accessEvents.eventType} = 'access.revocation_cleanup_failed'
          )`,
        ),
      ),
  ]);
  if (recorded[0]?.id === eventId) return;
  throw staleRevocation();
}

export async function recordBetaRevocationCleanupStall(params: {
  d1: D1Database;
  userId: string;
  revocationId: string;
  cleanupAttemptId: string;
  reason: string;
  actorUserId?: string | null;
  now?: number;
}): Promise<void> {
  const now = validTimestamp(params.now ?? Date.now());
  const userId = validId(params.userId, "user");
  const revocationId = validId(params.revocationId, "revocation");
  const cleanupAttemptId = validId(params.cleanupAttemptId, "cleanup attempt");
  const eventId = createAppId();
  const actorUserId = optionalId(params.actorUserId, "actor");
  const reason = validReason(params.reason);
  const db = drizzle(params.d1);
  const recorded = await db
    .insert(accessEvents)
    .select(
      cleanupEventSelect({
        db,
        eventId,
        eventType: "access.revocation_cleanup_stalled",
        userId,
        revocationId,
        cleanupAttemptId,
        actorUserId,
        reason,
        now,
      }),
    )
    .returning({ id: accessEvents.id });
  if (recorded[0]?.id === eventId) return;
  throw staleRevocation();
}

function cleanupEventSelect(params: {
  db: ReturnType<typeof drizzle>;
  eventId: string;
  eventType:
    | "access.revocation_cleanup_failed"
    | "access.revocation_cleanup_stalled";
  userId: string;
  revocationId: string;
  cleanupAttemptId: string;
  actorUserId: string | null;
  reason: string;
  now: number;
}) {
  return params.db
    .select({
      id: sql<string>`${params.eventId}`.as("id"),
      eventType: sql<AccessEventType>`${params.eventType}`.as("event_type"),
      inviteId: accessAllowlist.sourceInviteId,
      subjectUserId: accessAllowlist.userId,
      githubAccountId: accessAllowlist.githubAccountId,
      actorUserId: sql<string | null>`${params.actorUserId}`.as("actor_user_id"),
      revocationId: accessAllowlist.revocationId,
      cleanupAttemptId: sql<string>`${params.cleanupAttemptId}`.as(
        "cleanup_attempt_id",
      ),
      runId: sql<string | null>`null`.as("run_id"),
      reason: sql<string>`${params.reason}`.as("reason"),
      createdAt: sql<number>`${params.now}`.as("created_at"),
    })
    .from(accessAllowlist)
    .where(
      and(
        eq(accessAllowlist.userId, params.userId),
        eq(accessAllowlist.state, "blocked"),
        eq(accessAllowlist.revocationId, params.revocationId),
        eq(
          accessAllowlist.revocationCleanupAttemptId,
          params.cleanupAttemptId,
        ),
        sql`${accessAllowlist.revocationCleanupStartedAt} is not null`,
        isNull(accessAllowlist.revocationCleanupCompletedAt),
      ),
    );
}

function activeAdministratorPredicate(actorUserId: string) {
  return sql`exists (
    select 1
    from ${accessAllowlist}
    join ${user} on ${user.id} = ${accessAllowlist.userId}
    where ${accessAllowlist.userId} = ${actorUserId}
      and ${accessAllowlist.state} = 'active'
      and coalesce(${user.banned}, 0) = 0
      and instr(
        ',' || replace(lower(coalesce(${user.role}, '')), ' ', '') || ',',
        ',admin,'
      ) > 0
  )`;
}

function lastAdministratorSafePredicate(targetUserId: string) {
  return sql`(
    not exists (
      select 1 from "user" as target_identity
      where target_identity."id" = ${targetUserId}
        and coalesce(target_identity."banned", 0) = 0
        and instr(
          ',' || replace(lower(coalesce(target_identity."role", '')), ' ', '') || ',',
          ',admin,'
        ) > 0
    )
    or exists (
      select 1
      from "access_allowlist" as other_access
      join "user" as other_identity
        on other_identity."id" = other_access."user_id"
      where other_access."state" = 'active'
        and other_access."user_id" <> ${targetUserId}
        and coalesce(other_identity."banned", 0) = 0
        and instr(
          ',' || replace(lower(coalesce(other_identity."role", '')), ' ', '') || ',',
          ',admin,'
        ) > 0
    )
  )`;
}

async function isActiveAdministrator(
  d1: D1Database,
  userId: string,
): Promise<boolean> {
  const rows = await drizzle(d1)
    .select({ userId: accessAllowlist.userId })
    .from(accessAllowlist)
    .innerJoin(user, eq(user.id, accessAllowlist.userId))
    .where(
      and(
        eq(accessAllowlist.userId, userId),
        eq(accessAllowlist.state, "active"),
        sql`coalesce(${user.banned}, 0) = 0`,
        sql`instr(
          ',' || replace(lower(coalesce(${user.role}, '')), ' ', '') || ',',
          ',admin,'
        ) > 0`,
      ),
    )
    .limit(1);
  return rows[0]?.userId === userId;
}

async function hasOtherActiveAdministrator(
  d1: D1Database,
  userId: string,
): Promise<boolean> {
  const rows = await drizzle(d1)
    .select({ userId: accessAllowlist.userId })
    .from(accessAllowlist)
    .innerJoin(user, eq(user.id, accessAllowlist.userId))
    .where(
      and(
        eq(accessAllowlist.state, "active"),
        sql`${accessAllowlist.userId} <> ${userId}`,
        sql`coalesce(${user.banned}, 0) = 0`,
        sql`instr(
          ',' || replace(lower(coalesce(${user.role}, '')), ' ', '') || ',',
          ',admin,'
        ) > 0`,
      ),
    )
    .limit(1);
  return rows.length === 1;
}

function validId(value: string, kind: string): string {
  const id = value.trim();
  if (!id || id.length > 255) {
    throw appError(400, "invalid_beta_access_id", `Invalid ${kind} id`);
  }
  return id;
}

function optionalId(
  value: string | null | undefined,
  kind: string,
): string | null {
  return value == null ? null : validId(value, kind);
}

function validReason(value: string): string {
  const reason = value.trim();
  if (!/^[a-z0-9][a-z0-9._:-]{0,119}$/u.test(reason)) {
    throw appError(400, "invalid_access_reason", "Invalid audit reason code");
  }
  return reason;
}

function validTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw appError(500, "invalid_timestamp", "The server clock is invalid");
  }
  return value;
}

function administratorRequired() {
  return appError(
    403,
    "beta_admin_authority_required",
    "Platform beta administrator access is required",
  );
}

function staleRevocation() {
  return appError(
    409,
    "stale_beta_revocation",
    "The beta revocation is no longer current",
  );
}
