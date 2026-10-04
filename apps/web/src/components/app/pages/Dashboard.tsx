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
import {
  Activity,
  Archive,
  CircleAlert,
  RefreshCw,
  Search,
  Server,
  Shapes,
} from "lucide-react";
import { PageShell } from "@/components/app/patterns/PageShell";
import {
  COLLECTION_PAGE_SIZE,
  PaginatedCollection,
} from "@/components/app/patterns/CollectionPagination";
import { Section } from "@/components/app/patterns/Section";
import { FilterBar, FilterChip } from "@/components/app/patterns/FilterBar";
import {
  CardGridSkeleton,
  TableSkeleton,
} from "@/components/app/patterns/Skeletons";
import { ConfirmDialog } from "@/components/app/patterns/ConfirmDialog";
import { InlineFeedback } from "@/components/app/patterns/InlineFeedback";
import { RollingNumber } from "@/components/app/patterns/RollingNumber";
import { EmptyState } from "@/components/app/patterns/StateCard";
import type { RunArtifactViewerState } from "@/components/app/RunArtifactViewer";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { adminScenarioRunArtifactContentPath } from "@/lib/artifact-content-paths";
import { Input } from "@/components/ui/input";
import { parseTimestamp } from "@/components/app/admin/hosts/format";
import { LiveScenarioRunCard } from "@/components/app/admin/hosts/LiveScenarioRunCard";
import { ScenarioRunArchiveCard } from "@/components/app/admin/hosts/ScenarioRunArchiveCard";
import { useAdminScenarios } from "@/components/app/admin/hosts/useAdminScenarios";
import { useAdminRunArchive } from "@/components/app/admin/hosts/useAdminRunArchive";
import { useHostFleet } from "@/components/app/admin/hosts/useHostFleet";
import type {
  AgentVmRunArtifact,
  AgentVmRunRecord,
  AgentVmRunSummary,
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
type ArchiveOutcome = AgentVmRunSummary["outcome"];

const ARCHIVE_OUTCOME_FILTERS = [
  ["succeeded", "Succeeded"],
  ["cancelled", "Cancelled"],
  ["failed", "Failed"],
] as const satisfies ReadonlyArray<readonly [ArchiveOutcome, string]>;

// Admin overview: fleet-wide KPIs plus the live and archived scenario runs.
// Host operations live on /admin/hosts.
export function Dashboard() {
  const [vmError, setVmError] = useState<{
    title: string;
    message: string;
  } | null>(null);
  const archiveSearchRef = useRef<HTMLInputElement>(null);
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
  const [archiveSearch, setArchiveSearch] = useState("");
  const [archiveOutcomes, setArchiveOutcomes] = useState<
    readonly ArchiveOutcome[]
  >([]);

  const {
    hosts,
    hostRecords,
    liveLoadedCount,
    liveTotalCount,
    hasMoreLive,
    refreshHost,
  } = useHostFleet();
  const {
    runs: archivedScenarioRuns,
    totalCount: archiveTotalCount,
    hasMore: hasMoreArchives,
    isPending: isArchivePending,
    error: archiveError,
    refetch: refreshArchive,
    isLoadingMore: isLoadingMoreArchives,
    loadMoreError: loadMoreArchivesError,
    loadMore: loadMoreArchives,
    loadRunDetail: loadArchivedRunDetail,
    forgetRun: forgetArchivedRun,
  } = useAdminRunArchive();
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

  useEffect(() => {
    const currentUpdatedAt = new Map(
      archivedScenarioRuns.map(({ host, run }) => [
        `${host.id}:${run.id}`,
        run.updatedAt,
      ]),
    );
    const staleKeys = Object.entries(archiveDetailsByRun)
      .filter(
        ([viewerKey, detail]) =>
          !currentUpdatedAt.has(viewerKey) ||
          currentUpdatedAt.get(viewerKey) !== detail.updatedAt,
      )
      .map(([viewerKey]) => viewerKey);
    if (!staleKeys.length) return;
    const stale = new Set(staleKeys);
    for (const viewerKey of stale) {
      artifactStreamRef.current[viewerKey]?.abort();
      delete artifactStreamRef.current[viewerKey];
      archiveDetailGenerationRef.current[viewerKey] =
        (archiveDetailGenerationRef.current[viewerKey] ?? 0) + 1;
      delete archiveDetailPendingRef.current[viewerKey];
    }
    setExpandedRuns((current) => omitRecordKeys(current, stale));
    setArchiveDetailsByRun((current) => omitRecordKeys(current, stale));
    setArchiveDetailLoadingByRun((current) => omitRecordKeys(current, stale));
    setArchiveDetailErrorsByRun((current) => omitRecordKeys(current, stale));
    setArtifactViewerByRun((current) => omitRecordKeys(current, stale));
  }, [archiveDetailsByRun, archivedScenarioRuns]);

  const loadArchiveRunDetail = async (
    hostId: string,
    runId: string,
    expectedUpdatedAt: number,
  ) => {
    const viewerKey = `${hostId}:${runId}`;
    if (
      archiveDetailsByRun[viewerKey]?.updatedAt === expectedUpdatedAt ||
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
    setArtifactViewerByRun((current) => {
      const next = { ...current };
      delete next[viewerKey];
      return next;
    });

    try {
      const detail = await loadArchivedRunDetail(runId);
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
    const contentUrl = adminScenarioRunArtifactContentPath(runId, artifact.id);
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
      setVmError({
        title: "Could not end run",
        message:
          error instanceof Error
            ? error.message
            : "Your work is still open. Try ending the run again.",
      });
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
        `/api/admin/runs/${encodeURIComponent(runId)}`,
        {
          method: "DELETE",
          credentials: "include",
        },
      );
      const alreadyDeleted = isMissingArchivedRunStatus(response.status);
      if (!response.ok && !alreadyDeleted) {
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
      forgetArchivedRun(runId);
      setVmNotice(
        alreadyDeleted
          ? `Archived run ${runId} was already deleted`
          : `Deleted archived run ${runId}`,
      );
      setDeleteTarget(null);
      setDeleteConfirm("");
    } catch (error) {
      setVmError({
        title: "Could not delete run",
        message:
          error instanceof Error
            ? error.message
            : "The run was not deleted. Try again.",
      });
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
  const archivedRunCount = archiveTotalCount ?? archivedScenarioRuns.length;
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
  const filteredArchivedScenarioRuns = useMemo(
    () =>
      filterArchivedScenarioRuns(
        archivedScenarioRuns,
        archiveSearch,
        archiveOutcomes,
      ),
    [archiveOutcomes, archiveSearch, archivedScenarioRuns],
  );
  const archiveFiltersActive = Boolean(
    archiveSearch.trim() || archiveOutcomes.length,
  );
  const clearArchiveFilters = () => {
    setArchiveSearch("");
    setArchiveOutcomes([]);
  };
  // A ledger value is only claimed once its source has answered.
  const fleetState: LedgerState = hosts.isPending
    ? "pending"
    : hosts.error && !hostRecords.length
      ? "unavailable"
      : "ready";
  const scenarioState: LedgerState = scenarios.isPending
    ? "pending"
    : scenarios.error && !scenarios.data
      ? "unavailable"
      : "ready";
  const archiveState: LedgerState = isArchivePending
    ? "pending"
    : archiveError && !archivedScenarioRuns.length
      ? "unavailable"
      : "ready";
  const unknownDetail = (state: LedgerState) =>
    state === "pending" ? "Waiting for host reports" : "Host reports unavailable";
  const endPending =
    endTarget !== null &&
    vmBusyKey === `${endTarget.hostId}:destroy-run:${endTarget.runId}`;
  const deletePending =
    deleteTarget !== null &&
    vmBusyKey === `${deleteTarget.hostId}:delete-run:${deleteTarget.runId}`;
  const closeEndDialog = () => {
    setEndTarget(null);
    setVmError(null);
  };
  const closeDeleteDialog = () => {
    setDeleteTarget(null);
    setDeleteConfirm("");
    setVmError(null);
  };
  const deleteMatches = deleteTarget?.runId === deleteConfirm;
  const confirmDelete = () => {
    if (deleteTarget && deleteMatches && !deletePending) {
      void handleDeleteRun(deleteTarget.hostId, deleteTarget.runId);
    }
  };
  return (
    <PageShell variant="workspace" density="compact">
      <Section
        title="Operational ledger"
        description="Current fleet posture from the latest host reports."
        variant="flat"
        density="compact"
        className="rounded-none border-0 bg-transparent py-2"
        bodyClassName="divide-y px-0"
      >
        <LedgerRow
          icon={<CircleAlert />}
          label="Needs attention"
          state={fleetState}
          value={<RollingNumber value={attentionHostCount} />}
          detail={
            fleetState !== "ready"
              ? unknownDetail(fleetState)
              : attentionHostCount
                ? "Offline, degraded, or disabled hosts"
                : "No host exceptions"
          }
          tone={attentionHostCount ? "warning" : "success"}
          action={
            <Button
              size="sm"
              variant="link"
              render={<Link to="/admin/hosts" />}
            >
              Review hosts
            </Button>
          }
        />
        <LedgerRow
          icon={<Server />}
          label="Fleet connectivity"
          state={fleetState}
          value={
            <>
              <RollingNumber value={connectedHostCount} />/
              <RollingNumber value={hostRecords.length} />
            </>
          }
          detail={
            fleetState !== "ready"
              ? unknownDetail(fleetState)
              : "Hosts connected"
          }
        />
        <LedgerRow
          icon={<Activity />}
          label="Live work"
          state={fleetState}
          value={<RollingNumber value={activeVmCount} />}
          detail={
            fleetState !== "ready"
              ? unknownDetail(fleetState)
              : "Active scenario VMs"
          }
          action={
            <Button size="sm" variant="link" render={<a href="#live-runs" />}>
              Inspect live work
            </Button>
          }
        />
        <LedgerRow
          icon={<Archive />}
          label="Run archive"
          state={archiveState}
          value={
            <>
              <RollingNumber value={archivedRunCount} />
              {archiveTotalCount === null && hasMoreArchives ? "+" : ""}
            </>
          }
          detail={
            archiveState === "pending"
              ? "Waiting for the archive"
              : archiveState === "unavailable"
                ? "Archive unavailable"
                : "Retained sessions"
          }
        />
        <LedgerRow
          icon={<Shapes />}
          label="Scenario availability"
          state={scenarioState}
          value={
            <>
              <RollingNumber value={enabledScenarioCount} />/
              <RollingNumber value={launchableScenarios.length} />
            </>
          }
          detail={
            scenarioState === "pending"
              ? "Waiting for scenarios"
              : scenarioState === "unavailable"
                ? "Scenarios unavailable"
                : "Enabled for learners"
          }
          tone={enabledScenarioCount ? "default" : "warning"}
          action={
            <Button
              size="sm"
              variant="link"
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
                : "Refresh the page to try again."}
            </AlertDescription>
          </Alert>
        ) : null}
        {hosts.error ? (
          <Alert variant="destructive">
            <AlertTitle>Could not load hosts</AlertTitle>
            <AlertDescription>
              {hosts.error instanceof Error
                ? hosts.error.message
                : "Refresh the page to try again."}
            </AlertDescription>
          </Alert>
        ) : null}
        {archiveError ? (
          <Alert variant="destructive">
            <AlertTitle>Could not load run archive</AlertTitle>
            <AlertDescription>{archiveError.message}</AlertDescription>
          </Alert>
        ) : null}
        {/* While a dialog is open the failure shows inside it, where it is announced. */}
        {vmError && endTarget === null && deleteTarget === null ? (
          <Alert variant="destructive">
            <AlertTitle>{vmError.title}</AlertTitle>
            <AlertDescription>{vmError.message}</AlertDescription>
          </Alert>
        ) : null}
        {vmNotice ? (
          <InlineFeedback tone="success">{vmNotice}</InlineFeedback>
        ) : null}
      </div>

      <div id="live-runs" className="scroll-mt-24">
        <Section
          density="compact"
          title="Live scenario runs"
          description="Everything currently running across the fleet."
          actions={
            fleetState === "ready" ? (
              <span className="text-metadata tabular-nums">
                {hasMoreLive
                  ? `Newest ${liveLoadedCount} of ${liveTotalCount} runs`
                  : `${liveTotalCount} active`}
              </span>
            ) : null
          }
        >
          {hosts.isPending ? (
            <CardGridSkeleton
              cards={2}
              className="sm:grid-cols-1"
              cardClassName="h-52"
            />
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
                          setVmError(null);
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
            <EmptyState
              headingLevel={3}
              icon={<Activity />}
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
          <>
            {archiveState === "pending" ? null : (
              <span className="text-metadata tabular-nums">
                {archiveTotalCount === null
                  ? `${archivedScenarioRuns.length}+ loaded`
                  : `${archivedRunCount} retained`}
                {hasMoreArchives && archiveTotalCount !== null
                  ? ` · ${archivedScenarioRuns.length} loaded`
                  : ""}
              </span>
            )}
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={isArchivePending || isLoadingMoreArchives}
              onClick={() => {
                void refreshArchive().catch(() => {
                  // The archive section renders the request error.
                });
              }}
            >
              <RefreshCw />
              Refresh
            </Button>
          </>
        }
        bodyClassName="space-y-4"
      >
        {isArchivePending ? (
          <TableSkeleton rows={2} />
        ) : archiveError && !archivedScenarioRuns.length ? (
          <EmptyState
            headingLevel={3}
            icon={<Archive />}
            title="Run archive unavailable"
            description="Refresh the page to try loading the archive again."
          />
        ) : archivedScenarioRuns.length ? (
          <>
            <FilterBar
              search={archiveSearch}
              onSearchChange={setArchiveSearch}
              searchRef={archiveSearchRef}
              searchPlaceholder="Search runs, users, or hosts…"
              searchLabel="Search archived runs"
              stackSearchOnMobile
              filtersActive={archiveFiltersActive}
              onClear={clearArchiveFilters}
            >
              <div
                className="flex flex-wrap items-center gap-2"
                role="group"
                aria-label="Filter archived runs by outcome"
              >
                {ARCHIVE_OUTCOME_FILTERS.map(([value, label]) => (
                  <FilterChip
                    key={value}
                    active={archiveOutcomes.includes(value)}
                    onClick={() =>
                      setArchiveOutcomes((current) =>
                        current.includes(value)
                          ? current.filter((outcome) => outcome !== value)
                          : [...current, value],
                      )
                    }
                  >
                    {label}
                  </FilterChip>
                ))}
              </div>
            </FilterBar>

            {archiveFiltersActive ? (
              <p className="text-caption" aria-live="polite">
                Showing {filteredArchivedScenarioRuns.length} of{" "}
                {archivedScenarioRuns.length} loaded runs
                {hasMoreArchives ? ". Load older runs to search more." : "."}
              </p>
            ) : null}

            {filteredArchivedScenarioRuns.length ? (
              <PaginatedCollection
                items={filteredArchivedScenarioRuns}
                pageSize={DASHBOARD_ARCHIVE_PAGE_SIZE}
                itemLabel="archived runs"
                resetKey={`${archiveSearch.trim().toLowerCase()}|${archiveOutcomes.join(",")}`}
              >
                {(visibleRuns) => (
                  <div className="divide-y">
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
                          detailError={
                            archiveDetailErrorsByRun[viewerKey] ?? null
                          }
                          viewer={artifactViewerByRun[viewerKey] ?? null}
                          isExpanded={Boolean(expandedRuns[viewerKey])}
                          onToggle={() => {
                            const isExpanded = Boolean(expandedRuns[viewerKey]);
                            setExpandedRuns((current) => ({
                              ...current,
                              [viewerKey]: !isExpanded,
                            }));
                            if (!isExpanded) {
                              void loadArchiveRunDetail(
                                host.id,
                                run.id,
                                run.updatedAt,
                              );
                            }
                          }}
                          onDelete={() => {
                            setDeleteConfirm("");
                            setVmError(null);
                            setDeleteTarget({
                              hostId: host.id,
                              runId: run.id,
                            });
                          }}
                          onStreamArtifact={(artifact) => {
                            void streamArtifactContent(
                              host.id,
                              run.id,
                              artifact,
                            );
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
              <EmptyState
                headingLevel={3}
                icon={<Search />}
                title="No runs match these filters"
                description="Clear the filters or try a different search term."
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      clearArchiveFilters();
                      archiveSearchRef.current?.focus();
                    }}
                  >
                    Clear filters
                  </Button>
                }
              />
            )}
          </>
        ) : (
          <EmptyState
            headingLevel={3}
            icon={<Archive />}
            title="No archived scenario runs yet"
            description="Finished runs land here once their recordings upload."
          />
        )}
        {hasMoreArchives ? (
          <div className="flex flex-col items-center gap-2 border-t pt-4">
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
              <p className="text-support text-destructive" role="alert">
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

      <ConfirmDialog
        open={endTarget !== null}
        onClose={closeEndDialog}
        title="End this run?"
        description={`This stops active work on ${endTarget?.vmName ?? "this run"}. Captured history remains available after archival.`}
        error={endTarget ? (vmError?.message ?? null) : null}
        pending={endPending}
        confirmLabel="End run"
        pendingLabel="Ending…"
        cancelLabel="Keep running"
        onConfirm={() => {
          if (endTarget) {
            void handleDestroyRun(
              endTarget.hostId,
              endTarget.runId,
              endTarget.vmName,
            );
          }
        }}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={closeDeleteDialog}
        title="Delete this run?"
        description="This permanently removes the archived history and captured artifacts. Type the run ID to confirm."
        error={deleteTarget ? (vmError?.message ?? null) : null}
        pending={deletePending}
        confirmLabel="Delete run"
        pendingLabel="Deleting…"
        cancelLabel="Keep history"
        confirmDisabled={!deleteMatches}
        onConfirm={confirmDelete}
      >
        <div className="space-y-2">
          <label htmlFor="delete-run-confirm" className="block text-code">
            {deleteTarget?.runId}
          </label>
          <Input
            id="delete-run-confirm"
            className="font-mono"
            value={deleteConfirm}
            onChange={(event) => setDeleteConfirm(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                confirmDelete();
              }
            }}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
      </ConfirmDialog>
    </PageShell>
  );
}

export function filterArchivedScenarioRuns(
  runs: readonly ArchivedScenarioRunRecord[],
  search: string,
  outcomes: readonly ArchiveOutcome[],
): ArchivedScenarioRunRecord[] {
  const needle = search.trim().toLowerCase();
  return runs.filter(({ host, run }) => {
    if (outcomes.length && !outcomes.includes(run.outcome)) return false;
    if (!needle) return true;
    return [
      run.id,
      run.vmName,
      run.userId,
      run.ownerName,
      run.ownerUsername ?? "",
      host.name,
      host.id,
      run.scenarioMeta?.scenarioName ?? "",
      run.scenarioMeta?.scenarioVmName ?? "",
      run.scenarioMeta?.hostname ?? "",
    ].some((value) => value.toLowerCase().includes(needle));
  });
}

export function isMissingArchivedRunStatus(status: number) {
  return status === 404 || status === 410;
}

function omitRecordKeys<T>(
  current: Record<string, T>,
  keys: ReadonlySet<string>,
): Record<string, T> {
  const next = { ...current };
  for (const key of keys) delete next[key];
  return next;
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

type LedgerState = "ready" | "pending" | "unavailable";

function LedgerRow({
  icon,
  label,
  value,
  detail,
  state = "ready",
  tone = "default",
  action,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  detail: string;
  /** A value is shown only once its source has answered. */
  state?: LedgerState;
  tone?: "default" | "success" | "warning";
  action?: React.ReactNode;
}) {
  const shownTone = state === "ready" ? tone : "default";
  return (
    <div
      aria-busy={state === "pending" ? true : undefined}
      className="grid grid-cols-[1.4rem_minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-3 sm:grid-cols-[1.4rem_minmax(12rem,1fr)_auto_minmax(7.5rem,auto)] sm:gap-x-4"
    >
      <span
        className={cn(
          shownTone === "warning"
            ? "text-warning"
            : shownTone === "success"
              ? "text-success"
              : "text-muted-foreground",
        )}
      >
        {icon}
      </span>
      <div className="min-w-0 space-y-0.5">
        <p className="text-support font-medium">{label}</p>
        <p className="text-metadata">{detail}</p>
      </div>
      {/* On mobile the value shares the label line and the action the detail
          line, so rows with and without an action are the same height. */}
      <div className="flex min-w-20 flex-col items-end gap-0.5 self-center text-right sm:contents">
        <div className="text-support font-semibold tabular-nums sm:col-start-3 sm:justify-self-end">
          {state === "pending" ? (
            <Skeleton className="h-4 w-10" />
          ) : state === "unavailable" ? (
            "—"
          ) : (
            value
          )}
        </div>
        {action ? (
          <div className="sm:col-start-4 sm:justify-self-end">{action}</div>
        ) : null}
      </div>
    </div>
  );
}
