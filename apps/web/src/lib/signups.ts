import { env } from "cloudflare:workers";
import { activeAccountSql } from "@/lib/account-access";
import { appError } from "@/lib/app-error";
import { createAppId } from "@/lib/id";
import {
  isValidSignupLimit,
  signupStatusFromCounts,
  type AdminSignupStatus,
} from "@/lib/signup-status";


/** How long a spot is held while a new member's first identity is linked. */
export const SIGNUP_RESERVATION_TTL_MS = 10 * 60 * 1000;

// Members are active people with at least one sign-in identity, GitHub or an
// organization's identity provider. A person counts once however many
// identities they connect.
const LIMIT_SQL = `coalesce((SELECT settings.signup_limit FROM signup_settings AS settings WHERE settings.id = 1), 0)`;
const MEMBERS_SQL = `(SELECT count(*) FROM user AS identity
  WHERE ${activeAccountSql("identity")}
    AND EXISTS (SELECT 1 FROM account AS linked WHERE linked.user_id = identity.id))`;

/**
 * Live reservations of other people whose first identity is not linked yet.
 * `?1` is the reserving user id (or NULL) and `?2` is the current time.
 */
const PENDING_SQL = `(SELECT count(*) FROM signup_reservations AS reservation
  JOIN user AS reserved ON reserved.id = reservation.user_id
  WHERE reservation.expires_at > ?2
    AND reservation.user_id IS NOT ?1
    AND ${activeAccountSql("reserved")}
    AND NOT EXISTS (SELECT 1 FROM account AS linked
      WHERE linked.user_id = reservation.user_id))`;

interface SignupStatusRow {
  signup_limit: number;
  taken: number;
  version: number;
  updated_at: number | null;
}

export async function getSignupStatus(
  d1: D1Database = env.DB,
): Promise<AdminSignupStatus> {
  const row = await d1
    .prepare(
      `SELECT ${LIMIT_SQL} AS signup_limit,
              ${MEMBERS_SQL} AS taken,
              coalesce((SELECT version FROM signup_settings WHERE id = 1), 0) AS version,
              (SELECT updated_at FROM signup_settings WHERE id = 1) AS updated_at`,
    )
    .first<SignupStatusRow>();
  if (!row) throw new Error("the sign-up status query returned no row");

  return {
    ...signupStatusFromCounts(row.signup_limit, row.taken),
    version: row.version,
    updatedAt: row.updated_at,
  };
}

/**
 * Non-atomic pre-check that keeps a full cap from creating account-less user
 * rows. `reserveSignupSpot` is the authoritative check.
 */
export async function hasOpenSignupSpot(params: {
  userId: string | null;
  now?: number;
  d1?: D1Database;
}): Promise<boolean> {
  const d1 = params.d1 ?? env.DB;
  const row = await d1
    .prepare(
      `SELECT CASE WHEN ${MEMBERS_SQL} + ${PENDING_SQL} < ${LIMIT_SQL}
         THEN 1 ELSE 0 END AS open`,
    )
    .bind(params.userId, params.now ?? Date.now())
    .first<{ open: number }>();
  return row?.open === 1;
}

/**
 * Holds one spot for `userId` while its first identity is linked. The guarded
 * insert is a single statement, so concurrent sign-ups for the last spot admit
 * exactly one. A retry by the same user refreshes its own reservation.
 */
export async function reserveSignupSpot(params: {
  userId: string;
  now?: number;
  d1?: D1Database;
}): Promise<boolean> {
  const d1 = params.d1 ?? env.DB;
  const userId = requiredId(params.userId, "user");
  const now = validTimestamp(params.now ?? Date.now());
  const [, reserved] = await d1.batch([
    d1
      .prepare("DELETE FROM signup_reservations WHERE expires_at <= ?1")
      .bind(now),
    d1
      .prepare(
        `INSERT INTO signup_reservations (user_id, created_at, expires_at)
         SELECT ?1, ?2, ?3
         WHERE ${MEMBERS_SQL} + ${PENDING_SQL} < ${LIMIT_SQL}
         ON CONFLICT (user_id) DO UPDATE SET
           created_at = excluded.created_at,
           expires_at = excluded.expires_at`,
      )
      .bind(userId, now, now + SIGNUP_RESERVATION_TTL_MS),
  ]);
  return reserved?.meta.changes === 1;
}

export async function clearSignupReservation(params: {
  userId: string;
  d1?: D1Database;
}): Promise<void> {
  const d1 = params.d1 ?? env.DB;
  await d1
    .prepare("DELETE FROM signup_reservations WHERE user_id = ?1")
    .bind(requiredId(params.userId, "user"))
    .run();
}

/**
 * Saves the limit with optimistic concurrency. The first save expects version
 * 0. Lowering the limit never removes anyone; it only stops new sign-ups.
 */
export async function setSignupLimit(params: {
  actorUserId: string;
  limit: unknown;
  expectedVersion: unknown;
  now?: number;
  d1?: D1Database;
}): Promise<AdminSignupStatus> {
  const d1 = params.d1 ?? env.DB;
  const actorUserId = requiredId(params.actorUserId, "actor");
  if (!isValidSignupLimit(params.limit)) {
    throw appError(
      400,
      "signup_limit_invalid",
      "The sign-up limit must be a whole number from 0 to 1,000,000",
    );
  }
  const expectedVersion = params.expectedVersion;
  if (
    typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 0
  ) {
    throw appError(
      400,
      "signup_version_invalid",
      "The expected sign-up limit version is invalid",
    );
  }
  const limit = params.limit;
  const now = validTimestamp(params.now ?? Date.now());

  const [saved] = await d1.batch([
    d1
      .prepare(
        `INSERT INTO signup_settings (id, signup_limit, version, updated_by, updated_at)
         SELECT 1, ?1, 1, ?2, ?3
         WHERE ?4 = 0 OR EXISTS (SELECT 1 FROM signup_settings WHERE id = 1)
         ON CONFLICT (id) DO UPDATE SET
           signup_limit = excluded.signup_limit,
           version = signup_settings.version + 1,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at
         WHERE signup_settings.version = ?4`,
      )
      .bind(limit, actorUserId, now, expectedVersion),
    d1
      .prepare(
        `INSERT INTO access_events (id, event_type, actor_user_id, reason, created_at)
         SELECT ?1, 'signups.limit_changed', ?2, ?3, ?4 WHERE changes() = 1`,
      )
      .bind(createAppId(), actorUserId, `limit:${limit}`, now),
  ]);
  if (saved?.meta.changes !== 1) {
    throw appError(
      409,
      "signups_stale_version",
      "The limit changed in another session. Review it and save again.",
    );
  }
  return getSignupStatus(d1);
}

function requiredId(value: string, kind: string): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || id.length > 255) {
    throw appError(400, "invalid_signup_id", `Invalid ${kind} id`);
  }
  return id;
}

function validTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw appError(500, "invalid_timestamp", "The server clock is invalid");
  }
  return value;
}
