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
        authentication: { method: "session", purpose: "interactive" },
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

  it("forwards explicit benchmark admission only with an administrator-owned host pin", async () => {
    agentBridgeMock.requireUserContext.mockResolvedValue({
      ok: true,
      context: { userId: "admin-1", isAdmin: true },
    });

    const response = await startRequest({
      hostId: "agent-01",
      admissionMode: "benchmark",
    });

    expect(response.status).toBe(202);
    expect(scenarioRunsMock.startScenarioRunForUser).toHaveBeenCalledWith({
      scenarioId: "pair-ping",
      userId: "admin-1",
      hostId: "agent-01",
      admissionMode: "benchmark",
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

  it("rejects benchmark admission without a pinned host", async () => {
    agentBridgeMock.requireUserContext.mockResolvedValue({
      ok: true,
      context: { userId: "admin-1", isAdmin: true },
    });

    const response = await startRequest({ admissionMode: "benchmark" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "benchmark admission requires hostId",
    });
    expect(scenarioRunsMock.startScenarioRunForUser).not.toHaveBeenCalled();
  });

  it("rejects unknown admission modes", async () => {
    agentBridgeMock.requireUserContext.mockResolvedValue({
      ok: true,
      context: { userId: "admin-1", isAdmin: true },
    });

    const response = await startRequest({
      hostId: "agent-01",
      admissionMode: "ordinary",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'admissionMode must be "benchmark"',
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

  it("requires the operator credential to use exact benchmark admission on its bound host", async () => {
    agentBridgeMock.requireUserContext.mockResolvedValue({
      ok: true,
      context: {
        userId: "benchmark-admin",
        isAdmin: true,
        authentication: {
          method: "boot_benchmark",
          purpose: "broken_nginx_boot_benchmark",
          hostId: "benchmark-agent",
          notBeforeUnixMs: 4_102_434_000_000,
          expiresAtUnixMs: 4_102_444_800_000,
        },
      },
    });

    for (const [scenarioId, body] of [
      ["broken-nginx", undefined],
      ["broken-nginx", { hostId: "benchmark-agent" }],
      ["broken-nginx", { hostId: "other-agent", admissionMode: "benchmark" }],
      ["pair-ping", { hostId: "benchmark-agent", admissionMode: "benchmark" }],
    ] as const) {
      const response = await startRequest(body, scenarioId);
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error:
          "boot benchmark credential requires broken-nginx benchmark admission on its configured host",
      });
    }
    expect(scenarioRunsMock.startScenarioRunForUser).not.toHaveBeenCalled();
  });

  it("accepts only the bound broken-nginx benchmark start for the operator credential", async () => {
    agentBridgeMock.requireUserContext.mockResolvedValue({
      ok: true,
      context: {
        userId: "benchmark-admin",
        isAdmin: true,
        authentication: {
          method: "boot_benchmark",
          purpose: "broken_nginx_boot_benchmark",
          hostId: "benchmark-agent",
          notBeforeUnixMs: 4_102_434_000_000,
          expiresAtUnixMs: 4_102_444_800_000,
        },
      },
    });
    scenarioRunsMock.startScenarioRunForUser.mockResolvedValue({
      accepted: true,
      runId: "run-benchmark",
      scenarioId: "broken-nginx",
      acceptedAt: 1,
      reused: false,
    });

    const response = await startRequest(
      { hostId: "benchmark-agent", admissionMode: "benchmark" },
      "broken-nginx",
    );

    expect(response.status).toBe(202);
    expect(scenarioRunsMock.startScenarioRunForUser).toHaveBeenCalledWith({
      scenarioId: "broken-nginx",
      userId: "benchmark-admin",
      hostId: "benchmark-agent",
      admissionMode: "benchmark",
      benchmarkCredentialWindow: {
        notBeforeUnixMs: 4_102_434_000_000,
        expiresAtUnixMs: 4_102_444_800_000,
      },
    });
  });

  it("rejects extra fields in the operator benchmark start body", async () => {
    agentBridgeMock.requireUserContext.mockResolvedValue({
      ok: true,
      context: {
        userId: "benchmark-admin",
        isAdmin: true,
        authentication: {
          method: "boot_benchmark",
          purpose: "broken_nginx_boot_benchmark",
          hostId: "benchmark-agent",
          notBeforeUnixMs: 4_102_434_000_000,
          expiresAtUnixMs: 4_102_444_800_000,
        },
      },
    });

    const response = await startRequest(
      {
        hostId: "benchmark-agent",
        admissionMode: "benchmark",
        unexpected: true,
      },
      "broken-nginx",
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "boot benchmark start body contains unexpected fields",
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
