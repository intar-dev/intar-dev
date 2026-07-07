// Pure helpers for the scenario run page: formatters, boot/shutdown step
// derivation, screen copy, and probe-value summaries.

import { summarizeProbeValue } from "@/lib/probe-values";
import type {
  ScenarioProbeStatus,
  ScenarioRunRecord,
  ScenarioRunVmRecord,
  ScenarioStatusStep,
} from "./run-types";

export function formatScenarioReplayName(index: number, total: number) {
  if (total <= 1) {
    return "Terminal replay";
  }
  if (index === total - 1) {
    return "Latest replay";
  }
  return `Replay ${index + 1}`;
}

export function formatScenarioElapsedTime(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return [hours, minutes, seconds]
      .map((value) => String(value).padStart(2, "0"))
      .join(":");
  }

  return [minutes, seconds]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

export function formatScenarioDurationMs(durationMs: number) {
  return formatScenarioElapsedTime(Math.max(0, Math.floor(durationMs / 1_000)));
}

export function scenarioRunOutcomeMeta(outcome: ScenarioRunRecord["outcome"]) {
  switch (outcome) {
    case "succeeded":
      return {
        variant: "secondary" as const,
        label: "Succeeded",
      };
    case "cancelled":
      return {
        variant: "outline" as const,
        label: "Cancelled",
      };
    case "failed":
      return {
        variant: "destructive" as const,
        label: "Failed",
      };
    case "in_progress":
      return {
        variant: "outline" as const,
        label: "In progress",
      };
  }
}

export function buildScenarioBootSteps(
  attempt: ScenarioRunRecord | null,
): ScenarioStatusStep[] {
  if (!attempt) {
    return [];
  }

  const hasAnyReportedProbes = hasReportedProbeResults([
    ...attempt.bootProbes,
    ...attempt.scenarioProbes,
  ]);
  const bootChecksComplete = attempt.bootProbes.length
    ? attempt.bootProbes.every((probe) => probe.status === "pass")
    : attempt.canOpenTerminal;

  const steps: ScenarioStatusStep[] = [
    {
      id: "queue",
      label: "Start your scenario",
      detail:
        attempt.phase === "launching"
          ? "Lining up everything your run needs."
          : "Your scenario is underway.",
      state: attempt.phase === "launching" ? "active" : "done",
    },
    {
      id: "environment",
      label: "Prepare your workspace",
      detail:
        bootChecksComplete || attempt.canOpenTerminal
          ? "Your workspace is ready."
          : attempt.phase === "failed"
            ? "We could not finish setting things up."
            : "Setting up a fresh place for you to work.",
      state:
        attempt.phase === "failed" &&
        !bootChecksComplete &&
        !attempt.canOpenTerminal
          ? "failed"
          : bootChecksComplete || attempt.canOpenTerminal
            ? "done"
            : attempt.phase === "launching"
              ? "pending"
              : "active",
    },
  ];

  steps.push({
    id: "startup-checks",
    label: "Finish the last checks",
    detail:
      bootChecksComplete
        ? "Everything looks good so far."
        : attempt.canOpenTerminal && !hasAnyReportedProbes
          ? "Almost there. We are waiting for the first results to come in."
          : attempt.phase === "failed"
            ? "We could not confirm that everything was ready."
            : "Running the last setup checks before opening the terminal.",
    state:
      bootChecksComplete
        ? "done"
        : attempt.phase === "failed"
          ? "failed"
          : attempt.phase === "launching"
            ? "pending"
            : "active",
  });

  steps.push({
    id: "shell-access",
    label: "Open your terminal",
    detail:
      attempt.canOpenTerminal && hasAnyReportedProbes
        ? "Your terminal is ready."
        : attempt.canOpenTerminal
          ? "We are waiting for the last check to come through."
          : bootChecksComplete
            ? "Connecting the last part of your workspace."
            : "Waiting for the earlier steps to finish.",
    state:
      attempt.canOpenTerminal && hasAnyReportedProbes
        ? "done"
        : attempt.phase === "failed"
          ? "failed"
          : bootChecksComplete && !hasAnyReportedProbes
            ? "pending"
            : bootChecksComplete
              ? "active"
              : "pending",
  });

  return steps;
}

export function buildScenarioShutdownSteps(
  attempt: ScenarioRunRecord | null,
  shutdownRequested: boolean,
): ScenarioStatusStep[] {
  if (!attempt) {
    return [];
  }

  const phase =
    attempt.phase === "completed"
      ? "done"
      : attempt.phase === "failed"
        ? "failed"
        : attempt.phase === "archiving"
          ? "uploading"
          : attempt.phase === "deleting" || shutdownRequested
            ? "destroying"
            : "destroying";

  return [
    {
      id: "destroying",
      label: "Destroying",
      detail:
        phase === "destroying"
          ? "Removing the VM before the run is archived."
          : phase === "failed"
            ? "The shutdown did not finish cleanly."
          : "The VM has been removed.",
      state:
        phase === "destroying"
          ? "active"
          : phase === "failed"
            ? "failed"
            : "done",
    },
    {
      id: "uploading",
      label: "Uploading",
      detail:
        phase === "uploading"
          ? "Saving recordings and logs from this run."
          : phase === "failed"
            ? "Recordings or logs did not finish uploading."
          : "Uploads start once the VM is fully removed.",
      state:
        phase === "uploading"
          ? "active"
          : phase === "destroying"
            ? "pending"
            : phase === "failed"
              ? "failed"
              : "done",
    },
  ];
}

export function formatScenarioStepState(state: ScenarioStatusStep["state"]) {
  switch (state) {
    case "done":
      return "Done";
    case "active":
      return "In progress";
    case "failed":
      return "Failed";
    default:
      return "Pending";
  }
}

export function getScenarioBootScreenCopy(attempt: ScenarioRunRecord | null) {
  if (!attempt) {
    return {
      title: "Queued",
      description: "Hang tight while we get everything ready for you.",
    };
  }

  if (attempt.canOpenTerminal && !hasReportedProbeResults([...attempt.bootProbes, ...attempt.scenarioProbes])) {
    return {
      title: "Almost ready",
      description:
        "Your workspace is up. We are finishing the last checks before opening the terminal.",
    };
  }

  switch (attempt.phase) {
    case "launching":
      return {
        title: "Queued",
        description: "Waiting for the selected host to accept the launch.",
      };
    case "booting":
      return {
        title: "Preparing workspace",
        description: "Running the last setup checks before opening the terminal.",
      };
    case "waiting_for_target":
      return {
        title: "Waiting for shell",
        description:
          "Your workspace is ready. Waiting for shell access to become ready.",
      };
    default:
      return {
        title: "Getting your scenario ready",
        description:
          "We are preparing your workspace and checking that everything is ready.",
      };
  }
}

export function getScenarioShutdownScreenCopy(
  attempt: ScenarioRunRecord | null,
  shutdownRequested: boolean,
) {
  if (!attempt) {
    return {
      title: "Destroying",
      description: "We are closing your run and cleaning up the workspace.",
    };
  }

  if (attempt.phase === "archiving") {
    return {
      title: "Uploading",
      description: "Saving recordings and logs from this run.",
    };
  }

  return {
    title: "Destroying",
    description:
      shutdownRequested || attempt.phase === "deleting"
        ? "Removing the VM before the run is archived."
        : "We are closing your run and cleaning up the workspace.",
  };
}

export function describeProbeValue(probe: ScenarioProbeStatus) {
  if (probe.value === null || probe.value === undefined) {
    return probe.status === "pass"
      ? "Passing"
      : "Waiting for a passing signal.";
  }

  const summary = summarizeProbeValue(probe.kind, probe.value);
  if (summary) return summary;

  if (typeof probe.value === "string") {
    return probe.value;
  }

  if (typeof probe.value === "number" || typeof probe.value === "boolean") {
    return String(probe.value);
  }

  if (typeof probe.value === "object") {
    const record = probe.value as Record<string, unknown>;
    if (typeof record.state === "string") return `State: ${record.state}`;
    if (
      typeof record.service === "string" &&
      typeof record.expectedState === "string"
    ) {
      return `${record.service} should be ${record.expectedState}`;
    }
    if (typeof record.path === "string") return record.path;
    if (typeof record.host === "string" && typeof record.port === "number") {
      return `${record.host}:${record.port}`;
    }
  }

  return probe.status === "pass" ? "Passing" : "Waiting for a passing signal.";
}

export function hasReportedProbeResults(probes: ScenarioProbeStatus[]) {
  return probes.some(
    (probe) =>
      probe.status !== "pending" ||
      probe.error !== null ||
      probe.value !== null,
  );
}

export function hasUsableTerminalTarget(vm: ScenarioRunVmRecord) {
  return Boolean(
    vm.canOpenTerminal && vm.terminalTarget.host && vm.terminalTarget.port > 0,
  );
}

