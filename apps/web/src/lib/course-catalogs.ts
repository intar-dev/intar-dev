import {
  and,
  eq,
  inArray,
  isNotNull,
  or,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  courseUnitCompletions,
  member,
  organization,
  courseCatalogs,
  scenarioRuns,
  scenarioRevisions,
  scenarios,
  type CourseCatalogCourseV2,
  type CourseCatalogLectureV2,
  type CourseCatalogSnapshotV2,
} from "@/db/schema";
import { appError } from "@/lib/app-error";
import { isRevisionScenarioId } from "@/lib/scenario-id";
import { liveHostHasRevisionImagesSql, scenarioImagePreparing } from "@/lib/scenario-runs/image-readiness";
import { CUTOVER_WIPED_SQL, cutoverWipedError } from "@/lib/run-admission-gate";
import type { ResourceCapacity } from "@/lib/resource-capacity";

export type {
  CourseCatalogCourseV2,
  CourseCatalogLectureV2,
  CourseCatalogSnapshotV2,
} from "@/db/schema";

const PUBLIC_COURSE_CATALOG_SCOPE = "public";

// D1 allows 100 bound parameters, and a catalog can link more scenarios than
// that, so an id list travels as one JSON array.
const inJson = (column: SQLWrapper, ids: readonly string[]) =>
  sql`${column} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`;

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
  organizationName: string | null;
  title: string;
  summary: string;
  bodyMarkdown: string;
  sequential: boolean;
  lectures: CourseCatalogLectureSummary[];
}

export interface CourseCatalogForUser {
  courses: CourseCatalogCourseForUser[];
  capacityPressure: number | null;
  resourceCapacity: ResourceCapacity | null;
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
  /** The scenario has a startable live revision; `scenarioReady` also needs its images on a host. */
  scenarioLive: boolean;
  course: CourseCatalogCourseV2;
  lecture: CourseCatalogLectureV2;
}

interface CourseSource {
  scopeKey: string;
  organizationId: string | null;
  organizationName: string | null;
  course: CourseCatalogCourseV2;
}

interface LectureView {
  lecture: CourseCatalogLectureV2;
  state: CourseLectureState;
  blockedBy: CourseLectureBlocker | null;
  activeRunId: string | null;
  scenarioReady: boolean | null;
  scenarioLive: boolean | null;
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

/**
 * Lists public courses plus the current organization catalog. An organization
 * lecture that links a scenario hides the public lecture for that scenario.
 * Without an organization, it lists every member organization's catalog and
 * hides nothing.
 */
export async function listCourseCatalogForUser(input: {
  db: DrizzleD1Database;
  userId: string;
  organizationId: string | null;
  capacityPressure?: number | null;
  resourceCapacity?: ResourceCapacity | null;
  allowSequenceBypass?: boolean;
}): Promise<CourseCatalogForUser> {
  const views = await loadCourseViews({ ...input, includeMemberCatalogs: true });
  return {
    courses: views.map(toCourseCatalogCourseForUser),
    capacityPressure: input.capacityPressure ?? null,
    resourceCapacity: input.resourceCapacity ?? null,
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
        organizationName: course.organizationName,
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
  // The gate is checked inside the insert, so a completion in flight when
  // the cutover wipe starts cannot land behind it.
  await input.db.run(sql`INSERT INTO course_unit_completions
      (user_id, scope_key, course_id, lecture_id, source_run_id, completed_at)
    SELECT ${input.userId}, ${scopeKey}, ${before.detail.course.courseId},
      ${before.detail.lecture.lectureId}, NULL, ${input.nowUnixMs}
    WHERE NOT ${sql.raw(CUTOVER_WIPED_SQL)}
    ON CONFLICT DO NOTHING`);
  const gate = await input.db.get<{ wiped: number }>(
    sql`SELECT ${sql.raw(CUTOVER_WIPED_SQL)} AS wiped`,
  );
  if (gate?.wiped) throw cutoverWipedError();

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
      scenarioLive: lecture.scenarioLive === true,
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
  if (!resolved.scenarioReady && resolved.scenarioLive) throw scenarioImagePreparing();
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

async function loadCourseViews(input: {
  db: DrizzleD1Database;
  userId: string;
  organizationId: string | null;
  allowSequenceBypass?: boolean;
  includeMemberCatalogs?: boolean;
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
  const sources = await loadVisibleCourseSources(
    input.db,
    input.organizationId,
    input.includeMemberCatalogs && !input.organizationId ? input.userId : null,
  );
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
  // Only a namespaced id names a scenario.
  const revisionIds = scenarioIds.filter(isRevisionScenarioId);
  const [completionRows, activeRunRows] = await Promise.all([
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
          inJson(courseUnitCompletions.scopeKey, scopeKeys),
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
  ]);
  const readyRows: Array<{
    scenarioId: string; organizationId: string | null; enabled: boolean; enabledAt: number | null; imagesReady: number;
  }> = [];
  // A scenario is ready while it is enabled with a live revision that can
  // start, as content access and the start require. A learner placed on the
  // platform also needs a live platform host that reports the revision's
  // images ready; a learner's own server is prepared by the start itself.
  if (revisionIds.length) {
    const platformImagesReady = sql.raw(liveHostHasRevisionImagesSql(
      "(SELECT live.doc_json FROM scenario_revisions live WHERE live.scenario_id = scenarios.id AND live.rev = scenarios.live_rev)",
      "agent_hosts.scope = 'platform'",
    ));
    const platformPlaced = sql`EXISTS (SELECT 1 FROM user placed WHERE placed.id = ${input.userId}
      AND placed.metal_placement = 'platform'
      AND (${input.organizationId} IS NULL OR EXISTS (SELECT 1 FROM organization placed_org
        WHERE placed_org.id = ${input.organizationId} AND placed_org.metal_placement = 'platform')))`;
    const revised = await input.db
      .select({
        scenarioId: scenarios.id,
        organizationId: scenarios.organizationId,
        enabled: scenarios.enabled,
        enabledAt: sql<number | null>`CASE WHEN EXISTS (SELECT 1 FROM ${scenarioRevisions} live
          WHERE live.scenario_id = ${scenarios.id} AND live.rev = ${scenarios.liveRev}
            AND live.state IN ('ready', 'verified')) THEN 0 ELSE NULL END`,
        imagesReady: sql<number>`(NOT ${platformPlaced} OR ${platformImagesReady})`,
      })
      .from(scenarios)
      .where(inJson(scenarios.id, revisionIds));
    readyRows.push(...revised);
  }
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
    readyRows.map((scenario) => [scenario.scenarioId, scenario]),
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
      const scenarioLive = lecture.scenarioId
        ? isScenarioReady(
            scenarioById.get(lecture.scenarioId),
            source.organizationId ?? input.organizationId,
          )
        : null;
      const scenarioReady = scenarioLive === null
        ? null
        : scenarioLive && scenarioById.get(lecture.scenarioId!)?.imagesReady === 1;
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
      return { lecture, state, blockedBy, activeRunId, scenarioReady, scenarioLive };
    });
    return { ...source, lectures };
  });
}

/**
 * Loads the public catalog, the current organization's catalog, and, for
 * `memberUserId`, the catalog of every organization that user belongs to.
 */
async function loadVisibleCourseSources(
  db: DrizzleD1Database,
  organizationId: string | null,
  memberUserId: string | null,
): Promise<CourseSource[]> {
  const scopeKeys = [
    courseCatalogScopeKey(null),
    ...(organizationId ? [courseCatalogScopeKey(organizationId)] : []),
  ];
  const rows = await db
    .select({
      scopeKey: courseCatalogs.scopeKey,
      organizationId: courseCatalogs.organizationId,
      organizationName: organization.name,
      catalog: courseCatalogs.catalogJson,
    })
    .from(courseCatalogs)
    .leftJoin(organization, eq(organization.id, courseCatalogs.organizationId))
    .where(
      or(
        inArray(courseCatalogs.scopeKey, scopeKeys),
        memberUserId
          ? inArray(
              courseCatalogs.organizationId,
              db
                .select({ organizationId: member.organizationId })
                .from(member)
                .where(eq(member.userId, memberUserId)),
            )
          : undefined,
      ),
    )
    .orderBy(courseCatalogs.scopeKey);
  for (const row of rows) assertV2Snapshot(row.catalog);
  const publicSnapshot = rows.find((row) => row.organizationId === null)
    ?.catalog;
  const organizationRows = rows.filter((row) => row.organizationId !== null);

  const organizationScenarioIds = new Set(
    organizationRows.flatMap((row) =>
      row.organizationId === organizationId
        ? linkedScenarioIds(row.catalog)
        : [],
    ),
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
            organizationName: null,
            course: { ...course, lectures },
          },
        ]
      : [];
  });
  const organizationSources = organizationRows.flatMap((row) =>
    row.catalog.courses.map((course) => ({
      scopeKey: row.scopeKey,
      organizationId: row.organizationId,
      organizationName: row.organizationName,
      course,
    })),
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
    organizationName: course.organizationName,
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

export function linkedScenarioIds(snapshot: CourseCatalogSnapshotV2): string[] {
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
