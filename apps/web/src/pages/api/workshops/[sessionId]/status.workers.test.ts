/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  featureFlag: vi.fn(),
  getPreflight: vi.fn(),
  getStatus: vi.fn(),
}));

vi.mock("@/lib/agent-bridge", () => ({
  requireUserContext: mocks.requireUserContext,
  jsonResponse: (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: {
        "content-type": "application/json; charset=utf-8",
        ...Object.fromEntries(new Headers(init?.headers)),
      },
    }),
}));
vi.mock("@/lib/app-error", () => ({
  toErrorResponse: () => ({ status: 500, body: { error: "failed" } }),
}));
vi.mock("@/lib/workshops/feature-flag", () => ({
  requireWorkshopsEnabledForSession: mocks.featureFlag,
}));
vi.mock("@/lib/workshops/status", () => ({
  getWorkshopSessionStatusPreflight: mocks.getPreflight,
  getWorkshopSessionStatus: mocks.getStatus,
}));

import { GET } from "./status";

describe("workshop session status route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUserContext.mockResolvedValue({
      ok: true,
      context: { userId: "learner-a" },
    });
    mocks.featureFlag.mockResolvedValue(undefined);
    mocks.getPreflight.mockResolvedValue(preflight());
    mocks.getStatus.mockResolvedValue({
      version: "status-v2",
      managerVersion: null,
      requiresFullRefresh: false,
    });
  });

  it("returns changed private no-store status data", async () => {
    const response = await statusRequest();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      version: "status-v2",
      requiresFullRefresh: false,
    });
    expect(mocks.featureFlag).toHaveBeenCalledWith("session-a");
    expect(mocks.getPreflight).toHaveBeenCalledWith({
      sessionId: "session-a",
      userId: "learner-a",
      knownSessionVersion: null,
      knownManagerVersion: null,
    });
    expect(mocks.getStatus).toHaveBeenCalledWith({
      sessionId: "session-a",
      userId: "learner-a",
      knownSessionVersion: null,
      knownManagerVersion: null,
      preflight: preflight(),
    });
  });

  it("returns a private no-store 204 from the cheap revision before loading room status", async () => {
    mocks.getPreflight.mockResolvedValue(preflight("manager-v1"));

    const response = await statusRequest(
      "?version=status-v2&sessionVersion=7&managerVersion=manager-v1",
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.getPreflight).toHaveBeenCalledWith({
      sessionId: "session-a",
      userId: "learner-a",
      knownSessionVersion: 7,
      knownManagerVersion: "manager-v1",
    });
    expect(mocks.getStatus).not.toHaveBeenCalled();
  });

  it("keeps a matching status visible when the client must retry a full projection", async () => {
    mocks.getPreflight.mockResolvedValue(preflight("manager-v1", true));
    mocks.getStatus.mockResolvedValue({
      version: "status-v2",
      managerVersion: "manager-v1",
      requiresFullRefresh: true,
    });

    const response = await statusRequest(
      "?version=status-v2&sessionVersion=7&managerVersion=manager-v1",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      requiresFullRefresh: true,
    });
    expect(mocks.getStatus).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])("makes a %s auth response private no-store", async (status) => {
    mocks.requireUserContext.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "denied" }), {
        status,
        headers: { "content-type": "application/json" },
      }),
    });

    const response = await statusRequest();

    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.featureFlag).not.toHaveBeenCalled();
    expect(mocks.getPreflight).not.toHaveBeenCalled();
  });
});

function preflight(managerVersion: string | null = null, requiresFullRefresh = false) {
  return {
    version: "status-v2",
    managerVersion,
    requiresFullRefresh,
  };
}

function statusRequest(search = "") {
  return GET({
    request: new Request(
      `https://intar.dev/api/workshops/session-a/status${search}`,
    ),
    params: { sessionId: "session-a" },
  } as never);
}
