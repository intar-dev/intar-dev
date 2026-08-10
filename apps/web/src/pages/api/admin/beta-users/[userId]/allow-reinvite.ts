import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { allowBetaReinvite } from "@/lib/access-invites";
import {
  accessInviteError,
  accessInviteJson,
  accessInviteNoStore,
  readJsonObject,
} from "@/lib/access-invite-http";
import { requireAdminUserContext } from "@/lib/agent-bridge";
import { appError } from "@/lib/app-error";
import { requireSameOriginJsonMutation } from "@/lib/request-security";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  try {
    requireSameOriginJsonMutation(request);
    const authz = await requireAdminUserContext(request);
    if (!authz.ok) return accessInviteNoStore(authz.response);
    const userId = params.userId?.trim();
    if (!userId) throw appError(400, "user_id_required", "user id is required");
    const body = await readJsonObject(request);
    if (typeof body.revocationId !== "string") {
      throw appError(
        400,
        "revocation_id_required",
        "the current revocation id is required",
      );
    }
    await allowBetaReinvite({
      d1: env.DB,
      userId,
      actorUserId: authz.context.userId,
      revocationId: body.revocationId,
    });
    return accessInviteJson({ userId, state: "reinvite_allowed" });
  } catch (error) {
    return accessInviteError(error, "the beta block could not be cleared");
  }
};
