import { env } from "cloudflare:workers";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { scenarioRuns } from "@/db/schema";
import { appError } from "@/lib/app-error";
import { getScenarioRunForUser, type ScenarioRunRecord } from "@/lib/scenario-runs";
import {
  appendRevealedScenarioRunHintKey,
  decideScenarioRunHintReveal,
  isScenarioRunSolved,
} from "@/lib/scenario-run-content";
import {
  buildInitialRunState,
  recomputeRunState,
  type RunStateDocument,
} from "@/lib/run-state";

export async function revealScenarioRunHintForUser(input: {
  runId: string;
  userId: string;
  hintKey: string;
  /** Private broker fence; browser callers intentionally omit this. */
  mutationFence?: ScenarioRunCliMutationFence;
  /** Test seam for a replacement which lands after the initial read. */
  beforeMutation?: () => Promise<void> | void;
}): Promise<ScenarioRunRecord> {
  const db = drizzle(env.DB);
  const [row] = await db
    .select()
    .from(scenarioRuns)
    .where(and(eq(scenarioRuns.runId, input.runId), eq(scenarioRuns.userId, input.userId)))
    .limit(1);
  if (!row) {
    throw appError(404, "scenario_run_not_found", "scenario run not found");
  }

  const decision = decideScenarioRunHintReveal({
    hints: row.hintsJson,
    revealedHintKeys: row.revealedHintsJson,
    requestedHintKey: input.hintKey,
  });
  if (!decision.allowed && decision.reason === "unknown") {
    throw appError(404, "scenario_hint_unknown", "hint not found");
  }
  if (!decision.allowed && decision.reason === "already_revealed") {
    throw appError(
      409,
      "scenario_hint_already_revealed",
      "hint is already revealed",
    );
  }
  if (!decision.allowed) {
    throw appError(
      409,
      "scenario_hint_not_next",
      "only the next hint of its group can be revealed",
    );
  }

  const now = Date.now();
  const revealedHintsJson = appendRevealedScenarioRunHintKey({
    hints: row.hintsJson,
    revealedHintKeys: row.revealedHintsJson,
    hintKey: decision.hintKey,
  });
  await input.beforeMutation?.();
  const updated = await db
    .update(scenarioRuns)
    .set({
      revealedHintsJson,
      updatedAt: now,
    })
    .where(
      and(
        eq(scenarioRuns.runId, input.runId),
        eq(scenarioRuns.userId, input.userId),
        eq(scenarioRuns.revealedHintsJson, row.revealedHintsJson),
        ...(input.mutationFence
          ? [scenarioRunCliMutationGuard(input.mutationFence)]
          : []),
      ),
    )
    .returning({ runId: scenarioRuns.runId });
  if (!updated.length) {
    if (input.mutationFence) throw staleRunCliFence();
    return getScenarioRunForUser({ runId: input.runId, userId: input.userId });
  }

  return getScenarioRunForUser({ runId: input.runId, userId: input.userId });
}

export async function revealScenarioRunSolutionForUser(input: {
  runId: string;
  userId: string;
  /** Private broker fence; browser callers intentionally omit this. */
  mutationFence?: ScenarioRunCliMutationFence;
  /** Test seam for a replacement which lands after the initial read. */
  beforeMutation?: () => Promise<void> | void;
}): Promise<ScenarioRunRecord> {
  const db = drizzle(env.DB);
  const [row] = await db
    .select()
    .from(scenarioRuns)
    .where(and(eq(scenarioRuns.runId, input.runId), eq(scenarioRuns.userId, input.userId)))
    .limit(1);
  if (!row) {
    throw appError(404, "scenario_run_not_found", "scenario run not found");
  }

  const now = Date.now();
  const solved = isScenarioRunSolved({
    state: parseRunState(row.stateJson),
    solvedAt: row.solvedAt,
  });
  await input.beforeMutation?.();
  const updated = await db
    .update(scenarioRuns)
    .set({
      solutionRevealedAt: row.solutionRevealedAt ?? now,
      solutionAssisted: row.solutionAssisted || !solved,
      updatedAt: now,
    })
    .where(
      and(
        eq(scenarioRuns.runId, input.runId),
        eq(scenarioRuns.userId, input.userId),
        ...(input.mutationFence
          ? [scenarioRunCliMutationGuard(input.mutationFence)]
          : []),
      ),
    )
    .returning({ runId: scenarioRuns.runId });
  if (!updated.length && input.mutationFence) throw staleRunCliFence();

  return getScenarioRunForUser({ runId: input.runId, userId: input.userId });
}

export interface ScenarioRunCliMutationFence {
  executionId: string;
  hostId: string;
  runtimeVmName: string;
  jailGeneration: string;
  userId: string;
}

function scenarioRunCliMutationGuard(input: ScenarioRunCliMutationFence) {
  return sql`EXISTS (
    SELECT 1
    FROM runtime_executions execution
    INNER JOIN access_allowlist access
      ON access.user_id = ${scenarioRuns.userId}
    INNER JOIN runtime_vms vm
      ON vm.execution_id = execution.id
    INNER JOIN runtime_vm_actual_state actual
      ON actual.runtime_vm_id = vm.id
     AND actual.execution_id = execution.id
    WHERE execution.id = ${input.executionId}
      AND access.state = 'active'
      AND execution.host_id = ${input.hostId}
      AND execution.domain_kind = 'scenario'
      AND execution.domain_id = ${scenarioRuns.runId}
      AND execution.state = 'ready'
      AND vm.runtime_vm_name = ${input.runtimeVmName}
      AND actual.host_id = ${input.hostId}
      AND json_extract(actual.report_json, '$.run_id') = execution.id
      AND json_extract(actual.report_json, '$.vm_name') = ${input.runtimeVmName}
      AND json_extract(actual.report_json, '$.runtime_constraints.generation') = ${input.jailGeneration}
      AND ${scenarioRuns.runtimeExecutionId} = execution.id
      AND ${scenarioRuns.activeKey} = ${input.userId}
      AND ${scenarioRuns.deleteRequestedAt} IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM runtime_executions newer
        WHERE newer.domain_kind = execution.domain_kind
          AND newer.domain_id = execution.domain_id
          AND newer.generation > execution.generation
      )
  )`;
}

function staleRunCliFence() {
  return appError(
    409,
    "scenario_run_cli_fence_stale",
    "scenario run changed before the CLI action could be applied",
  );
}

function parseRunState(raw: string): RunStateDocument {
  try {
    return recomputeRunState(JSON.parse(raw) as RunStateDocument);
  } catch {
    return buildInitialRunState({ vms: [] });
  }
}
