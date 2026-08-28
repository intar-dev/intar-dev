import { and, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  scenarioCourseCatalogs,
  type ScenarioCourseCatalogCourse,
  type ScenarioCourseCatalogCredit,
  type ScenarioCourseCatalogSnapshotV1,
  vmScenarios,
} from "@/db/schema";

const PUBLIC_COURSE_CATALOG_SCOPE = "public";

export interface VisibleScenarioCourse {
  courseId: string;
  organizationId: string | null;
  title: string;
  description: string;
  scenarioIds: string[];
  credits?: ScenarioCourseCatalogCredit[];
}

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
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const [existing] = await db
      .select({
        courses: scenarioCourseCatalogs.coursesJson,
        sourceRevision: scenarioCourseCatalogs.sourceRevision,
        updatedAt: scenarioCourseCatalogs.updatedAt,
      })
      .from(scenarioCourseCatalogs)
      .where(eq(scenarioCourseCatalogs.scopeKey, scopeKey))
      .limit(1);
    const courses = mergeScenarioCourseCatalogCourses(
      existing?.courses ?? [],
      input.snapshot.courses,
    );

    if (!existing) {
      const inserted = await db
        .insert(scenarioCourseCatalogs)
        .values({
          scopeKey,
          organizationId: input.organizationId,
          coursesJson: courses,
          sourceRevision: input.sourceRevision,
          createdAt: input.nowUnixMs,
          updatedAt: input.nowUnixMs,
        })
        .onConflictDoNothing()
        .returning({ scopeKey: scenarioCourseCatalogs.scopeKey });
      if (inserted.length) return;
      continue;
    }

    const encodedExistingCourses = JSON.stringify(existing.courses);
    if (encodedExistingCourses === JSON.stringify(courses)) {
      return;
    }

    const updated = await db
      .update(scenarioCourseCatalogs)
      .set({
        coursesJson: courses,
        sourceRevision: input.sourceRevision,
        updatedAt: Math.max(input.nowUnixMs, existing.updatedAt + 1),
      })
      .where(
        and(
          eq(scenarioCourseCatalogs.scopeKey, scopeKey),
          eq(scenarioCourseCatalogs.sourceRevision, existing.sourceRevision),
          eq(scenarioCourseCatalogs.updatedAt, existing.updatedAt),
          sql`${scenarioCourseCatalogs.coursesJson} = ${encodedExistingCourses}`,
        ),
      )
      .returning({ scopeKey: scenarioCourseCatalogs.scopeKey });
    if (updated.length) return;
  }
  throw new Error("course catalog update did not converge");
}

/**
 * Course manifests arrive independently.  Preserve old course order and
 * append new IDs, while making incoming membership authoritative so a
 * scenario cannot remain in an older course after it moves to a new one.
 */
export function mergeScenarioCourseCatalogCourses(
  existing: readonly ScenarioCourseCatalogCourse[],
  incoming: readonly ScenarioCourseCatalogCourse[],
): ScenarioCourseCatalogCourse[] {
  const incomingById = new Map(
    incoming.map((course) => [course.courseId, cloneCourse(course)]),
  );
  const incomingScenarioIds = new Set(
    incoming.flatMap((course) => course.scenarioIds),
  );
  const merged: ScenarioCourseCatalogCourse[] = [];
  const emittedCourseIds = new Set<string>();

  for (const existingCourse of existing) {
    const replacement = incomingById.get(existingCourse.courseId);
    if (replacement) {
      merged.push(replacement);
      emittedCourseIds.add(replacement.courseId);
      continue;
    }

    const retainedScenarioIds = existingCourse.scenarioIds.filter(
      (scenarioId) => !incomingScenarioIds.has(scenarioId),
    );
    if (!retainedScenarioIds.length) continue;
    merged.push({ ...cloneCourse(existingCourse), scenarioIds: retainedScenarioIds });
    emittedCourseIds.add(existingCourse.courseId);
  }

  for (const incomingCourse of incoming) {
    if (emittedCourseIds.has(incomingCourse.courseId)) continue;
    merged.push(cloneCourse(incomingCourse));
    emittedCourseIds.add(incomingCourse.courseId);
  }

  return merged;
}

function cloneCourse(
  course: ScenarioCourseCatalogCourse,
): ScenarioCourseCatalogCourse {
  return {
    courseId: course.courseId,
    title: course.title,
    description: course.description,
    scenarioIds: [...course.scenarioIds],
    ...(course.credits === undefined
      ? {}
      : { credits: course.credits.map((credit) => ({ ...credit })) }),
  };
}

export async function listVisibleScenarioCourses(
  db: DrizzleD1Database,
  input: {
    organizationId: string | null;
    scenarios: Array<{ scenarioId: string; organizationId: string | null }>;
  },
): Promise<VisibleScenarioCourse[]> {
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
      ? projectVisibleCourses(publicRow, availableIds, organizationMembership)
      : []),
    ...(organizationRow
      ? projectVisibleCourses(organizationRow, availableIds, new Set())
      : []),
  ];
}

function projectVisibleCourses(
  row: {
    organizationId: string | null;
    courses: ScenarioCourseCatalogCourse[];
  },
  availableIds: Set<string>,
  excludedIds: Set<string>,
): VisibleScenarioCourse[] {
  const courses: VisibleScenarioCourse[] = [];
  const claimedIds = new Set(excludedIds);
  for (const course of row.courses) {
    const scenarioIds = course.scenarioIds.filter((scenarioId) => {
      if (!availableIds.has(scenarioId) || claimedIds.has(scenarioId)) {
        return false;
      }
      claimedIds.add(scenarioId);
      return true;
    });
    if (!scenarioIds.length) continue;
    courses.push({
      courseId: course.courseId,
      organizationId: row.organizationId,
      title: course.title,
      description: course.description,
      scenarioIds,
      ...(course.credits === undefined
        ? {}
        : { credits: course.credits.map((credit) => ({ ...credit })) }),
    });
  }
  return courses;
}
