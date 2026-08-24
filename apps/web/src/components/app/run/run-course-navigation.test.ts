import { describe, expect, it } from "vitest";
import type {
  CourseLocation,
  ScenarioCatalogCourseWireEntry,
  ScenarioCatalogWireEntry,
} from "@/lib/scenario-runs";
import { findNextCourseScenario } from "./run-course-navigation";

describe("saved run course navigation", () => {
  it("uses the current ordered course to find the next lab", () => {
    const location = publicLocation({ step: 1, steps: 2 });
    const next = findNextCourseScenario({
      location,
      scenarioId: "repair-nginx",
      courses: [
        authoredCourse("operations", [
          scenario("repair-nginx", "Repair nginx"),
          scenario("repair-dns", "Trace DNS"),
        ]),
      ],
    });

    expect(next).toMatchObject({
      scenarioId: "repair-dns",
      title: "Trace DNS",
    });
  });

  it("fails closed when the saved position no longer matches the catalog", () => {
    const location = publicLocation({ step: 1, steps: 2 });
    const next = findNextCourseScenario({
      location,
      scenarioId: "repair-nginx",
      courses: [
        authoredCourse("operations", [
          scenario("repair-dns", "Trace DNS"),
          scenario("repair-nginx", "Repair nginx"),
        ]),
      ],
    });

    expect(next).toBeNull();
  });

  it("uses the private organization course and rejects duplicate scoped IDs", () => {
    const location: CourseLocation = {
      courseKind: "authored",
      scope: "organization-private",
      organizationId: "org-platform",
      courseId: "operations",
      courseTitle: "Platform repair sequence",
      step: 1,
      steps: 2,
    };
    const privateCourse = authoredCourse(
      "operations",
      [
        scenario("repair-nginx", "Repair nginx"),
        scenario("platform-logrotate", "Restore log rotation"),
      ],
      "org-platform",
    );
    const publicCourse = authoredCourse("operations", [
      scenario("repair-nginx", "Repair nginx"),
      scenario("repair-dns", "Trace DNS"),
    ]);

    expect(
      findNextCourseScenario({
        location,
        scenarioId: "repair-nginx",
        courses: [publicCourse, privateCourse],
      }),
    ).toMatchObject({ scenarioId: "platform-logrotate" });
    expect(
      findNextCourseScenario({
        location,
        scenarioId: "repair-nginx",
        courses: [publicCourse, privateCourse, privateCourse],
      }),
    ).toBeNull();
  });
});

function publicLocation(
  position: Pick<Extract<CourseLocation, { courseKind: "authored" }>, "step" | "steps">,
): CourseLocation {
  return {
    courseKind: "authored",
    scope: "public",
    organizationId: null,
    courseId: "operations",
    courseTitle: "Linux operations",
    ...position,
  };
}

function authoredCourse(
  courseId: string,
  scenarios: ScenarioCatalogWireEntry[],
  organizationId: string | null = null,
): Extract<ScenarioCatalogCourseWireEntry, { kind: "authored" }> {
  return {
    kind: "authored",
    courseId,
    organizationId,
    title: organizationId ? "Platform repair sequence" : "Linux operations",
    description: "Practice production repair safely.",
    scenarios,
  };
}

function scenario(
  scenarioId: string,
  title: string,
): ScenarioCatalogWireEntry {
  return {
    scenarioId,
    organizationId: null,
    slug: scenarioId,
    title,
    tagline: `${title} safely.`,
    difficulty: "easy",
    estimatedMinutes: 20,
    tags: [],
    category: "Operations",
    scenarioName: scenarioId,
    enabledAt: 1,
    vmCount: 1,
    progress: {
      status: "new",
      activeRunId: null,
      attemptCount: 0,
      completedCount: 0,
      bestSolveMs: null,
      lastPlayedAt: null,
    },
  };
}
