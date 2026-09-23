import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { requireUserContext } from "@/lib/agent-bridge";
import { accessInviteError, accessInviteJson, accessInviteNoStore } from "@/lib/access-invite-http";
import { currentPersonalOwnerSql } from "@/lib/personal-host-retirement";

export const prerender = false;
export const DELETE: APIRoute = async ({ request, params }) => {
  try {
    const auth = await requireUserContext(request);
    if (!auth.ok) return accessInviteNoStore(auth.response);
    const { userId } = auth.context;
    const canceled = await env.DB.prepare(`UPDATE host_enrollments SET revoked_at = ?3
      WHERE host_id = ?2 AND user_id = ?1 AND scope = 'personal' AND claimed_at IS NULL
      AND ${currentPersonalOwnerSql} RETURNING host_id`)
      .bind(userId, params.enrollmentId ?? "", Date.now()).first();
    return canceled ? accessInviteJson({ canceled: true })
      : accessInviteJson({ error: "Setup already completed or was removed. Refresh My servers." }, { status: 409 });
  } catch (error) { return accessInviteError(error, "Could not cancel server setup. Try again."); }
};
