/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import {
  HOST_CPU_RESERVATION_TTL_MS,
  commitHostCpuReservation,
  reconcileHostCpuReservations,
  reserveHostCpuInD1,
} from "@/control-plane/host-cpu-reservations";
import {
  agentHosts,
  hostActualState,
  hostCpuReservations,
  hostDesiredState,
  scenarioRuns,
  user,
  vmScenarioVms,
} from "@/db/schema";
import { createEmptyHostDesiredState } from "@/lib/desired-state";
import { d1Migrations, resetD1Database } from "@/test/d1-migrations";
import type { VmActualStateV2 } from "@/generated/bridge";

describe("host CPU reservations", () => {
  beforeEach(async () => {
    await resetD1Database();
  });

  it("backfills integer CPU catalogs during the in-place migration", async () => {
    await reset();
    await applyD1Migrations(env.DB, [d1Migrations[0]!]);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO vm_scenarios (scenario_id, title, category, description, difficulty, estimated_minutes, tags_json, briefing_markdown, solution_markdown, hints_json, enabled, created_at, updated_at) VALUES ('legacy', 'Legacy', 'test', 'Legacy', 'easy', 1, '[]', 'Briefing', 'Solution', '[]', 1, 1, 1)",
      ),
      env.DB.prepare(
        "INSERT INTO vm_scenario_vms (id, scenario_id, ordinal, vm_name, image, image_format, image_virtual_size_bytes, kernel_sha256, initrd_sha256, boot_cmdline, cpu, memory_mib, disk_mib) VALUES ('legacy:vm', 'legacy', 0, 'vm', 'legacy.raw.zst', 'raw_zstd', 1024, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'root=/dev/vda', 2, 512, 4096)",
      ),
    ]);
    await applyD1Migrations(env.DB, [d1Migrations[1]!]);

    const [vm] = await drizzle(env.DB)
      .select({
        cpuMillis: vmScenarioVms.cpuMillis,
        vcpuCount: vmScenarioVms.vcpuCount,
      })
      .from(vmScenarioVms)
      .where(eq(vmScenarioVms.id, "legacy:vm"));
    expect(vm).toEqual({ cpuMillis: 2_000, vcpuCount: 2 });
  });

  it("serializes concurrent reservations and admits exactly eight 125m VMs", async () => {
    const hostId = "host-eight";
    await seedStrictCpuHost(hostId, 1_000);
    const stub = env.HOST_RUNTIME.get(env.HOST_RUNTIME.idFromName(hostId));

    const responses = await Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        stub.fetch("http://host-runtime/_internal/cpu-reservations/reserve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            hostId,
            runId: `run-${index}`,
            cpuMillis: 125,
          }),
        }),
      ),
    );

    expect(responses.filter((response) => response.status === 201)).toHaveLength(8);
    const rejected = responses.find((response) => response.status === 409);
    await expect(rejected?.json()).resolves.toMatchObject({
      ok: false,
      reason: "exhausted",
      capacity: { availableCpuMillis: 0 },
    });
    const rows = await drizzle(env.DB)
      .select()
      .from(hostCpuReservations)
      .where(eq(hostCpuReservations.hostId, hostId));
    expect(rows).toHaveLength(8);
    expect(rows.reduce((total, row) => total + row.cpuMillis, 0)).toBe(1_000);
  });

  it("commits a pending reservation when its run survives the caller", async () => {
    const hostId = "host-crash-recovery";
    const runId = "run-survived";
    const now = Date.now();
    const db = drizzle(env.DB);
    await seedStrictCpuHost(hostId, 2_000, now);
    await expect(
      reserveHostCpuInD1(db, { hostId, runId, cpuMillis: 125, nowUnixMs: now }),
    ).resolves.toMatchObject({ ok: true, state: "pending" });
    await seedRun(hostId, runId, now);

    await expect(
      reconcileHostCpuReservations(db, hostId, now + 1),
    ).resolves.toMatchObject({ committedRunIds: [runId] });
    const [reservation] = await db
      .select()
      .from(hostCpuReservations)
      .where(eq(hostCpuReservations.runId, runId));
    expect(reservation).toMatchObject({ state: "committed", expiresAt: null });
  });

  it("does not hide unreserved local quota behind a committed control-plane reservation", async () => {
    const hostId = "host-unreserved-local";
    const runId = "run-control-plane";
    const now = Date.now();
    const db = drizzle(env.DB);
    await seedStrictCpuHost(hostId, 1_000, now);
    await reserveHostCpuInD1(db, {
      hostId,
      runId,
      cpuMillis: 875,
      nowUnixMs: now,
    });
    await commitHostCpuReservation(db, { hostId, runId, nowUnixMs: now });
    await db
      .update(hostActualState)
      .set({
        reportJson: strictReport(hostId, 1_000, 0, 250, [
          runningVmReport(runId, 125),
          runningVmReport("run-local-unreserved", 125),
        ]),
      })
      .where(eq(hostActualState.hostId, hostId));

    await expect(
      reserveHostCpuInD1(db, {
        hostId,
        runId: "run-overcommit",
        cpuMillis: 1,
        nowUnixMs: now + 1,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "exhausted",
      capacity: {
        effectiveCommittedCpuMillis: 1_000,
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
      cpuMillis: 500,
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

  it("releases committed CPU only after desired state is absent and applied actual state is gone", async () => {
    const hostId = "host-release";
    const runId = "run-release";
    const now = Date.now();
    const db = drizzle(env.DB);
    await seedStrictCpuHost(hostId, 2_000, now);
    await reserveHostCpuInD1(db, {
      hostId,
      runId,
      cpuMillis: 500,
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
    schema_version: 3,
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
      supports_kvm: true,
      supports_vsock: true,
      supports_reflink: true,
      supports_nftables: true,
      supports_jailer_v1: true,
      supports_hard_cpu_quota: true,
      supports_landlock: true,
      supports_cgroup_v2: true,
    },
    cached_images: [],
    vms,
    builds: [],
  } as typeof hostActualState.$inferInsert.reportJson;
}

function runningVmReport(
  runId: string,
  cpuMillis: number,
): VmActualStateV2 {
  return {
    run_id: runId,
    vm_name: `${runId}-vm`,
    phase: "running",
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
    updated_at_unix_ms: Date.now(),
  };
}

async function seedRun(hostId: string, runId: string, now: number): Promise<void> {
  await drizzle(env.DB).insert(scenarioRuns).values({
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
    vmCount: 1,
    state: "provisioning",
    stateRank: 1,
    activeKey: "user-1",
    stateJson: JSON.stringify({ vms: [] }),
    createdAt: now,
    updatedAt: now,
  });
}
