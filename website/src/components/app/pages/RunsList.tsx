import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowRight,
  BookOpen,
  CircleDot,
  Clock3,
  ListChecks,
  PlayCircle,
} from "lucide-react";
import { PageHeader } from "../patterns/PageHeader";
import { EmptyState, ErrorState, LoadingState } from "../patterns/StateCard";
import { formatDurationMs, formatRelativeTime } from "../lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface ScenarioRunListEntry {
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

interface ScenarioRunListResponse {
  runs: ScenarioRunListEntry[];
}

export function RunsList() {
  const runs = useQuery({
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
        throw new Error(body?.error ?? `Failed to load runs (${response.status})`);
      }

      return (await response.json()) as ScenarioRunListResponse;
    },
    staleTime: 5_000,
  });

  const entries = runs.data?.runs ?? [];
  const activeRuns = entries.filter((run) => run.active);
  const pastRuns = entries.filter((run) => !run.active);

  return (
    <>
      <PageHeader
        eyebrow="Activity"
        title="My runs"
        description="Active sandboxes and your run history with replays."
      />

      {runs.error ? (
        <ErrorState
          title="Could not load runs"
          description={
            runs.error instanceof Error
              ? runs.error.message
              : "Failed to load runs"
          }
        />
      ) : runs.isLoading ? (
        <LoadingState title="Loading your runs" />
      ) : !entries.length ? (
        <EmptyState
          icon={<ListChecks className="size-6" />}
          title="No runs yet"
          description="Start a scenario to launch your first sandbox — it will show up here, along with the replay once you finish."
          action={
            <Button render={<Link to="/scenarios" />}>
              <BookOpen className="size-4" />
              Browse scenarios
            </Button>
          }
        />
      ) : (
        <div className="space-y-8">
          {activeRuns.length ? (
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground">
                Active
              </h2>
              <div className="space-y-2">
                {activeRuns.map((run) => (
                  <RunRow key={run.runId} run={run} />
                ))}
              </div>
            </section>
          ) : null}

          {pastRuns.length ? (
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground">
                History
              </h2>
              <div className="space-y-2">
                {pastRuns.map((run) => (
                  <RunRow key={run.runId} run={run} />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </>
  );
}

function RunRow({ run }: { run: ScenarioRunListEntry }) {
  return (
    <Card className="py-0">
      <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to="/runs/$runId"
              params={{ runId: run.runId }}
              className="truncate text-sm font-medium hover:underline"
            >
              {run.title}
            </Link>
            <OutcomeBadge run={run} />
            {run.solutionAssisted ? (
              <Badge variant="outline">Solution used</Badge>
            ) : null}
          </div>
          <p className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
            <span>Started {formatRelativeTime(run.createdAt)}</span>
            {run.solveDurationMs !== null ? (
              <span className="inline-flex items-center gap-1">
                <Clock3 className="size-3" />
                Solved in {formatDurationMs(run.solveDurationMs)}
              </span>
            ) : null}
            {!run.active && run.hasReplay ? (
              <span className="inline-flex items-center gap-1">
                <PlayCircle className="size-3" />
                Replay available
              </span>
            ) : null}
          </p>
        </div>
        <Button
          variant={run.active ? "default" : "outline"}
          size="sm"
          render={<Link to="/runs/$runId" params={{ runId: run.runId }} />}
        >
          {run.active ? "Resume" : run.hasReplay ? "Watch replay" : "View"}
          <ArrowRight className="size-3.5" />
        </Button>
      </CardContent>
    </Card>
  );
}

function OutcomeBadge({ run }: { run: ScenarioRunListEntry }) {
  if (run.active) {
    return (
      <Badge className="gap-1 bg-success/15 text-success" variant="secondary">
        <CircleDot
          className={cn("size-3", "motion-safe:animate-pulse")}
          aria-hidden="true"
        />
        In progress
      </Badge>
    );
  }
  switch (run.outcome) {
    case "succeeded":
      return <Badge variant="secondary">Solved</Badge>;
    case "failed":
      return <Badge variant="destructive">Failed</Badge>;
    case "cancelled":
      return <Badge variant="outline">Ended early</Badge>;
    default:
      return <Badge variant="outline">In progress</Badge>;
  }
}
