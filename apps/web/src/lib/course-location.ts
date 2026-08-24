import type {
  CourseLocation,
  ScenarioCatalogCourseWireEntry,
} from "./scenario-runs/types";

/** Reserved route segment for generated, non-authored practice scenarios. */
export const GENERAL_PRACTICE_COURSE_ID = "general-practice";

export type CourseRouteScope = CourseLocation["scope"];

export interface CourseRouteMatch {
  scope: CourseRouteScope;
  courseId: string;
}

/**
 * Builds the canonical location from the already-projected visible catalog.
 * The projection is important: organization courses intentionally claim a
 * scenario ahead of public courses with the same scenario ID.
 */
export function findScenarioCourseLocation(
  courses: readonly ScenarioCatalogCourseWireEntry[],
  scenarioId: string,
  organizationId: string | null,
): CourseLocation | null {
  for (const course of courses) {
    const index = course.scenarios.findIndex(
      (scenario) => scenario.scenarioId === scenarioId,
    );
    if (index < 0) continue;

    if (course.kind === "general-practice") {
      return {
        courseKind: "general-practice",
        scope: organizationId ? "organization-general-practice" : "public",
        organizationId,
        courseId: null,
        courseTitle: "General practice",
        step: null,
        steps: null,
      };
    }

    return {
      courseKind: "authored",
      scope: organizationId
        ? course.organizationId
          ? "organization-private"
          : "organization-public"
        : "public",
      organizationId,
      courseId: course.courseId,
      courseTitle: course.title,
      step: index + 1,
      steps: course.scenarios.length,
    };
  }
  return null;
}

/** Finds a course route target in a visible catalog, including General practice. */
export function findCourseLocation(
  courses: readonly ScenarioCatalogCourseWireEntry[],
  match: CourseRouteMatch,
  organizationId: string | null,
): CourseLocation | null {
  const course = courses.find((candidate) => {
    if (courseScopeFor(candidate, organizationId) !== match.scope) {
      return false;
    }
    if (candidate.kind === "general-practice") {
      return match.courseId === GENERAL_PRACTICE_COURSE_ID;
    }
    return candidate.courseId === match.courseId;
  });
  if (!course) return null;

  const probeScenarioId = course.scenarios[0]?.scenarioId;
  if (!probeScenarioId) return null;
  const location = findScenarioCourseLocation(
    [course],
    probeScenarioId,
    organizationId,
  );
  return location && matchesCourseRoute(location, match) ? location : null;
}

function courseScopeFor(
  course: ScenarioCatalogCourseWireEntry,
  organizationId: string | null,
): CourseRouteScope {
  if (course.kind === "general-practice") {
    return organizationId ? "organization-general-practice" : "public";
  }
  if (!organizationId) return "public";
  return course.organizationId
    ? "organization-private"
    : "organization-public";
}

export function courseRouteId(location: CourseLocation): string {
  return location.courseId ?? GENERAL_PRACTICE_COURSE_ID;
}

export function matchesCourseRoute(
  location: CourseLocation | null | undefined,
  match: CourseRouteMatch,
): boolean {
  return Boolean(
    location &&
      location.scope === match.scope &&
      courseRouteId(location) === match.courseId,
  );
}
