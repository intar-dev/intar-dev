/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";

const terminalMocks = vi.hoisted(() => ({
  loadCurrentRuntimeVmTerminalTarget: vi.fn(),
  issueStargateTerminalSession: vi.fn(),
  issueStargateWorkspaceAppSession: vi.fn(),
  deleteStargateRoute: vi.fn(),
  deleteStargateWorkspaceAppRoute: vi.fn(),
}));

vi.mock("@/lib/runtime-executions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/runtime-executions")>()),
  loadCurrentRuntimeVmTerminalTarget:
    terminalMocks.loadCurrentRuntimeVmTerminalTarget,
}));

vi.mock("@/lib/stargate", () => ({
  deleteStargateRoute: terminalMocks.deleteStargateRoute,
  deleteStargateWorkspaceAppRoute:
    terminalMocks.deleteStargateWorkspaceAppRoute,
  issueStargateTerminalSession: terminalMocks.issueStargateTerminalSession,
  issueStargateWorkspaceAppSession:
    terminalMocks.issueStargateWorkspaceAppSession,
  stargateRouteTtlMs: () => 4 * 60 * 60 * 1_000,
}));
import {
  agentHosts,
  member,
  organization,
  organizationProviderConnections,
  runtimeExecutions,
  runtimeVmActualState,
  runtimeVms,
  user,
  userSshKeys,
  workshopAssistGrants,
  workshopEvents,
  workshopHelpRequests,
  workshopSessionMembers,
  workshopSessionCostSummaries,
  workshopSessionRuntimeProviders,
  workshopSessions,
  workshopTemplateRevisions,
  workshopWorkspaceGenerations,
  workshopWorkspaces,
  type ProviderPriceObservation,
  type WorkshopManifestV1,
} from "@/db/schema";
import type { VmActualStateV2 } from "@/generated/bridge";
import { StaticFeatureToggleService } from "@/lib/feature-toggles";
import { POST as createTemplateApi } from "@/pages/api/organizations/[orgId]/workshops/templates/index";
import { POST as createRevisionApi } from "@/pages/api/organizations/[orgId]/workshops/templates/[templateId]/revisions/index";
import { resetD1Database } from "@/test/d1-migrations";
import {
  claimWorkshopHelpRequest,
  closeWorkshopHelpRequest,
  createWorkshopHelpRequest,
  grantWorkshopAssist,
  requireActiveWorkshopAssistGrant,
  revokeWorkshopAssist,
} from "./assistance";
import { createWorkshopCostForecast } from "./cost-storage";
import { performWorkshopSessionAction } from "./actions";
import { issueWorkshopWorkspaceApplication } from "./applications";
import {
  prepareCheckedInWorkshopWorkspaces,
  prepareWorkshopLateJoin,
  recordWorkshopGenerationState,
} from "./provisioning";
import { recordWorkshopModuleObservation } from "./progress";
import { recordWorkshopPresence, workshopPresenceState } from "./presence";
import {
  getOrganizationWorkshopsProjection,
  getWorkshopListProjection,
  getWorkshopSessionProjection,
} from "./projection";
import {
  checkInToWorkshop,
  createWorkshopSession,
  loadWorkshopSession,
  listWorkshopSessionsForUser,
  replaceWorkshopRoster,
  updateWorkshopSession,
} from "./sessions";
import {
  createWorkshopTemplate,
  listWorkshopTemplates,
  publishWorkshopTemplateRevision,
} from "./templates";
import {
  issueWorkshopBrowserTerminalSession,
  issueWorkshopNativeSshSession,
} from "./terminal";

describe("standalone workshops", () => {
  beforeEach(async () => {
    terminalMocks.loadCurrentRuntimeVmTerminalTarget.mockReset();
    terminalMocks.issueStargateTerminalSession.mockReset();
    terminalMocks.issueStargateWorkspaceAppSession.mockReset();
    terminalMocks.deleteStargateRoute.mockReset();
    terminalMocks.deleteStargateWorkspaceAppRoute.mockReset();
    terminalMocks.deleteStargateRoute.mockResolvedValue(undefined);
    terminalMocks.issueStargateTerminalSession.mockImplementation(
      async (input: {
        routeUsername: string;
        expiresAt: Date;
        mode: "browser" | "native";
      }) =>
        input.mode === "native"
          ? {
              routeUsername: input.routeUsername,
              expiresAt: input.expiresAt.getTime(),
              native: {
                authMode: "profile_keys" as const,
                authorizedKeyCount: 1,
                host: "ssh.example.test",
                port: 2222,
                username: input.routeUsername,
                publicHostKeyOpenssh: "ssh-ed25519 gateway-host-key",
                publicHostKeyFingerprintSha256: "SHA256:gateway",
                knownHostsLine: "[ssh.example.test]:2222 ssh-ed25519 key",
                command: `ssh -p 2222 ${input.routeUsername}@ssh.example.test`,
              },
            }
          : {
              routeUsername: input.routeUsername,
              expiresAt: input.expiresAt.getTime(),
              browser: { websocketUrl: "wss://terminal.example.test/session" },
            },
    );
    await resetD1Database();
    await seedIdentityGraph();
  });

  it("isolates private templates and session reads by organization roster", async () => {
    const setup = await createSessionFixture();

    await expect(
      listWorkshopTemplates({ organizationId: "org-b", userId: "owner-b" }),
    ).resolves.toEqual([]);
    await expect(
      getWorkshopSessionProjection({
        sessionId: setup.sessionId,
        userId: "owner-b",
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: "workshop_session_not_found",
    });
    await expect(
      createWorkshopSession({
        organizationId: "org-b",
        actorUserId: "owner-b",
        templateRevisionId: setup.revisionId,
        title: "Cross-tenant session",
        scheduledStartAt: Date.now() + 60_000,
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: "workshop_template_revision_not_found",
    });
  });

  it("records bounded live presence and projects present, stale, and absent states", async () => {
    const setup = await createSessionFixture();
    await expect(
      recordWorkshopPresence({
        sessionId: setup.sessionId,
        userId: "learner-a",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "workshop_presence_closed",
    });

    await openLobby(setup.sessionId);
    const heartbeat = await recordWorkshopPresence({
      sessionId: setup.sessionId,
      userId: "learner-a",
    });
    expect(heartbeat).toMatchObject({
      state: "present",
      observedAt: expect.any(Number),
      lastSeenAt: expect.any(Number),
    });

    const now = Date.now();
    const db = drizzle(env.DB);
    await db.batch([
      db
        .update(workshopSessionMembers)
        .set({ lastSeenAt: now - 60_000 })
        .where(eq(workshopSessionMembers.userId, "helper-a")),
      db
        .update(workshopSessionMembers)
        .set({ lastSeenAt: now - 180_000 })
        .where(eq(workshopSessionMembers.userId, "owner-a")),
    ]);
    const projection = await getWorkshopSessionProjection({
      sessionId: setup.sessionId,
      userId: "owner-a",
    });
    expect(projection.session.observedAt).toEqual(expect.any(Number));
    expect(
      Object.fromEntries(
        projection.session.roster.map((entry) => [
          entry.userId,
          entry.presenceState,
        ]),
      ),
    ).toEqual({
      "helper-a": "stale",
      "learner-a": "present",
      "owner-a": "absent",
    });

    await db.delete(member).where(eq(member.userId, "helper-a"));
    await expect(
      recordWorkshopPresence({
        sessionId: setup.sessionId,
        userId: "helper-a",
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: "workshop_session_not_found",
    });
    expect(workshopPresenceState(null, now)).toBe("absent");
  });

  it("lists immutable revision history and version-checks draft roster edits", async () => {
    const setup = await createSessionFixture();
    await publishWorkshopTemplateRevision({
      organizationId: "org-a",
      templateId: setup.templateId,
      actorUserId: "owner-a",
      sourceRevision: "source-b",
      contentHash: "b".repeat(64),
      manifest: workshopManifest({ summary: "A newer revision." }),
    });
    const organizationView = await getOrganizationWorkshopsProjection({
      organizationId: "org-a",
      userId: "owner-a",
    });
    expect(organizationView.templates[0]).toMatchObject({
      latestRevision: 2,
      revisionCount: 2,
      revisions: [
        { revision: 2, current: true, sourceRevision: "source-b" },
        { revision: 1, current: false, sourceRevision: "source-a" },
      ],
    });
    expect(organizationView.sessions[0]?.draftRoster).toEqual(
      expect.arrayContaining([
        { userId: "owner-a", role: "facilitator" },
        { userId: "learner-a", role: "participant" },
      ]),
    );
    expect(organizationView.sessions[0]?.templateRevisionId).toBe(
      setup.revisionId,
    );

    await performWorkshopSessionAction({
      sessionId: setup.sessionId,
      actorUserId: "owner-a",
      action: "replace_roster",
      expectedVersion: 1,
      payload: {
        members: [
          { userId: "owner-a", role: "facilitator" },
          { userId: "late-a", role: "participant" },
        ],
      },
    });
    const updated = await getWorkshopSessionProjection({
      sessionId: setup.sessionId,
      userId: "owner-a",
    });
    expect(updated.session.version).toBe(2);
    expect(updated.session.roster.map((entry) => entry.userId)).toEqual([
      "late-a",
      "owner-a",
    ]);
    await expect(
      performWorkshopSessionAction({
        sessionId: setup.sessionId,
        actorUserId: "owner-a",
        action: "replace_roster",
        expectedVersion: 1,
        payload: {
          members: [
            { userId: "owner-a", role: "facilitator" },
            { userId: "learner-a", role: "participant" },
          ],
        },
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "workshop_version_conflict",
    });
  });

  it("lets one organization owner facilitate while rostered as the participant", async () => {
    const template = await createTemplateFixture();
    const session = await createWorkshopSession({
      organizationId: "org-a",
      actorUserId: "owner-a",
      templateRevisionId: template.revisionId,
      title: "Single operator canary",
      scheduledStartAt: Date.now() + 60 * 60 * 1_000,
    });

    await expect(
      performWorkshopSessionAction({
        sessionId: session.id,
        actorUserId: "owner-a",
        action: "replace_roster",
        expectedVersion: 1,
        payload: {
          members: [{ userId: "owner-a", role: "participant" }],
        },
      }),
    ).resolves.toEqual({ kind: "updated" });

    const draft = await getWorkshopSessionProjection({
      sessionId: session.id,
      userId: "owner-a",
    });
    expect(draft.session.viewer).toMatchObject({
      role: "participant",
      canFacilitate: true,
      canPresent: true,
      canAssist: false,
    });
    expect(draft.session.roster).toEqual([
      expect.objectContaining({ userId: "owner-a", role: "participant" }),
    ]);
    expect(
      draft.session.modules.find((module) => module.id === "00-setup"),
    ).toMatchObject({
      facilitatorNotesMarkdown: "Help anyone still blocked.",
    });

    await performWorkshopSessionAction({
      sessionId: session.id,
      actorUserId: "owner-a",
      action: "open_lobby",
      expectedVersion: 2,
      payload: {},
    });
    await checkInToWorkshop({ sessionId: session.id, userId: "owner-a" });
    const prepared = await prepareCheckedInWorkshopWorkspaces({
      sessionId: session.id,
      actorUserId: "owner-a",
    });
    expect(prepared.requests).toEqual([
      expect.objectContaining({ participantUserId: "owner-a" }),
    ]);

    const help = await createWorkshopHelpRequest({
      sessionId: session.id,
      userId: "owner-a",
      message: "Need a second pair of eyes.",
    });
    await expect(
      claimWorkshopHelpRequest({
        sessionId: session.id,
        helpRequestId: help.id,
        helperUserId: "owner-a",
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "workshop_helper_required",
    });
  });

  it("does not let an ordinary participant replace the facilitator", async () => {
    const setup = await createSessionFixture();
    await expect(
      replaceWorkshopRoster({
        sessionId: setup.sessionId,
        actorUserId: "owner-a",
        members: [{ userId: "learner-a", role: "participant" }],
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "workshop_facilitator_missing",
    });
  });

  it("projects pinned provider and estimated costs only to organization managers", async () => {
    const setup = await createSessionFixture();
    const now = Date.now();
    const prices: ProviderPriceObservation = {
      currency: "EUR",
      observedAt: now,
      expiresAt: now + 24 * 60 * 60 * 1_000,
      serverType: "cx43",
      locations: ["nbg1", "fsn1", "hel1"].map((location, index) => ({
        location,
        available: true,
        serverHourlyNet: `0.0${index + 4}`,
        serverHourlyGross: `0.0${index + 5}`,
        serverMonthlyNet: "20.00",
        serverMonthlyGross: "24.00",
        ipv4HourlyNet: "0.001",
        ipv4HourlyGross: "0.0012",
        ipv4MonthlyNet: "0.50",
        ipv4MonthlyGross: "0.60",
      })),
    };
    const db = drizzle(env.DB);
    await db.insert(organizationProviderConnections).values({
      id: "hcloud-connection-a",
      organizationId: "org-a",
      providerKind: "hetzner_cloud",
      displayName: "Workshop learner project",
      state: "active",
      projectFingerprint: "project-fingerprint-a",
      sentinelFirewallId: "1234",
      approvedLocationsJson: ["nbg1", "fsn1", "hel1"],
      maxConcurrentServers: 5,
      maxSessionGrossMicros: 10_000_000,
      currency: "EUR",
      lastValidatedAt: now,
      createdBy: "owner-a",
      createdAt: now,
      updatedAt: now,
    });
    await db
      .update(workshopSessionRuntimeProviders)
      .set({
        providerKind: "hetzner_cloud",
        connectionId: "hcloud-connection-a",
        serverType: "cx43",
        hardwareJson: {
          architecture: "x86",
          cores: 8,
          memoryMib: 16_384,
          diskMib: 160 * 1_024,
        },
        permittedLocationsJson: ["nbg1", "fsn1", "hel1"],
        initialPriceObservationJson: prices,
        updatedAt: now,
      })
      .where(eq(workshopSessionRuntimeProviders.sessionId, setup.sessionId));
    await createWorkshopCostForecast({
      sessionId: setup.sessionId,
      priceObservation: prices,
      trigger: "session_created",
      actorUserId: "owner-a",
      now,
    });
    await db.insert(workshopSessionCostSummaries).values({
      sessionId: setup.sessionId,
      currency: "EUR",
      finalNetMicros: 45_000,
      finalGrossMicros: 54_000,
      forecastNetVarianceMicros: 1_000,
      forecastGrossVarianceMicros: 1_200,
      generationCount: 2,
      restoreCount: 1,
      cleanupPendingCount: 0,
      manualCleanupUnverified: false,
      finalizedAt: now,
      updatedAt: now,
    });

    const ownerOrganization = await getOrganizationWorkshopsProjection({
      organizationId: "org-a",
      userId: "owner-a",
    });
    expect(ownerOrganization.sessions[0]).toMatchObject({
      runtimeProvider: {
        kind: "hetzner_cloud",
        connection: {
          id: "hcloud-connection-a",
          displayName: "Workshop learner project",
          state: "active",
          currency: "EUR",
        },
        serverType: "cx43",
        permittedLocations: ["nbg1", "fsn1", "hel1"],
      },
      cost: {
        label: "estimated Hetzner cost",
        latestForecast: { version: 1, participantCount: 1 },
        live: { currency: "EUR" },
        final: {
          currency: "EUR",
          netMicros: 45_000,
          grossMicros: 54_000,
          generationCount: 2,
          restoreCount: 1,
          manualCleanupUnverified: false,
        },
      },
    });
    const ownerRoom = await getWorkshopSessionProjection({
      sessionId: setup.sessionId,
      userId: "owner-a",
    });
    expect(ownerRoom).toMatchObject({
      session: {
        runtimeProvider: {
          kind: "hetzner_cloud",
          serverType: "cx43",
        },
        cost: { latestForecast: { version: 1 } },
      },
    });

    const participantOrganization = await getOrganizationWorkshopsProjection({
      organizationId: "org-a",
      userId: "learner-a",
    });
    expect(participantOrganization.sessions[0]).not.toHaveProperty(
      "runtimeProvider",
    );
    expect(participantOrganization.sessions[0]).not.toHaveProperty("cost");
    const participantRoom = await getWorkshopSessionProjection({
      sessionId: setup.sessionId,
      userId: "learner-a",
    });
    expect(participantRoom.session).not.toHaveProperty("runtimeProvider");
    expect(participantRoom.session).not.toHaveProperty("cost");
    const helperRoom = await getWorkshopSessionProjection({
      sessionId: setup.sessionId,
      userId: "helper-a",
    });
    expect(helperRoom.session).not.toHaveProperty("runtimeProvider");
    expect(helperRoom.session).not.toHaveProperty("cost");
    const ownerProjector = await getWorkshopSessionProjection({
      sessionId: setup.sessionId,
      userId: "owner-a",
      view: "projector",
    });
    expect(ownerProjector.session).not.toHaveProperty("runtimeProvider");
    expect(ownerProjector.session).not.toHaveProperty("cost");
  });

  it("atomically rolls back invalid roster edits and allows one concurrent CAS winner", async () => {
    const setup = await createSessionFixture();
    await expect(
      performWorkshopSessionAction({
        sessionId: setup.sessionId,
        actorUserId: "owner-a",
        action: "replace_roster",
        expectedVersion: 1,
        payload: {
          members: [
            { userId: "owner-a", role: "facilitator" },
            { userId: "owner-b", role: "participant" },
          ],
        },
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "workshop_roster_non_member",
    });
    await expect(loadWorkshopSession(setup.sessionId)).resolves.toMatchObject({
      version: 1,
    });

    const edits = await Promise.allSettled([
      performWorkshopSessionAction({
        sessionId: setup.sessionId,
        actorUserId: "owner-a",
        action: "replace_roster",
        expectedVersion: 1,
        payload: {
          members: [
            { userId: "owner-a", role: "facilitator" },
            { userId: "learner-a", role: "participant" },
          ],
        },
      }),
      performWorkshopSessionAction({
        sessionId: setup.sessionId,
        actorUserId: "owner-a",
        action: "replace_roster",
        expectedVersion: 1,
        payload: {
          members: [
            { userId: "owner-a", role: "facilitator" },
            { userId: "late-a", role: "participant" },
          ],
        },
      }),
    ]);
    expect(
      edits.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(edits.find((result) => result.status === "rejected")).toMatchObject({
      reason: {
        status: 409,
        code: "workshop_version_conflict",
      },
    });

    const session = await getWorkshopSessionProjection({
      sessionId: setup.sessionId,
      userId: "owner-a",
    });
    expect(session.session.version).toBe(2);
    const rosterUserIds = session.session.roster.map((entry) => entry.userId);
    expect(rosterUserIds).toContain("owner-a");
    expect(
      rosterUserIds.includes("learner-a") !== rosterUserIds.includes("late-a"),
    ).toBe(true);
  });

  it("uses the revision lobby default unless session creation overrides it", async () => {
    const template = await createTemplateFixture(
      workshopManifest({ defaultLobbyMinutes: 17 }),
    );
    const scheduledStartAt = Date.now() + 2 * 60 * 60 * 1_000;

    const defaulted = await createWorkshopSession({
      organizationId: "org-a",
      actorUserId: "owner-a",
      templateRevisionId: template.revisionId,
      title: "Manifest default",
      scheduledStartAt,
    });
    expect(defaulted.lobbyOpensAt).toBe(scheduledStartAt - 17 * 60 * 1_000);

    const explicitLobbyOpensAt = scheduledStartAt - 5 * 60 * 1_000;
    const overridden = await createWorkshopSession({
      organizationId: "org-a",
      actorUserId: "owner-a",
      templateRevisionId: template.revisionId,
      title: "Explicit lobby",
      scheduledStartAt,
      lobbyOpensAt: explicitLobbyOpensAt,
    });
    expect(overridden.lobbyOpensAt).toBe(explicitLobbyOpensAt);

    await expect(
      createWorkshopSession({
        organizationId: "org-a",
        actorUserId: "owner-a",
        templateRevisionId: template.revisionId,
        title: "Invalid derived lobby",
        scheduledStartAt: 1,
      }),
    ).rejects.toMatchObject({
      code: "workshop_time_invalid",
    });
  });

  it("opens the lobby and releases gate modules in one optimistic update", async () => {
    const setup = await createSessionFixture();
    await env.DB.prepare(
      `CREATE TRIGGER test_lobby_requires_atomic_gate_release
       BEFORE UPDATE OF state ON workshop_sessions
       WHEN NEW.state = 'lobby'
         AND NOT EXISTS (
           SELECT 1
           FROM json_each(NEW.released_module_ids_json)
           WHERE value = '00-setup'
         )
       BEGIN
         SELECT RAISE(ABORT, 'lobby gate release must be atomic');
       END`,
    ).run();

    await expect(
      performWorkshopSessionAction({
        sessionId: setup.sessionId,
        actorUserId: "owner-a",
        action: "open_lobby",
        expectedVersion: 1,
        payload: {},
      }),
    ).resolves.toEqual({ kind: "updated" });

    const lobby = await loadWorkshopSession(setup.sessionId);
    expect(lobby).toMatchObject({
      state: "lobby",
      version: 2,
      releasedModuleIds: ["00-setup"],
    });

    await expect(
      performWorkshopSessionAction({
        sessionId: setup.sessionId,
        actorUserId: "owner-a",
        action: "announce",
        expectedVersion: 1,
        payload: { message: "stale facilitator update" },
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "workshop_version_conflict",
    });
    await expect(loadWorkshopSession(setup.sessionId)).resolves.toMatchObject({
      state: "lobby",
      version: 2,
      releasedModuleIds: ["00-setup"],
      announcement: null,
    });

    const events = await drizzle(env.DB)
      .select({
        type: workshopEvents.type,
        actorUserId: workshopEvents.actorUserId,
        payload: workshopEvents.payloadJson,
      })
      .from(workshopEvents)
      .where(eq(workshopEvents.sessionId, setup.sessionId));
    expect(events.filter((event) => event.type === "session.lobby")).toEqual([
      {
        type: "session.lobby",
        actorUserId: "owner-a",
        payload: expect.objectContaining({
          previousState: "draft",
          version: 2,
          automatic: false,
          releasedGateModuleIds: ["00-setup"],
        }),
      },
    ]);
    expect(events.some((event) => event.type === "module.gates_released")).toBe(
      false,
    );
  });

  it("withholds unreleased slide bodies from participants and helpers", async () => {
    const setup = await createSessionFixture();

    for (const userId of ["learner-a", "helper-a"]) {
      const projection = await getWorkshopSessionProjection({
        sessionId: setup.sessionId,
        userId,
      });
      expect(projection.session.slides).toEqual([
        expect.objectContaining({
          id: "welcome",
          released: false,
          bodyMarkdown: null,
        }),
        expect.objectContaining({
          id: "core",
          released: false,
          bodyMarkdown: null,
        }),
      ]);
    }

    const lockedCore = (
      await getWorkshopSessionProjection({
        sessionId: setup.sessionId,
        userId: "learner-a",
      })
    ).session.modules.find((module) => module.id === "01-core");
    expect(lockedCore).toMatchObject({
      released: false,
      contentMarkdown: null,
      explainBackPrompt: null,
      hints: [
        {
          id: "inspect-events",
          title: "Hint 1",
          bodyMarkdown: null,
          revealed: false,
        },
      ],
    });

    const facilitator = await getWorkshopSessionProjection({
      sessionId: setup.sessionId,
      userId: "owner-a",
    });
    expect(facilitator.session.slides).toEqual([
      expect.objectContaining({
        id: "welcome",
        released: true,
        bodyMarkdown: "Platform Engineering Workshop",
      }),
      expect.objectContaining({
        id: "core",
        released: true,
        bodyMarkdown: "Reconcile the platform.",
        notesMarkdown: "Release only after the module 01 explain-back.",
      }),
    ]);

    const privateProjector = await getWorkshopSessionProjection({
      sessionId: setup.sessionId,
      userId: "owner-a",
      view: "projector",
    });
    expect(privateProjector.session).toMatchObject({
      agenda: [],
      workspace: null,
      helpRequest: null,
      assistGrant: null,
      roster: [],
      capacity: null,
      viewer: { canFacilitate: false, canPresent: false },
    });
    expect(privateProjector.session.slides).toEqual([
      expect.objectContaining({
        id: "welcome",
        released: false,
        bodyMarkdown: null,
        notesMarkdown: null,
      }),
      expect.objectContaining({
        id: "core",
        released: false,
        bodyMarkdown: null,
        notesMarkdown: null,
      }),
    ]);
    expect(privateProjector.session.modules).toEqual([]);
    expect(JSON.stringify(privateProjector)).not.toContain("learner-a");
    expect(JSON.stringify(privateProjector)).not.toContain("helper-a");
    expect(JSON.stringify(privateProjector)).not.toContain(
      "Release only after the module 01 explain-back.",
    );

    await performWorkshopSessionAction({
      sessionId: setup.sessionId,
      actorUserId: "owner-a",
      action: "open_lobby",
      expectedVersion: 1,
      payload: {},
    });
    const participant = await getWorkshopSessionProjection({
      sessionId: setup.sessionId,
      userId: "learner-a",
    });
    expect(participant.session.slides).toEqual([
      expect.objectContaining({
        id: "welcome",
        released: true,
        bodyMarkdown: "Platform Engineering Workshop",
      }),
      expect.objectContaining({
        id: "core",
        released: false,
        bodyMarkdown: null,
      }),
    ]);
    const liveProjector = await getWorkshopSessionProjection({
      sessionId: setup.sessionId,
      userId: "owner-a",
      view: "projector",
    });
    expect(liveProjector.session.slides).toEqual([
      expect.objectContaining({
        id: "welcome",
        released: false,
        bodyMarkdown: null,
        notesMarkdown: null,
      }),
      expect.objectContaining({
        id: "core",
        released: false,
        bodyMarkdown: null,
        notesMarkdown: null,
      }),
    ]);
    expect(liveProjector.session.modules).toContainEqual(
      expect.objectContaining({
        id: "00-setup",
        outcome: "Confirm the workspace is ready.",
        released: true,
      }),
    );
  });

  it("derives non-module slide release and limits projector data to the synchronized slide", async () => {
    const manifest = workshopManifest();
    manifest.agenda.push(
      {
        id: "automatic-briefing",
        kind: "briefing",
        title: "Working agreement",
        durationMinutes: 0,
        scheduled: false,
        slideIds: ["automatic-briefing"],
        release: "automatic",
      },
      {
        id: "facilitated-demo",
        kind: "demo",
        title: "Facilitator demonstration",
        durationMinutes: 0,
        scheduled: false,
        slideIds: ["facilitated-demo"],
        release: "facilitator",
      },
    );
    manifest.presentation.slides.push(
      {
        id: "automatic-briefing",
        layout: "content",
        title: "Working agreement",
        bodyMarkdown: "Keep evidence visible and explain your decisions.",
        notesMarkdown: "Invite questions before the timer starts.",
      },
      {
        id: "facilitated-demo",
        layout: "content",
        title: "Facilitator demonstration",
        bodyMarkdown: "Watch the shared reconciliation demonstration.",
        notesMarkdown: "Do not show this before the room is ready.",
      },
    );
    const setup = await createSessionFixture(manifest);

    const draft = await getWorkshopSessionProjection({
      sessionId: setup.sessionId,
      userId: "learner-a",
    });
    expect(
      draft.session.slides.find((slide) => slide.id === "automatic-briefing"),
    ).toMatchObject({ released: false, bodyMarkdown: null });
    expect(
      draft.session.slides.find((slide) => slide.id === "facilitated-demo"),
    ).toMatchObject({ released: false, bodyMarkdown: null });

    await performWorkshopSessionAction({
      sessionId: setup.sessionId,
      actorUserId: "owner-a",
      action: "open_lobby",
      expectedVersion: 1,
      payload: {},
    });
    const lobby = await getWorkshopSessionProjection({
      sessionId: setup.sessionId,
      userId: "learner-a",
    });
    expect(
      lobby.session.slides.find((slide) => slide.id === "automatic-briefing"),
    ).toMatchObject({
      released: true,
      bodyMarkdown: "Keep evidence visible and explain your decisions.",
    });
    expect(
      lobby.session.slides.find((slide) => slide.id === "facilitated-demo"),
    ).toMatchObject({ released: false, bodyMarkdown: null });
    expect(
      lobby.session.agenda.find((item) => item.id === "automatic-briefing"),
    ).toMatchObject({ released: true });
    expect(
      lobby.session.agenda.find((item) => item.id === "facilitated-demo"),
    ).toMatchObject({ released: false });

    const waitingProjector = await getWorkshopSessionProjection({
      sessionId: setup.sessionId,
      userId: "owner-a",
      view: "projector",
    });
    expect(
      waitingProjector.session.slides.every((slide) => !slide.released),
    ).toBe(true);

    await performWorkshopSessionAction({
      sessionId: setup.sessionId,
      actorUserId: "owner-a",
      action: "set_slide",
      expectedVersion: 2,
      payload: { slideOrdinal: 3 },
    });
    const participant = await getWorkshopSessionProjection({
      sessionId: setup.sessionId,
      userId: "learner-a",
    });
    expect(participant.session.currentSlideId).toBe("facilitated-demo");
    expect(
      participant.session.slides.find(
        (slide) => slide.id === "facilitated-demo",
      ),
    ).toMatchObject({
      released: true,
      bodyMarkdown: "Watch the shared reconciliation demonstration.",
      notesMarkdown: null,
    });
    expect(
      participant.session.agenda.find((item) => item.id === "facilitated-demo"),
    ).toMatchObject({ released: true });

    const projector = await getWorkshopSessionProjection({
      sessionId: setup.sessionId,
      userId: "owner-a",
      view: "projector",
    });
    expect(projector.session.slides.filter((slide) => slide.released)).toEqual([
      expect.objectContaining({
        id: "facilitated-demo",
        bodyMarkdown: "Watch the shared reconciliation demonstration.",
        notesMarkdown: null,
      }),
    ]);
    expect(
      projector.session.slides.find(
        (slide) => slide.id === "automatic-briefing",
      ),
    ).toMatchObject({ released: false, bodyMarkdown: null });
  });

  it("projects only current-generation named probes and explain-back state to room staff", async () => {
    const setup = await readyWorkspaceFixture();
    const runtime = await seedWorkshopProbeReports({
      workspaceId: setup.workspaceId,
      staleGenerationId: setup.generationId,
    });
    await recordWorkshopModuleObservation({
      sessionId: setup.sessionId,
      participantUserId: "learner-a",
      moduleId: "01-core",
      technicalStatus: "working",
      currentHealth: "failing",
      explainBackStatus: "completed",
    });

    for (const userId of ["owner-a", "helper-a"]) {
      const projection = await getWorkshopSessionProjection({
        sessionId: setup.sessionId,
        userId,
      });
      const learner = projection.session.roster.find(
        (entry) => entry.userId === "learner-a",
      );
      expect(learner?.progress).toContainEqual(
        expect.objectContaining({
          moduleId: "00-setup",
          explainBackStatus: "not_required",
          probes: [
            expect.objectContaining({
              id: "workspace-ready",
              status: "pending",
            }),
          ],
        }),
      );
      expect(learner?.progress).toContainEqual(
        expect.objectContaining({
          moduleId: "01-core",
          health: "failing",
          explainBackStatus: "completed",
          probes: [
            expect.objectContaining({
              id: "service-ready",
              status: "pass",
              detail: "current generation is healthy",
            }),
          ],
        }),
      );
      expect(JSON.stringify(learner?.progress)).not.toContain(
        "undeclared-probe",
      );
    }

    const participant = await getWorkshopSessionProjection({
      sessionId: setup.sessionId,
      userId: "learner-a",
    });
    expect(participant.session.roster).toEqual([]);

    const observedAt = Date.now() + 20_000;
    await drizzle(env.DB)
      .update(runtimeVmActualState)
      .set({
        reportJson: workshopVmProbeReport({
          executionId: runtime.currentExecutionId,
          observedAt,
          probes: [
            probeSnapshot("workspace-ready", "unknown", observedAt),
            probeSnapshot("service-ready", "fail", observedAt),
          ],
        }),
        observedAt,
        updatedAt: observedAt,
      })
      .where(eq(runtimeVmActualState.runtimeVmId, runtime.currentRuntimeVmId));
    const updated = await getWorkshopSessionProjection({
      sessionId: setup.sessionId,
      userId: "owner-a",
    });
    const updatedProgress = updated.session.roster.find(
      (entry) => entry.userId === "learner-a",
    )?.progress;
    expect(updatedProgress).toContainEqual(
      expect.objectContaining({
        moduleId: "00-setup",
        probes: [expect.objectContaining({ status: "unknown" })],
      }),
    );
    expect(updatedProgress).toContainEqual(
      expect.objectContaining({
        moduleId: "01-core",
        probes: [expect.objectContaining({ status: "fail" })],
      }),
    );
  });

  it("revokes live room, terminal, application, and helper access with organization membership", async () => {
    const setup = await readyWorkspaceFixture();
    const help = await createWorkshopHelpRequest({
      sessionId: setup.sessionId,
      userId: "learner-a",
      message: "Please help me inspect this workspace",
    });
    expect(help.status).toBe("open");
    const live = await updateWorkshopSession({
      sessionId: setup.sessionId,
      actorUserId: "owner-a",
      expectedVersion: 2,
      state: "live",
    });
    const db = drizzle(env.DB);
    await db.delete(member).where(eq(member.userId, "learner-a"));
    await db.delete(member).where(eq(member.userId, "helper-a"));

    for (const userId of ["learner-a", "helper-a"]) {
      await expect(
        getWorkshopSessionProjection({ sessionId: setup.sessionId, userId }),
      ).rejects.toMatchObject({
        status: 404,
        code: "workshop_session_not_found",
      });
      await expect(
        issueWorkshopBrowserTerminalSession({
          sessionId: setup.sessionId,
          workspaceId: setup.workspaceId,
          actorUserId: userId,
        }),
      ).rejects.toMatchObject({
        status: 404,
        code: "workshop_session_not_found",
      });
    }
    for (const actorUserId of ["learner-a", "helper-a"]) {
      await expect(
        issueWorkshopWorkspaceApplication({
          sessionId: setup.sessionId,
          workspaceId: setup.workspaceId,
          applicationId: "missing-after-authorization",
          actorUserId,
        }),
      ).rejects.toMatchObject({
        status: 404,
        code: "workshop_session_not_found",
      });
    }
    await expect(
      performWorkshopSessionAction({
        sessionId: setup.sessionId,
        actorUserId: "helper-a",
        action: "claim_help",
        expectedVersion: live.version,
        payload: { userId: "learner-a" },
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: "workshop_session_not_found",
    });
    await expect(
      listWorkshopSessionsForUser({ userId: "learner-a" }),
    ).resolves.toEqual([]);
    await expect(
      listWorkshopSessionsForUser({ userId: "helper-a" }),
    ).resolves.toEqual([]);
  });

  it("preserves ended participant history after organization removal", async () => {
    const setup = await createSessionFixture();
    await openLobby(setup.sessionId);
    const live = await updateWorkshopSession({
      sessionId: setup.sessionId,
      actorUserId: "owner-a",
      expectedVersion: 2,
      state: "live",
    });
    await updateWorkshopSession({
      sessionId: setup.sessionId,
      actorUserId: "owner-a",
      expectedVersion: live.version,
      state: "ended",
    });
    const db = drizzle(env.DB);
    await db.delete(member).where(eq(member.userId, "learner-a"));
    await db.delete(member).where(eq(member.userId, "helper-a"));

    await expect(
      getWorkshopSessionProjection({
        sessionId: setup.sessionId,
        userId: "learner-a",
      }),
    ).resolves.toMatchObject({
      session: {
        id: setup.sessionId,
        state: "ended",
        viewer: { role: "participant" },
      },
    });
    const learnerHistory = await listWorkshopSessionsForUser({
      userId: "learner-a",
    });
    expect(learnerHistory.map((entry) => entry.session.id)).toEqual([
      setup.sessionId,
    ]);
    await expect(
      getWorkshopSessionProjection({
        sessionId: setup.sessionId,
        userId: "helper-a",
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: "workshop_session_not_found",
    });
    await expect(
      listWorkshopSessionsForUser({ userId: "helper-a" }),
    ).resolves.toEqual([]);
  });

  it("rejects direct template and revision publication outside the registry", async () => {
    for (const handler of [createTemplateApi, createRevisionApi]) {
      const response = await handler({} as never);
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET");
      await expect(response.json()).resolves.toMatchObject({
        code: "workshop_registry_publish_required",
      });
    }
  });

  it("filters disabled organizations from the learner workshop list", async () => {
    const setup = await createSessionFixture();
    await expect(
      getWorkshopListProjection(
        "learner-a",
        new StaticFeatureToggleService({ workshops_enabled: false }),
      ),
    ).resolves.toEqual({ sessions: [] });
    const enabled = await getWorkshopListProjection(
      "learner-a",
      new StaticFeatureToggleService({ workshops_enabled: true }),
    );
    expect(enabled.sessions.map((session) => session.id)).toEqual([
      setup.sessionId,
    ]);
  });

  it("publishes immutable revisions and reuses an identical content revision", async () => {
    const setup = await createTemplateFixture();
    const identical = await publishWorkshopTemplateRevision({
      organizationId: "org-a",
      templateId: setup.templateId,
      actorUserId: "owner-a",
      sourceRevision: "source-a",
      contentHash: "a".repeat(64),
      manifest: workshopManifest(),
    });
    expect(identical.id).toBe(setup.revisionId);

    const second = await publishWorkshopTemplateRevision({
      organizationId: "org-a",
      templateId: setup.templateId,
      actorUserId: "owner-a",
      sourceRevision: "source-b",
      contentHash: "b".repeat(64),
      manifest: workshopManifest({ summary: "Second immutable revision" }),
    });
    expect(second.revision).toBe(2);

    await expect(
      drizzle(env.DB)
        .update(workshopTemplateRevisions)
        .set({ sourceRevision: "mutated" })
        .where(eq(workshopTemplateRevisions.id, second.id)),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringMatching(/immutable/),
      }),
    });
  });

  it("allows zero duration only for unscheduled agenda release entries", async () => {
    const valid = workshopManifest();
    valid.agenda[0]!.durationMinutes = 0;
    await expect(
      createWorkshopTemplate({
        organizationId: "org-a",
        actorUserId: "owner-a",
        sourceRevision: "unscheduled-zero",
        contentHash: "d".repeat(64),
        manifest: valid,
      }),
    ).resolves.toMatchObject({
      revision: { manifest: { durationMinutes: 45 } },
    });

    const invalid = workshopManifest();
    invalid.agenda[1]!.durationMinutes = 0;
    invalid.durationMinutes = 0;
    await expect(
      createWorkshopTemplate({
        organizationId: "org-a",
        actorUserId: "owner-a",
        sourceRevision: "scheduled-zero",
        contentHash: "e".repeat(64),
        manifest: invalid,
      }),
    ).rejects.toMatchObject({
      code: "workshop_manifest_invalid",
    });
  });

  it("validates hydrated workshop lobby defaults", async () => {
    const zero = workshopManifest({ defaultLobbyMinutes: 0 });
    await expect(
      createWorkshopTemplate({
        organizationId: "org-a",
        actorUserId: "owner-a",
        sourceRevision: "zero-lobby-default",
        contentHash: "f".repeat(64),
        manifest: zero,
      }),
    ).resolves.toBeDefined();

    const tooLarge = workshopManifest({ defaultLobbyMinutes: 1_441 });
    await expect(
      createWorkshopTemplate({
        organizationId: "org-a",
        actorUserId: "owner-a",
        sourceRevision: "invalid-lobby-default",
        contentHash: "9".repeat(64),
        manifest: tooLarge,
      }),
    ).rejects.toMatchObject({
      code: "workshop_manifest_invalid",
      message: expect.stringMatching(/defaultLobbyMinutes/),
    });
  });

  it("enforces lifecycle transitions and optimistic version conflicts", async () => {
    const setup = await createSessionFixture();
    await expect(
      updateWorkshopSession({
        sessionId: setup.sessionId,
        actorUserId: "owner-a",
        expectedVersion: 1,
        state: "live",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "workshop_state_transition_invalid",
    });

    const lobby = await updateWorkshopSession({
      sessionId: setup.sessionId,
      actorUserId: "owner-a",
      expectedVersion: 1,
      state: "lobby",
    });
    expect(lobby).toMatchObject({ state: "lobby", version: 2 });
    await expect(
      updateWorkshopSession({
        sessionId: setup.sessionId,
        actorUserId: "owner-a",
        expectedVersion: 1,
        announcement: "stale update",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "workshop_version_conflict",
    });

    const live = await updateWorkshopSession({
      sessionId: setup.sessionId,
      actorUserId: "owner-a",
      expectedVersion: 2,
      state: "live",
    });
    expect(live).toMatchObject({ state: "live", version: 3 });
  });

  it("releases core modules sequentially even when HCL dependencies branch", async () => {
    const manifest = workshopManifest();
    manifest.modules.push({
      id: "02-core",
      title: "Second core module",
      tier: "core",
      outcome: "Prove the second core layer.",
      dependsOn: ["00-setup"],
      participantMarkdown: "Build the second core layer.",
      facilitatorNotesMarkdown: "Release only after the first core module.",
      hints: [],
      solutionMarkdown: "Apply the canonical second layer.",
      probeIds: [],
      catchUpCheckpointId: "checkpoint-00",
    });
    manifest.agenda.push({
      id: "second-core",
      kind: "lab",
      title: "Second core module",
      durationMinutes: 0,
      scheduled: false,
      moduleId: "02-core",
      slideIds: ["second-core"],
      release: "facilitator",
    });
    manifest.presentation.slides.push({
      id: "second-core",
      layout: "content",
      title: "Second core module",
      bodyMarkdown: "Build the second core layer.",
      moduleId: "02-core",
    });
    const setup = await createSessionFixture(manifest);
    await performWorkshopSessionAction({
      sessionId: setup.sessionId,
      actorUserId: "owner-a",
      action: "open_lobby",
      expectedVersion: 1,
      payload: {},
    });

    await expect(
      performWorkshopSessionAction({
        sessionId: setup.sessionId,
        actorUserId: "owner-a",
        action: "release_module",
        expectedVersion: 2,
        payload: { moduleId: "02-core" },
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "workshop_core_module_order_locked",
    });
    await performWorkshopSessionAction({
      sessionId: setup.sessionId,
      actorUserId: "owner-a",
      action: "release_module",
      expectedVersion: 2,
      payload: { moduleId: "01-core" },
    });
    await expect(
      performWorkshopSessionAction({
        sessionId: setup.sessionId,
        actorUserId: "owner-a",
        action: "release_module",
        expectedVersion: 3,
        payload: { moduleId: "02-core" },
      }),
    ).resolves.toEqual({ kind: "updated" });
  });

  it("latches verification while reporting later health regression", async () => {
    const setup = await createSessionFixture();
    await openLobby(setup.sessionId);
    const verified = await recordWorkshopModuleObservation({
      sessionId: setup.sessionId,
      participantUserId: "learner-a",
      moduleId: "01-core",
      technicalStatus: "verified",
      currentHealth: "passing",
      explainBackStatus: "completed",
      observedAt: 10_000,
    });
    expect(verified).toMatchObject({
      technicalStatus: "verified",
      currentHealth: "passing",
      explainBackStatus: "completed",
      firstVerifiedAt: 10_000,
    });

    const regressed = await recordWorkshopModuleObservation({
      sessionId: setup.sessionId,
      participantUserId: "learner-a",
      moduleId: "01-core",
      technicalStatus: "working",
      currentHealth: "failing",
      explainBackStatus: "pending",
      observedAt: 20_000,
    });
    expect(regressed).toMatchObject({
      technicalStatus: "verified",
      currentHealth: "failing",
      explainBackStatus: "completed",
      firstVerifiedAt: 10_000,
      healthObservedAt: 20_000,
    });
  });

  it("keeps late-join catch-up distinct from verification and explain-back", async () => {
    const setup = await createSessionFixture();
    await performWorkshopSessionAction({
      sessionId: setup.sessionId,
      actorUserId: "owner-a",
      action: "open_lobby",
      expectedVersion: 1,
      payload: {},
    });
    await performWorkshopSessionAction({
      sessionId: setup.sessionId,
      actorUserId: "owner-a",
      action: "release_module",
      expectedVersion: 2,
      payload: { moduleId: "01-core" },
    });
    await recordWorkshopModuleObservation({
      sessionId: setup.sessionId,
      participantUserId: "learner-a",
      moduleId: "01-core",
      technicalStatus: "caught_up",
      currentHealth: "passing",
      observedAt: 10_000,
    });

    await performWorkshopSessionAction({
      sessionId: setup.sessionId,
      actorUserId: "learner-a",
      action: "complete_explain_back",
      payload: { moduleId: "01-core" },
    });
    const afterExplainBack = await recordWorkshopModuleObservation({
      sessionId: setup.sessionId,
      participantUserId: "learner-a",
      moduleId: "01-core",
      technicalStatus: "verified",
      currentHealth: "passing",
      observedAt: 20_000,
    });
    expect(afterExplainBack).toMatchObject({
      technicalStatus: "caught_up",
      explainBackStatus: "completed",
      firstVerifiedAt: null,
      caughtUpAt: 10_000,
    });
  });

  it("blocks participant module actions and restores until release", async () => {
    const setup = await readyWorkspaceFixture();
    for (const [action, payload] of [
      ["reveal_hint", { moduleId: "01-core", hintId: "inspect-events" }],
      ["complete_explain_back", { moduleId: "01-core" }],
    ] as const) {
      await expect(
        performWorkshopSessionAction({
          sessionId: setup.sessionId,
          actorUserId: "learner-a",
          action,
          payload,
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: "workshop_module_not_released",
      });
    }
    await expect(
      performWorkshopSessionAction({
        sessionId: setup.sessionId,
        actorUserId: "learner-a",
        action: "restore_checkpoint",
        payload: { checkpointId: "01-core", confirmed: true },
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "workshop_checkpoint_not_released",
    });
    await expect(
      performWorkshopSessionAction({
        sessionId: setup.sessionId,
        actorUserId: "owner-a",
        action: "reveal_solution",
        expectedVersion: 2,
        payload: { moduleId: "01-core" },
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "workshop_module_not_released",
    });

    await drizzle(env.DB)
      .update(workshopSessions)
      .set({ revealedSolutionModuleIdsJson: ["01-core"] })
      .where(eq(workshopSessions.id, setup.sessionId));
    const participant = await getWorkshopSessionProjection({
      sessionId: setup.sessionId,
      userId: "learner-a",
    });
    expect(
      participant.session.modules.find((module) => module.id === "01-core"),
    ).toMatchObject({
      released: false,
      solutionMarkdown: null,
      solutionRevealed: false,
    });
  });

  it("focuses and times non-module agenda items with CAS and terminal immutability", async () => {
    const manifest = workshopManifest();
    manifest.agenda.unshift({
      id: "opening",
      kind: "briefing",
      title: "Opening briefing",
      durationMinutes: 10,
      scheduled: true,
      slideIds: ["opening-slide"],
      release: "facilitator",
    });
    manifest.presentation.slides.unshift({
      id: "opening-slide",
      layout: "title",
      title: "Opening briefing",
      bodyMarkdown: "Welcome to the workshop.",
    });
    manifest.durationMinutes += 10;
    const setup = await createSessionFixture(manifest);
    await openLobby(setup.sessionId);
    await performWorkshopSessionAction({
      sessionId: setup.sessionId,
      actorUserId: "owner-a",
      action: "go_live",
      expectedVersion: 2,
      payload: {},
    });
    await performWorkshopSessionAction({
      sessionId: setup.sessionId,
      actorUserId: "owner-a",
      action: "focus_agenda",
      expectedVersion: 3,
      payload: { agendaItemId: "opening" },
    });

    const focused = await getWorkshopSessionProjection({
      sessionId: setup.sessionId,
      userId: "owner-a",
    });
    expect(focused.session).toMatchObject({
      version: 4,
      currentAgendaItemId: "opening",
      currentModuleId: null,
      currentSlideId: "opening-slide",
      timer: {
        startedAt: expect.any(Number),
        endsAt: expect.any(Number),
      },
    });
    expect(focused.session.agenda[0]).toMatchObject({ active: true });
    expect(
      (focused.session.timer?.endsAt ?? 0) -
        (focused.session.timer?.startedAt ?? 0),
    ).toBe(10 * 60 * 1_000);

    await expect(
      performWorkshopSessionAction({
        sessionId: setup.sessionId,
        actorUserId: "owner-a",
        action: "focus_agenda",
        expectedVersion: 3,
        payload: { agendaItemId: "opening" },
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "workshop_version_conflict",
    });
    await performWorkshopSessionAction({
      sessionId: setup.sessionId,
      actorUserId: "owner-a",
      action: "end_session",
      expectedVersion: 4,
      payload: {},
    });
    await expect(
      performWorkshopSessionAction({
        sessionId: setup.sessionId,
        actorUserId: "owner-a",
        action: "release_module",
        expectedVersion: 5,
        payload: { moduleId: "01-core" },
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "workshop_session_terminal",
    });
  });

  it("rejects cumulative stretch checkpoints until the full prefix is released", async () => {
    const manifest = workshopManifest();
    manifest.workspace.checkpoints.push(
      workshopCheckpoint("checkpoint-01", "checkpoint-01", "d"),
      workshopCheckpoint("checkpoint-06", "checkpoint-06", "e"),
      workshopCheckpoint("checkpoint-07", "checkpoint-07", "f"),
    );
    manifest.modules[1]!.catchUpCheckpointId = "checkpoint-01";
    manifest.modules.push(
      stretchModule("06-stretch", "checkpoint-06"),
      stretchModule("07-stretch", "checkpoint-07"),
    );
    manifest.agenda.push(
      stretchAgenda("06-stretch"),
      stretchAgenda("07-stretch"),
    );
    manifest.presentation.slides.push(
      stretchSlide("06-stretch"),
      stretchSlide("07-stretch"),
    );
    const template = await createTemplateFixture(manifest);
    const session = await createWorkshopSession({
      organizationId: "org-a",
      actorUserId: "owner-a",
      templateRevisionId: template.revisionId,
      title: "Branched stretch session",
      scheduledStartAt: Date.now() + 60 * 60 * 1_000,
    });
    await replaceWorkshopRoster({
      sessionId: session.id,
      actorUserId: "owner-a",
      members: [
        { userId: "owner-a", role: "facilitator" },
        { userId: "learner-a", role: "participant" },
        { userId: "late-a", role: "participant" },
      ],
    });
    await openLobby(session.id);
    await checkInToWorkshop({ sessionId: session.id, userId: "learner-a" });
    const prepared = await prepareCheckedInWorkshopWorkspaces({
      sessionId: session.id,
      actorUserId: "owner-a",
    });
    const request = prepared.requests[0];
    if (!request) throw new Error("workspace request missing");
    await recordWorkshopGenerationState({
      generationId: request.generationId,
      update: {
        state: "ready",
        runtimeExecutionId: `runtime-${request.generationId}`,
        hostId: "host-a",
      },
    });
    for (const [expectedVersion, moduleId] of [
      [2, "00-setup"],
      [3, "01-core"],
      [4, "07-stretch"],
    ] as const) {
      await performWorkshopSessionAction({
        sessionId: session.id,
        actorUserId: "owner-a",
        action: "release_module",
        expectedVersion,
        payload: { moduleId },
      });
    }

    await expect(
      performWorkshopSessionAction({
        sessionId: session.id,
        actorUserId: "learner-a",
        action: "restore_checkpoint",
        payload: { checkpointId: "checkpoint-07", confirmed: true },
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "workshop_checkpoint_not_released",
    });
    await expect(
      performWorkshopSessionAction({
        sessionId: session.id,
        actorUserId: "owner-a",
        action: "catch_up_participant",
        expectedVersion: 5,
        payload: {
          participantUserId: "late-a",
          checkpointId: "checkpoint-07",
        },
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "workshop_checkpoint_not_released",
    });
    await expect(
      prepareWorkshopLateJoin({
        sessionId: session.id,
        actorUserId: "owner-a",
        participantUserId: "late-a",
        checkpointId: "checkpoint-00",
      }),
    ).resolves.toMatchObject({ checkpointId: "checkpoint-00" });
  });

  it("rolls roster replacement back if provisioning wins the race", async () => {
    const setup = await createSessionFixture();
    const db = drizzle(env.DB);
    await db
      .update(workshopSessionMembers)
      .set({ updatedAt: 1 })
      .where(eq(workshopSessionMembers.sessionId, setup.sessionId));
    const before = await db
      .select({
        userId: workshopSessionMembers.userId,
        role: workshopSessionMembers.role,
        updatedAt: workshopSessionMembers.updatedAt,
      })
      .from(workshopSessionMembers)
      .where(eq(workshopSessionMembers.sessionId, setup.sessionId));
    await env.DB.prepare(
      `CREATE TRIGGER test_roster_provisioning_race
       AFTER UPDATE OF updated_at ON workshop_session_members
       WHEN OLD.user_id = 'owner-a'
         AND NOT EXISTS (
           SELECT 1 FROM workshop_workspaces w
           WHERE w.session_id = OLD.session_id
         )
       BEGIN
         INSERT INTO workshop_workspaces (id, session_id, user_id)
         VALUES ('race-workspace', OLD.session_id, 'learner-a');
       END`,
    ).run();

    await expect(
      replaceWorkshopRoster({
        sessionId: setup.sessionId,
        actorUserId: "owner-a",
        expectedVersion: 1,
        draftOnly: true,
        members: [
          { userId: "owner-a", role: "facilitator" },
          { userId: "learner-a", role: "participant" },
        ],
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining(
          "workshop roster is immutable after workspace provisioning starts",
        ),
      }),
    });

    const [after, workspaces] = await Promise.all([
      db
        .select({
          userId: workshopSessionMembers.userId,
          role: workshopSessionMembers.role,
          updatedAt: workshopSessionMembers.updatedAt,
        })
        .from(workshopSessionMembers)
        .where(eq(workshopSessionMembers.sessionId, setup.sessionId)),
      db
        .select({ id: workshopWorkspaces.id })
        .from(workshopWorkspaces)
        .where(eq(workshopWorkspaces.sessionId, setup.sessionId)),
    ]);
    expect(after).toEqual(before);
    expect(workspaces).toEqual([]);
    await expect(loadWorkshopSession(setup.sessionId)).resolves.toMatchObject({
      version: 1,
    });
  });

  it("freezes the roster after workspace provisioning starts", async () => {
    const setup = await readyWorkspaceFixture();
    await expect(
      replaceWorkshopRoster({
        sessionId: setup.sessionId,
        actorUserId: "owner-a",
        members: [
          { userId: "owner-a", role: "facilitator" },
          { userId: "helper-a", role: "helper" },
        ],
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "workshop_roster_provisioned",
    });
  });

  it("atomically protects roster membership and roles after provisioning", async () => {
    const setup = await readyWorkspaceFixture();
    const db = drizzle(env.DB);
    const now = Date.now();

    await expect(
      db.insert(workshopSessionMembers).values({
        id: "roster-late-a",
        sessionId: setup.sessionId,
        userId: "late-a",
        role: "participant",
        assignedBy: "owner-a",
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining(
          "workshop roster is immutable after workspace provisioning starts",
        ),
      }),
    });
    await expect(
      db
        .update(workshopSessionMembers)
        .set({ role: "participant", updatedAt: now })
        .where(eq(workshopSessionMembers.userId, "helper-a")),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining(
          "workshop roster is immutable after workspace provisioning starts",
        ),
      }),
    });
    await expect(
      db
        .delete(workshopSessionMembers)
        .where(eq(workshopSessionMembers.userId, "helper-a")),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining(
          "workshop roster is immutable after workspace provisioning starts",
        ),
      }),
    });

    await expect(
      db
        .update(workshopSessionMembers)
        .set({ checkedInAt: now, updatedAt: now })
        .where(eq(workshopSessionMembers.userId, "helper-a")),
    ).resolves.toBeDefined();
  });

  it("requires learner consent, caps assist access at 30 minutes, and revokes immediately", async () => {
    const setup = await readyWorkspaceFixture();
    const help = await createWorkshopHelpRequest({
      sessionId: setup.sessionId,
      userId: "learner-a",
      moduleId: "01-core",
      message: "My reconciliation loop is stuck",
    });
    await claimWorkshopHelpRequest({
      sessionId: setup.sessionId,
      helpRequestId: help.id,
      helperUserId: "helper-a",
    });
    const grant = await grantWorkshopAssist({
      sessionId: setup.sessionId,
      helpRequestId: help.id,
      learnerUserId: "learner-a",
    });
    expect(grant.expiresAt - grant.grantedAt).toBe(15 * 60 * 1_000);
    await expect(
      requireActiveWorkshopAssistGrant({
        sessionId: setup.sessionId,
        workspaceId: setup.workspaceId,
        helperUserId: "helper-a",
        now: grant.expiresAt - 1,
      }),
    ).resolves.toMatchObject({ id: grant.id, active: true });
    await expect(
      requireActiveWorkshopAssistGrant({
        sessionId: setup.sessionId,
        workspaceId: setup.workspaceId,
        helperUserId: "helper-a",
        now: grant.expiresAt,
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "workshop_assist_grant_required",
    });

    await expect(
      performWorkshopSessionAction({
        sessionId: setup.sessionId,
        actorUserId: "helper-a",
        action: "extend_assist",
        payload: { grantId: grant.id },
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "workshop_assist_owner_required",
    });
    await performWorkshopSessionAction({
      sessionId: setup.sessionId,
      actorUserId: "learner-a",
      action: "extend_assist",
      payload: { grantId: grant.id },
    });
    const [extended] = await drizzle(env.DB)
      .select()
      .from(workshopAssistGrants)
      .where(eq(workshopAssistGrants.id, grant.id));
    if (!extended) throw new Error("extended assistance grant missing");
    expect(extended.expiresAt - extended.grantedAt).toBe(30 * 60 * 1_000);
    await performWorkshopSessionAction({
      sessionId: setup.sessionId,
      actorUserId: "learner-a",
      action: "extend_assist",
      payload: { grantId: grant.id },
    });
    const extensionEvents = await drizzle(env.DB)
      .select()
      .from(workshopEvents)
      .where(eq(workshopEvents.type, "assist.extended"));
    expect(extensionEvents).toEqual([
      expect.objectContaining({
        actorUserId: "learner-a",
        payloadJson: expect.objectContaining({
          grantId: grant.id,
          helperUserId: "helper-a",
          expiresAt: extended.expiresAt,
        }),
      }),
    ]);
    await expect(
      getWorkshopSessionProjection({
        sessionId: setup.sessionId,
        userId: "learner-a",
      }),
    ).resolves.toMatchObject({
      session: { assistGrant: { id: grant.id, canExtend: false } },
    });
    const revoked = await revokeWorkshopAssist({
      sessionId: setup.sessionId,
      grantId: grant.id,
      actorUserId: "learner-a",
    });
    expect(revoked.revokedAt).not.toBeNull();
    await expect(
      requireActiveWorkshopAssistGrant({
        sessionId: setup.sessionId,
        workspaceId: setup.workspaceId,
        helperUserId: "helper-a",
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("lets only the assigned helper resolve a claimed request and audits the action", async () => {
    const setup = await createSessionFixture();
    await openLobby(setup.sessionId);
    const help = await createWorkshopHelpRequest({
      sessionId: setup.sessionId,
      userId: "learner-a",
      moduleId: "01-core",
      message: "The service probe is still failing",
    });
    await performWorkshopSessionAction({
      sessionId: setup.sessionId,
      actorUserId: "helper-a",
      action: "claim_help",
      expectedVersion: 2,
      payload: { userId: "learner-a" },
    });

    const helperProjection = await getWorkshopSessionProjection({
      sessionId: setup.sessionId,
      userId: "helper-a",
    });
    expect(helperProjection.session.roster).toContainEqual(
      expect.objectContaining({
        userId: "learner-a",
        helpState: "claimed",
        helpAssignedToViewer: true,
      }),
    );

    for (const actorUserId of ["owner-a", "learner-a"]) {
      await expect(
        performWorkshopSessionAction({
          sessionId: setup.sessionId,
          actorUserId,
          action: "resolve_help",
          expectedVersion: 2,
          payload: { userId: "learner-a" },
        }),
      ).rejects.toMatchObject({
        status: 403,
        code: "workshop_help_request_forbidden",
      });
    }

    await performWorkshopSessionAction({
      sessionId: setup.sessionId,
      actorUserId: "helper-a",
      action: "resolve_help",
      expectedVersion: 3,
      payload: { userId: "learner-a" },
    });
    const db = drizzle(env.DB);
    const [requestRows, events] = await Promise.all([
      db
        .select({
          status: workshopHelpRequests.status,
          activeKey: workshopHelpRequests.activeKey,
          resolvedAt: workshopHelpRequests.resolvedAt,
        })
        .from(workshopHelpRequests)
        .where(eq(workshopHelpRequests.id, help.id)),
      db
        .select({
          actorUserId: workshopEvents.actorUserId,
          payload: workshopEvents.payloadJson,
        })
        .from(workshopEvents)
        .where(eq(workshopEvents.type, "help.resolved")),
    ]);
    expect(requestRows).toEqual([
      expect.objectContaining({
        status: "resolved",
        activeKey: null,
        resolvedAt: expect.any(Number),
      }),
    ]);
    expect(events).toEqual([
      {
        actorUserId: "helper-a",
        payload: { helpRequestId: help.id },
      },
    ]);
  });

  it("issues owner and consent-bounded helper browser routes and deletes them on revoke", async () => {
    const setup = await readyWorkspaceFixture();
    await seedReadyRuntimeExecution(setup.workspaceId, setup.generationId);
    terminalMocks.loadCurrentRuntimeVmTerminalTarget.mockResolvedValue({
      executionId: `runtime-${setup.generationId}`,
      generation: 1,
      domainKind: "workshop",
      domainId: setup.workspaceId,
      userId: "learner-a",
      organizationId: "org-a",
      hostId: "host-a",
      vmId: "workshop",
      runtimeVmName: "workshop",
      target: {
        host: "192.0.2.10",
        port: 22,
        username: "learner",
        hostKeyOpenssh: "ssh-ed25519 host-key",
        privateKeyOpenssh: "private-key",
        observedAt: Date.now(),
      },
    });

    const ownerTerminal = await issueWorkshopBrowserTerminalSession({
      sessionId: setup.sessionId,
      workspaceId: setup.workspaceId,
      actorUserId: "learner-a",
    });
    expect(ownerTerminal.browser.websocketUrl).toContain(
      "terminal.example.test",
    );
    expect(ownerTerminal.routeUsername).toMatch(/^workshop-workshop-/);

    await expect(
      issueWorkshopBrowserTerminalSession({
        sessionId: setup.sessionId,
        workspaceId: setup.workspaceId,
        actorUserId: "helper-a",
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "workshop_assist_grant_required",
    });

    const help = await createWorkshopHelpRequest({
      sessionId: setup.sessionId,
      userId: "learner-a",
      message: "Please inspect the terminal with me",
    });
    await claimWorkshopHelpRequest({
      sessionId: setup.sessionId,
      helpRequestId: help.id,
      helperUserId: "helper-a",
    });
    const grant = await grantWorkshopAssist({
      sessionId: setup.sessionId,
      helpRequestId: help.id,
      learnerUserId: "learner-a",
    });
    const helperTerminal = await issueWorkshopBrowserTerminalSession({
      sessionId: setup.sessionId,
      workspaceId: setup.workspaceId,
      actorUserId: "helper-a",
    });
    expect(helperTerminal.expiresAt).toBeLessThanOrEqual(grant.expiresAt);
    expect(helperTerminal.routeUsername).not.toBe(ownerTerminal.routeUsername);
    const helperRoom = await getWorkshopSessionProjection({
      sessionId: setup.sessionId,
      userId: "helper-a",
    });
    expect(
      helperRoom.session.roster.find((member) => member.userId === "learner-a"),
    ).toMatchObject({
      assistGrant: {
        id: grant.id,
        workspaceId: setup.workspaceId,
      },
    });

    await performWorkshopSessionAction({
      sessionId: setup.sessionId,
      actorUserId: "helper-a",
      action: "resolve_help",
      expectedVersion: 2,
      payload: { userId: "learner-a" },
    });
    expect(terminalMocks.deleteStargateRoute).toHaveBeenCalledWith(
      helperTerminal.routeUsername,
    );
    const grantRows = await drizzle(env.DB)
      .select({ routes: workshopAssistGrants.terminalRouteUsernamesJson })
      .from(workshopAssistGrants)
      .where(eq(workshopAssistGrants.id, grant.id));
    expect(grantRows).toEqual([{ routes: [] }]);
    const workspaceRows = await drizzle(env.DB)
      .select({ routes: workshopWorkspaces.terminalRouteUsernamesJson })
      .from(workshopWorkspaces)
      .where(eq(workshopWorkspaces.id, setup.workspaceId));
    expect(workspaceRows).toEqual([{ routes: [ownerTerminal.routeUsername] }]);
    await expect(
      getWorkshopSessionProjection({
        sessionId: setup.sessionId,
        userId: "learner-a",
      }),
    ).resolves.toMatchObject({
      session: { helpRequest: null, assistGrant: null },
    });
  });

  it("deletes a terminal route when archival wins the final recording race", async () => {
    const setup = await readyWorkspaceFixture();
    await seedReadyRuntimeExecution(setup.workspaceId, setup.generationId);
    const executionId = `runtime-${setup.generationId}`;
    terminalMocks.loadCurrentRuntimeVmTerminalTarget.mockResolvedValue({
      executionId,
      generation: 1,
      domainKind: "workshop",
      domainId: setup.workspaceId,
      userId: "learner-a",
      organizationId: "org-a",
      hostId: "host-a",
      vmId: "workshop",
      runtimeVmName: "workshop",
      target: {
        host: "192.0.2.10",
        port: 22,
        username: "learner",
        hostKeyOpenssh: "ssh-ed25519 host-key",
        privateKeyOpenssh: "private-key",
        observedAt: Date.now(),
      },
    });
    terminalMocks.issueStargateTerminalSession.mockImplementationOnce(
      async (input: {
        routeUsername: string;
        expiresAt: Date;
        mode: "browser" | "native";
      }) => {
        const now = Date.now();
        const db = drizzle(env.DB);
        await db.batch([
          db
            .update(workshopWorkspaceGenerations)
            .set({
              state: "archiving",
              archiveRequestedAt: now,
              updatedAt: now,
            })
            .where(eq(workshopWorkspaceGenerations.id, setup.generationId)),
          db
            .update(runtimeExecutions)
            .set({
              state: "archiving",
              archiveRequestedAt: now,
              updatedAt: now,
            })
            .where(eq(runtimeExecutions.id, executionId)),
        ]);
        return {
          routeUsername: input.routeUsername,
          expiresAt: input.expiresAt.getTime(),
          browser: { websocketUrl: "wss://terminal.example.test/session" },
        };
      },
    );

    await expect(
      issueWorkshopBrowserTerminalSession({
        sessionId: setup.sessionId,
        workspaceId: setup.workspaceId,
        actorUserId: "learner-a",
      }),
    ).rejects.toMatchObject({
      code: "workshop_terminal_authorization_changed",
    });

    const routeUsername = terminalMocks.issueStargateTerminalSession.mock
      .calls[0]?.[0]?.routeUsername as string;
    expect(terminalMocks.deleteStargateRoute).toHaveBeenCalledWith(
      routeUsername,
    );
    await expect(
      drizzle(env.DB)
        .select({ routes: workshopWorkspaces.terminalRouteUsernamesJson })
        .from(workshopWorkspaces)
        .where(eq(workshopWorkspaces.id, setup.workspaceId)),
    ).resolves.toEqual([{ routes: [] }]);
  });

  it("revokes learner-granted assistance when the learner lowers their hand", async () => {
    const setup = await readyWorkspaceFixture();
    const help = await createWorkshopHelpRequest({
      sessionId: setup.sessionId,
      userId: "learner-a",
      message: "I no longer need help",
    });
    await claimWorkshopHelpRequest({
      sessionId: setup.sessionId,
      helpRequestId: help.id,
      helperUserId: "helper-a",
    });
    const grant = await grantWorkshopAssist({
      sessionId: setup.sessionId,
      helpRequestId: help.id,
      learnerUserId: "learner-a",
    });

    await closeWorkshopHelpRequest({
      sessionId: setup.sessionId,
      helpRequestId: help.id,
      actorUserId: "learner-a",
      action: "cancel",
    });

    const [row] = await drizzle(env.DB)
      .select({ revokedAt: workshopAssistGrants.revokedAt })
      .from(workshopAssistGrants)
      .where(eq(workshopAssistGrants.id, grant.id));
    expect(row?.revokedAt).toEqual(expect.any(Number));
    await expect(
      requireActiveWorkshopAssistGrant({
        sessionId: setup.sessionId,
        workspaceId: setup.workspaceId,
        helperUserId: "helper-a",
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "workshop_assist_grant_required",
    });
  });

  it("keeps a failed assist-route revoke denied and retryable", async () => {
    const setup = await readyWorkspaceFixture();
    await seedReadyRuntimeExecution(setup.workspaceId, setup.generationId);
    terminalMocks.loadCurrentRuntimeVmTerminalTarget.mockResolvedValue({
      executionId: `runtime-${setup.generationId}`,
      generation: 1,
      domainKind: "workshop",
      domainId: setup.workspaceId,
      userId: "learner-a",
      organizationId: "org-a",
      hostId: "host-a",
      vmId: "workshop",
      runtimeVmName: "workshop",
      target: {
        host: "192.0.2.10",
        port: 22,
        username: "learner",
        hostKeyOpenssh: "ssh-ed25519 host-key",
        privateKeyOpenssh: "private-key",
        observedAt: Date.now(),
      },
    });
    const help = await createWorkshopHelpRequest({
      sessionId: setup.sessionId,
      userId: "learner-a",
      message: "Please inspect the terminal with me",
    });
    await claimWorkshopHelpRequest({
      sessionId: setup.sessionId,
      helpRequestId: help.id,
      helperUserId: "helper-a",
    });
    const grant = await grantWorkshopAssist({
      sessionId: setup.sessionId,
      helpRequestId: help.id,
      learnerUserId: "learner-a",
    });
    const helperTerminal = await issueWorkshopBrowserTerminalSession({
      sessionId: setup.sessionId,
      workspaceId: setup.workspaceId,
      actorUserId: "helper-a",
    });

    terminalMocks.deleteStargateRoute.mockRejectedValueOnce(
      new Error("injected assist-route cleanup failure"),
    );
    await expect(
      performWorkshopSessionAction({
        sessionId: setup.sessionId,
        actorUserId: "learner-a",
        action: "revoke_assist",
        payload: {},
      }),
    ).rejects.toThrow("injected assist-route cleanup failure");

    const db = drizzle(env.DB);
    const [failedGrant] = await db
      .select({
        revokedAt: workshopAssistGrants.revokedAt,
        routes: workshopAssistGrants.terminalRouteUsernamesJson,
      })
      .from(workshopAssistGrants)
      .where(eq(workshopAssistGrants.id, grant.id));
    expect(failedGrant).toMatchObject({
      revokedAt: expect.any(Number),
      routes: [helperTerminal.routeUsername],
    });
    await expect(
      requireActiveWorkshopAssistGrant({
        sessionId: setup.sessionId,
        workspaceId: setup.workspaceId,
        helperUserId: "helper-a",
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "workshop_assist_grant_required",
    });

    await expect(
      performWorkshopSessionAction({
        sessionId: setup.sessionId,
        actorUserId: "learner-a",
        action: "revoke_assist",
        payload: {},
      }),
    ).resolves.toEqual({ kind: "updated" });
    const [cleanedGrant, cleanedWorkspace, revokeEvents] = await Promise.all([
      db
        .select({
          revokedAt: workshopAssistGrants.revokedAt,
          routes: workshopAssistGrants.terminalRouteUsernamesJson,
        })
        .from(workshopAssistGrants)
        .where(eq(workshopAssistGrants.id, grant.id)),
      db
        .select({ routes: workshopWorkspaces.terminalRouteUsernamesJson })
        .from(workshopWorkspaces)
        .where(eq(workshopWorkspaces.id, setup.workspaceId)),
      db
        .select({ type: workshopEvents.type })
        .from(workshopEvents)
        .where(eq(workshopEvents.type, "assist.revoked")),
    ]);
    expect(cleanedGrant).toEqual([
      { revokedAt: failedGrant?.revokedAt, routes: [] },
    ]);
    expect(cleanedWorkspace).toEqual([{ routes: [] }]);
    expect(revokeEvents).toHaveLength(1);
    expect(terminalMocks.deleteStargateRoute).toHaveBeenCalledTimes(2);
  });

  it("issues native SSH only to the workspace participant using profile keys", async () => {
    const setup = await readyWorkspaceFixture();
    await seedReadyRuntimeExecution(setup.workspaceId, setup.generationId);
    terminalMocks.loadCurrentRuntimeVmTerminalTarget.mockResolvedValue({
      executionId: `runtime-${setup.generationId}`,
      generation: 1,
      domainKind: "workshop",
      domainId: setup.workspaceId,
      userId: "learner-a",
      organizationId: "org-a",
      hostId: "host-a",
      vmId: "workshop",
      runtimeVmName: "workshop",
      target: {
        host: "192.0.2.10",
        port: 22,
        username: "learner",
        hostKeyOpenssh: "ssh-ed25519 host-key",
        privateKeyOpenssh: "private-key",
        observedAt: Date.now(),
      },
    });

    await expect(
      issueWorkshopNativeSshSession({
        sessionId: setup.sessionId,
        workspaceId: setup.workspaceId,
        actorUserId: "learner-a",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "workshop_native_ssh_key_required",
    });
    await expect(
      issueWorkshopNativeSshSession({
        sessionId: setup.sessionId,
        workspaceId: setup.workspaceId,
        actorUserId: "helper-a",
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "workshop_native_ssh_participant_only",
    });

    await drizzle(env.DB).insert(userSshKeys).values({
      id: "learner-native-key",
      userId: "learner-a",
      label: "Laptop",
      keyType: "ssh-ed25519",
      comment: "learner@example.test",
      publicKeyOpenssh: "ssh-ed25519 AAAATEST learner@example.test",
      fingerprintSha256: "SHA256:learner",
    });
    const terminal = await issueWorkshopNativeSshSession({
      sessionId: setup.sessionId,
      workspaceId: setup.workspaceId,
      actorUserId: "learner-a",
    });
    expect(terminal.routeUsername).toMatch(/-native$/);
    expect(terminal.native).toMatchObject({
      authMode: "profile_keys",
      authorizedKeyCount: 1,
    });
    expect(terminalMocks.issueStargateTerminalSession).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "native",
        authorizedClientPublicKeysOpenssh: [
          "ssh-ed25519 AAAATEST learner@example.test",
        ],
        metadata: expect.objectContaining({ userId: "learner-a" }),
      }),
    );
    const events = await drizzle(env.DB)
      .select({ payload: workshopEvents.payloadJson })
      .from(workshopEvents)
      .where(eq(workshopEvents.type, "terminal.opened"));
    expect(events).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ mode: "native" }),
      }),
    ]);
  });

  it("ends the session by closing help and consent and requesting workspace archival", async () => {
    const setup = await readyWorkspaceFixture();
    const help = await createWorkshopHelpRequest({
      sessionId: setup.sessionId,
      userId: "learner-a",
      message: "Please take a look",
    });
    await claimWorkshopHelpRequest({
      sessionId: setup.sessionId,
      helpRequestId: help.id,
      helperUserId: "helper-a",
    });
    const grant = await grantWorkshopAssist({
      sessionId: setup.sessionId,
      helpRequestId: help.id,
      learnerUserId: "learner-a",
    });
    const live = await updateWorkshopSession({
      sessionId: setup.sessionId,
      actorUserId: "owner-a",
      expectedVersion: 2,
      state: "live",
    });
    const ended = await updateWorkshopSession({
      sessionId: setup.sessionId,
      actorUserId: "owner-a",
      expectedVersion: live.version,
      state: "ended",
    });
    expect(ended).toMatchObject({ state: "ended", version: 4 });

    const db = drizzle(env.DB);
    const [roster, workspaces, generations, grants, helpRows] =
      await Promise.all([
        db
          .select({ state: workshopSessionMembers.provisionState })
          .from(workshopSessionMembers)
          .where(eq(workshopSessionMembers.sessionId, setup.sessionId)),
        db
          .select({ state: workshopWorkspaces.state })
          .from(workshopWorkspaces)
          .where(eq(workshopWorkspaces.id, setup.workspaceId)),
        db
          .select({ state: workshopWorkspaceGenerations.state })
          .from(workshopWorkspaceGenerations)
          .where(eq(workshopWorkspaceGenerations.id, setup.generationId)),
        db
          .select({ revokedAt: workshopAssistGrants.revokedAt })
          .from(workshopAssistGrants)
          .where(eq(workshopAssistGrants.id, grant.id)),
        db
          .select({ status: workshopHelpRequests.status })
          .from(workshopHelpRequests)
          .where(eq(workshopHelpRequests.id, help.id)),
      ]);
    expect(roster.every((entry) => entry.state === "ended")).toBe(true);
    expect(workspaces).toEqual([{ state: "ended" }]);
    expect(generations).toEqual([{ state: "archived" }]);
    expect(grants[0]?.revokedAt).not.toBeNull();
    expect(helpRows).toEqual([{ status: "cancelled" }]);

    await expect(
      db
        .update(workshopEvents)
        .set({ type: "mutated" })
        .where(eq(workshopEvents.sessionId, setup.sessionId)),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringMatching(/append-only/),
      }),
    });
  });
});

async function createTemplateFixture(manifest = workshopManifest()) {
  const created = await createWorkshopTemplate({
    organizationId: "org-a",
    actorUserId: "owner-a",
    sourceRevision: "source-a",
    contentHash: "a".repeat(64),
    manifest,
  });
  return {
    templateId: created.template.id,
    revisionId: created.revision.id,
  };
}

async function createSessionFixture(manifest = workshopManifest()) {
  const template = await createTemplateFixture(manifest);
  const session = await createWorkshopSession({
    organizationId: "org-a",
    actorUserId: "owner-a",
    templateRevisionId: template.revisionId,
    title: "Platform engineering live",
    scheduledStartAt: Date.now() + 60 * 60 * 1_000,
  });
  await replaceWorkshopRoster({
    sessionId: session.id,
    actorUserId: "owner-a",
    members: [
      { userId: "owner-a", role: "facilitator" },
      { userId: "learner-a", role: "participant" },
      { userId: "helper-a", role: "helper" },
    ],
  });
  return { ...template, sessionId: session.id };
}

async function readyWorkspaceFixture() {
  const setup = await createSessionFixture();
  await openLobby(setup.sessionId);
  await checkInToWorkshop({ sessionId: setup.sessionId, userId: "learner-a" });
  const prepared = await prepareCheckedInWorkshopWorkspaces({
    sessionId: setup.sessionId,
    actorUserId: "owner-a",
  });
  const request = prepared.requests[0];
  if (!request) throw new Error("workspace request missing");
  await recordWorkshopGenerationState({
    generationId: request.generationId,
    update: {
      state: "ready",
      runtimeExecutionId: `runtime-${request.generationId}`,
      hostId: "host-a",
    },
  });
  return {
    ...setup,
    workspaceId: request.workspaceId,
    generationId: request.generationId,
  };
}

async function seedReadyRuntimeExecution(
  workspaceId: string,
  generationId: string,
) {
  const now = Date.now();
  await drizzle(env.DB)
    .insert(runtimeExecutions)
    .values({
      id: `runtime-${generationId}`,
      userId: "learner-a",
      organizationId: "org-a",
      domainKind: "workshop",
      domainId: workspaceId,
      generation: 1,
      state: "ready",
      createdAt: now,
      updatedAt: now,
    });
}

async function seedWorkshopProbeReports(params: {
  workspaceId: string;
  staleGenerationId: string;
}) {
  const db = drizzle(env.DB);
  const now = Date.now() + 10_000;
  const staleExecutionId = `runtime-${params.staleGenerationId}`;
  const currentGenerationId = `generation-current-${params.staleGenerationId}`;
  const currentExecutionId = `runtime-current-${params.staleGenerationId}`;
  const staleRuntimeVmId = `vm-stale-${params.staleGenerationId}`;
  const currentRuntimeVmId = `vm-current-${params.staleGenerationId}`;

  await db.insert(agentHosts).values({
    id: "host-a",
    userId: "owner-a",
    organizationId: "org-a",
    name: "Workshop runner",
    connected: true,
    activeSessionId: "host-a-session",
    lastHeartbeatAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(runtimeExecutions).values([
    {
      id: staleExecutionId,
      userId: "learner-a",
      organizationId: "org-a",
      hostId: "host-a",
      domainKind: "workshop",
      domainId: params.workspaceId,
      generation: 1,
      state: "archived",
      createdAt: now - 1_000,
      updatedAt: now,
    },
    {
      id: currentExecutionId,
      userId: "learner-a",
      organizationId: "org-a",
      hostId: "host-a",
      domainKind: "workshop",
      domainId: params.workspaceId,
      generation: 2,
      sourceExecutionId: staleExecutionId,
      state: "ready",
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await db.insert(runtimeVms).values([
    {
      id: staleRuntimeVmId,
      executionId: staleExecutionId,
      vmId: "workshop",
      ordinal: 0,
      runtimeVmName: "workshop-stale",
      imageKeyJson: { generation: "stale" },
      imageSha256: "a".repeat(64),
      cpuMillis: 4_000,
      memoryMib: 16_384,
      diskMib: 102_400,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: currentRuntimeVmId,
      executionId: currentExecutionId,
      vmId: "workshop",
      ordinal: 0,
      runtimeVmName: "workshop-current",
      imageKeyJson: { generation: "current" },
      imageSha256: "b".repeat(64),
      cpuMillis: 4_000,
      memoryMib: 16_384,
      diskMib: 102_400,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await db.insert(runtimeVmActualState).values([
    {
      runtimeVmId: staleRuntimeVmId,
      executionId: staleExecutionId,
      hostId: "host-a",
      phase: "ready",
      reportJson: workshopVmProbeReport({
        executionId: staleExecutionId,
        runtimeVmName: "workshop-stale",
        observedAt: now + 5_000,
        probes: [
          probeSnapshot("workspace-ready", "pass", now + 5_000),
          probeSnapshot("service-ready", "fail", now + 5_000),
        ],
      }),
      observedAt: now + 5_000,
      updatedAt: now + 5_000,
    },
    {
      runtimeVmId: currentRuntimeVmId,
      executionId: currentExecutionId,
      hostId: "host-a",
      phase: "ready",
      reportJson: workshopVmProbeReport({
        executionId: currentExecutionId,
        runtimeVmName: "workshop-current",
        observedAt: now,
        probes: [
          {
            ...probeSnapshot("service-ready", "pass", now),
            message: "current generation is healthy",
          },
          probeSnapshot("undeclared-probe", "fail", now + 1),
          {
            id: "service-ready",
            phase: "scenario",
            status: "passing",
            checked_at_unix_ms: now + 2,
          } as never,
          {
            id: "service-ready",
            status: "fail",
            checked_at_unix_ms: now + 3,
          } as never,
        ],
      }),
      observedAt: now,
      updatedAt: now,
    },
  ]);
  await db
    .update(workshopWorkspaceGenerations)
    .set({ state: "archived", archivedAt: now, updatedAt: now })
    .where(eq(workshopWorkspaceGenerations.id, params.staleGenerationId));
  await db.insert(workshopWorkspaceGenerations).values({
    id: currentGenerationId,
    workspaceId: params.workspaceId,
    ordinal: 2,
    runtimeExecutionId: currentExecutionId,
    checkpointId: "checkpoint-00",
    hostId: "host-a",
    state: "ready",
    requestedAt: now,
    readyAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db
    .update(workshopWorkspaces)
    .set({ currentGenerationId, updatedAt: now })
    .where(eq(workshopWorkspaces.id, params.workspaceId));

  return { currentExecutionId, currentRuntimeVmId };
}

function workshopVmProbeReport(params: {
  executionId: string;
  runtimeVmName?: string;
  observedAt: number;
  probes: VmActualStateV2["probes"];
}): VmActualStateV2 {
  return {
    run_id: params.executionId,
    vm_name: params.runtimeVmName ?? "workshop-current",
    phase: "ready",
    terminal: {
      state: "pending",
      observed_at_unix_ms: params.observedAt,
    },
    ssh_host_keys_openssh: [],
    probes: params.probes,
    updated_at_unix_ms: params.observedAt,
  };
}

function probeSnapshot(
  id: string,
  status: "pass" | "fail" | "unknown",
  checkedAt: number,
): VmActualStateV2["probes"][number] {
  return {
    id,
    phase: "scenario",
    status,
    checked_at_unix_ms: checkedAt,
  };
}

async function openLobby(sessionId: string) {
  return updateWorkshopSession({
    sessionId,
    actorUserId: "owner-a",
    expectedVersion: 1,
    state: "lobby",
  });
}

async function seedIdentityGraph() {
  const db = drizzle(env.DB);
  const now = new Date();
  await db.batch([
    db
      .insert(user)
      .values([
        userRow("owner-a"),
        userRow("learner-a"),
        userRow("helper-a"),
        userRow("late-a"),
        userRow("owner-b"),
      ]),
    db.insert(organization).values([
      { id: "org-a", name: "Organization A", slug: "org-a", createdAt: now },
      { id: "org-b", name: "Organization B", slug: "org-b", createdAt: now },
    ]),
    db
      .insert(member)
      .values([
        membership("membership-owner-a", "org-a", "owner-a", "owner", now),
        membership("membership-learner-a", "org-a", "learner-a", "member", now),
        membership("membership-helper-a", "org-a", "helper-a", "member", now),
        membership("membership-late-a", "org-a", "late-a", "member", now),
        membership("membership-owner-b", "org-b", "owner-b", "owner", now),
      ]),
  ]);
}

function userRow(id: string): typeof user.$inferInsert {
  return {
    id,
    name: id,
    email: `${id}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function membership(
  id: string,
  organizationId: string,
  userId: string,
  role: "owner" | "admin" | "member",
  createdAt: Date,
): typeof member.$inferInsert {
  return { id, organizationId, userId, role, createdAt };
}

function workshopManifest(
  override: { summary?: string; defaultLobbyMinutes?: number } = {},
): WorkshopManifestV1 {
  return {
    schemaVersion: 1,
    workshop: {
      slug: "platform-engineering",
      title: "Platform Engineering Workshop",
      summary: override.summary ?? "Build a platform from primitives.",
      prerequisites: ["A browser"],
      defaultLobbyMinutes: override.defaultLobbyMinutes ?? 30,
    },
    workspace: {
      leaseGraceMinutes: 60,
      vms: [
        {
          id: "workshop",
          name: "workshop",
          cpuMillis: 4_000,
          memoryMib: 16_384,
          diskMib: 102_400,
        },
      ],
      checkpoints: [
        {
          id: "checkpoint-00",
          label: "Setup",
          vmImages: [
            {
              vmId: "workshop",
              imageKey: {
                scenario: "workshop-test-checkpoint-00",
                vm: "workshop",
                arch: "x86_64",
              },
              imageSha256: "c".repeat(64),
            },
          ],
        },
      ],
      initialCheckpointId: "checkpoint-00",
      applications: [],
    },
    modules: [
      {
        id: "00-setup",
        title: "Setup",
        tier: "gate",
        outcome: "Confirm the workspace is ready.",
        dependsOn: [],
        participantMarkdown: "Run the preflight.",
        facilitatorNotesMarkdown: "Help anyone still blocked.",
        hints: [],
        solutionMarkdown: "Run the setup script.",
        probeIds: ["workspace-ready"],
        catchUpCheckpointId: "checkpoint-00",
      },
      {
        id: "01-core",
        title: "Core platform",
        tier: "core",
        outcome: "Reconcile the first platform service.",
        dependsOn: ["00-setup"],
        participantMarkdown: "Build the service.",
        facilitatorNotesMarkdown: "Watch reconciliation health.",
        hints: [
          {
            id: "inspect-events",
            title: "Inspect events",
            bodyMarkdown: "Read the event stream.",
          },
        ],
        solutionMarkdown: "Apply the canonical resource.",
        explainBackPrompt: "Explain the reconciliation loop.",
        probeIds: ["service-ready"],
        catchUpCheckpointId: "checkpoint-00",
      },
    ],
    agenda: [
      {
        id: "setup",
        kind: "lab",
        title: "Setup",
        durationMinutes: 15,
        scheduled: false,
        moduleId: "00-setup",
        slideIds: ["welcome"],
        release: "automatic",
      },
      {
        id: "core",
        kind: "lab",
        title: "Core platform",
        durationMinutes: 45,
        scheduled: true,
        moduleId: "01-core",
        slideIds: ["core"],
        release: "facilitator",
      },
    ],
    presentation: {
      slides: [
        {
          id: "welcome",
          layout: "title",
          title: "Welcome",
          bodyMarkdown: "Platform Engineering Workshop",
          moduleId: "00-setup",
        },
        {
          id: "core",
          layout: "content",
          title: "Core",
          bodyMarkdown: "Reconcile the platform.",
          notesMarkdown: "Release only after the module 01 explain-back.",
          moduleId: "01-core",
        },
      ],
    },
    durationMinutes: 45,
  };
}

function workshopCheckpoint(
  id: string,
  scenario: string,
  hashCharacter: string,
): WorkshopManifestV1["workspace"]["checkpoints"][number] {
  return {
    id,
    label: id,
    vmImages: [
      {
        vmId: "workshop",
        imageKey: { scenario, vm: "workshop", arch: "x86_64" },
        imageSha256: hashCharacter.repeat(64),
      },
    ],
  };
}

function stretchModule(
  id: string,
  checkpointId: string,
): WorkshopManifestV1["modules"][number] {
  return {
    id,
    title: id,
    tier: "stretch",
    outcome: `Complete ${id}.`,
    dependsOn: ["01-core"],
    participantMarkdown: `Build ${id}.`,
    facilitatorNotesMarkdown: `Coach ${id}.`,
    hints: [],
    solutionMarkdown: `Apply ${id}.`,
    probeIds: [],
    catchUpCheckpointId: checkpointId,
  };
}

function stretchAgenda(moduleId: string): WorkshopManifestV1["agenda"][number] {
  return {
    id: `${moduleId}-agenda`,
    kind: "tinker",
    title: moduleId,
    durationMinutes: 0,
    scheduled: false,
    moduleId,
    slideIds: [`${moduleId}-slide`],
    release: "pool",
  };
}

function stretchSlide(
  moduleId: string,
): WorkshopManifestV1["presentation"]["slides"][number] {
  return {
    id: `${moduleId}-slide`,
    layout: "content",
    title: moduleId,
    bodyMarkdown: `Build ${moduleId}.`,
    moduleId,
  };
}
