export type RevokeRoute = (routeUsername: string) => Promise<void>;

export async function revokeAllRoutes(
  routeUsernames: Iterable<string>,
  revokeRoute: RevokeRoute,
): Promise<void> {
  const routes = [...new Set(routeUsernames)];
  const outcomes = await Promise.allSettled(
    routes.map((route) => revokeRoute(route)),
  );
  const failures = outcomes.flatMap((outcome, index) =>
    outcome.status === "rejected"
      ? [
          new Error(`failed to revoke route ${routes[index]}`, {
            cause: outcome.reason,
          }),
        ]
      : [],
  );

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `failed to revoke ${failures.length} of ${routes.length} Stargate routes`,
    );
  }
}
