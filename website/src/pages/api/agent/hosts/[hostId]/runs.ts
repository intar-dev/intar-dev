import type { APIRoute } from "astro";
import {
  jsonResponse,
  loadHostForUser,
  requireAdminUserContext,
} from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { loadDashboardHostRuns } from "@/lib/dashboard-host";
import { startScenarioRunForUserOnHost } from "@/lib/scenario-runs";

interface CreateHostRunBody {
  scenarioId?: unknown;
}

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

export const POST: APIRoute = async ({ request, params }) => {
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
  if (host.disabled) {
    return jsonResponse({ error: "host is disabled" }, { status: 403 });
  }

  let body: CreateHostRunBody;
  try {
    body = (await request.json()) as CreateHostRunBody;
  } catch {
    return jsonResponse({ error: "invalid json body" }, { status: 400 });
  }

  const scenarioId =
    typeof body.scenarioId === "string" ? body.scenarioId.trim() : "";
  if (!scenarioId) {
    return jsonResponse({ error: "scenarioId is required" }, { status: 400 });
  }

  try {
    const result = await startScenarioRunForUserOnHost({
      scenarioId,
      hostId,
      userId: authz.context.userId,
    });
    return jsonResponse(result, { status: 202 });
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to start scenario");
    return jsonResponse(body, { status });
  }
};
