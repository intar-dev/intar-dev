import { afterEach, describe, expect, it, vi } from "vitest";
import {
  completeCourseLecture,
  CourseLectureLockedError,
  courseCatalogQueryKey,
  courseRouteForCatalogCourse,
  courseRouteForRun,
  fetchCourseCatalog,
  fetchCourseLecture,
  findNextCourseLecture,
  type CourseCatalogCourse,
} from "./course-wire";

const publicCourse: CourseCatalogCourse = {
  courseId: "kubernetes",
  organizationId: null,
  title: "Kubernetes basics",
  summary: "Learn the core model.",
  bodyMarkdown: "Course theory.",
  sequential: true,
  lectures: [
    lecture("01-replicas", "replicas"),
    lecture("02-rollout", "rollout"),
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("course learner wire contract", () => {
  it("uses separate public, organization-public, and organization-private routes", () => {
    expect(courseRouteForCatalogCourse(publicCourse, null)).toEqual({
      scope: "public",
      courseId: "kubernetes",
      organizationId: null,
    });
    expect(courseRouteForCatalogCourse(publicCourse, "team-a")).toEqual({
      scope: "organization-public",
      courseId: "kubernetes",
      organizationId: "team-a",
    });
    expect(
      courseRouteForCatalogCourse(
        { ...publicCourse, organizationId: "team-a" },
        "team-a",
      ),
    ).toEqual({
      scope: "organization-private",
      courseId: "kubernetes",
      organizationId: "team-a",
    });
  });

  it("maps only complete scoped run locations back to a lecture route", () => {
    expect(
      courseRouteForRun({
        courseId: "kubernetes",
        lectureId: "01-replicas",
        scope: "public",
      }),
    ).toEqual({
      scope: "public",
      courseId: "kubernetes",
      organizationId: null,
    });
    expect(
      courseRouteForRun({
        courseId: "kubernetes",
        scope: "organization-private",
        organizationId: "team-a",
      }),
    ).toEqual({
      scope: "organization-private",
      courseId: "kubernetes",
      organizationId: "team-a",
    });
    expect(courseRouteForRun({ courseId: "kubernetes" })).toBeNull();
  });

  it("finds the next lecture only inside the current scoped course", () => {
    expect(
      findNextCourseLecture({
        courses: [publicCourse],
        route: { scope: "public", courseId: "kubernetes", organizationId: null },
        lectureId: "01-replicas",
        scenarioId: "replicas",
      }),
    ).toMatchObject({ lectureId: "02-rollout" });
    expect(
      findNextCourseLecture({
        courses: [publicCourse],
        route: {
          scope: "organization-private",
          courseId: "kubernetes",
          organizationId: "team-a",
        },
        lectureId: "01-replicas",
        scenarioId: "replicas",
      }),
    ).toBeNull();
  });

  it("uses the V2 catalog and lecture endpoints with encoded IDs", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ courses: [], capacityPressure: null }))
      .mockResolvedValueOnce(jsonResponse({ courses: [], capacityPressure: null }))
      .mockResolvedValueOnce(
        jsonResponse({ course: publicCourse, lecture: publicCourse.lectures[0] }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ course: publicCourse, lecture: publicCourse.lectures[0] }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await fetchCourseCatalog("team/a");
    await fetchCourseLecture(
      {
        scope: "organization-public",
        organizationId: "team/a",
        courseId: "kubernetes / core",
      },
      "01 / replicas",
    );
    await completeCourseLecture(
      {
        scope: "organization-private",
        organizationId: "team/a",
        courseId: "kubernetes / core",
      },
      "01 / replicas",
    );
    await fetchCourseCatalog(null);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/organizations/team%2Fa/courses",
      { credentials: "include" },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/organizations/team%2Fa/courses/kubernetes%20%2F%20core/lectures/01%20%2F%20replicas?scope=public",
      { credentials: "include" },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/organizations/team%2Fa/courses/kubernetes%20%2F%20core/lectures/01%20%2F%20replicas/complete?scope=private",
      { credentials: "include", method: "POST" },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/courses", {
      credentials: "include",
    });
  });

  it("keeps a locked response separate from its lecture body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(
          {
            error: "Complete the introduction first.",
            code: "course_lecture_locked",
            blockedBy: {
              courseId: "kubernetes",
              lectureId: "01-replicas",
              title: "Desired replicas",
            },
            bodyMarkdown: "This must not be used.",
          },
          409,
        ),
      ),
    );

    let error: unknown;
    try {
      await fetchCourseLecture(
        { scope: "public", courseId: "kubernetes", organizationId: null },
        "02-rollout",
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(CourseLectureLockedError);
    expect(error).toMatchObject({
      name: "CourseLectureLockedError",
      blockedBy: {
        courseId: "kubernetes",
        lectureId: "01-replicas",
        title: "Desired replicas",
      },
    });
    expect(error).not.toHaveProperty("bodyMarkdown");
  });

  it("uses separate cache keys for public and organization catalogs", () => {
    expect(courseCatalogQueryKey(null)).toEqual(["courses", "public"]);
    expect(courseCatalogQueryKey("team-a")).toEqual([
      "courses",
      "organization",
      "team-a",
    ]);
  });
});

function lecture(lectureId: string, scenarioId: string) {
  return {
    lectureId,
    title: lectureId,
    summary: `${lectureId} summary`,
    category: "kubernetes",
    tags: ["kubernetes"],
    difficulty: "easy" as const,
    estimatedMinutes: 20,
    scenarioId,
    state: "available" as const,
    blockedBy: null,
    activeRunId: null,
    scenarioReady: true,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
