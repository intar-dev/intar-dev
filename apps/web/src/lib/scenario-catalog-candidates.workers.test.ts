/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentHosts,
  hostActualState,
  hostDesiredState,
  imageBuildBundles,
  imageBuilds,
  scenarioCatalogCandidates,
  user,
  type ImageBuildBundleMeta,
} from "@/db/schema";
import type { HostStateReportV2 } from "@/generated/bridge";
import type { ScenarioManifestV4 } from "@/generated/catalog";
import { createEmptyHostDesiredState } from "@/lib/desired-state";
import { stageReusableCandidateManifests } from "@/lib/scenario-catalog-candidates";
import { resetD1Database } from "@/test/d1-migrations";

const contentHash = "a".repeat(64);
const scenarioIds = Array.from(
  { length: 13 },
  (_, index) => `task-${String(index + 1).padStart(2, "0")}`,
);

describe("reused candidate presentation", () => {
  beforeEach(resetD1Database);

  it("overlays current lecture Markdown without queueing another image build", async () => {
    const db = drizzle(env.DB);
    await seedReusedBuilds(db, ["task"]);

    const meta: ImageBuildBundleMeta = {
      buildFormatVersion: "intar-image-build-v11",
      catalogChannel: "candidate",
      scenarios: [{ scenarioId: "task", arch: "x86_64", contentHash }],
      courseCatalog: {
        version: 2,
        courses: [
          {
            courseId: "course",
            title: "Course",
            summary: "Course summary",
            bodyMarkdown: "Course body",
            sequential: true,
            lectures: [
              {
                lectureId: "01-task",
                title: "Markdown title",
                summary: "Markdown summary",
                bodyMarkdown: "Markdown theory",
                category: "markdown",
                tags: ["markdown"],
                difficulty: "hard",
                estimatedMinutes: 42,
                scenarioId: "task",
              },
            ],
          },
        ],
      },
    };

    await expect(
      stageReusableCandidateManifests(db, {
        revision: "markdown-only",
        organizationId: null,
        meta,
        nowUnixMs: 2,
        wakeHost: async () => undefined,
      }),
    ).resolves.toEqual(["task"]);

    const [candidate] = await db
      .select()
      .from(scenarioCatalogCandidates)
      .where(eq(scenarioCatalogCandidates.id, "public:markdown-only:task"));
    expect(candidate?.manifestJson).toMatchObject({
      title: "Markdown title",
      category: "markdown",
      description: "Markdown summary",
      difficulty: "hard",
      estimated_minutes: 42,
      tags: ["markdown"],
      briefing_markdown: "Markdown theory",
      solution_markdown: "Technical solution",
      vms: [{ name: "vm" }],
    });
    await expect(
      db
        .select({ id: imageBuilds.id })
        .from(imageBuilds)
        .where(eq(imageBuilds.contentHash, contentHash)),
    ).resolves.toEqual([{ id: "reused-task" }]);
  });

  it("does not mutate or wake an already-ready host for 13 reused manifests", async () => {
    const db = drizzle(env.DB);
    await seedReusedBuilds(db, scenarioIds);
    await seedAgentHost(db, scenarioIds, true);
    const wakeHost = vi.fn(async () => undefined);

    await expect(
      stageReusableCandidateManifests(db, {
        revision: "repeat-ready",
        organizationId: null,
        meta: reusedMeta(scenarioIds),
        nowUnixMs: 2,
        wakeHost,
      }),
    ).resolves.toEqual(scenarioIds);

    expect(wakeHost).not.toHaveBeenCalled();
    const [desired] = await db
      .select({ version: hostDesiredState.version, state: hostDesiredState.docJson })
      .from(hostDesiredState)
      .where(eq(hostDesiredState.hostId, "agent-1"));
    expect(desired?.version).toBe(7);
    expect(desired?.state.cached_images).toHaveLength(13);
    await expect(
      db
        .select({ id: scenarioCatalogCandidates.id })
        .from(scenarioCatalogCandidates),
    ).resolves.toHaveLength(13);
  });

  it("mutates and wakes an empty host once for 13 reused manifests", async () => {
    const db = drizzle(env.DB);
    await seedReusedBuilds(db, scenarioIds);
    await seedAgentHost(db, scenarioIds, false);
    const wakeHost = vi.fn(async () => undefined);

    await expect(
      stageReusableCandidateManifests(db, {
        revision: "repeat-new-host",
        organizationId: null,
        meta: reusedMeta(scenarioIds),
        nowUnixMs: 2,
        wakeHost,
      }),
    ).resolves.toEqual(scenarioIds);

    expect(wakeHost).toHaveBeenCalledOnce();
    expect(wakeHost).toHaveBeenCalledWith("agent-1");
    const [desired] = await db
      .select({ version: hostDesiredState.version, state: hostDesiredState.docJson })
      .from(hostDesiredState)
      .where(eq(hostDesiredState.hostId, "agent-1"));
    expect(desired?.version).toBe(1);
    expect(desired?.state.cached_images).toHaveLength(13);
  });
});

async function seedReusedBuilds(
  db: ReturnType<typeof drizzle>,
  ids: string[],
): Promise<void> {
  await db.insert(imageBuildBundles).values({
    rev: "published",
    r2Key: "builds/bundles/published.tar.gz",
    metaJson: {
      buildFormatVersion: "intar-image-build-v11",
      scenarios: [],
    },
    createdAt: 1,
    updatedAt: 1,
  });
  for (const scenarioId of ids) {
    await db.insert(imageBuilds).values({
      id: `reused-${scenarioId}`,
      scenarioId,
      arch: "x86_64" as const,
      rev: "published",
      contentHash,
      catalogChannel: "live" as const,
      status: "succeeded" as const,
      phase: "succeeded" as const,
      attempt: 1,
      timingsJson: {},
      publishedManifestJson: technicalManifest(scenarioId),
      createdAt: 1,
      updatedAt: 1,
    });
  }
}

async function seedAgentHost(
  db: ReturnType<typeof drizzle>,
  ids: string[],
  alreadyReady: boolean,
): Promise<void> {
  await db.insert(user).values({
    id: "owner",
    name: "Owner",
    email: "owner@example.test",
    emailVerified: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
  await db.insert(agentHosts).values({
    id: "agent-1",
    userId: "owner",
    name: "agent-1",
    role: "agent",
    connected: true,
    createdAt: 1,
    updatedAt: 1,
  });
  await db.insert(hostActualState).values({
    hostId: "agent-1",
    appliedDesiredVersion: alreadyReady ? 7 : 0,
    observedAt: 1,
    reportJson: hostReport(),
    createdAt: 1,
    updatedAt: 1,
  });
  if (!alreadyReady) return;

  const desired = createEmptyHostDesiredState({
    hostId: "agent-1",
    nowUnixMs: 1,
  });
  desired.version = 7;
  desired.cached_images = ids.map((scenarioId) => ({
    image_key: { scenario: scenarioId, vm: "vm", arch: "x86_64" },
    image_id: "b".repeat(64),
  }));
  await db.insert(hostDesiredState).values({
    hostId: "agent-1",
    version: desired.version,
    docJson: desired,
    createdAt: 1,
    updatedAt: 1,
  });
}

function reusedMeta(ids: string[]): ImageBuildBundleMeta {
  return {
    buildFormatVersion: "intar-image-build-v11",
    catalogChannel: "candidate",
    scenarios: ids.map((scenarioId) => ({
      scenarioId,
      arch: "x86_64",
      contentHash,
    })),
  };
}

function hostReport(): HostStateReportV2 {
  return {
    schema_version: 5,
    host_id: "agent-1",
    observed_at_unix_ms: 1,
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
      arch: "x86_64",
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

function technicalManifest(scenarioId = "task"): ScenarioManifestV4 {
  return {
    schema_version: 4,
    scenario_id: scenarioId,
    name: scenarioId,
    title: "Technical title",
    category: "technical",
    description: "Technical description",
    difficulty: "easy",
    estimated_minutes: 10,
    tags: ["technical"],
    briefing_markdown: "Technical briefing",
    solution_markdown: "Technical solution",
    hints: [],
    vms: [
      {
        name: "vm",
        image_key: { scenario: scenarioId, vm: "vm", arch: "x86_64" },
        image_id: "b".repeat(64),
        image_format: "raw_zstd",
        image_virtual_size_bytes: 1,
        chunk_manifest_sha256: "",
        guest_bootstrap_abi: 0,
        boot: {
          kernel_sha256: "c".repeat(64),
          initrd_sha256: "d".repeat(64),
          cmdline: "root=/dev/vda rw",
        },
        cpu_millis: 1_000,
        vcpu_count: 1,
        memory_mib: 512,
        disk_mib: 1_024,
        probes: [],
      },
    ],
  };
}
