// The job of an automatic source's head commit (#454): it checks each lab of
// the commit on a platform host, up to "every lab passed". The source
// object's pass drives it, one step per pass; nothing here goes live.
//
// A lab is one scenario's revision of the commit. It has passed when the
// revision is verified, by inheritance or by a verify run the job started;
// it is skipped when it would not move (unchanged, on hold, disabled); it
// failed when its revision failed, its checks did not pass, or a wait ran
// out. The commit row is `building` while a revision waits for an image,
// `waiting` while a lab is undecided, and `failed` once every lab is decided
// and one failed.
//
// The job counts only what it started itself: the ids of its verify runs
// live in the source object's storage, with the row and attempt they belong
// to. A job of another row or attempt is closed first, and its runs ended.

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { scenarioSources } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { behaviourHeldSql } from "@/lib/kept-revisions";
import { sameAsLiveSql, type VerifyReport } from "@/lib/scenario-revisions";
import { scenarioSourceBindingPredicate } from "@/lib/scenario-sources";

export const DEPLOY_JOB_STORAGE_KEY = "deploy_job";
/** A job's verify run may take this long: three hour-long tries would hold a slot for three hours. */
export const DEPLOY_JOB_VERIFY_LEASE_MS = 10 * 60_000;
/** A lab that could not be decided this long after its job began has failed. */
export const DEPLOY_JOB_DEADLINE_MS = 24 * 3_600_000;
/** The next pass while a start was refused; settled builds and runs poke the source themselves. */
export const DEPLOY_JOB_WAIT_MS = 60_000;
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
}

export interface DeployJobDeps {
  /** Starts a verify run of a ready candidate with the job's lease; throws an `AppError` when refused. */
  beginVerifyRun(input: { scenarioId: string; rev: string; leaseMs: number }): Promise<{ runId: string }>;
  /** Ends a verify run the job started. */
  endVerifyRun(runId: string): Promise<void>;
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

interface LabRow {
  scenario_id: string;
  state: "building" | "ready" | "verified" | "failed";
  failure_reason: string | null;
  enabled: number;
  live: number;
  candidate: number;
  unchanged: number;
  held: number;
  running: number;
  verify_run_id: string | null;
  verify_report_json: string | null;
}

type Lab =
  | { kind: "passed" | "building" | "checking" }
  | { kind: "skipped" | "failed" | "waiting"; note: string };

/**
 * One step of the job of scope `scopeKey`'s head commit, whose rev is built
 * on compile digest `digest`. The caller has found the binding active.
 * `wait` asks for another pass in a minute: a start was refused.
 */
export async function driveDeployJob(input: {
  db: D1Database;
  storage: Storage;
  scopeKey: string;
  digest: string;
  now: number;
  deps: DeployJobDeps;
}): Promise<{ wait: boolean }> {
  const { db, storage, scopeKey, digest, now, deps } = input;
  const head = await readHead(db, scopeKey, digest);
  const stored = await storage.get<DeployJob>(DEPLOY_JOB_STORAGE_KEY);
  const driven = head?.automatic === 1 && head.id !== null && (head.state === "building" || head.state === "waiting");
  if (stored && (!driven || stored.rowId !== head.id || stored.attempt !== head.attempt)) {
    await closeJob(db, storage, stored, deps);
  }
  if (!head || !driven) {
    // A source switched back to manual shows its row as it did before.
    if (head && head.automatic !== 1 && head.id !== null && head.state === "waiting") {
      await db.prepare(
        `UPDATE scenario_source_commits SET state = 'building', detail = NULL, updated_at = ?3
          WHERE id = ?1 AND attempt = ?2 AND state = 'waiting'`,
      ).bind(head.id, head.attempt, now).run();
    }
    return { wait: false };
  }
  const job: DeployJob = stored && stored.rowId === head.id && stored.attempt === head.attempt
    ? stored
    : { rowId: head.id!, attempt: head.attempt!, since: now, labs: {}, decided: 0, total: 0 };
  const overdue = now - job.since >= DEPLOY_JOB_DEADLINE_MS;

  const { results: rows } = await db.prepare(
    `SELECT revision.scenario_id, revision.state, revision.failure_reason, scenario.enabled,
        scenario.live_rev IS revision.rev AS live, scenario.candidate_rev IS revision.rev AS candidate,
        ${sameAsLiveSql("revision", "scenario")} AS unchanged,
        ${behaviourHeldSql("revision.scenario_id", "revision.behaviour_digest")} AS held,
        EXISTS (SELECT 1 FROM scenario_runs run
          WHERE run.active_key = 'verify:' || ?2 || ':' || revision.rev || ':' || revision.scenario_id) AS running,
        revision.verify_run_id, revision.verify_report_json
      FROM scenario_revisions revision
      JOIN bundles bundle ON bundle.rev = revision.rev AND bundle.scope_key = ?2
      JOIN scenarios scenario ON scenario.id = revision.scenario_id
     WHERE revision.rev = ?1 ORDER BY revision.scenario_id`,
  ).bind(head.rev, scopeKey).all<LabRow>();

  const labs = new Map<string, Lab>();
  let wait = false;
  let scopeWait: string | null = null;
  for (const row of rows) {
    const decided = decide(row, overdue);
    if (decided) {
      labs.set(row.scenario_id, decided);
      continue;
    }
    // A ready candidate: it needs a verify run.
    if (row.running) {
      // A run on a host that went away is ended by nothing until the host
      // is back; the day's deadline is the lab's last word then.
      labs.set(row.scenario_id, overdue ? { kind: "failed", note: "its verify run did not finish" } : { kind: "checking" });
      continue;
    }
    const lab = (job.labs[row.scenario_id] ??= { runs: [] });
    const last = lab.runs.at(-1);
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

  const kinds = [...labs.values()].map((lab) => lab.kind);
  const undecided = kinds.filter((kind) => kind === "building" || kind === "checking" || kind === "waiting").length;
  const state = kinds.includes("building") ? "building" : undecided === 0 && kinds.includes("failed") ? "failed" : "waiting";
  // While the job goes on, what a lab waits for or why it stays; at the end,
  // which labs failed and why.
  const noted = [...labs].filter((entry): entry is [string, Extract<Lab, { note: string }>] => "note" in entry[1]);
  const detail = noted
    .filter(([, lab]) => state !== "failed" || lab.kind === "failed")
    .map(([scenarioId, lab]) => `- ${scenarioId}: ${lab.kind === "skipped" ? `not checked, ${lab.note}` : lab.note}`)
    .join("\n").slice(0, MAX_DETAIL_CHARS) || null;
  if (state !== head.state || detail !== head.detail) {
    await db.prepare(
      `UPDATE scenario_source_commits SET state = ?4, detail = ?5, updated_at = ?6
        WHERE id = ?1 AND attempt = ?2 AND state = ?3
          AND rev = (SELECT 'git-' || github_repository_id || '-' || head_sha || '-' || ?8
            FROM scenario_sources WHERE scope_key = ?7)`,
    ).bind(head.id, head.attempt, head.state, state, detail, now, scopeKey, digest).run();
  }
  if (state === "failed") {
    // Every lab is decided; a run the deadline overtook is ended.
    await closeJob(db, storage, job, deps);
    return { wait: false };
  }
  job.total = rows.length;
  job.decided = rows.length - undecided;
  await storage.put(DEPLOY_JOB_STORAGE_KEY, job);
  return { wait };
}

/** The lab's outcome where no verify run is needed to tell, else null. */
function decide(row: LabRow, overdue: boolean): Lab | null {
  if (row.state === "failed") return { kind: "failed", note: row.failure_reason ?? "its revision failed" };
  if (row.live) return { kind: "passed" };
  if (row.state === "building") {
    return overdue ? { kind: "failed", note: "its images did not arrive within 24 hours" } : { kind: "building" };
  }
  if (row.unchanged) return { kind: "skipped", note: "unchanged" };
  if (row.held) return { kind: "skipped", note: "held; an administrator must lift it" };
  if (!row.enabled) return { kind: "skipped", note: "the scenario is disabled" };
  // Only a candidate is verified and promoted. A head that is not its
  // labs' newest ingest, as after a force-push back to it, cannot pass.
  if (!row.candidate) return { kind: "failed", note: "a newer revision of this lab exists; publish the commit again" };
  if (row.state === "verified") return { kind: "passed" };
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
  automatic: number;
  id: string | null;
  attempt: number | null;
  state: string | null;
  rev: string | null;
  detail: string | null;
}

/** The scope's source and its head's deploy row, when it has one. */
async function readHead(db: D1Database, scopeKey: string, digest: string): Promise<Head | undefined> {
  return await drizzle(db).get<Head>(sql`
    SELECT ${scenarioSources.promotion} = 'automatic' AS automatic, head.id, head.attempt, head.state, head.rev, head.detail
      FROM ${scenarioSources}
      LEFT JOIN scenario_source_commits head ON head.scope_key = ${scenarioSources.scopeKey} AND head.purpose = 'deploy'
        AND head.rev = 'git-' || ${scenarioSources.githubRepositoryId} || '-' || ${scenarioSources.headSha} || '-' || ${digest}
     WHERE ${scenarioSources.scopeKey} = ${scopeKey}`);
}

/**
 * Whether the job may start a run now: the binding may still write, the
 * source is automatic, and the row is the head's and as the pass read it.
 */
async function mayStart(
  db: D1Database, scopeKey: string, digest: string, rowId: string, attempt: number, state: string,
): Promise<boolean> {
  const row = await drizzle(db).get<{ ok: number }>(sql`
    SELECT 1 AS ok FROM ${scenarioSources}
      JOIN scenario_source_commits head ON head.scope_key = ${scenarioSources.scopeKey} AND head.purpose = 'deploy'
        AND head.rev = 'git-' || ${scenarioSources.githubRepositoryId} || '-' || ${scenarioSources.headSha} || '-' || ${digest}
     WHERE ${scenarioSources.scopeKey} = ${scopeKey} AND ${scenarioSources.promotion} = 'automatic'
       AND ${scenarioSourceBindingPredicate()}
       AND head.id = ${rowId} AND head.attempt = ${attempt} AND head.state = ${state}`);
  return row?.ok === 1;
}

/** Ends the runs of a job that is over and are still going on, and forgets the job. */
async function closeJob(db: D1Database, storage: Storage, job: DeployJob, deps: DeployJobDeps): Promise<void> {
  const open = Object.values(job.labs).flatMap((lab) => lab.runs).filter((run) => !run.outcome).map((run) => run.id);
  if (open.length) {
    const { results } = await db.prepare(
      `SELECT run_id FROM scenario_runs WHERE launch_source = 'verify' AND active_key IS NOT NULL
        AND delete_requested_at IS NULL AND run_id IN (SELECT value FROM json_each(?1))`,
    ).bind(JSON.stringify(open)).all<{ run_id: string }>();
    for (const { run_id: runId } of results) await deps.endVerifyRun(runId);
  }
  await storage.delete(DEPLOY_JOB_STORAGE_KEY);
}
