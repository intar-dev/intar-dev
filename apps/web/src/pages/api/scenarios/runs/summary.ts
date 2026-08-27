import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { getScenarioRunsSummaryForUser } from "@/lib/scenario-runs/status";

export const prerender = false;

const PRIVATE_STATUS_HEADERS = {
  "cache-control": "private, no-store",
};

export const GET: APIRoute = async ({ request }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return privateStatusResponse(authz.response);

  try {
    const summary = await getScenarioRunsSummaryForUser({
      userId: authz.context.userId,
    });
    return jsonResponse(summary, { headers: PRIVATE_STATUS_HEADERS });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to load scenario run summary",
    );
    return jsonResponse(body, { status, headers: PRIVATE_STATUS_HEADERS });
  }
};

function privateStatusResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
