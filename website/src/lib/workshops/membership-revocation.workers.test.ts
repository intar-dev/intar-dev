/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";

const accessMocks = vi.hoisted(() => ({
  deleteStargateRoute: vi.fn(),
  deleteStargateWorkspaceAppRoute: vi.fn(),
  issueStargateWorkspaceAppSession: vi.fn(),
  loadCurrentRuntimeVmTerminalTarget: vi.fn(),
  afterWorkshopManagerAuthorizationOnce: null as (() => Promise<void>) | null,
  afterWorkshopHelperAuthorizationOnce: null as (() => Promise<void>) | null,
}));

vi.mock("@/lib/workshops/shared", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/workshops/shared")>();
  return {
    ...actual,
    requireWorkshopManager: vi.fn(
      async (...args: Parameters<typeof actual.requireWorkshopManager>) => {
        const access = await actual.requireWorkshopManager(...args);
        const hook = accessMocks.afterWorkshopManagerAuthorizationOnce;
        accessMocks.afterWorkshopManagerAuthorizationOnce = null;
        if (hook) await hook();
        return access;
      },
    ),
    requireWorkshopHelper: vi.fn(
      async (...args: Parameters<typeof actual.requireWorkshopHelper>) => {
        const access = await actual.requireWorkshopHelper(...args);
        const hook = accessMocks.afterWorkshopHelperAuthorizationOnce;
        accessMocks.afterWorkshopHelperAuthorizationOnce = null;
        if (hook) await hook();
        return access;
      },
    ),
  };
});

vi.mock("@/lib/stargate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stargate")>()),
  deleteStargateRoute: accessMocks.deleteStargateRoute,
  deleteStargateWorkspaceAppRoute: accessMocks.deleteStargateWorkspaceAppRoute,
  issueStargateWorkspaceAppSession:
    accessMocks.issueStargateWorkspaceAppSession,
}));

vi.mock("@/lib/runtime-executions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/runtime-executions")>()),
  loadCurrentRuntimeVmTerminalTarget:
    accessMocks.loadCurrentRuntimeVmTerminalTarget,
}));

import {
  activeRuntimeSlots,
  member,
  organization,
  runtimeExecutions,
  user,
  workshopAssistGrants,
  workshopEvents,
  workshopHelpRequests,
  workshopModuleProgress,
  workshopSessionMembers,
  workshopSessions,
  workshopTemplateRevisions,
  workshopTemplates,
  workshopWorkspaceGenerations,
  workshopWorkspaces,
  type WorkshopManifestV1,
  type WorkshopSessionState,
} from "@/db/schema";
import {
  leaveOrganization,
  removeOrganizationMember,
  transferOrganizationOwnership,
  updateOrganizationMemberRole,
} from "@/lib/organizations";
import { resetD1Database } from "@/test/d1-migrations";
import { issueWorkshopWorkspaceApplication } from "./applications";
import {
  claimWorkshopHelpRequest,
  revokeWorkshopAssist,
} from "./assistance";
import { updateWorkshopSession } from "./sessions";

const ORGANIZATION_ID = "organization-workshop-revocation";
const SESSION_ID = "session-workshop-revocation";
const WORKSPACE_ID = "workspace-participant";
const GENERATION_ID = "generation-participant-1";
const EXECUTION_ID = "execution-participant-1";
const PARTICIPANT_ROUTE = "participant-terminal-route";
const ASSIST_ROUTE = "helper-assist-route";
const APPLICATION_ROUTE = "existing-workspace-app-route";

describe("workshop access revocation during organization membership removal", () => {
  beforeEach(async () => {
    accessMocks.deleteStargateRoute.mockReset();
    accessMocks.deleteStargateWorkspaceAppRoute.mockReset();
    accessMocks.issueStargateWorkspaceAppSession.mockReset();
    accessMocks.loadCurrentRuntimeVmTerminalTarget.mockReset();
    accessMocks.afterWorkshopManagerAuthorizationOnce = null;
    accessMocks.afterWorkshopHelperAuthorizationOnce = null;
    accessMocks.deleteStargateRoute.mockResolvedValue(undefined);
    accessMocks.deleteStargateWorkspaceAppRoute.mockResolvedValue(undefined);
    accessMocks.issueStargateWorkspaceAppSession.mockImplementation(
      async (input: { routeId: string; expiresAt: Date }) => ({
        routeId: input.routeId,
        url: `https://${input.routeId}.intar.app/?__intar_bootstrap=one-time`,
        bootstrapExpiresAt: input.expiresAt.getTime() - 14 * 60_000,
        expiresAt: input.expiresAt.getTime(),
      }),
    );
    accessMocks.loadCurrentRuntimeVmTerminalTarget.mockResolvedValue({
      executionId: EXECUTION_ID,
      generation: 1,
      domainKind: "workshop",
      domainId: WORKSPACE_ID,
      userId: "participant",
      organizationId: ORGANIZATION_ID,
      hostId: "runner",
      vmId: "workshop",
      runtimeVmName: "workshop-participant",
      target: {
        host: "10.0.0.10",
        port: 22,
        username: "debian",
        hostKeyOpenssh: "ssh-ed25519 host-key",
        privateKeyOpenssh: "test-private-key",
        observedAt: 1_800_000_000_000,
      },
    });
    await resetD1Database();
  });

  it("revokes participant routes, applications, grants, runtime, and slot before removal", async () => {
    await seedLiveWorkshopFixture();

    await removeOrganizationMember({
      organizationId: ORGANIZATION_ID,
      memberId: membershipId("participant"),
      actorUserId: "owner",
    });

    expect(accessMocks.deleteStargateRoute).toHaveBeenCalledWith(
      PARTICIPANT_ROUTE,
    );
    expect(accessMocks.deleteStargateRoute).toHaveBeenCalledWith(ASSIST_ROUTE);
    expect(accessMocks.deleteStargateWorkspaceAppRoute).toHaveBeenCalledWith(
      APPLICATION_ROUTE,
    );

    const db = drizzle(env.DB);
    const [memberships, workspaces, generations, executions, slots, grants] =
      await Promise.all([
        db
          .select({
            id: member.id,
            workshopAccessRevokingAt: member.workshopAccessRevokingAt,
          })
          .from(member)
          .where(eq(member.id, membershipId("participant"))),
        db
          .select({
            state: workshopWorkspaces.state,
            terminalRoutes: workshopWorkspaces.terminalRouteUsernamesJson,
            applicationRoutes: workshopWorkspaces.applicationRouteIdsJson,
            endedAt: workshopWorkspaces.endedAt,
          })
          .from(workshopWorkspaces)
          .where(eq(workshopWorkspaces.id, WORKSPACE_ID)),
        db
          .select({ state: workshopWorkspaceGenerations.state })
          .from(workshopWorkspaceGenerations)
          .where(eq(workshopWorkspaceGenerations.id, GENERATION_ID)),
        db
          .select({ state: runtimeExecutions.state })
          .from(runtimeExecutions)
          .where(eq(runtimeExecutions.id, EXECUTION_ID)),
        db
          .select()
          .from(activeRuntimeSlots)
          .where(eq(activeRuntimeSlots.userId, "participant")),
        db
          .select({
            revokedAt: workshopAssistGrants.revokedAt,
            revokedBy: workshopAssistGrants.revokedBy,
            terminalRoutes: workshopAssistGrants.terminalRouteUsernamesJson,
          })
          .from(workshopAssistGrants)
          .where(eq(workshopAssistGrants.id, "assist-grant")),
      ]);

    expect(memberships).toEqual([]);
    expect(workspaces).toEqual([
      {
        state: "ended",
        terminalRoutes: [],
        applicationRoutes: [],
        endedAt: expect.any(Number),
      },
    ]);
    expect(generations).toEqual([{ state: "archived" }]);
    expect(executions).toEqual([{ state: "archived" }]);
    expect(slots).toEqual([]);
    expect(grants).toEqual([
      {
        revokedAt: expect.any(Number),
        revokedBy: "owner",
        terminalRoutes: [],
      },
    ]);
    await expectParticipantHistoryPreserved();
  });

  it("revokes only the helper assist capability when the helper leaves", async () => {
    await seedLiveWorkshopFixture();

    await leaveOrganization({
      organizationId: ORGANIZATION_ID,
      userId: "helper",
    });

    expect(accessMocks.deleteStargateRoute).toHaveBeenCalledTimes(1);
    expect(accessMocks.deleteStargateRoute).toHaveBeenCalledWith(ASSIST_ROUTE);
    expect(accessMocks.deleteStargateWorkspaceAppRoute).not.toHaveBeenCalled();

    const db = drizzle(env.DB);
    const [memberships, workspaces, executions, slots, grants, roster] =
      await Promise.all([
        db
          .select()
          .from(member)
          .where(eq(member.id, membershipId("helper"))),
        db
          .select({
            state: workshopWorkspaces.state,
            terminalRoutes: workshopWorkspaces.terminalRouteUsernamesJson,
            applicationRoutes: workshopWorkspaces.applicationRouteIdsJson,
          })
          .from(workshopWorkspaces)
          .where(eq(workshopWorkspaces.id, WORKSPACE_ID)),
        db
          .select({ state: runtimeExecutions.state })
          .from(runtimeExecutions)
          .where(eq(runtimeExecutions.id, EXECUTION_ID)),
        db
          .select()
          .from(activeRuntimeSlots)
          .where(eq(activeRuntimeSlots.userId, "participant")),
        db
          .select({
            revokedAt: workshopAssistGrants.revokedAt,
            revokedBy: workshopAssistGrants.revokedBy,
          })
          .from(workshopAssistGrants)
          .where(eq(workshopAssistGrants.id, "assist-grant")),
        db
          .select({ role: workshopSessionMembers.role })
          .from(workshopSessionMembers)
          .where(
            and(
              eq(workshopSessionMembers.sessionId, SESSION_ID),
              eq(workshopSessionMembers.userId, "helper"),
            ),
          ),
      ]);

    expect(memberships).toEqual([]);
    expect(workspaces).toEqual([
      {
        state: "ready",
        terminalRoutes: [PARTICIPANT_ROUTE],
        applicationRoutes: [APPLICATION_ROUTE],
      },
    ]);
    expect(executions).toEqual([{ state: "ready" }]);
    expect(slots).toHaveLength(1);
    expect(grants).toEqual([
      { revokedAt: expect.any(Number), revokedBy: "helper" },
    ]);
    expect(roster).toEqual([{ role: "helper" }]);
  });

  it("removes a facilitator without exposing or mutating learner-owned access", async () => {
    await seedLiveWorkshopFixture();

    await removeOrganizationMember({
      organizationId: ORGANIZATION_ID,
      memberId: membershipId("facilitator"),
      actorUserId: "owner",
    });

    expect(accessMocks.deleteStargateRoute).not.toHaveBeenCalled();
    expect(accessMocks.deleteStargateWorkspaceAppRoute).not.toHaveBeenCalled();

    const db = drizzle(env.DB);
    const [memberships, workspaces, grants, roster, history] =
      await Promise.all([
        db
          .select()
          .from(member)
          .where(eq(member.id, membershipId("facilitator"))),
        db
          .select({
            state: workshopWorkspaces.state,
            terminalRoutes: workshopWorkspaces.terminalRouteUsernamesJson,
            applicationRoutes: workshopWorkspaces.applicationRouteIdsJson,
          })
          .from(workshopWorkspaces)
          .where(eq(workshopWorkspaces.id, WORKSPACE_ID)),
        db
          .select({ revokedAt: workshopAssistGrants.revokedAt })
          .from(workshopAssistGrants)
          .where(eq(workshopAssistGrants.id, "assist-grant")),
        db
          .select({ role: workshopSessionMembers.role })
          .from(workshopSessionMembers)
          .where(
            and(
              eq(workshopSessionMembers.sessionId, SESSION_ID),
              eq(workshopSessionMembers.userId, "facilitator"),
            ),
          ),
        db
          .select({ type: workshopEvents.type })
          .from(workshopEvents)
          .where(eq(workshopEvents.sessionId, SESSION_ID)),
      ]);

    expect(memberships).toEqual([]);
    expect(workspaces).toEqual([
      {
        state: "ready",
        terminalRoutes: [PARTICIPANT_ROUTE, ASSIST_ROUTE],
        applicationRoutes: [APPLICATION_ROUTE],
      },
    ]);
    expect(grants).toEqual([{ revokedAt: null }]);
    expect(roster).toEqual([{ role: "facilitator" }]);
    expect(history.map((event) => event.type)).toEqual(
      expect.arrayContaining(["module.verified", "membership.access_revoked"]),
    );
  });

  it("keeps the organization membership when external cleanup fails", async () => {
    await seedLiveWorkshopFixture();
    accessMocks.deleteStargateWorkspaceAppRoute.mockRejectedValueOnce(
      new Error("injected Stargate cleanup failure"),
    );

    await expect(
      removeOrganizationMember({
        organizationId: ORGANIZATION_ID,
        memberId: membershipId("participant"),
        actorUserId: "owner",
      }),
    ).rejects.toThrow("injected Stargate cleanup failure");

    const db = drizzle(env.DB);
    const [memberships, workspaces, generations, executions, slots, grants] =
      await Promise.all([
        db
          .select({
            id: member.id,
            workshopAccessRevokingAt: member.workshopAccessRevokingAt,
          })
          .from(member)
          .where(eq(member.id, membershipId("participant"))),
        db
          .select({
            state: workshopWorkspaces.state,
            terminalRoutes: workshopWorkspaces.terminalRouteUsernamesJson,
            applicationRoutes: workshopWorkspaces.applicationRouteIdsJson,
          })
          .from(workshopWorkspaces)
          .where(eq(workshopWorkspaces.id, WORKSPACE_ID)),
        db
          .select({ state: workshopWorkspaceGenerations.state })
          .from(workshopWorkspaceGenerations)
          .where(eq(workshopWorkspaceGenerations.id, GENERATION_ID)),
        db
          .select({ state: runtimeExecutions.state })
          .from(runtimeExecutions)
          .where(eq(runtimeExecutions.id, EXECUTION_ID)),
        db
          .select()
          .from(activeRuntimeSlots)
          .where(eq(activeRuntimeSlots.userId, "participant")),
        db
          .select({ revokedAt: workshopAssistGrants.revokedAt })
          .from(workshopAssistGrants)
          .where(eq(workshopAssistGrants.id, "assist-grant")),
      ]);

    expect(memberships).toEqual([
      {
        id: membershipId("participant"),
        workshopAccessRevokingAt: expect.any(Date),
      },
    ]);
    expect(workspaces).toEqual([
      {
        state: "ready",
        terminalRoutes: [PARTICIPANT_ROUTE, ASSIST_ROUTE],
        applicationRoutes: [APPLICATION_ROUTE],
      },
    ]);
    expect(generations).toEqual([{ state: "ready" }]);
    expect(executions).toEqual([{ state: "ready" }]);
    expect(slots).toHaveLength(1);
    expect(grants).toEqual([{ revokedAt: null }]);
  });

  it.each(["ended", "cancelled"] satisfies WorkshopSessionState[])(
    "cleans leaked access from an archived %s session before membership removal",
    async (state) => {
      await seedLiveWorkshopFixture();
      await drizzle(env.DB)
        .update(workshopSessions)
        .set({ state })
        .where(eq(workshopSessions.id, SESSION_ID));

      await removeOrganizationMember({
        organizationId: ORGANIZATION_ID,
        memberId: membershipId("participant"),
        actorUserId: "owner",
      });

      expect(accessMocks.deleteStargateRoute).toHaveBeenCalledWith(
        PARTICIPANT_ROUTE,
      );
      expect(accessMocks.deleteStargateRoute).toHaveBeenCalledWith(
        ASSIST_ROUTE,
      );
      expect(accessMocks.deleteStargateWorkspaceAppRoute).toHaveBeenCalledWith(
        APPLICATION_ROUTE,
      );
      const db = drizzle(env.DB);
      await expect(
        db
          .select()
          .from(member)
          .where(eq(member.id, membershipId("participant"))),
      ).resolves.toEqual([]);
      await expectParticipantHistoryPreserved();
    },
  );

  it("bounds workspace application capabilities to exactly fifteen minutes", async () => {
    await seedLiveWorkshopFixture();
    const now = 1_800_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);

    try {
      const opened = await issueWorkshopWorkspaceApplication({
        sessionId: SESSION_ID,
        workspaceId: WORKSPACE_ID,
        applicationId: "gitea",
        actorUserId: "participant",
      });

      const request = accessMocks.issueStargateWorkspaceAppSession.mock
        .calls[0]?.[0] as { expiresAt: Date } | undefined;
      expect(request?.expiresAt.getTime()).toBe(now + 15 * 60_000);
      expect(opened.expiresAt).toBe(now + 15 * 60_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("cleans up the requested route when gateway response validation fails", async () => {
    await seedLiveWorkshopFixture();
    accessMocks.issueStargateWorkspaceAppSession.mockRejectedValueOnce(
      new Error("invalid stargate workspace application response"),
    );

    await expect(
      issueWorkshopWorkspaceApplication({
        sessionId: SESSION_ID,
        workspaceId: WORKSPACE_ID,
        applicationId: "gitea",
        actorUserId: "participant",
      }),
    ).rejects.toThrow("invalid stargate workspace application response");

    const request = accessMocks.issueStargateWorkspaceAppSession.mock
      .calls[0]?.[0] as { routeId: string } | undefined;
    expect(request?.routeId).toMatch(/^wa-[a-z0-9-]+$/);
    expect(accessMocks.deleteStargateWorkspaceAppRoute).toHaveBeenCalledOnce();
    expect(accessMocks.deleteStargateWorkspaceAppRoute).toHaveBeenCalledWith(
      request?.routeId,
    );
    await expect(
      env.DB.prepare(
        "SELECT id FROM workshop_route_issuance_intents WHERE workspace_id = ?",
      )
        .bind(WORKSPACE_ID)
        .all(),
    ).resolves.toMatchObject({ results: [] });
    await expect(
      drizzle(env.DB)
        .select({ routes: workshopWorkspaces.applicationRouteIdsJson })
        .from(workshopWorkspaces)
        .where(eq(workshopWorkspaces.id, WORKSPACE_ID)),
    ).resolves.toEqual([{ routes: [APPLICATION_ROUTE] }]);
  });

  it("blocks application issuance interleaved after the removal cleanup snapshot", async () => {
    await seedLiveWorkshopFixture();
    let interleavedResult:
      | { ok: true }
      | { ok: false; error: unknown }
      | undefined;
    accessMocks.deleteStargateRoute.mockImplementationOnce(async () => {
      interleavedResult = await issueWorkshopWorkspaceApplication({
        sessionId: SESSION_ID,
        workspaceId: WORKSPACE_ID,
        applicationId: "gitea",
        actorUserId: "participant",
      }).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    });

    await removeOrganizationMember({
      organizationId: ORGANIZATION_ID,
      memberId: membershipId("participant"),
      actorUserId: "owner",
    });

    expect(interleavedResult).toMatchObject({
      ok: false,
      error: {
        code: "workshop_session_not_found",
      },
    });
    expect(accessMocks.issueStargateWorkspaceAppSession).not.toHaveBeenCalled();
    expect(accessMocks.deleteStargateWorkspaceAppRoute).toHaveBeenCalledWith(
      APPLICATION_ROUTE,
    );
    const db = drizzle(env.DB);
    const [memberships, workspaces] = await Promise.all([
      db
        .select()
        .from(member)
        .where(eq(member.id, membershipId("participant"))),
      db
        .select({ routes: workshopWorkspaces.applicationRouteIdsJson })
        .from(workshopWorkspaces)
        .where(eq(workshopWorkspaces.id, WORKSPACE_ID)),
    ]);
    expect(memberships).toEqual([]);
    expect(workspaces).toEqual([{ routes: [] }]);
  });

  it("keeps a fresh issuance fenced, retains failed compensation, and cleans it on retry", async () => {
    await seedLiveWorkshopFixture();
    let resolveGateway:
      | ((value: {
          routeId: string;
          url: string;
          bootstrapExpiresAt: number;
          expiresAt: number;
        }) => void)
      | undefined;
    accessMocks.issueStargateWorkspaceAppSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveGateway = resolve;
        }),
    );
    const opening = issueWorkshopWorkspaceApplication({
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      applicationId: "gitea",
      actorUserId: "participant",
    });
    await vi.waitFor(() => {
      expect(accessMocks.issueStargateWorkspaceAppSession).toHaveBeenCalledOnce();
    });
    const gatewayRequest = accessMocks.issueStargateWorkspaceAppSession.mock
      .calls[0]?.[0] as { routeId: string; expiresAt: Date } | undefined;
    if (!gatewayRequest || !resolveGateway) {
      throw new Error("pending gateway request missing");
    }

    await expect(
      removeOrganizationMember({
        organizationId: ORGANIZATION_ID,
        memberId: membershipId("participant"),
        actorUserId: "owner",
      }),
    ).rejects.toMatchObject({ code: "workshop_route_issuance_in_progress" });

    const db = drizzle(env.DB);
    await expect(
      db
        .select({ state: runtimeExecutions.state })
        .from(runtimeExecutions)
        .where(eq(runtimeExecutions.id, EXECUTION_ID)),
    ).resolves.toEqual([{ state: "archived" }]);
    await expect(
      db
        .select({ routes: workshopWorkspaces.applicationRouteIdsJson })
        .from(workshopWorkspaces)
        .where(eq(workshopWorkspaces.id, WORKSPACE_ID)),
    ).resolves.toEqual([{ routes: [] }]);

    accessMocks.deleteStargateWorkspaceAppRoute.mockImplementation(
      async (routeId: string) => {
        if (routeId === gatewayRequest.routeId) {
          throw new Error("injected compensation delete failure");
        }
      },
    );
    resolveGateway({
      routeId: gatewayRequest.routeId,
      url: `https://${gatewayRequest.routeId}.intar.app/?__intar_bootstrap=one-time`,
      bootstrapExpiresAt: gatewayRequest.expiresAt.getTime() - 1_000,
      expiresAt: gatewayRequest.expiresAt.getTime(),
    });
    await expect(opening).rejects.toThrow(
      "injected compensation delete failure",
    );
    const issuedIntent = await env.DB.prepare(
      `SELECT state, route_key
       FROM workshop_route_issuance_intents
       WHERE workspace_id = ?`,
    )
      .bind(WORKSPACE_ID)
      .all<{ state: string; route_key: string }>();
    expect(issuedIntent.results).toEqual([
      { state: "issued", route_key: gatewayRequest.routeId },
    ]);
    await expect(
      db
        .select({ fence: member.workshopAccessRevokingAt })
        .from(member)
        .where(eq(member.id, membershipId("participant"))),
    ).resolves.toEqual([{ fence: expect.any(Date) }]);

    accessMocks.deleteStargateWorkspaceAppRoute.mockResolvedValue(undefined);
    await removeOrganizationMember({
      organizationId: ORGANIZATION_ID,
      memberId: membershipId("participant"),
      actorUserId: "owner",
    });
    expect(accessMocks.deleteStargateWorkspaceAppRoute).toHaveBeenCalledWith(
      gatewayRequest.routeId,
    );
    await expect(
      db.select().from(member).where(eq(member.id, membershipId("participant"))),
    ).resolves.toEqual([]);
    await expect(
      env.DB.prepare(
        "SELECT id FROM workshop_route_issuance_intents WHERE workspace_id = ?",
      )
        .bind(WORKSPACE_ID)
        .all(),
    ).resolves.toMatchObject({ results: [] });
  });

  it("retires stale pending terminal and application intents before removal", async () => {
    await seedLiveWorkshopFixture();
    const createdAt = Date.now() - 2 * 60_000 - 1;
    await env.DB.batch([
      routeIntentInsert({
        id: "stale-terminal-intent",
        kind: "terminal",
        routeKey: "stale-terminal-route",
        createdAt,
      }),
      routeIntentInsert({
        id: "stale-application-intent",
        kind: "application",
        routeKey: "stale-application-route",
        createdAt,
      }),
    ]);

    await removeOrganizationMember({
      organizationId: ORGANIZATION_ID,
      memberId: membershipId("participant"),
      actorUserId: "owner",
    });

    expect(accessMocks.deleteStargateRoute).toHaveBeenCalledWith(
      "stale-terminal-route",
    );
    expect(accessMocks.deleteStargateWorkspaceAppRoute).toHaveBeenCalledWith(
      "stale-application-route",
    );
    const intents = await env.DB.prepare(
      "SELECT id FROM workshop_route_issuance_intents WHERE workspace_id = ?",
    )
      .bind(WORKSPACE_ID)
      .all();
    expect(intents.results).toEqual([]);
  });

  it("archives a domain-owned runtime even when its generation link is missing", async () => {
    await seedLiveWorkshopFixture();
    await drizzle(env.DB)
      .update(workshopWorkspaceGenerations)
      .set({ runtimeExecutionId: null })
      .where(eq(workshopWorkspaceGenerations.id, GENERATION_ID));

    await removeOrganizationMember({
      organizationId: ORGANIZATION_ID,
      memberId: membershipId("participant"),
      actorUserId: "owner",
    });

    const db = drizzle(env.DB);
    await expect(
      db
        .select({ state: runtimeExecutions.state })
        .from(runtimeExecutions)
        .where(eq(runtimeExecutions.id, EXECUTION_ID)),
    ).resolves.toEqual([{ state: "archived" }]);
    await expect(db.select().from(activeRuntimeSlots)).resolves.toEqual([]);
  });

  it("rejects a pre-authorized facilitator session mutation after removal wins the commit race", async () => {
    await seedLiveWorkshopFixture();
    accessMocks.afterWorkshopManagerAuthorizationOnce = async () => {
      await removeOrganizationMember({
        organizationId: ORGANIZATION_ID,
        memberId: membershipId("facilitator"),
        actorUserId: "owner",
      });
    };

    await expect(
      updateWorkshopSession({
        sessionId: SESSION_ID,
        actorUserId: "facilitator",
        expectedVersion: 4,
        state: "ended",
      }),
    ).rejects.toMatchObject({ code: "workshop_version_conflict" });

    const db = drizzle(env.DB);
    await expect(
      db
        .select({ state: workshopSessions.state, version: workshopSessions.version })
        .from(workshopSessions)
        .where(eq(workshopSessions.id, SESSION_ID)),
    ).resolves.toEqual([{ state: "live", version: 4 }]);
    await expect(
      db.select().from(member).where(eq(member.id, membershipId("facilitator"))),
    ).resolves.toEqual([]);
    await expect(
      db
        .select({ state: runtimeExecutions.state })
        .from(runtimeExecutions)
        .where(eq(runtimeExecutions.id, EXECUTION_ID)),
    ).resolves.toEqual([{ state: "ready" }]);
  });

  it("cannot resurrect a helper claim after helper removal cleanup", async () => {
    await seedLiveWorkshopFixture();
    const db = drizzle(env.DB);
    await db
      .delete(workshopAssistGrants)
      .where(eq(workshopAssistGrants.id, "assist-grant"));
    await db
      .update(workshopHelpRequests)
      .set({
        status: "open",
        claimedBy: null,
        claimedAt: null,
        updatedAt: 1_800_000_000_001,
      })
      .where(eq(workshopHelpRequests.id, "help-request"));
    accessMocks.afterWorkshopHelperAuthorizationOnce = async () => {
      await removeOrganizationMember({
        organizationId: ORGANIZATION_ID,
        memberId: membershipId("helper"),
        actorUserId: "owner",
      });
    };

    await expect(
      claimWorkshopHelpRequest({
        sessionId: SESSION_ID,
        helpRequestId: "help-request",
        helperUserId: "helper",
      }),
    ).rejects.toMatchObject({ code: "workshop_help_request_unavailable" });
    await expect(
      db
        .select({
          status: workshopHelpRequests.status,
          claimedBy: workshopHelpRequests.claimedBy,
        })
        .from(workshopHelpRequests)
        .where(eq(workshopHelpRequests.id, "help-request")),
    ).resolves.toEqual([{ status: "open", claimedBy: null }]);
  });

  it("assist revoke sweeps issued helper terminal intents", async () => {
    await seedLiveWorkshopFixture();
    const createdAt = Date.now();
    await env.DB.prepare(
      `INSERT INTO workshop_route_issuance_intents
         (id, organization_id, session_id, workspace_id, generation_id,
          actor_user_id, kind, route_key, state, capability_expires_at,
          created_at, updated_at)
       VALUES ('helper-terminal-intent', ?, ?, ?, ?, 'helper', 'terminal',
               'helper-unrecorded-route', 'issued', ?, ?, ?)`,
    )
      .bind(
        ORGANIZATION_ID,
        SESSION_ID,
        WORKSPACE_ID,
        GENERATION_ID,
        createdAt + 15 * 60_000,
        createdAt,
        createdAt,
      )
      .run();

    await revokeWorkshopAssist({
      sessionId: SESSION_ID,
      grantId: "assist-grant",
      actorUserId: "helper",
    });

    expect(accessMocks.deleteStargateRoute).toHaveBeenCalledWith(ASSIST_ROUTE);
    expect(accessMocks.deleteStargateRoute).toHaveBeenCalledWith(
      "helper-unrecorded-route",
    );
    const intents = await env.DB.prepare(
      "SELECT id FROM workshop_route_issuance_intents WHERE id = 'helper-terminal-intent'",
    ).all();
    expect(intents.results).toEqual([]);
  });

  it("preserves exactly one owner when role update races ownership transfer", async () => {
    await seedLiveWorkshopFixture();

    const [roleUpdate, transfer] = await Promise.allSettled([
      updateOrganizationMemberRole({
        organizationId: ORGANIZATION_ID,
        actorUserId: "owner",
        memberId: membershipId("participant"),
        role: "member",
      }),
      transferOrganizationOwnership({
        organizationId: ORGANIZATION_ID,
        actorUserId: "owner",
        targetMemberId: membershipId("participant"),
      }),
    ]);

    expect(transfer.status).toBe("fulfilled");
    expect(["fulfilled", "rejected"]).toContain(roleUpdate.status);
    const roles = await drizzle(env.DB)
      .select({ userId: member.userId, role: member.role })
      .from(member)
      .where(eq(member.organizationId, ORGANIZATION_ID));
    expect(roles.filter((entry) => entry.role === "owner")).toEqual([
      { userId: "participant", role: "owner" },
    ]);
  });

  it("preserves exactly one owner when removal races ownership transfer", async () => {
    await seedLiveWorkshopFixture();

    await Promise.allSettled([
      removeOrganizationMember({
        organizationId: ORGANIZATION_ID,
        memberId: membershipId("facilitator"),
        actorUserId: "owner",
      }),
      transferOrganizationOwnership({
        organizationId: ORGANIZATION_ID,
        actorUserId: "owner",
        targetMemberId: membershipId("facilitator"),
      }),
    ]);

    const roles = await drizzle(env.DB)
      .select({ userId: member.userId, role: member.role })
      .from(member)
      .where(eq(member.organizationId, ORGANIZATION_ID));
    expect(roles.filter((entry) => entry.role === "owner")).toHaveLength(1);
  });
});

async function seedLiveWorkshopFixture(): Promise<void> {
  const db = drizzle(env.DB);
  const now = 1_800_000_000_000;
  const createdAt = new Date(now);
  await db.insert(user).values(
    ["owner", "participant", "helper", "facilitator"].map((id) => ({
      id,
      name: id,
      email: `${id}@example.test`,
      emailVerified: true,
      createdAt,
      updatedAt: createdAt,
    })),
  );
  await db.insert(organization).values({
    id: ORGANIZATION_ID,
    name: "Workshop Organization",
    slug: ORGANIZATION_ID,
    createdAt,
  });
  await db
    .insert(member)
    .values([
      membership("owner", "owner", createdAt),
      membership("participant", "member", createdAt),
      membership("helper", "member", createdAt),
      membership("facilitator", "member", createdAt),
    ]);
  await db.insert(workshopTemplates).values({
    id: "workshop-template",
    organizationId: ORGANIZATION_ID,
    slug: "platform-engineering",
    title: "Platform Engineering",
    summary: "Workshop membership revocation fixture",
    createdBy: "owner",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workshopTemplateRevisions).values({
    id: "workshop-revision",
    templateId: "workshop-template",
    revision: 1,
    sourceRevision: "test-source",
    contentHash: "a".repeat(64),
    manifestJson: workshopManifest(),
    publishedBy: "owner",
    publishedAt: now,
  });
  await db
    .update(workshopTemplates)
    .set({ currentRevisionId: "workshop-revision", updatedAt: now })
    .where(eq(workshopTemplates.id, "workshop-template"));
  await db.insert(workshopSessions).values({
    id: SESSION_ID,
    organizationId: ORGANIZATION_ID,
    templateRevisionId: "workshop-revision",
    title: "Live workshop",
    state: "live",
    version: 3,
    scheduledStartAt: now,
    lobbyOpensAt: now - 30 * 60_000,
    releasedModuleIdsJson: ["module-00"],
    createdBy: "owner",
    startedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db
    .insert(workshopSessionMembers)
    .values([
      roster("owner", "facilitator", "not_ready", now),
      roster("participant", "participant", "ready", now),
      roster("helper", "helper", "not_ready", now),
      roster("facilitator", "facilitator", "not_ready", now),
    ]);
  await db.insert(workshopWorkspaces).values({
    id: WORKSPACE_ID,
    sessionId: SESSION_ID,
    userId: "participant",
    state: "ready",
    terminalRouteUsernamesJson: [PARTICIPANT_ROUTE, ASSIST_ROUTE],
    applicationRouteIdsJson: [APPLICATION_ROUTE],
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workshopWorkspaceGenerations).values({
    id: GENERATION_ID,
    workspaceId: WORKSPACE_ID,
    ordinal: 1,
    checkpointId: "checkpoint-00",
    state: "ready",
    requestedAt: now,
    readyAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db
    .update(workshopWorkspaces)
    .set({ currentGenerationId: GENERATION_ID, updatedAt: now })
    .where(eq(workshopWorkspaces.id, WORKSPACE_ID));
  await db.insert(runtimeExecutions).values({
    id: EXECUTION_ID,
    userId: "participant",
    organizationId: ORGANIZATION_ID,
    domainKind: "workshop",
    domainId: WORKSPACE_ID,
    generation: 1,
    checkpointId: "checkpoint-00",
    state: "ready",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(activeRuntimeSlots).values({
    userId: "participant",
    executionId: EXECUTION_ID,
    acquiredAt: now,
  });
  await db
    .update(workshopWorkspaceGenerations)
    .set({ runtimeExecutionId: EXECUTION_ID, updatedAt: now })
    .where(eq(workshopWorkspaceGenerations.id, GENERATION_ID));
  await db.insert(workshopModuleProgress).values({
    id: "participant-progress",
    sessionId: SESSION_ID,
    userId: "participant",
    moduleId: "module-00",
    technicalStatus: "verified",
    currentHealth: "passing",
    explainBackStatus: "completed",
    firstVerifiedAt: now,
    completedAt: now,
    updatedAt: now,
  });
  await db.insert(workshopHelpRequests).values({
    id: "help-request",
    sessionId: SESSION_ID,
    requesterUserId: "participant",
    moduleId: "module-00",
    message: "Please help",
    status: "claimed",
    activeKey: `${SESSION_ID}:participant`,
    claimedBy: "helper",
    claimedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workshopAssistGrants).values({
    id: "assist-grant",
    sessionId: SESSION_ID,
    workspaceId: WORKSPACE_ID,
    helpRequestId: "help-request",
    learnerUserId: "participant",
    helperUserId: "helper",
    grantedAt: now,
    expiresAt: now + 15 * 60_000,
    terminalRouteUsernamesJson: [ASSIST_ROUTE],
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workshopEvents).values({
    id: "history-event",
    organizationId: ORGANIZATION_ID,
    sessionId: SESSION_ID,
    actorUserId: "participant",
    type: "module.verified",
    payloadJson: { moduleId: "module-00" },
    createdAt: now,
  });
}

async function expectParticipantHistoryPreserved(): Promise<void> {
  const db = drizzle(env.DB);
  const [roster, progress, help, events] = await Promise.all([
    db
      .select({
        role: workshopSessionMembers.role,
        provisionState: workshopSessionMembers.provisionState,
      })
      .from(workshopSessionMembers)
      .where(
        and(
          eq(workshopSessionMembers.sessionId, SESSION_ID),
          eq(workshopSessionMembers.userId, "participant"),
        ),
      ),
    db
      .select({
        technicalStatus: workshopModuleProgress.technicalStatus,
        explainBackStatus: workshopModuleProgress.explainBackStatus,
      })
      .from(workshopModuleProgress)
      .where(eq(workshopModuleProgress.id, "participant-progress")),
    db
      .select({
        message: workshopHelpRequests.message,
        status: workshopHelpRequests.status,
      })
      .from(workshopHelpRequests)
      .where(eq(workshopHelpRequests.id, "help-request")),
    db
      .select({ type: workshopEvents.type })
      .from(workshopEvents)
      .where(eq(workshopEvents.sessionId, SESSION_ID)),
  ]);
  expect(roster).toEqual([{ role: "participant", provisionState: "ended" }]);
  expect(progress).toEqual([
    { technicalStatus: "verified", explainBackStatus: "completed" },
  ]);
  expect(help).toEqual([{ message: "Please help", status: "cancelled" }]);
  expect(events.map((event) => event.type)).toEqual(
    expect.arrayContaining(["module.verified", "membership.access_revoked"]),
  );
}

function membership(
  userId: string,
  role: "owner" | "member",
  createdAt: Date,
): typeof member.$inferInsert {
  return {
    id: membershipId(userId),
    organizationId: ORGANIZATION_ID,
    userId,
    role,
    createdAt,
  };
}

function membershipId(userId: string): string {
  return `membership-${userId}`;
}

function roster(
  userId: string,
  role: "participant" | "helper" | "facilitator",
  provisionState: "not_ready" | "ready",
  now: number,
): typeof workshopSessionMembers.$inferInsert {
  return {
    id: `roster-${userId}`,
    sessionId: SESSION_ID,
    userId,
    role,
    provisionState,
    assignedBy: "owner",
    createdAt: now,
    updatedAt: now,
  };
}

function workshopManifest(): WorkshopManifestV1 {
  return {
    schemaVersion: 1,
    workshop: {
      slug: "platform-engineering",
      title: "Platform Engineering",
      summary: "Membership revocation test",
      prerequisites: [],
      defaultLobbyMinutes: 30,
    },
    workspace: {
      leaseGraceMinutes: 60,
      vms: [
        {
          id: "workshop",
          name: "Workshop",
          cpuMillis: 4_000,
          memoryMib: 16_384,
          diskMib: 102_400,
        },
      ],
      checkpoints: [
        {
          id: "checkpoint-00",
          label: "Initial",
          vmImages: [
            {
              vmId: "workshop",
              imageKey: { source: "test" },
              imageSha256: "a".repeat(64),
            },
          ],
        },
      ],
      initialCheckpointId: "checkpoint-00",
      applications: [
        {
          id: "gitea",
          label: "Gitea",
          vmId: "workshop",
          port: 3_000,
          protocol: "http",
        },
      ],
    },
    modules: [
      {
        id: "module-00",
        title: "Setup",
        tier: "gate",
        outcome: "Workspace ready",
        dependsOn: [],
        participantMarkdown: "Set up the workspace.",
        facilitatorNotesMarkdown: "Help learners get ready.",
        hints: [],
        solutionMarkdown: "Run setup.",
        explainBackPrompt: "Explain the setup.",
        probeIds: ["workspace-ready"],
        catchUpCheckpointId: "checkpoint-00",
      },
    ],
    agenda: [
      {
        id: "setup",
        kind: "lab",
        title: "Setup",
        durationMinutes: 15,
        scheduled: true,
        moduleId: "module-00",
        slideIds: ["slide-00"],
        release: "facilitator",
      },
    ],
    presentation: {
      slides: [
        {
          id: "slide-00",
          layout: "content",
          title: "Setup",
          bodyMarkdown: "Get ready.",
          moduleId: "module-00",
        },
      ],
    },
    durationMinutes: 15,
  };
}

function routeIntentInsert(input: {
  id: string;
  kind: "terminal" | "application";
  routeKey: string;
  createdAt: number;
}): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO workshop_route_issuance_intents
       (id, organization_id, session_id, workspace_id, generation_id,
        actor_user_id, kind, route_key, state, capability_expires_at,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'participant', ?, ?, 'pending', ?, ?, ?)`,
  ).bind(
    input.id,
    ORGANIZATION_ID,
    SESSION_ID,
    WORKSPACE_ID,
    GENERATION_ID,
    input.kind,
    input.routeKey,
    input.createdAt + 15 * 60_000,
    input.createdAt,
    input.createdAt,
  );
}
