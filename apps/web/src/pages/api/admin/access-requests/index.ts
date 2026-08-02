import type { APIRoute } from "astro";
import { jsonResponse, requireAdminUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { listAccessRequests } from "@/lib/access-requests";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const authz = await requireAdminUserContext(request);
  if (!authz.ok) return authz.response;

  try {
    const requests = await listAccessRequests();
    return jsonResponse({ requests });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to list access requests",
    );
    return jsonResponse(body, { status });
  }
};
