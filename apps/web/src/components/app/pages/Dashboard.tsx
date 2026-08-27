import {
  lazy,
  startTransition,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "@tanstack/react-router";
import { Activity, Archive, CircleAlert, Server, Shapes } from "lucide-react";
import { PageShell } from "@/components/app/patterns/PageShell";
import {
  COLLECTION_PAGE_SIZE,
  PaginatedCollection,
} from "@/components/app/patterns/CollectionPagination";
import { Section } from "@/components/app/patterns/Section";
import { TableSkeleton } from "@/components/app/patterns/Skeletons";
import type { RunArtifactViewerState } from "@/components/app/RunArtifactViewer";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { scenarioRunArtifactContentPath } from "@/lib/artifact-content-paths";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { parseTimestamp } from "@/components/app/admin/hosts/format";
import { LiveScenarioRunCard } from "@/components/app/admin/hosts/LiveScenarioRunCard";
import { ScenarioRunArchiveCard } from "@/components/app/admin/hosts/ScenarioRunArchiveCard";
import { useAdminScenarios } from "@/components/app/admin/hosts/useAdminScenarios";
import { useHostFleet } from "@/components/app/admin/hosts/useHostFleet";
import type {
  AgentVmRunArtifact,
  AgentVmRunRecord,
  ArchivedScenarioRunRecord,
  LiveScenarioRunRecord,
} from "@/components/app/admin/hosts/types";

const LazyWebSshTerminal = lazy(async () => {
  const { WebSshTerminal } = await import(
    "@/components/remote-access/WebSshTerminal"
  );
  return { default: WebSshTerminal };
});

const ARTIFACT_TEXT_PREVIEW_BYTES = 256 * 1024;
const ARTIFACT_REPLAY_PREVIEW_BYTES = 2 * 1024 * 1024;
const ARTIFACT_PREVIEW_FLUSH_MS = 50;
const DASHBOARD_ARCHIVE_PAGE_SIZE = 6;

// Admin overview: fleet-wide KPIs plus the live and archived scenario runs.
// Host operations live on /admin/hosts.
export function Dashboard() {
  const [vmError, setVmError] = useState<string | null>(null);
  const [vmNotice, setVmNotice] = useState<string | null>(null);
  const [vmBusyKey, setVmBusyKey] = useState<string | null>(null);
  const [expandedActiveVms, setExpandedActiveVms] = useState<
    Record<string, boolean>
  >({});
  const [expandedRuns, setExpandedRuns] = useState<Record<string, boolean>>({});
  const [artifactViewerByRun, setArtifactViewerByRun] = useState<
    Record<string, RunArtifactViewerState>
  >({});
  const artifactStreamRef = useRef<Record<string, AbortController>>({});
  const [archiveDetailsByRun, setArchiveDetailsByRun] = useState<
    Record<string, AgentVmRunRecord>
  >({});
  const [archiveDetailLoadingByRun, setArchiveDetailLoadingByRun] = useState<
    Record<string, true>
  >({});
  const [archiveDetailErrorsByRun, setArchiveDetailErrorsByRun] = useState<
    Record<string, string>
  >({});
  const archiveDetailPendingRef = useRef<Record<string, true>>({});
  const archiveDetailGenerationRef = useRef<Record<string, number>>({});
  const [activeWebSsh, setActiveWebSsh] = useState<{
    hostId: string;
    runId: string;
    vmId: string;
    vmName: string;
  } | null>(null);
  const [endTarget, setEndTarget] = useState<{
    hostId: string;
    runId: string;
    vmName: string;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    hostId: string;
    runId: string;
  } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState("");

  const {
    hosts,
    hostRecords,
    liveLoadedCount,
    liveTotalCount,
    archiveTotalCount,
    hasMoreArchives,
    hasMoreLive,
    isLoadingMoreArchives,
    loadMoreArchivesError,
    loadMoreArchives,
    refreshHost,
    forgetArchivedRun,
    loadArchivedRunDetail,
  } = useHostFleet();
  const scenarios = useAdminScenarios();
  const launchableScenarios = scenarios.data?.scenarios ?? [];

  useEffect(() => {
    return () => {
      for (const controller of Object.values(artifactStreamRef.current)) {
        controller.abort();
      }
      for (const viewerKey of Object.keys(archiveDetailGenerationRef.current)) {
        archiveDetailGenerationRef.current[viewerKey] =
          (archiveDetailGenerationRef.current[viewerKey] ?? 0) + 1;
      }
    };
  }, []);

  const loadArchiveRunDetail = async (hostId: string, runId: string) => {
    const viewerKey = `${hostId}:${runId}`;
    if (
      archiveDetailsByRun[viewerKey] ||
      archiveDetailPendingRef.current[viewerKey]
    ) {
      return;
    }

    const generation = (archiveDetailGenerationRef.current[viewerKey] ?? 0) + 1;
    archiveDetailGenerationRef.current[viewerKey] = generation;
    archiveDetailPendingRef.current[viewerKey] = true;
    setArchiveDetailLoadingByRun((current) => ({
      ...current,
      [viewerKey]: true,
    }));
    setArchiveDetailErrorsByRun((current) => {
      const next = { ...current };
      delete next[viewerKey];
      return next;
    });

    try {
      const detail = await loadArchivedRunDetail(hostId, runId);
      if (archiveDetailGenerationRef.current[viewerKey] !== generation) {
        return;
      }
      setArchiveDetailsByRun((current) => ({
        ...current,
        [viewerKey]: detail,
      }));
    } catch (error) {
      if (archiveDetailGenerationRef.current[viewerKey] !== generation) {
        return;
      }
      setArchiveDetailErrorsByRun((current) => ({
        ...current,
        [viewerKey]:
          error instanceof Error ? error.message : "failed to load run details",
      }));
    } finally {
      if (archiveDetailGenerationRef.current[viewerKey] !== generation) {
        return;
      }
      delete archiveDetailPendingRef.current[viewerKey];
      setArchiveDetailLoadingByRun((current) => {
        const next = { ...current };
        delete next[viewerKey];
        return next;
      });
    }
  };

  const streamArtifactContent = async (
    hostId: string,
    runId: string,
    artifact: AgentVmRunArtifact,
  ) => {
    const viewerKey = `${hostId}:${runId}`;
    const contentUrl = scenarioRunArtifactContentPath(runId, artifact.id);
    const preview = artifactPreviewRequest(artifact);
    const previewTruncated = preview.previewTruncated;
    artifactStreamRef.current[viewerKey]?.abort();

    const controller = new AbortController();
    artifactStreamRef.current[viewerKey] = controller;
    setArtifactViewerByRun((current) => ({
      ...current,
      [viewerKey]: {
        artifact,
        loading: true,
        error: null,
        content: "",
        receivedBytes: 0,
        previewTruncated,
        downloadUrl: contentUrl,
      },
    }));

    try {
      const response = await fetch(
        contentUrl,
        {
          method: "GET",
          credentials: "include",
          signal: controller.signal,
          ...preview.requestInit,
        },
      );

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          body?.error ?? `Failed to load artifact (${response.status})`,
        );
      }

      if (!response.body) {
        const text = await response.text();
        setArtifactViewerByRun((current) => ({
          ...current,
          [viewerKey]: {
            artifact,
            loading: false,
            error: null,
            content: text,
            receivedBytes: new TextEncoder().encode(text).byteLength,
            previewTruncated,
            downloadUrl: contentUrl,
          },
        }));
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = "";
      let receivedBytes = 0;
      let lastPublishedAt = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        receivedBytes += value.byteLength;
        accumulated += decoder.decode(value, { stream: true });
        const now = Date.now();
        if (now - lastPublishedAt < ARTIFACT_PREVIEW_FLUSH_MS) continue;
        lastPublishedAt = now;
        const content = accumulated;
        const publishedBytes = receivedBytes;
        startTransition(() => {
          setArtifactViewerByRun((current) => ({
            ...current,
            [viewerKey]: {
              artifact,
              loading: true,
              error: null,
              content,
              receivedBytes: publishedBytes,
              previewTruncated,
              downloadUrl: contentUrl,
            },
          }));
        });
      }

      accumulated += decoder.decode();
      setArtifactViewerByRun((current) => ({
        ...current,
        [viewerKey]: {
          artifact,
          loading: false,
          error: null,
          content: accumulated,
          receivedBytes,
          previewTruncated,
          downloadUrl: contentUrl,
        },
      }));
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      setArtifactViewerByRun((current) => ({
        ...current,
        [viewerKey]: {
          artifact,
          loading: false,
          error:
            error instanceof Error
              ? error.message
              : "failed to stream artifact",
          content: current[viewerKey]?.content ?? "",
          receivedBytes: current[viewerKey]?.receivedBytes ?? 0,
          previewTruncated,
          downloadUrl: contentUrl,
        },
      }));
    } finally {
      if (artifactStreamRef.current[viewerKey] === controller) {
        delete artifactStreamRef.current[viewerKey];
      }
    }
  };

  const handleDestroyRun = async (
    hostId: string,
    runId: string,
    vmName: string,
  ) => {
    const busyKey = `${hostId}:destroy-run:${runId}`;
    setVmBusyKey(busyKey);
    setVmError(null);
    setVmNotice(null);
    try {
      const response = await fetch(
        `/api/scenarios/runs/${encodeURIComponent(runId)}/destroy`,
        {
          method: "POST",
          credentials: "include",
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          body?.error ?? `Failed to request end run (${response.status})`,
        );
      }
      setVmNotice(`End requested for ${vmName}`);
      setEndTarget(null);
      setExpandedActiveVms((current) => {
        const next = { ...current };
        delete next[`${hostId}:${vmName}`];
        return next;
      });
      setActiveWebSsh((current) =>
        current && current.hostId === hostId && current.runId === runId
          ? null
          : current,
      );
      await refreshHost(hostId);
    } catch (error) {
      setVmError(
        error instanceof Error ? error.message : "failed to request end run",
      );
    } finally {
      setVmBusyKey((current) => (current === busyKey ? null : current));
    }
  };

  const handleDeleteRun = async (hostId: string, runId: string) => {
    const busyKey = `${hostId}:delete-run:${runId}`;
    const viewerKey = `${hostId}:${runId}`;
    setVmBusyKey(busyKey);
    setVmError(null);
    setVmNotice(null);
    try {
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

      artifactStreamRef.current[viewerKey]?.abort();
      delete artifactStreamRef.current[viewerKey];
      archiveDetailGenerationRef.current[viewerKey] =
        (archiveDetailGenerationRef.current[viewerKey] ?? 0) + 1;
      delete archiveDetailPendingRef.current[viewerKey];
      setExpandedRuns((current) => {
        const next = { ...current };
        delete next[viewerKey];
        return next;
      });
      setArtifactViewerByRun((current) => {
        const next = { ...current };
        delete next[viewerKey];
        return next;
      });
      setArchiveDetailsByRun((current) => {
        const next = { ...current };
        delete next[viewerKey];
        return next;
      });
      setArchiveDetailLoadingByRun((current) => {
        const next = { ...current };
        delete next[viewerKey];
        return next;
      });
      setArchiveDetailErrorsByRun((current) => {
        const next = { ...current };
        delete next[viewerKey];
        return next;
      });
      forgetArchivedRun(hostId, runId);
      setVmNotice(`Deleted archived run ${runId}`);
      setDeleteTarget(null);
      setDeleteConfirm("");
      await refreshHost(hostId);
    } catch (error) {
      setVmError(
        error instanceof Error ? error.message : "failed to delete run",
      );
    } finally {
      setVmBusyKey((current) => (current === busyKey ? null : current));
    }
  };

  const connectedHostCount = hostRecords.filter(
    ({ host }) => host.status?.connected,
  ).length;
  const activeVmCount = hostRecords.reduce(
    (total, { hostVms }) => total + hostVms.length,
    0,
  );
  const archivedRunCount = archiveTotalCount;
  const enabledScenarioCount = launchableScenarios.filter(
    (scenario) => scenario.enabled,
  ).length;
  const attentionHostCount = hostRecords.filter(
    ({ host }) =>
      !host.status?.connected ||
      host.disabled ||
      host.actualState?.health === "degraded",
  ).length;
  const liveScenarioRuns = useMemo<LiveScenarioRunRecord[]>(
    () =>
      hostRecords
        .flatMap(({ host, hostVms }) =>
          hostVms
            .filter((vm) => Boolean(vm.run_id))
            .map((vm) => ({ host, vm })),
        )
        .sort(
          (left, right) =>
            parseTimestamp(right.vm.updated_at) -
            parseTimestamp(left.vm.updated_at),
        ),
    [hostRecords],
  );
  const archivedScenarioRuns = useMemo<ArchivedScenarioRunRecord[]>(
    () =>
      hostRecords
        .flatMap(({ host, hostRuns }) => hostRuns.map((run) => ({ host, run })))
        .sort((left, right) => {
          const leftTime =
            left.run.deletedAt ??
            left.run.uploadCompletedAt ??
            left.run.updatedAt ??
            left.run.createdAt;
          const rightTime =
            right.run.deletedAt ??
            right.run.uploadCompletedAt ??
            right.run.updatedAt ??
            right.run.createdAt;
          return rightTime - leftTime;
        }),
    [hostRecords],
  );
  return (
    <PageShell width="workspace" density="compact">
      <Section
        title="Operational ledger"
        description="Current fleet posture from the latest host reports."
        variant="flat"
        density="compact"
        className="rounded-none border-0 bg-transparent py-2"
        bodyClassName="divide-y divide-border/50 px-0"
      >
        <LedgerRow
          icon={<CircleAlert />}
          label="Needs attention"
          value={String(attentionHostCount)}
          detail={
            attentionHostCount
              ? "Offline, degraded, or disabled hosts"
              : "No host exceptions"
          }
          tone={attentionHostCount ? "warning" : "success"}
          action={
            <Button
              size="sm"
              variant="ghost"
              className="h-auto p-0 text-xs font-medium text-muted-foreground hover:bg-transparent hover:text-foreground"
              render={<Link to="/admin/hosts" />}
            >
              Review hosts
            </Button>
          }
        />
        <LedgerRow
          icon={<Server />}
          label="Fleet connectivity"
          value={`${connectedHostCount}/${hostRecords.length}`}
          detail="Hosts connected"
        />
        <LedgerRow
          icon={<Activity />}
          label="Live work"
          value={String(activeVmCount)}
          detail="Active scenario VMs"
          action={
            <Button
              size="sm"
              variant="ghost"
              className="h-auto p-0 text-xs font-medium text-muted-foreground hover:bg-transparent hover:text-foreground"
              render={<a href="#live-runs" />}
            >
              Inspect live work
            </Button>
          }
        />
        <LedgerRow
          icon={<Archive />}
          label="Run archive"
          value={String(archivedRunCount)}
          detail="Retained sessions"
        />
        <LedgerRow
          icon={<Shapes />}
          label="Scenario availability"
          value={`${enabledScenarioCount}/${launchableScenarios.length}`}
          detail="Enabled for learners"
          tone={enabledScenarioCount ? "default" : "warning"}
          action={
            <Button
              size="sm"
              variant="ghost"
              className="h-auto p-0 text-xs font-medium text-muted-foreground hover:bg-transparent hover:text-foreground"
              render={<Link to="/admin/scenarios" />}
            >
              Open registry
            </Button>
          }
        />
      </Section>

      <div className="space-y-3 empty:hidden">
        {scenarios.error ? (
          <Alert variant="destructive">
            <AlertTitle>Could not load scenarios</AlertTitle>
            <AlertDescription>
              {scenarios.error instanceof Error
                ? scenarios.error.message
                : "Failed to load scenarios"}
            </AlertDescription>
          </Alert>
        ) : null}
        {hosts.error ? (
          <Alert variant="destructive">
            <AlertTitle>Could not load hosts</AlertTitle>
            <AlertDescription>
              {hosts.error instanceof Error
                ? hosts.error.message
                : "Failed to load hosts"}
            </AlertDescription>
          </Alert>
        ) : null}
        {vmError ? (
          <Alert variant="destructive">
            <AlertTitle>VM action failed</AlertTitle>
            <AlertDescription>{vmError}</AlertDescription>
          </Alert>
        ) : null}
        {vmNotice ? (
          <Alert>
            <AlertTitle>Host update</AlertTitle>
            <AlertDescription>{vmNotice}</AlertDescription>
          </Alert>
        ) : null}
      </div>

      <div id="live-runs" className="scroll-mt-24">
        <Section
          density="compact"
          title="Live scenario runs"
          description="Everything currently running across the fleet."
          actions={
            <Badge variant="outline">
              {hasMoreLive
                ? `Newest ${liveLoadedCount} of ${liveTotalCount} runs`
                : `${liveTotalCount} active`}
            </Badge>
          }
        >
          {hosts.isPending ? (
            <TableSkeleton rows={2} />
          ) : liveScenarioRuns.length ? (
            <PaginatedCollection
              items={liveScenarioRuns}
              pageSize={COLLECTION_PAGE_SIZE.cards}
              itemLabel="live runs"
            >
              {(visibleRuns) => (
                <div className="space-y-4">
                  {visibleRuns.map(({ host, vm }) => {
                    const vmKey = `${host.id}:${vm.name}`;
                    return (
                      <LiveScenarioRunCard
                        key={vmKey}
                        host={host}
                        vmItem={vm}
                        isExpanded={Boolean(expandedActiveVms[vmKey])}
                        onToggle={() => {
                          setExpandedActiveVms((current) => ({
                            ...current,
                            [vmKey]: !current[vmKey],
                          }));
                        }}
                        onOpenWebSsh={() => {
                          if (!vm.run_id) return;
                          setActiveWebSsh({
                            hostId: host.id,
                            runId: vm.run_id,
                            vmId: vm.id,
                            vmName: vm.name,
                          });
                        }}
                        onDelete={() => {
                          if (!vm.run_id) return;
                          setEndTarget({
                            hostId: host.id,
                            runId: vm.run_id,
                            vmName: vm.name,
                          });
                        }}
                        isDeleting={
                          vmBusyKey === `${host.id}:destroy-run:${vm.run_id}`
                        }
                      />
                    );
                  })}
                </div>
              )}
            </PaginatedCollection>
          ) : (
            <OperationalEmptyState
              title="No active scenario runs"
              description="Runs launched by learners or from the Hosts page show up here in real time."
            />
          )}
        </Section>
      </div>

      <Section
        density="compact"
        title="Run archive"
        description="Finished runs with their captured artifacts."
        actions={
          <Badge variant="outline">
            {archivedRunCount} retained
            {hasMoreArchives ? ` · ${archivedScenarioRuns.length} shown` : ""}
          </Badge>
        }
      >
        {hosts.isPending ? (
          <TableSkeleton rows={2} />
        ) : archivedScenarioRuns.length ? (
          <PaginatedCollection
            items={archivedScenarioRuns}
            pageSize={DASHBOARD_ARCHIVE_PAGE_SIZE}
            itemLabel="archived runs"
          >
            {(visibleRuns) => (
              <div className="space-y-4">
                {visibleRuns.map(({ host, run }) => {
                  const viewerKey = `${host.id}:${run.id}`;
                  return (
                    <ScenarioRunArchiveCard
                      key={viewerKey}
                      host={host}
                      run={run}
                      detail={archiveDetailsByRun[viewerKey] ?? null}
                      isDetailLoading={Boolean(
                        archiveDetailLoadingByRun[viewerKey],
                      )}
                      detailError={archiveDetailErrorsByRun[viewerKey] ?? null}
                      viewer={artifactViewerByRun[viewerKey] ?? null}
                      isExpanded={Boolean(expandedRuns[viewerKey])}
                      onToggle={() => {
                        const isExpanded = Boolean(expandedRuns[viewerKey]);
                        setExpandedRuns((current) => ({
                          ...current,
                          [viewerKey]: !isExpanded,
                        }));
                        if (!isExpanded) {
                          void loadArchiveRunDetail(host.id, run.id);
                        }
                      }}
                      onDelete={() => {
                        setDeleteConfirm("");
                        setDeleteTarget({ hostId: host.id, runId: run.id });
                      }}
                      onStreamArtifact={(artifact) => {
                        void streamArtifactContent(host.id, run.id, artifact);
                      }}
                      isDeleting={
                        vmBusyKey === `${host.id}:delete-run:${run.id}`
                      }
                    />
                  );
                })}
              </div>
            )}
          </PaginatedCollection>
        ) : (
          <OperationalEmptyState
            title="No archived scenario runs yet"
            description="Finished runs land here once their recordings upload."
          />
        )}
        {hasMoreArchives ? (
          <div className="mt-6 flex flex-col items-center gap-2 border-t pt-4">
            <Button
              type="button"
              variant="outline"
              disabled={isLoadingMoreArchives}
              onClick={() => {
                void loadMoreArchives().catch(() => {
                  // The request error is shown directly below this control.
                });
              }}
            >
              {isLoadingMoreArchives ? "Loading older runs…" : "Load older runs"}
            </Button>
            {loadMoreArchivesError ? (
              <p className="text-sm text-destructive" role="alert">
                {loadMoreArchivesError.message}
              </p>
            ) : null}
          </div>
        ) : null}
      </Section>

      {activeWebSsh ? (
        <Suspense fallback={null}>
          <LazyWebSshTerminal
            vmName={activeWebSsh.vmName}
            sessionRequest={{
              url: `/api/scenarios/runs/${encodeURIComponent(activeWebSsh.runId)}/ssh`,
              body: { vmId: activeWebSsh.vmId },
            }}
            onClose={() => setActiveWebSsh(null)}
          />
        </Suspense>
      ) : null}

      <Dialog
        open={endTarget !== null}
        onOpenChange={(open) => !open && setEndTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>End this run?</DialogTitle>
            <DialogDescription>
              This stops active work on {endTarget?.vmName}. Captured history
              remains available after archival.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEndTarget(null)}
              disabled={vmBusyKey !== null}
            >
              Keep running
            </Button>
            <Button
              variant="destructive"
              disabled={!endTarget || vmBusyKey !== null}
              onClick={() => {
                if (endTarget) {
                  void handleDestroyRun(
                    endTarget.hostId,
                    endTarget.runId,
                    endTarget.vmName,
                  );
                }
              }}
            >
              {vmBusyKey ? "Ending…" : "End run"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
            setDeleteConfirm("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this run?</DialogTitle>
            <DialogDescription>
              This permanently removes the archived history and captured
              artifacts. Type the run ID to confirm.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label htmlFor="delete-run-confirm" className="font-mono text-sm">
              {deleteTarget?.runId}
            </label>
            <Input
              id="delete-run-confirm"
              value={deleteConfirm}
              onChange={(event) => setDeleteConfirm(event.target.value)}
              autoComplete="off"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={vmBusyKey !== null}
            >
              Keep history
            </Button>
            <Button
              variant="destructive"
              disabled={
                !deleteTarget ||
                deleteConfirm !== deleteTarget.runId ||
                vmBusyKey !== null
              }
              onClick={() => {
                if (deleteTarget)
                  void handleDeleteRun(deleteTarget.hostId, deleteTarget.runId);
              }}
            >
              {vmBusyKey ? "Deleting…" : "Delete run"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}

function isReplayArtifact(
  artifact: Pick<AgentVmRunArtifact, "contentType" | "filename" | "kind">,
) {
  return (
    artifact.kind === "ssh_recording_segment" ||
    artifact.contentType.includes("asciicast") ||
    artifact.filename.endsWith(".cast")
  );
}

export function artifactPreviewRequest(
  artifact: Pick<AgentVmRunArtifact, "contentType" | "filename" | "kind" | "sizeBytes">,
): { previewTruncated: boolean; requestInit: RequestInit } {
  const previewTruncated =
    artifact.sizeBytes >
    (isReplayArtifact(artifact)
      ? ARTIFACT_REPLAY_PREVIEW_BYTES
      : ARTIFACT_TEXT_PREVIEW_BYTES);
  const previewBytes = isReplayArtifact(artifact)
    ? ARTIFACT_REPLAY_PREVIEW_BYTES
    : ARTIFACT_TEXT_PREVIEW_BYTES;
  return previewTruncated
    ? {
        previewTruncated: true,
        requestInit: {
          headers: { range: `bytes=0-${previewBytes - 1}` },
        },
      }
    : { previewTruncated: false, requestInit: {} };
}

function OperationalEmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-lg bg-muted/30 px-4 py-3">
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="mt-1 max-w-2xl text-metadata">{description}</p>
    </div>
  );
}

function LedgerRow({
  icon,
  label,
  value,
  detail,
  tone = "default",
  action,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
  tone?: "default" | "success" | "warning";
  action?: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[1.4rem_minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-3 sm:grid-cols-[1.4rem_minmax(12rem,1fr)_auto_minmax(7.5rem,auto)] sm:gap-x-4">
      <span
        className={cn(
          tone === "warning"
            ? "text-warning"
            : tone === "success"
              ? "text-success"
              : "text-muted-foreground",
        )}
      >
        {icon}
      </span>
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-metadata">{detail}</p>
      </div>
      <div className="flex min-w-20 flex-col items-end gap-0.5 text-right sm:contents">
        <p className="text-sm font-semibold tabular-nums sm:col-start-3 sm:justify-self-end">
          {value}
        </p>
        {action ? (
          <div className="sm:col-start-4 sm:justify-self-end">{action}</div>
        ) : null}
      </div>
    </div>
  );
}
