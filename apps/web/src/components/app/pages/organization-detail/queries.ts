import type { QueryClient } from "@tanstack/react-query";

/**
 * Refreshes the organization page, which caches its detail under the id or
 * the slug in its URL.
 */
export function invalidateOrganizationDetail(
  queryClient: QueryClient,
  detail: { id: string; slug: string },
): Promise<unknown> {
  return Promise.all(
    [detail.id, detail.slug].map((key) =>
      queryClient.invalidateQueries({
        queryKey: ["organizations", key, "detail"],
      }),
    ),
  );
}
