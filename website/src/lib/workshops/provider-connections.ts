import { env } from "cloudflare:workers";
import { and, count, desc, eq, inArray, isNull, max, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type {
  CatalogObservation,
  CredentialContext,
  EncryptedCredentialEnvelope,
  OwnershipLabels,
} from "../../../../hcloud-provider-worker/src/contracts";
import {
  hetznerAllocations,
  organizationProviderConnections,
  providerAuditEvents,
  providerCredentialVersions,
  runtimeExecutions,
  workshopSessionCostSummaries,
  workshopSessionRuntimeProviders,
  workshopSessions,
  workshopWorkspaces,
} from "@/db/schema";
import { appError } from "@/lib/app-error";
import { createAppId } from "@/lib/id";
import { requireOrganizationRole } from "@/lib/organizations";
import {
  credentialEnvelopeFromStorage,
  credentialEnvelopeStorage,
  hcloudConnectProject,
  hcloudRotateCredential,
  hcloudRunOperation,
} from "@/lib/hcloud-provider-service";
import { requireWorkshopHcloudRuntimeEnabledForOrganization } from "./feature-flag";

const DEFAULT_LOCATIONS = ["nbg1", "fsn1", "hel1"] as const;
const DEFAULT_MAX_SERVERS = 5;

export interface HetznerProviderConnectionRecord {
  id: string;
  organizationId: string;
  providerKind: "hetzner_cloud";
  displayName: string;
  state: "active" | "rotation_required" | "cleanup_pending" | "disconnected";
  approvedLocations: string[];
  maxConcurrentServers: number;
  maxSessionGrossMicros: number | null;
  currency: string;
  ipv4Enabled: true;
  sentinelFirewallId: string;
  credential: {
    version: number;
    fingerprint: string;
    activatedAt: number;
  } | null;
  lastValidatedAt: number;
  createdAt: number;
  updatedAt: number;
  cleanupAcknowledgement: {
    acknowledgedAt: number;
    acknowledgedBy: string;
    verified: false;
  } | null;
  /** Owner-only manual-cleanup inventory. Never projected to admins. */
  cleanupResources?: HetznerManualCleanupResource[];
}

export interface HetznerManualCleanupResource {
  allocationId: string;
  executionId: string;
  deterministicName: string;
  state: string;
  serverId: string | null;
  primaryIpId: string | null;
  primaryIpv4: string | null;
  sshKeyId: string | null;
  createActionId: string | null;
  deleteActionId: string | null;
  deletionConfirmedAt: number | null;
}

export interface HetznerManualCleanupAcknowledgement {
  acknowledgedAt: number;
  verified: false;
  sentinelFirewallId: string;
  resources: HetznerManualCleanupResource[];
}

export async function connectHetznerProject(input: {
  organizationId: string;
  actorUserId: string;
  token: string;
  displayName?: string;
  approvedLocations?: readonly string[];
  maxConcurrentServers?: number;
  maxSessionGrossMicros?: number | null;
  requiredServerTypes?: readonly string[];
  systemImage?: string;
  now?: number;
}): Promise<HetznerProviderConnectionRecord> {
  await requireOwner(input.organizationId, input.actorUserId);
  await requireWorkshopHcloudRuntimeEnabledForOrganization(
    input.organizationId,
  );
  const db = drizzle(env.DB);
  const existing = await db
    .select({ id: organizationProviderConnections.id })
    .from(organizationProviderConnections)
    .where(
      and(
        eq(
          organizationProviderConnections.organizationId,
          input.organizationId,
        ),
        eq(organizationProviderConnections.providerKind, "hetzner_cloud"),
      ),
    )
    .limit(1);
  if (existing[0]) {
    throw appError(
      409,
      "provider_connection_exists",
      "this organization already has a Hetzner provider connection",
    );
  }
  const token = providerToken(input.token);
  const now = input.now ?? Date.now();
  // Connection setup performs the provider write before the encrypted token can
  // be persisted. A stable ID makes an ambiguous first connection retry target
  // the same DO, sentinel name, and ownership labels instead of leaking a
  // second firewall into the dedicated project.
  const connectionId = `hcloud-${(
    await sha256Hex(`intar:hcloud:${input.organizationId}`)
  ).slice(0, 32)}`;
  const credentialId = createAppId();
  const locations = approvedLocations(input.approvedLocations);
  const maxConcurrentServers = serverLimit(input.maxConcurrentServers);
  const maxSessionGrossMicros = costLimit(input.maxSessionGrossMicros);
  const requiredServerTypes = input.requiredServerTypes?.length
    ? providerNames(input.requiredServerTypes, "server type")
    : [];
  const systemImage = providerName(input.systemImage ?? "debian-13", "image");
  const ownership = await ownershipLabels(input.organizationId, connectionId);
  const sentinelName = `intar-${connectionId.slice(0, 20)}-sentinel`;
  const credentialContext: CredentialContext = {
    organizationId: input.organizationId,
    connectionId,
    credentialId,
    provider: "hetzner_cloud",
    version: 1,
  };
  const connected = await hcloudConnectProject({
    requestId: createAppId(),
    connectionId,
    credentialContext,
    token,
    sentinel: {
      name: sentinelName,
      ownership,
      stargateEgressIpv4Cidrs: stargateEgressIpv4Cidrs(),
    },
    requiredServerTypes,
    permittedLocations: locations,
    systemImage,
  });
  const credential = credentialEnvelopeStorage(connected.credential);
  const fingerprint = await sha256Hex(token);
  const projectFingerprint = await sha256Hex(
    `hcloud-sentinel:${connected.sentinel.id}`,
  );
  const currency = billingCurrency(connected.catalog.pricing.currency);
  const displayName = connectionDisplayName(input.displayName);
  await db.batch([
    db.insert(organizationProviderConnections).values({
      id: connectionId,
      organizationId: input.organizationId,
      providerKind: "hetzner_cloud",
      displayName,
      state: "active",
      projectFingerprint,
      sentinelFirewallId: String(connected.sentinel.id),
      activeCredentialVersionId: credentialId,
      approvedLocationsJson: locations,
      maxConcurrentServers,
      maxSessionGrossMicros,
      currency,
      ipv4Enabled: true,
      lastValidatedAt: now,
      createdBy: input.actorUserId,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(providerCredentialVersions).values({
      id: credentialId,
      connectionId,
      version: 1,
      ...credential,
      tokenFingerprint: fingerprint,
      createdBy: input.actorUserId,
      activatedAt: now,
      createdAt: now,
    }),
    db.insert(providerAuditEvents).values({
      id: createAppId(),
      organizationId: input.organizationId,
      connectionId,
      actorUserId: input.actorUserId,
      type: "provider.connection.created",
      payloadJson: {
        provider: "hetzner_cloud",
        sentinelFirewallId: String(connected.sentinel.id),
        approvedLocations: locations,
        requiredServerTypes,
        systemImage,
        canonicalWriteCount: connected.canonicalWrites.length,
      },
      createdAt: now,
    }),
  ]);
  return {
    id: connectionId,
    organizationId: input.organizationId,
    providerKind: "hetzner_cloud",
    displayName,
    state: "active",
    approvedLocations: locations,
    maxConcurrentServers,
    maxSessionGrossMicros,
    currency,
    ipv4Enabled: true,
    sentinelFirewallId: String(connected.sentinel.id),
    credential: {
      version: 1,
      fingerprint: maskedTokenFingerprint(fingerprint),
      activatedAt: now,
    },
    lastValidatedAt: now,
    createdAt: now,
    updatedAt: now,
    cleanupAcknowledgement: null,
    cleanupResources: [],
  };
}

export async function rotateHetznerCredential(input: {
  organizationId: string;
  connectionId: string;
  actorUserId: string;
  token: string;
  now?: number;
}): Promise<HetznerProviderConnectionRecord> {
  await requireOwner(input.organizationId, input.actorUserId);
  const now = input.now ?? Date.now();
  const connection = await requireConnection(
    input.organizationId,
    input.connectionId,
  );
  if (connection.state === "disconnected") {
    throw appError(
      409,
      "provider_connection_disconnected",
      "a disconnected provider connection cannot be rotated",
    );
  }
  // Disabling issuance is a rollback fence, not a cleanup kill switch. Owners
  // must still be able to restore a revoked credential and delete accumulating
  // resources while this connection remains cleanup-pending.
  if (connection.state !== "cleanup_pending") {
    await requireWorkshopHcloudRuntimeEnabledForOrganization(
      input.organizationId,
    );
  }
  const token = providerToken(input.token);
  if (!connection.activeCredentialVersionId) {
    throw appError(
      409,
      "provider_credential_unavailable",
      "provider connection has no active credential",
    );
  }
  const previousCredentialId = connection.activeCredentialVersionId;
  const db = drizzle(env.DB);
  const versionRows = await db
    .select({ version: max(providerCredentialVersions.version) })
    .from(providerCredentialVersions)
    .where(eq(providerCredentialVersions.connectionId, connection.id));
  const version = (versionRows[0]?.version ?? 0) + 1;
  const credentialId = createAppId();
  const credentialContext: CredentialContext = {
    organizationId: input.organizationId,
    connectionId: connection.id,
    credentialId,
    provider: "hetzner_cloud",
    version,
  };
  const ownership = await ownershipLabels(input.organizationId, connection.id);
  const rotated = await hcloudRotateCredential({
    requestId: createAppId(),
    connectionId: connection.id,
    credentialContext,
    token,
    sentinelId: providerInteger(
      connection.sentinelFirewallId,
      "sentinel firewall",
    ),
    sentinelName: `intar-${connection.id.slice(0, 20)}-sentinel`,
    ownership,
  });
  const fingerprint = await sha256Hex(token);
  await db.batch([
    db.insert(providerCredentialVersions).values({
      id: credentialId,
      connectionId: connection.id,
      version,
      ...credentialEnvelopeStorage(rotated.credential),
      tokenFingerprint: fingerprint,
      createdBy: input.actorUserId,
      activatedAt: now,
      createdAt: now,
    }),
    db
      .update(providerCredentialVersions)
      .set({ supersededAt: now })
      .where(
        and(
          eq(providerCredentialVersions.connectionId, connection.id),
          ne(providerCredentialVersions.id, credentialId),
          eq(providerCredentialVersions.id, previousCredentialId),
        ),
      ),
    db
      .update(organizationProviderConnections)
      .set({
        activeCredentialVersionId: credentialId,
        // Rotation restores provider access, but it must not silently clear a
        // cleanup fence while billed resources are still unconfirmed. The
        // archive reconciler is the only path allowed to reactivate such a
        // connection after every allocation has confirmed deletion.
        state:
          connection.state === "cleanup_pending" ? "cleanup_pending" : "active",
        lastValidatedAt: now,
        updatedAt: now,
      })
      .where(eq(organizationProviderConnections.id, connection.id)),
    db.insert(providerAuditEvents).values({
      id: createAppId(),
      organizationId: input.organizationId,
      connectionId: connection.id,
      actorUserId: input.actorUserId,
      type: "provider.credential.rotated",
      payloadJson: {
        version,
        canonicalWriteCount: rotated.canonicalWrites.length,
      },
      createdAt: now,
    }),
  ]);
  return (
    await listHetznerProviderConnections({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
    })
  ).find((entry) => entry.id === connection.id)!;
}

export async function listHetznerProviderConnections(input: {
  organizationId: string;
  actorUserId: string;
}): Promise<HetznerProviderConnectionRecord[]> {
  const role = await requireOrganizationRole({
    organizationId: input.organizationId,
    userId: input.actorUserId,
    admin: true,
  });
  const rows = await drizzle(env.DB)
    .select({
      connection: organizationProviderConnections,
      credentialVersion: providerCredentialVersions.version,
      credentialFingerprint: providerCredentialVersions.tokenFingerprint,
      credentialActivatedAt: providerCredentialVersions.activatedAt,
    })
    .from(organizationProviderConnections)
    .leftJoin(
      providerCredentialVersions,
      eq(
        providerCredentialVersions.id,
        organizationProviderConnections.activeCredentialVersionId,
      ),
    )
    .where(
      and(
        eq(
          organizationProviderConnections.organizationId,
          input.organizationId,
        ),
        eq(organizationProviderConnections.providerKind, "hetzner_cloud"),
      ),
    )
    .orderBy(desc(organizationProviderConnections.createdAt));
  return Promise.all(
    rows.map(async ({ connection, ...credential }) => ({
      id: connection.id,
      organizationId: connection.organizationId,
      providerKind: "hetzner_cloud" as const,
      displayName: connection.displayName,
      state: connection.state,
      approvedLocations: connection.approvedLocationsJson,
      maxConcurrentServers: connection.maxConcurrentServers,
      maxSessionGrossMicros: connection.maxSessionGrossMicros,
      currency: connection.currency,
      ipv4Enabled: true as const,
      sentinelFirewallId: connection.sentinelFirewallId,
      credential:
        credential.credentialVersion === null ||
        credential.credentialFingerprint === null ||
        credential.credentialActivatedAt === null
          ? null
          : {
              version: credential.credentialVersion,
              fingerprint: maskedTokenFingerprint(
                credential.credentialFingerprint,
              ),
              activatedAt: credential.credentialActivatedAt,
            },
      lastValidatedAt: connection.lastValidatedAt,
      createdAt: connection.createdAt,
      updatedAt: connection.updatedAt,
      cleanupAcknowledgement:
        connection.cleanupAcknowledgedAt === null ||
        connection.cleanupAcknowledgedBy === null
          ? null
          : {
              acknowledgedAt: connection.cleanupAcknowledgedAt,
              acknowledgedBy: connection.cleanupAcknowledgedBy,
              verified: false as const,
            },
      ...(role === "owner"
        ? { cleanupResources: await unconfirmedAllocations(connection.id) }
        : {}),
    })),
  );
}

export async function updateHetznerProviderGuardrails(input: {
  organizationId: string;
  connectionId: string;
  actorUserId: string;
  approvedLocations?: readonly string[];
  maxConcurrentServers?: number;
  maxSessionGrossMicros?: number | null;
  now?: number;
}): Promise<HetznerProviderConnectionRecord> {
  await requireOwner(input.organizationId, input.actorUserId);
  await requireWorkshopHcloudRuntimeEnabledForOrganization(
    input.organizationId,
  );
  if (
    input.approvedLocations === undefined &&
    input.maxConcurrentServers === undefined &&
    input.maxSessionGrossMicros === undefined
  ) {
    throw appError(
      400,
      "provider_guardrails_empty",
      "at least one provider guardrail must be supplied",
    );
  }
  const connection = await requireConnection(
    input.organizationId,
    input.connectionId,
  );
  if (connection.state !== "active") {
    throw appError(
      409,
      "provider_connection_inactive",
      "only an active provider connection can be updated",
    );
  }
  const locations =
    input.approvedLocations === undefined
      ? connection.approvedLocationsJson
      : approvedLocations(input.approvedLocations);
  const maxConcurrentServers =
    input.maxConcurrentServers === undefined
      ? connection.maxConcurrentServers
      : serverLimit(input.maxConcurrentServers);
  const maxSessionGrossMicros =
    input.maxSessionGrossMicros === undefined
      ? connection.maxSessionGrossMicros
      : costLimit(input.maxSessionGrossMicros);
  const liveAllocations = await countLiveHetznerAllocations(connection.id);
  if (maxConcurrentServers < liveAllocations) {
    throw appError(
      409,
      "provider_server_limit_below_active_allocations",
      "provider concurrent server limit cannot be lower than active allocations",
    );
  }
  if (!sameStrings(locations, connection.approvedLocationsJson)) {
    const active = await loadActiveCredential(connection);
    await hcloudRunOperation({
      requestId: createAppId(),
      connectionId: connection.id,
      credentialContext: active.context,
      credential: active.envelope,
      operation: {
        kind: "catalog",
        requiredServerTypes: [],
        permittedLocations: locations,
        systemImage: "debian-13",
      },
    });
  }
  const now = input.now ?? Date.now();
  const db = drizzle(env.DB);
  const connectionUpdate = db
    .update(organizationProviderConnections)
    .set({
      approvedLocationsJson: locations,
      maxConcurrentServers,
      maxSessionGrossMicros,
      lastValidatedAt: now,
      updatedAt: now,
    })
    .where(eq(organizationProviderConnections.id, connection.id));
  const eventInsert = db.insert(providerAuditEvents).values({
    id: createAppId(),
    organizationId: input.organizationId,
    connectionId: connection.id,
    actorUserId: input.actorUserId,
    type: "provider.connection.guardrails_updated",
    payloadJson: {
      previous: {
        approvedLocations: connection.approvedLocationsJson,
        maxConcurrentServers: connection.maxConcurrentServers,
        maxSessionGrossMicros: connection.maxSessionGrossMicros,
      },
      current: {
        approvedLocations: locations,
        maxConcurrentServers,
        maxSessionGrossMicros,
      },
    },
    createdAt: now,
  });
  if (maxSessionGrossMicros !== connection.maxSessionGrossMicros) {
    // A previous owner override was made against a different numeric ceiling.
    // Never carry it across a mutable guardrail change.
    await db.batch([
      connectionUpdate,
      db
        .update(workshopSessionRuntimeProviders)
        .set({
          grossCeilingOverrideAt: null,
          grossCeilingOverrideBy: null,
          updatedAt: now,
        })
        .where(eq(workshopSessionRuntimeProviders.connectionId, connection.id)),
      eventInsert,
    ]);
  } else {
    await db.batch([connectionUpdate, eventInsert]);
  }
  return requireListedConnection(
    input.organizationId,
    input.actorUserId,
    connection.id,
  );
}

/**
 * Connects a new empty Hetzner project to a connection that was previously
 * disconnected. A fresh provider token is required; this is deliberately not
 * credential rotation because the project identity is allowed to change.
 */
export async function rebindHetznerProject(input: {
  organizationId: string;
  connectionId: string;
  actorUserId: string;
  token: string;
  approvedLocations?: readonly string[];
  maxConcurrentServers?: number;
  maxSessionGrossMicros?: number | null;
  requiredServerTypes?: readonly string[];
  systemImage?: string;
  now?: number;
}): Promise<HetznerProviderConnectionRecord> {
  await requireOwner(input.organizationId, input.actorUserId);
  await requireWorkshopHcloudRuntimeEnabledForOrganization(
    input.organizationId,
  );
  const connection = await requireConnection(
    input.organizationId,
    input.connectionId,
  );
  if (connection.state !== "disconnected") {
    throw appError(
      409,
      "provider_connection_not_disconnected",
      "only a disconnected provider connection can be rebound",
    );
  }
  const pending = await unconfirmedAllocations(connection.id);
  if (pending.length > 0) {
    throw appError(
      409,
      "provider_cleanup_not_confirmed",
      "all learner resources must have confirmed deletion before rebinding",
    );
  }
  const token = providerToken(input.token);
  const fingerprint = await sha256Hex(token);
  const db = drizzle(env.DB);
  const reused = await db
    .select({ id: providerCredentialVersions.id })
    .from(providerCredentialVersions)
    .where(
      and(
        eq(providerCredentialVersions.connectionId, connection.id),
        eq(providerCredentialVersions.tokenFingerprint, fingerprint),
      ),
    )
    .limit(1);
  if (reused[0]) {
    throw appError(
      409,
      "provider_token_reused",
      "a fresh Hetzner API token is required when rebinding a project",
    );
  }
  const now = input.now ?? Date.now();
  const locations =
    input.approvedLocations === undefined
      ? connection.approvedLocationsJson
      : approvedLocations(input.approvedLocations);
  const maxConcurrentServers =
    input.maxConcurrentServers === undefined
      ? connection.maxConcurrentServers
      : serverLimit(input.maxConcurrentServers);
  const maxSessionGrossMicros =
    input.maxSessionGrossMicros === undefined
      ? connection.maxSessionGrossMicros
      : costLimit(input.maxSessionGrossMicros);
  const requiredServerTypes = input.requiredServerTypes?.length
    ? providerNames(input.requiredServerTypes, "server type")
    : [];
  const systemImage = providerName(input.systemImage ?? "debian-13", "image");
  const versionRows = await db
    .select({ version: max(providerCredentialVersions.version) })
    .from(providerCredentialVersions)
    .where(eq(providerCredentialVersions.connectionId, connection.id));
  const version = (versionRows[0]?.version ?? 0) + 1;
  const credentialId = createAppId();
  const ownership = await ownershipLabels(input.organizationId, connection.id);
  const credentialContext: CredentialContext = {
    organizationId: input.organizationId,
    connectionId: connection.id,
    credentialId,
    provider: "hetzner_cloud",
    version,
  };
  const connected = await hcloudConnectProject({
    requestId: createAppId(),
    connectionId: connection.id,
    credentialContext,
    token,
    sentinel: {
      name: `intar-${connection.id.slice(0, 20)}-sentinel`,
      ownership,
      stargateEgressIpv4Cidrs: stargateEgressIpv4Cidrs(),
    },
    requiredServerTypes,
    permittedLocations: locations,
    systemImage,
  });
  const projectFingerprint = await sha256Hex(
    `hcloud-sentinel:${connected.sentinel.id}`,
  );
  await db.batch([
    db.insert(providerCredentialVersions).values({
      id: credentialId,
      connectionId: connection.id,
      version,
      ...credentialEnvelopeStorage(connected.credential),
      tokenFingerprint: fingerprint,
      createdBy: input.actorUserId,
      activatedAt: now,
      createdAt: now,
    }),
    db
      .update(organizationProviderConnections)
      .set({
        state: "active",
        projectFingerprint,
        sentinelFirewallId: String(connected.sentinel.id),
        activeCredentialVersionId: credentialId,
        approvedLocationsJson: locations,
        maxConcurrentServers,
        maxSessionGrossMicros,
        currency: billingCurrency(connected.catalog.pricing.currency),
        lastValidatedAt: now,
        cleanupAcknowledgedAt: null,
        cleanupAcknowledgedBy: null,
        updatedAt: now,
      })
      .where(eq(organizationProviderConnections.id, connection.id)),
    db.insert(providerAuditEvents).values({
      id: createAppId(),
      organizationId: input.organizationId,
      connectionId: connection.id,
      actorUserId: input.actorUserId,
      type: "provider.connection.rebound",
      payloadJson: {
        credentialVersion: version,
        sentinelFirewallId: String(connected.sentinel.id),
        approvedLocations: locations,
        maxConcurrentServers,
        maxSessionGrossMicros,
        requiredServerTypes,
        systemImage,
        canonicalWriteCount: connected.canonicalWrites.length,
      },
      createdAt: now,
    }),
  ]);
  return requireListedConnection(
    input.organizationId,
    input.actorUserId,
    connection.id,
  );
}

export async function disconnectHetznerProject(input: {
  organizationId: string;
  connectionId: string;
  actorUserId: string;
  now?: number;
}): Promise<HetznerProviderConnectionRecord> {
  await requireOwner(input.organizationId, input.actorUserId);
  const connection = await requireConnection(
    input.organizationId,
    input.connectionId,
  );
  if (connection.state === "disconnected") {
    return requireListedConnection(
      input.organizationId,
      input.actorUserId,
      connection.id,
    );
  }
  if ((await unconfirmedAllocations(connection.id)).length > 0) {
    throw appError(
      409,
      "provider_cleanup_not_confirmed",
      "all learner resources must have confirmed deletion before disconnecting",
    );
  }
  const active = await loadActiveCredential(connection);
  const now = input.now ?? Date.now();
  const claimed = await env.DB.prepare(
    `UPDATE organization_provider_connections
     SET state = 'cleanup_pending', updated_at = ?
     WHERE id = ? AND state IN ('active', 'rotation_required', 'cleanup_pending')
       AND NOT EXISTS (
         SELECT 1 FROM hetzner_allocations
         WHERE connection_id = ? AND deletion_confirmed_at IS NULL
       )
     RETURNING id`,
  )
    .bind(now, connection.id, connection.id)
    .first<{ id: string }>();
  if (!claimed) {
    throw appError(
      409,
      "provider_cleanup_not_confirmed",
      "provider cleanup changed while disconnecting; retry after deletion is confirmed",
    );
  }
  const firewallId = providerInteger(
    connection.sentinelFirewallId,
    "sentinel firewall",
  );
  const result = await hcloudRunOperation({
    requestId: createAppId(),
    connectionId: connection.id,
    credentialContext: active.context,
    credential: active.envelope,
    operation: {
      kind: "delete_resource",
      resourceKind: "firewall",
      externalId: firewallId,
      name: `intar-${connection.id.slice(0, 20)}-sentinel`,
    },
  });
  const deletionWrite = result.canonicalWrites.find(
    (write) =>
      write.connectionId === connection.id &&
      write.operation === "resource_deleted" &&
      write.resourceKind === "firewall" &&
      write.externalId === firewallId,
  );
  if (!deletionWrite) {
    throw appError(
      502,
      "provider_sentinel_deletion_unconfirmed",
      "Hetzner did not confirm deletion of the firewall sentinel",
    );
  }
  if ((await unconfirmedAllocations(connection.id)).length > 0) {
    throw appError(
      409,
      "provider_cleanup_not_confirmed",
      "a learner resource appeared while disconnecting; manual cleanup is required",
    );
  }
  const db = drizzle(env.DB);
  await db.batch([
    db
      .update(providerCredentialVersions)
      .set({ revokedAt: now })
      .where(eq(providerCredentialVersions.id, active.context.credentialId)),
    db
      .update(organizationProviderConnections)
      .set({
        state: "disconnected",
        activeCredentialVersionId: null,
        updatedAt: now,
      })
      .where(eq(organizationProviderConnections.id, connection.id)),
    db.insert(providerAuditEvents).values({
      id: createAppId(),
      organizationId: input.organizationId,
      connectionId: connection.id,
      actorUserId: input.actorUserId,
      type: "provider.resource_deleted",
      payloadJson: {
        requestId: deletionWrite.requestId,
        resourceKind: deletionWrite.resourceKind,
        externalId: String(deletionWrite.externalId),
        actionIds: deletionWrite.actionIds.map(String),
        state: deletionWrite.state ?? "deleted",
      },
      createdAt: now,
    }),
    db.insert(providerAuditEvents).values({
      id: createAppId(),
      organizationId: input.organizationId,
      connectionId: connection.id,
      actorUserId: input.actorUserId,
      type: "provider.connection.disconnected",
      payloadJson: {
        sentinelFirewallId: connection.sentinelFirewallId,
        deletionVerified: true,
        credentialVersion: active.context.version,
      },
      createdAt: now,
    }),
  ]);
  return requireListedConnection(
    input.organizationId,
    input.actorUserId,
    connection.id,
  );
}

export async function acknowledgeHetznerManualCleanup(input: {
  organizationId: string;
  connectionId: string;
  actorUserId: string;
  now?: number;
}): Promise<HetznerManualCleanupAcknowledgement> {
  await requireOwner(input.organizationId, input.actorUserId);
  const connection = await requireConnection(
    input.organizationId,
    input.connectionId,
  );
  if (connection.state === "disconnected") {
    throw appError(
      409,
      "provider_connection_disconnected",
      "a disconnected provider connection has no unverified cleanup to acknowledge",
    );
  }
  const resources = await unconfirmedAllocations(connection.id);
  if (resources.length === 0) {
    throw appError(
      409,
      "provider_cleanup_not_pending",
      "the provider connection has no unconfirmed learner resources",
    );
  }
  const now = input.now ?? Date.now();
  const db = drizzle(env.DB);
  const affectedSessions = await db
    .select({
      sessionId: workshopWorkspaces.sessionId,
      resourceCount: count(hetznerAllocations.id),
    })
    .from(hetznerAllocations)
    .innerJoin(
      runtimeExecutions,
      eq(runtimeExecutions.id, hetznerAllocations.executionId),
    )
    .innerJoin(
      workshopWorkspaces,
      eq(workshopWorkspaces.id, runtimeExecutions.domainId),
    )
    .where(
      and(
        eq(hetznerAllocations.connectionId, connection.id),
        inArray(
          hetznerAllocations.id,
          resources.length
            ? resources.map((resource) => resource.allocationId)
            : [""],
        ),
      ),
    )
    .groupBy(workshopWorkspaces.sessionId);
  await db.batch([
    db
      .update(organizationProviderConnections)
      .set({
        state: "cleanup_pending",
        cleanupAcknowledgedAt: now,
        cleanupAcknowledgedBy: input.actorUserId,
        updatedAt: now,
      })
      .where(eq(organizationProviderConnections.id, connection.id)),
    ...affectedSessions.map((session) =>
      db
        .insert(workshopSessionCostSummaries)
        .values({
          sessionId: session.sessionId,
          currency: connection.currency,
          cleanupPendingCount: session.resourceCount,
          manualCleanupUnverified: true,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: workshopSessionCostSummaries.sessionId,
          set: {
            cleanupPendingCount: session.resourceCount,
            manualCleanupUnverified: true,
            updatedAt: now,
          },
        }),
    ),
    db.insert(providerAuditEvents).values({
      id: createAppId(),
      organizationId: input.organizationId,
      connectionId: connection.id,
      actorUserId: input.actorUserId,
      type: "provider.cleanup.manually_acknowledged",
      payloadJson: {
        verified: false,
        sentinelFirewallId: connection.sentinelFirewallId,
        resources: resources.map((resource) => ({
          allocationId: resource.allocationId,
          executionId: resource.executionId,
          deterministicName: resource.deterministicName,
          state: resource.state,
          serverId: resource.serverId,
          primaryIpId: resource.primaryIpId,
          primaryIpv4: resource.primaryIpv4,
          sshKeyId: resource.sshKeyId,
          createActionId: resource.createActionId,
          deleteActionId: resource.deleteActionId,
        })),
      },
      createdAt: now,
    }),
  ]);
  return {
    acknowledgedAt: now,
    verified: false,
    sentinelFirewallId: connection.sentinelFirewallId,
    resources,
  };
}

export async function overrideWorkshopSessionGrossCeiling(input: {
  organizationId: string;
  sessionId: string;
  actorUserId: string;
  now?: number;
}): Promise<{
  sessionId: string;
  overriddenAt: number;
  overriddenBy: string;
}> {
  await requireOwner(input.organizationId, input.actorUserId);
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      state: workshopSessions.state,
      providerKind: workshopSessionRuntimeProviders.providerKind,
      connectionId: workshopSessionRuntimeProviders.connectionId,
      maxSessionGrossMicros:
        organizationProviderConnections.maxSessionGrossMicros,
    })
    .from(workshopSessions)
    .innerJoin(
      workshopSessionRuntimeProviders,
      eq(workshopSessionRuntimeProviders.sessionId, workshopSessions.id),
    )
    .leftJoin(
      organizationProviderConnections,
      eq(
        organizationProviderConnections.id,
        workshopSessionRuntimeProviders.connectionId,
      ),
    )
    .where(
      and(
        eq(workshopSessions.id, input.sessionId),
        eq(workshopSessions.organizationId, input.organizationId),
      ),
    )
    .limit(1);
  const session = rows[0];
  if (!session) {
    throw appError(
      404,
      "workshop_session_not_found",
      "workshop session not found",
    );
  }
  if (session.providerKind !== "hetzner_cloud" || !session.connectionId) {
    throw appError(
      409,
      "workshop_cost_unavailable",
      "gross cost overrides apply only to Hetzner workshop sessions",
    );
  }
  if (session.state === "ended" || session.state === "cancelled") {
    throw appError(
      409,
      "workshop_session_immutable",
      "an ended workshop session cannot receive a cost override",
    );
  }
  if (session.maxSessionGrossMicros === null) {
    throw appError(
      409,
      "workshop_cost_ceiling_not_configured",
      "the organization has no gross session cost ceiling to override",
    );
  }
  const latestRows = await env.DB.prepare(
    `SELECT id, version, currency, lease_ceiling_gross_micros,
            one_restore_gross_micros, exceeds_gross_ceiling
     FROM workshop_session_cost_forecasts
     WHERE session_id = ? ORDER BY version DESC LIMIT 1`,
  )
    .bind(input.sessionId)
    .all<{
      id: string;
      version: number;
      currency: string;
      lease_ceiling_gross_micros: number;
      one_restore_gross_micros: number;
      exceeds_gross_ceiling: number;
    }>();
  const forecast = latestRows.results[0];
  if (!forecast) {
    throw appError(
      409,
      "workshop_cost_forecast_missing",
      "refresh the workshop cost forecast before overriding its ceiling",
    );
  }
  const now = input.now ?? Date.now();
  await db.batch([
    db
      .update(workshopSessionRuntimeProviders)
      .set({
        grossCeilingOverrideAt: now,
        grossCeilingOverrideBy: input.actorUserId,
        updatedAt: now,
      })
      .where(eq(workshopSessionRuntimeProviders.sessionId, input.sessionId)),
    db.insert(providerAuditEvents).values({
      id: createAppId(),
      organizationId: input.organizationId,
      connectionId: session.connectionId,
      actorUserId: input.actorUserId,
      type: "provider.session.gross_ceiling_overridden",
      payloadJson: {
        sessionId: input.sessionId,
        forecastId: forecast.id,
        forecastVersion: forecast.version,
        currency: forecast.currency,
        configuredGrossCeilingMicros: session.maxSessionGrossMicros,
        leaseCeilingGrossMicros: forecast.lease_ceiling_gross_micros,
        oneRestoreGrossMicros: forecast.one_restore_gross_micros,
        forecastExceededCeiling: forecast.exceeds_gross_ceiling === 1,
      },
      createdAt: now,
    }),
  ]);
  return {
    sessionId: input.sessionId,
    overriddenAt: now,
    overriddenBy: input.actorUserId,
  };
}

export async function refreshHetznerCatalog(input: {
  organizationId: string;
  connectionId: string;
  requiredServerTypes: readonly string[];
  systemImage: string;
}): Promise<CatalogObservation> {
  const connection = await requireConnection(
    input.organizationId,
    input.connectionId,
  );
  if (connection.state !== "active") {
    throw appError(
      409,
      "provider_connection_inactive",
      "the Hetzner provider connection is not active",
    );
  }
  const active = await loadActiveCredential(connection);
  const operation = await hcloudRunOperation({
    requestId: createAppId(),
    connectionId: connection.id,
    credentialContext: active.context,
    credential: active.envelope,
    operation: {
      kind: "catalog",
      requiredServerTypes: providerNames(
        input.requiredServerTypes,
        "server type",
      ),
      permittedLocations: connection.approvedLocationsJson,
      systemImage: providerName(input.systemImage, "image"),
    },
  });
  return operation.data as CatalogObservation;
}

export async function requireConnection(
  organizationId: string,
  connectionId: string,
) {
  const rows = await drizzle(env.DB)
    .select()
    .from(organizationProviderConnections)
    .where(
      and(
        eq(organizationProviderConnections.id, connectionId),
        eq(organizationProviderConnections.organizationId, organizationId),
        eq(organizationProviderConnections.providerKind, "hetzner_cloud"),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw appError(
      404,
      "provider_connection_not_found",
      "provider connection not found",
    );
  }
  return row;
}

export async function loadActiveCredential(
  connection: Awaited<ReturnType<typeof requireConnection>>,
): Promise<{
  context: CredentialContext;
  envelope: EncryptedCredentialEnvelope;
}> {
  if (!connection.activeCredentialVersionId) {
    throw appError(
      409,
      "provider_credential_unavailable",
      "provider connection has no active credential",
    );
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
  const credential = rows[0];
  if (!credential || credential.revokedAt !== null) {
    throw appError(
      409,
      "provider_credential_unavailable",
      "provider connection credential is unavailable",
    );
  }
  return {
    context: {
      organizationId: connection.organizationId,
      connectionId: connection.id,
      credentialId: credential.id,
      provider: "hetzner_cloud",
      version: credential.version,
    },
    envelope: credentialEnvelopeFromStorage(credential),
  };
}

export async function ownershipLabels(
  organizationId: string,
  connectionId: string,
  workspaceId?: string,
  generation?: number,
): Promise<OwnershipLabels> {
  return {
    organizationRef: (await sha256Hex(organizationId)).slice(0, 32),
    connectionRef: (await sha256Hex(connectionId)).slice(0, 32),
    ...(workspaceId
      ? { workspaceRef: (await sha256Hex(workspaceId)).slice(0, 32) }
      : {}),
    ...(generation === undefined ? {} : { generation }),
  };
}

export async function countLiveHetznerAllocations(
  connectionId: string,
): Promise<number> {
  const rows = await drizzle(env.DB)
    .select({ id: hetznerAllocations.id })
    .from(hetznerAllocations)
    .where(
      and(
        eq(hetznerAllocations.connectionId, connectionId),
        // A cloud seat remains live (and potentially billable) until provider
        // deletion is confirmed, regardless of its local lifecycle label.
        isNull(hetznerAllocations.deletionConfirmedAt),
      ),
    );
  return rows.length;
}

async function unconfirmedAllocations(
  connectionId: string,
): Promise<HetznerManualCleanupResource[]> {
  const rows = await env.DB.prepare(
    `SELECT id, execution_id, deterministic_name, state, server_id,
            primary_ip_id, primary_ipv4, ssh_key_id, create_action_id,
            delete_action_id, deletion_confirmed_at
     FROM hetzner_allocations
     WHERE connection_id = ? AND deletion_confirmed_at IS NULL
     ORDER BY created_at ASC, id ASC`,
  )
    .bind(connectionId)
    .all<{
      id: string;
      execution_id: string;
      deterministic_name: string;
      state: string;
      server_id: string | null;
      primary_ip_id: string | null;
      primary_ipv4: string | null;
      ssh_key_id: string | null;
      create_action_id: string | null;
      delete_action_id: string | null;
      deletion_confirmed_at: number | null;
    }>();
  return rows.results.map((row) => ({
    allocationId: row.id,
    executionId: row.execution_id,
    deterministicName: row.deterministic_name,
    state: row.state,
    serverId: row.server_id,
    primaryIpId: row.primary_ip_id,
    primaryIpv4: row.primary_ipv4,
    sshKeyId: row.ssh_key_id,
    createActionId: row.create_action_id,
    deleteActionId: row.delete_action_id,
    deletionConfirmedAt: row.deletion_confirmed_at,
  }));
}

async function requireListedConnection(
  organizationId: string,
  actorUserId: string,
  connectionId: string,
): Promise<HetznerProviderConnectionRecord> {
  const connection = (
    await listHetznerProviderConnections({ organizationId, actorUserId })
  ).find((entry) => entry.id === connectionId);
  if (!connection) {
    throw appError(
      404,
      "provider_connection_not_found",
      "provider connection not found",
    );
  }
  return connection;
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

async function requireOwner(organizationId: string, userId: string) {
  const role = await requireOrganizationRole({ organizationId, userId });
  if (role !== "owner") {
    throw appError(
      403,
      "organization_owner_required",
      "organization owner role required",
    );
  }
}

function providerToken(value: string): string {
  const token = typeof value === "string" ? value.trim() : "";
  if (token.length < 16 || token.length > 512 || /\s/.test(token)) {
    throw appError(
      400,
      "provider_token_invalid",
      "Hetzner API token is invalid",
    );
  }
  return token;
}

function approvedLocations(values?: readonly string[]): string[] {
  const locations = [...new Set(values ?? DEFAULT_LOCATIONS)].map((value) =>
    providerName(value, "location"),
  );
  if (!locations.length || locations.length > 10) {
    throw appError(
      400,
      "provider_locations_invalid",
      "between one and ten approved Hetzner locations are required",
    );
  }
  return locations;
}

function providerNames(values: readonly string[], kind: string): string[] {
  const result = [...new Set(values.map((value) => providerName(value, kind)))];
  if (!result.length) {
    throw appError(
      400,
      "provider_names_required",
      `at least one Hetzner ${kind} is required`,
    );
  }
  return result;
}

function providerName(value: string, kind: string): string {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(normalized)) {
    throw appError(400, "provider_name_invalid", `Hetzner ${kind} is invalid`);
  }
  return normalized;
}

function connectionDisplayName(value?: string): string {
  const normalized = value?.trim() || "Hetzner Cloud";
  if (normalized.length > 80) {
    throw appError(
      400,
      "provider_connection_name_invalid",
      "provider connection name is too long",
    );
  }
  return normalized;
}

function serverLimit(value?: number): number {
  const limit = value ?? DEFAULT_MAX_SERVERS;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw appError(
      400,
      "provider_server_limit_invalid",
      "provider concurrent server limit must be between one and 100",
    );
  }
  return limit;
}

function costLimit(value?: number | null): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw appError(
      400,
      "provider_cost_limit_invalid",
      "provider gross cost ceiling must be non-negative currency micro-units",
    );
  }
  return value;
}

function billingCurrency(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw appError(
      502,
      "provider_currency_invalid",
      "Hetzner returned an invalid billing currency",
    );
  }
  return normalized;
}

function stargateEgressIpv4Cidrs(): string[] {
  const value = (
    env as Cloudflare.Env & { STARGATE_EGRESS_IPV4_CIDRS?: string }
  ).STARGATE_EGRESS_IPV4_CIDRS;
  const cidrs = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!cidrs.length || cidrs.some((entry) => !isIpv4Cidr(entry))) {
    throw appError(
      503,
      "stargate_egress_not_configured",
      "Stargate egress IPv4 CIDRs are not configured",
    );
  }
  return cidrs;
}

function isIpv4Cidr(value: string): boolean {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d|[12]\d|3[0-2])$/.exec(value);
  if (!match) return false;
  return match[1]!.split(".").every((octet) => Number(octet) <= 255);
}

function providerInteger(value: string, kind: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw appError(
      500,
      "provider_external_id_invalid",
      `stored ${kind} ID is invalid`,
    );
  }
  return parsed;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function maskedTokenFingerprint(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw appError(
      500,
      "provider_token_fingerprint_invalid",
      "stored provider credential fingerprint is invalid",
    );
  }
  return `sha256:${value.slice(0, 12)}...`;
}
