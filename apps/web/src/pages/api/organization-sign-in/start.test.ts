import type { APIContext } from "astro";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userContext: vi.fn(),
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
vi.mock("@/lib/organization-sso-start", () => ({
  startOrganizationSso: mocks.start,
}));
vi.mock("@/lib/request-security", () => ({
  canonicalApplicationOrigin: () => "https://intar.dev",
  NO_STORE_HEADERS: { "cache-control": "no-store" },
}));

import { POST } from "./start";

describe("organization sign-in start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userContext.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "unauthorized", code: "signed_out" }, { status: 401 }),
    });
    mocks.start.mockResolvedValue({
      redirectUrl: "https://id.example.test/authorize",
      headers: new Headers({ "set-cookie": "state=test; HttpOnly" }),
    });
  });

  it("starts a sign-in intent for a signed-out visitor", async () => {
    const response = await POST(context());
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("state=test");
    expect(await response.json()).toEqual({
      redirectUrl: "https://id.example.test/authorize",
    });
    expect(mocks.start).toHaveBeenCalledWith({
      request: expect.any(Request),
      intent: { kind: "sign-in", providerId: "provider" },
      callbackURL: "https://intar.dev/organizations/team",
      errorCallbackURL: "https://intar.dev/organizations/team/sign-in",
    });
  });

  it("sends a signed-in account to the connect flow", async () => {
    mocks.userContext.mockResolvedValue({
      ok: true,
      context: { userId: "member" },
    });
    const response = await POST(context());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "already_signed_in" });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("keeps a revoked session's refusal instead of signing in", async () => {
    mocks.userContext.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "access revoked", code: "access_revoked" }, { status: 403 }),
    });
    const response = await POST(context());
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: "access revoked",
      code: "access_revoked",
    });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("requires an organization slug", async () => {
    const response = await POST(
      context(JSON.stringify({ organizationSlug: 42 })),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "organization_slug_required",
    });
    expect(mocks.start).not.toHaveBeenCalled();
  });
});

function context(
  body = JSON.stringify({ organizationSlug: "team" }),
): APIContext {
  return {
    request: new Request("https://intar.dev/api/organization-sign-in/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  } as APIContext;
}
