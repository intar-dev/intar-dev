/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { vmScenarioVms, vmScenarios } from "@/db/schema";
import {
  agentHosts,
  hostActualState,
  hostDesiredState,
  imageBuildBundles,
  imageBuilds,
  user,
} from "@/db/schema";
import { HOST_DESIRED_STATE_SCHEMA_VERSION } from "@/generated/constants";
import type { ImageKey } from "@/generated/catalog";
import { sha256Hex } from "@/control-plane/image-registry/shared";
import { IMAGE_BUILD_FORMAT_VERSION } from "@/lib/image-build-format";
import {
  canonicalImageChunkManifest,
  validateImageChunkManifest,
} from "@/control-plane/image-registry/chunks";
import {
  IMAGE_CHUNK_PREFIX,
  IMAGE_MANIFEST_PREFIX,
} from "@/lib/image-artifact-retention";
import {
  createImageRegistryCleanupCore,
  planCleanupDeleteSelection,
  type ImageRegistryCleanupEnv,
  type ImageRegistryCleanupPlanObject,
} from "@/lib/image-registry-cleanup";
import { setRegistryEnforcement } from "@/lib/image-registry-admission";
import { resetD1Database } from "@/test/d1-migrations";

const NOW_MS = 1_700_000_000_000;
const LEGACY_IMAGE_ID = "2".repeat(64);
const KERNEL_SHA = "a".repeat(64);
const INITRD_SHA = "b".repeat(64);
const ORPHAN_IMAGE_ID = "3".repeat(64);
const ORPHAN_CHUNK_SHA = "c".repeat(64);
const ORPHAN_ARTIFACT_SHA = "d".repeat(64);
const RETAINED_CHUNK_ONE = "e".repeat(64);
const RETAINED_CHUNK_TWO = "f".repeat(64);
const ORPHAN_SCENARIO = "orphan-scenario";

const CHUNKED_SCENARIO = "chunked-scenario";
const CHUNKED_VM = "server";
const CHUNKED_ARCH = "x86_64";

interface BucketObjects {
  manifestSha256: string;
  manifestKey: string;
  /** The identity the canonical manifest declares; the catalog row names it. */
  imageId: string;
  virtualSizeBytes: number;
  orphanManifestKey: string;
}

const CHUNK_SIZE_BYTES = 4_194_304;

/**
 * A real manifest: the shared canonical builder derives the header, the
 * descriptor sizes, and the image_id, so the fixture cannot invent an identity.
 * These tests therefore exercise the same validation the sweep runs in
 * production, and a body that stops being valid fails here first.
 */
async function manifestFor(input: {
  chunks: string[];
  virtualSizeBytes?: number;
}): Promise<{ body: Uint8Array; imageId: string; sha256: string }> {
  const manifest = await canonicalImageChunkManifest({
    virtualSizeBytes: input.virtualSizeBytes ?? CHUNK_SIZE_BYTES,
    chunkRawSha256s: input.chunks,
  });
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  return {
    body: bytes,
    imageId: manifest.image_id,
    sha256: await sha256Hex(bytes.buffer as ArrayBuffer),
  };
}

/** One valid chunked image plus its manifest, and the orphans around it. */
async function seedBucket(): Promise<BucketObjects> {
  const retained = await manifestFor({
    virtualSizeBytes: 2 * CHUNK_SIZE_BYTES,
    chunks: [
    RETAINED_CHUNK_ONE,
    RETAINED_CHUNK_TWO,
    ],
  });
  const manifestSha256 = retained.sha256;
  const manifestKey = IMAGE_MANIFEST_PREFIX + manifestSha256 + ".json";

  // Retained by a live catalog pointer.
  await env.VM_IMAGE_REGISTRY_BUCKET.put(manifestKey, retained.body);
  await env.VM_IMAGE_REGISTRY_BUCKET.put(
    IMAGE_CHUNK_PREFIX + RETAINED_CHUNK_ONE,
    new Uint8Array([1, 2, 3]),
  );
  await env.VM_IMAGE_REGISTRY_BUCKET.put(
    IMAGE_CHUNK_PREFIX + RETAINED_CHUNK_TWO,
    new Uint8Array([4, 5, 6]),
  );
  await env.VM_IMAGE_REGISTRY_BUCKET.put(
    "artifacts/" + KERNEL_SHA,
    new Uint8Array([7]),
  );
  await env.VM_IMAGE_REGISTRY_BUCKET.put(
    "artifacts/" + INITRD_SHA,
    new Uint8Array([8]),
  );
  // The non-chunked live pointer keeps its legacy object and sidecar.
  await env.VM_IMAGE_REGISTRY_BUCKET.put(
    "images/broken-nginx-webserver-x86_64/" + LEGACY_IMAGE_ID + ".raw.zst",
    new Uint8Array([9]),
  );
  await env.VM_IMAGE_REGISTRY_BUCKET.put(
    "images/broken-nginx-webserver-x86_64/" + LEGACY_IMAGE_ID + ".raw.zst.sha256",
    new Uint8Array([10]),
  );

  // Nothing references these.
  const orphan = await manifestFor({ chunks: [ORPHAN_CHUNK_SHA] });
  const orphanManifestKey = IMAGE_MANIFEST_PREFIX + orphan.sha256 + ".json";
  await env.VM_IMAGE_REGISTRY_BUCKET.put(
    orphanManifestKey,
    orphan.body,
  );
  await env.VM_IMAGE_REGISTRY_BUCKET.put(
    IMAGE_CHUNK_PREFIX + ORPHAN_CHUNK_SHA,
    new Uint8Array([11]),
  );
  await env.VM_IMAGE_REGISTRY_BUCKET.put(
    "images/broken-nginx-webserver-x86_64/" + ORPHAN_IMAGE_ID + ".raw.zst",
    new Uint8Array([12]),
  );
  await env.VM_IMAGE_REGISTRY_BUCKET.put(
    "images/broken-nginx-webserver-x86_64/" + ORPHAN_IMAGE_ID + ".raw.zst.sha256",
    new Uint8Array([13]),
  );
  await env.VM_IMAGE_REGISTRY_BUCKET.put(
    "artifacts/" + ORPHAN_ARTIFACT_SHA,
    new Uint8Array([14]),
  );
  // Outside every swept prefix.
  await env.VM_IMAGE_REGISTRY_BUCKET.put(
    "builds/bundles/rev-1.tar.gz",
    new Uint8Array([15]),
  );
  await env.VM_IMAGE_REGISTRY_BUCKET.put(
    "guest-tools/scenario/stable.json",
    new Uint8Array([16]),
  );
  return {
    manifestSha256,
    manifestKey,
    imageId: retained.imageId,
    virtualSizeBytes: 2 * CHUNK_SIZE_BYTES,
    orphanManifestKey,
  };
}

async function seedCatalog(input: {
  manifestSha256: string;
  imageId: string;
  virtualSizeBytes: number;
}): Promise<void> {
  const db = drizzle(env.DB);
  const now = NOW_MS;
  await db.insert(vmScenarios).values({
    scenarioId: "broken-nginx",
    title: "Broken Nginx",
    description: "Repair nginx.",
    difficulty: "easy",
    estimatedMinutes: 1,
    tagsJson: [],
    briefingMarkdown: "Repair nginx.",
    solutionMarkdown: "Start nginx.",
    hintsJson: [],
    enabled: true,
    enabledAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(vmScenarios).values({
    scenarioId: CHUNKED_SCENARIO,
    title: "Chunked",
    description: "Chunked image.",
    difficulty: "easy",
    estimatedMinutes: 1,
    tagsJson: [],
    briefingMarkdown: "Chunked.",
    solutionMarkdown: "Chunked.",
    hintsJson: [],
    enabled: true,
    enabledAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(vmScenarioVms).values({
    id: "scenario-vm-web",
    scenarioId: "broken-nginx",
    ordinal: 0,
    vmName: "webserver",
    image: "legacy",
    imageKeyJson: { scenario: "broken-nginx", vm: "webserver", arch: "x86_64" },
    imageSha256: LEGACY_IMAGE_ID,
    imageFormat: "raw_zstd",
    imageVirtualSizeBytes: 1_073_741_824,
    kernelSha256: KERNEL_SHA,
    initrdSha256: INITRD_SHA,
    bootCmdline: "root=/dev/vda rw",
    cpuMillis: 125,
    vcpuCount: 1,
    memoryMib: 512,
    diskMib: 4_096,
  });
  await db.insert(vmScenarioVms).values({
    id: "scenario-vm-server",
    scenarioId: CHUNKED_SCENARIO,
    ordinal: 0,
    vmName: CHUNKED_VM,
    image: "chunked",
    imageKeyJson: {
      scenario: CHUNKED_SCENARIO,
      vm: CHUNKED_VM,
      arch: CHUNKED_ARCH,
    },
    imageSha256: input.imageId,
    imageFormat: "raw_chunks_v1",
    imageVirtualSizeBytes: input.virtualSizeBytes,
    chunkManifestSha256: input.manifestSha256,
    guestBootstrapAbi: 2,
    kernelSha256: KERNEL_SHA,
    initrdSha256: INITRD_SHA,
    bootCmdline: "root=/dev/vda rw",
    cpuMillis: 125,
    vcpuCount: 1,
    memoryMib: 512,
    diskMib: 4_096,
  });
}

/** The gate is shared state: the test turns enforcement on through its own API. */
async function enforce(): Promise<void> {
  await setRegistryEnforcement(env, "enforce");
}

/** The same canonical keyset the core reports: sorted key<TAB>bytes lines. */
async function keysetDigest(
  objects: ReadonlyArray<{ key: string; bytes: number }>,
): Promise<string> {
  const lines = objects
    .map((object) => object.key + "\t" + object.bytes)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return sha256Hex(
    new TextEncoder().encode(lines.join("\n")).buffer as ArrayBuffer,
  );
}

async function gcRuns(): Promise<Array<{ state: string; deleted_objects: number; error: string | null }>> {
  const rows = await env.DB.prepare(
    "SELECT state, deleted_objects, error FROM image_registry_gc_runs",
  ).all<{ state: string; deleted_objects: number; error: string | null }>();
  return rows.results ?? [];
}

function cleanupEnv(): ImageRegistryCleanupEnv {
  return {
    DB: env.DB,
    VM_IMAGE_REGISTRY_BUCKET: env.VM_IMAGE_REGISTRY_BUCKET,
  };
}

async function bucketKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await env.VM_IMAGE_REGISTRY_BUCKET.list(
      cursor ? { prefix, cursor } : { prefix },
    );
    for (const object of page.objects) keys.push(object.key);
    if (!page.truncated || !page.cursor) return keys.sort();
    cursor = page.cursor;
  }
}

/** A family that only a build record still manages: a removed scenario. */
const WARM_FAMILY: ImageKey = {
  scenario: "warm-old-scenario",
  vm: "web",
  arch: "x86_64",
};
/** The production reading of pinned_images on the scenario agent. */
const WARM_INTENTS = 425;

function warmImageId(index: number): string {
  return "f" + index.toString(16).padStart(63, "0");
}

/**
 * A host holding 425 image versions of a removed managed family, none of
 * which exists in the bucket any more. Its desired state is the only record
 * that still names them, which is exactly the production shape.
 */
async function seedObsoleteWarmIntents(input: {
  hostId: string;
  /** Set to a foreign host to make the version-guarded write refuse. */
  hostIdInDoc?: string;
}): Promise<string[]> {
  const db = drizzle(env.DB);
  const now = NOW_MS;
  await db.insert(imageBuildBundles).values({
    rev: "warm-old-bundle",
    r2Key: "builds/bundles/warm-old-bundle.tar.gz",
    metaJson: {
      buildFormatVersion: IMAGE_BUILD_FORMAT_VERSION,
      catalogChannel: "live",
      scenarios: [],
    },
  });
  await db.insert(imageBuilds).values({
    id: "warm-old-build",
    scenarioId: WARM_FAMILY.scenario,
    arch: WARM_FAMILY.arch,
    rev: "warm-old-bundle",
    contentHash: "5".repeat(64),
    status: "succeeded",
    phase: "succeeded",
    publishedManifestJson: {
      scenario_id: WARM_FAMILY.scenario,
      vms: [
        {
          name: WARM_FAMILY.vm,
          image_key: { ...WARM_FAMILY },
          image_id: "6".repeat(64),
        },
      ],
    } as never,
    updatedAt: now,
  });
  await db.insert(user).values({
    id: "warm-owner",
    name: "Warm Owner",
    email: "warm-owner@example.com",
    createdAt: new Date(now),
    updatedAt: new Date(now),
  });
  await db.insert(agentHosts).values({
    id: input.hostId,
    userId: "warm-owner",
    name: input.hostId,
    role: "agent",
    disabled: false,
    connected: true,
    createdAt: now,
    updatedAt: now,
  });
  const imageIds = Array.from({ length: WARM_INTENTS }, (_, index) =>
    warmImageId(index),
  );
  await db.insert(hostDesiredState).values({
    hostId: input.hostId,
    version: 3,
    docJson: {
      schema_version: HOST_DESIRED_STATE_SCHEMA_VERSION,
      host_id: input.hostIdInDoc ?? input.hostId,
      version: 3,
      generated_at_unix_ms: now,
      cached_images: imageIds.map((imageId) => ({
        image_key: { ...WARM_FAMILY },
        image_id: imageId,
      })),
      cached_guest_tools: [],
      vms: [],
      builds: [],
    },
    createdAt: now,
    updatedAt: now,
  });
  // The host is honest about what it holds: one obsolete version runs a VM and
  // another transfer is in flight, so neither intent may be withdrawn.
  await db.insert(hostActualState).values({
    hostId: input.hostId,
    appliedDesiredVersion: 3,
    observedAt: now,
    reportJson: {
      schema_version: 5,
      host_id: input.hostId,
      observed_at_unix_ms: now,
      applied_desired_version: 3,
      cached_images: [
        {
          image_key: { ...WARM_FAMILY },
          image_id: imageIds[1]!,
          phase: "downloading",
          updated_at_unix_ms: now,
        },
      ],
      vms: [
        {
          run_id: "run-warm",
          vm_name: WARM_FAMILY.vm,
          phase: "running",
          // The agent reports the key it boots with, so the retention policy
          // can resolve this VM to a registry family instead of guessing.
          image_key: { ...WARM_FAMILY },
          image_id: imageIds[0]!,
        },
      ],
      builds: [],
    } as never,
    createdAt: now,
    updatedAt: now,
  });
  return imageIds;
}

async function hostCachedImageIds(hostId: string): Promise<string[]> {
  const row = await env.DB.prepare(
    "SELECT doc_json FROM host_desired_state WHERE host_id = ?1",
  )
    .bind(hostId)
    .first<{ doc_json: string }>();
  if (!row) throw new Error("host desired state is missing for " + hostId);
  const doc = JSON.parse(row.doc_json) as {
    cached_images: Array<{ image_id: string }>;
  };
  return doc.cached_images.map((image) => image.image_id);
}


describe("image registry cleanup core", () => {
  beforeEach(async () => {
    await resetD1Database();
  });


  it("reclaims the objects that 423 obsolete warm intents were holding", async () => {
    const seeded = await seedBucket();
    await seedCatalog(seeded);
    const hostId = "host-warm-intents";
    const imageIds = await seedObsoleteWarmIntents({ hostId });
    // Two old versions still have their object in the bucket. One is named by
    // an intent a running VM needs, the other only by a withdrawn intent.
    const warmSlug = "warm-old-scenario-web-x86_64";
    const runningKey = "images/" + warmSlug + "/" + imageIds[0] + ".raw.zst";
    const withdrawnKey = "images/" + warmSlug + "/" + imageIds[3] + ".raw.zst";
    await env.VM_IMAGE_REGISTRY_BUCKET.put(runningKey, new Uint8Array([21]));
    await env.VM_IMAGE_REGISTRY_BUCKET.put(withdrawnKey, new Uint8Array([22]));
    await enforce();
    const core = createImageRegistryCleanupCore({});

    const plan = await core.plan(cleanupEnv(), {
      mode: "report-only",
      nowMs: NOW_MS,
    });
    expect(plan.details.faults).toEqual([]);
    expect(plan.details.deleteAllowedByReferences).toBe(true);
    expect(plan.details.projectedRetirements.trimmedHostCacheImageIds).toBe(
      WARM_INTENTS - 2,
    );
    // The running VM's version stays, and now as a proven root rather than a
    // digest coincidence: an operational host VM resolves through the same
    // index an active run uses, so its object is retained by reference.
    expect(plan.details.retainedByDigestOnly).toBe(0);
    expect(plan.candidateObjects.map((object) => object.key)).toContain(
      withdrawnKey,
    );

    // Report-only projects the trim and writes nothing, not even desired state.
    expect(await hostCachedImageIds(hostId)).toEqual(imageIds);
    expect(await bucketKeys("")).toContain(withdrawnKey);

    const result = await core.run(cleanupEnv(), { mode: "delete", nowMs: NOW_MS });

    expect(result.error).toBeNull();
    expect(result.phases.trimmed_host_cache_intents).toBe(WARM_INTENTS - 2);
    // The host update commits in the same pass and before the deletes, so the
    // intent that protected an object is gone before the object is. The two
    // that a live reference still needs stay in the document.
    const remaining = await hostCachedImageIds(hostId);
    expect(remaining.sort()).toEqual([imageIds[0]!, imageIds[1]!].sort());
    expect(await bucketKeys("")).not.toContain(withdrawnKey);
    expect(await bucketKeys("")).toContain(runningKey);
    // One pass: the policy decision this run committed was already in its own
    // worklist, so the sweep is complete rather than pending.
    expect(result.resumeRequired).toBe(false);
    expect(result.completed).toBe(true);
  });

  it("stops the sweep before any delete when the host cache trim loses its guard", async () => {
    const seeded = await seedBucket();
    await seedCatalog(seeded);
    const hostId = "host-warm-refused";
    // The document names another host, so the version-guarded write refuses
    // it. Deletion must not proceed against a live cache intent.
    const imageIds = await seedObsoleteWarmIntents({
      hostId,
      hostIdInDoc: "host-somebody-else",
    });
    // The running VM is a root now, so its object must exist for the sweep to
    // reach the trim guard this test is about.
    await env.VM_IMAGE_REGISTRY_BUCKET.put(
      "images/warm-old-scenario-web-x86_64/" + imageIds[0] + ".raw.zst",
      new Uint8Array([31]),
    );
    await enforce();
    const core = createImageRegistryCleanupCore({});

    const result = await core.run(cleanupEnv(), { mode: "delete", nowMs: NOW_MS });

    expect(result.deletedObjects).toBe(0);
    expect(result.error).toContain("desired state identity is invalid");
    expect(await bucketKeys("")).toContain(seeded.orphanManifestKey);
    expect(await gcRuns()).toEqual([
      { state: "failed", deleted_objects: 0, error: result.error },
    ]);
  });


  it("plans the orphans and keeps every referenced object", async () => {
    const seeded = await seedBucket();
    await seedCatalog(seeded);
    await enforce();
    const core = createImageRegistryCleanupCore({});

    const plan = await core.plan(cleanupEnv(), {
      mode: "report-only",
      nowMs: NOW_MS,
    });

    expect(plan.details.faults).toEqual([]);
    expect(plan.details.deleteAllowedByReferences).toBe(true);
    expect(plan.details.retainedManifests).toBe(1);
    expect(plan.details.retainedChunks).toBe(2);
    expect(plan.details.retainedImages).toBe(1);
    expect(plan.details.retainedBootArtifacts).toBe(2);
    const candidateKeys = plan.candidateObjects.map((object) => object.key);
    expect(candidateKeys).toEqual([
      seeded.orphanManifestKey,
      "images/broken-nginx-webserver-x86_64/" + ORPHAN_IMAGE_ID + ".raw.zst",
      "images/broken-nginx-webserver-x86_64/" +
        ORPHAN_IMAGE_ID +
        ".raw.zst.sha256",
      IMAGE_CHUNK_PREFIX + ORPHAN_CHUNK_SHA,
      "artifacts/" + ORPHAN_ARTIFACT_SHA,
    ]);
    // Out-of-scope objects are never candidates and never "unrecognized".
    expect(plan.details.unrecognizedObjects).toBe(0);
    expect(plan.candidateObjects.every((object) =>
      !String(object.key).startsWith("builds/") &&
      !String(object.key).startsWith("guest-tools/"),
    )).toBe(true);
    expect(plan.retainedObjects).toBeGreaterThan(0);
    expect(seeded.manifestKey).toContain(seeded.manifestSha256);
    // A plan mutates nothing and takes no sweep.
    expect(await gcRuns()).toEqual([]);
    expect(await bucketKeys("")).toContain(seeded.manifestKey);
  });

  it("deletes only the orphans, manifest first, in report-free apply mode", async () => {
    const seeded = await seedBucket();
    await seedCatalog(seeded);
    await enforce();
    const core = createImageRegistryCleanupCore({});

    const result = await core.run(cleanupEnv(), {
      mode: "delete",
      nowMs: NOW_MS,
    });

    expect(result.error).toBeNull();
    expect(result.deletedObjects).toBe(5);
    expect(result.failedObjects).toBe(0);
    expect(await gcRuns()).toEqual([
      { state: "completed", deleted_objects: 5, error: null },
    ]);
    expect(result.phases.manifest).toBe(1);
    expect(result.phases.legacy_image).toBe(1);
    expect(result.phases.legacy_sidecar).toBe(1);
    expect(result.phases.chunk).toBe(1);
    expect(result.phases.boot_artifact).toBe(1);
    const keys = await bucketKeys("");
    expect(keys).toContain(IMAGE_CHUNK_PREFIX + RETAINED_CHUNK_ONE);
    expect(keys).toContain(IMAGE_CHUNK_PREFIX + RETAINED_CHUNK_TWO);
    expect(keys).toContain("artifacts/" + KERNEL_SHA);
    expect(keys).toContain("artifacts/" + INITRD_SHA);
    expect(keys).toContain(
      "images/broken-nginx-webserver-x86_64/" + LEGACY_IMAGE_ID + ".raw.zst",
    );
    expect(keys).toContain(
      "images/broken-nginx-webserver-x86_64/" +
        LEGACY_IMAGE_ID +
        ".raw.zst.sha256",
    );
    expect(keys).toContain("builds/bundles/rev-1.tar.gz");
    expect(keys).toContain("guest-tools/scenario/stable.json");
    expect(keys).not.toContain(IMAGE_CHUNK_PREFIX + ORPHAN_CHUNK_SHA);
    expect(keys).not.toContain("artifacts/" + ORPHAN_ARTIFACT_SHA);
    expect(keys).not.toContain(
      "images/broken-nginx-webserver-x86_64/" + ORPHAN_IMAGE_ID + ".raw.zst",
    );
  });

  it("deletes nothing in report-only mode and never touches admission state", async () => {
    const seeded = await seedBucket();
    await seedCatalog(seeded);
    await enforce();
    const core = createImageRegistryCleanupCore({});
    const before = await bucketKeys("");

    const result = await core.run(cleanupEnv(), {
      mode: "report-only",
      nowMs: NOW_MS,
    });

    expect(result.deletedObjects).toBe(0);
    expect(result.wouldDeleteObjects).toBe(5);
    expect(result.error).toBeNull();
    // No sweep row: report-only never touches admission state.
    expect(await gcRuns()).toEqual([]);
    expect(await bucketKeys("")).toEqual(before);
  });

  it("refuses every delete when a retained manifest is missing", async () => {
    const seeded = await seedBucket();
    // The live pointer names a chunk manifest that is not in the bucket.
    await seedCatalog({ ...seeded, manifestSha256: "8".repeat(64) });
    await enforce();
    const core = createImageRegistryCleanupCore({});
    const before = await bucketKeys("");

    const plan = await core.plan(cleanupEnv(), {
      mode: "report-only",
      nowMs: NOW_MS,
    });
    expect(plan.details.faults.map((fault) => fault.code)).toContain(
      "retained_manifest_missing",
    );
    expect(plan.details.deleteAllowedByReferences).toBe(false);

    const result = await core.run(cleanupEnv(), {
      mode: "delete",
      nowMs: NOW_MS,
    });
    expect(result.deletedObjects).toBe(0);
    expect(result.error).toContain("reference verification stopped the sweep");
    expect(await bucketKeys("")).toEqual(before);
  });

  it("refuses to apply while enforcement is report_only", async () => {
    const seeded = await seedBucket();
    await seedCatalog(seeded);
    const core = createImageRegistryCleanupCore({});
    const before = await bucketKeys("");

    const result = await core.run(cleanupEnv(), {
      mode: "delete",
      nowMs: NOW_MS,
    });

    expect(result.deletedObjects).toBe(0);
    expect(result.error).toContain("enforcement is report_only");
    expect(result.resumeRequired).toBe(true);
    expect(await bucketKeys("")).toEqual(before);
  });

  it("stops the sweep when a writer holds the gate instead of routing around it", async () => {
    const seeded = await seedBucket();
    await seedCatalog(seeded);
    await enforce();
    // One open upload session is enough to refuse the exclusive sweep.
    await env.DB.prepare(
      "INSERT INTO image_registry_upload_sessions (id, owner_kind, owner_id, " +
        "epoch, state, intent, created_at, heartbeat_at, expires_at) " +
        "VALUES ('session-1', 'publish_token', 'publish-token', 1, 'open', " +
        "'image_publish', ?1, ?1, ?2)",
    ).bind(NOW_MS, NOW_MS + 60_000).run();
    const core = createImageRegistryCleanupCore({});

    const result = await core.run(cleanupEnv(), {
      mode: "delete",
      nowMs: NOW_MS,
    });

    expect(result.deletedObjects).toBe(0);
    expect(result.error).toContain("registry admission is busy");
    expect(await gcRuns()).toEqual([]);
    const keys = await bucketKeys("");
    expect(keys).toContain(IMAGE_CHUNK_PREFIX + ORPHAN_CHUNK_SHA);
  });

  it("honours maxDeletesPerRun and asks for a resume", async () => {
    const seeded = await seedBucket();
    await seedCatalog(seeded);
    await enforce();
    const core = createImageRegistryCleanupCore({
      batchSize: 2,
      maxDeletesPerRun: 2,
    });

    const result = await core.run(cleanupEnv(), {
      mode: "delete",
      nowMs: NOW_MS,
    });

    expect(result.deletedObjects).toBe(2);
    expect(result.resumeRequired).toBe(true);
    // A partial pass is never reported as complete, and the keys the budget left
    // out were not blocked by the gate: they were never selected.
    expect(result.completed).toBe(false);
    expect(result.blockedObjects).toBe(0);
    expect(result.postState?.unchanged).toBe(true);
    // The unselected orphans are still there for the next attempt.
    const keys = await bucketKeys("");
    expect(keys).toContain("artifacts/" + ORPHAN_ARTIFACT_SHA);
    expect(keys).toContain(IMAGE_CHUNK_PREFIX + ORPHAN_CHUNK_SHA);
  });

  it("stops mid-run without counting unselected keys as blocked", async () => {
    const seeded = await seedBucket();
    await seedCatalog(seeded);
    await enforce();
    // A zero-length lease makes the first heartbeat stale, so the gate refuses
    // the batch: one deterministic mid-run stop with a 5-key worklist.
    const core = createImageRegistryCleanupCore({
      batchSize: 2,
      maxDeletesPerRun: 2,
      leaseMs: 0,
    });

    const result = await core.run(cleanupEnv(), {
      mode: "delete",
      nowMs: NOW_MS,
    });

    // Two selected keys, two blocked keys. The other three candidates are beyond
    // the budget and are not blocked.
    expect(result.blockedObjects).toBe(2);
    expect(result.deletedObjects).toBe(0);
    expect(result.completed).toBe(false);
    expect(result.resumeRequired).toBe(true);
    expect(result.error).toBeTruthy();
  });

  it("selects only what one run may attempt", () => {
    const candidates: ImageRegistryCleanupPlanObject[] = Array.from(
      { length: 5 },
      (_, index) => ({
        key: "image-chunks/v1/zstd6/" + index.toString(16).padStart(64, "0"),
        bytes: 10,
        category: "chunk",
      }),
    );

    const budgeted = planCleanupDeleteSelection({
      candidates,
      batchSize: 2,
      maxDeletes: 2,
      candidateSampleCapped: false,
      faultsPresent: false,
    });
    expect(budgeted.selectedKeyCount).toBe(2);
    expect(budgeted.batches).toHaveLength(1);
    expect(budgeted.resumeRequired).toBe(true);

    const full = planCleanupDeleteSelection({
      candidates,
      batchSize: 2,
      maxDeletes: 100,
      candidateSampleCapped: false,
      faultsPresent: false,
    });
    expect(full.selectedKeyCount).toBe(5);
    expect(full.resumeRequired).toBe(false);

    // A capped worklist always needs a resume, however few keys are visible.
    expect(
      planCleanupDeleteSelection({
        candidates,
        batchSize: 2,
        maxDeletes: 100,
        candidateSampleCapped: true,
        faultsPresent: false,
      }).resumeRequired,
    ).toBe(true);
  });

  it("deletes in bounded bulk calls instead of one call per key", async () => {
    const seeded = await seedBucket();
    await seedCatalog(seeded);
    await enforce();
    const calls: number[] = [];
    const realBucket = env.VM_IMAGE_REGISTRY_BUCKET;
    const countingBucket: R2Bucket = {
      list: (options?: R2ListOptions) => realBucket.list(options),
      get: (key: string, options?: R2GetOptions) =>
        realBucket.get(key, options),
      head: (key: string) => realBucket.head(key),
      delete: async (keys: string | string[]) => {
        calls.push(Array.isArray(keys) ? keys.length : 1);
        return realBucket.delete(keys);
      },
    } as unknown as R2Bucket;
    const core = createImageRegistryCleanupCore({ batchSize: 2 });

    const result = await core.run(
      { DB: env.DB, VM_IMAGE_REGISTRY_BUCKET: countingBucket },
      { mode: "delete", nowMs: NOW_MS },
    );

    // Three batches of at most two keys, never five single-key calls.
    expect(calls).toEqual([2, 2, 1]);
    expect(result.deletedObjects).toBe(5);
    expect(result.completed).toBe(true);
  });

  it("proves the delete set with a digest and an object re-read", async () => {
    const seeded = await seedBucket();
    await seedCatalog(seeded);
    await enforce();
    const core = createImageRegistryCleanupCore({});
    const before = await core.plan(cleanupEnv(), {
      mode: "report-only",
      nowMs: NOW_MS,
    });

    const result = await core.run(cleanupEnv(), {
      mode: "delete",
      nowMs: NOW_MS,
    });

    // The planned worklist and the deleted set are the same set, proved by the
    // digest rather than by trusting the delete calls.
    expect(result.deletedKeysDigest).toBe(
      await keysetDigest(before.candidateObjects),
    );
    expect(result.deletedKeysDigest).toBe(
      await keysetDigest(
        before.candidateObjects.filter((object) =>
          result.deletedKeys.includes(String(object.key)),
        ),
      ),
    );
    expect(result.deletedKeys).toHaveLength(5);
    expect(result.deletedKeysTruncated).toBe(false);
    expect(result.verifiedDeletedObjects).toBe(5);
    expect(result.unverifiedObjects).toBe(0);
    expect(result.unverifiedKeys).toEqual([]);
    expect(result.verifiedDeletedBytes).toBe(result.deletedBytes);
    expect(result.completed).toBe(true);
    expect(result.blockedObjects).toBe(0);
    expect(result.postState?.unchanged).toBe(true);
    expect(result.postState?.scanned.objects).toBe(
      before.details.keysets.scanned.objects - 5,
    );
    expect(result.postState?.scanned.bytes).toBe(
      before.details.keysets.scanned.bytes - result.verifiedDeletedBytes,
    );
    // The run reports its own plan, so the collector need not list again.
    expect(result.planSummary?.objectsScanned).toBe(before.objectsScanned);

    // A second scan proves the end state: nothing left to delete, and the
    // retained key set is byte-identical to the one the run started from.
    const after = await core.plan(cleanupEnv(), {
      mode: "report-only",
      nowMs: NOW_MS + 1_000,
    });
    expect(after.details.candidateTotal).toBe(0);
    expect(after.details.keysets.retained.digest).toBe(
      before.details.keysets.retained.digest,
    );
    expect(after.details.keysets.retained.objects).toBe(
      before.details.keysets.retained.objects,
    );
    expect(after.details.keysets.retained.bytes).toBe(
      before.details.keysets.retained.bytes,
    );
    expect(after.details.deleteAllowedByReferences).toBe(true);
  });

  it("reports one keyset digest for one unchanged bucket", async () => {
    const seeded = await seedBucket();
    await seedCatalog(seeded);
    await enforce();
    const core = createImageRegistryCleanupCore({});

    const first = await core.plan(cleanupEnv(), {
      mode: "report-only",
      nowMs: NOW_MS,
    });
    const second = await core.plan(cleanupEnv(), {
      mode: "report-only",
      nowMs: NOW_MS + 60_000,
    });

    expect(second.details.keysets.scanned).toEqual(first.details.keysets.scanned);
    expect(second.details.keysets.retained).toEqual(
      first.details.keysets.retained,
    );
    expect(second.details.keysets.candidates).toEqual(
      first.details.keysets.candidates,
    );
    expect(first.details.keysets.scanned.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps a legacy object whose digest is still retained", async () => {

    const seeded = await seedBucket();
    // The same digest under an image key the catalog no longer names.
    await env.VM_IMAGE_REGISTRY_BUCKET.put(
      "images/" + ORPHAN_SCENARIO + "-old-vm-x86_64/" +
        LEGACY_IMAGE_ID +
        ".raw.zst",
      new Uint8Array([17]),
    );
    await seedCatalog(seeded);
    const core = createImageRegistryCleanupCore({});

    const plan = await core.plan(cleanupEnv(), {
      mode: "report-only",
      nowMs: NOW_MS,
    });

    expect(plan.details.retainedByDigestOnly).toBe(1);
    expect(
      plan.candidateObjects.map((object) => object.key),
    ).not.toContain(
      "images/" + ORPHAN_SCENARIO + "-old-vm-x86_64/" +
        LEGACY_IMAGE_ID +
        ".raw.zst",
    );
  });

  /**
   * A retained manifest is the only record of which chunks exist, so a body that
   * fails the real validator must stop the sweep. Each case stores bytes whose
   * hash still matches the reference, so the fault can only come from the
   * manifest rule and not from the body hash.
   */
  async function seedCorruptedManifest(
    mutate: (manifest: Record<string, unknown>) => void,
  ): Promise<{ manifestSha256: string; imageId: string }> {
    const canonical = await canonicalImageChunkManifest({
      virtualSizeBytes: 2 * CHUNK_SIZE_BYTES,
      chunkRawSha256s: [RETAINED_CHUNK_ONE, RETAINED_CHUNK_TWO],
    });
    const trueImageId = canonical.image_id;
    const mutated = JSON.parse(JSON.stringify(canonical)) as Record<
      string,
      unknown
    >;
    mutate(mutated);
    const bytes = new TextEncoder().encode(JSON.stringify(mutated));
    const manifestSha256 = await sha256Hex(bytes.buffer as ArrayBuffer);
    await env.VM_IMAGE_REGISTRY_BUCKET.put(
      IMAGE_MANIFEST_PREFIX + manifestSha256 + ".json",
      bytes,
    );
    // The pointer row keeps the manifest's true identity: only the object is bad.
    return { manifestSha256, imageId: trueImageId };
  }

  it("refuses to delete when a retained manifest declares another schema version", async () => {
    const seeded = await seedBucket();
    const corrupted = await seedCorruptedManifest((manifest) => {
      manifest.schema_version = 2;
    });
    await seedCatalog({
      ...seeded,
      manifestSha256: corrupted.manifestSha256,
      imageId: corrupted.imageId,
    });
    await enforce();
    const core = createImageRegistryCleanupCore({});
    const before = await bucketKeys("");

    const plan = await core.plan(cleanupEnv(), {
      mode: "report-only",
      nowMs: NOW_MS,
    });
    expect(plan.details.faults.map((fault) => fault.code)).toContain(
      "retained_manifest_invalid",
    );
    expect(plan.details.deleteAllowedByReferences).toBe(false);

    const result = await core.run(cleanupEnv(), {
      mode: "delete",
      nowMs: NOW_MS,
    });
    expect(result.deletedObjects).toBe(0);
    expect(result.completed).toBe(false);
    expect(await bucketKeys("")).toEqual(before);
  });

  it("refuses to delete when a retained manifest lists chunks out of order", async () => {
    const seeded = await seedBucket();
    const corrupted = await seedCorruptedManifest((manifest) => {
      const chunks = manifest.chunks as Array<Record<string, unknown>>;
      manifest.chunks = [chunks[1], chunks[0]];
    });
    await seedCatalog({
      ...seeded,
      manifestSha256: corrupted.manifestSha256,
      imageId: corrupted.imageId,
    });
    await enforce();
    const core = createImageRegistryCleanupCore({});
    const before = await bucketKeys("");

    const plan = await core.plan(cleanupEnv(), {
      mode: "report-only",
      nowMs: NOW_MS,
    });
    expect(plan.details.faults.map((fault) => fault.code)).toContain(
      "retained_manifest_invalid",
    );

    const result = await core.run(cleanupEnv(), {
      mode: "delete",
      nowMs: NOW_MS,
    });
    expect(result.deletedObjects).toBe(0);
    expect(await bucketKeys("")).toEqual(before);
  });

  it("refuses to delete when a retained manifest image id does not match its chunks", async () => {
    const seeded = await seedBucket();
    const corrupted = await seedCorruptedManifest((manifest) => {
      // A plausible-looking id that is not the Merkle digest of these chunks.
      manifest.image_id = "9".repeat(64);
    });
    await seedCatalog({
      ...seeded,
      manifestSha256: corrupted.manifestSha256,
      imageId: corrupted.imageId,
    });
    await enforce();
    const core = createImageRegistryCleanupCore({});
    const before = await bucketKeys("");

    const plan = await core.plan(cleanupEnv(), {
      mode: "report-only",
      nowMs: NOW_MS,
    });
    expect(plan.details.faults.map((fault) => fault.code)).toContain(
      "retained_manifest_invalid",
    );
    expect(plan.details.faults[0]?.detail).toContain(
      "image_id does not match ordered raw chunks",
    );

    const result = await core.run(cleanupEnv(), {
      mode: "delete",
      nowMs: NOW_MS,
    });
    expect(result.deletedObjects).toBe(0);
    expect(await bucketKeys("")).toEqual(before);
  });

  it("accepts a valid sparse manifest and pins no chunk for it", async () => {
    const seeded = await seedBucket();
    // One full chunk of virtual size, represented entirely as a zero hole.
    const sparse = await canonicalImageChunkManifest({
      virtualSizeBytes: CHUNK_SIZE_BYTES,
      chunkRawSha256s: [],
    });
    const sparseBytes = new TextEncoder().encode(JSON.stringify(sparse));
    const sparseSha256 = await sha256Hex(sparseBytes.buffer as ArrayBuffer);
    await env.VM_IMAGE_REGISTRY_BUCKET.put(
      IMAGE_MANIFEST_PREFIX + sparseSha256 + ".json",
      sparseBytes,
    );
    await seedCatalog({
      ...seeded,
      manifestSha256: sparseSha256,
      imageId: sparse.image_id,
      virtualSizeBytes: CHUNK_SIZE_BYTES,
    });

    // The manifest itself is valid, so it is a real reference: the seeded chunked
    // image is now unreferenced and nothing faults.
    const validated = await validateImageChunkManifest(
      JSON.parse(new TextDecoder().decode(sparseBytes)),
    );
    expect(validated.ok).toBe(true);
    const core = createImageRegistryCleanupCore({});
    const plan = await core.plan(cleanupEnv(), {
      mode: "report-only",
      nowMs: NOW_MS,
    });
    expect(
      plan.details.faults.filter(
        (fault) => fault.code === "retained_manifest_invalid",
      ),
    ).toEqual([]);
    // A manifest of zero chunks pins no chunk object, and the boot artifacts it
    // does declare are still retained.
    expect(plan.details.retainedChunks).toBe(0);
    expect(plan.details.retainedBootArtifacts).toBe(2);
    expect(
      plan.candidateObjects.map((object) => object.key),
    ).toContain(seeded.manifestKey);
  });

  /**
   * The post-delete proof must compare keys, not volumes. One key of the same
   * size can replace another without moving the object count or the byte total,
   * so a count-and-bytes comparison would call that a clean sweep.
   */
  it("withholds completion when a key is replaced by another of the same size", async () => {
    const seeded = await seedBucket();
    await seedCatalog(seeded);
    await enforce();
    // A same-size stand-in for the retained chunk, injected during the run.
    const substituteKey = IMAGE_CHUNK_PREFIX + "A".repeat(64).toLowerCase();
    const retainedChunkKey = IMAGE_CHUNK_PREFIX + RETAINED_CHUNK_ONE;
    let mutated = false;
    const realBucket = env.VM_IMAGE_REGISTRY_BUCKET;
    const mutatingBucket: R2Bucket = {
      list: (options?: R2ListOptions) => realBucket.list(options),
      get: (key: string, options?: R2GetOptions) =>
        realBucket.get(key, options),
      head: (key: string) => realBucket.head(key),
      delete: async (keys: string | string[]) => {
        await realBucket.delete(keys);
        if (mutated) return;
        mutated = true;
        // Swap one retained key for a different key of exactly the same size.
        const retained = await realBucket.head(retainedChunkKey);
        await realBucket.delete(retainedChunkKey);
        await realBucket.put(
          substituteKey,
          new Uint8Array(retained?.size ?? 0),
        );
      },
    } as unknown as R2Bucket;
    const core = createImageRegistryCleanupCore({});

    const result = await core.run(
      { DB: env.DB, VM_IMAGE_REGISTRY_BUCKET: mutatingBucket },
      { mode: "delete", nowMs: NOW_MS },
    );

    expect(mutated).toBe(true);
    // Counts and bytes alone would agree here; the keysets do not.
    expect(result.postState?.scanned.objects).toBe(
      result.postState?.expected.objects,
    );
    expect(result.postState?.scanned.bytes).toBe(
      result.postState?.expected.bytes,
    );
    expect(result.postState?.scanned.digest).not.toBe(
      result.postState?.expected.digest,
    );
    expect(result.postState?.unchanged).toBe(false);
    expect(result.completed).toBe(false);
    expect(result.error).toContain("the bucket changed during the sweep");
  });

  /**
   * A manifest is the record of which chunks exist. If its delete fails, the
   * chunks must not be touched, so the sweep stops at that batch instead of
   * walking on to the chunk phase.
   */
  it("stops at a failed manifest delete instead of reaching the chunk phase", async () => {
    const seeded = await seedBucket();
    await seedCatalog(seeded);
    await enforce();
    const attempted: string[][] = [];
    const realBucket = env.VM_IMAGE_REGISTRY_BUCKET;
    const failingBucket: R2Bucket = {
      list: (options?: R2ListOptions) => realBucket.list(options),
      get: (key: string, options?: R2GetOptions) =>
        realBucket.get(key, options),
      head: (key: string) => realBucket.head(key),
      delete: async (keys: string | string[]) => {
        attempted.push(Array.isArray(keys) ? keys : [keys]);
        // Manifest-first order: the first attempt is the orphan manifest.
        throw new Error("simulated R2 delete failure");
      },
    } as unknown as R2Bucket;
    const core = createImageRegistryCleanupCore({ batchSize: 1 });

    const result = await core.run(
      { DB: env.DB, VM_IMAGE_REGISTRY_BUCKET: failingBucket },
      { mode: "delete", nowMs: NOW_MS },
    );

    // Exactly one attempt, and it was the manifest.
    expect(attempted).toEqual([[seeded.orphanManifestKey]]);
    expect(result.failedObjects).toBe(1);
    expect(result.completed).toBe(false);
    expect(result.error).toContain("bulk delete failed");
    // No chunk delete was attempted, and the orphan chunk is intact.
    expect(
      attempted.some((keys) =>
        keys.some((key) => key.startsWith(IMAGE_CHUNK_PREFIX)),
      ),
    ).toBe(false);
    expect(await bucketKeys(IMAGE_CHUNK_PREFIX)).toContain(
      IMAGE_CHUNK_PREFIX + ORPHAN_CHUNK_SHA,
    );
  });
});
