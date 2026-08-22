import type {
  DBAdapter,
  DBTransactionAdapter,
} from "@better-auth/core/db/adapter";
import { describe, expect, it, vi } from "vitest";
import {
  decryptOidcClientSecret,
  encryptOidcClientSecret,
  isOidcClientSecretLengthValid,
  OidcSsoSecretError,
} from "./oidc-sso-secret";
import {
  decorateOidcSsoSecretAdapter,
  OidcSsoProviderSecretUnavailableError,
  OidcSsoProviderWriteDisabledError,
} from "./oidc-sso-secret-adapter";

const identity = {
  id: "provider-row-a",
  providerId: "provider-a",
  organizationId: "organization-a",
} as const;
const URL_SAFE_KEY = base64Url(
  Uint8Array.from({ length: 32 }, (_, index) => (index % 2 ? 255 : 0)),
);

describe("OIDC SSO client-secret envelope", () => {
  it("uses canonical base64url key and envelope data", async () => {
    expect(URL_SAFE_KEY).toMatch(/[_-]/u);
    const ciphertext = await encryptOidcClientSecret({
      encryptionKey: URL_SAFE_KEY,
      clientSecret: "url-safe-secret",
      identity,
    });

    expect(ciphertext).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    await expect(
      decryptOidcClientSecret({
        encryptionKey: URL_SAFE_KEY,
        ciphertext,
        identity,
      }),
    ).resolves.toBe("url-safe-secret");

    // An underscore IV must pass envelope parsing before authentication fails.
    await expect(
      decryptOidcClientSecret({
        encryptionKey: URL_SAFE_KEY,
        ciphertext: "v1.________________.AAAAAAAAAAAAAAAAAAAAAA",
        identity,
      }),
    ).rejects.toMatchObject({ code: "oidc_sso_secret_decryption_failed" });
  });

  it("binds ciphertext to its exact row, provider, and organization", async () => {
    const clientSecret = "bound-client-secret";
    const ciphertext = await encryptOidcClientSecret({
      encryptionKey: URL_SAFE_KEY,
      clientSecret,
      identity,
    });

    await expect(
      decryptOidcClientSecret({
        encryptionKey: URL_SAFE_KEY,
        ciphertext,
        identity: { ...identity, id: "provider-row-b" },
      }),
    ).rejects.toMatchObject({ code: "oidc_sso_secret_decryption_failed" });
    await expect(
      decryptOidcClientSecret({
        encryptionKey: URL_SAFE_KEY,
        ciphertext,
        identity: { ...identity, providerId: "provider-b" },
      }),
    ).rejects.toMatchObject({ code: "oidc_sso_secret_decryption_failed" });
    await expect(
      decryptOidcClientSecret({
        encryptionKey: URL_SAFE_KEY,
        ciphertext,
        identity: { ...identity, organizationId: "organization-b" },
      }),
    ).rejects.toMatchObject({ code: "oidc_sso_secret_decryption_failed" });
  });

  it("fails closed without leaking malformed data, secrets, or key material", async () => {
    const secret = "secret-that-must-not-leak";
    const ciphertext = await encryptOidcClientSecret({
      encryptionKey: URL_SAFE_KEY,
      clientSecret: secret,
      identity,
    });
    const tampered = `${ciphertext.slice(0, -1)}${ciphertext.endsWith("A") ? "B" : "A"}`;

    for (const candidate of [tampered, "v1.not+base64.ciphertext", "v2.a.b"]) {
      const error = await decryptOidcClientSecret({
        encryptionKey: URL_SAFE_KEY,
        ciphertext: candidate,
        identity,
      }).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(OidcSsoSecretError);
      expect(String(error)).not.toContain(secret);
      expect(String(error)).not.toContain(candidate);
      expect(String(error)).not.toContain(URL_SAFE_KEY);
    }

    await expect(
      decryptOidcClientSecret({
        encryptionKey: undefined,
        ciphertext,
        identity,
      }),
    ).rejects.toMatchObject({ code: "oidc_sso_secret_key_invalid" });
    await expect(
      decryptOidcClientSecret({
        encryptionKey: "not-a-32-byte-key",
        ciphertext,
        identity,
      }),
    ).rejects.toMatchObject({ code: "oidc_sso_secret_key_invalid" });
    await expect(
      decryptOidcClientSecret({
        encryptionKey: URL_SAFE_KEY,
        ciphertext: `v1.${"A".repeat(8190)}.A`,
        identity,
      }),
    ).rejects.toMatchObject({ code: "oidc_sso_secret_envelope_invalid" });
  });

  it("enforces the UTF-8 client-secret bound", async () => {
    const tooLongSecret = "😀".repeat(1025);
    expect(isOidcClientSecretLengthValid(tooLongSecret)).toBe(false);
    await expect(
      encryptOidcClientSecret({
        encryptionKey: URL_SAFE_KEY,
        clientSecret: tooLongSecret,
        identity,
      }),
    ).rejects.toMatchObject({ code: "oidc_sso_secret_envelope_invalid" });
  });
});

describe("OIDC SSO Better Auth adapter decorator", () => {
  it("injects ciphertext secrets in memory and strips ciphertext from every result path", async () => {
    const clientSecret = "adapter-secret";
    const ciphertext = await encryptOidcClientSecret({
      encryptionKey: URL_SAFE_KEY,
      clientSecret,
      identity,
    });
    const row = providerRow({ ciphertext });
    const base = fakeAdapter(row);
    const adapter = decorateOidcSsoSecretAdapter(base.adapter, () => ({
      encryptionKey: URL_SAFE_KEY,
    }));

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
      expect(JSON.stringify(result)).not.toContain(ciphertext);
      expect(result).not.toHaveProperty("oidcClientSecretCiphertext");
      expect(JSON.parse((result as { oidcConfig: string }).oidcConfig)).toMatchObject({
        clientSecret,
      });
    }
    expect(row.oidcClientSecretCiphertext).toBe(ciphertext);
    expect(base.update).toHaveBeenCalledOnce();

    const unrelated = await adapter.findOne({
      model: "user",
      where: [{ field: "id", value: "unrelated" }],
    });
    expect(unrelated).toBe(row);
  });

  it("rejects plaintext fallback and all non-lock SSO writes", async () => {
    const legacySecret = "legacy-secret";
    const row = providerRow({ clientSecret: legacySecret });
    const base = fakeAdapter(row);
    const adapter = decorateOidcSsoSecretAdapter(base.adapter, () => ({
      encryptionKey: URL_SAFE_KEY,
    }));

    const unavailable = await adapter
      .findOne({
        model: "ssoProvider",
        where: [{ field: "providerId", value: identity.providerId }],
      })
      .catch((failure: unknown) => failure);
    expect(unavailable).toBeInstanceOf(OidcSsoProviderSecretUnavailableError);
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

function providerRow(input: {
  ciphertext?: string;
  clientSecret?: string;
}): Record<string, unknown> {
  return {
    ...identity,
    domain: "example.test",
    issuer: "https://login.example.test",
    oidcConfig: JSON.stringify({
      clientId: "client-a",
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
    transaction: async <Result>(
      callback: (transaction: DBTransactionAdapter) => Promise<Result>,
    ): Promise<Result> => callback(adapter as unknown as DBTransactionAdapter),
  };
  return { adapter: adapter as unknown as DBAdapter, update };
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
