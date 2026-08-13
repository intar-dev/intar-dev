import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  accessInviteError,
  accessInviteJson,
  accessInviteNoStore,
  readJsonObject,
} from "@/lib/access-invite-http";
import { requireAdminUserContext } from "@/lib/agent-bridge";
import { appError } from "@/lib/app-error";
import { setPlatformUserBanned } from "@/lib/beta-admin-guard";
import { requireSameOriginJsonMutation } from "@/lib/request-security";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  try {
    requireSameOriginJsonMutation(request);
    const authz = await requireAdminUserContext(request);
    if (!authz.ok) return accessInviteNoStore(authz.response);
    const targetUserId = params.userId?.trim();
    if (!targetUserId) {
      throw appError(400, "user_id_required", "user id is required");
    }
    const body = await readJsonObject(request);
    if (typeof body.banned !== "boolean") {
      throw appError(400, "ban_state_invalid", "banned must be a boolean");
    }
    await setPlatformUserBanned({
      d1: env.DB,
      targetUserId,
      actorUserId: authz.context.userId,
      banned: body.banned,
      reason: typeof body.reason === "string" ? body.reason : null,
    });
    return accessInviteJson({ updated: true });
  } catch (error) {
    return accessInviteError(error, "the platform ban could not be updated");
  }
};
