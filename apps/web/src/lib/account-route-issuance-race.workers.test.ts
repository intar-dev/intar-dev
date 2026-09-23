/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { user } from "@/db/schema";
import { resetD1Database } from "@/test/d1-migrations";
import {
  ensureFixtureMember,
  revokeFixtureAccount,
} from "@/test/account-fixtures";
import { issueAccountFencedRoute } from "./account-route-issuance";

const db = drizzle(env.DB);
const userId = "race-user";
const routeId = "run-1-webserver-ssh";

beforeEach(async () => {
  await resetD1Database();
  const now = Date.now();
  await db.insert(user).values({
    id: userId,
    name: "Race User",
    email: "race-user@example.test",
    emailVerified: true,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  });
  await ensureFixtureMember({ d1: env.DB, userId, now });
});

describe("account-fenced route issuance against stored access", () => {
  it("refuses a revoked user before Stargate is called", async () => {
    await revokeFixtureAccount({ d1: env.DB, userId });
    const issue = vi.fn();
    const revoke = vi.fn();

    await expect(
      issueAccountFencedRoute({
        userId,
        routeId,
        issue,
        issuedRouteIds: () => [],
        revoke,
      }),
    ).rejects.toMatchObject({ code: "access_revoked", status: 403 });
    expect(issue).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it("deletes an issued route when access is revoked while Stargate is pending", async () => {
    let releaseIssue = () => {};
    const issuePending = new Promise<void>((resolve) => {
      releaseIssue = resolve;
    });
    let signalIssueEntered = () => {};
    const issueEntered = new Promise<void>((resolve) => {
      signalIssueEntered = resolve;
    });
    const revoke = vi.fn(async () => {});
    const issuance = issueAccountFencedRoute({
      userId,
      routeId,
      issue: async () => {
        signalIssueEntered();
        await issuePending;
        return { routeUsername: "run-1-webserver-ssh-issued" };
      },
      issuedRouteIds: (result) => [result.routeUsername],
      revoke,
    });

    // The fence already admitted this request; the revocation must now be
    // caught by the post-issuance read while Stargate is still in flight.
    await issueEntered;
    await revokeFixtureAccount({ d1: env.DB, userId });
    releaseIssue();

    await expect(issuance).rejects.toMatchObject({
      code: "access_revoked",
      status: 403,
    });
    expect(revoke).toHaveBeenCalledWith(routeId);
    expect(revoke).toHaveBeenCalledWith("run-1-webserver-ssh-issued");
  });
});
