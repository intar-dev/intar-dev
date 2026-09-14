/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import {
  agentHosts,
  hostActualState,
  hostDesiredState,
  imageBuildBundles,
  imageBuilds,
  runtimeExecutions,
  runtimeVms,
  scenarioCatalogCandidates,
  scenarioCatalogSnapshots,
  scenarioRuns,
  user,
  vmScenarioVms,
  vmScenarios,
} from "@/db/schema";
import { HOST_DESIRED_STATE_SCHEMA_VERSION } from "@/generated/constants";
import type {
  ImageArchitecture,
  ImageKey,
  ScenarioManifestV4,
} from "@/generated/catalog";
import { IMAGE_BUILD_FORMAT_VERSION } from "@/lib/image-build-format";
import {
  RegistryRetentionFault,
  applyRegistryRetention,
  loadRetiredBuildIds,
  projectRegistryRetention,
} from "@/lib/image-artifact-retention";
import { createImageRegistryCleanupCore } from "@/lib/image-registry-cleanup";
import { resetD1Database } from "@/test/d1-migrations";
import {
  enableRegistryDeletion,
  seedBootArtifact,
  seedChunkedImage,
  seedLegacyImage,
  sha256OfLabel,
  type SeededChunkedImage,
} from "../control-plane/image-registry/registry-artifact-fixtures";

const SCENARIO_ID = "broken-nginx";

async function seedScenario(
  imageKeyJson: unknown,
  input: {
    chunkManifestSha256: string | null;
    imageId: string;
    kernel: string;
    initrd: string;
    sourceRevision?: string;
    /** The scenario the pointer belongs to. Defaults to the shared fixture. */
    scenarioId?: string;
    /** The VM name of the pointer row. Defaults to the shared fixture. */
    vmName?: string;
  },
): Promise<void> {
  const db = drizzle(env.DB);
  const scenarioId = input.scenarioId ?? SCENARIO_ID;
  const vmName = input.vmName ?? "web";
  await db.insert(vmScenarios).values({
    scenarioId,
    sourceRevision: input.sourceRevision ?? null,
    title: "Broken Nginx",
    category: "linux",
    description: "Repair nginx",
    difficulty: "easy",
    estimatedMinutes: 10,
    tagsJson: [],
    briefingMarkdown: "briefing",
    solutionMarkdown: "solution",
    hintsJson: [],
    enabled: true,
    enabledAt: Date.now(),
  });
  await db.insert(vmScenarioVms).values({
    id: scenarioId + ":" + vmName,
    scenarioId,
    ordinal: 0,
    vmName,
    image: "web.raw.zst",
    imageKeyJson: imageKeyJson as never,
    imageSha256: input.imageId,
    imageFormat: "raw_chunks_v1",
    imageVirtualSizeBytes: 4_096,
    chunkManifestSha256: input.chunkManifestSha256,
    guestBootstrapAbi: 2,
    kernelSha256: input.kernel,
    initrdSha256: input.initrd,
    bootCmdline: "root=/dev/vda rw console=ttyS0",
    memoryMib: 512,
    diskMib: 1_024,
  });
}

function manifestFor(image: {
  imageId: string;
  chunkManifestSha256: string;
  kernelSha256: string;
  initrdSha256: string;
}) {
  return {
    schema_version: 4,
    scenario_id: SCENARIO_ID,
    name: SCENARIO_ID,
    title: "Broken Nginx",
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
        image_key: { scenario: SCENARIO_ID, vm: "web", arch: "x86_64" },
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
        vcpu_count: 1,
        memory_mib: 512,
        disk_mib: 1_024,
        probes: [],
      },
    ],
  } as never;
}

describe("registry retention fail-closed rules", () => {
  beforeEach(async () => {
    await resetD1Database();
    await enableRegistryDeletion(env.DB);
  });

  it("faults the projection when a live pointer has no usable image key", async () => {
    const image = await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, {
      label: "live",
    });
    await seedScenario(
      {},
      {
        chunkManifestSha256: image.chunkManifestSha256,
        imageId: image.imageId,
        kernel: image.kernelSha256,
        initrd: image.initrdSha256,
      },
    );

    await expect(
      projectRegistryRetention(env, { nowUnixMs: Date.now() }),
    ).rejects.toThrow(RegistryRetentionFault);
  });

  it("deletes nothing when a live pointer is malformed", async () => {
    const image = await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, {
      label: "live",
    });
    const orphan = await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, {
      label: "orphan",
    });
    await seedBootArtifact(env.VM_IMAGE_REGISTRY_BUCKET, "orphan-loose-kernel");
    await seedScenario(
      {},
      {
        chunkManifestSha256: image.chunkManifestSha256,
        imageId: image.imageId,
        kernel: image.kernelSha256,
        initrd: image.initrdSha256,
      },
    );

    const core = createImageRegistryCleanupCore({});
    const cleanupEnv = {
      DB: env.DB,
      VM_IMAGE_REGISTRY_BUCKET: env.VM_IMAGE_REGISTRY_BUCKET,
    };
    const plan = await core.plan(cleanupEnv, { mode: "delete", nowMs: Date.now() });

    // The unreadable pointer stops reference verification, so the sweep refuses.
    expect(plan.details.deleteAllowedByReferences).toBe(false);
    expect(plan.details.faults.map((fault) => fault.code)).toContain(
      "retention_projection_unavailable",
    );

    const result = await core.run(cleanupEnv, {
      mode: "delete",
      nowMs: Date.now(),
    });
    expect(result.deletedObjects).toBe(0);
    // The orphaned chunk and boot artifact survive: an unreadable pointer may
    // have been the only reference to them.
    expect(await env.VM_IMAGE_REGISTRY_BUCKET.head(orphan.objectKey)).not.toBeNull();
    expect(
      await env.VM_IMAGE_REGISTRY_BUCKET.head(
        "image-chunks/v1/zstd6/" + orphan.chunkRawSha256,
      ),
    ).not.toBeNull();
  });

  it("keeps a candidate whose revision is not the live one, even with the same image", async () => {
    const image = await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, {
      label: "live",
    });
    await seedScenario(
      { scenario: SCENARIO_ID, vm: "web", arch: "x86_64" },
      {
        chunkManifestSha256: image.chunkManifestSha256,
        imageId: image.imageId,
        kernel: image.kernelSha256,
        initrd: image.initrdSha256,
        sourceRevision: "revision-1",
      },
    );
    const db = drizzle(env.DB);
    await db.insert(scenarioCatalogCandidates).values({
      id: "public:revision-2:" + SCENARIO_ID,
      revision: "revision-2",
      scenarioId: SCENARIO_ID,
      buildId: "build-2",
      // Same disk image, different revision: the candidate changes the boot or
      // the metadata, so it must stay promotable until it becomes the catalog.
      manifestJson: manifestFor(image),
    });

    const projection = await projectRegistryRetention(env, {
      nowUnixMs: Date.now(),
    });

    expect(projection.candidates.keepIds).toEqual([
      "public:revision-2:" + SCENARIO_ID,
    ]);
    expect(projection.candidates.retireIds).toEqual([]);
  });

  it("retires a candidate once the catalog carries its revision", async () => {
    const image = await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, {
      label: "live",
    });
    await seedScenario(
      { scenario: SCENARIO_ID, vm: "web", arch: "x86_64" },
      {
        chunkManifestSha256: image.chunkManifestSha256,
        imageId: image.imageId,
        kernel: image.kernelSha256,
        initrd: image.initrdSha256,
        sourceRevision: "revision-2",
      },
    );
    const db = drizzle(env.DB);
    await db.insert(scenarioCatalogCandidates).values({
      id: "public:revision-2:" + SCENARIO_ID,
      revision: "revision-2",
      scenarioId: SCENARIO_ID,
      buildId: "build-2",
      manifestJson: manifestFor(image),
    });

    const projection = await projectRegistryRetention(env, {
      nowUnixMs: Date.now(),
    });

    expect(projection.candidates.keepIds).toEqual([]);
    expect(projection.candidates.retireIds).toEqual([
      "public:revision-2:" + SCENARIO_ID,
    ]);
  });

  it("faults the projection when a chunked live pointer has no chunk manifest", async () => {
    const image = await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, {
      label: "live",
    });
    await seedScenario(
      { scenario: SCENARIO_ID, vm: "web", arch: "x86_64" },
      {
        chunkManifestSha256: null,
        imageId: image.imageId,
        kernel: image.kernelSha256,
        initrd: image.initrdSha256,
      },
    );

    await expect(
      projectRegistryRetention(env, { nowUnixMs: Date.now() }),
    ).rejects.toThrow(RegistryRetentionFault);
  });
});

/**
 * The policy commit at the production shape: 657 candidate rows and 515 build
 * rows. D1 allows 100 bound parameters per query, and the same limit applies
 * to each statement of a batch
 * (https://developers.cloudflare.com/d1/platform/limits/), so no statement may
 * carry one placeholder per id.
 */
const SCALE_CANDIDATES = 657;
const SCALE_BUILDS = 515;
/** Builds a past sweep retired and the live catalog still justifies. */
const SCALE_REUSED_BUILDS = 120;
const SCALE_REVISION = "revision-scale";
const SCALE_CHUNK_MANIFEST_SHA256 = "7".repeat(64);
const SCALE_LIVE_IMAGE_ID = "8".repeat(64);
const SCALE_KERNEL_SHA256 = "9".repeat(64);
const SCALE_INITRD_SHA256 = "0".repeat(64);
const SCALE_BUNDLE_REV = "scale-bundle";
const D1_MAX_BOUND_PARAMETERS = 100;

function scaleCandidateId(index: number): string {
  return "public:revision-" + String(index).padStart(4, "0") + ":" + SCENARIO_ID;
}

function scaleRetireBuildId(index: number): string {
  return "scale-retire-" + String(index).padStart(4, "0");
}

function scaleReuseBuildId(index: number): string {
  return "scale-reuse-" + String(index).padStart(4, "0");
}

interface BindAudit {
  /** Statements that asked for more parameters than the platform allows. */
  overdrawn: string[];
  maxParameters: number;
  /** Statement count of each D1 batch call, in call order. */
  batches: number[];
}

/**
 * Wraps the D1 binding and records the bound parameters of every statement.
 * The local SQLite accepts more parameters than the platform does, so this
 * wrapper is what proves that the limit holds in this runtime.
 */
function auditBinding(db: D1Database, audit: BindAudit): D1Database {
  const auditStatement = (
    query: string,
    statement: D1PreparedStatement,
  ): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...parameters: unknown[]): D1PreparedStatement => {
            audit.maxParameters = Math.max(
              audit.maxParameters,
              parameters.length,
            );
            if (parameters.length > D1_MAX_BOUND_PARAMETERS) {
              audit.overdrawn.push(
                query.replaceAll(/\s+/g, " ").trim().slice(0, 120) +
                  " ... " +
                  String(parameters.length) +
                  " bound parameters",
              );
            }
            return target.bind(...parameters);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => auditStatement(query, target.prepare(query));
      }
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) => {
          audit.batches.push(statements.length);
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}

/**
 * Seeds rows in several statements: D1 allows 100 bound parameters per query,
 * so one insert cannot carry hundreds of rows.
 */
async function insertInChunks<Row>(
  rows: readonly Row[],
  chunkSize: number,
  insert: (chunk: Row[]) => Promise<void>,
): Promise<void> {
  for (let start = 0; start < rows.length; start += chunkSize) {
    await insert(rows.slice(start, start + chunkSize));
  }
}

async function seedScalePolicyRows(now: number): Promise<{
  buildIds: string[];
  retireBuildIds: string[];
  reusedBuildIds: string[];
}> {
  const db = drizzle(env.DB);
  await seedScenario(
    { scenario: SCENARIO_ID, vm: "web", arch: "x86_64" },
    {
      chunkManifestSha256: SCALE_CHUNK_MANIFEST_SHA256,
      imageId: SCALE_LIVE_IMAGE_ID,
      kernel: SCALE_KERNEL_SHA256,
      initrd: SCALE_INITRD_SHA256,
      sourceRevision: SCALE_REVISION,
    },
  );

  const candidates = Array.from({ length: SCALE_CANDIDATES }, (_, index) => ({
    id: scaleCandidateId(index),
    // The newest row carries the live revision, so its intent is fulfilled.
    // Every other row is history for the same scenario.
    revision:
      index === SCALE_CANDIDATES - 1 ? SCALE_REVISION : "revision-" + index,
    scenarioId: SCENARIO_ID,
    buildId: "candidate-build-" + index,
    manifestJson: { scenario_id: SCENARIO_ID, vms: [] } as never,
    updatedAt: now + index,
  }));
  // Eight columns per candidate row, so 12 rows stay inside the limit.
  await insertInChunks(candidates, 12, async (chunk) => {
    await db.insert(scenarioCatalogCandidates).values(chunk);
  });

  await db.insert(imageBuildBundles).values({
    rev: SCALE_BUNDLE_REV,
    r2Key: "builds/bundles/" + SCALE_BUNDLE_REV + ".tar.gz",
    metaJson: {
      buildFormatVersion: IMAGE_BUILD_FORMAT_VERSION,
      catalogChannel: "live",
      scenarios: [],
    },
  });

  const retiring = Array.from({ length: SCALE_BUILDS }, (_, index) => {
    const scenarioId = "scale-scenario-" + index;
    return {
      id: scaleRetireBuildId(index),
      scenarioId,
      arch: "x86_64" as const,
      rev: SCALE_BUNDLE_REV,
      contentHash: "scale-content-" + index,
      status: "succeeded" as const,
      phase: "succeeded" as const,
      // No catalog slot names this member, so the build is not reusable.
      publishedManifestJson: {
        scenario_id: scenarioId,
        vms: [
          {
            name: "web",
            image_key: { scenario: scenarioId, vm: "web", arch: "x86_64" },
            image_id: "1".repeat(64),
          },
        ],
      } as never,
      artifactsRetiredAt: null,
      updatedAt: now,
    };
  });
  // Thirteen bound parameters per build row, so 7 rows stay inside the limit.
  await insertInChunks(retiring, 7, async (chunk) => {
    await db.insert(imageBuilds).values(chunk);
  });

  const reused = Array.from({ length: SCALE_REUSED_BUILDS }, (_, index) => ({
    id: scaleReuseBuildId(index),
    scenarioId: "scale-reused-" + index,
    arch: "x86_64" as const,
    rev: SCALE_BUNDLE_REV,
    contentHash: "scale-reused-content-" + index,
    status: "succeeded" as const,
    phase: "succeeded" as const,
    // The member is the live image of the live slot, so the build stays
    // available and the sweep clears the marker a past run set on it.
    publishedManifestJson: {
      scenario_id: SCENARIO_ID,
      vms: [
        {
          name: "web",
          image_key: { scenario: SCENARIO_ID, vm: "web", arch: "x86_64" },
          image_id: SCALE_LIVE_IMAGE_ID,
        },
      ],
    } as never,
    artifactsRetiredAt: now,
    updatedAt: now,
  }));
  await insertInChunks(reused, 7, async (chunk) => {
    await db.insert(imageBuilds).values(chunk);
  });

  const retireBuildIds = retiring.map((row) => row.id);
  const reusedBuildIds = reused.map((row) => row.id);
  return {
    buildIds: [...retireBuildIds, ...reusedBuildIds],
    retireBuildIds,
    reusedBuildIds,
  };
}

describe("registry retention at the production row count", () => {
  beforeEach(async () => {
    await resetD1Database();
  });

  it("retires 515 builds and deletes 657 candidates with no statement over the D1 limit", async () => {
    const now = Date.now();
    const fixture = await seedScalePolicyRows(now);
    const audit: BindAudit = { overdrawn: [], maxParameters: 0, batches: [] };
    const audited = auditBinding(env.DB, audit);

    const projection = await projectRegistryRetention(
      { DB: audited },
      { nowUnixMs: now },
    );
    expect(projection.candidates.retireIds).toHaveLength(SCALE_CANDIDATES);
    expect(projection.candidates.keepIds).toEqual([]);
    expect(projection.builds.retireBuildIds).toEqual(fixture.retireBuildIds);
    expect(projection.builds.keepBuildIds).toEqual(fixture.reusedBuildIds);
    expect(projection.builds.retiredBuildIds).toEqual(fixture.reusedBuildIds);

    // The control-plane read path asks about every build row at once.
    expect(
      [
        ...(await loadRetiredBuildIds(drizzle(audited), fixture.buildIds)),
      ].sort(),
    ).toEqual(fixture.reusedBuildIds);

    const applied = await applyRegistryRetention({ DB: audited }, projection);
    expect(applied.retiredBuildIds).toEqual(fixture.retireBuildIds);
    expect(applied.activatedBuildIds).toEqual(fixture.reusedBuildIds);
    expect(applied.deletedCandidateIds).toHaveLength(SCALE_CANDIDATES);

    const retired = await env.DB
      .prepare(
        "SELECT id FROM image_builds WHERE artifacts_retired_at IS NOT NULL ORDER BY id",
      )
      .all<{ id: string }>();
    expect(retired.results.map((row) => row.id)).toEqual(
      fixture.retireBuildIds,
    );
    const buildCount = await env.DB
      .prepare("SELECT COUNT(*) AS count FROM image_builds")
      .first<{ count: number }>();
    expect(buildCount?.count).toBe(SCALE_BUILDS + SCALE_REUSED_BUILDS);
    const candidateCount = await env.DB
      .prepare("SELECT COUNT(*) AS count FROM scenario_catalog_candidates")
      .first<{ count: number }>();
    expect(candidateCount?.count).toBe(0);

    // One batch commits the retirement, the reactivation, and the deletes,
    // and no statement asked for more parameters than the platform allows.
    expect(audit.overdrawn).toEqual([]);
    expect(audit.maxParameters).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
    expect(audit.batches).toHaveLength(1);
  });
});

/**
 * The warm-cache gap at the shape production shows: one host whose desired
 * state names 425 image versions that no live reference roots any more.
 */
const WARM_SCENARIO = "warm-cache-fixture";
const WARM_VM = "web";
const WARM_ARCH: ImageArchitecture = "x86_64";
const REMOVED_SCENARIO = "scenario-removed-from-catalog";
/** 425 versions, the production reading of pinned_images. */
const OBSOLETE_INTENTS = 425;
const OPERATOR_IMAGE_ID = "d".repeat(64);
const TENANT_IMAGE_ID = "e".repeat(64);

function warmImageKey(
  scenario: string,
  vm: string,
  arch: ImageArchitecture,
): ImageKey {
  return { scenario, vm, arch };
}

function committedImageId(index: number): string {
  return "a" + index.toString(16).padStart(63, "0");
}

interface WarmCacheFixture {
  hostId: string;
  obsoleteImageIds: string[];
  /** One obsolete version an actual VM still runs: never trimmed. */
  runningImageId: string;
  /** One obsolete version a transfer is already fetching: never trimmed. */
  downloadingImageId: string;
}

/**
 * One live scenario, one build that published the removed scenario's family,
 * and one host holding 425 old versions of that family next to the intents
 * that must survive.
 */
async function seedWarmCacheHost(now: number): Promise<WarmCacheFixture> {
  const db = drizzle(env.DB);
  const image = await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, {
    label: "warm-live",
  });
  await seedScenario(
    { scenario: WARM_SCENARIO, vm: WARM_VM, arch: WARM_ARCH },
    {
      chunkManifestSha256: image.chunkManifestSha256,
      imageId: image.imageId,
      kernel: image.kernelSha256,
      initrd: image.initrdSha256,
    },
  );

  const obsoleteImageIds = Array.from({ length: OBSOLETE_INTENTS }, (_, index) =>
    committedImageId(index),
  );
  const runningImageId = obsoleteImageIds[0]!;
  const downloadingImageId = obsoleteImageIds[1]!;

  // A build manifest is a managed record: it is what tells the sweep that the
  // removed scenario's family belongs to this platform and not to a tenant.
  await db.insert(imageBuildBundles).values({
    rev: "warm-cache-bundle",
    r2Key: "builds/bundles/warm-cache-bundle.tar.gz",
    metaJson: {
      buildFormatVersion: IMAGE_BUILD_FORMAT_VERSION,
      catalogChannel: "live",
      scenarios: [],
    },
  });
  await db.insert(imageBuilds).values({
    id: "warm-cache-build",
    scenarioId: REMOVED_SCENARIO,
    arch: WARM_ARCH,
    rev: "warm-cache-bundle",
    contentHash: "b".repeat(64),
    status: "succeeded",
    phase: "succeeded",
    publishedManifestJson: {
      scenario_id: REMOVED_SCENARIO,
      vms: [
        {
          name: WARM_VM,
          image_key: warmImageKey(REMOVED_SCENARIO, WARM_VM, WARM_ARCH),
          image_id: "c".repeat(64),
        },
      ],
    } as never,
    updatedAt: now,
  });

  const hostId = "host-warm-cache";
  await db.insert(user).values({
    id: "warm-cache-owner",
    name: "Warm Cache Owner",
    email: "warm-cache@example.com",
    createdAt: new Date(now),
    updatedAt: new Date(now),
  });
  await db.insert(agentHosts).values({
    id: hostId,
    userId: "warm-cache-owner",
    name: hostId,
    role: "agent",
    disabled: false,
    connected: true,
    createdAt: now,
    updatedAt: now,
  });

  const cachedImages = [
    ...obsoleteImageIds.map((imageId) => ({
      image_key: warmImageKey(REMOVED_SCENARIO, WARM_VM, WARM_ARCH),
      image_id: imageId,
    })),
    // The live image, plus two families that are nobody's obsolete version.
    {
      image_key: warmImageKey(WARM_SCENARIO, WARM_VM, WARM_ARCH),
      image_id: image.imageId,
    },
    { image_key: warmImageKey("operator-pick", "base", WARM_ARCH), image_id: OPERATOR_IMAGE_ID },
    { image_key: warmImageKey("other-tenant", "edge", "aarch64"), image_id: TENANT_IMAGE_ID },
  ];
  await db.insert(hostDesiredState).values({
    hostId,
    version: 7,
    docJson: {
      schema_version: HOST_DESIRED_STATE_SCHEMA_VERSION,
      host_id: hostId,
      version: 7,
      generated_at_unix_ms: now,
      cached_images: cachedImages,
      cached_guest_tools: [],
      vms: [],
      builds: [],
    },
    createdAt: now,
    updatedAt: now,
  });
  // The host is honest about what it holds: one obsolete version runs a VM and
  // another transfer is still in flight, so neither may be withdrawn.
  await db.insert(hostActualState).values({
    hostId,
    appliedDesiredVersion: 7,
    observedAt: now,
    reportJson: {
      schema_version: 5,
      host_id: hostId,
      observed_at_unix_ms: now,
      applied_desired_version: 7,
      cached_images: [
        {
          image_key: warmImageKey(REMOVED_SCENARIO, WARM_VM, WARM_ARCH),
          image_id: downloadingImageId,
          phase: "downloading",
          updated_at_unix_ms: now,
        },
      ],
      vms: [
        {
          run_id: "run-warm",
          vm_name: WARM_VM,
          phase: "running",
          // The agent reports the key it boots with, so the retention policy
          // resolves this VM to a registry family instead of guessing.
          image_key: warmImageKey(REMOVED_SCENARIO, WARM_VM, WARM_ARCH),
          image_id: runningImageId,
        },
      ],
      builds: [],
    } as never,
    createdAt: now,
    updatedAt: now,
  });

  return { hostId, obsoleteImageIds, runningImageId, downloadingImageId };
}

async function hostDesiredDoc(hostId: string): Promise<{
  version: number;
  imageIds: string[];
}> {
  const row = await env.DB.prepare(
    "SELECT version, doc_json FROM host_desired_state WHERE host_id = ?1",
  )
    .bind(hostId)
    .first<{ version: number; doc_json: string }>();
  if (!row) throw new Error("host desired state is missing for " + hostId);
  const doc = JSON.parse(row.doc_json) as {
    cached_images: Array<{ image_id: string }>;
  };
  return {
    version: row.version,
    imageIds: doc.cached_images.map((image) => image.image_id),
  };
}

describe("warm cache intent retention", () => {
  beforeEach(async () => {
    await resetD1Database();
  });

  it("withdraws 423 obsolete intents of a removed family and pins nothing on them", async () => {
    const now = Date.now();
    const fixture = await seedWarmCacheHost(now);

    const projection = await projectRegistryRetention(env, { nowUnixMs: now });

    // Three still have a reason: an actual VM runs one, a transfer fetches
    // one, and one is the image the live scenario publishes.
    const surviving = fixture.obsoleteImageIds.slice(0, 2);
    const trimmed = fixture.obsoleteImageIds.slice(2);
    expect(projection.hostCacheTrims).toEqual([
      { hostId: fixture.hostId, imageIds: trimmed },
    ]);
    // The withdrawn intents stop pinning their objects, which is the point:
    // an absent object can no longer fail the sweep.
    for (const imageId of trimmed) {
      expect(projection.imageIds).not.toContain(imageId);
      expect(projection.objectOnlyImageIds).not.toContain(imageId);
    }
    for (const imageId of surviving) {
      expect(projection.imageIds).toContain(imageId);
      expect(projection.objectOnlyImageIds).toContain(imageId);
    }
    // Another tenant's family and the operator's own request stay.
    expect(projection.imageIds).toContain(OPERATOR_IMAGE_ID);
    expect(projection.imageIds).toContain(TENANT_IMAGE_ID);
  });

  it("withdraws the intents through the version-guarded write, and a replay is a no-op", async () => {
    const now = Date.now();
    const fixture = await seedWarmCacheHost(now);
    const projection = await projectRegistryRetention(env, { nowUnixMs: now });
    const before = await hostDesiredDoc(fixture.hostId);
    const trimmed = projection.hostCacheTrims[0]!.imageIds;

    const applied = await applyRegistryRetention(env, projection);

    expect(applied.trimmedHostCacheImageIds).toEqual(trimmed);
    const after = await hostDesiredDoc(fixture.hostId);
    // The committed version moved: the dispatch outbox delivers it to the host.
    expect(after.version).toBe(before.version + 1);
    expect(after.imageIds.sort()).toEqual(
      [
        fixture.runningImageId,
        fixture.downloadingImageId,
        projection.roots[0]!.imageId,
        OPERATOR_IMAGE_ID,
        TENANT_IMAGE_ID,
      ].sort(),
    );

    // A replayed projection finds every intent already withdrawn, so the
    // version does not move a second time.
    await applyRegistryRetention(env, projection);
    expect((await hostDesiredDoc(fixture.hostId)).version).toBe(after.version);
  });
});

/** The scenario every active-run fixture publishes and boots. */
const RUN_SCENARIO = "run-reference-fixture";
const RUN_VM = "web";
const RUN_ARCH: ImageArchitecture = "x86_64";
const RUN_KEY: ImageKey = { scenario: RUN_SCENARIO, vm: RUN_VM, arch: RUN_ARCH };

let runFixtureSeq = 0;

/** A complete published manifest for one image of one VM. */
function runManifest(input: {
  scenarioId: string;
  vmName: string;
  image: SeededChunkedImage;
}): ScenarioManifestV4 {
  return {
    schema_version: 4,
    scenario_id: input.scenarioId,
    name: input.scenarioId,
    title: "Run reference",
    category: "linux",
    description: "Run reference fixture.",
    difficulty: "easy",
    estimated_minutes: 10,
    tags: [],
    briefing_markdown: "briefing",
    solution_markdown: "solution",
    hints: [],
    vms: [
      {
        name: input.vmName,
        image_key: {
          scenario: input.scenarioId,
          vm: input.vmName,
          arch: RUN_ARCH,
        },
        image_id: input.image.imageId,
        image_format: "raw_chunks_v1",
        image_virtual_size_bytes: input.image.virtualSizeBytes,
        chunk_manifest_sha256: input.image.chunkManifestSha256,
        guest_bootstrap_abi: 2,
        boot: {
          kernel_sha256: input.image.kernelSha256,
          initrd_sha256: input.image.initrdSha256,
          cmdline: "root=/dev/vda rw console=ttyS0",
        },
        cpu_millis: 1_000,
        vcpu_count: 1,
        memory_mib: 512,
        disk_mib: 1_024,
        probes: [],
      },
    ],
  };
}

/**
 * An admitted run whose VM is still live: the execution is in an active state,
 * the run carries its request scope, and the runtime VM names the image it
 * boots. This is the shape production has while a learner sits in a lab.
 */
async function seedActiveRun(input: {
  imageKey: ImageKey;
  imageId: string;
  candidateRevision?: string | null;
  candidateBuildId?: string | null;
  executionState?: "queued" | "provisioning" | "ready" | "archiving";
}): Promise<string> {
  const db = drizzle(env.DB);
  const now = Date.now();
  runFixtureSeq += 1;
  const suffix = String(runFixtureSeq);
  const runId = "run-active-" + suffix;
  const userId = "run-owner-" + suffix;
  const hostId = "run-host-" + suffix;
  const executionId = "exec-" + runId;
  await db.insert(user).values({
    id: userId,
    name: "Run Owner",
    email: userId + "@example.com",
    createdAt: new Date(now),
    updatedAt: new Date(now),
  });
  await db.insert(agentHosts).values({
    id: hostId,
    userId,
    name: hostId,
    role: "agent",
    disabled: false,
    connected: true,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(runtimeExecutions).values({
    id: executionId,
    userId,
    hostId,
    domainKind: "scenario",
    domainId: runId,
    generation: 1,
    state: input.executionState ?? "ready",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(scenarioRuns).values({
    runId,
    userId,
    hostId,
    runtimeExecutionId: executionId,
    scenarioId: input.imageKey.scenario,
    scenarioName: input.imageKey.scenario,
    title: "Active run",
    tagline: "",
    briefingMarkdown: "",
    objectivesJson: "[]",
    difficulty: "easy",
    estimatedMinutes: 1,
    tagsJson: [],
    hintsJson: [],
    solutionMarkdown: "",
    vmCount: 1,
    state: "active_full",
    stateRank: 3,
    activeKey: userId,
    requestScopeJson: {
      scenarioId: input.imageKey.scenario,
      organizationId: null,
      hostId,
      candidateRevision: input.candidateRevision ?? null,
      candidateBuildId: input.candidateBuildId ?? null,
      allowDrainedAdminProof: false,
      allowSequenceBypass: false,
    },
    stateJson: "{}",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(runtimeVms).values({
    id: "runtime-vm-" + suffix,
    executionId,
    vmId: input.imageKey.vm,
    ordinal: 0,
    runtimeVmName: input.imageKey.vm,
    // The column is an untyped JSON record; the run carries the same key the
    // launch spec used, which is what a registry reader resolves an image by.
    imageKeyJson: { ...input.imageKey } as Record<string, unknown>,
    imageSha256: input.imageId,
    cpuMillis: 125,
    memoryMib: 512,
    diskMib: 4_096,
    createdAt: now,
    updatedAt: now,
  });
  return runId;
}

/** One published build manifest, the audit record of an image. */
async function seedBuildManifest(input: {
  manifest: ScenarioManifestV4;
  id: string;
}): Promise<void> {
  const db = drizzle(env.DB);
  const now = Date.now();
  const rev = input.id + "-bundle";
  await db.insert(imageBuildBundles).values({
    rev,
    r2Key: "builds/bundles/" + rev + ".tar.gz",
    metaJson: {
      buildFormatVersion: IMAGE_BUILD_FORMAT_VERSION,
      catalogChannel: "live",
      scenarios: [],
    },
  });
  await db.insert(imageBuilds).values({
    id: input.id,
    scenarioId: input.manifest.scenario_id,
    arch: RUN_ARCH,
    rev,
    contentHash: input.id + "-content",
    status: "succeeded",
    phase: "succeeded",
    publishedManifestJson: input.manifest,
    updatedAt: now,
  });
}

function cleanupEnv(): { DB: D1Database; VM_IMAGE_REGISTRY_BUCKET: R2Bucket } {
  return {
    DB: env.DB,
    VM_IMAGE_REGISTRY_BUCKET: env.VM_IMAGE_REGISTRY_BUCKET,
  };
}

/** One staged candidate row, the record the agent index resolves a run from. */
async function seedCandidateRow(input: {
  id: string;
  revision: string;
  buildId: string;
  manifest: ScenarioManifestV4;
}): Promise<void> {
  const db = drizzle(env.DB);
  const now = Date.now();
  await db.insert(scenarioCatalogCandidates).values({
    id: input.id,
    revision: input.revision,
    organizationId: null,
    scenarioId: input.manifest.scenario_id,
    buildId: input.buildId,
    manifestJson: input.manifest,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * One rollback record, in the shape the publish path captures: the whole
 * vm_scenario_vms row of the replaced revision, serialized with its camelCase
 * field names.
 */
async function seedRollbackSnapshot(input: {
  id: string;
  revision: string;
  vm: Record<string, unknown>;
}): Promise<void> {
  const db = drizzle(env.DB);
  const now = Date.now();
  await db.insert(scenarioCatalogSnapshots).values({
    id: input.id,
    revision: input.revision,
    organizationId: null,
    snapshotJson: {
      schemaVersion: 1,
      targetScenarioIds: [String(input.vm.scenarioId)],
      scenarios: [],
      vms: [input.vm],
      probes: [],
    },
    createdAt: now,
  });
}

async function objectExists(key: string): Promise<boolean> {
  return (await env.VM_IMAGE_REGISTRY_BUCKET.head(key)) !== null;
}

describe("active run image references", () => {
  beforeEach(async () => {
    await resetD1Database();
    await enableRegistryDeletion(env.DB);
  });

  it("pins the full closure of a run image that no catalog pointer names", async () => {
    // The scenario publishes one image and a run boots another: the pointer
    // moved on, so only the run itself still needs the image it launched.
    const published = await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, {
      label: "run-published",
    });
    const booted = await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, {
      label: "run-booted",
    });
    await seedScenario(
      { scenario: RUN_SCENARIO, vm: RUN_VM, arch: RUN_ARCH },
      {
        chunkManifestSha256: published.chunkManifestSha256,
        imageId: published.imageId,
        kernel: published.kernelSha256,
        initrd: published.initrdSha256,
        scenarioId: RUN_SCENARIO,
      },
    );
    await seedBuildManifest({
      id: "run-booted-build",
      manifest: runManifest({
        scenarioId: RUN_SCENARIO,
        vmName: RUN_VM,
        image: booted,
      }),
    });
    await seedActiveRun({ imageKey: RUN_KEY, imageId: booted.imageId });

    const projection = await projectRegistryRetention(env, {
      nowUnixMs: Date.now(),
    });

    expect(projection.roots).toContainEqual({
      scenarioId: RUN_SCENARIO,
      vmName: RUN_VM,
      arch: RUN_ARCH,
      imageId: booted.imageId,
      source: "active_run",
    });
    expect(projection.chunkManifestSha256s).toContain(booted.chunkManifestSha256);
    expect(projection.bootArtifactSha256s).toContain(booted.kernelSha256);
    expect(projection.bootArtifactSha256s).toContain(booted.initrdSha256);

    const core = createImageRegistryCleanupCore({});
    const plan = await core.plan(cleanupEnv(), {
      mode: "report-only",
      nowMs: Date.now(),
    });
    expect(plan.details.faults).toEqual([]);
    const candidates = plan.candidateObjects.map((object) => String(object.key));
    // The run's manifest, chunk, kernel, and initrd are not delete candidates.
    expect(candidates).not.toContain(booted.objectKey);
    expect(candidates).not.toContain("image-chunks/v1/zstd6/" + booted.chunkRawSha256);
    expect(candidates).not.toContain("artifacts/" + booted.kernelSha256);
    expect(candidates).not.toContain("artifacts/" + booted.initrdSha256);

    const result = await core.run(cleanupEnv(), {
      mode: "delete",
      nowMs: Date.now(),
    });

    expect(result.error).toBeNull();
    // The run's own closure survives the sweep, and the run is not retired.
    expect(await objectExists(booted.objectKey)).toBe(true);
    expect(await objectExists("artifacts/" + booted.kernelSha256)).toBe(true);
    expect(await objectExists("artifacts/" + booted.initrdSha256)).toBe(true);
    const retired = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM image_builds WHERE artifacts_retired_at IS NOT NULL",
    ).first<{ count: number }>();
    expect(retired?.count).toBe(0);
  });

  it("faults the projection when an active run image resolves to no manifest", async () => {
    const published = await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, {
      label: "run-unresolved",
    });
    await seedScenario(
      { scenario: RUN_SCENARIO, vm: RUN_VM, arch: RUN_ARCH },
      {
        chunkManifestSha256: published.chunkManifestSha256,
        imageId: published.imageId,
        kernel: published.kernelSha256,
        initrd: published.initrdSha256,
        scenarioId: RUN_SCENARIO,
      },
    );
    // Nothing describes this image: no pointer, no candidate, no build record.
    await seedActiveRun({
      imageKey: RUN_KEY,
      imageId: "9".repeat(64),
    });

    await expect(
      projectRegistryRetention(env, { nowUnixMs: Date.now() }),
    ).rejects.toThrow(RegistryRetentionFault);

    // Fail closed: the sweep reports the unresolved run and deletes nothing.
    const core = createImageRegistryCleanupCore({});
    const plan = await core.plan(cleanupEnv(), {
      mode: "report-only",
      nowMs: Date.now(),
    });
    expect(plan.details.deleteAllowedByReferences).toBe(false);
    expect(plan.details.faults.map((fault) => fault.code)).toContain(
      "retention_projection_unavailable",
    );
    const result = await core.run(cleanupEnv(), {
      mode: "delete",
      nowMs: Date.now(),
    });
    expect(result.deletedObjects).toBe(0);
    expect(await objectExists(published.objectKey)).toBe(true);
  });

  it("keeps the candidate row an active run resolves its manifest through", async () => {
    const published = await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, {
      label: "run-candidate-published",
    });
    const staged = await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, {
      label: "run-candidate-staged",
    });
    // The catalog already carries the revision the run was admitted from, so
    // the ordinary rule would retire that candidate row as consumed.
    await seedScenario(
      { scenario: RUN_SCENARIO, vm: RUN_VM, arch: RUN_ARCH },
      {
        chunkManifestSha256: published.chunkManifestSha256,
        imageId: published.imageId,
        kernel: published.kernelSha256,
        initrd: published.initrdSha256,
        sourceRevision: "revision-admitted",
        scenarioId: RUN_SCENARIO,
      },
    );
    const candidateId = "public:revision-admitted:" + RUN_SCENARIO;
    await seedCandidateRow({
      id: candidateId,
      revision: "revision-admitted",
      buildId: "run-candidate-build",
      manifest: runManifest({
        scenarioId: RUN_SCENARIO,
        vmName: RUN_VM,
        image: staged,
      }),
    });
    await seedActiveRun({
      imageKey: RUN_KEY,
      imageId: staged.imageId,
      candidateRevision: "revision-admitted",
      candidateBuildId: "run-candidate-build",
    });

    const projection = await projectRegistryRetention(env, {
      nowUnixMs: Date.now(),
    });

    expect(projection.candidates.retireIds).toEqual([]);
    expect(projection.candidates.keepIds).toEqual([candidateId]);
    // The run resolves its manifest through that row, so its closure is pinned.
    expect(projection.chunkManifestSha256s).toContain(staged.chunkManifestSha256);
    expect(projection.bootArtifactSha256s).toContain(staged.kernelSha256);

    await applyRegistryRetention(env, projection);
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM scenario_catalog_candidates WHERE id = ?1",
    )
      .bind(candidateId)
      .first<{ count: number }>();
    // The agent index reads this row to resolve the run's VM manifest, so it
    // must outlive the retirement of its intent.
    expect(rows?.count).toBe(1);
  });

  it("resolves an active run from the retained rollback after a direct publish", async () => {
    // A direct token publish writes no build row, and it can leave no
    // candidate row. After the pointer moves from A to B, the rollback record
    // is the only place A's metadata survives, and a run in flight boots A.
    const live = await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, {
      label: "rollback-live",
    });
    const previous = await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, {
      label: "rollback-previous",
    });
    const orphan = await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, {
      label: "rollback-orphan",
    });
    await seedScenario(
      { scenario: RUN_SCENARIO, vm: RUN_VM, arch: RUN_ARCH },
      {
        chunkManifestSha256: live.chunkManifestSha256,
        imageId: live.imageId,
        kernel: live.kernelSha256,
        initrd: live.initrdSha256,
        scenarioId: RUN_SCENARIO,
      },
    );
    await seedRollbackSnapshot({
      id: "rollback-of-the-direct-publish",
      revision: "revision-previous",
      vm: {
        scenarioId: RUN_SCENARIO,
        vmName: RUN_VM,
        imageSha256: previous.imageId,
        imageKeyJson: { scenario: RUN_SCENARIO, vm: RUN_VM, arch: RUN_ARCH },
        imageFormat: "raw_chunks_v1",
        chunkManifestSha256: previous.chunkManifestSha256,
        kernelSha256: previous.kernelSha256,
        initrdSha256: previous.initrdSha256,
      },
    });
    await seedActiveRun({ imageKey: RUN_KEY, imageId: previous.imageId });

    const projection = await projectRegistryRetention(env, {
      nowUnixMs: Date.now(),
    });

    // The run resolves through the rollback record, so the projection does not
    // fault, and its whole closure is retained.
    expect(projection.roots).toContainEqual({
      scenarioId: RUN_SCENARIO,
      vmName: RUN_VM,
      arch: RUN_ARCH,
      imageId: previous.imageId,
      source: "active_run",
    });
    expect(projection.chunkManifestSha256s).toContain(
      previous.chunkManifestSha256,
    );
    expect(projection.bootArtifactSha256s).toContain(previous.kernelSha256);
    expect(projection.bootArtifactSha256s).toContain(previous.initrdSha256);

    const core = createImageRegistryCleanupCore({});
    const plan = await core.plan(cleanupEnv(), {
      mode: "report-only",
      nowMs: Date.now(),
    });
    expect(plan.details.faults).toEqual([]);
    const candidates = plan.candidateObjects.map((object) => String(object.key));
    expect(candidates).not.toContain(previous.objectKey);
    expect(candidates).not.toContain(
      "image-chunks/v1/zstd6/" + previous.chunkRawSha256,
    );
    expect(candidates).not.toContain("artifacts/" + previous.kernelSha256);
    expect(candidates).not.toContain("artifacts/" + previous.initrdSha256);
    // An object no record names is still a candidate.
    expect(candidates).toContain(orphan.objectKey);

    const result = await core.run(cleanupEnv(), {
      mode: "delete",
      nowMs: Date.now(),
    });

    expect(result.error).toBeNull();
    expect(await objectExists(previous.objectKey)).toBe(true);
    expect(
      await objectExists("image-chunks/v1/zstd6/" + previous.chunkRawSha256),
    ).toBe(true);
    expect(await objectExists("artifacts/" + previous.kernelSha256)).toBe(true);
    expect(await objectExists("artifacts/" + previous.initrdSha256)).toBe(true);
    expect(await objectExists(orphan.objectKey)).toBe(false);
    expect(
      await objectExists("image-chunks/v1/zstd6/" + orphan.chunkRawSha256),
    ).toBe(false);
  });
});

/**
 * The production shape: many hosts keep an `absent` tombstone for a scenario
 * whose artifacts are already deleted. That tombstone used to root the image,
 * prove the family managed, and raise `retained_image_missing` per host.
 */
describe("host phase policy against real D1", () => {
  beforeEach(async () => {
    await resetD1Database();
    await enableRegistryDeletion(env.DB);
  });

  it("does not fault on absent tombstones and still faults on a running VM", async () => {
    const missingImageId = await sha256OfLabel("deleted-release");
    await seedManyHostsWithTombstone({
      hostCount: 40,
      desiredPhase: "absent",
      imageId: missingImageId,
    });

    const projection = await projectRegistryRetention(env, {
      nowUnixMs: Date.now(),
    });
    expect(projection.roots).toEqual([]);

    const core = createImageRegistryCleanupCore({});
    const plan = await core.plan(cleanupEnvForSweep(), {
      mode: "delete",
      nowMs: Date.now(),
    });
    expect(plan.details.faults).toEqual([]);
    expect(plan.details.deleteAllowedByReferences).toBe(true);

    await resetD1Database();
    await enableRegistryDeletion(env.DB);
    await seedManyHostsWithTombstone({
      hostCount: 40,
      desiredPhase: "running",
      imageId: missingImageId,
    });
    const faulted = await core.plan(cleanupEnvForSweep(), {
      mode: "delete",
      nowMs: Date.now(),
    });
    expect(faulted.details.faults.map((fault) => fault.code)).toEqual(
      Array.from({ length: 40 }, () => "retained_image_missing"),
    );
    expect(faulted.details.deleteAllowedByReferences).toBe(false);
  });

  it("roots a running, stopping, and failed-delete VM but not an archived one", async () => {
    const running = await sha256OfLabel("vm-running");
    const stopping = await sha256OfLabel("vm-stopping");
    const deleteFailed = await sha256OfLabel("vm-delete-failed");
    const archived = await sha256OfLabel("vm-archived-complete");
    const now = Date.now();
    const db = drizzle(env.DB);
    await seedHostRow(db, { hostId: "host-phases", now });
    await seedHostDesiredRow(db, { hostId: "host-phases", now });
    await db.insert(hostActualState).values({
      hostId: "host-phases",
      appliedDesiredVersion: 1,
      observedAt: now,
      reportJson: {
        schema_version: 5,
        host_id: "host-phases",
        observed_at_unix_ms: now,
        applied_desired_version: 1,
        cached_images: [],
        builds: [],
        vms: [
          phaseVm("run-live", "running", running, null),
          // DeletingVm: present on disk, teardown can still fail.
          phaseVm("run-stopping", "stopping", stopping, { phase: "pending", artifact_count: 0 }),
          // DeleteFailed: still present, so its image stays required.
          phaseVm("run-delete-failed", "failed", deleteFailed, { phase: "failed", artifact_count: 0 }),
          // The agent removes the VM once its artifacts are archived.
          phaseVm("run-archived", "stopping", archived, { phase: "complete", artifact_count: 9 }),
        ],
      } as never,
      createdAt: now,
      updatedAt: now,
    });

    const projection = await projectRegistryRetention(env, {
      nowUnixMs: Date.now(),
    });
    const rooted = new Set(projection.roots.map((root) => root.imageId));
    expect(rooted.has(running)).toBe(true);
    expect(rooted.has(stopping)).toBe(true);
    expect(rooted.has(deleteFailed)).toBe(true);
    expect(rooted.has(archived)).toBe(false);
  });

  it("pins the whole closure of a non-live image a running VM still uses", async () => {
    // The image is not live, not a rollback, and not a candidate: only the
    // build audit knows its manifest and boot artifacts. A running VM that
    // names it must keep the chunks, the manifest, and both boot artifacts,
    // and the audit must not fault on an image that is available.
    const image = await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, {
      label: "non-live-running",
    });
    const orphan = await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, {
      label: "truly-orphan",
    });
    const now = Date.now();
    const db = drizzle(env.DB);
    await db.insert(imageBuildBundles).values({
      rev: "audit-bundle",
      r2Key: "builds/bundles/audit-bundle.tar.gz",
      metaJson: {
        buildFormatVersion: IMAGE_BUILD_FORMAT_VERSION,
        catalogChannel: "live",
        scenarios: [],
      },
    });
    await db.insert(imageBuilds).values({
      id: "audit-build",
      scenarioId: "nonlive-scenario",
      arch: "x86_64",
      rev: "audit-bundle",
      contentHash: "9".repeat(64),
      status: "succeeded",
      phase: "succeeded",
      publishedManifestJson: {
        scenario_id: "nonlive-scenario",
        vms: [
          {
            name: "web",
            image_key: { scenario: "nonlive-scenario", vm: "web", arch: "x86_64" },
            image_id: image.imageId,
            image_format: "raw_chunks_v1",
            chunk_manifest_sha256: image.chunkManifestSha256,
            boot: {
              kernel_sha256: image.kernelSha256,
              initrd_sha256: image.initrdSha256,
            },
          },
        ],
      } as never,
      updatedAt: now,
    });
    await seedHostRow(db, { hostId: "host-non-live", now });
    await seedHostDesiredRow(db, { hostId: "host-non-live", now });
    await db.insert(hostActualState).values({
      hostId: "host-non-live",
      appliedDesiredVersion: 1,
      observedAt: now,
      reportJson: {
        schema_version: 5,
        host_id: "host-non-live",
        observed_at_unix_ms: now,
        applied_desired_version: 1,
        cached_images: [],
        builds: [],
        // No image key: the report carries only the id, so the closure has
        // to come from the index.
        vms: [
          phaseVm("run-non-live", "running", image.imageId, null, null),
        ],
      } as never,
      createdAt: now,
      updatedAt: now,
    });

    const projection = await projectRegistryRetention(env, {
      nowUnixMs: Date.now(),
    });
    expect(projection.chunkManifestSha256s).toContain(image.chunkManifestSha256);
    expect(projection.bootArtifactSha256s).toContain(image.kernelSha256);
    expect(projection.bootArtifactSha256s).toContain(image.initrdSha256);

    const core = createImageRegistryCleanupCore({});
    const plan = await core.plan(cleanupEnvForSweep(), {
      mode: "delete",
      nowMs: Date.now(),
    });
    expect(plan.details.faults).toEqual([]);
    const result = await core.run(cleanupEnvForSweep(), {
      mode: "delete",
      nowMs: Date.now(),
    });
    expect(result.error).toBeNull();

    expect(await objectExists(image.objectKey)).toBe(true);
    expect(await objectExists("image-chunks/v1/zstd6/" + image.chunkRawSha256)).toBe(true);
    expect(await objectExists("artifacts/" + image.kernelSha256)).toBe(true);
    expect(await objectExists("artifacts/" + image.initrdSha256)).toBe(true);
    // Nothing references the orphan, so the sweep removes it.
    expect(await objectExists(orphan.objectKey)).toBe(false);
  });
});

/** One actual-state VM row, optionally with a key and an archive record. */
describe("host operational closure against real D1", () => {
  beforeEach(async () => {
    await resetD1Database();
    await enableRegistryDeletion(env.DB);
  });

  it("resolves an actual VM with no key against the retained rollback", async () => {
    // Direct publish A then B: A survives only as the retained rollback, with
    // no build and no candidate naming it. A host reports a running VM on A
    // with no image key, so only the rollback closure can resolve it. Without
    // that coverage, A's manifest and boot artifacts would go unpinned.
    const previous = await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, {
      label: "rollback-only-a",
    });
    const live = await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, {
      label: "live-only-b",
    });
    const orphan = await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, {
      label: "truly-orphan-rollback",
    });
    const now = Date.now();
    const db = drizzle(env.DB);
    await seedScenario(
      { scenario: ROLLBACK_SCENARIO, vm: "web", arch: "x86_64" },
      {
        scenarioId: ROLLBACK_SCENARIO,
        chunkManifestSha256: live.chunkManifestSha256,
        imageId: live.imageId,
        kernel: live.kernelSha256,
        initrd: live.initrdSha256,
        sourceRevision: "revision-live",
      },
    );
    await db.insert(scenarioCatalogSnapshots).values({
      id: "public:revision-live:pre-promotion",
      revision: "revision-live:pre-promotion",
      snapshotJson: {
        schemaVersion: 1,
        targetScenarioIds: [ROLLBACK_SCENARIO],
        scenarios: [{ scenarioId: ROLLBACK_SCENARIO }],
        vms: [
          {
            scenarioId: ROLLBACK_SCENARIO,
            vmName: "web",
            imageSha256: previous.imageId,
            imageKeyJson: {
              scenario: ROLLBACK_SCENARIO,
              vm: "web",
              arch: "x86_64",
            },
            imageFormat: "raw_chunks_v1",
            chunkManifestSha256: previous.chunkManifestSha256,
            kernelSha256: previous.kernelSha256,
            initrdSha256: previous.initrdSha256,
          },
        ],
        probes: [],
      },
      createdAt: now,
    });
    await seedHostRow(db, { hostId: "host-rollback-only", now });
    await seedHostDesiredRow(db, { hostId: "host-rollback-only", now });
    await db.insert(hostActualState).values({
      hostId: "host-rollback-only",
      appliedDesiredVersion: 1,
      observedAt: now,
      reportJson: {
        schema_version: 5,
        host_id: "host-rollback-only",
        observed_at_unix_ms: now,
        applied_desired_version: 1,
        cached_images: [],
        builds: [],
        // Only an id: the rollback is the only record that names it.
        vms: [phaseVm("run-rollback", "running", previous.imageId, null, null)],
      } as never,
      createdAt: now,
      updatedAt: now,
    });

    const projection = await projectRegistryRetention(env, {
      nowUnixMs: Date.now(),
    });
    expect(projection.chunkManifestSha256s).toContain(
      previous.chunkManifestSha256,
    );
    expect(projection.bootArtifactSha256s).toContain(previous.kernelSha256);
    expect(projection.bootArtifactSha256s).toContain(previous.initrdSha256);

    const core = createImageRegistryCleanupCore({});
    const plan = await core.plan(cleanupEnvForSweep(), {
      mode: "delete",
      nowMs: Date.now(),
    });
    expect(plan.details.faults).toEqual([]);
    const result = await core.run(cleanupEnvForSweep(), {
      mode: "delete",
      nowMs: Date.now(),
    });
    expect(result.error).toBeNull();

    // The rollback closure the running VM needs survives, the live release
    // survives, and the image nothing names is reclaimed in the same pass.
    expect(await objectExists(previous.objectKey)).toBe(true);
    expect(
      await objectExists("image-chunks/v1/zstd6/" + previous.chunkRawSha256),
    ).toBe(true);
    expect(await objectExists("artifacts/" + previous.kernelSha256)).toBe(true);
    expect(await objectExists("artifacts/" + previous.initrdSha256)).toBe(true);
    expect(await objectExists(live.objectKey)).toBe(true);
    expect(await objectExists(orphan.objectKey)).toBe(false);
  });

  it("merges every boot variant that shares one image id", async () => {
    // The same disk image, republished with a different kernel and initrd. One
    // image id does not identify one boot variant, so an operational VM naming
    // that id must keep both variants rather than the first one found.
    // One real chunked image: a manifest that verifies, its chunk, and the
    // boot artifacts of the current variant.
    const bucket = env.VM_IMAGE_REGISTRY_BUCKET;
    const image = await seedChunkedImage(bucket, { label: "shared-image" });
    const imageId = image.imageId;
    const manifestSha256 = image.chunkManifestSha256;
    const oldKernel = await seedBootArtifact(bucket, "shared-image:old-kernel");
    const oldInitrd = await seedBootArtifact(bucket, "shared-image:old-initrd");
    const newKernel = image.kernelSha256;
    const newInitrd = image.initrdSha256;
    const imageKey = {
      scenario: "shared-boot",
      vm: "web",
      arch: "x86_64" as const,
    };
    const now = Date.now();
    const db = drizzle(env.DB);
    const variants = [
      { rev: "shared-boot-a", kernel: oldKernel, initrd: oldInitrd },
      { rev: "shared-boot-b", kernel: newKernel, initrd: newInitrd },
    ];
    for (const variant of variants) {
      await db.insert(imageBuildBundles).values({
        rev: variant.rev,
        r2Key: "builds/bundles/" + variant.rev + ".tar.gz",
        metaJson: {
          buildFormatVersion: IMAGE_BUILD_FORMAT_VERSION,
          catalogChannel: "live",
          scenarios: [],
        },
      });
      await db.insert(imageBuilds).values({
        id: "shared-build-" + variant.rev,
        scenarioId: imageKey.scenario,
        arch: imageKey.arch,
        rev: variant.rev,
        contentHash: variant.rev.padEnd(64, "0").slice(0, 64),
        status: "succeeded",
        phase: "succeeded",
        publishedManifestJson: {
          scenario_id: imageKey.scenario,
          vms: [
            {
              name: "web",
              image_key: imageKey,
              image_id: imageId,
              image_format: "raw_chunks_v1",
              chunk_manifest_sha256: manifestSha256,
              boot: {
                kernel_sha256: variant.kernel,
                initrd_sha256: variant.initrd,
              },
            },
          ],
        } as never,
        updatedAt: now,
      });
    }
    await seedHostRow(db, { hostId: "host-variants", now });
    await seedHostDesiredRow(db, { hostId: "host-variants", now });
    await db.insert(hostActualState).values({
      hostId: "host-variants",
      appliedDesiredVersion: 1,
      observedAt: now,
      reportJson: {
        schema_version: 5,
        host_id: "host-variants",
        observed_at_unix_ms: now,
        applied_desired_version: 1,
        cached_images: [],
        builds: [],
        vms: [phaseVm("run-variant", "running", imageId, null, imageKey)],
      } as never,
      createdAt: now,
      updatedAt: now,
    });

    const projection = await projectRegistryRetention(env, {
      nowUnixMs: Date.now(),
    });
    // Both variants survive: a running VM may boot either one.
    for (const sha256 of [oldKernel, oldInitrd, newKernel, newInitrd]) {
      expect(projection.bootArtifactSha256s).toContain(sha256);
    }
    expect(projection.chunkManifestSha256s).toContain(manifestSha256);

    const core = createImageRegistryCleanupCore({});
    const plan = await core.plan(cleanupEnvForSweep(), {
      mode: "delete",
      nowMs: Date.now(),
    });
    expect(plan.details.faults).toEqual([]);
    const result = await core.run(cleanupEnvForSweep(), {
      mode: "delete",
      nowMs: Date.now(),
    });
    expect(result.error).toBeNull();
    for (const sha256 of [oldKernel, oldInitrd, newKernel, newInitrd]) {
      expect(await objectExists("artifacts/" + sha256)).toBe(true);
    }
  });

  it("keeps historical boot artifacts unrooted on their own", async () => {
    // A manifest nothing operational names must not pin its boot artifacts,
    // even when another build with a different kernel is rooted.
    const image = await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, {
      label: "anchored-live",
    });
    const historicKernel = await sha256OfLabel("historic-only-kernel");
    const historicInitrd = await sha256OfLabel("historic-only-initrd");
    await env.VM_IMAGE_REGISTRY_BUCKET.put(
      "artifacts/" + historicKernel,
      new Uint8Array([9]),
    );
    await env.VM_IMAGE_REGISTRY_BUCKET.put(
      "artifacts/" + historicInitrd,
      new Uint8Array([9]),
    );
    const now = Date.now();
    const db = drizzle(env.DB);
    await db.insert(imageBuildBundles).values({
      rev: "historic-bundle",
      r2Key: "builds/bundles/historic-bundle.tar.gz",
      metaJson: {
        buildFormatVersion: IMAGE_BUILD_FORMAT_VERSION,
        catalogChannel: "live",
        scenarios: [],
      },
    });
    await db.insert(imageBuilds).values({
      id: "historic-build",
      scenarioId: HISTORIC_SCENARIO,
      arch: "x86_64",
      rev: "historic-bundle",
      contentHash: "h".repeat(64),
      status: "succeeded",
      phase: "succeeded",
      publishedManifestJson: {
        scenario_id: HISTORIC_SCENARIO,
        vms: [
          {
            name: "web",
            image_key: {
              scenario: HISTORIC_SCENARIO,
              vm: "web",
              arch: "x86_64",
            },
            image_id: "1".repeat(64),
            image_format: "raw_chunks_v1",
            chunk_manifest_sha256: "2".repeat(64),
            boot: {
              kernel_sha256: historicKernel,
              initrd_sha256: historicInitrd,
            },
          },
        ],
      } as never,
      updatedAt: now,
    });
    // The live catalog publishes a different image, and one host runs it.
    await seedScenario(
      { scenario: ANCHORED_SCENARIO, vm: "web", arch: "x86_64" },
      {
        scenarioId: ANCHORED_SCENARIO,
        chunkManifestSha256: image.chunkManifestSha256,
        imageId: image.imageId,
        kernel: image.kernelSha256,
        initrd: image.initrdSha256,
      },
    );
    await seedHostRow(db, { hostId: "host-anchored", now });
    await seedHostDesiredRow(db, { hostId: "host-anchored", now });
    await db.insert(hostActualState).values({
      hostId: "host-anchored",
      appliedDesiredVersion: 1,
      observedAt: now,
      reportJson: {
        schema_version: 5,
        host_id: "host-anchored",
        observed_at_unix_ms: now,
        applied_desired_version: 1,
        cached_images: [],
        builds: [],
        vms: [
          phaseVm("run-anchored", "running", image.imageId, null, {
            scenario: ANCHORED_SCENARIO,
            vm: "web",
            arch: "x86_64",
          }),
        ],
      } as never,
      createdAt: now,
      updatedAt: now,
    });

    const projection = await projectRegistryRetention(env, {
      nowUnixMs: Date.now(),
    });
    // The rooted image keeps its own boot artifacts...
    expect(projection.bootArtifactSha256s).toContain(image.kernelSha256);
    expect(projection.bootArtifactSha256s).toContain(image.initrdSha256);
    // ...and the historical manifest nothing operational names keeps nothing.
    expect(projection.bootArtifactSha256s).not.toContain(historicKernel);
    expect(projection.bootArtifactSha256s).not.toContain(historicInitrd);
    expect(projection.chunkManifestSha256s).not.toContain("2".repeat(64));
  });


  it("stops the sweep when an operational VM carries no image id", async () => {
    // An incomplete reference must not be ignored: dropping it would delete the
    // image that VM boots. The tombstone beside it still drops, so the phase
    // decides before the id does.
    const reachable = await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, {
      label: "reachable-orphan",
    });
    const now = Date.now();
    const db = drizzle(env.DB);
    await seedHostRow(db, { hostId: "host-missing-id", now });
    await seedHostDesiredRow(db, { hostId: "host-missing-id", now });
    await db.insert(hostActualState).values({
      hostId: "host-missing-id",
      appliedDesiredVersion: 1,
      observedAt: now,
      reportJson: {
        schema_version: 5,
        host_id: "host-missing-id",
        observed_at_unix_ms: now,
        applied_desired_version: 1,
        cached_images: [],
        builds: [],
        vms: [
          // Operational but incomplete: this is the fault.
          { run_id: "run-no-id", vm_name: "web", phase: "running" },
          // A tombstone with no id is still a tombstone, not a fault.
          {
            run_id: "run-tombstone",
            vm_name: "web",
            phase: "absent",
            image_key: { scenario: "tombstone", vm: "web", arch: "x86_64" },
          },
        ],
      } as never,
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      projectRegistryRetention(env, { nowUnixMs: Date.now() }),
    ).rejects.toThrow(RegistryRetentionFault);

    // The sweep deletes nothing at all, including the object it could reach.
    const core = createImageRegistryCleanupCore({});
    const result = await core.run(cleanupEnvForSweep(), {
      mode: "delete",
      nowMs: Date.now(),
    });
    expect(result.deletedObjects).toBe(0);
    // A refused pass reports why it stopped, and it deletes nothing.
    expect(result.error).toContain("reference verification stopped the sweep");
    expect(await objectExists(reachable.objectKey)).toBe(true);
    expect(
      await objectExists("image-chunks/v1/zstd6/" + reachable.chunkRawSha256),
    ).toBe(true);
  });

  it("keeps every boot variant for a keyless operational VM", async () => {
    // The same image id with two boot variants, and an actual VM that reports
    // only the id. Deduping the by-id index per key would keep the first
    // variant and leave the other variant's kernel and initrd unpinned.
    const bucket = env.VM_IMAGE_REGISTRY_BUCKET;
    const image = await seedChunkedImage(bucket, { label: "keyless-variant" });
    const imageId = image.imageId;
    const manifestSha256 = image.chunkManifestSha256;
    const oldKernel = await seedBootArtifact(bucket, "keyless-variant:old-kernel");
    const oldInitrd = await seedBootArtifact(bucket, "keyless-variant:old-initrd");
    const newKernel = image.kernelSha256;
    const newInitrd = image.initrdSha256;
    const imageKey = {
      scenario: "keyless-boot",
      vm: "web",
      arch: "x86_64" as const,
    };
    const now = Date.now();
    const db = drizzle(env.DB);
    const variants = [
      { rev: "keyless-boot-a", kernel: oldKernel, initrd: oldInitrd },
      { rev: "keyless-boot-b", kernel: newKernel, initrd: newInitrd },
    ];
    for (const variant of variants) {
      await db.insert(imageBuildBundles).values({
        rev: variant.rev,
        r2Key: "builds/bundles/" + variant.rev + ".tar.gz",
        metaJson: {
          buildFormatVersion: IMAGE_BUILD_FORMAT_VERSION,
          catalogChannel: "live",
          scenarios: [],
        },
      });
      await db.insert(imageBuilds).values({
        id: "keyless-build-" + variant.rev,
        scenarioId: imageKey.scenario,
        arch: imageKey.arch,
        rev: variant.rev,
        contentHash: variant.rev.padEnd(64, "0").slice(0, 64),
        status: "succeeded",
        phase: "succeeded",
        publishedManifestJson: {
          scenario_id: imageKey.scenario,
          vms: [
            {
              name: "web",
              image_key: imageKey,
              image_id: imageId,
              image_format: "raw_chunks_v1",
              chunk_manifest_sha256: manifestSha256,
              boot: {
                kernel_sha256: variant.kernel,
                initrd_sha256: variant.initrd,
              },
            },
          ],
        } as never,
        updatedAt: now,
      });
    }
    await seedHostRow(db, { hostId: "host-keyless", now });
    await seedHostDesiredRow(db, { hostId: "host-keyless", now });
    await db.insert(hostActualState).values({
      hostId: "host-keyless",
      appliedDesiredVersion: 1,
      observedAt: now,
      reportJson: {
        schema_version: 5,
        host_id: "host-keyless",
        observed_at_unix_ms: now,
        applied_desired_version: 1,
        cached_images: [],
        builds: [],
        // No key at all: the by-id fallback has to supply both variants.
        vms: [phaseVm("run-keyless", "running", imageId, null, null)],
      } as never,
      createdAt: now,
      updatedAt: now,
    });

    const projection = await projectRegistryRetention(env, {
      nowUnixMs: Date.now(),
    });
    for (const sha256 of [oldKernel, oldInitrd, newKernel, newInitrd]) {
      expect(projection.bootArtifactSha256s).toContain(sha256);
    }

    const core = createImageRegistryCleanupCore({});
    const plan = await core.plan(cleanupEnvForSweep(), {
      mode: "delete",
      nowMs: Date.now(),
    });
    expect(plan.details.faults).toEqual([]);
    const result = await core.run(cleanupEnvForSweep(), {
      mode: "delete",
      nowMs: Date.now(),
    });
    expect(result.error).toBeNull();
    for (const sha256 of [oldKernel, oldInitrd, newKernel, newInitrd]) {
      expect(await objectExists("artifacts/" + sha256)).toBe(true);
    }
  });

});

  it("keeps a legacy image's recorded boot artifacts and deletes unrelated ones", async () => {
    // A legacy single-object image carries no chunk manifest, but it does record
    // the kernel and initrd it boots. Those are references: a self-booting
    // format must not lose them, and boot artifacts nothing references must
    // still be reclaimed in the same pass.
    const legacyImageId = await sha256OfLabel("legacy-operational-image");
    await seedLegacyImage(env.VM_IMAGE_REGISTRY_BUCKET, {
      scenario: LEGACY_SCENARIO,
      vm: "web",
      arch: "x86_64",
      sha256: legacyImageId,
    });
    const bucket = env.VM_IMAGE_REGISTRY_BUCKET;
    const legacyKernel = await seedBootArtifact(bucket, "legacy:kernel");
    const legacyInitrd = await seedBootArtifact(bucket, "legacy:initrd");
    // Boot artifacts that no record and no reference names.
    const unusedKernel = await seedBootArtifact(bucket, "legacy:unused-kernel");
    const unusedInitrd = await seedBootArtifact(bucket, "legacy:unused-initrd");
    const imageKey = {
      scenario: LEGACY_SCENARIO,
      vm: "web",
      arch: "x86_64" as const,
    };
    const now = Date.now();
    const db = drizzle(env.DB);
    await db.insert(imageBuildBundles).values({
      rev: "legacy-bundle",
      r2Key: "builds/bundles/legacy-bundle.tar.gz",
      metaJson: {
        buildFormatVersion: IMAGE_BUILD_FORMAT_VERSION,
        catalogChannel: "live",
        scenarios: [],
      },
    });
    await db.insert(imageBuilds).values({
      id: "legacy-build",
      scenarioId: LEGACY_SCENARIO,
      arch: "x86_64",
      rev: "legacy-bundle",
      contentHash: "l".repeat(64),
      status: "succeeded",
      phase: "succeeded",
      publishedManifestJson: {
        scenario_id: LEGACY_SCENARIO,
        vms: [
          {
            name: "web",
            image_key: imageKey,
            image_id: legacyImageId,
            image_format: "raw_zstd",
            boot: {
              kernel_sha256: legacyKernel,
              initrd_sha256: legacyInitrd,
            },
          },
        ],
      } as never,
      updatedAt: now,
    });
    await seedHostRow(db, { hostId: "host-legacy", now });
    await seedHostDesiredRow(db, { hostId: "host-legacy", now });
    await db.insert(hostActualState).values({
      hostId: "host-legacy",
      appliedDesiredVersion: 1,
      observedAt: now,
      reportJson: {
        schema_version: 5,
        host_id: "host-legacy",
        observed_at_unix_ms: now,
        applied_desired_version: 1,
        cached_images: [],
        builds: [],
        // Keyless, so the resolution goes through the by-id fallback.
        vms: [phaseVm("run-legacy", "running", legacyImageId, null, null)],
      } as never,
      createdAt: now,
      updatedAt: now,
    });

    const projection = await projectRegistryRetention(env, {
      nowUnixMs: Date.now(),
    });
    // The legacy format's recorded boot artifacts are references.
    expect(projection.bootArtifactSha256s).toContain(legacyKernel);
    expect(projection.bootArtifactSha256s).toContain(legacyInitrd);
    expect(projection.bootArtifactSha256s).not.toContain(unusedKernel);
    expect(projection.bootArtifactSha256s).not.toContain(unusedInitrd);

    const core = createImageRegistryCleanupCore({});
    const plan = await core.plan(cleanupEnvForSweep(), {
      mode: "delete",
      nowMs: Date.now(),
    });
    expect(plan.details.faults).toEqual([]);
    const result = await core.run(cleanupEnvForSweep(), {
      mode: "delete",
      nowMs: Date.now(),
    });
    expect(result.error).toBeNull();

    expect(await objectExists("artifacts/" + legacyKernel)).toBe(true);
    expect(await objectExists("artifacts/" + legacyInitrd)).toBe(true);
    expect(await objectExists("artifacts/" + unusedKernel)).toBe(false);
    expect(await objectExists("artifacts/" + unusedInitrd)).toBe(false);
    // The legacy image object the running VM boots also survives.
    expect(
      await objectExists(
        "images/" + LEGACY_SCENARIO + "-web-x86_64/" + legacyImageId + ".raw.zst",
      ),
    ).toBe(true);
  });

/** The scenario the rollback-only regression publishes. */
const ROLLBACK_SCENARIO = "rollback-only-fixture";
/** A scenario published in the legacy single-object image format. */
const LEGACY_SCENARIO = "legacy-operational-fixture";
/** A scenario whose only record is one historical build manifest. */
const HISTORIC_SCENARIO = "historic-only-fixture";
/** A scenario whose images a host actually boots. */
const ANCHORED_SCENARIO = "anchored-fixture";

function phaseVm(
  runId: string,
  phase: string,
  imageId: string,
  archive: { phase: string; artifact_count: number } | null,
  imageKey: ImageKey | null = { scenario: "host-phase", vm: "web", arch: "x86_64" },
) {
  return {
    run_id: runId,
    vm_name: "web",
    phase,
    image_id: imageId,
    ...(imageKey ? { image_key: imageKey } : {}),
    ...(archive ? { archive } : {}),
  };
}

function cleanupEnvForSweep(): {
  DB: D1Database;
  VM_IMAGE_REGISTRY_BUCKET: R2Bucket;
} {
  return {
    DB: env.DB,
    VM_IMAGE_REGISTRY_BUCKET: env.VM_IMAGE_REGISTRY_BUCKET,
  };
}

/** A host with desired state but no desired VM: the actual report is all it has. */
async function seedHostDesiredRow(
  db: ReturnType<typeof drizzle>,
  input: { hostId: string; now: number },
): Promise<void> {
  await db.insert(hostDesiredState).values({
    hostId: input.hostId,
    version: 1,
    docJson: {
      schema_version: HOST_DESIRED_STATE_SCHEMA_VERSION,
      host_id: input.hostId,
      version: 1,
      generated_at_unix_ms: input.now,
      cached_images: [],
      cached_guest_tools: [],
      builds: [],
      vms: [],
    } as never,
    createdAt: input.now,
    updatedAt: input.now,
  });
}

async function seedHostRow(
  db: ReturnType<typeof drizzle>,
  input: { hostId: string; now: number },
): Promise<void> {
  await db.insert(user).values({
    id: "owner-" + input.hostId,
    name: "Owner",
    email: input.hostId + "@example.test",
    emailVerified: true,
    createdAt: new Date(input.now),
    updatedAt: new Date(input.now),
  });
  await db.insert(agentHosts).values({
    id: input.hostId,
    userId: "owner-" + input.hostId,
    name: input.hostId,
    role: "agent",
    scenarioEnabled: true,
    disabled: false,
  });
}

/** The production fan-out: many hosts, one deleted release, one tombstone. */
async function seedManyHostsWithTombstone(input: {
  hostCount: number;
  desiredPhase: "running" | "absent";
  imageId: string;
}): Promise<void> {
  const now = Date.now();
  const db = drizzle(env.DB);
  for (let index = 0; index < input.hostCount; index += 1) {
    const hostId = "host-" + index;
    await seedHostRow(db, { hostId, now });
    await db.insert(hostDesiredState).values({
      hostId,
      version: 1,
      docJson: {
        schema_version: HOST_DESIRED_STATE_SCHEMA_VERSION,
        host_id: hostId,
        version: 1,
        generated_at_unix_ms: now,
        cached_images: [],
        cached_guest_tools: [],
        builds: [],
        vms: [
          {
            run_id: "run-" + index,
            vm_name: "webserver",
            desired_phase: input.desiredPhase,
            image_key: {
              scenario: "broken-nginx",
              vm: "webserver",
              arch: "x86_64",
            },
            image_id: input.imageId,
          },
        ],
      } as never,
      createdAt: now,
      updatedAt: now,
    });
  }
}
