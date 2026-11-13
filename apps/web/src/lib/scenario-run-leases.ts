import { desiredVmName, type StoredHostDesiredState } from "@/lib/desired-state-store";

export interface OverdueRunLease {
  runId: string;
  vmNames: string[];
}

export function selectOverdueRunLeases(
  desiredState: StoredHostDesiredState,
  nowUnixMs: number,
): OverdueRunLease[] {
  const byRunId = new Map<string, Set<string>>();
  for (const vm of desiredState.vms) {
    if (
      vm.desired_phase !== "running" ||
      vm.lease_expires_at_unix_ms >= nowUnixMs
    ) {
      continue;
    }
    const names = byRunId.get(vm.run_id) ?? new Set<string>();
    names.add(desiredVmName(vm));
    byRunId.set(vm.run_id, names);
  }

  return [...byRunId.entries()]
    .map(([runId, names]) => ({
      runId,
      vmNames: [...names].sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => left.runId.localeCompare(right.runId));
}
