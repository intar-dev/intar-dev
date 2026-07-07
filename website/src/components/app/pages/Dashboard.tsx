import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { PageShell } from "@/components/app/patterns/PageShell";
import { HostOnboardingPanel } from "@/components/app/HostOnboardingPanel";
import { type RunArtifactViewerState } from "@/components/app/RunArtifactViewer";
import { WebSshTerminal } from "@/components/remote-access/WebSshTerminal";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  SCENARIO_RUNS_PAGE_SIZE,
  buildVisiblePages,
  formatLoad,
  formatTimestamp,
  parseTimestamp,
} from "@/components/app/admin/hosts/format";
import { HostScenarioLaunchPanel } from "@/components/app/admin/hosts/HostScenarioLaunchPanel";
import { LiveScenarioRunCard } from "@/components/app/admin/hosts/LiveScenarioRunCard";
import { ScenarioRunArchiveCard } from "@/components/app/admin/hosts/ScenarioRunArchiveCard";
import {
  HostMetric,
  WorkspaceStat,
} from "@/components/app/admin/hosts/stats";
import type {
  AdminScenarioListResponse,
  AgentHostApi,
  AgentVmRunArtifact,
  AgentVmRunRecord,
  ArchivedScenarioRunRecord,
  HostRecord,
  HostRunsResponse,
  LaunchScenarioRunResponse,
  LiveScenarioRunRecord,
  VmStatus,
} from "@/components/app/admin/hosts/types";

export function Dashboard() {
  const [vmError, setVmError] = useState<string | null>(null);
  const [vmNotice, setVmNotice] = useState<string | null>(null);
  const [vmBusyKey, setVmBusyKey] = useState<string | null>(null);
  const [selectedScenarioByHost, setSelectedScenarioByHost] = useState<
    Record<string, string>
  >({});
  const [vmListByHost, setVmListByHost] = useState<Record<string, VmStatus[]>>(
    {},
  );
  const [runListByHost, setRunListByHost] = useState<
    Record<string, AgentVmRunRecord[]>
  >({});
  const [expandedActiveVms, setExpandedActiveVms] = useState<
    Record<string, boolean>
  >({});
  const [expandedRuns, setExpandedRuns] = useState<Record<string, boolean>>({});
  const [artifactViewerByRun, setArtifactViewerByRun] = useState<
    Record<string, RunArtifactViewerState>
  >({});
  const [hostViewById, setHostViewById] = useState<
    Record<string, AgentHostApi>
  >({});
  const artifactStreamRef = useRef<Record<string, AbortController>>({});
  const [runsPage, setRunsPage] = useState(1);
  const [activeWebSsh, setActiveWebSsh] = useState<{
    hostId: string;
    runId: string;
    vmId: string;
    vmName: string;
  } | null>(null);

  const hosts = useQuery({
    queryKey: ["agent-hosts"],
    queryFn: async () => {
      const response = await fetch("/api/agent/hosts", {
        method: "GET",
        credentials: "include",
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          body?.error ?? `Failed to load hosts (${response.status})`,
        );
      }

      const body = (await response.json()) as { hosts: AgentHostApi[] };
      return body.hosts;
    },
    staleTime: 0,
    retry: 1,
    refetchInterval: 1_500,
  });

  const scenarios = useQuery({
    queryKey: ["admin-scenarios", "launcher"],
    queryFn: async () => {
      const response = await fetch("/api/admin/scenarios", {
        method: "GET",
        credentials: "include",
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          body?.error ?? `Failed to load scenarios (${response.status})`,
        );
      }

      return (await response.json()) as AdminScenarioListResponse;
    },
    staleTime: 10_000,
  });

  const launchableScenarios = scenarios.data?.scenarios ?? [];
  const defaultScenarioId =
    launchableScenarios.find((scenario) => scenario.enabled)?.scenarioId ??
    launchableScenarios[0]?.scenarioId ??
    "";

  const deleteHost = useMutation({
    mutationFn: async (hostId: string) => {
      const response = await fetch(
        `/api/agent/hosts/${encodeURIComponent(hostId)}`,
        {
          method: "DELETE",
          credentials: "include",
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `Delete failed (${response.status})`);
      }
      return (await response.json()) as { ok: boolean; hostId: string };
    },
    onSuccess: (result) => {
      setSelectedScenarioByHost((current) => {
        const next = { ...current };
        delete next[result.hostId];
        return next;
      });
      setHostViewById((current) => {
        const next = { ...current };
        delete next[result.hostId];
        return next;
      });
      setVmListByHost((current) => {
        const next = { ...current };
        delete next[result.hostId];
        return next;
      });
      setRunListByHost((current) => {
        const next = { ...current };
        delete next[result.hostId];
        return next;
      });
      setExpandedActiveVms((current) =>
        Object.fromEntries(
          Object.entries(current).filter(
            ([key]) => !key.startsWith(`${result.hostId}:`),
          ),
        ),
      );
      setExpandedRuns((current) =>
        Object.fromEntries(
          Object.entries(current).filter(
            ([key]) => !key.startsWith(`${result.hostId}:`),
          ),
        ),
      );
      setArtifactViewerByRun((current) =>
        Object.fromEntries(
          Object.entries(current).filter(
            ([key]) => !key.startsWith(`${result.hostId}:`),
          ),
        ),
      );
      setActiveWebSsh((current) =>
        current && current.hostId === result.hostId ? null : current,
      );
      void hosts.refetch();
    },
  });

  useEffect(() => {
    if (!hosts.data?.length || !defaultScenarioId) {
      return;
    }

    setSelectedScenarioByHost((current) => {
      const next = { ...current };
      let changed = false;

      for (const host of hosts.data) {
        const selected = next[host.id];
        if (
          !selected ||
          !launchableScenarios.some(
            (scenario) => scenario.scenarioId === selected,
          )
        ) {
          next[host.id] = defaultScenarioId;
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [defaultScenarioId, hosts.data, launchableScenarios]);

  useEffect(() => {
    if (!hosts.data?.length) {
      return;
    }

    setHostViewById((current) => {
      const next = { ...current };
      for (const host of hosts.data) {
        next[host.id] = host;
      }
      return next;
    });
  }, [hosts.data]);

  useEffect(() => {
    if (!hosts.data?.length) return;

    let cancelled = false;

    const pollOnce = async () => {
      for (const baseHost of hosts.data ?? []) {
        try {
          const state = await loadHostState(baseHost.id);
          if (cancelled) return;
          setHostViewById((current) => ({
            ...current,
            [baseHost.id]: state.host,
          }));
          setVmListByHost((current) => ({
            ...current,
            [baseHost.id]: state.liveVms,
          }));
          setRunListByHost((current) => ({
            ...current,
            [baseHost.id]: state.archivedRuns,
          }));
        } catch {
          continue;
        }
      }
    };

    void pollOnce();
    const intervalMs =
      typeof document !== "undefined" && document.visibilityState === "hidden"
        ? 15_000
        : 3_000;
    const timer = setInterval(() => {
      void pollOnce();
    }, intervalMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [hosts.data]);

  useEffect(() => {
    return () => {
      for (const controller of Object.values(artifactStreamRef.current)) {
        controller.abort();
      }
    };
  }, []);

  async function loadHostState(hostId: string) {
    const [hostResponse, runResponse] = await Promise.all([
      fetch(`/api/agent/hosts/${encodeURIComponent(hostId)}`, {
        method: "GET",
        credentials: "include",
      }),
      fetch(`/api/agent/hosts/${encodeURIComponent(hostId)}/runs`, {
        method: "GET",
        credentials: "include",
      }),
    ]);

    if (!hostResponse.ok) {
      const body = (await hostResponse.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new Error(
        body?.error ?? `Failed to load host (${hostResponse.status})`,
      );
    }
    if (!runResponse.ok) {
      const body = (await runResponse.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new Error(
        body?.error ?? `Failed to load host runs (${runResponse.status})`,
      );
    }

    const hostBody = (await hostResponse.json()) as { host: AgentHostApi };
    const runBody = (await runResponse.json()) as HostRunsResponse;
    return {
      host: hostBody.host,
      liveVms: runBody.liveVms ?? [],
      archivedRuns: runBody.archivedRuns ?? [],
    };
  }

  const refreshVmList = async (hostId: string) => {
    setVmError(null);
    const state = await loadHostState(hostId);
    setHostViewById((current) => ({ ...current, [hostId]: state.host }));
    setVmListByHost((current) => ({ ...current, [hostId]: state.liveVms }));
    setRunListByHost((current) => ({
      ...current,
      [hostId]: state.archivedRuns,
    }));
  };

  const refreshRunList = async (hostId: string) => {
    const state = await loadHostState(hostId);
    setHostViewById((current) => ({ ...current, [hostId]: state.host }));
    setVmListByHost((current) => ({ ...current, [hostId]: state.liveVms }));
    setRunListByHost((current) => ({
      ...current,
      [hostId]: state.archivedRuns,
    }));
  };

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

  const handleLaunchScenario = async (hostId: string, scenarioId: string) => {
    const busyKey = `${hostId}:launch`;
    setVmBusyKey(busyKey);
    setVmError(null);
    setVmNotice(null);
    try {
      const response = await fetch(
        `/api/agent/hosts/${encodeURIComponent(hostId)}/runs`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ scenarioId }),
        },
      );

      const body = (await response.json().catch(() => null)) as
        | LaunchScenarioRunResponse
        | { error?: string }
        | null;
      if (!response.ok) {
        throw new Error(
          (body as { error?: string } | null)?.error ??
            `Failed to launch scenario (${response.status})`,
        );
      }

      const result = body as LaunchScenarioRunResponse;
      setVmNotice(
        result.reused
          ? `${result.scenarioId} is already active on ${hostId}.`
          : `${result.scenarioId} queued on ${hostId}.`,
      );
      await Promise.all([hosts.refetch(), refreshRunList(hostId)]);
    } catch (error) {
      setVmError(
        error instanceof Error ? error.message : "failed to launch scenario",
      );
    } finally {
      setVmBusyKey((current) => (current === busyKey ? null : current));
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
          body?.error ?? `Failed to request teardown (${response.status})`,
        );
      }
      setVmNotice(`Teardown requested for ${vmName}`);
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
      await Promise.all([hosts.refetch(), refreshRunList(hostId)]);
    } catch (error) {
      setVmError(
        error instanceof Error ? error.message : "failed to request teardown",
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
      setRunListByHost((current) => ({
        ...current,
        [hostId]: (current[hostId] ?? []).filter((run) => run.id !== runId),
      }));
      setVmNotice(`Deleted archived run ${runId}`);
      await Promise.all([hosts.refetch(), refreshRunList(hostId)]);
    } catch (error) {
      setVmError(
        error instanceof Error ? error.message : "failed to delete run",
      );
    } finally {
      setVmBusyKey((current) => (current === busyKey ? null : current));
    }
  };

  const hostRecords = useMemo<HostRecord[]>(
    () =>
      (hosts.data ?? []).map((baseHost) => {
        const host = hostViewById[baseHost.id] ?? baseHost;
        return {
          host,
          hostVms: vmListByHost[host.id] ?? [],
          hostRuns: runListByHost[host.id] ?? [],
          info: host.status?.hostInfo ?? host.hostInfo ?? null,
        };
      }),
    [hosts.data, hostViewById, runListByHost, vmListByHost],
  );
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
      ? Math.min(
          runsPage * SCENARIO_RUNS_PAGE_SIZE,
          archivedScenarioRuns.length,
        )
      : 0;
  const pageNumbers = useMemo(
    () => buildVisiblePages(runsPage, totalRunPages),
    [runsPage, totalRunPages],
  );
  const pagedArchivedScenarioRuns = useMemo(() => {
    const start = (runsPage - 1) * SCENARIO_RUNS_PAGE_SIZE;
    return archivedScenarioRuns.slice(
      start,
      start + SCENARIO_RUNS_PAGE_SIZE,
    );
  }, [archivedScenarioRuns, runsPage]);

  useEffect(() => {
    setRunsPage((current) => Math.min(Math.max(current, 1), totalRunPages));
  }, [totalRunPages]);

  return (
    <PageShell admin
      title="Overview"
      description="Scenario runs stay front and center while host operations remain close at hand."
    >
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <WorkspaceStat
          label="Hosts"
          value={String(hostRecords.length)}
          detail={`${connectedHostCount} online`}
        />
        <WorkspaceStat
          label="Live runs"
          value={String(activeVmCount)}
          detail="Active VMs"
        />
        <WorkspaceStat
          label="Run archive"
          value={String(archivedRunCount)}
          detail="Archived sessions"
        />
        <WorkspaceStat
          label="Scenarios"
          value={String(launchableScenarios.length)}
          detail={
            launchableScenarios.filter((scenario) => scenario.enabled).length >
            0
              ? `${
                  launchableScenarios.filter((scenario) => scenario.enabled)
                    .length
                } enabled`
              : "No launchable scenarios"
          }
        />
      </div>

      <div className="space-y-3">
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
        {deleteHost.error ? (
          <Alert variant="destructive">
            <AlertTitle>Host deletion failed</AlertTitle>
            <AlertDescription>
              {deleteHost.error instanceof Error
                ? deleteHost.error.message
                : "Delete failed"}
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

      <Tabs defaultValue="scenario-runs" className="gap-6">
        <TabsList
          variant="line"
          className="w-full justify-start gap-6 rounded-none border-b border-border/70 p-0"
        >
          <TabsTrigger
            value="scenario-runs"
            className="rounded-none px-1 py-3 data-[state=active]:bg-transparent data-[state=active]:shadow-none"
          >
            Scenario runs
          </TabsTrigger>
          <TabsTrigger
            value="hosts"
            className="rounded-none px-1 py-3 data-[state=active]:bg-transparent data-[state=active]:shadow-none"
          >
            Hosts
          </TabsTrigger>
        </TabsList>

        <TabsContent value="scenario-runs" className="space-y-6">
          <section className="rounded-3xl border border-border/70 bg-card/80 p-6 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.28em] text-muted-foreground">
                  Live now
                </p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight">
                  Active scenario runs
                </h2>
              </div>
              <Badge variant="outline">{liveScenarioRuns.length} active</Badge>
            </div>

            {hosts.isLoading ? (
              <div className="mt-6 rounded-3xl border border-dashed border-border/70 bg-muted/15 px-4 py-8 text-center text-sm text-muted-foreground">
                Loading active runs...
              </div>
            ) : liveScenarioRuns.length ? (
              <div className="mt-6 space-y-4">
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
                        void handleDestroyRun(host.id, vm.run_id, vm.name);
                      }}
                      isDeleting={
                        vmBusyKey === `${host.id}:destroy-run:${vm.run_id}`
                      }
                    />
                  );
                })}
              </div>
            ) : (
              <div className="mt-6 rounded-3xl border border-dashed border-border/70 bg-muted/15 px-4 py-8 text-center text-sm text-muted-foreground">
                No active scenario runs.
              </div>
            )}
          </section>

          <section className="rounded-3xl border border-border/70 bg-card/80 p-6 shadow-sm">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.28em] text-muted-foreground">
                  Archive
                </p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight">
                  Scenario run history
                </h2>
              </div>
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
                  onClick={() =>
                    setRunsPage((current) => Math.max(1, current - 1))
                  }
                  disabled={runsPage === 1 || !archivedScenarioRuns.length}
                >
                  Previous
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setRunsPage((current) =>
                      Math.min(totalRunPages, current + 1),
                    )
                  }
                  disabled={
                    runsPage === totalRunPages || !archivedScenarioRuns.length
                  }
                >
                  Next
                </Button>
              </div>
            </div>

            {hosts.isLoading ? (
              <div className="mt-6 rounded-3xl border border-dashed border-border/70 bg-muted/15 px-4 py-8 text-center text-sm text-muted-foreground">
                Loading archived runs...
              </div>
            ) : pagedArchivedScenarioRuns.length ? (
              <div className="mt-6 space-y-4">
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
                        void handleDeleteRun(host.id, run.id);
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
            ) : (
              <div className="mt-6 rounded-3xl border border-dashed border-border/70 bg-muted/15 px-4 py-8 text-center text-sm text-muted-foreground">
                No archived scenario runs yet.
              </div>
            )}

            {archivedScenarioRuns.length > SCENARIO_RUNS_PAGE_SIZE ? (
              <div className="mt-6 flex flex-col gap-3 border-t border-border/70 pt-4 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-muted-foreground">
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
          </section>
        </TabsContent>

        <TabsContent value="hosts" className="space-y-6">
          <HostOnboardingPanel
            eyebrow="New host"
            title="Bridge config"
            onGenerated={() => {
              void hosts.refetch();
            }}
          />

          {hosts.isLoading ? (
            <div className="rounded-3xl border border-border/70 bg-card/70 px-6 py-10 text-sm text-muted-foreground shadow-sm">
              Loading hosts...
            </div>
          ) : hostRecords.length ? (
            <div className="grid gap-5 xl:grid-cols-2">
              {hostRecords.map(({ host, hostVms, hostRuns, info }) => {
                const isDeletingThisHost =
                  deleteHost.isPending && deleteHost.variables === host.id;
                const isLaunchingScenario = vmBusyKey === `${host.id}:launch`;
                const isRefreshingVmList = vmBusyKey === `${host.id}:list`;
                const selectedScenarioId =
                  selectedScenarioByHost[host.id] ?? defaultScenarioId;
                const selectedScenario =
                  launchableScenarios.find(
                    (scenario) => scenario.scenarioId === selectedScenarioId,
                  ) ?? null;
                const memorySummary =
                  info?.memoryAvailableMib !== null &&
                  info?.memoryAvailableMib !== undefined &&
                  info?.memoryTotalMib !== null &&
                  info?.memoryTotalMib !== undefined
                    ? `${info.memoryAvailableMib} / ${info.memoryTotalMib} MiB`
                    : info?.memoryTotalMib !== null &&
                        info?.memoryTotalMib !== undefined
                      ? `— / ${info.memoryTotalMib} MiB`
                      : "—";
                const diskSummary =
                  info?.diskAvailableMib !== null &&
                  info?.diskAvailableMib !== undefined &&
                  info?.diskTotalMib !== null &&
                  info?.diskTotalMib !== undefined
                    ? `${info.diskAvailableMib} / ${info.diskTotalMib} MiB`
                    : info?.diskTotalMib !== null &&
                        info?.diskTotalMib !== undefined
                      ? `— / ${info.diskTotalMib} MiB`
                      : "—";

                return (
                  <article
                    key={host.id}
                    className="overflow-hidden rounded-3xl border border-border/70 bg-card/80 shadow-sm"
                  >
                    <div className="px-5 py-5 sm:px-6">
                      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                        <div className="space-y-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <h2 className="text-xl font-semibold tracking-tight">
                              {host.name}
                            </h2>
                            <Badge
                              variant={
                                host.status?.connected ? "secondary" : "outline"
                              }
                            >
                              {host.status?.connected ? "Online" : "Offline"}
                            </Badge>
                            {host.actualState?.health === "degraded" ? (
                              <Badge variant="destructive">Degraded</Badge>
                            ) : host.actualState?.health === "unknown" ? (
                              <Badge variant="outline">Unknown health</Badge>
                            ) : null}
                            {host.disabled ? (
                              <Badge variant="destructive">Disabled</Badge>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <Badge variant="outline">
                              {host.role === "builder" ? "Builder" : "Agent"}
                            </Badge>
                            <Badge variant="outline">{host.id}</Badge>
                            <Badge variant="outline">{hostVms.length} live</Badge>
                            <Badge variant="outline">
                              {hostRuns.length} archived
                            </Badge>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setVmBusyKey(`${host.id}:list`);
                              void refreshVmList(host.id)
                                .catch((error) => {
                                  setVmError(
                                    error instanceof Error
                                      ? error.message
                                      : "failed to refresh host state",
                                  );
                                })
                                .finally(() => {
                                  setVmBusyKey((current) =>
                                    current === `${host.id}:list`
                                      ? null
                                      : current,
                                  );
                                });
                            }}
                            disabled={isRefreshingVmList}
                          >
                            {isRefreshingVmList ? "Refreshing..." : "Refresh"}
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => {
                              if (
                                typeof window !== "undefined" &&
                                !window.confirm(
                                  `Delete agent "${host.name}" (${host.id})? This removes host access and bootstrap tokens.`,
                                )
                              ) {
                                return;
                              }
                              deleteHost.mutate(host.id);
                            }}
                            disabled={isDeletingThisHost}
                          >
                            {isDeletingThisHost ? "Deleting..." : "Delete"}
                          </Button>
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-6 border-t border-border/70 px-5 py-5 sm:px-6 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
                      <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
                        <HostMetric
                          label="Heartbeat"
                          value={formatTimestamp(host.status?.lastHeartbeatAt)}
                          detail={
                            host.actualState?.health === "degraded"
                              ? "No state report for over 60 seconds"
                              : host.status?.connected
                              ? "Connected via bridge"
                              : "No fresh bridge heartbeat"
                          }
                        />
                        <HostMetric
                          label="Network"
                          value={info?.primaryIpv4 ?? "—"}
                          detail={info?.primaryIpv6 ?? "No IPv6"}
                        />
                        <HostMetric
                          label="CPU"
                          value={
                            info?.cpuCores ? `${info.cpuCores} cores` : "Unknown"
                          }
                          detail={`${formatLoad(info?.loadAvg1m)} / ${formatLoad(
                            info?.loadAvg5m,
                          )} / ${formatLoad(info?.loadAvg15m)}`}
                        />
                        <HostMetric
                          label="Memory"
                          value={memorySummary}
                          detail="Available / total"
                        />
                        <HostMetric
                          label={`Disk ${info?.diskProbePath ?? "/"}`}
                          value={diskSummary}
                          detail="Available / total"
                        />
                        <HostMetric
                          label="Runs"
                          value={`${hostVms.length} live`}
                          detail={`${hostRuns.length} archived`}
                        />
                      </div>

                      <div className="xl:border-l xl:border-border/70 xl:pl-6">
                        <HostScenarioLaunchPanel
                          host={host}
                          selectedScenarioId={selectedScenarioId}
                          selectedScenario={selectedScenario}
                          scenarios={launchableScenarios}
                          onScenarioChange={(scenarioId) => {
                            setSelectedScenarioByHost((current) => ({
                              ...current,
                              [host.id]: scenarioId,
                            }));
                          }}
                          onLaunch={() => {
                            if (!selectedScenarioId) return;
                            void handleLaunchScenario(host.id, selectedScenarioId);
                          }}
                          isLaunching={isLaunchingScenario}
                        />
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="rounded-3xl border border-dashed border-border/70 bg-card/70 px-6 py-12 text-center text-sm text-muted-foreground">
              No hosts yet. Generate a bridge config to register one.
            </div>
          )}
        </TabsContent>
      </Tabs>

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
    </PageShell>
  );
}

