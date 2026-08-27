import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CourseLocation,
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
  organizationId?: string | null;
  courseLocation?: CourseLocation | null;
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

export interface MyRunsSummary {
  activeCount: number;
  activeRunId: string | null;
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
  const enabled = options?.enabled ?? true;
  const queryClient = useQueryClient();
  const summary = useMyRunsSummary({ enabled });
  const previousSummaryRef = useRef<string | null>(null);
  const query = useQuery({
    queryKey: ["scenario-runs", "list"],
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/scenarios/runs", {
        method: "GET",
        credentials: "include",
        signal,
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
    // The history page and catalog need full rows, but a live run must not
    // repeatedly download a learner's whole archive. Mutations invalidate
    // this record when its full content really changes; a later tab focus
    // refreshes it after the normal stale window.
    refetchInterval: false,
    refetchOnWindowFocus: (query) =>
      !isAccessResponseError(query.state.error, true),
    staleTime: 30_000,
    retry: retryHttpResponseError,
    enabled,
  });

  useEffect(() => {
    if (!enabled || !summary.data) return;
    const signature = `${summary.data.activeCount}:${summary.data.activeRunId ?? ""}`;
    if (previousSummaryRef.current === null) {
      previousSummaryRef.current = signature;
      return;
    }
    if (previousSummaryRef.current === signature) return;
    previousSummaryRef.current = signature;
    void queryClient.invalidateQueries({
      queryKey: ["scenario-runs", "list"],
      exact: true,
    });
  }, [enabled, queryClient, summary.data]);

  return query;
}

/**
 * A bounded sidebar-only status query. It never loads a user's historical
 * runs, and React Query pauses it while the tab is hidden and cancels it when
 * its observer unmounts.
 */
export function useMyRunsSummary(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["scenario-runs", "summary"],
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/scenarios/runs/summary", {
        method: "GET",
        credentials: "include",
        signal,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new HttpResponseError(
          response.status,
          body?.error ?? `Failed to load run summary (${response.status})`,
        );
      }
      return (await response.json()) as MyRunsSummary;
    },
    refetchInterval: (query) =>
      pollingIntervalUnlessAccessError(query.state.error, 3_000),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: (query) =>
      !isAccessResponseError(query.state.error, true),
    staleTime: 1_000,
    retry: retryHttpResponseError,
    enabled: options?.enabled ?? true,
  });
}
