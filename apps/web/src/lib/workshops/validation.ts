import {
  isWorkshopManifestV2,
  type WorkshopManifestV2,
} from "@intar/workshop-contracts";
import { appError } from "@/lib/app-error";

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;

export interface WorkshopManifestValidationOptions {
  /**
   * Checkpoints whose provider-only reconstruction artifacts have already
   * been verified by Intar. Callers must derive this set from canonical
   * provider verification state, never from workshop or builder input.
   */
  verifiedProviderCheckpointIds?: ReadonlySet<string>;
}

export function validateWorkshopSlug(input: string): string {
  const slug = input.trim();
  if (!SLUG_PATTERN.test(slug) || slug.length > 80) {
    throw appError(
      400,
      "workshop_slug_invalid",
      "workshop slug must be lowercase kebab-case and at most 80 characters",
    );
  }
  return slug;
}

export function validateWorkshopTitle(input: string): string {
  const title = input.trim();
  if (!title || title.length > 120) {
    throw appError(
      400,
      "workshop_title_invalid",
      "workshop title must be between 1 and 120 characters",
    );
  }
  return title;
}

export function validateWorkshopSummary(input: string): string {
  const summary = input.trim();
  if (!summary || summary.length > 1_000) {
    throw appError(
      400,
      "workshop_summary_invalid",
      "workshop summary must be between 1 and 1000 characters",
    );
  }
  return summary;
}

export function validateSourceRevision(input: string): string {
  const revision = input.trim();
  if (!revision || revision.length > 200) {
    throw appError(
      400,
      "workshop_source_revision_invalid",
      "source revision must be between 1 and 200 characters",
    );
  }
  return revision;
}

export function validateContentHash(input: string): string {
  const hash = input.trim().toLowerCase();
  if (!CONTENT_HASH_PATTERN.test(hash)) {
    throw appError(
      400,
      "workshop_content_hash_invalid",
      "content hash must be a lowercase SHA-256 digest",
    );
  }
  return hash;
}

export function validateWorkshopManifest(
  input: unknown,
  options: WorkshopManifestValidationOptions = {},
): WorkshopManifestV2 {
  if (!isWorkshopManifestV2(input)) {
    throw invalidManifest("manifest must match the hydrated schemaVersion 2 contract");
  }
  const manifest = input as unknown as WorkshopManifestV2;
  if (!isRecord(manifest.workshop) || !isRecord(manifest.workspace)) {
    throw invalidManifest("manifest must define workshop and workspace");
  }
  validateWorkshopSlug(String(manifest.workshop.slug ?? ""));
  validateWorkshopTitle(String(manifest.workshop.title ?? ""));
  validateWorkshopSummary(String(manifest.workshop.summary ?? ""));
  if (
    !Number.isInteger(manifest.workshop.defaultLobbyMinutes) ||
    manifest.workshop.defaultLobbyMinutes < 0 ||
    manifest.workshop.defaultLobbyMinutes > 1_440
  ) {
    throw invalidManifest(
      "workshop defaultLobbyMinutes must be between 0 and 1440",
    );
  }

  if (!Array.isArray(manifest.modules) || !manifest.modules.length) {
    throw invalidManifest("manifest must define at least one module");
  }
  if (!Array.isArray(manifest.agenda) || !manifest.agenda.length) {
    throw invalidManifest("manifest must define at least one agenda item");
  }
  if (
    !isRecord(manifest.presentation) ||
    !Array.isArray(manifest.presentation.slides)
  ) {
    throw invalidManifest("manifest must define presentation slides");
  }
  if (
    !Number.isInteger(manifest.durationMinutes) ||
    manifest.durationMinutes <= 0
  ) {
    throw invalidManifest("durationMinutes must be a positive integer");
  }

  const moduleIds = uniqueIds(manifest.modules, "module");
  const checkpointIds = uniqueIds(manifest.workspace.checkpoints, "checkpoint");
  const vmIds = uniqueIds(manifest.workspace.vms, "workspace VM");
  const slideIds = uniqueIds(manifest.presentation.slides, "slide");
  uniqueIds(manifest.workspace.applications, "workspace application", true);
  uniqueIds(manifest.agenda, "agenda item");

  const runtimeProfileIds = uniqueIds(
    manifest.workspace.runtimeProfiles,
    "runtime profile",
  );
  const hasDirectCloud = manifest.workspace.runtimeProfiles.some(
    (profile) => profile.provider !== "agent_kvm",
  );
  const hasAgentKvm = manifest.workspace.runtimeProfiles.some(
    (profile) => profile.provider === "agent_kvm",
  );
  for (const profile of manifest.workspace.runtimeProfiles) {
    const vm = manifest.workspace.vms.find((candidate) => candidate.id === profile.vmId);
    if (!vm || profile.hardware.architecture !== "x86_64") {
      throw invalidManifest(`runtime profile ${profile.id} has an invalid VM or architecture`);
    }
    if (
      profile.hardware.cpuMillis < vm.cpuMillis ||
      profile.hardware.memoryMib < vm.memoryMib ||
      profile.hardware.diskMib < vm.diskMib ||
      profile.hardware.providerCpuCount <= 0
    ) {
      throw invalidManifest(`runtime profile ${profile.id} is undersized`);
    }
    if (profile.provider === "agent_kvm") {
      if (
        profile.machineType !== undefined ||
        profile.rootDiskType !== undefined ||
        profile.locations.length !== 0 ||
        profile.immutableSystemImage !== profile.requestedSystemImage
      ) {
        throw invalidManifest(`agent_kvm profile ${profile.id} contains cloud-only or mutable fields`);
      }
      continue;
    }
    if (
      manifest.workspace.vms.length !== 1 ||
      !profile.machineType ||
      !profile.immutableSystemImage ||
      profile.locations.length === 0
    ) {
      throw invalidManifest(`direct-cloud profile ${profile.id} is incomplete`);
    }
  }
  if (runtimeProfileIds.size !== manifest.workspace.runtimeProfiles.length) {
    throw invalidManifest("runtime profile IDs must be unique");
  }
  const verifiedProviderCheckpointIds =
    options.verifiedProviderCheckpointIds ?? new Set<string>();
  if (verifiedProviderCheckpointIds.size > 0) {
    if (!hasDirectCloud) {
      throw invalidManifest(
        "provider checkpoint verification requires a direct-cloud profile",
      );
    }
    for (const checkpointId of verifiedProviderCheckpointIds) {
      if (!checkpointIds.has(checkpointId)) {
        throw invalidManifest(
          `provider verification references unknown checkpoint ${checkpointId}`,
        );
      }
    }
  }

  if (!checkpointIds.has(manifest.workspace.initialCheckpointId)) {
    throw invalidManifest("initial checkpoint does not exist");
  }
  for (const checkpoint of manifest.workspace.checkpoints) {
    if (!Array.isArray(checkpoint.vmImages)) {
      throw invalidManifest(`checkpoint ${checkpoint.id} has no VM images`);
    }
    if (!hasAgentKvm && hasDirectCloud && checkpoint.vmImages.length === 0) {
      if (!verifiedProviderCheckpointIds.has(checkpoint.id)) {
        throw invalidManifest(
          `checkpoint ${checkpoint.id} has no verified provider artifact`,
        );
      }
      continue;
    }
    if (hasAgentKvm && checkpoint.vmImages.length === 0) {
      throw invalidManifest(`checkpoint ${checkpoint.id} is missing agent_kvm images`);
    }
    const imageVmIds = new Set(checkpoint.vmImages.map((image) => image.vmId));
    for (const vmId of vmIds) {
      if (!imageVmIds.has(vmId)) {
        throw invalidManifest(
          `checkpoint ${checkpoint.id} is missing VM ${vmId}`,
        );
      }
    }
  }
  for (const module of manifest.modules) {
    if (!(["gate", "core", "stretch"] as const).includes(module.tier)) {
      throw invalidManifest(`module ${module.id} has an invalid tier`);
    }
    for (const dependency of module.dependsOn ?? []) {
      if (!moduleIds.has(dependency) || dependency === module.id) {
        throw invalidManifest(`module ${module.id} has an invalid dependency`);
      }
    }
    if (
      module.catchUpCheckpointId &&
      !checkpointIds.has(module.catchUpCheckpointId)
    ) {
      throw invalidManifest(`module ${module.id} has an invalid checkpoint`);
    }
  }
  assertAcyclicModules(manifest.modules);

  for (const application of manifest.workspace.applications) {
    if (!vmIds.has(application.vmId)) {
      throw invalidManifest(`application ${application.id} has an invalid VM`);
    }
    if (
      !Number.isInteger(application.port) ||
      application.port < 1 ||
      application.port > 65_535
    ) {
      throw invalidManifest(
        `application ${application.id} has an invalid port`,
      );
    }
    if (
      application.upstreamHost !== undefined &&
      (typeof application.upstreamHost !== "string" ||
        !isCanonicalWorkspaceAppUpstreamHost(application.upstreamHost))
    ) {
      throw invalidManifest(
        `application ${application.id} has an invalid upstream host`,
      );
    }
    if (
      application.releaseModuleId &&
      !moduleIds.has(application.releaseModuleId)
    ) {
      throw invalidManifest(
        `application ${application.id} has an invalid release module`,
      );
    }
  }

  let durationMinutes = 0;
  for (const item of manifest.agenda) {
    if (!Number.isInteger(item.durationMinutes) || item.durationMinutes < 0) {
      throw invalidManifest(`agenda item ${item.id} has an invalid duration`);
    }
    if (typeof item.scheduled !== "boolean") {
      throw invalidManifest(`agenda item ${item.id} must declare scheduled`);
    }
    if (item.scheduled && item.durationMinutes === 0) {
      throw invalidManifest(
        `scheduled agenda item ${item.id} must have a positive duration`,
      );
    }
    if (item.scheduled) durationMinutes += item.durationMinutes;
    if (item.moduleId && !moduleIds.has(item.moduleId)) {
      throw invalidManifest(`agenda item ${item.id} has an invalid module`);
    }
    for (const slideId of item.slideIds ?? []) {
      if (!slideIds.has(slideId)) {
        throw invalidManifest(`agenda item ${item.id} has an invalid slide`);
      }
    }
  }
  if (durationMinutes !== manifest.durationMinutes) {
    throw invalidManifest(
      "durationMinutes must equal the sum of scheduled agenda item durations",
    );
  }
  return manifest;
}

function isCanonicalWorkspaceAppUpstreamHost(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 253 &&
    !value.endsWith(".") &&
    value.split(".").every((label) => {
      if (!label || label.length > 63) return false;
      const bytes = [...label];
      const validEdge = (character: string) => /[a-z0-9]/.test(character);
      return (
        validEdge(bytes[0] ?? "") &&
        validEdge(bytes.at(-1) ?? "") &&
        bytes.every((character) => /[a-z0-9-]/.test(character))
      );
    })
  );
}

export function validateSessionTitle(input: string): string {
  return validateWorkshopTitle(input);
}

export function validateHelpMessage(input: string): string {
  const message = input.trim();
  if (!message || message.length > 500) {
    throw appError(
      400,
      "workshop_help_message_invalid",
      "help request message must be between 1 and 500 characters",
    );
  }
  return message;
}

function uniqueIds(
  entries: Array<{ id?: string }> | undefined,
  kind: string,
  allowEmpty = false,
): Set<string> {
  if (!Array.isArray(entries) || (!allowEmpty && !entries.length)) {
    throw invalidManifest(`manifest must define at least one ${kind}`);
  }
  const ids = new Set<string>();
  for (const entry of entries) {
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id || ids.has(id)) {
      throw invalidManifest(`${kind} IDs must be non-empty and unique`);
    }
    ids.add(id);
  }
  return ids;
}

function assertAcyclicModules(modules: WorkshopManifestV2["modules"]): void {
  const dependencies = new Map(
    modules.map((module) => [module.id, module.dependsOn ?? []]),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw invalidManifest("module dependencies must not contain a cycle");
    }
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of dependencies.keys()) visit(id);
}

function invalidManifest(message: string) {
  return appError(400, "workshop_manifest_invalid", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
