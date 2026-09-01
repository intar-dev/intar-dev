import { beforeEach, describe, expect, it, vi } from "vitest";

const agentBridgeMock = vi.hoisted(() => ({
  jsonResponse: vi.fn((body: unknown, init?: ResponseInit) =>
    Response.json(body, init),
  ),
  requireUserContext: vi.fn(),
}));
const scenarioRunsMock = vi.hoisted(() => ({
  loadEnabledScenarioForUser: vi.fn(),
}));
const courseCatalogMock = vi.hoisted(() => ({
  resolveCourseLectureForScenario: vi.fn(),
}));
const drizzleMock = vi.hoisted(() => ({ drizzle: vi.fn(() => ({})) }));
const organizationsMock = vi.hoisted(() => ({
  resolveOrganizationId: vi.fn(),
}));

vi.mock("@/lib/agent-bridge", () => agentBridgeMock);
vi.mock("@/lib/scenario-runs", () => scenarioRunsMock);
vi.mock("@/lib/scenario-course-catalogs", () => courseCatalogMock);
vi.mock("@/lib/organizations", () => organizationsMock);
vi.mock("cloudflare:workers", () => ({ env: { DB: {} } }));
vi.mock("drizzle-orm/d1", () => drizzleMock);

import { GET } from "@/pages/api/scenarios/[scenarioId]";

describe("scenario detail route organization scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentBridgeMock.requireUserContext.mockResolvedValue({
      ok: true,
      context: { userId: "learner", organizationIds: ["org-id"] },
    });
    scenarioRunsMock.loadEnabledScenarioForUser.mockResolvedValue({
      scenarioId: "repair-nginx",
    });
    courseCatalogMock.resolveCourseLectureForScenario.mockResolvedValue({
      state: "available",
      scenarioReady: true,
      blockedBy: null,
    });
  });

  it("does not load a scenario for an unknown organization key", async () => {
    organizationsMock.resolveOrganizationId.mockResolvedValue(null);

    const response = await request("unknown-org");

    expect(response.status).toBe(404);
    expect(scenarioRunsMock.loadEnabledScenarioForUser).not.toHaveBeenCalled();
    expect(courseCatalogMock.resolveCourseLectureForScenario).not.toHaveBeenCalled();
  });

  it("does not load a scenario outside the user's organization membership", async () => {
    organizationsMock.resolveOrganizationId.mockResolvedValue("other-org");

    const response = await request("other-org");

    expect(response.status).toBe(404);
    expect(scenarioRunsMock.loadEnabledScenarioForUser).not.toHaveBeenCalled();
    expect(courseCatalogMock.resolveCourseLectureForScenario).not.toHaveBeenCalled();
  });

  it("normalizes an organization slug to its canonical ID", async () => {
    organizationsMock.resolveOrganizationId.mockResolvedValue("org-id");

    const response = await request("platform-repair-crew");

    expect(response.status).toBe(200);
    expect(scenarioRunsMock.loadEnabledScenarioForUser).toHaveBeenCalledWith({
      scenarioId: "repair-nginx",
      userId: "learner",
      organizationId: "org-id",
    });
  });

  it("does not expose a locked lecture through the legacy scenario detail route", async () => {
    courseCatalogMock.resolveCourseLectureForScenario.mockResolvedValueOnce({
      state: "locked",
      scenarioReady: true,
      blockedBy: {
        courseId: "linux",
        lectureId: "01-theory",
        title: "Theory",
      },
    });

    const response = await request();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "course_lecture_locked",
      blockedBy: { lectureId: "01-theory" },
    });
    expect(scenarioRunsMock.loadEnabledScenarioForUser).not.toHaveBeenCalled();
  });
});

async function request(organizationId?: string): Promise<Response> {
  const query = organizationId
    ? `?organizationId=${encodeURIComponent(organizationId)}`
    : "";
  return GET({
    request: new Request(
      `https://intar.test/api/scenarios/repair-nginx${query}`,
    ),
    params: { scenarioId: "repair-nginx" },
  } as never);
}
