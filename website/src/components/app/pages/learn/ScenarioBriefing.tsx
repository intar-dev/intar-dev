import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  ArrowRight,
  Clock3,
  History,
  Server,
  Trash2,
  Trophy,
} from "lucide-react";
import { Markdown } from "@/components/app/Markdown";
import { PageShell } from "@/components/app/patterns/PageShell";
import { PageHeader } from "@/components/app/patterns/PageHeader";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ScenarioObjective {
  probeName: string;
  vmName: string;
  label: string;
  title: string | null;
  bodyMarkdown: string | null;
  hintCount: number;
}

interface ScenarioDetail {
  scenarioId: string;
  slug: string;
  enabledAt: number;
  scenarioName: string;
  briefing: {
    title: string;
    tagline: string;
    difficulty: "easy" | "medium" | "hard";
    estimatedMinutes: number;
    briefingMarkdown: string;
    tags: string[];
    objectives: ScenarioObjective[];
  };
  vmCount: number;
  hasActiveRun: boolean;
  activeRunId: string | null;
  activeRun: {
    runId: string;
    phase:
      | "launching"
      | "booting"
      | "waiting_for_target"
      | "running"
      | "solved"
      | "deleting"
      | "archiving";
    phaseTitle: string;
    phaseDetail: string;
    canOpenTerminal?: boolean;
    terminalPhase?: "pending" | "ready" | "failed";
    updatedAt: number;
  } | null;
  finishedRuns: Array<{
    runId: string;
    phase: "completed" | "failed";
    outcome: "succeeded" | "cancelled" | "failed";
    createdAt: number;
    finishedAt: number;
    solvedAt: number | null;
    solveDurationMs: number | null;
    solutionAssisted: boolean;
    hasReplay: boolean;
  }>;
}

interface ScenarioDetailResponse {
  scenario: ScenarioDetail;
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
  const { scenarioId } = useParams({ from: "/app/scenarios/$scenarioId" });
  const [deleteTarget, setDeleteTarget] = useState<
    ScenarioDetail["finishedRuns"][number] | null
  >(null);

  const scenarioQuery = useQuery({
    queryKey: ["scenarios", "detail", scenarioId],
    queryFn: () => fetchScenarioDetail(scenarioId),
    staleTime: 10_000,
    refetchInterval: (query) =>
      query.state.data?.scenario.hasActiveRun ? 1_500 : false,
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
      await scenarioQuery.refetch();
    },
  });

  const scenarioData = scenarioQuery.data?.scenario ?? null;
  const finishedRuns = scenarioData?.finishedRuns ?? [];
  useBreadcrumbLabel(scenarioData?.briefing.title);

  const bestSolveMs = finishedRuns
    .filter((run) => run.outcome === "succeeded" && run.solveDurationMs !== null)
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
    <PageShell title="Scenario briefing" description="" showHeader={false}>
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
        <LoadingState title="Loading briefing" />
      ) : (
        <>
          <PageHeader
            backLink={{ to: "/scenarios", label: "All scenarios" }}
            title={scenarioData.briefing.title}
            description={scenarioData.briefing.tagline}
            meta={
              <>
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
                {scenarioData.briefing.tags.map((tag) => (
                  <MetaChip key={tag} variant="outline">
                    {tag}
                  </MetaChip>
                ))}
              </>
            }
          />

          <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="space-y-10">
              <div className="max-w-3xl text-[0.95rem] leading-7">
                <Markdown>{scenarioData.briefing.briefingMarkdown}</Markdown>
              </div>

              {scenarioData.briefing.objectives.length ? (
                <Card>
                  <CardHeader>
                    <CardTitle>Objectives</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ol className="space-y-3">
                      {scenarioData.briefing.objectives.map(
                        (objective, index) => (
                          <li
                            key={`${objective.probeName}-${index}`}
                            className="flex items-start gap-3"
                          >
                            <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground">
                              {index + 1}
                            </span>
                            <div className="min-w-0 space-y-0.5 pt-0.5">
                              <p className="text-sm font-medium">
                                {objective.title?.trim() || objective.label}
                              </p>
                              {objective.hintCount > 0 ? (
                                <p className="text-caption">
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

              {finishedRuns.length ? (
                <section className="space-y-3">
                  <div className="flex items-center gap-2">
                    <History className="size-4 text-muted-foreground" />
                    <h2 className="text-section-title">Previous runs</h2>
                  </div>
                  <div className="space-y-2.5">
                    {finishedRuns.map((run) => (
                      <RunListItem
                        key={run.runId}
                        run={{
                          runId: run.runId,
                          title: describeFinishedRun(run),
                          outcome: run.outcome,
                          active: false,
                          createdAt: run.createdAt,
                          solveDurationMs: null,
                          solutionAssisted: run.solutionAssisted,
                          hasReplay: run.hasReplay,
                        }}
                        trailing={
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className="text-muted-foreground hover:text-destructive"
                            onClick={() => setDeleteTarget(run)}
                            aria-label="Delete run"
                            title="Delete run"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        }
                      />
                    ))}
                  </div>
                </section>
              ) : null}
            </div>

            <aside className="top-24 space-y-4 lg:sticky">
              <Card>
                <CardContent className="space-y-4">
                  <Button
                    size="lg"
                    className="w-full"
                    onClick={handlePrimaryAction}
                    disabled={
                      startScenario.isPending ||
                      (scenarioData.hasActiveRun && !scenarioData.activeRunId)
                    }
                  >
                    {startScenario.isPending
                      ? "Starting…"
                      : scenarioData.hasActiveRun
                        ? "Resume run"
                        : "Start scenario"}
                    <ArrowRight className="size-4" />
                  </Button>
                  {startScenario.error ? (
                    <p className="text-sm text-destructive">
                      {startScenario.error instanceof Error
                        ? startScenario.error.message
                        : "Failed to start scenario"}
                    </p>
                  ) : null}
                  {scenarioData.activeRun ? (
                    <div className="space-y-1 rounded-xl bg-muted/50 px-4 py-3">
                      <p className="text-sm font-medium">
                        {scenarioData.activeRun.phaseTitle}
                      </p>
                      <p className="text-caption">
                        {scenarioData.activeRun.phaseDetail}
                      </p>
                      <p className="text-caption">
                        Updated{" "}
                        {formatTimestamp(scenarioData.activeRun.updatedAt)}
                      </p>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Runs in your browser — nothing to install.
                    </p>
                  )}
                  {bestSolveMs !== null ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Trophy className="size-4 text-warning" />
                      Best time: {formatDurationMs(bestSolveMs)}
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            </aside>
          </div>

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
                <DialogTitle>Delete this run?</DialogTitle>
                <DialogDescription>
                  This removes the run and everything saved with it from your
                  history. This action cannot be undone.
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
                      deleteRun.mutate(deleteTarget.runId);
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
    scenario: Parameters<typeof presentScenarioDetail>[0];
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

function describeFinishedRun(run: ScenarioDetail["finishedRuns"][number]) {
  if (run.outcome === "succeeded" && run.solveDurationMs !== null) {
    return `Solved in ${formatDurationMs(run.solveDurationMs)}`;
  }
  if (run.outcome === "succeeded") {
    return "Solved successfully";
  }
  if (run.outcome === "cancelled") {
    return "Ended early";
  }
  return "Run failed";
}
