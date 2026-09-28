import type { APIContext } from "astro";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appError } from "@/lib/app-error";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  card: vi.fn(),
  change: vi.fn(),
  refuse: vi.fn(),
}));
const CONTEXT = { userId: "operator", impersonated: false };
const SCOPE = { key: "public", organizationId: null };

vi.mock("@/lib/agent-bridge", () => ({
  requireAdminUserContext: mocks.admin,
  jsonResponse: (body: unknown, init?: ResponseInit) =>
    Response.json(body, init),
}));
vi.mock("@/lib/scenario-sources", () => ({
  scenarioSourceScope: (id: string | null) => ({
    key: id === null ? "public" : `organization:${id}`,
    organizationId: id,
  }),
  scenarioSourceCard: mocks.card,
  changeScenarioSource: mocks.change,
  refuseScenarioSourceWrite: mocks.refuse,
}));

import { GET, POST } from "./scenario-source";

describe("public scenario source route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.admin.mockResolvedValue({ ok: true, context: CONTEXT });
    mocks.card.mockResolvedValue({ enabled: false, configured: false, appSlug: null, source: null });
    mocks.change.mockResolvedValue({ repository: "intar-dev/scenarios" });
    mocks.refuse.mockResolvedValue(null);
  });

  it("shows the public card to platform admins only", async () => {
    expect((await GET(context())).status).toBe(200);
    expect(mocks.card).toHaveBeenCalledWith(SCOPE);

    mocks.admin.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "admin required" }, { status: 403 }),
    });
    expect((await GET(context())).status).toBe(403);
    expect((await POST(context({ action: "pause" }))).status).toBe(403);
    expect(mocks.card).toHaveBeenCalledTimes(1);
    expect(mocks.refuse).not.toHaveBeenCalled();
    expect(mocks.change).not.toHaveBeenCalled();
  });

  it("answers the write guard's refusal without changing anything", async () => {
    mocks.refuse.mockResolvedValue(Response.json({ code: "rate_limited" }, { status: 429 }));
    expect((await POST(context({ action: "pause" }))).status).toBe(429);
    mocks.refuse.mockRejectedValue(appError(403, "impersonation_forbidden", "no"));
    expect((await POST(context({ action: "pause" }))).status).toBe(403);
    expect(mocks.refuse).toHaveBeenCalledWith(expect.any(Request), CONTEXT);
    expect(mocks.change).not.toHaveBeenCalled();
  });

  it("applies the change to public for the caller", async () => {
    const response = await POST(context({ action: "pause" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ source: { repository: "intar-dev/scenarios" } });
    expect(mocks.change).toHaveBeenCalledWith({
      scope: SCOPE,
      actorUserId: "operator",
      body: { action: "pause" },
      startedAt: expect.any(Number),
    });
  });
});

function context(body?: unknown): APIContext {
  return {
    request: new Request("https://intar.dev/api/admin/scenario-source", {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }),
  } as unknown as APIContext;
}
