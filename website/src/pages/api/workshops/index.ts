import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { getWorkshopListProjection } from "@/lib/workshops/projection";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  try {
    return jsonResponse(await getWorkshopListProjection(authz.context.userId));
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to list workshops");
    return jsonResponse(body, { status });
  }
};
