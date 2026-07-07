import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import {
  createTeam,
  getUserGithubUsername,
  listPendingInvitesForUser,
  listTeamsForUser,
} from "@/lib/teams";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  try {
    const username = await getUserGithubUsername(authz.context.userId);
    const [teams, invites] = await Promise.all([
      listTeamsForUser({ userId: authz.context.userId }),
      listPendingInvitesForUser({ githubUsername: username }),
    ]);
    return jsonResponse({ teams, invites });
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to list teams");
    return jsonResponse(body, { status });
  }
};

export const POST: APIRoute = async ({ request }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;

  const body = (await request.json().catch(() => null)) as {
    name?: unknown;
  } | null;
  const name = typeof body?.name === "string" ? body.name : "";

  try {
    const team = await createTeam({
      name,
      ownerUserId: authz.context.userId,
    });
    return jsonResponse({ team }, { status: 201 });
  } catch (error) {
    const { status, body: errorBody } = toErrorResponse(
      error,
      "failed to create team",
    );
    return jsonResponse(errorBody, { status });
  }
};
