import { env } from "cloudflare:workers";
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  cpuReservationForVms,
  hostCpuReservationCapacityFromSnapshot,
  HOST_STATE_REPORT_SCHEMA_VERSION_V3,
} from "@/control-plane/host-cpu-reservations";
import { readKinoPin } from "@/control-plane/image-registry/push";
import { agentHosts, hostActualState, hostCpuReservations } from "@/db/schema";
import type { HostStateReportV2 } from "@/generated/bridge";
import type {
  DesiredVmV3,
  HostDesiredStateV3,
  HostStateReportV3,
} from "@/generated/contracts/bridge-message-v9";
import type { ScenarioRevisionV1 } from "@/generated/contracts/scenario-revision-v1";
import { appError } from "@/lib/app-error";
import type { assertCourseScenarioStartAllowed } from "@/lib/course-catalogs";
import {
  checkedHostDesiredStateV3,
  isHostDesiredStateV3,
  loadStoredHostDesiredState,
  markStoredDesiredVmsAbsent,
} from "@/lib/desired-state-store";
import { hostHealth } from "@/lib/host-health";
import { tryWakeHostRuntime } from "@/lib/host-runtime-wake";
import { createAppId } from "@/lib/id";
import { metalPlacementForUser } from "@/lib/metal-placement";
import { preparationAuthoritySql } from "@/lib/personal-image-access";
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
import { PERSONAL_IMAGE_PREPARATION_TTL_MS } from "@/lib/personal-image-preparation";
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
  scenarioSourceChanged,
  type AdmissionHostAllocation,
  type BeginScenarioRunInput,
  type BeginScenarioRunResult,
} from "./begin";
import { HOST_HEARTBEAT_TTL_MS, scenarioRuntimeReservationResources } from "./start";
import { activeKeyFor } from "./storage";

/** A run's VMs live this long unless the run renews them. */
const REVISION_RUN_LEASE_MS = 3_600_000;

export interface LiveScenarioRevision {
  scenarioId: string;
  rev: string;
  guestContract: number;
  doc: ScenarioRevisionV1;
}

/**
 * The revision a learner start runs: the scenario's `live_rev`, while the
 * scenario is enabled for this organization and that revision is ready or
 * verified. Promotion owns `live_rev`; this is its only reader for starts.
 */
export async function liveScenarioRevision(
  d1: D1Database,
  scenarioId: string,
  organizationId: string | null,
): Promise<LiveScenarioRevision | null> {
  const row = await d1.prepare(
    `SELECT scenario.id, revision.rev, revision.guest_contract, revision.doc_json
       FROM scenarios scenario
       JOIN scenario_revisions revision
         ON revision.scenario_id = scenario.id AND revision.rev = scenario.live_rev
      WHERE scenario.id = ?1 AND scenario.enabled = 1
        AND revision.state IN ('ready', 'verified')
        AND (scenario.organization_id IS NULL OR scenario.organization_id = ?2)`,
  ).bind(scenarioId, organizationId).first<{ id: string; rev: string; guest_contract: number; doc_json: string }>();
  if (!row) return null;
  return { scenarioId: row.id, rev: row.rev, guestContract: row.guest_contract, doc: JSON.parse(row.doc_json) };
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

/** Every machine image of a live revision of guest contract `contract`. */
export async function liveRevisionImages(d1: D1Database, contract: number): Promise<string[]> {
  const { results } = await d1.prepare(
    `SELECT DISTINCT json_extract(machine.value, '$.image_digest') AS image
       FROM scenarios scenario
       JOIN scenario_revisions revision
         ON revision.scenario_id = scenario.id AND revision.rev = scenario.live_rev
       JOIN json_each(revision.doc_json, '$.machines') machine
      WHERE scenario.enabled = 1 AND revision.state IN ('ready', 'verified')
        AND revision.guest_contract = ?1
        AND json_extract(machine.value, '$.image_digest') IS NOT NULL`,
  ).bind(contract).all<{ image: string }>();
  return results.map((row) => row.image);
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
  courseLecture: Awaited<ReturnType<typeof assertCourseScenarioStartAllowed>>;
  idempotencyKey: string;
  scope: ScenarioStartRequestScope;
}): Promise<BeginScenarioRunResult> {
  const { input, revision, organizationId, courseLecture } = context;
  const doc = revision.doc;
  if (!doc.machines.length || doc.machines.some((machine) => !machine.image_digest)) {
    throw appError(409, "image_not_ready", "scenario images are not built yet");
  }
  const pin = await readKinoPin(env, revision.guestContract);
  if (!pin) throw noEligibleHost();

  const runId = createAppId();
  const createdAt = Date.now();
  const leaseExpiresAt = createdAt + REVISION_RUN_LEASE_MS;
  const machines = doc.machines.map((machine, ordinal) => ({
    machine,
    ordinal,
    vmId: createAppId(),
    runtimeVmName: revisionVmId(machine.name, runId),
    image: machine.image_digest as string,
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
        leaseDurationSeconds: REVISION_RUN_LEASE_MS / 1000,
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
  // spec and Kino. The VM mirror row keeps it as the image key.
  const runtimeVms: Array<RuntimeVmSpec & { runtimeVmId: string }> = machines.map(({ machine, ordinal, vmId, runtimeVmName, image }) => ({
    runtimeVmId: createAppId(),
    vmId,
    ordinal,
    runtimeVmName,
    imageKey: { build_key: machine.build_key, spec: machine.spec, kino: pin.current },
    imageSha256: image,
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
    spec: machine.spec,
    mode: "learn",
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
  const lecture = courseLecture.lecture;
  const run = {
    runId,
    userId: input.userId,
    organizationId,
    runtimeExecutionId: runId,
    hostId: "",
    scenarioId: revision.scenarioId,
    scenarioName: revision.scenarioId,
    scenarioRev: revision.rev,
    tasksJson: doc.tasks,
    launchSource: "course" as const,
    courseScopeKey: courseLecture.courseScopeKey,
    courseId: courseLecture.courseId,
    courseTitle: courseLecture.courseTitle,
    lectureId: courseLecture.lectureId,
    lectureTitle: courseLecture.lectureTitle,
    lectureSummary: courseLecture.lectureSummary,
    lectureBodyMarkdown: courseLecture.lectureBodyMarkdown,
    lectureOrdinal: courseLecture.lectureOrdinal,
    lectureCount: courseLecture.lectureCount,
    title: lecture.title || doc.title,
    tagline: lecture.summary || doc.summary,
    briefingMarkdown: doc.briefing,
    objectivesJson: "[]",
    difficulty: lecture.difficulty ?? doc.difficulty,
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
    activeKey: activeKeyFor(input.userId),
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
    courseScopeKey: courseLecture.courseScopeKey,
    courseId: courseLecture.courseId,
    lectureId: courseLecture.lectureId,
    allowSequenceBypass: input.allowSequenceBypass === true,
    requiresAdmin: input.allowDrainedAdminProof === true || input.allowSequenceBypass === true,
  };
  const images = [...new Set(machines.map((machine) => machine.image))].sort();
  for (let attempt = 1; attempt <= ADMISSION_CAS_ATTEMPTS; attempt += 1) {
    const now = Date.now();
    const candidates = await eligibleRevisionHosts({
      userId: input.userId,
      organizationId,
      guestContract: revision.guestContract,
      kino: pin.current,
      ...(input.hostId ? { requestedHostId: input.hostId } : {}),
      now,
    });
    await prepareRevisionImages({ access, requestKey: context.idempotencyKey, candidates, images, now });
    const allocated = await planRevisionHost({ candidates, desiredVms, cpuMillis, reservationResources, now });
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
      candidateProof: null,
      sourceAnchor: null,
      revisionAnchor: revision.rev,
      ...(input.allowDrainedAdminProof ? { allowDrainedAdminProof: true } : {}),
      now: Date.now(),
    });
    if (outcome.ok) {
      try {
        await assertAccountStillActive({ userId: input.userId, runId, hostId: allocated.hostId });
      } catch (error) {
        await cancelRevisionRun({ runId, userId: input.userId, hostId: allocated.hostId });
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
    if (outcome.reason === "error") throw outcome.error;
    await assertAdmissionRefusalPriority({
      userId: input.userId,
      ...(input.allowDrainedAdminProof ? { allowDrainedAdminProof: true } : {}),
    });
    if (!(await liveRevisionHolds(env.DB, revision.scenarioId, revision.rev))) throw scenarioSourceChanged();
    await assertCurrentContentAccess({ ...run, hostId: allocated.hostId }, input.allowDrainedAdminProof);
  }
  throw appError(409, "scenario_host_capacity_contended", "scenario capacity changed during admission; retry the start");
}

interface RevisionHostCandidate {
  hostId: string;
  scope: "platform" | "personal" | "organization";
  credentialGeneration: number;
  activeSessionId: string;
  actualReportedAt: number;
  actualReportText: string;
  report: HostStateReportV3;
}

/**
 * Hosts this user may be placed on that run the revision's guest contract:
 * connected, fresh and healthy, reporting bridge 9 with strict CPU isolation
 * (and Ready, when not a platform host), and served a desired state that
 * carries the current Kino pin of that contract.
 */
async function eligibleRevisionHosts(input: {
  userId: string;
  organizationId: string | null;
  guestContract: number;
  kino: string;
  requestedHostId?: string;
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
    })
    .from(agentHosts)
    .innerJoin(hostActualState, eq(hostActualState.hostId, agentHosts.id))
    .where(and(
      eq(agentHosts.disabled, false),
      eq(agentHosts.role, "agent"),
      eq(agentHosts.scenarioEnabled, true),
      eq(agentHosts.connected, true),
      input.requestedHostId ? eq(agentHosts.id, input.requestedHostId) : undefined,
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
      (row.scope !== "platform" && !hostReportV3Ready(report))
    ) continue;
    const desired = await loadStoredHostDesiredState(db, row.id, input.now);
    if (!isHostDesiredStateV3(desired) || desired.kino_pin !== input.kino) continue;
    candidates.push({
      hostId: row.id,
      scope: row.scope,
      credentialGeneration: row.credentialGeneration,
      activeSessionId: row.activeSessionId,
      actualReportedAt: row.actualReportedAt,
      actualReportText: JSON.stringify(row.actualReportText),
      report,
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
  cpuMillis: number;
  reservationResources: Parameters<typeof runtimeResourcesFit>[0];
  now: number;
}): Promise<AdmissionHostAllocation> {
  const db = drizzle(env.DB);
  for (const candidate of input.candidates) {
    const current = await loadStoredHostDesiredState(db, candidate.hostId, input.now);
    if (!isHostDesiredStateV3(current)) continue;
    const reservations = await db
      .select({ runId: hostCpuReservations.runId, cpuMillis: hostCpuReservations.cpuMillis, state: hostCpuReservations.state })
      .from(hostCpuReservations)
      .where(eq(hostCpuReservations.hostId, candidate.hostId));
    const capacity = hostCpuReservationCapacityFromSnapshot(candidate.report, reservations);
    if (!capacity || input.cpuMillis > capacity.availableCpuMillis) continue;
    const snapshot = await loadActiveRuntimeResourceSnapshot(input.now, [candidate.hostId]);
    const available = availableRuntimeHostResources({
      hostId: candidate.hostId,
      report: capacityReportView(candidate.report),
      snapshot,
    });
    if (!available || !runtimeResourcesFit(input.reservationResources, available)) continue;
    const next = checkedHostDesiredStateV3(
      {
        ...current,
        version: current.version + 1,
        generated_at_unix_ms: input.now,
        vms: [...current.vms, ...input.desiredVms],
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

/** A bridge 9 report as the shared capacity reader names its VMs. */
function capacityReportView(report: HostStateReportV3): HostStateReportV2 {
  return {
    ...report,
    vms: report.vms.map((vm) => ({ ...vm, vm_name: revisionVmId(vm.name, vm.run_id) })),
  } as unknown as HostStateReportV2;
}

/**
 * On a personal or organization host, grants the run's images before the
 * run exists, as the catalog start's preparation does: the preparation row
 * names the digests (`images_json`) and the host caches them. Content
 * access is rechecked inside the write. A platform host already caches
 * every live image.
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
  if (!isHostDesiredStateV3(current)) return;
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
 * window: its VMs go absent, then the run to teardown. A crash in between
 * leaves VMs whose run no longer passes the workload filter, which marks
 * them absent on the next dispatch.
 */
async function cancelRevisionRun(input: { runId: string; userId: string; hostId: string }): Promise<void> {
  const now = Date.now();
  await markStoredDesiredVmsAbsent(drizzle(env.DB), input.hostId, now, (vm) => vm.run_id === input.runId);
  await cancelRunStatement(input, now).run();
  await deliveryHint(input.hostId);
}

function noEligibleHost() {
  return appError(409, "scenario_host_unavailable", "no scenario host can run this scenario yet");
}
