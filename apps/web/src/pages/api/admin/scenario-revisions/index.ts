import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { listAdministeredScenarios } from "@/lib/scenario-revisions";

export const prerender = false;

// Platform admins read every scope; organization owners and admins their own.
export const GET: APIRoute = async ({ request }) => {
  try {
    const authz = await requireUserContext(request);
    if (!authz.ok) return authz.response;
    return jsonResponse({ scenarios: await listAdministeredScenarios(authz.context.userId) });
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to list scenarios");
    return jsonResponse(body, { status });
  }
};
