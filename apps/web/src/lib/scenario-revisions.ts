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
import type { BuildTargetV1, VmVerifyV1 } from "@/generated/contracts/bridge-message-v9";
import { activeAccountSql, activeAdminSql } from "@/lib/account-access";
import { appError } from "@/lib/app-error";
import { courseCatalogScopeKey } from "@/lib/course-catalogs";
import { tryWakeHostRuntime } from "@/lib/host-runtime-wake";
import { admitInternalRegistryOperation } from "@/lib/image-registry-admission";
import { KEPT_REVISIONS_CTE, revisionImagesPresentSql } from "@/lib/kept-revisions";
import { verifyOutcome, type VerifyOutcome } from "@/lib/run-tasks";
import type { RunStateDocument } from "@/lib/run-state";
import { readSourceBundle } from "@/lib/scenario-contract/source-bundle";
import { VALIDATION_USER_ID } from "@/lib/scenario-runs/content-access";
import { destroyScenarioRunForUserWithDependencies } from "@/lib/scenario-runs/lifecycle";
import { markRunVmsAbsentInDesiredState, revokeScenarioRunRoutes } from "@/lib/scenario-runs/start";
import { countUnitGuardRuns, unitGuardRunsSql } from "@/lib/scenario-sources";

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
  /**
   * Whether the server would make this revision live now: verified, of the
   * current guest contract, kept by the registry sweep, its images stored.
   */
  canGoLive: boolean;
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
      `WITH ${KEPT_REVISIONS_CTE}
      SELECT revision.scenario_id, revision.rev, revision.state, revision.guest_contract, revision.content_digest,
          revision.failure_reason, revision.verify_run_id, revision.verify_report_json, revision.live_at,
          revision.created_at, (revision.state = 'verified' AND revision.guest_contract = ?3
            AND EXISTS (SELECT 1 FROM kept_revisions kept WHERE kept.scenario_id = revision.scenario_id AND kept.rev = revision.rev)
            AND ${revisionImagesPresentSql("revision.scenario_id", "revision.rev")}) AS can_go_live
        FROM scenario_revisions revision JOIN scenarios scenario ON scenario.id = revision.scenario_id
        WHERE ${readerSql(1)} AND (?2 IS NULL OR scenario.id = ?2)
        ORDER BY revision.created_at DESC, revision.rev DESC`,
    ).bind(actorUserId, scenarioId ?? null, GUEST_CONTRACT),
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
    verify_report_json: string | null; live_at: number | null; created_at: number; can_go_live: number;
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
      liveAt: row.live_at, createdAt: row.created_at, canGoLive: row.can_go_live === 1,
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
 * revision of the current guest contract. A promotion whose bundle is newer
 * than the scope catalog's applies that bundle's catalog, with each
 * lecture's scenario namespaced, and must not take content from an active
 * run; a rollback never touches the catalog. The operator drain does not
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
    `WITH ${KEPT_REVISIONS_CTE}
    SELECT scenario.namespace, scenario.organization_id, scenario.live_rev, scenario.candidate_rev,
        revision.state, revision.guest_contract, revision.live_at, bundle.r2_key, ${scopeAdminSql(3)} AS manage,
        EXISTS (SELECT 1 FROM kept_revisions kept WHERE kept.scenario_id = ?1 AND kept.rev = ?2) AS kept,
        ${revisionImagesPresentSql("?1", "?2")} AS images_present
      FROM scenarios scenario
      JOIN scenario_revisions revision ON revision.scenario_id = scenario.id AND revision.rev = ?2
      LEFT JOIN bundles bundle ON bundle.rev = revision.rev AND bundle.scope_key = scenario.scope_key
      WHERE scenario.id = ?1`,
  ).bind(scenarioId, rev, actorUserId).first<{
    namespace: string; organization_id: string | null; live_rev: string | null; candidate_rev: string | null;
    state: string; guest_contract: number; live_at: number | null; r2_key: string | null; manage: number;
    kept: number; images_present: number;
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
  if (!row.kept) {
    throw appError(409, "revision_not_retained", "only the newest verified revisions stay available to roll back to");
  }
  if (!row.images_present) throw appError(409, "revision_images_gone", "this revision's images are no longer stored");
  const scopeKey = courseCatalogScopeKey(row.organization_id);
  // Only a promotion of a newer bundle moves the scope's catalog; a rollback
  // or a lagging candidate leaves it, so the catalog never goes backwards.
  const forward = kind === "promote" && (await env.DB.prepare(`SELECT ${catalogForwardSql(1, 2)} AS forward`)
    .bind(rev, scopeKey).first<{ forward: number }>())?.forward === 1;
  const catalogJson = forward ? JSON.stringify(await namespacedCatalog(row.r2_key, row.namespace)) : null;
  if (catalogJson !== null && (await countUnitGuardRuns(env.DB, row.organization_id, JSON.parse(catalogJson)))) {
    throw activeRunsWouldLoseAccess();
  }

  const now = Date.now();
  // The marker the dependent writes check: this move's own row write.
  const moved = `EXISTS (SELECT 1 FROM scenarios WHERE id = ?1 AND live_rev = ?2 AND updated_at = ?3)`;
  const statements = [
    // The target must be one the registry sweep keeps, with its images still
    // indexed, so a revision never goes live after its images were swept.
    env.DB.prepare(
      `WITH ${KEPT_REVISIONS_CTE}
      UPDATE scenarios SET live_rev = ?2, updated_at = ?3
        WHERE id = ?1 AND live_rev IS ?4 AND enabled = 1
          AND EXISTS (SELECT 1 FROM kept_revisions kept WHERE kept.scenario_id = ?1 AND kept.rev = ?2)
          AND ${revisionImagesPresentSql("?1", "?2")}
          AND (?5 = 'rollback' OR candidate_rev = ?2)
          AND EXISTS (SELECT 1 FROM scenario_revisions revision WHERE revision.scenario_id = ?1 AND revision.rev = ?2
            AND revision.state = 'verified' AND revision.guest_contract = ?6
            AND (?5 = 'promote' OR revision.live_at IS NOT NULL))
          AND EXISTS (SELECT 1 FROM scenarios scenario WHERE scenario.id = ?1 AND ${scopeAdminSql(7)})
          -- The unit guard holds in this statement, so a run admitted after
          -- the check above cannot lose its unit to the catalog below.
          AND (?10 IS NULL OR NOT ${catalogForwardSql(2, 9)} OR NOT EXISTS (SELECT 1 ${unitGuardRunsSql(8, 9, 10)}))
        RETURNING id`,
    ).bind(scenarioId, rev, now, liveRev, kind, GUEST_CONTRACT, actorUserId, row.organization_id, scopeKey, catalogJson),
    env.DB.prepare(
      `UPDATE scenario_revisions SET live_at = coalesce(live_at, ?3) WHERE scenario_id = ?1 AND rev = ?2 AND ${moved}`,
    ).bind(scenarioId, rev, now),
  ];
  if (catalogJson !== null) {
    statements.push(env.DB.prepare(
      `INSERT INTO course_catalogs (scope_key, organization_id, catalog_json, source_revision, created_at, updated_at)
        SELECT ?4, ?5, ?6, ?2, ?3, ?3 WHERE ${moved} AND ${catalogForwardSql(2, 4)}
        ON CONFLICT (scope_key) DO UPDATE SET catalog_json = excluded.catalog_json,
          source_revision = excluded.source_revision, updated_at = max(course_catalogs.updated_at + 1, excluded.updated_at)`,
    ).bind(scenarioId, rev, now, scopeKey, row.organization_id, catalogJson));
  }
  // A registry writer for the move: refused while a sweep holds the gate, and
  // no sweep starts while it is open, so the move never overlaps a deleting
  // pass that marked without it.
  const writer = await admitInternalRegistryOperation(env, {
    operation: "pointer_mutation",
    owner: { kind: "system", id: actorUserId },
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
  if (!changed?.results.length) {
    if (catalogJson !== null && (await countUnitGuardRuns(env.DB, row.organization_id, JSON.parse(catalogJson)))) {
      throw activeRunsWouldLoseAccess();
    }
    throw appError(409, "live_revision_changed", "the scenario changed; reload and try again");
  }
  console.info(JSON.stringify({ event: "scenario_live_revision", scenarioId, kind, from: liveRev, to: rev, actorUserId }));
  await wakePlatformAgents();
  return { liveRev: rev };
}

const activeRunsWouldLoseAccess = () =>
  appError(409, "active_runs_would_lose_access", "active runs would lose their course unit; try again when they end");

/**
 * Holds while bundle ?{rev} is newer than the bundle scope ?{scopeKey}'s
 * catalog comes from, by ingest time and then rev. No catalog, or one from
 * outside the bundles table, is older.
 */
function catalogForwardSql(rev: number, scopeKey: number): string {
  return `(EXISTS (SELECT 1 FROM bundles promoted_bundle WHERE promoted_bundle.rev = ?${rev})
    AND NOT EXISTS (SELECT 1 FROM course_catalogs current_catalog
      JOIN bundles current_bundle ON current_bundle.rev = current_catalog.source_revision
      JOIN bundles promoted_bundle ON promoted_bundle.rev = ?${rev}
      WHERE current_catalog.scope_key = ?${scopeKey}
        AND (current_bundle.created_at > promoted_bundle.created_at
          OR (current_bundle.created_at = promoted_bundle.created_at AND current_bundle.rev >= promoted_bundle.rev))))`;
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
 * down; `wake` delivers that to its host. Every report of the run calls this
 * again, so a teardown that failed is retried until the run is going away.
 * True when the outcome was new.
 */
export async function settleVerifyRun(
  runId: string,
  options: { hostId?: string; leaseEnded?: boolean; wake?: (hostId: string) => Promise<void> } = {},
): Promise<boolean> {
  const run = await env.DB.prepare(
    `SELECT scenario_id, scenario_rev, host_id, state_json, delete_requested_at FROM scenario_runs
      WHERE run_id = ?1 AND launch_source = 'verify' AND user_id = ?2 AND (?3 IS NULL OR host_id = ?3)`,
  ).bind(runId, VALIDATION_USER_ID, options.hostId ?? null).first<{
    scenario_id: string; scenario_rev: string | null; host_id: string; state_json: string; delete_requested_at: number | null;
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
  const fresh = Boolean(settled?.results.length);
  if (fresh) {
    console.info(JSON.stringify({ event: "scenario_verify_run", runId, scenarioId: run.scenario_id, rev: run.scenario_rev, outcome }));
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
        build.attempt, build.error, build.log_key IS NOT NULL AS has_log, build.created_at, build.updated_at
      FROM machine_builds build LEFT JOIN bundles bundle ON bundle.rev = build.bundle_rev
      WHERE ${buildReaderSql(1)} ORDER BY build.updated_at DESC LIMIT 200`,
  ).bind(actorUserId).all<{
    build_key: string; bundle_rev: string; organization_id: string | null; target_json: string; state: string;
    phase: string | null; attempt: number; error: string | null; has_log: number; created_at: number; updated_at: number;
  }>();
  return results.map((row) => ({
    buildKey: row.build_key, bundleRev: row.bundle_rev, organizationId: row.organization_id,
    target: buildTargetLabel(row.target_json), state: row.state, phase: row.phase, attempt: row.attempt,
    error: row.error, hasLog: row.has_log === 1, createdAt: row.created_at, updatedAt: row.updated_at,
  }));
}

/** `<scenario>/<machine>` for a machine build, the image name for an image build. */
function buildTargetLabel(targetJson: string): string {
  const target = JSON.parse(targetJson) as BuildTargetV1;
  return target.kind === "machine" ? `${target.scenario}/${target.machine}` : target.name;
}

/** The build log of `buildKey` when `actorUserId` may read that build, else null. */
export async function readAdministeredMachineBuildLog(actorUserId: string, buildKey: string): Promise<R2ObjectBody | null> {
  const row = await env.DB.prepare(
    `SELECT build.log_key FROM machine_builds build WHERE build.build_key = ?2 AND ${buildReaderSql(1)}`,
  ).bind(actorUserId, buildKey).first<{ log_key: string | null }>();
  return row?.log_key ? env.VM_IMAGE_REGISTRY_BUCKET.get(row.log_key) : null;
}
