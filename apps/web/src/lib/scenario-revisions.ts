// The pointer model of scenario revisions. Each scenario has a candidate
// (`candidate_rev`, its newest ready or verified revision, which admins
// verify) and a live revision (`live_rev`, which learners start). Only a
// verified revision of the current guest contract goes live: by promotion
// of the candidate, or by rollback to a revision that was live before.
// Every change is a compare-and-set on the scenario row that rechecks the
// actor's rights, so a racing admin or ingest cannot make an unverified or
// stale revision live. A run keeps the revision it started from.

import { env } from "cloudflare:workers";
import { normalizeCourseCatalogSnapshot } from "@/control-plane/image-registry/bundle";
import type { CourseCatalogSnapshotV2 } from "@/db/schema/shared";
import { GUEST_CONTRACT } from "@/generated/constants";
import { activeAccountSql, activeAdminSql } from "@/lib/account-access";
import { appError } from "@/lib/app-error";
import { courseCatalogScopeKey } from "@/lib/course-catalogs";
import { tryWakeHostRuntime } from "@/lib/host-runtime-wake";
import { verifyOutcome, type VerifyOutcome } from "@/lib/run-tasks";
import type { RunStateDocument } from "@/lib/run-state";
import { readSourceBundle } from "@/lib/scenario-contract/source-bundle";
import { VALIDATION_USER_ID } from "@/lib/scenario-runs/content-access";
import { destroyScenarioRunForUserWithDependencies } from "@/lib/scenario-runs/lifecycle";
import { markRunVmsAbsentInDesiredState, revokeScenarioRunRoutes } from "@/lib/scenario-runs/start";
import { countUnitGuardRuns } from "@/lib/scenario-sources";

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
  liveAt: number | null;
  createdAt: number;
}

export interface VerifyReport {
  runId: string;
  outcome: VerifyOutcome;
  at: number;
  machines: Array<{ name: string; verify: unknown; failure: string | null }>;
}

export interface AdministeredScenario {
  id: string;
  namespace: string;
  slug: string;
  organizationId: string | null;
  title: string | null;
  enabled: boolean;
  play: boolean;
  liveRev: string | null;
  candidateRev: string | null;
  /** Whether the reader may verify, promote and roll back. */
  canManage: boolean;
  /** The active verify run of each revision, by rev. */
  verifyRuns: Record<string, string>;
  revisions: ScenarioRevisionSummary[];
}

/** The scenarios `actorUserId` may read, or one of them, with their revisions newest first. */
export async function listAdministeredScenarios(actorUserId: string, scenarioId?: string): Promise<AdministeredScenario[]> {
  const [scenarios, revisions, runs] = await env.DB.batch([
    env.DB.prepare(
      `SELECT scenario.id, scenario.namespace, scenario.slug, scenario.organization_id, scenario.enabled,
          scenario.play, scenario.live_rev, scenario.candidate_rev, ${scopeAdminSql(1)} AS can_manage,
          (SELECT json_extract(titled.doc_json, '$.title') FROM scenario_revisions titled
            WHERE titled.scenario_id = scenario.id ORDER BY titled.rev = scenario.live_rev DESC,
              titled.created_at DESC LIMIT 1) AS title
        FROM scenarios scenario WHERE ${readerSql(1)} AND (?2 IS NULL OR scenario.id = ?2) ORDER BY scenario.id`,
    ).bind(actorUserId, scenarioId ?? null),
    env.DB.prepare(
      `SELECT revision.scenario_id, revision.rev, revision.state, revision.guest_contract, revision.content_digest,
          revision.failure_reason, revision.verify_run_id, revision.verify_report_json, revision.live_at,
          revision.created_at
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
  ]);
  type ScenarioRow = {
    id: string; namespace: string; slug: string; organization_id: string | null; enabled: number; play: number;
    live_rev: string | null; candidate_rev: string | null; can_manage: number; title: string | null;
  };
  type RevisionRow = {
    scenario_id: string; rev: string; state: ScenarioRevisionSummary["state"]; guest_contract: number;
    content_digest: string | null; failure_reason: string | null; verify_run_id: string | null;
    verify_report_json: string | null; live_at: number | null; created_at: number;
  };
  const byScenario = new Map<string, AdministeredScenario>();
  for (const row of scenarios!.results as ScenarioRow[]) {
    byScenario.set(row.id, {
      id: row.id, namespace: row.namespace, slug: row.slug, organizationId: row.organization_id, title: row.title,
      enabled: row.enabled === 1, play: row.play === 1, liveRev: row.live_rev, candidateRev: row.candidate_rev,
      canManage: row.can_manage === 1, verifyRuns: {}, revisions: [],
    });
  }
  for (const row of revisions!.results as RevisionRow[]) {
    byScenario.get(row.scenario_id)?.revisions.push({
      rev: row.rev, state: row.state, guestContract: row.guest_contract, contentDigest: row.content_digest,
      failureReason: row.failure_reason, verifyRunId: row.verify_run_id,
      verifyReport: row.verify_report_json ? (JSON.parse(row.verify_report_json) as VerifyReport) : null,
      liveAt: row.live_at, createdAt: row.created_at,
    });
  }
  for (const row of runs!.results as Array<{ run_id: string; scenario_id: string; scenario_rev: string }>) {
    const scenario = byScenario.get(row.scenario_id);
    if (scenario) scenario.verifyRuns[row.scenario_rev] = row.run_id;
  }
  return [...byScenario.values()];
}

/** Refuses unless `actorUserId` administers the scenario's scope; the same 404 hides a scenario it may not read. */
export async function assertScenarioAdmin(actorUserId: string, scenarioId: string): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT ${scopeAdminSql(1)} AS manage, ${readerSql(1)} AS read FROM scenarios scenario WHERE scenario.id = ?2`,
  ).bind(actorUserId, scenarioId).first<{ manage: number; read: number }>();
  if (!row?.read) throw appError(404, "scenario_not_found", "scenario not found");
  if (!row.manage) throw appError(403, "scenario_scope_admin_required", "only an administrator of this scenario's scope may change it");
}

/**
 * Moves `live_rev` from `liveRev` to `rev`: a promotion of the candidate, or
 * a rollback to a revision that was live before. Either needs a verified
 * revision of the current guest contract, and the scope's course catalog
 * from that revision's bundle, with each lecture's scenario namespaced,
 * must not take content from an active run. The operator drain does not
 * hold it. Platform hosts then cache the new live images.
 */
export async function moveLiveRevision(input: {
  scenarioId: string;
  rev: string;
  /** The live revision the actor saw; the move fails when it changed. */
  liveRev: string | null;
  kind: "promote" | "rollback";
  actorUserId: string;
}): Promise<{ liveRev: string }> {
  const { scenarioId, rev, liveRev, kind, actorUserId } = input;
  const row = await env.DB.prepare(
    `SELECT scenario.namespace, scenario.organization_id, scenario.live_rev, scenario.candidate_rev,
        revision.state, revision.guest_contract, revision.live_at, bundle.r2_key, ${scopeAdminSql(3)} AS manage
      FROM scenarios scenario
      JOIN scenario_revisions revision ON revision.scenario_id = scenario.id AND revision.rev = ?2
      LEFT JOIN bundles bundle ON bundle.rev = revision.rev AND bundle.scope_key = scenario.scope_key
      WHERE scenario.id = ?1`,
  ).bind(scenarioId, rev, actorUserId).first<{
    namespace: string; organization_id: string | null; live_rev: string | null; candidate_rev: string | null;
    state: string; guest_contract: number; live_at: number | null; r2_key: string | null; manage: number;
  }>();
  if (!row?.manage) throw appError(404, "scenario_revision_not_found", "scenario revision not found");
  if (row.live_rev === rev) throw appError(409, "revision_already_live", "this revision is already live");
  if (row.live_rev !== liveRev) throw appError(409, "live_revision_changed", "the live revision changed; reload and try again");
  if (kind === "promote" && row.candidate_rev !== rev) {
    throw appError(409, "revision_not_candidate", "only the scenario's candidate revision can be promoted");
  }
  if (kind === "rollback" && row.live_at === null) {
    throw appError(409, "revision_never_live", "a rollback goes only to a revision that was live before");
  }
  if (row.state !== "verified") throw appError(409, "revision_not_verified", "only a verified revision can go live");
  if (row.guest_contract !== GUEST_CONTRACT) {
    throw appError(409, "guest_contract_mismatch", "this revision was built for another guest contract");
  }
  const catalog = await namespacedCatalog(row.r2_key, row.namespace);
  const scopeKey = courseCatalogScopeKey(row.organization_id);
  const current = await env.DB.prepare("SELECT catalog_json FROM course_catalogs WHERE scope_key = ?1")
    .bind(scopeKey).first<{ catalog_json: string }>();
  const catalogJson = JSON.stringify(catalog);
  if (current?.catalog_json !== catalogJson && (await countUnitGuardRuns(env.DB, row.organization_id, catalog))) {
    throw appError(409, "active_runs_would_lose_access", "active runs would lose their course unit; try again when they end");
  }

  const now = Date.now();
  // The marker the dependent writes check: this move's own row write.
  const moved = `EXISTS (SELECT 1 FROM scenarios WHERE id = ?1 AND live_rev = ?2 AND updated_at = ?3)`;
  const [changed] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE scenarios SET live_rev = ?2, updated_at = ?3
        WHERE id = ?1 AND live_rev IS ?4 AND enabled = 1
          AND (?5 = 'rollback' OR candidate_rev = ?2)
          AND EXISTS (SELECT 1 FROM scenario_revisions revision WHERE revision.scenario_id = ?1 AND revision.rev = ?2
            AND revision.state = 'verified' AND revision.guest_contract = ?6
            AND (?5 = 'promote' OR revision.live_at IS NOT NULL))
          AND EXISTS (SELECT 1 FROM scenarios scenario WHERE scenario.id = ?1 AND ${scopeAdminSql(7)})
        RETURNING id`,
    ).bind(scenarioId, rev, now, liveRev, kind, GUEST_CONTRACT, actorUserId),
    env.DB.prepare(
      `UPDATE scenario_revisions SET live_at = coalesce(live_at, ?3) WHERE scenario_id = ?1 AND rev = ?2 AND ${moved}`,
    ).bind(scenarioId, rev, now),
    env.DB.prepare(
      `INSERT INTO course_catalogs (scope_key, organization_id, catalog_json, source_revision, created_at, updated_at)
        SELECT ?4, ?5, ?6, ?2, ?3, ?3 WHERE ${moved}
        ON CONFLICT (scope_key) DO UPDATE SET catalog_json = excluded.catalog_json,
          source_revision = excluded.source_revision, updated_at = max(course_catalogs.updated_at + 1, excluded.updated_at)`,
    ).bind(scenarioId, rev, now, scopeKey, row.organization_id, catalogJson),
  ]);
  if (!changed?.results.length) throw appError(409, "live_revision_changed", "the scenario changed; reload and try again");
  console.info(JSON.stringify({ event: "scenario_live_revision", scenarioId, kind, from: liveRev, to: rev, actorUserId }));
  await wakePlatformAgents();
  return { liveRev: rev };
}

/** The bundle's course catalog with each lecture's scenario as `<namespace>/<slug>`. */
async function namespacedCatalog(r2Key: string | null, namespace: string): Promise<CourseCatalogSnapshotV2> {
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

/** Each connected platform agent rebuilds its desired state, whose `cached_images` follow the live revisions. */
async function wakePlatformAgents(): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM agent_hosts WHERE scope = 'platform' AND role = 'agent' AND disabled = 0 AND connected = 1`,
  ).all<{ id: string }>();
  await Promise.all(results.map((host) => tryWakeHostRuntime(host.id)));
}

/**
 * Settles verify run `runId` from its stored state, which only the run's own
 * host session writes; `hostId`, when given, must be that host. Passed makes
 * the revision verified; failed or timed out leaves it ready. Either way the
 * revision records the run and its report. A run with an outcome is torn
 * down; `wake` delivers that to its host. True when the outcome was new.
 */
export async function settleVerifyRun(
  runId: string,
  options: { hostId?: string; leaseEnded?: boolean; wake?: (hostId: string) => Promise<void> } = {},
): Promise<boolean> {
  const run = await env.DB.prepare(
    `SELECT scenario_id, scenario_rev, host_id, state_json FROM scenario_runs
      WHERE run_id = ?1 AND launch_source = 'verify' AND user_id = ?2 AND (?3 IS NULL OR host_id = ?3)`,
  ).bind(runId, VALIDATION_USER_ID, options.hostId ?? null)
    .first<{ scenario_id: string; scenario_rev: string | null; host_id: string; state_json: string }>();
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
  const [settled] = await env.DB.batch([
    env.DB.prepare(
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
  if (!settled?.results.length) return false;
  console.info(JSON.stringify({ event: "scenario_verify_run", runId, scenarioId: run.scenario_id, rev: run.scenario_rev, outcome }));
  if (outcome !== "verify_timeout") {
    try {
      await destroyScenarioRunForUserWithDependencies({ runId, userId: VALIDATION_USER_ID }, {
        markVmsAbsent: markRunVmsAbsentInDesiredState,
        revokeRoutes: revokeScenarioRunRoutes,
        wakeHostRuntime: options.wake ?? tryWakeHostRuntime,
      });
    } catch (error) {
      // The run's lease still ends it.
      console.warn(JSON.stringify({ event: "scenario_verify_run_teardown_failed", runId,
        error: error instanceof Error ? error.message : String(error) }));
    }
  }
  return true;
}
