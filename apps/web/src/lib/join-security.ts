export const JOIN_CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self' 'sha256-c1pEHKLW8bA9c2R6jFRu+q3eC5575OSrzbh5sQomoDE=' 'sha256-KhhjLB6kfApjWK/W/usY5gB3JYQwng2NeDtqK66pb9s='; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; worker-src 'none'; media-src 'none'";

// Astro/Vite injects ephemeral inline bootstrap code and HMR styles in local
// development. Keep that relaxation local-only; deployed builds always use
// the hash-pinned policy above.
export const JOIN_LOCAL_DEVELOPMENT_CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; base-uri 'none'; form-action 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; worker-src 'self' blob:; media-src 'none'";

// `frame-ancestors` is valid only in the authoritative HTTP header. Browsers
// ignore it in a meta policy and emit a console error, so omit only that
// directive from the defense-in-depth document policy.
export const JOIN_META_CONTENT_SECURITY_POLICY = JOIN_CONTENT_SECURITY_POLICY.replace(
  "; frame-ancestors 'none'",
  "",
);
export const JOIN_LOCAL_DEVELOPMENT_META_CONTENT_SECURITY_POLICY =
  JOIN_LOCAL_DEVELOPMENT_CONTENT_SECURITY_POLICY.replace(
    "; frame-ancestors 'none'",
    "",
  );

export function hardenJoinResponse(
  response: Response,
  options: { localDevelopment?: boolean } = {},
): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store, max-age=0");
  headers.set(
    "content-security-policy",
    options.localDevelopment
      ? JOIN_LOCAL_DEVELOPMENT_CONTENT_SECURITY_POLICY
      : JOIN_CONTENT_SECURITY_POLICY,
  );
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
