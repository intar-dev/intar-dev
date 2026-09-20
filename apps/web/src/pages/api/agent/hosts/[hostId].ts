import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  hostActualState,
  hostDesiredState,
} from "@/db/schema";
import type {
  DesiredBuildV1,
  DesiredCachedImageV1,
  DesiredVmV2,
  HostStateReportV2,
} from "@/generated/bridge";
import {
  buildStoredBridgeStatus,
  jsonResponse,
  loadHostForUser,
  parseInventory,
  requireAdminUserContext,
} from "@/lib/agent-bridge";
import { hostHealth, type HostHealth } from "@/lib/host-health";

export const prerender = false;

interface HostActualStateSummary {
  appliedDesiredVersion: number;
  observedAt: number;
  health: HostHealth;
  capacity: HostStateReportV2["capacity"];
  capabilities: HostStateReportV2["capabilities"];
  cachedImages: HostStateReportV2["cached_images"];
  vms: HostStateReportV2["vms"];
  builds: HostStateReportV2["builds"];
}

interface HostDesiredStateSummary {
  version: number;
  cachedImages: DesiredCachedImageV1[];
  vms: DesiredVmV2[];
  builds: DesiredBuildV1[];
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

  const [actualState, desiredState] = await Promise.all([
    loadHostActualStateSummary(host.id),
    loadHostDesiredStateSummary(host.id),
  ]);
  return jsonResponse({
    host: {
      id: host.id,
      name: host.name,
      role: host.role,
      disabled: Boolean(host.disabled),
      scenarioEnabled: Boolean(host.scenario_enabled),
      createdAt: host.created_at,
      updatedAt: host.updated_at,
      inventory: parseInventory(host.inventory_json),
      actualState,
      desiredState,
      status: buildStoredBridgeStatus(host),
    },
  });
};

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
    builds: row.reportJson.builds,
  };
}

async function loadHostDesiredStateSummary(
  hostId: string,
): Promise<HostDesiredStateSummary | null> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      version: hostDesiredState.version,
      docJson: hostDesiredState.docJson,
    })
    .from(hostDesiredState)
    .where(eq(hostDesiredState.hostId, hostId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    version: row.version,
    cachedImages: row.docJson.cached_images,
    vms: row.docJson.vms,
    builds: row.docJson.builds,
  };
}
