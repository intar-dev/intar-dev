import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { listMyAssignments } from "@/lib/assignments";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  try {
    const assignments = await listMyAssignments({
      userId: authz.context.userId,
    });
    return jsonResponse({ assignments });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to list assignments",
    );
    return jsonResponse(body, { status });
  }
};
