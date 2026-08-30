/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import {
  HOST_CPU_RESERVATION_TTL_MS,
  bootCpuReservationForSteadyVms,
  commitHostCpuReservation,
  reconcileHostCpuReservations,
  reserveHostCpuInD1,
  strictCpuCapacity,
} from "@/control-plane/host-cpu-reservations";
import {
  agentHosts,
  hostActualState,
  hostCpuReservations,
  hostDesiredState,
  hostResourceReservations,
  scenarioRuns,
  user,
} from "@/db/schema";
import { createEmptyHostDesiredState } from "@/lib/desired-state";
import {
  drizzleQueryToD1Statement,
  executeScenarioRunRuntimeProjection,
} from "@/lib/runtime-executions";
import { resetD1Database } from "@/test/d1-migrations";
import type { VmActualStateV2 } from "@/generated/bridge";

describe("host CPU reservations", () => {
  beforeEach(async () => {
    await resetD1Database();
  });

  it("reserves max(steady, 2000m) independently for every VM", () => {
    expect(bootCpuReservationForSteadyVms([1_000, 2_500, 125])).toBe(6_500);
    expect(() => bootCpuReservationForSteadyVms([])).toThrow(
      "scenario boot CPU reservation is invalid",
    );
  });

  it("rejects the legacy aggregate reservation request instead of falling back", async () => {
    const hostId = "host-no-capacity-fallback";
    await seedStrictCpuHost(hostId, 4_000);
    const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName(hostId));
    const response = await stub.fetch(
      "http://host-runtime/_internal/cpu-reservations/reserve",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          hostId,
          runId: "legacy-reservation",
          cpuMillis: 1_000,
        }),
      },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "steadyCpuMillisByVm is required",
    });
    await expect(
      drizzle(env.DB)
        .select()
        .from(hostCpuReservations)
        .where(eq(hostCpuReservations.hostId, hostId)),
    ).resolves.toHaveLength(0);
  });

  it("rejects legacy host reports without the complete v3 fast-launch contract", () => {
    const report = strictReport("host-legacy", 4_000, 1, 0);
    report.capabilities.supports_jailer_v3 = false;
    expect(strictCpuCapacity(report)).toBeNull();

    report.capabilities.supports_jailer_v3 = true;
    report.capabilities.fast_template_store = false;
    expect(strictCpuCapacity(report)).toBeNull();
  });

  it("rejects hosts that do not attest the root-owned 2000m/45s boot policy", () => {
    const report = strictReport("host-policy-drift", 4_000, 1, 0);
    report.capabilities.boot_cpu_millis = 1_000;
    expect(strictCpuCapacity(report)).toBeNull();

    report.capabilities.boot_cpu_millis = 2_000;
    report.capabilities.boot_cpu_lease_ms = 45_001;
    expect(strictCpuCapacity(report)).toBeNull();

    report.capabilities.boot_cpu_lease_ms = 45_000;
    report.capabilities.cloud_hypervisor_sha256 = null;
    expect(strictCpuCapacity(report)).toBeNull();
  });

  it("keeps disabled-host desired VMs fenced to an active local run", async () => {
    const hostId = "host-disabled-run-fence";
    const runId = "run-disabled-host";
    const now = Date.now();
    const db = drizzle(env.DB);
    await seedStrictCpuHost(hostId, 2_000, now);
    await db
      .update(agentHosts)
      .set({ scenarioEnabled: false })
      .where(eq(agentHosts.id, hostId));

    await expect(
      seedRunningDesiredState(hostId, runId, `${runId}-vm`, now),
    ).rejects.toThrow("desired running VM requires an active local run");

    await seedRun(hostId, runId, now);
    await expect(
      seedRunningDesiredState(hostId, runId, `${runId}-vm`, now),
    ).resolves.toBeUndefined();

    const triggers = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger'",
    ).all<{ name: string }>();
    expect(triggers.results).toEqual([]);
  });

  it("serializes concurrent boot reservations and admits exactly eight 125m VMs", async () => {
    const hostId = "host-eight";
    await seedStrictCpuHost(hostId, 16_000);
    const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName(hostId));

    const responses = await Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        stub.fetch("http://host-runtime/_internal/cpu-reservations/reserve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            hostId,
            runId: `run-${index}`,
            steadyCpuMillisByVm: [125],
          }),
        }),
      ),
    );

    expect(
      responses.filter((response) => response.status === 201),
    ).toHaveLength(8);
    const rejected = responses.find((response) => response.status === 409);
    await expect(rejected?.json()).resolves.toMatchObject({
      ok: false,
      reason: "boot_capacity_pending",
      capacity: { availableCpuMillis: 0 },
    });
    const rows = await drizzle(env.DB)
      .select()
      .from(hostCpuReservations)
      .where(eq(hostCpuReservations.hostId, hostId));
    expect(rows).toHaveLength(8);
    expect(rows.reduce((total, row) => total + row.cpuMillis, 0)).toBe(16_000);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          steadyCpuMillis: 125,
          bootCpuMillis: 2_000,
          quotaPhase: "boot",
        }),
      ]),
    );
  });

  it("commits a pending reservation only after its exact desired VMs survive the caller", async () => {
    const hostId = "host-crash-recovery";
    const runId = "run-survived";
    const now = Date.now();
    const db = drizzle(env.DB);
    await seedStrictCpuHost(hostId, 2_000, now);
    await expect(
      reserveHostCpuInD1(db, {
        hostId,
        runId,
        steadyCpuMillisByVm: [125],
        nowUnixMs: now,
      }),
    ).resolves.toMatchObject({ ok: true, state: "pending" });
    const vmName = `${runId}-vm`;
    await seedRun(
      hostId,
      runId,
      now,
      projectedQuotaState("generation-survived", "boot_burst", null, vmName),
    );
    await seedRunningDesiredState(hostId, runId, vmName, now, 125);

    await expect(
      reconcileHostCpuReservations(db, hostId, now + 1),
    ).resolves.toMatchObject({ committedRunIds: [runId] });
    const [reservation] = await db
      .select()
      .from(hostCpuReservations)
      .where(eq(hostCpuReservations.runId, runId));
    expect(reservation).toMatchObject({ state: "committed", expiresAt: null });
  });

  it("holds the boot allocation until every VM has generation-fenced live steady evidence", async () => {
    const hostId = "host-seal-capacity";
    const runId = "run-seal-capacity";
    const now = Date.now();
    const db = drizzle(env.DB);
    await seedStrictCpuHost(hostId, 3_000, now);
    await reserveHostCpuInD1(db, {
      hostId,
      runId,
      steadyCpuMillisByVm: [1_000],
      nowUnixMs: now,
    });
    await seedRun(
      hostId,
      runId,
      now,
      projectedQuotaState("generation-a", "boot_burst"),
    );
    await seedGenericRuntimeReservation(hostId, runId, now, 2_000);
    await commitHostCpuReservation(db, { hostId, runId, nowUnixMs: now });
    await seedRunningDesiredState(hostId, runId, "run-seal-capacity-vm", now);

    await expect(
      reserveHostCpuInD1(db, {
        hostId,
        runId: "run-waiting",
        steadyCpuMillisByVm: [1_000],
        nowUnixMs: now + 1,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "boot_capacity_pending",
      capacity: { availableCpuMillis: 1_000 },
    });

    const quotaVerifiedAt = now + 10;
    await db
      .update(scenarioRuns)
      .set({
        stateJson: JSON.stringify(
          projectedQuotaState("generation-a", "steady", quotaVerifiedAt),
        ),
      })
      .where(eq(scenarioRuns.runId, runId));
    await db
      .update(hostActualState)
      .set({
        appliedDesiredVersion: 1,
        reportJson: strictReport(hostId, 3_000, 1, 1_000, [
          quotaVmReport({
            runId,
            vmName: "run-seal-capacity-vm",
            generation: "generation-a",
            phase: "steady",
            effectiveCpuMillis: 1_000,
            quotaVerifiedAt,
            updatedAt: quotaVerifiedAt + 1,
          }),
        ]),
      })
      .where(eq(hostActualState.hostId, hostId));

    await expect(
      reconcileHostCpuReservations(db, hostId, quotaVerifiedAt + 2),
    ).resolves.toMatchObject({ sealedRunIds: [runId] });
    await expect(
      db
        .select()
        .from(hostCpuReservations)
        .where(eq(hostCpuReservations.runId, runId)),
    ).resolves.toEqual([
      expect.objectContaining({
        cpuMillis: 1_000,
        steadyCpuMillis: 1_000,
        bootCpuMillis: 2_000,
        quotaPhase: "steady",
      }),
    ]);
    await expect(
      db
        .select({
          cpuMillis: hostResourceReservations.cpuMillis,
          state: hostResourceReservations.state,
        })
        .from(hostResourceReservations)
        .where(eq(hostResourceReservations.executionId, runId)),
    ).resolves.toEqual([{ cpuMillis: 1_000, state: "committed" }]);

    await expect(
      reserveHostCpuInD1(db, {
        hostId,
        runId: "run-after-seal",
        steadyCpuMillisByVm: [1_000],
        nowUnixMs: quotaVerifiedAt + 3,
      }),
    ).resolves.toMatchObject({ ok: true, state: "pending" });
  });

  it("restores conservative boot accounting when fresh steady evidence is missing", async () => {
    const hostId = "host-conservative-recovery";
    const runId = "run-conservative-recovery";
    const now = Date.now();
    const db = drizzle(env.DB);
    await seedStrictCpuHost(hostId, 2_000, now);
    await reserveHostCpuInD1(db, {
      hostId,
      runId,
      steadyCpuMillisByVm: [1_000],
      nowUnixMs: now,
    });
    await seedRun(
      hostId,
      runId,
      now,
      projectedQuotaState("generation-a", "steady", now + 10, `${runId}-vm`),
    );
    await seedRunningDesiredState(hostId, runId, `${runId}-vm`, now);
    await commitHostCpuReservation(db, { hostId, runId, nowUnixMs: now });
    await db
      .update(hostActualState)
      .set({
        appliedDesiredVersion: 1,
        reportJson: strictReport(hostId, 2_000, 1, 1_000, [
          quotaVmReport({
            runId,
            vmName: `${runId}-vm`,
            generation: "generation-a",
            phase: "steady",
            effectiveCpuMillis: 1_000,
            quotaVerifiedAt: now + 10,
            updatedAt: now + 11,
          }),
        ]),
      })
      .where(eq(hostActualState.hostId, hostId));
    await reconcileHostCpuReservations(db, hostId, now + 12);

    // A newer projected generation fences the old inventory attestation. The
    // reservation returns to 2000m immediately and stays there until a fresh
    // live cgroup read for generation-b proves steady state.
    await db
      .update(scenarioRuns)
      .set({
        stateJson: JSON.stringify(
          projectedQuotaState(
            "generation-b",
            "boot_burst",
            null,
            `${runId}-vm`,
          ),
        ),
      })
      .where(eq(scenarioRuns.runId, runId));
    await expect(
      reconcileHostCpuReservations(db, hostId, now + 13),
    ).resolves.toMatchObject({ bootAccountingRunIds: [runId] });
    await expect(
      db
        .select()
        .from(hostCpuReservations)
        .where(eq(hostCpuReservations.runId, runId)),
    ).resolves.toEqual([
      expect.objectContaining({ cpuMillis: 2_000, quotaPhase: "boot" }),
    ]);
  });

  it("does not hide unreserved local quota behind a committed control-plane reservation", async () => {
    const hostId = "host-unreserved-local";
    const runId = "run-control-plane";
    const now = Date.now();
    const db = drizzle(env.DB);
    await seedStrictCpuHost(hostId, 2_000, now);
    await reserveHostCpuInD1(db, {
      hostId,
      runId,
      steadyCpuMillisByVm: [875],
      nowUnixMs: now,
    });
    await commitHostCpuReservation(db, { hostId, runId, nowUnixMs: now });
    await db
      .update(hostActualState)
      .set({
        reportJson: strictReport(hostId, 2_000, 0, 250, [
          runningVmReport(runId, 125),
          runningVmReport("run-local-unreserved", 125),
        ]),
      })
      .where(eq(hostActualState.hostId, hostId));

    await expect(
      reserveHostCpuInD1(db, {
        hostId,
        runId: "run-overcommit",
        steadyCpuMillisByVm: [1],
        nowUnixMs: now + 1,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "boot_capacity_pending",
      capacity: {
        effectiveCommittedCpuMillis: 2_125,
        availableCpuMillis: 0,
      },
    });
  });

  it("expires an orphaned pending reservation after sixty seconds", async () => {
    const hostId = "host-expire";
    const runId = "run-orphan";
    const now = Date.now();
    const db = drizzle(env.DB);
    await seedStrictCpuHost(hostId, 2_000, now);
    await reserveHostCpuInD1(db, {
      hostId,
      runId,
      steadyCpuMillisByVm: [500],
      nowUnixMs: now,
    });

    await expect(
      reconcileHostCpuReservations(
        db,
        hostId,
        now + HOST_CPU_RESERVATION_TTL_MS,
      ),
    ).resolves.toMatchObject({ expiredRunIds: [runId] });
    await expect(
      db
        .select()
        .from(hostCpuReservations)
        .where(eq(hostCpuReservations.runId, runId)),
    ).resolves.toHaveLength(0);
  });

  it("does not release the active slot when pending admission expires after teardown intent", async () => {
    const hostId = "host-expire-during-destroy";
    const runId = "run-expire-during-destroy";
    const now = Date.now();
    const db = drizzle(env.DB);
    await seedStrictCpuHost(hostId, 2_000, now);
    await reserveHostCpuInD1(db, {
      hostId,
      runId,
      steadyCpuMillisByVm: [500],
      nowUnixMs: now,
    });
    await seedRun(hostId, runId, now);
    await db
      .update(scenarioRuns)
      .set({ deleteRequestedAt: now + 1, updatedAt: now + 1 })
      .where(eq(scenarioRuns.runId, runId));

    await reconcileHostCpuReservations(
      db,
      hostId,
      now + HOST_CPU_RESERVATION_TTL_MS,
    );

    const [run] = await db
      .select({
        activeKey: scenarioRuns.activeKey,
        state: scenarioRuns.state,
      })
      .from(scenarioRuns)
      .where(eq(scenarioRuns.runId, runId));
    expect(run).toMatchObject({ activeKey: "user-1", state: "failed" });
  });

  it("releases committed CPU only after desired state is absent and applied actual state is gone", async () => {
    const hostId = "host-release";
    const runId = "run-release";
    const now = Date.now();
    const db = drizzle(env.DB);
    await seedStrictCpuHost(hostId, 2_000, now);
    await reserveHostCpuInD1(db, {
      hostId,
      runId,
      steadyCpuMillisByVm: [500],
      nowUnixMs: now,
    });
    await commitHostCpuReservation(db, { hostId, runId, nowUnixMs: now });

    const desired = createEmptyHostDesiredState({ hostId, nowUnixMs: now });
    const desiredAtVersionOne = { ...desired, version: 1 };
    await db.insert(hostDesiredState).values({
      hostId,
      version: 1,
      docJson: desiredAtVersionOne,
      createdAt: now,
      updatedAt: now,
    });
    await db
      .update(hostActualState)
      .set({
        appliedDesiredVersion: 0,
        reportJson: strictReport(hostId, 2_000, 0, 500),
      })
      .where(eq(hostActualState.hostId, hostId));

    await reconcileHostCpuReservations(db, hostId, now + 1);
    await expect(
      db
        .select()
        .from(hostCpuReservations)
        .where(eq(hostCpuReservations.runId, runId)),
    ).resolves.toHaveLength(1);

    await db
      .update(hostActualState)
      .set({
        appliedDesiredVersion: 1,
        reportJson: strictReport(hostId, 2_000, 1, 0),
      })
      .where(eq(hostActualState.hostId, hostId));
    await expect(
      reconcileHostCpuReservations(db, hostId, now + 2),
    ).resolves.toMatchObject({ releasedRunIds: [runId] });
    await expect(
      db
        .select()
        .from(hostCpuReservations)
        .where(eq(hostCpuReservations.runId, runId)),
    ).resolves.toHaveLength(0);
  });
});

async function seedStrictCpuHost(
  hostId: string,
  schedulableCpuMillis: number,
  now = Date.now(),
): Promise<void> {
  const db = drizzle(env.DB);
  await db
    .insert(user)
    .values({
      id: "user-1",
      name: "Test User",
      email: "test@example.com",
      emailVerified: true,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    })
    .onConflictDoNothing();
  await db.insert(agentHosts).values({
    id: hostId,
    userId: "user-1",
    name: hostId,
    role: "agent",
    scenarioEnabled: true,
    connected: true,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(hostActualState).values({
    hostId,
    appliedDesiredVersion: 0,
    observedAt: now,
    reportJson: strictReport(hostId, schedulableCpuMillis, 0, 0),
    createdAt: now,
    updatedAt: now,
  });
}

function strictReport(
  hostId: string,
  schedulableCpuMillis: number,
  appliedDesiredVersion: number,
  committedCpuMillis: number,
  vms: VmActualStateV2[] = [],
): typeof hostActualState.$inferInsert.reportJson {
  return {
    schema_version: 4,
    host_id: hostId,
    observed_at_unix_ms: Date.now(),
    applied_desired_version: appliedDesiredVersion,
    capacity: {
      total_cpu_millis: schedulableCpuMillis + 1_000,
      reserved_cpu_millis: 1_000,
      schedulable_cpu_millis: schedulableCpuMillis,
      committed_cpu_millis: committedCpuMillis,
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
      supports_jailer_v2: true,
      supports_jailer_v3: true,
      supports_raw_chunks_v1: true,
      supports_scenario_guest_tools_v1: true,
      supports_boot_cpu_lease: true,
      supports_template_backed_launch: true,
      fast_template_store: true,
      supports_hard_cpu_quota: true,
      supports_landlock: true,
      supports_cgroup_v2: true,
    },
    cached_images: [],
    vms,
    builds: [],
  } as typeof hostActualState.$inferInsert.reportJson;
}

function runningVmReport(runId: string, cpuMillis: number): VmActualStateV2 {
  const observedAt = Date.now();
  return {
    run_id: runId,
    vm_name: `${runId}-vm`,
    phase: "running",
    terminal: {
      state: "pending",
      observed_at_unix_ms: observedAt,
    },
    resource_state: {
      cpu_millis: cpuMillis,
      vcpu_count: 1,
      cpu_quota_us: cpuMillis * 100,
      cpu_period_us: 100_000,
      cpu_usage_usec: 0,
      cpu_user_usec: 0,
      cpu_system_usec: 0,
      cpu_nr_periods: 0,
      cpu_nr_throttled: 0,
      cpu_throttled_usec: 0,
    },
    ssh_host_keys_openssh: [],
    probes: [],
    updated_at_unix_ms: observedAt,
  };
}

async function seedRun(
  hostId: string,
  runId: string,
  now: number,
  state: unknown = { vms: [] },
): Promise<void> {
  const db = drizzle(env.DB);
  const mutation = db
    .insert(scenarioRuns)
    .values({
      runId,
      userId: "user-1",
      hostId,
      scenarioId: "scenario",
      scenarioName: "scenario",
      title: "Scenario",
      tagline: "",
      briefingMarkdown: "",
      objectivesJson: "[]",
      difficulty: "easy",
      estimatedMinutes: 1,
      tagsJson: [],
      hintsJson: [],
      solutionMarkdown: "",
      vmCount:
        typeof state === "object" &&
        state !== null &&
        "vms" in state &&
        Array.isArray(state.vms)
          ? Math.max(1, state.vms.length)
          : 1,
      state: "provisioning",
      stateRank: 1,
      activeKey: "user-1",
      stateJson: JSON.stringify(state),
      createdAt: now,
      updatedAt: now,
    });
  await executeScenarioRunRuntimeProjection({
    d1: env.DB,
    runId,
    statements: [drizzleQueryToD1Statement(env.DB, mutation)],
    mode: "create",
  });
}

function projectedQuotaState(
  generation: string,
  phase: "boot_burst" | "steady",
  quotaVerifiedAt: number | null = null,
  vmName = "run-seal-capacity-vm",
): unknown {
  return {
    vms: [
      {
        runtimeVmName: vmName,
        runtimeConstraints: {
          generation,
          phase,
          steadyCpuMillis: 1_000,
          effectiveCpuMillis: phase === "steady" ? 1_000 : 2_000,
          quotaVerifiedAt,
          leaseExpiresAt: phase === "boot_burst" ? Date.now() + 45_000 : null,
        },
      },
    ],
  };
}

async function seedRunningDesiredState(
  hostId: string,
  runId: string,
  vmName: string,
  now: number,
  cpuMillis = 1_000,
): Promise<void> {
  const empty = createEmptyHostDesiredState({ hostId, nowUnixMs: now });
  const desired = {
    ...empty,
    version: 1,
    vms: [
      {
        run_id: runId,
        vm_name: vmName,
        desired_phase: "running" as const,
        image_key: { scenario: "scenario", vm: "vm", arch: "x86_64" as const },
        image_sha256: "2".repeat(64),
        resources: {
          cpu_millis: cpuMillis,
          vcpu_count: 1,
          memory_mib: 512,
          disk_mib: 4_096,
        },
        ssh_authorized_keys_openssh: [
          "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest capacity@test",
        ],
        lease_expires_at_unix_ms: now + 60_000,
      },
    ],
  };
  const inserted = await env.DB.prepare(
    `INSERT INTO host_desired_state (
       host_id, version, doc_json, created_at, updated_at
     )
     SELECT ?1, 1, ?2, ?3, ?3
     WHERE EXISTS (
       SELECT 1
       FROM scenario_runs run
       WHERE run.run_id = ?4
         AND run.host_id = ?1
         AND run.active_key IS NOT NULL
         AND run.completed_at IS NULL
         AND run.failed_at IS NULL
     )`,
  )
    .bind(hostId, JSON.stringify(desired), now, runId)
    .run();
  if (inserted.meta.changes !== 1) {
    throw new Error("desired running VM requires an active local run");
  }
}

async function seedGenericRuntimeReservation(
  hostId: string,
  runId: string,
  now: number,
  cpuMillis: number,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO runtime_vms (
         id, execution_id, vm_id, ordinal, runtime_vm_name, image_key_json,
         image_sha256, cpu_millis, memory_mib, disk_mib, created_at, updated_at
       ) VALUES (?, ?, 'vm', 0, ?, ?, ?, 1000, 512, 4096, ?, ?)`,
    ).bind(
      `${runId}:vm`,
      runId,
      `${runId}-vm`,
      JSON.stringify({ scenario: "scenario", vm: "vm", arch: "x86_64" }),
      "2".repeat(64),
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO host_resource_reservations (
         execution_id, host_id, cpu_millis, memory_mib, worst_case_disk_mib,
         state, expires_at, released_at, created_at, updated_at
       ) VALUES (?, ?, ?, 512, 4096, 'committed', NULL, NULL, ?, ?)`,
    ).bind(runId, hostId, cpuMillis, now, now),
  ]);
}

function quotaVmReport(input: {
  runId: string;
  vmName: string;
  generation: string;
  phase: "boot_burst" | "steady";
  effectiveCpuMillis: number;
  quotaVerifiedAt: number | null;
  updatedAt: number;
}): VmActualStateV2 {
  return {
    run_id: input.runId,
    vm_name: input.vmName,
    phase: input.phase === "steady" ? "running" : "booting",
    terminal: {
      state: "pending",
      observed_at_unix_ms: input.updatedAt,
    },
    runtime_constraints: {
      generation: input.generation,
      phase: input.phase,
      steady_cpu_millis: 1_000,
      effective_cpu_millis: input.effectiveCpuMillis,
      quota_verified_at_unix_ms: input.quotaVerifiedAt,
      lease_expires_at_unix_ms:
        input.phase === "boot_burst" ? input.updatedAt + 45_000 : null,
    },
    resource_state: {
      cpu_millis: 1_000,
      vcpu_count: 1,
      cpu_quota_us: input.effectiveCpuMillis * 100,
      cpu_period_us: 100_000,
      cpu_usage_usec: 0,
      cpu_user_usec: 0,
      cpu_system_usec: 0,
      cpu_nr_periods: 0,
      cpu_nr_throttled: 0,
      cpu_throttled_usec: 0,
    },
    ssh_host_keys_openssh: [],
    probes: [],
    updated_at_unix_ms: input.updatedAt,
  };
}
