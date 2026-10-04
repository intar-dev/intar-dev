import { Link } from "@tanstack/react-router";
import { ArrowRight, BookOpen, ChevronDown, History } from "lucide-react";
import { PageShell } from "../patterns/PageShell";
import {
  COLLECTION_PAGE_SIZE,
  PaginatedCollection,
} from "../patterns/CollectionPagination";
import { RunListItem } from "../patterns/RunListItem";
import { ListSkeleton } from "../patterns/Skeletons";
import { MetaLine } from "../patterns/MetaLine";
import { RelativeTime } from "../patterns/RelativeTime";
import { StatusToken } from "../patterns/StatusToken";
import { EmptyState, ErrorState, StaleNotice } from "../patterns/StateCard";
import {
  groupMyRunsByActivity,
  useMyRuns,
  type MyRunEntry,
} from "../hooks/useMyRuns";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

export interface RunAttempt {
  run: MyRunEntry;
  /** Per-scenario ordinal, with the earliest retained run numbered 1. */
  attemptNumber: number;
}

export interface SettledRunGroup {
  key: string;
  title: string;
  latest: RunAttempt;
  older: RunAttempt[];
  totalAttempts: number;
}

function settledRunGroupKey(run: MyRunEntry): string {
  // Scenario IDs can be reused by different organizations. Keep their
  // histories separate even when their learner-facing titles are identical.
  return `${run.organizationId ?? "public"}\u0000${run.scenarioId}`;
}

/**
 * Collapses a user's settled history to one latest row per scenario, while
 * retaining ordered attempt rows for an on-demand disclosure.
 */
export function groupSettledRunsByScenario(
  runs: readonly MyRunEntry[],
): SettledRunGroup[] {
  const entriesByScenario = new Map<string, MyRunEntry[]>();
  const chronologicalRuns = [...runs].sort(
    (left, right) =>
      left.createdAt - right.createdAt || left.runId.localeCompare(right.runId),
  );

  for (const run of chronologicalRuns) {
    const key = settledRunGroupKey(run);
    const entries = entriesByScenario.get(key);
    if (entries) entries.push(run);
    else entriesByScenario.set(key, [run]);
  }

  return Array.from(entriesByScenario, ([key, entries]) => {
    const attempts = entries.map((run, index) => ({
      run,
      attemptNumber: index + 1,
    }));
    const latest = attempts.at(-1);
    if (!latest) {
      throw new Error("A settled run group must contain at least one run");
    }
    return {
      key,
      title: latest.run.title,
      latest,
      older: attempts.slice(0, -1).reverse(),
      totalAttempts: attempts.length,
    };
  }).sort(
    (left, right) =>
      right.latest.run.createdAt - left.latest.run.createdAt ||
      left.key.localeCompare(right.key),
  );
}

export function RunsList() {
  const runs = useMyRuns();

  const entries = runs.data?.runs ?? [];
  const groupedRuns = groupMyRunsByActivity(entries);
  const activeRuns = groupedRuns.foreground;
  const backgroundRuns = groupedRuns.background;
  const pastRuns = groupedRuns.settled;
  const pastRunGroups = groupSettledRunsByScenario(pastRuns);

  return (
    <PageShell density="comfortable">
      {runs.isLoadingError ? (
        <ErrorState
          title="Could not load runs"
          description={
            runs.error instanceof Error
              ? runs.error.message
              : "Refresh the page to try again."
          }
          onRetry={() => runs.refetch()}
        />
      ) : runs.isPending ? (
        <ListSkeleton />
      ) : !entries.length ? (
        <EmptyState
          icon={<BookOpen />}
          title="No runs yet"
          description="Launch a scenario to get a VM-backed environment — finished runs keep their replay here."
          action={
            <Button size="sm" render={<Link to="/courses" />}>
              Browse courses
            </Button>
          }
        />
      ) : (
        <>
          {runs.isRefetchError ? <StaleNotice what="Your runs" /> : null}
          {activeRuns.length ? (
            <section
              className="space-y-4"
              aria-labelledby="active-runs-heading"
            >
              <div>
                <h2
                  id="active-runs-heading"
                  className="text-section-title"
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
              <div className="flex items-center gap-3">
                <h2
                  id="background-runs-heading"
                  className="text-section-title"
                >
                  Finishing in background
                </h2>
              </div>
              <PaginatedCollection
                items={backgroundRuns}
                pageSize={COLLECTION_PAGE_SIZE.list}
                itemLabel="finishing runs"
              >
                {(visibleRuns) => (
                  <div className="divide-y overflow-hidden rounded-xl border bg-card shadow-[var(--highlight),var(--shadow-raised)]">
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
              className="space-y-4"
              aria-labelledby="run-archive-heading"
            >
              <div className="flex items-center gap-3">
                <History className="size-4 text-muted-foreground" />
                <h2
                  id="run-archive-heading"
                  className="text-section-title"
                >
                  History
                </h2>
              </div>
              <PaginatedCollection
                items={pastRunGroups}
                pageSize={COLLECTION_PAGE_SIZE.list}
                itemLabel="scenarios with past runs"
                resetKey={pastRuns.map((run) => run.runId).join("|")}
              >
                {(visibleGroups) => (
                  <div className="divide-y overflow-hidden rounded-xl border bg-card shadow-[var(--highlight),var(--shadow-raised)]">
                    {visibleGroups.map((group) => (
                      <SettledRunGroupCard key={group.key} group={group} />
                    ))}
                  </div>
                )}
              </PaginatedCollection>
            </section>
          ) : null}
        </>
      )}
    </PageShell>
  );
}

function SettledRunGroupCard({ group }: { group: SettledRunGroup }) {
  const olderAttemptCount = group.older.length;
  return (
    <section
      aria-label={`${group.title} run history`}
    >
      {olderAttemptCount ? (
        <div className="flex items-center justify-between gap-3 border-b bg-muted/30 px-4 py-2">
          <p className="text-metadata font-semibold">Latest attempt</p>
          <p className="text-caption tabular-nums">
            {group.totalAttempts} attempts
          </p>
        </div>
      ) : null}
      <RunListItem
        run={{ ...group.latest.run, attemptNumber: group.latest.attemptNumber }}
      />
      {olderAttemptCount ? (
        <Collapsible>
          <div className="border-t px-4 py-3">
            <CollapsibleTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={`Show all ${group.totalAttempts} attempts for ${group.title}`}
                />
              }
            >
              Show all {group.totalAttempts} attempts
              <ChevronDown className="size-3.5 transition-transform duration-(--duration-moderate) ease-enter group-data-[panel-open]/button:rotate-180" />
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-3">
              <div className="divide-y overflow-hidden rounded-lg border bg-background">
                {group.older.map((attempt) => (
                  <RunListItem
                    key={attempt.run.runId}
                    run={{ ...attempt.run, attemptNumber: attempt.attemptNumber }}
                  />
                ))}
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>
      ) : null}
    </section>
  );
}

// Active runs are the most important objects the user owns — full-width
// accent cards with one big Resume action.
function ActiveRunCard({ run }: { run: MyRunEntry }) {
  return (
    <article className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-[var(--highlight),var(--shadow-raised)] sm:flex-row sm:items-center sm:gap-4 sm:p-5">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-[0.625rem] bg-brand-subtle text-brand-text ring-1 ring-brand-border/60">
        <span
          className="size-2 rounded-full bg-primary text-primary"
          aria-hidden
        />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <h3 className="text-card-title text-balance">{run.title}</h3>
        <MetaLine
          items={[
            <StatusToken key="status" tone="live" word="In progress" />,
            run.courseLocation?.courseTitle ?? null,
            <span key="started">
              started <RelativeTime at={run.createdAt} />
            </span>,
          ]}
        />
      </div>
      {/* Match the run workspace Back link: document navigation avoids the
          current router intent-preload failure on repeated resume cycles. */}
      <Button
        className="w-full sm:w-auto"
        render={<a href={`/runs/${encodeURIComponent(run.runId)}`} />}
      >
        Resume
        <ArrowRight className="size-4" />
      </Button>
    </article>
  );
}
