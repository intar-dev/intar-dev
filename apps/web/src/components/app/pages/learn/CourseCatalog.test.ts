import { describe, expect, it } from "vitest";
import { HttpResponseError } from "@/components/app/lib/http-response-error";
import {
  catalogLoadFailed,
  filterCourses,
  filterLectures,
  splitAssignments,
} from "./CourseCatalog";
import type { CourseCatalogCourse } from "./course-wire";

const course: CourseCatalogCourse = {
  courseId: "operations",
  organizationId: null,
  organizationName: null,
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

describe("catalog load failure", () => {
  it("keeps a cached course on screen when only the refresh failed", () => {
    const outage = new Error("network");
    expect(catalogLoadFailed(null, true)).toBe(false);
    expect(catalogLoadFailed(outage, true)).toBe(false);
    expect(catalogLoadFailed(outage, false)).toBe(true);
    expect(catalogLoadFailed(new HttpResponseError(500, "boom", null), true)).toBe(
      false,
    );
  });

  it("replaces the page when access was denied or the course is gone", () => {
    for (const status of [401, 403, 404]) {
      expect(catalogLoadFailed(new HttpResponseError(status, "no", null), true)).toBe(
        true,
      );
    }
  });
});

describe("course index assignments", () => {
  const assignment = (
    assignmentId: string,
    lecture: { courseId: string; scope: "organization-public" | "organization-private" } | null,
  ) => ({
    assignmentId,
    organizationId: "org-a",
    organizationName: "Org A",
    scenarioTitle: null,
    assignedAt: 0,
    lecture: lecture && {
      ...lecture,
      lectureId: "01-nginx",
      title: "Repair Nginx",
      state: "available" as const,
      blockedBy: null,
    },
  });
  const privateCourse = { ...course, organizationId: "org-a", organizationName: "Org A" };

  it("places each assignment on its catalog course and keeps the rest", () => {
    const { byCourse, unmatched } = splitAssignments(
      [
        assignment("public", { courseId: "operations", scope: "organization-public" }),
        assignment("private", { courseId: "operations", scope: "organization-private" }),
        assignment("missing", { courseId: "gone", scope: "organization-public" }),
        assignment("no-lecture", null),
      ],
      [course, privateCourse],
    );
    expect(byCourse.get("public:operations")?.map((entry) => entry.assignmentId)).toEqual(["public"]);
    expect(byCourse.get("org-a:operations")?.map((entry) => entry.assignmentId)).toEqual(["private"]);
    expect(unmatched.map((entry) => entry.assignmentId)).toEqual(["missing", "no-lecture"]);
  });
});
