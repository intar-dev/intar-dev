import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { resolveCourseLectureForScenario } from "@/lib/scenario-course-catalogs";
import { isSafeScenarioId } from "@/lib/scenario-id";
import { loadEnabledScenarioForUser } from "@/lib/scenario-runs";
import { resolveOrganizationId } from "@/lib/organizations";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  const scenarioId = params.scenarioId?.trim() ?? "";
  if (!scenarioId) {
    return jsonResponse({ error: "scenarioId is required" }, { status: 400 });
  }
  if (!isSafeScenarioId(scenarioId)) {
    return jsonResponse({ error: "invalid scenarioId" }, { status: 400 });
  }

  const organizationKey =
    new URL(request.url).searchParams.get("organizationId")?.trim() || null;
  const organizationId = organizationKey
    ? await resolveOrganizationId(organizationKey)
    : null;
  if (
    (organizationKey && !organizationId) ||
    (organizationId && !authz.context.organizationIds.includes(organizationId))
  ) {
    return jsonResponse({ error: "scenario not found" }, { status: 404 });
  }

  try {
    // The old scenario detail route must not leak a lecture body around the
    // V2 course gate. The route remains for technical clients; learner UI uses
    // the dedicated lecture endpoint.
    const courseLecture = await resolveCourseLectureForScenario({
      db: drizzle(env.DB),
      userId: authz.context.userId,
      organizationId,
      scenarioId,
      ...(authz.context.isAdmin ? { allowSequenceBypass: true } : {}),
    });
    if (!courseLecture) {
      return jsonResponse({ error: "scenario not found" }, { status: 404 });
    }
    if (courseLecture.state === "locked") {
      return jsonResponse(
        {
          error: "complete the required lecture first",
          code: "course_lecture_locked",
          blockedBy: courseLecture.blockedBy,
        },
        { status: 409 },
      );
    }
    if (!courseLecture.scenarioReady) {
      return jsonResponse(
        {
          error: "scenario image is not ready",
          code: "course_scenario_waiting",
        },
        { status: 409 },
      );
    }

    const scenario = await loadEnabledScenarioForUser({
      scenarioId,
      userId: authz.context.userId,
      organizationId,
      ...(authz.context.isAdmin ? { allowSequenceBypass: true } : {}),
    });
    if (!scenario) {
      return jsonResponse({ error: "scenario not found" }, { status: 404 });
    }

    return jsonResponse({ scenario });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to load scenario",
    );
    return jsonResponse(body, { status });
  }
};
