import { env } from "cloudflare:workers";
import { AppError, appError, errorChainMatches } from "@/lib/app-error";
import { createAppId } from "@/lib/id";
import { archiveRuntimeExecution } from "@/lib/runtime-executions";
import {
  deleteStargateRoute,
  deleteStargateWorkspaceAppRoute,
} from "@/lib/stargate";
import { markRuntimeExecutionDesiredAbsent } from "./runtime-orchestrator";
import { WORKSHOP_ROUTE_ISSUANCE_PENDING_LEASE_MS } from "./route-issuance-intents";

interface WorkshopMembershipAccessRow {
  session_id: string;
  role: "participant" | "helper" | "facilitator";
  workspace_id: string | null;
  terminal_route_usernames_json: string | string[] | null;
  application_route_ids_json: string | string[] | null;
}

interface WorkshopMembershipGrantRow {
  id: string;
  session_id: string;
  workspace_id: string;
  terminal_route_usernames_json: string | string[];
}

interface WorkshopRouteIssuanceIntentRow {
  id: string;
  kind: "terminal" | "application";
  route_key: string;
  alternate_route_key: string | null;
  state: "pending" | "issued" | "cancelled";
  capability_expires_at: number;
  created_at: number;
}

interface WorkshopDomainExecutionRow {
  id: string;
  workspace_id: string;
  generation: number;
}

/**
 * Revokes externally usable live-workshop capabilities before organization
 * membership is removed. Callers must delete the membership only after this
 * succeeds; any Stargate or runtime cleanup failure is deliberately fatal.
 */
export async function revokeLiveWorkshopAccessForOrganizationMember(input: {
  organizationId: string;
  userId: string;
  actorUserId: string;
  now?: number;
}): Promise<void> {
  const now = input.now ?? Date.now();
  const [accessResult, grantResult, intentResult] = await Promise.all([
    env.DB.prepare(
      `SELECT
         session.id AS session_id,
         roster.role,
         workspace.id AS workspace_id,
         workspace.terminal_route_usernames_json,
         workspace.application_route_ids_json
       FROM workshop_session_members roster
       JOIN workshop_sessions session ON session.id = roster.session_id
       LEFT JOIN workshop_workspaces workspace
         ON workspace.session_id = session.id AND workspace.user_id = roster.user_id
       WHERE session.organization_id = ?
         AND roster.user_id = ?`,
    )
      .bind(input.organizationId, input.userId)
      .all<WorkshopMembershipAccessRow>(),
    env.DB.prepare(
      `SELECT grant_record.id, grant_record.session_id, grant_record.workspace_id,
              grant_record.terminal_route_usernames_json
       FROM workshop_assist_grants grant_record
       JOIN workshop_sessions session ON session.id = grant_record.session_id
       WHERE session.organization_id = ?
         AND (
           grant_record.revoked_at IS NULL
           OR json_array_length(grant_record.terminal_route_usernames_json) > 0
         )
         AND (grant_record.learner_user_id = ? OR grant_record.helper_user_id = ?)`,
    )
      .bind(input.organizationId, input.userId, input.userId)
      .all<WorkshopMembershipGrantRow>(),
    env.DB.prepare(
      `SELECT intent.id, intent.kind, intent.route_key,
              intent.alternate_route_key, intent.state,
              intent.capability_expires_at, intent.created_at
       FROM workshop_route_issuance_intents intent
       JOIN workshop_workspaces workspace ON workspace.id = intent.workspace_id
       WHERE intent.organization_id = ?
         AND (intent.actor_user_id = ? OR workspace.user_id = ?)`,
    )
      .bind(input.organizationId, input.userId, input.userId)
      .all<WorkshopRouteIssuanceIntentRow>(),
  ]);

  const accessRows = accessResult.results;
  const grantRows = grantResult.results;
  let intentRows = intentResult.results;
  const stalePendingIntentIds = intentRows.flatMap((intent) =>
    intent.state === "pending" &&
    intent.created_at + WORKSHOP_ROUTE_ISSUANCE_PENDING_LEASE_MS <= now
      ? [intent.id]
      : [],
  );
  if (stalePendingIntentIds.length) {
    await env.DB.prepare(
      `UPDATE workshop_route_issuance_intents
       SET state = 'cancelled', updated_at = ?
       WHERE id IN (${stalePendingIntentIds.map(() => "?").join(", ")})
         AND state = 'pending'`,
    )
      .bind(now, ...stalePendingIntentIds)
      .run();
    intentRows = (
      await loadMembershipRouteIntents(input.organizationId, input.userId)
    ).results;
  }
  if (!accessRows.length && !grantRows.length && !intentRows.length) return;

  const participantWorkspaceIds = new Set(
    accessRows.flatMap((row) =>
      row.role === "participant" && row.workspace_id ? [row.workspace_id] : [],
    ),
  );
  const terminalRoutes = new Set<string>();
  const applicationRoutes = new Set<string>();
  const assistRoutesByWorkspace = new Map<string, Set<string>>();
  for (const row of accessRows) {
    if (!row.workspace_id || row.role !== "participant") continue;
    for (const route of jsonStrings(row.terminal_route_usernames_json)) {
      terminalRoutes.add(route);
    }
    for (const route of jsonStrings(row.application_route_ids_json)) {
      applicationRoutes.add(route);
    }
  }
  for (const grant of grantRows) {
    const workspaceRoutes = assistRoutesByWorkspace.get(grant.workspace_id) ??
      new Set<string>();
    for (const route of jsonStrings(grant.terminal_route_usernames_json)) {
      terminalRoutes.add(route);
      workspaceRoutes.add(route);
    }
    assistRoutesByWorkspace.set(grant.workspace_id, workspaceRoutes);
  }
  for (const intent of intentRows) {
    if (intent.state === "pending") continue;
    const routes = [intent.route_key, intent.alternate_route_key].filter(
      (route): route is string => Boolean(route?.trim()),
    );
    const target =
      intent.kind === "terminal" ? terminalRoutes : applicationRoutes;
    for (const route of routes) target.add(route);
  }

  // Delete externally usable capabilities first. A partial failure keeps the
  // organization membership intact and a retry safely repeats 404 deletions.
  await Promise.all([
    ...[...terminalRoutes].map((route) => deleteStargateRoute(route)),
    ...[...applicationRoutes].map((route) =>
      deleteStargateWorkspaceAppRoute(route),
    ),
  ]);

  const domainExecutionRows = participantWorkspaceIds.size
    ? (
        await env.DB.prepare(
          `SELECT id, domain_id AS workspace_id, generation
           FROM runtime_executions
           WHERE domain_kind = 'workshop'
             AND domain_id IN (${[...participantWorkspaceIds]
               .map(() => "?")
               .join(", ")})
           ORDER BY domain_id, generation`,
        )
          .bind(...participantWorkspaceIds)
          .all<WorkshopDomainExecutionRow>()
      ).results
    : [];
  for (const execution of domainExecutionRows) {
    await markRuntimeExecutionDesiredAbsent(execution.id, now);
    try {
      await archiveRuntimeExecution({
        executionId: execution.id,
        expectedGeneration: execution.generation,
        endedAt: now,
      });
    } catch (error) {
      if (!isIgnorableArchivedGeneration(error)) throw error;
    }
  }

  const statements: D1PreparedStatement[] = [];
  const removableIntentRows = intentRows.filter(
    (intent) => intent.state !== "pending",
  );
  if (removableIntentRows.length) {
    statements.push(
      env.DB.prepare(
        `DELETE FROM workshop_route_issuance_intents
         WHERE id IN (${removableIntentRows.map(() => "?").join(", ")})`,
      ).bind(...removableIntentRows.map((intent) => intent.id)),
    );
  }
  const executionIds = domainExecutionRows.map((execution) => execution.id);
  if (executionIds.length) {
    statements.push(
      env.DB.prepare(
        `UPDATE runtime_terminal_sessions
         SET ended_at = coalesce(ended_at, max(started_at, ?)), updated_at = ?
         WHERE execution_id IN (${executionIds.map(() => "?").join(", ")})
           AND ended_at IS NULL`,
      ).bind(now, now, ...executionIds),
    );
  }
  if (grantRows.length) {
    statements.push(
      env.DB.prepare(
        `UPDATE workshop_assist_grants
         SET revoked_at = coalesce(revoked_at, ?),
             revoked_by = coalesce(revoked_by, ?),
             terminal_route_usernames_json = '[]',
             updated_at = ?
         WHERE id IN (${grantRows.map(() => "?").join(", ")})`,
      ).bind(now, input.actorUserId, now, ...grantRows.map((row) => row.id)),
    );
  }
  for (const workspaceId of participantWorkspaceIds) {
    statements.push(
      env.DB.prepare(
        `UPDATE workshop_workspaces
         SET state = 'ended', terminal_route_usernames_json = '[]',
             application_route_ids_json = '[]', ended_at = coalesce(ended_at, ?),
             updated_at = ?
         WHERE id = ?`,
      ).bind(now, now, workspaceId),
      env.DB.prepare(
        `UPDATE workshop_workspace_generations
         SET state = 'archived', archive_requested_at = coalesce(archive_requested_at, ?),
             archived_at = coalesce(archived_at, ?), updated_at = ?
         WHERE workspace_id = ?`,
      ).bind(now, now, now, workspaceId),
    );
  }
  for (const [workspaceId, routes] of assistRoutesByWorkspace) {
    if (participantWorkspaceIds.has(workspaceId) || routes.size === 0) continue;
    const routesJson = JSON.stringify([...routes]);
    statements.push(
      env.DB.prepare(
        `UPDATE workshop_workspaces
         SET terminal_route_usernames_json = coalesce(
               (SELECT json_group_array(value)
                FROM json_each(terminal_route_usernames_json)
                WHERE value NOT IN (SELECT value FROM json_each(?))),
               '[]'
             ),
             updated_at = ?
         WHERE id = ?`,
      ).bind(routesJson, now, workspaceId),
    );
  }
  statements.push(
    env.DB.prepare(
      `UPDATE workshop_help_requests
       SET status = 'cancelled', active_key = NULL,
           cancelled_at = coalesce(cancelled_at, ?), updated_at = ?
       WHERE requester_user_id = ?
         AND session_id IN (
           SELECT id FROM workshop_sessions WHERE organization_id = ?
         )
         AND status IN ('open', 'claimed')`,
    ).bind(now, now, input.userId, input.organizationId),
    env.DB.prepare(
      `UPDATE workshop_help_requests
       SET status = 'open', claimed_by = NULL, claimed_at = NULL, updated_at = ?
       WHERE claimed_by = ?
         AND requester_user_id <> ?
         AND session_id IN (
           SELECT id FROM workshop_sessions WHERE organization_id = ?
         )
         AND status = 'claimed'`,
    ).bind(now, input.userId, input.userId, input.organizationId),
  );
  const sessionIds = [
    ...new Set([
      ...accessRows.map((row) => row.session_id),
      ...grantRows.map((row) => row.session_id),
    ]),
  ];
  const participantSessionIds = [
    ...new Set(
      accessRows.flatMap((row) =>
        row.role === "participant" ? [row.session_id] : [],
      ),
    ),
  ];
  if (participantSessionIds.length) {
    statements.push(
      env.DB.prepare(
        `UPDATE workshop_session_members
         SET provision_state = 'ended', updated_at = ?
         WHERE user_id = ? AND session_id IN (${participantSessionIds
           .map(() => "?")
           .join(", ")})`,
      ).bind(now, input.userId, ...participantSessionIds),
    );
  }
  for (const sessionId of sessionIds) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO workshop_events
           (id, organization_id, session_id, actor_user_id, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, 'membership.access_revoked', ?, ?)`,
      ).bind(
        createAppId(),
        input.organizationId,
        sessionId,
        input.actorUserId,
        JSON.stringify({ userId: input.userId }),
        now,
      ),
    );
  }
  if (statements.length) await env.DB.batch(statements);
  if (intentRows.some((intent) => intent.state === "pending")) {
    throw appError(
      409,
      "workshop_route_issuance_in_progress",
      "a workshop route is still being issued; retry membership removal",
    );
  }
}

function jsonStrings(value: string | string[] | null): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string =>
      typeof entry === "string" && Boolean(entry.trim()),
    );
  }
  if (typeof value !== "string") return [];
  try {
    return jsonStrings(JSON.parse(value) as string[]);
  } catch {
    return [];
  }
}

function loadMembershipRouteIntents(
  organizationId: string,
  userId: string,
): Promise<D1Result<WorkshopRouteIssuanceIntentRow>> {
  return env.DB.prepare(
    `SELECT intent.id, intent.kind, intent.route_key,
            intent.alternate_route_key, intent.state,
            intent.capability_expires_at, intent.created_at
     FROM workshop_route_issuance_intents intent
     JOIN workshop_workspaces workspace ON workspace.id = intent.workspace_id
     WHERE intent.organization_id = ?
       AND (intent.actor_user_id = ? OR workspace.user_id = ?)`,
  )
    .bind(organizationId, userId, userId)
    .all<WorkshopRouteIssuanceIntentRow>();
}

function isIgnorableArchivedGeneration(error: unknown): boolean {
  return (
    (error instanceof AppError &&
      (error.code === "runtime_generation_stale" ||
        error.code === "runtime_execution_not_found")) ||
    errorChainMatches(error, /runtime execution not found/)
  );
}
