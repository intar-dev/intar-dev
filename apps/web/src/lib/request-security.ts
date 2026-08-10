import { env } from "cloudflare:workers";
import { appError } from "@/lib/app-error";

export const NO_STORE_HEADERS = {
  "cache-control": "no-store, max-age=0",
  pragma: "no-cache",
} as const;

/**
 * Custom Astro endpoints do not inherit Better Auth's CSRF/origin middleware.
 * Keep this deliberately stricter than the broader trusted-origin list used by
 * organization SSO: beta-access mutations are browser, same-origin JSON only.
 */
export function requireSameOriginJsonMutation(request: Request): void {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
    throw appError(405, "method_not_allowed", "a non-GET method is required");
  }

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw appError(
      415,
      "json_required",
      "content-type must be application/json",
    );
  }

  const canonicalOrigin = canonicalApplicationOrigin();
  const suppliedOrigin = normalizedOrigin(request.headers.get("origin"));
  if (!suppliedOrigin || suppliedOrigin !== canonicalOrigin) {
    throw appError(403, "invalid_origin", "request origin is not allowed");
  }

  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite && fetchSite !== "same-origin") {
    throw appError(403, "cross_site_request", "cross-site requests are not allowed");
  }
}

export function canonicalApplicationOrigin(): string {
  const configured = env.BETTER_AUTH_URL;
  const origin = normalizedOrigin(configured);
  if (!origin) {
    throw appError(
      503,
      "canonical_origin_unavailable",
      "access invitations are temporarily unavailable",
    );
  }
  return origin;
}

export async function rateLimitPublicAccessInvite(params: {
  request: Request;
  action: "exchange" | "start" | "confirm" | "sso-link";
}): Promise<void> {
  const remoteAddress =
    params.request.headers.get("cf-connecting-ip")?.trim() || "unknown";
  const remoteKey = await sha256Prefix(remoteAddress);

  let result: { success: boolean };
  try {
    result = await env.ACCESS_INVITE_RATE_LIMITER.limit({
      key: `access-invite:${params.action}:${remoteKey}`,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "access_invite_rate_limit_unavailable",
        action: params.action,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    throw appError(
      503,
      "rate_limit_unavailable",
      "access invitations are temporarily unavailable",
    );
  }

  if (!result.success) {
    throw appError(429, "rate_limited", "too many invite attempts");
  }
}

function normalizedOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
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
