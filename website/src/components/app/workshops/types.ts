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
  startsAt: number;
  endsAt: number;
  currentModuleTitle: string | null;
  checkedIn: boolean;
  workspaceState: WorkshopWorkspaceState | null;
  participantCount: number;
  draftRoster?: Array<{
    userId: string;
    role: WorkshopMemberRole;
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
  architecture: "x86";
  cores: number;
  memoryMib: number;
  diskMib: number;
}

export type WorkshopRuntimeProvider =
  | { kind: "agent_kvm" }
  | {
      kind: "hetzner_cloud";
      connection: {
        id: string;
        displayName: string;
        state: "active" | "rotation_required" | "cleanup_pending" | "disconnected";
        currency: string;
        lastValidatedAt: number;
      };
      serverType: string;
      hardware: WorkshopProviderHardware;
      permittedLocations: string[];
      initialPriceObservedAt: number | null;
      maxConcurrentServers: number;
      maxSessionGrossMicros: number | null;
      grossCeilingOverrideAt: number | null;
    };

export interface WorkshopCostScenario {
  lifetimeSeconds: number;
  billableHours: number;
  generationBillableHours: number[];
  location: string;
  participantCount: number;
  serverNetMicrosPerLearner: number;
  serverGrossMicrosPerLearner: number;
  ipv4NetMicrosPerLearner: number;
  ipv4GrossMicrosPerLearner: number;
  totalNetMicros: number;
  totalGrossMicros: number;
}

export interface WorkshopCostProjection {
  label: "estimated Hetzner cost";
  latestForecast: {
    id: string;
    version: number;
    currency: string;
    participantCount: number;
    preferredLocation: string;
    trigger: string;
    priceObservation: {
      observedAt: number;
      expiresAt: number;
    };
    expected: WorkshopCostScenario;
    leaseCeiling: WorkshopCostScenario;
    oneRestore: WorkshopCostScenario;
    exceedsGrossCeiling: boolean;
    assumptions: string[];
    exclusions: string[];
    expiresAt: number;
    createdAt: number;
  } | null;
  live: {
    currency: string;
    accruedNetMicros: number;
    accruedGrossMicros: number;
    scheduledEndNetMicros: number;
    scheduledEndGrossMicros: number;
    leaseCeilingNetMicros: number;
    leaseCeilingGrossMicros: number;
    forecastNetVarianceMicros: number;
    forecastGrossVarianceMicros: number;
    cleanupPendingResources: number;
    accumulatingResources: number;
    grossCeilingMicros: number | null;
    grossCeilingUsageMicros: number;
    overGrossCeiling: boolean;
  } | null;
  final: {
    currency: string;
    netMicros: number;
    grossMicros: number;
    netVarianceMicros: number;
    grossVarianceMicros: number;
    generationCount: number;
    restoreCount: number;
    manualCleanupUnverified: boolean;
    finalizedAt: number;
  } | null;
}

export interface WorkshopViewer {
  userId: string;
  role: WorkshopMemberRole;
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
  status: "building" | "ready" | "failed";
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
    runtimeProvider: {
      kind: "hetzner_cloud";
      serverType: string;
      systemImage: string;
      hardware: WorkshopProviderHardware;
      compatible: true;
    } | null;
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
    displayName: string;
    state: "active" | "rotation_required" | "cleanup_pending" | "disconnected";
    approvedLocations: string[];
    maxConcurrentServers: number;
    maxSessionGrossMicros: number | null;
    currency: string;
    credential: {
      version: number;
      fingerprint: string;
      activatedAt: number;
    } | null;
    lastValidatedAt: number;
    cleanupAcknowledgement: {
      acknowledgedAt: number;
      acknowledgedBy: string;
      verified: false;
    } | null;
    cleanupResources?: Array<{
      allocationId: string;
      executionId: string;
      deterministicName: string;
      state: string;
      serverId: string | null;
      primaryIpId: string | null;
      primaryIpv4: string | null;
      sshKeyId: string | null;
      createActionId: string | null;
      deleteActionId: string | null;
      deletionConfirmedAt: number | null;
    }>;
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
