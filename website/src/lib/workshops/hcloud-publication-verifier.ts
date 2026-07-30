import { env } from "cloudflare:workers";
import type {
  CanonicalProviderWrite,
  HcloudAction,
  HcloudOperation,
  HcloudOperationResult,
  OwnershipLabels,
  ReconcileResult,
  ResourceObservation,
} from "../../../../hcloud-provider-worker/src/contracts";
import { finalizeVerifiedWorkshopProviderPublication } from "@/control-plane/workshop-registry";
import type {
  ProviderHardwareShape,
  ProviderPriceObservation,
  WorkshopManifestV1,
} from "@/db/schema";
import { AppError, appError } from "@/lib/app-error";
import {
  hcloudRunOperation,
  resolveHetznerCatalog,
} from "@/lib/hcloud-provider-service";
import { createAppId } from "@/lib/id";
import {
  runtimeCapacityAllocationKey,
  withRuntimeAllocationLock,
} from "@/lib/runtime-allocation-lock";
import { generateSshEd25519KeyPair } from "@/lib/ssh-ed25519";
import { decimalCurrencyToMicros } from "./costs";
import {
  countLiveHetznerAllocations,
  loadActiveCredential,
  refreshHetznerCatalog,
  requireConnection,
  workshopPublicationVerifierOwnershipLabels,
} from "./provider-connections";
import { isWorkshopHcloudRuntimeEnabledForOrganization } from "./feature-flag";
import { buildWorkspaceAgentCloudInit } from "./workspace-agent-control-plane";

const BOOTSTRAP_TTL_MS = 30 * 60_000;
const REPORT_TTL_MS = 2 * 60 * 60_000;
const MAX_PROVIDER_ATTEMPTS = 3;
const ACTION_POLL_MS = 15_000;
const MAX_CANDIDATES_PER_SWEEP = 32;
const LEGACY_VERIFIER_NAME_ERROR =
  "Provider resource name must be a canonical Intar DNS label";
const LEGACY_VERIFIER_NAME_PATTERN = /^iwpv-[a-z0-9]+$/u;

type ResolvedProvider = NonNullable<
  WorkshopManifestV1["workspace"]["provider"]
>;

interface ProviderCheckpointRow {
  id: string;
  publication_id: string;
  organization_id: string;
  checkpoint_id: string;
  ordinal: number;
  expected_probes_json: string | Array<{ moduleId: string; probeId: string }>;
  connection_id: string;
  resolved_provider_json: string | ResolvedProvider;
  permitted_locations_json: string | string[];
  price_observation_json: string | ProviderPriceObservation;
  r2_key: string;
  sha256: string;
  size_bytes: number;
  workspace_agent_sha256: string;
  kino_sha256: string;
  verification_status: string;
}

interface ProviderAttemptRow {
  id: string;
  provider_checkpoint_id: string;
  connection_id: string;
  ordinal: number;
  deterministic_name: string;
  server_type: string;
  system_image: string;
  location: string;
  server_id: string | null;
  primary_ip_id: string | null;
  primary_ipv4: string | null;
  ssh_key_id: string | null;
  create_action_id: string | null;
  delete_action_id: string | null;
  state: string;
  bootstrap_expires_at: number;
  bootstrap_consumed_at: number | null;
  report_credential_hash: string | null;
  report_credential_issued_at: number | null;
  report_credential_expires_at: number;
  checkpoint_download_token_hash: string | null;
  checkpoint_download_expires_at: number | null;
  checkpoint_first_downloaded_at: number | null;
  last_report_sequence: number;
  last_report_at: number | null;
  proof_report_sequence: number | null;
  proof_verified_at: number | null;
  deletion_requested_at: number | null;
  deletion_confirmed_at: number | null;
  last_error_code: string | null;
  error: string | null;
}

interface ProviderContext {
  connection: Awaited<ReturnType<typeof requireConnection>>;
  credential: Awaited<ReturnType<typeof loadActiveCredential>>;
}

export interface WorkshopPublicationVerifierSweepResult {
  processed: boolean;
  publicationId?: string;
  checkpointId?: string;
  state:
    | "idle"
    | "waiting"
    | "allocating"
    | "bootstrapping"
    | "applying"
    | "deleting"
    | "verified"
    | "failed"
    | "cleanup_pending";
}

/**
 * Advances at most one publication checkpoint. A later checkpoint is never
 * selected until every earlier one has completed proof and confirmed cleanup.
 */
export async function sweepHetznerWorkshopPublicationVerifiers(
  input: {
    now?: number;
  } = {},
): Promise<WorkshopPublicationVerifierSweepResult> {
  const now = timestamp(input.now ?? Date.now());
  try {
    const finalizedPublicationId = await finalizeOneReadyPublication(now);
    if (finalizedPublicationId) {
      return {
        processed: true,
        publicationId: finalizedPublicationId,
        state: "verified",
      };
    }
  } catch {
    // A transient finalization read must not stop unrelated verifier cleanup or
    // allocation. The ready publication remains canonical in D1 and is retried
    // before candidate work on the next minute sweep.
  }

  const candidates = await nextCheckpoints(MAX_CANDIDATES_PER_SWEEP);
  if (candidates.length === 0) {
    return { processed: false, state: "idle" };
  }
  let deferred: WorkshopPublicationVerifierSweepResult | null = null;
  const deferredConnections = new Set<string>();
  for (const candidate of candidates) {
    if (deferredConnections.has(candidate.connection_id)) continue;
    const selected = {
      processed: true,
      publicationId: candidate.publication_id,
      checkpointId: candidate.checkpoint_id,
    } as const;
    let result: WorkshopPublicationVerifierSweepResult;
    try {
      result = await withRuntimeAllocationLock({
        key: `workshop-publication-verifier:${candidate.id}`,
        now,
        operation: async () => {
          const current = await checkpointById(candidate.id);
          if (!current) return { ...selected, state: "waiting" as const };
          return advanceCheckpoint(current, now);
        },
      });
    } catch (error) {
      if (
        error instanceof AppError &&
        error.code === "runtime_allocation_busy"
      ) {
        result = { ...selected, state: "waiting" };
      } else {
        throw error;
      }
    }
    if (result.state !== "waiting" && result.state !== "cleanup_pending") {
      return result;
    }
    deferred ??= result;
    deferredConnections.add(candidate.connection_id);
    await deferCheckpointCandidate(candidate.id, now);
  }
  return deferred ?? { processed: false, state: "idle" };
}

async function advanceCheckpoint(
  candidate: ProviderCheckpointRow,
  now: number,
): Promise<WorkshopPublicationVerifierSweepResult> {
  const base = {
    processed: true,
    publicationId: candidate.publication_id,
    checkpointId: candidate.checkpoint_id,
  } as const;
  const attempt = await latestAttempt(candidate.id);

  try {
    if (attempt?.state === "proof_succeeded") {
      await beginCleanup(candidate, attempt, now, true);
      return { ...base, state: "deleting" };
    }
    if (attempt?.state === "failed") {
      await beginCleanup(candidate, attempt, now, false);
      return { ...base, state: "deleting" };
    }
    if (
      candidate.verification_status === "deleting" ||
      candidate.verification_status === "cleanup_pending" ||
      attempt?.state === "deleting" ||
      attempt?.state === "cleanup_pending"
    ) {
      const state = await cleanupAttempt(candidate, attempt, now);
      return { ...base, state };
    }
    if (candidate.verification_status === "failed") {
      await failPublication(candidate, candidate.verification_status, now);
      return { ...base, state: "failed" };
    }
    if (attempt?.state === "allocating") {
      return {
        ...base,
        state: await resumeAllocatingAttempt(candidate, attempt, now),
      };
    }
    if (attempt?.state === "bootstrapping" || attempt?.state === "applying") {
      await mirrorAttemptState(candidate, attempt, now);
      if (attempt.report_credential_expires_at <= now) {
        await failAttemptForCleanup(
          candidate,
          attempt,
          "verifier report deadline expired",
          "publication_verifier_report_expired",
          now,
        );
        return { ...base, state: "deleting" };
      }
      if (
        attempt.bootstrap_consumed_at === null &&
        attempt.bootstrap_expires_at <= now
      ) {
        await failAttemptForCleanup(
          candidate,
          attempt,
          "verifier bootstrap deadline expired",
          "publication_verifier_bootstrap_expired",
          now,
        );
        return { ...base, state: "deleting" };
      }
      return {
        ...base,
        state: attempt.state === "applying" ? "applying" : "bootstrapping",
      };
    }
    if (candidate.verification_status !== "pending") {
      await markCleanupPending(
        candidate,
        attempt,
        "publication verifier state is inconsistent",
        "publication_verifier_state_inconsistent",
        now,
      );
      return { ...base, state: "cleanup_pending" };
    }

    const allocation = await allocatePendingCheckpoint(candidate, now);
    return { ...base, state: allocation };
  } catch (error) {
    if (isRetryableWait(error) && !attempt) {
      return { ...base, state: "waiting" };
    }
    const currentAttempt = attempt ?? (await latestAttempt(candidate.id));
    if (!currentAttempt) {
      if (isRetryableWait(error)) return { ...base, state: "waiting" };
      await failCheckpointWithoutAttempt(candidate, safeError(error), now);
      return { ...base, state: "failed" };
    }
    await failAttemptForCleanup(
      candidate,
      currentAttempt,
      safeError(error),
      errorCode(error),
      now,
    );
    return { ...base, state: "deleting" };
  }
}

async function allocatePendingCheckpoint(
  candidate: ProviderCheckpointRow,
  now: number,
): Promise<
  | "allocating"
  | "bootstrapping"
  | "applying"
  | "waiting"
  | "deleting"
  | "failed"
> {
  if (
    !(await isWorkshopHcloudRuntimeEnabledForOrganization(
      candidate.organization_id,
    ))
  ) {
    return "waiting";
  }
  const provider = parseResolvedProvider(candidate.resolved_provider_json);
  const expectedProbes = parseExpectedProbes(candidate.expected_probes_json);
  const pinnedLocations = parseStringArray(
    candidate.permitted_locations_json,
    "permitted locations",
  );
  if (expectedProbes.length === 0) {
    throw appError(
      409,
      "publication_verifier_probes_missing",
      "the provider checkpoint has no expected probes",
    );
  }
  const connection = await requireConnection(
    candidate.organization_id,
    candidate.connection_id,
  );
  if (
    connection.state !== "active" ||
    !connection.ipv4Enabled ||
    !connection.sentinelFirewallId
  ) {
    throw appError(
      409,
      "publication_verifier_connection_unavailable",
      "the Hetzner provider connection is unavailable for verification",
    );
  }
  const permittedLocations = pinnedLocations.filter((location) =>
    connection.approvedLocationsJson.includes(location),
  );
  if (permittedLocations.length === 0) {
    throw appError(
      409,
      "publication_verifier_locations_unavailable",
      "no pinned verification location remains approved",
    );
  }
  const catalog = await refreshHetznerCatalog({
    organizationId: candidate.organization_id,
    connectionId: candidate.connection_id,
    requiredServerTypes: [provider.serverType],
    systemImage: provider.systemImage,
  });
  const fresh = resolveHetznerCatalog({
    catalog,
    exactServerType: provider.serverType,
    systemImage: provider.systemImage,
    permittedLocations,
    requiredCpuMillis: provider.hardware.cores * 1_000,
    requiredMemoryMib: provider.hardware.memoryMib,
    requiredDiskMib: provider.hardware.diskMib,
  });
  if (!sameHardware(fresh.hardware, provider.hardware)) {
    throw appError(
      409,
      "publication_verifier_server_type_changed",
      "the pinned Hetzner server type hardware changed",
    );
  }
  const availableLocations = fresh.prices.locations
    .filter((entry) => entry.available)
    .map((entry) => entry.location);
  if (availableLocations.length === 0) {
    throw appError(
      503,
      "hcloud_resource_unavailable",
      "the pinned Hetzner server type is unavailable in approved locations",
    );
  }
  // The cost ledger must use the exact provider decimal snapshot observed for
  // this allocation, not the older price seen when the builder staged it.
  candidate.price_observation_json = fresh.prices;
  await Promise.all([
    verifyCheckpointArtifact(candidate),
    resolveGuestTools(candidate, requiredControlPlaneBaseUrl()),
  ]);

  const controlPlaneBaseUrl = requiredControlPlaneBaseUrl();
  const claim = await withRuntimeAllocationLock({
    key: runtimeCapacityAllocationKey(candidate.organization_id),
    now,
    operation: async () => {
      const lockedConnection = await requireConnection(
        candidate.organization_id,
        candidate.connection_id,
      );
      if (
        lockedConnection.state !== "active" ||
        !lockedConnection.ipv4Enabled ||
        !lockedConnection.sentinelFirewallId
      ) {
        throw appError(
          409,
          "publication_verifier_connection_unavailable",
          "the Hetzner provider connection is unavailable for verification",
        );
      }
      const occupiedSeats = await countLiveHetznerAllocations(
        candidate.connection_id,
      );
      if (occupiedSeats >= lockedConnection.maxConcurrentServers) {
        throw appError(
          409,
          "hcloud_concurrency_limit_reached",
          "the organization Hetzner learner-server limit is reached",
        );
      }
      const attemptOrdinal = (await maxAttemptOrdinal(candidate.id)) + 1;
      if (attemptOrdinal > MAX_PROVIDER_ATTEMPTS) {
        return { kind: "exhausted" as const };
      }
      const attemptId = createAppId();
      const location =
        availableLocations[(attemptOrdinal - 1) % availableLocations.length]!;
      if (!lockedConnection.approvedLocationsJson.includes(location)) {
        throw appError(
          409,
          "publication_verifier_locations_unavailable",
          "the selected verification location is no longer approved",
        );
      }
      const deterministicName = `intar-wpv-${attemptId}`;
      const bootstrapCapability = randomCapability("iwpv_bootstrap");
      const bootstrapTokenHash = await sha256Hex(bootstrapCapability);
      const keyPair = generateSshEd25519KeyPair(`${deterministicName}@intar`);
      const cloudInit = buildWorkspaceAgentCloudInit({
        identity: {
          executionId: attemptId,
          workspaceId: candidate.id,
          generation: attemptOrdinal,
        },
        endpoint: new URL(
          "/api/runtime/workshop-publication-verifier/",
          controlPlaneBaseUrl,
        ).toString(),
        bootstrapCapability,
        sshPublicKey: keyPair.publicKeyOpenssh,
        agentBinaryUrl: new URL(
          `/api/runtime/workspace-agent/binaries/${candidate.workspace_agent_sha256}`,
          controlPlaneBaseUrl,
        ).toString(),
        agentBinarySha256: candidate.workspace_agent_sha256,
        kinoBinaryUrl: new URL(
          `/api/runtime/workspace-agent/kino/binaries/${candidate.kino_sha256}`,
          controlPlaneBaseUrl,
        ).toString(),
        kinoBinarySha256: candidate.kino_sha256,
        kinoProbes: expectedProbes,
      });
      const results = await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO workshop_publication_provider_attempts (
             id, provider_checkpoint_id, connection_id, ordinal,
             deterministic_name, server_type, system_image, location, state,
             control_plane_base_url, bootstrap_token_hash,
             bootstrap_expires_at, report_credential_expires_at,
             created_at, updated_at
           )
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'allocating', ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1
             FROM workshop_publication_provider_checkpoints checkpoint
             INNER JOIN workshop_publications publication
               ON publication.id = checkpoint.publication_id
              AND publication.status = 'building'
              AND publication.provider_verification_state = 'verifying'
             INNER JOIN organization_provider_connections connection
               ON connection.id = checkpoint.connection_id
              AND connection.organization_id = publication.organization_id
              AND connection.state = 'active'
             WHERE checkpoint.id = ?
               AND checkpoint.connection_id = ?
               AND checkpoint.verification_status = 'pending'
               AND NOT EXISTS (
                 SELECT 1
                 FROM workshop_publication_provider_checkpoints prior
                 WHERE prior.publication_id = checkpoint.publication_id
                   AND prior.ordinal < checkpoint.ordinal
                   AND prior.verification_status <> 'verified'
               )
           )
           AND NOT EXISTS (
             SELECT 1 FROM workshop_publication_provider_attempts
             WHERE provider_checkpoint_id = ?
               AND deletion_confirmed_at IS NULL
           )`,
        ).bind(
          attemptId,
          candidate.id,
          candidate.connection_id,
          attemptOrdinal,
          deterministicName,
          provider.serverType,
          provider.systemImage,
          location,
          controlPlaneBaseUrl,
          bootstrapTokenHash,
          now + BOOTSTRAP_TTL_MS,
          now + REPORT_TTL_MS,
          now,
          now,
          candidate.id,
          candidate.connection_id,
          candidate.id,
        ),
        env.DB.prepare(
          `UPDATE workshop_publication_provider_checkpoints
           SET verification_status = 'allocating', error = NULL,
               price_observation_json = ?, updated_at = ?
           WHERE id = ? AND verification_status = 'pending'
             AND EXISTS (
               SELECT 1 FROM workshop_publication_provider_attempts
               WHERE id = ? AND provider_checkpoint_id = ?
             )`,
        ).bind(
          JSON.stringify(fresh.prices),
          now,
          candidate.id,
          attemptId,
          candidate.id,
        ),
      ]);
      if (!results.every((result) => result.meta.changes === 1)) {
        return { kind: "lost" as const };
      }
      return {
        kind: "claimed" as const,
        attemptId,
        deterministicName,
        location,
        publicKey: keyPair.publicKeyOpenssh,
        cloudInit,
        firewallId: providerId(lockedConnection.sentinelFirewallId),
      };
    },
  });
  if (claim.kind === "exhausted") {
    await failCheckpointWithoutAttempt(
      candidate,
      "provider verification exhausted its retry limit",
      now,
    );
    return "failed";
  }
  if (claim.kind === "lost") return "waiting";
  const {
    attemptId,
    deterministicName,
    location,
    publicKey,
    cloudInit,
    firewallId,
  } = claim;

  const attempt = await requireAttempt(attemptId);
  const context = await providerContext(candidate);
  const ownership = await verifierOwnership(candidate, attempt);
  try {
    const keyResult = await createOrReconcileResource({
      candidate,
      attempt,
      context,
      operation: {
        kind: "create_ssh_key",
        name: `${deterministicName}-key`,
        publicKey,
        ownership,
      },
      resourceKind: "ssh_key",
      deterministicName: `${deterministicName}-key`,
      ownership,
      now,
    });
    const sshKeyId = resourceIdentity(keyResult, "ssh_key");
    await persistIdentityBeforeNext(
      attempt.id,
      "ssh_key",
      sshKeyId.externalId,
      sshKeyId.publicIpv4,
      sshKeyId.actionIds,
      now,
    );

    const ipResult = await createOrReconcileResource({
      candidate,
      attempt: await requireAttempt(attempt.id),
      context,
      operation: {
        kind: "create_primary_ip",
        name: `${deterministicName}-ip-${location}`,
        location,
        ownership,
      },
      resourceKind: "primary_ip",
      deterministicName: `${deterministicName}-ip-${location}`,
      ownership,
      now,
    });
    const primaryIp = resourceIdentity(ipResult, "primary_ip");
    await persistIdentityBeforeNext(
      attempt.id,
      "primary_ip",
      primaryIp.externalId,
      primaryIp.publicIpv4,
      primaryIp.actionIds,
      now,
    );

    const serverResult = await createOrReconcileResource({
      candidate,
      attempt: await requireAttempt(attempt.id),
      context,
      operation: {
        kind: "create_server",
        name: deterministicName,
        serverType: provider.serverType,
        systemImage: provider.systemImage,
        location,
        primaryIpv4Id: primaryIp.externalId,
        sshKeyId: sshKeyId.externalId,
        firewallId,
        cloudInit,
        ownership,
      },
      resourceKind: "server",
      deterministicName,
      ownership,
      now,
    });
    const server = resourceIdentity(serverResult, "server");
    await persistIdentityBeforeNext(
      attempt.id,
      "server",
      server.externalId,
      server.publicIpv4,
      server.actionIds,
      now,
    );
    const actionId = server.actionIds[0];
    if (actionId) {
      const actionResult = await runOperation(
        candidate,
        await requireAttempt(attempt.id),
        context,
        { kind: "get_action", actionId, maxWaitMs: ACTION_POLL_MS },
        now,
      );
      const action = actionResult.data as HcloudAction;
      if (action.status === "error") {
        throw appError(
          503,
          "publication_verifier_create_action_failed",
          "Hetzner verifier server creation failed",
        );
      }
      if (action.status !== "success") return "allocating";
    }
    // The create action confirms the API mutation, not the actual server
    // observation. A following reconciliation must observe `running` before
    // this sweep advances the guest lifecycle.
    return "allocating";
  } catch (error) {
    await failAttemptForCleanup(
      candidate,
      await requireAttempt(attempt.id),
      safeError(error),
      errorCode(error),
      now,
    );
    return "deleting";
  }
}

async function resumeAllocatingAttempt(
  candidate: ProviderCheckpointRow,
  attempt: ProviderAttemptRow,
  now: number,
): Promise<"allocating" | "bootstrapping" | "deleting" | "cleanup_pending"> {
  const context = await providerContext(candidate);
  const ownership = await verifierOwnership(candidate, attempt);
  const result = await runOperation(
    candidate,
    attempt,
    context,
    {
      kind: "reconcile",
      resources: resourceRefs(attempt, ownership),
      actionIds: attempt.create_action_id
        ? [providerId(attempt.create_action_id)]
        : [],
    },
    now,
  );
  const reconciled = result.data as ReconcileResult;
  if (
    !hasCompleteReconcileCoverage(reconciled, attempt) ||
    hasUnsafeObservation(reconciled.resources)
  ) {
    await markCleanupPending(
      candidate,
      attempt,
      "provider resources could not be reconciled safely",
      "publication_verifier_reconcile_unsafe",
      now,
    );
    return "cleanup_pending";
  }
  await adoptReconciledResources(candidate, attempt, reconciled, now);
  const server = observation(reconciled, "server");
  const createAction = reconciled.actions?.find(
    (action) => String(action.id) === attempt.create_action_id,
  );
  if (createAction?.status === "error") {
    await failAttemptForCleanup(
      candidate,
      attempt,
      "Hetzner verifier server creation failed",
      "publication_verifier_create_action_failed",
      now,
    );
    return "deleting";
  }
  if (server?.status === "present" && server.state === "running") {
    await markBootstrapping(candidate, attempt.id, now);
    return "bootstrapping";
  }
  if (server?.status === "present") return "allocating";
  if (createAction?.status === "running") return "allocating";
  await failAttemptForCleanup(
    candidate,
    attempt,
    "verifier allocation was interrupted before server creation",
    "publication_verifier_allocation_interrupted",
    now,
  );
  return "deleting";
}

async function beginCleanup(
  candidate: ProviderCheckpointRow,
  attempt: ProviderAttemptRow,
  now: number,
  proofSucceeded: boolean,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE workshop_publication_provider_attempts
       SET state = 'deleting',
           report_credential_revoked_at = coalesce(report_credential_revoked_at, ?),
           bootstrap_expires_at = min(bootstrap_expires_at, ?),
           checkpoint_download_expires_at = CASE
             WHEN checkpoint_download_expires_at IS NULL THEN NULL
             ELSE min(checkpoint_download_expires_at, ?)
           END,
           deletion_requested_at = coalesce(deletion_requested_at, ?),
           updated_at = ?
       WHERE id = ? AND state IN ('proof_succeeded', 'failed', 'deleting')`,
    ).bind(now, now, now, now, now, attempt.id),
    env.DB.prepare(
      `UPDATE workshop_publication_provider_checkpoints
       SET verification_status = 'deleting',
           proof_verified_at = CASE WHEN ? = 1
             THEN coalesce(proof_verified_at, ?) ELSE proof_verified_at END,
           error = CASE WHEN ? = 1 THEN error ELSE coalesce(error, ?) END,
           updated_at = ?
       WHERE id = ? AND verification_status <> 'verified'`,
    ).bind(
      proofSucceeded ? 1 : 0,
      attempt.proof_verified_at ?? now,
      proofSucceeded ? 1 : 0,
      attempt.error ?? "provider verifier failed",
      now,
      candidate.id,
    ),
  ]);
}

async function cleanupAttempt(
  candidate: ProviderCheckpointRow,
  attempt: ProviderAttemptRow | null,
  now: number,
): Promise<"deleting" | "verified" | "failed" | "cleanup_pending"> {
  if (!attempt) {
    await markCleanupPending(
      candidate,
      null,
      "provider cleanup has no attempt record",
      "publication_verifier_attempt_missing",
      now,
    );
    return "cleanup_pending";
  }
  if (await recoverLegacyVerifierNameFailure(candidate, attempt, now)) {
    return "deleting";
  }
  let context: ProviderContext;
  try {
    context = await providerContext(candidate, true);
  } catch (error) {
    await markCleanupPending(
      candidate,
      attempt,
      safeError(error),
      errorCode(error),
      now,
    );
    return "cleanup_pending";
  }
  const ownership = await verifierOwnership(candidate, attempt);
  let result: HcloudOperationResult;
  try {
    result = await runOperation(
      candidate,
      attempt,
      context,
      {
        kind: "reconcile",
        resources: resourceRefs(attempt, ownership),
        actionIds: [attempt.create_action_id, attempt.delete_action_id]
          .filter((value): value is string => !!value)
          .map(providerId),
      },
      now,
    );
  } catch (error) {
    if (isRetryableWait(error)) return "deleting";
    await markCleanupPending(
      candidate,
      attempt,
      safeError(error),
      errorCode(error),
      now,
    );
    return "cleanup_pending";
  }
  const reconciled = result.data as ReconcileResult;
  if (
    !hasCompleteReconcileCoverage(reconciled, attempt) ||
    hasUnsafeObservation(reconciled.resources)
  ) {
    await markCleanupPending(
      candidate,
      attempt,
      "provider resources could not be reconciled safely for cleanup",
      "publication_verifier_cleanup_unsafe",
      now,
    );
    return "cleanup_pending";
  }
  await adoptReconciledResources(candidate, attempt, reconciled, now);
  const refreshed = await requireAttempt(attempt.id);
  const present = (["server", "primary_ip", "ssh_key"] as const).find(
    (kind) => observation(reconciled, kind)?.status === "present",
  );
  if (present) {
    const pendingDeleteAction = attempt.delete_action_id
      ? reconciled.actions?.find(
          (action) => String(action.id) === attempt.delete_action_id,
        )
      : undefined;
    if (pendingDeleteAction?.status === "running") return "deleting";
    if (pendingDeleteAction?.status === "error") {
      await markCleanupPending(
        candidate,
        attempt,
        "Hetzner verifier resource deletion action failed",
        "publication_verifier_delete_action_failed",
        now,
      );
      return "cleanup_pending";
    }
    const externalId =
      present === "server"
        ? refreshed.server_id
        : present === "primary_ip"
          ? refreshed.primary_ip_id
          : refreshed.ssh_key_id;
    if (!externalId) {
      await markCleanupPending(
        candidate,
        refreshed,
        "provider cleanup resource identity is missing",
        "publication_verifier_cleanup_identity_missing",
        now,
      );
      return "cleanup_pending";
    }
    try {
      const deleted = await runOperation(
        candidate,
        refreshed,
        context,
        {
          kind: "delete_resource",
          resourceKind: present,
          externalId: providerId(externalId),
          name: resourceName(refreshed, present),
        },
        now,
      );
      const write = deleted.canonicalWrites.find(
        (entry) =>
          entry.resourceKind === present &&
          entry.externalId === providerId(externalId),
      );
      const actionId = write?.actionIds[0];
      if (actionId) {
        await persistDeleteAction(refreshed.id, actionId, now);
        const actionResult = await runOperation(
          candidate,
          await requireAttempt(refreshed.id),
          context,
          { kind: "get_action", actionId, maxWaitMs: ACTION_POLL_MS },
          now,
        );
        const action = actionResult.data as HcloudAction;
        if (action.status === "error") {
          throw appError(
            503,
            "publication_verifier_delete_action_failed",
            "Hetzner verifier resource deletion failed",
          );
        }
      }
      return "deleting";
    } catch (error) {
      if (isRetryableWait(error)) return "deleting";
      await markCleanupPending(
        candidate,
        refreshed,
        safeError(error),
        errorCode(error),
        now,
      );
      return "cleanup_pending";
    }
  }

  await confirmMissingResources(refreshed, reconciled, now);
  const proofSucceeded = refreshed.proof_verified_at !== null;
  const retry =
    !proofSucceeded &&
    refreshed.ordinal < MAX_PROVIDER_ATTEMPTS &&
    retryableAttemptFailure(refreshed.last_error_code);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE workshop_publication_provider_attempts
       SET state = 'deleted', deletion_requested_at = coalesce(deletion_requested_at, ?),
           deletion_confirmed_at = ?, report_credential_revoked_at =
             coalesce(report_credential_revoked_at, ?),
           updated_at = ?
       WHERE id = ? AND deletion_confirmed_at IS NULL`,
    ).bind(now, now, now, now, refreshed.id),
    env.DB.prepare(
      `UPDATE workshop_publication_provider_checkpoints
       SET verification_status = ?,
           deletion_confirmed_at = CASE
             WHEN ? = 'verified' THEN ?
             WHEN ? = 'failed'
               AND NOT EXISTS (
                 SELECT 1
                 FROM workshop_publication_provider_attempts attempt
                 WHERE attempt.provider_checkpoint_id =
                   workshop_publication_provider_checkpoints.id
                   AND attempt.deletion_confirmed_at IS NULL
               )
             THEN (
               SELECT max(attempt.deletion_confirmed_at)
               FROM workshop_publication_provider_attempts attempt
               WHERE attempt.provider_checkpoint_id =
                 workshop_publication_provider_checkpoints.id
             )
             ELSE NULL
           END,
           error = CASE WHEN ? = 'verified' THEN NULL ELSE error END,
           updated_at = ?
       WHERE id = ? AND verification_status IN ('deleting', 'cleanup_pending')`,
    ).bind(
      proofSucceeded ? "verified" : retry ? "pending" : "failed",
      proofSucceeded ? "verified" : retry ? "pending" : "failed",
      now,
      proofSucceeded ? "verified" : retry ? "pending" : "failed",
      proofSucceeded ? "verified" : retry ? "pending" : "failed",
      now,
      candidate.id,
    ),
    env.DB.prepare(
      `UPDATE workshop_publications
       SET provider_verification_state = 'verifying', error = NULL,
           updated_at = ?
       WHERE id = ? AND status = 'building'
         AND provider_verification_state = 'cleanup_pending'
         AND NOT EXISTS (
           SELECT 1 FROM workshop_publication_provider_checkpoints
           WHERE publication_id = ? AND verification_status = 'cleanup_pending'
         )
         AND NOT EXISTS (
           SELECT 1
           FROM workshop_publication_provider_attempts attempt
           INNER JOIN workshop_publication_provider_checkpoints checkpoint
             ON checkpoint.id = attempt.provider_checkpoint_id
           WHERE checkpoint.publication_id = ?
             AND attempt.state = 'cleanup_pending'
             AND attempt.deletion_confirmed_at IS NULL
         )`,
    ).bind(
      now,
      candidate.publication_id,
      candidate.publication_id,
      candidate.publication_id,
    ),
  ]);
  await maybeRestoreConnection(candidate.connection_id, now);
  if (proofSucceeded) {
    await finalizeVerifiedWorkshopProviderPublication({
      publicationId: candidate.publication_id,
      now,
    });
    return "verified";
  }
  if (retry) return "deleting";
  await failPublication(
    candidate,
    refreshed.error ?? "provider verification failed",
    now,
  );
  return "failed";
}

/**
 * Releases verifier attempts created before resource names used the canonical
 * `intar-` prefix. The exact provider error is raised by local name validation
 * before any Hetzner request, so this is safe only while every provider and
 * action identity is still absent.
 */
async function recoverLegacyVerifierNameFailure(
  candidate: ProviderCheckpointRow,
  attempt: ProviderAttemptRow,
  now: number,
): Promise<boolean> {
  if (!isRecoverableLegacyVerifierNameFailure(attempt)) return false;
  const deletionConfirmedAt = attempt.deletion_confirmed_at ?? now;

  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE workshop_publication_provider_attempts
       SET state = 'deleted',
           deletion_requested_at = coalesce(deletion_requested_at, ?),
           deletion_confirmed_at = ?,
           report_credential_revoked_at =
             coalesce(report_credential_revoked_at, ?),
           updated_at = ?
       WHERE id = ? AND provider_checkpoint_id = ? AND connection_id = ?
         AND state IN ('deleting', 'cleanup_pending')
         AND deterministic_name = ?
         AND ordinal < ?
         AND last_error_code = 'invalid_provider_request' AND error = ?
         AND server_id IS NULL AND primary_ip_id IS NULL
         AND primary_ipv4 IS NULL AND ssh_key_id IS NULL
         AND create_action_id IS NULL AND delete_action_id IS NULL
         AND bootstrap_consumed_at IS NULL
         AND report_credential_hash IS NULL
         AND report_credential_issued_at IS NULL
         AND checkpoint_download_token_hash IS NULL
         AND checkpoint_download_expires_at IS NULL
         AND checkpoint_first_downloaded_at IS NULL
         AND last_report_sequence = 0 AND last_report_at IS NULL
         AND proof_report_sequence IS NULL AND proof_verified_at IS NULL
         AND deletion_confirmed_at IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM workshop_publication_provider_cost_ledger ledger
           WHERE ledger.attempt_id =
             workshop_publication_provider_attempts.id
         )
         AND EXISTS (
           SELECT 1
           FROM organization_provider_connections connection
           WHERE connection.id = ?
             AND connection.state IN ('active', 'cleanup_pending')
             AND connection.active_credential_version_id IS NOT NULL
             AND connection.cleanup_acknowledged_at IS NULL
         )
         AND NOT EXISTS (
           SELECT 1 FROM hetzner_allocations allocation
           WHERE allocation.connection_id = ?
             AND allocation.deletion_confirmed_at IS NULL
         )
         AND NOT EXISTS (
           SELECT 1
           FROM workshop_publication_provider_attempts other
           WHERE other.connection_id = ?
             AND other.id <> ?
             AND other.deletion_confirmed_at IS NULL
         )`,
    ).bind(
      now,
      now,
      now,
      now,
      attempt.id,
      candidate.id,
      candidate.connection_id,
      attempt.deterministic_name,
      MAX_PROVIDER_ATTEMPTS,
      LEGACY_VERIFIER_NAME_ERROR,
      candidate.connection_id,
      candidate.connection_id,
      candidate.connection_id,
      attempt.id,
    ),
    env.DB.prepare(
      `UPDATE workshop_publication_provider_checkpoints
       SET verification_status = 'pending', deletion_confirmed_at = NULL,
           error = NULL, updated_at = ?
       WHERE id = ? AND publication_id = ? AND connection_id = ?
         AND verification_status IN ('deleting', 'cleanup_pending')
         AND EXISTS (
           SELECT 1
           FROM workshop_publication_provider_attempts attempt
           WHERE attempt.id = ?
             AND attempt.provider_checkpoint_id =
               workshop_publication_provider_checkpoints.id
             AND attempt.connection_id = ?
             AND attempt.state = 'deleted'
             AND attempt.deterministic_name = ?
             AND attempt.ordinal < ?
             AND attempt.last_error_code = 'invalid_provider_request'
             AND attempt.error = ?
             AND attempt.server_id IS NULL
             AND attempt.primary_ip_id IS NULL
             AND attempt.primary_ipv4 IS NULL
             AND attempt.ssh_key_id IS NULL
             AND attempt.create_action_id IS NULL
             AND attempt.delete_action_id IS NULL
             AND attempt.bootstrap_consumed_at IS NULL
             AND attempt.report_credential_hash IS NULL
             AND attempt.report_credential_issued_at IS NULL
             AND attempt.checkpoint_download_token_hash IS NULL
             AND attempt.checkpoint_download_expires_at IS NULL
             AND attempt.checkpoint_first_downloaded_at IS NULL
             AND attempt.last_report_sequence = 0
             AND attempt.last_report_at IS NULL
             AND attempt.proof_report_sequence IS NULL
             AND attempt.proof_verified_at IS NULL
             AND attempt.deletion_confirmed_at = ?
             AND NOT EXISTS (
               SELECT 1
               FROM workshop_publication_provider_cost_ledger ledger
               WHERE ledger.attempt_id = attempt.id
             )
             AND EXISTS (
               SELECT 1
               FROM organization_provider_connections connection
               WHERE connection.id = ?
                 AND connection.state IN ('active', 'cleanup_pending')
                 AND connection.active_credential_version_id IS NOT NULL
                 AND connection.cleanup_acknowledged_at IS NULL
             )
             AND NOT EXISTS (
               SELECT 1 FROM hetzner_allocations allocation
               WHERE allocation.connection_id = ?
                 AND allocation.deletion_confirmed_at IS NULL
             )
             AND NOT EXISTS (
               SELECT 1
               FROM workshop_publication_provider_attempts other
               WHERE other.connection_id = ?
                 AND other.id <> attempt.id
                 AND other.deletion_confirmed_at IS NULL
             )
         )`,
    ).bind(
      now,
      candidate.id,
      candidate.publication_id,
      candidate.connection_id,
      attempt.id,
      candidate.connection_id,
      attempt.deterministic_name,
      MAX_PROVIDER_ATTEMPTS,
      LEGACY_VERIFIER_NAME_ERROR,
      deletionConfirmedAt,
      candidate.connection_id,
      candidate.connection_id,
      candidate.connection_id,
    ),
    env.DB.prepare(
      `UPDATE workshop_publications
       SET provider_verification_state = 'verifying', error = NULL,
           updated_at = ?
       WHERE id = ? AND status = 'building'
         AND provider_verification_state = 'cleanup_pending'
         AND NOT EXISTS (
           SELECT 1 FROM workshop_publication_provider_checkpoints
           WHERE publication_id = ? AND verification_status = 'cleanup_pending'
         )
         AND NOT EXISTS (
           SELECT 1
           FROM workshop_publication_provider_attempts attempt
           INNER JOIN workshop_publication_provider_checkpoints checkpoint
             ON checkpoint.id = attempt.provider_checkpoint_id
           WHERE checkpoint.publication_id = ?
             AND attempt.state = 'cleanup_pending'
             AND attempt.deletion_confirmed_at IS NULL
         )`,
    ).bind(
      now,
      candidate.publication_id,
      candidate.publication_id,
      candidate.publication_id,
    ),
  ]);

  const refreshedAttempt = await requireAttempt(attempt.id);
  const refreshedCheckpoint = await checkpointById(candidate.id);
  const recovered =
    refreshedAttempt.state === "deleted" &&
    refreshedAttempt.deletion_confirmed_at !== null &&
    refreshedCheckpoint?.verification_status === "pending";
  if (!recovered) {
    // Never send a locally terminalized legacy name back to the provider. If a
    // later statement lost its fence, the next sweep can resume this helper
    // from the persisted deletion marker.
    return (
      results.some((result) => result.meta.changes > 0) ||
      refreshedAttempt.state === "deleted"
    );
  }
  await maybeRestoreConnection(candidate.connection_id, now);
  return true;
}

function isRecoverableLegacyVerifierNameFailure(
  attempt: ProviderAttemptRow,
): boolean {
  const recoverableState =
    ((attempt.state === "deleting" || attempt.state === "cleanup_pending") &&
      attempt.deletion_confirmed_at === null) ||
    (attempt.state === "deleted" && attempt.deletion_confirmed_at !== null);
  return (
    recoverableState &&
    LEGACY_VERIFIER_NAME_PATTERN.test(attempt.deterministic_name) &&
    attempt.deterministic_name === `iwpv-${attempt.id}` &&
    attempt.ordinal < MAX_PROVIDER_ATTEMPTS &&
    attempt.last_error_code === "invalid_provider_request" &&
    attempt.error === LEGACY_VERIFIER_NAME_ERROR &&
    attempt.server_id === null &&
    attempt.primary_ip_id === null &&
    attempt.primary_ipv4 === null &&
    attempt.ssh_key_id === null &&
    attempt.create_action_id === null &&
    attempt.delete_action_id === null &&
    attempt.bootstrap_consumed_at === null &&
    attempt.report_credential_hash === null &&
    attempt.report_credential_issued_at === null &&
    attempt.checkpoint_download_token_hash === null &&
    attempt.checkpoint_download_expires_at === null &&
    attempt.checkpoint_first_downloaded_at === null &&
    attempt.last_report_sequence === 0 &&
    attempt.last_report_at === null &&
    attempt.proof_report_sequence === null &&
    attempt.proof_verified_at === null
  );
}

async function runOperation(
  candidate: ProviderCheckpointRow,
  attempt: ProviderAttemptRow,
  context: ProviderContext,
  operation: HcloudOperation,
  now: number,
): Promise<HcloudOperationResult> {
  const result = await hcloudRunOperation({
    requestId: createAppId(),
    connectionId: context.connection.id,
    credentialContext: context.credential.context,
    credential: context.credential.envelope,
    operation,
  });
  if (result.mustPersistBeforeNextOperation || result.canonicalWrites.length) {
    await persistCanonicalWrites(
      candidate,
      attempt,
      result.canonicalWrites,
      now,
    );
  }
  return result;
}

async function createOrReconcileResource(input: {
  candidate: ProviderCheckpointRow;
  attempt: ProviderAttemptRow;
  context: ProviderContext;
  operation: HcloudOperation;
  resourceKind: "server" | "primary_ip" | "ssh_key";
  deterministicName: string;
  ownership: OwnershipLabels;
  now: number;
}): Promise<HcloudOperationResult> {
  try {
    return await runOperation(
      input.candidate,
      input.attempt,
      input.context,
      input.operation,
      input.now,
    );
  } catch (error) {
    if (!isRetryableWait(error)) throw error;
    const reconciled = await runOperation(
      input.candidate,
      input.attempt,
      input.context,
      {
        kind: "reconcile",
        resources: [
          {
            resourceKind: input.resourceKind,
            deterministicName: input.deterministicName,
            ownership: input.ownership,
          },
        ],
        actionIds: [],
      },
      input.now,
    );
    const resource = (reconciled.data as ReconcileResult).resources[0];
    if (resource?.status === "present") return reconciled;
    if (
      resource?.status === "ambiguous" ||
      resource?.status === "ownership_mismatch"
    ) {
      throw appError(
        409,
        "publication_verifier_reconcile_unsafe",
        "provider resource creation could not be reconciled safely",
      );
    }
    throw error;
  }
}

async function persistCanonicalWrites(
  candidate: ProviderCheckpointRow,
  attempt: ProviderAttemptRow,
  writes: readonly CanonicalProviderWrite[],
  _fallbackNow: number,
): Promise<void> {
  for (const write of writes) {
    if (write.connectionId !== candidate.connection_id) {
      throw appError(
        502,
        "publication_verifier_provider_identity_invalid",
        "provider write belongs to another connection",
      );
    }
    const observedAt = providerTimestamp(write.observedAt);
    if (
      write.operation === "resource_created" ||
      write.operation === "resource_observed"
    ) {
      if (
        write.resourceKind === "server" ||
        write.resourceKind === "primary_ip" ||
        write.resourceKind === "ssh_key"
      ) {
        await persistIdentityBeforeNext(
          attempt.id,
          write.resourceKind,
          write.externalId,
          write.publicIpv4,
          write.actionIds,
          observedAt,
        );
        if (
          write.resourceKind === "server" ||
          write.resourceKind === "primary_ip"
        ) {
          await insertCostLedger(
            candidate,
            attempt,
            write.resourceKind,
            write.externalId,
            providerTimestamp(write.resourceCreatedAt ?? write.observedAt),
          );
        }
      }
    } else if (write.operation === "resource_deletion_requested") {
      const actionId = write.actionIds[0];
      if (actionId) await persistDeleteAction(attempt.id, actionId, observedAt);
    }
    await env.DB.prepare(
      `INSERT INTO provider_audit_events (
         id, organization_id, connection_id, type, payload_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        createAppId(),
        candidate.organization_id,
        candidate.connection_id,
        `provider.${write.operation}`,
        JSON.stringify({
          publicationId: candidate.publication_id,
          providerCheckpointId: candidate.id,
          attemptId: attempt.id,
          requestId: write.requestId,
          resourceKind: write.resourceKind,
          externalId: String(write.externalId),
          actionIds: write.actionIds.map(String),
          state: write.state ?? null,
        }),
        observedAt,
      )
      .run();
  }
}

async function persistIdentityBeforeNext(
  attemptId: string,
  kind: "server" | "primary_ip" | "ssh_key",
  externalId: number,
  publicIpv4: string | undefined,
  actionIds: number[],
  now: number,
): Promise<void> {
  const column =
    kind === "server"
      ? "server_id"
      : kind === "primary_ip"
        ? "primary_ip_id"
        : "ssh_key_id";
  const result = await env.DB.prepare(
    `UPDATE workshop_publication_provider_attempts
     SET ${column} = ?,
         primary_ipv4 = CASE
           WHEN ? = 'primary_ip' AND ? IS NOT NULL THEN ?
           ELSE primary_ipv4
         END,
         create_action_id = CASE
           WHEN ? = 'server' AND ? IS NOT NULL THEN ?
           ELSE create_action_id
         END,
         updated_at = max(updated_at, ?)
     WHERE id = ?`,
  )
    .bind(
      String(externalId),
      kind,
      publicIpv4 ?? null,
      publicIpv4 ?? null,
      kind,
      actionIds[0] ?? null,
      actionIds[0] === undefined ? null : String(actionIds[0]),
      now,
      attemptId,
    )
    .run();
  if (result.meta.changes !== 1) {
    throw appError(
      409,
      "publication_verifier_attempt_lost",
      "provider verifier attempt no longer exists",
    );
  }
}

async function insertCostLedger(
  candidate: ProviderCheckpointRow,
  attempt: ProviderAttemptRow,
  kind: "server" | "primary_ip",
  externalId: number,
  providerCreatedAt: number,
): Promise<void> {
  const observation = parsePriceObservation(candidate.price_observation_json);
  const location = observation.locations.find(
    (entry) => entry.location === attempt.location,
  );
  if (!location) {
    throw appError(
      409,
      "publication_verifier_price_missing",
      "the verifier location price observation is missing",
    );
  }
  const server = kind === "server";
  const hourlyNetRaw = server
    ? location.serverHourlyNet
    : location.ipv4HourlyNet;
  const hourlyGrossRaw = server
    ? location.serverHourlyGross
    : location.ipv4HourlyGross;
  const monthlyNetRaw = server
    ? location.serverMonthlyNet
    : location.ipv4MonthlyNet;
  const monthlyGrossRaw = server
    ? location.serverMonthlyGross
    : location.ipv4MonthlyGross;
  await env.DB.prepare(
    `INSERT INTO workshop_publication_provider_cost_ledger (
       id, attempt_id, provider_resource_id, resource_kind, resource_type,
       location, currency, hourly_net_raw, hourly_gross_raw,
       hourly_net_micros, hourly_gross_micros, monthly_net_raw,
       monthly_gross_raw, monthly_net_micros, monthly_gross_micros,
       provider_created_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (attempt_id, resource_kind, provider_resource_id) DO NOTHING`,
  )
    .bind(
      createAppId(),
      attempt.id,
      String(externalId),
      server ? "server" : "primary_ipv4",
      server ? attempt.server_type : "ipv4",
      attempt.location,
      observation.currency,
      hourlyNetRaw,
      hourlyGrossRaw,
      decimalCurrencyToMicros(hourlyNetRaw),
      decimalCurrencyToMicros(hourlyGrossRaw),
      monthlyNetRaw ?? null,
      monthlyGrossRaw ?? null,
      monthlyNetRaw === undefined
        ? null
        : decimalCurrencyToMicros(monthlyNetRaw),
      monthlyGrossRaw === undefined
        ? null
        : decimalCurrencyToMicros(monthlyGrossRaw),
      providerCreatedAt,
      providerCreatedAt,
      providerCreatedAt,
    )
    .run();
}

async function adoptReconciledResources(
  candidate: ProviderCheckpointRow,
  attempt: ProviderAttemptRow,
  reconciled: ReconcileResult,
  _now: number,
): Promise<void> {
  const observedAt = providerTimestamp(reconciled.observedAt);
  for (const resource of reconciled.resources) {
    if (
      resource.status !== "present" ||
      (resource.ref.resourceKind !== "server" &&
        resource.ref.resourceKind !== "primary_ip" &&
        resource.ref.resourceKind !== "ssh_key")
    ) {
      continue;
    }
    const externalId = resource.externalId ?? resource.ref.externalId;
    if (!externalId) continue;
    await persistIdentityBeforeNext(
      attempt.id,
      resource.ref.resourceKind,
      externalId,
      resource.publicIpv4,
      [],
      observedAt,
    );
    if (
      resource.ref.resourceKind === "server" ||
      resource.ref.resourceKind === "primary_ip"
    ) {
      await insertCostLedger(
        candidate,
        attempt,
        resource.ref.resourceKind,
        externalId,
        providerTimestamp(resource.resourceCreatedAt ?? reconciled.observedAt),
      );
    }
  }
}

async function confirmMissingResources(
  attempt: ProviderAttemptRow,
  reconciled: ReconcileResult,
  _now: number,
): Promise<void> {
  const observedAt = providerTimestamp(reconciled.observedAt);
  for (const kind of ["server", "primary_ip"] as const) {
    const resource = observation(reconciled, kind);
    const externalId =
      kind === "server" ? attempt.server_id : attempt.primary_ip_id;
    if (resource?.status !== "missing" || !externalId) continue;
    await env.DB.prepare(
      `UPDATE workshop_publication_provider_cost_ledger
       SET deletion_confirmed_at = coalesce(deletion_confirmed_at, ?),
           updated_at = max(updated_at, ?)
       WHERE attempt_id = ? AND resource_kind = ?
         AND provider_resource_id = ?`,
    )
      .bind(
        observedAt,
        observedAt,
        attempt.id,
        kind === "server" ? "server" : "primary_ipv4",
        externalId,
      )
      .run();
  }
}

async function markBootstrapping(
  candidate: ProviderCheckpointRow,
  attemptId: string,
  now: number,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE workshop_publication_provider_attempts
       SET state = 'bootstrapping', updated_at = ?
       WHERE id = ? AND state = 'allocating'`,
    ).bind(now, attemptId),
    env.DB.prepare(
      `UPDATE workshop_publication_provider_checkpoints
       SET verification_status = 'bootstrapping', updated_at = ?
       WHERE id = ? AND verification_status = 'allocating'`,
    ).bind(now, candidate.id),
  ]);
}

async function mirrorAttemptState(
  candidate: ProviderCheckpointRow,
  attempt: ProviderAttemptRow,
  now: number,
): Promise<void> {
  const state = attempt.state === "applying" ? "applying" : "bootstrapping";
  await env.DB.prepare(
    `UPDATE workshop_publication_provider_checkpoints
     SET verification_status = ?, updated_at = ?
     WHERE id = ? AND verification_status IN ('allocating', 'bootstrapping', 'applying')`,
  )
    .bind(state, now, candidate.id)
    .run();
}

async function failAttemptForCleanup(
  candidate: ProviderCheckpointRow,
  attempt: ProviderAttemptRow,
  message: string,
  code: string,
  now: number,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE workshop_publication_provider_attempts
       SET state = 'deleting', last_error_code = ?, error = ?,
           report_credential_revoked_at = coalesce(report_credential_revoked_at, ?),
           bootstrap_expires_at = min(bootstrap_expires_at, ?),
           checkpoint_download_expires_at = CASE
             WHEN checkpoint_download_expires_at IS NULL THEN NULL
             ELSE min(checkpoint_download_expires_at, ?)
           END,
           deletion_requested_at = coalesce(deletion_requested_at, ?),
           updated_at = ?
       WHERE id = ? AND state <> 'deleted'`,
    ).bind(code, message.slice(0, 500), now, now, now, now, now, attempt.id),
    env.DB.prepare(
      `UPDATE workshop_publication_provider_checkpoints
       SET verification_status = 'deleting', error = ?, updated_at = ?
       WHERE id = ? AND verification_status <> 'verified'`,
    ).bind(message.slice(0, 500), now, candidate.id),
  ]);
}

async function markCleanupPending(
  candidate: ProviderCheckpointRow,
  attempt: ProviderAttemptRow | null,
  message: string,
  code: string,
  now: number,
): Promise<void> {
  const statements = [
    ...(attempt
      ? [
          env.DB.prepare(
            `UPDATE workshop_publication_provider_attempts
             SET state = 'cleanup_pending', last_error_code = ?, error = ?,
                 report_credential_revoked_at =
                   coalesce(report_credential_revoked_at, ?),
                 deletion_requested_at = coalesce(deletion_requested_at, ?),
                 updated_at = ?
             WHERE id = ? AND state <> 'deleted'`,
          ).bind(code, message.slice(0, 500), now, now, now, attempt.id),
        ]
      : []),
    env.DB.prepare(
      `UPDATE workshop_publication_provider_checkpoints
       SET verification_status = 'cleanup_pending', error = ?, updated_at = ?
       WHERE id = ? AND verification_status <> 'verified'`,
    ).bind(message.slice(0, 500), now, candidate.id),
    env.DB.prepare(
      `UPDATE workshop_publications
       SET provider_verification_state = 'cleanup_pending', error = ?,
           updated_at = ?
       WHERE id = ? AND status = 'building'`,
    ).bind(message.slice(0, 500), now, candidate.publication_id),
    env.DB.prepare(
      `UPDATE organization_provider_connections
       SET state = 'cleanup_pending', updated_at = ?
       WHERE id = ? AND state = 'active'`,
    ).bind(now, candidate.connection_id),
  ];
  await env.DB.batch(statements);
}

async function failCheckpointWithoutAttempt(
  candidate: ProviderCheckpointRow,
  message: string,
  now: number,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE workshop_publication_provider_checkpoints
       SET verification_status = 'failed', error = ?, updated_at = ?
       WHERE id = ? AND verification_status = 'pending'`,
    ).bind(message.slice(0, 500), now, candidate.id),
    env.DB.prepare(
      `UPDATE workshop_publications
       SET status = 'failed', provider_verification_state = 'failed', error = ?,
           finished_at = ?, updated_at = ?
       WHERE id = ? AND status = 'building'
         AND provider_verification_state = 'verifying'`,
    ).bind(message.slice(0, 500), now, now, candidate.publication_id),
  ]);
}

async function failPublication(
  candidate: ProviderCheckpointRow,
  message: string,
  now: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE workshop_publications
     SET status = 'failed', provider_verification_state = 'failed', error = ?,
         finished_at = ?, updated_at = ?
     WHERE id = ? AND status = 'building'
       AND provider_verification_state IN ('verifying', 'cleanup_pending')`,
  )
    .bind(message.slice(0, 500), now, now, candidate.publication_id)
    .run();
}

async function maybeRestoreConnection(
  connectionId: string,
  now: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE organization_provider_connections
     SET state = 'active', updated_at = ?
     WHERE id = ? AND state = 'cleanup_pending'
       AND active_credential_version_id IS NOT NULL
       AND cleanup_acknowledged_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM hetzner_allocations
         WHERE connection_id = ? AND deletion_confirmed_at IS NULL
       )
       AND NOT EXISTS (
         SELECT 1 FROM workshop_publication_provider_attempts
         WHERE connection_id = ? AND deletion_confirmed_at IS NULL
       )`,
  )
    .bind(now, connectionId, connectionId, connectionId)
    .run();
}

async function nextCheckpoints(
  limit: number,
): Promise<ProviderCheckpointRow[]> {
  const rows = await env.DB.prepare(
    `SELECT
       checkpoint.id, checkpoint.publication_id,
       publication.organization_id, checkpoint.checkpoint_id,
       checkpoint.ordinal, checkpoint.expected_probes_json,
       checkpoint.connection_id, checkpoint.resolved_provider_json,
       checkpoint.permitted_locations_json, checkpoint.price_observation_json,
       checkpoint.r2_key, checkpoint.sha256, checkpoint.size_bytes,
       checkpoint.workspace_agent_sha256, checkpoint.kino_sha256,
       checkpoint.verification_status
     FROM workshop_publication_provider_checkpoints checkpoint
     INNER JOIN workshop_publications publication
       ON publication.id = checkpoint.publication_id
      AND publication.status = 'building'
      AND publication.provider_verification_state IN ('verifying', 'cleanup_pending')
     WHERE checkpoint.verification_status <> 'verified'
       AND NOT EXISTS (
         SELECT 1 FROM workshop_publication_provider_checkpoints prior
         WHERE prior.publication_id = checkpoint.publication_id
           AND prior.ordinal < checkpoint.ordinal
           AND prior.verification_status <> 'verified'
       )
     ORDER BY checkpoint.updated_at ASC, publication.created_at ASC,
              checkpoint.ordinal ASC
     LIMIT ?`,
  )
    .bind(limit)
    .all<ProviderCheckpointRow>();
  return rows.results;
}

async function deferCheckpointCandidate(
  id: string,
  now: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE workshop_publication_provider_checkpoints
     SET updated_at = max(updated_at + 1, ?)
     WHERE id = ? AND verification_status <> 'verified'`,
  )
    .bind(now, id)
    .run();
}

async function checkpointById(
  checkpointDatabaseId: string,
): Promise<ProviderCheckpointRow | null> {
  return env.DB.prepare(
    `SELECT
       checkpoint.id, checkpoint.publication_id,
       publication.organization_id, checkpoint.checkpoint_id,
       checkpoint.ordinal, checkpoint.expected_probes_json,
       checkpoint.connection_id, checkpoint.resolved_provider_json,
       checkpoint.permitted_locations_json, checkpoint.price_observation_json,
       checkpoint.r2_key, checkpoint.sha256, checkpoint.size_bytes,
       checkpoint.workspace_agent_sha256, checkpoint.kino_sha256,
       checkpoint.verification_status
     FROM workshop_publication_provider_checkpoints checkpoint
     INNER JOIN workshop_publications publication
       ON publication.id = checkpoint.publication_id
      AND publication.status = 'building'
      AND publication.provider_verification_state IN ('verifying', 'cleanup_pending')
     WHERE checkpoint.id = ? AND checkpoint.verification_status <> 'verified'
       AND NOT EXISTS (
         SELECT 1 FROM workshop_publication_provider_checkpoints prior
         WHERE prior.publication_id = checkpoint.publication_id
           AND prior.ordinal < checkpoint.ordinal
           AND prior.verification_status <> 'verified'
       )
     LIMIT 1`,
  )
    .bind(checkpointDatabaseId)
    .first<ProviderCheckpointRow>();
}

async function latestAttempt(
  checkpointId: string,
): Promise<ProviderAttemptRow | null> {
  return env.DB.prepare(
    `SELECT * FROM workshop_publication_provider_attempts
     WHERE provider_checkpoint_id = ?
     ORDER BY ordinal DESC LIMIT 1`,
  )
    .bind(checkpointId)
    .first<ProviderAttemptRow>();
}

async function requireAttempt(id: string): Promise<ProviderAttemptRow> {
  const attempt = await env.DB.prepare(
    "SELECT * FROM workshop_publication_provider_attempts WHERE id = ?",
  )
    .bind(id)
    .first<ProviderAttemptRow>();
  if (!attempt) {
    throw appError(
      409,
      "publication_verifier_attempt_lost",
      "provider verifier attempt no longer exists",
    );
  }
  return attempt;
}

async function maxAttemptOrdinal(checkpointId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT coalesce(max(ordinal), 0) AS ordinal
     FROM workshop_publication_provider_attempts
     WHERE provider_checkpoint_id = ?`,
  )
    .bind(checkpointId)
    .first<{ ordinal: number }>();
  return row?.ordinal ?? 0;
}

async function finalizeOneReadyPublication(
  now: number,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT publication.id
     FROM workshop_publications publication
     WHERE publication.status = 'building'
       AND publication.provider_verification_state = 'verifying'
       AND EXISTS (
         SELECT 1 FROM workshop_publication_provider_checkpoints checkpoint
         WHERE checkpoint.publication_id = publication.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM workshop_publication_provider_checkpoints checkpoint
         WHERE checkpoint.publication_id = publication.id
           AND checkpoint.verification_status <> 'verified'
       )
     ORDER BY publication.created_at ASC LIMIT 1`,
  ).first<{ id: string }>();
  if (!row) return null;
  const finalized = await finalizeVerifiedWorkshopProviderPublication({
    publicationId: row.id,
    now,
  });
  return finalized ? row.id : null;
}

async function providerContext(
  candidate: ProviderCheckpointRow,
  cleanup = false,
): Promise<ProviderContext> {
  const connection = await requireConnection(
    candidate.organization_id,
    candidate.connection_id,
  );
  if (
    cleanup
      ? connection.state === "disconnected"
      : connection.state !== "active"
  ) {
    throw appError(
      409,
      "provider_connection_inactive",
      "the Hetzner provider connection is inactive",
    );
  }
  return {
    connection,
    credential: await loadActiveCredential(connection),
  };
}

async function verifierOwnership(
  candidate: ProviderCheckpointRow,
  attempt: ProviderAttemptRow,
): Promise<OwnershipLabels> {
  return workshopPublicationVerifierOwnershipLabels(
    candidate.organization_id,
    candidate.connection_id,
    candidate.publication_id,
    candidate.id,
    attempt.ordinal,
  );
}

function resourceRefs(attempt: ProviderAttemptRow, ownership: OwnershipLabels) {
  return (["ssh_key", "primary_ip", "server"] as const).map((resourceKind) => {
    const externalId =
      resourceKind === "server"
        ? attempt.server_id
        : resourceKind === "primary_ip"
          ? attempt.primary_ip_id
          : attempt.ssh_key_id;
    return {
      resourceKind,
      ...(externalId ? { externalId: providerId(externalId) } : {}),
      deterministicName: resourceName(attempt, resourceKind),
      ownership,
    };
  });
}

function resourceName(
  attempt: ProviderAttemptRow,
  kind: "server" | "primary_ip" | "ssh_key",
): string {
  if (kind === "server") return attempt.deterministic_name;
  if (kind === "ssh_key") return `${attempt.deterministic_name}-key`;
  return `${attempt.deterministic_name}-ip-${attempt.location}`;
}

function resourceIdentity(
  result: HcloudOperationResult,
  kind: "server" | "primary_ip" | "ssh_key",
): {
  externalId: number;
  publicIpv4?: string;
  actionIds: number[];
} {
  const write = result.canonicalWrites.find(
    (entry) =>
      entry.resourceKind === kind &&
      (entry.operation === "resource_created" ||
        entry.operation === "resource_observed"),
  );
  if (write) {
    return {
      externalId: write.externalId,
      ...(write.publicIpv4 ? { publicIpv4: write.publicIpv4 } : {}),
      actionIds: write.actionIds,
    };
  }
  const reconciled = result.data as ReconcileResult;
  const resource = observation(reconciled, kind);
  const externalId = resource?.externalId ?? resource?.ref.externalId;
  if (resource?.status === "present" && externalId) {
    return {
      externalId,
      ...(resource.publicIpv4 ? { publicIpv4: resource.publicIpv4 } : {}),
      actionIds: [],
    };
  }
  throw appError(
    502,
    "publication_verifier_resource_identity_missing",
    "provider resource identity is missing",
  );
}

function observation(
  result: ReconcileResult,
  kind: "server" | "primary_ip" | "ssh_key",
): ResourceObservation | undefined {
  return result.resources?.find((entry) => entry.ref.resourceKind === kind);
}

function hasUnsafeObservation(resources: ResourceObservation[]): boolean {
  return resources.some(
    (resource) =>
      resource.status === "ambiguous" ||
      resource.status === "ownership_mismatch",
  );
}

function hasCompleteReconcileCoverage(
  result: ReconcileResult,
  attempt: ProviderAttemptRow,
): boolean {
  if (!Array.isArray(result.resources) || result.resources.length !== 3) {
    return false;
  }
  const seen = new Set<string>();
  for (const resource of result.resources) {
    const kind = resource.ref?.resourceKind;
    if (
      (kind !== "server" && kind !== "primary_ip" && kind !== "ssh_key") ||
      seen.has(kind) ||
      resource.ref.deterministicName !== resourceName(attempt, kind) ||
      (resource.status !== "present" && resource.status !== "missing")
    ) {
      return false;
    }
    const expectedId =
      kind === "server"
        ? attempt.server_id
        : kind === "primary_ip"
          ? attempt.primary_ip_id
          : attempt.ssh_key_id;
    const effectiveId = resource.externalId ?? resource.ref.externalId;
    if (
      expectedId &&
      ((resource.ref.externalId !== undefined &&
        String(resource.ref.externalId) !== expectedId) ||
        (effectiveId !== undefined && String(effectiveId) !== expectedId))
    ) {
      return false;
    }
    if (
      resource.status === "present" &&
      (!Number.isSafeInteger(effectiveId) || Number(effectiveId) <= 0)
    ) {
      return false;
    }
    seen.add(kind);
  }
  return seen.size === 3;
}

async function persistDeleteAction(
  attemptId: string,
  actionId: number,
  now: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE workshop_publication_provider_attempts
     SET delete_action_id = ?, deletion_requested_at =
       coalesce(deletion_requested_at, ?), updated_at = max(updated_at, ?)
     WHERE id = ?`,
  )
    .bind(String(actionId), now, now, attemptId)
    .run();
}

async function resolveGuestTools(
  candidate: ProviderCheckpointRow,
  _baseUrl: string,
): Promise<void> {
  if (
    !isSha256(candidate.workspace_agent_sha256) ||
    !isSha256(candidate.kino_sha256)
  ) {
    throw appError(
      503,
      "publication_verifier_guest_tools_invalid",
      "the verifier guest-tool pins are invalid",
    );
  }
  const [agent, kino] = await Promise.all([
    env.VM_IMAGE_REGISTRY_BUCKET.head(
      `workspace-agent/releases/${candidate.workspace_agent_sha256}/intar-workspace-agent`,
    ),
    env.VM_IMAGE_REGISTRY_BUCKET.head(
      `workspace-agent/kino/releases/${candidate.kino_sha256}/kino`,
    ),
  ]);
  if (
    !agent ||
    agent.size <= 0 ||
    agent.size > 128 * 1024 * 1024 ||
    !kino ||
    kino.size <= 0 ||
    kino.size > 128 * 1024 * 1024
  ) {
    throw appError(
      503,
      "publication_verifier_guest_tools_unavailable",
      "the pinned verifier guest tools are unavailable",
    );
  }
}

async function verifyCheckpointArtifact(
  candidate: ProviderCheckpointRow,
): Promise<void> {
  const object = await env.VM_IMAGE_REGISTRY_BUCKET.head(candidate.r2_key);
  if (!object) {
    throw appError(
      503,
      "publication_verifier_checkpoint_unavailable",
      "the staged verifier checkpoint is unavailable",
    );
  }
  if (
    !isSha256(candidate.sha256) ||
    object.size !== candidate.size_bytes ||
    object.customMetadata?.artifact_sha256 !== candidate.sha256
  ) {
    throw appError(
      409,
      "publication_verifier_checkpoint_invalid",
      "the staged verifier checkpoint metadata no longer matches",
    );
  }
}

function requiredControlPlaneBaseUrl(): string {
  const value =
    (
      env as Cloudflare.Env & {
        WORKSPACE_AGENT_CONTROL_PLANE_URL?: string;
      }
    ).WORKSPACE_AGENT_CONTROL_PLANE_URL?.trim() ?? env.BETTER_AUTH_URL?.trim();
  if (!value) {
    throw appError(
      503,
      "publication_verifier_control_plane_missing",
      "the verifier control-plane URL is not configured",
    );
  }
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw appError(
      500,
      "publication_verifier_control_plane_invalid",
      "the verifier control-plane URL is invalid",
    );
  }
  return `${url.origin}/`;
}

function parseResolvedProvider(
  value: string | ResolvedProvider,
): ResolvedProvider {
  const provider = parseJson(value, "resolved provider") as ResolvedProvider;
  if (
    provider?.kind !== "hetzner_cloud" ||
    !provider.serverType ||
    !provider.systemImage ||
    provider.hardware?.architecture !== "x86"
  ) {
    throw appError(
      409,
      "publication_verifier_provider_invalid",
      "the staged provider configuration is invalid",
    );
  }
  return provider;
}

function parsePriceObservation(
  value: string | ProviderPriceObservation,
): ProviderPriceObservation {
  const observation = parseJson(value, "price observation") as
    | ProviderPriceObservation
    | undefined;
  if (
    !observation?.currency ||
    !observation.serverType ||
    !Array.isArray(observation.locations)
  ) {
    throw appError(
      409,
      "publication_verifier_price_invalid",
      "the staged provider price observation is invalid",
    );
  }
  return observation;
}

function parseExpectedProbes(
  value: ProviderCheckpointRow["expected_probes_json"],
): Array<{ moduleId: string; probeId: string }> {
  const probes = parseJson(value, "expected probes");
  if (
    !Array.isArray(probes) ||
    probes.some(
      (entry) =>
        !entry ||
        typeof entry !== "object" ||
        typeof (entry as Record<string, unknown>).moduleId !== "string" ||
        typeof (entry as Record<string, unknown>).probeId !== "string",
    )
  ) {
    throw appError(
      409,
      "publication_verifier_probes_invalid",
      "the staged expected probes are invalid",
    );
  }
  return probes as Array<{ moduleId: string; probeId: string }>;
}

function parseStringArray(value: string | string[], label: string): string[] {
  const parsed = parseJson(value, label);
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    throw appError(
      409,
      "publication_verifier_configuration_invalid",
      `the staged ${label} are invalid`,
    );
  }
  return parsed as string[];
}

function parseJson(value: unknown, label: string): unknown {
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw appError(
      409,
      "publication_verifier_configuration_invalid",
      `the staged ${label} are invalid`,
    );
  }
}

function sameHardware(
  left: ProviderHardwareShape,
  right: ProviderHardwareShape,
): boolean {
  return (
    left.architecture === right.architecture &&
    left.cores === right.cores &&
    left.memoryMib === right.memoryMib &&
    left.diskMib === right.diskMib
  );
}

function providerId(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw appError(
      502,
      "publication_verifier_provider_id_invalid",
      "provider resource identity is invalid",
    );
  }
  return id;
}

function providerTimestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw appError(
      502,
      "publication_verifier_provider_time_invalid",
      "provider write has an invalid timestamp",
    );
  }
  return parsed;
}

function timestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("now must be a positive Unix millisecond timestamp");
  }
  return value;
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function isRetryableWait(error: unknown): boolean {
  return (
    error instanceof AppError &&
    (error.status === 429 ||
      error.status === 503 ||
      error.code === "runtime_allocation_busy" ||
      error.code === "hcloud_concurrency_limit_reached")
  );
}

function retryableAttemptFailure(code: string | null): boolean {
  return (
    code === "hcloud_transport_error" ||
    code === "hcloud_resource_unavailable" ||
    code === "hcloud_rate_limited" ||
    code === "publication_verifier_allocation_interrupted" ||
    code === "publication_verifier_bootstrap_expired" ||
    code === "publication_verifier_report_expired" ||
    code === "publication_verifier_probe_persisted" ||
    code === "publication_verifier_create_action_failed"
  );
}

function safeError(error: unknown): string {
  if (error instanceof AppError) return error.message.slice(0, 500);
  return "Hetzner publication verification failed";
}

function errorCode(error: unknown): string {
  return error instanceof AppError
    ? error.code.slice(0, 128)
    : "publication_verifier_failed";
}

function randomCapability(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const encoded = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  return `${prefix}_${createAppId()}_${encoded}`;
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
