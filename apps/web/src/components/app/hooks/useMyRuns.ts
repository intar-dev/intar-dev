import { useQuery } from "@tanstack/react-query";
import type {
  ScenarioRunActivity,
  ScenarioRunReplayState,
} from "@/lib/scenario-runs";
import type { RunPhase } from "@/lib/run-state";
import {
  HttpResponseError,
  isAccessResponseError,
  pollingIntervalUnlessAccessError,
  retryHttpResponseError,
} from "@/components/app/lib/http-response-error";

export interface MyRunEntry {
  runId: string;
  scenarioId: string;
  scenarioName: string;
  title: string;
  difficulty: "easy" | "medium" | "hard";
  phase: RunPhase;
  outcome: "in_progress" | "succeeded" | "cancelled" | "failed";
  active: boolean;
  activity: ScenarioRunActivity;
  deleteRequestedAt: number | null;
  replayState: ScenarioRunReplayState;
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

export function groupMyRunsByActivity(runs: MyRunEntry[]) {
  return {
    foreground: runs.filter((run) => run.activity === "foreground"),
    background: runs.filter((run) => run.activity === "background"),
    settled: runs.filter((run) => run.activity === "settled"),
  };
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
        throw new HttpResponseError(
          response.status,
          body?.error ?? `Failed to load runs (${response.status})`,
        );
      }

      return (await response.json()) as MyRunsResponse;
    },
    refetchInterval: (query) =>
      pollingIntervalUnlessAccessError(
        query.state.error,
        query.state.data?.runs.some((run) => run.activity !== "settled")
          ? 2_000
          : false,
      ),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: (query) =>
      !isAccessResponseError(query.state.error, true),
    staleTime: 1_000,
    retry: retryHttpResponseError,
    enabled: options?.enabled ?? true,
  });
}
