import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowRight,
  Clock3,
  History,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { SignedInShell } from "@/components/app/SignedInShell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toLegacyScenarioDetail } from "@/lib/legacy-scenario-ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

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
    objectives: string[];
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
  const { scenarioId } = useParams({ from: "/scenarios/$scenarioId" });
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
      window.location.assign(
        `/scenarios/runs/${encodeURIComponent(runId)}?pending=1`,
      );
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

  const handlePrimaryAction = () => {
    if (scenarioData?.hasActiveRun && scenarioData.activeRunId) {
      void navigate({
        to: "/scenarios/runs/$runId",
        params: { runId: scenarioData.activeRunId },
      });
      return;
    }

    startScenario.mutate();
  };

  return (
    <SignedInShell
      title={scenarioData?.briefing.title ?? "Scenario briefing"}
      description={
        scenarioData?.briefing.tagline ??
        "Read the objective, understand the constraints, then start the scenario when you are ready to drop into the shell."
      }
      compactHeader
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Button variant="ghost" asChild className="w-fit">
          <Link to="/scenarios">
            <ArrowLeft className="size-4" />
            Back to scenarios
          </Link>
        </Button>
        {scenarioData ? (
          <Button
            className="w-full sm:w-auto"
            onClick={handlePrimaryAction}
            disabled={
              startScenario.isPending ||
              (scenarioData.hasActiveRun && !scenarioData.activeRunId)
            }
          >
            {startScenario.isPending
              ? "Starting..."
              : scenarioData.hasActiveRun
                ? "Resume"
                : "Start"}
            <ArrowRight className="size-4" />
          </Button>
        ) : null}
      </div>

      {scenarioQuery.error ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load scenario</AlertTitle>
          <AlertDescription>
            {scenarioQuery.error instanceof Error
              ? scenarioQuery.error.message
              : "Failed to load scenario briefing"}
          </AlertDescription>
        </Alert>
      ) : null}

      {scenarioData ? (
        <div className="space-y-6">
          {scenarioData.activeRun ? (
            <Alert>
              <AlertTitle>Scenario already in progress</AlertTitle>
              <AlertDescription>
                <p>{scenarioData.activeRun.phaseDetail}</p>
                <p className="text-foreground/80">
                  {scenarioData.activeRun.phaseTitle} • Updated{" "}
                  {formatDateTime(scenarioData.activeRun.updatedAt)}
                </p>
              </AlertDescription>
            </Alert>
          ) : null}

          <Card>
            <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <CardTitle className="text-lg">Briefing</CardTitle>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                <DifficultyBadge difficulty={scenarioData.briefing.difficulty} />
                <MetaBadge
                  icon={<Clock3 className="size-4" />}
                  label={`${scenarioData.briefing.estimatedMinutes} min`}
                />
                <MetaBadge
                  icon={<ShieldCheck className="size-4" />}
                  label={`${scenarioData.vmCount} VM${scenarioData.vmCount === 1 ? "" : "s"}`}
                />
                <MetaBadge
                  label={`Enabled ${formatDate(scenarioData.enabledAt)}`}
                />
              </div>
            </CardHeader>
            <CardContent className="space-y-4 text-sm leading-7">
              {scenarioData.briefing.briefingMarkdown
                .split(/\n{2,}/)
                .map((paragraph) => paragraph.trim())
                .filter(Boolean)
                .map((paragraph, index) => (
                  <p key={index}>{paragraph}</p>
                ))}

              <div className="space-y-3 border-t pt-4">
                <h2 className="text-base font-semibold tracking-tight">
                  Objectives
                </h2>
                <ol className="list-decimal space-y-2 pl-5 marker:font-medium marker:text-muted-foreground">
                  {scenarioData.briefing.objectives.map((objective, index) => (
                    <li key={`${objective}-${index}`} className="pl-1">
                      {objective}
                    </li>
                  ))}
                </ol>
              </div>
            </CardContent>
          </Card>

          {finishedRuns.length ? (
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <History className="size-4 text-muted-foreground" />
                <h2 className="text-base font-semibold tracking-tight">
                  Previous runs
                </h2>
                <Badge variant="outline" className="h-6 px-2 text-xs">
                  {finishedRuns.length}
                </Badge>
              </div>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                {finishedRuns.map((run) => {
                  const runTone = outcomeTone(run.outcome);
                  const content = (
                    <div className="space-y-3">
                      <Badge variant={runTone.variant}>{runTone.label}</Badge>
                      <div className="space-y-1 text-sm">
                        <p className="font-medium">{describeFinishedRun(run)}</p>
                        <p className="text-muted-foreground">
                          Started {formatDateTime(run.createdAt)}
                        </p>
                        <p className="text-muted-foreground">
                          Finished {formatDateTime(run.finishedAt)}
                        </p>
                      </div>
                      <div className="pt-1 text-sm font-medium">
                        {run.hasReplay ? (
                          <span className="text-primary">Open replay</span>
                        ) : (
                          <span className="text-muted-foreground">
                            Replay unavailable
                          </span>
                        )}
                      </div>
                    </div>
                  );

                  return (
                    <div key={run.runId} className="relative">
                      {run.hasReplay ? (
                        <Link
                          to="/scenarios/runs/$runId"
                          params={{ runId: run.runId }}
                          className="block rounded-lg border p-4 pr-12 transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {content}
                        </Link>
                      ) : (
                        <div className="rounded-lg border p-4 pr-12">
                          {content}
                        </div>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="absolute top-3 right-3 text-muted-foreground hover:text-destructive"
                        onClick={() => setDeleteTarget(run)}
                        aria-label="Delete run"
                        title="Delete run"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  );
                })}
              </div>
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
                  {deleteRun.isPending ? "Deleting..." : "Delete run"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      ) : null}
    </SignedInShell>
  );
}

async function fetchScenarioDetail(scenarioId: string) {
  const response = await fetch(`/api/scenarios/${encodeURIComponent(scenarioId)}`, {
    method: "GET",
    credentials: "include",
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Failed to load scenario (${response.status})`);
  }

  const body = (await response.json()) as {
    scenario: Parameters<typeof toLegacyScenarioDetail>[0];
  };
  return {
    scenario: toLegacyScenarioDetail(body.scenario),
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

function DifficultyBadge(props: {
  difficulty: ScenarioDetail["briefing"]["difficulty"];
}) {
  if (props.difficulty === "hard") {
    return <Badge variant="destructive">Hard</Badge>;
  }

  if (props.difficulty === "easy") {
    return <Badge variant="secondary">Easy</Badge>;
  }

  return <Badge variant="outline">Medium</Badge>;
}

function MetaBadge(props: { icon?: React.ReactNode; label: string }) {
  return (
    <Badge variant="outline" className="gap-1">
      {props.icon ? props.icon : null}
      {props.label}
    </Badge>
  );
}

function formatDate(value: number) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(value);
}

function formatDateTime(value: number) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
}

function formatDurationMs(value: number) {
  const totalSeconds = Math.max(0, Math.floor(value / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return [hours, minutes, seconds]
      .map((part) => String(part).padStart(2, "0"))
      .join(":");
  }

  return [minutes, seconds]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function describeFinishedRun(run: ScenarioDetail["finishedRuns"][number]) {
  if (run.outcome === "succeeded" && run.solveDurationMs !== null) {
    return `Solved in ${formatDurationMs(run.solveDurationMs)}`;
  }
  if (run.outcome === "succeeded") {
    return "Solved successfully";
  }
  if (run.outcome === "cancelled") {
    return "Cancelled before solve";
  }
  return "Run failed";
}

function outcomeTone(outcome: ScenarioDetail["finishedRuns"][number]["outcome"]) {
  switch (outcome) {
    case "succeeded":
      return {
        variant: "secondary" as const,
        label: "Succeeded",
      };
    case "cancelled":
      return {
        variant: "outline" as const,
        label: "Cancelled",
      };
    case "failed":
      return {
        variant: "destructive" as const,
        label: "Failed",
      };
  }
}
