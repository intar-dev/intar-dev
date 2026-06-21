import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { agentHosts } from "@/db/schema";
import {
  buildHostRuntimeState,
  buildStoredBridgeStatus,
  jsonResponse,
  loadHostForUser,
  parseHostInfo,
  parseInventory,
  requireAdminUserContext,
} from "@/lib/agent-bridge";

export const prerender = false;

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

  return jsonResponse({
    host: {
      id: host.id,
      name: host.name,
      disabled: Boolean(host.disabled),
      scenarioEnabled: Boolean(host.scenario_enabled),
      createdAt: host.created_at,
      updatedAt: host.updated_at,
      hostInfo: parseHostInfo(host.host_info_json),
      inventory: parseInventory(host.inventory_json),
      runtime: buildHostRuntimeState(host),
      status: buildStoredBridgeStatus(host),
      statusError:
        host.last_ping_success === false
          ? (host.last_ping_error ?? "last ping failed")
          : null,
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
  await db
    .delete(agentHosts)
    .where(
      and(eq(agentHosts.id, hostId), eq(agentHosts.userId, authz.context.userId)),
    );

  return jsonResponse({ ok: true, hostId });
};
