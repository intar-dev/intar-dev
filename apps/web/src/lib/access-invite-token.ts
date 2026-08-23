const AAD_PREFIX = "intar:access-invite-token:v1";
const ENVELOPE_VERSION = "v1";
const AES_GCM_IV_BYTES = 12;
const AES_256_KEY_BYTES = 32;
const AES_GCM_TAG_BYTES = 16;
const MAX_ENVELOPE_BYTES = 1024;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const INVITE_TOKEN = /^intar_beta_[A-Za-z0-9_-]{43}$/u;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export interface AccessInviteTokenIdentity {
  inviteId: string;
  codeHash: string;
  createdAt: number;
}

export class AccessInviteTokenError extends Error {
  constructor(
    readonly code:
      | "access_invite_token_key_invalid"
      | "access_invite_token_envelope_invalid"
      | "access_invite_token_decryption_failed",
  ) {
    super("The beta invite link is unavailable");
    this.name = "AccessInviteTokenError";
  }
}

export async function encryptAccessInviteToken(params: {
  encryptionKey: string | undefined;
  token: string;
  identity: AccessInviteTokenIdentity;
}): Promise<string> {
  if (!INVITE_TOKEN.test(params.token)) {
    throw new AccessInviteTokenError("access_invite_token_envelope_invalid");
  }
  const key = await importEncryptionKey(params.encryptionKey, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: copyToArrayBuffer(iv),
      additionalData: copyToArrayBuffer(aad(params.identity)),
      tagLength: 128,
    },
    key,
    copyToArrayBuffer(textEncoder.encode(params.token)),
  );
  return `${ENVELOPE_VERSION}.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
}

export async function decryptAccessInviteToken(params: {
  encryptionKey: string | undefined;
  ciphertext: string;
  identity: AccessInviteTokenIdentity;
}): Promise<string> {
  const envelope = parseEnvelope(params.ciphertext);
  const key = await importEncryptionKey(params.encryptionKey, "decrypt");
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: copyToArrayBuffer(envelope.iv),
        additionalData: copyToArrayBuffer(aad(params.identity)),
        tagLength: 128,
      },
      key,
      copyToArrayBuffer(envelope.ciphertext),
    );
    const token = textDecoder.decode(plaintext);
    if (!INVITE_TOKEN.test(token)) {
      throw new AccessInviteTokenError(
        "access_invite_token_decryption_failed",
      );
    }
    return token;
  } catch (error) {
    if (error instanceof AccessInviteTokenError) throw error;
    throw new AccessInviteTokenError("access_invite_token_decryption_failed");
  }
}

function aad(identity: AccessInviteTokenIdentity): Uint8Array {
  if (
    !identity.inviteId ||
    !/^[0-9a-f]{64}$/u.test(identity.codeHash) ||
    !Number.isSafeInteger(identity.createdAt) ||
    identity.createdAt < 0
  ) {
    throw new AccessInviteTokenError("access_invite_token_envelope_invalid");
  }
  return textEncoder.encode(
    `${AAD_PREFIX}\0${identity.inviteId}\0${identity.codeHash}\0${identity.createdAt}`,
  );
}

async function importEncryptionKey(
  encodedKey: string | undefined,
  usage: KeyUsage,
): Promise<CryptoKey> {
  if (typeof encodedKey !== "string") {
    throw new AccessInviteTokenError("access_invite_token_key_invalid");
  }
  let bytes: Uint8Array;
  try {
    bytes = base64UrlDecode(encodedKey);
  } catch {
    throw new AccessInviteTokenError("access_invite_token_key_invalid");
  }
  if (bytes.byteLength !== AES_256_KEY_BYTES) {
    throw new AccessInviteTokenError("access_invite_token_key_invalid");
  }
  try {
    return await crypto.subtle.importKey(
      "raw",
      copyToArrayBuffer(bytes),
      { name: "AES-GCM" },
      false,
      [usage],
    );
  } catch {
    throw new AccessInviteTokenError("access_invite_token_key_invalid");
  }
}

function parseEnvelope(value: string): {
  iv: Uint8Array;
  ciphertext: Uint8Array;
} {
  if (value.length > MAX_ENVELOPE_BYTES) {
    throw new AccessInviteTokenError("access_invite_token_envelope_invalid");
  }
  const [version, encodedIv, encodedCiphertext, ...extra] = value.split(".");
  if (
    version !== ENVELOPE_VERSION ||
    !encodedIv ||
    !encodedCiphertext ||
    extra.length !== 0
  ) {
    throw new AccessInviteTokenError("access_invite_token_envelope_invalid");
  }
  const iv = base64UrlDecode(encodedIv);
  const ciphertext = base64UrlDecode(encodedCiphertext);
  if (
    iv.byteLength !== AES_GCM_IV_BYTES ||
    ciphertext.byteLength < AES_GCM_TAG_BYTES
  ) {
    throw new AccessInviteTokenError("access_invite_token_envelope_invalid");
  }
  return { iv, ciphertext };
}

function base64UrlDecode(value: string): Uint8Array {
  if (!BASE64URL.test(value) || value.length % 4 === 1) {
    throw new AccessInviteTokenError("access_invite_token_envelope_invalid");
  }
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = `${standard}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) =>
    character.charCodeAt(0),
  );
  if (base64UrlEncode(bytes) !== value) {
    throw new AccessInviteTokenError("access_invite_token_envelope_invalid");
  }
  return bytes;
}

function base64UrlEncode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function copyToArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}
