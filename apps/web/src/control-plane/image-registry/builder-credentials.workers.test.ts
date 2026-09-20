/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { handleAgentBootstrap, sha256Hex } from "@/control-plane/auth";
import { handleImageRegistryRequest } from "@/control-plane/image-registry";
import {
  agentBootstrapTokens, agentHosts, hostDesiredState, imageBuildBundles, imageBuilds,
  organization, runtimeExecutions, runtimeVms, scenarioRuns,
  scenarioCatalogCandidates, scenarioCatalogSnapshots, user,
  vmScenarioProbes, vmScenarioVms, vmScenarios,
} from "@/db/schema";
import type { ScenarioManifestV5 } from "@/generated/catalog";
import { seedScenarioManifest } from "@/lib/catalog-manifest";
import { IMAGE_BUILD_FORMAT_VERSION } from "@/lib/image-build-format";
import { createEmptyHostDesiredState } from "@/lib/desired-state";
import { projectRegistryRetention } from "@/lib/image-artifact-retention";
import { candidateScenarioId } from "@/lib/scenario-catalog-candidates";
import { resetD1Database } from "@/test/d1-migrations";
import { seedChunkedImage, type SeededChunkedImage } from "./registry-artifact-fixtures";

const HOST = "credential-builder";
const BUILD = "credential-build";
const REV = "credential-revision";
const SCENARIO = "broken-nginx";
const HASH = "a".repeat(64);
const BUNDLE_KEY = `builds/bundles/${REV}.tar.gz`;
const SOURCE = "private source code";
type Channel = "candidate" | "live";
let token: string;
let manifest: ScenarioManifestV5;
let previous: ScenarioManifestV5;

const revocations = [
  ["credential rotation", "UPDATE agent_hosts SET credential_generation = 2 WHERE id = ?"],
  ["disabled host", "UPDATE agent_hosts SET disabled = 1 WHERE id = ?"],
  ["owner change", "UPDATE agent_hosts SET user_id = 'other-owner' WHERE id = ?"],
  ["role change", "UPDATE agent_hosts SET role = 'agent' WHERE id = ?"],
  ["scope change", "UPDATE agent_hosts SET scope = 'personal', role = 'agent' WHERE id = ?"],
] as const;

describe("builder credentials at registry reads and commits", () => {
  beforeEach(async () => {
    await resetD1Database();
    const db = drizzle(env.DB);
    await db.insert(user).values(["builder-owner", "other-owner"].map((id) => ({
      id, name: id, email: `${id}@example.test`, emailVerified: true,
      createdAt: new Date(), updatedAt: new Date(),
    })));
    await db.insert(agentHosts).values({
      id: HOST, userId: "builder-owner", name: HOST, role: "builder",
      scope: "platform", credentialGeneration: 1, disabled: false,
    });
    await db.insert(agentBootstrapTokens).values({
      id: "builder-bootstrap", hostId: HOST, tokenHash: await sha256Hex("bootstrap-token"),
      credentialGeneration: 1, expiresAt: Date.now() + 60_000,
    });
    const bootstrap = await handleAgentBootstrap(new Request("https://intar.test/agent/bootstrap", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: HOST, bootstrapToken: "bootstrap-token" }),
    }), env);
    expect(bootstrap.status).toBe(200);
    token = (await bootstrap.json() as { accessToken: string }).accessToken;
    await db.insert(imageBuildBundles).values({
      rev: REV, r2Key: BUNDLE_KEY, metaJson: {
        buildFormatVersion: IMAGE_BUILD_FORMAT_VERSION,
        scenarios: [{ scenarioId: SCENARIO, arch: "x86_64", contentHash: HASH }],
      },
    });
    await db.insert(imageBuilds).values({
      id: BUILD, scenarioId: SCENARIO, arch: "x86_64", rev: REV,
      contentHash: HASH, hostId: HOST, status: "assigned", phase: "building",
      artifactsRetiredAt: 1_000,
    });
    await env.VM_IMAGE_REGISTRY_BUCKET.put(BUNDLE_KEY, SOURCE);
    manifest = manifestFor(await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, { label: "new" }));
    previous = manifestFor(await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, { label: "old" }));
    previous.title = "Previous catalog";
    previous.vms[0]!.probes[0]!.display_name = "Previous probe";
  });

  describe.each<Channel>(["candidate", "live"])("%s publication", (channel) => {
    it.each([false, true])("accepts a current builder (existing catalog: %s)", async (existing) => {
      await seedCatalog(channel, existing);
      const response = await publish();
      expect(response.status, await response.clone().text()).toBe(201);
      const db = drizzle(env.DB);
      const [build] = await db.select().from(imageBuilds);
      expect(build?.publishedManifestJson).toEqual(manifest);
      expect(build?.artifactsRetiredAt).toBeNull();
      if (channel === "candidate") {
        expect((await db.select().from(scenarioCatalogCandidates))[0]?.manifestJson).toEqual(manifest);
        expect(await db.select().from(vmScenarios)).toEqual([]);
      } else {
        expect((await db.select().from(vmScenarios))[0]?.title).toBe(manifest.title);
        expect((await db.select().from(vmScenarioVms))[0]?.imageSha256).toBe(manifest.vms[0]!.image_id);
        expect((await db.select().from(vmScenarioProbes))[0]?.description).toBe("New probe");
      }
      const snapshots = await db.select().from(scenarioCatalogSnapshots);
      expect(snapshots).toHaveLength(channel === "live" && existing ? 1 : 0);
      if (snapshots.length) expect(JSON.stringify(snapshots)).toContain(previous.vms[0]!.image_id);
      // An identical candidate replay remains valid and does not move its stamp.
      const committed = await catalogState();
      expect((await publish()).status).toBe(201);
      if (channel === "candidate") expect(await catalogState()).toEqual(committed);
      expect(await blockedWriters()).toBe(0);
    });

    it.each(revocations)("refuses %s during R2 validation", async (_name, statement) => {
      await seedCatalog(channel, true);
      const before = await catalogState();
      const race = beforeR2Returns("head", () => revoke(statement));
      expect((await publish(race.bindings)).status).toBe(409);
      expect(race.reached()).toBe(true);
      expect(await catalogState()).toEqual(before);
      await expectUnpublished();
    });

    it("commits the receipt before a credential rotation after the catalog batch", async () => {
      await seedCatalog(channel, true);
      const race = atCatalogCommit(channel, async (database, statements) => {
        const result = await database.batch(statements);
        await revoke(revocations[0][1]);
        return result;
      });
      expect((await publish(race.bindings)).status).toBe(201);
      expect(race.reached()).toBe(true);
      const db = drizzle(env.DB);
      expect((await db.select().from(imageBuilds))[0]).toMatchObject({
        publishedManifestJson: manifest, artifactsRetiredAt: null,
      });
      if (channel === "candidate") {
        expect((await db.select().from(scenarioCatalogCandidates))[0]?.manifestJson).toEqual(manifest);
      } else {
        expect((await db.select().from(vmScenarioVms))[0]?.imageSha256).toBe(manifest.vms[0]!.image_id);
      }
      expect(await blockedWriters()).toBe(0);
    });

    it("rolls back catalog and receipt together on a late batch failure", async () => {
      await seedCatalog(channel, true);
      const before = await catalogState();
      const [buildBefore] = await drizzle(env.DB).select().from(imageBuilds);
      const race = atCatalogCommit(channel, (database, statements) => database.batch([
        ...statements, database.prepare("SELECT json('invalid-json')"),
      ]));
      await expect(publish(race.bindings)).rejects.toThrow();
      expect(race.reached()).toBe(true);
      expect(await catalogState()).toEqual(before);
      expect((await drizzle(env.DB).select().from(imageBuilds))[0]).toEqual(buildBefore);
      expect(await blockedWriters()).toBe(1);
    });

    it.each([false, true])("fences credential rotation at the D1 commit (existing catalog: %s)", async (existing) => {
      await seedCatalog(channel, existing);
      const before = await catalogState();
      const race = beforeCatalogCommit(channel, () => revoke(revocations[0][1]));
      const response = await publish(race.bindings);
      expect(race.reached()).toBe(true);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "catalog_publication_revoked" });
      expect(await catalogState()).toEqual(before);
      await expectUnpublished();
    });

    it.each([
      ["assignment removal", "UPDATE image_builds SET host_id = NULL WHERE id = ?"],
      ["terminal build", "UPDATE image_builds SET status = 'stale' WHERE id = ?"],
      ["channel change", "UPDATE image_builds SET catalog_channel = CASE catalog_channel WHEN 'live' THEN 'candidate' ELSE 'live' END WHERE id = ?"],
      ["source change", "UPDATE image_builds SET content_hash = 'changed' WHERE id = ?"],
    ])("fences %s at the D1 commit", async (_name, statement) => {
      await seedCatalog(channel, true);
      const before = await catalogState();
      const race = beforeCatalogCommit(channel, () => env.DB.prepare(statement!).bind(BUILD).run());
      expect((await publish(race.bindings)).status).toBe(409);
      expect(race.reached()).toBe(true);
      expect(await catalogState()).toEqual(before);
      await expectUnpublished();
    });
  });

  it.each(["assigned", "building"] as const)("streams bundles for a current %s assignment", async (status) => {
    await drizzle(env.DB).update(imageBuilds).set({ status }).where(eq(imageBuilds.id, BUILD));
    const response = await download();
    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(SOURCE);
  });

  it.each([null, "private-org"])("blocks catalog %s while a shared platform host downloads its outgoing image", async (organizationId) => {
    await seedTransfer("platform", organizationId);
    const before = await catalogState();
    const response = await publish();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ blocking_host_ids: ["transfer-host"] });
    expect(await catalogState()).toEqual(before);
    await expectUnpublished();
  });

  it.each([null, "private-org"])("ignores personal transfer reports for catalog %s but retains their artifacts", async (organizationId) => {
    await seedTransfer("personal", organizationId);
    const outgoingImageId = previous.vms[0]!.image_id;
    expect((await publish()).status).toBe(201);
    // Rotate again so the personal transfer outlives the latest rollback.
    manifest = manifestFor(await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, { label: "third" }));
    expect((await publish()).status).toBe(201);
    const retention = await projectRegistryRetention(env, { nowUnixMs: Date.now() });
    expect(retention.imageIds).toContain(outgoingImageId);
    expect((await drizzle(env.DB).select().from(imageBuilds))[0]?.publishedManifestJson).toEqual(manifest);
    expect(await blockedWriters()).toBe(0);
  });

  it("still blocks an active personal execution recorded by the server", async () => {
    await seedTransfer("personal", "private-org");
    const db = drizzle(env.DB);
    await db.insert(runtimeExecutions).values({
      id: "personal-execution", userId: "builder-owner", hostId: "transfer-host",
      organizationId: "private-org", domainKind: "scenario", domainId: "personal-run",
      generation: 1, state: "ready",
    });
    await db.insert(runtimeVms).values({
      id: "personal-vm", executionId: "personal-execution", vmId: "web", ordinal: 0,
      runtimeVmName: "personal-web", imageKeyJson: { ...previous.vms[0]!.image_key },
      imageSha256: previous.vms[0]!.image_id, cpuMillis: 1_000, memoryMib: 512, diskMib: 1_024,
    });
    await db.insert(scenarioRuns).values({
      runId: "personal-run", userId: "builder-owner", hostId: "transfer-host",
      organizationId: "private-org", runtimeExecutionId: "personal-execution",
      scenarioId: SCENARIO, scenarioName: SCENARIO, title: "Active run", tagline: "",
      briefingMarkdown: "", objectivesJson: "[]", difficulty: "easy", estimatedMinutes: 10,
      tagsJson: [], hintsJson: [], solutionMarkdown: "", vmCount: 1,
      state: "ready", stateRank: 2, stateJson: "{}",
    });
    const before = await catalogState();
    const response = await publish();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      blocking_execution_ids: ["personal-execution"], blocking_host_ids: [],
    });
    expect(await catalogState()).toEqual(before);
    await expectUnpublished();
  });

  it.each([null, "private-org"])("does not retain an unassigned personal transfer report for catalog %s", async (organizationId) => {
    await seedTransfer("personal", organizationId);
    await drizzle(env.DB).update(hostDesiredState).set({
      docJson: createEmptyHostDesiredState({ ownerUserId: "builder-owner", scope: "platform", hostId: "transfer-host", nowUnixMs: Date.now() }),
    }).where(eq(hostDesiredState.hostId, "transfer-host"));
    const outgoingImageId = previous.vms[0]!.image_id;
    expect((await publish()).status).toBe(201);
    manifest = manifestFor(await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, { label: "third" }));
    expect((await publish()).status).toBe(201);
    const retention = await projectRegistryRetention(env, { nowUnixMs: Date.now() });
    expect(retention.imageIds).not.toContain(outgoingImageId);
  });

  it("refuses an identical candidate replay after revocation at commit", async () => {
    await seedCatalog("candidate", false);
    expect((await publish()).status).toBe(201);
    const before = await catalogState();
    const [buildBefore] = await drizzle(env.DB).select().from(imageBuilds);
    const race = beforeCatalogCommit("candidate", () => revoke(revocations[0][1]));
    expect((await publish(race.bindings)).status).toBe(409);
    expect(race.reached()).toBe(true);
    expect(await catalogState()).toEqual(before);
    expect((await drizzle(env.DB).select().from(imageBuilds))[0]).toEqual(buildBefore);
    expect(await blockedWriters()).toBe(0);
  });

  it.each(revocations)("refuses bundle bytes after %s during R2 GET", async (_name, statement) => {
    const race = beforeR2Returns("get", () => revoke(statement));
    const response = await download(race.bindings);
    expect(race.reached()).toBe(true);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(SOURCE);
  });

  it.each([
    ["assignment removal", "UPDATE image_builds SET host_id = NULL WHERE id = ?", BUILD],
    ["terminal build", "UPDATE image_builds SET status = 'succeeded' WHERE id = ?", BUILD],
    ["bundle replacement", "UPDATE image_build_bundles SET r2_key = 'replacement' WHERE rev = ?", REV],
  ])("refuses bundle bytes after %s during R2 GET", async (_name, statement, id) => {
    const race = beforeR2Returns("get", () => env.DB.prepare(statement!).bind(id).run());
    const response = await download(race.bindings);
    expect(race.reached()).toBe(true);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(SOURCE);
  });
});

async function seedCatalog(channel: Channel, existing: boolean) {
  const db = drizzle(env.DB);
  await db.update(imageBuilds).set({ catalogChannel: channel }).where(eq(imageBuilds.id, BUILD));
  if (!existing) return;
  if (channel === "live") {
    await seedScenarioManifest(db, previous, { nowUnixMs: 1_000 });
  } else {
    await db.insert(scenarioCatalogCandidates).values({
      id: candidateScenarioId(null, REV, SCENARIO), revision: REV,
      scenarioId: SCENARIO, buildId: BUILD, manifestJson: previous,
      createdAt: 1_000, updatedAt: 1_000,
    });
  }
}

async function seedTransfer(scope: "platform" | "personal", organizationId: string | null) {
  const db = drizzle(env.DB);
  const now = Date.now();
  if (organizationId) await db.insert(organization).values({
    id: organizationId, name: organizationId, slug: organizationId, createdAt: new Date(now),
  });
  await seedCatalog("live", true);
  await db.update(imageBuilds).set({ organizationId }).where(eq(imageBuilds.id, BUILD));
  await db.update(vmScenarios).set({ organizationId }).where(eq(vmScenarios.scenarioId, SCENARIO));
  await db.insert(agentHosts).values({
    id: "transfer-host", userId: "builder-owner", name: "transfer", role: "agent", scope,
  });
  const desired = createEmptyHostDesiredState({ ownerUserId: "builder-owner", scope: "platform", hostId: "transfer-host", nowUnixMs: now });
  desired.cached_images = [{ image_key: previous.vms[0]!.image_key, image_id: previous.vms[0]!.image_id }];
  await db.insert(hostDesiredState).values({
    hostId: "transfer-host", version: 0,
    docJson: desired,
  });
  await env.DB.prepare("INSERT INTO host_actual_state (host_id, applied_desired_version, observed_at, report_json, created_at, updated_at) VALUES (?1, 0, ?2, ?3, ?2, ?2)")
    .bind("transfer-host", now, JSON.stringify({
      capabilities: { arch: "x86_64" }, vms: [],
      cached_images: [{ image_key: previous.vms[0]!.image_key, image_id: previous.vms[0]!.image_id, phase: "downloading", updated_at_unix_ms: now }],
    })).run();
}

async function catalogState() {
  const db = drizzle(env.DB);
  return Promise.all([
    db.select().from(scenarioCatalogCandidates), db.select().from(vmScenarios),
    db.select().from(vmScenarioVms), db.select().from(vmScenarioProbes),
    db.select().from(scenarioCatalogSnapshots),
  ]);
}

async function expectUnpublished() {
  const [build] = await drizzle(env.DB).select().from(imageBuilds);
  expect(build?.publishedManifestJson).toBeNull();
  expect(build?.artifactsRetiredAt).toBe(1_000);
  expect(await blockedWriters()).toBe(0);
}

async function blockedWriters() {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM image_registry_operation_writers WHERE released_at IS NULL OR outcome = 'unknown'")
    .first<{ n: number }>())?.n;
}

function revoke(statement: string) {
  return env.DB.prepare(statement).bind(HOST).run();
}

async function publish(bindings = env) {
  const form = new FormData();
  form.set("manifest", JSON.stringify(manifest));
  form.set("build_id", BUILD);
  form.set("rev", REV);
  form.set("content_hash", HASH);
  form.set("architecture", "x86_64");
  const response = await handleImageRegistryRequest(new Request("https://intar.test/registry/v1/publish", {
    method: "POST", headers: { authorization: `Bearer ${token}` }, body: form,
  }), bindings);
  if (!response) throw new Error("missing publish route");
  return response;
}

async function download(bindings = env) {
  const response = await handleImageRegistryRequest(new Request(`https://intar.test/agent/registry/bundles/${REV}`, {
    headers: { authorization: `Bearer ${token}` },
  }), bindings);
  if (!response) throw new Error("missing bundle route");
  return response;
}

function beforeR2Returns(method: "get" | "head", change: () => Promise<unknown>) {
  let reached = false;
  const bucket = new Proxy(env.VM_IMAGE_REGISTRY_BUCKET, {
    get(target, property) {
      if (property === method) return async (key: string) => {
        const object = await target[method](key);
        if (!reached) { reached = true; await change(); }
        return object;
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { bindings: { ...env, VM_IMAGE_REGISTRY_BUCKET: bucket }, reached: () => reached };
}

// Intercept execution, after all application reads and statement preparation.
// A separate SELECT immediately before the write cannot pass these tests.
function beforeCatalogCommit(channel: Channel, change: () => Promise<unknown>) {
  return atCatalogCommit(channel, async (database, statements) => {
    await change();
    return database.batch(statements);
  });
}

function atCatalogCommit(
  channel: Channel,
  execute: (database: D1Database, statements: D1PreparedStatement[]) => Promise<D1Result[]>,
) {
  let reached = false;
  let prepared = false;
  const database = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare") return (query: string) => {
        const statement = target.prepare(query);
        if ((channel === "candidate" ? /INSERT INTO scenario_catalog_candidates/i : /INSERT INTO vm_scenarios/i).test(query)) prepared = true;
        return statement;
      };
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        if (prepared && !reached) {
          reached = true;
          return execute(target, statements);
        }
        return target.batch(statements);
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { bindings: { ...env, DB: database }, reached: () => reached };
}

function manifestFor(image: SeededChunkedImage): ScenarioManifestV5 {
  return {
    schema_version: 5, scenario_id: SCENARIO, name: SCENARIO,
    title: "New catalog", category: "linux", description: "Repair nginx",
    difficulty: "easy", estimated_minutes: 10, tags: [],
    briefing_markdown: "briefing", solution_markdown: "solution", hints: [],
    vms: [{
      name: "web", image_key: { scenario: SCENARIO, vm: "web", arch: "x86_64" },
      image_id: image.imageId, image_format: "raw_chunks_v1",
      image_virtual_size_bytes: image.virtualSizeBytes,
      chunk_manifest_sha256: image.chunkManifestSha256, guest_bootstrap_abi: 2,
      boot: { kernel_sha256: image.kernelSha256, initrd_sha256: image.initrdSha256, cmdline: "root=/dev/vda rw console=ttyS0" },
      cpu_millis: 1_000, memory_mib: 512, disk_mib: 1_024,
      probes: [{ id: "http", display_name: "New probe", hints: [], phase: "scenario", kind: "http" }],
    }],
  };
}
