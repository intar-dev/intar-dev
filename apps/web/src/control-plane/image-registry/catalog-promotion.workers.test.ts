/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { handleImageRegistryRequest } from "@/control-plane/image-registry";
import {
  imageBuildBundles,
  imageBuilds,
  runtimeOperationGates,
  scenarioCatalogCandidates,
  vmScenarioVms,
  vmScenarios,
} from "@/db/schema";
import type { ScenarioManifestV5 } from "@/generated/catalog";
import { IMAGE_BUILD_FORMAT_VERSION } from "@/lib/image-build-format";
import { IMAGE_CUTOVER_GATE } from "@/lib/run-admission-gate";
import { resetD1Database } from "@/test/d1-migrations";
import { createCleanupServiceDouble } from "./cleanup-service-double";
import {
  enableRegistryDeletion,
  seedChunkedImage,
  seedLegacyImage,
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

function manifest(image: Awaited<ReturnType<typeof seedChunkedImage>>): ScenarioManifestV5 {
  return {
    schema_version: 5,
    scenario_id: "broken-nginx",
    name: "broken-nginx",
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
        image_key: { scenario: "broken-nginx", vm: "web", arch: "x86_64" },
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
