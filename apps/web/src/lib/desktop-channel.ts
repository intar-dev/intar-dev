// The desktop app's channel to intar (#399), first slice: who the caller is,
// and starting, reading and ending a local run.
//
// The app signs in through the OAuth provider as a public client and sends
// its opaque access token as a bearer credential. The provider has no helper
// that verifies such a token for a client without a secret, so the check is
// one read here, on the hash the provider stores.

import { env } from "cloudflare:workers";
import { activeAccountSql, usableIdentityExistsSql } from "@/lib/account-access";
import { jsonResponse } from "@/lib/agent-bridge";
import { AppError, toErrorResponse } from "@/lib/app-error";
import { hashStoredOAuthToken } from "@/lib/auth";
import { requireIdempotencyKey } from "@/lib/idempotency-key";
import { endLocalRun } from "@/lib/local-runs";
import { resolveOrganizationId } from "@/lib/organizations";
import { enforceRateLimit } from "@/lib/request-security";
import { isRevisionScenarioId } from "@/lib/scenario-id";
import { beginScenarioRun } from "@/lib/scenario-runs/begin";
import { liveScenarioRevision } from "@/lib/scenario-runs/revision-begin";

/** The one OAuth client the routes accept. */
// ponytail: a fixed id; the client row itself is created outside this file (see PR 410's plan).
export const DESKTOP_OAUTH_CLIENT_ID = "intar-jumper";
export const LOCAL_RUNS_SCOPE = "local-runs";
/** Version of this channel's requests and answers. */
export const DESKTOP_PROTOCOL = 1;
/** The only architecture machine images exist for today. */
const IMAGE_ARCHITECTURE = "x86_64";

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
 * in now. A cookie is never read here.
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
        AND EXISTS (SELECT 1 FROM json_each(token.scopes) scope WHERE scope.value = ?4)
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
        (SELECT json_group_array(json_object('vmId', vm.vm_id, 'ordinal', vm.ordinal, 'image', vm.image_digest,
            'spec', vm.spec_digest, 'kino', vm.kino_digest, 'cpuMillis', vm.cpu_millis,
            'memoryMib', vm.memory_mib, 'diskMib', vm.disk_mib))
           FROM runtime_vms vm WHERE vm.execution_id = run.runtime_execution_id) AS vms
       FROM scenario_runs run
       LEFT JOIN scenario_revisions revision
         ON revision.scenario_id = run.scenario_id AND revision.rev = run.scenario_rev
      WHERE run.run_id = ?1 AND run.user_id = ?2 AND run.runtime = 'local'`,
  ).bind(runId, userId).first<{
    scenario_id: string; state: string; active: number; state_json: string; doc_json: string | null; vms: string;
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
    vmId: string; ordinal: number; image: string; spec: string; kino: string;
    cpuMillis: number; memoryMib: number; diskMib: number;
  }>).sort((a, b) => a.ordinal - b.ordinal);
  const allNames = vms.map((vm) => names.get(vm.vmId) ?? vm.vmId);
  return {
    runId,
    scenarioId: row.scenario_id,
    state: row.state,
    active: row.active === 1,
    machines: vms.map((vm, index) => {
      const name = allNames[index]!;
      return {
        name,
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
  if (arch !== IMAGE_ARCHITECTURE) {
    return refuse(409, "architecture_unavailable", "no machine images exist for this computer's architecture yet");
  }
  const organizationId = typeof organizationKey === "string" && organizationKey.trim()
    ? await resolveOrganizationId(organizationKey.trim())
    : null;
  if (typeof organizationKey === "string" && organizationKey.trim() && !organizationId) {
    return refuse(404, "scenario_not_found", "scenario not found");
  }
  // Refuse what the app cannot boot before a run exists. The admission
  // anchors the same live revision again at its commit.
  const revision = await liveScenarioRevision(workerEnv.DB, scenarioId, organizationId);
  if (!revision) return refuse(404, "scenario_not_found", "scenario not found");
  if (!guestContracts.includes(revision.guestContract)) {
    return refuse(409, "upgrade_required", "this scenario needs a newer version of the app; update it");
  }

  try {
    const started = await beginScenarioRun({
      scenarioId,
      userId: caller.userId,
      idempotencyKey,
      organizationId,
      runtime: "local",
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
