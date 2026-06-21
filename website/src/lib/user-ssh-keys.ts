import { env } from "cloudflare:workers";
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { userSshKeys } from "@/db/schema";
import { appError } from "@/lib/app-error";
import { createAppId } from "@/lib/id";

const MAX_USER_SSH_KEYS = 16;
const MAX_LABEL_LENGTH = 80;
const MAX_PUBLIC_KEY_LENGTH = 8192;
const ALLOWED_SSH_KEY_TYPES = new Set([
  "ssh-ed25519",
  "sk-ssh-ed25519@openssh.com",
]);

export interface UserSshKeyRecord {
  id: string;
  userId: string;
  label: string | null;
  keyType: string;
  comment: string | null;
  publicKeyOpenssh: string;
  fingerprintSha256: string;
  createdAt: number;
  updatedAt: number;
}

export interface AuthorizedLaunchSshKey {
  publicKeyOpenssh: string;
  fingerprintSha256: string;
}

export async function listUserSshKeysForUser(
  userId: string,
): Promise<UserSshKeyRecord[]> {
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(userSshKeys)
    .where(eq(userSshKeys.userId, userId))
    .orderBy(desc(userSshKeys.createdAt));

  return rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    label: row.label,
    keyType: row.keyType,
    comment: row.comment,
    publicKeyOpenssh: row.publicKeyOpenssh,
    fingerprintSha256: row.fingerprintSha256,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export async function listUserAuthorizedSshKeysForNativeRoutes(
  userId: string,
): Promise<AuthorizedLaunchSshKey[]> {
  const keys = await listUserSshKeysForUser(userId);
  return keys
    .filter((key) => ALLOWED_SSH_KEY_TYPES.has(key.keyType))
    .map((key) => ({
      publicKeyOpenssh: key.publicKeyOpenssh,
      fingerprintSha256: key.fingerprintSha256,
    }));
}

export async function createUserSshKeyForUser(input: {
  userId: string;
  label?: string | null;
  publicKey: string;
}): Promise<UserSshKeyRecord> {
  const db = drizzle(env.DB);
  const existingKeys = await db
    .select({
      id: userSshKeys.id,
      fingerprintSha256: userSshKeys.fingerprintSha256,
    })
    .from(userSshKeys)
    .where(eq(userSshKeys.userId, input.userId));

  if (existingKeys.length >= MAX_USER_SSH_KEYS) {
    throw appError(
      409,
      "user_ssh_key_limit_reached",
      `you can store up to ${MAX_USER_SSH_KEYS} public SSH keys`,
    );
  }

  const parsedKey = await parseOpenSshPublicKey(input.publicKey);
  if (
    existingKeys.some(
      (candidate) =>
        candidate.fingerprintSha256 === parsedKey.fingerprintSha256,
    )
  ) {
    throw appError(
      409,
      "user_ssh_key_duplicate",
      "that public SSH key is already on your profile",
    );
  }

  const label = normalizeLabel(input.label);
  const now = Date.now();
  const row = {
    id: createAppId(),
    userId: input.userId,
    label,
    keyType: parsedKey.keyType,
    comment: parsedKey.comment,
    publicKeyOpenssh: parsedKey.normalized,
    fingerprintSha256: parsedKey.fingerprintSha256,
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(userSshKeys).values(row);

  return row;
}

export async function deleteUserSshKeyForUser(input: {
  userId: string;
  keyId: string;
}): Promise<void> {
  const db = drizzle(env.DB);
  const result = await db
    .delete(userSshKeys)
    .where(
      and(eq(userSshKeys.id, input.keyId), eq(userSshKeys.userId, input.userId)),
    );

  if (!result.meta.changes) {
    throw appError(404, "user_ssh_key_not_found", "SSH key not found");
  }
}

async function parseOpenSshPublicKey(raw: string): Promise<{
  normalized: string;
  keyType: string;
  comment: string | null;
  fingerprintSha256: string;
}> {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw appError(400, "user_ssh_key_invalid", "public SSH key is required");
  }

  if (trimmed.length > MAX_PUBLIC_KEY_LENGTH) {
    throw appError(
      400,
      "user_ssh_key_invalid",
      "public SSH key is unexpectedly large",
    );
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) {
    throw appError(
      400,
      "user_ssh_key_invalid",
      "paste exactly one OpenSSH public key",
    );
  }

  const line = lines[0];
  if (!line) {
    throw appError(400, "user_ssh_key_invalid", "public SSH key is required");
  }

  const match = /^(\S+)\s+([A-Za-z0-9+/=]+)(?:\s+(.+))?$/.exec(line);
  if (!match) {
    throw appError(
      400,
      "user_ssh_key_invalid",
      "public SSH key must be in OpenSSH authorized_keys format",
    );
  }

  const [, rawKeyType, rawBody, rawComment] = match;
  if (!rawKeyType || !rawBody) {
    throw appError(
      400,
      "user_ssh_key_invalid",
      "public SSH key must be in OpenSSH authorized_keys format",
    );
  }

  const keyType = rawKeyType;
  const body = rawBody;
  const comment = rawComment?.trim() || null;
  if (!ALLOWED_SSH_KEY_TYPES.has(keyType)) {
    throw appError(
      400,
      "user_ssh_key_invalid",
      "only Ed25519 public keys are allowed (ssh-ed25519 or sk-ssh-ed25519@openssh.com)",
    );
  }

  const decoded = decodeBase64(body);
  if (!decoded.length) {
    throw appError(
      400,
      "user_ssh_key_invalid",
      "public SSH key payload is empty",
    );
  }

  const parsedType = readSshString(decoded);
  if (parsedType !== keyType) {
    throw appError(
      400,
      "user_ssh_key_invalid",
      "public SSH key payload does not match its declared type",
    );
  }

  const digestInput = Uint8Array.from(decoded).buffer;
  const fingerprintBytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", digestInput),
  );
  const fingerprintSha256 = `SHA256:${base64NoPadding(fingerprintBytes)}`;

  return {
    normalized: comment ? `${keyType} ${body} ${comment}` : `${keyType} ${body}`,
    keyType,
    comment,
    fingerprintSha256,
  };
}

function normalizeLabel(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) {
    return null;
  }
  if (trimmed.length > MAX_LABEL_LENGTH) {
    throw appError(
      400,
      "user_ssh_key_invalid",
      `SSH key label must be at most ${MAX_LABEL_LENGTH} characters`,
    );
  }
  return trimmed;
}

function decodeBase64(value: string): Uint8Array {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw appError(
      400,
      "user_ssh_key_invalid",
      "public SSH key payload is not valid base64",
    );
  }
}

function readSshString(bytes: Uint8Array): string {
  if (bytes.length < 4) {
    throw appError(
      400,
      "user_ssh_key_invalid",
      "public SSH key payload is truncated",
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(0, false);
  const start = 4;
  const end = start + length;
  if (length <= 0 || end > bytes.length) {
    throw appError(
      400,
      "user_ssh_key_invalid",
      "public SSH key payload is truncated",
    );
  }

  return new TextDecoder().decode(bytes.subarray(start, end));
}

function base64NoPadding(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/=+$/g, "");
}
