const BYPASS_COOKIE = "__Host-intar-maintenance";
const BYPASS_TTL_MS = 2 * 60 * 60 * 1000;
const encoder = new TextEncoder();

export async function handleMaintenanceMode(
  request: Request,
  workerEnv: Cloudflare.Env,
): Promise<Response | null> {
  if (!betaAccessMaintenanceEnabled(workerEnv)) return null;

  const pathname = new URL(request.url).pathname;
  if (pathname === "/api/maintenance/bypass" && request.method === "POST") {
    return establishMaintenanceBypass(request, workerEnv);
  }

  // An operator cookie can prove the fence is the expected protected version,
  // but it never enters the application. Even GET/HEAD application routes are
  // unsafe here: OAuth callbacks and session refreshes can write D1.
  if (
    pathname === "/api/maintenance/status" &&
    (request.method === "GET" || request.method === "HEAD") &&
    (await hasMaintenanceBypass(request, workerEnv))
  ) {
    return maintenanceStatus(request.method === "HEAD");
  }

  if (pathname.startsWith("/api/") || pathname.startsWith("/agent/")) {
    return maintenanceJsonResponse();
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
    return maintenanceJsonResponse(403, "maintenance bypass denied");
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
    return maintenanceJsonResponse(403, "maintenance bypass denied");
  }

  const expiresAt = Date.now() + BYPASS_TTL_MS;
  const signature = await signExpiry(expiresAt, configuredSecret);
  const headers = maintenanceHeaders("application/json; charset=utf-8");
  headers.set(
    "set-cookie",
    // This cookie authorizes only the database-independent maintenance status
    // endpoint. It never bypasses the application or an OAuth callback.
    `${BYPASS_COOKIE}=${expiresAt}.${signature}; Path=/; Max-Age=${Math.floor(BYPASS_TTL_MS / 1000)}; Secure; HttpOnly; SameSite=Strict`,
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

export function betaAccessMaintenanceEnabled(
  workerEnv: Pick<Cloudflare.Env, "BETA_ACCESS_MAINTENANCE">,
): boolean {
  return String(workerEnv.BETA_ACCESS_MAINTENANCE) === "on";
}

export function maintenanceJsonResponse(
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

function maintenanceStatus(head: boolean): Response {
  const headers = maintenanceHeaders("application/json; charset=utf-8");
  return new Response(
    head ? null : JSON.stringify({ maintenance: true, fence: "verified" }),
    { status: 200, headers },
  );
}

function maintenancePage(): Response {
  const nonce = maintenanceNonce();
  const headers = maintenanceHeaders("text/html; charset=utf-8");
  headers.set(
    "content-security-policy",
    `default-src 'none'; connect-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  );
  headers.set("x-robots-tag", "noindex, nofollow");
  return new Response(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="robots" content="noindex,nofollow">
    <title>Maintenance · intar.dev</title>
    <style nonce="${nonce}">
      html{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif;background:#171613;color:#f3efe4}
      body{min-height:100vh;margin:0;display:grid;place-items:center}
      main{width:min(38rem,calc(100% - 3rem));border-top:3px solid #d65f2f;padding-top:2rem}
      p{max-width:60ch;color:#c9c1b2;line-height:1.6}
      small{font-family:ui-monospace,monospace;color:#938b7d}
      form{margin-top:2rem;padding-top:1.5rem;border-top:1px solid #4b463d}
      label{display:block;margin-bottom:.5rem;font-weight:650}
      input,button{box-sizing:border-box;font:inherit;border-radius:.35rem}
      input{width:100%;padding:.75rem;border:1px solid #736a5d;background:#211f1b;color:#f3efe4}
      input:focus-visible,button:focus-visible{outline:3px solid #ef8a5f;outline-offset:3px}
      button{margin-top:1rem;padding:.7rem 1rem;border:0;background:#b84a20;color:#fff;cursor:pointer;font-weight:700}
      button:disabled{cursor:wait;opacity:.65}
      #operator-status{min-height:1.6em;margin-bottom:0}
      #operator-status[data-error="true"]{color:#ffb49a}
    </style>
  </head>
  <body>
    <main>
      <small>PLANNED CUTOVER</small>
      <h1>Beta access is under maintenance</h1>
      <p>We are replacing the access boundary and validating the new invite flow. Existing sessions are intentionally unavailable until the checks finish.</p>
      <p>Try again shortly.</p>
      <form id="operator-login" action="/api/maintenance/bypass" method="post">
        <label for="operator-secret">Operator maintenance secret</label>
        <input id="operator-secret" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" required>
        <button id="operator-submit" type="submit">Verify maintenance fence</button>
        <p id="operator-status" role="status" aria-live="polite" aria-atomic="true"></p>
      </form>
    </main>
    <script nonce="${nonce}">
      (() => {
        "use strict";
        const form = document.getElementById("operator-login");
        const secretInput = document.getElementById("operator-secret");
        const submitButton = document.getElementById("operator-submit");
        const status = document.getElementById("operator-status");
        if (!(form instanceof HTMLFormElement) ||
            !(secretInput instanceof HTMLInputElement) ||
            !(submitButton instanceof HTMLButtonElement) ||
            !(status instanceof HTMLParagraphElement)) return;

        window.addEventListener("pagehide", () => {
          secretInput.value = "";
        });

        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          form.setAttribute("aria-busy", "true");
          submitButton.disabled = true;
          status.removeAttribute("data-error");
          status.textContent = "Checking operator access…";
          let requestBody = "";
          try {
            requestBody = JSON.stringify({ secret: secretInput.value });
            secretInput.value = "";
            const response = await fetch("/api/maintenance/bypass", {
              method: "POST",
              headers: { "content-type": "application/json" },
              credentials: "same-origin",
              cache: "no-store",
              redirect: "error",
              body: requestBody,
            });
            requestBody = "";
            if (!response.ok) {
              status.setAttribute("data-error", "true");
              status.textContent = "Operator access was denied. Check the secret and try again.";
              secretInput.focus();
              return;
            }
            const statusResponse = await fetch("/api/maintenance/status", {
              method: "GET",
              credentials: "same-origin",
              cache: "no-store",
              redirect: "error",
            });
            if (!statusResponse.ok) throw new Error("status check failed");
            status.textContent = "Maintenance fence verified. Application access remains blocked.";
          } catch {
            status.setAttribute("data-error", "true");
            status.textContent = "Operator access could not be checked. Try again.";
            secretInput.focus();
          } finally {
            requestBody = "";
            secretInput.value = "";
            form.removeAttribute("aria-busy");
            submitButton.disabled = false;
          }
        });
      })();
    </script>
  </body>
</html>`,
    { status: 503, headers },
  );
}

function maintenanceNonce(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(18)));
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
