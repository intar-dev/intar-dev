import { useQuery } from "@tanstack/react-query";

export interface MyRunEntry {
  runId: string;
  scenarioId: string;
  scenarioName: string;
  title: string;
  difficulty: "easy" | "medium" | "hard";
  phase: string;
  outcome: "in_progress" | "succeeded" | "cancelled" | "failed";
  active: boolean;
  createdAt: number;
  finishedAt: number | null;
  solvedAt: number | null;
  solveDurationMs: number | null;
  solutionAssisted: boolean;
  hasReplay: boolean;
}

interface MyRunsResponse {
  runs: MyRunEntry[];
}

// The signed-in user's runs — shared by the runs list and the catalog's
// "continue" strip.
export function useMyRuns(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["scenario-runs", "list"],
    queryFn: async () => {
      const response = await fetch("/api/scenarios/runs", {
        method: "GET",
        credentials: "include",
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          body?.error ?? `Failed to load runs (${response.status})`,
        );
      }

      return (await response.json()) as MyRunsResponse;
    },
    staleTime: 5_000,
    enabled: options?.enabled ?? true,
  });
}
