import {
  canAdvanceVmPhase,
  decorateVmState,
  type RunVmStateDocument,
} from "@/lib/run-state";

export function applyProbePhaseHeuristics(
  vm: RunVmStateDocument,
  collectionError?: string | null,
): RunVmStateDocument {
  const bootGateSatisfied = bootProbesPassing(vm);
  const scenarioPassing = vm.scenarioProbes.length
    ? vm.scenarioProbes.every((probe) => isPassingProbe(probe.status))
    : false;

  let phase = vm.phase;
  let detail = vm.phaseDetail;

  if (collectionError && canAdvanceVmPhase(phase, "booting")) {
    phase = "booting";
    detail = collectionError;
  }

  if (scenarioPassing && canAdvanceVmPhase(phase, "solved")) {
    phase = "solved";
    detail = "All scenario probes are passing.";
  } else if (bootGateSatisfied && canAdvanceVmPhase(phase, "ready")) {
    phase = "ready";
    detail = hasTerminalEndpoint(vm.terminalTarget)
      ? "Boot probes passed. Shell target is ready."
      : "Boot probes passed. Waiting for shell target.";
  } else if (canAdvanceVmPhase(phase, "booting")) {
    phase = phase === "queued" || phase === "launching" ? "booting" : phase;
  }

  return decorateVmState({
    ...vm,
    phase,
    phaseDetail: detail,
  });
}

export function bootProbesPassing(vm: RunVmStateDocument): boolean {
  return (
    vm.bootProbes.length === 0 ||
    vm.bootProbes.every((probe) => isPassingProbe(probe.status))
  );
}

export function shouldQueueTerminalStateGet(
  vm: RunVmStateDocument,
  requireBootPassing: boolean,
): boolean {
  if (vm.terminalPhase === "ready") {
    return false;
  }
  if (
    vm.phase === "destroying" ||
    vm.phase === "archived" ||
    vm.phase === "completed" ||
    vm.phase === "failed"
  ) {
    return false;
  }
  if (requireBootPassing) {
    return bootProbesPassing(vm);
  }
  return vm.terminalPhase === "pending";
}

function isPassingProbe(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return (
    normalized === "pass" ||
    normalized === "passed" ||
    normalized === "ready" ||
    normalized === "ok" ||
    normalized === "succeeded"
  );
}

function hasTerminalEndpoint(target: RunVmStateDocument["terminalTarget"]): boolean {
  return Boolean(target.host && target.port > 0);
}
