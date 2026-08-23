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
const betaAdmission = {
  sourceInviteId: "invite-1",
  sourceLeaseId: "lease-1",
  grantedAt: 1,
};

vi.mock("@/lib/agent-bridge", () => agentBridgeMock);
vi.mock("@/lib/scenario-runs", () => scenarioRunsMock);

import { POST } from "@/pages/api/scenarios/[scenarioId]/start";
import { appError } from "@/lib/app-error";

describe("scenario start route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentBridgeMock.requireUserContext.mockResolvedValue({
      ok: true,
      context: {
        userId: "user-1",
        isAdmin: false,
        betaAdmission,
      },
    });
    scenarioRunsMock.startScenarioRunForUser.mockResolvedValue({
      accepted: true,
      runId: "run-1",
      scenarioId: "pair-ping",
      acceptedAt: 1,
      reused: false,
      run: { id: "run-1" },
    });
  });

  it("starts an ordinary scenario from an empty JSON object", async () => {
    const response = await startRequest();

    expect(response.status).toBe(202);
    expect(response.headers.get("location")).toBe(
      "/api/scenarios/runs/run-1",
    );
    expect(response.headers.get("retry-after")).toBe("1");
    await expect(response.json()).resolves.toMatchObject({
      run: { id: "run-1" },
    });
    expect(scenarioRunsMock.startScenarioRunForUser).toHaveBeenCalledWith({
      scenarioId: "pair-ping",
      userId: "user-1",
      betaAdmission,
    });
  });

  it("also accepts a valid bodyless scenario launch", async () => {
    const response = await bodylessStartRequest();

    expect(response.status).toBe(202);
    expect(scenarioRunsMock.startScenarioRunForUser).toHaveBeenCalledWith({
      scenarioId: "pair-ping",
      userId: "user-1",
      betaAdmission,
    });
  });

  it("forwards an explicit host only for an administrator", async () => {
    agentBridgeMock.requireUserContext.mockResolvedValue({
      ok: true,
      context: { userId: "admin-1", isAdmin: true, betaAdmission },
    });

    const response = await startRequest({ hostId: "agent-01" });

    expect(response.status).toBe(202);
    expect(scenarioRunsMock.startScenarioRunForUser).toHaveBeenCalledWith({
      scenarioId: "pair-ping",
      userId: "admin-1",
      betaAdmission,
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

  it("tells capacity waiters when to retry", async () => {
    scenarioRunsMock.startScenarioRunForUser.mockRejectedValueOnce(
      appError(
        409,
        "boot_capacity_pending",
        "scenario boot CPU capacity is pending; retry shortly",
      ),
    );

    const response = await startRequest();

    expect(response.status).toBe(409);
    expect(response.headers.get("retry-after")).toBe("2");
    await expect(response.json()).resolves.toMatchObject({
      code: "boot_capacity_pending",
    });
  });

});

async function startRequest(
  body: unknown = {},
  scenarioId = "pair-ping",
): Promise<Response> {
  const request = new Request(
    `https://intar.test/api/scenarios/${scenarioId}/start`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return POST({
    request,
    params: { scenarioId },
  } as never);
}

async function bodylessStartRequest(): Promise<Response> {
  return POST({
    request: new Request("https://intar.test/api/scenarios/pair-ping/start", {
      method: "POST",
    }),
    params: { scenarioId: "pair-ping" },
  } as never);
}
