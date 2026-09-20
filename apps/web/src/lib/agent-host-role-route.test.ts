import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  drizzle: vi.fn(),
  requireAdminUserContext: vi.fn(),
  requireUserContext: vi.fn(),
}));

vi.mock("@/lib/agent-bridge", () => ({
  ...mocks,
  jsonResponse: (body: unknown, init?: ResponseInit) => Response.json(body, init),
}));
vi.mock("drizzle-orm/d1", () => ({ drizzle: mocks.drizzle }));
vi.mock("cloudflare:workers", () => ({ env: { DB: "test-db" } }));
vi.mock("@/lib/organizations", () => ({ resolveOrganizationId: vi.fn() }));

import { POST as hostConfig } from "@/pages/api/agent/hosts";

describe("removed legacy host config routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["personal", hostConfig, "/api/agent/hosts"],
  ] as const)("rejects every %s config request before accessing credentials", async (_label, route, path) => {
    for (const body of [
      undefined,
      "invalid json",
      JSON.stringify({ name: "New server" }),
      JSON.stringify({ hostId: "host-1", runnerId: "host-1", role: "agent" }),
      JSON.stringify({ hostId: "host-1", runnerId: "host-1", role: "builder" }),
    ]) {
      const request = new Request(`https://intar.test${path}`, {
        method: "POST",
        body: body ?? null,
      });
      const response = await route({ request, params: { orgId: "org-1" } } as never);

      expect(response.status).toBe(410);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({
        error: "Legacy server registration is no longer available. Install and enroll this server again.",
        code: "fresh_enrollment_required",
      });
    }
    expect(mocks.drizzle).not.toHaveBeenCalled();
    expect(mocks.requireAdminUserContext).not.toHaveBeenCalled();
    expect(mocks.requireUserContext).not.toHaveBeenCalled();
  });
});
