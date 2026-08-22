const DEFAULT_CONTENT_SECURITY_POLICY =
  "base-uri 'none'; object-src 'none'; frame-ancestors 'none'";
const DEFAULT_PERMISSIONS_POLICY =
  "accelerometer=(), autoplay=(), camera=(), clipboard-read=(), geolocation=(), gyroscope=(), microphone=(), payment=(), picture-in-picture=(), usb=()";
const API_CACHE_CONTROL = "private, no-store, max-age=0";
const PRODUCTION_HOSTNAME = "intar.dev";

type ResponseSecurityEnv = Pick<Cloudflare.Env, "BETTER_AUTH_URL">;

/**
 * Applies the baseline policy after every Worker dispatcher has produced a
 * response. Route-specific policies are deliberately retained: this gives
 * `/join`, maintenance, and artifact responses room to be stricter.
 */
export function hardenWorkerResponse(
  request: Request,
  response: Response,
  workerEnv: ResponseSecurityEnv,
): Response {
  // WebSocket upgrade responses cannot be reconstructed without dropping the
  // socket. They do not represent cacheable HTTP content in any case.
  if (
    response.status === 101 ||
    ("webSocket" in response && response.webSocket !== null)
  ) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("x-frame-options", "DENY");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  if (!headers.has("permissions-policy")) {
    headers.set("permissions-policy", DEFAULT_PERMISSIONS_POLICY);
  }
  if (!headers.has("content-security-policy")) {
    headers.set("content-security-policy", DEFAULT_CONTENT_SECURITY_POLICY);
  }

  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) {
    headers.set("cache-control", API_CACHE_CONTROL);
    headers.set("pragma", "no-cache");
  }
  if (isProductionHttpsRequest(request, workerEnv)) {
    // Do not assert this policy for subdomains. Several operational services
    // intentionally have their own hostname and transport lifecycle.
    headers.set("strict-transport-security", "max-age=31536000");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isProductionHttpsRequest(
  request: Request,
  workerEnv: ResponseSecurityEnv,
): boolean {
  try {
    const requestUrl = new URL(request.url);
    const configuredUrl = new URL(workerEnv.BETTER_AUTH_URL);
    return (
      requestUrl.protocol === "https:" &&
      configuredUrl.protocol === "https:" &&
      configuredUrl.hostname === PRODUCTION_HOSTNAME &&
      requestUrl.origin === configuredUrl.origin
    );
  } catch {
    return false;
  }
}

export const responseSecurity = {
  API_CACHE_CONTROL,
  DEFAULT_CONTENT_SECURITY_POLICY,
  DEFAULT_PERMISSIONS_POLICY,
};
