import { strictCpuCapacity } from "@/control-plane/host-cpu-reservations";
import type { HostStateReportV2 } from "@/generated/bridge";
import { hostSupportsRunCliV1, hostSupportsSpeedRedesign } from "@/lib/scenario-hosts";

export function personalHostReportReady(report: HostStateReportV2 | null, requireRunCli: boolean): boolean {
  const cpu = strictCpuCapacity(report);
  return !!report && report.relay_connected === true && !!cpu && cpu.schedulableCpuMillis > 0 &&
    report.capabilities.arch === "x86_64" &&
    report.capacity.total_cpu_millis >= 2000 &&
    report.capacity.memory_total_mib >= 4096 &&
    hostSupportsSpeedRedesign(report) && (!requireRunCli || hostSupportsRunCliV1(report));
}

/** Persist readiness and placement together. Admission cannot see Ready with cloud placement. */
export async function persistHostReport(input: {
  d1: D1Database; hostId: string; sessionId: string; credentialGeneration: number;
  report: HostStateReportV2; now: number; requireRunCli: boolean;
}): Promise<boolean> {
  const { d1, hostId, sessionId, credentialGeneration, report, now } = input;
  if (report.host_id !== hostId) return false;
  const currentHost = `id = ?1 AND active_session_id = ?2 AND credential_generation = ?3 AND disabled = 0`;
  const [accepted] = await d1.batch([
    d1.prepare(`INSERT INTO host_actual_state
      (host_id, applied_desired_version, observed_at, report_json, created_at, updated_at)
      SELECT id, ?4, ?5, ?6, ?7, ?7 FROM agent_hosts WHERE ${currentHost}
        AND NOT EXISTS (SELECT 1 FROM json_each(?6, '$.vms') reported
          WHERE NOT EXISTS (SELECT 1 FROM runtime_executions execution
            JOIN runtime_vms vm ON vm.execution_id = execution.id
            WHERE execution.id = json_extract(reported.value, '$.runtime_execution_id')
              AND execution.generation = json_extract(reported.value, '$.generation')
              AND execution.user_id = json_extract(reported.value, '$.owner_user_id')
              AND execution.domain_id = json_extract(reported.value, '$.run_id')
              AND execution.host_id = ?1 AND execution.state <> 'archived'
              AND vm.runtime_vm_name = json_extract(reported.value, '$.vm_name')
              AND (agent_hosts.scope = 'platform' OR (agent_hosts.scope = 'personal' AND agent_hosts.user_id = execution.user_id))
              AND NOT EXISTS (SELECT 1 FROM runtime_executions newer WHERE newer.domain_kind = execution.domain_kind
                AND newer.domain_id = execution.domain_id AND newer.generation > execution.generation)))
      ON CONFLICT(host_id) DO UPDATE SET applied_desired_version = excluded.applied_desired_version,
        observed_at = excluded.observed_at, report_json = excluded.report_json, updated_at = excluded.updated_at
      WHERE excluded.observed_at > host_actual_state.observed_at
        OR (excluded.observed_at = host_actual_state.observed_at AND excluded.report_json = host_actual_state.report_json)
      RETURNING host_id`).bind(hostId, sessionId, credentialGeneration,
        report.applied_desired_version, report.observed_at_unix_ms, JSON.stringify(report), now),
    d1.prepare(`UPDATE agent_hosts SET connected = 1, disconnected_at = NULL,
      last_heartbeat_at = ?4, last_inventory_at = ?4, updated_at = ?4
      WHERE ${currentHost} AND EXISTS (SELECT 1 FROM host_actual_state WHERE host_id = ?1 AND report_json = ?5 AND updated_at = ?4)`).bind(hostId, sessionId, credentialGeneration, now, JSON.stringify(report)),
    d1.prepare(`UPDATE user SET metal_placement = 'personal'
      WHERE metal_placement = 'platform' AND deleted_at IS NULL AND coalesce(banned, 0) = 0 AND ?4 = 1
        AND EXISTS (SELECT 1 FROM agent_hosts host WHERE host.${currentHost}
          AND host.scope = 'personal' AND host.role = 'agent' AND host.scenario_enabled = 1 AND host.user_id = user.id)
        AND EXISTS (SELECT 1 FROM host_actual_state WHERE host_id = ?1 AND report_json = ?5 AND updated_at = ?6)
        AND EXISTS (SELECT 1 FROM access_allowlist access WHERE access.user_id = user.id AND access.state = 'active')`)
      .bind(hostId, sessionId, credentialGeneration, personalHostReportReady(report, input.requireRunCli) ? 1 : 0, JSON.stringify(report), now),
  ]);
  return accepted?.results.length === 1;
}
