/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentHosts, organization, scenarioRuns, user } from "@/db/schema";
import { buildInitialRunState } from "@/lib/run-state";
import { resetDatabase } from "@/test/database-migrations";

const stargateMocks = vi.hoisted(() => ({
  deleteStargateRoute: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/stargate", () => ({
  deleteStargateRoute: stargateMocks.deleteStargateRoute,
  stargateRouteTtlMs: () => 10_000,
}));

import {
  buildRunVmRouteUsername,
  revokeScenarioNativeProfileRoutesForUser,
  revokeScenarioRoutesForUser,
} from "./scenario-runs/start";

beforeEach(async () => {
  await resetDatabase();
  stargateMocks.deleteStargateRoute.mockReset();
  stargateMocks.deleteStargateRoute.mockResolvedValue(undefined);
  await seedRoutes();
});

describe("scenario route revocation", () => {
  it("revokes active and recent terminal routes but excludes expired terminal routes", async () => {
    await revokeScenarioRoutesForUser("blocked-user", 100_000);

    expect(revokedRoutes()).toEqual(
      new Set([
        expectedRoute("vm-a", "browser"),
        expectedRoute("vm-a", "native_profile_keys"),
        expectedRoute("vm-b", "browser"),
        expectedRoute("vm-b", "native_profile_keys"),
        expectedRouteForRun("recent-run", "vm-a", "browser"),
        expectedRouteForRun(
          "recent-run",
          "vm-a",
          "native_profile_keys",
        ),
      ]),
    );
    expect(stargateMocks.deleteStargateRoute).toHaveBeenCalledTimes(6);
  });

  it("keeps SSH-key rotation scoped to native routes", async () => {
    await revokeScenarioNativeProfileRoutesForUser("blocked-user");

    expect(revokedRoutes()).toEqual(
      new Set([
        expectedRoute("vm-a", "native_profile_keys"),
        expectedRoute("vm-b", "native_profile_keys"),
      ]),
    );
    expect(stargateMocks.deleteStargateRoute).toHaveBeenCalledTimes(2);
  });
});

function revokedRoutes(): Set<string> {
  return new Set(
    stargateMocks.deleteStargateRoute.mock.calls.map(([route]) => route),
  );
}

function expectedRoute(
  vmId: string,
  routeType: "browser" | "native_profile_keys",
): string {
  return buildRunVmRouteUsername("org-run", runState.vms, vmId, routeType);
}

function expectedRouteForRun(
  runId: string,
  vmId: string,
  routeType: "browser" | "native_profile_keys",
): string {
  return buildRunVmRouteUsername(runId, singleVmState.vms, vmId, routeType);
}

const runState = buildInitialRunState({
  vms: [
    {
      id: "vm-a",
      ordinal: 0,
      scenarioVmId: "scenario-vm-a",
      scenarioVmName: "gateway",
      runtimeVmName: "vm-a-org-run",
      hostname: "gateway",
      launchSummary: {
        scenarioVmName: "gateway",
        hostname: "gateway",
        probePhaseMap: {},
        probeDescriptors: [],
      },
    },
    {
      id: "vm-b",
      ordinal: 1,
      scenarioVmId: "scenario-vm-b",
      scenarioVmName: "gateway",
      runtimeVmName: "vm-b-org-run",
      hostname: "gateway-2",
      launchSummary: {
        scenarioVmName: "gateway",
        hostname: "gateway-2",
        probePhaseMap: {},
        probeDescriptors: [],
      },
    },
  ],
});

const singleVmState = buildInitialRunState({
  vms: [
    {
      id: "vm-a",
      ordinal: 0,
      scenarioVmId: "scenario-vm-a",
      scenarioVmName: "gateway",
      runtimeVmName: "vm-a-terminal-run",
      hostname: "gateway",
      launchSummary: {
        scenarioVmName: "gateway",
        hostname: "gateway",
        probePhaseMap: {},
        probeDescriptors: [],
      },
    },
  ],
});

async function seedRoutes(): Promise<void> {
  const db = drizzle(env.DB);
  await db.insert(user).values([
    {
      id: "blocked-user",
      name: "Blocked user",
      email: "blocked@example.test",
    },
    {
      id: "other-user",
      name: "Other user",
      email: "other@example.test",
    },
  ]);
  await db.insert(organization).values({
    id: "org-a",
    name: "Organization A",
    slug: "org-a",
    createdAt: new Date(1_000),
  });
  await db.insert(agentHosts).values([
    {
      id: "org-host",
      userId: "blocked-user",
      organizationId: "org-a",
      name: "Organization host",
    },
    {
      id: "other-host",
      userId: "other-user",
      name: "Other host",
    },
  ]);
  await db.insert(scenarioRuns).values([
    runRow({
      runId: "org-run",
      userId: "blocked-user",
      hostId: "org-host",
      organizationId: "org-a",
      stateJson: JSON.stringify(runState),
      vmCount: 2,
    }),
    runRow({
      runId: "recent-run",
      userId: "blocked-user",
      hostId: "org-host",
      organizationId: "org-a",
      completedAt: 95_000,
      updatedAt: 95_000,
      stateJson: JSON.stringify(singleVmState),
      vmCount: 1,
    }),
    runRow({
      runId: "expired-run",
      userId: "blocked-user",
      hostId: "org-host",
      organizationId: "org-a",
      completedAt: 80_000,
      updatedAt: 80_000,
      stateJson: JSON.stringify(singleVmState),
      vmCount: 1,
    }),
    runRow({
      runId: "other-run",
      userId: "other-user",
      hostId: "other-host",
    }),
  ]);
}

function runRow(input: {
  runId: string;
  userId: string;
  hostId: string;
  organizationId?: string | null;
  completedAt?: number | null;
  updatedAt?: number;
  stateJson?: string;
  vmCount?: number;
}): typeof scenarioRuns.$inferInsert {
  return {
    runId: input.runId,
    userId: input.userId,
    hostId: input.hostId,
    organizationId: input.organizationId ?? null,
    scenarioId: "scenario-a",
    scenarioName: "scenario-a",
    title: "Scenario A",
    tagline: "Test scenario",
    briefingMarkdown: "Test briefing",
    objectivesJson: "[]",
    difficulty: "easy",
    estimatedMinutes: 15,
    tagsJson: [],
    hintsJson: [],
    solutionMarkdown: "",
    vmCount: input.vmCount ?? 1,
    state: runState.phase,
    stateRank: 0,
    stateJson: input.stateJson ?? JSON.stringify(runState),
    completedAt: input.completedAt ?? null,
    createdAt: 1_000,
    updatedAt: input.updatedAt ?? 1_000,
  };
}
