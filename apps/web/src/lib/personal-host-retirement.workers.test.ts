/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, expect, it, vi } from "vitest";
import { agentHosts, user, runtimeExecutions, runtimeVms } from "@/db/schema";
import type { UserContext } from "@/lib/agent-bridge";
import { retirePersonalHost } from "@/lib/personal-host-retirement";
import { persistHostReport } from "@/lib/personal-host-readiness";
import { updatePersonalServer, listPersonalServers } from "@/lib/personal-servers";
import { createHostEnrollment, claimHostEnrollment, randomHostSecret } from "@/lib/host-enrollment";
import { ensureFixtureMember, revokeFixtureAccount } from "@/test/account-fixtures";
import { resetD1Database } from "@/test/d1-migrations";
import fixture from "@/generated/fixtures/bridge/host-state-report-v2.json";
import type { HostStateReportV2 } from "@/generated/bridge";
import { HOST_STATE_REPORT_SCHEMA_VERSION } from "@/generated/constants";
let context: UserContext;
const now = Date.now();
let reportSequence = now;
beforeEach(async () => {
  await resetD1Database();
  await drizzle(env.DB).insert(user).values([
    { id: "owner", name: "Owner", email: "owner@example.test" },
    { id: "other", name: "Other", email: "other@example.test" },
  ]);
  await ensureFixtureMember({ d1: env.DB, userId: "owner" });
  context = { userId: "owner", sessionId: "browser", isAdmin: false, role: "user", organizationIds: [], activeOrganizationId: null };
  await env.DB.prepare("INSERT INTO runtime_operation_gates (key,state,updated_at) VALUES ('personal_metal_registration','open',1)").run();
});
async function host(id = "host", scope: "personal" | "platform" = "personal") {
  await drizzle(env.DB).insert(agentHosts).values({ id, userId: "owner", name: id, scope, credentialGeneration: 1, connected: true, activeSessionId: "session", lastHeartbeatAt: now });
}
function report(id = "host"): HostStateReportV2 {
  return { ...structuredClone(fixture), observed_at_unix_ms: ++reportSequence, schema_version: HOST_STATE_REPORT_SCHEMA_VERSION, relay_connected: true, host_id: id, vms: [], builds: [] } as HostStateReportV2;
}
function ready(id = "host", snapshot = report(id), sessionId = "session") {
  return persistHostReport({ d1: env.DB, hostId: id, sessionId, credentialGeneration: 1, report: snapshot, now, requireRunCli: false });
}
function remove(hostId = "host", confirmReturnToCloud = true) {
  return retirePersonalHost({ d1: env.DB, hostId, userId: context.userId, confirmReturnToCloud });
}
async function placement() { return env.DB.prepare("SELECT metal_placement AS mode FROM user WHERE id = 'owner'").first<{ mode: string }>(); }
it("changes placement only when a current personal server is Ready", async () => {
  await host("platform", "platform"); await ready("platform");
  expect(await placement()).toEqual({ mode: "platform" });
  await host();
  expect(await ready("host", report(), "old-session")).toBe(false);
  expect(await placement()).toEqual({ mode: "platform" });
  const broken = report(); broken.capabilities.supports_kvm = false;
  await ready("host", broken);
  expect(await placement()).toEqual({ mode: "platform" });
  await ready();
  expect(await placement()).toEqual({ mode: "personal" });
  await updatePersonalServer(env.DB, context, "host", { paused: true });
  expect(await placement()).toEqual({ mode: "personal" });
  expect((await listPersonalServers(context)).servers[0]?.status).toBe("paused");
});
it("requires last-server consent, revokes credentials, preserves identity, and makes retries safe", async () => {
  const enrollment = await createHostEnrollment(env.DB, context, { name: "My server", scope: "personal", role: "agent" });
  const credential = randomHostSecret();
  await claimHostEnrollment(env.DB, enrollment.enrollmentToken, credential);
  await env.DB.prepare("UPDATE user SET metal_placement = 'personal' WHERE id = 'owner'").run();
  await expect(remove(enrollment.hostId, false)).rejects.toMatchObject({ code: "last_server_confirmation_required" });
  expect(await remove(enrollment.hostId)).toEqual({ placement: "platform" });
  expect(await remove(enrollment.hostId)).toEqual({ placement: "platform" });
  expect(await claimHostEnrollment(env.DB, enrollment.enrollmentToken, credential)).toBeNull();
  expect(await env.DB.prepare("SELECT disabled, credential_generation FROM agent_hosts WHERE id = ?").bind(enrollment.hostId).first()).toEqual({ disabled: 1, credential_generation: 2 });
});
it("does not let a retry override another server's later administrative revocation", async () => {
  await host(); await host("second"); await ready();
  await remove("host", false);
  await env.DB.prepare("UPDATE agent_hosts SET disabled = 1 WHERE id = 'second'").run();
  await remove("host", true);
  expect(await placement()).toEqual({ mode: "personal" });
  expect((await listPersonalServers(context)).servers.find(row => row.id === "second")?.status).toBe("revoked");
  await expect(remove("second", false)).rejects.toMatchObject({ code: "last_server_confirmation_required" });
  expect(await placement()).toEqual({ mode: "personal" });
  await remove("second", true);
  expect(await placement()).toEqual({ mode: "platform" });
});
it("keeps registration, last removal and first Ready consistent when requests race", async () => {
  await host(); await ready();
  const enrollment = await createHostEnrollment(env.DB, context, { name: "Second", scope: "personal", role: "agent" });
  await Promise.all([remove(), claimHostEnrollment(env.DB, enrollment.enrollmentToken, randomHostSecret())]);
  await env.DB.prepare("UPDATE agent_hosts SET active_session_id = 'session' WHERE id = ?").bind(enrollment.hostId).run();
  await Promise.all([remove(), ready(enrollment.hostId)]);
  expect(await placement()).toEqual({ mode: "personal" });
  expect((await listPersonalServers(context)).servers.filter(row => row.status !== "removing").map(row => row.id)).toEqual([enrollment.hostId]);
});
it("rejects another owner and a revoked owner for management", async () => {
  await host();
  const intruder = { ...context, userId: "other" };
  await expect(updatePersonalServer(env.DB, intruder, "host", { name: "stolen" })).rejects.toMatchObject({ status: 404 });
  await expect(retirePersonalHost({ d1: env.DB, hostId: "host", userId: "other", confirmReturnToCloud: true })).rejects.toMatchObject({ status: 404 });
  expect((await listPersonalServers(intruder)).servers).toEqual([]);
  await revokeFixtureAccount({ d1: env.DB, userId: "owner" });
  await expect(updatePersonalServer(env.DB, context, "host", { paused: true })).rejects.toMatchObject({ status: 404 });
  await expect(remove()).rejects.toMatchObject({ status: 404 });
});
it("a delayed report after removal cannot restore readiness or change placement", async () => {
  await host(); await ready(); await remove();
  expect(await ready()).toBe(false);
  expect(await placement()).toEqual({ mode: "platform" });
});

it("rejects missing or wrong workload identity before saving a host report", async () => {
  await host();
  const db = drizzle(env.DB);
  await db.insert(runtimeExecutions).values({ id: "execution", userId: "owner", hostId: "host", domainKind: "scenario", domainId: "run", generation: 1 });
  await db.insert(runtimeVms).values({ id: "runtime-vm", executionId: "execution", vmId: "web", ordinal: 0,
    runtimeVmName: "runtime-web", imageKeyJson: {}, imageSha256: "a".repeat(64), cpuMillis: 500, memoryMib: 512, diskMib: 1024 });
  const snapshot = report();
  const valid = { ...structuredClone(fixture.vms[0]!), owner_user_id: "owner", runtime_execution_id: "execution", generation: 1, run_id: "run", vm_name: "runtime-web" };
  for (const invalid of [
    { ...valid, owner_user_id: "other" }, { ...valid, generation: 2 },
    { ...valid, runtime_execution_id: "missing" }, { ...valid, run_id: "other-run" },
  ]) {
    snapshot.vms = [invalid as HostStateReportV2["vms"][number]];
    expect(await ready("host", snapshot)).toBe(false);
    expect(await placement()).toEqual({ mode: "platform" });
    expect(await env.DB.prepare("SELECT host_id FROM host_actual_state").first()).toBeNull();
  }
  snapshot.vms = [valid as HostStateReportV2["vms"][number]];
  expect(await ready("host", snapshot)).toBe(true);
});

it("rejects an older Ready report after the tunnel disconnects", async () => {
  await host();
  const oldReady = report();
  const disconnected = { ...report(), relay_connected: false };
  expect(await ready("host", disconnected)).toBe(true);
  expect(await ready("host", oldReady)).toBe(false);
  expect(await placement()).toEqual({ mode: "platform" });
  expect((await listPersonalServers(context)).servers[0]?.status).toBe("needs_attention");
});
it("changes placement atomically when the first healthy paused server resumes", async () => {
  await host();
  await updatePersonalServer(env.DB, context, "host", { paused: true });
  await ready();
  expect(await placement()).toEqual({ mode: "platform" });
  await updatePersonalServer(env.DB, context, "host", { paused: false });
  expect(await placement()).toEqual({ mode: "personal" });
  expect((await listPersonalServers(context)).servers[0]?.status).toBe("ready");
});
it("keeps failed removal visible until cleanup succeeds without restoring access", async () => {
  await host(); await ready(); await remove();
  const pending = (await listPersonalServers(context)).servers[0];
  expect(pending).toMatchObject({ id: "host", status: "removing", connected: false });
  await expect(updatePersonalServer(env.DB, context, "host", { paused: false })).rejects.toMatchObject({ status: 404 });
  expect(await remove("host", false)).toEqual({ placement: "platform" });
  await env.DB.prepare("UPDATE agent_hosts SET owner_removal_completed_at = ? WHERE id = 'host'").bind(Date.now()).run();
  expect((await listPersonalServers(context)).servers).toEqual([]);
});

it.each([false, true])("does not resume across a changed readiness snapshot (initial report: %s)", async initialReport => {
  await host();
  await updatePersonalServer(env.DB, context, "host", { paused: true });
  if (initialReport) await ready();
  const batch = env.DB.batch.bind(env.DB);
  const spy = vi.spyOn(env.DB, "batch").mockImplementationOnce(async statements => {
    spy.mockRestore();
    await ready();
    return batch(statements);
  });
  try {
    await expect(updatePersonalServer(env.DB, context, "host", { paused: false })).rejects.toMatchObject({ code: "server_status_changed" });
  } finally { spy.mockRestore(); }
  expect((await listPersonalServers(context)).servers[0]?.status).toBe("paused");
  expect(await placement()).toEqual({ mode: "platform" });
  await updatePersonalServer(env.DB, context, "host", { paused: false });
  expect(await placement()).toEqual({ mode: "personal" });
});
