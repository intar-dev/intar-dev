import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => ({
  jsonResponse: vi.fn(
    (body: unknown, init?: ResponseInit) => Response.json(body, init),
  ),
  requireAdminUserContext: vi.fn(),
}));
const dbMock = vi.hoisted(() => ({
  db: {},
  drizzle: vi.fn(),
}));
const schedulerMock = vi.hoisted(() => ({
  retryImageBuild: vi.fn(),
}));

vi.mock("@/lib/agent-bridge", () => authMock);
vi.mock("drizzle-orm/d1", () => ({ drizzle: dbMock.drizzle }));
vi.mock("cloudflare:workers", () => ({ env: { DB: "test-db" } }));
vi.mock("@/lib/build-scheduler", () => schedulerMock);

import { POST } from "@/pages/api/admin/builds/[buildId]/retry";

describe("admin build retry route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.drizzle.mockReturnValue(dbMock.db);
    authMock.requireAdminUserContext.mockResolvedValue({
      ok: true,
      context: { userId: "admin-user", isAdmin: true },
    });
  });

  it("rejects a superseded build without requeueing it", async () => {
    schedulerMock.retryImageBuild.mockResolvedValue({
      outcome: "not_retryable",
      status: "stale",
    });

    const request = new Request(
      "https://intar.test/api/admin/builds/build-1/retry",
      { method: "POST" },
    );
    const response = await POST({
      request,
      params: { buildId: "build-1" },
    } as never);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "build status stale cannot be retried",
    });
    expect(schedulerMock.retryImageBuild).toHaveBeenCalledWith(dbMock.db, {
      buildId: "build-1",
      nowUnixMs: expect.any(Number),
    });
  });
});
