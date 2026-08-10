import { and, eq, sql } from "drizzle-orm";
import {
  member,
  runtimeExecutions,
  workshopSessions,
  workshopWorkspaceGenerations,
  workshopWorkspaces,
} from "@/db/schema";
import { appError } from "@/lib/app-error";
import { loadCurrentRuntimeVmTerminalTarget } from "@/lib/runtime-executions";
import {
  deleteStargateWorkspaceAppRoute,
  issueStargateWorkspaceAppSession,
  StargateWorkspaceAppInvalidResponseError,
  StargateWorkspaceAppRouteConflictError,
  type StargateWorkspaceAppSessionResult,
} from "@/lib/stargate";
import {
  appendWorkshopEvent,
  loadWorkshopManifestForSession,
  requireWorkshopSessionMember,
  workshopDb,
} from "./shared";
import {
  completeWorkshopRouteIssuanceIntent,
  markWorkshopRouteIssuanceIntentIssued,
  reserveWorkshopApplicationRouteIssuanceIntent,
} from "./route-issuance-intents";
import { createWorkspaceAppRouteId } from "./workspace-app-route-id";

const WORKSPACE_APP_TTL_MS = 15 * 60_000;
const WORKSPACE_APP_ROUTE_ISSUANCE_ATTEMPTS = 8;

/**
 * Opens one template-declared browser application for the participant who owns
 * the current workspace generation. Helpers deliberately cannot use this path:
 * v1 assistance is browser-terminal-only and consent-bound.
 */
export async function issueWorkshopWorkspaceApplication(input: {
  sessionId: string;
  workspaceId: string;
  applicationId: string;
  actorUserId: string;
}): Promise<StargateWorkspaceAppSessionResult> {
  const access = await requireWorkshopSessionMember({
    sessionId: input.sessionId,
    userId: input.actorUserId,
  });
  if (!access.workspaceEnabled) {
    throw appError(
      403,
      "workshop_application_participant_only",
      "workspace applications are available only to their participant owner",
    );
  }
  if (access.state !== "lobby" && access.state !== "live") {
    throw appError(
      409,
      "workshop_application_closed",
      "workspace applications are available only while the room is open",
    );
  }

  const db = workshopDb();
  const [context, rows] = await Promise.all([
    loadWorkshopManifestForSession(input.sessionId),
    db
      .select({
        workspaceId: workshopWorkspaces.id,
        workspaceUserId: workshopWorkspaces.userId,
        workspaceState: workshopWorkspaces.state,
        generationId: workshopWorkspaceGenerations.id,
        generationOrdinal: workshopWorkspaceGenerations.ordinal,
        generationState: workshopWorkspaceGenerations.state,
        runtimeExecutionId: workshopWorkspaceGenerations.runtimeExecutionId,
        releasedModuleIds: workshopSessions.releasedModuleIdsJson,
      })
      .from(workshopWorkspaces)
      .innerJoin(
        workshopWorkspaceGenerations,
        eq(
          workshopWorkspaces.currentGenerationId,
          workshopWorkspaceGenerations.id,
        ),
      )
      .innerJoin(
        workshopSessions,
        eq(workshopWorkspaces.sessionId, workshopSessions.id),
      )
      .where(
        and(
          eq(workshopWorkspaces.id, input.workspaceId),
          eq(workshopWorkspaces.sessionId, input.sessionId),
          eq(workshopWorkspaces.userId, input.actorUserId),
        ),
      )
      .limit(1),
  ]);
  const workspace = rows[0];
  if (!workspace) {
    throw appError(
      404,
      "workshop_workspace_not_found",
      "workshop workspace not found",
    );
  }
  if (
    workspace.workspaceState !== "ready" ||
    workspace.generationState !== "ready" ||
    !workspace.runtimeExecutionId
  ) {
    throw appError(
      409,
      "workshop_application_not_ready",
      "the workshop workspace is still warming up",
    );
  }
  const application = context.manifest.workspace.applications.find(
    (candidate) => candidate.id === input.applicationId,
  );
  if (!application) {
    throw appError(
      404,
      "workshop_application_not_found",
      "workshop application not found",
    );
  }
  if (
    application.releaseModuleId &&
    !workspace.releasedModuleIds.includes(application.releaseModuleId)
  ) {
    throw appError(
      409,
      "workshop_application_not_released",
      "this workspace application has not been released",
    );
  }
  if (application.protocol !== "http" && application.protocol !== "ws") {
    throw appError(
      409,
      "workshop_application_protocol_unsupported",
      "the declared workspace application protocol is not supported",
    );
  }

  const target = await loadCurrentRuntimeVmTerminalTarget({
    executionId: workspace.runtimeExecutionId,
    expectedGeneration: workspace.generationOrdinal,
    vmId: application.vmId,
  });
  if (
    target.domainKind !== "workshop" ||
    target.domainId !== workspace.workspaceId ||
    target.userId !== input.actorUserId ||
    target.organizationId !== access.organizationId
  ) {
    throw appError(
      409,
      "workshop_runtime_identity_mismatch",
      "workshop runtime execution does not belong to this workspace",
    );
  }

  const requestedExpiresAt = Date.now() + WORKSPACE_APP_TTL_MS;
  let routeId: string | undefined;
  let intentId: string | undefined;
  let opened: StargateWorkspaceAppSessionResult | undefined;
  for (
    let attempt = 0;
    attempt < WORKSPACE_APP_ROUTE_ISSUANCE_ATTEMPTS;
    attempt += 1
  ) {
    const candidateRouteId = createWorkspaceAppRouteId();
    const reservation =
      await reserveWorkshopApplicationRouteIssuanceIntent({
        organizationId: access.organizationId,
        sessionId: input.sessionId,
        workspaceId: workspace.workspaceId,
        generationId: workspace.generationId,
        actorUserId: input.actorUserId,
        routeKey: candidateRouteId,
        capabilityExpiresAt: requestedExpiresAt,
      });
    if (reservation.status === "collision") continue;
    if (reservation.status === "unauthorized") {
      throw appError(
        409,
        "workshop_application_authorization_changed",
        "workshop application authorization changed while the route was opening",
      );
    }
    try {
      opened = await issueStargateWorkspaceAppSession({
        routeId: candidateRouteId,
        createOnly: true,
        targetUsername: target.target.username,
        targetHost: target.target.host,
        targetSshPort: target.target.port,
        targetHostKeyOpenssh: target.target.hostKeyOpenssh,
        targetPrivateKeyOpenssh: target.target.privateKeyOpenssh,
        targetAppPort: application.port,
        ...(application.upstreamHost === undefined
          ? {}
          : { upstreamHost: application.upstreamHost }),
        expiresAt: new Date(requestedExpiresAt),
        metadata: {
          hostId: target.hostId,
          runId: target.executionId,
          vmId: target.vmId,
          userId: input.actorUserId,
        },
      });
    } catch (error) {
      if (error instanceof StargateWorkspaceAppRouteConflictError) {
        await completeWorkshopRouteIssuanceIntent(reservation.intentId);
        continue;
      }
      if (error instanceof StargateWorkspaceAppInvalidResponseError) {
        await markWorkshopRouteIssuanceIntentIssued({
          intentId: reservation.intentId,
          routeKey: candidateRouteId,
        });
        await deleteStargateWorkspaceAppRoute(candidateRouteId);
      }
      // A transport or non-success response cannot prove whether create-only
      // inserted our candidate or found someone else's existing route. Never
      // delete in that ambiguous case; an unreachable route we created expires
      // after the bounded application TTL.
      await completeWorkshopRouteIssuanceIntent(reservation.intentId);
      throw error;
    }
    routeId = candidateRouteId;
    intentId = reservation.intentId;
    break;
  }
  if (!routeId || !intentId || !opened) {
    throw appError(
      503,
      "workshop_application_route_unavailable",
      "could not reserve a workspace application address; retry",
    );
  }
  const intentIssued = await markWorkshopRouteIssuanceIntentIssued({
    intentId,
    routeKey: routeId,
  });
  if (!intentIssued) {
    await deleteStargateWorkspaceAppRoute(routeId);
    await completeWorkshopRouteIssuanceIntent(intentId);
    throw appError(
      409,
      "workshop_application_authorization_changed",
      "workshop application authorization changed while the route was opening",
    );
  }
  if (
    opened.routeId !== routeId ||
    opened.expiresAt > requestedExpiresAt ||
    opened.expiresAt <= Date.now()
  ) {
    await deleteStargateWorkspaceAppRoute(routeId);
    await completeWorkshopRouteIssuanceIntent(intentId);
    throw appError(
      502,
      "workshop_application_expiry_invalid",
      "the workspace application gateway returned an invalid session expiry",
    );
  }
  const now = Date.now();
  const recorded = await db
    .update(workshopWorkspaces)
    .set({
      applicationRouteIdsJson: sql`case
        when exists (
          select 1 from json_each(${workshopWorkspaces.applicationRouteIdsJson})
          where value = ${opened.routeId}
        ) then ${workshopWorkspaces.applicationRouteIdsJson}
        else json_insert(${workshopWorkspaces.applicationRouteIdsJson}, '$[#]', ${opened.routeId})
      end`,
      updatedAt: now,
    })
    .where(
      and(
        eq(workshopWorkspaces.id, workspace.workspaceId),
        eq(workshopWorkspaces.sessionId, input.sessionId),
        eq(workshopWorkspaces.userId, input.actorUserId),
        eq(workshopWorkspaces.currentGenerationId, workspace.generationId),
        eq(workshopWorkspaces.state, "ready"),
        sql`exists (
          select 1
          from ${workshopWorkspaceGenerations}
          join ${runtimeExecutions}
            on ${runtimeExecutions.id} = ${workshopWorkspaceGenerations.runtimeExecutionId}
          where ${workshopWorkspaceGenerations.id} = ${workspace.generationId}
            and ${workshopWorkspaceGenerations.workspaceId} = ${workspace.workspaceId}
            and ${workshopWorkspaceGenerations.state} = 'ready'
            and ${runtimeExecutions.id} = ${target.executionId}
            and ${runtimeExecutions.domainKind} = 'workshop'
            and ${runtimeExecutions.domainId} = ${workspace.workspaceId}
            and ${runtimeExecutions.state} = 'ready'
        )`,
        sql`exists (
          select 1
          from ${workshopSessions}
          join ${member}
            on ${member.organizationId} = ${workshopSessions.organizationId}
           and ${member.userId} = ${input.actorUserId}
          where ${workshopSessions.id} = ${input.sessionId}
            and ${workshopSessions.organizationId} = ${access.organizationId}
            and ${workshopSessions.state} in ('lobby', 'live')
            and ${member.workshopAccessRevokingAt} is null
            and exists (
              select 1
              from access_allowlist beta_access
              where beta_access.user_id = ${input.actorUserId}
                and beta_access.state = 'active'
            )
        )`,
      ),
    )
    .returning({ id: workshopWorkspaces.id });
  if (!recorded[0]) {
    await deleteStargateWorkspaceAppRoute(routeId);
    await completeWorkshopRouteIssuanceIntent(intentId);
    throw appError(
      409,
      "workshop_application_authorization_changed",
      "workshop application authorization changed while the route was opening",
    );
  }
  await completeWorkshopRouteIssuanceIntent(intentId);
  await appendWorkshopEvent(db, {
    organizationId: access.organizationId,
    sessionId: input.sessionId,
    actorUserId: input.actorUserId,
    type: "application.opened",
    payload: {
      workspaceId: workspace.workspaceId,
      generationId: workspace.generationId,
      runtimeExecutionId: target.executionId,
      applicationId: application.id,
      vmId: application.vmId,
      port: application.port,
      upstreamHost: application.upstreamHost ?? null,
      routeId: opened.routeId,
      expiresAt: opened.expiresAt,
    },
    createdAt: now,
  });
  return opened;
}
