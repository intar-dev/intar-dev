// Wire/view types for the scenario run page. These mirror the presented run
// record shape produced by lib/run-phase's presentScenarioRun.

import type { RunVmProvisioningSpec } from "@/lib/run-state";
import { presentScenarioRun } from "@/lib/run-phase";
import { pollingIntervalUnlessAccessError } from "@/components/app/lib/http-response-error";
import type {
  CourseLocation,
  ScenarioRunActivity,
  ScenarioRunRecord as ScenarioRunWireRecord,
  ScenarioRunReplayState,
  ScenarioRunSavingStage,
} from "@/lib/scenario-runs";
import type { ScenarioRunStatus as ScenarioRunWireStatus } from "@/lib/scenario-runs/status";

export interface ScenarioProbeStatus {
  id: string;
  label: string;
  kind: string;
  phase: "boot" | "scenario";
  status: string;
  error: string | null;
  value: unknown;
}

export interface ScenarioReplayArtifact {
  id: string;
  hostId: string;
  runId: string;
  vmId: string;
  kind: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

export interface SessionTimelineEntry {
  index: number;
  startTimestampMs: number;
  durationMs: number;
  exitCode: number | null;
  castFilename: string;
  /// Worker-resolved artifact id for the session's cast; null while the
  /// cast has not finished uploading.
  castArtifactId: string | null;
  transcriptTruncated: boolean;
}

export interface ScenarioRunVmRecord {
  id: string;
  ordinal: number;
  scenarioVmId: string;
  scenarioVmName: string;
  runtimeVmName: string;
  hostname: string;
  phase:
    | "launching"
    | "booting"
    | "waiting_for_target"
    | "running"
    | "solved"
    | "deleting"
    | "archiving"
    | "completed"
    | "failed";
  phaseTitle: string;
  phaseDetail: string;
  progressPercent: number;
  terminalPhase: "pending" | "ready" | "failed";
  canOpenTerminal: boolean;
  bootProbes: ScenarioProbeStatus[];
  scenarioProbes: ScenarioProbeStatus[];
  replayArtifacts: ScenarioReplayArtifact[];
  /// Session metadata in chronological order; null until the agent submits
  /// the final replay timeline.
  sessionTimeline: SessionTimelineEntry[] | null;
  /// True once a raw recording uploaded.
  hasRecording?: boolean;
  provisioning: RunVmProvisioningSpec;
  terminalTarget: {
    host: string | null;
    port: number;
    username: string;
    hostKeyOpenssh: string | null;
    checkedAt: number | null;
  };
}

export interface ScenarioRunRecord {
  id: string;
  scenarioId: string;
  organizationId?: string | null;
  courseLocation?: CourseLocation | null;
  scenarioName: string;
  phase:
    | "launching"
    | "booting"
    | "waiting_for_target"
    | "running"
    | "solved"
    | "deleting"
    | "archiving"
    | "completed"
    | "failed";
  phaseTitle: string;
  phaseDetail: string;
  title: string;
  tagline: string;
  /** Immutable course lecture snapshot for V2 course runs. */
  lectureTitle?: string | null;
  lectureSummary?: string | null;
  lectureBodyMarkdown?: string | null;
  /** V1 fallback for historical runs. */
  briefingMarkdown: string;
  objectives: ScenarioObjective[];
  tags: string[];
  hints: ScenarioRunHint[];
  solution: ScenarioRunSolution;
  difficulty: "easy" | "medium" | "hard";
  estimatedMinutes: number;
  solvedAt: number | null;
  solveDurationMs: number | null;
  outcome: "in_progress" | "succeeded" | "cancelled" | "failed";
  active: boolean;
  activity: ScenarioRunActivity;
  deleteRequestedAt: number | null;
  savingStage: ScenarioRunSavingStage | null;
  replayState: ScenarioRunReplayState;
  hasReplay: boolean;
  progressPercent: number;
  terminalPhase: "pending" | "ready" | "failed";
  canOpenTerminal: boolean;
  terminalTarget?: {
    host: string | null;
    port: number;
    username: string;
    hostKeyOpenssh: string | null;
    checkedAt: number | null;
  };
  canDestroy: boolean;
  createdAt: number;
  updatedAt: number;
  bootProbes: ScenarioProbeStatus[];
  scenarioProbes: ScenarioProbeStatus[];
  replayArtifacts: ScenarioReplayArtifact[];
  vms: ScenarioRunVmRecord[];
}

export interface ScenarioObjective {
  probeName: string;
  vmName: string;
  label: string;
  title: string | null;
  bodyMarkdown: string | null;
  hintCount: number;
}

// Hints unlock sequentially per group (the scenario-level ladder and one
// ladder per probe). Sealed hints carry neither title nor body; `unlocked`
// marks the single revealable hint of each group.
export interface ScenarioRunHint {
  key: string;
  scope: "scenario" | "probe";
  probeName: string | null;
  id: string;
  title: string | null;
  revealed: boolean;
  unlocked: boolean;
  bodyMarkdown: string | null;
}

export interface ScenarioRunSolution {
  unlocked: boolean;
  revealed: boolean;
  assisted: boolean;
  revealedAt: number | null;
  bodyMarkdown: string | null;
}

export interface ScenarioRunResponse {
  run: ScenarioRunRecord;
}

export type ScenarioRunStatus = ScenarioRunWireStatus;

/**
 * Applies a compact, server-authoritative status view without throwing away
 * the authored content and learner actions from the initially loaded run.
 */
export function mergeScenarioRunStatus(
  current: ScenarioRunRecord,
  status: ScenarioRunStatus | null,
): ScenarioRunRecord {
  // A mutation can place a newer complete record in the cache while an older
  // status request is still in flight. Never let that response move the run
  // backwards.
  if (!status || status.updatedAt < current.updatedAt) {
    return current;
  }

  const statusByVmId = new Map(status.vms.map((vm) => [vm.id, vm]));
  const merged = {
    ...current,
    phase: status.phase,
    phaseTitle: status.phaseTitle,
    phaseDetail: status.phaseDetail,
    progressPercent: status.progressPercent,
    terminalPhase: status.terminalPhase,
    canOpenTerminal: status.canOpenTerminal,
    canDestroy: status.canDestroy,
    terminalTarget: status.terminalTarget,
    outcome: status.outcome,
    active: status.active,
    activity: status.activity,
    deleteRequestedAt: status.deleteRequestedAt,
    solvedAt: status.solvedAt,
    solveDurationMs: status.solveDurationMs,
    savingStage: status.savingStage,
    replayState: status.replayState,
    hasReplay: status.hasReplay,
    updatedAt: status.updatedAt,
    bootProbes: status.vms.flatMap((vm) => vm.bootProbes),
    scenarioProbes: status.vms.flatMap((vm) => vm.scenarioProbes),
    vms: current.vms.map((vm) => {
      const next = statusByVmId.get(vm.id);
      if (!next) return vm;
      return {
        ...vm,
        phase: next.phase,
        phaseTitle: next.phaseTitle,
        phaseDetail: next.phaseDetail,
        progressPercent: next.progressPercent,
        terminalPhase: next.terminalPhase,
        canOpenTerminal: next.canOpenTerminal,
        terminalTarget: next.terminalTarget,
        bootProbes: next.bootProbes,
        scenarioProbes: next.scenarioProbes,
        sessionTimeline: next.sessionTimeline,
        ...(next.hasRecording === undefined
          ? {}
          : { hasRecording: next.hasRecording }),
      };
    }),
  };

  // The status endpoint keeps wire phases so it can remain an additive API.
  // Reapply the page's phase presentation after merging those live fields.
  return presentScenarioRun(
    merged as Parameters<typeof presentScenarioRun>[0],
  ) as ScenarioRunRecord;
}

export interface ScenarioDestroyAcceptedResponse {
  accepted: true;
  runId: string;
  acceptedAt: number;
  activeSlotReleased: true;
  run: ScenarioRunWireRecord;
}

export interface ScenarioStatusStep {
  id: string;
  label: string;
  detail: string;
  state: "done" | "active" | "pending" | "failed";
}

export const POLL_INTERVALS: Record<
  ScenarioRunRecord["phase"],
  number | false
> = {
  launching: 750,
  booting: 750,
  waiting_for_target: 750,
  running: 1_500,
  solved: 1_500,
  deleting: 1_000,
  archiving: 1_000,
  completed: false,
  failed: false,
};

/**
 * A failed status request must not freeze a live run. Only access and
 * not-found errors stop polling; transient network and server failures keep
 * the normal cadence after React Query's retry window.
 */
export function scenarioRunStatusRefetchInterval(
  run: Pick<ScenarioRunRecord, "activity" | "phase"> | null | undefined,
  error: unknown,
): number | false {
  if (!run || run.activity === "settled") return false;
  const interval =
    run.activity === "background" ? 1_000 : POLL_INTERVALS[run.phase];
  return pollingIntervalUnlessAccessError(error, interval);
}
