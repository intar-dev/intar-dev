import { env } from "cloudflare:workers";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { user } from "@/db/schema";

// An account has access while its user row exists, is not deleted, and is not
// banned. Revocation bans it and advances `access_generation` in the same
// write; an administrator's restore lifts the ban but never lowers the
// generation, and deletion is final. So a check that reads the same generation,
// active both times, before and after an operation held for the whole
// operation. Status alone doesn't: the account may have been revoked and
// restored in between. Point-in-time gates and writes guarded in the same
// statement need only the status.

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

/** Raw SQL that holds when the `user` row aliased as `alias` has the admin role, active or not. */
export function adminRoleSql(alias: string): string {
  if (!SQL_ALIAS.test(alias)) {
    throw new Error("Expected a plain SQL alias");
  }
  return `(instr(
    ',' || replace(lower(coalesce(${alias}.role, '')), ' ', '') || ',',
    ',admin,'
  ) > 0)`;
}

/** Raw SQL that holds when the `user` row aliased as `alias` is an active administrator. */
export function activeAdminSql(alias: string): string {
  return `(${activeAccountSql(alias)} AND ${adminRoleSql(alias)})`;
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

/** Why an identity can't sign its user in (see identitySignInBlockerSql). */
export type IdentitySignInBlocker =
  | "provider_removed"
  | "removed_from_organization"
  | "admin_requires_github";

/**
 * Raw SQL for why the `account` row aliased as `identity` can't sign its user
 * in once they have access, or NULL when it can. Built from the predicates of
 * usableIdentitySql, so for an active account it is NULL exactly when that
 * holds; while an account is revoked its admin role still counts.
 */
export function identitySignInBlockerSql(identity: string): string {
  if (!SQL_ALIAS.test(identity)) {
    throw new Error("Expected a plain SQL alias");
  }
  return `CASE
    WHEN ${identity}.provider_id = 'github' THEN NULL
    WHEN NOT EXISTS (SELECT 1 FROM sso_provider AS present_provider
      WHERE present_provider.provider_id = ${identity}.provider_id)
      THEN 'provider_removed'
    WHEN ${removedThroughProviderSql(`${identity}.user_id`, `${identity}.provider_id`)}
      THEN 'removed_from_organization'
    WHEN EXISTS (SELECT 1 FROM user AS role_holder
      WHERE role_holder.id = ${identity}.user_id AND ${adminRoleSql("role_holder")})
      THEN 'admin_requires_github'
    ELSE NULL
  END`;
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
 * The access generation of an active account that some identity can still sign
 * in, or null. With `throughProvider`, the identity at that provider must be
 * the one.
 */
export async function signInAccessGeneration(
  userId: string,
  throughProvider: string | null = null,
  d1: D1Database = env.DB,
): Promise<number | null> {
  const row = await d1
    .prepare(
      `SELECT signing_account.access_generation AS generation
       FROM user AS signing_account
       WHERE signing_account.id = ?1
         AND ${activeAccountSql("signing_account")}
         AND CASE WHEN ?2 IS NULL
           THEN ${usableIdentityExistsSql("?1")}
           ELSE EXISTS (SELECT 1 FROM account AS signing_identity
             WHERE signing_identity.user_id = ?1
               AND signing_identity.provider_id = ?2
               AND ${usableIdentitySql("signing_identity")})
         END`,
    )
    .bind(userId, throughProvider)
    .first<{ generation: number }>();
  return row ? row.generation : null;
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
  return (await signInAccessGeneration(userId, throughProvider, d1)) !== null;
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
 * The access generations a session's permission to act rests on: its
 * account's, and for an impersonation also the impersonating admin's.
 */
export interface AccessStamp {
  user: number;
  admin: number | null;
}

export function sameAccessStamp(
  left: AccessStamp | null | undefined,
  right: AccessStamp | null | undefined,
): boolean {
  return (
    left != null &&
    right != null &&
    left.user === right.user &&
    left.admin === right.admin
  );
}

/**
 * The access stamp of a session that may act for its account (see
 * sessionMayActCondition), or null. `throughProvider` is the provider opening
 * the session, whose identity must be the one that can still sign the account
 * in.
 */
export async function sessionAccessStamp(
  session: ActingSession,
  throughProvider: string | null = null,
  d1: D1Database = env.DB,
): Promise<AccessStamp | null> {
  const admin = impersonatingAdmin(session);
  if (throughProvider && !admin) {
    const generation = await signInAccessGeneration(
      session.userId,
      throughProvider,
      d1,
    );
    return generation === null ? null : { user: generation, admin: null };
  }
  const rows = await drizzle(d1)
    .select({
      user: user.accessGeneration,
      admin: admin
        ? sql<number | null>`(SELECT impersonating_admin.access_generation
            FROM user AS impersonating_admin
            WHERE impersonating_admin.id = ${admin})`
        : sql<null>`NULL`,
    })
    .from(user)
    .where(and(eq(user.id, session.userId), sessionMayActCondition(session)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (admin && typeof row.admin !== "number") return null;
  return { user: row.user, admin: admin ? row.admin : null };
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
  return (await sessionAccessStamp(session, throughProvider, d1)) !== null;
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

/** The access generation of an active account, or null. */
export async function activeAccessGeneration(
  userId?: string | null,
  d1: D1Database = env.DB,
): Promise<number | null> {
  if (!userId) return null;

  const row = await d1
    .prepare(
      `SELECT identity.access_generation AS generation FROM user AS identity
       WHERE identity.id = ?1 AND ${activeAccountSql("identity")}
       LIMIT 1`,
    )
    .bind(userId)
    .first<{ generation: number }>();
  return row ? row.generation : null;
}

export async function isActiveAccount(
  userId?: string | null,
  d1: D1Database = env.DB,
): Promise<boolean> {
  return (await activeAccessGeneration(userId, d1)) !== null;
}
