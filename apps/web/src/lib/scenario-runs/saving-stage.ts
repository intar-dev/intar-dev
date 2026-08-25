import type { RunPhase } from "@/lib/run-state";

// This is deliberately the only archive-progress contract exposed to learner
// routes. The raw agent lifecycle and per-VM ranks stay inside the control
// plane.
export type ScenarioRunSavingStage =
  | "save_requested"
  | "closing_workspace"
  | "saving_files"
  | "preparing_replay"
  | "finalizing_recap";

export const ARCHIVE_STAGE_RANK = {
  archive_started: 1,
  raw_files_saved: 2,
  replay_prepared: 3,
  sealed: 4,
} as const;

export type AgentArchiveStage =
  | "raw_files_saved"
  | "replay_prepared"
  | "replay_skipped";

export function archiveStageRankForAgentStage(
  stage: AgentArchiveStage,
): number {
  switch (stage) {
    case "raw_files_saved":
      return ARCHIVE_STAGE_RANK.raw_files_saved;
    case "replay_prepared":
    case "replay_skipped":
      return ARCHIVE_STAGE_RANK.replay_prepared;
  }
}

/**
 * Returns the slowest VM's completed archive rank. A null means an older
 * agent has not reported detailed progress for every VM, so callers must use
 * the coarse run lifecycle instead of implying work has finished.
 */
export function lowestArchiveStageRank(
  ranks: Array<number | null> | null | undefined,
): number | null {
  const knownRanks = ranks?.filter(
    (rank): rank is number => rank !== null,
  );
  if (!ranks?.length || knownRanks?.length !== ranks.length) {
    return null;
  }
  return Math.min(...knownRanks);
}

export function deriveScenarioRunSavingStage(input: {
  phase: RunPhase;
  archiveStageRanks?: Array<number | null> | null;
}): ScenarioRunSavingStage | null {
  switch (input.phase) {
    case "teardown_requested":
      return "save_requested";
    case "tearing_down":
      return "closing_workspace";
    case "archiving": {
      const rank = lowestArchiveStageRank(input.archiveStageRanks);
      if (rank === null) return "closing_workspace";
      if (rank >= ARCHIVE_STAGE_RANK.replay_prepared) {
        return "finalizing_recap";
      }
      if (rank >= ARCHIVE_STAGE_RANK.raw_files_saved) {
        return "preparing_replay";
      }
      return "saving_files";
    }
    case "queued":
    case "provisioning":
    case "active_partial":
    case "active_full":
    case "solved":
    case "completed":
    case "failed":
      return null;
  }
}
