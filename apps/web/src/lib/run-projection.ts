// The one projection from derived run state to the run row: phase, solved,
// completed, failed, the active slot and course completion. The host Durable
// Object calls it for reports from hosts; the desktop channel (#399) will
// call it for reports from a learner's device.

import { and, eq, exists, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { agentHosts, scenarioRuns, runtimeExecutions } from "@/db/schema";
import { recordLinkedCourseUnitCompletionForRun } from "@/lib/course-catalogs";
import {
  RUN_PHASE_ORDER,
  buildInitialRunState,
  canAdvanceRunPhase,
  recomputeRunState,
  type RunStateDocument,
} from "@/lib/run-state";
import {
  drizzleQueryToD1Statement,
  executeScenarioRunRuntimeProjection,
} from "@/lib/runtime-executions";
import { nextSolvedAt } from "@/lib/scenario-run-outcome";

export interface RunProjectionRow {
  runId: string;
  hostId: string;
  activeKey: string | null;
  deleteRequestedAt: number | null;
  solvedAt: number | null;
  completedAt: number | null;
  failedAt: number | null;
  createdAt: number;
  updatedAt: number;
  state: RunStateDocument;
}

export type RunProjectionOutcome =
  | { kind: "updated"; revision: number }
  | { kind: "unchanged" }
  | { kind: "stale_session" };

export async function persistRunState(
  d1: D1Database,
  runId: string,
  deriveNextState: (current: RunStateDocument) => RunStateDocument,
  options?: {
    deleteRequestedAt?: number | null;
    keepDeleteRequestedAt?: boolean;
    initialRow?: RunProjectionRow;
    expectedExecution?: { id: string; ownerUserId: string; generation: number };
    expectedHostSession?: {
      hostId: string;
      activeSessionId: string;
      credentialGeneration: number;
    };
  },
): Promise<RunProjectionOutcome> {
  const db = drizzle(d1);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    // The direct VM-report path already loaded this row for its ownership
    // check inside the per-run ordering domain. Reuse it for attempt zero;
    // a failed CAS still reloads authoritative state before retrying.
    const row =
      attempt === 0 && options?.initialRow?.runId === runId
        ? options.initialRow
        : await loadRunProjection(d1, runId);
    if (!row) {
      return { kind: "unchanged" };
    }

    const current = recomputeRunState(row.state);
    const recomputed = recomputeRunState(deriveNextState(current));
    const phase = canAdvanceRunPhase(current.phase, recomputed.phase)
      ? recomputed.phase
      : current.phase;
    const merged =
      phase === recomputed.phase
        ? recomputed
        : {
            ...recomputed,
            phase,
          };

    // A strictly increasing value doubles as the optimistic projection
    // generation, even when two writes occur in the same millisecond.
    const now = Math.max(Date.now(), row.updatedAt + 1);
    const deleteRequestedAt = options?.keepDeleteRequestedAt
      ? row.deleteRequestedAt
      : (options?.deleteRequestedAt ?? row.deleteRequestedAt);
    const solvedAt = nextSolvedAt({
      currentPhase: current.phase,
      nextPhase: merged.phase,
      existingSolvedAt: row.solvedAt,
      now,
    });
    const completedAt =
      merged.phase === "completed" ? (row.completedAt ?? now) : null;
    const failedAt = merged.phase === "failed" ? (row.failedAt ?? now) : null;
    const nextActiveKey =
      (merged.phase === "completed" || merged.phase === "failed") &&
      deleteRequestedAt === null
        ? null
        : row.activeKey;
    const currentJson = JSON.stringify(current);
    const nextJson = JSON.stringify(merged);

    if (
      currentJson === nextJson &&
      row.activeKey === nextActiveKey &&
      row.deleteRequestedAt === deleteRequestedAt &&
      row.solvedAt === solvedAt &&
      row.completedAt === completedAt &&
      row.failedAt === failedAt
    ) {
      if (merged.phase === "completed" && solvedAt !== null) {
        await recordLinkedCourseUnitCompletionForRun(db, {
          runId,
          nowUnixMs: now,
        });
      }
      return { kind: "unchanged" };
    }

    const expectedHostSession = options?.expectedHostSession;
    const mutation = db
      .update(scenarioRuns)
      .set({
        state: merged.phase,
        stateRank: RUN_PHASE_ORDER[merged.phase],
        stateJson: nextJson,
        activeKey: nextActiveKey,
        deleteRequestedAt,
        solvedAt,
        completedAt,
        failedAt,
        // A run ends `lab_failed` when it fails because a guest's lab did.
        ...(merged.phase === "failed" && merged.vms.some((vm) => vm.lab?.state === "failed")
          ? { endReason: sql<"lab_failed">`coalesce(${scenarioRuns.endReason}, 'lab_failed')` }
          : {}),
        archiveEnteredAt: ["archiving", "completed", "failed"].includes(
          merged.phase,
        )
          ? sql<number>`coalesce(${scenarioRuns.archiveEnteredAt}, ${now})`
          : sql<number | null>`${scenarioRuns.archiveEnteredAt}`,
        updatedAt: now,
      })
      .where(
        and(
          eq(scenarioRuns.runId, runId),
          eq(scenarioRuns.updatedAt, row.updatedAt),
          ...(options?.expectedExecution ? [sql`EXISTS (SELECT 1 FROM runtime_executions execution
            WHERE execution.id = ${options.expectedExecution.id}
              AND execution.id = ${scenarioRuns.runtimeExecutionId}
              AND execution.user_id = ${options.expectedExecution.ownerUserId}
              AND execution.generation = ${options.expectedExecution.generation}
              AND execution.host_id = ${scenarioRuns.hostId}
              AND execution.state <> 'archived'
              AND execution.domain_id = ${scenarioRuns.runId}
              AND NOT EXISTS (SELECT 1 FROM runtime_executions newer WHERE newer.domain_kind = execution.domain_kind
                AND newer.domain_id = execution.domain_id AND newer.generation > execution.generation))`] : []),
          ...(expectedHostSession
            ? [
                exists(
                  db
                    .select({ id: agentHosts.id })
                    .from(agentHosts)
                    .where(
                      and(
                        eq(agentHosts.id, expectedHostSession.hostId),
                        eq(agentHosts.credentialGeneration, expectedHostSession.credentialGeneration),
                        eq(agentHosts.disabled, false),
                        sql`(${agentHosts.scope} = 'platform' OR (${agentHosts.scope} = 'personal'
                          AND ${agentHosts.userId} = ${scenarioRuns.userId})
                          OR (${agentHosts.scope} = 'organization' AND ${agentHosts.role} = 'agent'
                            AND ${agentHosts.organizationId} = ${scenarioRuns.organizationId}
                            AND EXISTS (SELECT 1 FROM member membership
                              JOIN user member_user ON member_user.id = membership.user_id
                              WHERE membership.organization_id = ${agentHosts.organizationId}
                                AND membership.user_id = ${scenarioRuns.userId}
                                AND member_user.deleted_at IS NULL AND coalesce(member_user.banned, 0) = 0)))`,
                        eq(
                          agentHosts.activeSessionId,
                          expectedHostSession.activeSessionId,
                        ),
                      ),
                    ),
                ),
              ]
            : []),
        ),
      )
      .returning({ runId: scenarioRuns.runId });
    const [updatedResult] = await executeScenarioRunRuntimeProjection({
      d1,
      runId,
      statements: [drizzleQueryToD1Statement(d1, mutation)],
      mode: "update",
    });
    const updated = updatedResult?.results ?? [];
    if (!updated.length) {
      if (options?.expectedExecution) {
        const execution = await db.select({ id: runtimeExecutions.id }).from(runtimeExecutions)
          .innerJoin(scenarioRuns, eq(scenarioRuns.runtimeExecutionId, runtimeExecutions.id))
          .where(and(eq(scenarioRuns.runId, runId), eq(runtimeExecutions.id, options.expectedExecution.id),
            eq(runtimeExecutions.generation, options.expectedExecution.generation),
            eq(runtimeExecutions.userId, options.expectedExecution.ownerUserId),
            sql`${runtimeExecutions.state} <> 'archived'`)).get();
        if (!execution) return { kind: "unchanged" };
      }
      if (
        expectedHostSession &&
        !(await isActiveHostSession(d1, expectedHostSession))
      ) {
        return { kind: "stale_session" };
      }
      continue;
    }

    if (merged.phase === "completed" && solvedAt !== null) {
      await recordLinkedCourseUnitCompletionForRun(db, {
        runId,
        nowUnixMs: now,
      });
    }

    if (!current.canOpenTerminal && merged.canOpenTerminal) {
      logLifecycleTiming({
        metric: "accepted_to_terminal_ready",
        runId,
        startedAt: row.createdAt,
        completedAt: now,
      });
    }
    if (
      row.deleteRequestedAt !== null &&
      !allVmsReportedAbsent(current) &&
      allVmsReportedAbsent(merged)
    ) {
      logLifecycleTiming({
        metric: "teardown_requested_to_vm_absent",
        runId,
        startedAt: row.deleteRequestedAt,
        completedAt: latestVmAbsenceAt(merged) ?? now,
      });
    }
    return { kind: "updated", revision: now };
  }
  throw new Error(`run projection CAS did not converge for ${runId}`);
}

export async function loadRunProjection(
  d1: D1Database,
  runId: string,
): Promise<RunProjectionRow | null> {
  const db = drizzle(d1);
  const rows = await db
    .select({
      runId: scenarioRuns.runId,
      hostId: scenarioRuns.hostId,
      activeKey: scenarioRuns.activeKey,
      deleteRequestedAt: scenarioRuns.deleteRequestedAt,
      solvedAt: scenarioRuns.solvedAt,
      completedAt: scenarioRuns.completedAt,
      failedAt: scenarioRuns.failedAt,
      createdAt: scenarioRuns.createdAt,
      updatedAt: scenarioRuns.updatedAt,
      stateJson: scenarioRuns.stateJson,
    })
    .from(scenarioRuns)
    .where(eq(scenarioRuns.runId, runId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    runId: row.runId,
    hostId: row.hostId,
    activeKey: row.activeKey,
    deleteRequestedAt: row.deleteRequestedAt,
    solvedAt: row.solvedAt,
    completedAt: row.completedAt,
    failedAt: row.failedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    state: parseRunState(row.stateJson),
  };
}

async function isActiveHostSession(d1: D1Database, input: {
  hostId: string;
  activeSessionId: string;
  credentialGeneration: number;
}): Promise<boolean> {
  const rows = await drizzle(d1)
    .select({ id: agentHosts.id })
    .from(agentHosts)
    .where(
      and(
        eq(agentHosts.id, input.hostId),
        eq(agentHosts.activeSessionId, input.activeSessionId),
        eq(agentHosts.credentialGeneration, input.credentialGeneration),
        eq(agentHosts.disabled, false),
      ),
    )
    .limit(1);
  return rows.length === 1;
}

function allVmsReportedAbsent(state: RunStateDocument): boolean {
  return (
    state.vms.length > 0 &&
    state.vms.every((vm) => vm.runtimeState === "absent")
  );
}

function latestVmAbsenceAt(state: RunStateDocument): number | null {
  const observed = state.vms
    .filter((vm) => vm.runtimeState === "absent")
    .map((vm) => vm.runtimeObservedAt)
    .filter((value): value is number => value !== null);
  return observed.length ? Math.max(...observed) : null;
}

function logLifecycleTiming(input: {
  metric: "accepted_to_terminal_ready" | "teardown_requested_to_vm_absent";
  runId: string;
  startedAt: number;
  completedAt: number;
}) {
  console.log(
    JSON.stringify({
      event: "scenario_run_lifecycle_timing",
      metric: input.metric,
      runId: input.runId,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      durationMs: Math.max(0, input.completedAt - input.startedAt),
    }),
  );
}

function parseRunState(raw: string): RunStateDocument {
  try {
    return recomputeRunState(JSON.parse(raw) as RunStateDocument);
  } catch {
    return buildInitialRunState({ vms: [] });
  }
}
