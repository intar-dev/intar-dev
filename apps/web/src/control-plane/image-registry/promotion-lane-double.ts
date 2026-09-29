import {
  REGISTRY_CLEANUP_WAIT_BUDGET_MS,
  runRegistryCleanup,
} from "@/lib/registry-cleanup-client";
import { admitInternalRegistryOperation } from "@/lib/image-registry-admission";
import { promoteDrainedRevision, type PromotionFence } from "./catalog-promotion";
import { jsonResponse } from "./shared";

/**
 * A drained promotion followed by its registry cleanup, answered the way the
 * retired image-ops HTTP lane answered, for the tests that pin the core and
 * the cleanup through those answers. Production runs the same two steps as
 * separate phases of Intar's promotion (image-promotion.ts); the caller of
 * this double has proven the drain.
 */
export async function promoteThroughDrainedLane(
  env: Cloudflare.Env,
  revision: string,
  options: { fence?: PromotionFence } = {},
): Promise<Response> {
  const result = await promoteDrainedRevision(env, revision, {
    admit: async () => {
      const admitted = await admitInternalRegistryOperation(env, {
        operation: "pointer_mutation",
        owner: { kind: "system", id: "image-promotion" },
      });
      return admitted.ok
        ? admitted
        : {
            ok: false,
            response: jsonResponse(
              { error: `the registry refused a writer: ${admitted.reason}`, code: admitted.reason },
              503,
            ),
          };
    },
    ...(options.fence ? { fence: options.fence } : {}),
  });
  if (!result.ok) return result.response ?? jsonResponse(result.body, result.status);
  const { outcome: promoted, cleanupService, nowUnixMs: now } = result;
  if (promoted.failedHostIds.length > 0) {
    return jsonResponse(
      {
        error: "catalog promoted but host desired-state reconciliation failed",
        failed_host_ids: promoted.failedHostIds,
      },
      503,
    );
  }
  const cleanup = await runRegistryCleanup(cleanupService, {
    nowUnixMs: now,
    waitBudgetMs: REGISTRY_CLEANUP_WAIT_BUDGET_MS,
  });
  // Only a pass that applied deletions and finished its worklist completes
  // the promotion; any other leaves the deletion half pending and says so.
  if (!cleanup.applied || cleanup.partial) {
    return jsonResponse(
      {
        error:
          cleanup.error ??
          (cleanup.partial
            ? "registry artifacts are not deleted yet: the sweep did not finish"
            : "registry artifacts are not deleted yet: cleanup did not apply"),
        catalog_promoted: true,
        retry: true,
        cleanup: cleanupPayload(cleanup),
      },
      503,
    );
  }
  return jsonResponse({
    ok: true,
    revision,
    scenario_ids: promoted.scenarioIds,
    changed_host_ids: promoted.changedHostIds,
    rollback_snapshot_retained: promoted.rollbackSnapshotRetained,
    retried: promoted.alreadyPromoted,
    evicted_host_ids: promoted.evictedHostIds,
    cleanup: cleanupPayload(cleanup),
  });
}

/**
 * A report-only or failed pass is not completed retention: the caller must
 * treat the deletion half of the promotion as pending, not as done.
 */
function cleanupPayload(cleanup: {
  ok: boolean;
  applied: boolean;
  partial: boolean;
  status: string;
  deletedObjects: number;
  deletedBytes: number;
  failedObjects: number;
  candidates: number;
  truncated: boolean;
}) {
  return {
    state: cleanup.status,
    applied: cleanup.applied,
    partial: cleanup.partial,
    pending: !cleanup.applied,
    deleted_objects: cleanup.deletedObjects,
    deleted_bytes: cleanup.deletedBytes,
    failed_objects: cleanup.failedObjects,
    candidate_objects: cleanup.candidates,
    truncated: cleanup.truncated,
  };
}
