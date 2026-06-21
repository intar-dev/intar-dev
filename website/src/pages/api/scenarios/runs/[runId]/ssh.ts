import type { APIRoute } from "astro";
import {
  jsonResponse,
  requireUserContext,
} from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { createScenarioSshSessionForUser } from "@/lib/scenario-runs";

interface ScenarioSshBody {
  vmId?: unknown;
  mode?: unknown;
}

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  const runId = params.runId?.trim() ?? "";
  if (!runId) {
    return jsonResponse({ error: "runId is required" }, { status: 400 });
  }

  let body: ScenarioSshBody;
  try {
    body = (await request.json()) as ScenarioSshBody;
  } catch {
    return jsonResponse({ error: "invalid json body" }, { status: 400 });
  }

  const vmId = typeof body.vmId === "string" ? body.vmId.trim() : "";
  const mode =
    body.mode === "native" || body.mode === "browser" ? body.mode : "browser";
  if (!vmId) {
    return jsonResponse({ error: "vmId is required" }, { status: 400 });
  }

  try {
    const session = await createScenarioSshSessionForUser({
      runId,
      vmId,
      userId: authz.context.userId,
      mode,
    });
    return jsonResponse(session);
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to create scenario shell",
    );
    return jsonResponse(body, { status });
  }
};
