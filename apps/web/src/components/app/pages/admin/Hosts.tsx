import { useMemo, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  EllipsisVertical,
  Plus,
  RefreshCw,
  Server,
  Trash2,
} from "lucide-react";
import { usePageChrome } from "@/components/app/shell/page-chrome";
import { PageShell } from "@/components/app/patterns/PageShell";
import {
  COLLECTION_PAGE_SIZE,
  PaginatedCollection,
} from "@/components/app/patterns/CollectionPagination";
import { InlineFeedback } from "@/components/app/patterns/InlineFeedback";
import { CardGridSkeleton } from "@/components/app/patterns/Skeletons";
import { EmptyState } from "@/components/app/patterns/StateCard";
import { HostOnboardingPanel } from "@/components/app/HostOnboardingPanel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import {
  formatLoad,
  formatTimestamp as formatHostTimestamp,
} from "@/components/app/admin/hosts/format";
import { formatRelativeTime } from "@/components/app/lib/format";
import { useHostFleet } from "@/components/app/admin/hosts/useHostFleet";
import type { AgentHostApi } from "@/components/app/admin/hosts/types";

// The host fleet: one calm card per host, with onboarding behind an explicit
// action instead of ambient panels. Scenario runs launch from the scenario
// pages; hosts are infrastructure only.
export function AdminHosts() {
  const [vmError, setVmError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<AgentHostApi | null>(null);
  const [removeConfirm, setRemoveConfirm] = useState("");
  const [removedHostIds, setRemovedHostIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [showOnboarding, setShowOnboarding] = useState(false);

  const { hosts, hostRecords, refreshHost, forgetHost } = useHostFleet();
  const activeHostRecords = hostRecords.filter(
    ({ host }) => !host.disabled && !removedHostIds.has(host.id),
  );

  const removeHost = useMutation({
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
        throw new Error(body?.error ?? `Remove failed (${response.status})`);
      }
      return (await response.json()) as { ok: boolean; hostId: string };
    },
    onSuccess: (result) => {
      setRemovedHostIds((current) => new Set(current).add(result.hostId));
      forgetHost(result.hostId);
      setRemoveTarget(null);
      setRemoveConfirm("");
      void hosts.refetch();
    },
  });

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

  usePageChrome({
    action: useMemo(
      () => (
        <Button
          size="sm"
          onClick={() => setShowOnboarding((current) => !current)}
        >
          <Plus className="size-3.5" />
          Add host
        </Button>
      ),
      [],
    ),
  });

  return (
    <PageShell width="workspace" density="compact">
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
        {removeHost.error ? (
          <Alert variant="destructive">
            <AlertTitle>Host removal failed</AlertTitle>
            <AlertDescription>
              {removeHost.error instanceof Error
                ? removeHost.error.message
                : "Remove failed"}
            </AlertDescription>
          </Alert>
        ) : null}
        {vmError ? (
          <Alert variant="destructive">
            <AlertTitle>Host action failed</AlertTitle>
            <AlertDescription>{vmError}</AlertDescription>
          </Alert>
        ) : null}
      </div>

      {showOnboarding ? (
        <HostOnboardingPanel eyebrow="New host" title="Bridge config" />
      ) : null}

      {hosts.isPending ? (
        <CardGridSkeleton cards={4} cardClassName="h-40" />
      ) : activeHostRecords.length ? (
        <PaginatedCollection
          items={activeHostRecords}
          pageSize={COLLECTION_PAGE_SIZE.cards}
          itemLabel="hosts"
        >
          {(visibleHosts) => (
            <div className="divide-y overflow-hidden rounded-xl border bg-card">
              {visibleHosts.map(({ host, hostVms, archiveTotalCount, capacity }) => {
                const isRemovingThisHost =
                  removeHost.isPending && removeHost.variables === host.id;
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
                    className="@container/host-card space-y-3 p-4"
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
                          <h2 className="truncate text-card-title">
                            {host.name}
                          </h2>
                          <Badge
                            variant={
                              host.status?.connected ? "success" : "outline"
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
                        <p className="text-caption">
                          {host.role === "builder" ? "Builder" : "Agent"} ·{" "}
                          <span className="font-mono">{host.id}</span> ·{" "}
                          {hostVms.length} live · {archiveTotalCount} archived
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
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
                              disabled={isRemovingThisHost}
                              onClick={() => setRemoveTarget(host)}
                            >
                              <Trash2 className="size-4" />
                              Remove host
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>

                    <dl className={hostMetricsGridClassName}>
                      <HostHeartbeatMetric
                        heartbeatAt={host.status?.lastHeartbeatAt}
                        detail={
                          host.actualState?.health === "degraded"
                            ? "State report overdue"
                            : host.status?.connected
                              ? "Bridge connected"
                              : "No fresh heartbeat"
                        }
                      />
                      <HostMetric
                        label="CPU / load"
                        value={
                          capacity
                            ? `${capacity.committed_cpu_millis} / ${capacity.schedulable_cpu_millis}m`
                            : "Unknown"
                        }
                        detail={
                          capacity
                            ? `${capacity.reserved_cpu_millis}m host reserve · load ${formatLoad(capacity.load_avg_1m)} / ${formatLoad(capacity.load_avg_5m)} / ${formatLoad(capacity.load_avg_15m)}`
                            : "No CPU capacity reported"
                        }
                        wrapDetail
                      />
                      <HostMetric
                        label="Memory"
                        value={memorySummary}
                        detail="Available / total"
                      />
                      <HostMetric
                        label={`Disk ${capacity?.disk_probe_path ?? "/"}`}
                        value={diskSummary}
                        detail="Available / total"
                      />
                      <HostMetric
                        label="Network"
                        value={capacity?.primary_ipv4 ?? "—"}
                        detail={capacity?.primary_ipv6 ?? "No IPv6 reported"}
                      />
                    </dl>
                  </article>
                );
              })}
            </div>
          )}
        </PaginatedCollection>
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
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRemoveTarget(null);
            setRemoveConfirm("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove this host?</DialogTitle>
            <DialogDescription>
              {removeTarget
                ? `Removing "${removeTarget.name}" (${removeTarget.id}) revokes its access and bootstrap credentials. Its run history remains available.`
                : null}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label
              htmlFor="remove-host-confirm"
              className="text-sm font-medium"
            >
              Type <span className="font-semibold">{removeTarget?.name}</span>{" "}
              to confirm
            </label>
            <Input
              id="remove-host-confirm"
              value={removeConfirm}
              onChange={(event) => setRemoveConfirm(event.target.value)}
              autoComplete="off"
            />
          </div>
          {removeHost.error ? (
            <InlineFeedback tone="error">
              {removeHost.error instanceof Error
                ? removeHost.error.message
                : "Host removal failed"}
            </InlineFeedback>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRemoveTarget(null)}
              disabled={removeHost.isPending}
            >
              Keep host
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (removeTarget) {
                  removeHost.mutate(removeTarget.id);
                }
              }}
              disabled={
                removeHost.isPending ||
                !removeTarget ||
                removeConfirm !== removeTarget.name
              }
            >
              <Trash2 className="size-4" />
              {removeHost.isPending ? "Removing…" : "Remove host"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}

// Host cards often sit beside the persistent app navigation. Let their own
// available width choose the grid, rather than letting a wide browser force
// five narrow metric columns. Five columns need a genuinely wide host card.
export const hostMetricsGridClassName =
  "grid grid-cols-1 gap-x-6 gap-y-4 border-t pt-4 @2xl/host-card:grid-cols-2 @4xl/host-card:grid-cols-3 @7xl/host-card:grid-cols-5";

export function HostHeartbeatMetric({
  heartbeatAt,
  detail,
}: {
  heartbeatAt: string | null | undefined;
  detail: string;
}) {
  const timestamp = parseHostTimestamp(heartbeatAt);
  const absoluteTimestamp = timestamp
    ? formatHostTimestamp(heartbeatAt)
    : null;
  const accessibleTimestamp = absoluteTimestamp
    ? `Last heartbeat: ${absoluteTimestamp}`
    : undefined;

  return (
    <HostMetric
      label="Heartbeat"
      value={
        timestamp && absoluteTimestamp ? (
          <time
            dateTime={new Date(timestamp).toISOString()}
            title={accessibleTimestamp}
            aria-label={accessibleTimestamp}
          >
            {formatRelativeTime(timestamp)}
          </time>
        ) : (
          "—"
        )
      }
      detail={detail}
      wrapValue
      wrapDetail
    />
  );
}

export function HostMetric({
  label,
  value,
  detail,
  wrapValue = false,
  wrapDetail = false,
}: {
  label: string;
  value: ReactNode;
  detail: string;
  wrapValue?: boolean;
  wrapDetail?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-label">{label}</dt>
      <dd
        className={
          wrapValue
            ? "mt-1 min-w-0 break-words text-sm font-medium tabular-nums"
            : "mt-1 min-w-0 truncate text-sm font-medium tabular-nums"
        }
      >
        {value}
      </dd>
      <dd
        className={
          wrapDetail
            ? "mt-0.5 min-w-0 break-words text-metadata leading-5"
            : "mt-0.5 min-w-0 truncate text-metadata"
        }
      >
        {detail}
      </dd>
    </div>
  );
}

function parseHostTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}
