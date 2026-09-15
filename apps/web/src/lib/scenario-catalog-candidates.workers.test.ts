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
  organization,
  scenarioCatalogCandidates,
  user,
  type ImageBuildBundleMeta,
} from "@/db/schema";
import type { HostStateReportV2 } from "@/generated/bridge";
import type { ScenarioManifestV5 } from "@/generated/catalog";
import { createEmptyHostDesiredState } from "@/lib/desired-state";
import { IMAGE_BUILD_FORMAT_VERSION } from "@/lib/image-build-format";
import {
  candidateScenarioId,
  stageCandidateScenarioManifest,
  stageReusableCandidateManifests,
} from "@/lib/scenario-catalog-candidates";
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
      buildFormatVersion: IMAGE_BUILD_FORMAT_VERSION,
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

const GUARD_SCENARIO_ID = "guarded-task";
const GUARD_REVISION = "guarded-revision";
const GUARD_BUILD_ID = "guarded-build";
const OTHER_ORGANIZATION_ID = "guarded-other-organization";
/** The staged timestamp the guard must leave alone when it refuses or replays. */
const STAGED_AT = 1_000;

describe("candidate source guard", () => {
  beforeEach(resetD1Database);

  it("refuses a changed manifest while an active run reads the row", async () => {
    const db = drizzle(env.DB);
    const manifest = technicalManifest(GUARD_SCENARIO_ID);
    await seedStagedCandidate({ revision: GUARD_REVISION, manifest });
    await seedCandidateRun({
      revision: GUARD_REVISION,
      scenarioId: GUARD_SCENARIO_ID,
      organizationId: null,
      executionState: "provisioning",
    });

    await expect(
      stageCandidateScenarioManifest(db, {
        revision: GUARD_REVISION,
        organizationId: null,
        buildId: GUARD_BUILD_ID,
        manifest: { ...manifest, title: "Changed title" },
        nowUnixMs: STAGED_AT + 1,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "candidate_source_locked",
    });

    // The reader and the retention root of the run are byte for byte what the
    // run read: a refused publish changes neither the manifest nor its stamp.
    await expect(loadStagedCandidate(GUARD_REVISION)).resolves.toMatchObject({
      buildId: GUARD_BUILD_ID,
      manifestJson: manifest,
      updatedAt: STAGED_AT,
    });
  });

  it("allows an identical replay and leaves the row untouched", async () => {
    const db = drizzle(env.DB);
    const manifest = technicalManifest(GUARD_SCENARIO_ID);
    await seedStagedCandidate({ revision: GUARD_REVISION, manifest });
    await seedCandidateRun({
      revision: GUARD_REVISION,
      scenarioId: GUARD_SCENARIO_ID,
      organizationId: null,
      executionState: "ready",
    });

    await expect(
      stageCandidateScenarioManifest(db, {
        revision: GUARD_REVISION,
        organizationId: null,
        buildId: GUARD_BUILD_ID,
        manifest,
        nowUnixMs: STAGED_AT + 1,
      }),
    ).resolves.toBeUndefined();

    await expect(loadStagedCandidate(GUARD_REVISION)).resolves.toMatchObject({
      buildId: GUARD_BUILD_ID,
      manifestJson: manifest,
      updatedAt: STAGED_AT,
    });
  });

  it("allows a changed manifest when no active run reads the row", async () => {
    const db = drizzle(env.DB);
    await seedOrganization(OTHER_ORGANIZATION_ID);
    const cases: Array<{
      name: string;
      run: null | {
        executionState: string;
        revision?: string;
        scenarioId: string;
        organizationId: string | null;
      };
    }> = [
      { name: "no run", run: null },
      {
        name: "another candidate revision",
        run: {
          executionState: "provisioning",
          revision: "other-revision",
          scenarioId: GUARD_SCENARIO_ID,
          organizationId: null,
        },
      },
      {
        name: "another scenario",
        run: {
          executionState: "provisioning",
          scenarioId: "other-scenario",
          organizationId: null,
        },
      },
      {
        name: "another organization",
        run: {
          executionState: "provisioning",
          scenarioId: GUARD_SCENARIO_ID,
          organizationId: OTHER_ORGANIZATION_ID,
        },
      },
      {
        name: "a run that already finished archiving",
        run: {
          executionState: "archived",
          scenarioId: GUARD_SCENARIO_ID,
          organizationId: null,
        },
      },
      {
        name: "a failed run",
        run: {
          executionState: "failed",
          scenarioId: GUARD_SCENARIO_ID,
          organizationId: null,
        },
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const revision = `${GUARD_REVISION}-${index}`;
      const manifest = technicalManifest(GUARD_SCENARIO_ID);
      await seedStagedCandidate({ revision, manifest });
      const run = testCase.run;
      if (run) {
        await seedCandidateRun({
          executionState: run.executionState,
          revision: run.revision ?? revision,
          scenarioId: run.scenarioId,
          organizationId: run.organizationId,
        });
      }

      const changed = { ...manifest, title: `changed-${index}` };
      await expect(
        stageCandidateScenarioManifest(db, {
          revision,
          organizationId: null,
          buildId: `${GUARD_BUILD_ID}-${index}`,
          manifest: changed,
          nowUnixMs: STAGED_AT + 1,
        }),
        testCase.name,
      ).resolves.toBeUndefined();

      await expect(loadStagedCandidate(revision)).resolves.toMatchObject({
        buildId: `${GUARD_BUILD_ID}-${index}`,
        manifestJson: changed,
        updatedAt: STAGED_AT + 1,
      });
    }
  });

  it("leaves no row behind when a run appears before the first stage", async () => {
    const db = drizzle(env.DB);
    await seedCandidateRun({
      revision: GUARD_REVISION,
      scenarioId: GUARD_SCENARIO_ID,
      organizationId: null,
      executionState: "queued",
    });

    await expect(
      stageCandidateScenarioManifest(db, {
        revision: GUARD_REVISION,
        organizationId: null,
        buildId: GUARD_BUILD_ID,
        manifest: technicalManifest(GUARD_SCENARIO_ID),
        nowUnixMs: STAGED_AT,
      }),
    ).rejects.toMatchObject({ code: "candidate_source_locked" });

    await expect(loadStagedCandidate(GUARD_REVISION)).resolves.toBeUndefined();
  });
});

/** The staged row as the guard's comparison and the callers read it. */
async function loadStagedCandidate(revision: string) {
  const rows = await drizzle(env.DB)
    .select({
      buildId: scenarioCatalogCandidates.buildId,
      manifestJson: scenarioCatalogCandidates.manifestJson,
      updatedAt: scenarioCatalogCandidates.updatedAt,
    })
    .from(scenarioCatalogCandidates)
    .where(
      eq(
        scenarioCatalogCandidates.id,
        candidateScenarioId(null, revision, GUARD_SCENARIO_ID),
      ),
    );
  return rows[0];
}

async function seedOrganization(organizationId: string): Promise<void> {
  await drizzle(env.DB).insert(organization).values({
    id: organizationId,
    name: organizationId,
    slug: organizationId,
    createdAt: new Date(STAGED_AT),
  });
}

async function seedStagedCandidate(input: {
  revision: string;
  manifest: ScenarioManifestV5;
}): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO scenario_catalog_candidates (id, revision, organization_id, scenario_id, build_id, manifest_json, created_at, updated_at)" +
      " VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?6)",
  )
    .bind(
      candidateScenarioId(null, input.revision, input.manifest.scenario_id),
      input.revision,
      input.manifest.scenario_id,
      GUARD_BUILD_ID,
      JSON.stringify(input.manifest),
      STAGED_AT,
    )
    .run();
}

/**
 * Seeds one run of a candidate revision in the runtime execution state the
 * guard reads. The run, its execution, its host, and its user are all required:
 * the retention policy resolves an active candidate from the same rows.
 */
async function seedCandidateRun(input: {
  revision: string;
  scenarioId: string;
  organizationId: string | null;
  executionState: string;
}): Promise<void> {
  const now = Date.now();
  const suffix = `${input.executionState}:${input.organizationId ?? "public"}:${input.scenarioId}:${input.revision}`;
  const userId = `guard-user:${suffix}`;
  const hostId = `guard-host:${suffix}`;
  const executionId = `guard-execution:${suffix}`;
  const runId = `guard-run:${suffix}`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO \"user\" (id, name, email, email_verified, created_at, updated_at)" +
        " VALUES (?1, ?1, ?1 || '@example.test', 1, ?2, ?2)",
    ).bind(userId, now),
    env.DB.prepare(
      "INSERT INTO agent_hosts (id, user_id, name, created_at, updated_at)" +
        " VALUES (?1, ?2, ?1, ?3, ?3)",
    ).bind(hostId, userId, now),
    env.DB.prepare(
      "INSERT INTO runtime_executions (id, user_id, organization_id, host_id, provider_kind, domain_kind, domain_id, generation, state, created_at, updated_at)" +
        " VALUES (?1, ?2, ?3, ?4, 'agent_kvm', 'scenario', ?5, 1, ?6, ?7, ?7)",
    ).bind(
      executionId,
      userId,
      input.organizationId,
      hostId,
      runId,
      input.executionState,
      now,
    ),
    env.DB.prepare(
      "INSERT INTO scenario_runs (run_id, user_id, organization_id, runtime_execution_id, host_id, scenario_id, scenario_name, title, tagline, briefing_markdown, objectives_json, difficulty, estimated_minutes, tags_json, hints_json, solution_markdown, vm_count, state, state_rank, request_scope_json, state_json, created_at, updated_at)" +
        " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?6, '', '', '[]', 'easy', 10, '[]', '[]', '', 1, 'provisioning', 1, ?7, '{}', ?8, ?8)",
    ).bind(
      runId,
      userId,
      input.organizationId,
      executionId,
      hostId,
      input.scenarioId,
      JSON.stringify({
        scenarioId: input.scenarioId,
        organizationId: input.organizationId,
        hostId: null,
        candidateRevision: input.revision,
        candidateBuildId: GUARD_BUILD_ID,
        allowDrainedAdminProof: true,
        allowSequenceBypass: false,
      }),
      now,
    ),
  ]);
}

async function seedReusedBuilds(
  db: ReturnType<typeof drizzle>,
  ids: string[],
): Promise<void> {
  await db.insert(imageBuildBundles).values({
    rev: "published",
    r2Key: "builds/bundles/published.tar.gz",
    metaJson: {
      buildFormatVersion: IMAGE_BUILD_FORMAT_VERSION,
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
    buildFormatVersion: IMAGE_BUILD_FORMAT_VERSION,
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
    schema_version: 6,
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
      supports_kvm: true,
      supports_vsock: true,
      supports_reflink: true,
      supports_nftables: true,
      supports_jailer_v2: true,
      supports_jailer_v3: true,
      supports_raw_chunks_v1: true,
      supports_scenario_guest_tools_v1: true,
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

function technicalManifest(scenarioId = "task"): ScenarioManifestV5 {
  return {
    schema_version: 5,
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
        memory_mib: 512,
        disk_mib: 1_024,
        probes: [],
      },
    ],
  };
}
