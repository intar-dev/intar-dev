import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { completePureCourseLectureForUser } from "@/lib/course-catalogs";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
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
    const detail = await completePureCourseLectureForUser({
      db: drizzle(env.DB),
      userId: authz.context.userId,
      organizationId: null,
      courseId,
      lectureId,
      nowUnixMs: Date.now(),
      allowSequenceBypass: authz.context.isAdmin,
    });
    return jsonResponse(detail);
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to complete lecture",
    );
    return jsonResponse(body, { status });
  }
};
