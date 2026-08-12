import { and, desc, eq, inArray, isNull, notExists } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  accessAllowlist,
  accessEvents,
  accessInviteCodes,
  accessInviteRemovals,
  type AccessInviteKind,
} from "@/db/schema/application";
import { user } from "@/db/schema/core";
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

  try {
    const inserted = await drizzle(params.d1)
      .insert(accessInviteCodes)
      .values(row)
      .returning();
    return { ...toInviteSummary(inserted[0]!), code: generated.code };
  } catch (error) {
    if (isInviteAdministratorGuardError(error)) {
      throw inviteIssuerForbidden();
    }
    throw error;
  }
}

export async function listAccessInvites(params: {
  d1: D1Database;
  limit?: number;
}): Promise<AccessInviteSummary[]> {
  const limit = boundedLimit(params.limit);
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
  return rows.map(toInviteSummary);
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
  const leased = await params.d1
    .prepare(
      `UPDATE access_invite_codes
       SET state = 'leased',
           lease_id = ?,
           leased_at = ?,
           lease_expires_at = ?,
           version = version + 1,
           updated_at = ?
       WHERE id = ?
         AND expires_at > ?
         AND (
           state = 'pending'
           OR (state = 'leased' AND lease_expires_at <= ?)
         )
       RETURNING id AS inviteId,
                 lease_id AS leaseId,
                 kind,
                 lease_expires_at AS leaseExpiresAt,
                 expires_at AS inviteExpiresAt,
                 version`,
    )
    .bind(leaseId, now, leaseExpiresAt, now, inviteId, now, now)
    .first<AccessInviteLease>();
  if (leased) return leased;

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
  const result = await params.d1
    .prepare(
      `UPDATE access_invite_codes
       SET state = 'pending',
           lease_id = NULL,
           leased_at = NULL,
           lease_expires_at = NULL,
           version = version + 1,
           updated_at = ?
       WHERE id = ?
         AND state = 'leased'
         AND lease_id = ?`,
    )
    .bind(
      now,
      validId(params.inviteId, "invite"),
      validId(params.leaseId, "lease"),
    )
    .run();
  return result.meta.changes === 1;
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
    replacesInviteId: validId(params.inviteId, "invite"),
    replacesInviteVersion: validVersion(params.expectedVersion),
    version: 1,
    updatedAt: now,
  };
  try {
    const inserted = await drizzle(params.d1)
      .insert(accessInviteCodes)
      .values(row)
      .returning();
    return { ...toInviteSummary(inserted[0]!), code: generated.code };
  } catch (error) {
    if (isInviteAdministratorGuardError(error)) {
      throw inviteIssuerForbidden();
    }
    if (
      errorChainMatches(
        error,
        /replacement lost its version race|only an administrator can replace/i,
      )
    ) {
      throw staleInvite();
    }
    throw error;
  }
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
  try {
    const updated = await db
      .update(accessInviteCodes)
      .set({
        state: "revoked",
        leaseId: null,
        leasedAt: null,
        leaseExpiresAt: null,
        revokedBy: validId(params.actorUserId, "actor"),
        revocationReason: validReason(params.reason),
        revokedAt: now,
        version: expectedVersion + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(accessInviteCodes.id, inviteId),
          eq(accessInviteCodes.version, expectedVersion),
          inArray(accessInviteCodes.state, ["pending", "leased"]),
        ),
      )
      .returning();
    const row = updated[0];
    if (row && row.state === "revoked") return toInviteSummary(row);
  } catch (error) {
    if (isInviteRevokerGuardError(error)) throw inviteRevokerForbidden();
    throw error;
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

  try {
    const inserted = await db
      .insert(accessInviteRemovals)
      .values({
        inviteId,
        inviteVersion: expectedVersion,
        removedBy: actorUserId,
        removedAt: now,
      })
      .returning({ inviteId: accessInviteRemovals.inviteId });
    if (inserted[0]?.inviteId === inviteId) return;

    // The database command is idempotent and ignores a repeated insert after
    // re-checking administrator authority.
    if (await hasInviteRemoval(params.d1, inviteId)) return;
  } catch (error) {
    if (isInviteRemoverGuardError(error)) throw inviteRemoverForbidden();
    if (!errorChainMatches(error, /invite removal lost its version race/i)) {
      throw error;
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
  const invite = (
    await db
      .select({
        id: accessInviteCodes.id,
        kind: accessInviteCodes.kind,
        createdBy: accessInviteCodes.createdBy,
      })
      .from(accessInviteCodes)
      .where(
        and(
          eq(accessInviteCodes.id, inviteId),
          eq(accessInviteCodes.state, "leased"),
          eq(accessInviteCodes.leaseId, leaseId),
        ),
      )
      .limit(1)
  )[0];
  if (!invite) throw invalidLease();

  const value: typeof accessAllowlist.$inferInsert = {
    userId,
    state: "active",
    githubAccountId,
    githubUsername,
    sourceInviteId: inviteId,
    sourceLeaseId: leaseId,
    grantedBy: invite.createdBy,
    grantReason: invite.kind,
    grantedAt: now,
  };
  try {
    // Deliberately one plain INSERT. The D1 trigger performs the invitation
    // CAS; conflict helpers such as INSERT OR IGNORE would break atomicity.
    const inserted = await db.insert(accessAllowlist).values(value).returning();
    return toBetaUserSummary(inserted[0]!, null, null);
  } catch (error) {
    if (
      !errorChainMatches(
        error,
        /invite lease is invalid|does not belong|fresh beta invite required|unique constraint failed:\s*access_allowlist\.(?:user_id|github_account_id|source_invite_id)/i,
      )
    ) {
      throw error;
    }
    const freshInviteRequired = errorChainMatches(
      error,
      /fresh beta invite required/i,
    );
    const reason = errorChainMatches(error, /does not belong/i)
      ? "identity_mismatch"
      : "claim_conflict";
    await recordAccessFailure({
      d1: params.d1,
      eventType: "invite.claim_failed",
      inviteId,
      subjectUserId: userId,
      githubAccountId,
      reason,
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
  const revocationId = createAppId();
  try {
    const updated = await db
      .update(accessAllowlist)
      .set({
        state: "blocked",
        revocationId,
        revokedBy: validId(params.actorUserId, "actor"),
        revocationReason: validReason(params.reason),
        revokedAt: now,
        revocationCleanupCompletedAt: null,
      })
      .where(
        and(
          eq(accessAllowlist.userId, userId),
          eq(accessAllowlist.state, "active"),
        ),
      )
      .returning();
    if (!updated[0]) {
      throw appError(
        409,
        "beta_user_not_active",
        "the beta user is not active",
      );
    }
    return {
      user: toBetaUserSummary(updated[0], null, null),
      revocationId,
    };
  } catch (error) {
    if (isBetaAdministratorGuardError(error)) {
      throw betaAdministratorForbidden();
    }
    if (errorChainMatches(error, /last active beta administrator/i)) {
      throw appError(
        409,
        "last_beta_admin",
        "the last active beta administrator cannot be revoked",
      );
    }
    throw error;
  }
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
  const updated = await db
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
    .returning();
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
  const recorded = await params.d1
    .prepare(
      `INSERT INTO access_events (
         id, event_type, invite_id, subject_user_id, github_account_id,
         actor_user_id, revocation_id, cleanup_attempt_id, reason, created_at
       )
       SELECT ?, 'access.revocation_cleanup_failed', source_invite_id, user_id,
              github_account_id, ?, revocation_id, ?, ?, ?
       FROM access_allowlist
       WHERE user_id = ?
         AND state = 'blocked'
         AND revocation_id = ?
         AND revocation_cleanup_attempt_id = ?
         AND revocation_cleanup_started_at IS NOT NULL
         AND revocation_cleanup_completed_at IS NULL
       RETURNING id`,
    )
    .bind(
      eventId,
      optionalId(params.actorUserId, "actor"),
      cleanupAttemptId,
      validReason(params.reason),
      now,
      userId,
      revocationId,
      cleanupAttemptId,
    )
    .first<{ id: string }>();
  if (recorded?.id === eventId) return;

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
  const recorded = await params.d1
    .prepare(
      `INSERT INTO access_events (
         id, event_type, invite_id, subject_user_id, github_account_id,
         actor_user_id, revocation_id, cleanup_attempt_id, reason, created_at
       )
       SELECT ?, 'access.revocation_cleanup_stalled', source_invite_id, user_id,
              github_account_id, ?, revocation_id, ?, ?, ?
       FROM access_allowlist
       WHERE user_id = ?
         AND state = 'blocked'
         AND revocation_id = ?
         AND revocation_cleanup_attempt_id = ?
         AND revocation_cleanup_started_at IS NOT NULL
         AND revocation_cleanup_completed_at IS NULL
       RETURNING id`,
    )
    .bind(
      eventId,
      optionalId(params.actorUserId, "actor"),
      cleanupAttemptId,
      validReason(params.reason),
      now,
      userId,
      revocationId,
      cleanupAttemptId,
    )
    .first<{ id: string }>();
  if (recorded?.id === eventId) return;

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
  try {
    // The event trigger deletes only the exact blocked row after cleanup has
    // completed. The audit append and block clear therefore share one D1
    // statement and cannot split under a race or lost response.
    await drizzle(params.d1)
      .insert(accessEvents)
      .values({
        id: createAppId(),
        eventType: "access.reinvite_allowed",
        subjectUserId: validId(params.userId, "user"),
        actorUserId: validId(params.actorUserId, "actor"),
        revocationId: validId(params.revocationId, "revocation"),
        reason: "admin_cleared_block",
        createdAt: now,
      });
  } catch (error) {
    if (isBetaAdministratorGuardError(error)) {
      throw betaAdministratorForbidden();
    }
    if (errorChainMatches(error, /block is stale|block-clear/i)) {
      throw appError(
        409,
        "beta_revocation_cleanup_incomplete",
        "revocation cleanup must complete before another invite is allowed",
      );
    }
    throw error;
  }
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

function isInviteAdministratorGuardError(error: unknown): boolean {
  return errorChainMatches(
    error,
    /access invite (?:issuer|revoker) must be an active unbanned administrator/i,
  );
}

function isInviteRevokerGuardError(error: unknown): boolean {
  return errorChainMatches(
    error,
    /access invite revoker must be an active unbanned administrator/i,
  );
}

function isInviteRemoverGuardError(error: unknown): boolean {
  return errorChainMatches(
    error,
    /access invite remover must be an active unbanned administrator/i,
  );
}

function isBetaAdministratorGuardError(error: unknown): boolean {
  return errorChainMatches(
    error,
    /(?:beta access revoker|beta block-clear actor) must be an active unbanned administrator/i,
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
