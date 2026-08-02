import type { EncryptedCredentialEnvelope } from "@intar/provider-contracts";
import type {
  GcpCredentialContext,
  GcpServiceAccountKey,
} from "@intar/provider-contracts/gcp";
import {
  CredentialEnvelopeError,
  openCredentialSecret,
  parseKek,
  sealCredentialSecret,
} from "@intar/provider-worker-core";

const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
const SERVICE_ACCOUNT_PATTERN = /^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseServiceAccountKey(value: string): GcpServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new CredentialEnvelopeError("GCP service-account key is invalid");
  }
  if (
    !isRecord(parsed) ||
    parsed.type !== "service_account" ||
    typeof parsed.project_id !== "string" ||
    !PROJECT_ID_PATTERN.test(parsed.project_id) ||
    typeof parsed.private_key_id !== "string" ||
    !/^[a-f0-9]{16,128}$/iu.test(parsed.private_key_id) ||
    typeof parsed.private_key !== "string" ||
    !parsed.private_key.startsWith("-----BEGIN PRIVATE KEY-----\n") ||
    !parsed.private_key.endsWith("\n-----END PRIVATE KEY-----\n") ||
    typeof parsed.client_email !== "string" ||
    !SERVICE_ACCOUNT_PATTERN.test(parsed.client_email) ||
    typeof parsed.client_id !== "string" ||
    !/^\d{8,32}$/u.test(parsed.client_id) ||
    typeof parsed.auth_uri !== "string" ||
    parsed.auth_uri !== "https://accounts.google.com/o/oauth2/auth" ||
    typeof parsed.token_uri !== "string" ||
    parsed.token_uri !== "https://oauth2.googleapis.com/token"
  ) {
    throw new CredentialEnvelopeError("GCP service-account key is invalid");
  }
  return parsed as unknown as GcpServiceAccountKey;
}

function validServiceAccountJson(value: string): boolean {
  try {
    parseServiceAccountKey(value);
    return true;
  } catch {
    return false;
  }
}

export async function sealGcpCredential(
  keyJson: string,
  kekSecret: string,
  context: GcpCredentialContext,
  now = new Date(),
): Promise<EncryptedCredentialEnvelope> {
  const canonicalKeyJson = JSON.stringify(parseServiceAccountKey(keyJson));
  const kek = parseKek(kekSecret);
  try {
    return await sealCredentialSecret(canonicalKeyJson, kek, context, {
      now,
      validate: validServiceAccountJson,
    });
  } finally {
    kek.fill(0);
  }
}

export async function openGcpCredential(
  envelope: EncryptedCredentialEnvelope,
  kekSecret: string,
  context: GcpCredentialContext,
): Promise<GcpServiceAccountKey> {
  const kek = parseKek(kekSecret);
  try {
    const json = await openCredentialSecret(
      envelope,
      kek,
      context,
      validServiceAccountJson,
    );
    return parseServiceAccountKey(json);
  } finally {
    kek.fill(0);
  }
}
