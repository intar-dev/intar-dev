import type {
  HostStateReportV1,
  VmActualStateV1,
  VmNetworkStateV1,
  VmPhase as BridgeVmPhase,
  VmReportV1,
} from "@/generated/bridge";
import {
  applyProbeSnapshotToVm,
  canAdvanceVmPhase,
  decorateVmState,
  recomputeRunState,
  type RunStateDocument,
  type RunVmStateDocument,
  type VmPhase,
} from "@/lib/run-state";

export function deriveVmPhase(input: {
  vm: RunVmStateDocument;
  reportPhase?: BridgeVmPhase | null | undefined;
  collectionError?: string | null | undefined;
}): {
  phase: VmPhase;
  phaseDetail: string;
} {
  const vm = input.vm;
  const bootGateSatisfied = bootProbesPassing(vm);
  const scenarioPassing = vm.scenarioProbes.length
    ? vm.scenarioProbes.every((probe) => isPassingProbe(probe.status))
    : false;

  let phase = vm.phase;
  let detail = vm.phaseDetail;
  const reportPhase = input.reportPhase
    ? bridgeVmPhaseToRunVmPhase(input.reportPhase)
    : null;

  if (reportPhase && canAdvanceVmPhase(phase, reportPhase)) {
    phase = reportPhase;
    detail = describeReportPhase(input.reportPhase as BridgeVmPhase, vm);
  }

  if (input.collectionError && canAdvanceVmPhase(phase, "booting")) {
    phase = "booting";
    detail = input.collectionError;
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

  return { phase, phaseDetail: detail };
}

export function applyVmReportToRunState(input: {
  runId: string;
  current: RunStateDocument;
  report: VmReportV1;
}): RunStateDocument {
  const next = {
    ...input.current,
    vms: input.current.vms.map((vm) =>
      applyReportedVmState({
        runId: input.runId,
        vm,
        report: {
          run_id: input.report.run_id,
          vm_name: input.report.vm_name,
          phase: input.report.phase,
          network: input.report.network ?? null,
          ssh_host_keys_openssh: input.report.ssh_host_keys_openssh,
          probes: input.report.probes,
          error: input.report.error ?? null,
          updated_at_unix_ms: input.report.observed_at_unix_ms,
        },
      }),
    ),
  };
  return recomputeRunState(next);
}

export function applyHostReportToRunState(input: {
  runId: string;
  current: RunStateDocument;
  report: HostStateReportV1;
}): RunStateDocument {
  let next = input.current;
  for (const report of input.report.vms) {
    next = {
      ...next,
      vms: next.vms.map((vm) =>
        applyReportedVmState({ runId: input.runId, vm, report }),
      ),
    };
  }
  return recomputeRunState(next);
}

export function matchesVmReportIdentity(input: {
  runId: string;
  runtimeVmName: string;
  reportRunId: string;
  reportVmName: string;
}): boolean {
  return (
    input.runId === input.reportRunId &&
    input.runtimeVmName === input.reportVmName
  );
}

export function matchesInventoryVmIdentity(input: {
  value: unknown;
  runId: string;
  runtimeVmName: string;
}): boolean {
  if (!isRecord(input.value)) {
    return false;
  }

  const reportRunId = readString(input.value.run_id);
  const reportVmName = readString(input.value.vm_name);
  if (!reportRunId || !reportVmName) {
    return false;
  }

  return matchesVmReportIdentity({
    runId: input.runId,
    runtimeVmName: input.runtimeVmName,
    reportRunId,
    reportVmName,
  });
}

function applyReportedVmState(input: {
  runId: string;
  vm: RunVmStateDocument;
  report: Pick<
    VmActualStateV1,
    | "run_id"
    | "vm_name"
    | "phase"
    | "network"
    | "ssh_host_keys_openssh"
    | "probes"
    | "error"
    | "updated_at_unix_ms"
  >;
}): RunVmStateDocument {
  if (
    !matchesVmReportIdentity({
      runId: input.runId,
      runtimeVmName: input.vm.runtimeVmName,
      reportRunId: input.report.run_id,
      reportVmName: input.report.vm_name,
    })
  ) {
    return input.vm;
  }

  const withProbes = applyProbeSnapshotToVm(input.vm, {
    probes: input.report.probes.map((probe) => ({
      id: probe.id,
      status: probe.status,
      error: probe.message ?? null,
      value: probe.value,
    })),
  });
  const derived = deriveVmPhase({
    vm: withProbes,
    reportPhase: input.report.phase,
    collectionError: input.report.error ?? null,
  });
  const terminalTarget = terminalTargetFromNetwork(
    input.report.network,
    input.report.ssh_host_keys_openssh,
    withProbes.terminalTarget,
    withProbes.hostname,
    input.report.updated_at_unix_ms,
  );
  const terminalReady = hasTerminalEndpoint(terminalTarget);

  return decorateVmState({
    ...withProbes,
    phase: derived.phase,
    phaseDetail: derived.phaseDetail,
    terminalPhase: terminalReady ? "ready" : withProbes.terminalPhase,
    terminalReason: terminalReady ? null : withProbes.terminalReason,
    terminalObservedAt: terminalReady
      ? input.report.updated_at_unix_ms
      : withProbes.terminalObservedAt,
    terminalTarget,
    runtimeState: input.report.phase,
    vmCreatedAt:
      withProbes.vmCreatedAt ??
      (derived.phase === "queued" ? null : input.report.updated_at_unix_ms),
  });
}

function bridgeVmPhaseToRunVmPhase(phase: BridgeVmPhase): VmPhase {
  switch (phase) {
    case "pending":
      return "queued";
    case "pulling_image":
    case "creating_disks":
      return "launching";
    case "booting":
    case "running":
      return "booting";
    case "ready":
      return "ready";
    case "solved":
      return "solved";
    case "stopping":
      return "destroying";
    case "stopped":
      return "archived";
    case "absent":
      return "completed";
    case "failed":
      return "failed";
  }
}

function describeReportPhase(
  phase: BridgeVmPhase,
  vm: RunVmStateDocument,
): string {
  switch (phase) {
    case "pending":
      return vm.phaseDetail || "Waiting for host reconciliation.";
    case "pulling_image":
      return "Host is preparing the scenario image.";
    case "creating_disks":
      return "Host is creating VM disks.";
    case "booting":
    case "running":
      return "Host reports the VM is running and boot probes are pending.";
    case "ready":
      return "Host reports the VM is ready.";
    case "solved":
      return "Host reports all scenario probes are passing.";
    case "stopping":
      return "Host is stopping the VM.";
    case "stopped":
      return "VM stopped. Waiting for final archival.";
    case "absent":
      return "Host confirms the VM is absent.";
    case "failed":
      return "Host reports the VM failed.";
  }
}

function bootProbesPassing(vm: RunVmStateDocument): boolean {
  return (
    vm.bootProbes.length === 0 ||
    vm.bootProbes.every((probe) => isPassingProbe(probe.status))
  );
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

function terminalTargetFromNetwork(
  network: VmNetworkStateV1 | null | undefined,
  sshHostKeysOpenssh: string[] | null | undefined,
  current: RunVmStateDocument["terminalTarget"],
  hostname: string,
  observedAt: number,
): RunVmStateDocument["terminalTarget"] {
  const host = network?.guest_ip?.trim() || current.host;
  const port = network?.ssh_host_port ?? current.port;
  const hostKeyOpenssh =
    sshHostKeysOpenssh?.find((key) => key.trim().length > 0)?.trim() ??
    current.hostKeyOpenssh;
  if (!host || !port) {
    return hostKeyOpenssh === current.hostKeyOpenssh
      ? current
      : { ...current, hostKeyOpenssh };
  }
  return {
    host,
    port,
    username: hostname.trim() || current.username,
    hostKeyOpenssh,
    checkedAt: observedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
