import type { APIContext } from "astro";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  adminContext: vi.fn(),
  resolveOrganizationId: vi.fn(),
  setPolicy: vi.fn(),
}));
vi.mock("@/lib/agent-bridge", () => ({
  requireAdminUserContext: mocks.adminContext,
}));
vi.mock("@/lib/organizations", () => ({
  resolveOrganizationId: mocks.resolveOrganizationId,
}));
vi.mock("@/lib/organization-oidc", () => ({
  setOrganizationOidcPolicy: mocks.setPolicy,
}));
vi.mock("@/lib/request-security", () => ({
  canonicalApplicationOrigin: () => "https://intar.dev",
  NO_STORE_HEADERS: { "cache-control": "no-store" },
}));

import { PUT } from "./sso-policy";

describe("organization SSO sign-up policy route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adminContext.mockResolvedValue({
      ok: true,
      context: { userId: "platform-admin" },
    });
    mocks.resolveOrganizationId.mockResolvedValue("organization");
    mocks.setPolicy.mockResolvedValue({ allowExternalEmailSignups: true });
  });

  it("saves the platform admin's decision", async () => {
    const response = await PUT(context({ allowExternalEmailSignups: true }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      provider: { allowExternalEmailSignups: true },
    });
    expect(mocks.setPolicy).toHaveBeenCalledWith({
      organizationId: "organization",
      actorUserId: "platform-admin",
      allowExternalEmailSignups: true,
      baseUrl: "https://intar.dev",
    });
  });

  it("returns the admin guard's refusal to everyone else", async () => {
    mocks.adminContext.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "admin required" }, { status: 403 }),
    });
    const response = await PUT(context({ allowExternalEmailSignups: true }));
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.setPolicy).not.toHaveBeenCalled();
  });

  it("answers an unknown organization with 404", async () => {
    mocks.resolveOrganizationId.mockResolvedValue(null);
    const response = await PUT(context({ allowExternalEmailSignups: false }));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: "organization_not_found",
    });
  });
});

function context(body: unknown): APIContext {
  return {
    params: { orgId: "organization" },
    request: new Request(
      "https://intar.dev/api/admin/organizations/organization/sso-policy",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  } as unknown as APIContext;
}
