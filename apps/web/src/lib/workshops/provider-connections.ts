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
import { AppError, appError } from "@/lib/app-error";
import { createAppId } from "@/lib/id";
import { requireOrganizationRole } from "@/lib/organizations";
import { withRuntimeAllocationLock } from "@/lib/runtime-allocation-lock";
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

function providerConnectionAllocationLockKey(connectionId: string): string {
  return `runtime-provider-connection:${connectionId}`;
}

function gcpProjectAllocationLockKey(projectId: string): string {
  return `runtime-provider-project:gcp_compute:${projectId.trim().toLowerCase()}`;
}

export interface ProviderConnectionRecord {
  id: string;
  organizationId: string;
  providerKind: DirectCloudProviderKind;
  displayName: string;
  state:
    | "validating"
    | "active"
    | "rotation_required"
    | "cleanup_pending"
    | "disconnected";
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
  const connectionId = await stableConnectionId(
    input.organizationId,
    input.providerKind,
  );
  const displayName = normalizeDisplayName(input.displayName, input.providerKind);
  const requestedGcpProjectId = input.providerKind === "gcp_compute"
    ? gcpProjectId(credentialText)
    : null;
  if (
    requestedGcpProjectId &&
    input.externalProjectId !== undefined &&
    input.externalProjectId !== requestedGcpProjectId
  ) {
    throw appError(
      400,
      "gcp_project_mismatch",
      "GCP key project does not match the requested project",
    );
  }

  return withRuntimeAllocationLock({
    key: providerConnectionAllocationLockKey(connectionId),
    now,
    ttlMs: 15 * 60_000,
    operation: async () => {
      await requireOwner(input.organizationId, input.actorUserId);
      const db = drizzle(env.DB);
      const existingRows = await db
        .select()
        .from(providerConnections)
        .where(
          and(
            eq(providerConnections.organizationId, input.organizationId),
            eq(providerConnections.providerKind, input.providerKind),
          ),
        )
        .limit(1);
      const existing = existingRows[0];
      if (existing) {
        if (existing.state === "disconnected") {
          throw appError(
            409,
            "provider_connection_disconnected",
            "rotate the disconnected connection credential to reconnect this provider",
          );
        }
        if (
          input.providerKind === "gcp_compute" &&
          existing.externalProjectId === requestedGcpProjectId &&
          existing.state === "active" &&
          existing.activeCredentialVersionId !== null
        ) {
          return requireListedConnection(
            input.organizationId,
            input.actorUserId,
            existing.id,
          );
        }
        const recoverableGcpAttempt =
          input.providerKind === "gcp_compute" &&
          existing.id === connectionId &&
          existing.externalProjectId === requestedGcpProjectId &&
          existing.activeCredentialVersionId === null &&
          (existing.state === "validating" ||
            existing.state === "rotation_required");
        if (!recoverableGcpAttempt) {
          throw appError(
            409,
            existing.providerKind === "gcp_compute" &&
                existing.externalProjectId !== requestedGcpProjectId
              ? "gcp_project_mismatch"
              : "provider_connection_exists",
            existing.providerKind === "gcp_compute" &&
                existing.externalProjectId !== requestedGcpProjectId
              ? "this organization already has a GCP connection for another project"
              : "this organization already has an active connection for that provider",
          );
        }
      }

      const finishConnection = async () => {
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
        const credentialFingerprint = await sha256Hex(credentialText);

        if (input.providerKind === "hetzner_cloud") {
          const connected = await invokeProviderOperation<ConnectHetznerProjectResult>(
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
          );
          const externalProjectId = `hetzner-firewall:${connected.sentinel.id}`;
          await db.batch([
            db.insert(providerConnections).values({
              id: connectionId,
              organizationId: input.organizationId,
              providerKind: input.providerKind,
              displayName,
              state: "active",
              externalProjectId,
              projectFingerprint: await sha256Hex(externalProjectId),
              activeCredentialVersionId: null,
              createdBy: input.actorUserId,
              lastValidatedAt: now,
              createdAt: now,
              updatedAt: now,
            }),
            db.insert(providerCredentialVersions).values(
              credentialInsert({
                credentialId,
                connectionId,
                envelope: connected.credential,
                credentialFingerprint,
                actorUserId: input.actorUserId,
                version: 1,
                now,
              }),
            ),
            db.insert(hetznerConnectionDetails).values({
              connectionId,
              sentinelFirewallId: String(connected.sentinel.id),
              approvedLocationsJson: locations,
              maxConcurrentAllocations,
              maxSessionCostNanos,
              nativeCurrency: currency(connected.catalog.pricing.currency),
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
          return requireListedConnection(
            input.organizationId,
            input.actorUserId,
            connectionId,
          );
        }

        const projectId = requestedGcpProjectId!;
        const foundation = gcpFoundation(connectionId, locations, ownership);
        const provisionalDetails = {
          connectionId,
          projectNumber: `pending-${connectionId}`,
          networkName: foundation.networkName,
          networkSelfLink: `pending:${foundation.networkName}`,
          subnetName: foundation.subnetworkName,
          subnetSelfLink: `pending:${foundation.subnetworkName}`,
          subnetCidr: foundation.subnetworkCidr,
          firewallName: foundation.firewallName,
          firewallSelfLink: `pending:${foundation.firewallName}`,
          approvedZonesJson: locations,
          maxConcurrentAllocations,
          maxSessionCostNanos,
          updatedAt: now,
        } satisfies typeof gcpConnectionDetails.$inferInsert;
        if (!existing) {
          await db.batch([
            db.insert(providerConnections).values({
              id: connectionId,
              organizationId: input.organizationId,
              providerKind: "gcp_compute",
              displayName,
              state: "validating",
              externalProjectId: projectId,
              projectFingerprint: await sha256Hex(`gcp:${projectId}`),
              activeCredentialVersionId: null,
              createdBy: input.actorUserId,
              lastValidatedAt: null,
              createdAt: now,
              updatedAt: now,
            }),
            db.insert(gcpConnectionDetails).values(provisionalDetails),
            auditInsert({
              organizationId: input.organizationId,
              connectionId,
              actorUserId: input.actorUserId,
              type: "provider.connection_validation_started",
              payload: { providerKind: input.providerKind, externalProjectId: projectId },
              now,
            }),
          ]);
        } else {
          await db.batch([
            db
              .update(providerConnections)
              .set({
                displayName,
                state: "validating",
                lastValidatedAt: null,
                updatedAt: now,
              })
              .where(eq(providerConnections.id, connectionId)),
            db
              .insert(gcpConnectionDetails)
              .values(provisionalDetails)
              .onConflictDoUpdate({
                target: gcpConnectionDetails.connectionId,
                set: {
                  approvedZonesJson: locations,
                  maxConcurrentAllocations,
                  maxSessionCostNanos,
                  updatedAt: now,
                },
              }),
            auditInsert({
              organizationId: input.organizationId,
              connectionId,
              actorUserId: input.actorUserId,
              type: "provider.connection_validation_resumed",
              payload: { providerKind: input.providerKind, externalProjectId: projectId },
              now,
            }),
          ]);
        }

        try {
          const connected = await connectGcp({
            connectionId,
            credentialId,
            organizationId: input.organizationId,
            serviceAccountKeyJson: credentialText,
            expectedProjectId: projectId,
            zones: locations,
            ownership,
          });
          if (connected.identity.projectId !== projectId) {
            throw appError(
              502,
              "gcp_project_mismatch",
              "GCP returned a different project identity",
            );
          }
          await db.batch([
            db.insert(providerCredentialVersions).values(
              credentialInsert({
                credentialId,
                connectionId,
                envelope: connected.credential,
                credentialFingerprint,
                actorUserId: input.actorUserId,
                version: 1,
                now,
              }),
            ),
            db
              .update(gcpConnectionDetails)
              .set({
                projectNumber: connected.identity.projectNumber,
                networkName: connected.foundation.network.name,
                networkSelfLink: connected.foundation.network.selfLink,
                subnetName: connected.foundation.subnetwork.name,
                subnetSelfLink: connected.foundation.subnetwork.selfLink,
                subnetCidr: foundation.subnetworkCidr,
                firewallName: connected.foundation.firewall.name,
                firewallSelfLink: connected.foundation.firewall.selfLink,
                approvedZonesJson: locations,
                maxConcurrentAllocations,
                maxSessionCostNanos,
                updatedAt: now,
              })
              .where(eq(gcpConnectionDetails.connectionId, connectionId)),
            db
              .update(providerConnections)
              .set({
                state: "active",
                projectFingerprint: await sha256Hex(
                  `gcp:${connected.identity.projectNumber}`,
                ),
                activeCredentialVersionId: credentialId,
                lastValidatedAt: now,
                updatedAt: now,
              })
              .where(eq(providerConnections.id, connectionId)),
            auditInsert({
              organizationId: input.organizationId,
              connectionId,
              actorUserId: input.actorUserId,
              type: "provider.connection_created",
              payload: { providerKind: input.providerKind, externalProjectId: projectId },
              now,
            }),
          ]);
        } catch (error) {
          await persistConnectionValidationFailure({
            organizationId: input.organizationId,
            connectionId,
            actorUserId: input.actorUserId,
            providerKind: input.providerKind,
            error,
            now,
          });
          throw error;
        }
        return requireListedConnection(
          input.organizationId,
          input.actorUserId,
          connectionId,
        );
      };
      if (requestedGcpProjectId) {
        return withRuntimeAllocationLock({
          key: gcpProjectAllocationLockKey(requestedGcpProjectId),
          now,
          ttlMs: 15 * 60_000,
          operation: async () => {
            await requireOwner(input.organizationId, input.actorUserId);
            const claims = await db
              .select({
                id: providerConnections.id,
                activeCredentialVersionId:
                  providerConnections.activeCredentialVersionId,
                projectNumber: gcpConnectionDetails.projectNumber,
              })
              .from(providerConnections)
              .leftJoin(
                gcpConnectionDetails,
                eq(gcpConnectionDetails.connectionId, providerConnections.id),
              )
              .where(
                and(
                  eq(providerConnections.providerKind, "gcp_compute"),
                  eq(
                    providerConnections.externalProjectId,
                    requestedGcpProjectId,
                  ),
                ),
              );
            const competingProvenClaim = claims.find(
              (claim) =>
                claim.id !== connectionId &&
                (claim.activeCredentialVersionId !== null ||
                  (claim.projectNumber !== null &&
                    !claim.projectNumber.startsWith("pending-"))),
            );
            if (competingProvenClaim) {
              throw appError(
                409,
                "gcp_project_already_connected",
                "this GCP project is already connected to an organization",
              );
            }
            return finishConnection();
          },
        });
      }
      return finishConnection();
    },
  });
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
  const initialConnection = await requireConnection(
    input.organizationId,
    input.connectionId,
  );
  const now = input.now ?? Date.now();
  return withRuntimeAllocationLock({
    key: providerConnectionAllocationLockKey(initialConnection.id),
    now,
    operation: async () => {
      // Re-read every mutable connection input after acquiring the same lock
      // used by allocation. Rotation can change whether this connection is
      // issuance-ready, so it must be serialized with seat claims.
      await requireOwner(input.organizationId, input.actorUserId);
      const connection = await requireConnection(
        input.organizationId,
        input.connectionId,
      );
      const reconnecting = connection.state === "disconnected";
      const previous = reconnecting
        ? await loadCredentialVersion(connection)
        : await loadActiveCredential(connection);
      const raw = requiredCredential(input.credential);
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
              sentinelId: positiveInteger(
                details.sentinelFirewallId,
                "sentinel firewall",
              ),
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
      return requireListedConnection(
        input.organizationId,
        input.actorUserId,
        connection.id,
      );
    },
  });
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
  const initialConnection = await requireConnection(
    input.organizationId,
    input.connectionId,
  );
  const now = input.now ?? Date.now();
  return withRuntimeAllocationLock({
    key: providerConnectionAllocationLockKey(initialConnection.id),
    now,
    operation: async () => {
      await requireOwner(input.organizationId, input.actorUserId);
      const connection = await requireConnection(
        input.organizationId,
        input.connectionId,
      );
      const locations = locationsFor(
        connection.providerKind,
        input.approvedLocations,
      );
      const db = drizzle(env.DB);
      const audit = db.insert(providerAuditEvents).values({
        id: createAppId(),
        organizationId: input.organizationId,
        connectionId: connection.id,
        actorUserId: input.actorUserId,
        type: "provider.guardrails_updated",
        payloadJson: { providerKind: connection.providerKind },
        createdAt: now,
      });
      if (connection.providerKind === "hetzner_cloud") {
        const current = await requireHetznerDetails(connection.id);
        await db.batch([
          db
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
            .where(eq(hetznerConnectionDetails.connectionId, connection.id)),
          audit,
        ]);
      } else {
        const current = await requireGcpDetails(connection.id);
        await db.batch([
          db
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
            .where(eq(gcpConnectionDetails.connectionId, connection.id)),
          audit,
        ]);
      }
      return requireListedConnection(
        input.organizationId,
        input.actorUserId,
        connection.id,
      );
    },
  });
}

export async function inspectProviderConnection(input: {
  organizationId: string;
  connectionId: string;
  actorUserId: string;
}) {
  await requireOwner(input.organizationId, input.actorUserId);
  const initialConnection = await requireConnection(
    input.organizationId,
    input.connectionId,
  );
  return withRuntimeAllocationLock({
    key: providerConnectionAllocationLockKey(initialConnection.id),
    operation: async () => {
      await requireOwner(input.organizationId, input.actorUserId);
      const connection = await requireConnection(
        input.organizationId,
        input.connectionId,
      );
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
      let result: { data: unknown };
      let observedAuthority = credential.authority;
      try {
        if (connection.providerKind === "hetzner_cloud") {
          result = await invokeProviderOperation("hetzner_cloud", (binding) =>
            binding.runOperation({
              ...common,
              operation: { kind: "inventory" },
            }),
          );
        } else {
          result = await invokeProviderOperation(
            "gcp_compute",
            async (binding) => {
              const detail = await requireGcpDetails(connection.id);
              const zones = locationsFor(
                "gcp_compute",
                detail.approvedZonesJson,
              );
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
                    zones,
                    ownership,
                  ),
                  zones,
                },
              });
            },
          );
          observedAuthority = gcpInspectionAuthority(result.data);
        }
      } catch (error) {
        if (credential.authority === "active") {
          await persistConnectionValidationFailure({
            organizationId: input.organizationId,
            connectionId: connection.id,
            actorUserId: input.actorUserId,
            providerKind: connection.providerKind,
            error,
            now: Date.now(),
          });
        }
        throw error;
      }
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
      const resources =
        allocations.length === 0
          ? []
          : await db
              .select({
                id: runtimeProviderResources.id,
                allocationId: runtimeProviderResources.allocationId,
                resourceKind: runtimeProviderResources.resourceKind,
                providerResourceId:
                  runtimeProviderResources.providerResourceId,
                locationAttempt: runtimeProviderResources.locationAttempt,
                location: runtimeProviderResources.location,
                providerState: runtimeProviderResources.providerState,
                disappearanceConfirmedAt:
                  runtimeProviderResources.disappearanceConfirmedAt,
              })
              .from(runtimeProviderResources)
              .where(
                inArray(
                  runtimeProviderResources.allocationId,
                  allocations.map((allocation) => allocation.id),
                ),
              );
      const runtimeAllocations = allocations.map((allocation) => ({
        ...allocation,
        resources: resources.filter(
          (resource) => resource.allocationId === allocation.id,
        ),
      }));
      const hasLiveAllocations =
        (await countLiveProviderAllocations(connection.id)) > 0;
      const nextState =
        observedAuthority === "active"
          ? "active"
          : hasLiveAllocations
            ? "cleanup_pending"
            : "rotation_required";
      const observedAt = Date.now();
      await db.batch([
        db
          .update(providerConnections)
          .set({
            state: nextState,
            lastValidatedAt: observedAt,
            updatedAt: observedAt,
          })
          .where(eq(providerConnections.id, connection.id)),
        db
          .update(providerCredentialVersions)
          .set({ authority: observedAuthority })
          .where(
            and(
              eq(providerCredentialVersions.id, credential.id),
              eq(providerCredentialVersions.connectionId, connection.id),
            ),
          ),
        auditInsert({
          organizationId: input.organizationId,
          connectionId: connection.id,
          actorUserId: input.actorUserId,
          type:
            observedAuthority === "active"
              ? "provider.connection_validation_succeeded"
              : "provider.connection_cleanup_inspected",
          payload: {
            providerKind: connection.providerKind,
            authority: observedAuthority,
            previousAuthority: credential.authority,
          },
          now: observedAt,
        }),
      ]);
      return {
        connectionId: connection.id,
        providerKind: connection.providerKind,
        observedAt,
        data: result.data,
        runtimeAllocations,
      };
    },
  });
}

function gcpInspectionAuthority(data: unknown): "active" | "cleanup_only" {
  const validation =
    typeof data === "object" && data !== null && "validation" in data
      ? data.validation
      : null;
  const authority =
    typeof validation === "object" &&
    validation !== null &&
    "authority" in validation
      ? validation.authority
      : null;
  if (authority === "active" || authority === "cleanup_only") {
    return authority;
  }
  throw appError(
    502,
    "gcp_inspection_result_invalid",
    "GCP inspection did not return credential authority",
  );
}

export async function disconnectProviderConnection(input: {
  organizationId: string;
  connectionId: string;
  actorUserId: string;
  now?: number;
}): Promise<ProviderConnectionRecord> {
  await requireOwner(input.organizationId, input.actorUserId);
  const initialConnection = await requireConnection(
    input.organizationId,
    input.connectionId,
  );
  const now = input.now ?? Date.now();
  return withRuntimeAllocationLock({
    key: providerConnectionAllocationLockKey(initialConnection.id),
    now,
    operation: async () => {
      await requireOwner(input.organizationId, input.actorUserId);
      const connection = await requireConnection(
        input.organizationId,
        input.connectionId,
      );
      const live = await countLiveProviderAllocations(connection.id);
      if (live > 0) {
        throw appError(
          409,
          "provider_cleanup_required",
          "provider resources must be deleted before disconnecting",
        );
      }
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
      return requireListedConnection(
        input.organizationId,
        input.actorUserId,
        connection.id,
      );
    },
  });
}

export async function abandonProviderConnectionAttempt(input: {
  organizationId: string;
  connectionId: string;
  actorUserId: string;
  manualCleanupAcknowledged: boolean;
  now?: number;
}): Promise<{
  abandoned: true;
  connectionId: string;
  externalProjectId: string;
  manualCleanupAcknowledged: true;
}> {
  await requireOwner(input.organizationId, input.actorUserId);
  if (!input.manualCleanupAcknowledged) {
    throw appError(
      400,
      "provider_manual_cleanup_acknowledgement_required",
      "confirm manual cleanup before abandoning the failed connection attempt",
    );
  }
  const initialConnection = await requireConnection(
    input.organizationId,
    input.connectionId,
  );
  const now = input.now ?? Date.now();
  return withRuntimeAllocationLock({
    key: providerConnectionAllocationLockKey(initialConnection.id),
    now,
    operation: async () => {
      await requireOwner(input.organizationId, input.actorUserId);
      const connection = await requireConnection(
        input.organizationId,
        input.connectionId,
      );
      if (
        connection.providerKind !== "gcp_compute" ||
        connection.activeCredentialVersionId !== null ||
        (connection.state !== "validating" &&
          connection.state !== "rotation_required")
      ) {
        throw appError(
          409,
          "provider_connection_attempt_not_abandonable",
          "only an incomplete GCP validation attempt can be abandoned",
        );
      }
      if (await countLiveProviderAllocations(connection.id)) {
        throw appError(
          409,
          "provider_cleanup_required",
          "provider resources must be deleted before abandoning the connection attempt",
        );
      }
      const db = drizzle(env.DB);
      const credentials = await db
        .select({ value: count() })
        .from(providerCredentialVersions)
        .where(eq(providerCredentialVersions.connectionId, connection.id));
      if ((credentials[0]?.value ?? 0) !== 0) {
        throw appError(
          409,
          "provider_connection_attempt_not_abandonable",
          "a connection attempt with stored credentials cannot be abandoned",
        );
      }
      const details = await requireGcpDetails(connection.id);
      await db.batch([
        auditInsert({
          organizationId: input.organizationId,
          connectionId: connection.id,
          actorUserId: input.actorUserId,
          type: "provider.connection_validation_abandoned",
          payload: {
            providerKind: connection.providerKind,
            connectionId: connection.id,
            externalProjectId: connection.externalProjectId,
            networkName: details.networkName,
            subnetName: details.subnetName,
            firewallName: details.firewallName,
            manualCleanupAcknowledged: true,
          },
          now,
        }),
        db
          .update(providerAuditEvents)
          .set({ connectionId: null })
          .where(eq(providerAuditEvents.connectionId, connection.id)),
        db
          .delete(gcpConnectionDetails)
          .where(eq(gcpConnectionDetails.connectionId, connection.id)),
        db
          .delete(providerConnections)
          .where(eq(providerConnections.id, connection.id)),
      ]);
      return {
        abandoned: true,
        connectionId: connection.id,
        externalProjectId: connection.externalProjectId,
        manualCleanupAcknowledged: true,
      };
    },
  });
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

export function gcpFoundation(
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

async function persistConnectionValidationFailure(input: {
  organizationId: string;
  connectionId: string;
  actorUserId: string;
  providerKind: DirectCloudProviderKind;
  error: unknown;
  now: number;
}): Promise<void> {
  const errorCode = input.error instanceof AppError
    ? input.error.code
    : "provider_connection_validation_failed";
  const db = drizzle(env.DB);
  await db.batch([
    db
      .update(providerConnections)
      .set({
        state: "rotation_required",
        lastValidatedAt: input.now,
        updatedAt: input.now,
      })
      .where(eq(providerConnections.id, input.connectionId)),
    auditInsert({
      organizationId: input.organizationId,
      connectionId: input.connectionId,
      actorUserId: input.actorUserId,
      type: "provider.connection_validation_failed",
      payload: {
        providerKind: input.providerKind,
        errorCode,
      },
      now: input.now,
    }),
  ]);
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
  if (typeof projectId !== "string" || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(projectId)) {
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
    cidrs.length > 32 ||
    new Set(cidrs).size !== cidrs.length ||
    cidrs.some((entry) => !validIpv4HostCidr(entry))
  ) {
    throw appError(503, "stargate_egress_not_configured", "Stargate egress IPv4 CIDRs are not configured");
  }
  return cidrs;
}

function validIpv4HostCidr(value: string): boolean {
  if (!value.endsWith("/32")) return false;
  const octets = value.slice(0, -3).split(".");
  return octets.length === 4 && octets.every((octet) => {
    if (!/^\d{1,3}$/u.test(octet)) return false;
    const number = Number(octet);
    return number >= 0 && number <= 255 && String(number) === octet;
  });
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
