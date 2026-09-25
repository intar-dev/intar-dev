import type { APIContext } from "astro";
import { beforeEach, describe, expect, it, vi } from "vitest";

const register = vi.hoisted(() => vi.fn());

vi.mock("@/lib/agent-bridge", () => ({
  requireUserContext: async () => ({ ok: true, context: { userId: "admin" } }),
  jsonResponse: (body: unknown, init?: ResponseInit) =>
    Response.json(body, init),
}));
// The callback URL shown to admins comes from BETTER_AUTH_URL, which is the
// base Better Auth uses for the redirect_uri, not from the request host.
vi.mock("@/lib/request-security", () => ({
  canonicalApplicationOrigin: () => "https://intar.dev",
}));
vi.mock("@/lib/organizations", () => ({
  resolveOrganizationId: async () => "organization",
  requireOrganizationRole: async () => {},
}));
vi.mock("@/lib/organization-oidc", () => ({
  registerOrganizationOidc: register,
  getOrganizationOidc: vi.fn(),
  deleteOrganizationOidc: vi.fn(),
}));

import { POST } from "./index";

describe("public OIDC registration route", () => {
  beforeEach(() => {
    register.mockReset().mockResolvedValue({ providerId: "public-provider" });
  });

  it("accepts registration without a secret", async () => {
    const response = await POST(context());
    expect(response.status).toBe(201);
    expect(register).toHaveBeenCalledWith({
      organizationId: "organization",
      actorUserId: "admin",
      issuer: "https://login.example.test",
      domain: "example.test",
      clientId: "public-client",
      baseUrl: "https://intar.dev",
    });
  });

  it.each(["secret", "", 42])(
    "rejects a supplied secret: %j",
    async (secret) => {
      const response = await POST(context({ clientSecret: secret }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "oidc_client_secret_not_allowed",
      });
      expect(register).not.toHaveBeenCalled();
    },
  );
});

function context(extra: Record<string, unknown> = {}): APIContext {
  return {
    params: { orgId: "organization" },
    request: new Request(
      "https://intar.dev/api/organizations/organization/sso",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          issuer: "https://login.example.test",
          domain: "example.test",
          clientId: "public-client",
          ...extra,
        }),
      },
    ),
  } as unknown as APIContext;
}
