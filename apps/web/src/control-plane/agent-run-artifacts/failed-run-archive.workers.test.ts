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
import type { VmStateV3 } from "@/generated/contracts/bridge-message-v9";
import { applyVmStateV3ToRunState } from "@/lib/run-lifecycle";
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
    ["the lost machine", VM_LOST_REASON, VM_LOST_REASON, false],
    ["the lost machine, deleted by the host", VM_LOST_REASON, VM_LOST_REASON, true],
    ["the expired lease", RUN_LEASE_EXPIRED_TEXT, RUN_LEASE_EXPIRED_TEXT, false],
    ["an internal error", "failed to stage queued VM: boom", GENERIC, false],
    ["a launch failure, deleted by the host", "vm create failed: no template", GENERIC, true],
  ])("shows the reason for %s only if a learner may read it", async (_, reason, archived, deleting) => {
    const db = drizzle(env.DB);
    const failed = await seedFailedRun(db, reason, 10_000, deleting);
    expect(failed.phaseDetail).toBe(reason);
    expect(failed.vms[0]?.terminalReason).toBe(reason);
    const runVm = await platformArtifactFixture(env.DB, "server-run-1");

    await transitionRunVmToCompleted(db, runVm, 10_001);

    const run = await loadStoredRunLifecycle(db, "run-1");
    expect(run?.state).toMatchObject({ phase: "failed", phaseDetail: archived });
    expect(run?.state.vms.map((vm) => vm.phase)).toEqual(["completed"]);
    expect(run?.state.vms[0]?.terminalReason).toBe(reason);
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
  deleting: boolean,
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
  const reported = recomputeRunState({
    ...initial,
    phase: "failed",
    vms: initial.vms.map((vm) => ({
      ...vm,
      phase: "failed",
      terminalPhase: "failed",
      terminalReason: reason,
    })),
  });
  // What the agent reports for a failed VM once its delete has started.
  const failed = deleting
    ? applyVmStateV3ToRunState({
        runId: "run-1",
        current: reported,
        vm: deletingReport(reason, now),
      })
    : reported;
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

function deletingReport(error: string, now: number): VmStateV3 {
  return {
    owner_user_id: "user-1",
    runtime_execution_id: "run-1",
    generation: 1,
    run_id: "run-1",
    name: "server",
    desired_version: 1,
    phase: "stopping",
    network: null,
    terminal: { state: "pending", reason: "destroying", observed_at_unix_ms: now + 250 },
    runtime_constraints: { generation: "generation-1", cpu_millis: 1_000 },
    resource_state: null,
    sandbox: null,
    ssh_host_keys_openssh: [],
    archive: { phase: "pending", artifact_count: 0, error: null },
    error,
    lab: null,
    updated_at_unix_ms: now + 250,
  };
}
