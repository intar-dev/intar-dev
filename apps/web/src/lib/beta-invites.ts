import { and, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { timingSafeEqual } from "node:crypto";
import {
  accessAllowlist,
  accessEvents,
  accessInviteCodes,
  type AccessEventType,
} from "@/db/schema/application";
import { account, user } from "@/db/schema/core";
import {
  decryptAccessInviteToken,
  encryptAccessInviteToken,
} from "@/lib/access-invite-token";
import { appError, errorChainMatches } from "@/lib/app-error";
import { isValidGithubUsername } from "@/lib/github-username";
import { createAppId } from "@/lib/id";

export const BETA_INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
const LEGACY_INVITE_STORAGE_LIFETIME_MS = 14 * 24 * 60 * 60 * 1_000;

const TOKEN_PREFIX = "intar_beta_";
const TOKEN_BYTES = 32;
const SAFE_PREFIX_LENGTH = 8;
const ID_MAX_LENGTH = 255;

type InviteRow = typeof accessInviteCodes.$inferSelect;
type ClaimableInviteRow = InviteRow & {
  claimExpiresAt: number;
  kind: "standard";
  state: "pending";
  tokenCiphertext: string;
};
type AllowlistRow = typeof accessAllowlist.$inferSelect;

export type BetaInviteState = "active" | "expired" | "redeemed" | "revoked";

export interface BetaInviteSummary {
  id: string;
  codePrefix: string;
  state: BetaInviteState;
  createdAt: number;
  expiresAt: number;
  completedAt: number | null;
  redeemerGithubUsername: string | null;
  version: number;
}

export interface BetaInviteAttempt {
  inviteId: string;
  codePrefix: string;
  expiresAt: number;
  version: number;
}

export interface BetaUserSummary {
  userId: string;
  name: string | null;
  role: string | null;
  state: "active" | "revoked";
  githubAccountId: string;
  githubUsername: string;
  sourceInviteId: string;
  grantedAt: number;
  revokedAt: number | null;
  revocationCleanupCompletedAt: number | null;
}

export async function createBetaInvite(params: {
  d1: D1Database;
  actorUserId: string;
  encryptionKey: string | undefined;
  now?: number;
}): Promise<BetaInviteSummary & { code: string }> {
  const now = validTimestamp(params.now ?? Date.now());
  const actorUserId = validId(params.actorUserId, "actor");
  const generated = await generateToken();
  const id = createAppId();
  const tokenCiphertext = await encryptAccessInviteToken({
    encryptionKey: params.encryptionKey,
    token: generated.code,
    identity: { inviteId: id, codeHash: generated.hash, createdAt: now },
  });
  const row: typeof accessInviteCodes.$inferInsert = {
    id,
    codeHash: generated.hash,
    codePrefix: generated.prefix,
    tokenCiphertext,
    kind: "standard",
    state: "pending",
    label: null,
    createdBy: actorUserId,
    createdAt: now,
    expiresAt: now + LEGACY_INVITE_STORAGE_LIFETIME_MS,
    claimExpiresAt: now + BETA_INVITE_LIFETIME_MS,
    version: 1,
    updatedAt: now,
  };
  const event = eventRow({
    eventType: "invite.created",
    inviteId: id,
    actorUserId,
    reason: "standard",
    createdAt: now,
  });
  const db = drizzle(params.d1);
  const [inserted] = await db.batch([
    db
      .insert(accessInviteCodes)
      .select(
        db
          .select(inviteInsertFields(row))
          .from(sql`(select 1) as command_source`)
          .where(activeAdministratorPredicate(actorUserId)),
      )
      .returning(),
    db.insert(accessEvents).select(
      db
        .select(eventInsertFields(event))
        .from(accessInviteCodes)
        .where(eq(accessInviteCodes.id, id)),
    ),
  ]);
  const created = inserted[0];
  if (!created) throw administratorRequired("create an invite");
  return { ...toSummary(created, now), code: generated.code };
}

export async function listBetaInvites(params: {
  d1: D1Database;
  limit?: number;
  now?: number;
}): Promise<BetaInviteSummary[]> {
  const now = validTimestamp(params.now ?? Date.now());
  const rows = await drizzle(params.d1)
    .select()
    .from(accessInviteCodes)
    .orderBy(desc(accessInviteCodes.createdAt))
    .limit(boundedLimit(params.limit));
  return rows.map((row) => toSummary(row, now));
}

export async function inspectBetaInviteCode(params: {
  d1: D1Database;
  code: string;
  now?: number;
}): Promise<BetaInviteAttempt> {
  const now = validTimestamp(params.now ?? Date.now());
  if (!isInviteCode(params.code)) {
    await recordInviteFailure(params.d1, {
      eventType: "invite.exchange_failed",
      reason: "invalid_code",
      createdAt: now,
    });
    throw unavailableInvite();
  }
  const hash = await hashBetaInviteCode(params.code);
  const row = await drizzle(params.d1)
    .select()
    .from(accessInviteCodes)
    .where(eq(accessInviteCodes.codeHash, hash))
    .limit(1)
    .then((rows) => rows[0]);
  if (!isClaimable(row, now)) {
    await recordInviteFailure(params.d1, {
      eventType: "invite.exchange_failed",
      ...(row ? { inviteId: row.id } : {}),
      reason: row && effectiveExpiry(row) <= now ? "expired" : "unavailable",
      createdAt: now,
    });
    throw unavailableInvite();
  }
  return toAttempt(row);
}

export async function getBetaInvite(params: {
  d1: D1Database;
  inviteId: string;
  now?: number;
}): Promise<BetaInviteAttempt> {
  const now = validTimestamp(params.now ?? Date.now());
  const inviteId = validId(params.inviteId, "invite");
  const row = await drizzle(params.d1)
    .select()
    .from(accessInviteCodes)
    .where(eq(accessInviteCodes.id, inviteId))
    .limit(1)
    .then((rows) => rows[0]);
  if (!isClaimable(row, now)) throw unavailableInvite();
  return toAttempt(row);
}

export async function getBetaInviteStatus(params: {
  d1: D1Database;
  inviteId: string;
  now?: number;
}): Promise<BetaInviteSummary | null> {
  const now = validTimestamp(params.now ?? Date.now());
  const inviteId = validId(params.inviteId, "invite");
  const row = await drizzle(params.d1)
    .select()
    .from(accessInviteCodes)
    .where(eq(accessInviteCodes.id, inviteId))
    .limit(1)
    .then((rows) => rows[0]);
  return row ? toSummary(row, now) : null;
}

export async function copyBetaInvite(params: {
  d1: D1Database;
  inviteId: string;
  expectedVersion: number;
  actorUserId: string;
  encryptionKey: string | undefined;
  now?: number;
}): Promise<string> {
  const now = validTimestamp(params.now ?? Date.now());
  const inviteId = validId(params.inviteId, "invite");
  const actorUserId = validId(params.actorUserId, "actor");
  const expectedVersion = validVersion(params.expectedVersion);
  const db = drizzle(params.d1);
  const row = await db
    .select()
    .from(accessInviteCodes)
    .where(
      and(
        eq(accessInviteCodes.id, inviteId),
        eq(accessInviteCodes.version, expectedVersion),
      ),
    )
    .limit(1)
    .then((rows) => rows[0]);
  if (!isClaimable(row, now) || !row.tokenCiphertext) {
    throw unavailableInvite();
  }
  const token = await decryptAccessInviteToken({
    encryptionKey: params.encryptionKey,
    ciphertext: row.tokenCiphertext,
    identity: {
      inviteId: row.id,
      codeHash: row.codeHash,
      createdAt: row.createdAt,
    },
  });
  const observedHash = await hashBetaInviteCode(token);
  if (
    !timingSafeEqual(
      new TextEncoder().encode(observedHash),
      new TextEncoder().encode(row.codeHash),
    )
  ) {
    throw appError(
      503,
      "access_invite_token_corrupt",
      "the beta invite link cannot be copied",
    );
  }
  const event = await db
    .insert(accessEvents)
    .select(
      db
        .select(
          eventInsertFields(
            eventRow({
              eventType: "invite.copied",
              inviteId,
              actorUserId,
              reason: "admin_copy",
              createdAt: now,
            }),
          ),
        )
        .from(accessInviteCodes)
        .where(
          and(
            eq(accessInviteCodes.id, inviteId),
            eq(accessInviteCodes.state, "pending"),
            eq(accessInviteCodes.version, expectedVersion),
            sql`${accessInviteCodes.tokenCiphertext} is not null`,
            sql`${accessInviteCodes.claimExpiresAt} > ${now}`,
            activeAdministratorPredicate(actorUserId),
          ),
        ),
    )
    .returning({ id: accessEvents.id });
  if (!event[0]) throw administratorRequired("copy an invite");
  return token;
}

export async function revokeBetaInvite(params: {
  d1: D1Database;
  inviteId: string;
  expectedVersion: number;
  actorUserId: string;
  now?: number;
}): Promise<BetaInviteSummary> {
  const db = drizzle(params.d1);
  const now = validTimestamp(params.now ?? Date.now());
  const inviteId = validId(params.inviteId, "invite");
  const expectedVersion = validVersion(params.expectedVersion);
  const actorUserId = validId(params.actorUserId, "actor");
  const reason = "admin_revoked";
  const [updated] = await db.batch([
    db
      .update(accessInviteCodes)
      .set({
        state: "revoked",
        tokenCiphertext: null,
        revokedBy: actorUserId,
        revocationReason: reason,
        revokedAt: now,
        version: expectedVersion + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(accessInviteCodes.id, inviteId),
          eq(accessInviteCodes.state, "pending"),
          eq(accessInviteCodes.version, expectedVersion),
          sql`${accessInviteCodes.tokenCiphertext} is not null`,
          activeAdministratorPredicate(actorUserId),
        ),
      )
      .returning(),
    db.insert(accessEvents).select(
      db
        .select(
          eventInsertFields(
            eventRow({
              eventType: "invite.revoked",
              inviteId,
              actorUserId,
              reason,
              createdAt: now,
            }),
          ),
        )
        .from(accessInviteCodes)
        .where(
          and(
            eq(accessInviteCodes.id, inviteId),
            eq(accessInviteCodes.state, "revoked"),
            eq(accessInviteCodes.version, expectedVersion + 1),
            eq(accessInviteCodes.revokedAt, now),
          ),
        ),
    ),
  ]);
  const row = updated[0];
  if (row) return toSummary(row, now);
  if (!(await isActiveAdministrator(params.d1, actorUserId))) {
    throw administratorRequired("revoke an invite");
  }
  throw staleInvite();
}

export async function redeemBetaInvite(params: {
  d1: D1Database;
  inviteId: string;
  attemptId: string;
  userId: string;
  githubAccountId: string;
  githubUsername: string;
  now?: number;
}): Promise<BetaUserSummary> {
  const now = validTimestamp(params.now ?? Date.now());
  const inviteId = validId(params.inviteId, "invite");
  const attemptId = validId(params.attemptId, "attempt");
  const userId = validId(params.userId, "user");
  const githubAccountId = validId(params.githubAccountId, "GitHub account");
  const githubUsername = params.githubUsername.trim();
  if (!isValidGithubUsername(githubUsername)) {
    throw appError(400, "invalid_github_username", "GitHub identity is invalid");
  }
  const db = drizzle(params.d1);
  const grantEventId = createAppId();
  const redeemedEventId = createAppId();
  try {
    const [admitted, redeemed] = await db.batch([
      db
        .insert(accessAllowlist)
        .select(
          db
            .select({
              userId: sql<string>`${userId}`.as("user_id"),
              state: sql<"active">`'active'`.as("state"),
              githubAccountId: sql<string>`${githubAccountId}`.as(
                "github_account_id",
              ),
              githubUsername: sql<string>`${githubUsername}`.as(
                "github_username",
              ),
              sourceInviteId: accessInviteCodes.id,
              sourceLeaseId: sql<string>`${attemptId}`.as("source_lease_id"),
              grantedBy: accessInviteCodes.createdBy,
              grantReason: sql<string>`'invite'`.as("grant_reason"),
              grantedAt: sql<number>`${now}`.as("granted_at"),
              revocationId: sql<string | null>`null`.as("revocation_id"),
              revokedBy: sql<string | null>`null`.as("revoked_by"),
              revocationReason: sql<string | null>`null`.as(
                "revocation_reason",
              ),
              revokedAt: sql<number | null>`null`.as("revoked_at"),
              revocationCleanupAttemptId: sql<string | null>`null`.as(
                "revocation_cleanup_attempt_id",
              ),
              revocationCleanupStartedAt: sql<number | null>`null`.as(
                "revocation_cleanup_started_at",
              ),
              revocationCleanupCompletedAt: sql<number | null>`null`.as(
                "revocation_cleanup_completed_at",
              ),
            })
            .from(accessInviteCodes)
            .where(
              and(
                eq(accessInviteCodes.id, inviteId),
                eq(accessInviteCodes.state, "pending"),
                sql`${accessInviteCodes.tokenCiphertext} is not null`,
                sql`${accessInviteCodes.claimExpiresAt} > ${now}`,
                sql`exists (
                  select 1 from ${account}
                  where ${account.providerId} = 'github'
                    and ${account.accountId} = ${githubAccountId}
                    and ${account.userId} = ${userId}
                )`,
              ),
            ),
        )
        .onConflictDoUpdate({
          target: accessAllowlist.userId,
          set: {
            state: "active",
            githubAccountId,
            githubUsername,
            sourceInviteId: inviteId,
            sourceLeaseId: attemptId,
            grantedBy: sql`excluded.granted_by`,
            grantReason: "invite",
            grantedAt: now,
            revocationId: null,
            revokedBy: null,
            revocationReason: null,
            revokedAt: null,
            revocationCleanupAttemptId: null,
            revocationCleanupStartedAt: null,
            revocationCleanupCompletedAt: null,
          },
          setWhere: sql`${accessAllowlist.state} = 'blocked'
            AND ${accessAllowlist.githubAccountId} = ${githubAccountId}
            AND ${accessAllowlist.revocationCleanupCompletedAt} is not null`,
        })
        .returning(),
      db
        .update(accessInviteCodes)
        .set({
          state: "redeemed",
          tokenCiphertext: null,
          leaseId: attemptId,
          leasedAt: now,
          leaseExpiresAt: now + 600_000,
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
            eq(accessInviteCodes.state, "pending"),
            sql`${accessInviteCodes.tokenCiphertext} is not null`,
            sql`${accessInviteCodes.claimExpiresAt} > ${now}`,
            sql`exists (
              select 1 from ${accessAllowlist}
              where ${accessAllowlist.userId} = ${userId}
                and ${accessAllowlist.state} = 'active'
                and ${accessAllowlist.githubAccountId} = ${githubAccountId}
                and ${accessAllowlist.sourceInviteId} = ${inviteId}
                and ${accessAllowlist.sourceLeaseId} = ${attemptId}
                and ${accessAllowlist.grantedAt} = ${now}
            )`,
          ),
        )
        .returning({ id: accessInviteCodes.id }),
      db.insert(accessEvents).select(
        db
          .select({
            id: sql<string>`${redeemedEventId}`.as("id"),
            eventType: sql<AccessEventType>`'invite.redeemed'`.as("event_type"),
            inviteId: accessInviteCodes.id,
            subjectUserId: accessInviteCodes.redeemerUserId,
            githubAccountId: accessInviteCodes.redeemerGithubAccountId,
            actorUserId: accessInviteCodes.redeemerUserId,
            revocationId: sql<string | null>`null`.as("revocation_id"),
            cleanupAttemptId: sql<string | null>`null`.as("cleanup_attempt_id"),
            runId: sql<string | null>`null`.as("run_id"),
            reason: sql<string | null>`null`.as("reason"),
            createdAt: accessInviteCodes.redeemedAt,
          })
          .from(accessInviteCodes)
          .where(
            and(
              eq(accessInviteCodes.id, inviteId),
              eq(accessInviteCodes.state, "redeemed"),
              eq(accessInviteCodes.redeemedAt, now),
            ),
          ),
      ),
      db.insert(accessEvents).select(
        db
          .select({
            id: sql<string>`${grantEventId}`.as("id"),
            eventType: sql<AccessEventType>`'access.granted'`.as("event_type"),
            inviteId: accessAllowlist.sourceInviteId,
            subjectUserId: accessAllowlist.userId,
            githubAccountId: accessAllowlist.githubAccountId,
            actorUserId: accessAllowlist.grantedBy,
            revocationId: sql<string | null>`null`.as("revocation_id"),
            cleanupAttemptId: sql<string | null>`null`.as("cleanup_attempt_id"),
            runId: sql<string | null>`null`.as("run_id"),
            reason: accessAllowlist.grantReason,
            createdAt: accessAllowlist.grantedAt,
          })
          .from(accessAllowlist)
          .where(
            and(
              eq(accessAllowlist.userId, userId),
              eq(accessAllowlist.state, "active"),
              eq(accessAllowlist.sourceInviteId, inviteId),
              eq(accessAllowlist.sourceLeaseId, attemptId),
              eq(accessAllowlist.grantedAt, now),
            ),
          ),
      ),
    ]);
    if (admitted[0] && redeemed[0]?.id === inviteId) {
      return toBetaUserSummary(admitted[0], null, null);
    }
  } catch (error) {
    if (
      !errorChainMatches(
        error,
        /unique constraint failed:\s*access_allowlist\.(?:github_account_id|source_invite_id)/iu,
      )
    ) {
      throw error;
    }
  }

  const identityMatches = await githubAccountBelongsToUser(
    params.d1,
    githubAccountId,
    userId,
  );
  await recordInviteFailure(params.d1, {
    eventType: "invite.claim_failed",
    inviteId,
    subjectUserId: userId,
    githubAccountId,
    reason: identityMatches ? "claim_conflict" : "identity_mismatch",
    createdAt: now,
  });
  const blocked = await drizzle(params.d1)
    .select({ completedAt: accessAllowlist.revocationCleanupCompletedAt })
    .from(accessAllowlist)
    .where(
      and(
        eq(accessAllowlist.userId, userId),
        eq(accessAllowlist.state, "blocked"),
      ),
    )
    .limit(1);
  if (blocked[0]?.completedAt == null && blocked.length > 0) {
    throw appError(
      409,
      "beta_revocation_cleanup_incomplete",
      "access cleanup is still running; try this invite again shortly",
    );
  }
  throw appError(409, "access_invite_claim_conflict", "the invite was already used");
}

export async function listBetaUsers(params: {
  d1: D1Database;
  limit?: number;
}): Promise<BetaUserSummary[]> {
  const rows = await drizzle(params.d1)
    .select({ access: accessAllowlist, name: user.name, role: user.role })
    .from(accessAllowlist)
    .leftJoin(user, eq(user.id, accessAllowlist.userId))
    .orderBy(desc(accessAllowlist.grantedAt))
    .limit(boundedLimit(params.limit));
  return rows.map(({ access, name, role }) =>
    toBetaUserSummary(access, name, role),
  );
}

export async function hashBetaInviteCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(code),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function toSummary(row: InviteRow, now: number): BetaInviteSummary {
  let state: BetaInviteState;
  if (row.state === "redeemed") state = "redeemed";
  else if (row.state === "revoked") state = "revoked";
  else if (row.state === "pending" && row.tokenCiphertext) {
    state = effectiveExpiry(row) <= now ? "expired" : "active";
  } else {
    // Pending/leased rows without a ciphertext are legacy links revoked by
    // the simplified-system cutover. They remain visible only in History.
    state = "revoked";
  }
  const completedAt =
    state === "redeemed"
      ? row.redeemedAt
      : state === "revoked"
        ? (row.revokedAt ?? row.updatedAt)
        : state === "expired"
          ? effectiveExpiry(row)
          : null;
  return {
    id: row.id,
    codePrefix: row.codePrefix,
    state,
    createdAt: row.createdAt,
    expiresAt: effectiveExpiry(row),
    completedAt,
    redeemerGithubUsername: row.redeemerGithubUsername,
    version: row.version,
  };
}

function toAttempt(row: InviteRow): BetaInviteAttempt {
  return {
    inviteId: row.id,
    codePrefix: row.codePrefix,
    expiresAt: effectiveExpiry(row),
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
    state: row.state === "active" ? "active" : "revoked",
    githubAccountId: row.githubAccountId,
    githubUsername: row.githubUsername,
    sourceInviteId: row.sourceInviteId,
    grantedAt: row.grantedAt,
    revokedAt: row.revokedAt,
    revocationCleanupCompletedAt: row.revocationCleanupCompletedAt,
  };
}

function isClaimable(
  row: InviteRow | undefined,
  now: number,
): row is ClaimableInviteRow {
  return Boolean(
    row &&
      row.kind === "standard" &&
      row.state === "pending" &&
      row.tokenCiphertext &&
      row.claimExpiresAt != null &&
      row.claimExpiresAt > now,
  );
}

async function generateToken(): Promise<{
  code: string;
  hash: string;
  prefix: string;
}> {
  const random = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  let binary = "";
  for (const byte of random) binary += String.fromCharCode(byte);
  const body = btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  const code = `${TOKEN_PREFIX}${body}`;
  return {
    code,
    hash: await hashBetaInviteCode(code),
    prefix: `${TOKEN_PREFIX}${body.slice(0, SAFE_PREFIX_LENGTH)}`,
  };
}

function isInviteCode(value: string): boolean {
  return /^intar_beta_[A-Za-z0-9_-]{43}$/u.test(value);
}

function inviteInsertFields(row: typeof accessInviteCodes.$inferInsert) {
  return {
    id: sql<string>`${row.id}`.as("id"),
    codeHash: sql<string>`${row.codeHash}`.as("code_hash"),
    codePrefix: sql<string>`${row.codePrefix}`.as("code_prefix"),
    tokenCiphertext: sql<string>`${row.tokenCiphertext}`.as("token_ciphertext"),
    kind: sql<"standard">`'standard'`.as("kind"),
    state: sql<"pending">`'pending'`.as("state"),
    label: sql<string | null>`null`.as("label"),
    createdBy: sql<string>`${row.createdBy}`.as("created_by"),
    createdAt: sql<number>`${row.createdAt}`.as("created_at"),
    expiresAt: sql<number>`${row.expiresAt}`.as("expires_at"),
    claimExpiresAt: sql<number>`${row.claimExpiresAt}`.as("claim_expires_at"),
    leaseId: sql<string | null>`null`.as("lease_id"),
    leasedAt: sql<number | null>`null`.as("leased_at"),
    leaseExpiresAt: sql<number | null>`null`.as("lease_expires_at"),
    redeemerUserId: sql<string | null>`null`.as("redeemer_user_id"),
    redeemerGithubAccountId: sql<string | null>`null`.as(
      "redeemer_github_account_id",
    ),
    redeemerGithubUsername: sql<string | null>`null`.as(
      "redeemer_github_username",
    ),
    redeemedAt: sql<number | null>`null`.as("redeemed_at"),
    revokedBy: sql<string | null>`null`.as("revoked_by"),
    revocationReason: sql<string | null>`null`.as("revocation_reason"),
    revokedAt: sql<number | null>`null`.as("revoked_at"),
    replacesInviteId: sql<string | null>`null`.as("replaces_invite_id"),
    replacesInviteVersion: sql<number | null>`null`.as(
      "replaces_invite_version",
    ),
    replacedByInviteId: sql<string | null>`null`.as("replaced_by_invite_id"),
    version: sql<number>`1`.as("version"),
    updatedAt: sql<number>`${row.updatedAt}`.as("updated_at"),
  };
}

function effectiveExpiry(row: InviteRow): number {
  return row.claimExpiresAt ?? row.expiresAt;
}

function eventRow(params: {
  eventType: AccessEventType;
  inviteId?: string | null;
  subjectUserId?: string | null;
  githubAccountId?: string | null;
  actorUserId?: string | null;
  reason?: string | null;
  createdAt: number;
}): typeof accessEvents.$inferInsert {
  return {
    id: createAppId(),
    eventType: params.eventType,
    inviteId: params.inviteId ?? null,
    subjectUserId: params.subjectUserId ?? null,
    githubAccountId: params.githubAccountId ?? null,
    actorUserId: params.actorUserId ?? null,
    reason: params.reason ?? null,
    createdAt: params.createdAt,
  };
}

function eventInsertFields(event: typeof accessEvents.$inferInsert) {
  return {
    id: sql<string>`${event.id}`.as("id"),
    eventType: sql<AccessEventType>`${event.eventType}`.as("event_type"),
    inviteId: sql<string | null>`${event.inviteId ?? null}`.as("invite_id"),
    subjectUserId: sql<string | null>`${event.subjectUserId ?? null}`.as(
      "subject_user_id",
    ),
    githubAccountId: sql<string | null>`${event.githubAccountId ?? null}`.as(
      "github_account_id",
    ),
    actorUserId: sql<string | null>`${event.actorUserId ?? null}`.as(
      "actor_user_id",
    ),
    revocationId: sql<string | null>`null`.as("revocation_id"),
    cleanupAttemptId: sql<string | null>`null`.as("cleanup_attempt_id"),
    runId: sql<string | null>`${event.runId ?? null}`.as("run_id"),
    reason: sql<string | null>`${event.reason ?? null}`.as("reason"),
    createdAt: sql<number>`${event.createdAt}`.as("created_at"),
  };
}

async function recordInviteFailure(
  d1: D1Database,
  params: {
    eventType: "invite.exchange_failed" | "invite.claim_failed";
    inviteId?: string | null;
    subjectUserId?: string | null;
    githubAccountId?: string | null;
    reason: "invalid_code" | "expired" | "unavailable" | "claim_conflict" | "identity_mismatch";
    createdAt: number;
  },
): Promise<void> {
  await drizzle(d1).insert(accessEvents).values(eventRow(params));
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

function validId(value: string, kind: string): string {
  const id = value.trim();
  if (!id || id.length > ID_MAX_LENGTH) {
    throw appError(400, `invalid_${kind.replaceAll(" ", "_")}_id`, `Invalid ${kind}`);
  }
  return id;
}

function validVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw appError(400, "invalid_access_invite_version", "Refresh and try again");
  }
  return value;
}

function validTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw appError(500, "invalid_timestamp", "The server clock is invalid");
  }
  return value;
}

function boundedLimit(value = 500): number {
  if (!Number.isSafeInteger(value) || value <= 0) return 500;
  return Math.min(value, 500);
}

function unavailableInvite() {
  return appError(404, "access_invite_unavailable", "This invite is no longer available");
}

function staleInvite() {
  return appError(409, "access_invite_stale_version", "The invite changed. Refresh and try again");
}

function administratorRequired(action: string) {
  return appError(
    403,
    "beta_admin_authority_required",
    `Platform beta administrator access is required to ${action}`,
  );
}
