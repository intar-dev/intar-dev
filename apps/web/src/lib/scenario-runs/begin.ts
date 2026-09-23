import { env } from "cloudflare:workers";
import { metalAdmissionSql } from "@/lib/metal-placement";
import { and, eq } from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import type {
  DesiredGuestToolsV1,
  DesiredVmV2,
  HostDesiredStateV2,
} from "@/generated/bridge";
import {
  admissionCpuQuotaStatement,
  admissionResourceReservationStatement,
  cpuReservationForVms,
  hostCpuReservationCapacityFromSnapshot,
} from "@/control-plane/host-cpu-reservations";
import {
  isSafeBuildId,
  isSafeBundleRev,
} from "@/control-plane/image-registry/shared";
import {
  hostCpuReservations,
  scenarioRuns,
  scenarioRunSshKeys,
} from "@/db/schema";
import type { ScenarioStartRequestScope } from "@/db/schema/runs";
import {
  activeAccountExistsSql,
  activeAccountSql,
  isActiveAccount,
} from "@/lib/account-access";
import { appError, AppError, errorChainMatches } from "@/lib/app-error";
import {
  applyLectureBriefingPresentation,
  assertCourseScenarioStartAllowed,
} from "@/lib/course-catalogs";
import {
  desiredVmFromRunVm,
  markDesiredVmAbsent,
  mutateDesiredState,
  upsertDesiredCachedImage,
  upsertDesiredGuestTools,
  upsertDesiredVm,
} from "@/lib/desired-state";
import { loadOrCreateHostDesiredState } from "@/lib/desired-state-store";
import { tryWakeHostRuntime } from "@/lib/host-runtime-wake";
import { createAppId } from "@/lib/id";
import { requireIdempotencyKey } from "@/lib/idempotency-key";
import {
  admitInternalRegistryOperation,
  type RegistryOperationLease,
} from "@/lib/image-registry-admission";
import { assertAgentKvmRunsOpen } from "@/lib/run-admission-gate";
import {
  availableRuntimeHostResources,
  loadActiveRuntimeResourceSnapshot,
  RUNTIME_PENDING_RESOURCE_RESERVATION_TTL_MS,
  runtimeResourcesFit,
  type RuntimeResourceDemand,
} from "@/lib/runtime-capacity";
import { encryptRuntimeVmAccessKey } from "@/lib/runtime-vm-state";
import {
  RUN_PHASE_ORDER,
  buildInitialRunState,
  buildInitialVmState,
  recomputeRunState,
  type RunStateDocument,
  type RunVmStateDocument,
} from "@/lib/run-state";
import type { RuntimeVmSpec } from "@/lib/runtime-executions";
import { candidateScenarioId } from "@/lib/scenario-catalog-candidates";
import { loadScenarioGuestToolsPin } from "@/lib/scenario-guest-tools";
import { preparePersonalScenarioImages } from "@/lib/personal-image-preparation";
import type { ScenarioLaunchSpec } from "@/lib/scenario-model";
import {
  generateScenarioRunSshKeyDraft,
  prepareScenarioRunSshKeyRows,
} from "@/lib/scenario-run-ssh-keys";
import { traceOperation } from "@/lib/tracing";
import { loadCandidateScenarioRunSource } from "./candidate";
import {
  admissionContentAccessCondition,
  admissionHostReadinessCondition,
  type AdmissionContentAccess,
  type AdmissionHostReadiness,
} from "./admission-guards";
import { deterministicRuntimeVmName } from "./runtime-vm-name";
import {
  type RequiredScenarioImage,
} from "@/lib/scenario-host-readiness";
import {
  assertScenarioLaunchHostForUser,
  loadScenarioLaunchHostForUser,
  isActiveKeyUniqueViolation,
  requiredImagesForScenarioLaunch,
  scenarioRuntimeReservationResources,
  selectScenarioHosts,
} from "./start";
import {
  activeKeyFor,
  activeRunConflictError,
  loadActiveRunRow,
  loadEnabledScenarioRows,
  type ScenarioRunLaunchSource,
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
  candidateRevision?: string;
  candidateBuildId?: string;
  allowDrainedAdminProof?: boolean;
  allowSequenceBypass?: boolean;
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

/** The candidate identity one start asks for. */
interface CandidateRequest {
  revision: string;
  buildId: string;
}

/**
 * The proof the commit anchors on: the requested identity plus the exact
 * stored text of the candidate manifest the start read.
 */
interface CandidateProof extends CandidateRequest {
  /**
   * The exact stored text of the candidate manifest the start read. The commit
   * batch compares it with the candidate row, so a republish that rewrote the
   * row inside the read-to-commit window refuses the run instead of committing
   * the spec it was built from.
   */
  manifestText: string;
}

/**
 * The live-catalog image identity one start read, as one JSON array of the
 * per-VM refs plus the VM count of that read. It travels into the commit batch
 * so the run insert compares the catalog rows against the exact read the run
 * was built from, without a database column of its own.
 */
interface LiveSourceFingerprint {
  json: string;
  vmCount: number;
}

/**
 * Captures the image identity of a live source read. A live start has no
 * candidate row to anchor on, so this is what proves at commit time that the
 * catalog still describes the images the run was built from. Only identity is
 * captured: presentation, probe, and resource metadata may change inside the
 * window, because the run carries the values it reserved.
 */
function liveSourceFingerprint(
  launchSpecs: readonly ScenarioLaunchSpec[],
): LiveSourceFingerprint {
  const refs = launchSpecs.map((spec) => {
    const ref = spec.imageRef;
    if (!ref) {
      throw appError(
        500,
        "scenario_catalog_invalid",
        "scenario VM " + spec.scenarioVmName + " has no image identity",
      );
    }
    return {
      name: ref.vmName,
      keyScenario: ref.keyScenario,
      keyVm: ref.keyVm,
      keyArch: ref.keyArch,
      imageId: ref.imageSha256,
      manifest: ref.chunkManifestSha256,
      kernel: ref.kernelSha256,
      initrd: ref.initrdSha256,
    };
  });
  return { json: JSON.stringify(refs), vmCount: refs.length };
}

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
      const candidateRequest = candidateRequestFromInput(input);
      // The run start is a shared registry writer for its whole read-to-commit
      // window: it reads a scenario image reference and then commits the run
      // and the desired VMs that point at that image. Without the writer a
      // collector sweep could retire the candidate and delete the image objects
      // in between, and the committed run would reference an image that no
      // longer exists. The writer also refuses the start while a sweep holds
      // the gate, so the two can never overlap in either direction.
      const registryGuard = await openRunStartRegistryGuard(input.userId);
      let outcome: "ok" | "error" = "error";
      try {
        const result = await admitScenarioStart(input, {
          idempotencyKey,
          organizationId,
          candidateRequest,
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
async function openRunStartRegistryGuard(
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
    candidateRequest: CandidateRequest | null;
  },
): Promise<BeginScenarioRunResult> {
  const { idempotencyKey, organizationId, candidateRequest } = prelude;
  const scope = scenarioStartRequestScope(input, input.scenarioId);
  const db = drizzle(env.DB);
  const [source, active] = await Promise.all([
    loadScenarioForStart({
      db,
      scenarioId: input.scenarioId,
      organizationId,
      candidateRequest,
    }),
    loadActiveRunRow(input.userId),
  ]);
  if (!source) {
    if (candidateRequest) {
      throw scenarioCandidateNotReady();
    }
    throw appError(404, "scenario_not_found", "scenario not found");
  }
  const scenario = source.scenario;
  // Resolve the V2 unit before any reuse can return, so an old direct
  // request cannot revive an unlinked scenario around the course gate.
  const courseLecture = await assertCourseScenarioStartAllowed({
    db,
    userId: input.userId,
    organizationId,
    scenarioId: scenario.scenarioId,
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

  return admitNewRun({
    input,
    scenario,
    organizationId,
    courseLecture,
    idempotencyKey,
    // The commit anchors on the source this start really read, never on the
    // proof the caller asked for.
    candidateProof: source.candidateProof,
    scope,
  });
}

function scenarioCandidateNotReady() {
  return appError(
    409,
    "scenario_candidate_not_ready",
    "candidate scenario is unavailable or not ready",
  );
}

/**
 * The live catalog changed inside the read-to-commit window, so this request
 * would launch an image the catalog no longer describes. It is a decision on
 * this request only: a start against fresh reads is a new admission.
 */
function scenarioSourceChanged() {
  return appError(
    409,
    "scenario_source_changed",
    "the scenario image changed while the run was starting; start it again",
  );
}

/** Validates the candidate identity one caller asks for, before any read. */
function candidateRequestFromInput(
  input: BeginScenarioRunInput,
): CandidateRequest | null {
  const revision =
    input.candidateRevision === undefined
      ? null
      : input.candidateRevision.trim();
  const buildId =
    input.candidateBuildId === undefined ? null : input.candidateBuildId.trim();
  if ((revision === null) !== (buildId === null)) {
    throw appError(
      400,
      "candidate_proof_identity_incomplete",
      "candidate revision and build id are both required",
    );
  }
  if (revision === null || buildId === null) {
    return null;
  }
  if (!isSafeBundleRev(revision) || !isSafeBuildId(buildId)) {
    throw appError(
      400,
      "candidate_proof_identity_invalid",
      "candidate revision or build id is invalid",
    );
  }
  if (!input.allowDrainedAdminProof) {
    throw appError(
      403,
      "candidate_proof_admin_required",
      "candidate proofs require administrator authorization",
    );
  }
  return { revision, buildId };
}

function scenarioStartRequestScope(
  input: BeginScenarioRunInput,
  scenarioId: string,
): ScenarioStartRequestScope {
  return {
    scenarioId,
    organizationId: input.organizationId ?? null,
    hostId: input.hostId ?? null,
    candidateRevision: input.candidateRevision?.trim() ?? null,
    candidateBuildId: input.candidateBuildId?.trim() ?? null,
    allowDrainedAdminProof: input.allowDrainedAdminProof === true,
    allowSequenceBypass: input.allowSequenceBypass === true,
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

async function loadRunByIdempotencyKey(
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

function assertReplayMatchesScope(
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


async function loadScenarioForStart(input: {
  db: DrizzleD1Database;
  scenarioId: string;
  organizationId: string | null;
  candidateRequest: CandidateRequest | null;
}): Promise<ScenarioStartSource | null> {
  if (input.candidateRequest) {
    const scenario = await loadCandidateScenarioRunSource(input.db, {
      revision: input.candidateRequest.revision,
      buildId: input.candidateRequest.buildId,
      scenarioId: input.scenarioId,
      organizationId: input.organizationId,
    });
    if (!scenario) return null;
    return {
      scenario,
      // The proof gains the manifest text of this read, which is what makes the
      // commit anchor exact instead of a check of the row identity alone.
      candidateProof: {
        ...input.candidateRequest,
        manifestText: scenario.candidateManifestText,
      },
    };
  }
  const [scenario] = await loadEnabledScenarioRows(
    input.scenarioId,
    input.organizationId,
  );
  return scenario ? { scenario, candidateProof: null } : null;
}

/**
 * One start source read, with the proof its commit must anchor on. A live
 * catalog start has no proof; a candidate start carries the manifest text its
 * read returned.
 */
interface ScenarioStartSource {
  scenario: ScenarioRunLaunchSource;
  candidateProof: CandidateProof | null;
}

async function assertAccountActive(userId: string): Promise<void> {
  if (!(await isActiveAccount(userId))) throw scenarioStartAccessRevoked();
}

async function assertAccountStillActive(input: {
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
function deliveryHint(hostId: string): Promise<void> {
  return tryWakeHostRuntime(hostId).catch(() => {
    console.warn(
      JSON.stringify({ event: "scenario_start_delivery_hint_failed" }),
    );
  });
}

/**
 * Cancels a run that became durable inside the commit window but failed its
 * post-commit account fence.
 *
 * Both writes travel in one D1 transaction. Marking the VMs absent without
 * moving the run out of provisioning would leave a run that no reconcile can
 * release: the CPU quota is committed, so only a terminal or deleting run
 * releases it, and a crash between two separate transactions would hold that
 * quota until the lease expired.
 *
 * The desired-state publish is a compare-and-set. A lost compare-and-set means
 * another writer published in between, so the cancel retries against the new
 * version instead of overwriting it.
 */
export async function cancelAdmittedRun(input: {
  runId: string;
  userId: string;
  hostId: string;
  vms: RunStateDocument;
}): Promise<void> {
  const now = Date.now();
  const teardownVms = input.vms.vms.filter((vm) => vm.phase !== "completed");
  for (let attempt = 0; attempt < ADMISSION_CAS_ATTEMPTS; attempt += 1) {
    const current = await loadOrCreateHostDesiredState(
      drizzle(env.DB),
      input.hostId,
      now,
    );
    const next = mutateDesiredState(
      current,
      (draft) => {
        for (const vm of teardownVms) {
          markDesiredVmAbsent(draft, {
            runId: input.runId,
            vmName: vm.runtimeVmName,
          });
        }
      },
      { nowUnixMs: now },
    );
    const statements =
      next === current
        ? [cancelRunStatement(input, now)]
        : [
            cancelDesiredStateStatement(input, current.version, next),
            cancelRunStatement(input, now),
            cancelSentinelStatement(input, next.version),
          ];
    try {
      await env.DB.batch(statements);
      await deliveryHint(input.hostId);
      return;
    } catch (error) {
      if (errorChainMatches(error, /runtime_executions_generation_positive/)) {
        continue;
      }
      throw error;
    }
  }
  throw appError(
    409,
    "scenario_host_capacity_contended",
    "scenario capacity changed while cancelling the start",
  );
}

function cancelRunStatement(
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

function cancelDesiredStateStatement(
  input: { runId: string; hostId: string },
  expectedVersion: number,
  next: HostDesiredStateV2,
): D1PreparedStatement {
  return env.DB.prepare(
    "UPDATE host_desired_state SET version = ?1, doc_json = ?2, updated_at = ?3" +
      " WHERE host_id = ?4 AND version = ?5" +
      " AND EXISTS (SELECT 1 FROM scenario_runs run" +
      " WHERE run.run_id = ?6 AND run.host_id = ?4)",
  ).bind(
    next.version,
    JSON.stringify(next),
    Date.now(),
    input.hostId,
    expectedVersion,
    input.runId,
  );
}

/**
 * Aborts the cancel transaction when its compare-and-set did not land, so a
 * cancel can never move a run to teardown while its VMs stay desired running.
 */
function cancelSentinelStatement(
  input: { runId: string; hostId: string },
  nextVersion: number,
): D1PreparedStatement {
  return env.DB.prepare(
    "INSERT INTO runtime_executions (" +
      "id, user_id, organization_id, host_id, provider_kind," +
      " provider_connection_id, domain_kind, domain_id, generation," +
      " source_execution_id, checkpoint_id, state, lease_expires_at," +
      " archive_requested_at, ended_at, created_at, updated_at" +
      ") SELECT '__admission_cancel_cas__:' || ?1," +
      " run.user_id, run.organization_id, run.host_id, 'agent_kvm', NULL," +
      " 'scenario', run.run_id, 0, NULL, NULL, 'queued', NULL, NULL, NULL," +
      " run.created_at, run.updated_at" +
      " FROM scenario_runs run" +
      " WHERE run.run_id = ?1" +
      " AND NOT EXISTS (SELECT 1 FROM host_desired_state desired" +
      " WHERE desired.host_id = ?2 AND desired.version = ?3)",
  ).bind(input.runId, input.hostId, nextVersion);
}

async function admitNewRun(context: {
  input: BeginScenarioRunInput;
  scenario: ScenarioRunLaunchSource;
  organizationId: string | null;
  courseLecture: Awaited<
    ReturnType<typeof assertCourseScenarioStartAllowed>
  >;
  idempotencyKey: string;
  candidateProof: CandidateProof | null;
  scope: ScenarioStartRequestScope;
}): Promise<BeginScenarioRunResult> {
  const { input, scenario, organizationId, courseLecture } = context;
  const briefing = scenario.candidateSource
    ? scenario.briefing
    : applyLectureBriefingPresentation(scenario.briefing, courseLecture.lecture);

  const runId = createAppId();
  const createdAt = Date.now();
  const requiredImages = requiredImagesForScenarioLaunch(scenario.launchSpecs);
  // A candidate start anchors on its candidate proof; a live start anchors on
  // the image identity of the catalog rows it just read.
  const sourceAnchor = context.candidateProof
    ? null
    : liveSourceFingerprint(scenario.launchSpecs);
  const cpuMillisByVm = scenario.launchSpecs.map(
    (spec) => spec.resources.cpuMillis,
  );
  const runVmStates = scenario.launchSpecs.map((spec, index) => {
    const vmId = createAppId();
    const runtimeVmName = deterministicRuntimeVmName(
      spec.runtimeVmNamePrefix,
      runId,
      index,
    );
    const vm = buildInitialVmState({
      id: vmId,
      ordinal: index,
      scenarioVmId: spec.scenarioVmId,
      scenarioVmName: spec.scenarioVmName,
      runtimeVmName,
      hostname: spec.hostname,
      launchSummary: spec.summary,
    });
    return {
      ...vm,
      provisioning: {
        ...vm.provisioning,
        image: spec.image,
        imageKey: spec.imageKey,
        imageSha256: spec.imageSha256,
        resources: spec.resources,
        leaseDurationSeconds: spec.leaseDurationSeconds,
        status: "pending",
      },
    } satisfies RunVmStateDocument;
  });
  const sshKeyDrafts = runVmStates.map((vm) =>
    generateScenarioRunSshKeyDraft({
      runId,
      vmId: vm.id,
      runtimeVmName: vm.runtimeVmName,
    }),
  );
  const sshKeyDraftByVmId = new Map(
    sshKeyDrafts.map((draft) => [draft.vmId, draft]),
  );
  const sshAuthorizedKeysByVmId = new Map(
    sshKeyDrafts.map((draft) => [draft.vmId, [draft.publicKeyOpenssh]]),
  );
  const initial = buildInitialRunState({
    vms: runVmStates.map((vm) => ({
      id: vm.id,
      ordinal: vm.ordinal,
      scenarioVmId: vm.scenarioVmId,
      scenarioVmName: vm.scenarioVmName,
      runtimeVmName: vm.runtimeVmName,
      hostname: vm.hostname,
      launchSummary: vm.launchSummary,
    })),
  });
  const state = recomputeRunState({
    ...initial,
    ...(scenario.candidateSource
      ? { candidateSource: scenario.candidateSource }
      : {}),
    phase: "provisioning",
    phaseTitle: "Provisioning",
    phaseDetail: "Queueing launch delivery.",
    vms: runVmStates,
  });
  const provisionedState = recomputeRunState({
    ...state,
    vms: state.vms.map(
      (vm) =>
        ({
          ...vm,
          provisioning: {
            ...vm.provisioning,
            status: "queued",
            error: null,
          },
        }) satisfies RunVmStateDocument,
    ),
  });
  const vmStateByRuntimeVmId = new Map(
    provisionedState.vms.map((vm) => [vm.id, vm]),
  );
  const runtimeVms = runtimeVmSpecsFromScenarioState(provisionedState);
  const runtimeVmRows = runtimeVms.map((vm) => ({
    ...vm,
    runtimeVmId: createAppId(),
  }));
  const leaseDurationSeconds = Math.max(
    0,
    ...provisionedState.vms.map(
      (vm) => vm.provisioning.leaseDurationSeconds ?? 0,
    ),
  );
  const leaseExpiresAt =
    leaseDurationSeconds > 0 ? createdAt + leaseDurationSeconds * 1_000 : null;
  const reservationResources = scenarioRuntimeReservationResources(
    runtimeVms,
    cpuMillisByVm,
  );
  const cpuMillis = cpuReservationForVms(cpuMillisByVm);
  if (cpuMillis !== reservationResources.cpuMillis) {
    throw appError(
      500,
      "scenario_catalog_invalid",
      "scenario CPU reservation is inconsistent",
    );
  }

  // The guest-tools pin read, the SSH key encryption, and the runtime access
  // key encryption are independent, so they run before the first host
  // candidate is evaluated.
  const [guestTools, sshKeyRows, accessKeys] = await Promise.all([
    loadScenarioGuestToolsPin(env),
    prepareScenarioRunSshKeyRows(sshKeyDrafts, createdAt),
    Promise.all(
      runtimeVms.map((vm) => {
        const draft = sshKeyDraftByVmId.get(vm.vmId);
        if (!draft) {
          throw new Error("scenario VM SSH key draft is missing");
        }
        return encryptRuntimeVmAccessKey({
          executionId: runId,
          vmId: vm.vmId,
          runtimeVmName: vm.runtimeVmName,
          publicKeyOpenssh: draft.publicKeyOpenssh,
          privateKeyOpenssh: draft.privateKeyOpenssh,
        });
      }),
    ),
  ]);
  if (sshKeyRows.length === 0) {
    throw new Error("scenario run has no SSH key rows");
  }
  const desiredVms: DesiredVmV2[] = runtimeVms.map((vm) => {
    const vmState = vmStateByRuntimeVmId.get(vm.vmId);
    if (!vmState) {
      throw new Error("scenario VM state is missing for " + vm.runtimeVmName);
    }
    const desiredVm = desiredVmFromRunVm({
      runId,
      ownerUserId: input.userId,
      runtimeExecutionId: runId,
      generation: 1,
      vm: vmState,
      nowUnixMs: createdAt,
      sshAuthorizedKeysOpenssh: sshAuthorizedKeysByVmId.get(vm.vmId) ?? [],
      guestTools,
    });
    if (!desiredVm) {
      throw appError(
        500,
        "scenario_vm_desired_state_invalid",
        "missing desired-state image metadata for " + vm.runtimeVmName,
      );
    }
    return desiredVm;
  });

  const run = {
    runId,
    userId: input.userId,
    organizationId,
    runtimeExecutionId: runId,
    hostId: "",
    scenarioId: scenario.scenarioId,
    scenarioName: scenario.scenarioId,
    courseScopeKey: courseLecture.courseScopeKey,
    courseId: courseLecture.courseId,
    courseTitle: courseLecture.courseTitle,
    lectureId: courseLecture.lectureId,
    lectureTitle: courseLecture.lectureTitle,
    lectureSummary: courseLecture.lectureSummary,
    lectureBodyMarkdown: courseLecture.lectureBodyMarkdown,
    lectureOrdinal: courseLecture.lectureOrdinal,
    lectureCount: courseLecture.lectureCount,
    title: briefing.title,
    tagline: briefing.tagline,
    briefingMarkdown: briefing.briefingMarkdown,
    objectivesJson: JSON.stringify(briefing.objectives),
    difficulty: briefing.difficulty,
    estimatedMinutes: briefing.estimatedMinutes,
    tagsJson: briefing.tags,
    hintsJson: scenario.content.hints,
    solutionMarkdown: scenario.content.solutionMarkdown,
    revealedHintsJson: [],
    solutionRevealedAt: null,
    solutionAssisted: false,
    vmCount: provisionedState.vms.length,
    state: provisionedState.phase,
    stateRank: RUN_PHASE_ORDER[provisionedState.phase],
    activeKey: activeKeyFor(input.userId),
    requestIdempotencyKey: context.idempotencyKey,
    requestScopeJson: context.scope,
    stateJson: JSON.stringify(provisionedState),
    archiveEnteredAt: null,
    deleteRequestedAt: null,
    solvedAt: null,
    completedAt: null,
    failedAt: null,
    hiddenAt: null,
    createdAt,
    updatedAt: createdAt,
  } satisfies typeof scenarioRuns.$inferInsert;

  let preparedHostId: string | undefined;
  try {
    preparedHostId = context.candidateProof ? undefined : await preparePersonalScenarioImages({
      access: {
        userId: input.userId,
        organizationId,
        scenarioId: scenario.scenarioId,
        courseScopeKey: courseLecture.courseScopeKey,
        courseId: courseLecture.courseId,
        lectureId: courseLecture.lectureId,
        allowSequenceBypass: input.allowSequenceBypass === true,
        requiresAdmin: input.allowDrainedAdminProof === true || input.allowSequenceBypass === true,
      },
      requestKey: context.idempotencyKey,
      ...(input.hostId ? { requestedHostId: input.hostId } : {}),
      requiredImages,
      requiredResources: reservationResources,
    });
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "scenario_preparation_changed") throw error;
    // Another request can admit this key after the initial replay lookup but
    // before preparation. Its run consumes the preparation grant atomically.
    const raced = await loadRunByIdempotencyKey(drizzle(env.DB), input.userId, context.idempotencyKey);
    if (!raced) throw error;
    assertReplayMatchesScope(raced.requestScopeJson, context.scope);
    return {
      accepted: true,
      runId: raced.runId,
      scenarioId: raced.scenarioId,
      acceptedAt: raced.acceptedAt,
      reused: true,
      hostId: raced.hostId,
      deliveryHint: deliveryHint(raced.hostId),
    };
  }

  for (let attempt = 1; attempt <= ADMISSION_CAS_ATTEMPTS; attempt += 1) {
    const allocated = await allocateAdmissionHost({
      userId: input.userId,
      organizationId,
      ...(preparedHostId ? { requestedHostId: preparedHostId } : input.hostId ? { requestedHostId: input.hostId } : {}),
      requiredImages,
      reservationResources,
      cpuMillis,
      now: Date.now(),
      desiredVms,
      guestTools,
    });
    // Re-read the cut-over gate after the capacity selection and before the
    // commit. A drain that lands while this request waits for its allocation
    // must refuse the start instead of launching a VM into a paused fleet.
    await assertAgentKvmRunsOpen(env.DB, {
      ...(input.allowDrainedAdminProof
        ? { allowDrainedAdminProof: true }
        : {}),
    });
    const outcome = await commitAdmissionBatch({
      run: { ...run, hostId: allocated.hostId },
      sshKeyRows,
      runtimeVms: runtimeVmRows,
      accessKeys,
      desiredVms,
      desired: allocated,
      cpuMillis,
      reservationResources,
      leaseExpiresAt,
      candidateProof: context.candidateProof,
      sourceAnchor,
      ...(input.allowDrainedAdminProof
        ? { allowDrainedAdminProof: true }
        : {}),
      now: Date.now(),
    });
    if (outcome.ok) {
      try {
        await assertAccountStillActive({
          userId: input.userId,
          runId,
          hostId: allocated.hostId,
        });
      } catch (error) {
        await cancelAdmittedRun({
          runId,
          userId: input.userId,
          hostId: allocated.hostId,
          vms: provisionedState,
        });
        throw error;
      }
      return {
        accepted: true,
        runId,
        scenarioId: scenario.scenarioId,
        acceptedAt: createdAt,
        reused: false,
        hostId: allocated.hostId,
        deliveryHint: deliveryHint(allocated.hostId),
      };
    }
    if (outcome.reason === "duplicate_key") {
      const raced = await loadRunByIdempotencyKey(
        drizzle(env.DB),
        input.userId,
        context.idempotencyKey,
      );
      if (raced) {
        assertReplayMatchesScope(raced.requestScopeJson, context.scope);
        return {
          accepted: true,
          runId: raced.runId,
          scenarioId: raced.scenarioId,
          // The loser of the race reports the winner's run, its original
          // acceptance time, and that this request did not admit a new run.
          acceptedAt: raced.acceptedAt,
          reused: true,
          hostId: raced.hostId,
          deliveryHint: deliveryHint(raced.hostId),
        };
      }
      throw appError(
        409,
        "idempotency_key_conflict",
        "this Idempotency-Key was used for a different start request",
      );
    }
    if (outcome.reason === "cas_lost") {
      // A lost compare-and-set is usually just contention, but a drain or a
      // revoked account that landed in the same window outranks it. Without
      // this check the final attempt reports a retryable 409 and hides a fence
      // that no retry can pass. It runs only after a failed attempt, so the
      // normal path pays nothing for it.
      await assertAdmissionRefusalPriority({
        userId: input.userId,
        ...(input.allowDrainedAdminProof
          ? { allowDrainedAdminProof: true }
          : {}),
      });
      // A refused candidate anchor reports itself as the same lost
      // compare-and-set, because the abort sentinel rolls the batch back the
      // same way. Name it here: no retry can pass a candidate that a promotion
      // already retired or a live row that a publish already replaced.
      const refusal = await sourceAnchorRefusal({
        candidateProof: context.candidateProof,
        sourceAnchor,
        organizationId,
        scenarioId: scenario.scenarioId,
      });
      if (refusal) throw refusal;
      await assertCurrentContentAccess(run, input.allowDrainedAdminProof);
      if (attempt < ADMISSION_CAS_ATTEMPTS) {
        continue;
      }
      throw appError(
        409,
        "scenario_host_capacity_contended",
        "scenario capacity changed during admission; retry the start",
      );
    }
    if (outcome.reason === "error") {
      throw outcome.error;
    }
    throw appError(
      409,
      "scenario_host_capacity_contended",
      "scenario capacity changed during admission; retry the start",
    );
  }
  throw appError(
    409,
    "scenario_host_capacity_contended",
    "scenario capacity changed during admission; retry the start",
  );
}

function runtimeVmSpecsFromScenarioState(
  state: RunStateDocument,
): RuntimeVmSpec[] {
  return state.vms.map((vm) => {
    const resources = vm.provisioning.resources;
    const imageKey = vm.provisioning.imageKey;
    const imageSha256 = vm.provisioning.imageSha256?.trim() ?? "";
    if (!resources || !imageKey || !imageSha256) {
      throw appError(
        409,
        "scenario_runtime_spec_incomplete",
        "scenario VM " +
          vm.scenarioVmName +
          " is missing immutable runtime metadata",
      );
    }
    return {
      vmId: vm.id,
      ordinal: vm.ordinal,
      runtimeVmName: vm.runtimeVmName,
      imageKey,
      imageSha256,
      cpuMillis: resources.cpuMillis,
      memoryMib: resources.memoryMib,
      diskMib: resources.diskMib,
    };
  });
}

export interface AdmissionHostAllocation {
  hostId: string;
  readiness: AdmissionHostReadiness;
  expectedVersion: number;
  nextVersion: number;
  nextDocJson: string;
}

async function allocateAdmissionHost(input: {
  userId: string;
  organizationId: string | null;
  requestedHostId?: string;
  requiredImages: RequiredScenarioImage[];
  reservationResources: RuntimeResourceDemand;
  cpuMillis: number;
  now: number;
  desiredVms: DesiredVmV2[];
  guestTools: DesiredGuestToolsV1;
}): Promise<AdmissionHostAllocation> {
  return traceOperation("scenario.allocate", async () => {
    let candidateHostIds: string[];
    if (input.requestedHostId) {
      await assertScenarioLaunchHostForUser(
        input.requestedHostId,
        input.userId,
        input.requiredImages,
        input.organizationId,
      );
      // No separate capacity precheck: planAdmissionHost reads the desired
      // version, the reported capacity, and the reservation ledger for this
      // host under one consistent read order, so a precheck would only repeat
      // the same D1 reads and then race the commit.
      candidateHostIds = [input.requestedHostId];
    } else {
      const selection = await selectScenarioHosts(
        input.requiredImages,
        input.userId,
        input.reservationResources,
        input.now,
        undefined,
        input.organizationId,
      );
      if (!selection.ok) {
        throw appError(
          409,
          selection.reason === "image_not_ready"
            ? "image_not_ready"
            : "scenario_host_unavailable",
          selection.message ?? (selection.reason === "image_not_ready"
            ? "scenario images are not ready on any available host"
            : selection.reason === "resource_capacity"
              ? "no scenario host has enough CPU, memory, and worst-case disk capacity"
              : "no scenario host available"),
        );
      }
      candidateHostIds = selection.hostIds;
    }

    // Order matters here for correctness, not for style.
    //
    // The desired-state version of a candidate is read FIRST, and the host's
    // reported capacity and reservation ledger only after it. The commit batch
    // compares and sets that version, so an admission that commits in between
    // bumps the version, this request's compare-and-set fails, and it retries
    // with fresh reads, including a fresh capacity read.
    //
    // Reading the version after the capacity snapshot would let two concurrent
    // starts both charge the same free capacity: both would read the ledger at
    // one version, and the loser's compare-and-set would still succeed on the
    // version it read after the winner's commit.
    const allocation = await planAdmissionHost({
      candidateHostIds,
      userId: input.userId,
      organizationId: input.organizationId,
      requiredImages: input.requiredImages,
      explicitHost: !!input.requestedHostId,
      now: input.now,
      cpuMillis: input.cpuMillis,
      reservationResources: input.reservationResources,
      desiredVms: input.desiredVms,
      guestTools: input.guestTools,
    });
    if (!allocation) {
      throw appError(
        409,
        "scenario_host_unavailable",
        input.requestedHostId
          ? "host does not have enough CPU, memory, and worst-case disk capacity"
          : "no scenario host can provide strict CPU isolation",
      );
    }
    return allocation;
  });
}

/**
 * Picks the first candidate that can hold this run and returns its desired
 * state under the version the commit batch must compare and set.
 *
 * The per-candidate read order is the capacity fence:
 *
 * 1. the desired-state version (the compare-and-set anchor);
 * 2. the reported capacity and the reservation ledger for that host;
 * 3. the CPU-quota check and the generic resource check;
 * 4. the desired-state draft that carries this run's VMs.
 *
 * A candidate that fails any check is skipped without writing anything, so a
 * refused candidate cannot publish a version bump that other admissions would
 * then have to retry against.
 */
async function planAdmissionHost(input: {
  candidateHostIds: readonly string[];
  userId: string;
  organizationId: string | null;
  requiredImages: RequiredScenarioImage[];
  explicitHost: boolean;
  now: number;
  cpuMillis: number;
  reservationResources: RuntimeResourceDemand;
  desiredVms: DesiredVmV2[];
  guestTools: DesiredGuestToolsV1;
}): Promise<AdmissionHostAllocation | null> {
  const db = drizzle(env.DB);
  for (const hostId of [...new Set(input.candidateHostIds)]) {
    const current = await loadOrCreateHostDesiredState(db, hostId, input.now);
    let host;
    try {
      host = await loadScenarioLaunchHostForUser(
        hostId,
        input.userId,
        input.requiredImages,
        input.organizationId,
      );
    } catch (error) {
      if (!input.explicitHost && error instanceof AppError && error.status < 500) {
        continue;
      }
      throw error;
    }
    if (
      !host.activeSessionId || host.credentialGeneration <= 0 ||
      host.actualReportedAt === null || host.actualReportText === null
    ) {
      continue;
    }
    const report = host.actualReport;
    const reservations = await db
      .select({
        runId: hostCpuReservations.runId,
        cpuMillis: hostCpuReservations.cpuMillis,
        state: hostCpuReservations.state,
      })
      .from(hostCpuReservations)
      .where(eq(hostCpuReservations.hostId, hostId));
    // CPU and other resource checks must use the same report as the commit
    // anchor. A second report read could hide a capacity/capability change.
    const capacity = hostCpuReservationCapacityFromSnapshot(report, reservations);
    if (!capacity) {
      continue;
    }
    if (input.cpuMillis > capacity.availableCpuMillis) {
      continue;
    }
    if (!report) {
      continue;
    }
    const snapshot = await loadActiveRuntimeResourceSnapshot(input.now, [
      hostId,
    ]);
    const available = availableRuntimeHostResources({
      hostId,
      report,
      snapshot,
    });
    if (
      !available ||
      !runtimeResourcesFit(input.reservationResources, available)
    ) {
      continue;
    }
    const next = mutateDesiredState(
      current,
      (draft) => {
        upsertDesiredGuestTools(draft, input.guestTools);
        for (const desiredVm of input.desiredVms) {
          upsertDesiredCachedImage(draft, {
            image_key: desiredVm.image_key,
            image_id: desiredVm.image_id,
          });
          upsertDesiredVm(draft, desiredVm);
        }
      },
      { nowUnixMs: input.now },
    );
    if (next === current) {
      continue;
    }
    return {
      hostId,
      readiness: {
        credentialGeneration: host.credentialGeneration,
        activeSessionId: host.activeSessionId,
        actualReportedAt: host.actualReportedAt,
        actualReportText: host.actualReportText,
      },
      expectedVersion: current.version,
      nextVersion: next.version,
      nextDocJson: JSON.stringify(next),
    };
  }
  return null;
}

export interface AdmissionCommitInput {
  run: typeof scenarioRuns.$inferInsert & { hostId: string };
  sshKeyRows: Array<typeof scenarioRunSshKeys.$inferInsert>;
  runtimeVms: Array<RuntimeVmSpec & { runtimeVmId: string }>;
  accessKeys: Array<{ ciphertextB64: string; ivB64: string }>;
  desiredVms: DesiredVmV2[];
  desired: AdmissionHostAllocation;
  cpuMillis: number;
  reservationResources: RuntimeResourceDemand;
  leaseExpiresAt: number | null;
  /** Administrative proof may admit a run while the cut-over gate is drained. */
  allowDrainedAdminProof?: boolean;
  /** The candidate proof this run was built from, or null for a live start. */
  candidateProof?: CandidateProof | null;
  /** The live-catalog image identity the source read returned, if any. */
  sourceAnchor?: LiveSourceFingerprint | null;
  now: number;
}

type AdmissionCommitOutcome =
  | { ok: true }
  | { ok: false; reason: "cas_lost" }
  | { ok: false; reason: "duplicate_key" }
  | { ok: false; reason: "error"; error: unknown };

async function commitAdmissionBatch(
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
    // host, the idempotency guard, the cut-over gate, and the candidate anchor.
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
 * Names the anchor that refused the run insert. The candidate anchor is the
 * one refusal that is not about the account: the candidate row or the build's
 * artifacts left the read-to-commit window, so the run is refused with the same
 * error the candidate source read raises. A still-active account is the
 * remaining refusal, and it means the cut-over gate drained inside the commit
 * window.
 */
async function admissionRefusal(input: AdmissionCommitInput) {
  const refusal = await sourceAnchorRefusal({
    candidateProof: input.candidateProof ?? null,
    sourceAnchor: input.sourceAnchor ?? null,
    organizationId: input.run.organizationId ?? null,
    scenarioId: input.run.scenarioId,
  });
  if (refusal) throw refusal;
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
  };
}

async function assertCurrentContentAccess(run: AdmissionCommitInput["run"], allowDrainedAdminProof = false) {
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
 * Names the source anchor that refused the run insert, or null when the source
 * this start read is still the source its commit would publish. A refused
 * candidate proof and a replaced live catalog row are both final for this
 * request: no retry with the same reads can pass, so the caller starts again
 * against fresh reads.
 */
async function sourceAnchorRefusal(input: {
  candidateProof: CandidateProof | null;
  sourceAnchor: LiveSourceFingerprint | null;
  organizationId: string | null;
  scenarioId: string;
}): Promise<AppError | null> {
  if (input.candidateProof) {
    const holds = await candidateAnchorHolds({
      organizationId: input.organizationId,
      scenarioId: input.scenarioId,
      proof: input.candidateProof,
    });
    return holds ? null : scenarioCandidateNotReady();
  }
  const anchor = input.sourceAnchor;
  if (!anchor) return null;
  const holds = await liveSourceAnchorHolds({
    scenarioId: input.scenarioId,
    anchor,
  });
  return holds ? null : scenarioSourceChanged();
}

/**
 * True when the live catalog still describes the images this start read. It
 * runs the same SQL condition as the commit batch anchor, so a refusal can
 * never name a different reason than the one that refused the run insert.
 */
async function liveSourceAnchorHolds(input: {
  scenarioId: string;
  anchor: LiveSourceFingerprint;
}): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT " +
      liveSourceAnchorCondition({
        scenarioParam: 1,
        fingerprintParam: 2,
        countParam: 3,
      }) +
      " AS anchored",
  )
    .bind(input.scenarioId, input.anchor.json, input.anchor.vmCount)
    .first<{ anchored: number }>();
  return row?.anchored === 1;
}

/**
 * True when the candidate row and the build of a candidate start are still in
 * the state the start read from. It runs the same SQL condition as the commit
 * batch anchor, so a refusal can never name a different reason than the one
 * that refused the run insert.
 */
async function candidateAnchorHolds(
  input: {
    organizationId: string | null;
    scenarioId: string;
    proof: CandidateProof;
  },
): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT " + candidateAnchorCondition(1) + " AS anchored",
  )
    .bind(
      candidateScenarioId(
        input.organizationId,
        input.proof.revision,
        input.scenarioId,
      ),
      input.proof.revision,
      input.proof.buildId,
      input.proof.manifestText,
    )
    .first<{ anchored: number }>();
  return row?.anchored === 1;
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
];

/**
 * The cut-over gate travels inside the insert so a drain that lands in the
 * commit window refuses the run instead of racing the fleet's pause. An
 * administrative proof start is the one caller that may bypass it.
 */
function drainGateCondition(allowDrainedAdminProof: boolean | undefined) {
  return allowDrainedAdminProof
    ? ""
    : " AND NOT EXISTS (SELECT 1 FROM runtime_operation_gates gate" +
        " WHERE gate.key = 'image_cutover' AND gate.state = 'drained')";
}

/**
 * The commit anchor of a candidate start, as one SQL condition on four bound
 * values (candidate id, revision, build id, manifest text) that start at
 * `startIndex`.
 *
 * The shared registry writer of the start serializes the start against the
 * exclusive collector sweep, but it cannot serialize it against another shared
 * writer: a promotion that lands between the candidate read and the commit can
 * retire the candidate row or retire the build's objects, and a republish can
 * rewrite the manifest of the same candidate row. All three changes make the
 * committed run launch an image, or a spec, that no reader describes any more,
 * so the batch re-checks the exact candidate, build, and manifest text it read
 * from and refuses the run instead.
 */
function candidateAnchorCondition(startIndex: number): string {
  const candidateId = "?" + String(startIndex);
  const revision = "?" + String(startIndex + 1);
  const buildId = "?" + String(startIndex + 2);
  const manifestText = "?" + String(startIndex + 3);
  return (
    "EXISTS (SELECT 1 FROM scenario_catalog_candidates candidate" +
    " WHERE candidate.id = " +
    candidateId +
    " AND candidate.revision = " +
    revision +
    " AND candidate.build_id = " +
    buildId +
    " AND candidate.manifest_json = " +
    manifestText +
    " AND EXISTS (SELECT 1 FROM image_builds build" +
    " WHERE build.id = " +
    buildId +
    " AND build.status = 'succeeded'" +
    " AND build.artifacts_retired_at IS NULL))"
  );
}

/**
 * The commit anchor of a live start, as one SQL condition on three bound values
 * (scenario id, the fingerprint JSON array, the expected VM count) that start
 * at the given parameter indices.
 *
 * A live catalog row can change under the same scenario id, and the shared
 * registry writer of the start does not serialize the start against another
 * shared writer. The anchor therefore re-checks, row for row, that the catalog
 * still describes the images this run was built from - the image key, the image
 * id, the chunk manifest, and the boot artifacts - and that the scenario has
 * the same number of VMs, so a replaced, added, or removed VM refuses the run
 * instead of committing a launch spec no catalog row describes any more.
 *
 * `IS` is SQLite's null-safe comparison, so a legacy image whose chunk manifest
 * is absent matches an absent manifest instead of failing against NULL.
 */
function liveSourceAnchorCondition(input: {
  scenarioParam: number;
  fingerprintParam: number;
  countParam: number;
}): string {
  const scenario = "?" + String(input.scenarioParam);
  const fingerprint = "?" + String(input.fingerprintParam);
  const count = "?" + String(input.countParam);
  return (
    "(SELECT COUNT(*) FROM vm_scenario_vms vm" +
    " WHERE vm.scenario_id = " +
    scenario +
    " AND EXISTS (SELECT 1 FROM json_each(" +
    fingerprint +
    ") expected" +
    " WHERE json_extract(expected.value, '$.name') IS vm.vm_name" +
    " AND json_extract(expected.value, '$.keyScenario')" +
    " IS json_extract(vm.image_key_json, '$.scenario')" +
    " AND json_extract(expected.value, '$.keyVm')" +
    " IS json_extract(vm.image_key_json, '$.vm')" +
    " AND json_extract(expected.value, '$.keyArch')" +
    " IS json_extract(vm.image_key_json, '$.arch')" +
    " AND json_extract(expected.value, '$.imageId') IS vm.image_sha256" +
    " AND json_extract(expected.value, '$.manifest')" +
    " IS vm.chunk_manifest_sha256" +
    " AND json_extract(expected.value, '$.kernel') IS vm.kernel_sha256" +
    " AND json_extract(expected.value, '$.initrd') IS vm.initrd_sha256))" +
    " = " +
    count +
    " AND (SELECT COUNT(*) FROM vm_scenario_vms vm" +
    " WHERE vm.scenario_id = " +
    scenario +
    ") = " +
    count
  );
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
  ];
  const hostParam = values.length + 1;
  const userParam = values.length + 2;
  const candidateParam = values.length + 3;
  const candidateProof = input.candidateProof;
  const sourceAnchor = input.sourceAnchor ?? null;
  const anchorCondition = candidateProof
    ? candidateAnchorCondition(candidateParam)
    : sourceAnchor
      ? liveSourceAnchorCondition({
          // The scenario id is already bound for the insert's own columns, so
          // the anchor reuses that parameter instead of adding a copy.
          scenarioParam: RUN_INSERT_COLUMNS.indexOf("scenario_id") + 1,
          fingerprintParam: candidateParam,
          countParam: candidateParam + 1,
        })
      : null;
  const anchorParams: Array<string | number> = candidateProof
    ? [
        candidateScenarioId(
          run.organizationId ?? null,
          candidateProof.revision,
          run.scenarioId,
        ),
        candidateProof.revision,
        candidateProof.buildId,
        candidateProof.manifestText,
      ]
    : sourceAnchor
      ? [sourceAnchor.json, sourceAnchor.vmCount]
      : [];
  const readinessParam = candidateParam + anchorParams.length;
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
          " image_key_json, image_sha256, cpu_millis, memory_mib, disk_mib," +
          " created_at, updated_at" +
          ") SELECT ?1, run.runtime_execution_id, ?2, ?3, ?4, ?5, ?6, ?7," +
          " ?8, ?9, ?10, ?10" +
          " FROM scenario_runs run" +
          " WHERE run.run_id = ?11 AND run.runtime_execution_id = ?12" +
          " AND run.state = 'provisioning'",
      ).bind(
        vm.runtimeVmId,
        vm.vmId,
        vm.ordinal,
        vm.runtimeVmName,
        JSON.stringify(vm.imageKey),
        vm.imageSha256,
        vm.cpuMillis,
        vm.memoryMib,
        vm.diskMib,
        input.now,
        run.runId,
        run.runId,
      ),
    );
    const accessKey = input.accessKeys[index];
    const publicKey =
      input.desiredVms.find((desired) => desired.vm_name === vm.runtimeVmName)
        ?.ssh_authorized_keys_openssh[0] ?? "";
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
  // aborts the whole batch, exactly like the previous projection.
  return env.DB.prepare(
    "INSERT INTO active_runtime_slots (user_id, execution_id, acquired_at)" +
      " SELECT run.user_id, run.runtime_execution_id, run.created_at" +
      " FROM scenario_runs run" +
      " WHERE run.run_id = ?1 AND run.active_key IS NOT NULL" +
      " AND run.runtime_execution_id IS NOT NULL",
  ).bind(run.runId);
}
