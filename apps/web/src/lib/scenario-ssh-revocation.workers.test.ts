/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { beforeEach, expect, it, vi } from "vitest";
import {
  drizzle, env, resetHostRuntimeTestDatabase, seedHost, seedRun, testImageKey,
} from "@/control-plane/host-runtime-do/test-fixtures";
import { runtimeVms } from "@/db/schema";
import { createScenarioSshSessionForUser } from "./scenario-runs/lifecycle";
import { updateRunState } from "./scenario-runs/storage";
import * as routeGeneration from "./scenario-terminal-route-generation";

const effects = vi.hoisted(() => ({ issue: vi.fn(), revoke: vi.fn(), key: vi.fn(), attach: vi.fn() }));
vi.mock("@/lib/stargate", async (original) => ({
  ...await original<typeof import("@/lib/stargate")>(),
  issueStargateTerminalSession: effects.issue,
  deleteStargateTerminalRoute: effects.revoke,
}));
vi.mock("@/lib/scenario-run-ssh-keys", () => ({ loadScenarioRunSshKey: effects.key }));
vi.mock("@/lib/user-ssh-keys", () => ({ listUserAuthorizedSshKeysForNativeRoutes: async () => [] }));
vi.mock("@/lib/scenario-terminal-attach", () => ({ attachReadyScenarioTerminalTargets: effects.attach }));

const hostId = "ssh-host";
const runId = "ssh-run";
const vmId = "vm-1";
const request = () => createScenarioSshSessionForUser({
  runId, vmId, userId: "user-1", mode: "native",
  clientPublicKeyOpenssh: "ssh-ed25519 TEMP test@example.test",
});
const issuedSession = (input: { routeUsername: string; generation: string }) => ({
  routeUsername: input.routeUsername, generation: input.generation,
  expiresAt: Date.now() + 60_000, native: { authMode: "issued_key" },
});

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  effects.issue.mockImplementation(async (input) => issuedSession(input));
  effects.revoke.mockResolvedValue(undefined);
  effects.key.mockResolvedValue({ privateKeyOpenssh: "PRIVATE KEY" });
  effects.attach.mockResolvedValue("not_ready");
  await resetHostRuntimeTestDatabase();
  await seedHost(hostId);
  await env.DB.prepare("UPDATE agent_hosts SET scope = 'platform' WHERE id = ?").bind(hostId).run();
  const db = drizzle(env.DB);
  const now = Date.now();
  await seedRun({ db, hostId, runId, now, seedRuntimeVms: false });
  await updateRunState(runId, {
    mutate: (current) => ({
      ...current,
      phase: "active_full",
      vms: current.vms.map((vm) => ({
        ...vm, phase: "ready", terminalPhase: "ready",
        terminalTarget: { host: "10.0.0.10", port: 22, username: "ubuntu", hostKeyOpenssh: "ssh-ed25519 HOST", checkedAt: now },
      })),
    }),
  });
  await db.insert(runtimeVms).values({
    id: "runtime-vm", executionId: runId, vmId, ordinal: 0,
    runtimeVmName: "runtime-web", imageKeyJson: testImageKey,
    imageSha256: "2".repeat(64), cpuMillis: 1_000, memoryMib: 512, diskMib: 4096,
  });
});

it("issues a native session while the host and current execution remain eligible", async () => {
  await expect(request()).resolves.toMatchObject({ generation: `${runId}:1` });
  expect(effects.revoke).not.toHaveBeenCalled();
});

it.each([
  "UPDATE agent_hosts SET disabled = 1 WHERE id = 'ssh-host'",
  "UPDATE agent_hosts SET credential_generation = credential_generation + 1 WHERE id = 'ssh-host'",
])("rechecks a host changed during key loading before remote creation: %s", async (change) => {
  effects.key.mockImplementationOnce(async () => {
    await env.DB.prepare(change).run();
    return { privateKeyOpenssh: "PRIVATE KEY" };
  });
  await expect(request()).rejects.toMatchObject({ status: 409 });
  expect(effects.issue).not.toHaveBeenCalled();
});

it.each([
  ["invalid scope", "UPDATE agent_hosts SET scope = NULL WHERE id = 'ssh-host'"],
  ["unenrolled credential", "UPDATE agent_hosts SET credential_generation = 0 WHERE id = 'ssh-host'"],
  ["foreign personal owner", "UPDATE agent_hosts SET scope = 'personal', user_id = (SELECT id FROM user WHERE id <> 'user-1' LIMIT 1) WHERE id = 'ssh-host'"],
])("refuses %s before remote creation", async (_name, change) => {
  await env.DB.prepare(change).run();
  await expect(request()).rejects.toMatchObject({ status: 409 });
  expect(effects.issue).not.toHaveBeenCalled();
});

it("allows a personal host owned by the execution user", async () => {
  await env.DB.prepare("UPDATE agent_hosts SET scope = 'personal', active_session_id = 'session-personal', connected = 1 WHERE id = ?").bind(hostId).run();
  await expect(request()).resolves.toMatchObject({ generation: `${runId}:1` });
});

it.each([
  ["disabled host", "UPDATE agent_hosts SET disabled = 1 WHERE id = 'ssh-host'"],
  ["rotated host credential", "UPDATE agent_hosts SET credential_generation = credential_generation + 1 WHERE id = 'ssh-host'"],
  ["archiving execution", "UPDATE runtime_executions SET state = 'archiving' WHERE id = 'ssh-run'"],
  ["archived execution", "UPDATE runtime_executions SET state = 'archived' WHERE id = 'ssh-run'"],
  ["failed execution", "UPDATE runtime_executions SET state = 'failed' WHERE id = 'ssh-run'"],
  ["changed generation", "UPDATE runtime_executions SET generation = 2 WHERE id = 'ssh-run'"],
  ["teardown request", "UPDATE scenario_runs SET delete_requested_at = 1 WHERE run_id = 'ssh-run'"],
])("revokes a late native route after %s", async (_name, change) => {
  effects.issue.mockImplementationOnce(async (input) => {
    await env.DB.prepare(change).run();
    return issuedSession(input);
  });
  await expect(request()).rejects.toMatchObject({ status: 409 });
  expect(effects.revoke).toHaveBeenCalledExactlyOnceWith(
    effects.issue.mock.calls[0]![0].routeUsername, `${runId}:1`,
  );
});

it("revokes the issued route when the post-create admission query fails", async () => {
  effects.issue.mockImplementationOnce(async (input) => {
    vi.spyOn(routeGeneration, "loadScenarioTerminalRouteGeneration")
      .mockRejectedValueOnce(new Error("admission read failed"));
    return issuedSession(input);
  });
  await expect(request()).rejects.toThrow("admission read failed");
  expect(effects.revoke).toHaveBeenCalledExactlyOnceWith(
    effects.issue.mock.calls[0]![0].routeUsername, `${runId}:1`,
  );
});

it("propagates a failed compensating deletion instead of returning the session", async () => {
  effects.issue.mockImplementationOnce(async (input) => {
    await env.DB.prepare("UPDATE agent_hosts SET disabled = 1 WHERE id = ?").bind(hostId).run();
    return issuedSession(input);
  });
  effects.revoke.mockRejectedValueOnce(new Error("gateway unavailable"));
  await expect(request()).rejects.toThrow("route could not be revoked");
});
