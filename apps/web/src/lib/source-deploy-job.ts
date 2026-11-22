// The job of a source's head commit (#454): it checks each lab of the commit
// on a platform host and puts each one that passed live. Every source has
// one (#494). The source object's pass drives it, one step per pass.
//
// A lab is one scenario's revision of the commit. It has passed when the
// revision is verified, by inheritance or by a verify run the job started;
// it is skipped when it would not move (unchanged); it failed when
// its revision failed, its checks did not pass, or a wait ran out. A lab
// that passed goes live by a move of its own, whatever the commit's other
// labs do. A pipeline's lab goes live only once the image of each of its
// machines is recorded for every architecture a pipeline is asked to build:
// a revision is complete on amd64 alone, and a learner's arm64 computer
// would find no image for a while after each change.
//
// Besides its labs a commit has one step of its own: its course catalog
// becomes the scope's, the scenarios it no longer has are disabled and
// those it has again are enabled. It is held while it would take content
// from a running lab.
//
// The commit row is `building` while a revision waits for an image,
// `waiting` while a lab is undecided, `awaiting_promote` while only the
// commit's step is held, and then `live`, or `failed` when a lab failed.
//
// A lab that is live boots cold until a restore check of its revision
// started from a host's snapshot and passed. For a lab of one machine the
// job runs such checks, also after its row has ended: a host takes its
// snapshot some time after an image's first boot, so a check that booted
// cold is "not yet". It tries for two hours and then says so; a snapshot
// that is slow or broken costs learners start-up time, never a publish.
//
// The checks are for the labs that serve the head's content: those the
// commit put live and those it left unchanged, whose live revision an
// earlier commit's job may not have got to. One check runs at a time, so a
// verify slot stays free; the lab that waited longest is next, and none is
// checked again within five minutes.
//
// The job counts only what it started itself: the ids of its verify runs
// live in the source object's storage, with the row and attempt they belong
// to. A job of another row or attempt is closed first, and its runs ended.

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { scenarioSources } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { pipelinePlan } from "@/lib/pipeline-revisions";
import {
  catalogForwardSql, namespacedCatalog, sameAsLiveSql, sourceHeadSql, type moveLiveRevision,
  type SourceHead, type VerifyReport,
} from "@/lib/scenario-revisions";
import { scenarioSourceBindingPredicate, unitGuardRunsSql } from "@/lib/scenario-sources";

export const DEPLOY_JOB_STORAGE_KEY = "deploy_job";
/** A job's verify run may take this long: three hour-long tries would hold a slot for three hours. */
export const DEPLOY_JOB_VERIFY_LEASE_MS = 10 * 60_000;
/** A lab that could not be decided this long after its job began has failed. */
export const DEPLOY_JOB_DEADLINE_MS = 24 * 3_600_000;
/** The next pass while a start was refused; settled builds and runs poke the source themselves. */
export const DEPLOY_JOB_WAIT_MS = 60_000;
/** Between two restore checks of a lab: a host needs time to take its snapshot. */
export const RESTORE_CHECK_EVERY_MS = 5 * 60_000;
/** How long the job tries to prove a lab's snapshot start. */
export const RESTORE_CHECK_FOR_MS = 2 * 3_600_000;
/** The next pass while a restore check goes on. */
const RESTORE_RUNNING_WAIT_MS = 2 * 60_000;
/** How a lab's line begins on the commit when the job has given the lab up. */
export const LAB_FAILED = "failed: ";
const RESTORE_GAVE_UP = ", starts cold: no snapshot start passed in two hours";
const RESTORE_NOT_TRIED = ", starts cold: its snapshot start could not be checked in two hours";
const MAX_FAILED_RUNS = 2;
const MAX_STARTS = 3;
const MAX_DETAIL_CHARS = 4096;

/**
 * What a run of the job came to. `unstarted` is a run that ended before its
 * lab reported anything, or without a word: a start, not a verdict.
 */
type RunOutcome = "failed" | "timeout" | "unstarted";

export interface DeployJob {
  rowId: string;
  attempt: number;
  /** When the job of this row and attempt began; the deadlines count from it. */
  since: number;
  /** Per scenario, the verify runs the job started, oldest first. */
  labs: Record<string, { runs: Array<{ id: string; outcome?: RunOutcome }> }>;
  decided: number;
  total: number;
  /**
   * Per scenario that serves the head's content: when the job began to
   * look at its snapshot start, the restore checks it started, and when a
   * start was last refused for the lab itself. `done` once its revision is
   * restore verified: the job does not check it again, so a withdrawal by
   * an administrator stands.
   */
  restore?: Record<string, {
    since: number; tries: Array<{ id: string; at: number }>; refusedAt?: number; gaveUp?: true; done?: true;
  }>;
  /** Set once the row has ended and only restore checks are left: the lines it ended with. */
  ended?: { detail: string | null };
}

export interface DeployJobDeps {
  /** Starts a verify run of a ready candidate with the job's lease; throws an `AppError` when refused. */
  beginVerifyRun(input: { scenarioId: string; rev: string; leaseMs: number; restoreCheck?: boolean }): Promise<{ runId: string }>;
  /** Ends a verify run the job started. */
  endVerifyRun(runId: string): Promise<void>;
  /** Puts a lab of the head commit live; throws an `AppError` when refused. */
  moveLive: typeof moveLiveRevision;
}

type Storage = Pick<DurableObjectStorage, "get" | "put" | "delete">;

/** Refusals that hold for every lab of the scope: the pass starts nothing more. */
const SCOPE_WAITS: Record<string, string> = {
  verify_quota_exhausted: "waiting for a free verify slot",
  scenario_host_unavailable: "waiting for a platform host",
  scenario_host_capacity_contended: "waiting for room on a platform host",
  runtime_cutover_drained: "waiting for a runtime update to finish",
  registry_busy: "waiting for the image registry",
};
/** Refusals of one lab. */
const LAB_WAITS: Record<string, string> = {
  scenario_image_preparing: "waiting for a platform host to fetch its images",
  image_not_ready: "waiting for its images",
  verify_run_active: "a verify run is going on",
  verify_revision_not_candidate: "waiting",
};

/** Refusals of a move that the next pass reads again. */
const MOVE_RETRIES = new Set(["live_revision_changed", "revision_unchanged", "revision_already_live",
  "revision_not_verified", "revision_not_candidate", "scenario_revision_not_found"]);
/** Refusals of a move that are the lab's end. */
const MOVE_FAILURES: Record<string, string> = {
  guest_contract_mismatch: "it was built for another guest contract; publish the commit again",
  revision_not_retained: "its revision is no longer kept",
  revision_images_gone: "its images are no longer stored",
};

interface LabRow {
  scenario_id: string;
  live_rev: string | null;
  state: "building" | "ready" | "verified" | "failed";
  failure_reason: string | null;
  enabled: number;
  live: number;
  candidate: number;
  unchanged: number;
  running: number;
  verify_run_id: string | null;
  verify_report_json: string | null;
  /** Who builds the revision's images, and the build keys of its machines, as a JSON array. */
  producer: string;
  build_keys: string;
  /** Of the head's revision: what becomes the live revision's when the lab moves. */
  restore_verified_at: number | null;
  machines: number;
  /** Of the scenario's live revision, the head's or an older one: what a restore check of it needs. */
  live_restore_verified_at: number | null;
  live_machines: number | null;
  live_running: number;
}

export type Lab =
  | { kind: "building" | "checking" | "unchanged" }
  /** Live: by this pass or before it. */
  | { kind: "live"; inherited: boolean }
  | { kind: "failed" | "waiting"; note: string };

/**
 * One step of the job of scope `scopeKey`'s head commit, whose rev is built
 * on compile digest `digest`. The caller has found the binding active.
 * `wait` asks for another pass in a minute: a start or a move was refused,
 * or the commit's own step is held. `wakeIn` asks for one after that many
 * milliseconds: a restore check goes on or is due then.
 */
export async function driveDeployJob(input: {
  db: D1Database;
  storage: Storage;
  scopeKey: string;
  digest: string;
  now: number;
  deps: DeployJobDeps;
}): Promise<{ wait: boolean; wakeIn?: number }> {
  const { db, storage, scopeKey, digest, now, deps } = input;
  const head = await readHead(db, scopeKey, digest);
  const stored = await storage.get<DeployJob>(DEPLOY_JOB_STORAGE_KEY);
  const acting = head !== undefined && head.id !== null && head.binder !== null;
  const driven = acting &&
    (head.state === "building" || head.state === "waiting" || head.state === "awaiting_promote");
  // The row has ended and the job stayed for its restore checks.
  const restoring = acting && (head.state === "live" || head.state === "failed") && stored?.ended !== undefined;
  if (stored && (!(driven || restoring) || stored.rowId !== head.id || stored.attempt !== head.attempt)) {
    await closeJob(db, storage, stored, deps);
  }
  if (head && restoring && stored && stored.rowId === head.id && stored.attempt === head.attempt) {
    const rows = await readLabs(db, head.rev!, scopeKey);
    const restore = await restoreChecks({ db, storage, job: stored, rows, head, scopeKey, digest, now, deps, blocked: false });
    const detail = withRestoreNotes(stored.ended!.detail, stored);
    if (detail !== head.detail) {
      await db.prepare(
        `UPDATE scenario_source_commits SET detail = ?4, updated_at = ?5 WHERE id = ?1 AND attempt = ?2 AND state = ?3`,
      ).bind(head.id, head.attempt, head.state, detail, Math.max(now, head.updated_at! + 1)).run();
    }
    if (restore.pending) await storage.put(DEPLOY_JOB_STORAGE_KEY, stored);
    else await closeJob(db, storage, stored, deps);
    return { wait: false, ...(restore.wakeIn === undefined ? {} : { wakeIn: restore.wakeIn }) };
  }
  if (!head || !driven) return { wait: false };
  const job: DeployJob = stored && stored.rowId === head.id && stored.attempt === head.attempt
    ? stored
    : { rowId: head.id!, attempt: head.attempt!, since: now, labs: {}, decided: 0, total: 0 };
  // Left by a pass that set it and then could not end the row.
  delete job.ended;
  const overdue = now - job.since >= DEPLOY_JOB_DEADLINE_MS;

  const rows = await readLabs(db, head.rev!, scopeKey);

  const source: SourceHead = { scopeKey, rowId: head.id!, attempt: head.attempt!, digest };
  if (!rows.length) {
    // Nothing to check, and nothing to tell removed labs from an empty
    // bundle by: the commit fails and disables nothing.
    await endRow(db, head, source, "failed", "the commit has no labs", now, false);
    await closeJob(db, storage, job, deps);
    return { wait: false };
  }
  // The commit's own step, once none of its revisions builds any more. It
  // comes before the labs: a lab the commit has again is enabled by it.
  let step: "done" | "held" | "building" = "building";
  let updatedAt = head.updated_at!;
  if (!rows.some((row) => row.state === "building")) {
    const at = Math.max(now, updatedAt + 1);
    step = await commitStep(db, { head, source, organizationId: head.organization_id, at });
    if (step === "done") updatedAt = at;
  }

  // The images a pipeline still owes, by build key: a lab of it does not
  // go live before each machine has every architecture's.
  const owed = new Map<string, string[]>();
  const pipelineKeys = rows.filter((row) => row.producer === "pipeline")
    .flatMap((row) => JSON.parse(row.build_keys) as string[]);
  if (pipelineKeys.length) {
    for (const { build_key: key, architecture } of (await pipelinePlan({ DB: db }, scopeKey, pipelineKeys)).missing) {
      owed.set(key, [...(owed.get(key) ?? []), architecture]);
    }
  }

  const labs = new Map<string, Lab>();
  let wait = step === "held";
  let scopeWait: string | null = null;
  for (const row of rows) {
    let decided = decide(row, overdue);
    if (decided === "move" && row.producer === "pipeline") {
      const missing = [...new Set((JSON.parse(row.build_keys) as string[]).flatMap((key) => owed.get(key) ?? []))].sort();
      // The image's own record pokes the source; nothing needs a wait here.
      if (missing.length) {
        decided = overdue
          ? { kind: "failed", note: `its ${missing.join(" and ")} images did not arrive within 24 hours` }
          : { kind: "waiting", note: `waiting for its ${missing.join(" and ")} images` };
      }
    }
    if (decided === "move") {
      decided = await move(row, head, source, deps);
      // A move that is refused day-long is the lab's end too.
      if (decided.kind === "waiting" && overdue) decided = { kind: "failed", note: "it could not go live within 24 hours" };
      if (decided.kind === "waiting") wait = true;
    }
    if (decided) {
      // A lab the commit's step has just enabled is read again at once.
      if (decided.kind === "waiting" && !row.enabled && step === "done") wait = true;
      labs.set(row.scenario_id, decided);
      continue;
    }
    // A ready candidate: it needs a verify run.
    const lab = (job.labs[row.scenario_id] ??= { runs: [] });
    const last = lab.runs.at(-1);
    // As soon as the revision names the job's run, before another run of
    // the revision can take its place there.
    if (last && !last.outcome && row.verify_run_id === last.id) {
      last.outcome = outcomeOf(last.id, row);
      // A run whose lease ended is recorded before its slot is free, and
      // nothing pokes when it is: look again in a minute.
      if (row.running) wait = true;
    }
    if (row.running) {
      // A run on a host that went away is ended by nothing until the host
      // is back; the day's deadline is the lab's last word then.
      labs.set(row.scenario_id, overdue ? { kind: "failed", note: "its verify run did not finish" } : { kind: "checking" });
      continue;
    }
    if (last && !last.outcome) last.outcome = outcomeOf(last.id, row);
    const failure = labFailure(lab.runs, overdue);
    if (failure) {
      labs.set(row.scenario_id, { kind: "failed", note: failure });
      continue;
    }
    if (scopeWait) {
      labs.set(row.scenario_id, { kind: "waiting", note: scopeWait });
      continue;
    }
    // The binding may have lost its rights, and the head may have moved,
    // since the pass read them.
    if (!(await mayStart(db, scopeKey, digest, head.id!, head.attempt!, head.state!))) return { wait: false };
    try {
      const { runId } = await deps.beginVerifyRun({
        scenarioId: row.scenario_id, rev: head.rev!, leaseMs: DEPLOY_JOB_VERIFY_LEASE_MS,
      });
      lab.runs.push({ id: runId });
      // At once: a pass that ends early must still know its runs.
      await storage.put(DEPLOY_JOB_STORAGE_KEY, job);
      labs.set(row.scenario_id, { kind: "checking" });
    } catch (error) {
      const code = error instanceof AppError ? error.code : "";
      wait = true;
      if (code in LAB_WAITS) {
        labs.set(row.scenario_id, { kind: "waiting", note: LAB_WAITS[code]! });
        continue;
      }
      if (!(code in SCOPE_WAITS)) {
        console.error(JSON.stringify({
          event: "deploy_job_start_failed", scope_key: scopeKey, scenario_id: row.scenario_id,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
      // Anything else is taken as the scope's too: one failing start is
      // enough for a pass.
      scopeWait = SCOPE_WAITS[code] ?? "waiting for the host check to start";
      labs.set(row.scenario_id, { kind: "waiting", note: scopeWait });
    }
  }

  // The labs that are live get their snapshot start checked, after the
  // verify runs: those decide whether a lab goes live at all.
  const restore = await restoreChecks({
    db, storage, job, rows, head, scopeKey, digest, now, deps, blocked: scopeWait !== null,
  });
  const kinds = [...labs.values()].map((lab) => lab.kind);
  const undecided = kinds.filter((kind) => kind === "building" || kind === "checking" || kind === "waiting").length;
  // The step still held at the deadline is the commit's failure; the labs
  // that went live stay live.
  const stepFailed = step === "held" && overdue;
  const state = kinds.includes("building") ? "building"
    : undecided > 0 ? "waiting"
    : step === "held" && !stepFailed ? "awaiting_promote"
    : kinds.includes("failed") || stepFailed ? "failed" : "live";
  const lines = detailOf(labs, step === "held"
    ? stepFailed
      ? "- the course catalog was not published: runs kept using what the commit removes"
      : "- the course catalog waits for an idle moment: a run still uses what the commit removes"
    : null);
  const detail = withRestoreNotes(lines, job);
  const wakeIn = restore.wakeIn === undefined ? {} : { wakeIn: restore.wakeIn };
  if (state === "live" || state === "failed") {
    // Every lab is decided. The job stays only for restore checks that are
    // left, and says so before the row ends: a fault after that must not
    // lose them. A verify run the deadline overtook is ended either way.
    if (restore.pending) {
      job.ended = { detail: lines };
      await storage.put(DEPLOY_JOB_STORAGE_KEY, job);
    }
    await endRow(db, { ...head, updated_at: updatedAt }, source, state, detail, now, true);
    if (!restore.pending) {
      await closeJob(db, storage, job, deps);
      return { wait: false };
    }
    await endRuns(db, Object.values(job.labs).flatMap((lab) => lab.runs).filter((run) => !run.outcome).map((run) => run.id), deps);
    return { wait: false, ...wakeIn };
  }
  if (state !== head.state || detail !== head.detail) {
    await db.prepare(
      `UPDATE scenario_source_commits SET state = ?4, detail = ?5, updated_at = ?6
        WHERE id = ?1 AND attempt = ?2 AND state = ?3
          AND rev = (SELECT 'git-' || github_repository_id || '-' || head_sha || '-' || ?8
            FROM scenario_sources WHERE scope_key = ?7)`,
    ).bind(head.id, head.attempt, head.state, state, detail, Math.max(now, updatedAt + 1), scopeKey, digest).run();
  }
  job.total = rows.length;
  job.decided = rows.length - undecided;
  await storage.put(DEPLOY_JOB_STORAGE_KEY, job);
  return { wait, ...wakeIn };
}

/**
 * The restore checks of the labs that serve the head's content: live with
 * the head's revision, or unchanged by it. A lab of one machine whose live
 * revision is not restore verified is checked until a check passed after a
 * snapshot start, or two hours are over. One check at a time, the lab that
 * waited longest first, and none again within five minutes of its last
 * check or refusal. `blocked` starts none in this pass: a start for the
 * scope was refused already. `pending` while a lab is not settled.
 */
async function restoreChecks(input: {
  db: D1Database; storage: Storage; job: DeployJob; rows: LabRow[]; head: Head; scopeKey: string; digest: string;
  now: number; deps: DeployJobDeps; blocked: boolean;
}): Promise<{ pending: boolean; wakeIn?: number }> {
  const { db, storage, job, rows, head, scopeKey, digest, now, deps } = input;
  let pending = false;
  let wakeIn: number | undefined;
  const wake = (ms: number) => {
    const at = Math.max(ms, 1000);
    pending = true;
    wakeIn = Math.min(wakeIn ?? at, at);
  };
  const restore = (job.restore ??= {});
  const lastAt = (lab: (typeof restore)[string]) => Math.max(lab.tries.at(-1)?.at ?? 0, lab.refusedAt ?? 0);
  const due: LabRow[] = [];
  let active = false;
  for (const row of rows) {
    // A snapshot is of one machine.
    if (!(row.live || row.unchanged) || row.live_rev === null || row.live_machines !== 1) continue;
    const lab = (restore[row.scenario_id] ??= { since: now, tries: [] });
    // Passed, or taken over from the revision it replaced.
    if (row.live_restore_verified_at !== null) lab.done = true;
    if (lab.done || lab.gaveUp) continue;
    if (row.live_running) {
      active = true;
      wake(RESTORE_RUNNING_WAIT_MS);
      continue;
    }
    if (now - lab.since >= RESTORE_CHECK_FOR_MS) {
      lab.gaveUp = true;
      continue;
    }
    const last = lastAt(lab);
    if (last && now - last < RESTORE_CHECK_EVERY_MS) wake(last + RESTORE_CHECK_EVERY_MS - now);
    else due.push(row);
  }
  if (!due.length) return { pending, ...(wakeIn === undefined ? {} : { wakeIn }) };
  // One at a time: the scope's other slot stays for verify runs, and a
  // host takes no snapshot while a run boots.
  wake(RESTORE_RUNNING_WAIT_MS);
  if (active || input.blocked) return { pending: true, wakeIn: wakeIn! };
  due.sort((a, b) => lastAt(restore[a.scenario_id]!) - lastAt(restore[b.scenario_id]!));
  const row = due[0]!;
  const lab = restore[row.scenario_id]!;
  if (!(await mayStart(db, scopeKey, digest, head.id!, head.attempt!, head.state!))) return { pending: true, wakeIn: wakeIn! };
  try {
    const { runId } = await deps.beginVerifyRun({
      scenarioId: row.scenario_id, rev: row.live_rev!, leaseMs: DEPLOY_JOB_VERIFY_LEASE_MS, restoreCheck: true,
    });
    lab.tries.push({ id: runId, at: now });
    await storage.put(DEPLOY_JOB_STORAGE_KEY, job);
  } catch (error) {
    const code = error instanceof AppError ? error.code : "";
    if (!(code in SCOPE_WAITS)) {
      // The lab's own refusal: it waits its five minutes, and the next lab
      // has its turn in a minute.
      if (!(code in LAB_WAITS) && code !== "restore_check_not_possible") {
        console.error(JSON.stringify({
          event: "deploy_job_restore_check_failed", scope_key: scopeKey, scenario_id: row.scenario_id,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
      lab.refusedAt = now;
      if (due.length > 1) wake(DEPLOY_JOB_WAIT_MS);
    }
  }
  return { pending: true, wakeIn: wakeIn! };
}

/** `detail` with a word on each live lab whose snapshot start the job gave up proving. */
function withRestoreNotes(detail: string | null, job: DeployJob): string | null {
  if (detail === null) return null;
  const gaveUp = Object.entries(job.restore ?? {}).filter(([, lab]) => lab.gaveUp);
  if (!gaveUp.length) return detail;
  return detail.split("\n").map((line) => {
    const lab = gaveUp.find(([scenarioId]) => line.startsWith(`- ${scenarioId}: live`))?.[1];
    return lab ? `${line}${lab.tries.length ? RESTORE_GAVE_UP : RESTORE_NOT_TRIED}` : line;
  }).join("\n");
}

/** The head commit's labs: each scenario's revision of `rev` in the scope, with what the job decides by. */
async function readLabs(db: D1Database, rev: string, scopeKey: string): Promise<LabRow[]> {
  const { results } = await db.prepare(
    `SELECT revision.scenario_id, scenario.live_rev, revision.state, revision.failure_reason, scenario.enabled,
        scenario.live_rev IS revision.rev AS live, scenario.candidate_rev IS revision.rev AS candidate,
        ${sameAsLiveSql("revision", "scenario")} AS unchanged,
        EXISTS (SELECT 1 FROM scenario_runs run
          WHERE run.active_key = 'verify:' || ?2 || ':' || revision.rev || ':' || revision.scenario_id) AS running,
        revision.verify_run_id, revision.verify_report_json, bundle.image_producer AS producer,
        (SELECT json_group_array(json_extract(machine.value, '$.build_key'))
           FROM json_each(revision.doc_json, '$.machines') machine) AS build_keys,
        revision.restore_verified_at,
        json_array_length(revision.doc_json, '$.machines') AS machines,
        live.restore_verified_at AS live_restore_verified_at,
        json_array_length(live.doc_json, '$.machines') AS live_machines,
        EXISTS (SELECT 1 FROM scenario_runs run
          WHERE run.active_key = 'verify:' || ?2 || ':' || scenario.live_rev || ':' || revision.scenario_id) AS live_running
      FROM scenario_revisions revision
      JOIN bundles bundle ON bundle.rev = revision.rev AND bundle.scope_key = ?2
      JOIN scenarios scenario ON scenario.id = revision.scenario_id
      LEFT JOIN scenario_revisions live ON live.scenario_id = scenario.id AND live.rev = scenario.live_rev
     WHERE revision.rev = ?1 ORDER BY revision.scenario_id`,
  ).bind(rev, scopeKey).all<LabRow>();
  return results;
}

/**
 * The check run's lines: one per lab that changed, the failed
 * first, the unchanged as a count; cut at a line when they are too many.
 */
export function detailOf(labs: Map<string, Lab>, stepLine: string | null): string | null {
  const rank = { failed: 0, waiting: 1, live: 2 } as const;
  const lines = [...labs]
    .filter((entry): entry is [string, Extract<Lab, { kind: keyof typeof rank }>] => entry[1].kind in rank)
    .sort(([, a], [, b]) => rank[a.kind] - rank[b.kind])
    .map(([scenarioId, lab]) => `- ${scenarioId}: ${lab.kind === "live"
      ? `live${lab.inherited ? ", verified without a run" : ""}`
      // Marked, so a reader can tell the job's last word from what it waits for.
      : lab.kind === "failed" ? `${LAB_FAILED}${lab.note}` : lab.note}`);
  const unchanged = [...labs.values()].filter((lab) => lab.kind === "unchanged").length;
  const tail = unchanged ? [`- ${unchanged} ${unchanged === 1 ? "lab" : "labs"} unchanged`] : [];
  const kept: string[] = stepLine ? [stepLine] : [];
  let length = kept.concat(tail).join("\n").length + 32;
  for (const [index, line] of lines.entries()) {
    // A line of a length of its own, as a build's failure can be, is cut.
    const fitted = line.length > 400 ? `${line.slice(0, 399)}…` : line;
    if (length + fitted.length + 1 > MAX_DETAIL_CHARS) {
      kept.push(`- and ${lines.length - index} more`);
      break;
    }
    kept.push(fitted);
    length += fitted.length + 1;
  }
  return kept.concat(tail).join("\n") || null;
}

/**
 * Ends the job's row as `live` or `failed`, and names the commit as the
 * last one whose job ended on its source, in one batch. A commit that had
 * nothing to check is named by nothing (`named` false).
 */
async function endRow(
  db: D1Database, head: Head, source: SourceHead, state: "live" | "failed", detail: string | null, now: number,
  named: boolean,
): Promise<void> {
  const at = Math.max(now, (head.updated_at ?? 0) + 1);
  await db.batch([
    db.prepare(
      `UPDATE scenario_source_commits SET state = ?4, detail = ?5, updated_at = ?6
        WHERE id = ?1 AND attempt = ?2 AND state = ?3
          AND ${sourceHeadSql("scenario_source_commits.scope_key", { binder: "?7", rev: "scenario_source_commits.rev", row: "?1", attempt: "?2", digest: "?8" })}`,
    ).bind(head.id, head.attempt, head.state, state, detail, at, head.binder, source.digest),
    db.prepare(
      `UPDATE scenario_sources SET live_rev = ?3, live_sha = head_sha, live_at = ?2, updated_at = ?2
        WHERE scope_key = ?1 AND ?6 = 1 AND EXISTS (SELECT 1 FROM scenario_source_commits ended
          WHERE ended.id = ?4 AND ended.state = ?5 AND ended.updated_at = ?2)`,
    ).bind(source.scopeKey, at, head.rev, head.id, state, named ? 1 : 0),
  ]);
}

/**
 * The commit's own step: its course catalog becomes the scope's when its
 * bundle is newer than the catalog's; and then, with the catalog this
 * commit's, the scope's scenarios the commit no longer has are disabled and
 * those it has again are enabled. One batch behind a marker on the commit
 * row, which holds only for the source's head and while no unfinished run
 * would lose its unit to the new catalog or is of a scenario to disable.
 * `done` when nothing of it is left, also when nothing was to do.
 */
async function commitStep(
  db: D1Database, input: { head: Head; source: SourceHead; organizationId: string | null; at: number },
): Promise<"done" | "held"> {
  const { head, source, organizationId, at } = input;
  const scope = source.scopeKey;
  const missing = `NOT EXISTS (SELECT 1 FROM scenario_revisions had WHERE had.scenario_id = scenarios.id AND had.rev = ?2)`;
  const todo = await db.prepare(
    `SELECT ${catalogForwardSql("?2", "?1")} AS forward,
        (SELECT source_revision FROM course_catalogs WHERE scope_key = ?1) IS ?2 AS ours,
        (SELECT COUNT(*) FROM scenarios WHERE scope_key = ?1 AND enabled = 1 AND ${missing}) AS removed,
        (SELECT COUNT(*) FROM scenarios WHERE scope_key = ?1 AND enabled = 0 AND NOT ${missing}) AS returned,
        (SELECT r2_key FROM bundles WHERE rev = ?2 AND scope_key = ?1) AS r2_key,
        (SELECT namespace FROM scenarios WHERE scope_key = ?1 AND NOT ${missing} LIMIT 1) AS namespace`,
  ).bind(scope, head.rev).first<{
    forward: number; ours: number; removed: number; returned: number; r2_key: string | null; namespace: string | null;
  }>();
  if (!todo) return "done";
  // Removals belong to the commit whose catalog is the scope's: a head that
  // an older bundle made, as after a force-push back, changes nothing.
  if (!todo.forward && (!todo.ours || (!todo.removed && !todo.returned))) return "done";
  let catalogJson: string | null = null;
  if (todo.forward && todo.namespace !== null) {
    try {
      catalogJson = JSON.stringify(await namespacedCatalog(todo.r2_key, todo.namespace));
    } catch (error) {
      // A bundle that is gone or unreadable holds the step; the deadline ends it.
      if (!(error instanceof AppError)) throw error;
      console.error(JSON.stringify({ event: "source_commit_catalog_unreadable", scope_key: scope, rev: head.rev, error: error.code }));
      return "held";
    }
  }
  const marked = `EXISTS (SELECT 1 FROM scenario_source_commits marked WHERE marked.id = ?3 AND marked.updated_at = ?4)`;
  const ours = `EXISTS (SELECT 1 FROM course_catalogs WHERE scope_key = ?1 AND source_revision = ?2)`;
  const [marker] = await db.batch([
    db.prepare(
      `UPDATE scenario_source_commits SET updated_at = ?4
        WHERE id = ?3 AND attempt = ?5 AND state = ?6
          AND ${sourceHeadSql("?1", { binder: "?7", rev: "?2", row: "?3", attempt: "?5", digest: "?8" })}
          AND (?10 IS NULL OR NOT EXISTS (SELECT 1 ${unitGuardRunsSql(9, 1, 10)}))
          AND NOT EXISTS (SELECT 1 FROM scenario_runs run JOIN scenarios ON scenarios.id = run.scenario_id
            WHERE scenarios.scope_key = ?1 AND scenarios.enabled = 1 AND ${missing}
              AND run.state NOT IN ('completed', 'failed'))
        RETURNING id`,
    ).bind(scope, head.rev, head.id, at, head.attempt, head.state, head.binder, source.digest, organizationId, catalogJson),
    db.prepare(
      `INSERT INTO course_catalogs (scope_key, organization_id, catalog_json, source_revision, created_at, updated_at)
        SELECT ?1, ?5, ?6, ?2, ?4, ?4 WHERE ?6 IS NOT NULL AND ${marked} AND ${catalogForwardSql("?2", "?1")}
        ON CONFLICT (scope_key) DO UPDATE SET catalog_json = excluded.catalog_json,
          source_revision = excluded.source_revision, updated_at = max(course_catalogs.updated_at + 1, excluded.updated_at)`,
    ).bind(scope, head.rev, head.id, at, organizationId, catalogJson),
    db.prepare(
      `UPDATE scenarios SET enabled = 0, updated_at = ?4
        WHERE scope_key = ?1 AND enabled = 1 AND ${missing} AND ${marked} AND ${ours}`,
    ).bind(scope, head.rev, head.id, at),
    db.prepare(
      `UPDATE scenarios SET enabled = 1, updated_at = ?4
        WHERE scope_key = ?1 AND enabled = 0 AND NOT ${missing} AND ${marked} AND ${ours}`,
    ).bind(scope, head.rev, head.id, at),
  ]);
  if (!marker?.results.length) return "held";
  console.info(JSON.stringify({ event: "source_commit_step", scope_key: scope, rev: head.rev,
    catalog: catalogJson !== null, removed: todo.removed, returned: todo.returned }));
  return "done";
}

/** Puts a lab that passed live, or says what its move waits for or failed on. */
async function move(row: LabRow, head: Head, source: SourceHead, deps: DeployJobDeps): Promise<Lab> {
  try {
    await deps.moveLive({
      scenarioId: row.scenario_id, rev: head.rev!, liveRev: row.live_rev, kind: "promote", actorUserId: head.binder!, source,
    });
    // The pass's later steps read the lab as it is now.
    // Its restore verification may have been taken over in the move; a
    // restore check that is not needed is refused, and the next pass knows.
    row.live = 1;
    row.live_rev = head.rev;
    row.live_restore_verified_at = row.restore_verified_at;
    row.live_machines = row.machines;
    row.live_running = 0;
    return { kind: "live", inherited: row.verify_run_id === null };
  } catch (error) {
    const code = error instanceof AppError ? error.code : "";
    if (code in MOVE_FAILURES) return { kind: "failed", note: MOVE_FAILURES[code]! };
    if (code === "registry_busy") return { kind: "waiting", note: "waiting for the image registry" };
    if (!MOVE_RETRIES.has(code)) {
      console.error(JSON.stringify({
        event: "deploy_job_move_failed", scope_key: source.scopeKey, scenario_id: row.scenario_id,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
    return { kind: "waiting", note: "waiting to go live" };
  }
}

/**
 * The lab's outcome where no verify run is needed to tell; `move` for one
 * that passed and is not live yet; null for one that needs a verify run.
 */
function decide(row: LabRow, overdue: boolean): Lab | "move" | null {
  if (row.state === "failed") return { kind: "failed", note: row.failure_reason ?? "its revision failed" };
  if (row.live) return { kind: "live", inherited: row.verify_run_id === null };
  if (row.state === "building") {
    return overdue ? { kind: "failed", note: "its images did not arrive within 24 hours" } : { kind: "building" };
  }
  if (row.unchanged) return { kind: "unchanged" };
  // Disabled with a revision of the head: the commit has the lab again,
  // and its step enables it.
  if (!row.enabled) {
    return overdue
      ? { kind: "failed", note: "the scenario could not be enabled within 24 hours" }
      : { kind: "waiting", note: "waiting for the commit to enable it" };
  }
  // Only a candidate is verified and promoted. A head that is not its
  // labs' newest ingest, as after a force-push back to it, cannot pass.
  if (!row.candidate) return { kind: "failed", note: "a newer revision of this lab exists; publish the commit again" };
  if (row.state === "verified") return "move";
  return null;
}

/** What an ended run of the job came to, from the revision's record of it. */
function outcomeOf(runId: string, row: LabRow): RunOutcome {
  if (row.verify_run_id !== runId || row.verify_report_json === null) return "unstarted";
  const report = JSON.parse(row.verify_report_json) as VerifyReport;
  if (report.outcome === "failed") return "failed";
  // With a lease counted from admission, a host that was still fetching
  // images ends a run through no fault of the lab: only a lab that
  // reported, and then did not finish, is the lab's own timeout.
  return report.machines.some((machine) => machine.verify !== null) ? "timeout" : "unstarted";
}

/** Why the lab failed after these runs, or null while another may start. */
function labFailure(runs: Array<{ outcome?: RunOutcome }>, overdue: boolean): string | null {
  if (runs.some((run) => run.outcome === "timeout")) return "its verify run did not finish";
  if (runs.filter((run) => run.outcome === "failed").length >= MAX_FAILED_RUNS) {
    return `its checks did not pass in ${MAX_FAILED_RUNS} verify runs`;
  }
  if (runs.length >= MAX_STARTS) return "its verify run did not finish";
  if (overdue) return "the host check could not start within 24 hours";
  return null;
}

interface Head {
  /** The source's binder, whose rights the job's writes are checked by. */
  binder: string | null;
  organization_id: string | null;
  id: string | null;
  attempt: number | null;
  state: string | null;
  rev: string | null;
  detail: string | null;
  updated_at: number | null;
}

/** The scope's source and its head's deploy row, when it has one. */
async function readHead(db: D1Database, scopeKey: string, digest: string): Promise<Head | undefined> {
  return await drizzle(db).get<Head>(sql`
    SELECT ${scenarioSources.boundByUserId} AS binder,
        ${scenarioSources.organizationId} AS organization_id,
        head.id, head.attempt, head.state, head.rev, head.detail, head.updated_at
      FROM ${scenarioSources}
      LEFT JOIN scenario_source_commits head ON head.scope_key = ${scenarioSources.scopeKey} AND head.purpose = 'deploy'
        AND head.rev = 'git-' || ${scenarioSources.githubRepositoryId} || '-' || ${scenarioSources.headSha} || '-' || ${digest}
     WHERE ${scenarioSources.scopeKey} = ${scopeKey}`);
}

/**
 * Whether the job may start a run now: the binding may still write, and the
 * row is the head's and as the pass read it.
 */
async function mayStart(
  db: D1Database, scopeKey: string, digest: string, rowId: string, attempt: number, state: string,
): Promise<boolean> {
  const row = await drizzle(db).get<{ ok: number }>(sql`
    SELECT 1 AS ok FROM ${scenarioSources}
      JOIN scenario_source_commits head ON head.scope_key = ${scenarioSources.scopeKey} AND head.purpose = 'deploy'
        AND head.rev = 'git-' || ${scenarioSources.githubRepositoryId} || '-' || ${scenarioSources.headSha} || '-' || ${digest}
     WHERE ${scenarioSources.scopeKey} = ${scopeKey}
       AND ${scenarioSourceBindingPredicate()}
       AND head.id = ${rowId} AND head.attempt = ${attempt} AND head.state = ${state}`);
  return row?.ok === 1;
}

/** Ends the runs of a job that is over and are still going on, its restore checks too, and forgets the job. */
async function closeJob(db: D1Database, storage: Storage, job: DeployJob, deps: DeployJobDeps): Promise<void> {
  await endRuns(db, [
    ...Object.values(job.labs).flatMap((lab) => lab.runs).filter((run) => !run.outcome).map((run) => run.id),
    ...Object.values(job.restore ?? {}).flatMap((lab) => lab.tries).map((run) => run.id),
  ], deps);
  await storage.delete(DEPLOY_JOB_STORAGE_KEY);
}

/** Ends those of the job's runs `ids` that still go on. */
async function endRuns(db: D1Database, ids: string[], deps: DeployJobDeps): Promise<void> {
  if (!ids.length) return;
  const { results } = await db.prepare(
    `SELECT run_id FROM scenario_runs WHERE launch_source = 'verify' AND active_key IS NOT NULL
      AND delete_requested_at IS NULL AND run_id IN (SELECT value FROM json_each(?1))`,
  ).bind(JSON.stringify(ids)).all<{ run_id: string }>();
  for (const { run_id: runId } of results) await deps.endVerifyRun(runId);
}
