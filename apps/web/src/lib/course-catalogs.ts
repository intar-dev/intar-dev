import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  sql,
} from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  courseUnitCompletions,
  member,
  courseCatalogs,
  scenarioRuns,
  vmScenarios,
  type CourseCatalogCourseV2,
  type CourseCatalogLectureV2,
  type CourseCatalogSnapshotV2,
} from "@/db/schema";
import type { ScenarioManifestV4 } from "@/generated/catalog";
import { appError } from "@/lib/app-error";
import type { ScenarioBriefing } from "@/lib/scenario-model";

export type {
  CourseCatalogCourseV2,
  CourseCatalogLectureV2,
  CourseCatalogSnapshotV2,
} from "@/db/schema";

const PUBLIC_COURSE_CATALOG_SCOPE = "public";
const COURSE_COMPLETION_SCENARIO_READ_BATCH_SIZE = 96;
const COURSE_COMPLETION_INSERT_BATCH_SIZE = 16;

export type CourseLectureState =
  | "locked"
  | "available"
  | "waiting_for_scenario"
  | "in_progress"
  | "completed";

export type CourseSourceScope = "public" | "private";

export interface CourseLectureBlocker {
  courseId: string;
  lectureId: string;
  title: string;
}

export interface CourseCatalogLectureSummary {
  lectureId: string;
  title: string;
  summary: string;
  category: string;
  tags: string[];
  difficulty?: "easy" | "medium" | "hard";
  estimatedMinutes: number | null;
  scenarioId: string | null;
  state: CourseLectureState;
  blockedBy: CourseLectureBlocker | null;
  activeRunId: string | null;
  scenarioReady: boolean | null;
}

export interface CourseCatalogCourseForUser {
  courseId: string;
  organizationId: string | null;
  title: string;
  summary: string;
  bodyMarkdown: string;
  sequential: boolean;
  lectures: CourseCatalogLectureSummary[];
}

export interface CourseCatalogForUser {
  courses: CourseCatalogCourseForUser[];
  capacityPressure: number | null;
}

export interface CourseLectureDetailForUser extends CourseCatalogLectureSummary {
  bodyMarkdown: string;
  previousLecture: CourseLectureBlocker | null;
  nextLecture: CourseLectureBlocker | null;
  lectureOrdinal: number;
  lectureCount: number;
}

export interface CourseLectureDetailResponse {
  course: Omit<CourseCatalogCourseForUser, "bodyMarkdown" | "lectures">;
  lecture: CourseLectureDetailForUser;
}

export type CourseLectureDetailResult =
  | { ok: true; detail: CourseLectureDetailResponse }
  | { ok: false; blockedBy: CourseLectureBlocker | null };

/**
 * The current course unit for a scenario. The flat fields match the immutable
 * scenario_runs snapshot columns, while `lecture` is useful for presentation.
 */
export interface ResolvedCourseLecture {
  courseScopeKey: string;
  organizationId: string | null;
  courseId: string;
  courseTitle: string;
  lectureId: string;
  lectureTitle: string;
  lectureSummary: string;
  lectureBodyMarkdown: string;
  lectureOrdinal: number;
  lectureCount: number;
  scenarioId: string;
  state: CourseLectureState;
  blockedBy: CourseLectureBlocker | null;
  activeRunId: string | null;
  scenarioReady: boolean;
  course: CourseCatalogCourseV2;
  lecture: CourseCatalogLectureV2;
}

export type LecturePresentation = Pick<
  CourseCatalogLectureV2,
  | "title"
  | "summary"
  | "bodyMarkdown"
  | "category"
  | "tags"
  | "difficulty"
  | "estimatedMinutes"
>;

interface CourseSource {
  scopeKey: string;
  organizationId: string | null;
  course: CourseCatalogCourseV2;
}

interface LectureView {
  lecture: CourseCatalogLectureV2;
  state: CourseLectureState;
  blockedBy: CourseLectureBlocker | null;
  activeRunId: string | null;
  scenarioReady: boolean | null;
}

interface CourseView extends CourseSource {
  lectures: LectureView[];
}

export function courseCatalogScopeKey(
  organizationId: string | null,
): string {
  return organizationId
    ? `organization:${organizationId}`
    : PUBLIC_COURSE_CATALOG_SCOPE;
}

export async function validateCourseCatalogReferences(
  db: DrizzleD1Database,
  input: {
    snapshot: CourseCatalogSnapshotV2;
    bundleScenarioIds: Iterable<string>;
    organizationId: string | null;
  },
): Promise<string[]> {
  assertV2Snapshot(input.snapshot);
  const referencedIds = linkedScenarioIds(input.snapshot);
  if (!referencedIds.length) {
    return [];
  }

  // Load disabled rows too. An existing row in another scope cannot be
  // claimed by this upload, even when the catalog does not expose it.
  const rows = await db
    .select({
      scenarioId: vmScenarios.scenarioId,
      organizationId: vmScenarios.organizationId,
      enabled: vmScenarios.enabled,
    })
    .from(vmScenarios);
  const existingById = new Map(rows.map((row) => [row.scenarioId, row]));
  const bundledIds = new Set(input.bundleScenarioIds);
  const invalidScenarioIds: string[] = [];

  for (const scenarioId of referencedIds) {
    const existing = existingById.get(scenarioId);
    const bundled = bundledIds.has(scenarioId);
    const existingIsInUploadScope =
      !existing || existing.organizationId === input.organizationId;

    if (bundled) {
      if (!existingIsInUploadScope) invalidScenarioIds.push(scenarioId);
      continue;
    }

    const existingIsVisible = Boolean(
      existing &&
        existing.enabled &&
        (existing.organizationId === null ||
          existing.organizationId === input.organizationId),
    );
    if (!existingIsVisible) invalidScenarioIds.push(scenarioId);
  }

  return invalidScenarioIds;
}

/** Replaces the complete V2 snapshot for one publication scope. */
export async function syncCourseCatalogSnapshot(
  db: DrizzleD1Database,
  input: {
    snapshot: CourseCatalogSnapshotV2;
    sourceRevision: string;
    organizationId: string | null;
    nowUnixMs: number;
  },
): Promise<void> {
  assertV2Snapshot(input.snapshot);
  const scopeKey = courseCatalogScopeKey(input.organizationId);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const [existing] = await db
      .select({
        catalog: courseCatalogs.catalogJson,
        sourceRevision: courseCatalogs.sourceRevision,
        updatedAt: courseCatalogs.updatedAt,
      })
      .from(courseCatalogs)
      .where(eq(courseCatalogs.scopeKey, scopeKey))
      .limit(1);

    if (!existing) {
      const inserted = await db
        .insert(courseCatalogs)
        .values({
          scopeKey,
          organizationId: input.organizationId,
          catalogJson: input.snapshot,
          sourceRevision: input.sourceRevision,
          createdAt: input.nowUnixMs,
          updatedAt: input.nowUnixMs,
        })
        .onConflictDoNothing()
        .returning({ scopeKey: courseCatalogs.scopeKey });
      if (inserted.length) {
        await syncScenarioPresentationFromCourseCatalog(db, input);
        await disableUnlinkedScenariosFromCourseCatalog(db, input);
        await backfillCourseUnitCompletions(db, {
          snapshot: input.snapshot,
          organizationId: input.organizationId,
        });
        return;
      }
      continue;
    }

    const sameCatalog =
      JSON.stringify(existing.catalog) === JSON.stringify(input.snapshot);
    if (sameCatalog && existing.sourceRevision === input.sourceRevision) {
      await syncScenarioPresentationFromCourseCatalog(db, input);
      await disableUnlinkedScenariosFromCourseCatalog(db, input);
      await backfillCourseUnitCompletions(db, {
        snapshot: input.snapshot,
        organizationId: input.organizationId,
      });
      return;
    }

    const encodedExistingCatalog = JSON.stringify(existing.catalog);
    const updated = await db
      .update(courseCatalogs)
      .set({
        catalogJson: input.snapshot,
        sourceRevision: input.sourceRevision,
        updatedAt: Math.max(input.nowUnixMs, existing.updatedAt + 1),
      })
      .where(
        and(
          eq(courseCatalogs.scopeKey, scopeKey),
          eq(courseCatalogs.sourceRevision, existing.sourceRevision),
          eq(courseCatalogs.updatedAt, existing.updatedAt),
          sql`${courseCatalogs.catalogJson} = ${encodedExistingCatalog}`,
        ),
      )
      .returning({ scopeKey: courseCatalogs.scopeKey });
    if (updated.length) {
      await syncScenarioPresentationFromCourseCatalog(db, input);
      await disableUnlinkedScenariosFromCourseCatalog(db, input);
      return;
    }
  }

  throw new Error("course catalog update did not converge");
}

/**
 * A Markdown-only publish has no VM build. Keep the persisted presentation
 * current for same-scope scenarios so ordinary detail/run reads do not retain
 * stale HCL-era text. Organization courses that point at public scenarios are
 * kept as request-time overlays and therefore do not rewrite public content.
 */
async function syncScenarioPresentationFromCourseCatalog(
  db: DrizzleD1Database,
  input: {
    snapshot: CourseCatalogSnapshotV2;
    sourceRevision: string;
    organizationId: string | null;
    nowUnixMs: number;
  },
): Promise<void> {
  const byScenario = new Map<string, LecturePresentation>();
  for (const course of input.snapshot.courses) {
    for (const lecture of course.lectures) {
      if (lecture.scenarioId) byScenario.set(lecture.scenarioId, lecture);
    }
  }
  const scenarioIds = [...byScenario.keys()];
  if (!scenarioIds.length) return;

  const rows = await db
    .select({
      scenarioId: vmScenarios.scenarioId,
      organizationId: vmScenarios.organizationId,
      difficulty: vmScenarios.difficulty,
    })
    .from(vmScenarios)
    .where(inArray(vmScenarios.scenarioId, scenarioIds));
  for (const row of rows) {
    if (row.organizationId !== input.organizationId) continue;
    const lecture = byScenario.get(row.scenarioId);
    if (!lecture) continue;
    await db
      .update(vmScenarios)
      .set({
        sourceRevision: input.sourceRevision,
        title: lecture.title,
        category: lecture.category,
        description: lecture.summary,
        difficulty: lecture.difficulty ?? row.difficulty,
        estimatedMinutes: lecture.estimatedMinutes,
        tagsJson: [...lecture.tags],
        briefingMarkdown: lecture.bodyMarkdown,
        updatedAt: input.nowUnixMs,
      })
      .where(eq(vmScenarios.scenarioId, row.scenarioId));
  }
}

/** Disables enabled technical scenarios that the replacement catalog omits. */
async function disableUnlinkedScenariosFromCourseCatalog(
  db: DrizzleD1Database,
  input: {
    snapshot: CourseCatalogSnapshotV2;
    organizationId: string | null;
    nowUnixMs: number;
  },
): Promise<void> {
  const scenarioIds = linkedScenarioIds(input.snapshot);
  const scope = input.organizationId
    ? eq(vmScenarios.organizationId, input.organizationId)
    : isNull(vmScenarios.organizationId);
  const omitted = scenarioIds.length
    ? notInArray(vmScenarios.scenarioId, scenarioIds)
    : undefined;

  await db
    .update(vmScenarios)
    .set({ enabled: false, enabledAt: null, updatedAt: input.nowUnixMs })
    .where(and(scope, eq(vmScenarios.enabled, true), omitted));
}

/**
 * Lists public courses plus the current organization catalog. An organization
 * lecture that links a scenario hides the public lecture for that scenario.
 */
export async function listCourseCatalogForUser(input: {
  db: DrizzleD1Database;
  userId: string;
  organizationId: string | null;
  capacityPressure?: number | null;
  allowSequenceBypass?: boolean;
}): Promise<CourseCatalogForUser> {
  const views = await loadCourseViews(input);
  return {
    courses: views.map(toCourseCatalogCourseForUser),
    capacityPressure: input.capacityPressure ?? null,
  };
}

/** Loads a lecture body only when the learner can access that unit. */
export async function loadCourseLectureDetailForUser(input: {
  db: DrizzleD1Database;
  userId: string;
  organizationId: string | null;
  courseId: string;
  lectureId: string;
  courseScope?: CourseSourceScope;
  allowSequenceBypass?: boolean;
}): Promise<CourseLectureDetailResult> {
  const views = await loadCourseViews(input);
  const course = findCourseView(
    views,
    input.courseId,
    input.organizationId,
    input.courseScope,
  );
  if (!course) {
    throw appError(404, "course_not_found", "course not found");
  }
  const lectureIndex = course.lectures.findIndex(
    (candidate) => candidate.lecture.lectureId === input.lectureId,
  );
  if (lectureIndex < 0) {
    throw appError(404, "course_lecture_not_found", "lecture not found");
  }
  const lecture = course.lectures[lectureIndex];
  if (!lecture) {
    throw appError(404, "course_lecture_not_found", "lecture not found");
  }
  if (lecture.state === "locked") {
    return { ok: false, blockedBy: lecture.blockedBy };
  }

  const previous = course.lectures[lectureIndex - 1];
  const next = course.lectures[lectureIndex + 1];
  return {
    ok: true,
    detail: {
      course: {
        courseId: course.course.courseId,
        organizationId: course.organizationId,
        title: course.course.title,
        summary: course.course.summary,
        sequential: course.course.sequential,
      },
      lecture: {
        ...toCourseLectureSummary(lecture),
        bodyMarkdown: lecture.lecture.bodyMarkdown,
        previousLecture: previous
          ? courseLectureBlocker(course.course.courseId, previous.lecture)
          : null,
        nextLecture: next
          ? courseLectureBlocker(course.course.courseId, next.lecture)
          : null,
        lectureOrdinal: lectureIndex + 1,
        lectureCount: course.lectures.length,
      },
    },
  };
}

/** Completes a theory-only lecture. The operation is idempotent. */
export async function completePureCourseLectureForUser(input: {
  db: DrizzleD1Database;
  userId: string;
  organizationId: string | null;
  courseId: string;
  lectureId: string;
  nowUnixMs: number;
  courseScope?: CourseSourceScope;
  allowSequenceBypass?: boolean;
}): Promise<CourseLectureDetailResponse> {
  const before = await loadCourseLectureDetailForUser(input);
  if (!before.ok) {
    throw appError(
      409,
      "course_lecture_locked",
      "complete the required lecture first",
    );
  }
  if (before.detail.lecture.scenarioId !== null) {
    throw appError(
      409,
      "course_lecture_requires_scenario",
      "this lecture is completed by its scenario",
    );
  }

  const scopeKey = courseCatalogScopeKey(
    before.detail.course.organizationId,
  );
  await input.db
    .insert(courseUnitCompletions)
    .values({
      userId: input.userId,
      scopeKey,
      courseId: before.detail.course.courseId,
      lectureId: before.detail.lecture.lectureId,
      sourceRunId: null,
      completedAt: input.nowUnixMs,
    })
    .onConflictDoNothing();

  const after = await loadCourseLectureDetailForUser(input);
  if (!after.ok) {
    throw appError(
      409,
      "course_lecture_locked",
      "complete the required lecture first",
    );
  }
  return after.detail;
}

/** Resolves the visible course unit that owns a scenario. */
export async function resolveCourseLectureForScenario(input: {
  db: DrizzleD1Database;
  userId: string;
  organizationId: string | null;
  scenarioId: string;
  allowSequenceBypass?: boolean;
}): Promise<ResolvedCourseLecture | null> {
  const views = await loadCourseViews(input);
  const orderedViews = input.organizationId
    ? [
        ...views.filter(
          (course) => course.organizationId === input.organizationId,
        ),
        ...views.filter((course) => course.organizationId === null),
      ]
    : views;
  for (const course of orderedViews) {
    const lectureIndex = course.lectures.findIndex(
      (candidate) => candidate.lecture.scenarioId === input.scenarioId,
    );
    if (lectureIndex < 0) continue;

    const lecture = course.lectures[lectureIndex];
    if (!lecture) continue;
    return {
      courseScopeKey: course.scopeKey,
      organizationId: course.organizationId,
      courseId: course.course.courseId,
      courseTitle: course.course.title,
      lectureId: lecture.lecture.lectureId,
      lectureTitle: lecture.lecture.title,
      lectureSummary: lecture.lecture.summary,
      lectureBodyMarkdown: lecture.lecture.bodyMarkdown,
      lectureOrdinal: lectureIndex + 1,
      lectureCount: course.lectures.length,
      scenarioId: input.scenarioId,
      state: lecture.state,
      blockedBy: lecture.blockedBy,
      activeRunId: lecture.activeRunId,
      scenarioReady: lecture.scenarioReady === true,
      course: course.course,
      lecture: lecture.lecture,
    };
  }
  return null;
}

/**
 * Enforces catalog membership, course order, and scenario readiness before
 * scenario admission. Membership and host admission stay in their own guards.
 */
export async function assertCourseScenarioStartAllowed(input: {
  db: DrizzleD1Database;
  userId: string;
  organizationId: string | null;
  scenarioId: string;
  allowSequenceBypass?: boolean;
}): Promise<ResolvedCourseLecture> {
  const resolved = await resolveCourseLectureForScenario(input);
  if (!resolved) {
    throw appError(
      404,
      "scenario_not_in_course_catalog",
      "scenario is not available in a course",
    );
  }
  if (resolved.state === "locked") {
    throw appError(
      409,
      "course_lecture_locked",
      "complete the required lecture first",
    );
  }
  if (!resolved.scenarioReady) {
    throw appError(
      409,
      "course_scenario_waiting",
      "scenario image is not ready",
    );
  }
  return resolved;
}

/**
 * Stores durable completion for a solved, successfully finished linked unit.
 * It is safe to call more than once for the same run.
 */
export async function recordLinkedCourseUnitCompletionForRun<
  TSchema extends Record<string, unknown>,
>(
  db: DrizzleD1Database<TSchema>,
  input: { runId: string; nowUnixMs?: number },
): Promise<void> {
  const [run] = await db
    .select({
      runId: scenarioRuns.runId,
      userId: scenarioRuns.userId,
      courseScopeKey: scenarioRuns.courseScopeKey,
      courseId: scenarioRuns.courseId,
      lectureId: scenarioRuns.lectureId,
      state: scenarioRuns.state,
      solvedAt: scenarioRuns.solvedAt,
      completedAt: scenarioRuns.completedAt,
    })
    .from(scenarioRuns)
    .where(eq(scenarioRuns.runId, input.runId))
    .limit(1);
  if (
    !run ||
    run.state !== "completed" ||
    run.solvedAt === null ||
    !run.courseScopeKey ||
    !run.courseId ||
    !run.lectureId
  ) {
    return;
  }

  await db
    .insert(courseUnitCompletions)
    .values({
      userId: run.userId,
      scopeKey: run.courseScopeKey,
      courseId: run.courseId,
      lectureId: run.lectureId,
      sourceRunId: run.runId,
      completedAt: input.nowUnixMs ?? run.completedAt ?? run.solvedAt,
    })
    .onConflictDoNothing();
}

/**
 * Backfills linked completion only when a scope receives its first V2 catalog.
 * Existing completion rows make a repeated call harmless.
 */
export async function backfillCourseUnitCompletions(
  db: DrizzleD1Database,
  input: {
    snapshot: CourseCatalogSnapshotV2;
    organizationId: string | null;
  },
): Promise<void> {
  assertV2Snapshot(input.snapshot);
  const scenarioIds = linkedScenarioIds(input.snapshot);
  if (!scenarioIds.length) return;

  const successfulRuns: Array<{
    runId: string;
    userId: string;
    scenarioId: string;
    solvedAt: number | null;
    completedAt: number | null;
  }> = [];
  for (const scenarioBatch of chunked(
    scenarioIds,
    COURSE_COMPLETION_SCENARIO_READ_BATCH_SIZE,
  )) {
    successfulRuns.push(
      ...(await db
        .select({
          runId: scenarioRuns.runId,
          userId: scenarioRuns.userId,
          scenarioId: scenarioRuns.scenarioId,
          solvedAt: scenarioRuns.solvedAt,
          completedAt: scenarioRuns.completedAt,
        })
        .from(scenarioRuns)
        .where(
          and(
            inArray(scenarioRuns.scenarioId, scenarioBatch),
            eq(scenarioRuns.state, "completed"),
            isNotNull(scenarioRuns.solvedAt),
            ...(input.organizationId
              ? [eq(scenarioRuns.organizationId, input.organizationId)]
              : []),
          ),
        )),
    );
  }
  const earliestRunByUserScenario = new Map<
    string,
    (typeof successfulRuns)[number]
  >();
  for (const run of successfulRuns) {
    const key = `${run.userId}\u0000${run.scenarioId}`;
    const current = earliestRunByUserScenario.get(key);
    const completedAt = run.completedAt ?? run.solvedAt ?? 0;
    const currentCompletedAt = current
      ? (current.completedAt ?? current.solvedAt ?? 0)
      : Number.POSITIVE_INFINITY;
    if (!current || completedAt < currentCompletedAt) {
      earliestRunByUserScenario.set(key, run);
    }
  }

  const scopeKey = courseCatalogScopeKey(input.organizationId);
  const completions: Array<typeof courseUnitCompletions.$inferInsert> = [];
  for (const course of input.snapshot.courses) {
    for (const lecture of course.lectures) {
      if (!lecture.scenarioId) continue;
      for (const run of earliestRunByUserScenario.values()) {
        if (run.scenarioId !== lecture.scenarioId) continue;
        completions.push({
          userId: run.userId,
          scopeKey,
          courseId: course.courseId,
          lectureId: lecture.lectureId,
          sourceRunId: run.runId,
          completedAt: run.completedAt ?? run.solvedAt ?? 0,
        });
      }
    }
  }
  if (!completions.length) return;

  const completionBatches = chunked(
    completions,
    COURSE_COMPLETION_INSERT_BATCH_SIZE,
  );
  const firstBatch = completionBatches[0];
  if (!firstBatch) return;
  await db.batch([
    db.insert(courseUnitCompletions).values(firstBatch).onConflictDoNothing(),
    ...completionBatches.slice(1).map((batch) =>
      db.insert(courseUnitCompletions).values(batch).onConflictDoNothing(),
    ),
  ]);
}

function chunked<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size));
  }
  return chunks;
}

/** Finds the Markdown presentation associated with one technical scenario. */
export function findCourseLecturePresentation(
  snapshot: CourseCatalogSnapshotV2,
  scenarioId: string,
): LecturePresentation | null {
  assertV2Snapshot(snapshot);
  for (const course of snapshot.courses) {
    const lecture = course.lectures.find(
      (candidate) => candidate.scenarioId === scenarioId,
    );
    if (lecture) return lecture;
  }
  return null;
}

/** Applies Markdown lecture presentation to a technical scenario manifest. */
export function applyLecturePresentation(
  manifest: ScenarioManifestV4,
  lecture: LecturePresentation,
): ScenarioManifestV4 {
  return {
    ...manifest,
    title: lecture.title,
    category: lecture.category,
    description: lecture.summary,
    difficulty: lecture.difficulty ?? manifest.difficulty,
    estimated_minutes: lecture.estimatedMinutes,
    tags: [...lecture.tags],
    briefing_markdown: lecture.bodyMarkdown,
  };
}

/** Applies the same learner presentation to a loaded scenario briefing. */
export function applyLectureBriefingPresentation(
  briefing: ScenarioBriefing,
  lecture: LecturePresentation,
): ScenarioBriefing {
  return {
    ...briefing,
    title: lecture.title,
    tagline: lecture.summary,
    category: lecture.category,
    difficulty: lecture.difficulty ?? briefing.difficulty,
    estimatedMinutes: lecture.estimatedMinutes,
    tags: [...lecture.tags],
    briefingMarkdown: lecture.bodyMarkdown,
  };
}

async function loadCourseViews(input: {
  db: DrizzleD1Database;
  userId: string;
  organizationId: string | null;
  allowSequenceBypass?: boolean;
}): Promise<CourseView[]> {
  if (input.organizationId) {
    const [membership] = await input.db
      .select({ id: member.id })
      .from(member)
      .where(
        and(
          eq(member.organizationId, input.organizationId),
          eq(member.userId, input.userId),
        ),
      )
      .limit(1);
    if (!membership) return [];
  }
  const sources = await loadVisibleCourseSources(input.db, input.organizationId);
  if (!sources.length) return [];

  const scopeKeys = [...new Set(sources.map((source) => source.scopeKey))];
  const scenarioIds = [
    ...new Set(
      sources.flatMap((source) =>
        source.course.lectures.flatMap((lecture) =>
          lecture.scenarioId ? [lecture.scenarioId] : [],
        ),
      ),
    ),
  ];
  const [completionRows, activeRunRows, scenarioRows] = await Promise.all([
    input.db
      .select({
        scopeKey: courseUnitCompletions.scopeKey,
        courseId: courseUnitCompletions.courseId,
        lectureId: courseUnitCompletions.lectureId,
      })
      .from(courseUnitCompletions)
      .where(
        and(
          eq(courseUnitCompletions.userId, input.userId),
          inArray(courseUnitCompletions.scopeKey, scopeKeys),
        ),
      ),
    input.db
      .select({
        runId: scenarioRuns.runId,
        courseScopeKey: scenarioRuns.courseScopeKey,
        courseId: scenarioRuns.courseId,
        lectureId: scenarioRuns.lectureId,
      })
      .from(scenarioRuns)
      .where(
        and(
          eq(scenarioRuns.userId, input.userId),
          isNotNull(scenarioRuns.activeKey),
        ),
      ),
    scenarioIds.length
      ? input.db
          .select({
            scenarioId: vmScenarios.scenarioId,
            organizationId: vmScenarios.organizationId,
            enabled: vmScenarios.enabled,
            enabledAt: vmScenarios.enabledAt,
          })
          .from(vmScenarios)
          .where(inArray(vmScenarios.scenarioId, scenarioIds))
      : Promise.resolve([]),
  ]);
  const completedUnitKeys = new Set(
    completionRows.map((row) =>
      courseUnitKey(row.scopeKey, row.courseId, row.lectureId),
    ),
  );
  const activeRunByUnitKey = new Map<string, string>();
  for (const run of activeRunRows) {
    if (!run.courseScopeKey || !run.courseId || !run.lectureId) continue;
    activeRunByUnitKey.set(
      courseUnitKey(run.courseScopeKey, run.courseId, run.lectureId),
      run.runId,
    );
  }
  const scenarioById = new Map(
    scenarioRows.map((scenario) => [scenario.scenarioId, scenario]),
  );

  return sources.map((source) => {
    let firstIncomplete: CourseLectureBlocker | null = null;
    const lectures = source.course.lectures.map((lecture) => {
      const unitKey = courseUnitKey(
        source.scopeKey,
        source.course.courseId,
        lecture.lectureId,
      );
      const completed = completedUnitKeys.has(unitKey);
      const activeRunId = activeRunByUnitKey.get(unitKey) ?? null;
      const scenarioReady = lecture.scenarioId
        ? isScenarioReady(
            scenarioById.get(lecture.scenarioId),
            input.organizationId,
          )
        : null;
      const blockedBy =
        source.course.sequential &&
        !input.allowSequenceBypass &&
        !completed &&
        !activeRunId
          ? firstIncomplete
          : null;
      const state: CourseLectureState = completed
        ? "completed"
        : activeRunId
          ? "in_progress"
          : blockedBy
            ? "locked"
            : scenarioReady === false
              ? "waiting_for_scenario"
              : "available";
      if (!completed && !firstIncomplete) {
        firstIncomplete = courseLectureBlocker(source.course.courseId, lecture);
      }
      return { lecture, state, blockedBy, activeRunId, scenarioReady };
    });
    return { ...source, lectures };
  });
}

async function loadVisibleCourseSources(
  db: DrizzleD1Database,
  organizationId: string | null,
): Promise<CourseSource[]> {
  const scopeKeys = [
    courseCatalogScopeKey(null),
    ...(organizationId ? [courseCatalogScopeKey(organizationId)] : []),
  ];
  const rows = await db
    .select({
      scopeKey: courseCatalogs.scopeKey,
      organizationId: courseCatalogs.organizationId,
      catalog: courseCatalogs.catalogJson,
    })
    .from(courseCatalogs)
    .where(inArray(courseCatalogs.scopeKey, scopeKeys));
  const byScope = new Map(rows.map((row) => [row.scopeKey, row]));
  const publicSnapshot = byScope.get(courseCatalogScopeKey(null))
    ?.catalog;
  const organizationSnapshot = organizationId
    ? byScope.get(courseCatalogScopeKey(organizationId))?.catalog
    : undefined;
  if (publicSnapshot) assertV2Snapshot(publicSnapshot);
  if (organizationSnapshot) assertV2Snapshot(organizationSnapshot);

  const organizationScenarioIds = new Set(
    organizationSnapshot
      ? linkedScenarioIds(organizationSnapshot)
      : [],
  );
  const publicSources = (publicSnapshot?.courses ?? []).flatMap((course) => {
    const lectures = course.lectures.filter(
      (lecture) =>
        !lecture.scenarioId || !organizationScenarioIds.has(lecture.scenarioId),
    );
    return lectures.length
      ? [
          {
            scopeKey: courseCatalogScopeKey(null),
            organizationId: null,
            course: { ...course, lectures },
          },
        ]
      : [];
  });
  const organizationSources = (organizationSnapshot?.courses ?? []).map(
    (course) => ({
      scopeKey: courseCatalogScopeKey(organizationId),
      organizationId,
      course,
    }),
  );
  return [...publicSources, ...organizationSources];
}

function findCourseView(
  views: readonly CourseView[],
  courseId: string,
  organizationId: string | null,
  courseScope?: CourseSourceScope,
): CourseView | undefined {
  if (courseScope === "public") {
    return views.find(
      (course) =>
        course.organizationId === null && course.course.courseId === courseId,
    );
  }
  if (courseScope === "private") {
    return organizationId
      ? views.find(
          (course) =>
            course.organizationId === organizationId &&
            course.course.courseId === courseId,
        )
      : undefined;
  }
  if (organizationId) {
    const privateCourse = views.find(
      (course) =>
        course.organizationId === organizationId &&
        course.course.courseId === courseId,
    );
    if (privateCourse) return privateCourse;
  }
  return views.find(
    (course) =>
      course.organizationId === null && course.course.courseId === courseId,
  );
}

function toCourseCatalogCourseForUser(
  course: CourseView,
): CourseCatalogCourseForUser {
  return {
    courseId: course.course.courseId,
    organizationId: course.organizationId,
    title: course.course.title,
    summary: course.course.summary,
    bodyMarkdown: course.course.bodyMarkdown,
    sequential: course.course.sequential,
    lectures: course.lectures.map(toCourseLectureSummary),
  };
}

function toCourseLectureSummary(
  lecture: LectureView,
): CourseCatalogLectureSummary {
  return {
    lectureId: lecture.lecture.lectureId,
    title: lecture.lecture.title,
    summary: lecture.lecture.summary,
    category: lecture.lecture.category,
    tags: [...lecture.lecture.tags],
    ...(lecture.lecture.difficulty
      ? { difficulty: lecture.lecture.difficulty }
      : {}),
    estimatedMinutes: lecture.lecture.estimatedMinutes,
    scenarioId: lecture.lecture.scenarioId ?? null,
    state: lecture.state,
    blockedBy: lecture.blockedBy,
    activeRunId: lecture.activeRunId,
    scenarioReady: lecture.scenarioReady,
  };
}

function courseLectureBlocker(
  courseId: string,
  lecture: Pick<CourseCatalogLectureV2, "lectureId" | "title">,
): CourseLectureBlocker {
  return { courseId, lectureId: lecture.lectureId, title: lecture.title };
}

function isScenarioReady(
  scenario:
    | {
        organizationId: string | null;
        enabled: boolean;
        enabledAt: number | null;
      }
    | undefined,
  organizationId: string | null,
): boolean {
  return Boolean(
    scenario &&
      scenario.enabled &&
      scenario.enabledAt !== null &&
      (scenario.organizationId === null ||
        scenario.organizationId === organizationId),
  );
}

function linkedScenarioIds(snapshot: CourseCatalogSnapshotV2): string[] {
  return [
    ...new Set(
      snapshot.courses.flatMap((course) =>
        course.lectures.flatMap((lecture) =>
          lecture.scenarioId ? [lecture.scenarioId] : [],
        ),
      ),
    ),
  ];
}

function courseUnitKey(
  scopeKey: string,
  courseId: string,
  lectureId: string,
): string {
  return `${scopeKey}\u0000${courseId}\u0000${lectureId}`;
}

function assertV2Snapshot(snapshot: CourseCatalogSnapshotV2): void {
  if (snapshot.version !== 2) {
    throw appError(
      400,
      "unsupported_course_catalog_version",
      "course catalog version 2 is required",
    );
  }
}
