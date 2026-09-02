import { env } from "cloudflare:workers";
import { archiveRuntimeExecution } from "@/lib/runtime-executions";
import { loadRunRow } from "@/lib/scenario-runs/storage";
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
 * Completes the domain-neutral half of lease expiry. Scenario expiry still
 * projects its learner-facing failure before this runs; this function revokes
 * access and releases the shared execution, slot, and capacity reservation for
 * both domains. Current-generation guards make retries safe.
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
