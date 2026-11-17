import { describe, expect, it } from "vitest";
import {
  CLEANUP_CONTENTION_REASONS,
  CLEANUP_WITHHOLD_REASONS,
  completionStatus,
} from "../../workers/image-registry-cleanup/src/completion";
import type { OciSweepReport } from "@/lib/oci-registry-sweep";

function report(overrides: Partial<OciSweepReport> = {}): OciSweepReport {
  return {
    mode: "delete",
    completed: false,
    resumeRequired: false,
    faults: [],
    startAfter: null,
    nextStartAfter: null,
    listedObjects: 0,
    listedBytes: 0,
    unrecognizedObjects: 0,
    markedObjects: 0,
    youngObjects: 0,
    candidateObjects: 0,
    candidateBytes: 0,
    candidateSample: [],
    deletedObjects: 0,
    deletedBytes: 0,
    revisionCandidates: 0,
    deletedRevisions: 0,
    error: null,
    ...overrides,
  };
}

describe("registry cleanup completion mapping", () => {
  it("copies the sweep verdict: completed means ok, and only that", () => {
    expect(completionStatus(report({ completed: true, deletedObjects: 12 }))).toBe("ok");
    // The sweep withholds `completed` for a partial pass; counters that look
    // good do not make it ok.
    for (const withheld of [
      report({ resumeRequired: true, deletedObjects: 12, candidateObjects: 12 }),
      report({ nextStartAfter: "a".repeat(64) }),
    ]) {
      expect(completionStatus(withheld), JSON.stringify(withheld)).not.toBe("ok");
    }
  });

  it("reports core-failed for any fault, in either mode", () => {
    const faults = [{ code: "listing_failed", detail: "list" }] as OciSweepReport["faults"];
    expect(completionStatus(report({ completed: true, faults }))).toBe("core-failed");
    expect(completionStatus(report({ mode: "report-only", faults }))).toBe("core-failed");
  });

  it("reports report-only for a plan, which never completes", () => {
    expect(completionStatus(report({ mode: "report-only", completed: true }))).toBe("report-only");
  });

  it("reports busy when another actor holds the registry", () => {
    for (const reason of CLEANUP_CONTENTION_REASONS) {
      expect(completionStatus(report({ error: reason })), reason).toBe("busy");
    }
  });

  it("reports paused when the registry withholds deletes", () => {
    for (const reason of CLEANUP_WITHHOLD_REASONS) {
      expect(completionStatus(report({ error: reason })), reason).toBe("paused");
    }
    expect(
      completionStatus(report({ error: "registry admission enforcement is report_only" })),
    ).toBe("paused");
  });

  it("reports core-failed for any other reason", () => {
    expect(completionStatus(report({ error: "2 object delete(s) failed" }))).toBe("core-failed");
  });

  it("reports pending when the sweep stopped without a reason", () => {
    // A bounded pass that still has work leaves no error behind; another pass
    // finishes it.
    expect(
      completionStatus(report({ resumeRequired: true, deletedObjects: 5_000, nextStartAfter: "b".repeat(64) })),
    ).toBe("pending");
  });

  it("keeps the refusal vocabularies disjoint and non-empty", () => {
    expect(CLEANUP_CONTENTION_REASONS.length).toBeGreaterThan(0);
    expect(CLEANUP_WITHHOLD_REASONS.length).toBeGreaterThan(0);
    for (const reason of CLEANUP_CONTENTION_REASONS) {
      expect(CLEANUP_WITHHOLD_REASONS).not.toContain(reason);
    }
  });
});
