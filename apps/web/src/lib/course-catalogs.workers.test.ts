/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import {
  agentHosts,
  courseUnitCompletions,
  runtimeOperationGates,
  member,
  organization,
  courseCatalogs,
  scenarioRevisions,
  scenarioRuns,
  scenarios,
  user,
  type CourseCatalogCourseV2,
  type CourseCatalogLectureV2,
  type CourseCatalogSnapshotV2,
} from "@/db/schema";
import {
  assertCourseScenarioStartAllowed,
  completePureCourseLectureForUser,
  listCourseCatalogForUser,
  loadCourseLectureDetailForUser,
  recordLinkedCourseUnitCompletionForRun,
  resolveCourseLectureForScenario,
} from "@/lib/course-catalogs";
import { IMAGE_CUTOVER_GATE } from "@/lib/run-admission-gate";
import { resetD1Database } from "@/test/d1-migrations";
import { revisionDoc, seedReadyPlatformHost } from "@/lib/scenario-runs/revision-test-fixtures";

const learnerId = "learner";

describe("V2 course catalogs", () => {
  beforeEach(async () => {
    await resetD1Database();
    // A learner on the platform needs a live platform host with the images.
    await seedReadyPlatformHost("platform-ready", [READY_IMAGE]);
  });

  it("defaults capacity to unknown and preserves pressure-only callers", async () => {
    const input = { db: drizzle(env.DB), userId: learnerId, organizationId: null };
    await expect(listCourseCatalogForUser(input)).resolves.toEqual({
      courses: [], capacityPressure: null, resourceCapacity: null,
    });
    await expect(listCourseCatalogForUser({ ...input, capacityPressure: 0 })).resolves.toEqual({
      courses: [], capacityPressure: 0, resourceCapacity: null,
    });
  });

  it.each([null, "org-a"])("returns both capacity signals for scope %s", async (organizationId) => {
    await seedLearnerAndHost();
    if (organizationId) {
      await insertOrganization(organizationId);
      await insertMembership(organizationId);
    }
    const resourceCapacity = {
      cpu: { availableMillis: 0, totalMillis: 4_000 },
      memory: { availableMib: 512, totalMib: 8_192 },
    };
    await expect(listCourseCatalogForUser({
      db: drizzle(env.DB), userId: learnerId, organizationId,
      capacityPressure: 100, resourceCapacity,
    })).resolves.toEqual({ courses: [], capacityPressure: 100, resourceCapacity });
  });

  it("lists public and organization courses that link more than 100 scenarios", async () => {
    const db = drizzle(env.DB);
    await seedLearnerAndHost();
    await insertOrganization("org-a");
    await insertMembership("org-a");
    for (const [organizationId, prefix] of [[null, "public"], ["org-a", "org-a"]] as const) {
      const ids = Array.from({ length: 60 }, (_, index) => `s/${prefix}-${index}`);
      for (const scenarioId of ids) await insertScenario(organizationId, scenarioId);
      await publishCatalog(db, {
        snapshot: snapshot(
          course(`${prefix}-course`, ids.map((scenarioId) => lecture(scenarioId.slice(2), scenarioId)), false),
        ),
        sourceRevision: `${prefix}-revision`,
        organizationId,
        nowUnixMs: 200,
      });
    }

    const catalog = await listCourseCatalogForUser({
      db,
      userId: learnerId,
      organizationId: "org-a",
    });

    expect(catalog.courses.map((item) => [item.courseId, item.lectures.length])).toEqual([
      ["public-course", 60],
      ["org-a-course", 60],
    ]);
    expect(
      catalog.courses.flatMap((item) => item.lectures).every((item) => item.scenarioReady),
    ).toBe(true);
  });

  it("shows public and organization courses with linked-scenario override", async () => {
    const db = drizzle(env.DB);
    await seedLearnerAndHost();
    await insertOrganization("org-a");
    await insertMembership("org-a");
    await insertScenario(null, "s/shared");
    await insertScenario(null, "s/building", false);
    await insertScenario(null, "s/waiting", false);

    await publishCatalog(db, {
      snapshot: snapshot(
        course("public-course", [
          lecture("public-shared", "s/shared"),
          lecture("public-theory"),
          lecture("public-building", "s/building"),
        ]),
      ),
      sourceRevision: "public-revision",
      organizationId: null,
      nowUnixMs: 100,
    });
    await publishCatalog(db, {
      snapshot: snapshot(
        course(
          "organization-course",
          [
            lecture("organization-shared", "s/shared"),
            lecture("organization-waiting", "s/waiting"),
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
      scenarioId: "s/shared",
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
            scenarioId: "s/building",
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
            scenarioId: "s/shared",
            state: "in_progress",
            activeRunId: "organization-active",
            scenarioReady: true,
          },
          {
            lectureId: "organization-waiting",
            scenarioId: "s/waiting",
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

  it("adds member organization courses to the public catalog", async () => {
    const db = drizzle(env.DB);
    await seedLearnerAndHost();
    await insertOrganization("org-a");
    await insertOrganization("org-b");
    await insertMembership("org-a");
    await insertScenario(null, "s/shared");
    await insertScenario("org-a", "s/org-a-task");
    for (const [organizationId, catalog] of [
      [null, snapshot(course("public-course", [lecture("public-shared", "s/shared")]))],
      ["org-a", snapshot(course("org-a-course", [
        lecture("org-a-shared", "s/shared"),
        lecture("org-a-task", "s/org-a-task"),
      ], false))],
      ["org-b", snapshot(course("org-b-course", [lecture("org-b-theory")]))],
    ] as const) {
      await publishCatalog(db, {
        snapshot: catalog,
        sourceRevision: "revision",
        organizationId,
        nowUnixMs: 100,
      });
    }

    const catalog = await listCourseCatalogForUser({
      db,
      userId: learnerId,
      organizationId: null,
    });

    expect(catalog.courses.map((item) => item.courseId)).toEqual([
      "public-course",
      "org-a-course",
    ]);
    expect(catalog.courses).toMatchObject([
      {
        organizationId: null,
        organizationName: null,
        lectures: [{ lectureId: "public-shared", scenarioReady: true }],
      },
      {
        organizationId: "org-a",
        organizationName: "org-a",
        lectures: [
          { lectureId: "org-a-shared", scenarioReady: true },
          { lectureId: "org-a-task", scenarioReady: true },
        ],
      },
    ]);
    await expect(
      resolveCourseLectureForScenario({
        db,
        userId: learnerId,
        organizationId: null,
        scenarioId: "s/org-a-task",
      }),
    ).resolves.toBeNull();
  });

  it("enforces sequence order, completes pure lectures, and resolves starts", async () => {
    const db = drizzle(env.DB);
    await seedLearnerAndHost();
    await insertScenario(null, "s/task");
    await publishCatalog(db, {
      snapshot: snapshot(
        course("sequence", [
          lecture("theory"),
          lecture("task", "s/task"),
          lecture("final"),
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
        scenarioId: "s/task",
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
      detail: {
        lecture: {
          state: "available",
          previousLecture: {
            courseId: "sequence",
            lectureId: "theory",
            title: "theory",
          },
          nextLecture: {
            courseId: "sequence",
            lectureId: "final",
            title: "final",
          },
          lectureOrdinal: 2,
          lectureCount: 3,
        },
      },
    });

    await expect(
      loadCourseLectureDetailForUser({
        db,
        userId: learnerId,
        organizationId: null,
        courseId: "sequence",
        lectureId: "final",
        allowSequenceBypass: true,
      }),
    ).resolves.toMatchObject({
      ok: true,
      detail: {
        lecture: {
          previousLecture: {
            courseId: "sequence",
            lectureId: "task",
            title: "task",
          },
          nextLecture: null,
          lectureOrdinal: 3,
          lectureCount: 3,
        },
      },
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
      previousLecture: null,
      nextLecture: { courseId: "sequence", lectureId: "task", title: "task" },
      lectureOrdinal: 1,
      lectureCount: 3,
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

    // After the cutover wipe the insert itself refuses, not only a pre-check.
    await db.delete(courseUnitCompletions);
    await db.insert(runtimeOperationGates).values({ key: IMAGE_CUTOVER_GATE, state: "wiped" });
    await expect(completePureCourseLectureForUser({
      db, userId: learnerId, organizationId: null,
      courseId: "sequence", lectureId: "theory", nowUnixMs: 700,
    })).rejects.toMatchObject({ status: 503, code: "runtime_cutover_wiped" });
    await expect(db.select().from(courseUnitCompletions)).resolves.toEqual([]);
    await db.delete(runtimeOperationGates);
    await completePureCourseLectureForUser({
      db, userId: learnerId, organizationId: null,
      courseId: "sequence", lectureId: "theory", nowUnixMs: 800,
    });

    await expect(
      assertCourseScenarioStartAllowed({
        db,
        userId: learnerId,
        organizationId: null,
        scenarioId: "s/task",
      }),
    ).resolves.toMatchObject({
      courseScopeKey: "public",
      courseId: "sequence",
      lectureId: "task",
      lectureOrdinal: 2,
      lectureCount: 3,
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
    await publishCatalog(db, {
      snapshot: snapshot(course("shared-id", [lecture("public-theory")])),
      sourceRevision: "public-revision",
      organizationId: null,
      nowUnixMs: 100,
    });
    await publishCatalog(db, {
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

/** A scenario with a live revision; a disabled one waits for its scenario. */
async function insertScenario(
  organizationId: string | null,
  scenarioId: string,
  enabled = true,
): Promise<void> {
  const db = drizzle(env.DB);
  const [namespace, slug] = scenarioId.split("/") as [string, string];
  await db.insert(scenarios).values({
    id: scenarioId, namespace, slug, organizationId,
    scopeKey: organizationId ? `organization:${organizationId}` : "public",
    enabled, play: false, liveRev: "r1",
  });
  await db.insert(scenarioRevisions).values({
    scenarioId, rev: "r1", guestContract: 3, state: "ready",
    docJson: revisionDoc({ web: READY_IMAGE, client: READY_IMAGE }, { web: `sha256:${"3".repeat(64)}` }),
  });
}

const READY_IMAGE = `sha256:${"7".repeat(64)}`;

/** Publishes a scope's catalog as a promoted revision leaves it. */
async function publishCatalog(
  db: ReturnType<typeof drizzle>,
  input: { snapshot: CourseCatalogSnapshotV2; sourceRevision: string; organizationId: string | null; nowUnixMs: number },
): Promise<void> {
  await db.insert(courseCatalogs).values({
    scopeKey: input.organizationId ? `organization:${input.organizationId}` : "public",
    organizationId: input.organizationId,
    sourceRevision: input.sourceRevision,
    catalogJson: input.snapshot,
    createdAt: input.nowUnixMs,
    updatedAt: input.nowUnixMs,
  });
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
