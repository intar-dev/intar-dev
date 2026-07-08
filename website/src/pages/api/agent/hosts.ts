import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { and, desc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  agentBootstrapTokens,
  agentHosts,
  hostActualState,
  scenarioRuns,
} from "@/db/schema";
import type { HostStateReportV1 } from "@/generated/bridge";
import { releaseBuildAssignmentsForHostRoleChange } from "@/lib/build-scheduler";
import {
  clearDesiredCachedImages,
  clearDesiredVms,
} from "@/lib/desired-state";
import { mutateStoredHostDesiredState } from "@/lib/desired-state-store";
import {
  buildStoredBridgeStatus,
  jsonResponse,
  loadHostForUser,
  parseInventory,
  requireAdminUserContext,
  resolveRequestOrigin,
  type AgentHostRow,
} from "@/lib/agent-bridge";
import { createAppId, createShortAppId } from "@/lib/id";
import {
  bridgeSessionResetForHostRoleChange,
  resolveRequestedHostRole,
} from "@/lib/scenario-hosts";
import { tryWakeHostRuntime } from "@/lib/host-runtime-wake";
import { hostHealth, type HostHealth } from "@/lib/host-health";

const BOOTSTRAP_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const HOST_ID_REGEX = /^[A-Za-z0-9_-]+$/;
type AppDb = Parameters<typeof mutateStoredHostDesiredState>[0];

interface CreateHostBody {
  name?: string;
  hostId?: string;
  role?: string;
}

interface HostActualStateSummary {
  appliedDesiredVersion: number;
  observedAt: number;
  health: HostHealth;
  capacity: HostStateReportV1["capacity"];
  capabilities: HostStateReportV1["capabilities"];
  cachedImages: HostStateReportV1["cached_images"];
}

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const authz = await requireAdminUserContext(request);
  if (!authz.ok) {
    return authz.response;
  }

  const db = drizzle(env.DB);
  const hosts = await db
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
      last_client_hello_at: agentHosts.lastClientHelloAt,
      last_server_hello_at: agentHosts.lastServerHelloAt,
      agent_version: agentHosts.agentVersion,
      inventory_json: agentHosts.inventoryJson,
      created_at: agentHosts.createdAt,
      updated_at: agentHosts.updatedAt,
    })
    .from(agentHosts)
    .where(eq(agentHosts.userId, authz.context.userId))
    .orderBy(desc(agentHosts.createdAt));

  const output = await Promise.all(
    hosts.map(async (host) => {
      const recentRuns = await db
        .select({
          runId: scenarioRuns.runId,
          scenarioId: scenarioRuns.scenarioId,
          state: scenarioRuns.state,
          createdAt: scenarioRuns.createdAt,
          updatedAt: scenarioRuns.updatedAt,
        })
        .from(scenarioRuns)
        .where(eq(scenarioRuns.hostId, host.id))
        .orderBy(desc(scenarioRuns.createdAt))
        .limit(5);

      const actualState = await loadHostActualStateSummary(host.id);
      return serializeHost(host, recentRuns, actualState);
    }),
  );

  return jsonResponse({ hosts: output });
};

export const POST: APIRoute = async ({ request, url }) => {
  const authz = await requireAdminUserContext(request);
  if (!authz.ok) {
    return authz.response;
  }

  const db = drizzle(env.DB);
  let body: CreateHostBody = {};
  try {
    body = (await request.json()) as CreateHostBody;
  } catch {
    // Empty JSON body is allowed.
  }

  const existingHostId = body.hostId?.trim() ?? "";
  let host = existingHostId
    ? await loadHostForUser(existingHostId, authz.context.userId)
    : null;
  if (existingHostId && !host) {
    return jsonResponse({ error: "host not found" }, { status: 404 });
  }
  const requestedRole = resolveRequestedHostRole(body.role, host?.role);

  if (!host) {
    const hostName = normalizeHostName(body.name);
    const existingByName = await db
      .select({ id: agentHosts.id })
      .from(agentHosts)
      .where(
        and(
          eq(agentHosts.userId, authz.context.userId),
          eq(agentHosts.name, hostName),
        ),
      )
      .limit(1);

    const hostId = existingByName[0]?.id ?? (await allocateHostId(hostName));
    const now = Date.now();
    if (!existingByName[0]) {
      await db.insert(agentHosts).values({
        id: hostId,
        userId: authz.context.userId,
        name: hostName,
        role: requestedRole,
        scenarioEnabled: requestedRole === "agent",
        disabled: false,
        connected: false,
        createdAt: now,
        updatedAt: now,
      });
    }

    host = await loadHostForUser(hostId, authz.context.userId);
  }

  if (host && host.role !== requestedRole) {
    const now = Date.now();
    const previousRole = host.role;
    await db
      .update(agentHosts)
      .set({
        role: requestedRole,
        scenarioEnabled: requestedRole === "agent",
        ...bridgeSessionResetForHostRoleChange(now),
        updatedAt: now,
      })
      .where(
        and(
          eq(agentHosts.id, host.id),
          eq(agentHosts.userId, authz.context.userId),
        ),
      );
    await cleanupDesiredStateForRoleChange(
      db,
      host.id,
      previousRole,
      requestedRole,
      now,
    );
    host = await loadHostForUser(host.id, authz.context.userId);
  }

  if (!host) {
    return jsonResponse({ error: "failed to create host" }, { status: 500 });
  }

  const token = createBootstrapToken();
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const expiresAt = now + BOOTSTRAP_TOKEN_TTL_MS;

  await db
    .update(agentBootstrapTokens)
    .set({ revokedAt: now })
    .where(
      and(
        eq(agentBootstrapTokens.hostId, host.id),
        isNull(agentBootstrapTokens.revokedAt),
      ),
    );

  await db.insert(agentBootstrapTokens).values({
    id: createAppId(),
    hostId: host.id,
    tokenHash,
    expiresAt,
    revokedAt: null,
    createdAt: now,
  });

  const bridgeConfigToml = buildBridgeConfigToml({
    baseUrl: url.origin || resolveRequestOrigin(request),
    hostId: host.id,
    bootstrapToken: token,
  });

  return jsonResponse({
    host: {
      id: host.id,
      name: host.name,
      role: host.role,
      disabled: Boolean(host.disabled),
      scenarioEnabled: Boolean(host.scenario_enabled),
      createdAt: host.created_at,
    },
    bootstrapTokenExpiresAt: new Date(expiresAt).toISOString(),
    bridgeConfigToml,
  });
};

function serializeHost(
  host: AgentHostRow,
  recentRuns: Array<{
    runId: string;
    scenarioId: string;
    state: string;
    createdAt: number;
    updatedAt: number;
  }>,
  actualState: HostActualStateSummary | null,
) {
  return {
    id: host.id,
    name: host.name,
    role: host.role,
    disabled: Boolean(host.disabled),
    scenarioEnabled: Boolean(host.scenario_enabled),
    createdAt: host.created_at,
    updatedAt: host.updated_at,
    inventory: parseInventory(host.inventory_json),
    actualState,
    status: buildStoredBridgeStatus(host),
    recentRuns,
  };
}

async function loadHostActualStateSummary(
  hostId: string,
): Promise<HostActualStateSummary | null> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      appliedDesiredVersion: hostActualState.appliedDesiredVersion,
      observedAt: hostActualState.observedAt,
      reportedAt: hostActualState.updatedAt,
      reportJson: hostActualState.reportJson,
    })
    .from(hostActualState)
    .where(eq(hostActualState.hostId, hostId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    appliedDesiredVersion: row.appliedDesiredVersion,
    observedAt: row.observedAt,
    health: hostHealth(row.reportedAt, Date.now()),
    capacity: row.reportJson.capacity,
    capabilities: row.reportJson.capabilities,
    cachedImages: row.reportJson.cached_images,
  };
}

function normalizeHostName(input?: string): string {
  const trimmed = input?.trim();
  return trimmed ? trimmed.slice(0, 80) : "dedicated-host";
}

async function allocateHostId(name: string): Promise<string> {
  const db = drizzle(env.DB);
  const base = toSafeKey(name) || "host";
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const candidate = `${base}-${createShortAppId()}`.slice(0, 64);
    const existing = await db
      .select({ id: agentHosts.id })
      .from(agentHosts)
      .where(eq(agentHosts.id, candidate))
      .limit(1);
    if (!existing.length && HOST_ID_REGEX.test(candidate)) {
      return candidate;
    }
  }
  throw new Error("failed to allocate host id");
}

async function cleanupDesiredStateForRoleChange(
  db: AppDb,
  hostId: string,
  previousRole: "agent" | "builder",
  requestedRole: "agent" | "builder",
  now: number,
): Promise<void> {
  await db.delete(hostActualState).where(eq(hostActualState.hostId, hostId));

  if (previousRole === "agent" && requestedRole === "builder") {
    await mutateStoredHostDesiredState(db, hostId, now, (draft) => {
      clearDesiredCachedImages(draft);
      clearDesiredVms(draft);
    });
    await tryWakeHostRuntime(hostId);
    return;
  }

  if (previousRole === "builder" && requestedRole === "agent") {
    await releaseBuildAssignmentsForHostRoleChange(db, hostId, now);
  }
}

function toSafeKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function createBootstrapToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/\"/g, '\\"')}"`;
}

function buildBridgeConfigToml(input: {
  baseUrl: string;
  hostId: string;
  bootstrapToken: string;
}): string {
  return [
    "[bridge]",
    "enabled = true",
    `base_url = ${tomlString(input.baseUrl)}`,
    `host_id = ${tomlString(input.hostId)}`,
    `bootstrap_token = ${tomlString(input.bootstrapToken)}`,
    "heartbeat_interval_seconds = 30",
  ].join("\n");
}
