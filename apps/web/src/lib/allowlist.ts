import { env } from "cloudflare:workers";
import { and, eq, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { accessAllowlist, account } from "@/db/schema";

// Beta access is intentionally keyed only by the immutable Better Auth user
// id. GitHub usernames and organization memberships are snapshots/tenant data,
// never authorization inputs.

export { isValidGithubUsername, toAllowlistKey } from "@/lib/github-username";

export type BetaAccessState = "active" | "blocked";

export interface BetaAdmissionEpoch {
  sourceInviteId: string;
  sourceLeaseId: string;
  grantedAt: number;
}

export interface BetaAccessSnapshot extends BetaAdmissionEpoch {
  userId: string;
  state: BetaAccessState;
  githubAccountId: string;
  githubUsername: string;
  revocationId: string | null;
}

export async function getBetaAccess(
  userId?: string | null,
  d1: D1Database = env.DB,
): Promise<BetaAccessSnapshot | null> {
  if (!userId) return null;

  const rows = await drizzle(d1)
    .select({
      userId: accessAllowlist.userId,
      state: accessAllowlist.state,
      githubAccountId: accessAllowlist.githubAccountId,
      githubUsername: accessAllowlist.githubUsername,
      sourceInviteId: accessAllowlist.sourceInviteId,
      sourceLeaseId: accessAllowlist.sourceLeaseId,
      grantedAt: accessAllowlist.grantedAt,
      revocationId: accessAllowlist.revocationId,
    })
    .from(accessAllowlist)
    .where(eq(accessAllowlist.userId, userId))
    .limit(1);

  return rows[0] ?? null;
}

export async function getBetaAccessState(
  userId?: string | null,
  d1: D1Database = env.DB,
): Promise<BetaAccessState | null> {
  return (await getBetaAccess(userId, d1))?.state ?? null;
}

export async function isActiveBetaUser(
  userId?: string | null,
  d1: D1Database = env.DB,
): Promise<boolean> {
  return (await getBetaAccessState(userId, d1)) === "active";
}

export async function hasLinkedProviderAccount(
  userId: string,
  providerId: string,
  d1: D1Database = env.DB,
): Promise<boolean> {
  if (!userId || !providerId) return false;

  const rows = await drizzle(d1)
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, providerId)))
    .limit(1);

  return rows.length === 1;
}

export async function hasLinkedNonGithubAccount(
  userId: string,
  d1: D1Database = env.DB,
): Promise<boolean> {
  if (!userId) return false;

  const rows = await drizzle(d1)
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.userId, userId), ne(account.providerId, "github")))
    .limit(1);

  return rows.length === 1;
}
