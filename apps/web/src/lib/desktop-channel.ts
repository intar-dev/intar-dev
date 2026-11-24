// The desktop app's channel to intar (#399), first slice: who the caller is,
// and starting, reading and ending a local run.
//
// The app signs in through the OAuth provider as a public client and sends
// its opaque access token as a bearer credential. The provider has no helper
// that verifies such a token for a client without a secret, so the check is
// one read here, on the hash the provider stores.

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { activeAccountSql, usableIdentityExistsSql } from "@/lib/account-access";
import { jsonResponse } from "@/lib/agent-bridge";
import { AppError, toErrorResponse } from "@/lib/app-error";
import { hashStoredOAuthToken } from "@/lib/auth";
import {
  completePureCourseLectureForUser, listCourseCatalogForUser, loadCourseLectureDetailForUser,
  type CourseLectureDetailForUser,
} from "@/lib/course-catalogs";
import type { VmStateV3 } from "@/generated/contracts/bridge-message-v9";
import validateBridgeMessageV9 from "@/generated/contracts/bridge-message-v9.validate";
import { requireIdempotencyKey } from "@/lib/idempotency-key";
import { endLocalRun, localHostId } from "@/lib/local-runs";
import { resolveOrganizationId } from "@/lib/organizations";
import { enforceRateLimit } from "@/lib/request-security";
import { applyVmStateV3ToRunState } from "@/lib/run-lifecycle";
import { learnerCheckStatus, repairObjectiveTitle } from "@/lib/verification-copy";
import { persistRunState } from "@/lib/run-projection";
import { presentScenarioRun } from "@/lib/run-phase";
import { revealScenarioRunHintForUser, revealScenarioRunSolutionForUser } from "@/lib/scenario-hints";
import { isRevisionScenarioId } from "@/lib/scenario-id";
import { decodeScenarioRunArtifactRouteParams, serveScenarioRunArtifactContent } from "@/lib/scenario-run-artifact-content";
import { getScenarioRunForUser, listScenarioRunsForUser, type ScenarioRunRecord } from "@/lib/scenario-runs";
import { beginScenarioRun } from "@/lib/scenario-runs/begin";
import { arm64MachineImages, liveScenarioRevision } from "@/lib/scenario-runs/revision-begin";
import {
  getRunRecapObjectives, getRunRecapState, getRunReplayAvailability, getRunReplayParts,
} from "@/components/app/run/run-recap-model";
import type { ScenarioRunRecord as RunViewRecord } from "@/components/app/run/run-types";

/** The one OAuth client the routes accept. A deploy seeds its row (apps/web/seeds). */
export const DESKTOP_OAUTH_CLIENT_ID = "intar-jumper";
export const LOCAL_RUNS_SCOPE = "local-runs";
/** Version of this channel's requests and answers. */
export const DESKTOP_PROTOCOL = 1;
/** The processors machine images exist for, as the app names its own (Rust's names). */
const IMAGE_ARCHITECTURES: Record<string, "amd64" | "arm64"> = { x86_64: "amd64", aarch64: "arm64" };

/** The targets the app is released for, by what it sends as `os` and `arch`. */
const APP_TARGETS: Record<string, string> = { "macos aarch64": "macos_arm64" };
const APP_RELEASE_BASE = "https://github.com/intar-dev/intar-dev/releases/download";

/**
 * The release an installed app is offered as its update (#404), for the
 * system and processor it names: its version, where its zip is, and the
 * SHA-256 the app checks the download against. `release` is null while none
 * is pinned for that target, and for a target the app is not released for.
 *
 * Public and the same for everyone: it holds what a release page shows. The
 * hash comes from the deploy's configuration, not from the release, so a
 * replaced download is refused by the app.
 */
export function appReleaseRequest(request: Request, workerEnv: { JUMPER_RELEASE_JSON?: string | undefined } = env): Response {
  if (request.method !== "GET") return jsonResponse({ error: "method not allowed" }, { status: 405 });
  const query = new URL(request.url).searchParams;
  const target = APP_TARGETS[`${query.get("os")} ${query.get("arch")}`];
  let pins: unknown = null;
  try {
    pins = JSON.parse(workerEnv.JUMPER_RELEASE_JSON || "null");
  } catch {
    // An unreadable value pins none.
  }
  const pin = target && pins !== null && typeof pins === "object" ? (pins as Record<string, unknown>)[target] : null;
  const release =
    pin !== null && typeof pin === "object" &&
    typeof (pin as { version?: unknown }).version === "string" &&
    /^\d+\.\d+\.\d+$/.test((pin as { version: string }).version) &&
    typeof (pin as { sha256?: unknown }).sha256 === "string" &&
    /^[0-9a-f]{64}$/.test((pin as { sha256: string }).sha256)
      ? (pin as { version: string; sha256: string })
      : null;
  return jsonResponse(
    {
      protocol: DESKTOP_PROTOCOL,
      release: release && {
        version: release.version,
        sha256: release.sha256,
        url: `${APP_RELEASE_BASE}/desktop%2Fv${release.version}/intar-desktop_${release.version}_${target}.zip`,
      },
    },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}

export type DesktopCaller =
  | { ok: true; userId: string; accessTokenId: string }
  | { ok: false; response: Response };

const signedOut = () =>
  jsonResponse(
    { error: "unauthorized", code: "signed_out" },
    { status: 401, headers: { "www-authenticate": "Bearer", "cache-control": "no-store" } },
  );

/**
 * The learner behind the app's access token. The token must be the app's
 * own, unexpired and unrevoked, carry the local-runs scope, still have its
 * session if it was bound to one, and belong to an account that could sign
 * in now. A cookie is never read here. The provider stores the scopes as a
 * JSON string holding the array; a plain array is read too.
 */
export async function requireDesktopCaller(
  request: Request,
  d1: D1Database = env.DB,
): Promise<DesktopCaller> {
  const header = request.headers.get("authorization") ?? "";
  const presented = /^Bearer ([A-Za-z0-9._~+/-]{16,512}=*)$/u.exec(header)?.[1];
  if (!presented) return { ok: false, response: signedOut() };
  const row = await d1.prepare(
    `SELECT token.id, token.user_id FROM oauth_access_token token
       JOIN oauth_client client ON client.client_id = token.client_id
       JOIN user owner ON owner.id = token.user_id
      WHERE token.token = ?1 AND token.client_id = ?2
        AND token.expires_at > ?3 AND token.revoked IS NULL
        AND coalesce(client.disabled, 0) = 0
        AND EXISTS (SELECT 1 FROM json_each(CASE json_type(token.scopes)
          WHEN 'text' THEN token.scopes ->> '$' ELSE token.scopes END) scope WHERE scope.value = ?4)
        AND (token.session_id IS NULL OR EXISTS (SELECT 1 FROM session bound
          WHERE bound.id = token.session_id AND bound.expires_at > ?3))
        AND ${activeAccountSql("owner")}
        AND ${usableIdentityExistsSql("owner.id")}`,
  ).bind(await hashStoredOAuthToken(presented), DESKTOP_OAUTH_CLIENT_ID, Date.now(), LOCAL_RUNS_SCOPE)
    .first<{ id: string; user_id: string }>();
  if (!row) return { ok: false, response: signedOut() };
  return { ok: true, userId: row.user_id, accessTokenId: row.id };
}

export interface LocalRunMachine {
  name: string;
  /** The VM's name in the archive routes (`/api/local/archive/...`). */
  runtimeName: string;
  image: string;
  spec: string;
  kino: string;
  mode: "learn";
  cpuMillis: number;
  memoryMib: number;
  diskMib: number;
  egress: boolean;
  terminal: boolean;
  peers: string[];
}

export interface LocalRunView {
  runId: string;
  scenarioId: string;
  /** The run's phase as the server holds it; the app stops its VMs when `active` is false. */
  state: string;
  active: boolean;
  /** The learner; every VM state the app reports names them as its owner. */
  userId: string;
  /** Every VM state the app reports names this execution and generation. */
  executionId: string | null;
  generation: number | null;
  machines: LocalRunMachine[];
}

/** What the app runs for a local run of this learner, and where the run stands. */
export async function localRunView(
  d1: D1Database,
  runId: string,
  userId: string,
): Promise<LocalRunView | null> {
  const row = await d1.prepare(
    `SELECT run.scenario_id, run.state, run.active_key IS NOT NULL AS active, run.state_json, revision.doc_json,
        run.runtime_execution_id AS execution_id,
        (SELECT execution.generation FROM runtime_executions execution
          WHERE execution.id = run.runtime_execution_id) AS generation,
        (SELECT json_group_array(json_object('vmId', vm.vm_id, 'runtimeName', vm.runtime_vm_name, 'ordinal', vm.ordinal, 'image', vm.image_digest,
            'spec', vm.spec_digest, 'kino', vm.kino_digest, 'cpuMillis', vm.cpu_millis,
            'memoryMib', vm.memory_mib, 'diskMib', vm.disk_mib))
           FROM runtime_vms vm WHERE vm.execution_id = run.runtime_execution_id) AS vms
       FROM scenario_runs run
       LEFT JOIN scenario_revisions revision
         ON revision.scenario_id = run.scenario_id AND revision.rev = run.scenario_rev
      WHERE run.run_id = ?1 AND run.user_id = ?2 AND run.runtime = 'local'`,
  ).bind(runId, userId).first<{
    scenario_id: string; state: string; active: number; state_json: string; doc_json: string | null; vms: string;
    execution_id: string | null; generation: number | null;
  }>();
  if (!row) return null;
  const names = new Map<string, string>(
    (JSON.parse(row.state_json) as { vms?: Array<{ id: string; scenarioVmName: string }> }).vms
      ?.map((vm) => [vm.id, vm.scenarioVmName]) ?? [],
  );
  const described = new Map<string, { egress?: boolean; terminal?: boolean }>(
    (row.doc_json ? (JSON.parse(row.doc_json) as { machines?: Array<{ name: string; egress?: boolean; terminal?: boolean }> }).machines ?? [] : [])
      .map((machine) => [machine.name, machine]),
  );
  const vms = (JSON.parse(row.vms) as Array<{
    vmId: string; runtimeName: string; ordinal: number; image: string; spec: string; kino: string;
    cpuMillis: number; memoryMib: number; diskMib: number;
  }>).sort((a, b) => a.ordinal - b.ordinal);
  const allNames = vms.map((vm) => names.get(vm.vmId) ?? vm.vmId);
  return {
    runId,
    scenarioId: row.scenario_id,
    state: row.state,
    active: row.active === 1,
    userId,
    executionId: row.execution_id,
    generation: row.generation,
    machines: vms.map((vm, index) => {
      const name = allNames[index]!;
      return {
        name,
        runtimeName: vm.runtimeName,
        image: vm.image,
        spec: vm.spec,
        kino: vm.kino,
        mode: "learn",
        cpuMillis: vm.cpuMillis,
        memoryMib: vm.memoryMib,
        diskMib: vm.diskMib,
        egress: described.get(name)?.egress === true,
        terminal: described.get(name)?.terminal !== false,
        peers: allNames.filter((peer) => peer !== name),
      };
    }),
  };
}

const refuse = (status: number, code: string, error: string) =>
  jsonResponse({ error, code, protocol: DESKTOP_PROTOCOL }, { status, headers: { "cache-control": "no-store" } });
const answer = (run: LocalRunView, extra: Record<string, unknown> = {}, status = 200) =>
  jsonResponse({ protocol: DESKTOP_PROTOCOL, run, ...extra }, { status, headers: { "cache-control": "no-store" } });

/**
 * `POST /api/local/runs`: start a local run. The body names the scenario,
 * the protocol the app speaks, the guest contracts it implements and its
 * architecture. No admin option of the internal start is reachable here.
 */
export async function startLocalRunRequest(
  request: Request,
  workerEnv: Cloudflare.Env = env,
): Promise<Response> {
  const caller = await requireDesktopCaller(request, workerEnv.DB);
  if (!caller.ok) return caller.response;
  const limited = await enforceRateLimit(request, workerEnv, "scenario-start", `desktop:${caller.userId}`);
  if (!limited.ok) return limited.response;

  let idempotencyKey: string;
  try {
    idempotencyKey = requireIdempotencyKey(request.headers.get("Idempotency-Key") ?? undefined);
  } catch (error) {
    const { status, body } = toErrorResponse(error, "invalid Idempotency-Key");
    return jsonResponse(body, { status });
  }
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return refuse(400, "invalid_body", "the body must be a JSON object");
  }
  if (body.protocol !== DESKTOP_PROTOCOL) {
    return refuse(409, "upgrade_required", "this version of the app is too old to start a run; update it");
  }
  const { scenarioId, organizationId: organizationKey, guestContracts, arch } = body;
  // The app boots Talos cluster labs; an older one cannot.
  const clusters = body.clusters === true;
  if (typeof scenarioId !== "string" || !isRevisionScenarioId(scenarioId)) {
    return refuse(400, "invalid_scenario", "scenarioId must be <namespace>/<slug>");
  }
  if (!Array.isArray(guestContracts) || guestContracts.length === 0 || guestContracts.length > 16 ||
      !guestContracts.every((contract) => Number.isSafeInteger(contract))) {
    return refuse(400, "invalid_guest_contracts", "guestContracts must list the guest contracts the app implements");
  }
  if (organizationKey !== undefined && organizationKey !== null && typeof organizationKey !== "string") {
    return refuse(400, "invalid_organization", "organizationId must be a string");
  }
  const architecture = typeof arch === "string" && Object.hasOwn(IMAGE_ARCHITECTURES, arch) ? IMAGE_ARCHITECTURES[arch] : undefined;
  if (!architecture) {
    return refuse(409, "architecture_unavailable", "no machine images exist for this computer's architecture yet");
  }
  const organizationId = typeof organizationKey === "string" && organizationKey.trim()
    ? await resolveOrganizationId(organizationKey.trim())
    : null;
  // An organization the learner is not in answers like one that does not
  // exist, before any of its scenarios is looked up.
  if (typeof organizationKey === "string" && organizationKey.trim() && (!organizationId ||
      !(await workerEnv.DB.prepare("SELECT 1 FROM member WHERE organization_id = ?1 AND user_id = ?2")
        .bind(organizationId, caller.userId).first()))) {
    return refuse(404, "scenario_not_found", "scenario not found");
  }
  // Refuse what the app cannot boot before a run exists. The admission
  // anchors the same live revision again at its commit.
  const revision = await liveScenarioRevision(workerEnv.DB, scenarioId, organizationId);
  if (!revision) return refuse(404, "scenario_not_found", "scenario not found");
  if (!guestContracts.includes(revision.guestContract)) {
    return refuse(409, "upgrade_required", "this scenario needs a newer version of the app; update it");
  }
  if (!clusters && revision.doc.machines.some((machine) => machine.cluster_key !== undefined)) {
    return refuse(409, "upgrade_required", "this scenario needs a newer version of the app; update it");
  }

  try {
    const started = await beginScenarioRun({
      scenarioId,
      userId: caller.userId,
      idempotencyKey,
      organizationId,
      runtime: "local",
      ...(architecture === "arm64" ? { architecture } : {}),
      ...(clusters ? { clusters } : {}),
    });
    const run = await localRunView(workerEnv.DB, started.runId, caller.userId);
    if (!run) return refuse(500, "local_run_missing", "the run started but could not be read");
    return answer(run, { reused: started.reused }, started.reused ? 200 : 201);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    const { status, body: refusal } = toErrorResponse(error, "the run could not be started");
    return jsonResponse({ ...refusal, protocol: DESKTOP_PROTOCOL }, { status, headers: { "cache-control": "no-store" } });
  }
}

/** `GET /api/local/runs/<id>` and `POST /api/local/runs/<id>/end`. */
export async function localRunRequest(
  request: Request,
  runId: string,
  action: "read" | "end",
  workerEnv: Cloudflare.Env = env,
): Promise<Response> {
  const caller = await requireDesktopCaller(request, workerEnv.DB);
  if (!caller.ok) return caller.response;
  if (action === "end" && !(await endLocalRun({ d1: workerEnv.DB, runId, userId: caller.userId }))) {
    return refuse(404, "run_not_found", "run not found");
  }
  const run = await localRunView(workerEnv.DB, runId, caller.userId);
  return run ? answer(run) : refuse(404, "run_not_found", "run not found");
}

/**
 * `POST /api/local/runs/<id>/report`: the app reports its VMs in the shape
 * an agent host does (bridge 9 `VmStateV3`), and the same projection turns
 * them into phases, task states and course completion. A report for a run
 * the server has closed is refused; the answer says so, and the app stops.
 *
 * The server keeps no endpoint the device names: the terminal and network
 * of a local VM stay on the learner's computer.
 */
// ponytail: no rate limit; each report is one bounded write by a signed-in
// learner with an active run. Add a per-run limiter if that is abused.
// ponytail: reports are ordered by the device's clock per VM, as a host's
// are; add a sequence number if a device's clock proves unusable.
export async function reportLocalRunRequest(
  request: Request,
  runId: string,
  workerEnv: Cloudflare.Env = env,
): Promise<Response> {
  const caller = await requireDesktopCaller(request, workerEnv.DB);
  if (!caller.ok) return caller.response;
  const d1 = workerEnv.DB;
  const body = (await request.json().catch(() => null)) as { protocol?: unknown; vms?: unknown } | null;
  if (body?.protocol !== DESKTOP_PROTOCOL) {
    return refuse(409, "upgrade_required", "this version of the app is too old to report; update it");
  }
  const before = await localRunView(d1, runId, caller.userId);
  if (!before) return refuse(404, "run_not_found", "run not found");
  if (!before.active) {
    return jsonResponse(
      { error: "the run has ended", code: "run_closed", protocol: DESKTOP_PROTOCOL, run: before },
      { status: 409, headers: { "cache-control": "no-store" } },
    );
  }
  const hostId = localHostId(caller.userId);
  const reported = Array.isArray(body.vms) ? body.vms : [];
  if (reported.length === 0 || reported.length > before.machines.length) {
    return refuse(400, "invalid_report", "vms must list one to all of the run's machines, each once");
  }
  const vms: VmStateV3[] = [];
  for (const candidate of reported) {
    const vm = candidate as VmStateV3;
    const at = vm?.updated_at_unix_ms;
    const valid = validateBridgeMessageV9({
      type: "vm_report", protocol_version: 9, host_id: hostId,
      report: { schema_version: 7, host_id: hostId, observed_at_unix_ms: at, vm },
    });
    if (!valid || vm.run_id !== runId || vm.owner_user_id !== caller.userId ||
        vm.runtime_execution_id !== before.executionId || vm.generation !== before.generation ||
        !before.machines.some((machine) => machine.name === vm.name) ||
        vms.some((earlier) => earlier.name === vm.name)) {
      return refuse(400, "invalid_report", "a reported VM is malformed or not of this run");
    }
    vms.push({ ...vm, network: null, ssh_host_keys_openssh: [], terminal: { state: "pending", observed_at_unix_ms: at } });
  }
  const outcome = await persistRunState(
    d1,
    runId,
    (latest) => vms.reduce((state, vm) => applyVmStateV3ToRunState({ runId, current: state, vm }), latest),
    {
      keepDeleteRequestedAt: true,
      expectedExecution: { id: before.executionId!, ownerUserId: caller.userId, generation: before.generation! },
    },
  );
  if (outcome.kind !== "updated") {
    // An unchanged report still shows the device is there (LOCAL_RUN_SILENCE_MS).
    await d1.prepare(
      `UPDATE scenario_runs SET updated_at = max(updated_at + 1, ?2)
        WHERE run_id = ?1 AND runtime = 'local' AND active_key IS NOT NULL`,
    ).bind(runId, Date.now()).run();
  }
  const run = await localRunView(d1, runId, caller.userId);
  return run ? answer(run) : refuse(404, "run_not_found", "run not found");
}

/**
 * `GET /api/local/catalog`: the courses the learner sees on the website,
 * public ones and those of every organization they are in, with each
 * lecture's scenario and where the learner stands in it. A lecture names the
 * `scenarioId`, and its course the `organizationId`, that a start takes.
 * No admin option applies: a locked lecture stays locked.
 */
export async function localCatalogRequest(
  request: Request,
  workerEnv: Cloudflare.Env = env,
): Promise<Response> {
  const caller = await requireDesktopCaller(request, workerEnv.DB);
  if (!caller.ok) return caller.response;
  const { courses } = await listCourseCatalogForUser({
    db: drizzle(workerEnv.DB),
    userId: caller.userId,
    organizationId: null,
    local: true,
  });
  // On an arm64 computer a lecture can start only once its scenario's arm64
  // images exist; until then it waits, as one whose images are not built.
  // ponytail: one lookup per startable lecture; fold it into the catalog's
  // own readiness query if catalogs grow.
  if (new URL(request.url).searchParams.get("arch") === "aarch64") {
    for (const course of courses) {
      for (const lecture of course.lectures) {
        if (!lecture.scenarioId || (lecture.state !== "available" && lecture.state !== "in_progress")) continue;
        const revision = await liveScenarioRevision(workerEnv.DB, lecture.scenarioId, course.organizationId ?? null);
        if (!revision || !(await arm64MachineImages(workerEnv.DB, revision))) lecture.state = "waiting_for_scenario";
      }
    }
  }
  return jsonResponse({ protocol: DESKTOP_PROTOCOL, courses }, { headers: { "cache-control": "no-store" } });
}

/**
 * The organization a lecture request names in `?organizationId=` (an id or
 * slug), or null for a public course. `undefined` when it names one the
 * learner is not in, which answers like a missing course.
 */
async function lectureOrganization(request: Request, userId: string, d1: D1Database): Promise<string | null | undefined> {
  const key = new URL(request.url).searchParams.get("organizationId")?.trim();
  if (!key) return null;
  const organizationId = await resolveOrganizationId(key);
  if (!organizationId) return undefined;
  const member = await d1.prepare("SELECT 1 FROM member WHERE organization_id = ?1 AND user_id = ?2")
    .bind(organizationId, userId).first();
  return member ? organizationId : undefined;
}

const lectureAnswer = (courseId: string, lecture: CourseLectureDetailForUser) =>
  jsonResponse({
    protocol: DESKTOP_PROTOCOL,
    locked: false,
    lecture: {
      courseId,
      lectureId: lecture.lectureId,
      title: lecture.title,
      bodyMarkdown: lecture.bodyMarkdown,
      ordinal: lecture.lectureOrdinal,
      count: lecture.lectureCount,
      state: lecture.state,
    },
  }, { headers: { "cache-control": "no-store" } });

/**
 * `GET /api/local/courses/<course>/lectures/<lecture>` and its `/complete`:
 * a lecture's theory, as the website's lecture page loads it, and marking a
 * lecture without a lab as read. The course is the organization's when
 * `organizationId` names one the learner is in, else the public one. As in
 * the catalog, no admin option applies: a locked lecture stays locked.
 */
export async function localLectureRequest(
  request: Request,
  courseId: string,
  lectureId: string,
  action: "read" | "complete",
  workerEnv: Cloudflare.Env = env,
): Promise<Response> {
  const caller = await requireDesktopCaller(request, workerEnv.DB);
  if (!caller.ok) return caller.response;
  const organizationId = await lectureOrganization(request, caller.userId, workerEnv.DB);
  if (organizationId === undefined) return refuse(404, "course_not_found", "course not found");
  const input = {
    db: drizzle(workerEnv.DB),
    userId: caller.userId,
    organizationId,
    courseId: courseId.trim(),
    lectureId: lectureId.trim(),
    courseScope: organizationId ? "private" as const : "public" as const,
    local: true,
  };
  try {
    if (action === "complete") {
      const detail = await completePureCourseLectureForUser({ ...input, nowUnixMs: Date.now() });
      return lectureAnswer(detail.course.courseId, detail.lecture);
    }
    const result = await loadCourseLectureDetailForUser(input);
    if (!result.ok) {
      return jsonResponse({ protocol: DESKTOP_PROTOCOL, locked: true }, { headers: { "cache-control": "no-store" } });
    }
    return lectureAnswer(result.detail.course.courseId, result.detail.lecture);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    const { status, body } = toErrorResponse(error, "the lecture could not be loaded");
    return jsonResponse({ ...body, protocol: DESKTOP_PROTOCOL }, { status, headers: { "cache-control": "no-store" } });
  }
}

/**
 * What the website's learning panel shows beside a run (RunLearningPanel),
 * for all of its machines at once: the lecture's theory, the checks, the
 * hint ladders and the solution. The record already seals unrevealed hints
 * and an unrevealed solution; this keeps what it holds.
 */
export function localRunLearning(run: ScenarioRunRecord) {
  const checks = run.tasks
    ? run.tasks.map((task) => ({
        key: task.id,
        machine: task.machine,
        title: task.title,
        description: task.body,
        status: learnerCheckStatus(task.status),
        optional: task.optional,
      }))
    : run.vms.flatMap((vm) => {
        // A machine's checks are titled by its own objectives, else by all (scopeObjectivesToVm).
        const own = run.objectives.filter((objective) => objective.vmName === vm.scenarioVmName);
        const objectives = own.length ? own : run.objectives;
        return vm.scenarioProbes.map((probe, index) => {
          const at = objectives.findIndex((objective) => objective.probeName === probe.id);
          return {
            key: probe.id,
            machine: vm.scenarioVmName,
            title: repairObjectiveTitle(objectives[at], at >= 0 ? at : index),
            description: null,
            status: learnerCheckStatus(probe.status),
            optional: false,
          };
        });
      });
  return {
    runId: run.id,
    lectureTitle: run.lectureTitle ?? null,
    lectureMarkdown: run.lectureBodyMarkdown ?? run.briefingMarkdown,
    solved: run.phase === "solved" || run.solvedAt !== null,
    checks,
    hints: run.hints.map((hint) => ({
      key: hint.key,
      checkKey: hint.scope === "probe" ? hint.probeName : null,
      title: hint.title,
      revealed: hint.revealed,
      unlocked: hint.unlocked,
      bodyMarkdown: hint.bodyMarkdown,
    })),
    solution: {
      unlocked: run.solution.unlocked,
      revealed: run.solution.revealed,
      assisted: run.solution.assisted,
      bodyMarkdown: run.solution.bodyMarkdown,
    },
  };
}

/**
 * `GET /api/local/runs/<id>/learning`, `POST .../hints/reveal` and
 * `POST .../solution/reveal`: the learning panel of the learner's own local
 * run, and revealing in it what the website reveals.
 */
export async function localRunLearningRequest(
  request: Request,
  runId: string,
  action: "read" | "hint" | "solution",
  workerEnv: Cloudflare.Env = env,
): Promise<Response> {
  const caller = await requireDesktopCaller(request, workerEnv.DB);
  if (!caller.ok) return caller.response;
  let hintKey = "";
  if (action === "hint") {
    const body = (await request.json().catch(() => null)) as { protocol?: unknown; hintKey?: unknown } | null;
    if (body?.protocol !== DESKTOP_PROTOCOL) {
      return refuse(409, "upgrade_required", "this version of the app is too old to reveal a hint; update it");
    }
    hintKey = typeof body.hintKey === "string" ? body.hintKey.trim() : "";
    if (!hintKey) return refuse(400, "invalid_hint", "hintKey is required");
  }
  try {
    const userId = caller.userId;
    // Only the learner's local runs, as the run route reads them.
    let run = await getScenarioRunForUser({ runId, userId });
    if (!run.local) return refuse(404, "run_not_found", "run not found");
    if (action === "hint") run = await revealScenarioRunHintForUser({ runId, userId, hintKey });
    if (action === "solution") run = await revealScenarioRunSolutionForUser({ runId, userId });
    return jsonResponse({ protocol: DESKTOP_PROTOCOL, learning: localRunLearning(run) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    if (error.code === "scenario_run_not_found") return refuse(404, "run_not_found", "run not found");
    const { status, body } = toErrorResponse(error, "the run's learning could not be loaded");
    return jsonResponse({ ...body, protocol: DESKTOP_PROTOCOL }, { status, headers: { "cache-control": "no-store" } });
  }
}

/**
 * `GET /api/local/runs`: the learner's run history as the website lists it
 * (`/api/scenarios/runs`), local or not, newest first.
 */
export async function localRunHistoryRequest(
  request: Request,
  workerEnv: Cloudflare.Env = env,
): Promise<Response> {
  const caller = await requireDesktopCaller(request, workerEnv.DB);
  if (!caller.ok) return caller.response;
  const runs = await listScenarioRunsForUser({ userId: caller.userId });
  return jsonResponse({
    protocol: DESKTOP_PROTOCOL,
    runs: runs.map((run) => ({
      runId: run.runId,
      scenarioId: run.scenarioId,
      organizationId: run.organizationId ?? null,
      title: run.title,
      local: run.local,
      active: run.active,
      outcome: run.outcome,
      activity: run.activity,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
      solvedAt: run.solvedAt,
      solveDurationMs: run.solveDurationMs,
      solutionAssisted: run.solutionAssisted,
      hasReplay: run.hasReplay,
    })),
  }, { headers: { "cache-control": "no-store" } });
}

/**
 * What the website's recap (RunRecap) shows of a run, through the same
 * model, so probe values, errors, filenames and VM ids stay out as there.
 */
export function localRunRecap(record: ScenarioRunRecord) {
  // The run page presents the record before its recap reads it.
  const run = presentScenarioRun(record) as unknown as RunViewRecord;
  const state = getRunRecapState(run);
  const parts = getRunReplayParts(run);
  return {
    runId: run.id,
    scenarioId: run.scenarioId,
    title: run.title,
    kind: state.kind,
    heading: state.title,
    description: state.description,
    solveDurationMs: run.solveDurationMs,
    hintsRevealed: run.hints.filter((hint) => hint.revealed).length,
    solutionUsed: run.solution.assisted || run.solution.revealed,
    // The website's final checks; a task run's (every local run's) are its
    // tasks, in order, which add their own id, description and optionality.
    checks: getRunRecapObjectives(run).map((objective, index) => {
      const task = record.tasks?.[index];
      return {
        key: task?.id ?? objective.key,
        machine: task?.machine ?? run.objectives[index]!.vmName,
        title: objective.title,
        description: task?.body ?? null,
        status: objective.status,
        optional: task?.optional ?? false,
      };
    }),
    replay: getRunReplayAvailability(run, parts),
    replayParts: parts.map((part) => ({
      key: part.key,
      machineLabel: part.machineLabel,
      partLabel: part.partLabel,
      castArtifactId: part.castArtifactId,
      sizeBytes: part.sizeBytes ?? null,
    })),
  };
}

/** `GET /api/local/runs/<id>/recap`: any run of the learner's, read-only. */
export async function localRunRecapRequest(
  request: Request,
  runId: string,
  workerEnv: Cloudflare.Env = env,
): Promise<Response> {
  const caller = await requireDesktopCaller(request, workerEnv.DB);
  if (!caller.ok) return caller.response;
  try {
    const run = await getScenarioRunForUser({ runId, userId: caller.userId });
    return jsonResponse({ protocol: DESKTOP_PROTOCOL, recap: localRunRecap(run) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    if (error.code === "scenario_run_not_found") return refuse(404, "run_not_found", "run not found");
    const { status, body } = toErrorResponse(error, "the run's recap could not be loaded");
    return jsonResponse({ ...body, protocol: DESKTOP_PROTOCOL }, { status, headers: { "cache-control": "no-store" } });
  }
}

/**
 * `GET /api/local/runs/<id>/artifacts/<artifactId>`: an artifact of one of
 * the learner's runs, as the website serves it
 * (`/api/runs/<id>/artifacts/<artifactId>/content`).
 */
export async function localRunArtifactRequest(
  request: Request,
  rawRunId: string | undefined,
  rawArtifactId: string | undefined,
  workerEnv: Cloudflare.Env = env,
): Promise<Response> {
  const caller = await requireDesktopCaller(request, workerEnv.DB);
  if (!caller.ok) return caller.response;
  const ids = decodeScenarioRunArtifactRouteParams(rawRunId, rawArtifactId);
  if (!ids.ok) return ids.response;
  return serveScenarioRunArtifactContent({
    request,
    runId: ids.runId,
    artifactId: ids.artifactId,
    ownerUserId: caller.userId,
  });
}
