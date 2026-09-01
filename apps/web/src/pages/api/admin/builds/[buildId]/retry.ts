import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { jsonResponse, requireAdminUserContext } from "@/lib/agent-bridge";
import { isSafeAdminBuildId } from "@/lib/admin-build-response";
import { retryImageBuild } from "@/lib/build-scheduler";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireAdminUserContext(request);
  if (!authz.ok) {
    return authz.response;
  }

  const buildId = params.buildId?.trim() ?? "";
  if (!buildId) {
    return jsonResponse({ error: "buildId is required" }, { status: 400 });
  }
  if (!isSafeAdminBuildId(buildId)) {
    return jsonResponse({ error: "invalid build id" }, { status: 400 });
  }

  const result = await retryImageBuild(drizzle(env.DB), {
    buildId,
    nowUnixMs: Date.now(),
  });
  if (result.outcome === "not_found") {
    return jsonResponse({ error: "build not found" }, { status: 404 });
  }
  if (result.outcome === "not_retryable") {
    return jsonResponse(
      { error: `build status ${result.status} cannot be retried` },
      { status: 409 },
    );
  }
  return jsonResponse({ ok: true, buildId, assigned: result.assigned });
};
