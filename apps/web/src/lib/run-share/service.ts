import { env } from "cloudflare:workers";
import { sha256Hex } from "@/control-plane/auth";
import { SHARE_ID_LEN } from "@/generated/constants";
import { activeAccountSql } from "@/lib/account-access";
import { appError } from "@/lib/app-error";
import { encodeBase64Url } from "@/lib/base64url";
import type { FeatureToggleService } from "@/lib/feature-toggles";
import { featureToggleService } from "@/lib/organization-access";
import { parseObjectives, parseRunState } from "@/lib/scenario-runs/storage";
import {
  deleteStargateRunMirror,
  putStargateRunMirror,
} from "@/lib/stargate";
import { runShareUrl } from "./links";
import type { SharedRunMission } from "./protocol";

export const RUN_SHARING_FLAG = "run-sharing";
const SHARE_DO_ORIGIN = "https://run-share.internal";
const SHARE_ID = /^[A-Za-z0-9_-]+$/;

export function isShareId(value: string): boolean {
  return value.length === SHARE_ID_LEN && SHARE_ID.test(value);
}

/** Share logs live next to the run recordings, in `RUN_SHARE_JURISDICTION`
 * (the EU in production). The jurisdiction is part of every share's id. */
export function runShareStub(shareId: string): DurableObjectStub {
  const jurisdiction = (env as { RUN_SHARE_JURISDICTION?: string })
    .RUN_SHARE_JURISDICTION?.trim();
  const namespace = jurisdiction
    ? env.RUN_SHARE.jurisdiction(jurisdiction as DurableObjectJurisdiction)
    : env.RUN_SHARE;
  return namespace.get(namespace.idFromName(shareId));
}

// The run view is polled while a VM boots, so the flag is read at most once a
// minute per user and isolate.
// ponytail: per-isolate cache, cleared wholesale at 1,000 users.
const canShareCache = new Map<string, { value: boolean; expiresAt: number }>();

export async function canShareRuns(
  userId: string,
  toggles?: FeatureToggleService,
): Promise<boolean> {
  if (toggles) {
    return toggles.getBoolean(RUN_SHARING_FLAG, false, { targetingKey: userId });
  }
  const cached = canShareCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = await featureToggleService().getBoolean(
    RUN_SHARING_FLAG,
    false,
    { targetingKey: userId },
  );
  if (canShareCache.size >= 1_000) canShareCache.clear();
  canShareCache.set(userId, { value, expiresAt: Date.now() + 60_000 });
  return value;
}

interface ShareRunRow {
  run_id: string;
  share_id: string | null;
  active_key: string | null;
  title: string;
  tagline: string;
  scenario_name: string;
  lecture_title: string | null;
  lecture_body_markdown: string | null;
  briefing_markdown: string;
  objectives_json: string;
  state_json: string;
}

async function loadOwnedRun(runId: string, userId: string): Promise<ShareRunRow> {
  const row = await env.DB.prepare(
    `SELECT run_id, share_id, active_key, title, tagline, scenario_name,
            lecture_title, lecture_body_markdown, briefing_markdown,
            objectives_json, state_json
       FROM scenario_runs
      WHERE run_id = ?1 AND user_id = ?2 AND hidden_at IS NULL`,
  )
    .bind(runId, userId)
    .first<ShareRunRow>();
  if (!row) {
    throw appError(404, "scenario_run_not_found", "scenario run not found");
  }
  return row;
}

/** Only what the public page shows: never the owner, hints, the solution,
 * or the run state (which holds terminal targets). */
export function buildSharedRunMission(row: ShareRunRow): SharedRunMission {
  return {
    title: row.title,
    tagline: row.tagline,
    scenario_name: row.scenario_name,
    lecture_title: row.lecture_title,
    markdown: row.lecture_body_markdown ?? row.briefing_markdown,
    objectives: parseObjectives(row.objectives_json).map((objective) => ({
      vm_name: objective.vmName,
      label: objective.label,
      title: objective.title,
      body_markdown: objective.bodyMarkdown,
    })),
    vms: parseRunState(row.state_json).vms.map((vm) => ({
      id: vm.id,
      name: vm.scenarioVmName,
    })),
  };
}

function mintSecret(bytes: number): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return encodeBase64Url(value);
}

async function initShare(
  shareId: string,
  mission: SharedRunMission,
  writeToken: string,
): Promise<void> {
  const response = await runShareStub(shareId).fetch(`${SHARE_DO_ORIGIN}/init`, {
    method: "PUT",
    body: JSON.stringify({
      mission,
      write_token_hash: await sha256Hex(writeToken),
    }),
  });
  if (response.status !== 204) {
    throw new Error(`run share init failed (${response.status})`);
  }
}

/** Closes every viewer and deletes the log. Callers clear the run's share id
 * only after this succeeded, so a failed wipe can always be retried. */
async function wipeShare(shareId: string): Promise<void> {
  const response = await runShareStub(shareId).fetch(`${SHARE_DO_ORIGIN}/wipe`, {
    method: "POST",
  });
  if (response.status !== 204) {
    throw appError(
      503,
      "run_share_stop_failed",
      "sharing could not be stopped; try again",
    );
  }
}

function logShareCleanup(event: string, runId: string, error: unknown): void {
  console.warn(
    JSON.stringify({
      event,
      runId,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

/**
 * Starts sharing an active run and returns the public link. A run that is
 * already shared returns its link. The share id is claimed in D1 first, then
 * the share and Stargate's mirror are set up; a stop that lands meanwhile is
 * caught by the re-read at the end.
 */
export async function enableRunShare(params: {
  runId: string;
  userId: string;
  toggles?: FeatureToggleService;
}): Promise<string | null> {
  if (!(await canShareRuns(params.userId, params.toggles))) {
    throw appError(403, "run_sharing_unavailable", "sharing is not available");
  }
  const row = await loadOwnedRun(params.runId, params.userId);
  if (row.share_id) return runShareUrl(row.share_id);
  if (row.active_key === null) {
    throw appError(409, "run_share_inactive_run", "only an active run can be shared");
  }

  const shareId = mintSecret(16);
  const writeToken = mintSecret(32);
  const claimedAtMs = Date.now();
  const claim = await env.DB.prepare(
    `UPDATE scenario_runs SET share_id = ?1
      WHERE run_id = ?2 AND user_id = ?3 AND share_id IS NULL
        AND active_key IS NOT NULL AND hidden_at IS NULL`,
  )
    .bind(shareId, params.runId, params.userId)
    .run();
  if (claim.meta.changes !== 1) {
    const current = await loadOwnedRun(params.runId, params.userId);
    if (current.share_id) return runShareUrl(current.share_id);
    throw appError(409, "run_share_inactive_run", "only an active run can be shared");
  }

  try {
    await initShare(shareId, buildSharedRunMission(row), writeToken);
    await putStargateRunMirror(params.runId, {
      share_id: shareId,
      write_token: writeToken,
      claimed_at_ms: claimedAtMs,
    });
  } catch (error) {
    logShareCleanup("run_share_start_failed", params.runId, error);
    await wipeShare(shareId).catch((wipeError: unknown) =>
      logShareCleanup("run_share_rollback_wipe_failed", params.runId, wipeError),
    );
    await env.DB.prepare(
      `UPDATE scenario_runs SET share_id = NULL WHERE run_id = ?1 AND share_id = ?2`,
    )
      .bind(params.runId, shareId)
      .run();
    await deleteStargateRunMirror(params.runId, shareId).catch(
      (deleteError: unknown) =>
        logShareCleanup("run_share_rollback_mirror_failed", params.runId, deleteError),
    );
    throw appError(503, "run_share_start_failed", "sharing could not start; try again");
  }

  const current = await env.DB.prepare(
    `SELECT share_id FROM scenario_runs WHERE run_id = ?1`,
  )
    .bind(params.runId)
    .first<{ share_id: string | null }>();
  if (current?.share_id !== shareId) {
    // Sharing was stopped while this call set it up.
    await deleteStargateRunMirror(params.runId, shareId).catch((error: unknown) =>
      logShareCleanup("run_share_late_mirror_delete_failed", params.runId, error),
    );
    await wipeShare(shareId).catch((error: unknown) =>
      logShareCleanup("run_share_late_wipe_failed", params.runId, error),
    );
    return current?.share_id ? runShareUrl(current.share_id) : null;
  }
  return runShareUrl(shareId);
}

export async function disableRunShare(params: {
  runId: string;
  userId: string;
}): Promise<void> {
  const row = await loadOwnedRun(params.runId, params.userId);
  if (row.share_id) await stopRunShare(params.runId, row.share_id);
}

/**
 * Wipes the share before the run forgets it: a failed wipe throws and leaves
 * the share id in place for the retry. Stargate's mirror goes last and may
 * fail, because a wiped share refuses Stargate's writes and stops them.
 */
export async function stopRunShare(runId: string, shareId: string): Promise<void> {
  await wipeShare(shareId);
  await env.DB.prepare(
    `UPDATE scenario_runs SET share_id = NULL WHERE run_id = ?1 AND share_id = ?2`,
  )
    .bind(runId, shareId)
    .run();
  await deleteStargateRunMirror(runId, shareId).catch((error: unknown) =>
    logShareCleanup("run_share_mirror_delete_failed", runId, error),
  );
}

/** Stops every share of a user whose access is revoked or deleted. */
export async function stopRunSharesForUser(userId: string): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT run_id, share_id FROM scenario_runs
      WHERE user_id = ?1 AND share_id IS NOT NULL`,
  )
    .bind(userId)
    .all<{ run_id: string; share_id: string }>();
  for (const run of results) await stopRunShare(run.run_id, run.share_id);
}

/** A share is watchable while its run is visible and its owner's account is
 * active, so revoking an account closes its links at once. */
export async function isShareWatchable(shareId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS watchable
       FROM scenario_runs run
       JOIN user run_owner ON run_owner.id = run.user_id
      WHERE run.share_id = ?1
        AND run.hidden_at IS NULL
        AND ${activeAccountSql("run_owner")}
      LIMIT 1`,
  )
    .bind(shareId)
    .first();
  return row !== null;
}

/** Stargate's ingest socket. The share checks the bearer write token. */
export async function handleShareIngest(request: Request): Promise<Response> {
  if (
    request.method !== "GET" ||
    request.headers.get("upgrade")?.toLowerCase() !== "websocket"
  ) {
    return new Response("expected websocket upgrade", { status: 426 });
  }
  const shareId = new URL(request.url).searchParams.get("s") ?? "";
  const authorization = request.headers.get("authorization");
  // Only a share its run still points at may receive output: a stray mirror
  // left by a failed cleanup gets 404 and stops for good, and nothing else
  // reaches (or creates) a share object.
  if (!isShareId(shareId) || !authorization || !(await isShareWatchable(shareId))) {
    return new Response("share not found", { status: 404 });
  }
  return runShareStub(shareId).fetch(`${SHARE_DO_ORIGIN}/ingest`, {
    headers: { upgrade: "websocket", authorization },
  });
}

/** Opens a viewer socket after the share and its owner are checked.
 * `network` is the hashed caller network the share caps viewers by. */
export async function openShareViewer(
  shareId: string,
  after: string | null,
  network: string,
): Promise<Response> {
  const query = after && /^\d{1,15}$/.test(after) ? `?after=${after}` : "";
  return runShareStub(shareId).fetch(`${SHARE_DO_ORIGIN}/watch${query}`, {
    headers: { upgrade: "websocket", "x-share-viewer-network": network },
  });
}
