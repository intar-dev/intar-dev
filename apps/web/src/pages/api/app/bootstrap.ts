import type { APIRoute } from "astro";
import { accessInviteError, accessInviteJson } from "@/lib/access-invite-http";
import { getBetaAccessState } from "@/lib/allowlist";
import { auth } from "@/lib/auth";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  try {
    const authSession = await auth.api.getSession({ headers: request.headers });
    const session =
      authSession?.session && authSession.user
        ? { session: authSession.session, user: authSession.user }
        : null;
    const betaAccess =
      session && (await getBetaAccessState(session.user.id)) === "active"
        ? "active"
        : "restricted";

    return accessInviteJson({ session, betaAccess });
  } catch (error) {
    return accessInviteError(
      error,
      "The app bootstrap state could not be loaded",
    );
  }
};
