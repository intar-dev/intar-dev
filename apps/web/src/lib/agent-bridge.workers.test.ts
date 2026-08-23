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
import { revokeBetaUser } from "@/lib/beta-access-revocation-store";
import { getBetaAccess, isActiveBetaUser } from "@/lib/allowlist";
import { auth } from "@/lib/auth";
import { resetD1Database } from "@/test/d1-migrations";
import {
  FIXTURE_BETA_ADMIN_ID,
  grantFixtureBetaAccess,
} from "@/test/beta-access-fixtures";
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
  it("authorizes only the active Better Auth user id and never organization membership", async () => {
    const now = Date.now();
    const userId = "beta-user-id";
    const githubUsername = "same-as-a-possible-username";
    const githubAccountId = "github-account-123";

    await db.insert(user).values({
      id: userId,
      name: "Beta User",
      email: "beta-user@example.test",
      emailVerified: true,
      username: githubUsername,
      displayUsername: githubUsername,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    await grantFixtureBetaAccess({
      d1: env.DB,
      userId,
      githubAccountId,
      githubUsername,
      now,
    });
    await db.insert(organization).values({
      id: "organization-id",
      name: "Beta Organization",
      slug: "beta-organization",
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

    await expect(isActiveBetaUser(userId)).resolves.toBe(true);
    // A username-shaped lookup is deliberately not an authorization alias.
    await expect(isActiveBetaUser(githubUsername)).resolves.toBe(false);
    const betaAccess = await getBetaAccess(userId);
    expect(betaAccess?.state).toBe("active");

    const active = await requireUserContext(request);
    expect(active).toMatchObject({
      ok: true,
      context: {
        userId,
        betaAdmission: {
          sourceInviteId: betaAccess!.sourceInviteId,
          sourceLeaseId: betaAccess!.sourceLeaseId,
          grantedAt: betaAccess!.grantedAt,
        },
        organizationIds: ["organization-id"],
        activeOrganizationId: "organization-id",
      },
    });

    await revokeBetaUser({
      d1: env.DB,
      userId,
      actorUserId: FIXTURE_BETA_ADMIN_ID,
      reason: "security_test",
      now: now + 2,
    });

    const blocked = await requireUserContext(request);
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("blocked beta user was authorized");
    expect(blocked.response.status).toBe(403);
    await expect(blocked.response.json()).resolves.toEqual({
      error: "access revoked",
    });
  });
});

async function signedSessionCookie(token: string): Promise<string> {
  const context = await auth.$context;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(context.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(token),
  );
  const encodedSignature = btoa(
    String.fromCharCode(...new Uint8Array(signature)),
  );
  const signedValue = encodeURIComponent(`${token}.${encodedSignature}`);
  return `${context.authCookies.sessionToken.name}=${signedValue}`;
}
