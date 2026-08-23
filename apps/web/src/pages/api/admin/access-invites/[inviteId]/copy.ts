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
import { copyBetaInvite } from "@/lib/beta-invites";
import { canonicalApplicationOrigin } from "@/lib/request-security";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  try {
    const authz = await requireAdminUserContext(request);
    if (!authz.ok) return accessInviteNoStore(authz.response);
    const inviteId = params.inviteId?.trim();
    if (!inviteId) {
      throw appError(400, "invite_id_required", "Invite id is required");
    }
    const body = await readJsonObject(request);
    const code = await copyBetaInvite({
      d1: env.DB,
      inviteId,
      expectedVersion:
        typeof body.expectedVersion === "number" ? body.expectedVersion : 0,
      actorUserId: authz.context.userId,
      encryptionKey: env.ACCESS_INVITE_TOKEN_ENCRYPTION_KEY_V1,
    });
    return accessInviteJson({
      inviteUrl: `${canonicalApplicationOrigin()}/join#invite=${encodeURIComponent(code)}`,
    });
  } catch (error) {
    return accessInviteError(error, "The beta invite link could not be copied");
  }
};
