import { env } from "cloudflare:workers";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  drizzleQueryToD1Statement,
  executeScenarioRunRuntimeProjection,
  releaseActiveRuntimeSlot,
} from "@/lib/runtime-executions";
import { appError } from "@/lib/app-error";
import {
  hostActualState,
  runtimeVms,
  scenarioRunArtifacts,
  scenarioRuns,
  type ScenarioRunHintSnapshot,
} from "@/db/schema";
import {
  buildScenarioLaunchSpecs,
  deriveScenarioBriefing,
  parseScenarioDifficulty,
  type ScenarioDifficulty,
  type ScenarioObjective,
} from "@/lib/scenario-model";
import {
  RUN_PHASE_ORDER,
  buildInitialRunState,
  recomputeRunState,
  type RunPhase,
  type ScenarioReplayArtifact,
  type RunStateDocument,
} from "@/lib/run-state";
import {
  buildScenarioRunHintViews,
  buildScenarioRunSolutionView,
} from "@/lib/scenario-run-content";
import {
  deriveScenarioRunOutcome,
  deriveScenarioRunSolveDurationMs,
  nextSolvedAt,
  type ScenarioRunOutcome,
} from "@/lib/scenario-run-outcome";
import {
  listEnabledScenarios,
  loadEnabledScenario,
  type ScenarioDetailRecord,
} from "@/lib/scenarios";
import { type ScenarioRunRecord } from "./types";
import {
  deriveScenarioRunActivity,
  deriveScenarioRunReplayState,
} from "./activity";
import { deriveScenarioRunSavingStage } from "./saving-stage";

export interface ScenarioRunContentSnapshot {
  tags: string[];
  hints: ScenarioRunHintSnapshot[];
  solutionMarkdown: string;
}

export async function loadEnabledScenarioRows(
  scenarioId?: string,
  organizationId: string | null = null,
) {
  const scenarios = scenarioId
    ? [await loadEnabledScenario(scenarioId, { organizationId })].filter(
        (scenario): scenario is ScenarioDetailRecord => Boolean(scenario),
      )
    : await listEnabledScenarios({ organizationId });

  return scenarios.map((scenario) => ({
    scenarioId: scenario.scenarioId,
    organizationId: scenario.organizationId,
    enabledAt: scenario.enabledAt ?? Date.now(),
    briefing: deriveScenarioBriefing(scenario),
    content: scenarioRunContentSnapshot(scenario),
    launchSpecs: buildScenarioLaunchSpecs(scenario),
  }));
}

export function scenarioRunContentSnapshot(
  scenario: ScenarioDetailRecord,
): ScenarioRunContentSnapshot {
  return {
    tags: scenario.tags,
    solutionMarkdown: scenario.solutionMarkdown,
    hints: [
      ...scenario.hints.map((hint) => ({
        key: `scenario:${hint.id}`,
        scope: "scenario" as const,
        probeName: null,
        id: hint.id,
        title: hint.title ?? null,
        bodyMarkdown: hint.body_markdown,
      })),
      ...scenario.probes.flatMap((probe) =>
        probe.hints.map((hint) => ({
          key: `probe:${probe.scenarioVmName}:${probe.name}:${hint.id}`,
          scope: "probe" as const,
          probeName: probe.name,
          id: hint.id,
          title: hint.title ?? null,
          bodyMarkdown: hint.body_markdown,
        })),
      ),
    ],
  };
}

export async function loadActiveRunRow(userId: string) {
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(scenarioRuns)
    .where(eq(scenarioRuns.activeKey, activeKeyFor(userId)))
    .limit(1);
  return rows[0] ? fromDbRow(rows[0]) : null;
}

export async function loadFinishedRuns(
  userId: string,
  scenarioId: string,
  organizationId: string | null = null,
) {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      runId: scenarioRuns.runId,
      state: scenarioRuns.state,
      stateJson: scenarioRuns.stateJson,
      createdAt: scenarioRuns.createdAt,
      completedAt: scenarioRuns.completedAt,
      solvedAt: scenarioRuns.solvedAt,
      failedAt: scenarioRuns.failedAt,
      deleteRequestedAt: scenarioRuns.deleteRequestedAt,
      solutionAssisted: scenarioRuns.solutionAssisted,
    })
    .from(scenarioRuns)
    .where(
      and(
        eq(scenarioRuns.userId, userId),
        eq(scenarioRuns.scenarioId, scenarioId),
        organizationId
          ? eq(scenarioRuns.organizationId, organizationId)
          : isNull(scenarioRuns.organizationId),
        isNull(scenarioRuns.activeKey),
        inArray(scenarioRuns.state, ["completed", "failed"]),
      ),
    )
    .orderBy(desc(scenarioRuns.createdAt));

  return rows.map((row) => {
    const replayState = deriveScenarioRunReplayState(
      parseRunState(row.stateJson),
    );
    return {
      runId: row.runId,
      phase: row.state as "completed" | "failed",
      outcome: toFinishedRunOutcome(
        deriveScenarioRunOutcome({
          phase: row.state as RunPhase,
          solvedAt: row.solvedAt,
          deleteRequestedAt: row.deleteRequestedAt,
          failedAt: row.failedAt,
        }),
      ),
      createdAt: row.createdAt,
      finishedAt: row.completedAt ?? row.failedAt ?? row.createdAt,
      solvedAt: row.solvedAt,
      solveDurationMs: deriveScenarioRunSolveDurationMs({
        createdAt: row.createdAt,
        solvedAt: row.solvedAt,
      }),
      solutionAssisted: row.solutionAssisted,
      replayState,
      hasReplay: replayState === "ready",
    };
  });
}

export async function loadRunRow(runId: string, userId?: string) {
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(scenarioRuns)
    .where(
      userId
        ? and(eq(scenarioRuns.runId, runId), eq(scenarioRuns.userId, userId))
        : eq(scenarioRuns.runId, runId),
    )
    .limit(1);
  return rows[0] ? fromDbRow(rows[0]) : null;
}

export async function updateRunState(
  runId: string,
  input: {
    mutate: (current: RunStateDocument) => RunStateDocument;
    deleteRequestedAt?: number | null;
    releaseActiveSlot?: boolean;
  },
): Promise<void> {
  const db = drizzle(env.DB);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const row = await loadRunRow(runId);
    if (!row) {
      return;
    }
    const current = recomputeRunState(row.state);
    const nextState = recomputeRunState(input.mutate(current));
    const terminal =
      nextState.phase === "completed" || nextState.phase === "failed";
    const deleteRequestedAt =
      input.deleteRequestedAt === undefined
        ? row.deleteRequestedAt
        : input.deleteRequestedAt;
    const now = Math.max(Date.now(), row.updatedAt + 1);
    const mutation = db
      .update(scenarioRuns)
      .set({
        state: nextState.phase,
        stateRank: RUN_PHASE_ORDER[nextState.phase],
        stateJson: JSON.stringify(nextState),
        activeKey:
          input.releaseActiveSlot === true ||
          (terminal && deleteRequestedAt === null)
            ? null
            : row.activeKey,
        deleteRequestedAt,
        solvedAt: nextSolvedAt({
          currentPhase: current.phase,
          nextPhase: nextState.phase,
          existingSolvedAt: row.solvedAt,
          now,
        }),
        completedAt:
          nextState.phase === "completed" ? (row.completedAt ?? now) : null,
        failedAt: nextState.phase === "failed" ? (row.failedAt ?? now) : null,
        archiveEnteredAt: ["archiving", "completed", "failed"].includes(
          nextState.phase,
        )
          ? sql<number>`coalesce(${scenarioRuns.archiveEnteredAt}, ${now})`
          : sql<number | null>`${scenarioRuns.archiveEnteredAt}`,
        updatedAt: now,
      })
      .where(
        and(
          eq(scenarioRuns.runId, runId),
          eq(scenarioRuns.updatedAt, row.updatedAt),
        ),
      )
      .returning({ runId: scenarioRuns.runId });
    const [updatedResult] = await executeScenarioRunRuntimeProjection({
      d1: env.DB,
      runId,
      statements: [drizzleQueryToD1Statement(env.DB, mutation)],
      mode: "update",
    });
    const updated = updatedResult?.results ?? [];
    if (updated.length) {
      if (
        row.runtimeExecutionId &&
        (input.releaseActiveSlot === true ||
          (terminal && deleteRequestedAt === null))
      ) {
        await releaseActiveRuntimeSlot({
          executionId: row.runtimeExecutionId,
          expectedGeneration: 1,
          now,
        });
      }
      return;
    }
  }
  throw new Error(`run state CAS did not converge for ${runId}`);
}

export function fromDbRow(row: typeof scenarioRuns.$inferSelect) {
  return {
    runId: row.runId,
    userId: row.userId,
    organizationId: row.organizationId,
    runtimeExecutionId: row.runtimeExecutionId,
    hostId: row.hostId,
    scenarioId: row.scenarioId,
    scenarioName: row.scenarioName,
    title: row.title,
    tagline: row.tagline,
    briefingMarkdown: row.briefingMarkdown,
    objectives: parseObjectives(row.objectivesJson),
    tags: row.tagsJson,
    hints: buildScenarioRunHintViews({
      hints: row.hintsJson,
      revealedHintKeys: row.revealedHintsJson,
    }),
    solution: buildScenarioRunSolutionView({
      solutionMarkdown: row.solutionMarkdown,
      solutionRevealedAt: row.solutionRevealedAt,
      solutionAssisted: row.solutionAssisted,
      state: parseRunState(row.stateJson),
      solvedAt: row.solvedAt,
    }),
    difficulty: scenarioRunDifficulty(row.runId, row.difficulty),
    estimatedMinutes: row.estimatedMinutes,
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

export function toScenarioRunRecord(
  row: ReturnType<typeof fromDbRow>,
): ScenarioRunRecord {
  const activity = deriveScenarioRunActivity({
    activeKey: row.activeKey,
    phase: row.state.phase,
  });
  const replayState = deriveScenarioRunReplayState(row.state);
  return {
    id: row.runId,
    scenarioId: row.scenarioId,
    organizationId: row.organizationId,
    scenarioName: row.scenarioName,
    title: row.title,
    tagline: row.tagline,
    briefingMarkdown: row.briefingMarkdown,
    objectives: row.objectives,
    tags: row.tags,
    hints: row.hints,
    solution: row.solution,
    difficulty: row.difficulty,
    estimatedMinutes: row.estimatedMinutes,
    solvedAt: row.solvedAt,
    solveDurationMs: deriveScenarioRunSolveDurationMs({
      createdAt: row.createdAt,
      solvedAt: row.solvedAt,
    }),
    outcome: deriveScenarioRunOutcome({
      phase: row.state.phase,
      solvedAt: row.solvedAt,
      deleteRequestedAt: row.deleteRequestedAt,
      failedAt: row.failedAt,
    }),
    active: row.activeKey !== null,
    activity,
    deleteRequestedAt: row.deleteRequestedAt,
    savingStage: deriveScenarioRunSavingStage({ phase: row.state.phase }),
    replayState,
    hasReplay: replayState === "ready",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...row.state,
  };
}

/**
 * Adds only the learner-safe aggregate archive stage to a full run view. A
 * pre-migration row or an older agent that has not reported every VM keeps
 * the existing coarse lifecycle stage instead of exposing partial internals.
 */
export async function hydrateScenarioRunSavingStage(
  run: ScenarioRunRecord,
  runtimeExecutionId: string | null,
): Promise<ScenarioRunRecord> {
  // Teardown requested and host shutdown map directly from the run state;
  // only archive processing needs the per-VM ledger. This keeps foreground
  // terminal polling to its existing single run-row query.
  if (run.phase !== "archiving" || !runtimeExecutionId) {
    return run;
  }
  const db = drizzle(env.DB);
  const rows = await db
    .select({ archiveStageRank: runtimeVms.archiveStageRank })
    .from(runtimeVms)
    .where(eq(runtimeVms.executionId, runtimeExecutionId));
  return {
    ...run,
    savingStage: deriveScenarioRunSavingStage({
      phase: run.phase,
      archiveStageRanks: rows.map((row) => row.archiveStageRank),
    }),
  };
}

export function toFinishedRunOutcome(
  outcome: ScenarioRunOutcome,
): Exclude<ScenarioRunOutcome, "in_progress"> {
  return outcome === "in_progress" ? "cancelled" : outcome;
}

export function parseRunState(raw: string): RunStateDocument {
  try {
    return recomputeRunState(JSON.parse(raw) as RunStateDocument);
  } catch {
    return buildInitialRunState({ vms: [] });
  }
}

// The unique index on active_key allows one foreground run per user across all
// scenarios. Teardown acceptance clears it explicitly; terminal failures with
// no pending teardown intent still release it automatically.
export function activeKeyFor(userId: string) {
  return userId;
}

export function activeRunConflictError(activeRunTitle?: string) {
  return appError(
    409,
    "scenario_run_active_conflict",
    activeRunTitle
      ? `you already have an active run for "${activeRunTitle}" — finish or destroy it before starting another scenario`
      : "you already have an active scenario run — finish or destroy it before starting another scenario",
  );
}

export function parseObjectives(raw: string): ScenarioObjective[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((item) => {
      if (
        typeof item !== "object" ||
        item === null ||
        Array.isArray(item) ||
        typeof item.probeName !== "string" ||
        typeof item.vmName !== "string" ||
        typeof item.label !== "string"
      ) {
        return [];
      }
      return [
        {
          probeName: item.probeName,
          vmName: item.vmName,
          label: item.label,
          title: typeof item.title === "string" ? item.title : null,
          bodyMarkdown:
            typeof item.bodyMarkdown === "string" ? item.bodyMarkdown : null,
          hintCount:
            typeof item.hintCount === "number" &&
            Number.isFinite(item.hintCount)
              ? Math.max(0, Math.floor(item.hintCount))
              : 0,
        } satisfies ScenarioObjective,
      ];
    });
  } catch {
    return [];
  }
}

export function scenarioRunDifficulty(
  runId: string,
  value: string,
): ScenarioDifficulty {
  const parsed = parseScenarioDifficulty(value);
  if (parsed) {
    return parsed;
  }
  throw appError(
    500,
    "scenario_run_invalid",
    `scenario run ${runId} has invalid difficulty`,
  );
}

export function slugify(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "scenario"
  );
}

export async function hydrateScenarioRunReplayArtifacts(
  run: ScenarioRunRecord,
): Promise<ScenarioRunRecord> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      id: scenarioRunArtifacts.id,
      runId: scenarioRunArtifacts.runId,
      vmId: scenarioRunArtifacts.vmId,
      kind: scenarioRunArtifacts.kind,
      filename: scenarioRunArtifacts.filename,
      contentType: scenarioRunArtifacts.contentType,
      sizeBytes: scenarioRunArtifacts.sizeBytes,
    })
    .from(scenarioRunArtifacts)
    .where(
      and(
        eq(scenarioRunArtifacts.runId, run.id),
        eq(scenarioRunArtifacts.uploadStatus, "uploaded"),
        eq(scenarioRunArtifacts.kind, "ssh_recording_segment"),
      ),
    )
    .orderBy(asc(scenarioRunArtifacts.vmId), asc(scenarioRunArtifacts.ordinal));

  const artifactsByVm = new Map<string, ScenarioReplayArtifact[]>();
  for (const row of rows) {
    const artifact: ScenarioReplayArtifact = {
      id: row.id,
      hostId: "",
      runId: row.runId,
      vmId: row.vmId,
      kind: row.kind,
      filename: row.filename,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
    };
    const artifacts = artifactsByVm.get(row.vmId) ?? [];
    artifacts.push(artifact);
    artifactsByVm.set(row.vmId, artifacts);
  }
  const vms = run.vms.map((vm) => ({
    ...vm,
    replayArtifacts: artifactsByVm.get(vm.id) ?? [],
  }));
  return {
    ...run,
    vms,
    replayArtifacts: vms.flatMap((vm) => vm.replayArtifacts),
  };
}

export async function loadHostTerminalAddress(
  hostId: string,
): Promise<string | null> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      report: hostActualState.reportJson,
    })
    .from(hostActualState)
    .where(eq(hostActualState.hostId, hostId))
    .limit(1);
  const capacity = rows[0]?.report?.capacity;
  return (
    capacity?.primary_ipv4?.trim() || capacity?.primary_ipv6?.trim() || null
  );
}
