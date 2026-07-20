import { env } from "cloudflare:workers";
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  workshopAssistGrants,
  workshopEvents,
  workshopModuleProgress,
  workshopSessionMembers,
  workshopWorkspaceGenerations,
  workshopWorkspaces,
  type WorkshopManifestV1,
} from "@/db/schema";
import type { DesiredVmV2 } from "@/generated/bridge";
import { AppError, appError, errorChainMatches } from "@/lib/app-error";
import {
  markDesiredVmAbsent,
  upsertDesiredCachedImage,
  upsertDesiredVm,
} from "@/lib/desired-state";
import { mutateStoredHostDesiredState } from "@/lib/desired-state-store";
import { createAppId } from "@/lib/id";
import { RUNTIME_PENDING_RESOURCE_RESERVATION_TTL_MS } from "@/lib/runtime-capacity";
import {
  runtimeCapacityAllocationKey,
  withRuntimeAllocationLock,
} from "@/lib/runtime-allocation-lock";
import {
  archiveRuntimeExecution,
  createRuntimeExecution,
  createRuntimeRecoveryGeneration,
  updateRuntimeExecutionState,
  type RuntimeExecutionHandle,
  type RuntimeVmSpec,
} from "@/lib/runtime-executions";
import { ensureRuntimeVmAccessKeys } from "@/lib/runtime-vm-state";
import {
  deleteStargateRoute,
  deleteStargateWorkspaceAppRoute,
} from "@/lib/stargate";
import { checkpointImages, selectWorkshopRuntimeHost } from "./capacity";
import { recordWorkshopGenerationState } from "./provisioning";
import { revokeWorkshopRouteIssuanceIntents } from "./route-issuance-intents";
import { loadWorkshopManifestForSession, workshopDb } from "./shared";
import type { WorkshopProvisioningRequest } from "./types";

const DEFAULT_FAILED_HOST_RECOVERY_BATCH_SIZE = 8;
const MAX_FAILED_HOST_RECOVERY_BATCH_SIZE = 32;

export interface WorkshopProvisioningOutcome {
  generationId: string;
  participantUserId: string;
  ok: boolean;
  runtimeExecutionId?: string;
  hostId?: string;
  error?: string;
}

export async function provisionWorkshopRequests(
  requests: readonly WorkshopProvisioningRequest[],
): Promise<WorkshopProvisioningOutcome[]> {
  const outcomes: WorkshopProvisioningOutcome[] = [];
  for (const request of requests) {
    try {
      const execution = await provisionWorkshopRequest(request);
      outcomes.push({
        generationId: request.generationId,
        participantUserId: request.participantUserId,
        ok: true,
        runtimeExecutionId: execution.executionId,
        ...(execution.hostId ? { hostId: execution.hostId } : {}),
      });
    } catch (error) {
      outcomes.push({
        generationId: request.generationId,
        participantUserId: request.participantUserId,
        ok: false,
        error: errorMessage(error),
      });
    }
  }
  return outcomes;
}

export async function provisionWorkshopRequest(
  request: WorkshopProvisioningRequest,
  options: {
    excludedHostIds?: readonly string[];
    recoveryMessage?: string;
  } = {},
): Promise<RuntimeExecutionHandle> {
  const now = Date.now();
  const session = await validateProvisioningRequest(request, now);
  const leaseExpiresAt =
    session.scheduledStartAt +
    (request.manifest.durationMinutes +
      request.manifest.workspace.leaseGraceMinutes) *
      60_000;
  if (leaseExpiresAt <= now) {
    await failWorkshopGeneration(
      request,
      "the workshop workspace lease has already expired",
      now,
    );
    throw appError(
      409,
      "workshop_workspace_lease_expired",
      "the workshop workspace lease has already expired",
    );
  }

  let execution: RuntimeExecutionHandle | null = null;
  let source: SourceGeneration | null = null;
  try {
    const allocated = await withRuntimeAllocationLock({
      key: runtimeCapacityAllocationKey(request.organizationId),
      operation: async () => {
        const current = await loadCurrentGenerationRuntime(request);
        if (current) {
          return {
            execution: await loadRuntimeHandle(current.executionId),
            source: null,
          };
        }
        const selected = await selectWorkshopRuntimeHost({
          organizationId: request.organizationId,
          manifest: request.manifest,
          checkpointId: request.checkpointId,
          now,
          ...(options.excludedHostIds
            ? { excludedHostIds: options.excludedHostIds }
            : {}),
        });
        const executionId = createAppId();
        const vms = runtimeVmSpecs(request, executionId);
        const previous = await loadPreviousRuntimeGeneration(request);
        // A recovery generation atomically archives the source execution,
        // releases its reservation, and moves the user's active slot. Persist
        // the old VMs as absent first so a failed desired-state mutation leaves
        // the still-current source fully reserved and safely retryable.
        if (previous) {
          await markRuntimeExecutionDesiredAbsent(previous.executionId, now);
        }
        const created = previous
          ? await createRuntimeRecoveryGeneration({
              sourceExecutionId: previous.executionId,
              expectedGeneration: previous.ordinal,
              executionId,
              hostId: selected.hostId,
              checkpointId: request.checkpointId,
              leaseExpiresAt,
              vms,
              reservationState: "pending",
              reservationExpiresAt:
                now + RUNTIME_PENDING_RESOURCE_RESERVATION_TTL_MS,
              now,
            })
          : await createRuntimeExecution({
              executionId,
              userId: request.participantUserId,
              organizationId: request.organizationId,
              hostId: selected.hostId,
              domainKind: "workshop",
              domainId: request.workspaceId,
              checkpointId: request.checkpointId,
              leaseExpiresAt,
              vms,
              claimActiveSlot: true,
              reservationState: "pending",
              reservationExpiresAt:
                now + RUNTIME_PENDING_RESOURCE_RESERVATION_TTL_MS,
              now,
            });
        execution = created;
        source = previous;
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
            hostId: created.hostId,
            observedAt: now,
          },
        });
        return { execution: created, source: previous };
      },
    });
    execution = allocated.execution;
    source = allocated.source;
    const activeExecution = execution;
    await assertWorkshopProvisioningFence(request, activeExecution.executionId);
    await env.DB.prepare(
      `UPDATE host_resource_reservations
       SET expires_at = ?, updated_at = ?
       WHERE execution_id = ? AND state = 'pending'`,
    )
      .bind(
        now + RUNTIME_PENDING_RESOURCE_RESERVATION_TTL_MS,
        now,
        activeExecution.executionId,
      )
      .run();

    if (source) {
      await workshopDb()
        .update(workshopWorkspaceGenerations)
        .set({ state: "archived", archivedAt: now, updatedAt: now })
        .where(eq(workshopWorkspaceGenerations.id, source.generationId));
    }

    const accessKeys = await ensureRuntimeVmAccessKeys({
      executionId: activeExecution.executionId,
      expectedGeneration: activeExecution.generation,
      now,
    });
    const publicKeyByVmId = new Map(
      accessKeys.map((key) => [key.vmId, key.publicKeyOpenssh]),
    );
    const imageByVmId = new Map(
      checkpointImages(request.manifest, request.checkpointId).map((image) => [
        image.imageKey.vm,
        image,
      ]),
    );
    await mutateStoredHostDesiredState(
      drizzle(env.DB),
      requiredHost(activeExecution),
      now,
      (draft) => {
        for (const image of imageByVmId.values()) {
          upsertDesiredCachedImage(draft, {
            image_key: image.imageKey,
            image_sha256: image.imageSha256,
          });
        }
        for (const vm of activeExecution.vms) {
          const publicKey = publicKeyByVmId.get(vm.vmId);
          if (!publicKey) {
            throw appError(
              500,
              "runtime_vm_access_key_missing",
              `runtime access key missing for VM ${vm.vmId}`,
            );
          }
          upsertDesiredVm(
            draft,
            desiredWorkshopVm(activeExecution, vm, publicKey, leaseExpiresAt),
          );
        }
      },
      undefined,
      {
        condition: workshopProvisioningDesiredStateWriteGuard(
          request,
          activeExecution.executionId,
        ),
        assertSatisfied: () =>
          assertWorkshopProvisioningFence(
            request,
            activeExecution.executionId,
          ),
      },
    );
    await commitRuntimeResourceReservation(activeExecution);
    await updateRuntimeExecutionState({
      executionId: execution.executionId,
      expectedGeneration: execution.generation,
      state: "provisioning",
      leaseExpiresAt,
      observedAt: now,
    });
    await assertWorkshopProvisioningFence(request, execution.executionId);
    if (options.recoveryMessage) {
      await workshopDb()
        .update(workshopWorkspaces)
        .set({ recoveryMessage: options.recoveryMessage, updatedAt: now })
        .where(
          and(
            eq(workshopWorkspaces.id, request.workspaceId),
            eq(workshopWorkspaces.currentGenerationId, request.generationId),
          ),
        );
    }
    return execution;
  } catch (error) {
    if (execution) {
      await bestEffortRuntimeCleanup(execution, now);
    }
    const terminalSession =
      await workshopProvisioningSessionIsTerminal(request);
    if (terminalSession) {
      await bestEffortArchiveWorkshopGeneration(request, execution, now);
    } else {
      await failWorkshopGeneration(request, errorMessage(error), now);
    }
    if (
      terminalSession &&
      ((error instanceof AppError &&
        error.code === "workshop_generation_stale") ||
        errorChainMatches(
          error,
          /workshop runtime provisioning is no longer authorized/,
        ))
    ) {
      throw appError(
        409,
        "workshop_provisioning_request_stale",
        "workshop provisioning authorization changed while the runtime was starting",
      );
    }
    throw error;
  }
}

export async function teardownWorkshopSessionRuntimes(input: {
  sessionId: string;
  now?: number;
}): Promise<void> {
  const now = input.now ?? Date.now();
  const rows = await env.DB.prepare(
    `SELECT workspace.id AS workspace_id,
            workspace.terminal_route_usernames_json,
            workspace.application_route_ids_json,
            generation.id AS generation_id,
            generation.ordinal,
            coalesce(generation.runtime_execution_id, domain_execution.id)
              AS runtime_execution_id
     FROM workshop_workspaces workspace
     LEFT JOIN workshop_workspace_generations generation
       ON generation.workspace_id = workspace.id
     LEFT JOIN runtime_executions domain_execution
       ON domain_execution.domain_kind = 'workshop'
      AND domain_execution.domain_id = workspace.id
      AND domain_execution.generation = generation.ordinal
     WHERE workspace.session_id = ?
     UNION ALL
     SELECT workspace.id AS workspace_id,
            workspace.terminal_route_usernames_json,
            workspace.application_route_ids_json,
            NULL AS generation_id,
            domain_execution.generation AS ordinal,
            domain_execution.id AS runtime_execution_id
     FROM workshop_workspaces workspace
     JOIN runtime_executions domain_execution
       ON domain_execution.domain_kind = 'workshop'
      AND domain_execution.domain_id = workspace.id
     WHERE workspace.session_id = ?
       AND NOT EXISTS (
         SELECT 1
         FROM workshop_workspace_generations generation
         WHERE generation.workspace_id = workspace.id
           AND generation.ordinal = domain_execution.generation
       )
     ORDER BY workspace_id ASC, ordinal ASC`,
  )
    .bind(input.sessionId, input.sessionId)
    .all<{
      workspace_id: string;
      terminal_route_usernames_json: string | string[];
      application_route_ids_json: string | string[];
      generation_id: string | null;
      ordinal: number | null;
      runtime_execution_id: string | null;
    }>();

  const revokedWorkspaceIds = new Set<string>();
  for (const row of rows.results) {
    if (!revokedWorkspaceIds.has(row.workspace_id)) {
      await revokeWorkshopWorkspaceRoutes({
        workspaceId: row.workspace_id,
        terminalRouteUsernames: jsonStrings(row.terminal_route_usernames_json),
        applicationRouteIds: jsonStrings(row.application_route_ids_json),
        now,
      });
      revokedWorkspaceIds.add(row.workspace_id);
    }
    if (row.runtime_execution_id && row.ordinal) {
      await markRuntimeExecutionDesiredAbsent(row.runtime_execution_id, now);
      try {
        await archiveRuntimeExecution({
          executionId: row.runtime_execution_id,
          expectedGeneration: row.ordinal,
          endedAt: now,
        });
      } catch (error) {
        if (
          !(
            error instanceof AppError &&
            (error.code === "runtime_generation_stale" ||
              error.code === "runtime_execution_not_found")
          ) &&
          !errorChainMatches(error, /runtime execution not found/)
        ) {
          throw error;
        }
      }
      if (row.generation_id) {
        await recordWorkshopGenerationState({
          generationId: row.generation_id,
          update: {
            state: "archived",
            runtimeExecutionId: row.runtime_execution_id,
            observedAt: now,
          },
        });
      }
    } else if (row.generation_id) {
      await recordWorkshopGenerationState({
        generationId: row.generation_id,
        update: { state: "archived", observedAt: now },
      });
    }
  }
}

export async function recoverWorkshopRuntimesFromFailedHost(input: {
  hostId: string;
  now?: number;
  maxWorkspaces?: number;
}): Promise<WorkshopProvisioningOutcome[]> {
  const now = input.now ?? Date.now();
  const requestedBatchSize = input.maxWorkspaces;
  const maxWorkspaces =
    typeof requestedBatchSize === "number" &&
    Number.isFinite(requestedBatchSize)
      ? Math.max(
          1,
          Math.min(
            MAX_FAILED_HOST_RECOVERY_BATCH_SIZE,
            Math.trunc(requestedBatchSize),
          ),
        )
      : DEFAULT_FAILED_HOST_RECOVERY_BATCH_SIZE;
  const rows = await env.DB.prepare(
    `SELECT
       workspace.id AS workspace_id,
       workspace.session_id,
       workspace.user_id,
       workspace.terminal_route_usernames_json,
       workspace.application_route_ids_json,
       generation.id AS generation_id,
       generation.ordinal,
       generation.checkpoint_id,
       generation.runtime_execution_id,
       session.organization_id,
       session.template_revision_id
     FROM workshop_workspaces workspace
     INNER JOIN workshop_workspace_generations generation
       ON generation.id = workspace.current_generation_id
     INNER JOIN workshop_sessions session ON session.id = workspace.session_id
     WHERE session.state IN ('lobby', 'live')
       AND (
         (
           generation.host_id = ?
           AND generation.runtime_execution_id IS NOT NULL
           AND generation.state IN ('provisioning', 'ready')
         )
         OR (
           workspace.state IN ('recovering', 'failed')
           AND generation.state IN ('queued', 'failed')
           AND EXISTS (
             SELECT 1
             FROM workshop_events event
             WHERE event.session_id = workspace.session_id
               AND event.type = 'workspace.host_failure_recovery_requested'
               AND json_extract(event.payload_json, '$.generationId') = generation.id
               AND json_extract(event.payload_json, '$.failedHostId') = ?
           )
         )
       )
     ORDER BY workspace.id ASC
     LIMIT ?`,
  )
    .bind(input.hostId, input.hostId, maxWorkspaces)
    .all<{
      workspace_id: string;
      session_id: string;
      user_id: string;
      terminal_route_usernames_json: string | string[];
      application_route_ids_json: string | string[];
      generation_id: string;
      ordinal: number;
      checkpoint_id: string | null;
      runtime_execution_id: string | null;
      organization_id: string;
      template_revision_id: string;
    }>();
  const outcomes: WorkshopProvisioningOutcome[] = [];
  for (const row of rows.results) {
    let attemptedGenerationId = row.generation_id;
    try {
      const context = await loadWorkshopManifestForSession(row.session_id);
      const reusableGeneration = row.runtime_execution_id === null;
      const checkpointId = reusableGeneration
        ? (row.checkpoint_id ?? context.manifest.workspace.initialCheckpointId)
        : await latestApplicableCheckpoint({
            sessionId: row.session_id,
            userId: row.user_id,
            manifest: context.manifest,
            fallbackCheckpointId:
              row.checkpoint_id ??
              context.manifest.workspace.initialCheckpointId,
          });
      const generationId = reusableGeneration
        ? row.generation_id
        : createAppId();
      const ordinal = reusableGeneration ? row.ordinal : row.ordinal + 1;
      attemptedGenerationId = generationId;
      const message = `Runner failure detected. Restoring ${checkpointId} on another runner; work since that checkpoint may be lost.`;
      const db = workshopDb();
      const resetOrInsertGeneration = reusableGeneration
        ? db
            .update(workshopWorkspaceGenerations)
            .set({
              state: "queued",
              error: null,
              failedAt: null,
              requestedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(workshopWorkspaceGenerations.id, generationId),
                eq(workshopWorkspaceGenerations.workspaceId, row.workspace_id),
                isNull(workshopWorkspaceGenerations.runtimeExecutionId),
                inArray(workshopWorkspaceGenerations.state, [
                  "queued",
                  "failed",
                ]),
              ),
            )
        : db.insert(workshopWorkspaceGenerations).values({
            id: generationId,
            workspaceId: row.workspace_id,
            ordinal,
            checkpointId,
            state: "queued",
            requestedAt: now,
            createdAt: now,
            updatedAt: now,
          });
      const commonMutations = [
        db
          .update(workshopWorkspaces)
          .set({
            state: "recovering",
            currentGenerationId: generationId,
            lastCheckpointId: checkpointId,
            recoveryMessage: message,
            updatedAt: now,
          })
          .where(
            and(
              eq(workshopWorkspaces.id, row.workspace_id),
              eq(workshopWorkspaces.currentGenerationId, row.generation_id),
            ),
          ),
        db
          .update(workshopSessionMembers)
          .set({
            provisionState: "queued",
            provisionError: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(workshopSessionMembers.sessionId, row.session_id),
              eq(workshopSessionMembers.userId, row.user_id),
            ),
          ),
        db
          .insert(workshopEvents)
          .values({
            id: workshopGenerationEventId("host-recovery", generationId),
            organizationId: row.organization_id,
            sessionId: row.session_id,
            actorUserId: null,
            type: "workspace.host_failure_recovery_requested",
            payloadJson: {
              workspaceId: row.workspace_id,
              failedHostId: input.hostId,
              checkpointId,
              generationId,
              lostWorkWarning: message,
            },
            createdAt: now,
          })
          .onConflictDoNothing(),
      ] as const;
      if (reusableGeneration) {
        const results = await db.batch([
          resetOrInsertGeneration,
          ...commonMutations,
        ]);
        if (results[0].meta.changes !== 1) {
          throw appError(
            409,
            "workshop_recovery_request_stale",
            "the pending failed-host recovery changed before it could be retried",
          );
        }
      } else {
        await db.batch([
          db
            .update(workshopWorkspaceGenerations)
            .set({
              state: "archiving",
              archiveRequestedAt: now,
              updatedAt: now,
            })
            .where(eq(workshopWorkspaceGenerations.id, row.generation_id)),
          resetOrInsertGeneration,
          ...commonMutations,
        ]);
      }
      await revokeWorkshopWorkspaceRoutes({
        workspaceId: row.workspace_id,
        terminalRouteUsernames: jsonStrings(row.terminal_route_usernames_json),
        applicationRouteIds: jsonStrings(row.application_route_ids_json),
        now,
      });
      const request: WorkshopProvisioningRequest = {
        organizationId: row.organization_id,
        sessionId: row.session_id,
        templateRevisionId: row.template_revision_id,
        participantUserId: row.user_id,
        workspaceId: row.workspace_id,
        generationId,
        generationOrdinal: ordinal,
        checkpointId,
        manifest: context.manifest,
      };
      const execution = await provisionWorkshopRequest(request, {
        excludedHostIds: [input.hostId],
        recoveryMessage: message,
      });
      outcomes.push({
        generationId,
        participantUserId: row.user_id,
        ok: true,
        runtimeExecutionId: execution.executionId,
        ...(execution.hostId ? { hostId: execution.hostId } : {}),
      });
    } catch (error) {
      outcomes.push({
        generationId: attemptedGenerationId,
        participantUserId: row.user_id,
        ok: false,
        error: errorMessage(error),
      });
    }
  }
  return outcomes;
}

export async function revokeWorkshopWorkspaceRoutes(input: {
  workspaceId: string;
  terminalRouteUsernames: readonly string[];
  applicationRouteIds: readonly string[];
  now?: number;
}): Promise<void> {
  const [intentCleanup, recordedRouteCleanup] = await Promise.allSettled([
    revokeWorkshopRouteIssuanceIntents({ workspaceId: input.workspaceId }),
    Promise.all([
      ...input.terminalRouteUsernames.map((route) => deleteStargateRoute(route)),
      ...input.applicationRouteIds.map((route) =>
        deleteStargateWorkspaceAppRoute(route),
      ),
    ]),
  ]);
  if (recordedRouteCleanup.status === "rejected") {
    throw recordedRouteCleanup.reason;
  }
  const now = input.now ?? Date.now();
  const db = workshopDb();
  await db.batch([
    db
      .update(workshopWorkspaces)
      .set({
        terminalRouteUsernamesJson: [],
        applicationRouteIdsJson: [],
        updatedAt: now,
      })
      .where(eq(workshopWorkspaces.id, input.workspaceId)),
    db
      .update(workshopAssistGrants)
      .set({ terminalRouteUsernamesJson: [], updatedAt: now })
      .where(eq(workshopAssistGrants.workspaceId, input.workspaceId)),
  ]);
  if (intentCleanup.status === "rejected") throw intentCleanup.reason;
}

export async function markRuntimeExecutionDesiredAbsent(
  executionId: string,
  now = Date.now(),
): Promise<void> {
  const execution = await env.DB.prepare(
    "SELECT host_id FROM runtime_executions WHERE id = ?",
  )
    .bind(executionId)
    .first<{ host_id: string | null }>();
  if (!execution?.host_id) return;
  const vms = await env.DB.prepare(
    "SELECT runtime_vm_name FROM runtime_vms WHERE execution_id = ?",
  )
    .bind(executionId)
    .all<{ runtime_vm_name: string }>();
  await mutateStoredHostDesiredState(
    drizzle(env.DB),
    execution.host_id,
    now,
    (draft) => {
      for (const vm of vms.results) {
        markDesiredVmAbsent(draft, {
          runId: executionId,
          vmName: vm.runtime_vm_name,
        });
      }
    },
  );
}

interface SourceGeneration {
  generationId: string;
  executionId: string;
  ordinal: number;
}

async function loadPreviousRuntimeGeneration(
  request: WorkshopProvisioningRequest,
): Promise<SourceGeneration | null> {
  return env.DB.prepare(
    `SELECT id AS generation_id, runtime_execution_id, ordinal
     FROM workshop_workspace_generations
     WHERE workspace_id = ?
       AND ordinal < ?
       AND runtime_execution_id IS NOT NULL
     ORDER BY ordinal DESC
     LIMIT 1`,
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

async function loadCurrentGenerationRuntime(
  request: WorkshopProvisioningRequest,
): Promise<{ executionId: string } | null> {
  return env.DB.prepare(
    `SELECT generation.runtime_execution_id
     FROM workshop_workspace_generations generation
     INNER JOIN workshop_workspaces workspace
       ON workspace.id = generation.workspace_id
      AND workspace.current_generation_id = generation.id
     WHERE generation.id = ?
       AND generation.workspace_id = ?
       AND generation.ordinal = ?
       AND generation.runtime_execution_id IS NOT NULL`,
  )
    .bind(request.generationId, request.workspaceId, request.generationOrdinal)
    .first<{ runtime_execution_id: string }>()
    .then((row) => (row ? { executionId: row.runtime_execution_id } : null));
}

async function loadRuntimeHandle(
  executionId: string,
): Promise<RuntimeExecutionHandle> {
  const execution = await env.DB.prepare(
    `SELECT
       id, user_id, organization_id, host_id, domain_kind, domain_id,
       generation, source_execution_id, checkpoint_id, state,
       lease_expires_at, created_at
     FROM runtime_executions WHERE id = ?`,
  )
    .bind(executionId)
    .first<{
      id: string;
      user_id: string;
      organization_id: string | null;
      host_id: string | null;
      domain_kind: "scenario" | "workshop";
      domain_id: string;
      generation: number;
      source_execution_id: string | null;
      checkpoint_id: string | null;
      state: RuntimeExecutionHandle["state"];
      lease_expires_at: number | null;
      created_at: number;
    }>();
  if (!execution) {
    throw appError(
      404,
      "runtime_execution_not_found",
      "runtime execution not found",
    );
  }
  const vms = await env.DB.prepare(
    `SELECT
       id, vm_id, ordinal, runtime_vm_name, image_key_json, image_sha256,
       cpu_millis, memory_mib, disk_mib
     FROM runtime_vms WHERE execution_id = ? ORDER BY ordinal ASC`,
  )
    .bind(execution.id)
    .all<{
      id: string;
      vm_id: string;
      ordinal: number;
      runtime_vm_name: string;
      image_key_json: string | object;
      image_sha256: string;
      cpu_millis: number;
      memory_mib: number;
      disk_mib: number;
    }>();
  const mapped = vms.results.map((vm) => ({
    vmId: vm.vm_id,
    ordinal: vm.ordinal,
    runtimeVmName: vm.runtime_vm_name,
    imageKey:
      typeof vm.image_key_json === "string"
        ? (JSON.parse(vm.image_key_json) as object)
        : vm.image_key_json,
    imageSha256: vm.image_sha256,
    cpuMillis: vm.cpu_millis,
    memoryMib: vm.memory_mib,
    diskMib: vm.disk_mib,
    runtimeVmId: vm.id,
  }));
  return {
    executionId: execution.id,
    userId: execution.user_id,
    organizationId: execution.organization_id,
    hostId: execution.host_id,
    domainKind: execution.domain_kind,
    domainId: execution.domain_id,
    generation: execution.generation,
    sourceExecutionId: execution.source_execution_id,
    checkpointId: execution.checkpoint_id,
    state: execution.state,
    leaseExpiresAt: execution.lease_expires_at,
    createdAt: execution.created_at,
    vms: mapped,
    resources: {
      cpuMillis: mapped.reduce((sum, vm) => sum + vm.cpuMillis, 0),
      memoryMib: mapped.reduce((sum, vm) => sum + vm.memoryMib, 0),
      worstCaseDiskMib: mapped.reduce((sum, vm) => sum + vm.diskMib, 0),
    },
  };
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
    checkpoint.vmImages.map((image) => [image.vmId, image]),
  );
  return request.manifest.workspace.vms.map((vm, ordinal) => {
    const image = images.get(vm.id);
    if (!image) {
      throw appError(
        409,
        "workshop_checkpoint_incomplete",
        `checkpoint ${request.checkpointId} has no image for VM ${vm.id}`,
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

function desiredWorkshopVm(
  execution: RuntimeExecutionHandle,
  vm: RuntimeExecutionHandle["vms"][number],
  publicKeyOpenssh: string,
  leaseExpiresAt: number,
): DesiredVmV2 {
  const imageKey = vm.imageKey as Partial<DesiredVmV2["image_key"]>;
  if (
    typeof imageKey.scenario !== "string" ||
    typeof imageKey.vm !== "string" ||
    (imageKey.arch !== "x86_64" && imageKey.arch !== "aarch64")
  ) {
    throw appError(
      409,
      "workshop_checkpoint_image_invalid",
      `runtime image for VM ${vm.vmId} is invalid`,
    );
  }
  return {
    run_id: execution.executionId,
    vm_name: vm.runtimeVmName,
    desired_phase: "running",
    image_key: {
      scenario: imageKey.scenario,
      vm: imageKey.vm,
      arch: imageKey.arch,
    },
    image_sha256: vm.imageSha256,
    resources: {
      cpu_millis: vm.cpuMillis,
      vcpu_count: Math.max(1, Math.ceil(vm.cpuMillis / 1_000)),
      memory_mib: vm.memoryMib,
      disk_mib: vm.diskMib,
    },
    ssh_authorized_keys_openssh: [publicKeyOpenssh],
    lease_expires_at_unix_ms: leaseExpiresAt,
  };
}

async function validateProvisioningRequest(
  request: WorkshopProvisioningRequest,
  now: number,
): Promise<{ scheduledStartAt: number }> {
  const row = await env.DB.prepare(
    `SELECT session.scheduled_start_at
     FROM workshop_sessions session
     INNER JOIN workshop_workspaces workspace ON workspace.session_id = session.id
     INNER JOIN workshop_workspace_generations generation
       ON generation.workspace_id = workspace.id
     INNER JOIN workshop_session_members roster
       ON roster.session_id = session.id AND roster.user_id = workspace.user_id
     INNER JOIN member organization_member
       ON organization_member.organization_id = session.organization_id
      AND organization_member.user_id = workspace.user_id
     WHERE session.id = ?
       AND session.organization_id = ?
       AND session.template_revision_id = ?
       AND session.state IN ('lobby', 'live')
       AND workspace.id = ?
       AND workspace.user_id = ?
       AND workspace.state NOT IN ('ending', 'ended')
       AND workspace.current_generation_id = ?
       AND generation.id = ?
       AND generation.ordinal = ?
       AND generation.checkpoint_id = ?
       AND generation.state NOT IN ('archiving', 'archived')
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
  if (!row) {
    throw appError(
      409,
      "workshop_provisioning_request_stale",
      "workshop provisioning request is stale or no longer authorized",
    );
  }
  if (!Number.isSafeInteger(now) || now < 0) {
    throw appError(500, "workshop_clock_invalid", "invalid workshop clock");
  }
  return { scheduledStartAt: row.scheduled_start_at };
}

async function assertWorkshopProvisioningFence(
  request: WorkshopProvisioningRequest,
  executionId: string,
): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT 1 AS authorized
     FROM workshop_sessions session
     INNER JOIN workshop_workspaces workspace ON workspace.session_id = session.id
     INNER JOIN workshop_workspace_generations generation
       ON generation.workspace_id = workspace.id
     INNER JOIN workshop_session_members roster
       ON roster.session_id = session.id AND roster.user_id = workspace.user_id
     INNER JOIN member organization_member
       ON organization_member.organization_id = session.organization_id
      AND organization_member.user_id = workspace.user_id
     INNER JOIN runtime_executions execution
       ON execution.id = generation.runtime_execution_id
     WHERE session.id = ?
       AND session.organization_id = ?
       AND session.template_revision_id = ?
       AND session.state IN ('lobby', 'live')
       AND workspace.id = ?
       AND workspace.user_id = ?
       AND workspace.state NOT IN ('ending', 'ended')
       AND workspace.current_generation_id = ?
       AND generation.id = ?
       AND generation.ordinal = ?
       AND generation.checkpoint_id = ?
       AND generation.state NOT IN ('archiving', 'archived')
       AND roster.role = 'participant'
       AND organization_member.workshop_access_revoking_at IS NULL
       AND generation.runtime_execution_id = ?
       AND execution.domain_kind = 'workshop'
       AND execution.domain_id = workspace.id
       AND execution.generation = generation.ordinal
       AND execution.state NOT IN ('archived', 'failed')
     LIMIT 1`,
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
      executionId,
    )
    .first<{ authorized: number }>();
  if (!row) {
    throw appError(
      409,
      "workshop_provisioning_request_stale",
      "workshop provisioning authorization changed while the runtime was starting",
    );
  }
}

function workshopProvisioningDesiredStateWriteGuard(
  request: WorkshopProvisioningRequest,
  executionId: string,
): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM workshop_sessions session
    INNER JOIN workshop_workspaces workspace
      ON workspace.session_id = session.id
    INNER JOIN workshop_workspace_generations generation
      ON generation.workspace_id = workspace.id
    INNER JOIN workshop_session_members roster
      ON roster.session_id = session.id
     AND roster.user_id = workspace.user_id
    INNER JOIN member organization_member
      ON organization_member.organization_id = session.organization_id
     AND organization_member.user_id = workspace.user_id
    INNER JOIN runtime_executions execution
      ON execution.id = generation.runtime_execution_id
    WHERE session.id = ${request.sessionId}
      AND session.organization_id = ${request.organizationId}
      AND session.template_revision_id = ${request.templateRevisionId}
      AND session.state IN ('lobby', 'live')
      AND workspace.id = ${request.workspaceId}
      AND workspace.user_id = ${request.participantUserId}
      AND workspace.state NOT IN ('ending', 'ended')
      AND workspace.current_generation_id = ${request.generationId}
      AND generation.id = ${request.generationId}
      AND generation.ordinal = ${request.generationOrdinal}
      AND generation.checkpoint_id = ${request.checkpointId}
      AND generation.state NOT IN ('archiving', 'archived')
      AND roster.role = 'participant'
      AND organization_member.workshop_access_revoking_at IS NULL
      AND generation.runtime_execution_id = ${executionId}
      AND execution.domain_kind = 'workshop'
      AND execution.domain_id = workspace.id
      AND execution.generation = generation.ordinal
      AND execution.state NOT IN ('archived', 'failed')
  )`;
}

async function workshopProvisioningSessionIsTerminal(
  request: WorkshopProvisioningRequest,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT state
     FROM workshop_sessions
     WHERE id = ? AND organization_id = ? AND template_revision_id = ?`,
  )
    .bind(request.sessionId, request.organizationId, request.templateRevisionId)
    .first<{ state: string }>();
  return row?.state === "ended" || row?.state === "cancelled";
}

async function bestEffortArchiveWorkshopGeneration(
  request: WorkshopProvisioningRequest,
  execution: RuntimeExecutionHandle | null,
  now: number,
): Promise<void> {
  try {
    await recordWorkshopGenerationState({
      generationId: request.generationId,
      update: {
        state: "archived",
        ...(execution
          ? {
              runtimeExecutionId: execution.executionId,
              hostId: execution.hostId,
            }
          : {}),
        observedAt: now,
      },
    });
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "workshop_terminal_provisioning_race_cleanup_failed",
        sessionId: request.sessionId,
        workspaceId: request.workspaceId,
        generationId: request.generationId,
        executionId: execution?.executionId ?? null,
        error: errorMessage(error),
      }),
    );
  }
}

async function latestApplicableCheckpoint(input: {
  sessionId: string;
  userId: string;
  manifest: WorkshopManifestV1;
  fallbackCheckpointId: string;
}): Promise<string> {
  const completed = await workshopDb()
    .select({
      moduleId: workshopModuleProgress.moduleId,
      technicalStatus: workshopModuleProgress.technicalStatus,
    })
    .from(workshopModuleProgress)
    .where(
      and(
        eq(workshopModuleProgress.sessionId, input.sessionId),
        eq(workshopModuleProgress.userId, input.userId),
        inArray(workshopModuleProgress.technicalStatus, [
          "verified",
          "caught_up",
          "manually_completed",
        ]),
      ),
    );
  const completedIds = new Set(completed.map((row) => row.moduleId));
  let checkpointId = input.fallbackCheckpointId;
  for (const module of input.manifest.modules) {
    if (!completedIds.has(module.id)) break;
    if (module.catchUpCheckpointId) checkpointId = module.catchUpCheckpointId;
  }
  return checkpointId;
}

async function bestEffortRuntimeCleanup(
  execution: RuntimeExecutionHandle,
  now: number,
) {
  try {
    await markRuntimeExecutionDesiredAbsent(execution.executionId, now);
  } catch {
    // The desired-state reconciler will retry cleanup from the persisted execution.
  }
  try {
    await archiveRuntimeExecution({
      executionId: execution.executionId,
      expectedGeneration: execution.generation,
      endedAt: now,
    });
  } catch {
    // Preserve the original provisioning error; teardown can be retried by session cleanup.
  }
}

async function commitRuntimeResourceReservation(
  execution: RuntimeExecutionHandle,
): Promise<void> {
  const hostId = requiredHost(execution);
  const committedAt = Date.now();
  const result = await env.DB.prepare(
    `UPDATE host_resource_reservations
     SET state = 'committed', expires_at = NULL, updated_at = ?
     WHERE execution_id = ?
       AND host_id = ?
       AND released_at IS NULL
       AND (
         state = 'committed'
         OR (
           state = 'pending'
           AND (expires_at IS NULL OR expires_at > ?)
         )
       )`,
  )
    .bind(committedAt, execution.executionId, hostId, committedAt)
    .run();
  if (result.meta.changes !== 1) {
    throw appError(
      409,
      "runtime_resource_reservation_expired",
      "runtime resource reservation expired before provisioning was committed",
    );
  }
}

async function failWorkshopGeneration(
  request: WorkshopProvisioningRequest,
  message: string,
  now: number,
) {
  try {
    await recordWorkshopGenerationState({
      generationId: request.generationId,
      update: { state: "failed", error: message, observedAt: now },
    });
  } catch (error) {
    if (
      !(
        error instanceof AppError && error.code === "workshop_generation_stale"
      ) &&
      !errorChainMatches(error, /workshop_generation_stale/)
    ) {
      throw error;
    }
  }
}

function requiredHost(execution: RuntimeExecutionHandle): string {
  if (!execution.hostId) {
    throw appError(
      409,
      "workshop_runtime_host_missing",
      "workshop runtime was not allocated to a runner",
    );
  }
  return execution.hostId;
}

function runtimeNamePart(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return normalized || "vm";
}

function jsonStrings(value: string | string[]): string[] {
  if (Array.isArray(value))
    return value.filter((item) => typeof item === "string");
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "workshop runtime provisioning failed";
}

function workshopGenerationEventId(kind: string, generationId: string): string {
  return `workshop-${kind}-${generationId}`;
}
