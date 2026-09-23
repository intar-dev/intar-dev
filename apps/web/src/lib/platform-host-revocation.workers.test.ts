/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { APIContext } from "astro";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, expect, it, vi } from "vitest";
import { agentBootstrapTokens, agentHosts, scenarioRuns, user } from "@/db/schema";
import { handleAgentBootstrap, requireVerifiedAgentRequest, sha256Hex } from "@/control-plane/auth";
import { POST } from "@/pages/api/admin/hosts/[hostId]/revoke";
import { resetD1Database } from "@/test/d1-migrations";
import { FIXTURE_ADMIN_ID, ensureFixtureAdmin, ensureFixtureMember, revokeFixtureAccount } from "@/test/account-fixtures";
import { seedHost, seedRun, desiredRunningVm } from "@/control-plane/host-runtime-do/test-fixtures";
import { mutateStoredHostDesiredState, loadOrCreateHostDesiredState } from "./desired-state-store";
import { destroyScenarioRunForUser } from "./scenario-runs/lifecycle";
import { loadRunRow, updateRunState } from "./scenario-runs/storage";

const effects = vi.hoisted(() => ({
  admin: vi.fn(), retire: vi.fn(), destroy: vi.fn(), deleteRoute: vi.fn(), wake: vi.fn(),
}));
vi.mock("@/lib/agent-bridge", () => ({ requireAdminUserContext: effects.admin }));
vi.mock("@/lib/host-runtime-wake", () => ({ retireHostRuntime: effects.retire, tryWakeHostRuntime: effects.wake, wakeHostRuntime: effects.wake }));
vi.mock("@/lib/scenario-runs", () => ({ destroyScenarioRunForUser: effects.destroy }));
vi.mock("@/lib/stargate", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/stargate")>(),
  deleteStargateRoute: effects.deleteRoute,
}));

const runtimeEnv = () => ({ ...env, AGENT_JWT_SECRET: "test-agent-jwt-secret-0123456789abcdef" });
const bootstrap = () => handleAgentBootstrap(new Request("https://intar.test/agent/bootstrap", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ hostId: "platform", bootstrapToken: "durable-secret" }),
}), runtimeEnv());
const revoke = (hostId = "platform") => POST({
  request: new Request(`https://intar.test/api/admin/hosts/${hostId}/revoke`, { method: "POST" }),
  params: { hostId },
} as unknown as APIContext);

beforeEach(async () => {
  vi.resetAllMocks();
  await resetD1Database();
  const db = drizzle(env.DB);
  // The creator is an admin too, so the acting fixture admin must exist first.
  await ensureFixtureAdmin(env.DB);
  await db.insert(user).values({ id: "creator", name: "Creator", email: "creator@example.test", role: "admin" });
  await ensureFixtureMember({ d1: env.DB, userId: "creator" });
  for (const scope of ["platform", "personal"] as const) {
    await db.insert(agentHosts).values({
      id: scope, name: scope, userId: "creator", scope,
      connected: true, activeSessionId: "old-session", credentialGeneration: 1,
    });
  }
  await db.insert(agentBootstrapTokens).values({
    id: "credential", hostId: "platform", tokenHash: await sha256Hex("durable-secret"), credentialGeneration: 1,
  });
  effects.admin.mockResolvedValue({ ok: true, context: { userId: FIXTURE_ADMIN_ID } });
  effects.retire.mockResolvedValue(undefined);
  effects.destroy.mockResolvedValue(undefined);
  effects.deleteRoute.mockResolvedValue(undefined);
  effects.wake.mockResolvedValue(undefined);
});

it("lets a different admin revoke a connected platform host after its creator loses access", async () => {
  await revokeFixtureAccount({ d1: env.DB, userId: "creator" });
  const before = await bootstrap();
  expect(before.status).toBe(200);
  const { accessToken } = await before.json() as { accessToken: string };
  expect((await revoke()).status).toBe(202);
  expect(await env.DB.prepare("SELECT disabled, credential_generation, active_session_id FROM agent_hosts WHERE id = 'platform'").first())
    .toEqual({ disabled: 1, credential_generation: 2, active_session_id: null });
  expect((await bootstrap()).status).toBe(401);
  const oldAccess = await requireVerifiedAgentRequest(new Request("https://intar.test/agent/connect", {
    headers: { authorization: `Bearer ${accessToken}` },
  }), runtimeEnv(), "platform");
  expect(oldAccess.ok).toBe(false);
  expect(effects.retire).toHaveBeenCalledWith("platform");
});

it("fails active builds and keeps the credential revoked while cleanup is retried", async () => {
  await env.DB.prepare("INSERT INTO image_build_bundles (rev, r2_key, meta_json) VALUES ('rev', 'bundle', '{}')").run();
  await env.DB.prepare("INSERT INTO image_builds (id, scenario_id, arch, rev, content_hash, host_id, status, phase) VALUES ('build', 'scenario', 'x86_64', 'rev', 'hash', 'platform', 'building', 'building')").run();
  effects.retire.mockRejectedValueOnce(new Error("offline"));
  expect((await revoke()).status).toBe(503);
  expect((await bootstrap()).status).toBe(401);
  expect((await revoke()).status).toBe(202);
  expect(await env.DB.prepare("SELECT credential_generation FROM agent_hosts WHERE id = 'platform'").first())
    .toEqual({ credential_generation: 2 });
  expect(await env.DB.prepare("SELECT status FROM image_builds WHERE id = 'build'").first()).toEqual({ status: "failed" });
});

it("rearms lease cleanup after retirement settles, including a failed retirement", async () => {
  let release!: () => void;
  const retiring = new Promise<void>((resolve) => { release = resolve; });
  effects.retire.mockImplementationOnce(async () => { await retiring; throw new Error("retirement failed"); });
  const request = revoke();
  await vi.waitFor(() => expect(effects.retire).toHaveBeenCalled());
  expect(effects.wake).not.toHaveBeenCalled();
  release();
  expect((await request).status).toBe(503);
  expect(effects.wake).toHaveBeenCalledWith("platform");
});

it("requests shutdown of each active workload on the revoked host", async () => {
  await drizzle(env.DB).insert(scenarioRuns).values({
    runId: "run", userId: "creator", hostId: "platform", scenarioId: "scenario",
    scenarioName: "Scenario", title: "Title", tagline: "", briefingMarkdown: "",
    objectivesJson: "[]", difficulty: "easy", estimatedMinutes: 1, tagsJson: [],
    hintsJson: [], solutionMarkdown: "", vmCount: 1, state: "ready", stateRank: 1,
    activeKey: "creator", stateJson: "{}",
  });
  effects.destroy.mockRejectedValueOnce(new Error("route cleanup failed"));
  expect((await revoke()).status).toBe(503);
  expect((await revoke()).status).toBe(202);
  expect(effects.destroy.mock.calls).toEqual([
    [{ runId: "run", userId: "creator" }],
    [{ runId: "run", userId: "creator" }],
  ]);
});

it("does not revoke another user's personal host", async () => {
  expect((await revoke("personal")).status).toBe(409);
  expect(await env.DB.prepare("SELECT disabled, credential_generation FROM agent_hosts WHERE id = 'personal'").first())
    .toEqual({ disabled: 0, credential_generation: 1 });
  expect(effects.retire).not.toHaveBeenCalled();
});

it("revokes routes and preserves lease records for a failed run with a live sibling VM", async () => {
  await seedHost("fixture-host");
  const db = drizzle(env.DB);
  const now = Date.now();
  await seedRun({ db, hostId: "platform", runId: "partly-failed", now, vms: [
    { id: "failed", scenarioVmId: "failed", scenarioVmName: "failed", runtimeVmName: "failed", hostname: "failed" },
    { id: "live", scenarioVmId: "live", scenarioVmName: "live", runtimeVmName: "live", hostname: "live" },
  ] });
  await mutateStoredHostDesiredState(db, "platform", now, (draft) => {
    draft.vms = [desiredRunningVm("partly-failed", "failed", now), desiredRunningVm("partly-failed", "live", now)];
  });
  await updateRunState("partly-failed", { mutate: (state) => ({
    ...state, phase: "failed", vms: state.vms.map((vm) => ({ ...vm, phase: vm.id === "failed" ? "failed" : "ready" })),
  }) });
  expect((await loadRunRow("partly-failed"))?.activeKey).toBeNull();
  effects.destroy.mockImplementation(destroyScenarioRunForUser);
  const revoked = await revoke();
  expect(revoked.status).toBe(202);
  expect(await revoked.json()).toMatchObject({ accessRevoked: true, physicalCleanup: "unconfirmed" });
  expect(effects.destroy).toHaveBeenCalledWith({ runId: "partly-failed", userId: "user-1" });
  expect(effects.deleteRoute).toHaveBeenCalledTimes(6);
  const desired = await loadOrCreateHostDesiredState(db, "platform", Date.now());
  expect(desired.vms.map(vm => [vm.desired_phase, vm.lease_expires_at_unix_ms]))
    .toEqual([["absent", now + 60_000], ["absent", now + 60_000]]);
  expect((await loadRunRow("partly-failed"))?.state.vms.find(vm => vm.id === "live")?.phase).toBe("ready");
  // A retry must only revoke routes after database archival. It must not
  // project the saved failed run back into an active runtime execution.
  await env.DB.prepare("UPDATE runtime_executions SET state = 'archived' WHERE domain_id = 'partly-failed'").run();
  effects.destroy.mockClear();
  expect((await revoke()).status).toBe(202);
  expect(effects.destroy).not.toHaveBeenCalled();
  expect(effects.deleteRoute).toHaveBeenCalledTimes(12);
  expect(await env.DB.prepare("SELECT state FROM runtime_executions WHERE domain_id = 'partly-failed'").first())
    .toEqual({ state: "archived" });
});

it.each(["role", "banned"])("rechecks the administrator %s at the database write", async (change) => {
  if (change === "role") await env.DB.prepare("UPDATE user SET role = 'user' WHERE id = ?").bind(FIXTURE_ADMIN_ID).run();
  if (change === "banned") await env.DB.prepare("UPDATE user SET banned = 1 WHERE id = ?").bind(FIXTURE_ADMIN_ID).run();
  expect((await revoke()).status).toBe(409);
  expect(await env.DB.prepare("SELECT disabled, credential_generation FROM agent_hosts WHERE id = 'platform'").first())
    .toEqual({ disabled: 0, credential_generation: 1 });
  expect((await bootstrap()).status).toBe(200);
  expect(effects.retire).not.toHaveBeenCalled();
});
