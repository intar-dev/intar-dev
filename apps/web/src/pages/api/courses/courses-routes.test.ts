import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: { name: "course-route-db" },
  drizzle: vi.fn(),
  requireUserContext: vi.fn(),
  jsonResponse: vi.fn((body: unknown, init?: ResponseInit) =>
    Response.json(body, init),
  ),
  resolveOrganizationId: vi.fn(),
  requireOrganizationRole: vi.fn(),
  listCourseCatalogForUser: vi.fn(),
  loadCourseLectureDetailForUser: vi.fn(),
  completePureCourseLectureForUser: vi.fn(),
  loadScenarioCapacityPressure: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: { DB: "test-db" } }));
vi.mock("drizzle-orm/d1", () => ({ drizzle: mocks.drizzle }));
vi.mock("@/lib/agent-bridge", () => ({
  requireUserContext: mocks.requireUserContext,
  jsonResponse: mocks.jsonResponse,
}));
vi.mock("@/lib/organizations", () => ({
  resolveOrganizationId: mocks.resolveOrganizationId,
  requireOrganizationRole: mocks.requireOrganizationRole,
}));
vi.mock("@/lib/course-catalogs", () => ({
  listCourseCatalogForUser: mocks.listCourseCatalogForUser,
  loadCourseLectureDetailForUser: mocks.loadCourseLectureDetailForUser,
  completePureCourseLectureForUser: mocks.completePureCourseLectureForUser,
}));
vi.mock("@/lib/scenario-runs/start", () => ({
  loadScenarioCapacityPressure: mocks.loadScenarioCapacityPressure,
}));

import { GET as publicCatalog } from "@/pages/api/courses";
import { POST as publicComplete } from "@/pages/api/courses/[courseId]/lectures/[lectureId]/complete";
import { GET as publicLecture } from "@/pages/api/courses/[courseId]/lectures/[lectureId]";
import { GET as organizationCatalog } from "@/pages/api/organizations/[orgId]/courses";
import { POST as organizationComplete } from "@/pages/api/organizations/[orgId]/courses/[courseId]/lectures/[lectureId]/complete";
import { GET as organizationLecture } from "@/pages/api/organizations/[orgId]/courses/[courseId]/lectures/[lectureId]";

const detail = {
  course: {
    courseId: "course-1",
    organizationId: null,
    title: "Course",
    summary: "Summary",
    sequential: true,
  },
  lecture: {
    lectureId: "lecture-1",
    title: "Lecture",
    summary: "Summary",
    bodyMarkdown: "Theory",
    category: "linux",
    tags: [],
    estimatedMinutes: 10,
    scenarioId: null,
    state: "available",
    blockedBy: null,
    activeRunId: null,
    scenarioReady: null,
    previousLecture: null,
    nextLecture: null,
    lectureOrdinal: 1,
    lectureCount: 1,
  },
};

describe("course routes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.drizzle.mockReturnValue(mocks.db);
    mocks.requireUserContext.mockResolvedValue({
      ok: true,
      context: { userId: "learner-1", isAdmin: false },
    });
    mocks.resolveOrganizationId.mockResolvedValue("organization-1");
    mocks.requireOrganizationRole.mockResolvedValue("member");
    mocks.loadScenarioCapacityPressure.mockResolvedValue(73);
    mocks.listCourseCatalogForUser.mockResolvedValue({
      courses: [],
      capacityPressure: 73,
    });
    mocks.loadCourseLectureDetailForUser.mockResolvedValue({
      ok: true,
      detail,
    });
    mocks.completePureCourseLectureForUser.mockResolvedValue(detail);
  });

  it("lists the public catalog with the learner's admin sequence permission", async () => {
    mocks.requireUserContext.mockResolvedValueOnce({
      ok: true,
      context: { userId: "admin-1", isAdmin: true },
    });

    const response = await publicCatalog(context("/api/courses"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      courses: [],
      capacityPressure: 73,
    });
    expect(mocks.listCourseCatalogForUser).toHaveBeenCalledWith({
      db: mocks.db,
      userId: "admin-1",
      organizationId: null,
      capacityPressure: 73,
      allowSequenceBypass: true,
    });
    expect(mocks.loadScenarioCapacityPressure).toHaveBeenCalledWith(null);
  });

  it("does not expose a locked public lecture body", async () => {
    const blockedBy = {
      courseId: "course-1",
      lectureId: "lecture-0",
      title: "Required lecture",
    };
    mocks.loadCourseLectureDetailForUser.mockResolvedValueOnce({
      ok: false,
      blockedBy,
    });

    const response = await publicLecture(
      context("/api/courses/course-1/lectures/lecture-1", {
        courseId: "course-1",
        lectureId: "lecture-1",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      locked: true,
      blockedBy,
    });
  });

  it("allows an organization member to read an organization catalog", async () => {
    const response = await organizationCatalog(
      context("/api/organizations/academy/courses", { orgId: "academy" }),
    );

    expect(response.status).toBe(200);
    expect(mocks.resolveOrganizationId).toHaveBeenCalledWith("academy");
    expect(mocks.requireOrganizationRole).toHaveBeenCalledWith({
      organizationId: "organization-1",
      userId: "learner-1",
    });
    expect(mocks.listCourseCatalogForUser).toHaveBeenCalledWith({
      db: mocks.db,
      userId: "learner-1",
      organizationId: "organization-1",
      capacityPressure: 73,
      allowSequenceBypass: false,
    });
    expect(mocks.loadScenarioCapacityPressure).toHaveBeenCalledWith(
      "organization-1",
    );
  });

  it("returns the same locked response after organization membership checks", async () => {
    const blockedBy = {
      courseId: "course-1",
      lectureId: "lecture-0",
      title: "Required lecture",
    };
    mocks.loadCourseLectureDetailForUser.mockResolvedValueOnce({
      ok: false,
      blockedBy,
    });

    const response = await organizationLecture(
      context(
        "/api/organizations/academy/courses/course-1/lectures/lecture-1?scope=private",
        {
          orgId: "academy",
          courseId: "course-1",
          lectureId: "lecture-1",
        },
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      locked: true,
      blockedBy,
    });
    expect(mocks.requireOrganizationRole).toHaveBeenCalledWith({
      organizationId: "organization-1",
      userId: "learner-1",
    });
    expect(mocks.loadCourseLectureDetailForUser).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "organization-1",
        courseScope: "private",
      }),
    );
  });

  it("requires an organization course scope before it reads a lecture", async () => {
    const response = await organizationLecture(
      context("/api/organizations/academy/courses/course-1/lectures/lecture-1", {
        orgId: "academy",
        courseId: "course-1",
        lectureId: "lecture-1",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "scope must be public or private",
    });
    expect(mocks.resolveOrganizationId).not.toHaveBeenCalled();
    expect(mocks.loadCourseLectureDetailForUser).not.toHaveBeenCalled();
  });

  it("completes pure lectures with the current time and the admin sequence permission", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_234);
    mocks.requireUserContext.mockResolvedValueOnce({
      ok: true,
      context: { userId: "admin-1", isAdmin: true },
    });

    const response = await publicComplete(
      context("/api/courses/course-1/lectures/lecture-1/complete", {
        courseId: "course-1",
        lectureId: "lecture-1",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(detail);
    expect(mocks.completePureCourseLectureForUser).toHaveBeenCalledWith({
      db: mocks.db,
      userId: "admin-1",
      organizationId: null,
      courseId: "course-1",
      lectureId: "lecture-1",
      nowUnixMs: 1_234,
      allowSequenceBypass: true,
    });
  });

  it("keeps organization pure completion member-scoped", async () => {
    const response = await organizationComplete(
      context(
        "/api/organizations/academy/courses/course-1/lectures/lecture-1/complete?scope=private",
        {
          orgId: "academy",
          courseId: "course-1",
          lectureId: "lecture-1",
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.requireOrganizationRole).toHaveBeenCalledWith({
      organizationId: "organization-1",
      userId: "learner-1",
    });
    expect(mocks.completePureCourseLectureForUser).toHaveBeenCalledWith(
      expect.objectContaining({
        db: mocks.db,
        userId: "learner-1",
        organizationId: "organization-1",
        courseId: "course-1",
        lectureId: "lecture-1",
        courseScope: "private",
        allowSequenceBypass: false,
      }),
    );
  });
});

function context(path: string, params: Record<string, string> = {}) {
  return {
    request: new Request(`https://intar.test${path}`),
    params,
  } as never;
}
