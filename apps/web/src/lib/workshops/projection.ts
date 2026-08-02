import { and, count, desc, eq, inArray } from "drizzle-orm";
import {
  gcpConnectionDetails,
  hetznerConnectionDetails,
  organization,
  providerConnections,
  runtimeActualState,
  runtimeGuestReports,
  runtimeVmActualState,
  runtimeVms,
  workshopRuntimeProfileCertifications,
  workshopRuntimeProfiles,
  workshopSessionMembers,
  workshopSessionRuntimeSelections,
  workshopTemplateRevisions,
  workshopWorkspaceGenerations,
  workshopWorkspaces,
  type WorkshopManifestV2,
  type WorkshopTechnicalStatus,
  type WorkshopWorkspaceState,
} from "@/db/schema";
import { appError } from "@/lib/app-error";
import type { FeatureToggleService } from "@/lib/feature-toggles";
import {
  getOrganizationDetail,
  isOrganizationAdminRole,
  requireOrganizationRole,
} from "@/lib/organizations";
import {
  canExtendWorkshopAssist,
  listActiveWorkshopAssistGrants,
  listWorkshopHelpRequests,
} from "./assistance";
import {
  isWorkshopsEnabledForOrganization,
  workshopFeatureToggleService,
} from "./feature-flag";
import { listWorkshopProgress } from "./progress";
import {
  loadWorkshopManifestForSession,
  requireWorkshopSessionMember,
  workshopCheckpointRequiredPrefixIds,
  workshopDb,
  workshopReleaseIncludesPrefix,
} from "./shared";
import {
  listOrganizationWorkshopSessions,
  listWorkshopRoster,
  listWorkshopSessionsForUser,
  loadWorkshopSession,
} from "./sessions";
import {
  listWorkshopTemplateRevisions,
  listWorkshopTemplates,
} from "./templates";
import { getWorkshopCapacityPreflight } from "./capacity";
import { workshopPresenceState } from "./presence";
import { getWorkshopCostProjection } from "./cost-storage";
import { listProviderConnections } from "./provider-connections";
import type {
  WorkshopModuleProgressRecord,
  WorkshopSessionRecord,
  WorkshopWorkspaceRecord,
} from "./types";

export async function getWorkshopListProjection(
  userId: string,
  featureToggles: FeatureToggleService = workshopFeatureToggleService(),
) {
  const entries = await listWorkshopSessionsForUser({ userId });
  const enabledByOrganization = new Map(
    await Promise.all(
      [...new Set(entries.map((entry) => entry.session.organizationId))].map(
        async (organizationId) =>
          [
            organizationId,
            await isWorkshopsEnabledForOrganization(
              organizationId,
              featureToggles,
            ),
          ] as const,
      ),
    ),
  );
  return {
    sessions: await Promise.all(
      entries
        .filter(
          (entry) =>
            enabledByOrganization.get(entry.session.organizationId) === true,
        )
        .map((entry) =>
          projectWorkshopSummary({
            session: entry.session,
            userId,
            role: entry.membership.role,
            workspaceEnabled: entry.membership.workspaceEnabled,
            checkedInAt: entry.membership.checkedInAt,
            provisionState: entry.membership.provisionState,
          }),
        ),
    ),
  };
}

export async function getOrganizationWorkshopsProjection(params: {
  organizationId: string;
  userId: string;
}) {
  const role = await requireOrganizationRole(params);
  const detail = await getOrganizationDetail({
    organizationKey: params.organizationId,
    userId: params.userId,
  });
  const isAdmin = isOrganizationAdminRole(role);
  const [templates, sessions, providerConnections] = await Promise.all([
    isAdmin ? listWorkshopTemplates(params) : Promise.resolve([]),
    isAdmin
      ? listOrganizationWorkshopSessions(params)
      : listWorkshopSessionsForUser({ userId: params.userId }).then((entries) =>
          entries
            .filter((entry) => entry.session.organizationId === detail.id)
            .map((entry) => entry.session),
        ),
    isAdmin
      ? listProviderConnections({
          organizationId: detail.id,
          actorUserId: params.userId,
        })
      : Promise.resolve([]),
  ]);
  const sessionSummaries = await Promise.all(
    sessions.map(async (session) => {
      const [roster, draftRoster, managerOperations] = await Promise.all([
        workshopDb()
          .select({
            role: workshopSessionMembers.role,
            workspaceEnabled: workshopSessionMembers.workspaceEnabled,
            checkedInAt: workshopSessionMembers.checkedInAt,
            provisionState: workshopSessionMembers.provisionState,
          })
          .from(workshopSessionMembers)
          .where(
            and(
              eq(workshopSessionMembers.sessionId, session.id),
              eq(workshopSessionMembers.userId, params.userId),
            ),
          )
          .limit(1),
        session.state === "draft"
          ? listWorkshopRoster(session.id)
          : Promise.resolve([]),
        isAdmin
          ? projectWorkshopManagerOperations(session.id)
          : Promise.resolve(null),
      ]);
      return {
        ...(await projectWorkshopSummary({
          session,
          userId: params.userId,
          role: roster[0]?.role ?? "facilitator",
          workspaceEnabled: roster[0]?.workspaceEnabled ?? false,
          checkedInAt: roster[0]?.checkedInAt ?? null,
          provisionState: roster[0]?.provisionState ?? "not_ready",
        })),
        draftRoster:
          session.state === "draft"
            ? draftRoster.map((entry) => ({
                userId: entry.userId,
                role: entry.role,
                workspaceEnabled: entry.workspaceEnabled,
              }))
            : null,
        ...(managerOperations ?? {}),
      };
    }),
  );
  const templateProjections = await Promise.all(
    templates.map(async (template) => {
      const revisions = await listWorkshopTemplateRevisions({
        organizationId: detail.id,
        templateId: template.id,
        userId: params.userId,
      });
      const current = revisions.find(
        (revision) => revision.id === template.currentRevisionId,
      );
      return {
        id: template.id,
        slug: template.slug,
        title: template.title,
        summary: template.summary,
        latestRevision: current?.revision ?? template.currentRevision ?? 0,
        currentRevisionId: template.currentRevisionId,
        revisionCount: revisions.length,
        durationMinutes: current?.manifest.durationMinutes ?? 0,
        moduleCount: current?.manifest.modules.length ?? 0,
        status: "ready" as const,
        updatedAt: template.updatedAt,
        revisions: await Promise.all(
          revisions.map(async (revision) => ({
            id: revision.id,
            revision: revision.revision,
            sourceRevision: revision.sourceRevision,
            contentHash: revision.contentHash,
            durationMinutes: revision.manifest.durationMinutes,
            moduleCount: revision.manifest.modules.length,
            publishedAt: revision.publishedAt,
            current: revision.id === template.currentRevisionId,
            runtimeProfiles: await projectRevisionRuntimeProfiles(revision.id),
          })),
        ),
      };
    }),
  );
  const capacitySession = sessions.find(
    (session) => session.state === "lobby" || session.state === "live",
  );
  const capacityProviderRows = capacitySession
    ? await workshopDb()
        .select({ kind: workshopSessionRuntimeSelections.providerKind })
        .from(workshopSessionRuntimeSelections)
        .where(eq(workshopSessionRuntimeSelections.sessionId, capacitySession.id))
        .limit(1)
    : [];
  const capacity =
    capacitySession &&
    capacityProviderRows[0]?.kind === "agent_kvm"
    ? await getWorkshopCapacityPreflight({ sessionId: capacitySession.id })
    : null;
  return {
    organization: {
      id: detail.id,
      name: detail.name,
      role,
    },
    viewer: { userId: params.userId },
    members: detail.members.map((entry) => ({
      userId: entry.userId,
      name: entry.name,
      email: entry.email,
    })),
    templates: templateProjections,
    sessions: sessionSummaries,
    providerConnections,
    capacity: projectCapacity(capacity),
  };
}

async function projectRevisionRuntimeProfiles(templateRevisionId: string) {
  const rows = await workshopDb()
    .select({
      profile: workshopRuntimeProfiles,
      certification: workshopRuntimeProfileCertifications,
    })
    .from(workshopRuntimeProfiles)
    .innerJoin(
      workshopRuntimeProfileCertifications,
      eq(
        workshopRuntimeProfileCertifications.runtimeProfileId,
        workshopRuntimeProfiles.id,
      ),
    )
    .where(eq(workshopRuntimeProfiles.templateRevisionId, templateRevisionId));
  return rows.map(({ profile, certification }) => ({
    id: profile.id,
    profileId: profile.profileId,
    providerKind: profile.providerKind,
    machineType: profile.machineType,
    systemImage: profile.systemImage,
    rootDiskType: profile.rootDiskType,
    hardware: {
      architecture: "x86_64" as const,
      cpuMillis: profile.cpuMillis,
      memoryMib: profile.memoryMib,
      diskMib: profile.diskMib,
    },
    locations: profile.locationsJson,
    certification: {
      state: certification.state,
      connectionId: certification.connectionId,
      verifiedAt: certification.verifiedAt,
      deletionConfirmedAt: certification.deletionConfirmedAt,
    },
    compatible:
      certification.state === "verified" &&
      certification.deletionConfirmedAt !== null,
  }));
}

export async function getWorkshopSessionProjection(params: {
  sessionId: string;
  userId: string;
  view?: "room" | "projector";
}) {
  const access = await requireWorkshopSessionMember(params);
  const projectorView = params.view === "projector";
  const [
    session,
    context,
    roster,
    allProgress,
    workspaces,
    organizationRows,
    runtimeProviderRows,
  ] =
    await Promise.all([
      loadWorkshopSession(params.sessionId),
      loadWorkshopManifestForSession(params.sessionId),
      listWorkshopRoster(params.sessionId),
      listWorkshopProgress(params.sessionId),
      loadWorkshopWorkspaces(params.sessionId),
      workshopDb()
        .select({ name: organization.name })
        .from(organization)
        .where(eq(organization.id, access.organizationId))
        .limit(1),
      workshopDb()
        .select({ kind: workshopSessionRuntimeSelections.providerKind })
        .from(workshopSessionRuntimeSelections)
        .where(eq(workshopSessionRuntimeSelections.sessionId, params.sessionId))
        .limit(1),
    ]);
  const organizationName = organizationRows[0]?.name;
  if (!organizationName) {
    throw appError(404, "organization_not_found", "organization not found");
  }
  const revisions = await workshopDb()
    .select({
      id: workshopTemplateRevisions.id,
      templateId: workshopTemplateRevisions.templateId,
      revision: workshopTemplateRevisions.revision,
      sourceRevision: workshopTemplateRevisions.sourceRevision,
      contentHash: workshopTemplateRevisions.contentHash,
      manifest: workshopTemplateRevisions.manifestJson,
      publishedAt: workshopTemplateRevisions.publishedAt,
    })
    .from(workshopTemplateRevisions)
    .where(eq(workshopTemplateRevisions.id, session.templateRevisionId))
    .limit(1);
  const revision = revisions[0];
  if (!revision) {
    throw appError(
      404,
      "workshop_template_revision_not_found",
      "workshop template revision not found",
    );
  }
  const viewer = roster.find((entry) => entry.userId === params.userId);
  if (!viewer) {
    throw appError(
      404,
      "workshop_session_not_found",
      "workshop session not found",
    );
  }
  const ownProgress = allProgress.filter(
    (entry) => entry.userId === params.userId,
  );
  const ownWorkspace =
    workspaces.find((entry) => entry.userId === params.userId) ?? null;
  const hasActiveOrganizationMembership = access.organizationRole !== null;
  const canFacilitate =
    !projectorView &&
    hasActiveOrganizationMembership &&
    (access.role === "facilitator" ||
      (access.organizationRole !== null &&
        isOrganizationAdminRole(access.organizationRole)));
  const canAssist =
    !projectorView &&
    hasActiveOrganizationMembership &&
    (access.role === "facilitator" || access.role === "helper");
  const canSeeRoomProgress =
    !projectorView &&
    (canFacilitate ||
      (hasActiveOrganizationMembership && access.role === "helper"));
  const helpRequests = projectorView
    ? []
    : await listWorkshopHelpRequests(
        params.sessionId,
        canSeeRoomProgress ? undefined : params.userId,
      );
  const activeGrants = projectorView
    ? []
    : await listActiveWorkshopAssistGrants({
        sessionId: params.sessionId,
        ...(!canSeeRoomProgress ? { userId: params.userId } : {}),
      });
  const userNames = new Map(roster.map((entry) => [entry.userId, entry.name]));
  const ownHelp =
    helpRequests.find(
      (entry) =>
        entry.requesterUserId === params.userId &&
        (entry.status === "open" || entry.status === "claimed"),
    ) ?? null;
  const ownGrant =
    activeGrants.find((entry) => entry.learnerUserId === params.userId) ?? null;
  const capacity =
    !projectorView &&
    (session.state === "lobby" || session.state === "live") &&
    runtimeProviderRows[0]?.kind === "agent_kvm"
      ? await getWorkshopCapacityPreflight({ sessionId: params.sessionId })
      : null;
  const probeReports =
    canSeeRoomProgress || access.workspaceEnabled
      ? await loadCurrentWorkshopProbeReports({
          sessionId: params.sessionId,
          manifest: context.manifest,
          ...(!canSeeRoomProgress ? { userId: params.userId } : {}),
        })
      : new Map<string, CurrentWorkshopProbeReport>();
  const slides = projectSlides(context.manifest, session, canFacilitate);
  const projectedAt = Date.now();
  const canSeeManagerOperations =
    !projectorView &&
    access.organizationRole !== null &&
    isOrganizationAdminRole(access.organizationRole);
  const managerOperations = canSeeManagerOperations
    ? await projectWorkshopManagerOperations(params.sessionId, projectedAt)
    : null;

  return {
    session: {
      id: session.id,
      organizationId: session.organizationId,
      organizationName,
      title: session.title,
      templateTitle: session.templateTitle,
      state: session.state,
      version: session.version,
      startsAt: session.scheduledStartAt,
      endsAt:
        session.scheduledStartAt + context.manifest.durationMinutes * 60_000,
      lobbyOpensAt: session.lobbyOpensAt,
      observedAt: projectedAt,
      currentAgendaItemId: session.currentAgendaItemId,
      currentModuleId: session.currentModuleId,
      currentSlideId: session.currentSlideId,
      currentSlideOrdinal: Math.max(
        0,
        context.manifest.presentation.slides.findIndex(
          (slide) => slide.id === session.currentSlideId,
        ),
      ),
      announcement: session.announcement,
      timer:
        session.timerStartedAt !== null || session.timerPausedAt !== null
          ? {
              observedAt: projectedAt,
              startedAt: session.timerStartedAt,
              endsAt: session.timerEndsAt,
              pausedAt: session.timerPausedAt,
              remainingMs: session.timerRemainingMs,
            }
          : null,
      viewer: {
        userId: params.userId,
        role: access.role,
        workspaceEnabled: access.workspaceEnabled,
        checkedIn: viewer.checkedInAt !== null,
        canFacilitate,
        canPresent: canFacilitate,
        canAssist,
      },
      modules: projectorView
        ? projectProjectorModules(context.manifest, session)
        : projectModules({
            manifest: context.manifest,
            session,
            progress: access.workspaceEnabled ? ownProgress : allProgress,
            ...(access.workspaceEnabled
              ? { participantUserId: params.userId }
              : {}),
            facilitator: canFacilitate,
            probeReport: access.workspaceEnabled
              ? (probeReports.get(params.userId) ?? null)
              : null,
          }),
      agenda: projectorView
        ? []
        : projectAgenda({
            manifest: context.manifest,
            session,
            progress: ownProgress,
          }),
      checkpoints: projectorView
        ? []
        : context.manifest.workspace.checkpoints.map((checkpoint) => {
            const coveredModuleIds =
              workshopCheckpointRequiredPrefixIds(
                context.manifest,
                checkpoint.id,
              ) ?? [];
            return {
              id: checkpoint.id,
              label: checkpoint.label,
              released: workshopReleaseIncludesPrefix(
                session.releasedModuleIds,
                coveredModuleIds,
              ),
              coveredModuleIds,
            };
          }),
      slides: projectorView
        ? projectProjectorSlides(slides, session.currentSlideId)
        : slides,
      workspace: !projectorView && ownWorkspace
        ? projectWorkspace(
            ownWorkspace,
            context.manifest,
            session.releasedModuleIds,
          )
        : null,
      helpRequest: !projectorView && ownHelp
        ? {
            id: ownHelp.id,
            state: ownHelp.status,
            message: ownHelp.message,
            moduleId: ownHelp.moduleId,
            requestedAt: ownHelp.createdAt,
            claimedByName: ownHelp.claimedBy
              ? (userNames.get(ownHelp.claimedBy) ?? null)
              : null,
          }
        : null,
      assistGrant: !projectorView && ownGrant
        ? {
            id: ownGrant.id,
            helperName:
              userNames.get(ownGrant.helperUserId) ?? "Workshop helper",
            expiresAt: ownGrant.expiresAt,
            revokedAt: ownGrant.revokedAt,
            canExtend: canExtendWorkshopAssist(ownGrant),
          }
        : null,
      roster: !projectorView && canSeeRoomProgress
        ? roster.map((entry) =>
            projectRosterMember({
              member: entry,
              progress: allProgress.filter(
                (progress) => progress.userId === entry.userId,
              ),
              workspace:
                workspaces.find(
                  (workspace) => workspace.userId === entry.userId,
                ) ?? null,
              helpRequest:
                helpRequests.find(
                  (request) =>
                    request.requesterUserId === entry.userId &&
                    (request.status === "open" || request.status === "claimed"),
                ) ?? null,
              assistGrant:
                activeGrants.find(
                  (grant) =>
                    grant.learnerUserId === entry.userId &&
                    grant.helperUserId === params.userId,
                ) ?? null,
              viewerUserId: params.userId,
              session,
              manifest: context.manifest,
              probeReport: probeReports.get(entry.userId) ?? null,
              observedAt: projectedAt,
            }),
          )
        : [],
      capacity: projectCapacity(capacity),
      ...(managerOperations ?? {}),
    },
  };
}

async function projectWorkshopManagerOperations(
  sessionId: string,
  observedAt = Date.now(),
) {
  const rows = await workshopDb()
    .select({
      selection: workshopSessionRuntimeSelections,
      connection: providerConnections,
    })
    .from(workshopSessionRuntimeSelections)
    .leftJoin(
      providerConnections,
      eq(
        providerConnections.id,
        workshopSessionRuntimeSelections.connectionId,
      ),
    )
    .where(eq(workshopSessionRuntimeSelections.sessionId, sessionId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw appError(
      409,
      "workshop_runtime_provider_missing",
      "workshop runtime provider selection is missing",
    );
  }
  const profile = row.selection.resolvedProfileJson;
  if (row.selection.providerKind === "agent_kvm") {
    return {
      runtimeProvider: {
        profileId: row.selection.profileId,
        kind: "agent_kvm" as const,
        machineType: profile.machineType,
        systemImage: profile.systemImage,
        rootDiskType: profile.rootDiskType,
        hardware: {
          architecture: "x86_64" as const,
          cpuMillis: profile.hardware.cpuMillis,
          memoryMib: profile.hardware.memoryMib,
          diskMib: profile.hardware.diskMib,
        },
        permittedLocations: profile.locations,
        connection: null,
        maxConcurrentAllocations: null,
        maxSessionCostNanos: null,
        grossCeilingOverrideAt: row.selection.grossCeilingOverrideAt,
      },
      cost: null,
    };
  }
  if (!row.connection || row.connection.providerKind !== row.selection.providerKind) {
    throw appError(
      409,
      "workshop_runtime_provider_invalid",
      "workshop runtime provider configuration is incomplete",
    );
  }
  const details =
    row.selection.providerKind === "hetzner_cloud"
      ? await workshopDb()
          .select({
            currency: hetznerConnectionDetails.nativeCurrency,
            maxConcurrentAllocations:
              hetznerConnectionDetails.maxConcurrentAllocations,
            maxSessionCostNanos: hetznerConnectionDetails.maxSessionCostNanos,
          })
          .from(hetznerConnectionDetails)
          .where(eq(hetznerConnectionDetails.connectionId, row.connection.id))
          .limit(1)
      : await workshopDb()
          .select({
            currency: gcpConnectionDetails.connectionId,
            maxConcurrentAllocations:
              gcpConnectionDetails.maxConcurrentAllocations,
            maxSessionCostNanos: gcpConnectionDetails.maxSessionCostNanos,
          })
          .from(gcpConnectionDetails)
          .where(eq(gcpConnectionDetails.connectionId, row.connection.id))
          .limit(1);
  const detail = details[0];
  if (!detail) {
    throw appError(
      409,
      "workshop_runtime_provider_invalid",
      "workshop runtime provider details are missing",
    );
  }
  const currency =
    row.selection.providerKind === "hetzner_cloud" ? detail.currency : "USD";
  return {
    runtimeProvider: {
      profileId: row.selection.profileId,
      kind: row.selection.providerKind,
      machineType: profile.machineType,
      systemImage: profile.systemImage,
      rootDiskType: profile.rootDiskType,
      hardware: {
        architecture: "x86_64" as const,
        cpuMillis: profile.hardware.cpuMillis,
        memoryMib: profile.hardware.memoryMib,
        diskMib: profile.hardware.diskMib,
      },
      permittedLocations: profile.locations,
      connection: {
        id: row.connection.id,
        displayName: row.connection.displayName,
        state: row.connection.state,
        currency,
        lastValidatedAt: row.connection.lastValidatedAt,
      },
      maxConcurrentAllocations: detail.maxConcurrentAllocations,
      maxSessionCostNanos: detail.maxSessionCostNanos,
      grossCeilingOverrideAt: row.selection.grossCeilingOverrideAt,
    },
    cost: await getWorkshopCostProjection({ sessionId, now: observedAt }),
  };
}

function projectCapacity(
  capacity: Awaited<ReturnType<typeof getWorkshopCapacityPreflight>> | null,
) {
  return capacity
    ? {
        seatsTotal: capacity.seatsTotal,
        seatsAvailable: capacity.seatsAvailable,
        seatsRequired: capacity.seatsRequired,
        checkedIn: capacity.checkedIn,
        provisioned: capacity.provisioned,
        imagesReady: capacity.imagesReady,
        healthyRunners: capacity.healthyRunners,
        seatResources: capacity.seatResources,
        runners: capacity.runners.map((runner) => ({
          ...runner,
          missingImageVmIds: [...runner.missingImageVmIds],
          available: { ...runner.available },
        })),
        allocationFailures: capacity.allocationFailures.map((failure) => ({
          ...failure,
        })),
      }
    : null;
}

async function projectWorkshopSummary(params: {
  session: WorkshopSessionRecord;
  userId: string;
  role: "participant" | "helper" | "facilitator";
  workspaceEnabled: boolean;
  checkedInAt: number | null;
  provisionState: string;
}) {
  const db = workshopDb();
  const [context, organizations, participantCounts, workspaces] =
    await Promise.all([
      loadWorkshopManifestForSession(params.session.id),
      db
        .select({ name: organization.name })
        .from(organization)
        .where(eq(organization.id, params.session.organizationId))
        .limit(1),
      db
        .select({ value: count() })
        .from(workshopSessionMembers)
        .where(
          and(
            eq(workshopSessionMembers.sessionId, params.session.id),
            eq(workshopSessionMembers.workspaceEnabled, true),
          ),
        ),
      db
        .select({ state: workshopWorkspaces.state })
        .from(workshopWorkspaces)
        .where(
          and(
            eq(workshopWorkspaces.sessionId, params.session.id),
            eq(workshopWorkspaces.userId, params.userId),
          ),
        )
        .limit(1),
    ]);
  const currentModuleTitle = params.session.currentModuleId
    ? (context.manifest.modules.find(
        (module) => module.id === params.session.currentModuleId,
      )?.title ?? null)
    : null;
  return {
    id: params.session.id,
    version: params.session.version,
    templateRevisionId: params.session.templateRevisionId,
    organizationId: params.session.organizationId,
    organizationName: organizations[0]?.name ?? "Organization",
    title: params.session.title,
    templateTitle: params.session.templateTitle,
    state: params.session.state,
    role: params.role,
    workspaceEnabled: params.workspaceEnabled,
    startsAt: params.session.scheduledStartAt,
    endsAt:
      params.session.scheduledStartAt +
      context.manifest.durationMinutes * 60_000,
    currentModuleTitle,
    checkedIn: params.checkedInAt !== null,
    workspaceState: workspaces[0]
      ? projectWorkspaceState(workspaces[0].state)
      : null,
    participantCount: participantCounts[0]?.value ?? 0,
  };
}

function projectModules(params: {
  manifest: WorkshopManifestV2;
  session: WorkshopSessionRecord;
  progress: WorkshopModuleProgressRecord[];
  participantUserId?: string;
  facilitator: boolean;
  probeReport: CurrentWorkshopProbeReport | null;
}) {
  return params.manifest.modules.map((module, ordinal) => {
    const progress = params.participantUserId
      ? params.progress.find(
          (entry) =>
            entry.userId === params.participantUserId &&
            entry.moduleId === module.id,
        )
      : undefined;
    const released = params.session.releasedModuleIds.includes(module.id);
    const state = progress
      ? projectModuleState(progress.technicalStatus, released)
      : released
        ? "available"
        : "locked";
    const durationMinutes = params.manifest.agenda
      .filter((entry) => entry.moduleId === module.id)
      .reduce((sum, entry) => sum + entry.durationMinutes, 0);
    return {
      id: module.id,
      ordinal,
      title: module.title,
      outcome: module.outcome,
      tier: module.tier,
      durationMinutes,
      dependsOn: module.dependsOn,
      state,
      health: progress?.currentHealth ?? "unknown",
      released,
      contentMarkdown:
        released || params.facilitator
          ? projectWorkshopMarkdown(
              module.participantMarkdown,
              params.session.id,
            )
          : null,
      facilitatorNotesMarkdown: params.facilitator
        ? projectWorkshopMarkdown(
            module.facilitatorNotesMarkdown,
            params.session.id,
          )
        : null,
      solutionMarkdown:
        params.facilitator ||
        (released &&
          params.session.revealedSolutionModuleIds.includes(module.id))
          ? projectWorkshopMarkdown(module.solutionMarkdown, params.session.id)
          : null,
      solutionRevealed:
        released &&
        params.session.revealedSolutionModuleIds.includes(module.id),
      explainBackPrompt:
        released || params.facilitator
          ? (module.explainBackPrompt ?? null)
          : null,
      explainBackCompletedAt: progress?.explainBackCompletedAt ?? null,
      verifiedAt: progress?.firstVerifiedAt ?? null,
      hints: module.hints.map((hint, hintOrdinal) => {
        const revealed =
          params.facilitator ||
          (released && Boolean(progress?.revealedHintIds.includes(hint.id)));
        return {
          id: hint.id,
          title:
            released || params.facilitator
              ? (hint.title ?? `Hint ${hintOrdinal + 1}`)
              : `Hint ${hintOrdinal + 1}`,
          bodyMarkdown: revealed
            ? projectWorkshopMarkdown(hint.bodyMarkdown, params.session.id)
            : null,
          revealed,
        };
      }),
      probes: module.probeIds.map((probeId) => {
        const snapshot = params.probeReport?.probes.get(probeId);
        return {
          id: probeId,
          label: probeId,
          status:
            snapshot?.status ??
            (params.probeReport?.hasValidReport
              ? ("pending" as const)
              : progress?.currentHealth === "passing"
                ? ("pass" as const)
                : progress?.currentHealth === "failing"
                  ? ("fail" as const)
                  : ("unknown" as const)),
          detail: snapshot?.detail ?? null,
        };
      }),
    };
  });
}

function projectProjectorModules(
  manifest: WorkshopManifestV2,
  session: WorkshopSessionRecord,
) {
  return projectModules({
    manifest,
    session,
    progress: [],
    facilitator: false,
    probeReport: null,
  })
    .filter((module) => module.released)
    .map((module) => ({
      ...module,
      dependsOn: [],
      health: "unknown" as const,
      contentMarkdown: null,
      facilitatorNotesMarkdown: null,
      solutionMarkdown: null,
      solutionRevealed: false,
      explainBackPrompt: null,
      explainBackCompletedAt: null,
      verifiedAt: null,
      hints: [],
      probes: [],
    }));
}

function projectAgenda(params: {
  manifest: WorkshopManifestV2;
  session: WorkshopSessionRecord;
  progress: WorkshopModuleProgressRecord[];
}) {
  return params.manifest.agenda.map((item, ordinal) => {
    const released = item.moduleId
      ? params.session.releasedModuleIds.includes(item.moduleId)
      : item.release === "automatic"
        ? params.session.state !== "draft"
        : params.session.currentSlideId !== null &&
          item.slideIds.includes(params.session.currentSlideId);
    const progress = item.moduleId
      ? params.progress.find((entry) => entry.moduleId === item.moduleId)
      : undefined;
    return {
      id: item.id,
      ordinal,
      kind: item.kind,
      title: item.title,
      durationMinutes: item.durationMinutes,
      scheduled: item.scheduled,
      moduleId: item.moduleId ?? null,
      slideIds: item.slideIds,
      released,
      active:
        params.session.currentAgendaItemId === item.id ||
        (params.session.currentAgendaItemId === null &&
          ((item.moduleId !== undefined &&
            item.moduleId === params.session.currentModuleId) ||
            (params.session.currentModuleId === null &&
              params.session.currentSlideId !== null &&
              item.slideIds.includes(params.session.currentSlideId)))),
      completed: progress
        ? isCompletedTechnicalStatus(progress.technicalStatus)
        : false,
    };
  });
}

function projectSlides(
  manifest: WorkshopManifestV2,
  session: WorkshopSessionRecord,
  facilitator: boolean,
) {
  return manifest.presentation.slides.map((slide, ordinal) => {
    const opensAutomatically = manifest.agenda.some(
      (item) =>
        item.slideIds.includes(slide.id) && item.release === "automatic",
    );
    const participantReleased = slide.moduleId
      ? session.releasedModuleIds.includes(slide.moduleId)
      : opensAutomatically
        ? session.state !== "draft"
        : slide.id === session.currentSlideId;
    const released = facilitator || participantReleased;
    return {
      id: slide.id,
      ordinal,
      layout: projectSlideLayout(slide.layout),
      title: slide.title ?? null,
      bodyMarkdown: released
        ? projectWorkshopMarkdown(slide.bodyMarkdown, session.id)
        : null,
      notesMarkdown: facilitator
        ? slide.notesMarkdown
          ? projectWorkshopMarkdown(slide.notesMarkdown, session.id)
          : null
        : null,
      moduleId: slide.moduleId ?? null,
      released,
    };
  });
}

function projectProjectorSlides(
  slides: ReturnType<typeof projectSlides>,
  currentSlideId: string | null,
) {
  return slides.map((slide) => {
    const released = slide.id === currentSlideId && slide.released;
    return {
      ...slide,
      bodyMarkdown: released ? slide.bodyMarkdown : null,
      notesMarkdown: null,
      released,
    };
  });
}

async function loadWorkshopWorkspaces(
  sessionId: string,
): Promise<WorkshopWorkspaceRecord[]> {
  const db = workshopDb();
  const workspaces = await db
    .select()
    .from(workshopWorkspaces)
    .where(eq(workshopWorkspaces.sessionId, sessionId));
  if (!workspaces.length) return [];
  const generations = await db
    .select()
    .from(workshopWorkspaceGenerations)
    .where(
      inArray(
        workshopWorkspaceGenerations.workspaceId,
        workspaces.map((workspace) => workspace.id),
      ),
    )
    .orderBy(desc(workshopWorkspaceGenerations.ordinal));
  return workspaces.map((workspace) => ({
    id: workspace.id,
    sessionId: workspace.sessionId,
    userId: workspace.userId,
    state: workspace.state,
    currentGenerationId: workspace.currentGenerationId,
    lastCheckpointId: workspace.lastCheckpointId,
    recoveryMessage: workspace.recoveryMessage,
    endedAt: workspace.endedAt,
    generations: generations
      .filter((generation) => generation.workspaceId === workspace.id)
      .map((generation) => ({
        id: generation.id,
        ordinal: generation.ordinal,
        runtimeExecutionId: generation.runtimeExecutionId,
        checkpointId: generation.checkpointId,
        hostId: generation.hostId,
        state: generation.state,
        error: generation.error,
        requestedAt: generation.requestedAt,
        provisioningStartedAt: generation.provisioningStartedAt,
        readyAt: generation.readyAt,
        archiveRequestedAt: generation.archiveRequestedAt,
        archivedAt: generation.archivedAt,
        failedAt: generation.failedAt,
      })),
  }));
}

function projectWorkspace(
  workspace: WorkshopWorkspaceRecord,
  manifest: WorkshopManifestV2,
  releasedModuleIds: string[],
) {
  const generation =
    workspace.generations.find(
      (entry) => entry.id === workspace.currentGenerationId,
    ) ?? workspace.generations[0];
  return {
    id: workspace.id,
    state: projectWorkspaceState(workspace.state),
    generation: generation?.ordinal ?? 0,
    checkpointId:
      generation?.checkpointId ??
      workspace.lastCheckpointId ??
      manifest.workspace.initialCheckpointId,
    vmName: manifest.workspace.vms[0]?.name ?? "workspace",
    terminalAvailable:
      workspace.state === "ready" && Boolean(generation?.runtimeExecutionId),
    lastHealthyAt: generation?.readyAt ?? null,
    recoveryMessage: workspace.recoveryMessage,
    applications: manifest.workspace.applications.map((application) => ({
      id: application.id,
      label: application.label,
      url: null,
      available:
        workspace.state === "ready" &&
        Boolean(generation?.runtimeExecutionId) &&
        (!application.releaseModuleId ||
          releasedModuleIds.includes(application.releaseModuleId)),
      releaseModuleId: application.releaseModuleId ?? null,
    })),
  };
}

function projectRosterMember(params: {
  member: Awaited<ReturnType<typeof listWorkshopRoster>>[number];
  progress: WorkshopModuleProgressRecord[];
  workspace: WorkshopWorkspaceRecord | null;
  helpRequest:
    | Awaited<ReturnType<typeof listWorkshopHelpRequests>>[number]
    | null;
  assistGrant:
    | Awaited<ReturnType<typeof listActiveWorkshopAssistGrants>>[number]
    | null;
  viewerUserId: string;
  session: WorkshopSessionRecord;
  manifest: WorkshopManifestV2;
  probeReport: CurrentWorkshopProbeReport | null;
  observedAt: number;
}) {
  const working = params.progress.find(
    (progress) => progress.technicalStatus === "working",
  );
  return {
    userId: params.member.userId,
    name: params.member.name,
    role: params.member.role,
    workspaceEnabled: params.member.workspaceEnabled,
    checkedInAt: params.member.checkedInAt,
    lastSeenAt: params.member.lastSeenAt,
    presenceState: workshopPresenceState(
      params.member.lastSeenAt,
      params.observedAt,
    ),
    provisionState: params.member.provisionState,
    provisionError: params.member.provisionError,
    workspaceState: params.workspace
      ? projectWorkspaceState(params.workspace.state)
      : null,
    currentModuleId: working?.moduleId ?? params.session.currentModuleId,
    helpState:
      params.helpRequest?.status === "claimed"
        ? ("claimed" as const)
        : params.helpRequest?.status === "open"
          ? ("open" as const)
          : ("none" as const),
    helpAssignedToViewer:
      params.helpRequest?.status === "claimed" &&
      params.helpRequest.claimedBy === params.viewerUserId,
    assistGrant: params.assistGrant
      ? {
          id: params.assistGrant.id,
          workspaceId: params.assistGrant.workspaceId,
          expiresAt: params.assistGrant.expiresAt,
        }
      : null,
    progress: params.manifest.modules.map((module) => {
      const progress = params.progress.find(
        (entry) => entry.moduleId === module.id,
      );
      const released = params.session.releasedModuleIds.includes(module.id);
      return {
        moduleId: module.id,
        state: progress
          ? projectModuleState(progress.technicalStatus, released)
          : released
            ? ("available" as const)
            : ("locked" as const),
        health: progress?.currentHealth ?? ("unknown" as const),
        explainBackStatus:
          progress?.explainBackStatus ??
          (module.explainBackPrompt
            ? ("pending" as const)
            : ("not_required" as const)),
        probes: module.probeIds.map((probeId) => {
          const snapshot = params.probeReport?.probes.get(probeId);
          return {
            id: probeId,
            label: probeId,
            status:
              snapshot?.status ??
              (params.probeReport?.hasValidReport
                ? ("pending" as const)
                : ("unknown" as const)),
            detail: snapshot?.detail ?? null,
          };
        }),
      };
    }),
  };
}

interface CurrentWorkshopProbeSnapshot {
  status: "pass" | "fail" | "unknown";
  detail: string | null;
  checkedAt: number;
  observedAt: number;
}

interface CurrentWorkshopProbeReport {
  hasValidReport: boolean;
  probes: Map<string, CurrentWorkshopProbeSnapshot>;
}

async function loadCurrentWorkshopProbeReports(params: {
  sessionId: string;
  manifest: WorkshopManifestV2;
  userId?: string;
}): Promise<Map<string, CurrentWorkshopProbeReport>> {
  const db = workshopDb();
  const workspaceScope = params.userId
    ? and(
        eq(workshopWorkspaces.sessionId, params.sessionId),
        eq(workshopWorkspaces.userId, params.userId),
      )
    : eq(workshopWorkspaces.sessionId, params.sessionId);
  const [vmRows, providerRows] = await Promise.all([
    db
      .select({
        userId: workshopWorkspaces.userId,
        executionId: runtimeVmActualState.executionId,
        runtimeVmName: runtimeVms.runtimeVmName,
        report: runtimeVmActualState.reportJson,
        observedAt: runtimeVmActualState.observedAt,
      })
      .from(workshopWorkspaces)
      .innerJoin(
        workshopWorkspaceGenerations,
        and(
          eq(
            workshopWorkspaceGenerations.id,
            workshopWorkspaces.currentGenerationId,
          ),
          eq(workshopWorkspaceGenerations.workspaceId, workshopWorkspaces.id),
        ),
      )
      .innerJoin(
        runtimeVmActualState,
        eq(
          runtimeVmActualState.executionId,
          workshopWorkspaceGenerations.runtimeExecutionId,
        ),
      )
      .innerJoin(
        runtimeVms,
        and(
          eq(runtimeVms.id, runtimeVmActualState.runtimeVmId),
          eq(
            runtimeVms.executionId,
            workshopWorkspaceGenerations.runtimeExecutionId,
          ),
        ),
      )
      .where(workspaceScope),
    db
      .select({
        userId: workshopWorkspaces.userId,
        probes: runtimeGuestReports.probesJson,
        observedAt: runtimeActualState.observedAt,
      })
      .from(workshopWorkspaces)
      .innerJoin(
        workshopWorkspaceGenerations,
        and(
          eq(
            workshopWorkspaceGenerations.id,
            workshopWorkspaces.currentGenerationId,
          ),
          eq(workshopWorkspaceGenerations.workspaceId, workshopWorkspaces.id),
        ),
      )
      .innerJoin(
        runtimeActualState,
        and(
          eq(
            runtimeActualState.executionId,
            workshopWorkspaceGenerations.runtimeExecutionId,
          ),
          eq(
            runtimeActualState.generation,
            workshopWorkspaceGenerations.ordinal,
          ),
        ),
      )
      .innerJoin(
        runtimeGuestReports,
        and(
          eq(runtimeGuestReports.id, runtimeActualState.latestReportId),
          eq(runtimeGuestReports.executionId, runtimeActualState.executionId),
        ),
      )
      .where(workspaceScope),
  ]);
  const knownProbeIds = new Set(
    params.manifest.modules.flatMap((module) => module.probeIds),
  );
  const reports = new Map<string, CurrentWorkshopProbeReport>();

  for (const row of vmRows) {
    const parsed = parseCurrentWorkshopProbeReport({
      report: row.report,
      executionId: row.executionId,
      runtimeVmName: row.runtimeVmName,
      observedAt: row.observedAt,
      knownProbeIds,
    });
    mergeCurrentWorkshopProbeReport(reports, row.userId, parsed);
  }

  for (const row of providerRows) {
    const parsed = parseCurrentProviderProbeReport({
      probes: row.probes,
      observedAt: row.observedAt,
      knownProbeIds,
    });
    mergeCurrentWorkshopProbeReport(reports, row.userId, parsed);
  }

  return reports;
}

function mergeCurrentWorkshopProbeReport(
  reports: Map<string, CurrentWorkshopProbeReport>,
  userId: string,
  parsed: Map<string, CurrentWorkshopProbeSnapshot> | null,
): void {
  if (!parsed) return;
  const aggregate = reports.get(userId) ?? {
    hasValidReport: false,
    probes: new Map<string, CurrentWorkshopProbeSnapshot>(),
  };
  aggregate.hasValidReport = true;
  for (const [probeId, snapshot] of parsed) {
    const existing = aggregate.probes.get(probeId);
    if (
      !existing ||
      snapshot.checkedAt > existing.checkedAt ||
      (snapshot.checkedAt === existing.checkedAt &&
        snapshot.observedAt >= existing.observedAt)
    ) {
      aggregate.probes.set(probeId, snapshot);
    }
  }
  reports.set(userId, aggregate);
}

function parseCurrentProviderProbeReport(params: {
  probes: unknown;
  observedAt: number;
  knownProbeIds: ReadonlySet<string>;
}): Map<string, CurrentWorkshopProbeSnapshot> | null {
  if (!Array.isArray(params.probes)) return null;
  const snapshots = new Map<string, CurrentWorkshopProbeSnapshot>();
  for (const candidate of params.probes) {
    if (!isRecord(candidate)) continue;
    const id = candidate.id;
    const status = candidate.status;
    const checkedAt = candidate.observed_at_unix_ms;
    const error = candidate.error;
    if (
      typeof id !== "string" ||
      !params.knownProbeIds.has(id) ||
      (status !== "pass" && status !== "fail" && status !== "unknown") ||
      typeof checkedAt !== "number" ||
      !Number.isSafeInteger(checkedAt) ||
      checkedAt < 0 ||
      (error !== undefined && error !== null && typeof error !== "string")
    ) {
      continue;
    }
    const snapshot: CurrentWorkshopProbeSnapshot = {
      status,
      detail: typeof error === "string" ? error : null,
      checkedAt,
      observedAt: params.observedAt,
    };
    const existing = snapshots.get(id);
    if (!existing || snapshot.checkedAt >= existing.checkedAt) {
      snapshots.set(id, snapshot);
    }
  }
  return snapshots;
}

function parseCurrentWorkshopProbeReport(params: {
  report: unknown;
  executionId: string;
  runtimeVmName: string;
  observedAt: number;
  knownProbeIds: ReadonlySet<string>;
}): Map<string, CurrentWorkshopProbeSnapshot> | null {
  if (
    !isRecord(params.report) ||
    params.report.run_id !== params.executionId ||
    params.report.vm_name !== params.runtimeVmName ||
    !Array.isArray(params.report.probes)
  ) {
    return null;
  }
  const snapshots = new Map<string, CurrentWorkshopProbeSnapshot>();
  for (const candidate of params.report.probes) {
    if (!isRecord(candidate)) continue;
    const id = candidate.id;
    const status = candidate.status;
    const phase = candidate.phase;
    const checkedAt = candidate.checked_at_unix_ms;
    const message = candidate.message;
    if (
      typeof id !== "string" ||
      !params.knownProbeIds.has(id) ||
      (phase !== "boot" && phase !== "scenario") ||
      (status !== "pass" && status !== "fail" && status !== "unknown") ||
      typeof checkedAt !== "number" ||
      !Number.isSafeInteger(checkedAt) ||
      checkedAt < 0 ||
      (message !== undefined && message !== null && typeof message !== "string")
    ) {
      continue;
    }
    const snapshot: CurrentWorkshopProbeSnapshot = {
      status,
      detail: typeof message === "string" ? message : null,
      checkedAt,
      observedAt: params.observedAt,
    };
    const existing = snapshots.get(id);
    if (!existing || snapshot.checkedAt >= existing.checkedAt) {
      snapshots.set(id, snapshot);
    }
  }
  return snapshots;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projectModuleState(
  status: WorkshopTechnicalStatus,
  released: boolean,
) {
  if (status === "not_started")
    return released ? ("available" as const) : ("locked" as const);
  return status;
}

function projectWorkspaceState(state: WorkshopWorkspaceState) {
  if (state === "ending") return "ended" as const;
  return state;
}

function projectSlideLayout(
  layout: WorkshopManifestV2["presentation"]["slides"][number]["layout"],
) {
  if (layout === "two_column") return "split" as const;
  if (layout === "image") return "content" as const;
  return layout;
}

function isCompletedTechnicalStatus(status: WorkshopTechnicalStatus) {
  return (
    status === "verified" ||
    status === "caught_up" ||
    status === "manually_completed" ||
    status === "skipped"
  );
}

function projectWorkshopMarkdown(markdown: string, sessionId: string): string {
  return markdown.replaceAll(
    "/_intar/workshop-assets/",
    `/api/workshops/${encodeURIComponent(sessionId)}/assets/`,
  );
}
