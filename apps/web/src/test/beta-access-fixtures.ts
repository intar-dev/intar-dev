import { drizzle } from "drizzle-orm/d1";
import { accessAllowlist, accessInviteCodes, account, user } from "@/db/schema";
import {
  createBetaInvite,
  redeemBetaInvite,
} from "@/lib/beta-invites";
import { createAppId } from "@/lib/id";

export const FIXTURE_BETA_ADMIN_ID = "fixture-beta-admin";
export const FIXTURE_INVITE_ENCRYPTION_KEY =
  "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

export async function grantFixtureBetaAccess(params: {
  d1: D1Database;
  userId: string;
  githubAccountId?: string;
  githubUsername?: string;
  now?: number;
}): Promise<void> {
  const existing = await params.d1
    .prepare(
      "SELECT 1 FROM access_allowlist WHERE user_id = ? AND state = 'active'",
    )
    .bind(params.userId)
    .first();
  if (existing) return;

  const now = params.now ?? Date.now();
  const issuerUserId = await ensureFixtureBetaAdmin(params.d1, now);
  const githubAccountId = await ensureGithubAccount({
    d1: params.d1,
    userId: params.userId,
    accountId:
      params.githubAccountId ?? `fixture-github-account-${params.userId}`,
    now,
  });
  const githubUsername = params.githubUsername ?? params.userId;
  const invite = await createBetaInvite({
    d1: params.d1,
    actorUserId: issuerUserId,
    encryptionKey: FIXTURE_INVITE_ENCRYPTION_KEY,
    now,
  });
  await redeemBetaInvite({
    d1: params.d1,
    inviteId: invite.id,
    attemptId: `fixture-attempt-${invite.id}`,
    userId: params.userId,
    githubAccountId,
    githubUsername,
    now: now + 1,
  });
}

export async function ensureFixtureBetaAdmin(
  d1: D1Database,
  now: number,
): Promise<string> {
  const activeAdmin = await d1
    .prepare(
      `SELECT access.user_id
       FROM access_allowlist AS access
       INNER JOIN user AS identity ON identity.id = access.user_id
       WHERE access.state = 'active'
         AND coalesce(identity.banned, 0) = 0
         AND instr(
           ',' || replace(lower(coalesce(identity.role, '')), ' ', '') || ',',
           ',admin,'
         ) > 0
       LIMIT 1`,
    )
    .first<{ user_id: string }>();
  if (activeAdmin) return activeAdmin.user_id;

  const db = drizzle(d1);
  const existingAdmin = await d1
    .prepare("SELECT id FROM user WHERE id = ? LIMIT 1")
    .bind(FIXTURE_BETA_ADMIN_ID)
    .first();
  if (!existingAdmin) {
    await db.insert(user).values({
      id: FIXTURE_BETA_ADMIN_ID,
      name: "Fixture beta administrator",
      email: "fixture-beta-admin@example.test",
      emailVerified: true,
      username: FIXTURE_BETA_ADMIN_ID,
      role: "admin",
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
  }
  const githubAccountId = await ensureGithubAccount({
    d1,
    userId: FIXTURE_BETA_ADMIN_ID,
    accountId: "fixture-github-account-beta-admin",
    now,
  });
  const bootstrapInviteId = "fixture-bootstrap-invite";
  const leaseId = "fixture-bootstrap-lease";
  await db.insert(accessInviteCodes).values({
    id: bootstrapInviteId,
    codeHash: "f".repeat(64),
    codePrefix: "intar_beta_fixture",
    kind: "bootstrap_admin",
    state: "redeemed",
    createdAt: now,
    expiresAt: now + 172_800_000,
    leaseId,
    leasedAt: now,
    leaseExpiresAt: now + 600_000,
    redeemerUserId: FIXTURE_BETA_ADMIN_ID,
    redeemerGithubAccountId: githubAccountId,
    redeemerGithubUsername: FIXTURE_BETA_ADMIN_ID,
    redeemedAt: now,
    version: 2,
    updatedAt: now,
  });
  await db.insert(accessAllowlist).values({
    userId: FIXTURE_BETA_ADMIN_ID,
    state: "active",
    githubAccountId,
    githubUsername: FIXTURE_BETA_ADMIN_ID,
    sourceInviteId: bootstrapInviteId,
    sourceLeaseId: leaseId,
    grantedBy: null,
    grantReason: "bootstrap_admin",
    grantedAt: now,
  });
  return FIXTURE_BETA_ADMIN_ID;
}

async function ensureGithubAccount(params: {
  d1: D1Database;
  userId: string;
  accountId: string;
  now: number;
}): Promise<string> {
  const existing = await params.d1
    .prepare(
      `SELECT account_id FROM account
       WHERE user_id = ? AND provider_id = 'github' LIMIT 1`,
    )
    .bind(params.userId)
    .first<{ account_id: string }>();
  if (existing) return existing.account_id;

  await drizzle(params.d1).insert(account).values({
    id: createAppId(),
    accountId: params.accountId,
    providerId: "github",
    userId: params.userId,
    createdAt: new Date(params.now),
    updatedAt: new Date(params.now),
  });
  return params.accountId;
}
