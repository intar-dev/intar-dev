// Pure helpers for the scenario run page: formatters, boot-step derivation,
// and screen copy.
import { isVerificationPassed } from "@/lib/verification-copy";
import type {
  ScenarioProbeStatus,
  ScenarioRunRecord,
  ScenarioRunVmRecord,
  ScenarioStatusStep,
} from "./run-types";

function formatScenarioElapsedTime(totalSeconds: number) {
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

export function hasPendingInfrastructureTeardown(
  vms: ReadonlyArray<Pick<ScenarioRunVmRecord, "phase">>,
) {
  return vms.some((vm) => vm.phase !== "completed");
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

/**
 * The startup stages while the run is still being created, on the start
 * route. They are the run page's boot stages with the first one working, so
 * the sequence carries on when the run page takes over instead of starting
 * again.
 */
export function buildScenarioStartSteps(start: {
  failed: boolean;
  detail: string;
}): ScenarioStatusStep[] {
  return [
    {
      id: "accepted",
      label: "Creating your run",
      detail: start.detail,
      state: start.failed ? "failed" : "active",
    },
    {
      id: "starting-vm",
      label: "Starting your workspace",
      detail: "Preparing a clean place for you to work.",
      state: "pending",
    },
    {
      id: "checking-workspace",
      label: "Checking the workspace",
      detail: "Checking services and shell prerequisites.",
      state: "pending",
    },
    {
      id: "opening-shell",
      label: "Opening the shell",
      detail: "Waiting for startup checks to finish.",
      state: "pending",
    },
  ];
}

export function buildScenarioBootSteps(
  attempt: ScenarioRunRecord | null,
  selectedVm?: ScenarioRunVmRecord | null,
): ScenarioStatusStep[] {
  if (!attempt) {
    return [];
  }

  const vm = selectedVm ?? attempt.vms[0] ?? null;
  const shellReady = Boolean(vm && hasUsableTerminalTarget(vm));
  const vmFailed = vm?.phase === "failed";
  const vmStarting = !vm || vm.phase === "launching" || vm.phase === "booting";
  const bootChecksComplete = Boolean(
    vm &&
    (vm.bootProbes.length > 0
      ? vm.bootProbes.every((probe) => isVerificationPassed(probe.status))
      : vm.canOpenTerminal),
  );
  const workspaceCheckStarted = Boolean(
    vm && vm.phase !== "launching" && vm.phase !== "booting",
  );

  return [
    {
      id: "accepted",
      label: "Creating your run",
      detail: "The run is registered and its work order is available.",
      state: "done",
    },
    {
      id: "starting-vm",
      label: "Starting your workspace",
      detail: vmStarting
        ? "Preparing a clean place for you to work."
        : "Your workspace has started.",
      state: vmFailed ? "failed" : vmStarting ? "active" : "done",
    },
    {
      id: "checking-workspace",
      label: "Checking the workspace",
      detail: bootChecksComplete
        ? "Startup checks are passing."
        : vmFailed
          ? "The workspace did not pass its startup checks."
          : "Checking services and shell prerequisites.",
      state: vmFailed
        ? "failed"
        : bootChecksComplete || shellReady
          ? "done"
          : workspaceCheckStarted
            ? "active"
            : "pending",
    },
    {
      id: "opening-shell",
      label: "Opening the shell",
      detail: shellReady
        ? "Shell access is ready."
        : vmFailed
          ? "Shell access could not be opened."
          : bootChecksComplete || vm?.canOpenTerminal
            ? "Connecting the browser terminal."
            : "Waiting for startup checks to finish.",
      state: shellReady
        ? "done"
        : vmFailed
          ? "failed"
          : bootChecksComplete || vm?.canOpenTerminal
            ? "active"
            : "pending",
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
      return "Up next";
  }
}

export function getScenarioBootScreenCopy(attempt: ScenarioRunRecord | null) {
  void attempt;
  return {
    title: "Preparing your workspace",
    description: "Review the work order while your workspace starts.",
  };
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
