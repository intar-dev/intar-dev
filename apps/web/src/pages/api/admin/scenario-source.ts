import type { APIRoute } from "astro";
import { jsonResponse, requireAdminUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import {
  changeScenarioSource,
  refuseScenarioSourceWrite,
  scenarioSourceCard,
  scenarioSourceScope,
} from "@/lib/scenario-sources";

export const prerender = false;

const PUBLIC_SCOPE = scenarioSourceScope(null);

export const GET: APIRoute = async ({ request }) => {
  try {
    const authz = await requireAdminUserContext(request);
    if (!authz.ok) return authz.response;
    return jsonResponse(await scenarioSourceCard(PUBLIC_SCOPE));
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to load the public scenario source",
    );
    return jsonResponse(body, { status });
  }
};

// Every write rechecks in its statement that the caller is still an active
// platform admin.
export const POST: APIRoute = async ({ request }) => {
  const startedAt = Date.now();
  try {
    const authz = await requireAdminUserContext(request);
    if (!authz.ok) return authz.response;
    const refused = await refuseScenarioSourceWrite(request, authz.context);
    if (refused) return refused;
    const source = await changeScenarioSource({
      scope: PUBLIC_SCOPE,
      actorUserId: authz.context.userId,
      body: await request.json().catch(() => null),
      startedAt,
    });
    return jsonResponse({ source });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to change the public scenario source",
    );
    return jsonResponse(body, { status });
  }
};
