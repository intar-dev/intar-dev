import type {
  DesiredCachedImageV1,
  DesiredVmV1,
  HostDesiredStateV1,
} from "@/generated/bridge";
import { HOST_DESIRED_STATE_SCHEMA_VERSION } from "@/generated/constants";
import type { ImageKey } from "@/generated/catalog";
import type { RunVmStateDocument } from "@/lib/run-state";

export type DesiredStateDraft = HostDesiredStateV1;
export type DesiredStateMutator = (draft: DesiredStateDraft) => void;

export function createEmptyHostDesiredState(input: {
  hostId: string;
  nowUnixMs: number;
}): HostDesiredStateV1 {
  return {
    schema_version: HOST_DESIRED_STATE_SCHEMA_VERSION,
    host_id: input.hostId,
    version: 0,
    generated_at_unix_ms: input.nowUnixMs,
    cached_images: [],
    vms: [],
  };
}

export function mutateDesiredState(
  current: HostDesiredStateV1,
  mutator: DesiredStateMutator,
  options: { nowUnixMs: number },
): HostDesiredStateV1 {
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
    (candidate) => imageKeyIdentity(candidate.image_key) === imageKeyIdentity(next.image_key),
  );
  if (index === -1) {
    draft.cached_images.push(next);
  } else {
    draft.cached_images[index] = next;
  }
}

export function upsertDesiredVm(
  draft: DesiredStateDraft,
  vm: DesiredVmV1,
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
}): DesiredVmV1 | null {
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
    image_sha256: imageSha256,
    resources: {
      cpu_count: resources.vcpus,
      memory_mib: resources.memoryMib,
      disk_mib: resources.diskMib,
    },
    ssh_authorized_keys_openssh: sshAuthorizedKeysOpenssh,
    lease_expires_at_unix_ms: input.nowUnixMs + leaseDurationSeconds * 1000,
  };
}

function normalizeDesiredState(
  document: HostDesiredStateV1,
): HostDesiredStateV1 {
  return {
    ...document,
    cached_images: uniqueLastBy(
      document.cached_images.map(cloneDesiredCachedImage),
      (image) => imageKeyIdentity(image.image_key),
    ).sort((left, right) =>
      imageKeyIdentity(left.image_key).localeCompare(
        imageKeyIdentity(right.image_key),
      ),
    ),
    vms: uniqueLastBy(
      document.vms.map(cloneDesiredVm),
      desiredVmIdentity,
    ).sort((left, right) =>
      desiredVmIdentity(left).localeCompare(desiredVmIdentity(right)),
    ),
  };
}

function comparableDesiredStatePayload(document: HostDesiredStateV1): string {
  const normalized = normalizeDesiredState(document);
  return JSON.stringify({
    schema_version: normalized.schema_version,
    host_id: normalized.host_id,
    cached_images: normalized.cached_images,
    vms: normalized.vms,
  });
}

function cloneDesiredState(document: HostDesiredStateV1): HostDesiredStateV1 {
  return {
    ...document,
    cached_images: document.cached_images.map(cloneDesiredCachedImage),
    vms: document.vms.map(cloneDesiredVm),
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

function cloneDesiredVm(vm: DesiredVmV1): DesiredVmV1 {
  return {
    ...vm,
    image_key: cloneImageKey(vm.image_key),
    resources: { ...vm.resources },
    ssh_authorized_keys_openssh: [...vm.ssh_authorized_keys_openssh],
  };
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

function desiredVmIdentity(vm: DesiredVmV1): string {
  return `${vm.run_id}\n${vm.vm_name}`;
}

function imageKeyIdentity(imageKey: ImageKey): string {
  return `${imageKey.scenario}\n${imageKey.vm}\n${imageKey.arch}`;
}
