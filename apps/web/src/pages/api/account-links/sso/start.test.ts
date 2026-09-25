import type { APIContext } from "astro";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userContext: vi.fn(),
  role: vi.fn(),
  start: vi.fn(),
}));
vi.mock("@/lib/agent-bridge", () => ({
  requireUserContext: mocks.userContext,
}));
vi.mock("@/lib/access-sso", () => ({
  resolveOrganizationOidcProvider: async () => ({
    providerId: "provider",
    organizationId: "org-team",
    organizationSlug: "team",
  }),
}));
vi.mock("@/lib/organizations", () => ({
  requireOrganizationRole: mocks.role,
}));
vi.mock("@/lib/organization-sso-start", () => ({
  startOrganizationSso: mocks.start,
}));
vi.mock("@/lib/request-security", () => ({
  canonicalApplicationOrigin: () => "https://intar.dev",
  NO_STORE_HEADERS: { "cache-control": "no-store" },
}));

import { POST } from "./start";

describe("organization SSO link start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userContext.mockResolvedValue({
      ok: true,
      context: { userId: "owner" },
    });
    mocks.role.mockResolvedValue("owner");
    mocks.start.mockResolvedValue({
      redirectUrl: "https://id.example.test/authorize",
      headers: new Headers({ "set-cookie": "state=test; HttpOnly" }),
    });
  });

  it("links the signed-in account and returns owners to Settings", async () => {
    const response = await POST(context(true));
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("state=test");
    expect(await response.json()).toEqual({
      redirectUrl: "https://id.example.test/authorize",
    });
    expect(mocks.role).toHaveBeenCalledWith({
      organizationId: "org-team",
      userId: "owner",
    });
    expect(mocks.start).toHaveBeenCalledWith({
      request: expect.any(Request),
      intent: { kind: "link", providerId: "provider", userId: "owner" },
      // Client-supplied URLs are ignored; the canonical origin builds both.
      callbackURL:
        "https://intar.dev/organizations/team?tab=settings&oidcTest=passed",
      errorCallbackURL: "https://intar.dev/organizations/team",
    });
  });

  it.each(["admin", "member"])(
    "rejects tests from %s users before starting OAuth",
    async (role) => {
      mocks.role.mockResolvedValue(role);
      const response = await POST(context(true));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: "organization_owner_required",
      });
      expect(mocks.start).not.toHaveBeenCalled();
    },
  );

  it("connects any signed-in account, with or without GitHub", async () => {
    const response = await POST(context(false));
    expect(response.status).toBe(200);
    expect(mocks.role).not.toHaveBeenCalled();
    expect(mocks.start.mock.calls[0]![0]).toMatchObject({
      intent: { kind: "link", providerId: "provider", userId: "owner" },
      callbackURL: "https://intar.dev/organizations/team",
      errorCallbackURL: "https://intar.dev/organizations/team/sign-in",
    });
  });

  it("returns an inactive session's refusal without starting OAuth", async () => {
    mocks.userContext.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "access revoked", code: "access_revoked" }, { status: 403 }),
    });

    const response = await POST(context(false));

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: "access revoked",
      code: "access_revoked",
    });
    expect(mocks.start).not.toHaveBeenCalled();
  });
});

function context(test: boolean): APIContext {
  return {
    request: new Request("https://intar.dev/api/account-links/sso/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        organizationSlug: "team",
        test,
        callbackURL: "https://untrusted.test",
      }),
    }),
  } as APIContext;
}
