import type { APIRoute } from "astro";
import { accessInviteError, accessInviteJson } from "@/lib/access-invite-http";
import { listLinkedIdentities } from "@/lib/account-links";
import { requireUserContext } from "@/lib/agent-bridge";

export const prerender = false;

// The signed-in account's ways to sign in, named by organization.
export const GET: APIRoute = async ({ request }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  try {
    return accessInviteJson({
      identities: await listLinkedIdentities(authz.context.userId),
    });
  } catch (error) {
    return accessInviteError(error, "failed to list sign-in methods");
  }
};
