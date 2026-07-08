import type { APIRoute } from "astro";
import {
  jsonResponse,
  loadHostForUser,
  requireAdminUserContext,
} from "@/lib/agent-bridge";
import { loadDashboardHostRuns } from "@/lib/dashboard-host";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireAdminUserContext(request);
  if (!authz.ok) {
    return authz.response;
  }

  const hostId = params.hostId?.trim() ?? "";
  if (!hostId) {
    return jsonResponse({ error: "hostId is required" }, { status: 400 });
  }

  const host = await loadHostForUser(hostId, authz.context.userId);
  if (!host) {
    return jsonResponse({ error: "host not found" }, { status: 404 });
  }

  const data = await loadDashboardHostRuns({
    host,
    userId: authz.context.userId,
  });
  return jsonResponse(data);
};
