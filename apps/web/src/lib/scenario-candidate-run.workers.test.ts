/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import {
  hostDesiredState,
  imageBuildBundles,
  imageBuilds,
  organization,
  scenarioCatalogCandidates,
  scenarioRuns,
} from "@/db/schema";
import type { ScenarioManifestV4 } from "@/generated/catalog";
import { IMAGE_BUILD_FORMAT_VERSION } from "@/lib/image-build-format";
import { startScenarioRunForUser } from "@/lib/scenario-runs";
import { destroyScenarioRunForUserWithDependencies } from "@/lib/scenario-runs/lifecycle";
import { markRunVmsAbsentInDesiredState } from "@/lib/scenario-runs/start";
import { loadCandidateScenarioRunSource } from "@/lib/scenario-runs/candidate";
import { updateRunState } from "@/lib/scenario-runs/storage";
import {
  betaAdmissionForHostFixture,
  connectHost,
  resetHostRuntimeTestDatabase,
  seedEnabledScenario,
  seedHost,
  sendBridge,
  stateReport,
  testImageKey,
  waitForHostActualState,
} from "@/control-plane/host-runtime-do/test-fixtures";
import type { RunStateDocument } from "@/lib/run-state";

const CANDIDATE_REVISION = "image-build-v12-proof";
const CANDIDATE_BUILD_ID = "candidate-build";
const CANDIDATE_IMAGE_ID = "c".repeat(64);
const CANDIDATE_CONTENT_HASH = "a".repeat(64);

describe("candidate scenario proof runs", () => {
  beforeEach(resetHostRuntimeTestDatabase);

  it("uses the ready candidate image, probes, solution, replay state, and normal teardown path", async () => {
    const db = drizzle(env.DB);
    const now = Date.now();
    const hostId = "candidate-proof-agent";
    await seedHost(hostId);
    const { ws } = await connectHost(hostId);
    await seedEnabledScenario(db, now);
    await seedCandidate(db, candidateManifest());

    sendBridge(
      ws,
      stateReport(hostId, {
        observedAt: now,
        appliedDesiredVersion: 0,
        cachedImages: [
          {
            image_key: testImageKey,
            image_id: CANDIDATE_IMAGE_ID,
            phase: "ready",
            updated_at_unix_ms: now,
          },
        ],
      }),
    );
    await waitForHostActualState(
      db,
      hostId,
      (row) => row.observedAt === now,
    );

    const started = await startScenarioRunForUser({
      scenarioId: "broken-nginx",
      userId: "user-1",
      betaAdmission: await betaAdmissionForHostFixture("user-1"),
      hostId,
      candidateRevision: CANDIDATE_REVISION,
      candidateBuildId: CANDIDATE_BUILD_ID,
      allowDrainedAdminProof: true,
      allowSequenceBypass: true,
    });

    expect(started.run).toMatchObject({
      title: "Candidate Broken Nginx",
      solution: { unlocked: false, revealed: false },
      replayState: "not_started",
    });
    const [run] = await db
      .select({
        hintsJson: scenarioRuns.hintsJson,
        solutionMarkdown: scenarioRuns.solutionMarkdown,
        stateJson: scenarioRuns.stateJson,
      })
      .from(scenarioRuns)
      .where(eq(scenarioRuns.runId, started.runId));
    expect(run?.solutionMarkdown).toBe("Use the candidate solution.");
    expect(run?.hintsJson).toEqual([
      expect.objectContaining({
        id: "candidate-hint",
        title: "Candidate hint",
        bodyMarkdown: "Check the candidate service.",
      }),
    ]);
    const state = JSON.parse(run?.stateJson ?? "{}") as RunStateDocument;
    expect(state.candidateSource).toEqual({
      revision: CANDIDATE_REVISION,
      buildId: CANDIDATE_BUILD_ID,
    });
    expect(state.vms[0]?.provisioning).toMatchObject({
      imageKey: testImageKey,
      imageSha256: CANDIDATE_IMAGE_ID,
    });
    expect(state.vms[0]?.bootProbes.map((probe) => probe.id)).toEqual([
      "candidate-boot",
    ]);
    expect(state.vms[0]?.scenarioProbes.map((probe) => probe.id)).toEqual([
      "candidate-repair",
    ]);

    const [desired] = await db
      .select({ state: hostDesiredState.docJson })
      .from(hostDesiredState)
      .where(eq(hostDesiredState.hostId, hostId));
    expect(
      desired?.state.vms.find((vm) => vm.run_id === started.runId),
    ).toMatchObject({
      image_key: testImageKey,
      image_id: CANDIDATE_IMAGE_ID,
    });

    const teardown = await destroyScenarioRunForUserWithDependencies(
      { runId: started.runId, userId: "user-1" },
      {
        markVmsAbsent: markRunVmsAbsentInDesiredState,
        revokeRoutes: async () => undefined,
        wakeHostRuntime: async () => undefined,
      },
    );
    expect(teardown.run.replayState).toBe("preparing");
    const [afterTeardown] = await db
      .select({ state: hostDesiredState.docJson })
      .from(hostDesiredState)
      .where(eq(hostDesiredState.hostId, hostId));
    expect(
      afterTeardown?.state.vms.find((vm) => vm.run_id === started.runId)
        ?.desired_phase,
    ).toBe("absent");
    const [afterLifecycleMutation] = await db
      .select({ stateJson: scenarioRuns.stateJson })
      .from(scenarioRuns)
      .where(eq(scenarioRuns.runId, started.runId));
    expect(
      (JSON.parse(afterLifecycleMutation?.stateJson ?? "{}") as RunStateDocument)
        .candidateSource,
    ).toEqual({
      revision: CANDIDATE_REVISION,
      buildId: CANDIDATE_BUILD_ID,
    });
    ws.close();
  });

  it("does not fall back to the published scenario when a candidate revision is missing", async () => {
    const db = drizzle(env.DB);
    const now = Date.now();
    const hostId = "candidate-fallback-agent";
    await seedHost(hostId);
    const { ws } = await connectHost(hostId);
    await seedEnabledScenario(db, now);
    sendBridge(
      ws,
      stateReport(hostId, {
        observedAt: now,
        appliedDesiredVersion: 0,
        cachedImages: [
          {
            image_key: testImageKey,
            image_id: "2".repeat(64),
            phase: "ready",
            updated_at_unix_ms: now,
          },
        ],
      }),
    );
    await waitForHostActualState(
      db,
      hostId,
      (row) => row.observedAt === now,
    );

    await expect(
      startScenarioRunForUser({
        scenarioId: "broken-nginx",
        userId: "user-1",
        betaAdmission: await betaAdmissionForHostFixture("user-1"),
        hostId,
        candidateRevision: "missing-candidate",
        candidateBuildId: "missing-build",
        allowDrainedAdminProof: true,
        allowSequenceBypass: true,
      }),
    ).rejects.toMatchObject({ code: "scenario_candidate_not_ready" });
    await expect(
      db
        .select({ runId: scenarioRuns.runId })
        .from(scenarioRuns)
        .where(eq(scenarioRuns.scenarioId, "broken-nginx")),
    ).resolves.toEqual([]);
    ws.close();
  });

  it("does not reuse an active published run for a candidate request", async () => {
    const db = drizzle(env.DB);
    const now = Date.now();
    const hostId = "candidate-active-run-agent";
    await seedHost(hostId);
    const { ws } = await connectHost(hostId);
    await seedEnabledScenario(db, now);
    await seedCandidate(db, candidateManifest());
    sendBridge(
      ws,
      stateReport(hostId, {
        observedAt: now,
        appliedDesiredVersion: 0,
        cachedImages: [
          {
            image_key: testImageKey,
            image_id: "2".repeat(64),
            phase: "ready",
            updated_at_unix_ms: now,
          },
          {
            image_key: testImageKey,
            image_id: CANDIDATE_IMAGE_ID,
            phase: "ready",
            updated_at_unix_ms: now,
          },
        ],
      }),
    );
    await waitForHostActualState(
      db,
      hostId,
      (row) => row.observedAt === now,
    );

    const published = await startScenarioRunForUser({
      scenarioId: "broken-nginx",
      userId: "user-1",
      betaAdmission: await betaAdmissionForHostFixture("user-1"),
      hostId,
    });
    await expect(
      startScenarioRunForUser({
        scenarioId: "broken-nginx",
        userId: "user-1",
        betaAdmission: await betaAdmissionForHostFixture("user-1"),
        hostId,
        candidateRevision: CANDIDATE_REVISION,
        candidateBuildId: CANDIDATE_BUILD_ID,
        allowDrainedAdminProof: true,
        allowSequenceBypass: true,
      }),
    ).rejects.toMatchObject({ code: "scenario_run_active_conflict" });

    const [run] = await db
      .select({ stateJson: scenarioRuns.stateJson })
      .from(scenarioRuns)
      .where(eq(scenarioRuns.runId, published.runId));
    const state = JSON.parse(run?.stateJson ?? "{}") as RunStateDocument;
    expect(state.vms[0]?.provisioning.imageSha256).toBe("2".repeat(64));
    ws.close();
  });

  it("does not reuse an active candidate run for a normal live start after a state update", async () => {
    const db = drizzle(env.DB);
    const now = Date.now();
    const hostId = "candidate-to-live-agent";
    await seedHost(hostId);
    const { ws } = await connectHost(hostId);
    await seedEnabledScenario(db, now);
    await seedCandidate(db, candidateManifest());
    sendBridge(
      ws,
      stateReport(hostId, {
        observedAt: now,
        appliedDesiredVersion: 0,
        cachedImages: [
          {
            image_key: testImageKey,
            image_id: "2".repeat(64),
            phase: "ready",
            updated_at_unix_ms: now,
          },
          {
            image_key: testImageKey,
            image_id: CANDIDATE_IMAGE_ID,
            phase: "ready",
            updated_at_unix_ms: now,
          },
        ],
      }),
    );
    await waitForHostActualState(
      db,
      hostId,
      (row) => row.observedAt === now,
    );

    const candidate = await startScenarioRunForUser({
      scenarioId: "broken-nginx",
      userId: "user-1",
      betaAdmission: await betaAdmissionForHostFixture("user-1"),
      hostId,
      candidateRevision: CANDIDATE_REVISION,
      candidateBuildId: CANDIDATE_BUILD_ID,
      allowDrainedAdminProof: true,
      allowSequenceBypass: true,
    });
    await updateRunState(candidate.runId, {
      mutate: (current) => ({
        ...current,
        phaseDetail: "Candidate proof remains active.",
      }),
    });

    await expect(
      startScenarioRunForUser({
        scenarioId: "broken-nginx",
        userId: "user-1",
        betaAdmission: await betaAdmissionForHostFixture("user-1"),
        hostId,
      }),
    ).rejects.toMatchObject({ code: "scenario_run_active_conflict" });
    const [run] = await db
      .select({ stateJson: scenarioRuns.stateJson })
      .from(scenarioRuns)
      .where(eq(scenarioRuns.runId, candidate.runId));
    expect((JSON.parse(run?.stateJson ?? "{}") as RunStateDocument).candidateSource).toEqual({
      revision: CANDIDATE_REVISION,
      buildId: CANDIDATE_BUILD_ID,
    });
    ws.close();
  });

  it("fails closed for an unready candidate build", async () => {
    const db = drizzle(env.DB);
    await seedCandidate(db, candidateManifest(), { status: "building" });

    await expect(
      loadCandidateScenarioRunSource(db, {
        revision: CANDIDATE_REVISION,
        buildId: CANDIDATE_BUILD_ID,
        scenarioId: "broken-nginx",
        organizationId: null,
      }),
    ).resolves.toBeNull();
  });

  it("fails closed when a candidate manifest does not match its build output", async () => {
    const db = drizzle(env.DB);
    const published = candidateManifest();
    const publishedVm = published.vms[0];
    if (!publishedVm) throw new Error("candidate fixture is missing its VM");
    publishedVm.image_id = "b".repeat(64);
    await seedCandidate(db, candidateManifest(), {
      publishedManifest: published,
    });

    await expect(
      loadCandidateScenarioRunSource(db, {
        revision: CANDIDATE_REVISION,
        buildId: CANDIDATE_BUILD_ID,
        scenarioId: "broken-nginx",
        organizationId: null,
      }),
    ).resolves.toBeNull();
  });

  it("fails closed when the selected build is no longer staged for the candidate revision", async () => {
    const db = drizzle(env.DB);
    await seedCandidate(db, candidateManifest());

    await expect(
      loadCandidateScenarioRunSource(db, {
        revision: CANDIDATE_REVISION,
        buildId: "candidate-build-stale",
        scenarioId: "broken-nginx",
        organizationId: null,
      }),
    ).resolves.toBeNull();
  });

  it("rejects a staged candidate from the previous image build format", async () => {
    const db = drizzle(env.DB);
    await seedCandidate(db, candidateManifest(), {
      candidateBuildFormatVersion: "intar-image-build-v11",
    });

    await expect(
      loadCandidateScenarioRunSource(db, {
        revision: CANDIDATE_REVISION,
        buildId: CANDIDATE_BUILD_ID,
        scenarioId: "broken-nginx",
        organizationId: null,
      }),
    ).resolves.toBeNull();
  });

  it("accepts a current-format candidate that reuses an exact live source build", async () => {
    const db = drizzle(env.DB);
    await seedCandidate(db, candidateManifest(), {
      sourceRevision: "published-v12",
      buildCatalogChannel: "live",
    });

    await expect(
      loadCandidateScenarioRunSource(db, {
        revision: CANDIDATE_REVISION,
        buildId: CANDIDATE_BUILD_ID,
        scenarioId: "broken-nginx",
        organizationId: null,
      }),
    ).resolves.toMatchObject({
      candidateSource: {
        revision: CANDIDATE_REVISION,
        buildId: CANDIDATE_BUILD_ID,
      },
      launchSpecs: [
        {
          imageSha256: CANDIDATE_IMAGE_ID,
        },
      ],
    });
  });

  it("rejects a reusable candidate when its source bundle tuple differs", async () => {
    const db = drizzle(env.DB);
    await seedCandidate(db, candidateManifest(), {
      sourceRevision: "published-v12",
      buildCatalogChannel: "live",
      sourceContentHash: "b".repeat(64),
    });

    await expect(
      loadCandidateScenarioRunSource(db, {
        revision: CANDIDATE_REVISION,
        buildId: CANDIDATE_BUILD_ID,
        scenarioId: "broken-nginx",
        organizationId: null,
      }),
    ).resolves.toBeNull();
  });

  it("does not resolve a candidate from another organization scope", async () => {
    const db = drizzle(env.DB);
    await db.insert(organization).values({
      id: "candidate-org",
      name: "Candidate organization",
      slug: "candidate-organization",
      createdAt: new Date(),
    });
    await seedCandidate(db, candidateManifest(), {
      organizationId: "candidate-org",
    });

    await expect(
      loadCandidateScenarioRunSource(db, {
        revision: CANDIDATE_REVISION,
        buildId: CANDIDATE_BUILD_ID,
        scenarioId: "broken-nginx",
        organizationId: null,
      }),
    ).resolves.toBeNull();
    await expect(
      loadCandidateScenarioRunSource(db, {
        revision: CANDIDATE_REVISION,
        buildId: CANDIDATE_BUILD_ID,
        scenarioId: "broken-nginx",
        organizationId: "candidate-org",
      }),
    ).resolves.toMatchObject({
      scenarioId: "broken-nginx",
      launchSpecs: [
        {
          imageKey: testImageKey,
          imageSha256: CANDIDATE_IMAGE_ID,
        },
      ],
    });
  });
});

async function seedCandidate(
  db: ReturnType<typeof drizzle>,
  manifest: ScenarioManifestV4,
  options: {
    organizationId?: string | null;
    status?: "succeeded" | "building";
    publishedManifest?: ScenarioManifestV4;
    candidateRevision?: string;
    sourceRevision?: string;
    buildId?: string;
    buildCatalogChannel?: "candidate" | "live";
    candidateBuildFormatVersion?: string;
    sourceBuildFormatVersion?: string;
    sourceContentHash?: string;
  } = {},
): Promise<void> {
  const now = Date.now();
  const organizationId = options.organizationId ?? null;
  const status = options.status ?? "succeeded";
  const candidateRevision = options.candidateRevision ?? CANDIDATE_REVISION;
  const sourceRevision = options.sourceRevision ?? candidateRevision;
  const buildId = options.buildId ?? CANDIDATE_BUILD_ID;
  const candidateMeta = {
    buildFormatVersion:
      options.candidateBuildFormatVersion ?? IMAGE_BUILD_FORMAT_VERSION,
    catalogChannel: "candidate" as const,
    scenarios: [
      {
        scenarioId: manifest.scenario_id,
        arch: "x86_64" as const,
        contentHash: CANDIDATE_CONTENT_HASH,
      },
    ],
  };
  const sourceMeta = {
    buildFormatVersion:
      options.sourceBuildFormatVersion ?? IMAGE_BUILD_FORMAT_VERSION,
    catalogChannel: options.buildCatalogChannel ?? "candidate",
    scenarios: [
      {
        scenarioId: manifest.scenario_id,
        arch: "x86_64" as const,
        contentHash: options.sourceContentHash ?? CANDIDATE_CONTENT_HASH,
      },
    ],
  };
  if (sourceRevision !== candidateRevision) {
    await db.insert(imageBuildBundles).values({
      rev: sourceRevision,
      organizationId,
      r2Key: `builds/bundles/${sourceRevision}.tar.gz`,
      metaJson: sourceMeta,
      createdAt: now,
      updatedAt: now,
    });
  }
  await db.insert(imageBuildBundles).values({
    rev: candidateRevision,
    organizationId,
    r2Key: `builds/bundles/${candidateRevision}.tar.gz`,
    metaJson: candidateMeta,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(imageBuilds).values({
    id: buildId,
    organizationId,
    scenarioId: manifest.scenario_id,
    arch: "x86_64",
    rev: sourceRevision,
    contentHash: CANDIDATE_CONTENT_HASH,
    catalogChannel: options.buildCatalogChannel ?? "candidate",
    status,
    phase: status === "succeeded" ? "succeeded" : "building",
    attempt: 1,
    timingsJson: {},
    publishedManifestJson: options.publishedManifest ?? manifest,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(scenarioCatalogCandidates).values({
    id: `${organizationId ?? "public"}:${candidateRevision}:${manifest.scenario_id}`,
    revision: candidateRevision,
    organizationId,
    scenarioId: manifest.scenario_id,
    buildId,
    manifestJson: manifest,
    createdAt: now,
    updatedAt: now,
  });
}

function candidateManifest(): ScenarioManifestV4 {
  return {
    schema_version: 4,
    scenario_id: "broken-nginx",
    name: "broken-nginx",
    title: "Candidate Broken Nginx",
    category: "linux",
    description: "Validate the candidate image.",
    difficulty: "easy",
    estimated_minutes: 10,
    tags: ["candidate"],
    briefing_markdown: "Use the candidate image for this proof.",
    solution_markdown: "Use the candidate solution.",
    hints: [
      {
        id: "candidate-hint",
        title: "Candidate hint",
        body_markdown: "Check the candidate service.",
      },
    ],
    vms: [
      {
        name: "webserver",
        image_key: testImageKey,
        image_id: CANDIDATE_IMAGE_ID,
        image_format: "raw_chunks_v1",
        image_virtual_size_bytes: 1_073_741_824,
        chunk_manifest_sha256: "d".repeat(64),
        guest_bootstrap_abi: 1,
        boot: {
          kernel_sha256: "e".repeat(64),
          initrd_sha256: "f".repeat(64),
          cmdline: "console=hvc0 root=/dev/vda rw",
        },
        cpu_millis: 125,
        vcpu_count: 1,
        memory_mib: 512,
        disk_mib: 4096,
        probes: [
          {
            id: "candidate-boot",
            phase: "boot",
            kind: "command",
            display_name: "Candidate boot check",
            hints: [],
          },
          {
            id: "candidate-repair",
            phase: "scenario",
            kind: "command",
            display_name: "Candidate repair check",
            hints: [],
          },
        ],
      },
    ],
  };
}
