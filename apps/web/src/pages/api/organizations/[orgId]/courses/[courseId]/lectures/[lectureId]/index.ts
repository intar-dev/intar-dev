import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import {
  requireOrganizationRole,
  resolveOrganizationId,
} from "@/lib/organizations";
import { loadCourseLectureDetailForUser } from "@/lib/scenario-course-catalogs";

export const prerender = false;

function courseScope(request: Request): "public" | "private" | null {
  const scope = new URL(request.url).searchParams.get("scope");
  return scope === "public" || scope === "private" ? scope : null;
}

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  const selectedScope = courseScope(request);
  if (!selectedScope) {
    return jsonResponse(
      { error: "scope must be public or private" },
      { status: 400 },
    );
  }
  const organizationId = await resolveOrganizationId(params.orgId ?? "");
  if (!organizationId) {
    return jsonResponse({ error: "organization not found" }, { status: 404 });
  }
  const courseId = params.courseId?.trim() ?? "";
  const lectureId = params.lectureId?.trim() ?? "";
  if (!courseId || !lectureId) {
    return jsonResponse(
      { error: "courseId and lectureId are required" },
      { status: 400 },
    );
  }

  try {
    await requireOrganizationRole({
      organizationId,
      userId: authz.context.userId,
    });
    const result = await loadCourseLectureDetailForUser({
      db: drizzle(env.DB),
      userId: authz.context.userId,
      organizationId,
      courseId,
      lectureId,
      courseScope: selectedScope,
      allowSequenceBypass: authz.context.isAdmin,
    });
    if (!result.ok) {
      return jsonResponse(
        {
          locked: true,
          blockedBy: result.blockedBy,
        },
      );
    }
    return jsonResponse(result.detail);
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to load organization lecture",
    );
    return jsonResponse(body, { status });
  }
};
