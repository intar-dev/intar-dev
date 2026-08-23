import type { APIRoute } from "astro";
import { accessInviteError, accessInviteJson } from "@/lib/access-invite-http";
import { auth } from "@/lib/auth";
import { clearInviteAttemptCookie } from "@/lib/invite-attempt";
import { copySetCookies } from "@/lib/response-cookies";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  try {
    const headers = new Headers();
    const signOutResponse = await auth.api
      .signOut({ headers: request.headers, asResponse: true })
      .catch(() => null);
    if (signOutResponse) copySetCookies(signOutResponse.headers, headers);
    headers.append("set-cookie", clearInviteAttemptCookie());
    return accessInviteJson({ canceled: true }, { headers });
  } catch (error) {
    return accessInviteError(error, "the invite attempt could not be canceled");
  }
};
