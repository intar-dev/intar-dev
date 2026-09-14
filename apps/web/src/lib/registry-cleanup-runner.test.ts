import { beforeEach, describe, expect, it, vi } from "vitest";

// The sweep core and the shared admission gate belong to the retention and
// admission work. This file proves the collector's own gates and the order in
// which it applies them.
const core = vi.hoisted(() => ({
  create: vi.fn(),
  plan: vi.fn(),
  run: vi.fn(),
}));
const admission = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock("@/lib/image-registry-cleanup", () => ({
  createImageRegistryCleanupCore: core.create,
}));

vi.mock("@/lib/image-registry-admission", () => ({
  REGISTRY_ADMISSION_KEY: "image_registry_admission",
  REGISTRY_ADMISSION_PROTOCOL_VERSION: 1,
  readRegistryAdmissionState: admission.read,
}));

import {
  runCleanup,
  type CleanupEnv,
} from "../../workers/image-registry-cleanup/src/cleanup";

const PLAN = {
  schemaVersion: 1,
  generatedAtMs: 1_700_000_000_000,
  mode: "report-only",
  objectsScanned: 3,
  retainedObjects: 1,
  candidateObjects: [
    { key: "image-chunks/v1/zstd6/aa", bytes: 10, category: "image_chunk" },
  ],
  candidateBytes: 10,
  truncated: false,
  details: { faults: [], candidateTotal: 1 },
};

const RESULT = {
  deletedObjects: 4,
  deletedBytes: 40,
  failedObjects: 0,
  skippedObjects: 2,
  wouldDeleteObjects: 0,
  wouldDeleteBytes: 0,
  blockedObjects: 0,
  completed: true,
  planSummary: null,
  postState: null,
  verifiedDeletedObjects: 4,
  verifiedDeletedBytes: 40,
  unverifiedObjects: 0,
  unverifiedKeys: [],
  deletedKeys: [],
  deletedKeysTruncated: false,
  deletedKeysDigest: "0".repeat(64),
  resumeRequired: false,
  phases: {},
  error: null,
};

function admissionState(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    enforcement: "enforce",
    epoch: 1,
    state: "open",
    paused: false,
    pauseReason: null,
    sweep: {
      active: false,
      stalled: false,
      token: null,
      owner: null,
      startedAtMs: null,
      heartbeatAtMs: null,
      expiresAtMs: null,
    },
    counts: {
      openSessions: 0,
      staleOpenSessions: 0,
      pendingWriters: 0,
      stalePendingWriters: 0,
      unknownWriters: 0,
    },
    ...overrides,
  };
}

function childEnv(overrides: Partial<CleanupEnv> = {}): CleanupEnv {
  return {
    DB: {} as D1Database,
    VM_IMAGE_REGISTRY_BUCKET: {} as R2Bucket,
    REGISTRY_CLEANUP_MODE: "report-only",
    CONTROL_PLANE: { state: async () => ({ maintenance: "off" }) },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  core.plan.mockResolvedValue(PLAN);
  core.run.mockResolvedValue(RESULT);
  core.create.mockReturnValue({ plan: core.plan, run: core.run });
  admission.read.mockResolvedValue(admissionState());
});

describe("image registry cleanup runner", () => {
  it("plans the sweep and stops before any delete in report-only mode", async () => {
    const result = await runCleanup(childEnv(), { source: "scheduled" });

    expect(result.status).toBe("report-only");
    expect(result.mode).toBe("report-only");
    expect(result.plan).toEqual(PLAN);
    expect(result.result).toBeNull();
    expect(core.plan).toHaveBeenCalledTimes(1);
    expect(core.run).not.toHaveBeenCalled();
  });

  it("runs the core, which owns the exclusive sweep lease, in delete mode", async () => {
    const result = await runCleanup(
      childEnv({ REGISTRY_CLEANUP_MODE: "delete" }),
      { source: "rpc" },
    );

    expect(result.status).toBe("ok");
    expect(result.result).toEqual(RESULT);
    // The core takes the sweep lease itself; the collector injects no second gate.
    expect(core.create).toHaveBeenCalledWith({});
    // One scan, not two: a delete pass must not pre-plan before the core plans
    // and verifies its own plan inside the sweep lease.
    expect(core.plan).not.toHaveBeenCalled();
    expect(core.run).toHaveBeenCalledWith(
      expect.objectContaining({ DB: expect.anything() }),
      expect.objectContaining({ mode: "delete" }),
    );
  });

  it("reports pending, never ok, when the core withheld its completion proof", async () => {
    core.run.mockResolvedValue({
      ...RESULT,
      failedObjects: 0,
      completed: false,
      resumeRequired: true,
    });

    const result = await runCleanup(
      childEnv({ REGISTRY_CLEANUP_MODE: "delete" }),
      { source: "rpc" },
    );

    expect(result.status).toBe("pending");
    expect(result.error).toBeNull();
  });

  it("reports busy when the core refused the sweep", async () => {
    core.run.mockResolvedValue({
      ...RESULT,
      failedObjects: 0,
      completed: false,
      resumeRequired: true,
      deletedObjects: 0,
      deletedBytes: 0,
      wouldDeleteObjects: 12,
      error: "registry admission is busy",
    });

    const result = await runCleanup(
      childEnv({ REGISTRY_CLEANUP_MODE: "delete" }),
      { source: "rpc" },
    );

    expect(result.status).toBe("busy");
    expect(result.error).toBe("registry admission is busy");
    expect(result.result?.deletedObjects).toBe(0);
  });

  it("reports core-failed when the core stopped on a retention fault", async () => {
    core.run.mockResolvedValue({
      ...RESULT,
      failedObjects: 0,
      deletedObjects: 0,
      completed: false,
      resumeRequired: true,
      error:
        "reference verification stopped the sweep: retained_manifest_missing",
    });

    const result = await runCleanup(
      childEnv({ REGISTRY_CLEANUP_MODE: "delete" }),
      { source: "rpc" },
    );

    expect(result.status).toBe("core-failed");
    expect(result.error).toContain("retained_manifest_missing");
  });

  it("honours planOnly in delete mode", async () => {
    const result = await runCleanup(
      childEnv({ REGISTRY_CLEANUP_MODE: "delete" }),
      { source: "rpc", planOnly: true },
    );

    expect(result.status).toBe("report-only");
    expect(core.run).not.toHaveBeenCalled();
  });

  it("fences the run before it reads the admission gate", async () => {
    const result = await runCleanup(
      childEnv({ CONTROL_PLANE: { state: async () => ({ maintenance: "on" }) } }),
      { source: "scheduled" },
    );

    expect(result.status).toBe("fenced");
    expect(result.maintenance).toBe("on");
    expect(admission.read).not.toHaveBeenCalled();
    expect(core.plan).not.toHaveBeenCalled();
    expect(core.run).not.toHaveBeenCalled();
  });

  it("treats an unreachable control plane as maintenance", async () => {
    const result = await runCleanup(
      childEnv({
        CONTROL_PLANE: {
          state: async () => {
            throw new Error("no route to the control plane");
          },
        },
      }),
      { source: "scheduled" },
    );

    expect(result.status).toBe("fenced");
    expect(result.maintenanceSource).toBe("unavailable");
    expect(core.plan).not.toHaveBeenCalled();
  });

  it("treats a deployment hold as paused and does not scan", async () => {
    admission.read.mockResolvedValue(
      admissionState({ paused: true, pauseReason: "registry_cleanup_hold" }),
    );

    const result = await runCleanup(childEnv(), { source: "scheduled" });

    expect(result.status).toBe("paused");
    expect(core.plan).not.toHaveBeenCalled();
  });

  it("treats a sweep of another isolate as busy", async () => {
    admission.read.mockResolvedValue(
      admissionState({
        sweep: { ...admissionState().sweep, active: true, token: "other" },
      }),
    );

    const result = await runCleanup(childEnv(), { source: "scheduled" });

    expect(result.status).toBe("busy");
    expect(core.plan).not.toHaveBeenCalled();
  });

  it("reports core-failed when the plan fails, without deleting", async () => {
    core.plan.mockRejectedValue(new Error("scan failed"));

    const result = await runCleanup(
      childEnv({ REGISTRY_CLEANUP_MODE: "report-only" }),
      { source: "scheduled" },
    );

    expect(result.status).toBe("core-failed");
    expect(result.error).toBe("scan failed");
    expect(core.run).not.toHaveBeenCalled();
  });

  it("reports core-failed when a delete fails, without a second plan", async () => {
    core.run.mockRejectedValue(new Error("delete failed"));

    const result = await runCleanup(
      childEnv({ REGISTRY_CLEANUP_MODE: "delete" }),
      { source: "rpc" },
    );

    expect(result.status).toBe("core-failed");
    // A delete pass never plans first, so a failed run is the only scan.
    expect(core.plan).not.toHaveBeenCalled();
  });

  it("fails closed on an unreadable mode", async () => {
    const result = await runCleanup(
      childEnv({ REGISTRY_CLEANUP_MODE: "yes" }),
      { source: "rpc" },
    );

    expect(result.mode).toBe("report-only");
    expect(result.modeValid).toBe(false);
    expect(core.run).not.toHaveBeenCalled();
  });
});
