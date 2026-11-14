import { env } from "cloudflare:workers";
import { metalAdmissionSql } from "@/lib/metal-placement";
import { and, eq } from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import type { DesiredVmV3 } from "@/generated/contracts/bridge-message-v9";
import { isRevisionScenarioId } from "@/lib/scenario-id";
import {
  admitRevisionRun,
  liveRevisionAnchorCondition,
  liveRevisionHolds,
  liveScenarioRevision,
  verifyAnchorCondition,
  verifyRefusal,
} from "./revision-begin";
import {
  admissionCpuQuotaStatement,
  admissionResourceReservationStatement,
} from "@/control-plane/host-cpu-reservations";
import {
  scenarioRuns,
  scenarioRunSshKeys,
} from "@/db/schema";
import type { ScenarioStartRequestScope } from "@/db/schema/runs";
import {
  activeAccountExistsSql,
  activeAccountSql,
  isActiveAccount,
} from "@/lib/account-access";
import { appError, errorChainMatches } from "@/lib/app-error";
import {
  assertCourseScenarioStartAllowed,
} from "@/lib/course-catalogs";
import { tryWakeHostRuntime } from "@/lib/host-runtime-wake";
import { requireIdempotencyKey } from "@/lib/idempotency-key";
import {
  admitInternalRegistryOperation,
  type RegistryOperationLease,
} from "@/lib/image-registry-admission";
import { assertAgentKvmRunsOpen, runsHeldCondition } from "@/lib/run-admission-gate";
import {
  RUNTIME_PENDING_RESOURCE_RESERVATION_TTL_MS,
  type RuntimeResourceDemand,
} from "@/lib/runtime-capacity";
import {
  RUN_PHASE_ORDER,
} from "@/lib/run-state";
import type { RuntimeVmSpec } from "@/lib/runtime-executions";
import { traceOperation } from "@/lib/tracing";
import {
  admissionContentAccessCondition,
  admissionHostReadinessCondition,
  type AdmissionContentAccess,
  type AdmissionHostReadiness,
} from "./admission-guards";
import {
  isActiveKeyUniqueViolation,
} from "./start";
import {
  activeRunConflictError,
  loadActiveRunRow,
} from "./storage";

/**
 * The one admission operation for a learner scenario start.
 *
 * Architecture: admission is a single D1 atomic batch that runs inside the
 * Worker request. There is no Durable Object hop and no allocation lock in the
 * admission path. The batch writes, in one transaction:
 *
 * - the run row and its SSH keys,
 * - the runtime execution, its VM mirror rows, and their access keys,
 * - the host resource reservation and the host boot-CPU quota,
 * - the host desired-state document under a version compare-and-set,
 * - the active-run slot.
 *
 * The host desired-state version is the capacity serialization point: every
 * admission publishes its VMs by bumping that version, so two starts for one
 * host cannot both read the same capacity and both win. A lost compare-and-set
 * aborts the whole batch through a generated constraint sentinel, and the
 * caller retries with fresh reads and the same idempotency key.
 *
 * Delivery is a hint after the commit: the committed desired-state version is
 * the durable dispatch record, and waking the host runtime is best effort.
 */
export interface BeginScenarioRunInput {
  scenarioId: string;
  userId: string;
  idempotencyKey: string;
  organizationId?: string | null;
  hostId?: string;
  allowDrainedAdminProof?: boolean;
  allowSequenceBypass?: boolean;
  /** A start from a play page: no course, and play access instead. */
  launchSource?: "play";
  /** Where the play page was opened from, as the start route validated it. */
  ref?: string;
}

export interface BeginScenarioRunResult {
  accepted: true;
  runId: string;
  scenarioId: string;
  acceptedAt: number;
  /**
   * True when this request did not admit a new run: it replayed the run that
   * the same idempotency key already admitted, either from the stored key or
   * as the loser of a concurrent race. The client uses it to keep a transport
   * retry of one attempt out of the fresh-sample benchmark evidence.
   */
  reused: boolean;
  hostId: string | null;
  /**
   * Started after the durable commit. Await it inside the request, or hand it
   * to ctx.waitUntil(). The outbox sweep delivers the version anyway.
   */
  deliveryHint: Promise<void>;
}

export const ADMISSION_CAS_ATTEMPTS = 3;

export async function beginScenarioRun(
  input: BeginScenarioRunInput,
): Promise<BeginScenarioRunResult> {
  return traceOperation(
    "scenario.start",
    async () => {
      await assertAgentKvmRunsOpen(env.DB, {
        ...(input.allowDrainedAdminProof
          ? { allowDrainedAdminProof: true }
          : {}),
      });
      const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
      const organizationId = input.organizationId ?? null;
      // The run start is a shared registry writer for its whole read-to-commit
      // window: it reads a scenario image reference and then commits the run
      // and the desired VMs that point at that image. Without the writer a
      // registry sweep could delete the image objects in between, and the
      // committed run would reference an image that no longer exists. The writer also refuses the start while a sweep holds
      // the gate, so the two can never overlap in either direction.
      const registryGuard = await openRunStartRegistryGuard(input.userId);
      let outcome: "ok" | "error" = "error";
      try {
        const result = await admitScenarioStart(input, {
          idempotencyKey,
          organizationId,
        });
        outcome = "ok";
        return result;
      } finally {
        // The window ends with the commit batch, and a release that fails
        // leaves the row as a hold for the operator reap. Neither may change
        // the answer the caller already has.
        await registryGuard.complete(outcome);
      }
    },
    { "intar.scenario.id": input.scenarioId },
  );
}

/**
 * Opens the shared registry writer that guards one run start. A refusal is
 * retryable: the gate is closed only while a collector sweep runs or while the
 * registry is paused, and the caller's idempotency key makes the retry safe.
 */
export async function openRunStartRegistryGuard(
  userId: string,
): Promise<RegistryOperationLease> {
  const admitted = await admitInternalRegistryOperation(env, {
    operation: "run_start",
    owner: { kind: "system", id: userId },
  });
  if (!admitted.ok) {
    throw appError(
      503,
      "registry_busy",
      "the image registry is busy; retry the start",
    );
  }
  return admitted.lease;
}

/**
 * The admission itself. The registry writer of the caller holds the image
 * references this function reads from the first scenario read to the commit.
 */
async function admitScenarioStart(
  input: BeginScenarioRunInput,
  prelude: {
    idempotencyKey: string;
    organizationId: string | null;
  },
): Promise<BeginScenarioRunResult> {
  const { idempotencyKey, organizationId } = prelude;
  const scope = scenarioStartRequestScope(input, input.scenarioId);
  const db = drizzle(env.DB);
  const play = input.launchSource === "play";
  // Every scenario id is namespaced and starts from its live revision. A
  // play start is personal.
  if (!isRevisionScenarioId(input.scenarioId) || (play && organizationId !== null)) {
    throw appError(404, "scenario_not_found", "scenario not found");
  }
  const [revision, active] = await Promise.all([
    liveScenarioRevision(env.DB, input.scenarioId, organizationId, { play }),
    loadActiveRunRow(input.userId),
  ]);
  if (!revision) throw appError(404, "scenario_not_found", "scenario not found");
  const scenarioId = input.scenarioId;
  // Resolve the V2 unit before any reuse can return, so an old direct
  // request cannot revive an unlinked scenario around the course gate.
  const courseLecture = play
    ? null
    : await assertCourseScenarioStartAllowed({
        db,
        userId: input.userId,
        organizationId,
        scenarioId,
        ...(input.allowSequenceBypass ? { allowSequenceBypass: true } : {}),
      });
  await assertAccountActive(input.userId);

  const replayed = await loadRunByIdempotencyKey(
    db,
    input.userId,
    idempotencyKey,
  );
  if (replayed) {
    assertReplayMatchesScope(replayed.requestScopeJson, scope);
    return {
      accepted: true,
      runId: replayed.runId,
      scenarioId: replayed.scenarioId,
      // The original acceptance, and a replay is not a fresh admission.
      acceptedAt: replayed.acceptedAt,
      reused: true,
      hostId: replayed.hostId,
      deliveryHint: deliveryHint(replayed.hostId),
    };
  }

  if (active) {
    // An active run never stands in for a new start. Returning it here
    // would answer a new idempotency key with another request's run, and a
    // later retry of that key would create a second VM set once the first
    // run ended. Only an exact replay of the admitting request returns the
    // stored run, which the idempotency lookup above already handled.
    throw activeRunConflictError(active.title);
  }

  return admitRevisionRun({
    input,
    revision,
    organizationId,
    courseLecture,
    idempotencyKey,
    scope,
  });
}

/**
 * The live revision changed inside the read-to-commit window, so this request
 * would launch an image the revision no longer describes. It is a decision on
 * this request only: a start against fresh reads is a new admission.
 */
export function scenarioSourceChanged() {
  return appError(
    409,
    "scenario_source_changed",
    "the scenario image changed while the run was starting; start it again",
  );
}

function scenarioStartRequestScope(
  input: BeginScenarioRunInput,
  scenarioId: string,
): ScenarioStartRequestScope {
  return {
    scenarioId,
    organizationId: input.organizationId ?? null,
    hostId: input.hostId ?? null,
    // Kept null: stored scopes are compared whole on a replay.
    candidateRevision: null,
    candidateBuildId: null,
    allowDrainedAdminProof: input.allowDrainedAdminProof === true,
    allowSequenceBypass: input.allowSequenceBypass === true,
    ...(input.launchSource === "play" ? { launchSource: "play" as const, ref: input.ref ?? null } : {}),
  };
}

interface StoredIdempotentRun {
  runId: string;
  scenarioId: string;
  hostId: string;
  requestScopeJson: ScenarioStartRequestScope | null;
  /**
   * The stored run's own acceptance time. A replay reports this value, never
   * the time of the retry, so a transport retry of one attempt cannot be
   * recorded as a fresh sample or advertise a later acceptance than the run
   * actually has.
   */
  acceptedAt: number;
}

export async function loadRunByIdempotencyKey(
  db: DrizzleD1Database,
  userId: string,
  idempotencyKey: string,
): Promise<StoredIdempotentRun | null> {
  const rows = await db
    .select({
      runId: scenarioRuns.runId,
      scenarioId: scenarioRuns.scenarioId,
      hostId: scenarioRuns.hostId,
      requestScopeJson: scenarioRuns.requestScopeJson,
      createdAt: scenarioRuns.createdAt,
    })
    .from(scenarioRuns)
    .where(
      and(
        eq(scenarioRuns.userId, userId),
        eq(scenarioRuns.requestIdempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    return null;
  }
  return {
    runId: row.runId,
    scenarioId: row.scenarioId,
    hostId: row.hostId,
    requestScopeJson:
      (row.requestScopeJson as ScenarioStartRequestScope | null) ?? null,
    acceptedAt: row.createdAt,
  };
}

export function assertReplayMatchesScope(
  stored: ScenarioStartRequestScope | null,
  expected: ScenarioStartRequestScope,
): void {
  if (!stored || JSON.stringify(stored) !== JSON.stringify(expected)) {
    throw appError(
      409,
      "idempotency_key_conflict",
      "this Idempotency-Key was used for a different start request",
    );
  }
}


export async function assertAccountActive(userId: string): Promise<void> {
  if (!(await isActiveAccount(userId))) throw scenarioStartAccessRevoked();
}

export async function assertAccountStillActive(input: {
  userId: string;
  runId: string;
  hostId: string;
}): Promise<void> {
  const current = await env.DB.prepare(
    "SELECT 1 FROM user owner" +
      " INNER JOIN scenario_runs run ON run.user_id = owner.id" +
      " AND run.run_id = ?2" +
      " WHERE owner.id = ?1 AND run.host_id = ?3" +
      " AND " + activeAccountSql("owner") +
      " AND run.state = 'provisioning'" +
      " AND run.delete_requested_at IS NULL LIMIT 1",
  )
    .bind(input.userId, input.runId, input.hostId)
    .first();
  if (!current) throw scenarioStartAccessRevoked();
}

function scenarioStartAccessRevoked() {
  return appError(
    403,
    "access_revoked",
    "account access was revoked while the scenario was starting",
  );
}

/**
 * Wakes the host runtime so it pushes the committed desired version to a live
 * agent socket. Best effort and never poison: the wake client already bounds
 * the call and clears its own timer, the committed version is the durable
 * record, and the outbox sweep delivers it when this process dies first.
 *
 * The failure log carries a fixed code. It never carries the host, the run,
 * or the error text: a wake failure can echo a request body, and the address
 * space of a scenario host is not a log field.
 */
export async function deliveryHint(hostId: string): Promise<void> {
  try {
    await tryWakeHostRuntime(hostId);
  } catch {
    console.warn(
      JSON.stringify({ event: "scenario_start_delivery_hint_failed" }),
    );
  }
}

export function cancelRunStatement(
  input: { runId: string; userId: string; hostId: string },
  now: number,
): D1PreparedStatement {
  return env.DB.prepare(
    "UPDATE scenario_runs SET state = 'teardown_requested'," +
      " state_rank = ?1, delete_requested_at = coalesce(delete_requested_at, ?2)," +
      " updated_at = ?2 WHERE run_id = ?3 AND user_id = ?4" +
      " AND host_id = ?5 AND state = 'provisioning'",
  ).bind(
    RUN_PHASE_ORDER.teardown_requested,
    now,
    input.runId,
    input.userId,
    input.hostId,
  );
}

export interface AdmissionHostAllocation {
  hostId: string;
  readiness: AdmissionHostReadiness;
  expectedVersion: number;
  nextVersion: number;
  nextDocJson: string;
}

export interface AdmissionCommitInput {
  run: typeof scenarioRuns.$inferInsert & { hostId: string };
  sshKeyRows: Array<typeof scenarioRunSshKeys.$inferInsert>;
  runtimeVms: Array<RuntimeVmSpec & { runtimeVmId: string }>;
  accessKeys: Array<{ ciphertextB64: string; ivB64: string }>;
  desiredVms: DesiredVmV3[];
  desired: AdmissionHostAllocation;
  cpuMillis: number;
  reservationResources: RuntimeResourceDemand;
  leaseExpiresAt: number | null;
  /** Administrative proof may admit a run while the cut-over gate is drained. */
  allowDrainedAdminProof?: boolean;
  /** The live revision a revision-model start read, if any. */
  revisionAnchor?: string | null;
  /** The scope whose verify quota a verify run takes, if it is one. */
  verifyScopeKey?: string | null;
  now: number;
}

export type AdmissionCommitOutcome =
  | { ok: true }
  | { ok: false; reason: "cas_lost" }
  | { ok: false; reason: "duplicate_key" }
  | { ok: false; reason: "error"; error: unknown };

export async function commitAdmissionBatch(
  input: AdmissionCommitInput,
): Promise<AdmissionCommitOutcome> {
  let results: D1Result<unknown>[];
  const batch = admissionStatements(input);
  try {
    results = await env.DB.batch(batch.statements);
  } catch (error) {
    if (errorChainMatches(error, /runtime_executions_generation_positive/)) {
      return { ok: false, reason: "cas_lost" };
    }
    // SQLite reports the violated columns, not the index name, so both forms
    // are matched. Without the column form this branch never fired and a
    // same-key race surfaced as a false active-run conflict.
    if (
      errorChainMatches(
        error,
        /scenario_runs_request_idempotency_uidx|UNIQUE constraint failed.*request_idempotency_key/,
      )
    ) {
      return { ok: false, reason: "duplicate_key" };
    }
    // A same-key race can be rejected by a different unique constraint than
    // the idempotency index: the loser's run row also collides with the
    // one-active-run index. The key is therefore re-read before such a
    // failure is reported as a conflict, so the loser replays the winner's
    // run instead of returning a false "you already have an active run".
    if (isActiveKeyUniqueViolation(error)) {
      if (await runExistsForIdempotencyKey(input)) {
        return { ok: false, reason: "duplicate_key" };
      }
      return { ok: false, reason: "error", error: activeRunConflictError() };
    }
    return { ok: false, reason: "error", error };
  }
  if (rowCount(results[batch.runGateIndex]) === 0) {
    // The run insert selects through the owner's active account, the enabled
    // host, the idempotency guard, the cut-over gate, and the revision anchor.
    // Zero rows means an anchor refused and D1 rolled the whole batch back, so
    // report the anchor that actually refused instead of a generic error.
    return { ok: false, reason: "error", error: await admissionRefusal(input) };
  }
  return { ok: true };
}

/**
 * True when the run row of this exact idempotency key is already committed.
 * It is the authority that decides whether a failed attempt was a race against
 * the same key rather than a genuine conflict.
 */
async function runExistsForIdempotencyKey(
  input: AdmissionCommitInput,
): Promise<boolean> {
  const stored = await loadRunByIdempotencyKey(
    drizzle(env.DB),
    input.run.userId,
    input.run.requestIdempotencyKey ?? "",
  );
  return stored !== null;
}

/**
 * Names the anchor that refused the run insert: the live revision or the
 * verify slot moved inside the read-to-commit window, the gate drained, or
 * content access changed. A still-active account with none of those is the
 * remaining refusal.
 */
async function admissionRefusal(input: AdmissionCommitInput) {
  if (input.revisionAnchor && !(await liveRevisionHolds(env.DB, input.run.scenarioId, input.revisionAnchor))) {
    throw scenarioSourceChanged();
  }
  if (input.verifyScopeKey) {
    const refusal = await verifyRefusal(env.DB, input.run.scenarioId, input.run.scenarioRev ?? "", input.verifyScopeKey);
    if (refusal) throw refusal;
  }
  await assertAdmissionRefusalPriority({
    userId: input.run.userId,
    ...(input.allowDrainedAdminProof
      ? { allowDrainedAdminProof: true }
      : {}),
  });
  await assertCurrentContentAccess(input.run, input.allowDrainedAdminProof);
  return scenarioStartAccessRevoked();
}

function admissionContentAccess(
  run: AdmissionCommitInput["run"],
  allowDrainedAdminProof = false,
): AdmissionContentAccess {
  return {
    userId: run.userId,
    organizationId: run.organizationId ?? null,
    scenarioId: run.scenarioId,
    courseScopeKey: run.courseScopeKey ?? null,
    courseId: run.courseId ?? null,
    lectureId: run.lectureId ?? null,
    allowSequenceBypass: run.requestScopeJson?.allowSequenceBypass === true,
    requiresAdmin: allowDrainedAdminProof ||
      run.requestScopeJson?.allowDrainedAdminProof === true ||
      run.requestScopeJson?.allowSequenceBypass === true,
    launchSource: run.launchSource ?? null,
    scenarioRev: run.scenarioRev ?? null,
  };
}

export async function assertCurrentContentAccess(run: AdmissionCommitInput["run"], allowDrainedAdminProof = false) {
  const row = await env.DB.prepare(
    "SELECT " + admissionContentAccessCondition(1) + " AS allowed",
  )
    .bind(JSON.stringify(admissionContentAccess(run, allowDrainedAdminProof)))
    .first<{ allowed: number }>();
  if (row?.allowed !== 1) {
    throw appError(
      409,
      "scenario_content_access_changed",
      "scenario, course, or administrator access changed during admission",
    );
  }
}

/**
 * Raises the refusal that outranks a lost compare-and-set or a refused insert,
 * from fresh reads. A drained cut-over gate is a 503 and a revoked account is
 * a 403; both are final, while the capacity conflict is retryable.
 * Without this ordering a client would keep retrying a fence that cannot pass.
 */
export async function assertAdmissionRefusalPriority(input: {
  userId: string;
  allowDrainedAdminProof?: boolean;
}): Promise<void> {
  await assertAgentKvmRunsOpen(env.DB, {
    ...(input.allowDrainedAdminProof
      ? { allowDrainedAdminProof: true }
      : {}),
  });
  await assertAccountActive(input.userId);
}

function rowCount(result: D1Result<unknown> | undefined): number {
  const rows = result?.results;
  return Array.isArray(rows) ? rows.length : 0;
}

export interface AdmissionBatch {
  statements: D1PreparedStatement[];
  /**
   * Index of the statement whose insertion is the admission gate. Zero rows
   * there means the run was refused, and the abort sentinel rolls the whole
   * batch back.
   */
  runGateIndex: number;
}

/** @internal Exported for adversarial D1-boundary tests. */
export function admissionStatements(input: AdmissionCommitInput): AdmissionBatch {
  const run = input.run;
  const statements = [
    // The run references the execution, so insert the execution first. Both
    // require an active owner account through the placement guard. The run
    // also checks content access and the host snapshot; the sentinel rolls
    // the execution back if either check fails.
    runtimeExecutionStatement(run, input),
    insertRunStatement(run, input),
    runRefusedSentinelStatement(run, input),
    ...sshKeyStatements(run, input.sshKeyRows),
    desiredStateCasStatement(run, input),
    casSentinelStatement(run),
    cpuQuotaStatement(run, input),
    ...runtimeVmStatements(run, input),
    resourceReservationStatement(run, input),
    activeSlotStatement(run),
  ];
  return { statements, runGateIndex: 1 };
}

const RUN_INSERT_COLUMNS = [
  "run_id",
  "user_id",
  "organization_id",
  "runtime_execution_id",
  "host_id",
  "scenario_id",
  "scenario_name",
  "course_scope_key",
  "course_id",
  "course_title",
  "lecture_id",
  "lecture_title",
  "lecture_summary",
  "lecture_body_markdown",
  "lecture_ordinal",
  "lecture_count",
  "title",
  "tagline",
  "briefing_markdown",
  "objectives_json",
  "difficulty",
  "estimated_minutes",
  "tags_json",
  "hints_json",
  "solution_markdown",
  "revealed_hints_json",
  "solution_revealed_at",
  "solution_assisted",
  "vm_count",
  "state",
  "state_rank",
  "active_key",
  "request_idempotency_key",
  "request_scope_json",
  "state_json",
  "archive_entered_at",
  "delete_requested_at",
  "solved_at",
  "completed_at",
  "failed_at",
  "hidden_at",
  "created_at",
  "updated_at",
  "scenario_rev",
  "tasks_json",
  "launch_source",
  "ref",
];

/**
 * The cut-over gates travel inside the insert so a drain that lands in the
 * commit window refuses the run instead of racing the fleet's pause. An
 * administrative proof start may bypass only the operator drain.
 */
function drainGateCondition(allowDrainedAdminProof: boolean | undefined) {
  return " AND NOT " + runsHeldCondition(allowDrainedAdminProof);
}

function insertRunStatement(
  run: typeof scenarioRuns.$inferInsert & { hostId: string },
  input: AdmissionCommitInput,
): D1PreparedStatement {
  const values: Array<string | number | null> = [
    run.runId,
    run.userId,
    run.organizationId ?? null,
    run.runtimeExecutionId ?? null,
    run.scenarioId,
    run.scenarioName,
    run.courseScopeKey ?? null,
    run.courseId ?? null,
    run.courseTitle ?? null,
    run.lectureId ?? null,
    run.lectureTitle ?? null,
    run.lectureSummary ?? null,
    run.lectureBodyMarkdown ?? null,
    run.lectureOrdinal ?? null,
    run.lectureCount ?? null,
    run.title,
    run.tagline,
    run.briefingMarkdown,
    run.objectivesJson,
    run.difficulty,
    run.estimatedMinutes,
    JSON.stringify(run.tagsJson),
    JSON.stringify(run.hintsJson),
    run.solutionMarkdown,
    JSON.stringify(run.revealedHintsJson ?? []),
    run.solutionRevealedAt ?? null,
    run.solutionAssisted ? 1 : 0,
    run.vmCount,
    run.state,
    run.stateRank,
    run.activeKey ?? null,
    run.requestIdempotencyKey ?? null,
    run.requestScopeJson ? JSON.stringify(run.requestScopeJson) : null,
    run.stateJson,
    run.archiveEnteredAt ?? null,
    run.deleteRequestedAt ?? null,
    run.solvedAt ?? null,
    run.completedAt ?? null,
    run.failedAt ?? null,
    run.hiddenAt ?? null,
    run.createdAt as number,
    run.updatedAt as number,
    run.scenarioRev ?? null,
    run.tasksJson ? JSON.stringify(run.tasksJson) : null,
    run.launchSource ?? null,
    run.ref ?? null,
  ];
  const hostParam = values.length + 1;
  const userParam = values.length + 2;
  const anchorParam = values.length + 3;
  const revisionAnchor = input.revisionAnchor ?? null;
  const verifyScopeKey = input.verifyScopeKey ?? null;
  const anchorCondition = verifyScopeKey
    // host_id takes no bound value, so a later column's index is its parameter number.
    ? verifyAnchorCondition(RUN_INSERT_COLUMNS.indexOf("scenario_id"),
      RUN_INSERT_COLUMNS.indexOf("scenario_rev"), anchorParam) + " AND host.scope = 'platform'"
    : revisionAnchor
      ? liveRevisionAnchorCondition(RUN_INSERT_COLUMNS.indexOf("scenario_id") + 1, anchorParam)
      : null;
  const anchorParams: string[] = verifyScopeKey ? [verifyScopeKey] : revisionAnchor ? [revisionAnchor] : [];
  const readinessParam = anchorParam + anchorParams.length;
  const contentParam = readinessParam + 1;
  // host_id is the fifth column and takes the host row id, so the host join
  // supplies that one expression and the bound values supply the rest.
  const hostIdColumnIndex = RUN_INSERT_COLUMNS.indexOf("host_id");
  const placeholders = values.flatMap((_, index) => {
    const bound = "?" + String(index + 1);
    return index === hostIdColumnIndex ? ["host.id", bound] : [bound];
  });
  const sqlText =
    "INSERT INTO scenario_runs (" +
    RUN_INSERT_COLUMNS.join(", ") +
    ") SELECT " +
    placeholders.join(", ") +
    " FROM agent_hosts host" +
    " WHERE host.id = ?" +
    String(hostParam) +
    " AND host.disabled = 0 AND host.role = 'agent'" +
    " AND host.scenario_enabled = 1" +
    " AND " + metalAdmissionSql("?" + String(userParam), "?3") +
    " AND " + admissionHostReadinessCondition(readinessParam) +
    " AND " + admissionContentAccessCondition(contentParam) +
    drainGateCondition(input.allowDrainedAdminProof) +
    (anchorCondition ? " AND " + anchorCondition : "") +
    " RETURNING run_id";
  return env.DB.prepare(sqlText).bind(
    ...values,
    run.hostId,
    run.userId,
    ...anchorParams,
    JSON.stringify(input.desired.readiness),
    JSON.stringify(admissionContentAccess(run, input.allowDrainedAdminProof)),
  );
}

function sshKeyStatements(
  run: typeof scenarioRuns.$inferInsert & { hostId: string },
  sshKeyRows: Array<typeof scenarioRunSshKeys.$inferInsert>,
): D1PreparedStatement[] {
  return sshKeyRows.map((key) =>
    env.DB.prepare(
      "INSERT INTO scenario_run_ssh_keys (" +
        "id, run_id, vm_id, runtime_vm_name, public_key_openssh," +
        " private_key_ciphertext_b64, private_key_iv_b64, created_at" +
        ") SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8" +
        " FROM scenario_runs run" +
        " WHERE run.run_id = ?2 AND run.user_id = ?9 AND run.host_id = ?10" +
        " AND run.state = 'provisioning'",
    ).bind(
      key.id,
      key.runId,
      key.vmId,
      key.runtimeVmName,
      key.publicKeyOpenssh,
      key.privateKeyCiphertextB64,
      key.privateKeyIvB64,
      key.createdAt,
      run.userId,
      run.hostId,
    ),
  );
}

function cpuQuotaStatement(
  run: typeof scenarioRuns.$inferInsert & { hostId: string },
  input: AdmissionCommitInput,
): D1PreparedStatement {
  // The CPU quota is the strict-isolation record for this run. It is written
  // under the same desired-state version fence as the run, so a lost
  // compare-and-set leaves neither the run nor the quota behind.
  return admissionCpuQuotaStatement({
    d1: env.DB,
    runId: run.runId,
    userId: run.userId,
    hostId: run.hostId,
    cpuMillis: input.cpuMillis,
    desiredVersion: input.desired.nextVersion,
    nowUnixMs: input.now,
  });
}

function desiredStateCasStatement(
  run: typeof scenarioRuns.$inferInsert & { hostId: string },
  input: AdmissionCommitInput,
): D1PreparedStatement {
  return env.DB.prepare(
    "UPDATE host_desired_state" +
      " SET version = ?1, doc_json = ?2, updated_at = ?3" +
      " WHERE host_id = ?4 AND version = ?5" +
      " AND EXISTS (SELECT 1 FROM scenario_runs run" +
      " WHERE run.run_id = ?6 AND run.host_id = ?4)",
  ).bind(
    input.desired.nextVersion,
    input.desired.nextDocJson,
    input.now,
    run.hostId,
    input.desired.expectedVersion,
    run.runId,
  );
}

function casSentinelStatement(
  run: typeof scenarioRuns.$inferInsert & { hostId: string },
): D1PreparedStatement {
  // A deliberately invalid generation is the abort sentinel. The generated
  // CHECK constraint aborts the entire batch when it is selected.
  //
  // The condition is the presence of this run's own VMs in the committed
  // document, not the version number. Two concurrent admissions of one host
  // both compute the same next version, so a version comparison stays silent
  // for the loser even though its compare-and-set never landed. The loser
  // would then commit a run whose VMs no host ever receives: the capacity
  // fence would be a no-op and the run would boot nothing.
  return env.DB.prepare(
    "INSERT INTO runtime_executions (" +
      "id, user_id, organization_id, host_id, provider_kind," +
      " provider_connection_id, domain_kind, domain_id, generation," +
      " source_execution_id, checkpoint_id, state, lease_expires_at," +
      " archive_requested_at, ended_at, created_at, updated_at" +
      ") SELECT '__admission_desired_cas__:' || run.run_id, run.user_id," +
      " run.organization_id, run.host_id, 'agent_kvm', NULL, 'scenario'," +
      " run.run_id, 0, NULL, NULL, 'queued', NULL, NULL, NULL," +
      " run.created_at, run.updated_at" +
      " FROM scenario_runs run" +
      " WHERE run.run_id = ?1" +
      " AND NOT EXISTS (SELECT 1 FROM host_desired_state desired," +
      " json_each(desired.doc_json, '$.vms') vm" +
      " WHERE desired.host_id = run.host_id" +
      " AND json_extract(vm.value, '$.run_id') = run.run_id)",
  ).bind(run.runId);
}

function runtimeExecutionStatement(
  run: typeof scenarioRuns.$inferInsert & { hostId: string },
  input: AdmissionCommitInput,
): D1PreparedStatement {
  // The execution is inserted before the run row because the run row
  // references it. Both statements carry the same placement guard, which
  // requires an active owner account, so a revoked account refuses both.
  return env.DB.prepare(
    "INSERT INTO runtime_executions (" +
      "id, user_id, organization_id, host_id, provider_kind," +
      " provider_connection_id, domain_kind, domain_id, generation," +
      " source_execution_id, checkpoint_id, state, lease_expires_at," +
      " archive_requested_at, ended_at, created_at, updated_at" +
      ") SELECT coalesce(?1, ?2), ?3, ?4, ?5, 'agent_kvm', NULL," +
      " 'scenario', ?2, 1, NULL, NULL, 'provisioning', ?6," +
      " NULL, NULL, ?7, ?7" +
      " FROM agent_hosts host" +
      " WHERE host.id = ?5 AND host.disabled = 0" +
      " AND " + metalAdmissionSql("?3", "?4"),
  ).bind(
    run.runtimeExecutionId ?? null,
    run.runId,
    run.userId,
    run.organizationId ?? null,
    run.hostId,
    input.leaseExpiresAt,
    input.now,
  );
}

/**
 * Aborts the batch when the admission gate refused the run while the owner's
 * account is still active. That combination means an anchor other than the
 * account refused the insert - a duplicate idempotency key or an occupied
 * active slot - and a partial admission must not survive. An inactive owner
 * leaves the sentinel silent: the placement guard refused both inserts, so
 * the start reports the revoked account instead of a retryable conflict.
 */
function runRefusedSentinelStatement(
  run: typeof scenarioRuns.$inferInsert & { hostId: string },
  input: AdmissionCommitInput,
): D1PreparedStatement {
  return env.DB.prepare(
    "INSERT INTO runtime_executions (" +
      "id, user_id, organization_id, host_id, provider_kind," +
      " provider_connection_id, domain_kind, domain_id, generation," +
      " source_execution_id, checkpoint_id, state, lease_expires_at," +
      " archive_requested_at, ended_at, created_at, updated_at" +
      ") SELECT '__admission_run_refused__:' || ?1, ?2, ?3, ?4," +
      " 'agent_kvm', NULL, 'scenario', ?1, 0, NULL, NULL, 'queued'," +
      " NULL, NULL, NULL, ?5, ?5" +
      " WHERE NOT EXISTS (SELECT 1 FROM scenario_runs run" +
      " WHERE run.run_id = ?1)" +
      " AND " + activeAccountExistsSql("?2"),
  ).bind(
    run.runId,
    run.userId,
    run.organizationId ?? null,
    run.hostId,
    input.now,
  );
}
function runtimeVmStatements(
  run: typeof scenarioRuns.$inferInsert & { hostId: string },
  input: AdmissionCommitInput,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const [index, vm] of input.runtimeVms.entries()) {
    statements.push(
      env.DB.prepare(
        "INSERT INTO runtime_vms (" +
          "id, execution_id, vm_id, ordinal, runtime_vm_name," +
          " image_digest, spec_digest, kino_digest, cpu_millis, memory_mib, disk_mib," +
          " created_at, updated_at" +
          ") SELECT ?1, run.runtime_execution_id, ?2, ?3, ?4, ?5, ?6, ?7, ?8," +
          " ?9, ?10, ?11, ?11" +
          " FROM scenario_runs run" +
          " WHERE run.run_id = ?12 AND run.runtime_execution_id = ?13" +
          " AND run.state = 'provisioning'",
      ).bind(
        vm.runtimeVmId,
        vm.vmId,
        vm.ordinal,
        vm.runtimeVmName,
        vm.imageDigest,
        vm.specDigest,
        vm.kinoDigest,
        vm.cpuMillis,
        vm.memoryMib,
        vm.diskMib,
        input.now,
        run.runId,
        run.runId,
      ),
    );
    const accessKey = input.accessKeys[index];
    const desired = input.desiredVms.find((candidate) => candidate.vm_id === vm.runtimeVmName);
    const publicKey = desired?.ssh_authorized_keys[0] ?? "";
    if (!accessKey || !publicKey) {
      throw new Error("runtime VM access key material is incomplete");
    }
    statements.push(
      env.DB.prepare(
        "INSERT INTO runtime_vm_access_keys (" +
          "runtime_vm_id, execution_id, public_key_openssh," +
          " private_key_ciphertext_b64, private_key_iv_b64, created_at" +
          ") SELECT ?1, run.runtime_execution_id, ?2, ?3, ?4, ?5" +
          " FROM scenario_runs run" +
          " WHERE run.run_id = ?6 AND run.runtime_execution_id = ?7" +
          " AND run.state = 'provisioning'",
      ).bind(
        vm.runtimeVmId,
        publicKey,
        accessKey.ciphertextB64,
        accessKey.ivB64,
        input.now,
        run.runId,
        run.runId,
      ),
    );
  }
  return statements;
}

function resourceReservationStatement(
  run: typeof scenarioRuns.$inferInsert & { hostId: string },
  input: AdmissionCommitInput,
): D1PreparedStatement {
  return admissionResourceReservationStatement({
    d1: env.DB,
    runId: run.runId,
    hostId: run.hostId,
    resources: input.reservationResources,
    expiresAt: input.now + RUNTIME_PENDING_RESOURCE_RESERVATION_TTL_MS,
    nowUnixMs: input.now,
  });
}

function activeSlotStatement(
  run: typeof scenarioRuns.$inferInsert & { hostId: string },
): D1PreparedStatement {
  // No conflict handler is intentional: a slot owned by another runtime
  // aborts the whole batch, exactly like the previous projection. Verify
  // runs share one account and hold no slot: their own active keys bound
  // them.
  return env.DB.prepare(
    "INSERT INTO active_runtime_slots (user_id, execution_id, acquired_at)" +
      " SELECT run.user_id, run.runtime_execution_id, run.created_at" +
      " FROM scenario_runs run" +
      " WHERE run.run_id = ?1 AND run.active_key IS NOT NULL" +
      " AND run.runtime_execution_id IS NOT NULL" +
      " AND run.launch_source IS NOT 'verify'",
  ).bind(run.runId);
}
