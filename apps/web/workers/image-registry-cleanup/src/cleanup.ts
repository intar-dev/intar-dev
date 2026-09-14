import {
  REGISTRY_ADMISSION_KEY,
  REGISTRY_ADMISSION_PROTOCOL_VERSION,
  readRegistryAdmissionState,
} from "@/lib/image-registry-admission";
import {
  createImageRegistryCleanupCore,
  type ImageRegistryCleanupEnv,
} from "@/lib/image-registry-cleanup";
import type { CleanupLastRun } from "./types";
import type {
  CleanupEnvelope,
  CleanupMode,
  CleanupStatus,
} from "./types";
import { completionStatus } from "./completion";

export const CLEANUP_SCHEMA_VERSION = 1;
export const DEFAULT_CLEANUP_MODE: CleanupMode = "report-only";
/** Marks the hold row as the collector's own deployment hold. */
export const CLEANUP_PAUSE_REASON = "registry_cleanup_hold";
const CLEANUP_IDLE_POLL_MS = 250;

/** Everything the collector reads, plus the parent entrypoint binding. */
export interface CleanupEnv extends ImageRegistryCleanupEnv {
  REGISTRY_CLEANUP_MODE?: string;
  CONTROL_PLANE?: unknown;
}

/** The parent `MaintenanceState` entrypoint, bound as CONTROL_PLANE. */
interface MaintenanceStateBinding {
  state(): Promise<{ maintenance?: unknown }>;
}

export interface MaintenanceRead {
  maintenance: "on" | "off";
  source: "control-plane" | "unavailable";
}

export interface ModeRead {
  mode: CleanupMode;
  configured: string;
  valid: boolean;
}

/** The shared admission gate, as the collector reads it. */
export interface CleanupGate {
  paused: boolean;
  pauseReason: string | null;
  sweepActive: boolean;
  /** A sweep whose heartbeat stopped. Only an operator resolves it. */
  sweepStalled: boolean;
  activeSessions: number;
  activeWriters: number;
}

/**
 * Read the live maintenance flag from the parent version that serves traffic.
 * A copy of the variable in this worker would drift during a maintenance
 * deployment, and every failure path answers `on`: a collector that cannot
 * prove the control plane is open must not delete.
 */
export async function readMaintenance(
  env: CleanupEnv,
): Promise<MaintenanceRead> {
  const binding = env.CONTROL_PLANE as MaintenanceStateBinding | undefined;
  if (!binding || typeof binding.state !== "function") {
    log("registry_cleanup_maintenance_probe_missing");
    return { maintenance: "on", source: "unavailable" };
  }
  try {
    const state = await binding.state();
    return {
      maintenance: state?.maintenance === "off" ? "off" : "on",
      source: "control-plane",
    };
  } catch (error) {
    log("registry_cleanup_maintenance_probe_failed", {
      error: describeError(error),
    });
    return { maintenance: "on", source: "unavailable" };
  }
}

/** An absent or unreadable mode must not widen the collector's authority. */
export function readMode(value: unknown): ModeRead {
  const configured = typeof value === "string" ? value.trim() : "";
  if (configured === "report-only" || configured === "delete") {
    return { mode: configured, configured, valid: true };
  }
  return { mode: DEFAULT_CLEANUP_MODE, configured, valid: false };
}

export async function readCleanupGate(
  env: CleanupEnv,
): Promise<CleanupGate> {
  const state = await readRegistryAdmissionState(asAdmissionEnv(env));
  return {
    paused: state.paused,
    pauseReason: state.pauseReason,
    sweepActive: state.sweep.active,
    sweepStalled: state.sweep.stalled,
    activeSessions: state.counts.openSessions,
    activeWriters: state.counts.pendingWriters,
  };
}

/** The most recent sweep row of the shared gc-run table, if any. */
export async function readLastCleanupRun(
  env: CleanupEnv,
): Promise<CleanupLastRun | null> {
  const row = await env.DB.prepare(
    `SELECT state, started_at, finished_at, scanned_objects, deleted_objects,
            blocked_objects, bytes_reclaimed, error
       FROM image_registry_gc_runs
      ORDER BY started_at DESC
      LIMIT 1`,
  ).first<{
    state: string;
    started_at: number;
    finished_at: number | null;
    scanned_objects: number;
    deleted_objects: number;
    blocked_objects: number;
    bytes_reclaimed: number;
    error: string | null;
  }>();
  if (!row) return null;
  return {
    state: row.state,
    startedAtMs: row.started_at,
    finishedAtMs: row.finished_at,
    scannedObjects: row.scanned_objects,
    deletedObjects: row.deleted_objects,
    blockedObjects: row.blocked_objects,
    bytesReclaimed: row.bytes_reclaimed,
    error: row.error,
  };
}

/**
 * Hold the registry before a migration. The hold is a row in the shared gate,
 * so it also refuses a new upload session and every sweep of any isolate.
 */
export async function holdRegistry(
  env: CleanupEnv,
  reason: string = CLEANUP_PAUSE_REASON,
): Promise<CleanupGate> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO image_registry_admission
       (key, protocol_version, enforcement, epoch, state, paused_at, pause_reason,
        updated_at)
     VALUES (?1, ?2, 'report_only', 0, 'open', ?3, ?4, ?3)
     ON CONFLICT(key) DO UPDATE SET
       paused_at = excluded.paused_at,
       pause_reason = excluded.pause_reason,
       updated_at = excluded.updated_at`,
  )
    .bind(REGISTRY_ADMISSION_KEY, REGISTRY_ADMISSION_PROTOCOL_VERSION, now, reason)
    .run();
  return readCleanupGate(env);
}

export async function releaseRegistryHold(
  env: CleanupEnv,
): Promise<CleanupGate> {
  await env.DB.prepare(
    `UPDATE image_registry_admission
        SET paused_at = NULL, pause_reason = NULL, updated_at = ?1
      WHERE key = ?2`,
  )
    .bind(Date.now(), REGISTRY_ADMISSION_KEY)
    .run();
  return readCleanupGate(env);
}

/**
 * Wait until no sweep holds the registry, or until the deadline passes. Nothing
 * here can clear a stalled sweep: an expired heartbeat is diagnosis, not
 * release authority, so the caller reports it and an operator decides.
 */
export async function awaitRegistryIdle(
  env: CleanupEnv,
  waitMs: number,
  now: () => number = () => Date.now(),
): Promise<{ idle: boolean; gate: CleanupGate }> {
  const deadline = now() + Math.max(waitMs, 0);
  for (;;) {
    const gate = await readCleanupGate(env);
    if (!gate.sweepActive) return { idle: true, gate };
    if (now() >= deadline) return { idle: false, gate };
    await new Promise((resolve) => setTimeout(resolve, CLEANUP_IDLE_POLL_MS));
  }
}

/**
 * One cleanup attempt.
 *
 * The order is deliberate: the maintenance fence and the shared admission gate
 * are read before the first bucket call, and a report-only collector stops
 * after the plan. The sweep core owns the exclusive lease and re-reads it under
 * that lease, so a race here can only add a redundant refusal.
 *
 * A delete pass calls the core's `run` directly and never pre-plans: the core
 * builds and verifies its plan inside the sweep lease, so a plan before it
 * would scan the whole bucket a second time for no gain. That single scan is
 * why the plan of a delete pass is not returned; the pass reports the counters
 * the core recorded while it ran.
 */
export async function runCleanup(
  env: CleanupEnv,
  request: { source: "scheduled" | "rpc"; planOnly?: boolean },
): Promise<CleanupEnvelope> {
  const startedAtMs = Date.now();
  const mode = readMode(env.REGISTRY_CLEANUP_MODE);
  const maintenance = await readMaintenance(env);
  const gateway = { mode, maintenance };

  if (maintenance.maintenance === "on") {
    log("registry_cleanup_fenced", {
      source: request.source,
      maintenanceSource: maintenance.source,
    });
    return envelope(gateway, request, startedAtMs, { status: "fenced" });
  }

  const gate = await readCleanupGate(env);
  if (gate.paused) {
    log("registry_cleanup_held", {
      source: request.source,
      pauseReason: gate.pauseReason,
    });
    return envelope(gateway, request, startedAtMs, { status: "paused" });
  }
  if (gate.sweepActive) {
    log("registry_cleanup_busy", {
      source: request.source,
      stalled: gate.sweepStalled,
    });
    return envelope(gateway, request, startedAtMs, { status: "busy" });
  }

  const coreEnv: ImageRegistryCleanupEnv = {
    DB: env.DB,
    VM_IMAGE_REGISTRY_BUCKET: env.VM_IMAGE_REGISTRY_BUCKET,
  };
  // The core owns the exclusive sweep lease and re-reads it under that lease.
  const core = createImageRegistryCleanupCore({});
  const input = { mode: mode.mode, nowMs: startedAtMs };

  try {
    const planOnly =
      request.planOnly === true || mode.mode !== "delete";
    if (planOnly) {
      const plan = await core.plan(coreEnv, { ...input, mode: "report-only" });
      const reported = envelope(gateway, request, startedAtMs, {
        status: "report-only",
        plan,
      });
      log("registry_cleanup_finished", {
        source: request.source,
        status: reported.status,
        objectsScanned: plan.objectsScanned,
        candidateObjects: plan.candidateObjects.length,
        candidateTotal: plan.details.candidateTotal,
        candidateBytes: plan.candidateBytes,
        truncated: plan.truncated,
        faults: plan.details.faults.length,
        deletedObjects: 0,
      });
      return reported;
    }

    const result = await core.run(coreEnv, input);
    // The canonical mapping decides completion. A pass that is not `ok` never
    // claims success, whatever the core reported alongside it.
    const status = completionStatus(result);
    const finished = envelope(gateway, request, startedAtMs, {
      status,
      result,
      error: status === "ok" ? null : (result.error ?? null),
    });
    log("registry_cleanup_finished", {
      source: request.source,
      status: finished.status,
      objectsScanned: result.planSummary?.objectsScanned ?? 0,
      candidateTotal: result.planSummary?.candidateTotal ?? result.wouldDeleteObjects,
      candidateBytes: result.planSummary?.candidateBytes ?? result.wouldDeleteBytes,
      truncated: result.planSummary?.truncated ?? false,
      completed: result.completed,
      deletedObjects: result.deletedObjects,
      deletedBytes: result.deletedBytes,
      verifiedDeletedObjects: result.verifiedDeletedObjects,
      failedObjects: result.failedObjects,
      skippedObjects: result.skippedObjects,
      unverifiedObjects: result.unverifiedObjects,
      blockedObjects: result.blockedObjects,
      resumeRequired: result.resumeRequired,
      phases: result.phases,
      error: result.error,
    });
    return finished;
  } catch (error) {
    // A failed plan must not delete: the delete path is unreachable without it.
    log("registry_cleanup_failed", {
      source: request.source,
      error: describeError(error),
    });
    return envelope(gateway, request, startedAtMs, {
      status: "core-failed",
      error: describeError(error),
    });
  }
}

function envelope(
  gateway: { mode: ModeRead; maintenance: MaintenanceRead },
  request: { source: "scheduled" | "rpc" },
  startedAtMs: number,
  fields: Partial<CleanupEnvelope> & { status: CleanupStatus },
): CleanupEnvelope {
  return {
    schemaVersion: CLEANUP_SCHEMA_VERSION,
    mode: gateway.mode.mode,
    modeValid: gateway.mode.valid,
    maintenance: gateway.maintenance.maintenance,
    maintenanceSource: gateway.maintenance.source,
    source: request.source,
    startedAtMs,
    finishedAtMs: Date.now(),
    plan: null,
    result: null,
    error: null,
    ...fields,
  };
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.info(JSON.stringify({ event, scope: "registry-cleanup", ...fields }));
}

/** The admission helpers accept the parent environment shape. */
function asAdmissionEnv(env: CleanupEnv): Cloudflare.Env {
  return env as unknown as Cloudflare.Env;
}
