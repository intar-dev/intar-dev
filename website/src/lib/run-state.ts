import type { ScenarioLaunchSummary } from "@/lib/scenario-model";
import type { ImageKey } from "@/generated/catalog";

export type RunPhase =
  | "queued"
  | "provisioning"
  | "active_partial"
  | "active_full"
  | "solved"
  | "teardown_requested"
  | "tearing_down"
  | "archiving"
  | "completed"
  | "failed";

export type VmPhase =
  | "queued"
  | "launching"
  | "booting"
  | "ready"
  | "solved"
  | "destroying"
  | "archived"
  | "completed"
  | "failed";

export interface ScenarioProbeStatus {
  id: string;
  label: string;
  kind: string;
  phase: "boot" | "scenario";
  status: string;
  error: string | null;
  value: unknown;
}

export interface ScenarioReplayArtifact {
  id: string;
  hostId: string;
  runId: string;
  vmId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

export interface TerminalTarget {
  host: string | null;
  port: number;
  username: string;
  hostKeyOpenssh: string | null;
  checkedAt: number | null;
}

export interface RunVmProvisioningSpec {
  image: string | null;
  imageKey: ImageKey | null;
  imageSha256: string | null;
  resources: {
    vcpus: number;
    memoryMib: number;
    diskMib: number;
  } | null;
  leaseDurationSeconds: number | null;
  groupName: string | null;
  groupId: string | null;
  setupKeyId: string | null;
  status: "pending" | "provisioning" | "queued" | "failed";
  error: string | null;
}

export interface RunVmStateDocument {
  id: string;
  ordinal: number;
  scenarioVmId: string;
  scenarioVmName: string;
  runtimeVmName: string;
  hostname: string;
  phase: VmPhase;
  phaseTitle: string;
  phaseDetail: string;
  progressPercent: number;
  terminalPhase: "pending" | "ready" | "failed";
  terminalReason: string | null;
  terminalObservedAt: number | null;
  canOpenTerminal: boolean;
  bootProbes: ScenarioProbeStatus[];
  scenarioProbes: ScenarioProbeStatus[];
  replayArtifacts: ScenarioReplayArtifact[];
  primaryReplayArtifactId: string | null;
  terminalTarget: TerminalTarget;
  /// Reported guest IP inside the agent's VM network (not publicly routable).
  guestIp: string | null;
  launchSummary: ScenarioLaunchSummary;
  runtimeState: string | null;
  runtimeObservedAt: number | null;
  vmCreatedAt: number | null;
  provisioning: RunVmProvisioningSpec;
}

export interface RunStateDocument {
  phase: RunPhase;
  phaseTitle: string;
  phaseDetail: string;
  progressPercent: number;
  terminalPhase: "pending" | "ready" | "failed";
  canOpenTerminal: boolean;
  canDestroy: boolean;
  bootProbes: ScenarioProbeStatus[];
  scenarioProbes: ScenarioProbeStatus[];
  replayArtifacts: ScenarioReplayArtifact[];
  primaryReplayArtifactId: string | null;
  terminalTarget: TerminalTarget;
  vms: RunVmStateDocument[];
}

export const RUN_PHASE_ORDER: Record<RunPhase, number> = {
  queued: 0,
  provisioning: 1,
  active_partial: 2,
  active_full: 3,
  solved: 4,
  teardown_requested: 5,
  tearing_down: 6,
  archiving: 7,
  completed: 8,
  failed: 8,
};

export const VM_PHASE_ORDER: Record<VmPhase, number> = {
  queued: 0,
  launching: 1,
  booting: 2,
  ready: 3,
  solved: 4,
  destroying: 5,
  archived: 6,
  completed: 7,
  failed: 7,
};

export function buildInitialRunState(input: {
  vms: Array<{
    id: string;
    ordinal: number;
    scenarioVmId: string;
    scenarioVmName: string;
    runtimeVmName: string;
    hostname: string;
    launchSummary: ScenarioLaunchSummary;
  }>;
}): RunStateDocument {
  const vms = input.vms.map((vm) => buildInitialVmState(vm));
  return recomputeRunState({
    phase: "queued",
    phaseTitle: "Queued",
    phaseDetail: "Waiting for host delivery.",
    progressPercent: 0,
    terminalPhase: "pending",
    canOpenTerminal: false,
    canDestroy: true,
    bootProbes: [],
    scenarioProbes: [],
    replayArtifacts: [],
    primaryReplayArtifactId: null,
    terminalTarget: defaultTerminalTarget(),
    vms,
  });
}

export function buildInitialVmState(input: {
  id: string;
  ordinal: number;
  scenarioVmId: string;
  scenarioVmName: string;
  runtimeVmName: string;
  hostname: string;
  launchSummary: ScenarioLaunchSummary;
}): RunVmStateDocument {
  const bootProbes = input.launchSummary.probeDescriptors
    .filter((probe) => probe.phase === "boot")
    .map((probe) => buildInitialProbe(probe));
  const scenarioProbes = input.launchSummary.probeDescriptors
    .filter((probe) => probe.phase === "scenario")
    .map((probe) => buildInitialProbe(probe));
  return decorateVmState({
    id: input.id,
    ordinal: input.ordinal,
    scenarioVmId: input.scenarioVmId,
    scenarioVmName: input.scenarioVmName,
    runtimeVmName: input.runtimeVmName,
    hostname: input.hostname,
    phase: "queued",
    phaseTitle: "",
    phaseDetail: "",
    progressPercent: 0,
    terminalPhase: "pending",
    terminalReason: null,
    terminalObservedAt: null,
    canOpenTerminal: false,
    bootProbes,
    scenarioProbes,
    replayArtifacts: [],
    primaryReplayArtifactId: null,
    terminalTarget: defaultTerminalTarget(),
    guestIp: null,
    launchSummary: input.launchSummary,
    runtimeState: null,
    runtimeObservedAt: null,
    vmCreatedAt: null,
    provisioning: {
      image: null,
      imageKey: null,
      imageSha256: null,
      resources: null,
      leaseDurationSeconds: null,
      groupName: null,
      groupId: null,
      setupKeyId: null,
      status: "pending",
      error: null,
    },
  });
}

export function recomputeRunState(current: RunStateDocument): RunStateDocument {
  const vms = current.vms.map((vm) => decorateVmState(vm));
  const bootProbes = vms.flatMap((vm) => vm.bootProbes);
  const scenarioProbes = vms.flatMap((vm) => vm.scenarioProbes);
  const replayArtifacts = vms.flatMap((vm) => vm.replayArtifacts);
  const primaryReplayArtifactId =
    vms.find((vm) => vm.primaryReplayArtifactId)?.primaryReplayArtifactId ??
    replayArtifacts.at(-1)?.id ??
    null;
  const terminalVm =
    vms.find(
      (vm) =>
        hasTerminalEndpoint(vm.terminalTarget) && vm.terminalPhase === "ready",
    ) ??
    vms[0] ??
    null;
  const terminalTarget = terminalVm?.terminalTarget ?? defaultTerminalTarget();
  const phase = deriveRunPhase(vms, current.phase);
  const descriptor = describeRunPhase(phase, vms, current.phaseDetail);

  return {
    phase,
    phaseTitle: descriptor.title,
    phaseDetail: descriptor.detail,
    progressPercent: descriptor.progressPercent,
    terminalPhase: vms.some((vm) => vm.terminalPhase === "ready")
      ? "ready"
      : vms.some((vm) => vm.terminalPhase === "failed")
        ? "failed"
        : "pending",
    canOpenTerminal: vms.some((vm) => vm.canOpenTerminal),
    canDestroy: !["archiving", "completed"].includes(phase),
    bootProbes,
    scenarioProbes,
    replayArtifacts,
    primaryReplayArtifactId,
    terminalTarget,
    vms,
  };
}

export function canAdvanceRunPhase(current: RunPhase, next: RunPhase): boolean {
  return RUN_PHASE_ORDER[next] >= RUN_PHASE_ORDER[current];
}

export function canAdvanceVmPhase(current: VmPhase, next: VmPhase): boolean {
  return VM_PHASE_ORDER[next] >= VM_PHASE_ORDER[current];
}

export function decorateVmState(vm: RunVmStateDocument): RunVmStateDocument {
  const descriptor = describeVmPhase(vm.phase, vm);
  return {
    ...vm,
    phaseTitle: descriptor.title,
    phaseDetail: descriptor.detail,
    progressPercent: descriptor.progressPercent,
    terminalPhase: vm.terminalPhase,
    runtimeObservedAt: vm.runtimeObservedAt ?? null,
    canOpenTerminal:
      vm.terminalPhase === "ready" && hasTerminalEndpoint(vm.terminalTarget),
    primaryReplayArtifactId:
      vm.replayArtifacts.at(-1)?.id ?? vm.primaryReplayArtifactId ?? null,
  };
}

export function buildInitialProbe(input: {
  id: string;
  label: string;
  kind: string;
  phase: "boot" | "scenario";
}): ScenarioProbeStatus {
  return {
    id: input.id,
    label: input.label,
    kind: input.kind,
    phase: input.phase,
    status: "pending",
    error: null,
    value: null,
  };
}

export function applyProbeSnapshotToVm(
  vm: RunVmStateDocument,
  input: {
    probes?: Array<{
      id?: string | null;
      kind?: string | null;
      status?: string | null;
      error?: string | null;
      value?: unknown;
    }> | null;
  },
): RunVmStateDocument {
  const updates = new Map(
    (input.probes ?? [])
      .filter(
        (
          probe,
        ): probe is {
          id: string;
          kind?: string | null;
          status?: string | null;
          error?: string | null;
          value?: unknown;
        } => typeof probe?.id === "string" && probe.id.length > 0,
      )
      .map((probe) => [probe.id, probe]),
  );

  const merge = (
    list: ScenarioProbeStatus[],
    options?: {
      stickyPass?: boolean;
    },
  ) =>
    list.map((probe) => {
      const next = updates.get(probe.id);
      if (!next) {
        return probe;
      }
      const nextStatus = next.status?.trim() || probe.status;
      if (
        options?.stickyPass &&
        isPassingProbeStatus(probe.status) &&
        !isPassingProbeStatus(nextStatus)
      ) {
        return probe;
      }
      const hasError = Object.prototype.hasOwnProperty.call(next, "error");
      const hasValue = Object.prototype.hasOwnProperty.call(next, "value");
      return {
        ...probe,
        kind: next.kind?.trim() || probe.kind,
        status: nextStatus,
        error: hasError
          ? typeof next.error === "string"
            ? next.error.trim() || null
            : null
          : probe.error,
        value: hasValue ? (next.value ?? null) : probe.value,
      };
    });

  return decorateVmState({
    ...vm,
    bootProbes: merge(vm.bootProbes, { stickyPass: true }),
    scenarioProbes: merge(vm.scenarioProbes),
  });
}

function isPassingProbeStatus(status: string | null | undefined): boolean {
  const normalized = status?.trim().toLowerCase() ?? "";
  return (
    normalized === "pass" ||
    normalized === "passed" ||
    normalized === "ready" ||
    normalized === "ok" ||
    normalized === "succeeded"
  );
}

function deriveRunPhase(
  vms: RunVmStateDocument[],
  current: RunPhase,
): RunPhase {
  if (!vms.length) {
    return current;
  }
  if (current === "completed" || current === "failed") {
    return current;
  }
  if (vms.some((vm) => vm.phase === "failed")) {
    return "failed";
  }
  if (vms.every((vm) => vm.phase === "completed" || vm.phase === "failed")) {
    return "completed";
  }
  if (RUN_PHASE_ORDER[current] >= RUN_PHASE_ORDER.teardown_requested) {
    if (vms.some((vm) => vm.phase === "destroying")) {
      return "tearing_down";
    }
    if (vms.some((vm) => vm.phase === "archived" || vm.phase === "completed")) {
      return "archiving";
    }
    return "teardown_requested";
  }
  if (vms.every((vm) => vm.phase === "solved")) {
    return "solved";
  }
  if (vms.every((vm) => vm.phase === "ready" || vm.phase === "solved")) {
    return "active_full";
  }
  if (vms.some((vm) => vm.phase === "ready" || vm.phase === "solved")) {
    return "active_partial";
  }
  if (
    current === "provisioning" &&
    vms.some(
      (vm) =>
        vm.phase === "queued" ||
        vm.phase === "launching" ||
        vm.phase === "booting",
    )
  ) {
    return "provisioning";
  }
  if (vms.some((vm) => vm.phase === "booting")) {
    return "provisioning";
  }
  if (vms.some((vm) => vm.phase === "launching")) {
    return "provisioning";
  }
  return "queued";
}

function describeVmPhase(
  phase: VmPhase,
  vm: RunVmStateDocument,
): {
  title: string;
  detail: string;
  progressPercent: number;
} {
  switch (phase) {
    case "queued":
      return {
        title: "Queued",
        detail: vm.phaseDetail || "Waiting for host delivery.",
        progressPercent: 5,
      };
    case "launching":
      return {
        title: "Launching",
        detail:
          vm.phaseDetail || "The launch request is in flight to the host.",
        progressPercent: 20,
      };
    case "booting":
      return {
        title: "Booting",
        detail:
          vm.phaseDetail ||
          "Waiting for the VM to boot and initial probes to pass.",
        progressPercent: 40,
      };
    case "ready":
      return {
        title: "Ready",
        detail:
          vm.phaseDetail ||
          (hasTerminalEndpoint(vm.terminalTarget)
            ? "The VM is ready for shell access."
            : "The VM is running and waiting for a shell target."),
        progressPercent: 65,
      };
    case "solved":
      return {
        title: "Solved",
        detail:
          vm.phaseDetail || "All scenario probes are passing for this VM.",
        progressPercent: 80,
      };
    case "destroying":
      return {
        title: "Destroying",
        detail: vm.phaseDetail || "The host is tearing this VM down.",
        progressPercent: 88,
      };
    case "archived":
      return {
        title: "Archived",
        detail:
          vm.phaseDetail ||
          "Local teardown finished. Final artifacts are archiving.",
        progressPercent: 96,
      };
    case "completed":
      return {
        title: "Completed",
        detail: vm.phaseDetail || "This VM is fully finished.",
        progressPercent: 100,
      };
    case "failed":
      return {
        title: "Failed",
        detail: vm.phaseDetail || "The VM failed to complete.",
        progressPercent: 100,
      };
  }
}

function describeRunPhase(
  phase: RunPhase,
  vms: RunVmStateDocument[],
  currentDetail: string,
): {
  title: string;
  detail: string;
  progressPercent: number;
} {
  switch (phase) {
    case "queued":
      return {
        title: "Queued",
        detail: "Waiting to hand the run to a host.",
        progressPercent: 5,
      };
    case "provisioning":
      return {
        title: "Provisioning",
        detail: "Launching the run VMs and waiting for them to boot.",
        progressPercent: 30,
      };
    case "active_partial":
      return {
        title: "Partially ready",
        detail:
          "At least one VM is usable. Other required VMs are still catching up.",
        progressPercent: 55,
      };
    case "active_full":
      return {
        title: "Active",
        detail: "All required VMs are ready.",
        progressPercent: 70,
      };
    case "solved":
      return {
        title: "Solved",
        detail: "All required VMs are passing their scenario probes.",
        progressPercent: 85,
      };
    case "teardown_requested":
      return {
        title: "Teardown requested",
        detail:
          currentDetail || "Waiting for the host to acknowledge teardown.",
        progressPercent: 90,
      };
    case "tearing_down":
      return {
        title: "Tearing down",
        detail: "Destroying VMs and collecting final artifacts.",
        progressPercent: 94,
      };
    case "archiving":
      return {
        title: "Archiving",
        detail: "Final run artifacts are uploading.",
        progressPercent: 97,
      };
    case "completed":
      return {
        title: "Completed",
        detail: "The run has finished cleanly.",
        progressPercent: 100,
      };
    case "failed":
      return {
        title: "Failed",
        detail:
          currentDetail ||
          vms.find((vm) => vm.phase === "failed")?.phaseDetail ||
          "The run hit a terminal failure.",
        progressPercent: 100,
      };
  }
}

function defaultTerminalTarget(): TerminalTarget {
  return {
    host: null,
    port: 22,
    username: "ubuntu",
    hostKeyOpenssh: null,
    checkedAt: null,
  };
}

function hasTerminalEndpoint(target: TerminalTarget): boolean {
  return Boolean(target.host && target.port > 0);
}
