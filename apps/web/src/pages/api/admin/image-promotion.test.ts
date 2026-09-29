import type { APIContext } from "astro";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appError } from "@/lib/app-error";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  read: vi.fn(),
  start: vi.fn(),
  release: vi.fn(),
  refuse: vi.fn(),
}));
const CONTEXT = { userId: "operator", impersonated: false };
const VIEW = { attempt: null, holdingRuns: false, operatorDrained: false, pendingRevision: null, runningVms: 0 };

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/lib/agent-bridge", () => ({
  requireAdminUserContext: mocks.admin,
  jsonResponse: (body: unknown, init?: ResponseInit) => Response.json(body, init),
}));
vi.mock("@/lib/scenario-sources", () => ({ refuseScenarioSourceWrite: mocks.refuse }));
vi.mock("@/control-plane/image-promotion", () => ({
  readImagePromotion: mocks.read,
  startImagePromotion: mocks.start,
  releaseImagePromotion: mocks.release,
}));

import { GET, POST } from "./image-promotion";

describe("image promotion route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.admin.mockResolvedValue({ ok: true, context: CONTEXT });
    mocks.read.mockResolvedValue(VIEW);
    mocks.start.mockResolvedValue(VIEW);
    mocks.release.mockResolvedValue(VIEW);
    mocks.refuse.mockResolvedValue(null);
  });

  it("answers platform admins only", async () => {
    expect((await GET(context())).status).toBe(200);
    mocks.admin.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "admin required" }, { status: 403 }),
    });
    expect((await GET(context())).status).toBe(403);
    expect((await POST(context({ action: "release" }))).status).toBe(403);
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("answers the write guard's refusal without changing anything", async () => {
    mocks.refuse.mockResolvedValue(Response.json({ code: "rate_limited" }, { status: 429 }));
    expect((await POST(context({ action: "release" }))).status).toBe(429);
    mocks.refuse.mockRejectedValue(appError(403, "impersonation_forbidden", "no"));
    expect((await POST(context({ action: "release" }))).status).toBe(403);
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("starts or releases for the caller and refuses anything else", async () => {
    expect((await POST(context({ action: "start", revision: "git-1-a-b" }))).status).toBe(200);
    expect(mocks.start).toHaveBeenCalledWith({}, { revision: "git-1-a-b", actorUserId: "operator" });
    expect((await POST(context({ action: "release" }))).status).toBe(200);
    expect(mocks.release).toHaveBeenCalledWith({}, { actorUserId: "operator" });

    expect((await POST(context({ action: "start" }))).status).toBe(400);
    mocks.start.mockRejectedValue(appError(409, "promotion_in_progress", "held"));
    const held = await POST(context({ action: "start", revision: "git-1-a-b" }));
    expect(held.status).toBe(409);
    expect(await held.json()).toMatchObject({ code: "promotion_in_progress" });
  });
});

function context(body?: unknown): APIContext {
  return {
    request: new Request("https://intar.dev/api/admin/image-promotion", {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  } as APIContext;
}
