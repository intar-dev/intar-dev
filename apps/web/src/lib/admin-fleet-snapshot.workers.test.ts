/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { agentHosts, scenarioRuns, user } from "@/db/schema";
import {
  FLEET_ARCHIVE_SUMMARY_LIMIT,
  FLEET_HOST_LIMIT,
  FLEET_LIVE_RUN_LIMIT,
  loadAdminFleetArchivedRunDetail,
  loadAdminFleetSnapshot,
} from "@/lib/admin-fleet-snapshot";
import { RUN_PHASE_ORDER } from "@/lib/run-state";
import { resetD1Database } from "@/test/d1-migrations";

describe("admin fleet snapshot", () => {
  beforeEach(async () => {
    await resetD1Database();
  });

  it("uses a fixed D1 query count as host count grows", async () => {
    const oneHostCalls = await snapshotPrepareCount(1);
    const manyHostCalls = await snapshotPrepareCount(8);

    expect(manyHostCalls).toBe(oneHostCalls);
  });

  it("bounds archive summaries and demand-loads only one archive detail", async () => {
    await seedOwnerAndHosts(2);
    await seedArchivedRuns(FLEET_ARCHIVE_SUMMARY_LIMIT + 1);

    const snapshot = await loadAdminFleetSnapshot({ userId: "fleet-owner" });
    const summaries = snapshot.hostRecords.flatMap((record) => record.hostRuns);

    expect(snapshot.archiveTotalCount).toBe(FLEET_ARCHIVE_SUMMARY_LIMIT + 1);
    expect(summaries).toHaveLength(FLEET_ARCHIVE_SUMMARY_LIMIT);
    expect(summaries.every((run) => !("artifacts" in run))).toBe(true);
    expect(summaries.every((run) => !("events" in run))).toBe(true);

    const detail = await loadAdminFleetArchivedRunDetail({
      userId: "fleet-owner",
      hostId: "fleet-host-0",
      runId: "fleet-run-0",
    });
    expect(detail).toMatchObject({
      id: "fleet-run-0",
      hostId: "fleet-host-0",
      artifactCount: 0,
      artifacts: [],
    });
    expect(detail?.events).toHaveLength(3);
  });

  it("caps hosts and exposes every archive page with truthful totals", async () => {
    await seedOwnerAndHosts(FLEET_HOST_LIMIT + 1);
    await seedArchivedRuns(FLEET_ARCHIVE_SUMMARY_LIMIT + 1, {
      hostIndex: FLEET_HOST_LIMIT,
    });
    await seedLiveRuns(FLEET_LIVE_RUN_LIMIT + 1, {
      hostIndex: FLEET_HOST_LIMIT,
    });

    const first = await loadAdminFleetSnapshot({ userId: "fleet-owner" });
    const firstRuns = first.hostRecords.flatMap((record) => record.hostRuns);

    expect(first.hostRecords).toHaveLength(FLEET_HOST_LIMIT);
    expect(first.hostRecords.some((record) => record.host.id === "fleet-host-0")).toBe(
      false,
    );
    expect(first.hostRecords[0]?.host.id).toBe(
      `fleet-host-${FLEET_HOST_LIMIT}`,
    );
    expect(first.hostRecords[0]?.host.status?.inventoryVmCount).toBe(3);
    expect(first.archiveTotalCount).toBe(FLEET_ARCHIVE_SUMMARY_LIMIT + 1);
    expect(first.archiveOffset).toBe(0);
    expect(first.archiveNextOffset).toBe(FLEET_ARCHIVE_SUMMARY_LIMIT);
    expect(first.hasMoreArchives).toBe(true);
    expect(firstRuns).toHaveLength(FLEET_ARCHIVE_SUMMARY_LIMIT);
    expect(first.liveTotalCount).toBe(FLEET_LIVE_RUN_LIMIT + 1);
    expect(first.hasMoreLive).toBe(true);

    const second = await loadAdminFleetSnapshot({
      userId: "fleet-owner",
      archiveOffset: first.archiveNextOffset ?? 0,
    });
    const secondRuns = second.hostRecords.flatMap((record) => record.hostRuns);

    expect(second.archiveOffset).toBe(FLEET_ARCHIVE_SUMMARY_LIMIT);
    expect(second.archiveNextOffset).toBeNull();
    expect(second.hasMoreArchives).toBe(false);
    expect(secondRuns).toHaveLength(1);
    expect(
      new Set([...firstRuns, ...secondRuns].map((run) => run.id)).size,
    ).toBe(FLEET_ARCHIVE_SUMMARY_LIMIT + 1);
  });
});

async function snapshotPrepareCount(hostCount: number): Promise<number> {
  await resetD1Database();
  await seedOwnerAndHosts(hostCount);
  let prepares = 0;
  const countedD1 = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare") {
        return (...args: Parameters<D1Database["prepare"]>) => {
          prepares += 1;
          return target.prepare(...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;

  const snapshot = await loadAdminFleetSnapshot({
    userId: "fleet-owner",
    d1: countedD1,
  });
  expect(snapshot.hostRecords).toHaveLength(hostCount);
  return prepares;
}

async function seedOwnerAndHosts(hostCount: number) {
  const db = drizzle(env.DB);
  await db.insert(user).values({
    id: "fleet-owner",
    name: "Fleet owner",
    email: "fleet-owner@example.test",
  });
  for (let index = 0; index < hostCount; index += 1) {
    await db.insert(agentHosts).values({
      id: `fleet-host-${index}`,
      userId: "fleet-owner",
      name: `Fleet host ${index}`,
      inventoryJson:
        index === hostCount - 1
          ? JSON.stringify({ vms: ["one", "two", "three"] })
          : null,
      createdAt: 1_000 + index,
      updatedAt: 1_000 + index,
    });
  }
}

async function seedArchivedRuns(
  count: number,
  options: { hostIndex?: number } = {},
) {
  const db = drizzle(env.DB);
  for (let index = 0; index < count; index += 1) {
    const now = 10_000 + index;
    await db.insert(scenarioRuns).values({
      runId: `fleet-run-${index}`,
      userId: "fleet-owner",
      hostId: `fleet-host-${options.hostIndex ?? (index % 2)}`,
      scenarioId: "fleet-scenario",
      scenarioName: "fleet-scenario",
      title: "Fleet scenario",
      tagline: "",
      briefingMarkdown: "",
      objectivesJson: "[]",
      difficulty: "easy",
      estimatedMinutes: 1,
      tagsJson: [],
      hintsJson: [],
      solutionMarkdown: "",
      vmCount: 0,
      state: "completed",
      stateRank: RUN_PHASE_ORDER.completed,
      stateJson: "{}",
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }
}

async function seedLiveRuns(
  count: number,
  options: { hostIndex: number },
) {
  const db = drizzle(env.DB);
  for (let index = 0; index < count; index += 1) {
    const now = 30_000 + index;
    await db.insert(scenarioRuns).values({
      runId: `fleet-live-run-${index}`,
      userId: "fleet-owner",
      hostId: `fleet-host-${options.hostIndex}`,
      scenarioId: "fleet-scenario",
      scenarioName: "fleet-scenario",
      title: "Fleet scenario",
      tagline: "",
      briefingMarkdown: "",
      objectivesJson: "[]",
      difficulty: "easy",
      estimatedMinutes: 1,
      tagsJson: [],
      hintsJson: [],
      solutionMarkdown: "",
      vmCount: 0,
      state: "queued",
      stateRank: RUN_PHASE_ORDER.queued,
      stateJson: "{}",
      createdAt: now,
      updatedAt: now,
    });
  }
}
