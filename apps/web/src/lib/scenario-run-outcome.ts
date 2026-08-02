import { RUN_PHASE_ORDER, type RunPhase } from "@/lib/run-state";

export type ScenarioRunOutcome =
  | "in_progress"
  | "succeeded"
  | "cancelled"
  | "failed";

export function deriveScenarioRunOutcome(input: {
  phase: RunPhase;
  solvedAt: number | null;
  deleteRequestedAt: number | null;
  failedAt: number | null;
}): ScenarioRunOutcome {
  if (input.phase === "failed" || input.failedAt !== null) {
    return "failed";
  }
  if (input.solvedAt !== null) {
    return "succeeded";
  }
  if (
    input.deleteRequestedAt !== null ||
    RUN_PHASE_ORDER[input.phase] >= RUN_PHASE_ORDER.teardown_requested
  ) {
    return "cancelled";
  }
  return "in_progress";
}

export function deriveScenarioRunSolveDurationMs(input: {
  createdAt: number;
  solvedAt: number | null;
}): number | null {
  if (input.solvedAt === null) {
    return null;
  }
  return Math.max(0, input.solvedAt - input.createdAt);
}

export function nextSolvedAt(input: {
  currentPhase: RunPhase;
  nextPhase: RunPhase;
  existingSolvedAt: number | null;
  now: number;
}): number | null {
  if (input.existingSolvedAt !== null) {
    return input.existingSolvedAt;
  }
  if (input.currentPhase === "solved" || input.nextPhase === "solved") {
    return input.now;
  }
  return null;
}
