import { env } from "cloudflare:workers";
import { appError } from "@/lib/app-error";

const ATTEMPT_COOKIE_NAME = "__Host-intar-beta-invite";
const ATTEMPT_TTL_MS = 20 * 60 * 1000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface InviteAttempt {
  version: 1;
  attemptId: string;
  inviteId: string;
  issuedAt: number;
  expiresAt: number;
  leaseId?: string;
  leaseExpiresAt?: number;
}

export function newInviteAttempt(inviteId: string, now = Date.now()): InviteAttempt {
  const attemptIdBytes = new Uint8Array(18);
  crypto.getRandomValues(attemptIdBytes);
  return {
    version: 1,
    attemptId: base64UrlEncode(attemptIdBytes),
    inviteId,
    issuedAt: now,
    expiresAt: now + ATTEMPT_TTL_MS,
  };
}

export function withInviteLease(
  attempt: InviteAttempt,
  lease: { leaseId: string; leaseExpiresAt: number },
): InviteAttempt {
  return {
    ...attempt,
    leaseId: lease.leaseId,
    leaseExpiresAt: lease.leaseExpiresAt,
    expiresAt: Math.max(attempt.expiresAt, lease.leaseExpiresAt),
  };
}

export async function readInviteAttempt(
  request: Request,
  now = Date.now(),
): Promise<InviteAttempt> {
  const rawCookie = parseCookie(request.headers.get("cookie"), ATTEMPT_COOKIE_NAME);
  if (!rawCookie) {
    throw appError(401, "invite_attempt_required", "open the invitation link again");
  }

  const attempt = await verifyInviteAttempt(rawCookie);
  if (!attempt || attempt.expiresAt <= now) {
    throw appError(401, "invite_attempt_expired", "open the invitation link again");
  }
  return attempt;
}

export async function inviteAttemptSetCookie(
  attempt: InviteAttempt,
): Promise<string> {
  const value = await signInviteAttempt(attempt);
  const maxAge = Math.max(0, Math.ceil((attempt.expiresAt - Date.now()) / 1000));
  return `${ATTEMPT_COOKIE_NAME}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}

export function clearInviteAttemptCookie(): string {
  return `${ATTEMPT_COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
}

export async function signInviteAttempt(
  attempt: InviteAttempt,
  secret = env.BETTER_AUTH_SECRET,
): Promise<string> {
  const payload = base64UrlEncode(textEncoder.encode(JSON.stringify(attempt)));
  const key = await importAttemptKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(`intar-beta-attempt-v1.${payload}`),
  );
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function verifyInviteAttempt(
  value: string,
  secret = env.BETTER_AUTH_SECRET,
): Promise<InviteAttempt | null> {
  const [payload, encodedSignature, extra] = value.split(".");
  if (!payload || !encodedSignature || extra) return null;
  const payloadBytes = base64UrlDecode(payload);
  const signature = base64UrlDecode(encodedSignature);
  if (!payloadBytes || !signature) return null;

  const key = await importAttemptKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    copyToArrayBuffer(signature),
    textEncoder.encode(`intar-beta-attempt-v1.${payload}`),
  );
  if (!valid) return null;

  try {
    const parsed = JSON.parse(textDecoder.decode(payloadBytes)) as Partial<InviteAttempt>;
    if (
      parsed.version !== 1 ||
      typeof parsed.attemptId !== "string" ||
      parsed.attemptId.length < 16 ||
      typeof parsed.inviteId !== "string" ||
      !parsed.inviteId ||
      typeof parsed.issuedAt !== "number" ||
      typeof parsed.expiresAt !== "number" ||
      parsed.expiresAt <= parsed.issuedAt ||
      (parsed.leaseId !== undefined && typeof parsed.leaseId !== "string") ||
      (parsed.leaseExpiresAt !== undefined &&
        typeof parsed.leaseExpiresAt !== "number")
    ) {
      return null;
    }
    return parsed as InviteAttempt;
  } catch {
    return null;
  }
}

function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim() || null;
    }
  }
  return null;
}

async function importAttemptKey(secret: string): Promise<CryptoKey> {
  if (typeof secret !== "string" || textEncoder.encode(secret).byteLength < 32) {
    throw appError(
      503,
      "invite_security_unavailable",
      "access invitations are temporarily unavailable",
    );
  }
  return crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const padded = `${value}${"=".repeat((4 - (value.length % 4)) % 4)}`
      .replaceAll("-", "+")
      .replaceAll("_", "/");
    const binary = atob(padded);
    const decoded = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return base64UrlEncode(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

function copyToArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}
