import type {
  DesiredCachedImageV1,
  DesiredBuildV1,
  DesiredGuestToolsV1,
  DesiredVmV2,
  HostDesiredStateV2,
} from "@/generated/bridge";
import { HOST_DESIRED_STATE_SCHEMA_VERSION } from "@/generated/constants";
import type { ImageKey } from "@/generated/catalog";
import type { RunVmStateDocument } from "@/lib/run-state";

export type DesiredStateDraft = HostDesiredStateV2;
export type DesiredStateMutator = (draft: DesiredStateDraft) => void;

const LEGACY_HOST_DESIRED_STATE_SCHEMA_VERSION = 3;

export interface StoredHostDesiredStateUpgrade {
  desiredState: HostDesiredStateV2;
  migrated: boolean;
}

export function createEmptyHostDesiredState(input: {
  hostId: string;
  nowUnixMs: number;
}): HostDesiredStateV2 {
  return {
    schema_version: HOST_DESIRED_STATE_SCHEMA_VERSION,
    host_id: input.hostId,
    version: 0,
    generated_at_unix_ms: input.nowUnixMs,
    cached_images: [],
    cached_guest_tools: [],
    vms: [],
    builds: [],
  };
}

export function upgradeStoredHostDesiredState(input: {
  document: unknown;
  hostId: string;
  rowVersion: number;
  nowUnixMs: number;
}): StoredHostDesiredStateUpgrade {
  const document = input.document;
  if (!isUnknownRecord(document)) {
    throw new Error(`desired state for host ${input.hostId} is not an object`);
  }
  if (
    document.host_id !== input.hostId ||
    document.version !== input.rowVersion ||
    !Number.isSafeInteger(input.rowVersion) ||
    input.rowVersion < 0
  ) {
    throw new Error(`desired state identity is invalid for host ${input.hostId}`);
  }

  if (document.schema_version === HOST_DESIRED_STATE_SCHEMA_VERSION) {
    if (
      !Array.isArray(document.cached_images) ||
      (document.cached_guest_tools !== undefined &&
        !Array.isArray(document.cached_guest_tools)) ||
      !Array.isArray(document.vms) ||
      !Array.isArray(document.builds)
    ) {
      throw new Error(`desired state arrays are invalid for host ${input.hostId}`);
    }
    return {
      desiredState: document as unknown as HostDesiredStateV2,
      migrated: false,
    };
  }

  if (document.schema_version !== LEGACY_HOST_DESIRED_STATE_SCHEMA_VERSION) {
    throw new Error(
      `desired state schema ${String(document.schema_version)} is unsupported for host ${input.hostId}`,
    );
  }
  if (
    !Array.isArray(document.cached_images) ||
    !Array.isArray(document.vms) ||
    !Array.isArray(document.builds)
  ) {
    throw new Error(`legacy desired state arrays are invalid for host ${input.hostId}`);
  }
  const runningVm = document.vms.find(
    (vm) => !isUnknownRecord(vm) || vm.desired_phase !== "absent",
  );
  if (runningVm !== undefined) {
    throw new Error(
      `legacy desired state for host ${input.hostId} still contains a running or malformed VM`,
    );
  }

  return {
    desiredState: {
      ...createEmptyHostDesiredState({
        hostId: input.hostId,
        nowUnixMs: input.nowUnixMs,
      }),
      version: input.rowVersion + 1,
    },
    migrated: true,
  };
}

export function mutateDesiredState(
  current: HostDesiredStateV2,
  mutator: DesiredStateMutator,
  options: { nowUnixMs: number },
): HostDesiredStateV2 {
  const before = comparableDesiredStatePayload(current);
  const draft = cloneDesiredState(current);
  mutator(draft);

  const normalized = normalizeDesiredState(draft);
  const after = comparableDesiredStatePayload(normalized);
  if (before === after) {
    return current;
  }

  return {
    ...normalized,
    version: current.version + 1,
    generated_at_unix_ms: options.nowUnixMs,
  };
}

export function upsertDesiredCachedImage(
  draft: DesiredStateDraft,
  image: DesiredCachedImageV1,
): void {
  const next = cloneDesiredCachedImage(image);
  const index = draft.cached_images.findIndex(
    (candidate) => cachedImageIdentity(candidate) === cachedImageIdentity(next),
  );
  if (index === -1) {
    draft.cached_images.push(next);
  } else {
    draft.cached_images[index] = next;
  }
}

export function upsertDesiredGuestTools(
  draft: DesiredStateDraft,
  pin: DesiredGuestToolsV1,
): void {
  const next = { ...pin };
  const entries = draft.cached_guest_tools ?? (draft.cached_guest_tools = []);
  const index = entries.findIndex(
    (candidate) => candidate.tools_disk_sha256 === next.tools_disk_sha256,
  );
  if (index === -1) {
    entries.push(next);
  } else {
    entries[index] = next;
  }
}

export function upsertDesiredVm(
  draft: DesiredStateDraft,
  vm: DesiredVmV2,
): void {
  const next = cloneDesiredVm(vm);
  const index = draft.vms.findIndex(
    (candidate) => desiredVmIdentity(candidate) === desiredVmIdentity(next),
  );
  if (index === -1) {
    draft.vms.push(next);
  } else {
    draft.vms[index] = next;
  }
}

export function upsertDesiredBuild(
  draft: DesiredStateDraft,
  build: DesiredBuildV1,
): void {
  const next = cloneDesiredBuild(build);
  const index = draft.builds.findIndex(
    (candidate) => desiredBuildIdentity(candidate) === desiredBuildIdentity(next),
  );
  if (index === -1) {
    draft.builds.push(next);
  } else {
    draft.builds[index] = next;
  }
}

export function removeDesiredBuild(
  draft: DesiredStateDraft,
  identity: { buildId: string },
): boolean {
  const index = draft.builds.findIndex((build) => build.build_id === identity.buildId);
  if (index === -1) {
    return false;
  }
  draft.builds.splice(index, 1);
  return true;
}

export function clearDesiredCachedImages(draft: DesiredStateDraft): boolean {
  if (draft.cached_images.length === 0) {
    return false;
  }
  draft.cached_images = [];
  return true;
}

export function clearDesiredGuestTools(draft: DesiredStateDraft): boolean {
  if (!draft.cached_guest_tools?.length) {
    return false;
  }
  draft.cached_guest_tools = [];
  return true;
}

export function clearDesiredVms(draft: DesiredStateDraft): boolean {
  if (draft.vms.length === 0) {
    return false;
  }
  draft.vms = [];
  return true;
}

export function clearDesiredBuilds(draft: DesiredStateDraft): boolean {
  if (draft.builds.length === 0) {
    return false;
  }
  draft.builds = [];
  return true;
}

export function markDesiredVmAbsent(
  draft: DesiredStateDraft,
  identity: { runId: string; vmName: string },
): boolean {
  const index = draft.vms.findIndex(
    (vm) => vm.run_id === identity.runId && vm.vm_name === identity.vmName,
  );
  const existing = draft.vms[index];
  if (!existing) {
    return false;
  }
  draft.vms[index] = {
    ...existing,
    desired_phase: "absent",
  };
  return true;
}

export function desiredVmFromRunVm(input: {
  runId: string;
  vm: RunVmStateDocument;
  nowUnixMs: number;
  sshAuthorizedKeysOpenssh: string[];
  guestTools: DesiredGuestToolsV1;
}): DesiredVmV2 | null {
  const imageKey = input.vm.provisioning.imageKey;
  const imageSha256 = input.vm.provisioning.imageSha256?.trim() ?? "";
  const resources = input.vm.provisioning.resources;
  const leaseDurationSeconds = input.vm.provisioning.leaseDurationSeconds;
  const sshAuthorizedKeysOpenssh = normalizeAuthorizedKeys(
    input.sshAuthorizedKeysOpenssh,
  );
  if (
    !imageKey ||
    !imageSha256 ||
    !resources ||
    typeof leaseDurationSeconds !== "number" ||
    sshAuthorizedKeysOpenssh.length === 0
  ) {
    return null;
  }

  return {
    run_id: input.runId,
    vm_name: input.vm.runtimeVmName,
    desired_phase: "running",
    image_key: cloneImageKey(imageKey),
    image_id: imageSha256,
    guest_tools: { ...input.guestTools },
    resources: {
      cpu_millis: resources.cpuMillis,
      vcpu_count: resources.vcpuCount,
      memory_mib: resources.memoryMib,
      disk_mib: resources.diskMib,
    },
    ssh_authorized_keys_openssh: sshAuthorizedKeysOpenssh,
    lease_expires_at_unix_ms: input.nowUnixMs + leaseDurationSeconds * 1000,
  };
}

function normalizeDesiredState(
  document: HostDesiredStateV2,
): HostDesiredStateV2 {
  return {
    ...document,
    cached_images: uniqueLastBy(
      document.cached_images.map(cloneDesiredCachedImage),
      cachedImageIdentity,
    ).sort((left, right) =>
      cachedImageIdentity(left).localeCompare(cachedImageIdentity(right)),
    ),
    cached_guest_tools: uniqueLastBy(
      (document.cached_guest_tools ?? []).map((pin) => ({ ...pin })),
      (pin) => pin.tools_disk_sha256,
    ).sort((left, right) =>
      left.tools_disk_sha256.localeCompare(right.tools_disk_sha256),
    ),
    vms: uniqueLastBy(
      document.vms.map(cloneDesiredVm),
      desiredVmIdentity,
    ).sort((left, right) =>
      desiredVmIdentity(left).localeCompare(desiredVmIdentity(right)),
    ),
    builds: uniqueLastBy(
      document.builds.map(cloneDesiredBuild),
      desiredBuildIdentity,
    ).sort((left, right) =>
      desiredBuildIdentity(left).localeCompare(desiredBuildIdentity(right)),
    ),
  };
}

function comparableDesiredStatePayload(document: HostDesiredStateV2): string {
  const normalized = normalizeDesiredState(document);
  return JSON.stringify({
    schema_version: normalized.schema_version,
    host_id: normalized.host_id,
    cached_images: normalized.cached_images,
    cached_guest_tools: normalized.cached_guest_tools,
    vms: normalized.vms,
    builds: normalized.builds,
  });
}

function cloneDesiredState(document: HostDesiredStateV2): HostDesiredStateV2 {
  return {
    ...document,
    cached_images: document.cached_images.map(cloneDesiredCachedImage),
    cached_guest_tools: (document.cached_guest_tools ?? []).map((pin) => ({
      ...pin,
    })),
    vms: document.vms.map(cloneDesiredVm),
    builds: document.builds.map(cloneDesiredBuild),
  };
}

function cloneDesiredCachedImage(
  image: DesiredCachedImageV1,
): DesiredCachedImageV1 {
  return {
    ...image,
    image_key: cloneImageKey(image.image_key),
  };
}

function cachedImageIdentity(image: DesiredCachedImageV1): string {
  return `${imageKeyIdentity(image.image_key)}:${image.image_id}`;
}

function cloneDesiredVm(vm: DesiredVmV2): DesiredVmV2 {
  return {
    ...vm,
    image_key: cloneImageKey(vm.image_key),
    guest_tools: { ...vm.guest_tools },
    resources: { ...vm.resources },
    ssh_authorized_keys_openssh: [...vm.ssh_authorized_keys_openssh],
  };
}

function cloneDesiredBuild(build: DesiredBuildV1): DesiredBuildV1 {
  return { ...build };
}

function cloneImageKey(imageKey: ImageKey): ImageKey {
  return { ...imageKey };
}

function uniqueLastBy<T>(values: T[], identity: (value: T) => string): T[] {
  const byIdentity = new Map<string, T>();
  for (const value of values) {
    byIdentity.set(identity(value), value);
  }
  return [...byIdentity.values()];
}

function normalizeAuthorizedKeys(values: string[]): string[] {
  return [
    ...new Set(
      values
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  ];
}

function desiredVmIdentity(vm: DesiredVmV2): string {
  return `${vm.run_id}\n${vm.vm_name}`;
}

function desiredBuildIdentity(build: DesiredBuildV1): string {
  return build.build_id;
}

function imageKeyIdentity(imageKey: ImageKey): string {
  return `${imageKey.scenario}\n${imageKey.vm}\n${imageKey.arch}`;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
