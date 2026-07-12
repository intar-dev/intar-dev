import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Activity, Archive, CircleAlert, Server, Shapes } from "lucide-react";
import { PageShell } from "@/components/app/patterns/PageShell";
import { Section } from "@/components/app/patterns/Section";
import { TableSkeleton } from "@/components/app/patterns/Skeletons";
import { EmptyState } from "@/components/app/patterns/StateCard";
import { type RunArtifactViewerState } from "@/components/app/RunArtifactViewer";
import { WebSshTerminal } from "@/components/remote-access/WebSshTerminal";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  SCENARIO_RUNS_PAGE_SIZE,
  buildVisiblePages,
  parseTimestamp,
} from "@/components/app/admin/hosts/format";
import { LiveScenarioRunCard } from "@/components/app/admin/hosts/LiveScenarioRunCard";
import { ScenarioRunArchiveCard } from "@/components/app/admin/hosts/ScenarioRunArchiveCard";
import { useAdminScenarios } from "@/components/app/admin/hosts/useAdminScenarios";
import { useHostFleet } from "@/components/app/admin/hosts/useHostFleet";
import type {
  AgentVmRunArtifact,
  ArchivedScenarioRunRecord,
  LiveScenarioRunRecord,
} from "@/components/app/admin/hosts/types";

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
  const [runsPage, setRunsPage] = useState(1);
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

  const { hosts, hostRecords, refreshHost, forgetArchivedRun } = useHostFleet();
  const scenarios = useAdminScenarios();
  const launchableScenarios = scenarios.data?.scenarios ?? [];

  useEffect(() => {
    return () => {
      for (const controller of Object.values(artifactStreamRef.current)) {
        controller.abort();
      }
    };
  }, []);

  const streamArtifactContent = async (
    hostId: string,
    runId: string,
    artifact: AgentVmRunArtifact,
  ) => {
    const viewerKey = `${hostId}:${runId}`;
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
      },
    }));

    try {
      const response = await fetch(
        `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifact.id)}/content`,
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
          },
        }));
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
          setArtifactViewerByRun((current) => ({
            ...current,
            [viewerKey]: {
              artifact,
              loading: true,
              error: null,
              content: accumulated,
              receivedBytes,
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
          receivedBytes: Math.max(receivedBytes, artifact.sizeBytes),
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
      await Promise.all([hosts.refetch(), refreshHost(hostId)]);
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
      forgetArchivedRun(hostId, runId);
      setVmNotice(`Deleted archived run ${runId}`);
      setDeleteTarget(null);
      setDeleteConfirm("");
      await Promise.all([hosts.refetch(), refreshHost(hostId)]);
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
  const archivedRunCount = hostRecords.reduce(
    (total, { hostRuns }) => total + hostRuns.length,
    0,
  );
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
  const totalRunPages = Math.max(
    1,
    Math.ceil(archivedScenarioRuns.length / SCENARIO_RUNS_PAGE_SIZE),
  );
  const archiveStart =
    archivedScenarioRuns.length > 0
      ? (runsPage - 1) * SCENARIO_RUNS_PAGE_SIZE + 1
      : 0;
  const archiveEnd =
    archivedScenarioRuns.length > 0
      ? Math.min(runsPage * SCENARIO_RUNS_PAGE_SIZE, archivedScenarioRuns.length)
      : 0;
  const pageNumbers = useMemo(
    () => buildVisiblePages(runsPage, totalRunPages),
    [runsPage, totalRunPages],
  );
  const pagedArchivedScenarioRuns = useMemo(() => {
    const start = (runsPage - 1) * SCENARIO_RUNS_PAGE_SIZE;
    return archivedScenarioRuns.slice(start, start + SCENARIO_RUNS_PAGE_SIZE);
  }, [archivedScenarioRuns, runsPage]);

  useEffect(() => {
    setRunsPage((current) => Math.min(Math.max(current, 1), totalRunPages));
  }, [totalRunPages]);

  return (
    <PageShell width="workspace" density="compact">
      <Section
        title="Operational ledger"
        description="Current fleet posture from the latest host reports."
        variant="flat"
        density="compact"
        bodyClassName="divide-y border-y"
      >
        <LedgerRow
          icon={<CircleAlert />}
          label="Needs attention"
          value={String(attentionHostCount)}
          detail={attentionHostCount ? "Offline, degraded, or disabled hosts" : "No host exceptions"}
          tone={attentionHostCount ? "warning" : "success"}
          action={<Button size="sm" variant="outline" render={<Link to="/admin/hosts" />}>Review hosts</Button>}
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
          action={<Button size="sm" variant="ghost" render={<a href="#live-runs" />}>Inspect live work</Button>}
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
          action={<Button size="sm" variant="ghost" render={<Link to="/admin/scenarios" />}>Open registry</Button>}
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
          actions={<Badge variant="outline">{liveScenarioRuns.length} active</Badge>}
        >
        {hosts.isPending ? (
          <TableSkeleton rows={2} />
        ) : liveScenarioRuns.length ? (
          <div className="space-y-4">
            {liveScenarioRuns.map(({ host, vm }) => {
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
        ) : (
          <EmptyState
            title="No active scenario runs"
            description="Runs launched by learners or from the Hosts page show up here in real time."
            className="border-0 bg-transparent shadow-none"
            contentClassName="min-h-[10rem]"
          />
        )}
        </Section>
      </div>

      <Section
        density="compact"
        title="Run archive"
        description="Finished runs with their captured artifacts."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">
              {archivedScenarioRuns.length
                ? `${archiveStart}-${archiveEnd} of ${archivedScenarioRuns.length}`
                : "0 runs"}
            </Badge>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setRunsPage((current) => Math.max(1, current - 1))}
              disabled={runsPage === 1 || !archivedScenarioRuns.length}
            >
              Previous
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                setRunsPage((current) => Math.min(totalRunPages, current + 1))
              }
              disabled={
                runsPage === totalRunPages || !archivedScenarioRuns.length
              }
            >
              Next
            </Button>
          </div>
        }
      >
        {hosts.isPending ? (
          <TableSkeleton rows={2} />
        ) : pagedArchivedScenarioRuns.length ? (
          <div className="space-y-4">
            {pagedArchivedScenarioRuns.map(({ host, run }) => {
              const viewerKey = `${host.id}:${run.id}`;
              return (
                <ScenarioRunArchiveCard
                  key={viewerKey}
                  host={host}
                  run={run}
                  viewer={artifactViewerByRun[viewerKey] ?? null}
                  isExpanded={Boolean(expandedRuns[viewerKey])}
                  onToggle={() => {
                    setExpandedRuns((current) => ({
                      ...current,
                      [viewerKey]: !current[viewerKey],
                    }));
                  }}
                  onDelete={() => {
                    setDeleteConfirm("");
                    setDeleteTarget({ hostId: host.id, runId: run.id });
                  }}
                  onStreamArtifact={(artifact) => {
                    void streamArtifactContent(host.id, run.id, artifact);
                  }}
                  isDeleting={vmBusyKey === `${host.id}:delete-run:${run.id}`}
                />
              );
            })}
          </div>
        ) : (
          <EmptyState
            title="No archived scenario runs yet"
            description="Finished runs land here once their recordings upload."
            className="border-0 bg-transparent shadow-none"
            contentClassName="min-h-[10rem]"
          />
        )}

        {archivedScenarioRuns.length > SCENARIO_RUNS_PAGE_SIZE ? (
          <div className="mt-6 flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-caption">
              Page {runsPage} of {totalRunPages}
            </p>
            <div className="flex flex-wrap gap-2">
              {pageNumbers.map((pageNumber) => (
                <Button
                  key={pageNumber}
                  type="button"
                  size="sm"
                  variant={pageNumber === runsPage ? "secondary" : "outline"}
                  onClick={() => setRunsPage(pageNumber)}
                >
                  {pageNumber}
                </Button>
              ))}
            </div>
          </div>
        ) : null}
      </Section>

      {activeWebSsh ? (
        <WebSshTerminal
          vmName={activeWebSsh.vmName}
          sessionRequest={{
            url: `/api/scenarios/runs/${encodeURIComponent(activeWebSsh.runId)}/ssh`,
            body: { vmId: activeWebSsh.vmId },
          }}
          onClose={() => setActiveWebSsh(null)}
        />
      ) : null}

      <Dialog open={endTarget !== null} onOpenChange={(open) => !open && setEndTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>End this run?</DialogTitle>
            <DialogDescription>
              This stops active work on {endTarget?.vmName}. Captured history remains available after archival.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEndTarget(null)} disabled={vmBusyKey !== null}>Keep running</Button>
            <Button
              variant="destructive"
              disabled={!endTarget || vmBusyKey !== null}
              onClick={() => {
                if (endTarget) {
                  void handleDestroyRun(endTarget.hostId, endTarget.runId, endTarget.vmName);
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
              This permanently removes the archived history and captured artifacts. Type the run ID to confirm.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label htmlFor="delete-run-confirm" className="font-mono text-sm">{deleteTarget?.runId}</label>
            <Input id="delete-run-confirm" value={deleteConfirm} onChange={(event) => setDeleteConfirm(event.target.value)} autoComplete="off" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={vmBusyKey !== null}>Keep history</Button>
            <Button
              variant="destructive"
              disabled={!deleteTarget || deleteConfirm !== deleteTarget.runId || vmBusyKey !== null}
              onClick={() => {
                if (deleteTarget) void handleDeleteRun(deleteTarget.hostId, deleteTarget.runId);
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
    <div className="grid gap-3 py-3 first:pt-0 last:pb-0 sm:grid-cols-[1.4rem_minmax(10rem,0.8fr)_minmax(0,1fr)_auto] sm:items-center">
      <span className={tone === "warning" ? "text-warning" : tone === "success" ? "text-success" : "text-muted-foreground"}>{icon}</span>
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-metadata">{detail}</p>
      </div>
      <p className="text-section-title tabular-nums sm:text-right">{value}</p>
      <div>{action}</div>
    </div>
  );
}
