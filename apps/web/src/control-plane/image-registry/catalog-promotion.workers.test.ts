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
import type { ScenarioManifestV4 } from "@/generated/catalog";
import { IMAGE_CUTOVER_GATE } from "@/lib/run-admission-gate";
import { resetD1Database } from "@/test/d1-migrations";

const CONTENT_HASH = "a".repeat(64);
const IMAGE_ID = "b".repeat(64);

describe("candidate scenario catalog promotion", () => {
  beforeEach(async () => {
    await resetD1Database();
    const db = drizzle(env.DB);
    await db.insert(imageBuildBundles).values({
      rev: "revision-1",
      r2Key: "builds/bundles/revision-1.tar.gz",
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
      publishedManifestJson: manifest(),
    });
    await db.insert(scenarioCatalogCandidates).values({
      id: "public:revision-1:broken-nginx",
      revision: "revision-1",
      scenarioId: "broken-nginx",
      buildId: "build-1",
      manifestJson: manifest(),
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
      imageSha256: IMAGE_ID,
      imageFormat: "raw_chunks_v1",
      guestBootstrapAbi: 1,
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
});

function manifest(): ScenarioManifestV4 {
  return {
    schema_version: 4,
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
        image_id: IMAGE_ID,
        image_format: "raw_chunks_v1",
        image_virtual_size_bytes: 1,
        chunk_manifest_sha256: "f".repeat(64),
        guest_bootstrap_abi: 1,
        boot: {
          kernel_sha256: "d".repeat(64),
          initrd_sha256: "e".repeat(64),
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
