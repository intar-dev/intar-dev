/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import {
  agentHosts,
  scenarioRunArtifacts,
  scenarioRuns,
  user,
} from "@/db/schema";
import {
  RUN_PHASE_ORDER,
  buildInitialRunState,
  recomputeRunState,
} from "@/lib/run-state";
import {
  getScenarioRunForUser,
  listScenarioRunsForUser,
} from "@/lib/scenario-runs";
import { resetD1Database } from "@/test/d1-migrations";

describe("scenario run artifact ledger", () => {
  beforeEach(async () => {
    await resetD1Database();
  });

  it("hydrates only uploaded replay segments from the authoritative ledger", async () => {
    await seedCompletedRun();
    const db = drizzle(env.DB);
    await db.insert(scenarioRunArtifacts).values([
      artifact("segment-uploaded", 0, "uploaded", "ssh_recording_segment"),
      artifact("segment-pending", 1, "pending", "ssh_recording_segment"),
      artifact("console-uploaded", 2, "uploaded", "console_log"),
    ]);

    const run = await getScenarioRunForUser({
      runId: "run-1",
      userId: "user-1",
    });
    const runs = await listScenarioRunsForUser({ userId: "user-1" });

    expect(run.replayArtifacts.map((entry) => entry.id)).toEqual([
      "segment-uploaded",
    ]);
    expect(run.vms[0]?.replayArtifacts.map((entry) => entry.id)).toEqual([
      "segment-uploaded",
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.hasReplay).toBe(true);
  });

  it("does not advertise console-only archives as replays", async () => {
    await seedCompletedRun();
    await drizzle(env.DB)
      .insert(scenarioRunArtifacts)
      .values(artifact("console-uploaded", 0, "uploaded", "console_log"));

    const run = await getScenarioRunForUser({
      runId: "run-1",
      userId: "user-1",
    });
    const runs = await listScenarioRunsForUser({ userId: "user-1" });

    expect(run.replayArtifacts).toEqual([]);
    expect(run.vms[0]?.replayArtifacts).toEqual([]);
    expect(runs[0]?.hasReplay).toBe(false);
  });

  it("does not advertise pending replay segments", async () => {
    await seedCompletedRun();
    await drizzle(env.DB)
      .insert(scenarioRunArtifacts)
      .values(
        artifact("segment-pending", 0, "pending", "ssh_recording_segment"),
      );

    const run = await getScenarioRunForUser({
      runId: "run-1",
      userId: "user-1",
    });
    const runs = await listScenarioRunsForUser({ userId: "user-1" });

    expect(run.replayArtifacts).toEqual([]);
    expect(run.vms[0]?.replayArtifacts).toEqual([]);
    expect(runs[0]?.hasReplay).toBe(false);
  });

  it("skips replay-ledger hydration while a run is active", async () => {
    await seedIdentity();
    await insertActiveRun();
    await drizzle(env.DB)
      .insert(scenarioRunArtifacts)
      .values(
        artifact("unexpected-active-segment", 0, "uploaded", "ssh_recording_segment"),
      );

    const run = await getScenarioRunForUser({
      runId: "run-1",
      userId: "user-1",
    });

    expect(run.phase).toBe("provisioning");
    expect(run.replayArtifacts).toEqual([]);
    expect(run.vms[0]?.replayArtifacts).toEqual([]);
  });

  it("removes stale state document replays when the ledger has none", async () => {
    await seedIdentity();
    await insertCompletedRun({ staleReplay: true });

    const run = await getScenarioRunForUser({
      runId: "run-1",
      userId: "user-1",
    });

    expect(run.replayArtifacts).toEqual([]);
    expect(run.vms[0]?.replayArtifacts).toEqual([]);
  });

  it("orders replay segments by VM state order and artifact ordinal", async () => {
    await seedIdentity();
    await insertCompletedRun({ vmIds: ["vm-z", "vm-a"] });
    await drizzle(env.DB)
      .insert(scenarioRunArtifacts)
      .values([
        artifact(
          "vm-a-segment-1",
          1,
          "uploaded",
          "ssh_recording_segment",
          "vm-a",
        ),
        artifact(
          "vm-z-segment-1",
          1,
          "uploaded",
          "ssh_recording_segment",
          "vm-z",
        ),
        artifact(
          "vm-a-segment-0",
          0,
          "uploaded",
          "ssh_recording_segment",
          "vm-a",
        ),
        artifact(
          "vm-z-segment-0",
          0,
          "uploaded",
          "ssh_recording_segment",
          "vm-z",
        ),
      ]);

    const run = await getScenarioRunForUser({
      runId: "run-1",
      userId: "user-1",
    });

    expect(
      run.vms.map((vm) => vm.replayArtifacts.map((entry) => entry.id)),
    ).toEqual([
      ["vm-z-segment-0", "vm-z-segment-1"],
      ["vm-a-segment-0", "vm-a-segment-1"],
    ]);
    expect(run.replayArtifacts.map((entry) => entry.id)).toEqual([
      "vm-z-segment-0",
      "vm-z-segment-1",
      "vm-a-segment-0",
      "vm-a-segment-1",
    ]);
  });

  it("loads replay flags for a full 100-run page within D1 bind limits", async () => {
    await seedIdentity();
    const now = Date.now();
    for (let index = 0; index < 100; index += 1) {
      await insertCompletedRun({
        runId: `run-${index}`,
        createdAt: now + index,
      });
    }
    await drizzle(env.DB)
      .insert(scenarioRunArtifacts)
      .values(
        artifact(
          "segment-page-boundary",
          0,
          "uploaded",
          "ssh_recording_segment",
          "vm-1",
          "run-0",
        ),
      );

    const runs = await listScenarioRunsForUser({ userId: "user-1" });

    expect(runs).toHaveLength(100);
    expect(runs.find((run) => run.runId === "run-0")?.hasReplay).toBe(true);
    expect(runs.filter((run) => run.hasReplay)).toHaveLength(1);
  });
});

async function seedCompletedRun(): Promise<void> {
  await seedIdentity();
  await insertCompletedRun();
}

async function seedIdentity(): Promise<void> {
  const db = drizzle(env.DB);
  await db.insert(user).values({
    id: "user-1",
    name: "Artifact Owner",
    email: "artifact-owner@example.com",
  });
  await db.insert(agentHosts).values({
    id: "host-1",
    userId: "user-1",
    name: "Artifact Host",
  });
}

async function insertCompletedRun({
  runId = "run-1",
  vmIds = ["vm-1"],
  createdAt = Date.now(),
  staleReplay = false,
}: {
  runId?: string;
  vmIds?: string[];
  createdAt?: number;
  staleReplay?: boolean;
} = {}): Promise<void> {
  const db = drizzle(env.DB);

  const initial = buildInitialRunState({
    vms: vmIds.map((vmId, ordinal) => ({
      id: vmId,
      ordinal,
      scenarioVmId: `scenario-${vmId}`,
      scenarioVmName: `server-${ordinal}`,
      runtimeVmName: `${vmId}-${runId}`,
      hostname: `server-${ordinal}`,
      launchSummary: {
        scenarioVmName: `server-${ordinal}`,
        hostname: `server-${ordinal}`,
        probePhaseMap: {},
        probeDescriptors: [],
      },
    })),
  });
  const completed = recomputeRunState({
    ...initial,
    phase: "completed",
    vms: initial.vms.map((vm) => ({ ...vm, phase: "completed" })),
  });
  const staleArtifact = {
    id: "stale-segment",
    hostId: "host-1",
    runId,
    vmId: vmIds[0] ?? "vm-1",
    kind: "ssh_recording_segment",
    filename: "stale.cast",
    contentType: "application/x-asciicast",
    sizeBytes: 64,
  };
  const state = staleReplay
    ? {
        ...completed,
        replayArtifacts: [staleArtifact],
        vms: completed.vms.map((vm, index) => ({
          ...vm,
          replayArtifacts: index === 0 ? [staleArtifact] : [],
        })),
      }
    : completed;
  await db.insert(scenarioRuns).values({
    runId,
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
    vmCount: vmIds.length,
    state: state.phase,
    stateRank: RUN_PHASE_ORDER[state.phase],
    activeKey: null,
    stateJson: JSON.stringify(state),
    completedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  });
}

async function insertActiveRun(): Promise<void> {
  const db = drizzle(env.DB);
  const createdAt = Date.now();
  const initial = buildInitialRunState({
    vms: [
      {
        id: "vm-1",
        ordinal: 0,
        scenarioVmId: "scenario-vm-1",
        scenarioVmName: "server-0",
        runtimeVmName: "vm-1-run-1",
        hostname: "server-0",
        launchSummary: {
          scenarioVmName: "server-0",
          hostname: "server-0",
          probePhaseMap: {},
          probeDescriptors: [],
        },
      },
    ],
  });
  const active = recomputeRunState({
    ...initial,
    phase: "provisioning",
    vms: initial.vms.map((vm) => ({ ...vm, phase: "booting" })),
  });
  await db.insert(scenarioRuns).values({
    runId: "run-1",
    userId: "user-1",
    hostId: "host-1",
    scenarioId: "broken-nginx",
    scenarioName: "broken-nginx",
    title: "Broken nginx",
    tagline: "Fix it",
    briefingMarkdown: "Repair nginx.",
    objectivesJson: "[]",
    difficulty: "easy",
    estimatedMinutes: 15,
    tagsJson: [],
    hintsJson: [],
    solutionMarkdown: "",
    revealedHintsJson: [],
    solutionAssisted: false,
    vmCount: 1,
    state: active.phase,
    stateRank: RUN_PHASE_ORDER[active.phase],
    activeKey: "user-1",
    stateJson: JSON.stringify(active),
    createdAt,
    updatedAt: createdAt,
  });
}

function artifact(
  id: string,
  ordinal: number,
  uploadStatus: string,
  kind: "ssh_recording_segment" | "console_log",
  vmId = "vm-1",
  runId = "run-1",
) {
  const extension = kind === "ssh_recording_segment" ? "cast" : "log";
  return {
    id,
    runId,
    vmId,
    ordinal,
    kind,
    filename: `${id}.${extension}`,
    contentType:
      kind === "ssh_recording_segment"
        ? "application/x-asciicast"
        : "text/plain; charset=utf-8",
    sizeBytes: 64,
    sha256: "a".repeat(64),
    r2Key: `runs/${runId}/${id}.${extension}`,
    uploadStatus,
    uploadedAt: uploadStatus === "uploaded" ? Date.now() : null,
  };
}
