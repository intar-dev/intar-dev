import { HOST_STATE_REPORT_SCHEMA_VERSION } from "@/generated/constants";
import { and, eq, exists, inArray, isNull, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  hostActualState,
  hostCpuReservations,
  hostDesiredState,
  hostResourceReservations,
  scenarioRuns,
} from "@/db/schema";
import {
  RUN_PHASE_ORDER,
  recomputeRunState,
  type RunStateDocument,
} from "@/lib/run-state";
import {
  drizzleQueryToD1Statement,
  executeScenarioRunRuntimeProjection,
} from "@/lib/runtime-executions";

type RuntimeD1Database = DrizzleD1Database & { $client: D1Database };

export const HOST_CPU_RESERVATION_TTL_MS = 60_000;

export interface HostCpuReservationCapacity {
  schedulableCpuMillis: number;
  reportedCommittedCpuMillis: number;
  controlPlanePendingCpuMillis: number;
  controlPlaneCommittedCpuMillis: number;
  effectiveCommittedCpuMillis: number;
  availableCpuMillis: number;
}

export interface HostCpuReservationCapacityRow {
  runId: string;
  cpuMillis: number;
  state: "pending" | "committed";
}

export function cpuReservationForVms(
  cpuMillisByVm: readonly number[],
): number {
  if (
    cpuMillisByVm.length === 0 ||
    cpuMillisByVm.some(
      (cpuMillis) => !Number.isSafeInteger(cpuMillis) || cpuMillis <= 0,
    )
  ) {
    throw new Error("scenario CPU reservation is invalid");
  }
  const cpuMillis = cpuMillisByVm.reduce(
    (total, cpuMillis) => total + cpuMillis,
    0,
  );
  if (!Number.isSafeInteger(cpuMillis)) {
    throw new Error("scenario CPU reservation overflows");
  }
  return cpuMillis;
}


export async function commitHostCpuReservation(
  db: DrizzleD1Database,
  input: { hostId: string; runId: string; nowUnixMs: number },
): Promise<boolean> {
  const updated = await db
    .update(hostCpuReservations)
    .set({
      state: "committed",
      expiresAt: null,
      updatedAt: input.nowUnixMs,
    })
    .where(
      and(
        eq(hostCpuReservations.hostId, input.hostId),
        eq(hostCpuReservations.runId, input.runId),
      ),
    )
    .returning({ runId: hostCpuReservations.runId });
  return updated.length > 0;
}

export async function rollbackPendingHostCpuReservation(
  db: DrizzleD1Database,
  input: { hostId: string; runId: string; nowUnixMs?: number },
): Promise<boolean> {
  const nowUnixMs = input.nowUnixMs ?? Date.now();
  const [deleted] = await db.batch([
    db
      .delete(hostCpuReservations)
      .where(
        and(
          eq(hostCpuReservations.hostId, input.hostId),
          eq(hostCpuReservations.runId, input.runId),
          eq(hostCpuReservations.state, "pending"),
        ),
      )
      .returning({ runId: hostCpuReservations.runId }),
    db
      .update(hostResourceReservations)
      .set({
        state: "released",
        releasedAt: nowUnixMs,
        updatedAt: nowUnixMs,
      })
      .where(
        and(
          eq(hostResourceReservations.executionId, input.runId),
          eq(hostResourceReservations.hostId, input.hostId),
          eq(hostResourceReservations.state, "pending"),
        ),
      ),
  ]);
  return deleted.length > 0;
}

export async function reconcileHostCpuReservations(
  db: RuntimeD1Database,
  hostId: string,
  nowUnixMs: number,
): Promise<{
  committedRunIds: string[];
  expiredRunIds: string[];
  releasedRunIds: string[];
}> {
  const reservations = await db
    .select()
    .from(hostCpuReservations)
    .where(eq(hostCpuReservations.hostId, hostId));
  if (!reservations.length) {
    return {
      committedRunIds: [],
      expiredRunIds: [],
      releasedRunIds: [],
    };
  }

  const runRows = await db
    .select({
      runId: scenarioRuns.runId,
      hostId: scenarioRuns.hostId,
      activeKey: scenarioRuns.activeKey,
      deleteRequestedAt: scenarioRuns.deleteRequestedAt,
      completedAt: scenarioRuns.completedAt,
      failedAt: scenarioRuns.failedAt,
      vmCount: scenarioRuns.vmCount,
      stateJson: scenarioRuns.stateJson,
      runtimeExecutionId: scenarioRuns.runtimeExecutionId,
      updatedAt: scenarioRuns.updatedAt,
    })
    .from(scenarioRuns)
    .where(
      inArray(
        scenarioRuns.runId,
        reservations.map((reservation) => reservation.runId),
      ),
    );
  const runById = new Map(runRows.map((run) => [run.runId, run]));
  const committedRunIds: string[] = [];
  const expiredRunIds: string[] = [];

  const loadDesiredState = async () => {
    const [row] = await db
      .select({
        version: hostDesiredState.version,
        docJson: hostDesiredState.docJson,
      })
      .from(hostDesiredState)
      .where(eq(hostDesiredState.hostId, hostId))
      .limit(1);
    return row;
  };
  let desiredRow = await loadDesiredState();

  for (const reservation of reservations) {
    if (reservation.state !== "pending") {
      continue;
    }
    const run = runById.get(reservation.runId);
    if (
      run?.hostId === hostId &&
      pendingRunHasDurableDesiredVms({
        run,
        reservation,
        desired: desiredRow?.docJson,
      })
    ) {
      await commitHostCpuReservation(db, {
        hostId,
        runId: reservation.runId,
        nowUnixMs,
      });
      await syncScenarioRuntimeResourceReservation(db, {
        executionId: run.runtimeExecutionId ?? reservation.runId,
        hostId,
        cpuMillis: reservation.cpuMillis,
        state: "committed",
        nowUnixMs,
      });
      committedRunIds.push(reservation.runId);
      continue;
    }
    if (reservation.expiresAt !== null && reservation.expiresAt <= nowUnixMs) {
      if (
        run?.hostId === hostId &&
        run.activeKey !== null &&
        run.completedAt === null &&
        run.failedAt === null
      ) {
        const disposition = await failExpiredUndispatchedRun(db, {
          hostId,
          runId: reservation.runId,
          cpuMillis: reservation.cpuMillis,
          nowUnixMs,
        });
        if (disposition === "durable") {
          await commitHostCpuReservation(db, {
            hostId,
            runId: reservation.runId,
            nowUnixMs,
          });
          await syncScenarioRuntimeResourceReservation(db, {
            executionId: run.runtimeExecutionId ?? reservation.runId,
            hostId,
            cpuMillis: reservation.cpuMillis,
            state: "committed",
            nowUnixMs,
          });
          committedRunIds.push(reservation.runId);
          desiredRow = await loadDesiredState();
          continue;
        }
      }
      await rollbackPendingHostCpuReservation(db, {
        hostId,
        runId: reservation.runId,
        nowUnixMs,
      });
      expiredRunIds.push(reservation.runId);
    }
  }

  desiredRow = await loadDesiredState();
  const [actualRow] = await db
    .select({
      appliedDesiredVersion: hostActualState.appliedDesiredVersion,
      reportJson: hostActualState.reportJson,
    })
    .from(hostActualState)
    .where(eq(hostActualState.hostId, hostId))
    .limit(1);
  const desired = desiredRow?.docJson;
  const actual = actualRow?.reportJson;
  const actualHasAppliedDesired =
    desired !== undefined &&
    actualRow !== undefined &&
    actualRow.appliedDesiredVersion >= desired.version;
  const releasedRunIds: string[] = [];

  // Reload after crash recovery may have committed a pending row above.
  // HostRuntimeDO holds its per-host CPU lock throughout reconciliation.
  const reconciledReservations = await db
    .select()
    .from(hostCpuReservations)
    .where(eq(hostCpuReservations.hostId, hostId));
  for (const reservation of reconciledReservations) {
    if (reservation.state !== "committed") {
      continue;
    }
    const run = runById.get(reservation.runId);
    const terminalOrDeleting =
      !run ||
      run.activeKey === null ||
      run.deleteRequestedAt !== null ||
      run.completedAt !== null ||
      run.failedAt !== null;

    if (terminalOrDeleting && desired && actual && actualHasAppliedDesired) {
      const desiredRunning = desired.vms.some(
        (vm) =>
          vm.run_id === reservation.runId && vm.desired_phase === "running",
      );
      const actualPresent = actual.vms.some(
        (vm) => vm.run_id === reservation.runId && vm.phase !== "absent",
      );
      if (!desiredRunning && !actualPresent) {
        const executionId = run?.runtimeExecutionId ?? reservation.runId;
        const [deleted] = await db.batch([
          db
            .delete(hostCpuReservations)
            .where(
              and(
                eq(hostCpuReservations.hostId, hostId),
                eq(hostCpuReservations.runId, reservation.runId),
                eq(hostCpuReservations.state, "committed"),
              ),
            )
            .returning({ runId: hostCpuReservations.runId }),
          db
            .update(hostResourceReservations)
            .set({
              state: "released",
              releasedAt: nowUnixMs,
              updatedAt: nowUnixMs,
            })
            .where(
              and(
                eq(hostResourceReservations.executionId, executionId),
                eq(hostResourceReservations.hostId, hostId),
                inArray(hostResourceReservations.state, [
                  "pending",
                  "committed",
                ]),
              ),
            ),
        ]);
        if (deleted.length > 0) {
          releasedRunIds.push(reservation.runId);
        }
        continue;
      }
    }

    // Keep the declared reservation until applied absence proves teardown.
    await syncScenarioRuntimeResourceReservation(db, {
      executionId: run?.runtimeExecutionId ?? reservation.runId,
      hostId,
      cpuMillis: reservation.cpuMillis,
      state: "committed",
      nowUnixMs,
    });
  }

  return {
    committedRunIds,
    expiredRunIds,
    releasedRunIds,
  };
}

async function syncScenarioRuntimeResourceReservation(
  db: DrizzleD1Database,
  input: {
    executionId: string;
    hostId: string;
    cpuMillis?: number;
    state?: "committed" | "released";
    nowUnixMs: number;
  },
): Promise<void> {
  if (input.state === "released") {
    await db
      .update(hostResourceReservations)
      .set({
        state: "released",
        releasedAt: input.nowUnixMs,
        updatedAt: input.nowUnixMs,
      })
      .where(
        and(
          eq(hostResourceReservations.executionId, input.executionId),
          eq(hostResourceReservations.hostId, input.hostId),
          inArray(hostResourceReservations.state, ["pending", "committed"]),
        ),
      );
    return;
  }
  await db
    .update(hostResourceReservations)
    .set({
      ...(input.cpuMillis === undefined
        ? {}
        : { cpuMillis: input.cpuMillis }),
      ...(input.state === "committed"
        ? { state: "committed" as const, expiresAt: null }
        : {}),
      updatedAt: input.nowUnixMs,
    })
    .where(
      and(
        eq(hostResourceReservations.executionId, input.executionId),
        eq(hostResourceReservations.hostId, input.hostId),
        inArray(hostResourceReservations.state, ["pending", "committed"]),
      ),
    );
}

function pendingRunHasDurableDesiredVms(input: {
  run: { runId: string; vmCount: number; stateJson: string };
  reservation: { cpuMillis: number };
  desired: typeof hostDesiredState.$inferSelect.docJson | undefined;
}): boolean {
  if (!input.desired || input.run.vmCount <= 0) {
    return false;
  }
  let projected: unknown;
  try {
    projected = JSON.parse(input.run.stateJson) as unknown;
  } catch {
    return false;
  }
  if (!isRecord(projected) || !Array.isArray(projected.vms)) {
    return false;
  }
  const projectedNames = new Set<string>();
  for (const vm of projected.vms) {
    if (!isRecord(vm)) return false;
    const vmName = readNonEmptyString(vm.runtimeVmName);
    if (!vmName || projectedNames.has(vmName)) return false;
    projectedNames.add(vmName);
  }
  if (projectedNames.size !== input.run.vmCount) {
    return false;
  }

  const desiredVms = input.desired.vms.filter(
    (vm) => vm.run_id === input.run.runId && vm.desired_phase === "running",
  );
  if (desiredVms.length !== input.run.vmCount) {
    return false;
  }
  let cpuMillis = 0;
  const desiredNames = new Set<string>();
  for (const vm of desiredVms) {
    if (
      !projectedNames.has(vm.vm_name) ||
      desiredNames.has(vm.vm_name) ||
      !Number.isSafeInteger(vm.resources.cpu_millis) ||
      vm.resources.cpu_millis <= 0
    ) {
      return false;
    }
    desiredNames.add(vm.vm_name);
    cpuMillis += vm.resources.cpu_millis;
    if (!Number.isSafeInteger(cpuMillis)) return false;
  }
  return cpuMillis === input.reservation.cpuMillis;
}

async function failExpiredUndispatchedRun(
  db: RuntimeD1Database,
  input: {
    hostId: string;
    runId: string;
    cpuMillis: number;
    nowUnixMs: number;
  },
): Promise<"failed" | "terminal" | "durable"> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const [run] = await db
      .select({
        runId: scenarioRuns.runId,
        hostId: scenarioRuns.hostId,
        activeKey: scenarioRuns.activeKey,
        deleteRequestedAt: scenarioRuns.deleteRequestedAt,
        completedAt: scenarioRuns.completedAt,
        failedAt: scenarioRuns.failedAt,
        vmCount: scenarioRuns.vmCount,
        stateJson: scenarioRuns.stateJson,
        updatedAt: scenarioRuns.updatedAt,
      })
      .from(scenarioRuns)
      .where(eq(scenarioRuns.runId, input.runId))
      .limit(1);
    if (
      !run ||
      run.hostId !== input.hostId ||
      run.activeKey === null ||
      run.completedAt !== null ||
      run.failedAt !== null
    ) {
      return "terminal";
    }
    const [desiredRow] = await db
      .select({
        version: hostDesiredState.version,
        docJson: hostDesiredState.docJson,
      })
      .from(hostDesiredState)
      .where(eq(hostDesiredState.hostId, input.hostId))
      .limit(1);
    if (
      pendingRunHasDurableDesiredVms({
        run,
        reservation: { cpuMillis: input.cpuMillis },
        desired: desiredRow?.docJson,
      })
    ) {
      return "durable";
    }

    const reason =
      "Boot admission expired before durable desired-state dispatch completed.";
    const failedStateJson = failedUndispatchedRunStateJson(
      run.stateJson,
      reason,
      input.nowUnixMs,
    );
    const desiredVersionFence = desiredRow
      ? exists(
          db
            .select({ hostId: hostDesiredState.hostId })
            .from(hostDesiredState)
            .where(
              and(
                eq(hostDesiredState.hostId, input.hostId),
                eq(hostDesiredState.version, desiredRow.version),
              ),
            ),
        )
      : undefined;
    const updatedAt = Math.max(input.nowUnixMs, run.updatedAt + 1);
    const mutation = db
      .update(scenarioRuns)
      .set({
        state: "failed",
        stateRank: RUN_PHASE_ORDER.failed,
        stateJson: failedStateJson,
        activeKey:
          run.deleteRequestedAt === null ? null : run.activeKey,
        failedAt: updatedAt,
        archiveEnteredAt: sql<number>`coalesce(${scenarioRuns.archiveEnteredAt}, ${updatedAt})`,
        updatedAt,
      })
      .where(
        and(
          eq(scenarioRuns.runId, input.runId),
          eq(scenarioRuns.hostId, input.hostId),
          eq(scenarioRuns.updatedAt, run.updatedAt),
          isNull(scenarioRuns.completedAt),
          isNull(scenarioRuns.failedAt),
          desiredVersionFence,
        ),
      )
      .returning({ runId: scenarioRuns.runId });
    const [updatedResult] = await executeScenarioRunRuntimeProjection({
      d1: db.$client,
      runId: input.runId,
      statements: [drizzleQueryToD1Statement(db.$client, mutation)],
      mode: "update",
    });
    const updated = updatedResult?.results ?? [];
    if (updated.length > 0) {
      return "failed";
    }
  }
  throw new Error(
    `expired undispatched run ${input.runId} could not be fenced for recovery`,
  );
}

function failedUndispatchedRunStateJson(
  stateJson: string,
  reason: string,
  nowUnixMs: number,
): string {
  try {
    const current = JSON.parse(stateJson) as RunStateDocument;
    if (!current || !Array.isArray(current.vms)) return stateJson;
    const failed = recomputeRunState({
      ...current,
      phase: "failed",
      phaseDetail: reason,
      vms: current.vms.map((vm) => ({
        ...vm,
        phase: "failed",
        phaseDetail: reason,
        terminalPhase: "failed",
        terminalReason: reason,
        terminalObservedAt: nowUnixMs,
        provisioning: {
          ...vm.provisioning,
          status: "failed",
          error: reason,
        },
      })),
    });
    return JSON.stringify(failed);
  } catch {
    return stateJson;
  }
}

export async function nextPendingHostCpuReservationExpiry(
  db: DrizzleD1Database,
  hostId: string,
): Promise<number | null> {
  const rows = await db
    .select({ expiresAt: hostCpuReservations.expiresAt })
    .from(hostCpuReservations)
    .where(
      and(
        eq(hostCpuReservations.hostId, hostId),
        eq(hostCpuReservations.state, "pending"),
      ),
    );
  return (
    rows
      .map((row) => row.expiresAt)
      .filter((value): value is number => value !== null)
      .sort((left, right) => left - right)[0] ?? null
  );
}

export async function loadHostCpuReservationCapacity(
  db: DrizzleD1Database,
  hostId: string,
): Promise<HostCpuReservationCapacity | null> {
  const [actual] = await db
    .select({ reportJson: hostActualState.reportJson })
    .from(hostActualState)
    .where(eq(hostActualState.hostId, hostId))
    .limit(1);
  const reservations = await db
    .select({
      runId: hostCpuReservations.runId,
      cpuMillis: hostCpuReservations.cpuMillis,
      state: hostCpuReservations.state,
    })
    .from(hostCpuReservations)
    .where(eq(hostCpuReservations.hostId, hostId));
  return hostCpuReservationCapacityFromSnapshot(
    actual?.reportJson,
    reservations,
  );
}

export function hostCpuReservationCapacityFromSnapshot(
  report: unknown,
  reservations: readonly HostCpuReservationCapacityRow[],
): HostCpuReservationCapacity | null {
  const reported = strictCpuCapacity(report);
  if (!reported) {
    return null;
  }
  const controlPlanePendingCpuMillis = sumCpuMillis(
    reservations.filter((reservation) => reservation.state === "pending"),
  );
  const controlPlaneCommittedCpuMillis = sumCpuMillis(
    reservations.filter((reservation) => reservation.state === "committed"),
  );
  const reservedRunIds = new Set(
    reservations.map((reservation) => reservation.runId),
  );
  const reportedCpuByReservedRun = reportedCpuMillisByRun(
    report,
    reservedRunIds,
  );
  const reportedReservedCpuMillis = [
    ...reportedCpuByReservedRun.values(),
  ].reduce((sum, cpuMillis) => sum + cpuMillis, 0);
  const reportedUnreservedCpuMillis = Math.max(
    0,
    reported.reportedCommittedCpuMillis - reportedReservedCpuMillis,
  );
  const effectiveCommittedCpuMillis =
    reservations.reduce(
      (sum, reservation) =>
        sum +
        Math.max(
          reservation.cpuMillis,
          reportedCpuByReservedRun.get(reservation.runId) ?? 0,
        ),
      0,
    ) + reportedUnreservedCpuMillis;

  return {
    ...reported,
    controlPlanePendingCpuMillis,
    controlPlaneCommittedCpuMillis,
    effectiveCommittedCpuMillis,
    availableCpuMillis: Math.max(
      0,
      reported.schedulableCpuMillis - effectiveCommittedCpuMillis,
    ),
  };
}

function reportedCpuMillisByRun(
  report: unknown,
  runIds: ReadonlySet<string>,
): Map<string, number> {
  const byRun = new Map<string, number>();
  if (!isRecord(report) || !Array.isArray(report.vms) || runIds.size === 0) {
    return byRun;
  }
  for (const vm of report.vms) {
    if (
      !isRecord(vm) ||
      typeof vm.run_id !== "string" ||
      !runIds.has(vm.run_id) ||
      vm.phase === "absent"
    ) {
      continue;
    }
    const runtimeConstraints = isRecord(vm.runtime_constraints)
      ? vm.runtime_constraints
      : null;
    const resourceState = isRecord(vm.resource_state)
      ? vm.resource_state
      : null;
    const attestedEffective = readPositiveInteger(
      runtimeConstraints?.cpu_millis,
    );
    const quotaUs = readPositiveInteger(resourceState?.cpu_quota_us);
    const periodUs = readPositiveInteger(resourceState?.cpu_period_us);
    const quotaEffective =
      quotaUs !== null && periodUs !== null
        ? Math.ceil((quotaUs * 1_000) / periodUs)
        : null;
    const cpuMillis = attestedEffective ?? quotaEffective;
    if (cpuMillis !== null && Number.isSafeInteger(cpuMillis)) {
      byRun.set(vm.run_id, (byRun.get(vm.run_id) ?? 0) + cpuMillis);
    }
  }
  return byRun;
}

export function strictCpuCapacity(
  report: unknown,
): Pick<
  HostCpuReservationCapacity,
  "schedulableCpuMillis" | "reportedCommittedCpuMillis"
> | null {
  if (!isRecord(report) || report.schema_version !== HOST_STATE_REPORT_SCHEMA_VERSION) {
    return null;
  }
  const capacity = isRecord(report.capacity) ? report.capacity : null;
  const capabilities = isRecord(report.capabilities)
    ? report.capabilities
    : null;
  if (
    !capacity ||
    !capabilities ||
    capabilities.supports_kvm !== true ||
    capabilities.supports_vsock !== true ||
    capabilities.supports_reflink !== true ||
    capabilities.supports_nftables !== true ||
    capabilities.supports_jailer_v3 !== true ||
    capabilities.supports_template_backed_launch !== true ||
    capabilities.fast_template_store !== true ||
    capabilities.supports_hard_cpu_quota !== true ||
    capabilities.supports_landlock !== true ||
    capabilities.supports_cgroup_v2 !== true ||
    typeof capabilities.cloud_hypervisor_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(capabilities.cloud_hypervisor_sha256)
  ) {
    return null;
  }
  const schedulableCpuMillis = readNonNegativeInteger(
    capacity.schedulable_cpu_millis,
  );
  const reportedCommittedCpuMillis = readNonNegativeInteger(
    capacity.committed_cpu_millis,
  );
  const totalCpuMillis = readNonNegativeInteger(capacity.total_cpu_millis);
  const reservedCpuMillis = readNonNegativeInteger(
    capacity.reserved_cpu_millis,
  );
  if (
    schedulableCpuMillis === null ||
    reportedCommittedCpuMillis === null ||
    totalCpuMillis === null ||
    reservedCpuMillis === null ||
    reservedCpuMillis + schedulableCpuMillis > totalCpuMillis ||
    reportedCommittedCpuMillis > schedulableCpuMillis
  ) {
    return null;
  }
  return { schedulableCpuMillis, reportedCommittedCpuMillis };
}

function sumCpuMillis(rows: readonly { cpuMillis: number }[]): number {
  return rows.reduce((sum, row) => sum + row.cpuMillis, 0);
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function readPositiveInteger(value: unknown): number | null {
  const integer = readNonNegativeInteger(value);
  return integer !== null && integer > 0 ? integer : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Builds the D1 statement that admits one run into the host CPU quota. */
export function admissionCpuQuotaStatement(input: {
  d1: D1Database;
  runId: string;
  userId: string;
  hostId: string;
  cpuMillis: number;
  desiredVersion: number;
  nowUnixMs: number;
}): D1PreparedStatement {
  // The row is written under the desired-state version fence, so a lost
  // compare-and-set leaves neither the run nor the quota behind.
  return input.d1
    .prepare(
      "INSERT INTO host_cpu_reservations (" +
        "run_id, host_id, cpu_millis, state, expires_at, created_at, updated_at" +
        ") SELECT run.run_id, run.host_id, ?1, 'committed', NULL, ?2, ?2" +
        " FROM scenario_runs run" +
        " WHERE run.run_id = ?3 AND run.user_id = ?4 AND run.host_id = ?5" +
        " AND EXISTS (SELECT 1 FROM host_desired_state desired" +
        " WHERE desired.host_id = run.host_id AND desired.version = ?6)",
    )
    .bind(
      input.cpuMillis,
      input.nowUnixMs,
      input.runId,
      input.userId,
      input.hostId,
      input.desiredVersion,
    );
}

/** Builds the D1 statement that records the generic resource reservation. */
export function admissionResourceReservationStatement(input: {
  d1: D1Database;
  runId: string;
  hostId: string;
  resources: { cpuMillis: number; memoryMib: number; worstCaseDiskMib: number };
  expiresAt: number | null;
  nowUnixMs: number;
}): D1PreparedStatement {
  return input.d1
    .prepare(
      "INSERT INTO host_resource_reservations (" +
        "execution_id, host_id, cpu_millis, memory_mib, worst_case_disk_mib," +
        " state, expires_at, released_at, created_at, updated_at" +
        ") SELECT run.runtime_execution_id, run.host_id, ?1, ?2, ?3, 'pending'," +
        " ?4, NULL, ?5, ?5" +
        " FROM scenario_runs run" +
        " WHERE run.run_id = ?6 AND run.host_id = ?7" +
        " AND run.state = 'provisioning'",
    )
    .bind(
      input.resources.cpuMillis,
      input.resources.memoryMib,
      input.resources.worstCaseDiskMib,
      input.expiresAt,
      input.nowUnixMs,
      input.runId,
      input.hostId,
    );
}
