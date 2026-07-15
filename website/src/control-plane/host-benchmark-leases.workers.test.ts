/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import {
  acquireHostBenchmarkLeaseAndReserveCpuInD1,
  clearDrainedHostBenchmarkLeaseInD1,
  loadHostBenchmarkLease,
  releaseHostBenchmarkLeaseInD1,
} from "@/control-plane/host-benchmark-leases";
import {
  HOST_CPU_RESERVATION_TTL_MS,
  reconcileHostCpuReservations,
  reserveHostCpuInD1,
} from "@/control-plane/host-cpu-reservations";
import {
  agentHosts,
  hostActualState,
  hostBenchmarkLeases,
  hostCpuReservations,
  hostDesiredState,
  scenarioRuns,
  user,
} from "@/db/schema";
import type { HostStateReportV2 } from "@/generated/bridge";
import { createEmptyHostDesiredState } from "@/lib/desired-state";
import {
  RUN_PHASE_ORDER,
  buildInitialRunState,
  recomputeRunState,
} from "@/lib/run-state";
import { resetD1Database } from "@/test/d1-migrations";

const USER_ID = "benchmark-user";

describe("exclusive benchmark host leases", () => {
  beforeEach(async () => {
    await resetD1Database();
  });

  it("atomically acquires one disabled drained host and is idempotent after a timeout", async () => {
    const now = Date.now();
    const hostId = "benchmark-host-idempotent";
    const runId = "benchmark-run-idempotent";
    await seedBenchmarkHost(hostId, now);
    const db = drizzle(env.DB);
    const input = {
      hostId,
      runId,
      userId: USER_ID,
      steadyCpuMillisByVm: [1_000],
      nowUnixMs: now,
    } as const;

    await expect(
      acquireHostBenchmarkLeaseAndReserveCpuInD1(db, input),
    ).resolves.toMatchObject({
      ok: true,
      lease: { hostId, runId, userId: USER_ID },
      state: "pending",
      capacity: { availableCpuMillis: 2_000 },
    });

    // A caller that timed out after the transaction committed can safely retry.
    await expect(
      acquireHostBenchmarkLeaseAndReserveCpuInD1(db, {
        ...input,
        nowUnixMs: now + 1,
      }),
    ).resolves.toMatchObject({
      ok: true,
      lease: { hostId, runId, userId: USER_ID, acquiredAt: now },
      state: "pending",
    });

    await expect(
      db
        .select()
        .from(hostBenchmarkLeases)
        .where(eq(hostBenchmarkLeases.hostId, hostId)),
    ).resolves.toHaveLength(1);
    await expect(
      db
        .select()
        .from(hostCpuReservations)
        .where(eq(hostCpuReservations.hostId, hostId)),
    ).resolves.toEqual([
      expect.objectContaining({
        runId,
        cpuMillis: 2_000,
        steadyCpuMillis: 1_000,
        bootCpuMillis: 2_000,
        quotaPhase: "boot",
        state: "pending",
      }),
    ]);
  });

  it("rejects acquisition when same-timestamp inventory contents change before the atomic insert", async () => {
    const now = Date.now();
    const hostId = "benchmark-host-acquire-content-race";
    const runId = "benchmark-run-acquire-content-race";
    await seedBenchmarkHost(hostId, now);
    const report = strictEmptyReport(hostId, 4_000, 0, now);
    report.vms = [foreignActualVm(now)];
    const db = withBeforeNextBatchHook(drizzle(env.DB), async () => {
      await overwriteActualReportWithoutAdvancingFences(hostId, report);
    });

    await expect(
      acquireHostBenchmarkLeaseAndReserveCpuInD1(db, {
        hostId,
        runId,
        userId: USER_ID,
        steadyCpuMillisByVm: [1_000],
        nowUnixMs: now,
      }),
    ).resolves.toEqual({ ok: false, reason: "conflict", capacity: null });
    await expect(
      drizzle(env.DB)
        .select()
        .from(hostBenchmarkLeases)
        .where(eq(hostBenchmarkLeases.hostId, hostId)),
    ).resolves.toHaveLength(0);
    await expect(
      drizzle(env.DB)
        .select()
        .from(hostCpuReservations)
        .where(eq(hostCpuReservations.hostId, hostId)),
    ).resolves.toHaveLength(0);
  });

  it("retains the lease when same-timestamp inventory contents change before release", async () => {
    const now = Date.now();
    const hostId = "benchmark-host-release-content-race";
    const runId = "benchmark-run-release-content-race";
    await seedBenchmarkHost(hostId, now);
    const db = drizzle(env.DB);
    await acquireHostBenchmarkLeaseAndReserveCpuInD1(db, {
      hostId,
      runId,
      userId: USER_ID,
      steadyCpuMillisByVm: [1_000],
      nowUnixMs: now,
    });
    await db
      .delete(hostCpuReservations)
      .where(eq(hostCpuReservations.runId, runId));

    const report = strictEmptyReport(hostId, 4_000, 0, now);
    report.vms = [foreignActualVm(now)];
    const racedDb = withBeforeNextBatchHook(db, async () => {
      await overwriteActualReportWithoutAdvancingFences(hostId, report);
    });
    await expect(
      releaseHostBenchmarkLeaseInD1(racedDb, {
        hostId,
        runId,
        userId: USER_ID,
        nowUnixMs: now,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "benchmark_host_not_drained",
    });
    await expect(loadHostBenchmarkLease(db, hostId)).resolves.toMatchObject({
      hostId,
      runId,
      userId: USER_ID,
    });
  });

  it("serializes v2 acquisition through the host runtime endpoint", async () => {
    const now = Date.now();
    const hostId = "benchmark-host-runtime";
    const runId = "benchmark-run-runtime";
    await seedBenchmarkHost(hostId, now);
    const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName(hostId));
    const request = () =>
      stub.fetch(
        "http://host-runtime/_internal/cpu-reservations/benchmark-acquire",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            hostId,
            runId,
            userId: USER_ID,
            steadyCpuMillisByVm: [1_000],
          }),
        },
      );

    const responses = await Promise.all([request(), request()]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    await expect(responses[0]?.json()).resolves.toMatchObject({
      ok: true,
      lease: { hostId, runId, userId: USER_ID },
    });
    await expect(responses[1]?.json()).resolves.toMatchObject({
      ok: true,
      lease: { hostId, runId, userId: USER_ID },
    });
    await expect(
      drizzle(env.DB)
        .select()
        .from(hostCpuReservations)
        .where(eq(hostCpuReservations.hostId, hostId)),
    ).resolves.toHaveLength(1);
  });

  it("blocks ordinary and database-level cross-run scheduling while leased", async () => {
    const now = Date.now();
    const hostId = "benchmark-host-exclusive";
    const runId = "benchmark-run-exclusive";
    await seedBenchmarkHost(hostId, now);
    const db = drizzle(env.DB);
    await acquireHostBenchmarkLeaseAndReserveCpuInD1(db, {
      hostId,
      runId,
      userId: USER_ID,
      steadyCpuMillisByVm: [1_000],
      nowUnixMs: now,
    });

    await expect(
      reserveHostCpuInD1(db, {
        hostId,
        runId: "foreign-run",
        steadyCpuMillisByVm: [125],
        nowUnixMs: now + 1,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "host_benchmark_leased",
      capacity: null,
    });
    await expect(
      acquireHostBenchmarkLeaseAndReserveCpuInD1(db, {
        hostId,
        runId: "foreign-benchmark-run",
        userId: USER_ID,
        steadyCpuMillisByVm: [1_000],
        nowUnixMs: now + 1,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "host_benchmark_leased",
      capacity: null,
    });

    await expect(
      env.DB.prepare(
        "INSERT INTO host_cpu_reservations (run_id, host_id, cpu_millis, steady_cpu_millis, boot_cpu_millis, quota_phase, state, expires_at, created_at, updated_at) VALUES (?, ?, 2000, 1000, 2000, 'boot', 'pending', ?, ?, ?)",
      )
        .bind("database-bypass-run", hostId, now + 60_000, now, now)
        .run(),
    ).rejects.toThrow(/exclusive benchmark lease/);
    await expect(
      env.DB.prepare("UPDATE agent_hosts SET scenario_enabled = 1 WHERE id = ?")
        .bind(hostId)
        .run(),
    ).rejects.toThrow(/cannot be enabled while a benchmark lease exists/);
    await expect(
      env.DB.prepare(
        "UPDATE host_benchmark_leases SET run_id = ? WHERE host_id = ?",
      )
        .bind("retargeted-run", hostId)
        .run(),
    ).rejects.toThrow(/benchmark lease identity is immutable/);
  });

  it("fails closed before allocation and leaves no partial lease", async () => {
    const now = Date.now();
    const db = drizzle(env.DB);
    const enabledHostId = "benchmark-host-enabled";
    await seedBenchmarkHost(enabledHostId, now, {
      scenarioEnabled: true,
    });
    await expect(
      acquireHostBenchmarkLeaseAndReserveCpuInD1(db, {
        hostId: enabledHostId,
        runId: "run-enabled",
        userId: USER_ID,
        steadyCpuMillisByVm: [1_000],
        nowUnixMs: now,
      }),
    ).resolves.toMatchObject({ ok: false, reason: "host_not_ready" });

    const undersizedHostId = "benchmark-host-undersized";
    await seedBenchmarkHost(undersizedHostId, now, {
      schedulableCpuMillis: 1_000,
    });
    await expect(
      acquireHostBenchmarkLeaseAndReserveCpuInD1(db, {
        hostId: undersizedHostId,
        runId: "run-undersized",
        userId: USER_ID,
        steadyCpuMillisByVm: [1_000],
        nowUnixMs: now,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "boot_capacity_pending",
    });

    await expect(db.select().from(hostBenchmarkLeases)).resolves.toHaveLength(
      0,
    );
    await expect(db.select().from(hostCpuReservations)).resolves.toHaveLength(
      0,
    );
    await expect(
      env.DB.prepare(
        "INSERT INTO host_benchmark_leases (host_id, run_id, user_id, acquired_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
        .bind(enabledHostId, "database-bypass", USER_ID, now, now)
        .run(),
    ).rejects.toThrow(/requires scenario scheduling to remain disabled/);

    const reservedHostId = "benchmark-host-already-reserved";
    await seedBenchmarkHost(reservedHostId, now);
    await reserveHostCpuInD1(db, {
      hostId: reservedHostId,
      runId: "existing-run",
      steadyCpuMillisByVm: [125],
      nowUnixMs: now,
    });
    await expect(
      acquireHostBenchmarkLeaseAndReserveCpuInD1(db, {
        hostId: reservedHostId,
        runId: "benchmark-after-reservation",
        userId: USER_ID,
        steadyCpuMillisByVm: [1_000],
        nowUnixMs: now + 1,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "benchmark_host_not_drained",
    });
    await expect(
      env.DB.prepare(
        "INSERT INTO host_benchmark_leases (host_id, run_id, user_id, acquired_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
        .bind(reservedHostId, "database-reservation-bypass", USER_ID, now, now)
        .run(),
    ).rejects.toThrow(/requires a host with zero CPU reservations/);
  });

  it("never time-expires into scheduling and releases only after fresh applied emptiness", async () => {
    const now = Date.now();
    const hostId = "benchmark-host-recovery";
    const runId = "benchmark-run-recovery";
    await seedBenchmarkHost(hostId, now);
    const db = drizzle(env.DB);
    await acquireHostBenchmarkLeaseAndReserveCpuInD1(db, {
      hostId,
      runId,
      userId: USER_ID,
      steadyCpuMillisByVm: [1_000],
      nowUnixMs: now,
    });

    await expect(
      releaseHostBenchmarkLeaseInD1(db, {
        hostId,
        runId,
        userId: "foreign-user",
        nowUnixMs: now + 1,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "host_benchmark_lease_conflict",
    });

    const recoveryNow = now + 120_000;
    await reconcileHostCpuReservations(db, hostId, recoveryNow);
    await expect(loadHostBenchmarkLease(db, hostId)).resolves.not.toBeNull();

    const desired = createEmptyHostDesiredState({
      hostId,
      nowUnixMs: recoveryNow,
    });
    desired.version = 1;
    await db
      .update(hostDesiredState)
      .set({ version: 1, docJson: desired, updatedAt: recoveryNow })
      .where(eq(hostDesiredState.hostId, hostId));
    await refreshHostEvidence(hostId, recoveryNow, {
      appliedDesiredVersion: 0,
    });
    await expect(
      clearDrainedHostBenchmarkLeaseInD1(db, hostId, recoveryNow),
    ).resolves.toEqual({
      ok: false,
      reason: "benchmark_host_not_drained",
    });
    await expect(loadHostBenchmarkLease(db, hostId)).resolves.not.toBeNull();

    await refreshHostEvidence(hostId, recoveryNow + 1, {
      appliedDesiredVersion: 1,
    });
    await expect(
      clearDrainedHostBenchmarkLeaseInD1(db, hostId, recoveryNow + 1),
    ).resolves.toEqual({ ok: true, released: true });
    await expect(loadHostBenchmarkLease(db, hostId)).resolves.toBeNull();
    await expect(
      db
        .select()
        .from(hostCpuReservations)
        .where(eq(hostCpuReservations.hostId, hostId)),
    ).resolves.toHaveLength(0);
  });

  it("fails and releases a run persisted before its desired VMs after the admission TTL", async () => {
    const now = Date.now();
    const hostId = "benchmark-host-start-crash";
    const runId = "benchmark-run-start-crash";
    await seedBenchmarkHost(hostId, now);
    const db = drizzle(env.DB);
    await acquireHostBenchmarkLeaseAndReserveCpuInD1(db, {
      hostId,
      runId,
      userId: USER_ID,
      steadyCpuMillisByVm: [1_000],
      nowUnixMs: now,
    });
    await seedPersistedRunBeforeDesiredState(db, hostId, runId, now);

    await expect(
      reconcileHostCpuReservations(
        db,
        hostId,
        now + HOST_CPU_RESERVATION_TTL_MS,
      ),
    ).resolves.toMatchObject({
      committedRunIds: [],
      expiredRunIds: [runId],
    });
    await expect(
      db
        .select({
          state: scenarioRuns.state,
          activeKey: scenarioRuns.activeKey,
          failedAt: scenarioRuns.failedAt,
        })
        .from(scenarioRuns)
        .where(eq(scenarioRuns.runId, runId)),
    ).resolves.toEqual([
      expect.objectContaining({
        state: "failed",
        activeKey: null,
        failedAt: expect.any(Number),
      }),
    ]);
    await expect(
      db
        .select()
        .from(hostCpuReservations)
        .where(eq(hostCpuReservations.runId, runId)),
    ).resolves.toHaveLength(0);

    const recoveryNow = now + HOST_CPU_RESERVATION_TTL_MS + 1;
    await refreshHostEvidence(hostId, recoveryNow, {
      appliedDesiredVersion: 0,
    });
    await expect(
      clearDrainedHostBenchmarkLeaseInD1(db, hostId, recoveryNow),
    ).resolves.toEqual({ ok: true, released: true });

    const [desiredRow] = await db
      .select()
      .from(hostDesiredState)
      .where(eq(hostDesiredState.hostId, hostId));
    expect(desiredRow).toBeDefined();
    await expect(
      db
        .update(hostDesiredState)
        .set({
          version: 1,
          docJson: {
            ...desiredRow!.docJson,
            version: 1,
            vms: [desiredVm(runId, `${runId}-vm`, recoveryNow)],
          },
          updatedAt: recoveryNow,
        })
        .where(eq(hostDesiredState.hostId, hostId)),
    ).rejects.toThrow();
    await expect(
      db
        .select({ version: hostDesiredState.version })
        .from(hostDesiredState)
        .where(eq(hostDesiredState.hostId, hostId)),
    ).resolves.toEqual([{ version: 0 }]);
  });

  it("freezes cache prewarm while leased and rejects a non-ready cache attestation", async () => {
    const now = Date.now();
    const hostId = "benchmark-host-cache-fence";
    const runId = "benchmark-run-cache-fence";
    const image = {
      image_key: {
        scenario: "broken-nginx",
        vm: "webserver",
        arch: "x86_64" as const,
      },
      image_sha256: "2".repeat(64),
    };
    await seedBenchmarkHost(hostId, now);
    const db = drizzle(env.DB);
    const [desiredRow] = await db
      .select()
      .from(hostDesiredState)
      .where(eq(hostDesiredState.hostId, hostId));
    await db
      .update(hostDesiredState)
      .set({
        version: 1,
        docJson: {
          ...desiredRow!.docJson,
          version: 1,
          cached_images: [image],
        },
        updatedAt: now + 1,
      })
      .where(eq(hostDesiredState.hostId, hostId));
    const [actualRow] = await db
      .select()
      .from(hostActualState)
      .where(eq(hostActualState.hostId, hostId));
    await db
      .update(hostActualState)
      .set({
        appliedDesiredVersion: 1,
        observedAt: now + 1,
        updatedAt: now + 1,
        reportJson: {
          ...actualRow!.reportJson,
          observed_at_unix_ms: now + 1,
          applied_desired_version: 1,
          cached_images: [
            {
              ...image,
              phase: "downloading",
              updated_at_unix_ms: now + 1,
            },
          ],
        },
      })
      .where(eq(hostActualState.hostId, hostId));

    await expect(
      acquireHostBenchmarkLeaseAndReserveCpuInD1(db, {
        hostId,
        runId,
        userId: USER_ID,
        steadyCpuMillisByVm: [1_000],
        nowUnixMs: now + 1,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "benchmark_host_not_drained",
    });

    await db
      .update(hostActualState)
      .set({
        observedAt: now + 2,
        updatedAt: now + 2,
        reportJson: {
          ...actualRow!.reportJson,
          observed_at_unix_ms: now + 2,
          applied_desired_version: 1,
          cached_images: [
            {
              ...image,
              phase: "ready",
              updated_at_unix_ms: now + 2,
            },
          ],
        },
      })
      .where(eq(hostActualState.hostId, hostId));
    await expect(
      acquireHostBenchmarkLeaseAndReserveCpuInD1(db, {
        hostId,
        runId,
        userId: USER_ID,
        steadyCpuMillisByVm: [1_000],
        nowUnixMs: now + 2,
      }),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      db
        .update(hostDesiredState)
        .set({
          version: 2,
          docJson: {
            ...desiredRow!.docJson,
            version: 2,
            cached_images: [
              image,
              {
                image_key: {
                  scenario: "pair-ping",
                  vm: "client",
                  arch: "x86_64" as const,
                },
                image_sha256: "3".repeat(64),
              },
            ],
          },
          updatedAt: now + 3,
        })
        .where(eq(hostDesiredState.hostId, hostId)),
    ).rejects.toThrow();
    await expect(
      db
        .select({ version: hostDesiredState.version })
        .from(hostDesiredState)
        .where(eq(hostDesiredState.hostId, hostId)),
    ).resolves.toEqual([{ version: 1 }]);
  });
});

async function seedPersistedRunBeforeDesiredState(
  db: ReturnType<typeof drizzle>,
  hostId: string,
  runId: string,
  now: number,
): Promise<void> {
  const initial = buildInitialRunState({
    vms: [
      {
        id: `${runId}-vm-id`,
        ordinal: 0,
        scenarioVmId: "broken-nginx:webserver",
        scenarioVmName: "webserver",
        runtimeVmName: `${runId}-vm`,
        hostname: "webserver",
        launchSummary: {
          scenarioVmName: "webserver",
          hostname: "webserver",
          probePhaseMap: {},
          probeDescriptors: [],
        },
      },
    ],
  });
  const state = recomputeRunState({
    ...initial,
    phase: "provisioning",
    vms: initial.vms.map((vm) => ({
      ...vm,
      provisioning: {
        ...vm.provisioning,
        image: "broken-nginx-webserver-x86_64",
        imageKey: {
          scenario: "broken-nginx",
          vm: "webserver",
          arch: "x86_64" as const,
        },
        imageSha256: "2".repeat(64),
        resources: {
          cpuMillis: 1_000,
          vcpuCount: 1,
          memoryMib: 512,
          diskMib: 4_096,
        },
        leaseDurationSeconds: 60,
        status: "queued",
      },
    })),
  });
  await db.insert(scenarioRuns).values({
    runId,
    userId: USER_ID,
    hostId,
    scenarioId: "broken-nginx",
    scenarioName: "broken-nginx",
    title: "Broken Nginx",
    tagline: "",
    briefingMarkdown: "",
    objectivesJson: "[]",
    difficulty: "easy",
    estimatedMinutes: 1,
    tagsJson: [],
    hintsJson: [],
    solutionMarkdown: "",
    vmCount: 1,
    state: state.phase,
    stateRank: RUN_PHASE_ORDER[state.phase],
    activeKey: USER_ID,
    stateJson: JSON.stringify(state),
    createdAt: now,
    updatedAt: now,
  });
}

function desiredVm(runId: string, vmName: string, now: number) {
  return {
    run_id: runId,
    vm_name: vmName,
    desired_phase: "running" as const,
    image_key: {
      scenario: "broken-nginx",
      vm: "webserver",
      arch: "x86_64" as const,
    },
    image_sha256: "2".repeat(64),
    resources: {
      cpu_millis: 1_000,
      vcpu_count: 1,
      memory_mib: 512,
      disk_mib: 4_096,
    },
    ssh_authorized_keys_openssh: [],
    lease_expires_at_unix_ms: now + 60_000,
  };
}

async function seedBenchmarkHost(
  hostId: string,
  now: number,
  options: {
    scenarioEnabled?: boolean;
    schedulableCpuMillis?: number;
  } = {},
): Promise<void> {
  const db = drizzle(env.DB);
  await db
    .insert(user)
    .values({
      id: USER_ID,
      name: "Benchmark User",
      email: "benchmark@example.com",
      emailVerified: true,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    })
    .onConflictDoNothing();
  await db.insert(agentHosts).values({
    id: hostId,
    userId: USER_ID,
    name: hostId,
    role: "agent",
    scenarioEnabled: options.scenarioEnabled ?? false,
    disabled: false,
    connected: true,
    connectedAt: now,
    lastHeartbeatAt: now,
    lastInventoryAt: now,
    createdAt: now,
    updatedAt: now,
  });
  const desired = createEmptyHostDesiredState({
    hostId,
    nowUnixMs: now,
  });
  await db.insert(hostDesiredState).values({
    hostId,
    version: desired.version,
    docJson: desired,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(hostActualState).values({
    hostId,
    appliedDesiredVersion: desired.version,
    observedAt: now,
    reportJson: strictEmptyReport(
      hostId,
      options.schedulableCpuMillis ?? 4_000,
      desired.version,
      now,
    ),
    createdAt: now,
    updatedAt: now,
  });
}

async function refreshHostEvidence(
  hostId: string,
  now: number,
  options: { appliedDesiredVersion: number },
): Promise<void> {
  const db = drizzle(env.DB);
  const [actual] = await db
    .select({ reportJson: hostActualState.reportJson })
    .from(hostActualState)
    .where(eq(hostActualState.hostId, hostId));
  if (!actual) {
    throw new Error("benchmark test host is missing actual state");
  }
  await db.batch([
    db
      .update(agentHosts)
      .set({ lastHeartbeatAt: now, lastInventoryAt: now, updatedAt: now })
      .where(eq(agentHosts.id, hostId)),
    db
      .update(hostActualState)
      .set({
        appliedDesiredVersion: options.appliedDesiredVersion,
        observedAt: now,
        updatedAt: now,
        reportJson: {
          ...actual.reportJson,
          observed_at_unix_ms: now,
          applied_desired_version: options.appliedDesiredVersion,
          vms: [],
          builds: [],
          capacity: {
            ...actual.reportJson.capacity,
            committed_cpu_millis: 0,
          },
        },
      })
      .where(eq(hostActualState.hostId, hostId)),
  ]);
}

function strictEmptyReport(
  hostId: string,
  schedulableCpuMillis: number,
  appliedDesiredVersion: number,
  observedAt: number,
): HostStateReportV2 {
  return {
    schema_version: 4,
    host_id: hostId,
    observed_at_unix_ms: observedAt,
    applied_desired_version: appliedDesiredVersion,
    capacity: {
      total_cpu_millis: schedulableCpuMillis + 1_000,
      reserved_cpu_millis: 1_000,
      schedulable_cpu_millis: schedulableCpuMillis,
      committed_cpu_millis: 0,
      memory_total_mib: 8_192,
      memory_available_mib: 4_096,
      disk_probe_path: "/var/lib/intar-agent",
      disk_total_mib: 100_000,
      disk_available_mib: 80_000,
    },
    capabilities: {
      arch: "x86_64",
      cloud_hypervisor_sha256:
        "448af3d4e59b22c2987f7df94c213ad40fb53a10d437e42b5ee6c4fce7c29ecc",
      boot_cpu_millis: 2_000,
      boot_cpu_lease_ms: 45_000,
      supports_kvm: true,
      supports_vsock: true,
      supports_reflink: true,
      supports_nftables: true,
      supports_jailer_v1: false,
      supports_jailer_v2: true,
      supports_boot_cpu_lease: true,
      supports_template_backed_launch: true,
      fast_template_store: true,
      supports_hard_cpu_quota: true,
      supports_landlock: true,
      supports_cgroup_v2: true,
    },
    cached_images: [],
    vms: [],
    builds: [],
  };
}

function foreignActualVm(observedAt: number): HostStateReportV2["vms"][number] {
  return {
    run_id: "",
    vm_name: "foreign-vm",
    phase: "running",
    terminal: {
      state: "pending",
      observed_at_unix_ms: observedAt,
    },
    ssh_host_keys_openssh: [],
    probes: [],
    updated_at_unix_ms: observedAt,
  };
}

async function overwriteActualReportWithoutAdvancingFences(
  hostId: string,
  report: HostStateReportV2,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE host_actual_state SET report_json = ? WHERE host_id = ?",
  )
    .bind(JSON.stringify(report), hostId)
    .run();
}

function withBeforeNextBatchHook<TDatabase extends ReturnType<typeof drizzle>>(
  db: TDatabase,
  hook: () => Promise<void>,
): TDatabase {
  const originalBatch = db.batch.bind(db) as unknown as (
    queries: readonly unknown[],
  ) => Promise<readonly unknown[]>;
  let pending = true;
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "batch") {
        return async (queries: readonly unknown[]) => {
          if (pending) {
            pending = false;
            await hook();
          }
          return originalBatch(queries);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
