import type { APIRoute } from "astro";
import { accessInviteError, accessInviteJson } from "@/lib/access-invite-http";
import { sessionMayAct } from "@/lib/account-access";
import { auth } from "@/lib/auth";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  try {
    const authSession = await auth.api.getSession({ headers: request.headers });
    const session =
      authSession?.session && authSession.user
        ? { session: authSession.session, user: authSession.user }
        : null;
    // The same rule every API request applies, so the app's route guard
    // agrees with them.
    const access =
      session && (await sessionMayAct(session.session))
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
