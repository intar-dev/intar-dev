import type {
  BuildPhase,
  DesiredBuildV1,
  HostCapacityV2,
} from "@/generated/bridge";
import type { ImageArchitecture } from "@/generated/catalog";
import type { ImageBuildStatus, ImageBuildTimings } from "@/db/schema";

export const BUILDER_REASSIGN_AFTER_MS = 10 * 60 * 1000;
export const BUILD_REPORT_STALE_AFTER_MS = 30 * 60 * 1000;

export interface BuilderCandidate {
  hostId: string;
  role: "agent" | "builder";
  arch: ImageArchitecture | null;
  connected: boolean;
  disabled: boolean;
  activeBuildCount: number;
  capacity: HostCapacityV2 | null;
}

export interface DesiredBuildSource {
  buildId: string;
  scenarioId: string;
  arch: ImageArchitecture;
  rev: string;
  contentHash: string;
  bundleRef: string;
}

export function buildStatusFromPhase(phase: BuildPhase): ImageBuildStatus {
  switch (phase) {
    case "queued":
      return "assigned";
    case "fetching_sources":
    case "building_base":
    case "building":
    case "publishing":
    case "uploading_logs":
      return "building";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
  }
}

export function isTerminalBuildPhase(phase: BuildPhase): boolean {
  return phase === "succeeded" || phase === "failed";
}

export function shouldAcceptBuildReport(input: {
  assignedHostId: string | null;
  assignedStatus: ImageBuildStatus;
  reportingHostId: string;
  reportHostId: string;
  assignedScenarioId: string;
  reportScenarioId: string;
  assignedContentHash: string;
  reportContentHash: string;
}): boolean {
  return (
    isBuildReportAcceptingStatus(input.assignedStatus) &&
    input.assignedHostId === input.reportingHostId &&
    input.reportHostId === input.reportingHostId &&
    input.assignedScenarioId === input.reportScenarioId &&
    input.assignedContentHash === input.reportContentHash
  );
}

function isBuildReportAcceptingStatus(status: ImageBuildStatus): boolean {
  return status === "assigned" || status === "building";
}

export function shouldSkipExistingBuildForBundle(
  status: ImageBuildStatus,
): boolean {
  return (
    status === "queued" ||
    status === "assigned" ||
    status === "building" ||
    status === "succeeded"
  );
}

export function canRetryImageBuild(status: ImageBuildStatus): boolean {
  return status === "failed" || status === "stale";
}

export function chooseLeastLoadedBuilder(
  candidates: BuilderCandidate[],
  arch: ImageArchitecture,
): BuilderCandidate | null {
  return (
    candidates
      .filter(
        (candidate) =>
          candidate.role === "builder" &&
          candidate.connected &&
          !candidate.disabled &&
          candidate.arch === arch,
      )
      .sort((left, right) => {
        const load = left.activeBuildCount - right.activeBuildCount;
        if (load !== 0) return load;
        const capacity = compareBuilderCapacity(left, right);
        if (capacity !== 0) return capacity;
        return left.hostId.localeCompare(right.hostId);
      })[0] ?? null
  );
}

function compareBuilderCapacity(
  left: BuilderCandidate,
  right: BuilderCandidate,
): number {
  const leftCapacity = left.capacity;
  const rightCapacity = right.capacity;
  const metrics = [
    (rightCapacity?.schedulable_cpu_millis ?? 0) -
      (leftCapacity?.schedulable_cpu_millis ?? 0),
    (rightCapacity?.memory_available_mib ?? 0) -
      (leftCapacity?.memory_available_mib ?? 0),
    (rightCapacity?.disk_available_mib ?? 0) -
      (leftCapacity?.disk_available_mib ?? 0),
  ];
  return metrics.find((value) => value !== 0) ?? 0;
}

export function desiredBuildFromSource(
  source: DesiredBuildSource,
): DesiredBuildV1 {
  return {
    build_id: source.buildId,
    scenario_id: source.scenarioId,
    arch: source.arch,
    rev: source.rev,
    content_hash: source.contentHash,
    bundle_ref: source.bundleRef,
  };
}

export function isDisconnectedPastDeadline(
  input: {
    connected: boolean;
    disconnectedAt: number | null;
  },
  nowUnixMs: number,
): boolean {
  return (
    !input.connected &&
    input.disconnectedAt !== null &&
    input.disconnectedAt <= nowUnixMs - BUILDER_REASSIGN_AFTER_MS
  );
}

export function isSilentBuildingBuild(
  input: {
    status: ImageBuildStatus;
    updatedAt: number;
    timingsJson: ImageBuildTimings;
  },
  nowUnixMs: number,
): boolean {
  if (input.status !== "building") {
    return false;
  }
  const lastReportAt = input.timingsJson.lastReportAt ?? input.updatedAt;
  return lastReportAt <= nowUnixMs - BUILD_REPORT_STALE_AFTER_MS;
}
