/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";

import {
  loadStoredRunLifecycle,
  transitionRunVmToCompleted,
} from "@/control-plane/agent-run-artifacts/storage";
import { agentHosts, scenarioRuns, user } from "@/db/schema";
import { VM_LOST_REASON } from "@/generated/constants";
import {
  RUN_LEASE_EXPIRED_TEXT,
  RUN_PHASE_ORDER,
  buildInitialRunState,
  recomputeRunState,
} from "@/lib/run-state";
import { deriveScenarioRunOutcome } from "@/lib/scenario-run-outcome";
import { deriveScenarioRunReplayState } from "@/lib/scenario-runs/activity";
import { resetD1Database } from "@/test/d1-migrations";
import { platformArtifactFixture } from "./test-fixtures";

const GENERIC = "The run hit a terminal failure.";

describe("a failed run's reason after its VM is archived", () => {
  beforeEach(async () => {
    await resetD1Database();
  });

  it.each([
    ["the lost machine", VM_LOST_REASON, VM_LOST_REASON],
    ["the expired lease", RUN_LEASE_EXPIRED_TEXT, RUN_LEASE_EXPIRED_TEXT],
    ["an internal error", "failed to stage queued VM: boom", GENERIC],
  ])("shows the reason for %s only if a learner may read it",async (_, reason, archived) => {
    const db = drizzle(env.DB);
    const failed = await seedFailedRun(db, reason, 10_000);
    expect(failed.phaseDetail).toBe(reason);
    const runVm = await platformArtifactFixture(env.DB, "server-run-1");

    await transitionRunVmToCompleted(db, runVm, 10_001);

    const run = await loadStoredRunLifecycle(db, "run-1");
    expect(run?.state).toMatchObject({ phase: "failed", phaseDetail: archived });
    expect(run?.state.vms.map((vm) => vm.phase)).toEqual(["completed"]);
    expect(
      deriveScenarioRunOutcome({
        phase: run!.state.phase,
        solvedAt: null,
        deleteRequestedAt: null,
        failedAt: 10_000,
      }),
    ).toBe("failed");
    expect(deriveScenarioRunReplayState(run!.state)).toBe(
      deriveScenarioRunReplayState(failed),
    );
  });
});

async function seedFailedRun(
  db: ReturnType<typeof drizzle>,
  reason: string,
  now: number,
) {
  await db.insert(user).values({
    id: "user-1",
    name: "Learner",
    email: "learner@example.test",
  });
  await db.insert(agentHosts).values({
    id: "host-1",
    userId: "user-1",
    name: "Host",
  });
  const initial = buildInitialRunState({
    vms: [
      {
        id: "vm-1",
        ordinal: 0,
        scenarioVmId: "scenario-vm-1",
        scenarioVmName: "server",
        runtimeVmName: "server-run-1",
        hostname: "server",
        launchSummary: {
          scenarioVmName: "server",
          hostname: "server",
          probePhaseMap: {},
          probeDescriptors: [],
        },
      },
    ],
  });
  const failed = recomputeRunState({
    ...initial,
    phase: "failed",
    vms: initial.vms.map((vm) => ({
      ...vm,
      phase: "failed",
      terminalPhase: "failed",
      terminalReason: reason,
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
    vmCount: 1,
    state: failed.phase,
    stateRank: RUN_PHASE_ORDER[failed.phase],
    stateJson: JSON.stringify(failed),
    failedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return failed;
}
