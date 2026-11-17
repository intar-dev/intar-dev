/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { agentHosts, scenarioRuns, user } from "@/db/schema";
import { RUN_PHASE_ORDER, buildInitialRunState, recomputeRunState } from "@/lib/run-state";
import { HOST_UNREACHABLE_GRACE_MS } from "@/lib/scenario-hosts";
import { getScenarioRunStatusForUser } from "@/lib/scenario-runs/status";
import { resetD1Database } from "@/test/d1-migrations";

describe("scenario run status on a disconnected host", () => {
  beforeEach(async () => {
    await resetD1Database();
    await seedReadyRun();
  });

  it("keeps the shell through a short disconnect and withholds it past the grace", async () => {
    const connected = await statusWithHost({ connected: true, disconnectedAt: null });
    expect(connected).toMatchObject({ machineUnreachable: false, canOpenTerminal: true });
    expect(connected.vms[0]?.canOpenTerminal).toBe(true);

    // Inside the grace nothing changes, not even the version a poll compares.
    const blip = await statusWithHost({ connected: false, disconnectedAt: Date.now() - 5_000 });
    expect(blip).toEqual(connected);

    const gone = await statusWithHost({
      connected: false,
      disconnectedAt: Date.now() - HOST_UNREACHABLE_GRACE_MS - 1_000,
    });
    expect(gone).toMatchObject({
      machineUnreachable: true,
      canOpenTerminal: false,
      phase: "active_full",
      version: `${connected.version}:unreachable`,
    });
    expect(gone.vms[0]).toMatchObject({ phase: "ready", canOpenTerminal: false });
    // The learner sees no host detail beyond what a ready run already carried.
    expect(gone.terminalTarget).toEqual(connected.terminalTarget);

    // Back with live VMs: the stored state is shown as it was.
    const back = await statusWithHost({ connected: true, disconnectedAt: null });
    expect(back).toEqual(connected);
  });
});

async function statusWithHost(host: { connected: boolean; disconnectedAt: number | null }) {
  await drizzle(env.DB)
    .update(agentHosts)
    .set({ ...host, lastHeartbeatAt: Date.now() })
    .where(eq(agentHosts.id, "host-1"));
  return getScenarioRunStatusForUser({ runId: "run-1", userId: "user-1" });
}

async function seedReadyRun(): Promise<void> {
  const db = drizzle(env.DB);
  await db.insert(user).values({ id: "user-1", name: "Learner", email: "learner@example.com" });
  await db.insert(agentHosts).values({ id: "host-1", userId: "user-1", name: "Host" });
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
  const ready = recomputeRunState({
    ...initial,
    phase: "active_full",
    vms: initial.vms.map((vm) => ({
      ...vm,
      phase: "ready",
      terminalPhase: "ready",
      terminalTarget: { ...vm.terminalTarget, host: "203.0.113.7", port: 2201 },
    })),
  });
  const createdAt = Date.now();
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
    state: ready.phase,
    stateRank: RUN_PHASE_ORDER[ready.phase],
    activeKey: "user-1",
    stateJson: JSON.stringify(ready),
    createdAt,
    updatedAt: createdAt,
  });
}
