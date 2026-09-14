import type {
  ImageRegistryCleanupPlan,
  ImageRegistryCleanupRunResult,
} from "@/lib/image-registry-cleanup";
import type { ImageRegistryEnforcementMode } from "@/db/schema";

/**
 * Request and response contract of the image registry cleanup worker.
 *
 * The parent control plane imports these types through the REGISTRY_CLEANUP
 * service binding, so this module stays runtime-free. The plan and the result
 * are the sweep core's own types: the collector adds no second copy of them.
 */

/** The collector changes nothing until an operator turns deletes on. */
export type CleanupMode = "report-only" | "delete";

export type CleanupStatus =
  | "ok"
  | "report-only"
  | "fenced"
  | "paused"
  | "busy"
  /** The pass did bounded work and needs another pass to finish. */
  | "pending"
  | "core-failed";

export type CleanupPlan = ImageRegistryCleanupPlan;
export type CleanupResult = ImageRegistryCleanupRunResult;

export interface CleanupEnvelope {
  schemaVersion: number;
  status: CleanupStatus;
  mode: CleanupMode;
  modeValid: boolean;
  maintenance: "on" | "off";
  maintenanceSource: "control-plane" | "unavailable";
  source: "scheduled" | "rpc";
  startedAtMs: number;
  finishedAtMs: number;
  plan: CleanupPlan | null;
  result: CleanupResult | null;
  error: string | null;
}

export interface CleanupRunRequest {
  /** List the candidates and stop, even in delete mode. */
  planOnly?: boolean;
}

export interface CleanupPauseRequest {
  /** Reason stored on the shared admission gate. */
  reason?: string;
  /** How long to wait for an active sweep to finish. */
  waitMs?: number;
}

export interface CleanupPauseResult {
  paused: boolean;
  pauseReason: string | null;
  /** True when no sweep holds the registry. */
  idle: boolean;
  /** True when a stalled sweep needs an operator decision. */
  stalled: boolean;
}

export interface CleanupStatusReport {
  schemaVersion: number;
  mode: CleanupMode;
  modeValid: boolean;
  configuredMode: string;
  maintenance: "on" | "off";
  maintenanceSource: "control-plane" | "unavailable";
  /** The shared admission row's enforcement, read live from D1. */
  enforcement: ImageRegistryEnforcementMode;
  /** True only when that enforcement requires an upload session. */
  sessionRequired: boolean;
  paused: boolean;
  pauseReason: string | null;
  sweepActive: boolean;
  /** True while a sweep of any isolate holds the registry. */
  running: boolean;
  idle: boolean;
  activeSessions: number;
  activeWriters: number;
  lastRun: CleanupLastRun | null;
  observedAtMs: number;
}

/** The most recent sweep row of the shared gc-run table. */
export interface CleanupLastRun {
  state: string;
  startedAtMs: number;
  finishedAtMs: number | null;
  scannedObjects: number;
  deletedObjects: number;
  blockedObjects: number;
  bytesReclaimed: number;
  error: string | null;
}
