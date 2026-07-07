import { env } from "cloudflare:workers";
import { and, desc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { member, organization, scenarioAssignments } from "@/db/schema";
import { appError } from "@/lib/app-error";
import { createAppId } from "@/lib/id";
import { listEnabledScenariosForUser } from "@/lib/scenario-runs";
import { requireTeamRole } from "@/lib/teams";

export interface TeamAssignmentRecord {
  id: string;
  scenarioId: string;
  scenarioTitle: string | null;
  createdAt: number;
}

export interface MyAssignment {
  assignmentId: string;
  scenarioId: string;
  scenarioTitle: string | null;
  teamId: string;
  teamName: string;
  assignedAt: number;
}

async function scenarioTitleMap(): Promise<Map<string, string>> {
  const scenarios = await listEnabledScenariosForUser();
  return new Map(scenarios.map((entry) => [entry.scenarioId, entry.title]));
}

export async function listTeamAssignments(params: {
  organizationId: string;
  userId: string;
}): Promise<TeamAssignmentRecord[]> {
  await requireTeamRole(params);
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(scenarioAssignments)
    .where(eq(scenarioAssignments.organizationId, params.organizationId))
    .orderBy(desc(scenarioAssignments.createdAt));

  const titles = await scenarioTitleMap();
  return rows.map((row) => ({
    id: row.id,
    scenarioId: row.scenarioId,
    scenarioTitle: titles.get(row.scenarioId) ?? null,
    createdAt: row.createdAt,
  }));
}

export async function assignScenarioToTeam(params: {
  organizationId: string;
  scenarioId: string;
  actorUserId: string;
}): Promise<TeamAssignmentRecord> {
  await requireTeamRole({
    organizationId: params.organizationId,
    userId: params.actorUserId,
    instructor: true,
  });

  const titles = await scenarioTitleMap();
  const scenarioTitle = titles.get(params.scenarioId);
  if (!scenarioTitle) {
    throw appError(404, "scenario_not_found", "scenario is not enabled");
  }

  const db = drizzle(env.DB);
  const id = createAppId();
  await db
    .insert(scenarioAssignments)
    .values({
      id,
      organizationId: params.organizationId,
      scenarioId: params.scenarioId,
      assignedBy: params.actorUserId,
    })
    .onConflictDoNothing();

  return {
    id,
    scenarioId: params.scenarioId,
    scenarioTitle,
    createdAt: Date.now(),
  };
}

export async function unassignScenarioFromTeam(params: {
  organizationId: string;
  assignmentId: string;
  actorUserId: string;
}): Promise<void> {
  await requireTeamRole({
    organizationId: params.organizationId,
    userId: params.actorUserId,
    instructor: true,
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

// Learner view: assignments across every team the user belongs to.
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
      teamId: scenarioAssignments.organizationId,
      teamName: organization.name,
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

  const titles = await scenarioTitleMap();
  return rows.map((row) => ({
    ...row,
    scenarioTitle: titles.get(row.scenarioId) ?? null,
  }));
}
