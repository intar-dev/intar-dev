/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";

const providerMocks = vi.hoisted(() => ({
  requireFeature: vi.fn(),
  refreshPreflight: vi.fn(),
  run: vi.fn(),
  operations: [] as Array<Record<string, unknown>>,
  dependencySnapshots: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/hcloud-provider-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hcloud-provider-service")>()),
  hcloudRunOperation: providerMocks.run,
}));

vi.mock("./feature-flag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./feature-flag")>()),
  requireWorkshopHcloudRuntimeEnabledForOrganization:
    providerMocks.requireFeature,
}));

vi.mock("./session-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-provider")>()),
  refreshWorkshopSessionProviderPreflight: providerMocks.refreshPreflight,
}));

import type {
  CanonicalProviderWrite,
  HcloudOperationResult,
  RunOperationRequest,
} from "../../../../hcloud-provider-worker/src/contracts";
import {
  activeRuntimeSlots,
  agentHosts,
  hetznerAllocations,
  hostResourceReservations,
  member,
  organization,
  organizationProviderConnections,
  providerCredentialVersions,
  runtimeExecutions,
  runtimeProviderCheckpointArtifacts,
  runtimeProviderCostLedger,
  runtimeProviderGuestCredentials,
  user,
  workshopSessionCostForecasts,
  workshopSessionCostSummaries,
  workshopSessionMembers,
  workshopSessionRuntimeProviders,
  workshopSessions,
  workshopTemplateRevisions,
  workshopTemplates,
  workshopEvents,
  workshopWorkspaceGenerations,
  workshopWorkspaces,
  type ProviderPriceObservation,
  type WorkshopManifestV1,
} from "@/db/schema";
import { appError } from "@/lib/app-error";
import { createRuntimeExecution } from "@/lib/runtime-executions";
import { resetD1Database } from "@/test/d1-migrations";
import { performWorkshopSessionAction } from "./actions";
import { provisionWorkshopRequest } from "./runtime-orchestrator";
import { updateWorkshopSession } from "./sessions";
import {
  createWorkshopCostForecast,
  getWorkshopCostProjection,
} from "./cost-storage";
import {
  allocateHetznerWorkshopRuntime,
  archiveHetznerWorkshopRuntime,
  preflightHetznerWorkshopRuntime,
  reconcileHetznerWorkshopRuntime,
  sweepHetznerWorkshopRuntimes,
} from "./hcloud-runtime";
import type { WorkshopProvisioningRequest } from "./types";

const PROVIDER_CONNECTION_ID = "connection-hetzner-test";
const PROVIDER_CREDENTIAL_ID = "credential-hetzner-test";
const BINARY_SHA256 = "d".repeat(64);
const KINO_BINARY_SHA256 = "c".repeat(64);

describe("Hetzner workshop runtime provider", () => {
  beforeEach(async () => {
    await resetD1Database();
    providerMocks.requireFeature.mockReset();
    providerMocks.requireFeature.mockResolvedValue(undefined);
    providerMocks.refreshPreflight.mockReset();
    providerMocks.refreshPreflight.mockResolvedValue({ kind: "hetzner_cloud" });
    providerMocks.run.mockReset();
    providerMocks.run.mockImplementation(defaultProviderOperation);
    providerMocks.operations.length = 0;
    providerMocks.dependencySnapshots.length = 0;
    await seedWorkspaceAgentObjects();
  });

  it("allocates the exact pinned type as one direct server and persists identities before dependent calls", async () => {
    const fixture = await seedRuntimeFixture();
    const execution = await provisionWorkshopRequest(fixture.request);
    const db = drizzle(env.DB);

    expect(execution).toMatchObject({
      providerKind: "hetzner_cloud",
      providerConnectionId: PROVIDER_CONNECTION_ID,
      hostId: null,
      generation: 1,
    });
    expect(
      providerMocks.operations.filter(
        (operation) => operation.kind === "create_server",
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "create_server",
        serverType: "cx43",
        systemImage: "debian-13",
        location: "nbg1",
        primaryIpv4Id: 301,
        sshKeyId: 201,
        firewallId: 42,
        cloudInit: expect.stringContaining('probe "module-00-workspace-ready"'),
      }),
    ]);
    expect(providerMocks.dependencySnapshots).toEqual([
      expect.objectContaining({
        operation: "create_primary_ip",
        sshKeyId: "201",
      }),
      expect.objectContaining({
        operation: "create_server",
        sshKeyId: "201",
        primaryIpId: "301",
        primaryIpv4: "192.0.2.31",
      }),
    ]);

    const [runtime, allocations, ledgers, slots, reservations, hosts] =
      await Promise.all([
        db
          .select()
          .from(runtimeExecutions)
          .where(eq(runtimeExecutions.id, execution.executionId)),
        db.select().from(hetznerAllocations),
        db.select().from(runtimeProviderCostLedger),
        db.select().from(activeRuntimeSlots),
        db.select().from(hostResourceReservations),
        db.select().from(agentHosts),
      ]);
    expect(runtime[0]).toMatchObject({
      providerKind: "hetzner_cloud",
      providerConnectionId: PROVIDER_CONNECTION_ID,
      hostId: null,
      domainKind: "workshop",
      domainId: fixture.request.workspaceId,
    });
    expect(allocations).toEqual([
      expect.objectContaining({
        executionId: execution.executionId,
        serverId: "401",
        primaryIpId: "301",
        sshKeyId: "201",
        serverType: "cx43",
        systemImage: "debian-13",
        location: "nbg1",
        state: "bootstrapping",
      }),
    ]);
    expect(ledgers).toHaveLength(2);
    expect(
      ledgers.map((row) => ({
        kind: row.resourceKind,
        id: row.providerResourceId,
        currency: row.currency,
        hourlyNet: row.hourlyNetRaw,
        hourlyGross: row.hourlyGrossRaw,
      })),
    ).toEqual([
      {
        kind: "primary_ipv4",
        id: "301",
        currency: "NOK",
        hourlyNet: "0.0100",
        hourlyGross: "0.0125",
      },
      {
        kind: "server",
        id: "401",
        currency: "NOK",
        hourlyNet: "0.5000",
        hourlyGross: "0.6250",
      },
    ]);
    expect(slots).toEqual([
      expect.objectContaining({
        userId: "learner-a",
        executionId: execution.executionId,
      }),
    ]);
    expect(reservations).toEqual([]);
    expect(hosts).toEqual([]);
  });

  it("forecasts one learner seat for a workspace-enabled facilitator", async () => {
    const fixture = await seedRuntimeFixture({
      workspaceRole: "facilitator",
    });

    const forecast = await createWorkshopCostForecast({
      sessionId: "session-a",
      priceObservation: priceObservation(fixture.now),
      trigger: "admin_refresh",
      actorUserId: "owner-a",
      now: fixture.now,
    });

    const roster = await drizzle(env.DB)
      .select({
        role: workshopSessionMembers.role,
        workspaceEnabled: workshopSessionMembers.workspaceEnabled,
      })
      .from(workshopSessionMembers)
      .where(eq(workshopSessionMembers.sessionId, "session-a"));
    expect(roster).toEqual([
      { role: "facilitator", workspaceEnabled: true },
    ]);
    expect(forecast.participantCount).toBe(1);
    expect(forecast.expected).toMatchObject({
      participantCount: 1,
      totalNetMicros:
        forecast.expected.serverNetMicrosPerLearner +
        forecast.expected.ipv4NetMicrosPerLearner,
      totalGrossMicros:
        forecast.expected.serverGrossMicrosPerLearner +
        forecast.expected.ipv4GrossMicrosPerLearner,
    });
  });

  it("uses the immutable revision guest-tool pair after current.json changes", async () => {
    const fixture = await seedRuntimeFixture();
    await env.VM_IMAGE_REGISTRY_BUCKET.put(
      "workspace-agent/releases/current.json",
      JSON.stringify({
        schema_version: 2,
        sha256: "f".repeat(64),
        size_bytes: 1,
        kino_sha256: "e".repeat(64),
        kino_size_bytes: 1,
      }),
    );

    await provisionWorkshopRequest(fixture.request);
    const createServer = providerMocks.operations.find(
      (operation) => operation.kind === "create_server",
    );
    expect(createServer).toEqual(
      expect.objectContaining({
        cloudInit: expect.stringContaining(BINARY_SHA256),
      }),
    );
    expect(createServer).toEqual(
      expect.objectContaining({
        cloudInit: expect.stringContaining(KINO_BINARY_SHA256),
      }),
    );
    expect(createServer?.cloudInit).not.toContain("f".repeat(64));
  });

  it("uses provider resource creation time for cost ledgers and falls back to observation time", async () => {
    const fixture = await seedRuntimeFixture();
    const ipCreatedAt = fixture.now - 3 * 60 * 60_000;
    const serverObservedAt = fixture.now - 2 * 60 * 60_000;
    providerMocks.run.mockImplementation(
      async (request: RunOperationRequest) => {
        const result = await defaultProviderOperation(request);
        const write = result.canonicalWrites[0];
        if (!write) return result;
        if (request.operation.kind === "create_primary_ip") {
          write.resourceCreatedAt = new Date(ipCreatedAt).toISOString();
        }
        if (request.operation.kind === "create_server") {
          write.observedAt = new Date(serverObservedAt).toISOString();
        }
        return result;
      },
    );

    await allocateHetznerWorkshopRuntime(fixture.request);

    const ledgers = await drizzle(env.DB)
      .select()
      .from(runtimeProviderCostLedger);
    expect(
      ledgers.find((row) => row.resourceKind === "primary_ipv4")
        ?.providerCreatedAt,
    ).toBe(ipCreatedAt);
    expect(
      ledgers.find((row) => row.resourceKind === "server")?.providerCreatedAt,
    ).toBe(serverObservedAt);
  });

  it("rejects an invalid provider resource creation timestamp", async () => {
    const fixture = await seedRuntimeFixture();
    providerMocks.run.mockImplementation(
      async (request: RunOperationRequest) => {
        const result = await defaultProviderOperation(request);
        const write = result.canonicalWrites[0];
        if (write && request.operation.kind === "create_primary_ip") {
          write.resourceCreatedAt = "not-a-provider-timestamp";
        }
        return result;
      },
    );

    await expect(
      allocateHetznerWorkshopRuntime(fixture.request),
    ).rejects.toMatchObject({ code: "hcloud_canonical_write_time_invalid" });
  });

  it("returns the existing generation without rotating a consumed bootstrap or recreating resources", async () => {
    const fixture = await seedRuntimeFixture();
    const first = await allocateHetznerWorkshopRuntime(fixture.request);
    const consumedAt = fixture.now + 1_000;
    await env.DB.prepare(
      `UPDATE runtime_provider_guest_credentials
       SET bootstrap_consumed_at = ?, report_credential_hash = ?,
           report_credential_issued_at = ?, checkpoint_download_token_hash = ?,
           checkpoint_download_expires_at = ?, updated_at = ?
       WHERE execution_id = ?`,
    )
      .bind(
        consumedAt,
        "f".repeat(64),
        consumedAt,
        "e".repeat(64),
        consumedAt + 5 * 60_000,
        consumedAt,
        first.executionId,
      )
      .run();
    providerMocks.operations.length = 0;

    const duplicate = await allocateHetznerWorkshopRuntime(fixture.request);

    expect(duplicate.executionId).toBe(first.executionId);
    expect(providerMocks.operations).toEqual([]);
    const db = drizzle(env.DB);
    await expect(db.select().from(runtimeExecutions)).resolves.toEqual([
      expect.objectContaining({ id: first.executionId, state: "provisioning" }),
    ]);
    await expect(db.select().from(hetznerAllocations)).resolves.toEqual([
      expect.objectContaining({
        executionId: first.executionId,
        state: "bootstrapping",
        serverId: "401",
      }),
    ]);
    await expect(
      db.select().from(runtimeProviderGuestCredentials),
    ).resolves.toEqual([
      expect.objectContaining({
        executionId: first.executionId,
        bootstrapConsumedAt: consumedAt,
        reportCredentialRevokedAt: null,
      }),
    ]);
  });

  it("fences a stale in-flight attempt before it can create a duplicate server", async () => {
    const fixture = await seedRuntimeFixture();
    let releaseFirstPrimaryIp!: () => void;
    let signalFirstPrimaryIp!: () => void;
    const firstPrimaryIpEntered = new Promise<void>((resolve) => {
      signalFirstPrimaryIp = resolve;
    });
    const firstPrimaryIpReleased = new Promise<void>((resolve) => {
      releaseFirstPrimaryIp = resolve;
    });
    let primaryIpAttempts = 0;
    providerMocks.run.mockImplementation(
      async (request: RunOperationRequest) => {
        if (request.operation.kind === "create_primary_ip") {
          primaryIpAttempts += 1;
          if (primaryIpAttempts === 1) {
            signalFirstPrimaryIp();
            await firstPrimaryIpReleased;
          }
        }
        return defaultProviderOperation(request);
      },
    );

    const firstAttempt = allocateHetznerWorkshopRuntime(fixture.request);
    await firstPrimaryIpEntered;
    await drizzle(env.DB)
      .update(hetznerAllocations)
      .set({
        provisioningHeartbeatAt: fixture.now - 3 * 60_000,
        updatedAt: fixture.now - 3 * 60_000,
      });

    const resumed = await allocateHetznerWorkshopRuntime(fixture.request);
    releaseFirstPrimaryIp();
    const original = await firstAttempt;

    expect(resumed.executionId).toBe(original.executionId);
    expect(primaryIpAttempts).toBe(2);
    expect(
      providerMocks.operations.filter(
        (operation) => operation.kind === "create_server",
      ),
    ).toHaveLength(1);
    const db = drizzle(env.DB);
    await expect(db.select().from(runtimeExecutions)).resolves.toHaveLength(1);
    await expect(db.select().from(hetznerAllocations)).resolves.toEqual([
      expect.objectContaining({
        executionId: resumed.executionId,
        state: "bootstrapping",
        serverId: "401",
      }),
    ]);
    await expect(db.select().from(activeRuntimeSlots)).resolves.toHaveLength(1);
  });

  it("revokes guest credentials immediately but releases the active slot only after every deletion is confirmed", async () => {
    const fixture = await seedRuntimeFixture();
    const execution = await allocateHetznerWorkshopRuntime(fixture.request);
    providerMocks.operations.length = 0;

    await expect(
      archiveHetznerWorkshopRuntime({
        executionId: execution.executionId,
        expectedGeneration: 2,
        now: fixture.now + 5_000,
      }),
    ).rejects.toMatchObject({ code: "runtime_generation_stale" });
    expect(providerMocks.operations).toEqual([]);
    await expect(
      drizzle(env.DB).select().from(activeRuntimeSlots),
    ).resolves.toHaveLength(1);

    await drizzle(env.DB)
      .update(workshopSessions)
      .set({ state: "ended", endedAt: fixture.now + 9_000 })
      .where(eq(workshopSessions.id, fixture.request.sessionId));

    await expect(
      archiveHetznerWorkshopRuntime({
        executionId: execution.executionId,
        expectedGeneration: 1,
        now: fixture.now + 10_000,
      }),
    ).resolves.toBe(true);

    const db = drizzle(env.DB);
    const [allocation, runtime, credentials, ledgers, slots, summaries] =
      await Promise.all([
        db.select().from(hetznerAllocations),
        db
          .select()
          .from(runtimeExecutions)
          .where(eq(runtimeExecutions.id, execution.executionId)),
        db.select().from(runtimeProviderGuestCredentials),
        db.select().from(runtimeProviderCostLedger),
        db.select().from(activeRuntimeSlots),
        db.select().from(workshopSessionCostSummaries),
      ]);
    expect(
      providerMocks.operations
        .filter((operation) => operation.kind === "delete_resource")
        .map((operation) => operation.resourceKind),
    ).toEqual(["server", "primary_ip", "ssh_key"]);
    expect(allocation[0]).toMatchObject({
      state: "deleted",
      deletionConfirmedAt: fixture.now + 10_000,
    });
    expect(runtime[0]).toMatchObject({
      state: "archived",
      endedAt: fixture.now + 10_000,
    });
    expect(credentials[0]).toMatchObject({
      reportCredentialRevokedAt: fixture.now + 10_000,
      bootstrapExpiresAt: fixture.now + 10_000,
    });
    expect(
      ledgers.every((row) => row.deletionConfirmedAt === fixture.now + 10_000),
    ).toBe(true);
    expect(slots).toEqual([]);
    expect(summaries).toEqual([
      expect.objectContaining({
        sessionId: fixture.request.sessionId,
        currency: "NOK",
        finalNetMicros: 510_000,
        finalGrossMicros: 637_500,
        generationCount: 1,
        restoreCount: 0,
        cleanupPendingCount: 0,
        finalizedAt: fixture.now + 10_000,
      }),
    ]);
  });

  it("drains recordings before revoking the guest credential and deleting resources", async () => {
    const fixture = await seedRuntimeFixture();
    const execution = await allocateHetznerWorkshopRuntime(fixture.request);
    const drainAt = fixture.now + 10_000;
    const db = drizzle(env.DB);
    await Promise.all([
      db
        .update(hetznerAllocations)
        .set({ lastReportAt: fixture.now + 5_000 })
        .where(eq(hetznerAllocations.executionId, execution.executionId)),
      db
        .update(workshopSessions)
        .set({ state: "ended", endedAt: drainAt, updatedAt: drainAt })
        .where(eq(workshopSessions.id, fixture.request.sessionId)),
    ]);
    providerMocks.operations.length = 0;

    await expect(
      archiveHetznerWorkshopRuntime({
        executionId: execution.executionId,
        expectedGeneration: 1,
        now: drainAt,
      }),
    ).resolves.toBe(false);
    await expect(db.select().from(hetznerAllocations)).resolves.toEqual([
      expect.objectContaining({
        state: "draining",
        recordingDrainRequestedAt: drainAt,
        recordingDrainCompletedAt: null,
        deletionRequestedAt: null,
      }),
    ]);
    await expect(
      db
        .select({ state: workshopWorkspaceGenerations.state })
        .from(workshopWorkspaceGenerations),
    ).resolves.toEqual([{ state: "archiving" }]);
    await expect(
      db
        .select({ state: runtimeExecutions.state })
        .from(runtimeExecutions)
        .where(eq(runtimeExecutions.id, execution.executionId)),
    ).resolves.toEqual([{ state: "archiving" }]);
    await expect(
      db.select().from(runtimeProviderGuestCredentials),
    ).resolves.toEqual([
      expect.objectContaining({ reportCredentialRevokedAt: null }),
    ]);
    expect(providerMocks.operations).toEqual([]);
    await expect(db.select().from(activeRuntimeSlots)).resolves.toHaveLength(1);

    await db
      .update(hetznerAllocations)
      .set({ recordingDrainCompletedAt: drainAt + 5_000 })
      .where(eq(hetznerAllocations.executionId, execution.executionId));
    await expect(
      archiveHetznerWorkshopRuntime({
        executionId: execution.executionId,
        expectedGeneration: 1,
        now: drainAt + 10_000,
      }),
    ).resolves.toBe(true);
    await expect(db.select().from(hetznerAllocations)).resolves.toEqual([
      expect.objectContaining({
        state: "deleted",
        recordingDrainCompletedAt: drainAt + 5_000,
        deletionConfirmedAt: drainAt + 10_000,
      }),
    ]);
    await expect(
      db.select().from(runtimeProviderGuestCredentials),
    ).resolves.toEqual([
      expect.objectContaining({
        reportCredentialRevokedAt: drainAt + 10_000,
      }),
    ]);
    await expect(db.select().from(activeRuntimeSlots)).resolves.toEqual([]);
  });

  it("keeps the active slot through the full persisted recording-drain timeout", async () => {
    const fixture = await seedRuntimeFixture();
    const execution = await allocateHetznerWorkshopRuntime(fixture.request);
    const drainAt = fixture.now + 10_000;
    const db = drizzle(env.DB);
    await db
      .update(hetznerAllocations)
      .set({ lastReportAt: fixture.now + 5_000 })
      .where(eq(hetznerAllocations.executionId, execution.executionId));
    providerMocks.operations.length = 0;

    await expect(
      archiveHetznerWorkshopRuntime({
        executionId: execution.executionId,
        expectedGeneration: 1,
        now: drainAt,
      }),
    ).resolves.toBe(false);
    await expect(
      archiveHetznerWorkshopRuntime({
        executionId: execution.executionId,
        expectedGeneration: 1,
        now: drainAt + 59_999,
      }),
    ).resolves.toBe(false);
    expect(providerMocks.operations).toEqual([]);
    await expect(db.select().from(activeRuntimeSlots)).resolves.toHaveLength(1);

    await expect(
      archiveHetznerWorkshopRuntime({
        executionId: execution.executionId,
        expectedGeneration: 1,
        now: drainAt + 60_000,
      }),
    ).resolves.toBe(true);
    await expect(db.select().from(hetznerAllocations)).resolves.toEqual([
      expect.objectContaining({
        state: "deleted",
        lastErrorCode: "recording_drain_timeout",
        recordingDrainRequestedAt: drainAt,
        recordingDrainCompletedAt: null,
        deletionConfirmedAt: drainAt + 60_000,
      }),
    ]);
    await expect(db.select().from(activeRuntimeSlots)).resolves.toEqual([]);
  });

  it("expires a Hetzner lease through confirmed provider deletion and finalizes an ended session", async () => {
    const fixture = await seedRuntimeFixture();
    const execution = await allocateHetznerWorkshopRuntime(fixture.request);
    const expiredAt = fixture.now + 5_000;
    const sweptAt = expiredAt + 1;
    const db = drizzle(env.DB);
    await Promise.all([
      db
        .update(runtimeExecutions)
        .set({ leaseExpiresAt: expiredAt, updatedAt: expiredAt })
        .where(eq(runtimeExecutions.id, execution.executionId)),
      db
        .update(workshopSessions)
        .set({ state: "ended", endedAt: expiredAt, updatedAt: expiredAt })
        .where(eq(workshopSessions.id, fixture.request.sessionId)),
    ]);
    providerMocks.operations.length = 0;

    await expect(
      sweepHetznerWorkshopRuntimes({ now: sweptAt, limit: 1 }),
    ).resolves.toMatchObject({
      inspected: 1,
      leaseExpired: 1,
      cleanupPending: 0,
    });

    const [allocation, runtime, generation, workspace, credentials, ledgers] =
      await Promise.all([
        db.select().from(hetznerAllocations),
        db
          .select()
          .from(runtimeExecutions)
          .where(eq(runtimeExecutions.id, execution.executionId)),
        db.select().from(workshopWorkspaceGenerations),
        db.select().from(workshopWorkspaces),
        db.select().from(runtimeProviderGuestCredentials),
        db.select().from(runtimeProviderCostLedger),
      ]);
    expect(
      providerMocks.operations
        .filter((operation) => operation.kind === "delete_resource")
        .map((operation) => operation.resourceKind),
    ).toEqual(["server", "primary_ip", "ssh_key"]);
    expect(allocation[0]).toMatchObject({
      state: "deleted",
      deletionConfirmedAt: sweptAt,
    });
    expect(runtime[0]).toMatchObject({ state: "archived", endedAt: sweptAt });
    expect(generation[0]).toMatchObject({ state: "archived" });
    expect(workspace[0]).toMatchObject({ state: "ended" });
    expect(credentials[0]).toMatchObject({
      reportCredentialRevokedAt: sweptAt,
      bootstrapExpiresAt: sweptAt,
    });
    expect(ledgers.every((row) => row.deletionConfirmedAt === sweptAt)).toBe(
      true,
    );
    await expect(db.select().from(activeRuntimeSlots)).resolves.toEqual([]);
    await expect(
      db.select().from(workshopSessionCostSummaries),
    ).resolves.toEqual([
      expect.objectContaining({
        sessionId: fixture.request.sessionId,
        finalNetMicros: 510_000,
        finalGrossMicros: 637_500,
        finalizedAt: sweptAt,
      }),
    ]);
  });

  it("keeps an expired Hetzner lease billed and slotted until asynchronous deletion is confirmed", async () => {
    const fixture = await seedRuntimeFixture();
    const execution = await allocateHetznerWorkshopRuntime(fixture.request);
    const expiredAt = fixture.now + 5_000;
    const db = drizzle(env.DB);
    await db
      .update(runtimeExecutions)
      .set({ leaseExpiresAt: expiredAt, updatedAt: expiredAt })
      .where(eq(runtimeExecutions.id, execution.executionId));
    let serverDeleteRequested = false;
    providerMocks.run.mockImplementation(
      async (request: RunOperationRequest) => {
        if (
          request.operation.kind === "delete_resource" &&
          request.operation.resourceKind === "server" &&
          !serverDeleteRequested
        ) {
          serverDeleteRequested = true;
          const write: CanonicalProviderWrite = {
            ...canonicalWrite(
              request,
              "server",
              request.operation.externalId,
              "resource_deletion_requested",
            ),
            actionIds: [902],
          };
          return operationResult(write);
        }
        if (
          request.operation.kind === "get_action" &&
          request.operation.actionId === 902
        ) {
          return actionResult(902, "running");
        }
        return defaultProviderOperation(request);
      },
    );

    await expect(
      sweepHetznerWorkshopRuntimes({ now: expiredAt + 1 }),
    ).resolves.toMatchObject({ leaseExpired: 1, cleanupPending: 0 });
    await expect(db.select().from(hetznerAllocations)).resolves.toEqual([
      expect.objectContaining({
        state: "deleting",
        deleteActionId: "902",
        deletionConfirmedAt: null,
      }),
    ]);
    await expect(db.select().from(activeRuntimeSlots)).resolves.toHaveLength(1);
    await expect(db.select().from(runtimeProviderCostLedger)).resolves.toEqual([
      expect.objectContaining({ deletionConfirmedAt: null }),
      expect.objectContaining({ deletionConfirmedAt: null }),
    ]);

    providerMocks.run.mockImplementation(defaultProviderOperation);
    await expect(
      sweepHetznerWorkshopRuntimes({ now: expiredAt + 60_000 }),
    ).resolves.toMatchObject({ leaseExpired: 1, cleanupPending: 0 });
    await expect(db.select().from(hetznerAllocations)).resolves.toEqual([
      expect.objectContaining({
        state: "deleted",
        deletionConfirmedAt: expiredAt + 60_000,
      }),
    ]);
    await expect(db.select().from(activeRuntimeSlots)).resolves.toEqual([]);
  });

  it("retains expired resources, external IDs, and the active slot when provider cleanup fails", async () => {
    const fixture = await seedRuntimeFixture();
    const execution = await allocateHetznerWorkshopRuntime(fixture.request);
    const expiredAt = fixture.now + 5_000;
    const db = drizzle(env.DB);
    await db
      .update(runtimeExecutions)
      .set({ leaseExpiresAt: expiredAt, updatedAt: expiredAt })
      .where(eq(runtimeExecutions.id, execution.executionId));
    providerMocks.run.mockImplementation(
      async (request: RunOperationRequest) => {
        if (
          request.operation.kind === "delete_resource" &&
          request.operation.resourceKind === "server"
        ) {
          throw appError(
            503,
            "hcloud_provider_unavailable",
            "provider unavailable",
          );
        }
        return defaultProviderOperation(request);
      },
    );

    await expect(
      sweepHetznerWorkshopRuntimes({ now: expiredAt + 1 }),
    ).resolves.toMatchObject({
      inspected: 1,
      leaseExpired: 1,
      cleanupPending: 1,
    });
    await expect(db.select().from(hetznerAllocations)).resolves.toEqual([
      expect.objectContaining({
        state: "cleanup_pending",
        serverId: "401",
        primaryIpId: "301",
        sshKeyId: "201",
        deletionConfirmedAt: null,
      }),
    ]);
    await expect(
      db.select().from(organizationProviderConnections),
    ).resolves.toEqual([expect.objectContaining({ state: "cleanup_pending" })]);
    await expect(db.select().from(activeRuntimeSlots)).resolves.toHaveLength(1);
  });

  it("keeps the slot and external IDs visible while cleanup is pending, then lets the sweep finish it", async () => {
    const fixture = await seedRuntimeFixture();
    const execution = await allocateHetznerWorkshopRuntime(fixture.request);
    await drizzle(env.DB)
      .update(workshopSessions)
      .set({ state: "ended", endedAt: fixture.now + 9_000 })
      .where(eq(workshopSessions.id, fixture.request.sessionId));
    providerMocks.run.mockImplementation(
      async (request: RunOperationRequest) => {
        if (
          request.operation.kind === "delete_resource" &&
          request.operation.resourceKind === "server"
        ) {
          throw appError(
            503,
            "hcloud_provider_unavailable",
            "provider unavailable",
          );
        }
        return defaultProviderOperation(request);
      },
    );

    await expect(
      archiveHetznerWorkshopRuntime({
        executionId: execution.executionId,
        expectedGeneration: 1,
        now: fixture.now + 10_000,
      }),
    ).rejects.toMatchObject({ code: "hcloud_provider_unavailable" });

    const db = drizzle(env.DB);
    const [allocation, runtime, credentials, connection, slots, summaries] =
      await Promise.all([
        db.select().from(hetznerAllocations),
        db
          .select()
          .from(runtimeExecutions)
          .where(eq(runtimeExecutions.id, execution.executionId)),
        db.select().from(runtimeProviderGuestCredentials),
        db.select().from(organizationProviderConnections),
        db.select().from(activeRuntimeSlots),
        db.select().from(workshopSessionCostSummaries),
      ]);
    expect(allocation[0]).toMatchObject({
      state: "cleanup_pending",
      serverId: "401",
      primaryIpId: "301",
      sshKeyId: "201",
      deletionConfirmedAt: null,
    });
    expect(runtime[0]?.state).not.toBe("archived");
    expect(credentials[0]?.reportCredentialRevokedAt).toBe(
      fixture.now + 10_000,
    );
    expect(connection[0]?.state).toBe("cleanup_pending");
    expect(slots).toEqual([
      expect.objectContaining({ executionId: execution.executionId }),
    ]);
    expect(summaries).toEqual([]);

    providerMocks.run.mockImplementation(defaultProviderOperation);
    await expect(
      sweepHetznerWorkshopRuntimes({ now: fixture.now + 70_000 }),
    ).resolves.toMatchObject({
      inspected: 1,
      cleanupPending: 0,
    });
    const [cleaned, releasedSlots, finalized, recoveredConnection] =
      await Promise.all([
        db.select().from(hetznerAllocations),
        db.select().from(activeRuntimeSlots),
        db.select().from(workshopSessionCostSummaries),
        db.select().from(organizationProviderConnections),
      ]);
    expect(cleaned[0]).toMatchObject({
      state: "deleted",
      deletionConfirmedAt: fixture.now + 70_000,
    });
    expect(releasedSlots).toEqual([]);
    expect(finalized[0]).toMatchObject({
      finalNetMicros: 510_000,
      finalGrossMicros: 637_500,
      finalizedAt: fixture.now + 70_000,
    });
    expect(recoveredConnection[0]?.state).toBe("active");
  });

  it("continues ordered cleanup after an asynchronous server delete outlives the bounded poll", async () => {
    const fixture = await seedRuntimeFixture();
    const execution = await allocateHetznerWorkshopRuntime(fixture.request);
    await drizzle(env.DB)
      .update(workshopSessions)
      .set({ state: "ended", endedAt: fixture.now + 9_000 })
      .where(eq(workshopSessions.id, fixture.request.sessionId));

    let serverDeleteRequested = false;
    providerMocks.run.mockImplementation(
      async (request: RunOperationRequest) => {
        if (
          request.operation.kind === "delete_resource" &&
          request.operation.resourceKind === "server" &&
          !serverDeleteRequested
        ) {
          serverDeleteRequested = true;
          providerMocks.operations.push(
            request.operation as unknown as Record<string, unknown>,
          );
          const write: CanonicalProviderWrite = {
            ...canonicalWrite(
              request,
              "server",
              request.operation.externalId,
              "resource_deletion_requested",
            ),
            actionIds: [901],
          };
          return operationResult(write);
        }
        if (
          request.operation.kind === "get_action" &&
          request.operation.actionId === 901
        ) {
          providerMocks.operations.push(
            request.operation as unknown as Record<string, unknown>,
          );
          return actionResult(901, "running");
        }
        if (
          request.operation.kind === "reconcile" &&
          request.operation.actionIds.length > 0
        ) {
          providerMocks.operations.push(
            request.operation as unknown as Record<string, unknown>,
          );
          const data = {
            observedAt: providerTime(),
            resources: request.operation.resources.map((ref) => ({
              ref,
              status:
                ref.resourceKind === "server"
                  ? ("missing" as const)
                  : ("present" as const),
              ...(ref.externalId === undefined
                ? {}
                : { externalId: ref.externalId }),
            })),
            actions: [action(901, "success")],
            canonicalWrites: [],
          };
          return {
            data,
            canonicalWrites: [],
            mustPersistBeforeNextOperation: false,
          };
        }
        return defaultProviderOperation(request);
      },
    );

    await expect(
      archiveHetznerWorkshopRuntime({
        executionId: execution.executionId,
        expectedGeneration: 1,
        now: fixture.now + 10_000,
      }),
    ).resolves.toBe(false);

    const db = drizzle(env.DB);
    const [pending] = await db.select().from(hetznerAllocations);
    expect(pending).toMatchObject({
      state: "deleting",
      serverId: "401",
      primaryIpId: "301",
      sshKeyId: "201",
      deleteActionId: "901",
      deletionConfirmedAt: null,
    });
    await expect(db.select().from(activeRuntimeSlots)).resolves.toHaveLength(1);

    await expect(
      reconcileHetznerWorkshopRuntime({
        allocationId: pending!.id,
        now: fixture.now + 70_000,
      }),
    ).resolves.toBe("deleted");

    const [deleted] = await db.select().from(hetznerAllocations);
    expect(deleted).toMatchObject({
      state: "deleted",
      deletionConfirmedAt: fixture.now + 70_000,
    });
    expect(
      providerMocks.operations
        .filter((operation) => operation.kind === "delete_resource")
        .map((operation) => operation.resourceKind),
    ).toEqual(["server", "server", "primary_ip", "ssh_key"]);
    await expect(db.select().from(activeRuntimeSlots)).resolves.toEqual([]);
    await expect(
      db.select().from(workshopSessionCostSummaries),
    ).resolves.toEqual([
      expect.objectContaining({ finalizedAt: fixture.now + 70_000 }),
    ]);
    await expect(
      db.select().from(workshopWorkspaceGenerations),
    ).resolves.toEqual([expect.objectContaining({ state: "archived" })]);
    await expect(db.select().from(workshopWorkspaces)).resolves.toEqual([
      expect.objectContaining({ state: "ended" }),
    ]);
  });

  it("accepts one restore action and provisions the queued replacement after cleanup", async () => {
    const fixture = await seedRuntimeFixture({ maxConcurrentServers: 1 });
    const initial = await allocateHetznerWorkshopRuntime(fixture.request);
    const db = drizzle(env.DB);
    const reportedAt = fixture.now + 1_000;
    await Promise.all([
      db
        .update(hetznerAllocations)
        .set({
          state: "ready",
          lastReportAt: reportedAt,
          updatedAt: reportedAt,
        })
        .where(eq(hetznerAllocations.executionId, initial.executionId)),
      db
        .update(workshopWorkspaceGenerations)
        .set({ state: "ready", readyAt: reportedAt, updatedAt: reportedAt })
        .where(
          eq(workshopWorkspaceGenerations.id, fixture.request.generationId),
        ),
      db
        .update(workshopWorkspaces)
        .set({ state: "ready", updatedAt: reportedAt })
        .where(eq(workshopWorkspaces.id, fixture.request.workspaceId)),
      db
        .update(workshopSessionMembers)
        .set({
          provisionState: "ready",
          provisionError: null,
          updatedAt: reportedAt,
        })
        .where(eq(workshopSessionMembers.userId, "learner-a")),
    ]);
    providerMocks.operations.length = 0;

    const accepted = await performWorkshopSessionAction({
      sessionId: fixture.request.sessionId,
      actorUserId: fixture.request.participantUserId,
      action: "restore_checkpoint",
      payload: { checkpointId: "checkpoint-00", confirmed: true },
    });
    const generationsAfterAction = await db
      .select({
        id: workshopWorkspaceGenerations.id,
        ordinal: workshopWorkspaceGenerations.ordinal,
        state: workshopWorkspaceGenerations.state,
        runtimeExecutionId: workshopWorkspaceGenerations.runtimeExecutionId,
      })
      .from(workshopWorkspaceGenerations)
      .orderBy(asc(workshopWorkspaceGenerations.ordinal));
    expect(accepted).toEqual({
      kind: "provisioning",
      generationIds: [generationsAfterAction[1]?.id],
    });
    expect(generationsAfterAction).toEqual([
      expect.objectContaining({
        ordinal: 1,
        state: "archiving",
        runtimeExecutionId: initial.executionId,
      }),
      expect.objectContaining({
        ordinal: 2,
        state: "queued",
        runtimeExecutionId: null,
      }),
    ]);
    const [draining] = await db
      .select()
      .from(hetznerAllocations)
      .where(eq(hetznerAllocations.executionId, initial.executionId));
    expect(draining).toMatchObject({
      state: "draining",
      recordingDrainRequestedAt: expect.any(Number),
      deletionConfirmedAt: null,
    });
    expect(
      providerMocks.operations.filter(
        (operation) => operation.kind === "delete_resource",
      ),
    ).toEqual([]);
    await expect(db.select().from(activeRuntimeSlots)).resolves.toEqual([
      expect.objectContaining({ executionId: initial.executionId }),
    ]);

    const drainCompletedAt = (draining?.recordingDrainRequestedAt ?? 0) + 1;
    await db
      .update(hetznerAllocations)
      .set({
        recordingDrainCompletedAt: drainCompletedAt,
        updatedAt: drainCompletedAt,
      })
      .where(eq(hetznerAllocations.executionId, initial.executionId));
    let serverDeleteRequested = false;
    let slotDuringReplacementCreate: string | null = null;
    providerMocks.run.mockImplementation(
      async (request: RunOperationRequest) => {
        if (
          request.operation.kind === "delete_resource" &&
          request.operation.resourceKind === "server" &&
          !serverDeleteRequested
        ) {
          serverDeleteRequested = true;
          providerMocks.operations.push(
            request.operation as unknown as Record<string, unknown>,
          );
          return operationResult({
            ...canonicalWrite(
              request,
              "server",
              request.operation.externalId,
              "resource_deletion_requested",
            ),
            actionIds: [903],
          });
        }
        if (
          request.operation.kind === "get_action" &&
          request.operation.actionId === 903
        ) {
          providerMocks.operations.push(
            request.operation as unknown as Record<string, unknown>,
          );
          return actionResult(903, "running");
        }
        if (
          request.operation.kind === "reconcile" &&
          serverDeleteRequested
        ) {
          providerMocks.operations.push(
            request.operation as unknown as Record<string, unknown>,
          );
          const deletedServer = request.operation.resources.find(
            (resource) =>
              resource.resourceKind === "server" &&
              resource.externalId !== undefined,
          );
          const canonicalWrites = deletedServer
            ? [
                canonicalWrite(
                  request,
                  "server",
                  Number(deletedServer.externalId),
                  "resource_deleted",
                ),
              ]
            : [];
          const data = {
            observedAt: providerTime(),
            resources: request.operation.resources.map((ref) => ({
              ref,
              status:
                ref.resourceKind === "server"
                  ? ("missing" as const)
                  : ("present" as const),
              ...(ref.externalId === undefined
                ? {}
                : { externalId: ref.externalId }),
            })),
            actions: request.operation.actionIds.map((actionId) =>
              action(actionId, "success"),
            ),
            canonicalWrites,
          };
          return {
            data,
            canonicalWrites,
            mustPersistBeforeNextOperation: canonicalWrites.length > 0,
          };
        }
        if (request.operation.kind === "create_ssh_key") {
          const [slot] = await db.select().from(activeRuntimeSlots);
          slotDuringReplacementCreate = slot?.executionId ?? null;
        }
        return defaultProviderOperation(request);
      },
    );
    await expect(
      archiveHetznerWorkshopRuntime({
        executionId: initial.executionId,
        expectedGeneration: 1,
        now: drainCompletedAt + 1,
      }),
    ).resolves.toBe(false);
    await expect(db.select().from(activeRuntimeSlots)).resolves.toEqual([
      expect.objectContaining({ executionId: initial.executionId }),
    ]);
    await expect(
      db
        .select({
          state: runtimeExecutions.state,
        })
        .from(runtimeExecutions)
        .where(eq(runtimeExecutions.id, initial.executionId)),
    ).resolves.toEqual([expect.objectContaining({ state: "archiving" })]);
    await expect(
      db
        .select({
          state: workshopWorkspaceGenerations.state,
        })
        .from(workshopWorkspaceGenerations)
        .where(
          eq(workshopWorkspaceGenerations.id, fixture.request.generationId),
        ),
    ).resolves.toEqual([expect.objectContaining({ state: "archiving" })]);

    const swept = await sweepHetznerWorkshopRuntimes({
      now: drainCompletedAt + 2,
    });
    expect(swept).toMatchObject({
      inspected: 1,
      replacementsProvisioned: 1,
      replacementFailures: 0,
      terminalCleanupsCompleted: 0,
    });

    const [executions, allocations, generations, slots, restoreEvents] =
      await Promise.all([
        db
          .select({
            id: runtimeExecutions.id,
            generation: runtimeExecutions.generation,
            sourceExecutionId: runtimeExecutions.sourceExecutionId,
            state: runtimeExecutions.state,
          })
          .from(runtimeExecutions)
          .orderBy(asc(runtimeExecutions.generation)),
        db
          .select({
            executionId: hetznerAllocations.executionId,
            state: hetznerAllocations.state,
            deletionConfirmedAt: hetznerAllocations.deletionConfirmedAt,
          })
          .from(hetznerAllocations)
          .orderBy(asc(hetznerAllocations.createdAt)),
        db
          .select({
            ordinal: workshopWorkspaceGenerations.ordinal,
            state: workshopWorkspaceGenerations.state,
            runtimeExecutionId: workshopWorkspaceGenerations.runtimeExecutionId,
          })
          .from(workshopWorkspaceGenerations)
          .orderBy(asc(workshopWorkspaceGenerations.ordinal)),
        db.select().from(activeRuntimeSlots),
        db
          .select({ type: workshopEvents.type })
          .from(workshopEvents)
          .where(
            eq(workshopEvents.type, "workspace.checkpoint_restore_requested"),
          ),
      ]);
    expect(executions).toEqual([
      expect.objectContaining({
        id: initial.executionId,
        generation: 1,
        state: "archived",
      }),
      expect.objectContaining({
        generation: 2,
        sourceExecutionId: initial.executionId,
        state: "provisioning",
      }),
    ]);
    expect(allocations).toEqual([
      expect.objectContaining({
        executionId: initial.executionId,
        state: "deleted",
        deletionConfirmedAt: drainCompletedAt + 2,
      }),
      expect.objectContaining({
        executionId: executions[1]?.id,
        state: "bootstrapping",
        deletionConfirmedAt: null,
      }),
    ]);
    expect(generations).toEqual([
      expect.objectContaining({ ordinal: 1, state: "archived" }),
      expect.objectContaining({
        ordinal: 2,
        state: "provisioning",
        runtimeExecutionId: executions[1]?.id,
      }),
    ]);
    expect(slots).toEqual([
      expect.objectContaining({ executionId: executions[1]?.id }),
    ]);
    expect(slotDuringReplacementCreate).toBe(executions[1]?.id);
    expect(restoreEvents).toHaveLength(1);
    expect(
      providerMocks.operations
        .filter((operation) => operation.kind === "delete_resource")
        .map((operation) => operation.resourceKind),
    ).toEqual(["server", "primary_ip", "ssh_key"]);
  });

  it("blocks a replacement when a lowered limit is still full after retiring its source", async () => {
    const fixture = await seedRuntimeFixture({
      maxConcurrentServers: 2,
      seedOtherParticipant: true,
    });
    await allocateHetznerWorkshopRuntime(fixture.request);
    const other = await createRuntimeExecution({
      executionId: "execution-other",
      userId: "learner-b",
      organizationId: "org-a",
      hostId: null,
      providerKind: "hetzner_cloud",
      providerConnectionId: PROVIDER_CONNECTION_ID,
      domainKind: "workshop",
      domainId: "workspace-other",
      checkpointId: "checkpoint-00",
      vms: [runtimeVm("execution-other")],
      now: fixture.now + 1,
    });
    const db = drizzle(env.DB);
    await db.insert(hetznerAllocations).values({
      id: "allocation-other",
      executionId: other.executionId,
      connectionId: PROVIDER_CONNECTION_ID,
      deterministicName: "intar-execution-other",
      serverType: "cx43",
      systemImage: "debian-13",
      location: "nbg1",
      state: "ready",
      createdAt: fixture.now + 1,
      updatedAt: fixture.now + 1,
    });
    await db
      .update(organizationProviderConnections)
      .set({ maxConcurrentServers: 1, updatedAt: fixture.now + 2 })
      .where(eq(organizationProviderConnections.id, PROVIDER_CONNECTION_ID));

    await expect(
      preflightHetznerWorkshopRuntime(
        {
          ...fixture.request,
          generationId: "generation-a-replacement",
          generationOrdinal: 2,
        },
        fixture.now + 60_000,
      ),
    ).rejects.toMatchObject({ code: "hcloud_concurrency_limit_reached" });
  });

  it("accepts terminal teardown once and records completion after sweep convergence", async () => {
    const fixture = await seedRuntimeFixture();
    const execution = await allocateHetznerWorkshopRuntime(fixture.request);
    const db = drizzle(env.DB);
    const reportedAt = fixture.now + 1_000;
    await Promise.all([
      db
        .update(hetznerAllocations)
        .set({
          state: "ready",
          lastReportAt: reportedAt,
          updatedAt: reportedAt,
        })
        .where(eq(hetznerAllocations.executionId, execution.executionId)),
      db
        .update(workshopWorkspaceGenerations)
        .set({ state: "ready", readyAt: reportedAt, updatedAt: reportedAt })
        .where(
          eq(workshopWorkspaceGenerations.id, fixture.request.generationId),
        ),
      db
        .update(workshopWorkspaces)
        .set({ state: "ready", updatedAt: reportedAt })
        .where(eq(workshopWorkspaces.id, fixture.request.workspaceId)),
      db
        .update(workshopSessions)
        .set({
          state: "live",
          version: 2,
          startedAt: reportedAt,
          updatedAt: reportedAt,
        })
        .where(eq(workshopSessions.id, fixture.request.sessionId)),
    ]);
    providerMocks.operations.length = 0;

    const ended = await updateWorkshopSession({
      sessionId: fixture.request.sessionId,
      actorUserId: "owner-a",
      expectedVersion: 2,
      state: "ended",
    });
    expect(ended).toMatchObject({ state: "ended", version: 3 });
    const [pendingAllocation] = await db.select().from(hetznerAllocations);
    expect(pendingAllocation).toMatchObject({
      state: "draining",
      recordingDrainRequestedAt: expect.any(Number),
      deletionConfirmedAt: null,
    });
    await expect(db.select().from(activeRuntimeSlots)).resolves.toHaveLength(1);
    const pendingEvents = await db
      .select({ type: workshopEvents.type })
      .from(workshopEvents)
      .where(eq(workshopEvents.sessionId, fixture.request.sessionId));
    expect(
      pendingEvents.filter((event) => event.type === "session.cleanup_pending"),
    ).toHaveLength(1);
    expect(
      pendingEvents.filter(
        (event) => event.type === "session.cleanup_completed",
      ),
    ).toHaveLength(0);

    const drainCompletedAt =
      (pendingAllocation?.recordingDrainRequestedAt ?? 0) + 1;
    await db.update(hetznerAllocations).set({
      recordingDrainCompletedAt: drainCompletedAt,
      updatedAt: drainCompletedAt,
    });
    const swept = await sweepHetznerWorkshopRuntimes({
      now: drainCompletedAt + 1,
    });
    expect(swept).toMatchObject({
      inspected: 1,
      replacementsProvisioned: 0,
      replacementFailures: 0,
      terminalCleanupsCompleted: 1,
    });

    const [allocation, runtime, generation, workspace, slots, summary, events] =
      await Promise.all([
        db.select().from(hetznerAllocations),
        db.select().from(runtimeExecutions),
        db.select().from(workshopWorkspaceGenerations),
        db.select().from(workshopWorkspaces),
        db.select().from(activeRuntimeSlots),
        db.select().from(workshopSessionCostSummaries),
        db
          .select({ type: workshopEvents.type })
          .from(workshopEvents)
          .where(eq(workshopEvents.sessionId, fixture.request.sessionId)),
      ]);
    expect(allocation[0]).toMatchObject({
      state: "deleted",
      deletionConfirmedAt: drainCompletedAt + 1,
    });
    expect(runtime[0]?.state).toBe("archived");
    expect(generation[0]?.state).toBe("archived");
    expect(workspace[0]?.state).toBe("ended");
    expect(slots).toEqual([]);
    expect(summary[0]).toMatchObject({
      generationCount: 1,
      restoreCount: 0,
      finalizedAt: drainCompletedAt + 1,
    });
    expect(
      events.filter((event) => event.type === "session.cleanup_pending"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === "session.cleanup_completed"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === "session.cleanup_failed"),
    ).toHaveLength(0);
    expect(
      providerMocks.operations
        .filter((operation) => operation.kind === "delete_resource")
        .map((operation) => operation.resourceKind),
    ).toEqual(["server", "primary_ip", "ssh_key"]);

    await expect(
      updateWorkshopSession({
        sessionId: fixture.request.sessionId,
        actorUserId: "owner-a",
        expectedVersion: 3,
        state: "ended",
      }),
    ).resolves.toMatchObject({ state: "ended", version: 3 });
    const eventsAfterRetry = await db
      .select({ type: workshopEvents.type })
      .from(workshopEvents)
      .where(eq(workshopEvents.sessionId, fixture.request.sessionId));
    expect(
      eventsAfterRetry.filter(
        (event) => event.type === "session.cleanup_completed",
      ),
    ).toHaveLength(1);
  });

  it("reconciles an ambiguous create by deterministic ownership before creating the dependent server", async () => {
    const fixture = await seedRuntimeFixture();
    let primaryIpCreateAttempts = 0;
    providerMocks.run.mockImplementation(
      async (request: RunOperationRequest) => {
        if (request.operation.kind === "create_primary_ip") {
          primaryIpCreateAttempts += 1;
          throw appError(
            503,
            "hcloud_gateway_timeout",
            "provider result was ambiguous",
          );
        }
        if (
          request.operation.kind === "reconcile" &&
          request.operation.resources[0]?.resourceKind === "primary_ip"
        ) {
          const canonical = canonicalWrite(
            request,
            "primary_ip",
            333,
            "resource_observed",
            "192.0.2.33",
          );
          const data = {
            observedAt: providerTime(),
            resources: [
              {
                ref: request.operation.resources[0],
                status: "present" as const,
                externalId: 333,
                state: "unassigned",
                publicIpv4: "192.0.2.33",
              },
            ],
            actions: [],
            canonicalWrites: [canonical],
          };
          return {
            data,
            canonicalWrites: [canonical],
            mustPersistBeforeNextOperation: true,
          };
        }
        return defaultProviderOperation(request);
      },
    );

    const execution = await allocateHetznerWorkshopRuntime(fixture.request);
    const [allocation] = await drizzle(env.DB)
      .select()
      .from(hetznerAllocations);
    expect(primaryIpCreateAttempts).toBe(1);
    expect(allocation).toMatchObject({
      executionId: execution.executionId,
      primaryIpId: "333",
      primaryIpv4: "192.0.2.33",
      serverId: "401",
    });
    expect(
      providerMocks.operations.find(
        (operation) => operation.kind === "create_server",
      ),
    ).toMatchObject({ primaryIpv4Id: 333, serverType: "cx43" });
  });

  it.each([
    ["ssh_key", "2011"],
    ["primary_ip", "3011"],
    ["server", "4011"],
  ] as const)(
    "discovers and deletes a %s whose create identity was lost before D1 persistence",
    async (resourceKind, externalId) => {
      const fixture = await seedRuntimeFixture();
      const execution = await allocateHetznerWorkshopRuntime(fixture.request);
      const db = drizzle(env.DB);
      await db.delete(runtimeProviderCostLedger);
      await db
        .update(hetznerAllocations)
        .set({
          state: "pending",
          serverId: null,
          primaryIpId: null,
          primaryIpv4: null,
          sshKeyId: null,
          createActionId: null,
          provisioningHeartbeatAt: fixture.now - 3 * 60_000,
          updatedAt: fixture.now - 3 * 60_000,
        })
        .where(eq(hetznerAllocations.executionId, execution.executionId));
      providerMocks.operations.length = 0;
      providerMocks.run.mockImplementation(
        async (request: RunOperationRequest) => {
          if (request.operation.kind === "reconcile") {
            providerMocks.operations.push(
              request.operation as unknown as Record<string, unknown>,
            );
            return reconcileOwnedResources(request, {
              [resourceKind]: Number(externalId),
            });
          }
          return defaultProviderOperation(request);
        },
      );

      await expect(
        archiveHetznerWorkshopRuntime({
          executionId: execution.executionId,
          expectedGeneration: 1,
          now: fixture.now + 1_000,
        }),
      ).resolves.toBe(true);

      const [allocation, ledgers, slots] = await Promise.all([
        db.select().from(hetznerAllocations),
        db.select().from(runtimeProviderCostLedger),
        db.select().from(activeRuntimeSlots),
      ]);
      expect(allocation[0]).toMatchObject({
        state: "deleted",
        ...(resourceKind === "ssh_key" ? { sshKeyId: externalId } : {}),
        ...(resourceKind === "primary_ip"
          ? { primaryIpId: externalId, primaryIpv4: "192.0.2.211" }
          : {}),
        ...(resourceKind === "server" ? { serverId: externalId } : {}),
      });
      expect(slots).toEqual([]);
      expect(providerMocks.operations[0]).toMatchObject({
        kind: "reconcile",
        resources: expect.arrayContaining([
          expect.objectContaining({ resourceKind: "ssh_key" }),
          expect.objectContaining({ resourceKind: "primary_ip" }),
          expect.objectContaining({ resourceKind: "server" }),
        ]),
      });
      expect(
        providerMocks.operations.find(
          (operation) => operation.kind === "delete_resource",
        ),
      ).toMatchObject({ resourceKind, externalId: Number(externalId) });
      if (resourceKind === "server" || resourceKind === "primary_ip") {
        expect(ledgers).toEqual([
          expect.objectContaining({
            providerResourceId: externalId,
            resourceKind: resourceKind === "server" ? "server" : "primary_ipv4",
            deletionConfirmedAt: fixture.now + 1_000,
          }),
        ]);
      } else {
        expect(ledgers).toEqual([]);
      }
    },
  );

  it("automatically reconciles a stale creating allocation during the minute sweep", async () => {
    const fixture = await seedRuntimeFixture();
    const execution = await allocateHetznerWorkshopRuntime(fixture.request);
    const db = drizzle(env.DB);
    await db.delete(runtimeProviderCostLedger);
    await db
      .update(hetznerAllocations)
      .set({
        state: "creating",
        serverId: null,
        primaryIpId: null,
        primaryIpv4: null,
        sshKeyId: null,
        createActionId: null,
        provisioningHeartbeatAt: fixture.now - 3 * 60_000,
        updatedAt: fixture.now - 3 * 60_000,
      })
      .where(eq(hetznerAllocations.executionId, execution.executionId));
    providerMocks.operations.length = 0;
    providerMocks.run.mockImplementation(
      async (request: RunOperationRequest) => {
        if (request.operation.kind === "reconcile") {
          providerMocks.operations.push(
            request.operation as unknown as Record<string, unknown>,
          );
          return reconcileOwnedResources(request, {
            ssh_key: 2021,
            primary_ip: 3021,
            server: 4021,
          });
        }
        return defaultProviderOperation(request);
      },
    );

    await expect(
      sweepHetznerWorkshopRuntimes({ now: fixture.now, limit: 1 }),
    ).resolves.toMatchObject({
      inspected: 1,
      provisioningRecovered: 1,
      cleanupPending: 0,
    });

    await expect(db.select().from(hetznerAllocations)).resolves.toEqual([
      expect.objectContaining({
        state: "bootstrapping",
        sshKeyId: "2021",
        primaryIpId: "3021",
        primaryIpv4: "192.0.2.211",
        serverId: "4021",
      }),
    ]);
    await expect(db.select().from(runtimeProviderCostLedger)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceKind: "primary_ipv4",
          providerResourceId: "3021",
        }),
        expect.objectContaining({
          resourceKind: "server",
          providerResourceId: "4021",
        }),
      ]),
    );
    expect(
      providerMocks.operations.filter((operation) =>
        String(operation.kind).startsWith("create_"),
      ),
    ).toEqual([]);
  });

  it("moves a failed allocation with a known server into reboot recovery", async () => {
    const fixture = await seedRuntimeFixture();
    const execution = await allocateHetznerWorkshopRuntime(fixture.request);
    const db = drizzle(env.DB);
    await db
      .update(hetznerAllocations)
      .set({ state: "failed", retryCount: 0, lastErrorCode: "guest_failed" })
      .where(eq(hetznerAllocations.executionId, execution.executionId));
    providerMocks.operations.length = 0;

    await expect(
      sweepHetznerWorkshopRuntimes({ now: fixture.now + 1_000, limit: 1 }),
    ).resolves.toMatchObject({
      inspected: 1,
      recoveryRequested: 1,
      cleanupPending: 0,
    });
    await expect(db.select().from(hetznerAllocations)).resolves.toEqual([
      expect.objectContaining({
        state: "rebooting",
        retryCount: 1,
        serverId: "401",
        createActionId: "999",
      }),
    ]);
    expect(providerMocks.operations).toEqual([
      expect.objectContaining({ kind: "reboot_server", serverId: 401 }),
    ]);
    await expect(db.select().from(activeRuntimeSlots)).resolves.toHaveLength(1);
  });

  it("converges an automatic replacement after its source recording drain", async () => {
    const fixture = await seedRuntimeFixture({ maxConcurrentServers: 1 });
    const source = await allocateHetznerWorkshopRuntime(fixture.request);
    const db = drizzle(env.DB);
    await db
      .update(hetznerAllocations)
      .set({
        state: "rebooting",
        retryCount: 1,
        lastReportAt: fixture.now,
        updatedAt: fixture.now,
      })
      .where(eq(hetznerAllocations.executionId, source.executionId));
    providerMocks.operations.length = 0;

    const recoveryAt = fixture.now + 3 * 60_000 + 1;
    await expect(
      sweepHetznerWorkshopRuntimes({ now: recoveryAt, limit: 1 }),
    ).resolves.toMatchObject({
      inspected: 1,
      recoveryRequested: 1,
      cleanupPending: 0,
      replacementsProvisioned: 0,
      replacementFailures: 0,
    });
    const [draining] = await db
      .select()
      .from(hetznerAllocations)
      .where(eq(hetznerAllocations.executionId, source.executionId));
    expect(draining).toMatchObject({
      state: "draining",
      recordingDrainRequestedAt: recoveryAt,
      deletionConfirmedAt: null,
    });
    await expect(
      db.select().from(organizationProviderConnections),
    ).resolves.toEqual([expect.objectContaining({ state: "active" })]);
    await expect(
      db
        .select({
          ordinal: workshopWorkspaceGenerations.ordinal,
          state: workshopWorkspaceGenerations.state,
          runtimeExecutionId:
            workshopWorkspaceGenerations.runtimeExecutionId,
        })
        .from(workshopWorkspaceGenerations)
        .orderBy(asc(workshopWorkspaceGenerations.ordinal)),
    ).resolves.toEqual([
      expect.objectContaining({
        ordinal: 1,
        state: "archiving",
        runtimeExecutionId: source.executionId,
      }),
      expect.objectContaining({
        ordinal: 2,
        state: "queued",
        runtimeExecutionId: null,
      }),
    ]);

    await db
      .update(hetznerAllocations)
      .set({
        recordingDrainCompletedAt: recoveryAt + 1,
        updatedAt: recoveryAt + 1,
      })
      .where(eq(hetznerAllocations.executionId, source.executionId));
    await expect(
      sweepHetznerWorkshopRuntimes({ now: recoveryAt + 2, limit: 1 }),
    ).resolves.toMatchObject({
      inspected: 1,
      cleanupPending: 0,
      replacementsProvisioned: 1,
      replacementFailures: 0,
    });

    const [allocations, generations, slots] = await Promise.all([
      db
        .select({
          executionId: hetznerAllocations.executionId,
          state: hetznerAllocations.state,
          deletionConfirmedAt: hetznerAllocations.deletionConfirmedAt,
        })
        .from(hetznerAllocations)
        .orderBy(asc(hetznerAllocations.createdAt)),
      db
        .select({
          ordinal: workshopWorkspaceGenerations.ordinal,
          state: workshopWorkspaceGenerations.state,
          runtimeExecutionId:
            workshopWorkspaceGenerations.runtimeExecutionId,
        })
        .from(workshopWorkspaceGenerations)
        .orderBy(asc(workshopWorkspaceGenerations.ordinal)),
      db.select().from(activeRuntimeSlots),
    ]);
    expect(allocations).toEqual([
      expect.objectContaining({
        executionId: source.executionId,
        state: "deleted",
        deletionConfirmedAt: recoveryAt + 2,
      }),
      expect.objectContaining({
        state: "bootstrapping",
        deletionConfirmedAt: null,
      }),
    ]);
    expect(generations).toEqual([
      expect.objectContaining({ ordinal: 1, state: "archived" }),
      expect.objectContaining({
        ordinal: 2,
        state: "provisioning",
        runtimeExecutionId: allocations[1]?.executionId,
      }),
    ]);
    expect(slots).toEqual([
      expect.objectContaining({ executionId: allocations[1]?.executionId }),
    ]);
    expect(
      providerMocks.operations
        .filter((operation) => operation.kind === "delete_resource")
        .map((operation) => operation.resourceKind),
    ).toEqual(["server", "primary_ip", "ssh_key"]);
  });

  it("name-reconciles and deletes failed allocations with no recorded resource IDs", async () => {
    const fixture = await seedRuntimeFixture();
    const execution = await allocateHetznerWorkshopRuntime(fixture.request);
    const db = drizzle(env.DB);
    await db
      .update(hetznerAllocations)
      .set({
        state: "failed",
        serverId: null,
        primaryIpId: null,
        primaryIpv4: null,
        sshKeyId: null,
        createActionId: null,
        lastErrorCode: "canonical_write_lost",
      })
      .where(eq(hetznerAllocations.executionId, execution.executionId));
    providerMocks.operations.length = 0;
    providerMocks.run.mockImplementation(
      async (request: RunOperationRequest) => {
        if (request.operation.kind === "reconcile") {
          providerMocks.operations.push(
            request.operation as unknown as Record<string, unknown>,
          );
          return reconcileOwnedResources(request, {
            ssh_key: 201,
            primary_ip: 301,
            server: 401,
          });
        }
        return defaultProviderOperation(request);
      },
    );

    await expect(
      sweepHetznerWorkshopRuntimes({ now: fixture.now + 1_000, limit: 1 }),
    ).resolves.toMatchObject({
      inspected: 1,
      recoveryRequested: 0,
      cleanupPending: 0,
    });
    await expect(db.select().from(hetznerAllocations)).resolves.toEqual([
      expect.objectContaining({
        state: "deleted",
        serverId: "401",
        primaryIpId: "301",
        sshKeyId: "201",
        deletionConfirmedAt: fixture.now + 1_000,
      }),
    ]);
    expect(providerMocks.operations[0]).toMatchObject({
      kind: "reconcile",
      resources: expect.arrayContaining([
        expect.objectContaining({ resourceKind: "ssh_key" }),
        expect.objectContaining({ resourceKind: "primary_ip" }),
        expect.objectContaining({ resourceKind: "server" }),
      ]),
    });
    expect(
      providerMocks.operations
        .filter((operation) => operation.kind === "delete_resource")
        .map((operation) => operation.resourceKind),
    ).toEqual(["server", "primary_ip", "ssh_key"]);
    await expect(db.select().from(activeRuntimeSlots)).resolves.toEqual([]);
  });

  it("falls back by the session-pinned location order only after failed-location cleanup", async () => {
    const fixture = await seedRuntimeFixture();
    await drizzle(env.DB)
      .update(organizationProviderConnections)
      .set({ approvedLocationsJson: ["hel1"] })
      .where(eq(organizationProviderConnections.id, PROVIDER_CONNECTION_ID));
    let failedPreferredServer = false;
    providerMocks.run.mockImplementation(
      async (request: RunOperationRequest) => {
        if (
          request.operation.kind === "create_server" &&
          request.operation.location === "nbg1" &&
          !failedPreferredServer
        ) {
          providerMocks.operations.push(
            request.operation as unknown as Record<string, unknown>,
          );
          failedPreferredServer = true;
          throw appError(
            503,
            "hcloud_resource_unavailable",
            "location temporarily unavailable",
          );
        }
        if (
          request.operation.kind === "reconcile" &&
          request.operation.resources[0]?.resourceKind === "server"
        ) {
          return reconcileMissing(request);
        }
        return defaultProviderOperation(request);
      },
    );

    await allocateHetznerWorkshopRuntime(fixture.request);
    const db = drizzle(env.DB);
    const [allocation, ledgers] = await Promise.all([
      db.select().from(hetznerAllocations),
      db.select().from(runtimeProviderCostLedger),
    ]);
    expect(
      providerMocks.operations
        .filter((operation) => operation.kind === "create_primary_ip")
        .map((operation) => operation.location),
    ).toEqual(["nbg1", "fsn1"]);
    expect(
      providerMocks.operations
        .filter((operation) => operation.kind === "delete_resource")
        .map((operation) => operation.resourceKind),
    ).toContain("primary_ip");
    expect(allocation[0]).toMatchObject({
      location: "fsn1",
      primaryIpId: "302",
      serverId: "402",
      retryCount: 1,
    });
    expect(
      ledgers.find((row) => row.providerResourceId === "301")
        ?.deletionConfirmedAt,
    ).not.toBeNull();
    expect(
      ledgers.find((row) => row.providerResourceId === "302")
        ?.deletionConfirmedAt,
    ).toBeNull();
  });

  it("blocks disabled, over-ceiling, and over-concurrency provisioning before allocation", async () => {
    const disabled = await seedRuntimeFixture();
    providerMocks.requireFeature.mockRejectedValueOnce(
      appError(
        404,
        "workshop_hcloud_runtime_not_found",
        "Hetzner workshop runtime is not enabled",
      ),
    );
    await expect(
      preflightHetznerWorkshopRuntime(disabled.request, disabled.now),
    ).rejects.toMatchObject({ code: "workshop_hcloud_runtime_not_found" });

    await resetD1Database();
    await seedWorkspaceAgentObjects();
    const ceiling = await seedRuntimeFixture({ exceedsGrossCeiling: true });
    await expect(
      preflightHetznerWorkshopRuntime(ceiling.request, ceiling.now),
    ).rejects.toMatchObject({ code: "workshop_cost_ceiling_exceeded" });

    await resetD1Database();
    await seedWorkspaceAgentObjects();
    const loweredCeiling = await seedRuntimeFixture();
    await drizzle(env.DB)
      .update(organizationProviderConnections)
      .set({ maxSessionGrossMicros: 3_899_999 })
      .where(eq(organizationProviderConnections.id, PROVIDER_CONNECTION_ID));
    const loweredProjection = await getWorkshopCostProjection({
      sessionId: loweredCeiling.request.sessionId,
      now: loweredCeiling.now,
    });
    expect(loweredProjection.live).toMatchObject({
      grossCeilingUsageMicros: 3_900_000,
      overGrossCeiling: true,
    });
    await expect(
      preflightHetznerWorkshopRuntime(
        loweredCeiling.request,
        loweredCeiling.now,
      ),
    ).rejects.toMatchObject({ code: "workshop_cost_ceiling_exceeded" });

    await resetD1Database();
    await seedWorkspaceAgentObjects();
    const staleForecast = await seedRuntimeFixture();
    await drizzle(env.DB)
      .update(workshopSessions)
      .set({ updatedAt: staleForecast.now + 1_000 })
      .where(eq(workshopSessions.id, staleForecast.request.sessionId));
    providerMocks.refreshPreflight.mockRejectedValueOnce(
      appError(
        503,
        "workshop_cost_forecast_write_failed",
        "forecast write failed",
      ),
    );
    await expect(
      preflightHetznerWorkshopRuntime(
        staleForecast.request,
        staleForecast.now + 2_000,
      ),
    ).rejects.toMatchObject({ code: "workshop_cost_forecast_write_failed" });
    expect(providerMocks.refreshPreflight).toHaveBeenCalledWith({
      sessionId: staleForecast.request.sessionId,
      trigger: "lobby_refresh",
    });

    await resetD1Database();
    await seedWorkspaceAgentObjects();
    const concurrency = await seedRuntimeFixture({
      maxConcurrentServers: 1,
      seedOtherParticipant: true,
    });
    const other = await createRuntimeExecution({
      executionId: "execution-other",
      userId: "learner-b",
      organizationId: "org-a",
      hostId: null,
      providerKind: "hetzner_cloud",
      providerConnectionId: PROVIDER_CONNECTION_ID,
      domainKind: "workshop",
      domainId: "workspace-other",
      checkpointId: "checkpoint-00",
      vms: [runtimeVm("execution-other")],
      now: concurrency.now - 1_000,
    });
    await drizzle(env.DB)
      .insert(hetznerAllocations)
      .values({
        id: "allocation-other",
        executionId: other.executionId,
        connectionId: PROVIDER_CONNECTION_ID,
        deterministicName: "intar-execution-other",
        serverType: "cx43",
        systemImage: "debian-13",
        location: "nbg1",
        state: "ready",
        createdAt: concurrency.now - 1_000,
        updatedAt: concurrency.now - 1_000,
      });
    await expect(
      preflightHetznerWorkshopRuntime(concurrency.request, concurrency.now),
    ).rejects.toMatchObject({ code: "hcloud_concurrency_limit_reached" });
    expect(providerMocks.run).not.toHaveBeenCalled();
  });
});

async function defaultProviderOperation(
  request: RunOperationRequest,
): Promise<HcloudOperationResult> {
  const operation = request.operation;
  providerMocks.operations.push(
    operation as unknown as Record<string, unknown>,
  );
  if (operation.kind === "create_ssh_key") {
    return operationResult(
      canonicalWrite(request, "ssh_key", 201, "resource_created"),
    );
  }
  if (operation.kind === "create_primary_ip") {
    const row = await currentAllocation();
    providerMocks.dependencySnapshots.push({
      operation: operation.kind,
      sshKeyId: row?.ssh_key_id,
    });
    const id = operation.location === "nbg1" ? 301 : 302;
    const ip = operation.location === "nbg1" ? "192.0.2.31" : "192.0.2.32";
    return operationResult(
      canonicalWrite(request, "primary_ip", id, "resource_created", ip),
    );
  }
  if (operation.kind === "create_server") {
    const row = await currentAllocation();
    providerMocks.dependencySnapshots.push({
      operation: operation.kind,
      sshKeyId: row?.ssh_key_id,
      primaryIpId: row?.primary_ip_id,
      primaryIpv4: row?.primary_ipv4,
    });
    const id = operation.location === "nbg1" ? 401 : 402;
    return operationResult(
      canonicalWrite(request, "server", id, "resource_created"),
    );
  }
  if (operation.kind === "delete_resource") {
    return operationResult(
      canonicalWrite(
        request,
        operation.resourceKind,
        operation.externalId,
        "resource_deleted",
      ),
    );
  }
  if (operation.kind === "reconcile") {
    const present = Object.fromEntries(
      operation.resources.flatMap((resource) =>
        resource.externalId === undefined ||
        (operation.actionIds.length > 0 && resource.resourceKind === "server")
          ? []
          : [[resource.resourceKind, resource.externalId]],
      ),
    ) as Partial<
      Record<"firewall" | "ssh_key" | "primary_ip" | "server", number>
    >;
    const result = reconcileOwnedResources(request, present);
    if (operation.actionIds.length > 0) {
      const reconciled = result.data as {
        actions: ReturnType<typeof action>[];
      };
      reconciled.actions = operation.actionIds.map((actionId) =>
        action(actionId, "success"),
      );
    }
    return result;
  }
  if (operation.kind === "get_action" || operation.kind === "reboot_server") {
    return {
      data: {
        id: operation.kind === "get_action" ? operation.actionId : 999,
        status: "success",
        command: operation.kind,
        progress: 100,
        started: providerTime(),
        finished: providerTime(),
        error: null,
        resources: [],
      },
      canonicalWrites: [],
      mustPersistBeforeNextOperation: false,
    };
  }
  throw new Error(`unexpected provider operation ${operation.kind}`);
}

function reconcileOwnedResources(
  request: RunOperationRequest,
  present: Partial<
    Record<"firewall" | "ssh_key" | "primary_ip" | "server", number>
  >,
): HcloudOperationResult {
  if (request.operation.kind !== "reconcile") {
    throw new Error("reconcile operation required");
  }
  const resourceCreatedAt = new Date(Date.now() - 60_000).toISOString();
  const resources = request.operation.resources.map((ref) => {
    const externalId = present[ref.resourceKind];
    return externalId === undefined
      ? { ref, status: "missing" as const }
      : {
          ref,
          status: "present" as const,
          externalId,
          state: ref.resourceKind === "server" ? "running" : "ready",
          ...(ref.resourceKind === "primary_ip"
            ? { publicIpv4: "192.0.2.211" }
            : {}),
          resourceCreatedAt,
        };
  });
  const canonicalWrites = resources.flatMap((resource) => {
    if (resource.status !== "present" || resource.externalId === undefined) {
      return [];
    }
    return [
      {
        ...canonicalWrite(
          request,
          resource.ref.resourceKind,
          resource.externalId,
          "resource_observed",
          "publicIpv4" in resource ? resource.publicIpv4 : undefined,
        ),
        resourceCreatedAt,
      },
    ];
  });
  const data = {
    observedAt: providerTime(),
    resources,
    actions: [],
    canonicalWrites,
  };
  return {
    data,
    canonicalWrites,
    mustPersistBeforeNextOperation: true,
  };
}

function operationResult(write: CanonicalProviderWrite): HcloudOperationResult {
  return {
    data: {},
    canonicalWrites: [write],
    mustPersistBeforeNextOperation: true,
  };
}

function actionResult(
  id: number,
  status: "running" | "success" | "error",
): HcloudOperationResult {
  return {
    data: action(id, status),
    canonicalWrites: [],
    mustPersistBeforeNextOperation: false,
  };
}

function action(id: number, status: "running" | "success" | "error") {
  return {
    id,
    status,
    command: "delete_server",
    progress: status === "running" ? 50 : 100,
    started: providerTime(),
    finished: status === "running" ? null : providerTime(),
    error:
      status === "error"
        ? { code: "action_failed", message: "action failed" }
        : null,
    resources: [],
  };
}

function canonicalWrite(
  request: RunOperationRequest,
  resourceKind: CanonicalProviderWrite["resourceKind"],
  externalId: number,
  operation: CanonicalProviderWrite["operation"],
  publicIpv4?: string,
): CanonicalProviderWrite {
  return {
    requestId: request.requestId,
    connectionId: request.connectionId,
    observedAt: providerTime(),
    operation,
    resourceKind,
    externalId,
    actionIds: [],
    ...(publicIpv4 ? { publicIpv4 } : {}),
  };
}

function reconcileMissing(request: RunOperationRequest): HcloudOperationResult {
  if (request.operation.kind !== "reconcile") {
    throw new Error("reconcile operation required");
  }
  const data = {
    observedAt: providerTime(),
    resources: request.operation.resources.map((ref) => ({
      ref,
      status: "missing" as const,
    })),
    actions: [],
    canonicalWrites: [],
  };
  return {
    data,
    canonicalWrites: [],
    mustPersistBeforeNextOperation: false,
  };
}

function providerTime(): string {
  return new Date().toISOString();
}

async function currentAllocation() {
  return env.DB.prepare(
    "SELECT ssh_key_id, primary_ip_id, primary_ipv4 FROM hetzner_allocations LIMIT 1",
  ).first<{
    ssh_key_id: string | null;
    primary_ip_id: string | null;
    primary_ipv4: string | null;
  }>();
}

async function seedWorkspaceAgentObjects() {
  const binary = new TextEncoder().encode("workspace-agent-test-binary");
  const kinoBinary = new TextEncoder().encode("kino-test-binary");
  await Promise.all([
    env.VM_IMAGE_REGISTRY_BUCKET.put(
      `workspace-agent/releases/${BINARY_SHA256}/intar-workspace-agent`,
      binary,
    ),
    env.VM_IMAGE_REGISTRY_BUCKET.put(
      `workspace-agent/kino/releases/${KINO_BINARY_SHA256}/kino`,
      kinoBinary,
    ),
    env.VM_IMAGE_REGISTRY_BUCKET.put(
      "workspace-agent/releases/current.json",
      JSON.stringify({
        schema_version: 2,
        sha256: BINARY_SHA256,
        size_bytes: binary.byteLength,
        kino_sha256: KINO_BINARY_SHA256,
        kino_size_bytes: kinoBinary.byteLength,
      }),
    ),
  ]);
}

async function seedRuntimeFixture(
  options: {
    exceedsGrossCeiling?: boolean;
    maxConcurrentServers?: number;
    seedOtherParticipant?: boolean;
    workspaceRole?: "participant" | "facilitator";
  } = {},
): Promise<{ now: number; request: WorkshopProvisioningRequest }> {
  const now = Date.now();
  const db = drizzle(env.DB);
  const manifest = workshopManifest();
  await db
    .insert(user)
    .values([
      userRow("owner-a"),
      userRow("learner-a"),
      ...(options.seedOtherParticipant ? [userRow("learner-b")] : []),
    ]);
  await db.insert(organization).values({
    id: "org-a",
    name: "Organization A",
    slug: "org-a",
    createdAt: new Date(now),
  });
  await db.insert(member).values([
    {
      id: "member-owner-a",
      organizationId: "org-a",
      userId: "owner-a",
      role: "owner",
      createdAt: new Date(now),
    },
    {
      id: "member-learner-a",
      organizationId: "org-a",
      userId: "learner-a",
      role: "member",
      createdAt: new Date(now),
    },
    ...(options.seedOtherParticipant
      ? [
          {
            id: "member-learner-b",
            organizationId: "org-a",
            userId: "learner-b",
            role: "member" as const,
            createdAt: new Date(now),
          },
        ]
      : []),
  ]);
  await db.insert(workshopTemplates).values({
    id: "template-a",
    organizationId: "org-a",
    slug: manifest.workshop.slug,
    title: manifest.workshop.title,
    summary: manifest.workshop.summary,
    createdBy: "owner-a",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workshopTemplateRevisions).values({
    id: "revision-a",
    templateId: "template-a",
    revision: 1,
    sourceRevision: "source-a",
    contentHash: "a".repeat(64),
    manifestJson: manifest,
    publishedBy: "owner-a",
    publishedAt: now,
  });
  await db
    .update(workshopTemplates)
    .set({ currentRevisionId: "revision-a" })
    .where(eq(workshopTemplates.id, "template-a"));
  await db.insert(workshopSessions).values({
    id: "session-a",
    organizationId: "org-a",
    templateRevisionId: "revision-a",
    title: "Hetzner pilot",
    state: "lobby",
    scheduledStartAt: now + 30 * 60_000,
    lobbyOpensAt: now,
    createdBy: "owner-a",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workshopSessionMembers).values([
    {
      id: "roster-learner-a",
      sessionId: "session-a",
      userId: "learner-a",
      role: options.workspaceRole ?? "participant",
      workspaceEnabled: true,
      checkedInAt: now,
      provisionState: "queued",
      assignedBy: "owner-a",
      createdAt: now,
      updatedAt: now,
    },
    ...(options.seedOtherParticipant
      ? [
          {
            id: "roster-learner-b",
            sessionId: "session-a",
            userId: "learner-b",
            role: "participant" as const,
            checkedInAt: now,
            provisionState: "ready" as const,
            assignedBy: "owner-a",
            createdAt: now,
            updatedAt: now,
          },
        ]
      : []),
  ]);
  await db.insert(organizationProviderConnections).values({
    id: PROVIDER_CONNECTION_ID,
    organizationId: "org-a",
    providerKind: "hetzner_cloud",
    displayName: "Pilot project",
    state: "active",
    projectFingerprint: "project-fingerprint",
    sentinelFirewallId: "42",
    approvedLocationsJson: ["nbg1", "fsn1", "hel1"],
    maxConcurrentServers: options.maxConcurrentServers ?? 5,
    maxSessionGrossMicros: options.exceedsGrossCeiling ? 3_899_999 : null,
    currency: "NOK",
    ipv4Enabled: true,
    lastValidatedAt: now,
    createdBy: "owner-a",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(providerCredentialVersions).values({
    id: PROVIDER_CREDENTIAL_ID,
    connectionId: PROVIDER_CONNECTION_ID,
    version: 1,
    algorithm: "AES-256-GCM",
    kekVersion: "v1",
    aadSha256: "b".repeat(64),
    encryptedTokenB64: "encrypted-token",
    tokenIvB64: "token-iv",
    wrappedDekB64: "wrapped-dek",
    dekIvB64: "dek-iv",
    envelopeCreatedAt: now,
    tokenFingerprint: "token-fingerprint",
    createdBy: "owner-a",
    activatedAt: now,
    createdAt: now,
  });
  await db
    .update(organizationProviderConnections)
    .set({ activeCredentialVersionId: PROVIDER_CREDENTIAL_ID })
    .where(eq(organizationProviderConnections.id, PROVIDER_CONNECTION_ID));
  await db.insert(workshopSessionRuntimeProviders).values({
    sessionId: "session-a",
    providerKind: "hetzner_cloud",
    connectionId: PROVIDER_CONNECTION_ID,
    serverType: "cx43",
    hardwareJson: manifest.workspace.provider?.hardware,
    permittedLocationsJson: ["nbg1", "fsn1"],
    initialPriceObservationJson: priceObservation(now),
    createdAt: now,
    updatedAt: now,
  });
  const participantCount = options.seedOtherParticipant ? 2 : 1;
  const expectedScenario = costScenario("nbg1", [6], participantCount);
  const leaseCeilingScenario = costScenario("fsn1", [6], participantCount);
  const oneRestoreScenario = costScenario("fsn1", [6, 1], participantCount);
  await db.insert(workshopSessionCostForecasts).values({
    id: "forecast-a",
    sessionId: "session-a",
    version: 1,
    connectionId: PROVIDER_CONNECTION_ID,
    currency: "NOK",
    participantCount,
    preferredLocation: "nbg1",
    trigger: "session_created",
    priceObservationJson: priceObservation(now),
    expectedJson: expectedScenario,
    leaseCeilingJson: leaseCeilingScenario,
    oneRestoreJson: oneRestoreScenario,
    expectedNetMicros: expectedScenario.totalNetMicros,
    expectedGrossMicros: expectedScenario.totalGrossMicros,
    leaseCeilingNetMicros: leaseCeilingScenario.totalNetMicros,
    leaseCeilingGrossMicros: leaseCeilingScenario.totalGrossMicros,
    oneRestoreNetMicros: oneRestoreScenario.totalNetMicros,
    oneRestoreGrossMicros: oneRestoreScenario.totalGrossMicros,
    exceedsGrossCeiling: options.exceedsGrossCeiling ?? false,
    assumptionsJson: ["one direct server per participant"],
    exclusionsJson: ["traffic overages"],
    expiresAt: now + 24 * 60 * 60_000,
    createdBy: "owner-a",
    createdAt: now,
  });
  const checkpoint = new TextEncoder().encode("checkpoint bundle");
  await env.VM_IMAGE_REGISTRY_BUCKET.put(
    "checkpoints/revision-a/00.tar.zst",
    checkpoint,
  );
  await db.insert(runtimeProviderCheckpointArtifacts).values({
    id: "checkpoint-artifact-a",
    templateRevisionId: "revision-a",
    checkpointId: "checkpoint-00",
    providerKind: "hetzner_cloud",
    r2Key: "checkpoints/revision-a/00.tar.zst",
    sha256: "c".repeat(64),
    sizeBytes: checkpoint.byteLength,
    compression: "zstd",
    signatureB64: "signed-checkpoint",
    signingKeyId: "workshop-builder-v1",
    workspaceAgentSha256: BINARY_SHA256,
    kinoSha256: KINO_BINARY_SHA256,
    status: "verified",
    coldBootVerifiedAt: now,
    createdAt: now,
  });
  await db.insert(workshopWorkspaces).values({
    id: "workspace-a",
    sessionId: "session-a",
    userId: "learner-a",
    state: "queued",
    lastCheckpointId: "checkpoint-00",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workshopWorkspaceGenerations).values({
    id: "generation-a",
    workspaceId: "workspace-a",
    ordinal: 1,
    checkpointId: "checkpoint-00",
    state: "queued",
    requestedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db
    .update(workshopWorkspaces)
    .set({ currentGenerationId: "generation-a" })
    .where(eq(workshopWorkspaces.id, "workspace-a"));
  if (options.seedOtherParticipant) {
    await db.insert(workshopWorkspaces).values({
      id: "workspace-other",
      sessionId: "session-a",
      userId: "learner-b",
      state: "ready",
      lastCheckpointId: "checkpoint-00",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(workshopWorkspaceGenerations).values({
      id: "generation-other",
      workspaceId: "workspace-other",
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
      .set({ currentGenerationId: "generation-other" })
      .where(eq(workshopWorkspaces.id, "workspace-other"));
  }
  return {
    now,
    request: {
      organizationId: "org-a",
      sessionId: "session-a",
      templateRevisionId: "revision-a",
      participantUserId: "learner-a",
      workspaceId: "workspace-a",
      generationId: "generation-a",
      generationOrdinal: 1,
      checkpointId: "checkpoint-00",
      manifest,
    },
  };
}

function workshopManifest(): WorkshopManifestV1 {
  return {
    schemaVersion: 1,
    workshop: {
      slug: "platform-engineering",
      title: "Platform Engineering Workshop",
      summary: "Build the platform.",
      prerequisites: ["A browser"],
      defaultLobbyMinutes: 30,
    },
    workspace: {
      leaseGraceMinutes: 60,
      vms: [
        {
          id: "learner",
          name: "learner",
          cpuMillis: 4_000,
          memoryMib: 16_384,
          diskMib: 65_536,
        },
      ],
      checkpoints: [
        {
          id: "checkpoint-00",
          label: "Setup",
          vmImages: [
            {
              vmId: "learner",
              imageKey: {
                scenario: "workshop-checkpoint-00",
                vm: "learner",
                arch: "x86_64",
              },
              imageSha256: "e".repeat(64),
            },
          ],
        },
      ],
      initialCheckpointId: "checkpoint-00",
      applications: [],
      provider: {
        kind: "hetzner_cloud",
        vmId: "learner",
        serverType: "cx43",
        systemImage: "debian-13",
        hardware: {
          architecture: "x86",
          cores: 8,
          memoryMib: 16_384,
          diskMib: 163_840,
        },
        compatible: true,
      },
    },
    modules: [
      {
        id: "00",
        title: "Setup",
        tier: "gate",
        outcome: "Prove the workspace is ready.",
        dependsOn: [],
        participantMarkdown: "Setup",
        facilitatorNotesMarkdown: "Notes",
        hints: [{ id: "hint-00", bodyMarkdown: "Inspect the host." }],
        solutionMarkdown: "Solution",
        probeIds: ["module-00-workspace-ready"],
        catchUpCheckpointId: "checkpoint-00",
      },
    ],
    agenda: [],
    presentation: { slides: [] },
    durationMinutes: 240,
  };
}

function priceObservation(now: number): ProviderPriceObservation {
  return {
    currency: "NOK",
    observedAt: now,
    expiresAt: now + 24 * 60 * 60_000,
    serverType: "cx43",
    locations: [
      priceLocation("nbg1", "0.5000", "0.6250"),
      priceLocation("fsn1", "0.5100", "0.6375"),
      priceLocation("hel1", "0.5200", "0.6500"),
    ],
  };
}

function priceLocation(
  location: string,
  serverHourlyNet: string,
  serverHourlyGross: string,
) {
  return {
    location,
    available: true,
    serverHourlyNet,
    serverHourlyGross,
    serverMonthlyNet: "250.0000",
    serverMonthlyGross: "312.5000",
    ipv4HourlyNet: "0.0100",
    ipv4HourlyGross: "0.0125",
    ipv4MonthlyNet: "5.0000",
    ipv4MonthlyGross: "6.2500",
  };
}

function costScenario(
  location: string,
  generationBillableHours = [6],
  participantCount = 1,
) {
  const billableHours = generationBillableHours.reduce(
    (sum, hours) => sum + hours,
    0,
  );
  const serverNetHourlyMicros = location === "fsn1" ? 510_000 : 500_000;
  const serverGrossHourlyMicros = location === "fsn1" ? 637_500 : 625_000;
  const ipv4NetHourlyMicros = 10_000;
  const ipv4GrossHourlyMicros = 12_500;
  const serverNetMicrosPerLearner = billableHours * serverNetHourlyMicros;
  const serverGrossMicrosPerLearner = billableHours * serverGrossHourlyMicros;
  const ipv4NetMicrosPerLearner = billableHours * ipv4NetHourlyMicros;
  const ipv4GrossMicrosPerLearner = billableHours * ipv4GrossHourlyMicros;
  return {
    lifetimeSeconds: 6 * 60 * 60,
    billableHours,
    generationBillableHours,
    location,
    participantCount,
    serverNetMicrosPerLearner,
    serverGrossMicrosPerLearner,
    ipv4NetMicrosPerLearner,
    ipv4GrossMicrosPerLearner,
    totalNetMicros:
      participantCount * (serverNetMicrosPerLearner + ipv4NetMicrosPerLearner),
    totalGrossMicros:
      participantCount *
      (serverGrossMicrosPerLearner + ipv4GrossMicrosPerLearner),
  };
}

function runtimeVm(executionId: string) {
  return {
    vmId: "learner",
    ordinal: 0,
    runtimeVmName: `workshop-${executionId}-learner`,
    imageKey: {
      scenario: "workshop-checkpoint-00",
      vm: "learner",
      arch: "x86_64",
    },
    imageSha256: "e".repeat(64),
    cpuMillis: 4_000,
    memoryMib: 16_384,
    diskMib: 65_536,
  };
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
