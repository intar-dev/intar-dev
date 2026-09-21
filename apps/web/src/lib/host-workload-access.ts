import { currentRunHostScopeCondition } from "@/lib/metal-placement";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import type { HostDesiredStateV2 } from "@/generated/bridge";
import { markDesiredVmAbsent } from "@/lib/desired-state";
import { mutateStoredHostDesiredState } from "@/lib/desired-state-store";
import { currentScenarioRunContentAccessCondition } from "@/lib/scenario-runs/admission-guards";
import { destroyScenarioRunForUserWithDependencies } from "@/lib/scenario-runs/lifecycle";
import { revokeScenarioRunRoutes } from "@/lib/scenario-runs/start";
import { requestScenarioRunRouteCleanup } from "@/lib/scenario-runs/route-cleanup";

/** Also runs after hibernation/reconnect. A saved desired document is not an access grant. */
export async function enforceHostWorkloadAccess(state: HostDesiredStateV2): Promise<HostDesiredStateV2> {
  const { results } = await env.DB.prepare(`WITH permitted_runs AS MATERIALIZED (
    SELECT run.run_id, run.user_id, run.runtime_execution_id, run.organization_id,
      run.scenario_id, run.course_scope_key, run.course_id, run.lecture_id, run.request_scope_json
    FROM scenario_runs run JOIN user owner ON owner.id = run.user_id
    JOIN access_allowlist access ON access.user_id = owner.id AND access.state = 'active'
    WHERE ?2 = 1 AND run.host_id = ?1 AND owner.deleted_at IS NULL AND coalesce(owner.banned, 0) = 0
      AND run.delete_requested_at IS NULL AND run.route_cleanup_id IS NULL AND run.failed_at IS NULL AND run.completed_at IS NULL
      AND (${currentScenarioRunContentAccessCondition()}))
    SELECT 'allowed' AS kind, run.run_id, execution.id, execution.generation, execution.user_id, vm.runtime_vm_name
    FROM permitted_runs run JOIN runtime_executions execution ON execution.id = run.runtime_execution_id
    JOIN runtime_vms vm ON vm.execution_id = execution.id
    JOIN agent_hosts host ON host.id = execution.host_id
    WHERE host.id = ?1 AND host.disabled = 0 AND execution.domain_id = run.run_id
      AND execution.user_id = run.user_id AND execution.state IN ('queued','provisioning','ready')
      AND execution.archive_requested_at IS NULL
      AND ${currentRunHostScopeCondition()}
      AND NOT EXISTS (SELECT 1 FROM runtime_executions newer WHERE newer.domain_kind = execution.domain_kind
        AND newer.domain_id = execution.domain_id AND newer.generation > execution.generation)
    UNION ALL
    SELECT 'cleanup' AS kind, run_id, NULL, NULL, user_id, NULL
    FROM scenario_runs WHERE host_id = ?1 AND (route_cleanup_id IS NOT NULL
      OR (delete_requested_at IS NOT NULL AND active_key IS NOT NULL))`)
    .bind(state.host_id, state.vms.some(vm => vm.desired_phase === "running") ? 1 : 0)
    .all<{ kind: "allowed" | "cleanup"; run_id: string; id: string | null; generation: number | null; user_id: string; runtime_vm_name: string | null }>();
  const allowed = new Set(results.filter(row => row.kind === "allowed")
    .map(row => JSON.stringify([row.run_id, row.id, row.generation, row.user_id, row.runtime_vm_name])));
  const pending = new Map(results.filter(row => row.kind === "cleanup").map(row => [row.run_id, row.user_id]));
  const denied = state.vms.filter(vm => vm.desired_phase === "running" &&
    !allowed.has(JSON.stringify([vm.run_id, vm.runtime_execution_id, vm.generation, vm.owner_user_id, vm.vm_name])));
  // Commit cleanup intent first. A restart after the absence write must still
  // find terminal runs whose active slot was already released.
  const newlyDenied = [...new Set(denied.map(vm => vm.run_id))].filter(runId => !pending.has(runId));
  for (const run of await requestScenarioRunRouteCleanup(state.host_id, newlyDenied)) pending.set(run.runId, run.userId);
  const deniedIdentities = new Set(denied.map(vm => JSON.stringify([vm.runtime_execution_id, vm.generation, vm.vm_name])));
  let next = denied.length ? await mutateStoredHostDesiredState(drizzle(env.DB), state.host_id, Date.now(), draft => {
    for (const vm of draft.vms) {
      if (deniedIdentities.has(JSON.stringify([vm.runtime_execution_id, vm.generation, vm.vm_name]))) vm.desired_phase = "absent";
    }
  }, state) : state;
  // Preserve the finite leases. The host can receive a stop even when route cleanup fails;
  // Stargate's short host grant also removes these targets on this dispatch.
  for (const [runId, userId] of pending) {
    try {
      await destroyScenarioRunForUserWithDependencies({ runId, userId }, {
        // Keep the returned dispatch document current, without loading the
        // same desired state again for each run. Absence preserves leases.
        markVmsAbsent: async input => {
          next = await mutateStoredHostDesiredState(drizzle(env.DB), state.host_id, input.nowUnixMs, draft => {
            for (const vm of input.vms) markDesiredVmAbsent(draft, { runId, vmName: vm.runtimeVmName });
          }, next);
        },
        revokeRoutes: revokeScenarioRunRoutes,
        // This is already inside the host dispatch lock. Waking it here
        // would wait for this dispatch to finish.
        wakeHostRuntime: async () => {},
      });
    } catch {
      console.warn(JSON.stringify({ event: "workload_access_route_cleanup_pending", hostId: state.host_id, runId }));
    }
  }
  // Destroy clears its cleanup ID only after success. Completed cleanup is
  // no longer selected, so later reports do no per-run reads, writes, or deletes.
  return next;
}
