import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { agentBootstrapTokens, agentHosts } from "@/db/schema";
import { createAppId } from "@/lib/id";

const JWT_TTL_SECONDS = 15 * 60;
const MIN_AGENT_JWT_SECRET_BYTES = 32;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface BootstrapRequest {
  hostId: string;
  bootstrapToken: string;
}

interface JwtPayload {
  iss: string;
  aud: string;
  sub: string;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
}

export interface VerifiedAgentHost {
  hostId: string;
  userId: string;
  organizationId: string | null;
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

  const hostId = body.hostId?.trim();
  const bootstrapToken = body.bootstrapToken?.trim();
  if (!hostId || !bootstrapToken) {
    return jsonResponse(
      { error: "hostId and bootstrapToken are required" },
      400,
    );
  }

  const tokenHash = await sha256Hex(bootstrapToken);
  const db = drizzle(env.DB);

  const matches = await db
    .select({
      expiresAt: agentBootstrapTokens.expiresAt,
      revokedAt: agentBootstrapTokens.revokedAt,
      hostDisabled: agentHosts.disabled,
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
    return jsonResponse({ error: "invalid bootstrap credentials" }, 401);
  }
  if (match.hostDisabled) {
    return jsonResponse({ error: "host is disabled" }, 403);
  }

  const nowMs = Date.now();
  if (
    match.revokedAt !== null ||
    (match.expiresAt !== null && match.expiresAt <= nowMs)
  ) {
    return jsonResponse(
      { error: "bootstrap token is expired or revoked" },
      401,
    );
  }

  const issuer = env.AGENT_JWT_ISSUER ?? "intar-agent-bridge";
  const audience = env.AGENT_JWT_AUDIENCE ?? "agent-connect";
  const nowSeconds = Math.floor(nowMs / 1000);

  const payload: JwtPayload = {
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
      accessToken,
      expiresAt: new Date(payload.exp * 1000).toISOString(),
      wsUrl: wsUrl.toString(),
    },
    200,
  );
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

  const id = env.HOST_RUNTIME.idFromName(hostId);
  const stub = env.HOST_RUNTIME.get(id);

  const headers = new Headers(request.headers);
  headers.set("x-agent-host-id", hostId);

  const proxiedRequest = new Request("https://host-runtime.internal/connect", {
    method: "GET",
    headers,
  });

  return stub.fetch(proxiedRequest);
}

export async function requireVerifiedAgentRequest(
  request: Request,
  env: Cloudflare.Env,
  expectedHostId?: string,
): Promise<
  { ok: true; agent: VerifiedAgentHost } | { ok: false; response: Response }
> {
  const jwtSecret = validAgentJwtSecret(env.AGENT_JWT_SECRET);
  if (!jwtSecret) {
    return {
      ok: false,
      response: agentAuthenticationUnavailable(),
    };
  }

  const authHeader = request.headers.get("authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : "";
  if (!bearer) {
    return {
      ok: false,
      response: jsonResponse({ error: "missing bearer token" }, 401),
    };
  }

  const payload = await verifyJwt(
    bearer,
    jwtSecret,
    env.AGENT_JWT_ISSUER ?? "intar-agent-bridge",
    env.AGENT_JWT_AUDIENCE ?? "agent-connect",
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
      organizationId: agentHosts.organizationId,
      role: agentHosts.role,
      disabled: agentHosts.disabled,
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
  if (host.disabled) {
    return {
      ok: false,
      response: jsonResponse({ error: "host is disabled" }, 403),
    };
  }

  return {
    ok: true,
    agent: {
      hostId: host.id,
      userId: host.userId,
      organizationId: host.organizationId,
      role: host.role,
    },
  };
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
    typeof payload.jti !== "string"
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
