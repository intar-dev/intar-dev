import { playableScenarioCondition } from "@/lib/scenario-runs/content-access";

/** How long a personal or organization host keeps a start's image grant. */
export const PERSONAL_IMAGE_PREPARATION_TTL_MS = 15 * 60_000;

// SQL identifiers here are fixed server text. Use the same live access fence
// for issuing a grant, reconciling its cache, and reading registry content.
export function preparationAuthoritySql(): string {
  const field = (name: string) => `json_extract(prep.access_json, '$.${name}')`;
  const shadowed = (scenario: string) => `EXISTS (SELECT 1 FROM course_catalogs hidden,
    json_each(hidden.catalog_json, '$.courses') hidden_course,
    json_each(hidden_course.value, '$.lectures') hidden_lecture
    WHERE hidden.organization_id = ${field("organizationId")}
      AND json_extract(hidden_lecture.value, '$.scenarioId') = ${scenario})`;
  // The host, its owner and the preparation itself, for every launch source.
  const hostAndOwner = `(host.id, host.role, host.disabled, host.scenario_enabled,
        host.credential_generation) = (prep.host_id, 'agent', 0, 1, prep.credential_generation)
      AND ((host.scope = 'personal' AND host.user_id = prep.user_id AND owner.metal_placement = 'personal')
        OR (host.scope = 'organization' AND host.organization_id = ${field("organizationId")}
          AND owner.metal_placement = 'platform' AND EXISTS (SELECT 1 FROM organization org
            WHERE org.id = host.organization_id AND org.metal_placement = 'organization')))
      AND (owner.deleted_at IS NULL AND coalesce(owner.banned, 0) = 0)
      AND (prep.user_id = ${field("userId")} AND prep.expires_at > CAST(unixepoch('subsecond') * 1000 AS INTEGER))
      AND NOT EXISTS (SELECT 1 FROM scenario_runs active
        WHERE active.active_key = prep.user_id OR (active.user_id = prep.user_id AND active.request_idempotency_key = prep.request_key))
      AND (${field("requiresAdmin")} = 0 OR
        instr(',' || replace(lower(coalesce(owner.role, '')), ' ', '') || ',', ',admin,') > 0)`;
  // A play start: personal, of a scenario still open to play.
  const play = `EXISTS (SELECT 1 FROM agent_hosts host
    JOIN user owner ON owner.id = prep.user_id
    JOIN scenarios played ON played.id = ${field("scenarioId")}
    WHERE ${hostAndOwner}
      AND ${field("organizationId")} IS NULL AND ${playableScenarioCondition("played")})`;
  // Small grouped predicates keep this correlated query below D1's expression
  // depth limit when image, manifest, and artifact routes add their own fences.
  return `CASE WHEN ${field("launchSource")} = 'play' THEN ${play} ELSE EXISTS (SELECT 1 FROM agent_hosts host
    JOIN user owner ON owner.id = prep.user_id
    JOIN (SELECT id AS scenario_id, organization_id FROM scenarios
        WHERE enabled = 1 AND live_rev IS NOT NULL) scenario ON scenario.scenario_id = ${field("scenarioId")}
    JOIN course_catalogs catalog ON catalog.scope_key = ${field("courseScopeKey")}
    JOIN json_each(catalog.catalog_json, '$.courses') course
    JOIN json_each(course.value, '$.lectures') lecture
    WHERE ${hostAndOwner}
      AND (${field("organizationId")} IS NULL OR EXISTS (SELECT 1 FROM member membership
        WHERE membership.user_id = prep.user_id AND membership.organization_id = ${field("organizationId")}))
      AND (scenario.organization_id IS NULL OR scenario.organization_id = ${field("organizationId")})
      AND (catalog.organization_id IS NULL OR catalog.organization_id = ${field("organizationId")})
      AND (json_extract(catalog.catalog_json, '$.version'), json_extract(course.value, '$.courseId'),
        json_extract(lecture.value, '$.lectureId'), json_extract(lecture.value, '$.scenarioId')) =
          (2, ${field("courseId")}, ${field("lectureId")}, scenario.scenario_id)
      AND (catalog.organization_id IS NOT NULL OR NOT ${shadowed("scenario.scenario_id")})
      AND (${field("allowSequenceBypass")} = 1 OR json_extract(course.value, '$.sequential') = 0
        OR EXISTS (SELECT 1 FROM course_unit_completions done WHERE done.user_id = prep.user_id
          AND (done.scope_key, done.course_id, done.lecture_id) = (catalog.scope_key, ${field("courseId")}, ${field("lectureId")}))
        OR NOT EXISTS (SELECT 1 FROM json_each(course.value, '$.lectures') prior
          WHERE CAST(prior.key AS INTEGER) < CAST(lecture.key AS INTEGER)
            AND (catalog.organization_id IS NOT NULL OR NOT ${shadowed("json_extract(prior.value, '$.scenarioId')")})
            AND NOT EXISTS (SELECT 1 FROM course_unit_completions done WHERE done.user_id = prep.user_id
              AND (done.scope_key, done.course_id, done.lecture_id) =
                (catalog.scope_key, ${field("courseId")}, json_extract(prior.value, '$.lectureId')))))) END`;
}
