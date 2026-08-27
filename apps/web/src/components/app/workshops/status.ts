import type { WorkshopSessionStatusResponse } from "@/lib/workshops/status-contract";
import type { WorkshopSessionResponse } from "./types";

export interface MergeWorkshopSessionStatusResult {
  response: WorkshopSessionResponse;
  requiresFullRefresh: boolean;
}

export interface WorkshopStatusPollVersions {
  request(sessionVersion: number): {
    version: string | null;
    sessionVersion: number;
    managerVersion: string | null;
  };
  commit(status: WorkshopSessionStatusResponse): void;
  reset(): void;
}

/**
 * Keep the conditional-request versions separate from a received status. They
 * become current only after that status was safely merged or a fallback full
 * projection completed. This makes a failed fallback retryable.
 */
export function createWorkshopStatusPollVersions(): WorkshopStatusPollVersions {
  let version: string | null = null;
  let managerVersion: string | null = null;
  return {
    request(sessionVersion: number) {
      return { version, sessionVersion, managerVersion };
    },
    commit(status: WorkshopSessionStatusResponse) {
      version = status.version;
      managerVersion = status.managerVersion;
    },
    reset() {
      version = null;
      managerVersion = null;
    },
  };
}

export async function commitWorkshopStatusAfterFullRefresh(
  versions: WorkshopStatusPollVersions,
  status: WorkshopSessionStatusResponse,
  refresh: () => Promise<boolean>,
): Promise<boolean> {
  const refreshed = await refresh();
  if (!refreshed) return false;
  versions.commit(status);
  return true;
}

/**
 * Merge a status payload into the full room projection already in React Query.
 * A different session version can expose new authored material, so that case
 * deliberately asks the caller for one full projection instead of guessing.
 */
export function mergeWorkshopSessionStatus(
  current: WorkshopSessionResponse,
  status: WorkshopSessionStatusResponse,
): MergeWorkshopSessionStatusResult {
  const previous = current.session;
  if (
    previous.id !== status.session.id ||
    previous.version !== status.session.version ||
    previous.viewer.userId !== status.viewer.userId ||
    previous.viewer.role !== status.viewer.role ||
    previous.viewer.workspaceEnabled !== status.viewer.workspaceEnabled ||
    previous.viewer.canFacilitate !== status.viewer.canFacilitate ||
    previous.viewer.canPresent !== status.viewer.canPresent ||
    previous.viewer.canAssist !== status.viewer.canAssist
  ) {
    return { response: current, requiresFullRefresh: true };
  }

  const nextModules = mergeById(previous.modules, status.modules, (module) =>
    module.id,
  ).map(({ previous: module, status: next }) => ({
    ...module,
    state: next.state,
    health: next.health,
    released: next.released,
    solutionRevealed: next.solutionRevealed,
    explainBackCompletedAt: next.explainBackCompletedAt,
    verifiedAt: next.verifiedAt,
    ...(next.verificationUnavailable === undefined
      ? {}
      : { verificationUnavailable: next.verificationUnavailable }),
    hints: mergeById(module.hints, next.hints, (hint) => hint.id).map(
      ({ previous: hint, status: nextHint }) => ({
        ...hint,
        revealed: nextHint.revealed,
      }),
    ),
    probes: mergeById(module.probes, next.probes, (probe) => probe.id).map(
      ({ previous: probe, status: nextProbe }) => ({
        ...probe,
        status: nextProbe.status,
        detail: nextProbe.detail,
      }),
    ),
  }));
  if (
    status.modules.length !== previous.modules.length ||
    nextModules.length !== previous.modules.length
  ) {
    return { response: current, requiresFullRefresh: true };
  }

  const nextAgenda = mergeById(previous.agenda, status.agenda, (item) =>
    item.id,
  ).map(({ previous: item, status: next }) => ({
    ...item,
    released: next.released,
    active: next.active,
    completed: next.completed,
  }));
  const nextCheckpoints = mergeById(
    previous.checkpoints,
    status.checkpoints,
    (checkpoint) => checkpoint.id,
  ).map(({ previous: checkpoint, status: next }) => ({
    ...checkpoint,
    released: next.released,
  }));
  const nextSlides = mergeById(previous.slides, status.slides, (slide) =>
    slide.id,
  ).map(({ previous: slide, status: next }) => ({
    ...slide,
    released: next.released,
  }));
  if (
    status.agenda.length !== previous.agenda.length ||
    nextAgenda.length !== previous.agenda.length ||
    status.checkpoints.length !== previous.checkpoints.length ||
    nextCheckpoints.length !== previous.checkpoints.length ||
    status.slides.length !== previous.slides.length ||
    nextSlides.length !== previous.slides.length ||
    (previous.workspace === null) !== (status.workspace === null)
  ) {
    return { response: current, requiresFullRefresh: true };
  }

  const nextWorkspace =
    previous.workspace && status.workspace
      ? {
          ...previous.workspace,
          ...status.workspace,
          applications: mergeById(
            previous.workspace.applications,
            status.workspace.applications,
            (application) => application.id,
          ).map(({ previous: application, status: next }) => ({
            ...application,
            available: next.available,
          })),
        }
      : null;
  if (
    previous.workspace &&
    status.workspace &&
    (previous.workspace.id !== status.workspace.id ||
      status.workspace.applications.length !==
        previous.workspace.applications.length ||
      nextWorkspace?.applications.length !== previous.workspace.applications.length)
  ) {
    return { response: current, requiresFullRefresh: true };
  }

  const nextRoster = mergeById(previous.roster, status.roster, (member) =>
    member.userId,
  ).map(({ previous: member, status: next }) => ({
    ...member,
    ...next,
  }));
  if (
    status.roster.length !== previous.roster.length ||
    nextRoster.length !== previous.roster.length
  ) {
    return { response: current, requiresFullRefresh: true };
  }

  return {
    response: {
      session: {
        ...previous,
        state: status.session.state,
        observedAt: status.session.observedAt,
        currentAgendaItemId: status.session.currentAgendaItemId,
        currentModuleId: status.session.currentModuleId,
        currentSlideId: status.session.currentSlideId,
        currentSlideOrdinal: Math.max(
          0,
          previous.slides.findIndex(
            (slide) => slide.id === status.session.currentSlideId,
          ),
        ),
        announcement: status.session.announcement,
        timer: status.session.timer
          ? { observedAt: status.session.observedAt, ...status.session.timer }
          : null,
        viewer: { ...status.viewer },
        modules: nextModules,
        agenda: nextAgenda,
        checkpoints: nextCheckpoints,
        slides: nextSlides,
        workspace: nextWorkspace,
        helpRequest: status.helpRequest,
        assistGrant: status.assistGrant,
        roster: nextRoster,
        ...(status.capacity === undefined ? {} : { capacity: status.capacity }),
      },
    },
    requiresFullRefresh: false,
  };
}

function mergeById<
  Previous extends { id?: string; userId?: string },
  Status extends { id?: string; userId?: string },
>(
  previous: Previous[],
  status: Status[],
  key: (value: Previous) => string,
): Array<{ previous: Previous; status: Status }> {
  const byId = new Map(
    status.map((value) => [
      "id" in value && typeof value.id === "string"
        ? value.id
        : "userId" in value && typeof value.userId === "string"
          ? value.userId
          : "",
      value,
    ]),
  );
  if (previous.length !== status.length) return [];
  const merged = previous.flatMap((value) => {
    const matching = byId.get(key(value));
    return matching ? [{ previous: value, status: matching }] : [];
  });
  return merged.length === previous.length ? merged : [];
}
