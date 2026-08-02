import { Link } from "@tanstack/react-router";
import {
  ArrowRight,
  BookOpen,
  CircleDot,
  History,
  LoaderCircle,
} from "lucide-react";
import { PageShell } from "../patterns/PageShell";
import {
  COLLECTION_PAGE_SIZE,
  PaginatedCollection,
} from "../patterns/CollectionPagination";
import { RunListItem } from "../patterns/RunListItem";
import { ListSkeleton } from "../patterns/Skeletons";
import { EmptyState, ErrorState } from "../patterns/StateCard";
import {
  groupMyRunsByActivity,
  useMyRuns,
  type MyRunEntry,
} from "../hooks/useMyRuns";
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
  const groupedRuns = groupMyRunsByActivity(entries);
  const activeRuns = groupedRuns.foreground;
  const backgroundRuns = groupedRuns.background;
  const pastRuns = groupedRuns.settled;

  const now = Date.now();
  return (
    <PageShell width="content" density="comfortable">
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
      ) : runs.isPending ? (
        <ListSkeleton />
      ) : !entries.length ? (
        <EmptyState
          icon={<BookOpen />}
          title="No runs yet"
          description="Launch a scenario to get a VM-backed environment — finished runs keep their replay here."
          action={
            <Button render={<Link to="/courses" />}>
              <BookOpen className="size-4" />
              Browse courses
            </Button>
          }
        />
      ) : (
        <div className="space-y-12">
          {activeRuns.length ? (
            <section
              className="space-y-4"
              aria-labelledby="active-runs-heading"
            >
              <div>
                <p className="text-eyebrow">Continue</p>
                <h2
                  id="active-runs-heading"
                  className="mt-2 text-section-title"
                >
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

          {backgroundRuns.length ? (
            <section
              className="space-y-4"
              aria-labelledby="background-runs-heading"
            >
              <div className="flex items-center gap-3 border-b pb-4">
                <LoaderCircle
                  className="size-4 text-primary motion-safe:animate-spin"
                  aria-hidden="true"
                />
                <div>
                  <p className="text-eyebrow">Cleanup continues</p>
                  <h2
                    id="background-runs-heading"
                    className="mt-1 text-section-title"
                  >
                    Finishing in background
                  </h2>
                </div>
              </div>
              <PaginatedCollection
                items={backgroundRuns}
                pageSize={COLLECTION_PAGE_SIZE.list}
                itemLabel="finishing runs"
              >
                {(visibleRuns) => (
                  <div className="divide-y overflow-hidden rounded-xl border bg-card">
                    {visibleRuns.map((run) => (
                      <RunListItem key={run.runId} run={run} />
                    ))}
                  </div>
                )}
              </PaginatedCollection>
            </section>
          ) : null}

          {pastRuns.length ? (
            <section
              className="space-y-6"
              aria-labelledby="run-archive-heading"
            >
              <div className="flex items-center gap-3 border-b pb-4">
                <History className="size-4 text-muted-foreground" />
                <div>
                  <p className="text-eyebrow">Past runs</p>
                  <h2
                    id="run-archive-heading"
                    className="mt-1 text-section-title"
                  >
                    History
                  </h2>
                </div>
              </div>
              <PaginatedCollection
                items={pastRuns}
                pageSize={COLLECTION_PAGE_SIZE.list}
                itemLabel="past runs"
              >
                {(visibleRuns) => (
                  <div className="space-y-8">
                    {groupPastRuns(visibleRuns, now).map((group) => (
                      <div key={group.label} className="space-y-3">
                        <h3 className="text-metadata font-semibold">
                          {group.label}
                        </h3>
                        <div className="divide-y overflow-hidden rounded-xl border bg-card">
                          {group.runs.map((run) => (
                            <RunListItem key={run.runId} run={run} />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </PaginatedCollection>
            </section>
          ) : null}
        </div>
      )}
    </PageShell>
  );
}

function groupPastRuns(runs: MyRunEntry[], now: number) {
  const groups: Array<{ label: string; runs: MyRunEntry[] }> = [];
  for (const run of runs) {
    const label = groupLabel(run, now);
    const group = groups.find((entry) => entry.label === label);
    if (group) group.runs.push(run);
    else groups.push({ label, runs: [run] });
  }
  return groups;
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
