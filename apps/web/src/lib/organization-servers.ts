import { env } from "cloudflare:workers";
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { agentHosts, hostActualState, organization, scenarioRuns } from "@/db/schema";
import type { UserContext } from "@/lib/agent-bridge";
import { appError } from "@/lib/app-error";
import { HOST_DEGRADED_AFTER_MS } from "@/lib/host-health";
import { cleanupRemovedHost } from "@/lib/host-workload-retirement";
import { requireOrganizationRole, resolveOrganizationId } from "@/lib/organizations";
import { serializeManagedServer } from "@/lib/personal-servers";
import { personalHostReportReady } from "@/lib/personal-host-readiness";
import { currentPersonalOwnerSql } from "@/lib/personal-host-retirement";
import { loadActiveRuntimeResourceSnapshot } from "@/lib/runtime-capacity";
import { learnerRunCliV1EnforcementEnabled } from "@/lib/run-cli-rollout";

// Binding 1 is the actor; binding 2 is the organization.
const currentOrganizationAdminSql = `${currentPersonalOwnerSql} AND EXISTS (
  SELECT 1 FROM member WHERE user_id = ?1 AND organization_id = ?2 AND role IN ('owner', 'admin'))`;

function actorArgs(context: UserContext, organizationId: string) {
  return [context.userId, organizationId] as const;
}

export async function requireOrganizationServerAccess(context: UserContext, key: string, admin = false) {
  const organizationId = await resolveOrganizationId(key);
  if (!organizationId) throw appError(404, "organization_not_found", "Organization not found.");
  await requireOrganizationRole({ organizationId, userId: context.userId, admin });
  return organizationId;
}

export async function listOrganizationServers(context: UserContext, organizationId: string) {
  await requireOrganizationRole({ organizationId, userId: context.userId });
  const db = drizzle(env.DB);
  const now = Date.now();
  const [hosts, owners, gate, enrollments, activeRuns] = await Promise.all([
    db.select({ host: agentHosts, report: hostActualState.reportJson, reportedAt: hostActualState.updatedAt })
      .from(agentHosts).leftJoin(hostActualState, eq(hostActualState.hostId, agentHosts.id))
      .where(and(eq(agentHosts.organizationId, organizationId), eq(agentHosts.scope, "organization"),
        or(eq(agentHosts.disabled, false), isNull(agentHosts.ownerRemovalCompletedAt)))),
    db.select({ placement: organization.metalPlacement }).from(organization).where(eq(organization.id, organizationId)),
    env.DB.prepare("SELECT state FROM runtime_operation_gates WHERE key = 'personal_metal_registration'").first<{ state: string }>(),
    env.DB.prepare(`SELECT enrollment.host_id AS id, enrollment.name, enrollment.expires_at AS expiresAt
      FROM host_enrollments enrollment
      JOIN member creator ON creator.user_id = enrollment.user_id AND creator.organization_id = enrollment.organization_id
      JOIN user ON user.id = enrollment.user_id
      WHERE enrollment.organization_id = ?1 AND enrollment.scope = 'organization'
        AND enrollment.claimed_at IS NULL AND enrollment.revoked_at IS NULL AND enrollment.expires_at > ?2
        AND creator.role IN ('owner', 'admin') AND user.deleted_at IS NULL AND coalesce(user.banned, 0) = 0
      ORDER BY enrollment.expires_at DESC`).bind(organizationId, now).all<{ id: string; name: string; expiresAt: number }>(),
    db.select({ hostId: scenarioRuns.hostId, count: sql<number>`count(*)` }).from(scenarioRuns)
      .innerJoin(agentHosts, eq(agentHosts.id, scenarioRuns.hostId))
      .where(and(eq(agentHosts.organizationId, organizationId), eq(agentHosts.scope, "organization"), isNotNull(scenarioRuns.activeKey)))
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

export async function updateOrganizationServer(d1: D1Database, context: UserContext, organizationId: string, hostId: string, input: Record<string, unknown>) {
  const keys = Object.keys(input);
  const rename = keys.length === 1 && keys[0] === "name" && typeof input.name === "string" && input.name.trim().length > 0 && input.name.trim().length <= 80;
  const pause = keys.length === 1 && keys[0] === "paused" && typeof input.paused === "boolean";
  if (!rename && !pause) throw appError(400, "invalid_server_update", "Enter a name of 1 to 80 characters, or choose pause or resume.");
  const args = [...actorArgs(context, organizationId), hostId] as const;
  const resume = pause && input.paused === false;
  const snapshot = resume ? await drizzle(d1).select({ report: hostActualState.reportJson, reportedAt: hostActualState.updatedAt,
    sessionId: agentHosts.activeSessionId, generation: agentHosts.credentialGeneration })
    .from(agentHosts).innerJoin(hostActualState, eq(hostActualState.hostId, agentHosts.id))
    .where(and(eq(agentHosts.id, hostId), eq(agentHosts.organizationId, organizationId), eq(agentHosts.scope, "organization"))).get() : undefined;
  const snapshotGuard = !resume ? "" : snapshot ? `AND active_session_id IS ?6 AND credential_generation = ?7
    AND EXISTS (SELECT 1 FROM host_actual_state actual WHERE actual.host_id = ?3 AND actual.report_json = ?8 AND actual.updated_at = ?9)`
    : "AND NOT EXISTS (SELECT 1 FROM host_actual_state actual WHERE actual.host_id = ?3)";
  const statements = [d1.prepare(`UPDATE agent_hosts SET ${rename ? "name" : "scenario_enabled"} = ?4, updated_at = ?5
    WHERE id = ?3 AND organization_id = ?2 AND scope = 'organization' AND disabled = 0
      AND ${currentOrganizationAdminSql} ${snapshotGuard} RETURNING id`)
    .bind(...args, rename ? (input.name as string).trim() : input.paused ? 0 : 1, Date.now(),
      ...(snapshot ? [snapshot.sessionId, snapshot.generation, JSON.stringify(snapshot.report), snapshot.reportedAt] : []))];
  if (snapshot && personalHostReportReady(snapshot.report, learnerRunCliV1EnforcementEnabled(env))) {
    statements.push(d1.prepare(`UPDATE organization SET metal_placement = 'organization'
      WHERE id = ?2 AND metal_placement = 'platform' AND ${currentOrganizationAdminSql}
        AND EXISTS (SELECT 1 FROM agent_hosts host JOIN host_actual_state actual ON actual.host_id = host.id
          WHERE host.id = ?3 AND host.organization_id = ?2 AND host.scope = 'organization' AND host.disabled = 0
            AND host.scenario_enabled = 1 AND host.connected = 1 AND host.active_session_id = ?4
            AND host.credential_generation = ?5 AND actual.report_json = ?6 AND actual.updated_at = ?7
            AND actual.updated_at >= CAST(unixepoch('subsecond') * 1000 AS INTEGER) - ${HOST_DEGRADED_AFTER_MS}
            AND host.last_heartbeat_at >= CAST(unixepoch('subsecond') * 1000 AS INTEGER) - 90000)`)
      .bind(...args, snapshot.sessionId, snapshot.generation, JSON.stringify(snapshot.report), snapshot.reportedAt));
  }
  const [updated] = await d1.batch(statements);
  if (!updated?.results.length) {
    if (resume && await d1.prepare(`SELECT id FROM agent_hosts WHERE id = ?3 AND organization_id = ?2
      AND scope = 'organization' AND disabled = 0 AND ${currentOrganizationAdminSql}`).bind(...args).first()) {
      throw appError(409, "server_status_changed", "Server status changed. Try resume again.");
    }
    throw appError(404, "server_not_found", "Server not found or access changed. Reload organization servers.");
  }
}

export async function cancelOrganizationEnrollment(d1: D1Database, context: UserContext, organizationId: string, enrollmentId: string) {
  const canceled = await d1.prepare(`UPDATE host_enrollments SET revoked_at = ?4
    WHERE host_id = ?3 AND organization_id = ?2 AND scope = 'organization' AND claimed_at IS NULL
      AND ${currentOrganizationAdminSql} RETURNING host_id`)
    .bind(...actorArgs(context, organizationId), enrollmentId, Date.now()).first();
  if (!canceled) throw appError(409, "enrollment_changed", "Setup already completed or access changed. Reload organization servers.");
}

/** Persist revocation and shutdown intent together, then use the shared host cleanup. */
export async function removeOrganizationServer(d1: D1Database, context: UserContext, organizationId: string, hostId: string, confirmReturnToCloud: boolean) {
  const args = [...actorArgs(context, organizationId), hostId] as const;
  const now = Date.now();
  const removalId = crypto.randomUUID();
  const owned = `id = ?3 AND organization_id = ?2 AND scope = 'organization' AND ${currentOrganizationAdminSql}`;
  const retired = `EXISTS (SELECT 1 FROM agent_hosts WHERE ${owned} AND disabled = 1 AND owner_removal_id IS NOT NULL)`;
  const [removed] = await d1.batch([
    d1.prepare(`UPDATE agent_hosts SET disabled = 1, scenario_enabled = 0, connected = 0,
      active_session_id = NULL, disconnected_at = ?4, updated_at = ?4,
      credential_generation = credential_generation + CASE WHEN disabled = 0 THEN 1 ELSE 0 END, owner_removal_id = ?5
      WHERE ${owned} AND (disabled = 0 OR owner_removal_id IS NULL) AND (?6 = 1
        OR NOT EXISTS (SELECT 1 FROM organization WHERE id = ?2 AND metal_placement = 'organization')
        OR EXISTS (SELECT 1 FROM agent_hosts other WHERE other.organization_id = ?2 AND other.scope = 'organization' AND other.disabled = 0 AND other.id <> ?3))
      RETURNING id`).bind(...args, now, removalId, confirmReturnToCloud ? 1 : 0),
    d1.prepare(`UPDATE organization SET metal_placement = 'platform' WHERE id = ?2
      AND EXISTS (SELECT 1 FROM agent_hosts WHERE ${owned} AND owner_removal_id = ?4)
      AND NOT EXISTS (SELECT 1 FROM agent_hosts WHERE organization_id = ?2 AND scope = 'organization' AND disabled = 0)`)
      .bind(...args, removalId),
    d1.prepare(`UPDATE agent_bootstrap_tokens SET revoked_at = ?4 WHERE host_id = ?3 AND revoked_at IS NULL AND ${retired}`).bind(...args, now),
    d1.prepare(`UPDATE host_enrollments SET revoked_at = ?4 WHERE host_id = ?3 AND revoked_at IS NULL AND ${retired}`).bind(...args, now),
    d1.prepare(`UPDATE runtime_executions SET lease_expires_at = ?4, updated_at = ?4
      WHERE host_id = ?3 AND state <> 'archived' AND lease_expires_at IS NULL AND ${retired}`).bind(...args, now),
    d1.prepare(`UPDATE scenario_runs SET delete_requested_at = coalesce(delete_requested_at, ?4), updated_at = ?4
      WHERE host_id = ?3 AND state NOT IN ('completed', 'failed') AND ${retired}`).bind(...args, now),
  ]);
  const result = await d1.prepare(`SELECT host.disabled, host.owner_removal_id, organization.metal_placement AS placement
    FROM agent_hosts host JOIN organization ON organization.id = host.organization_id
    WHERE host.id = ?3 AND host.organization_id = ?2 AND host.scope = 'organization' AND ${currentOrganizationAdminSql}`)
    .bind(...args).first<{ disabled: number; owner_removal_id: string | null; placement: "platform" | "organization" }>();
  if (!result) throw appError(404, "server_not_found", "Server not found or access changed. Reload organization servers.");
  if (!removed?.results.length && (!result.disabled || !result.owner_removal_id)) {
    throw appError(409, "last_server_confirmation_required", "This is the last organization server. Confirm removal to use cloud for new runs.");
  }
  try { await cleanupRemovedHost(hostId); }
  catch { throw appError(503, "server_cleanup_pending", "Server access is revoked. Retry removal to finish closing sessions."); }
  const completed = await d1.prepare(`UPDATE agent_hosts SET owner_removal_completed_at = coalesce(owner_removal_completed_at, ?4)
    WHERE ${owned} AND disabled = 1 AND owner_removal_id IS NOT NULL RETURNING id`)
    .bind(...args, Date.now()).first();
  if (!completed) throw appError(409, "server_access_changed", "Server access changed. Reload organization servers.");
  return { removed: true, placement: result.placement, physicalCleanup: "unconfirmed" } as const;
}
