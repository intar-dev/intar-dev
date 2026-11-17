import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { listAdministeredMachineBuilds } from "@/lib/scenario-revisions";

export const prerender = false;

// Platform admins read every build; organization owners and admins their bundles' builds.
export const GET: APIRoute = async ({ request }) => {
  try {
    const authz = await requireUserContext(request);
    if (!authz.ok) return authz.response;
    return jsonResponse({ builds: await listAdministeredMachineBuilds(authz.context.userId) });
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to list builds");
    return jsonResponse(body, { status });
  }
};
