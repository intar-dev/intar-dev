/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import {
  imageBuildBundles,
  imageBuilds,
  scenarioCatalogCandidates,
  type ImageBuildBundleMeta,
} from "@/db/schema";
import type { ScenarioManifestV4 } from "@/generated/catalog";
import { stageReusableCandidateManifests } from "@/lib/scenario-catalog-candidates";
import { resetD1Database } from "@/test/d1-migrations";

const contentHash = "a".repeat(64);

describe("reused candidate presentation", () => {
  beforeEach(resetD1Database);

  it("overlays current lecture Markdown without queueing another image build", async () => {
    const db = drizzle(env.DB);
    await db.insert(imageBuildBundles).values({
      rev: "published",
      r2Key: "builds/bundles/published.tar.gz",
      metaJson: {
        buildFormatVersion: "intar-image-build-v11",
        scenarios: [],
      },
      createdAt: 1,
      updatedAt: 1,
    });
    await db.insert(imageBuilds).values({
      id: "reused-build",
      scenarioId: "task",
      arch: "x86_64",
      rev: "published",
      contentHash,
      catalogChannel: "live",
      status: "succeeded",
      phase: "succeeded",
      attempt: 1,
      timingsJson: {},
      publishedManifestJson: technicalManifest(),
      createdAt: 1,
      updatedAt: 1,
    });

    const meta: ImageBuildBundleMeta = {
      buildFormatVersion: "intar-image-build-v11",
      catalogChannel: "candidate",
      scenarios: [{ scenarioId: "task", arch: "x86_64", contentHash }],
      courseCatalog: {
        version: 2,
        courses: [
          {
            courseId: "course",
            title: "Course",
            summary: "Course summary",
            bodyMarkdown: "Course body",
            sequential: true,
            lectures: [
              {
                lectureId: "01-task",
                title: "Markdown title",
                summary: "Markdown summary",
                bodyMarkdown: "Markdown theory",
                category: "markdown",
                tags: ["markdown"],
                difficulty: "hard",
                estimatedMinutes: 42,
                scenarioId: "task",
              },
            ],
          },
        ],
      },
    };

    await expect(
      stageReusableCandidateManifests(db, {
        revision: "markdown-only",
        organizationId: null,
        meta,
        nowUnixMs: 2,
        wakeHost: async () => undefined,
      }),
    ).resolves.toEqual(["task"]);

    const [candidate] = await db
      .select()
      .from(scenarioCatalogCandidates)
      .where(eq(scenarioCatalogCandidates.id, "public:markdown-only:task"));
    expect(candidate?.manifestJson).toMatchObject({
      title: "Markdown title",
      category: "markdown",
      description: "Markdown summary",
      difficulty: "hard",
      estimated_minutes: 42,
      tags: ["markdown"],
      briefing_markdown: "Markdown theory",
      solution_markdown: "Technical solution",
      vms: [{ name: "vm" }],
    });
    await expect(
      db
        .select({ id: imageBuilds.id })
        .from(imageBuilds)
        .where(eq(imageBuilds.contentHash, contentHash)),
    ).resolves.toEqual([{ id: "reused-build" }]);
  });
});

function technicalManifest(): ScenarioManifestV4 {
  return {
    schema_version: 4,
    scenario_id: "task",
    name: "task",
    title: "Technical title",
    category: "technical",
    description: "Technical description",
    difficulty: "easy",
    estimated_minutes: 10,
    tags: ["technical"],
    briefing_markdown: "Technical briefing",
    solution_markdown: "Technical solution",
    hints: [],
    vms: [
      {
        name: "vm",
        image_key: { scenario: "task", vm: "vm", arch: "x86_64" },
        image_id: "b".repeat(64),
        image_format: "raw_zstd",
        image_virtual_size_bytes: 1,
        chunk_manifest_sha256: "",
        guest_bootstrap_abi: 0,
        boot: {
          kernel_sha256: "c".repeat(64),
          initrd_sha256: "d".repeat(64),
          cmdline: "root=/dev/vda rw",
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
