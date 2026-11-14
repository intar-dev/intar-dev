import type { HostStateReportV3 } from "@/generated/contracts/bridge-message-v9";
import { appError } from "@/lib/app-error";
import { HOST_DEGRADED_AFTER_MS } from "@/lib/host-health";
import { HOST_HEARTBEAT_TTL_MS } from "./start";

/** Whether `report` lists every one of `images` as ready on its host. */
export function reportHasImagesReady(report: HostStateReportV3, images: readonly string[]): boolean {
  const ready = new Set(report.cached_images.filter((image) => image.phase === "ready").map((image) => image.image));
  return images.every((image) => ready.has(image));
}

/**
 * Holds while an agent host that matches `hostCondition` (SQL over
 * `agent_hosts`) is live, by the rules admission uses, and its last report
 * lists the image of every machine of the revision document `docJson` (a SQL
 * expression) as ready.
 */
export function liveHostHasRevisionImagesSql(docJson: string, hostCondition: string): string {
  const now = "CAST(unixepoch('subsecond') * 1000 AS INTEGER)";
  return `EXISTS (SELECT 1 FROM agent_hosts
      JOIN host_actual_state ready_state ON ready_state.host_id = agent_hosts.id
    WHERE agent_hosts.role = 'agent' AND agent_hosts.disabled = 0 AND agent_hosts.scenario_enabled = 1
      AND agent_hosts.connected = 1 AND agent_hosts.last_heartbeat_at >= ${now} - ${HOST_HEARTBEAT_TTL_MS}
      AND ready_state.updated_at >= ${now} - ${HOST_DEGRADED_AFTER_MS}
      AND ${hostCondition}
      AND NOT EXISTS (SELECT 1 FROM json_each(${docJson}, '$.machines') needed
        WHERE NOT EXISTS (SELECT 1 FROM json_each(ready_state.report_json, '$.cached_images') cached
          WHERE json_extract(cached.value, '$.image') = json_extract(needed.value, '$.image_digest')
            AND json_extract(cached.value, '$.phase') = 'ready')))`;
}

export function scenarioImagePreparing() {
  return appError(
    409,
    "scenario_image_preparing",
    "This scenario is still being prepared on its server. Try again in a few minutes.",
  );
}
