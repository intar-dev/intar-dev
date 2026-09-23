import { cleanupRemovedHost } from "@/lib/host-workload-retirement";
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { accessInviteError, accessInviteJson, accessInviteNoStore } from "@/lib/access-invite-http";
import { requireAdminUserContext } from "@/lib/agent-bridge";
import { appError } from "@/lib/app-error";
import { revokePlatformHost } from "@/lib/platform-host-revocation";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  try {
    const authz = await requireAdminUserContext(request);
    if (!authz.ok) return accessInviteNoStore(authz.response);
    const hostId = params.hostId?.trim();
    if (!hostId) throw appError(400, "host_id_required", "Host id is required");
    const revoked = await revokePlatformHost({
      d1: env.DB, hostId, actorUserId: authz.context.userId,
    });
    if (!revoked) {
      throw appError(409, "platform_host_revoke_conflict", "The platform host or administrator access changed. Refresh and retry.");
    }

    try { await cleanupRemovedHost(hostId); }
    catch {
      throw appError(503, "platform_host_cleanup_pending", "Host access is revoked. Retry this request to finish session and workload cleanup.");
    }
    return accessInviteJson({ ok: true, hostId, accessRevoked: true, physicalCleanup: "unconfirmed" }, { status: 202 });
  } catch (error) {
    return accessInviteError(error, "The platform host could not be revoked");
  }
};
