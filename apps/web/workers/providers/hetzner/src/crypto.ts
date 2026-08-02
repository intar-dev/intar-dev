import type {
  CredentialContext,
  EncryptedCredentialEnvelope,
  KekVersion,
} from "./contracts";
import {
  CredentialEnvelopeError,
  credentialAad as providerCredentialAad,
  openCredentialSecret,
  parseKek,
  sealCredentialSecret,
} from "@intar/provider-worker-core";

export { CredentialEnvelopeError, parseKek };

function validHetznerToken(token: string): boolean {
  const bytes = new TextEncoder().encode(token);
  return (
    bytes.byteLength >= 20 &&
    bytes.byteLength <= 512 &&
    token.trim() === token &&
    !/\s/u.test(token)
  );
}

export function credentialAad(
  context: CredentialContext,
  purpose: "token" | "dek",
): Uint8Array {
  return providerCredentialAad(
    context,
    purpose === "token" ? "credential" : "dek",
  );
}

export function sealCredential(
  token: string,
  kek: Uint8Array,
  context: CredentialContext,
  options: { now?: Date; kekVersion?: KekVersion } = {},
): Promise<EncryptedCredentialEnvelope> {
  return sealCredentialSecret(token, kek, context, {
    validate: validHetznerToken,
    ...(options.now ? { now: options.now } : {}),
    ...(options.kekVersion ? { kekVersion: options.kekVersion } : {}),
  });
}

export function openCredential(
  envelope: EncryptedCredentialEnvelope,
  kek: Uint8Array,
  context: CredentialContext,
): Promise<string> {
  return openCredentialSecret(envelope, kek, context, validHetznerToken);
}
