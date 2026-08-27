import {
  isVerificationPassed,
  repairObjectiveTitle,
} from "@/lib/verification-copy";
import type {
  ScenarioObjective,
  ScenarioRunRecord,
  ScenarioRunVmRecord,
} from "./run-types";

export type RunRecapState =
  | {
      kind: "saving";
      title: "Saving your run…";
      description: string;
    }
  | {
      kind: "solved";
      title: "Solved";
      description: string;
    }
  | {
      kind: "ended_early";
      title: "Ended early";
      description: string;
    }
  | {
      kind: "could_not_finish";
      title: "Could not finish";
      description: string;
    };

export interface RunRecapObjective {
  key: string;
  title: string;
  status: "verified" | "needs_repair";
}

export interface RunReplayPart {
  key: string;
  /** Only authored machine copy. It is omitted for a one-machine replay. */
  machineLabel: string | null;
  partLabel: string;
  castArtifactId: string | null;
  /** Used only to keep oversized casts out of browser memory. */
  sizeBytes?: number;
}

export type RunReplayAvailability =
  | "ready"
  | "pending"
  | "unavailable"
  | "none";

/**
 * Learner-facing terminal state. This purposefully ignores phase/detail copy:
 * those strings describe infrastructure, not the learner's work.
 */
export function getRunRecapState(run: ScenarioRunRecord): RunRecapState {
  if (run.activity !== "settled") {
    return {
      kind: "saving",
      title: "Saving your run…",
      description: "Your recap will be ready in a moment.",
    };
  }

  if (run.outcome === "succeeded" || run.solvedAt !== null) {
    return {
      kind: "solved",
      title: "Solved",
      description: "You completed this lab.",
    };
  }

  if (run.outcome === "failed" || run.phase === "failed") {
    return {
      kind: "could_not_finish",
      title: "Could not finish",
      description: "This lab did not reach its final checks.",
    };
  }

  return {
    kind: "ended_early",
    title: "Ended early",
    description: "You can try this lab again when you are ready.",
  };
}

/**
 * Keep final checks tied to authored objectives. Stored probe labels, kinds,
 * values, errors, and unmatched probes never cross this boundary.
 */
export function getRunRecapObjectives(
  run: ScenarioRunRecord,
): RunRecapObjective[] {
  return run.objectives.map((objective, index) => {
    const probe = findObjectiveProbe(run, objective);
    return {
      key: `objective-${index + 1}`,
      title: repairObjectiveTitle(objective, index),
      status: isVerificationPassed(probe?.status)
        ? "verified"
        : "needs_repair",
    };
  });
}

/**
 * Replay parts are deliberately presentation-only. Machine ordinal and
 * session index define the learner-visible order before contiguous Part labels
 * are assigned. Filenames, timestamps, VM ids, runtime names, and terminal
 * exit details never cross this boundary.
 */
export function getRunReplayParts(run: ScenarioRunRecord): RunReplayPart[] {
  const replaySizeByArtifactId = new Map(
    [...run.replayArtifacts, ...run.vms.flatMap((vm) => vm.replayArtifacts)].map(
      (artifact) => [artifact.id, artifact.sizeBytes] as const,
    ),
  );
  const hasMultipleMachines = run.vms.length > 1;
  const orderedVms = run.vms
    .map((vm, sourceIndex) => ({ vm, sourceIndex }))
    .sort(
      (left, right) =>
        left.vm.ordinal - right.vm.ordinal ||
        left.vm.scenarioVmId.localeCompare(right.vm.scenarioVmId) ||
        left.vm.id.localeCompare(right.vm.id) ||
        left.sourceIndex - right.sourceIndex,
    );

  const orderedSessions = orderedVms.flatMap(
    ({ vm }, vmIndex) =>
      (vm.sessionTimeline ?? [])
        .map((session, sourceSessionIndex) => ({
          vm,
          vmIndex,
          session,
          sourceSessionIndex,
        }))
        .sort(
          (left, right) =>
            left.session.index - right.session.index ||
            left.session.startTimestampMs - right.session.startTimestampMs ||
            (left.session.castArtifactId ?? "").localeCompare(
              right.session.castArtifactId ?? "",
            ) ||
            left.sourceSessionIndex - right.sourceSessionIndex,
        ),
  );

  return orderedSessions
    .filter((entry) => entry.session.castArtifactId)
    .map((entry, index) => {
      const castArtifactId = entry.session.castArtifactId;
      const sizeBytes = castArtifactId
        ? replaySizeByArtifactId.get(castArtifactId)
        : undefined;
      return {
        key: `replay-${castArtifactId}`,
        machineLabel: hasMultipleMachines
          ? authoredMachineLabel(entry.vm, entry.vmIndex)
          : null,
        partLabel: `Part ${index + 1}`,
        castArtifactId,
        ...(sizeBytes === undefined ? {} : { sizeBytes }),
      };
    });
}

export function getRunReplayAvailability(
  run: ScenarioRunRecord,
  parts: readonly RunReplayPart[] = getRunReplayParts(run),
): RunReplayAvailability {
  switch (run.replayState) {
    case "preparing":
      return "pending";
    case "failed":
      return "unavailable";
    case "ready":
      return parts.some((part) => part.castArtifactId) ? "ready" : "unavailable";
    case "none":
    case "not_started":
      return "none";
  }
}

function findObjectiveProbe(
  run: ScenarioRunRecord,
  objective: ScenarioObjective,
) {
  const matchingVms = run.vms.filter(
    (vm) =>
      vm.scenarioVmName === objective.vmName ||
      vm.scenarioVmId === objective.vmName,
  );
  const candidates =
    matchingVms.length > 0
      ? matchingVms
      : run.vms.length === 1
        ? run.vms
        : [];

  return candidates
    .flatMap((vm) => vm.scenarioProbes)
    .find((probe) => probe.id === objective.probeName);
}

function authoredMachineLabel(vm: ScenarioRunVmRecord, index: number) {
  return vm.scenarioVmName.trim() || `Machine ${index + 1}`;
}
