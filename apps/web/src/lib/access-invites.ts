import { and, desc, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  accessAllowlist,
  accessEvents,
  accessInviteCodes,
  accessInviteRemovals,
  type AccessEventType,
  type AccessInviteKind,
} from "@/db/schema/application";
import { account, user } from "@/db/schema/core";
import { appError, errorChainMatches } from "@/lib/app-error";
import { isValidGithubUsername } from "@/lib/github-username";
import { createAppId } from "@/lib/id";

export const ACCESS_INVITE_LIFETIME_MS = 14 * 24 * 60 * 60 * 1_000;
export const ACCESS_INVITE_LEASE_MS = 10 * 60 * 1_000;

const INVITE_TOKEN_PREFIX = "intar_beta_";
const INVITE_RANDOM_BYTES = 32;
const SAFE_PREFIX_BODY_LENGTH = 8;
const LABEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9 _.:-]{0,79}$/;
const REASON_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,119}$/;
const ID_MAX_LENGTH = 255;

type InviteRow = typeof accessInviteCodes.$inferSelect;
type AllowlistRow = typeof accessAllowlist.$inferSelect;
type InviteInsertRow = typeof accessInviteCodes.$inferInsert;
type AccessEventInsertRow = typeof accessEvents.$inferInsert;

export interface AccessInviteSummary {
  id: string;
  codePrefix: string;
  kind: AccessInviteKind;
  state: "pending" | "leased" | "redeemed" | "revoked";
  label: string | null;
  createdBy: string | null;
  createdAt: number;
  expiresAt: number;
  leaseExpiresAt: number | null;
  redeemerUserId: string | null;
  redeemerGithubAccountId: string | null;
  redeemerGithubUsername: string | null;
  redeemedAt: number | null;
  revokedBy: string | null;
  revocationReason: string | null;
  revokedAt: number | null;
  replacesInviteId: string | null;
  replacedByInviteId: string | null;
  version: number;
  updatedAt: number;
}

export interface AccessInviteAttempt {
  inviteId: string;
  codePrefix: string;
  kind: AccessInviteKind;
  state: "pending" | "leased";
  expiresAt: number;
  version: number;
}

export interface AccessInviteLease {
  inviteId: string;
  leaseId: string;
  kind: AccessInviteKind;
  leaseExpiresAt: number;
  inviteExpiresAt: number;
  version: number;
}

export interface BetaUserSummary {
  userId: string;
  name: string | null;
  role: string | null;
  state: "active" | "blocked";
  githubAccountId: string;
  githubUsername: string;
  sourceInviteId: string;
  grantedBy: string | null;
  grantReason: string;
  grantedAt: number;
  revocationId: string | null;
  revokedBy: string | null;
  revocationReason: string | null;
  revokedAt: number | null;
  revocationCleanupCompletedAt: number | null;
}

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

export type AccessFailureReason =
  | "invalid_code"
  | "expired"
  | "unavailable"
  | "lease_conflict"
  | "lease_invalid"
  | "claim_conflict"
  | "identity_mismatch"
  | "stale_version"
  | "blocked_user"
  | "already_active"
  | "rate_limited";

export async function createAccessInvite(
  params: {
    d1: D1Database;
    label?: string | null;
    now?: number;
  } & (
    | { kind: "standard"; actorUserId: string }
    | { kind: "bootstrap_admin"; actorUserId?: never }
  ),
): Promise<AccessInviteSummary & { code: string }> {
  const now = validTimestamp(params.now ?? Date.now());
  const label = normalizeLabel(params.label);
  const actorUserId =
    params.kind === "standard" ? validId(params.actorUserId, "actor") : null;
  const generated = await generateAccessInviteCode();
  const row: typeof accessInviteCodes.$inferInsert = {
    id: createAppId(),
    codeHash: generated.hash,
    codePrefix: generated.prefix,
    kind: params.kind,
    state: "pending",
    label,
    createdBy: actorUserId,
    createdAt: now,
    expiresAt: now + ACCESS_INVITE_LIFETIME_MS,
    version: 1,
    updatedAt: now,
  };
  const db = drizzle(params.d1);
  const createdEvent = accessEvent({
    eventType: "invite.created",
    inviteId: row.id,
    actorUserId,
    reason: params.kind,
    createdAt: now,
  });
  const insert = db
    .insert(accessInviteCodes)
    .select(
      db
        .select(inviteInsertFields(row))
        .from(sql`(select 1) as command_source`)
        .where(
          params.kind === "bootstrap_admin"
            ? sql`true`
            : activeAdministratorPredicate(actorUserId!),
        ),
    )
    .returning();
  const eventInsert = db.insert(accessEvents).select(
    db
      .select(accessEventInsertFields(createdEvent))
      .from(accessInviteCodes)
      .where(eq(accessInviteCodes.id, row.id)),
  );
  const [inserted] = await db.batch([insert, eventInsert]);
  if (!inserted[0]) throw inviteIssuerForbidden();
  return { ...toInviteSummary(inserted[0]), code: generated.code };
}

export async function listAccessInvites(params: {
  d1: D1Database;
  limit?: number;
  now?: number;
}): Promise<AccessInviteSummary[]> {
  const limit = boundedLimit(params.limit);
  const now = validTimestamp(params.now ?? Date.now());
  const db = drizzle(params.d1);
  const rows = await db
    .select()
    .from(accessInviteCodes)
    .where(
      notExists(
        db
          .select({ inviteId: accessInviteRemovals.inviteId })
          .from(accessInviteRemovals)
          .where(eq(accessInviteRemovals.inviteId, accessInviteCodes.id)),
      ),
    )
    .orderBy(desc(accessInviteCodes.createdAt))
    .limit(limit);
  return rows.map((row) => {
    const summary = toInviteSummary(row);
    if (
      summary.state === "leased" &&
      (summary.leaseExpiresAt ?? 0) <= now
    ) {
      return { ...summary, state: "pending", leaseExpiresAt: null };
    }
    return summary;
  });
}

// Lookup is intentionally read-only: exchanging a fragment never leases or
// consumes the underlying invitation.
export async function exchangeAccessInviteCode(params: {
  d1: D1Database;
  code: string;
  now?: number;
}): Promise<AccessInviteAttempt> {
  const now = validTimestamp(params.now ?? Date.now());
  if (!isAccessInviteCode(params.code)) {
    await recordAccessFailure({
      d1: params.d1,
      eventType: "invite.exchange_failed",
      reason: "invalid_code",
      now,
    });
    throw unavailableInvite();
  }

  const hash = await hashAccessInviteCode(params.code);
  const rows = await drizzle(params.d1)
    .select()
    .from(accessInviteCodes)
    .where(eq(accessInviteCodes.codeHash, hash))
    .limit(1);
  const row = rows[0];
  if (!row) {
    await recordAccessFailure({
      d1: params.d1,
      eventType: "invite.exchange_failed",
      reason: "invalid_code",
      now,
    });
    throw unavailableInvite();
  }
  if (row.expiresAt <= now) {
    await recordAccessFailure({
      d1: params.d1,
      eventType: "invite.exchange_failed",
      inviteId: row.id,
      reason: "expired",
      now,
    });
    throw unavailableInvite();
  }
  if (row.state !== "pending" && row.state !== "leased") {
    await recordAccessFailure({
      d1: params.d1,
      eventType: "invite.exchange_failed",
      inviteId: row.id,
      reason: "unavailable",
      now,
    });
    throw unavailableInvite();
  }
  return toAttempt(row);
}

export async function getCurrentAccessInvite(params: {
  d1: D1Database;
  inviteId: string;
  now?: number;
}): Promise<AccessInviteAttempt> {
  const now = validTimestamp(params.now ?? Date.now());
  const inviteId = validId(params.inviteId, "invite");
  const rows = await drizzle(params.d1)
    .select()
    .from(accessInviteCodes)
    .where(eq(accessInviteCodes.id, inviteId))
    .limit(1);
  const row = rows[0];
  if (
    !row ||
    (row.state !== "pending" && row.state !== "leased") ||
    (row.state === "pending" && row.expiresAt <= now) ||
    (row.state === "leased" && (row.leaseExpiresAt ?? 0) <= now)
  ) {
    throw unavailableInvite();
  }
  return toAttempt(row);
}

export async function leaseAccessInvite(params: {
  d1: D1Database;
  inviteId: string;
  now?: number;
}): Promise<AccessInviteLease> {
  const now = validTimestamp(params.now ?? Date.now());
  const inviteId = validId(params.inviteId, "invite");
  const leaseId = createAppId();
  const leaseExpiresAt = now + ACCESS_INVITE_LEASE_MS;
  const db = drizzle(params.d1);
  const event = accessEvent({
    eventType: "invite.leased",
    inviteId,
    createdAt: now,
  });
  const [leased] = await db.batch([
    db
      .update(accessInviteCodes)
      .set({
        state: "leased",
        leaseId,
        leasedAt: now,
        leaseExpiresAt,
        version: sql`${accessInviteCodes.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(accessInviteCodes.id, inviteId),
          sql`${accessInviteCodes.expiresAt} > ${now}`,
          sql`(
            ${accessInviteCodes.state} = 'pending'
            OR (
              ${accessInviteCodes.state} = 'leased'
              AND ${accessInviteCodes.leaseExpiresAt} <= ${now}
            )
          )`,
        ),
      )
      .returning({
        inviteId: accessInviteCodes.id,
        leaseId: accessInviteCodes.leaseId,
        kind: accessInviteCodes.kind,
        leaseExpiresAt: accessInviteCodes.leaseExpiresAt,
        inviteExpiresAt: accessInviteCodes.expiresAt,
        version: accessInviteCodes.version,
      }),
    db.insert(accessEvents).select(
      db
        .select(accessEventInsertFields(event))
        .from(accessInviteCodes)
        .where(
          and(
            eq(accessInviteCodes.id, inviteId),
            eq(accessInviteCodes.state, "leased"),
            eq(accessInviteCodes.leaseId, leaseId),
            eq(accessInviteCodes.leasedAt, now),
            eq(accessInviteCodes.leaseExpiresAt, leaseExpiresAt),
          ),
        ),
    ),
  ]);
  const row = leased[0];
  if (
    row?.leaseId &&
    row.leaseExpiresAt != null &&
    row.inviteExpiresAt != null
  ) {
    return {
      inviteId: row.inviteId,
      leaseId: row.leaseId,
      kind: row.kind,
      leaseExpiresAt: row.leaseExpiresAt,
      inviteExpiresAt: row.inviteExpiresAt,
      version: row.version,
    };
  }

  await recordAccessFailure({
    d1: params.d1,
    eventType: "invite.lease_failed",
    inviteId,
    reason: "lease_conflict",
    now,
  });
  throw appError(
    409,
    "access_invite_lease_unavailable",
    "the invite is unavailable or already being claimed",
  );
}

// Better Auth must call this only for a GitHub provider callback. Requiring
// providerId here prevents invitation OAuth state from authorizing another
// provider when callback state is replayed cross-provider.
export async function validateGithubInviteLease(params: {
  d1: D1Database;
  inviteId: string;
  leaseId: string;
  providerId: string;
  now?: number;
}): Promise<AccessInviteLease> {
  const now = validTimestamp(params.now ?? Date.now());
  const inviteId = validId(params.inviteId, "invite");
  const leaseId = validId(params.leaseId, "lease");
  if (params.providerId !== "github") {
    await recordAccessFailure({
      d1: params.d1,
      eventType: "invite.lease_failed",
      inviteId,
      reason: "identity_mismatch",
      now,
    });
    throw invalidLease();
  }

  const lease = await params.d1
    .prepare(
      `SELECT id AS inviteId,
              lease_id AS leaseId,
              kind,
              lease_expires_at AS leaseExpiresAt,
              expires_at AS inviteExpiresAt,
              version
       FROM access_invite_codes
       WHERE id = ?
         AND state = 'leased'
         AND lease_id = ?
         AND leased_at <= ?
         AND lease_expires_at > ?`,
    )
    .bind(inviteId, leaseId, now, now)
    .first<AccessInviteLease>();
  if (lease) return lease;

  await recordAccessFailure({
    d1: params.d1,
    eventType: "invite.lease_failed",
    inviteId,
    reason: "lease_invalid",
    now,
  });
  throw invalidLease();
}

export async function releaseAccessInviteLease(params: {
  d1: D1Database;
  inviteId: string;
  leaseId: string;
  now?: number;
}): Promise<boolean> {
  const now = validTimestamp(params.now ?? Date.now());
  const inviteId = validId(params.inviteId, "invite");
  const leaseId = validId(params.leaseId, "lease");
  const db = drizzle(params.d1);
  const event = accessEvent({
    eventType: "invite.lease_released",
    inviteId,
    createdAt: now,
  });
  const [released] = await db.batch([
    db
      .update(accessInviteCodes)
      .set({
        state: "pending",
        leaseId: null,
        leasedAt: null,
        leaseExpiresAt: null,
        version: sql`${accessInviteCodes.version} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(accessInviteCodes.id, inviteId),
          eq(accessInviteCodes.state, "leased"),
          eq(accessInviteCodes.leaseId, leaseId),
        ),
      )
      .returning({ id: accessInviteCodes.id }),
    db.insert(accessEvents).select(
      db
        .select(accessEventInsertFields(event))
        .from(accessInviteCodes)
        .where(
          and(
            eq(accessInviteCodes.id, inviteId),
            eq(accessInviteCodes.state, "pending"),
            eq(accessInviteCodes.updatedAt, now),
            notExists(
              db
                .select({ id: accessEvents.id })
                .from(accessEvents)
                .where(
                  and(
                    eq(accessEvents.eventType, "invite.lease_released"),
                    eq(accessEvents.inviteId, inviteId),
                    eq(accessEvents.createdAt, now),
                  ),
                ),
            ),
          ),
        ),
    ),
  ]);
  return released[0]?.id === inviteId;
}

export async function replaceAccessInvite(params: {
  d1: D1Database;
  inviteId: string;
  expectedVersion: number;
  actorUserId: string;
  label?: string | null;
  now?: number;
}): Promise<AccessInviteSummary & { code: string }> {
  const now = validTimestamp(params.now ?? Date.now());
  const actorUserId = validId(params.actorUserId, "actor");
  const inviteId = validId(params.inviteId, "invite");
  const expectedVersion = validVersion(params.expectedVersion);
  const generated = await generateAccessInviteCode();
  const row: typeof accessInviteCodes.$inferInsert = {
    id: createAppId(),
    codeHash: generated.hash,
    codePrefix: generated.prefix,
    kind: "standard",
    state: "pending",
    label: normalizeLabel(params.label),
    createdBy: actorUserId,
    createdAt: now,
    expiresAt: now + ACCESS_INVITE_LIFETIME_MS,
    replacesInviteId: inviteId,
    replacesInviteVersion: expectedVersion,
    version: 1,
    updatedAt: now,
  };
  const db = drizzle(params.d1);
  const replacedEvent = accessEvent({
    eventType: "invite.replaced",
    inviteId,
    actorUserId,
    reason: "replaced",
    createdAt: now,
  });
  const createdEvent = accessEvent({
    eventType: "invite.created",
    inviteId: row.id,
    actorUserId,
    reason: "standard",
    createdAt: now,
  });
  const [replaced, inserted] = await db.batch([
    db
      .update(accessInviteCodes)
      .set({
        state: "revoked",
        leaseId: null,
        leasedAt: null,
        leaseExpiresAt: null,
        revokedBy: actorUserId,
        revocationReason: "replaced",
        revokedAt: now,
        replacedByInviteId: row.id,
        version: expectedVersion + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(accessInviteCodes.id, inviteId),
          eq(accessInviteCodes.kind, "standard"),
          eq(accessInviteCodes.version, expectedVersion),
          inArray(accessInviteCodes.state, ["pending", "leased"]),
          activeAdministratorPredicate(actorUserId),
        ),
      )
      .returning({ id: accessInviteCodes.id }),
    db
      .insert(accessInviteCodes)
      .select(
        db
          .select(inviteInsertFields(row))
          .from(accessInviteCodes)
          .where(
            and(
              eq(accessInviteCodes.id, inviteId),
              eq(accessInviteCodes.state, "revoked"),
              eq(accessInviteCodes.version, expectedVersion + 1),
              eq(accessInviteCodes.replacedByInviteId, row.id),
              eq(accessInviteCodes.revokedBy, actorUserId),
              eq(accessInviteCodes.revocationReason, "replaced"),
              eq(accessInviteCodes.revokedAt, now),
            ),
          ),
      )
      .returning(),
    db.insert(accessEvents).select(
      db
        .select(accessEventInsertFields(replacedEvent))
        .from(accessInviteCodes)
        .where(
          and(
            eq(accessInviteCodes.id, inviteId),
            eq(accessInviteCodes.state, "revoked"),
            eq(accessInviteCodes.replacedByInviteId, row.id),
            eq(accessInviteCodes.version, expectedVersion + 1),
          ),
        ),
    ),
    db.insert(accessEvents).select(
      db
        .select(accessEventInsertFields(createdEvent))
        .from(accessInviteCodes)
        .where(eq(accessInviteCodes.id, row.id)),
    ),
  ]);
  if (replaced[0]?.id === inviteId && inserted[0]) {
    return { ...toInviteSummary(inserted[0]), code: generated.code };
  }
  if (!(await isActiveAdministrator(params.d1, actorUserId))) {
    throw inviteIssuerForbidden();
  }
  throw staleInvite();
}

export async function revokeAccessInvite(params: {
  d1: D1Database;
  inviteId: string;
  expectedVersion: number;
  actorUserId: string;
  reason: string;
  now?: number;
}): Promise<AccessInviteSummary> {
  const db = drizzle(params.d1);
  const now = validTimestamp(params.now ?? Date.now());
  const inviteId = validId(params.inviteId, "invite");
  const expectedVersion = validVersion(params.expectedVersion);
  const actorUserId = validId(params.actorUserId, "actor");
  const reason = validReason(params.reason);
  const event = accessEvent({
    eventType: "invite.revoked",
    inviteId,
    actorUserId,
    reason,
    createdAt: now,
  });
  const [updated] = await db.batch([
    db
      .update(accessInviteCodes)
      .set({
        state: "revoked",
        leaseId: null,
        leasedAt: null,
        leaseExpiresAt: null,
        revokedBy: actorUserId,
        revocationReason: reason,
        revokedAt: now,
        version: expectedVersion + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(accessInviteCodes.id, inviteId),
          eq(accessInviteCodes.version, expectedVersion),
          inArray(accessInviteCodes.state, ["pending", "leased"]),
          activeAdministratorPredicate(actorUserId),
        ),
      )
      .returning(),
    db.insert(accessEvents).select(
      db
        .select(accessEventInsertFields(event))
        .from(accessInviteCodes)
        .where(
          and(
            eq(accessInviteCodes.id, inviteId),
            eq(accessInviteCodes.state, "revoked"),
            eq(accessInviteCodes.version, expectedVersion + 1),
            eq(accessInviteCodes.revokedBy, actorUserId),
            eq(accessInviteCodes.revocationReason, reason),
            eq(accessInviteCodes.revokedAt, now),
          ),
        ),
    ),
  ]);
  const row = updated[0];
  if (row?.state === "revoked") return toInviteSummary(row);
  if (!(await isActiveAdministrator(params.d1, actorUserId))) {
    throw inviteRevokerForbidden();
  }
  throw staleInvite();
}

export async function removeAccessInvite(params: {
  d1: D1Database;
  inviteId: string;
  expectedVersion: number;
  actorUserId: string;
  now?: number;
}): Promise<void> {
  const db = drizzle(params.d1);
  const inviteId = validId(params.inviteId, "invite");
  const actorUserId = validId(params.actorUserId, "actor");
  const expectedVersion = validVersion(params.expectedVersion);
  const now = validTimestamp(params.now ?? Date.now());
  const removedEvent = accessEvent({
    eventType: "invite.removed",
    inviteId,
    actorUserId,
    reason: "admin_removed",
    createdAt: now,
  });
  const revokedEvent = accessEvent({
    eventType: "invite.revoked",
    inviteId,
    actorUserId,
    reason: "admin_removed",
    createdAt: now,
  });
  const [inserted] = await db.batch([
    db
      .insert(accessInviteRemovals)
      .select(
        db
          .select({
            inviteId: accessInviteCodes.id,
            inviteVersion: accessInviteCodes.version,
            removedBy: sql<string>`${actorUserId}`.as("removed_by"),
            removedAt: sql<number>`${now}`.as("removed_at"),
          })
          .from(accessInviteCodes)
          .where(
            and(
              eq(accessInviteCodes.id, inviteId),
              eq(accessInviteCodes.version, expectedVersion),
              activeAdministratorPredicate(actorUserId),
            ),
          ),
      )
      .onConflictDoNothing()
      .returning({ inviteId: accessInviteRemovals.inviteId }),
    db
      .update(accessInviteCodes)
      .set({
        state: "revoked",
        leaseId: null,
        leasedAt: null,
        leaseExpiresAt: null,
        revokedBy: actorUserId,
        revocationReason: "admin_removed",
        revokedAt: now,
        version: expectedVersion + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(accessInviteCodes.id, inviteId),
          eq(accessInviteCodes.version, expectedVersion),
          inArray(accessInviteCodes.state, ["pending", "leased"]),
          sql`exists (
            select 1 from ${accessInviteRemovals}
            where ${accessInviteRemovals.inviteId} = ${inviteId}
              and ${accessInviteRemovals.inviteVersion} = ${expectedVersion}
              and ${accessInviteRemovals.removedBy} = ${actorUserId}
              and ${accessInviteRemovals.removedAt} = ${now}
          )`,
        ),
      ),
    db.insert(accessEvents).select(
      db
        .select(accessEventInsertFields(revokedEvent))
        .from(accessInviteCodes)
        .where(
          and(
            eq(accessInviteCodes.id, inviteId),
            eq(accessInviteCodes.state, "revoked"),
            eq(accessInviteCodes.version, expectedVersion + 1),
            eq(accessInviteCodes.revokedBy, actorUserId),
            eq(accessInviteCodes.revocationReason, "admin_removed"),
            eq(accessInviteCodes.revokedAt, now),
            notExists(
              db
                .select({ id: accessEvents.id })
                .from(accessEvents)
                .where(
                  and(
                    eq(accessEvents.eventType, "invite.revoked"),
                    eq(accessEvents.inviteId, inviteId),
                    eq(accessEvents.reason, "admin_removed"),
                  ),
                ),
            ),
          ),
        ),
    ),
    db.insert(accessEvents).select(
      db
        .select(accessEventInsertFields(removedEvent))
        .from(accessInviteRemovals)
        .where(
          and(
            eq(accessInviteRemovals.inviteId, inviteId),
            notExists(
              db
                .select({ id: accessEvents.id })
                .from(accessEvents)
                .where(
                  and(
                    eq(accessEvents.eventType, "invite.removed"),
                    eq(accessEvents.inviteId, inviteId),
                  ),
                ),
            ),
          ),
        ),
    ),
  ]);
  if (inserted[0]?.inviteId === inviteId) return;
  if (!(await isActiveAdministrator(params.d1, actorUserId))) {
    throw inviteRemoverForbidden();
  }
  if (await hasInviteRemoval(params.d1, inviteId)) return;
  const invite = await db
    .select({ id: accessInviteCodes.id })
    .from(accessInviteCodes)
    .where(eq(accessInviteCodes.id, inviteId))
    .limit(1);
  if (!invite[0]) throw unavailableInvite();
  throw staleInvite();
}

export async function confirmAccessInvite(params: {
  d1: D1Database;
  inviteId: string;
  leaseId: string;
  userId: string;
  githubAccountId: string;
  githubUsername: string;
  now?: number;
}): Promise<BetaUserSummary> {
  const now = validTimestamp(params.now ?? Date.now());
  const inviteId = validId(params.inviteId, "invite");
  const leaseId = validId(params.leaseId, "lease");
  const userId = validId(params.userId, "user");
  const githubAccountId = validId(params.githubAccountId, "GitHub account");
  const githubUsername = params.githubUsername.trim();
  if (!isValidGithubUsername(githubUsername)) {
    throw appError(
      400,
      "invalid_github_username",
      "the GitHub username is invalid",
    );
  }

  const db = drizzle(params.d1);
  const redeemedEvent = accessEvent({
    eventType: "invite.redeemed",
    inviteId,
    subjectUserId: userId,
    githubAccountId,
    actorUserId: userId,
    createdAt: now,
  });
  const grantedEventId = createAppId();
  try {
    const [redeemed, admitted] = await db.batch([
      db
        .update(accessInviteCodes)
        .set({
          state: "redeemed",
          redeemerUserId: userId,
          redeemerGithubAccountId: githubAccountId,
          redeemerGithubUsername: githubUsername,
          redeemedAt: now,
          version: sql`${accessInviteCodes.version} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(accessInviteCodes.id, inviteId),
            eq(accessInviteCodes.state, "leased"),
            eq(accessInviteCodes.leaseId, leaseId),
            sql`${accessInviteCodes.leasedAt} <= ${now}`,
            sql`${accessInviteCodes.leaseExpiresAt} > ${now}`,
            notExists(
              db
                .select({ inviteId: accessInviteRemovals.inviteId })
                .from(accessInviteRemovals)
                .where(eq(accessInviteRemovals.inviteId, inviteId)),
            ),
            sql`exists (
              select 1 from ${account}
              where ${account.providerId} = 'github'
                and ${account.accountId} = ${githubAccountId}
                and ${account.userId} = ${userId}
            )`,
            sql`not exists (
              select 1 from ${accessEvents}
              where ${accessEvents.eventType} = 'access.reinvite_allowed'
                and ${accessEvents.subjectUserId} = ${userId}
                and ${accessEvents.createdAt} >= ${accessInviteCodes.createdAt}
            )`,
            sql`(
              ${accessInviteCodes.kind} <> 'bootstrap_admin'
              or exists (
                select 1 from ${user}
                where ${user.id} = ${userId}
                  and instr(
                    ',' || replace(lower(coalesce(${user.role}, '')), ' ', '') || ',',
                    ',admin,'
                  ) > 0
              )
            )`,
          ),
        )
        .returning({ id: accessInviteCodes.id }),
      db
        .insert(accessAllowlist)
        .select(
          db
            .select({
              userId: sql<string>`${userId}`.as("user_id"),
              state: sql<"active">`'active'`.as("state"),
              githubAccountId: sql<string>`${githubAccountId}`.as("github_account_id"),
              githubUsername: sql<string>`${githubUsername}`.as("github_username"),
              sourceInviteId: accessInviteCodes.id,
              sourceLeaseId: sql<string>`${leaseId}`.as("source_lease_id"),
              grantedBy: accessInviteCodes.createdBy,
              grantReason: accessInviteCodes.kind,
              grantedAt: sql<number>`${now}`.as("granted_at"),
              revocationId: sql<string | null>`null`.as("revocation_id"),
              revokedBy: sql<string | null>`null`.as("revoked_by"),
              revocationReason: sql<string | null>`null`.as("revocation_reason"),
              revokedAt: sql<number | null>`null`.as("revoked_at"),
              revocationCleanupAttemptId: sql<string | null>`null`.as("revocation_cleanup_attempt_id"),
              revocationCleanupStartedAt: sql<number | null>`null`.as("revocation_cleanup_started_at"),
              revocationCleanupCompletedAt: sql<number | null>`null`.as("revocation_cleanup_completed_at"),
            })
            .from(accessInviteCodes)
            .where(
              and(
                eq(accessInviteCodes.id, inviteId),
                eq(accessInviteCodes.state, "redeemed"),
                eq(accessInviteCodes.leaseId, leaseId),
                eq(accessInviteCodes.redeemerUserId, userId),
                eq(accessInviteCodes.redeemerGithubAccountId, githubAccountId),
                eq(accessInviteCodes.redeemerGithubUsername, githubUsername),
                eq(accessInviteCodes.redeemedAt, now),
              ),
            ),
        )
        .returning(),
      db.insert(accessEvents).select(
        db
          .select(accessEventInsertFields(redeemedEvent))
          .from(accessInviteCodes)
          .where(
            and(
              eq(accessInviteCodes.id, inviteId),
              eq(accessInviteCodes.state, "redeemed"),
              eq(accessInviteCodes.redeemerUserId, userId),
              eq(accessInviteCodes.redeemerGithubAccountId, githubAccountId),
              eq(accessInviteCodes.redeemedAt, now),
            ),
          ),
      ),
      db.insert(accessEvents).select(
        db
          .select({
            id: sql<string>`${grantedEventId}`.as("id"),
            eventType: sql<AccessEventType>`'access.granted'`.as("event_type"),
            inviteId: accessAllowlist.sourceInviteId,
            subjectUserId: accessAllowlist.userId,
            githubAccountId: accessAllowlist.githubAccountId,
            actorUserId: accessAllowlist.grantedBy,
            revocationId: sql<string | null>`null`.as("revocation_id"),
            cleanupAttemptId: sql<string | null>`null`.as("cleanup_attempt_id"),
            reason: accessAllowlist.grantReason,
            createdAt: accessAllowlist.grantedAt,
          })
          .from(accessAllowlist)
          .where(
            and(
              eq(accessAllowlist.userId, userId),
              eq(accessAllowlist.sourceInviteId, inviteId),
              eq(accessAllowlist.sourceLeaseId, leaseId),
              eq(accessAllowlist.grantedAt, now),
            ),
          ),
      ),
    ]);
    if (redeemed[0]?.id === inviteId && admitted[0]) {
      return toBetaUserSummary(admitted[0], null, null);
    }
  } catch (error) {
    if (
      !errorChainMatches(
        error,
        /unique constraint failed:\s*access_allowlist\.(?:user_id|github_account_id|source_invite_id)/i,
      )
    ) {
      throw error;
    }
  }
  const freshInviteRequired = await requiresFreshInvite(
    params.d1,
    inviteId,
    userId,
  );
  const identityMatches = await githubAccountBelongsToUser(
    params.d1,
    githubAccountId,
    userId,
  );
  await recordAccessFailure({
    d1: params.d1,
    eventType: "invite.claim_failed",
    inviteId,
    subjectUserId: userId,
    githubAccountId,
    reason: identityMatches ? "claim_conflict" : "identity_mismatch",
    now,
  });
  throw appError(
    409,
    freshInviteRequired
      ? "fresh_beta_invite_required"
      : "access_invite_claim_conflict",
    freshInviteRequired
      ? "an administrator must issue a fresh invite after clearing a beta block"
      : "the invite could not be claimed",
  );
}

export async function listBetaUsers(params: {
  d1: D1Database;
  limit?: number;
}): Promise<BetaUserSummary[]> {
  const rows = await drizzle(params.d1)
    .select({
      access: accessAllowlist,
      name: user.name,
      role: user.role,
    })
    .from(accessAllowlist)
    .leftJoin(user, eq(user.id, accessAllowlist.userId))
    .orderBy(desc(accessAllowlist.grantedAt))
    .limit(boundedLimit(params.limit));
  return rows.map(({ access, name, role }) =>
    toBetaUserSummary(access, name, role),
  );
}

export async function revokeBetaUser(params: {
  d1: D1Database;
  userId: string;
  actorUserId: string;
  reason: string;
  now?: number;
}): Promise<{ user: BetaUserSummary; revocationId: string }> {
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
      .returning(),
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
  if (updated[0]) {
    return {
      user: toBetaUserSummary(updated[0], null, null),
      revocationId,
    };
  }
  if (!(await isActiveAdministrator(params.d1, actorUserId))) {
    throw betaAdministratorForbidden();
  }
  if (
    (await isActiveAdministrator(params.d1, userId)) &&
    !(await hasOtherActiveAdministrator(params.d1, userId))
  ) {
    throw appError(
      409,
      "last_beta_admin",
      "the last active beta administrator cannot be revoked",
    );
  }
  throw appError(409, "beta_user_not_active", "the beta user is not active");
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
      "revocation cleanup is already running",
    );
  }
  throw appError(
    409,
    "stale_beta_revocation",
    "the beta revocation is no longer current",
  );
}

export async function completeBetaRevocationCleanup(params: {
  d1: D1Database;
  userId: string;
  revocationId: string;
  cleanupAttemptId: string;
  now?: number;
}): Promise<BetaUserSummary> {
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
      .returning(),
    db.insert(accessEvents).select(
      db
        .select({
          id: sql<string>`${completedEventId}`.as("id"),
          eventType: sql<AccessEventType>`'access.revocation_cleanup_completed'`.as("event_type"),
          inviteId: accessAllowlist.sourceInviteId,
          subjectUserId: accessAllowlist.userId,
          githubAccountId: accessAllowlist.githubAccountId,
          actorUserId: sql<string | null>`null`.as("actor_user_id"),
          revocationId: accessAllowlist.revocationId,
          cleanupAttemptId: accessAllowlist.revocationCleanupAttemptId,
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
  if (updated[0]) return toBetaUserSummary(updated[0], null, null);

  const current = await db
    .select()
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
    current[0]?.revocationCleanupAttemptId === cleanupAttemptId &&
    current[0].revocationCleanupCompletedAt != null
  ) {
    return toBetaUserSummary(current[0], null, null);
  }
  throw appError(
    409,
    "stale_beta_revocation",
    "the beta revocation is no longer current",
  );
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
        db
          .select({
            id: sql<string>`${eventId}`.as("id"),
            eventType: sql<AccessEventType>`'access.revocation_cleanup_failed'`.as("event_type"),
            inviteId: accessAllowlist.sourceInviteId,
            subjectUserId: accessAllowlist.userId,
            githubAccountId: accessAllowlist.githubAccountId,
            actorUserId: sql<string | null>`${actorUserId}`.as("actor_user_id"),
            revocationId: accessAllowlist.revocationId,
            cleanupAttemptId: sql<string>`${cleanupAttemptId}`.as("cleanup_attempt_id"),
            reason: sql<string>`${reason}`.as("reason"),
            createdAt: sql<number>`${now}`.as("created_at"),
          })
          .from(accessAllowlist)
          .where(
            and(
              eq(accessAllowlist.userId, userId),
              eq(accessAllowlist.state, "blocked"),
              eq(accessAllowlist.revocationId, revocationId),
              eq(accessAllowlist.revocationCleanupAttemptId, cleanupAttemptId),
              sql`${accessAllowlist.revocationCleanupStartedAt} is not null`,
              isNull(accessAllowlist.revocationCleanupCompletedAt),
            ),
          ),
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

  throw appError(
    409,
    "stale_beta_revocation",
    "the beta revocation is no longer current",
  );
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
      db
        .select({
          id: sql<string>`${eventId}`.as("id"),
          eventType: sql<AccessEventType>`'access.revocation_cleanup_stalled'`.as("event_type"),
          inviteId: accessAllowlist.sourceInviteId,
          subjectUserId: accessAllowlist.userId,
          githubAccountId: accessAllowlist.githubAccountId,
          actorUserId: sql<string | null>`${actorUserId}`.as("actor_user_id"),
          revocationId: accessAllowlist.revocationId,
          cleanupAttemptId: sql<string>`${cleanupAttemptId}`.as("cleanup_attempt_id"),
          reason: sql<string>`${reason}`.as("reason"),
          createdAt: sql<number>`${now}`.as("created_at"),
        })
        .from(accessAllowlist)
        .where(
          and(
            eq(accessAllowlist.userId, userId),
            eq(accessAllowlist.state, "blocked"),
            eq(accessAllowlist.revocationId, revocationId),
            eq(accessAllowlist.revocationCleanupAttemptId, cleanupAttemptId),
            sql`${accessAllowlist.revocationCleanupStartedAt} is not null`,
            isNull(accessAllowlist.revocationCleanupCompletedAt),
          ),
        ),
    )
    .returning({ id: accessEvents.id });
  if (recorded[0]?.id === eventId) return;

  throw appError(
    409,
    "stale_beta_revocation",
    "the beta revocation is no longer current",
  );
}

export async function allowBetaReinvite(params: {
  d1: D1Database;
  userId: string;
  actorUserId: string;
  revocationId: string;
  now?: number;
}): Promise<void> {
  const now = validTimestamp(params.now ?? Date.now());
  const userId = validId(params.userId, "user");
  const actorUserId = validId(params.actorUserId, "actor");
  const revocationId = validId(params.revocationId, "revocation");
  const eventId = createAppId();
  const db = drizzle(params.d1);
  const [inserted] = await db.batch([
    db
      .insert(accessEvents)
      .select(
        db
          .select({
            id: sql<string>`${eventId}`.as("id"),
            eventType: sql<AccessEventType>`'access.reinvite_allowed'`.as("event_type"),
            inviteId: sql<string | null>`null`.as("invite_id"),
            subjectUserId: accessAllowlist.userId,
            githubAccountId: sql<string | null>`null`.as("github_account_id"),
            actorUserId: sql<string>`${actorUserId}`.as("actor_user_id"),
            revocationId: accessAllowlist.revocationId,
            cleanupAttemptId: sql<string | null>`null`.as("cleanup_attempt_id"),
            reason: sql<string>`'admin_cleared_block'`.as("reason"),
            createdAt: sql<number>`${now}`.as("created_at"),
          })
          .from(accessAllowlist)
          .where(
            and(
              eq(accessAllowlist.userId, userId),
              eq(accessAllowlist.state, "blocked"),
              eq(accessAllowlist.revocationId, revocationId),
              sql`${accessAllowlist.revocationCleanupCompletedAt} is not null`,
              activeAdministratorPredicate(actorUserId),
            ),
          ),
      )
      .returning({ id: accessEvents.id }),
    db.delete(accessAllowlist).where(
      and(
        eq(accessAllowlist.userId, userId),
        eq(accessAllowlist.state, "blocked"),
        eq(accessAllowlist.revocationId, revocationId),
        sql`${accessAllowlist.revocationCleanupCompletedAt} is not null`,
        sql`exists (
          select 1 from ${accessEvents}
          where ${accessEvents.id} = ${eventId}
            and ${accessEvents.eventType} = 'access.reinvite_allowed'
        )`,
      ),
    ),
  ]);
  if (inserted[0]?.id === eventId) return;
  if (!(await isActiveAdministrator(params.d1, actorUserId))) {
    throw betaAdministratorForbidden();
  }
  throw appError(
    409,
    "beta_revocation_cleanup_incomplete",
    "revocation cleanup must complete before another invite is allowed",
  );
}

export async function recordAccessFailure(params: {
  d1: D1Database;
  eventType:
    "invite.exchange_failed" | "invite.lease_failed" | "invite.claim_failed";
  reason: AccessFailureReason;
  inviteId?: string | null;
  subjectUserId?: string | null;
  githubAccountId?: string | null;
  actorUserId?: string | null;
  now?: number;
}): Promise<void> {
  await drizzle(params.d1)
    .insert(accessEvents)
    .values({
      id: createAppId(),
      eventType: params.eventType,
      inviteId: optionalId(params.inviteId, "invite"),
      subjectUserId: optionalId(params.subjectUserId, "user"),
      githubAccountId: optionalId(params.githubAccountId, "GitHub account"),
      actorUserId: optionalId(params.actorUserId, "actor"),
      reason: params.reason,
      createdAt: validTimestamp(params.now ?? Date.now()),
    });
}

export async function hashAccessInviteCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(code),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function toInviteSummary(row: InviteRow): AccessInviteSummary {
  return {
    id: row.id,
    codePrefix: row.codePrefix,
    kind: row.kind,
    state: row.state,
    label: row.label,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    leaseExpiresAt: row.leaseExpiresAt,
    redeemerUserId: row.redeemerUserId,
    redeemerGithubAccountId: row.redeemerGithubAccountId,
    redeemerGithubUsername: row.redeemerGithubUsername,
    redeemedAt: row.redeemedAt,
    revokedBy: row.revokedBy,
    revocationReason: row.revocationReason,
    revokedAt: row.revokedAt,
    replacesInviteId: row.replacesInviteId,
    replacedByInviteId: row.replacedByInviteId,
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

function toAttempt(row: InviteRow): AccessInviteAttempt {
  if (row.state !== "pending" && row.state !== "leased") {
    throw unavailableInvite();
  }
  return {
    inviteId: row.id,
    codePrefix: row.codePrefix,
    kind: row.kind,
    state: row.state,
    expiresAt: row.expiresAt,
    version: row.version,
  };
}

function toBetaUserSummary(
  row: AllowlistRow,
  name: string | null,
  role: string | null,
): BetaUserSummary {
  return {
    userId: row.userId,
    name,
    role,
    state: row.state,
    githubAccountId: row.githubAccountId,
    githubUsername: row.githubUsername,
    sourceInviteId: row.sourceInviteId,
    grantedBy: row.grantedBy,
    grantReason: row.grantReason,
    grantedAt: row.grantedAt,
    revocationId: row.revocationId,
    revokedBy: row.revokedBy,
    revocationReason: row.revocationReason,
    revokedAt: row.revokedAt,
    revocationCleanupCompletedAt: row.revocationCleanupCompletedAt,
  };
}

function inviteInsertFields(row: InviteInsertRow) {
  return {
    id: sql<string>`${row.id}`.as("id"),
    codeHash: sql<string>`${row.codeHash}`.as("code_hash"),
    codePrefix: sql<string>`${row.codePrefix}`.as("code_prefix"),
    kind: sql<AccessInviteKind>`${row.kind}`.as("kind"),
    state: sql<"pending" | "leased" | "redeemed" | "revoked">`${row.state ?? "pending"}`.as("state"),
    label: sql<string | null>`${row.label ?? null}`.as("label"),
    createdBy: sql<string | null>`${row.createdBy ?? null}`.as("created_by"),
    createdAt: sql<number>`${row.createdAt}`.as("created_at"),
    expiresAt: sql<number>`${row.expiresAt}`.as("expires_at"),
    leaseId: sql<string | null>`${row.leaseId ?? null}`.as("lease_id"),
    leasedAt: sql<number | null>`${row.leasedAt ?? null}`.as("leased_at"),
    leaseExpiresAt: sql<number | null>`${row.leaseExpiresAt ?? null}`.as("lease_expires_at"),
    redeemerUserId: sql<string | null>`${row.redeemerUserId ?? null}`.as("redeemer_user_id"),
    redeemerGithubAccountId: sql<string | null>`${row.redeemerGithubAccountId ?? null}`.as("redeemer_github_account_id"),
    redeemerGithubUsername: sql<string | null>`${row.redeemerGithubUsername ?? null}`.as("redeemer_github_username"),
    redeemedAt: sql<number | null>`${row.redeemedAt ?? null}`.as("redeemed_at"),
    revokedBy: sql<string | null>`${row.revokedBy ?? null}`.as("revoked_by"),
    revocationReason: sql<string | null>`${row.revocationReason ?? null}`.as("revocation_reason"),
    revokedAt: sql<number | null>`${row.revokedAt ?? null}`.as("revoked_at"),
    replacesInviteId: sql<string | null>`${row.replacesInviteId ?? null}`.as("replaces_invite_id"),
    replacesInviteVersion: sql<number | null>`${row.replacesInviteVersion ?? null}`.as("replaces_invite_version"),
    replacedByInviteId: sql<string | null>`${row.replacedByInviteId ?? null}`.as("replaced_by_invite_id"),
    version: sql<number>`${row.version ?? 1}`.as("version"),
    updatedAt: sql<number>`${row.updatedAt}`.as("updated_at"),
  };
}

function accessEvent(params: {
  eventType: AccessEventType;
  inviteId?: string | null;
  subjectUserId?: string | null;
  githubAccountId?: string | null;
  actorUserId?: string | null;
  revocationId?: string | null;
  cleanupAttemptId?: string | null;
  reason?: string | null;
  createdAt: number;
}): AccessEventInsertRow {
  return {
    id: createAppId(),
    eventType: params.eventType,
    inviteId: params.inviteId ?? null,
    subjectUserId: params.subjectUserId ?? null,
    githubAccountId: params.githubAccountId ?? null,
    actorUserId: params.actorUserId ?? null,
    revocationId: params.revocationId ?? null,
    cleanupAttemptId: params.cleanupAttemptId ?? null,
    reason: params.reason ?? null,
    createdAt: params.createdAt,
  };
}

function accessEventInsertFields(event: AccessEventInsertRow) {
  return {
    id: sql<string>`${event.id}`.as("id"),
    eventType: sql<AccessEventType>`${event.eventType}`.as("event_type"),
    inviteId: sql<string | null>`${event.inviteId ?? null}`.as("invite_id"),
    subjectUserId: sql<string | null>`${event.subjectUserId ?? null}`.as("subject_user_id"),
    githubAccountId: sql<string | null>`${event.githubAccountId ?? null}`.as("github_account_id"),
    actorUserId: sql<string | null>`${event.actorUserId ?? null}`.as("actor_user_id"),
    revocationId: sql<string | null>`${event.revocationId ?? null}`.as("revocation_id"),
    cleanupAttemptId: sql<string | null>`${event.cleanupAttemptId ?? null}`.as("cleanup_attempt_id"),
    reason: sql<string | null>`${event.reason ?? null}`.as("reason"),
    createdAt: sql<number>`${event.createdAt}`.as("created_at"),
  };
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

async function githubAccountBelongsToUser(
  d1: D1Database,
  githubAccountId: string,
  userId: string,
): Promise<boolean> {
  const rows = await drizzle(d1)
    .select({ id: account.id })
    .from(account)
    .where(
      and(
        eq(account.providerId, "github"),
        eq(account.accountId, githubAccountId),
        eq(account.userId, userId),
      ),
    )
    .limit(1);
  return rows.length === 1;
}

async function requiresFreshInvite(
  d1: D1Database,
  inviteId: string,
  userId: string,
): Promise<boolean> {
  const rows = await drizzle(d1)
    .select({ id: accessEvents.id })
    .from(accessEvents)
    .innerJoin(accessInviteCodes, eq(accessInviteCodes.id, inviteId))
    .where(
      and(
        eq(accessEvents.eventType, "access.reinvite_allowed"),
        eq(accessEvents.subjectUserId, userId),
        sql`${accessEvents.createdAt} >= ${accessInviteCodes.createdAt}`,
      ),
    )
    .limit(1);
  return rows.length === 1;
}

async function generateAccessInviteCode(): Promise<{
  code: string;
  hash: string;
  prefix: string;
}> {
  const random = crypto.getRandomValues(new Uint8Array(INVITE_RANDOM_BYTES));
  const binary = String.fromCharCode(...random);
  const body = btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  const code = `${INVITE_TOKEN_PREFIX}${body}`;
  return {
    code,
    hash: await hashAccessInviteCode(code),
    prefix: `${INVITE_TOKEN_PREFIX}${body.slice(0, SAFE_PREFIX_BODY_LENGTH)}`,
  };
}

function isAccessInviteCode(code: string): boolean {
  return new RegExp(`^${INVITE_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`, "u").test(
    code,
  );
}

function normalizeLabel(value?: string | null): string | null {
  const label = value?.trim() || null;
  if (label && !LABEL_PATTERN.test(label)) {
    throw appError(
      400,
      "invalid_access_invite_label",
      "invite label must be 1-80 characters and cannot contain addresses or links",
    );
  }
  return label;
}

function validReason(value: string): string {
  const reason = value.trim();
  if (!REASON_PATTERN.test(reason)) {
    throw appError(
      400,
      "invalid_access_reason",
      "reason must be a lowercase reason code",
    );
  }
  return reason;
}

function validId(value: string, kind: string): string {
  const id = value.trim();
  if (!id || id.length > ID_MAX_LENGTH) {
    throw appError(
      400,
      `invalid_${kind.replaceAll(" ", "_")}_id`,
      `invalid ${kind} id`,
    );
  }
  return id;
}

function optionalId(
  value: string | null | undefined,
  kind: string,
): string | null {
  return value == null ? null : validId(value, kind);
}

function validVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw appError(
      400,
      "invalid_access_invite_version",
      "a positive invite version is required",
    );
  }
  return value;
}

function validTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw appError(500, "invalid_timestamp", "invalid storage timestamp");
  }
  return value;
}

function boundedLimit(value = 200): number {
  if (!Number.isSafeInteger(value) || value <= 0) return 200;
  return Math.min(value, 500);
}

function unavailableInvite() {
  return appError(
    404,
    "access_invite_unavailable",
    "the invite is invalid or unavailable",
  );
}

function invalidLease() {
  return appError(
    409,
    "access_invite_lease_invalid",
    "the invite lease is invalid or expired",
  );
}

function staleInvite() {
  return appError(
    409,
    "access_invite_stale_version",
    "the invite changed; refresh and retry",
  );
}

function inviteIssuerForbidden() {
  return appError(
    403,
    "access_invite_issuer_forbidden",
    "active beta administrator access is required to issue an invite",
  );
}

function inviteRevokerForbidden() {
  return appError(
    403,
    "access_invite_revoker_forbidden",
    "active beta administrator access is required to revoke an invite",
  );
}

function inviteRemoverForbidden() {
  return appError(
    403,
    "access_invite_remover_forbidden",
    "active beta administrator access is required to remove an invite",
  );
}

async function hasInviteRemoval(
  d1: D1Database,
  inviteId: string,
): Promise<boolean> {
  const row = await drizzle(d1)
    .select({ inviteId: accessInviteRemovals.inviteId })
    .from(accessInviteRemovals)
    .where(eq(accessInviteRemovals.inviteId, inviteId))
    .limit(1);
  return row[0]?.inviteId === inviteId;
}

function betaAdministratorForbidden() {
  return appError(
    403,
    "beta_admin_authority_required",
    "active beta administrator access is required",
  );
}
