import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { requireUserContext } from "@/lib/agent-bridge";
import { accessInviteError, accessInviteJson, accessInviteNoStore, readJsonObject } from "@/lib/access-invite-http";
import { appError } from "@/lib/app-error";
import { updatePersonalServer } from "@/lib/personal-servers";
import { retirePersonalHost } from "@/lib/personal-host-retirement";
import { cleanupRemovedHost } from "@/lib/host-workload-retirement";

export const prerender = false;
export const PATCH: APIRoute = async ({ request, params }) => {
  try {
    const auth = await requireUserContext(request);
    if (!auth.ok) return accessInviteNoStore(auth.response);
    await updatePersonalServer(env.DB, auth.context, params.hostId ?? "", await readJsonObject(request));
    return accessInviteJson({ updated: true });
  } catch (error) { return accessInviteError(error, "Could not update the server. Try again."); }
};
export const DELETE: APIRoute = async ({ request, params }) => {
  try {
    const auth = await requireUserContext(request);
    if (!auth.ok) return accessInviteNoStore(auth.response);
    const input = await readJsonObject(request);
    if (typeof input.confirmReturnToCloud !== "boolean" || Object.keys(input).some(key => key !== "confirmReturnToCloud")) {
      throw appError(400, "removal_confirmation_required", "Confirm server removal in My servers.");
    }
    const hostId = params.hostId ?? "";
    const result = await retirePersonalHost({ d1: env.DB, hostId, userId: auth.context.userId,
      betaAdmission: auth.context.betaAdmission, confirmReturnToCloud: input.confirmReturnToCloud });
    try { await cleanupRemovedHost(hostId); }
    catch {
      throw appError(503, "server_cleanup_pending", "Server access is revoked. Retry removal to finish closing sessions.");
    }
    await env.DB.prepare(`UPDATE agent_hosts SET owner_removal_completed_at = ?3
      WHERE id = ?1 AND user_id = ?2 AND scope = 'personal' AND disabled = 1 AND owner_removal_id IS NOT NULL`)
      .bind(hostId, auth.context.userId, Date.now()).run();
    return accessInviteJson({ removed: true, ...result, physicalCleanup: "unconfirmed" }, { status: 202 });
  } catch (error) { return accessInviteError(error, "Could not remove the server. Try again."); }
};
