import type { APIRoute } from "astro";
import {
  accessInviteError,
  accessInviteJson,
  accessInviteNoStore,
  readJsonObject,
  requiredRevocationId,
} from "@/lib/access-invite-http";
import { finishAccessRevocationCleanup } from "@/lib/access-revocation";
import { requireAdminUserContext } from "@/lib/agent-bridge";
import { appError } from "@/lib/app-error";

export const prerender = false;

// Finishes the cleanup of the revocation the administrator saw. A revocation
// that is no longer current gets 409 stale_access_revocation, so a stale page
// can't touch an account restored and revoked again since.
export const POST: APIRoute = async ({ request, params }) => {
  try {
    const authz = await requireAdminUserContext(request);
    if (!authz.ok) return accessInviteNoStore(authz.response);
    const userId = params.userId?.trim();
    if (!userId) throw appError(400, "user_id_required", "User id is required");
    const revocationId = requiredRevocationId(await readJsonObject(request));
    await finishAccessRevocationCleanup({
      userId,
      revocationId,
      actorUserId: authz.context.userId,
    });
    return accessInviteJson({
      userId,
      access: "revoked",
      revocationId,
      cleanupCompleted: true,
    });
  } catch (error) {
    return accessInviteError(error, "The revocation cleanup could not finish");
  }
};
