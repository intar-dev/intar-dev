/** Recheck access before any run content or desired VMs can be committed. */
export function admissionContentAccessCondition(parameter: number): string {
  return contentAccessCondition(name => `json_extract(?${parameter}, '$.${name}')`);
}

const currentRunFields = {
  userId: "run.user_id",
  organizationId: "run.organization_id",
  scenarioId: "run.scenario_id",
  courseScopeKey: "run.course_scope_key",
  courseId: "run.course_id",
  lectureId: "run.lecture_id",
  allowSequenceBypass: "coalesce(json_extract(run.request_scope_json, '$.allowSequenceBypass'), 0)",
  requiresAdmin: `(coalesce(json_extract(run.request_scope_json, '$.allowSequenceBypass'), 0)
    OR coalesce(json_extract(run.request_scope_json, '$.allowDrainedAdminProof'), 0))`,
};

/** Current access for a scenario_runs table aliased as run. */
export function currentScenarioRunContentAccessCondition(): string {
  return contentAccessCondition(name => currentRunFields[name]);
}

function contentAccessCondition(field: (name: keyof typeof currentRunFields) => string): string {
  const user = field("userId");
  const org = field("organizationId");
  const scenario = field("scenarioId");
  // Organization links hide the same scenario in the public catalog, just as
  // loadVisibleCourseSources does. This also applies to prerequisite lectures.
  const shadowed = (scenarioId: string) => `EXISTS (
    SELECT 1 FROM course_catalogs private_catalog,
      json_each(private_catalog.catalog_json, '$.courses') private_course,
      json_each(private_course.value, '$.lectures') private_lecture
    WHERE private_catalog.organization_id = ${org}
      AND json_extract(private_lecture.value, '$.scenarioId') = ${scenarioId})`;
  return `(${field("requiresAdmin")} = 0 OR EXISTS (
      SELECT 1 FROM user administrator WHERE administrator.id = ${user}
        AND administrator.deleted_at IS NULL
        AND coalesce(administrator.banned, 0) = 0
        AND instr(',' || replace(lower(coalesce(administrator.role, '')), ' ', '') || ',', ',admin,') > 0))
    AND (${org} IS NULL OR EXISTS (SELECT 1 FROM member membership
      WHERE membership.user_id = ${user} AND membership.organization_id = ${org}))
    AND EXISTS (SELECT 1 FROM vm_scenarios scenario
      WHERE scenario.scenario_id = ${scenario} AND scenario.enabled = 1
        AND scenario.enabled_at IS NOT NULL
        AND (scenario.organization_id IS NULL OR scenario.organization_id = ${org}))
    AND EXISTS (SELECT 1 FROM course_catalogs catalog,
        json_each(catalog.catalog_json, '$.courses') course,
        json_each(course.value, '$.lectures') lecture
      WHERE catalog.scope_key = ${field("courseScopeKey")}
        AND (catalog.organization_id IS NULL OR catalog.organization_id = ${org})
        AND json_extract(catalog.catalog_json, '$.version') = 2
        AND json_extract(course.value, '$.courseId') = ${field("courseId")}
        AND json_extract(lecture.value, '$.lectureId') = ${field("lectureId")}
        AND json_extract(lecture.value, '$.scenarioId') = ${scenario}
        AND (catalog.organization_id IS NOT NULL OR NOT ${shadowed(scenario)})
        AND (${field("allowSequenceBypass")} = 1
          OR json_extract(course.value, '$.sequential') = 0
          OR EXISTS (SELECT 1 FROM course_unit_completions completed
            WHERE completed.user_id = ${user} AND completed.scope_key = catalog.scope_key
              AND completed.course_id = ${field("courseId")}
              AND completed.lecture_id = ${field("lectureId")})
          OR NOT EXISTS (SELECT 1 FROM json_each(course.value, '$.lectures') prior
            WHERE CAST(prior.key AS INTEGER) < CAST(lecture.key AS INTEGER)
              AND (catalog.organization_id IS NOT NULL OR NOT ${shadowed("json_extract(prior.value, '$.scenarioId')")})
              AND NOT EXISTS (SELECT 1 FROM course_unit_completions completed
                WHERE completed.user_id = ${user} AND completed.scope_key = catalog.scope_key
                  AND completed.course_id = ${field("courseId")}
                  AND completed.lecture_id = json_extract(prior.value, '$.lectureId')))))`;
}
