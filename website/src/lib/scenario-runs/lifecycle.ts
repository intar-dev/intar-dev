import { env } from "cloudflare:workers";
import { and, desc, eq, isNull } from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import { appError } from "@/lib/app-error";
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
  issueStargateTerminalSession,
  stargateRouteTtlMs,
} from "@/lib/stargate";
import { loadScenarioRunSshKey } from "@/lib/scenario-run-ssh-keys";
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
  hostId?: string;
}): Promise<{
  accepted: true;
  runId: string;
  scenarioId: string;
  acceptedAt: number;
  reused: boolean;
}> {
  return startScenarioRunInternal(params);
}

export async function destroyScenarioRunForUser(params: {
  runId: string;
  userId: string;
}): Promise<{
  accepted: true;
  runId: string;
  acceptedAt: number;
}> {
  const db = drizzle(env.DB);
  const row = await loadRunRow(params.runId, params.userId);
  if (!row) {
    throw appError(404, "scenario_run_not_found", "scenario run not found");
  }

  const acceptedAt = Date.now();
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
      deleteRequestedAt: acceptedAt,
    });
  } else if (teardownVms.length > 0) {
    // A failed outcome is terminal for scoring, not for infrastructure. Keep
    // the original failure state while recording that teardown was requested.
    await db
      .update(scenarioRuns)
      .set({
        deleteRequestedAt: row.deleteRequestedAt ?? acceptedAt,
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
    await markRunVmsAbsentInDesiredState({
      hostId: row.hostId,
      runId: row.runId,
      vms: teardownVms,
      nowUnixMs: acceptedAt,
      db,
    });
  }

  const routeRevocationFailure = await revokeScenarioRunRoutes(row).then(
    () => null,
    (error: unknown) => ({ error }),
  );
  await tryWakeHostRuntime(row.hostId);
  if (routeRevocationFailure) {
    throw routeRevocationFailure.error;
  }

  return {
    accepted: true,
    runId: row.runId,
    acceptedAt,
  };
}

export async function deleteFinishedScenarioRunForUser(params: {
  runId: string;
  userId: string;
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

  await db.delete(scenarioRuns).where(eq(scenarioRuns.runId, row.runId));
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
  if (requestedMode === "native" && profileKeys.length === 0) {
    throw appError(
      409,
      "scenario_native_ssh_key_required",
      "add an SSH key to your profile before opening a native SSH route",
    );
  }
  const routeType =
    requestedMode === "browser" ? "browser" : "native_profile_keys";
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
  return issueStargateTerminalSession({
    routeUsername,
    targetUsername,
    targetHost: host,
    targetPort: port,
    targetHostKeyOpenssh,
    targetPrivateKeyOpenssh: targetKey.privateKeyOpenssh,
    expiresAt: new Date(Date.now() + stargateRouteTtlMs()),
    mode: requestedMode,
    authorizedClientPublicKeysOpenssh: profileKeys.map(
      (key) => key.publicKeyOpenssh,
    ),
    metadata: {
      hostId: row.hostId,
      runId: row.runId,
      vmId: vm.id,
      userId: row.userId,
    },
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
