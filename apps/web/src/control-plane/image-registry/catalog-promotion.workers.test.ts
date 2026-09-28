/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { handleImageRegistryRequest } from "@/control-plane/image-registry";
import {
  type CandidatePromotionOutcome,
  promoteCandidateRevision,
} from "@/control-plane/image-registry/catalog-promotion";
import {
  agentHosts,
  hostDesiredState,
  imageBuildBundles,
  imageBuilds,
  organization,
  runtimeOperationGates,
  scenarioCatalogCandidates,
  scenarioCatalogSnapshots,
  user,
  vmScenarioVms,
  vmScenarios,
} from "@/db/schema";
import type { ScenarioManifestV5 } from "@/generated/catalog";
import { createEmptyHostDesiredState } from "@/lib/desired-state";
import { projectRegistryRetention } from "@/lib/image-artifact-retention";
import { IMAGE_BUILD_FORMAT_VERSION } from "@/lib/image-build-format";
import {
  admitInternalRegistryOperation,
  createRegistryWriterGuard,
} from "@/lib/image-registry-admission";
import { IMAGE_CUTOVER_GATE } from "@/lib/run-admission-gate";
import type { ScenarioCatalogRollbackV1 } from "@/lib/scenario-catalog-rollback";
import { resetD1Database } from "@/test/d1-migrations";
import { createCleanupServiceDouble } from "./cleanup-service-double";
import {
  enableRegistryDeletion,
  seedChunkedImage,
  seedLegacyImage,
  type SeededChunkedImage,
} from "./registry-artifact-fixtures";

const CONTENT_HASH = "a".repeat(64);
describe("candidate scenario catalog promotion", () => {
  let promoted: Awaited<ReturnType<typeof seedChunkedImage>>;

  beforeEach(async () => {
    await resetD1Database();
    await enableRegistryDeletion(env.DB);
    promoted = await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, {
      label: "promoted",
    });
    await seedLegacyImage(env.VM_IMAGE_REGISTRY_BUCKET, {
      scenario: "broken-nginx",
      vm: "web",
      arch: "x86_64",
      sha256: "c".repeat(64),
    });
    // The catalog row the promotion replaces names its own boot artifacts.
    for (const sha256 of ["d".repeat(64), "e".repeat(64)]) {
      await env.VM_IMAGE_REGISTRY_BUCKET.put(
        "artifacts/" + sha256,
        new Uint8Array([1]),
      );
    }
    const db = drizzle(env.DB);
    await db.insert(imageBuildBundles).values({
      rev: "revision-1",
      r2Key: "builds/bundles/revision-1.tar.gz",
      metaJson: {
        buildFormatVersion: IMAGE_BUILD_FORMAT_VERSION,
        catalogChannel: "candidate",
        scenarios: [
          {
            scenarioId: "broken-nginx",
            arch: "x86_64",
            contentHash: CONTENT_HASH,
          },
        ],
      },
    });
    await db.insert(runtimeOperationGates).values({
      key: IMAGE_CUTOVER_GATE,
      state: "drained",
    });
    await db.insert(imageBuilds).values({
      id: "build-1",
      scenarioId: "broken-nginx",
      arch: "x86_64",
      rev: "revision-1",
      contentHash: CONTENT_HASH,
      catalogChannel: "candidate",
      status: "succeeded",
      phase: "succeeded",
      publishedManifestJson: manifest(promoted),
    });
    await db.insert(scenarioCatalogCandidates).values({
      id: "public:revision-1:broken-nginx",
      revision: "revision-1",
      scenarioId: "broken-nginx",
      buildId: "build-1",
      manifestJson: manifest(promoted),
    });
    await db.insert(vmScenarios).values({
      scenarioId: "broken-nginx",
      title: "Old catalog",
      category: "legacy",
      description: "Old raw image",
      difficulty: "easy",
      estimatedMinutes: 10,
      tagsJson: [],
      briefingMarkdown: "old",
      solutionMarkdown: "old",
      hintsJson: [],
      enabled: true,
      enabledAt: Date.now(),
    });
    await db.insert(vmScenarioVms).values({
      id: "broken-nginx:web",
      scenarioId: "broken-nginx",
      ordinal: 0,
      vmName: "web",
      image: "legacy.raw.zst",
      imageKeyJson: {
        scenario: "broken-nginx",
        vm: "web",
        arch: "x86_64",
      },
      imageSha256: "c".repeat(64),
      imageFormat: "raw_zstd",
      imageVirtualSizeBytes: 1,
      kernelSha256: "d".repeat(64),
      initrdSha256: "e".repeat(64),
      bootCmdline: "root=/dev/vda rw console=ttyS0",
      memoryMib: 512,
      diskMib: 1_024,
    });
  });

  it("switches every catalog row in one D1 batch after the drain gate", async () => {
    // Promotion deletes retired artifacts through the collector, so the test
    // reaches the collector the same way production does: a bound service.
    const response = await handleImageRegistryRequest(
      new Request(
        "https://intar.test/registry/v1/catalog/promote/revision-1",
        {
          method: "POST",
          headers: {
            authorization: "Bearer test-publish-token",
            "x-intar-drained": "true",
          },
        },
      ),
      {
        ...env,
        REGISTRY_CLEANUP: createCleanupServiceDouble({
          DB: env.DB,
          VM_IMAGE_REGISTRY_BUCKET: env.VM_IMAGE_REGISTRY_BUCKET,
        }),
      } as unknown as Cloudflare.Env,
    );
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      ok: true,
      revision: "revision-1",
      scenario_ids: ["broken-nginx"],
      rollback_snapshot_retained: true,
    });

    const db = drizzle(env.DB);
    const scenario = await db
      .select()
      .from(vmScenarios)
      .where(eq(vmScenarios.scenarioId, "broken-nginx"))
      .limit(1);
    const vms = await db
      .select()
      .from(vmScenarioVms)
      .where(eq(vmScenarioVms.scenarioId, "broken-nginx"));
    expect(scenario[0]).toMatchObject({
      title: "Broken Nginx",
      sourceRevision: "revision-1",
    });
    // The promotion's sweep retires the fulfilled candidate: the rows it wrote
    // carry the candidate's exact image closure, so no intent lingers.
    expect(await db.select().from(scenarioCatalogCandidates)).toEqual([]);
    expect(vms).toHaveLength(1);
    expect(vms[0]).toMatchObject({
      // The promoted row carries the fixture's derived identity, the same one the
      // manifest names and the sweep verifies.
      imageSha256: promoted.imageId,
      imageFormat: "raw_chunks_v1",
      guestBootstrapAbi: 2,
    });

    const rollback = await handleImageRegistryRequest(
      new Request(
        "https://intar.test/registry/v1/catalog/rollback/revision-1",
        {
          method: "POST",
          headers: {
            authorization: "Bearer test-publish-token",
            "x-intar-drained": "true",
          },
        },
      ),
      env,
    );
    expect(rollback?.status).toBe(200);
    await expect(rollback?.json()).resolves.toMatchObject({
      ok: true,
      restored_scenario_ids: ["broken-nginx"],
    });
    const restoredScenario = await db
      .select()
      .from(vmScenarios)
      .where(eq(vmScenarios.scenarioId, "broken-nginx"))
      .limit(1);
    const restoredVms = await db
      .select()
      .from(vmScenarioVms)
      .where(eq(vmScenarioVms.scenarioId, "broken-nginx"));
    expect(restoredScenario[0]).toMatchObject({ title: "Old catalog" });
    expect(restoredVms[0]).toMatchObject({ imageFormat: "raw_zstd" });
  });

  it("answers a committed retry without a second rollback row", async () => {
    expect((await promoteDrained()).status).toBe(200);
    const retry = await promoteDrained();
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({
      retried: true,
      rollback_snapshot_retained: false,
    });
    expect(
      await drizzle(env.DB).select().from(scenarioCatalogSnapshots),
    ).toHaveLength(1);
  });

  // The refusals moved into the shared promotion core. The drained lane must
  // still answer each one byte for byte as before.
  it.each([
    {
      kind: "incomplete_builds",
      setup: () =>
        drizzle(env.DB)
          .update(imageBuilds)
          .set({ status: "failed" })
          .where(eq(imageBuilds.id, "build-1")),
      body: { error: "candidate builds are not complete" },
    },
    {
      kind: "incomplete_catalog",
      setup: () => drizzle(env.DB).delete(scenarioCatalogCandidates),
      body: { error: "candidate catalog is incomplete" },
    },
    {
      kind: "ownership_conflict",
      setup: async () => {
        const db = drizzle(env.DB);
        await db.insert(organization).values({
          id: "org-1",
          name: "Org",
          slug: "org",
          createdAt: new Date(),
        });
        await db
          .update(vmScenarios)
          .set({ organizationId: "org-1" })
          .where(eq(vmScenarios.scenarioId, "broken-nginx"));
      },
      body: { error: "candidate catalog ownership conflict" },
    },
    {
      kind: "image_in_use",
      setup: () => seedHostCachingImage("c".repeat(64)),
      body: {
        error: "catalog promotion is blocked by active image use",
        blocking_execution_ids: [],
        blocking_host_ids: ["host-1"],
        outgoing_image_ids: ["c".repeat(64)],
      },
    },
  ])("answers the $kind refusal as before", async ({ setup, body }) => {
    await setup();
    const response = await promoteDrained();
    expect(response.status).toBe(409);
    expect(await response.text()).toBe(JSON.stringify(body));
  });

  it("rejects a candidate from an earlier image build format", async () => {
    await drizzle(env.DB)
      .update(imageBuildBundles)
      .set({
        metaJson: {
          buildFormatVersion: "intar-image-build-v11",
          catalogChannel: "candidate",
          scenarios: [
            {
              scenarioId: "broken-nginx",
              arch: "x86_64",
              contentHash: CONTENT_HASH,
            },
          ],
        },
      })
      .where(eq(imageBuildBundles.rev, "revision-1"));

    const response = await handleImageRegistryRequest(
      new Request(
        "https://intar.test/registry/v1/catalog/promote/revision-1",
        {
          method: "POST",
          headers: {
            authorization: "Bearer test-publish-token",
            "x-intar-drained": "true",
          },
        },
      ),
      env,
    );

    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toEqual({
      error: "candidate bundle uses an unsupported image build format",
    });
  });
});

async function promoteDrained(): Promise<Response> {
  const response = await handleImageRegistryRequest(
    new Request("https://intar.test/registry/v1/catalog/promote/revision-1", {
      method: "POST",
      headers: {
        authorization: "Bearer test-publish-token",
        "x-intar-drained": "true",
      },
    }),
    {
      ...env,
      REGISTRY_CLEANUP: createCleanupServiceDouble({
        DB: env.DB,
        VM_IMAGE_REGISTRY_BUCKET: env.VM_IMAGE_REGISTRY_BUCKET,
      }),
    } as unknown as Cloudflare.Env,
  );
  if (!response) throw new Error("the promotion route did not answer");
  return response;
}

/** A platform host still fetching the image, which blocks its replacement. */
async function seedHostCachingImage(imageId: string): Promise<void> {
  const db = drizzle(env.DB);
  const now = Date.now();
  await db.insert(user).values({
    id: "host-owner",
    name: "Host Owner",
    email: "host-owner@example.test",
    emailVerified: true,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  });
  await db.insert(agentHosts).values({
    id: "host-1",
    scope: "platform",
    userId: "host-owner",
    name: "Host 1",
    role: "agent",
    scenarioEnabled: true,
    disabled: false,
  });
  const doc = createEmptyHostDesiredState({
    ownerUserId: "host-owner",
    scope: "platform",
    hostId: "host-1",
    nowUnixMs: now,
  });
  doc.cached_images = [
    {
      image_key: { scenario: "broken-nginx", vm: "web", arch: "x86_64" },
      image_id: imageId,
    },
  ];
  await db.insert(hostDesiredState).values({
    hostId: "host-1",
    version: doc.version,
    docJson: doc,
    createdAt: now,
    updatedAt: now,
  });
}

describe("promotion rollback snapshots", () => {
  beforeEach(async () => {
    await resetD1Database();
  });

  it("writes no row for a promotion with no scenarios", async () => {
    await stage("revision-keep", []);
    const outcome = await promote("revision-keep");
    expect(outcome.rollbackSnapshotRetained).toBe(false);
    expect(await snapshotRows()).toEqual([]);
    // An empty-target row would fault the collector's projection.
    await expect(
      projectRegistryRetention(env, { nowUnixMs: Date.now() }),
    ).resolves.toBeDefined();
  });

  it("keeps the pre-image rollback and its build through a text-only commit", async () => {
    const a = await image("a");
    const b = await image("b");
    await stageAndPromote("revision-1", [{ image: a }]);
    await stageAndPromote("revision-2", [{ image: b }]);
    const text = await stageAndPromote("revision-3", [
      { image: b, title: "Broken Nginx, reworded" },
    ]);

    expect(text.rollbackSnapshotRetained).toBe(false);
    const rows = await snapshotRows();
    expect(rows.map((row) => row.revision)).toEqual(["revision-2"]);
    expect(imageIdsOf(rows[0]!.snapshot)).toEqual([a.imageId]);
    const projection = await projectRegistryRetention(env, {
      nowUnixMs: Date.now(),
    });
    expect(projection.builds.keepBuildIds).toContain(buildId("revision-1"));
    expect(rolledBackImageIds(projection)).toEqual([a.imageId]);
  });

  it("records the state a re-promoted revision replaces in a new row", async () => {
    const d1 = await image("d1");
    const d2 = await image("d2");
    await stage("revision-1", [{ image: d1 }]);
    await stage("revision-2", [{ image: d2 }]);
    await promote("revision-1");
    await promote("revision-2");
    await promote("revision-1");

    const rows = await snapshotRows();
    expect(rows.map((row) => row.revision)).toEqual(["revision-2", "revision-1"]);
    expect(imageIdsOf(rows[1]!.snapshot)).toEqual([d2.imageId]);
    const projection = await projectRegistryRetention(env, {
      nowUnixMs: Date.now(),
    });
    expect(projection.snapshots.keepIds).toEqual([rows[1]!.id]);
    expect(rolledBackImageIds(projection)).toEqual([d2.imageId]);
  });

  it("writes no second row for a committed retry", async () => {
    await stageAndPromote("revision-1", [{ image: await image("a") }]);
    await stage("revision-2", [{ image: await image("b") }]);
    expect((await promote("revision-2")).rollbackSnapshotRetained).toBe(true);
    const retry = await promote("revision-2");
    expect(retry).toMatchObject({
      alreadyPromoted: true,
      rollbackSnapshotRetained: false,
    });
    expect(await snapshotRows()).toHaveLength(1);
  });

  it("records only the scenarios whose images change", async () => {
    const a1 = await image("a1");
    const a2 = await image("a2");
    const b1 = await image("b1");
    const b2 = await image("b2");
    await stageAndPromote("revision-1", [
      { image: a1 },
      { image: b1, scenarioId: "second" },
    ]);
    await stageAndPromote("revision-2", [{ image: b2, scenarioId: "second" }]);
    await stageAndPromote("revision-3", [
      { image: a2 },
      { image: b2, scenarioId: "second", title: "Second, reworded" },
    ]);

    const rows = await snapshotRows();
    expect(
      rows.map((row) => [row.revision, row.snapshot.targetScenarioIds]),
    ).toEqual([
      ["revision-2", ["second"]],
      ["revision-3", ["broken-nginx"]],
    ]);
    expect(imageIdsOf(rows[1]!.snapshot)).toEqual([a1.imageId]);
    const projection = await projectRegistryRetention(env, {
      nowUnixMs: Date.now(),
    });
    expect(projection.snapshots.keepIds).toEqual(
      rows.map((row) => row.id).sort(),
    );
    expect(rolledBackImageIds(projection)).toEqual(
      [a1.imageId, b1.imageId].sort(),
    );
  });
});

interface StagedScenario {
  image: SeededChunkedImage;
  scenarioId?: string;
  title?: string;
}

function image(label: string): Promise<SeededChunkedImage> {
  return seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, { label });
}

function buildId(revision: string, scenarioId = "broken-nginx"): string {
  return "build:" + revision + ":" + scenarioId;
}

/** A candidate revision with one succeeded build per scenario. */
async function stage(
  revision: string,
  scenarios: readonly StagedScenario[],
): Promise<void> {
  const db = drizzle(env.DB);
  const staged = scenarios.map((item) => {
    const scenarioId = item.scenarioId ?? "broken-nginx";
    return {
      scenarioId,
      contentHash: revision + ":" + scenarioId,
      manifest: manifest(item.image, { scenarioId, title: item.title }),
    };
  });
  await db.insert(imageBuildBundles).values({
    rev: revision,
    r2Key: "builds/bundles/" + revision + ".tar.gz",
    metaJson: {
      buildFormatVersion: IMAGE_BUILD_FORMAT_VERSION,
      catalogChannel: "candidate",
      scenarios: staged.map((item) => ({
        scenarioId: item.scenarioId,
        arch: "x86_64" as const,
        contentHash: item.contentHash,
      })),
    },
  });
  for (const item of staged) {
    await db.insert(imageBuilds).values({
      id: buildId(revision, item.scenarioId),
      scenarioId: item.scenarioId,
      arch: "x86_64",
      rev: revision,
      contentHash: item.contentHash,
      catalogChannel: "candidate",
      status: "succeeded",
      phase: "succeeded",
      publishedManifestJson: item.manifest,
    });
    await db.insert(scenarioCatalogCandidates).values({
      id: "public:" + revision + ":" + item.scenarioId,
      revision,
      scenarioId: item.scenarioId,
      buildId: buildId(revision, item.scenarioId),
      manifestJson: item.manifest,
    });
  }
}

/** Runs the shared promotion core the way a caller that owns a writer does. */
async function promote(revision: string): Promise<CandidatePromotionOutcome> {
  const db = drizzle(env.DB);
  const [bundle] = await db
    .select({
      organizationId: imageBuildBundles.organizationId,
      meta: imageBuildBundles.metaJson,
    })
    .from(imageBuildBundles)
    .where(eq(imageBuildBundles.rev, revision));
  if (!bundle) throw new Error("no bundle " + revision);
  const admitted = await admitInternalRegistryOperation(env, {
    operation: "pointer_mutation",
    owner: { kind: "system", id: "catalog-promotion-test" },
  });
  if (!admitted.ok) throw new Error(admitted.reason);
  const writer = createRegistryWriterGuard(admitted.lease);
  try {
    const result = await promoteCandidateRevision(env, db, writer, {
      revision,
      bundle,
      nowUnixMs: Date.now(),
    });
    if (!result.ok) throw new Error(result.error);
    await writer.release("ok");
    return result.outcome;
  } finally {
    await writer.finish();
  }
}

async function stageAndPromote(
  revision: string,
  scenarios: readonly StagedScenario[],
): Promise<CandidatePromotionOutcome> {
  await stage(revision, scenarios);
  return promote(revision);
}

/** The rollback rows, oldest first. */
async function snapshotRows() {
  const rows = await drizzle(env.DB)
    .select()
    .from(scenarioCatalogSnapshots)
    .orderBy(scenarioCatalogSnapshots.createdAt);
  return rows.map((row) => ({
    id: row.id,
    revision: row.revision,
    snapshot: row.snapshotJson as unknown as ScenarioCatalogRollbackV1,
  }));
}

function imageIdsOf(snapshot: ScenarioCatalogRollbackV1): string[] {
  return snapshot.vms.map((vm) => vm.imageSha256 ?? "").sort();
}

function rolledBackImageIds(
  projection: Awaited<ReturnType<typeof projectRegistryRetention>>,
): string[] {
  return projection.roots
    .filter((root) => root.source === "rollback_snapshot")
    .map((root) => root.imageId)
    .sort();
}

function manifest(
  image: Awaited<ReturnType<typeof seedChunkedImage>>,
  options: { scenarioId?: string; title?: string | undefined } = {},
): ScenarioManifestV5 {
  const scenarioId = options.scenarioId ?? "broken-nginx";
  return {
    schema_version: 5,
    scenario_id: scenarioId,
    name: scenarioId,
    title: options.title ?? "Broken Nginx",
    category: "linux",
    description: "Repair nginx",
    difficulty: "easy",
    estimated_minutes: 10,
    tags: [],
    briefing_markdown: "briefing",
    solution_markdown: "solution",
    hints: [],
    vms: [
      {
        name: "web",
        image_key: { scenario: scenarioId, vm: "web", arch: "x86_64" },
        image_id: image.imageId,
        image_format: "raw_chunks_v1",
        image_virtual_size_bytes: 4_096,
        chunk_manifest_sha256: image.chunkManifestSha256,
        guest_bootstrap_abi: 2,
        boot: {
          kernel_sha256: image.kernelSha256,
          initrd_sha256: image.initrdSha256,
          cmdline: "root=/dev/vda rw console=ttyS0",
        },
        cpu_millis: 1_000,
        memory_mib: 512,
        disk_mib: 1_024,
        probes: [],
      },
    ],
  };
}
