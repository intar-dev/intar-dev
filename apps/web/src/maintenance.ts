import type {
  CleanupPauseResult,
  CleanupRunRequest,
} from "../workers/image-registry-cleanup/src/types";
import type { RegistryCleanup } from "../workers/image-registry-cleanup/src/worker";

const BYPASS_COOKIE = "__Host-intar-maintenance";
const BYPASS_TTL_MS = 2 * 60 * 60 * 1000;
export const MAX_MAINTENANCE_BYPASS_JSON_BYTES = 64 * 1024;
const encoder = new TextEncoder();

export async function handleMaintenanceMode(
  request: Request,
  workerEnv: Cloudflare.Env,
): Promise<Response | null> {
  if (!controlPlaneMaintenanceEnabled(workerEnv)) return null;

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

export const REGISTRY_CLEANUP_GATE_PATH = "/api/maintenance/registry-cleanup";

const REGISTRY_CLEANUP_GATE_MAX_WAIT_MS = 10 * 60 * 1000;

/**
 * The collector RPC surface, reached through the REGISTRY_CLEANUP binding. The
 * type comes from the child entrypoint itself, so a changed method signature is
 * a compile error here instead of a runtime surprise.
 */
type RegistryCleanupGateBinding = Pick<
  RegistryCleanup,
  "status" | "plan" | "run" | "pause" | "resume"
>;

/**
 * The deployment gate for the image registry collector.
 *
 * The collector publishes no route and no workers.dev address, so a deployment
 * reaches it here, through the parent that holds the service binding. This
 * handler is registered after `handleMaintenanceMode`, so the maintenance fence
 * stays in front of it: while maintenance is on, this path answers 503 under
 * the fence and the collector cannot be reached at all. A deployment holds the
 * collector before it enables maintenance, and releases it only after the
 * parent serves traffic again.
 *
 * Authorization is the maintenance bypass secret, which is a machine caller's
 * credential. This is not the operator cookie ceremony, and it grants nothing
 * beyond these five collector methods. The handler reads no database of its
 * own, and it reaches the child only after the secret is verified.
 */
export async function handleRegistryCleanupGateRequest(
  request: Request,
  workerEnv: Cloudflare.Env,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== REGISTRY_CLEANUP_GATE_PATH) return null;
  if (request.method !== "POST") {
    return registryCleanupGateResponse(405, { error: "method not allowed" });
  }

  // A present Origin must match the canonical origin, and a browser that sends
  // Sec-Fetch-Site from another site is refused, so this surface cannot be
  // driven as a confused deputy. The deployment itself calls with curl, which
  // sends neither header; the secret is what authorizes that call.
  const expectedOrigin = safeOrigin(workerEnv.BETTER_AUTH_URL);
  const suppliedOrigin = request.headers.get("origin")?.trim();
  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  const contentType = request.headers.get("content-type")?.trim() ?? "";
  if (
    !expectedOrigin ||
    (suppliedOrigin !== undefined && suppliedOrigin !== expectedOrigin) ||
    (fetchSite && fetchSite !== "same-origin") ||
    !/^application\/json(?:\s*;|$)/iu.test(contentType)
  ) {
    return registryCleanupGateDenied();
  }

  const configuredSecret = workerEnv.CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET;
  if (
    typeof configuredSecret !== "string" ||
    encoder.encode(configuredSecret).byteLength < 32
  ) {
    return registryCleanupGateResponse(503, {
      code: "registry_cleanup_gate_unconfigured",
      error: "the deployment gate has no usable secret",
    });
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/u.test(declaredLength)) {
      return registryCleanupGateDenied();
    }
    if (Number(declaredLength) > MAX_MAINTENANCE_BYPASS_JSON_BYTES) {
      return registryCleanupGateResponse(413, { error: "request body too large" });
    }
  }

  const encodedBody = await readBoundedBody(
    request.body,
    MAX_MAINTENANCE_BYPASS_JSON_BYTES,
  );
  if (!encodedBody) {
    return registryCleanupGateResponse(413, { error: "request body too large" });
  }
  const body = parseJson(encodedBody) as {
    secret?: unknown;
    action?: unknown;
    reason?: unknown;
    wait_ms?: unknown;
    plan_only?: unknown;
  } | null;
  const suppliedSecret = typeof body?.secret === "string" ? body.secret : "";
  // Authorization settles before any child access, so an unauthenticated caller
  // never learns whether a collector is deployed.
  if (!(await equalSecrets(suppliedSecret, configuredSecret))) {
    return registryCleanupGateDenied();
  }

  const binding = registryCleanupGateBinding(workerEnv);
  if (!binding) {
    // No collector version answers yet. This is a clear refusal, not a fence:
    // the distinct code tells the deployment which of the two it is looking at.
    return registryCleanupGateResponse(503, {
      code: "registry_cleanup_unavailable",
      error: "the parent has no image registry cleanup worker binding",
    });
  }

  const action = typeof body?.action === "string" ? body.action.trim() : "";
  try {
    if (action === "pause") {
      const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
      const paused = await binding.pause({
        ...(reason ? { reason } : {}),
        waitMs: registryCleanupGateWaitMs(body?.wait_ms),
      });
      return registryCleanupGatePauseResponse(action, paused);
    }
    if (action === "resume") {
      return registryCleanupGatePauseResponse(action, await binding.resume());
    }
    if (action === "status") {
      return registryCleanupGateResponse(200, {
        action,
        result: await binding.status(),
      });
    }
    if (action === "plan" || action === "run") {
      const input: CleanupRunRequest = { planOnly: body?.plan_only === true };
      return registryCleanupGateResponse(200, {
        action,
        result:
          action === "plan"
            ? await binding.plan(input)
            : await binding.run(input),
      });
    }
    return registryCleanupGateResponse(400, {
      error: "action must be pause, resume, status, plan, or run",
    });
  } catch (error) {
    return registryCleanupGateResponse(502, {
      code: "registry_cleanup_gate_failed",
      error:
        error instanceof Error ? error.message : "the collector did not answer",
    });
  }
}

/**
 * The hold and the release answer under `result`, which is the field the
 * deployment gate reads. An unreadable answer stays unreadable: a deployment
 * must see a missing flag, not a flag it can mistake for a proven state.
 */
function registryCleanupGatePauseResponse(
  action: "pause" | "resume",
  result: CleanupPauseResult | undefined,
): Response {
  return registryCleanupGateResponse(200, {
    action,
    result: {
      paused: gateFlag(result?.paused),
      pauseReason:
        typeof result?.pauseReason === "string" ? result.pauseReason : null,
      idle: gateFlag(result?.idle),
      stalled: gateFlag(result?.stalled),
    },
  });
}

function registryCleanupGateBinding(
  workerEnv: Cloudflare.Env,
): RegistryCleanupGateBinding | null {
  const binding = workerEnv.REGISTRY_CLEANUP as unknown as
    | RegistryCleanupGateBinding
    | undefined;
  if (
    !binding ||
    typeof binding.pause !== "function" ||
    typeof binding.resume !== "function" ||
    typeof binding.status !== "function" ||
    typeof binding.plan !== "function" ||
    typeof binding.run !== "function"
  ) {
    return null;
  }
  return binding;
}

function registryCleanupGateWaitMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(
    Math.max(Math.trunc(value), 0),
    REGISTRY_CLEANUP_GATE_MAX_WAIT_MS,
  );
}

function gateFlag(value: unknown): boolean | null {
  return value === true ? true : value === false ? false : null;
}

/** Every refusal reads the same, so a caller cannot probe the gate's state. */
function registryCleanupGateDenied(): Response {
  return registryCleanupGateResponse(403, {
    error: "registry cleanup gate denied",
  });
}

function registryCleanupGateResponse(
  status: number,
  body: Record<string, unknown>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: maintenanceHeaders("application/json; charset=utf-8"),
  });
}

async function establishMaintenanceBypass(
  request: Request,
  workerEnv: Cloudflare.Env,
): Promise<Response> {
  const expectedOrigin = safeOrigin(workerEnv.BETTER_AUTH_URL);
  const suppliedOrigin = request.headers.get("origin")?.trim();
  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  const contentType = request.headers.get("content-type")?.trim() ?? "";
  if (
    !expectedOrigin ||
    suppliedOrigin !== expectedOrigin ||
    (fetchSite && fetchSite !== "same-origin") ||
    !/^application\/json(?:\s*;|$)/iu.test(contentType)
  ) {
    return maintenanceJsonResponse(403, "maintenance bypass denied");
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/u.test(declaredLength)) {
      return maintenanceJsonResponse(400, "maintenance bypass denied");
    }
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length)) {
      return maintenanceJsonResponse(400, "maintenance bypass denied");
    }
    if (length > MAX_MAINTENANCE_BYPASS_JSON_BYTES) {
      return maintenanceJsonResponse(413, "maintenance bypass denied");
    }
  }

  const encodedBody = await readBoundedBody(
    request.body,
    MAX_MAINTENANCE_BYPASS_JSON_BYTES,
  );
  if (!encodedBody) {
    return maintenanceJsonResponse(413, "maintenance bypass denied");
  }
  const body = parseJson(encodedBody) as {
    secret?: unknown;
  } | null;
  const suppliedSecret = typeof body?.secret === "string" ? body.secret : "";
  const configuredSecret = workerEnv.CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET;
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

async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    return null;
  }
}

async function hasMaintenanceBypass(
  request: Request,
  workerEnv: Cloudflare.Env,
): Promise<boolean> {
  const configuredSecret = workerEnv.CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET;
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
  const leftDigest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(left),
  );
  const rightDigest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(right),
  );
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let mismatch = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < leftBytes.length; index += 1) {
    mismatch |= leftBytes[index]! ^ rightBytes[index]!;
  }
  return mismatch === 0;
}

export function controlPlaneMaintenanceEnabled(
  workerEnv: Pick<Cloudflare.Env, "CONTROL_PLANE_MAINTENANCE">,
): boolean {
  return String(workerEnv.CONTROL_PLANE_MAINTENANCE) === "on";
}

export function maintenanceJsonResponse(
  status = 503,
  error = "control-plane maintenance is in progress",
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
    `default-src 'none'; connect-src 'self'; img-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
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
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <style nonce="${nonce}">
      html{color-scheme:light dark;font-family:"IBM Plex Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:#f9f5ee;color:#1f1a14}
      body{min-height:100vh;margin:0;display:grid;place-items:center}
      main{width:min(38rem,calc(100% - 2rem));border-top:3px solid #c74700;padding-top:2rem}
      @media (min-width:40rem){main{width:min(38rem,calc(100% - 3rem))}}
      .brand{display:flex;align-items:center;gap:.5rem;margin-bottom:1.5rem}
      .brand img{display:block;width:28px;height:28px}
      .wm{font-size:.9375rem;font-weight:600;letter-spacing:-.015em}
      .wm b{font-weight:inherit;color:#a93800}
      h1{font-size:1.5rem;line-height:1.25;font-weight:600;letter-spacing:-.015em;text-wrap:balance}
      p{max-width:60ch;color:#5b5348;line-height:1.6}
      small{font-size:.75rem;font-weight:500;letter-spacing:.01em;color:#6a6155}
      form{margin-top:2rem;padding-top:1.5rem;border-top:1px solid #e3dacb}
      label{display:block;margin-bottom:.375rem;font-size:.8125rem;font-weight:500}
      input,button{box-sizing:border-box;font:inherit;border-radius:.5rem;height:2.25rem}
      input{width:100%;padding:0 .75rem;border:1px solid #928777;background:#fffdf9;color:#1f1a14;box-shadow:0 1px 2px rgb(31 26 20/.06);outline:none}
      input:hover{border-color:#7d7365}
      input:focus-visible{border-color:#c74700;box-shadow:0 0 0 3px color-mix(in oklab,#c74700 20%,transparent)}
      input[aria-invalid="true"]{border-color:#ba2b2b;box-shadow:0 0 0 3px color-mix(in oklab,#ba2b2b 20%,transparent)}
      button:focus-visible{outline:2px solid #c74700;outline-offset:2px}
      button{margin-top:1rem;padding:0 .875rem;border:0;background:#c74700;color:#fdfbf9;cursor:pointer;font-size:.875rem;font-weight:600;box-shadow:inset 0 1px 0 rgb(255 255 255/.2),0 1px 2px rgb(31 26 20/.2)}
      button:hover{background:#be4000}
      button:disabled{cursor:wait;opacity:.45}
      #operator-status,#operator-alert{min-height:1.25rem;margin:.75rem 0 0;font-size:.875rem;line-height:1.25rem}
      #operator-status[data-tone="success"]{color:#0b7643}
      #operator-alert{color:#ba2b2b}
      @media (pointer:coarse){input,button{min-height:2.75rem}}
      @media (prefers-reduced-motion:no-preference){
        input{transition:border-color 150ms cubic-bezier(.2,0,0,1),box-shadow 150ms cubic-bezier(.2,0,0,1)}
        button{transition:background-color 150ms cubic-bezier(.2,0,0,1),transform 150ms cubic-bezier(.2,0,0,1)}
        button:active:not(:disabled){transform:translateY(1px) scale(.985);transition-duration:100ms}
        button:focus-visible{animation:ring 150ms cubic-bezier(.2,0,0,1)}
        @keyframes ring{from{outline-color:transparent;outline-offset:0}}
      }
      @media (prefers-color-scheme:dark){
        html{background:#1a1714;color:#efe8df}
        main{border-top-color:#f88a3d}
        .wm b{color:#faa663}
        p{color:#aea597}
        small{color:#9d9386}
        form{border-top-color:#322c26}
        input{border-color:#73695e;background:#24201c;color:#efe8df;box-shadow:0 1px 2px rgb(0 0 0/.3)}
        input:hover{border-color:#8a8073}
        input:focus-visible{border-color:#f88a3d;box-shadow:0 0 0 3px color-mix(in oklab,#f88a3d 20%,transparent)}
        input[aria-invalid="true"]{border-color:#f97772;box-shadow:0 0 0 3px color-mix(in oklab,#f97772 20%,transparent)}
        button:focus-visible{outline-color:#f88a3d}
        button{background:#f88a3d;color:#21110a;box-shadow:inset 0 1px 0 rgb(255 255 255/.28),0 1px 2px rgb(0 0 0/.35)}
        button:hover{background:#fc9d51}
        #operator-status[data-tone="success"]{color:#62d397}
        #operator-alert{color:#f97772}
      }
    </style>
  </head>
  <body>
    <main>
      <div class="brand"><img src="/favicon.svg" width="28" height="28" alt=""><span class="wm">intar<b>.dev</b></span></div>
      <small>Planned maintenance</small>
      <h1>The control plane is under maintenance</h1>
      <p>Planned maintenance is in progress. Existing sessions are unavailable until the checks finish.</p>
      <p>Try again shortly.</p>
      <form id="operator-login" action="/api/maintenance/bypass" method="post" novalidate>
        <label for="operator-secret">Operator maintenance secret</label>
        <input id="operator-secret" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" required aria-describedby="operator-status operator-alert">
        <button id="operator-submit" type="submit">Verify maintenance fence</button>
        <p id="operator-status" role="status" aria-live="polite" aria-atomic="true"></p>
        <p id="operator-alert" role="alert"></p>
      </form>
    </main>
    <script nonce="${nonce}">
      (() => {
        "use strict";
        const form = document.getElementById("operator-login");
        const secretInput = document.getElementById("operator-secret");
        const submitButton = document.getElementById("operator-submit");
        const status = document.getElementById("operator-status");
        const alertBox = document.getElementById("operator-alert");
        if (!(form instanceof HTMLFormElement) ||
            !(secretInput instanceof HTMLInputElement) ||
            !(submitButton instanceof HTMLButtonElement) ||
            !(status instanceof HTMLParagraphElement) ||
            !(alertBox instanceof HTMLParagraphElement)) return;

        const say = (tone, text) => {
          status.removeAttribute("data-tone");
          status.textContent = "";
          alertBox.textContent = "";
          secretInput.removeAttribute("aria-invalid");
          if (tone === "error") {
            alertBox.textContent = text;
            secretInput.setAttribute("aria-invalid", "true");
            secretInput.focus();
            return;
          }
          if (tone === "success") status.setAttribute("data-tone", "success");
          status.textContent = text;
        };

        window.addEventListener("pagehide", () => {
          secretInput.value = "";
        });

        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          if (!secretInput.value) {
            say("error", "Enter the maintenance secret.");
            return;
          }
          form.setAttribute("aria-busy", "true");
          submitButton.disabled = true;
          say("pending", "Checking operator access…");
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
              say("error", "Operator access was denied. Check the secret and try again.");
              return;
            }
            const statusResponse = await fetch("/api/maintenance/status", {
              method: "GET",
              credentials: "same-origin",
              cache: "no-store",
              redirect: "error",
            });
            if (!statusResponse.ok) throw new Error("status check failed");
            say("success", "Maintenance fence verified. Application access remains blocked.");
          } catch {
            say("error", "Operator access could not be checked. Try again.");
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
