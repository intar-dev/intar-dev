import { IMAGE_FORMAT } from "@/generated/constants";
import type { ImageProducer } from "@/db/schema/scenarios";
import { REVISION_REPLACED, settleScenarioRevisions } from "@/lib/machine-builds";

/**
 * The revisions of a source whose images its own pipeline builds (#441).
 * No builder works on them, so nothing but this module ends one that never
 * gets its images: the source's tick settles, fails what a newer publish
 * replaced, and fails what waited longer than the deadline.
 */

/** How long a revision waits for its pipeline's images. */
export const PIPELINE_REVISION_DEADLINE_MS = 24 * 60 * 60 * 1000;
export const REVISION_PIPELINE_DEADLINE =
  "The publish pipeline did not push every image of this scenario in time. Re-run the workflow.";
export const REVISION_SOURCE_DISCONNECTED =
  "The scenario source was disconnected before the images of this revision were pushed.";

/**
 * The architectures a pipeline is asked to build. A constant for now; a
 * per-source or per-lab choice changes only this.
 */
export function pipelineArchitectures(): Array<"amd64" | "arm64"> {
  return ["amd64", "arm64"];
}

/** The revs of the scope `scope` (a `?n`) whose bundle is stamped `pipeline`. */
const pipelineRevs = (scope: string) =>
  `(SELECT rev FROM bundles WHERE scope_key = ${scope} AND image_producer = 'pipeline')`;

/**
 * One pass over a scope's building pipeline revisions. It first settles
 * them, for a result whose own settle never ran. Then, in one transaction,
 * it fails each that is no longer its scenario's newest and each created
 * more than the deadline ago, and fails a `building` commit row whose
 * revisions ended on the deadline and of which none still builds.
 */
export async function maintainPipelineRevisions(
  env: Parameters<typeof settleScenarioRevisions>[0],
  scopeKey: string,
  now: number,
): Promise<void> {
  const cutoff = now - PIPELINE_REVISION_DEADLINE_MS;
  // Nearly always nothing, and nothing for a builder source.
  const { results: building } = await env.DB.prepare(
    `SELECT revision.rev, MIN(revision.created_at) AS oldest FROM scenario_revisions revision
      WHERE revision.state = 'building' AND revision.rev IN ${pipelineRevs("?1")}
      GROUP BY revision.rev`,
  ).bind(scopeKey).all<{ rev: string; oldest: number }>();
  if (!building.length) return;
  for (const { rev } of building) await settleScenarioRevisions(env, { rev });

  // What the commit row says is missing; the batch below decides by itself
  // what fails.
  const { results: late } = await env.DB.prepare(
    `SELECT revision.rev, revision.scenario_id || '/' || json_extract(machine.value, '$.name') AS machine
       FROM scenario_revisions revision, json_each(revision.doc_json, '$.machines') machine
      WHERE revision.state = 'building' AND revision.created_at <= ?2 AND revision.rev IN ${pipelineRevs("?1")}
        AND NOT EXISTS (SELECT 1 FROM scope_machine_images image
          JOIN registry_manifests manifest ON manifest.digest = image.image_digest
          WHERE image.scope_key = ?1 AND image.architecture = 'amd64' AND image.image_format = ?3
            AND image.build_key = json_extract(machine.value, '$.build_key'))
      ORDER BY machine LIMIT 200`,
  ).bind(scopeKey, cutoff, IMAGE_FORMAT).all<{ rev: string; machine: string }>();
  const missing = new Map<string, string[]>();
  for (const { rev, machine } of late) missing.set(rev, [...(missing.get(rev) ?? []), `${machine} (amd64)`]);

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE scenario_revisions SET state = 'failed', failure_reason = ?2
        WHERE state = 'building' AND rev IN ${pipelineRevs("?1")}
          AND EXISTS (SELECT 1 FROM scenario_revisions newer WHERE newer.scenario_id = scenario_revisions.scenario_id
            AND (newer.created_at > scenario_revisions.created_at
              OR (newer.created_at = scenario_revisions.created_at AND newer.rev > scenario_revisions.rev)))`,
    ).bind(scopeKey, REVISION_REPLACED),
    env.DB.prepare(
      `UPDATE scenario_revisions SET state = 'failed', failure_reason = ?2
        WHERE state = 'building' AND created_at <= ?3 AND rev IN ${pipelineRevs("?1")}`,
    ).bind(scopeKey, REVISION_PIPELINE_DEADLINE, cutoff),
    ...building.map(({ rev }) =>
      env.DB.prepare(
        `UPDATE scenario_source_commits SET state = 'failed', detail = ?4, updated_at = ?5
          WHERE scope_key = ?1 AND rev = ?2 AND purpose = 'deploy' AND state = 'building'
            AND EXISTS (SELECT 1 FROM scenario_revisions ended
              WHERE ended.rev = ?2 AND ended.state = 'failed' AND ended.failure_reason = ?3)
            AND NOT EXISTS (SELECT 1 FROM scenario_revisions waiting
              WHERE waiting.rev = ?2 AND waiting.state = 'building')
            -- An automatic source's job decides its row: other labs of the
            -- commit may still be checked (#454).
            AND NOT EXISTS (SELECT 1 FROM scenario_sources source
              WHERE source.scope_key = ?1 AND source.promotion = 'automatic')`,
      ).bind(
        scopeKey,
        rev,
        REVISION_PIPELINE_DEADLINE,
        `${REVISION_PIPELINE_DEADLINE}${missing.has(rev) ? ` Missing: ${missing.get(rev)!.slice(0, 20).join(", ")}.` : ""}`,
        now,
      ),
    ),
  ]);
}

export interface PipelinePlan {
  architectures: Array<"amd64" | "arm64">;
  missing: Array<{ build_key: string; architecture: "amd64" | "arm64" }>;
}

/**
 * What a pipeline has to build for `keys`: each key in each architecture,
 * less what the scope has recorded in the current image format and whose
 * manifest is still stored.
 */
export async function pipelinePlan(
  env: { DB: D1Database },
  scopeKey: string,
  keys: readonly string[],
): Promise<PipelinePlan> {
  const architectures = pipelineArchitectures();
  const wanted = [...new Set(keys)].sort();
  const { results } = await env.DB.prepare(
    `SELECT image.build_key, image.architecture FROM scope_machine_images image
       JOIN registry_manifests manifest ON manifest.digest = image.image_digest
      WHERE image.scope_key = ?1 AND image.image_format = ?2
        AND image.build_key IN (SELECT value FROM json_each(?3))`,
  ).bind(scopeKey, IMAGE_FORMAT, JSON.stringify(wanted)).all<{ build_key: string; architecture: string }>();
  const recorded = new Set(results.map((image) => `${image.build_key} ${image.architecture}`));
  return {
    architectures,
    missing: wanted.flatMap((key) =>
      architectures
        .filter((architecture) => !recorded.has(`${key} ${architecture}`))
        .map((architecture) => ({ build_key: key, architecture })),
    ),
  };
}

/** The machine build keys of the revisions of `rev` in a scope, as ingest wrote them. */
export async function revisionBuildKeys(env: { DB: D1Database }, scopeKey: string, rev: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT json_extract(machine.value, '$.build_key') AS key
       FROM scenario_revisions revision
       JOIN scenarios scenario ON scenario.id = revision.scenario_id AND scenario.scope_key = ?1,
            json_each(revision.doc_json, '$.machines') machine
      WHERE revision.rev = ?2`,
  ).bind(scopeKey, rev).all<{ key: string }>();
  return results.map((row) => row.key);
}

/** The producer in force for a rev: its bundle's stamp once it has one, else the source's setting. */
export async function producerInForce(
  env: { DB: D1Database },
  scopeKey: string,
  rev: string,
  setting: ImageProducer,
): Promise<{ producer: ImageProducer; stamped: boolean }> {
  const stamp = await env.DB.prepare("SELECT image_producer FROM bundles WHERE rev = ?1 AND scope_key = ?2")
    .bind(rev, scopeKey).first<ImageProducer>("image_producer");
  return { producer: stamp ?? setting, stamped: stamp !== null };
}
