import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { count, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { member, organization, scenarioAssignments, user } from "@/db/schema";
import { jsonResponse, requireAdminUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const authz = await requireAdminUserContext(request);
  if (!authz.ok) return authz.response;
  try {
    const db = drizzle(env.DB);
    const [organizations, memberCounts, assignmentCounts, owners] =
      await Promise.all([
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

    const membersByOrganization = new Map(
      memberCounts.map((row) => [row.organizationId, row.members]),
    );
    const assignmentsByOrganization = new Map(
      assignmentCounts.map((row) => [row.organizationId, row.assignments]),
    );
    const ownerByOrganization = new Map(
      owners.map((row) => [
        row.organizationId,
        { name: row.ownerName, username: row.ownerUsername },
      ]),
    );
    return jsonResponse({
      organizations: organizations.map((entry) => ({
        id: entry.id,
        name: entry.name,
        slug: entry.slug,
        createdAt: entry.createdAt.getTime(),
        memberCount: membersByOrganization.get(entry.id) ?? 0,
        assignmentCount: assignmentsByOrganization.get(entry.id) ?? 0,
        owner: ownerByOrganization.get(entry.id) ?? null,
      })),
    });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to list organizations",
    );
    return jsonResponse(body, { status });
  }
};
