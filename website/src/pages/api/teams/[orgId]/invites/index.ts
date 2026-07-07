import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { inviteToTeam } from "@/lib/teams";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  const orgId = params.orgId?.trim() ?? "";
  if (!orgId) {
    return jsonResponse({ error: "orgId is required" }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as {
    username?: unknown;
  } | null;
  const username = typeof body?.username === "string" ? body.username : "";

  try {
    const invite = await inviteToTeam({
      organizationId: orgId,
      inviterUserId: authz.context.userId,
      githubUsername: username,
    });
    return jsonResponse({ invite }, { status: 201 });
  } catch (error) {
    const { status, body: errorBody } = toErrorResponse(
      error,
      "failed to invite user",
    );
    return jsonResponse(errorBody, { status });
  }
};
