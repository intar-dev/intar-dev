import { describe, expect, it } from "vitest";
import type { WorkshopSessionStatusResponse } from "@/lib/workshops/status-contract";
import type { WorkshopSessionResponse } from "./types";
import {
  commitWorkshopStatusAfterFullRefresh,
  createWorkshopStatusPollVersions,
  mergeWorkshopSessionStatus,
} from "./status";

describe("mergeWorkshopSessionStatus", () => {
  it("updates live status without replacing authored room content", () => {
    const merged = mergeWorkshopSessionStatus(fullRoom(), liveStatus());

    expect(merged.requiresFullRefresh).toBe(false);
    expect(merged.response.session.modules[0]?.contentMarkdown).toBe(
      "# Immutable module text",
    );
    expect(merged.response.session.modules[0]?.health).toBe("passing");
    expect(merged.response.session.roster[0]?.presenceState).toBe("present");
    expect(merged.response.session.helpRequest?.state).toBe("claimed");
  });

  it("requires one full projection when the authored session version changes", () => {
    const status = liveStatus();
    status.session.version = 8;

    expect(mergeWorkshopSessionStatus(fullRoom(), status)).toMatchObject({
      requiresFullRefresh: true,
    });
  });

  it("does not advance the conditional version when its fallback full refresh fails", async () => {
    const versions = createWorkshopStatusPollVersions();

    await expect(
      commitWorkshopStatusAfterFullRefresh(versions, liveStatus(), async () => {
        throw new Error("full projection failed");
      }),
    ).rejects.toThrow("full projection failed");
    expect(versions.request(7)).toEqual({
      version: null,
      sessionVersion: 7,
      managerVersion: null,
    });

    // Once a later fallback succeeds, the same status can become conditional.
    await expect(
      commitWorkshopStatusAfterFullRefresh(versions, liveStatus(), async () =>
        true,
      ),
    ).resolves.toBe(true);
    expect(versions.request(7)).toMatchObject({
      version: "status-v1",
      managerVersion: null,
    });
  });
});

function fullRoom(): WorkshopSessionResponse {
  return {
    session: {
      id: "session-a",
      version: 7,
      state: "live",
      observedAt: 100,
      currentAgendaItemId: "agenda-a",
      currentModuleId: "module-a",
      currentSlideId: "slide-a",
      currentSlideOrdinal: 0,
      announcement: null,
      timer: null,
      viewer: {
        userId: "learner-a",
        role: "participant",
        workspaceEnabled: true,
        checkedIn: true,
        canFacilitate: false,
        canPresent: false,
        canAssist: false,
      },
      modules: [
        {
          id: "module-a",
          contentMarkdown: "# Immutable module text",
          hints: [{ id: "hint-a", revealed: false }],
          probes: [{ id: "probe-a", status: "unknown", detail: null }],
        },
      ],
      agenda: [{ id: "agenda-a", released: true, active: true, completed: false }],
      checkpoints: [{ id: "checkpoint-a", released: true }],
      slides: [{ id: "slide-a", released: true }],
      workspace: null,
      helpRequest: null,
      assistGrant: null,
      roster: [
        {
          userId: "learner-a",
          presenceState: "stale",
          progress: [],
        },
      ],
      capacity: null,
    },
  } as unknown as WorkshopSessionResponse;
}

function liveStatus(): WorkshopSessionStatusResponse {
  return {
    version: "status-v1",
    managerVersion: null,
    requiresFullRefresh: false,
    session: {
      id: "session-a",
      version: 7,
      state: "live",
      observedAt: 200,
      currentAgendaItemId: "agenda-a",
      currentModuleId: "module-a",
      currentSlideId: "slide-a",
      releasedModuleIds: ["module-a"],
      revealedSolutionModuleIds: [],
      announcement: null,
      timer: null,
    },
    viewer: {
      userId: "learner-a",
      role: "participant",
      workspaceEnabled: true,
      checkedIn: true,
      canFacilitate: false,
      canPresent: false,
      canAssist: false,
    },
    modules: [
      {
        id: "module-a",
        state: "working",
        health: "passing",
        released: true,
        solutionRevealed: false,
        explainBackCompletedAt: null,
        verifiedAt: null,
        hints: [{ id: "hint-a", revealed: true }],
        probes: [{ id: "probe-a", status: "pass", detail: null }],
      },
    ],
    agenda: [{ id: "agenda-a", released: true, active: true, completed: false }],
    checkpoints: [{ id: "checkpoint-a", released: true }],
    slides: [{ id: "slide-a", released: true }],
    workspace: null,
    helpRequest: {
      id: "help-a",
      state: "claimed",
      message: "Please help",
      moduleId: "module-a",
      requestedAt: 100,
      claimedByName: "Helper",
    },
    assistGrant: null,
    roster: [
      {
        userId: "learner-a",
        name: "Learner",
        role: "participant",
        workspaceEnabled: true,
        checkedInAt: 100,
        lastSeenAt: 200,
        presenceState: "present",
        provisionState: "ready",
        provisionError: null,
        workspaceState: "ready",
        currentModuleId: "module-a",
        helpState: "claimed",
        helpAssignedToViewer: false,
        assistGrant: null,
        progress: [],
      },
    ],
    capacity: null,
  };
}
