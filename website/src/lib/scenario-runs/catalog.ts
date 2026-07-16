import { env } from "cloudflare:workers";
import { and, desc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { appError } from "@/lib/app-error";
import { scenarioRuns } from "@/db/schema";
import { RUN_PHASE_ORDER, type RunPhase } from "@/lib/run-state";
import {
  deriveScenarioRunOutcome,
  deriveScenarioRunSolveDurationMs,
} from "@/lib/scenario-run-outcome";
import {
  type ScenarioCatalogEntry,
  type ScenarioDetail,
  type ScenarioRunRecord,
  type ScenarioRunListEntry,
  type ScenarioProgress,
  type ScenarioCatalogWireEntry,
} from "./types";
import {
  loadEnabledScenarioRows,
  slugify,
  loadActiveRunRow,
  loadFinishedRuns,
  loadRunRow,
  toScenarioRunRecord,
  hydrateScenarioRunReplayArtifacts,
  parseRunState,
  scenarioRunDifficulty,
} from "./storage";
import {
  deriveScenarioRunActivity,
  deriveScenarioRunReplayState,
} from "./activity";

export async function listEnabledScenariosForUser(options?: {
  organizationId?: string | null;
}): Promise<ScenarioCatalogEntry[]> {
  const scenarios = await loadEnabledScenarioRows(
    undefined,
    options?.organizationId ?? null,
  );
  return scenarios.map((scenario) => ({
    scenarioId: scenario.scenarioId,
    organizationId: scenario.organizationId,
    slug: slugify(scenario.scenarioId),
    title: scenario.briefing.title,
    tagline: scenario.briefing.tagline,
    difficulty: scenario.briefing.difficulty,
    estimatedMinutes: scenario.briefing.estimatedMinutes,
    tags: scenario.briefing.tags,
    category: scenario.briefing.category,
    scenarioName: scenario.scenarioId,
    enabledAt: scenario.enabledAt,
    vmCount: scenario.launchSpecs.length,
  }));
}

export async function loadEnabledScenarioForUser(params: {
  scenarioId: string;
  userId: string;
  organizationId?: string | null;
}): Promise<ScenarioDetail | null> {
  const rows = await loadEnabledScenarioRows(
    params.scenarioId,
    params.organizationId ?? null,
  );
  const enabled = rows[0];
  if (!enabled) {
    return null;
  }

  const active = await loadActiveRunRow(params.userId);
  const activeHere =
    active &&
    active.scenarioId === enabled.scenarioId &&
    active.organizationId === (params.organizationId ?? null)
      ? active
      : null;
  const finishedRuns = await loadFinishedRuns(
    params.userId,
    enabled.scenarioId,
    params.organizationId ?? null,
  );
  return {
    scenarioId: enabled.scenarioId,
    organizationId: enabled.organizationId,
    slug: slugify(enabled.scenarioId),
    enabledAt: enabled.enabledAt,
    scenarioName: enabled.scenarioId,
    briefing: enabled.briefing,
    vmCount: enabled.launchSpecs.length,
    hasActiveRun: activeHere !== null,
    activeRunId: activeHere?.runId ?? null,
    activeRun: activeHere
      ? {
          runId: activeHere.runId,
          phase: activeHere.state.phase,
          phaseTitle: activeHere.state.phaseTitle,
          phaseDetail: activeHere.state.phaseDetail,
          canOpenTerminal: activeHere.state.canOpenTerminal,
          terminalPhase: activeHere.state.terminalPhase,
          updatedAt: activeHere.updatedAt,
        }
      : null,
    blockingRun:
      active && !activeHere
        ? {
            runId: active.runId,
            scenarioId: active.scenarioId,
            slug: slugify(active.scenarioId),
            title: active.title,
          }
        : null,
    finishedRuns,
  };
}

export async function getScenarioRunForUser(params: {
  runId: string;
  userId: string;
}): Promise<ScenarioRunRecord> {
  const row = await loadRunRow(params.runId, params.userId);
  if (!row) {
    throw appError(404, "scenario_run_not_found", "scenario run not found");
  }
  const run = toScenarioRunRecord(row);
  // Recording artifacts are produced only after teardown starts. Keep the
  // startup/readiness poll to one run-row query without hiding artifact
  // upload progress from teardown and archive views.
  if (RUN_PHASE_ORDER[run.phase] < RUN_PHASE_ORDER.teardown_requested) {
    return run;
  }
  return hydrateScenarioRunReplayArtifacts(run);
}

export async function listScenarioRunsForUser(params: {
  userId: string;
}): Promise<ScenarioRunListEntry[]> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      runId: scenarioRuns.runId,
      scenarioId: scenarioRuns.scenarioId,
      organizationId: scenarioRuns.organizationId,
      scenarioName: scenarioRuns.scenarioName,
      title: scenarioRuns.title,
      difficulty: scenarioRuns.difficulty,
      state: scenarioRuns.state,
      stateJson: scenarioRuns.stateJson,
      activeKey: scenarioRuns.activeKey,
      createdAt: scenarioRuns.createdAt,
      completedAt: scenarioRuns.completedAt,
      solvedAt: scenarioRuns.solvedAt,
      failedAt: scenarioRuns.failedAt,
      deleteRequestedAt: scenarioRuns.deleteRequestedAt,
      solutionAssisted: scenarioRuns.solutionAssisted,
    })
    .from(scenarioRuns)
    .where(eq(scenarioRuns.userId, params.userId))
    .orderBy(desc(scenarioRuns.createdAt))
    .limit(100);

  return rows.map((row) => {
    const phase = row.state as RunPhase;
    const replayState = deriveScenarioRunReplayState(
      parseRunState(row.stateJson),
    );
    return {
      runId: row.runId,
      scenarioId: row.scenarioId,
      organizationId: row.organizationId,
      scenarioName: row.scenarioName,
      title: row.title,
      difficulty: scenarioRunDifficulty(row.runId, row.difficulty),
      phase,
      outcome: deriveScenarioRunOutcome({
        phase,
        solvedAt: row.solvedAt,
        deleteRequestedAt: row.deleteRequestedAt,
        failedAt: row.failedAt,
      }),
      active: row.activeKey !== null,
      activity: deriveScenarioRunActivity({
        activeKey: row.activeKey,
        phase,
      }),
      deleteRequestedAt: row.deleteRequestedAt,
      replayState,
      createdAt: row.createdAt,
      finishedAt: row.completedAt ?? row.failedAt ?? null,
      solvedAt: row.solvedAt,
      solveDurationMs: deriveScenarioRunSolveDurationMs({
        createdAt: row.createdAt,
        solvedAt: row.solvedAt,
      }),
      solutionAssisted: row.solutionAssisted,
      hasReplay: replayState === "ready",
    };
  });
}

export async function getScenarioProgressByScenario(
  userId: string,
  organizationId: string | null = null,
): Promise<Map<string, ScenarioProgress>> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      runId: scenarioRuns.runId,
      scenarioId: scenarioRuns.scenarioId,
      state: scenarioRuns.state,
      activeKey: scenarioRuns.activeKey,
      createdAt: scenarioRuns.createdAt,
      updatedAt: scenarioRuns.updatedAt,
      completedAt: scenarioRuns.completedAt,
      solvedAt: scenarioRuns.solvedAt,
      failedAt: scenarioRuns.failedAt,
      deleteRequestedAt: scenarioRuns.deleteRequestedAt,
    })
    .from(scenarioRuns)
    .where(
      and(
        eq(scenarioRuns.userId, userId),
        organizationId
          ? eq(scenarioRuns.organizationId, organizationId)
          : isNull(scenarioRuns.organizationId),
      ),
    );

  const progressByScenario = new Map<string, ScenarioProgress>();
  for (const row of rows) {
    const current =
      progressByScenario.get(row.scenarioId) ?? newScenarioProgress();
    const outcome = deriveScenarioRunOutcome({
      phase: row.state as RunPhase,
      solvedAt: row.solvedAt,
      deleteRequestedAt: row.deleteRequestedAt,
      failedAt: row.failedAt,
    });
    const finished =
      row.activeKey === null &&
      (row.state === "completed" || row.state === "failed");
    const finishedAt = row.completedAt ?? row.failedAt ?? null;
    const solveDurationMs = deriveScenarioRunSolveDurationMs({
      createdAt: row.createdAt,
      solvedAt: row.solvedAt,
    });

    if (row.activeKey !== null) {
      current.activeRunId = row.runId;
    }
    // A run cancelled before it was ever solved is not an attempt, and a
    // genuine solve counts as completed even when teardown later failed or
    // the user destroyed the run (outcome would report failed/cancelled).
    const solved = row.solvedAt !== null;
    if (finished && (outcome !== "cancelled" || solved)) {
      current.attemptCount += 1;
    }
    if (finished && solved) {
      current.completedCount += 1;
      if (solveDurationMs !== null) {
        current.bestSolveMs =
          current.bestSolveMs === null
            ? solveDurationMs
            : Math.min(current.bestSolveMs, solveDurationMs);
      }
    }
    current.lastPlayedAt = Math.max(
      current.lastPlayedAt ?? 0,
      row.updatedAt,
      finishedAt ?? 0,
      row.createdAt,
    );
    progressByScenario.set(row.scenarioId, current);
  }

  for (const progress of progressByScenario.values()) {
    progress.status =
      progress.activeRunId !== null
        ? "in_progress"
        : progress.completedCount > 0
          ? "completed"
          : progress.attemptCount > 0
            ? "attempted"
            : "new";
  }

  return progressByScenario;
}

export function newScenarioProgress(): ScenarioProgress {
  return {
    status: "new",
    activeRunId: null,
    attemptCount: 0,
    completedCount: 0,
    bestSolveMs: null,
    lastPlayedAt: null,
  };
}

export async function listScenarioCatalogForUser(
  userId: string,
  organizationId: string | null = null,
): Promise<ScenarioCatalogWireEntry[]> {
  const [scenarios, progressByScenario] = await Promise.all([
    listEnabledScenariosForUser({ organizationId }),
    getScenarioProgressByScenario(userId, organizationId),
  ]);
  return scenarios.map((scenario) => ({
    ...scenario,
    progress:
      progressByScenario.get(scenario.scenarioId) ?? newScenarioProgress(),
  }));
}
