import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { disableRunShare, enableRunShare } from "@/lib/run-share/service";

export const prerender = false;

/** Turns the run's public share on or off. Only the owner may. */
export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  const runId = params.runId?.trim() ?? "";
  if (!runId) {
    return jsonResponse({ error: "runId is required" }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as {
    enabled?: unknown;
  } | null;
  if (typeof body?.enabled !== "boolean") {
    return jsonResponse({ error: "enabled must be a boolean" }, { status: 400 });
  }

  try {
    const owner = { runId, userId: authz.context.userId };
    if (body.enabled) {
      return jsonResponse({ shareUrl: await enableRunShare(owner) });
    }
    await disableRunShare(owner);
    return jsonResponse({ shareUrl: null });
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to update sharing");
    return jsonResponse(body, { status });
  }
};
