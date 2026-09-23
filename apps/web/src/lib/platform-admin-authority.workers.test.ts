/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { user } from "@/db/schema";
import {
  activeAdminSql,
  hasOtherActiveAdmin,
  isActiveAdmin,
  setPlatformUserRole,
} from "@/lib/platform-admin-authority";
import {
  createFixtureMember,
  ensureFixtureAdmin,
  FIXTURE_ADMIN_ID,
  revokeFixtureAccount,
} from "@/test/account-fixtures";
import { resetD1Database } from "@/test/d1-migrations";

const SECOND_ADMIN_ID = "platform-admin-b";

describe("platform administrator mutation boundary", () => {
  beforeEach(async () => {
    await resetD1Database();
    await seedTwoActiveAdministrators();
  });

  it("serializes concurrent demotions and retains one reachable administrator", async () => {
    const outcomes = await Promise.allSettled([
      setPlatformUserRole({
        d1: env.DB,
        targetUserId: FIXTURE_ADMIN_ID,
        actorUserId: FIXTURE_ADMIN_ID,
        role: "user",
        now: 20_000,
      }),
      setPlatformUserRole({
        d1: env.DB,
        targetUserId: SECOND_ADMIN_ID,
        actorUserId: FIXTURE_ADMIN_ID,
        role: "user",
        now: 20_000,
      }),
    ]);

    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    const remaining = await activeAdministratorIds();
    expect(remaining).toHaveLength(1);
    await expect(
      setPlatformUserRole({
        d1: env.DB,
        targetUserId: remaining[0]!,
        actorUserId: remaining[0]!,
        role: "user",
      }),
    ).rejects.toMatchObject({ code: "last_active_admin" });
  });

  it("rechecks the actor's live authority in the mutation statement", async () => {
    await drizzle(env.DB)
      .update(user)
      .set({ role: "user" })
      .where(eq(user.id, FIXTURE_ADMIN_ID));

    await expect(
      setPlatformUserRole({
        d1: env.DB,
        targetUserId: SECOND_ADMIN_ID,
        actorUserId: FIXTURE_ADMIN_ID,
        role: "user",
      }),
    ).rejects.toMatchObject({ code: "admin_required" });
    expect(await activeAdministratorIds()).toEqual([SECOND_ADMIN_ID]);
  });

  it("does not count a revoked administrator", async () => {
    await revokeFixtureAccount({ d1: env.DB, userId: SECOND_ADMIN_ID });

    expect(await isActiveAdmin(SECOND_ADMIN_ID, env.DB)).toBe(false);
    expect(await hasOtherActiveAdmin(FIXTURE_ADMIN_ID, env.DB)).toBe(false);
    await expect(
      setPlatformUserRole({
        d1: env.DB,
        targetUserId: FIXTURE_ADMIN_ID,
        actorUserId: FIXTURE_ADMIN_ID,
        role: "user",
      }),
    ).rejects.toMatchObject({ code: "last_active_admin" });
    await expect(
      setPlatformUserRole({
        d1: env.DB,
        targetUserId: FIXTURE_ADMIN_ID,
        actorUserId: SECOND_ADMIN_ID,
        role: "user",
      }),
    ).rejects.toMatchObject({ code: "admin_required" });
    expect(await activeAdministratorIds()).toEqual([FIXTURE_ADMIN_ID]);
  });
});

async function seedTwoActiveAdministrators(): Promise<void> {
  const now = 10_000;
  await ensureFixtureAdmin(env.DB, now);
  await createFixtureMember({
    d1: env.DB,
    userId: SECOND_ADMIN_ID,
    role: "admin",
    githubAccountId: "platform-admin-b-github",
    now: now + 100,
  });
}

async function activeAdministratorIds(): Promise<string[]> {
  const result = await env.DB.prepare(
    `SELECT identity.id FROM user AS identity
     WHERE ${activeAdminSql("identity")}
     ORDER BY identity.id`,
  ).all<{ id: string }>();
  return result.results.map(({ id }) => id);
}
