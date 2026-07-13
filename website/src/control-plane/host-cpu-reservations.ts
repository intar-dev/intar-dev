import { and, eq, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  hostActualState,
  hostCpuReservations,
  hostDesiredState,
  scenarioRuns,
} from "@/db/schema";

export const HOST_CPU_RESERVATION_TTL_MS = 60_000;

export interface HostCpuReservationCapacity {
  schedulableCpuMillis: number;
  reportedCommittedCpuMillis: number;
  controlPlanePendingCpuMillis: number;
  controlPlaneCommittedCpuMillis: number;
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
      reason: "host_not_ready" | "exhausted" | "conflict";
      capacity: HostCpuReservationCapacity | null;
    };

export async function reserveHostCpuInD1(
  db: DrizzleD1Database,
  input: {
    hostId: string;
    runId: string;
    cpuMillis: number;
    nowUnixMs: number;
  },
): Promise<ReserveHostCpuResult> {
  await reconcileHostCpuReservations(db, input.hostId, input.nowUnixMs);

  const [existing] = await db
    .select()
    .from(hostCpuReservations)
    .where(eq(hostCpuReservations.runId, input.runId))
    .limit(1);
  if (existing) {
    if (
      existing.hostId !== input.hostId ||
      existing.cpuMillis !== input.cpuMillis
    ) {
      return { ok: false, reason: "conflict", capacity: null };
    }
    const capacity = await loadReservationCapacity(db, input.hostId);
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

  const capacity = await loadReservationCapacity(db, input.hostId);
  if (!capacity) {
    return { ok: false, reason: "host_not_ready", capacity: null };
  }
  if (input.cpuMillis > capacity.availableCpuMillis) {
    return { ok: false, reason: "exhausted", capacity };
  }

  const expiresAt = input.nowUnixMs + HOST_CPU_RESERVATION_TTL_MS;
  try {
    await db.insert(hostCpuReservations).values({
      runId: input.runId,
      hostId: input.hostId,
      cpuMillis: input.cpuMillis,
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
    if (raced.hostId !== input.hostId || raced.cpuMillis !== input.cpuMillis) {
      return { ok: false, reason: "conflict", capacity: null };
    }
    const racedCapacity = await loadReservationCapacity(db, input.hostId);
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
        capacity.controlPlanePendingCpuMillis + input.cpuMillis,
      effectiveCommittedCpuMillis:
        capacity.effectiveCommittedCpuMillis + input.cpuMillis,
      availableCpuMillis: capacity.availableCpuMillis - input.cpuMillis,
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
): Promise<{ committedRunIds: string[]; expiredRunIds: string[]; releasedRunIds: string[] }> {
  const reservations = await db
    .select()
    .from(hostCpuReservations)
    .where(eq(hostCpuReservations.hostId, hostId));
  if (!reservations.length) {
    return { committedRunIds: [], expiredRunIds: [], releasedRunIds: [] };
  }

  const runRows = await db
    .select({
      runId: scenarioRuns.runId,
      hostId: scenarioRuns.hostId,
      activeKey: scenarioRuns.activeKey,
      deleteRequestedAt: scenarioRuns.deleteRequestedAt,
      completedAt: scenarioRuns.completedAt,
      failedAt: scenarioRuns.failedAt,
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

  for (const reservation of reservations) {
    if (reservation.state !== "pending") {
      continue;
    }
    const run = runById.get(reservation.runId);
    if (run?.hostId === hostId) {
      await commitHostCpuReservation(db, {
        hostId,
        runId: reservation.runId,
        nowUnixMs,
      });
      committedRunIds.push(reservation.runId);
      continue;
    }
    if (
      reservation.expiresAt !== null &&
      reservation.expiresAt <= nowUnixMs
    ) {
      await rollbackPendingHostCpuReservation(db, {
        hostId,
        runId: reservation.runId,
      });
      expiredRunIds.push(reservation.runId);
    }
  }

  const [desiredRow] = await db
    .select({ docJson: hostDesiredState.docJson })
    .from(hostDesiredState)
    .where(eq(hostDesiredState.hostId, hostId))
    .limit(1);
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

  if (desired && actual && actualHasAppliedDesired) {
    for (const reservation of reservations) {
      if (
        reservation.state !== "committed" ||
        committedRunIds.includes(reservation.runId)
      ) {
        continue;
      }
      const run = runById.get(reservation.runId);
      const terminalOrDeleting =
        !run ||
        run.activeKey === null ||
        run.deleteRequestedAt !== null ||
        run.completedAt !== null ||
        run.failedAt !== null;
      if (!terminalOrDeleting) {
        continue;
      }
      const desiredRunning = desired.vms.some(
        (vm) =>
          vm.run_id === reservation.runId && vm.desired_phase === "running",
      );
      const actualPresent = actual.vms.some(
        (vm) => vm.run_id === reservation.runId && vm.phase !== "absent",
      );
      if (desiredRunning || actualPresent) {
        continue;
      }
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
    }
  }

  return { committedRunIds, expiredRunIds, releasedRunIds };
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

async function loadReservationCapacity(
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
  const reservedRunIds = new Set(
    reservations.map((reservation) => reservation.runId),
  );
  const reportedReservedCpuMillis = reportedCpuMillisForRuns(
    actual?.reportJson,
    reservedRunIds,
  );
  const reportedUnreservedCpuMillis = Math.max(
    0,
    reported.reportedCommittedCpuMillis - reportedReservedCpuMillis,
  );
  const effectiveCommittedCpuMillis =
    controlPlanePendingCpuMillis +
    controlPlaneCommittedCpuMillis +
    reportedUnreservedCpuMillis;

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

function reportedCpuMillisForRuns(
  report: unknown,
  runIds: ReadonlySet<string>,
): number {
  if (!isRecord(report) || !Array.isArray(report.vms) || runIds.size === 0) {
    return 0;
  }
  return report.vms.reduce((sum, vm) => {
    if (
      !isRecord(vm) ||
      typeof vm.run_id !== "string" ||
      !runIds.has(vm.run_id) ||
      vm.phase === "absent" ||
      !isRecord(vm.resource_state)
    ) {
      return sum;
    }
    const cpuMillis = readNonNegativeInteger(vm.resource_state.cpu_millis);
    return cpuMillis === null ? sum : sum + cpuMillis;
  }, 0);
}

export function strictCpuCapacity(report: unknown): Pick<
  HostCpuReservationCapacity,
  "schedulableCpuMillis" | "reportedCommittedCpuMillis"
> | null {
  if (!isRecord(report)) {
    return null;
  }
  const capacity = isRecord(report.capacity) ? report.capacity : null;
  const capabilities = isRecord(report.capabilities) ? report.capabilities : null;
  if (
    !capacity ||
    !capabilities ||
    capabilities.supports_jailer_v1 !== true ||
    capabilities.supports_hard_cpu_quota !== true ||
    capabilities.supports_landlock !== true ||
    capabilities.supports_cgroup_v2 !== true
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
  const reservedCpuMillis = readNonNegativeInteger(capacity.reserved_cpu_millis);
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
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
