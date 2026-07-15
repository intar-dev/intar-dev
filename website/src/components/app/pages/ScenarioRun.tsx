import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Maximize2, Minimize2, Trash2 } from "lucide-react";
import { PageShell } from "@/components/app/patterns/PageShell";
import { StatusToken } from "@/components/app/patterns/StatusToken";
import { RunStatusDock } from "@/components/app/patterns/RunStatusDock";
import { usePageChrome } from "@/components/app/shell/page-chrome";
import { WebSshTerminal } from "@/components/remote-access/WebSshTerminal";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
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
import { ChecksSection, RunConsole } from "@/components/app/run/RunConsole";
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
  formatScenarioDurationMs,
  getScenarioBootScreenCopy,
  getScenarioShutdownScreenCopy,
  hasPendingInfrastructureTeardown,
  hasUsableTerminalTarget,
} from "@/components/app/run/run-support";
import { NativeSshDialog } from "@/components/remote-access/NativeSshDialogButton";
import {
  POLL_INTERVALS,
  type ScenarioRunResponse,
  type ScenarioDestroyAcceptedResponse,
} from "@/components/app/run/run-types";
import { cn } from "@/lib/utils";

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
  const [sshDialogOpen, setSshDialogOpen] = useState(false);
  const [shutdownRequested, setShutdownRequested] = useState(false);
  const [maximized, setMaximized] = useState(false);
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
        return projectionPending ? 100 : false;
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
  const infrastructureTeardownPending = Boolean(
    attemptData && hasPendingInfrastructureTeardown(attemptData.vms),
  );
  const probePassToasts = useProbePassEvents(
    attemptData?.vms,
    attemptData?.objectives,
    attemptData?.phase === "running",
  );
  const canDeleteRun =
    attemptData !== null &&
    (attemptData.phase === "completed" || attemptData.phase === "failed") &&
    !infrastructureTeardownPending;
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

  const showEndRunAction =
    showCancelAction &&
    (attemptData?.outcome === "in_progress" || infrastructureTeardownPending) &&
    !showShutdownLoadingScreen;
  const showSshMenuItem = Boolean(
    selectedVm &&
      selectedVmSessionRequest &&
      attemptData?.outcome === "in_progress" &&
      !showShutdownLoadingScreen,
  );

  usePageChrome({
    title: attemptData?.scenarioName,
    status: useMemo(() => {
      if (!attemptData) return undefined;
      if (attemptData.outcome === "in_progress") {
        if (showBootLoadingScreen || showShutdownLoadingScreen) {
          return (
            <StatusToken
              tone="pending"
              word={attemptData.phaseTitle}
              pulse
              live
              clock={{ startedAt: attemptData.createdAt }}
            />
          );
        }
        if (attemptData.phase === "solved") {
          return (
            <StatusToken
              tone="success"
              word="Solved"
              live
              clock={{
                startedAt: attemptData.createdAt,
                frozenMs: attemptData.solveDurationMs,
              }}
            />
          );
        }
        return (
          <StatusToken
            tone="live"
            word={attemptData.phaseTitle}
            live
            clock={{ startedAt: attemptData.createdAt }}
          />
        );
      }
      switch (attemptData.outcome) {
        case "succeeded":
          return (
            <StatusToken
              tone="success"
              word="Solved"
              elapsed={
                attemptData.solveDurationMs !== null
                  ? formatScenarioDurationMs(attemptData.solveDurationMs)
                  : null
              }
            />
          );
        case "failed":
          return <StatusToken tone="danger" word="Failed" />;
        default:
          return <StatusToken tone="muted" word="Ended early" />;
      }
    }, [attemptData, showBootLoadingScreen, showShutdownLoadingScreen]),
    action: useMemo(
      () =>
        showEndRunAction ? (
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setCancelDialogOpen(true)}
          >
            <Trash2 className="size-3.5" />
            End run
          </Button>
        ) : undefined,
      [showEndRunAction],
    ),
    menu: useMemo(() => {
      if (!showSshMenuItem && !canDeleteRun) return undefined;
      return (
        <>
          {showSshMenuItem ? (
            <DropdownMenuItem
              disabled={!selectedVmShellReady}
              onClick={() => setSshDialogOpen(true)}
            >
              SSH command…
            </DropdownMenuItem>
          ) : null}
          {canDeleteRun ? (
            <DropdownMenuItem
              variant="destructive"
              onClick={() => setDeleteRunDialogOpen(true)}
            >
              Delete run…
            </DropdownMenuItem>
          ) : null}
        </>
      );
    }, [showSshMenuItem, canDeleteRun, selectedVmShellReady]),
  });

  // The browser tab carries live-run state while the user is elsewhere.
  const scenarioName = attemptData?.scenarioName ?? null;
  const runIsLive = attemptData?.outcome === "in_progress";
  useEffect(() => {
    if (!runIsLive || !scenarioName) return;
    const previous = document.title;
    const live = `● ${scenarioName} · intar.dev`;
    document.title = live;
    return () => {
      // On route changes HeadContent has already committed the destination
      // title before this cleanup runs — only restore what we still own.
      if (document.title === live) {
        document.title = previous;
      }
    };
  }, [runIsLive, scenarioName]);

  const maximizeToggle = (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="hidden lg:inline-flex"
      aria-pressed={maximized}
      aria-label={maximized ? "Restore layout" : "Maximize terminal"}
      onClick={() => setMaximized((current) => !current)}
    >
      {maximized ? (
        <Minimize2 className="size-3.5" />
      ) : (
        <Maximize2 className="size-3.5" />
      )}
    </Button>
  );

  const runDialogs = (
    <>
      {showCancelAction ? (
        <ScenarioCancelDialog
          trigger={false}
          open={cancelDialogOpen}
          onOpenChange={setCancelDialogOpen}
          onConfirm={requestDestroyScenario}
          pending={destroyScenario.isPending}
        />
      ) : null}
      {canDeleteRun ? (
        <DeleteRunDialog
          trigger={false}
          open={deleteRunDialogOpen}
          onOpenChange={setDeleteRunDialogOpen}
          onConfirm={() => deleteRun.mutate()}
          pending={deleteRun.isPending}
        />
      ) : null}
      {selectedVm && selectedVmSessionRequest ? (
        <NativeSshDialog
          vmName={selectedVm.scenarioVmName}
          sessionRequest={selectedVmSessionRequest}
          open={sshDialogOpen}
          onOpenChange={setSshDialogOpen}
        />
      ) : null}
    </>
  );

  const renderRunRail = () => {
    if (!attemptData) return null;

    return (
      <RunConsole>
        {showResolutionCard ? (
          <div>
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
          </div>
        ) : (
          <>
            {/* Keyed per machine so row open/close state never leaks across
                VM switches. */}
            <ChecksSection
              key={selectedVm?.scenarioVmName ?? "checks"}
              vmName={selectedVm?.scenarioVmName ?? null}
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
      </RunConsole>
    );
  };

  const errorAlerts = (
    <>
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
    </>
  );

  // Completed runs are a reading surface — replay transcripts want the page
  // scroll back, not a fixed frame.
  if (attemptData?.phase === "completed") {
    return (
      <PageShell width="content">
        {runDialogs}
        {errorAlerts}
        <div className="flex flex-wrap items-center gap-3">
          {attemptData.outcome === "succeeded" ? (
            <StatusToken
              tone="success"
              word="Solved"
              elapsed={
                attemptData.solveDurationMs !== null
                  ? formatScenarioDurationMs(attemptData.solveDurationMs)
                  : null
              }
            />
          ) : attemptData.outcome === "failed" ? (
            <StatusToken tone="danger" word="Failed" />
          ) : (
            <StatusToken tone="muted" word="Ended early" />
          )}
        </div>
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
            <CardTitle className="font-heading text-base">Timeline</CardTitle>
            <CardDescription>
              When each check flipped during this run.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ObjectiveTimeline runId={runId} />
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  // Everything else is the workspace frame: bar + panes, no page scroll.
  return (
    <div className="flex h-[calc(100dvh-var(--app-bar-h,3rem))] min-h-[28rem] flex-col gap-3 overflow-hidden px-[var(--workspace-inset)] py-3">
      {runDialogs}
      <div className="shrink-0 space-y-3 empty:hidden">{errorAlerts}</div>

      {attemptData ? (
        showBootLoadingScreen ? (
          <div className="flex min-h-0 flex-1 overflow-y-auto">
            <div className="m-auto w-full max-w-2xl py-4">
              <ScenarioStepScreen
                title={bootScreenCopy.title}
                description={bootScreenCopy.description}
                progressLabel="Getting ready"
                progressPercent={attemptData.progressPercent}
                steps={bootSteps}
              />
            </div>
          </div>
        ) : showShutdownLoadingScreen ? (
          <div className="flex min-h-0 flex-1 overflow-y-auto">
            <div className="m-auto w-full max-w-2xl py-4">
              <ScenarioStepScreen
                title={shutdownScreenCopy.title}
                description={shutdownScreenCopy.description}
                steps={shutdownSteps}
              />
            </div>
          </div>
        ) : (
          <div
            className={cn(
              "grid min-h-0 flex-1 gap-3 lg:grid-rows-[minmax(0,1fr)]",
              !maximized && "lg:grid-cols-[minmax(0,1fr)_22rem]",
            )}
          >
            <section
              aria-label="Terminal"
              className="relative flex min-h-0 min-w-0 flex-col gap-3"
            >
              <ScenarioVmSelector
                vms={attemptData.vms}
                selectedVmId={selectedVmId}
                onSelect={setSelectedVmId}
              />

              {selectedVm && selectedVmShellReady && terminalVisible ? (
                <div className="relative min-h-[16rem] min-w-0 flex-1">
                  <WebSshTerminal
                    vmName={selectedVm.scenarioVmName}
                    sessionRequest={selectedVmSessionRequest!}
                    variant="embedded"
                    title={`${selectedVm.scenarioVmName} shell`}
                    showCloseButton={false}
                    onClose={() => setTerminalVisible(false)}
                    headerActions={
                      <>
                        <LeaseCountdown
                          deadlineMs={leaseDeadlineMs}
                          className="text-xs"
                        />
                        {maximizeToggle}
                      </>
                    }
                  />
                  <ProbePassToasts toasts={probePassToasts} />
                </div>
              ) : (
                <div className="relative flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
                  {/* The lease keeps ticking without a terminal — keep the
                      countdown's only home visible in this state too. */}
                  <div className="flex shrink-0 justify-end empty:hidden">
                    <LeaseCountdown
                      deadlineMs={leaseDeadlineMs}
                      className="text-xs"
                    />
                  </div>
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
                  <ProbePassToasts toasts={probePassToasts} />
                </div>
              )}

              <div
                aria-hidden="true"
                className="h-[calc(4.5rem+env(safe-area-inset-bottom))] shrink-0 lg:hidden"
              />
            </section>

            {desktopRunRail ? (
              <aside
                aria-label="Run console"
                className={cn(
                  "min-h-0 overflow-y-auto pr-1",
                  maximized && "hidden",
                )}
              >
                {renderRunRail()}
              </aside>
            ) : (
              <RunStatusDock
                label="Run checks and assistance"
                description="Review live checks, hints, solution, and machine details without leaving the shell."
                status={
                  selectedProbes.length
                    ? `${passedCheckCount}/${selectedProbes.length} checks · ${currentCheckLabel}`
                    : attemptData.phaseDetail
                }
              >
                {renderRunRail()}
              </RunStatusDock>
            )}
          </div>
        )
      ) : null}
    </div>
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
