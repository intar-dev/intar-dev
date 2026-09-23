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
  hasAnyLinkedAccount,
  hasLinkedProviderAccount,
  isActiveAccount,
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

  it("finds linked provider accounts by user", async () => {
    await insertAccount("active", "github", "active-github");
    await insertAccount("never-flagged", "tenant-oidc", "subject");

    await expect(
      hasLinkedProviderAccount("active", "github", env.DB),
    ).resolves.toBe(true);
    await expect(
      hasLinkedProviderAccount("never-flagged", "github", env.DB),
    ).resolves.toBe(false);
    await expect(
      hasLinkedProviderAccount("never-flagged", "tenant-oidc", env.DB),
    ).resolves.toBe(true);
    await expect(hasLinkedProviderAccount("", "github", env.DB)).resolves.toBe(
      false,
    );
    await expect(hasLinkedProviderAccount("active", "", env.DB)).resolves.toBe(
      false,
    );

    await expect(hasAnyLinkedAccount("active", env.DB)).resolves.toBe(true);
    await expect(hasAnyLinkedAccount("never-flagged", env.DB)).resolves.toBe(
      true,
    );
    await expect(hasAnyLinkedAccount("banned", env.DB)).resolves.toBe(false);
    await expect(hasAnyLinkedAccount("", env.DB)).resolves.toBe(false);
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
