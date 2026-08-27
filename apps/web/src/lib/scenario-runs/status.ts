import { env } from "cloudflare:workers";
import {
  and,
  count,
  eq,
  isNotNull,
  isNull,
  notInArray,
  or,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { appError } from "@/lib/app-error";
import { runtimeVms, scenarioRuns } from "@/db/schema";
import type { RunPhase, RunStateDocument } from "@/lib/run-state";
import {
  deriveScenarioRunActivity,
  deriveScenarioRunReplayState,
  type ScenarioRunActivity,
  type ScenarioRunReplayState,
} from "./activity";
import {
  deriveScenarioRunOutcome,
  deriveScenarioRunSolveDurationMs,
  type ScenarioRunOutcome,
} from "@/lib/scenario-run-outcome";
import {
  deriveScenarioRunSavingStage,
  type ScenarioRunSavingStage,
} from "./saving-stage";
import { parseRunState } from "./storage";

/**
 * The small, mutable portion of a scenario run. The full run view is loaded
 * once; this projection is safe to poll while a run is changing.
 */
export interface ScenarioRunStatus {
  /** Opaque token. It changes for run-state and archive-stage updates. */
  version: string;
  updatedAt: number;
  phase: RunPhase;
  phaseTitle: string;
  phaseDetail: string;
  progressPercent: number;
  terminalPhase: RunStateDocument["terminalPhase"];
  canOpenTerminal: boolean;
  canDestroy: boolean;
  terminalTarget: RunStateDocument["terminalTarget"];
  outcome: ScenarioRunOutcome;
  active: boolean;
  activity: ScenarioRunActivity;
  deleteRequestedAt: number | null;
  solvedAt: number | null;
  solveDurationMs: number | null;
  savingStage: ScenarioRunSavingStage | null;
  replayState: ScenarioRunReplayState;
  hasReplay: boolean;
  vms: Array<{
    id: string;
    phase: RunStateDocument["vms"][number]["phase"];
    phaseTitle: string;
    phaseDetail: string;
    progressPercent: number;
    terminalPhase: RunStateDocument["vms"][number]["terminalPhase"];
    canOpenTerminal: boolean;
    terminalTarget: RunStateDocument["vms"][number]["terminalTarget"];
    bootProbes: RunStateDocument["vms"][number]["bootProbes"];
    scenarioProbes: RunStateDocument["vms"][number]["scenarioProbes"];
    sessionTimeline: RunStateDocument["vms"][number]["sessionTimeline"];
    hasRecording?: boolean;
  }>;
}

export interface ScenarioRunsSummary {
  /** Foreground and safe-to-close background runs, excluding settled history. */
  activeCount: number;
  /** The one foreground run enforced by the active-slot constraint. */
  activeRunId: string | null;
}

/**
 * Loads only the fields that can change while the learner watches a run. It
 * intentionally omits authored copy, hints, provisioning detail, and replay
 * artifact metadata carried by the initial full view.
 */
export async function getScenarioRunStatusForUser(input: {
  runId: string;
  userId: string;
}): Promise<ScenarioRunStatus> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      runId: scenarioRuns.runId,
      runtimeExecutionId: scenarioRuns.runtimeExecutionId,
      stateJson: scenarioRuns.stateJson,
      activeKey: scenarioRuns.activeKey,
      deleteRequestedAt: scenarioRuns.deleteRequestedAt,
      solvedAt: scenarioRuns.solvedAt,
      failedAt: scenarioRuns.failedAt,
      createdAt: scenarioRuns.createdAt,
      updatedAt: scenarioRuns.updatedAt,
    })
    .from(scenarioRuns)
    .where(
      and(
        eq(scenarioRuns.runId, input.runId),
        eq(scenarioRuns.userId, input.userId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw appError(404, "scenario_run_not_found", "scenario run not found");
  }

  const state = parseRunState(row.stateJson);
  const archive = await loadArchiveStatusVersion({
    phase: state.phase,
    runtimeExecutionId: row.runtimeExecutionId,
  });
  const activity = deriveScenarioRunActivity({
    activeKey: row.activeKey,
    phase: state.phase,
  });
  const replayState = deriveScenarioRunReplayState(state);

  return {
    version: buildScenarioRunStatusVersion(row.updatedAt, archive.version),
    updatedAt: row.updatedAt,
    phase: state.phase,
    phaseTitle: state.phaseTitle,
    phaseDetail: state.phaseDetail,
    progressPercent: state.progressPercent,
    terminalPhase: state.terminalPhase,
    canOpenTerminal: state.canOpenTerminal,
    canDestroy: state.canDestroy,
    terminalTarget: state.terminalTarget,
    outcome: deriveScenarioRunOutcome({
      phase: state.phase,
      solvedAt: row.solvedAt,
      deleteRequestedAt: row.deleteRequestedAt,
      failedAt: row.failedAt,
    }),
    active: row.activeKey !== null,
    activity,
    deleteRequestedAt: row.deleteRequestedAt,
    solvedAt: row.solvedAt,
    solveDurationMs: deriveScenarioRunSolveDurationMs({
      createdAt: row.createdAt,
      solvedAt: row.solvedAt,
    }),
    savingStage: deriveScenarioRunSavingStage({
      phase: state.phase,
      archiveStageRanks: archive.stageRanks,
    }),
    replayState,
    hasReplay: replayState === "ready",
    vms: state.vms.map((vm) => ({
      id: vm.id,
      phase: vm.phase,
      phaseTitle: vm.phaseTitle,
      phaseDetail: vm.phaseDetail,
      progressPercent: vm.progressPercent,
      terminalPhase: vm.terminalPhase,
      canOpenTerminal: vm.canOpenTerminal,
      terminalTarget: vm.terminalTarget,
      bootProbes: vm.bootProbes,
      scenarioProbes: vm.scenarioProbes,
      sessionTimeline: vm.sessionTimeline,
      ...(vm.hasRecording === undefined
        ? {}
        : { hasRecording: vm.hasRecording }),
    })),
  };
}

/**
 * The sidebar has no need for historical rows. It uses a unique foreground
 * lookup and a scalar aggregate, so the response never materializes an
 * archive backlog.
 */
export async function getScenarioRunsSummaryForUser(input: {
  userId: string;
}): Promise<ScenarioRunsSummary> {
  const db = drizzle(env.DB);
  const visibleOngoingRun = and(
    eq(scenarioRuns.userId, input.userId),
    isNull(scenarioRuns.hiddenAt),
    or(
      // A foreground run has the user's active-slot key, even before the
      // first worker state update arrives.
      isNotNull(scenarioRuns.activeKey),
      // Accepted teardown releases that key while archive work remains.
      notInArray(scenarioRuns.state, ["completed", "failed"]),
    ),
  );

  const [foregroundRows, countRows] = await Promise.all([
    // active_key is unique per user. Keep this lookup separate from cleanup
    // history so a large archive backlog can never hide the live run.
    db
      .select({ runId: scenarioRuns.runId })
      .from(scenarioRuns)
      .where(
        and(
          eq(scenarioRuns.userId, input.userId),
          eq(scenarioRuns.activeKey, input.userId),
          isNull(scenarioRuns.hiddenAt),
        ),
      )
      .limit(1),
    // Count stays a single scalar response; it does not materialize archive
    // rows in the sidebar path.
    db
      .select({ activeCount: count() })
      .from(scenarioRuns)
      .where(visibleOngoingRun)
      .limit(1),
  ]);

  const foreground = foregroundRows[0] ?? null;
  const activeCount = countRows[0]?.activeCount ?? 0;

  return {
    activeCount,
    activeRunId: foreground?.runId ?? null,
  };
}

async function loadArchiveStatusVersion(input: {
  phase: RunPhase;
  runtimeExecutionId: string | null;
}): Promise<{
  version: string | null;
  stageRanks: Array<number | null> | null;
}> {
  if (input.phase !== "archiving" || !input.runtimeExecutionId) {
    return { version: null, stageRanks: null };
  }

  const db = drizzle(env.DB);
  const rows = await db
    .select({
      id: runtimeVms.id,
      archiveStageRank: runtimeVms.archiveStageRank,
      updatedAt: runtimeVms.updatedAt,
    })
    .from(runtimeVms)
    .where(eq(runtimeVms.executionId, input.runtimeExecutionId))
    .orderBy(runtimeVms.id);

  return {
    // The run row itself does not change for every archive callback. Include
    // the VM archive ledger so a 204 never hides a learner-visible stage.
    version: rows
      .map((row) => `${row.id}:${row.updatedAt}:${row.archiveStageRank ?? ""}`)
      .join(","),
    stageRanks: rows.map((row) => row.archiveStageRank),
  };
}

function buildScenarioRunStatusVersion(
  updatedAt: number,
  archiveVersion: string | null,
): string {
  return archiveVersion ? `${updatedAt}:${archiveVersion}` : String(updatedAt);
}
