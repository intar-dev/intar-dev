import type {
  BridgeMessageV6,
  BuildPhase,
  DesiredVmPhase,
  HostRoleV1,
  ImageCachePhase,
  SyncRequestReason,
  VmArchivePhase,
  VmPhase,
  VmProbeStatus,
  VmRuntimeConstraintPhaseV1,
  VmTerminalStateKindV1,
} from "@/generated/bridge";
import type { ImageArchitecture, ProbePhase } from "@/generated/catalog";
import {
  BRIDGE_PROTOCOL_VERSION,
  BUILD_REPORT_SCHEMA_VERSION,
  HOST_DESIRED_STATE_SCHEMA_VERSION,
  HOST_STATE_REPORT_SCHEMA_VERSION,
  VM_REPORT_SCHEMA_VERSION,
} from "@/generated/constants";

const textDecoder = new TextDecoder();

const MESSAGE_TYPES = new Set<BridgeMessageV6["type"]>([
  "client_hello",
  "server_hello",
  "desired_state",
  "state_report",
  "vm_report",
  "build_report",
  "sync_request",
]);

const HOST_ROLES = new Set<HostRoleV1>(["agent", "builder"]);

const IMAGE_ARCHITECTURES = new Set<ImageArchitecture>(["x86_64", "aarch64"]);

const DESIRED_VM_PHASES = new Set<DesiredVmPhase>(["running", "absent"]);

const IMAGE_CACHE_PHASES = new Set<ImageCachePhase>([
  "missing",
  "queued",
  "downloading",
  "ready",
  "failed",
]);

const VM_PHASES = new Set<VmPhase>([
  "pending",
  "pulling_image",
  "creating_disks",
  "booting",
  "running",
  "ready",
  "solved",
  "stopping",
  "stopped",
  "failed",
  "absent",
]);

const PROBE_PHASES = new Set<ProbePhase>(["boot", "scenario"]);

const VM_PROBE_STATUSES = new Set<VmProbeStatus>(["unknown", "pass", "fail"]);

const VM_TERMINAL_STATES = new Set<VmTerminalStateKindV1>([
  "pending",
  "ready",
  "failed",
]);

const VM_RUNTIME_CONSTRAINT_PHASES = new Set<VmRuntimeConstraintPhaseV1>([
  "boot_burst",
  "steady",
]);

const VM_ARCHIVE_PHASES = new Set<VmArchivePhase>([
  "none",
  "pending",
  "uploading",
  "complete",
  "failed",
]);

const BUILD_PHASES = new Set<BuildPhase>([
  "queued",
  "fetching_sources",
  "building_base",
  "building",
  "publishing",
  "uploading_logs",
  "succeeded",
  "failed",
]);

const SYNC_REQUEST_REASONS = new Set<SyncRequestReason>([
  "connect",
  "reconnect",
  "desired_version_lag",
  "operator_requested",
]);

const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;

export function parseBridgeMessageV6(
  input: string | ArrayBuffer,
): BridgeMessageV6 | null {
  const value = parseJson(input);
  if (!isRecord(value)) {
    return null;
  }

  const type = readString(value.type);
  if (!type || !isBridgeMessageType(type)) {
    return null;
  }

  if (!hasV6Envelope(value)) {
    return null;
  }

  switch (type) {
    case "client_hello":
      return isClientHello(value) ? withRunCliCapabilityDefaults(value) : null;
    case "server_hello":
      return isServerHello(value) ? value : null;
    case "desired_state":
      return isDesiredState(value) ? value : null;
    case "state_report":
      return isStateReport(value) ? withRunCliCapabilityDefaults(value) : null;
    case "vm_report":
      return isVmReport(value) ? value : null;
    case "build_report":
      return isBuildReport(value) ? value : null;
    case "sync_request":
      return isSyncRequest(value) ? value : null;
  }
}

export function serializeBridgeMessageV6(message: BridgeMessageV6): string {
  return JSON.stringify(message);
}

function parseJson(input: string | ArrayBuffer): unknown {
  const raw = typeof input === "string" ? input : textDecoder.decode(input);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function hasV6Envelope(value: Record<string, unknown>): boolean {
  return (
    value.protocol_version === BRIDGE_PROTOCOL_VERSION &&
    typeof value.host_id === "string" &&
    value.host_id.trim().length > 0
  );
}

function isClientHello(
  value: unknown,
): value is Extract<BridgeMessageV6, { type: "client_hello" }> {
  if (!isRecord(value)) {
    return false;
  }
  const role = readString(value.role);
  return (
    readString(value.agent_version) !== null &&
    role !== null &&
    HOST_ROLES.has(role as HostRoleV1) &&
    isHostCapabilitiesPayload(value.capabilities) &&
    isOptionalNumber(value.last_applied_desired_version)
  );
}

function isServerHello(
  value: unknown,
): value is Extract<BridgeMessageV6, { type: "server_hello" }> {
  if (!isRecord(value)) {
    return false;
  }
  return isNonNegativeInteger(value.desired_version);
}

function isDesiredState(
  value: unknown,
): value is Extract<BridgeMessageV6, { type: "desired_state" }> {
  if (!isRecord(value)) {
    return false;
  }
  const hostId = readString(value.host_id);
  if (!hostId) {
    return false;
  }
  const desiredState = value.desired_state;
  return (
    isRecord(desiredState) &&
    desiredState.schema_version === HOST_DESIRED_STATE_SCHEMA_VERSION &&
    desiredState.host_id === hostId &&
    isNonNegativeInteger(desiredState.version) &&
    isInteger(desiredState.generated_at_unix_ms) &&
    Array.isArray(desiredState.cached_images) &&
    desiredState.cached_images.every(isDesiredCachedImagePayload) &&
    Array.isArray(desiredState.vms) &&
    desiredState.vms.every(isDesiredVmPayload) &&
    Array.isArray(desiredState.builds) &&
    desiredState.builds.every(isDesiredBuildPayload)
  );
}

function isStateReport(
  value: unknown,
): value is Extract<BridgeMessageV6, { type: "state_report" }> {
  if (!isRecord(value)) {
    return false;
  }
  const hostId = readString(value.host_id);
  if (!hostId) {
    return false;
  }
  const report = value.report;
  return (
    isRecord(report) &&
    report.schema_version === HOST_STATE_REPORT_SCHEMA_VERSION &&
    report.host_id === hostId &&
    isInteger(report.observed_at_unix_ms) &&
    isNonNegativeInteger(report.applied_desired_version) &&
    isHostCapacityPayload(report.capacity) &&
    isHostCapabilitiesPayload(report.capabilities) &&
    Array.isArray(report.cached_images) &&
    report.cached_images.every(isCachedImageStatePayload) &&
    Array.isArray(report.vms) &&
    report.vms.every(isVmActualStatePayload) &&
    Array.isArray(report.builds) &&
    report.builds.every((build) => isBuildReportPayload(build, hostId))
  );
}

function isVmReport(
  value: unknown,
): value is Extract<BridgeMessageV6, { type: "vm_report" }> {
  if (!isRecord(value)) {
    return false;
  }
  const report = value.report;
  const hostId = readString(value.host_id);
  return hostId !== null && isVmReportPayload(report, hostId);
}

function isBuildReport(
  value: unknown,
): value is Extract<BridgeMessageV6, { type: "build_report" }> {
  if (!isRecord(value)) {
    return false;
  }
  const hostId = readString(value.host_id);
  if (!hostId) {
    return false;
  }
  const report = value.report;
  return isBuildReportPayload(report, hostId);
}

function isSyncRequest(
  value: unknown,
): value is Extract<BridgeMessageV6, { type: "sync_request" }> {
  if (!isRecord(value)) {
    return false;
  }
  const reason = readString(value.reason);
  return (
    reason !== null && SYNC_REQUEST_REASONS.has(reason as SyncRequestReason)
  );
}

function isBridgeMessageType(value: string): value is BridgeMessageV6["type"] {
  return MESSAGE_TYPES.has(value as BridgeMessageV6["type"]);
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || value === null || isNonNegativeInteger(value);
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isPositiveInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) > 0;
}

function isInteger(value: unknown): boolean {
  return Number.isInteger(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isSha256Hex(value: unknown): boolean {
  const text = readString(value);
  return text !== null && SHA256_HEX_RE.test(text);
}

function isOptionalSha256Hex(value: unknown): boolean {
  return value === undefined || value === null || isSha256Hex(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || readString(value) !== null;
}

function isOptionalInteger(value: unknown): boolean {
  return value === undefined || value === null || isInteger(value);
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || value === null || isNonNegativeInteger(value);
}

function isStringArray(value: unknown): boolean {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isImageKeyPayload(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const arch = readString(value.arch);
  return (
    readString(value.scenario) !== null &&
    readString(value.vm) !== null &&
    arch !== null &&
    IMAGE_ARCHITECTURES.has(arch as ImageArchitecture)
  );
}

function isOptionalImageKeyPayload(value: unknown): boolean {
  return value === undefined || value === null || isImageKeyPayload(value);
}

function isVmResourcesPayload(value: unknown): boolean {
  return (
    isRecord(value) &&
    isPositiveInteger(value.cpu_millis) &&
    isPositiveInteger(value.vcpu_count) &&
    isNonNegativeInteger(value.memory_mib) &&
    isNonNegativeInteger(value.disk_mib)
  );
}

function isDesiredCachedImagePayload(value: unknown): boolean {
  return (
    isRecord(value) &&
    isImageKeyPayload(value.image_key) &&
    isSha256Hex(value.image_sha256)
  );
}

function isDesiredBuildPayload(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const arch = readString(value.arch);
  return (
    readString(value.build_id) !== null &&
    readString(value.scenario_id) !== null &&
    arch !== null &&
    IMAGE_ARCHITECTURES.has(arch as ImageArchitecture) &&
    readString(value.rev) !== null &&
    isSha256Hex(value.content_hash) &&
    readString(value.bundle_ref) !== null &&
    readString(value.kino_version) !== null
  );
}

function isDesiredVmPayload(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const desiredPhase = readString(value.desired_phase);
  return (
    readString(value.run_id) !== null &&
    readString(value.vm_name) !== null &&
    desiredPhase !== null &&
    DESIRED_VM_PHASES.has(desiredPhase as DesiredVmPhase) &&
    isImageKeyPayload(value.image_key) &&
    isSha256Hex(value.image_sha256) &&
    isVmResourcesPayload(value.resources) &&
    isStringArray(value.ssh_authorized_keys_openssh) &&
    isInteger(value.lease_expires_at_unix_ms)
  );
}

function isHostCapacityPayload(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.total_cpu_millis) &&
    isNonNegativeInteger(value.reserved_cpu_millis) &&
    isNonNegativeInteger(value.schedulable_cpu_millis) &&
    isNonNegativeInteger(value.committed_cpu_millis) &&
    isNonNegativeInteger(value.memory_total_mib) &&
    isNonNegativeInteger(value.memory_available_mib) &&
    readString(value.disk_probe_path) !== null &&
    isNonNegativeInteger(value.disk_total_mib) &&
    isNonNegativeInteger(value.disk_available_mib) &&
    isOptionalNonNegativeNumber(value.load_avg_1m) &&
    isOptionalNonNegativeNumber(value.load_avg_5m) &&
    isOptionalNonNegativeNumber(value.load_avg_15m) &&
    isOptionalString(value.primary_ipv4) &&
    isOptionalString(value.primary_ipv6)
  );
}

function isOptionalNonNegativeNumber(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0)
  );
}

function isHostCapabilitiesPayload(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const arch = readString(value.arch);
  return (
    arch !== null &&
    IMAGE_ARCHITECTURES.has(arch as ImageArchitecture) &&
    (value.cloud_hypervisor_sha256 === null ||
      isSha256Hex(value.cloud_hypervisor_sha256)) &&
    (value.boot_cpu_millis === null ||
      isPositiveInteger(value.boot_cpu_millis)) &&
    (value.boot_cpu_lease_ms === null ||
      isPositiveInteger(value.boot_cpu_lease_ms)) &&
    typeof value.supports_kvm === "boolean" &&
    typeof value.supports_vsock === "boolean" &&
    typeof value.supports_reflink === "boolean" &&
    typeof value.supports_nftables === "boolean" &&
    typeof value.supports_jailer_v2 === "boolean" &&
    typeof value.supports_boot_cpu_lease === "boolean" &&
    typeof value.supports_template_backed_launch === "boolean" &&
    typeof value.fast_template_store === "boolean" &&
    typeof value.supports_hard_cpu_quota === "boolean" &&
    typeof value.supports_landlock === "boolean" &&
    typeof value.supports_cgroup_v2 === "boolean" &&
    // Old agents did not advertise the learner CLI. Treat an omitted field
    // as an explicit false capability rather than rejecting their inventory
    // report or accidentally scheduling a new CLI-required run there.
    (value.supports_run_cli_v1 === undefined ||
      typeof value.supports_run_cli_v1 === "boolean") &&
    (value.supports_run_cli_completion_v1 === undefined ||
      typeof value.supports_run_cli_completion_v1 === "boolean")
  );
}

function withRunCliCapabilityDefaults(
  value: Extract<BridgeMessageV6, { type: "client_hello" | "state_report" }>,
): Extract<BridgeMessageV6, { type: "client_hello" | "state_report" }> {
  if (value.type === "client_hello") {
    if (
      value.capabilities.supports_run_cli_v1 !== undefined &&
      value.capabilities.supports_run_cli_completion_v1 !== undefined
    ) {
      return value;
    }
    return {
      ...value,
      capabilities: {
        ...value.capabilities,
        supports_run_cli_v1: value.capabilities.supports_run_cli_v1 ?? false,
        supports_run_cli_completion_v1:
          value.capabilities.supports_run_cli_completion_v1 ?? false,
      },
    };
  }
  if (
    value.report.capabilities.supports_run_cli_v1 !== undefined &&
    value.report.capabilities.supports_run_cli_completion_v1 !== undefined
  ) {
    return value;
  }
  return {
    ...value,
    report: {
      ...value.report,
      capabilities: {
        ...value.report.capabilities,
        supports_run_cli_v1:
          value.report.capabilities.supports_run_cli_v1 ?? false,
        supports_run_cli_completion_v1:
          value.report.capabilities.supports_run_cli_completion_v1 ?? false,
      },
    },
  };
}

function isCachedImageStatePayload(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const phase = readString(value.phase);
  return (
    isImageKeyPayload(value.image_key) &&
    isSha256Hex(value.image_sha256) &&
    phase !== null &&
    IMAGE_CACHE_PHASES.has(phase as ImageCachePhase) &&
    isOptionalNonNegativeInteger(value.bytes_on_disk) &&
    isOptionalString(value.error) &&
    isInteger(value.updated_at_unix_ms)
  );
}

function isVmNetworkStatePayload(value: unknown): boolean {
  return (
    isRecord(value) &&
    readString(value.bridge_name) !== null &&
    readString(value.guest_ip) !== null &&
    readString(value.guest_cidr) !== null &&
    readString(value.gateway) !== null &&
    isOptionalNonNegativeInteger(value.ssh_host_port)
  );
}

function isOptionalVmNetworkStatePayload(value: unknown): boolean {
  return (
    value === undefined || value === null || isVmNetworkStatePayload(value)
  );
}

function isVmTerminalTargetPayload(value: unknown): boolean {
  return (
    isRecord(value) &&
    readString(value.host) !== null &&
    isPositiveInteger(value.port) &&
    readString(value.username) !== null &&
    isInteger(value.checked_at_unix_ms)
  );
}

function isVmTerminalStatePayload(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const state = readString(value.state);
  if (
    state === null ||
    !VM_TERMINAL_STATES.has(state as VmTerminalStateKindV1) ||
    !isOptionalString(value.reason) ||
    !isInteger(value.observed_at_unix_ms)
  ) {
    return false;
  }

  if (state === "ready") {
    return isVmTerminalTargetPayload(value.target);
  }
  // A pending or failed report must not smuggle a usable endpoint alongside
  // its non-ready state.
  return value.target === undefined || value.target === null;
}

function isVmRuntimeConstraintsPayload(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const phase = readString(value.phase);
  if (
    phase === null ||
    !VM_RUNTIME_CONSTRAINT_PHASES.has(phase as VmRuntimeConstraintPhaseV1) ||
    readString(value.generation) === null ||
    !isPositiveInteger(value.steady_cpu_millis) ||
    !isPositiveInteger(value.effective_cpu_millis) ||
    !isOptionalInteger(value.quota_verified_at_unix_ms) ||
    !isOptionalInteger(value.lease_expires_at_unix_ms)
  ) {
    return false;
  }
  return (
    phase !== "steady" || isPositiveInteger(value.quota_verified_at_unix_ms)
  );
}

function isOptionalVmRuntimeConstraintsPayload(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    isVmRuntimeConstraintsPayload(value)
  );
}

function hasRequiredRuntimeConstraints(
  value: unknown,
  phase: VmPhase,
): boolean {
  return ["booting", "running", "ready"].includes(phase)
    ? isVmRuntimeConstraintsPayload(value)
    : isOptionalVmRuntimeConstraintsPayload(value);
}

function isVmResourceStatePayload(value: unknown): boolean {
  return (
    isRecord(value) &&
    isPositiveInteger(value.cpu_millis) &&
    isPositiveInteger(value.vcpu_count) &&
    isPositiveInteger(value.cpu_quota_us) &&
    isPositiveInteger(value.cpu_period_us) &&
    isNonNegativeInteger(value.cpu_usage_usec) &&
    isNonNegativeInteger(value.cpu_user_usec) &&
    isNonNegativeInteger(value.cpu_system_usec) &&
    isNonNegativeInteger(value.cpu_nr_periods) &&
    isNonNegativeInteger(value.cpu_nr_throttled) &&
    isNonNegativeInteger(value.cpu_throttled_usec)
  );
}

function isOptionalVmResourceStatePayload(value: unknown): boolean {
  return (
    value === undefined || value === null || isVmResourceStatePayload(value)
  );
}

function isVmSandboxStatePayload(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.healthy === "boolean" &&
    readString(value.generation) !== null &&
    readString(value.systemd_unit) !== null &&
    readString(value.cgroup_path) !== null &&
    typeof value.seccomp_enabled === "boolean" &&
    typeof value.landlock_enabled === "boolean" &&
    typeof value.no_new_privs === "boolean"
  );
}

function isOptionalVmSandboxStatePayload(value: unknown): boolean {
  return (
    value === undefined || value === null || isVmSandboxStatePayload(value)
  );
}

function isVmProbeSnapshotPayload(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const phase = readString(value.phase);
  const status = readString(value.status);
  return (
    readString(value.id) !== null &&
    phase !== null &&
    PROBE_PHASES.has(phase as ProbePhase) &&
    status !== null &&
    VM_PROBE_STATUSES.has(status as VmProbeStatus) &&
    isInteger(value.checked_at_unix_ms) &&
    isOptionalString(value.message)
  );
}

function isVmArchiveStatePayload(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const phase = readString(value.phase);
  return (
    phase !== null &&
    VM_ARCHIVE_PHASES.has(phase as VmArchivePhase) &&
    isNonNegativeInteger(value.artifact_count) &&
    isOptionalString(value.error)
  );
}

function isOptionalVmArchiveStatePayload(value: unknown): boolean {
  return (
    value === undefined || value === null || isVmArchiveStatePayload(value)
  );
}

function isVmActualStatePayload(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const phase = readString(value.phase);
  return (
    // Host inventory is authoritative even for a VM that cannot be
    // attributed to a control-plane run. The agent deliberately reports that
    // condition as an empty run_id; only per-run vm_report envelopes require
    // a non-empty run identity.
    typeof value.run_id === "string" &&
    readString(value.vm_name) !== null &&
    isOptionalNonNegativeInteger(value.desired_version) &&
    phase !== null &&
    VM_PHASES.has(phase as VmPhase) &&
    isOptionalImageKeyPayload(value.image_key) &&
    isOptionalSha256Hex(value.image_sha256) &&
    isOptionalVmNetworkStatePayload(value.network) &&
    isVmTerminalStatePayload(value.terminal) &&
    hasRequiredRuntimeConstraints(
      value.runtime_constraints,
      phase as VmPhase,
    ) &&
    isOptionalVmResourceStatePayload(value.resource_state) &&
    isOptionalVmSandboxStatePayload(value.sandbox) &&
    isStringArray(value.ssh_host_keys_openssh) &&
    Array.isArray(value.probes) &&
    value.probes.every(isVmProbeSnapshotPayload) &&
    isOptionalVmArchiveStatePayload(value.archive) &&
    isOptionalString(value.error) &&
    isInteger(value.updated_at_unix_ms)
  );
}

function isVmReportPayload(value: unknown, hostId: string): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const phase = readString(value.phase);
  return (
    value.schema_version === VM_REPORT_SCHEMA_VERSION &&
    value.host_id === hostId &&
    readString(value.run_id) !== null &&
    readString(value.vm_name) !== null &&
    isOptionalNonNegativeInteger(value.desired_version) &&
    isInteger(value.observed_at_unix_ms) &&
    phase !== null &&
    VM_PHASES.has(phase as VmPhase) &&
    isOptionalVmNetworkStatePayload(value.network) &&
    isVmTerminalStatePayload(value.terminal) &&
    hasRequiredRuntimeConstraints(
      value.runtime_constraints,
      phase as VmPhase,
    ) &&
    isOptionalVmResourceStatePayload(value.resource_state) &&
    isOptionalVmSandboxStatePayload(value.sandbox) &&
    isStringArray(value.ssh_host_keys_openssh) &&
    Array.isArray(value.probes) &&
    value.probes.every(isVmProbeSnapshotPayload) &&
    isOptionalVmArchiveStatePayload(value.archive) &&
    isOptionalString(value.error)
  );
}

function isBuildReportPayload(
  value: unknown,
  hostId: string,
): value is Extract<BridgeMessageV6, { type: "build_report" }>["report"] {
  if (!isRecord(value)) {
    return false;
  }
  const phase = readString(value.phase);
  return (
    value.schema_version === BUILD_REPORT_SCHEMA_VERSION &&
    value.host_id === hostId &&
    readString(value.build_id) !== null &&
    readString(value.scenario_id) !== null &&
    isSha256Hex(value.content_hash) &&
    isInteger(value.observed_at_unix_ms) &&
    phase !== null &&
    BUILD_PHASES.has(phase as BuildPhase) &&
    isOptionalString(value.current_vm) &&
    isOptionalInteger(value.started_at_unix_ms) &&
    isOptionalInteger(value.finished_at_unix_ms) &&
    isNonNegativeInteger(value.attempt) &&
    isOptionalString(value.error)
  );
}
