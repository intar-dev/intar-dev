import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { loadCourseLectureDetailForUser } from "@/lib/course-catalogs";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  const courseId = params.courseId?.trim() ?? "";
  const lectureId = params.lectureId?.trim() ?? "";
  if (!courseId || !lectureId) {
    return jsonResponse(
      { error: "courseId and lectureId are required" },
      { status: 400 },
    );
  }

  try {
    const result = await loadCourseLectureDetailForUser({
      db: drizzle(env.DB),
      userId: authz.context.userId,
      organizationId: null,
      courseId,
      lectureId,
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
    const { status, body } = toErrorResponse(error, "failed to load lecture");
    return jsonResponse(body, { status });
  }
};
