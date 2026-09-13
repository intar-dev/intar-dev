import { env } from "cloudflare:workers";
import { createAppId } from "@/lib/id";
import type {
  ActivateTerminalTargetRequest as StargateActivateRequest,
  IssueTerminalSessionResponse as StargateApiTerminalSessionResponse,
  IssueTerminalSessionRequest as StargateCreateRequest,
  RouteMetadata as StargateRouteMetadata,
  StageTerminalTargetRequest as StargateStageRequest,
  StageTerminalTargetResponse as StargateStageResponse,
  TerminalTarget as StargateWireTerminalTarget,
  TerminalTargetState as StargateWireTargetState,
} from "@/generated/stargate";
import {
  buildTemporaryNativeSshCommand,
  temporaryNativeSshKeyFilename,
} from "@/lib/native-ssh";

const DEFAULT_ASSERTION_HEADER = "cf-access-jwt-assertion";
const DEFAULT_ROUTE_TTL_SECONDS = 4 * 60 * 60;
const DEFAULT_STARGATE_ADMIN_ORIGIN = "http://stargate.internal";
const STARGATE_ADMIN_CREATE_TIMEOUT_MS = 30_000;
const textEncoder = new TextEncoder();

interface AssertionTokenOptions {
  secret: string;
  issuer: string;
  audience: string;
  subject: string;
  ttlSeconds: number;
}

/** The four mandatory non-empty route identity fields. */
function routeMetadata(metadata: {
  hostId: string;
  runId: string;
  vmId: string;
  userId: string;
}): StargateRouteMetadata {
  return {
    host_id: metadata.hostId,
    run_id: metadata.runId,
    vm_id: metadata.vmId,
    user_id: metadata.userId,
  };
}

/** The SSH endpoint of one guest. A browser route receives this after the
 * gateway attaches the ready target; it never travels through the browser. */
export interface StargateTerminalTarget {
  username: string;
  host: string;
  port: number;
  hostKeyOpenssh: string;
  privateKeyOpenssh: string;
  authorizedClientPublicKeysOpenssh: string[];
}

/**
 * The web app works in camelCase; the wire uses the generated snake_case
 * names. The return type is the generated contract type, so a field that Rust
 * adds, renames, or removes makes this function fail to compile instead of
 * silently sending a stale body.
 */
function wireTerminalTarget(
  target: StargateTerminalTarget,
): StargateWireTerminalTarget {
  return {
    username: target.username,
    host: target.host,
    port: target.port,
    host_key_openssh: target.hostKeyOpenssh,
    private_key_openssh: target.privateKeyOpenssh,
    authorized_client_public_keys_openssh:
      target.authorizedClientPublicKeysOpenssh,
  };
}

interface IssueTerminalSessionCommonInput {
  routeUsername: string;
  /**
   * Opaque route generation. The gateway compares it as an exact string on
   * the attach call, so a revoked route can not be revived by a stale attach.
   */
  generation: string;
  expiresAt: Date;
  metadata: {
    hostId: string;
    runId: string;
    vmId: string;
    userId: string;
  };
}

/**
 * A browser route starts with no target and waits for the admin attach. A
 * native route starts with a ready target in the create call.
 */
export type IssueStargateTerminalSessionInput =
  | (IssueTerminalSessionCommonInput & { mode: "browser" })
  | (IssueTerminalSessionCommonInput & {
      mode: "native";
      target: StargateTerminalTarget;
      temporaryClientPublicKeyOpenssh?: string;
    });

export interface BrowserTerminalSessionResult {
  routeUsername: string;
  expiresAt: number;
  generation: string;
  browser: {
    websocketUrl: string;
  };
  native?: undefined;
}

export interface NativeTerminalSessionResult {
  routeUsername: string;
  expiresAt: number;
  generation: string;
  native: {
    authMode: "profile_keys" | "issued_key";
    authorizedKeyCount: number;
    host: string;
    port: number;
    username: string;
    publicHostKeyOpenssh: string;
    publicHostKeyFingerprintSha256: string;
    knownHostsLine: string;
    command: string;
    keyFilename?: string;
  };
  browser?: undefined;
}

export type StargateTerminalSessionResult =
  | BrowserTerminalSessionResult
  | NativeTerminalSessionResult;

export async function issueStargateTerminalSession(
  input: IssueStargateTerminalSessionInput,
): Promise<StargateTerminalSessionResult> {
  const generation = requiredValue(input.generation, "generation");
  const temporaryClientPublicKeyOpenssh =
    input.mode === "native"
      ? input.temporaryClientPublicKeyOpenssh?.trim()
      : undefined;
  if (
    input.mode === "native" &&
    input.temporaryClientPublicKeyOpenssh !== undefined &&
    !temporaryClientPublicKeyOpenssh
  ) {
    throw new Error("temporary native SSH public key is empty");
  }
  if (
    temporaryClientPublicKeyOpenssh &&
    input.mode === "native" &&
    input.target.authorizedClientPublicKeysOpenssh.length > 0
  ) {
    throw new Error(
      "temporary native SSH authorization cannot be combined with another route mode or profile key",
    );
  }
  const authorizedClientPublicKeysOpenssh =
    input.mode === "native" && temporaryClientPublicKeyOpenssh !== undefined
      ? [temporaryClientPublicKeyOpenssh]
      : input.mode === "native"
        ? input.target.authorizedClientPublicKeysOpenssh
        : [];
  const targetBody: StargateWireTargetState =
    input.mode === "native"
      ? {
          state: "ready",
          ...wireTerminalTarget(input.target),
          // The temporary key replaces the profile-key list for this route.
          authorized_client_public_keys_openssh:
            authorizedClientPublicKeysOpenssh,
        }
      : { state: "pending" };
  const createBody: StargateCreateRequest = {
    route_username: input.routeUsername,
    generation,
    target: targetBody,
    route_expires_at: Math.floor(input.expiresAt.getTime() / 1000),
    mode: input.mode,
    metadata: routeMetadata(input.metadata),
  };
  const response = await stargateAdminFetch("/v1/terminal-sessions", {
    method: "POST",
    signal: AbortSignal.timeout(STARGATE_ADMIN_CREATE_TIMEOUT_MS),
    headers: {
      "content-type": "application/json",
      [assertionHeader(env.STARGATE_ADMIN_AUTH_HEADER)]:
        await createAssertionToken({
          secret: requiredValue(
            env.STARGATE_ADMIN_AUTH_SECRET,
            "STARGATE_ADMIN_AUTH_SECRET",
          ),
          issuer: requiredValue(
            env.STARGATE_ADMIN_AUTH_ISSUER,
            "STARGATE_ADMIN_AUTH_ISSUER",
          ),
          audience: requiredValue(
            env.STARGATE_ADMIN_AUTH_AUDIENCE,
            "STARGATE_ADMIN_AUTH_AUDIENCE",
          ),
          subject: "intar-admin",
          ttlSeconds: 60,
        }),
    },
    body: JSON.stringify(createBody),
  });

  if (!response.ok) {
    throw new Error(
      `stargate terminal session create failed (${response.status})`,
    );
  }

  const body =
    (await response.json()) as Partial<StargateApiTerminalSessionResponse>;

  if (
    typeof body.route_username !== "string" ||
    typeof body.expires_at !== "number"
  ) {
    throw new Error("invalid stargate terminal session response");
  }

  if (input.mode === "browser") {
    if (typeof body.browser?.websocket_url !== "string") {
      throw new Error("invalid stargate browser terminal response");
    }
    return {
      routeUsername: body.route_username,
      expiresAt: body.expires_at * 1000,
      generation,
      browser: {
        websocketUrl: body.browser.websocket_url,
      },
    };
  }

  if (
    body.native?.auth_mode !== "profile_keys" ||
    typeof body.native?.authorized_key_count !== "number" ||
    typeof body.native?.ssh_host !== "string" ||
    typeof body.native?.ssh_port !== "number" ||
    typeof body.native?.username !== "string" ||
    typeof body.native?.public_host_key_openssh !== "string" ||
    typeof body.native?.public_host_key_fingerprint_sha256 !== "string" ||
    typeof body.native?.known_hosts_line !== "string" ||
    typeof body.native?.command !== "string"
  ) {
    throw new Error("invalid stargate native terminal response");
  }
  const keyFilename = temporaryClientPublicKeyOpenssh
    ? temporaryNativeSshKeyFilename(body.route_username)
    : undefined;
  const native = {
    authMode: input.temporaryClientPublicKeyOpenssh
      ? ("issued_key" as const)
      : body.native.auth_mode,
    authorizedKeyCount: body.native.authorized_key_count,
    host: body.native.ssh_host,
    port: body.native.ssh_port,
    username: body.native.username,
    publicHostKeyOpenssh: body.native.public_host_key_openssh,
    publicHostKeyFingerprintSha256:
      body.native.public_host_key_fingerprint_sha256,
    knownHostsLine: body.native.known_hosts_line,
    command: keyFilename
      ? buildTemporaryNativeSshCommand({
          username: body.native.username,
          host: body.native.ssh_host,
          port: body.native.ssh_port,
          knownHostsLine: body.native.known_hosts_line,
          keyFilename,
        })
      : body.native.command,
    ...(keyFilename ? { keyFilename } : {}),
  };
  return {
    routeUsername: body.route_username,
    expiresAt: body.expires_at * 1000,
    generation,
    native,
  };
}

/**
 * Phase one. Stores the ready target on a pending browser route and returns
 * the attachment id, but does NOT activate it: the gateway starts no PTY and
 * wakes no waiting socket until the activate call.
 *
 * The call is idempotent for one generation: a repeat stage for the same
 * ready target returns the same attachment id, so a retry after a lost
 * response is safe.
 */
export async function stageStargateTerminalTarget(input: {
  routeUsername: string;
  generation: string;
  runId: string;
  vmId: string;
  userId: string;
  target: StargateTerminalTarget;
}): Promise<{ attachmentId: string }> {
  const response = await stargateAdminFetch(
    `/v1/terminal-sessions/${encodeURIComponent(requiredValue(input.routeUsername, "routeUsername"))}/target`,
    {
      method: "POST",
      signal: AbortSignal.timeout(STARGATE_ADMIN_CREATE_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        [assertionHeader(env.STARGATE_ADMIN_AUTH_HEADER)]:
          await createAssertionToken({
            secret: requiredValue(
              env.STARGATE_ADMIN_AUTH_SECRET,
              "STARGATE_ADMIN_AUTH_SECRET",
            ),
            issuer: requiredValue(
              env.STARGATE_ADMIN_AUTH_ISSUER,
              "STARGATE_ADMIN_AUTH_ISSUER",
            ),
            audience: requiredValue(
              env.STARGATE_ADMIN_AUTH_AUDIENCE,
              "STARGATE_ADMIN_AUTH_AUDIENCE",
            ),
            subject: "intar-admin",
            ttlSeconds: 60,
          }),
      },
      body: JSON.stringify({
        run_id: input.runId,
        vm_id: input.vmId,
        user_id: input.userId,
        generation: requiredValue(input.generation, "generation"),
        // A stage carries the complete target. There is no pending shape on a
        // stage call, so the target has no `state` tag.
        target: wireTerminalTarget(input.target),
      } satisfies StargateStageRequest),
    },
  );

  // 404 and 409 are terminal for the route: it is gone, expired, or bound to
  // other metadata. Any other failure is ambiguous and reaches the caller,
  // which fails closed.
  if (!response.ok) {
    throw new StargateTerminalAttachError(response.status);
  }
  // Typed against the generated envelope so a renamed field fails to compile
  // instead of silently reading undefined.
  const body = (await response.json().catch(() => null)) as
    | Partial<StargateStageResponse>
    | null;
  const attachmentId = body?.attachment_id;
  if (typeof attachmentId !== "string" || !attachmentId) {
    // A staged target without an id can not be activated, so the caller must
    // treat this as an ambiguous failure and fail closed.
    throw new StargateTerminalAttachError(response.status);
  }
  return { attachmentId };
}

/**
 * Phase two. Activates one staged attachment. The gateway opens the PTY and
 * wakes the waiting socket only here, so a staged attachment that is never
 * activated can not produce a usable shell.
 *
 * Activation is idempotent for one generation and attachment, so a retry after
 * a lost response can not open a second shell.
 */
export async function activateStargateTerminalTarget(input: {
  routeUsername: string;
  generation: string;
  attachmentId: string;
  runId: string;
  vmId: string;
  userId: string;
}): Promise<void> {
  const response = await stargateAdminFetch(
    `/v1/terminal-sessions/${encodeURIComponent(requiredValue(input.routeUsername, "routeUsername"))}/activate`,
    {
      method: "POST",
      signal: AbortSignal.timeout(STARGATE_ADMIN_CREATE_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        [assertionHeader(env.STARGATE_ADMIN_AUTH_HEADER)]:
          await createAssertionToken({
            secret: requiredValue(
              env.STARGATE_ADMIN_AUTH_SECRET,
              "STARGATE_ADMIN_AUTH_SECRET",
            ),
            issuer: requiredValue(
              env.STARGATE_ADMIN_AUTH_ISSUER,
              "STARGATE_ADMIN_AUTH_ISSUER",
            ),
            audience: requiredValue(
              env.STARGATE_ADMIN_AUTH_AUDIENCE,
              "STARGATE_ADMIN_AUTH_AUDIENCE",
            ),
            subject: "intar-admin",
            ttlSeconds: 60,
          }),
      },
      body: JSON.stringify({
        run_id: input.runId,
        vm_id: input.vmId,
        user_id: input.userId,
        generation: requiredValue(input.generation, "generation"),
        attachment_id: requiredValue(input.attachmentId, "attachmentId"),
      } satisfies StargateActivateRequest),
    },
  );

  // Every non-success outcome is ambiguous for a call that opens a shell, so
  // it reaches the caller, which revokes this generation and fails closed.
  if (response.status === 204 || response.status === 200) {
    return;
  }
  throw new StargateTerminalAttachError(response.status);
}

export class StargateTerminalAttachError extends Error {
  constructor(readonly status: number) {
    super(`stargate terminal target attach failed (${status})`);
    this.name = "StargateTerminalAttachError";
  }
}


export async function deleteStargateTerminalRoute(
  routeUsername: string,
  generation: string,
): Promise<void> {
  const trimmed = routeUsername.trim();
  if (!trimmed) {
    return;
  }
  const routeGeneration = requiredValue(generation, "generation");

  const response = await stargateAdminFetch(
    `/v1/routes/${encodeURIComponent(trimmed)}?generation=` +
      encodeURIComponent(routeGeneration),
    {
      method: "DELETE",
      headers: {
        [assertionHeader(env.STARGATE_ADMIN_AUTH_HEADER)]:
          await createAssertionToken({
            secret: requiredValue(
              env.STARGATE_ADMIN_AUTH_SECRET,
              "STARGATE_ADMIN_AUTH_SECRET",
            ),
            issuer: requiredValue(
              env.STARGATE_ADMIN_AUTH_ISSUER,
              "STARGATE_ADMIN_AUTH_ISSUER",
            ),
            audience: requiredValue(
              env.STARGATE_ADMIN_AUTH_AUDIENCE,
              "STARGATE_ADMIN_AUTH_AUDIENCE",
            ),
            subject: "intar-admin",
            ttlSeconds: 60,
          }),
      },
    },
  );

  // 204 deleted, 404 already gone, 409 still owned by a newer generation.
  // Every other status is a real failure and must reach the caller.
  if (
    response.status === 204 ||
    response.status === 404 ||
    response.status === 409
  ) {
    return;
  }
  throw new Error(`stargate route delete failed (${response.status})`);
}

export async function deleteStargateRoute(
  routeUsername: string,
): Promise<void> {
  const trimmed = routeUsername.trim();
  if (!trimmed) {
    return;
  }

  const response = await stargateAdminFetch(
    `/v1/routes/${encodeURIComponent(trimmed)}`,
    {
      method: "DELETE",
      headers: {
        [assertionHeader(env.STARGATE_ADMIN_AUTH_HEADER)]:
          await createAssertionToken({
            secret: requiredValue(
              env.STARGATE_ADMIN_AUTH_SECRET,
              "STARGATE_ADMIN_AUTH_SECRET",
            ),
            issuer: requiredValue(
              env.STARGATE_ADMIN_AUTH_ISSUER,
              "STARGATE_ADMIN_AUTH_ISSUER",
            ),
            audience: requiredValue(
              env.STARGATE_ADMIN_AUTH_AUDIENCE,
              "STARGATE_ADMIN_AUTH_AUDIENCE",
            ),
            subject: "intar-admin",
            ttlSeconds: 60,
          }),
      },
    },
  );

  if (response.status === 404 || response.status === 204) {
    return;
  }
  if (!response.ok) {
    throw new Error(`stargate route delete failed (${response.status})`);
  }
}

export function stargateRouteTtlMs(): number {
  const raw = env.STARGATE_ROUTE_TTL_SECONDS?.trim();
  const ttlSeconds = raw ? Number.parseInt(raw, 10) : DEFAULT_ROUTE_TTL_SECONDS;
  const normalized =
    Number.isFinite(ttlSeconds) && ttlSeconds > 0
      ? ttlSeconds
      : DEFAULT_ROUTE_TTL_SECONDS;
  return normalized * 1000;
}

async function stargateAdminFetch(
  path: string,
  init: RequestInit,
): Promise<Response> {
  const binding = env.STARGATE_ADMIN_SERVICE;
  if (binding) {
    return binding.fetch(new URL(path, DEFAULT_STARGATE_ADMIN_ORIGIN), init);
  }

  const baseUrl = env.STARGATE_ADMIN_BASE_URL?.trim();
  if (baseUrl) {
    return fetch(new URL(path, requiredUrl(baseUrl)), init);
  }

  throw new Error(
    "STARGATE_ADMIN_SERVICE binding or STARGATE_ADMIN_BASE_URL is required",
  );
}

async function createAssertionToken(
  options: AssertionTokenOptions,
): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = {
    iss: options.issuer,
    aud: options.audience,
    sub: options.subject,
    iat: nowSeconds,
    nbf: nowSeconds,
    exp: nowSeconds + options.ttlSeconds,
    jti: createAppId(),
  };

  const encodedHeader = base64UrlEncode(
    textEncoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })),
  );
  const encodedPayload = base64UrlEncode(
    textEncoder.encode(JSON.stringify(payload)),
  );
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(options.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(signingInput),
  );

  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function assertionHeader(value?: string): string {
  const trimmed = value?.trim();
  return trimmed || DEFAULT_ASSERTION_HEADER;
}

function requiredValue(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${name} is required`);
  }
  return trimmed;
}

function requiredUrl(value: string | undefined): URL {
  return new URL(requiredValue(value, "stargate base url"));
}
