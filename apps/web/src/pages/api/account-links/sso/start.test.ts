import type { APIContext } from "astro";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  role: vi.fn(),
  signIn: vi.fn(),
  handoff: vi.fn(),
}));
vi.mock("@/lib/agent-bridge", () => ({
  requireUserContext: async () => ({ ok: true, context: { userId: "owner" } }),
}));
vi.mock("@/lib/access-claim", () => ({
  getAccessClaimIdentity: async () => ({
    githubAccountId: "github-owner",
    accessState: "active",
  }),
}));
vi.mock("@/lib/access-sso", () => ({
  resolveBetaOidcProvider: async () => ({
    providerId: "provider",
    organizationSlug: "team",
  }),
}));
vi.mock("@/lib/allowlist", () => ({
  getBetaAccess: async () => ({ state: "active", grantedAt: 123 }),
}));
vi.mock("@/lib/organizations", () => ({
  resolveOrganizationId: async () => "org-team",
  requireOrganizationRole: mocks.role,
}));
vi.mock("@/lib/auth", () => ({
  auth: { api: { signInSSO: mocks.signIn } },
  createSsoLinkOAuthHandoff: mocks.handoff,
  INVITE_OAUTH_HANDOFF_HEADER: "x-intar-invite-oauth-handoff",
}));
vi.mock("@/lib/request-security", () => ({
  canonicalApplicationOrigin: () => "https://intar.dev",
  rateLimitPublicAccessInvite: async () => {},
  NO_STORE_HEADERS: { "cache-control": "no-store" },
}));

import { POST } from "./start";

describe("organization owner sign-in test", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(mocks.role).toHaveBeenCalledWith({
      organizationId: "org-team",
      userId: "owner",
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
    expect(args.headers.get("x-intar-invite-oauth-handoff")).toBe(
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
