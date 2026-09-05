import type { ImageArchitecture } from "@/generated/catalog";
import type { ImageBuildStatus, ImageBuildTimings } from "@/db/schema";
import { canRetryImageBuild } from "@/lib/build-scheduler-core";
import { IMAGE_BUILD_FORMAT_VERSION } from "@/lib/image-build-format";

const ADMIN_BUILD_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export interface AdminBuildResponseRow {
  id: string;
  scenarioId: string;
  arch: ImageArchitecture;
  rev: string;
  contentHash: string;
  hostId: string | null;
  hostName: string | null;
  status: ImageBuildStatus;
  phase: string;
  attempt: number;
  error: string | null;
  logR2Key: string | null;
  timings: ImageBuildTimings;
  bundleR2Key: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AdminBuildDetailResponseRow extends AdminBuildResponseRow {
  organizationId: string | null;
  bundleOrganizationId: string | null;
  hostRole: "agent" | "builder" | null;
  hostConnected: boolean | null;
  hostLastHeartbeatAt: number | null;
  bundleMeta: unknown;
  candidateProof: AdminCandidateProof | null;
}

export interface AdminCandidateProof {
  revision: string;
  buildId: string;
}

export interface AdminCandidateProofCandidate {
  revision: string;
  buildId: string;
  organizationId: string | null;
  bundleOrganizationId: string | null;
  bundleMeta: unknown;
  updatedAt: number;
}

export function isSafeAdminBuildId(value: string): boolean {
  return value !== "." && value !== ".." && ADMIN_BUILD_ID_RE.test(value);
}

export function serializeAdminBuildSummary(row: AdminBuildResponseRow) {
  return {
    id: row.id,
    scenarioId: row.scenarioId,
    arch: row.arch,
    rev: row.rev,
    contentHash: row.contentHash,
    hostId: row.hostId,
    hostName: row.hostName,
    status: row.status,
    phase: row.phase,
    attempt: row.attempt,
    error: row.error,
    canRetry: canRetryImageBuild(row.status, row.error),
    hasLog: Boolean(row.logR2Key),
    timings: row.timings,
    bundleR2Key: row.bundleR2Key,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function serializeAdminBuildDetail(row: AdminBuildDetailResponseRow) {
  return {
    ...serializeAdminBuildSummary(row),
    organizationId: row.organizationId,
    host: row.hostId
      ? {
          id: row.hostId,
          name: row.hostName,
          role: row.hostRole,
          connected: row.hostConnected,
          lastHeartbeatAt: row.hostLastHeartbeatAt,
        }
      : null,
    bundle: {
      rev: row.rev,
      r2Key: row.bundleR2Key,
      meta: row.bundleMeta,
    },
    candidateAvailable: row.candidateProof !== null,
    candidateProof: row.candidateProof,
  };
}

export function selectAdminCandidateProof(input: {
  build: Pick<
    AdminBuildDetailResponseRow,
    | "id"
    | "scenarioId"
    | "arch"
    | "contentHash"
    | "organizationId"
    | "bundleOrganizationId"
    | "bundleMeta"
    | "status"
  >;
  candidates: AdminCandidateProofCandidate[];
}): AdminCandidateProof | null {
  if (
    input.build.status !== "succeeded" ||
    input.build.organizationId !== input.build.bundleOrganizationId ||
    !hasExactBundleScenario(input.build.bundleMeta, {
      scenarioId: input.build.scenarioId,
      arch: input.build.arch,
      contentHash: input.build.contentHash,
      requireCandidateChannel: false,
    })
  ) {
    return null;
  }

  const candidate = input.candidates
    .filter(
      (value) =>
        value.buildId === input.build.id &&
        value.organizationId === input.build.organizationId &&
        value.bundleOrganizationId === input.build.organizationId &&
        hasExactBundleScenario(value.bundleMeta, {
          scenarioId: input.build.scenarioId,
          arch: input.build.arch,
          contentHash: input.build.contentHash,
          requireCandidateChannel: true,
        }),
    )
    .sort(
      (left, right) =>
        right.updatedAt - left.updatedAt ||
        left.revision.localeCompare(right.revision),
    )[0];
  return candidate
    ? { revision: candidate.revision, buildId: candidate.buildId }
    : null;
}

function hasExactBundleScenario(
  value: unknown,
  input: {
    scenarioId: string;
    arch: ImageArchitecture;
    contentHash: string;
    requireCandidateChannel: boolean;
  },
): boolean {
  if (!isRecord(value) || !isCurrentBuildBundle(value)) return false;
  return (
    (!input.requireCandidateChannel || value.catalogChannel === "candidate") &&
    value.scenarios.some(
      (scenario) =>
        scenario.scenarioId === input.scenarioId &&
        scenario.arch === input.arch &&
        scenario.contentHash === input.contentHash,
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCurrentBuildBundle(
  value: Record<string, unknown>,
): value is {
  buildFormatVersion: string;
  catalogChannel?: "candidate" | "live";
  scenarios: Array<{
    scenarioId: string;
    arch: ImageArchitecture;
    contentHash: string;
  }>;
} {
  return (
    value.buildFormatVersion === IMAGE_BUILD_FORMAT_VERSION &&
    Array.isArray(value.scenarios) &&
    value.scenarios.every(
      (scenario) =>
        typeof scenario === "object" &&
        scenario !== null &&
        !Array.isArray(scenario) &&
        typeof scenario.scenarioId === "string" &&
        (scenario.arch === "x86_64" || scenario.arch === "aarch64") &&
        typeof scenario.contentHash === "string",
    )
  );
}
