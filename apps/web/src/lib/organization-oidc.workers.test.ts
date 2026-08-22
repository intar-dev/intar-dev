/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { organization, ssoProvider, user } from "@/db/schema/core";
import { resetD1Database } from "@/test/d1-migrations";

const sso = vi.hoisted(() => ({ discoverOIDCConfig: vi.fn() }));

vi.mock("@better-auth/sso", () => sso);

import { registerOrganizationOidc } from "./organization-oidc";

const ACTOR_ID = "oidc-organization-admin";
const ORGANIZATION_ID = "oidc-organization";

describe("organization OIDC secret registration", () => {
  beforeEach(async () => {
    await resetD1Database();
    sso.discoverOIDCConfig.mockReset();
    sso.discoverOIDCConfig.mockResolvedValue(discovery());
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

  it("stores a bound ciphertext without plaintext or returned secret material", async () => {
    const clientSecret = "registration-secret";
    const result = await registerOrganizationOidc({
      organizationId: ORGANIZATION_ID,
      actorUserId: ACTOR_ID,
      issuer: "https://login.example.test",
      domain: "example.test",
      clientId: "client-id",
      clientSecret,
      baseUrl: "https://intar.dev",
    });
    const row = await drizzle(env.DB)
      .select()
      .from(ssoProvider)
      .limit(1)
      .then((rows) => rows[0]);

    expect(row?.oidcClientSecretCiphertext).toMatch(
      /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u,
    );
    expect(JSON.parse(row?.oidcConfig ?? "{}")).not.toHaveProperty(
      "clientSecret",
    );
    expect(row?.oidcConfig).not.toContain(clientSecret);
    expect(JSON.stringify(result)).not.toContain(clientSecret);
    expect(JSON.stringify(result)).not.toContain(
      row?.oidcClientSecretCiphertext ?? "",
    );
  });

  it("uses one fixed public discovery failure and one structured log event", async () => {
    const upstreamDetail = "https://private.idp.example.test returned 503";
    sso.discoverOIDCConfig.mockRejectedValue(new Error(upstreamDetail));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const failure = await registerOrganizationOidc({
      organizationId: ORGANIZATION_ID,
      actorUserId: ACTOR_ID,
      issuer: "https://login.example.test",
      domain: "example.test",
      clientId: "client-id",
      clientSecret: "client-secret",
      baseUrl: "https://intar.dev",
    }).catch((error: unknown) => error);

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

  it("rejects a client secret over 4 KiB of UTF-8 input before discovery", async () => {
    await expect(
      registerOrganizationOidc({
        organizationId: ORGANIZATION_ID,
        actorUserId: ACTOR_ID,
        issuer: "https://login.example.test",
        domain: "example.test",
        clientId: "client-id",
        clientSecret: "😀".repeat(1025),
        baseUrl: "https://intar.dev",
      }),
    ).rejects.toMatchObject({ code: "invalid_oidc_client_secret" });
    expect(sso.discoverOIDCConfig).not.toHaveBeenCalled();
  });
});

function discovery() {
  return {
    issuer: "https://login.example.test",
    discoveryEndpoint:
      "https://login.example.test/.well-known/openid-configuration",
    authorizationEndpoint: "https://login.example.test/oauth/authorize",
    tokenEndpoint: "https://login.example.test/oauth/token",
    tokenEndpointAuthentication: "client_secret_basic",
    jwksEndpoint: "https://login.example.test/.well-known/jwks.json",
    userInfoEndpoint: "https://login.example.test/oauth/userinfo",
  };
}
