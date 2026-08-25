/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from "vitest";
import { generateSshEd25519KeyPair } from "./ssh-ed25519";
import { normalizeTemporaryNativeSshPublicKey } from "./user-ssh-keys";

describe("temporary native SSH public keys", () => {
  it("accepts one browser-generated Ed25519 public key", async () => {
    const key = generateSshEd25519KeyPair("temporary browser route");

    await expect(
      normalizeTemporaryNativeSshPublicKey(key.publicKeyOpenssh),
    ).resolves.toBe(key.publicKeyOpenssh);
  });

  it.each([
    "",
    "ssh-rsa AAAATEST unsupported",
    "ssh-ed25519 not-base64",
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 truncated",
    "ssh-ed25519 AAAATEST first\nssh-ed25519 AAAATEST second",
  ])("rejects an invalid temporary route key", async (value) => {
    await expect(
      normalizeTemporaryNativeSshPublicKey(value),
    ).rejects.toMatchObject({
      status: 400,
      code: "native_ssh_public_key_invalid",
    });
  });
});
