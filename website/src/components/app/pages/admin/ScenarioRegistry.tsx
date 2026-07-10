import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowRight,
  CircleCheckBig,
  CircleOff,
  HardDriveDownload,
  Search,
} from "lucide-react";
import { PageShell } from "@/components/app/patterns/PageShell";
import { Section } from "@/components/app/patterns/Section";
import {
  DifficultyChip,
  SCENARIO_DIFFICULTIES,
  type ScenarioDifficulty,
} from "@/components/app/patterns/MetaChip";
import { FilterBar, FilterChip } from "@/components/app/patterns/FilterBar";
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from "@/components/app/patterns/StateCard";
import { formatRelativeTime } from "@/components/app/lib/format";
import { Button } from "@/components/ui/button";
import type {
  AdminScenarioListResponse,
  AdminScenarioSummary,
} from "@/components/app/admin/hosts/types";
import { cn } from "@/lib/utils";

type StateFilter = "enabled" | "disabled" | null;

interface ScenarioSourceSummary {
  scenarioId: string;
  status: "draft" | "published";
}

type ScenarioBuildStatus =
  | "queued"
  | "assigned"
  | "building"
  | "succeeded"
  | "failed"
  | "stale";

interface ScenarioBuildSummary {
  scenarioId: string;
  status: ScenarioBuildStatus;
  updatedAt: number;
}

export function ScenarioRegistry() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState<StateFilter>(null);
  const [difficulty, setDifficulty] = useState<ScenarioDifficulty | null>(null);
  const [category, setCategory] = useState<string | null>(null);

  const scenarios = useQuery({
    queryKey: ["admin-scenarios"],
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
  const sources = useQuery({
    queryKey: ["admin", "authoring", "sources"],
    queryFn: fetchScenarioSources,
    staleTime: 5_000,
  });
  const builds = useQuery({
    queryKey: ["admin-builds"],
    queryFn: fetchScenarioBuilds,
    staleTime: 2_000,
  });

  const setEnabled = useMutation({
    mutationFn: async (params: { scenarioId: string; enabled: boolean }) => {
      const response = await fetch(
        `/api/admin/scenarios/${encodeURIComponent(params.scenarioId)}/enabled`,
        {
          method: params.enabled ? "POST" : "DELETE",
          credentials: "include",
        },
      );

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          body?.error ??
            `Failed to ${params.enabled ? "enable" : "disable"} scenario`,
        );
      }
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin-scenarios"] }),
        queryClient.invalidateQueries({ queryKey: ["scenarios"] }),
      ]);
    },
  });

  const scenarioList = scenarios.data?.scenarios ?? [];
  const enabledCount = scenarioList.filter(
    (scenario) => scenario.enabled,
  ).length;
  const categories = useMemo(
    () =>
      [
        ...new Set(
          scenarioList
            .map((scenario) => scenario.category)
            .filter((value) => value.trim()),
        ),
      ].sort(),
    [scenarioList],
  );
  const sourceByScenarioId = useMemo(
    () =>
      new Map(
        (sources.data?.sources ?? []).map((source) => [
          source.scenarioId,
          source,
        ]),
      ),
    [sources.data],
  );
  const latestBuildByScenarioId = useMemo(() => {
    const latestBuilds = new Map<string, ScenarioBuildSummary>();
    for (const build of builds.data?.builds ?? []) {
      const current = latestBuilds.get(build.scenarioId);
      if (!current || build.updatedAt > current.updatedAt) {
        latestBuilds.set(build.scenarioId, build);
      }
    }
    return latestBuilds;
  }, [builds.data]);
  const filteredScenarios = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return scenarioList
      .filter((scenario) => {
        if (stateFilter === "enabled" && !scenario.enabled) return false;
        if (stateFilter === "disabled" && scenario.enabled) return false;
        if (difficulty && scenario.difficulty !== difficulty) return false;
        if (category && scenario.category !== category) return false;
        if (!needle) return true;
        return (
          scenario.title.toLowerCase().includes(needle) ||
          scenario.scenarioId.toLowerCase().includes(needle) ||
          scenario.category.toLowerCase().includes(needle) ||
          scenario.tags.some((tag) => tag.toLowerCase().includes(needle))
        );
      })
      .sort((left, right) => left.title.localeCompare(right.title));
  }, [category, difficulty, scenarioList, search, stateFilter]);
  const filtersActive = Boolean(search.trim() || stateFilter || difficulty || category);

  const clearFilters = () => {
    setSearch("");
    setStateFilter(null);
    setDifficulty(null);
    setCategory(null);
  };

  return (
    <PageShell
      admin
      width="workspace"
      density="compact"
      title="Scenarios"
      description="Inspect uploaded scenarios and control which ones are live for learners."
      actions={
        <>
          <Button
            size="sm"
            variant="outline"
            render={<Link to="/admin/authoring" />}
          >
            Authoring drafts
          </Button>
          <Button
            size="sm"
            variant="outline"
            render={<Link to="/admin/builds" />}
          >
            Image builds
          </Button>
        </>
      }
    >
      {scenarios.error ? (
        <ErrorState
          title="Could not load scenarios"
          description={
            scenarios.error instanceof Error
              ? scenarios.error.message
              : "Failed to load scenarios"
          }
          onRetry={() => void scenarios.refetch()}
        />
      ) : scenarios.isLoading ? (
        <LoadingState title="Loading scenarios" />
      ) : !scenarioList.length ? (
        <EmptyState
          icon={<HardDriveDownload />}
          title="No scenarios uploaded"
          description="Create and validate a draft in Authoring, or upload one through the external pipeline. Published scenarios appear here with their VM inventory, checks, and learner availability."
        />
      ) : (
        <div className="space-y-4">
          <dl className="grid gap-4 border-y py-4 sm:grid-cols-3">
            <div>
              <dt className="text-eyebrow">Registry</dt>
              <dd className="mt-1 text-section-title tabular-nums">{scenarioList.length}</dd>
            </div>
            <div>
              <dt className="text-eyebrow">Enabled for learners</dt>
              <dd className="mt-1 text-section-title text-success tabular-nums">{enabledCount}</dd>
            </div>
            <div>
              <dt className="text-eyebrow">Unavailable</dt>
              <dd className="mt-1 text-section-title tabular-nums">{scenarioList.length - enabledCount}</dd>
            </div>
          </dl>
          <FilterBar
            search={search}
            onSearchChange={setSearch}
            searchPlaceholder="Search registry…"
            searchLabel="Search scenarios"
            filtersActive={filtersActive}
            onClear={clearFilters}
          >
            <div className="flex items-center gap-1.5">
              <FilterChip
                active={stateFilter === "enabled"}
                onClick={() =>
                  setStateFilter((current) =>
                    current === "enabled" ? null : "enabled",
                  )
                }
              >
                Enabled
              </FilterChip>
              <FilterChip
                active={stateFilter === "disabled"}
                onClick={() =>
                  setStateFilter((current) =>
                    current === "disabled" ? null : "disabled",
                  )
                }
              >
                Disabled
              </FilterChip>
            </div>
            <div className="flex items-center gap-1.5">
              {SCENARIO_DIFFICULTIES.map((level) => (
                <FilterChip
                  key={level}
                  active={difficulty === level}
                  onClick={() =>
                    setDifficulty((current) =>
                      current === level ? null : level,
                    )
                  }
                >
                  {level}
                </FilterChip>
              ))}
            </div>
            {categories.length > 1 ? (
              <div className="flex items-center gap-1.5">
                {categories.map((entry) => (
                  <FilterChip
                    key={entry}
                    active={category === entry}
                    onClick={() =>
                      setCategory((current) =>
                        current === entry ? null : entry,
                      )
                    }
                    className="normal-case"
                  >
                    {entry}
                  </FilterChip>
                ))}
              </div>
            ) : null}
          </FilterBar>

          {filtersActive && filteredScenarios.length ? (
            <p className="text-caption">
              Showing {filteredScenarios.length} of {scenarioList.length} scenarios.
            </p>
          ) : null}

          {!filteredScenarios.length ? (
            <EmptyState
              icon={<Search />}
              title="No scenarios match your filters"
              description="Clear the filters or try a different search term."
              action={
                <Button variant="outline" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <Section
              density="compact"
              title="Registry"
              description="Each scenario is keyed by its stable scenario ID; new uploads replace the stored scenario for that ID."
              bodyClassName="divide-y"
            >
              {setEnabled.error ? (
                <p className="pb-3 text-sm text-destructive">
                  {setEnabled.error instanceof Error
                    ? setEnabled.error.message
                    : "Failed to update scenario"}
                </p>
              ) : null}
              {filteredScenarios.map((scenario) => (
                <ScenarioRegistryRow
                  key={scenario.scenarioId}
                  scenario={scenario}
                  source={sourceByScenarioId.get(scenario.scenarioId) ?? null}
                  sourceLoading={sources.isLoading}
                  sourceUnavailable={Boolean(sources.error && !sources.data)}
                  latestBuild={
                    latestBuildByScenarioId.get(scenario.scenarioId) ?? null
                  }
                  buildLoading={builds.isLoading}
                  buildUnavailable={Boolean(builds.error && !builds.data)}
                  pending={
                    setEnabled.isPending &&
                    setEnabled.variables?.scenarioId === scenario.scenarioId
                  }
                  disabled={setEnabled.isPending}
                  onToggle={() =>
                    setEnabled.mutate({
                      scenarioId: scenario.scenarioId,
                      enabled: !scenario.enabled,
                    })
                  }
                />
              ))}
            </Section>
          )}
        </div>
      )}
    </PageShell>
  );
}

function ScenarioRegistryRow({
  scenario,
  source,
  sourceLoading,
  sourceUnavailable,
  latestBuild,
  buildLoading,
  buildUnavailable,
  pending,
  disabled,
  onToggle,
}: {
  scenario: AdminScenarioSummary;
  source: ScenarioSourceSummary | null;
  sourceLoading: boolean;
  sourceUnavailable: boolean;
  latestBuild: ScenarioBuildSummary | null;
  buildLoading: boolean;
  buildUnavailable: boolean;
  pending: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const sourceValue = sourceLoading
    ? "Checking source…"
    : sourceUnavailable
      ? "Status unavailable"
      : source?.status === "draft"
        ? "Draft saved"
        : source?.status === "published"
          ? "Published source"
          : "Published record";
  const buildValue = buildLoading
    ? "Checking builds…"
    : buildUnavailable
      ? "Status unavailable"
      : latestBuild
        ? BUILD_STATUS_LABELS[latestBuild.status]
        : "No build";

  return (
    <div className="grid gap-4 py-4 first:pt-0 last:pb-0 xl:grid-cols-[minmax(13rem,1fr)_minmax(20rem,1.4fr)_minmax(13rem,0.8fr)_auto] xl:items-center">
      <div className="min-w-0 space-y-1">
        <h3>
          <Link
            to="/admin/scenarios/$scenarioId"
            params={{ scenarioId: scenario.scenarioId }}
            className="inline-flex min-h-11 items-center text-sm font-semibold hover:underline"
          >
            {scenario.title}
          </Link>
        </h3>
        <p className="truncate font-mono text-xs text-muted-foreground">
          {scenario.scenarioId}
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <DifficultyChip difficulty={scenario.difficulty} />
          <span className="text-sm">{scenario.category}</span>
        </div>
        {scenario.tags.length ? (
          <p className="truncate text-metadata">{scenario.tags.join(", ")}</p>
        ) : null}
      </div>

      <dl
        className="grid grid-cols-3 gap-3 border-y py-3 text-sm xl:border-y-0 xl:py-0"
        aria-label={`${scenario.title} status`}
      >
        <StatusDefinition
          label="Availability"
          value={scenario.enabled ? "Enabled for learners" : "Unavailable"}
          tone={scenario.enabled ? "success" : "muted"}
        />
        <StatusDefinition
          label="Source"
          value={sourceValue}
          tone={
            sourceLoading || sourceUnavailable
              ? "muted"
              : source?.status === "draft"
                ? "warning"
                : "default"
          }
        />
        <StatusDefinition
          label="Latest build"
          value={buildValue}
          tone={buildTone(latestBuild?.status, buildLoading || buildUnavailable)}
        />
      </dl>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <div><dt className="text-eyebrow">Inventory</dt><dd className="mt-0.5 tabular-nums">{scenario.vmCount} VM · {scenario.probeCount} probes</dd></div>
        <div><dt className="text-eyebrow">Guidance</dt><dd className="mt-0.5 tabular-nums">{scenario.scenarioHintCount} hints · ~{scenario.estimatedMinutes} min</dd></div>
        <div className="col-span-2"><dt className="text-eyebrow">Updated</dt><dd className="mt-0.5 text-metadata">{formatRelativeTime(scenario.updatedAt)}</dd></div>
      </dl>

      <div className="flex shrink-0 flex-wrap items-center gap-2 xl:flex-col xl:items-stretch">
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={onToggle}
        >
          {scenario.enabled ? (
            <CircleOff className="size-4" />
          ) : (
            <CircleCheckBig className="size-4" />
          )}
          {pending
            ? "Updating…"
            : scenario.enabled
              ? "Disable scenario"
              : "Enable scenario"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          render={
            <Link
              to="/admin/scenarios/$scenarioId"
              params={{ scenarioId: scenario.scenarioId }}
            />
          }
        >
          Inspect
          <ArrowRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

const BUILD_STATUS_LABELS: Record<ScenarioBuildStatus, string> = {
  queued: "Queued",
  assigned: "Assigned",
  building: "Building",
  succeeded: "Succeeded",
  failed: "Failed",
  stale: "Stale",
};

type StatusTone = "default" | "muted" | "success" | "warning" | "error";

function StatusDefinition({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: StatusTone;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-eyebrow">{label}</dt>
      <dd
        className={cn(
          "mt-1 text-sm font-medium break-words",
          tone === "muted" && "text-muted-foreground",
          tone === "success" && "text-success",
          tone === "warning" && "text-warning",
          tone === "error" && "text-destructive",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function buildTone(
  status: ScenarioBuildStatus | undefined,
  unavailable: boolean,
): StatusTone {
  if (unavailable || !status) return "muted";
  if (status === "succeeded") return "success";
  if (status === "failed") return "error";
  if (status === "building" || status === "stale") return "warning";
  return "default";
}

async function fetchScenarioSources(): Promise<{
  sources: ScenarioSourceSummary[];
}> {
  const response = await fetch("/api/admin/authoring/sources", {
    method: "GET",
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error(`Failed to load source status (${response.status})`);
  }
  return (await response.json()) as { sources: ScenarioSourceSummary[] };
}

async function fetchScenarioBuilds(): Promise<{
  builds: ScenarioBuildSummary[];
}> {
  const response = await fetch("/api/admin/builds", {
    method: "GET",
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error(`Failed to load build status (${response.status})`);
  }
  return (await response.json()) as { builds: ScenarioBuildSummary[] };
}
