import { appError } from "@/lib/app-error";
import { getBetaAccess, type BetaAccessSnapshot } from "@/lib/allowlist";
import { revokeAllRoutes } from "@/lib/route-revocation";

export async function issueBetaAccessFencedRoute<Result>(params: {
  userId: string;
  routeId: string;
  issue: () => Promise<Result>;
  issuedRouteIds: (result: Result) => Iterable<string>;
  revoke: (routeId: string) => Promise<void>;
}): Promise<Result> {
  const admission = await getBetaAccess(params.userId);
  if (!isActiveAdmission(admission)) throw betaAccessRevoked();

  const issuedRouteIds = new Set([params.routeId]);
  try {
    // Keep the deterministic requested id inside the cleanup fence even when
    // Stargate created the route but its response was lost or malformed.
    const result = await params.issue();
    for (const routeId of params.issuedRouteIds(result)) {
      issuedRouteIds.add(routeId);
    }
    const current = await getBetaAccess(params.userId);
    if (!sameActiveAdmission(admission, current)) throw betaAccessRevoked();
    return result;
  } catch (error) {
    try {
      await revokeAllRoutes(issuedRouteIds, params.revoke);
    } catch (revokeError) {
      throw new AggregateError(
        [error, revokeError],
        "beta access changed during route issuance and the route could not be revoked",
      );
    }
    throw error;
  }
}

function isActiveAdmission(
  access: BetaAccessSnapshot | null,
): access is BetaAccessSnapshot & { state: "active" } {
  return access?.state === "active";
}

function sameActiveAdmission(
  expected: BetaAccessSnapshot & { state: "active" },
  current: BetaAccessSnapshot | null,
): boolean {
  return (
    current?.state === "active" &&
    current.userId === expected.userId &&
    current.sourceInviteId === expected.sourceInviteId &&
    current.sourceLeaseId === expected.sourceLeaseId &&
    current.grantedAt === expected.grantedAt
  );
}

function betaAccessRevoked() {
  return appError(
    403,
    "beta_access_revoked",
    "beta access is required to open a terminal route",
  );
}
