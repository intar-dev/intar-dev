import type { APIRoute } from "astro";
import { accessInviteError, accessInviteJson } from "@/lib/access-invite-http";
import { isActiveAccount } from "@/lib/account-access";
import { auth } from "@/lib/auth";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  try {
    const authSession = await auth.api.getSession({ headers: request.headers });
    const session =
      authSession?.session && authSession.user
        ? { session: authSession.session, user: authSession.user }
        : null;
    const access =
      session && (await isActiveAccount(session.user.id))
        ? "active"
        : "inactive";

    return accessInviteJson({ session, access });
  } catch (error) {
    return accessInviteError(
      error,
      "The app bootstrap state could not be loaded",
    );
  }
};
