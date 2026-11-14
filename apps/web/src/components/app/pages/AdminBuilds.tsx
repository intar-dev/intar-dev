import { Link } from "@tanstack/react-router";
import { ArrowLeft, ExternalLink, Hammer, PackageOpen } from "lucide-react";
import { useMemo } from "react";
import {
  type MachineBuildSummary,
  machineBuildLogUrl,
  shortRev,
  useMachineBuilds,
} from "@/components/app/admin/scenario-revisions";
import { formatRelativeTime } from "@/components/app/lib/format";
import {
  COLLECTION_PAGE_SIZE,
  PaginatedCollection,
} from "@/components/app/patterns/CollectionPagination";
import { MetaLine } from "@/components/app/patterns/MetaLine";
import { PageShell } from "@/components/app/patterns/PageShell";
import { Section } from "@/components/app/patterns/Section";
import { TableSkeleton } from "@/components/app/patterns/Skeletons";
import { EmptyState, ErrorState } from "@/components/app/patterns/StateCard";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { isAdminUser } from "@/lib/authz";
import { cn } from "@/lib/utils";
import { useSession } from "../hooks/useSession";
import { usePageChrome } from "../shell/page-chrome";

const ACTIVE = new Set(["queued", "assigned", "building"]);

/**
 * Platform admins see every machine build. Organization owners and admins
 * see the builds of their organizations' bundles; the API decides.
 */
export function AdminBuilds() {
  const manage = isAdminUser(useSession().data?.user);
  // The Admin crumb would bounce organization admins to the landing page.
  const back = useMemo(
    () =>
      manage ? undefined : (
        <Button variant="ghost" size="sm" aria-label="Back to organizations" render={<Link to="/organizations" />}>
          <ArrowLeft aria-hidden="true" />
          <span className="hidden md:inline">Organizations</span>
        </Button>
      ),
    [manage],
  );
  usePageChrome({ back });
  const builds = useMachineBuilds();
  const records = builds.data ?? [];
  const count = (predicate: (build: MachineBuildSummary) => boolean) => records.filter(predicate).length;

  return (
    <PageShell variant="workspace" density="compact">
      <Section
        variant="flat"
        density="compact"
        title="Queue posture"
        bodyClassName="grid grid-cols-2 gap-4 border-t pt-4 sm:grid-cols-4"
      >
        <BuildCount label="Total" value={records.length} />
        <BuildCount label="Active" value={count((build) => ACTIVE.has(build.state))} tone="brand" />
        <BuildCount label="Succeeded" value={count((build) => build.state === "succeeded")} tone="success" />
        <BuildCount label="Failed" value={count((build) => build.state === "failed")} tone="error" />
      </Section>

      {builds.error ? (
        <ErrorState
          title="Could not load builds"
          description={builds.error instanceof Error ? builds.error.message : "Failed to load builds"}
          onRetry={() => void builds.refetch()}
        />
      ) : builds.isPending ? (
        <TableSkeleton />
      ) : !records.length ? (
        <EmptyState
          icon={<PackageOpen />}
          title="No builds queued"
          description="Published scenario bundles create machine builds here."
        />
      ) : (
        <Section density="compact" title="Build queue" description="Content-addressed machine builds reported by builder hosts.">
          <PaginatedCollection items={records} pageSize={COLLECTION_PAGE_SIZE.dense} itemLabel="builds">
            {(visible) => (
              <div className="divide-y">
                {visible.map((build) => <BuildRow key={build.buildKey} build={build} />)}
              </div>
            )}
          </PaginatedCollection>
        </Section>
      )}
    </PageShell>
  );
}

function BuildRow({ build }: { build: MachineBuildSummary }) {
  return (
    <div className="grid gap-4 py-3 first:pt-0 last:pb-0 lg:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <StatusBadge state={build.state} />
          {build.phase ? (
            <span className="text-metadata">
              <span className="text-label">Phase</span> {build.phase}
            </span>
          ) : null}
        </div>
        <div className="min-w-0">
          <p className="truncate font-mono text-sm font-medium">{build.target}</p>
          <MetaLine dense className="font-mono" items={[build.buildKey.slice(0, 19), shortRev(build.bundleRev)]} />
        </div>
        <div className="grid gap-x-6 gap-y-2 text-sm md:grid-cols-2 xl:grid-cols-4">
          <BuildMeta label="Attempt" value={String(build.attempt)} />
          <BuildMeta label="Queued" value={formatRelativeTime(build.createdAt)} />
          <BuildMeta label="Updated" value={formatRelativeTime(build.updatedAt)} />
        </div>
        {build.error ? (
          <Alert variant="destructive">
            <AlertDescription>{build.error}</AlertDescription>
          </Alert>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 lg:flex-col lg:items-stretch">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="lg:w-full"
          disabled={!build.hasLog}
          render={build.hasLog ? <a href={machineBuildLogUrl(build.buildKey)} target="_blank" rel="noreferrer" /> : undefined}
        >
          <ExternalLink />
          Log
        </Button>
      </div>
    </div>
  );
}

function BuildCount({ label, value, tone = "default" }: { label: string; value: number; tone?: "default" | "brand" | "success" | "error" }) {
  return (
    <div>
      <p className="text-label">{label}</p>
      <p
        className={cn(
          "mt-1 text-section-title tabular-nums",
          tone === "brand" && "text-brand-text",
          tone === "success" && "text-success",
          tone === "error" && value > 0 && "text-destructive",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function StatusBadge({ state }: { state: string }) {
  switch (state) {
    case "succeeded":
      return <Badge variant="success">Succeeded</Badge>;
    case "failed":
      return <Badge variant="destructive">Failed</Badge>;
    case "building":
      return (
        <Badge variant="warning" className="gap-1">
          <Hammer className="size-3" />
          Building
        </Badge>
      );
    case "assigned":
      return <Badge variant="outline">Assigned</Badge>;
    default:
      return <Badge variant="outline">Queued</Badge>;
  }
}

function BuildMeta(props: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-label">{props.label}</p>
      <p className="mt-1 truncate text-sm font-medium text-foreground">{props.value}</p>
    </div>
  );
}
