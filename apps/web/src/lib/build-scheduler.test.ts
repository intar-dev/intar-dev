import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assignQueuedImageBuilds,
  queueImageBuildsFromBundle,
  recordHostBuildReports,
  recordImageBuildReport,
} from "@/lib/build-scheduler";
import type { BuildReportV1, HostDesiredStateV2 } from "@/generated/bridge";

const desiredStateStoreMock = vi.hoisted(() => ({
  mutateStoredHostDesiredState: vi.fn(),
}));
const hostRuntimeWakeMock = vi.hoisted(() => ({
  tryWakeHostRuntime: vi.fn(),
}));
const imageBuildLockMock = vi.hoisted(() => ({
  withImageBuildCoordinationLock: vi.fn(),
}));

vi.mock("@/lib/desired-state-store", () => desiredStateStoreMock);
vi.mock("@/lib/host-runtime-wake", () => hostRuntimeWakeMock);
vi.mock("@/lib/image-build-lock", () => imageBuildLockMock);

describe("build scheduler", () => {
  beforeEach(() => {
    desiredStateStoreMock.mutateStoredHostDesiredState.mockReset();
    hostRuntimeWakeMock.tryWakeHostRuntime.mockReset();
    imageBuildLockMock.withImageBuildCoordinationLock.mockReset();
    imageBuildLockMock.withImageBuildCoordinationLock.mockImplementation(
      async (_db, _input, callback) => callback({ assertHeld: vi.fn() }),
    );
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
      activeAssignmentRows: [[{ id: "build-1" }], [{ id: "build-2" }]],
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

  it("compensates when supersession wins between an assignment claim and desired-state publication", async () => {
    const now = 1_762_041_660_000;
    const db = assignmentDb({
      queuedRows: [queuedBuild("build-1", "broken-nginx")],
      builderRows: [
        builderCandidateRow("builder-1", {
          cpuCount: 8,
          memoryAvailableMib: 16_384,
          diskAvailableMib: 100_000,
        }),
      ],
      activeBuildRows: [],
      claimedRows: [[{ id: "build-1" }]],
      activeAssignmentRows: [[]],
    });

    await expect(assignQueuedImageBuilds(db as never, now)).resolves.toEqual(
      [],
    );
    expect(
      desiredStateStoreMock.mutateStoredHostDesiredState,
    ).toHaveBeenCalledTimes(2);

    const published = emptyDesiredState("builder-1");
    desiredStateStoreMock.mutateStoredHostDesiredState.mock.calls[0]?.[3]?.(
      published,
    );
    expect(published.builds.map((build) => build.build_id)).toEqual([
      "build-1",
    ]);
    desiredStateStoreMock.mutateStoredHostDesiredState.mock.calls[1]?.[3]?.(
      published,
    );
    expect(published.builds).toEqual([]);
    expect(hostRuntimeWakeMock.tryWakeHostRuntime).toHaveBeenCalledTimes(2);
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
      meta: {
        buildFormatVersion: "intar-image-build-v10",
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
    expect(db.batch).toHaveBeenCalledOnce();
    expect(hostRuntimeWakeMock.tryWakeHostRuntime).toHaveBeenCalledWith(
      "builder-1",
    );
  });

  it("retires superseded active hashes and removes their desired builds before queuing the new hash", async () => {
    const now = 1_762_041_660_000;
    const db = newHashBuildSchedulerDb({
      retiredRows: [
        { id: "queued-old", hostId: null },
        { id: "assigned-old", hostId: "builder-1" },
        { id: "building-old", hostId: "builder-1" },
        { id: "other-host-old", hostId: "builder-2" },
      ],
      insertedRows: [{ id: "build-new" }],
    });

    await expect(
      queueImageBuildsFromBundle(db as never, {
        rev: "bundle-new",
        r2Key: "builds/bundles/bundle-new.tar.gz",
        meta: {
          buildFormatVersion: "intar-image-build-v10",
          scenarios: [
            {
              scenarioId: "broken-nginx",
              arch: "x86_64",
              contentHash: "a".repeat(64),
            },
          ],
        },
        nowUnixMs: now,
      }),
    ).resolves.toEqual({ queued: 1 });

    expect(db.batch).toHaveBeenCalledOnce();
    expect(hostRuntimeWakeMock.tryWakeHostRuntime).toHaveBeenNthCalledWith(
      1,
      "builder-1",
    );
    expect(hostRuntimeWakeMock.tryWakeHostRuntime).toHaveBeenNthCalledWith(
      2,
      "builder-2",
    );
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

  it("acknowledges a matching terminal replay for desired-state cleanup", async () => {
    const db = buildReportDb({
      existingRows: [
        {
          hostId: "builder-1",
          status: "succeeded",
          scenarioId: "broken-nginx",
          contentHash: "f".repeat(64),
          timingsJson: {},
        },
      ],
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
        ],
        2_000,
      ),
    ).resolves.toEqual({ terminalBuildIds: ["build-1"] });
    expect(db.updateSet).not.toHaveBeenCalled();
  });

  it("ignores late build reports for non-active, non-matching build rows", async () => {
    for (const status of ["queued", "failed", "stale"] as const) {
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
  return queueSchedulerDb({
    cleanedHosts: [
      ...new Set(
        input.existingBuildRows
          .map((row) => row.hostId)
          .filter((hostId): hostId is string => hostId !== null),
      ),
    ],
    insertedRows: [{ id: input.existingBuildRows[0]?.id ?? "build-1" }],
  });
}

function newHashBuildSchedulerDb(input: {
  retiredRows: Array<{ id: string; hostId: string | null }>;
  insertedRows: Array<{ id: string }>;
}) {
  return queueSchedulerDb({
    cleanedHosts: [
      ...new Set(
        input.retiredRows
          .map((row) => row.hostId)
          .filter((hostId): hostId is string => hostId !== null),
      ),
    ],
    insertedRows: input.insertedRows,
  });
}

function queueSchedulerDb(input: {
  cleanedHosts: string[];
  insertedRows: Array<{ id: string }>;
}) {
  const bundleOnConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const bundleInsertValues = vi.fn(() => ({
    onConflictDoUpdate: bundleOnConflictDoUpdate,
  }));
  const imageInsertReturning = vi.fn(() => ({ kind: "queue-image-build" }));
  const imageOnConflictDoUpdate = vi.fn(() => ({
    returning: imageInsertReturning,
  }));
  const imageInsertValues = vi.fn(() => ({
    onConflictDoUpdate: imageOnConflictDoUpdate,
  }));
  const insert = vi
    .fn()
    .mockReturnValueOnce({ values: bundleInsertValues })
    .mockReturnValueOnce({ values: imageInsertValues });

  const cleanupReturning = vi.fn(() => ({ kind: "cleanup-desired" }));
  const cleanupWhere = vi.fn(() => ({ returning: cleanupReturning }));
  const retireWhere = vi.fn(() => ({ kind: "retire-builds" }));
  const update = vi
    .fn()
    .mockReturnValueOnce({
      set: vi.fn(() => ({ where: cleanupWhere })),
    })
    .mockReturnValueOnce({
      set: vi.fn(() => ({ where: retireWhere })),
    });
  const batch = vi
    .fn()
    .mockResolvedValue([
      input.cleanedHosts.map((hostId) => ({ hostId })),
      {},
      input.insertedRows,
    ]);

  return { insert, update, batch };
}

function emptyDesiredState(hostId: string): HostDesiredStateV2 {
  return {
    schema_version: 3,
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
  activeAssignmentRows: Array<Array<{ id: string }>>;
}) {
  const selectResults = [
    input.queuedRows,
    input.builderRows,
    input.activeBuildRows,
    ...input.activeAssignmentRows,
  ];
  const select = vi.fn(() => {
    const rows = Promise.resolve(selectResults.shift() ?? []);
    const chain = {
      from: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      leftJoin: vi.fn(() => chain),
      where: vi.fn(() => chain),
      limit: vi.fn(() => rows),
      then: rows.then.bind(rows),
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
        ? `v6:${hostId}`
        : options.activeSessionId,
    lastClientHelloAt,
    stateReportedAt: options.stateReportedAt ?? lastClientHelloAt,
    disabled: false,
    reportJson: {
      capabilities: { arch: options.arch ?? "x86_64" },
      capacity: {
        total_cpu_millis: capacity.cpuCount * 1_000,
        reserved_cpu_millis: 0,
        schedulable_cpu_millis: capacity.cpuCount * 1_000,
        committed_cpu_millis: 0,
        memory_available_mib: capacity.memoryAvailableMib,
        disk_available_mib: capacity.diskAvailableMib,
      },
    },
  };
}

function buildReportDb(input: {
  existingRows: Array<{
    hostId: string | null;
    status:
      | "queued"
      | "assigned"
      | "building"
      | "succeeded"
      | "failed"
      | "stale";
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
