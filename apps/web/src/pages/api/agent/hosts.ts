import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { agentHosts, hostActualState, scenarioRuns } from "@/db/schema";
import type { HostStateReportV2 } from "@/generated/bridge";
import {
  buildStoredBridgeStatus,
  jsonResponse,
  parseInventory,
  requireAdminUserContext,
  type AgentHostRow,
} from "@/lib/agent-bridge";
import { hostHealth, type HostHealth } from "@/lib/host-health";

interface HostActualStateSummary {
  appliedDesiredVersion: number;
  observedAt: number;
  health: HostHealth;
  capacity: HostStateReportV2["capacity"];
  capabilities: HostStateReportV2["capabilities"];
  cachedImages: HostStateReportV2["cached_images"];
  vms: HostStateReportV2["vms"];
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
    .where(
      and(
        eq(agentHosts.userId, authz.context.userId),
        eq(agentHosts.scope, "platform"),
        eq(agentHosts.disabled, false),
      ),
    )
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

export const POST: APIRoute = async () => jsonResponse(
  {
    error: "Legacy server registration is no longer available. Install and enroll this server again.",
    code: "fresh_enrollment_required",
  },
  { status: 410, headers: { "cache-control": "no-store" } },
);

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
    vms: row.reportJson.vms,
  };
}
