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

/**
 * Normalized Worker/DB form of the generated CourseCatalogSnapshotV2 wire
 * contract. The generated contract stays snake_case at the bundle boundary;
 * this form is camelCase for the application and persisted JSON snapshot.
 */
export interface CourseCatalogLectureV2 {
  lectureId: string;
  title: string;
  summary: string;
  bodyMarkdown: string;
  category: string;
  tags: string[];
  difficulty?: "easy" | "medium" | "hard";
  estimatedMinutes: number;
  scenarioId?: string;
}

export interface CourseCatalogCourseV2 {
  courseId: string;
  title: string;
  summary: string;
  bodyMarkdown: string;
  sequential: boolean;
  lectures: CourseCatalogLectureV2[];
}

export interface CourseCatalogSnapshotV2 {
  version: 2;
  courses: CourseCatalogCourseV2[];
}

export interface ImageBuildBundleMeta {
  buildFormatVersion: string;
  catalogChannel?: "candidate" | "live";
  scenarios: Array<{
    scenarioId: string;
    arch: ImageArchitecture;
    contentHash: string;
  }>;
  courseCatalog?: CourseCatalogSnapshotV2;
  [key: string]: unknown;
}

export interface ImageBuildTimings {
  queuedAt?: number | null;
  startedAt?: number | null;
  finishedAt?: number | null;
  lastReportAt?: number | null;
}
