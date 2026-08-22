import { env } from "cloudflare:workers";
import { AppError, appError } from "@/lib/app-error";

export const NO_STORE_HEADERS = {
  "cache-control": "no-store, max-age=0",
  pragma: "no-cache",
} as const;

export const MAX_API_JSON_BODY_BYTES = 1024 * 1024;
export const MAX_ORGANIZATION_SCENARIO_BUNDLE_MULTIPART_BYTES =
  65 * 1024 * 1024;

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type RequestSecurityEnv = Pick<
  Cloudflare.Env,
  "ACCESS_INVITE_RATE_LIMITER" | "BETTER_AUTH_URL"
>;

type SensitiveRateLimitAction =
  | "auth-start"
  | "scenario-start"
  | "workshop-start"
  | "terminal-issuance"
  | "ssh-issuance"
  | "build-retry"
  | "provider-connect"
  | "provider-rotate"
  | "provider-cleanup";

type RateLimitAction =
  | SensitiveRateLimitAction
  | "access-invite:exchange"
  | "access-invite:start"
  | "access-invite:confirm"
  | "access-invite:sso-link";

export type ApiRequestSecurityResult =
  | { ok: true; request: Request }
  | { ok: false; response: Response };

/**
 * Worker-level browser mutation boundary. This runs after the bearer-only
 * dispatchers, before Astro receives a custom API request. Keeping it here
 * avoids every Astro endpoint inventing its own CSRF and body-buffering rules.
 */
export async function secureApplicationApiRequest(
  request: Request,
  workerEnv: RequestSecurityEnv,
): Promise<ApiRequestSecurityResult> {
  const authResult = guardBetterAuthRequest(request, workerEnv);
  if (!authResult.ok) return authResult;

  const customResult = await guardCustomApiMutation(request, workerEnv);
  if (!customResult.ok) return customResult;

  const action = sensitiveRateLimitActionFor(request);
  if (action) {
    const rateLimitResult = await enforceRateLimit(request, workerEnv, action);
    if (!rateLimitResult.ok) return rateLimitResult;
  }

  return customResult;
}

/**
 * Better Auth has protocol-specific body formats, so it has a dedicated
 * origin/fetch-metadata guard instead of the JSON-only Astro endpoint guard.
 * GET callback routes stay available to OIDC identity providers.
 */
export function guardBetterAuthRequest(
  request: Request,
  workerEnv: Pick<Cloudflare.Env, "BETTER_AUTH_URL">,
): ApiRequestSecurityResult {
  const pathname = new URL(request.url).pathname;
  if (!isBetterAuthPath(pathname)) return { ok: true, request };

  if (isSamlPath(pathname)) {
    return deny(404, "saml_not_supported", "SAML is not supported");
  }
  if (!isMutatingMethod(request.method)) return { ok: true, request };

  return validateCanonicalBrowserOrigin(request, workerEnv);
}

/**
 * Applies the stricter JSON/multipart rules used by custom Astro endpoints.
 * Bearer-authenticated control-plane paths and Better Auth are handled before
 * this point and are not browser JSON APIs.
 */
export async function guardCustomApiMutation(
  request: Request,
  workerEnv: Pick<Cloudflare.Env, "BETTER_AUTH_URL">,
): Promise<ApiRequestSecurityResult> {
  const pathname = new URL(request.url).pathname;
  if (
    !pathname.startsWith("/api/") ||
    !isMutatingMethod(request.method) ||
    isBetterAuthPath(pathname) ||
    isPrehandledBearerApiPath(pathname) ||
    pathname.startsWith("/api/maintenance/")
  ) {
    return { ok: true, request };
  }

  const originResult = validateCanonicalBrowserOrigin(request, workerEnv);
  if (!originResult.ok) return originResult;

  if (isOrganizationScenarioBundleUpload(pathname)) {
    try {
      requireOrganizationScenarioBundleMultipart(request);
    } catch (error) {
      return errorResponse(error, "invalid scenario bundle upload");
    }
    return { ok: true, request };
  }

  if (request.body === null) {
    const declaredLength = request.headers.get("content-length");
    if (declaredLength !== null && declaredLength !== "0") {
      return deny(
        400,
        "request_body_unavailable",
        "request body is unavailable",
      );
    }
    return { ok: true, request };
  }
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return deny(415, "json_required", "content-type must be application/json");
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = canonicalContentLength(declaredLength);
    if (parsedLength === null) {
      return deny(
        400,
        "invalid_content_length",
        "content-length must be a canonical decimal value",
      );
    }
    if (parsedLength > MAX_API_JSON_BODY_BYTES) {
      return bodyTooLarge();
    }
  }

  try {
    const body = await readBoundedBody(request.body, MAX_API_JSON_BODY_BYTES);
    return { ok: true, request: rebuildRequestWithBody(request, body) };
  } catch (error) {
    if (error instanceof BodyLimitExceededError) return bodyTooLarge();
    return deny(400, "invalid_request_body", "request body could not be read");
  }
}

/** Require the one custom multipart upload to be declared and bounded. */
export function requireOrganizationScenarioBundleMultipart(request: Request): void {
  if (!isMultipartFormData(request.headers.get("content-type"))) {
    throw appError(
      415,
      "multipart_required",
      "content-type must be multipart/form-data with a boundary",
    );
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength === null) {
    throw appError(
      411,
      "content_length_required",
      "bundle uploads require a content-length",
    );
  }
  const parsedLength = canonicalContentLength(declaredLength);
  if (parsedLength === null) {
    throw appError(
      400,
      "invalid_content_length",
      "content-length must be a canonical decimal value",
    );
  }
  if (parsedLength > MAX_ORGANIZATION_SCENARIO_BUNDLE_MULTIPART_BYTES) {
    throw appError(
      413,
      "bundle_request_too_large",
      "scenario bundle upload is too large",
    );
  }
}

export function canonicalApplicationOrigin(
  workerEnv: Pick<Cloudflare.Env, "BETTER_AUTH_URL"> = env,
): string {
  const origin = normalizedOrigin(workerEnv.BETTER_AUTH_URL);
  if (!origin) {
    throw appError(
      503,
      "canonical_origin_unavailable",
      "access invitations are temporarily unavailable",
    );
  }
  return origin;
}

/** Retained for direct callers that need the invite-specific limiter key. */
export async function rateLimitPublicAccessInvite(params: {
  request: Request;
  action: "exchange" | "start" | "confirm" | "sso-link";
}): Promise<void> {
  const result = await enforceRateLimit(
    params.request,
    env,
    `access-invite:${params.action}`,
  );
  if (!result.ok) {
    const body = (await result.response.json()) as {
      error?: string;
      code?: string;
    };
    throw appError(
      result.response.status,
      body.code ?? "rate_limit_unavailable",
      body.error ?? "access invitations are temporarily unavailable",
    );
  }
}

export function sensitiveRateLimitActionFor(
  request: Request,
): SensitiveRateLimitAction | null {
  if (!isMutatingMethod(request.method)) return null;
  const pathname = new URL(request.url).pathname;

  if (isBetterAuthStartPath(pathname)) return "auth-start";
  if (/^\/api\/scenarios\/[^/]+\/start$/u.test(pathname)) {
    return "scenario-start";
  }
  if (
    /^\/api\/organizations\/[^/]+\/workshop-sessions$/u.test(pathname) ||
    /^\/api\/workshops\/[^/]+\/actions$/u.test(pathname)
  ) {
    return "workshop-start";
  }
  if (/^\/api\/scenarios\/runs\/[^/]+\/ssh$/u.test(pathname)) {
    return "ssh-issuance";
  }
  if (/^\/api\/workshops\/[^/]+\/terminal$/u.test(pathname)) {
    return "terminal-issuance";
  }
  if (/^\/api\/admin\/builds\/[^/]+\/retry$/u.test(pathname)) {
    return "build-retry";
  }
  if (/^\/api\/organizations\/[^/]+\/workshop-providers$/u.test(pathname)) {
    return "provider-connect";
  }
  if (
    /^\/api\/organizations\/[^/]+\/workshop-providers\/[^/]+\/rotate$/u.test(
      pathname,
    )
  ) {
    return "provider-rotate";
  }
  if (
    /^\/api\/organizations\/[^/]+\/workshop-providers\/[^/]+\/manual-cleanup$/u.test(
      pathname,
    )
  ) {
    return "provider-cleanup";
  }
  return null;
}

async function enforceRateLimit(
  request: Request,
  workerEnv: Pick<Cloudflare.Env, "ACCESS_INVITE_RATE_LIMITER">,
  action: RateLimitAction,
): Promise<ApiRequestSecurityResult> {
  const remoteAddress = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
  const remoteKey = await sha256Prefix(remoteAddress);
  let result: { success: boolean };
  try {
    result = await workerEnv.ACCESS_INVITE_RATE_LIMITER.limit({
      key: rateLimitKey(action, remoteKey),
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "web_edge_rate_limit_unavailable",
        action,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return deny(
      503,
      "rate_limit_unavailable",
      "request rate limiting is temporarily unavailable",
    );
  }
  if (!result.success) {
    return deny(429, "rate_limited", "too many requests", {
      "retry-after": "60",
    });
  }
  return { ok: true, request };
}

function validateCanonicalBrowserOrigin(
  request: Request,
  workerEnv: Pick<Cloudflare.Env, "BETTER_AUTH_URL">,
): ApiRequestSecurityResult {
  let canonicalOrigin: string;
  try {
    canonicalOrigin = canonicalApplicationOrigin(workerEnv);
  } catch (error) {
    return errorResponse(error, "application origin is unavailable");
  }
  // Origin is a serialized origin in browser requests. Do not normalize a
  // caller-supplied value here: a path, opaque origin, or lookalike must not
  // be made equivalent to the one canonical browser origin.
  const suppliedOrigin = request.headers.get("origin")?.trim();
  if (suppliedOrigin !== canonicalOrigin) {
    return deny(403, "invalid_origin", "request origin is not allowed");
  }
  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite && fetchSite !== "same-origin") {
    return deny(403, "cross_site_request", "cross-site requests are not allowed");
  }
  return { ok: true, request };
}

function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

function isBetterAuthPath(pathname: string): boolean {
  return pathname === "/api/auth" || pathname.startsWith("/api/auth/");
}

function isSamlPath(pathname: string): boolean {
  return /(?:^|\/)saml2?(?:\/|$)/iu.test(pathname);
}

function isBetterAuthStartPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/auth/sign-in/") ||
    pathname.startsWith("/api/auth/sign-up/") ||
    pathname === "/api/auth/forget-password" ||
    pathname === "/api/auth/request-password-reset" ||
    pathname === "/api/auth/send-verification-email" ||
    pathname === "/api/auth/oauth2/public-client-prelogin"
  );
}

function isPrehandledBearerApiPath(pathname: string): boolean {
  return (
    pathname === "/api/agent/bootstrap" ||
    pathname === "/api/agent/connect" ||
    pathname.startsWith("/api/runtime/workspace-agent/")
  );
}

function isOrganizationScenarioBundleUpload(pathname: string): boolean {
  return /^\/api\/organizations\/[^/]+\/scenarios\/bundles$/u.test(pathname);
}

function isJsonContentType(value: string | null): boolean {
  if (!value) return false;
  return /^application\/json(?:\s*;|$)/iu.test(value.trim());
}

function isMultipartFormData(value: string | null): boolean {
  if (!value) return false;
  return /^multipart\/form-data\s*;\s*boundary=(?:"[^"]+"|[^;\s]+)(?:\s*;.*)?$/iu.test(
    value,
  );
}

function canonicalContentLength(value: string): number | null {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : null;
}

function normalizedOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

class BodyLimitExceededError extends Error {}

async function readBoundedBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maxBytes - length) {
        await reader.cancel();
        throw new BodyLimitExceededError();
      }
      chunks.push(value);
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function rebuildRequestWithBody(request: Request, body: Uint8Array): Request {
  const headers = new Headers(request.headers);
  headers.set("content-length", String(body.byteLength));
  // `ReadableStream` chunks may be backed by a SharedArrayBuffer. Copy them
  // into an ordinary ArrayBuffer so the DOM and Worker Request body types both
  // preserve the exact bounded bytes.
  const copiedBody = new Uint8Array(body.byteLength);
  copiedBody.set(body);
  return new Request(request, { headers, body: copiedBody });
}

function bodyTooLarge(): ApiRequestSecurityResult {
  return deny(413, "request_too_large", "request body is too large");
}

function errorResponse(error: unknown, fallback: string): ApiRequestSecurityResult {
  if (error instanceof AppError) {
    return deny(error.status, error.code, error.message);
  }
  return deny(500, "request_security_failed", fallback);
}

function deny(
  status: number,
  code: string,
  error: string,
  extraHeaders: HeadersInit = {},
): ApiRequestSecurityResult {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    ...NO_STORE_HEADERS,
  });
  for (const [name, value] of new Headers(extraHeaders)) {
    headers.set(name, value);
  }
  return {
    ok: false,
    response: new Response(JSON.stringify({ error, code }), { status, headers }),
  };
}

async function sha256Prefix(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest).slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function rateLimitKey(action: RateLimitAction, remoteKey: string): string {
  return action.startsWith("access-invite:")
    ? `${action}:${remoteKey}`
    : `web-edge:${action}:${remoteKey}`;
}
