import {
  ENVELOPE_ALGORITHM,
  HCLOUD_PROVIDER_KIND,
  KEK_VERSION_V1,
  type CredentialContext,
  type EncryptedCredentialEnvelope,
  type KekVersion,
} from "./contracts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const AES_KEY_BYTES = 32;
const AES_GCM_IV_BYTES = 12;
const CONTEXT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

export class CredentialEnvelopeError extends Error {
  constructor(message = "Provider credential envelope is invalid") {
    super(message);
    this.name = "CredentialEnvelopeError";
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    throw new CredentialEnvelopeError();
  }
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function validateContext(context: CredentialContext): void {
  if (
    context.provider !== HCLOUD_PROVIDER_KIND ||
    !CONTEXT_ID_PATTERN.test(context.organizationId) ||
    !CONTEXT_ID_PATTERN.test(context.connectionId) ||
    !CONTEXT_ID_PATTERN.test(context.credentialId) ||
    !Number.isSafeInteger(context.version) ||
    context.version < 1
  ) {
    throw new CredentialEnvelopeError();
  }
}

export function credentialAad(context: CredentialContext, purpose: "token" | "dek"): Uint8Array {
  validateContext(context);
  return encoder.encode(
    [
      "intar-provider-credential",
      "schema=1",
      `purpose=${purpose}`,
      `provider=${context.provider}`,
      `organization=${context.organizationId}`,
      `connection=${context.connectionId}`,
      `credential=${context.credentialId}`,
      `version=${context.version}`,
    ].join("\n"),
  );
}

async function aadDigest(context: CredentialContext): Promise<string> {
  const tokenAad = credentialAad(context, "token");
  const digest = await crypto.subtle.digest("SHA-256", copyArrayBuffer(tokenAad));
  return bytesToBase64(new Uint8Array(digest));
}

export function parseKek(secret: string): Uint8Array {
  const kek = base64ToBytes(secret.trim());
  if (kek.byteLength !== AES_KEY_BYTES) {
    kek.fill(0);
    throw new CredentialEnvelopeError("Provider KEK must decode to 32 bytes");
  }
  return kek;
}

async function importAesKey(raw: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    copyArrayBuffer(raw),
    { name: "AES-GCM", length: 256 },
    false,
    usages,
  );
}

function validateToken(token: string): Uint8Array {
  const bytes = encoder.encode(token);
  if (
    bytes.byteLength < 20 ||
    bytes.byteLength > 512 ||
    token.trim() !== token ||
    /\s/u.test(token)
  ) {
    bytes.fill(0);
    throw new CredentialEnvelopeError("Hetzner token has an invalid format");
  }
  return bytes;
}

export async function sealCredential(
  token: string,
  kek: Uint8Array,
  context: CredentialContext,
  options: { now?: Date; kekVersion?: KekVersion } = {},
): Promise<EncryptedCredentialEnvelope> {
  validateContext(context);
  if (kek.byteLength !== AES_KEY_BYTES) throw new CredentialEnvelopeError();

  const tokenBytes = validateToken(token);
  const dekBytes = crypto.getRandomValues(new Uint8Array(AES_KEY_BYTES));
  const tokenIv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const wrapIv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));

  try {
    const [dek, kekKey] = await Promise.all([
      importAesKey(dekBytes, ["encrypt"]),
      importAesKey(kek, ["encrypt"]),
    ]);
    const [ciphertext, wrappedDek, digest] = await Promise.all([
      crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: copyArrayBuffer(tokenIv),
          additionalData: copyArrayBuffer(credentialAad(context, "token")),
          tagLength: 128,
        },
        dek,
        copyArrayBuffer(tokenBytes),
      ),
      crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: copyArrayBuffer(wrapIv),
          additionalData: copyArrayBuffer(credentialAad(context, "dek")),
          tagLength: 128,
        },
        kekKey,
        copyArrayBuffer(dekBytes),
      ),
      aadDigest(context),
    ]);

    return {
      algorithm: ENVELOPE_ALGORITHM,
      kekVersion: options.kekVersion ?? KEK_VERSION_V1,
      aadSha256: digest,
      wrappedDek: bytesToBase64(new Uint8Array(wrappedDek)),
      wrappedDekIv: bytesToBase64(wrapIv),
      ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
      ciphertextIv: bytesToBase64(tokenIv),
      createdAt: (options.now ?? new Date()).toISOString(),
    };
  } finally {
    tokenBytes.fill(0);
    dekBytes.fill(0);
    tokenIv.fill(0);
    wrapIv.fill(0);
  }
}

export async function openCredential(
  envelope: EncryptedCredentialEnvelope,
  kek: Uint8Array,
  context: CredentialContext,
): Promise<string> {
  validateContext(context);
  if (
    envelope.algorithm !== ENVELOPE_ALGORITHM ||
    envelope.kekVersion !== KEK_VERSION_V1 ||
    kek.byteLength !== AES_KEY_BYTES ||
    envelope.aadSha256 !== (await aadDigest(context))
  ) {
    throw new CredentialEnvelopeError();
  }

  const wrappedDek = base64ToBytes(envelope.wrappedDek);
  const wrappedDekIv = base64ToBytes(envelope.wrappedDekIv);
  const ciphertext = base64ToBytes(envelope.ciphertext);
  const ciphertextIv = base64ToBytes(envelope.ciphertextIv);

  if (wrappedDekIv.byteLength !== AES_GCM_IV_BYTES || ciphertextIv.byteLength !== AES_GCM_IV_BYTES) {
    wrappedDek.fill(0);
    wrappedDekIv.fill(0);
    ciphertext.fill(0);
    ciphertextIv.fill(0);
    throw new CredentialEnvelopeError();
  }

  let dekBytes: Uint8Array | undefined;
  let plaintext: Uint8Array | undefined;
  try {
    const kekKey = await importAesKey(kek, ["decrypt"]);
    const unwrapped = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: copyArrayBuffer(wrappedDekIv),
        additionalData: copyArrayBuffer(credentialAad(context, "dek")),
        tagLength: 128,
      },
      kekKey,
      copyArrayBuffer(wrappedDek),
    );
    dekBytes = new Uint8Array(unwrapped);
    if (dekBytes.byteLength !== AES_KEY_BYTES) throw new CredentialEnvelopeError();

    const dek = await importAesKey(dekBytes, ["decrypt"]);
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: copyArrayBuffer(ciphertextIv),
          additionalData: copyArrayBuffer(credentialAad(context, "token")),
          tagLength: 128,
        },
        dek,
        copyArrayBuffer(ciphertext),
      ),
    );
    const token = decoder.decode(plaintext);
    validateToken(token).fill(0);
    return token;
  } catch (error) {
    if (error instanceof CredentialEnvelopeError) throw error;
    throw new CredentialEnvelopeError();
  } finally {
    dekBytes?.fill(0);
    plaintext?.fill(0);
    wrappedDek.fill(0);
    wrappedDekIv.fill(0);
    ciphertext.fill(0);
    ciphertextIv.fill(0);
  }
}
