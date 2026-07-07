import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { count, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { member, organization, scenarioAssignments, user } from "@/db/schema";
import { jsonResponse, requireAdminUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";

export const prerender = false;

// Cross-team admin view: every organization with owner, member count, and
// assignment count (instructors only ever see their own teams).
export const GET: APIRoute = async ({ request }) => {
  const authz = await requireAdminUserContext(request);
  if (!authz.ok) return authz.response;

  try {
    const db = drizzle(env.DB);
    const [orgs, memberCounts, assignmentCounts, owners] = await Promise.all([
      db
        .select({
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          createdAt: organization.createdAt,
        })
        .from(organization)
        .orderBy(desc(organization.createdAt)),
      db
        .select({ organizationId: member.organizationId, members: count() })
        .from(member)
        .groupBy(member.organizationId),
      db
        .select({
          organizationId: scenarioAssignments.organizationId,
          assignments: count(),
        })
        .from(scenarioAssignments)
        .groupBy(scenarioAssignments.organizationId),
      db
        .select({
          organizationId: member.organizationId,
          ownerName: user.name,
          ownerUsername: user.username,
        })
        .from(member)
        .innerJoin(user, eq(member.userId, user.id))
        .where(eq(member.role, "owner")),
    ]);

    const membersByOrg = new Map(
      memberCounts.map((row) => [row.organizationId, row.members]),
    );
    const assignmentsByOrg = new Map(
      assignmentCounts.map((row) => [row.organizationId, row.assignments]),
    );
    const ownerByOrg = new Map(
      owners.map((row) => [
        row.organizationId,
        { name: row.ownerName, username: row.ownerUsername },
      ]),
    );

    return jsonResponse({
      teams: orgs.map((org) => ({
        id: org.id,
        name: org.name,
        slug: org.slug,
        createdAt: org.createdAt.getTime(),
        memberCount: membersByOrg.get(org.id) ?? 0,
        assignmentCount: assignmentsByOrg.get(org.id) ?? 0,
        owner: ownerByOrg.get(org.id) ?? null,
      })),
    });
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to list teams");
    return jsonResponse(body, { status });
  }
};
