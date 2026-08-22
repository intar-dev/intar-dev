const OIDC_SSO_CALLBACK_PATH = /^\/api\/auth\/sso\/callback(?:\/[^/]+)?\/?$/u;
const OIDC_SSO_START_PATH = "/api/auth/sign-in/sso";

/** Replace IdP and upstream server error details before they reach a browser. */
export function sanitizeOidcErrorResponse(
  request: Request,
  response: Response,
): Response {
  if (!isOidcSsoErrorBoundaryRequest(request)) {
    return response;
  }
  if (response.status >= 400) return fixedOidcCallbackErrorResponse();
  if (response.status < 300) return response;

  const location = response.headers.get("location");
  if (!location) return response;

  let redirect: URL;
  try {
    redirect = new URL(location, request.url);
  } catch {
    return response;
  }
  const sourceError = redirect.searchParams.get("error");
  if (!sourceError) return response;

  const discoveryFailure =
    sourceError === "discovery_failed" ||
    sourceError === "oidc_discovery_failed";
  redirect.searchParams.set(
    "error",
    discoveryFailure ? "oidc_discovery_failed" : "oidc_sign_in_failed",
  );
  redirect.searchParams.set(
    "error_description",
    discoveryFailure ? "OIDC discovery failed" : "OIDC sign-in failed",
  );

  const headers = new Headers(response.headers);
  headers.set("location", redirect.toString());
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

function fixedOidcCallbackErrorResponse(): Response {
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
