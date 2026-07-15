import { env } from "cloudflare:workers";
import { and, eq, gte, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { accessAllowlist, agentHosts, scenarioRuns, user } from "@/db/schema";
import type { AgentHostRole } from "@/db/schema";
import { auth } from "@/lib/auth";
import { isAllowlisted } from "@/lib/allowlist";
import { getUserRole, isAdminRole } from "@/lib/authz";

const ONLINE_HEARTBEAT_TTL_MS = 90_000;
const BOOT_BENCHMARK_SCENARIO_ID = "broken-nginx";
const BOOT_BENCHMARK_AUTH_SCHEME = "BootBenchmark";
const SAFE_PATH_SEGMENT_RE = /^[A-Za-z0-9._-]{1,128}$/;
const RUN_ROUTE_RE =
  /^\/api\/scenarios\/runs\/([A-Za-z0-9._-]{1,128})(?:\/(destroy|ssh))?$/;
const UNIX_MS_RE = /^(?:0|[1-9][0-9]{0,15})$/;
const MAX_BOOT_BENCHMARK_CREDENTIAL_TTL_MS = 3 * 60 * 60 * 1_000;
const MAX_BOOT_BENCHMARK_RUNS = 35;
const textEncoder = new TextEncoder();

export interface BootBenchmarkAuthBindings {
  DB: D1Database;
  INTAR_BOOT_BENCH_TOKEN?: string;
  INTAR_BOOT_BENCH_USER_ID?: string;
  INTAR_BOOT_BENCH_HOST_ID?: string;
  INTAR_BOOT_BENCH_NOT_BEFORE_UNIX_MS?: string;
  INTAR_BOOT_BENCH_EXPIRES_AT_UNIX_MS?: string;
}

export type UserAuthentication =
  | {
      method: "session";
      purpose: "interactive";
    }
  | {
      method: "boot_benchmark";
      purpose: "broken_nginx_boot_benchmark";
      hostId: string;
      notBeforeUnixMs: number;
      expiresAtUnixMs: number;
    };

export interface AgentBridgeStatus {
  hostId: string;
  connected: boolean;
  lastHeartbeatAt: string | null;
  agentVersion: string | null;
  activeSessionId: string | null;
  inventoryVmCount: number;
}

export interface AgentInventorySnapshot {
  generatedAt?: number | null;
  generation?: string | null;
  vms?: unknown[];
}

export interface AgentHostRow {
  id: string;
  user_id: string;
  name: string;
  role: AgentHostRole;
  disabled: boolean;
  scenario_enabled: boolean;
  connected: boolean;
  connected_at: number | null;
  disconnected_at: number | null;
  last_heartbeat_at: number | null;
  last_inventory_at: number | null;
  active_session_id: string | null;
  agent_version: string | null;
  inventory_json: string | null;
  created_at: number;
  updated_at: number;
}

export interface UserContext {
  userId: string;
  role: string | null;
  isAdmin: boolean;
  authentication: UserAuthentication;
}

type AuthzResult =
  | { ok: true; context: UserContext }
  | { ok: false; response: Response };

export const jsonResponse = (body: unknown, init?: ResponseInit) => {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json; charset=utf-8");
  }

  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
};

export function resolveRequestOrigin(request: Request): string {
  const directUrl = safeOriginFromUrl(request.url);
  if (directUrl) return directUrl;

  const originHeader = request.headers.get("origin");
  const origin = safeOriginFromUrl(originHeader);
  if (origin) return origin;

  const refererHeader = request.headers.get("referer");
  const referer = safeOriginFromUrl(refererHeader);
  if (referer) return referer;

  const forwarded = parseForwardedOrigin(request.headers.get("forwarded"));
  if (forwarded) return forwarded;

  const forwardedHost = extractForwardedHost(
    request.headers.get("x-forwarded-host") ?? request.headers.get("host"),
  );
  if (!forwardedHost) {
    throw new Error("unable to resolve request origin");
  }

  const forwardedProto =
    request.headers.get("x-forwarded-proto") ??
    parseCfVisitorScheme(request.headers.get("cf-visitor")) ??
    "https";

  const fallbackOrigin = safeOriginFromUrl(
    `${forwardedProto}://${forwardedHost}`,
  );
  if (fallbackOrigin) return fallbackOrigin;

  throw new Error("unable to resolve request origin");
}

export async function requireUserContext(
  request: Request,
): Promise<AuthzResult> {
  if (
    isBootBenchmarkAuthorizationAttempt(request.headers.get("authorization"))
  ) {
    return requireBootBenchmarkUserContext(request);
  }

  const session = await auth.api.getSession({ headers: request.headers });
  const sessionUser = session?.user as {
    id: string;
    role?: string | null;
    username?: string | null;
  } | null;
  if (!session?.session || !sessionUser?.id) {
    return requireBootBenchmarkUserContext(request);
  }

  if (!(await isAllowlisted(sessionUser.username))) {
    return {
      ok: false,
      response: jsonResponse({ error: "access revoked" }, { status: 403 }),
    };
  }

  const role = getUserRole(sessionUser);

  return {
    ok: true,
    context: {
      userId: sessionUser.id,
      role,
      isAdmin: isAdminRole(role),
      authentication: {
        method: "session",
        purpose: "interactive",
      },
    },
  };
}

/**
 * Authorizes the short-lived, host-bound operator credential used only by the
 * production broken-nginx boot benchmark. Every binding is required to enable
 * this path; absent, malformed, or expired configuration fails closed.
 */
export async function requireBootBenchmarkUserContext(
  request: Request,
  bindings: BootBenchmarkAuthBindings = env,
  nowUnixMs = Date.now(),
): Promise<AuthzResult> {
  const configuredToken = bindings.INTAR_BOOT_BENCH_TOKEN ?? "";
  const suppliedToken = parseBootBenchmarkAuthorization(
    request.headers.get("authorization"),
  );
  const tokenMatches = await constantTimeSecretEqual(
    configuredToken,
    suppliedToken,
  );
  const config = parseBootBenchmarkConfig(bindings, nowUnixMs);
  if (!tokenMatches || !config) return unauthorizedResponse();

  const route = parseBootBenchmarkRoute(request, config.hostId);
  if (!route) return unauthorizedResponse();

  const db = drizzle(bindings.DB);
  let operator: {
    id: string;
    role: string | null;
    banned: boolean | null;
  } | null = null;
  let inWindowRunCount = 0;

  if (route.kind === "run") {
    const rows = await db
      .select({
        id: user.id,
        role: user.role,
        banned: user.banned,
      })
      .from(user)
      .innerJoin(
        accessAllowlist,
        eq(accessAllowlist.githubUsername, user.username),
      )
      .innerJoin(
        scenarioRuns,
        and(
          eq(scenarioRuns.runId, route.runId),
          eq(scenarioRuns.userId, user.id),
          eq(scenarioRuns.hostId, config.hostId),
          eq(scenarioRuns.scenarioId, BOOT_BENCHMARK_SCENARIO_ID),
          gte(scenarioRuns.createdAt, config.notBeforeUnixMs),
          lt(scenarioRuns.createdAt, config.expiresAtUnixMs),
        ),
      )
      .where(eq(user.id, config.userId))
      .limit(1);
    operator = rows[0] ?? null;
  } else if (route.kind === "start") {
    // A left join preserves the operator row when the credential has not
    // started a run yet. Limiting to 35 matching rows is sufficient to decide
    // admission and avoids a second count query or an unbounded result set.
    const rows = await db
      .select({
        id: user.id,
        role: user.role,
        banned: user.banned,
        runId: scenarioRuns.runId,
      })
      .from(user)
      .innerJoin(
        accessAllowlist,
        eq(accessAllowlist.githubUsername, user.username),
      )
      .leftJoin(
        scenarioRuns,
        and(
          eq(scenarioRuns.userId, user.id),
          eq(scenarioRuns.hostId, config.hostId),
          eq(scenarioRuns.scenarioId, BOOT_BENCHMARK_SCENARIO_ID),
          gte(scenarioRuns.createdAt, config.notBeforeUnixMs),
          lt(scenarioRuns.createdAt, config.expiresAtUnixMs),
        ),
      )
      .where(eq(user.id, config.userId))
      .limit(MAX_BOOT_BENCHMARK_RUNS);
    const first = rows[0];
    operator = first
      ? { id: first.id, role: first.role, banned: first.banned }
      : null;
    inWindowRunCount = rows.reduce(
      (total, row) => total + (row.runId === null ? 0 : 1),
      0,
    );
  } else {
    const rows = await db
      .select({
        id: user.id,
        role: user.role,
        banned: user.banned,
      })
      .from(user)
      .innerJoin(
        accessAllowlist,
        eq(accessAllowlist.githubUsername, user.username),
      )
      .where(eq(user.id, config.userId))
      .limit(1);
    operator = rows[0] ?? null;
  }

  const role = getUserRole(operator);
  if (!operator || Boolean(operator.banned) || !isAdminRole(role)) {
    return unauthorizedResponse();
  }

  if (route.kind === "start" && inWindowRunCount >= MAX_BOOT_BENCHMARK_RUNS) {
    return unauthorizedResponse();
  }

  return {
    ok: true,
    context: {
      userId: operator.id,
      role,
      isAdmin: true,
      authentication: {
        method: "boot_benchmark",
        purpose: "broken_nginx_boot_benchmark",
        hostId: config.hostId,
        notBeforeUnixMs: config.notBeforeUnixMs,
        expiresAtUnixMs: config.expiresAtUnixMs,
      },
    },
  };
}

interface BootBenchmarkConfig {
  userId: string;
  hostId: string;
  notBeforeUnixMs: number;
  expiresAtUnixMs: number;
}

type BootBenchmarkRoute =
  | { kind: "host" | "scenario" | "start" }
  | { kind: "run"; runId: string };

function parseBootBenchmarkConfig(
  bindings: BootBenchmarkAuthBindings,
  nowUnixMs: number,
): BootBenchmarkConfig | null {
  const token = exactNonEmptyBinding(bindings.INTAR_BOOT_BENCH_TOKEN);
  const userId = exactNonEmptyBinding(bindings.INTAR_BOOT_BENCH_USER_ID);
  const hostId = exactSafePathSegment(bindings.INTAR_BOOT_BENCH_HOST_ID);
  const rawNotBefore = exactNonEmptyBinding(
    bindings.INTAR_BOOT_BENCH_NOT_BEFORE_UNIX_MS,
  );
  const rawExpiresAt = exactNonEmptyBinding(
    bindings.INTAR_BOOT_BENCH_EXPIRES_AT_UNIX_MS,
  );
  if (!token || !userId || !hostId || !rawNotBefore || !rawExpiresAt) {
    return null;
  }
  if (textEncoder.encode(token).byteLength < 32) return null;
  if (!UNIX_MS_RE.test(rawNotBefore) || !UNIX_MS_RE.test(rawExpiresAt)) {
    return null;
  }

  const notBeforeUnixMs = Number(rawNotBefore);
  const expiresAtUnixMs = Number(rawExpiresAt);
  if (
    !Number.isSafeInteger(notBeforeUnixMs) ||
    !Number.isSafeInteger(expiresAtUnixMs) ||
    !Number.isSafeInteger(nowUnixMs) ||
    notBeforeUnixMs > nowUnixMs ||
    expiresAtUnixMs <= nowUnixMs ||
    expiresAtUnixMs <= notBeforeUnixMs ||
    expiresAtUnixMs - notBeforeUnixMs > MAX_BOOT_BENCHMARK_CREDENTIAL_TTL_MS
  ) {
    return null;
  }
  return { userId, hostId, notBeforeUnixMs, expiresAtUnixMs };
}

function parseBootBenchmarkRoute(
  request: Request,
  configuredHostId: string,
): BootBenchmarkRoute | null {
  const url = new URL(request.url);
  if (url.search || url.hash) return null;

  if (
    request.method === "GET" &&
    url.pathname === `/api/agent/hosts/${configuredHostId}`
  ) {
    return { kind: "host" };
  }
  if (
    request.method === "GET" &&
    url.pathname === `/api/scenarios/${BOOT_BENCHMARK_SCENARIO_ID}`
  ) {
    return { kind: "scenario" };
  }
  if (
    request.method === "POST" &&
    url.pathname === `/api/scenarios/${BOOT_BENCHMARK_SCENARIO_ID}/start`
  ) {
    return { kind: "start" };
  }

  const runMatch = RUN_ROUTE_RE.exec(url.pathname);
  if (!runMatch) return null;
  const runId = exactSafePathSegment(runMatch[1]);
  if (!runId) return null;
  const operation = runMatch[2] ?? null;
  if (
    (operation === null && request.method !== "GET") ||
    (operation !== null && request.method !== "POST")
  ) {
    return null;
  }
  return { kind: "run", runId };
}

function parseBootBenchmarkAuthorization(header: string | null): string {
  if (!header) return "";
  const prefix = `${BOOT_BENCHMARK_AUTH_SCHEME} `;
  if (!header.startsWith(prefix)) return "";
  const token = header.slice(prefix.length);
  return token && !/\s/.test(token) ? token : "";
}

function isBootBenchmarkAuthorizationAttempt(header: string | null): boolean {
  return header !== null && /^\s*BootBenchmark(?:\s|$)/i.test(header);
}

function exactNonEmptyBinding(value: string | undefined): string | null {
  if (!value || value !== value.trim()) return null;
  return value;
}

function exactSafePathSegment(value: string | undefined): string | null {
  const candidate = exactNonEmptyBinding(value);
  if (
    !candidate ||
    candidate === "." ||
    candidate === ".." ||
    !SAFE_PATH_SEGMENT_RE.test(candidate)
  ) {
    return null;
  }
  return candidate;
}

async function constantTimeSecretEqual(
  expected: string,
  actual: string,
): Promise<boolean> {
  const [expectedHash, actualHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", textEncoder.encode(expected)),
    crypto.subtle.digest("SHA-256", textEncoder.encode(actual)),
  ]);
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (
      left: ArrayBuffer | ArrayBufferView,
      right: ArrayBuffer | ArrayBufferView,
    ) => boolean;
  };
  if (typeof subtle.timingSafeEqual === "function") {
    return subtle.timingSafeEqual(expectedHash, actualHash);
  }

  // Both inputs are fixed-size SHA-256 digests, preserving constant work in
  // runtimes whose Web Crypto implementation does not expose timingSafeEqual.
  const left = new Uint8Array(expectedHash);
  const right = new Uint8Array(actualHash);
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left[index]! ^ right[index]!;
  }
  return mismatch === 0;
}

function unauthorizedResponse(): AuthzResult {
  return {
    ok: false,
    response: jsonResponse({ error: "unauthorized" }, { status: 401 }),
  };
}

export async function requireAdminUserContext(
  request: Request,
): Promise<AuthzResult> {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz;

  if (!authz.context.isAdmin) {
    return {
      ok: false,
      response: jsonResponse({ error: "admin required" }, { status: 403 }),
    };
  }

  return authz;
}

export async function loadHostForUser(
  hostId: string,
  userId: string,
): Promise<AgentHostRow | null> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      id: agentHosts.id,
      user_id: agentHosts.userId,
      name: agentHosts.name,
      role: agentHosts.role,
      disabled: agentHosts.disabled,
      scenario_enabled: agentHosts.scenarioEnabled,
      connected: agentHosts.connected,
      connected_at: agentHosts.connectedAt,
      disconnected_at: agentHosts.disconnectedAt,
      last_heartbeat_at: agentHosts.lastHeartbeatAt,
      last_inventory_at: agentHosts.lastInventoryAt,
      active_session_id: agentHosts.activeSessionId,
      agent_version: agentHosts.agentVersion,
      inventory_json: agentHosts.inventoryJson,
      created_at: agentHosts.createdAt,
      updated_at: agentHosts.updatedAt,
    })
    .from(agentHosts)
    .where(and(eq(agentHosts.id, hostId), eq(agentHosts.userId, userId)))
    .limit(1);

  return rows[0] ?? null;
}

export function parseInventory(
  inventoryJson: string | null,
): AgentInventorySnapshot | null {
  return parseJsonObject(inventoryJson) as AgentInventorySnapshot | null;
}

export function buildStoredBridgeStatus(host: AgentHostRow): AgentBridgeStatus {
  const inventory = parseInventory(host.inventory_json);
  const nowMs = Date.now();
  const heartbeatFresh =
    typeof host.last_heartbeat_at === "number" &&
    host.last_heartbeat_at + ONLINE_HEARTBEAT_TTL_MS >= nowMs;

  const connected = Boolean(host.connected) && heartbeatFresh;

  return {
    hostId: host.id,
    connected,
    lastHeartbeatAt:
      typeof host.last_heartbeat_at === "number"
        ? new Date(host.last_heartbeat_at).toISOString()
        : null,
    agentVersion: host.agent_version,
    activeSessionId: host.active_session_id,
    inventoryVmCount: Array.isArray(inventory?.vms) ? inventory.vms.length : 0,
  };
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function safeOriginFromUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function parseCfVisitorScheme(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { scheme?: unknown };
    return typeof parsed.scheme === "string" && parsed.scheme
      ? parsed.scheme
      : null;
  } catch {
    return null;
  }
}

function extractForwardedHost(value: string | null): string | null {
  if (!value) return null;

  const first = value
    .split(",")
    .map((part) => part.trim())
    .find(Boolean);

  return first || null;
}

function parseForwardedOrigin(value: string | null): string | null {
  if (!value) return null;

  const first = value
    .split(",")
    .map((part) => part.trim())
    .find(Boolean);
  if (!first) return null;

  let proto: string | null = null;
  let host: string | null = null;

  for (const segment of first.split(";")) {
    const [rawKey, rawValue] = segment.split("=", 2);
    if (!rawKey || !rawValue) continue;

    const key = rawKey.trim().toLowerCase();
    const value = rawValue.trim().replace(/^"|"$/g, "");
    if (!value) continue;

    if (key === "proto") proto = value;
    if (key === "host") host = value;
  }

  if (!host) return null;
  return safeOriginFromUrl(`${proto ?? "https"}://${host}`);
}
