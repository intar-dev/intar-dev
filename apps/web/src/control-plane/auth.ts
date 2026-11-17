import { and, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { agentBootstrapTokens, agentHosts, user } from "@/db/schema";
import { BRIDGE_PROTOCOL_VERSION_9 } from "@/generated/constants";
import { createAppId } from "@/lib/id";

/** Organization credentials belong to the organization, not the enrollment creator. */
export function organizationHostAdmissionCondition(organizationIdSql = "host.organization_id"): string {
  return `EXISTS (SELECT 1 FROM organization WHERE id = ${organizationIdSql})`;
}

// Personal credentials last only while the owner's account is active. Spelled
// out here because this module also loads outside the Worker runtime.
const hostOwnerActive = sql<number>`EXISTS (SELECT 1 FROM ${user}
  WHERE ${user.id} = ${agentHosts.userId}
    AND ${user.deletedAt} IS NULL AND coalesce(${user.banned}, 0) = 0)`;

const JWT_TTL_SECONDS = 15 * 60;
const MIN_AGENT_JWT_SECRET_BYTES = 32;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface BootstrapRequest {
  hostId: string;
  bootstrapToken: string;
}

interface JwtPayload {
  credential_generation: number;
  organization_id?: string | null;
  iss: string;
  aud: string;
  sub: string;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
}

export interface VerifiedAgentHost {
  scope: "personal" | "platform" | "organization";
  organizationId?: string | null;
  credentialGeneration: number;
  hostId: string;
  userId: string;
  role: "agent" | "builder";
}

export async function handleAgentBootstrap(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  const jwtSecret = validAgentJwtSecret(env.AGENT_JWT_SECRET);
  if (!jwtSecret) {
    return agentAuthenticationUnavailable();
  }

  let body: BootstrapRequest;
  try {
    body = (await request.json()) as BootstrapRequest;
  } catch {
    return jsonResponse({ error: "invalid json body" }, 400);
  }

  const hostId = typeof body?.hostId === "string" ? body.hostId.trim() : "";
  const bootstrapToken = typeof body?.bootstrapToken === "string" ? body.bootstrapToken.trim() : "";
  if (!hostId || !bootstrapToken) {
    return jsonResponse(
      { error: "hostId and bootstrapToken are required" },
      400,
    );
  }

  const credential = await verifyHostCredential(env, hostId, bootstrapToken);
  if (!credential.ok) return credential.response;
  const host = credential.host;
  if (!statesBridgeProtocol9(request)) return refuseOldBridgeProtocol(env, hostId, null);
  const nowMs = Date.now();

  const issuer = env.AGENT_JWT_ISSUER ?? "intar-agent-bridge";
  const audience = env.AGENT_JWT_AUDIENCE ?? "agent-connect";
  const nowSeconds = Math.floor(nowMs / 1000);

  const payload: JwtPayload = {
    credential_generation: host.credentialGeneration,
    organization_id: host.scope === "organization" ? host.organizationId ?? null : null,
    iss: issuer,
    aud: audience,
    sub: hostId,
    iat: nowSeconds,
    nbf: nowSeconds,
    exp: nowSeconds + JWT_TTL_SECONDS,
    jti: createAppId(),
  };

  const accessToken = await signJwt(payload, jwtSecret);
  const wsUrl = new URL(request.url);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.pathname = "/agent/connect";
  wsUrl.search = `hostId=${encodeURIComponent(hostId)}`;

  return jsonResponse(
    {
      hostId,
      ownerUserId: host.userId,
      ...(host.scope === "organization" ? { organizationId: host.organizationId } : {}),
      scope: host.scope,
      credentialGeneration: host.credentialGeneration,
      accessToken,
      expiresAt: new Date(payload.exp * 1000).toISOString(),
      wsUrl: wsUrl.toString(),
    },
    200,
  );
}

type HostCredentialResult =
  | { ok: true; host: VerifiedAgentHost }
  | { ok: false; response: Response };

/**
 * Checks a host's enrollment credential (C2) as the bootstrap exchange does,
 * with the same statuses and messages.
 */
export async function verifyHostCredential(
  env: Cloudflare.Env,
  hostId: string,
  credential: string,
): Promise<HostCredentialResult> {
  const refuse = (body: unknown, status: number): HostCredentialResult => ({
    ok: false,
    response: jsonResponse(body, status),
  });
  const tokenHash = await sha256Hex(credential);
  const db = drizzle(env.DB);

  const matches = await db
    .select({
      expiresAt: agentBootstrapTokens.expiresAt,
      revokedAt: agentBootstrapTokens.revokedAt,
      hostDisabled: agentHosts.disabled,
      hostUserId: agentHosts.userId,
      role: agentHosts.role,
      scope: agentHosts.scope,
      organizationId: agentHosts.organizationId,
      organizationAdmitted: sql<number>`${sql.raw(organizationHostAdmissionCondition("agent_hosts.organization_id"))}`,
      credentialGeneration: agentHosts.credentialGeneration,
      tokenCredentialGeneration: agentBootstrapTokens.credentialGeneration,
      ownerActive: hostOwnerActive,
    })
    .from(agentBootstrapTokens)
    .innerJoin(agentHosts, eq(agentHosts.id, agentBootstrapTokens.hostId))
    .where(
      and(
        eq(agentBootstrapTokens.hostId, hostId),
        eq(agentBootstrapTokens.tokenHash, tokenHash),
      ),
    )
    .orderBy(desc(agentBootstrapTokens.createdAt))
    .limit(1);

  const match = matches[0];
  if (!match) {
    return refuse({ error: "invalid bootstrap credentials" }, 401);
  }
  if (!match.scope || match.credentialGeneration < 1 ||
      match.tokenCredentialGeneration !== match.credentialGeneration) {
    return refuse({ error: "Install and register this server again" }, 401);
  }
  if (match.scope === "organization" && (!match.organizationAdmitted || match.role !== "agent")) {
    return refuse({ error: "invalid organization host" }, 403);
  }
  if (match.hostDisabled) {
    return refuse({ error: "host is disabled" }, 403);
  }
  if (match.scope === "personal" && !match.ownerActive) {
    return refuse({ error: "account access is revoked" }, 403);
  }

  const nowMs = Date.now();
  if (
    match.revokedAt !== null ||
    (match.expiresAt !== null && match.expiresAt <= nowMs)
  ) {
    return refuse(
      { error: "bootstrap token is expired or revoked" },
      401,
    );
  }

  return {
    ok: true,
    host: {
      scope: match.scope,
      organizationId: match.organizationId,
      credentialGeneration: match.credentialGeneration,
      hostId,
      userId: match.hostUserId,
      role: match.role,
    },
  };
}

export async function handleAgentConnect(
  request: Request,
  env: Cloudflare.Env,
): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return jsonResponse({ error: "expected websocket upgrade" }, 400);
  }

  const hostId = new URL(request.url).searchParams.get("hostId")?.trim() ?? "";
  if (!hostId) {
    return jsonResponse({ error: "hostId is required" }, 400);
  }

  const verified = await requireVerifiedAgentRequest(request, env, hostId);
  if (!verified.ok) {
    return verified.response;
  }
  if (!statesBridgeProtocol9(request)) return refuseOldBridgeProtocol(env, hostId, null);

  const id = env.HOST_RUNTIME.idFromName(hostId);
  const stub = env.HOST_RUNTIME.get(id);

  const headers = new Headers(request.headers);
  headers.set("x-agent-host-id", hostId);
  if (verified.agent.scope === "organization") {
    headers.set("x-agent-organization-id", verified.agent.organizationId!);
  } else {
    headers.delete("x-agent-organization-id");
  }
  headers.set("x-agent-credential-generation", String(verified.agent.credentialGeneration));

  const proxiedRequest = new Request("https://host-runtime.internal/connect", {
    method: "GET",
    headers,
  });

  return stub.fetch(proxiedRequest);
}

/** The header a bridge client states its protocol in. */
export const BRIDGE_PROTOCOL_HEADER = "intar-bridge-protocol";
/** Close code of a bridge socket whose hello states another protocol. */
export const CLOSE_UPGRADE_REQUIRED = 4426;
const MAX_REFUSED_AGENT_VERSION_LENGTH = 64;

function statesBridgeProtocol9(request: Request): boolean {
  return request.headers.get(BRIDGE_PROTOCOL_HEADER)?.trim() === String(BRIDGE_PROTOCOL_VERSION_9);
}

/**
 * Records on the host that its agent was refused as too old, so My servers
 * can say so. Only an authenticated host's own row is written.
 */
export async function recordBridgeProtocolRefusal(
  env: Cloudflare.Env,
  hostId: string,
  agentVersion: string | null,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE agent_hosts SET last_refusal_code = 'upgrade_required', last_refusal_at = ?2,
       last_refused_agent_version = ?3 WHERE id = ?1`,
  ).bind(hostId, Date.now(), agentVersion?.slice(0, MAX_REFUSED_AGENT_VERSION_LENGTH) ?? null).run();
}

/** 426: the clients wait for an upgrade on this status alone. */
async function refuseOldBridgeProtocol(
  env: Cloudflare.Env,
  hostId: string,
  agentVersion: string | null,
): Promise<Response> {
  await recordBridgeProtocolRefusal(env, hostId, agentVersion);
  return jsonResponse({
    error: `bridge protocol ${BRIDGE_PROTOCOL_VERSION_9} is required; update the agent`,
    code: "upgrade_required",
    protocol_version: BRIDGE_PROTOCOL_VERSION_9,
  }, 426);
}

export type VerifiedAgentToken =
  | { ok: true; agent: VerifiedAgentHost; expiresAt: number }
  | { ok: false; response: Response };

export async function requireVerifiedAgentRequest(
  request: Request,
  env: Cloudflare.Env,
  expectedHostId?: string,
): Promise<
  { ok: true; agent: VerifiedAgentHost } | { ok: false; response: Response }
> {
  const authHeader = request.headers.get("authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : "";
  if (!bearer && validAgentJwtSecret(env.AGENT_JWT_SECRET)) {
    return {
      ok: false,
      response: jsonResponse({ error: "missing bearer token" }, 401),
    };
  }
  return verifyAgentToken(env, bearer, {
    audience: env.AGENT_JWT_AUDIENCE ?? "agent-connect",
    expectedHostId,
  });
}

/**
 * Verifies an agent JWT for one audience and re-reads its host, so a
 * credential rotation, a disabled host or a revoked owner fails at once.
 */
export async function verifyAgentToken(
  env: Cloudflare.Env,
  token: string,
  options: { audience: string; expectedHostId?: string | undefined },
): Promise<VerifiedAgentToken> {
  const jwtSecret = validAgentJwtSecret(env.AGENT_JWT_SECRET);
  if (!jwtSecret) {
    return {
      ok: false,
      response: agentAuthenticationUnavailable(),
    };
  }
  const expectedHostId = options.expectedHostId;

  const payload = await verifyJwt(
    token,
    jwtSecret,
    env.AGENT_JWT_ISSUER ?? "intar-agent-bridge",
    options.audience,
  );
  if (!payload) {
    return {
      ok: false,
      response: jsonResponse({ error: "invalid token" }, 401),
    };
  }

  const hostId = payload.sub.trim();
  if (!hostId || (expectedHostId && expectedHostId !== hostId)) {
    return {
      ok: false,
      response: jsonResponse({ error: "invalid token" }, 401),
    };
  }

  const db = drizzle(env.DB);
  const hosts = await db
    .select({
      id: agentHosts.id,
      userId: agentHosts.userId,
      scope: agentHosts.scope,
      organizationId: agentHosts.organizationId,
      organizationAdmitted: sql<number>`${sql.raw(organizationHostAdmissionCondition("agent_hosts.organization_id"))}`,
      credentialGeneration: agentHosts.credentialGeneration,
      role: agentHosts.role,
      disabled: agentHosts.disabled,
      ownerActive: hostOwnerActive,
    })
    .from(agentHosts)
    .where(eq(agentHosts.id, hostId))
    .limit(1);

  const host = hosts[0];
  if (!host) {
    return {
      ok: false,
      response: jsonResponse({ error: "host not found" }, 404),
    };
  }
  if (!host.scope || host.credentialGeneration < 1 || payload.credential_generation !== host.credentialGeneration) {
    return { ok: false, response: jsonResponse({ error: "Server credentials are no longer valid" }, 401) };
  }
  if (host.scope === "organization" && (!host.organizationAdmitted || host.role !== "agent" || payload.organization_id !== host.organizationId)) {
    return { ok: false, response: jsonResponse({ error: "invalid organization host" }, 403) };
  }
  if (host.scope !== "organization" && payload.organization_id != null) {
    return { ok: false, response: jsonResponse({ error: "invalid token" }, 401) };
  }
  if (host.disabled) {
    return {
      ok: false,
      response: jsonResponse({ error: "host is disabled" }, 403),
    };
  }
  if (host.scope === "personal" && !host.ownerActive) {
    return {
      ok: false,
      response: jsonResponse({ error: "account access is revoked" }, 403),
    };
  }

  return {
    ok: true,
    agent: {
      scope: host.scope,
      organizationId: host.organizationId,
      credentialGeneration: host.credentialGeneration,
      hostId: host.id,
      userId: host.userId,
      role: host.role,
    },
    expiresAt: payload.exp,
  };
}

/** Audience of the tokens `/v2` accepts; no other surface accepts it. */
export const REGISTRY_TOKEN_AUDIENCE = "intar-registry";

/**
 * Mints a registry token for a verified agent host. It never outlives
 * `notAfter`, so exchanging a JWT never extends its lifetime. Null when the
 * secret is unusable or the bridge audience is the registry's.
 */
export async function mintRegistryToken(
  env: Cloudflare.Env,
  agent: VerifiedAgentHost,
  notAfter?: number,
): Promise<{ token: string; issuedAt: number; expiresAt: number } | null> {
  const jwtSecret = validAgentJwtSecret(env.AGENT_JWT_SECRET);
  if (!jwtSecret || String(env.AGENT_JWT_AUDIENCE ?? "agent-connect") === REGISTRY_TOKEN_AUDIENCE) {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  const exp = Math.min(now + JWT_TTL_SECONDS, notAfter ?? Number.MAX_SAFE_INTEGER);
  const token = await signJwt({
    credential_generation: agent.credentialGeneration,
    organization_id: agent.scope === "organization" ? agent.organizationId ?? null : null,
    iss: env.AGENT_JWT_ISSUER ?? "intar-agent-bridge",
    aud: REGISTRY_TOKEN_AUDIENCE,
    sub: agent.hostId,
    iat: now,
    nbf: now,
    exp,
    jti: createAppId(),
  }, jwtSecret);
  return { token, issuedAt: now, expiresAt: exp };
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function signJwt(payload: JwtPayload, secret: string): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64UrlEncode(
    textEncoder.encode(JSON.stringify(header)),
  );
  const encodedPayload = base64UrlEncode(
    textEncoder.encode(JSON.stringify(payload)),
  );
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(signingInput),
  );

  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function verifyJwt(
  token: string,
  secret: string,
  expectedIssuer: string,
  expectedAudience: string,
): Promise<JwtPayload | null> {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) return null;

  const headerBytes = base64UrlDecode(encodedHeader);
  const payloadBytes = base64UrlDecode(encodedPayload);
  const signatureBytes = base64UrlDecode(encodedSignature);
  if (!headerBytes || !payloadBytes || !signatureBytes) return null;

  let header: { alg?: string; typ?: string };
  let payload: Partial<JwtPayload>;
  try {
    header = JSON.parse(textDecoder.decode(headerBytes)) as {
      alg?: string;
      typ?: string;
    };
    payload = JSON.parse(
      textDecoder.decode(payloadBytes),
    ) as Partial<JwtPayload>;
  } catch {
    return null;
  }

  if (header.alg !== "HS256" || header.typ !== "JWT") return null;

  const key = await importHmacKey(secret);
  const expectedSignature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      textEncoder.encode(`${encodedHeader}.${encodedPayload}`),
    ),
  );
  if (!timingSafeEqual(expectedSignature, signatureBytes)) return null;

  if (
    typeof payload.iss !== "string" ||
    typeof payload.aud !== "string" ||
    typeof payload.sub !== "string" ||
    typeof payload.iat !== "number" ||
    typeof payload.nbf !== "number" ||
    typeof payload.exp !== "number" ||
    typeof payload.jti !== "string" ||
    !Number.isSafeInteger(payload.credential_generation) ||
    (payload.credential_generation ?? 0) < 1
  ) {
    return null;
  }

  if (payload.iss !== expectedIssuer || payload.aud !== expectedAudience) {
    return null;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (payload.nbf > nowSeconds || payload.exp <= nowSeconds) {
    return null;
  }

  return payload as JwtPayload;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function validAgentJwtSecret(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const secret = value.trim();
  if (textEncoder.encode(secret).byteLength < MIN_AGENT_JWT_SECRET_BYTES) {
    return null;
  }

  return secret;
}

function agentAuthenticationUnavailable(): Response {
  return jsonResponse({ error: "agent authentication unavailable" }, 500);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a[i]! ^ b[i]!;
  }
  return mismatch === 0;
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

function base64UrlDecode(value: string): Uint8Array | null {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const remainder = normalized.length % 4;
  const padded = normalized + (remainder ? "=".repeat(4 - remainder) : "");

  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}
