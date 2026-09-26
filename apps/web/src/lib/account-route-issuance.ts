import { activeAccessGeneration } from "@/lib/account-access";
import { appError } from "@/lib/app-error";
import { revokeAllRoutes } from "@/lib/route-revocation";

/**
 * Runs one route mutation under the account fence, and fails closed.
 *
 * The route id is inside the cleanup set before the mutation starts. Any
 * outcome that is not a confirmed success with the account still active
 * revokes the route: a rejected mutation, a lost response, a timeout, a 5xx,
 * a revoked account, and a failure of the post-read itself. An ambiguous
 * failure therefore can not leave a ready route behind. The account must be
 * active at the same access generation before and after the mutation, so it
 * was active throughout it, even if an administrator restored access
 * meanwhile.
 *
 * A caller passes a generation-fenced `revoke` when the route has one
 * generation, so a late cleanup can not delete a route that the same name was
 * reissued to for a newer run.
 */
export async function issueAccountFencedRoute<Result>(params: {
  userId: string;
  routeId: string;
  issue: () => Promise<Result>;
  issuedRouteIds: (result: Result) => Iterable<string>;
  revoke: (routeId: string) => Promise<void>;
}): Promise<Result> {
  // The pre-check runs before the cleanup fence. A refused pre-check made no
  // remote mutation, so it must not revoke anything; only an outcome after
  // the write is ambiguous.
  const generation = await activeAccessGeneration(params.userId);
  if (generation === null) throw accountAccessRevoked();

  // Keep the deterministic requested id inside the cleanup fence even when
  // the mutation reached Stargate but its response was lost or malformed.
  const issuedRouteIds = new Set([params.routeId]);
  try {
    const result = await params.issue();
    for (const routeId of params.issuedRouteIds(result)) {
      issuedRouteIds.add(routeId);
    }
    // A throw here is a failure to confirm, so it revokes like any other.
    if ((await activeAccessGeneration(params.userId)) !== generation) {
      throw accountAccessRevoked();
    }
    return result;
  } catch (error) {
    try {
      await revokeAllRoutes(issuedRouteIds, params.revoke);
    } catch (revokeError) {
      throw new AggregateError(
        [error, revokeError],
        "account access changed during route issuance and the route could not be revoked",
      );
    }
    throw error;
  }
}

function accountAccessRevoked() {
  return appError(
    403,
    "access_revoked",
    "an active account is required to open a terminal route",
  );
}
