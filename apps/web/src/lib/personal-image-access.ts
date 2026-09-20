import { sql } from "drizzle-orm";
import { vmScenarios, vmScenarioVms } from "@/db/schema";

// SQL identifiers here are fixed server text. Use the same live access fence
// for issuing a grant, reconciling its cache, and reading registry content.
export function preparationAuthoritySql(): string {
  const field = (name: string) => `json_extract(prep.access_json, '$.${name}')`;
  const shadowed = (scenario: string) => `EXISTS (SELECT 1 FROM course_catalogs hidden,
    json_each(hidden.catalog_json, '$.courses') hidden_course,
    json_each(hidden_course.value, '$.lectures') hidden_lecture
    WHERE hidden.organization_id = ${field("organizationId")}
      AND json_extract(hidden_lecture.value, '$.scenarioId') = ${scenario})`;
  // Small grouped predicates keep this correlated query below D1's expression
  // depth limit when image, manifest, and artifact routes add their own fences.
  return `EXISTS (SELECT 1 FROM agent_hosts host
    JOIN user owner ON owner.id = host.user_id
    JOIN access_allowlist access ON access.user_id = owner.id
    JOIN vm_scenarios scenario ON scenario.scenario_id = ${field("scenarioId")}
    JOIN course_catalogs catalog ON catalog.scope_key = ${field("courseScopeKey")}
    JOIN json_each(catalog.catalog_json, '$.courses') course
    JOIN json_each(course.value, '$.lectures') lecture
    WHERE (host.id, host.user_id, host.scope, host.role, host.disabled, host.scenario_enabled,
        host.credential_generation) = (prep.host_id, prep.user_id, 'personal', 'agent', 0, 1, prep.credential_generation)
      AND (owner.metal_placement = 'personal' AND owner.deleted_at IS NULL AND coalesce(owner.banned, 0) = 0)
      AND (access.state, access.source_invite_id, access.source_lease_id, access.granted_at) =
        ('active', json_extract(prep.beta_json, '$.sourceInviteId'), json_extract(prep.beta_json, '$.sourceLeaseId'),
          json_extract(prep.beta_json, '$.grantedAt'))
      AND (prep.user_id = ${field("userId")} AND prep.expires_at > CAST(unixepoch('subsecond') * 1000 AS INTEGER))
      AND NOT EXISTS (SELECT 1 FROM scenario_runs active
        WHERE active.active_key = prep.user_id OR (active.user_id = prep.user_id AND active.request_idempotency_key = prep.request_key))
      AND (${field("requiresAdmin")} = 0 OR
        instr(',' || replace(lower(coalesce(owner.role, '')), ' ', '') || ',', ',admin,') > 0)
      AND (${field("organizationId")} IS NULL OR EXISTS (SELECT 1 FROM member membership
        WHERE membership.user_id = prep.user_id AND membership.organization_id = ${field("organizationId")}))
      AND (scenario.enabled = 1 AND scenario.enabled_at IS NOT NULL
        AND (scenario.organization_id IS NULL OR scenario.organization_id = ${field("organizationId")}))
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
                (catalog.scope_key, ${field("courseId")}, json_extract(prior.value, '$.lectureId'))))))`;
}

/** Correlated with vmScenarios/vmScenarioVms, just like the workload grant. */
export function personalPreparationImageAccess(hostId: string) {
  return sql`EXISTS (SELECT 1 FROM personal_image_preparations prep
    JOIN agent_hosts host ON host.id = prep.host_id AND prep.user_id = host.user_id
    JOIN json_each(prep.images_json) image
    JOIN host_desired_state desired ON desired.host_id = prep.host_id
    JOIN json_each(desired.doc_json, '$.cached_images') intent
    WHERE prep.host_id = ${hostId} AND ${sql.raw(preparationAuthoritySql())}
      AND (json_extract(desired.doc_json, '$.scope'), json_extract(desired.doc_json, '$.owner_user_id')) = ('personal', prep.user_id)
      AND json_extract(prep.access_json, '$.scenarioId') = ${vmScenarios.scenarioId}
      AND (json_extract(image.value, '$.imageSha256'), json_extract(image.value, '$.imageKey.scenario'),
        json_extract(image.value, '$.imageKey.vm'), json_extract(image.value, '$.imageKey.arch')) =
        (${vmScenarioVms.imageSha256}, json_extract(${vmScenarioVms.imageKeyJson}, '$.scenario'),
          json_extract(${vmScenarioVms.imageKeyJson}, '$.vm'), json_extract(${vmScenarioVms.imageKeyJson}, '$.arch'))
      AND (json_extract(intent.value, '$.image_id'), json_extract(intent.value, '$.image_key.scenario'),
        json_extract(intent.value, '$.image_key.vm'), json_extract(intent.value, '$.image_key.arch')) =
        (json_extract(image.value, '$.imageSha256'), json_extract(image.value, '$.imageKey.scenario'),
          json_extract(image.value, '$.imageKey.vm'), json_extract(image.value, '$.imageKey.arch')))`;
}
