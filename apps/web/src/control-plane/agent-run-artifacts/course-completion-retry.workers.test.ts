/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleAgentRunArtifactRequest } from "@/control-plane/agent-run-artifacts";
import { handleAgentBootstrap, sha256Hex } from "@/control-plane/auth";
import { agentHosts, scenarioRuns, user } from "@/db/schema";
import {
  ensureArtifactStates,
  loadArtifactStatesForRunVm,
  markArtifactUploaded,
  loadStoredRunLifecycle,
  transitionRunVmToCompleted,
} from "@/control-plane/agent-run-artifacts/storage";
import {
  RUN_PHASE_ORDER,
  buildInitialRunState,
  recomputeRunState,
} from "@/lib/run-state";
import { platformArtifactFixture } from "./test-fixtures";
import { resetD1Database } from "@/test/d1-migrations";

describe("course completion retry after archive persistence", () => {
  beforeEach(async () => {
    await resetD1Database();
    vi.restoreAllMocks();
  });

  it("rolls back sealing and lifecycle if course credit fails, then retries atomically", async () => {
    const db = drizzle(env.DB);
    const now = 10_000;
    await seedSolvedRun(db, now);
    await env.DB.prepare(
      "UPDATE scenario_runs SET course_scope_key = 'public', course_id = 'course', lecture_id = 'unit' WHERE run_id = 'run-1'",
    ).run();
    const runVm = await platformArtifactFixture(env.DB, "server-run-1");
    const original = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce((statements) =>
      original([
        ...statements,
        env.DB.prepare("INSERT INTO missing_course_credit_table VALUES (1)"),
      ]),
    );
    await expect(
      transitionRunVmToCompleted(db, runVm, now + 1),
    ).rejects.toThrow();
    expect(await loadStoredRunLifecycle(db, "run-1")).toMatchObject({
      state: { phase: "solved" },
      completedAt: null,
    });
    expect(
      await env.DB.prepare(
        "SELECT artifact_writes_sealed FROM runtime_vms",
      ).first(),
    ).toEqual({ artifact_writes_sealed: 0 });
    expect(
      (await env.DB.prepare("SELECT * FROM course_unit_completions").all())
        .results,
    ).toHaveLength(0);

    await transitionRunVmToCompleted(db, runVm, now + 2);
    await transitionRunVmToCompleted(db, runVm, now + 3);
    expect(await loadStoredRunLifecycle(db, "run-1")).toMatchObject({
      state: { phase: "completed" },
      completedAt: now + 2,
    });
    expect(
      await env.DB.prepare(
        "SELECT artifact_writes_sealed FROM runtime_vms",
      ).first(),
    ).toEqual({ artifact_writes_sealed: 1 });
    expect(
      (await env.DB.prepare("SELECT * FROM course_unit_completions").all())
        .results,
    ).toHaveLength(1);
  });

  it("serializes two VM completion snapshots without losing a seal, outcome, or course credit", async () => {
    const db = drizzle(env.DB);
    await seedSolvedRun(db, 10_000, 2);
    await env.DB.prepare(
      "UPDATE scenario_runs SET course_scope_key = 'public', course_id = 'course', lecture_id = 'unit' WHERE run_id = 'run-1'",
    ).run();
    await platformArtifactFixture(env.DB, "server-run-1");
    const token = await fixtureToken();
    let afterConflict: unknown;
    const held = holdTwoWrites(async () => {
      afterConflict = (
        await env.DB.prepare(
          "SELECT vm_id,artifact_writes_sealed FROM runtime_vms ORDER BY vm_id",
        ).all()
      ).results;
    });
    const complete = (name: string) =>
      handleAgentRunArtifactRequest(
        new Request(`http://localhost/agent/runs/run-1/vms/${name}/complete`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        }),
        env,
      );
    const first = complete("server-run-1");
    await held.entered[0].promise;
    const second = complete("server-run-2");
    await held.entered[1].promise; // Both full run-state snapshots are now the same.
    held.release[0].resolve();
    expect((await first)?.status).toBe(200);
    held.release[1].resolve();
    expect((await second)?.status).toBe(200);
    // The failed CAS rolled the whole second transaction back before retry.
    expect(afterConflict).toEqual([
      { vm_id: "vm-1", artifact_writes_sealed: 1 },
      { vm_id: "vm-2", artifact_writes_sealed: 0 },
    ]);
    const run = await loadStoredRunLifecycle(db, "run-1");
    expect(run?.state.phase).toBe("completed");
    expect(run?.state.vms.map((vm) => vm.phase)).toEqual([
      "completed",
      "completed",
    ]);
    expect(
      (
        await env.DB.prepare(
          "SELECT artifact_writes_sealed FROM runtime_vms",
        ).all()
      ).results,
    ).toEqual([{ artifact_writes_sealed: 1 }, { artifact_writes_sealed: 1 }]);
    expect(
      await env.DB.prepare(
        "SELECT state FROM runtime_executions WHERE id = 'run-1'",
      ).first(),
    ).toEqual({ state: "archived" });
    expect(
      (await env.DB.prepare("SELECT * FROM course_unit_completions").all())
        .results,
    ).toHaveLength(1);
  });

  it("reloads concurrent raw and segment metadata instead of losing either publication", async () => {
    const db = drizzle(env.DB);
    await seedSolvedRun(db, 10_000);
    const runVm = await platformArtifactFixture(env.DB, "server-run-1");
    await ensureArtifactStates({
      db,
      runVm,
      createdAt: 10_000,
      artifacts: ["ssh_recording_raw", "ssh_recording_segment"].map(
        (kind, index) => ({
          ordinal: index + 1,
          kind,
          filename: `${kind}.cast`,
          contentType: "text/plain",
          sizeBytes: 0,
          sha256: "a".repeat(64),
        }),
      ),
    });
    const artifacts = await loadArtifactStatesForRunVm(db, runVm);
    const held = holdTwoWrites();
    const raw = markArtifactUploaded({
      db,
      runVm,
      artifact: artifacts[0]!,
      uploadedAt: 10_001,
    });
    await held.entered[0].promise;
    const segment = markArtifactUploaded({
      db,
      runVm,
      artifact: artifacts[1]!,
      uploadedAt: 10_002,
    });
    await held.entered[1].promise;
    held.release[0].resolve();
    await raw;
    held.release[1].resolve();
    await segment;
    const run = await loadStoredRunLifecycle(db, "run-1");
    expect(run?.state.vms[0]?.hasRecording).toBe(true);
    expect(
      run?.state.vms[0]?.replayArtifacts.map((artifact) => artifact.id),
    ).toEqual([artifacts[1]!.id]);
    expect(
      (await loadArtifactStatesForRunVm(db, runVm)).map(
        (artifact) => artifact.uploadStatus,
      ),
    ).toEqual(["uploaded", "uploaded"]);
  });
});

async function seedSolvedRun(
  db: ReturnType<typeof drizzle>,
  now: number,
  vmCount = 1,
): Promise<void> {
  await db.insert(user).values({
    id: "user-1",
    name: "Course learner",
    email: "course-learner@example.test",
  });
  await db.insert(agentHosts).values({
    id: "host-1",
    userId: "user-1",
    name: "Course host",
  });
  const initial = buildInitialRunState({
    vms: Array.from({ length: vmCount }, (_, index) => ({
      id: `vm-${index + 1}`,
      ordinal: index,
      scenarioVmId: "scenario-vm-1",
      scenarioVmName: "server",
      runtimeVmName: `server-run-${index + 1}`,
      hostname: "server",
      launchSummary: {
        scenarioVmName: "server",
        hostname: "server",
        probePhaseMap: {},
        probeDescriptors: [],
      },
    })),
  });
  const solved = recomputeRunState({
    ...initial,
    phase: "solved",
    vms: initial.vms.map((vm) => ({
      ...vm,
      phase: vmCount > 1 ? "archived" : "solved",
    })),
  });
  await db.insert(scenarioRuns).values({
    runId: "run-1",
    userId: "user-1",
    hostId: "host-1",
    scenarioId: "scenario-1",
    scenarioName: "scenario-1",
    title: "Scenario",
    tagline: "Test",
    briefingMarkdown: "Briefing",
    objectivesJson: "[]",
    difficulty: "easy",
    estimatedMinutes: 10,
    tagsJson: [],
    hintsJson: [],
    solutionMarkdown: "Solution",
    vmCount,
    state: solved.phase,
    stateRank: RUN_PHASE_ORDER[solved.phase],
    activeKey: "user-1",
    stateJson: JSON.stringify(solved),
    solvedAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function holdTwoWrites(onConflict?: () => Promise<void>) {
  const entered = [deferred(), deferred()] as const;
  const release = [deferred(), deferred()] as const;
  const original = env.DB.batch.bind(env.DB);
  let arrivals = 0;
  vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
    // Single-statement batches only resolve the verified identity.
    if (statements.length < 2 || arrivals >= 2) return original(statements);
    const slot = arrivals++;
    entered[slot]!.resolve();
    await release[slot]!.promise;
    try {
      return await original(statements);
    } catch (error) {
      await onConflict?.();
      throw error;
    }
  });
  return { entered, release };
}

async function fixtureToken() {
  const secret = "artifact-test-bootstrap";
  await env.DB.prepare(
    "UPDATE agent_bootstrap_tokens SET token_hash = ? WHERE id = 'artifact-fixture'",
  )
    .bind(await sha256Hex(secret))
    .run();
  const response = await handleAgentBootstrap(
    new Request("http://localhost/agent/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: "host-1", bootstrapToken: secret }),
    }),
    env,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { accessToken: string }).accessToken;
}
