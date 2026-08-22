import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { replaceAccessInvite } from "@/lib/access-invites";
import {
  accessInviteError,
  accessInviteJson,
  accessInviteNoStore,
  readJsonObject,
} from "@/lib/access-invite-http";
import { requireAdminUserContext } from "@/lib/agent-bridge";
import { appError } from "@/lib/app-error";
import { canonicalApplicationOrigin } from "@/lib/request-security";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  try {
    const authz = await requireAdminUserContext(request);
    if (!authz.ok) return accessInviteNoStore(authz.response);
    const inviteId = params.inviteId?.trim();
    if (!inviteId) throw appError(400, "invite_id_required", "invite id is required");
    const body = await readJsonObject(request);
    const expectedVersion =
      typeof body.expectedVersion === "number" ? body.expectedVersion : 0;
    let label: string | null | undefined;
    if (body.label === null || typeof body.label === "string") {
      label = body.label;
    } else {
      const current = await env.DB.prepare(
        "SELECT label FROM access_invite_codes WHERE id = ?1 LIMIT 1",
      )
        .bind(inviteId)
        .first<{ label: string | null }>();
      label = current?.label;
    }
    const replaced = await replaceAccessInvite({
      d1: env.DB,
      inviteId,
      expectedVersion,
      actorUserId: authz.context.userId,
      ...(label !== undefined ? { label } : {}),
    });
    const { code, ...invite } = replaced;
    return accessInviteJson({
      invite,
      inviteUrl: `${canonicalApplicationOrigin()}/join#invite=${encodeURIComponent(code)}`,
    });
  } catch (error) {
    return accessInviteError(error, "the beta invite could not be replaced");
  }
};
