import { env } from "cloudflare:workers";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { user } from "@/db/schema";

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

/** `expression`, once it is a column reference or a numbered placeholder. */
function sqlExpression(expression: string): string {
  if (!SQL_USER_ID_EXPRESSION.test(expression)) {
    throw new Error("Expected a column reference or a numbered placeholder");
  }
  return expression;
}

/**
 * Raw SQL that holds when `userIdExpression` names an active account. Pass a
 * column reference or a numbered placeholder, never request text.
 */
export function activeAccountExistsSql(userIdExpression: string): string {
  return `EXISTS (SELECT 1 FROM user AS active_account
    WHERE active_account.id = ${sqlExpression(userIdExpression)}
      AND ${activeAccountSql("active_account")})`;
}

/** Raw SQL that holds when the `user` row aliased as `alias` is an active administrator. */
export function activeAdminSql(alias: string): string {
  return `(${activeAccountSql(alias)} AND instr(
    ',' || replace(lower(coalesce(${alias}.role, '')), ' ', '') || ',',
    ',admin,'
  ) > 0)`;
}

/** Raw SQL that holds when the organization removed the user. */
export function removedFromOrganizationSql(
  userExpression: string,
  organizationExpression: string,
): string {
  return `EXISTS (SELECT 1 FROM organization_member_removals AS removal_record
    WHERE removal_record.user_id = ${sqlExpression(userExpression)}
      AND removal_record.organization_id = ${sqlExpression(organizationExpression)})`;
}

/**
 * Raw SQL that holds when `userExpression` was removed from the organization
 * that owns the provider named by `providerExpression`. Pass column references
 * or numbered placeholders, never request text.
 */
export function removedThroughProviderSql(
  userExpression: string,
  providerExpression: string,
): string {
  return `EXISTS (SELECT 1 FROM sso_provider AS removal_provider
    WHERE removal_provider.provider_id = ${sqlExpression(providerExpression)}
      AND ${removedFromOrganizationSql(userExpression, "removal_provider.organization_id")})`;
}

/**
 * Raw SQL that holds when organization providers may sign the user in, which
 * is unless they are a platform admin. An organization's owners and admins
 * control its provider and decide who administers it, so platform admins sign
 * in with GitHub only.
 */
export function organizationSignInAllowedSql(userExpression: string): string {
  return `NOT EXISTS (SELECT 1 FROM user AS signing_user
    WHERE signing_user.id = ${sqlExpression(userExpression)}
      AND ${activeAdminSql("signing_user")})`;
}

/**
 * Raw SQL that holds when the `account` row aliased as `identity` can sign its
 * user in: GitHub, or an organization provider that still exists, whose
 * organization hasn't removed them, while organization sign-in is allowed for
 * them (see organizationSignInAllowedSql).
 */
export function usableIdentitySql(identity: string): string {
  if (!SQL_ALIAS.test(identity)) {
    throw new Error("Expected a plain SQL alias");
  }
  return `(${identity}.provider_id = 'github'
    OR EXISTS (SELECT 1 FROM sso_provider AS usable_provider
      WHERE usable_provider.provider_id = ${identity}.provider_id
        AND NOT ${removedFromOrganizationSql(`${identity}.user_id`, "usable_provider.organization_id")}
        AND ${organizationSignInAllowedSql(`${identity}.user_id`)}))`;
}

/**
 * Raw SQL that holds when `userIdExpression` can still sign in through some
 * identity (see usableIdentitySql). `exceptProvider` leaves out identities at
 * that provider. Pass column references or numbered placeholders, never
 * request text.
 */
export function usableIdentityExistsSql(
  userIdExpression: string,
  options: { exceptProvider?: string | undefined } = {},
): string {
  const otherProvider = options.exceptProvider
    ? `AND usable_identity.provider_id <> ${sqlExpression(options.exceptProvider)}`
    : "";
  return `EXISTS (SELECT 1 FROM account AS usable_identity
    WHERE usable_identity.user_id = ${sqlExpression(userIdExpression)}
      ${otherProvider}
      AND ${usableIdentitySql("usable_identity")})`;
}

/**
 * Raw SQL that holds when the `user` row aliased as `alias` is an active
 * administrator who can still sign in.
 */
export function signingAdminSql(alias: string): string {
  return `(${activeAdminSql(alias)} AND ${usableIdentityExistsSql(`${alias}.id`)})`;
}

/**
 * Raw SQL for a column of the user's first organization identity, which audit
 * events name for people who sign in without GitHub. Both columns come from
 * the same row.
 */
export function firstOrganizationIdentitySql(
  userExpression: string,
  column: "provider_id" | "account_id",
): string {
  return `(SELECT first_identity.${column} FROM account AS first_identity
    WHERE first_identity.user_id = ${sqlExpression(userExpression)}
      AND first_identity.provider_id <> 'github'
    ORDER BY first_identity.created_at, first_identity.id
    LIMIT 1)`;
}

/** How an account can sign in, read in one query. */
export interface IdentityState {
  /** It has an identity row at all, so it already holds a sign-up spot. */
  linked: boolean;
  github: boolean;
  /**
   * No identity can sign it in, so a sign-in with its email may take it
   * over. Never a platform admin's account, which would hand out the role.
   */
  reclaimable: boolean;
}

export async function identityState(
  userId: string,
  d1: D1Database = env.DB,
): Promise<IdentityState> {
  const row = await d1
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM account WHERE user_id = ?1) AS linked,
         EXISTS (SELECT 1 FROM account
           WHERE user_id = ?1 AND provider_id = 'github') AS github,
         ${organizationSignInAllowedSql("?1")}
           AND NOT ${usableIdentityExistsSql("?1")} AS reclaimable`,
    )
    .bind(userId)
    .first<{ linked: number; github: number; reclaimable: number }>();
  return {
    linked: row?.linked === 1,
    github: row?.github === 1,
    reclaimable: row?.reclaimable === 1,
  };
}

/**
 * An active account that some identity can still sign in. With
 * `throughProvider`, the identity at that provider must be the one.
 */
export async function canSignIn(
  userId: string,
  throughProvider: string | null = null,
  d1: D1Database = env.DB,
): Promise<boolean> {
  const row = await d1
    .prepare(
      `SELECT ${activeAccountExistsSql("?1")} AND CASE WHEN ?2 IS NULL
         THEN ${usableIdentityExistsSql("?1")}
         ELSE EXISTS (SELECT 1 FROM account AS signing_identity
           WHERE signing_identity.user_id = ?1
             AND signing_identity.provider_id = ?2
             AND ${usableIdentitySql("signing_identity")})
       END AS allowed`,
    )
    .bind(userId, throughProvider)
    .first<{ allowed: number }>();
  return row?.allowed === 1;
}

/** A session row's fields that decide whether it may act. */
export interface ActingSession {
  userId: string;
  /** Set by Better Auth's admin plugin on a session an admin opened as someone. */
  impersonatedBy?: string | null | undefined;
}

/** The admin who opened this session as its user, for an impersonation. */
function impersonatingAdmin(session: unknown): string | null {
  const admin =
    typeof session === "object" && session !== null
      ? (session as { impersonatedBy?: unknown }).impersonatedBy
      : null;
  return typeof admin === "string" && admin.length > 0 ? admin : null;
}

/** Better Auth's admin plugin marks a session an admin opened as someone. */
export function isImpersonatedSession(session: unknown): boolean {
  return impersonatingAdmin(session) !== null;
}

/**
 * Drizzle condition on the `user` table that holds while `session` may act
 * for that user: the account is active and can still sign in. An
 * impersonation instead needs the admin who opened it to still be one who can
 * sign in.
 */
export function sessionMayActCondition(session: ActingSession): SQL {
  const admin = impersonatingAdmin(session);
  return and(
    activeAccountCondition(),
    admin
      ? sql`EXISTS (SELECT 1 FROM user AS impersonating_admin
          WHERE impersonating_admin.id = ${admin}
            AND ${sql.raw(signingAdminSql("impersonating_admin"))})`
      : sql.raw(usableIdentityExistsSql("user.id")),
  )!;
}

/**
 * Whether a session may act for its account (see sessionMayActCondition).
 * `throughProvider` is the provider opening the session, whose identity must
 * be the one that can still sign the account in.
 */
export async function sessionMayAct(
  session: ActingSession,
  throughProvider: string | null = null,
  d1: D1Database = env.DB,
): Promise<boolean> {
  if (throughProvider && !impersonatingAdmin(session)) {
    return canSignIn(session.userId, throughProvider, d1);
  }
  const rows = await drizzle(d1)
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.id, session.userId), sessionMayActCondition(session)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Connecting or disconnecting a sign-in method needs a session opened this
 * recently (Better Auth's freshAge), so an older session someone took over
 * can't change how the account signs in.
 */
export const RECENT_SIGN_IN_SECONDS = 24 * 60 * 60;

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
