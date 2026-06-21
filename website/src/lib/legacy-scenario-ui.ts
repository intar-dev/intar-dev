import type { ScenarioDetail, ScenarioRunRecord } from "@/lib/scenario-runs";

export type LegacyScenarioRunPhase =
  | "launching"
  | "booting"
  | "waiting_for_target"
  | "running"
  | "solved"
  | "deleting"
  | "archiving"
  | "completed"
  | "failed";

export type LegacyScenarioVmPhase =
  | "launching"
  | "booting"
  | "waiting_for_target"
  | "running"
  | "solved"
  | "deleting"
  | "archiving"
  | "completed"
  | "failed";

export function toLegacyScenarioDetail(detail: ScenarioDetail) {
  return {
    ...detail,
    activeRun: detail.activeRun
      ? (() => {
          const phase = mapRunPhaseToLegacy(detail.activeRun);
          return {
            ...detail.activeRun,
            phase:
              phase === "completed" || phase === "failed" ? "running" : phase,
            phaseTitle: legacyRunPhaseTitle(phase),
          };
        })()
      : null,
  };
}

export function toLegacyScenarioRunRecord(run: ScenarioRunRecord) {
  const phase = mapRunPhaseToLegacy(run);
  return {
    ...run,
    phase,
    phaseTitle: legacyRunPhaseTitle(phase),
    vms: run.vms.map((vm) => {
      const vmPhase = mapVmPhaseToLegacy(vm);
      return {
        ...vm,
        phase: vmPhase,
        phaseTitle: legacyVmPhaseTitle(vmPhase),
      };
    }),
  };
}

function mapRunPhaseToLegacy(run: {
  phase:
    | ScenarioRunRecord["phase"]
    | NonNullable<ScenarioDetail["activeRun"]>["phase"];
  canOpenTerminal?: boolean;
  terminalPhase?: ScenarioRunRecord["terminalPhase"];
}): LegacyScenarioRunPhase {
  switch (run.phase) {
    case "queued":
      return "launching";
    case "provisioning":
      return "booting";
    case "active_partial":
      return hasReadyTerminal(run) ? "running" : "waiting_for_target";
    case "active_full":
      return hasReadyTerminal(run) ? "running" : "waiting_for_target";
    case "teardown_requested":
    case "tearing_down":
      return "deleting";
    case "solved":
    case "archiving":
    case "completed":
    case "failed":
      return run.phase;
  }
}

function mapVmPhaseToLegacy(
  vm: ScenarioRunRecord["vms"][number],
): LegacyScenarioVmPhase {
  switch (vm.phase) {
    case "queued":
    case "launching":
      return "launching";
    case "booting":
      return "booting";
    case "ready":
      return hasVmReadyTerminal(vm) ? "running" : "waiting_for_target";
    case "destroying":
      return "deleting";
    case "archived":
      return "archiving";
    case "solved":
    case "completed":
    case "failed":
      return vm.phase;
  }
}

function hasReadyTerminal(run: {
  canOpenTerminal?: boolean;
  terminalPhase?: ScenarioRunRecord["terminalPhase"];
}) {
  return run.canOpenTerminal === true || run.terminalPhase === "ready";
}

function hasVmReadyTerminal(vm: ScenarioRunRecord["vms"][number]) {
  return (
    (vm.canOpenTerminal === true || vm.terminalPhase === "ready") &&
    Boolean(vm.terminalTarget.host && vm.terminalTarget.port > 0)
  );
}

function legacyRunPhaseTitle(phase: LegacyScenarioRunPhase): string {
  switch (phase) {
    case "launching":
      return "Queued";
    case "booting":
      return "Booting";
    case "waiting_for_target":
      return "Waiting for target";
    case "running":
      return "Running";
    case "solved":
      return "Solved";
    case "deleting":
      return "Destroying";
    case "archiving":
      return "Archiving";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
  }
}

function legacyVmPhaseTitle(phase: LegacyScenarioVmPhase): string {
  switch (phase) {
    case "launching":
      return "Launching";
    case "booting":
      return "Booting";
    case "waiting_for_target":
      return "Waiting for target";
    case "running":
      return "Running";
    case "solved":
      return "Solved";
    case "deleting":
      return "Destroying";
    case "archiving":
      return "Archiving";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
  }
}
