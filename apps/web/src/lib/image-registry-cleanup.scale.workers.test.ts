/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import { vmScenarioVms, vmScenarios } from "@/db/schema";
import { sha256Hex } from "@/control-plane/image-registry/shared";
import { canonicalImageChunkManifest } from "@/control-plane/image-registry/chunks";
import { setRegistryEnforcement } from "@/lib/image-registry-admission";
import {
  createImageRegistryCleanupCore,
  type ImageRegistryCleanupEnv,
} from "@/lib/image-registry-cleanup";
import { resetD1Database } from "@/test/d1-migrations";

/**
 * Scale proofs for the planner and the applier at the production shape: about
 * 125 GiB across about 95,000 recognized objects, here 100,000 objects behind an
 * in-memory bucket. No real R2 write happens; D1 is the real migrated database
 * and enforcement is real, so the apply path runs its true admission, delete,
 * and verification sequence.
 *
 * The applier test also holds the whole initial inventory and the whole
 * post-scan inventory at once, which is the peak memory the production run will
 * meet before it touches the real 125 GB bucket.
 */

const TOTAL_OBJECTS = 100_000;
const LEGACY_OBJECTS = 60_000;
const CHUNK_OBJECTS = 30_000;
const ARTIFACT_OBJECTS = 10_000;
/** ~125 GiB across the recognized objects. */
const TARGET_BYTES = 125 * 1024 ** 3;
const LEGACY_BYTES = 1024 ** 2;

const CHUNK_PREFIX = "image-chunks/v1/zstd6/";
const MANIFEST_PREFIX = "image-manifests/v1/";
const ARTIFACT_PREFIX = "artifacts/";

const RETAINED_SCENARIO = "scale-scenario";

function digestFor(index: number): string {
  return index.toString(16).padStart(64, "0");
}

interface SyntheticObject {
  key: string;
  size: number;
  body?: Uint8Array;
}

/**
 * The one retained reference: a catalog row whose manifest, chunk, kernel, and
 * initrd must all survive. It exercises the retained-object verification, which
 * reads and hashes the manifest body.
 */
interface RetainedReference {
  manifestKey: string;
  manifestSha256: string;
  /** The identity the canonical manifest declares; the pointer row names it. */
  imageId: string;
  chunkKey: string;
  chunkSha256: string;
  kernelSha256: string;
  initrdSha256: string;
}

async function retainedReference(): Promise<{
  ref: RetainedReference;
  manifestBody: Uint8Array;
  chunkBody: Uint8Array;
}> {
  const chunkSha256 = "e".repeat(64);
  // The shared canonical builder derives a real image_id, so the scale fixture
  // retains a manifest the production validator accepts.
  const manifest = await canonicalImageChunkManifest({
    virtualSizeBytes: 4_194_304,
    chunkRawSha256s: [chunkSha256],
  });
  const manifestBody = new TextEncoder().encode(
    JSON.stringify(manifest),
  );
  const manifestSha256 = await sha256Hex(manifestBody.buffer as ArrayBuffer);
  return {
    ref: {
      manifestKey: MANIFEST_PREFIX + manifestSha256 + ".json",
      manifestSha256,
      imageId: manifest.image_id,
      chunkKey: CHUNK_PREFIX + chunkSha256,
      chunkSha256,
      kernelSha256: "a".repeat(64),
      initrdSha256: "b".repeat(64),
    },
    manifestBody,
    chunkBody: new Uint8Array([1, 2, 3]),
  };
}

/**
 * A byte distribution that sums to TARGET_BYTES: every legacy object carries the
 * same size, and the first object absorbs the remainder so the total is exact.
 *
 * With a retained reference the object count stays exact: one chunk and two
 * artifacts become the retained ones and one artifact slot becomes the manifest.
 */
function buildSyntheticObjects(input: {
  ref: RetainedReference | null;
  manifestBody?: Uint8Array;
  chunkBody?: Uint8Array;
}): SyntheticObject[] {
  const legacyChunkBytes =
    (TARGET_BYTES - LEGACY_OBJECTS * LEGACY_BYTES) /
    (CHUNK_OBJECTS + ARTIFACT_OBJECTS);
  const base = Math.floor(legacyChunkBytes);
  const objects: SyntheticObject[] = [];
  for (let index = 0; index < LEGACY_OBJECTS; index += 1) {
    objects.push({
      key:
        "images/scenario-" +
        (index % 500) +
        "-vm-" +
        (index % 3) +
        "-x86_64/" +
        digestFor(index) +
        ".raw.zst",
      size:
        index === 0
          ? LEGACY_BYTES +
            (TARGET_BYTES -
              LEGACY_OBJECTS * LEGACY_BYTES -
              base * (CHUNK_OBJECTS + ARTIFACT_OBJECTS))
          : LEGACY_BYTES,
    });
  }
  for (let index = 0; index < CHUNK_OBJECTS; index += 1) {
    const retained = input.ref !== null && index === 0;
    objects.push({
      key: retained
        ? input.ref!.chunkKey
        : CHUNK_PREFIX + digestFor(LEGACY_OBJECTS + index),
      size: retained ? (input.chunkBody?.byteLength ?? 1) : base,
      ...(retained && input.chunkBody ? { body: input.chunkBody } : {}),
    });
  }
  const artifactCount = input.ref ? ARTIFACT_OBJECTS - 1 : ARTIFACT_OBJECTS;
  for (let index = 0; index < artifactCount; index += 1) {
    const retained =
      input.ref !== null && (index === 0 || index === 1);
    objects.push({
      key: retained
        ? ARTIFACT_PREFIX +
          (index === 0 ? input.ref!.kernelSha256 : input.ref!.initrdSha256)
        : ARTIFACT_PREFIX +
          digestFor(LEGACY_OBJECTS + CHUNK_OBJECTS + index),
      size: retained ? 8 : base,
      ...(retained ? { body: new Uint8Array([7]) } : {}),
    });
  }
  if (input.ref && input.manifestBody) {
    objects.push({
      key: input.ref.manifestKey,
      size: input.manifestBody.byteLength,
      body: input.manifestBody,
    });
  }
  // R2 lists in key order, so a page boundary falls inside every prefix.
  return objects.sort((left, right) => compareKeys(left.key, right.key));
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The smallest faithful R2 surface: a paginated listing over a live key set, plus
 * get, head, and a bulk delete that mutates the same set. Nothing leaves memory.
 */
class FakeRegistryBucket {
  readonly objects = new Map<string, { size: number; body?: Uint8Array }>();
  listCalls = 0;
  getCalls = 0;
  headCalls = 0;
  readonly deleteCalls: number[] = [];
  private keys: string[] = [];

  constructor(entries: SyntheticObject[]) {
    for (const entry of entries) {
      this.objects.set(entry.key, {
        size: entry.size,
        ...(entry.body ? { body: entry.body } : {}),
      });
    }
    this.keys = [...this.objects.keys()].sort(compareKeys);
  }

  async list(options?: R2ListOptions): Promise<R2Objects> {
    this.listCalls += 1;
    const limit = options?.limit ?? 1_000;
    const start = options?.cursor ? Number(options.cursor) : 0;
    const page = this.keys.slice(start, start + limit);
    const next = start + page.length;
    const truncated = next < this.keys.length;
    return {
      objects: page.map((key) => ({
        key,
        size: this.objects.get(key)?.size ?? 0,
        etag: "synthetic",
        uploaded: new Date(0),
      })),
      truncated,
      ...(truncated ? { cursor: String(next) } : {}),
    } as unknown as R2Objects;
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    this.getCalls += 1;
    const entry = this.objects.get(key);
    if (!entry) return null;
    return {
      key,
      size: entry.size,
      arrayBuffer: async () =>
        (entry.body ?? new Uint8Array(0)).buffer as ArrayBuffer,
    } as unknown as R2ObjectBody;
  }

  async head(key: string): Promise<R2Object | null> {
    this.headCalls += 1;
    const entry = this.objects.get(key);
    return entry
      ? ({ key, size: entry.size } as unknown as R2Object)
      : null;
  }

  async delete(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    this.deleteCalls.push(list.length);
    for (const key of list) this.objects.delete(key);
    this.keys = [...this.objects.keys()].sort(compareKeys);
  }
}

function bucketOf(bucket: FakeRegistryBucket): R2Bucket {
  return bucket as unknown as R2Bucket;
}

function cleanupEnvOf(bucket: FakeRegistryBucket): ImageRegistryCleanupEnv {
  return {
    DB: env.DB,
    VM_IMAGE_REGISTRY_BUCKET: bucketOf(bucket),
  };
}

/** Seeds the catalog row the retained reference belongs to. */
async function seedRetainedReference(ref: RetainedReference): Promise<void> {
  const db = drizzle(env.DB);
  const now = 1_700_000_000_000;
  await db.insert(vmScenarios).values({
    scenarioId: RETAINED_SCENARIO,
    title: "Scale scenario",
    description: "Scale fixture.",
    difficulty: "easy",
    estimatedMinutes: 1,
    tagsJson: [],
    briefingMarkdown: "Scale.",
    solutionMarkdown: "Scale.",
    hintsJson: [],
    enabled: true,
    enabledAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(vmScenarioVms).values({
    id: "scale-vm",
    scenarioId: RETAINED_SCENARIO,
    ordinal: 0,
    vmName: "server",
    image: "chunked",
    imageKeyJson: {
      scenario: RETAINED_SCENARIO,
      vm: "server",
      arch: "x86_64",
    },
    imageSha256: ref.imageId,
    imageFormat: "raw_chunks_v1",
    imageVirtualSizeBytes: 4_194_304,
    chunkManifestSha256: ref.manifestSha256,
    guestBootstrapAbi: 2,
    kernelSha256: ref.kernelSha256,
    initrdSha256: ref.initrdSha256,
    bootCmdline: "root=/dev/vda rw",
    cpuMillis: 125,
    vcpuCount: 1,
    memoryMib: 512,
    diskMib: 4_096,
  });
}

describe("image registry cleanup core at production scale", () => {
  it("scans 100k objects across paginated pages inside one invocation", async () => {
    await resetD1Database();
    const objects = buildSyntheticObjects({ ref: null });
    expect(objects).toHaveLength(TOTAL_OBJECTS);
    const totalBytes = objects.reduce((sum, object) => sum + object.size, 0);
    expect(totalBytes).toBe(TARGET_BYTES);

    const bucket = new FakeRegistryBucket(objects);
    const core = createImageRegistryCleanupCore({});
    const startedAtMs = Date.now();
    const plan = await core.plan(cleanupEnvOf(bucket), {
      mode: "report-only",
      nowMs: 1_700_000_000_000,
    });
    const elapsedMs = Date.now() - startedAtMs;

    // Every page was read, and the listing reached the last one.
    expect(bucket.listCalls).toBe(Math.ceil(TOTAL_OBJECTS / 1_000));
    expect(plan.truncated).toBe(false);
    expect(plan.objectsScanned).toBe(TOTAL_OBJECTS);
    expect(plan.details.faults).toEqual([]);

    // Nothing is retained in an empty catalog, so the whole bucket is the worklist.
    expect(plan.details.keysets.scanned.objects).toBe(TOTAL_OBJECTS);
    expect(plan.details.keysets.scanned.bytes).toBe(TARGET_BYTES);
    expect(plan.details.keysets.retained.objects).toBe(0);
    expect(plan.details.keysets.candidates.objects).toBe(TOTAL_OBJECTS);
    expect(plan.details.keysets.candidates.bytes).toBe(TARGET_BYTES);
    expect(plan.details.candidateTotal).toBe(TOTAL_OBJECTS);

    // The worklist is bounded and the digest still covers all 100k keys.
    expect(plan.candidateObjects).toHaveLength(5_000);
    expect(plan.details.candidateSampleCapped).toBe(true);
    expect(plan.details.keysets.candidates.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.details.candidatesByCategory.chunk?.objects).toBe(
      CHUNK_OBJECTS,
    );
    expect(plan.details.candidatesByCategory.legacy_image?.objects).toBe(
      LEGACY_OBJECTS,
    );
    expect(plan.details.candidatesByCategory.boot_artifact?.objects).toBe(
      ARTIFACT_OBJECTS,
    );

    // A full scan plus three keyset digests stays far inside one Worker request.
    expect(elapsedMs).toBeLessThan(30_000);
  }, 120_000);

  it("reports one unchanged keyset digest across repeated scans", async () => {
    await resetD1Database();
    const objects = buildSyntheticObjects({ ref: null });
    const first = createImageRegistryCleanupCore({});
    const second = createImageRegistryCleanupCore({});
    const planFor = (core: ReturnType<typeof createImageRegistryCleanupCore>) =>
      core.plan(cleanupEnvOf(new FakeRegistryBucket(objects)), {
        mode: "report-only",
        nowMs: 1_700_000_000_000,
      });

    const [left, right] = await Promise.all([planFor(first), planFor(second)]);

    // The digest is a property of the bucket, not of the scan: a later run can
    // compare its baseline with this one byte for byte.
    expect(right.details.keysets.scanned).toEqual(left.details.keysets.scanned);
    expect(right.details.keysets.candidates).toEqual(
      left.details.keysets.candidates,
    );
  }, 120_000);

  it("applies a bounded pass, proves the delete set, and resumes consistently", async () => {
    await resetD1Database();
    await setRegistryEnforcement(env, "enforce");
    const { ref, manifestBody, chunkBody } = await retainedReference();
    await seedRetainedReference(ref);
    const objects = buildSyntheticObjects({ ref, manifestBody, chunkBody });
    expect(objects).toHaveLength(TOTAL_OBJECTS);
    const scannedBytes = objects.reduce((sum, object) => sum + object.size, 0);
    const retainedCount = 4;

    const bucket = new FakeRegistryBucket(objects);
    const core = createImageRegistryCleanupCore({
      batchSize: 100,
      maxDeletesPerRun: 200,
    });
    const baseline = await core.plan(cleanupEnvOf(bucket), {
      mode: "report-only",
      nowMs: 1_700_000_000_000,
    });
    expect(baseline.details.keysets.retained.objects).toBe(retainedCount);
    expect(bucket.listCalls).toBe(100);

    const result = await core.run(cleanupEnvOf(bucket), {
      mode: "delete",
      nowMs: 1_700_000_000_000,
    });

    // The run listed a fresh plan (100 pages) and re-listed the end state (100).
    expect(bucket.listCalls).toBe(300);
    // Verification is a listing pass, not one head call per key.
    expect(bucket.headCalls).toBe(0);
    // One bounded bulk delete per batch, never a call per key.
    expect(bucket.deleteCalls).toEqual([100, 100]);
    expect(bucket.deleteCalls.every((count) => count <= 1_000)).toBe(true);

    // A capped worklist under a small budget is real progress, not completion.
    expect(result.completed).toBe(false);
    expect(result.resumeRequired).toBe(true);
    expect(result.error).toBeNull();
    expect(result.blockedObjects).toBe(0);
    expect(result.failedObjects).toBe(0);
    expect(result.wouldDeleteObjects).toBe(TOTAL_OBJECTS - retainedCount);

    // Claimed against proven: every delete was re-read and found absent.
    expect(result.deletedObjects).toBe(200);
    expect(result.verifiedDeletedObjects).toBe(200);
    expect(result.verifiedDeletedBytes).toBe(result.deletedBytes);
    expect(result.unverifiedObjects).toBe(0);
    expect(result.deletedKeys).toHaveLength(200);
    expect(result.deletedKeysTruncated).toBe(false);
    expect(result.deletedKeysDigest).toMatch(/^[a-f0-9]{64}$/);

    // The post-scan proves the end state: scanned minus the verified deletes.
    expect(result.postState?.unchanged).toBe(true);
    // The proof is the keyset digest, not the count or the byte total: the run
    // recomputes the expected keyset from its own baseline minus the keys it
    // verified absent, and the post-scan must match it key for key.
    expect(result.postState?.scanned.digest).toBe(
      result.postState?.expected.digest,
    );
    expect(result.postState?.expected.objects).toBe(TOTAL_OBJECTS - 200);
    expect(result.postState?.expected.bytes).toBe(
      scannedBytes - result.verifiedDeletedBytes,
    );
    expect(result.postState?.scanned.objects).toBe(TOTAL_OBJECTS - 200);
    expect(result.postState?.scanned.bytes).toBe(
      scannedBytes - result.verifiedDeletedBytes,
    );
    expect(bucket.objects.size).toBe(TOTAL_OBJECTS - 200);

    // The run carries its own plan, so the collector need not list a third time.
    expect(result.planSummary?.objectsScanned).toBe(TOTAL_OBJECTS);
    expect(result.planSummary?.candidateTotal).toBe(
      TOTAL_OBJECTS - retainedCount,
    );

    // Every deleted key is gone, and every retained key is untouched.
    for (const key of result.deletedKeys) {
      expect(bucket.objects.has(key)).toBe(false);
    }
    for (const key of [
      ref.manifestKey,
      ref.chunkKey,
      ARTIFACT_PREFIX + ref.kernelSha256,
      ARTIFACT_PREFIX + ref.initrdSha256,
    ]) {
      expect(bucket.objects.has(key)).toBe(true);
    }

    // The next pass agrees with the previous one: same retained set, one smaller
    // scanned set, and a different worklist because the deleted keys are gone.
    const next = await core.plan(cleanupEnvOf(bucket), {
      mode: "report-only",
      nowMs: 1_700_000_000_000 + 60_000,
    });
    expect(bucket.listCalls).toBe(400);
    expect(next.details.faults).toEqual([]);
    expect(next.details.keysets.retained.digest).toBe(
      baseline.details.keysets.retained.digest,
    );
    expect(next.details.keysets.retained.objects).toBe(retainedCount);
    expect(next.details.keysets.scanned.objects).toBe(TOTAL_OBJECTS - 200);
    expect(next.details.keysets.scanned.bytes).toBe(
      scannedBytes - result.verifiedDeletedBytes,
    );
    expect(next.details.keysets.candidates.objects).toBe(
      TOTAL_OBJECTS - 200 - retainedCount,
    );
    expect(next.details.keysets.candidates.digest).not.toBe(
      baseline.details.keysets.candidates.digest,
    );
  }, 180_000);
});
