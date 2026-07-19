import { describe, expect, it } from "vitest";
import type {
  ScenarioCatalogWireEntry,
  ScenarioCourseWireEntry,
  ScenarioProgress,
} from "@/lib/scenario-runs";
import { buildCourseCatalogView, courseCatalogKey } from "./course-catalog";

describe("course catalog view", () => {
  it("preserves curriculum order and sorts only individual scenarios", () => {
    const scenarios = [
      scenario("standalone-z", "Zulu standalone"),
      scenario("course-second", "Second by title"),
      scenario("standalone-a", "Alpha standalone"),
      scenario("course-first", "First by title"),
    ];
    const courses = [course("linux", ["course-first", "course-second"])];

    const view = buildCourseCatalogView(scenarios, courses, {
      q: "",
      tags: [],
      sort: "title",
    });

    expect(
      view.courses[0]?.visibleScenarios.map((entry) => entry.scenarioId),
    ).toEqual(["course-first", "course-second"]);
    expect(view.individualScenarios.map((entry) => entry.scenarioId)).toEqual([
      "standalone-a",
      "standalone-z",
    ]);
    expect(view.units.map((unit) => unit.kind)).toEqual([
      "course",
      "scenario",
      "scenario",
    ]);
  });

  it("reveals structurally eligible members when the course title matches", () => {
    const scenarios = [
      scenario("nginx", "Repair the proxy", { difficulty: "medium" }),
      scenario("dns", "Trace the resolver", { difficulty: "hard" }),
    ];
    const courses = [course("linux", ["dns", "nginx"], "Linux operations")];

    const titleMatch = buildCourseCatalogView(scenarios, courses, {
      q: "linux operations",
      tags: [],
    });
    expect(
      titleMatch.courses[0]?.visibleScenarios.map((entry) => entry.scenarioId),
    ).toEqual(["dns", "nginx"]);

    const scenarioMatch = buildCourseCatalogView(scenarios, courses, {
      q: "resolver",
      tags: [],
    });
    expect(
      scenarioMatch.courses[0]?.visibleScenarios.map(
        (entry) => entry.scenarioId,
      ),
    ).toEqual(["dns"]);
  });

  it("applies structured filters while keeping header metrics unfiltered", () => {
    const scenarios = [
      scenario("nginx", "Repair nginx", {
        difficulty: "medium",
        estimatedMinutes: 35,
        status: "completed",
        tags: ["linux", "service"],
      }),
      scenario("dns", "Repair DNS", {
        difficulty: "hard",
        estimatedMinutes: 60,
        tags: ["linux", "networking"],
      }),
    ];
    const courses = [course("linux", ["nginx", "dns"])];

    const view = buildCourseCatalogView(scenarios, courses, {
      q: "",
      difficulty: "medium",
      tags: ["linux"],
    });
    const section = view.courses[0];

    expect(section?.visibleScenarios.map((entry) => entry.scenarioId)).toEqual([
      "nginx",
    ]);
    expect(section).toMatchObject({
      totalEstimatedMinutes: 95,
      solvedCount: 1,
    });
    expect(section?.accessibleScenarios).toHaveLength(2);

    const hidden = buildCourseCatalogView(scenarios, courses, {
      q: "",
      difficulty: "easy",
      tags: [],
    });
    expect(hidden.courses).toEqual([]);
    expect(hidden.visibleScenarioCount).toBe(0);
  });

  it("uses scope-qualified identities and lets organization membership win", () => {
    const scenarios = [scenario("nginx", "Repair nginx")];
    const publicCourse = course("operations", ["nginx"]);
    const organizationCourse = {
      ...course("operations", ["nginx"], "Team operations"),
      organizationId: "org-platform",
    };

    const view = buildCourseCatalogView(
      scenarios,
      [publicCourse, organizationCourse],
      { q: "", tags: [] },
    );

    expect(courseCatalogKey(publicCourse)).toBe("public:operations");
    expect(courseCatalogKey(organizationCourse)).toBe(
      "org-platform:operations",
    );
    expect(view.courses.map((entry) => entry.course.organizationId)).toEqual([
      "org-platform",
    ]);
    expect(view.visibleScenarioCount).toBe(1);
  });
});

function scenario(
  scenarioId: string,
  title: string,
  overrides: Partial<Omit<ScenarioCatalogWireEntry, "progress">> & {
    status?: ScenarioProgress["status"];
    progress?: Partial<ScenarioProgress>;
  } = {},
): ScenarioCatalogWireEntry {
  const { status, progress, ...entryOverrides } = overrides;
  const progressStatus = status ?? progress?.status ?? "new";
  return {
    scenarioId,
    organizationId: null,
    slug: scenarioId,
    title,
    tagline: `${title} safely.`,
    difficulty: "easy",
    estimatedMinutes: 20,
    tags: ["systems"],
    category: "Operations",
    scenarioName: scenarioId,
    enabledAt: 1,
    vmCount: 1,
    ...entryOverrides,
    progress: {
      status: progressStatus,
      activeRunId: null,
      attemptCount: 0,
      completedCount: progressStatus === "completed" ? 1 : 0,
      bestSolveMs: null,
      lastPlayedAt: null,
      ...progress,
    },
  };
}

function course(
  courseId: string,
  scenarioIds: string[],
  title = "Operations course",
): ScenarioCourseWireEntry {
  return {
    courseId,
    organizationId: null,
    title,
    description: "Practice a deliberate sequence of operational repairs.",
    scenarioIds,
  };
}
