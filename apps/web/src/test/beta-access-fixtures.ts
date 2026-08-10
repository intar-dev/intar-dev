import { drizzle } from "drizzle-orm/d1";
import { account, user } from "@/db/schema";
import {
  confirmAccessInvite,
  createAccessInvite,
  leaseAccessInvite,
} from "@/lib/access-invites";
import { createAppId } from "@/lib/id";

export const FIXTURE_BETA_ADMIN_ID = "fixture-beta-admin";

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
  const invite = await createAccessInvite({
    d1: params.d1,
    kind: "standard",
    actorUserId: issuerUserId,
    label: `fixture-${params.userId}`,
    now,
  });
  const lease = await leaseAccessInvite({
    d1: params.d1,
    inviteId: invite.id,
    now: now + 1,
  });
  await confirmAccessInvite({
    d1: params.d1,
    inviteId: invite.id,
    leaseId: lease.leaseId,
    userId: params.userId,
    githubAccountId,
    githubUsername,
    now: now + 2,
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
  const invite = await createAccessInvite({
    d1,
    kind: "bootstrap_admin",
    label: "fixture-bootstrap-admin",
    now,
  });
  const lease = await leaseAccessInvite({
    d1,
    inviteId: invite.id,
    now: now + 1,
  });
  await confirmAccessInvite({
    d1,
    inviteId: invite.id,
    leaseId: lease.leaseId,
    userId: FIXTURE_BETA_ADMIN_ID,
    githubAccountId,
    githubUsername: FIXTURE_BETA_ADMIN_ID,
    now: now + 2,
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
