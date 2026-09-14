import type { ImageRegistryCleanupRunResult } from "@/lib/image-registry-cleanup";
import type { CleanupStatus } from "./types";

/**
 * The one place that turns a sweep result into a collector status.
 *
 * The core owns the completion rule and reports it as `result.completed`. The
 * collector does not restate that rule: it copies the verdict, and when the
 * verdict is not complete it only classifies the reason so a caller knows
 * whether to retry, to wait, or to treat the pass as failed.
 *
 *   completed === true  -> ok          (the core proved the sweep finished)
 *   contention reason   -> busy        (another writer or sweep holds it)
 *   withholding reason  -> paused      (a hold or disabled enforcement)
 *   any other reason    -> core-failed (a fault stopped the sweep)
 *   no reason           -> pending     (bounded work; another pass finishes it)
 */

/**
 * Reasons that mean another actor holds the registry. A retry may succeed once
 * that actor releases it, so these are `busy` rather than a failure.
 */
export const CLEANUP_CONTENTION_REASONS: readonly string[] = [
  "registry admission is busy",
  "registry_admission_busy",
  "registry_admission_blocked",
  "registry_sweep_superseded",
  "registry_sweep_stalled",
  "registry_upload_session_open",
  "registry_write_unresolved",
];

/**
 * Reasons that mean the registry is not accepting deletes on purpose. A retry
 * changes nothing until an operator opens the gate, so these are `paused`.
 */
export const CLEANUP_WITHHOLD_REASONS: readonly string[] = [
  "registry_paused",
  "registry_enforcement_disabled",
  "registry admission did not allow deletion",
];

/** The enforcement refusal carries its observed mode, so it is matched by prefix. */
const ENFORCEMENT_REFUSAL_PREFIX = "registry admission enforcement is ";

export function completionStatus(
  result: ImageRegistryCleanupRunResult,
): CleanupStatus {
  // `completed` is the core's verdict, and the only signal that means a
  // finished sweep. Nothing else in the result may promote it to success.
  if (result.completed === true) return "ok";

  const reason = typeof result.error === "string" ? result.error.trim() : "";
  if (!reason) return "pending";
  if (CLEANUP_CONTENTION_REASONS.includes(reason)) return "busy";
  if (CLEANUP_WITHHOLD_REASONS.includes(reason)) return "paused";
  if (reason.startsWith(ENFORCEMENT_REFUSAL_PREFIX)) return "paused";
  return "core-failed";
}

/** True only for a pass the core proved complete. */
export function isAppliedCompletion(status: CleanupStatus): boolean {
  return status === "ok";
}
