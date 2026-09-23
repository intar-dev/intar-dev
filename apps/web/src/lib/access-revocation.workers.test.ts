/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentBootstrapTokens, agentHosts } from "@/db/schema";
import { activeAdminSql } from "@/lib/platform-admin-authority";
import { getSignupStatus } from "@/lib/signups";
import { resetD1Database } from "@/test/d1-migrations";
import {
  createFixtureMember,
  ensureFixtureAdmin,
  FIXTURE_ADMIN_ID,
} from "@/test/account-fixtures";
import {
  acquireAccessRevocationCleanup,
  completeAccessRevocationCleanup,
  recordAccessRevocationCleanupFailure,
  revokeAccount,
} from "./access-revocation-store";
import {
  cleanupAccessRevocation,
  ensureAccessRevoked,
  getAccessRevocationStatus,
} from "./access-revocation";

const effects = vi.hoisted(() => ({
  retire: vi.fn().mockResolvedValue(undefined),
  wake: vi.fn().mockResolvedValue(undefined),
  sessions: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn().mockResolvedValue(undefined),
  routes: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/auth", () => ({
  auth: { $context: Promise.resolve({ internalAdapter: { deleteUserSessions: effects.sessions } }) },
}));
vi.mock("@/lib/host-runtime-wake", () => ({ retireHostRuntime: effects.retire, wakeHostRuntime: effects.wake }));
vi.mock("@/lib/scenario-runs", () => ({
  destroyScenarioRunForUser: effects.destroy,
  revokeScenarioRoutesForUser: effects.routes,
}));

beforeEach(async () => {
  vi.clearAllMocks();
  await resetD1Database();
  await ensureFixtureAdmin(env.DB, 1_000);
  await createFixtureMember({
    d1: env.DB, userId: "owner", githubAccountId: "owner-github", now: 2_000,
  });
});

describe("revokeAccount", () => {
  it("bans the account and records the revocation in one batch", async () => {
    const revocation = await revokeAccount({
      d1: env.DB, userId: "owner", actorUserId: FIXTURE_ADMIN_ID, reason: "test", now: 5_000,
    });

    // A NULL expiry keeps Better Auth from lifting the ban at sign-in.
    expect(await env.DB.prepare("SELECT banned, ban_reason, ban_expires FROM user WHERE id = 'owner'").first())
      .toEqual({ banned: 1, ban_reason: "access_revoked", ban_expires: null });
    expect(await env.DB.prepare(
      `SELECT revocation_id, revoked_by, reason, revoked_at, cleanup_attempt_id,
              cleanup_started_at, cleanup_completed_at
       FROM access_revocations WHERE user_id = 'owner'`,
    ).first()).toEqual({
      revocation_id: revocation.revocationId, revoked_by: FIXTURE_ADMIN_ID, reason: "test",
      revoked_at: 5_000, cleanup_attempt_id: null, cleanup_started_at: null, cleanup_completed_at: null,
    });
    expect(await env.DB.prepare(
      `SELECT event_type, invite_id, github_account_id, actor_user_id, revocation_id, reason, created_at
       FROM access_events WHERE subject_user_id = 'owner'`,
    ).all().then(({ results }) => results)).toEqual([{
      event_type: "access.blocked", invite_id: null, github_account_id: "owner-github",
      actor_user_id: FIXTURE_ADMIN_ID, revocation_id: revocation.revocationId, reason: "test", created_at: 5_000,
    }]);
  });

  it("revokes personal hosts without disabling the admin's platform fleet", async () => {
    const db = drizzle(env.DB);
    for (const scope of ["personal", "platform"] as const) {
      await db.insert(agentHosts).values({
        id: scope, name: scope, userId: "owner", scope, credentialGeneration: 1,
        connected: true, activeSessionId: "session",
      });
      await db.insert(agentBootstrapTokens).values({
        id: scope, hostId: scope, tokenHash: scope, credentialGeneration: 1,
      });
    }
    const revocation = await revokeAccount({
      d1: env.DB, userId: "owner", actorUserId: FIXTURE_ADMIN_ID, reason: "test",
    });
    // In-flight host reports must lose authority before deferred cleanup starts.
    expect(await env.DB.prepare("SELECT disabled, credential_generation, active_session_id FROM agent_hosts WHERE id = 'personal'").first())
      .toEqual({ disabled: 1, credential_generation: 2, active_session_id: null });
    expect((await env.DB.prepare("SELECT revoked_at FROM agent_bootstrap_tokens WHERE host_id = 'personal'").first())?.revoked_at)
      .not.toBeNull();
    await cleanupAccessRevocation({
      userId: "owner", revocationId: revocation.revocationId, actorUserId: FIXTURE_ADMIN_ID,
    });
    expect(await env.DB.prepare("SELECT disabled, credential_generation, active_session_id FROM agent_hosts WHERE id = 'platform'").first())
      .toEqual({ disabled: 0, credential_generation: 1, active_session_id: "session" });
    expect(await env.DB.prepare("SELECT revoked_at FROM agent_bootstrap_tokens WHERE host_id = 'platform'").first())
      .toEqual({ revoked_at: null });
    expect(await env.DB.prepare("SELECT disabled, credential_generation, active_session_id FROM agent_hosts WHERE id = 'personal'").first())
      .toEqual({ disabled: 1, credential_generation: 2, active_session_id: null });
    expect(effects.retire.mock.calls).toEqual([["personal"]]);
    expect(effects.wake.mock.calls).toEqual([["personal"]]);
    expect(effects.wake.mock.invocationCallOrder[0]).toBeGreaterThan(effects.retire.mock.invocationCallOrder[0]!);
    await expect(getAccessRevocationStatus("owner")).resolves.toEqual({
      revocationId: revocation.revocationId, cleanup: "completed",
    });
  });

  it("does not invalidate host credentials when the actor cannot revoke access", async () => {
    const db = drizzle(env.DB);
    await db.insert(agentHosts).values({
      id: "personal", name: "Personal", userId: "owner", scope: "personal",
      connected: true, activeSessionId: "session", credentialGeneration: 1,
    });
    await expect(revokeAccount({
      d1: env.DB, userId: "owner", actorUserId: "owner", reason: "test",
    })).rejects.toMatchObject({ status: 403, code: "admin_required" });
    expect(await env.DB.prepare("SELECT disabled, credential_generation, active_session_id FROM agent_hosts WHERE id = 'personal'").first())
      .toEqual({ disabled: 0, credential_generation: 1, active_session_id: "session" });
    await expectNothingWritten("owner");
  });

  it("refuses to revoke the last active administrator and writes nothing", async () => {
    await expect(revokeAccount({
      d1: env.DB, userId: FIXTURE_ADMIN_ID, actorUserId: FIXTURE_ADMIN_ID, reason: "test",
    })).rejects.toMatchObject({ status: 409, code: "last_active_admin" });
    await expectNothingWritten(FIXTURE_ADMIN_ID);
  });

  it("keeps one active administrator when two revoke each other", async () => {
    await createFixtureMember({ d1: env.DB, userId: "second-admin", role: "admin" });

    const outcomes = await Promise.allSettled([
      revokeAccount({ d1: env.DB, userId: FIXTURE_ADMIN_ID, actorUserId: "second-admin", reason: "test" }),
      revokeAccount({ d1: env.DB, userId: "second-admin", actorUserId: FIXTURE_ADMIN_ID, reason: "test" }),
    ]);

    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(await activeAdminIds()).toHaveLength(1);
  });

  it("rejects a second revocation and a missing user", async () => {
    await revokeAccount({ d1: env.DB, userId: "owner", actorUserId: FIXTURE_ADMIN_ID, reason: "test" });

    await expect(revokeAccount({
      d1: env.DB, userId: "owner", actorUserId: FIXTURE_ADMIN_ID, reason: "test",
    })).rejects.toMatchObject({ status: 409, code: "access_already_revoked" });
    await expect(revokeAccount({
      d1: env.DB, userId: "missing", actorUserId: FIXTURE_ADMIN_ID, reason: "test",
    })).rejects.toMatchObject({ status: 404, code: "user_not_found" });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM access_events WHERE event_type = 'access.blocked'").first())
      .toEqual({ count: 1 });
  });

  it("frees the revoked member's sign-up spot", async () => {
    const before = await getSignupStatus(env.DB);

    await revokeAccount({ d1: env.DB, userId: "owner", actorUserId: FIXTURE_ADMIN_ID, reason: "test" });

    expect((await getSignupStatus(env.DB)).taken).toBe(before.taken - 1);
  });
});

describe("access revocation cleanup", () => {
  it("attempts all run shutdowns and independent host wakes when cleanup fails", async () => {
    const db = drizzle(env.DB);
    for (const id of ["personal", "shared-a", "shared-b"]) {
      await db.insert(agentHosts).values({
        id, name: id, userId: "owner", scope: id === "personal" ? "personal" : "platform", credentialGeneration: 1,
      });
    }
    for (const hostId of ["shared-a", "shared-b"]) {
      await env.DB.prepare(`INSERT INTO scenario_runs
        (run_id, user_id, host_id, scenario_id, scenario_name, title, tagline, briefing_markdown,
         objectives_json, difficulty, estimated_minutes, tags_json, hints_json, solution_markdown, vm_count, state, state_rank, state_json)
        VALUES (?, 'owner', ?, 'scenario', 'Scenario', 'Title', '', '', '[]', 'beginner', 1, '[]', '[]', '', 0, 'provisioning', 1, '{}')`)
        .bind(`run-${hostId}`, hostId).run();
    }
    const failure = new Error("run shutdown failed");
    effects.destroy.mockRejectedValueOnce(failure);
    effects.routes.mockRejectedValueOnce(new Error("route cleanup failed"));
    effects.retire.mockRejectedValueOnce(new Error("retirement response lost"));
    effects.wake.mockRejectedValueOnce(new Error("host wake failed"));
    const revocation = await revokeAccount({
      d1: env.DB, userId: "owner", actorUserId: FIXTURE_ADMIN_ID, reason: "test",
    });

    await expect(cleanupAccessRevocation({
      userId: "owner", revocationId: revocation.revocationId, actorUserId: FIXTURE_ADMIN_ID,
    })).rejects.toBe(failure);

    expect(effects.destroy.mock.calls).toHaveLength(2);
    expect(effects.destroy).toHaveBeenCalledWith({ runId: "run-shared-a", userId: "owner" });
    expect(effects.destroy).toHaveBeenCalledWith({ runId: "run-shared-b", userId: "owner" });
    expect(effects.routes).toHaveBeenCalledWith("owner");
    expect(effects.retire.mock.calls).toEqual([["personal"]]);
    expect(effects.wake.mock.calls.map(([hostId]) => hostId).sort()).toEqual(["personal", "shared-a", "shared-b"]);
    expect(effects.wake.mock.invocationCallOrder[0]).toBeGreaterThan(effects.retire.mock.invocationCallOrder[0]!);
    expect(await env.DB.prepare(
      `SELECT identity.banned, revocation.cleanup_completed_at
       FROM user AS identity JOIN access_revocations AS revocation ON revocation.user_id = identity.id
       WHERE identity.id = 'owner'`,
    ).first()).toEqual({ banned: 1, cleanup_completed_at: null });
  });

  it("fences cleanup to its current attempt", async () => {
    const { revocationId } = await revokeAccount({
      d1: env.DB, userId: "owner", actorUserId: FIXTURE_ADMIN_ID, reason: "test", now: 3_000,
    });
    const first = await acquireAccessRevocationCleanup({ d1: env.DB, userId: "owner", revocationId, now: 3_100 });
    if (first.status !== "acquired") throw new Error("expected a new cleanup attempt");
    await expect(acquireAccessRevocationCleanup({ d1: env.DB, userId: "owner", revocationId, now: 3_200 }))
      .rejects.toMatchObject({ status: 409, code: "access_revocation_cleanup_in_progress" });

    await recordAccessRevocationCleanupFailure({
      d1: env.DB, userId: "owner", revocationId, cleanupAttemptId: first.cleanupAttemptId,
      reason: "cleanup_test", now: 3_300,
    });
    const second = await acquireAccessRevocationCleanup({ d1: env.DB, userId: "owner", revocationId, now: 3_400 });
    if (second.status !== "acquired") throw new Error("expected a retried cleanup attempt");
    expect(second.cleanupAttemptId).not.toBe(first.cleanupAttemptId);

    await expect(completeAccessRevocationCleanup({
      d1: env.DB, userId: "owner", revocationId, cleanupAttemptId: first.cleanupAttemptId, now: 3_500,
    })).rejects.toMatchObject({ status: 409, code: "stale_access_revocation" });
    await completeAccessRevocationCleanup({
      d1: env.DB, userId: "owner", revocationId, cleanupAttemptId: second.cleanupAttemptId, now: 3_600,
    });
    await expect(acquireAccessRevocationCleanup({ d1: env.DB, userId: "owner", revocationId, now: 3_700 }))
      .resolves.toMatchObject({ status: "completed", cleanupAttemptId: second.cleanupAttemptId, completedAt: 3_600 });
  });
});

describe("ensureAccessRevoked", () => {
  it("revokes, cleans up, and leaves a finished revocation as it is", async () => {
    const first = await ensureAccessRevoked({ userId: "owner", actorUserId: FIXTURE_ADMIN_ID, reason: "admin_revoked" });
    const second = await ensureAccessRevoked({ userId: "owner", actorUserId: FIXTURE_ADMIN_ID, reason: "admin_revoked" });

    expect(second).toEqual(first);
    expect(effects.sessions.mock.calls).toEqual([["owner"]]);
    await expect(getAccessRevocationStatus("owner")).resolves.toEqual({
      revocationId: first.revocationId, cleanup: "completed",
    });
    expect(await env.DB.prepare(
      "SELECT event_type FROM access_events WHERE subject_user_id = 'owner' ORDER BY created_at, event_type",
    ).all().then(({ results }) => results)).toEqual([
      { event_type: "access.blocked" },
      { event_type: "access.revocation_cleanup_completed" },
    ]);
  });

  it("reports an unfinished cleanup and finishes it on retry", async () => {
    effects.sessions.mockRejectedValueOnce(new Error("session store unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(ensureAccessRevoked({ userId: "owner", actorUserId: FIXTURE_ADMIN_ID, reason: "admin_revoked" }))
        .rejects.toMatchObject({ status: 503, code: "access_cleanup_incomplete" });
    } finally {
      warn.mockRestore();
    }
    expect(await env.DB.prepare("SELECT banned FROM user WHERE id = 'owner'").first()).toEqual({ banned: 1 });
    const pending = await getAccessRevocationStatus("owner");
    expect(pending?.cleanup).toBe("pending");

    await expect(ensureAccessRevoked({ userId: "owner", actorUserId: FIXTURE_ADMIN_ID, reason: "admin_revoked" }))
      .resolves.toEqual({ revocationId: pending?.revocationId });
    await expect(getAccessRevocationStatus("owner")).resolves.toMatchObject({ cleanup: "completed" });
  });

  it("does not revoke the last active administrator", async () => {
    await expect(ensureAccessRevoked({ userId: FIXTURE_ADMIN_ID, actorUserId: FIXTURE_ADMIN_ID, reason: "admin_revoked" }))
      .rejects.toMatchObject({ status: 409, code: "last_active_admin" });
    await expect(getAccessRevocationStatus(FIXTURE_ADMIN_ID)).resolves.toBeNull();
    expect(effects.sessions).not.toHaveBeenCalled();
  });
});

async function expectNothingWritten(userId: string): Promise<void> {
  expect(await env.DB.prepare("SELECT coalesce(banned, 0) AS banned FROM user WHERE id = ?").bind(userId).first())
    .toEqual({ banned: 0 });
  expect(await env.DB.prepare("SELECT count(*) AS count FROM access_revocations").first()).toEqual({ count: 0 });
  expect(await env.DB.prepare("SELECT count(*) AS count FROM access_events").first()).toEqual({ count: 0 });
}

async function activeAdminIds(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT identity.id FROM user AS identity WHERE ${activeAdminSql("identity")} ORDER BY identity.id`,
  ).all<{ id: string }>();
  return results.map(({ id }) => id);
}
