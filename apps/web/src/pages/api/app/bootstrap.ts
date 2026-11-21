import type { APIRoute } from "astro";
import { accessInviteError, accessInviteJson } from "@/lib/access-invite-http";
import { sessionMayAct } from "@/lib/account-access";
import { auth } from "@/lib/auth";
import { isAdminUser } from "@/lib/authz";
import { featureToggleService } from "@/lib/organization-access";

/**
 * Shows a platform administrator the builder's own surfaces: the builds
 * page in the navigation and the builder role in host enrollment (#465).
 * One flag for the platform, not per scope. Off, they are out of sight; the
 * pages and their APIs stay. It is evaluated for the administrator who
 * reads, as `organization-creation` is, so it can be on by default or for
 * selected administrators.
 */
export const BUILDER_OPERATIONS_FLAG = "builder_operations";

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

    // Asked for an acting platform administrator only: nobody else has the
    // surfaces it shows.
    const builderOperations =
      session !== null && access === "active" && isAdminUser(session.user)
        ? await featureToggleService().getBoolean(BUILDER_OPERATIONS_FLAG, false, { targetingKey: session.user.id })
        : false;

    return accessInviteJson({ session, access, builderOperations });
  } catch (error) {
    return accessInviteError(
      error,
      "The app bootstrap state could not be loaded",
    );
  }
};
