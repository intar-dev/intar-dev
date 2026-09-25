/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { and, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { account, user } from "@/db/schema";
import { resetD1Database } from "@/test/d1-migrations";
import {
  activeAccountCondition,
  activeAccountExistsSql,
  activeAccountSql,
  canSignIn,
  identityState,
  isActiveAccount,
  sessionMayAct,
  usableIdentityExistsSql,
} from "./account-access";

const NOW = 1_800_000_000_000;

describe("account access", () => {
  beforeEach(async () => {
    await resetD1Database();
    await insertUser("active");
    await insertUser("never-flagged", { banned: null });
    await insertUser("banned", { banned: true });
    await insertUser("deleted", { deletedAt: new Date(NOW) });
  });

  it("builds the active-account predicate only for plain aliases", () => {
    expect(activeAccountSql("identity")).toBe(
      "(identity.deleted_at IS NULL AND coalesce(identity.banned, 0) = 0)",
    );
    for (const alias of ["", "1identity", "a.b", "identity; DROP TABLE user", "id-entity"]) {
      expect(() => activeAccountSql(alias)).toThrow("Expected a plain SQL alias");
    }
  });

  it("builds the existence check only for column references and placeholders", () => {
    for (const expression of ["?1", "?12", "host.user_id", "user_id"]) {
      expect(activeAccountExistsSql(expression)).toContain(
        `active_account.id = ${expression}`,
      );
    }
    for (const expression of ["?0", "?", "'x'", "a.b.c", "1", "?1 OR 1=1", ""]) {
      expect(() => activeAccountExistsSql(expression)).toThrow(
        "Expected a column reference or a numbered placeholder",
      );
    }
  });

  it("treats only existing, undeleted, unbanned users as active", async () => {
    await expect(isActiveAccount("active", env.DB)).resolves.toBe(true);
    await expect(isActiveAccount("never-flagged", env.DB)).resolves.toBe(true);
    await expect(isActiveAccount("banned", env.DB)).resolves.toBe(false);
    await expect(isActiveAccount("deleted", env.DB)).resolves.toBe(false);
    await expect(isActiveAccount("missing", env.DB)).resolves.toBe(false);
    for (const userId of [null, undefined, ""]) {
      await expect(isActiveAccount(userId, env.DB)).resolves.toBe(false);
    }
  });

  it("applies the same predicate through raw SQL and Drizzle", async () => {
    const everyone = ["active", "never-flagged", "banned", "deleted", "missing"];
    const exists = await Promise.all(
      everyone.map(async (userId) => {
        const row = await env.DB.prepare(
          `SELECT ${activeAccountExistsSql("?1")} AS active`,
        )
          .bind(userId)
          .first<{ active: number }>();
        return [userId, row?.active] as const;
      }),
    );
    expect(Object.fromEntries(exists)).toEqual({
      active: 1,
      "never-flagged": 1,
      banned: 0,
      deleted: 0,
      missing: 0,
    });

    const joined = await env.DB.prepare(
      `SELECT owner.id FROM user AS owner
       WHERE ${activeAccountExistsSql("owner.id")}
       ORDER BY owner.id`,
    ).all<{ id: string }>();
    expect(joined.results.map(({ id }) => id)).toEqual([
      "active",
      "never-flagged",
    ]);

    const rows = await drizzle(env.DB)
      .select({ id: user.id })
      .from(user)
      .where(and(inArray(user.id, everyone), activeAccountCondition()))
      .orderBy(user.id);
    expect(rows.map(({ id }) => id)).toEqual(["active", "never-flagged"]);
  });

  it("reads how an account can sign in in one query", async () => {
    await insertAccount("active", "github", "active-github");
    // No provider row: the identity can't sign anyone in.
    await insertAccount("never-flagged", "tenant-oidc", "subject");

    await expect(identityState("active", env.DB)).resolves.toEqual({
      linked: true,
      github: true,
      reclaimable: false,
    });
    await expect(identityState("never-flagged", env.DB)).resolves.toEqual({
      linked: true,
      github: false,
      reclaimable: true,
    });
    await expect(identityState("banned", env.DB)).resolves.toEqual({
      linked: false,
      github: false,
      reclaimable: true,
    });
  });

  it("counts an organization identity while its provider exists and keeps the person", async () => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO organization (id, name, slug, created_at) VALUES ('org', 'Org', 'org', 1)",
      ),
      env.DB.prepare(
        `INSERT INTO sso_provider (id, issuer, domain, oidc_config, user_id, provider_id, organization_id, domain_verified)
         VALUES ('tenant-row', 'https://idp.test', 'idp.test', '{}', 'active', 'tenant-oidc', 'org', 1)`,
      ),
    ]);
    await insertAccount("never-flagged", "tenant-oidc", "subject");
    const usable = async (
      options?: { exceptProvider?: string },
      ...bindings: string[]
    ) =>
      (
        await env.DB.prepare(
          `SELECT ${usableIdentityExistsSql("?1", options)} AS usable`,
        )
          .bind("never-flagged", ...bindings)
          .first<{ usable: number }>()
      )?.usable;

    expect(await usable()).toBe(1);
    expect(await usable({ exceptProvider: "?2" }, "tenant-oidc")).toBe(0);
    await env.DB.prepare(
      "INSERT INTO organization_member_removals (organization_id, user_id, removed_by, removed_at) VALUES ('org', 'never-flagged', 'active', 1)",
    ).run();
    expect(await usable()).toBe(0);
    expect(() => usableIdentityExistsSql("id; DROP TABLE user")).toThrow();
  });

  it("never signs a platform admin in through an organization", async () => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO organization (id, name, slug, created_at) VALUES ('org', 'Org', 'org', 1)",
      ),
      env.DB.prepare(
        `INSERT INTO sso_provider (id, issuer, domain, oidc_config, user_id, provider_id, organization_id, domain_verified)
         VALUES ('tenant-row', 'https://idp.test', 'idp.test', '{}', 'active', 'tenant-oidc', 'org', 1)`,
      ),
      env.DB.prepare("UPDATE user SET role = 'admin' WHERE id = 'never-flagged'"),
      env.DB.prepare(
        "INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ('membership', 'org', 'never-flagged', 'member', 1)",
      ),
    ]);
    await insertAccount("never-flagged", "tenant-oidc", "subject");

    // The organization controls its provider and who administers it, so it
    // can't sign in a platform admin, not even one it made an admin.
    await expect(canSignIn("never-flagged", null, env.DB)).resolves.toBe(false);
    await env.DB.prepare("UPDATE member SET role = 'admin' WHERE id = 'membership'").run();
    await expect(canSignIn("never-flagged", null, env.DB)).resolves.toBe(false);
    // Only their role keeps them out, so nobody may take the account over.
    await expect(identityState("never-flagged", env.DB)).resolves.toMatchObject({
      reclaimable: false,
    });
    await env.DB.prepare("UPDATE user SET role = 'user' WHERE id = 'never-flagged'").run();
    await expect(canSignIn("never-flagged", null, env.DB)).resolves.toBe(true);
  });

  it("never lets anyone take over a platform admin's account", async () => {
    // Without any identity, like a leftover user, but an admin.
    await env.DB.prepare("UPDATE user SET role = 'admin' WHERE id = 'never-flagged'").run();
    await expect(identityState("never-flagged", env.DB)).resolves.toEqual({
      linked: false,
      github: false,
      reclaimable: false,
    });
  });

  it("lets an impersonation act only while its admin can still sign in", async () => {
    await insertAccount("active", "github", "active-github");
    await insertUser("admin");
    await insertAccount("admin", "github", "admin-github");
    await env.DB.prepare("UPDATE user SET role = 'admin' WHERE id = 'admin'").run();
    const impersonation = { userId: "never-flagged", impersonatedBy: "admin" };

    await expect(sessionMayAct({ userId: "active" }, null, env.DB)).resolves.toBe(true);
    await expect(sessionMayAct({ userId: "never-flagged" }, null, env.DB)).resolves.toBe(false);
    // The impersonated account needs no way in of its own, only access.
    await expect(sessionMayAct(impersonation, null, env.DB)).resolves.toBe(true);
    await expect(
      sessionMayAct({ userId: "banned", impersonatedBy: "admin" }, null, env.DB),
    ).resolves.toBe(false);
    await env.DB.prepare("UPDATE user SET role = 'user' WHERE id = 'admin'").run();
    await expect(sessionMayAct(impersonation, null, env.DB)).resolves.toBe(false);
  });

  it("signs in through a provider only while that identity can sign the account in", async () => {
    await insertAccount("active", "github", "active-github");
    await expect(canSignIn("active", null, env.DB)).resolves.toBe(true);
    await expect(canSignIn("active", "github", env.DB)).resolves.toBe(true);
    await expect(canSignIn("active", "tenant-oidc", env.DB)).resolves.toBe(false);
    await expect(canSignIn("banned", null, env.DB)).resolves.toBe(false);
  });
});

async function insertUser(
  id: string,
  state: { banned?: boolean | null; deletedAt?: Date } = {},
): Promise<void> {
  await drizzle(env.DB).insert(user).values({
    id,
    name: id,
    email: `${id}@example.test`,
    emailVerified: true,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    ...(state.banned !== undefined ? { banned: state.banned } : {}),
    ...(state.deletedAt ? { deletedAt: state.deletedAt } : {}),
  });
}

async function insertAccount(
  userId: string,
  providerId: string,
  accountId: string,
): Promise<void> {
  await drizzle(env.DB).insert(account).values({
    id: `${userId}-${providerId}`,
    providerId,
    accountId,
    userId,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
  });
}
