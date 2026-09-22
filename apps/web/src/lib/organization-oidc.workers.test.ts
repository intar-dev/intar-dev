/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { organization, ssoProvider, user } from "@/db/schema/core";
import { resetD1Database } from "@/test/d1-migrations";

import { registerOrganizationOidc } from "./organization-oidc";

const ACTOR_ID = "oidc-organization-admin";
const ORGANIZATION_ID = "oidc-organization";

describe("organization OIDC public client registration", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    await resetD1Database();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(discovery()));
    const db = drizzle(env.DB);
    const now = new Date();
    await db.insert(user).values({
      id: ACTOR_ID,
      name: "OIDC organization admin",
      email: "oidc-organization-admin@example.test",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(organization).values({
      id: ORGANIZATION_ID,
      name: "OIDC organization",
      slug: "oidc-organization",
      createdAt: now,
    });
  });

  it("registers only a public client with PKCE and no secret material", async () => {
    const result = await registerOrganizationOidc(registration());
    const [row] = await drizzle(env.DB).select().from(ssoProvider);
    expect(row?.oidcClientSecretCiphertext).toBeNull();
    expect(JSON.parse(row?.oidcConfig ?? "{}")).toMatchObject({
      tokenEndpointAuthentication: "none",
      pkce: true,
      clientId: "client-id",
    });
    expect(JSON.parse(row?.oidcConfig ?? "{}")).not.toHaveProperty(
      "clientSecret",
    );
    expect(result.pkce).toBe(true);
  });

  it.each([
    { code_challenge_methods_supported: undefined },
    { code_challenge_methods_supported: ["plain"] },
    { code_challenge_methods_supported: "S256" },
    { response_types_supported: ["token", "id_token", "code id_token"] },
  ])("rejects unsupported authorization flow %j", async (metadata) => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ ...discovery(), ...metadata }),
    );
    await expect(
      registerOrganizationOidc(registration()),
    ).rejects.toMatchObject({
      code: "unsupported_oidc_authorization_flow",
    });
    expect(await drizzle(env.DB).select().from(ssoProvider)).toEqual([]);
  });

  it.each([
    undefined,
    ["client_secret_basic"],
    ["client_secret_post"],
    ["private_key_jwt"],
    "none",
  ])(
    "rejects token authentication without explicit public client support: %j",
    async (methods) => {
      vi.mocked(fetch).mockResolvedValue(
        Response.json({
          ...discovery(),
          token_endpoint_auth_methods_supported: methods,
        }),
      );
      await expect(
        registerOrganizationOidc(registration()),
      ).rejects.toMatchObject({
        code: "unsupported_oidc_token_authentication",
      });
      expect(await drizzle(env.DB).select().from(ssoProvider)).toEqual([]);
    },
  );

  it("uses one fixed public discovery failure and one structured log event", async () => {
    const upstreamDetail = "https://private.idp.example.test returned 503";
    vi.mocked(fetch).mockRejectedValue(new Error(upstreamDetail));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const failure = await registerOrganizationOidc(registration()).catch(
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({
      status: 400,
      code: "oidc_discovery_failed",
      message: "OIDC discovery failed",
    });
    expect(String(failure)).not.toContain(upstreamDetail);
    expect(warning).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(
      JSON.stringify({ event: "oidc_discovery_failed" }),
    );
  });
});

function registration() {
  return {
    organizationId: ORGANIZATION_ID,
    actorUserId: ACTOR_ID,
    issuer: "https://login.example.test",
    domain: "example.test",
    clientId: "client-id",
    baseUrl: "https://intar.dev",
  };
}

function discovery() {
  return {
    issuer: "https://login.example.test",
    authorization_endpoint: "https://login.example.test/oauth/authorize",
    token_endpoint: "https://login.example.test/oauth/token",
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
    code_challenge_methods_supported: ["S256"],
    response_types_supported: ["code"],
    jwks_uri: "https://login.example.test/.well-known/jwks.json",
    userinfo_endpoint: "https://login.example.test/oauth/userinfo",
  };
}
