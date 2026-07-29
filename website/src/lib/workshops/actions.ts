import { and, eq } from "drizzle-orm";
import {
  workshopHelpRequests,
  workshopSessions,
  workshopWorkspaces,
} from "@/db/schema";
import { AppError, appError } from "@/lib/app-error";
import {
  claimWorkshopHelpRequest,
  closeWorkshopHelpRequest,
  extendWorkshopAssist,
  findWorkshopAssistGrantForRevocation,
  grantWorkshopAssist,
  revokeWorkshopAssist,
} from "./assistance";
import {
  prepareCheckedInWorkshopWorkspaces,
  prepareWorkshopCheckpointRestore,
  prepareWorkshopLateJoin,
} from "./provisioning";
import {
  provisionWorkshopRequest,
  provisionWorkshopRequests,
} from "./runtime-orchestrator";
import {
  revealWorkshopHint,
  updateParticipantWorkshopProgress,
} from "./progress";
import {
  appendWorkshopEvent,
  loadWorkshopManifestForSession,
  requireManifestModule,
  requireWorkshopHelper,
  requireWorkshopManager,
  requireWorkshopSessionMember,
  workshopCheckpointRequiredPrefixIds,
  workshopDb,
  workshopHelperMutationGuard,
  workshopManagerMutationGuard,
  workshopModuleRequiredPrefixIds,
  workshopReleaseIncludesPrefix,
} from "./shared";
import {
  checkInToWorkshop,
  loadWorkshopSession,
  replaceWorkshopRoster,
  updateWorkshopSession,
} from "./sessions";
import { withWorkshopManagerRosterDefault } from "./roster-input";

export type WorkshopActionResult =
  | { kind: "updated" }
  | {
      kind: "provisioning";
      generationIds: string[];
    };

export async function performWorkshopSessionAction(params: {
  sessionId: string;
  actorUserId: string;
  action: string;
  expectedVersion?: number;
  payload: Record<string, unknown>;
}): Promise<WorkshopActionResult> {
  switch (params.action) {
    case "check_in":
      await checkInToWorkshop({
        sessionId: params.sessionId,
        userId: params.actorUserId,
      });
      return { kind: "updated" };
    case "reveal_hint":
      await revealWorkshopHint({
        sessionId: params.sessionId,
        userId: params.actorUserId,
        moduleId: requireString(params.payload.moduleId, "moduleId"),
        hintId: requireString(params.payload.hintId, "hintId"),
      });
      return { kind: "updated" };
    case "complete_explain_back":
      await updateParticipantWorkshopProgress({
        sessionId: params.sessionId,
        userId: params.actorUserId,
        moduleId: requireString(params.payload.moduleId, "moduleId"),
        explainBackStatus: "completed",
      });
      return { kind: "updated" };
    case "grant_assist": {
      const request = await activeHelpRequestForParticipant(
        params.sessionId,
        params.actorUserId,
      );
      await grantWorkshopAssist({
        sessionId: params.sessionId,
        helpRequestId: request.id,
        learnerUserId: params.actorUserId,
      });
      return { kind: "updated" };
    }
    case "extend_assist": {
      await extendWorkshopAssist({
        sessionId: params.sessionId,
        grantId: requireString(params.payload.grantId, "grantId"),
        learnerUserId: params.actorUserId,
      });
      return { kind: "updated" };
    }
    case "revoke_assist": {
      const grant = await findWorkshopAssistGrantForRevocation({
        sessionId: params.sessionId,
        actorUserId: params.actorUserId,
      });
      if (!grant) {
        throw appError(
          404,
          "workshop_assist_grant_not_found",
          "active workshop assistance grant not found",
        );
      }
      await revokeWorkshopAssist({
        sessionId: params.sessionId,
        grantId: grant.id,
        actorUserId: params.actorUserId,
      });
      return { kind: "updated" };
    }
    case "restore_checkpoint": {
      if (params.payload.confirmed !== true) {
        throw appError(
          400,
          "workshop_restore_confirmation_required",
          "checkpoint restore requires explicit destructive confirmation",
        );
      }
      const access = await requireWorkshopSessionMember({
        sessionId: params.sessionId,
        userId: params.actorUserId,
      });
      if (access.role !== "participant") {
        throw appError(
          403,
          "workshop_participant_required",
          "only participants restore their workspace from this action",
        );
      }
      const db = workshopDb();
      const workspaces = await db
        .select({ id: workshopWorkspaces.id })
        .from(workshopWorkspaces)
        .where(
          and(
            eq(workshopWorkspaces.sessionId, params.sessionId),
            eq(workshopWorkspaces.userId, params.actorUserId),
          ),
        )
        .limit(1);
      const workspace = workspaces[0];
      if (!workspace) {
        throw appError(
          404,
          "workshop_workspace_not_found",
          "workshop workspace not found",
        );
      }
      const context = await loadWorkshopManifestForSession(params.sessionId);
      const requested = requireString(
        params.payload.checkpointId,
        "checkpointId",
      );
      const module = context.manifest.modules.find(
        (entry) => entry.id === requested,
      );
      const checkpointExists = context.manifest.workspace.checkpoints.some(
        (entry) => entry.id === requested,
      );
      if (!module && !checkpointExists) {
        throw appError(
          404,
          "workshop_checkpoint_not_found",
          "workshop checkpoint not found",
        );
      }
      const current = await loadWorkshopSession(params.sessionId);
      const checkpointId = module?.catchUpCheckpointId ?? requested;
      const requiredModuleIds = module
        ? workshopModuleRequiredPrefixIds(context.manifest, module.id)
        : workshopCheckpointRequiredPrefixIds(
            context.manifest,
            checkpointId,
          );
      if (
        !requiredModuleIds ||
        !workshopReleaseIncludesPrefix(
          current.releasedModuleIds,
          requiredModuleIds,
        )
      ) {
        throw appError(
          409,
          "workshop_checkpoint_not_released",
          "this workshop checkpoint has not been released",
        );
      }
      const request = await prepareWorkshopCheckpointRestore({
        sessionId: params.sessionId,
        workspaceId: workspace.id,
        checkpointId,
        actorUserId: params.actorUserId,
      });
      await provisionWorkshopRequestOrDeferReplacement(request);
      return { kind: "provisioning", generationIds: [request.generationId] };
    }
  }

  const expectedVersion = requireVersion(params.expectedVersion);
  switch (params.action) {
    case "replace_roster": {
      await replaceWorkshopRoster({
        sessionId: params.sessionId,
        actorUserId: params.actorUserId,
        members: withWorkshopManagerRosterDefault(
          parseRoster(params.payload.members),
          params.actorUserId,
        ),
        expectedVersion,
        draftOnly: true,
      });
      return { kind: "updated" };
    }
    case "open_lobby": {
      await updateWorkshopSession({
        sessionId: params.sessionId,
        actorUserId: params.actorUserId,
        expectedVersion,
        state: "lobby",
      });
      return { kind: "updated" };
    }
    case "go_live":
      await updateWorkshopSession({
        sessionId: params.sessionId,
        actorUserId: params.actorUserId,
        expectedVersion,
        state: "live",
      });
      return { kind: "updated" };
    case "end_session":
      await updateWorkshopSession({
        sessionId: params.sessionId,
        actorUserId: params.actorUserId,
        expectedVersion,
        state: "ended",
      });
      return { kind: "updated" };
    case "cancel_session":
      await updateWorkshopSession({
        sessionId: params.sessionId,
        actorUserId: params.actorUserId,
        expectedVersion,
        state: "cancelled",
      });
      return { kind: "updated" };
    case "announce":
      await updateWorkshopSession({
        sessionId: params.sessionId,
        actorUserId: params.actorUserId,
        expectedVersion,
        announcement: nullableString(params.payload.message, "message"),
      });
      return { kind: "updated" };
    case "provision_checked_in": {
      await reserveWorkshopSessionMutation({
        sessionId: params.sessionId,
        actorUserId: params.actorUserId,
        expectedVersion,
        actor: "manager",
      });
      const result = await prepareCheckedInWorkshopWorkspaces({
        sessionId: params.sessionId,
        actorUserId: params.actorUserId,
      });
      await provisionWorkshopRequests(result.requests);
      return {
        kind: "provisioning",
        generationIds: result.requests.map((request) => request.generationId),
      };
    }
    case "catch_up_participant": {
      await reserveWorkshopSessionMutation({
        sessionId: params.sessionId,
        actorUserId: params.actorUserId,
        expectedVersion,
        actor: "manager",
      });
      const request = await prepareWorkshopLateJoin({
        sessionId: params.sessionId,
        actorUserId: params.actorUserId,
        participantUserId: requireString(
          params.payload.participantUserId,
          "participantUserId",
        ),
        checkpointId: requireString(
          params.payload.checkpointId,
          "checkpointId",
        ),
      });
      await provisionWorkshopRequestOrDeferReplacement(request);
      return { kind: "provisioning", generationIds: [request.generationId] };
    }
    case "release_module": {
      const moduleId = requireString(params.payload.moduleId, "moduleId");
      const context = await loadWorkshopManifestForSession(params.sessionId);
      const module = requireManifestModule(context.manifest, moduleId);
      const current = await loadWorkshopSession(params.sessionId);
      if (current.version !== expectedVersion) throw versionConflict();
      const missingDependency = module.dependsOn.find(
        (dependency) => !current.releasedModuleIds.includes(dependency),
      );
      if (missingDependency) {
        throw appError(
          409,
          "workshop_module_dependency_locked",
          `module ${moduleId} depends on unreleased module ${missingDependency}`,
        );
      }
      if (module.tier === "core") {
        const moduleOrdinal = context.manifest.modules.findIndex(
          (entry) => entry.id === moduleId,
        );
        const missingEarlierCore = context.manifest.modules
          .slice(0, moduleOrdinal)
          .find(
            (entry) =>
              entry.tier === "core" &&
              !current.releasedModuleIds.includes(entry.id),
          );
        if (missingEarlierCore) {
          throw appError(
            409,
            "workshop_core_module_order_locked",
            `release earlier core module ${missingEarlierCore.id} first`,
          );
        }
      }
      await setWorkshopSessionArrays({
        sessionId: params.sessionId,
        actorUserId: params.actorUserId,
        expectedVersion,
        releasedModuleIds: unique([...current.releasedModuleIds, moduleId]),
        eventType: "module.released",
        eventPayload: { moduleId },
      });
      return { kind: "updated" };
    }
    case "focus_module": {
      const moduleId = requireString(params.payload.moduleId, "moduleId");
      const context = await loadWorkshopManifestForSession(params.sessionId);
      requireManifestModule(context.manifest, moduleId);
      const agendaItem = context.manifest.agenda.find(
        (item) => item.moduleId === moduleId,
      );
      if (!agendaItem) {
        throw appError(
          404,
          "workshop_agenda_item_not_found",
          "workshop module has no agenda item",
        );
      }
      await focusWorkshopAgendaItem({
        sessionId: params.sessionId,
        actorUserId: params.actorUserId,
        expectedVersion,
        agendaItemId: agendaItem.id,
      });
      return { kind: "updated" };
    }
    case "focus_agenda":
      await focusWorkshopAgendaItem({
        sessionId: params.sessionId,
        actorUserId: params.actorUserId,
        expectedVersion,
        agendaItemId: requireString(
          params.payload.agendaItemId,
          "agendaItemId",
        ),
      });
      return { kind: "updated" };
    case "reveal_solution": {
      const moduleId = requireString(params.payload.moduleId, "moduleId");
      const context = await loadWorkshopManifestForSession(params.sessionId);
      requireManifestModule(context.manifest, moduleId);
      const current = await loadWorkshopSession(params.sessionId);
      if (current.version !== expectedVersion) throw versionConflict();
      if (!current.releasedModuleIds.includes(moduleId)) {
        throw appError(
          409,
          "workshop_module_not_released",
          "release the workshop module before revealing its solution",
        );
      }
      await setWorkshopSessionArrays({
        sessionId: params.sessionId,
        actorUserId: params.actorUserId,
        expectedVersion,
        revealedSolutionModuleIds: unique([
          ...current.revealedSolutionModuleIds,
          moduleId,
        ]),
        eventType: "module.solution_revealed",
        eventPayload: { moduleId },
      });
      return { kind: "updated" };
    }
    case "claim_help": {
      const requesterUserId = requireString(params.payload.userId, "userId");
      const rows = await workshopDb()
        .select({ id: workshopHelpRequests.id })
        .from(workshopHelpRequests)
        .where(
          and(
            eq(workshopHelpRequests.sessionId, params.sessionId),
            eq(workshopHelpRequests.requesterUserId, requesterUserId),
            eq(workshopHelpRequests.status, "open"),
          ),
        )
        .limit(1);
      const request = rows[0];
      if (!request) {
        throw appError(
          404,
          "workshop_help_request_not_found",
          "active workshop help request not found",
        );
      }
      await reserveWorkshopSessionMutation({
        sessionId: params.sessionId,
        actorUserId: params.actorUserId,
        expectedVersion,
        actor: "helper",
      });
      await claimWorkshopHelpRequest({
        sessionId: params.sessionId,
        helpRequestId: request.id,
        helperUserId: params.actorUserId,
      });
      return { kind: "updated" };
    }
    case "resolve_help": {
      const requesterUserId = requireString(params.payload.userId, "userId");
      const rows = await workshopDb()
        .select({
          id: workshopHelpRequests.id,
          claimedBy: workshopHelpRequests.claimedBy,
        })
        .from(workshopHelpRequests)
        .where(
          and(
            eq(workshopHelpRequests.sessionId, params.sessionId),
            eq(workshopHelpRequests.requesterUserId, requesterUserId),
            eq(workshopHelpRequests.status, "claimed"),
          ),
        )
        .limit(1);
      const request = rows[0];
      if (!request) {
        throw appError(
          404,
          "workshop_help_request_not_found",
          "claimed workshop help request not found",
        );
      }
      if (request.claimedBy !== params.actorUserId) {
        throw appError(
          403,
          "workshop_help_request_forbidden",
          "this workshop help request cannot be changed by the current user",
        );
      }
      await reserveWorkshopSessionMutation({
        sessionId: params.sessionId,
        actorUserId: params.actorUserId,
        expectedVersion,
        actor: "helper",
      });
      await closeWorkshopHelpRequest({
        sessionId: params.sessionId,
        helpRequestId: request.id,
        actorUserId: params.actorUserId,
        action: "resolve",
      });
      return { kind: "updated" };
    }
    case "pause_timer":
      await pauseWorkshopTimer(
        params.sessionId,
        params.actorUserId,
        expectedVersion,
      );
      return { kind: "updated" };
    case "resume_timer":
      await resumeWorkshopTimer(
        params.sessionId,
        params.actorUserId,
        expectedVersion,
      );
      return { kind: "updated" };
    case "set_slide":
      await setWorkshopSlide({
        sessionId: params.sessionId,
        actorUserId: params.actorUserId,
        expectedVersion,
        slideOrdinal: requireInteger(
          params.payload.slideOrdinal,
          "slideOrdinal",
        ),
      });
      return { kind: "updated" };
    default:
      throw appError(400, "workshop_action_invalid", "unknown workshop action");
  }
}

async function setWorkshopSessionArrays(params: {
  sessionId: string;
  actorUserId: string;
  expectedVersion: number;
  releasedModuleIds?: string[];
  revealedSolutionModuleIds?: string[];
  eventType: string;
  eventPayload?: Record<string, unknown>;
}) {
  const access = await requireWorkshopManager({
    sessionId: params.sessionId,
    userId: params.actorUserId,
  });
  const current = await loadWorkshopSession(params.sessionId);
  if (current.version !== params.expectedVersion) throw versionConflict();
  requireMutableWorkshopSession(current.state);
  const now = Date.now();
  const rows = await workshopDb()
    .update(workshopSessions)
    .set({
      releasedModuleIdsJson:
        params.releasedModuleIds ?? current.releasedModuleIds,
      revealedSolutionModuleIdsJson:
        params.revealedSolutionModuleIds ?? current.revealedSolutionModuleIds,
      version: current.version + 1,
      updatedAt: now,
    })
    .where(
      and(
        eq(workshopSessions.id, params.sessionId),
        eq(workshopSessions.version, params.expectedVersion),
        workshopManagerMutationGuard(
          params.sessionId,
          params.actorUserId,
        ),
      ),
    )
    .returning({ id: workshopSessions.id });
  if (!rows[0]) throw versionConflict();
  await appendWorkshopEvent(workshopDb(), {
    organizationId: access.organizationId,
    sessionId: params.sessionId,
    actorUserId: params.actorUserId,
    type: params.eventType,
    ...(params.eventPayload ? { payload: params.eventPayload } : {}),
    createdAt: now,
  });
}

async function focusWorkshopAgendaItem(params: {
  sessionId: string;
  actorUserId: string;
  expectedVersion: number;
  agendaItemId: string;
}) {
  const access = await requireWorkshopManager({
    sessionId: params.sessionId,
    userId: params.actorUserId,
  });
  if (access.state !== "lobby" && access.state !== "live") {
    throw appError(
      409,
      "workshop_agenda_focus_closed",
      "agenda focus is available only while the workshop room is open",
    );
  }
  const context = await loadWorkshopManifestForSession(params.sessionId);
  const item = context.manifest.agenda.find(
    (entry) => entry.id === params.agendaItemId,
  );
  if (!item) {
    throw appError(
      404,
      "workshop_agenda_item_not_found",
      "workshop agenda item not found",
    );
  }
  const current = await loadWorkshopSession(params.sessionId);
  if (
    item.moduleId &&
    !current.releasedModuleIds.includes(item.moduleId)
  ) {
    throw appError(
      409,
      "workshop_module_not_released",
      "release the workshop module before focusing its agenda item",
    );
  }
  const now = Date.now();
  await updateWorkshopSession({
    sessionId: params.sessionId,
    actorUserId: params.actorUserId,
    expectedVersion: params.expectedVersion,
    currentAgendaItemId: item.id,
    currentModuleId: item.moduleId ?? null,
    currentSlideId: item.slideIds[0] ?? null,
    timer:
      item.durationMinutes > 0
        ? {
            startedAt: now,
            endsAt: now + item.durationMinutes * 60_000,
          }
        : null,
  });
}

async function reserveWorkshopSessionMutation(params: {
  sessionId: string;
  actorUserId: string;
  expectedVersion: number;
  actor: "manager" | "helper";
}) {
  if (params.actor === "manager") {
    await requireWorkshopManager({
      sessionId: params.sessionId,
      userId: params.actorUserId,
    });
  } else {
    await requireWorkshopHelper({
      sessionId: params.sessionId,
      userId: params.actorUserId,
    });
  }
  const current = await loadWorkshopSession(params.sessionId);
  if (current.version !== params.expectedVersion) throw versionConflict();
  requireMutableWorkshopSession(current.state);
  const updated = await workshopDb()
    .update(workshopSessions)
    .set({
      version: params.expectedVersion + 1,
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(workshopSessions.id, params.sessionId),
        eq(workshopSessions.version, params.expectedVersion),
        params.actor === "manager"
          ? workshopManagerMutationGuard(
              params.sessionId,
              params.actorUserId,
            )
          : workshopHelperMutationGuard(
              params.sessionId,
              params.actorUserId,
            ),
      ),
    )
    .returning({ id: workshopSessions.id });
  if (!updated[0]) throw versionConflict();
}

function requireMutableWorkshopSession(state: string) {
  if (state === "ended" || state === "cancelled") {
    throw appError(
      409,
      "workshop_session_terminal",
      "workshop session has already ended",
    );
  }
}

async function pauseWorkshopTimer(
  sessionId: string,
  actorUserId: string,
  expectedVersion: number,
) {
  const access = await requireWorkshopManager({
    sessionId,
    userId: actorUserId,
  });
  const current = await loadWorkshopSession(sessionId);
  if (current.version !== expectedVersion) throw versionConflict();
  requireMutableWorkshopSession(current.state);
  if (!current.timerEndsAt || current.timerPausedAt) {
    throw appError(
      409,
      "workshop_timer_not_running",
      "workshop timer is not running",
    );
  }
  const now = Date.now();
  const remainingMs = Math.max(0, current.timerEndsAt - now);
  await casTimerUpdate({
    sessionId,
    organizationId: access.organizationId,
    actorUserId,
    expectedVersion,
    timerStartedAt: current.timerStartedAt,
    timerEndsAt: null,
    timerPausedAt: now,
    timerRemainingMs: remainingMs,
    eventType: "timer.paused",
  });
}

async function resumeWorkshopTimer(
  sessionId: string,
  actorUserId: string,
  expectedVersion: number,
) {
  const access = await requireWorkshopManager({
    sessionId,
    userId: actorUserId,
  });
  const current = await loadWorkshopSession(sessionId);
  if (current.version !== expectedVersion) throw versionConflict();
  requireMutableWorkshopSession(current.state);
  if (!current.timerPausedAt || current.timerRemainingMs === null) {
    throw appError(
      409,
      "workshop_timer_not_paused",
      "workshop timer is not paused",
    );
  }
  const now = Date.now();
  await casTimerUpdate({
    sessionId,
    organizationId: access.organizationId,
    actorUserId,
    expectedVersion,
    timerStartedAt: now,
    timerEndsAt: now + current.timerRemainingMs,
    timerPausedAt: null,
    timerRemainingMs: null,
    eventType: "timer.resumed",
  });
}

async function casTimerUpdate(params: {
  sessionId: string;
  organizationId: string;
  actorUserId: string;
  expectedVersion: number;
  timerStartedAt: number | null;
  timerEndsAt: number | null;
  timerPausedAt: number | null;
  timerRemainingMs: number | null;
  eventType: string;
}) {
  const now = Date.now();
  const rows = await workshopDb()
    .update(workshopSessions)
    .set({
      timerStartedAt: params.timerStartedAt,
      timerEndsAt: params.timerEndsAt,
      timerPausedAt: params.timerPausedAt,
      timerRemainingMs: params.timerRemainingMs,
      version: params.expectedVersion + 1,
      updatedAt: now,
    })
    .where(
      and(
        eq(workshopSessions.id, params.sessionId),
        eq(workshopSessions.version, params.expectedVersion),
        workshopManagerMutationGuard(
          params.sessionId,
          params.actorUserId,
        ),
      ),
    )
    .returning({ id: workshopSessions.id });
  if (!rows[0]) throw versionConflict();
  await appendWorkshopEvent(workshopDb(), {
    organizationId: params.organizationId,
    sessionId: params.sessionId,
    actorUserId: params.actorUserId,
    type: params.eventType,
    payload: { remainingMs: params.timerRemainingMs },
    createdAt: now,
  });
}

async function setWorkshopSlide(params: {
  sessionId: string;
  actorUserId: string;
  expectedVersion: number;
  slideOrdinal: number;
}) {
  const context = await loadWorkshopManifestForSession(params.sessionId);
  const slide = context.manifest.presentation.slides[params.slideOrdinal];
  if (!slide) {
    throw appError(404, "workshop_slide_not_found", "workshop slide not found");
  }
  const current = await loadWorkshopSession(params.sessionId);
  if (slide.moduleId && !current.releasedModuleIds.includes(slide.moduleId)) {
    throw appError(
      409,
      "workshop_slide_not_released",
      "release the slide module before presenting it",
    );
  }
  await updateWorkshopSession({
    sessionId: params.sessionId,
    actorUserId: params.actorUserId,
    expectedVersion: params.expectedVersion,
    currentSlideId: slide.id,
  });
}

async function activeHelpRequestForParticipant(
  sessionId: string,
  userId: string,
) {
  const rows = await workshopDb()
    .select({ id: workshopHelpRequests.id })
    .from(workshopHelpRequests)
    .where(
      and(
        eq(workshopHelpRequests.sessionId, sessionId),
        eq(workshopHelpRequests.requesterUserId, userId),
        eq(workshopHelpRequests.status, "claimed"),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw appError(
      404,
      "workshop_help_request_not_found",
      "claimed workshop help request not found",
    );
  }
  return row;
}

async function provisionWorkshopRequestOrDeferReplacement(
  request: Parameters<typeof provisionWorkshopRequest>[0],
): Promise<void> {
  try {
    await provisionWorkshopRequest(request);
  } catch (error) {
    if (
      error instanceof AppError &&
      error.code === "hcloud_replacement_cleanup_pending"
    ) {
      return;
    }
    throw error;
  }
}

function requireVersion(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) < 1) {
    throw appError(
      400,
      "workshop_version_required",
      "a positive workshop session version is required",
    );
  }
  return value as number;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw appError(400, "workshop_action_invalid", `${name} is required`);
  }
  return value.trim();
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw appError(400, "workshop_action_invalid", `${name} must be a string`);
  }
  return value;
}

function parseRoster(value: unknown): Array<{
  userId: string;
  role: "participant" | "helper" | "facilitator";
}> {
  if (!Array.isArray(value)) {
    throw appError(
      400,
      "workshop_roster_invalid",
      "workshop members must be an array",
    );
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw appError(
        400,
        "workshop_roster_invalid",
        "workshop roster contains an invalid member",
      );
    }
    const userId =
      "userId" in entry && typeof entry.userId === "string"
        ? entry.userId.trim()
        : "";
    const role = "role" in entry ? entry.role : undefined;
    if (
      !userId ||
      (role !== "participant" && role !== "helper" && role !== "facilitator")
    ) {
      throw appError(
        400,
        "workshop_roster_invalid",
        "workshop roster contains an invalid member",
      );
    }
    return { userId, role };
  });
}

function requireInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value)) {
    throw appError(
      400,
      "workshop_action_invalid",
      `${name} must be an integer`,
    );
  }
  return value as number;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function versionConflict() {
  return appError(
    409,
    "workshop_version_conflict",
    "workshop session was changed by another facilitator",
  );
}
