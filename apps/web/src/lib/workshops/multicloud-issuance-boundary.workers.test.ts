/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { WorkshopManifestV2 } from "@intar/workshop-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  requireFeature: vi.fn(),
}));

vi.mock("./provider-service", () => ({
  invokeProviderOperation: mocks.invoke,
}));
vi.mock("./feature-flag", () => ({
  requireWorkshopMulticloudRuntimeEnabledForOrganization:
    mocks.requireFeature,
}));

import {
  hetznerConnectionDetails,
  member,
  organization,
  providerConnections,
  providerCredentialVersions,
  providerPriceObservations,
  runtimeExecutions,
  runtimeProviderAllocations,
  user,
  workshopPublications,
  workshopRegistryTokens,
  workshopRuntimeProfileCertifications,
  workshopRuntimeProfiles,
  workshopSessionCostForecasts,
  workshopSessionMembers,
  workshopSessionRuntimeSelections,
  workshopSessions,
  workshopTemplateRevisions,
  workshopTemplates,
} from "@/db/schema";
import { resetD1Database } from "@/test/d1-migrations";
import { createWorkshopCostForecast } from "./cost-storage";
import {
  allocateProviderCertificationRuntime,
  allocateProviderWorkshopRuntime,
} from "./provider-runtime";
import {
  prepareWorkshopSessionProvider,
  workshopSessionProviderInsert,
} from "./session-provider";

const NOW = Date.parse("2026-08-02T10:00:00.000Z");

describe("multi-cloud Workshop issuance boundary", () => {
  beforeEach(async () => {
    await resetD1Database();
    vi.clearAllMocks();
    mocks.requireFeature.mockRejectedValue(disabledError());
  });

  it("allows exact-profile validation and a cost forecast while issuance is disabled", async () => {
    await seedDirectCloudFixture("verified");
    mocks.invoke.mockResolvedValue(hetznerCatalog());

    const prepared = await prepareWorkshopSessionProvider({
      organizationId: "org-a",
      templateRevisionId: "revision-a",
      runtimeProvider: {
        profileId: "hetzner-cx43",
        connectionId: "connection-a",
      },
    });
    expect(prepared).toMatchObject({
      profileId: "hetzner-cx43",
      providerKind: "hetzner_cloud",
      connectionId: "connection-a",
      resolvedProfile: {
        machineType: "cx43",
        resolvedImageId: "image-13",
      },
    });

    const db = drizzle(env.DB);
    await db.batch([
      db.insert(workshopSessions).values({
        id: "session-a",
        organizationId: "org-a",
        templateRevisionId: "revision-a",
        title: "Forecast-only pilot",
        state: "draft",
        version: 1,
        scheduledStartAt: NOW + 4 * 60 * 60_000,
        lobbyOpensAt: NOW,
        createdBy: "owner-a",
        createdAt: NOW,
        updatedAt: NOW,
      }),
      db
        .insert(workshopSessionRuntimeSelections)
        .values(workshopSessionProviderInsert("session-a", prepared, NOW)),
      db.insert(workshopSessionMembers).values({
        id: "session-member-a",
        sessionId: "session-a",
        userId: "owner-a",
        role: "participant",
        workspaceEnabled: true,
        assignedBy: "owner-a",
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ]);

    await expect(
      createWorkshopCostForecast({
        sessionId: "session-a",
        actorUserId: "owner-a",
        trigger: "session_created",
        now: NOW,
      }),
    ).resolves.toMatchObject({
      sessionId: "session-a",
      providerKind: "hetzner_cloud",
      connectionId: "connection-a",
      currency: "EUR",
      participantCount: 1,
    });
    await expect(
      db.select().from(workshopSessionCostForecasts),
    ).resolves.toHaveLength(1);
    await expect(
      db
        .select({ state: runtimeProviderAllocations.state })
        .from(runtimeProviderAllocations),
    ).resolves.toEqual([{ state: "deleted" }]);
    expect(mocks.requireFeature).not.toHaveBeenCalled();
  });

  it("blocks learner and certification VM creation while issuance is disabled", async () => {
    await expect(
      allocateProviderWorkshopRuntime({ organizationId: "org-a" } as never),
    ).rejects.toMatchObject({
      status: 404,
      code: "workshop_multicloud_runtime_not_found",
    });

    await seedDirectCloudFixture("pending");
    await expect(
      allocateProviderCertificationRuntime({
        certificationId: "certification-a",
        now: NOW,
      }),
    ).rejects.toMatchObject({
      status: 404,
      code: "workshop_multicloud_runtime_not_found",
    });
    expect(mocks.requireFeature).toHaveBeenCalledTimes(2);
    expect(mocks.invoke).not.toHaveBeenCalled();
    await expect(
      drizzle(env.DB).select().from(runtimeProviderAllocations),
    ).resolves.toHaveLength(0);
  });
});

async function seedDirectCloudFixture(
  certificationState: "pending" | "verified",
): Promise<void> {
  const db = drizzle(env.DB);
  const date = new Date(NOW);
  await db.insert(user).values({
    id: "owner-a",
    name: "Owner A",
    email: "owner-a@example.test",
    emailVerified: true,
    createdAt: date,
    updatedAt: date,
  });
  await db.insert(organization).values({
    id: "org-a",
    name: "Organization A",
    slug: "org-a",
    createdAt: date,
  });
  await db.insert(member).values({
    id: "membership-owner-a",
    organizationId: "org-a",
    userId: "owner-a",
    role: "owner",
    createdAt: date,
  });
  await db.insert(workshopTemplates).values({
    id: "template-a",
    organizationId: "org-a",
    slug: "platform-engineering",
    title: "Platform Engineering",
    summary: "Direct-cloud Workshop fixture",
    createdBy: "owner-a",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(workshopTemplateRevisions).values({
    id: "revision-a",
    templateId: "template-a",
    revision: 1,
    sourceRevision: "source-a",
    contentHash: "a".repeat(64),
    manifestJson: workshopManifest(),
    publishedBy: "owner-a",
    publishedAt: NOW,
  });
  await db
    .update(workshopTemplates)
    .set({ currentRevisionId: "revision-a" })
    .where(eq(workshopTemplates.id, "template-a"));
  await db.insert(providerConnections).values({
    id: "connection-a",
    organizationId: "org-a",
    providerKind: "hetzner_cloud",
    displayName: "Hetzner pilot",
    state: "active",
    externalProjectId: "hetzner-firewall:42",
    projectFingerprint: "b".repeat(64),
    activeCredentialVersionId: null,
    createdBy: "owner-a",
    lastValidatedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(providerCredentialVersions).values({
    id: "credential-a",
    connectionId: "connection-a",
    version: 1,
    algorithm: "AES-256-GCM",
    kekVersion: "v1",
    aadSha256: "c".repeat(64),
    encryptedPayloadB64: "ciphertext",
    payloadIvB64: "ciphertext-iv",
    wrappedDekB64: "wrapped-dek",
    dekIvB64: "wrapped-dek-iv",
    credentialFingerprint: "d".repeat(64),
    createdBy: "owner-a",
    activatedAt: NOW,
    createdAt: NOW,
  });
  await db
    .update(providerConnections)
    .set({ activeCredentialVersionId: "credential-a" })
    .where(eq(providerConnections.id, "connection-a"));
  await db.insert(hetznerConnectionDetails).values({
    connectionId: "connection-a",
    sentinelFirewallId: "42",
    approvedLocationsJson: ["nbg1"],
    maxConcurrentAllocations: 5,
    nativeCurrency: "EUR",
    ipv4Enabled: true,
    updatedAt: NOW,
  });
  await db.insert(workshopRuntimeProfiles).values({
    id: "runtime-profile-a",
    templateRevisionId: "revision-a",
    profileId: "hetzner-cx43",
    providerKind: "hetzner_cloud",
    vmId: "learner",
    machineType: "cx43",
    systemImage: "debian-13",
    resolvedImageId: "image-13",
    architecture: "x86_64",
    cpuMillis: 8_000,
    memoryMib: 16_384,
    diskMib: 163_840,
    locationsJson: ["nbg1"],
    configurationJson: {},
    createdAt: NOW,
  });
  await db.insert(workshopRuntimeProfileCertifications).values({
    id: "certification-a",
    runtimeProfileId: "runtime-profile-a",
    connectionId: "connection-a",
    state: "pending",
    evidenceJson: {},
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(workshopRegistryTokens).values({
    id: "registry-token-a",
    organizationId: "org-a",
    name: "Test token",
    tokenPrefix: "intar_test",
    tokenHash: "e".repeat(64),
    createdBy: "owner-a",
    createdAt: NOW,
  });
  await db.insert(workshopPublications).values({
    id: "publication-a",
    organizationId: "org-a",
    workshopSlug: "platform-engineering",
    contentHash: "f".repeat(64),
    sourceR2Key: "workshops/platform-engineering/source.tar.zst",
    compiledManifestJson: { format_version: 2 },
    requiredCheckpointIdsJson: ["checkpoint-00"],
    status: "building",
    submittedBy: "owner-a",
    registryTokenId: "registry-token-a",
    publishedRevisionId: "revision-a",
    certificationState:
      certificationState === "verified" ? "verified" : "verifying",
    createdAt: NOW,
    updatedAt: NOW,
  });
  if (certificationState === "verified") {
    await db.insert(providerPriceObservations).values({
      id: "certification-price-a",
      providerKind: "hetzner_cloud",
      connectionId: "connection-a",
      runtimeProfileId: "runtime-profile-a",
      currency: "EUR",
      source: "test-fixture",
      rawObservationJson: {},
      observedAt: NOW,
      expiresAt: NOW + 24 * 60 * 60_000,
      createdAt: NOW,
    });
    await db.insert(runtimeExecutions).values({
      id: "certification-execution-a",
      userId: "owner-a",
      organizationId: "org-a",
      hostId: null,
      providerKind: "hetzner_cloud",
      providerConnectionId: "connection-a",
      domainKind: "workshop_certification",
      domainId: "certification-a",
      generation: 1,
      checkpointId: "checkpoint-00",
      state: "archived",
      leaseExpiresAt: NOW,
      archiveRequestedAt: NOW,
      endedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await db.insert(runtimeProviderAllocations).values({
      id: "certification-allocation-a",
      executionId: "certification-execution-a",
      connectionId: "connection-a",
      runtimeProfileId: "runtime-profile-a",
      priceObservationId: "certification-price-a",
      costForecastId: null,
      providerKind: "hetzner_cloud",
      deterministicName: "intar-certification-a",
      machineType: "cx43",
      resolvedImageId: "image-13",
      locationAttemptsJson: ["nbg1"],
      location: "nbg1",
      locationAttempt: 1,
      locationAttemptStartedAt: NOW,
      state: "deleted",
      deletionConfirmedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await db
      .update(workshopRuntimeProfileCertifications)
      .set({
        state: "verified",
        verifierAllocationId: "certification-allocation-a",
        verifiedAt: NOW,
        deletionConfirmedAt: NOW,
        updatedAt: NOW,
      })
      .where(eq(workshopRuntimeProfileCertifications.id, "certification-a"));
  }
}

function workshopManifest(): WorkshopManifestV2 {
  return {
    schemaVersion: 2,
    workshop: {
      slug: "platform-engineering",
      title: "Platform Engineering",
      summary: "Direct-cloud Workshop fixture",
      prerequisites: [],
      attribution: {
        title: "Test fixture",
        url: "https://example.test/workshop",
        license: "Apache-2.0",
      },
      defaultLobbyMinutes: 30,
    },
    workspace: {
      leaseGraceMinutes: 60,
      vms: [
        {
          id: "learner",
          name: "Learner",
          cpuMillis: 4_000,
          memoryMib: 16_384,
          diskMib: 32_768,
        },
      ],
      runtimeProfiles: [
        {
          id: "hetzner-cx43",
          provider: "hetzner_cloud",
          vmId: "learner",
          machineType: "cx43",
          requestedSystemImage: "debian-13",
          immutableSystemImage: "image-13",
          locations: ["nbg1"],
          hardware: {
            architecture: "x86_64",
            cpuMillis: 8_000,
            providerCpuCount: 8,
            memoryMib: 16_384,
            diskMib: 163_840,
          },
        },
      ],
      checkpoints: [
        {
          id: "checkpoint-00",
          label: "Initial",
          vmImages: [],
        },
      ],
      initialCheckpointId: "checkpoint-00",
      applications: [],
    },
    modules: [],
    agenda: [],
    presentation: { slides: [] },
    durationMinutes: 240,
  };
}

function hetznerCatalog() {
  return {
    data: {
      observedAt: new Date(NOW).toISOString(),
      serverTypes: [
        {
          name: "cx43",
          architecture: "x86",
          cores: 8,
          memory: 16,
          disk: 160,
          deprecated: false,
          locations: [
            { name: "nbg1", available: true, deprecation: null },
          ],
        },
      ],
      systemImages: [
        {
          id: "image-13",
          name: "debian-13",
          architecture: "x86",
          status: "available",
        },
      ],
      pricing: {
        currency: "EUR",
        server_types: [
          {
            name: "cx43",
            prices: [
              {
                location: "nbg1",
                price_hourly: { net: "0.01", gross: "0.0119" },
                price_monthly: { net: "5.00", gross: "5.95" },
              },
            ],
          },
        ],
        primary_ips: [
          {
            type: "ipv4",
            prices: [
              {
                location: "nbg1",
                price_hourly: { net: "0.001", gross: "0.00119" },
                price_monthly: { net: "0.50", gross: "0.595" },
              },
            ],
          },
        ],
      },
    },
  };
}

function disabledError() {
  return Object.assign(new Error("multi-cloud workshop runtime is not enabled"), {
    status: 404,
    code: "workshop_multicloud_runtime_not_found",
  });
}
