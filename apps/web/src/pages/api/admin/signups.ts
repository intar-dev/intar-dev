import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  accessInviteError,
  accessInviteJson,
  accessInviteNoStore,
  readJsonObject,
} from "@/lib/access-invite-http";
import { requireAdminUserContext } from "@/lib/agent-bridge";
import { getSignupStatus, setSignupLimit } from "@/lib/signups";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  try {
    const authz = await requireAdminUserContext(request);
    if (!authz.ok) return accessInviteNoStore(authz.response);
    return accessInviteJson(await getSignupStatus(env.DB));
  } catch (error) {
    return accessInviteError(error, "The sign-up limit could not be loaded");
  }
};

// The store validates the limit and version and answers a stale version with
// 409, so the admin form can refetch and ask for a second save.
export const PUT: APIRoute = async ({ request }) => {
  try {
    const authz = await requireAdminUserContext(request);
    if (!authz.ok) return accessInviteNoStore(authz.response);
    const body = await readJsonObject(request);
    const status = await setSignupLimit({
      d1: env.DB,
      actorUserId: authz.context.userId,
      limit: body.limit,
      expectedVersion: body.expectedVersion,
    });
    return accessInviteJson(status);
  } catch (error) {
    return accessInviteError(error, "The sign-up limit could not be saved");
  }
};
