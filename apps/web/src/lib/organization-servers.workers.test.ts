/// <reference types="@cloudflare/vitest-pool-workers/types" />
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, expect, it, vi } from "vitest";
import { agentHosts, hostActualState, member, organization, runtimeExecutions, scenarioRuns, user, personalImagePreparations } from "@/db/schema";
import type { UserContext } from "@/lib/agent-bridge";
import { createHostEnrollment, claimHostEnrollment, randomHostSecret } from "@/lib/host-enrollment";
import { cancelOrganizationEnrollment, listOrganizationServers, removeOrganizationServer, updateOrganizationServer } from "@/lib/organization-servers";
import { deleteOrganization, leaveOrganization, removeOrganizationMember, updateOrganizationMemberRole } from "@/lib/organizations";
import { ensureFixtureMember, revokeFixtureAccount } from "@/test/account-fixtures";
import { resetD1Database } from "@/test/d1-migrations";
import { GET } from "@/pages/api/organizations/[orgId]/servers/index";
import { POST } from "@/pages/api/organizations/[orgId]/servers/enrollments";
import { PATCH, DELETE } from "@/pages/api/organizations/[orgId]/servers/[hostId]";
import { DELETE as CANCEL } from "@/pages/api/organizations/[orgId]/servers/enrollments/[enrollmentId]";
import fixture from "@/generated/fixtures/bridge/host-state-report-v2.json";
import type { HostStateReportV2 } from "@/generated/bridge";
import { HOST_STATE_REPORT_SCHEMA_VERSION } from "@/generated/constants";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), cleanup: vi.fn() }));
vi.mock("@/lib/agent-bridge", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/agent-bridge")>(), requireUserContext: mocks.auth }));
vi.mock("@/lib/host-workload-retirement", () => ({ cleanupRemovedHost: mocks.cleanup }));
let contexts: Record<string, UserContext>;

beforeEach(async () => {
  await resetD1Database();
  vi.clearAllMocks();
  mocks.cleanup.mockResolvedValue(undefined);
  const db = drizzle(env.DB);
  await db.insert(user).values(["owner", "admin", "reader", "outsider"].map(id => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(organization).values(["org", "other-org"].map(id => ({ id, name: id, slug: id, createdAt: new Date() })));
  await db.insert(member).values(["owner", "admin", "reader"].map(id => ({ id, userId: id, organizationId: "org", role: id === "reader" ? "member" : id, createdAt: new Date() })));
  contexts = {};
  for (const userId of ["owner", "admin", "reader", "outsider"]) {
    // "admin" would otherwise reuse the fixture administrator's GitHub account id.
    await ensureFixtureMember({ d1: env.DB, userId, githubAccountId: `org-servers-github-${userId}` });
    contexts[userId] = { userId, sessionId: "browser", role: "user", isAdmin: false, organizationIds: [], activeOrganizationId: null };
  }
  mocks.auth.mockResolvedValue({ ok: true, context: contexts.owner });
  await env.DB.prepare("INSERT INTO runtime_operation_gates (key,state,updated_at) VALUES ('personal_metal_registration','open',1)").run();
});

function enrollment(context = contexts.owner!) {
  return createHostEnrollment(env.DB, context, { name: "Team server", scope: "organization", role: "agent", organizationId: "org" });
}
async function host(id = "host", organizationId = "org") {
  await drizzle(env.DB).insert(agentHosts).values({ id, userId: "owner", name: id, scope: "organization", organizationId, credentialGeneration: 1 });
}
function route(handler: APIRoute, method: string, body?: unknown, params: Record<string, string> = {}) {
  return handler({ request: new Request("http://localhost/api/organizations/org/servers", {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  }), params: { orgId: "org", hostId: "host", enrollmentId: "host", ...params } } as unknown as Parameters<APIRoute>[0]);
}

it("binds a claim to its organization and permits management by another admin after creator demotion", async () => {
  const setup = await enrollment();
  const secret = randomHostSecret();
  expect(await claimHostEnrollment(env.DB, setup.enrollmentToken, secret)).toMatchObject({ hostId: setup.hostId, scope: "organization", organizationId: "org" });
  await env.DB.prepare("UPDATE member SET role = 'member' WHERE id = 'owner'").run();
  await updateOrganizationServer(env.DB, contexts.admin!, "org", setup.hostId, { name: "  Shared server  " });
  expect((await listOrganizationServers(contexts.reader!, "org")).servers[0]).toMatchObject({ name: "Shared server", status: "setting_up" });
  await expect(updateOrganizationServer(env.DB, contexts.owner!, "org", setup.hostId, { paused: true })).rejects.toMatchObject({ status: 404 });
  expect(await env.DB.prepare("SELECT disabled, organization_id FROM agent_hosts").first()).toEqual({ disabled: 0, organization_id: "org" });
});

it("requires current admin membership, an active account, and the user-managed gate at creation and claim", async () => {
  await expect(enrollment(contexts.reader!)).rejects.toMatchObject({ code: "host_enrollment_changed" });
  const setup = await enrollment();
  await env.DB.prepare("UPDATE member SET role = 'member' WHERE id = 'owner'").run();
  expect(await claimHostEnrollment(env.DB, setup.enrollmentToken, randomHostSecret())).toBeNull();
  await env.DB.prepare("UPDATE member SET role = 'owner' WHERE id = 'owner'").run();
  await env.DB.prepare("UPDATE runtime_operation_gates SET state = 'drained'").run();
  expect(await claimHostEnrollment(env.DB, setup.enrollmentToken, randomHostSecret())).toBeNull();
  await expect(enrollment()).rejects.toMatchObject({ code: "host_enrollment_changed" });
  await env.DB.prepare("UPDATE runtime_operation_gates SET state = 'open'").run();
  await revokeFixtureAccount({ d1: env.DB, userId: "owner" });
  expect(await claimHostEnrollment(env.DB, setup.enrollmentToken, randomHostSecret())).toBeNull();
  await expect(enrollment()).rejects.toMatchObject({ code: "host_enrollment_changed" });
  expect(await env.DB.prepare("SELECT count(*) AS n FROM agent_hosts").first()).toEqual({ n: 0 });
});

it("rejects organization builders, missing bindings, and organization bindings on personal hosts", async () => {
  await expect(createHostEnrollment(env.DB, contexts.owner!, { name: "Bad", scope: "organization", role: "builder", organizationId: "org" })).rejects.toThrow();
  await expect(createHostEnrollment(env.DB, contexts.owner!, { name: "Bad", scope: "organization", role: "agent" })).rejects.toMatchObject({ status: 400 });
  await expect(createHostEnrollment(env.DB, contexts.owner!, { name: "Bad", scope: "personal", role: "agent", organizationId: "org" })).rejects.toMatchObject({ status: 400 });
  const db = drizzle(env.DB);
  await expect(db.insert(agentHosts).values({ id: "bad", userId: "owner", name: "Bad", scope: "organization", organizationId: "org", role: "builder" })).rejects.toThrow();
  await expect(db.insert(agentHosts).values({ id: "bad", userId: "owner", name: "Bad", organizationId: "org" })).rejects.toThrow();
});

it("isolates organization lists, allows member GET, and protects every write route", async () => {
  await host(); await host("other-host", "other-org");
  await drizzle(env.DB).insert(agentHosts).values({ id: "personal", userId: "owner", name: "Personal", scope: "personal" });
  const setup = await enrollment();
  mocks.auth.mockResolvedValue({ ok: true, context: contexts.reader });
  const response = await route(GET, "GET");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  const body = await response.json() as { servers: { id: string }[] };
  expect(body).toMatchObject({ placement: "platform", registrationOpen: true, installerCommand: "curl -fsSL https://intar.dev/install.sh | sudo sh", enrollments: [{ id: setup.hostId }] });
  expect(body.servers.map(server => server.id)).toEqual(["host"]);
  for (const [handler, method, input] of [[POST, "POST", { name: "Bad" }], [PATCH, "PATCH", { name: "Bad" }], [DELETE, "DELETE", { confirmReturnToCloud: true }], [CANCEL, "DELETE", undefined]] as const) {
    expect((await route(handler, method, input)).status).toBe(403);
  }
  mocks.auth.mockResolvedValue({ ok: true, context: contexts.outsider });
  expect((await route(GET, "GET")).status).toBe(404);
  mocks.auth.mockResolvedValue({ ok: false, response: new Response("Account access required", { status: 403 }) });
  expect((await route(GET, "GET")).status).toBe(403);
});

it("returns enrollment and update responses and refuses invalid payloads", async () => {
  const response = await route(POST, "POST", { name: "New server" });
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ hostId: expect.any(String), enrollmentToken: expect.any(String), expiresAt: expect.any(Number) });
  await host();
  expect((await route(PATCH, "PATCH", { name: "Renamed" })).status).toBe(200);
  for (const input of [{}, { name: " " }, { name: "x", paused: true }, { paused: "true" }]) {
    expect((await route(PATCH, "PATCH", input)).status).toBe(400);
  }
  expect((await route(POST, "POST", { name: "Wrong scope", scope: "platform" })).status).toBe(400);
  expect((await route(DELETE, "DELETE", {})).status).toBe(400);
  await env.DB.prepare("UPDATE runtime_operation_gates SET state = 'drained'").run();
  expect((await route(POST, "POST", { name: "Closed" })).status).toBe(503);
});

it("rechecks write authority after route checks and rejects cross-organization host IDs", async () => {
  await host(); await host("other-host", "other-org");
  const setup = await enrollment();
  await expect(updateOrganizationServer(env.DB, contexts.owner!, "org", "other-host", { name: "Bad" })).rejects.toMatchObject({ status: 404 });
  await expect(removeOrganizationServer(env.DB, contexts.owner!, "org", "other-host", true)).rejects.toMatchObject({ status: 404 });
  await expect(cancelOrganizationEnrollment(env.DB, contexts.owner!, "other-org", setup.hostId)).rejects.toMatchObject({ status: 409 });
  await env.DB.prepare("DELETE FROM member WHERE id = 'owner'").run();
  await expect(updateOrganizationServer(env.DB, contexts.owner!, "org", "host", { paused: true })).rejects.toMatchObject({ status: 404 });
  await expect(cancelOrganizationEnrollment(env.DB, contexts.owner!, "org", setup.hostId)).rejects.toMatchObject({ status: 409 });
  await expect(removeOrganizationServer(env.DB, contexts.owner!, "org", "host", true)).rejects.toMatchObject({ status: 404 });
  expect(mocks.cleanup).not.toHaveBeenCalled();
});

it("rejects a revoked actor for all management writes", async () => {
  await host();
  const setup = await enrollment();
  await revokeFixtureAccount({ d1: env.DB, userId: "owner" });
  await expect(updateOrganizationServer(env.DB, contexts.owner!, "org", "host", { paused: true })).rejects.toMatchObject({ status: 404 });
  await expect(cancelOrganizationEnrollment(env.DB, contexts.owner!, "org", setup.hostId)).rejects.toMatchObject({ status: 409 });
  await expect(removeOrganizationServer(env.DB, contexts.owner!, "org", "host", true)).rejects.toMatchObject({ status: 404 });
  expect(mocks.cleanup).not.toHaveBeenCalled();
});

it("lets another admin cancel an enrollment and never cancels an enrolled host", async () => {
  const setup = await enrollment();
  mocks.auth.mockResolvedValue({ ok: true, context: contexts.admin });
  expect((await route(CANCEL, "DELETE", undefined, { enrollmentId: setup.hostId })).status).toBe(200);
  expect(await claimHostEnrollment(env.DB, setup.enrollmentToken, randomHostSecret())).toBeNull();
  const claimed = await enrollment();
  await claimHostEnrollment(env.DB, claimed.enrollmentToken, randomHostSecret());
  await expect(cancelOrganizationEnrollment(env.DB, contexts.admin!, "org", claimed.hostId)).rejects.toMatchObject({ status: 409 });
});

it("keeps placement sticky when paused and returns the personal server row fields", async () => {
  await host();
  const now = Date.now();
  const report = { ...structuredClone(fixture), host_id: "host", schema_version: HOST_STATE_REPORT_SCHEMA_VERSION, relay_connected: true, vms: [], builds: [] } as HostStateReportV2;
  await drizzle(env.DB).insert(hostActualState).values({ hostId: "host", appliedDesiredVersion: 0, observedAt: now, reportJson: report, updatedAt: now });
  await env.DB.prepare("UPDATE agent_hosts SET connected = 1, last_heartbeat_at = ?").bind(now).run();
  await env.DB.prepare("UPDATE organization SET metal_placement = 'organization' WHERE id = 'org'").run();
  let listed = await listOrganizationServers(contexts.reader!, "org");
  expect(listed.servers[0]).toMatchObject({ id: "host", status: "ready", repairAction: null, connected: true, createdAt: expect.any(Number), lastSeenAt: now, capacity: { total: expect.any(Number), available: expect.any(Number) }, activeRuns: 0 });
  await updateOrganizationServer(env.DB, contexts.admin!, "org", "host", { paused: true });
  listed = await listOrganizationServers(contexts.reader!, "org");
  expect(listed.placement).toBe("organization");
  expect(listed.servers[0]?.status).toBe("paused");
  await updateOrganizationServer(env.DB, contexts.admin!, "org", "host", { paused: false });
  expect((await listOrganizationServers(contexts.reader!, "org")).servers[0]?.status).toBe("ready");
});

it("requires last-server confirmation, revokes credentials, and supports removal retries", async () => {
  const setup = await enrollment();
  const secret = randomHostSecret();
  await claimHostEnrollment(env.DB, setup.enrollmentToken, secret);
  await env.DB.prepare("UPDATE organization SET metal_placement = 'organization' WHERE id = 'org'").run();
  await expect(removeOrganizationServer(env.DB, contexts.admin!, "org", setup.hostId, false)).rejects.toMatchObject({ code: "last_server_confirmation_required" });
  mocks.cleanup.mockRejectedValueOnce(new Error("Cleanup failed"));
  await expect(removeOrganizationServer(env.DB, contexts.admin!, "org", setup.hostId, true)).rejects.toMatchObject({ code: "server_cleanup_pending" });
  expect((await listOrganizationServers(contexts.reader!, "org")).servers[0]?.status).toBe("removing");
  expect(await claimHostEnrollment(env.DB, setup.enrollmentToken, secret)).toBeNull();
  expect(await env.DB.prepare("SELECT revoked_at FROM agent_bootstrap_tokens").first()).toMatchObject({ revoked_at: expect.any(Number) });
  const response = await route(DELETE, "DELETE", { confirmReturnToCloud: false }, { hostId: setup.hostId });
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ removed: true, placement: "platform", physicalCleanup: "unconfirmed" });
  expect(await env.DB.prepare("SELECT disabled, credential_generation FROM agent_hosts").first()).toEqual({ disabled: 1, credential_generation: 2 });
  expect((await listOrganizationServers(contexts.reader!, "org")).servers).toEqual([]);
  expect(mocks.cleanup).toHaveBeenCalledWith(setup.hostId);
});

it("does not return to cloud while another organization host remains", async () => {
  await host(); await host("second");
  await env.DB.prepare("UPDATE organization SET metal_placement = 'organization' WHERE id = 'org'").run();
  expect(await removeOrganizationServer(env.DB, contexts.admin!, "org", "host", false)).toMatchObject({ placement: "organization" });
  expect((await listOrganizationServers(contexts.reader!, "org")).servers.map(server => server.id)).toEqual(["second"]);
});

it("records shutdown for every host run and preserves issued lease deadlines before cleanup", async () => {
  await host();
  const db = drizzle(env.DB);
  const deadline = Date.now() + 60_000;
  for (const userId of ["owner", "reader"]) {
    await db.insert(runtimeExecutions).values({ id: userId, userId, hostId: "host", domainKind: "scenario", domainId: userId, generation: 1, leaseExpiresAt: userId === "owner" ? deadline : null });
    await db.insert(scenarioRuns).values({ runId: userId, userId, hostId: "host", scenarioId: "demo", organizationId: "org", state: "running", runtimeExecutionId: userId, activeKey: userId,
      scenarioName: "Demo", title: "Demo", tagline: "", briefingMarkdown: "", objectivesJson: "[]",
      difficulty: "easy", estimatedMinutes: 1, tagsJson: [], hintsJson: [], solutionMarkdown: "", vmCount: 1, stateRank: 1, stateJson: "{}" });
  }
  mocks.cleanup.mockRejectedValueOnce(new Error("Offline"));
  await expect(removeOrganizationServer(env.DB, contexts.admin!, "org", "host", true)).rejects.toMatchObject({ status: 503 });
  const runs = await env.DB.prepare("SELECT delete_requested_at AS requested FROM scenario_runs").all();
  expect(runs.results).toEqual([{ requested: expect.any(Number) }, { requested: expect.any(Number) }]);
  expect(await env.DB.prepare("SELECT lease_expires_at AS deadline FROM runtime_executions WHERE id = 'owner'").first()).toEqual({ deadline });
  expect(await env.DB.prepare("SELECT lease_expires_at AS deadline FROM runtime_executions WHERE id = 'reader'").first()).toEqual({ deadline: expect.any(Number) });
});

it("blocks organization deletion and keeps hosts when a creator is soft-deleted", async () => {
  await host();
  await expect(deleteOrganization({ organizationId: "org", actorUserId: "owner" })).rejects.toMatchObject({ code: "organization_not_empty" });
  await expect(env.DB.prepare("DELETE FROM organization WHERE id = 'org'").run()).rejects.toThrow();
  await env.DB.prepare("UPDATE user SET deleted_at = ? WHERE id = 'owner'").bind(Date.now()).run();
  expect(await env.DB.prepare("SELECT organization_id FROM agent_hosts").first()).toEqual({ organization_id: "org" });
});

it.each(["demote", "remove", "leave"])("permanently revokes pending enrollments on %s without revoking enrolled hosts", async change => {
  const enrolled = await enrollment(contexts.admin!);
  await claimHostEnrollment(env.DB, enrolled.enrollmentToken, randomHostSecret());
  const pending = await enrollment(contexts.admin!);
  await drizzle(env.DB).insert(personalImagePreparations).values({
    userId: "admin", hostId: enrolled.hostId, credentialGeneration: 1, requestKey: "pending",
    accessJson: { userId: "admin", organizationId: "org", scenarioId: "private", courseScopeKey: "organization:org",
      courseId: "course", lectureId: "private", allowSequenceBypass: false, requiresAdmin: false },
    imagesJson: [], expiresAt: Date.now() + 60_000,
  });
  if (change === "demote") {
    await updateOrganizationMemberRole({ organizationId: "org", actorUserId: "owner", memberId: "admin", role: "member" });
    await updateOrganizationMemberRole({ organizationId: "org", actorUserId: "owner", memberId: "admin", role: "admin" });
  } else {
    if (change === "remove") await removeOrganizationMember({ organizationId: "org", actorUserId: "owner", memberId: "admin" });
    else await leaveOrganization({ organizationId: "org", userId: "admin" });
    await drizzle(env.DB).insert(member).values({ id: "admin", userId: "admin", organizationId: "org", role: "admin", createdAt: new Date() });
  }
  expect(await claimHostEnrollment(env.DB, pending.enrollmentToken, randomHostSecret())).toBeNull();
  expect(await env.DB.prepare("SELECT disabled FROM agent_hosts WHERE id = ?").bind(enrolled.hostId).first()).toEqual({ disabled: 0 });
  expect(await env.DB.prepare("SELECT revoked_at FROM host_enrollments WHERE host_id = ?").bind(enrolled.hostId).first()).toEqual({ revoked_at: null });
  expect((await drizzle(env.DB).select().from(personalImagePreparations)).length).toBe(change === "demote" ? 1 : 0);
});

it("rechecks the acting admin when changing a member role", async () => {
  const pending = await enrollment(contexts.admin!);
  const batch = env.DB.batch.bind(env.DB);
  const spy = vi.spyOn(env.DB, "batch").mockImplementationOnce(async statements => {
    spy.mockRestore();
    await env.DB.prepare("DELETE FROM member WHERE id = 'owner'").run();
    return batch(statements);
  });
  try {
    await expect(updateOrganizationMemberRole({ organizationId: "org", actorUserId: "owner", memberId: "admin", role: "member" })).rejects.toMatchObject({ code: "organization_membership_changed" });
  } finally { spy.mockRestore(); }
  expect(await env.DB.prepare("SELECT role FROM member WHERE id = 'admin'").first()).toEqual({ role: "admin" });
  expect(await claimHostEnrollment(env.DB, pending.enrollmentToken, randomHostSecret())).not.toBeNull();
});

async function pausedHostReport(reportedAt = Date.now()) {
  await host();
  const now = Date.now();
  const report = { ...structuredClone(fixture), host_id: "host", schema_version: HOST_STATE_REPORT_SCHEMA_VERSION, relay_connected: true, vms: [], builds: [] } as HostStateReportV2;
  await drizzle(env.DB).insert(hostActualState).values({ hostId: "host", appliedDesiredVersion: 0, observedAt: reportedAt, reportJson: report, updatedAt: reportedAt });
  await env.DB.prepare("UPDATE agent_hosts SET scenario_enabled = 0, connected = 1, active_session_id = 'session', last_heartbeat_at = ? WHERE id = 'host'").bind(now).run();
}

it.each([false, true])("activates organization placement on resume only with a fresh Ready report (stale: %s)", async stale => {
  await pausedHostReport(Date.now() - (stale ? 120_000 : 0));
  await updateOrganizationServer(env.DB, contexts.admin!, "org", "host", { paused: false });
  const listed = await listOrganizationServers(contexts.reader!, "org");
  expect(listed.placement).toBe(stale ? "platform" : "organization");
  expect(listed.servers[0]?.status).toBe(stale ? "offline" : "ready");
});

it.each(["report", "session", "generation", "first report"])("rejects resume if the %s changes before the transaction", async change => {
  await pausedHostReport();
  const report = await env.DB.prepare("SELECT report_json FROM host_actual_state WHERE host_id = 'host'").first<{ report_json: string }>();
  if (change === "first report") await env.DB.prepare("DELETE FROM host_actual_state WHERE host_id = 'host'").run();
  const batch = env.DB.batch.bind(env.DB);
  const spy = vi.spyOn(env.DB, "batch").mockImplementationOnce(async statements => {
    spy.mockRestore();
    if (change === "report") await env.DB.prepare("UPDATE host_actual_state SET updated_at = updated_at + 1 WHERE host_id = 'host'").run();
    else if (change === "session") await env.DB.prepare("UPDATE agent_hosts SET active_session_id = 'new-session' WHERE id = 'host'").run();
    else if (change === "generation") await env.DB.prepare("UPDATE agent_hosts SET credential_generation = credential_generation + 1 WHERE id = 'host'").run();
    else await env.DB.prepare("INSERT INTO host_actual_state (host_id, applied_desired_version, observed_at, report_json, updated_at) VALUES ('host', 0, ?1, ?2, ?1)").bind(Date.now(), report!.report_json).run();
    return batch(statements);
  });
  try {
    await expect(updateOrganizationServer(env.DB, contexts.admin!, "org", "host", { paused: false })).rejects.toMatchObject({ code: "server_status_changed" });
  } finally { spy.mockRestore(); }
  const listed = await listOrganizationServers(contexts.reader!, "org");
  expect(listed.placement).toBe("platform");
  expect(listed.servers[0]?.status).toBe("paused");
});

it.each(["membership", "account"])("does not resume or activate after the actor's %s changes", async change => {
  await pausedHostReport();
  const batch = env.DB.batch.bind(env.DB);
  const spy = vi.spyOn(env.DB, "batch").mockImplementationOnce(async statements => {
    spy.mockRestore();
    if (change === "membership") await env.DB.prepare("UPDATE member SET role = 'member' WHERE id = 'admin'").run();
    else await revokeFixtureAccount({ d1: env.DB, userId: "admin" });
    return batch(statements);
  });
  try {
    await expect(updateOrganizationServer(env.DB, contexts.admin!, "org", "host", { paused: false })).rejects.toMatchObject({ status: 404 });
  } finally { spy.mockRestore(); }
  const listed = await listOrganizationServers(contexts.reader!, "org");
  expect(listed.placement).toBe("platform");
  expect(listed.servers[0]?.status).toBe("paused");
});
