import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { and, eq, notExists } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  agentHosts,
  hostActualState,
  imageBuilds,
  scenarioRuns,
} from "@/db/schema";
import type { HostStateReportV2 } from "@/generated/bridge";
import { assignQueuedImageBuilds } from "@/lib/build-scheduler";
import {
  buildStoredBridgeStatus,
  jsonResponse,
  loadHostForUser,
  parseInventory,
  requireAdminUserContext,
} from "@/lib/agent-bridge";
import { hostHealth, type HostHealth } from "@/lib/host-health";
import { retireHostRuntime } from "@/lib/host-runtime-wake";

export const prerender = false;

interface HostActualStateSummary {
  appliedDesiredVersion: number;
  observedAt: number;
  health: HostHealth;
  capacity: HostStateReportV2["capacity"];
  capabilities: HostStateReportV2["capabilities"];
  cachedImages: HostStateReportV2["cached_images"];
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
  const referencedRuns = await db
    .select({ runId: scenarioRuns.runId })
    .from(scenarioRuns)
    .where(eq(scenarioRuns.hostId, host.id))
    .limit(1);
  if (referencedRuns.length > 0) {
    return hostHasRunHistoryResponse(host.id);
  }

  const now = Date.now();
  const runGuard = () =>
    notExists(
      db
        .select({ runId: scenarioRuns.runId })
        .from(scenarioRuns)
        .where(eq(scenarioRuns.hostId, host.id)),
    );
  const deleteHost = db
    .delete(agentHosts)
    .where(
      and(
        eq(agentHosts.id, hostId),
        eq(agentHosts.userId, authz.context.userId),
        runGuard(),
      ),
    )
    .returning({ id: agentHosts.id });
  const deletedHosts =
    host.role === "builder"
      ? (
          await db.batch([
            db
              .update(imageBuilds)
              .set({
                hostId: null,
                status: "queued",
                phase: "queued",
                error: "builder host was deleted before starting build",
                updatedAt: now,
              })
              .where(
                and(
                  eq(imageBuilds.hostId, host.id),
                  eq(imageBuilds.status, "assigned"),
                  runGuard(),
                ),
              ),
            db
              .update(imageBuilds)
              .set({
                status: "stale",
                error: "builder host was deleted while build was running",
                updatedAt: now,
              })
              .where(
                and(
                  eq(imageBuilds.hostId, host.id),
                  eq(imageBuilds.status, "building"),
                  runGuard(),
                ),
              ),
            deleteHost,
          ])
        )[2]
      : await deleteHost;
  if (deletedHosts.length === 0) {
    return jsonResponse(
      {
        error: "host deletion conflicted with a new run or concurrent update",
        code: "host_delete_conflict",
        hostId: host.id,
      },
      { status: 409 },
    );
  }

  try {
    await retireHostRuntime(host.id);
  } catch (error) {
    console.warn(
      JSON.stringify({
        message: "host runtime retirement failed after host deletion",
        hostId: host.id,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  if (host.role === "builder") {
    await assignQueuedImageBuilds(db, now);
  }

  return jsonResponse({ ok: true, hostId });
};

function hostHasRunHistoryResponse(hostId: string): Response {
  return jsonResponse(
    {
      error: "host has scenario run history and cannot be deleted",
      code: "host_has_run_history",
      hostId,
    },
    { status: 409 },
  );
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
