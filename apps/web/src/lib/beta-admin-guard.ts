import { and, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { accessAllowlist, user } from "@/db/schema";
import { appError } from "@/lib/app-error";

export type PlatformUserRole = "user" | "admin";

interface PlatformUserMutationInput {
  d1: D1Database;
  targetUserId: string;
  actorUserId: string;
  now?: number;
}

export async function setPlatformUserRole(
  input: PlatformUserMutationInput & { role: PlatformUserRole },
): Promise<void> {
  const targetUserId = requiredId(input.targetUserId, "target user");
  const actorUserId = requiredId(input.actorUserId, "actor user");
  const now = validNow(input.now);
  const db = drizzle(input.d1);
  const updated = await db
    .update(user)
    .set({ role: input.role, updatedAt: new Date(now) })
    .where(
      and(
        eq(user.id, targetUserId),
        isNull(user.deletedAt),
        activeAdministratorPredicate(actorUserId),
        input.role === "admin"
          ? undefined
          : lastAdministratorSafePredicate(targetUserId),
      ),
    )
    .returning({ id: user.id });
  if (updated.length === 1) return;
  await throwPlatformUserMutationFailure({
    d1: input.d1,
    targetUserId,
    actorUserId,
  });
}

function activeAdministratorPredicate(actorUserId: string) {
  return sql`exists (
    select 1
    from ${accessAllowlist} as actor_access
    join ${user} as actor_identity
      on actor_identity.id = actor_access.user_id
    where actor_access.user_id = ${actorUserId}
      and actor_access.state = 'active'
      and actor_identity.deleted_at is null
      and coalesce(actor_identity.banned, 0) = 0
      and instr(
        ',' || replace(lower(coalesce(actor_identity.role, '')), ' ', '') || ',',
        ',admin,'
      ) > 0
  )`;
}

function lastAdministratorSafePredicate(targetUserId: string) {
  return sql`(
    not exists (
      select 1
      from ${accessAllowlist} as target_access
      join ${user} as target_identity
        on target_identity.id = target_access.user_id
      where target_access.user_id = ${targetUserId}
        and target_access.state = 'active'
        and target_identity.deleted_at is null
        and coalesce(target_identity.banned, 0) = 0
        and instr(
          ',' || replace(lower(coalesce(target_identity.role, '')), ' ', '') || ',',
          ',admin,'
        ) > 0
    )
    or exists (
      select 1
      from ${accessAllowlist} as other_access
      join ${user} as other_identity
        on other_identity.id = other_access.user_id
      where other_access.state = 'active'
        and other_access.user_id <> ${targetUserId}
        and other_identity.deleted_at is null
        and coalesce(other_identity.banned, 0) = 0
        and instr(
          ',' || replace(lower(coalesce(other_identity.role, '')), ' ', '') || ',',
          ',admin,'
        ) > 0
    )
  )`;
}

async function throwPlatformUserMutationFailure(input: {
  d1: D1Database;
  targetUserId: string;
  actorUserId: string;
}): Promise<never> {
  const db = drizzle(input.d1);
  const [target, actor] = await Promise.all([
    db
      .select({ id: user.id, deletedAt: user.deletedAt })
      .from(user)
      .where(eq(user.id, input.targetUserId))
      .limit(1),
    db
      .select({ id: user.id })
      .from(user)
      .innerJoin(
        accessAllowlist,
        and(
          eq(accessAllowlist.userId, user.id),
          eq(accessAllowlist.state, "active"),
        ),
      )
      .where(
        and(
          eq(user.id, input.actorUserId),
          sql`coalesce(${user.banned}, 0) = 0`,
          sql`instr(
            ',' || replace(lower(coalesce(${user.role}, '')), ' ', '') || ',',
            ',admin,'
          ) > 0`,
        ),
      )
      .limit(1),
  ]);
  if (target.length === 0 || target[0]?.deletedAt) {
    throw appError(404, "user_not_found", "user not found");
  }
  if (actor.length === 0) {
    throw appError(
      403,
      "admin_required",
      "active beta administrator access is required",
    );
  }
  throw appError(
    409,
    "last_active_admin",
    "the last active platform administrator cannot be removed",
  );
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
