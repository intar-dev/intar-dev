import type { ImageRegistryEnforcementMode } from "@/db/schema";
import type { OciSweepReport } from "@/lib/oci-registry-sweep";

/**
 * Request and response contract of the image registry cleanup worker.
 *
 * The parent control plane imports these types through the REGISTRY_CLEANUP
 * service binding, so this module stays runtime-free. The result is the OCI
 * sweep's own report: the collector adds no second copy of it.
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
  /**
   * The OCI sweep's report, a plan or a delete pass by its `mode`. Null when
   * the fence, the hold or another sweep stopped the invocation before it.
   */
  result: OciSweepReport | null;
  error: string | null;
}

export interface CleanupRunRequest {
  /** List the candidates and stop, even in delete mode. */
  planOnly?: boolean;
  /**
   * A plan of the OCI store starts after this hex, "" for the start; its
   * report's `nextStartAfter` names the next window, null after the last.
   * Absent, it plans the window the next delete pass would.
   */
  ociStartAfter?: string;
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
