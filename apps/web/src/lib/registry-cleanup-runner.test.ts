import { beforeEach, describe, expect, it, vi } from "vitest";

// The sweep and the shared admission gate have their own tests. This file
// proves the collector's own gates and the order in which it applies them.
const sweep = vi.hoisted(() => ({ run: vi.fn() }));
const admission = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock("@/lib/oci-registry-sweep", () => ({ runOciSweep: sweep.run }));

vi.mock("@/lib/image-registry-admission", () => ({
  REGISTRY_ADMISSION_KEY: "image_registry_admission",
  REGISTRY_ADMISSION_PROTOCOL_VERSION: 1,
  readRegistryAdmissionState: admission.read,
}));

import {
  runCleanup,
  type CleanupEnv,
} from "../../workers/image-registry-cleanup/src/cleanup";
import type { OciSweepReport } from "@/lib/oci-registry-sweep";

function report(overrides: Partial<OciSweepReport> = {}): OciSweepReport {
  return {
    mode: "delete",
    completed: true,
    resumeRequired: false,
    faults: [],
    startAfter: null,
    nextStartAfter: null,
    listedObjects: 6,
    listedBytes: 60,
    unrecognizedObjects: 0,
    markedObjects: 0,
    youngObjects: 0,
    candidateObjects: 4,
    candidateBytes: 40,
    candidateSample: [],
    deletedObjects: 4,
    deletedBytes: 40,
    revisionCandidates: 0,
    deletedRevisions: 0,
    error: null,
    ...overrides,
  };
}

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
  sweep.run.mockImplementation(async (_env: unknown, input: { mode: OciSweepReport["mode"] }) =>
    report({ mode: input.mode, completed: input.mode === "delete", deletedObjects: input.mode === "delete" ? 4 : 0 }));
  admission.read.mockResolvedValue(admissionState());
});

describe("image registry cleanup runner", () => {
  it("plans the sweep and stops before any delete in report-only mode", async () => {
    const result = await runCleanup(childEnv(), { source: "scheduled" });

    expect(result.status).toBe("report-only");
    expect(result.mode).toBe("report-only");
    expect(result.result?.mode).toBe("report-only");
    expect(result.result?.deletedObjects).toBe(0);
    expect(sweep.run).toHaveBeenCalledTimes(1);
    expect(sweep.run).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mode: "report-only" }),
    );
  });

  it("runs the sweep, which owns the exclusive lease, in delete mode", async () => {
    const result = await runCleanup(
      childEnv({ REGISTRY_CLEANUP_MODE: "delete" }),
      { source: "rpc" },
    );

    expect(result.status).toBe("ok");
    expect(result.result?.deletedObjects).toBe(4);
    expect(result.error).toBeNull();
    // One sweep call: a delete pass does not plan first.
    expect(sweep.run).toHaveBeenCalledTimes(1);
    expect(sweep.run).toHaveBeenCalledWith(
      expect.objectContaining({ DB: expect.anything() }),
      expect.objectContaining({ mode: "delete" }),
    );
  });

  it("passes the parent's Kino pins and the plan window to the sweep", async () => {
    await runCleanup(
      childEnv({
        CONTROL_PLANE: { state: async () => ({ maintenance: "off", kinoPinsJson: "[]" }) },
      }),
      { source: "rpc", planOnly: true, ociStartAfter: "c".repeat(64) },
    );

    expect(sweep.run).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kinoPinsJson: "[]", startAfter: "c".repeat(64) }),
    );
  });

  it("reports pending, never ok, when the sweep withheld completion", async () => {
    sweep.run.mockResolvedValue(report({ completed: false, resumeRequired: true }));

    const result = await runCleanup(
      childEnv({ REGISTRY_CLEANUP_MODE: "delete" }),
      { source: "rpc" },
    );

    expect(result.status).toBe("pending");
    expect(result.error).toBeNull();
  });

  it("reports busy when the sweep was refused", async () => {
    sweep.run.mockResolvedValue(
      report({ completed: false, deletedObjects: 0, error: "registry admission is busy" }),
    );

    const result = await runCleanup(
      childEnv({ REGISTRY_CLEANUP_MODE: "delete" }),
      { source: "rpc" },
    );

    expect(result.status).toBe("busy");
    expect(result.error).toBe("registry admission is busy");
    expect(result.result?.deletedObjects).toBe(0);
  });

  it("reports core-failed when the sweep faulted", async () => {
    sweep.run.mockResolvedValue(
      report({
        completed: false,
        deletedObjects: 0,
        faults: [{ code: "listing_failed", detail: "list" }],
        error: "listing_failed: list",
      }),
    );

    const result = await runCleanup(
      childEnv({ REGISTRY_CLEANUP_MODE: "delete" }),
      { source: "rpc" },
    );

    expect(result.status).toBe("core-failed");
    expect(result.error).toContain("listing_failed");
  });

  it("honours planOnly in delete mode", async () => {
    const result = await runCleanup(
      childEnv({ REGISTRY_CLEANUP_MODE: "delete" }),
      { source: "rpc", planOnly: true },
    );

    expect(result.status).toBe("report-only");
    expect(sweep.run).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mode: "report-only" }),
    );
  });

  it("fences the run before it reads the admission gate", async () => {
    const result = await runCleanup(
      childEnv({ CONTROL_PLANE: { state: async () => ({ maintenance: "on" }) } }),
      { source: "scheduled" },
    );

    expect(result.status).toBe("fenced");
    expect(result.maintenance).toBe("on");
    expect(result.result).toBeNull();
    expect(admission.read).not.toHaveBeenCalled();
    expect(sweep.run).not.toHaveBeenCalled();
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
    expect(sweep.run).not.toHaveBeenCalled();
  });

  it("treats a deployment hold as paused and does not scan", async () => {
    admission.read.mockResolvedValue(
      admissionState({ paused: true, pauseReason: "registry_cleanup_hold" }),
    );

    const result = await runCleanup(childEnv(), { source: "scheduled" });

    expect(result.status).toBe("paused");
    expect(sweep.run).not.toHaveBeenCalled();
  });

  it("treats a sweep of another isolate as busy", async () => {
    admission.read.mockResolvedValue(
      admissionState({
        sweep: { ...admissionState().sweep, active: true, token: "other" },
      }),
    );

    const result = await runCleanup(childEnv(), { source: "scheduled" });

    expect(result.status).toBe("busy");
    expect(sweep.run).not.toHaveBeenCalled();
  });

  it("reports core-failed when the sweep throws", async () => {
    sweep.run.mockRejectedValue(new Error("scan failed"));

    const result = await runCleanup(childEnv(), { source: "scheduled" });

    expect(result.status).toBe("core-failed");
    expect(result.error).toBe("scan failed");
    expect(result.result).toBeNull();
  });

  it("fails closed on an unreadable mode", async () => {
    const result = await runCleanup(
      childEnv({ REGISTRY_CLEANUP_MODE: "yes" }),
      { source: "rpc" },
    );

    expect(result.mode).toBe("report-only");
    expect(result.modeValid).toBe(false);
    expect(sweep.run).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mode: "report-only" }),
    );
  });
});
