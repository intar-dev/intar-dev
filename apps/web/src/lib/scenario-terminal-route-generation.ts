import { env } from "cloudflare:workers";
import { appError } from "@/lib/app-error";

export interface ScenarioTerminalRouteGeneration {
  executionId: string;
  generation: number;
  /** The opaque string both the create and the attach call send. */
  routeGeneration: string;
  userId: string;
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
 * Resolves the current runtime execution for one scenario run VM. Both the
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
      " execution.user_id AS user_id" +
      " FROM runtime_vms vm" +
      " INNER JOIN runtime_executions execution ON execution.id = vm.execution_id" +
      " WHERE execution.domain_kind = ?1" +
      " AND execution.domain_id = ?2" +
      " AND vm.vm_id = ?3" +
      " AND NOT EXISTS (" +
      "   SELECT 1 FROM runtime_executions newer" +
      "   WHERE newer.domain_kind = execution.domain_kind" +
      "     AND newer.domain_id = execution.domain_id" +
      "     AND newer.generation > execution.generation)" +
      " ORDER BY execution.generation DESC" +
      " LIMIT 1",
  )
    .bind("scenario", input.runId, input.vmId)
    .first<{ execution_id: string; generation: number; user_id: string }>();

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
  };
}
