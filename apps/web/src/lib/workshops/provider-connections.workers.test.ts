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
  listProviderConnections,
  rotateProviderCredential,
} from "./provider-connections";

describe("generic Workshop BYOK connections", () => {
  beforeEach(async () => {
    await resetD1Database();
    vi.clearAllMocks();
    mocks.requireFeature.mockResolvedValue(undefined);
    await seedIdentity();
  });

  it("connects Hetzner for an owner, masks health for admins, and persists no token", async () => {
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

  it("rotates credentials without the issuance flag and disconnects only after cleanup", async () => {
    mocks.invoke
      .mockResolvedValueOnce(gcpConnectionResult())
      .mockResolvedValueOnce({
        credential: encryptedEnvelope("rotated"),
        identity: gcpConnectionResult().identity,
        sentinelNetwork: gcpConnectionResult().foundation.network,
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
    mocks.requireFeature.mockRejectedValue(
      new Error("issuance feature is disabled"),
    );
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
    expect(mocks.requireFeature).toHaveBeenCalledTimes(1);

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
