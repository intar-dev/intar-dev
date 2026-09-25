/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import {
  member,
  organization,
  session,
  user,
} from "@/db/schema";
import { isActiveAccount } from "@/lib/account-access";
import { signedSessionCookie } from "@/test/auth-requests";
import { resetD1Database } from "@/test/d1-migrations";
import {
  ensureFixtureMember,
  FIXTURE_ADMIN_ID,
  revokeFixtureAccount,
} from "@/test/account-fixtures";
import { jsonResponse, requireUserContext } from "./agent-bridge";

const db = drizzle(env.DB);

beforeEach(async () => {
  await resetD1Database();
});

describe("jsonResponse", () => {
  it("preserves Headers instances while supplying the JSON content type", () => {
    const headers = new Headers({ "retry-after": "60" });

    const response = jsonResponse(
      { error: "rate limited" },
      { status: 429, headers },
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
  });

  it("does not overwrite an explicitly supplied content type", () => {
    const response = jsonResponse(
      { ok: true },
      { headers: { "content-type": "application/problem+json" } },
    );

    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
  });
});

describe("requireUserContext", () => {
  it.each([
    {
      name: "an active user without memberships",
      organizationIds: [],
      activeOrganizationId: null,
      expectedActiveOrganizationId: null,
      account: "active",
      expired: false,
      status: 200,
    },
    {
      name: "all memberships and the selected organization",
      organizationIds: ["first-organization", "second-organization"],
      activeOrganizationId: "second-organization",
      expectedActiveOrganizationId: "second-organization",
      account: "active",
      expired: false,
      status: 200,
    },
    {
      name: "a stale active organization without granting membership",
      organizationIds: ["first-organization", "second-organization"],
      activeOrganizationId: "unrelated-organization",
      expectedActiveOrganizationId: null,
      account: "active",
      expired: false,
      status: 200,
    },
    {
      name: "membership of a banned account",
      organizationIds: ["first-organization"],
      activeOrganizationId: "first-organization",
      expectedActiveOrganizationId: null,
      account: "banned",
      expired: false,
      status: 403,
    },
    {
      name: "membership of a deleted account",
      organizationIds: ["first-organization"],
      activeOrganizationId: "first-organization",
      expectedActiveOrganizationId: null,
      account: "deleted",
      expired: false,
      status: 403,
    },
    {
      name: "a session of an account no identity can sign in to",
      organizationIds: [],
      activeOrganizationId: null,
      expectedActiveOrganizationId: null,
      account: "no-identity",
      expired: false,
      status: 403,
    },
    {
      name: "an admin's impersonation of such an account",
      organizationIds: [],
      activeOrganizationId: null,
      expectedActiveOrganizationId: null,
      account: "impersonated-no-identity",
      expired: false,
      status: 200,
    },
    {
      name: "an impersonation whose admin is no longer one",
      organizationIds: [],
      activeOrganizationId: null,
      expectedActiveOrganizationId: null,
      account: "impersonated-by-former-admin",
      expired: false,
      status: 403,
    },
    {
      name: "an expired session of an active account",
      organizationIds: [],
      activeOrganizationId: null,
      expectedActiveOrganizationId: null,
      account: "active",
      expired: true,
      status: 401,
    },
  ])("handles $name", async (testCase) => {
    const now = Date.now();
    const userId = "context-user";
    await db.insert(user).values({
      id: userId,
      name: "Context User",
      email: "context-user@example.test",
      emailVerified: true,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    await ensureFixtureMember({
      d1: env.DB,
      userId,
      githubAccountId: "context-github-account",
      now,
    });
    for (const organizationId of testCase.organizationIds) {
      await db.insert(organization).values({
        id: organizationId,
        name: organizationId,
        slug: organizationId,
        createdAt: new Date(now),
      });
      await db.insert(member).values({
        id: `${organizationId}-membership`,
        userId,
        organizationId,
        role: "member",
        createdAt: new Date(now),
      });
    }
    const sessionToken = "context-session-token";
    await db.insert(session).values({
      id: "context-session",
      token: sessionToken,
      userId,
      expiresAt: new Date(now + (testCase.expired ? -1_000 : 3_600_000)),
      createdAt: new Date(now),
      updatedAt: new Date(now),
      activeOrganizationId: testCase.activeOrganizationId,
      impersonatedBy: testCase.account.startsWith("impersonated")
        ? FIXTURE_ADMIN_ID
        : null,
    });
    if (testCase.account.endsWith("no-identity")) {
      await env.DB.prepare("DELETE FROM account WHERE user_id = ?1")
        .bind(userId)
        .run();
    }
    if (testCase.account === "impersonated-by-former-admin") {
      await env.DB.prepare("UPDATE user SET role = 'user' WHERE id = ?1")
        .bind(FIXTURE_ADMIN_ID)
        .run();
    }
    if (testCase.account === "banned") {
      await revokeFixtureAccount({ d1: env.DB, userId });
    }
    if (testCase.account === "deleted") {
      await env.DB.prepare("UPDATE user SET deleted_at = ?1 WHERE id = ?2")
        .bind(now, userId)
        .run();
    }

    const result = await requireUserContext(
      new Request("http://localhost/api/agent", {
        headers: { cookie: await signedSessionCookie(sessionToken) },
      }),
    );
    if (testCase.status !== 200) {
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unauthorized user was admitted");
      expect(result.response.status).toBe(testCase.status);
      if (testCase.status === 403) {
        await expect(result.response.json()).resolves.toEqual({
          error: "access revoked",
          code: "access_revoked",
        });
      }
      return;
    }
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("active user was rejected");
    expect(result.context.organizationIds.toSorted()).toEqual(
      testCase.organizationIds.toSorted(),
    );
    expect(result.context.activeOrganizationId).toBe(
      testCase.expectedActiveOrganizationId,
    );
    expect(Object.keys(result.context).toSorted()).toEqual([
      "activeOrganizationId",
      "isAdmin",
      "organizationIds",
      "role",
      "sessionId",
      "userId",
    ]);
  });

  it("authorizes only the active Better Auth user id and never organization membership", async () => {
    const now = Date.now();
    const userId = "member-user-id";
    const githubUsername = "same-as-a-possible-username";
    const githubAccountId = "github-account-123";

    await db.insert(user).values({
      id: userId,
      name: "Member User",
      email: "member-user@example.test",
      emailVerified: true,
      username: githubUsername,
      displayUsername: githubUsername,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    await ensureFixtureMember({
      d1: env.DB,
      userId,
      githubAccountId,
      now,
    });
    await db.insert(organization).values({
      id: "organization-id",
      name: "Member Organization",
      slug: "member-organization",
      createdAt: new Date(now),
    });
    await db.insert(member).values({
      id: "membership-id",
      organizationId: "organization-id",
      userId,
      role: "member",
      createdAt: new Date(now),
    });

    const sessionToken = "agent-bridge-session-token";
    await db.insert(session).values({
      id: "agent-bridge-session-id",
      token: sessionToken,
      userId,
      expiresAt: new Date(now + 3_600_000),
      createdAt: new Date(now),
      updatedAt: new Date(now),
      activeOrganizationId: "organization-id",
    });
    const request = new Request("http://localhost/api/agent", {
      headers: { cookie: await signedSessionCookie(sessionToken) },
    });

    await expect(isActiveAccount(userId)).resolves.toBe(true);
    // A username-shaped lookup is deliberately not an authorization alias.
    await expect(isActiveAccount(githubUsername)).resolves.toBe(false);

    const active = await requireUserContext(request);
    expect(active).toMatchObject({
      ok: true,
      context: {
        userId,
        organizationIds: ["organization-id"],
        activeOrganizationId: "organization-id",
      },
    });

    await revokeFixtureAccount({ d1: env.DB, userId });

    const blocked = await requireUserContext(request);
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("revoked user was authorized");
    expect(blocked.response.status).toBe(403);
    await expect(blocked.response.json()).resolves.toEqual({
      error: "access revoked",
      code: "access_revoked",
    });
  });
});
