/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import {
  agentHosts,
  organization,
  scenarioCourseCatalogs,
  scenarioRuns,
  user,
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
    expect(rows.find((row) => row.scopeKey === "public")?.coursesJson).toEqual([
      course("public-course", ["public-one"]),
    ]);
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
      invalidScenarioIds: ["public-disabled", "org-a-enabled", "missing"],
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
    await insertScenario(null, "public-standalone");
    await insertScenario(null, "public-hidden", false);
    await insertScenario("org-a", "org-a-one");
    await insertScenario("org-a", "org-a-standalone");
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
        kind: "authored",
        courseId: "public-curriculum",
        organizationId: null,
        title: "public-curriculum title",
        description: "public-curriculum description",
        scenarios: [
          expect.objectContaining({ scenarioId: "public-two" }),
          expect.objectContaining({ scenarioId: "public-one" }),
        ],
      },
      {
        kind: "authored",
        courseId: "partial-public",
        organizationId: null,
        title: "partial-public title",
        description: "partial-public description",
        scenarios: [expect.objectContaining({ scenarioId: "public-three" })],
      },
      {
        kind: "general-practice",
        courseId: null,
        organizationId: null,
        title: "General practice",
        description:
          "Standalone systems for focused practice outside a guided curriculum.",
        scenarios: [
          expect.objectContaining({ scenarioId: "public-standalone" }),
        ],
      },
    ]);
    expect(catalog).not.toHaveProperty("scenarios");
    expect(flattenScenarioIds(catalog)).toEqual([
      "public-two",
      "public-one",
      "public-three",
      "public-standalone",
    ]);
  });

  it("returns public courses first and gives organization membership precedence", async () => {
    const catalog = await listScenarioCatalogForUser("learner", "org-a");
    expect(catalog.courses).toEqual([
      {
        kind: "authored",
        courseId: "public-curriculum",
        organizationId: null,
        title: "public-curriculum title",
        description: "public-curriculum description",
        scenarios: [expect.objectContaining({ scenarioId: "public-two" })],
      },
      {
        kind: "authored",
        courseId: "partial-public",
        organizationId: null,
        title: "partial-public title",
        description: "partial-public description",
        scenarios: [expect.objectContaining({ scenarioId: "public-three" })],
      },
      {
        kind: "authored",
        courseId: "organization-curriculum",
        organizationId: "org-a",
        title: "organization-curriculum title",
        description: "organization-curriculum description",
        scenarios: [
          expect.objectContaining({ scenarioId: "public-one" }),
          expect.objectContaining({ scenarioId: "org-a-one" }),
        ],
      },
      {
        kind: "general-practice",
        courseId: null,
        organizationId: null,
        title: "General practice",
        description:
          "Standalone systems for focused practice outside a guided curriculum.",
        scenarios: [
          expect.objectContaining({ scenarioId: "org-a-standalone" }),
          expect.objectContaining({ scenarioId: "public-standalone" }),
        ],
      },
    ]);
    expect(flattenScenarioIds(catalog)).toEqual([
      "public-two",
      "public-three",
      "public-one",
      "org-a-one",
      "org-a-standalone",
      "public-standalone",
    ]);
    expect(flattenScenarioIds(catalog)).not.toContain("org-b-one");
    expect(new Set(flattenScenarioIds(catalog)).size).toBe(
      flattenScenarioIds(catalog).length,
    );
  });

  it("omits General practice when authored courses claim every visible scenario", async () => {
    await syncScenarioCourseCatalogSnapshot(drizzle(env.DB), {
      snapshot: snapshot(
        course("complete-curriculum", [
          "public-three",
          "public-standalone",
          "public-two",
          "public-one",
        ]),
      ),
      sourceRevision: "complete-public-rev",
      organizationId: null,
      nowUnixMs: 200,
    });

    const catalog = await listScenarioCatalogForUser("learner");
    expect(catalog.courses).toHaveLength(1);
    expect(catalog.courses[0]).toMatchObject({
      kind: "authored",
      courseId: "complete-curriculum",
    });
    expect(flattenScenarioIds(catalog)).toEqual([
      "public-three",
      "public-standalone",
      "public-two",
      "public-one",
    ]);
  });

  it("nests progress with its scenario and defensively projects each scenario once", async () => {
    const db = drizzle(env.DB);
    await db.insert(user).values({
      id: "learner",
      name: "Learner",
      email: "learner@example.test",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(agentHosts).values({
      id: "progress-host",
      userId: "learner",
      name: "Progress host",
    });
    await db.insert(scenarioRuns).values(completedScenarioRun("public-two"));
    await syncScenarioCourseCatalogSnapshot(db, {
      snapshot: snapshot(
        course("first-course", ["public-two", "public-two"]),
        course("second-course", ["public-two", "public-one"]),
      ),
      sourceRevision: "duplicate-defense-rev",
      organizationId: null,
      nowUnixMs: 220,
    });

    const catalog = await listScenarioCatalogForUser("learner");
    expect(
      flattenScenarioIds(catalog).filter((id) => id === "public-two"),
    ).toEqual(["public-two"]);
    expect(catalog.courses[0]).toMatchObject({
      kind: "authored",
      courseId: "first-course",
      scenarios: [
        {
          scenarioId: "public-two",
          progress: {
            status: "completed",
            activeRunId: null,
            attemptCount: 1,
            completedCount: 1,
            bestSolveMs: 500,
            lastPlayedAt: 3_000,
          },
        },
      ],
    });
    expect(catalog.courses[1]).toMatchObject({
      kind: "authored",
      courseId: "second-course",
      scenarios: [expect.objectContaining({ scenarioId: "public-one" })],
    });
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

function flattenScenarioIds(
  catalog: Awaited<ReturnType<typeof listScenarioCatalogForUser>>,
): string[] {
  return catalog.courses.flatMap((course) =>
    course.scenarios.map((scenario) => scenario.scenarioId),
  );
}

function completedScenarioRun(
  scenarioId: string,
): typeof scenarioRuns.$inferInsert {
  return {
    runId: `${scenarioId}-run`,
    userId: "learner",
    organizationId: null,
    hostId: "progress-host",
    scenarioId,
    scenarioName: scenarioId,
    title: scenarioId,
    tagline: "Test",
    briefingMarkdown: "Briefing",
    objectivesJson: "[]",
    difficulty: "easy",
    estimatedMinutes: 10,
    tagsJson: [],
    hintsJson: [],
    solutionMarkdown: "Solution",
    revealedHintsJson: [],
    solutionAssisted: false,
    vmCount: 1,
    state: "completed",
    stateRank: 1,
    activeKey: null,
    stateJson: "{}",
    solvedAt: 1_500,
    completedAt: 3_000,
    createdAt: 1_000,
    updatedAt: 3_000,
  };
}
