import { ProviderServiceError } from "./errors";

const encoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Deterministic RFC 9562 UUIDv8 suitable for GCP's requestId field. */
export async function deterministicRequestId(parts: readonly string[]): Promise<string> {
  if (
    parts.length === 0 ||
    parts.some((part) => part.length === 0 || part.length > 256 || part.includes("\0"))
  ) {
    throw new ProviderServiceError({
      code: "invalid_provider_request",
      message: "Deterministic request identity is invalid",
      retryable: false,
    });
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(parts.join("\0"))),
  ).slice(0, 16);
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x80;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytesToHex(digest);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function deterministicResourceName(
  prefix: string,
  parts: readonly string[],
  maxLength = 63,
): Promise<string> {
  if (!/^[a-z][a-z0-9-]{0,15}$/u.test(prefix) || maxLength < 16 || maxLength > 63) {
    throw new ProviderServiceError({
      code: "invalid_provider_request",
      message: "Provider resource prefix is invalid",
      retryable: false,
    });
  }
  const uuid = await deterministicRequestId(parts);
  const suffix = uuid.replaceAll("-", "").slice(0, 20);
  return `${prefix}-${suffix}`.slice(0, maxLength).replace(/-+$/u, "");
}

export function assertConnectionId(connectionId: string): void {
  if (!/^[A-Za-z0-9._-]{8,128}$/u.test(connectionId)) {
    throw new ProviderServiceError({
      code: "invalid_provider_request",
      message: "Invalid connection id",
      retryable: false,
    });
  }
}
