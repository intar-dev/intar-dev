import { env } from "cloudflare:workers";
import { and, count, desc, eq, inArray, max, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type {
  EncryptedCredentialEnvelope,
  ProviderOwnership,
} from "@intar/provider-contracts";
import type {
  ConnectGcpProjectResult,
  GcpFoundationSpec,
  RotateGcpCredentialResult,
} from "@intar/provider-contracts/gcp";
import type {
  ConnectProjectResult as ConnectHetznerProjectResult,
  RotateCredentialResult as RotateHetznerCredentialResult,
} from "@intar/provider-contracts/hetzner";
import type { RuntimeProviderKind } from "@intar/workshop-contracts";
import {
  gcpConnectionDetails,
  hetznerConnectionDetails,
  providerAuditEvents,
  providerConnections,
  providerCredentialVersions,
  runtimeProviderAllocations,
  runtimeProviderResources,
  workshopRuntimeProfileCertifications,
} from "@/db/schema";
import { appError } from "@/lib/app-error";
import { createAppId } from "@/lib/id";
import { requireOrganizationRole } from "@/lib/organizations";
import {
  providerCredentialContext,
  providerCredentialEnvelope,
} from "./provider-credential";
import { invokeProviderOperation } from "./provider-service";

export type DirectCloudProviderKind = Exclude<
  RuntimeProviderKind,
  "agent_kvm"
>;

const DEFAULT_HETZNER_LOCATIONS = ["nbg1", "fsn1", "hel1"] as const;
const DEFAULT_GCP_ZONES = [
  "europe-west3-a",
  "europe-west3-b",
  "europe-west3-c",
] as const;
const DEFAULT_MAX_ALLOCATIONS = 5;

export interface ProviderConnectionRecord {
  id: string;
  organizationId: string;
  providerKind: DirectCloudProviderKind;
  displayName: string;
  state: "validating" | "active" | "rotation_required" | "cleanup_pending" | "disconnected";
  externalProjectId: string;
  lastValidatedAt: number | null;
  createdAt: number;
  updatedAt: number;
  credential: {
    version: number;
    authority: "active" | "cleanup_only";
    fingerprint: string;
    activatedAt: number;
  } | null;
  guardrails: {
    locations: string[];
    maxConcurrentAllocations: number;
    maxSessionCostNanos: number | null;
  };
  providerDetails:
    | {
        providerKind: "hetzner_cloud";
        sentinelFirewallId: string;
        nativeCurrency: string;
        ipv4Enabled: true;
      }
    | {
        providerKind: "gcp_compute";
        projectNumber: string;
        networkName: string;
        subnetName: string;
        firewallName: string;
        nativeCurrency: "USD";
      };
  cleanupAcknowledgement: {
    acknowledgedAt: number;
    acknowledgedBy: string;
    verified: false;
  } | null;
}

export async function connectProviderProject(input: {
  organizationId: string;
  actorUserId: string;
  providerKind: DirectCloudProviderKind;
  credential: string;
  displayName?: string;
  externalProjectId?: string;
  approvedLocations?: readonly string[];
  maxConcurrentAllocations?: number;
  maxSessionCostNanos?: number | null;
  now?: number;
}): Promise<ProviderConnectionRecord> {
  await requireOwner(input.organizationId, input.actorUserId);
  const credentialText = requiredCredential(input.credential);
  const locations = locationsFor(input.providerKind, input.approvedLocations);
  const maxConcurrentAllocations = allocationLimit(
    input.maxConcurrentAllocations,
  );
  const maxSessionCostNanos = costLimit(input.maxSessionCostNanos);
  const now = input.now ?? Date.now();
  const db = drizzle(env.DB);
  const existing = await db
    .select({
      id: providerConnections.id,
      state: providerConnections.state,
    })
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.organizationId, input.organizationId),
        eq(providerConnections.providerKind, input.providerKind),
      ),
    )
    .limit(1);
  if (existing[0]) {
    if (existing[0].state === "disconnected") {
      throw appError(
        409,
        "provider_connection_disconnected",
        "rotate the disconnected connection credential to reconnect this provider",
      );
    }
    throw appError(
      409,
      "provider_connection_exists",
      "this organization already has an active connection for that provider",
    );
  }

  const connectionId = await stableConnectionId(
    input.organizationId,
    input.providerKind,
  );
  const credentialId = createAppId();
  const credentialContext = {
    organizationId: input.organizationId,
    connectionId,
    credentialId,
    provider: input.providerKind,
    version: 1,
  } as const;
  const ownership = await providerOwnership(
    input.organizationId,
    connectionId,
    "provider_connection_sentinel",
  );

  const connected =
    input.providerKind === "hetzner_cloud"
      ? await invokeProviderOperation<ConnectHetznerProjectResult>(
          "hetzner_cloud",
          (binding) =>
            binding.connectProject<ConnectHetznerProjectResult>({
              requestId: createAppId(),
              connectionId,
              credentialContext,
              token: credentialText,
              sentinel: {
                name: sentinelName(connectionId),
                ownership,
                stargateEgressIpv4Cidrs: stargateEgressIpv4Cidrs(),
              },
              requiredServerTypes: [],
              permittedLocations: locations,
              systemImage: "debian-13",
            }),
        )
      : await connectGcp({
          connectionId,
          credentialId,
          organizationId: input.organizationId,
          serviceAccountKeyJson: credentialText,
          ...(input.externalProjectId === undefined
            ? {}
            : { expectedProjectId: input.externalProjectId }),
          zones: locations,
          ownership,
        });

  const envelope = connected.credential;
  const credentialFingerprint = await sha256Hex(credentialText);
  const displayName = normalizeDisplayName(input.displayName, input.providerKind);
  const commonConnection = {
    id: connectionId,
    organizationId: input.organizationId,
    providerKind: input.providerKind,
    displayName,
    state: "active" as const,
    activeCredentialVersionId: null,
    createdBy: input.actorUserId,
    lastValidatedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  if (input.providerKind === "hetzner_cloud") {
    const result = connected as ConnectHetznerProjectResult;
    const externalProjectId = `hetzner-firewall:${result.sentinel.id}`;
    await db.batch([
      db.insert(providerConnections).values({
        ...commonConnection,
        externalProjectId,
        projectFingerprint: await sha256Hex(externalProjectId),
      }),
      db.insert(providerCredentialVersions).values(
        credentialInsert({
          credentialId,
          connectionId,
          envelope,
          credentialFingerprint,
          actorUserId: input.actorUserId,
          version: 1,
          now,
        }),
      ),
      db.insert(hetznerConnectionDetails).values({
        connectionId,
        sentinelFirewallId: String(result.sentinel.id),
        approvedLocationsJson: locations,
        maxConcurrentAllocations,
        maxSessionCostNanos,
        nativeCurrency: currency(result.catalog.pricing.currency),
        ipv4Enabled: true,
        updatedAt: now,
      }),
      auditInsert({
        organizationId: input.organizationId,
        connectionId,
        actorUserId: input.actorUserId,
        type: "provider.connection_created",
        payload: { providerKind: input.providerKind, externalProjectId },
        now,
      }),
      db
        .update(providerConnections)
        .set({ activeCredentialVersionId: credentialId, updatedAt: now })
        .where(eq(providerConnections.id, connectionId)),
    ]);
  } else {
    const result = connected as ConnectGcpProjectResult;
    const projectId = result.identity.projectId;
    await db.batch([
      db.insert(providerConnections).values({
        ...commonConnection,
        externalProjectId: projectId,
        projectFingerprint: await sha256Hex(`gcp:${result.identity.projectNumber}`),
      }),
      db.insert(providerCredentialVersions).values(
        credentialInsert({
          credentialId,
          connectionId,
          envelope,
          credentialFingerprint,
          actorUserId: input.actorUserId,
          version: 1,
          now,
        }),
      ),
      db.insert(gcpConnectionDetails).values({
        connectionId,
        projectNumber: result.identity.projectNumber,
        networkName: result.foundation.network.name,
        networkSelfLink: result.foundation.network.selfLink,
        subnetName: result.foundation.subnetwork.name,
        subnetSelfLink: result.foundation.subnetwork.selfLink,
        subnetCidr: "10.77.0.0/20",
        firewallName: result.foundation.firewall.name,
        firewallSelfLink: result.foundation.firewall.selfLink,
        approvedZonesJson: locations,
        maxConcurrentAllocations,
        maxSessionCostNanos,
        updatedAt: now,
      }),
      auditInsert({
        organizationId: input.organizationId,
        connectionId,
        actorUserId: input.actorUserId,
        type: "provider.connection_created",
        payload: { providerKind: input.providerKind, externalProjectId: projectId },
        now,
      }),
      db
        .update(providerConnections)
        .set({ activeCredentialVersionId: credentialId, updatedAt: now })
        .where(eq(providerConnections.id, connectionId)),
    ]);
  }
  return requireListedConnection(input.organizationId, input.actorUserId, connectionId);
}

export async function listProviderConnections(input: {
  organizationId: string;
  actorUserId: string;
}): Promise<ProviderConnectionRecord[]> {
  await requireOrganizationRole({
    organizationId: input.organizationId,
    userId: input.actorUserId,
    admin: true,
  });
  const db = drizzle(env.DB);
  const rows = await db
    .select({ connection: providerConnections, credential: providerCredentialVersions })
    .from(providerConnections)
    .leftJoin(
      providerCredentialVersions,
      eq(providerCredentialVersions.id, providerConnections.activeCredentialVersionId),
    )
    .where(eq(providerConnections.organizationId, input.organizationId))
    .orderBy(desc(providerConnections.createdAt));
  const connectionIds = rows.map(({ connection }) => connection.id);
  const [hetzner, gcp] = connectionIds.length
    ? await Promise.all([
        db
          .select()
          .from(hetznerConnectionDetails)
          .where(inArray(hetznerConnectionDetails.connectionId, connectionIds)),
        db
          .select()
          .from(gcpConnectionDetails)
          .where(inArray(gcpConnectionDetails.connectionId, connectionIds)),
      ])
    : [[], []];
  const hetznerById = new Map(hetzner.map((entry) => [entry.connectionId, entry]));
  const gcpById = new Map(gcp.map((entry) => [entry.connectionId, entry]));
  return rows.map(({ connection, credential }) => {
    const common = {
      id: connection.id,
      organizationId: connection.organizationId,
      providerKind: connection.providerKind,
      displayName: connection.displayName,
      state: connection.state,
      externalProjectId: connection.externalProjectId,
      lastValidatedAt: connection.lastValidatedAt,
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
      credential: credential
        ? {
            version: credential.version,
            authority: credential.authority,
            fingerprint: maskFingerprint(credential.credentialFingerprint),
            activatedAt: credential.activatedAt,
          }
        : null,
    };
    if (connection.providerKind === "hetzner_cloud") {
      const detail = hetznerById.get(connection.id);
      if (!detail) throw corruptConnection();
      return {
        ...common,
        providerKind: "hetzner_cloud",
        guardrails: {
          locations: detail.approvedLocationsJson,
          maxConcurrentAllocations: detail.maxConcurrentAllocations,
          maxSessionCostNanos: detail.maxSessionCostNanos,
        },
        providerDetails: {
          providerKind: "hetzner_cloud",
          sentinelFirewallId: detail.sentinelFirewallId,
          nativeCurrency: detail.nativeCurrency,
          ipv4Enabled: true as const,
        },
        cleanupAcknowledgement:
          detail.cleanupAcknowledgedAt && detail.cleanupAcknowledgedBy
            ? {
                acknowledgedAt: detail.cleanupAcknowledgedAt,
                acknowledgedBy: detail.cleanupAcknowledgedBy,
                verified: false as const,
              }
            : null,
      };
    }
    const detail = gcpById.get(connection.id);
    if (!detail) throw corruptConnection();
    return {
      ...common,
      providerKind: "gcp_compute",
      guardrails: {
        locations: detail.approvedZonesJson,
        maxConcurrentAllocations: detail.maxConcurrentAllocations,
        maxSessionCostNanos: detail.maxSessionCostNanos,
      },
      providerDetails: {
        providerKind: "gcp_compute",
        projectNumber: detail.projectNumber,
        networkName: detail.networkName,
        subnetName: detail.subnetName,
        firewallName: detail.firewallName,
        nativeCurrency: "USD" as const,
      },
      cleanupAcknowledgement:
        detail.cleanupAcknowledgedAt && detail.cleanupAcknowledgedBy
          ? {
              acknowledgedAt: detail.cleanupAcknowledgedAt,
              acknowledgedBy: detail.cleanupAcknowledgedBy,
              verified: false as const,
            }
          : null,
    };
  });
}

export async function rotateProviderCredential(input: {
  organizationId: string;
  connectionId: string;
  actorUserId: string;
  credential: string;
  now?: number;
}): Promise<ProviderConnectionRecord> {
  await requireOwner(input.organizationId, input.actorUserId);
  const connection = await requireConnection(input.organizationId, input.connectionId);
  const reconnecting = connection.state === "disconnected";
  const previous = reconnecting
    ? await loadCredentialVersion(connection)
    : await loadActiveCredential(connection);
  const raw = requiredCredential(input.credential);
  const now = input.now ?? Date.now();
  const versionRows = await drizzle(env.DB)
    .select({ value: max(providerCredentialVersions.version) })
    .from(providerCredentialVersions)
    .where(eq(providerCredentialVersions.connectionId, connection.id));
  const version = (versionRows[0]?.value ?? 0) + 1;
  const credentialId = createAppId();
  const context = {
    organizationId: input.organizationId,
    connectionId: connection.id,
    credentialId,
    provider: connection.providerKind,
    version,
  } as const;
  const ownership = await providerOwnership(
    input.organizationId,
    connection.id,
    "provider_connection_sentinel",
  );
  let result: RotateHetznerCredentialResult | RotateGcpCredentialResult;
  let credentialAuthority: "active" | "cleanup_only" = "active";
  if (connection.providerKind === "hetzner_cloud") {
    const details = await requireHetznerDetails(connection.id);
    result = await invokeProviderOperation<RotateHetznerCredentialResult>(
      "hetzner_cloud",
      (binding) =>
        binding.rotateCredential<RotateHetznerCredentialResult>({
          requestId: createAppId(),
          connectionId: connection.id,
          credentialContext: context,
          token: raw,
          sentinelId: positiveInteger(details.sentinelFirewallId, "sentinel firewall"),
          sentinelName: sentinelName(connection.id),
          ownership,
        }),
    );
  } else {
    const details = await requireGcpDetails(connection.id);
    result = await invokeProviderOperation<RotateGcpCredentialResult>(
      "gcp_compute",
      (binding) =>
        binding.rotateCredential<RotateGcpCredentialResult>({
          requestId: createAppId(),
          connectionId: connection.id,
          credentialContext: context,
          serviceAccountKeyJson: raw,
          projectId: connection.externalProjectId,
          sentinelNetworkSelfLink: details.networkSelfLink,
          ownership,
        }),
    );
    credentialAuthority = result.authority;
  }
  const nextConnectionState = credentialAuthority === "active"
    ? "active" as const
    : await countLiveProviderAllocations(connection.id) > 0
      ? "cleanup_pending" as const
      : "rotation_required" as const;
  const db = drizzle(env.DB);
  await db.batch([
    db.insert(providerCredentialVersions).values(
      credentialInsert({
        credentialId,
        connectionId: connection.id,
        envelope: result.credential,
        credentialFingerprint: await sha256Hex(raw),
        actorUserId: input.actorUserId,
        version,
        authority: credentialAuthority,
        now,
      }),
    ),
    db
      .update(providerCredentialVersions)
      .set({ supersededAt: now })
      .where(eq(providerCredentialVersions.id, previous.id)),
    db
      .update(providerConnections)
      .set({
        activeCredentialVersionId: credentialId,
        state: nextConnectionState,
        lastValidatedAt: now,
        disconnectedAt: null,
        updatedAt: now,
      })
      .where(eq(providerConnections.id, connection.id)),
    auditInsert({
      organizationId: input.organizationId,
      connectionId: connection.id,
      actorUserId: input.actorUserId,
      type: credentialAuthority === "cleanup_only"
        ? "provider.credential_rotated_cleanup_only"
        : reconnecting
          ? "provider.connection_reconnected"
          : "provider.credential_rotated",
      payload: {
        providerKind: connection.providerKind,
        version,
        authority: credentialAuthority,
      },
      now,
    }),
  ]);
  return requireListedConnection(input.organizationId, input.actorUserId, connection.id);
}

export async function updateProviderGuardrails(input: {
  organizationId: string;
  connectionId: string;
  actorUserId: string;
  approvedLocations?: readonly string[];
  maxConcurrentAllocations?: number;
  maxSessionCostNanos?: number | null;
  now?: number;
}): Promise<ProviderConnectionRecord> {
  await requireOwner(input.organizationId, input.actorUserId);
  const connection = await requireConnection(input.organizationId, input.connectionId);
  const now = input.now ?? Date.now();
  const locations = locationsFor(connection.providerKind, input.approvedLocations);
  const db = drizzle(env.DB);
  if (connection.providerKind === "hetzner_cloud") {
    const current = await requireHetznerDetails(connection.id);
    await db
      .update(hetznerConnectionDetails)
      .set({
        approvedLocationsJson:
          input.approvedLocations === undefined
            ? current.approvedLocationsJson
            : locations,
        maxConcurrentAllocations:
          input.maxConcurrentAllocations === undefined
            ? current.maxConcurrentAllocations
            : allocationLimit(input.maxConcurrentAllocations),
        maxSessionCostNanos:
          input.maxSessionCostNanos === undefined
            ? current.maxSessionCostNanos
            : costLimit(input.maxSessionCostNanos),
        updatedAt: now,
      })
      .where(eq(hetznerConnectionDetails.connectionId, connection.id));
  } else {
    const current = await requireGcpDetails(connection.id);
    await db
      .update(gcpConnectionDetails)
      .set({
        approvedZonesJson:
          input.approvedLocations === undefined
            ? current.approvedZonesJson
            : locations,
        maxConcurrentAllocations:
          input.maxConcurrentAllocations === undefined
            ? current.maxConcurrentAllocations
            : allocationLimit(input.maxConcurrentAllocations),
        maxSessionCostNanos:
          input.maxSessionCostNanos === undefined
            ? current.maxSessionCostNanos
            : costLimit(input.maxSessionCostNanos),
        updatedAt: now,
      })
      .where(eq(gcpConnectionDetails.connectionId, connection.id));
  }
  await db.insert(providerAuditEvents).values({
    id: createAppId(),
    organizationId: input.organizationId,
    connectionId: connection.id,
    actorUserId: input.actorUserId,
    type: "provider.guardrails_updated",
    payloadJson: { providerKind: connection.providerKind },
    createdAt: now,
  });
  return requireListedConnection(input.organizationId, input.actorUserId, connection.id);
}

export async function inspectProviderConnection(input: {
  organizationId: string;
  connectionId: string;
  actorUserId: string;
}) {
  await requireOwner(input.organizationId, input.actorUserId);
  const connection = await requireConnection(input.organizationId, input.connectionId);
  const credential = await loadActiveCredential(connection);
  const common = {
    requestId: createAppId(),
    connectionId: connection.id,
    credentialContext: providerCredentialContext({
      organizationId: input.organizationId,
      connection,
      credential,
    }),
    credential: providerCredentialEnvelope(credential),
  };
  const result =
    connection.providerKind === "hetzner_cloud"
      ? await invokeProviderOperation("hetzner_cloud", (binding) =>
          binding.runOperation({ ...common, operation: { kind: "inventory" } }),
        )
      : await invokeProviderOperation("gcp_compute", async (binding) => {
          const detail = await requireGcpDetails(connection.id);
          const ownership = await providerOwnership(
            input.organizationId,
            connection.id,
            "provider_connection_sentinel",
          );
          return binding.runOperation({
            ...common,
            projectId: connection.externalProjectId,
            operation: {
              kind: "inspect_connection",
              foundation: gcpFoundation(
                connection.id,
                detail.approvedZonesJson,
                ownership,
              ),
            },
          });
        });
  const db = drizzle(env.DB);
  const allocations = await db
    .select({
      id: runtimeProviderAllocations.id,
      executionId: runtimeProviderAllocations.executionId,
      state: runtimeProviderAllocations.state,
      deterministicName: runtimeProviderAllocations.deterministicName,
      location: runtimeProviderAllocations.location,
      locationAttempt: runtimeProviderAllocations.locationAttempt,
      deletionRequestedAt: runtimeProviderAllocations.deletionRequestedAt,
      deletionConfirmedAt: runtimeProviderAllocations.deletionConfirmedAt,
      lastErrorCode: runtimeProviderAllocations.lastErrorCode,
    })
    .from(runtimeProviderAllocations)
    .where(
      and(
        eq(runtimeProviderAllocations.connectionId, connection.id),
        ne(runtimeProviderAllocations.state, "deleted"),
      ),
    );
  const resources = allocations.length === 0
    ? []
    : await db
        .select({
          id: runtimeProviderResources.id,
          allocationId: runtimeProviderResources.allocationId,
          resourceKind: runtimeProviderResources.resourceKind,
          providerResourceId: runtimeProviderResources.providerResourceId,
          locationAttempt: runtimeProviderResources.locationAttempt,
          location: runtimeProviderResources.location,
          providerState: runtimeProviderResources.providerState,
          disappearanceConfirmedAt: runtimeProviderResources.disappearanceConfirmedAt,
        })
        .from(runtimeProviderResources)
        .where(inArray(
          runtimeProviderResources.allocationId,
          allocations.map((allocation) => allocation.id),
        ));
  const runtimeAllocations = allocations.map((allocation) => ({
    ...allocation,
    resources: resources.filter((resource) => resource.allocationId === allocation.id),
  }));
  const observedAt = Date.now();
  await db
    .update(providerConnections)
    .set({ lastValidatedAt: observedAt, updatedAt: observedAt })
    .where(eq(providerConnections.id, connection.id));
  return {
    connectionId: connection.id,
    providerKind: connection.providerKind,
    observedAt,
    data: result.data,
    runtimeAllocations,
  };
}

export async function disconnectProviderConnection(input: {
  organizationId: string;
  connectionId: string;
  actorUserId: string;
  now?: number;
}): Promise<ProviderConnectionRecord> {
  await requireOwner(input.organizationId, input.actorUserId);
  const connection = await requireConnection(input.organizationId, input.connectionId);
  const live = await countLiveProviderAllocations(connection.id);
  if (live > 0) {
    throw appError(
      409,
      "provider_cleanup_required",
      "provider resources must be deleted before disconnecting",
    );
  }
  const now = input.now ?? Date.now();
  const db = drizzle(env.DB);
  const credential = connection.activeCredentialVersionId;
  await db.batch([
    db
      .update(providerConnections)
      .set({ state: "disconnected", disconnectedAt: now, updatedAt: now })
      .where(eq(providerConnections.id, connection.id)),
    ...(credential
      ? [
          db
            .update(providerCredentialVersions)
            .set({ revokedAt: now })
            .where(eq(providerCredentialVersions.id, credential)),
        ]
      : []),
    auditInsert({
      organizationId: input.organizationId,
      connectionId: connection.id,
      actorUserId: input.actorUserId,
      type: "provider.connection_disconnected",
      payload: { providerKind: connection.providerKind },
      now,
    }),
  ]);
  return requireListedConnection(input.organizationId, input.actorUserId, connection.id);
}

export async function acknowledgeProviderManualCleanup(input: {
  organizationId: string;
  connectionId: string;
  actorUserId: string;
  now?: number;
}): Promise<{ acknowledgedAt: number; verified: false; pendingAllocations: number }> {
  await requireOwner(input.organizationId, input.actorUserId);
  const connection = await requireConnection(input.organizationId, input.connectionId);
  const pendingAllocations = await countLiveProviderAllocations(connection.id);
  if (pendingAllocations === 0) {
    throw appError(409, "provider_cleanup_not_pending", "no provider cleanup is pending");
  }
  const now = input.now ?? Date.now();
  const db = drizzle(env.DB);
  const detailUpdate =
    connection.providerKind === "hetzner_cloud"
      ? db
          .update(hetznerConnectionDetails)
          .set({ cleanupAcknowledgedAt: now, cleanupAcknowledgedBy: input.actorUserId, updatedAt: now })
          .where(eq(hetznerConnectionDetails.connectionId, connection.id))
      : db
          .update(gcpConnectionDetails)
          .set({ cleanupAcknowledgedAt: now, cleanupAcknowledgedBy: input.actorUserId, updatedAt: now })
          .where(eq(gcpConnectionDetails.connectionId, connection.id));
  await db.batch([
    detailUpdate,
    db
      .update(providerConnections)
      .set({ state: "cleanup_pending", updatedAt: now })
      .where(eq(providerConnections.id, connection.id)),
    auditInsert({
      organizationId: input.organizationId,
      connectionId: connection.id,
      actorUserId: input.actorUserId,
      type: "provider.manual_cleanup_acknowledged",
      payload: { providerKind: connection.providerKind, pendingAllocations },
      now,
    }),
  ]);
  return { acknowledgedAt: now, verified: false, pendingAllocations };
}

export async function requireConnection(
  organizationId: string,
  connectionId: string,
) {
  const rows = await drizzle(env.DB)
    .select()
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.id, connectionId),
        eq(providerConnections.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw appError(404, "provider_connection_not_found", "provider connection not found");
  return rows[0];
}

export async function loadActiveCredential(
  connection: typeof providerConnections.$inferSelect,
) {
  const credential = await loadCredentialVersion(connection);
  if (credential.revokedAt !== null) {
    throw appError(409, "provider_credential_missing", "provider credential is unavailable");
  }
  return credential;
}

async function loadCredentialVersion(
  connection: typeof providerConnections.$inferSelect,
) {
  if (!connection.activeCredentialVersionId) {
    throw appError(409, "provider_credential_missing", "provider credential is unavailable");
  }
  const rows = await drizzle(env.DB)
    .select()
    .from(providerCredentialVersions)
    .where(
      and(
        eq(providerCredentialVersions.id, connection.activeCredentialVersionId),
        eq(providerCredentialVersions.connectionId, connection.id),
      ),
    )
    .limit(1);
  if (!rows[0]) {
    throw appError(409, "provider_credential_missing", "provider credential is unavailable");
  }
  return rows[0];
}

export async function countLiveProviderAllocations(connectionId: string): Promise<number> {
  const rows = await drizzle(env.DB)
    .select({ value: count() })
    .from(runtimeProviderAllocations)
    .where(
      and(
        eq(runtimeProviderAllocations.connectionId, connectionId),
        ne(runtimeProviderAllocations.state, "deleted"),
      ),
    );
  const certificationRows = await drizzle(env.DB)
    .select({ value: count() })
    .from(workshopRuntimeProfileCertifications)
    .where(
      and(
        eq(workshopRuntimeProfileCertifications.connectionId, connectionId),
        ne(workshopRuntimeProfileCertifications.state, "verified"),
        ne(workshopRuntimeProfileCertifications.state, "failed"),
      ),
    );
  return (rows[0]?.value ?? 0) + (certificationRows[0]?.value ?? 0);
}

export async function providerOwnership(
  organizationId: string,
  connectionId: string,
  purpose: ProviderOwnership["purpose"] = "learner_workspace",
): Promise<ProviderOwnership> {
  return {
    organizationRef: (await sha256Hex(organizationId)).slice(0, 32),
    connectionRef: (await sha256Hex(connectionId)).slice(0, 32),
    purpose,
  };
}

async function connectGcp(input: {
  connectionId: string;
  credentialId: string;
  organizationId: string;
  serviceAccountKeyJson: string;
  expectedProjectId?: string;
  zones: string[];
  ownership: ProviderOwnership;
}) {
  const projectId = gcpProjectId(input.serviceAccountKeyJson);
  if (input.expectedProjectId && input.expectedProjectId !== projectId) {
    throw appError(400, "gcp_project_mismatch", "GCP key project does not match the requested project");
  }
  return invokeProviderOperation<ConnectGcpProjectResult>(
    "gcp_compute",
    (binding) =>
      binding.connectProject<ConnectGcpProjectResult>({
        requestId: createAppId(),
        connectionId: input.connectionId,
        credentialContext: {
          organizationId: input.organizationId,
          connectionId: input.connectionId,
          credentialId: input.credentialId,
          provider: "gcp_compute",
          version: 1,
        },
        serviceAccountKeyJson: input.serviceAccountKeyJson,
        projectId,
        permittedZones: input.zones,
        requiredMachineTypes: ["e2-standard-4"],
        imageFamily: "projects/debian-cloud/global/images/family/debian-13",
        foundation: gcpFoundation(input.connectionId, input.zones, input.ownership),
      }),
  );
}

function gcpFoundation(
  connectionId: string,
  _zones: readonly string[],
  ownership: ProviderOwnership,
): GcpFoundationSpec {
  const suffix = connectionId.replace(/[^a-z0-9-]/gu, "-").slice(-20);
  return {
    networkName: `intar-${suffix}`,
    subnetworkName: `intar-${suffix}-fra`,
    subnetworkRegion: "europe-west3",
    subnetworkCidr: "10.77.0.0/20",
    firewallName: `intar-${suffix}-ssh`,
    stargateEgressIpv4Cidrs: stargateEgressIpv4Cidrs(),
    ownership,
  };
}

function credentialInsert(input: {
  credentialId: string;
  connectionId: string;
  envelope: EncryptedCredentialEnvelope;
  credentialFingerprint: string;
  actorUserId: string;
  version: number;
  authority?: "active" | "cleanup_only";
  now: number;
}) {
  return {
    id: input.credentialId,
    connectionId: input.connectionId,
    version: input.version,
    authority: input.authority ?? "active",
    algorithm: input.envelope.algorithm,
    kekVersion: input.envelope.kekVersion,
    aadSha256: input.envelope.aadSha256,
    encryptedPayloadB64: input.envelope.ciphertext,
    payloadIvB64: input.envelope.ciphertextIv,
    wrappedDekB64: input.envelope.wrappedDek,
    dekIvB64: input.envelope.wrappedDekIv,
    credentialFingerprint: input.credentialFingerprint,
    createdBy: input.actorUserId,
    activatedAt: input.now,
    createdAt: input.now,
  } satisfies typeof providerCredentialVersions.$inferInsert;
}

function auditInsert(input: {
  organizationId: string;
  connectionId: string;
  actorUserId: string;
  type: string;
  payload: Record<string, unknown>;
  now: number;
}) {
  return drizzle(env.DB).insert(providerAuditEvents).values({
    id: createAppId(),
    organizationId: input.organizationId,
    connectionId: input.connectionId,
    actorUserId: input.actorUserId,
    type: input.type,
    payloadJson: input.payload,
    createdAt: input.now,
  });
}

async function requireListedConnection(
  organizationId: string,
  actorUserId: string,
  connectionId: string,
) {
  const connection = (await listProviderConnections({ organizationId, actorUserId })).find(
    (entry) => entry.id === connectionId,
  );
  if (!connection) throw corruptConnection();
  return connection;
}

async function requireHetznerDetails(connectionId: string) {
  const rows = await drizzle(env.DB)
    .select()
    .from(hetznerConnectionDetails)
    .where(eq(hetznerConnectionDetails.connectionId, connectionId))
    .limit(1);
  if (!rows[0]) throw corruptConnection();
  return rows[0];
}

async function requireGcpDetails(connectionId: string) {
  const rows = await drizzle(env.DB)
    .select()
    .from(gcpConnectionDetails)
    .where(eq(gcpConnectionDetails.connectionId, connectionId))
    .limit(1);
  if (!rows[0]) throw corruptConnection();
  return rows[0];
}

async function requireOwner(organizationId: string, actorUserId: string) {
  const role = await requireOrganizationRole({ organizationId, userId: actorUserId });
  if (role !== "owner") {
    throw appError(403, "organization_owner_required", "organization owner role required");
  }
}

function requiredCredential(value: string) {
  const result = value.trim();
  if (!result || result.length > 64 * 1024) {
    throw appError(400, "provider_credential_invalid", "provider credential is invalid");
  }
  return result;
}

function gcpProjectId(serviceAccountKeyJson: string): string {
  let value: unknown;
  try {
    value = JSON.parse(serviceAccountKeyJson);
  } catch {
    throw appError(400, "gcp_service_account_key_invalid", "GCP service-account JSON is invalid");
  }
  const projectId =
    typeof value === "object" && value !== null && "project_id" in value
      ? (value as { project_id?: unknown }).project_id
      : null;
  if (typeof projectId !== "string" || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/u.test(projectId)) {
    throw appError(400, "gcp_service_account_key_invalid", "GCP service-account project ID is invalid");
  }
  return projectId;
}

function locationsFor(
  providerKind: DirectCloudProviderKind,
  values?: readonly string[],
): string[] {
  const defaults =
    providerKind === "hetzner_cloud"
      ? DEFAULT_HETZNER_LOCATIONS
      : DEFAULT_GCP_ZONES;
  const locations = [...new Set((values ?? defaults).map((entry) => entry.trim().toLowerCase()))];
  if (
    locations.length === 0 ||
    locations.length > 10 ||
    locations.some((entry) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(entry))
  ) {
    throw appError(400, "provider_locations_invalid", "provider locations are invalid");
  }
  if (
    providerKind === "gcp_compute" &&
    locations.some((entry) => !DEFAULT_GCP_ZONES.includes(entry as (typeof DEFAULT_GCP_ZONES)[number]))
  ) {
    throw appError(400, "provider_locations_invalid", "GCP v1 supports only Frankfurt zones");
  }
  return locations;
}

function allocationLimit(value = DEFAULT_MAX_ALLOCATIONS) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 500) {
    throw appError(400, "provider_allocation_limit_invalid", "provider allocation limit is invalid");
  }
  return value;
}

function costLimit(value?: number | null) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw appError(400, "provider_cost_limit_invalid", "provider cost ceiling must use non-negative currency nanos");
  }
  return value;
}

function normalizeDisplayName(
  value: string | undefined,
  providerKind: DirectCloudProviderKind,
) {
  const result = value?.trim() || (providerKind === "hetzner_cloud" ? "Hetzner Cloud" : "GCP Compute");
  if (result.length > 80) throw appError(400, "provider_display_name_invalid", "provider display name is too long");
  return result;
}

function currency(value: string) {
  const result = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/u.test(result)) throw appError(502, "provider_currency_invalid", "provider currency is invalid");
  return result;
}

function maskFingerprint(value: string) {
  return value.length >= 8 ? `${value.slice(0, 4)}…${value.slice(-4)}` : "masked";
}

function sentinelName(connectionId: string) {
  return `intar-${connectionId.replace(/[^a-z0-9-]/gu, "-").slice(-24)}-sentinel`;
}

function positiveInteger(value: string, label: string) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw appError(500, "provider_external_id_invalid", `${label} ID is invalid`);
  }
  return result;
}

function stargateEgressIpv4Cidrs(): string[] {
  const value = (env as Cloudflare.Env & { STARGATE_EGRESS_IPV4_CIDRS?: string })
    .STARGATE_EGRESS_IPV4_CIDRS;
  const cidrs = (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (
    cidrs.length === 0 ||
    cidrs.some((entry) => !/^(?:\d{1,3}\.){3}\d{1,3}\/(?:[0-9]|[12][0-9]|3[0-2])$/u.test(entry))
  ) {
    throw appError(503, "stargate_egress_not_configured", "Stargate egress IPv4 CIDRs are not configured");
  }
  return cidrs;
}

async function stableConnectionId(
  organizationId: string,
  providerKind: DirectCloudProviderKind,
) {
  return `provider-${providerKind === "hetzner_cloud" ? "hetzner" : "gcp"}-${(
    await sha256Hex(`${providerKind}:${organizationId}`)
  ).slice(0, 24)}`;
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function corruptConnection() {
  return appError(500, "provider_connection_corrupt", "provider connection state is incomplete");
}
