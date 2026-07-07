import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { acceptTeamInvite, getUserGithubUsername } from "@/lib/teams";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  const inviteId = params.inviteId?.trim() ?? "";
  if (!inviteId) {
    return jsonResponse({ error: "inviteId is required" }, { status: 400 });
  }

  try {
    const username = await getUserGithubUsername(authz.context.userId);
    const result = await acceptTeamInvite({
      inviteId,
      userId: authz.context.userId,
      githubUsername: username,
    });
    return jsonResponse(result);
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to accept invite");
    return jsonResponse(body, { status });
  }
};
