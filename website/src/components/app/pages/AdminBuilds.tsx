import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ExternalLink,
  Hammer,
  Info,
  PackageOpen,
  RefreshCcw,
} from "lucide-react";
import { useState } from "react";
import { AuthenticatedShell } from "@/components/app/AuthenticatedShell";
import { EmptyStateCard } from "@/components/app/PagePatterns";
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
  const failedCount = records.filter((build) => build.status === "failed").length;
  const succeededCount = records.filter(
    (build) => build.status === "succeeded",
  ).length;

  return (
    <AuthenticatedShell
      title="Image builds"
      description="Builder job queue, assignment, reports, and logs."
    >
      <Card className="overflow-hidden">
        <CardHeader className="border-b border-border/70 bg-muted/30">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-2">
              <CardTitle className="text-lg">Build queue</CardTitle>
              <CardDescription>
                Content-addressed scenario image builds reported by builder hosts.
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">{records.length} total</Badge>
              <Badge variant="secondary">{activeCount} active</Badge>
              <Badge variant="outline">{succeededCount} succeeded</Badge>
              <Badge variant={failedCount > 0 ? "destructive" : "outline"}>
                {failedCount} failed
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 pt-6">
          {builds.error ? (
            <Alert variant="destructive">
              <AlertTitle>Could not load builds</AlertTitle>
              <AlertDescription>
                {builds.error instanceof Error
                  ? builds.error.message
                  : "Failed to load builds"}
              </AlertDescription>
            </Alert>
          ) : null}

          {retryBuild.error ? (
            <Alert variant="destructive">
              <AlertTitle>Could not retry build</AlertTitle>
              <AlertDescription>
                {retryBuild.error instanceof Error
                  ? retryBuild.error.message
                  : "Failed to retry build"}
              </AlertDescription>
            </Alert>
          ) : null}

          {!builds.isLoading && !records.length ? (
            <EmptyStateCard
              icon={<PackageOpen className="size-10" />}
              title="No builds queued"
              description="Uploaded scenario bundles will create build jobs here."
            />
          ) : (
            <div className="space-y-3">
              {records.map((build) => (
                <BuildRow
                  key={build.id}
                  build={build}
                  retryPending={
                    retryBuild.isPending && retryBuild.variables === build.id
                  }
                  retryDisabled={retryBuild.isPending || !build.canRetry}
                  detail={selectedBuildId === build.id ? buildDetail.data?.build : null}
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
            </div>
          )}
        </CardContent>
      </Card>
    </AuthenticatedShell>
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
  return (
    <article className="grid gap-4 rounded-lg border border-border/70 bg-card/70 p-4 lg:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={build.status} />
          <Badge variant="outline">{build.phase}</Badge>
          <Badge variant="outline">{build.arch}</Badge>
          <Badge variant="outline">kino {build.kinoVersion}</Badge>
        </div>

        <div className="min-w-0">
          <p className="truncate text-base font-semibold tracking-tight">
            {build.scenarioId}
          </p>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {build.id} - {shortHash(build.contentHash)} - {build.rev}
          </p>
        </div>

        <div className="grid gap-2 text-sm text-muted-foreground md:grid-cols-2 xl:grid-cols-4">
          <BuildMeta
            label="Host"
            value={build.hostName ?? build.hostId ?? "Unassigned"}
          />
          <BuildMeta label="Attempt" value={String(build.attempt)} />
          <BuildMeta label="Updated" value={formatDateTime(build.updatedAt)} />
          <BuildMeta
            label="Last report"
            value={formatDateTime(build.timings.lastReportAt)}
          />
        </div>

        {build.error ? (
          <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {build.error}
          </p>
        ) : null}

        {props.detailOpen ? (
          <BuildDetails
            detail={props.detail}
            loading={props.detailLoading}
            error={props.detailError}
          />
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 lg:flex-col lg:items-stretch">
        <Button
          type="button"
          variant={props.detailOpen ? "secondary" : "outline"}
          onClick={props.onToggleDetails}
          className="lg:w-full"
        >
          <Info className="size-4" />
          Details
        </Button>
        <Button
          type="button"
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
          <Button asChild type="button" variant="outline" className="lg:w-full">
            <a
              href={`/api/admin/builds/${encodeURIComponent(build.id)}/log`}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink className="size-4" />
              Log
            </a>
          </Button>
        ) : (
          <Button type="button" variant="outline" disabled className="lg:w-full">
            <ExternalLink className="size-4" />
            Log
          </Button>
        )}
      </div>
    </article>
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

async function fetchBuildDetail(buildId: string): Promise<ImageBuildDetailResponse> {
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
  detail: ImageBuildDetailRecord | null | undefined;
  loading: boolean;
  error: unknown;
}) {
  if (props.loading) {
    return (
      <div className="border-t border-border/70 pt-3 text-sm text-muted-foreground">
        Loading build details...
      </div>
    );
  }

  if (props.error) {
    return (
      <div className="border-t border-border/70 pt-3 text-sm text-destructive">
        {props.error instanceof Error
          ? props.error.message
          : "Failed to load build details"}
      </div>
    );
  }

  const detail = props.detail;
  if (!detail) {
    return null;
  }

  return (
    <div className="border-t border-border/70 pt-3">
      <div className="grid gap-2 text-sm text-muted-foreground md:grid-cols-2 xl:grid-cols-4">
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
          value={formatDateTime(detail.timings.startedAt)}
        />
      </div>
      <dl className="mt-3 grid gap-2 text-xs text-muted-foreground md:grid-cols-2">
        <DetailPair label="Created" value={formatDateTime(detail.createdAt)} />
        <DetailPair
          label="Finished"
          value={formatDateTime(detail.timings.finishedAt)}
        />
        <DetailPair label="Content hash" value={detail.contentHash} />
        <DetailPair
          label="Host heartbeat"
          value={formatDateTime(detail.host?.lastHeartbeatAt)}
        />
      </dl>
    </div>
  );
}

function DetailPair(props: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="uppercase">{props.label}</dt>
      <dd className="truncate font-mono text-foreground">{props.value}</dd>
    </div>
  );
}

function StatusBadge(props: { status: ImageBuildRecord["status"] }) {
  switch (props.status) {
    case "succeeded":
      return <Badge variant="secondary">Succeeded</Badge>;
    case "failed":
      return <Badge variant="destructive">Failed</Badge>;
    case "stale":
      return <Badge variant="outline">Stale</Badge>;
    case "building":
      return (
        <Badge variant="outline" className="gap-1">
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
    <div className="min-w-0 rounded-md bg-muted/30 px-3 py-2">
      <p className="text-xs uppercase text-muted-foreground">{props.label}</p>
      <p className="truncate font-medium text-foreground">{props.value}</p>
    </div>
  );
}

function shortHash(value: string) {
  return value.length > 12 ? `${value.slice(0, 12)}...` : value;
}

function formatDateTime(value: number | null | undefined) {
  if (!value) {
    return "Never";
  }
  return new Date(value).toLocaleString();
}

function hostStatus(host: NonNullable<ImageBuildDetailRecord["host"]>) {
  const name = host.name ?? host.id;
  const role = host.role ?? "unknown";
  const status = host.connected ? "connected" : "offline";
  return `${name} (${role}, ${status})`;
}
