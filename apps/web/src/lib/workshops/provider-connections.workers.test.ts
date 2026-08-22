/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  requireFeature: vi.fn(),
}));

vi.mock("./provider-service", () => ({
  invokeProviderOperation: mocks.invoke,
}));
vi.mock("./feature-flag", () => ({
  requireWorkshopMulticloudRuntimeEnabledForOrganization: mocks.requireFeature,
}));

import {
  gcpConnectionDetails,
  hetznerConnectionDetails,
  member,
  organization,
  providerAuditEvents,
  providerConnections,
  providerCredentialVersions,
  user,
} from "@/db/schema";
import { resetD1Database } from "@/test/d1-migrations";
import { withRuntimeAllocationLock } from "@/lib/runtime-allocation-lock";
import { appError } from "@/lib/app-error";
import {
  abandonProviderConnectionAttempt,
  connectProviderProject,
  disconnectProviderConnection,
  inspectProviderConnection,
  listProviderConnections,
  rotateProviderCredential,
  updateProviderGuardrails,
} from "./provider-connections";

describe("generic Workshop BYOK connections", () => {
  beforeEach(async () => {
    await resetD1Database();
    vi.clearAllMocks();
    mocks.requireFeature.mockRejectedValue(
      new Error("issuance feature is disabled"),
    );
    await seedIdentity();
  });

  it("connects and inspects Hetzner with issuance disabled, masks health for admins, and persists no token", async () => {
    mocks.invoke.mockResolvedValue(hetznerConnectionResult());

    await expect(
      connectProviderProject({
        organizationId: "org-a",
        actorUserId: "admin-a",
        providerKind: "hetzner_cloud",
        credential: "must-not-reach-provider",
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "organization_owner_required",
    });
    expect(mocks.invoke).not.toHaveBeenCalled();

    const token = "sensitive-hcloud-token";
    const connected = await connectProviderProject({
      organizationId: "org-a",
      actorUserId: "owner-a",
      providerKind: "hetzner_cloud",
      credential: token,
    });
    const invocation = mocks.invoke.mock.calls[0]?.[1] as
      | ((binding: {
          connectProject(request: unknown): Promise<{
            ok: true;
            value: unknown;
          }>;
        }) => Promise<unknown>)
      | undefined;
    if (!invocation) throw new Error("Hetzner provider invocation was not captured");
    let providerRequest: unknown;
    await invocation({
      connectProject: async (request) => {
        providerRequest = request;
        return { ok: true, value: hetznerConnectionResult() };
      },
    });
    expect(providerRequest).toMatchObject({
      sentinel: {
        ownership: {
          purpose: "provider_connection_sentinel",
        },
      },
    });
    expect(providerRequest).not.toHaveProperty("sentinel.ownership.workspaceRef");
    expect(providerRequest).not.toHaveProperty("sentinel.ownership.generation");
    expect(providerRequest).not.toHaveProperty(
      "sentinel.ownership.workshopPublicationRef",
    );
    expect(providerRequest).not.toHaveProperty("sentinel.ownership.checkpointRef");
    expect(providerRequest).not.toHaveProperty("sentinel.ownership.attempt");
    expect(connected).toMatchObject({
      providerKind: "hetzner_cloud",
      state: "active",
      guardrails: {
        locations: ["nbg1", "fsn1", "hel1"],
        maxConcurrentAllocations: 5,
      },
      providerDetails: {
        providerKind: "hetzner_cloud",
        sentinelFirewallId: "42",
        nativeCurrency: "NOK",
      },
      credential: { version: 1 },
    });
    expect(connected.credential?.fingerprint).toMatch(/^[a-f0-9]{4}…[a-f0-9]{4}$/u);

    const listed = await listProviderConnections({
      organizationId: "org-a",
      actorUserId: "admin-a",
    });
    expect(listed).toEqual([connected]);
    await expect(
      inspectProviderConnection({
        organizationId: "org-a",
        connectionId: connected.id,
        actorUserId: "owner-a",
      }),
    ).resolves.toMatchObject({
      connectionId: connected.id,
      providerKind: "hetzner_cloud",
    });
    expect(mocks.requireFeature).not.toHaveBeenCalled();
    await expectNoPlaintext(token);
  });

  it("connects a GCP service account into provider-neutral and GCP detail rows", async () => {
    mocks.invoke.mockResolvedValue(gcpConnectionResult());
    const credential = JSON.stringify({
      type: "service_account",
      project_id: "intar-pilot-123",
      private_key_id: "key-a",
      private_key: "sensitive-private-key",
      client_email: "intar@intar-pilot-123.iam.gserviceaccount.com",
    });

    const connected = await connectProviderProject({
      organizationId: "org-a",
      actorUserId: "owner-a",
      providerKind: "gcp_compute",
      credential,
      approvedLocations: ["europe-west3-a", "europe-west3-b"],
      maxConcurrentAllocations: 3,
    });

    const invocation = mocks.invoke.mock.calls[0]?.[1] as
      | ((binding: {
          connectProject(request: unknown): Promise<{
            ok: true;
            value: unknown;
          }>;
        }) => Promise<unknown>)
      | undefined;
    if (!invocation) throw new Error("GCP provider invocation was not captured");
    let providerRequest: unknown;
    await invocation({
      connectProject: async (request) => {
        providerRequest = request;
        return { ok: true, value: gcpConnectionResult() };
      },
    });
    expect(providerRequest).toMatchObject({
      projectId: "intar-pilot-123",
      permittedZones: ["europe-west3-a", "europe-west3-b"],
      requiredMachineTypes: ["e2-standard-4"],
      imageFamily: "projects/debian-cloud/global/images/family/debian-13",
      foundation: {
        subnetworkRegion: "europe-west3",
        subnetworkCidr: "10.77.0.0/20",
        ownership: { purpose: "provider_connection_sentinel" },
      },
    });

    expect(connected).toMatchObject({
      providerKind: "gcp_compute",
      externalProjectId: "intar-pilot-123",
      guardrails: {
        locations: ["europe-west3-a", "europe-west3-b"],
        maxConcurrentAllocations: 3,
      },
      providerDetails: {
        providerKind: "gcp_compute",
        projectNumber: "1234567890",
        networkName: expect.stringMatching(/^intar-/u),
        nativeCurrency: "USD",
      },
    });
    const db = drizzle(env.DB);
    await expect(db.select().from(providerConnections)).resolves.toHaveLength(1);
    await expect(db.select().from(gcpConnectionDetails)).resolves.toHaveLength(1);
    await expect(db.select().from(hetznerConnectionDetails)).resolves.toHaveLength(0);
    await expectNoPlaintext("sensitive-private-key");
  });

  it("keeps a failed GCP foundation attempt listable and resumes it safely", async () => {
    const invalidResult = {
      ...gcpConnectionResult(),
      credential: { ...encryptedEnvelope("invalid"), kekVersion: "" },
    };
    mocks.invoke
      .mockResolvedValueOnce(invalidResult)
      .mockResolvedValueOnce(gcpConnectionResult());
    const credential = gcpCredential("intar-pilot-123", "foundation-key");

    await expect(
      connectProviderProject({
        organizationId: "org-a",
        actorUserId: "owner-a",
        providerKind: "gcp_compute",
        credential,
        now: 100,
      }),
    ).rejects.toBeTruthy();

    const failed = await listProviderConnections({
      organizationId: "org-a",
      actorUserId: "owner-a",
    });
    expect(failed).toEqual([
      expect.objectContaining({
        providerKind: "gcp_compute",
        state: "rotation_required",
        externalProjectId: "intar-pilot-123",
        credential: null,
        lastValidatedAt: 100,
      }),
    ]);
    if (failed[0]?.providerDetails.providerKind !== "gcp_compute") {
      throw new Error("expected the failed GCP connection");
    }
    expect(failed[0].providerDetails.projectNumber).toMatch(/^pending-/u);

    const recovered = await connectProviderProject({
      organizationId: "org-a",
      actorUserId: "owner-a",
      providerKind: "gcp_compute",
      credential,
      now: 200,
    });
    expect(recovered).toMatchObject({
      state: "active",
      externalProjectId: "intar-pilot-123",
      credential: { version: 1 },
      providerDetails: { projectNumber: "1234567890" },
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("abandons failed project A after manual cleanup and connects project B", async () => {
    mocks.invoke
      .mockResolvedValueOnce({
        ...gcpConnectionResult(),
        credential: { ...encryptedEnvelope("invalid"), kekVersion: "" },
      })
      .mockResolvedValueOnce(
        gcpConnectionResult("another-pilot-123", "9876543210"),
      );
    await expect(
      connectProviderProject({
        organizationId: "org-a",
        actorUserId: "owner-a",
        providerKind: "gcp_compute",
        credential: gcpCredential("intar-pilot-123", "project-a-key"),
        now: 100,
      }),
    ).rejects.toBeTruthy();
    const [failed] = await listProviderConnections({
      organizationId: "org-a",
      actorUserId: "owner-a",
    });
    expect(failed).toMatchObject({
      state: "rotation_required",
      credential: null,
      externalProjectId: "intar-pilot-123",
    });

    await expect(
      abandonProviderConnectionAttempt({
        organizationId: "org-a",
        connectionId: failed!.id,
        actorUserId: "admin-a",
        manualCleanupAcknowledged: true,
        now: 200,
      }),
    ).rejects.toMatchObject({ code: "organization_owner_required" });

    await expect(
      abandonProviderConnectionAttempt({
        organizationId: "org-a",
        connectionId: failed!.id,
        actorUserId: "owner-a",
        manualCleanupAcknowledged: true,
        now: 200,
      }),
    ).resolves.toMatchObject({
      abandoned: true,
      externalProjectId: "intar-pilot-123",
      manualCleanupAcknowledged: true,
    });
    await expect(
      listProviderConnections({
        organizationId: "org-a",
        actorUserId: "owner-a",
      }),
    ).resolves.toEqual([]);
    const abandonedEvents = await drizzle(env.DB)
      .select()
      .from(providerAuditEvents);
    expect(abandonedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          connectionId: null,
          type: "provider.connection_validation_abandoned",
          payloadJson: expect.objectContaining({
            externalProjectId: "intar-pilot-123",
            manualCleanupAcknowledged: true,
          }),
        }),
      ]),
    );

    const projectB = await connectProviderProject({
      organizationId: "org-a",
      actorUserId: "owner-a",
      providerKind: "gcp_compute",
      credential: gcpCredential("another-pilot-123", "project-b-key"),
      now: 300,
    });
    expect(projectB).toMatchObject({
      state: "active",
      externalProjectId: "another-pilot-123",
      providerDetails: { projectNumber: "9876543210" },
    });
    const allEvents = await drizzle(env.DB).select().from(providerAuditEvents);
    expect(allEvents.some((event) =>
      event.connectionId === null &&
      event.payloadJson.externalProjectId === "intar-pilot-123"
    )).toBe(true);
  });

  it("lists a validating GCP attempt and blocks a concurrent different project", async () => {
    let release!: (value: ReturnType<typeof gcpConnectionResult>) => void;
    const providerResult = new Promise<ReturnType<typeof gcpConnectionResult>>(
      (resolve) => {
        release = resolve;
      },
    );
    mocks.invoke.mockReturnValueOnce(providerResult);
    const first = connectProviderProject({
      organizationId: "org-a",
      actorUserId: "owner-a",
      providerKind: "gcp_compute",
      credential: gcpCredential("intar-pilot-123", "project-a-key"),
      now: 100,
    });
    await vi.waitFor(async () => {
      const listed = await listProviderConnections({
        organizationId: "org-a",
        actorUserId: "owner-a",
      });
      expect(listed[0]).toMatchObject({
        state: "validating",
        credential: null,
        externalProjectId: "intar-pilot-123",
      });
    });

    await expect(
      connectProviderProject({
        organizationId: "org-a",
        actorUserId: "owner-a",
        providerKind: "gcp_compute",
        credential: gcpCredential("another-pilot-123", "project-b-key"),
        now: 100,
      }),
    ).rejects.toMatchObject({ code: "runtime_allocation_busy" });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);

    release(gcpConnectionResult());
    await expect(first).resolves.toMatchObject({ state: "active" });
  });

  it("serializes one GCP project claim across two organizations", async () => {
    let release!: (value: ReturnType<typeof gcpConnectionResult>) => void;
    const providerResult = new Promise<ReturnType<typeof gcpConnectionResult>>(
      (resolve) => {
        release = resolve;
      },
    );
    mocks.invoke.mockReturnValueOnce(providerResult);
    const projectCredential = gcpCredential(
      "intar-pilot-123",
      "shared-project-key",
    );
    const first = connectProviderProject({
      organizationId: "org-a",
      actorUserId: "owner-a",
      providerKind: "gcp_compute",
      credential: projectCredential,
      now: 100,
    });
    await vi.waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledTimes(1);
    });

    await expect(
      connectProviderProject({
        organizationId: "org-b",
        actorUserId: "owner-b",
        providerKind: "gcp_compute",
        credential: projectCredential,
        now: 100,
      }),
    ).rejects.toMatchObject({ code: "runtime_allocation_busy" });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    await expect(
      listProviderConnections({
        organizationId: "org-b",
        actorUserId: "owner-b",
      }),
    ).resolves.toEqual([]);

    release(gcpConnectionResult());
    await expect(first).resolves.toMatchObject({
      organizationId: "org-a",
      state: "active",
    });
    await expect(
      connectProviderProject({
        organizationId: "org-b",
        actorUserId: "owner-b",
        providerKind: "gcp_compute",
        credential: projectCredential,
        now: 200,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "gcp_project_already_connected",
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);

    const db = drizzle(env.DB);
    await expect(
      db
        .select({
          organizationId: providerConnections.organizationId,
          externalProjectId: providerConnections.externalProjectId,
        })
        .from(providerConnections),
    ).resolves.toEqual([
      {
        organizationId: "org-a",
        externalProjectId: "intar-pilot-123",
      },
    ]);
    await expect(db.select().from(gcpConnectionDetails)).resolves.toHaveLength(1);
    const events = await db.select().from(providerAuditEvents);
    expect(events.every((event) => event.organizationId === "org-a")).toBe(true);
  });

  it("ignores an unproven project attempt but blocks its retry after another organization proves the claim", async () => {
    const projectCredential = gcpCredential(
      "intar-pilot-123",
      "shared-project-key",
    );
    mocks.invoke
      .mockRejectedValueOnce(
        appError(
          409,
          "gcp_service_account_key_invalid",
          "GCP rejected the service account key",
        ),
      )
      .mockResolvedValueOnce(gcpConnectionResult());

    await expect(
      connectProviderProject({
        organizationId: "org-a",
        actorUserId: "owner-a",
        providerKind: "gcp_compute",
        credential: projectCredential,
        now: 100,
      }),
    ).rejects.toMatchObject({ code: "gcp_service_account_key_invalid" });
    await expect(
      listProviderConnections({
        organizationId: "org-a",
        actorUserId: "owner-a",
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        state: "rotation_required",
        externalProjectId: "intar-pilot-123",
        credential: null,
        providerDetails: expect.objectContaining({
          projectNumber: expect.stringMatching(/^pending-/u),
        }),
      }),
    ]);

    await expect(
      connectProviderProject({
        organizationId: "org-b",
        actorUserId: "owner-b",
        providerKind: "gcp_compute",
        credential: projectCredential,
        now: 200,
      }),
    ).resolves.toMatchObject({
      organizationId: "org-b",
      state: "active",
      externalProjectId: "intar-pilot-123",
      providerDetails: { projectNumber: "1234567890" },
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(2);

    await expect(
      connectProviderProject({
        organizationId: "org-a",
        actorUserId: "owner-a",
        providerKind: "gcp_compute",
        credential: projectCredential,
        now: 300,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "gcp_project_already_connected",
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("returns the same active GCP connection without a second cloud mutation", async () => {
    mocks.invoke.mockResolvedValue(gcpConnectionResult());
    const first = await connectProviderProject({
      organizationId: "org-a",
      actorUserId: "owner-a",
      providerKind: "gcp_compute",
      credential: gcpCredential("intar-pilot-123", "first-key"),
      now: 100,
    });
    const repeated = await connectProviderProject({
      organizationId: "org-a",
      actorUserId: "owner-a",
      providerKind: "gcp_compute",
      credential: gcpCredential("intar-pilot-123", "replacement-key"),
      now: 200,
    });

    expect(repeated).toEqual(first);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    await expect(drizzle(env.DB).select().from(providerCredentialVersions))
      .resolves.toHaveLength(1);
  });

  it("rejects a GCP project ID longer than the provider limit before RPC", async () => {
    await expect(
      connectProviderProject({
        organizationId: "org-a",
        actorUserId: "owner-a",
        providerKind: "gcp_compute",
        credential: JSON.stringify({
          type: "service_account",
          project_id: `p${"a".repeat(30)}`,
          private_key: "must-not-reach-provider",
        }),
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "gcp_service_account_key_invalid",
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it.each([
    "192.0.2.0/24",
    "999.0.2.10/32",
    "192.00.2.10/32",
    "192.0.2.10/32,192.0.2.10/32",
  ])("rejects non-canonical Stargate egress range %s before GCP RPC", async (cidr) => {
    const mutableEnv = env as unknown as {
      STARGATE_EGRESS_IPV4_CIDRS: string;
    };
    const original = mutableEnv.STARGATE_EGRESS_IPV4_CIDRS;
    const connectProject = vi.fn();
    mocks.invoke.mockImplementation(async (_providerKind, invocation) =>
      invocation({ connectProject }),
    );
    mutableEnv.STARGATE_EGRESS_IPV4_CIDRS = cidr;
    try {
      await expect(
        connectProviderProject({
          organizationId: "org-a",
          actorUserId: "owner-a",
          providerKind: "gcp_compute",
          credential: JSON.stringify({
            type: "service_account",
            project_id: "intar-pilot-123",
            private_key: "must-not-reach-provider",
          }),
        }),
      ).rejects.toMatchObject({
        status: 503,
        code: "stargate_egress_not_configured",
      });
      expect(connectProject).not.toHaveBeenCalled();
    } finally {
      mutableEnv.STARGATE_EGRESS_IPV4_CIDRS = original;
    }
  });

  it("keeps D1 runtime allocation and cleanup state visible during provider inspection", async () => {
    mocks.invoke.mockResolvedValue(gcpConnectionResult());
    const connected = await connectProviderProject({
      organizationId: "org-a",
      actorUserId: "owner-a",
      providerKind: "gcp_compute",
      credential: JSON.stringify({
        type: "service_account",
        project_id: "intar-pilot-123",
        private_key: "initial-private-key",
      }),
    });
    await seedInspectionAllocations(connected.id);
    mocks.invoke.mockResolvedValue({
      data: {
        validation: { authority: "active" },
        classification: {
          status: "owned_resources_present",
          foundation: [],
          runtime: [],
          foreign: [],
        },
      },
      canonicalWrites: [],
    });

    const inspection = await inspectProviderConnection({
      organizationId: "org-a",
      connectionId: connected.id,
      actorUserId: "owner-a",
    });
    const invocation = mocks.invoke.mock.calls.at(-1)?.[1] as
      | ((binding: {
          runOperation(request: unknown): Promise<{
            ok: true;
            value: unknown;
          }>;
        }) => Promise<unknown>)
      | undefined;
    if (!invocation) throw new Error("GCP inspection invocation was not captured");
    let inspectionRequest: unknown;
    await invocation({
      runOperation: async (request) => {
        inspectionRequest = request;
        return {
          ok: true,
          value: { data: {}, canonicalWrites: [] },
        };
      },
    });
    expect(inspectionRequest).toMatchObject({
      operation: {
        kind: "inspect_connection",
        zones: [
          "europe-west3-a",
          "europe-west3-b",
          "europe-west3-c",
        ],
      },
    });

    expect(inspection.data).toMatchObject({
      classification: { status: "owned_resources_present" },
    });
    expect(inspection.runtimeAllocations).toHaveLength(2);
    expect(inspection.runtimeAllocations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "allocation-ready",
        state: "ready",
        resources: [
          expect.objectContaining({
            resourceKind: "instance",
            providerResourceId: "instance-ready",
            disappearanceConfirmedAt: null,
          }),
        ],
      }),
      expect.objectContaining({
        id: "allocation-cleanup",
        state: "cleanup_pending",
        resources: [
          expect.objectContaining({
            resourceKind: "boot_disk",
            providerResourceId: "disk-cleanup",
            disappearanceConfirmedAt: null,
          }),
        ],
      }),
    ]));
  });

  it("persists active inspection failure and restores health only after success", async () => {
    mocks.invoke.mockResolvedValue(gcpConnectionResult());
    const connected = await connectProviderProject({
      organizationId: "org-a",
      actorUserId: "owner-a",
      providerKind: "gcp_compute",
      credential: gcpCredential("intar-pilot-123", "inspection-key"),
      now: 100,
    });
    mocks.invoke.mockRejectedValueOnce(
      appError(409, "gcp_billing_disabled", "GCP billing is disabled"),
    );

    await expect(
      inspectProviderConnection({
        organizationId: "org-a",
        connectionId: connected.id,
        actorUserId: "owner-a",
      }),
    ).rejects.toMatchObject({ code: "gcp_billing_disabled" });
    const unhealthy = await listProviderConnections({
      organizationId: "org-a",
      actorUserId: "admin-a",
    });
    expect(unhealthy[0]).toMatchObject({
      state: "rotation_required",
      credential: { authority: "active" },
      lastValidatedAt: expect.any(Number),
    });
    const failureEvents = await drizzle(env.DB)
      .select()
      .from(providerAuditEvents);
    expect(failureEvents.at(-1)).toMatchObject({
      type: "provider.connection_validation_failed",
      payloadJson: { errorCode: "gcp_billing_disabled" },
    });

    mocks.invoke.mockResolvedValueOnce({
      data: { status: "ready", validation: { authority: "active" } },
      canonicalWrites: [],
    });
    await expect(
      inspectProviderConnection({
        organizationId: "org-a",
        connectionId: connected.id,
        actorUserId: "owner-a",
      }),
    ).resolves.toMatchObject({ data: { status: "ready" } });
    const healthy = await listProviderConnections({
      organizationId: "org-a",
      actorUserId: "admin-a",
    });
    expect(healthy[0]?.state).toBe("active");
  });

  it("downgrades an active GCP credential from dormant inspection and keeps cleanup pending while resources live", async () => {
    mocks.invoke
      .mockResolvedValueOnce(gcpConnectionResult())
      .mockResolvedValueOnce(gcpInspectionResult("cleanup_only"))
      .mockResolvedValueOnce(gcpInspectionResult("cleanup_only"));
    const connected = await connectProviderProject({
      organizationId: "org-a",
      actorUserId: "owner-a",
      providerKind: "gcp_compute",
      credential: gcpCredential("intar-pilot-123", "inspection-key"),
      now: 100,
    });

    await inspectProviderConnection({
      organizationId: "org-a",
      connectionId: connected.id,
      actorUserId: "owner-a",
    });
    const [downgraded] = await listProviderConnections({
      organizationId: "org-a",
      actorUserId: "admin-a",
    });
    expect(downgraded).toMatchObject({
      state: "rotation_required",
      credential: { authority: "cleanup_only" },
    });
    const [credential] = await drizzle(env.DB)
      .select({ authority: providerCredentialVersions.authority })
      .from(providerCredentialVersions);
    expect(credential?.authority).toBe("cleanup_only");
    const events = await drizzle(env.DB).select().from(providerAuditEvents);
    expect(events.at(-1)).toMatchObject({
      type: "provider.connection_cleanup_inspected",
      payloadJson: {
        authority: "cleanup_only",
        previousAuthority: "active",
      },
    });

    await seedInspectionAllocations(connected.id);
    await inspectProviderConnection({
      organizationId: "org-a",
      connectionId: connected.id,
      actorUserId: "owner-a",
    });
    const [cleanupPending] = await listProviderConnections({
      organizationId: "org-a",
      actorUserId: "admin-a",
    });
    expect(cleanupPending).toMatchObject({
      state: "cleanup_pending",
      credential: { authority: "cleanup_only" },
    });
  });

  it("promotes a cleanup-only GCP credential when inspection proves active authority", async () => {
    mocks.invoke
      .mockResolvedValueOnce(gcpConnectionResult())
      .mockResolvedValueOnce({
        credential: encryptedEnvelope("cleanup-only"),
        identity: gcpConnectionResult().identity,
        sentinelNetwork: gcpConnectionResult().foundation.network,
        authority: "cleanup_only",
      })
      .mockResolvedValueOnce(gcpInspectionResult("active"));
    const connected = await connectProviderProject({
      organizationId: "org-a",
      actorUserId: "owner-a",
      providerKind: "gcp_compute",
      credential: gcpCredential("intar-pilot-123", "initial-key"),
      now: 100,
    });
    await rotateProviderCredential({
      organizationId: "org-a",
      connectionId: connected.id,
      actorUserId: "owner-a",
      credential: gcpCredential("intar-pilot-123", "cleanup-key"),
      now: 200,
    });

    await inspectProviderConnection({
      organizationId: "org-a",
      connectionId: connected.id,
      actorUserId: "owner-a",
    });
    const [promoted] = await listProviderConnections({
      organizationId: "org-a",
      actorUserId: "admin-a",
    });
    expect(promoted).toMatchObject({
      state: "active",
      credential: { version: 2, authority: "active" },
    });
    const credentials = await drizzle(env.DB)
      .select({
        version: providerCredentialVersions.version,
        authority: providerCredentialVersions.authority,
      })
      .from(providerCredentialVersions);
    expect(credentials.find((credential) => credential.version === 2)).toEqual({
      version: 2,
      authority: "active",
    });
    const events = await drizzle(env.DB).select().from(providerAuditEvents);
    expect(events.at(-1)).toMatchObject({
      type: "provider.connection_validation_succeeded",
      payloadJson: {
        authority: "active",
        previousAuthority: "cleanup_only",
      },
    });
  });

  it("connects and rotates credentials with issuance disabled, then disconnects only after cleanup", async () => {
    mocks.invoke
      .mockResolvedValueOnce(gcpConnectionResult())
      .mockResolvedValueOnce({
        credential: encryptedEnvelope("rotated"),
        identity: gcpConnectionResult().identity,
        sentinelNetwork: gcpConnectionResult().foundation.network,
        authority: "active",
      });
    const initial = JSON.stringify({
      type: "service_account",
      project_id: "intar-pilot-123",
      private_key: "initial-private-key",
    });
    const connected = await connectProviderProject({
      organizationId: "org-a",
      actorUserId: "owner-a",
      providerKind: "gcp_compute",
      credential: initial,
    });
    const rotatedRaw = JSON.stringify({
      type: "service_account",
      project_id: "intar-pilot-123",
      private_key: "rotated-private-key",
    });
    const rotated = await rotateProviderCredential({
      organizationId: "org-a",
      connectionId: connected.id,
      actorUserId: "owner-a",
      credential: rotatedRaw,
    });
    expect(rotated).toMatchObject({
      state: "active",
      credential: { version: 2 },
    });
    expect(mocks.requireFeature).not.toHaveBeenCalled();

    const disconnected = await disconnectProviderConnection({
      organizationId: "org-a",
      connectionId: connected.id,
      actorUserId: "owner-a",
    });
    expect(disconnected.state).toBe("disconnected");
    const credentials = await drizzle(env.DB)
      .select()
      .from(providerCredentialVersions);
    expect(credentials).toHaveLength(2);
    expect(credentials[0]?.supersededAt).not.toBeNull();
    expect(credentials[1]?.revokedAt).not.toBeNull();
    await expectNoPlaintext("initial-private-key");
    await expectNoPlaintext("rotated-private-key");
  });

  it("serializes lifecycle and guardrail changes with provider allocation", async () => {
    mocks.invoke.mockResolvedValue(hetznerConnectionResult());
    const connected = await connectProviderProject({
      organizationId: "org-a",
      actorUserId: "owner-a",
      providerKind: "hetzner_cloud",
      credential: "initial-hcloud-token",
    });
    let entered!: () => void;
    const lockEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const allocationFinished = new Promise<void>((resolve) => {
      release = resolve;
    });
    const now = Date.now();
    const allocation = withRuntimeAllocationLock({
      key: `runtime-provider-connection:${connected.id}`,
      now,
      operation: async () => {
        entered();
        await allocationFinished;
      },
    });
    await lockEntered;

    const attempts = await Promise.allSettled([
      updateProviderGuardrails({
        organizationId: "org-a",
        connectionId: connected.id,
        actorUserId: "owner-a",
        maxConcurrentAllocations: 1,
        now,
      }),
      disconnectProviderConnection({
        organizationId: "org-a",
        connectionId: connected.id,
        actorUserId: "owner-a",
        now,
      }),
      rotateProviderCredential({
        organizationId: "org-a",
        connectionId: connected.id,
        actorUserId: "owner-a",
        credential: "replacement-hcloud-token",
        now,
      }),
      inspectProviderConnection({
        organizationId: "org-a",
        connectionId: connected.id,
        actorUserId: "owner-a",
      }),
    ]);
    expect(attempts).toEqual([
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({ code: "runtime_allocation_busy" }),
      }),
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({ code: "runtime_allocation_busy" }),
      }),
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({ code: "runtime_allocation_busy" }),
      }),
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({ code: "runtime_allocation_busy" }),
      }),
    ]);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);

    release();
    await allocation;
  });

  it("records dormant GCP rotation as cleanup-only instead of issuance-ready", async () => {
    mocks.invoke
      .mockResolvedValueOnce(gcpConnectionResult())
      .mockResolvedValueOnce({
        credential: encryptedEnvelope("cleanup-only"),
        identity: gcpConnectionResult().identity,
        sentinelNetwork: gcpConnectionResult().foundation.network,
        authority: "cleanup_only",
      });
    const connected = await connectProviderProject({
      organizationId: "org-a",
      actorUserId: "owner-a",
      providerKind: "gcp_compute",
      credential: JSON.stringify({
        type: "service_account",
        project_id: "intar-pilot-123",
        private_key: "initial-private-key",
      }),
    });
    const rotated = await rotateProviderCredential({
      organizationId: "org-a",
      connectionId: connected.id,
      actorUserId: "owner-a",
      credential: JSON.stringify({
        type: "service_account",
        project_id: "intar-pilot-123",
        private_key: "cleanup-private-key",
      }),
    });

    expect(rotated).toMatchObject({
      state: "rotation_required",
      credential: { version: 2, authority: "cleanup_only" },
    });
    expect(rotated.state).toBe("rotation_required");
    const credentials = await drizzle(env.DB)
      .select({ version: providerCredentialVersions.version, authority: providerCredentialVersions.authority })
      .from(providerCredentialVersions);
    expect(credentials).toEqual([
      { version: 1, authority: "active" },
      { version: 2, authority: "cleanup_only" },
    ]);
    const events = await drizzle(env.DB).select().from(providerAuditEvents);
    expect(events.at(-1)).toMatchObject({
      type: "provider.credential_rotated_cleanup_only",
      payloadJson: { authority: "cleanup_only" },
    });

    mocks.invoke.mockRejectedValueOnce(
      appError(409, "gcp_cleanup_inspection_failed", "cleanup inspection failed"),
    );
    await expect(
      inspectProviderConnection({
        organizationId: "org-a",
        connectionId: connected.id,
        actorUserId: "owner-a",
      }),
    ).rejects.toMatchObject({ code: "gcp_cleanup_inspection_failed" });
    const [afterFailure] = await listProviderConnections({
      organizationId: "org-a",
      actorUserId: "admin-a",
    });
    expect(afterFailure).toMatchObject({
      state: "rotation_required",
      credential: { authority: "cleanup_only" },
    });
  });

  it("reconnects the stable provider identity by rotating a disconnected credential", async () => {
    mocks.invoke
      .mockResolvedValueOnce(hetznerConnectionResult())
      .mockResolvedValueOnce({
        credential: encryptedEnvelope("reconnected"),
        sentinel: hetznerConnectionResult().sentinel,
      });
    const connected = await connectProviderProject({
      organizationId: "org-a",
      actorUserId: "owner-a",
      providerKind: "hetzner_cloud",
      credential: "initial-hcloud-token",
    });
    await disconnectProviderConnection({
      organizationId: "org-a",
      connectionId: connected.id,
      actorUserId: "owner-a",
    });

    await expect(
      connectProviderProject({
        organizationId: "org-a",
        actorUserId: "owner-a",
        providerKind: "hetzner_cloud",
        credential: "must-not-be-submitted-to-provider",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "provider_connection_disconnected",
    });

    const reconnected = await rotateProviderCredential({
      organizationId: "org-a",
      connectionId: connected.id,
      actorUserId: "owner-a",
      credential: "replacement-hcloud-token",
    });
    expect(reconnected).toMatchObject({
      id: connected.id,
      state: "active",
      credential: { version: 2 },
    });
    const [row] = await drizzle(env.DB).select().from(providerConnections);
    expect(row?.disconnectedAt).toBeNull();
    const events = await drizzle(env.DB).select().from(providerAuditEvents);
    expect(events.at(-1)?.type).toBe("provider.connection_reconnected");
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    await expectNoPlaintext("replacement-hcloud-token");
  });

  it("does not expose or mutate a connection across organizations", async () => {
    mocks.invoke.mockResolvedValue(hetznerConnectionResult());
    const connected = await connectProviderProject({
      organizationId: "org-a",
      actorUserId: "owner-a",
      providerKind: "hetzner_cloud",
      credential: "organization-a-token",
    });

    await expect(
      listProviderConnections({
        organizationId: "org-b",
        actorUserId: "owner-b",
      }),
    ).resolves.toEqual([]);
    await expect(
      rotateProviderCredential({
        organizationId: "org-b",
        connectionId: connected.id,
        actorUserId: "owner-b",
        credential: "organization-b-token",
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: "provider_connection_not_found",
    });
  });
});

async function seedIdentity() {
  const db = drizzle(env.DB);
  const now = new Date();
  await db.insert(user).values(
    ["owner-a", "admin-a", "member-a", "owner-b"].map((id) => ({
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
  await db.insert(organization).values({
    id: "org-b",
    name: "Organization B",
    slug: "org-b",
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
    {
      id: "membership-owner-b",
      organizationId: "org-b",
      userId: "owner-b",
      role: "owner",
      createdAt: now,
    },
  ]);
}

async function seedInspectionAllocations(connectionId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO workshop_templates
         (id, organization_id, slug, title, summary, created_by, created_at, updated_at)
       VALUES ('inspection-template', 'org-a', 'inspection', 'Inspection',
               'Inspection fixture', 'owner-a', 1, 1)`,
    ),
    env.DB.prepare(
      `INSERT INTO workshop_template_revisions
         (id, template_id, revision, source_revision, content_hash,
          manifest_json, published_by, published_at)
       VALUES ('inspection-revision', 'inspection-template', 1, 'source', ?,
               '{"schemaVersion":2}', 'owner-a', 1)`,
    ).bind("a".repeat(64)),
    env.DB.prepare(
      `INSERT INTO workshop_runtime_profiles
         (id, template_revision_id, profile_id, provider_kind, vm_id,
          machine_type, system_image, resolved_image_id, root_disk_type,
          architecture, cpu_millis, memory_mib, disk_mib, locations_json,
          configuration_json, created_at)
       VALUES ('inspection-profile', 'inspection-revision', 'gcp-e2',
               'gcp_compute', 'learner', 'e2-standard-4', 'debian-13',
               'debian-image-1', 'pd-balanced', 'x86_64', 4000, 16384,
               32768, '["europe-west3-a"]', '{}', 1)`,
    ),
    env.DB.prepare(
      `INSERT INTO provider_price_observations
         (id, provider_kind, connection_id, runtime_profile_id, currency,
          source, raw_observation_json, observed_at, expires_at, created_at)
       VALUES ('inspection-price', 'gcp_compute', ?, 'inspection-profile',
               'USD', 'test', '{}', 1, 86400001, 1)`,
    ).bind(connectionId),
    env.DB.prepare(
      `INSERT INTO workshop_runtime_profile_certifications
         (id, runtime_profile_id, connection_id, state, evidence_json,
          created_at, updated_at)
       VALUES ('inspection-certification', 'inspection-profile', ?,
               'verifying', '{}', 1, 1)`,
    ).bind(connectionId),
    ...["ready", "cleanup"].map((suffix) =>
      env.DB.prepare(
        `INSERT INTO runtime_executions
           (id, user_id, organization_id, provider_kind,
            provider_connection_id, domain_kind, domain_id, generation,
            checkpoint_id, state, created_at, updated_at)
         VALUES (?, 'owner-a', 'org-a', 'gcp_compute', ?,
                 'workshop_certification', 'inspection-certification', ?,
                 'checkpoint-00', ?, 1, 1)`,
      ).bind(
        `execution-${suffix}`,
        connectionId,
        suffix === "ready" ? 1 : 2,
        suffix === "ready" ? "ready" : "archiving",
      )
    ),
    env.DB.prepare(
      `INSERT INTO runtime_provider_allocations
         (id, execution_id, connection_id, runtime_profile_id,
          price_observation_id, provider_kind, deterministic_name,
          machine_type, resolved_image_id, location_attempts_json, location,
          location_attempt, state, created_at, updated_at)
       VALUES ('allocation-ready', 'execution-ready', ?, 'inspection-profile',
               'inspection-price', 'gcp_compute', 'intar-ready',
               'e2-standard-4', 'debian-image-1', '["europe-west3-a"]',
               'europe-west3-a', 1, 'ready', 1, 1)`,
    ).bind(connectionId),
    env.DB.prepare(
      `INSERT INTO runtime_provider_allocations
         (id, execution_id, connection_id, runtime_profile_id,
          price_observation_id, provider_kind, deterministic_name,
          machine_type, resolved_image_id, location_attempts_json, location,
          location_attempt, state, last_error_code, deletion_requested_at,
          created_at, updated_at)
       VALUES ('allocation-cleanup', 'execution-cleanup', ?, 'inspection-profile',
               'inspection-price', 'gcp_compute', 'intar-cleanup',
               'e2-standard-4', 'debian-image-1', '["europe-west3-a"]',
               'europe-west3-a', 1, 'cleanup_pending', 'cleanup_pending', 2,
               1, 2)`,
    ).bind(connectionId),
    env.DB.prepare(
      `INSERT INTO runtime_provider_resources
         (id, allocation_id, provider_kind, resource_kind,
          provider_resource_id, location_attempt, location, provider_state,
          configuration_json, created_at, updated_at)
       VALUES ('resource-ready', 'allocation-ready', 'gcp_compute', 'instance',
               'instance-ready', 1, 'europe-west3-a', 'RUNNING', '{}', 1, 1)`,
    ),
    env.DB.prepare(
      `INSERT INTO runtime_provider_resources
         (id, allocation_id, provider_kind, resource_kind,
          provider_resource_id, location_attempt, location, provider_state,
          configuration_json, created_at, updated_at)
       VALUES ('resource-cleanup', 'allocation-cleanup', 'gcp_compute',
               'boot_disk', 'disk-cleanup', 1, 'europe-west3-a', 'READY',
               '{}', 1, 1)`,
    ),
  ]);
}

async function expectNoPlaintext(value: string) {
  const db = drizzle(env.DB);
  const [connections, credentials, events] = await Promise.all([
    db.select().from(providerConnections),
    db.select().from(providerCredentialVersions),
    db.select().from(providerAuditEvents),
  ]);
  expect(JSON.stringify({ connections, credentials, events })).not.toContain(value);
}

function encryptedEnvelope(suffix = "initial") {
  return {
    algorithm: "AES-256-GCM" as const,
    kekVersion: "v1" as const,
    aadSha256: "a".repeat(64),
    wrappedDek: `wrapped-dek-${suffix}`,
    wrappedDekIv: `wrapped-dek-iv-${suffix}`,
    ciphertext: `ciphertext-${suffix}`,
    ciphertextIv: `ciphertext-iv-${suffix}`,
    createdAt: new Date(1_900_000_000_000).toISOString(),
  };
}

function hetznerConnectionResult() {
  return {
    credential: encryptedEnvelope(),
    catalog: { pricing: { currency: "NOK" } },
    sentinel: { id: 42, name: "sentinel", labels: {}, rules: [] },
    canonicalWrites: [],
  };
}

function gcpConnectionResult(
  projectId = "intar-pilot-123",
  projectNumber = "1234567890",
) {
  return {
    credential: encryptedEnvelope(),
    identity: {
      projectId,
      projectNumber,
      displayName: "Intar pilot",
      lifecycleState: "ACTIVE",
      serviceAccountEmail: `intar@${projectId}.iam.gserviceaccount.com`,
    },
    foundation: {
      network: {
        id: "network-a",
        name: "intar-provider-gcp",
        selfLink: "https://compute.googleapis.com/network-a",
      },
      subnetwork: {
        id: "subnet-a",
        name: "intar-provider-gcp-fra",
        selfLink: "https://compute.googleapis.com/subnet-a",
      },
      firewall: {
        id: "firewall-a",
        name: "intar-provider-gcp-ssh",
        selfLink: "https://compute.googleapis.com/firewall-a",
      },
      createdResourceSelfLinks: [],
    },
    canonicalWrites: [],
  };
}

function gcpInspectionResult(authority: "active" | "cleanup_only") {
  return {
    data: {
      status: "ready",
      validation: { authority },
    },
    canonicalWrites: [],
  };
}

function gcpCredential(projectId: string, privateKey: string): string {
  return JSON.stringify({
    type: "service_account",
    project_id: projectId,
    private_key_id: "test-key",
    private_key: privateKey,
    client_email: `intar@${projectId}.iam.gserviceaccount.com`,
  });
}
