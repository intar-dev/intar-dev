import { env } from "cloudflare:workers";

/** Save intent before desired absence; terminal runs need it even without an active slot. */
export async function requestScenarioRunRouteCleanup(hostId: string, runIds: string[], now = Date.now()) {
  if (!runIds.length) return [];
  const { results } = await env.DB.prepare(`UPDATE scenario_runs
    SET route_cleanup_id = coalesce(route_cleanup_id, ?1),
      delete_requested_at = coalesce(delete_requested_at, ?2), updated_at = max(updated_at + 1, ?2)
    WHERE host_id = ?3 AND run_id IN (SELECT value FROM json_each(?4))
    RETURNING run_id AS runId, user_id AS userId, route_cleanup_id AS cleanupId`)
    .bind(crypto.randomUUID(), now, hostId, JSON.stringify(runIds))
    .all<{ runId: string; userId: string; cleanupId: string }>();
  return results;
}

export async function completeScenarioRunRouteCleanup(runId: string, cleanupId: string) {
  // A late completion cannot discard a newer cleanup request.
  await env.DB.prepare("UPDATE scenario_runs SET route_cleanup_id = NULL WHERE run_id = ? AND route_cleanup_id = ?")
    .bind(runId, cleanupId).run();
}
