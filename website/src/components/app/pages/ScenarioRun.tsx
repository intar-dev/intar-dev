import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Activity, CheckCircle2, Clock3 } from "lucide-react";
import { PageShell } from "@/components/app/patterns/PageShell";
import { PageHeader } from "@/components/app/patterns/PageHeader";
import { MetaChip } from "@/components/app/patterns/MetaChip";
import { RunStatusDock } from "@/components/app/patterns/RunStatusDock";
import { useBreadcrumbLabel } from "@/components/app/shell/breadcrumbs";
import { WebSshTerminal } from "@/components/remote-access/WebSshTerminal";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { presentScenarioRun } from "@/lib/run-phase";
import { SessionTimeline } from "@/components/app/run/SessionTimeline";
import { RunDetailsSection } from "@/components/app/run/RunDetailsSection";
import { ObjectiveTimeline } from "@/components/app/run/ObjectiveTimeline";
import { computeLeaseDeadline } from "@/lib/run-lease";
import { LeaseCountdown } from "@/components/app/run/LeaseCountdown";
import { OpsConsoleRail } from "@/components/app/run/OpsConsoleRail";
import { AssistDrawer } from "@/components/app/run/AssistDrawer";
import {
  ProbePassToasts,
  useProbePassEvents,
} from "@/components/app/run/ProbePassToasts";
import { ResolutionCard } from "@/components/app/run/ResolutionCard";
import {
  DeleteRunDialog,
  ScenarioCancelDialog,
} from "@/components/app/run/RunDialogs";
import { ScenarioVmSelector } from "@/components/app/run/ScenarioVmSelector";
import {
  ScenarioShellStatusCard,
  ScenarioStepScreen,
} from "@/components/app/run/StatusScreens";
import {
  buildScenarioBootSteps,
  buildScenarioShutdownSteps,
  formatScenarioElapsedTime,
  formatScenarioDurationMs,
  getScenarioBootScreenCopy,
  getScenarioShutdownScreenCopy,
  hasUsableTerminalTarget,
  scenarioRunOutcomeMeta,
} from "@/components/app/run/run-support";
import { NativeSshDialogButton } from "@/components/remote-access/NativeSshDialogButton";
import {
  POLL_INTERVALS,
  type ScenarioRunResponse,
  type ScenarioDestroyAcceptedResponse,
} from "@/components/app/run/run-types";

export function ScenarioRun() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { runId } = useParams({ from: "/app/runs/$runId" });
  const [projectionPending, setProjectionPending] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return new URLSearchParams(window.location.search).get("pending") === "1";
  });
  const [selectedVmId, setSelectedVmId] = useState<string | null>(null);
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [deleteRunDialogOpen, setDeleteRunDialogOpen] = useState(false);
  const [shutdownRequested, setShutdownRequested] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const desktopRunRail = useDesktopRunRail();

  const attempt = useQuery({
    queryKey: ["scenarios", "run", runId],
    queryFn: async () => {
      const response = await fetch(
        `/api/scenarios/runs/${encodeURIComponent(runId)}`,
        {
          method: "GET",
          credentials: "include",
        },
      );

      if (response.status === 404 && projectionPending) {
        return null;
      }

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          body?.error ?? `Failed to load scenario (${response.status})`,
        );
      }

      const body = (await response.json()) as {
        run: Parameters<typeof presentScenarioRun>[0];
      };
      return {
        run: presentScenarioRun(body.run),
      } satisfies ScenarioRunResponse;
    },
    refetchInterval: (query) => {
      const record = query.state.data?.run;
      if (!record) {
        return projectionPending ? 1_500 : false;
      }
      // Poll eagerly while the session media is still rendering on the host
      // so the timeline appears as soon as the agent submits it.
      if (
        record.phase === "completed" &&
        record.vms.some(
          (vm) => vm.hasRecording === true && !vm.sessionTimeline,
        )
      ) {
        return 2_500;
      }
      return POLL_INTERVALS[record.phase];
    },
    staleTime: 1_000,
  });

  const destroyScenario = useMutation({
    mutationFn: async () => {
      const response = await fetch(
        `/api/scenarios/runs/${encodeURIComponent(runId)}/destroy`,
        {
          method: "POST",
          credentials: "include",
        },
      );

      const body = (await response.json().catch(() => null)) as
        | ScenarioDestroyAcceptedResponse
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
            : "Failed to end run",
        );
      }

      return body;
    },
    onSuccess: () => {
      setCancelDialogOpen(false);
      setTerminalVisible(false);
      void queryClient.invalidateQueries({ queryKey: ["scenarios", "run", runId] });
      void queryClient.invalidateQueries({ queryKey: ["scenarios", "list"] });
      void queryClient.invalidateQueries({ queryKey: ["scenario-runs", "list"] });
    },
    onError: () => {
      setShutdownRequested(false);
    },
  });

  const deleteRun = useMutation({
    mutationFn: async () => {
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
      setDeleteRunDialogOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["scenarios", "list"] });
      void queryClient.invalidateQueries({ queryKey: ["scenario-runs", "list"] });
      if (attemptData?.scenarioId) {
        await navigate({
          to: "/scenarios/$scenarioId",
          params: { scenarioId: attemptData.scenarioId },
        });
        return;
      }

      await navigate({ to: "/scenarios" });
    },
  });

  const revealHint = useMutation({
    mutationFn: async (hintKey: string) => {
      const response = await fetch(
        `/api/scenarios/runs/${encodeURIComponent(runId)}/hints/reveal`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hintKey }),
        },
      );
      const body = (await response.json().catch(() => null)) as
        | { run?: Parameters<typeof presentScenarioRun>[0]; error?: string }
        | null;
      if (!response.ok || !body?.run) {
        throw new Error(body?.error ?? "Failed to reveal hint");
      }
      return presentScenarioRun(body.run);
    },
    onSuccess: (run) => {
      queryClient.setQueryData(["scenarios", "run", runId], { run });
    },
  });

  const revealSolution = useMutation({
    mutationFn: async () => {
      const response = await fetch(
        `/api/scenarios/runs/${encodeURIComponent(runId)}/solution/reveal`,
        {
          method: "POST",
          credentials: "include",
        },
      );
      const body = (await response.json().catch(() => null)) as
        | { run?: Parameters<typeof presentScenarioRun>[0]; error?: string }
        | null;
      if (!response.ok || !body?.run) {
        throw new Error(body?.error ?? "Failed to reveal solution");
      }
      return presentScenarioRun(body.run);
    },
    onSuccess: (run) => {
      queryClient.setQueryData(["scenarios", "run", runId], { run });
    },
  });

  const attemptData = attempt.data?.run ?? null;
  useBreadcrumbLabel(attemptData?.scenarioName);
  const outcomeMeta = attemptData
    ? scenarioRunOutcomeMeta(attemptData.outcome)
    : null;
  useEffect(() => {
    if (!attemptData || !projectionPending || typeof window === "undefined") {
      return;
    }
    setProjectionPending(false);
    const url = new URL(window.location.href);
    url.searchParams.delete("pending");
    window.history.replaceState({}, "", url.toString());
  }, [attemptData, projectionPending]);
  const selectedVm = useMemo(() => {
    if (!attemptData?.vms.length) {
      return null;
    }

    return (
      attemptData.vms.find((vm) => vm.id === selectedVmId) ??
      attemptData.vms[0] ??
      null
    );
  }, [attemptData, selectedVmId]);
  const selectedVmShellReady = Boolean(
    selectedVm && hasUsableTerminalTarget(selectedVm),
  );
  const showBootLoadingScreen =
    attemptData !== null &&
    !attemptData.canOpenTerminal &&
    (attemptData.phase === "launching" ||
      attemptData.phase === "booting" ||
      attemptData.phase === "waiting_for_target");
  const showShutdownLoadingScreen =
    attemptData !== null &&
    (shutdownRequested ||
      attemptData.phase === "deleting" ||
      attemptData.phase === "archiving");
  const showCancelAction =
    attemptData !== null &&
    attemptData.canDestroy &&
    attemptData.phase !== "solved";
  const showResolutionCard =
    attemptData !== null &&
    attemptData.phase === "solved" &&
    attemptData.canDestroy;
  const leaseDeadlineMs =
    attemptData !== null && attemptData.outcome === "in_progress"
      ? computeLeaseDeadline(
          attemptData.createdAt,
          attemptData.vms.map((vm) => vm.provisioning?.leaseDurationSeconds),
        )
      : null;
  const selectedProbes = selectedVm?.scenarioProbes ?? [];
  const passedCheckCount = selectedProbes.filter(
    (probe) => probe.status === "pass",
  ).length;
  const currentProbe =
    selectedProbes.find((probe) => probe.status !== "pass") ?? null;
  const currentObjective = currentProbe
    ? attemptData?.objectives.find(
        (objective) => objective.probeName === currentProbe.id,
      ) ?? null
    : null;
  const currentCheckLabel =
    selectedProbes.length > 0 && passedCheckCount === selectedProbes.length
      ? "All checks passing"
      : currentObjective?.title?.trim() ||
        currentProbe?.label ||
        attemptData?.phaseDetail ||
        "Waiting for run status";
  const probePassToasts = useProbePassEvents(
    attemptData?.vms,
    attemptData?.objectives,
    attemptData?.phase === "running",
  );
  const canDeleteRun =
    attemptData !== null &&
    (attemptData.phase === "completed" || attemptData.phase === "failed");
  const bootElapsedSeconds =
    attemptData !== null && showBootLoadingScreen
      ? Math.max(0, Math.floor((now - attemptData.createdAt) / 1_000))
      : null;
  const bootSteps = useMemo(
    () => buildScenarioBootSteps(attemptData),
    [attemptData],
  );
  const shutdownSteps = useMemo(
    () => buildScenarioShutdownSteps(attemptData, shutdownRequested),
    [attemptData, shutdownRequested],
  );
  const bootScreenCopy = useMemo(
    () => getScenarioBootScreenCopy(attemptData),
    [attemptData],
  );
  const shutdownScreenCopy = useMemo(
    () => getScenarioShutdownScreenCopy(attemptData, shutdownRequested),
    [attemptData, shutdownRequested],
  );
  const selectedVmSessionRequest = useMemo(
    () =>
      selectedVm
        ? {
            url: `/api/scenarios/runs/${encodeURIComponent(attemptData?.id ?? runId)}/ssh`,
            body: { vmId: selectedVm.id },
          }
        : null,
    [attemptData?.id, runId, selectedVm],
  );

  useEffect(() => {
    if (selectedVmShellReady) {
      setTerminalVisible(true);
    }
  }, [selectedVmShellReady]);

  useEffect(() => {
    if (
      shutdownRequested &&
      attemptData &&
      (attemptData.phase === "deleting" ||
        attemptData.phase === "archiving" ||
        attemptData.phase === "completed" ||
        attemptData.phase === "failed")
    ) {
      setShutdownRequested(false);
    }
  }, [shutdownRequested, attemptData]);

  useEffect(() => {
    if (!showBootLoadingScreen) {
      return;
    }

    setNow(Date.now());
    const interval = window.setInterval(() => {
      setNow(Date.now());
    }, 1_000);

    return () => {
      window.clearInterval(interval);
    };
  }, [showBootLoadingScreen]);

  useEffect(() => {
    if (!attemptData?.vms.length) {
      setSelectedVmId(null);
      return;
    }

    setSelectedVmId((current) => {
      const readyVmId =
        attemptData.vms.find((vm) => hasUsableTerminalTarget(vm))?.id ?? null;
      if (current && attemptData.vms.some((vm) => vm.id === current)) {
        if (!terminalVisible && readyVmId) {
          const currentVm = attemptData.vms.find((vm) => vm.id === current);
          if (currentVm && !hasUsableTerminalTarget(currentVm)) {
            return readyVmId;
          }
        }
        return current;
      }
      return readyVmId ?? attemptData.vms[0]?.id ?? null;
    });
  }, [attemptData?.vms, terminalVisible]);

  const requestDestroyScenario = () => {
    destroyScenario.reset();
    setShutdownRequested(true);
    destroyScenario.mutate();
  };

  const cancelScenarioAction = showCancelAction ? (
    <ScenarioCancelDialog
      open={cancelDialogOpen}
      onOpenChange={setCancelDialogOpen}
      onConfirm={requestDestroyScenario}
      pending={destroyScenario.isPending}
    />
  ) : null;

  const shellAccessActions =
    selectedVm && selectedVmSessionRequest ? (
      <>
        <NativeSshDialogButton
          vmName={selectedVm.scenarioVmName}
          sessionRequest={selectedVmSessionRequest}
          label="SSH command"
          disabled={!selectedVmShellReady}
        />
        {cancelScenarioAction}
      </>
    ) : (
      cancelScenarioAction
    );

  const renderRunRail = () => {
    if (!attemptData) return null;

    return (
      <>
        {showResolutionCard ? (
          <ResolutionCard
            runId={runId}
            scenarioName={attemptData.scenarioName}
            createdAt={attemptData.createdAt}
            solveDurationMs={attemptData.solveDurationMs}
            hints={attemptData.hints}
            objectives={attemptData.objectives}
            assisted={attemptData.solution.assisted}
            pending={destroyScenario.isPending}
            onEndScenario={requestDestroyScenario}
          />
        ) : (
          <>
            <OpsConsoleRail
              vmName={selectedVm?.scenarioVmName ?? null}
              createdAt={attemptData.createdAt}
              solveDurationMs={attemptData.solveDurationMs}
              leaseDeadlineMs={leaseDeadlineMs}
              probes={selectedProbes}
              objectives={attemptData.objectives}
            />
            <AssistDrawer
              hints={attemptData.hints}
              objectives={attemptData.objectives}
              solution={attemptData.solution}
              onRevealHint={(hintKey) => revealHint.mutate(hintKey)}
              pendingHintKey={
                revealHint.isPending ? revealHint.variables ?? null : null
              }
              hintError={
                revealHint.error instanceof Error
                  ? revealHint.error.message
                  : null
              }
              onRevealSolution={() => revealSolution.mutate()}
              solutionPending={revealSolution.isPending}
              solutionError={
                revealSolution.error instanceof Error
                  ? revealSolution.error.message
                  : null
              }
            />
          </>
        )}
        <RunDetailsSection
          runId={runId}
          vmName={selectedVm?.scenarioVmName ?? null}
          hostname={selectedVm?.hostname ?? null}
          provisioning={selectedVm?.provisioning ?? null}
          terminalTarget={selectedVm?.terminalTarget ?? null}
        />
      </>
    );
  };

  return (
    <PageShell
      title="Scenario run"
      description="Progress, shell access, and the final replay."
      showHeader={false}
      width="workspace"
      density="compact"
    >
      <PageHeader
        compact
        backLink={
          attemptData
            ? {
                to: "/scenarios/$scenarioId",
                params: { scenarioId: attemptData.scenarioId },
                label: "Briefing",
              }
            : { to: "/scenarios", label: "All scenarios" }
        }
        eyebrow={attemptData?.phase === "completed" ? "Replay" : undefined}
        title={attemptData?.scenarioName ?? "Scenario run"}
        meta={
          attemptData ? (
            <>
              {outcomeMeta && attemptData.outcome !== "in_progress" ? (
                <Badge variant={outcomeMeta.variant}>{outcomeMeta.label}</Badge>
              ) : null}
              {attemptData.solveDurationMs !== null ? (
                <MetaChip icon={<Clock3 />}>
                  Solved in{" "}
                  {formatScenarioDurationMs(attemptData.solveDurationMs)}
                </MetaChip>
              ) : null}
            </>
          ) : undefined
        }
        actions={
          <>
            {attemptData &&
            attemptData.outcome === "in_progress" &&
            !showShutdownLoadingScreen
              ? shellAccessActions
              : null}
            {canDeleteRun ? (
              <DeleteRunDialog
                open={deleteRunDialogOpen}
                onOpenChange={setDeleteRunDialogOpen}
                onConfirm={() => deleteRun.mutate()}
                pending={deleteRun.isPending}
              />
            ) : null}
          </>
        }
      />

      {attempt.error ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load scenario run</AlertTitle>
          <AlertDescription>
            {attempt.error instanceof Error
              ? attempt.error.message
              : "Failed to load scenario run"}
          </AlertDescription>
        </Alert>
      ) : null}

      {!attempt.error && !attemptData && projectionPending ? (
        <Alert>
          <AlertTitle>Preparing scenario run</AlertTitle>
          <AlertDescription>
            The command was accepted. Waiting for projections to catch up.
          </AlertDescription>
        </Alert>
      ) : null}

      {destroyScenario.error ? (
        <Alert variant="destructive">
          <AlertTitle>Could not end run</AlertTitle>
          <AlertDescription>
            {destroyScenario.error instanceof Error
              ? destroyScenario.error.message
              : "The active run could not be ended."}
          </AlertDescription>
        </Alert>
      ) : null}

      {attemptData ? (
        <div className="flex min-h-0 flex-1 flex-col gap-4">
          <section
            aria-label="Current run status"
            className="sticky top-16 z-20 flex min-h-14 flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border bg-card px-3 py-2 shadow-sm sm:px-4"
          >
            <div
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className="flex min-w-0 flex-1 flex-wrap items-center gap-x-5 gap-y-2"
            >
              <span className="inline-flex min-w-0 items-center gap-2">
                {selectedProbes.length > 0 &&
                passedCheckCount === selectedProbes.length ? (
                  <CheckCircle2 className="size-4 shrink-0 text-success" />
                ) : (
                  <Activity className="size-4 shrink-0 text-brand-text" />
                )}
                <span className="truncate text-sm font-semibold">
                  {attemptData.phaseTitle}
                </span>
              </span>
              {selectedVm ? (
                <span className="font-mono text-xs text-muted-foreground">
                  {selectedVm.scenarioVmName}
                </span>
              ) : null}
              <span className="min-w-40 flex-1 truncate text-sm text-muted-foreground">
                {currentCheckLabel}
              </span>
              {selectedProbes.length ? (
                <span className="text-sm font-semibold tabular-nums">
                  {passedCheckCount}/{selectedProbes.length} checks
                </span>
              ) : null}
            </div>
            <LeaseCountdown deadlineMs={leaseDeadlineMs} className="text-xs" />
          </section>

          {attemptData.phase === "completed" ? (
            <section className="mx-auto w-full max-w-5xl space-y-4">
              {attemptData.vms.length > 1 ? (
                <ScenarioVmSelector
                  vms={attemptData.vms}
                  selectedVmId={selectedVmId}
                  onSelect={setSelectedVmId}
                />
              ) : null}
              <SessionTimeline runId={runId} vm={selectedVm} />
              <Card size="sm">
                <CardHeader>
                  <CardTitle className="font-heading text-base">
                    Timeline
                  </CardTitle>
                  <CardDescription>
                    When each check flipped during this run.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ObjectiveTimeline runId={runId} />
                </CardContent>
              </Card>
            </section>
          ) : showBootLoadingScreen ? (
            <div className="mx-auto w-full max-w-2xl">
              <ScenarioStepScreen
                title={bootScreenCopy.title}
                description={bootScreenCopy.description}
                progressLabel="Getting ready"
                progressPercent={attemptData.progressPercent}
                steps={bootSteps}
                topRight={
                  bootElapsedSeconds !== null ? (
                    <div className="inline-flex items-center gap-2 rounded-full border bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
                      <Clock3 className="size-3.5" />
                      <span className="tabular-nums">
                        {formatScenarioElapsedTime(bootElapsedSeconds)}
                      </span>
                    </div>
                  ) : null
                }
              />
            </div>
          ) : showShutdownLoadingScreen ? (
            <div className="mx-auto w-full max-w-2xl">
              <ScenarioStepScreen
                title={shutdownScreenCopy.title}
                description={shutdownScreenCopy.description}
                steps={shutdownSteps}
              />
            </div>
          ) : (
            <div className="grid min-h-0 flex-1 gap-4 pb-[calc(5rem_+_env(safe-area-inset-bottom))] lg:grid-cols-[minmax(0,1fr)_22rem] lg:grid-rows-[minmax(0,1fr)] lg:pb-0">
              <div className="relative flex min-h-0 min-w-0 flex-col gap-3">
                <ScenarioVmSelector
                  vms={attemptData.vms}
                  selectedVmId={selectedVmId}
                  onSelect={setSelectedVmId}
                />

                {selectedVm && selectedVmShellReady && terminalVisible ? (
                  <div className="h-[62dvh] min-h-[20rem] lg:h-auto lg:min-h-0 lg:flex-1">
                    <WebSshTerminal
                      vmName={selectedVm.scenarioVmName}
                      sessionRequest={selectedVmSessionRequest!}
                      variant="embedded"
                      title={`${selectedVm.scenarioVmName} shell`}
                      showCloseButton={false}
                      onClose={() => setTerminalVisible(false)}
                    />
                  </div>
                ) : (
                  <div className="lg:flex-1">
                    <ScenarioShellStatusCard
                      phase={selectedVm?.phase ?? attemptData.phase}
                      title={selectedVm?.phaseTitle ?? attemptData.phaseTitle}
                      description={
                        selectedVm?.phaseDetail ?? attemptData.phaseDetail
                      }
                      pending={
                        !selectedVmShellReady &&
                        Boolean(selectedVm && selectedVm.phase !== "failed")
                      }
                    />
                  </div>
                )}

                <ProbePassToasts toasts={probePassToasts} />
              </div>

              {desktopRunRail ? (
                <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1">
                  {renderRunRail()}
                </aside>
              ) : (
                <RunStatusDock
                  label="Run checks and assistance"
                  description="Review live checks, lease state, hints, solution, and machine details without leaving the shell."
                  status={
                    selectedProbes.length
                      ? `${passedCheckCount}/${selectedProbes.length} checks · ${currentCheckLabel}`
                      : attemptData.phaseDetail
                  }
                >
                  <div className="space-y-4">{renderRunRail()}</div>
                </RunStatusDock>
              )}
            </div>
          )}
        </div>
      ) : null}
    </PageShell>
  );
}

function useDesktopRunRail() {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined"
      ? false
      : window.matchMedia("(min-width: 64rem)").matches,
  );

  useEffect(() => {
    const media = window.matchMedia("(min-width: 64rem)");
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return matches;
}
