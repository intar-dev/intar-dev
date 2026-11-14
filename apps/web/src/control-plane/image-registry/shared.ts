export const textEncoder = new TextEncoder();

export const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

export const BUILD_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export async function hasRegistryPublishToken(
  request: Request,
  env: Cloudflare.Env,
): Promise<boolean> {
  const expected = env.REGISTRY_PUBLISH_TOKEN?.trim();
  const authHeader = request.headers.get("authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";
  if (!expected || !bearer) {
    return false;
  }

  const [expectedHash, bearerHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", textEncoder.encode(expected)),
    crypto.subtle.digest("SHA-256", textEncoder.encode(bearer)),
  ]);
  return timingSafeHashEqual(expectedHash, bearerHash);
}

export function timingSafeHashEqual(
  expected: ArrayBuffer,
  actual: ArrayBuffer,
): boolean {
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (
      left: ArrayBuffer | ArrayBufferView,
      right: ArrayBuffer | ArrayBufferView,
    ) => boolean;
  };
  if (typeof subtle.timingSafeEqual === "function") {
    return subtle.timingSafeEqual(expected, actual);
  }

  // Node's Web Crypto test runtime does not yet expose timingSafeEqual. Both
  // inputs are fixed-size SHA-256 digests, so this loop preserves the same
  // constant-work comparison without leaking the original token length.
  const left = new Uint8Array(expected);
  const right = new Uint8Array(actual);
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left[index]! ^ right[index]!;
  }
  return mismatch === 0;
}

export function isSafeBuildId(value: string): boolean {
  return value !== "." && value !== ".." && BUILD_ID_RE.test(value);
}

export function isScenarioDifficulty(value: unknown): boolean {
  return value === "easy" || value === "medium" || value === "hard";
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isPositiveU32(value: unknown): boolean {
  return isPositiveInteger(value) && value <= 0xffff_ffff;
}

export async function sha256Hex(value: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSafeBundleRev(value: string): boolean {
  return (
    value !== "." && value !== ".." && /^[A-Za-z0-9._-]{1,128}$/.test(value)
  );
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
