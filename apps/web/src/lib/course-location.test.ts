import { describe, expect, it } from "vitest";
import type { ScenarioCatalogCourseWireEntry } from "@/lib/scenario-runs";
import {
  findCourseLocation,
  findScenarioCourseLocation,
  matchesCourseRoute,
} from "./course-location";

const scenario = (scenarioId: string) => ({
  scenarioId,
  organizationId: null,
  slug: scenarioId,
  title: scenarioId,
  tagline: scenarioId,
  difficulty: "easy" as const,
  estimatedMinutes: 10,
  tags: [],
  category: "test",
  scenarioName: scenarioId,
  enabledAt: 1,
  vmCount: 1,
  progress: {
    status: "new" as const,
    activeRunId: null,
    attemptCount: 0,
    completedCount: 0,
    bestSolveMs: null,
    lastPlayedAt: null,
  },
});

describe("course locations", () => {
  it("keeps curriculum order in the scenario location", () => {
    const courses: ScenarioCatalogCourseWireEntry[] = [
      {
        kind: "authored",
        courseId: "kubernetes",
        organizationId: null,
        title: "Kubernetes fundamentals",
        description: "Learn Kubernetes.",
        scenarios: [scenario("second"), scenario("first")],
      },
    ];

    expect(findScenarioCourseLocation(courses, "first", null)).toMatchObject({
      scope: "public",
      courseId: "kubernetes",
      step: 2,
      steps: 2,
    });
  });

  it("resolves duplicate public and private course IDs by route scope", () => {
    const courses: ScenarioCatalogCourseWireEntry[] = [
      {
        kind: "authored",
        courseId: "operations",
        organizationId: null,
        title: "Public operations",
        description: "Public course.",
        scenarios: [scenario("public-scenario")],
      },
      {
        kind: "authored",
        courseId: "operations",
        organizationId: "org-a",
        title: "Private operations",
        description: "Private course.",
        scenarios: [scenario("private-scenario")],
      },
    ];

    expect(
      findCourseLocation(
        courses,
        { scope: "organization-public", courseId: "operations" },
        "org-a",
      ),
    ).toMatchObject({ courseTitle: "Public operations" });
    const privateLocation = findCourseLocation(
      courses,
      { scope: "organization-private", courseId: "operations" },
      "org-a",
    );
    expect(privateLocation).toMatchObject({ courseTitle: "Private operations" });
    expect(
      matchesCourseRoute(privateLocation, {
        scope: "organization-private",
        courseId: "operations",
      }),
    ).toBe(true);
  });
});
