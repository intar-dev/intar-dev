import type { APIRoute } from "astro";
import { jsonResponse, requireAdminUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { queueDraftBuild } from "@/lib/authoring-build";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const authz = await requireAdminUserContext(request);
  if (!authz.ok) return authz.response;

  const body = (await request.json().catch(() => null)) as {
    scenarioId?: unknown;
    contentHash?: unknown;
    kinoVersion?: unknown;
    imageArch?: unknown;
  } | null;
  const scenarioId =
    typeof body?.scenarioId === "string" ? body.scenarioId.trim() : "";
  const contentHash =
    typeof body?.contentHash === "string" ? body.contentHash : "";
  const kinoVersion =
    typeof body?.kinoVersion === "string" ? body.kinoVersion : "";
  const imageArch = typeof body?.imageArch === "string" ? body.imageArch : "";
  if (!scenarioId || !contentHash || !kinoVersion || !imageArch) {
    return jsonResponse(
      { error: "scenarioId, contentHash, kinoVersion, and imageArch are required" },
      { status: 400 },
    );
  }

  try {
    const result = await queueDraftBuild({
      scenarioId,
      contentHash,
      kinoVersion,
      imageArch,
    });
    return jsonResponse(result, { status: 202 });
  } catch (error) {
    const { status, body: errorBody } = toErrorResponse(
      error,
      "failed to queue draft build",
    );
    return jsonResponse(errorBody, { status });
  }
};
