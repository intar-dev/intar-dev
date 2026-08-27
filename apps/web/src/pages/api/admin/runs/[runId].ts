import type { APIRoute } from "astro";
import { jsonResponse, requireAdminUserContext } from "@/lib/agent-bridge";
import { loadAdminArchivedRunDetail } from "@/lib/admin-fleet-snapshot";
import { toErrorResponse } from "@/lib/app-error";
import { deleteFinishedScenarioRunForAdmin } from "@/lib/scenario-runs";

export const prerender = false;

const PRIVATE_NO_STORE_HEADERS = {
  "cache-control": "private, no-store",
};

export const GET: APIRoute = async ({ request, params }) => {
  try {
    const authz = await requireAdminUserContext(request);
    if (!authz.ok) return privateNoStore(authz.response);

    const runId = params.runId?.trim() ?? "";
    if (!runId) return badRunId();

    const run = await loadAdminArchivedRunDetail({ runId });
    if (!run) return runNotFound();
    return jsonResponse({ run }, { headers: PRIVATE_NO_STORE_HEADERS });
  } catch (error) {
    return errorResponse(error, "failed to load archived run detail");
  }
};

export const DELETE: APIRoute = async ({ request, params }) => {
  try {
    const authz = await requireAdminUserContext(request);
    if (!authz.ok) return privateNoStore(authz.response);

    const runId = params.runId?.trim() ?? "";
    if (!runId) return badRunId();

    const run = await loadAdminArchivedRunDetail({ runId });
    if (!run) return runNotFound();
    await deleteFinishedScenarioRunForAdmin({
      runId,
      actorUserId: authz.context.userId,
    });
    return new Response(null, {
      status: 204,
      headers: PRIVATE_NO_STORE_HEADERS,
    });
  } catch (error) {
    return errorResponse(error, "failed to delete archived run");
  }
};

function badRunId() {
  return jsonResponse(
    { error: "runId is required" },
    { status: 400, headers: PRIVATE_NO_STORE_HEADERS },
  );
}

function runNotFound() {
  return jsonResponse(
    { error: "archived run not found" },
    { status: 404, headers: PRIVATE_NO_STORE_HEADERS },
  );
}

function errorResponse(error: unknown, fallback: string) {
  const { status, body } = toErrorResponse(error, fallback);
  return jsonResponse(body, {
    status,
    headers: PRIVATE_NO_STORE_HEADERS,
  });
}

function privateNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
