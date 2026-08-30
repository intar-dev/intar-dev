/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import {
  agentHosts,
  hostActualState,
  hostDesiredState,
  organization,
  user,
  vmScenarios,
  vmScenarioVms,
} from "@/db/schema";
import type {
  DesiredBuildV1,
  DesiredCachedImageV1,
  DesiredVmV2,
  HostStateReportV2,
} from "@/generated/bridge";
import type { ImageArchitecture, ImageKey } from "@/generated/catalog";
import { HOST_STATE_REPORT_SCHEMA_VERSION } from "@/generated/constants";
import {
  upsertDesiredBuild,
  upsertDesiredCachedImage,
  upsertDesiredVm,
} from "@/lib/desired-state";
import { mutateStoredHostDesiredState } from "@/lib/desired-state-store";
import {
  reconcileHostScenarioImages,
  reconcileScenarioImagesForPublicationScope,
  type ReconcileHostScenarioImagesResult,
} from "@/lib/scenario-image-cache";
import { resetD1Database } from "@/test/d1-migrations";

const PUBLIC_SHA = "a".repeat(64);
const PUBLIC_ARM_SHA = "b".repeat(64);
const ORG_A_SHA = "c".repeat(64);
const ORG_B_SHA = "d".repeat(64);

describe("scenario image cache reconciliation", () => {
  beforeEach(async () => {
    await resetD1Database();
    await seedIdentity();
  });

  it("gives public and organization agents their complete visible architecture-specific catalog", async () => {
    await Promise.all([
      seedScenario({
        scenarioId: "public-disabled",
        organizationId: null,
        arch: "x86_64",
        sha256: PUBLIC_SHA,
        enabled: false,
      }),
      seedScenario({
        scenarioId: "public-arm",
        organizationId: null,
        arch: "aarch64",
        sha256: PUBLIC_ARM_SHA,
      }),
      seedScenario({
        scenarioId: "org-a-private",
        organizationId: "org-a",
        arch: "x86_64",
        sha256: ORG_A_SHA,
      }),
      seedScenario({
        scenarioId: "org-b-private",
        organizationId: "org-b",
        arch: "x86_64",
        sha256: ORG_B_SHA,
      }),
    ]);
    await Promise.all([
      seedHost({ hostId: "public-agent", organizationId: null }),
      seedHost({ hostId: "org-a-agent", organizationId: "org-a" }),
    ]);
    await mutateStoredHostDesiredState(
      drizzle(env.DB),
      "org-a-agent",
      Date.now(),
      (draft) => {
        upsertDesiredCachedImage(draft, {
          image_key: image("unrelated-runtime", "vm", "aarch64"),
          image_id: PUBLIC_ARM_SHA,
        });
      },
    );

    const now = Date.now();
    const [publicResult, organizationResult] = await Promise.all([
      reconcileHostScenarioImages(drizzle(env.DB), {
        hostId: "public-agent",
        architecture: "x86_64",
        nowUnixMs: now,
      }),
      reconcileHostScenarioImages(drizzle(env.DB), {
        hostId: "org-a-agent",
        architecture: "x86_64",
        nowUnixMs: now,
      }),
    ]);

    expect(publicResult.outcome).toBe("changed");
    expect(imageIdentities(requiredState(publicResult).cached_images)).toEqual([
      `public-disabled:vm:x86_64:${PUBLIC_SHA}`,
    ]);
    expect(
      imageIdentities(requiredState(organizationResult).cached_images),
    ).toEqual([
      `org-a-private:vm:x86_64:${ORG_A_SHA}`,
      `public-disabled:vm:x86_64:${PUBLIC_SHA}`,
    ]);
  });

  it("excludes builders and disabled hosts while prewarming placement-paused agents", async () => {
    await seedScenario({
      scenarioId: "public-scenario",
      organizationId: null,
      arch: "x86_64",
      sha256: PUBLIC_SHA,
    });
    await Promise.all([
      seedHost({ hostId: "builder", organizationId: null, role: "builder" }),
      seedHost({ hostId: "disabled", organizationId: null, disabled: true }),
      seedHost({
        hostId: "placement-paused",
        organizationId: null,
        scenarioEnabled: false,
      }),
    ]);

    const db = drizzle(env.DB);
    const now = Date.now();
    const [builder, disabled, placementPaused] = await Promise.all([
      reconcileHostScenarioImages(db, {
        hostId: "builder",
        architecture: "x86_64",
        nowUnixMs: now,
      }),
      reconcileHostScenarioImages(db, {
        hostId: "disabled",
        architecture: "x86_64",
        nowUnixMs: now,
      }),
      reconcileHostScenarioImages(db, {
        hostId: "placement-paused",
        architecture: "x86_64",
        nowUnixMs: now,
      }),
    ]);

    expect(builder.outcome).toBe("ineligible");
    expect(disabled.outcome).toBe("ineligible");
    expect(requiredState(builder).cached_images).toEqual([]);
    expect(requiredState(disabled).cached_images).toEqual([]);
    expect(
      imageIdentities(requiredState(placementPaused).cached_images),
    ).toEqual([`public-scenario:vm:x86_64:${PUBLIC_SHA}`]);
  });

  it("adds new catalog pointers while retaining rollback images and running VMs", async () => {
    const scenarioImage = await seedScenario({
      scenarioId: "rolling-scenario",
      organizationId: null,
      arch: "x86_64",
      sha256: PUBLIC_SHA,
    });
    await seedHost({ hostId: "active-agent", organizationId: null });
    const workshopImage = image("workshop-checkpoint", "vm", "x86_64");
    const runningScenarioVm = desiredVm(scenarioImage, PUBLIC_SHA, "run-1");
    const runningWorkshopVm = desiredVm(
      workshopImage,
      ORG_A_SHA,
      "workshop-run",
    );
    const build = desiredBuild();
    const db = drizzle(env.DB);
    await mutateStoredHostDesiredState(
      db,
      "active-agent",
      Date.now(),
      (draft) => {
        upsertDesiredCachedImage(draft, {
          image_key: scenarioImage,
          image_id: PUBLIC_SHA,
        });
        upsertDesiredCachedImage(draft, {
          image_key: workshopImage,
          image_id: ORG_A_SHA,
        });
        upsertDesiredVm(draft, runningScenarioVm);
        upsertDesiredVm(draft, runningWorkshopVm);
        upsertDesiredBuild(draft, build);
      },
    );
    const before = await storedDesiredState("active-agent");

    const nextSha = "e".repeat(64);
    await db
      .update(vmScenarioVms)
      .set({ imageSha256: nextSha })
      .where(eq(vmScenarioVms.scenarioId, "rolling-scenario"));
    const result = await reconcileHostScenarioImages(db, {
      hostId: "active-agent",
      architecture: "x86_64",
      nowUnixMs: Date.now() + 1,
    });
    const after = requiredState(result);

    expect(imageIdentities(after.cached_images)).toEqual([
      `rolling-scenario:vm:x86_64:${PUBLIC_SHA}`,
      `rolling-scenario:vm:x86_64:${nextSha}`,
      `workshop-checkpoint:vm:x86_64:${ORG_A_SHA}`,
    ]);
    expect(after.vms).toEqual(before.vms);
    expect(after.builds).toEqual(before.builds);
    expect(after.vms[0]?.image_id).toBe(PUBLIC_SHA);
  });

  it("is idempotent and preserves a concurrent desired-VM mutation", async () => {
    const catalogImage = await seedScenario({
      scenarioId: "public-scenario",
      organizationId: null,
      arch: "x86_64",
      sha256: PUBLIC_SHA,
    });
    await seedHost({ hostId: "racing-agent", organizationId: null });
    const db = drizzle(env.DB);
    const now = Date.now();
    const first = await reconcileHostScenarioImages(db, {
      hostId: "racing-agent",
      architecture: "x86_64",
      nowUnixMs: now,
    });
    const firstState = requiredState(first);
    const second = await reconcileHostScenarioImages(db, {
      hostId: "racing-agent",
      architecture: "x86_64",
      nowUnixMs: now + 1,
    });
    expect(second.outcome).toBe("unchanged");
    expect(requiredState(second)).toEqual(firstState);

    const workshopImage = image("workshop", "vm", "x86_64");
    await Promise.all([
      reconcileHostScenarioImages(db, {
        hostId: "racing-agent",
        architecture: "x86_64",
        nowUnixMs: now + 2,
      }),
      mutateStoredHostDesiredState(db, "racing-agent", now + 2, (draft) => {
        upsertDesiredCachedImage(draft, {
          image_key: workshopImage,
          image_id: ORG_A_SHA,
        });
        upsertDesiredVm(
          draft,
          desiredVm(workshopImage, ORG_A_SHA, "workshop-run"),
        );
      }),
    ]);

    const finalState = await storedDesiredState("racing-agent");
    expect(imageIdentities(finalState.cached_images)).toEqual([
      `public-scenario:vm:x86_64:${PUBLIC_SHA}`,
      `workshop:vm:x86_64:${ORG_A_SHA}`,
    ]);
    expect(finalState.vms).toHaveLength(1);
    expect(finalState.builds).toEqual([]);
    expect(finalState.cached_images[0]?.image_key).toEqual(catalogImage);
  });

  it("accepts a same-millisecond current report after prior-session state is cleared", async () => {
    await seedScenario({
      scenarioId: "public-scenario",
      organizationId: null,
      arch: "x86_64",
      sha256: PUBLIC_SHA,
    });
    await seedHost({ hostId: "reinstalled-agent", organizationId: null });
    const db = drizzle(env.DB);
    const helloAt = Date.now();
    await db.insert(hostActualState).values({
      hostId: "reinstalled-agent",
      appliedDesiredVersion: 0,
      observedAt: helloAt - 1,
      reportJson: hostReport("reinstalled-agent", "aarch64", helloAt - 1),
      createdAt: helloAt - 1,
      updatedAt: helloAt - 1,
    });
    await db.batch([
      db
        .update(agentHosts)
        .set({
          activeSessionId: "new-session",
          lastClientHelloAt: helloAt,
          updatedAt: helloAt,
        })
        .where(eq(agentHosts.id, "reinstalled-agent")),
      db
        .delete(hostActualState)
        .where(eq(hostActualState.hostId, "reinstalled-agent")),
    ]);

    const stale = await reconcileScenarioImagesForPublicationScope(db, {
      publicationOrganizationId: null,
      nowUnixMs: helloAt,
    });
    expect(stale.changedHostIds).toEqual([]);
    expect(
      await db
        .select({ hostId: hostDesiredState.hostId })
        .from(hostDesiredState)
        .where(eq(hostDesiredState.hostId, "reinstalled-agent")),
    ).toEqual([]);

    await db.insert(hostActualState).values({
      hostId: "reinstalled-agent",
      appliedDesiredVersion: 0,
      observedAt: helloAt,
      reportJson: hostReport("reinstalled-agent", "x86_64", helloAt),
      createdAt: helloAt,
      updatedAt: helloAt,
    });
    const current = await reconcileScenarioImagesForPublicationScope(db, {
      publicationOrganizationId: null,
      nowUnixMs: helloAt,
    });
    expect(current.changedHostIds).toEqual(["reinstalled-agent"]);
    expect(
      imageIdentities(
        (await storedDesiredState("reinstalled-agent")).cached_images,
      ),
    ).toEqual([`public-scenario:vm:x86_64:${PUBLIC_SHA}`]);
  });
});

async function seedIdentity(): Promise<void> {
  const db = drizzle(env.DB);
  await db.insert(user).values({
    id: "owner",
    name: "Owner",
    email: "owner@example.test",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(organization).values([
    { id: "org-a", name: "Org A", slug: "org-a", createdAt: new Date() },
    { id: "org-b", name: "Org B", slug: "org-b", createdAt: new Date() },
  ]);
}

async function seedHost(input: {
  hostId: string;
  organizationId: string | null;
  role?: "agent" | "builder";
  disabled?: boolean;
  scenarioEnabled?: boolean;
}): Promise<void> {
  await drizzle(env.DB)
    .insert(agentHosts)
    .values({
      id: input.hostId,
      userId: "owner",
      organizationId: input.organizationId,
      name: input.hostId,
      role: input.role ?? "agent",
      disabled: input.disabled ?? false,
      scenarioEnabled: input.scenarioEnabled ?? true,
      connected: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
}

async function seedScenario(input: {
  scenarioId: string;
  organizationId: string | null;
  arch: ImageArchitecture;
  sha256: string;
  enabled?: boolean;
}): Promise<ImageKey> {
  const db = drizzle(env.DB);
  const now = Date.now();
  const imageKey = image(input.scenarioId, "vm", input.arch);
  await db.batch([
    db.insert(vmScenarios).values({
      scenarioId: input.scenarioId,
      organizationId: input.organizationId,
      title: input.scenarioId,
      category: "test",
      description: "scenario image cache test",
      difficulty: "easy",
      estimatedMinutes: 10,
      tagsJson: [],
      briefingMarkdown: "briefing",
      solutionMarkdown: "solution",
      hintsJson: [],
      enabled: input.enabled ?? true,
      enabledAt: input.enabled === false ? null : now,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(vmScenarioVms).values({
      id: `${input.scenarioId}:vm`,
      scenarioId: input.scenarioId,
      ordinal: 0,
      vmName: "vm",
      image: `${input.scenarioId}-vm-${input.arch}.chunks.json`,
      imageKeyJson: imageKey,
      imageSha256: input.sha256,
      imageFormat: "raw_chunks_v1",
      imageVirtualSizeBytes: 1_024,
      chunkManifestSha256: "d".repeat(64),
      guestBootstrapAbi: 1,
      kernelSha256: "1".repeat(64),
      initrdSha256: "2".repeat(64),
      bootCmdline: "console=ttyS0 root=/dev/vda rw",
      cpuMillis: 1_000,
      vcpuCount: 1,
      memoryMib: 512,
      diskMib: 1_024,
    }),
  ]);
  return imageKey;
}

async function storedDesiredState(hostId: string) {
  const rows = await drizzle(env.DB)
    .select({
      version: hostDesiredState.version,
      doc: hostDesiredState.docJson,
    })
    .from(hostDesiredState)
    .where(eq(hostDesiredState.hostId, hostId));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.version).toBe(rows[0]?.doc.version);
  return rows[0]!.doc;
}

function requiredState(result: ReconcileHostScenarioImagesResult) {
  expect(result.desiredState).not.toBeNull();
  return result.desiredState!;
}

function image(
  scenario: string,
  vm: string,
  arch: ImageArchitecture,
): ImageKey {
  return { scenario, vm, arch };
}

function imageIdentities(images: DesiredCachedImageV1[]): string[] {
  return images.map(
    (entry) =>
      `${entry.image_key.scenario}:${entry.image_key.vm}:${entry.image_key.arch}:${entry.image_id}`,
  );
}

function desiredVm(
  imageKey: ImageKey,
  imageSha256: string,
  runId: string,
): DesiredVmV2 {
  return {
    run_id: runId,
    vm_name: `${runId}-vm`,
    desired_phase: "running",
    image_key: imageKey,
    image_id: imageSha256,
    guest_tools: {
      tools_disk_sha256: "1".repeat(64),
      tools_disk_size_bytes: 64 * 1024 * 1024,
      kino_sha256: "2".repeat(64),
      bootstrap_abi: 1,
    },
    resources: {
      cpu_millis: 1_000,
      vcpu_count: 1,
      memory_mib: 512,
      disk_mib: 1_024,
    },
    ssh_authorized_keys_openssh: ["ssh-ed25519 AAAATEST test@example"],
    lease_expires_at_unix_ms: Date.now() + 60_000,
  };
}

function desiredBuild(): DesiredBuildV1 {
  return {
    build_id: "build-1",
    scenario_id: "rolling-scenario",
    arch: "x86_64",
    rev: "revision-1",
    content_hash: "f".repeat(64),
    bundle_ref: "builds/bundles/revision-1.tar.gz",
  };
}

function hostReport(
  hostId: string,
  arch: ImageArchitecture,
  observedAt: number,
): HostStateReportV2 {
  return {
    schema_version: HOST_STATE_REPORT_SCHEMA_VERSION,
    host_id: hostId,
    observed_at_unix_ms: observedAt,
    applied_desired_version: 0,
    capacity: {
      total_cpu_millis: 4_000,
      reserved_cpu_millis: 0,
      schedulable_cpu_millis: 4_000,
      committed_cpu_millis: 0,
      memory_total_mib: 8_192,
      memory_available_mib: 4_096,
      disk_probe_path: "/var/lib/intar-agent",
      disk_total_mib: 100_000,
      disk_available_mib: 80_000,
    },
    capabilities: {
      arch,
      cloud_hypervisor_sha256: null,
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
    vms: [],
    builds: [],
  };
}
