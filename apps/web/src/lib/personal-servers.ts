import { env } from "cloudflare:workers";
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { agentHosts, hostActualState, scenarioRuns, user } from "@/db/schema";
import type { HostStateReportV2 } from "@/generated/bridge";
import type { UserContext } from "@/lib/agent-bridge";
import { appError } from "@/lib/app-error";
import { hostHealth, HOST_DEGRADED_AFTER_MS } from "@/lib/host-health";
import { personalHostReportReady } from "@/lib/personal-host-readiness";
import { currentPersonalOwnerSql } from "@/lib/personal-host-retirement";
import { availableRuntimeHostResources, loadActiveRuntimeResourceSnapshot, type ActiveRuntimeResourceSnapshot } from "@/lib/runtime-capacity";
import { learnerRunCliV1EnforcementEnabled } from "@/lib/run-cli-rollout";
import { isFreshHostHeartbeat } from "@/lib/scenario-hosts";

export async function listPersonalServers(context: UserContext) {
  const db = drizzle(env.DB);
  const now = Date.now();
  const [hosts, owners, gate, enrollments, activeRuns] = await Promise.all([
    db.select({ host: agentHosts, report: hostActualState.reportJson, reportedAt: hostActualState.updatedAt })
      .from(agentHosts).leftJoin(hostActualState, eq(hostActualState.hostId, agentHosts.id))
      .where(and(eq(agentHosts.userId, context.userId), eq(agentHosts.scope, "personal"),
        or(eq(agentHosts.disabled, false), isNull(agentHosts.ownerRemovalCompletedAt)))),
    db.select({ placement: user.metalPlacement }).from(user).where(eq(user.id, context.userId)),
    env.DB.prepare("SELECT state FROM runtime_operation_gates WHERE key = 'personal_metal_registration'").first<{ state: string }>(),
    env.DB.prepare(`SELECT host_id AS id, name, expires_at AS expiresAt FROM host_enrollments
      WHERE user_id = ?1 AND scope = 'personal' AND claimed_at IS NULL AND revoked_at IS NULL AND expires_at > ?2
        AND source_invite_id = ?3 AND source_lease_id = ?4 AND granted_at = ?5
      ORDER BY expires_at DESC`).bind(context.userId, now, context.betaAdmission.sourceInviteId, context.betaAdmission.sourceLeaseId, context.betaAdmission.grantedAt).all<{ id: string; name: string; expiresAt: number }>(),
    db.select({ hostId: scenarioRuns.hostId, count: sql<number>`count(*)` }).from(scenarioRuns)
      .innerJoin(agentHosts, eq(agentHosts.id, scenarioRuns.hostId))
      .where(and(eq(agentHosts.userId, context.userId), eq(agentHosts.scope, "personal"), eq(scenarioRuns.userId, context.userId), isNotNull(scenarioRuns.activeKey)))
      .groupBy(scenarioRuns.hostId),
  ]);
  const reservations = await loadActiveRuntimeResourceSnapshot(now, hosts.map(({ host }) => host.id));
  return {
    placement: owners[0]?.placement ?? "platform",
    registrationOpen: gate?.state === "open",
    installerCommand: "curl -fsSL https://intar.dev/install.sh | sudo sh",
    enrollments: enrollments.results,
    servers: hosts.map(row => serializeManagedServer(row, now, reservations,
      activeRuns.find(run => run.hostId === row.host.id)?.count ?? 0)),
  };
}

/** Keep personal and shared server status, capacity, and repair guidance identical. */
export function serializeManagedServer(
  { host, report, reportedAt }: { host: typeof agentHosts.$inferSelect; report: HostStateReportV2 | null; reportedAt: number | null },
  now: number,
  reservations: ActiveRuntimeResourceSnapshot,
  activeRuns: number,
) {
  const connected = !host.disabled && host.connected && isFreshHostHeartbeat(host.lastHeartbeatAt, now, 90_000);
  const fresh = connected && hostHealth(reportedAt, now) === "healthy";
  const ready = fresh && personalHostReportReady(report, learnerRunCliV1EnforcementEnabled(env));
  const resources = ready && report ? availableRuntimeHostResources({ hostId: host.id, report, snapshot: reservations }) : null;
  const status = host.disabled ? host.ownerRemovalId ? "removing" : "revoked"
    : !host.scenarioEnabled ? "paused" : !host.lastHeartbeatAt ? "setting_up" : !fresh ? "offline" : ready ? "ready" : "needs_attention";
  const full = resources && (resources.cpuMillis <= 0 || resources.memoryMib <= 0 || resources.worstCaseDiskMib <= 0);
  const message = status === "removing" ? "Access is revoked. Retry removal to finish closing sessions."
    : status === "revoked" ? "Server access was revoked. Remove this server, then register it again to use it."
    : status === "paused" ? "New runs are paused. Current runs can finish."
    : status === "setting_up" ? "Waiting for installation and the first health check."
    : status === "offline" ? "No recent connection. New runs cannot start on this server."
    : status === "needs_attention" ? "The server did not pass its readiness checks."
    : full ? "The server is full. Wait for a run to finish."
    : host.scope === "organization"
      ? "Ready for organization runs. Only this organization can use this server."
      : "Ready for your runs. Only your workloads can use this server.";
  return {
    id: host.id, name: host.name, status, message,
    repairAction: status === "offline" || status === "needs_attention" || status === "setting_up" ? "Run sudo intar-host doctor on this server." : null,
    connected, createdAt: host.createdAt, lastSeenAt: host.lastHeartbeatAt,
    capacity: ready && report && resources ? { total: report.capacity.schedulable_cpu_millis / 1000, available: resources.cpuMillis / 1000 } : null,
    activeRuns,
  };
}

export async function updatePersonalServer(d1: D1Database, context: UserContext, hostId: string, input: Record<string, unknown>) {
  const keys = Object.keys(input);
  const rename = keys.length === 1 && keys[0] === "name" && typeof input.name === "string" && input.name.trim().length > 0 && input.name.trim().length <= 80;
  const pause = keys.length === 1 && keys[0] === "paused" && typeof input.paused === "boolean";
  if (!rename && !pause) throw appError(400, "invalid_server_update", "Enter a name of 1 to 80 characters, or choose pause or resume.");
  const epoch = context.betaAdmission;
  const now = Date.now();
  const resume = pause && input.paused === false;
  const snapshot = resume ? await drizzle(d1).select({ report: hostActualState.reportJson, reportedAt: hostActualState.updatedAt,
    sessionId: agentHosts.activeSessionId, generation: agentHosts.credentialGeneration })
    .from(agentHosts).innerJoin(hostActualState, eq(hostActualState.hostId, agentHosts.id))
    .where(eq(agentHosts.id, hostId)).get() : undefined;
  const snapshotGuard = !resume ? "" : snapshot ? `AND active_session_id IS ?8 AND credential_generation = ?9
    AND EXISTS (SELECT 1 FROM host_actual_state actual WHERE actual.host_id = ?5 AND actual.report_json = ?10 AND actual.updated_at = ?11)`
    : "AND NOT EXISTS (SELECT 1 FROM host_actual_state actual WHERE actual.host_id = ?5)";
  const statements = [d1.prepare(`UPDATE agent_hosts SET ${rename ? "name" : "scenario_enabled"} = ?6, updated_at = ?7
    WHERE id = ?5 AND user_id = ?1 AND scope = 'personal' AND disabled = 0 AND ${currentPersonalOwnerSql} ${snapshotGuard} RETURNING id`)
    .bind(context.userId, epoch.sourceInviteId, epoch.sourceLeaseId, epoch.grantedAt, hostId,
      rename ? (input.name as string).trim() : input.paused ? 0 : 1, now,
      ...(snapshot ? [snapshot.sessionId, snapshot.generation, JSON.stringify(snapshot.report), snapshot.reportedAt] : []))];
  if (resume) {
    if (snapshot && personalHostReportReady(snapshot.report, learnerRunCliV1EnforcementEnabled(env))) {
      statements.push(d1.prepare(`UPDATE user SET metal_placement = 'personal'
        WHERE id = ?1 AND metal_placement = 'platform' AND ${currentPersonalOwnerSql}
          AND EXISTS (SELECT 1 FROM agent_hosts host JOIN host_actual_state actual ON actual.host_id = host.id
            WHERE host.id = ?5 AND host.user_id = ?1 AND host.scope = 'personal' AND host.disabled = 0
              AND host.scenario_enabled = 1 AND host.connected = 1 AND host.active_session_id = ?6
              AND host.credential_generation = ?7 AND actual.report_json = ?8 AND actual.updated_at = ?9
              AND actual.updated_at >= CAST(unixepoch('subsecond') * 1000 AS INTEGER) - ${HOST_DEGRADED_AFTER_MS}
              AND host.last_heartbeat_at >= CAST(unixepoch('subsecond') * 1000 AS INTEGER) - 90000)`)
        .bind(context.userId, epoch.sourceInviteId, epoch.sourceLeaseId, epoch.grantedAt, hostId,
          snapshot.sessionId, snapshot.generation, JSON.stringify(snapshot.report), snapshot.reportedAt));
    }
  }
  const [result] = await d1.batch(statements);
  if (!result?.results.length) {
    if (resume && await d1.prepare(`SELECT id FROM agent_hosts WHERE id = ?5 AND user_id = ?1
      AND scope = 'personal' AND disabled = 0 AND ${currentPersonalOwnerSql}`)
      .bind(context.userId, epoch.sourceInviteId, epoch.sourceLeaseId, epoch.grantedAt, hostId).first()) {
      throw appError(409, "server_status_changed", "Server status changed. Try resume again.");
    }
    throw appError(404, "server_not_found", "Server not found. Refresh My servers.");
  }
}
