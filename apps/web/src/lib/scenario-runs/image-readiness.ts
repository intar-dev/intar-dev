import type { HostStateReportV3 } from "@/generated/contracts/bridge-message-v9";
import { appError } from "@/lib/app-error";
import { HOST_DEGRADED_AFTER_MS } from "@/lib/host-health";
import { HOST_HEARTBEAT_TTL_MS } from "./start";

/** Whether `report` lists every one of `images` as ready on its host. */
export function reportHasImagesReady(report: HostStateReportV3, images: readonly string[]): boolean {
  const ready = new Set(report.cached_images.filter((image) => image.phase === "ready").map((image) => image.image));
  return images.every((image) => ready.has(image));
}

const NOW = "CAST(unixepoch('subsecond') * 1000 AS INTEGER)";

/**
 * The common table expressions `live_platform_hosts(host_id)`, the platform
 * agents that are live by the rules admission uses, and
 * `ready_platform_images(host_id, image)`, the images each of them last
 * reported ready. Each report is read once per statement.
 */
export function readyPlatformImagesCtes(): string {
  // A function, so the liveness constants are read at call time and an
  // import cycle cannot leave them undefined in the text.
  return `live_platform_hosts AS MATERIALIZED (
    SELECT agent_hosts.id AS host_id, ready_state.report_json
      FROM agent_hosts JOIN host_actual_state ready_state ON ready_state.host_id = agent_hosts.id
     WHERE agent_hosts.scope = 'platform' AND agent_hosts.role = 'agent' AND agent_hosts.disabled = 0
       AND agent_hosts.scenario_enabled = 1 AND agent_hosts.connected = 1
       AND agent_hosts.last_heartbeat_at >= ${NOW} - ${HOST_HEARTBEAT_TTL_MS}
       AND ready_state.updated_at >= ${NOW} - ${HOST_DEGRADED_AFTER_MS}),
  ready_platform_images AS MATERIALIZED (
    SELECT live.host_id, json_extract(cached.value, '$.image') AS image
      FROM live_platform_hosts live, json_each(live.report_json, '$.cached_images') cached
     WHERE json_extract(cached.value, '$.phase') = 'ready')`;
}

/**
 * Holds while a live platform host has the image of every machine of the
 * revision document `docJson` (a SQL expression) ready. The statement must
 * carry {@link readyPlatformImagesCtes}.
 */
export function platformHasRevisionImagesSql(docJson: string): string {
  return `EXISTS (SELECT 1 FROM live_platform_hosts host
    WHERE NOT EXISTS (SELECT 1 FROM json_each(${docJson}, '$.machines') needed
      WHERE NOT EXISTS (SELECT 1 FROM ready_platform_images have
        WHERE have.host_id = host.host_id AND have.image = json_extract(needed.value, '$.image_digest'))))`;
}

export function scenarioImagePreparing() {
  return appError(
    409,
    "scenario_image_preparing",
    "This scenario is still being prepared on its server. Try again in a few minutes.",
  );
}
