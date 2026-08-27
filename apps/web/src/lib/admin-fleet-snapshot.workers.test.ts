/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentHosts, organization, scenarioRuns, user } from "@/db/schema";
import {
  ADMIN_RUN_ARCHIVE_PAGE_SIZE,
  FLEET_ARCHIVE_SUMMARY_LIMIT,
  FLEET_HOST_LIMIT,
  FLEET_LIVE_RUN_LIMIT,
  loadAdminArchivedRunDetail,
  loadAdminFleetArchivedRunDetail,
  loadAdminFleetSnapshot,
  loadAdminRunArchivePage,
  parseAdminRunArchiveCursor,
} from "@/lib/admin-fleet-snapshot";
import {
  buildInitialRunState,
  recomputeRunState,
  RUN_PHASE_ORDER,
} from "@/lib/run-state";
import { deleteFinishedScenarioRunForAdmin } from "@/lib/scenario-runs";
import { updateRunState } from "@/lib/scenario-runs/storage";
import { resetD1Database } from "@/test/d1-migrations";

vi.mock("@/lib/stargate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stargate")>()),
  deleteStargateRoute: vi.fn().mockResolvedValue(undefined),
}));

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
    expect(summaries[0]).toMatchObject({
      ownerName: "Fleet owner",
      ownerUsername: "fleet-owner",
    });

    const detail = await loadAdminFleetArchivedRunDetail({
      userId: "fleet-owner",
      hostId: "fleet-host-0",
      runId: "fleet-run-0",
    });
    expect(detail).toMatchObject({
      id: "fleet-run-0",
      hostId: "fleet-host-0",
      ownerName: "Fleet owner",
      ownerUsername: "fleet-owner",
      artifactCount: 0,
      artifacts: [],
    });
    expect(detail?.events).toHaveLength(3);
  });

  it("keeps archive counts but omits summaries from the live fleet poll", async () => {
    await seedOwnerAndHosts(1);
    await seedArchivedRuns(1, { hostIndex: 0 });

    const snapshot = await loadAdminFleetSnapshot({
      userId: "fleet-owner",
      includeArchiveSummaries: false,
    });

    expect(snapshot.archiveTotalCount).toBe(1);
    expect(snapshot.hostRecords[0]?.archiveTotalCount).toBe(1);
    expect(snapshot.hostRecords[0]?.hostRuns).toEqual([]);
    expect(snapshot.archiveNextOffset).toBeNull();
  });

  it("keeps archived owner labels when a username is cleared", async () => {
    await seedOwnerAndHosts(1);
    await seedArchivedRuns(1, { hostIndex: 0 });
    const db = drizzle(env.DB);
    await db
      .update(user)
      .set({
        name: "Deleted user",
        username: null,
        displayUsername: null,
      })
      .where(eq(user.id, "fleet-owner"));

    const snapshot = await loadAdminFleetSnapshot({ userId: "fleet-owner" });
    expect(snapshot.hostRecords[0]?.hostRuns[0]).toMatchObject({
      ownerName: "Deleted user",
      ownerUsername: null,
    });

    const detail = await loadAdminFleetArchivedRunDetail({
      userId: "fleet-owner",
      hostId: "fleet-host-0",
      runId: "fleet-run-0",
    });
    expect(detail).toMatchObject({
      ownerName: "Deleted user",
      ownerUsername: null,
    });
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

  it("lists archived runs across users, organizations, and disabled hosts", async () => {
    await seedOwnerAndHosts(1);
    await seedArchivedRuns(1, { hostIndex: 0 });
    await seedForeignArchiveOwner();
    await seedForeignRun({
      runId: "foreign-archive",
      state: "completed",
      updatedAt: 50_000,
    });
    await seedForeignRun({
      runId: "foreign-hidden",
      state: "completed",
      hiddenAt: 50_001,
      updatedAt: 50_001,
    });
    await seedForeignRun({
      runId: "foreign-live",
      state: "queued",
      updatedAt: 50_002,
    });

    const page = await loadAdminRunArchivePage({});

    expect(page.totalCount).toBe(2);
    expect(page.nextCursor).toBeNull();
    expect(page.runs.map(({ run }) => run.id)).toEqual([
      "foreign-archive",
      "fleet-run-0",
    ]);
    expect(page.runs[0]).toMatchObject({
      host: { id: "foreign-host", name: "Disabled learner host" },
      run: {
        userId: "foreign-user",
        ownerName: "Foreign learner",
        ownerUsername: "foreign-learner",
      },
    });
    expect(page.runs.every(({ run }) => !("artifacts" in run))).toBe(true);
    expect(page.runs.every(({ run }) => !("events" in run))).toBe(true);

    const detail = await loadAdminArchivedRunDetail({
      runId: "foreign-archive",
    });
    expect(detail).toMatchObject({
      id: "foreign-archive",
      hostId: "foreign-host",
      ownerUsername: "foreign-learner",
    });
    await expect(
      loadAdminArchivedRunDetail({ runId: "foreign-hidden" }),
    ).resolves.toBeNull();
    await expect(
      loadAdminArchivedRunDetail({ runId: "foreign-live" }),
    ).resolves.toBeNull();
  });

  it("retains a safe global owner label after account tombstoning", async () => {
    await seedForeignArchiveOwner();
    await seedForeignRun({
      runId: "foreign-archive",
      state: "completed",
      updatedAt: 50_000,
    });
    await drizzle(env.DB)
      .update(user)
      .set({
        name: "Deleted user",
        username: null,
        displayUsername: null,
        deletedAt: new Date(50_001),
      })
      .where(eq(user.id, "foreign-user"));

    const page = await loadAdminRunArchivePage({});
    expect(page.runs[0]?.run).toMatchObject({
      ownerName: "Deleted user",
      ownerUsername: null,
    });
  });

  it("pages the global archive with a stable opaque cursor", async () => {
    await seedOwnerAndHosts(2);
    await seedArchivedRuns(ADMIN_RUN_ARCHIVE_PAGE_SIZE + 1, {
      fixedUpdatedAt: 10_000,
    });

    const first = await loadAdminRunArchivePage({});
    const cursor = parseAdminRunArchiveCursor(first.nextCursor);
    expect(cursor).not.toBeNull();
    expect(cursor).not.toBeUndefined();
    const firstIds = new Set(first.runs.map(({ run }) => run.id));
    const remainingId = Array.from(
      { length: ADMIN_RUN_ARCHIVE_PAGE_SIZE + 1 },
      (_, index) => `fleet-run-${index}`,
    ).find((runId) => !firstIds.has(runId));
    expect(remainingId).toBeDefined();
    await drizzle(env.DB)
      .update(scenarioRuns)
      .set({ deleteRequestedAt: 99_999, updatedAt: 99_999 })
      .where(eq(scenarioRuns.runId, remainingId!));
    const second = await loadAdminRunArchivePage({ cursor: cursor! });

    expect(first.runs).toHaveLength(ADMIN_RUN_ARCHIVE_PAGE_SIZE);
    expect(first.totalCount).toBeNull();
    expect(second.runs).toHaveLength(1);
    expect(second.runs[0]?.run.id).toBe(remainingId);
    expect(second.nextCursor).toBeNull();
    expect(second.totalCount).toBeNull();
    expect(
      new Set([...first.runs, ...second.runs].map(({ run }) => run.id)).size,
    ).toBe(ADMIN_RUN_ARCHIVE_PAGE_SIZE + 1);
  });

  it("keeps global archive query count fixed as run count grows", async () => {
    const oneRunCalls = await globalArchivePrepareCount(1);
    const manyRunCalls = await globalArchivePrepareCount(30);

    expect(manyRunCalls).toBe(oneRunCalls);
  });

  it("uses the partial index for global archive page order", async () => {
    const plan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN
       SELECT run_id
       FROM scenario_runs
       WHERE hidden_at IS NULL
         AND state IN ('archiving', 'completed', 'failed')
       ORDER BY coalesce(archive_entered_at, created_at) DESC, run_id DESC
       LIMIT 101`,
    ).all<{ detail: string }>();

    expect(plan.results.map((row) => row.detail).join("\n")).toContain(
      "scenario_runs_admin_archive_page_idx",
    );
  });

  it("latches archive entry time across later terminal updates", async () => {
    await seedOwnerAndHosts(1);
    await seedLiveRuns(1, { hostIndex: 0 });
    const db = drizzle(env.DB);
    await updateRunState("fleet-live-run-0", {
      mutate: (current) =>
        recomputeRunState({ ...current, phase: "archiving" }),
    });
    const [entered] = await db
      .select({ archiveEnteredAt: scenarioRuns.archiveEnteredAt })
      .from(scenarioRuns)
      .where(eq(scenarioRuns.runId, "fleet-live-run-0"));
    expect(entered?.archiveEnteredAt).toEqual(expect.any(Number));
    await db
      .update(scenarioRuns)
      .set({
        deleteRequestedAt: 50_000,
        updatedAt: 50_000,
      })
      .where(eq(scenarioRuns.runId, "fleet-live-run-0"));
    await updateRunState("fleet-live-run-0", {
      mutate: (current) =>
        recomputeRunState({ ...current, phase: "completed" }),
    });

    const [row] = await db
      .select({ archiveEnteredAt: scenarioRuns.archiveEnteredAt })
      .from(scenarioRuns)
      .where(eq(scenarioRuns.runId, "fleet-live-run-0"));
    expect(row?.archiveEnteredAt).toBe(entered?.archiveEnteredAt);
  });

  it("lets an admin delete another user's terminal run", async () => {
    await seedForeignArchiveOwner();
    await seedForeignRun({
      runId: "foreign-archive",
      state: "completed",
      updatedAt: 50_000,
    });

    await deleteFinishedScenarioRunForAdmin({
      runId: "foreign-archive",
      actorUserId: "fleet-owner",
    });

    const rows = await drizzle(env.DB)
      .select({ runId: scenarioRuns.runId })
      .from(scenarioRuns)
      .where(eq(scenarioRuns.runId, "foreign-archive"));
    expect(rows).toEqual([]);
    const audit = await env.DB.prepare(
      `SELECT event_type AS eventType, subject_user_id AS subjectUserId,
              actor_user_id AS actorUserId, run_id AS runId, reason,
              created_at AS createdAt
       FROM access_events
       WHERE run_id = ?1`,
    )
      .bind("foreign-archive")
      .first<{
        eventType: string;
        subjectUserId: string;
        actorUserId: string;
        runId: string;
        reason: string;
        createdAt: number;
      }>();
    expect(audit).toEqual({
      eventType: "run.deleted_by_admin",
      subjectUserId: "foreign-user",
      actorUserId: "fleet-owner",
      runId: "foreign-archive",
      reason: "admin_deleted",
      createdAt: expect.any(Number),
    });
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

async function globalArchivePrepareCount(runCount: number): Promise<number> {
  await resetD1Database();
  await seedDistinctArchivedRuns(runCount);
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

  const page = await loadAdminRunArchivePage({ d1: countedD1 });
  expect(page.runs).toHaveLength(runCount);
  return prepares;
}

async function seedDistinctArchivedRuns(count: number) {
  const db = drizzle(env.DB);
  for (let index = 0; index < count; index += 1) {
    await db.insert(user).values({
      id: `distinct-user-${index}`,
      name: `Distinct user ${index}`,
      email: `distinct-user-${index}@example.test`,
      username: `distinct-user-${index}`,
    });
    await db.insert(agentHosts).values({
      id: `distinct-host-${index}`,
      userId: `distinct-user-${index}`,
      name: `Distinct host ${index}`,
      createdAt: 10_000 + index,
      updatedAt: 10_000 + index,
    });
    await db.insert(scenarioRuns).values({
      runId: `distinct-run-${index}`,
      userId: `distinct-user-${index}`,
      hostId: `distinct-host-${index}`,
      scenarioId: "distinct-scenario",
      scenarioName: "distinct-scenario",
      title: "Distinct scenario",
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
      completedAt: 10_000 + index,
      createdAt: 10_000 + index,
      updatedAt: 10_000 + index,
    });
  }
}

async function seedOwnerAndHosts(hostCount: number) {
  const db = drizzle(env.DB);
  await db.insert(user).values({
    id: "fleet-owner",
    name: "Fleet owner",
    email: "fleet-owner@example.test",
    username: "fleet-owner",
    displayUsername: "fleet-owner",
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
  options: { hostIndex?: number; fixedUpdatedAt?: number } = {},
) {
  const db = drizzle(env.DB);
  for (let index = 0; index < count; index += 1) {
    const now = options.fixedUpdatedAt ?? 10_000 + index;
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

async function seedForeignArchiveOwner() {
  const db = drizzle(env.DB);
  await db.insert(user).values({
    id: "foreign-user",
    name: "Foreign learner",
    email: "foreign-learner@example.test",
    username: "foreign-learner",
    displayUsername: "foreign-learner",
  });
  await db.insert(organization).values({
    id: "foreign-org",
    name: "Foreign organization",
    slug: "foreign-organization",
    createdAt: new Date(40_000),
  });
  await db.insert(agentHosts).values({
    id: "foreign-host",
    userId: "foreign-user",
    organizationId: "foreign-org",
    name: "Disabled learner host",
    disabled: true,
    createdAt: 40_000,
    updatedAt: 40_000,
  });
}

async function seedForeignRun(input: {
  runId: string;
  state: "queued" | "completed";
  updatedAt: number;
  hiddenAt?: number;
}) {
  const initial = buildInitialRunState({
    vms: [
      {
        id: `${input.runId}-vm`,
        ordinal: 0,
        scenarioVmId: "foreign-vm",
        scenarioVmName: "Foreign VM",
        runtimeVmName: `${input.runId}-vm`,
        hostname: "foreign-vm",
        launchSummary: {
          scenarioVmName: "Foreign VM",
          hostname: "foreign-vm",
          probePhaseMap: {},
          probeDescriptors: [],
        },
      },
    ],
  });
  const state = recomputeRunState({
    ...initial,
    phase: input.state,
    vms: initial.vms.map((vm) => ({
      ...vm,
      phase: input.state === "completed" ? "completed" : vm.phase,
    })),
  });
  await drizzle(env.DB)
    .insert(scenarioRuns)
    .values({
      runId: input.runId,
      userId: "foreign-user",
      hostId: "foreign-host",
      scenarioId: "foreign-scenario",
      scenarioName: "foreign-scenario",
      title: "Foreign scenario",
      tagline: "",
      briefingMarkdown: "",
      objectivesJson: "[]",
      difficulty: "easy",
      estimatedMinutes: 1,
      tagsJson: [],
      hintsJson: [],
      solutionMarkdown: "",
      vmCount: 0,
      state: input.state,
      stateRank: RUN_PHASE_ORDER[input.state],
      stateJson: JSON.stringify(state),
      completedAt: input.state === "completed" ? input.updatedAt : null,
      hiddenAt: input.hiddenAt ?? null,
      createdAt: input.updatedAt,
      updatedAt: input.updatedAt,
    });
}
