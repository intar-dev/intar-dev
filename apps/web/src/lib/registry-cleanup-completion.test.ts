import { describe, expect, it } from "vitest";
import {
  CLEANUP_CONTENTION_REASONS,
  CLEANUP_WITHHOLD_REASONS,
  completionStatus,
  isAppliedCompletion,
} from "../../workers/image-registry-cleanup/src/completion";
import type { ImageRegistryCleanupRunResult } from "@/lib/image-registry-cleanup";

function run(
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

describe("registry cleanup completion mapping", () => {
  it("copies the core verdict: completed means ok, and only that", () => {
    const status = completionStatus(
      run({
        completed: true,
        deletedObjects: 12,
        verifiedDeletedObjects: 12,
        wouldDeleteObjects: 12,
      }),
    );

    expect(status).toBe("ok");
    expect(isAppliedCompletion(status)).toBe(true);
  });

  it("never reports ok while the core withholds completion", () => {
    // The core withholds `completed` for a partial pass, a blocked batch, an
    // unproven delete, and a post-state that changed. The collector copies that
    // verdict: it does not re-derive it from counters that happen to look good.
    const withheld = [
      run({ completed: false, resumeRequired: true }),
      run({ completed: false, blockedObjects: 1 }),
      run({ completed: false, unverifiedObjects: 1 }),
      run({ completed: false, failedObjects: 1 }),
      run({ completed: false, wouldDeleteObjects: 12, deletedObjects: 12 }),
      run({ completed: false, phases: { retired_builds: 3 } }),
    ];

    for (const result of withheld) {
      const status = completionStatus(result);
      expect(status, JSON.stringify(result)).not.toBe("ok");
      expect(isAppliedCompletion(status)).toBe(false);
    }
  });

  it("reports core-failed for a retention fault that stopped the sweep", () => {
    // The production hazard: a missing retained manifest must never read as a
    // completed pass, because a promotion then believes artifacts are gone.
    const status = completionStatus(
      run({
        completed: false,
        error:
          "reference verification stopped the sweep: retained_manifest_missing",
        blockedObjects: 1,
      }),
    );

    expect(status).toBe("core-failed");
    expect(isAppliedCompletion(status)).toBe(false);
  });

  it("reports core-failed for a delete that failed", () => {
    expect(
      completionStatus(
        run({ completed: false, failedObjects: 2, error: "2 object delete(s) failed" }),
      ),
    ).toBe("core-failed");
  });

  it("reports busy when another actor holds the registry", () => {
    for (const reason of CLEANUP_CONTENTION_REASONS) {
      const status = completionStatus(run({ completed: false, error: reason }));
      expect(status, reason).toBe("busy");
      expect(isAppliedCompletion(status)).toBe(false);
    }
  });

  it("reports paused when the registry withholds deletes", () => {
    for (const reason of CLEANUP_WITHHOLD_REASONS) {
      expect(completionStatus(run({ completed: false, error: reason })), reason).toBe(
        "paused",
      );
    }
    expect(
      completionStatus(
        run({
          completed: false,
          error: "registry admission enforcement is report_only",
        }),
      ),
    ).toBe("paused");
  });

  it("reports pending when the core stopped without a reason", () => {
    // A bounded pass that still has work leaves no error behind. Another pass
    // finishes it, so the status is pending and never a failure or a success.
    const status = completionStatus(
      run({
        completed: false,
        deletedObjects: 5_000,
        wouldDeleteObjects: 12_000,
        resumeRequired: true,
        skippedObjects: 7_000,
      }),
    );

    expect(status).toBe("pending");
    expect(isAppliedCompletion(status)).toBe(false);
  });

  it("keeps the refusal vocabularies disjoint and non-empty", () => {
    expect(CLEANUP_CONTENTION_REASONS.length).toBeGreaterThan(0);
    expect(CLEANUP_WITHHOLD_REASONS.length).toBeGreaterThan(0);
    for (const reason of CLEANUP_CONTENTION_REASONS) {
      expect(CLEANUP_WITHHOLD_REASONS).not.toContain(reason);
    }
  });
});
