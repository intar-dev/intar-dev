import { env } from "cloudflare:workers";
import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import { AppError, appError, errorChainMatches } from "@/lib/app-error";
import {
  bootCpuReservationForSteadyVms,
  strictCpuCapacity,
} from "@/control-plane/host-cpu-reservations";
import {
  agentHosts,
  accessAllowlist,
  hostActualState,
  scenarioRuns,
  scenarioRunSshKeys,
} from "@/db/schema";
import type { BetaAdmissionEpoch } from "@/lib/allowlist";
import {
  desiredVmFromRunVm,
  markDesiredVmAbsent,
  upsertDesiredCachedImage,
  upsertDesiredVm,
} from "@/lib/desired-state";
import { mutateStoredHostDesiredState } from "@/lib/desired-state-store";
import { hostHealth } from "@/lib/host-health";
import {
  commitHostCpu,
  reserveHostCpu,
  rollbackHostCpu,
} from "@/lib/host-cpu-reservation-client";
import { createAppId } from "@/lib/id";
import {
  availableRuntimeHostResources,
  loadActiveRuntimeResourceSnapshot,
  RUNTIME_PENDING_RESOURCE_RESERVATION_TTL_MS,
  runtimeResourcesFit,
  type RuntimeResourceDemand,
} from "@/lib/runtime-capacity";
import {
  runtimeCapacityAllocationKey,
  withRuntimeAllocationLock,
} from "@/lib/runtime-allocation-lock";
import {
  createRuntimeExecution,
  updateRuntimeExecutionState,
  type RuntimeVmSpec,
} from "@/lib/runtime-executions";
import { revokeAllRoutes } from "@/lib/route-revocation";
import {
  RUN_PHASE_ORDER,
  buildInitialVmState,
  buildInitialRunState,
  recomputeRunState,
  type RunStateDocument,
  type RunVmStateDocument,
} from "@/lib/run-state";
import {
  hostHasImagesReady,
  imageKeyIdentity,
  type RequiredScenarioImage,
} from "@/lib/scenario-host-readiness";
import {
  isAvailableScenarioLaunchHost,
  isFreshHostHeartbeat,
  isScenarioLaunchHost,
} from "@/lib/scenario-hosts";
import { deleteStargateRoute, stargateRouteTtlMs } from "@/lib/stargate";
import {
  generateScenarioRunSshKeyDraft,
  prepareScenarioRunSshKeyRows,
} from "@/lib/scenario-run-ssh-keys";
import {
  loadEnabledScenarioRows,
  loadActiveRunRow,
  activeRunConflictError,
  activeKeyFor,
  parseRunState,
} from "./storage";
import { deterministicRuntimeVmName } from "./runtime-vm-name";

export { deterministicRuntimeVmName } from "./runtime-vm-name";

export const HOST_HEARTBEAT_TTL_MS = 90_000;

export type HostSelectionResult =
  | { ok: true; hostIds: string[] }
  | {
      ok: false;
      reason: "unavailable" | "image_not_ready" | "resource_capacity";
    };

export type ScenarioRouteType = "browser" | "native_profile_keys";

export async function startScenarioRunInternal(params: {
  scenarioId: string;
  userId: string;
  betaAdmission: BetaAdmissionEpoch;
  organizationId?: string | null;
  hostId?: string;
}): Promise<{
  accepted: true;
  runId: string;
  scenarioId: string;
  acceptedAt: number;
  reused: boolean;
}> {
  const organizationId = params.organizationId ?? null;
  const [[scenario], active] = await Promise.all([
    loadEnabledScenarioRows(params.scenarioId, organizationId),
    loadActiveRunRow(params.userId),
  ]);
  if (!scenario) {
    throw appError(404, "scenario_not_found", "scenario not found");
  }
  await assertScenarioStartAdmission(params.userId, params.betaAdmission);
  if (active) {
    if (
      active.scenarioId === scenario.scenarioId &&
      active.organizationId === organizationId
    ) {
      if (params.hostId && active.hostId !== params.hostId) {
        throw appError(
          409,
          "scenario_run_host_conflict",
          "the active scenario run is assigned to a different host",
        );
      }
      await assertScenarioStartAdmission(params.userId, params.betaAdmission);
      return {
        accepted: true,
        runId: active.runId,
        scenarioId: active.scenarioId,
        acceptedAt: Date.now(),
        reused: true,
      };
    }
    throw activeRunConflictError(active.title);
  }

  const runId = createAppId();
  const createdAt = Date.now();
  const requiredImages = requiredImagesForScenarioLaunch(scenario.launchSpecs);
  const steadyCpuMillisByVm = scenario.launchSpecs.map(
    (spec) => spec.resources.cpuMillis,
  );
  const steadyCpuMillis = steadyCpuMillisByVm.reduce(
    (total, cpuMillis) => total + cpuMillis,
    0,
  );
  if (!Number.isSafeInteger(steadyCpuMillis) || steadyCpuMillis <= 0) {
    throw appError(
      500,
      "scenario_catalog_invalid",
      "scenario CPU entitlement is invalid",
    );
  }
  const runVmStates = scenario.launchSpecs.map((spec, index) => {
    const vmId = createAppId();
    const runtimeVmName = deterministicRuntimeVmName(
      spec.runtimeVmNamePrefix,
      runId,
      index,
    );
    const vm = buildInitialVmState({
      id: vmId,
      ordinal: index,
      scenarioVmId: spec.scenarioVmId,
      scenarioVmName: spec.scenarioVmName,
      runtimeVmName,
      hostname: spec.hostname,
      launchSummary: spec.summary,
    });
    return {
      ...vm,
      provisioning: {
        ...vm.provisioning,
        image: spec.image,
        imageKey: spec.imageKey,
        imageSha256: spec.imageSha256,
        resources: spec.resources,
        leaseDurationSeconds: spec.leaseDurationSeconds,
        status: "pending",
      },
    } satisfies RunVmStateDocument;
  });
  const sshKeyDrafts = runVmStates.map((vm) =>
    generateScenarioRunSshKeyDraft({
      runId,
      vmId: vm.id,
      runtimeVmName: vm.runtimeVmName,
    }),
  );
  const sshAuthorizedKeysByVmId = new Map(
    sshKeyDrafts.map((draft) => [draft.vmId, [draft.publicKeyOpenssh]]),
  );
  const sshKeyRowsPromise = prepareScenarioRunSshKeyRows(
    sshKeyDrafts,
    createdAt,
  ).then(
    (rows) => ({ ok: true as const, rows }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  const initial = buildInitialRunState({
    vms: runVmStates.map((vm) => ({
      id: vm.id,
      ordinal: vm.ordinal,
      scenarioVmId: vm.scenarioVmId,
      scenarioVmName: vm.scenarioVmName,
      runtimeVmName: vm.runtimeVmName,
      hostname: vm.hostname,
      launchSummary: vm.launchSummary,
    })),
  });
  const state = recomputeRunState({
    ...initial,
    phase: "provisioning",
    phaseTitle: "Provisioning",
    phaseDetail: "Queueing launch delivery.",
    vms: runVmStates,
  });

  const provisionedState = recomputeRunState({
    ...state,
    vms: state.vms.map(
      (vm) =>
        ({
          ...vm,
          provisioning: {
            ...vm.provisioning,
            status: "queued",
            error: null,
          },
        }) satisfies RunVmStateDocument,
    ),
  });
  const runtimeVms = runtimeVmSpecsFromScenarioState(provisionedState);
  const leaseDurationSeconds = Math.max(
    0,
    ...provisionedState.vms.map(
      (vm) => vm.provisioning.leaseDurationSeconds ?? 0,
    ),
  );
  const runtimeReservationResources = scenarioRuntimeReservationResources(
    runtimeVms,
    steadyCpuMillisByVm,
  );
  let hostId: string | null = null;
  let runtimeCreated = false;
  let runInserted = false;
  try {
    const allocated = await allocateScenarioRuntime({
      scenarioId: scenario.scenarioId,
      runId,
      userId: params.userId,
      organizationId,
      ...(params.hostId ? { requestedHostId: params.hostId } : {}),
      requiredImages,
      steadyCpuMillisByVm,
      reservationResources: runtimeReservationResources,
      runtimeVms,
      leaseExpiresAt:
        leaseDurationSeconds > 0
          ? createdAt + leaseDurationSeconds * 1_000
          : null,
      now: createdAt,
    });
    hostId = allocated.hostId;
    runtimeCreated = true;
    const preparedSshKeys = await sshKeyRowsPromise;
    if (!preparedSshKeys.ok) {
      throw preparedSshKeys.error;
    }
    const sshKeyRows = preparedSshKeys.rows;
    if (sshKeyRows.length === 0) {
      throw new Error("scenario run has no SSH key rows");
    }
    const runInsert = {
      runId,
      userId: params.userId,
      organizationId,
      runtimeExecutionId: runId,
      hostId,
      scenarioId: scenario.scenarioId,
      scenarioName: scenario.scenarioId,
      title: scenario.briefing.title,
      tagline: scenario.briefing.tagline,
      briefingMarkdown: scenario.briefing.briefingMarkdown,
      objectivesJson: JSON.stringify(scenario.briefing.objectives),
      difficulty: scenario.briefing.difficulty,
      estimatedMinutes: scenario.briefing.estimatedMinutes,
      tagsJson: scenario.content.tags,
      hintsJson: scenario.content.hints,
      solutionMarkdown: scenario.content.solutionMarkdown,
      revealedHintsJson: [],
      solutionRevealedAt: null,
      solutionAssisted: false,
      vmCount: provisionedState.vms.length,
      state: provisionedState.phase,
      stateRank: RUN_PHASE_ORDER[provisionedState.phase],
      activeKey: activeKeyFor(params.userId),
      stateJson: JSON.stringify(provisionedState),
      deleteRequestedAt: null,
      completedAt: null,
      solvedAt: null,
      failedAt: null,
      hiddenAt: null,
      createdAt,
      updatedAt: createdAt,
    } satisfies typeof scenarioRuns.$inferInsert;
    await insertScenarioRunForAdmission({
      row: runInsert,
      sshKeyRows,
      betaAdmission: params.betaAdmission,
    });
    runInserted = true;
    await upsertRunVmsIntoDesiredState({
      hostId,
      runId,
      userId: params.userId,
      betaAdmission: params.betaAdmission,
      vms: provisionedState.vms,
      nowUnixMs: createdAt,
      sshAuthorizedKeysByVmId,
    });
    await updateRuntimeExecutionState({
      executionId: runId,
      expectedGeneration: 1,
      state: "provisioning",
      observedAt: createdAt,
    });
    const committedReservation = await env.DB.prepare(
      `UPDATE host_resource_reservations
       SET state = 'committed', expires_at = NULL, updated_at = ?
       WHERE execution_id = ? AND host_id = ? AND state = 'pending'
         AND EXISTS (
           SELECT 1
           FROM access_allowlist access
           INNER JOIN scenario_runs run
             ON run.user_id = access.user_id AND run.run_id = ?
           WHERE access.user_id = ?
             AND access.state = 'active'
             AND access.source_invite_id = ?
             AND access.source_lease_id = ?
             AND access.granted_at = ?
             AND run.state = 'provisioning'
             AND run.delete_requested_at IS NULL
         )`,
    )
      .bind(
        createdAt,
        runId,
        hostId,
        runId,
        params.userId,
        params.betaAdmission.sourceInviteId,
        params.betaAdmission.sourceLeaseId,
        params.betaAdmission.grantedAt,
      )
      .run();
    if (committedReservation.meta.changes !== 1) {
      throw scenarioStartAdmissionChanged();
    }
    await commitHostCpu({ hostId, runId });
    // Keep this inside rollback coverage. The guarded run/desired-state writes
    // close the two D1 orderings; this final check catches any later stale work.
    await assertScenarioStartWriteFence({
      userId: params.userId,
      runId,
      betaAdmission: params.betaAdmission,
    });
  } catch (error) {
    await rollbackScenarioStartAfterFailure({
      hostId,
      runId,
      userId: params.userId,
      betaAdmission: params.betaAdmission,
      vms: provisionedState.vms,
      runInserted,
      runtimeCreated,
    });
    // Two concurrent starts race past the pre-check; the unique index on
    // active_key rejects the loser.
    if (isActiveKeyUniqueViolation(error)) {
      throw activeRunConflictError();
    }
    if (error instanceof AppError && error.code === "runtime_allocation_busy") {
      throw bootCapacityPendingError({ scenarioId: scenario.scenarioId });
    }
    throw error;
  }

  return {
    accepted: true,
    runId,
    scenarioId: scenario.scenarioId,
    acceptedAt: createdAt,
    reused: false,
  };
}

/** @internal Exported for adversarial D1-boundary tests. */
export async function insertScenarioRunForAdmission(input: {
  row: typeof scenarioRuns.$inferInsert;
  sshKeyRows: Array<typeof scenarioRunSshKeys.$inferInsert>;
  betaAdmission: BetaAdmissionEpoch;
}): Promise<void> {
  const row = input.row;
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO scenario_runs (
         run_id, user_id, organization_id, runtime_execution_id, host_id,
         scenario_id, scenario_name, title, tagline, briefing_markdown,
         objectives_json, difficulty, estimated_minutes, tags_json,
         hints_json, solution_markdown, revealed_hints_json,
         solution_revealed_at, solution_assisted, vm_count, state, state_rank,
         active_key, state_json, delete_requested_at, solved_at, completed_at,
         failed_at, hidden_at, created_at, updated_at
       )
       SELECT
         ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
         ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26,
         ?27, ?28, ?29, ?30, ?31
       FROM access_allowlist access
       WHERE access.user_id = ?2
         AND access.state = 'active'
         AND access.source_invite_id = ?32
         AND access.source_lease_id = ?33
         AND access.granted_at = ?34
       RETURNING run_id`,
    ).bind(
      row.runId,
      row.userId,
      row.organizationId ?? null,
      row.runtimeExecutionId ?? null,
      row.hostId,
      row.scenarioId,
      row.scenarioName,
      row.title,
      row.tagline,
      row.briefingMarkdown,
      row.objectivesJson,
      row.difficulty,
      row.estimatedMinutes,
      JSON.stringify(row.tagsJson),
      JSON.stringify(row.hintsJson),
      row.solutionMarkdown,
      JSON.stringify(row.revealedHintsJson ?? []),
      row.solutionRevealedAt ?? null,
      row.solutionAssisted ? 1 : 0,
      row.vmCount,
      row.state,
      row.stateRank,
      row.activeKey ?? null,
      row.stateJson,
      row.deleteRequestedAt ?? null,
      row.solvedAt ?? null,
      row.completedAt ?? null,
      row.failedAt ?? null,
      row.hiddenAt ?? null,
      row.createdAt,
      row.updatedAt,
      input.betaAdmission.sourceInviteId,
      input.betaAdmission.sourceLeaseId,
      input.betaAdmission.grantedAt,
    ),
    ...input.sshKeyRows.map((key) =>
      env.DB.prepare(
        `INSERT INTO scenario_run_ssh_keys (
           id, run_id, vm_id, runtime_vm_name, public_key_openssh,
           private_key_ciphertext_b64, private_key_iv_b64, created_at
         )
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
         FROM scenario_runs run
         INNER JOIN access_allowlist access ON access.user_id = run.user_id
         WHERE run.run_id = ?2
           AND run.run_id = ?9
           AND run.user_id = ?10
           AND access.state = 'active'
           AND access.source_invite_id = ?11
           AND access.source_lease_id = ?12
           AND access.granted_at = ?13`,
      ).bind(
        key.id,
        key.runId,
        key.vmId,
        key.runtimeVmName,
        key.publicKeyOpenssh,
        key.privateKeyCiphertextB64,
        key.privateKeyIvB64,
        key.createdAt,
        row.runId,
        row.userId,
        input.betaAdmission.sourceInviteId,
        input.betaAdmission.sourceLeaseId,
        input.betaAdmission.grantedAt,
      ),
    ),
  ];
  const [inserted] = await env.DB.batch(statements);
  if (
    !inserted?.results.some(
      (result) =>
        typeof result === "object" &&
        result !== null &&
        "run_id" in result &&
        result.run_id === row.runId,
    )
  ) {
    throw scenarioStartAdmissionChanged();
  }
}

/** @internal Exported for adversarial rollback tests. */
export async function rollbackScenarioStartAfterFailure(
  input: {
    hostId: string | null;
    runId: string;
    userId: string;
    betaAdmission: BetaAdmissionEpoch;
    vms: RunVmStateDocument[];
    runInserted: boolean;
    runtimeCreated: boolean;
  },
  dependencies: {
    markVmsAbsent?: typeof markRunVmsAbsentInDesiredState;
    rollbackCpu?: typeof rollbackHostCpu;
  } = {},
): Promise<{ durableStatePreserved: boolean }> {
  const markVmsAbsent =
    dependencies.markVmsAbsent ?? markRunVmsAbsentInDesiredState;
  const rollbackCpu = dependencies.rollbackCpu ?? rollbackHostCpu;

  if (input.hostId && input.runInserted) {
    try {
      await markVmsAbsent({
        hostId: input.hostId,
        runId: input.runId,
        vms: input.vms,
        nowUnixMs: Date.now(),
        db: drizzle(env.DB),
      });
    } catch (error) {
      // The run and runtime are the durable recovery record for both the
      // revocation worker and normal reconciliation. Deleting them while the
      // host may still desire the VMs would turn a retryable cleanup into an
      // untracked workload, especially on a shared organization runner.
      console.warn(
        JSON.stringify({
          event: "scenario_start_rollback_preserved",
          runId: input.runId,
          hostId: input.hostId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return { durableStatePreserved: true };
    }
  }

  let durableStatePreserved = false;
  if (input.runInserted) {
    const statements: D1PreparedStatement[] = [
      env.DB
        .prepare(
          `DELETE FROM scenario_runs
           WHERE run_id = ?1
             AND user_id = ?2
             AND EXISTS (
               SELECT 1 FROM access_allowlist
               WHERE user_id = ?2
                 AND state = 'active'
                 AND source_invite_id = ?3
                 AND source_lease_id = ?4
                 AND granted_at = ?5
             )`,
        )
        .bind(
          input.runId,
          input.userId,
          input.betaAdmission.sourceInviteId,
          input.betaAdmission.sourceLeaseId,
          input.betaAdmission.grantedAt,
        ),
    ];
    if (input.runtimeCreated) {
      statements.push(
        env.DB
          .prepare(
            `DELETE FROM runtime_executions
             WHERE id = ?1
               AND NOT EXISTS (
                 SELECT 1 FROM scenario_runs WHERE run_id = ?1
               )`,
          )
          .bind(input.runId),
      );
    }
    const [deletedRun] = await env.DB.batch(statements);
    durableStatePreserved = deletedRun?.meta.changes !== 1;
  } else if (input.runtimeCreated) {
    await env.DB.prepare("DELETE FROM runtime_executions WHERE id = ?1")
      .bind(input.runId)
      .run();
  }

  if (input.hostId) {
    await Promise.allSettled([
      rollbackCpu({ hostId: input.hostId, runId: input.runId }),
    ]);
  }
  return { durableStatePreserved };
}

async function assertScenarioStartAdmission(
  userId: string,
  admission: BetaAdmissionEpoch,
): Promise<void> {
  const current = await env.DB.prepare(
    `SELECT 1
     FROM access_allowlist
     WHERE user_id = ?1
       AND state = 'active'
       AND source_invite_id = ?2
       AND source_lease_id = ?3
       AND granted_at = ?4
     LIMIT 1`,
  )
    .bind(
      userId,
      admission.sourceInviteId,
      admission.sourceLeaseId,
      admission.grantedAt,
    )
    .first();
  if (!current) throw scenarioStartAdmissionChanged();
}

async function assertScenarioStartWriteFence(input: {
  userId: string;
  runId: string;
  betaAdmission: BetaAdmissionEpoch;
}): Promise<void> {
  const current = await env.DB.prepare(
    `SELECT 1
     FROM access_allowlist access
     INNER JOIN scenario_runs run
       ON run.user_id = access.user_id AND run.run_id = ?2
     WHERE access.user_id = ?1
       AND access.state = 'active'
       AND access.source_invite_id = ?3
       AND access.source_lease_id = ?4
       AND access.granted_at = ?5
       AND run.state = 'provisioning'
       AND run.delete_requested_at IS NULL
     LIMIT 1`,
  )
    .bind(
      input.userId,
      input.runId,
      input.betaAdmission.sourceInviteId,
      input.betaAdmission.sourceLeaseId,
      input.betaAdmission.grantedAt,
    )
    .first();
  if (!current) throw scenarioStartAdmissionChanged();
}

function scenarioStartAdmissionChanged() {
  return appError(
    403,
    "beta_access_revoked",
    "beta access changed while the scenario was starting",
  );
}

async function allocateScenarioRuntime(input: {
  scenarioId: string;
  runId: string;
  userId: string;
  organizationId: string | null;
  requestedHostId?: string;
  requiredImages: RequiredScenarioImage[];
  steadyCpuMillisByVm: number[];
  reservationResources: RuntimeResourceDemand;
  runtimeVms: RuntimeVmSpec[];
  leaseExpiresAt: number | null;
  now: number;
}): Promise<{ hostId: string }> {
  return withRuntimeAllocationLock({
    key: runtimeCapacityAllocationKey(input.organizationId),
    now: input.now,
    operation: async () => {
      let candidateHostIds: string[];
      if (input.requestedHostId) {
        await assertScenarioLaunchHostForUser(
          input.requestedHostId,
          input.userId,
          input.requiredImages,
          input.organizationId,
        );
        await assertScenarioRuntimeCapacity(
          input.requestedHostId,
          input.reservationResources,
          input.now,
        );
        candidateHostIds = [input.requestedHostId];
      } else {
        const selection = await selectScenarioHosts(
          input.requiredImages,
          input.organizationId,
          input.reservationResources,
          input.now,
        );
        if (!selection.ok) {
          if (selection.reason === "image_not_ready") {
            throw appError(
              409,
              "image_not_ready",
              "scenario images are not ready on any available host",
            );
          }
          throw appError(
            409,
            "scenario_host_unavailable",
            selection.reason === "resource_capacity"
              ? "no scenario host has enough CPU, memory, and worst-case disk capacity"
              : "no scenario host available",
          );
        }
        candidateHostIds = selection.hostIds;
      }

      const reservation = await reserveScenarioBootCpuWithJitter({
        hostIds: candidateHostIds,
        runId: input.runId,
        steadyCpuMillisByVm: input.steadyCpuMillisByVm,
      });
      if (!reservation.ok) {
        throw reservation.reason === "boot_capacity_pending"
          ? bootCapacityPendingError({
              scenarioId: input.scenarioId,
              ...(input.requestedHostId
                ? { hostId: input.requestedHostId }
                : {}),
            })
          : appError(
              409,
              "scenario_host_unavailable",
              input.requestedHostId
                ? "host cannot provide strict CPU isolation"
                : "no scenario host can provide strict CPU isolation",
            );
      }

      try {
        await createRuntimeExecution({
          executionId: input.runId,
          userId: input.userId,
          organizationId: input.organizationId,
          hostId: reservation.hostId,
          domainKind: "scenario",
          domainId: input.runId,
          ...(input.leaseExpiresAt !== null
            ? { leaseExpiresAt: input.leaseExpiresAt }
            : {}),
          vms: input.runtimeVms,
          claimActiveSlot: true,
          reservationState: "pending",
          reservationExpiresAt:
            input.now + RUNTIME_PENDING_RESOURCE_RESERVATION_TTL_MS,
          reservationResources: input.reservationResources,
          now: input.now,
        });
      } catch (error) {
        await Promise.allSettled([
          rollbackHostCpu({ hostId: reservation.hostId, runId: input.runId }),
        ]);
        throw error;
      }
      return { hostId: reservation.hostId };
    },
  });
}

export function scenarioRuntimeReservationResources(
  vms: RuntimeVmSpec[],
  steadyCpuMillisByVm: readonly number[],
): RuntimeResourceDemand {
  const resources = vms.reduce<RuntimeResourceDemand>(
    (total, vm) => ({
      cpuMillis: total.cpuMillis + vm.cpuMillis,
      memoryMib: total.memoryMib + vm.memoryMib,
      worstCaseDiskMib: total.worstCaseDiskMib + vm.diskMib,
    }),
    { cpuMillis: 0, memoryMib: 0, worstCaseDiskMib: 0 },
  );
  return {
    ...resources,
    cpuMillis: bootCpuReservationForSteadyVms(steadyCpuMillisByVm),
  };
}

function runtimeVmSpecsFromScenarioState(
  state: RunStateDocument,
): RuntimeVmSpec[] {
  return state.vms.map((vm) => {
    const resources = vm.provisioning.resources;
    const imageKey = vm.provisioning.imageKey;
    const imageSha256 = vm.provisioning.imageSha256?.trim() ?? "";
    if (!resources || !imageKey || !imageSha256) {
      throw appError(
        409,
        "scenario_runtime_spec_incomplete",
        `scenario VM ${vm.scenarioVmName} is missing immutable runtime metadata`,
      );
    }
    return {
      vmId: vm.id,
      ordinal: vm.ordinal,
      runtimeVmName: vm.runtimeVmName,
      imageKey,
      imageSha256,
      cpuMillis: resources.cpuMillis,
      memoryMib: resources.memoryMib,
      diskMib: resources.diskMib,
    };
  });
}

export async function assertScenarioLaunchHostForUser(
  hostId: string,
  userId: string,
  requiredImages: RequiredScenarioImage[],
  organizationId: string | null = null,
): Promise<void> {
  const now = Date.now();
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      role: agentHosts.role,
      disabled: agentHosts.disabled,
      scenarioEnabled: agentHosts.scenarioEnabled,
      connected: agentHosts.connected,
      lastHeartbeatAt: agentHosts.lastHeartbeatAt,
      actualReportedAt: hostActualState.updatedAt,
      actualReport: hostActualState.reportJson,
      organizationId: agentHosts.organizationId,
    })
    .from(agentHosts)
    .leftJoin(hostActualState, eq(hostActualState.hostId, agentHosts.id))
    .where(
      and(
        eq(agentHosts.id, hostId),
        organizationId
          ? eq(agentHosts.organizationId, organizationId)
          : and(
              eq(agentHosts.userId, userId),
              isNull(agentHosts.organizationId),
            ),
      ),
    )
    .limit(1);
  const host = rows[0];
  if (!host) {
    throw appError(404, "scenario_host_not_found", "host not found");
  }
  if (host.disabled) {
    throw appError(403, "scenario_host_disabled", "host is disabled");
  }
  if (host.role !== "agent") {
    throw appError(
      403,
      "scenario_host_not_launchable",
      "host cannot run scenarios",
    );
  }
  if (
    !isScenarioLaunchHost({
      role: host.role,
      disabled: host.disabled,
      scenarioEnabled: host.scenarioEnabled,
    })
  ) {
    throw appError(
      403,
      "scenario_host_not_launchable",
      "host cannot run scenarios",
    );
  }
  if (
    !host.connected ||
    !isFreshHostHeartbeat(host.lastHeartbeatAt, now, HOST_HEARTBEAT_TTL_MS) ||
    hostHealth(host.actualReportedAt ?? null, now) !== "healthy"
  ) {
    throw appError(409, "scenario_host_unavailable", "host is not connected");
  }
  if (!hostHasImagesReady(host.actualReport, requiredImages)) {
    throw appError(
      409,
      "image_not_ready",
      "scenario images are not ready on this host",
    );
  }
  if (strictCpuCapacity(host.actualReport) === null) {
    throw appError(
      409,
      "scenario_host_not_performance_ready",
      "host does not attest the required v2 template, boot-quota, and fast-filesystem launch path",
    );
  }
}

export const BOOT_CAPACITY_RESERVATION_ATTEMPTS = 4;

export const BOOT_CAPACITY_RETRY_MIN_MS = 15;

export const BOOT_CAPACITY_RETRY_JITTER_MS = 30;

export async function reserveScenarioBootCpuWithJitter(input: {
  hostIds: readonly string[];
  runId: string;
  steadyCpuMillisByVm: readonly number[];
}): Promise<
  | { ok: true; hostId: string }
  | { ok: false; reason: "boot_capacity_pending" | "host_unavailable" }
> {
  let sawBootCapacityPending = false;
  for (
    let attempt = 0;
    attempt < BOOT_CAPACITY_RESERVATION_ATTEMPTS;
    attempt += 1
  ) {
    for (const hostId of input.hostIds) {
      const reservation = await reserveHostCpu({
        hostId,
        runId: input.runId,
        steadyCpuMillisByVm: input.steadyCpuMillisByVm,
      });
      if (reservation.ok) {
        return { ok: true, hostId };
      }
      if (reservation.reason === "boot_capacity_pending") {
        sawBootCapacityPending = true;
        continue;
      }
      if (reservation.reason === "conflict") {
        throw new Error(`CPU reservation conflict for run ${input.runId}`);
      }
    }
    if (
      !sawBootCapacityPending ||
      attempt === BOOT_CAPACITY_RESERVATION_ATTEMPTS - 1
    ) {
      break;
    }
    await bootCapacityRetryJitter();
  }
  return {
    ok: false,
    reason: sawBootCapacityPending
      ? "boot_capacity_pending"
      : "host_unavailable",
  };
}

export async function bootCapacityRetryJitter(): Promise<void> {
  await new Promise<void>((resolve) => {
    const jitterMs =
      BOOT_CAPACITY_RETRY_MIN_MS +
      Math.floor(Math.random() * (BOOT_CAPACITY_RETRY_JITTER_MS + 1));
    setTimeout(resolve, jitterMs);
  });
}

export function bootCapacityPendingError(context?: {
  scenarioId: string;
  hostId?: string;
}) {
  console.log(
    JSON.stringify({
      event: "scenario_boot_capacity_pending",
      scenarioId: context?.scenarioId ?? null,
      hostId: context?.hostId ?? null,
    }),
  );
  return appError(
    409,
    "boot_capacity_pending",
    "scenario boot CPU capacity is pending; retry shortly",
  );
}

export function isActiveKeyUniqueViolation(error: unknown): boolean {
  if (error instanceof AppError && error.code === "runtime_active_slot_conflict") {
    return true;
  }
  return errorChainMatches(
    error,
    /UNIQUE constraint failed.*active_key|scenario_runs_active_key_uidx|active_runtime_slots|runtime_active_slot_conflict/,
  );
}

export async function upsertRunVmsIntoDesiredState(input: {
  hostId: string;
  runId: string;
  userId: string;
  betaAdmission: BetaAdmissionEpoch;
  vms: RunVmStateDocument[];
  nowUnixMs: number;
  sshAuthorizedKeysByVmId: Map<string, string[]>;
}): Promise<void> {
  const desiredVms = input.vms.map((vm) => {
    const desiredVm = desiredVmFromRunVm({
      runId: input.runId,
      vm,
      nowUnixMs: input.nowUnixMs,
      sshAuthorizedKeysOpenssh: input.sshAuthorizedKeysByVmId.get(vm.id) ?? [],
    });
    if (!desiredVm) {
      throw appError(
        500,
        "scenario_vm_desired_state_invalid",
        `missing desired-state image metadata for ${vm.runtimeVmName}`,
      );
    }
    return desiredVm;
  });

  await mutateStoredHostDesiredState(
    drizzle(env.DB),
    input.hostId,
    input.nowUnixMs,
    (draft) => {
      for (const desiredVm of desiredVms) {
        upsertDesiredCachedImage(draft, {
          image_key: desiredVm.image_key,
          image_sha256: desiredVm.image_sha256,
        });
        upsertDesiredVm(draft, desiredVm);
      }
    },
    undefined,
    {
      condition: sql`EXISTS (
        SELECT 1
        FROM ${accessAllowlist} access
        INNER JOIN ${scenarioRuns} run
          ON run.user_id = access.user_id
         AND run.run_id = ${input.runId}
        WHERE access.user_id = ${input.userId}
          AND access.state = 'active'
          AND access.source_invite_id = ${input.betaAdmission.sourceInviteId}
          AND access.source_lease_id = ${input.betaAdmission.sourceLeaseId}
          AND access.granted_at = ${input.betaAdmission.grantedAt}
          AND run.state = 'provisioning'
          AND run.delete_requested_at IS NULL
      )`,
      assertSatisfied: () =>
        assertScenarioStartWriteFence({
          userId: input.userId,
          runId: input.runId,
          betaAdmission: input.betaAdmission,
        }),
    },
  );
}

export async function markRunVmsAbsentInDesiredState(input: {
  hostId: string;
  runId: string;
  vms: RunVmStateDocument[];
  nowUnixMs: number;
  db?: DrizzleD1Database;
}): Promise<void> {
  if (!input.vms.length) {
    return;
  }

  await mutateStoredHostDesiredState(
    input.db ?? drizzle(env.DB),
    input.hostId,
    input.nowUnixMs,
    (draft) => {
      for (const vm of input.vms) {
        markDesiredVmAbsent(draft, {
          runId: input.runId,
          vmName: vm.runtimeVmName,
        });
      }
    },
  );
}

export function requiredImagesForScenarioLaunch(
  launchSpecs: Array<{
    imageKey: RequiredScenarioImage["imageKey"] | null;
    imageSha256: string | null;
  }>,
): RequiredScenarioImage[] {
  const byIdentity = new Map<string, RequiredScenarioImage>();
  for (const spec of launchSpecs) {
    const imageSha256 = spec.imageSha256?.trim() ?? "";
    if (!spec.imageKey || !imageSha256) {
      throw appError(
        409,
        "image_not_ready",
        "scenario image metadata is not ready",
      );
    }
    byIdentity.set(imageKeyIdentity(spec.imageKey), {
      imageKey: spec.imageKey,
      imageSha256,
    });
  }
  return [...byIdentity.values()];
}

export function buildRunVmRouteUsername(
  runId: string,
  vms: RunVmStateDocument[],
  vmId: string,
  routeType: ScenarioRouteType,
): string {
  const counts = new Map<string, number>();
  const aliases = new Map<string, string>();
  const runPrefix = slugifyVmAlias(runId) || runId.toLowerCase();
  const suffix = routeSuffixForType(routeType);

  for (const vm of [...vms].sort(
    (left, right) => left.ordinal - right.ordinal,
  )) {
    const baseSlug =
      slugifyVmAlias(vm.scenarioVmName) || `vm-${vm.ordinal + 1}`;
    const count = (counts.get(baseSlug) ?? 0) + 1;
    counts.set(baseSlug, count);
    const ordinalSuffix = count > 1 ? `-${count}` : "";
    aliases.set(
      vm.id,
      `${runPrefix}-${baseSlug}${ordinalSuffix}-${suffix}`.slice(0, 128),
    );
  }

  return aliases.get(vmId) ?? `${runPrefix}-vm-${suffix}`.slice(0, 128);
}

export function slugifyVmAlias(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

export function routeSuffixForType(routeType: ScenarioRouteType): string {
  switch (routeType) {
    case "browser":
      return "web";
    case "native_profile_keys":
      return "ssh-profile";
  }
}

export async function revokeScenarioRunRoutes(row: {
  runId: string;
  state: RunStateDocument;
}): Promise<void> {
  const routeUsernames = new Set(
    row.state.vms.flatMap((vm) => [
      buildRunVmRouteUsername(row.runId, row.state.vms, vm.id, "browser"),
      buildRunVmRouteUsername(
        row.runId,
        row.state.vms,
        vm.id,
        "native_profile_keys",
      ),
    ]),
  );
  await revokeAllRoutes(routeUsernames, deleteStargateRoute);
}

export async function revokeScenarioNativeProfileRoutesForUser(
  userId: string,
): Promise<void> {
  await revokeScenarioRouteTypesForUser(
    userId,
    ["native_profile_keys"],
    "active-only",
  );
}

export async function revokeScenarioRoutesForUser(
  userId: string,
  now = Date.now(),
): Promise<void> {
  await revokeScenarioRouteTypesForUser(
    userId,
    ["browser", "native_profile_keys"],
    now - stargateRouteTtlMs(),
  );
}

async function revokeScenarioRouteTypesForUser(
  userId: string,
  routeTypes: readonly ScenarioRouteType[],
  scope: "active-only" | number,
): Promise<void> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      runId: scenarioRuns.runId,
      stateJson: scenarioRuns.stateJson,
    })
    .from(scenarioRuns)
    .where(
      scope === "active-only"
        ? and(
            eq(scenarioRuns.userId, userId),
            isNull(scenarioRuns.hiddenAt),
            isNull(scenarioRuns.completedAt),
            isNull(scenarioRuns.failedAt),
          )
        : and(
            eq(scenarioRuns.userId, userId),
            or(
              and(
                isNull(scenarioRuns.completedAt),
                isNull(scenarioRuns.failedAt),
              ),
              gte(scenarioRuns.updatedAt, scope),
              gte(scenarioRuns.completedAt, scope),
              gte(scenarioRuns.failedAt, scope),
              gte(scenarioRuns.hiddenAt, scope),
            ),
          ),
    );

  const routeUsernames = new Set<string>();
  for (const row of rows) {
    const state = parseRunState(row.stateJson);
    for (const vm of state.vms) {
      for (const routeType of routeTypes) {
        routeUsernames.add(
          buildRunVmRouteUsername(row.runId, state.vms, vm.id, routeType),
        );
      }
    }
  }

  await revokeAllRoutes(routeUsernames, deleteStargateRoute);
}

export async function selectScenarioHosts(
  requiredImages: RequiredScenarioImage[],
  organizationId: string | null = null,
  requiredResources?: RuntimeResourceDemand,
  now = Date.now(),
): Promise<HostSelectionResult> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      id: agentHosts.id,
      updatedAt: agentHosts.updatedAt,
      connected: agentHosts.connected,
      lastHeartbeatAt: agentHosts.lastHeartbeatAt,
      lastInventoryAt: agentHosts.lastInventoryAt,
      actualReportedAt: hostActualState.updatedAt,
      actualReport: hostActualState.reportJson,
    })
    .from(agentHosts)
    .leftJoin(hostActualState, eq(hostActualState.hostId, agentHosts.id))
    .where(
      and(
        eq(agentHosts.disabled, false),
        eq(agentHosts.role, "agent"),
        eq(agentHosts.scenarioEnabled, true),
        eq(agentHosts.connected, true),
        organizationId
          ? eq(agentHosts.organizationId, organizationId)
          : isNull(agentHosts.organizationId),
      ),
    )
    .orderBy(desc(agentHosts.updatedAt));

  const candidates = rows
    .map((row) => {
      // The bridge v6 state report is the live source of per-host VM load
      // and capacity; the legacy inventory upload no longer exists.
      const capacity = row.actualReport?.capacity ?? null;
      const inventoryVmCount = row.actualReport?.vms?.length ?? 0;
      const cpuCores = Math.max(1, (capacity?.total_cpu_millis ?? 0) / 1000);
      const loadPerCpu =
        typeof capacity?.load_avg_1m === "number" && capacity.load_avg_1m >= 0
          ? capacity.load_avg_1m / cpuCores
          : Number.POSITIVE_INFINITY;
      return {
        ...row,
        inventoryVmCount,
        loadPerCpu,
        memoryAvailableMib: capacity?.memory_available_mib ?? -1,
        reportedFreeCpuMillis: Math.max(
          0,
          (capacity?.schedulable_cpu_millis ?? 0) -
            (capacity?.committed_cpu_millis ?? 0),
        ),
      };
    })
    .filter(
      (row) =>
        isAvailableScenarioLaunchHost(
          {
            role: "agent",
            disabled: false,
            scenarioEnabled: true,
            connected: row.connected,
            lastHeartbeatAt: row.lastHeartbeatAt,
          },
          now,
          HOST_HEARTBEAT_TTL_MS,
        ) &&
        hostHealth(row.actualReportedAt ?? null, now) === "healthy" &&
        strictCpuCapacity(row.actualReport) !== null,
    );

  if (!candidates.length) {
    return { ok: false, reason: "unavailable" };
  }

  let imageReadyCandidates = candidates.filter((candidate) =>
    hostHasImagesReady(candidate.actualReport, requiredImages),
  );

  if (!imageReadyCandidates.length) {
    return { ok: false, reason: "image_not_ready" };
  }

  const availableResourcesByHost = new Map<string, RuntimeResourceDemand>();
  if (requiredResources) {
    const snapshot = await loadActiveRuntimeResourceSnapshot(now);
    imageReadyCandidates = imageReadyCandidates.filter((candidate) => {
      if (!candidate.actualReport) return false;
      const available = availableRuntimeHostResources({
        hostId: candidate.id,
        report: candidate.actualReport,
        snapshot,
      });
      if (!available) return false;
      availableResourcesByHost.set(candidate.id, available);
      return runtimeResourcesFit(requiredResources, available);
    });
    if (!imageReadyCandidates.length) {
      return { ok: false, reason: "resource_capacity" };
    }
  }

  const activeRuns = await db
    .select({
      hostId: scenarioRuns.hostId,
    })
    .from(scenarioRuns)
    .where(
      and(
        inArray(
          scenarioRuns.hostId,
          imageReadyCandidates.map((candidate) => candidate.id),
        ),
        isNull(scenarioRuns.completedAt),
        isNull(scenarioRuns.failedAt),
      ),
    );

  const activeRunCounts = new Map<string, number>();
  for (const row of activeRuns) {
    activeRunCounts.set(row.hostId, (activeRunCounts.get(row.hostId) ?? 0) + 1);
  }

  imageReadyCandidates.sort((left, right) => {
    const leftRuns = activeRunCounts.get(left.id) ?? 0;
    const rightRuns = activeRunCounts.get(right.id) ?? 0;
    if (leftRuns !== rightRuns) {
      return leftRuns - rightRuns;
    }
    const leftAvailable = availableResourcesByHost.get(left.id);
    const rightAvailable = availableResourcesByHost.get(right.id);
    if (
      leftAvailable &&
      rightAvailable &&
      leftAvailable.cpuMillis !== rightAvailable.cpuMillis
    ) {
      return rightAvailable.cpuMillis - leftAvailable.cpuMillis;
    }
    if (left.reportedFreeCpuMillis !== right.reportedFreeCpuMillis) {
      return right.reportedFreeCpuMillis - left.reportedFreeCpuMillis;
    }
    if (left.inventoryVmCount !== right.inventoryVmCount) {
      return left.inventoryVmCount - right.inventoryVmCount;
    }
    if (left.loadPerCpu !== right.loadPerCpu) {
      return left.loadPerCpu - right.loadPerCpu;
    }
    if (left.memoryAvailableMib !== right.memoryAvailableMib) {
      return right.memoryAvailableMib - left.memoryAvailableMib;
    }
    if (left.updatedAt !== right.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    return left.id.localeCompare(right.id);
  });

  const hostIds = imageReadyCandidates.map((candidate) => candidate.id);
  return hostIds.length
    ? { ok: true, hostIds }
    : { ok: false, reason: "unavailable" };
}

async function assertScenarioRuntimeCapacity(
  hostId: string,
  requiredResources: RuntimeResourceDemand,
  now: number,
): Promise<void> {
  const db = drizzle(env.DB);
  const [actual] = await db
    .select({ report: hostActualState.reportJson })
    .from(hostActualState)
    .where(eq(hostActualState.hostId, hostId))
    .limit(1);
  const snapshot = await loadActiveRuntimeResourceSnapshot(now);
  const available = actual?.report
    ? availableRuntimeHostResources({
        hostId,
        report: actual.report,
        snapshot,
      })
    : null;
  if (!available || !runtimeResourcesFit(requiredResources, available)) {
    throw appError(
      409,
      "scenario_host_unavailable",
      "host does not have enough CPU, memory, and worst-case disk capacity",
    );
  }
}
