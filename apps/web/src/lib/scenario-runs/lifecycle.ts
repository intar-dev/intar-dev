import { env } from "cloudflare:workers";
import { and, desc, eq, isNull } from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import { appError } from "@/lib/app-error";
import type { BetaAdmissionEpoch } from "@/lib/allowlist";
import { issueBetaAccessFencedRoute } from "@/lib/beta-route-issuance";
import {
  scenarioRunArtifacts,
  scenarioRunArtifactUploads,
  scenarioRuns,
} from "@/db/schema";
import { markDesiredVmAbsent } from "@/lib/desired-state";
import {
  loadOrCreateHostDesiredState,
  mutateStoredHostDesiredState,
} from "@/lib/desired-state-store";
import { tryWakeHostRuntime } from "@/lib/host-runtime-wake";
import { deleteScenarioArtifactStorage } from "@/lib/scenario-artifact-storage";
import {
  runVmsRequiringDesiredAbsence,
  scenarioRunPurgeBlockReason,
} from "@/lib/scenario-run-cleanup";
import {
  recomputeRunState,
  runPhaseAcceptsTerminalSessions,
} from "@/lib/run-state";
import { selectOverdueRunLeases } from "@/lib/scenario-run-leases";
import {
  deleteStargateRoute,
  issueStargateTerminalSession,
  stargateRouteTtlMs,
} from "@/lib/stargate";
import { loadScenarioRunSshKey } from "@/lib/scenario-run-ssh-keys";
import { deleteScenarioRunRuntimeProjection } from "@/lib/runtime-executions";
import { listUserAuthorizedSshKeysForNativeRoutes } from "@/lib/user-ssh-keys";
import {
  type ScenarioTerminalSessionResult,
  type ScenarioRunRecord,
} from "./types";
import {
  startScenarioRunInternal,
  markRunVmsAbsentInDesiredState,
  revokeScenarioRunRoutes,
  buildRunVmRouteUsername,
} from "./start";
import {
  loadRunRow,
  updateRunState,
  loadHostTerminalAddress,
  fromDbRow,
  toScenarioRunRecord,
} from "./storage";

export async function startScenarioRunForUser(params: {
  scenarioId: string;
  userId: string;
  betaAdmission: BetaAdmissionEpoch;
  organizationId?: string | null;
  hostId?: string;
  allowDrainedAdminProof?: boolean;
  allowSequenceBypass?: boolean;
}): Promise<{
  accepted: true;
  runId: string;
  scenarioId: string;
  acceptedAt: number;
  reused: boolean;
  run: ScenarioRunRecord;
}> {
  const result = await startScenarioRunInternal(params);
  const row = await loadRunRow(result.runId, params.userId);
  if (!row) {
    throw appError(
      500,
      "scenario_run_snapshot_missing",
      "scenario run was accepted but its snapshot could not be loaded",
    );
  }
  return {
    ...result,
    run: toScenarioRunRecord(row),
  };
}

export async function destroyScenarioRunForUser(params: {
  runId: string;
  userId: string;
}) {
  return destroyScenarioRunForUserWithDependencies(params, {
    markVmsAbsent: markRunVmsAbsentInDesiredState,
    revokeRoutes: revokeScenarioRunRoutes,
    wakeHostRuntime: tryWakeHostRuntime,
  });
}

export async function destroyScenarioRunForUserWithDependencies(
  params: {
    runId: string;
    userId: string;
  },
  dependencies: {
    markVmsAbsent: typeof markRunVmsAbsentInDesiredState;
    revokeRoutes: typeof revokeScenarioRunRoutes;
    wakeHostRuntime: typeof tryWakeHostRuntime;
  },
): Promise<{
  accepted: true;
  runId: string;
  acceptedAt: number;
  activeSlotReleased: true;
  run: ScenarioRunRecord;
}> {
  const db = drizzle(env.DB);
  const row = await loadRunRow(params.runId, params.userId);
  if (!row) {
    throw appError(404, "scenario_run_not_found", "scenario run not found");
  }

  const acceptedAt = Date.now();
  const deleteRequestedAt = row.deleteRequestedAt ?? acceptedAt;
  const teardownVms = runVmsRequiringDesiredAbsence(row.state);
  if (!["completed", "failed"].includes(row.state.phase)) {
    const teardownVmIds = new Set(teardownVms.map((vm) => vm.id));
    await updateRunState(row.runId, {
      mutate: (current) =>
        recomputeRunState({
          ...current,
          phase: "teardown_requested",
          phaseTitle: "Teardown requested",
          phaseDetail: "Waiting for the host to acknowledge teardown.",
          vms: current.vms.map((vm) =>
            teardownVmIds.has(vm.id)
              ? {
                  ...vm,
                  phaseDetail: "Teardown requested. Waiting for host delivery.",
                }
              : vm,
          ),
        }),
      deleteRequestedAt,
    });
  } else {
    // Terminal outcomes keep their original scoring state while recording
    // that teardown was explicitly requested.
    await db
      .update(scenarioRuns)
      .set({
        deleteRequestedAt,
        updatedAt: acceptedAt,
      })
      .where(
        and(
          eq(scenarioRuns.runId, row.runId),
          eq(scenarioRuns.userId, params.userId),
        ),
      );
  }

  if (teardownVms.length > 0) {
    try {
      await dependencies.markVmsAbsent({
        hostId: row.hostId,
        runId: row.runId,
        vms: teardownVms,
        nowUnixMs: acceptedAt,
        db,
      });
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "scenario_run_teardown_acceptance_failed",
          stage: "desired_state",
          runId: row.runId,
          hostId: row.hostId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      throw appError(
        503,
        "scenario_teardown_desired_state_failed",
        "Workspace shutdown could not be requested. Retry ending the run.",
      );
    }
  }

  const routeRevocationFailure = await dependencies.revokeRoutes(row).then(
    () => null,
    (error: unknown) => ({ error }),
  );
  await dependencies.wakeHostRuntime(row.hostId);
  if (routeRevocationFailure) {
    console.warn(
      JSON.stringify({
        event: "scenario_run_teardown_acceptance_failed",
        stage: "route_revocation",
        runId: row.runId,
        hostId: row.hostId,
        error:
          routeRevocationFailure.error instanceof Error
            ? routeRevocationFailure.error.message
            : String(routeRevocationFailure.error),
      }),
    );
    throw appError(
      503,
      "scenario_teardown_route_revocation_failed",
      "Shell access could not be revoked. Retry ending the run.",
    );
  }

  try {
    await updateRunState(row.runId, {
      mutate: (current) => current,
      deleteRequestedAt,
      releaseActiveSlot: true,
    });
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "scenario_run_teardown_acceptance_failed",
        stage: "active_slot_release",
        runId: row.runId,
        hostId: row.hostId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    throw appError(
      503,
      "scenario_teardown_slot_release_failed",
      "Cleanup was accepted, but the active run slot could not be released. Retry ending the run.",
    );
  }

  const acceptedRow = await loadRunRow(row.runId, params.userId);
  if (!acceptedRow) {
    throw appError(
      500,
      "scenario_run_snapshot_missing",
      "scenario teardown was accepted but its snapshot could not be loaded",
    );
  }
  const run = toScenarioRunRecord(acceptedRow);
  console.log(
    JSON.stringify({
      event: "scenario_run_teardown_accepted",
      runId: row.runId,
      hostId: row.hostId,
      acceptedAt,
      deleteRequestedAt,
      vmCount: teardownVms.length,
    }),
  );

  return {
    accepted: true,
    runId: row.runId,
    acceptedAt,
    activeSlotReleased: true,
    run,
  };
}

export async function deleteFinishedScenarioRunForUser(params: {
  runId: string;
  userId: string;
}): Promise<void> {
  return deleteFinishedScenarioRun(params);
}

export async function deleteFinishedScenarioRunForAdmin(params: {
  runId: string;
  actorUserId: string;
}): Promise<void> {
  return deleteFinishedScenarioRun(params);
}

async function deleteFinishedScenarioRun(params: {
  runId: string;
  userId?: string;
  actorUserId?: string;
}): Promise<void> {
  const db = drizzle(env.DB);
  const row = await loadRunRow(params.runId, params.userId);
  if (!row) {
    throw appError(404, "scenario_run_not_found", "scenario run not found");
  }
  if (!["completed", "failed"].includes(row.state.phase)) {
    throw appError(
      409,
      "scenario_run_delete_conflict",
      "scenario run is not in a terminal state",
    );
  }
  const storageRecords = await db
    .select({
      r2Key: scenarioRunArtifacts.r2Key,
      r2UploadId: scenarioRunArtifactUploads.r2UploadId,
      uploadStatus: scenarioRunArtifacts.uploadStatus,
    })
    .from(scenarioRunArtifacts)
    .leftJoin(
      scenarioRunArtifactUploads,
      eq(scenarioRunArtifactUploads.artifactId, scenarioRunArtifacts.id),
    )
    .where(eq(scenarioRunArtifacts.runId, row.runId));
  const purgeBlockReason = scenarioRunPurgeBlockReason(
    row.state,
    storageRecords,
  );
  if (purgeBlockReason) {
    throw appError(
      409,
      "scenario_run_delete_conflict",
      purgeBlockReason === "vm_teardown_pending"
        ? "scenario run teardown is not complete"
        : "scenario run artifact uploads are not complete",
    );
  }

  await revokeScenarioRunRoutes(row);
  const storageCleanup = await deleteScenarioArtifactStorage(
    env.VM_RUN_ARTIFACTS_BUCKET,
    storageRecords,
  );
  if (storageCleanup.failedMultipartAborts > 0) {
    console.warn("scenario artifact multipart cleanup was incomplete", {
      runId: row.runId,
      failedMultipartAborts: storageCleanup.failedMultipartAborts,
    });
  }

  const adminAuditStatements = params.actorUserId
    ? [
        env.DB.prepare(
          `DELETE FROM scenario_runs
           WHERE run_id = ?1
             AND user_id = ?2
             AND hidden_at IS NULL`,
        ).bind(row.runId, row.userId),
        env.DB.prepare(
          `INSERT INTO access_events (
             id, event_type, subject_user_id, actor_user_id, run_id, reason,
             created_at
           )
           SELECT ?1, 'run.deleted_by_admin', ?2, ?3, ?4, 'admin_deleted', ?5
           WHERE changes() = 1`,
        ).bind(
          crypto.randomUUID(),
          row.userId,
          params.actorUserId,
          row.runId,
          Date.now(),
        ),
      ]
    : undefined;
  const deletion = await deleteScenarioRunRuntimeProjection({
    d1: env.DB,
    runId: row.runId,
    userId: row.userId,
    ...(adminAuditStatements ? { statements: adminAuditStatements } : {}),
  });
  if (!deletion.deleted) {
    throw appError(404, "scenario_run_not_found", "scenario run not found");
  }
}

export async function expireOverdueRunLeases(
  hostId: string,
  nowUnixMs: number,
  options?: {
    db?: DrizzleD1Database;
    wakeHostRuntime?: boolean;
  },
): Promise<{ expiredRunIds: string[] }> {
  const db = options?.db ?? drizzle(env.DB);
  const desiredState = await loadOrCreateHostDesiredState(
    db,
    hostId,
    nowUnixMs,
  );
  const overdue = selectOverdueRunLeases(desiredState, nowUnixMs);
  const expiredRunIds: string[] = [];

  for (const lease of overdue) {
    const row = await loadRunRow(lease.runId);
    const expiredVmNames = new Set(lease.vmNames);
    if (
      row &&
      row.hostId === hostId &&
      row.completedAt === null &&
      row.failedAt === null &&
      row.state.vms.some((vm) => expiredVmNames.has(vm.runtimeVmName))
    ) {
      await updateRunState(row.runId, {
        mutate: (current) =>
          recomputeRunState({
            ...current,
            phase: "failed",
            phaseDetail: "The run lease expired before teardown completed.",
            vms: current.vms.map((vm) =>
              expiredVmNames.has(vm.runtimeVmName)
                ? {
                    ...vm,
                    phase: "failed",
                    phaseDetail: "The run lease expired.",
                    terminalPhase: "failed",
                    terminalReason: "The run lease expired.",
                  }
                : vm,
            ),
          }),
        deleteRequestedAt: row.deleteRequestedAt,
      });
    }

    // Clear the expired VMs from the desired doc even when the run row is
    // missing, on another host, or already terminal: a leftover overdue lease
    // re-arms the host alarm immediately and leaves the VM running forever.
    await mutateStoredHostDesiredState(db, hostId, nowUnixMs, (draft) => {
      for (const vmName of lease.vmNames) {
        markDesiredVmAbsent(draft, { runId: lease.runId, vmName });
      }
    });
    expiredRunIds.push(lease.runId);
  }

  if (expiredRunIds.length && options?.wakeHostRuntime !== false) {
    await tryWakeHostRuntime(hostId);
  }

  return { expiredRunIds };
}

export async function createScenarioSshSessionForUser(params: {
  runId: string;
  vmId: string;
  userId: string;
  mode?: "browser" | "native";
  /**
   * A one-run public key supplied by the native SSH client. This is already
   * normalized at the HTTP boundary and is never persisted as a profile key.
   */
  clientPublicKeyOpenssh?: string;
}): Promise<ScenarioTerminalSessionResult> {
  const row = await loadRunRow(params.runId, params.userId);
  if (!row) {
    throw appError(404, "scenario_run_not_found", "scenario run not found");
  }
  if (
    !runPhaseAcceptsTerminalSessions(row.state.phase) ||
    row.completedAt !== null ||
    row.failedAt !== null
  ) {
    throw appError(
      409,
      "scenario_terminal_closed",
      "terminal sessions are closed unless the run is active",
    );
  }
  const vm = row.state.vms.find((candidate) => candidate.id === params.vmId);
  if (!vm) {
    throw appError(404, "scenario_vm_not_found", "scenario VM not found");
  }
  if (!vm.canOpenTerminal || vm.terminalPhase !== "ready") {
    throw appError(
      409,
      "scenario_shell_not_ready",
      "terminal target is still warming up",
    );
  }

  const host =
    vm.terminalTarget.host?.trim() ||
    (await loadHostTerminalAddress(row.hostId)) ||
    "";
  const port =
    typeof vm.terminalTarget.port === "number" && vm.terminalTarget.port > 0
      ? vm.terminalTarget.port
      : 0;
  const targetUsername = vm.terminalTarget.username?.trim() || "ubuntu";
  const targetHostKeyOpenssh = vm.terminalTarget.hostKeyOpenssh?.trim() ?? "";
  if (!host || !port || !targetHostKeyOpenssh) {
    throw appError(
      409,
      "scenario_shell_not_ready",
      "terminal target is still warming up",
    );
  }

  const requestedMode = params.mode ?? "browser";
  const profileKeys =
    requestedMode === "native"
      ? await listUserAuthorizedSshKeysForNativeRoutes(params.userId)
      : [];
  const temporaryClientPublicKeyOpenssh =
    params.clientPublicKeyOpenssh?.trim() || undefined;
  if (temporaryClientPublicKeyOpenssh && requestedMode !== "native") {
    throw appError(
      400,
      "native_ssh_public_key_invalid",
      "a temporary SSH key can only be used for native SSH",
    );
  }
  const usesProfileKeys =
    requestedMode === "native" &&
    !temporaryClientPublicKeyOpenssh &&
    profileKeys.length > 0;
  if (
    requestedMode === "native" &&
    !usesProfileKeys &&
    !temporaryClientPublicKeyOpenssh
  ) {
    throw appError(
      409,
      "scenario_native_ssh_key_required",
      "provide a temporary SSH key or add an SSH key to your profile before opening a native SSH route",
    );
  }
  const routeType =
    requestedMode === "browser"
      ? "browser"
      : usesProfileKeys
        ? "native_profile_keys"
        : "native_issued_key";
  const routeUsername = buildRunVmRouteUsername(
    row.runId,
    row.state.vms,
    vm.id,
    routeType,
  );
  const targetKey = await loadScenarioRunSshKey({
    runId: row.runId,
    vmId: vm.id,
  });
  return issueBetaAccessFencedRoute({
    userId: params.userId,
    routeId: routeUsername,
    revoke: deleteStargateRoute,
    issuedRouteIds: (session) => [session.routeUsername],
    issue: () =>
      issueStargateTerminalSession({
        routeUsername,
        targetUsername,
        targetHost: host,
        targetPort: port,
        targetHostKeyOpenssh,
        targetPrivateKeyOpenssh: targetKey.privateKeyOpenssh,
        expiresAt: new Date(Date.now() + stargateRouteTtlMs()),
        mode: requestedMode,
        authorizedClientPublicKeysOpenssh: usesProfileKeys
          ? profileKeys.map((key) => key.publicKeyOpenssh)
          : [],
        ...(temporaryClientPublicKeyOpenssh
          ? { temporaryClientPublicKeyOpenssh }
          : {}),
        metadata: {
          hostId: row.hostId,
          runId: row.runId,
          vmId: vm.id,
          userId: row.userId,
        },
      }),
  });
}

export async function listHostRunsForUser(params: {
  hostId: string;
  userId: string;
}): Promise<ScenarioRunRecord[]> {
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(scenarioRuns)
    .where(
      and(
        eq(scenarioRuns.hostId, params.hostId),
        eq(scenarioRuns.userId, params.userId),
        isNull(scenarioRuns.hiddenAt),
      ),
    )
    .orderBy(desc(scenarioRuns.createdAt));
  const parsedRows = rows.map((row) => fromDbRow(row));
  return parsedRows.map((row) => toScenarioRunRecord(row));
}
