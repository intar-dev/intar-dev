import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ExternalLink,
  Hammer,
  Info,
  PackageOpen,
  RefreshCcw,
} from "lucide-react";
import { useState } from "react";
import { PageShell } from "@/components/app/patterns/PageShell";
import { Section } from "@/components/app/patterns/Section";
import { InlineFeedback } from "@/components/app/patterns/InlineFeedback";
import { TableSkeleton } from "@/components/app/patterns/Skeletons";
import {
  EmptyState,
  ErrorState,
} from "@/components/app/patterns/StateCard";
import {
  formatRelativeTime,
  formatTimestamp,
} from "@/components/app/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { BuildPhase } from "@/generated/bridge";
import { cn } from "@/lib/utils";

interface ImageBuildTimings {
  queuedAt?: number | null;
  startedAt?: number | null;
  finishedAt?: number | null;
  lastReportAt?: number | null;
}

interface ImageBuildRecord {
  id: string;
  scenarioId: string;
  arch: "x86_64" | "aarch64";
  rev: string;
  contentHash: string;
  kinoVersion: string;
  hostId: string | null;
  hostName: string | null;
  status: "queued" | "assigned" | "building" | "succeeded" | "failed" | "stale";
  phase: BuildPhase;
  attempt: number;
  error: string | null;
  canRetry: boolean;
  hasLog: boolean;
  timings: ImageBuildTimings;
  bundleR2Key: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ImageBuildListResponse {
  builds: ImageBuildRecord[];
}

interface ImageBuildDetailRecord extends ImageBuildRecord {
  host: {
    id: string;
    name: string | null;
    role: "agent" | "builder" | null;
    connected: boolean | null;
    lastHeartbeatAt: number | null;
  } | null;
  bundle: {
    rev: string;
    r2Key: string | null;
    kinoVersion: string | null;
    meta: unknown;
  };
}

interface ImageBuildDetailResponse {
  build: ImageBuildDetailRecord;
}

export function AdminBuilds() {
  const queryClient = useQueryClient();
  const [selectedBuildId, setSelectedBuildId] = useState<string | null>(null);
  const builds = useQuery({
    queryKey: ["admin-builds"],
    queryFn: fetchBuilds,
    refetchInterval: (query) =>
      query.state.data?.builds.some((build) =>
        ["queued", "assigned", "building", "stale"].includes(build.status),
      )
        ? 2_500
        : false,
    staleTime: 2_000,
  });
  const buildDetail = useQuery({
    queryKey: ["admin-build", selectedBuildId],
    queryFn: () => fetchBuildDetail(selectedBuildId ?? ""),
    enabled: selectedBuildId !== null,
    staleTime: 2_000,
  });

  const retryBuild = useMutation({
    mutationFn: async (buildId: string) => {
      const response = await fetch(
        `/api/admin/builds/${encodeURIComponent(buildId)}/retry`,
        {
          method: "POST",
          credentials: "include",
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `Retry failed (${response.status})`);
      }
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin-builds"] }),
        queryClient.invalidateQueries({ queryKey: ["admin-build"] }),
      ]);
    },
  });

  const records = builds.data?.builds ?? [];
  const activeCount = records.filter((build) =>
    ["queued", "assigned", "building", "stale"].includes(build.status),
  ).length;
  const failedCount = records.filter(
    (build) => build.status === "failed",
  ).length;
  const succeededCount = records.filter(
    (build) => build.status === "succeeded",
  ).length;

  return (
    <PageShell width="workspace" density="compact">
      <Section
        variant="flat"
        density="compact"
        title="Queue posture"
        bodyClassName="grid grid-cols-2 gap-4 border-y py-4 sm:grid-cols-4"
      >
        <BuildCount label="Total" value={records.length} />
        <BuildCount label="Active" value={activeCount} tone="brand" />
        <BuildCount label="Succeeded" value={succeededCount} tone="success" />
        <BuildCount label="Failed" value={failedCount} tone={failedCount ? "error" : "default"} />
      </Section>

      {retryBuild.error ? (
        <InlineFeedback tone="error">
          {retryBuild.error instanceof Error
            ? retryBuild.error.message
            : "Failed to retry build"}
        </InlineFeedback>
      ) : null}

      {builds.error ? (
        <ErrorState
          title="Could not load builds"
          description={
            builds.error instanceof Error
              ? builds.error.message
              : "Failed to load builds"
          }
          onRetry={() => void builds.refetch()}
        />
      ) : builds.isPending ? (
        <TableSkeleton />
      ) : !records.length ? (
        <EmptyState
          icon={<PackageOpen />}
          title="No builds queued"
          description="Uploaded scenario bundles will create build jobs here."
        />
      ) : (
        <Section
          density="compact"
          title="Build queue"
          description="Content-addressed scenario image builds reported by builder hosts."
          bodyClassName="divide-y"
        >
          {records.map((build) => (
            <BuildRow
              key={build.id}
              build={build}
              retryPending={
                retryBuild.isPending && retryBuild.variables === build.id
              }
              retryDisabled={retryBuild.isPending || !build.canRetry}
              detail={
                selectedBuildId === build.id ? buildDetail.data?.build : null
              }
              detailLoading={
                selectedBuildId === build.id && buildDetail.isLoading
              }
              detailError={
                selectedBuildId === build.id ? buildDetail.error : null
              }
              detailOpen={selectedBuildId === build.id}
              onToggleDetails={() =>
                setSelectedBuildId((current) =>
                  current === build.id ? null : build.id,
                )
              }
              onRetry={() => retryBuild.mutate(build.id)}
            />
          ))}
        </Section>
      )}
    </PageShell>
  );
}

function BuildRow(props: {
  build: ImageBuildRecord;
  retryPending: boolean;
  retryDisabled: boolean;
  detail: ImageBuildDetailRecord | null | undefined;
  detailLoading: boolean;
  detailError: unknown;
  detailOpen: boolean;
  onToggleDetails: () => void;
  onRetry: () => void;
}) {
  const { build } = props;
  const detailId = `build-details-${build.id}`;
  return (
    <div className="grid gap-4 py-4 first:pt-0 last:pb-0 lg:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <StatusBadge status={build.status} />
          <span className="text-metadata"><span className="text-eyebrow">Phase</span> {build.phase}</span>
          <span className="font-mono text-xs text-muted-foreground">{build.arch}</span>
          <span className="font-mono text-xs text-muted-foreground">kino {build.kinoVersion}</span>
        </div>

        <div className="min-w-0">
          <p className="truncate font-mono text-sm font-medium">
            {build.scenarioId}
          </p>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {build.id} - {shortHash(build.contentHash)} - {build.rev}
          </p>
        </div>

        <div className="grid gap-x-6 gap-y-2 text-sm md:grid-cols-2 xl:grid-cols-4">
          <BuildMeta
            label="Host"
            value={build.hostName ?? build.hostId ?? "Unassigned"}
          />
          <BuildMeta label="Attempt" value={String(build.attempt)} />
          <BuildMeta
            label="Updated"
            value={formatRelativeTime(build.updatedAt)}
          />
          <BuildMeta
            label="Last report"
            value={formatRelativeTime(build.timings.lastReportAt)}
          />
        </div>

        {build.error ? (
          <p className="rounded-md border border-destructive-border bg-destructive-subtle px-3 py-2 text-sm text-destructive">
            {build.error}
          </p>
        ) : null}

        {props.detailOpen ? (
          <BuildDetails
            id={detailId}
            detail={props.detail}
            loading={props.detailLoading}
            error={props.detailError}
          />
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 lg:flex-col lg:items-stretch">
        <Button
          type="button"
          size="sm"
          variant={props.detailOpen ? "secondary" : "outline"}
          aria-expanded={props.detailOpen}
          aria-controls={detailId}
          onClick={props.onToggleDetails}
          className="lg:w-full"
        >
          <Info className="size-4" />
          Details
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={props.onRetry}
          disabled={props.retryDisabled}
          className="lg:w-full"
        >
          <RefreshCcw
            className={cn("size-4", props.retryPending ? "animate-spin" : "")}
          />
          Retry
        </Button>
        {build.hasLog ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="lg:w-full"
            render={
              <a
                href={`/api/admin/builds/${encodeURIComponent(build.id)}/log`}
                target="_blank"
                rel="noreferrer"
              />
            }
          >
            <ExternalLink className="size-4" />
            Log
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled
            className="lg:w-full"
          >
            <ExternalLink className="size-4" />
            Log
          </Button>
        )}
      </div>
    </div>
  );
}

async function fetchBuilds(): Promise<ImageBuildListResponse> {
  const response = await fetch("/api/admin/builds", {
    method: "GET",
    credentials: "include",
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Failed to load builds (${response.status})`);
  }
  return (await response.json()) as ImageBuildListResponse;
}

async function fetchBuildDetail(
  buildId: string,
): Promise<ImageBuildDetailResponse> {
  const response = await fetch(
    `/api/admin/builds/${encodeURIComponent(buildId)}`,
    {
      method: "GET",
      credentials: "include",
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Failed to load build (${response.status})`);
  }
  return (await response.json()) as ImageBuildDetailResponse;
}

function BuildDetails(props: {
  id: string;
  detail: ImageBuildDetailRecord | null | undefined;
  loading: boolean;
  error: unknown;
}) {
  if (props.loading) {
    return (
      <div id={props.id} className="border-t pt-3 text-sm text-muted-foreground">
        Loading build details…
      </div>
    );
  }

  if (props.error) {
    return (
      <div id={props.id} className="border-t pt-3 text-sm text-destructive">
        {props.error instanceof Error
          ? props.error.message
          : "Failed to load build details"}
      </div>
    );
  }

  const detail = props.detail;
  if (!detail) {
    return <div id={props.id} />;
  }

  return (
    <div id={props.id} className="border-t pt-3">
      <div className="grid gap-x-6 gap-y-2 text-sm md:grid-cols-2 xl:grid-cols-4">
        <BuildMeta label="Bundle" value={detail.bundle.r2Key ?? detail.rev} />
        <BuildMeta
          label="Bundle kino"
          value={detail.bundle.kinoVersion ?? "Unknown"}
        />
        <BuildMeta
          label="Host status"
          value={detail.host ? hostStatus(detail.host) : "Unassigned"}
        />
        <BuildMeta
          label="Started"
          value={formatTimestamp(detail.timings.startedAt)}
        />
      </div>
      <dl className="terminal-surface mt-3 grid gap-x-6 gap-y-3 rounded-lg border p-3 text-xs md:grid-cols-2">
        <DetailPair label="Created" value={formatTimestamp(detail.createdAt)} />
        <DetailPair
          label="Finished"
          value={formatTimestamp(detail.timings.finishedAt)}
        />
        <DetailPair label="Content hash" value={detail.contentHash} />
        <DetailPair
          label="Host heartbeat"
          value={formatTimestamp(detail.host?.lastHeartbeatAt)}
        />
      </dl>
    </div>
  );
}

function BuildCount({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "brand" | "success" | "error";
}) {
  return (
    <div>
      <p className="text-eyebrow">{label}</p>
      <p
        className={cn(
          "mt-1 text-section-title tabular-nums",
          tone === "brand" && "text-primary",
          tone === "success" && "text-success",
          tone === "error" && "text-destructive",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function DetailPair(props: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-eyebrow">{props.label}</dt>
      <dd className="truncate font-mono text-foreground">{props.value}</dd>
    </div>
  );
}

function StatusBadge(props: { status: ImageBuildRecord["status"] }) {
  switch (props.status) {
    case "succeeded":
      return <Badge variant="success">Succeeded</Badge>;
    case "failed":
      return <Badge variant="destructive">Failed</Badge>;
    case "stale":
      return <Badge variant="warning">Stale</Badge>;
    case "building":
      return (
        <Badge variant="warning" className="gap-1">
          <Hammer className="size-3" />
          Building
        </Badge>
      );
    case "assigned":
      return <Badge variant="outline">Assigned</Badge>;
    case "queued":
      return <Badge variant="outline">Queued</Badge>;
  }
}

function BuildMeta(props: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-eyebrow">{props.label}</p>
      <p className="truncate text-sm font-medium text-foreground">
        {props.value}
      </p>
    </div>
  );
}

function shortHash(value: string) {
  return value.length > 12 ? `${value.slice(0, 12)}...` : value;
}

function hostStatus(host: NonNullable<ImageBuildDetailRecord["host"]>) {
  const name = host.name ?? host.id;
  const role = host.role ?? "unknown";
  const status = host.connected ? "connected" : "offline";
  return `${name} (${role}, ${status})`;
}
