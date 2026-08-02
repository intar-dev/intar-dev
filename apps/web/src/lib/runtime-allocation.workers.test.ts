/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import {
  agentHosts,
  hostActualState,
  member,
  organization,
  user,
  workshopSessionMembers,
  workshopSessions,
  workshopTemplateRevisions,
  workshopTemplates,
  workshopWorkspaceGenerations,
  workshopWorkspaces,
  type WorkshopManifestV2,
} from "@/db/schema";
import type { HostStateReportV2 } from "@/generated/bridge";
import {
  runtimeCapacityAllocationKey,
  withRuntimeAllocationLock,
} from "@/lib/runtime-allocation-lock";
import { createRuntimeExecution } from "@/lib/runtime-executions";
import { selectScenarioHosts } from "@/lib/scenario-runs/start";
import { calculateWorkshopCapacity } from "@/lib/workshops/capacity";
import { resetD1Database } from "@/test/d1-migrations";

describe("shared runtime allocation fence", () => {
  beforeEach(async () => {
    await resetD1Database();
  });

  it("serializes simultaneous scenario and workshop admission in one organization", async () => {
    const key = runtimeCapacityAllocationKey("academy");
    let releaseScenario!: () => void;
    let scenarioEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      scenarioEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseScenario = resolve;
    });
    const scenarioStart = withRuntimeAllocationLock({
      key,
      operation: async () => {
        scenarioEntered();
        await release;
        return "scenario-admitted";
      },
    });
    await entered;

    await expect(
      withRuntimeAllocationLock({
        key: runtimeCapacityAllocationKey("academy"),
        operation: async () => "workshop-admitted",
      }),
    ).rejects.toMatchObject({ code: "runtime_allocation_busy" });

    releaseScenario();
    await expect(scenarioStart).resolves.toBe("scenario-admitted");
    await expect(
      withRuntimeAllocationLock({
        key,
        operation: async () => "workshop-retry-admitted",
      }),
    ).resolves.toBe("workshop-retry-admitted");
  });

  it("charges a scenario boot reservation before workshop capacity is admitted", async () => {
    const now = Date.now();
    await seedRuntimePool(now);
    await createRuntimeExecution({
      executionId: "scenario-starting",
      userId: "scenario-learner",
      organizationId: "academy",
      hostId: "runner",
      domainKind: "scenario",
      domainId: "scenario-starting",
      vms: [
        {
          vmId: "scenario-vm",
          ordinal: 0,
          runtimeVmName: "scenario-starting-vm",
          imageKey: scenarioImageKey(),
          imageSha256: "a".repeat(64),
          cpuMillis: 500,
          memoryMib: 1_024,
          diskMib: 2_048,
        },
      ],
      reservationState: "pending",
      reservationExpiresAt: now + 60_000,
      reservationResources: {
        cpuMillis: 2_000,
        memoryMib: 1_024,
        worstCaseDiskMib: 2_048,
      },
      now,
    });

    const capacity = await calculateWorkshopCapacity({
      organizationId: "academy",
      manifest: workshopManifest({ cpuMillis: 3_000 }),
      checkpointId: "checkpoint-00",
      now,
    });
    expect(capacity.runners).toEqual([
      expect.objectContaining({
        hostId: "runner",
        seatsAvailable: 0,
        available: {
          cpuMillis: 2_000,
          memoryMib: 7_168,
          worstCaseDiskMib: 18_432,
        },
      }),
    ]);
    expect(capacity.allocationFailures).toEqual([
      expect.objectContaining({
        hostId: "runner",
        reason: "insufficient_resources",
      }),
    ]);

    const reported = hostReport(now + 1);
    reported.capacity.committed_cpu_millis = 2_000;
    reported.capacity.memory_available_mib = 7_168;
    reported.vms = [reportedScenarioVm(now + 1)];
    await drizzle(env.DB)
      .update(hostActualState)
      .set({
        observedAt: now + 1,
        reportJson: reported,
        updatedAt: now + 1,
      })
      .where(eq(hostActualState.hostId, "runner"));
    const reportedCapacity = await calculateWorkshopCapacity({
      organizationId: "academy",
      manifest: workshopManifest({ cpuMillis: 3_000 }),
      checkpointId: "checkpoint-00",
      now: now + 1,
    });
    expect(reportedCapacity.runners[0]?.available).toEqual({
      cpuMillis: 2_000,
      memoryMib: 6_144,
      worstCaseDiskMib: 18_432,
    });

    await expect(
      selectScenarioHosts(
        [{ imageKey: scenarioImageKey(), imageSha256: "a".repeat(64) }],
        "academy",
        {
          cpuMillis: 1_000,
          memoryMib: 6_145,
          worstCaseDiskMib: 1_024,
        },
        now + 1,
      ),
    ).resolves.toEqual({ ok: false, reason: "resource_capacity" });
  });

  it("keeps scenario selection behind an in-flight workshop reservation", async () => {
    const now = Date.now();
    await seedRuntimePool(now);
    await createRuntimeExecution({
      executionId: "workshop-starting",
      userId: "workshop-learner",
      organizationId: "academy",
      hostId: "runner",
      domainKind: "workshop",
      domainId: "workspace-a",
      checkpointId: "checkpoint-00",
      vms: [
        {
          vmId: "workspace",
          ordinal: 0,
          runtimeVmName: "workshop-starting-vm",
          imageKey: workshopImageKey(),
          imageSha256: "b".repeat(64),
          cpuMillis: 1_000,
          memoryMib: 7_500,
          diskMib: 19_000,
        },
      ],
      reservationState: "pending",
      reservationExpiresAt: now + 60_000,
      now,
    });

    await expect(
      selectScenarioHosts(
        [{ imageKey: scenarioImageKey(), imageSha256: "a".repeat(64) }],
        "academy",
        {
          cpuMillis: 2_000,
          memoryMib: 1_024,
          worstCaseDiskMib: 2_048,
        },
        now,
      ),
    ).resolves.toEqual({ ok: false, reason: "resource_capacity" });
  });
});

async function seedRuntimePool(now: number): Promise<void> {
  const db = drizzle(env.DB);
  await db.batch([
    db.insert(user).values(userRow("owner")),
    db.insert(user).values(userRow("scenario-learner")),
    db.insert(user).values(userRow("workshop-learner")),
    db.insert(organization).values({
      id: "academy",
      name: "Academy",
      slug: "academy",
      createdAt: new Date(now),
    }),
    db.insert(agentHosts).values({
      id: "runner",
      userId: "owner",
      organizationId: "academy",
      name: "Runner",
      role: "agent",
      scenarioEnabled: true,
      disabled: false,
      connected: true,
      activeSessionId: "runner-session",
      lastHeartbeatAt: now,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(hostActualState).values({
      hostId: "runner",
      appliedDesiredVersion: 0,
      observedAt: now,
      reportJson: hostReport(now),
      createdAt: now,
      updatedAt: now,
    }),
  ]);
  await db.insert(member).values(
    ["owner", "scenario-learner", "workshop-learner"].map((userId) => ({
      id: `academy-${userId}`,
      organizationId: "academy",
      userId,
      role: userId === "owner" ? ("owner" as const) : ("member" as const),
      createdAt: new Date(now),
    })),
  );
  await db.insert(workshopTemplates).values({
    id: "allocation-workshop-template",
    organizationId: "academy",
    slug: "allocation-workshop",
    title: "Allocation workshop",
    summary: "Shared allocation test fixture",
    createdBy: "owner",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workshopTemplateRevisions).values({
    id: "allocation-workshop-revision",
    templateId: "allocation-workshop-template",
    revision: 1,
    sourceRevision: "test",
    contentHash: "b".repeat(64),
    manifestJson: workshopManifest(),
    publishedBy: "owner",
    publishedAt: now,
  });
  await db.insert(workshopSessions).values({
    id: "allocation-workshop-session",
    organizationId: "academy",
    templateRevisionId: "allocation-workshop-revision",
    title: "Allocation workshop",
    state: "live",
    version: 1,
    scheduledStartAt: now,
    lobbyOpensAt: now,
    createdBy: "owner",
    startedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workshopSessionMembers).values({
    id: "allocation-workshop-roster",
    sessionId: "allocation-workshop-session",
    userId: "workshop-learner",
    role: "participant",
    assignedBy: "owner",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workshopWorkspaces).values({
    id: "workspace-a",
    sessionId: "allocation-workshop-session",
    userId: "workshop-learner",
    state: "queued",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workshopWorkspaceGenerations).values({
    id: "allocation-workshop-generation",
    workspaceId: "workspace-a",
    ordinal: 1,
    checkpointId: "checkpoint-00",
    state: "queued",
    requestedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db
    .update(workshopWorkspaces)
    .set({ currentGenerationId: "allocation-workshop-generation" })
    .where(eq(workshopWorkspaces.id, "workspace-a"));
}

function userRow(id: string): typeof user.$inferInsert {
  return {
    id,
    name: id,
    email: `${id}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function hostReport(now: number): HostStateReportV2 {
  return {
    schema_version: 2,
    host_id: "runner",
    observed_at_unix_ms: now,
    applied_desired_version: 0,
    capacity: {
      total_cpu_millis: 6_000,
      reserved_cpu_millis: 2_000,
      schedulable_cpu_millis: 4_000,
      committed_cpu_millis: 0,
      memory_total_mib: 16_384,
      memory_available_mib: 8_192,
      disk_probe_path: "/var/lib/intar",
      disk_total_mib: 40_960,
      disk_available_mib: 20_480,
    },
    capabilities: {
      arch: "x86_64",
      cloud_hypervisor_sha256: "c".repeat(64),
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
    cached_images: [
      {
        image_key: scenarioImageKey(),
        image_sha256: "a".repeat(64),
        phase: "ready",
        updated_at_unix_ms: now,
      },
      {
        image_key: workshopImageKey(),
        image_sha256: "b".repeat(64),
        phase: "ready",
        updated_at_unix_ms: now,
      },
    ],
    vms: [],
    builds: [],
  };
}

function workshopManifest(
  resources: Partial<{
    cpuMillis: number;
    memoryMib: number;
    diskMib: number;
  }> = {},
): WorkshopManifestV2 {
  return {
    schemaVersion: 2,
    workshop: {
      slug: "shared-capacity",
      title: "Shared capacity",
      summary: "Exercise the shared capacity ledger.",
      prerequisites: [],
      attribution: {
        title: "Test fixture",
        url: "https://example.test/workshop",
        license: "Apache-2.0",
      },
      defaultLobbyMinutes: 30,
    },
    workspace: {
      leaseGraceMinutes: 60,
      vms: [
        {
          id: "workspace",
          name: "Workspace",
          cpuMillis: resources.cpuMillis ?? 1_000,
          memoryMib: resources.memoryMib ?? 1_024,
          diskMib: resources.diskMib ?? 1_024,
        },
      ],
      runtimeProfiles: [
        {
          id: "agent-x86",
          provider: "agent_kvm",
          vmId: "workspace",
          requestedSystemImage: "workshop-image",
          immutableSystemImage: "workshop-image",
          locations: [],
          hardware: {
            architecture: "x86_64",
            cpuMillis: resources.cpuMillis ?? 1_000,
            providerCpuCount: 1,
            memoryMib: resources.memoryMib ?? 1_024,
            diskMib: resources.diskMib ?? 1_024,
          },
        },
      ],
      checkpoints: [
        {
          id: "checkpoint-00",
          label: "Checkpoint 00",
          vmImages: [
            {
              vmId: "workspace",
              imageKey: workshopImageKey(),
              imageSha256: "b".repeat(64),
            },
          ],
        },
      ],
      initialCheckpointId: "checkpoint-00",
      applications: [],
    },
    modules: [],
    agenda: [],
    presentation: { slides: [] },
    durationMinutes: 0,
  };
}

function scenarioImageKey() {
  return {
    scenario: "scenario-image",
    vm: "workspace",
    arch: "x86_64" as const,
  };
}

function workshopImageKey() {
  return {
    scenario: "workshop-image",
    vm: "workspace",
    arch: "x86_64" as const,
  };
}

function reportedScenarioVm(now: number): HostStateReportV2["vms"][number] {
  return {
    run_id: "scenario-starting",
    vm_name: "scenario-starting-vm",
    phase: "booting",
    terminal: { state: "pending", observed_at_unix_ms: now },
    runtime_constraints: {
      generation: "scenario-starting-generation",
      phase: "boot_burst",
      steady_cpu_millis: 500,
      effective_cpu_millis: 2_000,
      lease_expires_at_unix_ms: now + 45_000,
    },
    resource_state: {
      cpu_millis: 500,
      vcpu_count: 1,
      cpu_quota_us: 200_000,
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
    updated_at_unix_ms: now,
  };
}
