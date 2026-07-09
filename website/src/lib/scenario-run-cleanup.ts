import type { RunVmStateDocument } from "@/lib/run-state";

type CleanupVm = Pick<RunVmStateDocument, "id" | "phase">;

export type ScenarioRunPurgeBlockReason =
  | "vm_teardown_pending"
  | "artifact_upload_pending";

export function runVmsRequiringDesiredAbsence<T extends CleanupVm>(state: {
  vms: readonly T[];
}): T[] {
  return state.vms.filter((vm) => vm.phase !== "completed");
}

export function scenarioRunPurgeBlockReason(
  state: { vms: readonly CleanupVm[] },
  artifacts: readonly { uploadStatus: string }[],
): ScenarioRunPurgeBlockReason | null {
  if (
    state.vms.length === 0 ||
    state.vms.some((vm) => vm.phase !== "completed")
  ) {
    return "vm_teardown_pending";
  }
  if (artifacts.some((artifact) => artifact.uploadStatus !== "uploaded")) {
    return "artifact_upload_pending";
  }
  return null;
}
