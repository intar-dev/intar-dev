/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, expect, it, vi } from "vitest";
import { agentBootstrapTokens, agentHosts, user } from "@/db/schema";
import { resetD1Database } from "@/test/d1-migrations";
import { FIXTURE_BETA_ADMIN_ID, grantFixtureBetaAccess } from "@/test/beta-access-fixtures";
import { revokeBetaUser } from "./beta-access-revocation-store";
import { cleanupBetaRevocation } from "./beta-access-revocation";

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
});

it("revokes personal hosts without disabling the admin's platform fleet", async () => {
  const db = drizzle(env.DB);
  await db.insert(user).values({ id: "owner", name: "Owner", email: "owner@example.test" });
  await grantFixtureBetaAccess({ d1: env.DB, userId: "owner" });
  for (const scope of ["personal", "platform"] as const) {
    await db.insert(agentHosts).values({
      id: scope, name: scope, userId: "owner", scope, credentialGeneration: 1,
      connected: true, activeSessionId: "session",
    });
    await db.insert(agentBootstrapTokens).values({
      id: scope, hostId: scope, tokenHash: scope, credentialGeneration: 1,
    });
  }
  const revocation = await revokeBetaUser({
    d1: env.DB, userId: "owner", actorUserId: FIXTURE_BETA_ADMIN_ID, reason: "test",
  });
  // In-flight host reports must lose authority before deferred cleanup starts.
  expect(await env.DB.prepare("SELECT disabled, credential_generation, active_session_id FROM agent_hosts WHERE id = 'personal'").first())
    .toEqual({ disabled: 1, credential_generation: 2, active_session_id: null });
  expect((await env.DB.prepare("SELECT revoked_at FROM agent_bootstrap_tokens WHERE host_id = 'personal'").first())?.revoked_at)
    .not.toBeNull();
  await cleanupBetaRevocation({
    userId: "owner", revocationId: revocation.revocationId, actorUserId: FIXTURE_BETA_ADMIN_ID,
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
});

it("does not invalidate host credentials when the actor cannot revoke access", async () => {
  const db = drizzle(env.DB);
  await db.insert(user).values({ id: "owner", name: "Owner", email: "owner@example.test" });
  await grantFixtureBetaAccess({ d1: env.DB, userId: "owner" });
  await db.insert(agentHosts).values({
    id: "personal", name: "Personal", userId: "owner", scope: "personal",
    connected: true, activeSessionId: "session", credentialGeneration: 1,
  });
  await expect(revokeBetaUser({
    d1: env.DB, userId: "owner", actorUserId: "owner", reason: "test",
  })).rejects.toMatchObject({ status: 403 });
  expect(await env.DB.prepare("SELECT disabled, credential_generation, active_session_id FROM agent_hosts WHERE id = 'personal'").first())
    .toEqual({ disabled: 0, credential_generation: 1, active_session_id: "session" });
});

it("attempts all run shutdowns and independent host wakes when cleanup fails", async () => {
  const db = drizzle(env.DB);
  await db.insert(user).values({ id: "owner", name: "Owner", email: "owner@example.test" });
  await grantFixtureBetaAccess({ d1: env.DB, userId: "owner" });
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
  const revocation = await revokeBetaUser({
    d1: env.DB, userId: "owner", actorUserId: FIXTURE_BETA_ADMIN_ID, reason: "test",
  });

  await expect(cleanupBetaRevocation({
    userId: "owner", revocationId: revocation.revocationId, actorUserId: FIXTURE_BETA_ADMIN_ID,
  })).rejects.toBe(failure);

  expect(effects.destroy.mock.calls).toHaveLength(2);
  expect(effects.destroy).toHaveBeenCalledWith({ runId: "run-shared-a", userId: "owner" });
  expect(effects.destroy).toHaveBeenCalledWith({ runId: "run-shared-b", userId: "owner" });
  expect(effects.routes).toHaveBeenCalledWith("owner");
  expect(effects.retire.mock.calls).toEqual([["personal"]]);
  expect(effects.wake.mock.calls.map(([hostId]) => hostId).sort()).toEqual(["personal", "shared-a", "shared-b"]);
  expect(effects.wake.mock.invocationCallOrder[0]).toBeGreaterThan(effects.retire.mock.invocationCallOrder[0]!);
  expect(await env.DB.prepare("SELECT state, revocation_cleanup_completed_at FROM access_allowlist WHERE user_id = 'owner'").first())
    .toEqual({ state: "blocked", revocation_cleanup_completed_at: null });
});
