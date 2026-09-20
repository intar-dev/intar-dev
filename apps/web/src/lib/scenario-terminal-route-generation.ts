import { env } from "cloudflare:workers";
import { appError } from "@/lib/app-error";

export interface ScenarioTerminalRouteGeneration {
  executionId: string;
  generation: number;
  /** The opaque string both the create and the attach call send. */
  routeGeneration: string;
  userId: string;
  hostId: string;
  hostCredentialGeneration: number;
}

/**
 * The gateway treats the route generation as an opaque string and compares it
 * as an exact value on the attach call. Deriving it from the current runtime
 * execution gives two properties:
 *
 * - the create call and the attach call agree on one value for one execution;
 * - a route from a replaced execution can not be revived, because a new
 *   execution has a different id or a higher generation integer.
 */
export function scenarioTerminalRouteGeneration(
  executionId: string,
  generation: number,
): string {
  return executionId + ":" + String(generation);
}

/**
 * Resolves an eligible current runtime execution for one scenario run VM. Both the
 * browser create path and the host-runtime attach path call this function, so
 * the generation string can not drift between them.
 */
export async function loadScenarioTerminalRouteGeneration(input: {
  runId: string;
  vmId: string;
}): Promise<ScenarioTerminalRouteGeneration> {
  const row = await env.DB.prepare(
    "SELECT" +
      " execution.id AS execution_id," +
      " execution.generation AS generation," +
      " execution.user_id AS user_id," +
      " execution.host_id AS host_id," +
      " host.credential_generation AS host_credential_generation" +
      " FROM runtime_vms vm" +
      " INNER JOIN runtime_executions execution ON execution.id = vm.execution_id" +
      " INNER JOIN agent_hosts host ON host.id = execution.host_id" +
      " INNER JOIN scenario_runs run ON run.run_id = execution.domain_id" +
      " WHERE execution.domain_kind = ?1" +
      " AND execution.domain_id = ?2" +
      " AND vm.vm_id = ?3" +
      " AND host.disabled = 0" +
      " AND host.credential_generation > 0" +
      " AND (host.scope = 'platform' OR (host.scope = 'personal' AND host.user_id = execution.user_id))" +
      " AND execution.state IN ('queued', 'provisioning', 'ready')" +
      " AND run.runtime_execution_id = execution.id" +
      " AND run.host_id = execution.host_id AND run.user_id = execution.user_id" +
      " AND run.delete_requested_at IS NULL" +
      " AND run.completed_at IS NULL AND run.failed_at IS NULL" +
      " AND NOT EXISTS (" +
      "   SELECT 1 FROM runtime_executions newer" +
      "   WHERE newer.domain_kind = execution.domain_kind" +
      "     AND newer.domain_id = execution.domain_id" +
      "     AND newer.generation > execution.generation)" +
      " ORDER BY execution.generation DESC" +
      " LIMIT 1",
  )
    .bind("scenario", input.runId, input.vmId)
    .first<{
      execution_id: string;
      generation: number;
      user_id: string;
      host_id: string;
      host_credential_generation: number;
    }>();

  if (!row) {
    throw appError(
      409,
      "scenario_terminal_target_unavailable",
      "the terminal target for this VM is not available yet",
    );
  }

  return {
    executionId: row.execution_id,
    generation: row.generation,
    routeGeneration: scenarioTerminalRouteGeneration(
      row.execution_id,
      row.generation,
    ),
    userId: row.user_id,
    hostId: row.host_id,
    hostCredentialGeneration: row.host_credential_generation,
  };
}
