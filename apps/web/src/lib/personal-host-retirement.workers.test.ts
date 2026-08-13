/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import {
  agentBootstrapTokens,
  agentHosts,
  hostActualState,
  hostDesiredState,
  scenarioRuns,
  user,
} from "@/db/schema";
import { getBetaAccess, type BetaAdmissionEpoch } from "@/lib/allowlist";
import { createEmptyHostDesiredState } from "@/lib/desired-state";
import { retirePersonalHost } from "@/lib/personal-host-retirement";
import { grantFixtureBetaAccess } from "@/test/beta-access-fixtures";
import { resetD1Database } from "@/test/d1-migrations";

const USER_ID = "retirement-owner";
const HOST_ID = "retirement-host";
const NOW = 20_000;

describe("personal host retirement boundary", () => {
  beforeEach(async () => {
    await resetD1Database();
    const db = drizzle(env.DB);
    await db.insert(user).values({
      id: USER_ID,
      name: "Retirement Owner",
      email: "retirement@example.test",
    });
    await grantFixtureBetaAccess({ d1: env.DB, userId: USER_ID, now: 10_000 });
  });

  it("revokes and hides a drained host while preserving identity and history", async () => {
    const db = drizzle(env.DB);
    await seedHost();
    await db.insert(agentBootstrapTokens).values({
      id: "bootstrap-1",
      hostId: HOST_ID,
      tokenHash: "bootstrap-hash",
      createdAt: 11_000,
    });
    await db.insert(scenarioRuns).values(completedRun());
    const desired = {
      ...createEmptyHostDesiredState({ hostId: HOST_ID, nowUnixMs: 11_000 }),
      version: 1,
    };
    await db.insert(hostDesiredState).values({
      hostId: HOST_ID,
      version: 1,
      docJson: desired,
      createdAt: 11_000,
      updatedAt: 11_000,
    });
    await db.insert(hostActualState).values({
      hostId: HOST_ID,
      appliedDesiredVersion: 1,
      observedAt: 11_000,
      reportJson: emptyHostReport(),
      createdAt: 11_000,
      updatedAt: 11_000,
    });

    await expect(
      retirePersonalHost({
        d1: env.DB,
        hostId: HOST_ID,
        userId: USER_ID,
        betaAdmission: await admission(),
        now: NOW,
      }),
    ).resolves.toBe(true);

    await expect(
      db
        .select({
          id: agentHosts.id,
          name: agentHosts.name,
          role: agentHosts.role,
          disabled: agentHosts.disabled,
          scenarioEnabled: agentHosts.scenarioEnabled,
          connected: agentHosts.connected,
          activeSessionId: agentHosts.activeSessionId,
        })
        .from(agentHosts)
        .where(eq(agentHosts.id, HOST_ID)),
    ).resolves.toEqual([
      {
        id: HOST_ID,
        name: "Cutover host",
        role: "agent",
        disabled: true,
        scenarioEnabled: false,
        connected: false,
        activeSessionId: null,
      },
    ]);
    await expect(
      db
        .select({ revokedAt: agentBootstrapTokens.revokedAt })
        .from(agentBootstrapTokens),
    ).resolves.toEqual([{ revokedAt: NOW }]);
    await expect(db.select().from(hostDesiredState)).resolves.toHaveLength(0);
    await expect(db.select().from(hostActualState)).resolves.toHaveLength(0);
    await expect(
      db.select({ hostId: scenarioRuns.hostId }).from(scenarioRuns),
    ).resolves.toEqual([{ hostId: HOST_ID }]);

    await expect(
      retirePersonalHost({
        d1: env.DB,
        hostId: HOST_ID,
        userId: USER_ID,
        betaAdmission: await admission(),
        now: NOW + 1,
      }),
    ).resolves.toBe(true);
  });

  it("fails closed while connected or when a run is active", async () => {
    const db = drizzle(env.DB);
    await seedHost({ connected: true, activeSessionId: "session-1" });

    await expect(
      retirePersonalHost({
        d1: env.DB,
        hostId: HOST_ID,
        userId: USER_ID,
        betaAdmission: await admission(),
        now: NOW,
      }),
    ).resolves.toBe(false);

    await db
      .update(agentHosts)
      .set({ connected: false, activeSessionId: null })
      .where(eq(agentHosts.id, HOST_ID));
    await db
      .insert(scenarioRuns)
      .values({
        ...completedRun(),
        activeKey: USER_ID,
        state: "running",
        completedAt: null,
      });

    await expect(
      retirePersonalHost({
        d1: env.DB,
        hostId: HOST_ID,
        userId: USER_ID,
        betaAdmission: await admission(),
        now: NOW,
      }),
    ).resolves.toBe(false);
    await expect(
      db.select({ disabled: agentHosts.disabled }).from(agentHosts),
    ).resolves.toEqual([{ disabled: false }]);
  });

  it("rejects a stale admission epoch", async () => {
    await seedHost();
    const current = await admission();

    await expect(
      retirePersonalHost({
        d1: env.DB,
        hostId: HOST_ID,
        userId: USER_ID,
        betaAdmission: {
          ...current,
          sourceLeaseId: `${current.sourceLeaseId}-old`,
        },
        now: NOW,
      }),
    ).resolves.toBe(false);
  });
});

async function seedHost(
  input: { connected?: boolean; activeSessionId?: string | null } = {},
) {
  await drizzle(env.DB)
    .insert(agentHosts)
    .values({
      id: HOST_ID,
      userId: USER_ID,
      name: "Cutover host",
      role: "agent",
      scenarioEnabled: true,
      disabled: false,
      connected: input.connected ?? false,
      activeSessionId: input.activeSessionId ?? null,
      createdAt: 11_000,
      updatedAt: 11_000,
    });
}

async function admission(): Promise<BetaAdmissionEpoch> {
  const access = await getBetaAccess(USER_ID, env.DB);
  if (!access) throw new Error("missing admission fixture");
  return {
    sourceInviteId: access.sourceInviteId,
    sourceLeaseId: access.sourceLeaseId,
    grantedAt: access.grantedAt,
  };
}

function completedRun() {
  return {
    runId: "retirement-run",
    userId: USER_ID,
    hostId: HOST_ID,
    scenarioId: "retirement-scenario",
    scenarioName: "retirement-scenario",
    title: "Retirement history",
    tagline: "",
    briefingMarkdown: "",
    objectivesJson: "[]",
    difficulty: "easy",
    estimatedMinutes: 1,
    tagsJson: [],
    hintsJson: [],
    solutionMarkdown: "",
    vmCount: 1,
    state: "completed",
    stateRank: 1,
    activeKey: null as string | null,
    stateJson: "{}",
    completedAt: 11_000 as number | null,
    createdAt: 11_000,
    updatedAt: 11_000,
  };
}

function emptyHostReport(): typeof hostActualState.$inferInsert.reportJson {
  return {
    schema_version: 4,
    host_id: HOST_ID,
    observed_at_unix_ms: 11_000,
    applied_desired_version: 1,
    capacity: {
      total_cpu_millis: 2_000,
      reserved_cpu_millis: 1_000,
      schedulable_cpu_millis: 1_000,
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
