import type { APIRoute } from "astro";
import { wipeScenarioData } from "@/lib/cutover-wipe";
import { jsonResponse, requireAdminUserContext } from "@/lib/agent-bridge";
import { appError, toErrorResponse } from "@/lib/app-error";

export const prerender = false;

/**
 * Cutover window step 1: deletes every row of scenario data. Refused unless
 * the runtime cutover gate is drained. Repeat until `complete` is true.
 */
export const POST: APIRoute = async ({ request }) => {
  try {
    const authz = await requireAdminUserContext(request);
    if (!authz.ok) return authz.response;
    if (authz.context.impersonated) {
      throw appError(403, "impersonation_forbidden", "Stop impersonating to wipe scenario data.");
    }
    const body = (await request.json().catch(() => null)) as { confirm?: unknown } | null;
    if (body?.confirm !== "wipe all scenario data") {
      throw appError(400, "confirmation_required", 'Send {"confirm": "wipe all scenario data"}.');
    }
    return jsonResponse(await wipeScenarioData());
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to wipe scenario data");
    return jsonResponse(body, { status });
  }
};
