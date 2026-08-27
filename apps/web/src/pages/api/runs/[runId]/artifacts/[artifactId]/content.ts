import type { APIRoute } from "astro";
import { requireUserContext } from "@/lib/agent-bridge";
import {
  decodeScenarioRunArtifactRouteParams,
  serveScenarioRunArtifactContent,
} from "@/lib/scenario-run-artifact-content";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  const ids = decodeScenarioRunArtifactRouteParams(
    params.runId,
    params.artifactId,
  );
  if (!ids.ok) return ids.response;

  return serveScenarioRunArtifactContent({
    request,
    runId: ids.runId,
    artifactId: ids.artifactId,
    ownerUserId: authz.context.userId,
  });
};
