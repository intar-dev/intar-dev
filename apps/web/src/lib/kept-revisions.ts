import { ACTIVE_RUNTIME_EXECUTION_STATES } from "@/db/schema";

/** How many verified revisions of a scenario stay rollback targets. */
export const KEPT_VERIFIED_REVISIONS = 3;
export const ACTIVE_EXECUTIONS = ACTIVE_RUNTIME_EXECUTION_STATES.map((state) => `'${state}'`).join(", ");

/**
 * `kept_revisions(scenario_id, rev, doc_json)`: the revisions that may still
 * be used. The mark, the revision GC and the live-revision moves all read it,
 * so a revision can only go live while the sweep keeps its images.
 */
export const KEPT_REVISIONS_CTE = `kept_revisions AS (
  SELECT revision.scenario_id, revision.rev, revision.doc_json
    FROM scenario_revisions revision
    JOIN scenarios scenario ON scenario.id = revision.scenario_id
   WHERE revision.rev = scenario.live_rev OR revision.rev = scenario.candidate_rev
      OR revision.state = 'building'
      OR (revision.state = 'verified' AND (SELECT COUNT(*) FROM scenario_revisions newer
            WHERE newer.scenario_id = revision.scenario_id AND newer.state = 'verified'
              AND (newer.created_at > revision.created_at
                OR (newer.created_at = revision.created_at AND newer.rev > revision.rev))) < ${KEPT_VERIFIED_REVISIONS})
      OR EXISTS (SELECT 1 FROM scenario_runs run
            WHERE run.scenario_id = revision.scenario_id AND run.scenario_rev = revision.rev
              AND (run.active_key IS NOT NULL OR EXISTS (SELECT 1 FROM runtime_executions execution
                WHERE execution.id = run.runtime_execution_id AND execution.state IN (${ACTIVE_EXECUTIONS})))))`;

/**
 * Holds while every machine of the revision (`scenario`, `rev`, SQL
 * expressions) names an image whose manifest row exists. The sweep deletes a
 * manifest's rows before its objects, so a row present means the image is
 * still stored.
 */
export function revisionImagesPresentSql(scenario: string, rev: string): string {
  return `NOT EXISTS (SELECT 1 FROM scenario_revisions imaged, json_each(imaged.doc_json, '$.machines') machine
    WHERE imaged.scenario_id = ${scenario} AND imaged.rev = ${rev}
      AND NOT EXISTS (SELECT 1 FROM registry_manifests manifest
        WHERE manifest.digest = json_extract(machine.value, '$.image_digest')))`;
}
