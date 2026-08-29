import { type ReactNode, useMemo, useState } from "react";
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
import {
  COLLECTION_PAGE_SIZE,
  PaginatedCollection,
} from "@/components/app/patterns/CollectionPagination";
import { Section } from "@/components/app/patterns/Section";
import {
  MetaDifficulty,
  MetaLine,
  SCENARIO_DIFFICULTIES,
  type ScenarioDifficulty,
} from "@/components/app/patterns/MetaLine";
import { FilterBar, FilterChip } from "@/components/app/patterns/FilterBar";
import { TableSkeleton } from "@/components/app/patterns/Skeletons";
import { EmptyState, ErrorState } from "@/components/app/patterns/StateCard";
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
  const filtersActive = Boolean(
    search.trim() || stateFilter || difficulty || category,
  );

  const clearFilters = () => {
    setSearch("");
    setStateFilter(null);
    setDifficulty(null);
    setCategory(null);
  };

  return (
    <PageShell width="workspace" density="compact">
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
      ) : scenarios.isPending ? (
        <TableSkeleton />
      ) : !scenarioList.length ? (
        <EmptyState
          icon={<HardDriveDownload />}
          title="No scenarios uploaded"
          description="Create and validate a draft in Authoring, or upload one through the external pipeline. Published scenarios appear here with their VM inventory, checks, and learner availability."
        />
      ) : (
        <div className="space-y-4">
          <dl className="grid grid-cols-3 gap-3 border-y py-4 sm:gap-4">
            <div className="min-w-0">
              <dt className="text-label">Total scenarios</dt>
              <dd className="mt-1 text-section-title tabular-nums">
                {scenarioList.length}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-label">Enabled for learners</dt>
              <dd className="mt-1 text-section-title text-success tabular-nums">
                {enabledCount}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-label">Unavailable</dt>
              <dd className="mt-1 text-section-title tabular-nums">
                {scenarioList.length - enabledCount}
              </dd>
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
              Showing {filteredScenarios.length} of {scenarioList.length}{" "}
              scenarios.
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
            >
              {setEnabled.error ? (
                <p className="pb-3 text-sm text-destructive">
                  {setEnabled.error instanceof Error
                    ? setEnabled.error.message
                    : "Failed to update scenario"}
                </p>
              ) : null}
              <PaginatedCollection
                items={filteredScenarios}
                pageSize={COLLECTION_PAGE_SIZE.dense}
                itemLabel="scenarios"
                resetKey={`${search}|${stateFilter ?? ""}|${difficulty ?? ""}|${category ?? ""}`}
              >
                {(visibleScenarios) => (
                  <div className="divide-y">
                    {visibleScenarios.map((scenario) => (
                      <ScenarioRegistryRow
                        key={scenario.scenarioId}
                        scenario={scenario}
                        source={
                          sourceByScenarioId.get(scenario.scenarioId) ?? null
                        }
                        sourceLoading={sources.isLoading}
                        sourceUnavailable={Boolean(
                          sources.error && !sources.data,
                        )}
                        latestBuild={
                          latestBuildByScenarioId.get(scenario.scenarioId) ??
                          null
                        }
                        buildLoading={builds.isLoading}
                        buildUnavailable={Boolean(builds.error && !builds.data)}
                        pending={
                          setEnabled.isPending &&
                          setEnabled.variables?.scenarioId ===
                            scenario.scenarioId
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
                  </div>
                )}
              </PaginatedCollection>
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
    <div className="grid gap-4 py-4 first:pt-0 last:pb-0 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
      <div className="min-w-0 space-y-3">
        <h3>
          <Link
            to="/admin/scenarios/$scenarioId"
            params={{ scenarioId: scenario.scenarioId }}
            className="inline-flex min-h-11 items-center text-sm font-semibold hover:underline sm:min-h-9"
          >
            {scenario.title}
          </Link>
        </h3>
        <MetaLine
          items={[
            scenario.scenarioId,
            <MetaDifficulty
              key="difficulty"
              difficulty={scenario.difficulty}
            />,
            scenario.category,
            scenario.tags.length ? scenario.tags.join(", ") : null,
          ]}
        />

        <dl
          className="grid grid-cols-2 gap-x-4 gap-y-3 border-t pt-3 text-sm lg:grid-cols-4 lg:gap-x-6"
          aria-label={`${scenario.title} details`}
        >
          <RegistryFact
            label="Availability"
            value={scenario.enabled ? "Enabled for learners" : "Unavailable"}
            tone={scenario.enabled ? "success" : "muted"}
          />
          <RegistryFact
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
          <RegistryFact
            label="Latest build"
            value={buildValue}
            tone={buildTone(
              latestBuild?.status,
              buildLoading || buildUnavailable,
            )}
          />
          <RegistryFact
            label="Updated"
            value={formatRelativeTime(scenario.updatedAt)}
            tone="muted"
          />
          <RegistryFact
            label="Inventory"
            value={`${scenario.vmCount} VM · ${scenario.probeCount} probes`}
          />
          <RegistryFact
            label="Guidance"
            value={`${scenario.scenarioHintCount} hints · ~${scenario.estimatedMinutes} min`}
          />
          <RegistryFact
            className="col-span-2"
            label="Resources"
            value={
              <span className="flex flex-wrap gap-x-3 gap-y-1 tabular-nums">
                {formatScenarioResourceItems(scenario.requiredResources).map(
                  (resource) => (
                    <span key={resource}>{resource}</span>
                  ),
                )}
              </span>
            }
          />
        </dl>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 lg:flex-col lg:items-stretch">
        <Button
          size="sm"
          variant="outline"
          className="min-h-11 lg:min-h-9 lg:w-full"
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
          className="min-h-11 lg:min-h-9 lg:w-full"
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

export function formatScenarioResourceItems(
  resources: AdminScenarioSummary["requiredResources"],
): string[] {
  return [
    `${formatCpu(resources.cpuMillis)} CPU`,
    `${resources.vcpuCount.toLocaleString()} vCPU`,
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

const BUILD_STATUS_LABELS: Record<ScenarioBuildStatus, string> = {
  queued: "Queued",
  assigned: "Assigned",
  building: "Building",
  succeeded: "Succeeded",
  failed: "Failed",
  stale: "Stale",
};

type FactTone = "default" | "muted" | "success" | "warning" | "error";

function RegistryFact({
  label,
  value,
  tone,
  className,
}: {
  label: string;
  value: ReactNode;
  tone?: FactTone;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-label">{label}</dt>
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
): FactTone {
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
