import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { drizzle } from "drizzle-orm/d1";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { listProbeSnapshotsForUserRun } from "@/lib/run-probe-history";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  const runId = params.runId?.trim() ?? "";
  if (!runId) {
    return jsonResponse({ error: "runId is required" }, { status: 400 });
  }

  try {
    const snapshots = await listProbeSnapshotsForUserRun(drizzle(env.DB), {
      runId,
      userId: authz.context.userId,
    });
    if (snapshots === null) {
      return jsonResponse({ error: "scenario run not found" }, { status: 404 });
    }
    return jsonResponse({ snapshots });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to load probe snapshots",
    );
    return jsonResponse(body, { status });
  }
};
