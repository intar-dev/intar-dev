import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type {
  CanonicalProviderWrite,
  HcloudAction,
  HcloudOperation,
  HcloudOperationResult,
  OwnershipLabels,
  ReconcileResult,
} from "../../../../hcloud-provider-worker/src/contracts";
import {
  hetznerAllocations,
  providerAuditEvents,
  runtimeProviderCheckpointArtifacts,
  runtimeProviderCostLedger,
  workshopSessionRuntimeProviders,
  type WorkshopManifestV1,
} from "@/db/schema";
import { AppError, appError } from "@/lib/app-error";
import { hcloudRunOperation } from "@/lib/hcloud-provider-service";
import { createAppId } from "@/lib/id";
import {
  archiveRuntimeExecution,
  createRuntimeExecution,
  createRuntimeRecoveryGeneration,
  loadRuntimeExecutionHandle,
  updateRuntimeExecutionState,
  type RuntimeExecutionHandle,
  type RuntimeVmSpec,
} from "@/lib/runtime-executions";
import { ensureRuntimeVmAccessKeys } from "@/lib/runtime-vm-state";
import {
  deleteStargateRoute,
  deleteStargateWorkspaceAppRoute,
} from "@/lib/stargate";
import {
  runtimeCapacityAllocationKey,
  withRuntimeAllocationLock,
} from "@/lib/runtime-allocation-lock";
import { decimalCurrencyToMicros } from "./costs";
import { requireWorkshopHcloudRuntimeEnabledForOrganization } from "./feature-flag";
import {
  finalizeWorkshopCostSummary,
  getWorkshopCostProjection,
  loadLatestWorkshopCostForecast,
  type StoredWorkshopCostForecast,
} from "./cost-storage";
import {
  countLiveHetznerAllocations,
  loadActiveCredential,
  ownershipLabels,
  requireConnection,
} from "./provider-connections";
import { recordWorkshopGenerationState } from "./provisioning";
import { revokeWorkshopRouteIssuanceIntents } from "./route-issuance-intents";
import { refreshWorkshopSessionProviderPreflight } from "./session-provider";
import type { WorkshopProvisioningRequest } from "./types";
import {
  buildWorkspaceAgentCloudInit,
  issueWorkspaceAgentBootstrap,
  revokeWorkspaceAgentGeneration,
} from "./workspace-agent-control-plane";

const REPORT_DEGRADED_AFTER_MS = 45_000;
const REPORT_RECOVERY_AFTER_MS = 90_000;
const REBOOT_RECOVERY_WAIT_MS = 3 * 60_000;
const PROVISIONING_CLAIM_STALE_MS = 2 * 60_000;
const RECORDING_DRAIN_TIMEOUT_MS = 60_000;

interface HcloudRuntimePreflight {
  connection: Awaited<ReturnType<typeof requireConnection>>;
  checkpointArtifactId: string;
  workspaceAgentSha256: string;
  kinoSha256: string;
  forecast: StoredWorkshopCostForecast;
  location: string;
  permittedLocations: string[];
  provider: NonNullable<WorkshopManifestV1["workspace"]["provider"]>;
}

export interface WorkshopRuntimeProviderOperations {
  preflight(
    request: WorkshopProvisioningRequest,
    now?: number,
  ): Promise<unknown>;
  allocate(
    request: WorkshopProvisioningRequest,
    options?: { recoveryMessage?: string; now?: number },
  ): Promise<RuntimeExecutionHandle>;
  archive(input: {
    executionId: string;
    expectedGeneration: number;
    now?: number;
    archiveExecution?: boolean;
  }): Promise<boolean>;
  reconcile(input: {
    allocationId: string;
    now?: number;
  }): Promise<"ready" | "pending" | "deleted" | "cleanup_pending">;
  recover(input: { executionId: string; now?: number }): Promise<void>;
}

export const hcloudWorkshopRuntimeProvider: WorkshopRuntimeProviderOperations =
  {
    preflight: preflightHetznerWorkshopRuntime,
    allocate: allocateHetznerWorkshopRuntime,
    archive: archiveHetznerWorkshopRuntime,
    reconcile: reconcileHetznerWorkshopRuntime,
    recover: recoverHetznerWorkshopRuntime,
  };

export async function workshopRuntimeProviderKind(
  sessionId: string,
): Promise<"agent_kvm" | "hetzner_cloud"> {
  const row = await env.DB.prepare(
    `SELECT provider_kind
     FROM workshop_session_runtime_providers
     WHERE session_id = ?`,
  )
    .bind(sessionId)
    .first<{ provider_kind: "agent_kvm" | "hetzner_cloud" }>();
  // Older rows and tests predate the provider pin table. They remain on the
  // existing runner path by design.
  return row?.provider_kind ?? "agent_kvm";
}

export async function preflightHetznerWorkshopRuntime(
  request: WorkshopProvisioningRequest,
  now = Date.now(),
): Promise<HcloudRuntimePreflight> {
  await requireWorkshopHcloudRuntimeEnabledForOrganization(
    request.organizationId,
  );
  if (request.manifest.workspace.vms.length !== 1) {
    throw appError(
      409,
      "hcloud_workshop_multi_vm_unsupported",
      "Hetzner workshop revisions must contain exactly one learner VM",
    );
  }
  const provider = request.manifest.workspace.provider;
  if (!provider || provider.kind !== "hetzner_cloud" || !provider.compatible) {
    throw appError(
      409,
      "workshop_revision_not_hcloud_compatible",
      "this workshop revision is not verified for Hetzner Cloud",
    );
  }
  const sessionRows = await drizzle(env.DB)
    .select({
      providerKind: workshopSessionRuntimeProviders.providerKind,
      connectionId: workshopSessionRuntimeProviders.connectionId,
      serverType: workshopSessionRuntimeProviders.serverType,
      hardware: workshopSessionRuntimeProviders.hardwareJson,
      locations: workshopSessionRuntimeProviders.permittedLocationsJson,
      overrideAt: workshopSessionRuntimeProviders.grossCeilingOverrideAt,
    })
    .from(workshopSessionRuntimeProviders)
    .where(eq(workshopSessionRuntimeProviders.sessionId, request.sessionId))
    .limit(1);
  const pin = sessionRows[0];
  if (
    pin?.providerKind !== "hetzner_cloud" ||
    !pin.connectionId ||
    pin.serverType !== provider.serverType ||
    !pin.hardware
  ) {
    throw appError(
      409,
      "workshop_provider_pin_invalid",
      "the workshop session has no valid Hetzner provider pin",
    );
  }
  if (
    pin.hardware.architecture !== provider.hardware.architecture ||
    pin.hardware.cores !== provider.hardware.cores ||
    pin.hardware.memoryMib !== provider.hardware.memoryMib ||
    pin.hardware.diskMib !== provider.hardware.diskMib
  ) {
    throw appError(
      409,
      "workshop_provider_shape_changed",
      "the session-pinned server type hardware shape changed",
    );
  }
  const connection = await requireConnection(
    request.organizationId,
    pin.connectionId,
  );
  if (connection.state !== "active") {
    throw appError(
      409,
      "provider_connection_inactive",
      "the Hetzner provider connection is not active",
    );
  }
  if (!connection.ipv4Enabled) {
    throw appError(
      409,
      "hcloud_ipv4_required",
      "Hetzner learner workspaces require Primary IPv4",
    );
  }
  let forecast = await loadLatestWorkshopCostForecast(request.sessionId);
  let forecastFence = await loadWorkshopForecastFence(request.sessionId);
  if (!forecast || workshopForecastIsStale(forecast, forecastFence, now)) {
    await refreshWorkshopSessionProviderPreflight({
      sessionId: request.sessionId,
      trigger: "lobby_refresh",
    });
    forecast = await loadLatestWorkshopCostForecast(request.sessionId);
    forecastFence = await loadWorkshopForecastFence(request.sessionId);
  }
  if (!forecast || workshopForecastIsStale(forecast, forecastFence, now)) {
    throw appError(
      409,
      "workshop_cost_forecast_stale",
      "refresh the Hetzner cost forecast for the current session roster before provisioning",
    );
  }
  // The connection guardrail is mutable while forecasts are immutable. Compare
  // the current ceiling directly so lowering it cannot leave an older,
  // otherwise-unexpired forecast authorized.
  const forecastExceedsCurrentCeiling =
    connection.maxSessionGrossMicros !== null &&
    forecast.leaseCeiling.totalGrossMicros > connection.maxSessionGrossMicros;
  const costProjection = await getWorkshopCostProjection({
    sessionId: request.sessionId,
    now,
  });
  if (
    (forecastExceedsCurrentCeiling ||
      costProjection.live?.overGrossCeiling === true) &&
    pin.overrideAt === null
  ) {
    throw appError(
      409,
      "workshop_cost_ceiling_exceeded",
      "the Hetzner forecast or live projection exceeds the organization limit",
    );
  }
  const seat = await env.DB.prepare(
    `SELECT
       max(CASE WHEN execution.generation = ? THEN 1 ELSE 0 END)
         AS exact_generation,
       max(CASE
         WHEN execution.generation < ?
          AND allocation.deletion_confirmed_at IS NULL THEN 1
         ELSE 0
       END) AS counted_source
     FROM hetzner_allocations allocation
     INNER JOIN runtime_executions execution ON execution.id = allocation.execution_id
     WHERE execution.domain_kind = 'workshop'
       AND execution.domain_id = ?
       AND execution.provider_kind = 'hetzner_cloud'
       AND allocation.connection_id = ?`,
  )
    .bind(
      request.generationOrdinal,
      request.generationOrdinal,
      request.workspaceId,
      connection.id,
    )
    .first<{
      exact_generation: number | null;
      counted_source: number | null;
    }>();
  if (!seat?.exact_generation) {
    const live = await countLiveHetznerAllocations(connection.id);
    const replacementSourceSeats = seat?.counted_source ? 1 : 0;
    if (live - replacementSourceSeats >= connection.maxConcurrentServers) {
      throw appError(
        409,
        "hcloud_concurrency_limit_reached",
        "the organization Hetzner learner-server limit is reached",
      );
    }
  }
  const priceLocations = new Map(
    forecast.priceObservation.locations.map((entry) => [entry.location, entry]),
  );
  const location = pin.locations.find(
    (candidate) => priceLocations.get(candidate)?.available === true,
  );
  if (!location) {
    throw appError(
      409,
      "hcloud_location_unavailable",
      "the pinned server type is unavailable in every approved location",
    );
  }
  const artifact = await drizzle(env.DB)
    .select({
      id: runtimeProviderCheckpointArtifacts.id,
      workspaceAgentSha256:
        runtimeProviderCheckpointArtifacts.workspaceAgentSha256,
      kinoSha256: runtimeProviderCheckpointArtifacts.kinoSha256,
    })
    .from(runtimeProviderCheckpointArtifacts)
    .where(
      and(
        eq(
          runtimeProviderCheckpointArtifacts.templateRevisionId,
          request.templateRevisionId,
        ),
        eq(
          runtimeProviderCheckpointArtifacts.checkpointId,
          request.checkpointId,
        ),
        eq(runtimeProviderCheckpointArtifacts.providerKind, "hetzner_cloud"),
        eq(runtimeProviderCheckpointArtifacts.status, "verified"),
      ),
    )
    .limit(1);
  if (
    !artifact[0] ||
    !isSha256(artifact[0].workspaceAgentSha256) ||
    !isSha256(artifact[0].kinoSha256)
  ) {
    throw appError(
      409,
      "hcloud_checkpoint_not_verified",
      "the selected checkpoint has no cold-boot-verified Hetzner runtime bundle",
    );
  }
  return {
    connection,
    checkpointArtifactId: artifact[0].id,
    workspaceAgentSha256: artifact[0].workspaceAgentSha256,
    kinoSha256: artifact[0].kinoSha256,
    forecast,
    location,
    permittedLocations: pin.locations,
    provider,
  };
}

interface WorkshopForecastFence {
  participantCount: number;
  sessionUpdatedAt: number;
}

async function loadWorkshopForecastFence(
  sessionId: string,
): Promise<WorkshopForecastFence> {
  const row = await env.DB.prepare(
    `SELECT session.updated_at AS session_updated_at,
            (SELECT count(*)
             FROM workshop_session_members roster
             WHERE roster.session_id = session.id
               AND roster.role = 'participant') AS participant_count
     FROM workshop_sessions session
     WHERE session.id = ?`,
  )
    .bind(sessionId)
    .first<{
      participant_count: number;
      session_updated_at: number;
    }>();
  if (!row) {
    throw appError(
      404,
      "workshop_session_not_found",
      "workshop session not found",
    );
  }
  return {
    participantCount: row.participant_count,
    sessionUpdatedAt: row.session_updated_at,
  };
}

function workshopForecastIsStale(
  forecast: StoredWorkshopCostForecast,
  fence: WorkshopForecastFence,
  now: number,
): boolean {
  return (
    forecast.expiresAt <= now ||
    forecast.participantCount !== fence.participantCount ||
    forecast.createdAt < fence.sessionUpdatedAt
  );
}

export async function allocateHetznerWorkshopRuntime(
  request: WorkshopProvisioningRequest,
  options: { recoveryMessage?: string; now?: number } = {},
): Promise<RuntimeExecutionHandle> {
  const now = options.now ?? Date.now();
  const session = await validateProvisioningFence(request, now);
  const leaseExpiresAt =
    session.scheduledStartAt +
    (request.manifest.durationMinutes +
      request.manifest.workspace.leaseGraceMinutes) *
      60_000;
  if (leaseExpiresAt <= now) {
    throw appError(
      409,
      "workshop_workspace_lease_expired",
      "the workshop workspace lease has already expired",
    );
  }
  const preflight = await preflightHetznerWorkshopRuntime(request, now);
  let execution: RuntimeExecutionHandle | null = null;
  try {
    const claim = await withRuntimeAllocationLock({
      key: runtimeCapacityAllocationKey(request.organizationId),
      operation: async () => {
        const currentId = await currentExecutionId(request);
        if (currentId) {
          const current = await loadRuntimeExecutionHandle(currentId);
          if (current.state === "archived" || current.state === "failed") {
            throw appError(
              409,
              "hcloud_generation_closed",
              "the current learner workspace generation is closed",
            );
          }
          const existingAllocation = await allocationForExecution(currentId);
          if (existingAllocation) {
            if (
              existingAllocation.state === "deleting" ||
              existingAllocation.state === "deleted" ||
              existingAllocation.state === "cleanup_pending" ||
              existingAllocation.state === "failed"
            ) {
              throw appError(
                503,
                "hcloud_allocation_unavailable",
                "the learner server allocation is not available for provisioning",
              );
            }
            if (
              existingAllocation.server_id !== null ||
              existingAllocation.state === "bootstrapping" ||
              existingAllocation.state === "ready" ||
              existingAllocation.state === "degraded" ||
              existingAllocation.state === "rebooting"
            ) {
              return {
                execution: current,
                allocation: existingAllocation,
                shouldProvision: false,
                resumed: false,
              };
            }
            const resumed = await claimStaleProvisioningAttempt(
              existingAllocation,
              now,
            );
            return {
              execution: current,
              allocation: resumed ?? existingAllocation,
              shouldProvision: resumed !== null,
              resumed: resumed !== null,
            };
          }
          const allocation = await ensureAllocationRow({
            execution: current,
            request,
            preflight,
            now,
          });
          return {
            execution: current,
            allocation,
            shouldProvision: true,
            resumed: false,
          };
        }
        // The first preflight gives the caller an early, descriptive failure.
        // Repeat the admission count while holding the organization allocation
        // lock so two learners cannot both observe the final free seat.
        const previous = await previousExecution(request);
        const previousAllocation = previous
          ? await allocationForExecution(previous.executionId)
          : null;
        const sourceOwnsCountedSeat =
          previousAllocation !== null &&
          previousAllocation.connection_id === preflight.connection.id &&
          previousAllocation.deletion_confirmed_at === null;
        const liveAllocations = await countLiveHetznerAllocations(
          preflight.connection.id,
        );
        if (
          liveAllocations - (sourceOwnsCountedSeat ? 1 : 0) >=
          preflight.connection.maxConcurrentServers
        ) {
          throw appError(
            409,
            "hcloud_concurrency_limit_reached",
            "the organization Hetzner learner-server limit is reached",
          );
        }
        if (previous) {
          const deleted = await archiveHetznerWorkshopRuntime({
            executionId: previous.executionId,
            expectedGeneration: previous.ordinal,
            now,
            archiveExecution: false,
          });
          if (!deleted) {
            throw appError(
              503,
              "hcloud_replacement_cleanup_pending",
              "the previous learner server is still being deleted",
            );
          }
        }
        const executionId = createAppId();
        const vms = runtimeVmSpecs(request, executionId);
        const created = previous
          ? await createRuntimeRecoveryGeneration({
              sourceExecutionId: previous.executionId,
              expectedGeneration: previous.ordinal,
              executionId,
              hostId: null,
              providerKind: "hetzner_cloud",
              providerConnectionId: preflight.connection.id,
              checkpointId: request.checkpointId,
              leaseExpiresAt,
              vms,
              now,
            })
          : await createRuntimeExecution({
              executionId,
              userId: request.participantUserId,
              organizationId: request.organizationId,
              hostId: null,
              providerKind: "hetzner_cloud",
              providerConnectionId: preflight.connection.id,
              domainKind: "workshop",
              domainId: request.workspaceId,
              checkpointId: request.checkpointId,
              leaseExpiresAt,
              vms,
              claimActiveSlot: true,
              now,
            });
        if (created.generation !== request.generationOrdinal) {
          throw appError(
            409,
            "workshop_runtime_generation_mismatch",
            "workshop and runtime generations are out of sync",
          );
        }
        await recordWorkshopGenerationState({
          generationId: request.generationId,
          update: {
            state: "provisioning",
            runtimeExecutionId: created.executionId,
            observedAt: now,
          },
        });
        if (previous) {
          await env.DB.prepare(
            `UPDATE workshop_workspace_generations
             SET state = 'archived', archived_at = ?, updated_at = ?
             WHERE id = ?`,
          )
            .bind(now, now, previous.generationId)
            .run();
        }
        const allocation = await ensureAllocationRow({
          execution: created,
          request,
          preflight,
          now,
        });
        return {
          execution: created,
          allocation,
          shouldProvision: true,
          resumed: false,
        };
      },
    });
    execution = claim.execution;
    if (!claim.shouldProvision) return execution;
    const provisioningAttemptId = requiredProvisioningAttemptId(
      claim.allocation,
    );
    await heartbeatProvisioningAttempt(
      claim.allocation.id,
      provisioningAttemptId,
      now,
    );
    await assertProvisioningFence(request, execution.executionId);
    const ownership = await ownershipLabels(
      request.organizationId,
      preflight.connection.id,
      request.workspaceId,
      request.generationOrdinal,
    );
    let allocation = claim.allocation;
    if (claim.resumed) {
      const reconciled = await reconcileResumedProvisioning({
        allocation,
        execution,
        preflight,
        ownership,
        provisioningAttemptId,
        now,
      });
      allocation = reconciled.allocation;
      if (reconciled.serverPresent) return execution;
    }
    await heartbeatProvisioningAttempt(
      allocation.id,
      provisioningAttemptId,
      Date.now(),
    );
    const accessKeys = await ensureRuntimeVmAccessKeys({
      executionId: execution.executionId,
      expectedGeneration: execution.generation,
      now,
    });
    const accessKey = accessKeys[0];
    if (!accessKey || accessKeys.length !== 1) {
      throw appError(
        409,
        "hcloud_workspace_key_invalid",
        "Hetzner learner workspaces require exactly one SSH access key",
      );
    }
    const controlPlaneBaseUrl = requiredControlPlaneBaseUrl();
    const guestTools = await resolveWorkspaceGuestTools(controlPlaneBaseUrl, {
      workspaceAgentSha256: preflight.workspaceAgentSha256,
      kinoSha256: preflight.kinoSha256,
    });
    const bootstrap = await issueWorkspaceAgentBootstrap({
      executionId: execution.executionId,
      generation: execution.generation,
      checkpointArtifactId: preflight.checkpointArtifactId,
      now,
      baseUrl: controlPlaneBaseUrl,
      provisioningAttemptId,
    });
    await heartbeatProvisioningAttempt(
      allocation.id,
      provisioningAttemptId,
      Date.now(),
    );
    const cloudInit = buildWorkspaceAgentCloudInit({
      identity: bootstrap.identity,
      endpoint: bootstrap.endpoint,
      bootstrapCapability: bootstrap.capability,
      sshPublicKey: accessKey.publicKeyOpenssh,
      agentBinaryUrl: guestTools.agent.url,
      agentBinarySha256: guestTools.agent.sha256,
      kinoBinaryUrl: guestTools.kino.url,
      kinoBinarySha256: guestTools.kino.sha256,
      kinoProbes: request.manifest.modules.flatMap((module) =>
        module.probeIds.map((probeId) => ({ moduleId: module.id, probeId })),
      ),
    });
    await createProviderResources({
      allocation,
      execution,
      preflight,
      ownership,
      publicKey: accessKey.publicKeyOpenssh,
      cloudInit,
      provisioningAttemptId,
      now,
    });
    await updateRuntimeExecutionState({
      executionId: execution.executionId,
      expectedGeneration: execution.generation,
      state: "provisioning",
      leaseExpiresAt,
      observedAt: now,
    });
    if (options.recoveryMessage) {
      await env.DB.prepare(
        `UPDATE workshop_workspaces
         SET recovery_message = ?, updated_at = ?
         WHERE id = ? AND current_generation_id = ?`,
      )
        .bind(
          options.recoveryMessage,
          now,
          request.workspaceId,
          request.generationId,
        )
        .run();
    }
    return execution;
  } catch (error) {
    if (execution && isProvisioningSuperseded(error)) return execution;
    // A reporting workspace first enters the bounded recording-drain phase.
    // That is an accepted asynchronous replacement, not a failed generation:
    // keep the queued generation intact so the minute sweep can provision it
    // immediately after the source allocation is confirmed deleted.
    if (isReplacementCleanupPending(error)) throw error;
    if (execution) {
      try {
        await archiveHetznerWorkshopRuntime({
          executionId: execution.executionId,
          expectedGeneration: execution.generation,
          now,
        });
      } catch {
        // Preserve the provisioning failure. The allocation remains visible as
        // cleanup_pending and the active slot is deliberately retained.
      }
    }
    try {
      await recordWorkshopGenerationState({
        generationId: request.generationId,
        update: { state: "failed", error: safeError(error), observedAt: now },
      });
    } catch {
      // A concurrent restore can make this generation stale.
    }
    throw error;
  }
}

export async function archiveHetznerWorkshopRuntime(input: {
  executionId: string;
  expectedGeneration: number;
  now?: number;
  archiveExecution?: boolean;
}): Promise<boolean> {
  const now = input.now ?? Date.now();
  const execution = await loadRuntimeExecutionHandle(input.executionId);
  if (execution.providerKind !== "hetzner_cloud") {
    throw appError(
      409,
      "runtime_provider_mismatch",
      "runtime execution is not a Hetzner allocation",
    );
  }
  if (execution.generation !== input.expectedGeneration) {
    throw appError(
      409,
      "runtime_generation_stale",
      "runtime execution generation changed",
    );
  }
  const shouldArchiveExecution = async () =>
    input.archiveExecution ??
    !(await hasQueuedHetznerReplacement(execution.executionId));
  // Fence new terminal and application routes before any asynchronous drain
  // or provider cleanup starts. A route already in flight must observe either
  // the non-ready generation or execution in its final canonical write and
  // compensate by deleting the just-created Stargate route.
  await markWorkshopGenerationArchivingForExecution(execution.executionId, now);
  if (
    execution.state !== "archiving" &&
    execution.state !== "archived" &&
    execution.state !== "failed"
  ) {
    await updateRuntimeExecutionState({
      executionId: execution.executionId,
      expectedGeneration: input.expectedGeneration,
      state: "archiving",
      observedAt: now,
    });
  }
  let row = await allocationForExecution(execution.executionId);
  if (!row) {
    await revokeWorkspaceAgentGeneration({
      executionId: execution.executionId,
      generation: input.expectedGeneration,
      now,
    });
    if (await shouldArchiveExecution()) {
      await archiveRuntimeExecution({
        executionId: execution.executionId,
        expectedGeneration: input.expectedGeneration,
        endedAt: now,
      });
    }
    return true;
  }
  if (row.state === "deleted") {
    await revokeWorkspaceAgentGeneration({
      executionId: execution.executionId,
      generation: input.expectedGeneration,
      now,
    });
    if (
      execution.state !== "archived" &&
      (await shouldArchiveExecution())
    ) {
      await archiveRuntimeExecution({
        executionId: execution.executionId,
        expectedGeneration: input.expectedGeneration,
        endedAt: now,
      });
    }
    await restoreConnectionAfterConfirmedCleanup(row.connection_id, now);
    await finalizeSessionCostForExecution(execution.executionId, now);
    return true;
  }

  const canDrainRecordings =
    row.server_id !== null &&
    row.last_report_at !== null &&
    row.state !== "deleting" &&
    row.state !== "cleanup_pending";
  if (canDrainRecordings && row.state !== "draining") {
    // Revoke every browser route before asking the guest to finish its local
    // recordings. Keep only the generation-bound report credential alive so
    // it can upload completed artifacts during the bounded drain window.
    await revokeHetznerWorkspaceRoutesForExecution(execution.executionId, now);
    await env.DB.prepare(
      `UPDATE hetzner_allocations
       SET state = 'draining',
           recording_drain_requested_at = COALESCE(recording_drain_requested_at, ?),
           recording_drain_completed_at = NULL,
           updated_at = ?
       WHERE id = ? AND state NOT IN ('deleting', 'deleted', 'cleanup_pending')`,
    )
      .bind(now, now, row.id)
      .run();
    return false;
  }
  if (row.state === "draining") {
    if (row.recording_drain_requested_at === null) {
      await env.DB.prepare(
        `UPDATE hetzner_allocations
         SET recording_drain_requested_at = ?, updated_at = ?
         WHERE id = ? AND state = 'draining'
           AND recording_drain_requested_at IS NULL`,
      )
        .bind(now, now, row.id)
        .run();
      return false;
    }
    const requestedAt = row.recording_drain_requested_at;
    if (
      row.recording_drain_completed_at === null &&
      now - requestedAt < RECORDING_DRAIN_TIMEOUT_MS
    ) {
      return false;
    }
    if (row.recording_drain_completed_at === null) {
      await env.DB.prepare(
        `UPDATE hetzner_allocations
         SET last_error_code = 'recording_drain_timeout', updated_at = ?
         WHERE id = ? AND recording_drain_completed_at IS NULL`,
      )
        .bind(now, row.id)
        .run();
    }
  }

  await revokeWorkspaceAgentGeneration({
    executionId: execution.executionId,
    generation: input.expectedGeneration,
    now,
  });
  await env.DB.prepare(
    `UPDATE hetzner_allocations
     SET state = 'deleting', deletion_requested_at = coalesce(deletion_requested_at, ?), updated_at = ?
     WHERE id = ?`,
  )
    .bind(now, now, row.id)
    .run();
  try {
    // A provider create can commit even when its RPC response or the following
    // D1 canonical write is lost. Resolve every deterministic ownership label
    // before treating a null external ID as proof that no resource exists.
    row = await reconcileAllocationResourcesByNameForCleanup(row);
    const context = await providerOperationContext(row.connection_id);
    if (row.server_id) {
      const serverDeleted = await deleteProviderResource({
        context,
        allocationId: row.id,
        kind: "server",
        externalId: providerId(row.server_id),
        deterministicName: row.deterministic_name,
        now,
      });
      if (!serverDeleted) return false;
      await markLedgerDeleted(row.id, "server", row.server_id, now);
    }
    if (row.primary_ip_id) {
      const ipDeleted = await deleteProviderResource({
        context,
        allocationId: row.id,
        kind: "primary_ip",
        externalId: providerId(row.primary_ip_id),
        deterministicName: `${row.deterministic_name}-ip-${row.location}`,
        now,
      });
      if (!ipDeleted) return false;
      await markLedgerDeleted(row.id, "primary_ipv4", row.primary_ip_id, now);
    }
    if (row.ssh_key_id) {
      const keyDeleted = await deleteProviderResource({
        context,
        allocationId: row.id,
        kind: "ssh_key",
        externalId: providerId(row.ssh_key_id),
        deterministicName: `${row.deterministic_name}-key`,
        now,
      });
      if (!keyDeleted) return false;
    }
    await env.DB.prepare(
      `UPDATE hetzner_allocations
       SET state = 'deleted', deletion_confirmed_at = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(now, now, row.id)
      .run();
    await restoreConnectionAfterConfirmedCleanup(row.connection_id, now);
    if (await shouldArchiveExecution()) {
      await archiveRuntimeExecution({
        executionId: execution.executionId,
        expectedGeneration: input.expectedGeneration,
        endedAt: now,
      });
    }
    await finalizeSessionCostForExecution(execution.executionId, now);
    return true;
  } catch (error) {
    await markCleanupPending(row, error, now);
    throw error;
  }
}

export async function reconcileHetznerWorkshopRuntime(input: {
  allocationId: string;
  now?: number;
}): Promise<"ready" | "pending" | "deleted" | "cleanup_pending"> {
  const now = input.now ?? Date.now();
  let row = await allocationById(input.allocationId);
  if (!row) {
    throw appError(404, "hcloud_allocation_not_found", "allocation not found");
  }
  if (row.state === "deleted") return "deleted";
  if (row.state === "cleanup_pending") {
    if (row.deletion_requested_at === null) return "cleanup_pending";
    try {
      const execution = await loadRuntimeExecutionHandle(row.execution_id);
      const deleted = await archiveHetznerWorkshopRuntime({
        executionId: execution.executionId,
        expectedGeneration: execution.generation,
        now,
      });
      if (deleted) {
        await markWorkshopGenerationArchivedForExecution(
          execution.executionId,
          now,
        );
      }
      return deleted ? "deleted" : "pending";
    } catch {
      return "cleanup_pending";
    }
  }
  try {
    if (
      row.state === "deleting" &&
      (!row.server_id || !row.primary_ip_id || !row.ssh_key_id)
    ) {
      // A delete row can predate persistence of one provider identity. Discover
      // only null IDs before the action-aware reconciler may conclude that all
      // resources are absent.
      row = await reconcileAllocationResourcesByNameForCleanup(row, true);
    }
    const context = await providerOperationContext(row.connection_id);
    const ownership = await allocationOwnership(row.execution_id);
    const refs: Extract<HcloudOperation, { kind: "reconcile" }>["resources"] =
      [];
    if (row.server_id) {
      refs.push({
        resourceKind: "server",
        externalId: providerId(row.server_id),
        deterministicName: row.deterministic_name,
        ownership,
      });
    }
    if (row.primary_ip_id) {
      refs.push({
        resourceKind: "primary_ip",
        externalId: providerId(row.primary_ip_id),
        deterministicName: `${row.deterministic_name}-ip-${row.location}`,
        ownership,
      });
    }
    if (row.ssh_key_id) {
      refs.push({
        resourceKind: "ssh_key",
        externalId: providerId(row.ssh_key_id),
        deterministicName: `${row.deterministic_name}-key`,
        ownership,
      });
    }
    const actionIds = [row.create_action_id, row.delete_action_id]
      .filter((value): value is string => Boolean(value))
      .map(providerId);
    const result = await runProviderOperation(context, row.id, {
      kind: "reconcile",
      resources: refs,
      actionIds,
    });
    const reconciled = result.data as ReconcileResult;
    const server = reconciled.resources.find(
      (entry) => entry.ref.resourceKind === "server",
    );
    if (row.state === "deleting") {
      const failedAction = reconciled.actions.find(
        (action) => action.status === "error",
      );
      if (failedAction) {
        throw appError(
          503,
          "hcloud_delete_action_failed",
          "Hetzner deletion action failed",
        );
      }
      const allMissing = reconciled.resources.every(
        (entry) => entry.status === "missing",
      );
      if (allMissing) {
        await markLedgerDeleted(row.id, "server", row.server_id, now);
        await markLedgerDeleted(row.id, "primary_ipv4", row.primary_ip_id, now);
        await env.DB.prepare(
          `UPDATE hetzner_allocations
           SET state = 'deleted', deletion_confirmed_at = ?, updated_at = ?
           WHERE id = ?`,
        )
          .bind(now, now, row.id)
          .run();
        await restoreConnectionAfterConfirmedCleanup(row.connection_id, now);
        const execution = await loadRuntimeExecutionHandle(row.execution_id);
        if (
          execution.state !== "archived" &&
          !(await hasQueuedHetznerReplacement(execution.executionId))
        ) {
          await archiveRuntimeExecution({
            executionId: execution.executionId,
            expectedGeneration: execution.generation,
            endedAt: now,
          });
        }
        await markWorkshopGenerationArchivedForExecution(
          execution.executionId,
          now,
        );
        await finalizeSessionCostForExecution(row.execution_id, now);
        return "deleted";
      }
      // Server deletion is asynchronous. The first archive attempt may stop
      // after its bounded action poll while the separately billed Primary IP
      // and SSH key still exist. Once reconciliation proves the server is
      // gone, re-enter the ordered archive path so those remaining resources
      // are deleted and the active slot can eventually be released.
      if (
        (!row.server_id || server?.status === "missing") &&
        !reconciled.actions.some((action) => action.status === "running")
      ) {
        const execution = await loadRuntimeExecutionHandle(row.execution_id);
        const deleted = await archiveHetznerWorkshopRuntime({
          executionId: execution.executionId,
          expectedGeneration: execution.generation,
          now,
        });
        if (deleted) {
          await markWorkshopGenerationArchivedForExecution(
            execution.executionId,
            now,
          );
        }
        return deleted ? "deleted" : "pending";
      }
      return "pending";
    }
    if (server?.status === "present" && server.state === "running") {
      return row.state === "ready" ? "ready" : "pending";
    }
    return "pending";
  } catch (error) {
    await markCleanupPending(row, error, now);
    return "cleanup_pending";
  }
}

export async function recoverHetznerWorkshopRuntime(input: {
  executionId: string;
  now?: number;
}): Promise<void> {
  const now = input.now ?? Date.now();
  const row = await allocationForExecution(input.executionId);
  if (
    !row ||
    !row.server_id ||
    ["draining", "deleting", "deleted", "cleanup_pending"].includes(row.state)
  ) {
    return;
  }
  const context = await providerOperationContext(row.connection_id);
  if (row.retry_count === 0) {
    const result = await runProviderOperation(context, row.id, {
      kind: "reboot_server",
      serverId: providerId(row.server_id),
    });
    const action = result.data as HcloudAction;
    await env.DB.prepare(
      `UPDATE hetzner_allocations
       SET state = 'rebooting', retry_count = 1, create_action_id = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(String(action.id), now, row.id)
      .run();
    return;
  }
  if (now - row.updated_at < REBOOT_RECOVERY_WAIT_MS) return;
  await recreateUnhealthyHetznerGeneration(row, now);
}

/** Minute-sweep entrypoint. It recovers lost alarms, advances deletions, and
 * applies the 45s/90s report-health thresholds without creating agent hosts. */
export async function sweepHetznerWorkshopRuntimes(
  input: {
    now?: number;
    limit?: number;
  } = {},
): Promise<{
  inspected: number;
  leaseExpired: number;
  provisioningRecovered: number;
  degraded: number;
  recoveryRequested: number;
  cleanupPending: number;
  replacementsProvisioned: number;
  replacementFailures: number;
  terminalCleanupsCompleted: number;
}> {
  const now = input.now ?? Date.now();
  const limit = Math.max(1, Math.min(100, input.limit ?? 25));
  const rows = await env.DB.prepare(
    `SELECT allocation.*,
            execution.generation AS runtime_generation,
            execution.lease_expires_at AS runtime_lease_expires_at
     FROM hetzner_allocations allocation
     INNER JOIN runtime_executions execution
       ON execution.id = allocation.execution_id
      AND execution.provider_kind = 'hetzner_cloud'
     WHERE allocation.state IN (
       'pending', 'creating', 'bootstrapping', 'ready', 'degraded',
       'rebooting', 'draining', 'deleting', 'cleanup_pending', 'failed'
     )
     ORDER BY
       CASE
         WHEN execution.lease_expires_at IS NOT NULL
          AND execution.lease_expires_at <= ? THEN 0
         WHEN allocation.state IN ('draining', 'deleting', 'cleanup_pending') THEN 1
         ELSE 2
       END ASC,
       COALESCE(execution.lease_expires_at, allocation.updated_at) ASC,
       allocation.updated_at ASC,
       allocation.id ASC
     LIMIT ?`,
  )
    .bind(now, limit)
    .all<SweepAllocationRow>();
  let leaseExpired = 0;
  let provisioningRecovered = 0;
  let degraded = 0;
  let recoveryRequested = 0;
  let cleanupPending = 0;
  for (const row of rows.results) {
    const expired =
      row.runtime_lease_expires_at !== null &&
      row.runtime_lease_expires_at <= now;
    if (expired) leaseExpired += 1;

    // Once ordered deletion has started, reconciliation owns it. Reissuing the
    // server delete here would discard the bounded asynchronous action poll.
    if (
      row.state === "deleting" ||
      (row.state === "cleanup_pending" && row.deletion_requested_at !== null)
    ) {
      const result = await reconcileHetznerWorkshopRuntime({
        allocationId: row.id,
        now,
      });
      if (result === "cleanup_pending") cleanupPending += 1;
      continue;
    }
    if (row.state === "draining") {
      try {
        const deleted = await archiveHetznerWorkshopRuntime({
          executionId: row.execution_id,
          expectedGeneration: row.runtime_generation,
          now,
        });
        if (deleted) {
          await markWorkshopGenerationArchivedForExecution(
            row.execution_id,
            now,
          );
        }
      } catch {
        cleanupPending += 1;
      }
      continue;
    }
    if (expired) {
      try {
        await revokeHetznerWorkspaceRoutesForExecution(row.execution_id, now);
        await markWorkshopGenerationArchivingForExecution(
          row.execution_id,
          now,
        );
        const deleted = await archiveHetznerWorkshopRuntime({
          executionId: row.execution_id,
          expectedGeneration: row.runtime_generation,
          now,
        });
        if (deleted) {
          await markWorkshopGenerationArchivedForExecution(
            row.execution_id,
            now,
          );
        }
      } catch {
        // The archive path preserves external IDs and the active slot in
        // cleanup_pending until provider deletion can be confirmed.
        cleanupPending += 1;
      }
      continue;
    }
    if (
      (row.state === "pending" || row.state === "creating") &&
      now - (row.provisioning_heartbeat_at ?? row.updated_at) >=
        PROVISIONING_CLAIM_STALE_MS
    ) {
      try {
        const request = await loadStaleProvisioningRequest(row.execution_id);
        if (request) {
          await allocateHetznerWorkshopRuntime(request, { now });
          provisioningRecovered += 1;
        } else {
          await markWorkshopGenerationArchivingForExecution(
            row.execution_id,
            now,
          );
          await archiveHetznerWorkshopRuntime({
            executionId: row.execution_id,
            expectedGeneration: row.runtime_generation,
            now,
          });
        }
      } catch {
        const latest = await allocationById(row.id);
        if (latest?.state === "cleanup_pending") cleanupPending += 1;
      }
      continue;
    }
    if (row.state === "failed") {
      try {
        if (row.server_id) {
          // A failed guest with a known server still owns a billed runtime.
          // Enter the normal reboot-then-recreate recovery path immediately;
          // do not strand it merely because no healthy report was accepted.
          await recoverHetznerWorkshopRuntime({
            executionId: row.execution_id,
            now,
          });
          recoveryRequested += 1;
        } else {
          // A create may have succeeded before its canonical ID write was
          // lost. Archive performs deterministic, ownership-checked name
          // reconciliation before deciding that there is nothing to delete.
          await markWorkshopGenerationArchivingForExecution(
            row.execution_id,
            now,
          );
          const deleted = await archiveHetznerWorkshopRuntime({
            executionId: row.execution_id,
            expectedGeneration: row.runtime_generation,
            now,
          });
          if (deleted) {
            await markWorkshopGenerationArchivedForExecution(
              row.execution_id,
              now,
            );
          }
        }
      } catch (error) {
        await markCleanupPending(row, error, now);
        cleanupPending += 1;
      }
      continue;
    }
    if (row.state === "pending" || row.state === "creating") {
      continue;
    }
    const reportAge =
      row.last_report_at === null
        ? now - row.created_at
        : now - row.last_report_at;
    if (reportAge >= REPORT_DEGRADED_AFTER_MS && row.state === "ready") {
      await env.DB.prepare(
        `UPDATE hetzner_allocations SET state = 'degraded', updated_at = ? WHERE id = ?`,
      )
        .bind(now, row.id)
        .run();
      degraded += 1;
    }
    if (reportAge >= REPORT_RECOVERY_AFTER_MS) {
      try {
        await recoverHetznerWorkshopRuntime({
          executionId: row.execution_id,
          now,
        });
        recoveryRequested += 1;
      } catch (error) {
        await markCleanupPending(row, error, now);
        cleanupPending += 1;
      }
    }
  }
  const replacements = await resumeQueuedHetznerReplacements({ now, limit });
  const terminalCleanupsCompleted =
    await finalizePendingTerminalSessionCleanups({ now, limit });
  return {
    inspected: rows.results.length,
    leaseExpired,
    provisioningRecovered,
    degraded,
    recoveryRequested,
    cleanupPending,
    replacementsProvisioned: replacements.provisioned,
    replacementFailures: replacements.failed,
    terminalCleanupsCompleted,
  };
}

async function reconcileAllocationResourcesByNameForCleanup(
  allocation: AllocationRow,
  onlyMissingIdentities = false,
): Promise<AllocationRow> {
  const ownership = await allocationOwnership(allocation.execution_id);
  const base = allocation.deterministic_name;
  const descriptors = [
    {
      resourceKind: "ssh_key" as const,
      externalId: allocation.ssh_key_id,
      deterministicName: `${base}-key`,
    },
    {
      resourceKind: "primary_ip" as const,
      externalId: allocation.primary_ip_id,
      deterministicName: `${base}-ip-${allocation.location}`,
    },
    {
      resourceKind: "server" as const,
      externalId: allocation.server_id,
      deterministicName: base,
    },
  ];
  const descriptorsToInspect = onlyMissingIdentities
    ? descriptors.filter((descriptor) => descriptor.externalId === null)
    : descriptors;
  if (descriptorsToInspect.length === 0) return allocation;
  const context = await providerOperationContext(allocation.connection_id);
  const result = await runProviderOperation(context, allocation.id, {
    kind: "reconcile",
    resources: descriptorsToInspect.map((descriptor) => ({
      resourceKind: descriptor.resourceKind,
      ...(descriptor.externalId
        ? { externalId: providerId(descriptor.externalId) }
        : {}),
      deterministicName: descriptor.deterministicName,
      ownership,
    })),
    actionIds: [],
  });
  const reconciled = result.data as ReconcileResult;
  const observedAt = Date.parse(reconciled.observedAt);
  if (!Number.isSafeInteger(observedAt)) {
    throw appError(
      502,
      "hcloud_reconcile_time_invalid",
      "the provider reconciliation timestamp is invalid",
    );
  }
  const forecast = await loadLatestForecastForExecution(
    allocation.execution_id,
  );
  for (const resource of reconciled.resources) {
    if (
      resource.status === "ambiguous" ||
      resource.status === "ownership_mismatch"
    ) {
      throw appError(
        409,
        "hcloud_cleanup_reconcile_unsafe",
        "the learner-server resources could not be reconciled safely for cleanup",
      );
    }
    const descriptor = descriptors.find(
      (candidate) => candidate.resourceKind === resource.ref.resourceKind,
    );
    const previousId = descriptor?.externalId ?? null;
    if (resource.status === "missing") {
      if (previousId) {
        if (resource.ref.resourceKind === "server") {
          await markLedgerDeleted(
            allocation.id,
            "server",
            previousId,
            observedAt,
          );
        } else if (resource.ref.resourceKind === "primary_ip") {
          await markLedgerDeleted(
            allocation.id,
            "primary_ipv4",
            previousId,
            observedAt,
          );
        }
        await clearDeletedProviderIdentity(
          allocation.id,
          resource.ref.resourceKind,
          previousId,
          observedAt,
        );
      }
      continue;
    }
    if (resource.status !== "present") continue;
    if (
      resource.ref.resourceKind !== "server" &&
      resource.ref.resourceKind !== "primary_ip" &&
      resource.ref.resourceKind !== "ssh_key"
    ) {
      continue;
    }
    const write = resourceWrite(result, resource.ref.resourceKind);
    const externalId = String(write.externalId);
    if (previousId && previousId !== externalId) {
      if (resource.ref.resourceKind === "server") {
        await markLedgerDeleted(
          allocation.id,
          "server",
          previousId,
          observedAt,
        );
      } else if (resource.ref.resourceKind === "primary_ip") {
        await markLedgerDeleted(
          allocation.id,
          "primary_ipv4",
          previousId,
          observedAt,
        );
      }
    }
    if (forecast && resource.ref.resourceKind === "server") {
      await insertCostLedger({
        allocationId: allocation.id,
        executionId: allocation.execution_id,
        forecast,
        location: allocation.location,
        resourceKind: "server",
        providerResourceId: externalId,
        providerCreatedAt: providerResourceCreatedAt(write),
      });
    } else if (forecast && resource.ref.resourceKind === "primary_ip") {
      await insertCostLedger({
        allocationId: allocation.id,
        executionId: allocation.execution_id,
        forecast,
        location: allocation.location,
        resourceKind: "primary_ipv4",
        providerResourceId: externalId,
        providerCreatedAt: providerResourceCreatedAt(write),
      });
    }
  }
  return (await allocationById(allocation.id)) ?? allocation;
}

async function loadLatestForecastForExecution(
  executionId: string,
): Promise<StoredWorkshopCostForecast | null> {
  const row = await env.DB.prepare(
    `SELECT workspace.session_id
     FROM runtime_executions execution
     INNER JOIN workshop_workspaces workspace
       ON execution.domain_kind = 'workshop'
      AND workspace.id = execution.domain_id
     WHERE execution.id = ?`,
  )
    .bind(executionId)
    .first<{ session_id: string }>();
  return row ? loadLatestWorkshopCostForecast(row.session_id) : null;
}

async function loadStaleProvisioningRequest(
  executionId: string,
): Promise<WorkshopProvisioningRequest | null> {
  const row = await env.DB.prepare(
    `SELECT execution.organization_id,
            execution.domain_id AS workspace_id,
            execution.generation,
            execution.checkpoint_id,
            workspace.session_id,
            workspace.user_id,
            generation.id AS generation_id,
            session.template_revision_id,
            revision.manifest_json
     FROM runtime_executions execution
     INNER JOIN workshop_workspaces workspace
       ON workspace.id = execution.domain_id
      AND workspace.current_generation_id IS NOT NULL
     INNER JOIN workshop_workspace_generations generation
       ON generation.id = workspace.current_generation_id
      AND generation.runtime_execution_id = execution.id
      AND generation.ordinal = execution.generation
     INNER JOIN workshop_sessions session
       ON session.id = workspace.session_id
      AND session.state IN ('lobby', 'live')
     INNER JOIN workshop_template_revisions revision
       ON revision.id = session.template_revision_id
     WHERE execution.id = ?
       AND execution.provider_kind = 'hetzner_cloud'
       AND execution.state IN ('queued', 'provisioning')
     LIMIT 1`,
  )
    .bind(executionId)
    .first<{
      organization_id: string;
      workspace_id: string;
      generation: number;
      checkpoint_id: string | null;
      session_id: string;
      user_id: string;
      generation_id: string;
      template_revision_id: string;
      manifest_json: string | WorkshopManifestV1;
    }>();
  if (!row) return null;
  const manifest = parseManifest(row.manifest_json);
  return {
    organizationId: row.organization_id,
    sessionId: row.session_id,
    templateRevisionId: row.template_revision_id,
    participantUserId: row.user_id,
    workspaceId: row.workspace_id,
    generationId: row.generation_id,
    generationOrdinal: row.generation,
    checkpointId: row.checkpoint_id ?? manifest.workspace.initialCheckpointId,
    manifest,
  };
}

async function loadQueuedHetznerReplacementRequests(limit: number): Promise<
  Array<{
    sourceExecutionId: string;
    request: WorkshopProvisioningRequest;
  }>
> {
  const rows = await env.DB.prepare(
    `SELECT source.id AS source_execution_id,
            source.organization_id,
            source.domain_id AS workspace_id,
            generation.id AS generation_id,
            generation.ordinal,
            generation.checkpoint_id,
            workspace.session_id,
            workspace.user_id,
            session.template_revision_id,
            revision.manifest_json
     FROM runtime_executions source
     INNER JOIN hetzner_allocations allocation
       ON allocation.execution_id = source.id
      AND allocation.state = 'deleted'
      AND allocation.deletion_confirmed_at IS NOT NULL
     INNER JOIN workshop_workspaces workspace
       ON source.domain_kind = 'workshop'
      AND workspace.id = source.domain_id
     INNER JOIN workshop_workspace_generations generation
       ON generation.id = workspace.current_generation_id
      AND generation.workspace_id = workspace.id
      AND generation.ordinal = source.generation + 1
      AND generation.runtime_execution_id IS NULL
      AND generation.state = 'queued'
     INNER JOIN workshop_sessions session
       ON session.id = workspace.session_id
      AND session.state IN ('lobby', 'live')
     INNER JOIN workshop_template_revisions revision
       ON revision.id = session.template_revision_id
     INNER JOIN workshop_session_runtime_providers provider
       ON provider.session_id = session.id
      AND provider.provider_kind = 'hetzner_cloud'
     WHERE source.provider_kind = 'hetzner_cloud'
       AND NOT EXISTS (
         SELECT 1
         FROM runtime_executions replacement
         WHERE replacement.domain_kind = source.domain_kind
           AND replacement.domain_id = source.domain_id
           AND replacement.generation >= generation.ordinal
       )
     ORDER BY generation.requested_at ASC, generation.id ASC
     LIMIT ?`,
  )
    .bind(limit)
    .all<{
      source_execution_id: string;
      organization_id: string;
      workspace_id: string;
      generation_id: string;
      ordinal: number;
      checkpoint_id: string | null;
      session_id: string;
      user_id: string;
      template_revision_id: string;
      manifest_json: string | WorkshopManifestV1;
    }>();
  return rows.results.map((row) => {
    const manifest = parseManifest(row.manifest_json);
    return {
      sourceExecutionId: row.source_execution_id,
      request: {
        organizationId: row.organization_id,
        sessionId: row.session_id,
        templateRevisionId: row.template_revision_id,
        participantUserId: row.user_id,
        workspaceId: row.workspace_id,
        generationId: row.generation_id,
        generationOrdinal: row.ordinal,
        checkpointId:
          row.checkpoint_id ?? manifest.workspace.initialCheckpointId,
        manifest,
      },
    };
  });
}

async function hasQueuedHetznerReplacement(
  sourceExecutionId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS present
     FROM runtime_executions source
     INNER JOIN workshop_workspaces workspace
       ON source.domain_kind = 'workshop'
      AND workspace.id = source.domain_id
     INNER JOIN workshop_workspace_generations generation
       ON generation.id = workspace.current_generation_id
      AND generation.workspace_id = workspace.id
      AND generation.ordinal = source.generation + 1
      AND generation.runtime_execution_id IS NULL
      AND generation.state = 'queued'
     INNER JOIN workshop_sessions session
       ON session.id = workspace.session_id
      AND session.state IN ('lobby', 'live')
     WHERE source.id = ?
       AND source.provider_kind = 'hetzner_cloud'
     LIMIT 1`,
  )
    .bind(sourceExecutionId)
    .first<{ present: number }>();
  return row !== null;
}

async function resumeQueuedHetznerReplacements(input: {
  now: number;
  limit: number;
}): Promise<{ provisioned: number; failed: number }> {
  const queued = await loadQueuedHetznerReplacementRequests(input.limit);
  let provisioned = 0;
  let failed = 0;
  for (const replacement of queued) {
    try {
      await allocateHetznerWorkshopRuntime(replacement.request, {
        now: input.now,
      });
      provisioned += 1;
    } catch (error) {
      // Another cleanup pass may still own the source. Leave the queued
      // generation retryable without projecting a false provisioning failure.
      if (isReplacementCleanupPending(error)) continue;
      failed += 1;
      console.error(
        JSON.stringify({
          event: "workshop_hcloud_replacement_resume_failed",
          sourceExecutionId: replacement.sourceExecutionId,
          workspaceId: replacement.request.workspaceId,
          generationId: replacement.request.generationId,
          code:
            error instanceof AppError
              ? error.code
              : "hcloud_replacement_resume_failed",
        }),
      );
    }
  }
  return { provisioned, failed };
}

async function finalizePendingTerminalSessionCleanups(input: {
  now: number;
  limit: number;
}): Promise<number> {
  const sessions = await env.DB.prepare(
    `SELECT session.id, session.organization_id, session.state
     FROM workshop_sessions session
     WHERE session.state IN ('ended', 'cancelled')
       AND EXISTS (
         SELECT 1
         FROM workshop_events pending
         WHERE pending.session_id = session.id
           AND pending.type = 'session.cleanup_pending'
       )
       AND NOT EXISTS (
         SELECT 1
         FROM workshop_events completed
         WHERE completed.session_id = session.id
           AND completed.type = 'session.cleanup_completed'
       )
       AND NOT EXISTS (
         SELECT 1
         FROM workshop_workspaces workspace
         INNER JOIN workshop_workspace_generations generation
           ON generation.workspace_id = workspace.id
         WHERE workspace.session_id = session.id
           AND generation.state != 'archived'
       )
       AND NOT EXISTS (
         SELECT 1
         FROM workshop_workspaces workspace
         INNER JOIN runtime_executions execution
           ON execution.domain_kind = 'workshop'
          AND execution.domain_id = workspace.id
          AND execution.provider_kind = 'hetzner_cloud'
         LEFT JOIN hetzner_allocations allocation
           ON allocation.execution_id = execution.id
         WHERE workspace.session_id = session.id
           AND (
             execution.state != 'archived'
             OR (
               allocation.id IS NOT NULL
               AND (
                 allocation.state != 'deleted'
                 OR allocation.deletion_confirmed_at IS NULL
               )
             )
           )
       )
     ORDER BY session.updated_at ASC, session.id ASC
     LIMIT ?`,
  )
    .bind(input.limit)
    .all<{
      id: string;
      organization_id: string;
      state: "ended" | "cancelled";
    }>();
  let completed = 0;
  for (const session of sessions.results) {
    const result = await env.DB.prepare(
      `INSERT INTO workshop_events (
         id, organization_id, session_id, actor_user_id, type, payload_json,
         created_at
       )
       SELECT ?, ?, ?, NULL, 'session.cleanup_completed', ?, ?
       WHERE NOT EXISTS (
         SELECT 1
         FROM workshop_events existing
         WHERE existing.session_id = ?
           AND existing.type = 'session.cleanup_completed'
       )
       ON CONFLICT(id) DO NOTHING`,
    )
      .bind(
        `workshop-cleanup-completed-${session.id}`,
        session.organization_id,
        session.id,
        JSON.stringify({
          terminalState: session.state,
          asynchronous: true,
        }),
        input.now,
        session.id,
      )
      .run();
    completed += result.meta.changes;
  }
  return completed;
}

async function reconcileResumedProvisioning(input: {
  allocation: AllocationRow;
  execution: RuntimeExecutionHandle;
  preflight: HcloudRuntimePreflight;
  ownership: OwnershipLabels;
  provisioningAttemptId: string;
  now: number;
}): Promise<{ allocation: AllocationRow; serverPresent: boolean }> {
  await heartbeatProvisioningAttempt(
    input.allocation.id,
    input.provisioningAttemptId,
    Date.now(),
  );
  const context = await providerOperationContext(input.preflight.connection.id);
  const base = input.allocation.deterministic_name;
  const result = await runProviderOperation(context, input.allocation.id, {
    kind: "reconcile",
    resources: [
      {
        resourceKind: "ssh_key",
        ...(input.allocation.ssh_key_id
          ? { externalId: providerId(input.allocation.ssh_key_id) }
          : {}),
        deterministicName: `${base}-key`,
        ownership: input.ownership,
      },
      {
        resourceKind: "primary_ip",
        ...(input.allocation.primary_ip_id
          ? { externalId: providerId(input.allocation.primary_ip_id) }
          : {}),
        deterministicName: `${base}-ip-${input.allocation.location}`,
        ownership: input.ownership,
      },
      {
        resourceKind: "server",
        ...(input.allocation.server_id
          ? { externalId: providerId(input.allocation.server_id) }
          : {}),
        deterministicName: base,
        ownership: input.ownership,
      },
    ],
    actionIds: input.allocation.create_action_id
      ? [providerId(input.allocation.create_action_id)]
      : [],
  });
  const reconciled = result.data as ReconcileResult;
  const reconciledAt = Date.parse(reconciled.observedAt);
  if (!Number.isSafeInteger(reconciledAt)) {
    throw appError(
      502,
      "hcloud_reconcile_time_invalid",
      "the provider reconciliation timestamp is invalid",
    );
  }
  for (const resource of reconciled.resources) {
    if (
      resource.status === "ambiguous" ||
      resource.status === "ownership_mismatch"
    ) {
      throw appError(
        409,
        "hcloud_provisioning_reconcile_unsafe",
        "the existing learner-server resources could not be reconciled safely",
      );
    }
    if (resource.status === "missing" && resource.ref.externalId) {
      await clearDeletedProviderIdentity(
        input.allocation.id,
        resource.ref.resourceKind,
        String(resource.ref.externalId),
        reconciledAt,
      );
    }
  }
  const primaryIp = reconciled.resources.find(
    (resource) => resource.ref.resourceKind === "primary_ip",
  );
  if (primaryIp?.status === "present") {
    const write = resourceWrite(result, "primary_ip");
    await insertCostLedger({
      allocationId: input.allocation.id,
      executionId: input.execution.executionId,
      forecast: input.preflight.forecast,
      location: input.allocation.location,
      resourceKind: "primary_ipv4",
      providerResourceId: String(write.externalId),
      providerCreatedAt: providerResourceCreatedAt(write),
    });
  }
  const server = reconciled.resources.find(
    (resource) => resource.ref.resourceKind === "server",
  );
  if (server?.status === "present") {
    const write = resourceWrite(result, "server");
    await insertCostLedger({
      allocationId: input.allocation.id,
      executionId: input.execution.executionId,
      forecast: input.preflight.forecast,
      location: input.allocation.location,
      resourceKind: "server",
      providerResourceId: String(write.externalId),
      providerCreatedAt: providerResourceCreatedAt(write),
    });
    const credential = await env.DB.prepare(
      `SELECT id FROM runtime_provider_guest_credentials
       WHERE execution_id = ? AND generation = ?`,
    )
      .bind(input.execution.executionId, input.execution.generation)
      .first<{ id: string }>();
    if (!credential) {
      throw appError(
        409,
        "hcloud_reconciled_server_bootstrap_missing",
        "the reconciled learner server has no bootstrap credential",
      );
    }
    const adopted = await env.DB.prepare(
      `UPDATE hetzner_allocations
       SET state = 'bootstrapping', provisioning_heartbeat_at = ?,
           updated_at = max(updated_at, ?)
       WHERE id = ? AND provisioning_attempt_id = ?
         AND state IN ('pending', 'creating')`,
    )
      .bind(
        Date.now(),
        input.now,
        input.allocation.id,
        input.provisioningAttemptId,
      )
      .run();
    if (adopted.meta.changes !== 1) throw provisioningSuperseded();
    return {
      allocation:
        (await allocationById(input.allocation.id)) ?? input.allocation,
      serverPresent: true,
    };
  }
  await heartbeatProvisioningAttempt(
    input.allocation.id,
    input.provisioningAttemptId,
    Date.now(),
  );
  return {
    allocation: (await allocationById(input.allocation.id)) ?? input.allocation,
    serverPresent: false,
  };
}

async function createProviderResources(input: {
  allocation: AllocationRow;
  execution: RuntimeExecutionHandle;
  preflight: HcloudRuntimePreflight;
  ownership: OwnershipLabels;
  publicKey: string;
  cloudInit: string;
  provisioningAttemptId: string;
  now: number;
}) {
  const context = await providerOperationContext(input.preflight.connection.id);
  const base = input.allocation.deterministic_name;
  let allocation =
    (await allocationById(input.allocation.id)) ?? input.allocation;
  await heartbeatProvisioningAttempt(
    allocation.id,
    input.provisioningAttemptId,
    Date.now(),
  );
  let sshKeyId: number;
  if (allocation.ssh_key_id) {
    sshKeyId = providerId(allocation.ssh_key_id);
  } else {
    const keyResult = await createOrReconcile({
      context,
      allocationId: allocation.id,
      operation: {
        kind: "create_ssh_key",
        name: `${base}-key`,
        publicKey: input.publicKey,
        ownership: input.ownership,
      },
      resourceKind: "ssh_key",
      deterministicName: `${base}-key`,
      ownership: input.ownership,
    });
    sshKeyId = resourceWrite(keyResult, "ssh_key").externalId;
  }
  await heartbeatProvisioningAttempt(
    allocation.id,
    input.provisioningAttemptId,
    Date.now(),
  );
  allocation = (await allocationById(allocation.id)) ?? allocation;
  const locations = orderedAvailableLocations(
    input.preflight,
    allocation.location,
  );
  let lastError: unknown = null;
  for (const location of locations) {
    try {
      const existingPrimaryIpId =
        allocation.location === location ? allocation.primary_ip_id : null;
      const claimed = await env.DB.prepare(
        `UPDATE hetzner_allocations
         SET location = ?, state = 'creating', provisioning_heartbeat_at = ?,
             updated_at = max(updated_at, ?)
         WHERE id = ? AND provisioning_attempt_id = ?
           AND state IN ('pending', 'creating')`,
      )
        .bind(
          location,
          Date.now(),
          input.now,
          allocation.id,
          input.provisioningAttemptId,
        )
        .run();
      if (claimed.meta.changes !== 1) throw provisioningSuperseded();
      const ipName = `${base}-ip-${location}`;
      let primaryIpId: number;
      if (existingPrimaryIpId) {
        primaryIpId = providerId(existingPrimaryIpId);
      } else {
        const ipResult = await createOrReconcile({
          context,
          allocationId: allocation.id,
          operation: {
            kind: "create_primary_ip",
            name: ipName,
            location,
            ownership: input.ownership,
          },
          resourceKind: "primary_ip",
          deterministicName: ipName,
          ownership: input.ownership,
        });
        const ipWrite = resourceWrite(ipResult, "primary_ip");
        primaryIpId = ipWrite.externalId;
        await insertCostLedger({
          allocationId: allocation.id,
          executionId: input.execution.executionId,
          forecast: input.preflight.forecast,
          location,
          resourceKind: "primary_ipv4",
          providerResourceId: String(primaryIpId),
          providerCreatedAt: providerResourceCreatedAt(ipWrite),
        });
      }
      await heartbeatProvisioningAttempt(
        allocation.id,
        input.provisioningAttemptId,
        Date.now(),
      );
      const serverResult = await createOrReconcile({
        context,
        allocationId: allocation.id,
        operation: {
          kind: "create_server",
          name: base,
          serverType: input.preflight.provider.serverType,
          systemImage: input.preflight.provider.systemImage,
          location,
          primaryIpv4Id: primaryIpId,
          sshKeyId,
          firewallId: providerId(input.preflight.connection.sentinelFirewallId),
          cloudInit: input.cloudInit,
          ownership: input.ownership,
        },
        resourceKind: "server",
        deterministicName: base,
        ownership: input.ownership,
      });
      const serverWrite = resourceWrite(serverResult, "server");
      await insertCostLedger({
        allocationId: allocation.id,
        executionId: input.execution.executionId,
        forecast: input.preflight.forecast,
        location,
        resourceKind: "server",
        providerResourceId: String(serverWrite.externalId),
        providerCreatedAt: providerResourceCreatedAt(serverWrite),
      });
      const completed = await env.DB.prepare(
        `UPDATE hetzner_allocations
         SET state = 'bootstrapping', location = ?,
             provisioning_heartbeat_at = ?, updated_at = max(updated_at, ?)
         WHERE id = ? AND provisioning_attempt_id = ?
           AND state IN ('pending', 'creating')`,
      )
        .bind(
          location,
          Date.now(),
          input.now,
          allocation.id,
          input.provisioningAttemptId,
        )
        .run();
      if (completed.meta.changes !== 1) throw provisioningSuperseded();
      return;
    } catch (error) {
      lastError = error;
      if (isProvisioningSuperseded(error)) throw error;
      if (!isLocationFallbackProviderError(error)) throw error;
      await heartbeatProvisioningAttempt(
        allocation.id,
        input.provisioningAttemptId,
        Date.now(),
      );
      await cleanupFailedLocationAttempt(
        allocation.id,
        location,
        context,
        input.now,
      );
      await heartbeatProvisioningAttempt(
        allocation.id,
        input.provisioningAttemptId,
        Date.now(),
      );
      allocation = (await allocationById(allocation.id)) ?? allocation;
    }
  }
  throw (
    lastError ??
    appError(503, "hcloud_allocation_failed", "Hetzner allocation failed")
  );
}

async function recreateUnhealthyHetznerGeneration(
  allocation: AllocationRow,
  now: number,
): Promise<void> {
  const source = await env.DB.prepare(
    `SELECT
       execution.organization_id,
       execution.domain_id AS workspace_id,
       execution.generation,
       workspace.session_id,
       workspace.user_id,
       workspace.current_generation_id,
       workspace.terminal_route_usernames_json,
       workspace.application_route_ids_json,
       current_generation.id AS source_generation_id,
       current_generation.checkpoint_id,
       session.template_revision_id,
       revision.manifest_json
     FROM runtime_executions execution
     INNER JOIN workshop_workspaces workspace
       ON workspace.id = execution.domain_id
      AND workspace.current_generation_id IS NOT NULL
     INNER JOIN workshop_workspace_generations current_generation
       ON current_generation.id = workspace.current_generation_id
      AND current_generation.runtime_execution_id = execution.id
      AND current_generation.ordinal = execution.generation
     INNER JOIN workshop_sessions session
       ON session.id = workspace.session_id
      AND session.state IN ('lobby', 'live')
     INNER JOIN workshop_template_revisions revision
       ON revision.id = session.template_revision_id
     WHERE execution.id = ?
       AND execution.provider_kind = 'hetzner_cloud'
       AND execution.state IN ('provisioning', 'ready')
     LIMIT 1`,
  )
    .bind(allocation.execution_id)
    .first<{
      organization_id: string;
      workspace_id: string;
      generation: number;
      session_id: string;
      user_id: string;
      current_generation_id: string;
      terminal_route_usernames_json: string | string[];
      application_route_ids_json: string | string[];
      source_generation_id: string;
      checkpoint_id: string | null;
      template_revision_id: string;
      manifest_json: string | WorkshopManifestV1;
    }>();
  if (!source) return;
  const manifest = parseManifest(source.manifest_json);
  const checkpointId = await latestRecoveryCheckpoint({
    sessionId: source.session_id,
    userId: source.user_id,
    manifest,
    fallback: source.checkpoint_id ?? manifest.workspace.initialCheckpointId,
  });
  const generationId = createAppId();
  const ordinal = source.generation + 1;
  const message = `Learner server stopped reporting. Restoring ${checkpointId} on a replacement Hetzner server; work since that checkpoint may be lost.`;
  const terminalRoutes = jsonStrings(source.terminal_route_usernames_json);
  const applicationRoutes = jsonStrings(source.application_route_ids_json);
  await Promise.all([
    revokeWorkshopRouteIssuanceIntents({ workspaceId: source.workspace_id }),
    ...terminalRoutes.map((route) => deleteStargateRoute(route)),
    ...applicationRoutes.map((route) => deleteStargateWorkspaceAppRoute(route)),
  ]);
  const mutations = await env.DB.batch([
    env.DB.prepare(
      `UPDATE workshop_workspace_generations
       SET state = 'archiving', archive_requested_at = ?, updated_at = ?
       WHERE id = ? AND runtime_execution_id = ?`,
    ).bind(now, now, source.source_generation_id, allocation.execution_id),
    env.DB.prepare(
      `INSERT INTO workshop_workspace_generations (
         id, workspace_id, ordinal, checkpoint_id, state,
         requested_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
    ).bind(
      generationId,
      source.workspace_id,
      ordinal,
      checkpointId,
      now,
      now,
      now,
    ),
    env.DB.prepare(
      `UPDATE workshop_workspaces
       SET state = 'recovering', current_generation_id = ?,
           last_checkpoint_id = ?, recovery_message = ?,
           terminal_route_usernames_json = '[]',
           application_route_ids_json = '[]', updated_at = ?
       WHERE id = ? AND current_generation_id = ?`,
    ).bind(
      generationId,
      checkpointId,
      message,
      now,
      source.workspace_id,
      source.source_generation_id,
    ),
    env.DB.prepare(
      `UPDATE workshop_session_members
       SET provision_state = 'queued', provision_error = NULL, updated_at = ?
       WHERE session_id = ? AND user_id = ? AND role = 'participant'`,
    ).bind(now, source.session_id, source.user_id),
    env.DB.prepare(
      `UPDATE workshop_assist_grants
       SET terminal_route_usernames_json = '[]', updated_at = ?
       WHERE workspace_id = ?`,
    ).bind(now, source.workspace_id),
    env.DB.prepare(
      `INSERT INTO workshop_events (
         id, organization_id, session_id, actor_user_id, type,
         payload_json, created_at
       ) VALUES (?, ?, ?, NULL, 'workspace.provider_recovery_requested', ?, ?)`,
    ).bind(
      `workshop-hcloud-recovery-${generationId}`,
      source.organization_id,
      source.session_id,
      JSON.stringify({
        workspaceId: source.workspace_id,
        participantUserId: source.user_id,
        failedExecutionId: allocation.execution_id,
        checkpointId,
        generationId,
        generationOrdinal: ordinal,
        workLossWarning: true,
      }),
      now,
    ),
  ]);
  if (mutations[0]?.meta.changes !== 1 || mutations[2]?.meta.changes !== 1) {
    return;
  }
  try {
    await allocateHetznerWorkshopRuntime(
      {
        organizationId: source.organization_id,
        sessionId: source.session_id,
        templateRevisionId: source.template_revision_id,
        participantUserId: source.user_id,
        workspaceId: source.workspace_id,
        generationId,
        generationOrdinal: ordinal,
        checkpointId,
        manifest,
      },
      { recoveryMessage: message, now },
    );
  } catch (error) {
    // A reporting source must finish its bounded recording drain before the
    // replacement is allocated. Keep that accepted transition as `draining`;
    // the minute sweep will delete it and resume this queued generation.
    if (!isReplacementCleanupPending(error)) throw error;
  }
}

async function latestRecoveryCheckpoint(input: {
  sessionId: string;
  userId: string;
  manifest: WorkshopManifestV1;
  fallback: string;
}): Promise<string> {
  const rows = await env.DB.prepare(
    `SELECT module_id
     FROM workshop_module_progress
     WHERE session_id = ? AND user_id = ?
       AND technical_status IN ('verified', 'caught_up', 'manually_completed')`,
  )
    .bind(input.sessionId, input.userId)
    .all<{ module_id: string }>();
  const completed = new Set(rows.results.map((entry) => entry.module_id));
  let checkpointId = input.fallback;
  for (const module of input.manifest.modules) {
    if (!completed.has(module.id)) break;
    if (module.catchUpCheckpointId) checkpointId = module.catchUpCheckpointId;
  }
  return checkpointId;
}

async function createOrReconcile(input: {
  context: ProviderOperationContext;
  allocationId: string;
  operation: HcloudOperation;
  resourceKind: "server" | "primary_ip" | "ssh_key";
  deterministicName: string;
  ownership: OwnershipLabels;
}): Promise<HcloudOperationResult> {
  try {
    return await runProviderOperation(
      input.context,
      input.allocationId,
      input.operation,
    );
  } catch (error) {
    if (!isRetryableProviderError(error)) throw error;
    const reconciled = await runProviderOperation(
      input.context,
      input.allocationId,
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
    );
    const data = reconciled.data as ReconcileResult;
    const resource = data.resources[0];
    if (resource?.status === "present" && resource.externalId)
      return reconciled;
    throw error;
  }
}

interface ProviderOperationContext {
  connection: Awaited<ReturnType<typeof requireConnection>>;
  credential: Awaited<ReturnType<typeof loadActiveCredential>>;
}

async function providerOperationContext(
  connectionId: string,
): Promise<ProviderOperationContext> {
  const row = await env.DB.prepare(
    `SELECT organization_id FROM organization_provider_connections WHERE id = ?`,
  )
    .bind(connectionId)
    .first<{ organization_id: string }>();
  if (!row) {
    throw appError(
      404,
      "provider_connection_not_found",
      "provider connection not found",
    );
  }
  const connection = await requireConnection(row.organization_id, connectionId);
  if (connection.state !== "active" && connection.state !== "cleanup_pending") {
    throw appError(
      409,
      "provider_connection_inactive",
      "provider connection is inactive",
    );
  }
  return { connection, credential: await loadActiveCredential(connection) };
}

async function runProviderOperation(
  context: ProviderOperationContext,
  allocationId: string,
  operation: HcloudOperation,
): Promise<HcloudOperationResult> {
  const requestId = createAppId();
  const result = await hcloudRunOperation({
    requestId,
    connectionId: context.connection.id,
    credentialContext: context.credential.context,
    credential: context.credential.envelope,
    operation,
  });
  if (result.mustPersistBeforeNextOperation || result.canonicalWrites.length) {
    await persistCanonicalWrites({
      allocationId,
      organizationId: context.connection.organizationId,
      connectionId: context.connection.id,
      writes: result.canonicalWrites,
    });
  }
  return result;
}

async function persistCanonicalWrites(input: {
  allocationId: string;
  organizationId: string;
  connectionId: string;
  writes: readonly CanonicalProviderWrite[];
}): Promise<void> {
  const db = drizzle(env.DB);
  for (const write of input.writes) {
    if (write.connectionId !== input.connectionId) {
      throw appError(
        502,
        "hcloud_canonical_write_identity_invalid",
        "provider write belongs to another connection",
      );
    }
    const observedAt = Date.parse(write.observedAt);
    if (!Number.isSafeInteger(observedAt)) {
      throw appError(
        502,
        "hcloud_canonical_write_time_invalid",
        "provider write has an invalid timestamp",
      );
    }
    if (write.resourceCreatedAt !== undefined) {
      providerResourceCreatedAt(write);
    }
    const allocationSet: Record<string, unknown> = { updatedAt: observedAt };
    if (write.operation !== "resource_deleted") {
      if (write.resourceKind === "primary_ip") {
        allocationSet.primaryIpId = String(write.externalId);
        if (write.publicIpv4) allocationSet.primaryIpv4 = write.publicIpv4;
      } else if (write.resourceKind === "ssh_key") {
        allocationSet.sshKeyId = String(write.externalId);
      } else if (write.resourceKind === "server") {
        allocationSet.serverId = String(write.externalId);
        if (write.actionIds[0]) {
          if (write.operation === "resource_deletion_requested") {
            allocationSet.deleteActionId = String(write.actionIds[0]);
          } else if (write.operation === "resource_created") {
            allocationSet.createActionId = String(write.actionIds[0]);
          }
        }
      }
      if (Object.keys(allocationSet).length > 1) {
        await db
          .update(hetznerAllocations)
          .set(allocationSet)
          .where(eq(hetznerAllocations.id, input.allocationId));
      }
    }
    await db.insert(providerAuditEvents).values({
      id: createAppId(),
      organizationId: input.organizationId,
      connectionId: input.connectionId,
      type: `provider.${write.operation}`,
      payloadJson: {
        allocationId: input.allocationId,
        requestId: write.requestId,
        resourceKind: write.resourceKind,
        externalId: String(write.externalId),
        actionIds: write.actionIds.map(String),
        state: write.state ?? null,
      },
      createdAt: observedAt,
    });
  }
}

async function clearDeletedProviderIdentity(
  allocationId: string,
  resourceKind: CanonicalProviderWrite["resourceKind"],
  externalId: string,
  observedAt: number,
): Promise<void> {
  if (resourceKind === "server") {
    await env.DB.prepare(
      `UPDATE hetzner_allocations
       SET server_id = NULL, create_action_id = NULL,
           delete_action_id = NULL, updated_at = max(updated_at, ?)
       WHERE id = ? AND server_id = ?`,
    )
      .bind(observedAt, allocationId, externalId)
      .run();
  } else if (resourceKind === "primary_ip") {
    await env.DB.prepare(
      `UPDATE hetzner_allocations
       SET primary_ip_id = NULL, primary_ipv4 = NULL,
           updated_at = max(updated_at, ?)
       WHERE id = ? AND primary_ip_id = ?`,
    )
      .bind(observedAt, allocationId, externalId)
      .run();
  } else if (resourceKind === "ssh_key") {
    await env.DB.prepare(
      `UPDATE hetzner_allocations
       SET ssh_key_id = NULL, updated_at = max(updated_at, ?)
       WHERE id = ? AND ssh_key_id = ?`,
    )
      .bind(observedAt, allocationId, externalId)
      .run();
  }
}

async function ensureAllocationRow(input: {
  execution: RuntimeExecutionHandle;
  request: WorkshopProvisioningRequest;
  preflight: HcloudRuntimePreflight;
  now: number;
}): Promise<AllocationRow> {
  const existing = await allocationForExecution(input.execution.executionId);
  if (existing) return existing;
  const id = createAppId();
  const provisioningAttemptId = createAppId();
  const deterministicName = providerResourceName(input.execution.executionId);
  await drizzle(env.DB).insert(hetznerAllocations).values({
    id,
    executionId: input.execution.executionId,
    connectionId: input.preflight.connection.id,
    deterministicName,
    serverType: input.preflight.provider.serverType,
    systemImage: input.preflight.provider.systemImage,
    location: input.preflight.location,
    state: "pending",
    provisioningAttemptId,
    provisioningHeartbeatAt: input.now,
    createdAt: input.now,
    updatedAt: input.now,
  });
  return (await allocationById(id))!;
}

async function claimStaleProvisioningAttempt(
  allocation: AllocationRow,
  now: number,
): Promise<AllocationRow | null> {
  const heartbeatAt =
    allocation.provisioning_heartbeat_at ?? allocation.updated_at;
  if (
    (allocation.state !== "pending" && allocation.state !== "creating") ||
    allocation.server_id !== null ||
    now - heartbeatAt < PROVISIONING_CLAIM_STALE_MS
  ) {
    return null;
  }
  const nextAttemptId = createAppId();
  const claimed = await env.DB.prepare(
    `UPDATE hetzner_allocations
     SET provisioning_attempt_id = ?, provisioning_heartbeat_at = ?,
         updated_at = max(updated_at, ?)
     WHERE id = ? AND provisioning_attempt_id IS ?
       AND provisioning_heartbeat_at IS ? AND server_id IS NULL
       AND state IN ('pending', 'creating')
     RETURNING id`,
  )
    .bind(
      nextAttemptId,
      now,
      now,
      allocation.id,
      allocation.provisioning_attempt_id,
      allocation.provisioning_heartbeat_at,
    )
    .first<{ id: string }>();
  return claimed ? allocationById(allocation.id) : null;
}

async function heartbeatProvisioningAttempt(
  allocationId: string,
  provisioningAttemptId: string,
  now: number,
): Promise<void> {
  const heartbeatAt = Number.isSafeInteger(now) ? now : Date.now();
  const result = await env.DB.prepare(
    `UPDATE hetzner_allocations
     SET provisioning_heartbeat_at = ?, updated_at = max(updated_at, ?)
     WHERE id = ? AND provisioning_attempt_id = ?
       AND state IN ('pending', 'creating')`,
  )
    .bind(heartbeatAt, heartbeatAt, allocationId, provisioningAttemptId)
    .run();
  if (result.meta.changes !== 1) throw provisioningSuperseded();
}

async function insertCostLedger(input: {
  allocationId: string;
  executionId: string;
  forecast: StoredWorkshopCostForecast;
  location: string;
  resourceKind: "server" | "primary_ipv4";
  providerResourceId: string;
  providerCreatedAt: number;
}) {
  const prices = input.forecast.priceObservation.locations.find(
    (entry) => entry.location === input.location,
  );
  if (!prices) {
    throw appError(
      409,
      "hcloud_price_location_missing",
      "location price snapshot is missing",
    );
  }
  const server = input.resourceKind === "server";
  const hourlyNetRaw = server ? prices.serverHourlyNet : prices.ipv4HourlyNet;
  const hourlyGrossRaw = server
    ? prices.serverHourlyGross
    : prices.ipv4HourlyGross;
  const monthlyNetRaw = server
    ? prices.serverMonthlyNet
    : prices.ipv4MonthlyNet;
  const monthlyGrossRaw = server
    ? prices.serverMonthlyGross
    : prices.ipv4MonthlyGross;
  await drizzle(env.DB)
    .insert(runtimeProviderCostLedger)
    .values({
      id: createAppId(),
      executionId: input.executionId,
      allocationId: input.allocationId,
      forecastId: input.forecast.id,
      providerResourceId: input.providerResourceId,
      resourceKind: input.resourceKind,
      resourceType: server
        ? input.forecast.priceObservation.serverType
        : "ipv4",
      location: input.location,
      currency: input.forecast.currency,
      hourlyNetRaw,
      hourlyGrossRaw,
      hourlyNetMicros: decimalCurrencyToMicros(hourlyNetRaw),
      hourlyGrossMicros: decimalCurrencyToMicros(hourlyGrossRaw),
      ...(monthlyNetRaw === undefined
        ? {}
        : {
            monthlyNetRaw,
            monthlyNetMicros: decimalCurrencyToMicros(monthlyNetRaw),
          }),
      ...(monthlyGrossRaw === undefined
        ? {}
        : {
            monthlyGrossRaw,
            monthlyGrossMicros: decimalCurrencyToMicros(monthlyGrossRaw),
          }),
      providerCreatedAt: input.providerCreatedAt,
      createdAt: input.providerCreatedAt,
      updatedAt: input.providerCreatedAt,
    })
    .onConflictDoNothing();
}

async function deleteProviderResource(input: {
  context: ProviderOperationContext;
  allocationId: string;
  kind: "server" | "primary_ip" | "ssh_key";
  externalId: number;
  deterministicName: string;
  now: number;
}): Promise<boolean> {
  const result = await runProviderOperation(input.context, input.allocationId, {
    kind: "delete_resource",
    resourceKind: input.kind,
    externalId: input.externalId,
    name: input.deterministicName,
  });
  const write = result.canonicalWrites.find(
    (candidate) =>
      candidate.resourceKind === input.kind &&
      candidate.externalId === input.externalId,
  );
  if (write?.operation === "resource_deleted") return true;
  const actionId = write?.actionIds[0];
  if (!actionId) return false;
  if (input.kind === "server") {
    await env.DB.prepare(
      `UPDATE hetzner_allocations SET delete_action_id = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(String(actionId), input.now, input.allocationId)
      .run();
  }
  const actionResult = await runProviderOperation(
    input.context,
    input.allocationId,
    {
      kind: "get_action",
      actionId,
      maxWaitMs: 15_000,
    },
  );
  const action = actionResult.data as HcloudAction;
  if (action.status === "error") {
    throw appError(
      503,
      "hcloud_delete_action_failed",
      "Hetzner deletion action failed",
    );
  }
  if (action.status !== "success") return false;
  return true;
}

async function cleanupFailedLocationAttempt(
  allocationId: string,
  location: string,
  context: ProviderOperationContext,
  now: number,
) {
  const row = await allocationById(allocationId);
  if (!row) return;
  if (row.server_id) {
    const deleted = await deleteProviderResource({
      context,
      allocationId,
      kind: "server",
      externalId: providerId(row.server_id),
      deterministicName: row.deterministic_name,
      now,
    });
    if (!deleted) {
      throw appError(
        503,
        "hcloud_location_cleanup_pending",
        "the failed-location server is still being deleted",
      );
    }
    await markLedgerDeleted(allocationId, "server", row.server_id, now);
  }
  if (row.primary_ip_id) {
    const deleted = await deleteProviderResource({
      context,
      allocationId,
      kind: "primary_ip",
      externalId: providerId(row.primary_ip_id),
      deterministicName: `${row.deterministic_name}-ip-${location}`,
      now,
    });
    if (!deleted) {
      throw appError(
        503,
        "hcloud_location_cleanup_pending",
        "the failed-location Primary IPv4 is still being deleted",
      );
    }
    await markLedgerDeleted(
      allocationId,
      "primary_ipv4",
      row.primary_ip_id,
      now,
    );
  }
  await env.DB.prepare(
    `UPDATE hetzner_allocations
     SET server_id = NULL, primary_ip_id = NULL, primary_ipv4 = NULL,
         create_action_id = NULL, retry_count = retry_count + 1, updated_at = ?
     WHERE id = ?`,
  )
    .bind(now, allocationId)
    .run();
}

async function markLedgerDeleted(
  allocationId: string,
  kind: "server" | "primary_ipv4",
  providerResourceId: string | null,
  now: number,
) {
  if (!providerResourceId) return;
  await env.DB.prepare(
    `UPDATE runtime_provider_cost_ledger
     SET deletion_confirmed_at = coalesce(
           deletion_confirmed_at,
           max(?, provider_created_at)
         ),
         updated_at = max(?, provider_created_at)
     WHERE allocation_id = ? AND resource_kind = ? AND provider_resource_id = ?`,
  )
    .bind(now, now, allocationId, kind, providerResourceId)
    .run();
}

async function markCleanupPending(
  row: AllocationRow,
  error: unknown,
  now: number,
) {
  const code =
    error instanceof AppError ? error.code : "provider_cleanup_failed";
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE hetzner_allocations
       SET state = 'cleanup_pending', last_error_code = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(code, now, row.id),
    env.DB.prepare(
      `UPDATE organization_provider_connections
       SET state = 'cleanup_pending', updated_at = ?
       WHERE id = ? AND state != 'disconnected'`,
    ).bind(now, row.connection_id),
  ]);
}

async function restoreConnectionAfterConfirmedCleanup(
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

async function finalizeSessionCostForExecution(
  executionId: string,
  now: number,
) {
  const row = await env.DB.prepare(
    `SELECT workspace.session_id
     FROM runtime_executions execution
     INNER JOIN workshop_workspaces workspace ON workspace.id = execution.domain_id
     WHERE execution.id = ? AND execution.domain_kind = 'workshop'`,
  )
    .bind(executionId)
    .first<{ session_id: string }>();
  if (row) {
    await finalizeWorkshopCostSummary({ sessionId: row.session_id, now });
  }
}

async function revokeHetznerWorkspaceRoutesForExecution(
  executionId: string,
  now: number,
): Promise<void> {
  const workspace = await env.DB.prepare(
    `SELECT workspace.id,
            workspace.terminal_route_usernames_json,
            workspace.application_route_ids_json
     FROM runtime_executions execution
     INNER JOIN workshop_workspaces workspace
       ON execution.domain_kind = 'workshop'
      AND workspace.id = execution.domain_id
     WHERE execution.id = ?`,
  )
    .bind(executionId)
    .first<{
      id: string;
      terminal_route_usernames_json: string | string[];
      application_route_ids_json: string | string[];
    }>();
  if (!workspace) return;

  const terminalRoutes = jsonStrings(workspace.terminal_route_usernames_json);
  const applicationRoutes = jsonStrings(workspace.application_route_ids_json);
  const [intentCleanup, routeCleanup] = await Promise.allSettled([
    revokeWorkshopRouteIssuanceIntents({ workspaceId: workspace.id }),
    Promise.all([
      ...terminalRoutes.map((route) => deleteStargateRoute(route)),
      ...applicationRoutes.map((route) =>
        deleteStargateWorkspaceAppRoute(route),
      ),
    ]),
  ]);
  if (routeCleanup.status === "rejected") throw routeCleanup.reason;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE workshop_workspaces
       SET terminal_route_usernames_json = '[]',
           application_route_ids_json = '[]', updated_at = ?
       WHERE id = ?`,
    ).bind(now, workspace.id),
    env.DB.prepare(
      `UPDATE workshop_assist_grants
       SET terminal_route_usernames_json = '[]', updated_at = ?
       WHERE workspace_id = ?`,
    ).bind(now, workspace.id),
  ]);
  if (intentCleanup.status === "rejected") throw intentCleanup.reason;
}

async function markWorkshopGenerationArchivingForExecution(
  executionId: string,
  now: number,
): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT id, state
     FROM workshop_workspace_generations
     WHERE runtime_execution_id = ?
     LIMIT 1`,
  )
    .bind(executionId)
    .first<{ id: string; state: string }>();
  if (!row || row.state === "archiving" || row.state === "archived") return;
  await recordWorkshopGenerationState({
    generationId: row.id,
    update: {
      state: "archiving",
      runtimeExecutionId: executionId,
      observedAt: now,
    },
  });
}

async function markWorkshopGenerationArchivedForExecution(
  executionId: string,
  now: number,
): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT generation.id, generation.state
     FROM workshop_workspace_generations generation
     INNER JOIN runtime_executions execution
       ON execution.id = generation.runtime_execution_id
      AND execution.state = 'archived'
     WHERE generation.runtime_execution_id = ?
     LIMIT 1`,
  )
    .bind(executionId)
    .first<{ id: string; state: string }>();
  if (!row || row.state === "archived") return;
  await recordWorkshopGenerationState({
    generationId: row.id,
    update: {
      state: "archived",
      runtimeExecutionId: executionId,
      observedAt: now,
    },
  });
}

async function allocationOwnership(
  executionId: string,
): Promise<OwnershipLabels> {
  const row = await env.DB.prepare(
    `SELECT execution.organization_id, execution.provider_connection_id,
            execution.domain_id, execution.generation
     FROM runtime_executions execution WHERE execution.id = ?`,
  )
    .bind(executionId)
    .first<{
      organization_id: string;
      provider_connection_id: string;
      domain_id: string;
      generation: number;
    }>();
  if (!row?.organization_id || !row.provider_connection_id) {
    throw appError(
      409,
      "runtime_provider_identity_invalid",
      "runtime provider identity is incomplete",
    );
  }
  return ownershipLabels(
    row.organization_id,
    row.provider_connection_id,
    row.domain_id,
    row.generation,
  );
}

async function validateProvisioningFence(
  request: WorkshopProvisioningRequest,
  now: number,
): Promise<{ scheduledStartAt: number }> {
  const row = await env.DB.prepare(
    `SELECT session.scheduled_start_at
     FROM workshop_sessions session
     INNER JOIN workshop_workspaces workspace ON workspace.session_id = session.id
     INNER JOIN workshop_workspace_generations generation ON generation.workspace_id = workspace.id
     INNER JOIN workshop_session_members roster
       ON roster.session_id = session.id AND roster.user_id = workspace.user_id
     INNER JOIN member organization_member
       ON organization_member.organization_id = session.organization_id
      AND organization_member.user_id = workspace.user_id
     WHERE session.id = ? AND session.organization_id = ?
       AND session.template_revision_id = ? AND session.state IN ('lobby', 'live')
       AND workspace.id = ? AND workspace.user_id = ?
       AND workspace.current_generation_id = ? AND generation.id = ?
       AND generation.ordinal = ? AND generation.checkpoint_id = ?
       AND roster.role = 'participant'
       AND organization_member.workshop_access_revoking_at IS NULL`,
  )
    .bind(
      request.sessionId,
      request.organizationId,
      request.templateRevisionId,
      request.workspaceId,
      request.participantUserId,
      request.generationId,
      request.generationId,
      request.generationOrdinal,
      request.checkpointId,
    )
    .first<{ scheduled_start_at: number }>();
  if (!row || !Number.isSafeInteger(now)) {
    throw appError(
      409,
      "workshop_provisioning_request_stale",
      "workshop provisioning request is stale or no longer authorized",
    );
  }
  return { scheduledStartAt: row.scheduled_start_at };
}

async function assertProvisioningFence(
  request: WorkshopProvisioningRequest,
  executionId: string,
) {
  const row = await env.DB.prepare(
    `SELECT 1 AS valid
     FROM workshop_workspaces workspace
     INNER JOIN workshop_workspace_generations generation
       ON generation.id = workspace.current_generation_id
     INNER JOIN runtime_executions execution ON execution.id = generation.runtime_execution_id
     INNER JOIN workshop_sessions session ON session.id = workspace.session_id
     WHERE workspace.id = ? AND workspace.session_id = ?
       AND generation.id = ? AND generation.ordinal = ?
       AND execution.id = ? AND execution.provider_kind = 'hetzner_cloud'
       AND execution.provider_connection_id IS NOT NULL
       AND session.state IN ('lobby', 'live')`,
  )
    .bind(
      request.workspaceId,
      request.sessionId,
      request.generationId,
      request.generationOrdinal,
      executionId,
    )
    .first<{ valid: number }>();
  if (!row) {
    throw appError(
      409,
      "workshop_provisioning_request_stale",
      "workshop provisioning authorization changed while the server was starting",
    );
  }
}

function runtimeVmSpecs(
  request: WorkshopProvisioningRequest,
  executionId: string,
): RuntimeVmSpec[] {
  const checkpoint = request.manifest.workspace.checkpoints.find(
    (candidate) => candidate.id === request.checkpointId,
  );
  if (!checkpoint) {
    throw appError(
      404,
      "workshop_checkpoint_not_found",
      "workshop checkpoint not found",
    );
  }
  const images = new Map(
    checkpoint.vmImages.map((entry) => [entry.vmId, entry]),
  );
  return request.manifest.workspace.vms.map((vm, ordinal) => {
    const image = images.get(vm.id);
    if (!image) {
      throw appError(
        409,
        "workshop_checkpoint_incomplete",
        "checkpoint bundle is incomplete",
      );
    }
    return {
      vmId: vm.id,
      ordinal,
      runtimeVmName: `workshop-${executionId}-${runtimeNamePart(vm.id)}`,
      imageKey: image.imageKey,
      imageSha256: image.imageSha256,
      cpuMillis: vm.cpuMillis,
      memoryMib: vm.memoryMib,
      diskMib: vm.diskMib,
    };
  });
}

async function currentExecutionId(
  request: WorkshopProvisioningRequest,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT runtime_execution_id
     FROM workshop_workspace_generations
     WHERE id = ? AND workspace_id = ? AND ordinal = ?`,
  )
    .bind(request.generationId, request.workspaceId, request.generationOrdinal)
    .first<{ runtime_execution_id: string | null }>();
  return row?.runtime_execution_id ?? null;
}

async function previousExecution(request: WorkshopProvisioningRequest) {
  return env.DB.prepare(
    `SELECT id AS generation_id, runtime_execution_id, ordinal
     FROM workshop_workspace_generations
     WHERE workspace_id = ? AND ordinal < ? AND runtime_execution_id IS NOT NULL
     ORDER BY ordinal DESC LIMIT 1`,
  )
    .bind(request.workspaceId, request.generationOrdinal)
    .first<{
      generation_id: string;
      runtime_execution_id: string;
      ordinal: number;
    }>()
    .then((row) =>
      row
        ? {
            generationId: row.generation_id,
            executionId: row.runtime_execution_id,
            ordinal: row.ordinal,
          }
        : null,
    );
}

interface AllocationRow {
  id: string;
  execution_id: string;
  connection_id: string;
  deterministic_name: string;
  server_id: string | null;
  primary_ip_id: string | null;
  primary_ipv4: string | null;
  ssh_key_id: string | null;
  create_action_id: string | null;
  delete_action_id: string | null;
  server_type: string;
  system_image: string;
  location: string;
  state: string;
  provisioning_attempt_id: string | null;
  provisioning_heartbeat_at: number | null;
  retry_count: number;
  last_report_sequence: number;
  last_report_at: number | null;
  recording_drain_requested_at: number | null;
  recording_drain_completed_at: number | null;
  deletion_requested_at: number | null;
  deletion_confirmed_at: number | null;
  created_at: number;
  updated_at: number;
}

interface SweepAllocationRow extends AllocationRow {
  runtime_generation: number;
  runtime_lease_expires_at: number | null;
}

async function allocationForExecution(executionId: string) {
  return env.DB.prepare(
    "SELECT * FROM hetzner_allocations WHERE execution_id = ?",
  )
    .bind(executionId)
    .first<AllocationRow>();
}

async function allocationById(id: string) {
  return env.DB.prepare("SELECT * FROM hetzner_allocations WHERE id = ?")
    .bind(id)
    .first<AllocationRow>();
}

function resourceWrite(
  result: HcloudOperationResult,
  kind: "server" | "primary_ip" | "ssh_key",
): CanonicalProviderWrite {
  const write = result.canonicalWrites.find(
    (candidate) =>
      candidate.resourceKind === kind &&
      (candidate.operation === "resource_created" ||
        candidate.operation === "resource_observed"),
  );
  if (!write) {
    const reconciled = result.data as ReconcileResult;
    const resource = reconciled.resources?.find(
      (candidate) => candidate.ref.resourceKind === kind,
    );
    const externalId = resource?.externalId ?? resource?.ref.externalId;
    if (resource?.status === "present" && externalId) {
      return {
        requestId: createAppId(),
        connectionId: "reconciled",
        observedAt: reconciled.observedAt,
        operation: "resource_observed",
        resourceKind: kind,
        externalId,
        name: resource.ref.deterministicName,
        actionIds: [],
        ...(resource.state ? { state: resource.state } : {}),
        ...(resource.publicIpv4 ? { publicIpv4: resource.publicIpv4 } : {}),
        ...(resource.resourceCreatedAt
          ? { resourceCreatedAt: resource.resourceCreatedAt }
          : {}),
      };
    }
    throw appError(
      502,
      "hcloud_resource_identity_missing",
      "provider resource identity is missing",
    );
  }
  return write;
}

function providerResourceCreatedAt(write: CanonicalProviderWrite): number {
  const createdAt = Date.parse(write.resourceCreatedAt ?? write.observedAt);
  if (!Number.isSafeInteger(createdAt)) {
    throw appError(
      502,
      "hcloud_canonical_write_time_invalid",
      "provider write has an invalid resource creation timestamp",
    );
  }
  return createdAt;
}

function orderedAvailableLocations(
  preflight: HcloudRuntimePreflight,
  preferred?: string,
): string[] {
  const availability = new Map(
    preflight.forecast.priceObservation.locations.map((entry) => [
      entry.location,
      entry.available,
    ]),
  );
  const available = preflight.permittedLocations.filter(
    (location) => availability.get(location) === true,
  );
  if (!preferred || !available.includes(preferred)) return available;
  return [preferred, ...available.filter((location) => location !== preferred)];
}

function providerResourceName(executionId: string): string {
  const normalized = executionId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return `intar-${normalized}`.slice(0, 52).replace(/-+$/g, "");
}

function requiredProvisioningAttemptId(allocation: AllocationRow): string {
  const attemptId = allocation.provisioning_attempt_id?.trim();
  if (!attemptId) {
    throw appError(
      500,
      "hcloud_provisioning_attempt_missing",
      "the learner-server provisioning attempt is missing",
    );
  }
  return attemptId;
}

function provisioningSuperseded(): AppError {
  return appError(
    409,
    "hcloud_provisioning_superseded",
    "a newer learner-server provisioning attempt has taken ownership",
  );
}

function isProvisioningSuperseded(error: unknown): boolean {
  return (
    error instanceof AppError &&
    (error.code === "hcloud_provisioning_superseded" ||
      error.code === "workspace_agent_provisioning_superseded")
  );
}

function providerId(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw appError(
      500,
      "hcloud_external_id_invalid",
      "provider external ID is invalid",
    );
  }
  return id;
}

function runtimeNamePart(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "vm"
  );
}

function parseManifest(value: string | WorkshopManifestV1): WorkshopManifestV1 {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as WorkshopManifestV1;
  } catch {
    throw appError(
      500,
      "workshop_manifest_invalid",
      "the pinned workshop manifest is invalid",
    );
  }
}

function jsonStrings(value: string | string[]): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isRetryableProviderError(error: unknown): boolean {
  return (
    error instanceof AppError && (error.status === 429 || error.status === 503)
  );
}

function isLocationFallbackProviderError(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.status === 503 &&
    error.code === "hcloud_resource_unavailable"
  );
}

function isReplacementCleanupPending(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.code === "hcloud_replacement_cleanup_pending"
  );
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
      "workspace_agent_configuration_missing",
      "the workspace agent control-plane URL is not configured",
    );
  }
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw appError(
      500,
      "workspace_agent_configuration_invalid",
      "the workspace agent control-plane URL is invalid",
    );
  }
  return `${url.origin}/`;
}

async function resolveWorkspaceGuestTools(
  controlPlaneBaseUrl: string,
  pinned: { workspaceAgentSha256: string; kinoSha256: string },
): Promise<{
  agent: { sha256: string; sizeBytes: number; url: string };
  kino: { sha256: string; sizeBytes: number; url: string };
}> {
  if (!isSha256(pinned.workspaceAgentSha256) || !isSha256(pinned.kinoSha256)) {
    throw appError(
      503,
      "workspace_agent_binary_unavailable",
      "the immutable workshop revision has invalid guest-tool pins",
    );
  }
  const sha256 = pinned.workspaceAgentSha256;
  const kinoSha256 = pinned.kinoSha256;
  const key = `workspace-agent/releases/${sha256}/intar-workspace-agent`;
  const binary = await env.VM_IMAGE_REGISTRY_BUCKET.head(key);
  const kinoKey = `workspace-agent/kino/releases/${kinoSha256}/kino`;
  const kinoBinary = await env.VM_IMAGE_REGISTRY_BUCKET.head(kinoKey);
  if (
    !binary ||
    binary.size <= 0 ||
    binary.size > 128 * 1024 * 1024 ||
    !kinoBinary ||
    kinoBinary.size <= 0 ||
    kinoBinary.size > 128 * 1024 * 1024
  ) {
    throw appError(
      503,
      "workspace_agent_binary_unavailable",
      "the pinned workspace agent binary is unavailable",
    );
  }
  return {
    agent: {
      sha256,
      sizeBytes: binary.size,
      url: new URL(
        `/api/runtime/workspace-agent/binaries/${sha256}`,
        controlPlaneBaseUrl,
      ).toString(),
    },
    kino: {
      sha256: kinoSha256,
      sizeBytes: kinoBinary.size,
      url: new URL(
        `/api/runtime/workspace-agent/kino/binaries/${kinoSha256}`,
        controlPlaneBaseUrl,
      ).toString(),
    },
  };
}

function safeError(error: unknown): string {
  if (error instanceof AppError) return error.message.slice(0, 300);
  return "Hetzner learner workspace provisioning failed";
}
