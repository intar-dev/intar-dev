import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  EllipsisVertical,
  Plus,
  RefreshCw,
  Rocket,
  Server,
  Trash2,
} from "lucide-react";
import { PageShell } from "@/components/app/patterns/PageShell";
import { Stat } from "@/components/app/patterns/Stat";
import { EmptyState, LoadingState } from "@/components/app/patterns/StateCard";
import { HostOnboardingPanel } from "@/components/app/HostOnboardingPanel";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatLoad, formatTimestamp } from "@/components/app/admin/hosts/format";
import { HostScenarioLaunchPanel } from "@/components/app/admin/hosts/HostScenarioLaunchPanel";
import { useAdminScenarios } from "@/components/app/admin/hosts/useAdminScenarios";
import { useHostFleet } from "@/components/app/admin/hosts/useHostFleet";
import type {
  AgentHostApi,
  LaunchScenarioRunResponse,
} from "@/components/app/admin/hosts/types";

// The host fleet: one calm card per host, with launch and onboarding behind
// explicit actions instead of ambient panels.
export function AdminHosts() {
  const [vmError, setVmError] = useState<string | null>(null);
  const [vmNotice, setVmNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [selectedScenarioByHost, setSelectedScenarioByHost] = useState<
    Record<string, string>
  >({});
  const [launchHostId, setLaunchHostId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentHostApi | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);

  const { hosts, hostRecords, refreshHost, forgetHost } = useHostFleet();
  const scenarios = useAdminScenarios();
  const launchableScenarios = scenarios.data?.scenarios ?? [];
  const defaultScenarioId =
    launchableScenarios.find((scenario) => scenario.enabled)?.scenarioId ??
    launchableScenarios[0]?.scenarioId ??
    "";

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
      setLaunchHostId((current) =>
        current === result.hostId ? null : current,
      );
      forgetHost(result.hostId);
      setDeleteTarget(null);
      void hosts.refetch();
    },
  });

  const handleLaunchScenario = async (hostId: string, scenarioId: string) => {
    const key = `${hostId}:launch`;
    setBusyKey(key);
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
      setLaunchHostId(null);
      await Promise.all([hosts.refetch(), refreshHost(hostId)]);
    } catch (error) {
      setVmError(
        error instanceof Error ? error.message : "failed to launch scenario",
      );
    } finally {
      setBusyKey((current) => (current === key ? null : current));
    }
  };

  const handleRefreshHost = (hostId: string) => {
    const key = `${hostId}:refresh`;
    setBusyKey(key);
    setVmError(null);
    void refreshHost(hostId)
      .catch((error) => {
        setVmError(
          error instanceof Error
            ? error.message
            : "failed to refresh host state",
        );
      })
      .finally(() => {
        setBusyKey((current) => (current === key ? null : current));
      });
  };

  const launchRecord = launchHostId
    ? (hostRecords.find(({ host }) => host.id === launchHostId) ?? null)
    : null;

  // Close the launch dialog if its host disappears (deleted elsewhere, poll).
  useEffect(() => {
    if (launchHostId && !launchRecord) {
      setLaunchHostId(null);
    }
  }, [launchHostId, launchRecord]);

  return (
    <PageShell
      admin
      title="Hosts"
      description="Agent and builder hosts running scenario workloads."
      actions={
        <Button onClick={() => setShowOnboarding((current) => !current)}>
          <Plus className="size-4" />
          Add host
        </Button>
      }
    >
      <div className="space-y-3 empty:hidden">
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
            <AlertTitle>Host action failed</AlertTitle>
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

      {showOnboarding ? (
        <HostOnboardingPanel eyebrow="New host" title="Bridge config" />
      ) : null}

      {hosts.isLoading ? (
        <LoadingState title="Loading hosts" />
      ) : hostRecords.length ? (
        <div className="grid gap-5 xl:grid-cols-2">
          {hostRecords.map(({ host, hostVms, hostRuns, capacity }) => {
            const isDeletingThisHost =
              deleteHost.isPending && deleteHost.variables === host.id;
            const isRefreshing = busyKey === `${host.id}:refresh`;
            const memorySummary = capacity
              ? `${capacity.memory_available_mib} / ${capacity.memory_total_mib} MiB`
              : "—";
            const diskSummary = capacity
              ? `${capacity.disk_available_mib} / ${capacity.disk_total_mib} MiB`
              : "—";

            return (
              <article
                key={host.id}
                className="space-y-5 rounded-2xl border bg-card p-6 shadow-xs"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={
                          host.status?.connected
                            ? "size-2 rounded-full bg-success"
                            : "size-2 rounded-full bg-muted-foreground/40"
                        }
                        aria-hidden="true"
                      />
                      <h2 className="truncate font-heading text-lg font-semibold tracking-tight">
                        {host.name}
                      </h2>
                      <Badge
                        variant={host.status?.connected ? "success" : "outline"}
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
                    <p className="text-caption">
                      {host.role === "builder" ? "Builder" : "Agent"} ·{" "}
                      <span className="font-mono">{host.id}</span> ·{" "}
                      {hostVms.length} live · {hostRuns.length} archived
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      size="sm"
                      onClick={() => setLaunchHostId(host.id)}
                      disabled={!launchableScenarios.length}
                    >
                      <Rocket className="size-3.5" />
                      Launch scenario
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label="Host actions"
                          />
                        }
                      >
                        <EllipsisVertical className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          disabled={isRefreshing}
                          onClick={() => handleRefreshHost(host.id)}
                        >
                          <RefreshCw className="size-4" />
                          {isRefreshing ? "Refreshing…" : "Refresh"}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          disabled={isDeletingThisHost}
                          onClick={() => setDeleteTarget(host)}
                        >
                          <Trash2 className="size-4" />
                          Delete host
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
                  <Stat
                    size="sm"
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
                  <Stat
                    size="sm"
                    label="CPU"
                    value={
                      capacity?.cpu_count
                        ? `${capacity.cpu_count} cores`
                        : "Unknown"
                    }
                    detail={`${formatLoad(capacity?.load_avg_1m)} / ${formatLoad(
                      capacity?.load_avg_5m,
                    )} / ${formatLoad(capacity?.load_avg_15m)}`}
                  />
                  <Stat
                    size="sm"
                    label="Memory"
                    value={memorySummary}
                    detail="Available / total"
                  />
                  <Stat
                    size="sm"
                    label={`Disk ${capacity?.disk_probe_path ?? "/"}`}
                    value={diskSummary}
                    detail="Available / total"
                  />
                </div>

                <p className="text-caption">
                  Network: {capacity?.primary_ipv4 ?? "—"}
                  {capacity?.primary_ipv6 ? ` · ${capacity.primary_ipv6}` : ""}
                </p>
              </article>
            );
          })}
        </div>
      ) : (
        <EmptyState
          icon={<Server />}
          title="No hosts yet"
          description="Generate a bridge config to register your first agent or builder host."
          action={
            <Button onClick={() => setShowOnboarding(true)}>
              <Plus className="size-4" />
              Add host
            </Button>
          }
        />
      )}

      <Dialog
        open={launchHostId !== null}
        onOpenChange={(open) => {
          if (!open) setLaunchHostId(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          {launchRecord ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  Launch scenario on {launchRecord.host.name}
                </DialogTitle>
                <DialogDescription>
                  Queues a scenario run directly on this host.
                </DialogDescription>
              </DialogHeader>
              {vmError ? (
                <p className="text-sm text-destructive">{vmError}</p>
              ) : null}
              <HostScenarioLaunchPanel
                host={launchRecord.host}
                selectedScenarioId={
                  selectedScenarioByHost[launchRecord.host.id] ??
                  defaultScenarioId
                }
                selectedScenario={
                  launchableScenarios.find(
                    (scenario) =>
                      scenario.scenarioId ===
                      (selectedScenarioByHost[launchRecord.host.id] ??
                        defaultScenarioId),
                  ) ?? null
                }
                scenarios={launchableScenarios}
                onScenarioChange={(scenarioId) => {
                  setSelectedScenarioByHost((current) => ({
                    ...current,
                    [launchRecord.host.id]: scenarioId,
                  }));
                }}
                onLaunch={() => {
                  const scenarioId =
                    selectedScenarioByHost[launchRecord.host.id] ??
                    defaultScenarioId;
                  if (!scenarioId) return;
                  void handleLaunchScenario(launchRecord.host.id, scenarioId);
                }}
                isLaunching={busyKey === `${launchRecord.host.id}:launch`}
              />
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this host?</DialogTitle>
            <DialogDescription>
              {deleteTarget
                ? `Deleting "${deleteTarget.name}" (${deleteTarget.id}) removes host access and bootstrap tokens. This cannot be undone.`
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={deleteHost.isPending}
            >
              Keep host
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteTarget) {
                  deleteHost.mutate(deleteTarget.id);
                }
              }}
              disabled={deleteHost.isPending || !deleteTarget}
            >
              <Trash2 className="size-4" />
              {deleteHost.isPending ? "Deleting…" : "Delete host"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
