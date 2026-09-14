import { WorkerEntrypoint } from "cloudflare:workers";
import {
  CLEANUP_SCHEMA_VERSION,
  awaitRegistryIdle,
  holdRegistry,
  readCleanupGate,
  readLastCleanupRun,
  readMaintenance,
  readMode,
  releaseRegistryHold,
  runCleanup,
  type CleanupEnv,
} from "./cleanup";
import type {
  CleanupEnvelope,
  CleanupPauseRequest,
  CleanupPauseResult,
  CleanupRunRequest,
  CleanupStatusReport,
} from "./types";

export type * from "./types";

const MAX_PAUSE_WAIT_MS = 60 * 1000;

async function readStatus(env: CleanupEnv): Promise<CleanupStatusReport> {
  const nowMs = Date.now();
  const mode = readMode(env.REGISTRY_CLEANUP_MODE);
  const [maintenance, gate, lastRun] = await Promise.all([
    readMaintenance(env),
    readCleanupGate(env),
    readLastCleanupRun(env),
  ]);
  return {
    schemaVersion: CLEANUP_SCHEMA_VERSION,
    mode: mode.mode,
    modeValid: mode.valid,
    configuredMode: mode.configured,
    maintenance: maintenance.maintenance,
    maintenanceSource: maintenance.source,
    enforcement: gate.enforcement,
    sessionRequired: gate.sessionRequired,
    paused: gate.paused,
    pauseReason: gate.pauseReason,
    sweepActive: gate.sweepActive,
    running: gate.sweepActive,
    idle: !gate.sweepActive,
    activeSessions: gate.activeSessions,
    activeWriters: gate.activeWriters,
    lastRun,
    observedAtMs: nowMs,
  };
}

/**
 * The collector RPC surface.
 *
 * The collector publishes no route, so the control plane and the deployment
 * gate reach these methods through service bindings only.
 */
export class RegistryCleanup extends WorkerEntrypoint<CleanupEnv> {
  async status(): Promise<CleanupStatusReport> {
    return readStatus(this.env);
  }

  async plan(input?: CleanupRunRequest): Promise<CleanupEnvelope> {
    // A plan request always plans, whatever the caller passes.
    void input;
    return runCleanup(this.env, { source: "rpc", planOnly: true });
  }

  async run(input?: CleanupRunRequest): Promise<CleanupEnvelope> {
    return runCleanup(this.env, {
      source: "rpc",
      planOnly: input?.planOnly === true,
    });
  }

  /**
   * Hold the registry and wait for the active sweep to release it. A deployment
   * calls this before a migration and calls `resume` afterwards.
   */
  async pause(input?: CleanupPauseRequest): Promise<CleanupPauseResult> {
    const waitMs = clamp(input?.waitMs ?? 0, 0, MAX_PAUSE_WAIT_MS);
    await holdRegistry(this.env, input?.reason?.trim() || undefined);
    const idle = await awaitRegistryIdle(this.env, waitMs);
    log("registry_cleanup_pause", {
      waitMs,
      idle: idle.idle,
      stalled: idle.gate.sweepStalled,
    });
    return {
      paused: idle.gate.paused,
      pauseReason: idle.gate.pauseReason,
      idle: idle.idle,
      stalled: idle.gate.sweepStalled,
    };
  }

  async resume(): Promise<CleanupPauseResult> {
    const gate = await releaseRegistryHold(this.env);
    const idle = await awaitRegistryIdle(this.env, 0);
    log("registry_cleanup_resume", { sweepActive: idle.gate.sweepActive });
    return {
      paused: gate.paused,
      pauseReason: gate.pauseReason,
      idle: idle.idle,
      stalled: idle.gate.sweepStalled,
    };
  }
}

export default {
  /** The collector has no public surface. */
  async fetch(): Promise<Response> {
    return new Response("not found", { status: 404 });
  },

  async scheduled(
    _controller: ScheduledController,
    env: CleanupEnv,
    _ctx: ExecutionContext,
  ): Promise<void> {
    await runCleanup(env, { source: "scheduled" });
  },
} satisfies ExportedHandler<CleanupEnv>;

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(Math.max(Math.trunc(value), minimum), maximum);
}

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.info(JSON.stringify({ event, scope: "registry-cleanup", ...fields }));
}
