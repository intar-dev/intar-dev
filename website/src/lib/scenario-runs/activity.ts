import type { RunPhase, RunStateDocument } from "@/lib/run-state";

export type ScenarioRunActivity = "foreground" | "background" | "settled";

export type ScenarioRunReplayState =
  | "not_started"
  | "preparing"
  | "ready"
  | "none"
  | "failed";

const TERMINAL_RUN_PHASES = new Set<RunPhase>(["completed", "failed"]);
const REPLAY_PREPARATION_PHASES = new Set<RunPhase>([
  "teardown_requested",
  "tearing_down",
  "archiving",
]);

export function deriveScenarioRunActivity(input: {
  activeKey: string | null;
  phase: RunPhase;
}): ScenarioRunActivity {
  if (input.activeKey !== null) {
    return "foreground";
  }
  return TERMINAL_RUN_PHASES.has(input.phase) ? "settled" : "background";
}
export function deriveScenarioRunReplayState(
  state: Pick<RunStateDocument, "phase" | "vms">,
): ScenarioRunReplayState {
  if (
    state.vms.some((vm) => (vm.sessionTimeline?.length ?? 0) > 0)
  ) {
    return "ready";
  }

  if (TERMINAL_RUN_PHASES.has(state.phase)) {
    return state.vms.some((vm) => vm.hasRecording === true)
      ? "failed"
      : "none";
  }

  if (REPLAY_PREPARATION_PHASES.has(state.phase)) {
    return "preparing";
  }

  return "not_started";
}
