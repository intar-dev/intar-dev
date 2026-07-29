import type { WorkshopManifestV1 } from "@/db/schema";
import { appError } from "@/lib/app-error";

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;

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

export function validateWorkshopManifest(input: unknown): WorkshopManifestV1 {
  if (!isRecord(input) || input.schemaVersion !== 1) {
    throw invalidManifest("manifest must use schemaVersion 1");
  }
  const manifest = input as unknown as WorkshopManifestV1;
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
  if (!isRecord(manifest.presentation) || !Array.isArray(manifest.presentation.slides)) {
    throw invalidManifest("manifest must define presentation slides");
  }
  if (!Number.isInteger(manifest.durationMinutes) || manifest.durationMinutes <= 0) {
    throw invalidManifest("durationMinutes must be a positive integer");
  }

  const moduleIds = uniqueIds(manifest.modules, "module");
  const checkpointIds = uniqueIds(manifest.workspace.checkpoints, "checkpoint");
  const vmIds = uniqueIds(manifest.workspace.vms, "workspace VM");
  const slideIds = uniqueIds(manifest.presentation.slides, "slide");
  uniqueIds(manifest.workspace.applications, "workspace application", true);
  uniqueIds(manifest.agenda, "agenda item");

  const provider = manifest.workspace.provider;
  if (provider !== undefined) {
    if (
      !isRecord(provider) ||
      provider.kind !== "hetzner_cloud" ||
      typeof provider.vmId !== "string" ||
      !vmIds.has(provider.vmId) ||
      typeof provider.serverType !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(provider.serverType) ||
      typeof provider.systemImage !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(provider.systemImage) ||
      provider.compatible !== true ||
      !isRecord(provider.hardware) ||
      provider.hardware.architecture !== "x86" ||
      !Number.isSafeInteger(provider.hardware.cores) ||
      provider.hardware.cores <= 0 ||
      !Number.isSafeInteger(provider.hardware.memoryMib) ||
      provider.hardware.memoryMib <= 0 ||
      !Number.isSafeInteger(provider.hardware.diskMib) ||
      provider.hardware.diskMib <= 0 ||
      manifest.workspace.vms.length !== 1
    ) {
      throw invalidManifest(
        "Hetzner provider metadata must pin one compatible x86 VM shape",
      );
    }
    const vm = manifest.workspace.vms[0]!;
    if (
      vm.id !== provider.vmId ||
      provider.hardware.cores * 1_000 < vm.cpuMillis ||
      provider.hardware.memoryMib < vm.memoryMib ||
      provider.hardware.diskMib < vm.diskMib
    ) {
      throw invalidManifest(
        "Hetzner provider hardware does not satisfy the workspace requirements",
      );
    }
  }

  if (!checkpointIds.has(manifest.workspace.initialCheckpointId)) {
    throw invalidManifest("initial checkpoint does not exist");
  }
  for (const checkpoint of manifest.workspace.checkpoints) {
    if (!Array.isArray(checkpoint.vmImages)) {
      throw invalidManifest(`checkpoint ${checkpoint.id} has no VM images`);
    }
    const imageVmIds = new Set(checkpoint.vmImages.map((image) => image.vmId));
    for (const vmId of vmIds) {
      if (!imageVmIds.has(vmId)) {
        throw invalidManifest(`checkpoint ${checkpoint.id} is missing VM ${vmId}`);
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
      throw invalidManifest(`application ${application.id} has an invalid port`);
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

function assertAcyclicModules(
  modules: WorkshopManifestV1["modules"],
): void {
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
