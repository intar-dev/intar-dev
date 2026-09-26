import type { APIRoute } from "astro";
import {
  accessInviteError,
  accessInviteJson,
  accessInviteNoStore,
  readJsonObject,
  requiredRevocationId,
} from "@/lib/access-invite-http";
import { restoreAccess } from "@/lib/access-revocation";
import { requireAdminUserContext } from "@/lib/agent-bridge";
import { appError } from "@/lib/app-error";

export const prerender = false;

// Restores a revoked account as a fresh start once its revocation cleanup
// finished. The body names the revocation the administrator reviewed, so a
// delayed request can't undo a newer one. Repeating a restore that succeeded
// reports success again.
export const POST: APIRoute = async ({ request, params }) => {
  try {
    const authz = await requireAdminUserContext(request);
    if (!authz.ok) return accessInviteNoStore(authz.response);
    const userId = params.userId?.trim();
    if (!userId) throw appError(400, "user_id_required", "User id is required");
    const revocationId = requiredRevocationId(await readJsonObject(request));
    const { serversPendingCleanup } = await restoreAccess({
      userId,
      revocationId,
      actorUserId: authz.context.userId,
    });
    return accessInviteJson({ userId, access: "active", serversPendingCleanup });
  } catch (error) {
    return accessInviteError(error, "Access could not be restored");
  }
};
