import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  accessInviteError,
  accessInviteJson,
  accessInviteNoStore,
} from "@/lib/access-invite-http";
import { requireAdminUserContext } from "@/lib/agent-bridge";
import { listPlatformUsers } from "@/lib/platform-user-deletion-store";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const authz = await requireAdminUserContext(request);
  if (!authz.ok) return accessInviteNoStore(authz.response);

  try {
    const users = await listPlatformUsers(env.DB);
    return accessInviteJson({ users });
  } catch (error) {
    return accessInviteError(error, "Users could not be listed");
  }
};
