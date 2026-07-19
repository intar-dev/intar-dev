/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import {
  organization,
  scenarioCourseCatalogs,
  vmScenarios,
  vmScenarioVms,
  type ScenarioCourseCatalogSnapshotV1,
} from "@/db/schema";
import {
  syncScenarioCourseCatalogSnapshot,
  validateScenarioCourseCatalogReferences,
} from "@/lib/scenario-course-catalogs";
import { listScenarioCatalogForUser } from "@/lib/scenario-runs";
import { resetD1Database } from "@/test/d1-migrations";

describe("scenario course catalog storage", () => {
  beforeEach(async () => {
    await resetD1Database();
  });

  it("replaces snapshots per scope, clears explicitly, and is idempotent", async () => {
    const db = drizzle(env.DB);
    await insertOrganization("org-a");
    await insertOrganization("org-b");

    await syncScenarioCourseCatalogSnapshot(db, {
      snapshot: snapshot(course("public-course", ["public-one"])),
      sourceRevision: "public-rev",
      organizationId: null,
      nowUnixMs: 100,
    });
    await syncScenarioCourseCatalogSnapshot(db, {
      snapshot: snapshot(course("org-a-course", ["org-a-one"])),
      sourceRevision: "org-a-rev",
      organizationId: "org-a",
      nowUnixMs: 110,
    });
    await syncScenarioCourseCatalogSnapshot(db, {
      snapshot: snapshot(course("org-b-course", ["org-b-one"])),
      sourceRevision: "org-b-rev",
      organizationId: "org-b",
      nowUnixMs: 120,
    });

    await syncScenarioCourseCatalogSnapshot(db, {
      snapshot: snapshot(course("public-course", ["public-one"])),
      sourceRevision: "public-rev",
      organizationId: null,
      nowUnixMs: 200,
    });
    const publicAfterIdempotentWrite = await db
      .select()
      .from(scenarioCourseCatalogs)
      .where(eq(scenarioCourseCatalogs.scopeKey, "public"));
    expect(publicAfterIdempotentWrite).toEqual([
      expect.objectContaining({
        sourceRevision: "public-rev",
        createdAt: 100,
        updatedAt: 100,
      }),
    ]);

    await syncScenarioCourseCatalogSnapshot(db, {
      snapshot: snapshot(),
      sourceRevision: "org-a-clear-rev",
      organizationId: "org-a",
      nowUnixMs: 210,
    });
    const rows = await db.select().from(scenarioCourseCatalogs);
    expect(rows).toHaveLength(3);
    expect(
      rows.find((row) => row.scopeKey === "organization:org-a"),
    ).toMatchObject({
      organizationId: "org-a",
      coursesJson: [],
      sourceRevision: "org-a-clear-rev",
      createdAt: 110,
      updatedAt: 210,
    });
    expect(rows.find((row) => row.scopeKey === "public")?.coursesJson).toEqual(
      [course("public-course", ["public-one"])],
    );
    expect(
      rows.find((row) => row.scopeKey === "organization:org-b")?.coursesJson,
    ).toEqual([course("org-b-course", ["org-b-one"])]);
  });

  it("cascades organization snapshots and enforces deterministic scope keys", async () => {
    const db = drizzle(env.DB);
    await insertOrganization("org-a");
    await syncScenarioCourseCatalogSnapshot(db, {
      snapshot: snapshot(),
      sourceRevision: "org-a-rev",
      organizationId: "org-a",
      nowUnixMs: 100,
    });

    await expect(
      db.insert(scenarioCourseCatalogs).values({
        scopeKey: "wrong-scope",
        organizationId: null,
        coursesJson: [],
        sourceRevision: "bad-rev",
        createdAt: 100,
        updatedAt: 100,
      }),
    ).rejects.toBeDefined();

    await db.delete(organization).where(eq(organization.id, "org-a"));
    await expect(db.select().from(scenarioCourseCatalogs)).resolves.toEqual([]);
  });
});

describe("scenario course catalog reference validation", () => {
  beforeEach(async () => {
    await resetD1Database();
    await insertOrganization("org-a");
    await insertOrganization("org-b");
    await insertScenario(null, "public-enabled");
    await insertScenario(null, "public-disabled", false);
    await insertScenario("org-a", "org-a-enabled");
    await insertScenario("org-b", "org-b-enabled");
  });

  it("allows public bundles plus enabled public catalog rows", async () => {
    const result = await validateScenarioCourseCatalogReferences(
      drizzle(env.DB),
      {
        snapshot: snapshot(
          course("public-course", ["new-public", "public-enabled"]),
        ),
        bundleScenarioIds: ["new-public"],
        organizationId: null,
      },
    );
    expect(result).toEqual({ ok: true, invalidScenarioIds: [] });
  });

  it("allows mixed public and same-organization members", async () => {
    const result = await validateScenarioCourseCatalogReferences(
      drizzle(env.DB),
      {
        snapshot: snapshot(
          course("organization-course", [
            "public-enabled",
            "org-a-enabled",
            "org-a-new",
          ]),
        ),
        bundleScenarioIds: ["org-a-new"],
        organizationId: "org-a",
      },
    );
    expect(result).toEqual({ ok: true, invalidScenarioIds: [] });
  });

  it("rejects disabled rows, cross-tenant rows, and bundle-ID collisions", async () => {
    const db = drizzle(env.DB);
    await expect(
      validateScenarioCourseCatalogReferences(db, {
        snapshot: snapshot(
          course("public-course", [
            "public-disabled",
            "org-a-enabled",
            "missing",
          ]),
        ),
        bundleScenarioIds: [],
        organizationId: null,
      }),
    ).resolves.toEqual({
      ok: false,
      invalidScenarioIds: [
        "public-disabled",
        "org-a-enabled",
        "missing",
      ],
    });

    await expect(
      validateScenarioCourseCatalogReferences(db, {
        snapshot: snapshot(course("org-course", ["org-b-enabled"])),
        bundleScenarioIds: [],
        organizationId: "org-a",
      }),
    ).resolves.toEqual({
      ok: false,
      invalidScenarioIds: ["org-b-enabled"],
    });

    await expect(
      validateScenarioCourseCatalogReferences(db, {
        snapshot: snapshot(course("collision", ["org-a-enabled"])),
        bundleScenarioIds: ["org-a-enabled"],
        organizationId: null,
      }),
    ).resolves.toEqual({
      ok: false,
      invalidScenarioIds: ["org-a-enabled"],
    });
    await expect(
      validateScenarioCourseCatalogReferences(db, {
        snapshot: snapshot(course("collision", ["public-enabled"])),
        bundleScenarioIds: ["public-enabled"],
        organizationId: "org-a",
      }),
    ).resolves.toEqual({
      ok: false,
      invalidScenarioIds: ["public-enabled"],
    });
  });
});

describe("scenario course catalog reads", () => {
  beforeEach(async () => {
    await resetD1Database();
    await insertOrganization("org-a");
    await insertOrganization("org-b");
    await insertScenario(null, "public-one");
    await insertScenario(null, "public-two");
    await insertScenario(null, "public-three");
    await insertScenario(null, "public-hidden", false);
    await insertScenario("org-a", "org-a-one");
    await insertScenario("org-a", "org-a-hidden", false);
    await insertScenario("org-b", "org-b-one");

    const db = drizzle(env.DB);
    await syncScenarioCourseCatalogSnapshot(db, {
      snapshot: snapshot(
        course("public-curriculum", ["public-two", "public-one"]),
        course("partial-public", ["public-three", "public-hidden"]),
        course("empty-public", ["public-hidden"]),
      ),
      sourceRevision: "public-rev",
      organizationId: null,
      nowUnixMs: 100,
    });
    await syncScenarioCourseCatalogSnapshot(db, {
      snapshot: snapshot(
        course("organization-curriculum", [
          "public-one",
          "org-a-one",
          "org-a-hidden",
        ]),
      ),
      sourceRevision: "org-a-rev",
      organizationId: "org-a",
      nowUnixMs: 110,
    });
    await syncScenarioCourseCatalogSnapshot(db, {
      snapshot: snapshot(course("org-b-course", ["org-b-one"])),
      sourceRevision: "org-b-rev",
      organizationId: "org-b",
      nowUnixMs: 120,
    });
  });

  it("preserves public curriculum order while hiding unavailable members", async () => {
    const catalog = await listScenarioCatalogForUser("learner");
    expect(catalog.courses).toEqual([
      {
        courseId: "public-curriculum",
        organizationId: null,
        title: "public-curriculum title",
        description: "public-curriculum description",
        scenarioIds: ["public-two", "public-one"],
      },
      {
        courseId: "partial-public",
        organizationId: null,
        title: "partial-public title",
        description: "partial-public description",
        scenarioIds: ["public-three"],
      },
    ]);
    expect(catalog.scenarios.map((scenario) => scenario.scenarioId)).toEqual([
      "public-one",
      "public-three",
      "public-two",
    ]);
  });

  it("returns public courses first and gives organization membership precedence", async () => {
    const catalog = await listScenarioCatalogForUser("learner", "org-a");
    expect(catalog.courses).toEqual([
      {
        courseId: "public-curriculum",
        organizationId: null,
        title: "public-curriculum title",
        description: "public-curriculum description",
        scenarioIds: ["public-two"],
      },
      {
        courseId: "partial-public",
        organizationId: null,
        title: "partial-public title",
        description: "partial-public description",
        scenarioIds: ["public-three"],
      },
      {
        courseId: "organization-curriculum",
        organizationId: "org-a",
        title: "organization-curriculum title",
        description: "organization-curriculum description",
        scenarioIds: ["public-one", "org-a-one"],
      },
    ]);
    expect(catalog.scenarios.map((scenario) => scenario.scenarioId)).toEqual([
      "org-a-one",
      "public-one",
      "public-three",
      "public-two",
    ]);
    expect(catalog.scenarios).not.toContainEqual(
      expect.objectContaining({ scenarioId: "org-b-one" }),
    );
  });
});

async function insertOrganization(id: string): Promise<void> {
  await drizzle(env.DB).insert(organization).values({
    id,
    name: id,
    slug: id,
    createdAt: new Date(),
  });
}

async function insertScenario(
  organizationId: string | null,
  scenarioId: string,
  enabled = true,
): Promise<void> {
  const db = drizzle(env.DB);
  const now = Date.now();
  await db.batch([
    db.insert(vmScenarios).values({
      scenarioId,
      organizationId,
      title: scenarioId,
      category: "test",
      description: `${scenarioId} description`,
      difficulty: "easy",
      estimatedMinutes: 10,
      tagsJson: [],
      briefingMarkdown: `${scenarioId} briefing`,
      solutionMarkdown: `${scenarioId} solution`,
      hintsJson: [],
      enabled,
      enabledAt: enabled ? now : null,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(vmScenarioVms).values({
      id: `${scenarioId}:vm`,
      scenarioId,
      ordinal: 0,
      vmName: "vm",
      image: `${scenarioId}-vm-x86_64.raw.zst`,
      imageKeyJson: { scenario: scenarioId, vm: "vm", arch: "x86_64" },
      imageSha256: "a".repeat(64),
      imageFormat: "raw_zstd",
      imageVirtualSizeBytes: 1024,
      kernelSha256: "b".repeat(64),
      initrdSha256: "c".repeat(64),
      bootCmdline: "console=ttyS0 root=/dev/vda rw",
      cpuMillis: 1_000,
      vcpuCount: 1,
      memoryMib: 512,
      diskMib: 1_024,
    }),
  ]);
}

function snapshot(
  ...courses: ScenarioCourseCatalogSnapshotV1["courses"]
): ScenarioCourseCatalogSnapshotV1 {
  return { version: 1, mode: "replace", courses };
}

function course(
  courseId: string,
  scenarioIds: string[],
): ScenarioCourseCatalogSnapshotV1["courses"][number] {
  return {
    courseId,
    title: `${courseId} title`,
    description: `${courseId} description`,
    scenarioIds,
  };
}
