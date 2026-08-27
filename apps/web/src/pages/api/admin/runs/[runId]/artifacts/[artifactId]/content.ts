import type { APIRoute } from "astro";
import { requireAdminUserContext } from "@/lib/agent-bridge";
import {
  decodeScenarioRunArtifactRouteParams,
  serveScenarioRunArtifactContent,
} from "@/lib/scenario-run-artifact-content";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireAdminUserContext(request);
  if (!authz.ok) return privateNoStore(authz.response);

  const ids = decodeScenarioRunArtifactRouteParams(
    params.runId,
    params.artifactId,
  );
  if (!ids.ok) return privateNoStore(ids.response);

  return privateNoStore(
    await serveScenarioRunArtifactContent({
      request,
      runId: ids.runId,
      artifactId: ids.artifactId,
      archiveOnly: true,
    }),
  );
};

function privateNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
