/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import {
  accessAllowlist,
  accessRequests,
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
  session,
  user,
} from "@/db/schema";
import { resetD1Database } from "@/test/d1-migrations";
import { decideAccessRequest } from "./access-requests";
import { isAllowlisted } from "./allowlist";

describe("access revocation", () => {
  beforeEach(async () => {
    await resetD1Database();
  });

  it("stores an approval in the strongly-consistent D1 allowlist", async () => {
    const db = drizzle(env.DB);
    await db.insert(user).values({
      id: "admin-approve",
      name: "Admin User",
      email: "admin-approve@example.com",
      username: "admin-approve",
    });
    await db.insert(accessRequests).values({
      id: "request-approve",
      githubUsername: "approved-user",
      status: "pending",
    });

    await decideAccessRequest({
      id: "request-approve",
      decision: "approved",
      adminUserId: "admin-approve",
    });

    await expect(isAllowlisted("APPROVED-USER")).resolves.toBe(true);
    await expect(
      db
        .select()
        .from(accessAllowlist)
        .where(eq(accessAllowlist.githubUsername, "approved-user")),
    ).resolves.toMatchObject([
      {
        githubUsername: "approved-user",
        approvedBy: "admin-approve",
      },
    ]);
  });

  it("revokes the allowlist, sessions, OAuth tokens, and consents together", async () => {
    const db = drizzle(env.DB);
    await db.insert(user).values([
      {
        id: "user-1",
        name: "Allowed User",
        email: "allowed@example.com",
        username: "allowed-user",
      },
      {
        id: "admin-1",
        name: "Admin User",
        email: "admin@example.com",
        username: "admin-user",
      },
    ]);
    await db.insert(session).values([
      {
        id: "session-1",
        token: "token-1",
        userId: "user-1",
        expiresAt: new Date(Date.now() + 60_000),
        updatedAt: new Date(),
      },
      {
        id: "session-2",
        token: "token-2",
        userId: "user-1",
        expiresAt: new Date(Date.now() + 60_000),
        updatedAt: new Date(),
      },
    ]);
    await db.insert(oauthClient).values({
      id: "oauth-client-row",
      clientId: "oauth-client",
      redirectUris: ["https://client.example/callback"],
    });
    await db.insert(oauthRefreshToken).values({
      id: "refresh-1",
      token: "refresh-token-1",
      clientId: "oauth-client",
      sessionId: "session-1",
      userId: "user-1",
      expiresAt: new Date(Date.now() + 60_000),
      scopes: ["openid"],
    });
    await db.insert(oauthAccessToken).values({
      id: "access-1",
      token: "access-token-1",
      clientId: "oauth-client",
      sessionId: "session-1",
      userId: "user-1",
      refreshId: "refresh-1",
      expiresAt: new Date(Date.now() + 60_000),
      scopes: ["openid"],
    });
    await db.insert(oauthConsent).values({
      id: "consent-1",
      clientId: "oauth-client",
      userId: "user-1",
      scopes: ["openid"],
    });
    await db.insert(accessRequests).values({
      id: "request-1",
      githubUsername: "allowed-user",
      status: "approved",
    });
    await db.insert(accessAllowlist).values({
      githubUsername: "allowed-user",
      approvedBy: "admin-1",
      approvedAt: Date.now(),
    });

    await decideAccessRequest({
      id: "request-1",
      decision: "rejected",
      adminUserId: "admin-1",
    });

    await expect(isAllowlisted("allowed-user")).resolves.toBe(false);
    await expect(
      db.select().from(session).where(eq(session.userId, "user-1")),
    ).resolves.toHaveLength(0);
    await expect(
      db
        .select()
        .from(oauthAccessToken)
        .where(eq(oauthAccessToken.userId, "user-1")),
    ).resolves.toHaveLength(0);
    await expect(
      db
        .select()
        .from(oauthRefreshToken)
        .where(eq(oauthRefreshToken.userId, "user-1")),
    ).resolves.toHaveLength(0);
    await expect(
      db
        .select()
        .from(oauthConsent)
        .where(eq(oauthConsent.userId, "user-1")),
    ).resolves.toHaveLength(0);
  });

  it("rejects stale pending state even when an approval row already exists", async () => {
    const db = drizzle(env.DB);
    await db.insert(user).values({
      id: "admin-race",
      name: "Admin User",
      email: "admin-race@example.com",
      username: "admin-race",
    });
    await db.insert(accessRequests).values({
      id: "request-race",
      githubUsername: "racing-user",
      status: "pending",
    });
    await db.insert(accessAllowlist).values({
      githubUsername: "racing-user",
      approvedBy: "admin-race",
      approvedAt: Date.now(),
    });

    await decideAccessRequest({
      id: "request-race",
      decision: "rejected",
      adminUserId: "admin-race",
    });

    await expect(isAllowlisted("racing-user")).resolves.toBe(false);
    await expect(
      db
        .select({ status: accessRequests.status })
        .from(accessRequests)
        .where(eq(accessRequests.id, "request-race")),
    ).resolves.toEqual([{ status: "rejected" }]);
  });
});
