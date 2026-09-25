import type {
  DBAdapter,
  DBTransactionAdapter,
} from "@better-auth/core/db/adapter";
import { describe, expect, it, vi } from "vitest";
import {
  decorateOidcSsoAdapter,
  OidcSsoProviderConfigurationError,
  OidcSsoProviderWriteDisabledError,
} from "./oidc-sso-adapter";

const identity = {
  id: "provider-row-a",
  providerId: "provider-a",
  organizationId: "organization-a",
} as const;
describe("OIDC SSO Better Auth adapter decorator", () => {
  it("checks ID tokens against the issuer discovery advertised", async () => {
    // Rows registered before the fix kept the typed issuer; the plugin compares
    // the ID token's iss with the row's issuer exactly.
    const row = providerRow();
    row.oidcConfig = JSON.stringify({
      ...JSON.parse(String(row.oidcConfig)),
      issuer: "https://login.example.test/",
    });
    const base = fakeAdapter(row);
    const adapter = decorateOidcSsoAdapter(base.adapter);

    const found = await adapter.findOne({
      model: "ssoProvider",
      where: [{ field: "providerId", value: identity.providerId }],
    });
    const locked = await adapter.update({
      model: "ssoProvider",
      where: [{ field: "providerId", value: identity.providerId }],
      update: { providerId: identity.providerId },
    });
    for (const result of [found, locked]) {
      expect(result).toMatchObject({ issuer: "https://login.example.test/" });
    }

    // Without a discovered issuer the stored value stays.
    const legacy = decorateOidcSsoAdapter(fakeAdapter(providerRow()).adapter);
    await expect(
      legacy.findOne({
        model: "ssoProvider",
        where: [{ field: "providerId", value: identity.providerId }],
      }),
    ).resolves.toMatchObject({ issuer: "https://login.example.test" });
  });

  it.each([undefined, false, true])(
    "enforces PKCE on public providers across result paths: %s",
    async (pkce) => {
      const row = providerRow();
      row.oidcConfig = JSON.stringify({
        ...JSON.parse(String(row.oidcConfig)),
        clientId: "client-a",
        tokenEndpointAuthentication: "none",
        pkce,
        userInfoEndpoint: "https://login.example.test/oauth/userinfo",
      });
      const base = fakeAdapter(row);
      const adapter = decorateOidcSsoAdapter(base.adapter);

      const one = await adapter.findOne({
        model: "ssoProvider",
        where: [{ field: "providerId", value: identity.providerId }],
      });
      const many = await adapter.findMany({ model: "ssoProvider" });
      const locked = await adapter.update({
        model: "ssoProvider",
        where: [{ field: "providerId", value: identity.providerId }],
        update: { providerId: identity.providerId },
      });
      const fromTransaction = await adapter.transaction(async (transaction) =>
        transaction.findOne({
          model: "ssoProvider",
          where: [{ field: "providerId", value: identity.providerId }],
        }),
      );

      for (const result of [one, many[0], locked, fromTransaction]) {
        expect(result).toBeTruthy();
        expect(result).not.toHaveProperty("oidcClientSecretCiphertext");
        expect(
          JSON.parse((result as { oidcConfig: string }).oidcConfig),
        ).toMatchObject({
          tokenEndpointAuthentication: "none",
          pkce: true,
        });
        expect(
          JSON.parse((result as { oidcConfig: string }).oidcConfig),
        ).not.toHaveProperty("userInfoEndpoint");
      }
      expect(JSON.parse(String(row.oidcConfig)).pkce).toBe(pkce);
      expect(base.update).toHaveBeenCalledOnce();

      const unrelated = await adapter.findOne({
        model: "user",
        where: [{ field: "id", value: "unrelated" }],
      });
      expect(unrelated).toBe(row);
    },
  );

  it.each([
    { tokenEndpointAuthentication: "client_secret_basic" },
    { tokenEndpointAuthentication: "client_secret_post" },
    { tokenEndpointAuthentication: "private_key_jwt" },
    { tokenEndpointAuthentication: undefined },
    { tokenEndpointAuthentication: "none", clientSecret: "legacy-secret" },
    { jwksEndpoint: undefined },
  ])("rejects secret-based or ambiguous configurations: %j", async (config) => {
    const row = providerRow();
    row.oidcConfig = JSON.stringify({
      ...JSON.parse(String(row.oidcConfig)),
      ...config,
    });
    const adapter = decorateOidcSsoAdapter(fakeAdapter(row).adapter);
    await expect(
      adapter.findOne({ model: "ssoProvider", where: [] }),
    ).rejects.toBeInstanceOf(OidcSsoProviderConfigurationError);
  });

  it("rejects a public provider with a stored encrypted secret", async () => {
    const row = providerRow({ ciphertext: "legacy-ciphertext" });
    const adapter = decorateOidcSsoAdapter(fakeAdapter(row).adapter);
    await expect(
      adapter.findOne({ model: "ssoProvider", where: [] }),
    ).rejects.toBeInstanceOf(OidcSsoProviderConfigurationError);
  });

  it("rejects plaintext fallback and all non-lock SSO writes", async () => {
    const legacySecret = "legacy-secret";
    const row = providerRow({ clientSecret: legacySecret });
    const base = fakeAdapter(row);
    const adapter = decorateOidcSsoAdapter(base.adapter);

    const unavailable = await adapter
      .findOne({
        model: "ssoProvider",
        where: [{ field: "providerId", value: identity.providerId }],
      })
      .catch((failure: unknown) => failure);
    expect(unavailable).toBeInstanceOf(OidcSsoProviderConfigurationError);
    expect(String(unavailable)).not.toContain(legacySecret);

    await expect(
      adapter.update({
        model: "ssoProvider",
        where: [{ field: "providerId", value: identity.providerId }],
        update: { oidcConfig: JSON.stringify({ clientSecret: "replacement" }) },
      }),
    ).rejects.toBeInstanceOf(OidcSsoProviderWriteDisabledError);
    await expect(
      adapter.delete({
        model: "ssoProvider",
        where: [{ field: "providerId", value: identity.providerId }],
      }),
    ).rejects.toBeInstanceOf(OidcSsoProviderWriteDisabledError);
  });
});

function providerRow(
  input: {
    ciphertext?: string;
    clientSecret?: string;
  } = {},
): Record<string, unknown> {
  return {
    ...identity,
    domain: "example.test",
    issuer: "https://login.example.test",
    oidcConfig: JSON.stringify({
      clientId: "client-a",
      tokenEndpointAuthentication: "none",
      authorizationEndpoint: "https://login.example.test/oauth/authorize",
      tokenEndpoint: "https://login.example.test/oauth/token",
      jwksEndpoint: "https://login.example.test/.well-known/jwks.json",
      ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
    }),
    ...(input.ciphertext
      ? { oidcClientSecretCiphertext: input.ciphertext }
      : {}),
  };
}

function fakeAdapter(row: Record<string, unknown>): {
  adapter: DBAdapter;
  update: ReturnType<typeof vi.fn>;
} {
  const update = vi.fn(async () => row);
  const adapter = {
    id: "test-adapter",
    create: async () => row,
    findOne: async () => row,
    findMany: async () => [row],
    count: async () => 0,
    update,
    updateMany: async () => 0,
    delete: async () => undefined,
    deleteMany: async () => 0,
    consumeOne: async () => row,
    incrementOne: async () => row,
    transaction: async <Result,>(
      callback: (transaction: DBTransactionAdapter) => Promise<Result>,
    ): Promise<Result> => callback(adapter as unknown as DBTransactionAdapter),
  };
  return { adapter: adapter as unknown as DBAdapter, update };
}
