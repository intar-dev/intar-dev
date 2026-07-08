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
  MetaChip,
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  AdminScenarioListResponse,
  AdminScenarioSummary,
} from "@/components/app/admin/hosts/types";

type StateFilter = "enabled" | "disabled" | null;

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
      title="Scenarios"
      description="Inspect uploaded scenarios and control which ones are live for learners."
      meta={
        <>
          <MetaChip>{scenarioList.length} total</MetaChip>
          <MetaChip variant="accent">{enabledCount} enabled</MetaChip>
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
          description="Scenario authoring lives outside the web UI. Upload a scenario through the external pipeline and it appears here with its description, VM inventory, probes, and enabled state."
        />
      ) : (
        <div className="space-y-4">
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
  pending,
  disabled,
  onToggle,
}: {
  scenario: AdminScenarioSummary;
  pending: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const visibleTags = scenario.tags.slice(0, 3);
  const overflowTags = scenario.tags.length - visibleTags.length;

  return (
    <div className="flex flex-col gap-3 py-3.5 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/admin/scenarios/$scenarioId"
            params={{ scenarioId: scenario.scenarioId }}
            className="text-sm font-semibold hover:underline"
          >
            {scenario.title}
          </Link>
          <DifficultyChip difficulty={scenario.difficulty} />
          <Badge variant={scenario.enabled ? "success" : "outline"}>
            {scenario.enabled ? "Enabled" : "Disabled"}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-mono text-xs text-muted-foreground">
            {scenario.scenarioId}
          </p>
          <MetaChip variant="outline">{scenario.category}</MetaChip>
          {visibleTags.map((tag) => (
            <MetaChip key={tag} variant="outline">
              {tag}
            </MetaChip>
          ))}
          {overflowTags > 0 ? (
            <MetaChip variant="outline">+{overflowTags}</MetaChip>
          ) : null}
        </div>
        <p className="text-caption">
          {scenario.vmCount} VMs · {scenario.probeCount} probes ·{" "}
          {scenario.scenarioHintCount} hints · ~{scenario.estimatedMinutes} min
          · updated {formatRelativeTime(scenario.updatedAt)}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
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
          {pending ? "Updating…" : scenario.enabled ? "Disable" : "Enable"}
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
