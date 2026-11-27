import { useMemo, useState } from "react";
import { Link, useSearch } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, HardDriveDownload, Search } from "lucide-react";
import {
  type AdministeredScenario,
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
import { type StatusTone, StatusToken } from "@/components/app/patterns/StatusToken";
import { usePageChrome } from "@/components/app/shell/page-chrome";
import { ScenarioSourceSection } from "@/components/app/pages/organization-detail/scenario-source";
import { Button } from "@/components/ui/button";
import { isAdminUser } from "@/lib/authz";
import { cn } from "@/lib/utils";

/** A course across scopes: an organization's catalog may reuse a public course id. */
interface CourseGroup {
  key: string;
  title: string;
  scenarios: AdministeredScenario[];
}

const UNGROUPED = "none";

/** Courses in catalog order of first appearance, then the scenarios no course names. */
export function groupByCourse(scenarios: AdministeredScenario[]): CourseGroup[] {
  const groups = new Map<string, CourseGroup>();
  const ungrouped: AdministeredScenario[] = [];
  for (const scenario of scenarios) {
    if (!scenario.courses.length) ungrouped.push(scenario);
    for (const course of scenario.courses) {
      const key = `${scenario.organizationId ?? "public"}:${course.courseId}`;
      const group = groups.get(key) ?? { key, title: course.title, scenarios: [] };
      group.scenarios.push(scenario);
      groups.set(key, group);
    }
  }
  const list = [...groups.values()];
  if (ungrouped.length) list.push({ key: UNGROUPED, title: "Not in a course", scenarios: ungrouped });
  return list;
}

/** The one state a registry row shows for a scenario. */
export function scenarioState(scenario: AdministeredScenario): { word: string; tone: StatusTone } {
  if (!scenario.enabled) return { word: "Disabled", tone: "muted" };
  if (Object.keys(scenario.verifyRuns).length) return { word: "Verifying", tone: "live" };
  const candidate = scenario.candidateRev !== scenario.liveRev
    ? scenario.revisions.find((revision) => revision.rev === scenario.candidateRev)
    : undefined;
  if (scenario.sourceJob?.failed || candidate?.state === "failed") return { word: "Failed", tone: "danger" };
  if (candidate?.state === "building") return { word: "Building", tone: "pending" };
  if (candidate) return { word: "Candidate", tone: "info" };
  return scenario.liveRev ? { word: "Live", tone: "success" } : { word: "Not live", tone: "muted" };
}

const DOT_TONES: Record<StatusTone, string> = {
  pending: "bg-warning",
  live: "bg-primary",
  info: "bg-info",
  success: "bg-success",
  danger: "bg-destructive",
  muted: "bg-faint-foreground",
};

export function ScenarioRegistry() {
  const { course } = useSearch({ from: "/app/admin/scenarios" });
  const scenarios = useAdministeredScenarios();
  const platformAdmin = isAdminUser(useSession().data?.user);
  const groups = useMemo(() => groupByCourse(scenarios.data ?? []), [scenarios.data]);
  const group = course ? groups.find((entry) => entry.key === course) : undefined;

  usePageChrome({ title: group?.title ?? "Scenario registry" });

  return (
    <PageShell variant="workspace" density="compact">
      {platformAdmin && !course ? <ScenarioSourceSection endpoint="/api/admin/scenario-source" scope="public" /> : null}
      {scenarios.error ? (
        <ErrorState
          title="Could not load scenarios"
          description={scenarios.error instanceof Error ? scenarios.error.message : "Failed to load scenarios"}
          onRetry={() => void scenarios.refetch()}
        />
      ) : scenarios.isPending ? (
        <TableSkeleton />
      ) : !groups.length ? (
        <EmptyState
          icon={<HardDriveDownload />}
          title="No scenarios yet"
          description="Scenarios appear here once a connected repository publishes them. Each one shows its revisions, which one learners start, and which one is next."
        />
      ) : course ? (
        group ? <CourseScenarios group={group} /> : (
          <EmptyState
            icon={<Search />}
            title="Course not found"
            description="It may have left its catalog. Go back to the registry to pick another."
            action={<Button variant="outline" render={<Link to="/admin/scenarios" />}>All courses</Button>}
          />
        )
      ) : (
        <Section
          density="compact"
          title="Courses"
          description="Each dot is one of the course's scenarios, colored by its state. Learners start a scenario's live revision; a new revision is the candidate until its source checks it and puts it live."
          bodyClassName="divide-y"
        >
          {groups.map((entry) => <CourseRow key={entry.key} group={entry} />)}
        </Section>
      )}
    </PageShell>
  );
}

function CourseRow({ group }: { group: CourseGroup }) {
  const states = group.scenarios.map((scenario) => ({ scenario, state: scenarioState(scenario) }));
  const counts = new Map<string, number>();
  for (const { state } of states) counts.set(state.word, (counts.get(state.word) ?? 0) + 1);
  return (
    <Link
      to="/admin/scenarios"
      search={{ course: group.key }}
      className="group grid gap-2 py-3 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
    >
      <div className="min-w-0 space-y-1.5">
        <h3 className="text-sm font-semibold group-hover:underline">{group.title}</h3>
        <MetaLine
          items={[
            `${group.scenarios.length} ${group.scenarios.length === 1 ? "scenario" : "scenarios"}`,
            ...[...counts].map(([word, count]) => `${count} ${word.toLowerCase()}`),
          ]}
        />
      </div>
      <div className="flex items-center gap-3">
        <ul className="flex max-w-80 flex-wrap gap-1" aria-hidden>
          {states.map(({ scenario, state }) => (
            <li
              key={scenario.id}
              title={`${scenario.title ?? scenario.id}: ${state.word}`}
              className={cn("size-2.5 rounded-full", DOT_TONES[state.tone])}
            />
          ))}
        </ul>
        <ArrowRight className="size-4 text-muted-foreground" />
      </div>
    </Link>
  );
}

function CourseScenarios({ group }: { group: CourseGroup }) {
  const [search, setSearch] = useState("");
  const list = group.scenarios;
  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return needle
      ? list.filter((scenario) => scenario.id.includes(needle) || (scenario.title ?? "").toLowerCase().includes(needle))
      : list;
  }, [list, search]);
  return (
    <Section
      density="compact"
      title="Scenarios"
      description="Open a scenario for its revision history and verify runs."
      actions={<Button size="sm" variant="ghost" render={<Link to="/admin/scenarios" />}><ArrowLeft />All courses</Button>}
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
  );
}

function ScenarioRegistryRow({ scenario }: { scenario: AdministeredScenario }) {
  const [namespace, slug] = scenario.id.split("/") as [string, string];
  const state = scenarioState(scenario);
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
        <StatusToken tone={state.tone} word={state.word} />
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

