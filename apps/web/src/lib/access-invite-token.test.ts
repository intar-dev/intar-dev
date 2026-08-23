import { describe, expect, it } from "vitest";
import {
  AccessInviteTokenError,
  decryptAccessInviteToken,
  encryptAccessInviteToken,
  type AccessInviteTokenIdentity,
} from "./access-invite-token";

const encryptionKey =
  "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const token = `intar_beta_${"A".repeat(43)}`;
const identity: AccessInviteTokenIdentity = {
  inviteId: "invite-1",
  codeHash: "a".repeat(64),
  createdAt: 1_000,
};

describe("access invite token encryption", () => {
  it("round-trips a row-bound token", async () => {
    const ciphertext = await encryptAccessInviteToken({
      encryptionKey,
      token,
      identity,
    });

    expect(ciphertext).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    await expect(
      decryptAccessInviteToken({ encryptionKey, ciphertext, identity }),
    ).resolves.toBe(token);
    expect(ciphertext).not.toContain(token);
  });

  it("rejects another invite identity and tampering", async () => {
    const ciphertext = await encryptAccessInviteToken({
      encryptionKey,
      token,
      identity,
    });
    const [version, iv, encrypted] = ciphertext.split(".") as [
      string,
      string,
      string,
    ];
    const tampered = `${version}.${iv}.${encrypted.startsWith("A") ? "B" : "A"}${encrypted.slice(1)}`;

    for (const candidate of [
      { ciphertext, identity: { ...identity, inviteId: "invite-2" } },
      { ciphertext: tampered, identity },
    ]) {
      await expect(
        decryptAccessInviteToken({ encryptionKey, ...candidate }),
      ).rejects.toMatchObject({
        code: "access_invite_token_decryption_failed",
      });
    }
  });

  it("rejects a different valid encryption key", async () => {
    const ciphertext = await encryptAccessInviteToken({
      encryptionKey,
      token,
      identity,
    });

    await expect(
      decryptAccessInviteToken({
        encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        ciphertext,
        identity,
      }),
    ).rejects.toMatchObject({
      code: "access_invite_token_decryption_failed",
    });
  });

  it("requires one exact 32-byte base64url key", async () => {
    for (const candidate of [undefined, "not-a-key", `${encryptionKey}A`]) {
      await expect(
        encryptAccessInviteToken({
          encryptionKey: candidate,
          token,
          identity,
        }),
      ).rejects.toEqual(
        new AccessInviteTokenError("access_invite_token_key_invalid"),
      );
    }
  });
});
