/// <reference types="@cloudflare/vitest-plugin/types" />

import { gzipSync } from "node:zlib";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KINO_CONFIG_MEDIA_TYPE } from "@/control-plane/image-registry/push";
import { member, organization } from "@/db/schema";
import type { DesiredVmV3, VmLabV1, VmVerifyV1 } from "@/generated/contracts/bridge-message-v9";
import validateBridgeMessageV9 from "@/generated/contracts/bridge-message-v9.validate";
import bundleFixture from "@/generated/fixtures/scenario/broken-nginx-bundle.json";
import { acquireRegistrySweep, finishRegistrySweep, setRegistryEnforcement } from "@/lib/image-registry-admission";
import { selectCandidateRevision, settleScenarioRevisions } from "@/lib/machine-builds";
import { ingestSourceBundle } from "@/lib/scenario-bundles";
import { sourceCompileDigest } from "@/lib/scenario-contract/source-bundle";
import {
  assertScenarioAdmin,
  listAdministeredScenarios,
  moveLiveRevision,
  type VerifyReport,
} from "@/lib/scenario-revisions";
import { beginScenarioRun } from "@/lib/scenario-runs/begin";
import { VALIDATION_USER_ID } from "@/lib/scenario-runs/content-access";
import { expireOverdueRunLeases } from "@/lib/scenario-runs/lifecycle";
import { beginVerifyRun, liveScenarioRevision } from "@/lib/scenario-runs/revision-begin";
import { getScenarioRunStatusForUser } from "@/lib/scenario-runs/status";
import { mutateHostDesiredStateV3 } from "@/lib/desired-state-store";
import { createFixtureMember } from "@/test/account-fixtures";
import { resetD1Database } from "@/test/d1-migrations";
import {
  KINO, connect, desiredDoc, disconnect, enrollHost, labState, machineImage, registryToken, sendState, sendVm, store, until, v2, vmState,
} from "./scenario-runs/revision-test-fixtures";

const candidateOf = (id: string) => env.DB.prepare("SELECT candidate_rev FROM scenarios WHERE id = ?1").bind(id).first("candidate_rev");

describe("candidate revision", () => {
  beforeEach(resetD1Database);

  async function revision(rev: string, state: string, createdAt: number) {
    await env.DB.prepare(`INSERT INTO scenario_revisions (scenario_id, rev, guest_contract, doc_json, state, created_at)
      VALUES ('intar/web', ?1, 3, '{}', ?2, ?3)`).bind(rev, state, createdAt).run();
  }
  const select = (rev: string) => selectCandidateRevision(env.DB, "intar/web", rev).run();

  it("is the newest revision once it is ready or verified, never an older one that settles later", async () => {
    await env.DB.prepare(`INSERT INTO scenarios (id, namespace, slug, scope_key, enabled, play)
      VALUES ('intar/web', 'intar', 'web', 'public', 1, 0)`).run();
    await revision("r1", "ready", 1);
    await revision("r2", "building", 2);
    await select("r1");
    expect(await candidateOf("intar/web")).toBeNull();
    await env.DB.prepare("UPDATE scenario_revisions SET state = 'verified' WHERE rev = 'r2'").run();
    await select("r2");
    expect(await candidateOf("intar/web")).toBe("r2");
    await revision("r0", "ready", 0);
    await select("r0");
    expect(await candidateOf("intar/web")).toBe("r2");
    // A newer head that failed keeps the last candidate.
    await revision("r3", "failed", 3);
    await select("r3");
    expect(await candidateOf("intar/web")).toBe("r2");
    // Two revisions of one millisecond: the greater rev is the head.
    await revision("r5", "ready", 5);
    await revision("r4", "ready", 5);
    await select("r4");
    expect(await candidateOf("intar/web")).toBe("r2");
    await select("r5");
    expect(await candidateOf("intar/web")).toBe("r5");
  });
});

const ADMIN = "platform-admin";
const ORG_OWNER = "org-owner";
const OTHER_OWNER = "other-owner";
const LEARNER = "learner";
const LEARNER_2 = "learner-2";
const PLATFORM = "platform-1";
const PLATFORM_2 = "platform-2";
const PUBLIC_ID = "intar/broken-nginx";
const ORG_ID = "acme/broken-nginx";

let digest: string;
const rev = (sha: string) => `git-42-${sha.repeat(40)}-${digest}`;

/** Ingests a bundle as `rev` and finishes its builds with `image`, as a builder's result would. */
async function publish(at: string, image: string, organizationId: string | null = null, bundle: unknown = bundleFixture) {
  const refused = await ingestSourceBundle(env, {
    organizationId, rev: at, gzip: new Uint8Array(gzipSync(JSON.stringify(bundle))), stored: false,
  });
  expect(refused).toBeNull();
  await env.DB.prepare("UPDATE machine_builds SET state = 'succeeded', image_digest = ?1 WHERE image_digest IS NULL")
    .bind(image).run();
  await settleScenarioRevisions(env, { rev: at });
}

const revisionRow = (scenarioId: string, at: string) => env.DB.prepare(
  "SELECT state, verify_run_id, verify_report_json, live_at, doc_json FROM scenario_revisions WHERE scenario_id = ?1 AND rev = ?2",
).bind(scenarioId, at).first<{ state: string; verify_run_id: string | null; verify_report_json: string | null;
  live_at: number | null; doc_json: string }>();
const scenarioRow = (id: string) => env.DB.prepare("SELECT live_rev, candidate_rev FROM scenarios WHERE id = ?1")
  .bind(id).first<{ live_rev: string | null; candidate_rev: string | null }>();
const markVerified = (scenarioId: string, at: string) =>
  env.DB.prepare("UPDATE scenario_revisions SET state = 'verified' WHERE scenario_id = ?1 AND rev = ?2").bind(scenarioId, at).run();
const promote = (at: string, liveRev: string | null, actorUserId = ADMIN, scenarioId = PUBLIC_ID) =>
  moveLiveRevision({ scenarioId, rev: at, liveRev, kind: "promote", actorUserId });
const rollback = (at: string, liveRev: string | null, actorUserId = ADMIN) =>
  moveLiveRevision({ scenarioId: PUBLIC_ID, rev: at, liveRev, kind: "rollback", actorUserId });
const catalogRow = () => env.DB.prepare("SELECT source_revision, catalog_json FROM course_catalogs WHERE scope_key = 'public'")
  .first<{ source_revision: string; catalog_json: string }>();
/** The fixture bundle with another course title, so its catalog differs. */
const retitled = (title: string) => {
  const bundle = structuredClone(bundleFixture);
  bundle.course_catalog.courses[0]!.title = title;
  return bundle;
};
const drain = () => env.DB.prepare(
  "INSERT INTO runtime_operation_gates (key, state, updated_at) VALUES ('image_cutover', 'drained', 1)",
).run();

/** The learner's start of the public scenario's lecture, after the lecture before it. */
async function learnerStart(userId: string, key = `${userId}-start`) {
  await env.DB.prepare(`INSERT OR IGNORE INTO course_unit_completions (user_id, scope_key, course_id, lecture_id, completed_at)
    VALUES (?1, 'public', 'linux-operations', '00-operating-model', 1)`).bind(userId).run();
  return beginScenarioRun({ scenarioId: PUBLIC_ID, userId, idempotencyKey: key, organizationId: null });
}

const runOf = (runId: string) => env.DB.prepare(
  "SELECT scenario_rev, host_id, user_id, organization_id, launch_source, active_key, end_reason, delete_requested_at, state FROM scenario_runs WHERE run_id = ?1",
).bind(runId).first<{ scenario_rev: string; host_id: string; user_id: string; organization_id: string | null; launch_source: string;
  active_key: string | null; end_reason: string | null; delete_requested_at: number | null; state: string }>();

function verifyLab(verify: VmVerifyV1, state: VmLabV1["state"] = "ready", failure: string | null = null): VmLabV1 {
  return { ...labState(state, [], failure), verify };
}
const verifyVm = (runId: string, lab: VmLabV1) => ({ ...vmState(runId, "webserver", lab), owner_user_id: VALIDATION_USER_ID });

describe("promotion, rollback and verify runs", () => {
  let image: string;
  let ws: WebSocket;
  const sockets: Array<[WebSocket, string]> = [];

  beforeAll(async () => {
    digest = await sourceCompileDigest();
  });

  beforeEach(async () => {
    await resetD1Database();
    for (const prefix of ["builds/", "oci/"]) {
      const listed = await env.VM_IMAGE_REGISTRY_BUCKET.list({ prefix });
      if (listed.objects.length) await env.VM_IMAGE_REGISTRY_BUCKET.delete(listed.objects.map((object) => object.key));
    }
    const db = drizzle(env.DB);
    await createFixtureMember({ d1: env.DB, userId: ADMIN, role: "admin" });
    for (const id of [ORG_OWNER, OTHER_OWNER, LEARNER, LEARNER_2]) await createFixtureMember({ d1: env.DB, userId: id });
    await db.insert(organization).values([
      { id: "org-a", name: "Acme", slug: "acme", createdAt: new Date() },
      { id: "org-b", name: "Other", slug: "other", createdAt: new Date() },
    ]);
    await db.insert(member).values([
      { id: "m-a", organizationId: "org-a", userId: ORG_OWNER, role: "owner", createdAt: new Date() },
      { id: "m-b", organizationId: "org-b", userId: OTHER_OWNER, role: "owner", createdAt: new Date() },
    ]);
    expect(await store("application/vnd.intar.kino.v1", KINO_CONFIG_MEDIA_TYPE, { guest_contract: 3, version: "run-test" },
      [["application/octet-stream", "kino binary"]])).toBe(KINO);
    image = await machineImage("webserver");
    await enrollHost(PLATFORM, ADMIN, "platform");
    ws = await connect(PLATFORM);
    sockets.push([ws, PLATFORM]);
    await publish(rev("a"), image);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const [socket, hostId] of sockets.splice(0)) await disconnect(socket, hostId);
  });

  it("ingests into a ready candidate that is not live", async () => {
    expect(await scenarioRow(PUBLIC_ID)).toEqual({ live_rev: null, candidate_rev: rev("a") });
    expect((await revisionRow(PUBLIC_ID, rev("a")))?.state).toBe("ready");
    expect(await liveScenarioRevision(env.DB, PUBLIC_ID, null)).toBeNull();
  });

  describe("promotion", () => {
    it("refuses a revision that is not verified, of another contract, or not the candidate", async () => {
      await expect(promote(rev("a"), null)).rejects.toMatchObject({ status: 409, code: "revision_not_verified" });
      await markVerified(PUBLIC_ID, rev("a"));
      await env.DB.prepare("UPDATE scenario_revisions SET guest_contract = 2").run();
      await expect(promote(rev("a"), null)).rejects.toMatchObject({ status: 409, code: "guest_contract_mismatch" });
      await env.DB.prepare("UPDATE scenario_revisions SET guest_contract = 3").run();
      await env.DB.prepare("UPDATE scenarios SET candidate_rev = 'other'").run();
      await expect(promote(rev("a"), null)).rejects.toMatchObject({ status: 409, code: "revision_not_candidate" });
      expect((await scenarioRow(PUBLIC_ID))?.live_rev).toBeNull();
    });

    it("refuses another scope's admin and a stale live revision", async () => {
      await markVerified(PUBLIC_ID, rev("a"));
      await expect(promote(rev("a"), null, ORG_OWNER)).rejects.toMatchObject({ status: 404 });
      await expect(promote(rev("a"), "elsewhere")).rejects.toMatchObject({ status: 409, code: "live_revision_changed" });
      expect((await scenarioRow(PUBLIC_ID))?.live_rev).toBeNull();
    });

    it("never makes a revision live that a racing ingest or verify changed after the read", async () => {
      await markVerified(PUBLIC_ID, rev("a"));
      const get = env.VM_IMAGE_REGISTRY_BUCKET.get.bind(env.VM_IMAGE_REGISTRY_BUCKET);
      vi.spyOn(env.VM_IMAGE_REGISTRY_BUCKET, "get").mockImplementationOnce(async (key: string) => {
        await env.DB.prepare("UPDATE scenario_revisions SET state = 'ready'").run();
        return get(key);
      });
      await expect(promote(rev("a"), null)).rejects.toMatchObject({ status: 409, code: "live_revision_changed" });
      expect((await scenarioRow(PUBLIC_ID))?.live_rev).toBeNull();
      expect(await env.DB.prepare("SELECT count(*) AS n FROM course_catalogs").first("n")).toBe(0);
      await markVerified(PUBLIC_ID, rev("a"));
      const results = await Promise.allSettled([promote(rev("a"), null), promote(rev("a"), null)]);
      expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    });

    it("moves live_rev, applies the catalog with namespaced ids and updates platform caches, under the drain too", async () => {
      await markVerified(PUBLIC_ID, rev("a"));
      await drain();
      expect(await promote(rev("a"), null)).toEqual({ liveRev: rev("a") });
      expect(await scenarioRow(PUBLIC_ID)).toEqual({ live_rev: rev("a"), candidate_rev: rev("a") });
      expect((await revisionRow(PUBLIC_ID, rev("a")))?.live_at).toEqual(expect.any(Number));
      const catalog = await env.DB.prepare("SELECT catalog_json, source_revision FROM course_catalogs WHERE scope_key = 'public'")
        .first<{ catalog_json: string; source_revision: string }>();
      expect(catalog?.source_revision).toBe(rev("a"));
      const lectures = JSON.parse(catalog!.catalog_json).courses[0].lectures as Array<{ lectureId: string; scenarioId?: string }>;
      expect(lectures.map((lecture) => [lecture.lectureId, lecture.scenarioId ?? null]))
        .toEqual([["00-operating-model", null], ["01-broken-nginx", PUBLIC_ID]]);
      expect((await until(() => desiredDoc(PLATFORM), (doc) => doc?.cached_images.includes(image) === true))?.cached_images)
        .toEqual([image]);
    });

    it("holds a promotion whose catalog would strand an active run", async () => {
      await markVerified(PUBLIC_ID, rev("a"));
      await promote(rev("a"), null);
      const { runId } = await learnerStart(LEARNER);
      // The next commit drops the lecture the learner is in.
      const dropped = structuredClone(bundleFixture);
      dropped.course_catalog.courses[0]!.lectures.splice(1, 1);
      await publish(rev("b"), image, null, dropped);
      // The same content as a verified revision: verified without a run.
      expect((await revisionRow(PUBLIC_ID, rev("b")))?.state).toBe("verified");
      expect((await scenarioRow(PUBLIC_ID))?.candidate_rev).toBe(rev("b"));
      await expect(promote(rev("b"), rev("a"))).rejects.toMatchObject({ status: 409, code: "active_runs_would_lose_access" });
      await env.DB.prepare("UPDATE scenario_runs SET state = 'completed', completed_at = 1, active_key = NULL WHERE run_id = ?1")
        .bind(runId).run();
      await promote(rev("b"), rev("a"));
      expect((await scenarioRow(PUBLIC_ID))?.live_rev).toBe(rev("b"));
    });

    it("holds the unit guard in the move itself, against a start that commits after the check", async () => {
      await markVerified(PUBLIC_ID, rev("a"));
      await promote(rev("a"), null);
      const dropped = structuredClone(bundleFixture);
      dropped.course_catalog.courses[0]!.lectures.splice(1, 1);
      await publish(rev("b"), image, null, dropped);
      // A learner start commits between the check and the move's own write.
      const batch = env.DB.batch.bind(env.DB);
      let started = "";
      vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
        started = (await learnerStart(LEARNER)).runId;
        return batch(statements);
      });
      await expect(promote(rev("b"), rev("a"))).rejects.toMatchObject({ status: 409, code: "active_runs_would_lose_access" });
      expect(started).not.toBe("");
      expect((await scenarioRow(PUBLIC_ID))?.live_rev).toBe(rev("a"));
      expect((await catalogRow())?.source_revision).toBe(rev("a"));
      expect((await revisionRow(PUBLIC_ID, rev("b")))?.live_at).toBeNull();
    });

    it("starts learners on the new live revision while an older run keeps its snapshot", async () => {
      await markVerified(PUBLIC_ID, rev("a"));
      await promote(rev("a"), null);
      const first = await learnerStart(LEARNER);
      await publish(rev("b"), image);
      await promote(rev("b"), rev("a"));
      const second = await learnerStart(LEARNER_2);
      expect((await runOf(first.runId))?.scenario_rev).toBe(rev("a"));
      expect((await runOf(second.runId))?.scenario_rev).toBe(rev("b"));
      const vms = (await desiredDoc(PLATFORM))!.vms;
      expect(vms.filter((vm) => vm.run_id === first.runId).map((vm) => vm.desired_phase)).toEqual(["running"]);
    });
  });

  describe("rollback", () => {
    it("goes back only to a verified revision that was live, of the current contract", async () => {
      await markVerified(PUBLIC_ID, rev("a"));
      await promote(rev("a"), null);
      await publish(rev("b"), image);
      await expect(rollback(rev("b"), rev("a"))).rejects.toMatchObject({ code: "revision_never_live" });
      await promote(rev("b"), rev("a"));
      await expect(rollback(rev("a"), rev("b"), ORG_OWNER)).rejects.toMatchObject({ status: 404 });
      await env.DB.prepare("UPDATE scenario_revisions SET guest_contract = 2 WHERE rev = ?1").bind(rev("a")).run();
      await expect(rollback(rev("a"), rev("b"))).rejects.toMatchObject({ code: "guest_contract_mismatch" });
      await env.DB.prepare("UPDATE scenario_revisions SET guest_contract = 3 WHERE rev = ?1").bind(rev("a")).run();
      await drain();
      expect(await rollback(rev("a"), rev("b"))).toEqual({ liveRev: rev("a") });
      expect(await scenarioRow(PUBLIC_ID)).toEqual({ live_rev: rev("a"), candidate_rev: rev("b") });
    });

    it("goes back only to a revision the registry sweep keeps", async () => {
      await markVerified(PUBLIC_ID, rev("a"));
      await promote(rev("a"), null);
      await publish(rev("b"), image);
      await markVerified(PUBLIC_ID, rev("b"));
      await promote(rev("b"), rev("a"));
      // rev a is the third newest verified revision, so it is kept.
      await publish(rev("c"), image);
      await markVerified(PUBLIC_ID, rev("c"));
      expect((await listAdministeredScenarios(ADMIN))[0]?.revisions.find((r) => r.rev === rev("a"))?.canGoLive).toBe(true);
      // A fourth verified revision pushes it out of the kept set.
      await publish(rev("d"), image);
      await markVerified(PUBLIC_ID, rev("d"));
      expect((await listAdministeredScenarios(ADMIN))[0]?.revisions.find((r) => r.rev === rev("a"))?.canGoLive).toBe(false);
      await expect(rollback(rev("a"), rev("b"))).rejects.toMatchObject({ code: "revision_not_retained" });
      expect((await scenarioRow(PUBLIC_ID))?.live_rev).toBe(rev("b"));
    });

    it("refuses a target whose machine image is no longer indexed, for a promotion too", async () => {
      await markVerified(PUBLIC_ID, rev("a"));
      await promote(rev("a"), null);
      await publish(rev("b"), image);
      await markVerified(PUBLIC_ID, rev("b"));
      const gone = `sha256:${"0".repeat(64)}`;
      await env.DB.prepare("UPDATE scenario_revisions SET doc_json = json_set(doc_json, '$.machines[0].image_digest', ?1) WHERE rev = ?2")
        .bind(gone, rev("b")).run();
      expect((await listAdministeredScenarios(ADMIN))[0]?.revisions.find((r) => r.rev === rev("b"))?.canGoLive).toBe(false);
      await expect(promote(rev("b"), rev("a"))).rejects.toMatchObject({ code: "revision_images_gone" });

      await env.DB.prepare("UPDATE scenario_revisions SET doc_json = json_set(doc_json, '$.machines[0].image_digest', ?1) WHERE rev = ?2")
        .bind(image, rev("b")).run();
      await promote(rev("b"), rev("a"));
      await env.DB.prepare("UPDATE scenario_revisions SET doc_json = json_set(doc_json, '$.machines[0].image_digest', ?1) WHERE rev = ?2")
        .bind(gone, rev("a")).run();
      await expect(rollback(rev("a"), rev("b"))).rejects.toMatchObject({ code: "revision_images_gone" });
      expect((await scenarioRow(PUBLIC_ID))?.live_rev).toBe(rev("b"));
    });

    it("waits for a sweep that holds the registry, and leaves the live images in place", async () => {
      await markVerified(PUBLIC_ID, rev("a"));
      await promote(rev("a"), null);
      await publish(rev("b"), image);
      await markVerified(PUBLIC_ID, rev("b"));
      await promote(rev("b"), rev("a"));
      await setRegistryEnforcement(env, "enforce");
      const sweep = await acquireRegistrySweep(env, { owner: "rollback-test-collector" });
      if (!sweep.ok) throw new Error(`the test sweep did not acquire: ${sweep.code}`);

      await expect(rollback(rev("a"), rev("b"))).rejects.toMatchObject({ status: 503, code: "registry_busy" });
      expect((await scenarioRow(PUBLIC_ID))?.live_rev).toBe(rev("b"));
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM registry_manifests WHERE digest = ?1").bind(image).first("n")).toBe(1);

      await finishRegistrySweep(env, { sweepToken: sweep.lease.sweepToken, outcome: "completed" });
      expect(await rollback(rev("a"), rev("b"))).toEqual({ liveRev: rev("a") });
      // The move's writer lease is closed again, so the next sweep can start.
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM image_registry_operation_writers WHERE released_at IS NULL").first("n")).toBe(0);
    });
  });

  describe("course catalog", () => {
    it("moves only forward: a lagging promotion and a rollback leave the newer catalog", async () => {
      await markVerified(PUBLIC_ID, rev("a"));
      await promote(rev("a"), null);
      expect((await catalogRow())?.source_revision).toBe(rev("a"));
      // A newer bundle moves the catalog forward.
      await publish(rev("b"), image, null, retitled("Linux operations, second edition"));
      await promote(rev("b"), rev("a"));
      const newer = await catalogRow();
      expect(newer?.source_revision).toBe(rev("b"));
      expect(newer?.catalog_json).toContain("second edition");
      // A rollback to the older bundle keeps the catalog.
      await rollback(rev("a"), rev("b"));
      expect(await catalogRow()).toEqual(newer);
      // So does a promotion of a candidate from the older bundle.
      await promote(rev("b"), rev("a"));
      await env.DB.prepare("UPDATE scenarios SET candidate_rev = ?1 WHERE id = ?2").bind(rev("a"), PUBLIC_ID).run();
      await env.DB.prepare("UPDATE scenario_revisions SET live_at = NULL WHERE rev = ?1").bind(rev("a")).run();
      await promote(rev("a"), rev("b"));
      expect((await scenarioRow(PUBLIC_ID))?.live_rev).toBe(rev("a"));
      expect(await catalogRow()).toEqual(newer);
    });
  });

  describe("scope rights", () => {
    it("lets an organization's admins manage only their own scenarios and platform admins only public ones", async () => {
      await publish(rev("c"), image, "org-a");
      await expect(assertScenarioAdmin(ORG_OWNER, ORG_ID)).resolves.toBeUndefined();
      await expect(assertScenarioAdmin(ORG_OWNER, PUBLIC_ID)).rejects.toMatchObject({ status: 404 });
      await expect(assertScenarioAdmin(OTHER_OWNER, ORG_ID)).rejects.toMatchObject({ status: 404 });
      await expect(assertScenarioAdmin(LEARNER, PUBLIC_ID)).rejects.toMatchObject({ status: 404 });
      await expect(assertScenarioAdmin(ADMIN, ORG_ID)).rejects.toMatchObject({ status: 403 });
      await expect(assertScenarioAdmin(ADMIN, PUBLIC_ID)).resolves.toBeUndefined();
      expect((await listAdministeredScenarios(ORG_OWNER)).map((scenario) => scenario.id)).toEqual([ORG_ID]);
      expect(await listAdministeredScenarios(OTHER_OWNER)).toEqual([]);
      expect((await listAdministeredScenarios(ADMIN)).map((scenario) => [scenario.id, scenario.canManage]))
        .toEqual([[ORG_ID, false], [PUBLIC_ID, true]]);
      await markVerified(ORG_ID, rev("c"));
      await expect(promote(rev("c"), null, ADMIN, ORG_ID)).rejects.toMatchObject({ status: 404 });
      await expect(promote(rev("c"), null, OTHER_OWNER, ORG_ID)).rejects.toMatchObject({ status: 404 });
      await promote(rev("c"), null, ORG_OWNER, ORG_ID);
      const catalog = await env.DB.prepare("SELECT catalog_json FROM course_catalogs WHERE scope_key = 'organization:org-a'")
        .first<{ catalog_json: string }>();
      expect(catalog?.catalog_json).toContain(`"scenarioId":"${ORG_ID}"`);
    });
  });

  describe("verify runs", () => {
    async function cloneScenario(id: string) {
      const [namespace, slug] = id.split("/");
      await env.DB.prepare(`INSERT INTO scenarios (id, namespace, slug, scope_key, enabled, play, candidate_rev)
        VALUES (?1, ?2, ?3, 'public', 1, 0, ?4)`).bind(id, namespace, slug, rev("a")).run();
      await env.DB.prepare(`INSERT INTO scenario_revisions (scenario_id, rev, guest_contract, doc_json, content_digest, state, created_at)
        SELECT ?1, rev, guest_contract, doc_json, content_digest, state, created_at FROM scenario_revisions WHERE scenario_id = ?2`)
        .bind(id, PUBLIC_ID).run();
    }
    // A platform admin's start, which passes the operator drain.
    const verify = (scenarioId = PUBLIC_ID, at = rev("a")) =>
      beginVerifyRun({ scenarioId, rev: at, allowDrainedAdminProof: true });

    it("runs as the validation account on a platform host, in verify mode with the verify spec", async () => {
      await enrollHost("personal-1", LEARNER);
      sockets.push([await connect("personal-1"), "personal-1"]);
      await drain();
      const { runId, hostId } = await verify();
      expect(hostId).toBe(PLATFORM);
      expect(await runOf(runId)).toMatchObject({
        user_id: VALIDATION_USER_ID, organization_id: null, launch_source: "verify", scenario_rev: rev("a"),
        active_key: `verify:public:${rev("a")}:${PUBLIC_ID}`,
      });
      const doc = (await desiredDoc(PLATFORM))!;
      expect(validateBridgeMessageV9({ type: "desired_state", protocol_version: 9, host_id: PLATFORM, desired_state: doc })).toBe(true);
      const machine = JSON.parse((await revisionRow(PUBLIC_ID, rev("a")))!.doc_json).machines[0];
      expect(doc.vms).toEqual([expect.objectContaining({
        run_id: runId, name: "webserver", mode: "verify", spec: machine.verify_spec, image, kino: KINO,
        owner_user_id: VALIDATION_USER_ID,
      } satisfies Partial<DesiredVmV3>)]);
      expect(machine.verify_spec).not.toBe(machine.spec);
      expect((await desiredDoc("personal-1"))!.vms).toEqual([]);
    });

    it("waits for a platform host to report the candidate's images ready, which its cache already asks for", async () => {
      // The candidate is not live, yet the platform host is told to cache it.
      expect(await scenarioRow(PUBLIC_ID)).toEqual({ live_rev: null, candidate_rev: rev("a") });
      expect((await until(() => desiredDoc(PLATFORM), (doc) => !!doc?.cached_images.includes(image)))!.cached_images)
        .toContain(image);
      const reported = (ready: boolean) => until(
        () => env.DB.prepare("SELECT json_array_length(report_json, '$.cached_images') AS count FROM host_actual_state WHERE host_id = ?1")
          .bind(PLATFORM).first<number>("count"),
        (count) => ready ? (count ?? 0) > 0 : count === 0,
      );
      const imagesReady = async () => (await listAdministeredScenarios(ADMIN, PUBLIC_ID))[0]!.revisions
        .find((revision) => revision.rev === rev("a"))!.imagesReady;

      sendState(ws, PLATFORM, [], []);
      await reported(false);
      expect(await imagesReady()).toBe(false);
      await expect(verify()).rejects.toMatchObject({ status: 409, code: "scenario_image_preparing" });
      expect(await env.DB.prepare("SELECT count(*) AS count FROM scenario_runs").first("count")).toBe(0);
      expect((await desiredDoc(PLATFORM))!.vms).toEqual([]);

      sendState(ws, PLATFORM, []);
      await reported(true);
      expect(await imagesReady()).toBe(true);
      const { hostId } = await verify();
      expect(hostId).toBe(PLATFORM);
    });

    it("passes the operator drain only for a platform admin", async () => {
      await publish(rev("c"), image, "org-a");
      await drain();
      // An organization admin's start: no drain bypass.
      await expect(beginVerifyRun({ scenarioId: ORG_ID, rev: rev("c") }))
        .rejects.toMatchObject({ status: 503, code: "runtime_cutover_drained" });
      expect(await env.DB.prepare("SELECT count(*) AS n FROM scenario_runs").first("n")).toBe(0);
      await expect(verify()).resolves.toMatchObject({ hostId: PLATFORM });
    });

    it("finds no host when only hosts that users control are up", async () => {
      ws.close();
      await env.DB.prepare("UPDATE agent_hosts SET connected = 0 WHERE id = ?1").bind(PLATFORM).run();
      await enrollHost("personal-1", LEARNER);
      sockets.push([await connect("personal-1"), "personal-1"]);
      await expect(verify()).rejects.toMatchObject({ code: "scenario_host_unavailable" });
    });

    it("allows one run per revision and two per scope", async () => {
      await cloneScenario("intar/two");
      await cloneScenario("intar/three");
      await verify();
      await expect(verify()).rejects.toMatchObject({ status: 409, code: "verify_run_active" });
      await verify("intar/two");
      await expect(verify("intar/three")).rejects.toMatchObject({ status: 409, code: "verify_quota_exhausted" });
      // Another scope has its own quota.
      await publish(rev("c"), image, "org-a");
      await expect(verify(ORG_ID, rev("c"))).resolves.toMatchObject({ hostId: PLATFORM });
    });

    it("refuses a revision that is not the ready candidate", async () => {
      await markVerified(PUBLIC_ID, rev("a"));
      await expect(verify()).rejects.toMatchObject({ code: "verify_revision_not_candidate" });
    });

    it("grants its host the verify spec only while it runs", async () => {
      const { runId } = await verify();
      const spec = JSON.parse((await revisionRow(PUBLIC_ID, rev("a")))!.doc_json).machines[0].verify_spec as string;
      await enrollHost(PLATFORM_2, ADMIN, "platform");
      await enrollHost("personal-1", LEARNER);
      const own = await registryToken(PLATFORM, ADMIN, "platform");
      const manifest = `/v2/machines/${image.slice(7)}/manifests/machine`;
      expect(await v2(`/v2/specs/blobs/${spec}`, own)).toBe(200);
      expect(await v2(manifest, own)).toBe(200);
      expect(await v2(`/v2/specs/blobs/${spec}`, await registryToken(PLATFORM_2, ADMIN, "platform"))).toBe(404);
      const personal = await registryToken("personal-1", LEARNER);
      expect(await v2(`/v2/specs/blobs/${spec}`, personal)).toBe(404);
      expect(await v2(manifest, personal)).toBe(404);
      await mutateHostDesiredStateV3(drizzle(env.DB), PLATFORM, Date.now(), (draft) => {
        for (const vm of draft.vms) vm.lease_expires_at_unix_ms = Date.now() - 1;
      });
      expect((await expireOverdueRunLeases(PLATFORM, Date.now(), { wakeHostRuntime: false })).expiredRunIds).toEqual([runId]);
      expect(await v2(`/v2/specs/blobs/${spec}`, own)).toBe(404);
    });

    it("verifies the revision when every machine passed, and ends the run", async () => {
      const { runId } = await verify();
      sendVm(ws, PLATFORM, verifyVm(runId, verifyLab({ steps: [], done: false, passed: false, pre_done: true })));
      sendVm(ws, PLATFORM, verifyVm(runId, verifyLab({ steps: [], done: true, passed: true, pre_done: true })));
      const row = await until(() => revisionRow(PUBLIC_ID, rev("a")), (current) => current?.state === "verified");
      expect(row).toMatchObject({ state: "verified", verify_run_id: runId });
      expect((JSON.parse(row!.verify_report_json!) as VerifyReport).outcome).toBe("passed");
      expect((await until(() => runOf(runId), (run) => run?.delete_requested_at !== null))?.delete_requested_at).not.toBeNull();
      expect((await until(() => desiredDoc(PLATFORM), (doc) => doc?.vms[0]?.desired_phase === "absent"))?.vms[0]?.desired_phase)
        .toBe("absent");
      // Never progress, and never anyone else's run.
      expect(await env.DB.prepare("SELECT count(*) AS n FROM course_unit_completions").first("n")).toBe(0);
      await expect(getScenarioRunStatusForUser({ runId, userId: LEARNER })).rejects.toMatchObject({ status: 404 });
      // Promotable now.
      await promote(rev("a"), null);
    });

    it("settles from a state report too", async () => {
      const { runId } = await verify();
      sendState(ws, PLATFORM, [verifyVm(runId, verifyLab({ steps: [], done: true, passed: true, pre_done: true }))]);
      expect(await until(() => revisionRow(PUBLIC_ID, rev("a")), (row) => row?.state === "verified"))
        .toMatchObject({ state: "verified", verify_run_id: runId });
      expect((await until(() => runOf(runId), (run) => run?.delete_requested_at !== null))?.delete_requested_at).not.toBeNull();
    });

    it("retries the teardown of a settled run on its next report", async () => {
      const { runId } = await verify();
      const passed = verifyVm(runId, verifyLab({ steps: [], done: true, passed: true, pre_done: true }));
      sendVm(ws, PLATFORM, passed);
      await until(() => runOf(runId), (run) => run?.delete_requested_at !== null);
      // As a teardown that did not land leaves it: settled, not going away.
      await env.DB.prepare("UPDATE scenario_runs SET delete_requested_at = NULL WHERE run_id = ?1").bind(runId).run();
      sendVm(ws, PLATFORM, { ...passed, updated_at_unix_ms: Date.now() + 1 });
      expect((await until(() => runOf(runId), (run) => run?.delete_requested_at !== null))?.delete_requested_at).not.toBeNull();
      expect((await revisionRow(PUBLIC_ID, rev("a")))?.verify_run_id).toBe(runId);
    });

    it("leaves the revision ready with the admin detail when verify or the lab fails", async () => {
      const { runId } = await verify();
      sendVm(ws, PLATFORM, verifyVm(runId, verifyLab({ steps: [{ task_id: "nginx-running", pre: "fail", solve_exit: 1,
        post: "fail", duration_ms: 5, tail: "solve.sh: exit 1", waiting_for: [] }], done: true, passed: false, pre_done: true })));
      const row = await until(() => revisionRow(PUBLIC_ID, rev("a")), (current) => current?.verify_run_id === runId);
      expect(row?.state).toBe("ready");
      const report = JSON.parse(row!.verify_report_json!) as VerifyReport;
      expect(report.outcome).toBe("failed");
      expect(JSON.stringify(report.machines)).toContain("solve.sh: exit 1");
      await until(() => runOf(runId), (run) => run?.active_key === null || run?.delete_requested_at !== null);

      const second = await (async () => {
        await env.DB.prepare("UPDATE scenario_runs SET active_key = NULL WHERE run_id = ?1").bind(runId).run();
        return verify();
      })();
      sendVm(ws, PLATFORM, verifyVm(second.runId, verifyLab({ steps: [], done: false, passed: false, pre_done: false },
        "failed", "ready nginx: timed out")));
      const failed = await until(() => revisionRow(PUBLIC_ID, rev("a")), (current) => current?.verify_run_id === second.runId);
      expect(failed?.state).toBe("ready");
      expect(JSON.stringify(JSON.parse(failed!.verify_report_json!).machines)).toContain("ready nginx: timed out");
      await expect(promote(rev("a"), null)).rejects.toMatchObject({ code: "revision_not_verified" });
    });

    it("ends with verify_timeout when its lease runs out first", async () => {
      const { runId } = await verify();
      await mutateHostDesiredStateV3(drizzle(env.DB), PLATFORM, Date.now(), (draft) => {
        for (const vm of draft.vms) vm.lease_expires_at_unix_ms = Date.now() - 1;
      });
      await expireOverdueRunLeases(PLATFORM, Date.now(), { wakeHostRuntime: false });
      expect(await runOf(runId)).toMatchObject({ end_reason: "verify_timeout", active_key: null, state: "failed" });
      const row = await revisionRow(PUBLIC_ID, rev("a"));
      expect(row).toMatchObject({ state: "ready", verify_run_id: runId });
      expect(JSON.parse(row!.verify_report_json!).outcome).toBe("verify_timeout");
      // The slot is free again.
      await expect(verify()).resolves.toMatchObject({ hostId: PLATFORM });
    });

    it("ignores a passing report from another host", async () => {
      const { runId } = await verify();
      await enrollHost(PLATFORM_2, ADMIN, "platform");
      const other = await connect(PLATFORM_2);
      sockets.push([other, PLATFORM_2]);
      sendVm(other, PLATFORM_2, verifyVm(runId, verifyLab({ steps: [], done: true, passed: true, pre_done: true })));
      // A report from the run's own host that changes nothing, as a barrier.
      sendVm(ws, PLATFORM, verifyVm(runId, verifyLab({ steps: [], done: false, passed: false, pre_done: true })));
      await until(() => env.DB.prepare("SELECT state_json FROM scenario_runs WHERE run_id = ?1").bind(runId).first<string>("state_json"),
        (json) => json?.includes("pre_done") === true);
      expect(await revisionRow(PUBLIC_ID, rev("a"))).toMatchObject({ state: "ready", verify_run_id: null });
    });

    it("is not a learner's to start or see", async () => {
      // Ready but never live: learners find nothing.
      await expect(learnerStart(LEARNER)).rejects.toMatchObject({ status: 404 });
      const { runId } = await verify();
      await expect(getScenarioRunStatusForUser({ runId, userId: LEARNER })).rejects.toMatchObject({ status: 404 });
      await expect(getScenarioRunStatusForUser({ runId, userId: ADMIN })).rejects.toMatchObject({ status: 404 });
    });
  });
});
