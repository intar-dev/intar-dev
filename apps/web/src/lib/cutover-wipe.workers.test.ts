/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetHostRuntimeTestDatabase,
  seedHost,
  seedRun,
} from "@/control-plane/host-runtime-do/test-fixtures";
import {
  courseUnitCompletions,
  hostCpuReservations,
  organization,
  runtimeOperationGates,
  scenarioAssignments,
  scenarioRunArtifacts,
  scenarioRunArtifactUploads,
} from "@/db/schema";
import { completePureCourseLectureForUser } from "@/lib/course-catalogs";
import { wipeScenarioData } from "@/lib/cutover-wipe";
import { StaticFeatureToggleService } from "@/lib/feature-toggles";
import { assertAgentKvmRunsOpen, assertCutoverNotWiped, IMAGE_CUTOVER_GATE } from "@/lib/run-admission-gate";
import { enableRunShare, RUN_SHARING_FLAG } from "@/lib/run-share/service";

const effects = vi.hoisted(() => ({ revokeRoute: vi.fn() }));
vi.mock("@/lib/stargate", async (original) => ({
  ...await original<typeof import("@/lib/stargate")>(),
  deleteStargateRoute: effects.revokeRoute,
}));

async function gateState(): Promise<string | null> {
  const row = await env.DB.prepare("SELECT state FROM runtime_operation_gates WHERE key = ?")
    .bind(IMAGE_CUTOVER_GATE)
    .first<{ state: string }>();
  return row?.state ?? null;
}

async function setGate(state: "open" | "drained"): Promise<void> {
  await drizzle(env.DB).insert(runtimeOperationGates).values({ key: IMAGE_CUTOVER_GATE, state });
}

describe("cutover wipe", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    effects.revokeRoute.mockResolvedValue(undefined);
    await resetHostRuntimeTestDatabase();
    await seedHost("host-1");
    const db = drizzle(env.DB);
    await seedRun({ db, hostId: "host-1", runId: "run-1", now: Date.now() });
    await enableRunShare({
      runId: "run-1",
      userId: "user-1",
      toggles: new StaticFeatureToggleService({ [RUN_SHARING_FLAG]: true }),
    });
    const upload = await env.VM_RUN_ARTIFACTS_BUCKET.createMultipartUpload("runs/run-1/session.cast");
    await db.insert(scenarioRunArtifacts).values({
      id: "artifact-1", runId: "run-1", vmId: "vm-1", ordinal: 0, kind: "ssh_recording_segment",
      filename: "session.cast", contentType: "application/x-asciicast", sizeBytes: 1,
      sha256: "0".repeat(64), r2Key: upload.key, uploadStatus: "pending",
    });
    await db.insert(scenarioRunArtifactUploads).values({
      artifactId: "artifact-1", r2UploadId: upload.uploadId, uploadedPartsJson: "[]", nextExpectedPart: 1,
    });
    await db.insert(organization).values({ id: "org-1", name: "Org", slug: "org", createdAt: new Date() });
    await db.insert(scenarioAssignments).values({
      id: "assignment-1", organizationId: "org-1", scenarioId: "broken-nginx", assignedBy: "user-1",
    });
    await db.insert(courseUnitCompletions).values({
      userId: "user-1", scopeKey: "public", courseId: "linux-operations", lectureId: "01-broken-nginx",
      sourceRunId: "run-1", completedAt: Date.now(),
    });
    await db.insert(hostCpuReservations).values({
      runId: "orphan-run", hostId: "host-1", cpuMillis: 1_000, state: "committed",
    });
  });

  it("is refused unless the gate is drained", async () => {
    await expect(wipeScenarioData()).rejects.toMatchObject({ status: 409 });
    await setGate("open");
    await expect(wipeScenarioData()).rejects.toMatchObject({ status: 409 });
    expect(await gateState()).toBe("open");
    const runs = await env.DB.prepare("SELECT COUNT(*) AS count FROM scenario_runs").first<{ count: number }>();
    expect(runs?.count).toBe(1);
  });

  it("deletes every scenario row and keeps accounts, organizations and hosts", async () => {
    await setGate("drained");

    const report = await wipeScenarioData();

    expect(report.complete).toBe(true);
    expect(Object.values(report.remaining).every((count) => count === 0)).toBe(true);
    expect(report.kept.after).toEqual(report.kept.before);
    expect(report.kept.before).toMatchObject({ agent_hosts: 1, organization: 1 });
    expect(report.kept.before.user).toBeGreaterThan(0);
    expect(report.sharesStopped).toBe(1);
    expect(report.runRoutesRevoked).toBe(1);
    expect(effects.revokeRoute).toHaveBeenCalled();
    expect(report.uploadsAborted).toBe(1);
    expect(report.deleted).toMatchObject({
      scenario_runs: 1, runtime_executions: 1, host_cpu_reservations: 1,
      course_unit_completions: 1, scenario_assignments: 1,
    });
    // The upload is aborted, never completed into an object.
    expect(await env.VM_RUN_ARTIFACTS_BUCKET.head("runs/run-1/session.cast")).toBeNull();
    expect(await gateState()).toBe("wiped");

    // Nothing refills the tables before the epoch migration.
    await expect(assertCutoverNotWiped(env.DB)).rejects.toMatchObject({ status: 503 });
    await expect(completePureCourseLectureForUser({
      db: drizzle(env.DB), userId: "user-1", organizationId: null,
      courseId: "linux-operations", lectureId: "reading", nowUnixMs: Date.now(),
    })).rejects.toMatchObject({ status: 503, code: "runtime_cutover_wiped" });
    await expect(assertAgentKvmRunsOpen(env.DB)).rejects.toMatchObject({ status: 503 });
    await expect(assertAgentKvmRunsOpen(env.DB, { allowDrainedAdminProof: true }))
      .rejects.toMatchObject({ status: 503 });

    // A retry finds nothing left and stays wiped.
    await expect(wipeScenarioData()).resolves.toMatchObject({ complete: true, sharesStopped: 0 });
    expect(await gateState()).toBe("wiped");
  });

  it("stops at its per-call budget and finishes on the next call", async () => {
    await setGate("drained");
    // 229 finished copies of run-1 beyond the 200-row budget of one call.
    await env.DB.batch([
      env.DB.prepare("CREATE TABLE run_copy AS SELECT * FROM scenario_runs"),
      env.DB.prepare(`UPDATE run_copy SET active_key = NULL, share_id = NULL,
        runtime_execution_id = NULL, state = 'completed'`),
    ]);
    for (let index = 0; index < 229; index += 1) {
      await env.DB.batch([
        env.DB.prepare("UPDATE run_copy SET run_id = ?").bind(`copy-${index}`),
        env.DB.prepare("INSERT INTO scenario_runs SELECT * FROM run_copy"),
      ]);
    }
    await env.DB.prepare("DROP TABLE run_copy").run();

    const first = await wipeScenarioData();
    expect(first.complete).toBe(false);
    expect(first.deleted.scenario_runs).toBe(200);
    expect(first.remaining.scenario_runs).toBe(30);
    expect(first.remaining.scenario_assignments).toBe(1);

    const second = await wipeScenarioData();
    expect(second.complete).toBe(true);
    expect(second.deleted).toMatchObject({ scenario_runs: 30, runtime_executions: 1, scenario_assignments: 1 });
    expect(second.runRoutesRevoked).toBe(1);
  });

  it("keeps a failed route revoke's run for the retry", async () => {
    await setGate("drained");
    effects.revokeRoute.mockRejectedValue(new Error("stargate down"));

    await expect(wipeScenarioData()).rejects.toThrow();
    const runs = await env.DB.prepare("SELECT COUNT(*) AS count FROM scenario_runs").first<{ count: number }>();
    expect(runs?.count).toBe(1);

    effects.revokeRoute.mockResolvedValue(undefined);
    await expect(wipeScenarioData()).resolves.toMatchObject({ complete: true });
  });
});
