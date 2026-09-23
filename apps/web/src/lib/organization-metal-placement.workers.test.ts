import { beforeEach, expect, it } from "vitest";
import { agentHosts, member, organization, user } from "@/db/schema";
import { drizzle, env, seedHost, stateReport, resetHostRuntimeTestDatabase } from "@/control-plane/host-runtime-do/test-fixtures";
import { persistHostReport } from "./personal-host-readiness";
import { loadScenarioCapacity, loadScenarioCapacityPressure, loadScenarioLaunchHostForUser, selectScenarioHosts } from "./scenario-runs/start";
import { metalAdmissionSql } from "./metal-placement";

beforeEach(async () => {
  await resetHostRuntimeTestDatabase();
  await seedHost("organization-host");
  const db = drizzle(env.DB);
  await db.insert(user).values({ id: "learner", name: "Learner", email: "learner@example.test" });
  await db.insert(organization).values([
    { id: "org", name: "Org", slug: "org", createdAt: new Date() },
    { id: "other", name: "Other", slug: "other", createdAt: new Date() },
  ]);
  await db.insert(member).values({ id: "membership", organizationId: "org", userId: "learner", role: "member", createdAt: new Date() });
  await env.DB.prepare("UPDATE agent_hosts SET scope = 'organization', organization_id = 'org' WHERE id = 'organization-host'").run();
  await db.insert(agentHosts).values([
    { id: "platform-host", userId: "user-1", name: "Platform", scope: "platform", credentialGeneration: 1 },
    { id: "personal-host", userId: "learner", name: "Personal", scope: "personal", credentialGeneration: 1 },
    { id: "other-personal-host", userId: "user-1", name: "Other personal", scope: "personal", credentialGeneration: 1 },
    { id: "other-host", userId: "user-1", name: "Other", scope: "organization", organizationId: "other", credentialGeneration: 1 },
  ]);
  await env.DB.prepare("UPDATE agent_hosts SET active_session_id = 'session'").run();
  for (const hostId of ["organization-host", "platform-host", "personal-host", "other-host", "other-personal-host"]) await report(hostId);
  // The learner's personal host just became Ready, which moves an active
  // owner's new runs onto it. These cases start from platform placement.
  await env.DB.prepare("UPDATE user SET metal_placement = 'platform' WHERE id = 'learner'").run();
});

async function report(hostId: string, change?: (report: import("@/generated/bridge").HostStateReportV2) => void) {
  const now = Date.now();
  const message = stateReport(hostId, { observedAt: now, appliedDesiredVersion: 0 });
  if (message.type !== "state_report") throw new Error("Expected report");
  change?.(message.report);
  return persistHostReport({ d1: env.DB, hostId, sessionId: "session", credentialGeneration: 1, report: message.report, now, requireRunCli: false });
}

function select(organizationId: string | null = "org", cpuMillis = 1000) {
  return selectScenarioHosts([], "learner", { cpuMillis, memoryMib: 512, worstCaseDiskMib: 1024 }, undefined, false, organizationId);
}

it("selects the context fleet, gives personal placement priority, and rechecks membership", async () => {
  expect(await select()).toEqual({ ok: true, hostIds: ["organization-host"] });
  expect(await select(null)).toEqual({ ok: true, hostIds: ["platform-host"] });
  expect(await select("other")).toMatchObject({ ok: false });
  await expect(loadScenarioLaunchHostForUser("other-host", "learner", [], "org")).rejects.toMatchObject({ code: "scenario_host_not_found" });
  await expect(loadScenarioLaunchHostForUser("organization-host", "learner", [], "org")).resolves.toMatchObject({ scope: "organization" });
  await env.DB.prepare("UPDATE user SET metal_placement = 'personal' WHERE id = 'learner'").run();
  expect(await select()).toEqual({ ok: true, hostIds: ["personal-host"] });
  expect(await select(null)).toEqual({ ok: true, hostIds: ["personal-host"] });
  await env.DB.prepare("DELETE FROM member WHERE user_id = 'learner'").run();
  expect(await select()).toMatchObject({ ok: false });
});

it("uses the same placement for commit checks and selection", async () => {
  const hosts = () => env.DB.prepare(`SELECT host.id FROM agent_hosts host WHERE ${metalAdmissionSql("?1", "?2")}`).bind("learner", "org").all<{ id: string }>();
  expect((await hosts()).results).toEqual([{ id: "organization-host" }]);
  await env.DB.prepare("UPDATE organization SET metal_placement = 'platform' WHERE id = 'org'").run();
  expect((await hosts()).results).toEqual([{ id: "platform-host" }]);
  expect(await select()).toEqual({ ok: true, hostIds: ["platform-host"] });
  await env.DB.prepare("DELETE FROM member WHERE user_id = 'learner'").run();
  expect((await hosts()).results).toEqual([]);
});

it("does not fall back when the organization fleet is offline, full, or lacks a relay", async () => {
  expect(await select("org", 5000)).toMatchObject({ ok: false, reason: "resource_capacity" });
  await env.DB.prepare("UPDATE agent_hosts SET connected = 0 WHERE id = 'organization-host'").run();
  expect(await select()).toMatchObject({ ok: false, reason: "unavailable" });
  await env.DB.prepare("UPDATE agent_hosts SET connected = 1 WHERE id = 'organization-host'").run();
  await env.DB.prepare("UPDATE host_actual_state SET report_json = json_set(report_json, '$.relay_connected', json('false')) WHERE host_id = 'organization-host'").run();
  expect(await select()).toMatchObject({ ok: false, reason: "unavailable" });
  await expect(loadScenarioLaunchHostForUser("organization-host", "learner", [], "org")).rejects.toMatchObject({ code: "organization_server_not_ready" });
  expect(await select(null)).toEqual({ ok: true, hostIds: ["platform-host"] });
});

it("combines accessible pools in both catalogs, independent of placement preferences", async () => {
  await env.DB.prepare("UPDATE host_actual_state SET report_json = json_set(report_json, '$.capacity.committed_cpu_millis', 4000) WHERE host_id = 'organization-host'").run();
  await env.DB.prepare("UPDATE host_actual_state SET report_json = json_set(report_json, '$.capacity.memory_available_mib', 1024) WHERE host_id = 'personal-host'").run();
  const combined = {
    capacityPressure: 63,
    resourceCapacity: {
      cpu: { availableMillis: 8000, totalMillis: 12_000 },
      memory: { availableMib: 9216, totalMib: 24_576 },
    },
  };
  for (const orgId of [null, "org"]) {
    expect(await loadScenarioCapacity("learner", undefined, false, orgId)).toEqual(combined);
    expect(await loadScenarioCapacityPressure("learner", undefined, false, orgId)).toBe(63);
  }
  await env.DB.prepare("UPDATE organization SET metal_placement = 'platform' WHERE id = 'org'").run();
  await env.DB.prepare("UPDATE user SET metal_placement = 'personal' WHERE id = 'learner'").run();
  expect(await loadScenarioCapacity("learner", undefined, false, "org")).toEqual(combined);
  expect(await loadScenarioCapacity("learner", undefined, false)).toEqual(combined);
});

it("adds member organizations once and removes their capacity when membership ends", async () => {
  expect(await loadScenarioCapacity("learner", undefined, false, "other")).toEqual({ capacityPressure: null, resourceCapacity: null });
  await drizzle(env.DB).insert(member).values({ id: "other-membership", organizationId: "other", userId: "learner", role: "member", createdAt: new Date() });
  for (const orgId of [null, "org", "other"]) {
    expect((await loadScenarioCapacity("learner", undefined, false, orgId)).resourceCapacity).toEqual({
      cpu: { availableMillis: 16_000, totalMillis: 16_000 },
      memory: { availableMib: 16_384, totalMib: 32_768 },
    });
  }
  await env.DB.prepare("DELETE FROM member WHERE user_id = 'learner'").run();
  expect(await loadScenarioCapacity("learner", undefined, false, "org")).toEqual({ capacityPressure: null, resourceCapacity: null });
  expect((await loadScenarioCapacity("learner", undefined, false)).resourceCapacity).toEqual({
    cpu: { availableMillis: 8000, totalMillis: 8000 },
    memory: { availableMib: 8192, totalMib: 16_384 },
  });
});

it("excludes offline and unready private hosts from combined totals", async () => {
  await env.DB.prepare("UPDATE agent_hosts SET connected = 0 WHERE id = 'organization-host'").run();
  await env.DB.prepare("UPDATE host_actual_state SET report_json = json_set(report_json, '$.relay_connected', json('false')) WHERE host_id = 'personal-host'").run();
  expect((await loadScenarioCapacity("learner", undefined, false, "org")).resourceCapacity).toEqual({
    cpu: { availableMillis: 4000, totalMillis: 4000 },
    memory: { availableMib: 4096, totalMib: 8192 },
  });
  await env.DB.prepare("UPDATE agent_hosts SET connected = 0 WHERE id = 'platform-host'").run();
  expect(await loadScenarioCapacity("learner", undefined, false)).toEqual({ capacityPressure: null, resourceCapacity: null });
});

it.each(["banned", "deleted_at"])("withholds combined capacity from users with %s set", async column => {
  await env.DB.prepare(`UPDATE user SET ${column} = 1 WHERE id = 'learner'`).run();
  for (const orgId of [null, "org"]) {
    expect(await loadScenarioCapacity("learner", undefined, false, orgId)).toEqual({ capacityPressure: null, resourceCapacity: null });
  }
});

it("sets organization placement on first Ready, independent of the creator, and keeps it after disconnect", async () => {
  await env.DB.prepare("UPDATE organization SET metal_placement = 'platform' WHERE id = 'org'").run();
  await env.DB.prepare("UPDATE user SET banned = 1, deleted_at = 1 WHERE id = 'user-1'").run();
  await env.DB.prepare("DELETE FROM host_actual_state WHERE host_id = 'organization-host'").run();
  const placement = () => env.DB.prepare("SELECT metal_placement FROM organization WHERE id = 'org'").first();
  await report("organization-host", report => { report.relay_connected = false; });
  expect(await placement()).toEqual({ metal_placement: "platform" });
  await env.DB.prepare("DELETE FROM host_actual_state WHERE host_id = 'organization-host'").run();
  expect(await report("organization-host")).toBe(true);
  expect(await placement()).toEqual({ metal_placement: "organization" });
  await env.DB.prepare("UPDATE agent_hosts SET connected = 0 WHERE id = 'organization-host'").run();
  expect(await placement()).toEqual({ metal_placement: "organization" });
  expect(await env.DB.prepare("SELECT metal_placement FROM user WHERE id = 'learner'").first()).toEqual({ metal_placement: "platform" });
});
