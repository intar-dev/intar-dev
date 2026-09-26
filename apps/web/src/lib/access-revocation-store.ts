import { and, eq, exists, inArray, isNull, lte, notExists, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  accessEvents,
  accessRevocations,
  type AccessEventType,
} from "@/db/schema/application";
import { account, user } from "@/db/schema/core";
import { agentBootstrapTokens, agentHosts } from "@/db/schema/platform";
import {
  activeAccountSql,
  activeAdminSql,
  firstOrganizationIdentitySql,
} from "@/lib/account-access";
import { accountCredentialSweepStatements } from "@/lib/account-sign-out";
import { appError } from "@/lib/app-error";
import { createAppId } from "@/lib/id";
import { retiredHostCredentialStatements } from "@/lib/personal-host-retirement";
import {
  activeAdministrator,
  adminRequiredError,
  isActiveAdmin,
  isLastActiveAdmin,
  lastActiveAdminError,
  lastAdministratorSafe,
} from "@/lib/platform-admin-authority";

// A revocation bans the account and advances its access generation in one
// write; its row is the audit record and the ledger for the cleanup that
// follows. An administrator can restore access once that cleanup finished: the
// restore sweeps whatever credentials raced in, lifts the ban, and deletes the
// row, so a row exists exactly while the account is revoked. The history stays
// in `access_events`.

/**
 * A cleanup attempt that neither finished nor recorded a failure within this
 * long is abandoned (a lost isolate, or a stall after external cleanup was
 * dispatched), so a new attempt may take it over. Every write of the old
 * attempt is fenced by its attempt id, and its late external effects only
 * target the runs, routes, and host credential generations it read.
 */
export const CLEANUP_LEASE_MS = 10 * 60 * 1000;

export type AccessRevocationCleanupClaim =
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

export async function revokeAccount(params: {
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
  const currentRevocation = exists(
    db.select({ userId: accessRevocations.userId }).from(accessRevocations).where(and(
      eq(accessRevocations.userId, userId),
      eq(accessRevocations.revocationId, revocationId),
    )),
  );
  const [inserted] = await db.batch([
    db
      .insert(accessRevocations)
      .select(
        db
          .select({
            userId: user.id,
            revocationId: sql<string>`${revocationId}`.as("revocation_id"),
            revokedBy: sql<string>`${actorUserId}`.as("revoked_by"),
            reason: sql<string>`${reason}`.as("reason"),
            revokedAt: sql<number>`${now}`.as("revoked_at"),
            cleanupAttemptId: sql<string | null>`null`.as("cleanup_attempt_id"),
            cleanupStartedAt: sql<number | null>`null`.as("cleanup_started_at"),
            cleanupCompletedAt: sql<number | null>`null`.as(
              "cleanup_completed_at",
            ),
          })
          .from(user)
          .where(
            and(
              eq(user.id, userId),
              isNull(user.deletedAt),
              notExists(
                db
                  .select({ userId: accessRevocations.userId })
                  .from(accessRevocations)
                  .where(eq(accessRevocations.userId, userId)),
              ),
              activeAdministrator(actorUserId),
              lastAdministratorSafe(userId),
            ),
          ),
      )
      .returning({ userId: accessRevocations.userId }),
    // `ban_expires` stays NULL: Better Auth lifts bans whose expiry has passed.
    db.update(user).set({
      banned: true,
      banReason: "access_revoked",
      banExpires: null,
      // Fails every bracketing check that started before this write, even
      // once access is restored (see account-access.ts).
      accessGeneration: sql`${user.accessGeneration} + 1`,
      updatedAt: new Date(now),
    }).where(and(eq(user.id, userId), currentRevocation)),
    // A report admitted before this transaction must fail its session/generation
    // check after it. Do not defer credential invalidation to network cleanup.
    db.update(agentHosts).set({
      disabled: true,
      scenarioEnabled: false,
      credentialGeneration: sql`${agentHosts.credentialGeneration} + 1`,
      connected: false,
      activeSessionId: null,
      disconnectedAt: now,
      updatedAt: now,
    }).where(and(
      eq(agentHosts.userId, userId),
      eq(agentHosts.scope, "personal"),
      currentRevocation,
    )),
    db.update(agentBootstrapTokens).set({ revokedAt: now }).where(and(
      isNull(agentBootstrapTokens.revokedAt),
      inArray(agentBootstrapTokens.hostId,
        db.select({ id: agentHosts.id }).from(agentHosts).where(and(
          eq(agentHosts.userId, userId), eq(agentHosts.scope, "personal"),
        )),
      ),
      currentRevocation,
    )),
    db.insert(accessEvents).select(
      db
        .select({
          id: sql<string>`${blockedEventId}`.as("id"),
          eventType: sql<AccessEventType>`'access.blocked'`.as("event_type"),
          inviteId: sql<string | null>`null`.as("invite_id"),
          subjectUserId: accessRevocations.userId,
          githubAccountId: revokedGithubAccountId(),
          ssoProviderId: revokedSsoIdentity("provider_id"),
          ssoAccountId: revokedSsoIdentity("account_id"),
          actorUserId: accessRevocations.revokedBy,
          revocationId: accessRevocations.revocationId,
          cleanupAttemptId: sql<string | null>`null`.as("cleanup_attempt_id"),
          runId: sql<string | null>`null`.as("run_id"),
          reason: accessRevocations.reason,
          createdAt: accessRevocations.revokedAt,
        })
        .from(accessRevocations)
        .where(
          and(
            eq(accessRevocations.userId, userId),
            eq(accessRevocations.revocationId, revocationId),
          ),
        ),
    ),
  ]);
  if (inserted[0]?.userId === userId) return { revocationId };
  throw await revocationFailure(params.d1, userId, actorUserId);
}

export async function acquireAccessRevocationCleanup(params: {
  d1: D1Database;
  userId: string;
  revocationId: string;
  now?: number;
}): Promise<AccessRevocationCleanupClaim> {
  const db = drizzle(params.d1);
  const now = validTimestamp(params.now ?? Date.now());
  const userId = validId(params.userId, "user");
  const revocationId = validId(params.revocationId, "revocation");
  const cleanupAttemptId = createAppId();
  const updated = await db
    .update(accessRevocations)
    .set({ cleanupAttemptId, cleanupStartedAt: now })
    .where(
      and(
        eq(accessRevocations.userId, userId),
        eq(accessRevocations.revocationId, revocationId),
        isNull(accessRevocations.cleanupCompletedAt),
        or(
          and(
            isNull(accessRevocations.cleanupAttemptId),
            isNull(accessRevocations.cleanupStartedAt),
          ),
          lte(accessRevocations.cleanupStartedAt, now - CLEANUP_LEASE_MS),
        ),
      ),
    )
    .returning({
      cleanupAttemptId: accessRevocations.cleanupAttemptId,
      startedAt: accessRevocations.cleanupStartedAt,
    });
  if (
    updated[0]?.cleanupAttemptId === cleanupAttemptId &&
    updated[0].startedAt === now
  ) {
    return { status: "acquired", cleanupAttemptId, startedAt: now };
  }

  const current = await db
    .select({
      revocationId: accessRevocations.revocationId,
      cleanupAttemptId: accessRevocations.cleanupAttemptId,
      startedAt: accessRevocations.cleanupStartedAt,
      completedAt: accessRevocations.cleanupCompletedAt,
    })
    .from(accessRevocations)
    .where(eq(accessRevocations.userId, userId))
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
      "access_revocation_cleanup_in_progress",
      "Revocation cleanup is already running",
    );
  }
  throw staleRevocation();
}

export async function completeAccessRevocationCleanup(params: {
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
      .update(accessRevocations)
      .set({ cleanupCompletedAt: now })
      .where(
        and(
          eq(accessRevocations.userId, userId),
          eq(accessRevocations.revocationId, revocationId),
          eq(accessRevocations.cleanupAttemptId, cleanupAttemptId),
          isNull(accessRevocations.cleanupCompletedAt),
        ),
      )
      .returning({ userId: accessRevocations.userId }),
    db.insert(accessEvents).select(
      db
        .select({
          id: sql<string>`${completedEventId}`.as("id"),
          eventType:
            sql<AccessEventType>`'access.revocation_cleanup_completed'`.as(
              "event_type",
            ),
          inviteId: sql<string | null>`null`.as("invite_id"),
          subjectUserId: accessRevocations.userId,
          githubAccountId: revokedGithubAccountId(),
          ssoProviderId: revokedSsoIdentity("provider_id"),
          ssoAccountId: revokedSsoIdentity("account_id"),
          actorUserId: sql<string | null>`null`.as("actor_user_id"),
          revocationId: accessRevocations.revocationId,
          cleanupAttemptId: accessRevocations.cleanupAttemptId,
          runId: sql<string | null>`null`.as("run_id"),
          reason: sql<string>`'cleanup_completed'`.as("reason"),
          createdAt: accessRevocations.cleanupCompletedAt,
        })
        .from(accessRevocations)
        .where(
          and(
            eq(accessRevocations.userId, userId),
            eq(accessRevocations.revocationId, revocationId),
            eq(accessRevocations.cleanupAttemptId, cleanupAttemptId),
            eq(accessRevocations.cleanupCompletedAt, now),
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
      cleanupAttemptId: accessRevocations.cleanupAttemptId,
      completedAt: accessRevocations.cleanupCompletedAt,
    })
    .from(accessRevocations)
    .where(
      and(
        eq(accessRevocations.userId, userId),
        eq(accessRevocations.revocationId, revocationId),
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

export async function recordAccessRevocationCleanupFailure(params: {
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
      .update(accessRevocations)
      .set({ cleanupAttemptId: null, cleanupStartedAt: null })
      .where(
        and(
          eq(accessRevocations.userId, userId),
          eq(accessRevocations.revocationId, revocationId),
          eq(accessRevocations.cleanupAttemptId, cleanupAttemptId),
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

export async function recordAccessRevocationCleanupStall(params: {
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

export type AccessRestoreOutcome = "restored" | "already_restored";

/**
 * Restores the access of an account whose revocation cleanup finished, as a
 * fresh start: it keeps its identities, history, and the organization it alone
 * owns, and loses everything else it held. One batch; the restore event guards
 * every later statement, so a refused restore writes nothing.
 */
export async function restoreAccount(params: {
  d1: D1Database;
  userId: string;
  actorUserId: string;
  revocationId: string;
  now?: number;
}): Promise<AccessRestoreOutcome> {
  const now = validTimestamp(params.now ?? Date.now());
  const userId = validId(params.userId, "user");
  const actorUserId = validId(params.actorUserId, "actor");
  const revocationId = validId(params.revocationId, "revocation");
  const eventId = createAppId();
  const d1 = params.d1;
  const bindings = [userId, eventId] as const;
  const restored = `EXISTS (SELECT 1 FROM access_events AS restore_event
    WHERE restore_event.id = ?2 AND restore_event.event_type = 'access.restored')`;
  const ownerRole = (column: string) =>
    `instr(',' || replace(lower(coalesce(${column}, '')), ' ', '') || ',', ',owner,') > 0`;

  const [recorded] = await d1.batch<{ id: string }>([
    d1
      .prepare(
        `INSERT INTO access_events (
           id, event_type, subject_user_id, github_account_id,
           sso_provider_id, sso_account_id,
           actor_user_id, revocation_id, reason, created_at
         )
         SELECT ?2, 'access.restored', revocation.user_id,
                (SELECT github.account_id FROM account AS github
                 WHERE github.user_id = revocation.user_id
                   AND github.provider_id = 'github'
                 LIMIT 1),
                ${firstOrganizationIdentitySql("revocation.user_id", "provider_id")},
                ${firstOrganizationIdentitySql("revocation.user_id", "account_id")},
                ?3, revocation.revocation_id, 'admin_restored', ?5
         FROM access_revocations AS revocation
         WHERE revocation.user_id = ?1
           AND revocation.revocation_id = ?4
           AND revocation.cleanup_completed_at IS NOT NULL
           AND EXISTS (SELECT 1 FROM user AS revoked_account
             WHERE revoked_account.id = ?1
               AND revoked_account.deleted_at IS NULL
               AND revoked_account.banned = 1
               AND revoked_account.ban_reason = 'access_revoked')
           AND EXISTS (SELECT 1 FROM user AS actor_identity
             WHERE actor_identity.id = ?3
               AND ${activeAdminSql("actor_identity")})
         RETURNING id`,
      )
      .bind(userId, eventId, actorUserId, revocationId, now),
    // Anything that raced in after the revocation cleanup.
    ...accountCredentialSweepStatements(d1, restored, bindings, now),
    d1
      .prepare(`DELETE FROM user_ssh_keys WHERE user_id = ?1 AND ${restored}`)
      .bind(...bindings),
    // Their apps, with every grant other people gave them (cascade).
    d1
      .prepare(`DELETE FROM oauth_client WHERE user_id = ?1 AND ${restored}`)
      .bind(...bindings),
    // Every membership except an organization they alone own, which would be
    // left without an owner. An organization's identity provider adds its
    // people back when they sign in through it.
    d1
      .prepare(
        `DELETE FROM member
         WHERE member.user_id = ?1 AND ${restored}
           AND NOT (${ownerRole("member.role")}
             AND NOT EXISTS (SELECT 1 FROM member AS other_owner
               WHERE other_owner.organization_id = member.organization_id
                 AND other_owner.user_id <> ?1
                 AND ${ownerRole("other_owner.role")}))`,
      )
      .bind(...bindings),
    // Revocation already disabled their servers and rotated the credentials;
    // retire them as a server removal does, so the owner starts on cloud.
    d1
      .prepare(
        `UPDATE agent_hosts SET disabled = 1, scenario_enabled = 0, connected = 0,
           active_session_id = NULL, disconnected_at = ?3, updated_at = ?3,
           credential_generation = credential_generation + CASE WHEN disabled = 0 THEN 1 ELSE 0 END,
           owner_removal_id = coalesce(owner_removal_id, ?2)
         WHERE user_id = ?1 AND scope = 'personal'
           AND owner_removal_completed_at IS NULL AND ${restored}`,
      )
      .bind(...bindings, now),
    ...retiredHostCredentialStatements(
      d1,
      `host_id IN (SELECT retired_host.id FROM agent_hosts AS retired_host
        WHERE retired_host.user_id = ?1 AND retired_host.scope = 'personal')
        AND ${restored}`,
      bindings,
      now,
    ),
    // The access generation stays where the revocation left it.
    d1
      .prepare(
        `UPDATE user SET banned = 0, ban_reason = NULL, ban_expires = NULL,
           role = 'user', metal_placement = 'platform', updated_at = ?3
         WHERE id = ?1 AND ${restored}`,
      )
      .bind(...bindings, now),
    d1
      .prepare(
        `DELETE FROM access_revocations
         WHERE user_id = ?1 AND revocation_id = ?3 AND ${restored}`,
      )
      .bind(...bindings, revocationId),
  ]);
  if (recorded?.results[0]?.id === eventId) return "restored";
  return restoreFailure(d1, { userId, actorUserId, revocationId });
}

// Classifies a restore that recorded nothing, most specific cause first. A
// retry of a restore whose response was lost reports the earlier success.
async function restoreFailure(
  d1: D1Database,
  params: { userId: string; actorUserId: string; revocationId: string },
): Promise<AccessRestoreOutcome> {
  if (!(await isActiveAdmin(params.actorUserId, d1))) throw adminRequiredError();
  const target = await d1
    .prepare(
      `SELECT target.deleted_at AS deletedAt,
              ${activeAccountSql("target")} AS active,
              revocation.revocation_id AS revocationId,
              revocation.cleanup_completed_at AS cleanupCompletedAt,
              EXISTS (SELECT 1 FROM access_events
                WHERE subject_user_id = ?1 AND revocation_id = ?2
                  AND event_type = 'access.restored') AS restored
       FROM user AS target
       LEFT JOIN access_revocations AS revocation ON revocation.user_id = target.id
       WHERE target.id = ?1`,
    )
    .bind(params.userId, params.revocationId)
    .first<{
      deletedAt: number | null;
      active: number;
      revocationId: string | null;
      cleanupCompletedAt: number | null;
      restored: number;
    }>();
  if (!target || target.deletedAt !== null) {
    throw appError(404, "user_not_found", "User not found");
  }
  if (target.revocationId === null) {
    if (target.restored === 1 && target.active === 1) return "already_restored";
    throw appError(409, "access_not_revoked", "Their access isn't revoked");
  }
  if (target.revocationId !== params.revocationId) throw staleRevocation();
  if (target.cleanupCompletedAt === null) {
    throw appError(
      409,
      "access_cleanup_incomplete",
      "Finish revoking access before restoring it",
    );
  }
  throw appError(
    409,
    "access_restore_conflict",
    "The user changed during the restore. Refresh and try again.",
  );
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
      inviteId: sql<string | null>`null`.as("invite_id"),
      subjectUserId: accessRevocations.userId,
      githubAccountId: revokedGithubAccountId(),
      ssoProviderId: revokedSsoIdentity("provider_id"),
      ssoAccountId: revokedSsoIdentity("account_id"),
      actorUserId: sql<string | null>`${params.actorUserId}`.as("actor_user_id"),
      revocationId: accessRevocations.revocationId,
      cleanupAttemptId: sql<string>`${params.cleanupAttemptId}`.as(
        "cleanup_attempt_id",
      ),
      runId: sql<string | null>`null`.as("run_id"),
      reason: sql<string>`${params.reason}`.as("reason"),
      createdAt: sql<number>`${params.now}`.as("created_at"),
    })
    .from(accessRevocations)
    .where(
      and(
        eq(accessRevocations.userId, params.userId),
        eq(accessRevocations.revocationId, params.revocationId),
        eq(accessRevocations.cleanupAttemptId, params.cleanupAttemptId),
        sql`${accessRevocations.cleanupStartedAt} is not null`,
        isNull(accessRevocations.cleanupCompletedAt),
      ),
    );
}

// Events keep the GitHub account id so the audit trail outlives the account
// row, which user deletion removes. Selects from `access_revocations` only;
// the outer column is spelled out because drizzle leaves column names
// unqualified in single-table selections.
function revokedGithubAccountId() {
  return sql<string | null>`(
    select github.account_id from ${account} as github
    where github.user_id = access_revocations.user_id
      and github.provider_id = 'github'
    limit 1
  )`.as("github_account_id");
}

function revokedSsoIdentity(column: "provider_id" | "account_id") {
  return sql<string | null>`${sql.raw(
    firstOrganizationIdentitySql("access_revocations.user_id", column),
  )}`.as(column === "provider_id" ? "sso_provider_id" : "sso_account_id");
}

// Classifies a revocation that inserted nothing, most specific cause first.
async function revocationFailure(
  d1: D1Database,
  userId: string,
  actorUserId: string,
) {
  if (!(await isActiveAdmin(actorUserId, d1))) return adminRequiredError();
  const [target] = await drizzle(d1)
    .select({
      deletedAt: user.deletedAt,
      revokedUserId: accessRevocations.userId,
    })
    .from(user)
    .leftJoin(accessRevocations, eq(accessRevocations.userId, user.id))
    .where(eq(user.id, userId))
    .limit(1);
  if (!target || target.deletedAt) {
    return appError(404, "user_not_found", "User not found");
  }
  if (target.revokedUserId) {
    return appError(409, "access_already_revoked", "Access is already revoked");
  }
  if (await isLastActiveAdmin(userId, d1)) {
    return lastActiveAdminError("revoked");
  }
  return appError(
    409,
    "access_revocation_conflict",
    "The user changed during revocation. Refresh and try again.",
  );
}

function validId(
  value: string,
  kind: "user" | "actor" | "revocation" | "cleanup attempt",
): string {
  const id = value.trim();
  if (!id || id.length > 255) {
    throw appError(
      400,
      kind === "user" || kind === "actor"
        ? "invalid_user_id"
        : "invalid_access_revocation_id",
      `Invalid ${kind} id`,
    );
  }
  return id;
}

function optionalId(
  value: string | null | undefined,
  kind: "actor",
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

function staleRevocation() {
  return appError(
    409,
    "stale_access_revocation",
    "The access revocation is no longer current",
  );
}
