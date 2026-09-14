/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { handleCandidateCatalogPromotion } from "@/control-plane/image-registry/catalog-promotion";
import {
  imageBuildBundles,
  imageBuilds,
  runtimeOperationGates,
  scenarioCatalogCandidates,
  vmScenarioVms,
  vmScenarios,
} from "@/db/schema";
import type { ScenarioManifestV4 } from "@/generated/catalog";
import { IMAGE_BUILD_FORMAT_VERSION } from "@/lib/image-build-format";
import { IMAGE_CUTOVER_GATE } from "@/lib/run-admission-gate";
import { resetD1Database } from "@/test/d1-migrations";
import { createCleanupServiceDouble } from "./cleanup-service-double";
import {
  enableRegistryDeletion,
  seedChunkedImage,
  seedLegacyImage,
} from "./registry-artifact-fixtures";

const encoderForTest = new TextEncoder();
const CONTENT_HASH = "a".repeat(64);
const REVISION = "revision-1";
const SCENARIO_ID = "broken-nginx";
const IMAGE_KEY = {
  scenario: SCENARIO_ID,
  vm: "web",
  arch: "x86_64" as const,
};
/** The live pointer before the promotion; a legacy raw image with no chunks. */
const PREVIOUS_IMAGE = "b".repeat(64);
/** An unreferenced legacy image that only a historical build names. */
const HISTORIC_IMAGE = "c".repeat(64);

let promoted: Awaited<ReturnType<typeof seedChunkedImage>>;

function manifest(input: {
  imageId: string;
  chunkManifestSha256: string | null;
  kernelSha256: string;
  initrdSha256: string;
}): ScenarioManifestV4 {
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
        image_key: IMAGE_KEY,
        image_id: input.imageId,
        image_format: "raw_chunks_v1",
        image_virtual_size_bytes: 4_096,
        chunk_manifest_sha256: input.chunkManifestSha256 ?? undefined,
        guest_bootstrap_abi: 2,
        boot: {
          kernel_sha256: input.kernelSha256,
          initrd_sha256: input.initrdSha256,
          cmdline: "root=/dev/vda rw console=ttyS0",
        },
        cpu_millis: 1_000,
        vcpu_count: 1,
        memory_mib: 512,
        disk_mib: 1_024,
        probes: [],
      },
    ],
  } as ScenarioManifestV4;
}

function legacyManifest(imageId: string): ScenarioManifestV4 {
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
        image_key: IMAGE_KEY,
        image_id: imageId,
        image_format: "raw_zstd",
        image_virtual_size_bytes: 4_096,
        guest_bootstrap_abi: 1,
        boot: {
          kernel_sha256: "1".repeat(64),
          initrd_sha256: "2".repeat(64),
          cmdline: "root=/dev/vda rw console=ttyS0",
        },
        cpu_millis: 1_000,
        vcpu_count: 1,
        memory_mib: 512,
        disk_mib: 1_024,
        probes: [],
      },
    ],
  } as unknown as ScenarioManifestV4;
}

async function seed(): Promise<void> {
  const db = drizzle(env.DB);
  const bucket = env.VM_IMAGE_REGISTRY_BUCKET;
  await enableRegistryDeletion(env.DB);
  promoted = await seedChunkedImage(bucket, {
    label: "promoted",
  });
  await seedLegacyImage(bucket, {
    scenario: SCENARIO_ID,
    vm: "web",
    arch: "x86_64",
    sha256: PREVIOUS_IMAGE,
  });
  await seedLegacyImage(bucket, {
    scenario: SCENARIO_ID,
    vm: "web",
    arch: "x86_64",
    sha256: HISTORIC_IMAGE,
  });
  await bucket.put("builds/bundles/" + REVISION + ".tar.gz", new Uint8Array([11]));
  for (const sha256 of ["1".repeat(64), "2".repeat(64)]) {
    await bucket.put("artifacts/" + sha256, encoderForTest.encode("legacy-boot"));
  }

  await db.insert(imageBuildBundles).values({
    rev: REVISION,
    r2Key: "builds/bundles/" + REVISION + ".tar.gz",
    metaJson: {
      buildFormatVersion: IMAGE_BUILD_FORMAT_VERSION,
      catalogChannel: "candidate",
      scenarios: [
        { scenarioId: SCENARIO_ID, arch: "x86_64", contentHash: CONTENT_HASH },
      ],
    },
  });
  await db.insert(runtimeOperationGates).values({
    key: IMAGE_CUTOVER_GATE,
    state: "drained",
  });
  await db.insert(imageBuilds).values([
    {
      id: "build-new",
      scenarioId: SCENARIO_ID,
      arch: "x86_64",
      rev: REVISION,
      contentHash: CONTENT_HASH,
      catalogChannel: "candidate",
      status: "succeeded",
      phase: "succeeded",
      publishedManifestJson: manifest({
        imageId: promoted.imageId,
        chunkManifestSha256: promoted.chunkManifestSha256,
        kernelSha256: promoted.kernelSha256,
        initrdSha256: promoted.initrdSha256,
      }),
    },
    {
      // The build behind the live pointer. Its image becomes the one rollback.
      id: "build-previous",
      scenarioId: SCENARIO_ID,
      arch: "x86_64",
      rev: REVISION,
      contentHash: "6".repeat(64),
      status: "succeeded",
      phase: "succeeded",
      publishedManifestJson: legacyManifest(PREVIOUS_IMAGE),
    },
    {
      // A historical build that only names objects nothing else references.
      id: "build-historic",
      scenarioId: SCENARIO_ID,
      arch: "x86_64",
      rev: REVISION,
      contentHash: "7".repeat(64),
      status: "succeeded",
      phase: "succeeded",
      publishedManifestJson: legacyManifest(HISTORIC_IMAGE),
    },
  ]);
  await db.insert(scenarioCatalogCandidates).values({
    id: "public:" + REVISION + ":" + SCENARIO_ID,
    revision: REVISION,
    scenarioId: SCENARIO_ID,
    buildId: "build-new",
    manifestJson: manifest({
      imageId: promoted.imageId,
      chunkManifestSha256: promoted.chunkManifestSha256,
      kernelSha256: promoted.kernelSha256,
      initrdSha256: promoted.initrdSha256,
    }),
  });
  await db.insert(vmScenarios).values({
    scenarioId: SCENARIO_ID,
    title: "Previous catalog",
    category: "linux",
    description: "Previous catalog",
    difficulty: "easy",
    estimatedMinutes: 10,
    tagsJson: [],
    briefingMarkdown: "previous",
    solutionMarkdown: "previous",
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
    imageKeyJson: IMAGE_KEY,
    imageSha256: PREVIOUS_IMAGE,
    imageFormat: "raw_zstd",
    imageVirtualSizeBytes: 4_096,
    kernelSha256: "1".repeat(64),
    initrdSha256: "2".repeat(64),
    bootCmdline: "root=/dev/vda rw console=ttyS0",
    memoryMib: 512,
    diskMib: 1_024,
  } as unknown as typeof vmScenarioVms.$inferInsert);
}

async function pendingWriterCount(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM image_registry_operation_writers WHERE released_at IS NULL",
  ).first<{ count: number }>();
  return row?.count ?? -1;
}

async function sweepState(): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT state FROM image_registry_admission WHERE key = 'image_registry_admission'",
  ).first<{ state: string }>();
  return row?.state ?? "missing";
}

describe("catalog promotion admission and cleanup", () => {
  beforeEach(async () => {
    await resetD1Database();
    await seed();
  });

  it("releases every writer before the collector sweeps and deletes the retired objects", async () => {
    const observations: Array<{ pendingWriters: number; sweep: string }> = [];
    const double = createCleanupServiceDouble(
      { DB: env.DB, VM_IMAGE_REGISTRY_BUCKET: env.VM_IMAGE_REGISTRY_BUCKET },
      {
        // This runs while the promotion request is still open. It is the proof
        // that the pointer-mutation guard was released before the sweep: a
        // pending writer makes the collector refuse its exclusive lease.
        onRun: async () => {
          observations.push({
            pendingWriters: await pendingWriterCount(),
            sweep: await sweepState(),
          });
        },
      },
    );

    const response = await handleCandidateCatalogPromotion(
      new Request(
        "https://intar.test/registry/v1/catalog/promote/" + REVISION,
        {
          method: "POST",
          headers: {
            authorization: "Bearer test-publish-token",
            "x-intar-drained": "true",
          },
        },
      ),
      { ...env, REGISTRY_CLEANUP: double } as unknown as Cloudflare.Env,
      REVISION,
    );

    const body = (await response.json()) as {
      ok?: boolean;
      error?: string;
      cleanup?: { applied?: boolean; deleted_objects?: number; pending?: boolean };
    };
    expect({ status: response.status, ok: body.ok, error: body.error }).toEqual({
      status: 200,
      ok: true,
      error: undefined,
    });
    expect(body.cleanup).toMatchObject({ applied: true, pending: false });

    // The guard was released before the sweep ran, and nothing is left behind.
    expect(observations).toEqual([{ pendingWriters: 0, sweep: "open" }]);
    expect(await pendingWriterCount()).toBe(0);

    // The live pointer moved to the promoted image.
    const db = drizzle(env.DB);
    const live = await db
      .select({
        imageSha256: vmScenarioVms.imageSha256,
        imageFormat: vmScenarioVms.imageFormat,
        chunkManifestSha256: vmScenarioVms.chunkManifestSha256,
      })
      .from(vmScenarioVms)
      .where(eq(vmScenarioVms.scenarioId, SCENARIO_ID));
    expect(live).toEqual([
      {
        imageSha256: promoted.imageId,
        imageFormat: "raw_chunks_v1",
        chunkManifestSha256: promoted.chunkManifestSha256,
      },
    ]);

    // A historical build only naming unreferenced objects is retired, and its
    // objects are gone; the promoted artifacts and the rollback survive.
    const bucket = env.VM_IMAGE_REGISTRY_BUCKET;
    const builds = await db
      .select({ id: imageBuilds.id, retiredAt: imageBuilds.artifactsRetiredAt })
      .from(imageBuilds);
    expect(
      Object.fromEntries(builds.map((row) => [row.id, row.retiredAt])),
    ).toMatchObject({
      "build-new": null,
      "build-previous": null,
    });
    expect(
      builds.find((row) => row.id === "build-historic")?.retiredAt,
    ).toBeTypeOf("number");
    expect(
      await bucket.head(
        "images/" + SCENARIO_ID + "-web-x86_64/" + HISTORIC_IMAGE + ".raw.zst",
      ),
    ).toBeNull();
    expect(await bucket.head(promoted.objectKey)).not.toBeNull();
    expect(
      await bucket.head("image-chunks/v1/zstd6/" + promoted.chunkRawSha256),
    ).not.toBeNull();
    expect(await bucket.head("artifacts/" + promoted.kernelSha256)).not.toBeNull();
    expect(
      await bucket.head(
        "images/" + SCENARIO_ID + "-web-x86_64/" + PREVIOUS_IMAGE + ".raw.zst",
      ),
    ).not.toBeNull();
    expect(
      await bucket.head("builds/bundles/" + REVISION + ".tar.gz"),
    ).not.toBeNull();
  });
});
