/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { handleAgentRunArtifactRequest } from "@/control-plane/agent-run-artifacts";
import { handleAgentBootstrap, sha256Hex } from "@/control-plane/auth";
import {
  agentBootstrapTokens,
  agentHosts,
  scenarioRunArtifacts,
  scenarioRuns,
  user,
} from "@/db/schema";
import {
  RUN_PHASE_ORDER,
  buildInitialRunState,
  recomputeRunState,
  type RunPhase,
  type VmPhase,
} from "@/lib/run-state";
import { resetD1Database } from "@/test/d1-migrations";

describe("agent run artifact sealing", () => {
  beforeEach(async () => {
    await resetD1Database();
  });

  it("rejects a new artifact after the VM archive is sealed", async () => {
    const token = await seedRun("completed", "completed");

    const response = await handleAgentRunArtifactRequest(
      new Request("http://localhost/agent/runs/begin", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          runId: "run-1",
          vmName: "vm-runtime",
          artifacts: [artifactDescriptor()],
        }),
      }),
      env,
    );

    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toEqual({
      code: "run_artifacts_sealed",
      error: "run artifact writes are sealed",
    });
    await expect(drizzle(env.DB).select().from(scenarioRunArtifacts)).resolves
      .toHaveLength(0);
  });

  it("turns a failed VM into cleanup-complete without erasing the failed outcome", async () => {
    const token = await seedRun("failed", "failed");

    const response = await handleAgentRunArtifactRequest(
      new Request(
        "http://localhost/agent/runs/run-1/vms/vm-runtime/complete",
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        },
      ),
      env,
    );

    expect(response?.status).toBe(200);
    const [run] = await drizzle(env.DB).select().from(scenarioRuns);
    const state = JSON.parse(run?.stateJson ?? "{}") as {
      phase: string;
      vms: Array<{ phase: string }>;
    };
    expect(run?.state).toBe("failed");
    expect(state.phase).toBe("failed");
    expect(state.vms[0]?.phase).toBe("completed");
  });
});

async function seedRun(runPhase: RunPhase, vmPhase: VmPhase): Promise<string> {
  const db = drizzle(env.DB);
  const now = Date.now();
  await db.insert(user).values({
    id: "user-1",
    name: "Agent Owner",
    email: "agent-owner@example.com",
  });
  await db.insert(agentHosts).values({
    id: "host-1",
    userId: "user-1",
    name: "Agent Host",
  });

  const initial = buildInitialRunState({
    vms: [
      {
        id: "vm-1",
        ordinal: 0,
        scenarioVmId: "scenario-vm-1",
        scenarioVmName: "vm",
        runtimeVmName: "vm-runtime",
        hostname: "vm",
        launchSummary: {
          scenarioVmName: "vm",
          hostname: "vm",
          probePhaseMap: {},
          probeDescriptors: [],
        },
      },
    ],
  });
  const state = recomputeRunState({
    ...initial,
    phase: runPhase,
    vms: initial.vms.map((vm) => ({ ...vm, phase: vmPhase })),
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
    state: state.phase,
    stateRank: RUN_PHASE_ORDER[state.phase],
    activeKey: null,
    stateJson: JSON.stringify(state),
    completedAt: runPhase === "completed" ? now : null,
    failedAt: runPhase === "failed" ? now : null,
    createdAt: now,
    updatedAt: now,
  });

  const bootstrapToken = "bootstrap-token";
  await db.insert(agentBootstrapTokens).values({
    id: "bootstrap-1",
    hostId: "host-1",
    tokenHash: await sha256Hex(bootstrapToken),
    expiresAt: now + 60_000,
    createdAt: now,
  });
  const response = await handleAgentBootstrap(
    new Request("http://localhost/agent/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: "host-1", bootstrapToken }),
    }),
    env,
  );
  const body = (await response.json()) as { accessToken: string };
  return body.accessToken;
}

function artifactDescriptor() {
  return {
    ordinal: 1,
    kind: "console_log",
    filename: "console.log",
    contentType: "text/plain",
    sizeBytes: 10,
    sha256: "a".repeat(64),
  };
}
