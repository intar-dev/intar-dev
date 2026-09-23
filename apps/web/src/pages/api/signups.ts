import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { accessInviteError, accessInviteJson } from "@/lib/access-invite-http";
import { getSignupStatus } from "@/lib/signups";

export const prerender = false;

// Public: the landing page shows how many sign-up spots are left. Only the
// counts leave the server, never the settings version or its author.
export const GET: APIRoute = async () => {
  try {
    const { limit, taken, remaining, open } = await getSignupStatus(env.DB);
    return accessInviteJson({ limit, taken, remaining, open });
  } catch (error) {
    return accessInviteError(error, "The sign-up status could not be loaded");
  }
};
