/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";

const courseCatalogMocks = vi.hoisted(() => ({
  recordLinkedCourseUnitCompletionForRun: vi.fn(),
}));

vi.mock("@/lib/scenario-course-catalogs", () => courseCatalogMocks);

import { agentHosts, scenarioRuns, user } from "@/db/schema";
import {
  loadStoredRunLifecycle,
  persistStoredRunLifecycle,
} from "@/control-plane/agent-run-artifacts/storage";
import {
  RUN_PHASE_ORDER,
  buildInitialRunState,
  recomputeRunState,
} from "@/lib/run-state";
import { resetD1Database } from "@/test/d1-migrations";

describe("course completion retry after archive persistence", () => {
  beforeEach(async () => {
    await resetD1Database();
    courseCatalogMocks.recordLinkedCourseUnitCompletionForRun.mockReset();
  });

  it("retries the completion upsert after its first post-transition failure", async () => {
    const db = drizzle(env.DB);
    const now = 10_000;
    await seedSolvedRun(db, now);
    const first = await loadStoredRunLifecycle(db, "run-1");
    if (!first) throw new Error("missing run fixture");
    const completed = completedState(first.state);

    courseCatalogMocks.recordLinkedCourseUnitCompletionForRun.mockRejectedValueOnce(
      new Error("temporary completion write failure"),
    );
    await expect(
      persistStoredRunLifecycle(db, "run-1", first, completed, now + 1),
    ).rejects.toThrow("temporary completion write failure");

    const afterFailure = await loadStoredRunLifecycle(db, "run-1");
    expect(afterFailure).toMatchObject({
      solvedAt: now,
      completedAt: now + 1,
      state: { phase: "completed" },
    });
    if (!afterFailure) return;

    await persistStoredRunLifecycle(
      db,
      "run-1",
      afterFailure,
      completed,
      now + 2,
    );

    expect(
      courseCatalogMocks.recordLinkedCourseUnitCompletionForRun,
    ).toHaveBeenCalledTimes(2);
    expect(
      courseCatalogMocks.recordLinkedCourseUnitCompletionForRun,
    ).toHaveBeenLastCalledWith(db, { runId: "run-1", nowUnixMs: now + 2 });
  });
});

async function seedSolvedRun(
  db: ReturnType<typeof drizzle>,
  now: number,
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
  const solved = recomputeRunState({
    ...initial,
    phase: "solved",
    vms: initial.vms.map((vm) => ({ ...vm, phase: "solved" })),
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
    state: solved.phase,
    stateRank: RUN_PHASE_ORDER[solved.phase],
    activeKey: "user-1",
    stateJson: JSON.stringify(solved),
    solvedAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

function completedState(state: ReturnType<typeof buildInitialRunState>) {
  return recomputeRunState({
    ...state,
    phase: "completed",
    vms: state.vms.map((vm) => ({ ...vm, phase: "completed" })),
  });
}
