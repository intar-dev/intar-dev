export type WorkshopSessionState =
  | "draft"
  | "lobby"
  | "live"
  | "ended"
  | "cancelled";

export type WorkshopMemberRole = "participant" | "helper" | "facilitator";

export type WorkshopModuleTier = "gate" | "core" | "stretch";

export type WorkshopModuleState =
  | "locked"
  | "available"
  | "working"
  | "verified"
  | "caught_up"
  | "manually_completed"
  | "skipped";

export type WorkshopHealth = "unknown" | "pending" | "passing" | "failing";

export type WorkshopPresenceState = "present" | "stale" | "absent";

export type WorkshopExplainBackStatus =
  | "not_required"
  | "pending"
  | "completed";

export type WorkshopWorkspaceState =
  | "not_started"
  | "queued"
  | "provisioning"
  | "ready"
  | "recovering"
  | "ending"
  | "failed"
  | "ended";

export type WorkshopAgendaKind =
  | "briefing"
  | "lab"
  | "demo"
  | "break"
  | "explain_back"
  | "tinker"
  | "retro";

export interface WorkshopSessionSummary {
  id: string;
  version: number;
  templateRevisionId: string;
  organizationId: string;
  organizationName: string;
  title: string;
  templateTitle: string;
  state: WorkshopSessionState;
  role: WorkshopMemberRole;
  workspaceEnabled?: boolean;
  startsAt: number;
  endsAt: number;
  currentModuleTitle: string | null;
  checkedIn: boolean;
  workspaceState: WorkshopWorkspaceState | null;
  participantCount: number;
  draftRoster?: Array<{
    userId: string;
    role: WorkshopMemberRole;
    workspaceEnabled?: boolean;
  }> | null;
  runtimeProvider?: WorkshopRuntimeProvider;
  cost?: WorkshopCostProjection | null;
}

export interface WorkshopModuleHint {
  id: string;
  title: string;
  bodyMarkdown: string | null;
  revealed: boolean;
}

export interface WorkshopProbe {
  id: string;
  label: string;
  status: "pass" | "fail" | "pending" | "unknown";
  detail: string | null;
}

export interface WorkshopModule {
  id: string;
  ordinal: number;
  title: string;
  outcome: string;
  tier: WorkshopModuleTier;
  durationMinutes: number;
  dependsOn: string[];
  state: WorkshopModuleState;
  health: WorkshopHealth;
  released: boolean;
  contentMarkdown: string | null;
  facilitatorNotesMarkdown: string | null;
  solutionMarkdown: string | null;
  solutionRevealed: boolean;
  explainBackPrompt: string | null;
  explainBackCompletedAt: number | null;
  verifiedAt: number | null;
  hints: WorkshopModuleHint[];
  probes: WorkshopProbe[];
}

export interface WorkshopAgendaItem {
  id: string;
  ordinal: number;
  kind: WorkshopAgendaKind;
  title: string;
  durationMinutes: number;
  scheduled: boolean;
  moduleId: string | null;
  slideIds: string[];
  released: boolean;
  active: boolean;
  completed: boolean;
}

export interface WorkshopCheckpoint {
  id: string;
  label: string;
  released: boolean;
  coveredModuleIds: string[];
}

export interface WorkshopApplication {
  id: string;
  label: string;
  url: string | null;
  available: boolean;
  releaseModuleId: string | null;
}

export interface WorkshopWorkspace {
  id: string;
  state: WorkshopWorkspaceState;
  generation: number;
  checkpointId: string;
  vmName: string;
  terminalAvailable: boolean;
  lastHealthyAt: number | null;
  recoveryMessage: string | null;
  applications: WorkshopApplication[];
}

export interface WorkshopSlide {
  id: string;
  ordinal: number;
  layout:
    | "title"
    | "content"
    | "split"
    | "two_column"
    | "image"
    | "quote"
    | "lab"
    | "break";
  title: string | null;
  bodyMarkdown: string | null;
  notesMarkdown: string | null;
  moduleId: string | null;
  released: boolean;
}

export interface WorkshopTimer {
  observedAt: number;
  startedAt: number | null;
  endsAt: number | null;
  pausedAt: number | null;
  remainingMs: number | null;
}

export interface WorkshopHelpRequest {
  id: string;
  state: "open" | "claimed" | "resolved";
  message: string | null;
  moduleId: string | null;
  requestedAt: number;
  claimedByName: string | null;
}

export interface WorkshopAssistGrant {
  id: string;
  helperName: string;
  expiresAt: number;
  revokedAt: number | null;
  canExtend: boolean;
}

export interface WorkshopRosterProgress {
  moduleId: string;
  state: WorkshopModuleState;
  health: WorkshopHealth;
  explainBackStatus: WorkshopExplainBackStatus;
  probes: WorkshopProbe[];
}

export interface WorkshopRosterMember {
  userId: string;
  name: string;
  role: WorkshopMemberRole;
  workspaceEnabled?: boolean;
  checkedInAt: number | null;
  lastSeenAt: number | null;
  presenceState: WorkshopPresenceState;
  provisionState:
    | "not_ready"
    | "queued"
    | "provisioning"
    | "ready"
    | "failed"
    | "ended";
  provisionError: string | null;
  workspaceState: WorkshopWorkspaceState | null;
  currentModuleId: string | null;
  helpState: "none" | "open" | "claimed";
  helpAssignedToViewer: boolean;
  assistGrant: {
    id: string;
    workspaceId: string;
    expiresAt: number;
  } | null;
  progress: WorkshopRosterProgress[];
}

export interface WorkshopSeatResources {
  cpuMillis: number;
  memoryMib: number;
  worstCaseDiskMib: number;
}

export interface WorkshopRunnerCapacity {
  hostId: string;
  imagesReady: boolean;
  missingImageVmIds: string[];
  seatsTotal: number;
  seatsAvailable: number;
  available: WorkshopSeatResources;
}

export interface WorkshopAllocationFailure {
  hostId: string;
  reason:
    | "host_unavailable"
    | "host_report_stale"
    | "runtime_capabilities_missing"
    | "image_not_ready"
    | "insufficient_resources";
  detail: string;
}

export interface WorkshopCapacity {
  seatsTotal: number;
  seatsAvailable: number;
  seatsRequired: number;
  checkedIn: number;
  provisioned: number;
  imagesReady: boolean;
  healthyRunners: number;
  seatResources: WorkshopSeatResources;
  runners: WorkshopRunnerCapacity[];
  allocationFailures: WorkshopAllocationFailure[];
}

export interface WorkshopProviderHardware {
  architecture: "x86_64";
  cpuMillis: number;
  memoryMib: number;
  diskMib: number;
}

export type WorkshopRuntimeProviderKind =
  | "agent_kvm"
  | "hetzner_cloud"
  | "gcp_compute";

export interface WorkshopRuntimeProvider {
  profileId: string;
  kind: WorkshopRuntimeProviderKind;
  machineType: string | null;
  systemImage: string;
  rootDiskType: string | null;
  hardware: WorkshopProviderHardware;
  permittedLocations: string[];
  connection: {
    id: string;
    displayName: string;
    state:
      | "validating"
      | "active"
      | "rotation_required"
      | "cleanup_pending"
      | "disconnected";
    currency: string;
    lastValidatedAt: number | null;
  } | null;
  maxConcurrentAllocations: number | null;
  maxSessionCostNanos: number | null;
  grossCeilingOverrideAt: number | null;
}

export interface WorkshopCostScenario {
  location: string;
  participantCount: number;
  generationLifetimeSeconds: number[];
  perLearnerCostNanos: number;
  totalCostNanos: number;
  providerNetCostNanos: number | null;
  providerGrossCostNanos: number | null;
  taxExcludedListCostNanos: number | null;
  lineItems: Array<{
    sku: string;
    resourceKind: string;
    taxTreatment:
      | "provider_net"
      | "provider_gross"
      | "tax_excluded_public_list";
    generationBillableDurationSeconds: number[];
    billedQuantityNanos: number;
    generationCostsNanos: number[];
    totalCostNanos: number;
  }>;
}

export interface WorkshopCostProjection {
  label: "estimated Hetzner cost" | "estimated GCP list cost (USD)" | null;
  latestForecast: {
    id: string;
    version: number;
    sessionId: string;
    providerKind: "hetzner_cloud" | "gcp_compute";
    connectionId: string;
    currency: string;
    participantCount: number;
    trigger: string;
    expected: WorkshopCostScenario;
    leaseCeiling: WorkshopCostScenario;
    oneRestore: WorkshopCostScenario;
    exceedsBudgetCeiling: boolean;
    assumptions: string[];
    exclusions: string[];
    observedAt: number;
    expiresAt: number;
    createdAt: number;
  } | null;
  live: {
    currency: string;
    accruedCostNanos: number;
    scheduledEndCostNanos: number;
    leaseCeilingCostNanos: number;
    forecastVarianceNanos: number;
    cleanupPendingResources: number;
    accumulatingResources: number;
    budgetCeilingNanos: number | null;
    budgetUsageNanos: number;
    overBudgetCeiling: boolean;
  } | null;
  final: {
    currency: string;
    costNanos: number;
    varianceNanos: number;
    generationCount: number;
    restoreCount: number;
    manualCleanupUnverified: boolean;
    finalizedAt: number;
  } | null;
}

export interface WorkshopViewer {
  userId: string;
  role: WorkshopMemberRole;
  workspaceEnabled?: boolean;
  checkedIn: boolean;
  canFacilitate: boolean;
  canPresent: boolean;
  canAssist: boolean;
}

export interface WorkshopSessionDetail {
  id: string;
  organizationId: string;
  organizationName: string;
  title: string;
  templateTitle: string;
  state: WorkshopSessionState;
  version: number;
  startsAt: number;
  endsAt: number;
  lobbyOpensAt: number;
  observedAt: number;
  currentAgendaItemId: string | null;
  currentModuleId: string | null;
  currentSlideId: string | null;
  currentSlideOrdinal: number;
  announcement: string | null;
  timer: WorkshopTimer | null;
  viewer: WorkshopViewer;
  modules: WorkshopModule[];
  agenda: WorkshopAgendaItem[];
  checkpoints: WorkshopCheckpoint[];
  slides: WorkshopSlide[];
  workspace: WorkshopWorkspace | null;
  helpRequest: WorkshopHelpRequest | null;
  assistGrant: WorkshopAssistGrant | null;
  roster: WorkshopRosterMember[];
  capacity: WorkshopCapacity | null;
  runtimeProvider?: WorkshopRuntimeProvider;
  cost?: WorkshopCostProjection | null;
}

export interface WorkshopListResponse {
  sessions: WorkshopSessionSummary[];
}

export interface WorkshopSessionResponse {
  session: WorkshopSessionDetail;
}

export interface WorkshopRegistryTokenSummary {
  id: string;
  name: string;
  tokenPrefix: string;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
  createdAt: number;
}

export interface CreatedWorkshopRegistryToken
  extends WorkshopRegistryTokenSummary {
  token: string;
}

export interface OrganizationWorkshopTemplate {
  id: string;
  slug: string;
  title: string;
  summary: string;
  latestRevision: number;
  currentRevisionId: string | null;
  revisionCount: number;
  durationMinutes: number;
  moduleCount: number;
  status: "building" | "ready" | "failed" | "cleanup_pending";
  updatedAt: number;
  revisions: Array<{
    id: string;
    revision: number;
    sourceRevision: string;
    contentHash: string;
    durationMinutes: number;
    moduleCount: number;
    publishedAt: number;
    current: boolean;
    schedulable: boolean;
    runtimeProfiles: Array<{
      id: string;
      profileId: string;
      providerKind: WorkshopRuntimeProviderKind;
      machineType: string | null;
      systemImage: string;
      rootDiskType: string | null;
      hardware: WorkshopProviderHardware;
      locations: string[];
      certification: {
        state:
          | "pending"
          | "verifying"
          | "verified"
          | "failed"
          | "cleanup_pending";
        connectionId: string | null;
        verifiedAt: number | null;
        deletionConfirmedAt: number | null;
      };
      compatible: boolean;
    }>;
  }>;
}

export interface OrganizationWorkshopsResponse {
  organization: {
    id: string;
    name: string;
    role: "owner" | "admin" | "member";
  };
  viewer: {
    userId: string;
  };
  members: Array<{
    userId: string;
    name: string;
    email: string;
  }>;
  templates: OrganizationWorkshopTemplate[];
  sessions: WorkshopSessionSummary[];
  providerConnections: Array<{
    id: string;
    providerKind: "hetzner_cloud" | "gcp_compute";
    displayName: string;
    state:
      | "validating"
      | "active"
      | "rotation_required"
      | "cleanup_pending"
      | "disconnected";
    externalProjectId: string;
    guardrails: {
      locations: string[];
      maxConcurrentAllocations: number;
      maxSessionCostNanos: number | null;
    };
    providerDetails:
      | {
          providerKind: "hetzner_cloud";
          sentinelFirewallId: string;
          nativeCurrency: string;
          ipv4Enabled: true;
        }
      | {
          providerKind: "gcp_compute";
          projectNumber: string;
          networkName: string;
          subnetName: string;
          firewallName: string;
          nativeCurrency: "USD";
        };
    credential: {
      version: number;
      authority: "active" | "cleanup_only";
      fingerprint: string;
      activatedAt: number;
    } | null;
    lastValidatedAt: number | null;
    createdAt: number;
    updatedAt: number;
    cleanupAcknowledgement: {
      acknowledgedAt: number;
      acknowledgedBy: string;
      verified: false;
    } | null;
  }>;
  capacity: WorkshopCapacity | null;
}

export function workshopSessionStateLabel(state: WorkshopSessionState): string {
  switch (state) {
    case "draft":
      return "Draft";
    case "lobby":
      return "Lobby open";
    case "live":
      return "Live";
    case "ended":
      return "Ended";
    case "cancelled":
      return "Cancelled";
  }
}

export function workshopMemberHasWorkspace(member: {
  role: WorkshopMemberRole;
  workspaceEnabled?: boolean;
}): boolean {
  return member.role === "participant" || member.workspaceEnabled === true;
}

export function workshopModuleStateLabel(state: WorkshopModuleState): string {
  switch (state) {
    case "locked":
      return "Locked";
    case "available":
      return "Available";
    case "working":
      return "Working";
    case "verified":
      return "Verified";
    case "caught_up":
      return "Caught up";
    case "manually_completed":
      return "Completed";
    case "skipped":
      return "Skipped";
  }
}
