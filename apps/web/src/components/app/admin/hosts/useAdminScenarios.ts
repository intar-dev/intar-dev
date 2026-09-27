import { useQuery } from "@tanstack/react-query";
import type { AdminScenarioListResponse } from "./types";

// The scenario list, shared by the admin Overview (stats) and the Scenario
// registry. One cache entry, one queryFn, so moving between them reuses it.
export function useAdminScenarios() {
  return useQuery({
    queryKey: ["admin-scenarios", "list"],
    queryFn: async () => {
      const response = await fetch("/api/admin/scenarios", {
        method: "GET",
        credentials: "include",
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          body?.error ?? `Failed to load scenarios (${response.status})`,
        );
      }

      return (await response.json()) as AdminScenarioListResponse;
    },
    staleTime: 10_000,
  });
}
