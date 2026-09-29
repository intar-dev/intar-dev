import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  context: { userId: "user", isAdmin: false },
  drizzle: vi.fn(),
  list: vi.fn(),
  log: vi.fn(),
}));

vi.mock("@/lib/agent-bridge", () => ({
  requireUserContext: async () => ({ ok: true, context: mocks.context }),
  jsonResponse: (body: unknown, init?: ResponseInit) => Response.json(body, init),
}));
vi.mock("drizzle-orm/d1", () => ({ drizzle: mocks.drizzle }));
vi.mock("cloudflare:workers", () => ({ env: { DB: "test-db" } }));
vi.mock("@/lib/organization-builds", () => ({
  listAdministeredBuilds: mocks.list,
  readAdministeredBuildLog: mocks.log,
}));

import { GET as list } from "@/pages/api/admin/builds/index";
import { GET as log } from "@/pages/api/admin/builds/[buildId]/log";

const call = (route: typeof list, buildId?: string) =>
  route({ request: new Request("https://intar.test"), params: { buildId } } as never);

describe("builds for organization admins", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.context.isAdmin = false;
    mocks.drizzle.mockImplementation(() => {
      throw new Error("platform query");
    });
  });

  it("lists only the caller's organization builds, and refuses everyone else", async () => {
    mocks.list.mockResolvedValue([{ id: "build-a" }]);
    const response = await call(list);
    expect(await response.json()).toEqual({ builds: [{ id: "build-a" }] });
    expect(mocks.list).toHaveBeenCalledWith("user");

    mocks.list.mockResolvedValue(null);
    expect((await call(list)).status).toBe(403);
    expect(mocks.drizzle).not.toHaveBeenCalled();
  });

  it("serves only an administered build's log", async () => {
    mocks.log.mockResolvedValue("redacted");
    const response = await call(log, "build-a");
    expect(await response.text()).toBe("redacted");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.log).toHaveBeenCalledWith("user", "build-a");

    mocks.log.mockResolvedValue(null);
    expect((await call(log, "build-b")).status).toBe(404);
    expect(mocks.drizzle).not.toHaveBeenCalled();
  });

  it("keeps the platform view for platform admins", async () => {
    mocks.context.isAdmin = true;
    await expect(call(list)).rejects.toThrow("platform query");
    await expect(call(log, "build-a")).rejects.toThrow("platform query");
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.log).not.toHaveBeenCalled();
  });
});
