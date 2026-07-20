import { describe, expect, it } from "vitest";
import type {
  ScenarioCatalogCourseWireEntry,
  ScenarioCatalogWireEntry,
  ScenarioProgress,
} from "@/lib/scenario-runs";
import { paginateWeightedCollection } from "@/components/app/patterns/CollectionPagination";
import { buildCourseCatalogView, courseCatalogKey } from "./course-catalog";

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
    expect(view.units.map((unit) => unit.kind)).toEqual([
      "course",
      "general-practice-scenario",
      "general-practice-scenario",
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

  it("packs a mixed authored course and generated members toward nine", () => {
    const authoredScenarios = numberedScenarios("course", 5);
    const generalScenarios = numberedScenarios("general", 6);
    const view = buildCourseCatalogView(
      [
        authored("linux", authoredScenarios),
        generalPractice(generalScenarios),
      ],
      { q: "", tags: [] },
    );

    const first = paginateView(view, 1);
    const second = paginateView(view, 2);

    expect(first.items.map((unit) => unit.kind)).toEqual([
      "course",
      "general-practice-scenario",
      "general-practice-scenario",
      "general-practice-scenario",
      "general-practice-scenario",
    ]);
    expect([first.start, first.end, first.totalItems]).toEqual([1, 9, 11]);
    expect([second.start, second.end]).toEqual([10, 11]);
  });

  it("paginates nineteen General practice members as 9/9/1", () => {
    const view = buildCourseCatalogView(
      [generalPractice(numberedScenarios("general", 19))],
      { q: "", tags: [] },
    );

    const pages = [1, 2, 3].map((page) => paginateView(view, page));

    expect(pages.map((page) => page.items.length)).toEqual([9, 9, 1]);
    expect(pages.map((page) => [page.start, page.end])).toEqual([
      [1, 9],
      [10, 18],
      [19, 19],
    ]);
    expect(pages[0]?.totalPages).toBe(3);
  });

  it("keeps an oversized authored course alone", () => {
    const view = buildCourseCatalogView(
      [
        authored("linux", numberedScenarios("course", 11)),
        generalPractice([scenario("general-1", "General 1")]),
      ],
      { q: "", tags: [] },
    );

    const first = paginateView(view, 1);
    const second = paginateView(view, 2);

    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({ kind: "course", weight: 11 });
    expect([first.start, first.end]).toEqual([1, 11]);
    expect(second.items).toHaveLength(1);
    expect(second.items[0]).toMatchObject({
      kind: "general-practice-scenario",
      weight: 1,
    });
    expect([second.start, second.end]).toEqual([12, 12]);
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
    expect(view.units).toEqual([]);
  });
});

function paginateView(
  view: ReturnType<typeof buildCourseCatalogView>,
  page: number,
) {
  return paginateWeightedCollection(
    view.units.map((unit) => ({ item: unit, weight: unit.weight })),
    page,
    9,
  );
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
