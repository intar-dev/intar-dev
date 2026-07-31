import { env } from "cloudflare:workers";
import { appError } from "@/lib/app-error";
import { createAppId } from "@/lib/id";
import {
  deleteStargateRoute,
  deleteStargateWorkspaceAppRoute,
} from "@/lib/stargate";

export type WorkshopRouteIssuanceKind = "terminal" | "application";
export const WORKSHOP_ROUTE_ISSUANCE_PENDING_LEASE_MS = 2 * 60_000;

export type WorkshopApplicationRouteReservation =
  | { status: "reserved"; intentId: string }
  | { status: "collision" }
  | { status: "unauthorized" };

export async function reserveWorkshopApplicationRouteIssuanceIntent(input: {
  organizationId: string;
  sessionId: string;
  workspaceId: string;
  generationId: string;
  actorUserId: string;
  routeKey: string;
  capabilityExpiresAt: number;
  now?: number;
}): Promise<WorkshopApplicationRouteReservation> {
  const id = createAppId();
  const now = input.now ?? Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO workshop_route_issuance_intents
       (id, organization_id, session_id, workspace_id, generation_id,
        actor_user_id, kind, route_key, state, capability_expires_at,
        created_at, updated_at)
     SELECT ?, session.organization_id, session.id, workspace.id, generation.id,
            ?, 'application', ?, 'pending', ?, ?, ?
     FROM workshop_sessions session
     JOIN workshop_workspaces workspace ON workspace.session_id = session.id
     JOIN workshop_workspace_generations generation
       ON generation.id = workspace.current_generation_id
     JOIN member organization_member
       ON organization_member.organization_id = session.organization_id
      AND organization_member.user_id = ?
     JOIN member workspace_member
       ON workspace_member.organization_id = session.organization_id
      AND workspace_member.user_id = workspace.user_id
     WHERE session.id = ?
       AND session.organization_id = ?
       AND session.state IN ('lobby', 'live')
       AND workspace.id = ?
       AND workspace.current_generation_id = ?
       AND workspace.state = 'ready'
       AND generation.state = 'ready'
       AND organization_member.workshop_access_revoking_at IS NULL
       AND workspace_member.workshop_access_revoking_at IS NULL
       AND NOT EXISTS (
         SELECT 1
         FROM workshop_workspaces recorded_workspace,
              json_each(recorded_workspace.application_route_ids_json) recorded_route
         WHERE CAST(recorded_route.value AS TEXT) = ?
       )
     ON CONFLICT(kind, route_key) DO NOTHING
     RETURNING id`,
  )
    .bind(
      id,
      input.actorUserId,
      input.routeKey,
      input.capabilityExpiresAt,
      now,
      now,
      input.actorUserId,
      input.sessionId,
      input.organizationId,
      input.workspaceId,
      input.generationId,
      input.routeKey,
    )
    .first<{ id: string }>();
  if (row) return { status: "reserved", intentId: row.id };

  const authorized = await env.DB.prepare(
    `SELECT 1 AS authorized
     FROM workshop_sessions session
     JOIN workshop_workspaces workspace ON workspace.session_id = session.id
     JOIN workshop_workspace_generations generation
       ON generation.id = workspace.current_generation_id
     JOIN member organization_member
       ON organization_member.organization_id = session.organization_id
      AND organization_member.user_id = ?
     JOIN member workspace_member
       ON workspace_member.organization_id = session.organization_id
      AND workspace_member.user_id = workspace.user_id
     WHERE session.id = ?
       AND session.organization_id = ?
       AND session.state IN ('lobby', 'live')
       AND workspace.id = ?
       AND workspace.current_generation_id = ?
       AND workspace.state = 'ready'
       AND generation.state = 'ready'
       AND organization_member.workshop_access_revoking_at IS NULL
       AND workspace_member.workshop_access_revoking_at IS NULL
     LIMIT 1`,
  )
    .bind(
      input.actorUserId,
      input.sessionId,
      input.organizationId,
      input.workspaceId,
      input.generationId,
    )
    .first<{ authorized: number }>();
  return authorized ? { status: "collision" } : { status: "unauthorized" };
}

export async function beginWorkshopRouteIssuanceIntent(input: {
  organizationId: string;
  sessionId: string;
  workspaceId: string;
  generationId: string;
  actorUserId: string;
  kind: WorkshopRouteIssuanceKind;
  routeKey: string;
  capabilityExpiresAt: number;
  now?: number;
}): Promise<string | null> {
  const id = createAppId();
  const now = input.now ?? Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO workshop_route_issuance_intents
       (id, organization_id, session_id, workspace_id, generation_id,
        actor_user_id, kind, route_key, state, capability_expires_at,
        created_at, updated_at)
     SELECT ?, session.organization_id, session.id, workspace.id, generation.id,
            ?, ?, ?, 'pending', ?, ?, ?
     FROM workshop_sessions session
     JOIN workshop_workspaces workspace ON workspace.session_id = session.id
     JOIN workshop_workspace_generations generation
       ON generation.id = workspace.current_generation_id
     JOIN member organization_member
       ON organization_member.organization_id = session.organization_id
      AND organization_member.user_id = ?
     JOIN member workspace_member
       ON workspace_member.organization_id = session.organization_id
      AND workspace_member.user_id = workspace.user_id
     WHERE session.id = ?
       AND session.organization_id = ?
       AND session.state IN ('lobby', 'live')
       AND workspace.id = ?
       AND workspace.current_generation_id = ?
       AND workspace.state = 'ready'
       AND generation.state = 'ready'
       AND organization_member.workshop_access_revoking_at IS NULL
       AND workspace_member.workshop_access_revoking_at IS NULL
     RETURNING id`,
  )
    .bind(
      id,
      input.actorUserId,
      input.kind,
      input.routeKey,
      input.capabilityExpiresAt,
      now,
      now,
      input.actorUserId,
      input.sessionId,
      input.organizationId,
      input.workspaceId,
      input.generationId,
    )
    .first<{ id: string }>();
  return row?.id ?? null;
}

export async function markWorkshopRouteIssuanceIntentIssued(input: {
  intentId: string;
  routeKey: string;
  alternateRouteKey?: string | null;
  now?: number;
}): Promise<boolean> {
  const row = await env.DB.prepare(
    `UPDATE workshop_route_issuance_intents
     SET state = 'issued', alternate_route_key = ?, updated_at = ?
     WHERE id = ? AND route_key = ? AND state = 'pending'
     RETURNING id`,
  )
    .bind(
      input.alternateRouteKey ?? null,
      input.now ?? Date.now(),
      input.intentId,
      input.routeKey,
    )
    .first<{ id: string }>();
  return Boolean(row);
}

export async function completeWorkshopRouteIssuanceIntent(
  intentId: string,
): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM workshop_route_issuance_intents WHERE id = ?",
  )
    .bind(intentId)
    .run();
}

export async function revokeWorkshopRouteIssuanceIntents(input: {
  workspaceId: string;
  actorUserId?: string;
  kind?: WorkshopRouteIssuanceKind;
}): Promise<void> {
  const now = Date.now();
  const clauses = ["workspace_id = ?"];
  const bindings: string[] = [input.workspaceId];
  if (input.actorUserId) {
    clauses.push("actor_user_id = ?");
    bindings.push(input.actorUserId);
  }
  if (input.kind) {
    clauses.push("kind = ?");
    bindings.push(input.kind);
  }
  const result = await env.DB.prepare(
    `SELECT id, kind, route_key, alternate_route_key, state,
            capability_expires_at, created_at
     FROM workshop_route_issuance_intents
     WHERE ${clauses.join(" AND ")}`,
  )
    .bind(...bindings)
    .all<{
      id: string;
      kind: WorkshopRouteIssuanceKind;
      route_key: string;
      alternate_route_key: string | null;
      state: "pending" | "issued" | "cancelled";
      capability_expires_at: number;
      created_at: number;
    }>();
  if (!result.results.length) return;
  const stalePending = result.results.filter(
    (intent) =>
      intent.state === "pending" &&
      intent.created_at + WORKSHOP_ROUTE_ISSUANCE_PENDING_LEASE_MS <= now,
  );
  if (stalePending.length) {
    await env.DB.prepare(
      `UPDATE workshop_route_issuance_intents
       SET state = 'cancelled', updated_at = ?
       WHERE id IN (${stalePending.map(() => "?").join(", ")})
         AND state = 'pending'`,
    )
      .bind(now, ...stalePending.map((intent) => intent.id))
      .run();
    for (const intent of stalePending) intent.state = "cancelled";
  }
  const deletableRoutes = result.results.filter(
    (intent) => intent.state !== "pending",
  );
  await Promise.all(
    deletableRoutes.flatMap((intent) =>
      [intent.route_key, intent.alternate_route_key]
        .filter((route): route is string => Boolean(route?.trim()))
        .map((route) =>
          intent.kind === "terminal"
            ? deleteStargateRoute(route)
            : deleteStargateWorkspaceAppRoute(route),
        ),
    ),
  );
  const removable = result.results.filter(
    (intent) => intent.state !== "pending",
  );
  if (removable.length) {
    await env.DB.prepare(
      `DELETE FROM workshop_route_issuance_intents
       WHERE id IN (${removable.map(() => "?").join(", ")})`,
    )
      .bind(...removable.map((intent) => intent.id))
      .run();
  }
  if (removable.length !== result.results.length) {
    throw appError(
      409,
      "workshop_route_issuance_in_progress",
      "a workshop route is still being issued; retry cleanup",
    );
  }
}
