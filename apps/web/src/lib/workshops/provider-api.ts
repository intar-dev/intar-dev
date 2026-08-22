import { appError } from "@/lib/app-error";
import { MAX_PROVIDER_JSON_BODY_BYTES } from "@/lib/request-security";

/** Read a credential-bearing JSON body without buffering an unbounded request. */
export async function readProviderRequestBody(
  request: Request,
): Promise<Record<string, unknown>> {
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) ||
      Number(declaredLength) > MAX_PROVIDER_JSON_BODY_BYTES)
  ) {
    throw bodyTooLarge();
  }
  if (!request.body) {
    throw invalidBody();
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PROVIDER_JSON_BODY_BYTES) {
        await reader.cancel();
        throw bodyTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw invalidBody();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalidBody();
  }
  return parsed as Record<string, unknown>;
}

function bodyTooLarge() {
  return appError(
    413,
    "provider_request_too_large",
    "provider credential request is too large",
  );
}

function invalidBody() {
  return appError(
    400,
    "provider_request_invalid",
    "provider request body must be a JSON object",
  );
}
