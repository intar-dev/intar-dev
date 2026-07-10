import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  ArrowRight,
  ChevronDown,
  Clock3,
  History,
  Server,
  Trash2,
  Trophy,
} from "lucide-react";
import { Markdown } from "@/components/app/Markdown";
import { PageShell } from "@/components/app/patterns/PageShell";
import { PageHeader } from "@/components/app/patterns/PageHeader";
import { InlineFeedback } from "@/components/app/patterns/InlineFeedback";
import {
  DifficultyChip,
  MetaChip,
} from "@/components/app/patterns/MetaChip";
import { RunListItem } from "@/components/app/patterns/RunListItem";
import { ErrorState, LoadingState } from "@/components/app/patterns/StateCard";
import { useBreadcrumbLabel } from "@/components/app/shell/breadcrumbs";
import {
  formatDurationMs,
  formatTimestamp,
} from "@/components/app/lib/format";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { presentScenarioDetail } from "@/lib/run-phase";
import type { ScenarioDetail } from "@/lib/scenario-runs";
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

interface ScenarioStartAcceptedResponse {
  accepted: true;
  runId: string;
  scenarioId: string;
  acceptedAt: number;
  reused: boolean;
}

export function ScenarioBriefing() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { scenarioId } = useParams({ from: "/app/scenarios/$scenarioId" });
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

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
    mutationFn: () => requestScenarioStart(scenarioId),
    onSuccess: (runId) => {
      window.location.assign(`/runs/${encodeURIComponent(runId)}?pending=1`);
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
  useBreadcrumbLabel(scenarioData?.briefing.title);

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

  return (
    <PageShell
      title="Scenario briefing"
      description=""
      showHeader={false}
      width="content"
      density="comfortable"
    >
      {scenarioQuery.error ? (
        <ErrorState
          title="Could not load scenario"
          description={
            scenarioQuery.error instanceof Error
              ? scenarioQuery.error.message
              : "Failed to load scenario briefing"
          }
          onRetry={() => void scenarioQuery.refetch()}
          headingLevel={1}
        />
      ) : !scenarioData ? (
        <LoadingState title="Loading briefing" headingLevel={1} />
      ) : (
        <>
          <PageHeader
            backLink={{ to: "/scenarios", label: "All scenarios" }}
            title={
              <span className="inline-flex flex-wrap items-center gap-3">
                {scenarioData.briefing.title}
                {succeededRuns.length ? (
                  <Badge variant="success">Solved</Badge>
                ) : null}
              </span>
            }
            description={scenarioData.briefing.tagline}
            meta={
              <>
                <MetaChip variant="outline">
                  {scenarioData.briefing.category}
                </MetaChip>
                <DifficultyChip
                  difficulty={scenarioData.briefing.difficulty}
                />
                <MetaChip icon={<Clock3 />}>
                  ~{scenarioData.briefing.estimatedMinutes} min
                </MetaChip>
                <MetaChip icon={<Server />}>
                  {scenarioData.vmCount === 1
                    ? "1 machine"
                    : `${scenarioData.vmCount} machines`}
                </MetaChip>
              </>
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
                    ? "Starting sandbox…"
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
                {startScenario.error ? (
                  <InlineFeedback tone="error">
                    {startScenario.error instanceof Error
                      ? startScenario.error.message
                      : "The scenario could not be started."}
                  </InlineFeedback>
                ) : startScenario.isPending ? (
                  <InlineFeedback tone="pending">
                    Allocating the scenario run…
                  </InlineFeedback>
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

async function requestScenarioStart(scenarioId: string) {
  const response = await fetch(
    `/api/scenarios/${encodeURIComponent(scenarioId)}/start`,
    {
      method: "POST",
      credentials: "include",
    },
  );

  const body = (await response.json().catch(() => null)) as
    | ScenarioStartAcceptedResponse
    | { error?: string }
    | null;

  if (
    !response.ok ||
    !body ||
    !("accepted" in body) ||
    body.accepted !== true ||
    typeof body.runId !== "string"
  ) {
    throw new Error(
      body && "error" in body && typeof body.error === "string"
        ? body.error
        : "Failed to start scenario",
    );
  }

  return body.runId;
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
