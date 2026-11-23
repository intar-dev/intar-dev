import { IMAGE_FORMAT } from "@/generated/constants";
import { endLocalRun, ensureLocalHostStatement, localHostId } from "@/lib/local-runs";
import { env } from "cloudflare:workers";
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  cpuReservationForVms,
  hostCpuReservationCapacityFromSnapshot,
  HOST_STATE_REPORT_SCHEMA_VERSION_V3,
  strictCpuHardware,
} from "@/control-plane/host-cpu-reservations";
import { readKinoPin } from "@/control-plane/image-registry/push";
import { agentHosts, hostActualState, hostCpuReservations } from "@/db/schema";
import type {
  DesiredVmV3,
  HostDesiredStateV3,
  HostStateReportV3,
} from "@/generated/contracts/bridge-message-v9";
import type { ScenarioRevisionV1 } from "@/generated/contracts/scenario-revision-v1";
import { AppError, appError } from "@/lib/app-error";
import type { assertCourseScenarioStartAllowed } from "@/lib/course-catalogs";
import {
  checkedHostDesiredStateV3,
  loadStoredHostDesiredState,
  markStoredDesiredVmsAbsent,
} from "@/lib/desired-state-store";
import { hostHealth } from "@/lib/host-health";
import { tryWakeHostRuntime } from "@/lib/host-runtime-wake";
import { createAppId } from "@/lib/id";
import { metalPlacementForUser } from "@/lib/metal-placement";
import { PERSONAL_IMAGE_PREPARATION_TTL_MS, preparationAuthoritySql } from "@/lib/personal-image-access";
import { hostReportV3Ready } from "@/lib/personal-host-readiness";
import { assertAgentKvmRunsOpen } from "@/lib/run-admission-gate";
import { revisionVmId } from "@/lib/run-lifecycle";
import {
  RUN_PHASE_ORDER,
  buildInitialRunState,
  buildInitialVmState,
  recomputeRunState,
  type RunVmStateDocument,
} from "@/lib/run-state";
import { initialRunTasks } from "@/lib/run-tasks";
import {
  availableRuntimeHostResources,
  loadActiveRuntimeResourceSnapshot,
  runtimeResourcesFit,
} from "@/lib/runtime-capacity";
import type { RuntimeVmSpec } from "@/lib/runtime-executions";
import { encryptRuntimeVmAccessKey } from "@/lib/runtime-vm-state";
import { isAvailableScenarioLaunchHost } from "@/lib/scenario-hosts";
import type { ScenarioRunHintSnapshot } from "@/db/schema/shared";
import type { ScenarioStartRequestScope } from "@/db/schema/runs";
import {
  generateScenarioRunSshKeyDraft,
  prepareScenarioRunSshKeyRows,
} from "@/lib/scenario-run-ssh-keys";
import type { AdmissionContentAccess } from "./admission-guards";
import {
  ADMISSION_CAS_ATTEMPTS,
  assertAccountStillActive,
  assertAdmissionRefusalPriority,
  assertCurrentContentAccess,
  assertReplayMatchesScope,
  cancelRunStatement,
  commitAdmissionBatch,
  deliveryHint,
  loadRunByIdempotencyKey,
  openRunStartRegistryGuard,
  scenarioSourceChanged,
  type AdmissionHostAllocation,
  type BeginScenarioRunInput,
  type BeginScenarioRunResult,
} from "./begin";
import { HOST_HEARTBEAT_TTL_MS, scenarioRuntimeReservationResources } from "./start";
import { activeKeyFor } from "./storage";
import { VALIDATION_USER_ID } from "./content-access";
import { reportHasImagesReady, scenarioImagePreparing } from "./image-readiness";

/** A run's VMs live this long unless the run renews them; a verify run's never renew. */
const REVISION_RUN_LEASE_MS = 3_600_000;
/** Verify runs one scope may have at once. */
export const VERIFY_RUN_QUOTA = 2;

/** The active key of a verify run: one per scenario revision, scoped for the quota. */
export function verifyActiveKey(scopeKey: string, rev: string, scenarioId: string): string {
  return `verify:${scopeKey}:${rev}:${scenarioId}`;
}

/** Holds while scope ?N has fewer than VERIFY_RUN_QUOTA active verify runs. */
function verifyQuotaCondition(scopeParam: number): string {
  // ';' sorts right after ':', so the range is the scope's keys and uses the index.
  return `(SELECT count(*) FROM scenario_runs verifying
      WHERE verifying.active_key > 'verify:' || ?${scopeParam} || ':'
        AND verifying.active_key < 'verify:' || ?${scopeParam} || ';') < ${VERIFY_RUN_QUOTA}`;
}

/**
 * The commit anchor of a verify run: the revision is still its enabled
 * scenario's ready candidate in scope ?scope, and the scope has a free verify
 * slot. One run per revision is the active key's unique index.
 */
export function verifyAnchorCondition(scenarioParam: number, revParam: number, scopeParam: number, restoreCheck = false): string {
  // A restore check runs a revision that is verified already, whether it is
  // the candidate or live: one machine, and not restore-verified yet.
  const revision = restoreCheck
    ? `(verify_scenario.candidate_rev = ?${revParam} OR verify_scenario.live_rev = ?${revParam})
      AND verify_revision.rev = ?${revParam} AND verify_revision.state = 'verified'
      AND verify_revision.restore_verified_at IS NULL
      AND json_array_length(verify_revision.doc_json, '$.machines') = 1`
    : `verify_scenario.candidate_rev = ?${revParam}
      AND verify_revision.rev = ?${revParam} AND verify_revision.state = 'ready'`;
  return `EXISTS (SELECT 1 FROM scenarios verify_scenario
      JOIN scenario_revisions verify_revision ON verify_revision.scenario_id = verify_scenario.id
    WHERE verify_scenario.id = ?${scenarioParam} AND verify_scenario.enabled = 1
      AND verify_scenario.scope_key = ?${scopeParam} AND ${revision})
    AND ${verifyQuotaCondition(scopeParam)}`;
}

/** Why a verify run of `rev` may not start now, or null. */
export async function verifyRefusal(d1: D1Database, scenarioId: string, rev: string, scopeKey: string, restoreCheck = false) {
  const row = await d1.prepare(
    `SELECT EXISTS (SELECT 1 FROM scenario_runs WHERE active_key = ?4) AS running,
        ${verifyQuotaCondition(3)} AS quota, ${verifyAnchorCondition(1, 2, 3, restoreCheck)} AS anchored`,
  ).bind(scenarioId, rev, scopeKey, verifyActiveKey(scopeKey, rev, scenarioId))
    .first<{ running: number; quota: number; anchored: number }>();
  if (row?.running) return appError(409, "verify_run_active", "a verify run of this revision is already running");
  if (!row?.quota) {
    return appError(409, "verify_quota_exhausted", `this scope already has ${VERIFY_RUN_QUOTA} verify runs; wait for one to end`);
  }
  if (!row.anchored) {
    return restoreCheck
      ? appError(409, "restore_check_not_possible",
        "a restore check needs a verified candidate or live revision with one machine that is not restore-verified yet")
      : appError(409, "verify_revision_not_candidate", "only a ready candidate revision can be verified");
  }
  return null;
}

export interface LiveScenarioRevision {
  scenarioId: string;
  rev: string;
  guestContract: number;
  doc: ScenarioRevisionV1;
  /** The revision's checks passed in a lab started from a host snapshot. */
  restoreVerified?: boolean;
}

/**
 * The revision a learner start runs: the scenario's `live_rev`, while the
 * scenario is enabled for this organization and that revision is ready or verified. Promotion owns `live_rev`; this is
 * its only reader for starts.
 */
export async function liveScenarioRevision(
  d1: D1Database,
  scenarioId: string,
  organizationId: string | null,
): Promise<LiveScenarioRevision | null> {
  const sql = `SELECT scenario.id, revision.rev, revision.guest_contract, revision.doc_json,
         revision.restore_verified_at IS NOT NULL AS restore_verified
       FROM scenarios scenario
       JOIN scenario_revisions revision
         ON revision.scenario_id = scenario.id AND revision.rev = scenario.live_rev
      WHERE scenario.id = ?1 AND scenario.enabled = 1
        AND revision.state IN ('ready', 'verified')
        AND (scenario.organization_id IS NULL OR scenario.organization_id = ?2)`;
  const row = await d1.prepare(sql).bind(scenarioId, organizationId)
    .first<{ id: string; rev: string; guest_contract: number; doc_json: string; restore_verified: number }>();
  if (!row) return null;
  return {
    scenarioId: row.id, rev: row.rev, guestContract: row.guest_contract, doc: JSON.parse(row.doc_json),
    restoreVerified: row.restore_verified === 1,
  };
}

/**
 * The commit anchor of a revision start: the scenario (bound at
 * `scenarioParam`) is enabled and still has the live revision bound at
 * `revParam`, in a startable state. A promotion inside the read-to-commit
 * window refuses the run.
 */
export function liveRevisionAnchorCondition(scenarioParam: number, revParam: number): string {
  return `EXISTS (SELECT 1 FROM scenarios anchor_scenario
    JOIN scenario_revisions anchor_revision ON anchor_revision.scenario_id = anchor_scenario.id
      AND anchor_revision.rev = anchor_scenario.live_rev
    WHERE anchor_scenario.id = ?${scenarioParam} AND anchor_scenario.enabled = 1
      AND anchor_scenario.live_rev = ?${revParam}
      AND anchor_revision.state IN ('ready', 'verified'))`;
}

export async function liveRevisionHolds(d1: D1Database, scenarioId: string, rev: string): Promise<boolean> {
  const row = await d1.prepare(`SELECT ${liveRevisionAnchorCondition(1, 2)} AS anchored`)
    .bind(scenarioId, rev).first<{ anchored: number }>();
  return row?.anchored === 1;
}

/**
 * Every machine image of a live or candidate revision of guest contract
 * `contract`: what a platform host caches, so a learner start and a verify
 * run find their images ready. Each enabled scenario adds at most two
 * revisions; one leaves the set when it is neither live nor candidate.
 */
export async function liveRevisionImages(d1: D1Database, contract: number): Promise<string[]> {
  const { results } = await d1.prepare(
    `SELECT DISTINCT json_extract(machine.value, '$.image_digest') AS image
       FROM scenarios scenario
       JOIN scenario_revisions revision
         ON revision.scenario_id = scenario.id AND revision.rev IN (scenario.live_rev, scenario.candidate_rev)
       JOIN json_each(revision.doc_json, '$.machines') machine
      WHERE scenario.enabled = 1 AND revision.state IN ('ready', 'verified')
        AND revision.guest_contract = ?1
        AND json_extract(machine.value, '$.image_digest') IS NOT NULL`,
  ).bind(contract).all<{ image: string }>();
  return results.map((row) => row.image);
}

/**
 * The arm64 image of each machine of a revision, by build key: the one
 * recorded for it that the registry still holds. Null when any machine has
 * none. A revision whose images its source's pipeline built (#441) has them
 * among its own scope's images and nowhere else; any other has its builds'.
 */
export async function arm64MachineImages(
  d1: D1Database,
  revision: Pick<LiveScenarioRevision, "scenarioId" | "rev" | "doc">,
): Promise<Map<string, string> | null> {
  const keys = [...new Set(revision.doc.machines.map((machine) => machine.build_key))];
  const source = await d1.prepare(
    `SELECT scenario.scope_key, COALESCE(bundle.image_producer, 'builder') AS producer
       FROM scenarios scenario LEFT JOIN bundles bundle ON bundle.rev = ?2
      WHERE scenario.id = ?1`,
  ).bind(revision.scenarioId, revision.rev).first<{ scope_key: string; producer: string }>();
  const { results } = await (source?.producer === "pipeline"
    ? d1.prepare(
        `SELECT image.build_key, image.image_digest AS digest FROM scope_machine_images image
           JOIN registry_manifests manifest ON manifest.digest = image.image_digest
          WHERE image.scope_key = ?2 AND image.architecture = 'arm64' AND image.image_format = ?3
            AND image.build_key IN (SELECT value FROM json_each(?1))`,
      ).bind(JSON.stringify(keys), source.scope_key, IMAGE_FORMAT)
    : d1.prepare(
        `SELECT build.build_key, build.arm64_image_digest AS digest FROM machine_builds build
           JOIN registry_manifests manifest ON manifest.digest = build.arm64_image_digest
          WHERE build.arm64_state = 'succeeded' AND build.build_key IN (SELECT value FROM json_each(?1))`,
      ).bind(JSON.stringify(keys))
  ).all<{ build_key: string; digest: string }>();
  const images = new Map(results.map((row) => [row.build_key, row.digest]));
  return keys.length > 0 && keys.every((key) => images.has(key)) ? images : null;
}

/**
 * Admits one run of a live revision. It shares the catalog start's commit
 * batch (run, keys, execution, VM mirrors, reservations, desired-state CAS,
 * active slot); only the source, the placement and the desired VMs differ.
 */
export async function admitRevisionRun(context: {
  input: BeginScenarioRunInput;
  revision: LiveScenarioRevision;
  organizationId: string | null;
  /** Null for a verify run. */
  courseLecture: Awaited<ReturnType<typeof assertCourseScenarioStartAllowed>> | null;
  idempotencyKey: string;
  scope: ScenarioStartRequestScope;
  /** A verify run of the revision, taking this scope's verify quota. */
  verifyScopeKey?: string;
  /** The verify run is a restore check: its VM may start from a host snapshot. */
  verifyRestoreCheck?: boolean;
  /** How long the run's VMs live; the usual hour when not given. */
  leaseMs?: number;
}): Promise<BeginScenarioRunResult> {
  const { input, revision, organizationId, courseLecture } = context;
  const leaseMs = context.leaseMs ?? REVISION_RUN_LEASE_MS;
  const verifyScopeKey = context.verifyScopeKey ?? null;
  const local = input.runtime === "local" && verifyScopeKey === null;
  const verifyRestoreCheck = verifyScopeKey !== null && context.verifyRestoreCheck === true;
  const doc = revision.doc;
  // A VM may start from its host's snapshot only in a restore check, or for
  // a revision that passed one. A snapshot is of one machine. The flag is
  // read once here: a withdrawal that lands before this start commits can
  // still let this one run restore.
  const mayRestore = doc.machines.length === 1 &&
    (verifyScopeKey ? verifyRestoreCheck : revision.restoreVerified === true);
  if (!doc.machines.length || doc.machines.some((machine) => !machine.image_digest)) {
    throw appError(409, "image_not_ready", "scenario images are not built yet");
  }
  // A Talos cluster runs only on a host whose agent boots one; the desktop
  // app does not yet.
  const cluster = doc.machines.some((machine) => machine.cluster_key !== undefined);
  if (cluster && local) {
    throw appError(409, "upgrade_required", "this scenario needs a newer version of the app; update it");
  }
  // A learner's arm64 computer boots the arm64 image of each machine's build
  // and the arm64 Kino. Either may be missing: those builds are not what a
  // revision waits for.
  const arm64 = local && input.architecture === "arm64";
  const arm64Images = arm64 ? await arm64MachineImages(env.DB, revision) : null;
  const pin = await readKinoPin(env, revision.guestContract, arm64 ? "arm64" : "amd64");
  if (arm64 && (!arm64Images || !pin)) {
    throw appError(409, "architecture_unavailable", "this scenario has no machine images for this computer's processor yet");
  }
  if (!pin) throw noEligibleHost();

  const runId = createAppId();
  const createdAt = Date.now();
  const leaseExpiresAt = createdAt + leaseMs;
  const machines = doc.machines.map((machine, ordinal) => ({
    machine,
    ordinal,
    vmId: createAppId(),
    runtimeVmName: revisionVmId(machine.name, runId),
    image: arm64Images?.get(machine.build_key) ?? (machine.image_digest as string),
  }));
  const vms = machines.map(({ machine, ordinal, vmId, runtimeVmName, image }) => {
    const vm = buildInitialVmState({
      id: vmId,
      ordinal,
      scenarioVmId: machine.name,
      scenarioVmName: machine.name,
      runtimeVmName,
      hostname: machine.name,
      launchSummary: { scenarioVmName: machine.name, hostname: machine.name, probePhaseMap: {}, probeDescriptors: [] },
    });
    return {
      ...vm,
      provisioning: {
        ...vm.provisioning,
        image,
        imageSha256: image,
        resources: { cpuMillis: machine.cpu_millis, memoryMib: machine.memory_mib, diskMib: machine.disk_mib },
        leaseDurationSeconds: leaseMs / 1000,
        status: "queued",
      },
    } satisfies RunVmStateDocument;
  });
  const state = recomputeRunState({
    ...buildInitialRunState({ vms: [] }),
    phase: "provisioning",
    phaseTitle: "Provisioning",
    phaseDetail: "Queueing launch delivery.",
    vms,
    tasks: initialRunTasks(doc.tasks),
  });
  // The run's immutable snapshot per machine: what it boots, with which
  // spec and Kino. The VM mirror row keeps the three digests.
  const runtimeVms: Array<RuntimeVmSpec & { runtimeVmId: string }> = machines.map(({ machine, ordinal, vmId, runtimeVmName, image }) => ({
    runtimeVmId: createAppId(),
    vmId,
    ordinal,
    runtimeVmName,
    imageDigest: image,
    specDigest: verifyScopeKey ? machine.verify_spec : machine.spec,
    kinoDigest: pin.current,
    cpuMillis: machine.cpu_millis,
    memoryMib: machine.memory_mib,
    diskMib: machine.disk_mib,
  }));
  const cpuMillisByVm = doc.machines.map((machine) => machine.cpu_millis);
  const reservationResources = scenarioRuntimeReservationResources(runtimeVms, cpuMillisByVm);
  const cpuMillis = cpuReservationForVms(cpuMillisByVm);

  const sshKeyDrafts = machines.map(({ vmId, runtimeVmName }) =>
    generateScenarioRunSshKeyDraft({ runId, vmId, runtimeVmName }));
  const [sshKeyRows, accessKeys] = await Promise.all([
    prepareScenarioRunSshKeyRows(sshKeyDrafts, createdAt),
    Promise.all(sshKeyDrafts.map((draft) => encryptRuntimeVmAccessKey({
      executionId: runId,
      vmId: draft.vmId,
      runtimeVmName: draft.runtimeVmName,
      publicKeyOpenssh: draft.publicKeyOpenssh,
      privateKeyOpenssh: draft.privateKeyOpenssh,
    }))),
  ]);
  const desiredVms: DesiredVmV3[] = machines.map(({ machine, runtimeVmName, image }, index) => ({
    vm_id: runtimeVmName,
    name: machine.name,
    run_id: runId,
    runtime_execution_id: runId,
    owner_user_id: input.userId,
    generation: 1,
    desired_phase: "running",
    lease_expires_at_unix_ms: leaseExpiresAt,
    image,
    kino: pin.current,
    spec: verifyScopeKey ? machine.verify_spec : machine.spec,
    mode: verifyScopeKey ? "verify" : "learn",
    cpu_millis: machine.cpu_millis,
    memory_mib: machine.memory_mib,
    disk_mib: machine.disk_mib,
    peers: doc.machines.filter((peer) => peer.name !== machine.name).map((peer) => peer.name),
    ssh_authorized_keys: [sshKeyDrafts[index]!.publicKeyOpenssh],
    terminal: machine.terminal,
    egress: machine.egress,
  }));

  const hints: ScenarioRunHintSnapshot[] = [
    ...doc.hints.map((hint) => ({
      key: `scenario:${hint.id}`, scope: "scenario" as const, probeName: null,
      id: hint.id, title: hint.title ?? null, bodyMarkdown: hint.body,
    })),
    ...doc.tasks.flatMap((task) => task.hints.map((hint) => ({
      key: `task:${task.id}:${hint.id}`, scope: "probe" as const, probeName: task.id,
      id: hint.id, title: hint.title ?? null, bodyMarkdown: hint.body,
    }))),
  ];
  const lecture = courseLecture?.lecture;
  const run = {
    runId,
    userId: input.userId,
    organizationId,
    runtimeExecutionId: runId,
    hostId: "",
    runtime: local ? "local" as const : "platform" as const,
    scenarioId: revision.scenarioId,
    scenarioName: revision.scenarioId,
    scenarioRev: revision.rev,
    tasksJson: doc.tasks,
    launchSource: verifyScopeKey ? "verify" as const : "course" as const,
    courseScopeKey: courseLecture?.courseScopeKey ?? null,
    courseId: courseLecture?.courseId ?? null,
    courseTitle: courseLecture?.courseTitle ?? null,
    lectureId: courseLecture?.lectureId ?? null,
    lectureTitle: courseLecture?.lectureTitle ?? null,
    lectureSummary: courseLecture?.lectureSummary ?? null,
    lectureBodyMarkdown: courseLecture?.lectureBodyMarkdown ?? null,
    lectureOrdinal: courseLecture?.lectureOrdinal ?? null,
    lectureCount: courseLecture?.lectureCount ?? null,
    title: lecture?.title || doc.title,
    tagline: lecture?.summary || doc.summary,
    briefingMarkdown: doc.briefing,
    objectivesJson: "[]",
    difficulty: lecture?.difficulty ?? doc.difficulty,
    estimatedMinutes: doc.minutes,
    tagsJson: doc.tags,
    hintsJson: hints,
    solutionMarkdown: doc.solution,
    revealedHintsJson: [],
    solutionRevealedAt: null,
    solutionAssisted: false,
    vmCount: vms.length,
    state: state.phase,
    stateRank: RUN_PHASE_ORDER[state.phase],
    activeKey: verifyScopeKey ? verifyActiveKey(verifyScopeKey, revision.rev, revision.scenarioId) : activeKeyFor(input.userId),
    requestIdempotencyKey: context.idempotencyKey,
    requestScopeJson: context.scope,
    stateJson: JSON.stringify(state),
    archiveEnteredAt: null,
    deleteRequestedAt: null,
    solvedAt: null,
    completedAt: null,
    failedAt: null,
    hiddenAt: null,
    createdAt,
    updatedAt: createdAt,
  };

  const access: AdmissionContentAccess = {
    userId: input.userId,
    organizationId,
    scenarioId: revision.scenarioId,
    courseScopeKey: courseLecture?.courseScopeKey ?? null,
    courseId: courseLecture?.courseId ?? null,
    lectureId: courseLecture?.lectureId ?? null,
    allowSequenceBypass: input.allowSequenceBypass === true,
    requiresAdmin: input.allowDrainedAdminProof === true || input.allowSequenceBypass === true,
    launchSource: run.launchSource,
    scenarioRev: revision.rev,
  };
  const images = [...new Set(machines.map((machine) => machine.image))].sort();
  for (let attempt = 1; attempt <= ADMISSION_CAS_ATTEMPTS; attempt += 1) {
    const now = Date.now();
    let allocated: AdmissionHostAllocation;
    if (local) {
      // No host is chosen: the run points at the learner's placeholder, and
      // the device pulls and boots what the run's VM rows name.
      await ensureLocalHostStatement(env.DB, input.userId, now).run();
      allocated = {
        hostId: localHostId(input.userId),
        readiness: { credentialGeneration: 0, activeSessionId: "", actualReportedAt: 0, actualReportText: "" },
        expectedVersion: 0,
        nextVersion: 0,
        nextDocJson: "",
      };
    } else {
    const candidates = await eligibleRevisionHosts({
      userId: input.userId,
      organizationId,
      guestContract: revision.guestContract,
      kino: pin.current,
      ...(input.hostId ? { requestedHostId: input.hostId } : {}),
      platformOnly: verifyScopeKey !== null,
      cluster,
      now,
    });
    // Only a host that reports every image ready may take the run. The commit
    // fences on that exact report, so a host whose image went away since
    // this read fails the commit and the next attempt reads it again.
    const isReady = (candidate: RevisionHostCandidate) => reportHasImagesReady(candidate.report, images);
    const ready = candidates.filter(isReady);
    if (candidates[0]!.scope === "platform") {
      // Platform hosts cache every live and candidate image on their own.
      if (!ready.length) throw scenarioImagePreparing();
      allocated = await planRevisionHost({ candidates: ready, desiredVms, mayRestore, cpuMillis, reservationResources, now });
    } else {
      // The learner's own servers: the host with room, ready ones first, is
      // told to cache the images. Until it reports them ready the start is
      // refused; the preparation it wrote is what makes the host pull.
      const planned = await planRevisionHost({
        candidates: [...ready, ...candidates.filter((candidate) => !isReady(candidate))],
        desiredVms, cpuMillis, reservationResources, now,
      });
      const chosen = candidates.find((candidate) => candidate.hostId === planned.hostId)!;
      await prepareRevisionImages({ access, requestKey: context.idempotencyKey, candidates: [chosen], images, now });
      if (!isReady(chosen)) throw scenarioImagePreparing();
      // The preparation moved the desired state; plan against the new version.
      allocated = await planRevisionHost({ candidates: [chosen], desiredVms, cpuMillis, reservationResources, now, reload: true });
    }
    }
    await assertAgentKvmRunsOpen(env.DB, input.allowDrainedAdminProof ? { allowDrainedAdminProof: true } : {});
    const outcome = await commitAdmissionBatch({
      run: { ...run, hostId: allocated.hostId },
      sshKeyRows,
      runtimeVms,
      accessKeys,
      desiredVms,
      desired: allocated,
      cpuMillis,
      reservationResources,
      leaseExpiresAt,
      revisionAnchor: verifyScopeKey ? null : revision.rev,
      verifyScopeKey,
      ...(verifyRestoreCheck ? { verifyRestoreCheck: true } : {}),
      ...(input.allowDrainedAdminProof ? { allowDrainedAdminProof: true } : {}),
      ...(local ? { local: true } : {}),
      now: Date.now(),
    });
    if (outcome.ok) {
      try {
        await assertAccountStillActive({ userId: input.userId, runId, hostId: allocated.hostId });
      } catch (error) {
        if (local) await endLocalRun({ d1: env.DB, runId });
        else await cancelRevisionRun({ runId, userId: input.userId, hostId: allocated.hostId });
        throw error;
      }
      return {
        accepted: true,
        runId,
        scenarioId: revision.scenarioId,
        acceptedAt: createdAt,
        reused: false,
        hostId: allocated.hostId,
        deliveryHint: deliveryHint(allocated.hostId),
      };
    }
    if (outcome.reason === "duplicate_key") {
      const raced = await loadRunByIdempotencyKey(drizzle(env.DB), input.userId, context.idempotencyKey);
      if (!raced) throw appError(409, "idempotency_key_conflict", "this Idempotency-Key was used for a different start request");
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
    if (outcome.reason === "error") {
      // The active key is per revision for a verify run, not per account.
      if (verifyScopeKey && outcome.error instanceof AppError && outcome.error.code === "scenario_run_active_conflict") {
        throw appError(409, "verify_run_active", "a verify run of this revision is already running");
      }
      throw outcome.error;
    }
    await assertAdmissionRefusalPriority({
      userId: input.userId,
      ...(input.allowDrainedAdminProof ? { allowDrainedAdminProof: true } : {}),
    });
    if (verifyScopeKey) {
      const refusal = await verifyRefusal(env.DB, revision.scenarioId, revision.rev, verifyScopeKey, verifyRestoreCheck);
      if (refusal) throw refusal;
    } else if (!(await liveRevisionHolds(env.DB, revision.scenarioId, revision.rev))) {
      throw scenarioSourceChanged();
    }
    await assertCurrentContentAccess({ ...run, hostId: allocated.hostId }, input.allowDrainedAdminProof);
  }
  throw appError(409, "scenario_host_capacity_contended", "scenario capacity changed during admission; retry the start");
}

/**
 * Starts a verify run of a scenario's ready candidate revision `rev`, as the
 * validation account, on a platform host. The caller has checked that its
 * actor administers the scenario's scope; only a platform admin's start
 * (`allowDrainedAdminProof`) passes the operator drain.
 */
export async function beginVerifyRun(input: {
  scenarioId: string;
  rev: string;
  allowDrainedAdminProof?: boolean;
  /**
   * A restore check of a revision that is verified already: the same verify
   * run, with a VM that may start from its host's snapshot. The revision
   * names the run, which is how its outcome is told from a verify run's.
   */
  restoreCheck?: boolean;
  /** A shorter lease than an administrator's hour: a source's job starts many runs. */
  leaseMs?: number;
}): Promise<BeginScenarioRunResult> {
  const drained = input.allowDrainedAdminProof === true;
  const restoreCheck = input.restoreCheck === true;
  const row = await env.DB.prepare(
    `SELECT scenario.scope_key, revision.guest_contract, revision.doc_json FROM scenarios scenario
       JOIN scenario_revisions revision ON revision.scenario_id = scenario.id AND revision.rev = ?2
      WHERE scenario.id = ?1`,
  ).bind(input.scenarioId, input.rev).first<{ scope_key: string; guest_contract: number; doc_json: string }>();
  if (!row) throw appError(404, "scenario_revision_not_found", "scenario revision not found");
  const refusal = await verifyRefusal(env.DB, input.scenarioId, input.rev, row.scope_key, restoreCheck);
  if (refusal) throw refusal;
  await env.DB.prepare(
    `INSERT INTO user (id, name, email, email_verified, metal_placement) VALUES (?1, 'Scenario validation', ?2, 1, 'platform')
      ON CONFLICT (id) DO NOTHING`,
  ).bind(VALIDATION_USER_ID, `${VALIDATION_USER_ID}@users.invalid`).run();
  const idempotencyKey = createAppId();
  const runInput: BeginScenarioRunInput = {
    scenarioId: input.scenarioId,
    userId: VALIDATION_USER_ID,
    idempotencyKey,
    organizationId: null,
    ...(drained ? { allowDrainedAdminProof: true } : {}),
  };
  await assertAgentKvmRunsOpen(env.DB, drained ? { allowDrainedAdminProof: true } : {});
  const registryGuard = await openRunStartRegistryGuard(VALIDATION_USER_ID);
  let outcome: "ok" | "error" = "error";
  try {
    const result = await admitRevisionRun({
      input: runInput,
      revision: { scenarioId: input.scenarioId, rev: input.rev, guestContract: row.guest_contract, doc: JSON.parse(row.doc_json) },
      organizationId: null,
      courseLecture: null,
      idempotencyKey,
      scope: {
        scenarioId: input.scenarioId, organizationId: null, hostId: null, candidateRevision: null,
        candidateBuildId: null, allowDrainedAdminProof: drained, allowSequenceBypass: false,
      },
      verifyScopeKey: row.scope_key,
      ...(restoreCheck ? { verifyRestoreCheck: true } : {}),
      ...(input.leaseMs === undefined ? {} : { leaseMs: input.leaseMs }),
    });
    if (restoreCheck) {
      // The run is already on its way to the host. Should a report settle
      // it before this write, the settlement names the run itself, and this
      // must not wipe what it recorded.
      await env.DB.prepare(
        `UPDATE scenario_revisions SET restore_verify_run_id = ?3, restore_verify_report_json = NULL
          WHERE scenario_id = ?1 AND rev = ?2 AND restore_verify_run_id IS NOT ?3`,
      ).bind(input.scenarioId, input.rev, result.runId).run();
    }
    outcome = "ok";
    return result;
  } finally {
    await registryGuard.complete(outcome);
  }
}

interface RevisionHostCandidate {
  hostId: string;
  scope: "platform" | "personal" | "organization";
  credentialGeneration: number;
  activeSessionId: string;
  actualReportedAt: number;
  actualReportText: string;
  report: HostStateReportV3;
  /** The host's agent reads `may_restore`; an older one refuses a desired state that holds it. */
  readsMayRestore: boolean;
  /** The desired state the host was found eligible on. */
  desired: HostDesiredStateV3;
}

/** The first agent release that reads `DesiredVmV3.may_restore`. */
const MAY_RESTORE_AGENT_VERSION = [0, 22, 0] as const;
/** The first agent release that boots a Talos cluster's machines. */
const TALOS_AGENT_VERSION = [0, 27, 0] as const;

/** Whether the agent of a stored client hello is at least that release. */
export function agentReadsMayRestore(helloJson: string | null): boolean {
  return agentAtLeast(helloJson, MAY_RESTORE_AGENT_VERSION);
}

/** Whether the agent of a stored client hello boots Talos clusters. */
export function agentBootsTalos(helloJson: string | null): boolean {
  return agentAtLeast(helloJson, TALOS_AGENT_VERSION);
}

function agentAtLeast(helloJson: string | null, release: readonly [number, number, number]): boolean {
  if (!helloJson) return false;
  let version: unknown;
  try {
    version = (JSON.parse(helloJson) as { agent_version?: unknown }).agent_version;
  } catch {
    return false;
  }
  const match = typeof version === "string" ? /^(\d+)\.(\d+)\.(\d+)$/.exec(version) : null;
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  for (const [index, least] of release.entries()) {
    const part = parts[index] ?? 0;
    if (part !== least) return part > least;
  }
  return true;
}

/**
 * Hosts this user may be placed on that run the revision's guest contract:
 * connected, fresh and healthy, reporting bridge 9 with strict CPU isolation
 * (and Ready, when not a platform host), and served a desired state that
 * carries the current Kino pin of that contract. A host that reports no
 * strict CPU capacity at all (no KVM or hard CPU quota, as while jailerd has
 * no self-test for this boot) cannot run anything: it is not a full host, so
 * a fleet of only such hosts is unavailable rather than contended.
 */
async function eligibleRevisionHosts(input: {
  userId: string;
  organizationId: string | null;
  guestContract: number;
  kino: string;
  requestedHostId?: string;
  /** Platform hosts only: a verify run never runs on a host a user controls. */
  platformOnly?: boolean;
  /** The revision has a Talos cluster: only an agent that boots one. */
  cluster?: boolean;
  now: number;
}): Promise<RevisionHostCandidate[]> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      id: agentHosts.id,
      scope: agentHosts.scope,
      connected: agentHosts.connected,
      lastHeartbeatAt: agentHosts.lastHeartbeatAt,
      credentialGeneration: agentHosts.credentialGeneration,
      activeSessionId: agentHosts.activeSessionId,
      actualReportedAt: hostActualState.updatedAt,
      actualReportText: hostActualState.reportJson,
      helloJson: agentHosts.helloJson,
    })
    .from(agentHosts)
    .innerJoin(hostActualState, eq(hostActualState.hostId, agentHosts.id))
    .where(and(
      eq(agentHosts.disabled, false),
      eq(agentHosts.role, "agent"),
      eq(agentHosts.scenarioEnabled, true),
      eq(agentHosts.connected, true),
      input.requestedHostId ? eq(agentHosts.id, input.requestedHostId) : undefined,
      input.platformOnly ? eq(agentHosts.scope, "platform") : undefined,
      metalPlacementForUser(input.userId, input.organizationId),
    ))
    .orderBy(desc(agentHosts.updatedAt));
  const candidates: RevisionHostCandidate[] = [];
  for (const row of rows) {
    const report = row.actualReportText as unknown as HostStateReportV3;
    if (
      !row.scope || !row.activeSessionId || row.credentialGeneration <= 0 ||
      !isAvailableScenarioLaunchHost({ role: "agent", disabled: false, scenarioEnabled: true,
        connected: row.connected, lastHeartbeatAt: row.lastHeartbeatAt }, input.now, HOST_HEARTBEAT_TTL_MS) ||
      hostHealth(row.actualReportedAt, input.now) !== "healthy" ||
      report.schema_version !== HOST_STATE_REPORT_SCHEMA_VERSION_V3 ||
      report.guest_contract !== input.guestContract ||
      // Load is the planner's to judge, so a busy host is contended, not unable.
      !strictCpuHardware(report) ||
      (row.scope !== "platform" && !hostReportV3Ready(report)) ||
      (input.cluster === true && !agentBootsTalos(row.helloJson))
    ) continue;
    const desired = await loadStoredHostDesiredState(db, row.id, input.now);
    if (desired.kino_pin !== input.kino) continue;
    candidates.push({
      hostId: row.id,
      scope: row.scope,
      credentialGeneration: row.credentialGeneration,
      activeSessionId: row.activeSessionId,
      actualReportedAt: row.actualReportedAt,
      actualReportText: JSON.stringify(row.actualReportText),
      report,
      readsMayRestore: agentReadsMayRestore(row.helloJson),
      desired,
    });
  }
  if (!candidates.length) throw noEligibleHost();
  return candidates;
}

/**
 * The first candidate with room for the run, and its next desired state.
 * The desired-state version is read before the capacity, as the catalog
 * start does: the commit compares and sets that version.
 */
async function planRevisionHost(input: {
  candidates: readonly RevisionHostCandidate[];
  desiredVms: readonly DesiredVmV3[];
  /** The run's VM may start from a snapshot, on a host that takes that word. */
  mayRestore?: boolean;
  cpuMillis: number;
  reservationResources: Parameters<typeof runtimeResourcesFit>[0];
  now: number;
  /** The candidates' desired state moved since they were found: read it again. */
  reload?: boolean;
}): Promise<AdmissionHostAllocation> {
  const db = drizzle(env.DB);
  for (const candidate of input.candidates) {
    // The eligibility check read this version a moment ago, before any
    // capacity, and the commit fails if it moved since.
    const current = input.reload ? await loadStoredHostDesiredState(db, candidate.hostId, input.now) : candidate.desired;
    const [reservations, snapshot] = await Promise.all([
      db
        .select({ runId: hostCpuReservations.runId, cpuMillis: hostCpuReservations.cpuMillis, state: hostCpuReservations.state })
        .from(hostCpuReservations)
        .where(eq(hostCpuReservations.hostId, candidate.hostId)),
      loadActiveRuntimeResourceSnapshot(input.now, [candidate.hostId]),
    ]);
    const capacity = hostCpuReservationCapacityFromSnapshot(candidate.report, reservations);
    if (!capacity || input.cpuMillis > capacity.availableCpuMillis) continue;
    const available = availableRuntimeHostResources({
      hostId: candidate.hostId,
      report: candidate.report,
      snapshot,
    });
    if (!available || !runtimeResourcesFit(input.reservationResources, available)) continue;
    const next = checkedHostDesiredStateV3(
      {
        ...current,
        version: current.version + 1,
        generated_at_unix_ms: input.now,
        // Only a platform host, and only one whose agent reads the field:
        // any other would refuse the whole desired state.
        vms: [...current.vms, ...(input.mayRestore && candidate.scope === "platform" && candidate.readsMayRestore
          ? input.desiredVms.map((vm) => ({ ...vm, may_restore: true }))
          : input.desiredVms)],
      } satisfies HostDesiredStateV3,
      candidate.hostId,
      current.version + 1,
    );
    return {
      hostId: candidate.hostId,
      readiness: {
        credentialGeneration: candidate.credentialGeneration,
        activeSessionId: candidate.activeSessionId,
        actualReportedAt: candidate.actualReportedAt,
        actualReportText: candidate.actualReportText,
      },
      expectedVersion: current.version,
      nextVersion: next.version,
      nextDocJson: JSON.stringify(next),
    };
  }
  throw appError(409, "scenario_host_capacity_contended", "no scenario host has room for this run; retry the start");
}

/**
 * On a personal or organization host, grants the run's images before the
 * run exists, as the catalog start's preparation does: the preparation row
 * names the digests (`images_json`) and the host caches them. Content
 * access is rechecked inside the write. A platform host already caches
 * every live and candidate image. The run is admitted only once the host
 * reports the images ready; until then the start is refused, and this
 * preparation, which it writes on purpose and a later start renews, keeps
 * the host pulling.
 */
async function prepareRevisionImages(input: {
  access: AdmissionContentAccess;
  requestKey: string;
  candidates: readonly RevisionHostCandidate[];
  images: readonly string[];
  now: number;
}): Promise<void> {
  const host = input.candidates[0];
  if (!host || host.scope === "platform") return;
  const db = drizzle(env.DB);
  const current = await loadStoredHostDesiredState(db, host.hostId, input.now);
  const others = await env.DB.prepare(`SELECT images_json FROM personal_image_preparations prep
      WHERE prep.host_id = ?1 AND prep.user_id <> ?2 AND ${preparationAuthoritySql()}`)
    .bind(host.hostId, input.access.userId).all<{ images_json: string }>();
  const cached = new Set(input.images);
  for (const row of others.results) {
    for (const image of JSON.parse(row.images_json) as unknown[]) {
      if (typeof image === "string") cached.add(image);
    }
  }
  const next = checkedHostDesiredStateV3(
    { ...current, version: current.version + 1, generated_at_unix_ms: input.now, cached_images: [...cached].sort() },
    host.hostId,
    current.version + 1,
  );
  const columns = "user_id, host_id, credential_generation, request_key, access_json, images_json, expires_at";
  const values = [input.access.userId, host.hostId, host.credentialGeneration, input.requestKey,
    JSON.stringify(input.access), JSON.stringify(input.images), input.now + PERSONAL_IMAGE_PREPARATION_TTL_MS];
  // Every granted digest is an image of the scenario's live revision.
  const [updated] = await env.DB.batch([
    env.DB.prepare(`WITH prep (${columns}) AS (VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7))
      UPDATE host_desired_state SET version = ?8, doc_json = ?9, updated_at = ?10
      WHERE host_id = ?2 AND version = ?11 AND EXISTS (SELECT 1 FROM prep
        WHERE ${preparationAuthoritySql()}
          AND json_array_length(prep.images_json) > 0
          AND NOT EXISTS (SELECT 1 FROM json_each(prep.images_json) image
            WHERE NOT EXISTS (SELECT 1 FROM scenarios scenario
              JOIN scenario_revisions revision
                ON revision.scenario_id = scenario.id AND revision.rev = scenario.live_rev
              JOIN json_each(revision.doc_json, '$.machines') machine
              WHERE scenario.id = json_extract(prep.access_json, '$.scenarioId')
                AND json_extract(machine.value, '$.image_digest') = image.value)))
      RETURNING host_id`).bind(...values, next.version, JSON.stringify(next), input.now, current.version),
    env.DB.prepare(`INSERT INTO personal_image_preparations (${columns})
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE changes() = 1
      ON CONFLICT(user_id) DO UPDATE SET host_id = excluded.host_id,
        credential_generation = excluded.credential_generation, request_key = excluded.request_key,
        access_json = excluded.access_json,
        images_json = excluded.images_json, expires_at = excluded.expires_at`).bind(...values),
  ]);
  if (!updated?.results.length) {
    throw appError(409, "scenario_host_capacity_contended", "your server changed while the run was starting; retry the start");
  }
  await tryWakeHostRuntime(host.hostId);
}

/**
 * Cancels a committed revision run whose owner lost access inside the commit
 * window: the run to teardown first, then its VMs absent. A crash in between
 * leaves a run in teardown, which the teardown sweep finishes, and VMs
 * whose run no longer passes the workload filter, which marks them absent
 * on the next dispatch.
 */
async function cancelRevisionRun(input: { runId: string; userId: string; hostId: string }): Promise<void> {
  const now = Date.now();
  await cancelRunStatement(input, now).run();
  await markStoredDesiredVmsAbsent(drizzle(env.DB), input.hostId, now, (vm) => vm.run_id === input.runId);
  await deliveryHint(input.hostId);
}

function noEligibleHost() {
  return appError(409, "scenario_host_unavailable", "no scenario host can run this scenario yet");
}
