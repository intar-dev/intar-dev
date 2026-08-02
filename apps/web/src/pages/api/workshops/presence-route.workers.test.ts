/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  featureFlag: vi.fn(),
  recordPresence: vi.fn(),
}));

vi.mock("@/lib/agent-bridge", () => ({
  requireUserContext: async () => ({
    ok: true as const,
    context: { userId: "learner-a" },
  }),
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
vi.mock("@/lib/workshops/presence", () => ({
  recordWorkshopPresence: mocks.recordPresence,
}));

import { POST } from "./[sessionId]/presence";

describe("workshop presence route", () => {
  beforeEach(() => {
    mocks.featureFlag.mockReset();
    mocks.featureFlag.mockResolvedValue(undefined);
    mocks.recordPresence.mockReset();
  });

  it("records a roster-authorized heartbeat as private server-time data", async () => {
    const presence = {
      observedAt: 1_800_000_000_000,
      lastSeenAt: 1_800_000_000_000,
      state: "present",
    };
    mocks.recordPresence.mockResolvedValue(presence);

    const response = await POST({
      request: new Request(
        "https://intar.dev/api/workshops/session-a/presence",
        { method: "POST" },
      ),
      params: { sessionId: "session-a" },
    } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual(presence);
    expect(mocks.featureFlag).toHaveBeenCalledWith("session-a");
    expect(mocks.recordPresence).toHaveBeenCalledWith({
      sessionId: "session-a",
      userId: "learner-a",
    });
  });
});
