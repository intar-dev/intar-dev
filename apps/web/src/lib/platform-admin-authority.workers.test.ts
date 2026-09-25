/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { user } from "@/db/schema";
import { activeAdminSql } from "@/lib/account-access";
import {
  isActiveAdmin,
  isLastActiveAdmin,
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

  it("ends the sessions a demoted admin opened as someone else", async () => {
    await createFixtureMember({ d1: env.DB, userId: "learner" });
    await env.DB.prepare(
      `INSERT INTO session (id, token, user_id, impersonated_by, expires_at, created_at, updated_at)
       VALUES ('impersonation', 'impersonation-token', 'learner', ?1, 9999999999999, 1, 1),
              ('admin-own', 'admin-own-token', ?1, NULL, 9999999999999, 1, 1)`,
    )
      .bind(SECOND_ADMIN_ID)
      .run();
    const sessions = () =>
      env.DB.prepare("SELECT id FROM session ORDER BY id")
        .all<{ id: string }>()
        .then(({ results }) => results.map(({ id }) => id));

    // A refused demotion ends nothing.
    await expect(
      setPlatformUserRole({
        d1: env.DB,
        targetUserId: SECOND_ADMIN_ID,
        actorUserId: "learner",
        role: "user",
      }),
    ).rejects.toMatchObject({ code: "admin_required" });
    await expect(sessions()).resolves.toEqual(["admin-own", "impersonation"]);

    await setPlatformUserRole({
      d1: env.DB,
      targetUserId: SECOND_ADMIN_ID,
      actorUserId: FIXTURE_ADMIN_ID,
      role: "user",
    });
    await expect(sessions()).resolves.toEqual(["admin-own"]);
  });

  it("does not count a revoked administrator", async () => {
    await revokeFixtureAccount({ d1: env.DB, userId: SECOND_ADMIN_ID });

    expect(await isActiveAdmin(SECOND_ADMIN_ID, env.DB)).toBe(false);
    expect(await isLastActiveAdmin(FIXTURE_ADMIN_ID, env.DB)).toBe(true);
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

describe("platform administrators who can sign in", () => {
  beforeEach(async () => {
    await resetD1Database();
    await ensureFixtureAdmin(env.DB, 10_000);
    // Someone who signs in through an organization, whose provider can't
    // sign in a platform admin even where they administer it.
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO user (id, name, email) VALUES ('org-member', 'Org member', 'org.member@example.test')",
      ),
      env.DB.prepare(
        "INSERT INTO organization (id, name, slug, created_at) VALUES ('org', 'Org', 'org', 1)",
      ),
      env.DB.prepare(
        `INSERT INTO sso_provider (id, issuer, domain, oidc_config, user_id, provider_id, organization_id, domain_verified)
         VALUES ('org-idp-row', 'https://idp.test', 'example.test', '{}', 'org-member', 'org-idp', 'org', 1)`,
      ),
      env.DB.prepare(
        "INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ('org-membership', 'org', 'org-member', 'member', 1)",
      ),
      env.DB.prepare(
        "INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES ('org-member-idp', 'subject', 'org-idp', 'org-member', 1, 1)",
      ),
      env.DB.prepare(
        "INSERT INTO session (id, token, user_id, expires_at, created_at, updated_at) VALUES ('org-member-session', 'org-member-token', 'org-member', 9999999999999, 1, 1)",
      ),
    ]);
  });

  it("promotes only someone with GitHub, and signs them out", async () => {
    await env.DB.prepare("UPDATE member SET role = 'owner' WHERE id = 'org-membership'").run();
    await expect(
      setPlatformUserRole({
        d1: env.DB,
        targetUserId: "org-member",
        actorUserId: FIXTURE_ADMIN_ID,
        role: "admin",
      }),
    ).rejects.toMatchObject({ status: 409, code: "admin_sign_in_required" });
    await expect(
      env.DB.prepare("SELECT count(*) AS count FROM session WHERE user_id = 'org-member'").first(),
    ).resolves.toEqual({ count: 1 });

    await env.DB.prepare(
      "INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES ('org-member-github', 'org-member-gh', 'github', 'org-member', 1, 1)",
    ).run();
    await setPlatformUserRole({
      d1: env.DB,
      targetUserId: "org-member",
      actorUserId: FIXTURE_ADMIN_ID,
      role: "admin",
    });
    // The organization's provider may have opened that session.
    await expect(
      env.DB.prepare("SELECT count(*) AS count FROM session WHERE user_id = 'org-member'").first(),
    ).resolves.toEqual({ count: 0 });

    // Setting the role an admin already has signs nobody out.
    await env.DB.prepare(
      "INSERT INTO session (id, token, user_id, expires_at, created_at, updated_at) VALUES ('admin-session', 'admin-token', 'org-member', 9999999999999, 1, 1)",
    ).run();
    await setPlatformUserRole({
      d1: env.DB,
      targetUserId: "org-member",
      actorUserId: FIXTURE_ADMIN_ID,
      role: "admin",
    });
    await expect(
      env.DB.prepare("SELECT id FROM session WHERE user_id = 'org-member'").all(),
    ).resolves.toMatchObject({ results: [{ id: "admin-session" }] });
  });

  it("doesn't count an admin who can't sign in as the remaining one", async () => {
    await env.DB.prepare("UPDATE user SET role = 'admin' WHERE id = 'org-member'").run();
    expect(await isLastActiveAdmin(FIXTURE_ADMIN_ID, env.DB)).toBe(true);
    await expect(
      setPlatformUserRole({
        d1: env.DB,
        targetUserId: FIXTURE_ADMIN_ID,
        actorUserId: FIXTURE_ADMIN_ID,
        role: "user",
      }),
    ).rejects.toMatchObject({ code: "last_active_admin" });
    // Demoting the one who can't sign in takes nothing away.
    await setPlatformUserRole({
      d1: env.DB,
      targetUserId: "org-member",
      actorUserId: FIXTURE_ADMIN_ID,
      role: "user",
    });
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
