import { describe, expect, it } from "vitest";
import {
  BUILD_REPORT_STALE_AFTER_MS,
  BUILDER_REASSIGN_AFTER_MS,
  buildStatusFromPhase,
  canRetryImageBuild,
  chooseLeastLoadedBuilder,
  desiredBuildFromSource,
  isDisconnectedPastDeadline,
  isSilentBuildingBuild,
  isTerminalBuildPhase,
  shouldAcceptBuildReport,
  shouldSkipExistingBuildForBundle,
} from "@/lib/build-scheduler-core";

describe("build scheduler core", () => {
  it("maps bridge build phases to persisted scheduler status", () => {
    expect(buildStatusFromPhase("queued")).toBe("assigned");
    expect(buildStatusFromPhase("fetching_sources")).toBe("building");
    expect(buildStatusFromPhase("building_base")).toBe("building");
    expect(buildStatusFromPhase("building")).toBe("building");
    expect(buildStatusFromPhase("publishing")).toBe("building");
    expect(buildStatusFromPhase("uploading_logs")).toBe("building");
    expect(buildStatusFromPhase("succeeded")).toBe("succeeded");
    expect(buildStatusFromPhase("failed")).toBe("failed");
  });

  it("treats only succeeded and failed reports as terminal", () => {
    expect(isTerminalBuildPhase("queued")).toBe(false);
    expect(isTerminalBuildPhase("building")).toBe(false);
    expect(isTerminalBuildPhase("succeeded")).toBe(true);
    expect(isTerminalBuildPhase("failed")).toBe(true);
  });

  it("accepts build reports only from the assigned builder", () => {
    const accepted = {
      assignedHostId: "builder-a",
      assignedStatus: "assigned" as const,
      reportingHostId: "builder-a",
      reportHostId: "builder-a",
      assignedScenarioId: "broken-nginx",
      reportScenarioId: "broken-nginx",
      assignedContentHash: "f".repeat(64),
      reportContentHash: "f".repeat(64),
    };

    expect(shouldAcceptBuildReport(accepted)).toBe(true);
    expect(
      shouldAcceptBuildReport({
        ...accepted,
        reportingHostId: "builder-b",
        reportHostId: "builder-b",
      }),
    ).toBe(false);
    expect(
      shouldAcceptBuildReport({
        ...accepted,
        reportHostId: "builder-b",
      }),
    ).toBe(false);
    expect(
      shouldAcceptBuildReport({
        ...accepted,
        assignedHostId: null,
      }),
    ).toBe(false);
    expect(
      shouldAcceptBuildReport({
        ...accepted,
        assignedStatus: "building",
      }),
    ).toBe(true);
    for (const assignedStatus of [
      "queued",
      "succeeded",
      "failed",
      "stale",
    ] as const) {
      expect(
        shouldAcceptBuildReport({
          ...accepted,
          assignedStatus,
        }),
      ).toBe(false);
    }
    expect(
      shouldAcceptBuildReport({
        ...accepted,
        reportScenarioId: "workshop-cluster",
      }),
    ).toBe(false);
    expect(
      shouldAcceptBuildReport({
        ...accepted,
        reportContentHash: "a".repeat(64),
      }),
    ).toBe(false);
  });

  it("requeues only failed or stale existing builds for a new bundle upload", () => {
    expect(shouldSkipExistingBuildForBundle("queued")).toBe(true);
    expect(shouldSkipExistingBuildForBundle("assigned")).toBe(true);
    expect(shouldSkipExistingBuildForBundle("building")).toBe(true);
    expect(shouldSkipExistingBuildForBundle("succeeded")).toBe(true);
    expect(shouldSkipExistingBuildForBundle("failed")).toBe(false);
    expect(shouldSkipExistingBuildForBundle("stale")).toBe(false);
  });

  it("allows admin retry only for failed or stale builds", () => {
    expect(canRetryImageBuild("queued")).toBe(false);
    expect(canRetryImageBuild("assigned")).toBe(false);
    expect(canRetryImageBuild("building")).toBe(false);
    expect(canRetryImageBuild("succeeded")).toBe(false);
    expect(canRetryImageBuild("failed")).toBe(true);
    expect(canRetryImageBuild("stale")).toBe(true);
  });

  it("chooses the least-loaded connected builder with matching architecture", () => {
    expect(
      chooseLeastLoadedBuilder(
        [
          builder("builder-b", "x86_64", 2, { cpuCount: 32 }),
          builder("builder-a", "x86_64", 1, { cpuCount: 4 }),
          builder("builder-arm", "aarch64", 0),
          { ...builder("disabled", "x86_64", 0), disabled: true },
          { ...builder("offline", "x86_64", 0), connected: false },
          { ...builder("agent", "x86_64", 0), role: "agent" },
        ],
        "x86_64",
      )?.hostId,
    ).toBe("builder-a");
  });

  it("uses reported capacity as the equal-load builder tie-break", () => {
    expect(
      chooseLeastLoadedBuilder(
        [
          builder("builder-a", "x86_64", 1, { cpuCount: 4 }),
          builder("builder-b", "x86_64", 1, { cpuCount: 8 }),
          builder("builder-c", "x86_64", 1, {
            cpuCount: 8,
            memoryAvailableMib: 32_768,
          }),
        ],
        "x86_64",
      )?.hostId,
    ).toBe("builder-c");
  });

  it("serializes desired builds from queued build rows", () => {
    expect(
      desiredBuildFromSource({
        buildId: "build-1",
        scenarioId: "broken-nginx",
        arch: "x86_64",
        rev: "abc123",
        contentHash: "f".repeat(64),
        bundleRef: "builds/bundles/abc123.tar.gz",
        kinoVersion: "1.2.3",
      }),
    ).toEqual({
      build_id: "build-1",
      scenario_id: "broken-nginx",
      arch: "x86_64",
      rev: "abc123",
      content_hash: "f".repeat(64),
      bundle_ref: "builds/bundles/abc123.tar.gz",
      kino_version: "1.2.3",
    });
  });

  it("detects disconnected builders after the reassignment deadline", () => {
    const now = 10_000_000;
    expect(
      isDisconnectedPastDeadline(
        {
          connected: false,
          disconnectedAt: now - BUILDER_REASSIGN_AFTER_MS,
        },
        now,
      ),
    ).toBe(true);
    expect(
      isDisconnectedPastDeadline(
        {
          connected: false,
          disconnectedAt: now - BUILDER_REASSIGN_AFTER_MS + 1,
        },
        now,
      ),
    ).toBe(false);
    expect(
      isDisconnectedPastDeadline(
        {
          connected: true,
          disconnectedAt: now - BUILDER_REASSIGN_AFTER_MS,
        },
        now,
      ),
    ).toBe(false);
  });

  it("detects silent building rows from last build report time", () => {
    const now = 10_000_000;
    expect(
      isSilentBuildingBuild(
        {
          status: "building",
          updatedAt: now,
          timingsJson: { lastReportAt: now - BUILD_REPORT_STALE_AFTER_MS },
        },
        now,
      ),
    ).toBe(true);
    expect(
      isSilentBuildingBuild(
        {
          status: "building",
          updatedAt: now - BUILD_REPORT_STALE_AFTER_MS,
          timingsJson: { lastReportAt: now - BUILD_REPORT_STALE_AFTER_MS + 1 },
        },
        now,
      ),
    ).toBe(false);
    expect(
      isSilentBuildingBuild(
        {
          status: "assigned",
          updatedAt: now - BUILD_REPORT_STALE_AFTER_MS,
          timingsJson: {},
        },
        now,
      ),
    ).toBe(false);
  });
});

function builder(
  hostId: string,
  arch: "x86_64" | "aarch64",
  activeBuildCount: number,
  capacity: {
    cpuCount?: number;
    memoryAvailableMib?: number;
    diskAvailableMib?: number;
  } = {},
) {
  return {
    hostId,
    role: "builder" as const,
    arch,
    connected: true,
    disabled: false,
    activeBuildCount,
    capacity: {
      total_cpu_millis: (capacity.cpuCount ?? 4) * 1_000,
      reserved_cpu_millis: 0,
      schedulable_cpu_millis: (capacity.cpuCount ?? 4) * 1_000,
      committed_cpu_millis: 0,
      memory_total_mib: 16_384,
      memory_available_mib: capacity.memoryAvailableMib ?? 8_192,
      disk_probe_path: "/var/cache/intar-builder",
      disk_total_mib: 102_400,
      disk_available_mib: capacity.diskAvailableMib ?? 51_200,
    },
  };
}
