import type { ImageArchitecture } from "@/generated/catalog";
import type { ImageBuildStatus, ImageBuildTimings } from "@/db/schema";
import { canRetryImageBuild } from "@/lib/build-scheduler-core";

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
  hostRole: "agent" | "builder" | null;
  hostConnected: boolean | null;
  hostLastHeartbeatAt: number | null;
  bundleMeta: unknown;
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
  };
}
