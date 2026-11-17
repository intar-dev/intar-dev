import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { readAdministeredMachineBuildLog } from "@/lib/scenario-revisions";

export const prerender = false;

/** `?attempt=<n>` asks for one attempt's log; without it, the newest. */
export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const asked = new URL(request.url).searchParams.get("attempt");
  if (asked !== null && !/^[1-9][0-9]{0,2}$/.test(asked)) {
    return jsonResponse({ error: "attempt must be a positive number" }, { status: 400 });
  }
  const object = await readAdministeredMachineBuildLog(
    authz.context.userId,
    params.buildKey ?? "",
    asked === null ? undefined : Number(asked),
  );
  if (!object) return jsonResponse({ error: "build log not found" }, { status: 404 });
  return new Response(object.body, {
    headers: { "content-type": "text/plain; charset=utf-8", "content-length": String(object.size), "cache-control": "private, no-store" },
  });
};
