/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import {
  agentHosts,
  courseUnitCompletions,
  imageBuilds,
  member,
  organization,
  courseCatalogs,
  scenarioRuns,
  user,
  vmScenarios,
  type CourseCatalogCourseV2,
  type CourseCatalogLectureV2,
  type CourseCatalogSnapshotV2,
} from "@/db/schema";
import type { ScenarioManifestV4 } from "@/generated/catalog";
import type { ScenarioBriefing } from "@/lib/scenario-model";
import {
  applyLectureBriefingPresentation,
  applyLecturePresentation,
  assertCourseScenarioStartAllowed,
  completePureCourseLectureForUser,
  findCourseLecturePresentation,
  listCourseCatalogForUser,
  loadCourseLectureDetailForUser,
  recordLinkedCourseUnitCompletionForRun,
  resolveCourseLectureForScenario,
  syncCourseCatalogSnapshot,
  validateCourseCatalogReferences,
} from "@/lib/course-catalogs";
import { resetD1Database } from "@/test/d1-migrations";

const learnerId = "learner";

describe("V2 course catalogs", () => {
  beforeEach(resetD1Database);

  it("fully replaces a scope snapshot and backfills its first linked unit", async () => {
    const db = drizzle(env.DB);
    await seedLearnerAndHost();
    await insertOrganization("org-a");
    await insertScenario(null, "historical");
    await insertRun({
      runId: "historical-run",
      scenarioId: "historical",
      organizationId: "org-a",
      state: "completed",
      solvedAt: 2_000,
      completedAt: 3_000,
    });

    const first = snapshot(
      course("first", [lecture("first-lecture", "historical")]),
    );
    await syncCourseCatalogSnapshot(db, {
      snapshot: first,
      sourceRevision: "first-revision",
      organizationId: null,
      nowUnixMs: 100,
    });

    const [firstRow] = await db
      .select()
      .from(courseCatalogs)
      .where(eq(courseCatalogs.scopeKey, "public"));
    expect(firstRow).toMatchObject({
      catalogJson: first,
      sourceRevision: "first-revision",
      createdAt: 100,
      updatedAt: 100,
    });
    await expect(db.select().from(courseUnitCompletions)).resolves.toEqual([
      expect.objectContaining({
        userId: learnerId,
        scopeKey: "public",
        courseId: "first",
        lectureId: "first-lecture",
        sourceRunId: "historical-run",
        completedAt: 3_000,
      }),
    ]);

    await db.delete(courseUnitCompletions);
    await syncCourseCatalogSnapshot(db, {
      snapshot: first,
      sourceRevision: "first-revision",
      organizationId: null,
      nowUnixMs: 200,
    });
    await expect(db.select().from(courseUnitCompletions)).resolves.toHaveLength(
      1,
    );

    const replacement = snapshot(course("second", [lecture("theory")]));
    await syncCourseCatalogSnapshot(db, {
      snapshot: replacement,
      sourceRevision: "replacement-revision",
      organizationId: null,
      nowUnixMs: 90,
    });

    const [replacementRow] = await db
      .select()
      .from(courseCatalogs)
      .where(eq(courseCatalogs.scopeKey, "public"));
    expect(replacementRow).toMatchObject({
      catalogJson: replacement,
      sourceRevision: "replacement-revision",
      createdAt: 100,
      updatedAt: 101,
    });
  });

  it("validates only linked V2 scenario references in the upload scope", async () => {
    const db = drizzle(env.DB);
    await insertOrganization("org-a");
    await insertOrganization("org-b");
    await insertScenario(null, "public-enabled");
    await insertScenario("org-b", "org-b-enabled");

    await expect(
      validateCourseCatalogReferences(db, {
        snapshot: snapshot(
          course("public", [
            lecture("existing", "public-enabled"),
            lecture("new", "new-public"),
            lecture("theory"),
          ]),
        ),
        bundleScenarioIds: ["new-public"],
        organizationId: null,
      }),
    ).resolves.toEqual([]);

    await expect(
      validateCourseCatalogReferences(db, {
        snapshot: snapshot(
          course("invalid", [lecture("other", "org-b-enabled")]),
        ),
        bundleScenarioIds: [],
        organizationId: "org-a",
      }),
    ).resolves.toEqual(["org-b-enabled"]);
  });

  it("hard-cuts unlinked public scenarios, including a content-only catalog", async () => {
    const db = drizzle(env.DB);
    await insertOrganization("org-a");
    await insertScenario(null, "public-kept");
    await insertScenario(null, "public-removed");
    await insertScenario("org-a", "organization-kept");

    await syncCourseCatalogSnapshot(db, {
      snapshot: snapshot(course("public", [lecture("kept", "public-kept")])),
      sourceRevision: "public-first",
      organizationId: null,
      nowUnixMs: 200,
    });

    await expectScenarioEnabled(db, "public-kept", true, 100);
    await expectScenarioEnabled(db, "public-removed", false, null);
    await expectScenarioEnabled(db, "organization-kept", true, 100);

    await syncCourseCatalogSnapshot(db, {
      snapshot: snapshot(course("public", [lecture("theory")])),
      sourceRevision: "public-content-only",
      organizationId: null,
      nowUnixMs: 300,
    });

    await expectScenarioEnabled(db, "public-kept", false, null);
    await expectScenarioEnabled(db, "organization-kept", true, 100);
  });

  it("hard-cuts only unlinked scenarios in the published organization scope", async () => {
    const db = drizzle(env.DB);
    await insertOrganization("org-a");
    await insertOrganization("org-b");
    await insertScenario(null, "public-kept");
    await insertScenario("org-a", "org-a-kept");
    await insertScenario("org-a", "org-a-removed");
    await insertScenario("org-b", "org-b-kept");

    await syncCourseCatalogSnapshot(db, {
      snapshot: snapshot(course("organization", [lecture("kept", "org-a-kept")])),
      sourceRevision: "organization-first",
      organizationId: "org-a",
      nowUnixMs: 200,
    });

    await expectScenarioEnabled(db, "org-a-kept", true, 100);
    await expectScenarioEnabled(db, "org-a-removed", false, null);
    await expectScenarioEnabled(db, "public-kept", true, 100);
    await expectScenarioEnabled(db, "org-b-kept", true, 100);
  });

  it("updates stored presentation fields for a Markdown-only publish", async () => {
    const db = drizzle(env.DB);
    await insertScenario(null, "task");
    await syncCourseCatalogSnapshot(db, {
      snapshot: snapshot(
        course("course", [lecture("lesson", "task", { title: "First title" })]),
      ),
      sourceRevision: "first",
      organizationId: null,
      nowUnixMs: 100,
    });
    await syncCourseCatalogSnapshot(db, {
      snapshot: snapshot(
        course("course", [
          lecture("lesson", "task", {
            title: "Markdown title",
            summary: "Markdown summary",
            bodyMarkdown: "Markdown theory",
            category: "markdown",
            difficulty: "hard",
            estimatedMinutes: 42,
            tags: ["markdown"],
          }),
        ]),
      ),
      sourceRevision: "markdown-only",
      organizationId: null,
      nowUnixMs: 200,
    });

    const [stored] = await db
      .select()
      .from(vmScenarios)
      .where(eq(vmScenarios.scenarioId, "task"));
    expect(stored).toMatchObject({
      sourceRevision: "markdown-only",
      title: "Markdown title",
      category: "markdown",
      description: "Markdown summary",
      difficulty: "hard",
      estimatedMinutes: 42,
      tagsJson: ["markdown"],
      briefingMarkdown: "Markdown theory",
    });
    await expect(db.select().from(imageBuilds)).resolves.toEqual([]);
  });

  it("shows public and organization courses with linked-scenario override", async () => {
    const db = drizzle(env.DB);
    await seedLearnerAndHost();
    await insertOrganization("org-a");
    await insertMembership("org-a");
    await insertScenario(null, "shared");
    await insertScenario(null, "building", false);
    await insertScenario(null, "waiting", false);

    await syncCourseCatalogSnapshot(db, {
      snapshot: snapshot(
        course("public-course", [
          lecture("public-shared", "shared"),
          lecture("public-theory"),
          lecture("public-building", "building"),
        ]),
      ),
      sourceRevision: "public-revision",
      organizationId: null,
      nowUnixMs: 100,
    });
    await syncCourseCatalogSnapshot(db, {
      snapshot: snapshot(
        course(
          "organization-course",
          [
            lecture("organization-shared", "shared"),
            lecture("organization-waiting", "waiting"),
          ],
          false,
        ),
      ),
      sourceRevision: "organization-revision",
      organizationId: "org-a",
      nowUnixMs: 110,
    });
    await insertRun({
      runId: "organization-active",
      scenarioId: "shared",
      organizationId: "org-a",
      active: true,
      courseScopeKey: "organization:org-a",
      courseId: "organization-course",
      lectureId: "organization-shared",
    });

    const catalog = await listCourseCatalogForUser({
      db,
      userId: learnerId,
      organizationId: "org-a",
      capacityPressure: null,
    });
    expect(catalog.courses).toMatchObject([
      {
        courseId: "public-course",
        organizationId: null,
        lectures: [
          {
            lectureId: "public-theory",
            scenarioId: null,
            state: "available",
          },
          {
            lectureId: "public-building",
            scenarioId: "building",
            state: "locked",
            blockedBy: {
              courseId: "public-course",
              lectureId: "public-theory",
            },
          },
        ],
      },
      {
        courseId: "organization-course",
        organizationId: "org-a",
        lectures: [
          {
            lectureId: "organization-shared",
            scenarioId: "shared",
            state: "in_progress",
            activeRunId: "organization-active",
            scenarioReady: true,
          },
          {
            lectureId: "organization-waiting",
            scenarioId: "waiting",
            state: "waiting_for_scenario",
            scenarioReady: false,
          },
        ],
      },
    ]);
    expect(
      catalog.courses
        .flatMap((course) => course.lectures)
        .map((lecture) => lecture.lectureId),
    ).not.toContain("public-shared");

    const noMembership = await listCourseCatalogForUser({
      db,
      userId: "unrelated-user",
      organizationId: "org-a",
    });
    expect(noMembership.courses).toEqual([]);
  });

  it("enforces sequence order, completes pure lectures, and resolves starts", async () => {
    const db = drizzle(env.DB);
    await seedLearnerAndHost();
    await insertScenario(null, "task");
    await syncCourseCatalogSnapshot(db, {
      snapshot: snapshot(
        course("sequence", [
          lecture("theory"),
          lecture("task", "task"),
        ]),
      ),
      sourceRevision: "sequence-revision",
      organizationId: null,
      nowUnixMs: 100,
    });

    await expect(
      loadCourseLectureDetailForUser({
        db,
        userId: learnerId,
        organizationId: null,
        courseId: "sequence",
        lectureId: "task",
      }),
    ).resolves.toEqual({
      ok: false,
      blockedBy: { courseId: "sequence", lectureId: "theory", title: "theory" },
    });
    await expect(
      assertCourseScenarioStartAllowed({
        db,
        userId: learnerId,
        organizationId: null,
        scenarioId: "task",
      }),
    ).rejects.toMatchObject({ code: "course_lecture_locked" });
    await expect(
      loadCourseLectureDetailForUser({
        db,
        userId: learnerId,
        organizationId: null,
        courseId: "sequence",
        lectureId: "task",
        allowSequenceBypass: true,
      }),
    ).resolves.toMatchObject({
      ok: true,
      detail: { lecture: { state: "available" } },
    });

    const completed = await completePureCourseLectureForUser({
      db,
      userId: learnerId,
      organizationId: null,
      courseId: "sequence",
      lectureId: "theory",
      nowUnixMs: 500,
    });
    expect(completed.lecture).toMatchObject({
      state: "completed",
      nextLecture: { courseId: "sequence", lectureId: "task", title: "task" },
    });
    await completePureCourseLectureForUser({
      db,
      userId: learnerId,
      organizationId: null,
      courseId: "sequence",
      lectureId: "theory",
      nowUnixMs: 600,
    });
    await expect(db.select().from(courseUnitCompletions)).resolves.toHaveLength(
      1,
    );

    await expect(
      assertCourseScenarioStartAllowed({
        db,
        userId: learnerId,
        organizationId: null,
        scenarioId: "task",
      }),
    ).resolves.toMatchObject({
      courseScopeKey: "public",
      courseId: "sequence",
      lectureId: "task",
      lectureOrdinal: 2,
      lectureCount: 2,
      scenarioReady: true,
    });
    await expect(
      resolveCourseLectureForScenario({
        db,
        userId: learnerId,
        organizationId: null,
        scenarioId: "not-linked",
      }),
    ).resolves.toBeNull();
  });

  it("selects the requested public or private course source on ID collision", async () => {
    const db = drizzle(env.DB);
    await seedLearnerAndHost();
    await insertOrganization("org-a");
    await insertMembership("org-a");
    await syncCourseCatalogSnapshot(db, {
      snapshot: snapshot(course("shared-id", [lecture("public-theory")])),
      sourceRevision: "public-revision",
      organizationId: null,
      nowUnixMs: 100,
    });
    await syncCourseCatalogSnapshot(db, {
      snapshot: snapshot(course("shared-id", [lecture("private-theory")])),
      sourceRevision: "private-revision",
      organizationId: "org-a",
      nowUnixMs: 110,
    });

    await expect(
      loadCourseLectureDetailForUser({
        db,
        userId: learnerId,
        organizationId: "org-a",
        courseId: "shared-id",
        lectureId: "public-theory",
        courseScope: "public",
      }),
    ).resolves.toMatchObject({
      ok: true,
      detail: { course: { organizationId: null } },
    });
    await expect(
      loadCourseLectureDetailForUser({
        db,
        userId: learnerId,
        organizationId: "org-a",
        courseId: "shared-id",
        lectureId: "private-theory",
        courseScope: "private",
      }),
    ).resolves.toMatchObject({
      ok: true,
      detail: { course: { organizationId: "org-a" } },
    });
  });

  it("records only solved successful linked runs, including Finish and save teardown", async () => {
    const db = drizzle(env.DB);
    await seedLearnerAndHost();
    await insertRun({
      runId: "solved-run",
      scenarioId: "task",
      state: "completed",
      solvedAt: 200,
      completedAt: 300,
      deleteRequestedAt: 250,
      courseScopeKey: "public",
      courseId: "course",
      lectureId: "task-lecture",
    });
    await insertRun({
      runId: "unsolved-run",
      scenarioId: "task",
      state: "completed",
      solvedAt: null,
      courseScopeKey: "public",
      courseId: "course",
      lectureId: "unsolved-lecture",
    });
    await insertRun({
      runId: "failed-run",
      scenarioId: "task",
      state: "failed",
      solvedAt: 200,
      courseScopeKey: "public",
      courseId: "course",
      lectureId: "failed-lecture",
    });

    await recordLinkedCourseUnitCompletionForRun(db, { runId: "solved-run" });
    await recordLinkedCourseUnitCompletionForRun(db, { runId: "solved-run" });
    await recordLinkedCourseUnitCompletionForRun(db, { runId: "unsolved-run" });
    await recordLinkedCourseUnitCompletionForRun(db, { runId: "failed-run" });
    await expect(db.select().from(courseUnitCompletions)).resolves.toEqual([
      expect.objectContaining({
        userId: learnerId,
        courseId: "course",
        lectureId: "task-lecture",
        sourceRunId: "solved-run",
        completedAt: 300,
      }),
    ]);
  });

  it("overlays Markdown presentation without changing technical scenario data", () => {
    const lesson = lecture("presentation", "task", {
      title: "Markdown title",
      summary: "Markdown summary",
      bodyMarkdown: "Markdown body",
      category: "markdown-category",
      tags: ["markdown"],
      difficulty: "hard",
      estimatedMinutes: 42,
    });
    const manifest = {
      schema_version: 4,
      scenario_id: "task",
      name: "task",
      title: "Technical title",
      category: "technical",
      description: "Technical description",
      difficulty: "easy",
      estimated_minutes: 10,
      tags: ["technical"],
      briefing_markdown: "Technical context",
      solution_markdown: "Technical solution",
      hints: [],
      vms: [],
    } satisfies ScenarioManifestV4;
    const scenarioPresentation = {
      title: "Technical title",
      tagline: "Technical description",
      category: "technical",
      difficulty: "easy",
      estimatedMinutes: 10,
      briefingMarkdown: "Technical context",
      tags: ["technical"],
      objectives: [],
    } satisfies ScenarioBriefing;

    expect(
      findCourseLecturePresentation(
        snapshot(course("presentation", [lesson])),
        "task",
      ),
    ).toBe(lesson);
    expect(
      findCourseLecturePresentation(
        snapshot(course("presentation", [lesson])),
        "missing",
      ),
    ).toBeNull();

    expect(applyLecturePresentation(manifest, lesson)).toMatchObject({
      title: "Markdown title",
      category: "markdown-category",
      description: "Markdown summary",
      difficulty: "hard",
      estimated_minutes: 42,
      tags: ["markdown"],
      briefing_markdown: "Markdown body",
      solution_markdown: "Technical solution",
    });
    expect(
      applyLectureBriefingPresentation(scenarioPresentation, lesson),
    ).toMatchObject({
      title: "Markdown title",
      tagline: "Markdown summary",
      category: "markdown-category",
      difficulty: "hard",
      estimatedMinutes: 42,
      tags: ["markdown"],
      briefingMarkdown: "Markdown body",
      objectives: [],
    });
  });
});

function snapshot(
  ...courses: CourseCatalogCourseV2[]
): CourseCatalogSnapshotV2 {
  return { version: 2, courses };
}

function course(
  courseId: string,
  lectures: CourseCatalogLectureV2[],
  sequential = true,
): CourseCatalogCourseV2 {
  return {
    courseId,
    title: courseId,
    summary: `${courseId} summary`,
    bodyMarkdown: `${courseId} body`,
    sequential,
    lectures,
  };
}

function lecture(
  lectureId: string,
  scenarioId?: string,
  overrides: Partial<CourseCatalogLectureV2> = {},
): CourseCatalogLectureV2 {
  return {
    lectureId,
    title: lectureId,
    summary: `${lectureId} summary`,
    bodyMarkdown: `${lectureId} body`,
    category: "test",
    tags: ["test"],
    difficulty: "easy",
    estimatedMinutes: 15,
    ...(scenarioId ? { scenarioId } : {}),
    ...overrides,
  };
}

async function seedLearnerAndHost(): Promise<void> {
  const db = drizzle(env.DB);
  await db.insert(user).values({
    id: learnerId,
    name: "Learner",
    email: "learner@example.test",
    emailVerified: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
  await db.insert(agentHosts).values({
    id: "host",
    userId: learnerId,
    name: "Host",
    createdAt: 1,
    updatedAt: 1,
  });
}

async function insertOrganization(id: string): Promise<void> {
  await drizzle(env.DB).insert(organization).values({
    id,
    name: id,
    slug: id,
    createdAt: new Date(0),
  });
}

async function insertMembership(organizationId: string): Promise<void> {
  await drizzle(env.DB).insert(member).values({
    id: `${organizationId}:${learnerId}`,
    organizationId,
    userId: learnerId,
    role: "member",
    createdAt: new Date(0),
  });
}

async function insertScenario(
  organizationId: string | null,
  scenarioId: string,
  enabled = true,
): Promise<void> {
  const now = 100;
  await drizzle(env.DB).insert(vmScenarios).values({
    scenarioId,
    organizationId,
    title: scenarioId,
    category: "test",
    description: `${scenarioId} description`,
    difficulty: "easy",
    estimatedMinutes: 10,
    tagsJson: [],
    briefingMarkdown: `${scenarioId} theory`,
    solutionMarkdown: `${scenarioId} solution`,
    hintsJson: [],
    enabled,
    enabledAt: enabled ? now : null,
    createdAt: now,
    updatedAt: now,
  });
}

async function expectScenarioEnabled(
  db: ReturnType<typeof drizzle>,
  scenarioId: string,
  enabled: boolean,
  enabledAt: number | null,
): Promise<void> {
  const [scenario] = await db
    .select({ enabled: vmScenarios.enabled, enabledAt: vmScenarios.enabledAt })
    .from(vmScenarios)
    .where(eq(vmScenarios.scenarioId, scenarioId));
  expect(scenario).toEqual({ enabled, enabledAt });
}

async function insertRun(input: {
  runId: string;
  scenarioId: string;
  organizationId?: string | null;
  state?: "completed" | "failed" | "provisioning";
  active?: boolean;
  solvedAt?: number | null;
  completedAt?: number | null;
  deleteRequestedAt?: number | null;
  courseScopeKey?: string | null;
  courseId?: string | null;
  lectureId?: string | null;
}): Promise<void> {
  const state = input.state ?? "provisioning";
  await drizzle(env.DB).insert(scenarioRuns).values({
    runId: input.runId,
    userId: learnerId,
    organizationId: input.organizationId ?? null,
    hostId: "host",
    scenarioId: input.scenarioId,
    scenarioName: input.scenarioId,
    courseScopeKey: input.courseScopeKey ?? null,
    courseId: input.courseId ?? null,
    courseTitle: input.courseId ?? null,
    lectureId: input.lectureId ?? null,
    lectureTitle: input.lectureId ?? null,
    lectureSummary: input.lectureId ? `${input.lectureId} summary` : null,
    lectureBodyMarkdown: input.lectureId ? `${input.lectureId} body` : null,
    lectureOrdinal: input.lectureId ? 1 : null,
    lectureCount: input.lectureId ? 1 : null,
    title: input.scenarioId,
    tagline: "Test",
    briefingMarkdown: "Lecture theory",
    objectivesJson: "[]",
    difficulty: "easy",
    estimatedMinutes: 10,
    tagsJson: [],
    hintsJson: [],
    solutionMarkdown: "Solution",
    revealedHintsJson: [],
    solutionAssisted: false,
    vmCount: 1,
    state,
    stateRank: 1,
    activeKey: input.active ? learnerId : null,
    stateJson: "{}",
    deleteRequestedAt: input.deleteRequestedAt ?? null,
    solvedAt: input.solvedAt ?? null,
    completedAt:
      input.completedAt ?? (state === "completed" ? 1_000 : null),
    failedAt: state === "failed" ? 1_000 : null,
    hiddenAt: null,
    createdAt: 100,
    updatedAt: 100,
  });
}
