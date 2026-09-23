/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { agentHosts, courseCatalogs, hostActualState, hostDesiredState, member, organization,
  personalImagePreparations, runtimeExecutions, scenarioRuns, user, vmScenarios, vmScenarioVms } from "@/db/schema";
import type { VerifiedAgentHost } from "@/control-plane/auth";
import { agentScenarioImageAccess, agentCanAccessManifest } from "@/control-plane/image-registry/image-access";
import { stateReport } from "@/control-plane/host-runtime-do/test-fixtures";
import { ensureFixtureMember } from "@/test/account-fixtures";
import { resetD1Database } from "@/test/d1-migrations";
import { beginScenarioRun } from "@/lib/scenario-runs/begin";
import { preparePersonalScenarioImages } from "@/lib/personal-image-preparation";
import { reconcileHostScenarioImages, reconcileScenarioImagesForPublicationScope } from "@/lib/scenario-image-cache";
import { tryWakeHostRuntime } from "@/lib/host-runtime-wake";

vi.mock("@/lib/host-runtime-wake", () => ({ tryWakeHostRuntime: vi.fn(async () => {}) }));
const db = drizzle(env.DB);
const image = { imageKey: { scenario: "private", vm: "vm", arch: "x86_64" as const }, imageSha256: "a".repeat(64) };
const access = { userId: "owner", organizationId: "org", scenarioId: "private", courseScopeKey: "organization:org",
  courseId: "course", lectureId: "private", allowSequenceBypass: false, requiresAdmin: false };

async function input() {
  return { access, requestKey: "personal-start-1", requiredImages: [image],
    requiredResources: { cpuMillis: 1000, memoryMib: 512, worstCaseDiskMib: 4096 } };
}

async function agent(hostId = "personal", userId = "owner"): Promise<VerifiedAgentHost> {
  const [host] = await db.select().from(agentHosts).where(eq(agentHosts.id, hostId));
  return { hostId, userId, scope: host!.scope!, organizationId: host!.organizationId, role: "agent", credentialGeneration: 1 };
}

async function visible(hostId = "personal", userId = "owner") {
  return (await db.select({ id: vmScenarios.scenarioId }).from(vmScenarios)
    .innerJoin(vmScenarioVms, eq(vmScenarios.scenarioId, vmScenarioVms.scenarioId))
    .where(agentScenarioImageAccess(await agent(hostId, userId)))).map(row => row.id);
}

async function seedHost(id: string, userId = "owner", scope: "personal" | "platform" = "personal") {
  const now = Date.now();
  await db.insert(agentHosts).values({ id, name: id, userId, scope, credentialGeneration: 1,
    role: "agent", connected: true, activeSessionId: id + "-session", lastHeartbeatAt: now });
  const message = stateReport(id, { observedAt: now, appliedDesiredVersion: 0, cachedImages: [] });
  if (message.type !== "state_report") throw new Error("Report required");
  await db.insert(hostActualState).values({ hostId: id, appliedDesiredVersion: 0, observedAt: now, reportJson: message.report, updatedAt: now });
}

describe("personal image preparation", () => {
  beforeEach(async () => {
    await resetD1Database();
    vi.clearAllMocks();
    for (const id of ["owner", "other"]) {
      await db.insert(user).values({ id, name: id, email: id + "@example.test", metalPlacement: "personal" });
      await ensureFixtureMember({ d1: env.DB, userId: id });
    }
    await db.insert(organization).values({ id: "org", name: "Org", slug: "org", createdAt: new Date() });
    await db.insert(member).values({ id: "membership", userId: "owner", organizationId: "org", role: "member", createdAt: new Date() });
    for (const id of ["private", "other-private", "public"]) {
      await db.insert(vmScenarios).values({ scenarioId: id, organizationId: id === "public" ? null : "org",
        title: id, description: id, difficulty: "easy", estimatedMinutes: 10, tagsJson: [], hintsJson: [],
        briefingMarkdown: "Briefing", solutionMarkdown: "Solution", enabled: true, enabledAt: Date.now() });
      await db.insert(vmScenarioVms).values({ id, scenarioId: id, ordinal: 0, vmName: "vm", image: id + "-vm-x86_64",
        imageKeyJson: { ...image.imageKey, scenario: id }, imageSha256: image.imageSha256, imageFormat: "raw_chunks_v1",
        imageVirtualSizeBytes: 1073741824, chunkManifestSha256: "b".repeat(64), guestBootstrapAbi: 2,
        kernelSha256: "c".repeat(64), initrdSha256: "d".repeat(64), bootCmdline: "root=/dev/vda rw",
        cpuMillis: 1000, memoryMib: 512, diskMib: 4096 });
    }
    for (const organizationId of ["org", null]) {
      await db.insert(courseCatalogs).values({ scopeKey: organizationId ? "organization:org" : "public", organizationId,
        sourceRevision: "test", catalogJson: { version: 2, courses: [{ courseId: "course", title: "Course", summary: "Summary",
          bodyMarkdown: "Theory", sequential: false, lectures: (organizationId ? ["private", "other-private"] : ["public"])
            .map(id => ({ lectureId: id, scenarioId: id, title: id, summary: "Summary", bodyMarkdown: "Theory",
              category: "linux", tags: [], estimatedMinutes: 10 })) }] } });
    }
    await seedHost("personal");
    await seedHost("foreign", "other");
    await seedHost("platform", "owner", "platform");
  });
  afterEach(() => vi.restoreAllMocks());

  it("warms a first private start, then admits exactly once after the host reports ready", async () => {
    const prep = await input();
    const start = { scenarioId: "private", userId: "owner", organizationId: "org", idempotencyKey: prep.requestKey };
    await expect(beginScenarioRun(start)).rejects.toMatchObject({ code: "image_not_ready" });
    expect(await db.select().from(scenarioRuns)).toHaveLength(0);
    expect(await db.select().from(runtimeExecutions)).toHaveLength(0);
    expect(await visible()).toEqual(["private"]);
    expect(await visible("foreign", "other")).toEqual([]);
    expect(await agentCanAccessManifest(db, await agent(), "b".repeat(64), image.imageSha256)).toBe(true);
    expect(tryWakeHostRuntime).toHaveBeenCalledWith("personal");
    const [intent] = await db.select().from(hostDesiredState).where(eq(hostDesiredState.hostId, "personal"));
    expect(intent!.docJson.cached_images).toEqual([{ image_key: image.imageKey, image_id: image.imageSha256 }]);
    expect(intent!.docJson.vms).toEqual([]);
    await env.DB.prepare("UPDATE host_actual_state SET report_json = json_set(report_json, '$.cached_images', json(?)) WHERE host_id = 'personal'")
      .bind(JSON.stringify([{ image_key: image.imageKey, image_id: image.imageSha256, phase: "ready" }])).run();
    const run = await beginScenarioRun(start);
    await run.deliveryHint;
    expect(run.hostId).toBe("personal");
    const replay = await beginScenarioRun(start);
    await replay.deliveryHint;
    expect(replay).toMatchObject({ runId: run.runId, reused: true });
    expect(await db.select().from(scenarioRuns)).toHaveLength(1);
    expect(await visible()).toEqual(["private"]);
    await env.DB.prepare("UPDATE scenario_runs SET active_key = NULL, completed_at = ?").bind(Date.now()).run();
    expect(await visible()).toEqual([]); // Consumed preparation must not return after completion.
  });

  it.each([
    { race: "same request", winnerOverrides: {}, errorCode: null },
    { race: "different request scope", winnerOverrides: { hostId: "personal" }, errorCode: "idempotency_key_conflict" },
    { race: "different key", winnerOverrides: { idempotencyKey: "another-personal-start" }, errorCode: "scenario_preparation_changed" },
  ])("recovers a preparation refusal only for an exact replay: $race", async ({ winnerOverrides, errorCode }) => {
    const prep = await input();
    const start = { scenarioId: "private", userId: "owner", organizationId: "org", idempotencyKey: prep.requestKey };
    await env.DB.prepare("UPDATE host_actual_state SET report_json = json_set(report_json, '$.cached_images', json(?)) WHERE host_id = 'personal'")
      .bind(JSON.stringify([{ image_key: image.imageKey, image_id: image.imageSha256, phase: "ready" }])).run();

    // Hold B after its replay lookup and before its first preparation batch.
    // Let A commit, then run B's real D1 guard and all three refused attempts.
    let held = false;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const batch = env.DB.batch.bind(env.DB);
    let preparationBatches = 0;
    vi.spyOn(env.DB, "batch").mockImplementation(async statements => {
      const preparation = statements.some(statement =>
        (statement as unknown as { statement: string }).statement.includes("WITH prep ("));
      if (preparation) {
        preparationBatches++;
        if (!held) {
          held = true;
          await barrier;
        }
      }
      return batch(statements);
    });
    const waiting = beginScenarioRun(start);
    // Attach rejection handling before either request can complete.
    const settled = waiting.then(result => ({ result, error: null }), error => ({ result: null, error }));
    try {
      await vi.waitFor(() => expect(held).toBe(true));
      const winner = await beginScenarioRun({ ...start, ...winnerOverrides });
      await winner.deliveryHint;
      expect(winner.reused).toBe(false);
      const snapshot = async () => ({
        runs: await db.select().from(scenarioRuns),
        executions: await db.select().from(runtimeExecutions),
        desired: await db.select().from(hostDesiredState),
        preparations: await db.select().from(personalImagePreparations),
      });
      const beforeReplay = await snapshot();
      release();
      const replay = await settled;
      expect(preparationBatches).toBe(4); // A once, B three refused attempts.
      if (errorCode) {
        expect(replay.error).toMatchObject({ code: errorCode });
        expect(replay.result).toBeNull();
      } else {
        expect(replay.error).toBeNull();
        expect(replay.result).toMatchObject({ accepted: true, runId: winner.runId,
          scenarioId: winner.scenarioId, hostId: winner.hostId, acceptedAt: winner.acceptedAt, reused: true });
        await replay.result!.deliveryHint;
      }
      expect(beforeReplay.runs).toHaveLength(1);
      expect(beforeReplay.executions).toHaveLength(1);
      expect(await snapshot()).toEqual(beforeReplay);
    } finally {
      release();
      await settled;
    }
  });

  it.each([
    ["membership", "DELETE FROM member"],
    ["credentials", "UPDATE agent_hosts SET credential_generation = 2 WHERE id = 'personal'"],
    ["owner", "UPDATE agent_hosts SET user_id = 'other' WHERE id = 'personal'"],
    ["disabled host", "UPDATE agent_hosts SET disabled = 1 WHERE id = 'personal'"],
    ["paused host", "UPDATE agent_hosts SET scenario_enabled = 0 WHERE id = 'personal'"],
    ["expiry", "UPDATE personal_image_preparations SET expires_at = 1"],
    ["course", "DELETE FROM course_catalogs"],
    ["lecture", "UPDATE course_catalogs SET catalog_json = json_set(catalog_json, '$.courses[0].lectures', json('[]'))"],
    ["image", "UPDATE vm_scenario_vms SET image_sha256 = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'"],
    ["scenario", "UPDATE vm_scenarios SET enabled = 0"],
    ["desired cache", "UPDATE host_desired_state SET doc_json = json_set(doc_json, '$.cached_images', json('[]'))"],
    ["desired owner", "UPDATE host_desired_state SET doc_json = json_set(doc_json, '$.owner_user_id', 'other')"],
    ["user banned", "UPDATE user SET banned = 1 WHERE id = 'owner'"],
    ["placement", "UPDATE user SET metal_placement = 'platform' WHERE id = 'owner'"],
  ])("revokes preparation access after a change to %s", async (_name, query) => {
    await preparePersonalScenarioImages(await input());
    expect(await visible()).toEqual(["private"]);
    await env.DB.prepare(query).run();
    expect(await visible()).toEqual([]);
    expect(await agentCanAccessManifest(db, await agent(), "b".repeat(64), image.imageSha256)).toBe(false);
  });

  it("retries on one host and replaces the prior grant instead of accumulating images", async () => {
    await seedHost("second");
    const first = await preparePersonalScenarioImages(await input());
    const again = await preparePersonalScenarioImages(await input());
    expect(again).toBe(first);
    expect(await db.select().from(personalImagePreparations)).toHaveLength(1);
    const next = await input();
    await preparePersonalScenarioImages({ ...next, requestKey: "personal-start-2", ...(first ? { requestedHostId: first } : {}),
      access: { ...access, scenarioId: "other-private", lectureId: "other-private" },
      requiredImages: [{ ...image, imageKey: { ...image.imageKey, scenario: "other-private" } }] });
    expect(await visible(first)).toEqual(["other-private"]);
  });

  it("requires an explicit preparation for public images too", async () => {
    expect(await visible()).toEqual([]);
    const prep = await input();
    await preparePersonalScenarioImages({ ...prep, access: { ...access, organizationId: null, courseScopeKey: "public",
      scenarioId: "public", lectureId: "public" }, requiredImages: [{ ...image, imageKey: { ...image.imageKey, scenario: "public" } }] });
    expect(await visible()).toEqual(["public"]);
  });

  it("removes expired preparation from cache without waiting for another start", async () => {
    await preparePersonalScenarioImages(await input());
    await env.DB.prepare("UPDATE personal_image_preparations SET expires_at = 1").run();
    const result = await reconcileHostScenarioImages(db, { hostId: "personal", architecture: "x86_64", nowUnixMs: Date.now() });
    expect(result.desiredState!.cached_images).toEqual([]);
    expect(await visible()).toEqual([]);
  });

  it("does not warm personal hosts during publication", async () => {
    const result = await reconcileScenarioImagesForPublicationScope(db, { publicationOrganizationId: "org", nowUnixMs: Date.now() });
    expect(result.changedHostIds).toEqual(["platform"]);
    expect(await db.select().from(personalImagePreparations)).toEqual([]);
    expect(await visible()).toEqual([]);
  });

  it("refuses a grant if membership changes before the atomic cache write", async () => {
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce(async statements => {
      await env.DB.prepare("DELETE FROM member").run();
      return batch(statements);
    });
    await expect(preparePersonalScenarioImages(await input())).rejects.toMatchObject({ code: "scenario_preparation_changed" });
    expect(await db.select().from(personalImagePreparations)).toEqual([]);
    expect(await visible()).toEqual([]);
    const [desired] = await db.select().from(hostDesiredState).where(eq(hostDesiredState.hostId, "personal"));
    expect(desired!.docJson.cached_images).toEqual([]);
  });

  it("retries a cache version race without overwriting another desired-state change", async () => {
    const batch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce(async statements => {
      await env.DB.prepare(`UPDATE host_desired_state SET version = version + 1,
        doc_json = json_set(doc_json, '$.version', version + 1, '$.builds', json(?))
        WHERE host_id = 'personal'`).bind(JSON.stringify([{ build_id: "concurrent", scenario_id: "private",
          arch: "x86_64", rev: "revision", content_hash: "e".repeat(64), bundle_ref: "bundle" }])).run();
      return batch(statements);
    });
    expect(await preparePersonalScenarioImages(await input())).toBe("personal");
    const [desired] = await db.select().from(hostDesiredState).where(eq(hostDesiredState.hostId, "personal"));
    expect(desired!.docJson.builds[0]!.build_id).toBe("concurrent");
    expect(await visible()).toEqual(["private"]);
  });

  it("renews an expired grant on a new start attempt and retries a failed image", async () => {
    await preparePersonalScenarioImages(await input());
    const [first] = await db.select().from(hostDesiredState).where(eq(hostDesiredState.hostId, "personal"));
    await env.DB.prepare("UPDATE personal_image_preparations SET expires_at = 1").run();
    await env.DB.prepare("UPDATE host_actual_state SET report_json = json_set(report_json, '$.cached_images', json(?)) WHERE host_id = 'personal'")
      .bind(JSON.stringify([{ image_key: image.imageKey, image_id: image.imageSha256, phase: "failed" }])).run();
    expect(await visible()).toEqual([]);
    expect(await preparePersonalScenarioImages(await input())).toBe("personal");
    const [next] = await db.select().from(hostDesiredState).where(eq(hostDesiredState.hostId, "personal"));
    expect(next!.version).toBeGreaterThan(first!.version);
    expect(await visible()).toEqual(["private"]);
  });

  it("rechecks sequential course access before issuing a grant and on each read", async () => {
    const prep = await input();
    const second = { ...prep, access: { ...access, scenarioId: "other-private", lectureId: "other-private" },
      requiredImages: [{ ...image, imageKey: { ...image.imageKey, scenario: "other-private" } }] };
    await preparePersonalScenarioImages(second);
    expect(await visible()).toEqual(["other-private"]);
    await env.DB.prepare("UPDATE course_catalogs SET catalog_json = json_set(catalog_json, '$.courses[0].sequential', json('true')) WHERE scope_key = 'organization:org'").run();
    expect(await visible()).toEqual([]);
    await expect(preparePersonalScenarioImages(second)).rejects.toMatchObject({ code: "scenario_preparation_changed" });
  });

  async function useOrganizationHost() {
    await env.DB.prepare("UPDATE user SET metal_placement = 'platform'").run();
    await env.DB.prepare("UPDATE organization SET metal_placement = 'organization' WHERE id = 'org'").run();
    await env.DB.prepare("UPDATE agent_hosts SET scope = 'organization', organization_id = 'org' WHERE id = 'personal'").run();
  }

  it("prepares organization images for a member other than the host creator", async () => {
    await useOrganizationHost();
    await db.insert(member).values({ id: "other-membership", userId: "other", organizationId: "org", role: "member", createdAt: new Date() });
    const prep = { ...await input(), access: { ...access, userId: "other" } };
    expect(await preparePersonalScenarioImages(prep)).toBe("personal");
    expect(await visible()).toEqual(["private"]);
    await env.DB.prepare("DELETE FROM member WHERE user_id = 'other'").run();
    expect(await visible()).toEqual([]);
    await expect(preparePersonalScenarioImages(prep)).resolves.toBeUndefined();
  });

  it("keeps other members' preparations and refuses another organization's images", async () => {
    await useOrganizationHost();
    await db.insert(member).values({ id: "other-membership", userId: "other", organizationId: "org", role: "member", createdAt: new Date() });
    await preparePersonalScenarioImages(await input());
    const prep = { ...await input(), requestKey: "other-start", access: { ...access, userId: "other", scenarioId: "other-private", lectureId: "other-private" },
      requiredImages: [{ ...image, imageKey: { ...image.imageKey, scenario: "other-private" } }] };
    await preparePersonalScenarioImages(prep);
    expect((await visible()).sort()).toEqual(["other-private", "private"]);
    const result = await reconcileHostScenarioImages(db, { hostId: "personal", architecture: "x86_64", nowUnixMs: Date.now() });
    expect(result.desiredState!.cached_images).toHaveLength(2);
    await db.insert(organization).values({ id: "foreign-org", name: "Foreign", slug: "foreign", createdAt: new Date() });
    await env.DB.prepare("UPDATE vm_scenarios SET organization_id = 'foreign-org' WHERE scenario_id = 'other-private'").run();
    expect(await visible()).toEqual(["private"]);
    await expect(preparePersonalScenarioImages(prep)).rejects.toMatchObject({ code: "scenario_preparation_changed" });
  });

  it("starts an organization run and keeps its exact image grant until membership ends", async () => {
    await useOrganizationHost();
    const prep = await input();
    const start = { scenarioId: "private", userId: "owner", organizationId: "org", idempotencyKey: prep.requestKey };
    await expect(beginScenarioRun(start)).rejects.toMatchObject({ code: "image_not_ready" });
    expect(await visible()).toEqual(["private"]);
    await env.DB.prepare("UPDATE host_actual_state SET report_json = json_set(report_json, '$.cached_images', json(?)) WHERE host_id = 'personal'")
      .bind(JSON.stringify([{ image_key: image.imageKey, image_id: image.imageSha256, phase: "ready" }])).run();
    const run = await beginScenarioRun(start);
    await run.deliveryHint;
    expect(run.hostId).toBe("personal");
    expect(await visible()).toEqual(["private"]);
    await env.DB.prepare("DELETE FROM member WHERE user_id = 'owner'").run();
    expect(await visible()).toEqual([]);
  });

});
