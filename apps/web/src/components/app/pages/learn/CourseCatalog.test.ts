import { describe, expect, it } from "vitest";
import { filterCourses, filterLectures } from "./CourseCatalog";
import type { CourseCatalogCourse } from "./course-wire";

const course: CourseCatalogCourse = {
  courseId: "operations",
  organizationId: null,
  title: "Linux operations",
  summary: "Repair common services.",
  bodyMarkdown: "Course overview.",
  sequential: true,
  lectures: [
    lecture("01-nginx", "Repair Nginx", {
      category: "services",
      tags: ["linux", "http"],
      difficulty: "medium",
    }),
    lecture("02-dns", "Trace DNS", {
      category: "networking",
      tags: ["linux", "dns"],
      difficulty: "hard",
    }),
  ],
};

describe("course lecture filters", () => {
  it("keeps authored lecture order after structured filtering", () => {
    expect(
      filterLectures(course, {
        q: "",
        difficulty: undefined,
        category: undefined,
        tags: ["linux"],
      }).map((lecture) => lecture.lectureId),
    ).toEqual(["01-nginx", "02-dns"]);
  });

  it("matches course text and lecture metadata without exposing locked bodies", () => {
    expect(
      filterCourses([course], {
        q: "Linux operations",
        difficulty: undefined,
        category: undefined,
        tags: [],
      }),
    ).toEqual([course]);
    expect(
      filterLectures(course, {
        q: "dns",
        difficulty: "hard",
        category: "networking",
        tags: ["linux"],
      }).map((lecture) => lecture.lectureId),
    ).toEqual(["02-dns"]);
  });

  it("uses lecture filters to remove courses with no matching lecture", () => {
    const concepts: CourseCatalogCourse = {
      ...course,
      courseId: "concepts",
      title: "Systems concepts",
      lectures: [
        lecture("01-models", "Build a system model", {
          category: "theory",
          tags: ["models"],
        }),
      ],
    };

    expect(
      filterCourses([course, concepts], {
        q: "",
        difficulty: undefined,
        category: "services",
        tags: [],
      }),
    ).toEqual([course]);

    expect(
      filterCourses([course, concepts], {
        q: "Linux operations",
        difficulty: undefined,
        category: "theory",
        tags: [],
      }),
    ).toEqual([]);
  });
});

function lecture(
  lectureId: string,
  title: string,
  overrides: Partial<CourseCatalogCourse["lectures"][number]>,
): CourseCatalogCourse["lectures"][number] {
  return {
    lectureId,
    title,
    summary: `${title} summary`,
    category: "general",
    tags: [],
    difficulty: "easy",
    estimatedMinutes: 20,
    scenarioId: lectureId,
    state: "available",
    blockedBy: null,
    activeRunId: null,
    scenarioReady: true,
    ...overrides,
  };
}
