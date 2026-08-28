import { env } from "cloudflare:workers";
import { appError, errorChainMatches } from "@/lib/app-error";
import { createAppId } from "@/lib/id";
import type {
  HostResourceReservationState,
  RuntimeDomainKind,
  RuntimeExecutionState,
  RuntimeProviderKind,
} from "@/db/schema";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface RuntimeVmSpec {
  vmId: string;
  ordinal: number;
  runtimeVmName: string;
  imageKey: object;
  imageSha256: string;
  cpuMillis: number;
  memoryMib: number;
  diskMib: number;
}

export interface RuntimeExecutionHandle {
  executionId: string;
  userId: string;
  organizationId: string | null;
  hostId: string | null;
  providerKind: RuntimeProviderKind;
  providerConnectionId: string | null;
  domainKind: RuntimeDomainKind;
  domainId: string;
  generation: number;
  sourceExecutionId: string | null;
  checkpointId: string | null;
  state: RuntimeExecutionState;
  leaseExpiresAt: number | null;
  createdAt: number;
  vms: Array<RuntimeVmSpec & { runtimeVmId: string }>;
  resources: {
    cpuMillis: number;
    memoryMib: number;
    worstCaseDiskMib: number;
  };
}

export interface CreateRuntimeExecutionInput {
  executionId?: string;
  userId: string;
  organizationId?: string | null;
  hostId?: string | null;
  providerKind?: RuntimeProviderKind;
  providerConnectionId?: string | null;
  domainKind: RuntimeDomainKind;
  domainId: string;
  checkpointId?: string | null;
  leaseExpiresAt?: number | null;
  vms: RuntimeVmSpec[];
  claimActiveSlot?: boolean;
  reservationState?: HostResourceReservationState;
  reservationExpiresAt?: number | null;
  reservationResources?: RuntimeExecutionHandle["resources"];
  now?: number;
}

export interface CreateRuntimeRecoveryGenerationInput {
  sourceExecutionId: string;
  expectedGeneration: number;
  executionId?: string;
  hostId?: string | null;
  providerKind?: RuntimeProviderKind;
  providerConnectionId?: string | null;
  checkpointId: string;
  leaseExpiresAt?: number | null;
  vms: RuntimeVmSpec[];
  reservationState?: HostResourceReservationState;
  reservationExpiresAt?: number | null;
  now?: number;
}

interface RuntimeExecutionIdentityRow {
  id: string;
  user_id: string;
  organization_id: string | null;
  host_id: string | null;
  provider_kind: RuntimeProviderKind;
  provider_connection_id: string | null;
  domain_kind: RuntimeDomainKind;
  domain_id: string;
  generation: number;
  source_execution_id: string | null;
  checkpoint_id: string | null;
  state: RuntimeExecutionState;
  lease_expires_at: number | null;
  created_at: number;
  current_generation: number;
}

export function drizzleQueryToD1Statement(
  d1: D1Database,
  query: { toSQL(): { sql: string; params: unknown[] } },
): D1PreparedStatement {
  const compiled = query.toSQL();
  return d1.prepare(compiled.sql).bind(...compiled.params);
}

/**
 * Runs a scenario-run mutation and its provider-neutral runtime projection in
 * one D1 batch. The projection used to be maintained by scenario_runs
 * triggers; keeping it in the command batch preserves the same rollback and
 * cross-domain active-slot semantics without schema-owned behavior.
 */
export async function executeScenarioRunRuntimeProjection(input: {
  d1: D1Database;
  runId: string;
  statements: D1PreparedStatement[];
  mode: "create" | "update";
}): Promise<D1Result<unknown>[]> {
  const runId = requiredId(input.runId, "runId");
  const projection = scenarioRunRuntimeProjectionStatements(
    input.d1,
    runId,
    input.mode,
  );
  try {
    return await input.d1.batch([...input.statements, ...projection]);
  } catch (error) {
    if (isActiveRuntimeSlotConflict(error)) {
      throw activeRuntimeSlotConflict();
    }
    if (
      errorChainMatches(
        error,
        /runtime_executions_generation_positive|scenario runtime execution identity mismatch/i,
      )
    ) {
      throw appError(
        409,
        "scenario_runtime_execution_identity_mismatch",
        "the scenario run does not reference its generation-one runtime execution",
      );
    }
    throw error;
  }
}

/** Deletes a scenario run and every execution generation in its domain. */
export async function deleteScenarioRunRuntimeProjection(input: {
  d1: D1Database;
  runId: string;
  userId?: string;
  statements?: D1PreparedStatement[];
}): Promise<{ deleted: boolean }> {
  const runId = requiredId(input.runId, "runId");
  const userId = normalizedOptionalId(input.userId);
  const deleteStatements =
    input.statements ??
    [
      input.d1
        .prepare(
          `DELETE FROM scenario_runs
           WHERE run_id = ?1 AND (?2 IS NULL OR user_id = ?2)`,
        )
        .bind(runId, userId),
    ];
  if (deleteStatements.length === 0) {
    throw invalidRuntimeInput("a scenario delete requires a mutation statement");
  }
  const results = await input.d1.batch([
    ...deleteStatements,
    input.d1
      .prepare(
        `DELETE FROM runtime_executions
         WHERE domain_kind = 'scenario'
           AND domain_id = ?1
           AND NOT EXISTS (
             SELECT 1 FROM scenario_runs WHERE run_id = ?1
           )`,
      )
      .bind(runId),
  ]);
  // D1 includes rows removed by foreign-key cascades in meta.changes. A run
  // with SSH keys, transcripts, probes, or artifacts can therefore report
  // more than one change even though exactly one parent run matched.
  return { deleted: changes(results[0]) > 0 };
}

function scenarioRunRuntimeProjectionStatements(
  d1: D1Database,
  runId: string,
  mode: "create" | "update",
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  if (mode === "create") {
    statements.push(
      d1
        .prepare(
          `INSERT INTO runtime_executions (
             id, user_id, organization_id, host_id, provider_kind,
             provider_connection_id, domain_kind, domain_id, generation,
             source_execution_id, checkpoint_id, state, lease_expires_at,
             archive_requested_at, ended_at, created_at, updated_at
           )
           SELECT
             coalesce(run.runtime_execution_id, run.run_id),
             run.user_id,
             run.organization_id,
             run.host_id,
             'agent_kvm',
             NULL,
             'scenario',
             run.run_id,
             1,
             NULL,
             NULL,
             CASE
               WHEN run.state = 'queued' THEN 'queued'
               WHEN run.state = 'provisioning' THEN 'provisioning'
               WHEN run.state IN (
                 'teardown_requested', 'tearing_down', 'archiving'
               ) THEN 'archiving'
               WHEN run.state = 'completed' THEN 'archived'
               WHEN run.state = 'failed' THEN 'failed'
               ELSE 'ready'
             END,
             NULL,
             CASE
               WHEN run.state IN (
                 'teardown_requested', 'tearing_down', 'archiving',
                 'completed', 'failed'
               ) THEN run.updated_at
               ELSE NULL
             END,
             CASE
               WHEN run.state = 'completed'
                 THEN coalesce(run.completed_at, run.updated_at)
               WHEN run.state = 'failed'
                 THEN coalesce(run.failed_at, run.updated_at)
               ELSE NULL
             END,
             run.created_at,
             run.updated_at
           FROM scenario_runs run
           WHERE run.run_id = ?1
             AND NOT EXISTS (
               SELECT 1
               FROM runtime_executions execution
               WHERE execution.id = coalesce(
                 run.runtime_execution_id,
                 run.run_id
               )
             )`,
        )
        .bind(runId),
      // A deliberately invalid generation is a transaction sentinel. It is
      // selected only for a mismatched pre-existing identity, so the named
      // Drizzle CHECK constraint aborts and rolls the entire command back.
      d1
        .prepare(
          `INSERT INTO runtime_executions (
             id, user_id, organization_id, host_id, provider_kind,
             provider_connection_id, domain_kind, domain_id, generation,
             source_execution_id, checkpoint_id, state, lease_expires_at,
             archive_requested_at, ended_at, created_at, updated_at
           )
           SELECT
             '__scenario_projection_mismatch__:' || run.run_id,
             run.user_id,
             run.organization_id,
             run.host_id,
             'agent_kvm',
             NULL,
             'scenario',
             run.run_id,
             0,
             NULL,
             NULL,
             'queued',
             NULL,
             NULL,
             NULL,
             run.created_at,
             run.updated_at
           FROM scenario_runs run
           INNER JOIN runtime_executions execution
             ON execution.id = coalesce(
               run.runtime_execution_id,
               run.run_id
             )
           WHERE run.run_id = ?1
             AND NOT (
               execution.user_id = run.user_id
               AND execution.organization_id IS run.organization_id
               AND execution.domain_kind = 'scenario'
               AND execution.domain_id = run.run_id
               AND execution.generation = 1
             )`,
        )
        .bind(runId),
      d1
        .prepare(
          `UPDATE scenario_runs
           SET runtime_execution_id = coalesce(runtime_execution_id, run_id)
           WHERE run_id = ?1 AND runtime_execution_id IS NULL`,
        )
        .bind(runId),
    );
  }

  statements.push(
    d1
      .prepare(
        `UPDATE runtime_executions
         SET
           host_id = (
             SELECT run.host_id
             FROM scenario_runs run
             WHERE run.run_id = ?1
           ),
           state = (
             SELECT CASE
               WHEN run.state = 'queued' THEN 'queued'
               WHEN run.state = 'provisioning' THEN 'provisioning'
               WHEN run.state IN (
                 'teardown_requested', 'tearing_down', 'archiving'
               ) THEN 'archiving'
               WHEN run.state = 'completed' THEN 'archived'
               WHEN run.state = 'failed' THEN 'failed'
               ELSE 'ready'
             END
             FROM scenario_runs run
             WHERE run.run_id = ?1
           ),
           archive_requested_at = CASE
             WHEN (
               SELECT run.state
               FROM scenario_runs run
               WHERE run.run_id = ?1
             ) IN (
               'teardown_requested', 'tearing_down', 'archiving',
               'completed', 'failed'
             ) THEN coalesce(
               archive_requested_at,
               (
                 SELECT run.updated_at
                 FROM scenario_runs run
                 WHERE run.run_id = ?1
               )
             )
             ELSE archive_requested_at
           END,
           ended_at = CASE
             WHEN (
               SELECT run.state
               FROM scenario_runs run
               WHERE run.run_id = ?1
             ) = 'completed' THEN (
               SELECT coalesce(run.completed_at, run.updated_at)
               FROM scenario_runs run
               WHERE run.run_id = ?1
             )
             WHEN (
               SELECT run.state
               FROM scenario_runs run
               WHERE run.run_id = ?1
             ) = 'failed' THEN (
               SELECT coalesce(run.failed_at, run.updated_at)
               FROM scenario_runs run
               WHERE run.run_id = ?1
             )
             ELSE ended_at
           END,
           updated_at = (
             SELECT run.updated_at
             FROM scenario_runs run
             WHERE run.run_id = ?1
           )
         WHERE id = (
             SELECT run.runtime_execution_id
             FROM scenario_runs run
             WHERE run.run_id = ?1
           )
           AND domain_kind = 'scenario'
           AND domain_id = ?1`,
      )
      .bind(runId),
    d1
      .prepare(
        `DELETE FROM active_runtime_slots
         WHERE execution_id = (
           SELECT run.runtime_execution_id
           FROM scenario_runs run
           WHERE run.run_id = ?1 AND run.active_key IS NULL
         )`,
      )
      .bind(runId),
    // No conflict handler is intentional: a slot owned by another runtime
    // aborts the whole D1 batch, just as the old trigger did.
    d1
      .prepare(
        `INSERT INTO active_runtime_slots (user_id, execution_id, acquired_at)
         SELECT
           run.user_id,
           run.runtime_execution_id,
           CASE WHEN ?2 = 'create' THEN run.created_at ELSE run.updated_at END
         FROM scenario_runs run
         WHERE run.run_id = ?1
           AND run.active_key IS NOT NULL
           AND run.runtime_execution_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
             FROM active_runtime_slots slot
             WHERE slot.user_id = run.user_id
               AND slot.execution_id = run.runtime_execution_id
           )`,
      )
      .bind(runId, mode),
  );
  return statements;
}

export async function createRuntimeExecution(
  input: CreateRuntimeExecutionInput,
): Promise<RuntimeExecutionHandle> {
  const executionId = normalizedOptionalId(input.executionId) ?? createAppId();
  const userId = requiredId(input.userId, "userId");
  const domainId = requiredId(input.domainId, "domainId");
  const organizationId = normalizedOptionalId(input.organizationId);
  const hostId = normalizedOptionalId(input.hostId);
  const providerKind = input.providerKind ?? "agent_kvm";
  const providerConnectionId = normalizedOptionalId(input.providerConnectionId);
  validateProviderIdentity({
    providerKind,
    providerConnectionId,
    hostId,
    domainKind: input.domainKind,
  });
  const checkpointId = normalizedOptionalId(input.checkpointId);
  const now = validTimestamp(input.now ?? Date.now(), "now");
  const leaseExpiresAt = optionalTimestamp(
    input.leaseExpiresAt,
    "leaseExpiresAt",
  );
  const vms = prepareVmRows(executionId, input.vms);
  const resources = sumResources(vms);
  const reservationResources = prepareReservationResources(
    input.reservationResources,
    resources,
  );
  const reservationState = input.reservationState ?? "pending";
  const reservationExpiresAt = optionalTimestamp(
    input.reservationExpiresAt,
    "reservationExpiresAt",
  );

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO runtime_executions (
        id, user_id, organization_id, host_id, provider_kind,
        provider_connection_id, domain_kind, domain_id,
        generation, source_execution_id, checkpoint_id, state,
        lease_expires_at, archive_requested_at, ended_at, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, 'queued', ?, NULL, NULL, ?, ?
      WHERE ? <> 'workshop'
         OR EXISTS (
           SELECT 1
           FROM workshop_workspaces workspace
           JOIN workshop_sessions session ON session.id = workspace.session_id
           JOIN workshop_workspace_generations generation
             ON generation.workspace_id = workspace.id
            AND generation.id = workspace.current_generation_id
           JOIN workshop_session_members roster
             ON roster.session_id = session.id
            AND roster.user_id = workspace.user_id
            AND roster.workspace_enabled = 1
           JOIN member organization_member
             ON organization_member.organization_id = session.organization_id
            AND organization_member.user_id = workspace.user_id
           WHERE workspace.id = ?
             AND workspace.user_id = ?
             AND session.organization_id = ?
             AND session.state IN ('lobby', 'live')
             AND workspace.state NOT IN ('ending', 'ended')
             AND generation.state NOT IN ('archiving', 'archived')
             AND organization_member.workshop_access_revoking_at IS NULL
         )`,
    ).bind(
      executionId,
      userId,
      organizationId,
      hostId,
      providerKind,
      providerConnectionId,
      input.domainKind,
      domainId,
      checkpointId,
      leaseExpiresAt,
      now,
      now,
      input.domainKind,
      domainId,
      userId,
      organizationId,
    ),
    ...vms.map((vm) => runtimeVmInsert(vm, now)),
  ];
  if (hostId) {
    statements.push(
      resourceReservationInsert({
        executionId,
        hostId,
        resources: reservationResources,
        state: reservationState,
        expiresAt: reservationExpiresAt,
        now,
      }),
    );
  }
  if (input.claimActiveSlot === true) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO active_runtime_slots (user_id, execution_id, acquired_at)
         VALUES (?, ?, ?)`,
      ).bind(userId, executionId, now),
    );
  }

  try {
    const results = await env.DB.batch(statements);
    if (changes(results[0]) !== 1) {
      throw appError(
        409,
        "runtime_execution_authorization_changed",
        "workshop runtime provisioning is no longer authorized",
      );
    }
  } catch (error) {
    if (isActiveRuntimeSlotConflict(error)) {
      throw activeRuntimeSlotConflict();
    }
    if (
      errorChainMatches(
        error,
        /runtime_executions_domain_generation_uidx|UNIQUE constraint failed: runtime_executions\.domain_kind, runtime_executions\.domain_id, runtime_executions\.generation/,
      )
    ) {
      throw appError(
        409,
        "runtime_generation_conflict",
        "this runtime domain already has an initial generation",
      );
    }
    throw error;
  }

  return {
    executionId,
    userId,
    organizationId,
    hostId,
    providerKind,
    providerConnectionId,
    domainKind: input.domainKind,
    domainId,
    generation: 1,
    sourceExecutionId: null,
    checkpointId,
    state: "queued",
    leaseExpiresAt,
    createdAt: now,
    vms,
    resources,
  };
}

export async function createRuntimeRecoveryGeneration(
  input: CreateRuntimeRecoveryGenerationInput,
): Promise<RuntimeExecutionHandle> {
  const source = await requireCurrentRuntimeGeneration(
    input.sourceExecutionId,
    input.expectedGeneration,
  );
  const executionId = normalizedOptionalId(input.executionId) ?? createAppId();
  const hostId =
    input.hostId === undefined
      ? source.host_id
      : normalizedOptionalId(input.hostId);
  const providerKind = input.providerKind ?? source.provider_kind;
  const providerConnectionId =
    input.providerConnectionId === undefined
      ? source.provider_connection_id
      : normalizedOptionalId(input.providerConnectionId);
  validateProviderIdentity({
    providerKind,
    providerConnectionId,
    hostId,
    domainKind: source.domain_kind,
  });
  const checkpointId = requiredId(input.checkpointId, "checkpointId");
  const now = validTimestamp(input.now ?? Date.now(), "now");
  const leaseExpiresAt = optionalTimestamp(
    input.leaseExpiresAt,
    "leaseExpiresAt",
  );
  const vms = prepareVmRows(executionId, input.vms);
  const resources = sumResources(vms);
  const reservationState = input.reservationState ?? "pending";
  const reservationExpiresAt = optionalTimestamp(
    input.reservationExpiresAt,
    "reservationExpiresAt",
  );

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO runtime_executions (
        id, user_id, organization_id, host_id, provider_kind,
        provider_connection_id, domain_kind, domain_id,
        generation, source_execution_id, checkpoint_id, state,
        lease_expires_at, archive_requested_at, ended_at, created_at, updated_at
      )
      SELECT
        ?, source.user_id, source.organization_id, ?, ?, ?, source.domain_kind,
        source.domain_id, source.generation + 1, source.id, ?, 'queued',
        ?, NULL, NULL, ?, ?
      FROM runtime_executions source
      WHERE source.id = ?
        AND source.generation = ?
        AND (
          source.domain_kind <> 'workshop'
          OR EXISTS (
            SELECT 1
            FROM workshop_workspaces workspace
            JOIN workshop_sessions session ON session.id = workspace.session_id
            JOIN workshop_workspace_generations workspace_generation
              ON workspace_generation.workspace_id = workspace.id
             AND workspace_generation.id = workspace.current_generation_id
            JOIN workshop_session_members roster
              ON roster.session_id = session.id
             AND roster.user_id = workspace.user_id
             AND roster.workspace_enabled = 1
            JOIN member organization_member
              ON organization_member.organization_id = session.organization_id
             AND organization_member.user_id = workspace.user_id
            WHERE workspace.id = source.domain_id
              AND workspace.user_id = source.user_id
              AND session.organization_id = source.organization_id
              AND session.state IN ('lobby', 'live')
              AND workspace.state NOT IN ('ending', 'ended')
              AND workspace_generation.state NOT IN ('archiving', 'archived')
              AND organization_member.workshop_access_revoking_at IS NULL
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM runtime_executions newer
          WHERE newer.domain_kind = source.domain_kind
            AND newer.domain_id = source.domain_id
            AND newer.generation > source.generation
        )`,
    ).bind(
      executionId,
      hostId,
      providerKind,
      providerConnectionId,
      checkpointId,
      leaseExpiresAt,
      now,
      now,
      source.id,
      input.expectedGeneration,
    ),
    ...vms.map((vm) => runtimeVmInsert(vm, now)),
  ];
  if (hostId) {
    statements.push(
      resourceReservationInsert({
        executionId,
        hostId,
        resources,
        state: reservationState,
        expiresAt: reservationExpiresAt,
        now,
      }),
    );
  }
  // A failed provisioning attempt may already have archived the source and
  // released its slot. Upsert transfers an existing source slot or recreates
  // the missing slot atomically; the guard deliberately aborts the batch if a
  // different scenario or workshop claimed the user in the meantime.
  statements.push(
    env.DB.prepare(
      `INSERT INTO active_runtime_slots (user_id, execution_id, acquired_at)
       SELECT source.user_id, ?, ?
       FROM runtime_executions source
       WHERE source.id = ? AND source.generation = ?
       ON CONFLICT (user_id) DO UPDATE SET
         execution_id = excluded.execution_id,
         acquired_at = excluded.acquired_at
       WHERE active_runtime_slots.execution_id = ?`,
    ).bind(executionId, now, source.id, input.expectedGeneration, source.id),
    // If another domain owns the user slot, force the named unique constraint
    // instead of manufacturing an invalid FK value. That keeps the conflict
    // recognizable on D1 and rolls the complete recovery batch back.
    env.DB.prepare(
      `INSERT INTO active_runtime_slots (user_id, execution_id, acquired_at)
       SELECT source.user_id, ?, ?
       FROM runtime_executions source
       WHERE source.id = ? AND source.generation = ?
         AND NOT EXISTS (
           SELECT 1
           FROM active_runtime_slots slot
           WHERE slot.user_id = source.user_id
             AND slot.execution_id = ?
         )`,
    ).bind(
      executionId,
      now,
      source.id,
      input.expectedGeneration,
      executionId,
    ),
    env.DB.prepare(
      `UPDATE scenario_runs
       SET runtime_execution_id = ?
       WHERE runtime_execution_id = ?`,
    ).bind(executionId, source.id),
    env.DB.prepare(
      `UPDATE host_resource_reservations
       SET state = 'released', released_at = ?, updated_at = ?
       WHERE execution_id = ? AND state <> 'released'`,
    ).bind(now, now, source.id),
    env.DB.prepare(
      `UPDATE runtime_executions
       SET state = 'archived',
           archive_requested_at = coalesce(archive_requested_at, ?),
           ended_at = coalesce(ended_at, ?),
           updated_at = ?
       WHERE id = ? AND generation = ?`,
    ).bind(now, now, now, source.id, input.expectedGeneration),
  );

  try {
    const results = await env.DB.batch(statements);
    if (changes(results[0]) !== 1) {
      if (source.domain_kind === "workshop") {
        throw appError(
          409,
          "runtime_execution_authorization_changed",
          "workshop runtime provisioning is no longer authorized",
        );
      }
      throw runtimeGenerationStale(source);
    }
  } catch (error) {
    const current = await loadRuntimeExecutionIdentity(source.id);
    if (
      !current ||
      current.generation !== input.expectedGeneration ||
      current.current_generation !== input.expectedGeneration
    ) {
      throw runtimeGenerationStale(current ?? source);
    }
    if (
      source.domain_kind === "workshop" &&
      errorChainMatches(
        error,
        /FOREIGN KEY constraint failed|workshop runtime provisioning is no longer authorized/i,
      )
    ) {
      throw appError(
        409,
        "runtime_execution_authorization_changed",
        "workshop runtime provisioning is no longer authorized",
      );
    }
    if (isActiveRuntimeSlotConflict(error)) {
      throw activeRuntimeSlotConflict();
    }
    throw error;
  }

  return {
    executionId,
    userId: source.user_id,
    organizationId: source.organization_id,
    hostId,
    providerKind,
    providerConnectionId,
    domainKind: source.domain_kind,
    domainId: source.domain_id,
    generation: input.expectedGeneration + 1,
    sourceExecutionId: source.id,
    checkpointId,
    state: "queued",
    leaseExpiresAt,
    createdAt: now,
    vms,
    resources,
  };
}

export async function claimActiveRuntimeSlot(input: {
  executionId: string;
  expectedGeneration: number;
  now?: number;
}): Promise<void> {
  const execution = await requireCurrentRuntimeGeneration(
    input.executionId,
    input.expectedGeneration,
  );
  if (execution.state === "archived" || execution.state === "failed") {
    throw appError(
      409,
      "runtime_execution_closed",
      "an archived or failed runtime execution cannot claim the active slot",
    );
  }
  const now = validTimestamp(input.now ?? Date.now(), "now");
  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE scenario_runs
         SET active_key = user_id, updated_at = max(updated_at + 1, ?)
         WHERE runtime_execution_id = ?
           AND active_key IS NULL
           AND EXISTS (
             SELECT 1
             FROM runtime_executions current
             WHERE current.id = ?
               AND current.generation = ?
               AND NOT EXISTS (
                 SELECT 1 FROM runtime_executions newer
                 WHERE newer.domain_kind = current.domain_kind
                   AND newer.domain_id = current.domain_id
                   AND newer.generation > current.generation
               )
           )`,
      ).bind(now, execution.id, execution.id, input.expectedGeneration),
      env.DB.prepare(
        `INSERT INTO active_runtime_slots (user_id, execution_id, acquired_at)
         SELECT current.user_id, current.id, ?
         FROM runtime_executions current
         WHERE current.id = ?
           AND current.generation = ?
           AND NOT EXISTS (
             SELECT 1 FROM runtime_executions newer
             WHERE newer.domain_kind = current.domain_kind
               AND newer.domain_id = current.domain_id
               AND newer.generation > current.generation
           )
         ON CONFLICT (user_id) DO UPDATE SET
           acquired_at = active_runtime_slots.acquired_at
         WHERE active_runtime_slots.execution_id = excluded.execution_id`,
      ).bind(now, execution.id, input.expectedGeneration),
    ]);
    if (changes(results[0]) + changes(results[1]) === 0) {
      await requireCurrentRuntimeGeneration(
        input.executionId,
        input.expectedGeneration,
      );
      const slot = await env.DB.prepare(
        "SELECT execution_id FROM active_runtime_slots WHERE user_id = ?",
      )
        .bind(execution.user_id)
        .first<{ execution_id: string }>();
      if (slot?.execution_id !== execution.id) {
        throw activeRuntimeSlotConflict();
      }
    }
  } catch (error) {
    if (isActiveRuntimeSlotConflict(error)) {
      throw activeRuntimeSlotConflict();
    }
    await requireCurrentRuntimeGeneration(
      input.executionId,
      input.expectedGeneration,
    );
    throw error;
  }
}

export async function releaseActiveRuntimeSlot(input: {
  executionId: string;
  expectedGeneration: number;
  now?: number;
}): Promise<{ released: boolean }> {
  const execution = await requireCurrentRuntimeGeneration(
    input.executionId,
    input.expectedGeneration,
  );
  const now = validTimestamp(input.now ?? Date.now(), "now");
  const currentGuard = `EXISTS (
    SELECT 1
    FROM runtime_executions current
    WHERE current.id = ?
      AND current.generation = ?
      AND NOT EXISTS (
        SELECT 1 FROM runtime_executions newer
        WHERE newer.domain_kind = current.domain_kind
          AND newer.domain_id = current.domain_id
          AND newer.generation > current.generation
      )
  )`;
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE scenario_runs
       SET active_key = NULL, updated_at = max(updated_at + 1, ?)
       WHERE runtime_execution_id = ? AND active_key IS NOT NULL
         AND ${currentGuard}`,
    ).bind(now, execution.id, execution.id, input.expectedGeneration),
    env.DB.prepare(
      `DELETE FROM active_runtime_slots
       WHERE execution_id = ? AND ${currentGuard}`,
    ).bind(execution.id, execution.id, input.expectedGeneration),
  ]);
  await rejectIfGenerationRaced(
    execution,
    input.expectedGeneration,
    changes(results[0]) + changes(results[1]),
  );
  return { released: changes(results[0]) + changes(results[1]) > 0 };
}

export async function archiveRuntimeExecution(input: {
  executionId: string;
  expectedGeneration: number;
  endedAt?: number;
}): Promise<void> {
  const execution = await requireCurrentRuntimeGeneration(
    input.executionId,
    input.expectedGeneration,
  );
  const endedAt = validTimestamp(input.endedAt ?? Date.now(), "endedAt");
  const currentGuard = `EXISTS (
    SELECT 1
    FROM runtime_executions current
    WHERE current.id = ?
      AND current.generation = ?
      AND NOT EXISTS (
        SELECT 1 FROM runtime_executions newer
        WHERE newer.domain_kind = current.domain_kind
          AND newer.domain_id = current.domain_id
          AND newer.generation > current.generation
      )
  )`;
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE scenario_runs
       SET active_key = NULL, updated_at = max(updated_at + 1, ?)
       WHERE runtime_execution_id = ? AND active_key IS NOT NULL
         AND ${currentGuard}`,
    ).bind(endedAt, execution.id, execution.id, input.expectedGeneration),
    env.DB.prepare(
      `UPDATE host_resource_reservations
       SET state = 'released', released_at = coalesce(released_at, ?), updated_at = ?
       WHERE execution_id = ? AND state <> 'released' AND ${currentGuard}`,
    ).bind(
      endedAt,
      endedAt,
      execution.id,
      execution.id,
      input.expectedGeneration,
    ),
    env.DB.prepare(
      `DELETE FROM active_runtime_slots
       WHERE execution_id = ? AND ${currentGuard}`,
    ).bind(execution.id, execution.id, input.expectedGeneration),
    env.DB.prepare(
      `UPDATE runtime_executions
       SET state = 'archived',
           archive_requested_at = coalesce(archive_requested_at, ?),
           ended_at = coalesce(ended_at, ?),
           updated_at = ?
       WHERE id = ?
         AND generation = ?
         AND NOT EXISTS (
           SELECT 1 FROM runtime_executions newer
           WHERE newer.domain_kind = runtime_executions.domain_kind
             AND newer.domain_id = runtime_executions.domain_id
             AND newer.generation > runtime_executions.generation
         )`,
    ).bind(endedAt, endedAt, endedAt, execution.id, input.expectedGeneration),
  ]);
  if (changes(results[3]) !== 1) {
    throw runtimeGenerationStale(execution);
  }
}

export async function updateRuntimeExecutionState(input: {
  executionId: string;
  expectedGeneration: number;
  state: Exclude<RuntimeExecutionState, "archived">;
  observedAt?: number;
  leaseExpiresAt?: number | null;
}): Promise<void> {
  const execution = await requireCurrentRuntimeGeneration(
    input.executionId,
    input.expectedGeneration,
  );
  const observedAt = validTimestamp(
    input.observedAt ?? Date.now(),
    "observedAt",
  );
  const leaseExpiresAt =
    input.leaseExpiresAt === undefined
      ? execution.lease_expires_at
      : optionalTimestamp(input.leaseExpiresAt, "leaseExpiresAt");
  const result = await env.DB.prepare(
    `UPDATE runtime_executions
     SET state = ?,
         lease_expires_at = ?,
         archive_requested_at = CASE
           WHEN ? = 'archiving' THEN coalesce(archive_requested_at, ?)
           ELSE archive_requested_at
         END,
         ended_at = CASE
           WHEN ? = 'failed' THEN coalesce(ended_at, ?)
           ELSE ended_at
         END,
         updated_at = ?
     WHERE id = ?
       AND generation = ?
       AND state NOT IN ('archived', 'failed')
       AND NOT EXISTS (
         SELECT 1 FROM runtime_executions newer
         WHERE newer.domain_kind = runtime_executions.domain_kind
           AND newer.domain_id = runtime_executions.domain_id
           AND newer.generation > runtime_executions.generation
       )`,
  )
    .bind(
      input.state,
      leaseExpiresAt,
      input.state,
      observedAt,
      input.state,
      observedAt,
      observedAt,
      execution.id,
      input.expectedGeneration,
    )
    .run();
  if (changes(result) !== 1) {
    throw runtimeGenerationStale(execution);
  }
}

export async function recordRuntimeVmTerminalTarget(input: {
  executionId: string;
  expectedGeneration: number;
  vmId: string;
  target: {
    host: string;
    port: number;
    username: string;
    hostKeyOpenssh: string;
    privateKeyOpenssh: string;
  };
  observedAt?: number;
}): Promise<void> {
  const execution = await requireCurrentRuntimeGeneration(
    input.executionId,
    input.expectedGeneration,
  );
  const vmId = requiredId(input.vmId, "vmId");
  const host = requiredId(input.target.host, "target.host");
  const username = requiredId(input.target.username, "target.username");
  const hostKeyOpenssh = requiredId(
    input.target.hostKeyOpenssh,
    "target.hostKeyOpenssh",
  );
  const privateKeyOpenssh = requiredId(
    input.target.privateKeyOpenssh,
    "target.privateKeyOpenssh",
  );
  const port = positiveInteger(input.target.port, "target.port");
  const observedAt = validTimestamp(
    input.observedAt ?? Date.now(),
    "observedAt",
  );
  const vm = await env.DB.prepare(
    `SELECT id, runtime_vm_name
     FROM runtime_vms
     WHERE execution_id = ? AND vm_id = ?`,
  )
    .bind(execution.id, vmId)
    .first<{ id: string; runtime_vm_name: string }>();
  if (!vm) {
    throw appError(404, "runtime_vm_not_found", "runtime VM not found");
  }
  const encrypted = await encryptRuntimePrivateKey({
    executionId: execution.id,
    vmId,
    runtimeVmName: vm.runtime_vm_name,
    hostKeyOpenssh,
    privateKeyOpenssh,
  });
  const result = await env.DB.prepare(
    `UPDATE runtime_vms
     SET terminal_host = ?,
         terminal_port = ?,
         terminal_username = ?,
         terminal_host_key_openssh = ?,
         terminal_private_key_ciphertext_b64 = ?,
         terminal_private_key_iv_b64 = ?,
         terminal_observed_at = ?,
         updated_at = ?
     WHERE id = ?
       AND execution_id = ?
       AND (terminal_observed_at IS NULL OR terminal_observed_at <= ?)
       AND EXISTS (
         SELECT 1
         FROM runtime_executions current
         WHERE current.id = runtime_vms.execution_id
           AND current.generation = ?
           AND current.state NOT IN ('archived', 'failed')
           AND NOT EXISTS (
             SELECT 1 FROM runtime_executions newer
             WHERE newer.domain_kind = current.domain_kind
               AND newer.domain_id = current.domain_id
               AND newer.generation > current.generation
           )
       )`,
  )
    .bind(
      host,
      port,
      username,
      hostKeyOpenssh,
      encrypted.ciphertextB64,
      encrypted.ivB64,
      observedAt,
      observedAt,
      vm.id,
      execution.id,
      observedAt,
      input.expectedGeneration,
    )
    .run();
  if (changes(result) !== 1) {
    await requireCurrentRuntimeGeneration(
      execution.id,
      input.expectedGeneration,
    );
    const current = await env.DB.prepare(
      "SELECT terminal_observed_at FROM runtime_vms WHERE id = ?",
    )
      .bind(vm.id)
      .first<{ terminal_observed_at: number | null }>();
    if ((current?.terminal_observed_at ?? -1) <= observedAt) {
      throw runtimeGenerationStale(execution);
    }
  }
}

export async function loadCurrentRuntimeVmTerminalTarget(input: {
  executionId: string;
  expectedGeneration: number;
  vmId?: string;
}): Promise<{
  executionId: string;
  generation: number;
  domainKind: RuntimeDomainKind;
  domainId: string;
  userId: string;
  organizationId: string | null;
  hostId: string;
  vmId: string;
  runtimeVmName: string;
  target: {
    host: string;
    port: number;
    username: string;
    hostKeyOpenssh: string;
    privateKeyOpenssh: string;
    observedAt: number;
  };
}> {
  const execution = await requireCurrentRuntimeGeneration(
    input.executionId,
    input.expectedGeneration,
  );
  const transportSourceId =
    execution.host_id ??
    (execution.provider_connection_id
      ? `provider:${execution.provider_connection_id}`
      : null);
  if (!transportSourceId) {
    throw appError(
      409,
      "runtime_terminal_not_ready",
      "runtime execution has not been assigned to a transport source",
    );
  }
  const vmId = normalizedOptionalId(input.vmId);
  const row = await env.DB.prepare(
    `SELECT
       vm.vm_id,
       vm.runtime_vm_name,
       vm.terminal_host,
       vm.terminal_port,
       vm.terminal_username,
       vm.terminal_host_key_openssh,
       vm.terminal_private_key_ciphertext_b64,
       vm.terminal_private_key_iv_b64,
       vm.terminal_observed_at
     FROM runtime_vms vm
     WHERE vm.execution_id = ?
       AND (? IS NULL OR vm.vm_id = ?)
     ORDER BY vm.ordinal ASC
     LIMIT 1`,
  )
    .bind(execution.id, vmId, vmId)
    .first<{
      vm_id: string;
      runtime_vm_name: string;
      terminal_host: string | null;
      terminal_port: number | null;
      terminal_username: string | null;
      terminal_host_key_openssh: string | null;
      terminal_private_key_ciphertext_b64: string | null;
      terminal_private_key_iv_b64: string | null;
      terminal_observed_at: number | null;
    }>();
  if (!row) {
    throw appError(404, "runtime_vm_not_found", "runtime VM not found");
  }
  if (
    !row.terminal_host ||
    !row.terminal_port ||
    !row.terminal_username ||
    !row.terminal_host_key_openssh ||
    !row.terminal_private_key_ciphertext_b64 ||
    !row.terminal_private_key_iv_b64 ||
    row.terminal_observed_at === null
  ) {
    throw appError(
      409,
      "runtime_terminal_not_ready",
      "runtime terminal target is still warming up",
    );
  }
  return {
    executionId: execution.id,
    generation: execution.generation,
    domainKind: execution.domain_kind,
    domainId: execution.domain_id,
    userId: execution.user_id,
    organizationId: execution.organization_id,
    hostId: transportSourceId,
    vmId: row.vm_id,
    runtimeVmName: row.runtime_vm_name,
    target: {
      host: row.terminal_host,
      port: row.terminal_port,
      username: row.terminal_username,
      hostKeyOpenssh: row.terminal_host_key_openssh,
      privateKeyOpenssh: await decryptRuntimePrivateKey({
        executionId: execution.id,
        vmId: row.vm_id,
        runtimeVmName: row.runtime_vm_name,
        hostKeyOpenssh: row.terminal_host_key_openssh,
        ciphertextB64: row.terminal_private_key_ciphertext_b64,
        ivB64: row.terminal_private_key_iv_b64,
      }),
      observedAt: row.terminal_observed_at,
    },
  };
}

export async function requireCurrentRuntimeGeneration(
  executionId: string,
  expectedGeneration: number,
): Promise<RuntimeExecutionIdentityRow> {
  const normalizedExecutionId = requiredId(executionId, "executionId");
  const normalizedGeneration = positiveInteger(
    expectedGeneration,
    "expectedGeneration",
  );
  const row = await loadRuntimeExecutionIdentity(normalizedExecutionId);
  if (!row) {
    throw appError(
      404,
      "runtime_execution_not_found",
      "runtime execution not found",
    );
  }
  if (
    row.generation !== normalizedGeneration ||
    row.current_generation !== normalizedGeneration
  ) {
    throw runtimeGenerationStale(row);
  }
  return row;
}

/**
 * Loads the provider-neutral execution identity and its immutable VM
 * requirements. Provider implementations use this instead of reaching into
 * agent-host desired state, which keeps Hetzner executions independent from
 * `agent_hosts` and `DesiredVmV2`.
 */
export async function loadRuntimeExecutionHandle(
  executionId: string,
): Promise<RuntimeExecutionHandle> {
  const id = requiredId(executionId, "executionId");
  const execution = await loadRuntimeExecutionIdentity(id);
  if (!execution) {
    throw appError(
      404,
      "runtime_execution_not_found",
      "runtime execution not found",
    );
  }
  const vmRows = await env.DB.prepare(
    `SELECT
       id, vm_id, ordinal, runtime_vm_name, image_key_json, image_sha256,
       cpu_millis, memory_mib, disk_mib
     FROM runtime_vms
     WHERE execution_id = ?
     ORDER BY ordinal ASC`,
  )
    .bind(id)
    .all<{
      id: string;
      vm_id: string;
      ordinal: number;
      runtime_vm_name: string;
      image_key_json: string | object;
      image_sha256: string;
      cpu_millis: number;
      memory_mib: number;
      disk_mib: number;
    }>();
  const vms = vmRows.results.map((vm) => ({
    runtimeVmId: vm.id,
    vmId: vm.vm_id,
    ordinal: vm.ordinal,
    runtimeVmName: vm.runtime_vm_name,
    imageKey:
      typeof vm.image_key_json === "string"
        ? (JSON.parse(vm.image_key_json) as object)
        : vm.image_key_json,
    imageSha256: vm.image_sha256,
    cpuMillis: vm.cpu_millis,
    memoryMib: vm.memory_mib,
    diskMib: vm.disk_mib,
  }));
  return {
    executionId: execution.id,
    userId: execution.user_id,
    organizationId: execution.organization_id,
    hostId: execution.host_id,
    providerKind: execution.provider_kind,
    providerConnectionId: execution.provider_connection_id,
    domainKind: execution.domain_kind,
    domainId: execution.domain_id,
    generation: execution.generation,
    sourceExecutionId: execution.source_execution_id,
    checkpointId: execution.checkpoint_id,
    state: execution.state,
    leaseExpiresAt: execution.lease_expires_at,
    createdAt: execution.created_at,
    vms,
    resources: sumResources(vms),
  };
}

async function loadRuntimeExecutionIdentity(
  executionId: string,
): Promise<RuntimeExecutionIdentityRow | null> {
  return env.DB.prepare(
    `SELECT
       execution.id,
       execution.user_id,
       execution.organization_id,
       execution.host_id,
       execution.provider_kind,
       execution.provider_connection_id,
       execution.domain_kind,
       execution.domain_id,
       execution.generation,
       execution.source_execution_id,
       execution.checkpoint_id,
       execution.state,
       execution.lease_expires_at,
       execution.created_at,
       (
         SELECT max(current.generation)
         FROM runtime_executions current
         WHERE current.domain_kind = execution.domain_kind
           AND current.domain_id = execution.domain_id
       ) AS current_generation
     FROM runtime_executions execution
     WHERE execution.id = ?`,
  )
    .bind(executionId)
    .first<RuntimeExecutionIdentityRow>();
}

function validateProviderIdentity(input: {
  providerKind: RuntimeProviderKind;
  providerConnectionId: string | null;
  hostId: string | null;
  domainKind: RuntimeDomainKind;
}): void {
  if (input.providerKind === "agent_kvm") {
    if (input.providerConnectionId !== null) {
      throw appError(
        400,
        "runtime_provider_identity_invalid",
        "agent runtimes cannot reference an external provider connection",
      );
    }
    return;
  }
  if (
    (input.providerKind !== "hetzner_cloud" &&
      input.providerKind !== "gcp_compute") ||
    (input.domainKind !== "workshop" &&
      input.domainKind !== "workshop_certification") ||
    !input.providerConnectionId ||
    input.hostId !== null
  ) {
    throw appError(
      400,
      "runtime_provider_identity_invalid",
      "direct-cloud runtimes require a workshop or certification provider connection and no agent host",
    );
  }
}

function runtimeVmInsert(
  vm: RuntimeVmSpec & { runtimeVmId: string; executionId: string },
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO runtime_vms (
       id, execution_id, vm_id, ordinal, runtime_vm_name, image_key_json,
       image_sha256, cpu_millis, memory_mib, disk_mib, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    vm.runtimeVmId,
    vm.executionId,
    vm.vmId,
    vm.ordinal,
    vm.runtimeVmName,
    JSON.stringify(vm.imageKey),
    vm.imageSha256,
    vm.cpuMillis,
    vm.memoryMib,
    vm.diskMib,
    now,
    now,
  );
}

function resourceReservationInsert(input: {
  executionId: string;
  hostId: string;
  resources: RuntimeExecutionHandle["resources"];
  state: HostResourceReservationState;
  expiresAt: number | null;
  now: number;
}): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO host_resource_reservations (
       execution_id, host_id, cpu_millis, memory_mib, worst_case_disk_mib,
       state, expires_at, released_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).bind(
    input.executionId,
    input.hostId,
    input.resources.cpuMillis,
    input.resources.memoryMib,
    input.resources.worstCaseDiskMib,
    input.state,
    input.expiresAt,
    input.now,
    input.now,
  );
}

function prepareVmRows(executionId: string, input: RuntimeVmSpec[]) {
  if (!Array.isArray(input) || input.length === 0) {
    throw invalidRuntimeInput("a runtime execution requires at least one VM");
  }
  const vmIds = new Set<string>();
  const ordinals = new Set<number>();
  const runtimeNames = new Set<string>();
  return input.map((candidate) => {
    const vmId = requiredId(candidate.vmId, "vms[].vmId");
    const runtimeVmName = requiredId(
      candidate.runtimeVmName,
      "vms[].runtimeVmName",
    );
    const ordinal = nonNegativeInteger(candidate.ordinal, "vms[].ordinal");
    if (
      vmIds.has(vmId) ||
      ordinals.has(ordinal) ||
      runtimeNames.has(runtimeVmName)
    ) {
      throw invalidRuntimeInput(
        "runtime VM ids, ordinals, and runtime names must be unique",
      );
    }
    vmIds.add(vmId);
    ordinals.add(ordinal);
    runtimeNames.add(runtimeVmName);
    if (!isRecord(candidate.imageKey)) {
      throw invalidRuntimeInput("vms[].imageKey must be an object");
    }
    return {
      vmId,
      ordinal,
      runtimeVmName,
      imageKey: candidate.imageKey,
      imageSha256: requiredId(candidate.imageSha256, "vms[].imageSha256"),
      cpuMillis: positiveInteger(candidate.cpuMillis, "vms[].cpuMillis"),
      memoryMib: positiveInteger(candidate.memoryMib, "vms[].memoryMib"),
      diskMib: positiveInteger(candidate.diskMib, "vms[].diskMib"),
      runtimeVmId: createAppId(),
      executionId,
    };
  });
}

function sumResources(
  vms: Array<Pick<RuntimeVmSpec, "cpuMillis" | "memoryMib" | "diskMib">>,
): RuntimeExecutionHandle["resources"] {
  const resources = vms.reduce(
    (total, vm) => ({
      cpuMillis: total.cpuMillis + vm.cpuMillis,
      memoryMib: total.memoryMib + vm.memoryMib,
      worstCaseDiskMib: total.worstCaseDiskMib + vm.diskMib,
    }),
    { cpuMillis: 0, memoryMib: 0, worstCaseDiskMib: 0 },
  );
  for (const [name, value] of Object.entries(resources)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw invalidRuntimeInput(`${name} total is outside the supported range`);
    }
  }
  return resources;
}

function prepareReservationResources(
  input: RuntimeExecutionHandle["resources"] | undefined,
  vmResources: RuntimeExecutionHandle["resources"],
): RuntimeExecutionHandle["resources"] {
  if (!input) return vmResources;
  const resources = {
    cpuMillis: positiveInteger(
      input.cpuMillis,
      "reservationResources.cpuMillis",
    ),
    memoryMib: positiveInteger(
      input.memoryMib,
      "reservationResources.memoryMib",
    ),
    worstCaseDiskMib: positiveInteger(
      input.worstCaseDiskMib,
      "reservationResources.worstCaseDiskMib",
    ),
  };
  if (
    resources.cpuMillis < vmResources.cpuMillis ||
    resources.memoryMib < vmResources.memoryMib ||
    resources.worstCaseDiskMib < vmResources.worstCaseDiskMib
  ) {
    throw invalidRuntimeInput(
      "reservationResources cannot be smaller than the runtime VM resources",
    );
  }
  return resources;
}

async function rejectIfGenerationRaced(
  execution: RuntimeExecutionIdentityRow,
  expectedGeneration: number,
  mutationChanges: number,
): Promise<void> {
  if (mutationChanges > 0) return;
  const current = await loadRuntimeExecutionIdentity(execution.id);
  if (
    !current ||
    current.generation !== expectedGeneration ||
    current.current_generation !== expectedGeneration
  ) {
    throw runtimeGenerationStale(current ?? execution);
  }
}

function runtimeGenerationStale(
  execution: Pick<
    RuntimeExecutionIdentityRow,
    "domain_kind" | "domain_id" | "current_generation"
  >,
) {
  return appError(
    409,
    "runtime_generation_stale",
    `runtime generation is stale for ${execution.domain_kind}:${execution.domain_id}; current generation is ${execution.current_generation}`,
  );
}

function activeRuntimeSlotConflict() {
  return appError(
    409,
    "runtime_active_slot_conflict",
    "the user already has an active scenario or workshop runtime",
  );
}

function isActiveRuntimeSlotConflict(error: unknown): boolean {
  return errorChainMatches(
    error,
    /active[_ ]runtime[_ ]slots?|scenario_runs\.active_key|scenario_runs_active_key_uidx/,
  );
}

function changes(result: D1Result<unknown> | undefined): number {
  return result?.meta.changes ?? 0;
}

function requiredId(value: string, name: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw invalidRuntimeInput(`${name} must be a non-empty string`);
  }
  return normalized;
}

function normalizedOptionalId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return requiredId(value, "identifier");
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalidRuntimeInput(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidRuntimeInput(`${name} must be a non-negative integer`);
  }
  return value;
}

function validTimestamp(value: number, name: string): number {
  return nonNegativeInteger(value, name);
}

function optionalTimestamp(
  value: number | null | undefined,
  name: string,
): number | null {
  return value === null || value === undefined
    ? null
    : validTimestamp(value, name);
}

function invalidRuntimeInput(message: string) {
  return appError(400, "runtime_execution_invalid", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function encryptRuntimePrivateKey(input: {
  executionId: string;
  vmId: string;
  runtimeVmName: string;
  hostKeyOpenssh: string;
  privateKeyOpenssh: string;
}): Promise<{ ciphertextB64: string; ivB64: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(runtimeKeyContext(input)),
    },
    await runtimeEncryptionKey(),
    toArrayBuffer(textEncoder.encode(input.privateKeyOpenssh)),
  );
  return {
    ciphertextB64: bytesToBase64(new Uint8Array(ciphertext)),
    ivB64: bytesToBase64(iv),
  };
}

async function decryptRuntimePrivateKey(input: {
  executionId: string;
  vmId: string;
  runtimeVmName: string;
  hostKeyOpenssh: string;
  ciphertextB64: string;
  ivB64: string;
}): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(base64ToBytes(input.ivB64)),
      additionalData: toArrayBuffer(runtimeKeyContext(input)),
    },
    await runtimeEncryptionKey(),
    toArrayBuffer(base64ToBytes(input.ciphertextB64)),
  );
  return textDecoder.decode(plaintext);
}

async function runtimeEncryptionKey(): Promise<CryptoKey> {
  const secret = env.SCENARIO_RUN_KEY_ENCRYPTION_SECRET?.trim();
  if (!secret) {
    throw appError(
      500,
      "runtime_key_secret_missing",
      "runtime credential encryption is not configured",
    );
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(secret),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function runtimeKeyContext(input: {
  executionId: string;
  vmId: string;
  runtimeVmName: string;
  hostKeyOpenssh: string;
}): Uint8Array {
  return textEncoder.encode(
    `${input.executionId}\0${input.vmId}\0${input.runtimeVmName}\0${input.hostKeyOpenssh}`,
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index);
  }
  return output;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const output = new Uint8Array(bytes.length);
  output.set(bytes);
  return output.buffer;
}
