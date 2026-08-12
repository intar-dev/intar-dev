import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { removeAccessInvite } from "@/lib/access-invites";
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
    const inviteId = params.inviteId?.trim();
    if (!inviteId) {
      throw appError(400, "invite_id_required", "invite id is required");
    }
    const body = await readJsonObject(request);
    await removeAccessInvite({
      d1: env.DB,
      inviteId,
      expectedVersion:
        typeof body.expectedVersion === "number" ? body.expectedVersion : 0,
      actorUserId: authz.context.userId,
    });
    return accessInviteJson({ removed: true });
  } catch (error) {
    return accessInviteError(error, "the beta invite could not be removed");
  }
};
