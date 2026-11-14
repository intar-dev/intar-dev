/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentHosts,
  courseCatalogs,
  courseUnitCompletions,
  bundles,
  member,
  organization,
  scenarioAssignments,
  scenarioRuns,
  scenarioSources,
  scenarios,
} from "@/db/schema";
import { REVISION_BUILD_FAILURE } from "@/lib/machine-builds";
import { buildInitialRunState, recomputeRunState, RUN_PHASE_ORDER } from "@/lib/run-state";
import { changeScenarioSource, scenarioSourceScope } from "@/lib/scenario-sources";
import { createFixtureMember } from "@/test/account-fixtures";
import { resetD1Database } from "@/test/d1-migrations";

const ORG = "org-a";
const SCOPE = scenarioSourceScope(ORG);
const OWNER = "owner";
const SCENARIO = "org-a/demo";
const PUBLIC_SCENARIO = "intar/demo";
const REV = `git-9-${"b".repeat(40)}-digest`;
const BUNDLE_KEY = `builds/bundles/${REV}.json.gz`;

const purge = (actorUserId = OWNER) =>
  changeScenarioSource({
    scope: SCOPE,
    actorUserId,
    body: { action: "purge" },
    startedAt: Date.now(),
  });

beforeEach(async () => {
  await resetD1Database();
  const db = drizzle(env.DB);
  await createFixtureMember({ d1: env.DB, userId: OWNER });
  await db.insert(organization).values({ id: ORG, name: ORG, slug: ORG, createdAt: new Date() });
  await db.insert(member).values({
    id: "owner-member", organizationId: ORG, userId: OWNER, role: "owner", createdAt: new Date(),
  });
  await db.insert(agentHosts).values({
    id: "host", userId: OWNER, name: "host", createdAt: 1, updatedAt: 1,
  });
  await db.insert(scenarioSources).values({
    scopeKey: SCOPE.key, organizationId: ORG, githubInstallationId: 3, githubRepositoryId: 9,
    githubRepository: "acme/labs", defaultBranch: "main", boundByUserId: OWNER,
    liveRev: REV, disconnectedAt: 1, disconnectReason: "admin",
  });
  for (const [scenarioId, organizationId] of [[SCENARIO, ORG], [PUBLIC_SCENARIO, null]] as const) {
    const [namespace, slug] = scenarioId.split("/") as [string, string];
    await db.insert(scenarios).values({
      id: scenarioId, namespace, slug, organizationId,
      scopeKey: organizationId ? SCOPE.key : "public", enabled: true, play: false, liveRev: null,
    });
    await db.insert(scenarioAssignments).values({
      id: `assignment-${scenarioId}`, organizationId: ORG, scenarioId, assignedBy: OWNER,
    });
  }
  await db.insert(courseCatalogs).values({
    scopeKey: SCOPE.key, organizationId: ORG, catalogJson: { version: 2, courses: [] },
    sourceRevision: REV,
  });
  await db.insert(courseUnitCompletions).values({
    userId: OWNER, scopeKey: SCOPE.key, courseId: "c", lectureId: "l", completedAt: 1,
  });
  await db.insert(bundles).values({
    rev: REV, scopeKey: SCOPE.key, organizationId: ORG, compilerVersion: "2", r2Key: BUNDLE_KEY,
  });
  await env.VM_IMAGE_REGISTRY_BUCKET.put(BUNDLE_KEY, "bundle");
  await insertRun("org-run", SCENARIO, "completed");
  await insertRun("public-run", PUBLIC_SCENARIO, "completed");
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function insertRun(
  runId: string,
  scenarioId: string,
  phase: "queued" | "completed",
  extra: Partial<typeof scenarioRuns.$inferInsert> = {},
) {
  const initial = buildInitialRunState({
    vms: [{
      id: `${runId}-vm`, ordinal: 0, scenarioVmId: "vm", scenarioVmName: "vm",
      runtimeVmName: `${runId}-vm`, hostname: "vm",
      launchSummary: { scenarioVmName: "vm", hostname: "vm", probePhaseMap: {}, probeDescriptors: [] },
    }],
  });
  const state = recomputeRunState({
    ...initial,
    phase,
    vms: initial.vms.map((vm) => ({ ...vm, phase: phase === "completed" ? "completed" : vm.phase })),
  });
  await drizzle(env.DB).insert(scenarioRuns).values({
    runId, userId: OWNER, hostId: "host", organizationId: ORG, scenarioId,
    scenarioName: scenarioId, title: scenarioId, tagline: "", briefingMarkdown: "",
    objectivesJson: "[]", difficulty: "easy", estimatedMinutes: 1, tagsJson: [], hintsJson: [],
    solutionMarkdown: "", vmCount: 0, state: phase, stateRank: RUN_PHASE_ORDER[phase],
    stateJson: JSON.stringify(state), completedAt: phase === "completed" ? 1 : null,
    createdAt: 1, updatedAt: 1, ...extra,
  });
}

async function count(table: string, where = "1") {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("purging a disconnected scope", () => {
  it("deletes what the repository published and keeps public content", async () => {
    await expect(purge()).resolves.toBeNull();

    for (const table of [
      "scenario_sources", "course_catalogs", "course_unit_completions", "bundles",
    ]) {
      expect(await count(table), table).toBe(0);
    }
    expect(await count("scenarios")).toBe(1);
    expect(await count("scenario_assignments", `scenario_id = '${PUBLIC_SCENARIO}'`)).toBe(1);
    expect(await count("scenario_assignments")).toBe(1);
    expect(await count("scenario_runs", "run_id = 'public-run'")).toBe(1);
    expect(await count("scenario_runs")).toBe(1);
    expect(await count("access_events", "event_type = 'run.deleted_by_admin'")).toBe(1);
    expect(await env.VM_IMAGE_REGISTRY_BUCKET.head(BUNDLE_KEY)).toBeNull();
  });

  it("refuses a connected scope, an unfinished run and a running build, and deletes nothing", async () => {
    await env.DB.prepare("UPDATE scenario_sources SET disconnected_at = NULL").run();
    await expect(purge()).rejects.toMatchObject({ status: 409, code: "scenario_source_not_disconnected" });

    await env.DB.prepare("UPDATE scenario_sources SET disconnected_at = 1").run();
    await insertRun("live-run", SCENARIO, "queued");
    await expect(purge()).rejects.toMatchObject({ status: 409, code: "scenario_source_runs_active" });

    await env.DB.prepare("DELETE FROM scenario_runs WHERE run_id = 'live-run'").run();
    // A public scenario's run launched from the org's courses loses access with them.
    await insertRun("course-run", PUBLIC_SCENARIO, "queued", { courseScopeKey: SCOPE.key });
    await expect(purge()).rejects.toMatchObject({ status: 409, code: "scenario_source_runs_active" });

    // A finished run whose VM the host has not reported gone yet can't be deleted.
    await env.DB.prepare("DELETE FROM scenario_runs WHERE run_id = 'course-run'").run();
    await env.DB.prepare(
      "UPDATE scenario_runs SET state_json = json_set(state_json, '$.vms[0].phase', 'failed') WHERE run_id = 'org-run'",
    ).run();
    await expect(purge()).rejects.toMatchObject({ status: 409, code: "scenario_source_runs_active" });

    await env.DB.prepare(
      "UPDATE scenario_runs SET state_json = json_set(state_json, '$.vms[0].phase', 'completed') WHERE run_id = 'org-run'",
    ).run();
    await env.DB.prepare(
      `INSERT INTO machine_builds (build_key, image_format, bundle_rev, target_json, state)
       VALUES ('sha256:${"c".repeat(64)}', 'raw', ?1, '{}', 'building')`,
    ).bind(REV).run();
    await expect(purge()).rejects.toMatchObject({ status: 409, code: "scenario_source_deploying" });

    expect(await count("course_catalogs")).toBe(1);
    expect(await count("scenarios", "enabled = 1")).toBe(2);
    expect(await count("scenario_sources", "disconnect_reason = 'admin'")).toBe(1);
  });

  it("refuses a member and the public scope", async () => {
    await createFixtureMember({ d1: env.DB, userId: "learner" });
    await drizzle(env.DB).insert(member).values({
      id: "learner-member", organizationId: ORG, userId: "learner", role: "member", createdAt: new Date(),
    });
    await expect(purge("learner")).rejects.toMatchObject({ status: 409, code: "scenario_source_authority_changed" });
    await expect(
      changeScenarioSource({
        scope: scenarioSourceScope(null),
        actorUserId: OWNER,
        body: { action: "purge" },
        startedAt: Date.now(),
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await count("course_catalogs")).toBe(1);
  });

  it("keeps the rows naming the objects until their R2 delete succeeds", async () => {
    vi.spyOn(env.VM_IMAGE_REGISTRY_BUCKET, "delete").mockRejectedValueOnce(new Error("r2 down"));
    await expect(purge()).rejects.toThrow("r2 down");
    expect(await count("bundles")).toBe(1);
    expect(await count("scenario_sources", "disconnect_reason = 'purging'")).toBe(1);

    await expect(purge()).resolves.toBeNull();
    expect(await count("scenario_sources")).toBe(0);
    expect(await env.VM_IMAGE_REGISTRY_BUCKET.head(BUNDLE_KEY)).toBeNull();
  });

  it("fails the scope's queued builds and fails another scope's revision that waits on one", async () => {
    const shared = `sha256:${"d".repeat(64)}`;
    const own = `sha256:${"e".repeat(64)}`;
    for (const key of [shared, own]) {
      await env.DB.prepare(
        `INSERT INTO machine_builds (build_key, image_format, bundle_rev, target_json, state)
         VALUES (?1, 'raw', ?2, '{}', 'queued')`,
      ).bind(key, REV).run();
    }
    await env.DB.prepare(
      `INSERT INTO scenario_revisions (scenario_id, rev, guest_contract, doc_json, state)
       VALUES (?1, 'public-rev', 3, ?2, 'building')`,
    ).bind(PUBLIC_SCENARIO, JSON.stringify({ machines: [{ name: "vm", build_key: shared }] })).run();

    await expect(purge()).resolves.toBeNull();
    expect(await env.DB.prepare("SELECT build_key, state, error FROM machine_builds").all().then((r) => r.results))
      .toEqual([{ build_key: shared, state: "failed", error: "purged" }]);
    expect(await env.DB.prepare("SELECT state, failure_reason FROM scenario_revisions").first())
      .toEqual({ state: "failed", failure_reason: REVISION_BUILD_FAILURE });
  });

  it("deletes the logs and rows of the scope's builds that no other scope needs", async () => {
    const shared = `sha256:${"d".repeat(64)}`;
    const own = `sha256:${"e".repeat(64)}`;
    for (const key of [shared, own]) {
      const logKey = `builds/logs/${key.slice(7)}.log`;
      await env.DB.prepare(
        `INSERT INTO machine_builds (build_key, image_format, bundle_rev, target_json, state, log_key)
         VALUES (?1, 'raw', ?2, '{}', 'succeeded', ?3)`,
      ).bind(key, REV, logKey).run();
      await env.VM_IMAGE_REGISTRY_BUCKET.put(logKey, "log");
    }
    await env.DB.prepare(
      `INSERT INTO scenario_revisions (scenario_id, rev, guest_contract, doc_json, state)
       VALUES (?1, 'public-rev', 3, ?2, 'building')`,
    ).bind(PUBLIC_SCENARIO, JSON.stringify({ machines: [{ name: "vm", build_key: shared }] })).run();

    await expect(purge()).resolves.toBeNull();
    expect(await env.DB.prepare("SELECT build_key FROM machine_builds").all().then((r) => r.results))
      .toEqual([{ build_key: shared }]);
    expect(await env.VM_IMAGE_REGISTRY_BUCKET.head(`builds/logs/${"e".repeat(64)}.log`)).toBeNull();
    expect(await env.VM_IMAGE_REGISTRY_BUCKET.head(`builds/logs/${"d".repeat(64)}.log`)).not.toBeNull();
  });

  it("resumes a purge that was cut off", async () => {
    await env.DB.prepare("UPDATE scenario_sources SET disconnect_reason = 'purging'").run();
    await env.DB.prepare("DELETE FROM course_catalogs").run();
    await expect(purge()).resolves.toBeNull();
    expect(await count("scenario_sources")).toBe(0);
    expect(await count("scenarios")).toBe(1);
  });
});
