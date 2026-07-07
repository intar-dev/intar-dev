import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeft, Clock3 } from "lucide-react";
import {
  RunArtifactGifExportButton,
  RunArtifactViewer,
  type RunArtifactFile,
  type RunArtifactViewerState,
} from "@/components/app/RunArtifactViewer";
import { PageShell } from "@/components/app/patterns/PageShell";
import { WebSshTerminal } from "@/components/remote-access/WebSshTerminal";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toLegacyScenarioRunRecord } from "@/lib/legacy-scenario-ui";
import { LeaseCountdown } from "@/components/app/run/LeaseCountdown";
import { VmDetailsCard } from "@/components/app/run/VmDetailsCard";
import { computeLeaseDeadline } from "@/lib/run-lease";
import {
  ScenarioProbeRail,
} from "@/components/app/run/ObjectivesRail";
import { HintList, SolutionCard } from "@/components/app/run/Guidance";
import {
  DeleteRunDialog,
  ScenarioCancelDialog,
} from "@/components/app/run/RunDialogs";
import { RunTimelineSection } from "@/components/app/run/RunTimelineSection";
import { ScenarioVmSelector } from "@/components/app/run/ScenarioVmSelector";
import {
  ScenarioShellStatusCard,
  ScenarioStepScreen,
  ScenarioSuccessOverlay,
} from "@/components/app/run/StatusScreens";
import {
  buildScenarioBootSteps,
  buildScenarioShutdownSteps,
  formatScenarioElapsedTime,
  formatScenarioDurationMs,
  formatScenarioReplayName,
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
  const artifactStreamRef = useRef<AbortController | null>(null);
  const [selectedReplayArtifactId, setSelectedReplayArtifactId] = useState<
    string | null
  >(null);
  const [selectedVmId, setSelectedVmId] = useState<string | null>(null);
  const [viewer, setViewer] = useState<RunArtifactViewerState | null>(null);
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [deleteRunDialogOpen, setDeleteRunDialogOpen] = useState(false);
  const [shutdownRequested, setShutdownRequested] = useState(false);
  const [now, setNow] = useState(() => Date.now());

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
        run: Parameters<typeof toLegacyScenarioRunRecord>[0];
      };
      return {
        run: toLegacyScenarioRunRecord(body.run),
      } satisfies ScenarioRunResponse;
    },
    refetchInterval: (query) => {
      const record = query.state.data?.run;
      if (!record) {
        return projectionPending ? 1_500 : false;
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
            : "Failed to destroy scenario VM",
        );
      }

      return body;
    },
    onSuccess: () => {
      setCancelDialogOpen(false);
      setTerminalVisible(false);
      void queryClient.invalidateQueries({ queryKey: ["scenarios", "run", runId] });
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
        | { run?: Parameters<typeof toLegacyScenarioRunRecord>[0]; error?: string }
        | null;
      if (!response.ok || !body?.run) {
        throw new Error(body?.error ?? "Failed to reveal hint");
      }
      return toLegacyScenarioRunRecord(body.run);
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
        | { run?: Parameters<typeof toLegacyScenarioRunRecord>[0]; error?: string }
        | null;
      if (!response.ok || !body?.run) {
        throw new Error(body?.error ?? "Failed to reveal solution");
      }
      return toLegacyScenarioRunRecord(body.run);
    },
    onSuccess: (run) => {
      queryClient.setQueryData(["scenarios", "run", runId], { run });
    },
  });

  const attemptData = attempt.data?.run ?? null;
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
  const showCompletionOverlay =
    attemptData !== null &&
    attemptData.phase === "solved" &&
    attemptData.canDestroy;
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
  const replayArtifact = useMemo(() => {
    if (!selectedVm?.replayArtifacts.length) {
      return null;
    }
    return (
      selectedVm.replayArtifacts.find(
        (artifact) => artifact.id === selectedReplayArtifactId,
      ) ??
      selectedVm.replayArtifacts.find(
        (artifact) => artifact.id === selectedVm.primaryReplayArtifactId,
      ) ??
      selectedVm.replayArtifacts.at(-1) ??
      null
    );
  }, [selectedReplayArtifactId, selectedVm]);

  const replayArtifactIndex = useMemo(() => {
    if (!selectedVm || !replayArtifact) {
      return -1;
    }

    return selectedVm.replayArtifacts.findIndex(
      (artifact) => artifact.id === replayArtifact.id,
    );
  }, [replayArtifact, selectedVm]);

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

  useEffect(() => {
    if (!selectedVm?.replayArtifacts.length) {
      setSelectedReplayArtifactId(null);
      return;
    }

    setSelectedReplayArtifactId((current) => {
      if (
        current &&
        selectedVm.replayArtifacts.some((artifact) => artifact.id === current)
      ) {
        return current;
      }
      return (
        selectedVm.primaryReplayArtifactId ??
        selectedVm.replayArtifacts.at(-1)?.id ??
        null
      );
    });
  }, [selectedVm?.primaryReplayArtifactId, selectedVm?.replayArtifacts]);

  useEffect(() => {
    return () => {
      artifactStreamRef.current?.abort();
      artifactStreamRef.current = null;
    };
  }, []);

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

  useEffect(() => {
    if (!attemptData || !selectedVm || !replayArtifact || attemptData.phase !== "completed") {
      return;
    }

    artifactStreamRef.current?.abort();
    const controller = new AbortController();
    artifactStreamRef.current = controller;

    const artifactFile: RunArtifactFile = {
      id: replayArtifact.id,
      ordinal: 0,
      kind: "ssh_recording",
      filename: formatScenarioReplayName(
        replayArtifactIndex,
        selectedVm.replayArtifacts.length,
      ),
      contentType: replayArtifact.contentType,
      sizeBytes: replayArtifact.sizeBytes,
      sha256: "",
      uploadStatus: "uploaded",
      uploadedAt: attemptData.updatedAt,
    };

    setViewer({
      artifact: artifactFile,
      loading: true,
      error: null,
      content: "",
      receivedBytes: 0,
    });

    void (async () => {
      try {
        const response = await fetch(
          `/api/runs/${encodeURIComponent(attemptData.id)}/artifacts/${encodeURIComponent(replayArtifact.id)}/content`,
          {
            method: "GET",
            credentials: "include",
            signal: controller.signal,
          },
        );

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(
            body?.error ??
              `Failed to load replay artifact (${response.status})`,
          );
        }

        if (!response.body) {
          const text = await response.text();
          setViewer({
            artifact: artifactFile,
            loading: false,
            error: null,
            content: text,
            receivedBytes: new TextEncoder().encode(text).byteLength,
          });
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";
        let receivedBytes = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          receivedBytes += value.byteLength;
          accumulated += decoder.decode(value, { stream: true });
          startTransition(() => {
            setViewer({
              artifact: artifactFile,
              loading: true,
              error: null,
              content: accumulated,
              receivedBytes,
            });
          });
        }

        accumulated += decoder.decode();
        setViewer({
          artifact: artifactFile,
          loading: false,
          error: null,
          content: accumulated,
          receivedBytes: Math.max(receivedBytes, replayArtifact.sizeBytes),
        });
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        setViewer((current) => ({
          artifact: artifactFile,
          loading: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to stream replay artifact",
          content: current?.content ?? "",
          receivedBytes: current?.receivedBytes ?? 0,
        }));
      } finally {
        if (artifactStreamRef.current === controller) {
          artifactStreamRef.current = null;
        }
      }
    })();
  }, [attemptData, replayArtifact, replayArtifactIndex, selectedVm]);

  return (
    <PageShell
      title="Scenario run"
      description="Progress, shell access, and the final replay."
      showHeader={false}
    >
      <div className="space-y-2">
        {attemptData ? (
          <Button
            variant="ghost"
            className="-ml-3 w-fit"
            render={
              <Link
                to="/scenarios/$scenarioId"
                params={{ scenarioId: attemptData.scenarioId }}
              />
            }
          >
            <ArrowLeft className="size-4" />
            Back to scenario
          </Button>
        ) : (
          <Button
            variant="ghost"
            className="-ml-3 w-fit"
            render={<Link to="/scenarios" />}
          >
            <ArrowLeft className="size-4" />
            Back to scenarios
          </Button>
        )}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <h1 className="text-lg font-semibold tracking-tight">
              {attemptData?.phase === "completed" && attemptData.scenarioName
                ? `${attemptData.scenarioName} - Replay`
                : (attemptData?.scenarioName ?? "Scenario run")}
            </h1>
            {attemptData &&
            (attemptData.outcome !== "in_progress" ||
              attemptData.solveDurationMs !== null) ? (
              <div className="flex flex-wrap items-center gap-2">
                {outcomeMeta ? (
                  <Badge variant={outcomeMeta.variant}>{outcomeMeta.label}</Badge>
                ) : null}
                {attemptData.solveDurationMs !== null ? (
                  <Badge variant="outline">
                    Solved in {formatScenarioDurationMs(attemptData.solveDurationMs)}
                  </Badge>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {attemptData && attemptData.outcome === "in_progress" ? (
              <LeaseCountdown
                deadlineMs={computeLeaseDeadline(
                  attemptData.createdAt,
                  attemptData.vms.map(
                    (vm) => vm.provisioning?.leaseDurationSeconds,
                  ),
                )}
                className="rounded-full border bg-muted/40 px-3 py-1"
              />
            ) : null}
            {attemptData?.phase === "completed" ? (
              <RunArtifactGifExportButton viewer={viewer} />
            ) : null}
            {canDeleteRun ? (
              <DeleteRunDialog
                open={deleteRunDialogOpen}
                onOpenChange={setDeleteRunDialogOpen}
                onConfirm={() => deleteRun.mutate()}
                pending={deleteRun.isPending}
              />
            ) : null}
          </div>
        </div>
      </div>

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
          <AlertTitle>Could not end scenario</AlertTitle>
          <AlertDescription>
            {destroyScenario.error instanceof Error
              ? destroyScenario.error.message
              : "Failed to destroy scenario VM"}
          </AlertDescription>
        </Alert>
      ) : null}

      {attemptData ? (
        <div className="space-y-6">
          {attemptData.phase === "completed" ? (
            <section className="space-y-4">
              {attemptData.vms.length > 1 ? (
                <ScenarioVmSelector
                  vms={attemptData.vms}
                  selectedVmId={selectedVmId}
                  onSelect={setSelectedVmId}
                />
              ) : null}
              <RunArtifactViewer viewer={viewer} minimalCastReplay />
            </section>
          ) : showBootLoadingScreen ? (
            <div className="mx-auto w-full max-w-7xl">
              <ScenarioStepScreen
                title={bootScreenCopy.title}
                description={bootScreenCopy.description}
                progressLabel="Getting ready"
                progressPercent={attemptData.progressPercent}
                steps={bootSteps}
                actions={cancelScenarioAction}
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
            <div className="mx-auto w-full max-w-7xl">
              <ScenarioStepScreen
                title={shutdownScreenCopy.title}
                description={shutdownScreenCopy.description}
                steps={shutdownSteps}
              />
            </div>
          ) : (
            <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_18rem]">
              <div className="relative min-w-0">
                <div className="mb-4">
                  <ScenarioVmSelector
                    vms={attemptData.vms}
                    selectedVmId={selectedVmId}
                    onSelect={setSelectedVmId}
                  />
                </div>

                {selectedVm && selectedVmShellReady && terminalVisible ? (
                  <WebSshTerminal
                    vmName={selectedVm.scenarioVmName}
                    sessionRequest={selectedVmSessionRequest!}
                    variant="embedded"
                    title={`${selectedVm.scenarioVmName} shell`}
                    showCloseButton={false}
                    onClose={() => setTerminalVisible(false)}
                    headerActions={shellAccessActions}
                  />
                ) : (
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
                    actions={shellAccessActions}
                  />
                )}

                {showCompletionOverlay ? (
                  <ScenarioSuccessOverlay
                    scenarioName={attemptData.scenarioName}
                    probes={selectedVm?.scenarioProbes ?? []}
                    solveDurationMs={attemptData.solveDurationMs}
                    pending={destroyScenario.isPending}
                    onConfirm={requestDestroyScenario}
                  />
                ) : null}
              </div>

              <aside className="space-y-4">
                <ScenarioProbeRail
                  title="Objectives"
                  description={
                    selectedVm
                      ? `${selectedVm.scenarioVmName} scenario checks`
                      : "These track the scenario goal."
                  }
                  probes={selectedVm?.scenarioProbes ?? []}
                  objectives={attemptData.objectives}
                />
                <RunTimelineSection runId={runId} />
                {selectedVm ? (
                  <VmDetailsCard
                    vmName={selectedVm.scenarioVmName}
                    hostname={selectedVm.hostname}
                    provisioning={selectedVm.provisioning}
                    terminalTarget={selectedVm.terminalTarget}
                  />
                ) : null}
                <HintList
                  hints={attemptData.hints}
                  nextHintKey={attemptData.nextHintKey}
                  onReveal={(hintKey) => revealHint.mutate(hintKey)}
                  pendingHintKey={
                    revealHint.isPending ? revealHint.variables ?? null : null
                  }
                  error={
                    revealHint.error instanceof Error
                      ? revealHint.error.message
                      : null
                  }
                />
                <SolutionCard
                  solution={attemptData.solution}
                  onReveal={() => revealSolution.mutate()}
                  pending={revealSolution.isPending}
                  error={
                    revealSolution.error instanceof Error
                      ? revealSolution.error.message
                      : null
                  }
                />
              </aside>
            </div>
          )}
        </div>
      ) : null}
    </PageShell>
  );
}
