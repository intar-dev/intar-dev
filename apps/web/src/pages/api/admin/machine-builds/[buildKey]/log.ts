import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { readAdministeredMachineBuildLog } from "@/lib/scenario-revisions";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const object = await readAdministeredMachineBuildLog(authz.context.userId, params.buildKey ?? "");
  if (!object) return jsonResponse({ error: "build log not found" }, { status: 404 });
  return new Response(object.body, {
    headers: { "content-type": "text/plain; charset=utf-8", "content-length": String(object.size), "cache-control": "private, no-store" },
  });
};
