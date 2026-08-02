import { describe, expect, it } from "vitest";
import type { CredentialContext } from "../src/contracts";
import {
  CredentialEnvelopeError,
  openCredential,
  parseKek,
  sealCredential,
} from "../src/crypto";

const context: CredentialContext = {
  organizationId: "org_0123456789",
  connectionId: "conn_0123456789",
  credentialId: "cred_0123456789",
  provider: "hetzner_cloud",
  version: 1,
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe("provider credential envelope", () => {
  it("wraps a random DEK and decrypts only with the bound context", async () => {
    const token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const kek = new Uint8Array(32).fill(17);
    const envelope = await sealCredential(token, kek, context, {
      now: new Date("2026-07-22T12:00:00.000Z"),
    });

    expect(await openCredential(envelope, kek, context)).toBe(token);
    expect(JSON.stringify(envelope)).not.toContain(token);
    expect(envelope.aadSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(envelope.createdAt).toBe("2026-07-22T12:00:00.000Z");

    await expect(
      openCredential(envelope, kek, { ...context, organizationId: "org_other" }),
    ).rejects.toBeInstanceOf(CredentialEnvelopeError);
    await expect(
      openCredential(envelope, kek, { ...context, version: 2 }),
    ).rejects.toBeInstanceOf(CredentialEnvelopeError);
  });

  it("uses fresh DEKs and nonces for every credential version", async () => {
    const token = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const kek = new Uint8Array(32).fill(23);
    const first = await sealCredential(token, kek, context);
    const second = await sealCredential(token, kek, context);

    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.wrappedDek).not.toBe(second.wrappedDek);
    expect(first.ciphertextIv).not.toBe(second.ciphertextIv);
    expect(first.wrappedDekIv).not.toBe(second.wrappedDekIv);
  });

  it("rejects a wrong KEK and ciphertext tampering without leaking a token", async () => {
    const token = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const kek = new Uint8Array(32).fill(31);
    const envelope = await sealCredential(token, kek, context);

    await expect(openCredential(envelope, new Uint8Array(32).fill(32), context)).rejects.toThrow(
      "Provider credential envelope is invalid",
    );
    await expect(
      openCredential({ ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -2)}AA` }, kek, context),
    ).rejects.toThrow("Provider credential envelope is invalid");
  });

  it("rejects context delimiters that could make AAD fields ambiguous", async () => {
    await expect(
      sealCredential("c".repeat(64), new Uint8Array(32).fill(11), {
        ...context,
        organizationId: "org_ok\nconnection=conn_other",
      }),
    ).rejects.toBeInstanceOf(CredentialEnvelopeError);
  });

  it("accepts only a base64-encoded 256-bit KEK", () => {
    expect(parseKek(bytesToBase64(new Uint8Array(32).fill(1)))).toHaveLength(32);
    expect(() => parseKek(bytesToBase64(new Uint8Array(31).fill(1)))).toThrow(
      "Provider KEK must decode to 32 bytes",
    );
  });
});
