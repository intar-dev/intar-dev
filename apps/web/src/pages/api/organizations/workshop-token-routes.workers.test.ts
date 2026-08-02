/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  resolveOrganizationId: vi.fn(),
  featureFlag: vi.fn(),
  listTokens: vi.fn(),
  createToken: vi.fn(),
  revokeToken: vi.fn(),
}));

vi.mock("@/lib/agent-bridge", () => ({
  requireUserContext: mocks.requireUserContext,
  jsonResponse: (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: {
        "content-type": "application/json; charset=utf-8",
        ...Object.fromEntries(new Headers(init?.headers)),
      },
    }),
}));
vi.mock("@/lib/organizations", () => ({
  resolveOrganizationId: mocks.resolveOrganizationId,
}));
vi.mock("@/lib/workshops/feature-flag", () => ({
  requireWorkshopsEnabledForOrganization: mocks.featureFlag,
}));
vi.mock("@/lib/workshops/registry-tokens", () => ({
  listWorkshopRegistryTokens: mocks.listTokens,
  createWorkshopRegistryToken: mocks.createToken,
  revokeWorkshopRegistryToken: mocks.revokeToken,
}));

import {
  GET,
  POST,
} from "./[orgId]/workshops/tokens/index";
import { DELETE } from "./[orgId]/workshops/tokens/[tokenId]";

const EXPECTED_SECURITY_HEADERS = {
  "cache-control": "private, no-store",
  "cloudflare-cdn-cache-control": "no-store",
  "referrer-policy": "no-referrer",
};

describe("workshop registry token routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUserContext.mockResolvedValue({
      ok: true as const,
      context: { userId: "owner-a" },
    });
    mocks.resolveOrganizationId.mockResolvedValue("organization-a");
    mocks.featureFlag.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists token metadata as private data for the resolved organization owner", async () => {
    const tokens = [
      {
        id: "token-a",
        name: "Workshop publisher",
        tokenPrefix: "intar_ws_1234567890",
        lastUsedAt: null,
        expiresAt: 1_900_000_000_000,
        revokedAt: null,
        createdAt: 1_800_000_000_000,
      },
    ];
    mocks.listTokens.mockResolvedValue(tokens);

    const response = await GET({
      request: new Request(
        "https://intar.dev/api/organizations/org-slug/workshops/tokens",
      ),
      params: { orgId: "org-slug" },
    } as never);

    expect(response.status).toBe(200);
    expectSecurityHeaders(response);
    await expect(response.json()).resolves.toEqual({ tokens });
    expect(mocks.resolveOrganizationId).toHaveBeenCalledWith("org-slug");
    expect(mocks.featureFlag).toHaveBeenCalledWith("organization-a");
    expect(mocks.listTokens).toHaveBeenCalledWith({
      organizationId: "organization-a",
      actorUserId: "owner-a",
    });
  });

  it("creates a one-time token with the resolved organization and owner", async () => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const token = {
      id: "token-a",
      name: "CI publisher",
      tokenPrefix: "intar_ws_1234567890",
      token: "intar_ws_single-use-secret",
      lastUsedAt: null,
      expiresAt: 1_900_000_000_000,
      revokedAt: null,
      createdAt: 1_800_000_000_000,
    };
    mocks.createToken.mockResolvedValue(token);

    const response = await POST({
      request: new Request(
        "https://intar.dev/api/organizations/org-slug/workshops/tokens",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "CI publisher",
            expiresAfterMinutes: 30,
          }),
        },
      ),
      params: { orgId: "org-slug" },
    } as never);

    expect(response.status).toBe(201);
    expectSecurityHeaders(response);
    await expect(response.json()).resolves.toEqual(token);
    expect(mocks.createToken).toHaveBeenCalledWith({
      organizationId: "organization-a",
      actorUserId: "owner-a",
      name: "CI publisher",
      expiresAt: now + 30 * 60_000,
    });
  });

  it("strictly rejects malformed JSON without creating a token", async () => {
    const response = await POST({
      request: new Request(
        "https://intar.dev/api/organizations/org-slug/workshops/tokens",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"name":',
        },
      ),
      params: { orgId: "org-slug" },
    } as never);

    expect(response.status).toBe(400);
    expectSecurityHeaders(response);
    expect(mocks.createToken).not.toHaveBeenCalled();
  });

  it("strictly rejects a non-numeric duration without creating a token", async () => {
    const response = await POST({
      request: new Request(
        "https://intar.dev/api/organizations/org-slug/workshops/tokens",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "CI publisher",
            expiresAfterMinutes: "30",
          }),
        },
      ),
      params: { orgId: "org-slug" },
    } as never);

    expect(response.status).toBe(400);
    expectSecurityHeaders(response);
    expect(mocks.createToken).not.toHaveBeenCalled();
  });

  it("rejects client-derived absolute expiries", async () => {
    const response = await POST({
      request: new Request(
        "https://intar.dev/api/organizations/org-slug/workshops/tokens",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "CI publisher",
            expiresAt: 1_900_000_000_000,
          }),
        },
      ),
      params: { orgId: "org-slug" },
    } as never);

    expect(response.status).toBe(400);
    expectSecurityHeaders(response);
    expect(mocks.createToken).not.toHaveBeenCalled();
  });

  it("revokes the resolved organization's token without returning a body", async () => {
    mocks.revokeToken.mockResolvedValue(undefined);

    const response = await DELETE({
      request: new Request(
        "https://intar.dev/api/organizations/org-slug/workshops/tokens/token-slug",
        { method: "DELETE" },
      ),
      params: { orgId: "org-slug", tokenId: "token-slug" },
    } as never);

    expect(response.status).toBe(204);
    expectSecurityHeaders(response);
    await expect(response.text()).resolves.toBe("");
    expect(mocks.resolveOrganizationId).toHaveBeenCalledWith("org-slug");
    expect(mocks.featureFlag).toHaveBeenCalledWith("organization-a");
    expect(mocks.revokeToken).toHaveBeenCalledWith({
      organizationId: "organization-a",
      actorUserId: "owner-a",
      tokenId: "token-slug",
    });
  });
});

function expectSecurityHeaders(response: Response): void {
  for (const [name, value] of Object.entries(EXPECTED_SECURITY_HEADERS)) {
    expect(response.headers.get(name)).toBe(value);
  }
}
