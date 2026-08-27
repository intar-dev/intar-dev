/**
 * The small, live portion of a workshop room projection.  It deliberately
 * excludes authored Markdown, slide bodies, and other immutable revision
 * data that the room already received in its first projection.
 */
export interface WorkshopSessionStatusResponse {
  version: string;
  managerVersion: string | null;
  /** A changed authored or manager projection needs one normal GET refresh. */
  requiresFullRefresh: boolean;
  session: {
    id: string;
    version: number;
    state: "draft" | "lobby" | "live" | "ended" | "cancelled";
    observedAt: number;
    currentAgendaItemId: string | null;
    currentModuleId: string | null;
    currentSlideId: string | null;
    releasedModuleIds: string[];
    revealedSolutionModuleIds: string[];
    announcement: string | null;
    timer: {
      startedAt: number | null;
      endsAt: number | null;
      pausedAt: number | null;
      remainingMs: number | null;
    } | null;
  };
  viewer: {
    userId: string;
    role: "participant" | "helper" | "facilitator";
    workspaceEnabled: boolean;
    checkedIn: boolean;
    canFacilitate: boolean;
    canPresent: boolean;
    canAssist: boolean;
  };
  modules: Array<{
    id: string;
    state:
      | "locked"
      | "available"
      | "working"
      | "verified"
      | "caught_up"
      | "manually_completed"
      | "skipped";
    health: "unknown" | "pending" | "passing" | "failing";
    released: boolean;
    solutionRevealed: boolean;
    explainBackCompletedAt: number | null;
    verifiedAt: number | null;
    verificationUnavailable?: boolean;
    hints: Array<{ id: string; revealed: boolean }>;
    probes: Array<{
      id: string;
      status: "pass" | "fail" | "pending" | "unknown";
      detail: string | null;
    }>;
  }>;
  agenda: Array<{
    id: string;
    released: boolean;
    active: boolean;
    completed: boolean;
  }>;
  checkpoints: Array<{ id: string; released: boolean }>;
  slides: Array<{ id: string; released: boolean }>;
  workspace: {
    id: string;
    state:
      | "not_started"
      | "queued"
      | "provisioning"
      | "ready"
      | "recovering"
      | "ending"
      | "failed"
      | "ended";
    generation: number;
    checkpointId: string;
    vmName: string;
    terminalAvailable: boolean;
    lastHealthyAt: number | null;
    recoveryMessage: string | null;
    applications: Array<{
      id: string;
      label: string;
      url: null;
      available: boolean;
      releaseModuleId: string | null;
    }>;
  } | null;
  helpRequest: {
    id: string;
    state: "open" | "claimed" | "resolved";
    message: string | null;
    moduleId: string | null;
    requestedAt: number;
    claimedByName: string | null;
  } | null;
  assistGrant: {
    id: string;
    helperName: string;
    expiresAt: number;
    revokedAt: number | null;
    canExtend: boolean;
  } | null;
  roster: Array<{
    userId: string;
    name: string;
    role: "participant" | "helper" | "facilitator";
    workspaceEnabled: boolean;
    checkedInAt: number | null;
    lastSeenAt: number | null;
    presenceState: "present" | "stale" | "absent";
    provisionState:
      | "not_ready"
      | "queued"
      | "provisioning"
      | "ready"
      | "failed"
      | "ended";
    provisionError: string | null;
    workspaceState:
      | "not_started"
      | "queued"
      | "provisioning"
      | "ready"
      | "recovering"
      | "ending"
      | "failed"
      | "ended"
      | null;
    currentModuleId: string | null;
    helpState: "none" | "open" | "claimed";
    helpAssignedToViewer: boolean;
    assistGrant: {
      id: string;
      workspaceId: string;
      expiresAt: number;
    } | null;
    progress: Array<{
      moduleId: string;
      state:
        | "locked"
        | "available"
        | "working"
        | "verified"
        | "caught_up"
        | "manually_completed"
        | "skipped";
      health: "unknown" | "pending" | "passing" | "failing";
      explainBackStatus: "not_required" | "pending" | "completed";
      verificationUnavailable?: boolean;
      probes: Array<{
        id: string;
        label: string;
        status: "pass" | "fail" | "pending" | "unknown";
        detail: string | null;
      }>;
    }>;
  }>;
  capacity?: {
    seatsTotal: number;
    seatsAvailable: number;
    seatsRequired: number;
    checkedIn: number;
    provisioned: number;
    imagesReady: boolean;
    healthyRunners: number;
    seatResources: {
      cpuMillis: number;
      memoryMib: number;
      worstCaseDiskMib: number;
    };
    runners: Array<{
      hostId: string;
      imagesReady: boolean;
      missingImageVmIds: string[];
      seatsTotal: number;
      seatsAvailable: number;
      available: {
        cpuMillis: number;
        memoryMib: number;
        worstCaseDiskMib: number;
      };
    }>;
    allocationFailures: Array<{
      hostId: string;
      reason:
        | "host_unavailable"
        | "host_report_stale"
        | "runtime_capabilities_missing"
        | "image_not_ready"
        | "insufficient_resources";
      detail: string;
    }>;
  } | null;
}

export async function workshopStatusDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return digestWorkshopStatusBytes(bytes);
}

async function digestWorkshopStatusBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer,
  );
  return Array.from(new Uint8Array(digest), (part) =>
    part.toString(16).padStart(2, "0"),
  ).join("");
}
