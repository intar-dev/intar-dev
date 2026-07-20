import { env } from "cloudflare:workers";
import { archiveRuntimeExecution } from "@/lib/runtime-executions";
import { loadRunRow } from "@/lib/scenario-runs/storage";
import { revokeScenarioRunRoutes } from "@/lib/scenario-runs/start";
import { recordWorkshopGenerationState } from "@/lib/workshops/provisioning";
import {
  markRuntimeExecutionDesiredAbsent,
  revokeWorkshopWorkspaceRoutes,
} from "@/lib/workshops/runtime-orchestrator";

type ExpiredRuntimeExecutionRow = {
  execution_id: string;
  domain_kind: "scenario" | "workshop";
  domain_id: string;
  generation: number;
  workshop_generation_id: string | null;
  terminal_route_usernames_json: string | string[] | null;
  application_route_ids_json: string | string[] | null;
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
       execution.generation,
       generation.id AS workshop_generation_id,
       workspace.terminal_route_usernames_json,
       workspace.application_route_ids_json
     FROM runtime_executions execution
     LEFT JOIN workshop_workspace_generations generation
       ON execution.domain_kind = 'workshop'
      AND generation.runtime_execution_id = execution.id
      AND generation.ordinal = execution.generation
     LEFT JOIN workshop_workspaces workspace
       ON execution.domain_kind = 'workshop'
      AND workspace.id = execution.domain_id
     WHERE execution.host_id = ?
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
      if (execution.domain_kind === "scenario") {
        const run = await loadRunRow(execution.domain_id);
        if (run) await revokeScenarioRunRoutes(run);
      } else {
        await revokeWorkshopWorkspaceRoutes({
          workspaceId: execution.domain_id,
          terminalRouteUsernames: jsonStrings(
            execution.terminal_route_usernames_json,
          ),
          applicationRouteIds: jsonStrings(
            execution.application_route_ids_json,
          ),
          now,
        });
        if (execution.workshop_generation_id) {
          await recordWorkshopGenerationState({
            generationId: execution.workshop_generation_id,
            update: {
              state: "archiving",
              runtimeExecutionId: execution.execution_id,
              observedAt: now,
            },
          });
        }
      }

      await markRuntimeExecutionDesiredAbsent(execution.execution_id, now);
      await archiveRuntimeExecution({
        executionId: execution.execution_id,
        expectedGeneration: execution.generation,
        endedAt: now,
      });

      if (
        execution.domain_kind === "workshop" &&
        execution.workshop_generation_id
      ) {
        await recordWorkshopGenerationState({
          generationId: execution.workshop_generation_id,
          update: {
            state: "archived",
            runtimeExecutionId: execution.execution_id,
            observedAt: now,
          },
        });
      }
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

function jsonStrings(value: string | string[] | null): string[] {
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === "string");
  }
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}
