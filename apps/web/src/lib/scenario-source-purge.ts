// Purges what a disconnected repository published for an organization: its
// courses, scenarios, images, builds, bundles, the runs of those scenarios and
// the learners' progress. The binding row stays as the `purging` marker until
// the end, so a refused or cut-off purge resumes and a reconnect waits.
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { ACTIVE_RUNTIME_EXECUTION_STATES } from "@/db/schema";
import type { ImageArchitecture } from "@/generated/catalog";
import { appError } from "@/lib/app-error";
import { withImageBuildCoordinationLocks } from "@/lib/image-build-lock";
import { tryWakeHostRuntimeViaNamespace } from "@/lib/host-runtime-wake-client";
import { reconcileScenarioImagesForPublicationScope } from "@/lib/scenario-image-cache";
import { deleteFinishedScenarioRunForAdmin } from "@/lib/scenario-runs/lifecycle";

// ponytail: runs are deleted one by one through the run delete path, so one
// request handles a bounded number and the caller repeats until done.
const RUNS_PER_REQUEST = 20;

// ?1 scope key, ?2 organization id.
const ORG_SCENARIOS = "SELECT scenario_id FROM vm_scenarios WHERE organization_id = ?2";
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
    AND NOT EXISTS (SELECT 1 FROM image_builds WHERE organization_id = ?2
      AND status IN ('assigned', 'building'))
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
  // Removing the catalog stops new starts; queued builds would never run.
  const [marked] = await d1.batch([
    bind(`UPDATE scenario_sources SET disconnect_reason = 'purging', updated_at = ?4
      WHERE scope_key = ?1 AND ${QUIET} RETURNING scope_key`),
    bind(`UPDATE image_builds SET status = 'stale', error = 'purged', updated_at = ?4
      WHERE organization_id = ?2 AND status = 'queued' AND ${QUIET}`),
    bind(`DELETE FROM course_catalogs WHERE scope_key = ?1 AND ${QUIET}`),
    bind(`UPDATE vm_scenarios SET enabled = 0, enabled_at = NULL, updated_at = ?4
      WHERE organization_id = ?2 AND enabled = 1 AND ${QUIET}`),
  ]);
  if (!marked?.results.length) throw await refusal(input);

  // Platform hosts drop the cached images while the scenarios still name them;
  // once the rows are gone a host keeps an unknown scenario's cache.
  const cache = await reconcileScenarioImagesForPublicationScope(drizzle(d1), {
    publicationOrganizationId: organizationId,
    nowUnixMs: now,
    wakeHostRuntime: (hostId) => tryWakeHostRuntimeViaNamespace(env.HOST_RUNTIME, hostId),
  });
  if (cache.failedHostIds.length) {
    throw appError(503, "scenario_source_purge_retry", "Some servers couldn't be updated. Try again.");
  }

  const { results: runs } = await bind(
    `SELECT run_id FROM scenario_runs WHERE scenario_id IN (${ORG_SCENARIOS}) LIMIT ${RUNS_PER_REQUEST + 1}`,
  ).all<{ run_id: string }>();
  for (const run of runs.slice(0, RUNS_PER_REQUEST)) {
    await deleteFinishedScenarioRunForAdmin({ runId: run.run_id, actorUserId });
  }
  if (runs.length > RUNS_PER_REQUEST) return false;

  const { results: families } = await bind(
    `SELECT DISTINCT vm.scenario_id, json_extract(vm.image_key_json, '$.arch') AS arch
      FROM vm_scenario_vms AS vm WHERE vm.scenario_id IN (${ORG_SCENARIOS})
        AND json_extract(vm.image_key_json, '$.arch') IS NOT NULL
      UNION SELECT scenario_id, arch FROM image_builds WHERE organization_id = ?2
      UNION SELECT json_extract(vm.value, '$.scenarioId'), json_extract(vm.value, '$.imageKeyJson.arch')
        FROM scenario_catalog_snapshots AS snapshot, json_each(snapshot.snapshot_json, '$.vms') AS vm
        WHERE snapshot.organization_id = ?2
          AND json_extract(vm.value, '$.imageKeyJson.arch') IS NOT NULL`,
  ).all<{ scenario_id: string; arch: ImageArchitecture }>();
  // The family locks a live publish and a rollback take, over every family a
  // pointer or a rollback snapshot names, so neither can write the scope's
  // pointers back between the read and the delete. The scope key, which no
  // scenario id can be, serializes overlapping purges of the scope.
  await withImageBuildCoordinationLocks(
    drizzle(d1),
    [
      { scenarioId: scopeKey, arch: "x86_64" },
      ...families.map((family) => ({ scenarioId: family.scenario_id, arch: family.arch })),
    ],
    async () => {
      // The objects go before the rows that name them, so a purge cut off in
      // between reads the same keys again. R2 deletes take at most 1000 keys.
      // The marker is still set, so no reconnect writes under these keys.
      const { results: keys } = await bind(
        `SELECT r2_key AS key FROM image_build_bundles WHERE organization_id = ?2
          UNION SELECT log_r2_key FROM image_builds
            WHERE organization_id = ?2 AND log_r2_key IS NOT NULL`,
      ).all<{ key: string }>();
      for (let offset = 0; offset < keys.length; offset += 1000) {
        await env.VM_IMAGE_REGISTRY_BUCKET.delete(
          keys.slice(offset, offset + 1000).map((row) => row.key),
        );
      }
      // The assignment delete reads the scenarios, so it runs before them.
      // The commits cascade with the binding. The registry sweep reclaims the
      // unreferenced images.
      await d1.batch([
        bind(`DELETE FROM course_unit_completions WHERE scope_key = ?1 AND ${PURGING}`),
        bind(`DELETE FROM scenario_assignments WHERE organization_id = ?2
          AND scenario_id IN (${ORG_SCENARIOS}) AND ${PURGING}`),
        bind(`DELETE FROM scenario_catalog_candidates WHERE organization_id = ?2 AND ${PURGING}`),
        bind(`DELETE FROM scenario_catalog_snapshots WHERE organization_id = ?2 AND ${PURGING}`),
        bind(`DELETE FROM image_builds WHERE organization_id = ?2 AND ${PURGING}`),
        bind(`DELETE FROM image_build_bundles WHERE organization_id = ?2 AND ${PURGING}`),
        bind(`DELETE FROM vm_scenarios WHERE organization_id = ?2 AND ${PURGING}`),
        bind(`DELETE FROM scenario_sources WHERE scope_key = ?1 AND ${PURGING}
          AND NOT EXISTS (${ORG_SCENARIOS})`),
      ]);
    },
  );
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
          OR EXISTS (SELECT 1 FROM image_builds WHERE organization_id = ?2
            AND status IN ('assigned', 'building')) AS deploying`,
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
