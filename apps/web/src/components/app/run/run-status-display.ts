import type { StatusTone } from "@/components/app/patterns/StatusToken";

export interface ActiveRunStatusPlan {
  tone: StatusTone;
  word: string;
  /** Only the run's one live or becoming state breathes. */
  pulse: boolean;
  /** The clock stops at the solve time once the run is solved. */
  frozen: boolean;
}

/**
 * Every word planActiveRunStatus can pick. The status token stacks them in
 * one box sized for the longest, so a change swaps in place and the clock
 * beside it never moves.
 */
export const ACTIVE_RUN_STATUS_WORDS = [
  "Starting",
  "In progress",
  "Solved",
  "Finishing",
  "Ending",
] as const;

/**
 * The word and its tone come from one place, so they always describe the same
 * state: "In progress" is the live primary state, becoming states (starting,
 * finishing, ending) are pending, and a failure does not breathe. Returns null
 * once the run has settled; the settled tokens carry their own words.
 */
export function planActiveRunStatus(input: {
  activity: "foreground" | "background" | "settled";
  outcome: "in_progress" | "succeeded" | "cancelled" | "failed";
  phase: string;
  phaseTitle: string;
  /** The selected machine is still launching, booting or waiting. */
  preparing: boolean;
  /** The selected machine's own phase word, while it prepares. */
  vmPhaseTitle?: string | null;
}): ActiveRunStatusPlan | null {
  if (input.activity === "background") {
    return { tone: "pending", word: "Finishing", pulse: true, frozen: false };
  }
  if (input.outcome !== "in_progress") return null;
  if (input.preparing) {
    return {
      tone: "pending",
      word: input.vmPhaseTitle ?? "Starting",
      pulse: true,
      frozen: false,
    };
  }
  if (input.phase === "solved") {
    return { tone: "success", word: "Solved", pulse: false, frozen: true };
  }
  if (input.phase === "deleting") {
    return { tone: "pending", word: "Ending", pulse: true, frozen: false };
  }
  if (input.phase === "failed") {
    return { tone: "danger", word: input.phaseTitle, pulse: false, frozen: false };
  }
  return { tone: "live", word: "In progress", pulse: true, frozen: false };
}
