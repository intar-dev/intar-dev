const OIDC_SSO_SECRET_AAD_PREFIX = "intar:oidc-sso-secret:v1";
const OIDC_SSO_SECRET_ENVELOPE_VERSION = "v1";
const AES_GCM_IV_BYTES = 12;
const AES_256_KEY_BYTES = 32;
const AES_GCM_TAG_BYTES = 16;
const MAX_CLIENT_SECRET_BYTES = 4096;
const MAX_ENVELOPE_BYTES = 8192;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export type OidcSsoSecretIdentity = {
  id: string;
  providerId: string;
  organizationId: string | null;
};

export class OidcSsoSecretError extends Error {
  constructor(
    readonly code:
      | "oidc_sso_secret_key_invalid"
      | "oidc_sso_secret_envelope_invalid"
      | "oidc_sso_secret_decryption_failed",
  ) {
    super("OIDC SSO secret configuration is unavailable");
    this.name = "OidcSsoSecretError";
  }
}

export function isOidcClientSecretLengthValid(value: string): boolean {
  return textEncoder.encode(value).byteLength <= MAX_CLIENT_SECRET_BYTES;
}

export async function encryptOidcClientSecret(params: {
  encryptionKey: string | undefined;
  clientSecret: string;
  identity: OidcSsoSecretIdentity;
}): Promise<string> {
  if (!isOidcClientSecretLengthValid(params.clientSecret)) {
    throw new OidcSsoSecretError("oidc_sso_secret_envelope_invalid");
  }
  const key = await importEncryptionKey(params.encryptionKey, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(additionalAuthenticatedData(params.identity)),
      tagLength: 128,
    },
    key,
    toArrayBuffer(textEncoder.encode(params.clientSecret)),
  );
  return `${OIDC_SSO_SECRET_ENVELOPE_VERSION}.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
}

export async function decryptOidcClientSecret(params: {
  encryptionKey: string | undefined;
  ciphertext: string;
  identity: OidcSsoSecretIdentity;
}): Promise<string> {
  const envelope = parseEnvelope(params.ciphertext);
  const key = await importEncryptionKey(params.encryptionKey, "decrypt");
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(envelope.iv),
        additionalData: toArrayBuffer(additionalAuthenticatedData(params.identity)),
        tagLength: 128,
      },
      key,
      toArrayBuffer(envelope.ciphertext),
    );
    return textDecoder.decode(plaintext);
  } catch {
    throw new OidcSsoSecretError("oidc_sso_secret_decryption_failed");
  }
}

function additionalAuthenticatedData(identity: OidcSsoSecretIdentity): Uint8Array {
  return textEncoder.encode(
    `${OIDC_SSO_SECRET_AAD_PREFIX}\0${identity.id}\0${identity.providerId}\0${identity.organizationId ?? ""}`,
  );
}

async function importEncryptionKey(
  encodedKey: string | undefined,
  usage: KeyUsage,
): Promise<CryptoKey> {
  if (typeof encodedKey !== "string") {
    throw new OidcSsoSecretError("oidc_sso_secret_key_invalid");
  }
  let keyBytes: Uint8Array;
  try {
    keyBytes = decodeBase64Url(encodedKey);
  } catch {
    throw new OidcSsoSecretError("oidc_sso_secret_key_invalid");
  }
  if (keyBytes.byteLength !== AES_256_KEY_BYTES) {
    throw new OidcSsoSecretError("oidc_sso_secret_key_invalid");
  }
  try {
    return await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(keyBytes),
      { name: "AES-GCM" },
      false,
      [usage],
    );
  } catch {
    throw new OidcSsoSecretError("oidc_sso_secret_key_invalid");
  }
}

function parseEnvelope(value: string): {
  iv: Uint8Array;
  ciphertext: Uint8Array;
} {
  if (value.length > MAX_ENVELOPE_BYTES) {
    throw new OidcSsoSecretError("oidc_sso_secret_envelope_invalid");
  }
  const [version, encodedIv, encodedCiphertext, ...extra] = value.split(".");
  if (
    version !== OIDC_SSO_SECRET_ENVELOPE_VERSION ||
    !encodedIv ||
    !encodedCiphertext ||
    extra.length !== 0
  ) {
    throw new OidcSsoSecretError("oidc_sso_secret_envelope_invalid");
  }
  const iv = decodeBase64Url(encodedIv);
  const ciphertext = decodeBase64Url(encodedCiphertext);
  if (
    iv.byteLength !== AES_GCM_IV_BYTES ||
    ciphertext.byteLength < AES_GCM_TAG_BYTES
  ) {
    throw new OidcSsoSecretError("oidc_sso_secret_envelope_invalid");
  }
  return { iv, ciphertext };
}

function decodeBase64Url(value: string): Uint8Array {
  if (!BASE64URL.test(value) || value.length % 4 === 1) {
    throw new OidcSsoSecretError("oidc_sso_secret_envelope_invalid");
  }
  try {
    const standardBase64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = `${standardBase64}${"=".repeat((4 - (value.length % 4)) % 4)}`;
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    if (base64UrlEncode(bytes) !== value) {
      throw new OidcSsoSecretError("oidc_sso_secret_envelope_invalid");
    }
    return bytes;
  } catch (error) {
    if (error instanceof OidcSsoSecretError) throw error;
    throw new OidcSsoSecretError("oidc_sso_secret_envelope_invalid");
  }
}

function base64UrlEncode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(value.byteLength);
  new Uint8Array(buffer).set(value);
  return buffer;
}
