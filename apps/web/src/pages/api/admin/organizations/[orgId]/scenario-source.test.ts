import type { APIContext } from "astro";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appError } from "@/lib/app-error";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  card: vi.fn(),
  change: vi.fn(),
  refuse: vi.fn(),
  resolve: vi.fn(),
}));
const CONTEXT = { userId: "operator", impersonated: false };
const SCOPE = { key: "organization:org-a", organizationId: "org-a" };

vi.mock("@/lib/agent-bridge", () => ({
  requireAdminUserContext: mocks.admin,
  jsonResponse: (body: unknown, init?: ResponseInit) => Response.json(body, init),
}));
vi.mock("@/lib/organizations", () => ({ resolveOrganizationId: mocks.resolve }));
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

describe("an organization's scenario source, for a platform administrator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.admin.mockResolvedValue({ ok: true, context: CONTEXT });
    mocks.resolve.mockResolvedValue("org-a");
    mocks.card.mockResolvedValue({ enabled: true, appSlug: null, source: null });
    mocks.change.mockResolvedValue({ repository: "acme/labs" });
    mocks.refuse.mockResolvedValue(null);
  });

  it("is a platform administrator's alone, before the organization is even looked up", async () => {
    mocks.admin.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "admin required" }, { status: 403 }),
    });
    expect((await GET(context())).status).toBe(403);
    expect((await POST(context({ action: "pause" }))).status).toBe(403);
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.change).not.toHaveBeenCalled();
  });

  it("answers 404 for an organization that is not there", async () => {
    mocks.resolve.mockResolvedValue(null);
    expect((await GET(context())).status).toBe(404);
    expect((await POST(context({ action: "pause" }))).status).toBe(404);
    expect(mocks.change).not.toHaveBeenCalled();
  });

  it("shows the organization's card", async () => {
    expect((await GET(context())).status).toBe(200);
    expect(mocks.resolve).toHaveBeenCalledWith("acme");
    expect(mocks.card).toHaveBeenCalledWith(SCOPE);
  });

  it("applies a change as the platform's step back, behind the write guard", async () => {
    const response = await POST(context({ action: "promotion", promotion: "manual" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ source: { repository: "acme/labs" } });
    expect(mocks.refuse).toHaveBeenCalledWith(expect.any(Request), CONTEXT);
    expect(mocks.change).toHaveBeenCalledWith({
      scope: SCOPE,
      actorUserId: "operator",
      body: { action: "promotion", promotion: "manual" },
      startedAt: expect.any(Number),
      asPlatform: true,
    });

    mocks.refuse.mockRejectedValue(appError(403, "impersonation_forbidden", "no"));
    expect((await POST(context({ action: "pause" }))).status).toBe(403);
    expect(mocks.change).toHaveBeenCalledTimes(1);
  });
});

function context(body?: unknown): APIContext {
  return {
    params: { orgId: "acme" },
    request: new Request("https://intar.dev/api/admin/organizations/acme/scenario-source", {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }),
  } as unknown as APIContext;
}
