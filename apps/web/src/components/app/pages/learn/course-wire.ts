import type { ScenarioDifficulty } from "@/generated/catalog";

/**
 * Learner-facing normalization of the generated V2 snapshot contract.
 * The API changes source snake_case fields to camelCase and adds learner state.
 */
export type LectureState =
  | "locked"
  | "available"
  | "waiting_for_scenario"
  | "in_progress"
  | "completed";

export function lectureStatePresentation(state: LectureState): {
  tone: "muted" | "pending" | "live" | "success";
  word: string;
} {
  switch (state) {
    case "locked":
      return { tone: "muted", word: "Locked" };
    case "available":
      return { tone: "pending", word: "Ready" };
    case "waiting_for_scenario":
      return { tone: "pending", word: "Preparing scenario" };
    case "in_progress":
      return { tone: "live", word: "In progress" };
    case "completed":
      return { tone: "success", word: "Complete" };
  }
}

export type CourseDifficulty = ScenarioDifficulty;

export interface CourseLectureBlocker {
  courseId: string;
  lectureId: string;
  title: string;
}

export interface CourseLectureSummary {
  lectureId: string;
  title: string;
  summary: string;
  category: string;
  tags: string[];
  difficulty?: CourseDifficulty;
  estimatedMinutes: number | null;
  scenarioId: string | null;
  state: LectureState;
  blockedBy: CourseLectureBlocker | null;
  activeRunId: string | null;
  /** Null for a theory-only lecture. */
  scenarioReady: boolean | null;
}

export interface CourseCatalogCourse {
  courseId: string;
  organizationId: string | null;
  title: string;
  summary: string;
  bodyMarkdown: string;
  sequential: boolean;
  lectures: CourseLectureSummary[];
}

export interface CourseCatalogResponse {
  courses: CourseCatalogCourse[];
  capacityPressure: number | null;
}

export interface CourseLectureDetail extends CourseLectureSummary {
  bodyMarkdown: string;
  previousLecture: CourseLectureBlocker | null;
  nextLecture: CourseLectureBlocker | null;
  lectureOrdinal: number;
  lectureCount: number;
}

export interface CourseLectureDetailResponse {
  course: Omit<CourseCatalogCourse, "bodyMarkdown" | "lectures">;
  lecture: CourseLectureDetail;
}

export type CourseRouteScope =
  | "public"
  | "organization-public"
  | "organization-private";

export interface CourseRouteRef {
  scope: CourseRouteScope;
  courseId: string;
  organizationId: string | null;
}

export interface CourseRunLocation {
  courseId?: string | null;
  lectureId?: string | null;
  organizationId?: string | null;
  scope?: string | null;
}

export class CourseLectureLockedError extends Error {
  readonly blockedBy: CourseLectureBlocker | null;

  constructor(message: string, blockedBy: CourseLectureBlocker | null) {
    super(message);
    this.name = "CourseLectureLockedError";
    this.blockedBy = blockedBy;
  }
}

export function courseCatalogQueryKey(organizationId: string | null) {
  return organizationId
    ? (["courses", "organization", organizationId] as const)
    : (["courses", "public"] as const);
}

export async function fetchCourseCatalog(
  organizationId: string | null,
): Promise<CourseCatalogResponse> {
  const response = await fetch(courseCatalogPath(organizationId), {
    credentials: "include",
  });
  return parseCourseResponse<CourseCatalogResponse>(response, "courses");
}

export async function fetchCourseLecture(
  route: CourseRouteRef,
  lectureId: string,
): Promise<CourseLectureDetailResponse> {
  const response = await fetch(
    `${courseLecturePath(route, lectureId)}${courseLectureScopeQuery(route)}`,
    {
    credentials: "include",
    },
  );
  return parseCourseResponse<CourseLectureDetailResponse>(response, "lecture");
}

export async function completeCourseLecture(
  route: CourseRouteRef,
  lectureId: string,
): Promise<CourseLectureDetailResponse> {
  const response = await fetch(
    `${courseLecturePath(route, lectureId)}/complete${courseLectureScopeQuery(route)}`,
    {
      method: "POST",
      credentials: "include",
    },
  );
  return parseCourseResponse<CourseLectureDetailResponse>(response, "lecture");
}

export function courseRouteForCatalogCourse(
  course: Pick<CourseCatalogCourse, "courseId" | "organizationId">,
  organizationId: string | null,
): CourseRouteRef {
  if (!organizationId) {
    return { scope: "public", courseId: course.courseId, organizationId: null };
  }
  return {
    scope:
      course.organizationId === organizationId
        ? "organization-private"
        : "organization-public",
    courseId: course.courseId,
    organizationId,
  };
}

/** Maps a durable run context to the current course route when possible. */
export function courseRouteForRun(
  location: CourseRunLocation | null | undefined,
): CourseRouteRef | null {
  if (!location?.courseId) return null;
  switch (location.scope) {
    case "public":
      return {
        scope: "public",
        courseId: location.courseId,
        organizationId: null,
      };
    case "organization-public":
    case "organization-private":
      return location.organizationId
        ? {
            scope: location.scope,
            courseId: location.courseId,
            organizationId: location.organizationId,
          }
        : null;
    default:
      return null;
  }
}

/** Finds the following published unit without guessing across changed courses. */
export function findNextCourseLecture({
  courses,
  route,
  lectureId,
  scenarioId,
}: {
  courses: readonly CourseCatalogCourse[];
  route: CourseRouteRef | null | undefined;
  lectureId?: string | null;
  scenarioId: string;
}): CourseLectureSummary | null {
  if (!route) return null;
  const course = courses.find(
    (candidate) =>
      candidate.courseId === route.courseId &&
      courseMatchesRunRoute(candidate, route),
  );
  if (!course) return null;
  const currentIndex = course.lectures.findIndex(
    (lecture) =>
      lecture.lectureId === lectureId ||
      (!lectureId && lecture.scenarioId === scenarioId),
  );
  return currentIndex >= 0 ? (course.lectures[currentIndex + 1] ?? null) : null;
}

function courseMatchesRunRoute(
  course: CourseCatalogCourse,
  route: CourseRouteRef,
): boolean {
  switch (route.scope) {
    case "public":
    case "organization-public":
      return course.organizationId === null;
    case "organization-private":
      return course.organizationId === route.organizationId;
  }
}

function courseCatalogPath(organizationId: string | null): string {
  return organizationId
    ? `/api/organizations/${encodeURIComponent(organizationId)}/courses`
    : "/api/courses";
}

function courseLecturePath(route: CourseRouteRef, lectureId: string): string {
  const base = route.organizationId
    ? `/api/organizations/${encodeURIComponent(route.organizationId)}/courses`
    : "/api/courses";
  return `${base}/${encodeURIComponent(route.courseId)}/lectures/${encodeURIComponent(lectureId)}`;
}

function courseLectureScopeQuery(route: CourseRouteRef): string {
  if (!route.organizationId) return "";
  return route.scope === "organization-private" ? "?scope=private" : "?scope=public";
}

async function parseCourseResponse<T>(response: Response, label: string): Promise<T> {
  const body = (await response.json().catch(() => null)) as {
    error?: string;
    code?: string;
    locked?: boolean;
    blockedBy?: CourseLectureBlocker | null;
  } | null;
  if (
    body?.locked === true ||
    (response.status === 409 && body?.code === "course_lecture_locked")
  ) {
    throw new CourseLectureLockedError(
      body.error ?? "Complete the required lecture first.",
      body.blockedBy ?? null,
    );
  }
  if (!response.ok || !body) {
    throw new Error(body?.error ?? `Could not load ${label} (${response.status})`);
  }
  return body as T;
}
