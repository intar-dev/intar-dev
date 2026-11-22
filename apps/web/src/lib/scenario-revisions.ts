// The pointer model of scenario revisions. Each scenario has a candidate
// (`candidate_rev`, its newest ready or verified revision, which its
// source's job checks) and a live revision (`live_rev`, which learners start). Only a
// verified revision of the current guest contract goes live, by the scope's
// source's job promoting the candidate. There is no rollback (#494): the
// remedy for a bad lab is a revert in the repository, whose commit finds the
// verified twin among the revisions that were live and goes live without a
// new check.
// Every change is a compare-and-set on the scenario row that rechecks the
// actor's rights, so a racing admin or ingest cannot make an unverified or
// stale revision live. A run keeps the revision it started from.
//
// A candidate with the live revision's content does not move. The course
// catalog is the source's job's, once per commit.

import { env } from "cloudflare:workers";
import { normalizeCourseCatalogSnapshot } from "@/control-plane/image-registry/bundle";
import type { CourseCatalogSnapshotV2 } from "@/db/schema/shared";
import { GUEST_CONTRACT } from "@/generated/constants";
import type { BuildTargetV1, VmVerifyV1 } from "@/generated/contracts/bridge-message-v9";
import { activeAccountSql, activeAdminSql } from "@/lib/account-access";
import { appError } from "@/lib/app-error";
import { tryWakeHostRuntime, wakePlatformAgents } from "@/lib/host-runtime-wake";
import { admitInternalRegistryOperation } from "@/lib/image-registry-admission";
import { KEPT_REVISIONS_CTE, revisionImagesPresentSql } from "@/lib/kept-revisions";
import { logKeyAttempt, machineBuildLogKey } from "@/lib/machine-builds";
import { platformHasRevisionImagesSql, readyPlatformImagesCtes } from "@/lib/scenario-runs/image-readiness";
import { verifyOutcome, type VerifyOutcome } from "@/lib/run-tasks";
import type { RunStateDocument } from "@/lib/run-state";
import { readSourceBundle, sourceCompileDigest } from "@/lib/scenario-contract/source-bundle";
import { pokeSource } from "@/lib/source-pokes";
import { VALIDATION_USER_ID } from "@/lib/scenario-runs/content-access";
import { destroyScenarioRunForUserWithDependencies } from "@/lib/scenario-runs/lifecycle";
import { markRunVmsAbsentInDesiredState, revokeScenarioRunRoutes } from "@/lib/scenario-runs/start";
import { redactHostPaths } from "@/lib/scenario-sources";

/**
 * Holds while the account bound at ?{actor} administers the scope of the
 * scenarios row aliased `scenario`: an active platform admin for the public
 * scope, an active owner or admin of the organization for its own.
 */
function scopeAdminSql(actor: number): string {
  return `((scenario.organization_id IS NULL AND EXISTS (SELECT 1 FROM user actor
      WHERE actor.id = ?${actor} AND ${activeAdminSql("actor")}))
    OR EXISTS (SELECT 1 FROM member actor_member JOIN user actor ON actor.id = actor_member.user_id
      WHERE actor_member.organization_id = scenario.organization_id AND actor_member.user_id = ?${actor}
        AND actor_member.role IN ('owner', 'admin') AND ${activeAccountSql("actor")}))`;
}

/** What ?{actor} may read: a platform admin every scenario, others their scope's. */
function readerSql(actor: number): string {
  return `(EXISTS (SELECT 1 FROM user reader WHERE reader.id = ?${actor} AND ${activeAdminSql("reader")})
    OR ${scopeAdminSql(actor)})`;
}

export interface ScenarioRevisionSummary {
  rev: string;
  state: "building" | "ready" | "verified" | "failed";
  guestContract: number;
  contentDigest: string | null;
  failureReason: string | null;
  verifyRunId: string | null;
  /** The last verify run's outcome, per machine verify steps and lab failure text; admin-only. */
  verifyReport: VerifyReport | null;
  /** When the revision was last made live. */
  liveAt: number | null;
  createdAt: number;
  /** Whether a live platform host reports every image of the revision ready, as a verify run needs. */
  imagesReady: boolean;
  /** When the revision's checks passed in a lab started from a host snapshot; only then may its runs start that way. */
  restoreVerifiedAt: number | null;
  /** The last restore check's outcome; admin-only. */
  restoreVerifyReport: RestoreVerifyReport | null;
  /** Whether this is another revision with the live one's content and guest contract: promoting it moves nothing. */
  sameAsLive: boolean;
}

/** A restore check: a verify run whose VM was allowed to start from a host snapshot. */
export interface RestoreVerifyReport extends VerifyReport {
  /** Whether every VM really started from a snapshot. A lab that started cold proves nothing about a restore. */
  restored: boolean;
  /** The Kino the lab ran. */
  kino: string | null;
}

export interface VerifyReport {
  runId: string;
  outcome: VerifyOutcome;
  at: number;
  machines: Array<{ name: string; verify: VmVerifyV1 | null; failure: string | null }>;
}

export interface AdministeredScenario {
  id: string;
  namespace: string;
  slug: string;
  organizationId: string | null;
  title: string | null;
  enabled: boolean;
  liveRev: string | null;
  candidateRev: string | null;
  /** The active verify run of each revision, by rev. */
  verifyRuns: Record<string, string>;
  revisions: ScenarioRevisionSummary[];
  /**
   * Set while the scenario's candidate or live revision is of the head
   * commit of its scope's source: what that source's job says of this lab.
   * Null for a scope without a connected source.
   */
  sourceJob: {
    /** The rev the job's commit is of. */
    rev: string;
    /**
     * Whether the job is working on the commit now: the source may act and
     * its row is one the job takes up. When false, a lab that is not live
     * waits for the source to be resumed, or for the commit to be run again.
     */
    driving: boolean;
    /** The job's line for this lab on the commit, when it has one. */
    note: string | null;
    /**
     * The job has given this lab up on this commit, whatever it still does
     * for the commit's other labs: only a re-run of the commit, or a new
     * one, takes it further.
     */
    failed: boolean;
  } | null;
}

/** The scenarios `actorUserId` may read, or one of them, with their revisions newest first. */
export async function listAdministeredScenarios(actorUserId: string, scenarioId?: string): Promise<AdministeredScenario[]> {
  const digest = await sourceCompileDigest();
  const [scenarios, revisions, runs, jobs] = await env.DB.batch([
    env.DB.prepare(
      `SELECT scenario.id, scenario.namespace, scenario.slug, scenario.organization_id, scenario.enabled,
          scenario.live_rev, scenario.candidate_rev,
          (SELECT json_extract(titled.doc_json, '$.title') FROM scenario_revisions titled
            WHERE titled.scenario_id = scenario.id ORDER BY titled.rev = scenario.live_rev DESC,
              titled.created_at DESC LIMIT 1) AS title
        FROM scenarios scenario WHERE ${readerSql(1)} AND (?2 IS NULL OR scenario.id = ?2) ORDER BY scenario.id`,
    ).bind(actorUserId, scenarioId ?? null),
    env.DB.prepare(
      `WITH ${readyPlatformImagesCtes()}
      SELECT revision.scenario_id, revision.rev, revision.state, revision.guest_contract, revision.content_digest,
          revision.failure_reason, revision.verify_run_id, revision.verify_report_json, revision.live_at,
          revision.restore_verified_at, revision.restore_verify_report_json, revision.created_at,
          ${sameAsLiveSql("revision", "scenario")} AS same_as_live,
          ${platformHasRevisionImagesSql("revision.doc_json")} AS images_ready
        FROM scenario_revisions revision JOIN scenarios scenario ON scenario.id = revision.scenario_id
        WHERE ${readerSql(1)} AND (?2 IS NULL OR scenario.id = ?2)
        ORDER BY revision.created_at DESC, revision.rev DESC`,
    ).bind(actorUserId, scenarioId ?? null),
    env.DB.prepare(
      `SELECT run.run_id, run.scenario_id, run.scenario_rev FROM scenario_runs run
        JOIN scenarios scenario ON scenario.id = run.scenario_id
        WHERE run.launch_source = 'verify' AND run.active_key IS NOT NULL AND ${readerSql(1)}
          AND (?2 IS NULL OR scenario.id = ?2)`,
    ).bind(actorUserId, scenarioId ?? null),
    // The head commit of the scope's source, where a revision of it is this
    // scenario's candidate or live one. The job drives it while the source
    // may act for that row (`sourceHeadSql`).
    env.DB.prepare(
      `SELECT scenario.id AS scenario_id, job_head.rev, job_head.detail,
          (${sourceHeadSql("scenario.scope_key", {
            binder: "job_source.bound_by_user_id", rev: "job_head.rev", row: "job_head.id", attempt: "job_head.attempt",
            digest: "?3",
          })}) AS driving
        FROM scenarios scenario
        JOIN scenario_sources job_source ON job_source.scope_key = scenario.scope_key
          AND job_source.disconnected_at IS NULL
        JOIN scenario_source_commits job_head ON job_head.scope_key = job_source.scope_key AND job_head.purpose = 'deploy'
          AND job_head.rev = 'git-' || job_source.github_repository_id || '-' || job_source.head_sha || '-' || ?3
        WHERE ${readerSql(1)} AND (?2 IS NULL OR scenario.id = ?2)
          AND job_head.rev IN (scenario.candidate_rev, scenario.live_rev)`,
    ).bind(actorUserId, scenarioId ?? null, digest),
  ]);
  type ScenarioRow = {
    id: string; namespace: string; slug: string; organization_id: string | null; enabled: number;
    live_rev: string | null; candidate_rev: string | null; title: string | null;
  };
  type RevisionRow = {
    scenario_id: string; rev: string; state: ScenarioRevisionSummary["state"]; guest_contract: number;
    content_digest: string | null; failure_reason: string | null; verify_run_id: string | null;
    verify_report_json: string | null; live_at: number | null; created_at: number;
    images_ready: number; restore_verified_at: number | null; restore_verify_report_json: string | null;
    same_as_live: number;
  };
  const byScenario = new Map<string, AdministeredScenario>();
  for (const row of scenarios!.results as ScenarioRow[]) {
    byScenario.set(row.id, {
      id: row.id, namespace: row.namespace, slug: row.slug, organizationId: row.organization_id, title: row.title,
      enabled: row.enabled === 1, liveRev: row.live_rev, candidateRev: row.candidate_rev,
      verifyRuns: {}, revisions: [], sourceJob: null,
    });
  }
  for (const row of jobs!.results as Array<{ scenario_id: string; rev: string; detail: string | null; driving: number }>) {
    const scenario = byScenario.get(row.scenario_id);
    if (!scenario) continue;
    // The job writes one line per lab that changed: `- <scenario>: <what>`.
    const prefix = `- ${row.scenario_id}: `;
    const line = row.detail?.split("\n").find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
    // `failed: `, as the job marks a lab it has given up (`LAB_FAILED` in source-deploy-job.ts).
    const failed = line?.startsWith("failed: ") === true;
    scenario.sourceJob = {
      rev: row.rev, driving: row.driving === 1, failed,
      note: line ? redactHostPaths(failed ? line.slice("failed: ".length) : line) : null,
    };
  }
  for (const row of revisions!.results as RevisionRow[]) {
    byScenario.get(row.scenario_id)?.revisions.push({
      rev: row.rev, state: row.state, guestContract: row.guest_contract, contentDigest: row.content_digest,
      failureReason: row.failure_reason, verifyRunId: row.verify_run_id,
      verifyReport: row.verify_report_json ? (JSON.parse(row.verify_report_json) as VerifyReport) : null,
      liveAt: row.live_at, createdAt: row.created_at,
      imagesReady: row.images_ready === 1,
      restoreVerifiedAt: row.restore_verified_at,
      restoreVerifyReport: row.restore_verify_report_json
        ? (JSON.parse(row.restore_verify_report_json) as RestoreVerifyReport) : null,
      sameAsLive: row.same_as_live === 1,
    });
  }
  for (const row of runs!.results as Array<{ run_id: string; scenario_id: string; scenario_rev: string }>) {
    const scenario = byScenario.get(row.scenario_id);
    if (scenario) scenario.verifyRuns[row.scenario_rev] = row.run_id;
  }
  return [...byScenario.values()];
}

/**
 * Moves `live_rev` from `liveRev` to `rev`, a promotion of the candidate. It
 * needs a verified revision of the current guest contract, and does not touch
 * the course catalog, which the source's job applies once per commit. The
 * operator drain does not hold it. Platform hosts then cache the new live
 * images.
 *
 * A candidate with the live revision's content and guest contract does not
 * move. Every move writes the revision's `live_at`, and takes over the
 * replaced revision's restore verification when a snapshot start of both
 * depends on the same things.
 *
 * With `source` the move is the source's job's (#454): a promotion
 * of one lab of its head commit, with no catalog, which the job applies
 * once for the commit. `actorUserId` is then the source's binder, whose
 * rights are the binding's, and the source and its commit row are checked
 * again in the move's own statement.
 */
export async function moveLiveRevision(input: {
  scenarioId: string;
  rev: string;
  /** The live revision the actor saw; the move fails when it changed. */
  liveRev: string | null;
  kind: "promote";
  actorUserId: string;
  source?: SourceHead;
}): Promise<{ liveRev: string }> {
  const { scenarioId, rev, liveRev, kind, actorUserId, source } = input;
  const row = await env.DB.prepare(
    `WITH ${KEPT_REVISIONS_CTE}
    SELECT scenario.live_rev, scenario.candidate_rev,
        revision.state, revision.guest_contract,
        (${scopeAdminSql(3)}${source ? ` AND ${sourceHeadSql("scenario.scope_key", { binder: "?3", rev: "?2", row: "?4", attempt: "?5", digest: "?6" })}` : ""}) AS manage,
        ${sameAsLiveSql("revision", "scenario")} AS same_as_live,
        EXISTS (SELECT 1 FROM kept_revisions kept WHERE kept.scenario_id = ?1 AND kept.rev = ?2) AS kept,
        ${revisionImagesPresentSql("?1", "?2")} AS images_present
      FROM scenarios scenario
      JOIN scenario_revisions revision ON revision.scenario_id = scenario.id AND revision.rev = ?2
      WHERE scenario.id = ?1`,
  ).bind(scenarioId, rev, actorUserId, ...(source ? [source.rowId, source.attempt, source.digest] : [])).first<{
    live_rev: string | null; candidate_rev: string | null;
    state: string; guest_contract: number; manage: number;
    kept: number; images_present: number; same_as_live: number;
  }>();
  if (!row?.manage) throw appError(404, "scenario_revision_not_found", "scenario revision not found");
  if (row.live_rev === rev) throw appError(409, "revision_already_live", "this revision is already live");
  if (row.live_rev !== liveRev) throw appError(409, "live_revision_changed", "the live revision changed; reload and try again");
  if (row.candidate_rev !== rev) {
    throw appError(409, "revision_not_candidate", "only the scenario's candidate revision can be promoted");
  }
  // An unchanged lab does not move, and the catalog is not this path's.
  if (row.same_as_live) throw appError(409, "revision_unchanged", "this revision is the same as the live one");
  if (row.state !== "verified") throw appError(409, "revision_not_verified", "only a verified revision can go live");
  if (row.guest_contract !== GUEST_CONTRACT) {
    throw appError(409, "guest_contract_mismatch", "this revision was built for another guest contract");
  }
  // The candidate is always kept; this is the registry sweep's word on it.
  if (!row.kept) throw appError(409, "revision_not_retained", "this revision is no longer kept");
  if (!row.images_present) throw appError(409, "revision_images_gone", "this revision's images are no longer stored");

  const now = Date.now();
  // The marker the dependent writes check: this move's own row write.
  const moved = `EXISTS (SELECT 1 FROM scenarios WHERE id = ?1 AND live_rev = ?2 AND updated_at = ?3)`;
  const statements = [
    // The target must be one the registry sweep keeps, with its images still
    // indexed, so a revision never goes live after its images were swept.
    env.DB.prepare(
      `WITH ${KEPT_REVISIONS_CTE}
      UPDATE scenarios SET live_rev = ?2, updated_at = ?3
        WHERE id = ?1 AND live_rev IS ?4 AND enabled = 1 AND candidate_rev = ?2
          AND EXISTS (SELECT 1 FROM kept_revisions kept WHERE kept.scenario_id = ?1 AND kept.rev = ?2)
          AND ${revisionImagesPresentSql("?1", "?2")}
          AND EXISTS (SELECT 1 FROM scenario_revisions revision WHERE revision.scenario_id = ?1 AND revision.rev = ?2
            AND revision.state = 'verified' AND revision.guest_contract = ?5)
          AND EXISTS (SELECT 1 FROM scenarios scenario WHERE scenario.id = ?1 AND ${scopeAdminSql(6)})
          ${source ? `AND ${sourceHeadSql("scenarios.scope_key", { binder: "?6", rev: "?2", row: "?7", attempt: "?8", digest: "?9" })}` : ""}
        RETURNING id`,
    ).bind(scenarioId, rev, now, liveRev, GUEST_CONTRACT, actorUserId,
      ...(source ? [source.rowId, source.attempt, source.digest] : [])),
    env.DB.prepare(
      // "Last made live": retention keeps the revisions live most recently.
      `UPDATE scenario_revisions SET live_at = ?3 WHERE scenario_id = ?1 AND rev = ?2 AND ${moved}`,
    ).bind(scenarioId, rev, now),
  ];
  if (liveRev !== null) {
    // Restore verification comes from the revision this one replaces and
    // from no other, so withdrawing it there is not undone by a push. A
    // revision with a restore check of its own keeps that check's word.
    statements.push(env.DB.prepare(
      `UPDATE scenario_revisions SET restore_verified_at = (SELECT replaced.restore_verified_at
            FROM scenario_revisions replaced WHERE replaced.scenario_id = ?1 AND replaced.rev = ?4
              AND replaced.restore_digest = scenario_revisions.restore_digest
              AND replaced.guest_contract = scenario_revisions.guest_contract)
        WHERE scenario_id = ?1 AND rev = ?2 AND restore_verified_at IS NULL AND restore_verify_run_id IS NULL
          AND ${moved}`,
    ).bind(scenarioId, rev, now, liveRev));
  }
  // A registry writer for the move: refused while a sweep holds the gate, and
  // no sweep starts while it is open, so the move never overlaps a deleting
  // pass that marked without it.
  const writer = await admitInternalRegistryOperation(env, {
    operation: "pointer_mutation",
    owner: { kind: "system", id: source ? `source:${source.scopeKey}` : actorUserId },
  });
  if (!writer.ok) throw appError(503, "registry_busy", "the image registry is busy; try again shortly");
  let outcome: "ok" | "error" = "error";
  let changed: D1Result | undefined;
  try {
    [changed] = await env.DB.batch(statements);
    outcome = "ok";
  } finally {
    await writer.lease.complete(outcome);
  }
  if (!changed?.results.length) throw appError(409, "live_revision_changed", "the scenario changed; reload and try again");
  console.info(JSON.stringify({ event: "scenario_live_revision", scenarioId, kind, from: liveRev, to: rev,
    ...(source ? { source: source.scopeKey, commitRow: source.rowId } : { actorUserId }) }));
  await wakePlatformAgents();
  return { liveRev: rev };
}

/** The head commit of a source, as its job read it. */
export interface SourceHead {
  scopeKey: string;
  /** The deploy row of the head and its attempt. */
  rowId: string;
  attempt: number;
  /** The compile digest the head's rev is built on. */
  digest: string;
}

/**
 * Holds while the source of scope `scope` may act for its head commit: it
 * is bound by `binder`, connected and not paused, and its deploy
 * row `row` of attempt `attempt` has rev `rev`, is the head's on compile
 * digest `digest`, and is one the job still drives. All are SQL
 * expressions. The
 * binder must still administer the scope, as `scopeAdminSql` asks of an
 * actor: this is the source's binding predicate, held in the statement
 * that writes.
 */
export function sourceHeadSql(
  scope: string, by: { binder: string; rev: string; row: string; attempt: string; digest: string },
): string {
  return `EXISTS (SELECT 1 FROM scenario_sources source
      JOIN scenario_source_commits head ON head.scope_key = source.scope_key AND head.purpose = 'deploy'
     WHERE source.scope_key = ${scope} AND source.bound_by_user_id = ${by.binder}
       AND source.disconnected_at IS NULL AND source.paused_at IS NULL
       AND ((source.organization_id IS NULL AND EXISTS (SELECT 1 FROM user binder
           WHERE binder.id = source.bound_by_user_id AND ${activeAdminSql("binder")}))
         OR EXISTS (SELECT 1 FROM member binder_member JOIN user binder ON binder.id = binder_member.user_id
           WHERE binder_member.organization_id = source.organization_id
             AND binder_member.user_id = source.bound_by_user_id
             AND binder_member.role IN ('owner', 'admin') AND ${activeAccountSql("binder")}))
       AND head.id = ${by.row} AND head.attempt = ${by.attempt} AND head.rev = ${by.rev}
       AND head.state IN ('building', 'waiting', 'awaiting_promote')
       AND head.rev = 'git-' || source.github_repository_id || '-' || source.head_sha || '-' || ${by.digest})`;
}

/**
 * Holds while the scenario_revisions row aliased `revision` is another
 * revision than the live one of the scenarios row aliased `scenario`, with
 * the same content and guest contract: learners would get the same lab.
 */
export function sameAsLiveSql(revision: string, scenario: string): string {
  return `EXISTS (SELECT 1 FROM scenario_revisions same_live WHERE same_live.scenario_id = ${scenario}.id
    AND same_live.rev = ${scenario}.live_rev AND same_live.rev <> ${revision}.rev
    AND same_live.content_digest = ${revision}.content_digest AND same_live.guest_contract = ${revision}.guest_contract)`;
}

/**
 * Holds while bundle `rev` is newer than the bundle scope `scopeKey`'s
 * catalog comes from, by ingest time and then rev; both are SQL
 * expressions. No catalog, or one from outside the bundles table, is older.
 */
export function catalogForwardSql(rev: string, scopeKey: string): string {
  return `(EXISTS (SELECT 1 FROM bundles promoted_bundle WHERE promoted_bundle.rev = ${rev})
    AND NOT EXISTS (SELECT 1 FROM course_catalogs current_catalog
      JOIN bundles current_bundle ON current_bundle.rev = current_catalog.source_revision
      JOIN bundles promoted_bundle ON promoted_bundle.rev = ${rev}
      WHERE current_catalog.scope_key = ${scopeKey}
        AND (current_bundle.created_at > promoted_bundle.created_at
          OR (current_bundle.created_at = promoted_bundle.created_at AND current_bundle.rev >= promoted_bundle.rev))))`;
}

/** The bundle's course catalog with each lecture's scenario as `<namespace>/<slug>`. */
export async function namespacedCatalog(r2Key: string | null, namespace: string): Promise<CourseCatalogSnapshotV2> {
  const object = r2Key ? await env.VM_IMAGE_REGISTRY_BUCKET.get(r2Key) : null;
  if (!object) throw appError(409, "bundle_missing", "this revision's bundle is gone");
  const catalog = normalizeCourseCatalogSnapshot((await readSourceBundle(new Uint8Array(await object.arrayBuffer()))).course_catalog);
  if (!catalog) throw appError(409, "bundle_catalog_invalid", "this revision's course catalog is invalid");
  return {
    ...catalog,
    courses: catalog.courses.map((course) => ({
      ...course,
      lectures: course.lectures.map((lecture) =>
        lecture.scenarioId === undefined ? lecture : { ...lecture, scenarioId: `${namespace}/${lecture.scenarioId}` }),
    })),
  };
}


/**
 * Settles verify run `runId` from its stored state, which only the run's own
 * host session writes; `hostId`, when given, must be that host. Passed makes
 * the revision verified; failed or timed out leaves it ready. Either way the
 * revision records the run and its report. A run with an outcome is torn
 * down; `wake` delivers that to its host. Every report of the run calls this
 * again, so a teardown that failed is retried until the run is going away.
 * True when the outcome was new.
 */
export async function settleVerifyRun(
  runId: string,
  options: { hostId?: string; leaseEnded?: boolean; wake?: (hostId: string) => Promise<void> } = {},
): Promise<boolean> {
  // A restore check is a verify run too. The revision names it; and since
  // that name is written after the run is admitted, a report can get here
  // first. Until the run is being torn down, a verify run of a revision
  // that is verified already, and not by this run, can only be one.
  const run = await env.DB.prepare(
    `SELECT run.scenario_id, run.scenario_rev, run.host_id, run.state_json, run.delete_requested_at,
        EXISTS (SELECT 1 FROM scenario_revisions revision WHERE revision.scenario_id = run.scenario_id
          AND revision.rev = run.scenario_rev AND (revision.restore_verify_run_id = run.run_id
            OR (run.delete_requested_at IS NULL AND revision.state = 'verified'
              AND revision.verify_run_id IS NOT run.run_id))) AS restore_check,
        (SELECT vm.kino_digest FROM runtime_vms vm WHERE vm.execution_id = run.run_id LIMIT 1) AS kino
       FROM scenario_runs run
      WHERE run.run_id = ?1 AND run.launch_source = 'verify' AND run.user_id = ?2 AND (?3 IS NULL OR run.host_id = ?3)`,
  ).bind(runId, VALIDATION_USER_ID, options.hostId ?? null).first<{
    scenario_id: string; scenario_rev: string | null; host_id: string; state_json: string; delete_requested_at: number | null;
    restore_check: number; kino: string | null;
  }>();
  if (!run?.scenario_rev) return false;
  const state = JSON.parse(run.state_json) as RunStateDocument;
  const outcome = verifyOutcome(state, options.leaseEnded);
  if (!outcome) return false;
  const report: VerifyReport = {
    runId,
    outcome,
    at: Date.now(),
    machines: state.vms.map((vm) => ({ name: vm.scenarioVmName, verify: vm.lab?.verify ?? null, failure: vm.lab?.failure ?? null })),
  };
  // A restore check counts only when the lab really started from a
  // snapshot, as its last report says, and then passed. Whatever else comes
  // of it, the revision stays what it was: verified for cold boots.
  const restored = state.vms.length > 0 && state.vms.every((vm) => vm.restored === true);
  const restoreReport: RestoreVerifyReport = { ...report, restored, kino: run.kino };
  const [settled] = await env.DB.batch([
    run.restore_check
      ? env.DB.prepare(
        `UPDATE scenario_revisions SET restore_verify_run_id = ?3, restore_verify_report_json = ?5,
            restore_verified_at = CASE WHEN ?4 = 1 THEN ?6 ELSE restore_verified_at END
          WHERE scenario_id = ?1 AND rev = ?2 AND state = 'verified'
            AND ((restore_verify_run_id = ?3 AND restore_verify_report_json IS NULL)
              OR (restore_verify_run_id IS NOT ?3 AND ?7 = 1))
          RETURNING rev`,
      ).bind(run.scenario_id, run.scenario_rev, runId, outcome === "passed" && restored ? 1 : 0,
        JSON.stringify(restoreReport), report.at, run.delete_requested_at === null ? 1 : 0)
      : env.DB.prepare(
        `UPDATE scenario_revisions SET state = CASE WHEN ?4 = 'passed' THEN 'verified' ELSE state END,
            verify_run_id = ?3, verify_report_json = ?5
          WHERE scenario_id = ?1 AND rev = ?2 AND state = 'ready' AND verify_run_id IS NOT ?3
          RETURNING rev`,
      ).bind(run.scenario_id, run.scenario_rev, runId, outcome, JSON.stringify(report)),
    env.DB.prepare(
      `UPDATE scenario_runs SET end_reason = coalesce(end_reason, 'verify_timeout')
        WHERE run_id = ?1 AND ?2 = 'verify_timeout'`,
    ).bind(runId, outcome),
  ]);
  const fresh = Boolean(settled?.results.length);
  if (fresh) {
    console.info(JSON.stringify({ event: "scenario_verify_run", runId, scenarioId: run.scenario_id, rev: run.scenario_rev, outcome,
      ...(run.restore_check ? { restoreCheck: true, restored } : {}) }));
  }
  // An expired lease ends the run itself; any other outcome tears it down.
  if (outcome !== "verify_timeout" && run.delete_requested_at === null) {
    try {
      await destroyScenarioRunForUserWithDependencies({ runId, userId: VALIDATION_USER_ID }, {
        markVmsAbsent: markRunVmsAbsentInDesiredState,
        revokeRoutes: revokeScenarioRunRoutes,
        wakeHostRuntime: options.wake ?? tryWakeHostRuntime,
      });
    } catch (error) {
      // The run's next report retries; its lease ends it at the latest.
      console.warn(JSON.stringify({ event: "scenario_verify_run_teardown_failed", runId,
        error: error instanceof Error ? error.message : String(error) }));
    }
  }
  // After the teardown, which frees the run's slot: the source's
  // job goes on with the lab, or with the next one that waited for the slot.
  if (fresh) await pokeSource(env.DB, { scenarioId: run.scenario_id }).run();
  return fresh;
}

export interface MachineBuildSummary {
  buildKey: string;
  bundleRev: string;
  organizationId: string | null;
  target: string;
  state: string;
  phase: string | null;
  attempt: number;
  error: string | null;
  hasLog: boolean;
  /** The attempts whose log can be asked for, oldest first: those up to the newest uploaded one. */
  logAttempts: number[];
  createdAt: number;
  updatedAt: number;
}

/** Holds while ?{actor} may read the machine_builds row aliased `build`: a platform admin all, an organization's admins its bundles' builds. */
function buildReaderSql(actor: number): string {
  return `(EXISTS (SELECT 1 FROM user reader WHERE reader.id = ?${actor} AND ${activeAdminSql("reader")})
    OR EXISTS (SELECT 1 FROM bundles build_bundle JOIN member actor_member ON actor_member.organization_id = build_bundle.organization_id
        JOIN user actor ON actor.id = actor_member.user_id
      WHERE build_bundle.rev = build.bundle_rev AND actor_member.user_id = ?${actor}
        AND actor_member.role IN ('owner', 'admin') AND ${activeAccountSql("actor")}))`;
}

/** The newest machine builds `actorUserId` may read. */
export async function listAdministeredMachineBuilds(actorUserId: string): Promise<MachineBuildSummary[]> {
  const { results } = await env.DB.prepare(
    `SELECT build.build_key, build.bundle_rev, bundle.organization_id, build.target_json, build.state, build.phase,
        build.attempt, build.error, build.log_key, build.created_at, build.updated_at
      FROM machine_builds build LEFT JOIN bundles bundle ON bundle.rev = build.bundle_rev
      WHERE ${buildReaderSql(1)} ORDER BY build.updated_at DESC LIMIT 200`,
  ).bind(actorUserId).all<{
    build_key: string; bundle_rev: string; organization_id: string | null; target_json: string; state: string;
    phase: string | null; attempt: number; error: string | null; log_key: string | null; created_at: number; updated_at: number;
  }>();
  return results.map((row) => ({
    buildKey: row.build_key, bundleRev: row.bundle_rev, organizationId: row.organization_id,
    target: buildTargetLabel(row.target_json), state: row.state, phase: row.phase, attempt: row.attempt,
    error: row.error, hasLog: row.log_key !== null,
    logAttempts: Array.from({ length: logKeyAttempt(row.log_key) }, (_, index) => index + 1), createdAt: row.created_at, updatedAt: row.updated_at,
  }));
}

/** `<scenario>/<machine>` for a machine build, the image name for an image build. */
function buildTargetLabel(targetJson: string): string {
  const target = JSON.parse(targetJson) as BuildTargetV1;
  return target.kind === "machine" ? `${target.scenario}/${target.machine}` : target.name;
}

/**
 * The log of `buildKey`'s newest uploaded attempt, or of `attempt`, when
 * `actorUserId` may read that build, else null. Only an attempt up to the one
 * `log_key` names is served: a build requeued for another bundle has none
 * until its own first upload, so no log of the previous bundle is reachable.
 */
export async function readAdministeredMachineBuildLog(
  actorUserId: string,
  buildKey: string,
  attempt?: number,
): Promise<R2ObjectBody | null> {
  const row = await env.DB.prepare(
    `SELECT build.log_key FROM machine_builds build WHERE build.build_key = ?2 AND ${buildReaderSql(1)}`,
  ).bind(actorUserId, buildKey).first<{ log_key: string | null }>();
  if (!row?.log_key) return null;
  if (attempt === undefined) return env.VM_IMAGE_REGISTRY_BUCKET.get(row.log_key);
  if (attempt < 1 || attempt > logKeyAttempt(row.log_key)) return null;
  return env.VM_IMAGE_REGISTRY_BUCKET.get(machineBuildLogKey(buildKey, attempt));
}
