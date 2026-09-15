/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { handleCandidateCatalogPromotion } from "@/control-plane/image-registry/catalog-promotion";
import { handleImageRegistryRequest } from "@/control-plane/image-registry";
import {
  imageBuildBundles,
  imageBuilds,
  runtimeOperationGates,
  scenarioCatalogCandidates,
  scenarioCatalogSnapshots,
  vmScenarioVms,
  vmScenarios,
} from "@/db/schema";
import type { ScenarioManifestV5 } from "@/generated/catalog";
import { IMAGE_BUILD_FORMAT_VERSION } from "@/lib/image-build-format";
import { withImageBuildCoordinationLock } from "@/lib/image-build-lock";
import {
  acquireRegistrySweep,
  completeRegistryUploadSession,
  createRegistryUploadSession,
  finishRegistrySweep,
} from "@/lib/image-registry-admission";
import { createImageRegistryCleanupCore } from "@/lib/image-registry-cleanup";
import { IMAGE_CUTOVER_GATE } from "@/lib/run-admission-gate";
import { resetD1Database } from "@/test/d1-migrations";
import {
  enableRegistryDeletion,
  seedChunkedImage,
  seedLegacyImage,
  type SeededChunkedImage,
} from "./registry-artifact-fixtures";
import { createCleanupServiceDouble } from "./cleanup-service-double";

/**
 * Interleaving of a candidate promotion with the collector and with a direct
 * live publish.
 *
 * The promotion admits its registry writer BEFORE its first source read and
 * holds the same per-family locks a live publish takes, so:
 *   - a sweep cannot retire the candidate source while the promotion is
 *     deciding what to install, and
 *   - a live publish cannot replace the catalog between that read and the
 *     commit.
 */

const SCENARIO_ID = "broken-nginx";
const ARCH = "x86_64" as const;
const REVISION = "revision-1";
const CONTENT_HASH = "a".repeat(64);
const PREVIOUS_IMAGE = "b".repeat(64);

function manifestFor(image: SeededChunkedImage): ScenarioManifestV5 {
  return {
    schema_version: 5,
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
        image_key: { scenario: SCENARIO_ID, vm: "web", arch: ARCH },
        image_id: image.imageId,
        image_format: "raw_chunks_v1",
        image_virtual_size_bytes: image.virtualSizeBytes,
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
  } as ScenarioManifestV5;
}

let candidateImage: SeededChunkedImage;

async function seedCandidate(): Promise<void> {
  const db = drizzle(env.DB);
  await enableRegistryDeletion(env.DB);
  candidateImage = await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, {
    label: "candidate",
  });
  await seedLegacyImage(env.VM_IMAGE_REGISTRY_BUCKET, {
    scenario: SCENARIO_ID,
    vm: "web",
    arch: ARCH,
    sha256: PREVIOUS_IMAGE,
  });
  // The live row the promotion replaces names its boot artifacts, and the
  // sweep verifies every retained object before it deletes anything.
  for (const sha256 of ["1".repeat(64), "2".repeat(64)]) {
    await env.VM_IMAGE_REGISTRY_BUCKET.put(
      "artifacts/" + sha256,
      new Uint8Array([1]),
    );
  }
  await db.insert(imageBuildBundles).values({
    rev: REVISION,
    r2Key: "builds/bundles/" + REVISION + ".tar.gz",
    metaJson: {
      buildFormatVersion: IMAGE_BUILD_FORMAT_VERSION,
      catalogChannel: "candidate",
      scenarios: [
        { scenarioId: SCENARIO_ID, arch: ARCH, contentHash: CONTENT_HASH },
      ],
    },
  });
  await db.insert(runtimeOperationGates).values({
    key: IMAGE_CUTOVER_GATE,
    state: "drained",
  });
  await db.insert(imageBuilds).values({
    id: "build-1",
    scenarioId: SCENARIO_ID,
    arch: ARCH,
    rev: REVISION,
    contentHash: CONTENT_HASH,
    catalogChannel: "candidate",
    status: "succeeded",
    phase: "succeeded",
    publishedManifestJson: manifestFor(candidateImage),
  });
  await db.insert(scenarioCatalogCandidates).values({
    id: "public:" + REVISION + ":" + SCENARIO_ID,
    revision: REVISION,
    scenarioId: SCENARIO_ID,
    buildId: "build-1",
    manifestJson: manifestFor(candidateImage),
  });
  await db.insert(vmScenarios).values({
    scenarioId: SCENARIO_ID,
    title: "Live catalog",
    category: "linux",
    description: "Live catalog",
    difficulty: "easy",
    estimatedMinutes: 10,
    tagsJson: [],
    briefingMarkdown: "live",
    solutionMarkdown: "live",
    hintsJson: [],
    enabled: true,
    enabledAt: Date.now(),
  });
  await db.insert(vmScenarioVms).values({
    id: SCENARIO_ID + ":web",
    scenarioId: SCENARIO_ID,
    ordinal: 0,
    vmName: "web",
    image: "previous.raw.zst",
    imageKeyJson: { scenario: SCENARIO_ID, vm: "web", arch: ARCH },
    imageSha256: PREVIOUS_IMAGE,
    imageFormat: "raw_zstd",
    imageVirtualSizeBytes: 4_096,
    kernelSha256: "1".repeat(64),
    initrdSha256: "2".repeat(64),
    bootCmdline: "root=/dev/vda rw console=ttyS0",
    memoryMib: 512,
    diskMib: 1_024,
  });
}

function promotionRequest(): Request {
  return new Request(
    "https://intar.test/registry/v1/catalog/promote/" + REVISION,
    {
      method: "POST",
      headers: {
        authorization: "Bearer test-publish-token",
        "x-intar-drained": "true",
      },
    },
  );
}

function cleanupService() {
  return createCleanupServiceDouble({
    DB: env.DB,
    VM_IMAGE_REGISTRY_BUCKET: env.VM_IMAGE_REGISTRY_BUCKET,
  });
}

function promotionEnv(): Cloudflare.Env {
  return { ...env, REGISTRY_CLEANUP: cleanupService() } as unknown as Cloudflare.Env;
}

async function pendingWriters(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM image_registry_operation_writers WHERE released_at IS NULL",
  ).first<{ count: number }>();
  return row?.count ?? -1;
}

/** Waits (bounded) for the promotion to register its writer. */
async function waitForPendingWriter(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await pendingWriters()) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the promotion never registered its writer");
}

function collectorEnv(): { DB: D1Database; VM_IMAGE_REGISTRY_BUCKET: R2Bucket } {
  return {
    DB: env.DB,
    VM_IMAGE_REGISTRY_BUCKET: env.VM_IMAGE_REGISTRY_BUCKET,
  };
}

async function liveImageIds(): Promise<string[]> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({ imageSha256: vmScenarioVms.imageSha256 })
    .from(vmScenarioVms)
    .where(eq(vmScenarioVms.scenarioId, SCENARIO_ID));
  return rows.map((row) => row.imageSha256 ?? "").sort();
}

describe("candidate promotion interleaving", () => {
  beforeEach(async () => {
    await resetD1Database();
    await seedCandidate();
  });

  it("refuses the sweep while the promotion is still reading its source", async () => {
    // An object nothing references, so the refusal is the only reason it
    // survives this sweep.
    const orphan = await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, {
      label: "orphan",
    });

    // Hold the family lock the promotion must take. The promotion therefore
    // registers its writer, then blocks before its first source read, which is
    // exactly the window a sweep could otherwise exploit.
    const db = drizzle(env.DB);
    let releaseHolder = () => {};
    const held = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holderReady = () => {};
    const ready = new Promise<void>((resolve) => {
      holderReady = resolve;
    });
    const holder = withImageBuildCoordinationLock(
      db,
      { scenarioId: SCENARIO_ID, arch: ARCH },
      async () => {
        holderReady();
        await held;
      },
    );

    const promotion = handleCandidateCatalogPromotion(
      promotionRequest(),
      promotionEnv(),
      REVISION,
    );
    await ready;
    await waitForPendingWriter();

    // The collector runs to completion here. It must not delete anything: the
    // promotion has already registered its writer.
    const core = createImageRegistryCleanupCore({});
    const result = await core.run(collectorEnv(), {
      mode: "delete",
      nowMs: Date.now(),
    });
    expect(result.deletedObjects).toBe(0);
    expect(result.resumeRequired).toBe(true);
    expect(await env.VM_IMAGE_REGISTRY_BUCKET.head(orphan.objectKey)).not.toBeNull();

    releaseHolder();
    await holder;
    const response = await promotion;
    expect(response.status).toBe(200);
    expect(await liveImageIds()).toEqual([candidateImage.imageId]);

    // Once the writer is settled, the same sweep removes the orphan.
    const after = await core.run(collectorEnv(), {
      mode: "delete",
      nowMs: Date.now(),
    });
    expect(after.error).toBeNull();
    expect(await env.VM_IMAGE_REGISTRY_BUCKET.head(orphan.objectKey)).toBeNull();
  });

  it("refuses before any metadata change while a sweep holds the registry", async () => {
    const db = drizzle(env.DB);
    const sweep = await acquireRegistrySweep(
      { DB: env.DB } as unknown as Cloudflare.Env,
      { owner: "test-sweep", leaseMs: 60_000 },
    );
    expect("lease" in sweep).toBe(true);
    if (!("lease" in sweep)) return;

    const before = {
      candidates: await db.select().from(scenarioCatalogCandidates),
      snapshots: await db.select().from(scenarioCatalogSnapshots),
      live: await liveImageIds(),
    };

    const response = await handleCandidateCatalogPromotion(
      promotionRequest(),
      promotionEnv(),
      REVISION,
    );

    expect(response.status).toBe(409);
    const after = {
      candidates: await db.select().from(scenarioCatalogCandidates),
      snapshots: await db.select().from(scenarioCatalogSnapshots),
      live: await liveImageIds(),
    };
    expect(after).toEqual(before);
    expect(await pendingWriters()).toBe(0);

    await finishRegistrySweep(
      { DB: env.DB } as unknown as Cloudflare.Env,
      { sweepToken: sweep.lease.sweepToken, outcome: "completed" },
    );
    // With the sweep released the promotion proceeds.
    expect(
      (await handleCandidateCatalogPromotion(promotionRequest(), promotionEnv(), REVISION))
        .status,
    ).toBe(200);
  });

  it("serializes a live publish against the promotion", async () => {
    const db = drizzle(env.DB);
    const published = await seedChunkedImage(env.VM_IMAGE_REGISTRY_BUCKET, {
      label: "published",
    });
    const form = new FormData();
    form.set("manifest", JSON.stringify(manifestFor(published)));
    // Deletes are enabled for the promotion's sweep, so the publish must carry
    // the upload session the enforcement mode requires.
    const session = await createRegistryUploadSession(
      { DB: env.DB } as unknown as Cloudflare.Env,
      { owner: { kind: "publish_token", id: "publish-token" } },
    );
    expect(session.ok).toBe(true);
    if (!session.ok) return;

    const [promotion, publish] = await Promise.all([
      handleCandidateCatalogPromotion(promotionRequest(), promotionEnv(), REVISION),
      handleImageRegistryRequest(
        new Request("https://intar.test/registry/v1/publish", {
          method: "POST",
          headers: {
            authorization: "Bearer test-publish-token",
            "x-intar-registry-session": session.sessionId,
          },
          body: form,
        }),
        env,
      ),
    ]);

    expect(publish?.status).toBe(201);
    // The uploader owns the session lifetime: it closes it once publication is
    // done, and an open session would keep the sweep out of the registry.
    await completeRegistryUploadSession(
      { DB: env.DB } as unknown as Cloudflare.Env,
      {
        owner: { kind: "publish_token", id: "publish-token" },
        sessionId: session.sessionId,
        outcome: "published",
      },
    );

    // The two writers were serialized, so the publish always commits. The
    // promotion commits too, but its deletion half can legitimately report
    // pending: it asks the collector while the publish's writer may still be
    // active, and a sweep refuses in that window. That is a retryable answer,
    // not a lost promotion.
    const body = (await promotion.json()) as {
      ok?: boolean;
      catalog_promoted?: boolean;
      retry?: boolean;
    };
    if (promotion.status === 503) {
      expect(body).toMatchObject({ catalog_promoted: true, retry: true });
      const retry = await handleCandidateCatalogPromotion(
        promotionRequest(),
        promotionEnv(),
        REVISION,
      );
      expect(retry.status).toBe(200);
      await expect(retry.json()).resolves.toMatchObject({ ok: true });
    } else {
      expect(promotion.status).toBe(200);
      expect(body).toMatchObject({ ok: true });
    }

    // Coherence after both writers: exactly one image is live and the newest
    // rollback record captures the state the last writer replaced.
    expect(await liveImageIds()).toEqual([candidateImage.imageId]);

    const records = await db
      .select({
        id: scenarioCatalogSnapshots.id,
        createdAt: scenarioCatalogSnapshots.createdAt,
        snapshot: scenarioCatalogSnapshots.snapshotJson,
      })
      .from(scenarioCatalogSnapshots)
      .orderBy(scenarioCatalogSnapshots.createdAt);
    expect(records.length).toBeGreaterThan(0);
    const newest = records[records.length - 1]!;
    const captured = (
      (newest.snapshot as { vms?: Array<{ imageSha256?: string }> }).vms ?? []
    )
      .map((vm) => vm.imageSha256 ?? "")
      .filter((imageId) => imageId !== "");
    expect(captured).toEqual([published.imageId]);
  });
});
