import {
  APP_SIGN_IN_CODES,
  withErrorCode,
} from "@/lib/organization-sso-errors";

const OIDC_SSO_CALLBACK_PATH = /^\/api\/auth\/sso\/callback(?:\/[^/]+)?\/?$/u;
const OIDC_SSO_START_PATH = "/api/auth/sign-in/sso";
// Better Auth's own error page, and the app page `onAPIError.errorURL` points
// flows without an error URL of their own at.
const GENERIC_ERROR_PATHS = new Set(["/api/auth/error", "/"]);
const FALLBACK_ERROR_PATH = "/organization-sign-in";

// Better Auth reports these outcomes with plain-text codes.
const BETTER_AUTH_ERROR_CODES: Record<string, string> = {
  // The provider's email belongs to an account the identity isn't connected
  // to, and Better Auth refused to link by email.
  "account not linked": "sso_email_in_use",
};

/** Replace IdP and upstream server error details before they reach a browser. */
export function sanitizeOidcErrorResponse(
  request: Request,
  response: Response,
): Response {
  if (!isOidcSsoErrorBoundaryRequest(request)) {
    return response;
  }
  if (response.status >= 400) return fixedOidcErrorResponse(request);
  if (response.status < 300) return response;

  const location = response.headers.get("location");
  if (!location) return response;

  let redirect: URL;
  try {
    redirect = new URL(location, request.url);
  } catch {
    return response;
  }
  // Organization flows always carry their own URLs, so a generic error page
  // is a dead end for them.
  if (GENERIC_ERROR_PATHS.has(redirect.pathname)) {
    const code = redirect.searchParams.get("error");
    redirect = new URL(FALLBACK_ERROR_PATH, request.url);
    redirect.searchParams.set("error", code ?? "oidc_sign_in_failed");
  }
  const sourceError = redirect.searchParams.get("error");
  if (!sourceError) return response;

  // The SSO plugin copies an `error` the identity provider sent to the
  // callback straight into this redirect. Only Intar may use its own codes.
  const code = identityProviderReportedError(request)
    ? "oidc_sign_in_failed"
    : sanitizedErrorCode(sourceError, redirect.searchParams.get("error_description"));

  const headers = new Headers(response.headers);
  headers.set("location", withErrorCode(redirect.toString(), code));
  headers.delete("content-length");
  headers.delete("content-type");
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function isOidcSsoErrorBoundaryRequest(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  return (
    pathname === OIDC_SSO_START_PATH || OIDC_SSO_CALLBACK_PATH.test(pathname)
  );
}

/**
 * The response for a failure that has no error redirect. A browser that
 * followed the identity provider back lands on the organization sign-in page;
 * API callers get a fixed JSON body.
 */
export function fixedOidcErrorResponse(request: Request): Response {
  if (
    request.method === "GET" &&
    OIDC_SSO_CALLBACK_PATH.test(new URL(request.url).pathname)
  ) {
    return new Response(null, {
      status: 302,
      headers: {
        location: withErrorCode(
          FALLBACK_ERROR_PATH,
          "oidc_sign_in_failed",
          request.url,
        ),
        "cache-control": "no-store, max-age=0",
        pragma: "no-cache",
      },
    });
  }
  return new Response(
    JSON.stringify({
      error: "OIDC sign-in failed",
      code: "oidc_sign_in_failed",
    }),
    {
      status: 400,
      headers: {
        "cache-control": "no-store, max-age=0",
        "content-type": "application/json; charset=utf-8",
        pragma: "no-cache",
      },
    },
  );
}

function identityProviderReportedError(request: Request): boolean {
  const url = new URL(request.url);
  return (
    OIDC_SSO_CALLBACK_PATH.test(url.pathname) && url.searchParams.has("error")
  );
}

function sanitizedErrorCode(
  sourceError: string,
  sourceDescription: string | null,
): string {
  // The plugin refuses an ID token without an email or subject this way.
  if (
    sourceError === "invalid_provider" &&
    sourceDescription === "missing_user_info"
  ) {
    return "oidc_email_missing";
  }
  const mapped = Object.hasOwn(BETTER_AUTH_ERROR_CODES, sourceError)
    ? BETTER_AUTH_ERROR_CODES[sourceError]!
    : sourceError;
  // App-owned codes reach the browser; every other code, including identity
  // provider and discovery details, collapses to a generic failure. Pages
  // look up the message for a code, so no description is passed along.
  if (APP_SIGN_IN_CODES.has(mapped)) return mapped;
  if (mapped === "discovery_failed" || mapped === "oidc_discovery_failed") {
    return "oidc_discovery_failed";
  }
  return "oidc_sign_in_failed";
}
