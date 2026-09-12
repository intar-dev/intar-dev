/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { user } from "@/db/schema";
import { revokeBetaUser } from "@/lib/beta-access-revocation-store";
import { resetD1Database } from "@/test/d1-migrations";
import {
  FIXTURE_BETA_ADMIN_ID,
  grantFixtureBetaAccess,
} from "@/test/beta-access-fixtures";
import { issueBetaAccessFencedRoute } from "./beta-route-issuance";

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
  await grantFixtureBetaAccess({ d1: env.DB, userId, now });
});

describe("beta-fenced route issuance against stored access", () => {
  it("refuses a revoked user before Stargate is called", async () => {
    await revokeBetaUser({
      d1: env.DB,
      userId,
      actorUserId: FIXTURE_BETA_ADMIN_ID,
      reason: "security_test",
      now: Date.now() + 1,
    });
    const issue = vi.fn();
    const revoke = vi.fn();

    await expect(
      issueBetaAccessFencedRoute({
        userId,
        routeId,
        issue,
        issuedRouteIds: () => [],
        revoke,
      }),
    ).rejects.toMatchObject({ code: "beta_access_revoked", status: 403 });
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
    const issuance = issueBetaAccessFencedRoute({
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
    await revokeBetaUser({
      d1: env.DB,
      userId,
      actorUserId: FIXTURE_BETA_ADMIN_ID,
      reason: "security_test",
      now: Date.now() + 1,
    });
    releaseIssue();

    await expect(issuance).rejects.toMatchObject({
      code: "beta_access_revoked",
      status: 403,
    });
    expect(revoke).toHaveBeenCalledWith(routeId);
    expect(revoke).toHaveBeenCalledWith("run-1-webserver-ssh-issued");
  });
});
