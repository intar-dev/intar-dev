import type {
  HostStateReportV2,
  VmActualStateV2,
  VmPhase as BridgeVmPhase,
  VmReportV2,
  VmRuntimeConstraintsV1,
  VmTerminalStateV1,
} from "@/generated/bridge";
import {
  applyProbeSnapshotToVm,
  canAdvanceVmPhase,
  decorateVmState,
  recomputeRunState,
  type RuntimeConstraintsEvidence,
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
  report: VmReportV2;
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
          terminal: input.report.terminal ?? null,
          runtime_constraints: input.report.runtime_constraints ?? null,
          boot_evidence: input.report.boot_evidence ?? null,
          resource_state: input.report.resource_state ?? null,
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
  report: HostStateReportV2;
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
    VmActualStateV2,
    | "run_id"
    | "vm_name"
    | "phase"
    | "network"
    | "terminal"
    | "runtime_constraints"
    | "boot_evidence"
    | "resource_state"
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

  if (
    typeof input.vm.runtimeObservedAt === "number" &&
    input.report.updated_at_unix_ms < input.vm.runtimeObservedAt
  ) {
    return input.vm;
  }

  const reportedGeneration =
    input.report.runtime_constraints?.generation?.trim() || null;
  const currentGeneration = input.vm.runtimeConstraints?.generation ?? null;
  if (
    (reportedGeneration &&
      input.vm.retiredRuntimeGenerations?.includes(reportedGeneration)) ||
    (!reportedGeneration && currentGeneration)
  ) {
    return input.vm;
  }
  const generationChanged = Boolean(
    reportedGeneration &&
    ((currentGeneration && currentGeneration !== reportedGeneration) ||
      (!currentGeneration &&
        input.vm.terminalPhase === "ready" &&
        input.report.runtime_constraints?.phase === "boot_burst")),
  );
  const generationBase = generationChanged
    ? resetVmForRuntimeGeneration(input.vm)
    : input.vm;
  const withProbes = applyProbeSnapshotToVm(generationBase, {
    probes: input.report.probes.map((probe) => ({
      id: probe.id,
      status: probe.status,
      error: probe.message ?? null,
      value: probe.value,
    })),
  });
  const runtimeConstraints = mergeRuntimeConstraints(
    withProbes.runtimeConstraints,
    input.report.runtime_constraints,
  );
  const bootEvidence =
    input.report.boot_evidence?.generation.trim() &&
    input.report.boot_evidence.generation === runtimeConstraints?.generation
      ? input.report.boot_evidence
      : (withProbes.bootEvidence ?? null);
  const resourceState =
    input.report.resource_state &&
    input.report.runtime_constraints?.generation ===
      runtimeConstraints?.generation
      ? input.report.resource_state
      : (withProbes.resourceState ?? null);
  const terminal = projectTerminalReadiness(
    input.report.terminal,
    runtimeConstraints,
    input.report.ssh_host_keys_openssh,
    withProbes,
    input.report.phase,
  );
  const withRuntimeEvidence: RunVmStateDocument = {
    ...withProbes,
    terminalPhase: terminal.phase,
    terminalReason: terminal.reason,
    terminalObservedAt: terminal.observedAt,
    terminalTarget: terminal.target,
    runtimeConstraints,
    bootEvidence,
    resourceState,
  };
  const derived = deriveVmPhase({
    vm: withRuntimeEvidence,
    reportPhase: input.report.phase,
    collectionError: input.report.error ?? null,
  });

  return decorateVmState({
    ...withRuntimeEvidence,
    guestIp: input.report.network?.guest_ip?.trim() || withProbes.guestIp,
    phase: derived.phase,
    phaseDetail: derived.phaseDetail,
    runtimeState: input.report.phase,
    runtimeObservedAt: input.report.updated_at_unix_ms,
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

function hasTerminalEndpoint(
  target: RunVmStateDocument["terminalTarget"],
): boolean {
  return Boolean(target.host && target.port > 0);
}

function mergeRuntimeConstraints(
  current: RunVmStateDocument["runtimeConstraints"],
  reported: VmRuntimeConstraintsV1 | null | undefined,
): RuntimeConstraintsEvidence | null {
  if (!reported) {
    return current ?? null;
  }
  const generation = reported.generation.trim();
  // Quota sealing is one-way for a VM generation. A later inventory snapshot
  // must not regress already-attested steady state back to boot capacity.
  const sameGeneration =
    !current?.generation || current.generation === generation;
  if (
    sameGeneration &&
    current?.phase === "steady" &&
    reported.phase === "boot_burst"
  ) {
    return current;
  }
  return {
    generation,
    phase: reported.phase,
    steadyCpuMillis: reported.steady_cpu_millis,
    effectiveCpuMillis: reported.effective_cpu_millis,
    quotaVerifiedAt: reported.quota_verified_at_unix_ms ?? null,
    leaseExpiresAt: reported.lease_expires_at_unix_ms ?? null,
  };
}

function resetVmForRuntimeGeneration(
  current: RunVmStateDocument,
): RunVmStateDocument {
  const resetProbes = (probes: RunVmStateDocument["bootProbes"]) =>
    probes.map((probe) => ({
      ...probe,
      status: "pending",
      error: null,
      value: null,
    }));
  return {
    ...current,
    retiredRuntimeGenerations: [
      ...(current.retiredRuntimeGenerations ?? []),
      ...(current.runtimeConstraints?.generation
        ? [current.runtimeConstraints.generation]
        : []),
    ].filter(
      (generation, index, values) => values.indexOf(generation) === index,
    ),
    phase: "booting",
    phaseDetail: "A new VM generation is waiting for fresh readiness evidence.",
    terminalPhase: "pending",
    terminalReason: "Waiting for the new VM generation to seal its CPU quota.",
    terminalObservedAt: null,
    terminalTarget: {
      host: null,
      port: 22,
      username: current.terminalTarget.username,
      hostKeyOpenssh: null,
      checkedAt: null,
    },
    runtimeConstraints: null,
    bootEvidence: null,
    resourceState: null,
    bootProbes: resetProbes(current.bootProbes),
    scenarioProbes: resetProbes(current.scenarioProbes),
  };
}

function projectTerminalReadiness(
  reported: VmTerminalStateV1 | null | undefined,
  runtimeConstraints: RunVmStateDocument["runtimeConstraints"],
  sshHostKeysOpenssh: string[] | null | undefined,
  current: RunVmStateDocument,
  reportPhase: BridgeVmPhase,
): {
  phase: RunVmStateDocument["terminalPhase"];
  reason: string | null;
  observedAt: number | null;
  target: RunVmStateDocument["terminalTarget"];
} {
  if (!reported) {
    return currentTerminalProjection(current);
  }

  if (reported.state === "failed" || reportPhase === "failed") {
    return {
      phase: "failed",
      reason: reported.reason?.trim() || "Terminal readiness failed.",
      observedAt: reported.observed_at_unix_ms,
      target: clearedTerminalTarget(current),
    };
  }

  const expectedCpuMillis = current.provisioning.resources?.cpuMillis ?? null;
  const quotaReady =
    expectedCpuMillis !== null &&
    expectedCpuMillis > 0 &&
    Boolean(runtimeConstraints?.generation?.trim()) &&
    runtimeConstraints?.phase === "steady" &&
    runtimeConstraints.steadyCpuMillis === expectedCpuMillis &&
    runtimeConstraints.effectiveCpuMillis === expectedCpuMillis &&
    typeof runtimeConstraints.quotaVerifiedAt === "number" &&
    Number.isInteger(runtimeConstraints.quotaVerifiedAt) &&
    runtimeConstraints.quotaVerifiedAt > 0 &&
    runtimeConstraints.quotaVerifiedAt <= reported.observed_at_unix_ms;
  const target = reported.state === "ready" ? reported.target : null;
  const hostKeyOpenssh =
    sshHostKeysOpenssh?.find((key) => key.trim().length > 0)?.trim() ?? null;
  const explicitReady = Boolean(
    target?.host.trim() &&
    target.port > 0 &&
    target.username.trim() &&
    hostKeyOpenssh &&
    quotaReady &&
    runtimeConstraints?.quotaVerifiedAt !== null &&
    runtimeConstraints?.quotaVerifiedAt !== undefined &&
    target.checked_at_unix_ms >= runtimeConstraints.quotaVerifiedAt,
  );

  if (explicitReady && target) {
    return {
      phase: "ready",
      reason: null,
      observedAt: reported.observed_at_unix_ms,
      target: {
        host: target.host.trim(),
        port: target.port,
        username: target.username.trim(),
        hostKeyOpenssh,
        checkedAt: target.checked_at_unix_ms,
      },
    };
  }

  // Once accepted, readiness remains sticky across later periodic/probe
  // reports which omit evidence or temporarily observe a pending TCP check.
  // Explicit failure above is still authoritative.
  if (current.terminalPhase === "ready") {
    return currentTerminalProjection(current);
  }

  return {
    phase: "pending",
    reason:
      reported.state === "ready"
        ? quotaReady
          ? "Waiting for a complete verified SSH target."
          : "Waiting for verified steady CPU quota."
        : (reported.reason?.trim() ?? null),
    observedAt: reported.observed_at_unix_ms,
    target: clearedTerminalTarget(current),
  };
}

function clearedTerminalTarget(current: RunVmStateDocument) {
  return {
    host: null,
    port: 22,
    username: current.terminalTarget.username,
    hostKeyOpenssh: null,
    checkedAt: null,
  };
}

function currentTerminalProjection(current: RunVmStateDocument) {
  return {
    phase: current.terminalPhase,
    reason: current.terminalReason,
    observedAt: current.terminalObservedAt,
    target:
      current.terminalPhase === "ready"
        ? current.terminalTarget
        : clearedTerminalTarget(current),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
