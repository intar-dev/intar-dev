import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { organization } from "@/db/schema";
import { jsonResponse, requireAdminUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";

export const prerender = false;

// Admin moderation: delete any team without being a member. Cascades wipe
// members, invites and assignments; run history is user-owned and survives.
export const DELETE: APIRoute = async ({ request, params }) => {
  const authz = await requireAdminUserContext(request);
  if (!authz.ok) return authz.response;

  const orgId = params.orgId?.trim() ?? "";
  if (!orgId) {
    return jsonResponse({ error: "orgId is required" }, { status: 400 });
  }

  try {
    const db = drizzle(env.DB);
    await db.delete(organization).where(eq(organization.id, orgId));
    return new Response(null, { status: 204 });
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to delete team");
    return jsonResponse(body, { status });
  }
};
