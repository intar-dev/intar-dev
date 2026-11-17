import { playableScenarioCondition } from "@/lib/scenario-runs/content-access";
import { isRevisionScenarioId } from "@/lib/scenario-id";
import { platformHasRevisionImagesSql, readyPlatformImagesCtes } from "@/lib/scenario-runs/image-readiness";

/** What anyone may read about a scenario open to play. */
export interface PlayScenarioPublic {
  id: string;
  title: string;
  summary: string;
  difficulty: string;
  minutes: number;
  credit: string | null;
}

/** What a signed-in visitor reads in addition. */
export interface PlayScenarioSignedIn extends PlayScenarioPublic {
  tags: string[];
  briefing: string;
  /**
   * False while the reader is placed on the platform and no live platform
   * host reports the revision's images ready, so a start would be refused.
   */
  ready: boolean;
}

/**
 * The play page of `namespace/slug`, or null when no such scenario is open to
 * play with a startable live revision. Only the named fields are read from
 * the revision; a signed-out visitor gets the public ones alone.
 */
export async function loadPlayScenario(
  d1: D1Database,
  namespace: string,
  slug: string,
  /** The signed-in reader, or null. */
  userId: string | null,
): Promise<PlayScenarioPublic | PlayScenarioSignedIn | null> {
  const signedIn = userId !== null;
  const id = `${namespace}/${slug}`;
  if (!isRevisionScenarioId(id)) return null;
  const row = await d1.prepare(
    `${signedIn ? `WITH ${readyPlatformImagesCtes()}` : ""}
    SELECT scenario.id,
        json_extract(revision.doc_json, '$.title') AS title,
        json_extract(revision.doc_json, '$.summary') AS summary,
        json_extract(revision.doc_json, '$.difficulty') AS difficulty,
        json_extract(revision.doc_json, '$.minutes') AS minutes,
        json_extract(revision.doc_json, '$.credit') AS credit
        ${signedIn ? `, json_extract(revision.doc_json, '$.tags') AS tags,
        json_extract(revision.doc_json, '$.briefing') AS briefing,
        (NOT EXISTS (SELECT 1 FROM user placed WHERE placed.id = ?3 AND placed.metal_placement = 'platform')
          OR ${platformHasRevisionImagesSql("revision.doc_json")}) AS ready` : ""}
       FROM scenarios scenario
       JOIN scenario_revisions revision
         ON revision.scenario_id = scenario.id AND revision.rev = scenario.live_rev
      WHERE scenario.namespace = ?1 AND scenario.slug = ?2
        AND revision.state IN ('ready', 'verified')
        AND ${playableScenarioCondition("scenario")}`,
  ).bind(...(signedIn ? [namespace, slug, userId] : [namespace, slug])).first<Record<string, unknown>>();
  if (!row) return null;
  const view: PlayScenarioPublic = {
    id: String(row.id),
    title: String(row.title ?? ""),
    summary: String(row.summary ?? ""),
    difficulty: String(row.difficulty ?? ""),
    minutes: Number(row.minutes ?? 0),
    credit: typeof row.credit === "string" ? row.credit : null,
  };
  if (!signedIn) return view;
  const tags: unknown = JSON.parse(typeof row.tags === "string" ? row.tags : "[]");
  return {
    ...view,
    tags: Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [],
    briefing: typeof row.briefing === "string" ? row.briefing : "",
    ready: row.ready === 1,
  };
}
