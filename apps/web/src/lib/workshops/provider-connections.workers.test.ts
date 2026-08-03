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
import {
  connectProviderProject,
  disconnectProviderConnection,
  inspectProviderConnection,
  listProviderConnections,
  rotateProviderCredential,
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
    await expect(
      env.DB.prepare(
        `UPDATE provider_connections SET state = 'active' WHERE id = ?`,
      ).bind(connected.id).run(),
    ).rejects.toThrow(/active credential does not belong/u);
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

function gcpConnectionResult() {
  return {
    credential: encryptedEnvelope(),
    identity: {
      projectId: "intar-pilot-123",
      projectNumber: "1234567890",
      displayName: "Intar pilot",
      lifecycleState: "ACTIVE",
      serviceAccountEmail: "intar@intar-pilot-123.iam.gserviceaccount.com",
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
