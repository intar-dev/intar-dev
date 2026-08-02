// Pure status derivation for the instructor progress grid (testable without
// the worker runtime). "assisted" means every solve used the revealed solution.

export type ProgressStatus =
  | "not_started"
  | "in_progress"
  | "solved"
  | "assisted";

export interface RunFacts {
  runId: string;
  active: boolean;
  solvedAt: number | null;
  solutionAssisted: boolean;
  solveDurationMs: number | null;
  createdAt: number;
}

export function cellStatus(runs: RunFacts[]): ProgressStatus {
  if (!runs.length) return "not_started";
  const solved = runs.filter((run) => run.solvedAt !== null);
  if (solved.length) {
    // A single clean solve counts as solved even if another run used the solution.
    return solved.some((run) => !run.solutionAssisted) ? "solved" : "assisted";
  }
  return runs.some((run) => run.active) ? "in_progress" : "not_started";
}

export function bestSolveDuration(runs: RunFacts[]): number | null {
  const durations = runs
    .filter((run) => run.solvedAt !== null && run.solveDurationMs !== null)
    .map((run) => run.solveDurationMs as number);
  return durations.length ? Math.min(...durations) : null;
}
