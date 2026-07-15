import { beforeEach, describe, expect, it, vi } from "vitest";

const agentBridgeMock = vi.hoisted(() => ({
  jsonResponse: vi.fn((body: unknown, init?: ResponseInit) =>
    Response.json(body, init),
  ),
  requireUserContext: vi.fn(),
}));
const scenarioRunsMock = vi.hoisted(() => ({
  createScenarioSshSessionForUser: vi.fn(),
  destroyScenarioRunForUser: vi.fn(),
}));

vi.mock("@/lib/agent-bridge", () => agentBridgeMock);
vi.mock("@/lib/scenario-runs", () => scenarioRunsMock);

import { POST as destroyRun } from "@/pages/api/scenarios/runs/[runId]/destroy";
import { POST as createSshSession } from "@/pages/api/scenarios/runs/[runId]/ssh";

describe("boot benchmark run route body fences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentBridgeMock.requireUserContext.mockResolvedValue(
      benchmarkAuthorization(),
    );
    scenarioRunsMock.createScenarioSshSessionForUser.mockResolvedValue({
      browser: { websocketUrl: "wss://terminal.example.test/session" },
    });
    scenarioRunsMock.destroyScenarioRunForUser.mockResolvedValue({
      accepted: true,
    });
  });

  it("requires browser mode to be explicit for benchmark SSH sessions", async () => {
    for (const body of [{ vmId: "vm-1" }, { vmId: "vm-1", mode: "native" }]) {
      const response = await createSshSession(
        routeContext(
          jsonRequest("https://intar.test/api/scenarios/runs/run-1/ssh", body),
        ),
      );
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "boot benchmark credential requires browser SSH mode",
      });
    }
    expect(
      scenarioRunsMock.createScenarioSshSessionForUser,
    ).not.toHaveBeenCalled();
  });

  it("permits the exact browser SSH request for the benchmark-owned run", async () => {
    const response = await createSshSession(
      routeContext(
        jsonRequest("https://intar.test/api/scenarios/runs/run-1/ssh", {
          vmId: "vm-1",
          mode: "browser",
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(
      scenarioRunsMock.createScenarioSshSessionForUser,
    ).toHaveBeenCalledWith({
      runId: "run-1",
      vmId: "vm-1",
      userId: "benchmark-admin",
      mode: "browser",
    });
  });

  it("rejects extra fields in the benchmark SSH body", async () => {
    const response = await createSshSession(
      routeContext(
        jsonRequest("https://intar.test/api/scenarios/runs/run-1/ssh", {
          vmId: "vm-1",
          mode: "browser",
          unexpected: true,
        }),
      ),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "boot benchmark SSH body contains unexpected fields",
    });
    expect(
      scenarioRunsMock.createScenarioSshSessionForUser,
    ).not.toHaveBeenCalled();
  });

  it("rejects a benchmark destroy body and accepts an empty request", async () => {
    const rejected = await destroyRun(
      routeContext(
        jsonRequest("https://intar.test/api/scenarios/runs/run-1/destroy", {}),
      ),
    );
    expect(rejected.status).toBe(403);
    await expect(rejected.json()).resolves.toEqual({
      error: "boot benchmark destroy request must not contain a body",
    });
    expect(scenarioRunsMock.destroyScenarioRunForUser).not.toHaveBeenCalled();

    const accepted = await destroyRun(
      routeContext(
        new Request("https://intar.test/api/scenarios/runs/run-1/destroy", {
          method: "POST",
        }),
      ),
    );
    expect(accepted.status).toBe(202);
    expect(scenarioRunsMock.destroyScenarioRunForUser).toHaveBeenCalledWith({
      runId: "run-1",
      userId: "benchmark-admin",
    });
  });

  it("keeps normal-session SSH defaults and destroy bodies unchanged", async () => {
    agentBridgeMock.requireUserContext.mockResolvedValue({
      ok: true,
      context: {
        userId: "session-admin",
        isAdmin: true,
        authentication: { method: "session", purpose: "interactive" },
      },
    });

    const sshResponse = await createSshSession(
      routeContext(
        jsonRequest("https://intar.test/api/scenarios/runs/run-1/ssh", {
          vmId: "vm-1",
        }),
      ),
    );
    const destroyResponse = await destroyRun(
      routeContext(
        jsonRequest("https://intar.test/api/scenarios/runs/run-1/destroy", {}),
      ),
    );

    expect(sshResponse.status).toBe(200);
    expect(
      scenarioRunsMock.createScenarioSshSessionForUser,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "browser", userId: "session-admin" }),
    );
    expect(destroyResponse.status).toBe(202);
    expect(scenarioRunsMock.destroyScenarioRunForUser).toHaveBeenCalledWith({
      runId: "run-1",
      userId: "session-admin",
    });
  });
});

function benchmarkAuthorization() {
  return {
    ok: true,
    context: {
      userId: "benchmark-admin",
      isAdmin: true,
      authentication: {
        method: "boot_benchmark",
        purpose: "broken_nginx_boot_benchmark",
        hostId: "benchmark-agent",
        notBeforeUnixMs: 1,
        expiresAtUnixMs: 2,
      },
    },
  };
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function routeContext(request: Request) {
  return {
    request,
    params: { runId: "run-1" },
  } as never;
}
