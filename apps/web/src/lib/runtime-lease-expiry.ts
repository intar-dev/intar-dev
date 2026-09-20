import { env } from "cloudflare:workers";
import { archiveRuntimeExecution } from "@/lib/runtime-executions";
import { loadRunRow, updateRunState } from "@/lib/scenario-runs/storage";
import { revokeScenarioRunRoutes } from "@/lib/scenario-runs/start";

type ExpiredRuntimeExecutionRow = {
  execution_id: string;
  domain_kind: "scenario";
  domain_id: string;
  generation: number;
};

export interface RuntimeLeaseExpiryResult {
  expiredExecutionIds: string[];
  failedExecutionIds: string[];
}

/**
 * Finalizes expired executions even when teardown already marked desired VMs
 * absent. Lease expiry ends the run; it does not prove physical VM removal.
 */
export async function expireOverdueRuntimeExecutions(
  hostId: string,
  now: number,
): Promise<RuntimeLeaseExpiryResult> {
  const rows = await env.DB.prepare(
    `SELECT
       execution.id AS execution_id,
       execution.domain_kind,
       execution.domain_id,
       execution.generation
     FROM runtime_executions execution
     WHERE execution.host_id = ?
       AND execution.domain_kind = 'scenario'
       AND execution.lease_expires_at IS NOT NULL
       AND execution.lease_expires_at <= ?
       AND execution.state <> 'archived'
       AND NOT EXISTS (
         SELECT 1
         FROM runtime_executions newer
         WHERE newer.domain_kind = execution.domain_kind
           AND newer.domain_id = execution.domain_id
           AND newer.generation > execution.generation
       )
     ORDER BY execution.lease_expires_at ASC, execution.id ASC`,
  )
    .bind(hostId, now)
    .all<ExpiredRuntimeExecutionRow>();

  const expiredExecutionIds: string[] = [];
  const failedExecutionIds: string[] = [];
  for (const execution of rows.results) {
    try {
      const run = await loadRunRow(execution.domain_id);
      if (run) await revokeScenarioRunRoutes(run);
      if (run && !["completed", "failed"].includes(run.state.phase)) {
        // End the logical run without inventing a host absence observation.
        await updateRunState(run.runId, {
          mutate: (current) => ["completed", "failed"].includes(current.phase)
            ? current
            : {
                ...current,
                phase: "failed",
              },
          releaseActiveSlot: true,
        });
      }
      await archiveRuntimeExecution({
        executionId: execution.execution_id,
        expectedGeneration: execution.generation,
        endedAt: now,
      });

      expiredExecutionIds.push(execution.execution_id);
    } catch (error) {
      failedExecutionIds.push(execution.execution_id);
      console.warn(
        JSON.stringify({
          event: "runtime_lease_expiry_cleanup_failed",
          hostId,
          executionId: execution.execution_id,
          domainKind: execution.domain_kind,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  return { expiredExecutionIds, failedExecutionIds };
}
