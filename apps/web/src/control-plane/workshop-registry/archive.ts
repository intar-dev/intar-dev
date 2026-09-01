import {
  inspectTarArchive,
  readGzipBundleArchive,
  TAR_BLOCK_SIZE,
  tarHeaderPath,
  tarHeaderSize,
} from "@/control-plane/image-registry/bundle";
import {
  isRecord,
  normalizeSha256,
  sha256Hex,
} from "@/control-plane/image-registry/shared";
import type { WorkshopManifestV2 } from "@/db/schema";

const COMPILED_MANIFEST_PATH = "workshop.compiled.json";
const MAX_COMPRESSED_BUNDLE_BYTES = 64 * 1024 * 1024;
export const MAX_COMPILED_MANIFEST_BYTES = 2 * 1024 * 1024;
// Keep this in lockstep with
// `intar_workshop_manifest::WORKSHOP_RUNTIME_TOOL_FORMAT_VERSION`. It changes
// the source-bundle hash without changing the author-facing manifest schema.
export const WORKSHOP_RUNTIME_TOOL_FORMAT_VERSION = 1;
const WORKSHOP_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SOURCE_LAYOUTS = new Set([
  "cover",
  "default",
  "section",
  "statement",
  "break",
  "closing",
]);
const APPLICATION_PROTOCOLS = new Set(["http", "ws"]);
const MODULE_TIERS = new Set(["gate", "core", "stretch"]);
const AGENDA_KINDS = new Set([
  "briefing",
  "lab",
  "demo",
  "break",
  "explain_back",
  "tinker",
  "retro",
]);
const RELEASE_MODES = new Set(["facilitator", "automatic", "pool"]);
const UNSAFE_MARKDOWN =
  /<!--|<\/?[a-z][^>]*>|javascript\s*:|data\s*:\s*text\/html|\bon(?:click|load|error|mouseover)\s*=/i;

export interface ValidatedWorkshopSourceBundle {
  contentHash: string;
  workshopSlug: string;
  compiledManifest: Record<string, unknown>;
  requiredCheckpointIds: string[];
  files: ReadonlyMap<string, Uint8Array>;
}

export interface WorkshopCheckpointBuildReport {
  checkpointId: string;
  coveredModuleIds: string[];
  vmImages: Array<{
    vmId: string;
    imageKey: Record<string, unknown>;
    imageSha256: string;
  }>;
  sanitized: boolean;
  coldBootVerified: boolean;
  runtimeBundleColdBootVerified?: true;
  providerArtifact?: {
    r2Key: string;
    sha256: string;
    sizeBytes: number;
    compression: "none" | "gzip" | "zstd";
    signatureB64: string;
    signingKeyId: string;
    workspaceAgentSha256: string;
    kinoSha256: string;
  };
}

export type ResolvedWorkshopRuntimeProfile =
  WorkshopManifestV2["workspace"]["runtimeProfiles"][number];

export class WorkshopBundleValidationError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "WorkshopBundleValidationError";
  }
}

export async function validateWorkshopSourceBundle(params: {
  payload: ArrayBuffer;
  claimedWorkshopId: string;
  claimedSha256: string;
}): Promise<ValidatedWorkshopSourceBundle> {
  if (
    params.payload.byteLength === 0 ||
    params.payload.byteLength > MAX_COMPRESSED_BUNDLE_BYTES
  ) {
    throw new WorkshopBundleValidationError(
      params.payload.byteLength === 0
        ? "bundle archive is empty"
        : "bundle archive is too large",
      params.payload.byteLength === 0 ? 400 : 413,
    );
  }
  const claimedHash = normalizeSha256(params.claimedSha256);
  if (!claimedHash) {
    throw new WorkshopBundleValidationError(
      "sha256 must be a lowercase SHA-256 digest",
    );
  }
  const actualHash = await sha256Hex(params.payload);
  if (actualHash !== claimedHash) {
    throw new WorkshopBundleValidationError("bundle sha256 does not match");
  }

  const archive = await readGzipBundleArchive(params.payload);
  if (!archive.ok) {
    const body = (await archive.response.json().catch(() => null)) as {
      error?: unknown;
    } | null;
    throw new WorkshopBundleValidationError(
      typeof body?.error === "string" ? body.error : "invalid gzip archive",
      archive.response.status,
    );
  }
  const files = extractTarFiles(archive.bytes);
  const compiledBytes = files.get(COMPILED_MANIFEST_PATH);
  if (!compiledBytes) {
    throw new WorkshopBundleValidationError(
      `bundle archive is missing ${COMPILED_MANIFEST_PATH}`,
    );
  }
  if (compiledBytes.byteLength > MAX_COMPILED_MANIFEST_BYTES) {
    throw new WorkshopBundleValidationError("compiled manifest is too large");
  }
  let compiled: unknown;
  try {
    compiled = JSON.parse(new TextDecoder().decode(compiledBytes));
  } catch {
    throw new WorkshopBundleValidationError(
      "workshop.compiled.json is not valid JSON",
    );
  }
  if (!isRecord(compiled)) {
    throw new WorkshopBundleValidationError(
      "workshop.compiled.json must be an object",
    );
  }
  const validated = validateCompiledManifest(compiled, files);
  if (validated.workshopSlug !== params.claimedWorkshopId) {
    throw new WorkshopBundleValidationError(
      "workshop_id does not match the compiled manifest",
    );
  }
  return {
    contentHash: actualHash,
    workshopSlug: validated.workshopSlug,
    compiledManifest: compiled,
    requiredCheckpointIds: validated.requiredCheckpointIds,
    files,
  };
}

export function hydrateWorkshopManifest(params: {
  source: ValidatedWorkshopSourceBundle;
  checkpoints: WorkshopCheckpointBuildReport[];
  resolvedProfiles?: ResolvedWorkshopRuntimeProfile[];
}): WorkshopManifestV2 {
  return hydrateWorkshopManifestWithMarkdown(params, "canonical");
}

/**
 * Hydrate the exact source representation reported by the trusted builder.
 * This verification-only form is never persisted or served to learners.
 */
export function hydrateRawWorkshopManifest(params: {
  source: ValidatedWorkshopSourceBundle;
  checkpoints: WorkshopCheckpointBuildReport[];
  resolvedProfiles?: ResolvedWorkshopRuntimeProfile[];
}): WorkshopManifestV2 {
  return hydrateWorkshopManifestWithMarkdown(params, "source");
}

function hydrateWorkshopManifestWithMarkdown(
  params: {
    source: ValidatedWorkshopSourceBundle;
    checkpoints: WorkshopCheckpointBuildReport[];
    resolvedProfiles?: ResolvedWorkshopRuntimeProfile[];
  },
  markdownMode: "canonical" | "source",
): WorkshopManifestV2 {
  const sourceManifest = record(
    params.source.compiledManifest.manifest,
    "manifest",
  );
  const workshop = record(sourceManifest.workshop, "manifest.workshop");
  const workspace = record(sourceManifest.workspace, "manifest.workspace");
  const sourceModules = recordArray(sourceManifest.modules, "manifest.modules");
  const sourceAgenda = recordArray(sourceManifest.agenda, "manifest.agenda");
  const presentation = record(
    sourceManifest.presentation,
    "manifest.presentation",
  );
  const sourceSlides = recordArray(
    presentation.slides,
    "manifest.presentation.slides",
  );
  const presentationAssets = new Set(
    stringArray(presentation.assets, "manifest.presentation.assets"),
  );
  const readMarkdown =
    markdownMode === "source"
      ? (path: string) => readUtf8Source(params.source.files, path)
      : (path: string) =>
          hydrateMarkdownSource(params.source.files, path, presentationAssets);

  const modules = sourceModules.map((module) => {
    const id = string(module.id, "module id");
    const participantMarkdown = readMarkdown(
      string(module.content, `module ${id} content`),
    );
    const hintPaths = stringArray(module.hints, `module ${id} hints`);
    const explainBackPrompt =
      typeof module.explain_back === "string" && module.explain_back.trim()
        ? module.explain_back.trim()
        : null;
    return {
      id,
      title: markdownTitle(participantMarkdown, `Module ${id}`),
      tier: string(module.tier, `module ${id} tier`) as
        | "gate"
        | "core"
        | "stretch",
      outcome: string(module.outcome, `module ${id} outcome`),
      dependsOn: stringArray(module.depends_on, `module ${id} depends_on`),
      participantMarkdown,
      facilitatorNotesMarkdown: readMarkdown(
        string(module.facilitator_notes, `module ${id} facilitator_notes`),
      ),
      hints: hintPaths.map((path, index) => {
        const bodyMarkdown = readMarkdown(path);
        return {
          id: `${id}-hint-${String(index + 1).padStart(2, "0")}`,
          title: markdownTitle(bodyMarkdown, `Hint ${index + 1}`),
          bodyMarkdown,
        };
      }),
      solutionMarkdown: readMarkdown(
        string(module.solution, `module ${id} solution`),
      ),
      ...(explainBackPrompt ? { explainBackPrompt } : {}),
      probeIds: stringArray(module.probes, `module ${id} probes`),
      catchUpCheckpointId: string(module.checkpoint, `module ${id} checkpoint`),
    };
  });
  const moduleById = new Map(modules.map((module) => [module.id, module]));

  const moduleBySlide = new Map<string, string>();
  for (const item of sourceAgenda) {
    if (typeof item.module !== "string") continue;
    for (const slideId of stringArray(item.slides, "agenda slides")) {
      moduleBySlide.set(slideId, item.module);
    }
  }
  const slides = sourceSlides.map((slide) => {
    const id = string(slide.id, "slide id");
    const bodyMarkdown = readMarkdown(
      string(slide.content, `slide ${id} content`),
    );
    const notesMarkdown = readMarkdown(
      string(slide.presenter_notes, `slide ${id} presenter_notes`),
    );
    const moduleId = moduleBySlide.get(id);
    return {
      id,
      layout: hydratedSlideLayout(string(slide.layout, `slide ${id} layout`)),
      title: markdownTitle(bodyMarkdown, id),
      bodyMarkdown,
      ...(notesMarkdown.trim() ? { notesMarkdown } : {}),
      ...(moduleId ? { moduleId } : {}),
    };
  });

  const agenda = sourceAgenda.map((item) => {
    const id = string(item.id, "agenda id");
    const moduleId =
      typeof item.module === "string" ? item.module.trim() : undefined;
    const kind = string(item.kind, `agenda ${id} kind`) as
      | "briefing"
      | "lab"
      | "demo"
      | "break"
      | "explain_back"
      | "tinker"
      | "retro";
    return {
      id,
      kind,
      title:
        (moduleId ? moduleById.get(moduleId)?.title : undefined) ??
        agendaTitle(kind),
      durationMinutes: nonNegativeInteger(
        item.duration_minutes,
        `agenda ${id} duration_minutes`,
      ),
      scheduled: item.scheduled !== false,
      ...(moduleId ? { moduleId } : {}),
      slideIds: stringArray(item.slides, `agenda ${id} slides`),
      release: string(item.release, `agenda ${id} release`) as
        | "facilitator"
        | "automatic"
        | "pool",
    };
  });

  const attribution = string(
    workshop.attribution,
    "manifest.workshop.attribution",
  );
  const attributionUrl = attribution.match(/https?:\/\/\S+/)?.[0] ?? "";
  const license =
    attribution.match(/\b(?:Apache|MIT|BSD|GPL|MPL)[-\w.]+\b/i)?.[0] ??
    "See bundled LICENSE";
  const sourceVms = recordArray(workspace.vms, "manifest.workspace.vms");

  return {
    schemaVersion: 2,
    workshop: {
      slug: params.source.workshopSlug,
      title: string(workshop.title, "manifest.workshop.title"),
      summary: string(workshop.summary, "manifest.workshop.summary"),
      prerequisites: stringArray(
        workshop.prerequisites,
        "manifest.workshop.prerequisites",
      ),
      defaultLobbyMinutes: workshopLobbyMinutes(
        workshop.default_lobby_minutes,
        "manifest.workshop.default_lobby_minutes",
      ),
      attribution: {
        title: attribution,
        url: attributionUrl,
        license,
      },
    },
    workspace: {
      leaseGraceMinutes: positiveInteger(
        workspace.lease_grace_minutes,
        "manifest.workspace.lease_grace_minutes",
      ),
      vms: sourceVms.map((vm) => ({
        id: string(vm.id, "workspace VM id"),
        name: string(vm.id, "workspace VM id"),
        cpuMillis: positiveInteger(vm.cpu_millis, "workspace VM cpu_millis"),
        memoryMib: positiveInteger(vm.memory_mib, "workspace VM memory_mib"),
        diskMib: positiveInteger(vm.disk_mib, "workspace VM disk_mib"),
      })),
      runtimeProfiles: params.resolvedProfiles ?? [],
      checkpoints: params.checkpoints.map((checkpoint) => ({
        id: checkpoint.checkpointId,
        label: checkpoint.checkpointId,
        vmImages:
          checkpoint.vmImages as WorkshopManifestV2["workspace"]["checkpoints"][number]["vmImages"],
      })),
      initialCheckpointId: string(
        workspace.initial_checkpoint,
        "manifest.workspace.initial_checkpoint",
      ),
      applications: recordArray(
        workspace.applications,
        "manifest.workspace.applications",
        true,
      ).map((application) => ({
        id: string(application.id, "application id"),
        label: string(application.label, "application label"),
        vmId: string(application.vm, "application vm"),
        port: positiveInteger(application.port, "application port"),
        protocol: string(application.protocol, "application protocol") as
          | "http"
          | "ws",
        ...(application.upstream_host === undefined
          ? {}
          : {
              upstreamHost: string(
                application.upstream_host,
                "application upstream_host",
              ),
            }),
        releaseModuleId: string(
          application.release_module,
          "application release_module",
        ),
      })),
    },
    modules,
    agenda,
    presentation: { slides },
    durationMinutes: positiveInteger(
      params.source.compiledManifest.scheduled_duration_minutes,
      "scheduled_duration_minutes",
    ),
  };
}

export function extractTarFiles(bytes: Uint8Array): Map<string, Uint8Array> {
  const inspection = inspectTarArchive(bytes);
  if (!inspection.ok) {
    throw new WorkshopBundleValidationError(inspection.error);
  }
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  let zeroBlocks = 0;
  while (offset + TAR_BLOCK_SIZE <= bytes.length && zeroBlocks < 2) {
    const header = bytes.subarray(offset, offset + TAR_BLOCK_SIZE);
    offset += TAR_BLOCK_SIZE;
    if (header.every((byte) => byte === 0)) {
      zeroBlocks += 1;
      continue;
    }
    zeroBlocks = 0;
    const path = tarHeaderPath(header);
    const size = tarHeaderSize(header);
    if (!path || size === null) {
      throw new WorkshopBundleValidationError(
        "bundle archive contains an invalid header",
      );
    }
    const paddedSize = Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    const typeflag = String.fromCharCode(header[156] ?? 0);
    if (typeflag === "\0" || typeflag === "0") {
      files.set(path, bytes.slice(offset, offset + size));
    }
    offset += paddedSize;
  }
  return files;
}

function validateCompiledManifest(
  compiled: Record<string, unknown>,
  files: ReadonlyMap<string, Uint8Array>,
): { workshopSlug: string; requiredCheckpointIds: string[] } {
  if (compiled.format_version !== 2) {
    throw invalid("unsupported workshop bundle format_version");
  }
  if (
    compiled.runtime_tool_format_version !==
    WORKSHOP_RUNTIME_TOOL_FORMAT_VERSION
  ) {
    throw invalid("unsupported workshop runtime_tool_format_version");
  }
  const scheduledDuration = positiveInteger(
    compiled.scheduled_duration_minutes,
    "scheduled_duration_minutes",
  );
  const manifest = record(compiled.manifest, "manifest");
  if (manifest.format_version !== 2) {
    throw invalid("manifest must use format_version 2");
  }
  const workshop = record(manifest.workshop, "manifest.workshop");
  const workshopSlug = string(workshop.id, "manifest.workshop.id");
  if (!WORKSHOP_SLUG.test(workshopSlug) || workshopSlug.length > 80) {
    throw invalid("manifest.workshop.id must be lowercase kebab-case");
  }
  string(workshop.title, "manifest.workshop.title");
  string(workshop.summary, "manifest.workshop.summary");
  string(workshop.attribution, "manifest.workshop.attribution");
  stringArray(workshop.prerequisites, "manifest.workshop.prerequisites");
  workshopLobbyMinutes(
    workshop.default_lobby_minutes,
    "manifest.workshop.default_lobby_minutes",
  );
  requireFile(files, "workshop.hcl");

  const workspace = record(manifest.workspace, "manifest.workspace");
  positiveInteger(
    workspace.lease_grace_minutes,
    "manifest.workspace.lease_grace_minutes",
  );
  const initialCheckpoint = string(
    workspace.initial_checkpoint,
    "manifest.workspace.initial_checkpoint",
  );
  const vms = recordArray(workspace.vms, "manifest.workspace.vms");
  const vmIds = uniqueStrings(
    vms.map((vm) => string(vm.id, "workspace VM id")),
    "workspace VM id",
  );
  for (const vm of vms) {
    positiveInteger(vm.cpu_millis, "workspace VM cpu_millis");
    positiveInteger(vm.memory_mib, "workspace VM memory_mib");
    positiveInteger(vm.disk_mib, "workspace VM disk_mib");
  }
  validateRuntimeProfileDeclarations(workspace.runtime_profiles, vmIds, vms.length);

  const modules = recordArray(manifest.modules, "manifest.modules");
  const moduleIds = uniqueStrings(
    modules.map((module) => string(module.id, "module id")),
    "module id",
  );
  const moduleDependencies = new Map<string, string[]>();
  const checkpointIds = new Set<string>();
  const probeIds = new Set<string>();
  const markdownPaths = new Set<string>();
  for (const module of modules) {
    const id = string(module.id, "module id");
    const tier = string(module.tier, `module ${id} tier`);
    if (!MODULE_TIERS.has(tier)) {
      throw invalid(`module ${id} has an invalid tier`);
    }
    string(module.outcome, `module ${id} outcome`);
    const dependencies = stringArray(
      module.depends_on,
      `module ${id} depends_on`,
    );
    for (const dependency of dependencies) {
      if (!moduleIds.has(dependency) || dependency === id) {
        throw invalid(`module ${id} has an invalid dependency`);
      }
    }
    moduleDependencies.set(id, dependencies);
    const sourcePaths = [
      string(module.content, `module ${id} content`),
      string(module.facilitator_notes, `module ${id} facilitator_notes`),
      string(module.solution, `module ${id} solution`),
      ...stringArray(module.hints, `module ${id} hints`),
    ];
    for (const path of sourcePaths) {
      requireFile(files, path);
      markdownPaths.add(path);
    }
    requireFile(
      files,
      string(module.verify_script, `module ${id} verify_script`),
    );
    requireFile(
      files,
      string(module.catch_up_script, `module ${id} catch_up_script`),
    );
    const checkpoint = string(module.checkpoint, `module ${id} checkpoint`);
    if (checkpointIds.has(checkpoint)) {
      throw invalid(`checkpoint ${checkpoint} is published more than once`);
    }
    checkpointIds.add(checkpoint);
    const probes = stringArray(module.probes, `module ${id} probes`);
    if (!probes.length) throw invalid(`module ${id} must define probes`);
    for (const probe of probes) {
      if (probeIds.has(probe)) throw invalid(`probe ${probe} is duplicated`);
      probeIds.add(probe);
    }
    if (typeof module.explain_back !== "string") {
      throw invalid(`module ${id} explain_back must be a string`);
    }
  }
  assertAcyclic(moduleDependencies);
  if (!checkpointIds.has(initialCheckpoint)) {
    throw invalid("initial checkpoint must be published by a module");
  }

  const applications = recordArray(
    workspace.applications,
    "manifest.workspace.applications",
    true,
  );
  const applicationIds = new Set<string>();
  const applicationPorts = new Set<string>();
  for (const application of applications) {
    const id = string(application.id, "application id");
    if (applicationIds.has(id))
      throw invalid(`application ${id} is duplicated`);
    applicationIds.add(id);
    string(application.label, `application ${id} label`);
    const vm = string(application.vm, `application ${id} vm`);
    if (!vmIds.has(vm))
      throw invalid(`application ${id} references an unknown VM`);
    const port = positiveInteger(application.port, `application ${id} port`);
    if (port > 65_535) throw invalid(`application ${id} has an invalid port`);
    const portKey = `${vm}:${port}`;
    if (applicationPorts.has(portKey)) {
      throw invalid(`workspace applications collide on ${portKey}`);
    }
    applicationPorts.add(portKey);
    const protocol = string(application.protocol, `application ${id} protocol`);
    if (!APPLICATION_PROTOCOLS.has(protocol)) {
      throw invalid(`application ${id} has an invalid protocol`);
    }
    if (
      application.upstream_host !== undefined &&
      (typeof application.upstream_host !== "string" ||
        !isCanonicalWorkspaceAppUpstreamHost(application.upstream_host))
    ) {
      throw invalid(`application ${id} has an invalid upstream host`);
    }
    const releaseModule = string(
      application.release_module,
      `application ${id} release_module`,
    );
    if (!moduleIds.has(releaseModule)) {
      throw invalid(`application ${id} has an invalid release module`);
    }
  }

  const presentation = record(manifest.presentation, "manifest.presentation");
  const slides = recordArray(
    presentation.slides,
    "manifest.presentation.slides",
  );
  const slideIds = uniqueStrings(
    slides.map((slide) => string(slide.id, "slide id")),
    "slide id",
  );
  for (const slide of slides) {
    const id = string(slide.id, "slide id");
    const layout = string(slide.layout, `slide ${id} layout`);
    if (!SOURCE_LAYOUTS.has(layout)) {
      throw invalid(`slide ${id} has an unsupported layout`);
    }
    const contentPath = string(slide.content, `slide ${id} content`);
    const notesPath = string(
      slide.presenter_notes,
      `slide ${id} presenter_notes`,
    );
    requireFile(files, contentPath);
    requireFile(files, notesPath);
    markdownPaths.add(contentPath);
    markdownPaths.add(notesPath);
  }
  const presentationAssetPaths = stringArray(
    presentation.assets,
    "manifest.presentation.assets",
  );
  const presentationAssetSet = new Set(presentationAssetPaths);
  for (const asset of presentationAssetPaths) {
    requireFile(files, asset);
  }

  const agenda = recordArray(manifest.agenda, "manifest.agenda");
  const agendaIds = new Set<string>();
  let derivedDuration = 0;
  for (const item of agenda) {
    const id = string(item.id, "agenda id");
    if (agendaIds.has(id)) throw invalid(`agenda item ${id} is duplicated`);
    agendaIds.add(id);
    const kind = string(item.kind, `agenda item ${id} kind`);
    if (!AGENDA_KINDS.has(kind)) {
      throw invalid(`agenda item ${id} has an invalid kind`);
    }
    const duration = nonNegativeInteger(
      item.duration_minutes,
      `agenda item ${id} duration_minutes`,
    );
    if (item.scheduled === true) {
      if (duration === 0) {
        throw invalid(
          `scheduled agenda item ${id} duration_minutes must be positive`,
        );
      }
      derivedDuration += duration;
    } else if (item.scheduled !== false) {
      throw invalid(`agenda item ${id} scheduled must be boolean`);
    }
    if (item.module !== undefined && item.module !== null) {
      const moduleId = string(item.module, `agenda item ${id} module`);
      if (!moduleIds.has(moduleId)) {
        throw invalid(`agenda item ${id} references an unknown module`);
      }
    }
    for (const slideId of stringArray(
      item.slides,
      `agenda item ${id} slides`,
    )) {
      if (!slideIds.has(slideId)) {
        throw invalid(`agenda item ${id} references an unknown slide`);
      }
    }
    const release = string(item.release, `agenda item ${id} release`);
    if (!RELEASE_MODES.has(release)) {
      throw invalid(`agenda item ${id} has an invalid release mode`);
    }
  }
  if (derivedDuration !== scheduledDuration) {
    throw invalid(
      "scheduled_duration_minutes must equal the scheduled agenda duration",
    );
  }

  for (const path of markdownPaths) {
    const bytes = files.get(path);
    if (!bytes) continue;
    const rawSource = new TextDecoder().decode(bytes);
    const source = markdownOutsideCode(rawSource);
    if (UNSAFE_MARKDOWN.test(source)) {
      throw invalid(
        `Markdown source ${path} contains unsafe HTML or JavaScript`,
      );
    }
    validateWorkshopMarkdownAssets(rawSource, path, presentationAssetSet);
    renderMermaidFences(rawSource, path);
  }
  return {
    workshopSlug,
    requiredCheckpointIds: [...checkpointIds].sort(),
  };
}

function validateRuntimeProfileDeclarations(
  value: unknown,
  vmIds: ReadonlySet<string>,
  vmCount: number,
): void {
  const profiles = recordArray(value, "manifest.workspace.runtime_profiles");
  const profileIds = new Set<string>();
  for (const profile of profiles) {
    const id = string(profile.id, "runtime profile id");
    if (profileIds.has(id)) throw invalid(`runtime profile ${id} is duplicated`);
    profileIds.add(id);
    const provider = string(profile.provider, `runtime profile ${id} provider`);
    if (
      provider !== "agent_kvm" &&
      provider !== "hetzner_cloud" &&
      provider !== "gcp_compute"
    ) {
      throw invalid(`runtime profile ${id} has an unsupported provider`);
    }
    const vmId = string(profile.vm_id, `runtime profile ${id} vm_id`);
    if (!vmIds.has(vmId)) {
      throw invalid(`runtime profile ${id} references an unknown VM`);
    }
    string(profile.system_image, `runtime profile ${id} system_image`);
    const machineType =
      profile.machine_type == null
        ? null
        : string(profile.machine_type, `runtime profile ${id} machine_type`);
    const rootDiskType =
      profile.root_disk_type == null
        ? null
        : string(profile.root_disk_type, `runtime profile ${id} root_disk_type`);
    const locations =
      profile.locations == null
        ? []
        : stringArray(profile.locations, `runtime profile ${id} locations`);
    if (provider === "agent_kvm") {
      if (machineType || rootDiskType || locations.length > 0) {
        throw invalid(`agent_kvm runtime profile ${id} contains cloud-only fields`);
      }
      continue;
    }
    if (vmCount !== 1 || !machineType) {
      throw invalid(`direct-cloud runtime profile ${id} requires one VM and a machine_type`);
    }
    if (provider === "gcp_compute" && rootDiskType !== "pd-balanced") {
      throw invalid(`GCP runtime profile ${id} must use pd-balanced`);
    }
    if (provider === "hetzner_cloud" && rootDiskType !== null) {
      throw invalid(`Hetzner runtime profile ${id} cannot define root_disk_type`);
    }
  }
}

function assertAcyclic(dependencies: ReadonlyMap<string, string[]>): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw invalid("module dependencies contain a cycle");
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of dependencies.keys()) visit(id);
}

function requireFile(
  files: ReadonlyMap<string, Uint8Array>,
  path: string,
): void {
  if (!files.has(path)) {
    throw invalid(`bundle archive is missing ${path}`);
  }
}

function uniqueStrings(values: string[], label: string): Set<string> {
  const result = new Set<string>();
  for (const value of values) {
    if (result.has(value)) throw invalid(`${label}s must be unique`);
    result.add(value);
  }
  if (!result.size) throw invalid(`at least one ${label} is required`);
  return result;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalid(`${label} must be an object`);
  return value;
}

function recordArray(
  value: unknown,
  label: string,
  allowEmpty = false,
): Record<string, unknown>[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw invalid(
      `${label} must be ${allowEmpty ? "an" : "a non-empty"} array`,
    );
  }
  return value.map((entry, index) => record(entry, `${label}[${index}]`));
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw invalid(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw invalid(`${label} must be an array`);
  return value.map((entry, index) => string(entry, `${label}[${index}]`));
}

function isCanonicalWorkspaceAppUpstreamHost(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 253 &&
    !value.endsWith(".") &&
    value.split(".").every((label) => {
      if (!label || label.length > 63) return false;
      const characters = [...label];
      const validEdge = (character: string) => /[a-z0-9]/.test(character);
      return (
        validEdge(characters[0] ?? "") &&
        validEdge(characters.at(-1) ?? "") &&
        characters.every((character) => /[a-z0-9-]/.test(character))
      );
    })
  );
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw invalid(`${label} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalid(`${label} must be a non-negative integer`);
  }
  return value;
}

function workshopLobbyMinutes(value: unknown, label: string): number {
  const minutes = nonNegativeInteger(value, label);
  if (minutes > 1_440) {
    throw invalid(`${label} must be between 0 and 1440`);
  }
  return minutes;
}

function readUtf8Source(
  files: ReadonlyMap<string, Uint8Array>,
  path: string,
): string {
  const bytes = files.get(path);
  if (!bytes) throw invalid(`bundle archive is missing ${path}`);
  return new TextDecoder().decode(bytes);
}

function hydrateMarkdownSource(
  files: ReadonlyMap<string, Uint8Array>,
  path: string,
  presentationAssets: ReadonlySet<string>,
): string {
  const source = readUtf8Source(files, path);
  return renderMermaidFences(
    rewriteWorkshopMarkdownAssets(source, path, presentationAssets),
    path,
  );
}

function validateWorkshopMarkdownAssets(
  source: string,
  sourcePath: string,
  presentationAssets: ReadonlySet<string>,
): void {
  rewriteWorkshopMarkdownAssets(source, sourcePath, presentationAssets);
}

function rewriteWorkshopMarkdownAssets(
  source: string,
  sourcePath: string,
  presentationAssets: ReadonlySet<string>,
): string {
  return mapMarkdownOutsideFences(source, (line) => {
    const visible = line.replaceAll(/`[^`]*`/g, "");
    if (
      /!\[[^\]]*\]\s*\[[^\]]*\]/.test(visible) ||
      /!\[[^\]]*\](?!\s*[[(])/.test(visible)
    ) {
      throw invalid(
        `Markdown source ${sourcePath} contains a reference-style image; workshop images must use bundled inline targets`,
      );
    }
    return line.replace(
      /!\[([^\]]*)\]\(([^)\s]+)([^)]*)\)/g,
      (_match, alt: string, rawTarget: string, suffix: string) => {
        const wrapped = rawTarget.startsWith("<") && rawTarget.endsWith(">");
        const target = wrapped ? rawTarget.slice(1, -1) : rawTarget;
        if (/^https?:\/\//i.test(target)) {
          throw invalid(
            `Markdown source ${sourcePath} contains a remote image URL; workshop images must be bundled`,
          );
        }
        if (/^(?:data|javascript):/i.test(target)) {
          throw invalid(
            `Markdown source ${sourcePath} contains an embedded or unsafe image URL`,
          );
        }
        const resolved = resolveWorkshopSourceReference(sourcePath, target);
        if (!resolved || !presentationAssets.has(resolved)) {
          throw invalid(
            `Markdown source ${sourcePath} references undeclared presentation asset ${target}`,
          );
        }
        const encoded = resolved
          .split("/")
          .map((segment) => encodeURIComponent(segment))
          .join("/");
        return `![${alt}](/_intar/workshop-assets/${encoded}${suffix})`;
      },
    );
  });
}

function resolveWorkshopSourceReference(
  sourcePath: string,
  reference: string,
): string | null {
  if (!reference || reference.startsWith("/") || reference.includes("\\")) {
    return null;
  }
  const pathOnly = reference.split(/[?#]/, 1)[0] ?? "";
  const parts = sourcePath.split("/");
  parts.pop();
  for (const part of pathOnly.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

function mapMarkdownOutsideFences(
  source: string,
  transform: (line: string) => string,
): string {
  let fence: "```" | "~~~" | null = null;
  return source
    .split("\n")
    .map((line) => {
      const marker = line.match(/^\s*(```|~~~)/)?.[1] as
        | "```"
        | "~~~"
        | undefined;
      if (marker) {
        if (fence === marker) fence = null;
        else if (!fence) fence = marker;
        return line;
      }
      return fence ? line : transform(line);
    })
    .join("\n");
}

function renderMermaidFences(source: string, context: string): string {
  const lines = source.split("\n");
  const output: string[] = [];
  let diagram: string[] | null = null;
  let diagramIndex = 0;
  let ordinaryFence: "```" | "~~~" | null = null;
  for (const line of lines) {
    if (diagram) {
      if (/^\s*```\s*$/.test(line)) {
        diagramIndex += 1;
        output.push(
          renderMermaidFlowchart(diagram.join("\n"), context, diagramIndex),
        );
        diagram = null;
      } else {
        diagram.push(line);
      }
      continue;
    }
    if (!ordinaryFence && /^\s*```mermaid\s*$/.test(line)) {
      diagram = [];
      continue;
    }
    if (!ordinaryFence && /^\s*```mermaid\b/.test(line)) {
      throw invalid(
        `Markdown source ${context} uses unsupported Mermaid fence attributes`,
      );
    }
    const marker = line.match(/^\s*(```|~~~)/)?.[1] as
      | "```"
      | "~~~"
      | undefined;
    if (marker) {
      if (ordinaryFence === marker) ordinaryFence = null;
      else if (!ordinaryFence) ordinaryFence = marker;
    }
    output.push(line);
  }
  if (diagram) {
    throw invalid(
      `Markdown source ${context} has an unterminated Mermaid block`,
    );
  }
  return output.join("\n");
}

type MermaidNode = { id: string; label: string };
type MermaidEdge = {
  from: string;
  to: string;
  label: string | null;
  dotted: boolean;
};

function renderMermaidFlowchart(
  raw: string,
  context: string,
  index: number,
): string {
  const normalized = collapseQuotedMermaidLines(raw);
  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const header = lines.shift()?.match(/^flowchart\s+(LR|TD)$/);
  if (!header) {
    throw invalid(
      `Markdown source ${context} Mermaid blocks must use flowchart LR or flowchart TD`,
    );
  }
  const direction = header[1]!.toUpperCase() as "LR" | "TD";
  const nodes = new Map<string, MermaidNode>();
  const edges: MermaidEdge[] = [];
  for (const line of lines) {
    parseMermaidFlowLine(line, nodes, edges, context);
  }
  if (nodes.size < 2 || edges.length === 0) {
    throw invalid(
      `Markdown source ${context} contains an empty Mermaid flowchart`,
    );
  }
  if (nodes.size > 32 || edges.length > 64) {
    throw invalid(`Markdown source ${context} Mermaid flowchart is too large`);
  }
  const svg = flowchartSvg([...nodes.values()], edges, direction);
  return `![Rendered flowchart ${index}](data:image/svg+xml;base64,${base64Utf8(svg)})`;
}

function collapseQuotedMermaidLines(source: string): string {
  let quoted = false;
  let result = "";
  for (const character of source) {
    if (character === '"') quoted = !quoted;
    if (character === "\n" && quoted) result += "\\n";
    else result += character;
  }
  if (quoted) throw invalid("Mermaid flowchart contains an unterminated label");
  return result;
}

function parseMermaidFlowLine(
  line: string,
  nodes: Map<string, MermaidNode>,
  edges: MermaidEdge[],
  context: string,
): void {
  let cursor = 0;
  let current = readMermaidNode(line, cursor, context);
  cursor = current.cursor;
  rememberMermaidNode(nodes, current.node, context);
  let edgeCount = 0;
  while (cursor < line.length) {
    const rest = line.slice(cursor);
    const connector = rest.match(/^\s*(-->|-\.->)\s*(?:\|"([^"]*)"\|\s*)?/);
    if (!connector) {
      throw invalid(
        `Markdown source ${context} has unsupported Mermaid statement: ${line}`,
      );
    }
    cursor += connector[0].length;
    const next = readMermaidNode(line, cursor, context);
    cursor = next.cursor;
    rememberMermaidNode(nodes, next.node, context);
    edges.push({
      from: current.node.id,
      to: next.node.id,
      label: connector[2]?.replaceAll("\\n", " ") ?? null,
      dotted: connector[1] === "-.->",
    });
    current = next;
    edgeCount += 1;
  }
  if (!edgeCount) {
    throw invalid(
      `Markdown source ${context} has a Mermaid node without an edge`,
    );
  }
}

function readMermaidNode(
  line: string,
  cursor: number,
  context: string,
): { node: MermaidNode; cursor: number } {
  const match = line
    .slice(cursor)
    .match(/^\s*([A-Za-z][A-Za-z0-9_-]*)(?:\["([^"]*)"\])?/);
  if (!match) {
    throw invalid(`Markdown source ${context} has an invalid Mermaid node`);
  }
  return {
    node: {
      id: match[1]!,
      label: (match[2] ?? match[1]!).replaceAll("\\n", "\n"),
    },
    cursor: cursor + match[0].length,
  };
}

function rememberMermaidNode(
  nodes: Map<string, MermaidNode>,
  node: MermaidNode,
  context: string,
): void {
  const existing = nodes.get(node.id);
  if (
    existing &&
    existing.label !== existing.id &&
    node.label !== node.id &&
    existing.label !== node.label
  ) {
    throw invalid(
      `Markdown source ${context} redefines Mermaid node ${node.id}`,
    );
  }
  if (!existing || existing.label === existing.id) nodes.set(node.id, node);
}

function flowchartSvg(
  nodes: MermaidNode[],
  edges: MermaidEdge[],
  direction: "LR" | "TD",
): string {
  const horizontal = direction === "LR";
  const width = horizontal ? Math.max(640, nodes.length * 190 + 80) : 760;
  const height = horizontal ? 260 : Math.max(300, nodes.length * 120 + 80);
  const positions = new Map(
    nodes.map((node, ordinal) => [
      node.id,
      horizontal
        ? { x: 60 + ordinal * 190, y: 95, width: 150, height: 70 }
        : { x: 305, y: 45 + ordinal * 120, width: 150, height: 70 },
    ]),
  );
  const edgeSvg = edges
    .map((edge) => {
      const from = positions.get(edge.from)!;
      const to = positions.get(edge.to)!;
      const x1 = horizontal ? from.x + from.width : from.x + from.width / 2;
      const y1 = horizontal ? from.y + from.height / 2 : from.y + from.height;
      const x2 = horizontal ? to.x : to.x + to.width / 2;
      const y2 = horizontal ? to.y + to.height / 2 : to.y;
      const label = edge.label
        ? `<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 9}" text-anchor="middle" class="edge-label">${escapeXml(edge.label)}</text>`
        : "";
      return `<path d="M ${x1} ${y1} L ${x2} ${y2}" class="edge${edge.dotted ? " dotted" : ""}" marker-end="url(#arrow)"/>${label}`;
    })
    .join("");
  const nodeSvg = nodes
    .map((node) => {
      const position = positions.get(node.id)!;
      const lines = wrapMermaidLabel(node.label);
      const text = lines
        .map(
          (line, lineIndex) =>
            `<tspan x="${position.x + position.width / 2}" dy="${lineIndex === 0 ? 0 : 17}">${escapeXml(line)}</tspan>`,
        )
        .join("");
      const textY =
        position.y + position.height / 2 - ((lines.length - 1) * 17) / 2 + 5;
      return `<rect x="${position.x}" y="${position.y}" width="${position.width}" height="${position.height}" rx="9" class="node"/><text x="${position.x + position.width / 2}" y="${textY}" text-anchor="middle" class="node-label">${text}</text>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Flowchart" viewBox="0 0 ${width} ${height}"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#d97745"/></marker><style>.node{fill:#181713;stroke:#8a8174;stroke-width:1.5}.node-label{fill:#f7f1e7;font:600 13px ui-monospace,monospace}.edge{fill:none;stroke:#d97745;stroke-width:2}.edge.dotted{stroke-dasharray:6 5}.edge-label{fill:#181713;font:600 11px ui-monospace,monospace;paint-order:stroke;stroke:#f7f1e7;stroke-width:4px;stroke-linejoin:round}</style></defs>${edgeSvg}${nodeSvg}</svg>`;
}

function wrapMermaidLabel(label: string): string[] {
  const result: string[] = [];
  for (const explicit of label.split("\n")) {
    const words = explicit.trim().split(/\s+/);
    let line = "";
    for (const word of words) {
      if (line && `${line} ${word}`.length > 22) {
        result.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) result.push(line);
  }
  return result.slice(0, 4);
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return btoa(binary);
}

function markdownTitle(markdown: string, fallback: string): string {
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^#{1,3}\s+(.+?)\s*#*$/);
    if (match?.[1]) return match[1].trim().slice(0, 120);
  }
  return fallback;
}

function hydratedSlideLayout(
  source: string,
): "title" | "content" | "two_column" | "image" | "quote" {
  switch (source) {
    case "cover":
    case "section":
    case "break":
    case "closing":
      return "title";
    case "statement":
      return "quote";
    default:
      return "content";
  }
}

function agendaTitle(kind: string): string {
  switch (kind) {
    case "briefing":
      return "Briefing";
    case "break":
      return "Break";
    case "explain_back":
      return "Explain back";
    case "tinker":
      return "Tinker";
    case "retro":
      return "Closing reflection";
    case "demo":
      return "Demo";
    default:
      return "Scenario";
  }
}

function markdownOutsideCode(markdown: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const marker = line.match(/^\s*(```+|~~~+)/)?.[1] ?? null;
    if (marker) {
      if (!fence) fence = marker[0] ?? "`";
      else if (marker[0] === fence) fence = null;
      continue;
    }
    if (!fence) kept.push(line.replaceAll(/`[^`]*`/g, ""));
  }
  return kept.join("\n");
}

function invalid(message: string): WorkshopBundleValidationError {
  return new WorkshopBundleValidationError(message);
}
