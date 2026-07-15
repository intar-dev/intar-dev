import { and, eq, exists, notExists, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  agentHosts,
  hostActualState,
  hostBenchmarkLeases,
  hostCpuReservations,
  hostDesiredState,
} from "@/db/schema";
import {
  bootCpuReservationForSteadyVms,
  HOST_CPU_RESERVATION_TTL_MS,
  loadHostCpuReservationCapacity,
  reconcileHostCpuReservations,
  strictCpuCapacity,
  type HostCpuReservationCapacity,
} from "@/control-plane/host-cpu-reservations";
import { hostHealth } from "@/lib/host-health";
import { isFreshHostHeartbeat } from "@/lib/scenario-hosts";

export const BENCHMARK_HOST_HEARTBEAT_TTL_MS = 90_000;

export interface HostBenchmarkLeaseIdentity {
  hostId: string;
  runId: string;
  userId: string;
}

export interface HostBenchmarkLeaseRecord extends HostBenchmarkLeaseIdentity {
  acquiredAt: number;
  updatedAt: number;
}

export type AcquireHostBenchmarkLeaseResult =
  | {
      ok: true;
      lease: HostBenchmarkLeaseRecord;
      state: "pending" | "committed";
      expiresAt: number | null;
      capacity: HostCpuReservationCapacity;
    }
  | {
      ok: false;
      reason:
        | "host_not_ready"
        | "benchmark_host_not_drained"
        | "host_benchmark_leased"
        | "boot_capacity_pending"
        | "conflict";
      capacity: HostCpuReservationCapacity | null;
    };

export type ReleaseHostBenchmarkLeaseResult =
  | { ok: true; released: boolean }
  | {
      ok: false;
      reason:
        | "host_not_ready"
        | "benchmark_host_not_drained"
        | "host_benchmark_lease_conflict";
    };

interface BenchmarkHostDrainAttestation {
  hostUpdatedAt: number;
  desiredVersion: number;
  desiredState: typeof hostDesiredState.$inferSelect.docJson;
  appliedDesiredVersion: number;
  actualObservedAt: number;
  actualUpdatedAt: number;
  actualReport: typeof hostActualState.$inferSelect.reportJson;
  capacity: HostCpuReservationCapacity;
}

type BenchmarkHostDrainResult =
  | { ok: true; attestation: BenchmarkHostDrainAttestation }
  | {
      ok: false;
      reason: "host_not_ready" | "benchmark_host_not_drained";
      capacity: HostCpuReservationCapacity | null;
    };

export async function acquireHostBenchmarkLeaseAndReserveCpuInD1(
  db: DrizzleD1Database,
  input: HostBenchmarkLeaseIdentity & {
    steadyCpuMillisByVm: readonly number[];
    nowUnixMs: number;
  },
): Promise<AcquireHostBenchmarkLeaseResult> {
  const steadyCpuMillis = input.steadyCpuMillisByVm.reduce(
    (total, value) => total + value,
    0,
  );
  const bootCpuMillis = bootCpuReservationForSteadyVms(
    input.steadyCpuMillisByVm,
  );
  if (
    !validIdentity(input) ||
    !Number.isSafeInteger(steadyCpuMillis) ||
    steadyCpuMillis <= 0 ||
    !Number.isSafeInteger(input.nowUnixMs) ||
    input.nowUnixMs <= 0
  ) {
    throw new Error("invalid host benchmark lease contract");
  }

  const existing = await loadHostBenchmarkLease(db, input.hostId);
  if (existing) {
    if (!sameLeaseOwner(existing, input)) {
      return {
        ok: false,
        reason: "host_benchmark_leased",
        capacity: null,
      };
    }
    return loadIdempotentAcquisition(db, existing, {
      steadyCpuMillis,
      bootCpuMillis,
    });
  }

  await reconcileHostCpuReservations(db, input.hostId, input.nowUnixMs);
  const drained = await attestBenchmarkHostDrained(db, input, input.nowUnixMs);
  if (!drained.ok) {
    return drained;
  }
  if (bootCpuMillis > drained.attestation.capacity.availableCpuMillis) {
    return {
      ok: false,
      reason: "boot_capacity_pending",
      capacity: drained.attestation.capacity,
    };
  }

  const leaseSelection = db
    .select({
      hostId: sql<string>`${input.hostId}`.as("host_id"),
      runId: sql<string>`${input.runId}`.as("run_id"),
      userId: sql<string>`${input.userId}`.as("user_id"),
      acquiredAt: sql<number>`${input.nowUnixMs}`.as("acquired_at"),
      updatedAt: sql<number>`${input.nowUnixMs}`.as("updated_at"),
    })
    .from(agentHosts)
    .innerJoin(hostDesiredState, eq(hostDesiredState.hostId, agentHosts.id))
    .innerJoin(hostActualState, eq(hostActualState.hostId, agentHosts.id))
    .where(
      and(
        eq(agentHosts.id, input.hostId),
        eq(agentHosts.userId, input.userId),
        eq(agentHosts.role, "agent"),
        eq(agentHosts.disabled, false),
        eq(agentHosts.scenarioEnabled, false),
        eq(agentHosts.connected, true),
        eq(agentHosts.updatedAt, drained.attestation.hostUpdatedAt),
        eq(hostDesiredState.version, drained.attestation.desiredVersion),
        eq(hostDesiredState.docJson, drained.attestation.desiredState),
        eq(
          hostActualState.appliedDesiredVersion,
          drained.attestation.appliedDesiredVersion,
        ),
        eq(hostActualState.observedAt, drained.attestation.actualObservedAt),
        eq(hostActualState.updatedAt, drained.attestation.actualUpdatedAt),
        eq(hostActualState.reportJson, drained.attestation.actualReport),
        notExists(
          db
            .select({ hostId: hostBenchmarkLeases.hostId })
            .from(hostBenchmarkLeases)
            .where(eq(hostBenchmarkLeases.hostId, input.hostId)),
        ),
        notExists(
          db
            .select({ runId: hostCpuReservations.runId })
            .from(hostCpuReservations)
            .where(eq(hostCpuReservations.hostId, input.hostId)),
        ),
      ),
    );
  const reservationSelection = db
    .select({
      runId: sql<string>`${input.runId}`.as("run_id"),
      hostId: sql<string>`${input.hostId}`.as("host_id"),
      cpuMillis: sql<number>`${bootCpuMillis}`.as("cpu_millis"),
      steadyCpuMillis: sql<number>`${steadyCpuMillis}`.as("steady_cpu_millis"),
      bootCpuMillis: sql<number>`${bootCpuMillis}`.as("boot_cpu_millis"),
      quotaPhase: sql<"boot">`'boot'`.as("quota_phase"),
      state: sql<"pending">`'pending'`.as("state"),
      expiresAt:
        sql<number>`${input.nowUnixMs + HOST_CPU_RESERVATION_TTL_MS}`.as(
          "expires_at",
        ),
      createdAt: sql<number>`${input.nowUnixMs}`.as("created_at"),
      updatedAt: sql<number>`${input.nowUnixMs}`.as("updated_at"),
    })
    .from(hostBenchmarkLeases)
    .where(
      and(
        eq(hostBenchmarkLeases.hostId, input.hostId),
        eq(hostBenchmarkLeases.runId, input.runId),
        eq(hostBenchmarkLeases.userId, input.userId),
        eq(hostBenchmarkLeases.acquiredAt, input.nowUnixMs),
      ),
    );

  const [insertedLeases, insertedReservations] = await db.batch([
    db.insert(hostBenchmarkLeases).select(leaseSelection).returning(),
    db.insert(hostCpuReservations).select(reservationSelection).returning(),
  ]);
  const lease = insertedLeases[0];
  const reservation = insertedReservations[0];
  if (!lease || !reservation) {
    const raced = await loadHostBenchmarkLease(db, input.hostId);
    if (raced && !sameLeaseOwner(raced, input)) {
      return {
        ok: false,
        reason: "host_benchmark_leased",
        capacity: null,
      };
    }
    return { ok: false, reason: "conflict", capacity: null };
  }

  const capacity = await loadHostCpuReservationCapacity(db, input.hostId);
  if (!capacity) {
    return { ok: false, reason: "host_not_ready", capacity: null };
  }
  return {
    ok: true,
    lease,
    state: reservation.state,
    expiresAt: reservation.expiresAt,
    capacity,
  };
}

export async function releaseHostBenchmarkLeaseInD1(
  db: DrizzleD1Database,
  input: HostBenchmarkLeaseIdentity & { nowUnixMs: number },
): Promise<ReleaseHostBenchmarkLeaseResult> {
  const existing = await loadHostBenchmarkLease(db, input.hostId);
  if (!existing) {
    return { ok: true, released: false };
  }
  if (!sameLeaseOwner(existing, input)) {
    return { ok: false, reason: "host_benchmark_lease_conflict" };
  }

  const drained = await attestBenchmarkHostDrained(db, input, input.nowUnixMs);
  if (!drained.ok) {
    return { ok: false, reason: drained.reason };
  }
  const [deleted] = await db.batch([
    db
      .delete(hostBenchmarkLeases)
      .where(
        and(
          eq(hostBenchmarkLeases.hostId, input.hostId),
          eq(hostBenchmarkLeases.runId, input.runId),
          eq(hostBenchmarkLeases.userId, input.userId),
          notExists(
            db
              .select({ runId: hostCpuReservations.runId })
              .from(hostCpuReservations)
              .where(eq(hostCpuReservations.hostId, input.hostId)),
          ),
          exists(
            db
              .select({ id: agentHosts.id })
              .from(agentHosts)
              .where(
                and(
                  eq(agentHosts.id, input.hostId),
                  eq(agentHosts.userId, input.userId),
                  eq(agentHosts.role, "agent"),
                  eq(agentHosts.disabled, false),
                  eq(agentHosts.scenarioEnabled, false),
                  eq(agentHosts.connected, true),
                  eq(agentHosts.updatedAt, drained.attestation.hostUpdatedAt),
                ),
              ),
          ),
          exists(
            db
              .select({ hostId: hostDesiredState.hostId })
              .from(hostDesiredState)
              .where(
                and(
                  eq(hostDesiredState.hostId, input.hostId),
                  eq(
                    hostDesiredState.version,
                    drained.attestation.desiredVersion,
                  ),
                  eq(
                    hostDesiredState.docJson,
                    drained.attestation.desiredState,
                  ),
                ),
              ),
          ),
          exists(
            db
              .select({ hostId: hostActualState.hostId })
              .from(hostActualState)
              .where(
                and(
                  eq(hostActualState.hostId, input.hostId),
                  eq(
                    hostActualState.appliedDesiredVersion,
                    drained.attestation.appliedDesiredVersion,
                  ),
                  eq(
                    hostActualState.observedAt,
                    drained.attestation.actualObservedAt,
                  ),
                  eq(
                    hostActualState.updatedAt,
                    drained.attestation.actualUpdatedAt,
                  ),
                  eq(
                    hostActualState.reportJson,
                    drained.attestation.actualReport,
                  ),
                ),
              ),
          ),
        ),
      )
      .returning({ hostId: hostBenchmarkLeases.hostId }),
  ]);
  if (deleted.length > 0) {
    return { ok: true, released: true };
  }
  return { ok: false, reason: "benchmark_host_not_drained" };
}

export async function clearDrainedHostBenchmarkLeaseInD1(
  db: DrizzleD1Database,
  hostId: string,
  nowUnixMs: number,
): Promise<ReleaseHostBenchmarkLeaseResult> {
  const lease = await loadHostBenchmarkLease(db, hostId);
  if (!lease) {
    return { ok: true, released: false };
  }
  return releaseHostBenchmarkLeaseInD1(db, {
    ...lease,
    nowUnixMs,
  });
}

export async function loadHostBenchmarkLease(
  db: DrizzleD1Database,
  hostId: string,
): Promise<HostBenchmarkLeaseRecord | null> {
  const rows = await db
    .select()
    .from(hostBenchmarkLeases)
    .where(eq(hostBenchmarkLeases.hostId, hostId))
    .limit(1);
  return rows[0] ?? null;
}

async function attestBenchmarkHostDrained(
  db: DrizzleD1Database,
  owner: Pick<HostBenchmarkLeaseIdentity, "hostId" | "userId">,
  nowUnixMs: number,
): Promise<BenchmarkHostDrainResult> {
  const rows = await db
    .select({
      hostUserId: agentHosts.userId,
      role: agentHosts.role,
      disabled: agentHosts.disabled,
      scenarioEnabled: agentHosts.scenarioEnabled,
      connected: agentHosts.connected,
      lastHeartbeatAt: agentHosts.lastHeartbeatAt,
      hostUpdatedAt: agentHosts.updatedAt,
      desiredVersion: hostDesiredState.version,
      desiredState: hostDesiredState.docJson,
      appliedDesiredVersion: hostActualState.appliedDesiredVersion,
      actualObservedAt: hostActualState.observedAt,
      actualUpdatedAt: hostActualState.updatedAt,
      actualReport: hostActualState.reportJson,
    })
    .from(agentHosts)
    .leftJoin(hostDesiredState, eq(hostDesiredState.hostId, agentHosts.id))
    .leftJoin(hostActualState, eq(hostActualState.hostId, agentHosts.id))
    .where(eq(agentHosts.id, owner.hostId))
    .limit(1);
  const host = rows[0];
  if (
    !host ||
    host.hostUserId !== owner.userId ||
    host.role !== "agent" ||
    host.disabled ||
    host.scenarioEnabled ||
    !host.connected ||
    !isFreshHostHeartbeat(
      host.lastHeartbeatAt,
      nowUnixMs,
      BENCHMARK_HOST_HEARTBEAT_TTL_MS,
    ) ||
    hostHealth(host.actualUpdatedAt, nowUnixMs) !== "healthy"
  ) {
    return { ok: false, reason: "host_not_ready", capacity: null };
  }
  const reported = strictCpuCapacity(host.actualReport);
  if (!reported) {
    return { ok: false, reason: "host_not_ready", capacity: null };
  }
  const capacity = await loadHostCpuReservationCapacity(db, owner.hostId);
  if (!capacity) {
    return { ok: false, reason: "host_not_ready", capacity: null };
  }
  const reservations = await db
    .select({ runId: hostCpuReservations.runId })
    .from(hostCpuReservations)
    .where(eq(hostCpuReservations.hostId, owner.hostId));
  if (
    host.desiredVersion === null ||
    host.desiredState === null ||
    host.appliedDesiredVersion === null ||
    host.actualObservedAt === null ||
    host.actualUpdatedAt === null ||
    host.actualReport === null ||
    host.desiredState.host_id !== owner.hostId ||
    host.desiredState.version !== host.desiredVersion ||
    host.actualReport.host_id !== owner.hostId ||
    host.appliedDesiredVersion < host.desiredVersion ||
    host.actualReport.applied_desired_version < host.desiredVersion ||
    host.desiredState.vms.some((vm) => vm.desired_phase !== "absent") ||
    host.desiredState.builds.length !== 0 ||
    host.actualReport.vms.length !== 0 ||
    host.actualReport.builds.length !== 0 ||
    !hasStableReadyImageCache(host.desiredState, host.actualReport) ||
    reported.reportedCommittedCpuMillis !== 0 ||
    reservations.length !== 0
  ) {
    return {
      ok: false,
      reason: "benchmark_host_not_drained",
      capacity,
    };
  }

  return {
    ok: true,
    attestation: {
      hostUpdatedAt: host.hostUpdatedAt,
      desiredVersion: host.desiredVersion,
      desiredState: host.desiredState,
      appliedDesiredVersion: host.appliedDesiredVersion,
      actualObservedAt: host.actualObservedAt,
      actualUpdatedAt: host.actualUpdatedAt,
      actualReport: host.actualReport,
      capacity,
    },
  };
}

function hasStableReadyImageCache(
  desired: typeof hostDesiredState.$inferSelect.docJson,
  actual: typeof hostActualState.$inferSelect.reportJson,
): boolean {
  if (desired.cached_images.length !== actual.cached_images.length) {
    return false;
  }
  const desiredByKey = new Map<string, string>();
  for (const image of desired.cached_images) {
    const identity = imageKeyIdentity(image.image_key);
    const sha256 = image.image_sha256.toLowerCase();
    if (
      !identity ||
      !/^[a-f0-9]{64}$/.test(sha256) ||
      desiredByKey.has(identity)
    ) {
      return false;
    }
    desiredByKey.set(identity, sha256);
  }

  const actualKeys = new Set<string>();
  for (const image of actual.cached_images) {
    const identity = imageKeyIdentity(image.image_key);
    const sha256 = image.image_sha256.toLowerCase();
    if (
      !identity ||
      image.phase !== "ready" ||
      image.error != null ||
      !Number.isSafeInteger(image.updated_at_unix_ms) ||
      image.updated_at_unix_ms <= 0 ||
      image.updated_at_unix_ms > actual.observed_at_unix_ms ||
      actualKeys.has(identity) ||
      desiredByKey.get(identity) !== sha256
    ) {
      return false;
    }
    actualKeys.add(identity);
  }
  return actualKeys.size === desiredByKey.size;
}

function imageKeyIdentity(imageKey: {
  scenario: string;
  vm: string;
  arch: string;
}): string {
  return `${imageKey.scenario}\u0000${imageKey.vm}\u0000${imageKey.arch}`;
}

async function loadIdempotentAcquisition(
  db: DrizzleD1Database,
  lease: HostBenchmarkLeaseRecord,
  expected: { steadyCpuMillis: number; bootCpuMillis: number },
): Promise<AcquireHostBenchmarkLeaseResult> {
  const rows = await db
    .select()
    .from(hostCpuReservations)
    .where(
      and(
        eq(hostCpuReservations.hostId, lease.hostId),
        eq(hostCpuReservations.runId, lease.runId),
      ),
    )
    .limit(1);
  const reservation = rows[0];
  if (
    !reservation ||
    reservation.steadyCpuMillis !== expected.steadyCpuMillis ||
    reservation.bootCpuMillis !== expected.bootCpuMillis
  ) {
    return { ok: false, reason: "conflict", capacity: null };
  }
  const capacity = await loadHostCpuReservationCapacity(db, lease.hostId);
  if (!capacity) {
    return { ok: false, reason: "host_not_ready", capacity: null };
  }
  return {
    ok: true,
    lease,
    state: reservation.state,
    expiresAt: reservation.expiresAt,
    capacity,
  };
}

function sameLeaseOwner(
  lease: HostBenchmarkLeaseRecord,
  owner: HostBenchmarkLeaseIdentity,
): boolean {
  return (
    lease.hostId === owner.hostId &&
    lease.runId === owner.runId &&
    lease.userId === owner.userId
  );
}

function validIdentity(identity: HostBenchmarkLeaseIdentity): boolean {
  return [identity.hostId, identity.runId, identity.userId].every(
    (value) => value.trim().length > 0 && value.length <= 128,
  );
}
