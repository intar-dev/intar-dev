// Astro/Vite injects ephemeral inline bootstrap code and HMR styles in local
// development. Keep that relaxation local-only; deployed builds use a fresh
// nonce for every response.
export const JOIN_LOCAL_DEVELOPMENT_CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; base-uri 'none'; form-action 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; worker-src 'self' blob:; media-src 'none'";

function joinContentSecurityPolicy(nonce: string): string {
  return `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; font-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; worker-src 'none'; media-src 'none'`;
}

function joinNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_");
}

export function hardenJoinResponse(
  response: Response,
  options: { localDevelopment?: boolean } = {},
): Response {
  const headers = new Headers(response.headers);
  const localDevelopment = options.localDevelopment === true;
  const nonce = localDevelopment ? null : joinNonce();
  headers.set("cache-control", "no-store, max-age=0");
  headers.set(
    "content-security-policy",
    nonce === null
      ? JOIN_LOCAL_DEVELOPMENT_CONTENT_SECURITY_POLICY
      : joinContentSecurityPolicy(nonce),
  );
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  const hardenedResponse = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  if (nonce === null || response.body === null) {
    return hardenedResponse;
  }

  // The Astro hydration bootstraps are generated at build time, so their
  // hashes are not a stable security boundary. Apply the response nonce only
  // to inline code; external scripts remain constrained by `script-src 'self'`.
  return new HTMLRewriter()
    .on("script", {
      element(element) {
        if (!element.hasAttribute("src")) element.setAttribute("nonce", nonce);
      },
    })
    .on("style", {
      element(element) {
        element.setAttribute("nonce", nonce);
      },
    })
    .on("meta[http-equiv]", {
      element(element) {
        if (
          element.getAttribute("http-equiv")?.toLowerCase() ===
          "content-security-policy"
        ) {
          element.remove();
        }
      },
    })
    .transform(hardenedResponse);
}
