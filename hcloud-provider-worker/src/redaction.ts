import type { ServiceErrorShape } from "./contracts";

const SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu,
  /\b(?:token|authorization|api[_-]?key)\s*[:=]\s*[^\s,;]+/giu,
  /\b[A-Za-z0-9_-]{32,}\b/gu,
];

export function redactString(value: string, additionalSecrets: readonly string[] = []): string {
  let redacted = value;
  for (const secret of additionalSecrets) {
    if (secret.length > 0) redacted = redacted.split(secret).join("[REDACTED]");
  }
  for (const pattern of SECRET_PATTERNS) redacted = redacted.replace(pattern, "[REDACTED]");
  return redacted.slice(0, 512);
}

export class ProviderServiceError extends Error {
  readonly shape: ServiceErrorShape;

  constructor(shape: ServiceErrorShape) {
    super(shape.message);
    this.name = "ProviderServiceError";
    this.shape = shape;
  }

  toJSON(): ServiceErrorShape {
    return this.shape;
  }
}

export function safeUnknownError(error: unknown): ServiceErrorShape {
  if (error instanceof ProviderServiceError) return error.shape;
  return {
    code: "provider_internal_error",
    message: "Hetzner provider operation failed",
    retryable: false,
  };
}
