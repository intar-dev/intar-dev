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
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, 'queued', ?, NULL, NULL, ?, ?)`,
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
        "runtime provisioning is no longer authorized",
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
  if (input.providerConnectionId !== null) {
    throw appError(
      400,
      "runtime_provider_identity_invalid",
      "agent runtimes cannot reference an external provider connection",
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
    "the user already has an active scenario runtime",
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

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const output = new Uint8Array(bytes.length);
  output.set(bytes);
  return output.buffer;
}
