import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { agentHosts } from "@/db/schema";
import type { AgentHostRole } from "@/db/schema";
import { auth } from "@/lib/auth";
import { isAllowlisted } from "@/lib/allowlist";
import { getUserRole, isAdminRole } from "@/lib/authz";

const ONLINE_HEARTBEAT_TTL_MS = 90_000;

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
  const session = await auth.api.getSession({ headers: request.headers });
  const sessionUser = session?.user as
    | { id: string; role?: string | null; username?: string | null }
    | null;
  if (!session?.session || !sessionUser?.id) {
    return {
      ok: false,
      response: jsonResponse({ error: "unauthorized" }, { status: 401 }),
    };
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
    },
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
