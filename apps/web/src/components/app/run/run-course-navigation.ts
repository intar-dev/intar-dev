import { findScenarioCourseLocation } from "@/lib/course-location";
import type {
  CourseLocation,
  ScenarioCatalogCourseWireEntry,
  ScenarioCatalogWireEntry,
} from "@/lib/scenario-runs";

/**
 * Finds the following lab only when the current catalog still proves that the
 * saved run belongs to this exact ordered course. A saved location is useful
 * for returning to a course, but must never be used to guess a new next lab
 * after a catalog edit.
 */
export function findNextCourseScenario({
  location,
  scenarioId,
  courses,
}: {
  location: CourseLocation | null | undefined;
  scenarioId: string;
  courses: readonly ScenarioCatalogCourseWireEntry[];
}): ScenarioCatalogWireEntry | null {
  if (
    !location ||
    location.courseKind !== "authored" ||
    !location.courseId ||
    !hasValidCourseScope(location)
  ) {
    return null;
  }

  const expectedCourseOrganizationId =
    location.scope === "organization-private" ? location.organizationId : null;
  const matchingCourses = courses.filter(
    (course): course is Extract<
      ScenarioCatalogCourseWireEntry,
      { kind: "authored" }
    > =>
      course.kind === "authored" &&
      course.courseId === location.courseId &&
      course.organizationId === expectedCourseOrganizationId,
  );

  // A duplicate scoped ID has no unambiguous continuation route.
  if (matchingCourses.length !== 1) return null;

  const course = matchingCourses[0];
  if (!course) return null;
  const matchingScenarioIndexes = course.scenarios.flatMap(
    (scenario, index) => (scenario.scenarioId === scenarioId ? [index] : []),
  );
  if (matchingScenarioIndexes.length !== 1) return null;

  const currentIndex = matchingScenarioIndexes[0];
  if (currentIndex === undefined) return null;
  const currentLocation = findScenarioCourseLocation(
    [course],
    scenarioId,
    location.organizationId,
  );
  if (
    !currentLocation ||
    currentLocation.scope !== location.scope ||
    currentLocation.organizationId !== location.organizationId ||
    currentLocation.courseId !== location.courseId ||
    currentLocation.step !== location.step ||
    currentLocation.steps !== location.steps
  ) {
    return null;
  }

  const next = course.scenarios[currentIndex + 1] ?? null;
  return next && next.scenarioId !== scenarioId ? next : null;
}

function hasValidCourseScope(
  location: Extract<CourseLocation, { courseKind: "authored" }>,
) {
  switch (location.scope) {
    case "public":
      return location.organizationId === null;
    case "organization-public":
    case "organization-private":
      return Boolean(location.organizationId);
    default:
      return false;
  }
}
