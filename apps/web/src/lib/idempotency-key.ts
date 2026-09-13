import { appError } from "@/lib/app-error";

/**
 * Validation for the caller-supplied start idempotency key.
 *
 * The rule lives in its own module so the HTTP route can validate the header
 * before any admission work without loading the runtime admission module, and
 * so both callers share one definition.
 */
const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
const IDEMPOTENCY_KEY_MAX_LENGTH = 200;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~:/+=-]+$/;

export function requireIdempotencyKey(value: string | undefined): string {
  const key = value?.trim() ?? "";
  if (
    key.length < IDEMPOTENCY_KEY_MIN_LENGTH ||
    key.length > IDEMPOTENCY_KEY_MAX_LENGTH ||
    !IDEMPOTENCY_KEY_PATTERN.test(key)
  ) {
    throw appError(
      400,
      "idempotency_key_required",
      "the Idempotency-Key header must be 8 to 200 safe characters",
    );
  }
  return key;
}
