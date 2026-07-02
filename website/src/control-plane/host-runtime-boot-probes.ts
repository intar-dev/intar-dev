import { decorateVmState, type RunVmStateDocument } from "@/lib/run-state";
import { deriveVmPhase } from "@/lib/run-lifecycle";

export function applyProbePhaseHeuristics(
  vm: RunVmStateDocument,
  collectionError?: string | null,
): RunVmStateDocument {
  const { phase, phaseDetail } = deriveVmPhase({ vm, collectionError });
  return decorateVmState({
    ...vm,
    phase,
    phaseDetail,
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
