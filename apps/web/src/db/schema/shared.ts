import { sql } from "drizzle-orm";
import { text } from "drizzle-orm/sqlite-core";
import type { ImageArchitecture } from "@/generated/catalog";

export const nowMsDefault = sql`(cast(unixepoch('subsecond') * 1000 as integer))`;
export const jsonText = <T>(name: string) =>
  text(name, { mode: "json" }).$type<T>();

export interface ScenarioRunHintSnapshot {
  key: string;
  scope: "scenario" | "probe";
  probeName: string | null;
  id: string;
  title: string | null;
  bodyMarkdown: string;
}

export type AgentHostRole = "agent" | "builder";
export type HostCpuReservationState = "pending" | "committed";
export type HostCpuReservationQuotaPhase = "boot" | "steady";
export type ImageBuildStatus =
  | "queued"
  | "assigned"
  | "building"
  | "succeeded"
  | "failed"
  | "stale";

export interface ScenarioCourseCatalogCourse {
  courseId: string;
  title: string;
  description: string;
  scenarioIds: string[];
}

export interface ScenarioCourseCatalogSnapshotV1 {
  version: 1;
  mode: "replace";
  courses: ScenarioCourseCatalogCourse[];
}

export interface ImageBuildBundleMeta {
  buildFormatVersion: string;
  catalogChannel?: "candidate" | "live";
  scenarios: Array<{
    scenarioId: string;
    arch: ImageArchitecture;
    contentHash: string;
  }>;
  courseCatalog?: ScenarioCourseCatalogSnapshotV1;
  [key: string]: unknown;
}

export interface ImageBuildTimings {
  queuedAt?: number | null;
  startedAt?: number | null;
  finishedAt?: number | null;
  lastReportAt?: number | null;
}
