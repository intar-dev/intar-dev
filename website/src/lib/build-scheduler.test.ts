import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assignQueuedImageBuilds,
  queueImageBuildsFromBundle,
  recordHostBuildReports,
  recordImageBuildReport,
} from "@/lib/build-scheduler";
import type { BuildReportV1, HostDesiredStateV1 } from "@/generated/bridge";

const desiredStateStoreMock = vi.hoisted(() => ({
  mutateStoredHostDesiredState: vi.fn(),
}));
const hostRuntimeWakeMock = vi.hoisted(() => ({
  tryWakeHostRuntime: vi.fn(),
}));

vi.mock("@/lib/desired-state-store", () => desiredStateStoreMock);
vi.mock("@/lib/host-runtime-wake", () => hostRuntimeWakeMock);

describe("build scheduler", () => {
  beforeEach(() => {
    desiredStateStoreMock.mutateStoredHostDesiredState.mockReset();
    hostRuntimeWakeMock.tryWakeHostRuntime.mockReset();
  });

  it("assigns queued builds to connected arch-matching builders and balances subsequent work", async () => {
    const now = 1_762_041_660_000;
    const db = assignmentDb({
      queuedRows: [
        queuedBuild("build-1", "broken-nginx"),
        queuedBuild("build-2", "workshop-cluster"),
        queuedBuild("build-arm", "arm-only", "aarch64"),
      ],
      builderRows: [
        builderCandidateRow("builder-fast", {
          cpuCount: 16,
          memoryAvailableMib: 32_768,
          diskAvailableMib: 200_000,
        }),
        builderCandidateRow("builder-small", {
          cpuCount: 4,
          memoryAvailableMib: 8_192,
          diskAvailableMib: 50_000,
        }),
        builderCandidateRow(
          "builder-arm",
          {
            cpuCount: 16,
            memoryAvailableMib: 32_768,
            diskAvailableMib: 200_000,
          },
          { arch: "aarch64" },
        ),
        {
          ...builderCandidateRow("builder-offline", {
            cpuCount: 64,
            memoryAvailableMib: 131_072,
            diskAvailableMib: 2_000_000,
          }),
          connected: false,
        },
        builderCandidateRow(
          "builder-no-session",
          {
            cpuCount: 64,
            memoryAvailableMib: 131_072,
            diskAvailableMib: 2_000_000,
          },
          { activeSessionId: null },
        ),
        builderCandidateRow(
          "builder-stale-report",
          {
            cpuCount: 64,
            memoryAvailableMib: 131_072,
            diskAvailableMib: 2_000_000,
          },
          {
            lastClientHelloAt: now,
            stateReportedAt: now - 1,
          },
        ),
      ],
      activeBuildRows: [],
      claimedRows: [[{ id: "build-1" }], [{ id: "build-2" }], []],
    });

    await expect(assignQueuedImageBuilds(db as never, now)).resolves.toEqual([
      { buildId: "build-1", hostId: "builder-fast" },
      { buildId: "build-2", hostId: "builder-small" },
    ]);

    expect(db.updateSet).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        hostId: "builder-fast",
        status: "assigned",
        phase: "queued",
        updatedAt: now,
      }),
    );
    expect(db.updateSet).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        hostId: "builder-small",
        status: "assigned",
        phase: "queued",
        updatedAt: now,
      }),
    );
    expect(db.updateSet).toHaveBeenCalledTimes(3);

    expect(
      desiredStateStoreMock.mutateStoredHostDesiredState,
    ).toHaveBeenNthCalledWith(1, db, "builder-fast", now, expect.any(Function));
    expect(
      desiredStateStoreMock.mutateStoredHostDesiredState,
    ).toHaveBeenNthCalledWith(
      2,
      db,
      "builder-small",
      now,
      expect.any(Function),
    );
    expect(hostRuntimeWakeMock.tryWakeHostRuntime).toHaveBeenNthCalledWith(
      1,
      "builder-fast",
    );
    expect(hostRuntimeWakeMock.tryWakeHostRuntime).toHaveBeenNthCalledWith(
      2,
      "builder-small",
    );

    const fastDraft = emptyDesiredState("builder-fast");
    desiredStateStoreMock.mutateStoredHostDesiredState.mock.calls[0]?.[3]?.(
      fastDraft,
    );
    expect(fastDraft.builds).toEqual([
      expect.objectContaining({
        build_id: "build-1",
        scenario_id: "broken-nginx",
        arch: "x86_64",
        bundle_ref: "builds/bundles/abc123.tar.gz",
      }),
    ]);

    const smallDraft = emptyDesiredState("builder-small");
    desiredStateStoreMock.mutateStoredHostDesiredState.mock.calls[1]?.[3]?.(
      smallDraft,
    );
    expect(smallDraft.builds).toEqual([
      expect.objectContaining({
        build_id: "build-2",
        scenario_id: "workshop-cluster",
        arch: "x86_64",
        bundle_ref: "builds/bundles/abc123.tar.gz",
      }),
    ]);
  });

  it("removes stale desired builds from the previous host when requeueing from a new bundle", async () => {
    const now = 1_762_041_660_000;
    const db = buildSchedulerDb({
      existingBuildRows: [
        {
          id: "build-1",
          hostId: "builder-1",
          status: "stale",
        },
      ],
    });

    const queued = await queueImageBuildsFromBundle(db as never, {
      rev: "abc123",
      r2Key: "builds/bundles/abc123.tar.gz",
      kinoVersion: "0.4.0",
      meta: {
        buildFormatVersion: "intar-image-build-v1",
        scenarios: [
          {
            scenarioId: "broken-nginx",
            arch: "x86_64",
            contentHash: "f".repeat(64),
          },
        ],
      },
      nowUnixMs: now,
    });

    expect(queued).toEqual({ queued: 1 });
    expect(db.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: null,
        status: "queued",
        phase: "queued",
        attempt: 0,
        error: null,
        logR2Key: null,
        updatedAt: now,
      }),
    );
    expect(
      desiredStateStoreMock.mutateStoredHostDesiredState,
    ).toHaveBeenCalledWith(db, "builder-1", now, expect.any(Function));
    expect(hostRuntimeWakeMock.tryWakeHostRuntime).toHaveBeenCalledWith(
      "builder-1",
    );

    const mutator =
      desiredStateStoreMock.mutateStoredHostDesiredState.mock.calls[0]?.[3];
    const draft = desiredStateWithBuild("build-1");
    mutator?.(draft);
    expect(draft.builds).toEqual([]);
  });

  it("ignores build reports whose scenario or content hash no longer matches the assigned row", async () => {
    const db = buildReportDb({
      existingRows: [
        {
          hostId: "builder-1",
          status: "assigned",
          scenarioId: "broken-nginx",
          contentHash: "f".repeat(64),
          timingsJson: {},
        },
      ],
    });

    await expect(
      recordImageBuildReport(
        db as never,
        "builder-1",
        buildReport({
          scenarioId: "workshop-cluster",
          contentHash: "f".repeat(64),
        }),
        2_000,
      ),
    ).resolves.toEqual({ updated: false, terminal: false });
    await expect(
      recordImageBuildReport(
        db as never,
        "builder-1",
        buildReport({
          scenarioId: "broken-nginx",
          contentHash: "a".repeat(64),
        }),
        2_000,
      ),
    ).resolves.toEqual({ updated: false, terminal: false });

    expect(db.updateSet).not.toHaveBeenCalled();
  });

  it("records matching build reports from the assigned builder", async () => {
    const db = buildReportDb({
      existingRows: [
        {
          hostId: "builder-1",
          status: "assigned",
          scenarioId: "broken-nginx",
          contentHash: "f".repeat(64),
          timingsJson: {},
        },
      ],
      updatedRows: [{ id: "build-1" }],
    });

    await expect(
      recordImageBuildReport(
        db as never,
        "builder-1",
        buildReport({
          phase: "succeeded",
          scenarioId: "broken-nginx",
          contentHash: "f".repeat(64),
        }),
        2_000,
      ),
    ).resolves.toEqual({ updated: true, terminal: true });

    expect(db.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: "builder-1",
        phase: "succeeded",
        status: "succeeded",
        attempt: 1,
        error: null,
        updatedAt: 2_000,
      }),
    );
  });

  it("returns only accepted terminal build reports for desired-state cleanup", async () => {
    const db = buildReportDb({
      existingRows: [
        {
          hostId: "builder-1",
          status: "assigned",
          scenarioId: "broken-nginx",
          contentHash: "f".repeat(64),
          timingsJson: {},
        },
      ],
      updatedRows: [{ id: "build-1" }],
    });

    await expect(
      recordHostBuildReports(
        db as never,
        "builder-1",
        [
          buildReport({
            phase: "succeeded",
            scenarioId: "broken-nginx",
            contentHash: "f".repeat(64),
          }),
          buildReport({
            phase: "failed",
            scenarioId: "workshop-cluster",
            contentHash: "f".repeat(64),
          }),
          buildReport({
            phase: "building",
            scenarioId: "broken-nginx",
            contentHash: "f".repeat(64),
          }),
        ],
        2_000,
      ),
    ).resolves.toEqual({ terminalBuildIds: ["build-1"] });
    expect(db.updateSet).toHaveBeenCalledTimes(2);
  });

  it("ignores late build reports for non-active build rows", async () => {
    for (const status of [
      "queued",
      "succeeded",
      "failed",
      "stale",
    ] as const) {
      const db = buildReportDb({
        existingRows: [
          {
            hostId: "builder-1",
            status,
            scenarioId: "broken-nginx",
            contentHash: "f".repeat(64),
            timingsJson: {},
          },
        ],
      });

      await expect(
        recordImageBuildReport(
          db as never,
          "builder-1",
          buildReport({
            phase: "succeeded",
            scenarioId: "broken-nginx",
            contentHash: "f".repeat(64),
          }),
          2_000,
        ),
      ).resolves.toEqual({ updated: false, terminal: false });
      expect(db.updateSet).not.toHaveBeenCalled();
    }
  });

});

function buildSchedulerDb(input: {
  existingBuildRows: Array<{
    id: string;
    hostId: string | null;
    status: "failed" | "stale";
  }>;
}) {
  const insertOnConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const insertValues = vi.fn(() => ({
    onConflictDoUpdate: insertOnConflictDoUpdate,
  }));
  const insert = vi.fn(() => ({ values: insertValues }));

  const selectLimit = vi.fn().mockResolvedValue(input.existingBuildRows);
  const selectWhere = vi.fn(() => ({ limit: selectLimit }));
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  return {
    insert,
    select,
    update,
    updateSet,
  };
}

function desiredStateWithBuild(buildId: string): HostDesiredStateV1 {
  return desiredStateWithBuilds([buildId]);
}

function desiredStateWithBuilds(buildIds: string[]): HostDesiredStateV1 {
  const state = emptyDesiredState("builder-1");
  state.version = 7;
  state.generated_at_unix_ms = 1_762_041_600_000;
  state.builds = buildIds.map((buildId) => ({
    build_id: buildId,
    scenario_id: "broken-nginx",
    arch: "x86_64",
    rev: "abc123",
    content_hash: "f".repeat(64),
    bundle_ref: "builds/bundles/abc123.tar.gz",
    kino_version: "0.4.0",
  }));
  return state;
}

function emptyDesiredState(hostId: string): HostDesiredStateV1 {
  return {
    schema_version: 2,
    host_id: hostId,
    version: 0,
    generated_at_unix_ms: 0,
    cached_images: [],
    vms: [],
    builds: [],
  };
}

function assignmentDb(input: {
  queuedRows: ReturnType<typeof queuedBuild>[];
  builderRows: ReturnType<typeof builderCandidateRow>[];
  activeBuildRows: Array<{ hostId: string | null }>;
  claimedRows: Array<Array<{ id: string }>>;
}) {
  const selectResults = [
    input.queuedRows,
    input.builderRows,
    input.activeBuildRows,
  ];
  const nextSelectRows = vi.fn(() =>
    Promise.resolve(selectResults.shift() ?? []),
  );
  const select = vi.fn(() => {
    const chain = {
      from: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      leftJoin: vi.fn(() => chain),
      where: nextSelectRows,
    };
    return chain;
  });

  const updateReturning = vi.fn(() =>
    Promise.resolve(input.claimedRows.shift() ?? []),
  );
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  return {
    select,
    update,
    updateSet,
  };
}

function queuedBuild(
  id: string,
  scenarioId: string,
  arch: "x86_64" | "aarch64" = "x86_64",
) {
  return {
    id,
    scenarioId,
    arch,
    rev: "abc123",
    contentHash: "f".repeat(64),
    kinoVersion: "0.4.0",
    bundleRef: "builds/bundles/abc123.tar.gz",
  };
}

function builderCandidateRow(
  hostId: string,
  capacity: {
    cpuCount: number;
    memoryAvailableMib: number;
    diskAvailableMib: number;
  },
  options: {
    arch?: "x86_64" | "aarch64";
    activeSessionId?: string | null;
    lastClientHelloAt?: number | null;
    stateReportedAt?: number | null;
  } = {},
) {
  const lastClientHelloAt = options.lastClientHelloAt ?? 1_762_041_660_000;
  return {
    hostId,
    role: "builder" as const,
    connected: true,
    activeSessionId:
      options.activeSessionId === undefined
        ? `v5:${hostId}`
        : options.activeSessionId,
    lastClientHelloAt,
    stateReportedAt: options.stateReportedAt ?? lastClientHelloAt,
    disabled: false,
    reportJson: {
      capabilities: { arch: options.arch ?? "x86_64" },
      capacity: {
        cpu_count: capacity.cpuCount,
        memory_available_mib: capacity.memoryAvailableMib,
        disk_available_mib: capacity.diskAvailableMib,
      },
    },
  };
}

function buildReportDb(input: {
  existingRows: Array<{
    hostId: string | null;
    status: "queued" | "assigned" | "building" | "succeeded" | "failed" | "stale";
    scenarioId: string;
    contentHash: string;
    timingsJson: Record<string, unknown>;
  }>;
  updatedRows?: Array<{ id: string }>;
}) {
  const selectLimit = vi.fn().mockResolvedValue(input.existingRows);
  const selectWhere = vi.fn(() => ({ limit: selectLimit }));
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  const updateReturning = vi.fn().mockResolvedValue(input.updatedRows ?? []);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  return {
    select,
    update,
    updateSet,
  };
}

function buildReport(input: {
  phase?: BuildReportV1["phase"];
  scenarioId: string;
  contentHash: string;
}): BuildReportV1 {
  return {
    schema_version: 1,
    host_id: "builder-1",
    build_id: "build-1",
    scenario_id: input.scenarioId,
    content_hash: input.contentHash,
    observed_at_unix_ms: 1_500,
    phase: input.phase ?? "building",
    current_vm: null,
    started_at_unix_ms: 1_000,
    finished_at_unix_ms: input.phase === "succeeded" ? 1_500 : null,
    attempt: 1,
    error: null,
  };
}
