import type { APIContext } from "astro";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appError } from "@/lib/app-error";

const mocks = vi.hoisted(() => ({
  role: vi.fn(),
  card: vi.fn(),
  change: vi.fn(),
  refuse: vi.fn(),
}));
const CONTEXT = { userId: "owner", impersonated: false };

vi.mock("@/lib/agent-bridge", () => ({
  requireUserContext: async () => ({ ok: true, context: CONTEXT }),
  jsonResponse: (body: unknown, init?: ResponseInit) =>
    Response.json(body, init),
}));
vi.mock("@/lib/organizations", () => ({
  resolveOrganizationId: async (key: string) => (key === "org" ? "org" : null),
  requireOrganizationRole: mocks.role,
  isOrganizationAdminRole: (role: string) => role !== "member",
}));
vi.mock("@/lib/scenario-sources", () => ({
  scenarioSourceScope: (id: string) => ({ key: `organization:${id}`, organizationId: id }),
  scenarioSourceCard: mocks.card,
  changeScenarioSource: mocks.change,
  refuseScenarioSourceWrite: mocks.refuse,
}));

import { GET, POST } from "./scenario-source";

const SCOPE = { key: "organization:org", organizationId: "org" };

describe("organization scenario source route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.role.mockResolvedValue("owner");
    mocks.card.mockResolvedValue({ enabled: false, appSlug: null, source: null });
    mocks.change.mockResolvedValue({ repository: "acme/labs" });
    mocks.refuse.mockResolvedValue(null);
  });

  it("shows the card to owners and admins only", async () => {
    const owner = await GET(context());
    expect(owner.status).toBe(200);
    expect(await owner.json()).toEqual({ enabled: false, appSlug: null, source: null });
    expect(mocks.card).toHaveBeenCalledWith(SCOPE);

    mocks.role.mockResolvedValue("member");
    const member = await GET(context());
    expect(member.status).toBe(404);
    mocks.role.mockRejectedValue(appError(404, "organization_not_found", "organization not found"));
    expect((await GET(context())).status).toBe(404);
    expect((await GET(context("POST", {}, "missing"))).status).toBe(404);
    expect(mocks.card).toHaveBeenCalledTimes(1);
  });

  it("refuses member writes before any change", async () => {
    mocks.role.mockResolvedValue("member");
    expect((await POST(context("POST", { action: "pause" }))).status).toBe(404);
    expect(mocks.refuse).not.toHaveBeenCalled();
    expect(mocks.change).not.toHaveBeenCalled();
  });

  it("answers the write guard's refusal without changing anything", async () => {
    mocks.refuse.mockResolvedValue(Response.json({ code: "rate_limited" }, { status: 429 }));
    expect((await POST(context("POST", { action: "pause" }))).status).toBe(429);
    mocks.refuse.mockRejectedValue(appError(403, "impersonation_forbidden", "no"));
    expect((await POST(context("POST", { action: "pause" }))).status).toBe(403);
    expect(mocks.refuse).toHaveBeenCalledWith(expect.any(Request), CONTEXT);
    expect(mocks.change).not.toHaveBeenCalled();
  });

  it("applies the change for the caller from the request's start", async () => {
    const before = Date.now();
    const response = await POST(context("POST", { action: "connect", repository: "acme/labs" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ source: { repository: "acme/labs" } });
    expect(mocks.change).toHaveBeenCalledWith({
      scope: SCOPE,
      actorUserId: "owner",
      body: { action: "connect", repository: "acme/labs" },
      startedAt: expect.any(Number),
    });
    expect(mocks.change.mock.calls[0]?.[0].startedAt).toBeGreaterThanOrEqual(before);
  });
});

function context(method = "GET", body?: unknown, orgId = "org"): APIContext {
  return {
    params: { orgId },
    request: new Request(`https://intar.dev/api/organizations/${orgId}/scenario-source`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }),
  } as unknown as APIContext;
}
