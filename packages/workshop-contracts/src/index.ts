export const RUNTIME_PROVIDER_KINDS = [
  "agent_kvm",
  "hetzner_cloud",
  "gcp_compute",
] as const;

export type RuntimeProviderKind = (typeof RUNTIME_PROVIDER_KINDS)[number];

export type WorkshopModuleTier = "gate" | "core" | "stretch";
export type WorkshopApplicationProtocol = "http" | "ws";
export type WorkshopAgendaKind =
  | "briefing"
  | "lab"
  | "demo"
  | "break"
  | "explain_back"
  | "tinker"
  | "retro";
export type WorkshopAgendaRelease = "facilitator" | "automatic" | "pool";
export type WorkshopSlideLayout =
  | "title"
  | "content"
  | "two_column"
  | "image"
  | "quote";

export interface HydratedRuntimeHardware {
  architecture: "x86_64";
  cpuMillis: number;
  providerCpuCount: number;
  memoryMib: number;
  diskMib: number;
}

interface HydratedRuntimeProfileBase {
  id: string;
  vmId: string;
  requestedSystemImage: string;
  immutableSystemImage: string;
  locations: string[];
  hardware: HydratedRuntimeHardware;
}

export interface HydratedAgentKvmRuntimeProfile extends HydratedRuntimeProfileBase {
  provider: "agent_kvm";
  machineType?: never;
  rootDiskType?: never;
}

export interface HydratedHetznerRuntimeProfile extends HydratedRuntimeProfileBase {
  provider: "hetzner_cloud";
  machineType: string;
  rootDiskType?: never;
}

export interface HydratedGcpRuntimeProfile extends HydratedRuntimeProfileBase {
  provider: "gcp_compute";
  machineType: string;
  rootDiskType: "pd-balanced";
}

export type HydratedWorkshopRuntimeProfile =
  | HydratedAgentKvmRuntimeProfile
  | HydratedHetznerRuntimeProfile
  | HydratedGcpRuntimeProfile;

/**
 * The hydrated, immutable manifest emitted by `intar-workshop-builder`.
 *
 * This is the JSON boundary shared by the builder, registry, database and web
 * application. Authored HCL is deliberately not represented here.
 */
export interface WorkshopManifestV2 {
  schemaVersion: 2;
  workshop: {
    slug: string;
    title: string;
    summary: string;
    prerequisites: string[];
    attribution: {
      title: string;
      url: string;
      license: string;
    };
    defaultLobbyMinutes: number;
  };
  workspace: {
    leaseGraceMinutes: number;
    vms: Array<{
      id: string;
      name: string;
      cpuMillis: number;
      memoryMib: number;
      diskMib: number;
    }>;
    runtimeProfiles: HydratedWorkshopRuntimeProfile[];
    checkpoints: Array<{
      id: string;
      label: string;
      vmImages: Array<{
        vmId: string;
        imageKey: {
          scenario: string;
          vm: string;
          arch: "x86_64" | "aarch64";
        };
        imageSha256: string;
      }>;
    }>;
    initialCheckpointId: string;
    applications: Array<{
      id: string;
      label: string;
      vmId: string;
      port: number;
      protocol: WorkshopApplicationProtocol;
      upstreamHost?: string;
      releaseModuleId: string;
    }>;
  };
  modules: Array<{
    id: string;
    title: string;
    tier: WorkshopModuleTier;
    outcome: string;
    dependsOn: string[];
    participantMarkdown: string;
    facilitatorNotesMarkdown: string;
    hints: Array<{
      id: string;
      title: string;
      bodyMarkdown: string;
    }>;
    solutionMarkdown: string;
    explainBackPrompt?: string;
    probeIds: string[];
    catchUpCheckpointId: string;
  }>;
  agenda: Array<{
    id: string;
    kind: WorkshopAgendaKind;
    title: string;
    durationMinutes: number;
    scheduled: boolean;
    moduleId?: string;
    slideIds: string[];
    release: WorkshopAgendaRelease;
  }>;
  presentation: {
    slides: Array<{
      id: string;
      layout: WorkshopSlideLayout;
      title: string;
      bodyMarkdown: string;
      notesMarkdown?: string;
      moduleId?: string;
    }>;
  };
  durationMinutes: number;
}

/** Runtime validation for untrusted publication/database JSON. */
export function isWorkshopManifestV2(value: unknown): value is WorkshopManifestV2 {
  if (!isRecord(value) || value.schemaVersion !== 2) return false;
  if (!isWorkshop(value.workshop) || !isWorkspace(value.workspace)) return false;
  if (!isArrayOf(value.modules, isModule)) return false;
  if (!isArrayOf(value.agenda, isAgendaItem)) return false;
  if (!isRecord(value.presentation) || !isArrayOf(value.presentation.slides, isSlide)) {
    return false;
  }
  return isNonNegativeInteger(value.durationMinutes);
}

export function parseWorkshopManifestV2(value: unknown): WorkshopManifestV2 {
  if (!isWorkshopManifestV2(value)) {
    throw new TypeError("invalid hydrated Workshop manifest v2");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isArrayOf<T>(value: unknown, guard: (entry: unknown) => entry is T): value is T[] {
  return Array.isArray(value) && value.every(guard);
}

function hasOptionalString(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined || isString(record[key]);
}

function isWorkshop(value: unknown): value is WorkshopManifestV2["workshop"] {
  return isRecord(value)
    && isString(value.slug)
    && isString(value.title)
    && isString(value.summary)
    && isArrayOf(value.prerequisites, isString)
    && isRecord(value.attribution)
    && isString(value.attribution.title)
    && isString(value.attribution.url)
    && isString(value.attribution.license)
    && isNonNegativeInteger(value.defaultLobbyMinutes);
}

function isWorkspace(value: unknown): value is WorkshopManifestV2["workspace"] {
  return isRecord(value)
    && isNonNegativeInteger(value.leaseGraceMinutes)
    && isArrayOf(value.vms, isVm)
    && isArrayOf(value.runtimeProfiles, isRuntimeProfile)
    && value.runtimeProfiles.length > 0
    && isArrayOf(value.checkpoints, isCheckpoint)
    && isString(value.initialCheckpointId)
    && isArrayOf(value.applications, isApplication);
}

function isVm(value: unknown): value is WorkshopManifestV2["workspace"]["vms"][number] {
  return isRecord(value)
    && isString(value.id)
    && isString(value.name)
    && isPositiveInteger(value.cpuMillis)
    && isPositiveInteger(value.memoryMib)
    && isPositiveInteger(value.diskMib);
}

function isRuntimeProfile(
  value: unknown,
): value is WorkshopManifestV2["workspace"]["runtimeProfiles"][number] {
  if (!isRecord(value)
    || !isNonEmptyString(value.id)
    || !isNonEmptyString(value.vmId)
    || !isNonEmptyString(value.requestedSystemImage)
    || !isNonEmptyString(value.immutableSystemImage)
    || !isArrayOf(value.locations, isNonEmptyString)
    || !isHydratedRuntimeHardware(value.hardware)) {
    return false;
  }
  switch (value.provider) {
    case "agent_kvm":
      return value.machineType === undefined
        && value.rootDiskType === undefined
        && value.locations.length === 0
        && value.requestedSystemImage === value.immutableSystemImage;
    case "hetzner_cloud":
      return isNonEmptyString(value.machineType)
        && value.rootDiskType === undefined
        && value.locations.length > 0;
    case "gcp_compute":
      return isNonEmptyString(value.machineType)
        && value.rootDiskType === "pd-balanced"
        && value.locations.length > 0;
    default:
      return false;
  }
}

function isHydratedRuntimeHardware(value: unknown): value is HydratedRuntimeHardware {
  return isRecord(value)
    && value.architecture === "x86_64"
    && isPositiveInteger(value.cpuMillis)
    && isPositiveInteger(value.providerCpuCount)
    && isPositiveInteger(value.memoryMib)
    && isPositiveInteger(value.diskMib);
}

function isCheckpoint(
  value: unknown,
): value is WorkshopManifestV2["workspace"]["checkpoints"][number] {
  return isRecord(value)
    && isString(value.id)
    && isString(value.label)
    && isArrayOf(value.vmImages, isVmImage);
}

function isVmImage(
  value: unknown,
): value is WorkshopManifestV2["workspace"]["checkpoints"][number]["vmImages"][number] {
  return isRecord(value)
    && isString(value.vmId)
    && isRecord(value.imageKey)
    && isString(value.imageKey.scenario)
    && isString(value.imageKey.vm)
    && (value.imageKey.arch === "x86_64" || value.imageKey.arch === "aarch64")
    && isString(value.imageSha256);
}

function isApplication(
  value: unknown,
): value is WorkshopManifestV2["workspace"]["applications"][number] {
  return isRecord(value)
    && isString(value.id)
    && isString(value.label)
    && isString(value.vmId)
    && isPositiveInteger(value.port)
    && value.port <= 65_535
    && (value.protocol === "http" || value.protocol === "ws")
    && hasOptionalString(value, "upstreamHost")
    && isString(value.releaseModuleId);
}

function isModule(value: unknown): value is WorkshopManifestV2["modules"][number] {
  return isRecord(value)
    && isString(value.id)
    && isString(value.title)
    && (value.tier === "gate" || value.tier === "core" || value.tier === "stretch")
    && isString(value.outcome)
    && isArrayOf(value.dependsOn, isString)
    && isString(value.participantMarkdown)
    && isString(value.facilitatorNotesMarkdown)
    && isArrayOf(value.hints, isHint)
    && isString(value.solutionMarkdown)
    && hasOptionalString(value, "explainBackPrompt")
    && isArrayOf(value.probeIds, isString)
    && isString(value.catchUpCheckpointId);
}

function isHint(value: unknown): value is WorkshopManifestV2["modules"][number]["hints"][number] {
  return isRecord(value)
    && isString(value.id)
    && isString(value.title)
    && isString(value.bodyMarkdown);
}

function isAgendaItem(value: unknown): value is WorkshopManifestV2["agenda"][number] {
  return isRecord(value)
    && isString(value.id)
    && ["briefing", "lab", "demo", "break", "explain_back", "tinker", "retro"].includes(
      value.kind as string,
    )
    && isString(value.title)
    && isNonNegativeInteger(value.durationMinutes)
    && typeof value.scheduled === "boolean"
    && hasOptionalString(value, "moduleId")
    && isArrayOf(value.slideIds, isString)
    && ["facilitator", "automatic", "pool"].includes(value.release as string);
}

function isSlide(value: unknown): value is WorkshopManifestV2["presentation"]["slides"][number] {
  return isRecord(value)
    && isString(value.id)
    && ["title", "content", "two_column", "image", "quote"].includes(value.layout as string)
    && isString(value.title)
    && isString(value.bodyMarkdown)
    && hasOptionalString(value, "notesMarkdown")
    && hasOptionalString(value, "moduleId");
}

/** The only provider input accepted when creating a v2 Workshop session. */
export interface RuntimeProviderSelection {
  profileId: string;
  connectionId?: string;
}

export interface RuntimeHardwareShape {
  architecture: "x86_64";
  cpuMillis: number;
  memoryMib: number;
  diskMib: number;
  providerCpuCount: number;
  providerMemoryMib: number;
  providerDiskMib: number;
}

export interface ResolvedSystemImage {
  requested: string;
  immutableIdentity: string;
  architecture: "x86_64";
  resolvedAt: string;
}

export interface RuntimeProfileBase {
  id: string;
  vmId: string;
  provider: RuntimeProviderKind;
  machineType?: string;
  hardware: RuntimeHardwareShape;
  systemImage: ResolvedSystemImage;
  locations: readonly string[];
}

export interface AgentKvmRuntimeProfile extends RuntimeProfileBase {
  provider: "agent_kvm";
  machineType?: never;
}

export interface HetznerRuntimeProfile extends RuntimeProfileBase {
  provider: "hetzner_cloud";
  machineType: string;
}

export interface GcpRuntimeProfile extends RuntimeProfileBase {
  provider: "gcp_compute";
  machineType: string;
  rootDiskType: "pd-balanced";
}

export type WorkshopRuntimeProfile =
  | AgentKvmRuntimeProfile
  | HetznerRuntimeProfile
  | GcpRuntimeProfile;

export const DIRECT_CLOUD_BUNDLE_TARGET =
  "direct_cloud_linux_x86_64_v1" as const;

export interface ReconstructionBundleRef {
  target: typeof DIRECT_CLOUD_BUNDLE_TARGET;
  checkpointId: string;
  digest: `sha256:${string}`;
  byteLength: number;
  signature: string;
  keyId: string;
}

export type CurrencyNanos = bigint;

export interface ProviderPriceLineItem {
  provider: Exclude<RuntimeProviderKind, "agent_kvm">;
  sku: string;
  resourceKind: string;
  location: string;
  currency: string;
  rawUnitPrice: string;
  unitPriceNanos: CurrencyNanos;
  unit: "second" | "hour" | "gib_second" | "gib_month";
  quantity: number;
  billingGranularitySeconds: number;
  minimumDurationSeconds: number;
  capNanos?: CurrencyNanos;
  taxTreatment:
    | "provider_net"
    | "provider_gross"
    | "tax_excluded_public_list";
  source: string;
  observedAt: string;
}

export interface ProviderQuote {
  provider: Exclude<RuntimeProviderKind, "agent_kvm">;
  profileId: string;
  currency: string;
  location: string;
  lineItems: readonly ProviderPriceLineItem[];
  observedAt: string;
  expiresAt: string;
}
