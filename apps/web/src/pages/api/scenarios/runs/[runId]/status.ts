import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { getScenarioRunStatusForUser } from "@/lib/scenario-runs/status";

export const prerender = false;

const PRIVATE_STATUS_HEADERS = {
  "cache-control": "private, no-store",
};

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return privateStatusResponse(authz.response);

  const runId = params.runId?.trim() ?? "";
  if (!runId) {
    return jsonResponse(
      { error: "runId is required" },
      { status: 400, headers: PRIVATE_STATUS_HEADERS },
    );
  }

  try {
    const status = await getScenarioRunStatusForUser({
      runId,
      userId: authz.context.userId,
    });
    const version = new URL(request.url).searchParams.get("version");
    if (version && version === status.version) {
      return new Response(null, { status: 204, headers: PRIVATE_STATUS_HEADERS });
    }
    return jsonResponse({ status }, { headers: PRIVATE_STATUS_HEADERS });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to load scenario run status",
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
