import { loadStargateSshTransport } from "@/lib/stargate-relay";
import { env } from "cloudflare:workers";
import { issueAccountFencedRoute } from "@/lib/account-route-issuance";
import { parseRunState } from "@/lib/scenario-runs/storage";
import { buildRunVmRouteUsername } from "@/lib/scenario-runs/start";
import { runPhaseAcceptsTerminalSessions } from "@/lib/run-state";
import { loadRuntimeVmAccessKey } from "@/lib/runtime-vm-state";
import { scenarioTerminalRouteGeneration } from "@/lib/scenario-terminal-route-generation";
import {
  StargateTerminalAttachError,
  activateStargateTerminalTarget,
  deleteStargateTerminalRoute,
  stageStargateTerminalTarget,
} from "@/lib/stargate";

export type ScenarioTerminalAttachOutcome = "attached" | "not_ready";

/**
 * A target is pending until the gateway accepted exactly this observation.
 * terminal_observed_at moves when the agent reports a new guest endpoint, so a
 * replaced endpoint is attached again rather than reusing a stale target.
 */
const PENDING_TARGET_PREDICATE =
  "(vm.terminal_attached_at IS NULL" +
  " OR vm.terminal_attached_at <> vm.terminal_observed_at)";

interface PendingScenarioTerminalTargetRow {
  execution_id: string;
  generation: number;
  user_id: string;
  host_id: string;
  run_id: string;
  active_session_id: string | null;
  vm_id: string;
  state_json: string;
  terminal_observed_at: number;
  terminal_host: string;
  terminal_port: number;
  terminal_username: string | null;
  terminal_host_key_openssh: string;
}

/**
 * Attaches the ready terminal target of one scenario VM to its pending
 * browser route, then marks the target as attached.
 *
 * The durable work marker is the runtime mirror row itself: the target is in
 * D1 with `terminal_attached_at` null (or older than the observation) before
 * any attach is sent, and the marker moves only after the gateway accepts the
 * target. A crash between the two steps therefore leaves the work pending for
 * the next reconcile pass. The gateway attach is idempotent (204 for the
 * first call and for an identical repeat), so a repeat call is safe.
 *
 * Ownership is checked before a credential leaves D1:
 *
 * - the VM must belong to the current generation of the run;
 * - the run row must belong to the expected user and host;
 * - the run must still accept terminal sessions.
 *
 * The attach has two phases, and only the second one can produce a shell:
 *
 * 1. STAGE the ready target under the account fence. The fence confirms the
 *    account is active before the stage and re-reads it after, and the staged
 *    target is inert: the gateway opens no PTY and wakes no socket.
 * 2. ACTIVATE the staged attachment, but only after a fresh ownership read
 *    still matches this run, generation, host session, and observation. The
 *    gateway opens the PTY and wakes the socket only on activation.
 *
 * That ordering is the whole point: the browser can not receive a usable shell
 * until the account fence has already confirmed the account, so a revoked
 * learner never gets a live shell during the confirmation window.
 *
 * The durable `terminal_attached_at` marker is written only after activation
 * succeeds. A crash between the two phases leaves an inert staged attachment
 * that no later pass can activate, because the attachment id is never stored.
 * Every ambiguous activation outcome revokes this generation's route.
 */
export async function attachReadyScenarioTerminalTargets(input: {
  executionId: string;
  expectedGeneration: number;
  expectedUserId: string;
  hostId: string;
  runId: string;
  vmId: string;
  /**
   * The active agent session of the host. When supplied, the attach is
   * refused unless that session is still the active one.
   */
  expectedHostSessionId?: string;
  /**
   * Attach the current ready target even when the marker already names it.
   * Set only when the route was just created: a fresh route is always
   * unattached, and the marker can be stale after a revoke and a reconnect.
   */
  force?: boolean;
}): Promise<ScenarioTerminalAttachOutcome> {
  const outcome = await loadPendingTarget(input);
  if (outcome.kind === "not_ready") {
    return "not_ready";
  }
  const row = outcome.row;
  const routeUsername = buildRunVmRouteUsername(
    input.runId,
    parseRunState(row.state_json).vms,
    input.vmId,
    "browser",
  );

  const accessKey = await loadRuntimeVmAccessKey({
    executionId: row.execution_id,
    expectedGeneration: row.generation,
    vmId: input.vmId,
  });

  const routeGeneration = scenarioTerminalRouteGeneration(
    row.execution_id,
    row.generation,
  );
  // The revoke is generation-fenced, so a late cleanup after a reissue can not
  // delete the route that the same name now carries for a newer generation.
  const stageInput = {
    routeUsername,
    generation: routeGeneration,
    runId: input.runId,
    vmId: input.vmId,
    userId: input.expectedUserId,
    target: {
      username: row.terminal_username?.trim() || "ubuntu",
      transport: await loadStargateSshTransport({hostId: row.host_id, ownerId: row.user_id,
        executionId: row.execution_id, executionGeneration: row.generation, vmId: input.vmId,
        directHost: row.terminal_host, directPort: row.terminal_port}),
      hostKeyOpenssh: row.terminal_host_key_openssh,
      privateKeyOpenssh: accessKey.privateKeyOpenssh,
      authorizedClientPublicKeysOpenssh: [accessKey.publicKeyOpenssh],
    },
  };

  // Phase one. The fence returns an attachment id only after both the
  // pre-check and the post-check confirm the account is still active, so
  // reaching the next line already proves the learner was authorized after the
  // stage. Nothing is usable yet.
  const staged = await issueAccountFencedRoute({
    userId: input.expectedUserId,
    routeId: routeUsername,
    revoke: (routeId) =>
      deleteStargateTerminalRoute(routeId, routeGeneration),
    issuedRouteIds: () => [routeUsername],
    issue: () => stageStargateTerminalTarget(stageInput),
  });

  // Phase two. Activation wakes the socket, so it happens only while the
  // ownership facts that justified the stage are still true. This read is the
  // last barrier before a shell exists; it is not a second account fence,
  // because the fence above already ran on the far side of the stage.
  const confirmed = await loadPendingTarget(input);
  if (confirmed.kind === "not_ready") {
    // The target was attached or cleared by another attempt, or the run moved
    // on. The staged attachment stays inert.
    return "not_ready";
  }
  if (confirmed.row.terminal_observed_at !== row.terminal_observed_at) {
    // The guest reported again while the target was staged. This returns before
    // activation, so the staged attachment stays inert. The route is kept: a
    // report that only advances the observation must not delete a healthy
    // route's live socket.
    return "not_ready";
  }

  try {
    await activateStargateTerminalTarget({
      routeUsername,
      generation: routeGeneration,
      attachmentId: staged.attachmentId,
      runId: input.runId,
      vmId: input.vmId,
      userId: input.expectedUserId,
    });
  } catch (error) {
    // Activation is the step that creates a shell, so an unconfirmed outcome
    // is not retryable here: revoke this generation and fail closed.
    await deleteStargateTerminalRoute(routeUsername, routeGeneration);
    throw error;
  }

  // The durable marker means "a shell was activated for this observation".
  // It moves only after activation, so a crash before it leaves the work
  // pending and the next pass re-runs both phases.
  await markScenarioTerminalTargetAttached({
    executionId: row.execution_id,
    vmId: input.vmId,
    observedAt: row.terminal_observed_at,
    expectedGeneration: row.generation,
    ...(input.expectedHostSessionId === undefined
      ? {}
      : { expectedHostSessionId: input.expectedHostSessionId }),
  });
  return "attached";
}

/**
 * The marker clause is the one clause a freshly created route drops. Every
 * other clause is an ownership or readiness fence and is never optional, so
 * both selects are built from one body.
 */
function scenarioTerminalTargetSelect(markerClause: string): string {
  return (
  "SELECT" +
  " execution.id AS execution_id," +
  " execution.generation AS generation," +
  " execution.user_id AS user_id," +
  " execution.host_id AS host_id," +
  " execution.domain_id AS run_id," +
  " host.active_session_id AS active_session_id," +
  " vm.vm_id AS vm_id," +
  " run.state_json AS state_json," +
  " vm.terminal_observed_at," +
  " vm.terminal_host, vm.terminal_port, vm.terminal_username," +
  " vm.terminal_host_key_openssh" +
  " FROM runtime_vms vm" +
  " INNER JOIN runtime_executions execution ON execution.id = vm.execution_id" +
  " INNER JOIN scenario_runs run ON run.run_id = execution.domain_id" +
  " INNER JOIN agent_hosts host ON host.id = execution.host_id" +
  " WHERE execution.domain_kind = 'scenario'" +
  "   AND execution.state NOT IN ('archived', 'failed')" +
  "   AND run.delete_requested_at IS NULL" +
  "   AND run.completed_at IS NULL" +
  "   AND run.failed_at IS NULL" +
  "   AND vm.terminal_host IS NOT NULL" +
  "   AND vm.terminal_port IS NOT NULL" +
  "   AND vm.terminal_host_key_openssh IS NOT NULL" +
  "   AND vm.terminal_observed_at IS NOT NULL" +
  markerClause +
  "   AND NOT EXISTS (" +
  "     SELECT 1 FROM runtime_executions newer" +
  "     WHERE newer.domain_kind = execution.domain_kind" +
  "       AND newer.domain_id = execution.domain_id" +
  "       AND newer.generation > execution.generation)"
  );
}

/** Ready targets whose marker does not yet name the current observation. */
const PENDING_TARGET_SELECT = scenarioTerminalTargetSelect(
  "   AND " + PENDING_TARGET_PREDICATE,
);

/** The same fences without the marker test, for a freshly created route. */
const UNMARKED_TARGET_SELECT = scenarioTerminalTargetSelect("");

async function loadPendingTarget(input: {
  executionId: string;
  expectedGeneration: number;
  expectedUserId: string;
  hostId: string;
  runId: string;
  vmId: string;
  expectedHostSessionId?: string;
  force?: boolean;
}): Promise<
  | { kind: "not_ready" }
  | { kind: "pending"; row: PendingScenarioTerminalTargetRow }
> {
  // `force` drops only the marker test. Every ownership and readiness
  // fence below still applies, so a forced attach can not reach a stale or
  // foreign target.
  const row = await env.DB.prepare(
    (input.force ? UNMARKED_TARGET_SELECT : PENDING_TARGET_SELECT) +
      " AND run.run_id = ?1 AND vm.vm_id = ?2 LIMIT 1",
  )
    .bind(input.runId, input.vmId)
    .first<PendingScenarioTerminalTargetRow>();
  if (!row) {
    return { kind: "not_ready" };
  }
  if (
    row.execution_id !== input.executionId ||
    row.generation !== input.expectedGeneration ||
    row.user_id !== input.expectedUserId ||
    row.host_id !== input.hostId ||
    (input.expectedHostSessionId !== undefined &&
      row.active_session_id !== input.expectedHostSessionId)
  ) {
    throw scenarioTerminalAttachStale();
  }
  const vmState = parseRunState(row.state_json);
  if (!runPhaseAcceptsTerminalSessions(vmState.phase)) {
    return { kind: "not_ready" };
  }
  return { kind: "pending", row };
}

/**
 * Marks the target attached. The guard keeps a newer observation pending even
 * when two attaches race, because the late writer can not lower the marker
 * below the observation it belongs to.
 */
async function markScenarioTerminalTargetAttached(input: {
  executionId: string;
  vmId: string;
  observedAt: number;
  expectedGeneration: number;
  expectedHostSessionId?: string;
}): Promise<void> {
  // The marker moves to exactly the observation that was attached, and only
  // when that observation is still the current one. A guest report that lands
  // during the attach therefore keeps the row pending instead of being marked
  // attached by an older revision.
  await env.DB.prepare(
    "UPDATE runtime_vms" +
      " SET terminal_attached_at = ?1, updated_at = ?2" +
      " WHERE execution_id = ?3" +
      "   AND vm_id = ?4" +
      "   AND terminal_observed_at = ?1" +
      "   AND EXISTS (" +
      "     SELECT 1 FROM runtime_executions execution" +
      "     INNER JOIN agent_hosts host ON host.id = execution.host_id" +
      "     WHERE execution.id = runtime_vms.execution_id" +
      "       AND execution.domain_kind = 'scenario'" +
      "       AND execution.generation = ?5" +
      "       AND execution.state NOT IN ('archived', 'failed')" +
      "       AND (?6 IS NULL OR host.active_session_id = ?6)" +
      "       AND NOT EXISTS (" +
      "         SELECT 1 FROM runtime_executions newer" +
      "         WHERE newer.domain_kind = execution.domain_kind" +
      "           AND newer.domain_id = execution.domain_id" +
      "           AND newer.generation > execution.generation))",
  )
    .bind(
      input.observedAt,
      Date.now(),
      input.executionId,
      input.vmId,
      input.expectedGeneration,
      input.expectedHostSessionId ?? null,
    )
    .run();
}

/**
 * Re-sends the attach for every pending browser route of one host. The call
 * site is the existing host reconcile path, so an attach that was lost to a
 * transient failure or a crash is delivered by the next pass.
 *
 * A route that does not exist yet, or that was revoked, is not an error: the
 * marker stays pending and the next pass retries.
 */
export async function reconcileScenarioTerminalRouteAttachments(input: {
  hostId: string;
  limit?: number;
}): Promise<{ attempted: number; attached: number }> {
  // This function never throws: its caller is the host reconcile path, and a
  // raw error message can echo an attach request that carried a credential.
  let rows: { results?: PendingScenarioTerminalTargetRow[] };
  try {
    rows = await env.DB.prepare(
      PENDING_TARGET_SELECT +
        " AND execution.host_id = ?1" +
        " LIMIT ?2",
    )
      .bind(input.hostId, input.limit ?? 8)
      .all<PendingScenarioTerminalTargetRow>();
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "scenario_terminal_attach_reconcile_failed",
        hostId: input.hostId,
        code: scenarioTerminalAttachErrorCode(error),
      }),
    );
    return { attempted: 0, attached: 0 };
  }

  let attempted = 0;
  let attached = 0;
  for (const candidate of rows.results ?? []) {
    attempted += 1;
    try {
      const outcome = await attachReadyScenarioTerminalTargets({
        executionId: candidate.execution_id,
        expectedGeneration: candidate.generation,
        expectedUserId: candidate.user_id,
        hostId: candidate.host_id,
        runId: candidate.run_id,
        vmId: candidate.vm_id,
      });
      if (outcome === "attached") {
        attached += 1;
      }
    } catch (error) {
      if (isTerminalAttachRejection(error)) {
        continue;
      }
      // Log a fixed code, never the raw message: a gateway error body can echo
      // request fields, and the attach body carries the guest private key.
      console.warn(
        JSON.stringify({
          event: "scenario_terminal_attach_reconcile_failed",
          hostId: input.hostId,
          runId: candidate.run_id,
          vmId: candidate.vm_id,
          code: scenarioTerminalAttachErrorCode(error),
        }),
      );
    }
  }
  return { attempted, attached };
}

/**
 * A missing, expired, or revoked route is not a retryable failure. The
 * gateway reports 404 for a route that is gone and 409 for a route that is
 * bound to other metadata or already carries a different target.
 */
function isTerminalAttachRejection(error: unknown): boolean {
  return (
    error instanceof StargateTerminalAttachError &&
    (error.status === 404 || error.status === 409)
  );
}

function scenarioTerminalAttachErrorCode(error: unknown): string {
  if (error instanceof StargateTerminalAttachError) {
    return "gateway_" + String(error.status);
  }
  if (error instanceof Error) {
    return error.name;
  }
  return "unknown";
}

function scenarioTerminalAttachStale() {
  return new Error(
    "scenario terminal attach refused: the route belongs to a replaced runtime generation",
  );
}
