import type { ServiceErrorShape } from "@intar/provider-contracts";

const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+\/-]{8,}/giu,
  /(?:token|secret|private_key|private-key|client_email|authorization)\s*[=:]\s*[^\s,;]+/giu,
  /-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/gu,
];

export function redactString(
  value: string,
  additionalSecrets: readonly string[] = [],
): string {
  let redacted = value;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  for (const secret of additionalSecrets) {
    if (secret.length >= 4) redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted.slice(0, 512);
}

export class ProviderServiceError extends Error {
  readonly shape: ServiceErrorShape;

  constructor(shape: ServiceErrorShape) {
    super(shape.message);
    this.name = "ProviderServiceError";
    this.shape = Object.freeze({ ...shape });
  }
}

export function safeProviderError(
  error: unknown,
  fallback: Pick<ServiceErrorShape, "code" | "message">,
): ServiceErrorShape {
  if (error instanceof ProviderServiceError) return error.shape;
  return {
    code: fallback.code,
    message: fallback.message,
    retryable: false,
  };
}
