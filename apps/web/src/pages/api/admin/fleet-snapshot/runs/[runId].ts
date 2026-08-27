import type { APIRoute } from "astro";
import { jsonResponse, requireAdminUserContext } from "@/lib/agent-bridge";
import { loadAdminFleetArchivedRunDetail } from "@/lib/admin-fleet-snapshot";
import { toErrorResponse } from "@/lib/app-error";

export const prerender = false;

const PRIVATE_NO_STORE_HEADERS = {
  "cache-control": "private, no-store",
};

/** Rich archive metadata is intentionally demand-loaded after a card opens. */
export const GET: APIRoute = async ({ request, params, url }) => {
  try {
    const authz = await requireAdminUserContext(request);
    if (!authz.ok) {
      return privateNoStore(authz.response);
    }

    const runId = params.runId?.trim() ?? "";
    if (!runId) {
      return jsonResponse(
        { error: "runId is required" },
        { status: 400, headers: PRIVATE_NO_STORE_HEADERS },
      );
    }

    const hostId = url.searchParams.get("hostId")?.trim() || null;
    const run = await loadAdminFleetArchivedRunDetail({
      userId: authz.context.userId,
      runId,
      hostId,
    });
    if (!run) {
      return jsonResponse(
        { error: "archived run not found" },
        { status: 404, headers: PRIVATE_NO_STORE_HEADERS },
      );
    }

    return jsonResponse({ run }, { headers: PRIVATE_NO_STORE_HEADERS });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to load archived run detail",
    );
    return jsonResponse(body, { status, headers: PRIVATE_NO_STORE_HEADERS });
  }
};

function privateNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
