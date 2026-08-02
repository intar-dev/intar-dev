import { env } from "cloudflare:workers";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { CanonicalProviderWrite } from "@intar/provider-contracts";
import type { RuntimeProviderKind } from "@intar/workshop-contracts";
import {
  gcpConnectionDetails,
  hetznerConnectionDetails,
  providerConnections,
  providerCredentialVersions,
  runtimeCheckpointBundles,
  runtimeExecutions,
  runtimeGuestCredentials,
  runtimeProviderAllocations,
  runtimeProviderOperations,
  runtimeProviderReconciliation,
  runtimeProviderResources,
  workshopPublications,
  workshopRuntimeProfileCertifications,
  workshopRuntimeProfiles,
  workshopSessionRuntimeSelections,
  workshopSessions,
  workshopTemplateRevisions,
  workshopTemplates,
} from "@/db/schema";
import { sha256Hex } from "@/control-plane/auth";
import { AppError, appError } from "@/lib/app-error";
import { createAppId } from "@/lib/id";
import {
  archiveRuntimeExecution,
  createRuntimeExecution,
  createRuntimeRecoveryGeneration,
  updateRuntimeExecutionState,
  type RuntimeExecutionHandle,
  type RuntimeVmSpec,
} from "@/lib/runtime-executions";
import { ensureRuntimeVmAccessKeys } from "@/lib/runtime-vm-state";
import { withRuntimeAllocationLock } from "@/lib/runtime-allocation-lock";
import { recordWorkshopGenerationState } from "./provisioning";
import {
  providerCredentialContext,
  providerCredentialEnvelope,
} from "./provider-credential";
import { invokeProviderOperation } from "./provider-service";
import { requireWorkshopMulticloudRuntimeEnabledForOrganization } from "./feature-flag";
import type { WorkshopProvisioningRequest } from "./types";
import {
  buildWorkspaceAgentCloudInit,
  issueWorkspaceAgentBootstrap,
  requiredWorkspaceAgentControlPlaneBaseUrl,
  resolveWorkspaceGuestTools,
  revokeWorkspaceAgentGeneration,
} from "./workspace-agent-control-plane";
import { finalizeCertifiedWorkshopRevision } from "@/control-plane/workshop-registry/publication-state";
import {
  ensureDirectCloudPriceObservation,
  getWorkshopCostProjection,
} from "./cost-storage";
import {
  createRuntimeProviderRegistry,
  isDefinitiveLocationCapacityFailure,
  nextProviderLocationAttempt,
  orderedProviderLocationAttempts,
  requireRuntimeProviderAdapter,
  type ProviderAllocationObservation,
  type RuntimeProviderAdapter,
} from "./runtime-provider";
import {
  finalizeWorkshopCostAfterAllocationDeletion,
  reconcileProviderCostLedger,
} from "./provider-cost-ledger";
import { preflightDirectCloudProvider } from "./direct-provider-preflight";

// A verifier gets 30 minutes for allocate/delete plus four hours per cumulative
// checkpoint (the guest apply timeout is three hours). Reject plans above 48
// hours so the maximum paid verifier window remains explicit and finite.
const CERTIFICATION_BASE_ALLOWANCE_MS = 30 * 60_000;
const CERTIFICATION_PER_CHECKPOINT_ALLOWANCE_MS = 4 * 60 * 60_000;
const CERTIFICATION_MAX_RUNTIME_MS = 48 * 60 * 60_000;

export function certificationRuntimeDurationMs(checkpointCount: number): number {
  if (!Number.isSafeInteger(checkpointCount) || checkpointCount <= 0) {
    throw appError(
      409,
      "workshop_certification_checkpoint_plan_invalid",
      "certification requires a non-empty checkpoint plan",
    );
  }
  const duration =
    CERTIFICATION_BASE_ALLOWANCE_MS +
    checkpointCount * CERTIFICATION_PER_CHECKPOINT_ALLOWANCE_MS;
  if (duration > CERTIFICATION_MAX_RUNTIME_MS) {
    throw appError(
      409,
      "workshop_certification_duration_exceeds_limit",
      "the cumulative certification plan exceeds the finite runtime limit",
    );
  }
  return duration;
}

export async function workshopRuntimeProviderKind(sessionId: string) {
  const rows = await drizzle(env.DB)
    .select({ kind: workshopSessionRuntimeSelections.providerKind })
    .from(workshopSessionRuntimeSelections)
    .where(eq(workshopSessionRuntimeSelections.sessionId, sessionId))
    .limit(1);
  if (!rows[0]) {
    throw appError(
      409,
      "workshop_runtime_provider_missing",
      "workshop session has no runtime provider selection",
    );
  }
  return rows[0].kind;
}

/** Allocate one direct learner VM; no agent_host row is ever synthesized. */
export async function allocateProviderWorkshopRuntime(
  request: WorkshopProvisioningRequest,
  options: { recoveryMessage?: string; now?: number } = {},
): Promise<RuntimeExecutionHandle> {
  const now = options.now ?? Date.now();
  await requireWorkshopMulticloudRuntimeEnabledForOrganization(
    request.organizationId,
  );
  const context = await requireAllocationContext(request);
  const leaseExpiresAt =
    context.scheduledStartAt +
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
  const existing = await currentExecution(request);
  if (existing) return loadRuntimeHandle(existing);
  const source = await previousExecution(request);
  if (source) {
    const deleted = await archiveProviderWorkshopRuntime({
      executionId: source.executionId,
      expectedGeneration: source.generation,
      now,
    });
    if (!deleted) {
      throw appError(
        409,
        "workshop_restore_cleanup_pending",
        "the previous learner VM must be fully deleted before reconstruction",
      );
    }
  }
  const allocated = await withRuntimeAllocationLock({
    key: `runtime-provider-connection:${context.connection.id}`,
    now,
    operation: async () => {
      const attribution = await requireProviderAllocationGuardrails({
        sessionId: request.sessionId,
        context,
        now,
      });
      const { locationAttempts, priceObservationId, costForecastId } =
        attribution;
      const location = locationAttempts[0]!;
      const executionId = createAppId();
      const vms = directRuntimeVmSpecs(request, executionId, context.bundle);
      const execution = source
        ? await createRuntimeRecoveryGeneration({
            sourceExecutionId: source.executionId,
            expectedGeneration: source.generation,
            executionId,
            hostId: null,
            providerKind: context.providerKind,
            providerConnectionId: context.connection.id,
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
            providerKind: context.providerKind,
            providerConnectionId: context.connection.id,
            domainKind: "workshop",
            domainId: request.workspaceId,
            checkpointId: request.checkpointId,
            leaseExpiresAt,
            vms,
            claimActiveSlot: true,
            now,
          });
      if (execution.generation !== request.generationOrdinal) {
        throw appError(
          409,
          "workshop_runtime_generation_mismatch",
          "workshop and runtime generations are out of sync",
        );
      }
      const allocationId = createAppId();
      const deterministicName = providerResourceName(
        request.workspaceId,
        execution.generation,
      );
      const db = drizzle(env.DB);
      try {
        await db.batch([
          db.insert(runtimeProviderAllocations).values({
            id: allocationId,
            executionId: execution.executionId,
            connectionId: context.connection.id,
            runtimeProfileId: context.profile.id,
            priceObservationId,
            costForecastId,
            providerKind: context.providerKind,
            deterministicName,
            machineType: context.profile.machineType,
            resolvedImageId: context.profile.resolvedImageId,
            locationAttemptsJson: locationAttempts,
            location,
            locationAttempt: 1,
            locationAttemptStartedAt: now,
            state: "creating",
            createdAt: now,
            updatedAt: now,
          }),
          db.insert(runtimeProviderReconciliation).values({
            allocationId,
            desiredState: "ready",
            observedState: "creating",
            sweepAfter: now + 10_000,
            updatedAt: now,
          }),
        ]);
      } catch (error) {
        await archiveRuntimeExecution({
          executionId: execution.executionId,
          expectedGeneration: execution.generation,
          endedAt: now,
        });
        await Promise.allSettled([
          recordWorkshopGenerationState({
            generationId: request.generationId,
            update: {
              state: "failed",
              runtimeExecutionId: execution.executionId,
              hostId: null,
              error: "provider allocation persistence failed before any cloud mutation",
              observedAt: now,
            },
          }),
        ]);
        throw error;
      }
      return { execution, allocationId, deterministicName, location };
    },
  });
  const { execution, allocationId, deterministicName, location } = allocated;
  const db = drizzle(env.DB);
  let providerAttempted = false;
  try {
    // Link the Workshop generation before the first paid external mutation.
    // A lost provider response can then resume the same durable allocation.
    await recordWorkshopGenerationState({
      generationId: request.generationId,
      update: {
        state: "provisioning",
        runtimeExecutionId: execution.executionId,
        hostId: null,
        observedAt: now,
      },
    });
    const creation = await prepareProviderCreationInput({
      allocationId,
      execution,
      context,
      deterministicName,
      location,
      locationAttempt: 1,
      kinoProbes: request.manifest.modules.flatMap((module) =>
        module.probeIds.map((probeId) => ({ moduleId: module.id, probeId })),
      ),
      now,
    });
    providerAttempted = true;
    await directProviderAdapter(context.providerKind).createResources(creation);
    const bootstrapping = await db
      .update(runtimeProviderAllocations)
      .set({ state: "bootstrapping", updatedAt: now })
      .where(
        and(
          eq(runtimeProviderAllocations.id, allocationId),
          eq(runtimeProviderAllocations.locationAttempt, 1),
          eq(runtimeProviderAllocations.state, "creating"),
        ),
      );
    if (bootstrapping.meta.changes !== 1) return execution;
    await updateRuntimeExecutionState({
      executionId: execution.executionId,
      expectedGeneration: execution.generation,
      state: "provisioning",
      leaseExpiresAt,
      observedAt: now,
    });
    await recordWorkshopGenerationState({
      generationId: request.generationId,
      update: {
        state: "provisioning",
        runtimeExecutionId: execution.executionId,
        hostId: null,
        observedAt: now,
      },
    });
    return execution;
  } catch (error) {
    const errorCode =
      error instanceof AppError ? error.code : "provider_allocation_failed";
    const fallbackScheduled = await handleLearnerAllocationFailure({
      generationId: request.generationId,
      execution,
      allocationId,
      locationAttempt: 1,
      providerAttempted,
      error,
      errorCode,
      now,
    });
    if (fallbackScheduled) return execution;
    throw error;
  }
}

/**
 * Allocate the single temporary verifier for one direct-cloud runtime profile.
 * Certification executions use the same provider allocation, guest bootstrap,
 * report and reconciliation tables as learner executions, but never acquire a
 * learner active slot or Stargate route.
 */
export async function allocateProviderCertificationRuntime(input: {
  certificationId: string;
  now?: number;
}): Promise<string> {
  const now = input.now ?? Date.now();
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      certification: workshopRuntimeProfileCertifications,
      profile: workshopRuntimeProfiles,
      revision: workshopTemplateRevisions,
      template: workshopTemplates,
      publication: workshopPublications,
      connection: providerConnections,
      credential: providerCredentialVersions,
    })
    .from(workshopRuntimeProfileCertifications)
    .innerJoin(
      workshopRuntimeProfiles,
      eq(
        workshopRuntimeProfiles.id,
        workshopRuntimeProfileCertifications.runtimeProfileId,
      ),
    )
    .innerJoin(
      workshopTemplateRevisions,
      eq(
        workshopTemplateRevisions.id,
        workshopRuntimeProfiles.templateRevisionId,
      ),
    )
    .innerJoin(
      workshopTemplates,
      eq(workshopTemplates.id, workshopTemplateRevisions.templateId),
    )
    .innerJoin(
      workshopPublications,
      eq(
        workshopPublications.publishedRevisionId,
        workshopTemplateRevisions.id,
      ),
    )
    .innerJoin(
      providerConnections,
      eq(
        providerConnections.id,
        workshopRuntimeProfileCertifications.connectionId,
      ),
    )
    .innerJoin(
      providerCredentialVersions,
      eq(
        providerCredentialVersions.id,
        providerConnections.activeCredentialVersionId,
      ),
    )
    .where(
      and(
        eq(workshopRuntimeProfileCertifications.id, input.certificationId),
        eq(workshopRuntimeProfileCertifications.state, "pending"),
        eq(providerConnections.state, "active"),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    const current = await db
      .select({
        state: workshopRuntimeProfileCertifications.state,
        allocationId:
          workshopRuntimeProfileCertifications.verifierAllocationId,
      })
      .from(workshopRuntimeProfileCertifications)
      .where(eq(workshopRuntimeProfileCertifications.id, input.certificationId))
      .limit(1);
    if (current[0]?.allocationId) return current[0].allocationId;
    throw appError(
      409,
      "workshop_certification_not_allocatable",
      "runtime profile certification is not allocatable",
    );
  }
  if (
    (row.profile.providerKind !== "hetzner_cloud" &&
      row.profile.providerKind !== "gcp_compute") ||
    !row.profile.machineType ||
    !row.profile.resolvedImageId ||
    !row.certification.connectionId
  ) {
    throw appError(
      409,
      "workshop_certification_profile_invalid",
      "certification requires a complete direct-cloud profile",
    );
  }
  const manifest = row.revision.manifestJson;
  const evidence = row.certification.evidenceJson;
  const checkpointPlan = certificationCheckpointPlan(evidence);
  const checkpointId = checkpointPlan[0]?.checkpointId;
  if (!checkpointId) {
    throw appError(
      409,
      "workshop_certification_checkpoint_missing",
      "certification has no valid cumulative checkpoint proof plan",
    );
  }
  const bundles = await db
    .select()
    .from(runtimeCheckpointBundles)
    .where(eq(runtimeCheckpointBundles.templateRevisionId, row.revision.id));
  const bundlesByCheckpoint = new Map(
    bundles.map((candidate) => [candidate.checkpointId, candidate]),
  );
  const bundle = bundlesByCheckpoint.get(checkpointId);
  const everyCheckpointHasBundle = checkpointPlan.every((checkpoint) =>
    bundlesByCheckpoint.has(checkpoint.checkpointId),
  );
  const learnerVm = manifest.workspace.vms.find(
    (vm) => vm.id === row.profile.vmId,
  );
  if (!bundle || !everyCheckpointHasBundle || !learnerVm) {
    throw appError(
      409,
      "workshop_certification_artifact_missing",
      "certification profile has no terminal bundle, VM, or location",
    );
  }

  const certificationDurationMs = certificationRuntimeDurationMs(
    checkpointPlan.length,
  );
  const leaseExpiresAt = now + certificationDurationMs;
  const context: AllocationContext = {
    providerKind: row.profile.providerKind,
    connection: row.connection,
    credential: row.credential,
    profile: row.profile as typeof row.profile & {
      machineType: string;
      resolvedImageId: string;
    },
    bundle,
    scheduledStartAt: now,
  };
  const permittedLocationAttempts =
    await requireProviderLocationAttempts(context);
  const priceObservation = await ensureDirectCloudPriceObservation({
    organizationId: row.template.organizationId,
    providerKind: row.profile.providerKind,
    connectionId: row.connection.id,
    runtimeProfileId: row.profile.id,
    now,
  });
  const location = permittedLocationAttempts.find((candidate) =>
    priceObservation.availableLocations.includes(candidate),
  );
  if (!location) {
    throw appError(
      409,
      "provider_location_unavailable",
      "the exact certification profile is unavailable in every approved fallback location",
    );
  }
  const locationAttempts = [
    location,
    ...permittedLocationAttempts.filter((candidate) => candidate !== location),
  ];
  const claimed = await withRuntimeAllocationLock({
    key: `runtime-provider-connection:${row.connection.id}`,
    now,
    operation: async () => {
      const stillPending = await db
        .select({ id: workshopRuntimeProfileCertifications.id })
        .from(workshopRuntimeProfileCertifications)
        .where(
          and(
            eq(workshopRuntimeProfileCertifications.id, row.certification.id),
            eq(workshopRuntimeProfileCertifications.state, "pending"),
            isNull(workshopRuntimeProfileCertifications.verifierAllocationId),
          ),
        )
        .limit(1);
      if (!stillPending[0]) {
        throw appError(
          409,
          "workshop_certification_claim_lost",
          "another verifier claimed the runtime profile certification",
        );
      }
      await requireProviderConnectionSeat(
        row.profile.providerKind as DirectCloudKind,
        row.connection.id,
      );
      const executionId = createAppId();
      const execution = await createRuntimeExecution({
        executionId,
        userId: row.revision.publishedBy,
        organizationId: row.template.organizationId,
        hostId: null,
        providerKind: row.profile.providerKind as DirectCloudKind,
        providerConnectionId: row.certification.connectionId,
        domainKind: "workshop_certification",
        domainId: row.certification.id,
        checkpointId,
        leaseExpiresAt,
        claimActiveSlot: false,
        now,
        vms: [
          {
            vmId: learnerVm.id,
            ordinal: 0,
            runtimeVmName: `workshop-cert-${executionId}-${runtimeNamePart(learnerVm.id)}`,
            imageKey: {
              kind: "direct_cloud_checkpoint",
              checkpointId,
              bundleId: bundle.id,
            },
            imageSha256: bundle.sha256,
            cpuMillis: learnerVm.cpuMillis,
            memoryMib: learnerVm.memoryMib,
            diskMib: learnerVm.diskMib,
          },
        ],
      });
      const allocationId = createAppId();
      const deterministicName = providerResourceName(row.certification.id, 1);
      let claims;
      try {
        claims = await db.batch([
          db.insert(runtimeProviderAllocations).values({
            id: allocationId,
            executionId,
            connectionId: row.connection.id,
            runtimeProfileId: row.profile.id,
            priceObservationId: priceObservation.id,
            costForecastId: null,
            providerKind: row.profile.providerKind as DirectCloudKind,
            deterministicName,
            machineType: row.profile.machineType!,
            resolvedImageId: row.profile.resolvedImageId!,
            locationAttemptsJson: locationAttempts,
            location,
            locationAttempt: 1,
            locationAttemptStartedAt: now,
            state: "creating",
            createdAt: now,
            updatedAt: now,
          }),
          db.insert(runtimeProviderReconciliation).values({
            allocationId,
            desiredState: "ready",
            observedState: "creating",
            sweepAfter: now + 10_000,
            updatedAt: now,
          }),
          db
            .update(workshopRuntimeProfileCertifications)
            .set({
              state: "verifying",
              verifierAllocationId: allocationId,
              startedAt: now,
              evidenceJson: {
                ...evidence,
                currentCheckpointOrdinal: 0,
                phase: "allocating",
                certificationDurationMs,
                certificationDeadlineAt: leaseExpiresAt,
              },
              updatedAt: now,
            })
            .where(
              and(
                eq(workshopRuntimeProfileCertifications.id, row.certification.id),
                eq(workshopRuntimeProfileCertifications.state, "pending"),
                isNull(
                  workshopRuntimeProfileCertifications.verifierAllocationId,
                ),
              ),
            ),
        ]);
      } catch (error) {
        await archiveRuntimeExecution({
          executionId,
          expectedGeneration: 1,
          endedAt: now,
        });
        await db
          .update(workshopRuntimeProfileCertifications)
          .set({
            state: "failed",
            errorCode: "provider_allocation_persistence_failed",
            evidenceJson: {
              ...evidence,
              phase: "failed_before_provider_mutation",
            },
            updatedAt: now,
          })
          .where(
            and(
              eq(
                workshopRuntimeProfileCertifications.id,
                row.certification.id,
              ),
              eq(workshopRuntimeProfileCertifications.state, "pending"),
            ),
          );
        await markWorkshopPublicationCertificationFailed(
          row.publication.id,
          now,
        );
        throw error;
      }
      if (claims[2].meta.changes !== 1) {
        await db.batch([
          db
            .update(runtimeProviderAllocations)
            .set({
              state: "deleted",
              deletionRequestedAt: now,
              deletionConfirmedAt: now,
              lastErrorCode: "workshop_certification_claim_lost",
              updatedAt: now,
            })
            .where(eq(runtimeProviderAllocations.id, allocationId)),
          db
            .update(runtimeProviderReconciliation)
            .set({
              desiredState: "deleted",
              observedState: "deleted",
              sweepAfter: now,
              lastReconciledAt: now,
              updatedAt: now,
            })
            .where(eq(runtimeProviderReconciliation.allocationId, allocationId)),
        ]);
        await archiveRuntimeExecution({
          executionId,
          expectedGeneration: 1,
          endedAt: now,
        });
        throw appError(
          409,
          "workshop_certification_claim_lost",
          "another verifier claimed the runtime profile certification",
        );
      }
      return { execution, executionId, allocationId, deterministicName };
    },
  });
  const { execution, executionId, allocationId, deterministicName } = claimed;
  let providerAttempted = false;
  try {
    const creation = await prepareProviderCreationInput({
      allocationId,
      execution,
      context,
      deterministicName,
      location,
      locationAttempt: 1,
      kinoProbes: manifest.modules.flatMap((module) =>
        module.probeIds.map((probeId) => ({ moduleId: module.id, probeId })),
      ),
      reportExpiresAt: leaseExpiresAt,
      certification: {
        publicationId: row.publication.id,
        checkpointId,
      },
      now,
    });
    providerAttempted = true;
    await directProviderAdapter(row.profile.providerKind).createResources(
      creation,
    );
    const bootstrapping = await db
      .update(runtimeProviderAllocations)
      .set({ state: "bootstrapping", updatedAt: now })
      .where(
        and(
          eq(runtimeProviderAllocations.id, allocationId),
          eq(runtimeProviderAllocations.locationAttempt, 1),
          eq(runtimeProviderAllocations.state, "creating"),
        ),
      );
    if (bootstrapping.meta.changes !== 1) return allocationId;
    await updateRuntimeExecutionState({
      executionId,
      expectedGeneration: 1,
      state: "provisioning",
      leaseExpiresAt,
      observedAt: now,
    });
    await db
      .update(workshopRuntimeProfileCertifications)
      .set({
        evidenceJson: {
          ...evidence,
          currentCheckpointOrdinal: 0,
          phase: "awaiting_checkpoint_proof",
          certificationDurationMs,
          certificationDeadlineAt: leaseExpiresAt,
        },
        updatedAt: now,
      })
      .where(eq(workshopRuntimeProfileCertifications.id, row.certification.id));
    return allocationId;
  } catch (error) {
    const code = error instanceof AppError ? error.code : "provider_allocation_failed";
    const fallbackScheduled = await handleCertificationAllocationFailure({
      certificationId: row.certification.id,
      publicationId: row.publication.id,
      executionId,
      allocationId,
      locationAttempt: 1,
      providerAttempted,
      error,
      errorCode: code,
      evidence: {
        ...evidence,
        certificationDurationMs,
        certificationDeadlineAt: leaseExpiresAt,
      },
      now,
    });
    if (fallbackScheduled) return allocationId;
    throw error;
  }
}

export async function archiveProviderWorkshopRuntime(input: {
  executionId: string;
  expectedGeneration: number;
  now?: number;
}): Promise<boolean> {
  const now = input.now ?? Date.now();
  const context = await loadExecutionAllocation(input.executionId);
  if (!context) return true;
  if (context.generation !== input.expectedGeneration) {
    throw appError(409, "runtime_generation_stale", "runtime generation is stale");
  }
  if (context.allocation.state === "deleted") return true;
  if (
    context.allocation.state !== "draining" &&
    context.allocation.state !== "deleting" &&
    context.allocation.state !== "cleanup_pending"
  ) {
    await drizzle(env.DB).batch([
      drizzle(env.DB)
        .update(runtimeProviderAllocations)
        .set({
          state: "draining",
          recordingDrainRequestedAt: now,
          updatedAt: now,
        })
        .where(eq(runtimeProviderAllocations.id, context.allocation.id)),
      drizzle(env.DB)
        .update(runtimeProviderReconciliation)
        .set({ observedState: "draining", sweepAfter: now + 10_000, updatedAt: now })
        .where(eq(runtimeProviderReconciliation.allocationId, context.allocation.id)),
      drizzle(env.DB)
        .update(runtimeExecutions)
        .set({ state: "archiving", archiveRequestedAt: now, updatedAt: now })
        .where(eq(runtimeExecutions.id, context.executionId)),
    ]);
    return false;
  }
  if (context.allocation.state === "draining") {
    return advanceRecordingDrain(context, now);
  }
  await advanceProviderDeletion(context, now);
  return confirmProviderDeletion(context, now);
}

export async function sweepWorkshopProviderRuntimes(input: {
  now?: number;
  limit?: number;
} = {}): Promise<{ inspected: number; deleted: number; pending: number; failed: number }> {
  const now = input.now ?? Date.now();
  const limit = Math.max(1, Math.min(100, input.limit ?? 25));
  const pendingCertifications = await drizzle(env.DB)
    .select({ id: workshopRuntimeProfileCertifications.id })
    .from(workshopRuntimeProfileCertifications)
    .where(eq(workshopRuntimeProfileCertifications.state, "pending"))
    .limit(limit);
  const result = {
    inspected: pendingCertifications.length,
    deleted: 0,
    pending: 0,
    failed: 0,
  };
  for (const certification of pendingCertifications) {
    try {
      await allocateProviderCertificationRuntime({
        certificationId: certification.id,
        now,
      });
      result.pending += 1;
    } catch {
      result.failed += 1;
    }
  }
  const due = await drizzle(env.DB)
    .select({
      allocation: runtimeProviderAllocations,
      domainKind: runtimeExecutions.domainKind,
    })
    .from(runtimeProviderReconciliation)
    .innerJoin(
      runtimeProviderAllocations,
      eq(runtimeProviderAllocations.id, runtimeProviderReconciliation.allocationId),
    )
    .innerJoin(
      runtimeExecutions,
      eq(runtimeExecutions.id, runtimeProviderAllocations.executionId),
    )
    .where(
      and(
        lte(runtimeProviderReconciliation.sweepAfter, now),
        or(
          isNull(runtimeProviderReconciliation.claimId),
          lte(runtimeProviderReconciliation.claimExpiresAt, now),
        ),
        or(
          inArray(runtimeProviderAllocations.state, [
            "creating",
            "bootstrapping",
            "degraded",
            "rebooting",
            "draining",
            "deleting",
            "cleanup_pending",
          ]),
          and(
            eq(runtimeExecutions.domainKind, "workshop_certification"),
            eq(runtimeProviderAllocations.state, "ready"),
          ),
          and(
            eq(runtimeExecutions.domainKind, "workshop"),
            eq(runtimeProviderAllocations.state, "ready"),
            or(
              isNull(runtimeProviderAllocations.lastReportAt),
              lte(runtimeProviderAllocations.lastReportAt, now - 45_000),
            ),
          ),
        ),
      ),
    )
    .limit(Math.max(1, limit - pendingCertifications.length));
  result.inspected += due.length;
  for (const row of due) {
    const claimId = await claimProviderReconciliation(
      row.allocation.id,
      now,
    );
    if (!claimId) continue;
    let succeeded = false;
    try {
      const context = await loadExecutionAllocation(row.allocation.executionId);
      if (!context) {
        succeeded = true;
        continue;
      }
      if (context.domainKind === "workshop_certification") {
        const outcome = await withRuntimeAllocationLock({
          key: `workshop-certification:${context.workspaceId}:${context.executionId}:g${context.generation}`,
          now,
          operation: async () => {
            const current = await loadExecutionAllocation(context.executionId);
            if (!current || current.domainKind !== "workshop_certification") {
              throw appError(
                409,
                "workshop_certification_fence_lost",
                "the verifier execution changed before certification advanced",
              );
            }
            return advanceCertification(current, now);
          },
        });
        if (outcome === "deleted") result.deleted += 1;
        else result.pending += 1;
        succeeded = true;
        continue;
      }
      if (context.allocation.state === "creating") {
        await advanceProviderCreation(context, now);
        result.pending += 1;
        succeeded = true;
        continue;
      }
      if (context.allocation.state === "bootstrapping") {
        await advanceInitialProvisioning(context, now);
        result.pending += 1;
        succeeded = true;
        continue;
      }
      if (
        context.allocation.state === "ready" ||
        context.allocation.state === "degraded" ||
        context.allocation.state === "rebooting"
      ) {
        await advanceLearnerHealthRecovery(context, now);
        result.pending += 1;
        succeeded = true;
        continue;
      }
      if (
        context.allocation.state === "deleting" ||
        context.allocation.state === "cleanup_pending"
      ) {
        if (
          context.allocation.state === "cleanup_pending" &&
          !context.allocation.fallbackPending &&
          context.allocation.lastErrorCode
        ) {
          await transitionCurrentProviderAttemptToCleanup({
            context,
            expectedLocationAttempt: context.allocation.locationAttempt,
            errorCode: context.allocation.lastErrorCode,
            observedState: "cleanup_pending",
            message: `provider runtime failed (${context.allocation.lastErrorCode}); cleanup is pending`,
            now,
          });
        }
        await advanceProviderDeletion(context, now);
        if (await confirmProviderDeletion(context, now)) result.deleted += 1;
        else result.pending += 1;
      } else if (context.allocation.state === "draining") {
        if (await advanceRecordingDrain(context, now)) result.deleted += 1;
        else result.pending += 1;
      } else {
        await observeProviderAllocation(context, now);
        result.pending += 1;
      }
      succeeded = true;
    } catch {
      result.failed += 1;
    } finally {
      await releaseProviderReconciliationClaim({
        allocationId: row.allocation.id,
        claimId,
        now,
        succeeded,
      });
    }
  }
  return result;
}

const PROVIDER_RECONCILIATION_CLAIM_TTL_MS = 5 * 60_000;
const PROVIDER_RECONCILIATION_RETRY_MS = 10_000;

async function claimProviderReconciliation(
  allocationId: string,
  now: number,
): Promise<string | null> {
  const claimId = createAppId();
  const claimed = await env.DB.prepare(
    `UPDATE runtime_provider_reconciliation
     SET claim_id = ?, claim_expires_at = ?, updated_at = ?
     WHERE allocation_id = ? AND sweep_after <= ?
       AND (claim_id IS NULL OR claim_expires_at <= ?)`,
  )
    .bind(
      claimId,
      now + PROVIDER_RECONCILIATION_CLAIM_TTL_MS,
      now,
      allocationId,
      now,
      now,
    )
    .run();
  return claimed.meta.changes === 1 ? claimId : null;
}

async function releaseProviderReconciliationClaim(input: {
  allocationId: string;
  claimId: string;
  now: number;
  succeeded: boolean;
}): Promise<void> {
  const retryAt = input.now + PROVIDER_RECONCILIATION_RETRY_MS;
  await env.DB.prepare(
    `UPDATE runtime_provider_reconciliation
     SET claim_id = NULL, claim_expires_at = NULL,
         sweep_after = CASE
           WHEN sweep_after <= ? THEN ?
           ELSE sweep_after
         END,
         consecutive_failures = CASE
           WHEN ? THEN 0
           ELSE consecutive_failures + 1
         END,
         last_reconciled_at = CASE
           WHEN ? THEN ?
           ELSE last_reconciled_at
         END,
         updated_at = ?
     WHERE allocation_id = ? AND claim_id = ?`,
  )
    .bind(
      input.now,
      retryAt,
      input.succeeded ? 1 : 0,
      input.succeeded ? 1 : 0,
      input.now,
      input.now,
      input.allocationId,
      input.claimId,
    )
    .run();
}

async function advanceRecordingDrain(
  context: ExecutionAllocationContext,
  now: number,
): Promise<boolean> {
  const requestedAt =
    context.allocation.recordingDrainRequestedAt ?? context.allocation.updatedAt;
  const completed = context.allocation.recordingDrainCompletedAt !== null;
  if (!completed && requestedAt + 60_000 > now) {
    await drizzle(env.DB)
      .update(runtimeProviderReconciliation)
      .set({ sweepAfter: Math.min(requestedAt + 60_000, now + 10_000), updatedAt: now })
      .where(eq(runtimeProviderReconciliation.allocationId, context.allocation.id));
    return false;
  }
  await revokeWorkspaceAgentGeneration({
    executionId: context.executionId,
    generation: context.generation,
    now,
  });
  await drizzle(env.DB).batch([
    drizzle(env.DB)
      .update(runtimeProviderAllocations)
      .set({
        state: "deleting",
        deletionRequestedAt: now,
        updatedAt: now,
      })
      .where(eq(runtimeProviderAllocations.id, context.allocation.id)),
    drizzle(env.DB)
      .update(runtimeProviderReconciliation)
      .set({ desiredState: "deleted", observedState: "deleting", sweepAfter: now, updatedAt: now })
      .where(eq(runtimeProviderReconciliation.allocationId, context.allocation.id)),
  ]);
  await advanceProviderDeletion(context, now);
  return confirmProviderDeletion(context, now);
}

async function advanceCertification(
  context: ExecutionAllocationContext,
  now: number,
): Promise<"pending" | "deleted"> {
  const certification = await drizzle(env.DB)
    .select()
    .from(workshopRuntimeProfileCertifications)
    .where(
      and(
        eq(workshopRuntimeProfileCertifications.id, context.workspaceId),
        eq(
          workshopRuntimeProfileCertifications.verifierAllocationId,
          context.allocation.id,
        ),
      ),
    )
    .limit(1);
  const row = certification[0];
  if (!row) {
    throw appError(
      409,
      "workshop_certification_identity_invalid",
      "verifier allocation has no matching certification",
    );
  }
  if (row.state === "verified") return "deleted";
  if (row.state === "cleanup_pending" || context.allocation.state === "cleanup_pending") {
    if (
      context.allocation.state === "cleanup_pending" &&
      !context.allocation.fallbackPending &&
      context.allocation.lastErrorCode
    ) {
      await transitionCurrentProviderAttemptToCleanup({
        context,
        expectedLocationAttempt: context.allocation.locationAttempt,
        errorCode: context.allocation.lastErrorCode,
        observedState: "cleanup_pending",
        message: `runtime profile certification failed (${context.allocation.lastErrorCode})`,
        now,
      });
    }
    await advanceProviderDeletion(context, now);
    if (await confirmProviderDeletion(context, now)) {
      await drizzle(env.DB)
        .update(workshopRuntimeProfileCertifications)
        .set({
          state: "failed",
          deletionConfirmedAt: now,
          updatedAt: now,
        })
        .where(eq(workshopRuntimeProfileCertifications.id, row.id));
      if (context.certificationPublicationId) {
        await env.DB.prepare(
          `UPDATE workshop_publications
           SET status = 'failed', certification_state = 'failed',
               finished_at = ?, updated_at = ?
           WHERE id = ? AND status = 'building'`,
        )
          .bind(now, now, context.certificationPublicationId)
          .run();
      }
      return "deleted";
    }
    return "pending";
  }
  if (context.allocation.state === "creating") {
    await advanceProviderCreation(context, now);
    return "pending";
  }

  const evidence = row.evidenceJson;
  const checkpointPlan = certificationCheckpointPlan(evidence);
  const checkpointOrdinal = Number(evidence.currentCheckpointOrdinal);
  const checkpoint = Number.isSafeInteger(checkpointOrdinal)
    ? checkpointPlan[checkpointOrdinal]
    : undefined;
  const completedProofs = certificationCompletedProofs(evidence);
  const latest = checkpoint
    ? await latestCertificationProof(context.executionId, checkpoint.checkpointId)
    : null;
  const phase =
    typeof evidence.phase === "string" ? evidence.phase : "awaiting_checkpoint_proof";
  let certificationDurationMs: number | null = null;
  try {
    certificationDurationMs = certificationRuntimeDurationMs(checkpointPlan.length);
  } catch {
    certificationDurationMs = null;
  }
  const certificationStartedAt = row.startedAt ?? context.allocation.createdAt;
  const certificationDeadlineAt =
    certificationDurationMs === null
      ? null
      : certificationStartedAt + certificationDurationMs;
  const certificationTimingInvalid =
    certificationDurationMs === null ||
    Number(evidence.certificationDurationMs) !== certificationDurationMs ||
    Number(evidence.certificationDeadlineAt) !== certificationDeadlineAt;
  const certificationTimedOut =
    certificationDeadlineAt !== null && certificationDeadlineAt <= now;
  if (
    !checkpoint ||
    completedProofs.length !== checkpointOrdinal ||
    certificationTimingInvalid ||
    certificationTimedOut ||
    latest?.phase === "failed" ||
    latest?.health === "failed"
  ) {
    const errorCode =
      !checkpoint ||
      completedProofs.length !== checkpointOrdinal ||
      certificationTimingInvalid
        ? "workshop_certification_evidence_invalid"
        : certificationTimedOut
        ? "workshop_certification_timed_out"
        : "workshop_certification_guest_failed";
    await requestCertificationCleanup({
      context,
      certificationId: row.id,
      evidence,
      errorCode,
      failedReportSequence: latest?.sequence ?? null,
      now,
    });
    return "pending";
  }
  if (!latest || !reportProvesCertification(latest, checkpoint)) {
    await observeProviderAllocation(context, now);
    return "pending";
  }

  if (phase === "allocating" || phase === "awaiting_checkpoint_proof") {
    const rebootOperationKind = `certification_reboot_${checkpointOrdinal}`;
    await directProviderAdapter(context.allocation.providerKind).rebootContext(
      context,
      now,
      rebootOperationKind,
    );
    const rebooted = await drizzle(env.DB).batch([
      drizzle(env.DB)
        .update(runtimeProviderAllocations)
        .set({ state: "rebooting", updatedAt: now })
        .where(
          and(
            eq(runtimeProviderAllocations.id, context.allocation.id),
            eq(
              runtimeProviderAllocations.locationAttempt,
              context.allocation.locationAttempt,
            ),
          ),
        ),
      drizzle(env.DB)
        .update(runtimeProviderReconciliation)
        .set({ sweepAfter: now + 10_000, updatedAt: now })
        .where(
          and(
            eq(
              runtimeProviderReconciliation.allocationId,
              context.allocation.id,
            ),
            sql`EXISTS (
              SELECT 1 FROM runtime_provider_allocations allocation
              WHERE allocation.id = ${context.allocation.id}
                AND allocation.location_attempt = ${context.allocation.locationAttempt}
            )`,
          ),
        ),
      drizzle(env.DB)
        .update(workshopRuntimeProfileCertifications)
        .set({
          evidenceJson: {
            ...evidence,
            phase: "awaiting_reboot_completion",
            currentCheckpointOrdinal: checkpointOrdinal,
            initialProofSequence: latest.sequence,
            initialProofReceivedAt: latest.receivedAt,
            preRebootBootId: latest.bootId,
            rebootRequestedAt: now,
            rebootOperationKind,
            rebootConfirmedAt: null,
          },
          updatedAt: now,
        })
        .where(
          and(
            eq(workshopRuntimeProfileCertifications.id, row.id),
            eq(workshopRuntimeProfileCertifications.state, "verifying"),
            eq(
              workshopRuntimeProfileCertifications.verifierAllocationId,
              context.allocation.id,
            ),
            sql`json_extract(${workshopRuntimeProfileCertifications.evidenceJson}, '$.phase') IN ('allocating', 'awaiting_checkpoint_proof')`,
            sql`json_extract(${workshopRuntimeProfileCertifications.evidenceJson}, '$.currentCheckpointOrdinal') = ${checkpointOrdinal}`,
          ),
        ),
    ]);
    if (
      rebooted[0]?.meta.changes !== 1 ||
      rebooted[1]?.meta.changes !== 1 ||
      rebooted[2]?.meta.changes !== 1
    ) {
      throw appError(
        409,
        "workshop_certification_checkpoint_fence_lost",
        "the checkpoint reboot proof fence changed concurrently",
      );
    }
    return "pending";
  }

  if (phase === "awaiting_reboot_completion") {
    const expectedOperationKind = `certification_reboot_${checkpointOrdinal}`;
    const rebootOperationKind = evidence.rebootOperationKind;
    const preRebootBootId = evidence.preRebootBootId;
    if (
      rebootOperationKind !== expectedOperationKind ||
      typeof preRebootBootId !== "string" ||
      !validCertificationBootId(preRebootBootId)
    ) {
      await requestCertificationCleanup({
        context,
        certificationId: row.id,
        evidence,
        errorCode: "workshop_certification_reboot_evidence_invalid",
        failedReportSequence: latest.sequence,
        now,
      });
      return "pending";
    }
    const operation = await latestCertificationRebootOperation({
      allocationId: context.allocation.id,
      locationAttempt: context.allocation.locationAttempt,
      operationKind: rebootOperationKind,
    });
    if (!operation) {
      await requestCertificationCleanup({
        context,
        certificationId: row.id,
        evidence,
        errorCode: "workshop_certification_reboot_operation_missing",
        failedReportSequence: latest.sequence,
        now,
      });
      return "pending";
    }
    if (operation.state === "failed") {
      await requestCertificationCleanup({
        context,
        certificationId: row.id,
        evidence,
        errorCode:
          operation.errorCode ?? "workshop_certification_reboot_failed",
        failedReportSequence: latest.sequence,
        now,
      });
      return "pending";
    }
    if (operation.state !== "succeeded") {
      if (
        operation.providerOperationId === null &&
        (operation.retryAt === null || operation.retryAt <= now)
      ) {
        await directProviderAdapter(
          context.allocation.providerKind,
        ).rebootContext(context, now, rebootOperationKind);
      }
      await observeProviderAllocation(context, now);
      return "pending";
    }
    const confirmed = await drizzle(env.DB)
      .update(workshopRuntimeProfileCertifications)
      .set({
        evidenceJson: {
          ...evidence,
          phase: "awaiting_reboot_proof",
          rebootConfirmedAt: now,
          rebootProviderOperationId: operation.providerOperationId,
        },
        updatedAt: now,
      })
      .where(
        and(
          eq(workshopRuntimeProfileCertifications.id, row.id),
          eq(workshopRuntimeProfileCertifications.state, "verifying"),
          eq(
            workshopRuntimeProfileCertifications.verifierAllocationId,
            context.allocation.id,
          ),
          sql`json_extract(${workshopRuntimeProfileCertifications.evidenceJson}, '$.phase') = 'awaiting_reboot_completion'`,
          sql`json_extract(${workshopRuntimeProfileCertifications.evidenceJson}, '$.currentCheckpointOrdinal') = ${checkpointOrdinal}`,
          sql`json_extract(${workshopRuntimeProfileCertifications.evidenceJson}, '$.rebootOperationKind') = ${rebootOperationKind}`,
        ),
      );
    if (confirmed.meta.changes !== 1) {
      throw appError(
        409,
        "workshop_certification_checkpoint_fence_lost",
        "the provider reboot completion fence changed concurrently",
      );
    }
    await drizzle(env.DB)
      .update(runtimeProviderReconciliation)
      .set({ sweepAfter: now + 10_000, updatedAt: now })
      .where(eq(runtimeProviderReconciliation.allocationId, context.allocation.id));
    return "pending";
  }

  if (phase === "awaiting_reboot_proof") {
    const initialSequence = Number(evidence.initialProofSequence);
    const initialProofReceivedAt = Number(evidence.initialProofReceivedAt);
    const rebootRequestedAt = Number(evidence.rebootRequestedAt);
    const rebootConfirmedAt = Number(evidence.rebootConfirmedAt);
    const preRebootBootId = evidence.preRebootBootId;
    if (
      !Number.isSafeInteger(initialSequence) ||
      !Number.isSafeInteger(initialProofReceivedAt) ||
      !Number.isSafeInteger(rebootRequestedAt) ||
      !Number.isSafeInteger(rebootConfirmedAt) ||
      typeof preRebootBootId !== "string" ||
      !validCertificationBootId(preRebootBootId) ||
      latest.sequence <= initialSequence ||
      latest.receivedAt <= rebootConfirmedAt ||
      latest.bootId === preRebootBootId
    ) {
      await observeProviderAllocation(context, now);
      return "pending";
    }
    const completedCheckpointProof = {
      checkpointId: checkpoint.checkpointId,
      ordinal: checkpointOrdinal,
      initialProofSequence: initialSequence,
      initialProofReceivedAt,
      preRebootBootId,
      rebootRequestedAt,
      rebootConfirmedAt,
      rebootProofSequence: latest.sequence,
      rebootProofReceivedAt: latest.receivedAt,
      rebootProofBootId: latest.bootId,
    };
    const nextCheckpoint = checkpointPlan[checkpointOrdinal + 1];
    if (nextCheckpoint) {
      await advanceCertificationCheckpoint({
        context,
        certificationId: row.id,
        evidence: {
          ...evidence,
          checkpointProofsCompleted: [
            ...completedProofs,
            completedCheckpointProof,
          ],
        },
        currentOrdinal: checkpointOrdinal,
        nextOrdinal: checkpointOrdinal + 1,
        nextCheckpointId: nextCheckpoint.checkpointId,
        now,
      });
      return "pending";
    }
    await revokeWorkspaceAgentGeneration({
      executionId: context.executionId,
      generation: context.generation,
      now,
    });
    const deleting = await drizzle(env.DB).batch([
      drizzle(env.DB)
        .update(workshopRuntimeProfileCertifications)
        .set({
          evidenceJson: {
            ...evidence,
            phase: "deleting",
            checkpointProofsCompleted: [
              ...completedProofs,
              completedCheckpointProof,
            ],
            deletionRequestedAt: now,
          },
          updatedAt: now,
        })
        .where(
          and(
            eq(workshopRuntimeProfileCertifications.id, row.id),
            eq(workshopRuntimeProfileCertifications.state, "verifying"),
            eq(
              workshopRuntimeProfileCertifications.verifierAllocationId,
              context.allocation.id,
            ),
            sql`json_extract(${workshopRuntimeProfileCertifications.evidenceJson}, '$.phase') = 'awaiting_reboot_proof'`,
            sql`json_extract(${workshopRuntimeProfileCertifications.evidenceJson}, '$.currentCheckpointOrdinal') = ${checkpointOrdinal}`,
          ),
        ),
      drizzle(env.DB)
        .update(runtimeProviderAllocations)
        .set({ state: "deleting", deletionRequestedAt: now, updatedAt: now })
        .where(eq(runtimeProviderAllocations.id, context.allocation.id)),
      drizzle(env.DB)
        .update(runtimeProviderReconciliation)
        .set({ desiredState: "deleted", sweepAfter: now, updatedAt: now })
        .where(eq(runtimeProviderReconciliation.allocationId, context.allocation.id)),
    ]);
    if (deleting[0]?.meta.changes !== 1) {
      throw appError(
        409,
        "workshop_certification_checkpoint_fence_lost",
        "the final checkpoint deletion fence changed concurrently",
      );
    }
    await advanceProviderDeletion(context, now);
    return "pending";
  }

  if (phase === "deleting" || context.allocation.state === "deleting") {
    await advanceProviderDeletion(context, now);
    if (!(await confirmProviderDeletion(context, now))) return "pending";
    const verified = await env.DB.prepare(
      `UPDATE workshop_runtime_profile_certifications
       SET state = 'verified', verified_at = ?, deletion_confirmed_at = ?,
           evidence_json = json_set(evidence_json,
             '$.phase', 'verified',
             '$.deletionConfirmedAt', ?),
           error_code = NULL, updated_at = ?
       WHERE id = ? AND state = 'verifying'
         AND verifier_allocation_id = ?
         AND json_extract(evidence_json, '$.phase') = 'deleting'
         AND json_array_length(json_extract(evidence_json, '$.checkpointProofsCompleted')) =
             json_array_length(json_extract(evidence_json, '$.checkpointProofs'))`,
    )
      .bind(now, now, now, now, row.id, context.allocation.id)
      .run();
    if (verified.meta.changes !== 1) {
      throw appError(
        409,
        "workshop_certification_fence_lost",
        "certification lost its final deletion fence",
      );
    }
    if (context.certificationPublicationId) {
      await finalizeCertifiedWorkshopRevision({
        env,
        publicationId: context.certificationPublicationId,
        now,
      });
    }
    return "deleted";
  }
  await observeProviderAllocation(context, now);
  return "pending";
}

async function requestCertificationCleanup(input: {
  context: ExecutionAllocationContext;
  certificationId: string;
  evidence: Record<string, unknown>;
  errorCode: string;
  failedReportSequence: number | null;
  now: number;
}): Promise<void> {
  const transitioned = await transitionCurrentProviderAttemptToCleanup({
    context: input.context,
    expectedLocationAttempt: input.context.allocation.locationAttempt,
    errorCode: input.errorCode,
    observedState: "certification_failed",
    message: `runtime profile certification failed (${input.errorCode})`,
    now: input.now,
  });
  if (!transitioned) return;
  await env.DB.prepare(
    `UPDATE workshop_runtime_profile_certifications
     SET evidence_json = json_set(
           evidence_json,
           '$.failedReportSequence', ?,
           '$.cleanupRequestedAt', ?
         ),
         updated_at = ?
     WHERE id = ? AND verifier_allocation_id = ?
       AND state = 'cleanup_pending'`,
  )
    .bind(
      input.failedReportSequence,
      input.now,
      input.now,
      input.certificationId,
      input.context.allocation.id,
    )
    .run();
  await advanceProviderDeletion(input.context, input.now);
}

interface CertificationRebootOperation {
  state: "pending" | "running" | "succeeded" | "retryable" | "failed";
  providerOperationId: string | null;
  retryAt: number | null;
  errorCode: string | null;
}

async function latestCertificationRebootOperation(input: {
  allocationId: string;
  locationAttempt: number;
  operationKind: string;
}): Promise<CertificationRebootOperation | null> {
  const row = await env.DB.prepare(
    `SELECT state, provider_operation_id, retry_at, error_code
     FROM runtime_provider_operations
     WHERE allocation_id = ? AND location_attempt = ? AND operation_kind = ?
     ORDER BY created_at DESC, attempt DESC
     LIMIT 1`,
  )
    .bind(input.allocationId, input.locationAttempt, input.operationKind)
    .first<{
      state: CertificationRebootOperation["state"];
      provider_operation_id: string | null;
      retry_at: number | null;
      error_code: string | null;
    }>();
  return row
    ? {
        state: row.state,
        providerOperationId: row.provider_operation_id,
        retryAt: row.retry_at,
        errorCode: row.error_code,
      }
    : null;
}

async function advanceProviderCreation(
  context: ExecutionAllocationContext,
  now: number,
): Promise<void> {
  try {
    // Observation is always first. It adopts a resource whose create response
    // was lost and prevents a second paid allocation.
    await directProviderAdapter(context.allocation.providerKind).observeContext(
      context,
      now,
    );
    const latestAllocation = await drizzle(env.DB)
      .select({
        state: runtimeProviderAllocations.state,
        locationAttempt: runtimeProviderAllocations.locationAttempt,
      })
      .from(runtimeProviderAllocations)
      .where(eq(runtimeProviderAllocations.id, context.allocation.id))
      .limit(1);
    if (
      !latestAllocation[0] ||
      latestAllocation[0].locationAttempt !==
        context.allocation.locationAttempt ||
      ["cleanup_pending", "deleting", "deleted", "failed"].includes(
        latestAllocation[0]?.state ?? "deleted",
      )
    ) {
      return;
    }
    if (
      await loadActiveProviderResource(
        context.allocation.id,
        "instance",
        context.allocation.locationAttempt,
      )
    ) {
      if (
        !(await markProviderAllocationBootstrapping(
          context.allocation.id,
          context.allocation.locationAttempt,
          now,
        ))
      ) {
        return;
      }
      await updateRuntimeExecutionState({
        executionId: context.executionId,
        expectedGeneration: context.generation,
        state: "provisioning",
        observedAt: now,
      });
      await markCertificationAwaitingInitialProof(context, now);
      return;
    }
    const creation = await prepareProviderCreationInput({
      allocationId: context.allocation.id,
      execution: {
        executionId: context.executionId,
        generation: context.generation,
        organizationId: context.connection.organizationId,
        domainId: context.workspaceId,
      },
      context,
      deterministicName: context.allocation.deterministicName,
      location: context.allocation.location,
      locationAttempt: context.allocation.locationAttempt,
      kinoProbes: await loadRuntimeKinoProbes(context.profile.templateRevisionId),
      ...(context.domainKind === "workshop_certification" &&
      context.certificationPublicationId
        ? {
            certification: {
              publicationId: context.certificationPublicationId,
              checkpointId: context.bundle.checkpointId,
            },
          }
        : {}),
      now,
    });
    await directProviderAdapter(context.allocation.providerKind).createResources(
      creation,
    );
    if (
      !(await markProviderAllocationBootstrapping(
        context.allocation.id,
        context.allocation.locationAttempt,
        now,
      ))
    ) {
      return;
    }
    await updateRuntimeExecutionState({
      executionId: context.executionId,
      expectedGeneration: context.generation,
      state: "provisioning",
      observedAt: now,
    });
    await markCertificationAwaitingInitialProof(context, now);
  } catch (error) {
    if (
      !(await providerLocationAttemptIsCurrent(
        context.allocation.id,
        context.allocation.locationAttempt,
      ))
    ) {
      return;
    }
    const errorCode =
      error instanceof AppError ? error.code : "provider_allocation_failed";
    const failure = classifyProviderAllocationFailure(error, now);
    if (
      failure.disposition === "fallback_location" &&
      (await scheduleProviderLocationFallback(context, errorCode, now))
    ) {
      return;
    }
    if (failure.disposition === "reconcile_same_allocation") {
      await drizzle(env.DB).batch([
        drizzle(env.DB)
          .update(runtimeProviderAllocations)
          .set({ state: "creating", lastErrorCode: errorCode, updatedAt: now })
          .where(
            and(
              eq(runtimeProviderAllocations.id, context.allocation.id),
              eq(
                runtimeProviderAllocations.locationAttempt,
                context.allocation.locationAttempt,
              ),
            ),
          ),
        drizzle(env.DB)
          .update(runtimeProviderReconciliation)
          .set({
            desiredState: "ready",
            observedState: "ambiguous",
            sweepAfter: failure.retryAt ?? now + 10_000,
            updatedAt: now,
          })
          .where(
            and(
              eq(
                runtimeProviderReconciliation.allocationId,
                context.allocation.id,
              ),
              sql`EXISTS (
                SELECT 1 FROM runtime_provider_allocations allocation
                WHERE allocation.id = ${context.allocation.id}
                  AND allocation.location_attempt = ${context.allocation.locationAttempt}
              )`,
            ),
          ),
      ]);
      return;
    }
    await transitionCurrentProviderAttemptToCleanup({
      context,
      expectedLocationAttempt: context.allocation.locationAttempt,
      errorCode,
      observedState: "failed",
      message: `provider allocation failed (${errorCode}); manual retry is required`,
      now,
    });
  }
}

async function markCertificationAwaitingInitialProof(
  context: ExecutionAllocationContext,
  now: number,
): Promise<void> {
  if (context.domainKind !== "workshop_certification") return;
  await env.DB.prepare(
    `UPDATE workshop_runtime_profile_certifications
     SET evidence_json = json_set(
           evidence_json,
           '$.phase', 'awaiting_checkpoint_proof',
           '$.currentCheckpointOrdinal', 0
         ),
         error_code = NULL, updated_at = ?
     WHERE id = ? AND state = 'verifying'`,
  )
    .bind(now, context.workspaceId)
    .run();
}

async function markProviderAllocationBootstrapping(
  allocationId: string,
  locationAttempt: number,
  now: number,
): Promise<boolean> {
  const updated = await drizzle(env.DB).batch([
    drizzle(env.DB)
      .update(runtimeProviderAllocations)
      .set({ state: "bootstrapping", lastErrorCode: null, updatedAt: now })
      .where(
        and(
          eq(runtimeProviderAllocations.id, allocationId),
          eq(runtimeProviderAllocations.locationAttempt, locationAttempt),
          eq(runtimeProviderAllocations.state, "creating"),
        ),
      ),
    drizzle(env.DB)
      .update(runtimeProviderReconciliation)
      .set({
        desiredState: "ready",
        observedState: "bootstrapping",
        sweepAfter: now + 10_000,
        lastReconciledAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(runtimeProviderReconciliation.allocationId, allocationId),
          sql`EXISTS (
            SELECT 1 FROM runtime_provider_allocations allocation
            WHERE allocation.id = ${allocationId}
              AND allocation.location_attempt = ${locationAttempt}
          )`,
        ),
      ),
  ]);
  return updated[0]?.meta.changes === 1;
}

async function advanceInitialProvisioning(
  context: ExecutionAllocationContext,
  now: number,
): Promise<void> {
  if (
    initialProviderReadinessTimedOut({
      createdAt: context.allocation.locationAttemptStartedAt,
      lastReportAt: context.allocation.lastReportAt,
      now,
    })
  ) {
    await transitionCurrentProviderAttemptToCleanup({
      context,
      expectedLocationAttempt: context.allocation.locationAttempt,
      errorCode: "reconstruct_required",
      observedState: "initial_readiness_timed_out",
      message:
        "learner VM did not become ready within 15 minutes; cleanup and checkpoint recovery are pending",
      now,
    });
    return;
  }
  await observeProviderAllocation(context, now);
}

export function initialProviderReadinessTimedOut(input: {
  createdAt: number;
  lastReportAt: number | null;
  now: number;
}): boolean {
  return (
    input.lastReportAt === null &&
    input.createdAt + 15 * 60_000 <= input.now
  );
}

async function markCurrentWorkshopGenerationFailed(
  context: ProviderFailureProjectionContext,
  message: string,
  now: number,
): Promise<void> {
  if (context.domainKind !== "workshop") return;
  const generation = await env.DB.prepare(
    `SELECT id, state FROM workshop_workspace_generations
     WHERE runtime_execution_id = ? AND ordinal = ?
     LIMIT 1`,
  )
    .bind(context.executionId, context.generation)
    .first<{ id: string; state: string }>();
  if (!generation || generation.state === "failed") return;
  await recordWorkshopGenerationState({
    generationId: generation.id,
    update: {
      state: "failed",
      runtimeExecutionId: context.executionId,
      hostId: null,
      error: message,
      observedAt: now,
    },
  });
}

async function loadRuntimeKinoProbes(
  templateRevisionId: string,
): Promise<Array<{ moduleId: string; probeId: string }>> {
  const row = await drizzle(env.DB)
    .select({ manifest: workshopTemplateRevisions.manifestJson })
    .from(workshopTemplateRevisions)
    .where(eq(workshopTemplateRevisions.id, templateRevisionId))
    .limit(1);
  const manifest = row[0]?.manifest as {
    modules?: Array<{ id?: unknown; probeIds?: unknown }>;
  } | undefined;
  if (!manifest || !Array.isArray(manifest.modules)) {
    throw appError(
      409,
      "workshop_manifest_unavailable",
      "Workshop runtime probes are unavailable",
    );
  }
  return manifest.modules.flatMap((module) => {
    if (typeof module.id !== "string" || !Array.isArray(module.probeIds)) return [];
    return module.probeIds.flatMap((probeId) =>
      typeof probeId === "string" && probeId.length > 0
        ? [{ moduleId: module.id as string, probeId }]
        : [],
    );
  });
}

async function advanceLearnerHealthRecovery(
  context: ExecutionAllocationContext,
  now: number,
): Promise<void> {
  if (
    !(await providerLocationAttemptIsCurrent(
      context.allocation.id,
      context.allocation.locationAttempt,
    ))
  ) {
    return;
  }
  const lastReportAt = context.allocation.lastReportAt;
  if (
    context.allocation.state === "ready" &&
    (lastReportAt === null || lastReportAt <= now - 45_000)
  ) {
    await drizzle(env.DB).batch([
      drizzle(env.DB)
        .update(runtimeProviderAllocations)
        .set({
          state: "degraded",
          lastErrorCode: "guest_heartbeat_stale",
          updatedAt: now,
        })
        .where(
          and(
            eq(runtimeProviderAllocations.id, context.allocation.id),
            eq(
              runtimeProviderAllocations.locationAttempt,
              context.allocation.locationAttempt,
            ),
          ),
        ),
      drizzle(env.DB)
        .update(runtimeProviderReconciliation)
        .set({ sweepAfter: now + 10_000, updatedAt: now })
        .where(eq(runtimeProviderReconciliation.allocationId, context.allocation.id)),
    ]);
    return;
  }
  if (
    context.allocation.state === "degraded" &&
    (lastReportAt === null || lastReportAt <= now - 90_000)
  ) {
    await rebootProviderAllocation(context, now, "learner_health_reboot");
    await drizzle(env.DB).batch([
      drizzle(env.DB)
        .update(runtimeProviderAllocations)
        .set({
          state: "rebooting",
          retryCount: context.allocation.retryCount + 1,
          lastErrorCode: "guest_heartbeat_rebooting",
          updatedAt: now,
        })
        .where(
          and(
            eq(runtimeProviderAllocations.id, context.allocation.id),
            eq(
              runtimeProviderAllocations.locationAttempt,
              context.allocation.locationAttempt,
            ),
          ),
        ),
      drizzle(env.DB)
        .update(runtimeProviderReconciliation)
        .set({ sweepAfter: now + 3 * 60_000, updatedAt: now })
        .where(eq(runtimeProviderReconciliation.allocationId, context.allocation.id)),
    ]);
    return;
  }
  if (
    context.allocation.state === "rebooting" &&
    context.allocation.updatedAt <= now - 3 * 60_000
  ) {
    await transitionCurrentProviderAttemptToCleanup({
      context,
      expectedLocationAttempt: context.allocation.locationAttempt,
      errorCode: "reconstruct_required",
      observedState: "health_recovery_failed",
      message:
        "learner VM did not recover after reboot; cleanup and checkpoint recovery are pending",
      now,
    });
    return;
  }
  await observeProviderAllocation(context, now);
}

async function rebootProviderAllocation(
  context: ExecutionAllocationContext,
  now: number,
  operationKind: string,
): Promise<void> {
  await directProviderAdapter(context.allocation.providerKind).rebootContext(
    context,
    now,
    operationKind,
  );
}

interface CertificationCheckpointPlan {
  checkpointId: string;
  expectedModuleIds: string[];
  expectedProbeIds: string[];
}

function certificationCheckpointPlan(
  evidence: Record<string, unknown>,
): CertificationCheckpointPlan[] {
  const cumulativeIds = certificationStringList(
    evidence.cumulativeCheckpointIds,
  );
  if (!cumulativeIds || !Array.isArray(evidence.checkpointProofs)) return [];
  const plans = evidence.checkpointProofs.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const candidate = value as Record<string, unknown>;
    const checkpointId = candidate.checkpointId;
    const expectedModuleIds = certificationStringList(
      candidate.expectedModuleIds,
    );
    const expectedProbeIds = certificationStringList(candidate.expectedProbeIds);
    return typeof checkpointId === "string" &&
      checkpointId.length > 0 &&
      expectedModuleIds !== null &&
      expectedModuleIds.length > 0 &&
      expectedProbeIds !== null
      ? [{ checkpointId, expectedModuleIds, expectedProbeIds }]
      : [];
  });
  if (
    plans.length === 0 ||
    plans.length !== cumulativeIds.length ||
    plans.some((plan, ordinal) => plan.checkpointId !== cumulativeIds[ordinal])
  ) {
    return [];
  }
  return plans;
}

function certificationStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const strings = value.filter(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.length > 0,
  );
  return strings.length === value.length && new Set(strings).size === strings.length
    ? strings
    : null;
}

function certificationCompletedProofs(
  evidence: Record<string, unknown>,
): Array<Record<string, unknown>> {
  return Array.isArray(evidence.checkpointProofsCompleted)
    ? evidence.checkpointProofsCompleted.filter(
        (value): value is Record<string, unknown> =>
          Boolean(value) && typeof value === "object" && !Array.isArray(value),
      )
    : [];
}

interface CertificationProof {
  sequence: number;
  checkpointId: string;
  bootId: string;
  phase: string;
  health: string;
  terminalReady: boolean;
  completedModuleIds: string[];
  probes: Array<{ id: string; status: string }>;
  receivedAt: number;
}

async function latestCertificationProof(
  executionId: string,
  checkpointId: string,
): Promise<CertificationProof | null> {
  const row = await env.DB.prepare(
    `SELECT sequence, checkpoint_id, boot_id, phase, health, terminal_ready,
            completed_module_ids_json, probes_json, received_at
     FROM runtime_guest_reports
     WHERE execution_id = ? AND checkpoint_id = ?
     ORDER BY sequence DESC
     LIMIT 1`,
  )
    .bind(executionId, checkpointId)
    .first<{
      sequence: number;
      checkpoint_id: string;
      boot_id: string;
      phase: string;
      health: string;
      terminal_ready: number;
      completed_module_ids_json: string;
      probes_json: string;
      received_at: number;
    }>();
  if (!row) return null;
  let probes: unknown;
  let completedModuleIds: unknown;
  try {
    probes = JSON.parse(row.probes_json);
    completedModuleIds = JSON.parse(row.completed_module_ids_json);
  } catch {
    return null;
  }
  if (
    !validCertificationBootId(row.boot_id) ||
    !Array.isArray(probes) ||
    !Array.isArray(completedModuleIds)
  ) {
    return null;
  }
  return {
    sequence: row.sequence,
    checkpointId: row.checkpoint_id,
    bootId: row.boot_id,
    phase: row.phase,
    health: row.health,
    terminalReady: row.terminal_ready === 1,
    completedModuleIds: completedModuleIds.filter(
      (value): value is string => typeof value === "string",
    ),
    probes: probes.flatMap((probe) =>
      probe &&
      typeof probe === "object" &&
      typeof (probe as { id?: unknown }).id === "string" &&
      typeof (probe as { status?: unknown }).status === "string"
        ? [
            {
              id: (probe as { id: string }).id,
              status: (probe as { status: string }).status,
            },
          ]
        : [],
    ),
    receivedAt: row.received_at,
  };
}

function validCertificationBootId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    value,
  );
}

function reportProvesCertification(
  report: CertificationProof,
  checkpoint: CertificationCheckpointPlan,
): boolean {
  if (
    report.checkpointId !== checkpoint.checkpointId ||
    report.phase !== "ready" ||
    report.health !== "healthy" ||
    !report.terminalReady ||
    report.completedModuleIds.length !== checkpoint.expectedModuleIds.length ||
    report.completedModuleIds.some(
      (moduleId, index) => moduleId !== checkpoint.expectedModuleIds[index],
    )
  ) {
    return false;
  }
  const statuses = new Map(report.probes.map((probe) => [probe.id, probe.status]));
  return checkpoint.expectedProbeIds.every(
    (probeId) => statuses.get(probeId) === "pass",
  );
}

async function advanceCertificationCheckpoint(input: {
  context: ExecutionAllocationContext;
  certificationId: string;
  evidence: Record<string, unknown>;
  currentOrdinal: number;
  nextOrdinal: number;
  nextCheckpointId: string;
  now: number;
}): Promise<void> {
  const nextBundles = await drizzle(env.DB)
    .select()
    .from(runtimeCheckpointBundles)
    .where(
      and(
        eq(
          runtimeCheckpointBundles.templateRevisionId,
          input.context.profile.templateRevisionId,
        ),
        eq(runtimeCheckpointBundles.checkpointId, input.nextCheckpointId),
      ),
    )
    .limit(1);
  const nextBundle = nextBundles[0];
  if (
    !nextBundle ||
    nextBundle.workspaceAgentSha256 !== input.context.bundle.workspaceAgentSha256 ||
    nextBundle.kinoSha256 !== input.context.bundle.kinoSha256
  ) {
    throw appError(
      409,
      "workshop_certification_checkpoint_bundle_invalid",
      "the next checkpoint bundle is unavailable or changes pinned guest tools",
    );
  }
  const completedProofs = certificationCompletedProofs(input.evidence);
  if (completedProofs.length !== input.nextOrdinal) {
    throw appError(
      409,
      "workshop_certification_checkpoint_fence_lost",
      "the cumulative checkpoint proof ordinal is inconsistent",
    );
  }
  const commandFenceHash = await sha256Hex(
    `checkpoint-command-fence:${createAppId()}`,
  );
  const nextEvidence = {
    ...input.evidence,
    phase: "awaiting_checkpoint_proof",
    currentCheckpointOrdinal: input.nextOrdinal,
    checkpointAdvancedAt: input.now,
    initialProofSequence: null,
    initialProofReceivedAt: null,
    preRebootBootId: null,
    rebootRequestedAt: null,
    rebootOperationKind: null,
    rebootConfirmedAt: null,
    rebootProviderOperationId: null,
  };
  const results = await drizzle(env.DB).batch([
    drizzle(env.DB)
      .update(workshopRuntimeProfileCertifications)
      .set({ evidenceJson: nextEvidence, updatedAt: input.now })
      .where(
        and(
          eq(workshopRuntimeProfileCertifications.id, input.certificationId),
          eq(workshopRuntimeProfileCertifications.state, "verifying"),
          eq(
            workshopRuntimeProfileCertifications.verifierAllocationId,
            input.context.allocation.id,
          ),
          sql`json_extract(${workshopRuntimeProfileCertifications.evidenceJson}, '$.phase') = 'awaiting_reboot_proof'`,
          sql`json_extract(${workshopRuntimeProfileCertifications.evidenceJson}, '$.currentCheckpointOrdinal') = ${input.currentOrdinal}`,
        ),
      ),
    drizzle(env.DB)
      .update(runtimeExecutions)
      .set({
        checkpointId: input.nextCheckpointId,
        state: "provisioning",
        updatedAt: input.now,
      })
      .where(
        and(
          eq(runtimeExecutions.id, input.context.executionId),
          eq(runtimeExecutions.generation, input.context.generation),
          eq(runtimeExecutions.domainKind, "workshop_certification"),
          eq(runtimeExecutions.domainId, input.certificationId),
          eq(runtimeExecutions.checkpointId, input.context.bundle.checkpointId),
        ),
      ),
    drizzle(env.DB)
      .update(runtimeGuestCredentials)
      .set({
        checkpointBundleId: nextBundle.id,
        checkpointDownloadTokenHash: commandFenceHash,
        checkpointDownloadExpiresAt: input.now,
        checkpointFirstDownloadedAt: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(runtimeGuestCredentials.executionId, input.context.executionId),
          eq(runtimeGuestCredentials.generation, input.context.generation),
          eq(runtimeGuestCredentials.checkpointBundleId, input.context.bundle.id),
          isNull(runtimeGuestCredentials.reportCredentialRevokedAt),
        ),
      ),
    drizzle(env.DB)
      .update(runtimeProviderAllocations)
      .set({ state: "bootstrapping", updatedAt: input.now })
      .where(eq(runtimeProviderAllocations.id, input.context.allocation.id)),
    drizzle(env.DB)
      .update(runtimeProviderReconciliation)
      .set({
        desiredState: "ready",
        observedState: "bootstrapping",
        sweepAfter: input.now + 10_000,
        updatedAt: input.now,
      })
      .where(
        eq(
          runtimeProviderReconciliation.allocationId,
          input.context.allocation.id,
        ),
      ),
  ]);
  if (results.some((result) => result.meta.changes !== 1)) {
    throw appError(
      409,
      "workshop_certification_checkpoint_fence_lost",
      "the cumulative checkpoint advance lost its execution fence",
    );
  }
}

async function createHetznerResources(input: CreationInput) {
  const details = await drizzle(env.DB)
    .select()
    .from(hetznerConnectionDetails)
    .where(eq(hetznerConnectionDetails.connectionId, input.context.connection.id))
    .limit(1);
  const sentinel = details[0];
  if (!sentinel) throw appError(409, "provider_connection_incomplete", "Hetzner connection details are missing");
  const ownership = ownershipLabels(input);
  const primary = await providerMutation(input, "create_primary_ip", {
    kind: "create_primary_ip",
    name: `${input.deterministicName}-ipv4`,
    location: input.location,
    ownership,
  });
  const primaryId = requiredExternalId(primary, "primary_ip");
  const ssh = await providerMutation(input, "create_ssh_key", {
    kind: "create_ssh_key",
    name: `${input.deterministicName}-ssh`,
    publicKey: input.sshPublicKey,
    ownership,
  });
  const sshId = requiredExternalId(ssh, "ssh_key");
  await providerMutation(input, "create_server", {
    kind: "create_server",
    name: input.deterministicName,
    serverType: input.context.profile.machineType,
    systemImage: input.context.profile.resolvedImageId,
    location: input.location,
    primaryIpv4Id: Number(primaryId),
    sshKeyId: Number(sshId),
    firewallId: Number(sentinel.sentinelFirewallId),
    cloudInit: input.cloudInit,
    ownership,
  });
}

async function createGcpResources(input: CreationInput) {
  const details = await drizzle(env.DB)
    .select()
    .from(gcpConnectionDetails)
    .where(eq(gcpConnectionDetails.connectionId, input.context.connection.id))
    .limit(1);
  const foundation = details[0];
  if (!foundation) throw appError(409, "provider_connection_incomplete", "GCP connection details are missing");
  await providerMutation(input, "create_instance", {
    kind: "create_instance",
    name: input.deterministicName,
    zone: input.location,
    machineType: input.context.profile.machineType,
    sourceImage: input.context.profile.resolvedImageId,
    rootDiskType: input.context.profile.rootDiskType,
    rootDiskGib: input.context.profile.diskMib / 1024,
    networkSelfLink: foundation.networkSelfLink,
    subnetworkSelfLink: foundation.subnetSelfLink,
    sshPublicKey: input.sshPublicKey,
    startupScript: input.cloudInit,
    ownership: ownershipLabels(input),
    generation: input.execution.generation,
  });
}

type DirectCloudKind = "hetzner_cloud" | "gcp_compute";

interface ProductionRuntimeProviderAdapter extends RuntimeProviderAdapter {
  readonly kind: RuntimeProviderKind;
  createResources(input: CreationInput): Promise<void>;
  observeContext(
    context: ExecutionAllocationContext,
    now: number,
  ): Promise<void>;
  rebootContext(
    context: ExecutionAllocationContext,
    now: number,
    operationKind: string,
  ): Promise<void>;
  deleteContext(
    context: ExecutionAllocationContext,
    now: number,
  ): Promise<void>;
}

function directAdapter(kind: DirectCloudKind): ProductionRuntimeProviderAdapter {
  const loadRequestContext = async (input: {
    allocationId: string;
    executionId: string;
  }) => {
    const context = await loadExecutionAllocation(input.executionId);
    if (
      !context ||
      context.allocation.id !== input.allocationId ||
      context.allocation.providerKind !== kind
    ) {
      throw appError(
        409,
        "runtime_provider_allocation_mismatch",
        "the provider allocation does not match the registered adapter",
      );
    }
    return context;
  };
  const adapter: ProductionRuntimeProviderAdapter = {
    kind,
    async resolveProfile(input) {
      if (
        input.profile.providerKind !== kind ||
        input.connection?.providerKind !== kind
      ) {
        throw appError(
          409,
          "runtime_provider_profile_mismatch",
          "the runtime profile does not match the registered provider adapter",
        );
      }
      return input.profile;
    },
    async prepareSession(input) {
      const profile = await adapter.resolveProfile({
        organizationId: input.organizationId,
        profile: input.profile,
        connection: input.connection,
        now: input.now,
      });
      return {
        profile,
        connectionId: input.connection?.id ?? null,
        permittedLocations: profile.locations,
        catalogObservedAt: input.now,
      };
    },
    async quote() {
      throw appError(
        409,
        "runtime_provider_quote_context_required",
        "provider quotes are persisted through the Workshop cost harness",
      );
    },
    async preflight(input) {
      return preflightDirectCloudProvider(input);
    },
    async advanceAllocation(input) {
      const context = await loadRequestContext(input);
      await adapter.observeContext(context, input.now);
      return allocationObservation(context.allocation.id);
    },
    async observeAllocation(input) {
      const context = await loadRequestContext(input);
      await adapter.observeContext(context, input.now);
      return allocationObservation(context.allocation.id);
    },
    async reboot(input) {
      const context = await loadRequestContext(input);
      await adapter.rebootContext(context, input.now, "adapter_reboot");
      return allocationObservation(context.allocation.id);
    },
    async advanceDeletion(input) {
      const context = await loadRequestContext(input);
      await adapter.deleteContext(context, input.now);
      await confirmProviderDeletion(context, input.now);
      return allocationObservation(context.allocation.id);
    },
    async inspectConnection() {
      throw appError(
        409,
        "runtime_provider_connection_context_required",
        "provider connection inspection is handled by the credential boundary",
      );
    },
    async rotateCredential() {
      throw appError(
        409,
        "runtime_provider_connection_context_required",
        "provider credential rotation is handled by the credential boundary",
      );
    },
    async sweep(input) {
      const rows = await drizzle(env.DB)
        .select({ id: runtimeProviderAllocations.id })
        .from(runtimeProviderAllocations)
        .where(
          and(
            eq(runtimeProviderAllocations.providerKind, kind),
            input.connectionId === null
              ? undefined
              : eq(runtimeProviderAllocations.connectionId, input.connectionId),
          ),
        )
        .limit(input.limit);
      return Promise.all(rows.map((row) => allocationObservation(row.id)));
    },
    createResources:
      kind === "hetzner_cloud" ? createHetznerResources : createGcpResources,
    async observeContext(context, now) {
      const mutation = creationInputFromContext(context, now);
      if (kind === "gcp_compute") {
        await pollPendingGcpOperations(mutation, now);
        const bootDisk = await loadActiveProviderResource(
          context.allocation.id,
          "boot_disk",
          context.allocation.locationAttempt,
        );
        await providerMutation(mutation, "observe_allocation", {
          kind: "observe_allocation",
          zone: context.allocation.location,
          instanceName: context.allocation.deterministicName,
          ownership: ownershipLabels(mutation),
          ...(bootDisk ? { bootDiskName: resourceName(bootDisk) } : {}),
        });
        return;
      }
      await discoverExpectedHetznerResources(mutation);
      const resources = await drizzle(env.DB)
        .select()
        .from(runtimeProviderResources)
        .where(
          and(
            eq(runtimeProviderResources.allocationId, context.allocation.id),
            eq(
              runtimeProviderResources.locationAttempt,
              context.allocation.locationAttempt,
            ),
          ),
        );
      await providerMutation(mutation, "reconcile", {
        kind: "reconcile",
        resources: resources.map((resource) => ({
          resourceKind: resource.resourceKind,
          externalId: Number(resource.providerResourceId),
          deterministicName: resourceName(resource),
          ownership: ownershipLabels(mutation),
        })),
        actionIds: await pendingHetznerActionIds(
          context.allocation.id,
          context.allocation.locationAttempt,
          now,
        ),
      });
    },
    async rebootContext(context, now, operationKind) {
      const mutation = creationInputFromContext(context, now);
      if (kind === "gcp_compute") {
        await providerMutation(mutation, operationKind, {
          kind: "reboot_instance",
          zone: context.allocation.location,
          instanceName: context.allocation.deterministicName,
        });
        return;
      }
      const instances = await drizzle(env.DB)
        .select({ id: runtimeProviderResources.providerResourceId })
        .from(runtimeProviderResources)
        .where(
          and(
            eq(runtimeProviderResources.allocationId, context.allocation.id),
            eq(
              runtimeProviderResources.locationAttempt,
              context.allocation.locationAttempt,
            ),
            eq(runtimeProviderResources.resourceKind, "instance"),
            isNull(runtimeProviderResources.disappearanceConfirmedAt),
          ),
        )
        .limit(1);
      const serverId = Number(instances[0]?.id);
      if (!Number.isSafeInteger(serverId) || serverId <= 0) {
        throw appError(
          409,
          "provider_instance_missing",
          "provider instance identity is missing",
        );
      }
      await providerMutation(mutation, operationKind, {
        kind: "reboot_server",
        serverId,
      });
    },
    async deleteContext(context, now) {
      const mutation = creationInputFromContext(context, now);
      if (kind === "gcp_compute") {
        await providerMutation(mutation, "delete_instance", {
          kind: "delete_instance",
          zone: context.allocation.location,
          instanceName: context.allocation.deterministicName,
          ownership: ownershipLabels(mutation),
        });
        return;
      }
      await discoverExpectedHetznerResources(mutation);
      const resources = await drizzle(env.DB)
        .select()
        .from(runtimeProviderResources)
        .where(
          and(
            eq(runtimeProviderResources.allocationId, context.allocation.id),
            eq(
              runtimeProviderResources.locationAttempt,
              context.allocation.locationAttempt,
            ),
            isNull(runtimeProviderResources.disappearanceConfirmedAt),
          ),
        );
      for (const resourceKind of [
        { stored: "instance", provider: "server" },
        { stored: "ipv4", provider: "primary_ip" },
        { stored: "ssh_key", provider: "ssh_key" },
      ] as const) {
        const resource = resources.find(
          (candidate) => candidate.resourceKind === resourceKind.stored,
        );
        if (!resource) continue;
        await providerMutation(mutation, `delete_${resourceKind.provider}`, {
          kind: "delete_resource",
          resourceKind: resourceKind.provider,
          externalId: Number(resource.providerResourceId),
          name: resourceName(resource),
        });
      }
    },
  };
  return adapter;
}

const unsupportedAgentOperation = async () => {
  throw appError(
    409,
    "runtime_provider_operation_not_applicable",
    "agent KVM operations use the organization-runner desired-state harness",
  );
};

const agentRuntimeProviderAdapter: ProductionRuntimeProviderAdapter = {
  kind: "agent_kvm",
  async resolveProfile({ profile }) {
    if (profile.providerKind !== "agent_kvm") {
      throw appError(
        409,
        "runtime_provider_profile_mismatch",
        "the runtime profile does not match the agent KVM adapter",
      );
    }
    return profile;
  },
  async prepareSession({ profile, now }) {
    return {
      profile,
      connectionId: null,
      permittedLocations: [],
      catalogObservedAt: now,
    };
  },
  async quote() {
    return { currency: "", observedAt: 0, expiresAt: 0, lineItems: [] };
  },
  async preflight({ requestedSeats }) {
    return {
      ok: requestedSeats >= 0,
      availableSeats: requestedSeats,
      preferredLocation: null,
      reasons: [],
    };
  },
  advanceAllocation: unsupportedAgentOperation,
  observeAllocation: unsupportedAgentOperation,
  reboot: unsupportedAgentOperation,
  advanceDeletion: unsupportedAgentOperation,
  inspectConnection: unsupportedAgentOperation,
  rotateCredential: unsupportedAgentOperation,
  async sweep() {
    return [];
  },
  createResources: unsupportedAgentOperation,
  observeContext: unsupportedAgentOperation,
  rebootContext: unsupportedAgentOperation,
  deleteContext: unsupportedAgentOperation,
};

const productionRuntimeProviderRegistry = createRuntimeProviderRegistry([
  agentRuntimeProviderAdapter,
  directAdapter("hetzner_cloud"),
  directAdapter("gcp_compute"),
]);

export function requireProductionRuntimeProviderAdapter(
  kind: RuntimeProviderKind,
): RuntimeProviderAdapter {
  return requireRuntimeProviderAdapter(productionRuntimeProviderRegistry, kind);
}

function directProviderAdapter(
  kind: DirectCloudKind,
): ProductionRuntimeProviderAdapter {
  return requireRuntimeProviderAdapter(
    productionRuntimeProviderRegistry,
    kind,
  ) as ProductionRuntimeProviderAdapter;
}

async function allocationObservation(
  allocationId: string,
): Promise<ProviderAllocationObservation> {
  const allocation = await drizzle(env.DB)
    .select()
    .from(runtimeProviderAllocations)
    .where(eq(runtimeProviderAllocations.id, allocationId))
    .limit(1);
  const row = allocation[0];
  if (!row) {
    throw appError(
      404,
      "runtime_provider_allocation_not_found",
      "provider allocation not found",
    );
  }
  const resources = await drizzle(env.DB)
    .select()
    .from(runtimeProviderResources)
    .where(
      and(
        eq(runtimeProviderResources.allocationId, allocationId),
        eq(runtimeProviderResources.locationAttempt, row.locationAttempt),
      ),
    );
  return {
    allocationId,
    phase: row.state,
    location: row.location,
    externalIpv4: row.externalIpv4,
    resources: resources.map((resource) => ({
      kind: resource.resourceKind,
      providerResourceId: resource.providerResourceId,
      state: resource.providerState,
    })),
    operationId: null,
    retryableAt: null,
    errorCode: row.lastErrorCode,
  };
}

async function advanceProviderDeletion(context: ExecutionAllocationContext, now: number) {
  await directProviderAdapter(context.allocation.providerKind).deleteContext(
    context,
    now,
  );
}

async function observeProviderAllocation(context: ExecutionAllocationContext, now: number) {
  await directProviderAdapter(context.allocation.providerKind).observeContext(
    context,
    now,
  );
  await drizzle(env.DB)
    .update(runtimeProviderReconciliation)
    .set({ sweepAfter: now + 10_000, lastReconciledAt: now, updatedAt: now })
    .where(eq(runtimeProviderReconciliation.allocationId, context.allocation.id));
}

async function confirmProviderDeletion(context: ExecutionAllocationContext, now: number) {
  await observeProviderAllocation(context, now);
  const present = await drizzle(env.DB)
    .select({ id: runtimeProviderResources.id })
    .from(runtimeProviderResources)
    .where(
      and(
        eq(runtimeProviderResources.allocationId, context.allocation.id),
        eq(
          runtimeProviderResources.locationAttempt,
          context.allocation.locationAttempt,
        ),
        isNull(runtimeProviderResources.disappearanceConfirmedAt),
      ),
    )
    .limit(1);
  if (present.length > 0) return false;
  const current = await drizzle(env.DB)
    .select({
      locationAttempt: runtimeProviderAllocations.locationAttempt,
      fallbackPending: runtimeProviderAllocations.fallbackPending,
    })
    .from(runtimeProviderAllocations)
    .where(eq(runtimeProviderAllocations.id, context.allocation.id))
    .limit(1);
  if (
    !current[0] ||
    current[0].locationAttempt !== context.allocation.locationAttempt
  ) {
    return false;
  }
  if (current[0].fallbackPending) {
    await reconcileProviderCostLedger({
      allocationId: context.allocation.id,
      now,
    });
    await advanceProviderLocationFallback(context, now);
    return false;
  }
  const db = drizzle(env.DB);
  const deleted = await db
    .update(runtimeProviderAllocations)
    .set({ state: "deleted", deletionConfirmedAt: now, updatedAt: now })
    .where(
      and(
        eq(runtimeProviderAllocations.id, context.allocation.id),
        eq(
          runtimeProviderAllocations.locationAttempt,
          context.allocation.locationAttempt,
        ),
      ),
    );
  if (deleted.meta.changes !== 1) return false;
  await archiveRuntimeExecution({
    executionId: context.executionId,
    expectedGeneration: context.generation,
    endedAt: now,
  });
  await finalizeWorkshopCostAfterAllocationDeletion({
    allocationId: context.allocation.id,
    now,
  });
  return true;
}

async function scheduleProviderLocationFallback(
  context: ExecutionAllocationContext,
  errorCode: string,
  now: number,
): Promise<boolean> {
  if (
    !nextProviderLocationAttempt({
      locations: context.allocation.locationAttemptsJson,
      currentAttempt: context.allocation.locationAttempt,
    })
  ) {
    return false;
  }
  const bootstrap = await env.DB.prepare(
    `SELECT bootstrap_consumed_at, report_credential_revoked_at
     FROM runtime_guest_credentials
     WHERE execution_id = ? AND generation = ?`,
  )
    .bind(context.executionId, context.generation)
    .first<{
      bootstrap_consumed_at: number | null;
      report_credential_revoked_at: number | null;
    }>();
  if (
    !providerLocationFallbackBootstrapEligible({
      bootstrapConsumedAt: bootstrap?.bootstrap_consumed_at,
      reportCredentialRevokedAt: bootstrap?.report_credential_revoked_at,
    })
  ) {
    return false;
  }
  const active = await drizzle(env.DB)
    .select({ id: runtimeProviderResources.id })
    .from(runtimeProviderResources)
    .where(
      and(
        eq(runtimeProviderResources.allocationId, context.allocation.id),
        eq(
          runtimeProviderResources.locationAttempt,
          context.allocation.locationAttempt,
        ),
        isNull(runtimeProviderResources.disappearanceConfirmedAt),
      ),
    )
    .limit(1);
  const scheduled = await drizzle(env.DB)
    .update(runtimeProviderAllocations)
    .set({
      state: "cleanup_pending",
      fallbackPending: true,
      lastErrorCode: errorCode,
      deletionRequestedAt: active.length > 0 ? now : null,
      updatedAt: now,
    })
    .where(
      and(
        eq(runtimeProviderAllocations.id, context.allocation.id),
        eq(
          runtimeProviderAllocations.locationAttempt,
          context.allocation.locationAttempt,
        ),
        eq(runtimeProviderAllocations.fallbackPending, false),
      ),
    );
  if (scheduled.meta.changes !== 1) {
    const latest = await drizzle(env.DB)
      .select({
        fallbackPending: runtimeProviderAllocations.fallbackPending,
        locationAttempt: runtimeProviderAllocations.locationAttempt,
      })
      .from(runtimeProviderAllocations)
      .where(eq(runtimeProviderAllocations.id, context.allocation.id))
      .limit(1);
    return Boolean(
      latest[0] &&
        (latest[0].fallbackPending ||
          latest[0].locationAttempt > context.allocation.locationAttempt),
    );
  }
  try {
    // Rotate the still-unconsumed capability only after this attempt wins the
    // fallback fence. This invalidates cloud-init attached to a partial VM;
    // the next attempt rotates it once more when rendering its own cloud-init.
    await issueWorkspaceAgentBootstrap({
      executionId: context.executionId,
      generation: context.generation,
      checkpointBundleId: context.bundle.id,
      now,
      baseUrl: requiredWorkspaceAgentControlPlaneBaseUrl(),
    });
  } catch (error) {
    await drizzle(env.DB).batch([
      drizzle(env.DB)
        .update(runtimeProviderAllocations)
        .set({
          fallbackPending: false,
          state: "cleanup_pending",
          updatedAt: now,
        })
        .where(
          and(
            eq(runtimeProviderAllocations.id, context.allocation.id),
            eq(
              runtimeProviderAllocations.locationAttempt,
              context.allocation.locationAttempt,
            ),
            eq(runtimeProviderAllocations.fallbackPending, true),
          ),
        ),
      drizzle(env.DB)
        .update(runtimeProviderReconciliation)
        .set({
          desiredState: "deleted",
          observedState: "location_fallback_bootstrap_fenced",
          sweepAfter: now,
          updatedAt: now,
        })
        .where(
          eq(runtimeProviderReconciliation.allocationId, context.allocation.id),
        ),
    ]);
    if (
      error instanceof AppError &&
      error.code === "workspace_agent_bootstrap_already_consumed"
    ) {
      return false;
    }
    throw error;
  }
  await drizzle(env.DB)
    .update(runtimeProviderReconciliation)
    .set({
      desiredState: "deleted",
      observedState:
        active.length > 0
          ? "location_fallback_cleanup"
          : "location_fallback_ready",
      sweepAfter: now,
      updatedAt: now,
    })
    .where(eq(runtimeProviderReconciliation.allocationId, context.allocation.id));
  if (context.domainKind === "workshop_certification") {
    await env.DB.prepare(
      `UPDATE workshop_runtime_profile_certifications
       SET evidence_json = json_set(
             evidence_json,
             '$.phase', 'location_fallback',
             '$.fallbackErrorCode', ?,
             '$.locationAttempt', ?
           ),
           error_code = NULL, updated_at = ?
       WHERE id = ? AND state = 'verifying'`,
    )
      .bind(
        errorCode,
        context.allocation.locationAttempt,
        now,
        context.workspaceId,
      )
      .run();
  }
  if (active.length === 0) {
    await advanceProviderLocationFallback(context, now);
  }
  return true;
}

export function providerLocationFallbackBootstrapEligible(
  input: {
    bootstrapConsumedAt: number | null | undefined;
    reportCredentialRevokedAt: number | null | undefined;
  },
): boolean {
  return (
    input.bootstrapConsumedAt === null &&
    input.reportCredentialRevokedAt === null
  );
}

async function advanceProviderLocationFallback(
  context: ExecutionAllocationContext,
  now: number,
): Promise<boolean> {
  const current = await drizzle(env.DB)
    .select()
    .from(runtimeProviderAllocations)
    .where(eq(runtimeProviderAllocations.id, context.allocation.id))
    .limit(1);
  const allocation = current[0];
  if (!allocation?.fallbackPending) return false;
  const next = nextProviderLocationAttempt({
    locations: allocation.locationAttemptsJson,
    currentAttempt: allocation.locationAttempt,
  });
  if (!next) return false;
  const update = await env.DB.prepare(
    `UPDATE runtime_provider_allocations
     SET location = ?, location_attempt = ?, location_attempt_started_at = ?,
         fallback_pending = 0, state = 'creating', external_ipv4 = NULL,
         last_report_sequence = 0, last_report_at = NULL,
         deletion_requested_at = NULL, deletion_confirmed_at = NULL,
         last_error_code = NULL, retry_count = retry_count + 1,
         updated_at = ?
     WHERE id = ? AND location_attempt = ? AND fallback_pending = 1
       AND NOT EXISTS (
         SELECT 1 FROM runtime_provider_resources resource
         WHERE resource.allocation_id = runtime_provider_allocations.id
           AND resource.location_attempt = runtime_provider_allocations.location_attempt
           AND resource.disappearance_confirmed_at IS NULL
       )`,
  )
    .bind(
      next.location,
      next.attempt,
      now,
      now,
      allocation.id,
      allocation.locationAttempt,
    )
    .run();
  if (update.meta.changes !== 1) return false;
  await drizzle(env.DB)
    .update(runtimeProviderReconciliation)
    .set({
      desiredState: "ready",
      observedState: "creating",
      sweepAfter: now,
      lastReconciledAt: now,
      updatedAt: now,
    })
    .where(eq(runtimeProviderReconciliation.allocationId, allocation.id));
  await updateRuntimeExecutionState({
    executionId: context.executionId,
    expectedGeneration: context.generation,
    state: "provisioning",
    observedAt: now,
  });
  if (context.domainKind === "workshop_certification") {
    await env.DB.prepare(
      `UPDATE workshop_runtime_profile_certifications
       SET evidence_json = json_set(
             evidence_json,
             '$.phase', 'allocating',
             '$.location', ?,
             '$.locationAttempt', ?
           ),
           error_code = NULL, updated_at = ?
       WHERE id = ? AND state = 'verifying'`,
    )
      .bind(next.location, next.attempt, now, context.workspaceId)
      .run();
  }
  return true;
}

interface CreationInput {
  allocationId: string;
  execution: Pick<
    RuntimeExecutionHandle,
    "executionId" | "generation" | "organizationId" | "domainId"
  >;
  context: AllocationContext;
  deterministicName: string;
  location: string;
  locationAttempt: number;
  sshPublicKey: string;
  cloudInit: string;
  certification?: { publicationId: string; checkpointId: string };
  now: number;
}

async function prepareProviderCreationInput(input: {
  allocationId: string;
  execution: Pick<
    RuntimeExecutionHandle,
    "executionId" | "generation" | "organizationId" | "domainId"
  >;
  context: AllocationContext;
  deterministicName: string;
  location: string;
  locationAttempt: number;
  kinoProbes: Array<{ moduleId: string; probeId: string }>;
  reportExpiresAt?: number;
  certification?: { publicationId: string; checkpointId: string };
  now: number;
}): Promise<CreationInput> {
  const accessKeys = await ensureRuntimeVmAccessKeys({
    executionId: input.execution.executionId,
    expectedGeneration: input.execution.generation,
    now: input.now,
  });
  const learnerKey = accessKeys.find(
    (key) => key.vmId === input.context.profile.vmId,
  );
  if (!learnerKey) {
    throw appError(
      500,
      "runtime_vm_access_key_missing",
      "runtime access key is missing",
    );
  }
  const controlPlaneBaseUrl = requiredWorkspaceAgentControlPlaneBaseUrl();
  const guestTools = await resolveWorkspaceGuestTools(controlPlaneBaseUrl, {
    workspaceAgentSha256: input.context.bundle.workspaceAgentSha256,
    kinoSha256: input.context.bundle.kinoSha256,
  });
  const bootstrap = await issueWorkspaceAgentBootstrap({
    executionId: input.execution.executionId,
    generation: input.execution.generation,
    checkpointBundleId: input.context.bundle.id,
    ...(input.reportExpiresAt === undefined
      ? {}
      : { reportExpiresAt: input.reportExpiresAt }),
    now: input.now,
    baseUrl: controlPlaneBaseUrl,
  });
  return {
    allocationId: input.allocationId,
    execution: input.execution,
    context: input.context,
    deterministicName: input.deterministicName,
    location: input.location,
    locationAttempt: input.locationAttempt,
    sshPublicKey: learnerKey.publicKeyOpenssh,
    cloudInit: buildWorkspaceAgentCloudInit({
      identity: bootstrap.identity,
      endpoint: bootstrap.endpoint,
      bootstrapCapability: bootstrap.capability,
      sshPublicKey: learnerKey.publicKeyOpenssh,
      agentBinaryUrl: guestTools.agent.url,
      agentBinarySha256: guestTools.agent.sha256,
      kinoBinaryUrl: guestTools.kino.url,
      kinoBinarySha256: guestTools.kino.sha256,
      kinoProbes: input.kinoProbes,
    }),
    ...(input.certification ? { certification: input.certification } : {}),
    now: input.now,
  };
}

async function handleLearnerAllocationFailure(input: {
  generationId: string;
  execution: Pick<RuntimeExecutionHandle, "executionId" | "generation">;
  allocationId: string;
  locationAttempt: number;
  providerAttempted: boolean;
  error: unknown;
  errorCode: string;
  now: number;
}): Promise<boolean> {
  const db = drizzle(env.DB);
  if (!input.providerAttempted) {
    await Promise.allSettled([
      revokeWorkspaceAgentGeneration({
        executionId: input.execution.executionId,
        generation: input.execution.generation,
        now: input.now,
      }),
    ]);
    await db.batch([
      db
        .update(runtimeProviderAllocations)
        .set({
          state: "deleted",
          deletionRequestedAt: input.now,
          deletionConfirmedAt: input.now,
          lastErrorCode: input.errorCode,
          updatedAt: input.now,
        })
        .where(eq(runtimeProviderAllocations.id, input.allocationId)),
      db
        .update(runtimeProviderReconciliation)
        .set({
          desiredState: "deleted",
          observedState: "deleted",
          sweepAfter: input.now,
          lastReconciledAt: input.now,
          updatedAt: input.now,
        })
        .where(
          eq(runtimeProviderReconciliation.allocationId, input.allocationId),
        ),
    ]);
    await archiveRuntimeExecution({
      executionId: input.execution.executionId,
      expectedGeneration: input.execution.generation,
      endedAt: input.now,
    });
    await Promise.allSettled([
      recordWorkshopGenerationState({
        generationId: input.generationId,
        update: {
          state: "failed",
          runtimeExecutionId: input.execution.executionId,
          hostId: null,
          error: `provider preparation failed (${input.errorCode}); no cloud resource was created`,
          observedAt: input.now,
        },
      }),
    ]);
    return false;
  }

  const failure = classifyProviderAllocationFailure(input.error, input.now);
  const context = await loadExecutionAllocation(input.execution.executionId);
  if (
    !context ||
    context.allocation.locationAttempt !== input.locationAttempt
  ) {
    return true;
  }
  if (failure.disposition === "fallback_location") {
    if (
      (await scheduleProviderLocationFallback(
        context,
        input.errorCode,
        input.now,
      ))
    ) {
      return true;
    }
  }
  if (failure.disposition === "reconcile_same_allocation") {
    const reconciled = await db.batch([
      db
        .update(runtimeProviderAllocations)
        .set({
          state: "creating",
          lastErrorCode: input.errorCode,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(runtimeProviderAllocations.id, input.allocationId),
            eq(
              runtimeProviderAllocations.locationAttempt,
              input.locationAttempt,
            ),
          ),
        ),
      db
        .update(runtimeProviderReconciliation)
        .set({
          desiredState: "ready",
          observedState: "ambiguous",
          sweepAfter: failure.retryAt ?? input.now + 10_000,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(
              runtimeProviderReconciliation.allocationId,
              input.allocationId,
            ),
            sql`EXISTS (
              SELECT 1 FROM runtime_provider_allocations allocation
              WHERE allocation.id = ${input.allocationId}
                AND allocation.location_attempt = ${input.locationAttempt}
            )`,
          ),
      ),
    ]);
    if (reconciled[0]?.meta.changes !== 1) return true;
    await Promise.allSettled([
      recordWorkshopGenerationState({
        generationId: input.generationId,
        update: {
          state: "provisioning",
          runtimeExecutionId: input.execution.executionId,
          hostId: null,
          error: `provider response was ambiguous (${input.errorCode}); reconciling the same allocation`,
          observedAt: input.now,
        },
      }),
    ]);
    return false;
  }

  await transitionCurrentProviderAttemptToCleanup({
    context,
    expectedLocationAttempt: input.locationAttempt,
    errorCode: input.errorCode,
    observedState: "failed",
    message: `provider allocation failed (${input.errorCode}); owner action or manual retry is required`,
    now: input.now,
  });
  return false;
}

async function handleCertificationAllocationFailure(input: {
  certificationId: string;
  publicationId: string;
  executionId: string;
  allocationId: string;
  locationAttempt: number;
  providerAttempted: boolean;
  error: unknown;
  errorCode: string;
  evidence: Record<string, unknown>;
  now: number;
}): Promise<boolean> {
  const db = drizzle(env.DB);
  if (!input.providerAttempted) {
    await Promise.allSettled([
      revokeWorkspaceAgentGeneration({
        executionId: input.executionId,
        generation: 1,
        now: input.now,
      }),
    ]);
    await db.batch([
      db
        .update(runtimeProviderAllocations)
        .set({
          state: "deleted",
          deletionRequestedAt: input.now,
          deletionConfirmedAt: input.now,
          lastErrorCode: input.errorCode,
          updatedAt: input.now,
        })
        .where(eq(runtimeProviderAllocations.id, input.allocationId)),
      db
        .update(runtimeProviderReconciliation)
        .set({
          desiredState: "deleted",
          observedState: "deleted",
          sweepAfter: input.now,
          lastReconciledAt: input.now,
          updatedAt: input.now,
        })
        .where(
          eq(runtimeProviderReconciliation.allocationId, input.allocationId),
        ),
      db
        .update(workshopRuntimeProfileCertifications)
        .set({
          state: "failed",
          deletionConfirmedAt: input.now,
          errorCode: input.errorCode,
          evidenceJson: {
            ...input.evidence,
            phase: "failed_before_provider_mutation",
          },
          updatedAt: input.now,
        })
        .where(
          eq(workshopRuntimeProfileCertifications.id, input.certificationId),
        ),
    ]);
    await archiveRuntimeExecution({
      executionId: input.executionId,
      expectedGeneration: 1,
      endedAt: input.now,
    });
    await markWorkshopPublicationCertificationFailed(
      input.publicationId,
      input.now,
    );
    return false;
  }

  const failure = classifyProviderAllocationFailure(input.error, input.now);
  const context = await loadExecutionAllocation(input.executionId);
  if (
    !context ||
    context.allocation.locationAttempt !== input.locationAttempt
  ) {
    return true;
  }
  if (failure.disposition === "fallback_location") {
    if (
      (await scheduleProviderLocationFallback(
        context,
        input.errorCode,
        input.now,
      ))
    ) {
      return true;
    }
  }
  if (failure.disposition === "reconcile_same_allocation") {
    const reconciled = await db.batch([
      db
        .update(runtimeProviderAllocations)
        .set({
          state: "creating",
          lastErrorCode: input.errorCode,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(runtimeProviderAllocations.id, input.allocationId),
            eq(
              runtimeProviderAllocations.locationAttempt,
              input.locationAttempt,
            ),
          ),
        ),
      db
        .update(runtimeProviderReconciliation)
        .set({
          desiredState: "ready",
          observedState: "ambiguous",
          sweepAfter: failure.retryAt ?? input.now + 10_000,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(
              runtimeProviderReconciliation.allocationId,
              input.allocationId,
            ),
            sql`EXISTS (
              SELECT 1 FROM runtime_provider_allocations allocation
              WHERE allocation.id = ${input.allocationId}
                AND allocation.location_attempt = ${input.locationAttempt}
            )`,
          ),
        ),
      db
        .update(workshopRuntimeProfileCertifications)
        .set({
          evidenceJson: {
            ...input.evidence,
            phase: "allocating",
            retryableErrorCode: input.errorCode,
          },
          updatedAt: input.now,
        })
        .where(
          and(
            eq(
              workshopRuntimeProfileCertifications.id,
              input.certificationId,
            ),
            eq(
              workshopRuntimeProfileCertifications.verifierAllocationId,
              input.allocationId,
            ),
            sql`EXISTS (
              SELECT 1 FROM runtime_provider_allocations allocation
              WHERE allocation.id = ${input.allocationId}
                AND allocation.location_attempt = ${input.locationAttempt}
            )`,
          ),
        ),
    ]);
    if (reconciled[0]?.meta.changes !== 1) return true;
    return false;
  }

  await transitionCurrentProviderAttemptToCleanup({
    context,
    expectedLocationAttempt: input.locationAttempt,
    errorCode: input.errorCode,
    observedState: "failed",
    message: `runtime profile certification allocation failed (${input.errorCode})`,
    now: input.now,
  });
  return false;
}

async function markWorkshopPublicationCertificationFailed(
  publicationId: string,
  now: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE workshop_publications
     SET status = 'failed', certification_state = 'failed',
         finished_at = COALESCE(finished_at, ?), updated_at = ?
     WHERE id = ? AND status = 'building'`,
  )
    .bind(now, now, publicationId)
    .run();
}

async function providerMutation(
  input: CreationInput,
  operationKind: string,
  operation: Record<string, unknown>,
): Promise<CanonicalProviderWrite[]> {
  if (
    !(await providerLocationAttemptIsCurrent(
      input.allocationId,
      input.locationAttempt,
    ))
  ) {
    throw appError(
      409,
      "provider_location_attempt_stale",
      "provider operation belongs to an obsolete location attempt",
    );
  }
  const db = drizzle(env.DB);
  const repeatable = operationKind === "observe_allocation" || operationKind === "reconcile";
  const previous = await env.DB.prepare(
    `SELECT id, request_id, state, attempt, provider_operation_id
     FROM runtime_provider_operations
     WHERE allocation_id = ? AND location_attempt = ? AND operation_kind = ?
     ORDER BY created_at DESC, attempt DESC
     LIMIT 1`,
  )
    .bind(input.allocationId, input.locationAttempt, operationKind)
    .first<{
      id: string;
      request_id: string;
      state: "pending" | "running" | "succeeded" | "retryable" | "failed";
      attempt: number;
      provider_operation_id: string | null;
    }>();
  if (
    shouldDiscoverHetznerCreateBeforeRetry({
      providerKind: input.context.providerKind,
      operationKind,
      previous,
    })
  ) {
    const adopted = await reconcileExpectedHetznerResource({
      input,
      operationKind,
      deterministicName: requiredOperationName(operation),
      now: input.now,
    });
    if (adopted.status === "present") {
      await persistCanonicalWrites(input, adopted.writes);
      await db
        .update(runtimeProviderOperations)
        .set({
          state: "succeeded",
          retryAt: null,
          completedAt: input.now,
          errorClass: null,
          errorCode: null,
          sanitizedResultJson: { reconciledAfterAmbiguousCreate: true },
          updatedAt: input.now,
        })
        .where(
          and(
            eq(runtimeProviderOperations.id, previous!.id),
            eq(
              runtimeProviderOperations.locationAttempt,
              input.locationAttempt,
            ),
          ),
        );
      return adopted.writes;
    }
  }
  if (!repeatable && previous?.state === "succeeded") {
    const writes = await successfulOperationWrites(
      input,
      operationKind,
      previous.request_id,
    );
    if (writes.length > 0 || !isProviderCreateOperation(operationKind)) {
      return writes;
    }
  }
  if (
    !repeatable &&
    previous &&
    (previous.state === "pending" ||
      previous.state === "running" ||
      previous.state === "retryable") &&
    previous.provider_operation_id !== null
  ) {
    return successfulOperationWrites(input, operationKind, previous.request_id);
  }
  const retrying =
    previous &&
    (previous.state === "pending" ||
      previous.state === "running" ||
      previous.state === "retryable");
  const logicalOrdinal = nextProviderOperationLogicalOrdinal(previous);
  const operationId = retrying ? previous.id : createAppId();
  const requestId = retrying
    ? previous.request_id
    : await deterministicProviderRequestId(
        input.allocationId,
        input.locationAttempt,
        operationKind,
        logicalOrdinal,
      );
  const attempt = retrying ? previous.attempt + 1 : logicalOrdinal;
  if (retrying) {
    await db
      .update(runtimeProviderOperations)
      .set({ state: "running", attempt, retryAt: null, updatedAt: input.now })
      .where(
        and(
          eq(runtimeProviderOperations.id, operationId),
          eq(runtimeProviderOperations.locationAttempt, input.locationAttempt),
        ),
      );
  } else {
    await db.insert(runtimeProviderOperations).values({
      id: operationId,
      allocationId: input.allocationId,
      providerKind: input.context.providerKind,
      operationKind,
      locationAttempt: input.locationAttempt,
      requestId,
      state: "running",
      attempt,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }
  const request = {
    requestId,
    connectionId: input.context.connection.id,
    credentialContext: providerCredentialContext({
      organizationId: input.execution.organizationId!,
      connection: input.context.connection,
      credential: input.context.credential,
    }),
    credential: providerCredentialEnvelope(input.context.credential),
    ...(input.context.providerKind === "gcp_compute"
      ? { projectId: input.context.connection.externalProjectId }
      : {}),
    operation,
  };
  try {
    const result = await invokeProviderOperation(
      input.context.providerKind,
      (binding) => binding.runOperation(request),
    );
    await persistCanonicalWrites(input, result.canonicalWrites);
    const providerOperations = normalizeProviderOperationWrites(result.canonicalWrites);
    if (repeatable) {
      await persistObservedProviderOperations({
        allocationId: input.allocationId,
        locationAttempt: input.locationAttempt,
        operations: providerOperations,
        resultData: result.data,
        now: input.now,
      });
    } else {
      await persistAdditionalProviderOperations({
        input,
        originOperationId: operationId,
        operationKind,
        operations: providerOperations.slice(1),
      });
    }
    const providerOperationState = summarizeProviderOperations(
      providerOperations,
      result.data,
    );
    await db
      .update(runtimeProviderOperations)
      .set({
        providerOperationId: repeatable ? null : providerOperations[0]?.id ?? null,
        state: providerOperationState.state,
        retryAt:
          providerOperationState.state === "running" ? input.now + 10_000 : null,
        completedAt:
          providerOperationState.state === "running" ? null : input.now,
        errorClass:
          providerOperationState.state === "failed" ? "definitive" : null,
        errorCode:
          providerOperationState.state === "failed"
            ? providerOperationState.errorCode ?? "provider_async_operation_failed"
            : null,
        sanitizedResultJson: {
          canonicalWriteCount: result.canonicalWrites.length,
          providerOperationCount: providerOperations.length,
        },
        updatedAt: input.now,
      })
      .where(
        and(
          eq(runtimeProviderOperations.id, operationId),
          eq(runtimeProviderOperations.locationAttempt, input.locationAttempt),
        ),
      );
    if (providerOperationState.state === "failed") {
      await markAllocationProviderOperationFailed(
        input.allocationId,
        input.locationAttempt,
        providerOperationState.errorCode ?? "provider_async_operation_failed",
        input.now,
      );
      throw appError(
        409,
        providerOperationState.errorCode ?? "provider_async_operation_failed",
        "provider asynchronous operation failed",
      );
    }
    return result.canonicalWrites;
  } catch (error) {
    const failure = classifyProviderOperationFailure(error, input.now);
    await db
      .update(runtimeProviderOperations)
      .set({
        state: failure.state,
        retryAt: failure.retryAt,
        completedAt: failure.state === "failed" ? input.now : null,
        errorClass: failure.errorClass,
        errorCode: error instanceof AppError ? error.code : "provider_operation_failed",
        updatedAt: input.now,
      })
      .where(
        and(
          eq(runtimeProviderOperations.id, operationId),
          eq(runtimeProviderOperations.locationAttempt, input.locationAttempt),
        ),
      );
    throw error;
  }
}

export function nextProviderOperationLogicalOrdinal(
  previous:
    | { state: "pending" | "running" | "succeeded" | "retryable" | "failed"; attempt: number }
    | null,
): number {
  return previous &&
    (previous.state === "succeeded" || previous.state === "failed")
    ? previous.attempt + 1
    : 1;
}

interface NormalizedProviderOperationWrite {
  id: string;
  state: string;
  errorCode: string | null;
}

function normalizeProviderOperationWrites(
  writes: readonly CanonicalProviderWrite[],
): NormalizedProviderOperationWrite[] {
  const byId = new Map<string, NormalizedProviderOperationWrite>();
  for (const canonical of writes) {
    const write = canonical as unknown as {
      operation: string;
      externalId: string | number;
      state?: string;
      errorCode?: string;
    };
    if (
      write.operation !== "operation_observed" &&
      write.operation !== "action_observed"
    ) {
      continue;
    }
    const id = String(write.externalId);
    if (!id) continue;
    byId.set(id, {
      id,
      state: write.state ?? "running",
      errorCode: write.errorCode ?? null,
    });
  }
  return [...byId.values()];
}

function summarizeProviderOperations(
  operations: readonly NormalizedProviderOperationWrite[],
  resultData: unknown,
): {
  state: "running" | "succeeded" | "failed";
  errorCode?: string;
} {
  if (operations.length === 0) return { state: "succeeded" };
  if (providerResultHasError(resultData)) {
    return {
      state: "failed",
      ...(operations.find((operation) => operation.errorCode)?.errorCode
        ? {
            errorCode: operations.find((operation) => operation.errorCode)!
              .errorCode!,
          }
        : {}),
    };
  }
  const states = operations.map((operation) => operation.state.toLowerCase());
  if (
    states.some((state) =>
      ["error", "failed", "cancelled", "canceled"].includes(state),
    )
  ) {
    return {
      state: "failed",
      ...(operations.find((operation) => operation.errorCode)?.errorCode
        ? {
            errorCode: operations.find((operation) => operation.errorCode)!
              .errorCode!,
          }
        : {}),
    };
  }
  return states.every((state) => state === "success" || state === "done")
    ? { state: "succeeded" }
    : { state: "running" };
}

function providerResultHasError(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (typeof record.httpErrorStatusCode === "number" &&
      record.httpErrorStatusCode >= 400) ||
    (record.error !== null && record.error !== undefined)
  );
}

async function persistAdditionalProviderOperations(input: {
  input: CreationInput;
  originOperationId: string;
  operationKind: string;
  operations: readonly NormalizedProviderOperationWrite[];
}): Promise<void> {
  for (const [index, operation] of input.operations.entries()) {
    const summary = summarizeProviderOperations([operation], null);
    const state = summary.state;
    const requestId = await deterministicProviderRequestId(
      input.input.allocationId,
      input.input.locationAttempt,
      `${input.operationKind}:provider-operation:${operation.id}`,
      index + 1,
    );
    await env.DB.prepare(
      `INSERT INTO runtime_provider_operations (
         id, allocation_id, provider_kind, operation_kind, location_attempt,
         provider_operation_id, request_id, state, attempt, retry_at,
         completed_at, error_class, error_code, sanitized_result_json,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(allocation_id, location_attempt, provider_operation_id) DO UPDATE SET
         state = excluded.state,
         retry_at = excluded.retry_at,
         completed_at = excluded.completed_at,
         error_class = excluded.error_class,
         error_code = excluded.error_code,
         sanitized_result_json = excluded.sanitized_result_json,
         updated_at = excluded.updated_at`,
    )
      .bind(
        createAppId(),
        input.input.allocationId,
        input.input.context.providerKind,
        `${input.operationKind}:provider-operation`,
        input.input.locationAttempt,
        operation.id,
        requestId,
        state,
        state === "running" ? input.input.now + 10_000 : null,
        state === "running" ? null : input.input.now,
        state === "failed" ? "definitive" : null,
        state === "failed"
          ? summary.errorCode ?? "provider_async_operation_failed"
          : null,
        JSON.stringify({
          parentOperationId: input.originOperationId,
          providerState: operation.state,
        }),
        input.input.now,
        input.input.now,
      )
      .run();
  }
}

async function markAllocationProviderOperationFailed(
  allocationId: string,
  locationAttempt: number,
  errorCode: string,
  now: number,
): Promise<void> {
  const identity = await drizzle(env.DB)
      .select({
        executionId: runtimeProviderAllocations.executionId,
        locationAttempt: runtimeProviderAllocations.locationAttempt,
      })
      .from(runtimeProviderAllocations)
      .where(eq(runtimeProviderAllocations.id, allocationId))
      .limit(1);
  if (identity[0]?.locationAttempt !== locationAttempt) return;
  const context = await loadProviderFailureProjectionContext(allocationId);
  if (!context || context.allocation.locationAttempt !== locationAttempt) return;
  if (isDefinitiveLocationCapacityFailure({ code: errorCode })) {
    const allocationContext = await loadExecutionAllocation(
      identity[0].executionId,
    );
    if (
      allocationContext?.allocation.locationAttempt === locationAttempt &&
      (await scheduleProviderLocationFallback(
        allocationContext,
        errorCode,
        now,
      ))
    ) {
      return;
    }
  }
  await transitionCurrentProviderAttemptToCleanup({
    context,
    expectedLocationAttempt: locationAttempt,
    errorCode,
    observedState: "provider_operation_failed",
    message: `provider asynchronous operation failed (${errorCode}); cleanup is pending`,
    now,
  });
}

async function transitionCurrentProviderAttemptToCleanup(input: {
  context: ProviderFailureProjectionContext;
  expectedLocationAttempt: number;
  errorCode: string;
  observedState: string;
  message: string;
  now: number;
}): Promise<boolean> {
  const transitioned = await env.DB.batch([
    env.DB.prepare(
      `UPDATE runtime_provider_allocations
       SET state = 'cleanup_pending', fallback_pending = 0,
           last_error_code = ?,
           deletion_requested_at = COALESCE(deletion_requested_at, ?),
           updated_at = ?
       WHERE id = ? AND location_attempt = ? AND state != 'deleted'`,
    ).bind(
      input.errorCode,
      input.now,
      input.now,
      input.context.allocation.id,
      input.expectedLocationAttempt,
    ),
    env.DB.prepare(
      `UPDATE runtime_provider_reconciliation
       SET desired_state = 'deleted', observed_state = ?, sweep_after = ?,
           updated_at = ?
       WHERE allocation_id = ?
         AND EXISTS (
           SELECT 1 FROM runtime_provider_allocations allocation
           WHERE allocation.id = runtime_provider_reconciliation.allocation_id
             AND allocation.location_attempt = ?
             AND allocation.state = 'cleanup_pending'
         )`,
    ).bind(
      input.observedState,
      input.now,
      input.now,
      input.context.allocation.id,
      input.expectedLocationAttempt,
    ),
    env.DB.prepare(
      `UPDATE runtime_executions
       SET state = 'failed', ended_at = COALESCE(ended_at, ?), updated_at = ?
       WHERE id = ? AND generation = ? AND state NOT IN ('archived', 'failed')
         AND EXISTS (
           SELECT 1 FROM runtime_provider_allocations allocation
           WHERE allocation.execution_id = runtime_executions.id
             AND allocation.id = ? AND allocation.location_attempt = ?
             AND allocation.state = 'cleanup_pending'
         )
         AND NOT EXISTS (
           SELECT 1 FROM runtime_executions newer
           WHERE newer.domain_kind = runtime_executions.domain_kind
             AND newer.domain_id = runtime_executions.domain_id
             AND newer.generation > runtime_executions.generation
         )`,
    ).bind(
      input.now,
      input.now,
      input.context.executionId,
      input.context.generation,
      input.context.allocation.id,
      input.expectedLocationAttempt,
    ),
  ]);
  if (transitioned[0]?.meta.changes !== 1) return false;

  // The attempt transition above is the fence: after it succeeds no fallback
  // can advance this allocation. Revocation is therefore safe for this logical
  // generation and is retried by cleanup sweeps if a Worker exits early.
  await revokeWorkspaceAgentGeneration({
    executionId: input.context.executionId,
    generation: input.context.generation,
    now: input.now,
  });
  if (input.context.domainKind === "workshop_certification") {
    await env.DB.prepare(
      `UPDATE workshop_runtime_profile_certifications
       SET state = 'cleanup_pending', error_code = ?,
           evidence_json = json_set(
             evidence_json,
             '$.phase', 'cleanup_pending',
             '$.cleanupRequestedAt', ?,
             '$.failureLocationAttempt', ?
           ),
           updated_at = ?
       WHERE id = ? AND verifier_allocation_id = ?
         AND state IN ('verifying', 'cleanup_pending')`,
    )
      .bind(
        input.errorCode,
        input.now,
        input.expectedLocationAttempt,
        input.now,
        input.context.workspaceId,
        input.context.allocation.id,
      )
      .run();
  } else {
    await markCurrentWorkshopGenerationFailed(
      input.context,
      input.message,
      input.now,
    );
  }
  return true;
}

async function providerLocationAttemptIsCurrent(
  allocationId: string,
  locationAttempt: number,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS current
     FROM runtime_provider_allocations
     WHERE id = ? AND location_attempt = ?`,
  )
    .bind(allocationId, locationAttempt)
    .first<{ current: number }>();
  return row?.current === 1;
}

async function persistObservedProviderOperations(input: {
  allocationId: string;
  locationAttempt: number;
  operations: readonly NormalizedProviderOperationWrite[];
  resultData: unknown;
  now: number;
}): Promise<void> {
  for (const operation of input.operations) {
    const summary = summarizeProviderOperations([operation], input.resultData);
    await recordProviderOperationObservation({
      allocationId: input.allocationId,
      locationAttempt: input.locationAttempt,
      providerOperationId: operation.id,
      providerState: operation.state,
      state: summary.state,
      errorCode: summary.errorCode ?? null,
      now: input.now,
    });
  }
}

export async function recordProviderOperationObservation(input: {
  allocationId: string;
  locationAttempt: number;
  providerOperationId: string;
  providerState: string;
  state: "running" | "succeeded" | "failed";
  errorCode?: string | null;
  now: number;
}): Promise<void> {
    const updated = await env.DB.prepare(
      `UPDATE runtime_provider_operations
       SET state = ?, retry_at = ?, last_polled_at = ?, completed_at = ?,
           error_class = ?, error_code = ?,
           sanitized_result_json = json_object('providerState', ?),
           updated_at = ?
       WHERE allocation_id = ? AND location_attempt = ? AND provider_operation_id = ?
         AND state IN ('pending','running','retryable')`,
      )
      .bind(
        input.state,
        input.state === "running" ? input.now + 10_000 : null,
        input.now,
        input.state === "running" ? null : input.now,
        input.state === "failed" ? "definitive" : null,
        input.state === "failed"
          ? input.errorCode ?? "provider_async_operation_failed"
          : null,
        input.providerState,
        input.now,
        input.allocationId,
        input.locationAttempt,
        input.providerOperationId,
      )
      .run();
    if (input.state === "failed" && updated.meta.changes === 1) {
      await markAllocationProviderOperationFailed(
        input.allocationId,
        input.locationAttempt,
        input.errorCode ?? "provider_async_operation_failed",
        input.now,
      );
    }
}

async function loadActiveProviderResource(
  allocationId: string,
  resourceKind: "instance" | "boot_disk" | "ipv4" | "ssh_key",
  locationAttempt: number,
): Promise<typeof runtimeProviderResources.$inferSelect | null> {
  const rows = await drizzle(env.DB)
    .select()
    .from(runtimeProviderResources)
    .where(
      and(
        eq(runtimeProviderResources.allocationId, allocationId),
        eq(runtimeProviderResources.locationAttempt, locationAttempt),
        eq(runtimeProviderResources.resourceKind, resourceKind),
        isNull(runtimeProviderResources.disappearanceConfirmedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function pendingProviderOperations(
  allocationId: string,
  providerKind: DirectCloudKind,
  locationAttempt: number,
  now: number,
): Promise<Array<typeof runtimeProviderOperations.$inferSelect>> {
  return drizzle(env.DB)
    .select()
    .from(runtimeProviderOperations)
    .where(
      and(
        eq(runtimeProviderOperations.allocationId, allocationId),
        eq(runtimeProviderOperations.providerKind, providerKind),
        eq(runtimeProviderOperations.locationAttempt, locationAttempt),
        inArray(runtimeProviderOperations.state, ["pending", "running", "retryable"]),
        or(
          isNull(runtimeProviderOperations.retryAt),
          lte(runtimeProviderOperations.retryAt, now),
        ),
      ),
    );
}

async function pendingHetznerActionIds(
  allocationId: string,
  locationAttempt: number,
  now: number,
): Promise<number[]> {
  const operations = await pendingProviderOperations(
    allocationId,
    "hetzner_cloud",
    locationAttempt,
    now,
  );
  return operations.flatMap((operation) => {
    if (!operation.providerOperationId) return [];
    const id = Number(operation.providerOperationId);
    return Number.isSafeInteger(id) && id > 0 ? [id] : [];
  });
}

async function pollPendingGcpOperations(
  input: CreationInput,
  now: number,
): Promise<void> {
  const operations = await pendingProviderOperations(
    input.allocationId,
    "gcp_compute",
    input.locationAttempt,
    now,
  );
  for (const operation of operations) {
    if (!operation.providerOperationId) continue;
    const request = {
      requestId: await deterministicProviderRequestId(
        input.allocationId,
        input.locationAttempt,
        `poll:${operation.providerOperationId}`,
        operation.attempt + 1,
      ),
      connectionId: input.context.connection.id,
      credentialContext: providerCredentialContext({
        organizationId: input.execution.organizationId!,
        connection: input.context.connection,
        credential: input.context.credential,
      }),
      credential: providerCredentialEnvelope(input.context.credential),
      projectId: input.context.connection.externalProjectId,
      operation: {
        kind: "observe_operation",
        operationSelfLink: operation.providerOperationId,
      },
    };
    try {
      const result = await invokeProviderOperation(
        "gcp_compute",
        (binding) => binding.runOperation(request),
      );
      await persistCanonicalWrites(input, result.canonicalWrites);
      await persistObservedProviderOperations({
        allocationId: input.allocationId,
        locationAttempt: input.locationAttempt,
        operations: normalizeProviderOperationWrites(result.canonicalWrites),
        resultData: result.data,
        now,
      });
    } catch (error) {
      const failure = classifyProviderOperationFailure(error, now);
      const updated = await drizzle(env.DB)
        .update(runtimeProviderOperations)
        .set({
          state: failure.state,
          retryAt: failure.retryAt,
          lastPolledAt: now,
          completedAt: failure.state === "failed" ? now : null,
          errorClass: failure.errorClass,
          errorCode:
            error instanceof AppError ? error.code : "provider_operation_poll_failed",
          updatedAt: now,
        })
        .where(
          and(
            eq(runtimeProviderOperations.id, operation.id),
            eq(
              runtimeProviderOperations.locationAttempt,
              input.locationAttempt,
            ),
          ),
        );
      if (failure.state === "failed" && updated.meta.changes === 1) {
        await markAllocationProviderOperationFailed(
          input.allocationId,
          input.locationAttempt,
          error instanceof AppError
            ? error.code
            : "provider_operation_poll_failed",
          now,
        );
      }
    }
  }
}

function isHetznerCreateOperation(operationKind: string): boolean {
  return (
    operationKind === "create_primary_ip" ||
    operationKind === "create_ssh_key" ||
    operationKind === "create_server"
  );
}

function isProviderCreateOperation(operationKind: string): boolean {
  return isHetznerCreateOperation(operationKind) || operationKind === "create_instance";
}

export function shouldDiscoverHetznerCreateBeforeRetry(input: {
  providerKind: DirectCloudKind;
  operationKind: string;
  previous:
    | {
        state: "pending" | "running" | "succeeded" | "retryable" | "failed";
        provider_operation_id: string | null;
      }
    | null;
}): boolean {
  return Boolean(
    input.providerKind === "hetzner_cloud" &&
      input.previous &&
      ["pending", "running", "retryable"].includes(input.previous.state) &&
      input.previous.provider_operation_id === null &&
      isHetznerCreateOperation(input.operationKind),
  );
}

function requiredOperationName(operation: Record<string, unknown>): string {
  const name = operation.name;
  if (typeof name !== "string" || name.length === 0) {
    throw appError(
      500,
      "provider_operation_identity_missing",
      "provider operation has no deterministic resource name",
    );
  }
  return name;
}

function hetznerResourceKindForCreate(
  operationKind: string,
): "primary_ip" | "ssh_key" | "server" {
  if (operationKind === "create_primary_ip") return "primary_ip";
  if (operationKind === "create_ssh_key") return "ssh_key";
  if (operationKind === "create_server") return "server";
  throw appError(
    500,
    "provider_operation_kind_invalid",
    "provider create operation kind is invalid",
  );
}

async function reconcileExpectedHetznerResource(input: {
  input: CreationInput;
  operationKind: string;
  deterministicName: string;
  now: number;
}): Promise<{
  status: "present" | "missing";
  writes: CanonicalProviderWrite[];
}> {
  const resourceKind = hetznerResourceKindForCreate(input.operationKind);
  const request = {
    requestId: await deterministicProviderRequestId(
      input.input.allocationId,
      input.input.locationAttempt,
      `discover:${input.operationKind}:${input.deterministicName}`,
      1,
    ),
    connectionId: input.input.context.connection.id,
    credentialContext: providerCredentialContext({
      organizationId: input.input.execution.organizationId!,
      connection: input.input.context.connection,
      credential: input.input.context.credential,
    }),
    credential: providerCredentialEnvelope(input.input.context.credential),
    operation: {
      kind: "reconcile",
      resources: [
        {
          resourceKind,
          deterministicName: input.deterministicName,
          ownership: ownershipLabels(input.input),
        },
      ],
      actionIds: [],
    },
  };
  const result = await invokeProviderOperation(
    "hetzner_cloud",
    (binding) => binding.runOperation(request),
  );
  const data = result.data as {
    resources?: Array<{ status?: string }>;
  };
  const status = data.resources?.[0]?.status;
  if (status === "ambiguous" || status === "ownership_mismatch") {
    throw appError(
      409,
      status === "ambiguous"
        ? "provider_resource_discovery_ambiguous"
        : "provider_resource_ownership_mismatch",
      "provider resource discovery did not yield exactly one owned resource",
    );
  }
  if (status === "missing") return { status: "missing", writes: [] };
  const writes = result.canonicalWrites.filter(
    (write) =>
      (write.operation === "resource_created" ||
        write.operation === "resource_observed") &&
      write.resourceKind === resourceKind,
  );
  if (status !== "present" || writes.length !== 1) {
    throw appError(
      502,
      "provider_resource_discovery_invalid",
      "provider resource discovery returned an invalid result",
    );
  }
  return { status: "present", writes };
}

async function discoverExpectedHetznerResources(
  input: CreationInput,
): Promise<void> {
  if (input.context.providerKind !== "hetzner_cloud") return;
  const ambiguous = await drizzle(env.DB)
    .select({
      id: runtimeProviderOperations.id,
      operationKind: runtimeProviderOperations.operationKind,
    })
    .from(runtimeProviderOperations)
    .where(
      and(
        eq(runtimeProviderOperations.allocationId, input.allocationId),
        eq(runtimeProviderOperations.providerKind, "hetzner_cloud"),
        eq(runtimeProviderOperations.locationAttempt, input.locationAttempt),
        inArray(runtimeProviderOperations.state, [
          "pending",
          "running",
          "retryable",
        ]),
        isNull(runtimeProviderOperations.providerOperationId),
        inArray(runtimeProviderOperations.operationKind, [
          "create_primary_ip",
          "create_ssh_key",
          "create_server",
        ]),
      ),
    );
  for (const operation of ambiguous) {
    const resourceKind = normalizeResourceKind(
      hetznerResourceKindForCreate(operation.operationKind),
    );
    if (
      await loadActiveProviderResource(
        input.allocationId,
        resourceKind,
        input.locationAttempt,
      )
    ) {
      continue;
    }
    const deterministicName =
      operation.operationKind === "create_primary_ip"
        ? `${input.deterministicName}-ipv4`
        : operation.operationKind === "create_ssh_key"
          ? `${input.deterministicName}-ssh`
          : input.deterministicName;
    const discovered = await reconcileExpectedHetznerResource({
      input,
      operationKind: operation.operationKind,
      deterministicName,
      now: input.now,
    });
    if (discovered.status === "present") {
      await persistCanonicalWrites(input, discovered.writes);
      await drizzle(env.DB)
        .update(runtimeProviderOperations)
        .set({
          state: "succeeded",
          retryAt: null,
          completedAt: input.now,
          errorClass: null,
          errorCode: null,
          sanitizedResultJson: { reconciledAfterAmbiguousCreate: true },
          updatedAt: input.now,
        })
        .where(
          and(
            eq(runtimeProviderOperations.id, operation.id),
            eq(
              runtimeProviderOperations.locationAttempt,
              input.locationAttempt,
            ),
          ),
        );
    }
  }
}

export function classifyProviderOperationFailure(
  error: unknown,
  now: number,
): {
  state: "retryable" | "failed";
  retryAt: number | null;
  errorClass: "ambiguous_rpc" | "definitive";
} {
  const retryable =
    !isDefinitiveLocationCapacityFailure(error) &&
    (!(error instanceof AppError) ||
      error.status === 408 ||
      error.status === 429 ||
      error.status >= 500);
  return retryable
    ? {
        state: "retryable",
        retryAt: now + 10_000,
        errorClass: "ambiguous_rpc",
      }
    : { state: "failed", retryAt: null, errorClass: "definitive" };
}

export function classifyProviderAllocationFailure(
  error: unknown,
  now: number,
): {
  disposition:
    | "reconcile_same_allocation"
    | "fallback_location"
    | "cleanup_manual_retry";
  retryAt: number | null;
} {
  if (isDefinitiveLocationCapacityFailure(error)) {
    return { disposition: "fallback_location", retryAt: null };
  }
  const operation = classifyProviderOperationFailure(error, now);
  return operation.state === "retryable"
    ? {
        disposition: "reconcile_same_allocation",
        retryAt: operation.retryAt,
      }
    : { disposition: "cleanup_manual_retry", retryAt: null };
}

async function successfulOperationWrites(
  input: CreationInput,
  operationKind: string,
  requestId: string,
): Promise<CanonicalProviderWrite[]> {
  const resourceMapping =
    operationKind === "create_primary_ip"
      ? { stored: "ipv4", provider: "primary_ip" }
      : operationKind === "create_ssh_key"
        ? { stored: "ssh_key", provider: "ssh_key" }
        : operationKind === "create_server"
          ? { stored: "instance", provider: "server" }
          : operationKind === "create_instance"
            ? { stored: "instance", provider: "instance" }
            : null;
  if (!resourceMapping) return [];
  const resources = await drizzle(env.DB)
    .select()
    .from(runtimeProviderResources)
    .where(
      and(
        eq(runtimeProviderResources.allocationId, input.allocationId),
        eq(runtimeProviderResources.locationAttempt, input.locationAttempt),
        eq(
          runtimeProviderResources.resourceKind,
          resourceMapping.stored as "instance" | "ipv4" | "ssh_key",
        ),
        isNull(runtimeProviderResources.disappearanceConfirmedAt),
      ),
    );
  return resources.map((resource) => ({
    requestId,
    connectionId: input.context.connection.id,
    observedAt: new Date(input.now).toISOString(),
    operation: "resource_observed",
    resourceKind: resourceMapping.provider,
    externalId: resource.providerResourceId,
    name: resourceName(resource),
    operationIds: [],
    state: resource.providerState,
    ...(input.context.providerKind === "gcp_compute" &&
    resource.resourceKind === "instance" &&
    input.location
      ? { location: input.location }
      : {}),
  }));
}

async function deterministicProviderRequestId(
  allocationId: string,
  locationAttempt: number,
  operationKind: string,
  logicalOrdinal: number,
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `intar-provider-operation-v1:${allocationId}:${locationAttempt}:${operationKind}:${logicalOrdinal}`,
      ),
    ),
  ).slice(0, 16);
  // RFC 4122 variant with a deterministic version-5 marker. Provider APIs
  // require UUID syntax, while D1 retains the logical operation identity.
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

async function persistCanonicalWrites(
  input: CreationInput,
  writes: readonly CanonicalProviderWrite[],
) {
  const db = drizzle(env.DB);
  const fence = await db
    .select({
      location: runtimeProviderAllocations.location,
      locationAttempt: runtimeProviderAllocations.locationAttempt,
    })
    .from(runtimeProviderAllocations)
    .where(eq(runtimeProviderAllocations.id, input.allocationId))
    .limit(1);
  if (
    fence[0]?.locationAttempt !== input.locationAttempt ||
    fence[0]?.location !== input.location
  ) {
    throw appError(
      409,
      "provider_location_attempt_stale",
      "provider observation belongs to an obsolete location attempt",
    );
  }
  let gcpInstanceObserved = false;
  for (const write of writes) {
    if (write.operation === "resource_created" || write.operation === "resource_observed") {
      if (
        input.context.providerKind === "gcp_compute" &&
        write.operation === "resource_observed" &&
        write.resourceKind === "instance"
      ) {
        gcpInstanceObserved = true;
      }
      const externalId = String(write.externalId);
      const existing = await db
        .select({
          id: runtimeProviderResources.id,
          providerResourceId: runtimeProviderResources.providerResourceId,
        })
        .from(runtimeProviderResources)
        .where(
          and(
            eq(runtimeProviderResources.allocationId, input.allocationId),
            eq(runtimeProviderResources.locationAttempt, input.locationAttempt),
            eq(runtimeProviderResources.resourceKind, normalizeResourceKind(write.resourceKind)),
          ),
        )
        .limit(1);
      const deterministicName =
        write.name ?? `${input.deterministicName}-${write.resourceKind}`;
      if (existing[0]) {
        if (existing[0].providerResourceId !== externalId) {
          throw appError(
            409,
            "provider_resource_identity_changed",
            "provider resource identity changed within one allocation",
          );
        }
        await db
          .update(runtimeProviderResources)
          .set({
            providerState: write.state ?? "present",
            configurationJson: { deterministicName },
            disappearanceConfirmedAt: null,
            updatedAt: input.now,
          })
          .where(
            and(
              eq(runtimeProviderResources.id, existing[0].id),
              eq(
                runtimeProviderResources.locationAttempt,
                input.locationAttempt,
              ),
              sql`EXISTS (
                SELECT 1 FROM runtime_provider_allocations allocation
                WHERE allocation.id = ${input.allocationId}
                  AND allocation.location_attempt = ${input.locationAttempt}
                  AND allocation.location = ${input.location}
              )`,
            ),
          );
      } else {
        await db.insert(runtimeProviderResources).values({
          id: createAppId(),
          allocationId: input.allocationId,
          providerKind: input.context.providerKind,
          resourceKind: normalizeResourceKind(write.resourceKind),
          providerResourceId: externalId,
          locationAttempt: input.locationAttempt,
          location: input.location,
          providerState: write.state ?? "present",
          configurationJson: { deterministicName },
          providerCreatedAt: write.resourceCreatedAt
            ? Date.parse(write.resourceCreatedAt)
            : input.now,
          createdAt: input.now,
          updatedAt: input.now,
        });
      }
      if (write.publicIpv4) {
        await db
          .update(runtimeProviderAllocations)
          .set({ externalIpv4: write.publicIpv4, updatedAt: input.now })
          .where(
            and(
              eq(runtimeProviderAllocations.id, input.allocationId),
              eq(
                runtimeProviderAllocations.locationAttempt,
                input.locationAttempt,
              ),
              eq(runtimeProviderAllocations.location, input.location),
            ),
          );
      }
    } else if (write.operation === "resource_deleted") {
      // Direct-cloud Workshop profiles have exactly one resource of each kind.
      // Provider observations can identify a confirmed-missing resource by its
      // deterministic name after its numeric ID/self-link is no longer
      // queryable, so deletion is fenced by allocation + canonical kind.
      await confirmProviderResourceDisappearance({
        allocationId: input.allocationId,
        locationAttempt: input.locationAttempt,
        resourceKind: normalizeResourceKind(write.resourceKind),
        now: input.now,
      });
    }
  }
  if (gcpInstanceObserved) {
    // A name/ownership observation resolves an RPC-loss create whose provider
    // operation identity was never returned. Keep operations with a stable
    // provider ID pollable until the provider reports their terminal state.
    await env.DB.prepare(
      `UPDATE runtime_provider_operations
       SET state = 'succeeded', retry_at = NULL,
           completed_at = COALESCE(completed_at, ?),
           error_class = NULL, error_code = NULL, updated_at = ?
       WHERE allocation_id = ? AND operation_kind = 'create_instance'
         AND location_attempt = ?
         AND provider_operation_id IS NULL
         AND state IN ('pending','running','retryable')`,
    )
      .bind(
        input.now,
        input.now,
        input.allocationId,
        input.locationAttempt,
      )
      .run();
  }
  await reconcileProviderCostLedger({
    allocationId: input.allocationId,
    now: input.now,
  });
}

export async function confirmProviderResourceDisappearance(input: {
  allocationId: string;
  locationAttempt: number;
  resourceKind: "instance" | "boot_disk" | "ipv4" | "ssh_key";
  now: number;
}): Promise<void> {
  const pendingGcpCreate = await env.DB.prepare(
    `SELECT 1 AS pending
     FROM runtime_provider_allocations allocation
     JOIN runtime_provider_operations operation
       ON operation.allocation_id = allocation.id
     WHERE allocation.id = ? AND allocation.provider_kind = 'gcp_compute'
       AND allocation.location_attempt = ?
       AND operation.location_attempt = ?
       AND operation.operation_kind = 'create_instance'
       AND operation.state IN ('pending','running','retryable')
     LIMIT 1`,
  )
    .bind(
      input.allocationId,
      input.locationAttempt,
      input.locationAttempt,
    )
    .first<{ pending: number }>();
  if (pendingGcpCreate) return;
  const db = drizzle(env.DB);
  if (
    !(await providerLocationAttemptIsCurrent(
      input.allocationId,
      input.locationAttempt,
    ))
  ) {
    return;
  }
  await db
    .update(runtimeProviderResources)
    .set({
      providerState: "deleted",
      disappearanceConfirmedAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(runtimeProviderResources.allocationId, input.allocationId),
        eq(runtimeProviderResources.locationAttempt, input.locationAttempt),
        eq(runtimeProviderResources.resourceKind, input.resourceKind),
      ),
    );
  if (input.resourceKind === "ipv4") {
    await db
      .update(runtimeProviderAllocations)
      .set({ externalIpv4: null, updatedAt: input.now })
      .where(
        and(
          eq(runtimeProviderAllocations.id, input.allocationId),
          eq(
            runtimeProviderAllocations.locationAttempt,
            input.locationAttempt,
          ),
        ),
      );
  }
}

function normalizeResourceKind(value: string): "instance" | "boot_disk" | "ipv4" | "ssh_key" {
  if (value === "server") return "instance";
  if (value === "primary_ip") return "ipv4";
  if (value === "instance" || value === "boot_disk" || value === "ipv4" || value === "ssh_key") return value;
  // Provider action writes are stored as operations, never billable resources.
  throw appError(502, "provider_resource_kind_invalid", "provider returned an invalid resource kind");
}

function resourceName(
  resource: typeof runtimeProviderResources.$inferSelect,
): string {
  const name = resource.configurationJson.deterministicName;
  return typeof name === "string" && name.length > 0
    ? name
    : resource.providerResourceId;
}

function requiredExternalId(
  writes: readonly CanonicalProviderWrite[],
  kind: string,
): string {
  const write = writes.find(
    (candidate) =>
      (candidate.operation === "resource_created" ||
        candidate.operation === "resource_observed") &&
      candidate.resourceKind === kind,
  );
  if (!write) throw appError(502, "provider_create_result_invalid", "provider did not return a resource identity");
  return String(write.externalId);
}

interface AllocationContext {
  providerKind: "hetzner_cloud" | "gcp_compute";
  connection: typeof providerConnections.$inferSelect;
  credential: typeof providerCredentialVersions.$inferSelect;
  profile: typeof workshopRuntimeProfiles.$inferSelect & {
    machineType: string;
    resolvedImageId: string;
  };
  bundle: typeof runtimeCheckpointBundles.$inferSelect;
  scheduledStartAt: number;
}

async function requireProviderAllocationGuardrails(input: {
  sessionId: string;
  context: AllocationContext;
  now: number;
}): Promise<{
  locationAttempts: string[];
  priceObservationId: string;
  costForecastId: string;
}> {
  const forecast = await env.DB.prepare(
    `SELECT forecast.id,
            forecast.price_observation_id,
            forecast.expires_at,
            forecast.exceeds_budget_ceiling,
            selection.gross_ceiling_override_at,
            observation.expires_at AS observation_expires_at,
            observation.raw_observation_json
     FROM workshop_session_cost_forecasts forecast
     JOIN workshop_session_runtime_selections selection
       ON selection.session_id = forecast.session_id
     JOIN provider_price_observations observation
       ON observation.id = forecast.price_observation_id
      AND observation.connection_id = selection.connection_id
      AND observation.runtime_profile_id = selection.runtime_profile_id
      AND observation.provider_kind = forecast.provider_kind
     WHERE forecast.session_id = ?
       AND forecast.provider_kind = ?
       AND selection.connection_id = ?
       AND selection.runtime_profile_id = ?
     ORDER BY forecast.version DESC
     LIMIT 1`,
  )
    .bind(
      input.sessionId,
      input.context.providerKind,
      input.context.connection.id,
      input.context.profile.id,
    )
    .first<{
      id: string;
      price_observation_id: string;
      expires_at: number;
      observation_expires_at: number;
      exceeds_budget_ceiling: number;
      gross_ceiling_override_at: number | null;
      raw_observation_json: string | Record<string, unknown>;
    }>();
  if (
    !forecast ||
    forecast.expires_at <= input.now ||
    forecast.observation_expires_at <= input.now
  ) {
    throw appError(
      409,
      "workshop_cost_forecast_stale",
      "a current provider cost forecast is required before provisioning",
    );
  }
  const overridden = forecast.gross_ceiling_override_at !== null;
  if (forecast.exceeds_budget_ceiling === 1 && !overridden) {
    throw appError(
      409,
      "workshop_cost_ceiling_exceeded",
      "the current lease-ceiling forecast exceeds the organization limit",
    );
  }
  const live = await getWorkshopCostProjection({
    sessionId: input.sessionId,
    now: input.now,
  });
  if (live.live?.overBudgetCeiling && !overridden) {
    throw appError(
      409,
      "workshop_cost_ceiling_exceeded",
      "the current provider cost projection exceeds the organization limit",
    );
  }

  await requireProviderConnectionSeat(
    input.context.providerKind,
    input.context.connection.id,
  );

  const observation = parseStoredObject(forecast.raw_observation_json);
  const available = Array.isArray(observation?.availableLocations)
    ? observation.availableLocations.filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      )
    : [];
  const permittedLocations = await requireProviderLocationAttempts(input.context);
  const preferredLocation = permittedLocations.find((location) =>
    available.includes(location),
  );
  if (!preferredLocation) {
    throw appError(
      409,
      "provider_location_unavailable",
      "the exact runtime profile is unavailable in every approved fallback location",
    );
  }
  return {
    locationAttempts: [
      preferredLocation,
      ...permittedLocations.filter(
        (location) => location !== preferredLocation,
      ),
    ],
    priceObservationId: forecast.price_observation_id,
    costForecastId: forecast.id,
  };
}

async function requireProviderLocationAttempts(
  context: AllocationContext,
): Promise<string[]> {
  const connectionLocations =
    context.providerKind === "hetzner_cloud"
      ? (
          await drizzle(env.DB)
            .select({ locations: hetznerConnectionDetails.approvedLocationsJson })
            .from(hetznerConnectionDetails)
            .where(
              eq(
                hetznerConnectionDetails.connectionId,
                context.connection.id,
              ),
            )
            .limit(1)
        )[0]?.locations
      : (
          await drizzle(env.DB)
            .select({ locations: gcpConnectionDetails.approvedZonesJson })
            .from(gcpConnectionDetails)
            .where(eq(gcpConnectionDetails.connectionId, context.connection.id))
            .limit(1)
        )[0]?.locations;
  const locations = orderedProviderLocationAttempts({
    profileLocations: context.profile.locationsJson,
    connectionLocations: connectionLocations ?? [],
  });
  if (locations.length === 0) {
    throw appError(
      409,
      "provider_location_unavailable",
      "the exact runtime profile is unavailable in every approved fallback location",
    );
  }
  return locations;
}

async function requireProviderConnectionSeat(
  providerKind: DirectCloudKind,
  connectionId: string,
): Promise<void> {
  const detailTable =
    providerKind === "hetzner_cloud"
      ? "hetzner_connection_details"
      : "gcp_connection_details";
  const limit = await env.DB.prepare(
    `SELECT max_concurrent_allocations AS value
     FROM ${detailTable}
     WHERE connection_id = ?`,
  )
    .bind(connectionId)
    .first<{ value: number }>();
  if (!limit || !Number.isSafeInteger(limit.value) || limit.value < 1) {
    throw appError(
      409,
      "provider_connection_incomplete",
      "the provider allocation limit is unavailable",
    );
  }
  const usage = await env.DB.prepare(
    `SELECT count(*) AS value
     FROM runtime_provider_allocations
     WHERE connection_id = ? AND state != 'deleted'`,
  )
    .bind(connectionId)
    .first<{ value: number }>();
  if ((usage?.value ?? 0) >= limit.value) {
    throw appError(
      409,
      "provider_concurrency_limit_exceeded",
      "the provider connection has no remaining allocation seats",
    );
  }
}

function parseStoredObject(
  value: string | Record<string, unknown>,
): Record<string, unknown> | null {
  if (typeof value !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function requireAllocationContext(
  request: WorkshopProvisioningRequest,
): Promise<AllocationContext> {
  await assertProvisioningAuthorized(request);
  const db = drizzle(env.DB);
  const selections = await db
    .select({
      providerKind: workshopSessionRuntimeSelections.providerKind,
      connectionId: workshopSessionRuntimeSelections.connectionId,
      profile: workshopRuntimeProfiles,
      scheduledStartAt: workshopSessions.scheduledStartAt,
    })
    .from(workshopSessionRuntimeSelections)
    .innerJoin(
      workshopRuntimeProfiles,
      eq(workshopRuntimeProfiles.id, workshopSessionRuntimeSelections.runtimeProfileId),
    )
    .innerJoin(
      workshopSessions,
      eq(workshopSessions.id, workshopSessionRuntimeSelections.sessionId),
    )
    .where(eq(workshopSessionRuntimeSelections.sessionId, request.sessionId))
    .limit(1);
  const selected = selections[0];
  if (!selected || selected.providerKind === "agent_kvm" || !selected.connectionId) {
    throw appError(409, "workshop_direct_provider_required", "session is not a direct-cloud workshop");
  }
  if (!selected.profile.machineType || !selected.profile.resolvedImageId) {
    throw appError(
      409,
      "workshop_runtime_profile_incomplete",
      "the selected direct-cloud runtime profile is incomplete",
    );
  }
  const connections = await db
    .select()
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.id, selected.connectionId),
        eq(providerConnections.organizationId, request.organizationId),
        eq(providerConnections.providerKind, selected.providerKind),
        eq(providerConnections.state, "active"),
      ),
    )
    .limit(1);
  const connection = connections[0];
  if (!connection?.activeCredentialVersionId) throw appError(409, "provider_connection_inactive", "provider connection is inactive");
  const credentials = await db
    .select()
    .from(providerCredentialVersions)
    .where(eq(providerCredentialVersions.id, connection.activeCredentialVersionId))
    .limit(1);
  const credential = credentials[0];
  if (!credential) throw appError(409, "provider_credential_missing", "provider credential is missing");
  const bundles = await db
    .select()
    .from(runtimeCheckpointBundles)
    .where(
      and(
        eq(runtimeCheckpointBundles.templateRevisionId, request.templateRevisionId),
        eq(runtimeCheckpointBundles.checkpointId, request.checkpointId),
      ),
    )
    .limit(1);
  const bundle = bundles[0];
  if (!bundle) throw appError(409, "runtime_checkpoint_bundle_missing", "checkpoint reconstruction bundle is unavailable");
  return {
    providerKind: selected.providerKind,
    connection,
    credential,
    profile: selected.profile as typeof selected.profile & {
      machineType: string;
      resolvedImageId: string;
    },
    bundle,
    scheduledStartAt: selected.scheduledStartAt,
  };
}

async function assertProvisioningAuthorized(request: WorkshopProvisioningRequest) {
  const row = await env.DB.prepare(
    `SELECT 1 AS authorized
     FROM workshop_sessions session
     JOIN workshop_workspaces workspace ON workspace.session_id = session.id
     JOIN workshop_workspace_generations generation ON generation.workspace_id = workspace.id
     JOIN workshop_session_members roster
       ON roster.session_id = session.id AND roster.user_id = workspace.user_id
     JOIN member organization_member
       ON organization_member.organization_id = session.organization_id
      AND organization_member.user_id = workspace.user_id
     WHERE session.id = ? AND session.organization_id = ?
       AND session.template_revision_id = ? AND session.state IN ('lobby','live')
       AND workspace.id = ? AND workspace.user_id = ?
       AND workspace.current_generation_id = generation.id
       AND generation.id = ? AND generation.ordinal = ?
       AND generation.checkpoint_id = ? AND roster.workspace_enabled = 1
       AND organization_member.workshop_access_revoking_at IS NULL`,
  )
    .bind(
      request.sessionId,
      request.organizationId,
      request.templateRevisionId,
      request.workspaceId,
      request.participantUserId,
      request.generationId,
      request.generationOrdinal,
      request.checkpointId,
    )
    .first();
  if (!row) throw appError(409, "workshop_provisioning_request_stale", "workshop provisioning is no longer authorized");
}

function directRuntimeVmSpecs(
  request: WorkshopProvisioningRequest,
  executionId: string,
  bundle: typeof runtimeCheckpointBundles.$inferSelect,
): RuntimeVmSpec[] {
  return request.manifest.workspace.vms.map((vm, ordinal) => ({
    vmId: vm.id,
    ordinal,
    runtimeVmName: `workshop-${executionId}-${runtimeNamePart(vm.id)}`,
    imageKey: {
      kind: "direct_cloud_checkpoint",
      checkpointId: request.checkpointId,
      bundleId: bundle.id,
    },
    imageSha256: bundle.sha256,
    cpuMillis: vm.cpuMillis,
    memoryMib: vm.memoryMib,
    diskMib: vm.diskMib,
  }));
}

interface ExecutionAllocationContext extends AllocationContext {
  executionId: string;
  generation: number;
  domainKind: "workshop" | "workshop_certification";
  workspaceId: string;
  certificationPublicationId: string | null;
  allocation: typeof runtimeProviderAllocations.$inferSelect;
}

interface ProviderFailureProjectionContext {
  executionId: string;
  generation: number;
  domainKind: "workshop" | "workshop_certification";
  workspaceId: string;
  allocation: typeof runtimeProviderAllocations.$inferSelect;
}

async function loadProviderFailureProjectionContext(
  allocationId: string,
): Promise<ProviderFailureProjectionContext | null> {
  const rows = await drizzle(env.DB)
    .select({
      allocation: runtimeProviderAllocations,
      executionId: runtimeExecutions.id,
      generation: runtimeExecutions.generation,
      domainKind: runtimeExecutions.domainKind,
      workspaceId: runtimeExecutions.domainId,
    })
    .from(runtimeProviderAllocations)
    .innerJoin(
      runtimeExecutions,
      eq(runtimeExecutions.id, runtimeProviderAllocations.executionId),
    )
    .where(eq(runtimeProviderAllocations.id, allocationId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    executionId: row.executionId,
    generation: row.generation,
    domainKind:
      row.domainKind === "workshop_certification"
        ? "workshop_certification"
        : "workshop",
    workspaceId: row.workspaceId,
    allocation: row.allocation,
  };
}

async function loadExecutionAllocation(executionId: string): Promise<ExecutionAllocationContext | null> {
  const db = drizzle(env.DB);
  // Keep each projection below SQLite's result-column limit. Selecting every
  // column from the allocation, execution, profile, connection, credential and
  // bundle tables in one join became invalid once immutable cost pins were
  // added to allocations.
  const roots = await db
    .select({
      allocation: runtimeProviderAllocations,
      execution: runtimeExecutions,
    })
    .from(runtimeProviderAllocations)
    .innerJoin(runtimeExecutions, eq(runtimeExecutions.id, runtimeProviderAllocations.executionId))
    .where(eq(runtimeProviderAllocations.executionId, executionId))
    .limit(1);
  const root = roots[0];
  if (!root) return null;
  const providers = await db
    .select({
      profile: workshopRuntimeProfiles,
      connection: providerConnections,
      credential: providerCredentialVersions,
    })
    .from(workshopRuntimeProfiles)
    .innerJoin(
      providerConnections,
      eq(providerConnections.id, root.allocation.connectionId),
    )
    .innerJoin(
      providerCredentialVersions,
      eq(
        providerCredentialVersions.id,
        providerConnections.activeCredentialVersionId,
      ),
    )
    .where(eq(workshopRuntimeProfiles.id, root.allocation.runtimeProfileId))
    .limit(1);
  const provider = providers[0];
  if (!provider) return null;
  if (!root.execution.checkpointId) return null;
  const bundles = await db
    .select()
    .from(runtimeCheckpointBundles)
    .where(
      and(
        eq(
          runtimeCheckpointBundles.templateRevisionId,
          provider.profile.templateRevisionId,
        ),
        eq(
          runtimeCheckpointBundles.checkpointId,
          root.execution.checkpointId,
        ),
      ),
    )
    .limit(1);
  const bundle = bundles[0];
  if (!bundle) return null;
  if (!provider.profile.machineType || !provider.profile.resolvedImageId) {
    throw appError(
      409,
      "workshop_runtime_profile_incomplete",
      "the selected direct-cloud runtime profile is incomplete",
    );
  }
  const certificationPublicationId =
    root.execution.domainKind === "workshop_certification"
      ? await loadCertificationPublicationId(root.execution.domainId)
      : null;
  return {
        providerKind: root.allocation.providerKind,
        executionId,
        generation: root.execution.generation,
        domainKind: root.execution.domainKind === "workshop_certification"
          ? "workshop_certification"
          : "workshop",
        workspaceId: root.execution.domainId,
        certificationPublicationId,
        allocation: root.allocation,
        profile: provider.profile as typeof provider.profile & {
          machineType: string;
          resolvedImageId: string;
        },
        connection: provider.connection,
        credential: provider.credential,
        bundle,
        scheduledStartAt: root.execution.createdAt,
      };
}

async function loadCertificationPublicationId(
  certificationId: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT json_extract(evidence_json, '$.publicationId') AS publication_id
     FROM workshop_runtime_profile_certifications
     WHERE id = ?`,
  )
    .bind(certificationId)
    .first<{ publication_id: string | null }>();
  return row?.publication_id ?? null;
}

function creationInputFromContext(context: ExecutionAllocationContext, now: number): CreationInput {
  return {
    allocationId: context.allocation.id,
    execution: {
      executionId: context.executionId,
      generation: context.generation,
      organizationId: context.connection.organizationId,
      domainId: context.workspaceId,
    },
    context,
    deterministicName: context.allocation.deterministicName,
    location: context.allocation.location,
    locationAttempt: context.allocation.locationAttempt,
    sshPublicKey: "unused-during-reconciliation",
    cloudInit: "",
    ...(context.domainKind === "workshop_certification" &&
    context.certificationPublicationId
      ? {
          certification: {
            publicationId: context.certificationPublicationId,
            checkpointId: context.bundle.checkpointId,
          },
        }
      : {}),
    now,
  };
}

function ownershipLabels(input: CreationInput) {
  if (input.certification) {
    return {
      organizationRef: input.execution.organizationId!,
      connectionRef: input.context.connection.id,
      purpose: "workshop_publication_verifier" as const,
      workshopPublicationRef: input.certification.publicationId,
      checkpointRef: input.certification.checkpointId,
      attempt: input.locationAttempt,
    };
  }
  return {
    organizationRef: input.execution.organizationId!,
    connectionRef: input.context.connection.id,
    purpose: "learner_workspace" as const,
    workspaceRef: input.execution.domainId,
    generation: input.execution.generation,
    attempt: input.locationAttempt,
  };
}

async function currentExecution(request: WorkshopProvisioningRequest) {
  const row = await env.DB.prepare(
    `SELECT generation.runtime_execution_id,
            execution.state AS execution_state,
            allocation.state AS allocation_state
     FROM workshop_workspace_generations generation
     LEFT JOIN runtime_executions execution
       ON execution.id = generation.runtime_execution_id
     LEFT JOIN runtime_provider_allocations allocation
       ON allocation.execution_id = execution.id
     WHERE generation.id = ? AND generation.workspace_id = ?
       AND generation.ordinal = ?`,
  )
    .bind(request.generationId, request.workspaceId, request.generationOrdinal)
    .first<{
      runtime_execution_id: string | null;
      execution_state: string | null;
      allocation_state: string | null;
    }>();
  if (
    row?.runtime_execution_id &&
    (row.execution_state === "archived" ||
      row.execution_state === "failed" ||
      row.allocation_state === "deleted" ||
      row.allocation_state === "failed")
  ) {
    // Bulk provisioning creates a fresh immutable Workshop generation for a
    // linked failed execution. Never report the archived handle as success to
    // a stale direct retry.
    throw appError(
      409,
      "workshop_runtime_generation_retry_required",
      "a fresh Workshop generation is required to retry this workspace",
    );
  }
  if (
    row?.runtime_execution_id &&
    ["draining", "deleting", "cleanup_pending"].includes(
      row.allocation_state ?? "",
    )
  ) {
    throw appError(
      409,
      "workshop_provider_cleanup_pending",
      "the previous provider allocation must be deleted before retrying",
    );
  }
  return row?.runtime_execution_id ?? null;
}

async function previousExecution(request: WorkshopProvisioningRequest) {
  const row = await env.DB.prepare(
    `SELECT runtime_execution_id, ordinal FROM workshop_workspace_generations
     WHERE workspace_id = ? AND ordinal < ? AND runtime_execution_id IS NOT NULL
     ORDER BY ordinal DESC LIMIT 1`,
  )
    .bind(request.workspaceId, request.generationOrdinal)
    .first<{ runtime_execution_id: string; ordinal: number }>();
  return row ? { executionId: row.runtime_execution_id, generation: row.ordinal } : null;
}

async function loadRuntimeHandle(executionId: string): Promise<RuntimeExecutionHandle> {
  const row = await env.DB.prepare(`SELECT * FROM runtime_executions WHERE id = ?`)
    .bind(executionId)
    .first<Record<string, unknown>>();
  if (!row) throw appError(404, "runtime_execution_not_found", "runtime execution not found");
  const vms = await env.DB.prepare(`SELECT * FROM runtime_vms WHERE execution_id = ? ORDER BY ordinal`)
    .bind(executionId)
    .all<Record<string, unknown>>();
  const mapped = vms.results.map((vm) => ({
    runtimeVmId: String(vm.id), vmId: String(vm.vm_id), ordinal: Number(vm.ordinal),
    runtimeVmName: String(vm.runtime_vm_name),
    imageKey: JSON.parse(String(vm.image_key_json)) as object,
    imageSha256: String(vm.image_sha256), cpuMillis: Number(vm.cpu_millis),
    memoryMib: Number(vm.memory_mib), diskMib: Number(vm.disk_mib),
  }));
  return {
    executionId: String(row.id), userId: String(row.user_id),
    organizationId: typeof row.organization_id === "string" ? row.organization_id : null,
    hostId: null,
    providerKind: row.provider_kind as RuntimeExecutionHandle["providerKind"],
    providerConnectionId: String(row.provider_connection_id), domainKind: "workshop",
    domainId: String(row.domain_id), generation: Number(row.generation),
    sourceExecutionId: typeof row.source_execution_id === "string" ? row.source_execution_id : null,
    checkpointId: typeof row.checkpoint_id === "string" ? row.checkpoint_id : null,
    state: row.state as RuntimeExecutionHandle["state"],
    leaseExpiresAt: typeof row.lease_expires_at === "number" ? row.lease_expires_at : null,
    createdAt: Number(row.created_at), vms: mapped,
    resources: {
      cpuMillis: mapped.reduce((sum, vm) => sum + vm.cpuMillis, 0),
      memoryMib: mapped.reduce((sum, vm) => sum + vm.memoryMib, 0),
      worstCaseDiskMib: mapped.reduce((sum, vm) => sum + vm.diskMib, 0),
    },
  };
}

function providerResourceName(workspaceId: string, generation: number) {
  return `intar-${workspaceId.replace(/[^a-z0-9-]/giu, "-").toLowerCase().slice(0, 36)}-g${generation}`;
}

function runtimeNamePart(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 24) || "vm";
}
