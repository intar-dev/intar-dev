import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  readImagePromotion,
  releaseImagePromotion,
  startImagePromotion,
} from "@/control-plane/image-promotion";
import { jsonResponse, requireAdminUserContext } from "@/lib/agent-bridge";
import { appError, toErrorResponse } from "@/lib/app-error";
import { refuseScenarioSourceWrite } from "@/lib/scenario-sources";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  try {
    const authz = await requireAdminUserContext(request);
    if (!authz.ok) return authz.response;
    return jsonResponse(await readImagePromotion(env));
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to load the image promotion");
    return jsonResponse(body, { status });
  }
};

// Every write rechecks in its statement that the caller is still an active
// platform admin.
export const POST: APIRoute = async ({ request }) => {
  try {
    const authz = await requireAdminUserContext(request);
    if (!authz.ok) return authz.response;
    const refused = await refuseScenarioSourceWrite(request, authz.context);
    if (refused) return refused;
    const body = (await request.json().catch(() => null)) as {
      action?: unknown;
      revision?: unknown;
    } | null;
    const actorUserId = authz.context.userId;
    if (body?.action === "start" && typeof body.revision === "string") {
      return jsonResponse(
        await startImagePromotion(env, { revision: body.revision, actorUserId }),
      );
    }
    if (body?.action === "release") {
      return jsonResponse(await releaseImagePromotion(env, { actorUserId }));
    }
    throw appError(400, "invalid_action", "Choose start with a revision, or release.");
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to change the image promotion");
    return jsonResponse(body, { status });
  }
};
