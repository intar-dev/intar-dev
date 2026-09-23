import { drizzle } from "drizzle-orm/d1";
import { account, user } from "@/db/schema";
import { createAppId } from "@/lib/id";

// An account has access by existing, not deleted and not banned. These
// fixtures add the GitHub identity a real member always has and, like the
// production database, at least one active administrator.

export const FIXTURE_ADMIN_ID = "fixture-admin";

export async function ensureFixtureMember(params: {
  d1: D1Database;
  userId: string;
  githubAccountId?: string | undefined;
  now?: number | undefined;
}): Promise<void> {
  const now = params.now ?? Date.now();
  await ensureFixtureAdmin(params.d1, now);
  await ensureFixtureGithubAccount({
    d1: params.d1,
    userId: params.userId,
    accountId: params.githubAccountId,
    now,
  });
}

export async function createFixtureMember(params: {
  d1: D1Database;
  userId: string;
  role?: "user" | "admin";
  githubAccountId?: string | undefined;
  now?: number | undefined;
}): Promise<void> {
  const now = params.now ?? Date.now();
  await drizzle(params.d1).insert(user).values({
    id: params.userId,
    name: params.userId,
    email: `${params.userId}@example.test`,
    emailVerified: true,
    username: params.userId.toLowerCase(),
    role: params.role ?? "user",
    createdAt: new Date(now),
    updatedAt: new Date(now),
  });
  await ensureFixtureGithubAccount({
    d1: params.d1,
    userId: params.userId,
    accountId: params.githubAccountId,
    now,
  });
}

export async function ensureFixtureAdmin(
  d1: D1Database,
  now = Date.now(),
): Promise<string> {
  const activeAdmin = await d1
    .prepare(
      `SELECT identity.id
       FROM user AS identity
       WHERE identity.deleted_at IS NULL
         AND coalesce(identity.banned, 0) = 0
         AND instr(
           ',' || replace(lower(coalesce(identity.role, '')), ' ', '') || ',',
           ',admin,'
         ) > 0
       LIMIT 1`,
    )
    .first<{ id: string }>();
  if (activeAdmin) return activeAdmin.id;

  const existingAdmin = await d1
    .prepare("SELECT id FROM user WHERE id = ? LIMIT 1")
    .bind(FIXTURE_ADMIN_ID)
    .first();
  if (!existingAdmin) {
    await drizzle(d1).insert(user).values({
      id: FIXTURE_ADMIN_ID,
      name: "Fixture administrator",
      email: "fixture-admin@example.test",
      emailVerified: true,
      username: FIXTURE_ADMIN_ID,
      role: "admin",
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
  }
  await ensureFixtureGithubAccount({
    d1,
    userId: FIXTURE_ADMIN_ID,
    accountId: `fixture-github-account-${FIXTURE_ADMIN_ID}`,
    now,
  });
  return FIXTURE_ADMIN_ID;
}

/**
 * Makes the account inactive the way a revocation does, without the host and
 * session cleanup. Use `revokeAccount` when a test needs those side effects.
 */
export async function revokeFixtureAccount(params: {
  d1: D1Database;
  userId: string;
}): Promise<void> {
  await params.d1
    .prepare(
      `UPDATE user SET banned = 1, ban_reason = 'access_revoked', ban_expires = NULL
       WHERE id = ?1`,
    )
    .bind(params.userId)
    .run();
}

export async function ensureFixtureGithubAccount(params: {
  d1: D1Database;
  userId: string;
  accountId?: string | undefined;
  now?: number | undefined;
}): Promise<string> {
  const existing = await params.d1
    .prepare(
      `SELECT account_id FROM account
       WHERE user_id = ? AND provider_id = 'github' LIMIT 1`,
    )
    .bind(params.userId)
    .first<{ account_id: string }>();
  if (existing) return existing.account_id;

  const now = params.now ?? Date.now();
  const accountId =
    params.accountId ?? `fixture-github-account-${params.userId}`;
  await drizzle(params.d1).insert(account).values({
    id: createAppId(),
    accountId,
    providerId: "github",
    userId: params.userId,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  });
  return accountId;
}
