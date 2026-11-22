import { ACTIVE_RUNTIME_EXECUTION_STATES } from "@/db/schema";

/**
 * How many revisions of a scenario that were live stay kept, the live one
 * among them. They are no rollback target (#494): they make a revert quick,
 * since a commit that brings a behaviour back finds its verified twin and its
 * images, and goes live without a rebuild or a new check.
 */
export const KEPT_LIVE_REVISIONS = 3;
export const ACTIVE_EXECUTIONS = ACTIVE_RUNTIME_EXECUTION_STATES.map((state) => `'${state}'`).join(", ");

/**
 * `kept_revisions(scenario_id, rev, doc_json)`: the revisions that may still
 * be used. The mark, the revision GC and the live-revision moves all read it,
 * so a revision can only go live while the sweep keeps its images.
 *
 * Besides the pointers, the building revisions and those a run started
 * from, a scenario keeps the revisions most recently made live (#454). A
 * verified revision that was never live is kept only as the candidate:
 * nothing else can promote it.
 */
export const KEPT_REVISIONS_CTE = `kept_revisions AS (
  SELECT revision.scenario_id, revision.rev, revision.doc_json
    FROM scenario_revisions revision
    JOIN scenarios scenario ON scenario.id = revision.scenario_id
   WHERE revision.rev = scenario.live_rev OR revision.rev = scenario.candidate_rev
      OR revision.state = 'building'
      OR (revision.live_at IS NOT NULL AND (SELECT COUNT(*) FROM scenario_revisions later
            WHERE later.scenario_id = revision.scenario_id AND later.live_at IS NOT NULL
              AND (later.live_at > revision.live_at
                OR (later.live_at = revision.live_at AND later.rev > revision.rev))) < ${KEPT_LIVE_REVISIONS})
      OR EXISTS (SELECT 1 FROM scenario_runs run
            WHERE run.scenario_id = revision.scenario_id AND run.scenario_rev = revision.rev
              AND (run.active_key IS NOT NULL OR EXISTS (SELECT 1 FROM runtime_executions execution
                WHERE execution.id = run.runtime_execution_id AND execution.state IN (${ACTIVE_EXECUTIONS})))))`;

/**
 * Holds while a kept revision of the image's own scope names its build key
 * (`image`, an alias of `scope_machine_images`): the images a scope's quota
 * counts. Needs `KEPT_REVISIONS_CTE`.
 */
export function imageKeptSql(image: string): string {
  return `EXISTS (SELECT 1 FROM kept_revisions kept
                    JOIN scenarios scenario ON scenario.id = kept.scenario_id,
                    json_each(kept.doc_json, '$.machines') machine
                   WHERE scenario.scope_key = ${image}.scope_key
                     AND json_extract(machine.value, '$.build_key') = ${image}.build_key)`;
}

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

/**
 * Holds while a verified revision of `scenario` and guest contract
 * `contract` behaves as `digest` says: a revision with this digest needs no
 * verify run of its own (#454).
 */
export function behaviourVerifiedSql(scenario: string, digest: string, contract: string): string {
  return `EXISTS (SELECT 1 FROM scenario_revisions twin WHERE twin.scenario_id = ${scenario}
      AND twin.behaviour_digest = ${digest} AND twin.guest_contract = ${contract} AND twin.state = 'verified')`;
}
