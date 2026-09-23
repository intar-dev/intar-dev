import type { APIContext } from "astro";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userContext: vi.fn(),
  hasGithub: vi.fn(),
  role: vi.fn(),
  signIn: vi.fn(),
  handoff: vi.fn(),
}));
vi.mock("@/lib/agent-bridge", () => ({
  requireUserContext: mocks.userContext,
}));
vi.mock("@/lib/account-access", () => ({
  hasLinkedProviderAccount: mocks.hasGithub,
}));
vi.mock("@/lib/access-sso", () => ({
  resolveOrganizationOidcProvider: async () => ({
    providerId: "provider",
    organizationSlug: "team",
  }),
}));
vi.mock("@/lib/organizations", () => ({
  resolveOrganizationId: async () => "org-team",
  requireOrganizationRole: mocks.role,
}));
vi.mock("@/lib/auth", () => ({
  auth: { api: { signInSSO: mocks.signIn } },
  createSsoLinkOAuthHandoff: mocks.handoff,
  SSO_LINK_HANDOFF_HEADER: "x-intar-sso-link-handoff",
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
    mocks.hasGithub.mockResolvedValue(true);
    mocks.role.mockResolvedValue("owner");
    mocks.handoff.mockResolvedValue("signed-link-handoff");
    mocks.signIn.mockImplementation(async () =>
      Response.json(
        { redirect: true, url: "https://id.example.test/authorize" },
        { headers: { "set-cookie": "state=test; HttpOnly" } },
      ),
    );
  });

  it("uses the existing secure flow and returns owners to Settings", async () => {
    const response = await POST(context(true));
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("state=test");
    expect(mocks.hasGithub).toHaveBeenCalledWith("owner", "github");
    expect(mocks.role).toHaveBeenCalledWith({
      organizationId: "org-team",
      userId: "owner",
    });
    expect(mocks.handoff).toHaveBeenCalledWith({
      userId: "owner",
      providerId: "provider",
      expiresAt: expect.any(Number),
    });
    const args = mocks.signIn.mock.calls[0]![0];
    expect(args.body).toMatchObject({
      providerId: "provider",
      providerType: "oidc",
      callbackURL:
        "https://intar.dev/organizations/team?tab=settings&oidcTest=passed",
      errorCallbackURL: "https://intar.dev/organizations/team",
      newUserCallbackURL:
        "https://intar.dev/organizations/team?tab=settings&oidcTest=passed",
    });
    expect(args.headers.get("x-intar-sso-link-handoff")).toBe(
      "signed-link-handoff",
    );
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
      expect(mocks.handoff).not.toHaveBeenCalled();
      expect(mocks.signIn).not.toHaveBeenCalled();
    },
  );

  it("preserves normal member sign-in", async () => {
    const response = await POST(context(false));
    expect(response.status).toBe(200);
    expect(mocks.role).not.toHaveBeenCalled();
    expect(mocks.signIn.mock.calls[0]![0].body).toMatchObject({
      callbackURL: "https://intar.dev/organizations/team",
      errorCallbackURL: "https://intar.dev/organizations/team/sign-in",
    });
  });

  it("requires a linked GitHub account before minting a handoff", async () => {
    mocks.hasGithub.mockResolvedValue(false);

    const response = await POST(context(false));

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      code: "active_github_session_required",
    });
    expect(mocks.handoff).not.toHaveBeenCalled();
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it("returns an inactive session's refusal without starting OAuth", async () => {
    mocks.userContext.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "access revoked" }, { status: 403 }),
    });

    const response = await POST(context(false));

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "access revoked" });
    expect(mocks.hasGithub).not.toHaveBeenCalled();
    expect(mocks.handoff).not.toHaveBeenCalled();
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
