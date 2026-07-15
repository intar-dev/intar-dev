import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { destroyScenarioRunForUser } from "@/lib/scenario-runs";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  const runId = params.runId?.trim() ?? "";
  if (!runId) {
    return jsonResponse({ error: "runId is required" }, { status: 400 });
  }
  if (
    authz.context.authentication?.method === "boot_benchmark" &&
    (await requestHasBody(request))
  ) {
    return jsonResponse(
      { error: "boot benchmark destroy request must not contain a body" },
      { status: 403 },
    );
  }

  try {
    const result = await destroyScenarioRunForUser({
      runId,
      userId: authz.context.userId,
    });
    return jsonResponse(result, { status: 202 });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to destroy scenario",
    );
    return jsonResponse(body, { status });
  }
};

async function requestHasBody(request: Request): Promise<boolean> {
  if (!request.body) return false;
  const reader = request.body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return false;
      if (chunk.value.byteLength > 0) return true;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
