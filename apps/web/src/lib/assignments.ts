import { env } from "cloudflare:workers";
import { and, desc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { member, organization, scenarioAssignments } from "@/db/schema";
import { appError } from "@/lib/app-error";
import { findScenarioCourseLocation } from "@/lib/course-location";
import { createAppId } from "@/lib/id";
import { listEnabledScenariosForUser } from "@/lib/scenario-runs";
import { listScenarioCatalogForUser } from "@/lib/scenario-runs/catalog";
import type { CourseLocation } from "@/lib/scenario-runs";
import { requireOrganizationRole } from "@/lib/organizations";

export interface OrganizationAssignmentRecord {
  id: string;
  scenarioId: string;
  scenarioTitle: string | null;
  createdAt: number;
}

export interface MyAssignment {
  assignmentId: string;
  scenarioId: string;
  scenarioTitle: string | null;
  organizationId: string;
  organizationName: string;
  assignedAt: number;
  courseLocation: CourseLocation | null;
}

async function scenarioTitleMap(
  organizationId: string,
): Promise<Map<string, string>> {
  const scenarios = await listEnabledScenariosForUser({ organizationId });
  return new Map(scenarios.map((entry) => [entry.scenarioId, entry.title]));
}

export async function listOrganizationAssignments(params: {
  organizationId: string;
  userId: string;
}): Promise<OrganizationAssignmentRecord[]> {
  await requireOrganizationRole(params);
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(scenarioAssignments)
    .where(eq(scenarioAssignments.organizationId, params.organizationId))
    .orderBy(desc(scenarioAssignments.createdAt));

  const titles = await scenarioTitleMap(params.organizationId);
  return rows.map((row) => ({
    id: row.id,
    scenarioId: row.scenarioId,
    scenarioTitle: titles.get(row.scenarioId) ?? null,
    createdAt: row.createdAt,
  }));
}

export async function assignScenarioToOrganization(params: {
  organizationId: string;
  scenarioId: string;
  actorUserId: string;
}): Promise<OrganizationAssignmentRecord> {
  await requireOrganizationRole({
    organizationId: params.organizationId,
    userId: params.actorUserId,
    admin: true,
  });

  const titles = await scenarioTitleMap(params.organizationId);
  const scenarioTitle = titles.get(params.scenarioId);
  if (!scenarioTitle) {
    throw appError(404, "scenario_not_found", "scenario is not enabled");
  }

  const db = drizzle(env.DB);
  const id = createAppId();
  const inserted = await db
    .insert(scenarioAssignments)
    .values({
      id,
      organizationId: params.organizationId,
      scenarioId: params.scenarioId,
      assignedBy: params.actorUserId,
    })
    .onConflictDoNothing()
    .returning({
      id: scenarioAssignments.id,
      createdAt: scenarioAssignments.createdAt,
    });
  const assignment =
    inserted[0] ??
    (
      await db
        .select({
          id: scenarioAssignments.id,
          createdAt: scenarioAssignments.createdAt,
        })
        .from(scenarioAssignments)
        .where(
          and(
            eq(scenarioAssignments.organizationId, params.organizationId),
            eq(scenarioAssignments.scenarioId, params.scenarioId),
          ),
        )
        .limit(1)
    )[0];
  if (!assignment) {
    throw appError(
      500,
      "assignment_create_failed",
      "failed to create assignment",
    );
  }

  return {
    id: assignment.id,
    scenarioId: params.scenarioId,
    scenarioTitle,
    createdAt: assignment.createdAt,
  };
}

export async function unassignScenarioFromOrganization(params: {
  organizationId: string;
  assignmentId: string;
  actorUserId: string;
}): Promise<void> {
  await requireOrganizationRole({
    organizationId: params.organizationId,
    userId: params.actorUserId,
    admin: true,
  });

  const db = drizzle(env.DB);
  await db
    .delete(scenarioAssignments)
    .where(
      and(
        eq(scenarioAssignments.id, params.assignmentId),
        eq(scenarioAssignments.organizationId, params.organizationId),
      ),
    );
}

// Learner view: assignments across every organization the user belongs to.
export async function listMyAssignments(params: {
  userId: string;
}): Promise<MyAssignment[]> {
  const db = drizzle(env.DB);
  const memberships = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, params.userId));
  if (!memberships.length) return [];

  const rows = await db
    .select({
      assignmentId: scenarioAssignments.id,
      scenarioId: scenarioAssignments.scenarioId,
      organizationId: scenarioAssignments.organizationId,
      organizationName: organization.name,
      assignedAt: scenarioAssignments.createdAt,
    })
    .from(scenarioAssignments)
    .innerJoin(
      organization,
      eq(scenarioAssignments.organizationId, organization.id),
    )
    .where(
      inArray(
        scenarioAssignments.organizationId,
        memberships.map((row) => row.organizationId),
      ),
    )
    .orderBy(desc(scenarioAssignments.createdAt));

  const catalogsByOrganization = new Map(
    await Promise.all(
      [...new Set(rows.map((row) => row.organizationId))].map(
        async (organizationId) => {
          const catalog = await listScenarioCatalogForUser(
            params.userId,
            organizationId,
          );
          return [organizationId, catalog.courses] as const;
        },
      ),
    ),
  );
  return rows.map((row) => ({
    ...row,
    scenarioTitle:
      catalogsByOrganization
        .get(row.organizationId)
        ?.flatMap((course) => course.scenarios)
        .find((scenario) => scenario.scenarioId === row.scenarioId)?.title ??
      null,
    courseLocation: findScenarioCourseLocation(
      catalogsByOrganization.get(row.organizationId) ?? [],
      row.scenarioId,
      row.organizationId,
    ),
  }));
}
