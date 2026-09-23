import { env } from "cloudflare:workers";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { account, user } from "@/db/schema";

// An account has access while its user row exists, is not deleted, and is not
// banned. Revocation and deletion only ever move an account out of that state
// (nothing sets `banned` back to 0), so a check that holds before and after an
// operation held for the whole operation.

const SQL_ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SQL_USER_ID_EXPRESSION =
  /^(?:\?[1-9][0-9]*|[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)$/u;

/** Raw SQL that holds when the `user` row aliased as `alias` is active. */
export function activeAccountSql(alias: string): string {
  if (!SQL_ALIAS.test(alias)) {
    throw new Error("Expected a plain SQL alias");
  }
  return `(${alias}.deleted_at IS NULL AND coalesce(${alias}.banned, 0) = 0)`;
}

/**
 * Raw SQL that holds when `userIdExpression` names an active account. Pass a
 * column reference or a numbered placeholder, never request text.
 */
export function activeAccountExistsSql(userIdExpression: string): string {
  if (!SQL_USER_ID_EXPRESSION.test(userIdExpression)) {
    throw new Error("Expected a column reference or a numbered placeholder");
  }
  return `EXISTS (SELECT 1 FROM user AS active_account
    WHERE active_account.id = ${userIdExpression}
      AND ${activeAccountSql("active_account")})`;
}

/** Drizzle condition for rows of the `user` table. */
export function activeAccountCondition(): SQL {
  return and(isNull(user.deletedAt), sql`coalesce(${user.banned}, 0) = 0`)!;
}

export async function isActiveAccount(
  userId?: string | null,
  d1: D1Database = env.DB,
): Promise<boolean> {
  if (!userId) return false;

  const row = await d1
    .prepare(
      `SELECT 1 AS active FROM user AS identity
       WHERE identity.id = ?1 AND ${activeAccountSql("identity")}
       LIMIT 1`,
    )
    .bind(userId)
    .first<{ active: number }>();
  return row !== null;
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

export async function hasAnyLinkedAccount(
  userId: string,
  d1: D1Database = env.DB,
): Promise<boolean> {
  if (!userId) return false;

  const rows = await drizzle(d1)
    .select({ id: account.id })
    .from(account)
    .where(eq(account.userId, userId))
    .limit(1);

  return rows.length === 1;
}
