import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { revokeScenarioNativeProfileRoutesForUser } from "@/lib/scenario-runs";
import { deleteUserSshKeyForUser } from "@/lib/user-ssh-keys";

export const prerender = false;

export const DELETE: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  const keyId = params.keyId?.trim() ?? "";
  if (!keyId) {
    return jsonResponse({ error: "keyId is required" }, { status: 400 });
  }

  try {
    await deleteUserSshKeyForUser({
      userId: authz.context.userId,
      keyId,
    });
    await revokeScenarioNativeProfileRoutesForUser(authz.context.userId).catch(
      (error) => {
        console.error("failed to revoke native profile routes after key delete", error);
      },
    );
    return jsonResponse({ deleted: true });
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to delete SSH key");
    return jsonResponse(body, { status });
  }
};
