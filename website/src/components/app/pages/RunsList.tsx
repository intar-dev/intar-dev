import { Link } from "@tanstack/react-router";
import { ArrowRight, BookOpen, CircleDot, History } from "lucide-react";
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
      eyebrow="Learn"
      description="Resume live work or study the record of a completed repair."
      width="content"
      density="comfortable"
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
        <div className="space-y-12">
          {activeRuns.length ? (
            <section className="space-y-4" aria-labelledby="active-runs-heading">
              <div>
                <p className="text-eyebrow">Continue</p>
                <h2 id="active-runs-heading" className="mt-2 text-section-title">
                  Active work
                </h2>
              </div>
              <div className="space-y-3">
                {activeRuns.map((run) => (
                  <ActiveRunCard key={run.runId} run={run} />
                ))}
              </div>
            </section>
          ) : null}

          {pastRuns.length ? (
            <section className="space-y-6" aria-labelledby="run-archive-heading">
              <div className="flex items-center gap-3 border-b pb-4">
                <History className="size-4 text-muted-foreground" />
                <div>
                  <p className="text-eyebrow">History</p>
                  <h2 id="run-archive-heading" className="mt-1 text-section-title">
                    Run archive
                  </h2>
                </div>
              </div>
              <div className="space-y-8">
                {groups.map((group) => (
                  <div key={group.label} className="space-y-3">
                    <h3 className="text-metadata font-semibold">{group.label}</h3>
                    <div className="divide-y border-y">
                      {group.runs.map((run) => (
                        <RunListItem key={run.runId} run={run} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </PageShell>
  );
}

// Active runs are the most important objects the user owns — full-width
// accent cards with one big Resume action.
function ActiveRunCard({ run }: { run: MyRunEntry }) {
  return (
    <article className="flex flex-col gap-4 rounded-xl border border-brand-border bg-brand-subtle p-4 sm:flex-row sm:items-center sm:p-6">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-card text-brand-text">
        <CircleDot className="size-5 motion-safe:animate-pulse" aria-hidden />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <h3 className="text-card-title text-balance">{run.title}</h3>
        <p className="text-metadata">
          In progress · started {formatRelativeTime(run.createdAt)}
        </p>
      </div>
      <Button
        size="lg"
        className="w-full sm:w-auto"
        render={<Link to="/runs/$runId" params={{ runId: run.runId }} />}
      >
        Resume
        <ArrowRight className="size-4" />
      </Button>
    </article>
  );
}
