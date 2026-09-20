import type { APIRoute } from "astro";
import { requireUserContext } from "@/lib/agent-bridge";
import { accessInviteError, accessInviteJson, accessInviteNoStore } from "@/lib/access-invite-http";
import { listPersonalServers } from "@/lib/personal-servers";

export const prerender = false;
export const GET: APIRoute = async ({ request }) => {
  try {
    const auth = await requireUserContext(request);
    if (!auth.ok) return accessInviteNoStore(auth.response);
    return accessInviteJson(await listPersonalServers(auth.context));
  } catch (error) { return accessInviteError(error, "Could not load your servers. Try again."); }
};
