import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { agentHosts, hostActualState } from "@/db/schema";
import type { HostStateReportV1 } from "@/generated/bridge";
import {
  assignQueuedImageBuilds,
  releaseBuildAssignmentsForHostRemoval,
} from "@/lib/build-scheduler";
import {
  buildStoredBridgeStatus,
  jsonResponse,
  loadHostForUser,
  parseHostInfo,
  parseInventory,
  requireAdminUserContext,
} from "@/lib/agent-bridge";

export const prerender = false;

interface HostActualStateSummary {
  appliedDesiredVersion: number;
  observedAt: number;
  capacity: HostStateReportV1["capacity"];
  capabilities: HostStateReportV1["capabilities"];
  cachedImages: HostStateReportV1["cached_images"];
}

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireAdminUserContext(request);
  if (!authz.ok) {
    return authz.response;
  }

  const hostId = params.hostId?.trim() ?? "";
  if (!hostId) {
    return jsonResponse({ error: "hostId is required" }, { status: 400 });
  }

  const host = await loadHostForUser(hostId, authz.context.userId);
  if (!host) {
    return jsonResponse({ error: "host not found" }, { status: 404 });
  }

  const actualState = await loadHostActualStateSummary(host.id);
  return jsonResponse({
    host: {
      id: host.id,
      name: host.name,
      role: host.role,
      disabled: Boolean(host.disabled),
      scenarioEnabled: Boolean(host.scenario_enabled),
      createdAt: host.created_at,
      updatedAt: host.updated_at,
      hostInfo: parseHostInfo(host.host_info_json),
      inventory: parseInventory(host.inventory_json),
      actualState,
      status: buildStoredBridgeStatus(host),
    },
  });
};

export const DELETE: APIRoute = async ({ request, params }) => {
  const authz = await requireAdminUserContext(request);
  if (!authz.ok) {
    return authz.response;
  }

  const hostId = params.hostId?.trim() ?? "";
  if (!hostId) {
    return jsonResponse({ error: "hostId is required" }, { status: 400 });
  }

  const host = await loadHostForUser(hostId, authz.context.userId);
  if (!host) {
    return jsonResponse({ error: "host not found" }, { status: 404 });
  }

  const db = drizzle(env.DB);
  const now = Date.now();
  if (host.role === "builder") {
    await releaseBuildAssignmentsForHostRemoval(db, host.id, now);
  }
  await db
    .delete(agentHosts)
    .where(
      and(eq(agentHosts.id, hostId), eq(agentHosts.userId, authz.context.userId)),
    );
  if (host.role === "builder") {
    await assignQueuedImageBuilds(db, now);
  }

  return jsonResponse({ ok: true, hostId });
};

async function loadHostActualStateSummary(
  hostId: string,
): Promise<HostActualStateSummary | null> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      appliedDesiredVersion: hostActualState.appliedDesiredVersion,
      observedAt: hostActualState.observedAt,
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
    capacity: row.reportJson.capacity,
    capabilities: row.reportJson.capabilities,
    cachedImages: row.reportJson.cached_images,
  };
}
