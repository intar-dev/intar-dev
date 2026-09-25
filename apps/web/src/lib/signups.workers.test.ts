/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { user } from "@/db/schema";
import { resetD1Database } from "@/test/d1-migrations";
import {
  createFixtureMember,
  ensureFixtureAdmin,
  ensureFixtureGithubAccount,
  FIXTURE_ADMIN_ID,
  revokeFixtureAccount,
} from "@/test/account-fixtures";
import {
  clearSignupReservation,
  getSignupStatus,
  hasOpenSignupSpot,
  reserveSignupSpot,
  SIGNUP_RESERVATION_TTL_MS,
  setSignupLimit,
} from "./signups";

const NOW = 1_800_000_000_000;

describe("sign-up limit", () => {
  beforeEach(async () => {
    await resetD1Database();
    await ensureFixtureAdmin(env.DB, NOW);
  });

  it("counts active people with any identity once, admins included", async () => {
    await createFixtureMember({ d1: env.DB, userId: "member", now: NOW });
    await createFixtureMember({
      d1: env.DB,
      userId: "second-admin",
      role: "admin",
      now: NOW,
    });
    await createFixtureMember({ d1: env.DB, userId: "banned", now: NOW });
    await revokeFixtureAccount({ d1: env.DB, userId: "banned" });
    await createFixtureMember({ d1: env.DB, userId: "deleted", now: NOW });
    await env.DB.prepare("UPDATE user SET deleted_at = ?1 WHERE id = 'deleted'")
      .bind(NOW)
      .run();
    await insertAccountlessUser("github-less");
    await env.DB.prepare(
      `INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at)
       VALUES ('oidc-only-row', 'oidc-only-subject', 'tenant-oidc', 'github-less', ?1, ?1)`,
    )
      .bind(NOW)
      .run();
    // A second identity does not take a second spot.
    await env.DB.prepare(
      `INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at)
       VALUES ('member-oidc-row', 'member-subject', 'tenant-oidc', 'member', ?1, ?1)`,
    )
      .bind(NOW)
      .run();
    await insertAccountlessUser("no-identity");

    // The fixture admin, the member, the second admin, and the account that
    // signs in only through an organization.
    await expect(getSignupStatus(env.DB)).resolves.toMatchObject({ taken: 4 });
  });

  it("keeps sign-ups closed until an administrator saves a limit", async () => {
    await insertAccountlessUser("candidate");

    await expect(getSignupStatus(env.DB)).resolves.toEqual({
      limit: 0,
      taken: 1,
      remaining: 0,
      open: false,
      version: 0,
      updatedAt: null,
    });
    await expect(hasOpenSignupSpot({ userId: null, d1: env.DB })).resolves.toBe(
      false,
    );
    await expect(
      reserveSignupSpot({ userId: "candidate", now: NOW, d1: env.DB }),
    ).resolves.toBe(false);
    await expect(countReservations()).resolves.toBe(0);
  });

  it("saves the first limit at version 0 and refuses a stale version without an event", async () => {
    await expect(
      setSignupLimit({
        actorUserId: FIXTURE_ADMIN_ID,
        limit: 5,
        expectedVersion: 1,
        now: NOW,
        d1: env.DB,
      }),
    ).rejects.toMatchObject({ status: 409, code: "signups_stale_version" });
    await expect(countLimitEvents()).resolves.toBe(0);

    await expect(
      setSignupLimit({
        actorUserId: FIXTURE_ADMIN_ID,
        limit: 5,
        expectedVersion: 0,
        now: NOW,
        d1: env.DB,
      }),
    ).resolves.toEqual({
      limit: 5,
      taken: 1,
      remaining: 4,
      open: true,
      version: 1,
      updatedAt: NOW,
    });

    for (const expectedVersion of [0, 2]) {
      await expect(
        setSignupLimit({
          actorUserId: FIXTURE_ADMIN_ID,
          limit: 9,
          expectedVersion,
          now: NOW + 1,
          d1: env.DB,
        }),
      ).rejects.toMatchObject({ status: 409, code: "signups_stale_version" });
    }
    await expect(getSignupStatus(env.DB)).resolves.toMatchObject({
      limit: 5,
      version: 1,
    });

    await expect(
      setSignupLimit({
        actorUserId: FIXTURE_ADMIN_ID,
        limit: 0,
        expectedVersion: 1,
        now: NOW + 2,
        d1: env.DB,
      }),
    ).resolves.toMatchObject({ limit: 0, open: false, version: 2 });
    const events = await env.DB.prepare(
      `SELECT actor_user_id AS actorUserId, reason, created_at AS createdAt
       FROM access_events WHERE event_type = 'signups.limit_changed'
       ORDER BY created_at`,
    ).all();
    expect(events.results).toEqual([
      { actorUserId: FIXTURE_ADMIN_ID, reason: "limit:5", createdAt: NOW },
      { actorUserId: FIXTURE_ADMIN_ID, reason: "limit:0", createdAt: NOW + 2 },
    ]);
    await expect(
      env.DB.prepare(
        "SELECT updated_by AS updatedBy FROM signup_settings WHERE id = 1",
      ).first(),
    ).resolves.toEqual({ updatedBy: FIXTURE_ADMIN_ID });
  });

  it("rejects invalid limits and versions before writing", async () => {
    for (const limit of [-1, 1.5, "5", 1_000_001, Number.NaN, null]) {
      await expect(
        setSignupLimit({
          actorUserId: FIXTURE_ADMIN_ID,
          limit,
          expectedVersion: 0,
          d1: env.DB,
        }),
      ).rejects.toMatchObject({ status: 400, code: "signup_limit_invalid" });
    }
    for (const expectedVersion of [-1, 0.5, "0", undefined]) {
      await expect(
        setSignupLimit({
          actorUserId: FIXTURE_ADMIN_ID,
          limit: 5,
          expectedVersion,
          d1: env.DB,
        }),
      ).rejects.toMatchObject({ status: 400, code: "signup_version_invalid" });
    }
    await expect(
      setSignupLimit({
        actorUserId: FIXTURE_ADMIN_ID,
        limit: 1_000_000,
        expectedVersion: 0,
        d1: env.DB,
      }),
    ).resolves.toMatchObject({ limit: 1_000_000, version: 1 });
    await expect(countLimitEvents()).resolves.toBe(1);
  });

  it("enforces the limit range and the singleton row in the schema", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO signup_settings (id, signup_limit, version, updated_at)
         VALUES (1, 1000001, 1, ?1)`,
      )
        .bind(NOW)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/u);
    await expect(
      env.DB.prepare(
        `INSERT INTO signup_settings (id, signup_limit, version, updated_at)
         VALUES (2, 5, 1, ?1)`,
      )
        .bind(NOW)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/u);
    await expect(
      env.DB.prepare(
        `INSERT INTO signup_settings (id, signup_limit, version, updated_at)
         VALUES (1, 1000000, 1, ?1)`,
      )
        .bind(NOW)
        .run(),
    ).resolves.toMatchObject({ success: true });
  });

  it("admits exactly one of five concurrent reservations for the last spot", async () => {
    await saveLimit(2);
    const candidates = ["race-1", "race-2", "race-3", "race-4", "race-5"];
    for (const userId of candidates) await insertAccountlessUser(userId);

    const results = await Promise.all(
      candidates.map((userId) =>
        reserveSignupSpot({ userId, now: NOW, d1: env.DB }),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    await expect(countReservations()).resolves.toBe(1);
    await expect(hasOpenSignupSpot({ userId: null, now: NOW, d1: env.DB }))
      .resolves.toBe(false);
  });

  it("counts a user who reserves twice once", async () => {
    await saveLimit(2);
    await insertAccountlessUser("repeat");
    await insertAccountlessUser("other");

    await expect(
      reserveSignupSpot({ userId: "repeat", now: NOW, d1: env.DB }),
    ).resolves.toBe(true);
    await expect(
      reserveSignupSpot({ userId: "repeat", now: NOW + 1_000, d1: env.DB }),
    ).resolves.toBe(true);

    await expect(
      env.DB.prepare(
        "SELECT user_id AS userId, expires_at AS expiresAt FROM signup_reservations",
      ).all(),
    ).resolves.toMatchObject({
      results: [
        { userId: "repeat", expiresAt: NOW + 1_000 + SIGNUP_RESERVATION_TTL_MS },
      ],
    });
    // The reserving user does not compete with its own reservation.
    await expect(
      hasOpenSignupSpot({ userId: "repeat", now: NOW + 1_000, d1: env.DB }),
    ).resolves.toBe(true);
    await expect(
      hasOpenSignupSpot({ userId: null, now: NOW + 1_000, d1: env.DB }),
    ).resolves.toBe(false);
    await expect(
      reserveSignupSpot({ userId: "other", now: NOW + 1_000, d1: env.DB }),
    ).resolves.toBe(false);
  });

  it("stops counting expired reservations and purges them on the next reservation", async () => {
    await saveLimit(2);
    await insertAccountlessUser("stale");
    await insertAccountlessUser("fresh");
    await expect(
      reserveSignupSpot({ userId: "stale", now: NOW, d1: env.DB }),
    ).resolves.toBe(true);
    const expiry = NOW + SIGNUP_RESERVATION_TTL_MS;

    await expect(
      hasOpenSignupSpot({ userId: null, now: expiry - 1, d1: env.DB }),
    ).resolves.toBe(false);
    await expect(
      hasOpenSignupSpot({ userId: null, now: expiry, d1: env.DB }),
    ).resolves.toBe(true);

    await expect(
      reserveSignupSpot({ userId: "fresh", now: expiry, d1: env.DB }),
    ).resolves.toBe(true);
    await expect(
      env.DB.prepare("SELECT user_id AS userId FROM signup_reservations").all(),
    ).resolves.toMatchObject({ results: [{ userId: "fresh" }] });
  });

  it("ignores reservations of users who already have an identity or lost access", async () => {
    await saveLimit(3);
    await insertAccountlessUser("linked");
    await insertAccountlessUser("revoked");
    await insertAccountlessUser("next");
    await insertAccountlessUser("last");
    await expect(
      reserveSignupSpot({ userId: "linked", now: NOW, d1: env.DB }),
    ).resolves.toBe(true);
    await expect(
      reserveSignupSpot({ userId: "revoked", now: NOW, d1: env.DB }),
    ).resolves.toBe(true);
    await expect(getSignupStatus(env.DB)).resolves.toMatchObject({ taken: 1 });

    // A linked identity holds the spot now, so its reservation does not count
    // twice. A revoked account's reservation frees its spot.
    await ensureFixtureGithubAccount({ d1: env.DB, userId: "linked", now: NOW });
    await revokeFixtureAccount({ d1: env.DB, userId: "revoked" });
    await expect(getSignupStatus(env.DB)).resolves.toMatchObject({
      taken: 2,
      remaining: 1,
    });

    await expect(
      reserveSignupSpot({ userId: "next", now: NOW + 1, d1: env.DB }),
    ).resolves.toBe(true);
    await expect(
      reserveSignupSpot({ userId: "last", now: NOW + 1, d1: env.DB }),
    ).resolves.toBe(false);
  });

  it("clears a reservation and frees its spot", async () => {
    await saveLimit(2);
    await insertAccountlessUser("cleared");
    await insertAccountlessUser("waiting");
    await expect(
      reserveSignupSpot({ userId: "cleared", now: NOW, d1: env.DB }),
    ).resolves.toBe(true);

    await clearSignupReservation({ userId: "cleared", d1: env.DB });

    await expect(countReservations()).resolves.toBe(0);
    await expect(
      reserveSignupSpot({ userId: "waiting", now: NOW, d1: env.DB }),
    ).resolves.toBe(true);
  });

  it("never removes members when the limit is lowered", async () => {
    await createFixtureMember({ d1: env.DB, userId: "member-a", now: NOW });
    await createFixtureMember({ d1: env.DB, userId: "member-b", now: NOW });
    await saveLimit(1);

    await expect(getSignupStatus(env.DB)).resolves.toMatchObject({
      limit: 1,
      taken: 3,
      remaining: 0,
      open: false,
    });
  });
});

async function insertAccountlessUser(userId: string): Promise<void> {
  await drizzle(env.DB).insert(user).values({
    id: userId,
    name: userId,
    email: `${userId}@example.test`,
    emailVerified: true,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
  });
}

async function saveLimit(limit: number): Promise<void> {
  const { version } = await getSignupStatus(env.DB);
  await setSignupLimit({
    actorUserId: FIXTURE_ADMIN_ID,
    limit,
    expectedVersion: version,
    now: NOW,
    d1: env.DB,
  });
}

async function countReservations(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT count(*) AS count FROM signup_reservations",
  ).first<{ count: number }>();
  return row?.count ?? 0;
}

async function countLimitEvents(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT count(*) AS count FROM access_events WHERE event_type = 'signups.limit_changed'",
  ).first<{ count: number }>();
  return row?.count ?? 0;
}
