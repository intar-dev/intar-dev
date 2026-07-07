import {
  startTransition,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  ArrowLeft,
  Eye,
  CheckCircle2,
  Clock3,
  Lightbulb,
  LoaderCircle,
  LockKeyhole,
  Trash2,
} from "lucide-react";
import { Markdown } from "@/components/app/Markdown";
import {
  RunArtifactGifExportButton,
  RunArtifactViewer,
  type RunArtifactFile,
  type RunArtifactViewerState,
} from "@/components/app/RunArtifactViewer";
import { NativeSshDialogButton } from "@/components/remote-access/NativeSshDialogButton";
import { PageShell } from "@/components/app/patterns/PageShell";
import { WebSshTerminal } from "@/components/remote-access/WebSshTerminal";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toLegacyScenarioRunRecord } from "@/lib/legacy-scenario-ui";
import { parseProbeValue, summarizeProbeValue } from "@/lib/probe-values";
import { ProbeDetail } from "@/components/app/run/ProbeDetail";
import { LeaseCountdown } from "@/components/app/run/LeaseCountdown";
import { computeLeaseDeadline } from "@/lib/run-lease";
import type { RunVmProvisioningSpec } from "@/lib/run-state";
import { cn } from "@/lib/utils";

interface ScenarioProbeStatus {
  id: string;
  label: string;
  kind: string;
  phase: "boot" | "scenario";
  status: string;
  error: string | null;
  value: unknown;
}

interface ScenarioReplayArtifact {
  id: string;
  hostId: string;
  runId: string;
  vmId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

interface ScenarioRunVmRecord {
  id: string;
  ordinal: number;
  scenarioVmId: string;
  scenarioVmName: string;
  runtimeVmName: string;
  hostname: string;
  phase:
    | "launching"
    | "booting"
    | "waiting_for_target"
    | "running"
    | "solved"
    | "deleting"
    | "archiving"
    | "completed"
    | "failed";
  phaseTitle: string;
  phaseDetail: string;
  progressPercent: number;
  terminalPhase: "pending" | "ready" | "failed";
  canOpenTerminal: boolean;
  bootProbes: ScenarioProbeStatus[];
  scenarioProbes: ScenarioProbeStatus[];
  replayArtifacts: ScenarioReplayArtifact[];
  primaryReplayArtifactId: string | null;
  provisioning: RunVmProvisioningSpec;
  terminalTarget: {
    host: string | null;
    port: number;
    username: string;
    hostKeyOpenssh: string | null;
    checkedAt: number | null;
  };
}

interface ScenarioRunRecord {
  id: string;
  scenarioId: string;
  scenarioName: string;
  phase:
    | "launching"
    | "booting"
    | "waiting_for_target"
    | "running"
    | "solved"
    | "deleting"
    | "archiving"
    | "completed"
    | "failed";
  phaseTitle: string;
  phaseDetail: string;
  title: string;
  tagline: string;
  briefingMarkdown: string;
  objectives: ScenarioObjective[];
  tags: string[];
  hints: ScenarioRunHint[];
  nextHintKey: string | null;
  solution: ScenarioRunSolution;
  difficulty: "easy" | "medium" | "hard";
  estimatedMinutes: number;
  solvedAt: number | null;
  solveDurationMs: number | null;
  outcome: "in_progress" | "succeeded" | "cancelled" | "failed";
  progressPercent: number;
  terminalPhase: "pending" | "ready" | "failed";
  canOpenTerminal: boolean;
  canDestroy: boolean;
  createdAt: number;
  updatedAt: number;
  bootProbes: ScenarioProbeStatus[];
  scenarioProbes: ScenarioProbeStatus[];
  replayArtifacts: ScenarioReplayArtifact[];
  primaryReplayArtifactId: string | null;
  vms: ScenarioRunVmRecord[];
}

interface ScenarioObjective {
  probeName: string;
  vmName: string;
  label: string;
  title: string | null;
  bodyMarkdown: string | null;
  hintCount: number;
}

interface ScenarioRunHint {
  key: string;
  scope: "scenario" | "probe";
  probeName: string | null;
  id: string;
  title: string | null;
  revealed: boolean;
  bodyMarkdown: string | null;
}

interface ScenarioRunSolution {
  unlocked: boolean;
  revealed: boolean;
  assisted: boolean;
  revealedAt: number | null;
  bodyMarkdown: string | null;
}

interface ScenarioRunResponse {
  run: ScenarioRunRecord;
}

interface ScenarioDestroyAcceptedResponse {
  accepted: true;
  runId: string;
  acceptedAt: number;
}

interface ScenarioStatusStep {
  id: string;
  label: string;
  detail: string;
  state: "done" | "active" | "pending" | "failed";
}

const POLL_INTERVALS: Record<ScenarioRunRecord["phase"], number> = {
  launching: 1_500,
  booting: 1_500,
  waiting_for_target: 1_500,
  running: 1_500,
  solved: 1_500,
  deleting: 1_500,
  archiving: 1_500,
  completed: 20_000,
  failed: 20_000,
};

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

function formatScenarioReplayName(index: number, total: number) {
  if (total <= 1) {
    return "Terminal replay";
  }
  if (index === total - 1) {
    return "Latest replay";
  }
  return `Replay ${index + 1}`;
}

function formatScenarioElapsedTime(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return [hours, minutes, seconds]
      .map((value) => String(value).padStart(2, "0"))
      .join(":");
  }

  return [minutes, seconds]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

function formatScenarioDurationMs(durationMs: number) {
  return formatScenarioElapsedTime(Math.max(0, Math.floor(durationMs / 1_000)));
}

function ScenarioVmSelector(props: {
  vms: ScenarioRunVmRecord[];
  selectedVmId: string | null;
  onSelect: (vmId: string) => void;
}) {
  if (props.vms.length <= 1) {
    return null;
  }

  return (
    <div className="rounded-2xl border border-border/70 bg-muted/[0.18] p-2">
      <div className="mb-2 flex items-center justify-between px-2 pt-1">
        <div>
          <p className="text-sm font-medium tracking-tight">Mission VMs</p>
          <p className="text-xs text-muted-foreground">
            Switch the terminal and probe rail between scenario machines.
          </p>
        </div>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {props.vms.map((vm) => {
          const active = vm.id === props.selectedVmId;
          return (
            <button
              key={vm.id}
              type="button"
              onClick={() => props.onSelect(vm.id)}
              className={cn(
                "rounded-xl border px-4 py-3 text-left transition-colors",
                active
                  ? "border-foreground/20 bg-background shadow-sm"
                  : "border-transparent bg-transparent hover:border-border/80 hover:bg-background/70",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{vm.scenarioVmName}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {vm.hostname}
                  </p>
                </div>
                <Badge variant={vm.phase === "solved" ? "default" : "secondary"}>
                  {vm.phaseTitle}
                </Badge>
              </div>
              <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
                {vm.phaseDetail}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ScenarioProbeRail(props: {
  title: string;
  description: string;
  probes: ScenarioProbeStatus[];
  objectives: ScenarioObjective[];
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{props.title}</CardTitle>
        <CardDescription>{props.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {props.probes.length ? (
          props.probes.map((probe) => {
            const objective = props.objectives.find(
              (candidate) => candidate.probeName === probe.id,
            );
            return (
              <div
                key={probe.id}
                className={cn(
                  "rounded-lg border px-3 py-3",
                  probe.status === "pass"
                    ? "border-success/30 bg-success/[0.06]"
                    : probe.status === "fail"
                      ? "border-destructive/30 bg-destructive/5"
                      : "",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p
                      className={cn(
                        "truncate text-sm font-medium",
                        probe.status === "pass"
                          ? "text-success"
                          : "text-foreground",
                      )}
                    >
                      {objective?.title?.trim() || probe.label}
                    </p>
                    <p
                      className={cn(
                        "mt-1 text-xs",
                        probe.status === "pass"
                          ? "text-success/75"
                          : "text-muted-foreground",
                      )}
                    >
                      {probe.kind}
                    </p>
                  </div>
                  <ProbeBadge status={probe.status} />
                </div>
                {objective?.bodyMarkdown ? (
                  <Markdown
                    className={cn(
                      "mt-3 space-y-2 text-xs leading-6",
                      probe.status === "pass"
                        ? "text-success/85"
                        : "text-muted-foreground",
                    )}
                  >
                    {objective.bodyMarkdown}
                  </Markdown>
                ) : null}
                {probe.error ? (
                  <p className="mt-2 text-xs text-destructive">{probe.error}</p>
                ) : probe.status === "fail" &&
                  parseProbeValue(probe.kind, probe.value) ? (
                  <ProbeDetail
                    kind={probe.kind}
                    value={probe.value}
                    className="mt-3 rounded-md border border-destructive/20 bg-background/60 p-2.5"
                  />
                ) : (
                  <p
                    className={cn(
                      "mt-2 text-xs",
                      probe.status === "pass"
                        ? "text-success/80"
                        : "text-muted-foreground",
                    )}
                  >
                    {describeProbeValue(probe)}
                  </p>
                )}
              </div>
            );
          })
        ) : (
          <div className="border border-dashed border-border/70 px-3 py-6 text-sm text-muted-foreground">
            No probes in this section.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function HintList(props: {
  hints: ScenarioRunHint[];
  nextHintKey: string | null;
  onReveal: (hintKey: string) => void;
  pendingHintKey: string | null;
  error: string | null;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Lightbulb className="size-4 text-muted-foreground" />
          Hints
        </CardTitle>
        <CardDescription>Hints unlock in order.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {props.error ? <p className="text-xs text-destructive">{props.error}</p> : null}
        {props.hints.length ? (
          props.hints.map((hint, index) => {
            const canReveal = hint.key === props.nextHintKey;
            return (
              <div key={hint.key} className="rounded-lg border px-3 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {hint.title?.trim() || `Hint ${index + 1}`}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {hint.scope === "probe" && hint.probeName
                        ? `Probe: ${hint.probeName}`
                        : "Scenario"}
                    </p>
                  </div>
                  {hint.revealed ? (
                    <Badge variant="outline">Shown</Badge>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!canReveal || props.pendingHintKey === hint.key}
                      onClick={() => props.onReveal(hint.key)}
                    >
                      {props.pendingHintKey === hint.key ? "Revealing" : "Reveal"}
                    </Button>
                  )}
                </div>
                {hint.bodyMarkdown ? (
                  <Markdown className="mt-3 space-y-2 text-xs leading-6 text-muted-foreground">
                    {hint.bodyMarkdown}
                  </Markdown>
                ) : null}
              </div>
            );
          })
        ) : (
          <div className="border border-dashed border-border/70 px-3 py-6 text-sm text-muted-foreground">
            No hints for this run.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SolutionCard(props: {
  solution: ScenarioRunSolution;
  onReveal: () => void;
  pending: boolean;
  error: string | null;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const reveal = () => {
    setConfirmOpen(false);
    props.onReveal();
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          {props.solution.revealed ? (
            <Eye className="size-4 text-muted-foreground" />
          ) : (
            <LockKeyhole className="size-4 text-muted-foreground" />
          )}
          Solution
        </CardTitle>
        <CardDescription>
          {props.solution.revealed
            ? props.solution.assisted
              ? "Revealed before completion."
              : "Unlocked after completion."
            : props.solution.unlocked
              ? "Available after all objectives pass."
              : "Reveal now or solve first."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {props.error ? <p className="text-xs text-destructive">{props.error}</p> : null}
        {props.solution.bodyMarkdown ? (
          <Markdown className="space-y-2 text-xs leading-6 text-muted-foreground">
            {props.solution.bodyMarkdown}
          </Markdown>
        ) : props.solution.unlocked ? (
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={props.pending}
            onClick={props.onReveal}
          >
            {props.pending ? "Revealing" : "Show solution"}
          </Button>
        ) : (
          <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <DialogTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  disabled={props.pending}
                >
                  {props.pending ? "Revealing" : "Reveal solution"}
                </Button>
              }
            />
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Reveal solution?</DialogTitle>
                <DialogDescription>
                  Revealing before the scenario is solved marks this run as assisted.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setConfirmOpen(false)}
                >
                  Cancel
                </Button>
                <Button type="button" onClick={reveal}>
                  Reveal
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </CardContent>
    </Card>
  );
}

function ProbeBadge(props: { status: string }) {
  return (
    <Badge
      variant={props.status === "fail" ? "destructive" : "outline"}
      className={cn(
        "px-2.5 py-1 capitalize",
        props.status === "pass"
          ? "border-success/30 bg-success/10 text-success"
          : "",
      )}
    >
      {props.status}
    </Badge>
  );
}

function scenarioRunOutcomeMeta(outcome: ScenarioRunRecord["outcome"]) {
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
    case "in_progress":
      return {
        variant: "outline" as const,
        label: "In progress",
      };
  }
}

function ScenarioStepScreen(props: {
  title: string;
  description: string;
  progressLabel?: string;
  progressPercent?: number;
  steps: ScenarioStatusStep[];
  actions?: ReactNode;
  topRight?: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <CardTitle className="text-lg">{props.title}</CardTitle>
            <CardDescription className="leading-6">
              {props.description}
            </CardDescription>
          </div>
          {props.topRight ? (
            <div className="shrink-0 self-start">{props.topRight}</div>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-6" aria-live="polite">
        {typeof props.progressPercent === "number" ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">
                {props.progressLabel ?? "In progress"}
              </span>
              <span className="font-medium text-foreground">
                {props.progressPercent}%
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-primary motion-safe:transition-[width] duration-300"
                style={{ width: `${props.progressPercent}%` }}
              />
            </div>
          </div>
        ) : null}

        <ul className="space-y-3">
          {props.steps.map((step) => (
            <li
              key={step.id}
              className={cn(
                "flex items-start gap-3 rounded-lg px-3 py-2 text-sm",
                step.state === "done"
                  ? "bg-success/8"
                  : step.state === "active"
                    ? "bg-primary/6"
                    : step.state === "failed"
                      ? "bg-destructive/8"
                      : "bg-muted/40",
              )}
            >
              <span
                className={cn(
                  "mt-1.5 size-2 shrink-0 rounded-full",
                  step.state === "done"
                    ? "bg-success"
                    : step.state === "active"
                      ? "bg-primary"
                      : step.state === "failed"
                        ? "bg-destructive"
                        : "bg-border",
                )}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p
                    className={cn(
                      "font-medium",
                      step.state === "done"
                        ? "text-success"
                        : "text-foreground",
                    )}
                  >
                    {step.label}
                  </p>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[11px] font-medium",
                      step.state === "done"
                        ? "bg-success/15 text-success"
                        : step.state === "active"
                          ? "bg-primary/10 text-primary"
                          : step.state === "failed"
                            ? "bg-destructive/10 text-destructive"
                            : "bg-muted text-muted-foreground",
                    )}
                  >
                    {formatScenarioStepState(step.state)}
                  </span>
                </div>
                <p
                  className={cn(
                    "leading-6",
                    step.state === "done"
                      ? "text-success/80"
                      : "text-muted-foreground",
                  )}
                >
                  {step.detail}
                </p>
              </div>
            </li>
          ))}
        </ul>

        {props.actions ? (
          <div className="flex flex-wrap justify-end gap-3">
            {props.actions}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ScenarioCancelDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  pending: boolean;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogTrigger
        render={
          <Button size="sm" variant="destructive" className="w-full sm:w-auto">
            <Trash2 className="size-4" />
            Cancel scenario
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel this scenario?</DialogTitle>
          <DialogDescription>
            This ends the current run and saves the replay after cleanup
            finishes.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Keep going
          </Button>
          <Button
            variant="destructive"
            onClick={props.onConfirm}
            disabled={props.pending}
          >
            <Trash2 className="size-4" />
            {props.pending ? "Canceling..." : "Cancel scenario"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteRunDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  pending: boolean;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogTrigger
        render={
          <Button size="sm" variant="destructive" className="w-full sm:w-auto">
            <Trash2 className="size-4" />
            Delete run
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete this run?</DialogTitle>
          <DialogDescription>
            This removes the run and everything saved with it from your history.
            This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Keep run
          </Button>
          <Button
            variant="destructive"
            onClick={props.onConfirm}
            disabled={props.pending}
          >
            <Trash2 className="size-4" />
            {props.pending ? "Deleting..." : "Delete run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ScenarioSuccessOverlay(props: {
  scenarioName: string;
  probes: ScenarioProbeStatus[];
  solveDurationMs: number | null;
  pending: boolean;
  onConfirm: () => void;
}) {
  const solvedProbes = props.probes.filter((probe) => probe.status === "pass");

  return (
    <div className="fixed inset-0 z-40 bg-background p-4 sm:p-8">
      <div className="mx-auto flex h-full w-full max-w-7xl items-center justify-center">
        <div className="w-full space-y-6 rounded-xl border border-success/30 bg-success/[0.05] p-6 shadow-sm sm:p-8">
          <div className="space-y-4">
            <Badge
              variant="outline"
              className="w-fit border-success/30 bg-success/10 text-success"
            >
              <CheckCircle2 className="size-3.5" />
              Success
            </Badge>
            <div className="space-y-2">
              <h2 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                Scenario solved
              </h2>
              <p className="max-w-xl text-sm leading-6 text-muted-foreground sm:text-base">
                You completed {props.scenarioName}. End the scenario to save
                your replay and wrap up this run.
              </p>
            </div>
            {props.solveDurationMs !== null ? (
              <div className="inline-flex items-center gap-2 rounded-full border border-success/20 bg-background/80 px-3 py-1 text-xs text-muted-foreground">
                <Clock3 className="size-3.5" />
                <span>Solved in {formatScenarioDurationMs(props.solveDurationMs)}</span>
              </div>
            ) : null}
          </div>

          <div className="space-y-3">
            <p className="text-sm font-medium text-foreground">Solved checks</p>
            {solvedProbes.length ? (
              <ul className="grid gap-2 sm:grid-cols-2">
                {solvedProbes.map((probe) => (
                  <li
                    key={probe.id}
                    className="flex items-start gap-3 rounded-lg border border-success/20 bg-background/80 px-3 py-3"
                  >
                    <CheckCircle2
                      className="mt-0.5 size-4 shrink-0 text-success"
                      aria-hidden="true"
                    />
                    <div className="min-w-0 space-y-1">
                      <p className="text-sm font-medium text-foreground">
                        {probe.label}
                      </p>
                      <p className="text-xs leading-5 text-muted-foreground">
                        {probe.error ?? describeProbeValue(probe)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="rounded-lg border border-success/20 bg-background/80 px-4 py-3 text-sm text-muted-foreground">
                All scenario checks are complete.
              </div>
            )}
          </div>

          <Button
            size="lg"
            className="h-12 w-full bg-success text-success-foreground hover:bg-success/90 focus-visible:ring-success"
            onClick={props.onConfirm}
            disabled={props.pending}
          >
            <CheckCircle2 className="size-4" />
            {props.pending ? "Ending scenario..." : "End scenario"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ScenarioShellStatusCard(props: {
  phase: ScenarioRunRecord["phase"];
  title: string;
  description: string;
  pending?: boolean;
  actions?: ReactNode;
}) {
  const isTransient =
    props.pending === true ||
    props.phase === "deleting" ||
    props.phase === "archiving";

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Shell</CardTitle>
        <CardDescription>{props.title}</CardDescription>
      </CardHeader>
      <CardContent
        className="flex min-h-[20rem] flex-col items-center justify-center gap-4 text-center"
        aria-live="polite"
      >
        {isTransient ? (
          <LoaderCircle className="size-8 text-primary motion-safe:animate-spin" />
        ) : null}
        <div className="max-w-md space-y-2">
          <p className="text-sm font-medium text-foreground">
            {props.phase === "failed"
              ? "Scenario run stopped"
              : "Shell unavailable"}
          </p>
          <p className="text-sm leading-6 text-muted-foreground">
            {props.description}
          </p>
        </div>
        {props.actions ? (
          <div className="flex flex-wrap justify-center gap-3">
            {props.actions}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function buildScenarioBootSteps(
  attempt: ScenarioRunRecord | null,
): ScenarioStatusStep[] {
  if (!attempt) {
    return [];
  }

  const hasAnyReportedProbes = hasReportedProbeResults([
    ...attempt.bootProbes,
    ...attempt.scenarioProbes,
  ]);
  const bootChecksComplete = attempt.bootProbes.length
    ? attempt.bootProbes.every((probe) => probe.status === "pass")
    : attempt.canOpenTerminal;

  const steps: ScenarioStatusStep[] = [
    {
      id: "queue",
      label: "Start your scenario",
      detail:
        attempt.phase === "launching"
          ? "Lining up everything your run needs."
          : "Your scenario is underway.",
      state: attempt.phase === "launching" ? "active" : "done",
    },
    {
      id: "environment",
      label: "Prepare your workspace",
      detail:
        bootChecksComplete || attempt.canOpenTerminal
          ? "Your workspace is ready."
          : attempt.phase === "failed"
            ? "We could not finish setting things up."
            : "Setting up a fresh place for you to work.",
      state:
        attempt.phase === "failed" &&
        !bootChecksComplete &&
        !attempt.canOpenTerminal
          ? "failed"
          : bootChecksComplete || attempt.canOpenTerminal
            ? "done"
            : attempt.phase === "launching"
              ? "pending"
              : "active",
    },
  ];

  steps.push({
    id: "startup-checks",
    label: "Finish the last checks",
    detail:
      bootChecksComplete
        ? "Everything looks good so far."
        : attempt.canOpenTerminal && !hasAnyReportedProbes
          ? "Almost there. We are waiting for the first results to come in."
          : attempt.phase === "failed"
            ? "We could not confirm that everything was ready."
            : "Running the last setup checks before opening the terminal.",
    state:
      bootChecksComplete
        ? "done"
        : attempt.phase === "failed"
          ? "failed"
          : attempt.phase === "launching"
            ? "pending"
            : "active",
  });

  steps.push({
    id: "shell-access",
    label: "Open your terminal",
    detail:
      attempt.canOpenTerminal && hasAnyReportedProbes
        ? "Your terminal is ready."
        : attempt.canOpenTerminal
          ? "We are waiting for the last check to come through."
          : bootChecksComplete
            ? "Connecting the last part of your workspace."
            : "Waiting for the earlier steps to finish.",
    state:
      attempt.canOpenTerminal && hasAnyReportedProbes
        ? "done"
        : attempt.phase === "failed"
          ? "failed"
          : bootChecksComplete && !hasAnyReportedProbes
            ? "pending"
            : bootChecksComplete
              ? "active"
              : "pending",
  });

  return steps;
}

function buildScenarioShutdownSteps(
  attempt: ScenarioRunRecord | null,
  shutdownRequested: boolean,
): ScenarioStatusStep[] {
  if (!attempt) {
    return [];
  }

  const phase =
    attempt.phase === "completed"
      ? "done"
      : attempt.phase === "failed"
        ? "failed"
        : attempt.phase === "archiving"
          ? "uploading"
          : attempt.phase === "deleting" || shutdownRequested
            ? "destroying"
            : "destroying";

  return [
    {
      id: "destroying",
      label: "Destroying",
      detail:
        phase === "destroying"
          ? "Removing the VM before the run is archived."
          : phase === "failed"
            ? "The shutdown did not finish cleanly."
          : "The VM has been removed.",
      state:
        phase === "destroying"
          ? "active"
          : phase === "failed"
            ? "failed"
            : "done",
    },
    {
      id: "uploading",
      label: "Uploading",
      detail:
        phase === "uploading"
          ? "Saving recordings and logs from this run."
          : phase === "failed"
            ? "Recordings or logs did not finish uploading."
          : "Uploads start once the VM is fully removed.",
      state:
        phase === "uploading"
          ? "active"
          : phase === "destroying"
            ? "pending"
            : phase === "failed"
              ? "failed"
              : "done",
    },
  ];
}

function formatScenarioStepState(state: ScenarioStatusStep["state"]) {
  switch (state) {
    case "done":
      return "Done";
    case "active":
      return "In progress";
    case "failed":
      return "Failed";
    default:
      return "Pending";
  }
}

function getScenarioBootScreenCopy(attempt: ScenarioRunRecord | null) {
  if (!attempt) {
    return {
      title: "Queued",
      description: "Hang tight while we get everything ready for you.",
    };
  }

  if (attempt.canOpenTerminal && !hasReportedProbeResults([...attempt.bootProbes, ...attempt.scenarioProbes])) {
    return {
      title: "Almost ready",
      description:
        "Your workspace is up. We are finishing the last checks before opening the terminal.",
    };
  }

  switch (attempt.phase) {
    case "launching":
      return {
        title: "Queued",
        description: "Waiting for the selected host to accept the launch.",
      };
    case "booting":
      return {
        title: "Preparing workspace",
        description: "Running the last setup checks before opening the terminal.",
      };
    case "waiting_for_target":
      return {
        title: "Waiting for shell",
        description:
          "Your workspace is ready. Waiting for shell access to become ready.",
      };
    default:
      return {
        title: "Getting your scenario ready",
        description:
          "We are preparing your workspace and checking that everything is ready.",
      };
  }
}

function getScenarioShutdownScreenCopy(
  attempt: ScenarioRunRecord | null,
  shutdownRequested: boolean,
) {
  if (!attempt) {
    return {
      title: "Destroying",
      description: "We are closing your run and cleaning up the workspace.",
    };
  }

  if (attempt.phase === "archiving") {
    return {
      title: "Uploading",
      description: "Saving recordings and logs from this run.",
    };
  }

  return {
    title: "Destroying",
    description:
      shutdownRequested || attempt.phase === "deleting"
        ? "Removing the VM before the run is archived."
        : "We are closing your run and cleaning up the workspace.",
  };
}

function describeProbeValue(probe: ScenarioProbeStatus) {
  if (probe.value === null || probe.value === undefined) {
    return probe.status === "pass"
      ? "Passing"
      : "Waiting for a passing signal.";
  }

  const summary = summarizeProbeValue(probe.kind, probe.value);
  if (summary) return summary;

  if (typeof probe.value === "string") {
    return probe.value;
  }

  if (typeof probe.value === "number" || typeof probe.value === "boolean") {
    return String(probe.value);
  }

  if (typeof probe.value === "object") {
    const record = probe.value as Record<string, unknown>;
    if (typeof record.state === "string") return `State: ${record.state}`;
    if (
      typeof record.service === "string" &&
      typeof record.expectedState === "string"
    ) {
      return `${record.service} should be ${record.expectedState}`;
    }
    if (typeof record.path === "string") return record.path;
    if (typeof record.host === "string" && typeof record.port === "number") {
      return `${record.host}:${record.port}`;
    }
  }

  return probe.status === "pass" ? "Passing" : "Waiting for a passing signal.";
}

function hasReportedProbeResults(probes: ScenarioProbeStatus[]) {
  return probes.some(
    (probe) =>
      probe.status !== "pending" ||
      probe.error !== null ||
      probe.value !== null,
  );
}

function hasUsableTerminalTarget(vm: ScenarioRunVmRecord) {
  return Boolean(
    vm.canOpenTerminal && vm.terminalTarget.host && vm.terminalTarget.port > 0,
  );
}
