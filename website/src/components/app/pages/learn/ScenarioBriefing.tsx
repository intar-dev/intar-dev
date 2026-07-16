import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  ArrowRight,
  ChevronDown,
  History,
  Trash2,
  Trophy,
} from "lucide-react";
import { Markdown } from "@/components/app/Markdown";
import { PageShell } from "@/components/app/patterns/PageShell";
import { ContentHeader } from "@/components/app/patterns/ContentHeader";
import { InlineFeedback } from "@/components/app/patterns/InlineFeedback";
import { MetaDifficulty, MetaLine } from "@/components/app/patterns/MetaLine";
import { RunListItem } from "@/components/app/patterns/RunListItem";
import { ErrorState } from "@/components/app/patterns/StateCard";
import { usePageChrome } from "@/components/app/shell/page-chrome";
import {
  formatDurationMs,
  formatTimestamp,
} from "@/components/app/lib/format";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { presentScenarioDetail, presentScenarioRun } from "@/lib/run-phase";
import type { ScenarioDetail } from "@/lib/scenario-runs";
import {
  requestScenarioStartWithCapacityWait,
  ScenarioStartCancelledError,
} from "@/components/app/lib/scenario-start";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type PresentedScenarioDetail = ReturnType<typeof presentScenarioDetail>;
type FinishedRun = PresentedScenarioDetail["finishedRuns"][number];

interface DeleteTarget {
  run: FinishedRun;
  attemptNumber: number;
}

interface ScenarioDetailResponse {
  scenario: PresentedScenarioDetail;
}

export function ScenarioBriefing() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { scenarioId } = useParams({ from: "/app/scenarios/$scenarioId" });
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [waitingForCapacity, setWaitingForCapacity] = useState(false);
  const startAbortRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      startAbortRef.current?.abort();
    },
    [],
  );

  const scenarioQuery = useQuery({
    queryKey: ["scenarios", "detail", scenarioId],
    queryFn: () => fetchScenarioDetail(scenarioId),
    staleTime: 10_000,
    refetchInterval: (query) =>
      query.state.data?.scenario.hasActiveRun
        ? 1_500
        : query.state.data?.scenario.blockingRun
          ? 5_000
          : false,
  });

  const startScenario = useMutation({
    mutationFn: async () => {
      const controller = new AbortController();
      startAbortRef.current = controller;
      setWaitingForCapacity(false);
      return requestScenarioStartWithCapacityWait(scenarioId, {
        signal: controller.signal,
        onCapacityWait: () => setWaitingForCapacity(true),
      });
    },
    onSuccess: (result) => {
      queryClient.setQueryData(["scenarios", "run", result.runId], {
        run: presentScenarioRun(result.run),
      });
      void queryClient.invalidateQueries({ queryKey: ["scenario-runs", "list"] });
      void queryClient.invalidateQueries({
        queryKey: ["scenarios", "detail", scenarioId],
      });
      void navigate({
        to: "/runs/$runId",
        params: { runId: result.runId },
      });
    },
    onSettled: () => {
      startAbortRef.current = null;
      setWaitingForCapacity(false);
    },
  });

  const deleteRun = useMutation({
    mutationFn: async (runId: string) => {
      const response = await fetch(
        `/api/scenarios/runs/${encodeURIComponent(runId)}`,
        {
          method: "DELETE",
          credentials: "include",
        },
      );

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          body?.error ?? `Failed to delete run (${response.status})`,
        );
      }
    },
    onSuccess: async () => {
      setDeleteTarget(null);
      await Promise.all([
        scenarioQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["scenarios", "list"] }),
        queryClient.invalidateQueries({ queryKey: ["scenario-runs", "list"] }),
      ]);
    },
  });

  const scenarioData = scenarioQuery.data?.scenario ?? null;
  const finishedRuns = scenarioData?.finishedRuns ?? [];
  // A solve counts even when teardown later failed or the run was destroyed
  // afterwards — same semantics as the catalog's ScenarioProgress.
  const succeededRuns = finishedRuns.filter((run) => run.solvedAt !== null);
  // finishedRuns arrives newest-first from the API.
  const runsWithAttemptNumbers = finishedRuns.map((run, index) => ({
    run,
    attemptNumber: finishedRuns.length - index,
  }));
  const recentRuns = runsWithAttemptNumbers.slice(0, 5);
  const olderRuns = runsWithAttemptNumbers.slice(5);
  const solved = succeededRuns.length > 0;
  usePageChrome({
    title: scenarioData?.briefing.title,
    status: useMemo(
      () => (solved ? <Badge variant="success">Solved</Badge> : undefined),
      [solved],
    ),
  });

  const bestSolveMs = succeededRuns
    .filter((run) => run.solveDurationMs !== null)
    .reduce<number | null>(
      (best, run) =>
        best === null
          ? run.solveDurationMs
          : Math.min(best, run.solveDurationMs ?? best),
      null,
    );

  const handlePrimaryAction = () => {
    if (scenarioData?.hasActiveRun && scenarioData.activeRunId) {
      void navigate({
        to: "/runs/$runId",
        params: { runId: scenarioData.activeRunId },
      });
      return;
    }

    startScenario.mutate();
  };

  const stopWaitingForCapacity = () => {
    startAbortRef.current?.abort();
    setWaitingForCapacity(false);
  };

  return (
    <PageShell width="content" density="comfortable">
      {scenarioQuery.error ? (
        <ErrorState
          title="Could not load scenario"
          description={
            scenarioQuery.error instanceof Error
              ? scenarioQuery.error.message
              : "Failed to load scenario briefing"
          }
          onRetry={() => void scenarioQuery.refetch()}
        />
      ) : !scenarioData ? (
        <div role="status" className="space-y-8">
          <span className="sr-only">Loading…</span>
          <div className="space-y-2">
            <Skeleton className="h-7 w-72 max-w-full" />
            <Skeleton className="h-4 w-96 max-w-full" />
            <Skeleton className="h-3 w-64" />
          </div>
          <div className="grid items-start gap-12 lg:grid-cols-[minmax(0,1fr)_21rem]">
            <Skeleton className="h-64 rounded-xl" />
            <Skeleton className="h-48 rounded-xl" />
          </div>
        </div>
      ) : (
        <>
          <ContentHeader
            title={scenarioData.briefing.title}
            badge={solved ? <Badge variant="success">Solved</Badge> : undefined}
            summary={scenarioData.briefing.tagline}
            meta={
              <MetaLine
                items={[
                  scenarioData.briefing.category,
                  <MetaDifficulty
                    key="difficulty"
                    difficulty={scenarioData.briefing.difficulty}
                  />,
                  `~${scenarioData.briefing.estimatedMinutes} min`,
                  scenarioData.vmCount === 1
                    ? "1 machine"
                    : `${scenarioData.vmCount} machines`,
                ]}
              />
            }
          />

          <div className="grid items-start gap-12 lg:grid-cols-[minmax(0,1fr)_21rem]">
            <div className="space-y-12">
              {scenarioData.briefing.objectives.length ? (
                <Card as="section" aria-labelledby="objectives-heading">
                  <CardHeader className="gap-2 border-b">
                    <p className="text-eyebrow">Work order</p>
                    <CardTitle as="h2" id="objectives-heading" className="text-section-title">
                      Repair objectives
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ol className="divide-y">
                      {scenarioData.briefing.objectives.map(
                        (objective, index) => (
                          <li
                            key={`${objective.probeName}-${index}`}
                            className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3 py-4 first:pt-0 last:pb-0"
                          >
                            <span className="font-heading text-sm font-semibold text-brand-text tabular-nums">
                              {String(index + 1).padStart(2, "0")}
                            </span>
                            <div className="min-w-0 space-y-1">
                              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                                <p className="font-semibold">
                                  {objective.title?.trim() || objective.label}
                                </p>
                                {scenarioData.vmCount > 1 ? (
                                  <code className="text-caption">
                                    {objective.vmName}
                                  </code>
                                ) : null}
                              </div>
                              {objective.hintCount > 0 ? (
                                <p className="text-metadata">
                                  {objective.hintCount} hint
                                  {objective.hintCount === 1 ? "" : "s"}{" "}
                                  available
                                </p>
                              ) : null}
                            </div>
                          </li>
                        ),
                      )}
                    </ol>
                  </CardContent>
                </Card>
              ) : null}

              <section className="space-y-4" aria-labelledby="briefing-heading">
                <div>
                  <p className="text-eyebrow">Incident context</p>
                  <h2 id="briefing-heading" className="mt-2 text-section-title">
                    Briefing
                  </h2>
                </div>
                <div className="prose-measure text-body leading-7">
                  <Markdown>{scenarioData.briefing.briefingMarkdown}</Markdown>
                </div>
              </section>

              <details className="rounded-lg border bg-card">
                <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 py-2 text-sm font-semibold marker:hidden">
                  <ChevronDown className="size-4 text-muted-foreground" />
                  Technical details
                </summary>
                <div className="border-t px-4 py-2">
                  <dl className="divide-y text-sm">
                    <TechnicalDetail label="Scenario ID">
                      <code className="break-all">{scenarioData.scenarioId}</code>
                    </TechnicalDetail>
                    <TechnicalDetail label="Definition">
                      <code className="break-all">{scenarioData.scenarioName}</code>
                    </TechnicalDetail>
                    <TechnicalDetail label="Published">
                      {formatTimestamp(scenarioData.enabledAt)}
                    </TechnicalDetail>
                    <TechnicalDetail label="Tags">
                      {scenarioData.briefing.tags.length
                        ? scenarioData.briefing.tags.join(", ")
                        : "None"}
                    </TechnicalDetail>
                  </dl>
                </div>
              </details>
            </div>

            <aside className="space-y-6 lg:sticky lg:top-24">
              <section className="space-y-4 rounded-xl border border-brand-border bg-brand-subtle p-6">
                <div>
                  <p className="text-eyebrow text-brand-text">Next action</p>
                  <h2 className="mt-2 text-section-title">
                    {scenarioData.hasActiveRun
                      ? "Continue the repair"
                      : "Open a fresh sandbox"}
                  </h2>
                </div>
                <Button
                  size="lg"
                  className="w-full"
                  onClick={handlePrimaryAction}
                  disabled={
                    startScenario.isPending ||
                    scenarioData.blockingRun !== null ||
                    (scenarioData.hasActiveRun && !scenarioData.activeRunId)
                  }
                >
                  {startScenario.isPending
                    ? "Starting scenario…"
                    : scenarioData.hasActiveRun
                      ? "Resume run"
                      : "Start scenario"}
                  <ArrowRight className="size-4" />
                </Button>
                {scenarioData.blockingRun ? (
                  <div className="space-y-3 border-t border-brand-border pt-4">
                    <p className="text-sm leading-6 text-muted-foreground">
                      An active run on{" "}
                      <span className="font-semibold text-foreground">
                        {scenarioData.blockingRun.title}
                      </span>{" "}
                      must end before another sandbox can start.
                    </p>
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={() =>
                        void navigate({
                          to: "/runs/$runId",
                          params: { runId: scenarioData.blockingRun?.runId ?? "" },
                        })
                      }
                    >
                      Go to active run
                      <ArrowRight className="size-4" />
                    </Button>
                  </div>
                ) : null}
                {startScenario.error &&
                !(startScenario.error instanceof ScenarioStartCancelledError) ? (
                  <InlineFeedback tone="error">
                    {startScenario.error instanceof Error
                      ? startScenario.error.message
                      : "The scenario could not be started."}
                  </InlineFeedback>
                ) : startScenario.isPending ? (
                  <div className="space-y-2">
                    <InlineFeedback tone="pending">
                      {waitingForCapacity
                        ? "VM capacity is temporarily busy. Retrying automatically for up to 60 seconds."
                        : "Requesting VM capacity…"}
                    </InlineFeedback>
                    {waitingForCapacity ? (
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11 w-full"
                        onClick={stopWaitingForCapacity}
                      >
                        Stop waiting
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </section>

              {scenarioData.activeRun ? (
                <section className="space-y-2 border-y py-4">
                  <p className="text-eyebrow">Live status</p>
                  <p className="font-semibold">{scenarioData.activeRun.phaseTitle}</p>
                  <p className="text-metadata">{scenarioData.activeRun.phaseDetail}</p>
                  <p className="text-caption">
                    Updated {formatTimestamp(scenarioData.activeRun.updatedAt)}
                  </p>
                </section>
              ) : null}

              {finishedRuns.length ? (
                <dl className="grid grid-cols-2 gap-4 border-y py-4">
                  <div>
                    <dt className="text-eyebrow">Best time</dt>
                    <dd className="mt-2 inline-flex items-center gap-2 font-semibold tabular-nums">
                      {bestSolveMs !== null ? (
                        <>
                          <Trophy className="size-4 text-warning" />
                          {formatDurationMs(bestSolveMs)}
                        </>
                      ) : (
                        "—"
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-eyebrow">Attempts</dt>
                    <dd>
                      <span className="mt-2 block font-semibold tabular-nums">
                        {finishedRuns.length}
                      </span>
                      <span className="block text-caption">
                        {succeededRuns.length} solved
                      </span>
                    </dd>
                  </div>
                </dl>
              ) : null}

              {!finishedRuns.length && !scenarioData.activeRun ? (
                <p className="border-y py-4 text-sm text-muted-foreground">
                  The browser shell needs no local installation. Native SSH is
                  also available after launch.
                </p>
              ) : null}
            </aside>
          </div>

          {finishedRuns.length ? (
            <section className="space-y-4" aria-labelledby="previous-runs-heading">
              <div className="flex items-center gap-3 border-b pb-4">
                <History className="size-4 text-muted-foreground" />
                <div>
                  <p className="text-eyebrow">History</p>
                  <h2 id="previous-runs-heading" className="mt-1 text-section-title">
                    Previous runs
                  </h2>
                </div>
              </div>
              <div className="divide-y border-y">
                {recentRuns.map(({ run, attemptNumber }) => (
                  <PreviousRunRow
                    key={run.runId}
                    run={run}
                    attemptNumber={attemptNumber}
                    onDelete={() => setDeleteTarget({ run, attemptNumber })}
                  />
                ))}
              </div>
              {olderRuns.length ? (
                <Collapsible>
                  <CollapsibleTrigger
                    render={<Button type="button" variant="outline" size="sm" />}
                  >
                    Show all {finishedRuns.length} runs
                    <ChevronDown className="size-3.5" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="mt-3 divide-y border-y">
                    {olderRuns.map(({ run, attemptNumber }) => (
                      <PreviousRunRow
                        key={run.runId}
                        run={run}
                        attemptNumber={attemptNumber}
                        onDelete={() => setDeleteTarget({ run, attemptNumber })}
                      />
                    ))}
                  </CollapsibleContent>
                </Collapsible>
              ) : null}
            </section>
          ) : null}

          <Dialog
            open={deleteTarget !== null}
            onOpenChange={(open) => {
              if (!open) {
                setDeleteTarget(null);
              }
            }}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  Delete attempt {deleteTarget?.attemptNumber ?? ""}?
                </DialogTitle>
                <DialogDescription>
                  This permanently removes this run, its checks, and its replay
                  from your history. This action cannot be undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setDeleteTarget(null)}
                  disabled={deleteRun.isPending}
                >
                  Keep run
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    if (deleteTarget) {
                      deleteRun.mutate(deleteTarget.run.runId);
                    }
                  }}
                  disabled={deleteRun.isPending || !deleteTarget}
                >
                  <Trash2 className="size-4" />
                  {deleteRun.isPending ? "Deleting…" : "Delete run"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </PageShell>
  );
}

async function fetchScenarioDetail(scenarioId: string) {
  const response = await fetch(
    `/api/scenarios/${encodeURIComponent(scenarioId)}`,
    {
      method: "GET",
      credentials: "include",
    },
  );

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      body?.error ?? `Failed to load scenario (${response.status})`,
    );
  }

  const body = (await response.json()) as {
    scenario: ScenarioDetail;
  };
  return {
    scenario: presentScenarioDetail(body.scenario),
  } satisfies ScenarioDetailResponse;
}

function TechnicalDetail({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-medium sm:text-right">{children}</dd>
    </div>
  );
}

function PreviousRunRow({
  run,
  attemptNumber,
  onDelete,
}: {
  run: FinishedRun;
  attemptNumber: number;
  onDelete: () => void;
}) {
  return (
    <RunListItem
      run={{
        runId: run.runId,
        title: `Attempt ${attemptNumber}`,
        outcome: run.outcome,
        active: false,
        createdAt: run.createdAt,
        solveDurationMs: run.solveDurationMs,
        solutionAssisted: run.solutionAssisted,
        hasReplay: run.hasReplay,
      }}
      trailing={
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-destructive"
          onClick={onDelete}
          aria-label="Delete run"
          title="Delete run"
        >
          <Trash2 className="size-4" />
        </Button>
      }
    />
  );
}
