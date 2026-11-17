import type { OciSweepReport } from "@/lib/oci-registry-sweep";
import type { CleanupStatus } from "./types";

/**
 * The one place that turns a sweep report into a collector status.
 *
 * The sweep owns the completion rule and reports it as `completed`. The
 * collector does not restate that rule: it copies the verdict, and when the
 * verdict is not complete it only classifies the reason so a caller knows
 * whether to retry, to wait, or to treat the pass as failed.
 *
 *   any fault           -> core-failed (in either mode)
 *   report-only         -> report-only (a plan never completes)
 *   completed === true  -> ok          (the sweep proved the store finished)
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

/** Classifies why a pass did not complete. */
function incompleteStatus(error: string | null): CleanupStatus {
  const reason = typeof error === "string" ? error.trim() : "";
  if (!reason) return "pending";
  if (CLEANUP_CONTENTION_REASONS.includes(reason)) return "busy";
  if (CLEANUP_WITHHOLD_REASONS.includes(reason)) return "paused";
  if (reason.startsWith(ENFORCEMENT_REFUSAL_PREFIX)) return "paused";
  return "core-failed";
}

export function completionStatus(report: OciSweepReport): CleanupStatus {
  if (report.faults.length) return "core-failed";
  if (report.mode !== "delete") return "report-only";
  if (report.completed) return "ok";
  return incompleteStatus(report.error);
}
