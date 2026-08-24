import { describe, expect, it } from "vitest";
import type {
  ScenarioCatalogCourseWireEntry,
  ScenarioCatalogWireEntry,
  ScenarioProgress,
} from "@/lib/scenario-runs";
import { paginateCollection } from "@/components/app/patterns/CollectionPagination";
import {
  buildCourseCatalogSection,
  buildCourseCatalogView,
  courseCatalogKey,
  getCourseCurriculumState,
} from "./course-catalog";

type AuthoredCourse = Extract<
  ScenarioCatalogCourseWireEntry,
  { kind: "authored" }
>;
type GeneralPracticeCourse = Extract<
  ScenarioCatalogCourseWireEntry,
  { kind: "general-practice" }
>;

describe("course catalog view", () => {
  it("preserves authored curriculum order and sorts only General practice", () => {
    const courses = [
      authored("linux", [
        scenario("course-first", "Zulu by title"),
        scenario("course-second", "Alpha by title"),
      ]),
      generalPractice([
        scenario("standalone-z", "Zulu standalone"),
        scenario("standalone-a", "Alpha standalone"),
      ]),
    ];

    const view = buildCourseCatalogView(courses, {
      q: "",
      tags: [],
      sort: "title",
    });

    expect(
      view.courses[0]?.visibleScenarios.map((entry) => entry.scenarioId),
    ).toEqual(["course-first", "course-second"]);
    expect(
      view.generalPractice?.visibleScenarios.map((entry) => entry.scenarioId),
    ).toEqual(["standalone-a", "standalone-z"]);
    expect(view.courses.map((section) => section.course.kind)).toEqual([
      "authored",
      "general-practice",
    ]);
  });

  it("reveals structurally eligible members when any course title matches", () => {
    const courses = [
      authored(
        "linux",
        [
          scenario("nginx", "Repair the proxy", { difficulty: "medium" }),
          scenario("dns", "Trace the resolver", { difficulty: "hard" }),
        ],
        "Linux operations",
      ),
      generalPractice([
        scenario("logs", "Zulu log exercise"),
        scenario("disk", "Alpha disk exercise"),
      ]),
    ];

    const authoredTitleMatch = buildCourseCatalogView(courses, {
      q: "linux operations",
      tags: [],
    });
    expect(
      authoredTitleMatch.courses[0]?.visibleScenarios.map(
        (entry) => entry.scenarioId,
      ),
    ).toEqual(["nginx", "dns"]);

    const generatedTitleMatch = buildCourseCatalogView(courses, {
      q: "general practice",
      tags: [],
      sort: "title",
    });
    expect(
      generatedTitleMatch.generalPractice?.visibleScenarios.map(
        (entry) => entry.scenarioId,
      ),
    ).toEqual(["disk", "logs"]);

    const scenarioMatch = buildCourseCatalogView(courses, {
      q: "resolver",
      tags: [],
    });
    expect(
      scenarioMatch.courses[0]?.visibleScenarios.map(
        (entry) => entry.scenarioId,
      ),
    ).toEqual(["dns"]);
  });

  it("applies structured filters while keeping course metrics unfiltered", () => {
    const courses = [
      authored("linux", [
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
      ]),
    ];

    const view = buildCourseCatalogView(courses, {
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

    const hidden = buildCourseCatalogView(courses, {
      q: "",
      difficulty: "easy",
      tags: [],
    });
    expect(hidden.courses).toEqual([]);
    expect(hidden.visibleScenarioCount).toBe(0);
  });

  it("uses scope-qualified authored identities and a fixed generated identity", () => {
    const publicCourse = authored("operations", [scenario("nginx", "Nginx")]);
    const organizationCourse: ScenarioCatalogCourseWireEntry = {
      ...authored("operations", [scenario("dns", "DNS")], "Team operations"),
      organizationId: "org-platform",
    };
    const generated = generalPractice([scenario("disk", "Disk")]);

    expect(courseCatalogKey(publicCourse)).toBe("public:operations");
    expect(courseCatalogKey(organizationCourse)).toBe(
      "org-platform:operations",
    );
    expect(courseCatalogKey(generated)).toBe("general-practice");
  });

  it("keeps top-level courses in catalog order and paginates them by nine", () => {
    const courses = Array.from({ length: 19 }, (_, index) =>
      authored(
        `course-${index + 1}`,
        [scenario(`scenario-${index + 1}`, `Scenario ${index + 1}`)],
        `Course ${index + 1}`,
      ),
    );
    const view = buildCourseCatalogView(courses, { q: "", tags: [] });

    const pages = [1, 2, 3].map((page) => paginateCourseIndex(view, page));

    expect(pages.map((page) => page.items.length)).toEqual([9, 9, 1]);
    expect(pages[0]?.items[0]?.course.title).toBe("Course 1");
    expect(pages[2]?.items[0]?.course.title).toBe("Course 19");
  });

  it("paginates nineteen General practice members as 9/9/1", () => {
    const section = buildCourseCatalogSection(
      generalPractice(numberedScenarios("general", 19)),
      { q: "", tags: [], sort: "title" },
    );

    const pages = [1, 2, 3].map((page) =>
      paginateCollection(section.visibleScenarios, page, 9),
    );

    expect(pages.map((page) => page.items.length)).toEqual([9, 9, 1]);
    expect(pages[0]?.totalPages).toBe(3);
    expect(section.accessibleScenarios).toHaveLength(19);
  });

  it("paginates a selected authored curriculum without reordering it", () => {
    const section = buildCourseCatalogSection(
      authored("linux", numberedScenarios("course", 11)),
      { q: "", tags: [] },
    );

    const first = paginateCollection(section.visibleScenarios, 1, 9);
    const second = paginateCollection(section.visibleScenarios, 2, 9);

    expect(first.items.map((entry) => entry.scenarioId)).toEqual(
      numberedScenarios("course", 9).map((entry) => entry.scenarioId),
    );
    expect(second.items.map((entry) => entry.scenarioId)).toEqual([
      "course-10",
      "course-11",
    ]);
  });

  it("foregrounds a resumable step, then the first unsolved step", () => {
    const scenarios = [
      scenario("first", "First", { status: "completed" }),
      scenario("second", "Second", { status: "new" }),
      scenario("third", "Third", { status: "in_progress" }),
      scenario("fourth", "Fourth", { status: "attempted" }),
    ];

    expect(getCourseCurriculumState(scenarios)).toEqual({
      complete: false,
      nextScenarioId: "third",
    });

    expect(
      getCourseCurriculumState([
        scenario("first", "First", { status: "completed" }),
        scenario("second", "Second", { status: "attempted" }),
        scenario("third", "Third", { status: "new" }),
      ]),
    ).toEqual({
      complete: false,
      nextScenarioId: "second",
    });
  });

  it("marks a course complete only after every curriculum step is solved", () => {
    expect(
      getCourseCurriculumState([
        scenario("first", "First", { status: "completed" }),
        scenario("second", "Second", { status: "completed" }),
      ]),
    ).toEqual({
      complete: true,
      nextScenarioId: null,
    });
  });

  it("hides General practice and its sort target when filters remove every member", () => {
    const view = buildCourseCatalogView(
      [
        generalPractice([
          scenario("hard", "Hard repair", { difficulty: "hard" }),
        ]),
      ],
      { q: "", difficulty: "easy", tags: [] },
    );

    expect(view.generalPractice).toBeNull();
    expect(view.courses).toEqual([]);

    const selectedSection = buildCourseCatalogSection(
      generalPractice([
        scenario("hard", "Hard repair", { difficulty: "hard" }),
      ]),
      { q: "", difficulty: "easy", tags: [] },
    );
    expect(selectedSection.accessibleScenarios).toHaveLength(1);
    expect(selectedSection.visibleScenarios).toEqual([]);
  });
});

function paginateCourseIndex(
  view: ReturnType<typeof buildCourseCatalogView>,
  page: number,
) {
  return paginateCollection(view.courses, page, 9);
}

function numberedScenarios(prefix: string, count: number) {
  return Array.from({ length: count }, (_, index) =>
    scenario(`${prefix}-${index + 1}`, `${prefix} ${index + 1}`),
  );
}

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

function authored(
  courseId: string,
  scenarios: ScenarioCatalogWireEntry[],
  title = "Operations course",
): AuthoredCourse {
  return {
    kind: "authored",
    courseId,
    organizationId: null,
    title,
    description: "Practice a deliberate sequence of operational repairs.",
    scenarios,
  };
}

function generalPractice(
  scenarios: ScenarioCatalogWireEntry[],
): GeneralPracticeCourse {
  return {
    kind: "general-practice",
    courseId: null,
    organizationId: null,
    title: "General practice",
    description:
      "Standalone systems for focused practice outside a guided curriculum.",
    scenarios,
  };
}
