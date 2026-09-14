import { describe, expect, it, vi } from "vitest";
import {
  readCleanupEnvelope,
  registryCleanupService,
  runRegistryCleanup,
  type RegistryCleanupServiceBinding,
} from "@/lib/registry-cleanup-client";
import type { CleanupEnvelope, CleanupStatus } from "../../workers/image-registry-cleanup/src/types";
import type { ImageRegistryCleanupRunResult } from "@/lib/image-registry-cleanup";

/** A complete run result; tests override the fields they are about. */
function runResult(
  overrides: Partial<ImageRegistryCleanupRunResult> = {},
): ImageRegistryCleanupRunResult {
  return {
    deletedObjects: 0,
    deletedBytes: 0,
    failedObjects: 0,
    skippedObjects: 0,
    wouldDeleteObjects: 0,
    wouldDeleteBytes: 0,
    blockedObjects: 0,
    completed: false,
    planSummary: null,
    postState: null,
    verifiedDeletedObjects: 0,
    verifiedDeletedBytes: 0,
    unverifiedObjects: 0,
    unverifiedKeys: [],
    deletedKeys: [],
    deletedKeysTruncated: false,
    deletedKeysDigest: "0".repeat(64),
    resumeRequired: false,
    phases: {},
    error: null,
    ...overrides,
  };
}

function envelope(
  status: CleanupStatus,
  fields: Partial<CleanupEnvelope> = {},
): CleanupEnvelope {
  return {
    schemaVersion: 1,
    status,
    mode: status === "ok" ? "delete" : "report-only",
    modeValid: true,
    maintenance: "off",
    maintenanceSource: "control-plane",
    source: "rpc",
    startedAtMs: 1,
    finishedAtMs: 2,
    plan: null,
    result: null,
    error: null,
    ...fields,
  };
}

function service(status: CleanupStatus): RegistryCleanupServiceBinding {
  return {
    status: vi.fn(),
    plan: vi.fn(),
    run: vi.fn().mockResolvedValue(envelope(status)),
  } as unknown as RegistryCleanupServiceBinding;
}

describe("registry cleanup client", () => {
  it("treats an applied pass as ok and applied", () => {
    const outcome = readCleanupEnvelope(
      envelope("ok", {
        result: {
          ...runResult({
            deletedObjects: 3,
            deletedBytes: 30,
            skippedObjects: 1,
            completed: true,
          }),
        },
      }),
    );

    expect(outcome).toMatchObject({
      ok: true,
      applied: true,
      deletedObjects: 3,
      error: null,
    });
  });

  it("keeps a report-only pass pending, so no caller reads it as success", () => {
    const outcome = readCleanupEnvelope(envelope("report-only"));

    // Report-only deletes nothing. A caller that waits for retired artifacts
    // must stay pending and strict instead of reporting a completed retention.
    expect(outcome).toMatchObject({
      ok: false,
      applied: false,
      status: "report-only",
      error: "registry cleanup is in report-only mode",
    });
  });

  it("treats a refused pass as not ok and explains it", () => {
    for (const status of ["fenced", "paused", "busy", "core-failed"] as const) {
      const outcome = readCleanupEnvelope(envelope(status));
      expect(outcome.ok).toBe(false);
      expect(outcome.applied).toBe(false);
      expect(outcome.status).toBe(status);
    }
    expect(readCleanupEnvelope(envelope("fenced")).error).toBe(
      "registry cleanup is fenced by maintenance",
    );
  });

  it("retries a busy collector inside the wait budget", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(envelope("busy"))
      .mockResolvedValueOnce(envelope("ok"));
    const binding = { status: vi.fn(), plan: vi.fn(), run } as unknown as RegistryCleanupServiceBinding;

    const outcome = await runRegistryCleanup(binding, { waitBudgetMs: 5_000 });

    expect(run).toHaveBeenCalledTimes(2);
    expect(outcome.ok).toBe(true);
  });

  it("retries a pending pass inside the wait budget", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(
        envelope("pending", {
          result: runResult({
            deletedObjects: 5_000,
            deletedBytes: 5_000,
            skippedObjects: 7_000,
            wouldDeleteObjects: 12_000,
            wouldDeleteBytes: 12_000,
            resumeRequired: true,
          }),
        }),
      )
      .mockResolvedValueOnce(envelope("ok"));
    const binding = {
      status: vi.fn(),
      plan: vi.fn(),
      run,
    } as unknown as RegistryCleanupServiceBinding;

    const outcome = await runRegistryCleanup(binding, { waitBudgetMs: 5_000 });

    expect(run).toHaveBeenCalledTimes(2);
    expect(outcome.ok).toBe(true);
  });

  it("returns pending, never ok, when a bounded pass cannot finish in budget", async () => {
    const binding = {
      status: vi.fn(),
      plan: vi.fn(),
      run: vi.fn().mockResolvedValue(
        envelope("pending", {
          result: runResult({
            deletedObjects: 5_000,
            deletedBytes: 5_000,
            skippedObjects: 7_000,
            wouldDeleteObjects: 12_000,
            wouldDeleteBytes: 12_000,
            resumeRequired: true,
          }),
        }),
      ),
    } as unknown as RegistryCleanupServiceBinding;

    const outcome = await runRegistryCleanup(binding, {
      waitBudgetMs: 50,
      nowUnixMs: Date.now(),
    });

    expect(outcome.status).toBe("pending");
    expect(outcome.ok).toBe(false);
    expect(outcome.applied).toBe(false);
    expect(outcome.partial).toBe(true);
    expect(outcome.resumeRequired).toBe(true);
    expect(outcome.error).toBe(
      "registry cleanup has not finished its sweep worklist",
    );
    // The worklist size is reported from the run counters, not from a plan.
    expect(outcome.candidates).toBe(12_000);
  });

  it("reports an unreachable collector as retryable, not as success", async () => {
    const binding = {
      status: vi.fn(),
      plan: vi.fn(),
      run: vi.fn().mockRejectedValue(new Error("no route to the collector")),
    } as unknown as RegistryCleanupServiceBinding;

    const outcome = await runRegistryCleanup(binding);

    expect(outcome).toMatchObject({
      ok: false,
      applied: false,
      status: "unavailable",
      error: "no route to the collector",
    });
  });

  it("reads the binding only when it can run", () => {
    expect(registryCleanupService({} as Cloudflare.Env)).toBeNull();
    expect(
      registryCleanupService({ REGISTRY_CLEANUP: service("ok") } as unknown as Cloudflare.Env),
    ).not.toBeNull();
  });
});
