import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  ChevronDown,
  ExternalLink,
  Hammer,
  Info,
  PackageOpen,
  Play,
  RefreshCcw,
} from "lucide-react";
import { useMemo, useState } from "react";
import { PageShell } from "@/components/app/patterns/PageShell";
import {
  COLLECTION_PAGE_SIZE,
  PaginatedCollection,
} from "@/components/app/patterns/CollectionPagination";
import { Section } from "@/components/app/patterns/Section";
import { InlineFeedback } from "@/components/app/patterns/InlineFeedback";
import { TableSkeleton } from "@/components/app/patterns/Skeletons";
import { EmptyState, ErrorState } from "@/components/app/patterns/StateCard";
import {
  formatRelativeTime,
  formatTimestamp,
} from "@/components/app/lib/format";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { MetaLine } from "@/components/app/patterns/MetaLine";
import type { BuildPhase } from "@/generated/bridge";
import { isAdminUser } from "@/lib/authz";
import { isActiveImageBuild } from "@/lib/build-scheduler-core";
import { cn } from "@/lib/utils";
import { apiErrorMessage } from "@/components/app/lib/api-errors";
import { HttpResponseError } from "@/components/app/lib/http-response-error";
import { requestScenarioStartWithCapacityWait } from "@/components/app/lib/scenario-start";
import { useSession } from "../hooks/useSession";
import { usePageChrome } from "../shell/page-chrome";

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
  organizationId: string | null;
  candidateAvailable: boolean;
  candidateProof: {
    revision: string;
    buildId: string;
  } | null;
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
    meta: unknown;
  };
}

interface ImageBuildDetailResponse {
  build: ImageBuildDetailRecord;
}

/**
 * Platform admins manage every build. Organization owners and admins see
 * only their organizations' builds, read-only: the API projects them without
 * builder hosts, and retry, details and candidate runs stay platform-only.
 */
export function AdminBuilds() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const manage = isAdminUser(useSession().data?.user);
  // The Admin crumb would bounce organization admins to the landing page.
  const back = useMemo(
    () =>
      manage ? undefined : (
        <Button
          variant="ghost"
          size="sm"
          aria-label="Back to organizations"
          render={<Link to="/organizations" />}
        >
          <ArrowLeft aria-hidden="true" />
          <span className="hidden md:inline">Organizations</span>
        </Button>
      ),
    [manage],
  );
  usePageChrome({ back });
  const [selectedBuildId, setSelectedBuildId] = useState<string | null>(null);
  const builds = useQuery({
    queryKey: ["admin-builds"],
    queryFn: fetchBuilds,
    // Builds run for minutes and each read returns up to 200 rows.
    refetchInterval: (query) =>
      query.state.data?.builds.some((build) =>
        isActiveImageBuild(build.status),
      )
        ? 5_000
        : false,
    staleTime: 2_000,
  });
  const buildDetail = useQuery({
    queryKey: ["admin-build", selectedBuildId],
    queryFn: () => fetchBuildDetail(selectedBuildId ?? ""),
    enabled: manage && selectedBuildId !== null,
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
        throw HttpResponseError.fromBody(
          response.status,
          await response.json().catch(() => null),
          `Retry failed (${response.status})`,
        );
      }
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin-builds"] }),
        queryClient.invalidateQueries({ queryKey: ["admin-build"] }),
      ]);
    },
  });
  const runCandidate = useMutation({
    mutationFn: async (input: {
      buildId: string;
      scenarioId: string;
      candidateRevision: string;
      candidateBuildId: string;
      organizationId: string | null;
    }) =>
      requestScenarioStartWithCapacityWait(input.scenarioId, {
        signal: new AbortController().signal,
        onCapacityWait: () => undefined,
        candidateRevision: input.candidateRevision,
        candidateBuildId: input.candidateBuildId,
        organizationId: input.organizationId,
      }),
    onSuccess: async ({ runId }) => {
      await navigate({
        to: "/runs/$runId",
        params: { runId },
      });
    },
  });

  const records = builds.data?.builds ?? [];
  const activeCount = records.filter((build) =>
    isActiveImageBuild(build.status),
  ).length;
  const needsAttentionCount = records.filter((build) => build.canRetry).length;
  const succeededCount = records.filter(
    (build) => build.status === "succeeded",
  ).length;

  return (
    <PageShell variant="workspace" density="compact">
      <Section
        variant="flat"
        density="compact"
        title="Queue posture"
        bodyClassName="grid grid-cols-2 gap-4 border-t pt-4 sm:grid-cols-4"
      >
        <BuildCount label="Total" value={records.length} />
        <BuildCount label="Active" value={activeCount} tone="brand" />
        <BuildCount label="Succeeded" value={succeededCount} tone="success" />
        <BuildCount
          label="Needs attention"
          value={needsAttentionCount}
          tone={needsAttentionCount ? "error" : "default"}
        />
      </Section>

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
        >
          <PaginatedCollection
            items={records}
            pageSize={COLLECTION_PAGE_SIZE.dense}
            itemLabel="builds"
          >
            {(visibleBuilds) => (
              <div className="divide-y">
                {visibleBuilds.map((build) => (
                  <BuildRow
                    key={build.id}
                    build={build}
                    manage={manage}
                    retryPending={
                      retryBuild.isPending && retryBuild.variables === build.id
                    }
                    retryDisabled={retryBuild.isPending || !build.canRetry}
                    actionError={buildActionError(
                      build.id,
                      retryBuild,
                      runCandidate,
                    )}
                    runCandidatePending={
                      runCandidate.isPending &&
                      runCandidate.variables?.buildId === build.id
                    }
                    detail={
                      selectedBuildId === build.id
                        ? buildDetail.data?.build
                        : null
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
                    onRunCandidate={(detail) => {
                      if (!detail.candidateProof) return;
                      runCandidate.mutate({
                        buildId: detail.id,
                        scenarioId: detail.scenarioId,
                        candidateRevision: detail.candidateProof.revision,
                        candidateBuildId: detail.candidateProof.buildId,
                        organizationId: detail.organizationId,
                      });
                    }}
                  />
                ))}
              </div>
            )}
          </PaginatedCollection>
        </Section>
      )}
    </PageShell>
  );
}

function buildActionError(
  buildId: string,
  retry: { error: unknown; variables: string | undefined },
  candidate: { error: unknown; variables: { buildId: string } | undefined },
): string | null {
  if (retry.error && retry.variables === buildId) {
    return `Could not retry build ${buildId}: ${
      apiErrorMessage(retry.error, "Try again.") ?? "Try again."
    }`;
  }
  if (candidate.error && candidate.variables?.buildId === buildId) {
    return `Could not start a candidate run for build ${buildId}: ${
      apiErrorMessage(candidate.error, "Try again.") ?? "Try again."
    }`;
  }
  return null;
}

function BuildRow(props: {
  build: ImageBuildRecord;
  manage: boolean;
  retryPending: boolean;
  retryDisabled: boolean;
  /** The row's own failed action, named after the build. */
  actionError: string | null;
  runCandidatePending: boolean;
  detail: ImageBuildDetailRecord | null | undefined;
  detailLoading: boolean;
  detailError: unknown;
  detailOpen: boolean;
  onToggleDetails: () => void;
  onRetry: () => void;
  onRunCandidate: (detail: ImageBuildDetailRecord) => void;
}) {
  const { build } = props;
  const detailId = `build-details-${build.id}`;
  return (
    <div
      data-build-id={build.id}
      className="grid gap-4 py-3 first:pt-0 last:pb-0 lg:grid-cols-[minmax(0,1fr)_auto]"
    >
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <StatusBadge status={build.status} canRetry={build.canRetry} />
          <span className="text-metadata">
            <span className="text-label">
              {build.status === "stale" ? "Last phase" : "Phase"}
            </span>{" "}
            {build.phase}
          </span>
          <span className="font-mono text-xs text-muted-foreground">
            {build.arch}
          </span>
        </div>

        <div className="min-w-0">
          <p className="truncate font-mono text-sm font-medium">
            {build.scenarioId}
          </p>
          <MetaLine
            dense
            className="font-mono"
            items={[build.id, shortHash(build.contentHash), build.rev]}
          />
        </div>

        <div className="grid gap-x-6 gap-y-2 text-sm md:grid-cols-2 xl:grid-cols-4">
          {props.manage ? (
            <BuildMeta
              label="Host"
              value={build.hostName ?? build.hostId ?? "Unassigned"}
            />
          ) : null}
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
          build.status === "stale" && !build.canRetry ? (
            <Alert>
              <AlertDescription>{build.error}</AlertDescription>
            </Alert>
          ) : (
            <Alert variant="destructive">
              <AlertDescription>{build.error}</AlertDescription>
            </Alert>
          )
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 lg:flex-col lg:items-stretch">
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label={`Details for build ${build.id}`}
          aria-expanded={props.detailOpen}
          aria-controls={props.detailOpen ? detailId : undefined}
          onClick={props.onToggleDetails}
          className="group lg:w-full"
        >
          <Info />
          Details
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "transition-transform duration-(--duration-moderate) ease-enter",
              props.detailOpen && "rotate-180",
            )}
          />
        </Button>
        {props.manage ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={props.onRetry}
            disabled={props.retryDisabled}
            className="lg:w-full"
          >
            <RefreshCcw
              className={props.retryPending ? "motion-safe:animate-spin" : ""}
            />
            Retry
          </Button>
        ) : null}
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
            <ExternalLink />
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
            <ExternalLink />
            Log
          </Button>
        )}
      </div>

      {props.actionError ? (
        <InlineFeedback tone="error" className="lg:col-span-2">
          {props.actionError}
        </InlineFeedback>
      ) : null}

      <Collapsible open={props.detailOpen} className="lg:col-span-2">
        <CollapsibleContent id={detailId}>
          <BuildDetails
            build={build}
            detail={props.detail}
            loading={props.detailLoading}
            error={props.detailError}
            runCandidatePending={props.runCandidatePending}
            onRunCandidate={props.onRunCandidate}
          />
        </CollapsibleContent>
      </Collapsible>
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
    throw new Error(
      body?.error ?? `Failed to load builds (${response.status})`,
    );
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

// Only platform admins load `detail`: the builder host and candidate proof.
function BuildDetails(props: {
  build: ImageBuildRecord;
  detail: ImageBuildDetailRecord | null | undefined;
  loading: boolean;
  error: unknown;
  runCandidatePending: boolean;
  onRunCandidate: (detail: ImageBuildDetailRecord) => void;
}) {
  if (props.loading) {
    return (
      <div
        role="status"
        className="border-t pt-3 text-sm text-muted-foreground"
      >
        Loading build details…
      </div>
    );
  }

  if (props.error) {
    return (
      <div className="border-t pt-3">
        <Alert variant="destructive" just>
          <AlertDescription>
            {props.error instanceof Error
              ? props.error.message
              : "Could not load build details."}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const { build, detail } = props;
  return (
    <div className="border-t pt-3">
      <div className="grid gap-x-6 gap-y-2 text-sm md:grid-cols-2 xl:grid-cols-4">
        <BuildMeta label="Bundle" value={detail?.bundle.r2Key ?? build.rev} />
        {detail ? (
          <BuildMeta
            label="Host status"
            value={detail.host ? hostStatus(detail.host) : "Unassigned"}
          />
        ) : null}
        <BuildMeta
          label="Started"
          value={formatTimestamp(build.timings.startedAt)}
        />
      </div>
      <dl className="mt-3 grid gap-x-6 gap-y-3 rounded-lg border bg-muted/50 p-3 text-xs md:grid-cols-2">
        <DetailPair label="Created" value={formatTimestamp(build.createdAt)} />
        <DetailPair
          label="Finished"
          value={formatTimestamp(build.timings.finishedAt)}
        />
        <DetailPair mono label="Content hash" value={build.contentHash} />
        {detail ? (
          <DetailPair
            label="Host heartbeat"
            value={formatTimestamp(detail.host?.lastHeartbeatAt)}
          />
        ) : null}
      </dl>
      {detail?.candidateAvailable ? (
        <div className="mt-3">
          <Button
            type="button"
            size="sm"
            onClick={() => props.onRunCandidate(detail)}
            disabled={props.runCandidatePending}
          >
            <Play />
            Run candidate
          </Button>
        </div>
      ) : null}
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
      <p className="text-label">{label}</p>
      <p
        className={cn(
          "mt-1 text-section-title tabular-nums",
          tone === "brand" && "text-brand-text",
          tone === "success" && "text-success",
          tone === "error" && "text-destructive",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function DetailPair(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-label">{props.label}</dt>
      <dd
        className={cn(
          "mt-1 text-foreground [overflow-wrap:anywhere]",
          props.mono ? "font-mono" : "text-metadata",
        )}
      >
        {props.value}
      </dd>
    </div>
  );
}

function StatusBadge(props: {
  status: ImageBuildRecord["status"];
  canRetry: boolean;
}) {
  switch (props.status) {
    case "succeeded":
      return <Badge variant="success">Succeeded</Badge>;
    case "failed":
      return <Badge variant="destructive">Failed</Badge>;
    case "stale":
      return (
        <Badge variant="warning">
          {props.canRetry ? "Stale" : "Superseded"}
        </Badge>
      );
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
      <p className="text-label">{props.label}</p>
      <p className="mt-1 truncate text-sm font-medium text-foreground">
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
