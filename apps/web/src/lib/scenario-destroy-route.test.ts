import { beforeEach, describe, expect, it, vi } from "vitest";

const agentBridgeMock = vi.hoisted(() => ({
  jsonResponse: vi.fn((body: unknown, init?: ResponseInit) =>
    Response.json(body, init),
  ),
  requireUserContext: vi.fn(),
}));
const scenarioRunsMock = vi.hoisted(() => ({
  courseLocationFromRunSnapshot: vi.fn(),
  destroyScenarioRunForUser: vi.fn(),
}));

vi.mock("@/lib/agent-bridge", () => agentBridgeMock);
vi.mock("@/lib/scenario-runs", () => scenarioRunsMock);

import { POST } from "@/pages/api/scenarios/runs/[runId]/destroy";

describe("scenario destroy route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentBridgeMock.requireUserContext.mockResolvedValue({
      ok: true,
      context: { userId: "user-1", isAdmin: false },
    });
    scenarioRunsMock.destroyScenarioRunForUser.mockResolvedValue({
      accepted: true,
      runId: "run-1",
      acceptedAt: 10,
      activeSlotReleased: true,
      run: { id: "run-1", activity: "background" },
    });
    scenarioRunsMock.courseLocationFromRunSnapshot.mockReturnValue(null);
  });

  it("returns the background snapshot and long-running-operation headers", async () => {
    const response = await POST({
      request: new Request(
        "https://intar.test/api/scenarios/runs/run-1/destroy",
        { method: "POST" },
      ),
      params: { runId: "run-1" },
    } as never);

    expect(response.status).toBe(202);
    expect(response.headers.get("location")).toBe(
      "/api/scenarios/runs/run-1",
    );
    expect(response.headers.get("retry-after")).toBe("1");
    await expect(response.json()).resolves.toMatchObject({
      activeSlotReleased: true,
      run: { id: "run-1", activity: "background" },
    });
  });
});
