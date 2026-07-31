import type {
  WorkshopCurrentHealth,
  WorkshopExplainBackStatus,
  WorkshopManifestV1,
  WorkshopProvisionState,
  WorkshopSessionRole,
  WorkshopSessionState,
  WorkshopTechnicalStatus,
  WorkshopWorkspaceGenerationState,
  WorkshopWorkspaceState,
} from "@/db/schema";

export interface WorkshopTemplateRecord {
  id: string;
  organizationId: string;
  slug: string;
  title: string;
  summary: string;
  currentRevisionId: string | null;
  currentRevision: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkshopTemplateRevisionRecord {
  id: string;
  templateId: string;
  revision: number;
  sourceRevision: string;
  contentHash: string;
  manifest: WorkshopManifestV1;
  publishedAt: number;
}

export interface WorkshopSessionRecord {
  id: string;
  organizationId: string;
  templateRevisionId: string;
  templateId: string;
  templateSlug: string;
  templateTitle: string;
  title: string;
  state: WorkshopSessionState;
  version: number;
  scheduledStartAt: number;
  lobbyOpensAt: number;
  currentAgendaItemId: string | null;
  currentModuleId: string | null;
  currentSlideId: string | null;
  releasedModuleIds: string[];
  revealedHintIds: string[];
  revealedSolutionModuleIds: string[];
  timerStartedAt: number | null;
  timerEndsAt: number | null;
  timerPausedAt: number | null;
  timerRemainingMs: number | null;
  announcement: string | null;
  startedAt: number | null;
  endedAt: number | null;
  cancelledAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkshopRosterMemberRecord {
  id: string;
  userId: string;
  name: string;
  role: WorkshopSessionRole;
  workspaceEnabled: boolean;
  checkedInAt: number | null;
  lastSeenAt: number | null;
  provisionState: WorkshopProvisionState;
  provisionError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkshopWorkspaceGenerationRecord {
  id: string;
  ordinal: number;
  runtimeExecutionId: string | null;
  checkpointId: string | null;
  hostId: string | null;
  state: WorkshopWorkspaceGenerationState;
  error: string | null;
  requestedAt: number;
  provisioningStartedAt: number | null;
  readyAt: number | null;
  archiveRequestedAt: number | null;
  archivedAt: number | null;
  failedAt: number | null;
}

export interface WorkshopWorkspaceRecord {
  id: string;
  sessionId: string;
  userId: string;
  state: WorkshopWorkspaceState;
  currentGenerationId: string | null;
  lastCheckpointId: string | null;
  recoveryMessage: string | null;
  endedAt: number | null;
  generations: WorkshopWorkspaceGenerationRecord[];
}

export interface WorkshopModuleProgressRecord {
  id: string;
  userId: string;
  moduleId: string;
  technicalStatus: WorkshopTechnicalStatus;
  currentHealth: WorkshopCurrentHealth;
  explainBackStatus: WorkshopExplainBackStatus;
  revealedHintIds: string[];
  startedAt: number | null;
  firstVerifiedAt: number | null;
  caughtUpAt: number | null;
  explainBackCompletedAt: number | null;
  healthObservedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
}

export interface WorkshopHelpRequestRecord {
  id: string;
  requesterUserId: string;
  moduleId: string | null;
  message: string;
  status: "open" | "claimed" | "resolved" | "cancelled";
  claimedBy: string | null;
  claimedAt: number | null;
  resolvedAt: number | null;
  cancelledAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkshopAssistGrantRecord {
  id: string;
  sessionId: string;
  workspaceId: string;
  helpRequestId: string;
  learnerUserId: string;
  helperUserId: string;
  grantedAt: number;
  expiresAt: number;
  revokedAt: number | null;
  revokedBy: string | null;
  active: boolean;
}

export interface WorkshopProvisioningRequest {
  organizationId: string;
  sessionId: string;
  templateRevisionId: string;
  participantUserId: string;
  workspaceId: string;
  generationId: string;
  generationOrdinal: number;
  checkpointId: string;
  manifest: WorkshopManifestV1;
}

export interface WorkshopRoomRecord {
  session: WorkshopSessionRecord;
  revision: WorkshopTemplateRevisionRecord;
  viewer: WorkshopRosterMemberRecord;
  workspace: WorkshopWorkspaceRecord | null;
  progress: WorkshopModuleProgressRecord[];
  helpRequests: WorkshopHelpRequestRecord[];
  activeAssistGrants: WorkshopAssistGrantRecord[];
  facilitation: {
    roster: WorkshopRosterMemberRecord[];
    progress: WorkshopModuleProgressRecord[];
    workspaces: WorkshopWorkspaceRecord[];
  } | null;
}

export interface WorkshopGenerationStateUpdate {
  state: WorkshopWorkspaceGenerationState;
  runtimeExecutionId?: string | null;
  hostId?: string | null;
  error?: string | null;
  observedAt?: number;
}
