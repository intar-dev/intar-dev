import { env } from "cloudflare:workers";
import { createAppId } from "@/lib/id";
import type {
  IssueTerminalSessionResponse as StargateApiTerminalSessionResponse,
  IssueWorkspaceAppSessionResponse as StargateApiWorkspaceAppSessionResponse,
} from "@/generated/stargate";

const DEFAULT_ASSERTION_HEADER = "cf-access-jwt-assertion";
const DEFAULT_ROUTE_TTL_SECONDS = 4 * 60 * 60;
const DEFAULT_STARGATE_ADMIN_ORIGIN = "http://stargate.internal";
const STARGATE_ADMIN_CREATE_TIMEOUT_MS = 30_000;
const WORKSPACE_APP_BOOTSTRAP_QUERY_PARAMETER = "__intar_bootstrap";
const textEncoder = new TextEncoder();

interface AssertionTokenOptions {
  secret: string;
  issuer: string;
  audience: string;
  subject: string;
  ttlSeconds: number;
}

export type StargateTerminalSessionMode = "browser" | "native";

export interface IssueStargateTerminalSessionInput {
  routeUsername: string;
  targetUsername: string;
  targetHost: string;
  targetPort: number;
  targetHostKeyOpenssh: string;
  targetPrivateKeyOpenssh: string;
  expiresAt: Date;
  mode: StargateTerminalSessionMode;
  authorizedClientPublicKeysOpenssh?: string[];
  metadata: {
    hostId: string;
    runId: string;
    vmId: string;
    userId: string;
  };
}

export interface BrowserTerminalSessionResult {
  routeUsername: string;
  expiresAt: number;
  browser: {
    websocketUrl: string;
  };
  native?: undefined;
}

export interface NativeTerminalSessionResult {
  routeUsername: string;
  expiresAt: number;
  native: {
    authMode: "profile_keys";
    authorizedKeyCount: number;
    host: string;
    port: number;
    username: string;
    publicHostKeyOpenssh: string;
    publicHostKeyFingerprintSha256: string;
    knownHostsLine: string;
    command: string;
  };
  browser?: undefined;
}

export type StargateTerminalSessionResult =
  | BrowserTerminalSessionResult
  | NativeTerminalSessionResult;

export interface IssueStargateWorkspaceAppSessionInput {
  routeId: string;
  targetUsername: string;
  targetHost: string;
  targetSshPort: number;
  targetHostKeyOpenssh: string;
  targetPrivateKeyOpenssh: string;
  targetAppPort: number;
  expiresAt: Date;
  metadata: {
    hostId: string;
    runId: string;
    vmId: string;
    userId: string;
  };
}

export interface StargateWorkspaceAppSessionResult {
  routeId: string;
  url: string;
  bootstrapExpiresAt: number;
  expiresAt: number;
}

export async function issueStargateTerminalSession(
  input: IssueStargateTerminalSessionInput,
): Promise<StargateTerminalSessionResult> {
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
    body: JSON.stringify({
      route_username: input.routeUsername,
      target_username: input.targetUsername,
      target_ip: input.targetHost,
      target_port: input.targetPort,
      target_host_key_openssh: input.targetHostKeyOpenssh,
      target_private_key_openssh: input.targetPrivateKeyOpenssh,
      authorized_client_public_keys_openssh:
        input.authorizedClientPublicKeysOpenssh ?? [],
      route_expires_at: Math.floor(input.expiresAt.getTime() / 1000),
      mode: input.mode,
      metadata: {
        host_id: input.metadata.hostId,
        run_id: input.metadata.runId,
        vm_id: input.metadata.vmId,
        user_id: input.metadata.userId,
      },
    }),
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
  return {
    routeUsername: body.route_username,
    expiresAt: body.expires_at * 1000,
    native: {
      authMode: body.native.auth_mode,
      authorizedKeyCount: body.native.authorized_key_count,
      host: body.native.ssh_host,
      port: body.native.ssh_port,
      username: body.native.username,
      publicHostKeyOpenssh: body.native.public_host_key_openssh,
      publicHostKeyFingerprintSha256:
        body.native.public_host_key_fingerprint_sha256,
      knownHostsLine: body.native.known_hosts_line,
      command: body.native.command,
    },
  };
}

export async function issueStargateWorkspaceAppSession(
  input: IssueStargateWorkspaceAppSessionInput,
): Promise<StargateWorkspaceAppSessionResult> {
  const response = await stargateAdminFetch("/v1/workspace-app-sessions", {
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
      route_id: input.routeId,
      target_username: input.targetUsername,
      target_ip: input.targetHost,
      target_ssh_port: input.targetSshPort,
      target_host_key_openssh: input.targetHostKeyOpenssh,
      target_private_key_openssh: input.targetPrivateKeyOpenssh,
      target_app_port: input.targetAppPort,
      protocol: "http",
      route_expires_at: Math.floor(input.expiresAt.getTime() / 1000),
      metadata: {
        host_id: input.metadata.hostId,
        run_id: input.metadata.runId,
        vm_id: input.metadata.vmId,
        user_id: input.metadata.userId,
      },
    }),
  });
  if (!response.ok) {
    throw new Error(
      `stargate workspace application create failed (${response.status})`,
    );
  }
  return parseStargateWorkspaceAppSessionResponse(await response.json());
}

export function parseStargateWorkspaceAppSessionResponse(
  value: unknown,
): StargateWorkspaceAppSessionResult {
  const body = value as Partial<StargateApiWorkspaceAppSessionResponse> | null;
  if (
    !body ||
    typeof body.route_id !== "string" ||
    typeof body.url !== "string" ||
    typeof body.bootstrap_expires_at !== "number" ||
    typeof body.expires_at !== "number" ||
    body.bootstrap_expires_at > body.expires_at
  ) {
    throw new Error("invalid stargate workspace application response");
  }
  let bootstrapUrl: URL;
  try {
    bootstrapUrl = new URL(body.url);
  } catch {
    throw new Error("invalid stargate workspace application response");
  }
  if (
    (bootstrapUrl.protocol !== "http:" && bootstrapUrl.protocol !== "https:") ||
    bootstrapUrl.username ||
    bootstrapUrl.password ||
    !bootstrapUrl.searchParams.get(WORKSPACE_APP_BOOTSTRAP_QUERY_PARAMETER)
  ) {
    throw new Error("invalid stargate workspace application response");
  }
  return {
    routeId: body.route_id,
    url: body.url,
    bootstrapExpiresAt: body.bootstrap_expires_at * 1000,
    expiresAt: body.expires_at * 1000,
  };
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

export async function deleteStargateWorkspaceAppRoute(
  routeId: string,
): Promise<void> {
  const trimmed = routeId.trim();
  if (!trimmed) return;
  const response = await stargateAdminFetch(
    `/v1/workspace-app-routes/${encodeURIComponent(trimmed)}`,
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
  if (response.status === 404 || response.status === 204) return;
  if (!response.ok) {
    throw new Error(
      `stargate workspace application delete failed (${response.status})`,
    );
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
