/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  issue: vi.fn(),
  featureFlag: vi.fn(),
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
vi.mock("@/lib/workshops/applications", () => ({
  issueWorkshopWorkspaceApplication: mocks.issue,
}));
vi.mock("@/lib/workshops/feature-flag", () => ({
  requireWorkshopsEnabledForSession: mocks.featureFlag,
}));

import { POST } from "./[sessionId]/applications/[applicationId]";

describe("workshop application issuance route", () => {
  beforeEach(() => {
    mocks.issue.mockReset();
    mocks.featureFlag.mockReset();
    mocks.featureFlag.mockResolvedValue(undefined);
  });

  it("returns the one-time URL as private no-store data after owner authorization", async () => {
    const issued = {
      routeId: "wa-route",
      url: "https://wa-route.intar.app/?__intar_bootstrap=single-use",
      bootstrapExpiresAt: 1_800_000_060_000,
      expiresAt: 1_800_000_900_000,
    };
    mocks.issue.mockResolvedValue(issued);
    const response = await POST({
      request: new Request("https://intar.dev/api/workshops/session-a/applications/gitea", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "workspace-a" }),
      }),
      params: { sessionId: "session-a", applicationId: "gitea" },
    } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    await expect(response.json()).resolves.toEqual(issued);
    expect(mocks.issue).toHaveBeenCalledWith({
      sessionId: "session-a",
      workspaceId: "workspace-a",
      applicationId: "gitea",
      actorUserId: "learner-a",
    });
  });
});
