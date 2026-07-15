import { and, eq, exists, inArray, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  hostBenchmarkLeases,
  hostActualState,
  hostCpuReservations,
  hostDesiredState,
  scenarioRuns,
} from "@/db/schema";
import {
  RUN_PHASE_ORDER,
  recomputeRunState,
  type RunStateDocument,
} from "@/lib/run-state";

export const HOST_CPU_RESERVATION_TTL_MS = 60_000;
export const HOST_BOOT_CPU_MILLIS_PER_VM = 2_000;

export interface HostCpuReservationCapacity {
  schedulableCpuMillis: number;
  reportedCommittedCpuMillis: number;
  controlPlanePendingCpuMillis: number;
  controlPlaneCommittedCpuMillis: number;
  controlPlaneBootCpuMillis: number;
  controlPlaneSteadyCpuMillis: number;
  effectiveCommittedCpuMillis: number;
  availableCpuMillis: number;
}

export type ReserveHostCpuResult =
  | {
      ok: true;
      state: "pending" | "committed";
      expiresAt: number | null;
      capacity: HostCpuReservationCapacity;
    }
  | {
      ok: false;
      reason:
        | "host_not_ready"
        | "boot_capacity_pending"
        | "host_benchmark_leased"
        | "conflict";
      capacity: HostCpuReservationCapacity | null;
    };

export function bootCpuReservationForSteadyVms(
  steadyCpuMillisByVm: readonly number[],
): number {
  if (
    steadyCpuMillisByVm.length === 0 ||
    steadyCpuMillisByVm.some(
      (cpuMillis) => !Number.isSafeInteger(cpuMillis) || cpuMillis <= 0,
    )
  ) {
    throw new Error("scenario boot CPU reservation is invalid");
  }
  const bootCpuMillis = steadyCpuMillisByVm.reduce(
    (total, steadyCpuMillis) =>
      total + Math.max(steadyCpuMillis, HOST_BOOT_CPU_MILLIS_PER_VM),
    0,
  );
  if (!Number.isSafeInteger(bootCpuMillis)) {
    throw new Error("scenario boot CPU reservation overflows");
  }
  return bootCpuMillis;
}

export async function reserveHostCpuInD1(
  db: DrizzleD1Database,
  input: {
    hostId: string;
    runId: string;
    steadyCpuMillisByVm: readonly number[];
    nowUnixMs: number;
  },
): Promise<ReserveHostCpuResult> {
  const steadyCpuMillis = input.steadyCpuMillisByVm.reduce(
    (sum, value) => sum + value,
    0,
  );
  const bootCpuMillis = bootCpuReservationForSteadyVms(
    input.steadyCpuMillisByVm,
  );
  if (
    !Number.isSafeInteger(steadyCpuMillis) ||
    steadyCpuMillis <= 0 ||
    !Number.isSafeInteger(bootCpuMillis)
  ) {
    throw new Error("invalid boot CPU reservation contract");
  }
  const [benchmarkLease] = await db
    .select({ runId: hostBenchmarkLeases.runId })
    .from(hostBenchmarkLeases)
    .where(eq(hostBenchmarkLeases.hostId, input.hostId))
    .limit(1);
  if (benchmarkLease) {
    return {
      ok: false,
      reason: "host_benchmark_leased",
      capacity: null,
    };
  }
  await reconcileHostCpuReservations(db, input.hostId, input.nowUnixMs);

  const [existing] = await db
    .select()
    .from(hostCpuReservations)
    .where(eq(hostCpuReservations.runId, input.runId))
    .limit(1);
  if (existing) {
    if (
      existing.hostId !== input.hostId ||
      existing.steadyCpuMillis !== steadyCpuMillis ||
      existing.bootCpuMillis !== bootCpuMillis
    ) {
      return { ok: false, reason: "conflict", capacity: null };
    }
    const capacity = await loadHostCpuReservationCapacity(db, input.hostId);
    if (!capacity) {
      return { ok: false, reason: "host_not_ready", capacity: null };
    }
    return {
      ok: true,
      state: existing.state,
      expiresAt: existing.expiresAt,
      capacity,
    };
  }

  const capacity = await loadHostCpuReservationCapacity(db, input.hostId);
  if (!capacity) {
    return { ok: false, reason: "host_not_ready", capacity: null };
  }
  if (bootCpuMillis > capacity.availableCpuMillis) {
    return { ok: false, reason: "boot_capacity_pending", capacity };
  }

  const expiresAt = input.nowUnixMs + HOST_CPU_RESERVATION_TTL_MS;
  try {
    await db.insert(hostCpuReservations).values({
      runId: input.runId,
      hostId: input.hostId,
      cpuMillis: bootCpuMillis,
      steadyCpuMillis,
      bootCpuMillis,
      quotaPhase: "boot",
      state: "pending",
      expiresAt,
      createdAt: input.nowUnixMs,
      updatedAt: input.nowUnixMs,
    });
  } catch (error) {
    const [raced] = await db
      .select()
      .from(hostCpuReservations)
      .where(eq(hostCpuReservations.runId, input.runId))
      .limit(1);
    if (!raced) {
      throw error;
    }
    if (
      raced.hostId !== input.hostId ||
      raced.steadyCpuMillis !== steadyCpuMillis ||
      raced.bootCpuMillis !== bootCpuMillis
    ) {
      return { ok: false, reason: "conflict", capacity: null };
    }
    const racedCapacity = await loadHostCpuReservationCapacity(
      db,
      input.hostId,
    );
    if (!racedCapacity) {
      return { ok: false, reason: "host_not_ready", capacity: null };
    }
    return {
      ok: true,
      state: raced.state,
      expiresAt: raced.expiresAt,
      capacity: racedCapacity,
    };
  }

  return {
    ok: true,
    state: "pending",
    expiresAt,
    capacity: {
      ...capacity,
      controlPlanePendingCpuMillis:
        capacity.controlPlanePendingCpuMillis + bootCpuMillis,
      controlPlaneBootCpuMillis:
        capacity.controlPlaneBootCpuMillis + bootCpuMillis,
      effectiveCommittedCpuMillis:
        capacity.effectiveCommittedCpuMillis + bootCpuMillis,
      availableCpuMillis: capacity.availableCpuMillis - bootCpuMillis,
    },
  };
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
  input: { hostId: string; runId: string },
): Promise<boolean> {
  const deleted = await db
    .delete(hostCpuReservations)
    .where(
      and(
        eq(hostCpuReservations.hostId, input.hostId),
        eq(hostCpuReservations.runId, input.runId),
        eq(hostCpuReservations.state, "pending"),
      ),
    )
    .returning({ runId: hostCpuReservations.runId });
  return deleted.length > 0;
}

export async function reconcileHostCpuReservations(
  db: DrizzleD1Database,
  hostId: string,
  nowUnixMs: number,
): Promise<{
  committedRunIds: string[];
  expiredRunIds: string[];
  releasedRunIds: string[];
  sealedRunIds: string[];
  bootAccountingRunIds: string[];
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
      sealedRunIds: [],
      bootAccountingRunIds: [],
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
          steadyCpuMillis: reservation.steadyCpuMillis,
          nowUnixMs,
        });
        if (disposition === "durable") {
          await commitHostCpuReservation(db, {
            hostId,
            runId: reservation.runId,
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
  const sealedRunIds: string[] = [];
  const bootAccountingRunIds: string[] = [];

  // Reload after crash recovery may have committed a pending row above. All
  // quota-phase mutations happen as one fenced row update while HostRuntimeDO
  // holds its per-host CPU lock.
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
        const deleted = await db
          .delete(hostCpuReservations)
          .where(
            and(
              eq(hostCpuReservations.hostId, hostId),
              eq(hostCpuReservations.runId, reservation.runId),
              eq(hostCpuReservations.state, "committed"),
            ),
          )
          .returning({ runId: hostCpuReservations.runId });
        if (deleted.length > 0) {
          releasedRunIds.push(reservation.runId);
        }
        continue;
      }
    }

    // Teardown retains the last conservative reservation until applied
    // absence proves the VM is gone. Active runs are charged boot allocation
    // unless the current inventory and sticky projection agree on one live,
    // generation-fenced steady attestation for every VM.
    if (terminalOrDeleting || !run) {
      continue;
    }
    const steadyAttested = hasGenerationFencedSteadyQuotaEvidence({
      run,
      reservation,
      desired,
      actual,
      actualHasAppliedDesired,
    });
    const nextPhase = steadyAttested ? "steady" : "boot";
    const nextCpuMillis = steadyAttested
      ? reservation.steadyCpuMillis
      : reservation.bootCpuMillis;
    if (
      reservation.quotaPhase === nextPhase &&
      reservation.cpuMillis === nextCpuMillis
    ) {
      continue;
    }
    const updated = await db
      .update(hostCpuReservations)
      .set({
        cpuMillis: nextCpuMillis,
        quotaPhase: nextPhase,
        updatedAt: nowUnixMs,
      })
      .where(
        and(
          eq(hostCpuReservations.hostId, hostId),
          eq(hostCpuReservations.runId, reservation.runId),
          eq(hostCpuReservations.state, "committed"),
          eq(hostCpuReservations.quotaPhase, reservation.quotaPhase),
          eq(hostCpuReservations.cpuMillis, reservation.cpuMillis),
        ),
      )
      .returning({ runId: hostCpuReservations.runId });
    if (updated.length > 0) {
      if (nextPhase === "steady") {
        sealedRunIds.push(reservation.runId);
      } else {
        bootAccountingRunIds.push(reservation.runId);
      }
    }
  }

  return {
    committedRunIds,
    expiredRunIds,
    releasedRunIds,
    sealedRunIds,
    bootAccountingRunIds,
  };
}

function pendingRunHasDurableDesiredVms(input: {
  run: { runId: string; vmCount: number; stateJson: string };
  reservation: { steadyCpuMillis: number };
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
  let steadyCpuMillis = 0;
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
    steadyCpuMillis += vm.resources.cpu_millis;
    if (!Number.isSafeInteger(steadyCpuMillis)) return false;
  }
  return steadyCpuMillis === input.reservation.steadyCpuMillis;
}

async function failExpiredUndispatchedRun(
  db: DrizzleD1Database,
  input: {
    hostId: string;
    runId: string;
    steadyCpuMillis: number;
    nowUnixMs: number;
  },
): Promise<"failed" | "terminal" | "durable"> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const [run] = await db
      .select({
        runId: scenarioRuns.runId,
        hostId: scenarioRuns.hostId,
        activeKey: scenarioRuns.activeKey,
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
        reservation: { steadyCpuMillis: input.steadyCpuMillis },
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
    const updated = await db
      .update(scenarioRuns)
      .set({
        state: "failed",
        stateRank: RUN_PHASE_ORDER.failed,
        stateJson: failedStateJson,
        activeKey: null,
        failedAt: updatedAt,
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

function hasGenerationFencedSteadyQuotaEvidence(input: {
  run: { runId: string; vmCount: number; stateJson: string };
  reservation: { steadyCpuMillis: number };
  desired: unknown;
  actual: unknown;
  actualHasAppliedDesired: boolean;
}): boolean {
  if (
    !input.actualHasAppliedDesired ||
    !isRecord(input.desired) ||
    !Array.isArray(input.desired.vms) ||
    !isRecord(input.actual) ||
    !Array.isArray(input.actual.vms)
  ) {
    return false;
  }
  let projectedState: unknown;
  try {
    projectedState = JSON.parse(input.run.stateJson);
  } catch {
    return false;
  }
  if (!isRecord(projectedState) || !Array.isArray(projectedState.vms)) {
    return false;
  }

  const desiredVms = input.desired.vms.filter(
    (vm) =>
      isRecord(vm) &&
      vm.run_id === input.run.runId &&
      vm.desired_phase === "running",
  );
  if (
    input.run.vmCount <= 0 ||
    desiredVms.length !== input.run.vmCount ||
    projectedState.vms.length !== input.run.vmCount
  ) {
    return false;
  }

  let steadyCpuTotal = 0;
  const seenVmNames = new Set<string>();
  for (const desiredVm of desiredVms) {
    if (!isRecord(desiredVm)) {
      return false;
    }
    const vmName = readNonEmptyString(desiredVm.vm_name);
    const resources = isRecord(desiredVm.resources)
      ? desiredVm.resources
      : null;
    const steadyCpuMillis = readPositiveInteger(resources?.cpu_millis);
    if (!vmName || steadyCpuMillis === null || seenVmNames.has(vmName)) {
      return false;
    }
    seenVmNames.add(vmName);
    steadyCpuTotal += steadyCpuMillis;
    if (!Number.isSafeInteger(steadyCpuTotal)) {
      return false;
    }

    const projectedVm = projectedState.vms.find(
      (vm) => isRecord(vm) && vm.runtimeVmName === vmName,
    );
    const actualMatches = input.actual.vms.filter(
      (vm) =>
        isRecord(vm) &&
        vm.run_id === input.run.runId &&
        vm.vm_name === vmName &&
        vm.phase !== "absent",
    );
    if (!isRecord(projectedVm) || actualMatches.length !== 1) {
      return false;
    }
    const actualVm = actualMatches[0];
    if (!isRecord(actualVm)) {
      return false;
    }
    const projectedQuota = isRecord(projectedVm.runtimeConstraints)
      ? projectedVm.runtimeConstraints
      : null;
    const actualQuota = isRecord(actualVm.runtime_constraints)
      ? actualVm.runtime_constraints
      : null;
    const resourceState = isRecord(actualVm.resource_state)
      ? actualVm.resource_state
      : null;
    const generation = readNonEmptyString(actualQuota?.generation);
    const quotaVerifiedAt = readPositiveInteger(
      actualQuota?.quota_verified_at_unix_ms,
    );
    const reportUpdatedAt = readPositiveInteger(actualVm.updated_at_unix_ms);
    if (
      !generation ||
      actualQuota?.phase !== "steady" ||
      actualQuota?.steady_cpu_millis !== steadyCpuMillis ||
      actualQuota?.effective_cpu_millis !== steadyCpuMillis ||
      quotaVerifiedAt === null ||
      reportUpdatedAt === null ||
      quotaVerifiedAt > reportUpdatedAt ||
      projectedQuota?.generation !== generation ||
      projectedQuota?.phase !== "steady" ||
      projectedQuota?.steadyCpuMillis !== steadyCpuMillis ||
      projectedQuota?.effectiveCpuMillis !== steadyCpuMillis ||
      projectedQuota?.quotaVerifiedAt !== quotaVerifiedAt ||
      resourceState?.cpu_millis !== steadyCpuMillis ||
      resourceState?.cpu_period_us !== 100_000 ||
      resourceState?.cpu_quota_us !== steadyCpuMillis * 100
    ) {
      return false;
    }
  }

  return steadyCpuTotal === input.reservation.steadyCpuMillis;
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
  const reported = strictCpuCapacity(actual?.reportJson);
  if (!reported) {
    return null;
  }

  const reservations = await db
    .select({
      runId: hostCpuReservations.runId,
      cpuMillis: hostCpuReservations.cpuMillis,
      quotaPhase: hostCpuReservations.quotaPhase,
      state: hostCpuReservations.state,
    })
    .from(hostCpuReservations)
    .where(eq(hostCpuReservations.hostId, hostId));
  const controlPlanePendingCpuMillis = sumCpuMillis(
    reservations.filter((reservation) => reservation.state === "pending"),
  );
  const controlPlaneCommittedCpuMillis = sumCpuMillis(
    reservations.filter((reservation) => reservation.state === "committed"),
  );
  const controlPlaneBootCpuMillis = sumCpuMillis(
    reservations.filter((reservation) => reservation.quotaPhase === "boot"),
  );
  const controlPlaneSteadyCpuMillis = sumCpuMillis(
    reservations.filter((reservation) => reservation.quotaPhase === "steady"),
  );
  const reservedRunIds = new Set(
    reservations.map((reservation) => reservation.runId),
  );
  const reportedCpuByReservedRun = reportedCpuMillisByRun(
    actual?.reportJson,
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
    controlPlaneBootCpuMillis,
    controlPlaneSteadyCpuMillis,
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
      runtimeConstraints?.effective_cpu_millis,
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
  if (!isRecord(report)) {
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
    capabilities.supports_jailer_v1 !== false ||
    capabilities.supports_jailer_v2 !== true ||
    capabilities.supports_boot_cpu_lease !== true ||
    capabilities.supports_template_backed_launch !== true ||
    capabilities.fast_template_store !== true ||
    capabilities.supports_hard_cpu_quota !== true ||
    capabilities.supports_landlock !== true ||
    capabilities.supports_cgroup_v2 !== true ||
    typeof capabilities.cloud_hypervisor_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(capabilities.cloud_hypervisor_sha256) ||
    capabilities.boot_cpu_millis !== 2_000 ||
    capabilities.boot_cpu_lease_ms !== 45_000
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

function sumCpuMillis(rows: Array<{ cpuMillis: number }>): number {
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
