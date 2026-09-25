import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { session, user } from "@/db/schema";
import { activeAdminSql, signingAdminSql } from "@/lib/account-access";
import { signOutQueries } from "@/lib/account-sign-out";
import { appError, type AppError } from "@/lib/app-error";

// A platform administrator is an active account whose role list contains
// `admin`. Every write that needs an administrator, or that could remove the
// last one, rechecks these predicates inside its own statement.

export type PlatformUserRole = "user" | "admin";

interface PlatformUserMutationInput {
  d1: D1Database;
  targetUserId: string;
  actorUserId: string;
  now?: number;
}


/** Drizzle condition that holds while `userId` is an active administrator. */
export function activeAdministrator(userId: string): SQL {
  return sql`exists (
    select 1 from ${user} as actor_identity
    where actor_identity.id = ${userId}
      and ${sql.raw(activeAdminSql("actor_identity"))}
  )`;
}

/**
 * Drizzle condition that holds unless `targetUserId` is the last active
 * administrator who can still sign in. An administrator with no usable
 * identity can't act, so they don't count. Guard every write that removes an
 * administrator's role or access with it.
 */
export function lastAdministratorSafe(targetUserId: string): SQL {
  return sql`(
    not exists (
      select 1 from ${user} as target_identity
      where target_identity.id = ${targetUserId}
        and ${sql.raw(signingAdminSql("target_identity"))}
    )
    or exists (
      select 1 from ${user} as other_identity
      where other_identity.id <> ${targetUserId}
        and ${sql.raw(signingAdminSql("other_identity"))}
    )
  )`;
}

/** Whether this is the only active administrator who can still sign in. */
export async function isLastActiveAdmin(
  userId: string,
  d1: D1Database,
): Promise<boolean> {
  const row = await d1
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM user AS identity
           WHERE identity.id = ?1 AND ${signingAdminSql("identity")})
         AND NOT EXISTS (SELECT 1 FROM user AS other_identity
           WHERE other_identity.id <> ?1
             AND ${signingAdminSql("other_identity")}) AS last`,
    )
    .bind(userId)
    .first<{ last: number }>();
  return row?.last === 1;
}

export async function isActiveAdmin(
  userId: string,
  d1: D1Database,
): Promise<boolean> {
  const row = await d1
    .prepare(
      `SELECT 1 AS admin FROM user AS identity
       WHERE identity.id = ?1 AND ${activeAdminSql("identity")}
       LIMIT 1`,
    )
    .bind(userId)
    .first<{ admin: number }>();
  return row !== null;
}

export function adminRequiredError(): AppError {
  return appError(
    403,
    "admin_required",
    "Active administrator access is required",
  );
}

export function lastActiveAdminError(
  action: "demoted" | "revoked" | "deleted",
): AppError {
  return appError(
    409,
    "last_active_admin",
    `The last active administrator can't be ${action}`,
  );
}

export async function setPlatformUserRole(
  input: PlatformUserMutationInput & { role: PlatformUserRole },
): Promise<void> {
  const targetUserId = requiredId(input.targetUserId, "target user");
  const actorUserId = requiredId(input.actorUserId, "actor user");
  const now = validNow(input.now);
  const db = drizzle(input.d1);
  const promoting = input.role === "admin";
  // Platform admins sign in with GitHub only.
  const hasGithub = sql`EXISTS (SELECT 1 FROM account AS admin_identity
    WHERE admin_identity.user_id = ${targetUserId}
      AND admin_identity.provider_id = 'github')`;
  const update = db
    .update(user)
    .set({ role: input.role, updatedAt: new Date(now) })
    .where(
      and(
        eq(user.id, targetUserId),
        isNull(user.deletedAt),
        activeAdministrator(actorUserId),
        promoting ? hasGithub : lastAdministratorSafe(targetUserId),
      ),
    )
    .returning({ id: user.id });
  // The sign-outs run before the update with its guard, so they apply exactly
  // when it changes the role. A promotion ends the person's sessions, which an
  // organization's provider may have opened. A demotion ends the sessions the
  // admin opened by impersonating someone.
  const signOuts = promoting
    ? signOutQueries(
        db,
        (userColumn) => sql`${userColumn} = ${targetUserId}
          AND ${activeAdministrator(actorUserId)}
          AND ${hasGithub}
          AND EXISTS (SELECT 1 FROM ${user} AS promoted
            WHERE promoted.id = ${targetUserId}
              AND promoted.deleted_at IS NULL
              AND NOT ${sql.raw(activeAdminSql("promoted"))})`,
      )
    : ([
        db.delete(session).where(sql`${session.impersonatedBy} = ${targetUserId}
          AND ${activeAdministrator(actorUserId)}
          AND ${lastAdministratorSafe(targetUserId)}
          AND EXISTS (SELECT 1 FROM ${user} AS demoted
            WHERE demoted.id = ${targetUserId}
              AND demoted.deleted_at IS NULL)`),
      ] as const);
  const results = await db.batch([...signOuts, update]);
  const updated = results.at(-1) as { id: string }[];
  if (updated.length === 1) return;
  await throwPlatformUserMutationFailure({
    d1: input.d1,
    targetUserId,
    actorUserId,
    promoting,
  });
}

async function throwPlatformUserMutationFailure(input: {
  d1: D1Database;
  targetUserId: string;
  actorUserId: string;
  promoting: boolean;
}): Promise<never> {
  const [target, actorIsAdmin] = await Promise.all([
    drizzle(input.d1)
      .select({ id: user.id, deletedAt: user.deletedAt })
      .from(user)
      .where(eq(user.id, input.targetUserId))
      .limit(1),
    isActiveAdmin(input.actorUserId, input.d1),
  ]);
  if (target.length === 0 || target[0]?.deletedAt) {
    throw appError(404, "user_not_found", "User not found");
  }
  if (!actorIsAdmin) throw adminRequiredError();
  if (input.promoting) {
    throw appError(
      409,
      "admin_sign_in_required",
      "Platform admins sign in with GitHub. Ask them to connect GitHub from their profile first.",
    );
  }
  throw lastActiveAdminError("demoted");
}

function requiredId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 255) {
    throw appError(400, "invalid_user_id", `${label} id is invalid`);
  }
  return normalized;
}

function validNow(value: number | undefined): number {
  const now = value ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw appError(500, "clock_invalid", "the server clock is invalid");
  }
  return now;
}
