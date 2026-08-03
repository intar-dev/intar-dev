import type { WorkshopManifestV2 } from "@intar/workshop-contracts";
import {
  artifactObjectKey,
  imageObjectKey,
  isImageKey,
  isRecord,
  normalizeSha256,
  registryImageKey,
} from "@/control-plane/image-registry/shared";
import { validateWorkshopManifest } from "@/lib/workshops/validation";
import {
  hydrateRawWorkshopManifest,
  hydrateWorkshopManifest,
  type ResolvedWorkshopRuntimeProfile,
  type ValidatedWorkshopSourceBundle,
  type WorkshopCheckpointBuildReport,
} from "./archive";
import type { PublicationProfileResolution } from "./provider";

export interface ValidatedBuilderCheckpoint
  extends WorkshopCheckpointBuildReport {
  rawVmImages: Array<Record<string, unknown>>;
}

export interface ValidatedWorkshopBuilderResult {
  manifest: WorkshopManifestV2;
  checkpoints: ValidatedBuilderCheckpoint[];
  hasAgentKvm: boolean;
  hasDirectCloud: boolean;
}

/**
 * Validate the complete trusted-builder handoff before any immutable revision
 * row is staged. Provider observations are control-plane values pinned when
 * the claim is issued; the builder is never authoritative for provider shape
 * or image identity.
 */
export async function validateWorkshopBuilderResult(input: {
  env: Cloudflare.Env;
  publicationId: string;
  source: ValidatedWorkshopSourceBundle;
  resolutions: PublicationProfileResolution[];
  rawManifest: unknown;
  rawCheckpoints: unknown;
}): Promise<ValidatedWorkshopBuilderResult> {
  const hasAgentKvm = input.resolutions.some(
    (resolution) => resolution.declaration.provider === "agent_kvm",
  );
  const hasDirectCloud = input.resolutions.some(
    (resolution) => resolution.declaration.provider !== "agent_kvm",
  );
  const checkpoints = await validateCheckpointReports({
    ...input,
    hasAgentKvm,
    hasDirectCloud,
  });
  const manifest = validateWorkshopBuilderManifest({
    source: input.source,
    checkpoints,
    resolutions: input.resolutions,
    rawManifest: input.rawManifest,
  });

  return { manifest, checkpoints, hasAgentKvm, hasDirectCloud };
}

/**
 * Verify the builder's exact raw-source hydration, then return the registry's
 * canonical Markdown hydration. This keeps source and profile authority in
 * the control plane without requiring the Rust builder to duplicate the
 * registry's asset rewriting and deterministic Mermaid renderer.
 */
export function validateWorkshopBuilderManifest(input: {
  source: ValidatedWorkshopSourceBundle;
  checkpoints: WorkshopCheckpointBuildReport[];
  resolutions: PublicationProfileResolution[];
  rawManifest: unknown;
}): WorkshopManifestV2 {
  const hasDirectCloud = input.resolutions.some(
    (resolution) => resolution.declaration.provider !== "agent_kvm",
  );
  const verifiedProviderCheckpointIds = hasDirectCloud
    ? new Set(input.checkpoints.map((checkpoint) => checkpoint.checkpointId))
    : undefined;
  const validationOptions = verifiedProviderCheckpointIds
    ? { verifiedProviderCheckpointIds }
    : {};
  const reported = validateWorkshopManifest(
    input.rawManifest,
    validationOptions,
  );
  validateResolvedProfiles(reported, input.resolutions);
  const trustedProfiles = materializeResolvedProfiles(input.resolutions);

  const expectedSourceHydration = hydrateRawWorkshopManifest({
    source: input.source,
    checkpoints: input.checkpoints,
    resolvedProfiles: trustedProfiles,
  });
  if (!jsonEqual(expectedSourceHydration, reported)) {
    throw new Error(
      "hydrated manifest does not exactly match the validated source and checkpoint result",
    );
  }

  const canonical = validateWorkshopManifest(
    hydrateWorkshopManifest({
      source: input.source,
      checkpoints: input.checkpoints,
      resolvedProfiles: trustedProfiles,
    }),
    validationOptions,
  );
  validateResolvedProfiles(canonical, input.resolutions);
  return canonical;
}

function materializeResolvedProfiles(
  resolutions: PublicationProfileResolution[],
): ResolvedWorkshopRuntimeProfile[] {
  return resolutions.map((resolution) => {
    const declaration = resolution.declaration;
    if (declaration.provider === "agent_kvm") {
      if (
        resolution.connectionId !== null ||
        resolution.claimedObservation !== null
      ) {
        throw new Error(
          `agent_kvm profile ${declaration.id} has unexpected provider state`,
        );
      }
      return {
        id: declaration.id,
        provider: "agent_kvm",
        vmId: declaration.vmId,
        requestedSystemImage: declaration.systemImage,
        immutableSystemImage: declaration.systemImage,
        locations: [],
        hardware: {
          architecture: "x86_64",
          cpuMillis: declaration.requirements.cpuMillis,
          providerCpuCount: Math.ceil(
            declaration.requirements.cpuMillis / 1_000,
          ),
          memoryMib: declaration.requirements.memoryMib,
          diskMib: declaration.requirements.diskMib,
        },
      };
    }

    const claimed = resolution.claimedObservation;
    const observation = claimed?.observation;
    if (
      !resolution.connectionId ||
      !claimed ||
      claimed.profile_id !== declaration.id ||
      !observation ||
      observation.provider !== declaration.provider ||
      observation.architecture !== "x86_64" ||
      observation.deprecated ||
      !observation.system_image_is_immutable
    ) {
      throw new Error(
        `runtime profile ${declaration.id} has invalid pinned provider state`,
      );
    }
    const hardware = {
      architecture: "x86_64" as const,
      cpuMillis: observation.cores * 1_000,
      providerCpuCount: observation.cores,
      memoryMib: observation.memory_mib,
      diskMib: observation.disk_mib,
    };
    return declaration.provider === "hetzner_cloud"
      ? {
          id: declaration.id,
          provider: "hetzner_cloud",
          vmId: declaration.vmId,
          machineType: observation.machine_type,
          requestedSystemImage: declaration.systemImage,
          immutableSystemImage: observation.resolved_system_image,
          locations: observation.available_locations,
          hardware,
        }
      : {
          id: declaration.id,
          provider: "gcp_compute",
          vmId: declaration.vmId,
          machineType: observation.machine_type,
          requestedSystemImage: declaration.systemImage,
          immutableSystemImage: observation.resolved_system_image,
          rootDiskType: "pd-balanced",
          locations: observation.available_locations,
          hardware,
        };
  });
}

async function validateCheckpointReports(input: {
  env: Cloudflare.Env;
  publicationId: string;
  source: ValidatedWorkshopSourceBundle;
  rawCheckpoints: unknown;
  hasAgentKvm: boolean;
  hasDirectCloud: boolean;
}): Promise<ValidatedBuilderCheckpoint[]> {
  if (!Array.isArray(input.rawCheckpoints)) {
    throw new Error("checkpoints must be an array");
  }
  const workspace = record(
    record(input.source.compiledManifest.manifest, "manifest").workspace,
    "manifest.workspace",
  );
  const requiredVmIds = recordArray(workspace.vms, "workspace.vms").map(
    (vm) => text(vm.id, "workspace VM id"),
  );
  const expected = expectedCheckpointMetadata(input.source);
  if (input.rawCheckpoints.length !== expected.length) {
    throw new Error("every checkpoint must be reported exactly once");
  }

  const reports: ValidatedBuilderCheckpoint[] = [];
  for (const [ordinal, raw] of input.rawCheckpoints.entries()) {
    const checkpoint = record(raw, `checkpoint[${ordinal}]`);
    const expectedCheckpoint = expected[ordinal]!;
    const checkpointId = text(
      checkpoint.checkpoint_id ?? checkpoint.checkpointId,
      "checkpoint_id",
    );
    if (checkpointId !== expectedCheckpoint.checkpointId) {
      throw new Error(
        `checkpoint ${checkpointId} is out of order; expected ${expectedCheckpoint.checkpointId}`,
      );
    }
    const coveredModuleIds = textArray(
      checkpoint.covered_module_ids ?? checkpoint.coveredModuleIds,
      `checkpoint ${checkpointId} covered_module_ids`,
    );
    if (!jsonEqual(coveredModuleIds, expectedCheckpoint.coveredModuleIds)) {
      throw new Error(
        `checkpoint ${checkpointId} does not cover the canonical cumulative module prefix`,
      );
    }

    const rawVmImages = recordArrayAllowEmpty(
      checkpoint.vm_images ?? checkpoint.vmImages,
      `checkpoint ${checkpointId} vm_images`,
    );
    const vmImages = input.hasAgentKvm
      ? await validateAgentKvmImages({
          env: input.env,
          publicationId: input.publicationId,
          checkpointId,
          requiredVmIds,
          images: rawVmImages,
        })
      : [];
    if (
      input.hasAgentKvm &&
      (checkpoint.sanitized !== true ||
        (checkpoint.cold_boot_verified ?? checkpoint.coldBootVerified) !== true)
    ) {
      throw new Error(
        `checkpoint ${checkpointId} is missing agent_kvm sanitization or cold-boot proof`,
      );
    }
    if (
      !input.hasAgentKvm &&
      (rawVmImages.length !== 0 ||
        checkpoint.sanitized !== false ||
        (checkpoint.cold_boot_verified ?? checkpoint.coldBootVerified) !== false)
    ) {
      throw new Error(
        `checkpoint ${checkpointId} contains unexpected agent_kvm proof`,
      );
    }

    const pending =
      checkpoint.provider_verification_pending ??
      checkpoint.providerVerificationPending ??
      false;
    const rawRuntimeBundle =
      checkpoint.runtime_bundle ?? checkpoint.runtimeBundle;
    const providerArtifact = input.hasDirectCloud
      ? await validateRuntimeBundle(input.env, checkpointId, rawRuntimeBundle)
      : undefined;
    if (
      input.hasDirectCloud &&
      (pending !== true ||
        (checkpoint.runtime_bundle_cold_boot_verified ??
          checkpoint.runtimeBundleColdBootVerified) !== false)
    ) {
      throw new Error(
        `checkpoint ${checkpointId} must hand direct-cloud proof to Intar certification`,
      );
    }
    if (!input.hasDirectCloud && (pending !== false || rawRuntimeBundle != null)) {
      throw new Error(
        `checkpoint ${checkpointId} contains an unexpected direct-cloud bundle`,
      );
    }

    reports.push({
      checkpointId,
      coveredModuleIds,
      vmImages,
      rawVmImages,
      sanitized: input.hasAgentKvm,
      coldBootVerified: input.hasAgentKvm,
      ...(providerArtifact ? { providerArtifact } : {}),
    });
  }
  return reports;
}

async function validateAgentKvmImages(input: {
  env: Cloudflare.Env;
  publicationId: string;
  checkpointId: string;
  requiredVmIds: string[];
  images: Array<Record<string, unknown>>;
}): Promise<WorkshopCheckpointBuildReport["vmImages"]> {
  if (input.images.length !== input.requiredVmIds.length) {
    throw new Error(
      `checkpoint ${input.checkpointId} must contain every workspace VM`,
    );
  }
  const seen = new Set<string>();
  const result: WorkshopCheckpointBuildReport["vmImages"] = [];
  for (const image of input.images) {
    const vmId = text(image.vm_id ?? image.vmId, "vm_id");
    if (!input.requiredVmIds.includes(vmId) || seen.has(vmId)) {
      throw new Error(
        `checkpoint ${input.checkpointId} has an invalid or duplicated VM ${vmId}`,
      );
    }
    seen.add(vmId);
    const imageKey = image.image_key ?? image.imageKey;
    if (
      !isImageKey(imageKey) ||
      imageKey.arch !== "x86_64" ||
      imageKey.scenario !==
        `workshop-${input.publicationId}-${input.checkpointId}` ||
      imageKey.vm !== vmId
    ) {
      throw new Error(
        `checkpoint ${input.checkpointId} image_key is outside its publication namespace`,
      );
    }
    const imageSha256 = digest(
      image.image_sha256 ?? image.imageSha256,
      "image_sha256",
    );
    const kernelSha256 = digest(
      image.kernel_sha256 ?? image.kernelSha256,
      "kernel_sha256",
    );
    const initrdSha256 = digest(
      image.initrd_sha256 ?? image.initrdSha256,
      "initrd_sha256",
    );
    const imageFormat = image.image_format ?? image.imageFormat;
    const virtualSize =
      image.image_virtual_size_bytes ?? image.imageVirtualSizeBytes;
    text(image.boot_cmdline ?? image.bootCmdline, "boot_cmdline");
    if (
      imageFormat !== "raw_zstd" ||
      !Number.isSafeInteger(virtualSize) ||
      Number(virtualSize) <= 0
    ) {
      throw new Error(
        `checkpoint ${input.checkpointId} image metadata is incomplete`,
      );
    }
    const [imageObject, kernelObject, initrdObject] = await Promise.all([
      input.env.VM_IMAGE_REGISTRY_BUCKET.head(
        imageObjectKey(registryImageKey(imageKey), imageSha256),
      ),
      input.env.VM_IMAGE_REGISTRY_BUCKET.head(artifactObjectKey(kernelSha256)),
      input.env.VM_IMAGE_REGISTRY_BUCKET.head(artifactObjectKey(initrdSha256)),
    ]);
    if (
      !imageObject ||
      normalizeSha256(imageObject.customMetadata?.image_sha256 ?? "") !==
        imageSha256 ||
      !kernelObject ||
      !initrdObject
    ) {
      throw new Error(
        `checkpoint ${input.checkpointId} references missing registry objects`,
      );
    }
    result.push({ vmId, imageKey: { ...imageKey }, imageSha256 });
  }
  return result;
}

async function validateRuntimeBundle(
  env: Cloudflare.Env,
  checkpointId: string,
  raw: unknown,
): Promise<NonNullable<WorkshopCheckpointBuildReport["providerArtifact"]>> {
  const artifact = record(raw, `checkpoint ${checkpointId} runtime_bundle`);
  if (artifact.format !== "direct_cloud_linux_x86_64_v1") {
    throw new Error(`checkpoint ${checkpointId} has an invalid bundle format`);
  }
  if (artifact.compression !== "zstd") {
    throw new Error(`checkpoint ${checkpointId} bundle must use zstd`);
  }
  const sha256 = digest(artifact.sha256, "runtime bundle sha256");
  const signatureB64 = text(
    artifact.signature_b64 ?? artifact.signatureB64,
    "runtime bundle signature",
  );
  if (!isEd25519Signature(signatureB64)) {
    throw new Error(`checkpoint ${checkpointId} has an invalid bundle signature`);
  }
  const signingKeyId = text(
    artifact.signing_key_id ?? artifact.signingKeyId,
    "runtime bundle signing key ID",
  );
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(signingKeyId)) {
    throw new Error(`checkpoint ${checkpointId} has an invalid signing key ID`);
  }
  const reportedAgentDigest = optionalDigest(
    artifact.workspace_agent_sha256 ?? artifact.workspaceAgentSha256,
  );
  const guestTools = await verifyPublishedGuestTools(env, reportedAgentDigest);
  const r2Key = artifactObjectKey(sha256);
  const object = await env.VM_IMAGE_REGISTRY_BUCKET.head(r2Key);
  if (
    !object ||
    object.size <= 0 ||
    normalizeSha256(object.customMetadata?.artifact_sha256 ?? "") !== sha256
  ) {
    throw new Error(`checkpoint ${checkpointId} runtime bundle is unavailable`);
  }
  return {
    r2Key,
    sha256,
    sizeBytes: object.size,
    compression: "zstd",
    signatureB64,
    signingKeyId,
    workspaceAgentSha256: guestTools.workspaceAgentSha256,
    kinoSha256: guestTools.kinoSha256,
  };
}

async function verifyPublishedGuestTools(
  env: Cloudflare.Env,
  expectedAgentDigest: string | null,
): Promise<{ workspaceAgentSha256: string; kinoSha256: string }> {
  const current = await env.VM_IMAGE_REGISTRY_BUCKET.get(
    "workspace-agent/releases/current.json",
  );
  if (!current || current.size <= 0 || current.size > 4_096) {
    throw new Error("workspace guest-tools release manifest is unavailable");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await current.text());
  } catch {
    throw new Error("workspace guest-tools release manifest is invalid");
  }
  const manifest = record(raw, "workspace guest-tools release manifest");
  const workspaceAgentSha256 = digest(manifest.sha256, "workspace-agent sha256");
  const kinoSha256 = digest(manifest.kino_sha256, "Kino sha256");
  if (
    expectedAgentDigest !== null &&
    expectedAgentDigest !== workspaceAgentSha256
  ) {
    throw new Error("builder workspace-agent digest is not the published release");
  }
  const workspaceAgentSize = positiveInteger(
    manifest.size_bytes,
    "workspace-agent size",
  );
  const kinoSize = positiveInteger(manifest.kino_size_bytes, "Kino size");
  if (manifest.schema_version !== 2) {
    throw new Error("workspace guest-tools release manifest is invalid");
  }
  const [agent, kino] = await Promise.all([
    env.VM_IMAGE_REGISTRY_BUCKET.head(
      `workspace-agent/releases/${workspaceAgentSha256}/intar-workspace-agent`,
    ),
    env.VM_IMAGE_REGISTRY_BUCKET.head(
      `workspace-agent/kino/releases/${kinoSha256}/kino`,
    ),
  ]);
  if (!agent || agent.size !== workspaceAgentSize || !kino || kino.size !== kinoSize) {
    throw new Error("pinned workspace guest-tools binaries are unavailable");
  }
  return { workspaceAgentSha256, kinoSha256 };
}

function validateResolvedProfiles(
  manifest: WorkshopManifestV2,
  resolutions: PublicationProfileResolution[],
): void {
  if (manifest.workspace.runtimeProfiles.length !== resolutions.length) {
    throw new Error("hydrated runtime profile count does not match the claim");
  }
  for (const [index, resolution] of resolutions.entries()) {
    const profile = manifest.workspace.runtimeProfiles[index]!;
    const declaration = resolution.declaration;
    if (
      profile.id !== declaration.id ||
      profile.provider !== declaration.provider ||
      profile.vmId !== declaration.vmId ||
      profile.requestedSystemImage !== declaration.systemImage
    ) {
      throw new Error(`runtime profile ${declaration.id} changed after claim`);
    }
    if (declaration.provider === "agent_kvm") {
      if (
        resolution.connectionId !== null ||
        resolution.claimedObservation !== null ||
        profile.immutableSystemImage !== declaration.systemImage ||
        profile.hardware.cpuMillis !== declaration.requirements.cpuMillis ||
        profile.hardware.memoryMib !== declaration.requirements.memoryMib ||
        profile.hardware.diskMib !== declaration.requirements.diskMib
      ) {
        throw new Error(`agent_kvm profile ${declaration.id} is not canonical`);
      }
      continue;
    }
    const observation = resolution.claimedObservation?.observation;
    if (
      !resolution.connectionId ||
      !observation ||
      observation.provider !== declaration.provider ||
      observation.machine_type !== declaration.machineType ||
      observation.architecture !== "x86_64" ||
      observation.deprecated ||
      !observation.system_image_is_immutable ||
      observation.available_locations.length === 0 ||
      observation.cores * 1_000 < declaration.requirements.cpuMillis ||
      observation.memory_mib < declaration.requirements.memoryMib ||
      observation.disk_mib < declaration.requirements.diskMib ||
      profile.machineType !== observation.machine_type ||
      profile.immutableSystemImage !== observation.resolved_system_image ||
      !jsonEqual(profile.locations, observation.available_locations) ||
      profile.hardware.cpuMillis !== observation.cores * 1_000 ||
      profile.hardware.providerCpuCount !== observation.cores ||
      profile.hardware.memoryMib !== observation.memory_mib ||
      profile.hardware.diskMib !== observation.disk_mib
    ) {
      throw new Error(`runtime profile ${declaration.id} does not match the pinned catalog observation`);
    }
  }
}

function expectedCheckpointMetadata(
  source: ValidatedWorkshopSourceBundle,
): Array<{ checkpointId: string; coveredModuleIds: string[] }> {
  const manifest = record(source.compiledManifest.manifest, "manifest");
  const modules = recordArray(manifest.modules, "manifest.modules");
  const ordered: Array<Record<string, unknown>> = [];
  const completed = new Set<string>();
  while (ordered.length < modules.length) {
    let progressed = false;
    for (const module of modules) {
      const id = text(module.id, "module id");
      if (completed.has(id)) continue;
      const dependencies = textArray(module.depends_on, `module ${id} dependencies`);
      if (dependencies.every((dependency) => completed.has(dependency))) {
        ordered.push(module);
        completed.add(id);
        progressed = true;
      }
    }
    if (!progressed) throw new Error("module dependency graph is cyclic");
  }
  const covered: string[] = [];
  return ordered.map((module) => {
    covered.push(text(module.id, "module id"));
    return {
      checkpointId: text(module.checkpoint, "module checkpoint"),
      coveredModuleIds: [...covered],
    };
  });
}

function isEd25519Signature(value: string): boolean {
  if (
    value.length > 128 ||
    !/^(?:[A-Za-z0-9+/]{4}){21}[A-Za-z0-9+/]{2}==$/.test(value)
  ) {
    return false;
  }
  try {
    return atob(value).length === 64;
  } catch {
    return false;
  }
}

function digest(value: unknown, label: string): string {
  const normalized =
    typeof value === "string" ? normalizeSha256(value) : null;
  if (!normalized) throw new Error(`${label} must be a SHA-256 digest`);
  return normalized;
}

function optionalDigest(value: unknown): string | null {
  if (value == null) return null;
  return digest(value, "optional digest");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function recordArray(value: unknown, label: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  return value.map((entry, index) => record(entry, `${label}[${index}]`));
}

function recordArrayAllowEmpty(
  value: unknown,
  label: string,
): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => record(entry, `${label}[${index}]`));
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function textArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => text(entry, `${label}[${index}]`));
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => jsonEqual(entry, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        jsonEqual(left[key], right[key]),
    )
  );
}
