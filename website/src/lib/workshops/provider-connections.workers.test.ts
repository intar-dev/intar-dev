/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";

const providerMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  rotate: vi.fn(),
  run: vi.fn(),
  requireFeature: vi.fn(),
}));

vi.mock("@/lib/hcloud-provider-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hcloud-provider-service")>()),
  hcloudConnectProject: providerMocks.connect,
  hcloudRotateCredential: providerMocks.rotate,
  hcloudRunOperation: providerMocks.run,
}));

vi.mock("./feature-flag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./feature-flag")>()),
  requireWorkshopHcloudRuntimeEnabledForOrganization:
    providerMocks.requireFeature,
}));

import {
  hetznerAllocations,
  member,
  organization,
  organizationProviderConnections,
  providerAuditEvents,
  providerCredentialVersions,
  runtimeExecutions,
  user,
  workshopSessionCostForecasts,
  workshopSessionMembers,
  workshopSessionRuntimeProviders,
  workshopSessions,
  workshopTemplateRevisions,
  workshopTemplates,
  workshopWorkspaceGenerations,
  workshopWorkspaces,
  type WorkshopManifestV1,
} from "@/db/schema";
import { resetD1Database } from "@/test/d1-migrations";
import { errorChainMatches } from "@/lib/app-error";
import {
  acknowledgeHetznerManualCleanup,
  connectHetznerProject,
  countLiveHetznerAllocations,
  disconnectHetznerProject,
  inspectHetznerProjectInventory,
  listHetznerProviderConnections,
  overrideWorkshopSessionGrossCeiling,
  ownershipLabels,
  rebindHetznerProject,
  rotateHetznerCredential,
  updateHetznerProviderGuardrails,
  workshopPublicationVerifierOwnershipLabels,
} from "./provider-connections";

describe("Hetzner BYOK provider connections", () => {
  beforeEach(async () => {
    await resetD1Database();
    providerMocks.connect.mockReset();
    providerMocks.rotate.mockReset();
    providerMocks.run.mockReset();
    providerMocks.requireFeature.mockReset();
    providerMocks.requireFeature.mockResolvedValue(undefined);
    await seedIdentity();
    providerMocks.connect.mockResolvedValue(providerConnectionResult());
  });

  it("creates purpose-specific hashed ownership for publication verifiers", async () => {
    const ownership = await workshopPublicationVerifierOwnershipLabels(
      "org-a",
      "connection-a",
      "publication-a",
      "checkpoint-00",
      2,
    );

    expect(ownership).toMatchObject({
      purpose: "workshop_publication_verifier",
      attempt: 2,
    });
    expect(ownership.organizationRef).toMatch(/^[a-f0-9]{32}$/);
    expect(ownership.connectionRef).toMatch(/^[a-f0-9]{32}$/);
    if (ownership.purpose !== "workshop_publication_verifier") {
      throw new Error("expected publication-verifier ownership");
    }
    expect(ownership.workshopPublicationRef).toMatch(/^[a-f0-9]{32}$/);
    expect(ownership.checkpointRef).toMatch(/^[a-f0-9]{32}$/);
    expect(JSON.stringify(ownership)).not.toContain("publication-a");
    expect(JSON.stringify(ownership)).not.toContain("checkpoint-00");
  });

  it("allows only owners to connect and returns masked provider health", async () => {
    await expect(
      connectHetznerProject({
        organizationId: "org-a",
        actorUserId: "admin-a",
        token: "admin-must-not-connect-token",
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "organization_owner_required",
    });
    expect(providerMocks.connect).not.toHaveBeenCalled();

    const connected = await connectHetznerProject({
      organizationId: "org-a",
      actorUserId: "owner-a",
      token: "secret-hcloud-token-value",
    });
    expect(providerMocks.connect).toHaveBeenCalledWith(
      expect.objectContaining({ requiredServerTypes: [] }),
    );
    expect(connected).toMatchObject({
      providerKind: "hetzner_cloud",
      state: "active",
      approvedLocations: ["nbg1", "fsn1", "hel1"],
      maxConcurrentServers: 5,
      currency: "NOK",
      credential: { version: 1 },
    });
    expect(JSON.stringify(connected)).not.toContain(
      "secret-hcloud-token-value",
    );
    expect(connected.credential?.fingerprint).toMatch(
      /^sha256:[a-f0-9]{12}\.\.\.$/,
    );
    expect(connected.credential?.fingerprint).not.toMatch(/^[a-f0-9]{64}$/);

    const listed = await listHetznerProviderConnections({
      organizationId: "org-a",
      actorUserId: "admin-a",
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty("cleanupResources");
    expect(listed[0]?.credential?.fingerprint).toBe(
      connected.credential?.fingerprint,
    );
    await expect(
      listHetznerProviderConnections({
        organizationId: "org-a",
        actorUserId: "member-a",
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("never stores the plaintext token in credentials or audit events", async () => {
    const token = "secret-hcloud-token-value";
    await connectHetznerProject({
      organizationId: "org-a",
      actorUserId: "owner-a",
      token,
    });
    const db = drizzle(env.DB);
    const [credentials, events] = await Promise.all([
      db.select().from(providerCredentialVersions),
      db.select().from(providerAuditEvents),
    ]);
    expect(JSON.stringify(credentials)).not.toContain(token);
    expect(JSON.stringify(events)).not.toContain(token);
    expect(credentials[0]).toMatchObject({
      algorithm: "AES-256-GCM",
      kekVersion: "v1",
      encryptedTokenB64: "encrypted-token",
      wrappedDekB64: "wrapped-dek",
    });
  });

  it("returns a sanitized owner-only proof of an empty project with exactly the sentinel", async () => {
    const connected = await connectHetznerProject({
      organizationId: "org-a",
      actorUserId: "owner-a",
      token: "secret-hcloud-token-value",
    });
    const ownership = await ownershipLabels("org-a", connected.id);
    const sentinelName = `intar-${connected.id.slice(0, 20)}-sentinel`;
    providerMocks.run.mockResolvedValue({
      data: {
        ...providerConnectionResult().inventory,
        firewalls: [
          {
            id: 42,
            name: sentinelName,
            labels: {
              intar_managed: "true",
              intar_provider: "hetzner_cloud",
              intar_org: ownership.organizationRef,
              intar_connection: ownership.connectionRef,
              provider_private_label: "must-not-cross-the-api-boundary",
            },
            rules: [
              {
                direction: "in",
                protocol: "tcp",
                port: "22",
                source_ips: ["192.0.2.10/32"],
                description: "Intar Stargate SSH forwarding",
              },
            ],
          },
        ],
      },
      canonicalWrites: [],
      mustPersistBeforeNextOperation: false,
    });

    const inspection = await inspectHetznerProjectInventory({
      organizationId: "org-a",
      connectionId: connected.id,
      actorUserId: "owner-a",
      now: 1_750_000_005_000,
    });

    expect(providerMocks.run).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: connected.id,
        credentialContext: expect.objectContaining({
          organizationId: "org-a",
          connectionId: connected.id,
        }),
        operation: { kind: "inventory" },
      }),
    );
    expect(inspection).toEqual({
      connectionId: connected.id,
      observedAt: 1_750_000_005_000,
      counts: {
        servers: 0,
        primaryIps: 0,
        floatingIps: 0,
        firewalls: 1,
        networks: 0,
        volumes: 0,
        placementGroups: 0,
        snapshots: 0,
        sshKeys: 0,
        loadBalancers: 0,
        certificates: 0,
      },
      sentinel: {
        expected: { id: "42", name: sentinelName },
        present: true,
        onlyFirewall: true,
      },
      clean: true,
    });
    const serialized = JSON.stringify(inspection);
    expect(serialized).not.toContain("192.0.2.10");
    expect(serialized).not.toContain("provider_private_label");
    expect(serialized).not.toContain("must-not-cross-the-api-boundary");
    expect(serialized).not.toContain("encrypted-token");
    expect(serialized).not.toContain("wrapped-dek");
  });

  it("counts unexpected resources without returning provider payload details", async () => {
    const connected = await connectHetznerProject({
      organizationId: "org-a",
      actorUserId: "owner-a",
      token: "secret-hcloud-token-value",
    });
    const ownership = await ownershipLabels("org-a", connected.id);
    const sentinelName = `intar-${connected.id.slice(0, 20)}-sentinel`;
    const secret = "provider-payload-secret-must-be-redacted";
    providerMocks.run.mockResolvedValue({
      data: {
        servers: [
          {
            id: 1,
            name: secret,
            public_net: { ipv4: { ip: "203.0.113.77" } },
          },
        ],
        primaryIps: [{ id: 2, ip: "203.0.113.78", name: secret }],
        floatingIps: [{ id: 3, name: secret }],
        firewalls: [
          {
            id: 42,
            name: sentinelName,
            labels: {
              intar_managed: "true",
              intar_provider: "hetzner_cloud",
              intar_org: ownership.organizationRef,
              intar_connection: ownership.connectionRef,
            },
            rules: [
              {
                direction: "in",
                protocol: "tcp",
                port: "22",
                source_ips: ["192.0.2.10/32"],
                description: "Intar Stargate SSH forwarding",
              },
            ],
          },
          { id: 4, name: secret, labels: { secret }, rules: [] },
        ],
        networks: [{ id: 5, name: secret }],
        volumes: [{ id: 6, name: secret }],
        placementGroups: [{ id: 7, name: secret }],
        snapshots: [{ id: 8, name: secret, description: secret }],
        sshKeys: [
          {
            id: 9,
            name: secret,
            fingerprint: secret,
            public_key: secret,
            labels: { secret },
          },
        ],
        loadBalancers: [{ id: 10, name: secret }],
        certificates: [{ id: 11, name: secret }],
      },
      canonicalWrites: [],
      mustPersistBeforeNextOperation: false,
    });

    const inspection = await inspectHetznerProjectInventory({
      organizationId: "org-a",
      connectionId: connected.id,
      actorUserId: "owner-a",
    });

    expect(inspection.counts).toEqual({
      servers: 1,
      primaryIps: 1,
      floatingIps: 1,
      firewalls: 2,
      networks: 1,
      volumes: 1,
      placementGroups: 1,
      snapshots: 1,
      sshKeys: 1,
      loadBalancers: 1,
      certificates: 1,
    });
    expect(inspection.sentinel).toMatchObject({
      present: true,
      onlyFirewall: false,
    });
    expect(inspection.clean).toBe(false);
    const serialized = JSON.stringify(inspection);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("203.0.113");
    expect(serialized).not.toContain("public_key");
    expect(serialized).not.toContain("fingerprint");
    expect(serialized).not.toContain("labels");
  });

  it("fails closed when the sentinel rules or a provider collection cannot be verified", async () => {
    const connected = await connectHetznerProject({
      organizationId: "org-a",
      actorUserId: "owner-a",
      token: "secret-hcloud-token-value",
    });
    const ownership = await ownershipLabels("org-a", connected.id);
    const sentinelName = `intar-${connected.id.slice(0, 20)}-sentinel`;
    const inventory = {
      ...providerConnectionResult().inventory,
      firewalls: [
        {
          id: 42,
          name: sentinelName,
          labels: {
            intar_managed: "true",
            intar_provider: "hetzner_cloud",
            intar_org: ownership.organizationRef,
            intar_connection: ownership.connectionRef,
          },
          rules: [
            {
              direction: "in",
              protocol: "tcp",
              port: "22",
              source_ips: ["0.0.0.0/0"],
              description: "Intar Stargate SSH forwarding",
            },
          ],
        },
      ],
    };
    providerMocks.run.mockResolvedValue({
      data: inventory,
      canonicalWrites: [],
      mustPersistBeforeNextOperation: false,
    });

    await expect(
      inspectHetznerProjectInventory({
        organizationId: "org-a",
        connectionId: connected.id,
        actorUserId: "owner-a",
      }),
    ).resolves.toMatchObject({
      sentinel: { present: false, onlyFirewall: false },
      clean: false,
    });

    const { certificates: _certificates, ...incompleteInventory } = inventory;
    providerMocks.run.mockResolvedValue({
      data: incompleteInventory,
      canonicalWrites: [],
      mustPersistBeforeNextOperation: false,
    });
    await expect(
      inspectHetznerProjectInventory({
        organizationId: "org-a",
        connectionId: connected.id,
        actorUserId: "owner-a",
      }),
    ).rejects.toMatchObject({
      status: 502,
      code: "hcloud_inventory_invalid",
    });
  });

  it("authorizes owners before inventory credential or provider access", async () => {
    const connected = await connectHetznerProject({
      organizationId: "org-a",
      actorUserId: "owner-a",
      token: "secret-hcloud-token-value",
    });
    providerMocks.run.mockClear();

    await expect(
      inspectHetznerProjectInventory({
        organizationId: "org-a",
        connectionId: connected.id,
        actorUserId: "admin-a",
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "organization_owner_required",
    });
    expect(providerMocks.run).not.toHaveBeenCalled();

    const db = drizzle(env.DB);
    const now = new Date();
    await db.insert(user).values({
      id: "owner-b",
      name: "owner-b",
      email: "owner-b@example.test",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(organization).values({
      id: "org-b",
      name: "Organization B",
      slug: "org-b",
      createdAt: now,
    });
    await db.insert(member).values({
      id: "membership-owner-b",
      organizationId: "org-b",
      userId: "owner-b",
      role: "owner",
      createdAt: now,
    });

    await expect(
      inspectHetznerProjectInventory({
        organizationId: "org-b",
        connectionId: connected.id,
        actorUserId: "owner-b",
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: "provider_connection_not_found",
    });
    expect(providerMocks.run).not.toHaveBeenCalled();
  });

  it("uses a stable connection identity and rejects a duplicate before another provider write", async () => {
    const first = await connectHetznerProject({
      organizationId: "org-a",
      actorUserId: "owner-a",
      token: "secret-hcloud-token-value",
    });
    expect(first.id).toMatch(/^hcloud-[a-f0-9]{32}$/);
    providerMocks.connect.mockClear();

    await expect(
      connectHetznerProject({
        organizationId: "org-a",
        actorUserId: "owner-a",
        token: "a-different-token-that-must-not-reach-the-provider",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "provider_connection_exists",
    });
    expect(providerMocks.connect).not.toHaveBeenCalled();
  });

  it("rejects a Hetzner execution bound to another organization's connection", async () => {
    const connected = await connectHetznerProject({
      organizationId: "org-a",
      actorUserId: "owner-a",
      token: "secret-hcloud-token-value",
    });
    const db = drizzle(env.DB);
    await db.insert(organization).values({
      id: "org-b",
      name: "Organization B",
      slug: "org-b",
      createdAt: new Date(),
    });

    let insertionError: unknown;
    try {
      await db.insert(runtimeExecutions).values({
        id: "cross-org-execution",
        userId: "member-a",
        organizationId: "org-b",
        providerKind: "hetzner_cloud",
        providerConnectionId: connected.id,
        domainKind: "workshop",
        domainId: "cross-org-workspace",
        generation: 1,
        state: "queued",
      });
    } catch (error) {
      insertionError = error;
    }
    expect(
      errorChainMatches(insertionError, /belongs to another organization/),
    ).toBe(true);
  });

  it("keeps guardrail changes and project rebinds owner-only and audited", async () => {
    const connected = await connectHetznerProject({
      organizationId: "org-a",
      actorUserId: "owner-a",
      token: "secret-hcloud-token-value",
    });
    await expect(
      updateHetznerProviderGuardrails({
        organizationId: "org-a",
        connectionId: connected.id,
        actorUserId: "admin-a",
        maxConcurrentServers: 9,
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "organization_owner_required",
    });

    providerMocks.run.mockResolvedValue({
      data: providerConnectionResult().catalog,
      canonicalWrites: [],
      mustPersistBeforeNextOperation: false,
    });
    const updated = await updateHetznerProviderGuardrails({
      organizationId: "org-a",
      connectionId: connected.id,
      actorUserId: "owner-a",
      approvedLocations: ["hel1", "nbg1"],
      maxConcurrentServers: 9,
      maxSessionGrossMicros: 12_500_000,
      now: 1_750_000_010_000,
    });
    expect(updated).toMatchObject({
      approvedLocations: ["hel1", "nbg1"],
      maxConcurrentServers: 9,
      maxSessionGrossMicros: 12_500_000,
    });
    expect(providerMocks.run).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({
          kind: "catalog",
          permittedLocations: ["hel1", "nbg1"],
        }),
      }),
    );

    providerMocks.run.mockImplementation(async (request) => ({
      data: {},
      canonicalWrites: [
        {
          requestId: request.requestId,
          connectionId: request.connectionId,
          observedAt: new Date(1_750_000_011_000).toISOString(),
          operation: "resource_deleted",
          resourceKind: "firewall",
          externalId: 42,
          actionIds: [],
          state: "deleted",
        },
      ],
      mustPersistBeforeNextOperation: true,
    }));
    await disconnectHetznerProject({
      organizationId: "org-a",
      connectionId: connected.id,
      actorUserId: "owner-a",
      now: 1_750_000_011_000,
    });
    await expect(
      rebindHetznerProject({
        organizationId: "org-a",
        connectionId: connected.id,
        actorUserId: "admin-a",
        token: "new-project-token-for-admin",
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "organization_owner_required",
    });
    const rebound = await rebindHetznerProject({
      organizationId: "org-a",
      connectionId: connected.id,
      actorUserId: "owner-a",
      token: "fresh-project-token-for-owner",
      now: 1_750_000_012_000,
    });
    expect(providerMocks.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({ requiredServerTypes: [] }),
    );
    expect(rebound).toMatchObject({
      id: connected.id,
      state: "active",
      credential: { version: 2 },
      approvedLocations: ["hel1", "nbg1"],
      maxConcurrentServers: 9,
      maxSessionGrossMicros: 12_500_000,
    });
    const events = await drizzle(env.DB).select().from(providerAuditEvents);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "provider.connection.guardrails_updated",
        "provider.connection.disconnected",
        "provider.connection.rebound",
      ]),
    );
  });

  it("fences disconnect until every allocation has confirmed deletion", async () => {
    const connected = await connectHetznerProject({
      organizationId: "org-a",
      actorUserId: "owner-a",
      token: "secret-hcloud-token-value",
    });
    await expect(
      acknowledgeHetznerManualCleanup({
        organizationId: "org-a",
        connectionId: connected.id,
        actorUserId: "owner-a",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "provider_cleanup_not_pending",
    });
    await seedWorkshopSession(connected.id);
    await seedAllocation(connected.id, null);
    const ownerView = await listHetznerProviderConnections({
      organizationId: "org-a",
      actorUserId: "owner-a",
    });
    expect(ownerView[0]?.cleanupResources).toEqual([
      expect.objectContaining({
        allocationId: "allocation-a",
        serverId: "9001",
        primaryIpId: "8001",
        sshKeyId: "7001",
      }),
    ]);
    await expect(
      disconnectHetznerProject({
        organizationId: "org-a",
        connectionId: connected.id,
        actorUserId: "admin-a",
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "organization_owner_required",
    });
    await expect(
      disconnectHetznerProject({
        organizationId: "org-a",
        connectionId: connected.id,
        actorUserId: "owner-a",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "provider_cleanup_not_confirmed",
    });
    expect(providerMocks.run).not.toHaveBeenCalled();

    const db = drizzle(env.DB);
    await db
      .update(hetznerAllocations)
      .set({ state: "deleted", deletionConfirmedAt: 1_750_000_020_000 })
      .where(eq(hetznerAllocations.id, "allocation-a"));
    providerMocks.run.mockImplementation(async (request) => ({
      data: { alreadyMissing: false },
      canonicalWrites: [
        {
          requestId: request.requestId,
          connectionId: request.connectionId,
          observedAt: new Date(1_750_000_021_000).toISOString(),
          operation: "resource_deleted",
          resourceKind: "firewall",
          externalId: 42,
          actionIds: [],
          state: "deleted",
        },
      ],
      mustPersistBeforeNextOperation: true,
    }));
    const disconnected = await disconnectHetznerProject({
      organizationId: "org-a",
      connectionId: connected.id,
      actorUserId: "owner-a",
      now: 1_750_000_021_000,
    });
    expect(disconnected).toMatchObject({
      state: "disconnected",
      credential: null,
    });
    const credential = await db.select().from(providerCredentialVersions);
    expect(credential[0]?.revokedAt).toBe(1_750_000_021_000);
  });

  it("keeps cleanup-pending issuance fenced after credential rotation", async () => {
    const connected = await connectHetznerProject({
      organizationId: "org-a",
      actorUserId: "owner-a",
      token: "secret-hcloud-token-value",
    });
    await drizzle(env.DB)
      .update(organizationProviderConnections)
      .set({ state: "cleanup_pending" })
      .where(eq(organizationProviderConnections.id, connected.id));
    providerMocks.rotate.mockResolvedValue(providerConnectionResult());
    providerMocks.requireFeature.mockClear();
    providerMocks.requireFeature.mockRejectedValue(
      new Error("workshop hcloud issuance is disabled"),
    );

    const rotated = await rotateHetznerCredential({
      organizationId: "org-a",
      connectionId: connected.id,
      actorUserId: "owner-a",
      token: "rotated-token-restores-cleanup-access",
      now: 1_750_000_025_000,
    });

    expect(rotated).toMatchObject({
      state: "cleanup_pending",
      credential: { version: 2, activatedAt: 1_750_000_025_000 },
    });
    const [stored] = await drizzle(env.DB)
      .select()
      .from(organizationProviderConnections);
    expect(stored).toMatchObject({
      state: "cleanup_pending",
      lastValidatedAt: 1_750_000_025_000,
    });
    expect(providerMocks.requireFeature).not.toHaveBeenCalled();
  });

  it("clears session cost overrides when the connection ceiling changes", async () => {
    const connected = await connectHetznerProject({
      organizationId: "org-a",
      actorUserId: "owner-a",
      token: "secret-hcloud-token-value",
      maxSessionGrossMicros: 10_000_000,
    });
    await seedWorkshopSession(connected.id);
    const db = drizzle(env.DB);
    await db
      .update(workshopSessionRuntimeProviders)
      .set({
        grossCeilingOverrideAt: 1_750_000_020_000,
        grossCeilingOverrideBy: "owner-a",
      })
      .where(eq(workshopSessionRuntimeProviders.sessionId, "session-a"));

    await updateHetznerProviderGuardrails({
      organizationId: "org-a",
      connectionId: connected.id,
      actorUserId: "owner-a",
      maxSessionGrossMicros: 5_000_000,
      now: 1_750_000_026_000,
    });

    const [provider] = await db.select().from(workshopSessionRuntimeProviders);
    expect(provider).toMatchObject({
      grossCeilingOverrideAt: null,
      grossCeilingOverrideBy: null,
      updatedAt: 1_750_000_026_000,
    });
  });

  it("counts draining and failed allocations until provider deletion is confirmed", async () => {
    const connected = await connectHetznerProject({
      organizationId: "org-a",
      actorUserId: "owner-a",
      token: "secret-hcloud-token-value",
    });
    await seedWorkshopSession(connected.id);
    await seedAllocation(connected.id, null);
    const db = drizzle(env.DB);
    await db
      .update(hetznerAllocations)
      .set({ state: "draining" })
      .where(eq(hetznerAllocations.id, "allocation-a"));
    await expect(countLiveHetznerAllocations(connected.id)).resolves.toBe(1);

    await db
      .update(hetznerAllocations)
      .set({ state: "failed" })
      .where(eq(hetznerAllocations.id, "allocation-a"));
    await expect(countLiveHetznerAllocations(connected.id)).resolves.toBe(1);
    await db
      .update(hetznerAllocations)
      .set({ state: "deleted", deletionConfirmedAt: 1_750_000_030_000 })
      .where(eq(hetznerAllocations.id, "allocation-a"));
    await expect(countLiveHetznerAllocations(connected.id)).resolves.toBe(0);
  });

  it("records an explicitly unverified manual-cleanup acknowledgement without deleting IDs", async () => {
    const connected = await connectHetznerProject({
      organizationId: "org-a",
      actorUserId: "owner-a",
      token: "secret-hcloud-token-value",
    });
    await seedWorkshopSession(connected.id);
    await seedAllocation(connected.id, null);
    await expect(
      acknowledgeHetznerManualCleanup({
        organizationId: "org-a",
        connectionId: connected.id,
        actorUserId: "admin-a",
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "organization_owner_required",
    });
    const acknowledgement = await acknowledgeHetznerManualCleanup({
      organizationId: "org-a",
      connectionId: connected.id,
      actorUserId: "owner-a",
      now: 1_750_000_030_000,
    });
    expect(acknowledgement).toEqual({
      acknowledgedAt: 1_750_000_030_000,
      verified: false,
      sentinelFirewallId: "42",
      resources: [
        expect.objectContaining({
          allocationId: "allocation-a",
          executionId: "execution-a",
          deterministicName: "intar-allocation-a",
          serverId: "9001",
          primaryIpId: "8001",
          primaryIpv4: "192.0.2.50",
          sshKeyId: "7001",
          createActionId: "6001",
          deleteActionId: "6002",
          deletionConfirmedAt: null,
        }),
      ],
    });
    const db = drizzle(env.DB);
    const [allocation] = await db.select().from(hetznerAllocations);
    expect(allocation).toMatchObject({
      state: "cleanup_pending",
      deletionConfirmedAt: null,
      serverId: "9001",
    });
    const [connection] = await db
      .select()
      .from(organizationProviderConnections);
    expect(connection).toMatchObject({
      state: "cleanup_pending",
      cleanupAcknowledgedAt: 1_750_000_030_000,
      cleanupAcknowledgedBy: "owner-a",
    });
    const events = await db.select().from(providerAuditEvents);
    expect(events.at(-1)).toMatchObject({
      actorUserId: "owner-a",
      type: "provider.cleanup.manually_acknowledged",
      payloadJson: expect.objectContaining({ verified: false }),
    });
  });

  it("keeps per-session gross ceiling overrides owner-only and append-only audited", async () => {
    const connected = await connectHetznerProject({
      organizationId: "org-a",
      actorUserId: "owner-a",
      token: "secret-hcloud-token-value",
      maxSessionGrossMicros: 1_000_000,
    });
    await seedWorkshopSession(connected.id);
    await expect(
      overrideWorkshopSessionGrossCeiling({
        organizationId: "org-a",
        sessionId: "session-a",
        actorUserId: "admin-a",
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "organization_owner_required",
    });
    await expect(
      overrideWorkshopSessionGrossCeiling({
        organizationId: "org-other",
        sessionId: "session-a",
        actorUserId: "owner-a",
      }),
    ).rejects.toMatchObject({ status: 404 });

    await expect(
      overrideWorkshopSessionGrossCeiling({
        organizationId: "org-a",
        sessionId: "session-a",
        actorUserId: "owner-a",
        now: 1_750_000_040_000,
      }),
    ).resolves.toEqual({
      sessionId: "session-a",
      overriddenAt: 1_750_000_040_000,
      overriddenBy: "owner-a",
    });
    const db = drizzle(env.DB);
    const [provider] = await db.select().from(workshopSessionRuntimeProviders);
    expect(provider).toMatchObject({
      grossCeilingOverrideAt: 1_750_000_040_000,
      grossCeilingOverrideBy: "owner-a",
    });
    const events = await db.select().from(providerAuditEvents);
    expect(events.at(-1)).toMatchObject({
      actorUserId: "owner-a",
      type: "provider.session.gross_ceiling_overridden",
      payloadJson: expect.objectContaining({
        sessionId: "session-a",
        forecastVersion: 1,
        forecastExceededCeiling: true,
      }),
    });
    await expect(
      db
        .update(providerAuditEvents)
        .set({ type: "provider.audit.tampered" })
        .where(
          eq(
            providerAuditEvents.type,
            "provider.session.gross_ceiling_overridden",
          ),
        ),
    ).rejects.toThrow();
    const [untampered] = await db
      .select()
      .from(providerAuditEvents)
      .where(
        eq(
          providerAuditEvents.type,
          "provider.session.gross_ceiling_overridden",
        ),
      );
    expect(untampered?.type).toBe("provider.session.gross_ceiling_overridden");
  });
});

async function seedIdentity() {
  const db = drizzle(env.DB);
  const now = new Date();
  await db.insert(user).values(
    ["owner-a", "admin-a", "member-a"].map((id) => ({
      id,
      name: id,
      email: `${id}@example.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })),
  );
  await db.insert(organization).values({
    id: "org-a",
    name: "Organization A",
    slug: "org-a",
    createdAt: now,
  });
  await db.insert(member).values([
    {
      id: "membership-owner",
      organizationId: "org-a",
      userId: "owner-a",
      role: "owner",
      createdAt: now,
    },
    {
      id: "membership-admin",
      organizationId: "org-a",
      userId: "admin-a",
      role: "admin",
      createdAt: now,
    },
    {
      id: "membership-member",
      organizationId: "org-a",
      userId: "member-a",
      role: "member",
      createdAt: now,
    },
  ]);
}

function providerConnectionResult() {
  return {
    credential: {
      algorithm: "AES-256-GCM" as const,
      kekVersion: "v1" as const,
      aadSha256: "a".repeat(64),
      wrappedDek: "wrapped-dek",
      wrappedDekIv: "wrapped-dek-iv",
      ciphertext: "encrypted-token",
      ciphertextIv: "encrypted-token-iv",
      createdAt: new Date(1_750_000_000_000).toISOString(),
    },
    inventory: {
      servers: [],
      primaryIps: [],
      floatingIps: [],
      firewalls: [],
      networks: [],
      volumes: [],
      placementGroups: [],
      snapshots: [],
      sshKeys: [],
      loadBalancers: [],
      certificates: [],
    },
    catalog: {
      observedAt: new Date(1_750_000_000_000).toISOString(),
      serverTypes: [],
      locations: [],
      systemImages: [],
      pricing: {
        currency: "NOK",
        vat_rate: "0.25",
        server_types: [],
        primary_ips: [],
      },
    },
    sentinel: {
      id: 42,
      name: "sentinel",
      labels: {},
      rules: [],
    },
    canonicalWrites: [],
  };
}

async function seedAllocation(
  connectionId: string,
  deletionConfirmedAt: number | null,
) {
  const db = drizzle(env.DB);
  await db.insert(runtimeExecutions).values({
    id: "execution-a",
    userId: "member-a",
    organizationId: "org-a",
    providerKind: "hetzner_cloud",
    providerConnectionId: connectionId,
    domainKind: "workshop",
    domainId: "workspace-a",
    generation: 1,
    state: "ready",
    createdAt: 1_750_000_000_000,
    updatedAt: 1_750_000_000_000,
  });
  await db.insert(hetznerAllocations).values({
    id: "allocation-a",
    executionId: "execution-a",
    connectionId,
    deterministicName: "intar-allocation-a",
    serverId: "9001",
    primaryIpId: "8001",
    primaryIpv4: "192.0.2.50",
    sshKeyId: "7001",
    createActionId: "6001",
    deleteActionId: "6002",
    serverType: "cx43",
    systemImage: "debian-13",
    location: "nbg1",
    state: deletionConfirmedAt === null ? "cleanup_pending" : "deleted",
    deletionConfirmedAt,
    createdAt: 1_750_000_000_000,
    updatedAt: 1_750_000_000_000,
  });
}

async function seedWorkshopSession(connectionId: string) {
  const db = drizzle(env.DB);
  const manifest: WorkshopManifestV1 = {
    schemaVersion: 1,
    workshop: {
      slug: "provider-test",
      title: "Provider test",
      summary: "Provider test",
      prerequisites: [],
      defaultLobbyMinutes: 30,
    },
    workspace: {
      leaseGraceMinutes: 60,
      provider: {
        kind: "hetzner_cloud",
        vmId: "learner",
        serverType: "cx43",
        systemImage: "debian-13",
        hardware: {
          architecture: "x86",
          cores: 8,
          memoryMib: 16_384,
          diskMib: 160 * 1_024,
        },
        compatible: true,
      },
      vms: [
        {
          id: "learner",
          name: "Learner",
          cpuMillis: 4_000,
          memoryMib: 8_192,
          diskMib: 32_768,
        },
      ],
      checkpoints: [],
      initialCheckpointId: "00",
      applications: [],
    },
    modules: [],
    agenda: [],
    presentation: { slides: [] },
    durationMinutes: 240,
  };
  await db.insert(workshopTemplates).values({
    id: "template-a",
    organizationId: "org-a",
    slug: "provider-test",
    title: "Provider test",
    summary: "Provider test",
    createdBy: "owner-a",
    createdAt: 1_750_000_000_000,
    updatedAt: 1_750_000_000_000,
  });
  await db.insert(workshopTemplateRevisions).values({
    id: "revision-a",
    templateId: "template-a",
    revision: 1,
    sourceRevision: "source-a",
    contentHash: "a".repeat(64),
    manifestJson: manifest,
    publishedBy: "owner-a",
    publishedAt: 1_750_000_000_000,
  });
  await db.insert(workshopSessions).values({
    id: "session-a",
    organizationId: "org-a",
    templateRevisionId: "revision-a",
    title: "Provider test",
    state: "lobby",
    scheduledStartAt: 1_750_100_000_000,
    lobbyOpensAt: 1_750_098_200_000,
    createdBy: "owner-a",
    createdAt: 1_750_000_000_000,
    updatedAt: 1_750_000_000_000,
  });
  await db.insert(workshopSessionRuntimeProviders).values({
    sessionId: "session-a",
    providerKind: "hetzner_cloud",
    connectionId,
    serverType: "cx43",
    hardwareJson: {
      architecture: "x86",
      cores: 8,
      memoryMib: 16_384,
      diskMib: 160 * 1_024,
    },
    permittedLocationsJson: ["nbg1"],
    createdAt: 1_750_000_000_000,
    updatedAt: 1_750_000_000_000,
  });
  await db.insert(workshopSessionMembers).values({
    id: "session-member-a",
    sessionId: "session-a",
    userId: "member-a",
    role: "participant",
    assignedBy: "owner-a",
    createdAt: 1_750_000_000_000,
    updatedAt: 1_750_000_000_000,
  });
  await db.insert(workshopWorkspaces).values({
    id: "workspace-a",
    sessionId: "session-a",
    userId: "member-a",
    state: "provisioning",
    createdAt: 1_750_000_000_000,
    updatedAt: 1_750_000_000_000,
  });
  await db.insert(workshopWorkspaceGenerations).values({
    id: "generation-a",
    workspaceId: "workspace-a",
    ordinal: 1,
    state: "provisioning",
    requestedAt: 1_750_000_000_000,
    createdAt: 1_750_000_000_000,
    updatedAt: 1_750_000_000_000,
  });
  await db
    .update(workshopWorkspaces)
    .set({ currentGenerationId: "generation-a" })
    .where(eq(workshopWorkspaces.id, "workspace-a"));
  const prices = {
    currency: "NOK",
    observedAt: 1_750_000_000_000,
    expiresAt: 1_750_086_400_000,
    serverType: "cx43",
    locations: [
      {
        location: "nbg1",
        available: true,
        serverHourlyNet: "1.0",
        serverHourlyGross: "1.25",
        ipv4HourlyNet: "0.1",
        ipv4HourlyGross: "0.125",
      },
    ],
  };
  const scenario = {
    lifetimeSeconds: 18_000,
    billableHours: 5,
    generationBillableHours: [5],
    location: "nbg1",
    participantCount: 1,
    serverNetMicrosPerLearner: 5_000_000,
    serverGrossMicrosPerLearner: 6_250_000,
    ipv4NetMicrosPerLearner: 500_000,
    ipv4GrossMicrosPerLearner: 625_000,
    totalNetMicros: 5_500_000,
    totalGrossMicros: 6_875_000,
  };
  await db.insert(workshopSessionCostForecasts).values({
    id: "forecast-a",
    sessionId: "session-a",
    version: 1,
    connectionId,
    currency: "NOK",
    participantCount: 1,
    preferredLocation: "nbg1",
    trigger: "session_created",
    priceObservationJson: prices,
    expectedJson: scenario,
    leaseCeilingJson: scenario,
    oneRestoreJson: {
      ...scenario,
      billableHours: 6,
      generationBillableHours: [5, 1],
      totalNetMicros: 6_600_000,
      totalGrossMicros: 8_250_000,
    },
    expectedNetMicros: scenario.totalNetMicros,
    expectedGrossMicros: scenario.totalGrossMicros,
    leaseCeilingNetMicros: scenario.totalNetMicros,
    leaseCeilingGrossMicros: scenario.totalGrossMicros,
    oneRestoreNetMicros: 6_600_000,
    oneRestoreGrossMicros: 8_250_000,
    exceedsGrossCeiling: true,
    assumptionsJson: [],
    exclusionsJson: [],
    expiresAt: prices.expiresAt,
    createdBy: "owner-a",
    createdAt: 1_750_000_000_000,
  });
}
