import { inArray, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  scenarioCourseCatalogs,
  type ScenarioCourseCatalogSnapshotV1,
  vmScenarios,
} from "@/db/schema";
import type { ScenarioCourseWireEntry } from "@/lib/scenario-runs/types";

const PUBLIC_COURSE_CATALOG_SCOPE = "public";

export interface CourseCatalogReferenceValidation {
  ok: boolean;
  invalidScenarioIds: string[];
}

export function scenarioCourseCatalogScopeKey(
  organizationId: string | null,
): string {
  return organizationId
    ? `organization:${organizationId}`
    : PUBLIC_COURSE_CATALOG_SCOPE;
}

export async function validateScenarioCourseCatalogReferences(
  db: DrizzleD1Database,
  input: {
    snapshot: ScenarioCourseCatalogSnapshotV1;
    bundleScenarioIds: Iterable<string>;
    organizationId: string | null;
  },
): Promise<CourseCatalogReferenceValidation> {
  const referencedIds = [
    ...new Set(input.snapshot.courses.flatMap((course) => course.scenarioIds)),
  ];
  if (!referencedIds.length) {
    return { ok: true, invalidScenarioIds: [] };
  }

  // Load disabled rows too: they cannot authorize a reference, but an existing
  // row in another scope must prevent bundle metadata from claiming that ID.
  const rows = await db
    .select({
      scenarioId: vmScenarios.scenarioId,
      organizationId: vmScenarios.organizationId,
      enabled: vmScenarios.enabled,
    })
    .from(vmScenarios);
  const existingById = new Map(rows.map((row) => [row.scenarioId, row]));
  const bundledIds = new Set(input.bundleScenarioIds);
  const invalidScenarioIds: string[] = [];

  for (const scenarioId of referencedIds) {
    const existing = existingById.get(scenarioId);
    const bundled = bundledIds.has(scenarioId);
    const existingIsInUploadScope =
      !existing || existing.organizationId === input.organizationId;

    if (bundled) {
      if (!existingIsInUploadScope) {
        invalidScenarioIds.push(scenarioId);
      }
      continue;
    }

    const existingIsVisible = Boolean(
      existing &&
        existing.enabled &&
        (existing.organizationId === null ||
          existing.organizationId === input.organizationId),
    );
    if (!existingIsVisible) {
      invalidScenarioIds.push(scenarioId);
    }
  }

  return {
    ok: invalidScenarioIds.length === 0,
    invalidScenarioIds,
  };
}

export async function syncScenarioCourseCatalogSnapshot(
  db: DrizzleD1Database,
  input: {
    snapshot: ScenarioCourseCatalogSnapshotV1;
    sourceRevision: string;
    organizationId: string | null;
    nowUnixMs: number;
  },
): Promise<void> {
  const scopeKey = scenarioCourseCatalogScopeKey(input.organizationId);
  const encodedCourses = JSON.stringify(input.snapshot.courses);
  await db
    .insert(scenarioCourseCatalogs)
    .values({
      scopeKey,
      organizationId: input.organizationId,
      coursesJson: input.snapshot.courses,
      sourceRevision: input.sourceRevision,
      createdAt: input.nowUnixMs,
      updatedAt: input.nowUnixMs,
    })
    .onConflictDoUpdate({
      target: scenarioCourseCatalogs.scopeKey,
      set: {
        coursesJson: input.snapshot.courses,
        sourceRevision: input.sourceRevision,
        updatedAt: input.nowUnixMs,
      },
      setWhere: sql`${scenarioCourseCatalogs.sourceRevision} <> ${input.sourceRevision} OR ${scenarioCourseCatalogs.coursesJson} <> ${encodedCourses}`,
    });
}

export async function listVisibleScenarioCourses(
  db: DrizzleD1Database,
  input: {
    organizationId: string | null;
    scenarios: Array<{ scenarioId: string; organizationId: string | null }>;
  },
): Promise<ScenarioCourseWireEntry[]> {
  const scopeKeys = [
    scenarioCourseCatalogScopeKey(null),
    ...(input.organizationId
      ? [scenarioCourseCatalogScopeKey(input.organizationId)]
      : []),
  ];
  const rows = await db
    .select({
      scopeKey: scenarioCourseCatalogs.scopeKey,
      organizationId: scenarioCourseCatalogs.organizationId,
      courses: scenarioCourseCatalogs.coursesJson,
    })
    .from(scenarioCourseCatalogs)
    .where(inArray(scenarioCourseCatalogs.scopeKey, scopeKeys));
  const rowByScope = new Map(rows.map((row) => [row.scopeKey, row]));
  const availableIds = new Set(
    input.scenarios.map((scenario) => scenario.scenarioId),
  );
  const publicRow = rowByScope.get(scenarioCourseCatalogScopeKey(null));

  if (!input.organizationId) {
    return publicRow
      ? projectVisibleCourses(publicRow, availableIds, new Set())
      : [];
  }

  const organizationRow = rowByScope.get(
    scenarioCourseCatalogScopeKey(input.organizationId),
  );
  const organizationMembership = new Set(
    (organizationRow?.courses ?? []).flatMap((course) =>
      course.scenarioIds.filter((scenarioId) => availableIds.has(scenarioId)),
    ),
  );

  return [
    ...(publicRow
      ? projectVisibleCourses(
          publicRow,
          availableIds,
          organizationMembership,
        )
      : []),
    ...(organizationRow
      ? projectVisibleCourses(organizationRow, availableIds, new Set())
      : []),
  ];
}

function projectVisibleCourses(
  row: {
    organizationId: string | null;
    courses: Array<{
      courseId: string;
      title: string;
      description: string;
      scenarioIds: string[];
    }>;
  },
  availableIds: Set<string>,
  excludedIds: Set<string>,
): ScenarioCourseWireEntry[] {
  const courses: ScenarioCourseWireEntry[] = [];
  for (const course of row.courses) {
    const scenarioIds = course.scenarioIds.filter(
      (scenarioId) =>
        availableIds.has(scenarioId) && !excludedIds.has(scenarioId),
    );
    if (!scenarioIds.length) continue;
    courses.push({
      courseId: course.courseId,
      organizationId: row.organizationId,
      title: course.title,
      description: course.description,
      scenarioIds,
    });
  }
  return courses;
}
