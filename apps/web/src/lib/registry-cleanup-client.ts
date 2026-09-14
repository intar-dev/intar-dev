import type { CleanupEnvelope } from "../../workers/image-registry-cleanup/src/types";
import type { RegistryCleanup } from "../../workers/image-registry-cleanup/src/worker";

export type {
  CleanupEnvelope,
  CleanupRunRequest,
  CleanupStatusReport,
} from "../../workers/image-registry-cleanup/src/types";

/**
 * Client for the registry cleanup child worker.
 *
 * The collector publishes no route: the parent reaches it through the
 * REGISTRY_CLEANUP service binding and the typed RegistryCleanup entrypoint.
 * Promotion must not report success before the collector has finished, so the
 * run is awaited. A collector that is busy or that finished only a bounded part
 * of its worklist is retried inside the request budget, and a pass that never
 * becomes complete is reported as incomplete rather than as success.
 */

const CLEANUP_RUN_RETRY_MS = 1_000;
export const REGISTRY_CLEANUP_WAIT_BUDGET_MS = 20_000;

/**
 * The service-binding shape of the child RegistryCleanup entrypoint. The type
 * comes from the entrypoint itself, so a changed method signature is a compile
 * error here instead of a runtime surprise.
 */
export type RegistryCleanupServiceBinding = Pick<
  RegistryCleanup,
  "status" | "plan" | "run"
>;

export interface RegistryCleanupOutcome {
  /** True when the collector completed its pass for the configured mode. */
  ok: boolean;
  /** True only when the pass deleted objects. Report-only never applies. */
  applied: boolean;
  /**
   * True when the collector stopped before the worklist was finished, or left
   * objects it could not delete. A partial sweep is not a completed one.
   */
  partial: boolean;
  /** True when the collector asked for another pass to finish the worklist. */
  resumeRequired: boolean;
  /** Envelope status of the last attempt, or "unavailable". */
  status: CleanupEnvelope["status"] | "unavailable";
  deletedObjects: number;
  deletedBytes: number;
  failedObjects: number;
  candidates: number;
  truncated: boolean;
  error: string | null;
}

export function registryCleanupService(
  env: Cloudflare.Env,
): RegistryCleanupServiceBinding | null {
  const service = env.REGISTRY_CLEANUP as unknown as
    | RegistryCleanupServiceBinding
    | undefined;
  return service && typeof service.run === "function" ? service : null;
}

export async function runRegistryCleanup(
  service: RegistryCleanupServiceBinding,
  input: {
    planOnly?: boolean;
    waitBudgetMs?: number;
    nowUnixMs?: number;
  } = {},
): Promise<RegistryCleanupOutcome> {
  const waitBudgetMs = input.waitBudgetMs ?? REGISTRY_CLEANUP_WAIT_BUDGET_MS;
  const deadline = (input.nowUnixMs ?? Date.now()) + waitBudgetMs;

  for (;;) {
    let envelope: CleanupEnvelope;
    try {
      envelope = await service.run({
        planOnly: input.planOnly === true,
      });
    } catch (error) {
      return {
        ok: false,
        applied: false,
        partial: false,
        resumeRequired: false,
        status: "unavailable",
        deletedObjects: 0,
        deletedBytes: 0,
        failedObjects: 0,
        candidates: 0,
        truncated: false,
        error: error instanceof Error ? error.message : "cleanup run failed",
      };
    }

    const outcome = readCleanupEnvelope(envelope);
    if (outcome.ok || input.planOnly === true) return outcome;
    // `busy` is another actor holding the registry, and `pending` is a pass that
    // finished only its bounded share of the worklist. Both can complete on a
    // later attempt, so both are retried; the budget bounds the wait, and the
    // caller reads the incomplete answer when the budget runs out.
    if (!RETRYABLE_CLEANUP_STATUSES.has(outcome.status)) return outcome;
    if (Date.now() >= deadline) return outcome;
    await sleep(CLEANUP_RUN_RETRY_MS);
  }
}

/** Statuses that another attempt could turn into a completed pass. */
const RETRYABLE_CLEANUP_STATUSES: ReadonlySet<string> = new Set([
  "busy",
  "pending",
]);

export function readCleanupEnvelope(
  envelope: CleanupEnvelope,
): RegistryCleanupOutcome {
  return {
    // Only an applied pass is complete. A report-only pass deletes nothing, so
    // a caller that must wait for retired artifacts stays pending and strict;
    // the operator who chose report-only mode gets that answer, not a success.
    ok: envelope.status === "ok" && !partialSweep(envelope),
    applied: envelope.status === "ok",
    partial: partialSweep(envelope),
    status: envelope.status,
    resumeRequired: envelope.result?.resumeRequired === true,
    deletedObjects: envelope.result?.deletedObjects ?? 0,
    deletedBytes: envelope.result?.deletedBytes ?? 0,
    failedObjects: envelope.result?.failedObjects ?? 0,
    // A delete pass reports counters instead of a plan, so the candidate total
    // comes from whichever of the two the collector filled in.
    candidates:
      envelope.plan?.candidateObjects.length ??
      envelope.result?.wouldDeleteObjects ??
      0,
    truncated: envelope.plan?.truncated ?? false,
    error: envelope.error ?? cleanupIncompleteReason(envelope),
  };
}

/**
 * A sweep that failed objects, needed a resume, or reported an error has not
 * finished the worklist. The collector reports those on its run result.
 */
function partialSweep(envelope: CleanupEnvelope): boolean {
  const result = envelope.result;
  if (!result) return false;
  return (
    result.error !== null ||
    result.resumeRequired === true ||
    result.failedObjects > 0
  );
}

function cleanupIncompleteReason(envelope: CleanupEnvelope): string | null {
  switch (envelope.status) {
    case "report-only":
      return "registry cleanup is in report-only mode";
    case "busy":
      return "registry cleanup is already running";
    case "pending":
      return "registry cleanup has not finished its sweep worklist";
    case "paused":
      return "registry cleanup is paused";
    case "fenced":
      return "registry cleanup is fenced by maintenance";
    case "core-failed":
      return "registry cleanup failed";
    case "ok":
      return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
