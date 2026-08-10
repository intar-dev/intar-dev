const BYPASS_COOKIE = "__Host-intar-maintenance";
const BYPASS_TTL_MS = 2 * 60 * 60 * 1000;
const encoder = new TextEncoder();

export async function handleMaintenanceMode(
  request: Request,
  workerEnv: Cloudflare.Env,
): Promise<Response | null> {
  if (workerEnv.BETA_ACCESS_MAINTENANCE !== "on") return null;

  const pathname = new URL(request.url).pathname;
  if (pathname === "/api/maintenance/bypass" && request.method === "POST") {
    return establishMaintenanceBypass(request, workerEnv);
  }

  if (await hasMaintenanceBypass(request, workerEnv)) return null;

  if (pathname.startsWith("/api/") || pathname.startsWith("/agent/")) {
    return maintenanceJson();
  }
  return maintenancePage();
}

async function establishMaintenanceBypass(
  request: Request,
  workerEnv: Cloudflare.Env,
): Promise<Response> {
  const expectedOrigin = safeOrigin(workerEnv.BETTER_AUTH_URL);
  const suppliedOrigin = safeOrigin(request.headers.get("origin"));
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (
    !expectedOrigin ||
    suppliedOrigin !== expectedOrigin ||
    (fetchSite && fetchSite !== "same-origin") ||
    !contentType.startsWith("application/json")
  ) {
    return maintenanceJson(403, "maintenance bypass denied");
  }

  const body = (await request.json().catch(() => null)) as {
    secret?: unknown;
  } | null;
  const suppliedSecret =
    typeof body?.secret === "string" ? body.secret : "";
  const configuredSecret = workerEnv.BETA_MAINTENANCE_BYPASS_SECRET;
  if (
    typeof configuredSecret !== "string" ||
    encoder.encode(configuredSecret).byteLength < 32 ||
    !(await equalSecrets(suppliedSecret, configuredSecret))
  ) {
    return maintenanceJson(403, "maintenance bypass denied");
  }

  const expiresAt = Date.now() + BYPASS_TTL_MS;
  const signature = await signExpiry(expiresAt, configuredSecret);
  const headers = maintenanceHeaders("application/json; charset=utf-8");
  headers.set(
    "set-cookie",
    // Lax is required for the top-level GitHub/OIDC callback that redeems the
    // bootstrap invite. The __Host- prefix still makes this host-only, while
    // the bypass-creation endpoint itself remains exact-origin JSON only.
    `${BYPASS_COOKIE}=${expiresAt}.${signature}; Path=/; Max-Age=${Math.floor(BYPASS_TTL_MS / 1000)}; Secure; HttpOnly; SameSite=Lax`,
  );
  return new Response(JSON.stringify({ bypass: true, expiresAt }), {
    status: 200,
    headers,
  });
}

async function hasMaintenanceBypass(
  request: Request,
  workerEnv: Cloudflare.Env,
): Promise<boolean> {
  const configuredSecret = workerEnv.BETA_MAINTENANCE_BYPASS_SECRET;
  if (
    typeof configuredSecret !== "string" ||
    encoder.encode(configuredSecret).byteLength < 32
  ) {
    return false;
  }
  const value = cookieValue(request.headers.get("cookie"), BYPASS_COOKIE);
  if (!value) return false;
  const [rawExpiry, signature, extra] = value.split(".");
  if (!rawExpiry || !signature || extra) return false;
  const expiresAt = Number(rawExpiry);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return false;
  const expected = await signExpiry(expiresAt, configuredSecret);
  return equalSecrets(signature, expected);
}

async function signExpiry(expiresAt: number, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`intar-maintenance-v1.${expiresAt}`),
  );
  return base64Url(new Uint8Array(signature));
}

async function equalSecrets(left: string, right: string): Promise<boolean> {
  const leftDigest = await crypto.subtle.digest("SHA-256", encoder.encode(left));
  const rightDigest = await crypto.subtle.digest("SHA-256", encoder.encode(right));
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let mismatch = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < leftBytes.length; index += 1) {
    mismatch |= leftBytes[index]! ^ rightBytes[index]!;
  }
  return mismatch === 0;
}

function maintenanceJson(
  status = 503,
  error = "beta access maintenance is in progress",
): Response {
  const headers = maintenanceHeaders("application/json; charset=utf-8");
  headers.set("retry-after", "60");
  return new Response(JSON.stringify({ error, code: "maintenance" }), {
    status,
    headers,
  });
}

function maintenancePage(): Response {
  const headers = maintenanceHeaders("text/html; charset=utf-8");
  headers.set(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  headers.set("x-robots-tag", "noindex, nofollow");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Maintenance · intar.dev</title><style>html{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif;background:#171613;color:#f3efe4}body{min-height:100vh;margin:0;display:grid;place-items:center}main{width:min(38rem,calc(100% - 3rem));border-top:3px solid #d65f2f;padding-top:2rem}p{max-width:60ch;color:#c9c1b2;line-height:1.6}small{font-family:ui-monospace,monospace;color:#938b7d}</style></head><body><main><small>PLANNED CUTOVER</small><h1>Beta access is under maintenance</h1><p>We are replacing the access boundary and validating the new invite flow. Existing sessions are intentionally unavailable until the checks finish.</p><p>Try again shortly.</p></main></body></html>`,
    { status: 503, headers },
  );
}

function maintenanceHeaders(contentType: string): Headers {
  return new Headers({
    "cache-control": "no-store, max-age=0",
    "content-type": contentType,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
}

function safeOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim() || null;
    }
  }
  return null;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
