import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, HardDriveDownload, Search } from "lucide-react";
import {
  type AdministeredScenario,
  REVISION_STATES,
  shortRev,
  useAdministeredScenarios,
} from "@/components/app/admin/scenario-revisions";
import { useSession } from "@/components/app/hooks/useSession";
import {
  COLLECTION_PAGE_SIZE,
  PaginatedCollection,
} from "@/components/app/patterns/CollectionPagination";
import { FilterBar } from "@/components/app/patterns/FilterBar";
import { MetaLine } from "@/components/app/patterns/MetaLine";
import { PageShell } from "@/components/app/patterns/PageShell";
import { Section } from "@/components/app/patterns/Section";
import { TableSkeleton } from "@/components/app/patterns/Skeletons";
import { EmptyState, ErrorState } from "@/components/app/patterns/StateCard";
import { StatusToken } from "@/components/app/patterns/StatusToken";
import { ScenarioSourceSection } from "@/components/app/pages/organization-detail/scenario-source";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { isAdminUser } from "@/lib/authz";

export function ScenarioRegistry() {
  const [search, setSearch] = useState("");
  const scenarios = useAdministeredScenarios();
  const platformAdmin = isAdminUser(useSession().data?.user);
  const list = scenarios.data ?? [];
  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return needle
      ? list.filter((scenario) => scenario.id.includes(needle) || (scenario.title ?? "").toLowerCase().includes(needle))
      : list;
  }, [list, search]);

  return (
    <PageShell variant="workspace" density="compact">
      {platformAdmin ? <ScenarioSourceSection endpoint="/api/admin/scenario-source" scope="public" /> : null}
      {scenarios.error ? (
        <ErrorState
          title="Could not load scenarios"
          description={scenarios.error instanceof Error ? scenarios.error.message : "Failed to load scenarios"}
          onRetry={() => void scenarios.refetch()}
        />
      ) : scenarios.isPending ? (
        <TableSkeleton />
      ) : !list.length ? (
        <EmptyState
          icon={<HardDriveDownload />}
          title="No scenarios yet"
          description="Scenarios appear here once a connected repository publishes them. Each one shows its revisions, which one learners start, and which one is next."
        />
      ) : (
        <Section
          density="compact"
          title="Registry"
          description="Learners start a scenario's live revision. A new revision becomes the candidate once it builds; verify it, then promote it."
          bodyClassName="space-y-4"
        >
          <FilterBar
            search={search}
            onSearchChange={setSearch}
            searchPlaceholder="Search scenarios…"
            searchLabel="Search scenarios"
            filtersActive={Boolean(search.trim())}
            onClear={() => setSearch("")}
            shown={shown.length}
            total={list.length}
            noun="scenarios"
          />
          {!shown.length ? (
            <EmptyState
              icon={<Search />}
              title="No scenarios match your search"
              description="Clear the search or try a different term."
              headingLevel={3}
              action={<Button variant="outline" onClick={() => setSearch("")}>Clear search</Button>}
            />
          ) : (
            <PaginatedCollection items={shown} pageSize={COLLECTION_PAGE_SIZE.dense} itemLabel="scenarios" resetKey={search}>
              {(visible) => (
                <div className="divide-y">
                  {visible.map((scenario) => <ScenarioRegistryRow key={scenario.id} scenario={scenario} />)}
                </div>
              )}
            </PaginatedCollection>
          )}
        </Section>
      )}
    </PageShell>
  );
}

function ScenarioRegistryRow({ scenario }: { scenario: AdministeredScenario }) {
  const [namespace, slug] = scenario.id.split("/") as [string, string];
  const candidate = scenario.revisions.find((revision) => revision.rev === scenario.candidateRev) ?? null;
  const pending = candidate && candidate.rev !== scenario.liveRev ? REVISION_STATES[candidate.state] : null;
  const verifying = Object.keys(scenario.verifyRuns).length > 0;
  return (
    <div className="grid gap-3 py-3 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0 space-y-1.5">
        <h3>
          <Link
            to="/admin/scenarios/$namespace/$slug"
            params={{ namespace, slug }}
            className="inline-flex items-center text-sm font-semibold hover:underline pointer-coarse:min-h-11"
          >
            {scenario.title ?? scenario.id}
          </Link>
        </h3>
        <MetaLine
          items={[
            <code key="id">{scenario.id}</code>,
            scenario.liveRev ? <span key="live">Live <code>{shortRev(scenario.liveRev)}</code></span> : "Not live",
            `${scenario.revisions.length} ${scenario.revisions.length === 1 ? "revision" : "revisions"}`,
            scenario.enabled ? null : "Disabled",
          ]}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {verifying ? (
          <StatusToken tone="live" word="Verifying" />
        ) : pending ? (
          <span className="inline-flex items-center gap-2">
            <Badge variant="outline">Candidate</Badge>
            <StatusToken tone={pending.tone} word={pending.word} />
          </span>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Inspect ${scenario.title ?? scenario.id}`}
          render={<Link to="/admin/scenarios/$namespace/$slug" params={{ namespace, slug }} />}
        >
          Inspect
          <ArrowRight />
        </Button>
      </div>
    </div>
  );
}

export function formatScenarioResourceItems(
  resources: { cpuMillis: number; memoryMib: number; diskMib: number },
): string[] {
  return [
    `${formatCpu(resources.cpuMillis)} CPU`,
    formatMibResource(resources.memoryMib, "RAM"),
    formatMibResource(resources.diskMib, "disk"),
  ];
}

function formatCpu(cpuMillis: number): string {
  return (cpuMillis / 1000).toLocaleString(undefined, {
    maximumFractionDigits: 3,
  });
}

function formatMibResource(value: number, label: string): string {
  const gib = value / 1024;
  const formatted = gib.toLocaleString(undefined, {
    maximumFractionDigits: 1,
  });
  return `${formatted} GiB ${label}`;
}

