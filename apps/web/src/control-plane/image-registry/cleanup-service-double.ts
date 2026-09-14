import {
  createImageRegistryCleanupCore,
  type ImageRegistryCleanupEnv,
} from "@/lib/image-registry-cleanup";
import type {
  CleanupEnvelope,
  CleanupStatusReport,
} from "../../../workers/image-registry-cleanup/src/worker";

/**
 * The collector RPC surface as the parent really reaches it.
 *
 * The double owns no retention or delete rule of its own: it calls the real
 * child cleanup core, so a promotion test exercises the same projection,
 * manifest verification, admission guard, and delete pass that production runs.
 * Only the transport and the configured mode are supplied here.
 */
export function createCleanupServiceDouble(
  env: ImageRegistryCleanupEnv,
  options: {
    mode?: "report-only" | "delete";
    modeValid?: boolean;
    paused?: boolean;
    running?: boolean;
    /** Observes the shared admission state exactly when the sweep starts. */
    onRun?: () => Promise<void>;
  } = {},
) {
  const mode = options.mode ?? "delete";
  const modeValid = options.modeValid ?? true;
  const paused = options.paused ?? false;
  const core = createImageRegistryCleanupCore({});

  function envelope(
    status: CleanupEnvelope["status"],
    plan: Awaited<ReturnType<typeof core.plan>> | null,
    result: Awaited<ReturnType<typeof core.run>> | null,
    error: string | null,
  ): CleanupEnvelope {
    return {
      schemaVersion: 1,
      status,
      mode,
      modeValid,
      maintenance: "off",
      maintenanceSource: "control-plane",
      source: "rpc",
      startedAtMs: Date.now(),
      finishedAtMs: Date.now(),
      // The child contract re-exports the real plan and result types, so the
      // pass-through keeps the double honest: no field is invented here.
      plan,
      result,
      error,
    };
  }

  return {
    async status(): Promise<CleanupStatusReport> {
      return {
        schemaVersion: 1,
        mode,
        modeValid,
        configuredMode: mode,
        maintenance: "off",
        maintenanceSource: "control-plane",
        paused,
        pauseReason: null,
        sweepActive: false,
        running: options.running ?? false,
        idle: true,
        activeSessions: 0,
        activeWriters: 0,
        lastRun: null,
        observedAtMs: Date.now(),
      };
    },
    async plan(): Promise<CleanupEnvelope> {
      const plan = await core.plan(env, { mode, nowMs: Date.now() });
      return envelope("report-only", plan, null, null);
    },
    async run(): Promise<CleanupEnvelope> {
      await options.onRun?.();
      const result = await core.run(env, {
        mode: paused || !modeValid ? "report-only" : mode,
        nowMs: Date.now(),
      });
      const status: CleanupEnvelope["status"] = paused
        ? "paused"
        : !modeValid || mode === "report-only"
          ? "report-only"
          : result.error
            ? "core-failed"
            : "ok";
      return envelope(status, null, result, result.error);
    },
  };
}
