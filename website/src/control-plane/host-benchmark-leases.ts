import { and, eq, exists, gte, lt, notExists, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  agentHosts,
  hostActualState,
  hostBenchmarkLeases,
  hostCpuReservations,
  hostDesiredState,
  scenarioRuns,
} from "@/db/schema";
import {
  bootCpuReservationForSteadyVms,
  HOST_CPU_RESERVATION_TTL_MS,
  hostCpuReservationCapacityFromSnapshot,
  reconcileHostCpuReservations,
  strictCpuCapacity,
  type HostCpuReservationCapacity,
  type HostCpuReservationCapacityRow,
} from "@/control-plane/host-cpu-reservations";
import { hostHealth } from "@/lib/host-health";
import {
  hostHasImagesReady,
  type RequiredScenarioImage,
} from "@/lib/scenario-host-readiness";
import { isFreshHostHeartbeat } from "@/lib/scenario-hosts";
import type { HostDesiredStateV2 } from "@/generated/bridge";

export const BENCHMARK_HOST_HEARTBEAT_TTL_MS = 90_000;
export const MAX_BOOT_BENCHMARK_RUNS_PER_CREDENTIAL = 35;
export const MAX_BOOT_BENCHMARK_CREDENTIAL_TTL_MS = 3 * 60 * 60 * 1_000;
const MAX_RESERVATION_CPU_MILLIS = 4_294_967_295;
const MAX_GUEST_VCPU_COUNT = 256;

export interface HostBenchmarkLeaseIdentity {
  hostId: string;
  runId: string;
  userId: string;
}

export interface HostBenchmarkLeaseRecord extends HostBenchmarkLeaseIdentity {
  contractSha256: string;
  credentialNotBeforeUnixMs: number;
  credentialExpiresAtUnixMs: number;
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
      desiredState: HostDesiredStateV2;
    }
  | {
      ok: false;
      reason:
        | "host_not_ready"
        | "image_not_ready"
        | "benchmark_host_not_drained"
        | "host_benchmark_leased"
        | "benchmark_credential_window_invalid"
        | "benchmark_run_limit_reached"
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

interface BenchmarkHostSnapshotRow {
  hostUserId: string;
  role: typeof agentHosts.$inferSelect.role;
  disabled: boolean;
  scenarioEnabled: boolean;
  connected: boolean;
  lastHeartbeatAt: number | null;
  hostUpdatedAt: number;
  desiredVersion: number | null;
  desiredState: typeof hostDesiredState.$inferSelect.docJson | null;
  appliedDesiredVersion: number | null;
  actualObservedAt: number | null;
  actualUpdatedAt: number | null;
  actualReport: typeof hostActualState.$inferSelect.reportJson | null;
}

interface BenchmarkReservationSnapshotRow
  extends HostCpuReservationCapacityRow {
  steadyCpuMillis: number;
  bootCpuMillis: number;
  expiresAt: number | null;
}

interface BenchmarkAdmissionSnapshot {
  lease: HostBenchmarkLeaseRecord | null;
  host: BenchmarkHostSnapshotRow | null;
  reservations: BenchmarkReservationSnapshotRow[];
}

type BenchmarkHostDrainResult =
  | { ok: true; attestation: BenchmarkHostDrainAttestation }
  | {
      ok: false;
      reason:
        | "host_not_ready"
        | "image_not_ready"
        | "benchmark_host_not_drained";
      capacity: HostCpuReservationCapacity | null;
    };

export async function acquireHostBenchmarkLeaseAndReserveCpuInD1(
  db: DrizzleD1Database,
  input: HostBenchmarkLeaseIdentity & {
    steadyCpuMillisByVm: readonly number[];
    guestVcpuCountByVm: readonly number[];
    requiredImages: readonly RequiredScenarioImage[];
    credentialNotBeforeUnixMs: number;
    credentialExpiresAtUnixMs: number;
    nowUnixMs: number;
  },
): Promise<AcquireHostBenchmarkLeaseResult> {
  const requiredImages = normalizeRequiredImages(input.requiredImages);
  if (
    !validIdentity(input) ||
    !validCpuVector(input.steadyCpuMillisByVm) ||
    !validGuestVcpuVector(input.guestVcpuCountByVm) ||
    input.steadyCpuMillisByVm.length !== input.guestVcpuCountByVm.length ||
    requiredImages === null ||
    !validCredentialWindow(
      input.credentialNotBeforeUnixMs,
      input.credentialExpiresAtUnixMs,
    ) ||
    !Number.isSafeInteger(input.nowUnixMs) ||
    input.nowUnixMs <= 0
  ) {
    throw new Error("invalid host benchmark lease contract");
  }
  const steadyCpuMillis = input.steadyCpuMillisByVm.reduce(
    (total, value) => total + value,
    0,
  );
  const bootCpuMillis = bootCpuReservationForSteadyVms(
    input.steadyCpuMillisByVm,
  );
  if (!Number.isSafeInteger(steadyCpuMillis) || steadyCpuMillis <= 0) {
    throw new Error("invalid host benchmark lease contract");
  }
  const contractSha256 = await benchmarkAdmissionContractSha256({
    steadyCpuMillisByVm: input.steadyCpuMillisByVm,
    guestVcpuCountByVm: input.guestVcpuCountByVm,
    requiredImages,
  });

  let snapshot = await loadBenchmarkAdmissionSnapshot(db, input.hostId);
  const existing = snapshot.lease;
  if (existing) {
    if (!sameLeaseOwner(existing, input)) {
      return {
        ok: false,
        reason: "host_benchmark_leased",
        capacity: null,
      };
    }
    return loadIdempotentAcquisitionFromSnapshot(existing, snapshot, {
      steadyCpuMillis,
      bootCpuMillis,
      contractSha256,
      credentialNotBeforeUnixMs: input.credentialNotBeforeUnixMs,
      credentialExpiresAtUnixMs: input.credentialExpiresAtUnixMs,
    });
  }

  if (
    input.nowUnixMs < input.credentialNotBeforeUnixMs ||
    input.nowUnixMs >= input.credentialExpiresAtUnixMs
  ) {
    return {
      ok: false,
      reason: "benchmark_credential_window_invalid",
      capacity: null,
    };
  }

  if (snapshot.reservations.length > 0) {
    await reconcileHostCpuReservations(db, input.hostId, input.nowUnixMs);
    snapshot = await loadBenchmarkAdmissionSnapshot(db, input.hostId);
    if (snapshot.lease) {
      if (!sameLeaseOwner(snapshot.lease, input)) {
        return {
          ok: false,
          reason: "host_benchmark_leased",
          capacity: null,
        };
      }
      return loadIdempotentAcquisitionFromSnapshot(snapshot.lease, snapshot, {
        steadyCpuMillis,
        bootCpuMillis,
        contractSha256,
        credentialNotBeforeUnixMs: input.credentialNotBeforeUnixMs,
        credentialExpiresAtUnixMs: input.credentialExpiresAtUnixMs,
      });
    }
  }
  const drained = attestBenchmarkHostDrainedSnapshot(
    snapshot,
    input,
    input.nowUnixMs,
    requiredImages,
  );
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
      contractSha256: sql<string>`${contractSha256}`.as("contract_sha256"),
      credentialNotBeforeUnixMs:
        sql<number>`${input.credentialNotBeforeUnixMs}`.as(
          "credential_not_before_unix_ms",
        ),
      credentialExpiresAtUnixMs:
        sql<number>`${input.credentialExpiresAtUnixMs}`.as(
          "credential_expires_at_unix_ms",
        ),
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
        sql`(
          SELECT count(*)
          FROM ${scenarioRuns}
          WHERE ${scenarioRuns.userId} = ${input.userId}
            AND ${scenarioRuns.hostId} = ${input.hostId}
            AND ${scenarioRuns.scenarioId} = 'broken-nginx'
            AND ${scenarioRuns.createdAt} >= ${input.credentialNotBeforeUnixMs}
            AND ${scenarioRuns.createdAt} < ${input.credentialExpiresAtUnixMs}
        ) < ${MAX_BOOT_BENCHMARK_RUNS_PER_CREDENTIAL}`,
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

  const runCountSelection = db
    .select({ count: sql<number>`count(*)` })
    .from(scenarioRuns)
    .where(
      and(
        eq(scenarioRuns.userId, input.userId),
        eq(scenarioRuns.hostId, input.hostId),
        eq(scenarioRuns.scenarioId, "broken-nginx"),
        gte(scenarioRuns.createdAt, input.credentialNotBeforeUnixMs),
        lt(scenarioRuns.createdAt, input.credentialExpiresAtUnixMs),
      ),
    );
  const [insertedLeases, insertedReservations, benchmarkRunCounts] =
    await db.batch([
      db.insert(hostBenchmarkLeases).select(leaseSelection).returning(),
      db.insert(hostCpuReservations).select(reservationSelection).returning(),
      runCountSelection,
    ]);
  const lease = insertedLeases[0];
  const reservation = insertedReservations[0];
  if (!lease || !reservation) {
    if (
      (benchmarkRunCounts[0]?.count ?? 0) >=
      MAX_BOOT_BENCHMARK_RUNS_PER_CREDENTIAL
    ) {
      return {
        ok: false,
        reason: "benchmark_run_limit_reached",
        capacity: null,
      };
    }
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

  return {
    ok: true,
    lease,
    state: reservation.state,
    expiresAt: reservation.expiresAt,
    capacity: capacityAfterPendingBootReservation(
      drained.attestation.capacity,
      bootCpuMillis,
    ),
    desiredState: drained.attestation.desiredState,
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
    return {
      ok: false,
      reason:
        drained.reason === "image_not_ready"
          ? "benchmark_host_not_drained"
          : drained.reason,
    };
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

async function loadBenchmarkAdmissionSnapshot(
  db: DrizzleD1Database,
  hostId: string,
): Promise<BenchmarkAdmissionSnapshot> {
  const [leases, hosts, reservations] = await db.batch([
    db
      .select()
      .from(hostBenchmarkLeases)
      .where(eq(hostBenchmarkLeases.hostId, hostId))
      .limit(1),
    db
      .select({
        hostUserId: agentHosts.userId,
        role: agentHosts.role,
        disabled: agentHosts.disabled,
        scenarioEnabled: agentHosts.scenarioEnabled,
        connected: agentHosts.connected,
        lastHeartbeatAt: agentHosts.lastHeartbeatAt,
        hostUpdatedAt: sql<number>`${agentHosts.updatedAt}`.as(
          "host_updated_at",
        ),
        desiredVersion: hostDesiredState.version,
        desiredStateRaw: sql<unknown>`${hostDesiredState.docJson}`.as(
          "desired_state_raw",
        ),
        appliedDesiredVersion: hostActualState.appliedDesiredVersion,
        actualObservedAt: hostActualState.observedAt,
        actualUpdatedAt: sql<number>`${hostActualState.updatedAt}`.as(
          "actual_updated_at",
        ),
        actualReportRaw: sql<unknown>`${hostActualState.reportJson}`.as(
          "actual_report_raw",
        ),
      })
      .from(agentHosts)
      .innerJoin(hostDesiredState, eq(hostDesiredState.hostId, agentHosts.id))
      .innerJoin(hostActualState, eq(hostActualState.hostId, agentHosts.id))
      .where(eq(agentHosts.id, hostId))
      .limit(1),
    db
      .select({
        runId: hostCpuReservations.runId,
        cpuMillis: hostCpuReservations.cpuMillis,
        steadyCpuMillis: hostCpuReservations.steadyCpuMillis,
        bootCpuMillis: hostCpuReservations.bootCpuMillis,
        quotaPhase: hostCpuReservations.quotaPhase,
        state: hostCpuReservations.state,
        expiresAt: hostCpuReservations.expiresAt,
      })
      .from(hostCpuReservations)
      .where(eq(hostCpuReservations.hostId, hostId)),
  ]);
  return {
    lease: leases[0] ?? null,
    host: hosts[0]
      ? {
          ...hosts[0],
          desiredState: parseJsonValue<
            typeof hostDesiredState.$inferSelect.docJson
          >(hosts[0].desiredStateRaw),
          actualReport: parseJsonValue<
            typeof hostActualState.$inferSelect.reportJson
          >(hosts[0].actualReportRaw),
        }
      : null,
    reservations,
  };
}

function parseJsonValue<T>(raw: unknown): T | null {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
  return raw !== null && typeof raw === "object" ? (raw as T) : null;
}

async function attestBenchmarkHostDrained(
  db: DrizzleD1Database,
  owner: Pick<HostBenchmarkLeaseIdentity, "hostId" | "userId">,
  nowUnixMs: number,
  requiredImages: readonly RequiredScenarioImage[] = [],
): Promise<BenchmarkHostDrainResult> {
  return attestBenchmarkHostDrainedSnapshot(
    await loadBenchmarkAdmissionSnapshot(db, owner.hostId),
    owner,
    nowUnixMs,
    requiredImages,
  );
}

function attestBenchmarkHostDrainedSnapshot(
  snapshot: BenchmarkAdmissionSnapshot,
  owner: Pick<HostBenchmarkLeaseIdentity, "hostId" | "userId">,
  nowUnixMs: number,
  requiredImages: readonly RequiredScenarioImage[],
): BenchmarkHostDrainResult {
  const host = snapshot.host;
  if (
    !host ||
    host.hostUserId !== owner.userId ||
    host.role !== "agent" ||
    host.disabled ||
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
  const capacity = hostCpuReservationCapacityFromSnapshot(
    host.actualReport,
    snapshot.reservations,
  );
  if (!capacity) {
    return { ok: false, reason: "host_not_ready", capacity: null };
  }
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
    host.scenarioEnabled ||
    reported.reportedCommittedCpuMillis !== 0 ||
    snapshot.reservations.length !== 0
  ) {
    return {
      ok: false,
      reason: "benchmark_host_not_drained",
      capacity,
    };
  }
  if (!hostHasImagesReady(host.actualReport, requiredImages)) {
    return { ok: false, reason: "image_not_ready", capacity };
  }
  if (!hasStableReadyImageCache(host.desiredState, host.actualReport)) {
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

function loadIdempotentAcquisitionFromSnapshot(
  lease: HostBenchmarkLeaseRecord,
  snapshot: BenchmarkAdmissionSnapshot,
  expected: {
    steadyCpuMillis: number;
    bootCpuMillis: number;
    contractSha256: string;
    credentialNotBeforeUnixMs: number;
    credentialExpiresAtUnixMs: number;
  },
): AcquireHostBenchmarkLeaseResult {
  const reservation = snapshot.reservations.find(
    (candidate) => candidate.runId === lease.runId,
  );
  if (
    !reservation ||
    reservation.steadyCpuMillis !== expected.steadyCpuMillis ||
    reservation.bootCpuMillis !== expected.bootCpuMillis ||
    lease.contractSha256 !== expected.contractSha256 ||
    lease.credentialNotBeforeUnixMs !==
      expected.credentialNotBeforeUnixMs ||
    lease.credentialExpiresAtUnixMs !== expected.credentialExpiresAtUnixMs
  ) {
    return { ok: false, reason: "conflict", capacity: null };
  }
  const capacity = hostCpuReservationCapacityFromSnapshot(
    snapshot.host?.actualReport,
    snapshot.reservations,
  );
  if (!capacity) {
    return { ok: false, reason: "host_not_ready", capacity: null };
  }
  const desiredState = snapshot.host?.desiredState;
  if (!desiredState) {
    return { ok: false, reason: "host_not_ready", capacity: null };
  }
  return {
    ok: true,
    lease,
    state: reservation.state,
    expiresAt: reservation.expiresAt,
    capacity,
    desiredState,
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

function capacityAfterPendingBootReservation(
  capacity: HostCpuReservationCapacity,
  bootCpuMillis: number,
): HostCpuReservationCapacity {
  return {
    ...capacity,
    controlPlanePendingCpuMillis:
      capacity.controlPlanePendingCpuMillis + bootCpuMillis,
    controlPlaneBootCpuMillis:
      capacity.controlPlaneBootCpuMillis + bootCpuMillis,
    effectiveCommittedCpuMillis:
      capacity.effectiveCommittedCpuMillis + bootCpuMillis,
    availableCpuMillis: capacity.availableCpuMillis - bootCpuMillis,
  };
}

function normalizeRequiredImages(
  requiredImages: readonly RequiredScenarioImage[],
): RequiredScenarioImage[] | null {
  if (requiredImages.length === 0 || requiredImages.length > 256) {
    return null;
  }
  const identities = new Set<string>();
  const normalized: RequiredScenarioImage[] = [];
  for (const image of requiredImages) {
    const scenario = image.imageKey.scenario.trim();
    const vm = image.imageKey.vm.trim();
    const imageSha256 = image.imageSha256.toLowerCase();
    const imageKey = { scenario, vm, arch: image.imageKey.arch };
    const identity = imageKeyIdentity(imageKey);
    if (
      !scenario ||
      scenario.length > 128 ||
      !vm ||
      vm.length > 128 ||
      (imageKey.arch !== "x86_64" && imageKey.arch !== "aarch64") ||
      identities.has(identity) ||
      !/^[a-f0-9]{64}$/.test(imageSha256)
    ) {
      return null;
    }
    identities.add(identity);
    normalized.push({ imageKey, imageSha256 });
  }
  return normalized.sort((left, right) => {
    const leftIdentity = imageKeyIdentity(left.imageKey);
    const rightIdentity = imageKeyIdentity(right.imageKey);
    return leftIdentity < rightIdentity
      ? -1
      : leftIdentity > rightIdentity
        ? 1
        : 0;
  });
}

function validCpuVector(values: readonly number[]): boolean {
  return (
    values.length > 0 &&
    values.length <= 256 &&
    values.every(
      (value) =>
        Number.isSafeInteger(value) &&
        value > 0 &&
        value <= MAX_RESERVATION_CPU_MILLIS,
    )
  );
}

function validGuestVcpuVector(values: readonly number[]): boolean {
  return (
    values.length > 0 &&
    values.length <= 256 &&
    values.every(
      (value) =>
        Number.isSafeInteger(value) &&
        value > 0 &&
        value <= MAX_GUEST_VCPU_COUNT,
    )
  );
}

function validCredentialWindow(notBefore: number, expiresAt: number): boolean {
  return (
    Number.isSafeInteger(notBefore) &&
    notBefore > 0 &&
    Number.isSafeInteger(expiresAt) &&
    expiresAt > notBefore &&
    expiresAt - notBefore <= MAX_BOOT_BENCHMARK_CREDENTIAL_TTL_MS
  );
}

export async function benchmarkAdmissionContractSha256(input: {
  steadyCpuMillisByVm: readonly number[];
  guestVcpuCountByVm: readonly number[];
  requiredImages: readonly RequiredScenarioImage[];
}): Promise<string> {
  const requiredImages = normalizeRequiredImages(input.requiredImages);
  if (
    !validCpuVector(input.steadyCpuMillisByVm) ||
    !validGuestVcpuVector(input.guestVcpuCountByVm) ||
    input.steadyCpuMillisByVm.length !== input.guestVcpuCountByVm.length ||
    requiredImages === null
  ) {
    throw new Error("invalid host benchmark admission contract");
  }
  const canonical = JSON.stringify({
    schemaVersion: 1,
    steadyCpuMillisByVm: [...input.steadyCpuMillisByVm],
    guestVcpuCountByVm: [...input.guestVcpuCountByVm],
    requiredImages: requiredImages.map((image) => ({
      scenario: image.imageKey.scenario,
      vm: image.imageKey.vm,
      arch: image.imageKey.arch,
      imageSha256: image.imageSha256,
    })),
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function validIdentity(identity: HostBenchmarkLeaseIdentity): boolean {
  return [identity.hostId, identity.runId, identity.userId].every(
    (value) => value.trim().length > 0 && value.length <= 128,
  );
}
