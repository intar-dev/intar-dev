import { Link } from "@tanstack/react-router";
import { ArrowRight, BookOpen, CircleDot } from "lucide-react";
import { PageShell } from "../patterns/PageShell";
import { RunListItem } from "../patterns/RunListItem";
import { EmptyState, ErrorState, LoadingState } from "../patterns/StateCard";
import { useMyRuns, type MyRunEntry } from "../hooks/useMyRuns";
import { formatRelativeTime } from "../lib/format";
import { Button } from "@/components/ui/button";

const DAY_MS = 86_400_000;

function groupLabel(run: MyRunEntry, now: number): string {
  const age = now - run.createdAt;
  if (age < DAY_MS) return "Today";
  if (age < 7 * DAY_MS) return "This week";
  return "Earlier";
}

export function RunsList() {
  const runs = useMyRuns();

  const entries = runs.data?.runs ?? [];
  const activeRuns = entries.filter((run) => run.active);
  const pastRuns = entries.filter((run) => !run.active);

  const now = Date.now();
  const groups: Array<{ label: string; runs: MyRunEntry[] }> = [];
  for (const run of pastRuns) {
    const label = groupLabel(run, now);
    const group = groups.find((entry) => entry.label === label);
    if (group) {
      group.runs.push(run);
    } else {
      groups.push({ label, runs: [run] });
    }
  }

  return (
    <PageShell
      title="My runs"
      description="Pick up where you left off, or replay a finished run."
    >
      {runs.error ? (
        <ErrorState
          title="Could not load runs"
          description={
            runs.error instanceof Error
              ? runs.error.message
              : "Failed to load runs"
          }
          onRetry={() => void runs.refetch()}
        />
      ) : runs.isLoading ? (
        <LoadingState title="Loading your runs" />
      ) : !entries.length ? (
        <EmptyState
          icon={<BookOpen />}
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
        <div className="space-y-10">
          {activeRuns.length ? (
            <section className="space-y-3">
              <h2 className="text-eyebrow">Active now</h2>
              <div className="space-y-3">
                {activeRuns.map((run) => (
                  <ActiveRunCard key={run.runId} run={run} />
                ))}
              </div>
            </section>
          ) : null}

          {groups.map((group) => (
            <section key={group.label} className="space-y-3">
              <h2 className="text-eyebrow">{group.label}</h2>
              <div className="space-y-2.5">
                {group.runs.map((run) => (
                  <RunListItem key={run.runId} run={run} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </PageShell>
  );
}

// Active runs are the most important objects the user owns — full-width
// accent cards with one big Resume action.
function ActiveRunCard({ run }: { run: MyRunEntry }) {
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-primary/30 bg-primary/5 p-5 shadow-xs">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
        <CircleDot className="size-5 motion-safe:animate-pulse" aria-hidden />
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="truncate font-heading text-base font-semibold">
          {run.title}
        </p>
        <p className="text-xs text-muted-foreground">
          In progress · started {formatRelativeTime(run.createdAt)}
        </p>
      </div>
      <Button
        size="lg"
        render={<Link to="/runs/$runId" params={{ runId: run.runId }} />}
      >
        Resume
        <ArrowRight className="size-4" />
      </Button>
    </div>
  );
}
