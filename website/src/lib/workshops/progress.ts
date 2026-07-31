import { and, eq, sql } from "drizzle-orm";
import {
  workshopModuleProgress,
  workshopSessionMembers,
  workshopSessions,
  type WorkshopCurrentHealth,
  type WorkshopExplainBackStatus,
  type WorkshopManifestV1,
  type WorkshopTechnicalStatus,
} from "@/db/schema";
import { appError } from "@/lib/app-error";
import { createAppId } from "@/lib/id";
import {
  appendWorkshopEvent,
  loadWorkshopManifestForSession,
  requireManifestModule,
  requireWorkshopManager,
  requireWorkshopSessionMember,
  workshopDb,
} from "./shared";
import type { WorkshopModuleProgressRecord } from "./types";

export async function updateParticipantWorkshopProgress(params: {
  sessionId: string;
  userId: string;
  moduleId: string;
  working?: boolean;
  explainBackStatus?: WorkshopExplainBackStatus;
}): Promise<WorkshopModuleProgressRecord> {
  const access = await requireWorkshopSessionMember(params);
  if (!access.workspaceEnabled) {
    throw appError(
      403,
      "workshop_participant_required",
      "only workshop participants update learner progress",
    );
  }
  if (access.state !== "lobby" && access.state !== "live") {
    throw appError(
      409,
      "workshop_progress_closed",
      "workshop progress is closed",
    );
  }
  if (
    params.explainBackStatus !== undefined &&
    params.explainBackStatus !== "pending" &&
    params.explainBackStatus !== "completed"
  ) {
    throw appError(
      400,
      "workshop_explain_back_invalid",
      "participants can only start or complete an explain-back",
    );
  }
  await requireParticipantModuleReleased(params.sessionId, params.moduleId);
  return recordWorkshopModuleObservation({
    sessionId: params.sessionId,
    participantUserId: params.userId,
    moduleId: params.moduleId,
    actorUserId: params.userId,
    ...(params.working ? { technicalStatus: "working" as const } : {}),
    ...(params.explainBackStatus
      ? { explainBackStatus: params.explainBackStatus }
      : {}),
  });
}

export async function revealWorkshopHint(params: {
  sessionId: string;
  userId: string;
  moduleId: string;
  hintId: string;
}): Promise<WorkshopModuleProgressRecord> {
  const access = await requireWorkshopSessionMember(params);
  if (!access.workspaceEnabled) {
    throw appError(
      403,
      "workshop_participant_required",
      "only workshop participants reveal learner hints",
    );
  }
  if (access.state !== "lobby" && access.state !== "live") {
    throw appError(409, "workshop_progress_closed", "workshop progress is closed");
  }
  const { context, module } = await requireParticipantModuleReleased(
    params.sessionId,
    params.moduleId,
  );
  if (!module.hints.some((hint) => hint.id === params.hintId)) {
    throw appError(404, "workshop_hint_not_found", "workshop hint not found");
  }
  const db = workshopDb();
  let rows = await db
    .select()
    .from(workshopModuleProgress)
    .where(
      and(
        eq(workshopModuleProgress.sessionId, params.sessionId),
        eq(workshopModuleProgress.userId, params.userId),
        eq(workshopModuleProgress.moduleId, params.moduleId),
      ),
    )
    .limit(1);
  if (!rows[0]) {
    await recordWorkshopModuleObservation({
      sessionId: params.sessionId,
      participantUserId: params.userId,
      moduleId: params.moduleId,
      actorUserId: params.userId,
      technicalStatus: "working",
    });
    rows = await db
      .select()
      .from(workshopModuleProgress)
      .where(
        and(
          eq(workshopModuleProgress.sessionId, params.sessionId),
          eq(workshopModuleProgress.userId, params.userId),
          eq(workshopModuleProgress.moduleId, params.moduleId),
        ),
      )
      .limit(1);
  }
  const current = rows[0];
  if (!current) {
    throw appError(500, "workshop_hint_reveal_failed", "failed to reveal workshop hint");
  }
  const revealedHintIds = current.revealedHintIdsJson.includes(params.hintId)
    ? current.revealedHintIdsJson
    : [...current.revealedHintIdsJson, params.hintId];
  const now = Date.now();
  const updated = await db
    .update(workshopModuleProgress)
    .set({ revealedHintIdsJson: revealedHintIds, updatedAt: now })
    .where(eq(workshopModuleProgress.id, current.id))
    .returning();
  await appendWorkshopEvent(db, {
    organizationId: context.organizationId,
    sessionId: params.sessionId,
    actorUserId: params.userId,
    type: "hint.revealed",
    payload: { moduleId: params.moduleId, hintId: params.hintId },
    createdAt: now,
  });
  return progressRecord(updated[0] ?? current);
}

export async function recordFacilitatorWorkshopProgress(params: {
  sessionId: string;
  actorUserId: string;
  participantUserId: string;
  moduleId: string;
  technicalStatus?: WorkshopTechnicalStatus;
  currentHealth?: WorkshopCurrentHealth;
  explainBackStatus?: WorkshopExplainBackStatus;
  observedAt?: number;
}): Promise<WorkshopModuleProgressRecord> {
  await requireWorkshopManager({
    sessionId: params.sessionId,
    userId: params.actorUserId,
  });
  return recordWorkshopModuleObservation(params);
}

export interface WorkshopProbeObservation {
  status: "unknown" | "pass" | "fail";
}

export interface WorkshopProbeReportAcceptance {
  executionId: string;
  allocationId: string;
  generation: number;
  sequence: number;
  observedAt: number;
}

/**
 * Projects one authenticated runtime report into workshop progress.
 *
 * Runtime callers have already fenced the current workspace generation. This
 * helper validates workspace enrollment once, derives every changed module in
 * memory, and commits all progress rows and audit events in one D1 batch. That
 * keeps large checkpoint reports bounded and prevents earlier modules from
 * starving later modules when a learner remains intentionally `caught_up`.
 */
export async function recordWorkshopProbeReport(params: {
  database: D1Database;
  organizationId: string;
  sessionId: string;
  participantUserId: string;
  manifest: WorkshopManifestV1;
  probes: ReadonlyMap<string, WorkshopProbeObservation>;
  observedAt: number;
}): Promise<void> {
  const statements = await prepareWorkshopProbeReport(params);
  if (statements.length === 0) return;
  const results = await params.database.batch(statements);
  assertWorkshopProbeBatchResults(results);
}

export async function prepareWorkshopProbeReport(params: {
  database: D1Database;
  organizationId: string;
  sessionId: string;
  participantUserId: string;
  manifest: WorkshopManifestV1;
  probes: ReadonlyMap<string, WorkshopProbeObservation>;
  observedAt: number;
  acceptance?: WorkshopProbeReportAcceptance;
}): Promise<D1PreparedStatement[]> {
  if (!Number.isSafeInteger(params.observedAt) || params.observedAt < 0) {
    throw appError(
      400,
      "workshop_observation_time_invalid",
      "observation time must be a Unix millisecond timestamp",
    );
  }

  const currentRows = await params.database
    .prepare(
      `SELECT
         roster.workspace_enabled,
         progress.module_id,
         progress.technical_status,
         progress.current_health
       FROM workshop_session_members roster
       LEFT JOIN workshop_module_progress progress
         ON progress.session_id = roster.session_id
        AND progress.user_id = roster.user_id
       WHERE roster.session_id = ? AND roster.user_id = ?
       ORDER BY progress.module_id ASC`,
    )
    .bind(params.sessionId, params.participantUserId)
    .all<{
      workspace_enabled: number;
      module_id: string | null;
      technical_status: WorkshopTechnicalStatus | null;
      current_health: WorkshopCurrentHealth | null;
    }>();
  if (!currentRows.results[0]?.workspace_enabled) {
    throw appError(
      404,
      "workshop_participant_not_found",
      "workshop participant not found",
    );
  }

  const current = new Map(
    currentRows.results.flatMap((row) =>
      row.module_id && row.technical_status && row.current_health
        ? [
            [
              row.module_id,
              {
                technicalStatus: row.technical_status,
                currentHealth: row.current_health,
              },
            ] as const,
          ]
        : [],
    ),
  );
  const statements: D1PreparedStatement[] = [];
  const acceptanceSql = params.acceptance
    ? `WHERE EXISTS (
         SELECT 1
         FROM runtime_provider_actual_state actual
         INNER JOIN hetzner_allocations allocation
           ON allocation.id = ?
          AND allocation.execution_id = actual.execution_id
         WHERE actual.execution_id = ?
           AND actual.generation = ?
           AND actual.sequence = ?
           AND actual.observed_at = ?
           AND allocation.last_report_sequence = ?
           AND allocation.last_report_at = ?
       )`
    : "";
  const acceptanceBindings = params.acceptance
    ? [
        params.acceptance.allocationId,
        params.acceptance.executionId,
        params.acceptance.generation,
        params.acceptance.sequence,
        params.acceptance.observedAt,
        params.acceptance.sequence,
        params.acceptance.observedAt,
      ]
    : [];

  for (const module of params.manifest.modules) {
    if (module.probeIds.length === 0) continue;
    const probes = module.probeIds.map((probeId) => params.probes.get(probeId));
    const allPassing = probes.every((probe) => probe?.status === "pass");
    const currentHealth: WorkshopCurrentHealth = allPassing
      ? "passing"
      : probes.some((probe) => probe?.status === "fail")
        ? "failing"
        : "unknown";
    const existing = current.get(module.id);
    const passingStateAlreadyLatched =
      existing?.technicalStatus === "verified" ||
      existing?.technicalStatus === "caught_up";
    if (
      existing?.currentHealth === currentHealth &&
      (!allPassing || passingStateAlreadyLatched)
    ) {
      continue;
    }

    const technicalStatus: WorkshopTechnicalStatus = allPassing
      ? "verified"
      : "not_started";
    const explainBackStatus: WorkshopExplainBackStatus =
      module.explainBackPrompt ? "pending" : "not_required";
    const startedAt =
      technicalStatus === "not_started" ? null : params.observedAt;
    const firstVerifiedAt =
      technicalStatus === "verified" ? params.observedAt : null;
    const completedAt = isCompletedTechnicalStatus(technicalStatus)
      ? params.observedAt
      : null;

    statements.push(
      params.database
        .prepare(
          `INSERT INTO workshop_module_progress (
             id, session_id, user_id, module_id, technical_status,
             current_health, explain_back_status, revealed_hint_ids_json,
             started_at, first_verified_at, caught_up_at,
             explain_back_completed_at, health_observed_at, completed_at,
             updated_at
           ) ${
             params.acceptance
               ? `SELECT ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, NULL, NULL, ?, ?, ?
                  ${acceptanceSql}`
               : "VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, NULL, NULL, ?, ?, ?)"
           }
           ON CONFLICT(session_id, user_id, module_id) DO UPDATE SET
             technical_status = CASE
               WHEN workshop_module_progress.technical_status = 'verified'
                 THEN 'verified'
               WHEN workshop_module_progress.technical_status = 'caught_up'
                 THEN 'caught_up'
               WHEN excluded.technical_status = 'verified' THEN 'verified'
               ELSE workshop_module_progress.technical_status
             END,
             current_health = excluded.current_health,
             explain_back_status = CASE
               WHEN workshop_module_progress.explain_back_status = 'completed'
                 THEN 'completed'
               WHEN excluded.explain_back_status = 'completed' THEN 'completed'
               ELSE excluded.explain_back_status
             END,
             started_at = coalesce(
               workshop_module_progress.started_at,
               excluded.started_at
             ),
             first_verified_at = CASE
               WHEN workshop_module_progress.technical_status = 'caught_up'
                 THEN workshop_module_progress.first_verified_at
               ELSE coalesce(
                 workshop_module_progress.first_verified_at,
                 excluded.first_verified_at
               )
             END,
             caught_up_at = CASE
               WHEN workshop_module_progress.technical_status = 'verified'
                 THEN workshop_module_progress.caught_up_at
               ELSE coalesce(
                 workshop_module_progress.caught_up_at,
                 excluded.caught_up_at
               )
             END,
             explain_back_completed_at = coalesce(
               workshop_module_progress.explain_back_completed_at,
               excluded.explain_back_completed_at
             ),
             health_observed_at = excluded.health_observed_at,
             completed_at = coalesce(
               workshop_module_progress.completed_at,
               excluded.completed_at
             ),
             updated_at = excluded.updated_at`,
        )
        .bind(
          createAppId(),
          params.sessionId,
          params.participantUserId,
          module.id,
          technicalStatus,
          currentHealth,
          explainBackStatus,
          startedAt,
          firstVerifiedAt,
          params.observedAt,
          completedAt,
          params.observedAt,
          ...acceptanceBindings,
        ),
      params.database
        .prepare(
          `INSERT INTO workshop_events (
             id, organization_id, session_id, actor_user_id, type,
             payload_json, created_at
           ) ${
             params.acceptance
               ? `SELECT ?, ?, ?, NULL, 'progress.observed', ?, ?
                  ${acceptanceSql}`
               : "VALUES (?, ?, ?, NULL, 'progress.observed', ?, ?)"
           }`,
        )
        .bind(
          createAppId(),
          params.organizationId,
          params.sessionId,
          JSON.stringify({
            participantUserId: params.participantUserId,
            moduleId: module.id,
            technicalStatus: allPassing ? "verified" : null,
            currentHealth,
            explainBackStatus: null,
          }),
          params.observedAt,
          ...acceptanceBindings,
        ),
    );
  }

  return statements;
}

export function assertWorkshopProbeBatchResults(
  results: D1Result<unknown>[],
): void {
  if (results.some((result) => result.meta.changes !== 1)) {
    throw appError(
      500,
      "workshop_progress_update_failed",
      "failed to update workshop probe progress",
    );
  }
}

// Runtime probe ingestion calls this after authenticating the generic runtime
// execution. Keeping it independent from scenario runs is the integration
// point for the shared VM harness.
export async function recordWorkshopModuleObservation(params: {
  sessionId: string;
  participantUserId: string;
  moduleId: string;
  actorUserId?: string | null;
  technicalStatus?: WorkshopTechnicalStatus;
  currentHealth?: WorkshopCurrentHealth;
  explainBackStatus?: WorkshopExplainBackStatus;
  observedAt?: number;
}): Promise<WorkshopModuleProgressRecord> {
  const context = await loadWorkshopManifestForSession(params.sessionId);
  const module = requireManifestModule(context.manifest, params.moduleId);
  const db = workshopDb();
  const roster = await db
    .select({ workspaceEnabled: workshopSessionMembers.workspaceEnabled })
    .from(workshopSessionMembers)
    .where(
      and(
        eq(workshopSessionMembers.sessionId, params.sessionId),
        eq(workshopSessionMembers.userId, params.participantUserId),
      ),
    )
    .limit(1);
  if (!roster[0]?.workspaceEnabled) {
    throw appError(
      404,
      "workshop_participant_not_found",
      "workshop participant not found",
    );
  }
  const technicalStatus = validateTechnicalStatus(params.technicalStatus);
  const currentHealth = validateCurrentHealth(params.currentHealth);
  const explainBackStatus = validateExplainBackStatus(
    params.explainBackStatus ??
      (module.explainBackPrompt ? "pending" : "not_required"),
  );
  const now = params.observedAt ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw appError(
      400,
      "workshop_observation_time_invalid",
      "observation time must be a Unix millisecond timestamp",
    );
  }
  const inputTechnicalStatus = technicalStatus ?? "not_started";
  const inputCurrentHealth = currentHealth ?? "unknown";
  const rows = await db
    .insert(workshopModuleProgress)
    .values({
      id: createAppId(),
      sessionId: params.sessionId,
      userId: params.participantUserId,
      moduleId: params.moduleId,
      technicalStatus: inputTechnicalStatus,
      currentHealth: inputCurrentHealth,
      explainBackStatus,
      revealedHintIdsJson: [],
      startedAt: inputTechnicalStatus === "not_started" ? null : now,
      firstVerifiedAt: inputTechnicalStatus === "verified" ? now : null,
      caughtUpAt: inputTechnicalStatus === "caught_up" ? now : null,
      explainBackCompletedAt:
        explainBackStatus === "completed" ? now : null,
      healthObservedAt: currentHealth === undefined ? null : now,
      completedAt: isCompletedTechnicalStatus(inputTechnicalStatus) ? now : null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        workshopModuleProgress.sessionId,
        workshopModuleProgress.userId,
        workshopModuleProgress.moduleId,
      ],
      set: {
        technicalStatus:
          technicalStatus === undefined
            ? workshopModuleProgress.technicalStatus
            : sql`CASE
                WHEN ${workshopModuleProgress.technicalStatus} = 'verified' THEN 'verified'
                WHEN ${workshopModuleProgress.technicalStatus} = 'caught_up' THEN 'caught_up'
                WHEN excluded.technical_status = 'verified' THEN 'verified'
                ELSE excluded.technical_status
              END`,
        currentHealth:
          currentHealth === undefined
            ? workshopModuleProgress.currentHealth
            : sql`excluded.current_health`,
        explainBackStatus: sql`CASE
          WHEN ${workshopModuleProgress.explainBackStatus} = 'completed' THEN 'completed'
          WHEN excluded.explain_back_status = 'completed' THEN 'completed'
          ELSE excluded.explain_back_status
        END`,
        startedAt: sql`coalesce(${workshopModuleProgress.startedAt}, excluded.started_at)`,
        firstVerifiedAt: sql`CASE
          WHEN ${workshopModuleProgress.technicalStatus} = 'caught_up'
            THEN ${workshopModuleProgress.firstVerifiedAt}
          ELSE coalesce(${workshopModuleProgress.firstVerifiedAt}, excluded.first_verified_at)
        END`,
        caughtUpAt: sql`CASE
          WHEN ${workshopModuleProgress.technicalStatus} = 'verified'
            THEN ${workshopModuleProgress.caughtUpAt}
          ELSE coalesce(${workshopModuleProgress.caughtUpAt}, excluded.caught_up_at)
        END`,
        explainBackCompletedAt: sql`coalesce(${workshopModuleProgress.explainBackCompletedAt}, excluded.explain_back_completed_at)`,
        healthObservedAt:
          currentHealth === undefined
            ? workshopModuleProgress.healthObservedAt
            : now,
        completedAt: sql`coalesce(${workshopModuleProgress.completedAt}, excluded.completed_at)`,
        updatedAt: now,
      },
    })
    .returning();
  const row = rows[0];
  if (!row) {
    throw appError(
      500,
      "workshop_progress_update_failed",
      "failed to update workshop progress",
    );
  }
  await appendWorkshopEvent(db, {
    organizationId: context.organizationId,
    sessionId: params.sessionId,
    actorUserId: params.actorUserId ?? null,
    type: "progress.observed",
    payload: {
      participantUserId: params.participantUserId,
      moduleId: params.moduleId,
      technicalStatus: params.technicalStatus ?? null,
      currentHealth: params.currentHealth ?? null,
      explainBackStatus: params.explainBackStatus ?? null,
    },
    createdAt: now,
  });
  return progressRecord(row);
}

export async function listWorkshopProgress(
  sessionId: string,
  userId?: string,
): Promise<WorkshopModuleProgressRecord[]> {
  const db = workshopDb();
  const rows = await db
    .select()
    .from(workshopModuleProgress)
    .where(
      userId
        ? and(
            eq(workshopModuleProgress.sessionId, sessionId),
            eq(workshopModuleProgress.userId, userId),
          )
        : eq(workshopModuleProgress.sessionId, sessionId),
    );
  return rows.map(progressRecord);
}

async function requireParticipantModuleReleased(
  sessionId: string,
  moduleId: string,
) {
  const context = await loadWorkshopManifestForSession(sessionId);
  const module = requireManifestModule(context.manifest, moduleId);
  const rows = await workshopDb()
    .select({ releasedModuleIds: workshopSessions.releasedModuleIdsJson })
    .from(workshopSessions)
    .where(eq(workshopSessions.id, sessionId))
    .limit(1);
  if (!rows[0]?.releasedModuleIds.includes(moduleId)) {
    throw appError(
      409,
      "workshop_module_not_released",
      "this workshop module has not been released",
    );
  }
  return { context, module };
}

function progressRecord(
  row: typeof workshopModuleProgress.$inferSelect,
): WorkshopModuleProgressRecord {
  return {
    id: row.id,
    userId: row.userId,
    moduleId: row.moduleId,
    technicalStatus: row.technicalStatus,
    currentHealth: row.currentHealth,
    explainBackStatus: row.explainBackStatus,
    revealedHintIds: row.revealedHintIdsJson,
    startedAt: row.startedAt,
    firstVerifiedAt: row.firstVerifiedAt,
    caughtUpAt: row.caughtUpAt,
    explainBackCompletedAt: row.explainBackCompletedAt,
    healthObservedAt: row.healthObservedAt,
    completedAt: row.completedAt,
    updatedAt: row.updatedAt,
  };
}

function validateTechnicalStatus(
  value: WorkshopTechnicalStatus | undefined,
): WorkshopTechnicalStatus | undefined {
  if (
    value !== undefined &&
    ![
      "not_started",
      "working",
      "verified",
      "caught_up",
      "manually_completed",
      "skipped",
    ].includes(value)
  ) {
    throw appError(
      400,
      "workshop_technical_status_invalid",
      "invalid workshop technical status",
    );
  }
  return value;
}

function validateCurrentHealth(
  value: WorkshopCurrentHealth | undefined,
): WorkshopCurrentHealth | undefined {
  if (
    value !== undefined &&
    value !== "unknown" &&
    value !== "passing" &&
    value !== "failing"
  ) {
    throw appError(
      400,
      "workshop_health_invalid",
      "invalid workshop health value",
    );
  }
  return value;
}

function validateExplainBackStatus(
  value: WorkshopExplainBackStatus,
): WorkshopExplainBackStatus {
  if (
    value !== "not_required" &&
    value !== "pending" &&
    value !== "completed"
  ) {
    throw appError(
      400,
      "workshop_explain_back_invalid",
      "invalid workshop explain-back status",
    );
  }
  return value;
}

function isCompletedTechnicalStatus(value: WorkshopTechnicalStatus): boolean {
  return (
    value === "verified" ||
    value === "caught_up" ||
    value === "manually_completed" ||
    value === "skipped"
  );
}
