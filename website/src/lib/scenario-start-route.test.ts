import { beforeEach, describe, expect, it, vi } from "vitest";

const agentBridgeMock = vi.hoisted(() => ({
  jsonResponse: vi.fn((body: unknown, init?: ResponseInit) =>
    Response.json(body, init),
  ),
  requireUserContext: vi.fn(),
}));
const scenarioRunsMock = vi.hoisted(() => ({
  startScenarioRunForUser: vi.fn(),
}));

vi.mock("@/lib/agent-bridge", () => agentBridgeMock);
vi.mock("@/lib/scenario-runs", () => scenarioRunsMock);

import { POST } from "@/pages/api/scenarios/[scenarioId]/start";

describe("scenario start route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentBridgeMock.requireUserContext.mockResolvedValue({
      ok: true,
      context: {
        userId: "user-1",
        isAdmin: false,
      },
    });
    scenarioRunsMock.startScenarioRunForUser.mockResolvedValue({
      accepted: true,
      runId: "run-1",
      scenarioId: "pair-ping",
      acceptedAt: 1,
      reused: false,
    });
  });

  it("keeps the ordinary scenario launch bodyless and scheduler-driven", async () => {
    const response = await startRequest();

    expect(response.status).toBe(202);
    expect(scenarioRunsMock.startScenarioRunForUser).toHaveBeenCalledWith({
      scenarioId: "pair-ping",
      userId: "user-1",
    });
  });

  it("forwards an explicit host only for an administrator", async () => {
    agentBridgeMock.requireUserContext.mockResolvedValue({
      ok: true,
      context: { userId: "admin-1", isAdmin: true },
    });

    const response = await startRequest({ hostId: "agent-01" });

    expect(response.status).toBe(202);
    expect(scenarioRunsMock.startScenarioRunForUser).toHaveBeenCalledWith({
      scenarioId: "pair-ping",
      userId: "admin-1",
      hostId: "agent-01",
    });
  });

  it("rejects a host override from a non-admin user", async () => {
    const response = await startRequest({ hostId: "agent-01" });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "admin required" });
    expect(scenarioRunsMock.startScenarioRunForUser).not.toHaveBeenCalled();
  });

  it("rejects malformed host overrides", async () => {
    const response = await startRequest({ hostId: 42 });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "hostId must be a string",
    });
    expect(scenarioRunsMock.startScenarioRunForUser).not.toHaveBeenCalled();
  });

  it("rejects empty host overrides", async () => {
    const response = await startRequest({ hostId: "  " });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "hostId must not be empty",
    });
    expect(scenarioRunsMock.startScenarioRunForUser).not.toHaveBeenCalled();
  });

  it("rejects non-object json bodies", async () => {
    const response = await startRequest(null);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "json body must be an object",
    });
    expect(scenarioRunsMock.startScenarioRunForUser).not.toHaveBeenCalled();
  });

});

async function startRequest(
  body?: unknown,
  scenarioId = "pair-ping",
): Promise<Response> {
  const request = new Request(
    `https://intar.test/api/scenarios/${scenarioId}/start`,
    {
      method: "POST",
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    },
  );
  return POST({
    request,
    params: { scenarioId },
  } as never);
}
