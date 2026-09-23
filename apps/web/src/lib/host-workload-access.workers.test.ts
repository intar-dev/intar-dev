import { loadScenarioTerminalRouteGeneration } from "./scenario-terminal-route-generation";
import { artifactWriteBatch, resolveRunVm } from "@/control-plane/agent-run-artifacts/storage";
import { persistHostReport } from "./personal-host-readiness";
import { actualVm, stateReport } from "@/control-plane/host-runtime-do/test-fixtures";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { enforceHostWorkloadAccess } from "./host-workload-access";
import { loadOrCreateHostDesiredState } from "./desired-state-store";
import * as desiredStateStore from "./desired-state-store";
import { updateRunState } from "./scenario-runs/storage";
import { runtimeExecutions, runtimeVms, user } from "@/db/schema";
import { ensureFixtureMember } from "@/test/account-fixtures";
import {
  desiredRunningVm, drizzle, env, eq, hostDesiredState, mutateStoredHostDesiredState,
  resetHostRuntimeTestDatabase, scenarioRuns, seedHost, seedRun, upsertDesiredVm,
} from "@/control-plane/host-runtime-do/test-fixtures";

const gateway = vi.hoisted(() => ({ deleteRoute: vi.fn(), wake: vi.fn() }));
vi.mock("@/lib/stargate", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/stargate")>(),
  deleteStargateRoute: gateway.deleteRoute,
}));
vi.mock("@/lib/host-runtime-wake", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/host-runtime-wake")>(),
  tryWakeHostRuntime: gateway.wake,
}));

beforeEach(async () => {
  await resetHostRuntimeTestDatabase();
  gateway.deleteRoute.mockReset().mockResolvedValue(undefined);
  gateway.wake.mockReset();
  const now = Date.now();
  await seedHost("host-1");
  await seedRun({ db: drizzle(env.DB), hostId: "host-1", runId: "run-1", runtimeVmName: "runtime-1", now });
  await mutateStoredHostDesiredState(drizzle(env.DB), "host-1", now, draft => {
    upsertDesiredVm(draft, desiredRunningVm("run-1", "runtime-1", now));
  });
});
afterEach(() => vi.restoreAllMocks());

it.each(["absent", "empty"])("retries durable cleanup with an %s desired VM list, then stops per-run work", async mode => {
  const db = drizzle(env.DB);
  await db.update(scenarioRuns).set({ deleteRequestedAt: Date.now() }).where(eq(scenarioRuns.runId, "run-1"));
  const state = await mutateStoredHostDesiredState(db, "host-1", Date.now(), draft => {
    if (mode === "empty") draft.vms = [];
    else for (const vm of draft.vms) vm.desired_phase = "absent";
  });
  gateway.deleteRoute.mockRejectedValue(new Error("gateway unavailable"));
  const failed = await enforceHostWorkloadAccess(state);
  expect(failed).toEqual(state);
  expect((await runRow()).activeKey).toBe("user-1");
  expect(gateway.deleteRoute).toHaveBeenCalledTimes(3);

  // Host completion does not discard the pending route cleanup marker.
  await updateRunState("run-1", { mutate: current => ({
    ...current, phase: "completed", vms: current.vms.map(vm => ({ ...vm, phase: "completed" })),
  }) });
  expect((await runRow()).activeKey).toBe("user-1");
  gateway.deleteRoute.mockResolvedValue(undefined);
  const retried = await enforceHostWorkloadAccess(failed);
  const completed = await runRow();
  expect(completed.activeKey).toBeNull();
  expect(completed.routeCleanupId).toBeNull();
  expect(completed.deleteRequestedAt).not.toBeNull();
  expect(retried).toEqual(state);
  expect(gateway.deleteRoute).toHaveBeenCalledTimes(6);
  expect(gateway.wake).not.toHaveBeenCalled();

  const prepare = vi.spyOn(env.DB, "prepare");
  expect(await enforceHostWorkloadAccess(retried)).toBe(retried);
  // One host-level discovery query; no per-run reads or lifecycle writes.
  expect(prepare).toHaveBeenCalledTimes(1);
  prepare.mockRestore();
  expect(await runRow()).toEqual(completed);
  expect(gateway.deleteRoute).toHaveBeenCalledTimes(6);
  expect(await env.DB.prepare("SELECT metal_placement FROM user WHERE id = 'user-1'").first()).toEqual({ metal_placement: "personal" });
});

it("stops newly denied work before route cleanup, retains leases and retries a missed membership cleanup", async () => {
  await env.DB.prepare("INSERT INTO organization (id, name, slug, created_at) VALUES ('org', 'Org', 'org', 1)").run();
  // There is no membership, and no earlier teardown intent from the API.
  await env.DB.prepare("UPDATE scenario_runs SET organization_id = 'org' WHERE run_id = 'run-1'").run();
  const state = await loadOrCreateHostDesiredState(drizzle(env.DB), "host-1", Date.now());
  const lease = state.vms[0]!.lease_expires_at_unix_ms;
  gateway.deleteRoute.mockImplementation(async () => {
    const [saved] = await drizzle(env.DB).select().from(hostDesiredState).where(eq(hostDesiredState.hostId, "host-1"));
    expect(saved?.docJson.vms[0]?.desired_phase).toBe("absent");
    throw new Error("gateway unavailable");
  });
  const stopped = await enforceHostWorkloadAccess(state);
  expect(stopped.vms[0]).toMatchObject({ desired_phase: "absent", lease_expires_at_unix_ms: lease });
  expect((await runRow()).deleteRequestedAt).not.toBeNull();
  expect((await runRow()).activeKey).toBe("user-1");
  gateway.deleteRoute.mockResolvedValue(undefined);
  await enforceHostWorkloadAccess(stopped);
  expect((await runRow()).activeKey).toBeNull();
  expect(gateway.deleteRoute).toHaveBeenCalledTimes(6);
});

it.each(["completed", "failed"] as const)("retries denied %s work after its active slot was already released", async phase => {
  await updateRunState("run-1", { mutate: current => ({
    ...current, phase, vms: current.vms.map(vm => ({ ...vm, phase })),
  }) });
  expect((await runRow()).activeKey).toBeNull();
  const state = await loadOrCreateHostDesiredState(drizzle(env.DB), "host-1", Date.now());
  gateway.deleteRoute.mockRejectedValue(new Error("gateway unavailable"));
  const stopped = await enforceHostWorkloadAccess(state);
  const cleanupId = (await runRow()).routeCleanupId;
  expect(cleanupId).toEqual(expect.any(String));
  expect(stopped.vms[0]?.desired_phase).toBe("absent");
  expect(stopped.vms[0]?.lease_expires_at_unix_ms).toBe(state.vms[0]?.lease_expires_at_unix_ms);
  expect(gateway.deleteRoute).toHaveBeenCalledTimes(3);

  const empty = await mutateStoredHostDesiredState(drizzle(env.DB), "host-1", Date.now(), draft => { draft.vms = []; });
  await enforceHostWorkloadAccess(empty);
  expect((await runRow()).routeCleanupId).toBe(cleanupId);
  expect(gateway.deleteRoute).toHaveBeenCalledTimes(6);
  gateway.deleteRoute.mockResolvedValue(undefined);
  await enforceHostWorkloadAccess(empty);
  expect(await runRow()).toMatchObject({ activeKey: null, routeCleanupId: null, state: phase });
  const prepare = vi.spyOn(env.DB, "prepare");
  await enforceHostWorkloadAccess(empty);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(gateway.deleteRoute).toHaveBeenCalledTimes(9);
});

it("saves retry intent before absence so an interrupted dispatch cannot lose terminal cleanup", async () => {
  await updateRunState("run-1", { mutate: current => ({
    ...current, phase: "failed", vms: current.vms.map(vm => ({ ...vm, phase: "failed" })),
  }) });
  const state = await loadOrCreateHostDesiredState(drizzle(env.DB), "host-1", Date.now());
  const mutate = desiredStateStore.mutateStoredHostDesiredState;
  const interrupted = vi.spyOn(desiredStateStore, "mutateStoredHostDesiredState").mockImplementationOnce(async (...args) => {
    expect((await runRow()).routeCleanupId).not.toBeNull();
    await mutate(...args);
    throw new Error("dispatch interrupted after absence was saved");
  });
  await expect(enforceHostWorkloadAccess(state)).rejects.toThrow("dispatch interrupted");
  interrupted.mockRestore();
  expect(gateway.deleteRoute).not.toHaveBeenCalled();
  const recovered = await loadOrCreateHostDesiredState(drizzle(env.DB), "host-1", Date.now());
  expect(recovered.vms[0]?.desired_phase).toBe("absent");
  await enforceHostWorkloadAccess(recovered);
  expect(gateway.deleteRoute).toHaveBeenCalledTimes(3);
  expect((await runRow()).routeCleanupId).toBeNull();
});

it("does not clear a newer cleanup request when an older request completes", async () => {
  await drizzle(env.DB).update(scenarioRuns).set({ deleteRequestedAt: Date.now() }).where(eq(scenarioRuns.runId, "run-1"));
  gateway.deleteRoute.mockImplementationOnce(async () => {
    await env.DB.prepare("UPDATE scenario_runs SET route_cleanup_id = 'new-cleanup' WHERE run_id = 'run-1'").run();
  });
  const state = await loadOrCreateHostDesiredState(drizzle(env.DB), "host-1", Date.now());
  const stopped = await enforceHostWorkloadAccess(state);
  expect((await runRow()).routeCleanupId).toBe("new-cleanup");
  await enforceHostWorkloadAccess(stopped);
  expect((await runRow()).routeCleanupId).toBeNull();
  expect(gateway.deleteRoute).toHaveBeenCalledTimes(6);
});

it("keeps authorized work and does not clean another host's pending run", async () => {
  await seedHost("host-2");
  const row = await runRow();
  await drizzle(env.DB).insert(scenarioRuns).values({
    ...row, runId: "other-host-run", hostId: "host-2", runtimeExecutionId: null,
    activeKey: "other-active-slot", deleteRequestedAt: Date.now(),
  });
  const state = await loadOrCreateHostDesiredState(drizzle(env.DB), "host-1", Date.now());
  expect(await enforceHostWorkloadAccess(state)).toBe(state);
  expect(await runRow()).toEqual(row);
  expect(gateway.deleteRoute).not.toHaveBeenCalled();
  expect(gateway.wake).not.toHaveBeenCalled();
  expect(await env.DB.prepare("SELECT active_key FROM scenario_runs WHERE run_id = 'other-host-run'").first()).toEqual({ active_key: "other-active-slot" });
});

it("cleans one owner's run without changing another owner's run on the same platform host", async () => {
  const db = drizzle(env.DB);
  const now = Date.now();
  await db.insert(user).values({ id: "user-2", name: "Other owner", email: "other@example.test" });
  await ensureFixtureMember({ d1: env.DB, userId: "user-2", githubAccountId: "host-runtime-github-user-2", now });
  const [execution] = await db.select().from(runtimeExecutions).where(eq(runtimeExecutions.id, "run-1"));
  const [vm] = await db.select().from(runtimeVms).where(eq(runtimeVms.executionId, "run-1"));
  if (!execution || !vm) throw new Error("runtime fixture is missing");
  await db.insert(runtimeExecutions).values({ ...execution, id: "run-2", domainId: "run-2", userId: "user-2" });
  await db.insert(runtimeVms).values({ ...vm, id: "run-2:vm-1", executionId: "run-2", runtimeVmName: "runtime-2" });
  const otherRun = { ...await runRow(), runId: "run-2", userId: "user-2", activeKey: "user-2", runtimeExecutionId: "run-2" };
  await db.insert(scenarioRuns).values(otherRun);
  await env.DB.batch([
    env.DB.prepare("UPDATE agent_hosts SET scope = 'platform' WHERE id = 'host-1'"),
    env.DB.prepare("UPDATE host_desired_state SET doc_json = json_set(doc_json, '$.scope', 'platform') WHERE host_id = 'host-1'"),
    env.DB.prepare("UPDATE scenario_runs SET delete_requested_at = ? WHERE run_id = 'run-1'").bind(now),
  ]);
  const state = await mutateStoredHostDesiredState(db, "host-1", now, draft => {
    upsertDesiredVm(draft, { ...desiredRunningVm("run-2", "runtime-2", now), owner_user_id: "user-2" });
  });
  const next = await enforceHostWorkloadAccess(state);
  expect(next.vms.find(vm => vm.run_id === "run-1")?.desired_phase).toBe("absent");
  expect(next.vms.find(vm => vm.run_id === "run-2")).toEqual(state.vms.find(vm => vm.run_id === "run-2"));
  expect((await db.select().from(scenarioRuns).where(eq(scenarioRuns.runId, "run-2")))[0]).toEqual(otherRun);
  expect(gateway.deleteRoute).toHaveBeenCalledTimes(3);
  expect(gateway.deleteRoute.mock.calls.every(([route]) => String(route).startsWith("run-1-"))).toBe(true);
});

async function runRow() {
  const [row] = await drizzle(env.DB).select().from(scenarioRuns).where(eq(scenarioRuns.runId, "run-1"));
  if (!row) throw new Error("test run is missing");
  return row;
}

async function organizationWorkload() {
  await drizzle(env.DB).insert(user).values({ id: "creator", name: "Creator", email: "creator@example.test", banned: true, deletedAt: new Date(1) });
  await env.DB.batch([
    env.DB.prepare("INSERT INTO organization (id, name, slug, created_at) VALUES ('org', 'Org', 'org', 1)"),
    env.DB.prepare("INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ('membership', 'org', 'user-1', 'member', 1)"),
    env.DB.prepare("UPDATE agent_hosts SET scope = 'organization', organization_id = 'org', user_id = 'creator', active_session_id = 'session' WHERE id = 'host-1'"),
    env.DB.prepare("UPDATE host_desired_state SET doc_json = json_set(doc_json, '$.scope', 'organization', '$.owner_user_id', 'creator') WHERE host_id = 'host-1'"),
    env.DB.prepare("UPDATE scenario_runs SET organization_id = 'org' WHERE run_id = 'run-1'"),
    env.DB.prepare("UPDATE runtime_executions SET organization_id = 'org' WHERE id = 'run-1'"),
    env.DB.prepare("INSERT INTO agent_bootstrap_tokens (id,host_id,token_hash,credential_generation) VALUES ('credential','host-1','fixture',1)"),
  ]);
  return loadOrCreateHostDesiredState(drizzle(env.DB), "host-1", Date.now());
}

it("keeps shared organization work on its assigned host after placement and creator access change", async () => {
  const state = await organizationWorkload();
  expect(await enforceHostWorkloadAccess(state)).toBe(state);
  expect(await loadScenarioTerminalRouteGeneration({ runId: "run-1", vmId: "vm-1" })).toMatchObject({ hostId: "host-1", userId: "user-1" });
  const runVm = await resolveRunVm({ db: drizzle(env.DB), runId: "run-1", vmName: "runtime-1", agent: {
    scope: "organization", organizationId: "org", credentialGeneration: 1, hostId: "host-1", userId: "creator", role: "agent",
  } });
  expect(runVm).toMatchObject({ userId: "user-1", hostId: "host-1" });
  const now = Date.now();
  const message = stateReport("host-1", { observedAt: now, appliedDesiredVersion: state.version, vms: [actualVm("run-1", "runtime-1", now)] });
  if (message.type !== "state_report") throw new Error("Expected state report");
  expect(await persistHostReport({ d1: env.DB, hostId: "host-1", sessionId: "session", credentialGeneration: 1, report: message.report, now, requireRunCli: false })).toBe(true);
  expect(gateway.deleteRoute).not.toHaveBeenCalled();

  // The initial artifact resolution does not authorize a later write.
  await env.DB.prepare("DELETE FROM member WHERE user_id = 'user-1'").run();
  await expect(artifactWriteBatch(env.DB, runVm!, [])).rejects.toThrow("Artifact write identity is no longer current");
});

it.each([
  ["membership removed", "DELETE FROM member WHERE user_id = 'user-1'"],
  ["public-context run", "UPDATE scenario_runs SET organization_id = NULL WHERE run_id = 'run-1'"],
  ["different organization", "UPDATE scenario_runs SET organization_id = 'other' WHERE run_id = 'run-1'"],
  ["content removed", "DELETE FROM course_catalogs"],
  ["learner banned", "UPDATE user SET banned = 1 WHERE id = 'user-1'"],
])("denies organization workload and terminal access after %s", async (_name, mutation) => {
  const state = await organizationWorkload();
  await env.DB.prepare("INSERT INTO organization (id,name,slug,created_at) VALUES ('other','Other','other',1)").run();
  await env.DB.prepare(mutation).run();
  await expect(loadScenarioTerminalRouteGeneration({ runId: "run-1", vmId: "vm-1" })).rejects.toMatchObject({ code: "scenario_terminal_target_unavailable" });
  const stopped = await enforceHostWorkloadAccess(state);
  expect(stopped.vms[0]?.desired_phase).toBe("absent");
  expect(gateway.deleteRoute).toHaveBeenCalledTimes(3);
});

it("accepts a removed member's VM report so cleanup cannot make the shared host unavailable", async () => {
  const state = await organizationWorkload();
  await env.DB.prepare("DELETE FROM member WHERE user_id = 'user-1'").run();
  const now = Date.now();
  const message = stateReport("host-1", { observedAt: now, appliedDesiredVersion: state.version, vms: [actualVm("run-1", "runtime-1", now)] });
  if (message.type !== "state_report") throw new Error("Expected state report");
  const save = () => persistHostReport({ d1: env.DB, hostId: "host-1", sessionId: "session", credentialGeneration: 1, report: message.report, now, requireRunCli: false });
  expect(await save()).toBe(true);
  expect(await env.DB.prepare("SELECT connected FROM agent_hosts WHERE id = 'host-1'").first()).toEqual({ connected: 1 });
  const stopped = await enforceHostWorkloadAccess(state);
  expect(stopped.vms[0]?.desired_phase).toBe("absent");
  message.report.observed_at_unix_ms += 1;
  message.report.vms[0]!.phase = "absent";
  expect(await save()).toBe(true);
  message.report.observed_at_unix_ms += 1;
  message.report.vms[0]!.generation += 1;
  expect(await save()).toBe(false);
  message.report.vms[0]!.generation -= 1;
  await env.DB.prepare("UPDATE scenario_runs SET organization_id = NULL WHERE run_id = 'run-1'").run();
  expect(await save()).toBe(false);
});
