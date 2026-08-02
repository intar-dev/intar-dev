import { and, eq, sql } from "drizzle-orm";
import {
  member,
  runtimeExecutions,
  workshopAssistGrants,
  workshopSessions,
  workshopWorkspaceGenerations,
  workshopWorkspaces,
} from "@/db/schema";
import { appError } from "@/lib/app-error";
import { loadCurrentRuntimeVmTerminalTarget } from "@/lib/runtime-executions";
import {
  deleteStargateRoute,
  issueStargateTerminalSession,
  stargateRouteTtlMs,
  type BrowserTerminalSessionResult,
  type NativeTerminalSessionResult,
  type StargateTerminalSessionResult,
} from "@/lib/stargate";
import { listUserAuthorizedSshKeysForNativeRoutes } from "@/lib/user-ssh-keys";
import { requireActiveWorkshopAssistGrant } from "./assistance";
import {
  appendWorkshopEvent,
  requireWorkshopSessionMember,
  workshopDb,
} from "./shared";
import {
  beginWorkshopRouteIssuanceIntent,
  completeWorkshopRouteIssuanceIntent,
  markWorkshopRouteIssuanceIntentIssued,
} from "./route-issuance-intents";
import { workshopTerminalRouteUsername } from "./terminal-routes";

export async function issueWorkshopBrowserTerminalSession(input: {
  sessionId: string;
  workspaceId: string;
  actorUserId: string;
  vmId?: string;
}): Promise<BrowserTerminalSessionResult> {
  const terminal = await issueWorkshopTerminalSession({
    ...input,
    mode: "browser",
  });
  if (!terminal.browser) {
    throw new Error("stargate returned a non-browser workshop terminal route");
  }
  return terminal;
}

export async function issueWorkshopNativeSshSession(input: {
  sessionId: string;
  workspaceId: string;
  actorUserId: string;
  vmId?: string;
}): Promise<NativeTerminalSessionResult> {
  const terminal = await issueWorkshopTerminalSession({
    ...input,
    mode: "native",
  });
  if (!terminal.native) {
    throw new Error("stargate returned a non-native workshop terminal route");
  }
  return terminal;
}

async function issueWorkshopTerminalSession(input: {
  sessionId: string;
  workspaceId: string;
  actorUserId: string;
  vmId?: string;
  mode: "browser" | "native";
}): Promise<StargateTerminalSessionResult> {
  const access = await requireWorkshopSessionMember({
    sessionId: input.sessionId,
    userId: input.actorUserId,
  });
  if (access.state !== "lobby" && access.state !== "live") {
    throw appError(
      409,
      "workshop_terminal_closed",
      "workshop terminal access is only available while the room is open",
    );
  }
  const db = workshopDb();
  const rows = await db
    .select({
      workspaceId: workshopWorkspaces.id,
      workspaceUserId: workshopWorkspaces.userId,
      workspaceState: workshopWorkspaces.state,
      generationId: workshopWorkspaceGenerations.id,
      generationOrdinal: workshopWorkspaceGenerations.ordinal,
      generationState: workshopWorkspaceGenerations.state,
      runtimeExecutionId: workshopWorkspaceGenerations.runtimeExecutionId,
    })
    .from(workshopWorkspaces)
    .innerJoin(
      workshopWorkspaceGenerations,
      eq(
        workshopWorkspaces.currentGenerationId,
        workshopWorkspaceGenerations.id,
      ),
    )
    .where(
      and(
        eq(workshopWorkspaces.id, input.workspaceId),
        eq(workshopWorkspaces.sessionId, input.sessionId),
      ),
    )
    .limit(1);
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
      "workshop_terminal_not_ready",
      "workshop terminal target is still warming up",
    );
  }

  if (
    input.mode === "native" &&
    (!access.workspaceEnabled ||
      workspace.workspaceUserId !== input.actorUserId)
  ) {
    throw appError(
      403,
      "workshop_native_ssh_participant_only",
      "native SSH is available only to the participant who owns the workspace",
    );
  }

  const now = Date.now();
  const assistGrant =
    workspace.workspaceUserId === input.actorUserId || input.mode === "native"
      ? null
      : await requireActiveWorkshopAssistGrant({
          sessionId: input.sessionId,
          workspaceId: input.workspaceId,
          helperUserId: input.actorUserId,
          now,
        });
  const target = await loadCurrentRuntimeVmTerminalTarget({
    executionId: workspace.runtimeExecutionId,
    expectedGeneration: workspace.generationOrdinal,
    ...(input.vmId ? { vmId: input.vmId } : {}),
  });
  if (
    target.domainKind !== "workshop" ||
    target.domainId !== workspace.workspaceId ||
    target.userId !== workspace.workspaceUserId ||
    target.organizationId !== access.organizationId
  ) {
    throw appError(
      409,
      "workshop_runtime_identity_mismatch",
      "workshop runtime execution does not belong to this workspace",
    );
  }

  const profileKeys =
    input.mode === "native"
      ? await listUserAuthorizedSshKeysForNativeRoutes(input.actorUserId)
      : [];
  if (input.mode === "native" && profileKeys.length === 0) {
    throw appError(
      409,
      "workshop_native_ssh_key_required",
      "add an SSH key to your profile before opening a native workshop SSH route",
    );
  }
  const routeUsername = await workshopTerminalRouteUsername({
    workspaceId: workspace.workspaceId,
    actorUserId: input.actorUserId,
    vmId: target.vmId,
    mode: input.mode,
  });
  const expiresAt = Math.min(
    now + stargateRouteTtlMs(),
    assistGrant?.expiresAt ?? Number.POSITIVE_INFINITY,
  );
  if (expiresAt <= Date.now()) {
    throw appError(
      403,
      "workshop_assist_grant_required",
      "an active learner assistance grant is required",
    );
  }

  const intentId = await beginWorkshopRouteIssuanceIntent({
    organizationId: access.organizationId,
    sessionId: input.sessionId,
    workspaceId: workspace.workspaceId,
    generationId: workspace.generationId,
    actorUserId: input.actorUserId,
    kind: "terminal",
    routeKey: routeUsername,
    capabilityExpiresAt: expiresAt,
  });
  if (!intentId) {
    throw appError(
      409,
      "workshop_terminal_authorization_changed",
      "workshop terminal authorization changed while the route was opening",
    );
  }
  let terminal: StargateTerminalSessionResult;
  try {
    terminal = await issueStargateTerminalSession({
      routeUsername,
      targetUsername: target.target.username,
      targetHost: target.target.host,
      targetPort: target.target.port,
      targetHostKeyOpenssh: target.target.hostKeyOpenssh,
      targetPrivateKeyOpenssh: target.target.privateKeyOpenssh,
      expiresAt: new Date(expiresAt),
      mode: input.mode,
      authorizedClientPublicKeysOpenssh: profileKeys.map(
        (key) => key.publicKeyOpenssh,
      ),
      metadata: {
        hostId: target.hostId,
        runId: target.executionId,
        vmId: target.vmId,
        userId: input.actorUserId,
      },
    });
  } catch (error) {
    await markWorkshopRouteIssuanceIntentIssued({
      intentId,
      routeKey: routeUsername,
    });
    await deleteStargateRoute(routeUsername);
    await completeWorkshopRouteIssuanceIntent(intentId);
    throw error;
  }
  const intentIssued = await markWorkshopRouteIssuanceIntentIssued({
    intentId,
    routeKey: routeUsername,
    alternateRouteKey:
      terminal.routeUsername === routeUsername ? null : terminal.routeUsername,
  });
  if (!intentIssued) {
    await Promise.all(
      [...new Set([routeUsername, terminal.routeUsername])].map((route) =>
        deleteStargateRoute(route),
      ),
    );
    await completeWorkshopRouteIssuanceIntent(intentId);
    throw appError(
      409,
      "workshop_terminal_authorization_changed",
      "workshop terminal authorization changed while the route was opening",
    );
  }
  if (
    terminal.routeUsername !== routeUsername ||
    terminal.expiresAt > expiresAt ||
    terminal.expiresAt <= Date.now() ||
    (input.mode === "browser" ? !terminal.browser : !terminal.native)
  ) {
    if (terminal.routeUsername !== routeUsername) {
      await Promise.all([
        deleteStargateRoute(routeUsername),
        deleteStargateRoute(terminal.routeUsername),
      ]);
      await completeWorkshopRouteIssuanceIntent(intentId);
    } else {
      await deleteStargateRoute(routeUsername);
      await completeWorkshopRouteIssuanceIntent(intentId);
    }
    throw appError(
      502,
      "workshop_terminal_gateway_response_invalid",
      "the terminal gateway returned an invalid route identity or expiry",
    );
  }
  const recorded = await recordIssuedRoute({
    sessionId: input.sessionId,
    workspaceId: workspace.workspaceId,
    generationId: workspace.generationId,
    organizationId: access.organizationId,
    actorUserId: input.actorUserId,
    routeUsername,
    runtimeExecutionId: target.executionId,
    now: Date.now(),
    ...(assistGrant ? { assistGrantId: assistGrant.id } : {}),
  });
  if (!recorded) {
    await deleteStargateRoute(routeUsername);
    await completeWorkshopRouteIssuanceIntent(intentId);
    throw appError(
      409,
      "workshop_terminal_authorization_changed",
      "workshop terminal authorization changed while the route was opening",
    );
  }
  await completeWorkshopRouteIssuanceIntent(intentId);
  await appendWorkshopEvent(db, {
    organizationId: access.organizationId,
    sessionId: input.sessionId,
    actorUserId: input.actorUserId,
    type: assistGrant ? "assist.terminal_opened" : "terminal.opened",
    payload: {
      workspaceId: workspace.workspaceId,
      generationId: workspace.generationId,
      runtimeExecutionId: target.executionId,
      vmId: target.vmId,
      routeUsername,
      expiresAt: terminal.expiresAt,
      mode: input.mode,
      assistGrantId: assistGrant?.id ?? null,
    },
  });
  return terminal;
}

async function recordIssuedRoute(input: {
  sessionId: string;
  workspaceId: string;
  generationId: string;
  organizationId: string;
  actorUserId: string;
  routeUsername: string;
  runtimeExecutionId: string;
  assistGrantId?: string;
  now: number;
}): Promise<boolean> {
  const db = workshopDb();
  const runtimeFence = currentWorkshopRuntimeRouteExists(input);
  const activeAssistGrant = input.assistGrantId
    ? sql`exists (
        select 1
        from ${workshopAssistGrants}
        where ${workshopAssistGrants.id} = ${input.assistGrantId}
          and ${workshopAssistGrants.sessionId} = ${input.sessionId}
          and ${workshopAssistGrants.workspaceId} = ${input.workspaceId}
          and ${workshopAssistGrants.helperUserId} = ${input.actorUserId}
          and ${workshopAssistGrants.revokedAt} is null
          and ${workshopAssistGrants.expiresAt} > ${input.now}
      )`
    : undefined;
  const workspaceUpdate = db
    .update(workshopWorkspaces)
    .set({
      terminalRouteUsernamesJson: appendUniqueJsonString(
        workshopWorkspaces.terminalRouteUsernamesJson,
        input.routeUsername,
      ),
      updatedAt: input.now,
    })
    .where(
      and(
        eq(workshopWorkspaces.id, input.workspaceId),
        eq(workshopWorkspaces.sessionId, input.sessionId),
        eq(workshopWorkspaces.currentGenerationId, input.generationId),
        eq(workshopWorkspaces.state, "ready"),
        runtimeFence,
        activeAssistGrant,
        currentWorkshopMembershipExists(input),
      ),
    )
    .returning({ id: workshopWorkspaces.id });
  if (!input.assistGrantId) {
    const workspaces = await workspaceUpdate;
    return Boolean(workspaces[0]);
  }
  const grantUpdate = db
    .update(workshopAssistGrants)
    .set({
      terminalRouteUsernamesJson: appendUniqueJsonString(
        workshopAssistGrants.terminalRouteUsernamesJson,
        input.routeUsername,
      ),
      updatedAt: input.now,
    })
    .where(
      and(
        eq(workshopAssistGrants.id, input.assistGrantId),
        eq(workshopAssistGrants.sessionId, input.sessionId),
        eq(workshopAssistGrants.workspaceId, input.workspaceId),
        eq(workshopAssistGrants.helperUserId, input.actorUserId),
        sql`${workshopAssistGrants.revokedAt} is null`,
        sql`${workshopAssistGrants.expiresAt} > ${input.now}`,
        runtimeFence,
        currentWorkshopMembershipExists(input),
      ),
    )
    .returning({ id: workshopAssistGrants.id });
  const [workspaces, grants] = await db.batch([workspaceUpdate, grantUpdate]);
  return Boolean(workspaces[0] && grants[0]);
}

function currentWorkshopRuntimeRouteExists(input: {
  workspaceId: string;
  generationId: string;
  runtimeExecutionId: string;
}) {
  return sql`exists (
    select 1
    from ${workshopWorkspaceGenerations}
    join ${runtimeExecutions}
      on ${runtimeExecutions.id} = ${workshopWorkspaceGenerations.runtimeExecutionId}
    where ${workshopWorkspaceGenerations.id} = ${input.generationId}
      and ${workshopWorkspaceGenerations.workspaceId} = ${input.workspaceId}
      and ${workshopWorkspaceGenerations.state} = 'ready'
      and ${runtimeExecutions.id} = ${input.runtimeExecutionId}
      and ${runtimeExecutions.domainKind} = 'workshop'
      and ${runtimeExecutions.domainId} = ${input.workspaceId}
      and ${runtimeExecutions.state} = 'ready'
  )`;
}

function currentWorkshopMembershipExists(input: {
  sessionId: string;
  workspaceId: string;
  organizationId: string;
  actorUserId: string;
}) {
  return sql`exists (
    select 1
    from ${workshopSessions}
    join ${member}
      on ${member.organizationId} = ${workshopSessions.organizationId}
     and ${member.userId} = ${input.actorUserId}
    where ${workshopSessions.id} = ${input.sessionId}
      and ${workshopSessions.organizationId} = ${input.organizationId}
      and ${workshopSessions.state} in ('lobby', 'live')
      and ${member.workshopAccessRevokingAt} is null
      and exists (
        select 1
        from workshop_workspaces authorization_workspace
        join member workspace_member
          on workspace_member.organization_id = ${workshopSessions.organizationId}
         and workspace_member.user_id = authorization_workspace.user_id
        where authorization_workspace.id = ${input.workspaceId}
          and workspace_member.workshop_access_revoking_at is null
      )
  )`;
}

function appendUniqueJsonString(column: unknown, value: string) {
  return sql`case
    when exists (select 1 from json_each(${column}) where value = ${value})
      then ${column}
    else json_insert(${column}, '$[#]', ${value})
  end`;
}
