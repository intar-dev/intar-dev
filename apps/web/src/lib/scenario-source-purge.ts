// Purges what a disconnected repository published for an organization: its
// courses, scenarios and their revisions, bundles, the runs of those scenarios
// and the learners' progress. The binding row stays as the `purging` marker until
// the end, so a refused or cut-off purge resumes and a reconnect waits.
import { env } from "cloudflare:workers";
import { ACTIVE_RUNTIME_EXECUTION_STATES } from "@/db/schema";
import { appError } from "@/lib/app-error";
import { settleScenarioRevisions } from "@/lib/machine-builds";
import { deleteFinishedScenarioRunForAdmin } from "@/lib/scenario-runs/lifecycle";

// ponytail: runs are deleted one by one through the run delete path, so one
// request handles a bounded number and the caller repeats until done.
const RUNS_PER_REQUEST = 20;

// ?1 scope key, ?2 organization id.
const ORG_SCENARIOS = "SELECT id FROM scenarios WHERE scope_key = ?1 AND organization_id = ?2";
const BUILDING = `EXISTS (SELECT 1 FROM machine_builds WHERE state IN ('assigned', 'building')
      AND bundle_rev IN (SELECT rev FROM bundles WHERE scope_key = ?1))`;
// The scope's builds that no revision of another scope needs, so their rows and
// logs go with the scope.
const SCOPE_BUILDS = `bundle_rev IN (SELECT rev FROM bundles WHERE scope_key = ?1)
      AND state NOT IN ('assigned', 'building')
      AND NOT EXISTS (SELECT 1 FROM scenario_revisions revision
        JOIN scenarios scenario ON scenario.id = revision.scenario_id,
        json_each(revision.doc_json, '$.machines') machine
        WHERE scenario.scope_key <> ?1 AND json_extract(machine.value, '$.build_key') = machine_builds.build_key)`;
const ACTIVE_STATES = ACTIVE_RUNTIME_EXECUTION_STATES.map((state) => `'${state}'`).join(", ");

// Holds while nothing of the scope is still moving and every run of its
// scenarios can be deleted now: an unfinished run, one launched from its
// courses (it loses access with the catalog), a VM not torn down, or an upload
// in flight refuses before anything is deleted. ?3 is the actor.
const QUIET = `EXISTS (SELECT 1 FROM scenario_sources
      WHERE scope_key = ?1 AND disconnected_at IS NOT NULL)
    AND EXISTS (SELECT 1 FROM member WHERE organization_id = ?2 AND user_id = ?3
      AND role IN ('owner', 'admin'))
    AND NOT EXISTS (SELECT 1 FROM scenario_source_commits WHERE scope_key = ?1
      AND state IN ('fetching', 'compiling', 'ingesting', 'promoting'))
    AND NOT ${BUILDING}
    AND NOT EXISTS (SELECT 1 FROM scenario_runs WHERE state NOT IN ('completed', 'failed')
      AND (scenario_id IN (${ORG_SCENARIOS}) OR course_scope_key = ?1))
    AND NOT EXISTS (SELECT 1 FROM scenario_runs AS run WHERE run.scenario_id IN (${ORG_SCENARIOS})
      AND (NOT EXISTS (SELECT 1 FROM json_each(run.state_json, '$.vms'))
        OR EXISTS (SELECT 1 FROM json_each(run.state_json, '$.vms') AS vm
          WHERE json_extract(vm.value, '$.phase') IS NOT 'completed')
        OR EXISTS (SELECT 1 FROM scenario_run_artifacts AS artifact
          WHERE artifact.run_id = run.run_id AND artifact.upload_status <> 'uploaded')))
    AND NOT EXISTS (SELECT 1 FROM runtime_executions WHERE organization_id = ?2
      AND state IN (${ACTIVE_STATES})
      AND domain_id IN (SELECT run_id FROM scenario_runs WHERE scenario_id IN (${ORG_SCENARIOS})))`;

// Holds once the purge has started and no run of the scope's scenarios is left.
const PURGING = `EXISTS (SELECT 1 FROM scenario_sources
      WHERE scope_key = ?1 AND disconnect_reason = 'purging')
    AND NOT EXISTS (SELECT 1 FROM scenario_runs WHERE scenario_id IN (${ORG_SCENARIOS}))`;

/** One step of the purge. True once nothing of the scope is left. */
export async function purgeScenarioSource(input: {
  scopeKey: string;
  organizationId: string;
  actorUserId: string;
}): Promise<boolean> {
  const { scopeKey, organizationId, actorUserId } = input;
  const d1 = env.DB;
  const now = Date.now();
  // D1 wants exactly as many values as the highest ?N a statement names.
  const params = [scopeKey, organizationId, actorUserId, now];
  const bind = (statement: string) =>
    d1.prepare(statement).bind(
      ...params.slice(0, Math.max(0, ...[...statement.matchAll(/\?(\d)/g)].map((m) => Number(m[1])))),
    );

  // Every call re-checks the guard, so a role change or a new run stops it.
  // Removing the catalog and disabling the scenarios stops new starts. A
  // queued build of the scope can no longer read its bundle, so it fails
  // here instead of going to a builder.
  const [marked, , , purgedBuilds] = await d1.batch([
    bind(`UPDATE scenario_sources SET disconnect_reason = 'purging', updated_at = ?4
      WHERE scope_key = ?1 AND ${QUIET} RETURNING scope_key`),
    bind(`DELETE FROM course_catalogs WHERE scope_key = ?1 AND ${QUIET}`),
    bind(`UPDATE scenarios SET enabled = 0, updated_at = ?4
      WHERE scope_key = ?1 AND organization_id = ?2 AND enabled = 1 AND ${QUIET}`),
    bind(`UPDATE machine_builds SET state = 'failed', error = 'purged', updated_at = ?4
      WHERE state = 'queued' AND bundle_rev IN (SELECT rev FROM bundles WHERE scope_key = ?1) AND ${QUIET}
      RETURNING build_key`),
  ]);
  if (!marked?.results.length) throw await refusal(input);
  // Revisions of other scopes that wait on such a build fail with it.
  for (const { build_key: buildKey } of purgedBuilds!.results as Array<{ build_key: string }>) {
    await settleScenarioRevisions(env, { buildKey });
  }

  const { results: runs } = await bind(
    `SELECT run_id FROM scenario_runs WHERE scenario_id IN (${ORG_SCENARIOS}) LIMIT ${RUNS_PER_REQUEST + 1}`,
  ).all<{ run_id: string }>();
  for (const run of runs.slice(0, RUNS_PER_REQUEST)) {
    await deleteFinishedScenarioRunForAdmin({ runId: run.run_id, actorUserId });
  }
  if (runs.length > RUNS_PER_REQUEST) return false;

  // The objects go before the rows that name them, so a purge cut off in
  // between reads the same keys again. R2 deletes take at most 1000 keys.
  // The marker is still set, so no reconnect writes under these keys.
  const { results: keys } = await bind(
    `SELECT r2_key AS key FROM bundles WHERE scope_key = ?1 AND organization_id = ?2
      UNION ALL SELECT log_key FROM machine_builds WHERE log_key IS NOT NULL AND ${SCOPE_BUILDS}`,
  ).all<{ key: string }>();
  for (let offset = 0; offset < keys.length; offset += 1000) {
    await env.VM_IMAGE_REGISTRY_BUCKET.delete(
      keys.slice(offset, offset + 1000).map((row) => row.key),
    );
  }
  // The assignment delete reads the scenarios, so it runs before them; their
  // revisions cascade with them, and the commits with the binding. The
  // registry sweep reclaims the unreferenced images.
  await d1.batch([
    bind(`DELETE FROM course_unit_completions WHERE scope_key = ?1 AND ${PURGING}`),
    bind(`DELETE FROM scenario_assignments WHERE organization_id = ?2
      AND scenario_id IN (${ORG_SCENARIOS}) AND ${PURGING}`),
    bind(`DELETE FROM scenarios WHERE scope_key = ?1 AND organization_id = ?2 AND ${PURGING}`),
    bind(`DELETE FROM machine_builds WHERE ${SCOPE_BUILDS} AND ${PURGING}`),
    bind(`DELETE FROM bundles WHERE scope_key = ?1 AND organization_id = ?2 AND ${PURGING}`),
    bind(`DELETE FROM scenario_sources WHERE scope_key = ?1 AND ${PURGING}
      AND NOT EXISTS (${ORG_SCENARIOS})`),
  ]);
  return true;
}

async function refusal(input: {
  scopeKey: string;
  organizationId: string;
  actorUserId: string;
}) {
  const row = await env.DB.prepare(
    `SELECT
        (SELECT disconnected_at IS NOT NULL FROM scenario_sources WHERE scope_key = ?1) AS disconnected,
        EXISTS (SELECT 1 FROM member WHERE organization_id = ?2 AND user_id = ?3
          AND role IN ('owner', 'admin')) AS admin,
        EXISTS (SELECT 1 FROM scenario_source_commits WHERE scope_key = ?1
          AND state IN ('fetching', 'compiling', 'ingesting', 'promoting'))
          OR ${BUILDING} AS deploying`,
  )
    .bind(input.scopeKey, input.organizationId, input.actorUserId)
    .first<{ disconnected: number | null; admin: number; deploying: number }>();
  if (!row?.disconnected) {
    return appError(409, "scenario_source_not_disconnected", "Disconnect the repository first.");
  }
  if (!row.admin) {
    return appError(409, "scenario_source_authority_changed", "Your role changed. Reload and try again.");
  }
  if (row.deploying) {
    return appError(409, "scenario_source_deploying", "A deploy is still finishing. Try again in a few minutes.");
  }
  return appError(
    409,
    "scenario_source_runs_active",
    "Some runs of these scenarios are still going or being cleaned up. Try again once they end.",
  );
}
