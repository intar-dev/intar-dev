/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentBootstrapTokens, agentHosts } from "@/db/schema";
import { accountCredentialSweepStatements } from "@/lib/account-sign-out";
import { activeAdminSql } from "@/lib/account-access";
import { getSignupStatus } from "@/lib/signups";
import { resetD1Database } from "@/test/d1-migrations";
import { finalizePlatformUserDeletion } from "@/lib/platform-user-deletion-store";
import {
  createFixtureMember,
  ensureFixtureAdmin,
  FIXTURE_ADMIN_ID,
} from "@/test/account-fixtures";
import {
  acquireAccessRevocationCleanup,
  CLEANUP_LEASE_MS,
  completeAccessRevocationCleanup,
  recordAccessRevocationCleanupFailure,
  recordAccessRevocationCleanupStall,
  restoreAccount,
  revokeAccount,
} from "./access-revocation-store";
import {
  cleanupAccessRevocation,
  ensureAccessRevoked,
  finishAccessRevocationCleanup,
  getAccessRevocationStatus,
  restoreAccess,
  revokeAccess,
} from "./access-revocation";

const effects = vi.hoisted(() => ({
  retire: vi.fn().mockResolvedValue(undefined),
  wake: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn().mockResolvedValue(undefined),
  routes: vi.fn().mockResolvedValue(undefined),
  removeHost: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/account-sign-out", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/account-sign-out")>();
  return {
    ...actual,
    accountCredentialSweepStatements: vi.fn(actual.accountCredentialSweepStatements),
  };
});
vi.mock("@/lib/host-workload-retirement", () => ({ cleanupRemovedHost: effects.removeHost }));
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
    await seedConnectedSession();
    const first = await ensureAccessRevoked({ userId: "owner", actorUserId: FIXTURE_ADMIN_ID, reason: "admin_revoked" });
    const second = await ensureAccessRevoked({ userId: "owner", actorUserId: FIXTURE_ADMIN_ID, reason: "admin_revoked" });

    expect(second).toEqual(first);
    expect(await env.DB.prepare(
      "SELECT (SELECT count(*) FROM session) + (SELECT count(*) FROM oauth_access_token) AS count",
    ).first()).toEqual({ count: 0 });
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

  it("ends the sessions a revoked admin opened as someone else", async () => {
    await createFixtureMember({
      d1: env.DB, userId: "second-admin", role: "admin", githubAccountId: "second-admin-github",
    });
    await env.DB.prepare(
      `INSERT INTO session (id, token, user_id, impersonated_by, expires_at, created_at, updated_at)
       VALUES ('impersonation', 'impersonation-token', 'owner', 'second-admin', 9999999999999, 1, 1),
              ('owner-own', 'owner-own-token', 'owner', NULL, 9999999999999, 1, 1)`,
    ).run();

    await ensureAccessRevoked({ userId: "second-admin", actorUserId: FIXTURE_ADMIN_ID, reason: "admin_revoked" });
    expect(await env.DB.prepare("SELECT id FROM session").all().then(({ results }) => results))
      .toEqual([{ id: "owner-own" }]);
  });

  it("reports an unfinished cleanup and finishes it on retry", async () => {
    await seedConnectedSession();
    vi.mocked(accountCredentialSweepStatements).mockImplementationOnce(() => {
      throw new Error("session store unavailable");
    });
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
    expect(accountCredentialSweepStatements).not.toHaveBeenCalled();
  });
});

describe("revokeAccess", () => {
  it("refuses an account that is already revoked instead of reusing it", async () => {
    await revokeAccess({ userId: "owner", actorUserId: FIXTURE_ADMIN_ID, reason: "admin_revoked" });
    await expect(revokeAccess({ userId: "owner", actorUserId: FIXTURE_ADMIN_ID, reason: "admin_revoked" }))
      .rejects.toMatchObject({ status: 409, code: "access_already_revoked" });
    expect(await env.DB.prepare(
      "SELECT count(*) AS count FROM access_events WHERE subject_user_id = 'owner' AND event_type = 'access.blocked'",
    ).first()).toEqual({ count: 1 });
  });

  it("advances the access generation only when it revokes", async () => {
    await revokeAccess({ userId: "owner", actorUserId: FIXTURE_ADMIN_ID, reason: "admin_revoked" });
    await expect(revokeAccess({ userId: "owner", actorUserId: FIXTURE_ADMIN_ID, reason: "admin_revoked" }))
      .rejects.toMatchObject({ code: "access_already_revoked" });
    expect(await accessGeneration("owner")).toBe(1);
  });

  it("revokes pending server registrations and image preparations in its cleanup", async () => {
    await seedPendingCredentials("owner", "before");
    await revokeAccess({ userId: "owner", actorUserId: FIXTURE_ADMIN_ID, reason: "admin_revoked" });
    await expectPendingCredentialsEnded("owner", "before");
  });
});

describe("finishAccessRevocationCleanup", () => {
  it("finishes the cleanup of the named revocation", async () => {
    vi.mocked(accountCredentialSweepStatements).mockImplementationOnce(() => {
      throw new Error("session store unavailable");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      // A repeated revoke would be refused, so the message points at finishing.
      await expect(revokeAccess({ userId: "owner", actorUserId: FIXTURE_ADMIN_ID, reason: "admin_revoked" }))
        .rejects.toMatchObject({
          status: 503,
          code: "access_cleanup_incomplete",
          message: "Access is revoked, but cleanup didn't finish. Finish the cleanup to retry it.",
        });
    } finally {
      warn.mockRestore();
    }
    const pending = await getAccessRevocationStatus("owner");
    expect(pending?.cleanup).toBe("pending");

    await finishAccessRevocationCleanup({
      userId: "owner", revocationId: pending!.revocationId, actorUserId: FIXTURE_ADMIN_ID,
    });
    await expect(getAccessRevocationStatus("owner")).resolves.toMatchObject({ cleanup: "completed" });
  });

  it("reports a cleanup another attempt holds instead of an unfinished one", async () => {
    const { revocationId } = await revokeAccount({
      d1: env.DB, userId: "owner", actorUserId: FIXTURE_ADMIN_ID, reason: "admin_revoked",
    });
    await acquireAccessRevocationCleanup({ d1: env.DB, userId: "owner", revocationId });
    await expect(finishAccessRevocationCleanup({
      userId: "owner", revocationId, actorUserId: FIXTURE_ADMIN_ID,
    })).rejects.toMatchObject({ status: 409, code: "access_revocation_cleanup_in_progress" });
  });

  it("refuses a revocation that is no longer current and never revokes", async () => {
    await expect(finishAccessRevocationCleanup({
      userId: "owner", revocationId: "not-current", actorUserId: FIXTURE_ADMIN_ID,
    })).rejects.toMatchObject({ status: 409, code: "stale_access_revocation" });
    expect(await env.DB.prepare("SELECT banned FROM user WHERE id = 'owner'").first()).toEqual({ banned: 0 });
    await expect(getAccessRevocationStatus("owner")).resolves.toBeNull();
  });
});

describe("cleanup lease", () => {
  it("lets a new attempt take over a stalled one once its lease ran out", async () => {
    const { revocationId } = await revokeAccount({
      d1: env.DB, userId: "owner", actorUserId: FIXTURE_ADMIN_ID, reason: "test", now: 3_000,
    });
    const stalled = await acquireAccessRevocationCleanup({ d1: env.DB, userId: "owner", revocationId, now: 3_100 });
    if (stalled.status !== "acquired") throw new Error("expected a new cleanup attempt");
    // A stall keeps its attempt: external cleanup may still be landing.
    await recordAccessRevocationCleanupStall({
      d1: env.DB, userId: "owner", revocationId, cleanupAttemptId: stalled.cleanupAttemptId,
      reason: "ambiguous_cleanup_test", now: 3_200,
    });
    await expect(acquireAccessRevocationCleanup({
      d1: env.DB, userId: "owner", revocationId, now: 3_100 + CLEANUP_LEASE_MS - 1,
    })).rejects.toMatchObject({ status: 409, code: "access_revocation_cleanup_in_progress" });

    const takeover = await acquireAccessRevocationCleanup({
      d1: env.DB, userId: "owner", revocationId, now: 3_100 + CLEANUP_LEASE_MS,
    });
    if (takeover.status !== "acquired") throw new Error("expected a takeover");
    expect(takeover.cleanupAttemptId).not.toBe(stalled.cleanupAttemptId);

    // The abandoned attempt can no longer write anything.
    await expect(completeAccessRevocationCleanup({
      d1: env.DB, userId: "owner", revocationId, cleanupAttemptId: stalled.cleanupAttemptId,
    })).rejects.toMatchObject({ code: "stale_access_revocation" });
    await expect(recordAccessRevocationCleanupFailure({
      d1: env.DB, userId: "owner", revocationId, cleanupAttemptId: stalled.cleanupAttemptId,
      reason: "cleanup_late",
    })).rejects.toMatchObject({ code: "stale_access_revocation" });
    await completeAccessRevocationCleanup({
      d1: env.DB, userId: "owner", revocationId, cleanupAttemptId: takeover.cleanupAttemptId,
      now: 3_100 + CLEANUP_LEASE_MS + 1,
    });
    await expect(getAccessRevocationStatus("owner")).resolves.toMatchObject({ cleanup: "completed" });
  });
});

describe("restoring access", () => {
  it("restores a revoked account as a fresh start", async () => {
    await seedFreshStartState();
    const { revocationId } = await revokeAccess({
      userId: "owner", actorUserId: FIXTURE_ADMIN_ID, reason: "admin_revoked",
    });
    // Credentials that raced in after the cleanup, and an app another person
    // connected to one of the owner's apps.
    await seedPendingCredentials("owner", "late");

    await expect(restoreAccess({ userId: "owner", actorUserId: FIXTURE_ADMIN_ID, revocationId }))
      .resolves.toEqual({ serversPendingCleanup: 0 });

    expect(await env.DB.prepare(
      `SELECT banned, ban_reason, ban_expires, role, metal_placement, access_generation
       FROM user WHERE id = 'owner'`,
    ).first()).toEqual({
      banned: 0, ban_reason: null, ban_expires: null, role: "user",
      metal_placement: "platform", access_generation: 1,
    });
    await expect(getAccessRevocationStatus("owner")).resolves.toBeNull();
    expect(await env.DB.prepare(
      `SELECT event_type, actor_user_id, revocation_id, reason, github_account_id
       FROM access_events WHERE subject_user_id = 'owner' AND event_type = 'access.restored'`,
    ).all().then(({ results }) => results)).toEqual([{
      event_type: "access.restored", actor_user_id: FIXTURE_ADMIN_ID, revocation_id: revocationId,
      reason: "admin_restored", github_account_id: "owner-github",
    }]);
    await expectPendingCredentialsEnded("owner", "late");
    expect(await count("SELECT count(*) AS count FROM user_ssh_keys WHERE user_id = 'owner'")).toBe(0);
    expect(await count("SELECT count(*) AS count FROM oauth_client WHERE client_id = 'owner-app'")).toBe(0);
    // Their app's grants to other people go with it.
    expect(await count("SELECT count(*) AS count FROM oauth_consent WHERE user_id = 'bystander'")).toBe(0);
    // The organization they alone own keeps them; other memberships go.
    expect(await env.DB.prepare(
      "SELECT organization_id FROM member WHERE user_id = 'owner' ORDER BY organization_id",
    ).all().then(({ results }) => results)).toEqual([{ organization_id: "owned-org" }]);
    expect(await count("SELECT count(*) AS count FROM member WHERE user_id = 'bystander'")).toBe(2);
    expect(await env.DB.prepare(
      `SELECT disabled, owner_removal_id IS NOT NULL AS removing,
              owner_removal_completed_at IS NOT NULL AS removed
       FROM agent_hosts WHERE id = 'owner-personal'`,
    ).first()).toEqual({ disabled: 1, removing: 1, removed: 1 });
    expect(effects.removeHost.mock.calls).toEqual([["owner-personal"]]);
    // The identities stay, and nobody else's access changed.
    expect(await count("SELECT count(*) AS count FROM account WHERE user_id = 'owner'")).toBe(1);
    expect(await count("SELECT count(*) AS count FROM session WHERE user_id = 'bystander'")).toBe(1);
  });

  it("makes a restored administrator a user", async () => {
    await createFixtureMember({ d1: env.DB, userId: "second-admin", role: "admin", githubAccountId: "second-admin-github" });
    const { revocationId } = await revokeAccess({
      userId: "second-admin", actorUserId: FIXTURE_ADMIN_ID, reason: "admin_revoked",
    });
    await restoreAccess({ userId: "second-admin", actorUserId: FIXTURE_ADMIN_ID, revocationId });
    expect(await env.DB.prepare("SELECT banned, role FROM user WHERE id = 'second-admin'").first())
      .toEqual({ banned: 0, role: "user" });
  });

  it("reports servers whose removal cleanup didn't finish", async () => {
    await seedFreshStartState();
    const { revocationId } = await revokeAccess({
      userId: "owner", actorUserId: FIXTURE_ADMIN_ID, reason: "admin_revoked",
    });
    effects.removeHost.mockRejectedValueOnce(new Error("host unreachable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(restoreAccess({ userId: "owner", actorUserId: FIXTURE_ADMIN_ID, revocationId }))
        .resolves.toEqual({ serversPendingCleanup: 1 });
    } finally {
      warn.mockRestore();
    }
    expect(await env.DB.prepare(
      `SELECT owner_removal_id IS NOT NULL AS removing, owner_removal_completed_at AS completed
       FROM agent_hosts WHERE id = 'owner-personal'`,
    ).first()).toEqual({ removing: 1, completed: null });
    expect(await env.DB.prepare("SELECT banned FROM user WHERE id = 'owner'").first()).toEqual({ banned: 0 });
  });

  it("refuses until the revocation cleanup finished, and writes nothing", async () => {
    const { revocationId } = await revokeAccount({
      d1: env.DB, userId: "owner", actorUserId: FIXTURE_ADMIN_ID, reason: "admin_revoked",
    });
    await expect(restoreAccount({ d1: env.DB, userId: "owner", actorUserId: FIXTURE_ADMIN_ID, revocationId }))
      .rejects.toMatchObject({ status: 409, code: "access_cleanup_incomplete" });
    await acquireAccessRevocationCleanup({ d1: env.DB, userId: "owner", revocationId });
    await expect(restoreAccount({ d1: env.DB, userId: "owner", actorUserId: FIXTURE_ADMIN_ID, revocationId }))
      .rejects.toMatchObject({ status: 409, code: "access_cleanup_incomplete" });
    expect(await env.DB.prepare("SELECT banned FROM user WHERE id = 'owner'").first()).toEqual({ banned: 1 });
    expect(await count("SELECT count(*) AS count FROM access_events WHERE event_type = 'access.restored'")).toBe(0);
  });

  it("refuses a revocation id that isn't the current one", async () => {
    const first = await revokeAccess({ userId: "owner", actorUserId: FIXTURE_ADMIN_ID, reason: "admin_revoked" });
    await restoreAccess({ userId: "owner", actorUserId: FIXTURE_ADMIN_ID, revocationId: first.revocationId });
    const second = await revokeAccess({ userId: "owner", actorUserId: FIXTURE_ADMIN_ID, reason: "admin_revoked" });
    expect(second.revocationId).not.toBe(first.revocationId);
    expect(await accessGeneration("owner")).toBe(2);

    // A delayed restore of the first revocation can't undo the second.
    await expect(restoreAccess({ userId: "owner", actorUserId: FIXTURE_ADMIN_ID, revocationId: first.revocationId }))
      .rejects.toMatchObject({ status: 409, code: "stale_access_revocation" });
    expect(await env.DB.prepare("SELECT banned FROM user WHERE id = 'owner'").first()).toEqual({ banned: 1 });
  });

  it("reports a repeated restore as done, and one of two concurrent restores wins", async () => {
    const { revocationId } = await revokeAccess({
      userId: "owner", actorUserId: FIXTURE_ADMIN_ID, reason: "admin_revoked",
    });
    const outcomes = await Promise.all([
      restoreAccount({ d1: env.DB, userId: "owner", actorUserId: FIXTURE_ADMIN_ID, revocationId }),
      restoreAccount({ d1: env.DB, userId: "owner", actorUserId: FIXTURE_ADMIN_ID, revocationId }),
    ]);
    expect(outcomes.sort()).toEqual(["already_restored", "restored"]);
    await expect(restoreAccount({ d1: env.DB, userId: "owner", actorUserId: FIXTURE_ADMIN_ID, revocationId }))
      .resolves.toBe("already_restored");
    expect(await count("SELECT count(*) AS count FROM access_events WHERE event_type = 'access.restored'")).toBe(1);
  });

  it("refuses accounts that aren't revoked, missing or deleted users, and non-admin actors", async () => {
    await expect(restoreAccount({ d1: env.DB, userId: "owner", actorUserId: FIXTURE_ADMIN_ID, revocationId: "none" }))
      .rejects.toMatchObject({ status: 409, code: "access_not_revoked" });
    await expect(restoreAccount({ d1: env.DB, userId: "missing", actorUserId: FIXTURE_ADMIN_ID, revocationId: "none" }))
      .rejects.toMatchObject({ status: 404, code: "user_not_found" });

    const { revocationId } = await revokeAccess({
      userId: "owner", actorUserId: FIXTURE_ADMIN_ID, reason: "admin_revoked",
    });
    await createFixtureMember({ d1: env.DB, userId: "member", githubAccountId: "member-github" });
    await expect(restoreAccount({ d1: env.DB, userId: "owner", actorUserId: "member", revocationId }))
      .rejects.toMatchObject({ status: 403 });
    await createFixtureMember({ d1: env.DB, userId: "revoked-admin", role: "admin", githubAccountId: "revoked-admin-github" });
    await revokeAccess({ userId: "revoked-admin", actorUserId: FIXTURE_ADMIN_ID, reason: "admin_revoked" });
    await expect(restoreAccount({ d1: env.DB, userId: "owner", actorUserId: "revoked-admin", revocationId }))
      .rejects.toMatchObject({ status: 403 });

    await env.DB.prepare("UPDATE user SET deleted_at = 1 WHERE id = 'owner'").run();
    await expect(restoreAccount({ d1: env.DB, userId: "owner", actorUserId: FIXTURE_ADMIN_ID, revocationId }))
      .rejects.toMatchObject({ status: 404, code: "user_not_found" });
    expect(await count("SELECT count(*) AS count FROM access_events WHERE event_type = 'access.restored'")).toBe(0);
  });

  it("needs a new revocation before a restored account can be deleted", async () => {
    const { revocationId } = await revokeAccess({
      userId: "owner", actorUserId: FIXTURE_ADMIN_ID, reason: "admin_revoked",
    });
    await restoreAccess({ userId: "owner", actorUserId: FIXTURE_ADMIN_ID, revocationId });
    await expect(finalizePlatformUserDeletion({
      d1: env.DB, targetUserId: "owner", actorUserId: FIXTURE_ADMIN_ID,
    })).rejects.toMatchObject({ status: 409, code: "platform_user_access_active" });
    expect(await env.DB.prepare("SELECT deleted_at FROM user WHERE id = 'owner'").first()).toEqual({ deleted_at: null });
  });
});

async function count(query: string): Promise<number> {
  const row = await env.DB.prepare(query).first<{ count: number }>();
  return row?.count ?? 0;
}

async function accessGeneration(userId: string): Promise<number | undefined> {
  const row = await env.DB.prepare("SELECT access_generation FROM user WHERE id = ?1")
    .bind(userId)
    .first<{ access_generation: number }>();
  return row?.access_generation;
}

/** Credentials the owner holds or can redeem, named by `tag`. */
async function seedPendingCredentials(userId: string, tag: string): Promise<void> {
  const far = 9_999_999_999_999;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO agent_hosts (id, user_id, name, scope, credential_generation)
       VALUES (?1 || '-prep-host', ?1, 'Prep host', 'platform', 1)`,
    ).bind(userId),
    env.DB.prepare(
      `INSERT INTO session (id, token, user_id, expires_at, created_at, updated_at)
       VALUES (?1 || '-' || ?2 || '-session', ?1 || '-' || ?2 || '-token', ?1, ?3, 1, 1)`,
    ).bind(userId, tag, far),
    env.DB.prepare(
      `INSERT OR IGNORE INTO oauth_client (id, client_id, redirect_uris)
       VALUES ('sweep-app-row', 'sweep-app', '["http://localhost/callback"]')`,
    ),
    env.DB.prepare(
      `INSERT INTO oauth_consent (id, client_id, user_id, scopes)
       VALUES (?1 || '-' || ?2 || '-consent', 'sweep-app', ?1, '["openid"]')`,
    ).bind(userId, tag),
    env.DB.prepare(
      `INSERT INTO verification (id, identifier, value, expires_at)
       VALUES (?1 || '-' || ?2 || '-code', ?1 || '-' || ?2 || '-code',
               json_object('type', 'authorization_code', 'userId', ?1), ?3)`,
    ).bind(userId, tag, far),
    env.DB.prepare(
      `INSERT INTO host_enrollments (token_hash, host_id, user_id, name, scope, role, expires_at)
       VALUES (?1 || '-' || ?2 || '-enrollment', ?1 || '-' || ?2 || '-enrolled-host', ?1,
               'Pending', 'personal', 'agent', ?3)`,
    ).bind(userId, tag, far),
    env.DB.prepare(
      `INSERT OR REPLACE INTO personal_image_preparations
         (user_id, host_id, credential_generation, request_key, access_json, images_json, expires_at)
       VALUES (?1, ?1 || '-prep-host', 1, ?2, '{}', '[]', ?3)`,
    ).bind(userId, tag, far),
  ]);
}

async function expectPendingCredentialsEnded(userId: string, tag: string): Promise<void> {
  expect(await env.DB.prepare(
    `SELECT
       (SELECT count(*) FROM session WHERE user_id = ?1) AS sessions,
       (SELECT count(*) FROM oauth_consent WHERE user_id = ?1) AS consents,
       (SELECT count(*) FROM verification WHERE id = ?1 || '-' || ?2 || '-code') AS codes,
       (SELECT count(*) FROM host_enrollments
         WHERE token_hash = ?1 || '-' || ?2 || '-enrollment' AND revoked_at IS NULL) AS enrollments,
       (SELECT count(*) FROM personal_image_preparations WHERE user_id = ?1) AS preparations`,
  ).bind(userId, tag).first()).toEqual({
    sessions: 0, consents: 0, codes: 0, enrollments: 0, preparations: 0,
  });
}

/**
 * The owner with a personal server on personal placement, an SSH key, an app
 * a bystander connected to, their own organization and a membership in the
 * bystander's.
 */
async function seedFreshStartState(): Promise<void> {
  await createFixtureMember({ d1: env.DB, userId: "bystander", githubAccountId: "bystander-github" });
  await env.DB.batch([
    env.DB.prepare("UPDATE user SET metal_placement = 'personal' WHERE id = 'owner'"),
    env.DB.prepare(
      `INSERT INTO agent_hosts (id, user_id, name, scope, credential_generation)
       VALUES ('owner-personal', 'owner', 'Owner personal', 'personal', 1)`,
    ),
    env.DB.prepare(
      `INSERT INTO user_ssh_keys (id, user_id, key_type, public_key_openssh, fingerprint_sha256)
       VALUES ('owner-key', 'owner', 'ssh-ed25519', 'ssh-ed25519 AAAA owner', 'SHA256:owner')`,
    ),
    env.DB.prepare(
      `INSERT INTO oauth_client (id, client_id, user_id, redirect_uris)
       VALUES ('owner-app-row', 'owner-app', 'owner', '["http://localhost/callback"]')`,
    ),
    env.DB.prepare(
      `INSERT INTO oauth_consent (id, client_id, user_id, scopes)
       VALUES ('bystander-consent', 'owner-app', 'bystander', '["openid"]')`,
    ),
    env.DB.prepare(
      `INSERT INTO organization (id, name, slug, created_at)
       VALUES ('owned-org', 'Owned', 'owned', 1), ('bystander-org', 'Bystander', 'bystander', 1)`,
    ),
    env.DB.prepare(
      `INSERT INTO member (id, organization_id, user_id, role, created_at)
       VALUES ('owner-owns', 'owned-org', 'owner', 'owner', 1),
              ('owner-joins', 'bystander-org', 'owner', 'member', 1),
              ('bystander-owns', 'bystander-org', 'bystander', 'owner', 1),
              ('bystander-joins', 'owned-org', 'bystander', 'member', 1)`,
    ),
    env.DB.prepare(
      `INSERT INTO session (id, token, user_id, expires_at, created_at, updated_at)
       VALUES ('bystander-session', 'bystander-token', 'bystander', 9999999999999, 1, 1)`,
    ),
  ]);
}

/** Two sessions of the owner, one with an app connected through it. */
async function seedConnectedSession(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO session (id, token, user_id, expires_at, created_at, updated_at)
       VALUES ('owner-app-session', 'owner-app-session-token', 'owner', 9999999999999, 1, 1),
              ('owner-session', 'owner-session-token', 'owner', 9999999999999, 1, 1)`,
    ),
    env.DB.prepare(
      `INSERT INTO oauth_client (id, client_id, redirect_uris)
       VALUES ('app-row', 'app', '["http://localhost/callback"]')`,
    ),
    env.DB.prepare(
      `INSERT INTO oauth_access_token (id, token, client_id, session_id, user_id, expires_at, scopes)
       VALUES ('app-access', 'app-access-token', 'app', 'owner-app-session', 'owner', 9999999999999, '["openid"]')`,
    ),
  ]);
}

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
