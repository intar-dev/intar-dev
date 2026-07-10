import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  ArrowRight,
  CircleDot,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Users,
} from "lucide-react";
import { PageShell } from "@/components/app/patterns/PageShell";
import { EmptyState } from "@/components/app/patterns/StateCard";
import { FilterBar, FilterChip } from "@/components/app/patterns/FilterBar";
import { ScenarioCard } from "@/components/app/patterns/ScenarioCard";
import { SCENARIO_DIFFICULTIES } from "@/components/app/patterns/MetaChip";
import { useMyRuns } from "@/components/app/hooks/useMyRuns";
import {
  CATALOG_SORT_COMPARATORS,
  CATALOG_SORT_OPTIONS,
  compactCatalogSearch,
  normalizeCatalogSearch,
  type CatalogSort,
  type NormalizedCatalogSearch,
} from "./catalog-search";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { ScenarioCatalogWireEntry } from "@/lib/scenario-runs";

interface ScenarioCatalogResponse {
  scenarios: ScenarioCatalogWireEntry[];
}

interface MyAssignmentsResponse {
  assignments: Array<{
    assignmentId: string;
    scenarioId: string;
    scenarioTitle: string | null;
    teamId: string;
    teamName: string;
    assignedAt: number;
  }>;
}

export function ScenarioCatalog() {
  const routeSearch = useSearch({ from: "/app/scenarios" });
  const searchState = useMemo(
    () => normalizeCatalogSearch(routeSearch),
    [routeSearch],
  );
  const navigate = useNavigate();
  const [searchText, setSearchText] = useState(searchState.q);

  const scenarios = useQuery({
    queryKey: ["scenarios", "list"],
    queryFn: async () => {
      const response = await fetch("/api/scenarios", {
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

      return (await response.json()) as ScenarioCatalogResponse;
    },
    staleTime: 10_000,
  });

  const myAssignments = useQuery({
    queryKey: ["teams", "my-assignments"],
    queryFn: async () => {
      const response = await fetch("/api/teams/my-assignments", {
        method: "GET",
        credentials: "include",
      });
      if (!response.ok) {
        return { assignments: [] } satisfies MyAssignmentsResponse;
      }
      return (await response.json()) as MyAssignmentsResponse;
    },
    staleTime: 30_000,
  });

  const myRuns = useMyRuns();
  const activeRuns = (myRuns.data?.runs ?? []).filter((run) => run.active);

  const allEntries = scenarios.data?.scenarios ?? [];
  const assignments = myAssignments.data?.assignments ?? [];

  const allTags = useMemo(
    () => [...new Set(allEntries.flatMap((scenario) => scenario.tags))].sort(),
    [allEntries],
  );

  const allCategories = useMemo(
    () =>
      [
        ...new Set(
          allEntries
            .map((scenario) => scenario.category)
            .filter((value) => value.trim()),
        ),
      ].sort(),
    [allEntries],
  );

  useEffect(() => {
    setSearchText((current) =>
      current.trim() === searchState.q ? current : searchState.q,
    );
  }, [searchState.q]);

  useEffect(() => {
    const nextQuery = searchText.trim();
    if (nextQuery === searchState.q) return;
    const timeout = window.setTimeout(() => {
      void navigateCatalogSearch(navigate, {
        ...searchState,
        q: nextQuery,
      });
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [navigate, searchState, searchText]);

  const filtered = useMemo(() => {
    const needle = searchState.q.toLowerCase();
    const filteredEntries = allEntries.filter((scenario) => {
      if (searchState.difficulty && scenario.difficulty !== searchState.difficulty) {
        return false;
      }
      if (searchState.category && scenario.category !== searchState.category) {
        return false;
      }
      if (
        searchState.tags.length &&
        !searchState.tags.every((tag) => scenario.tags.includes(tag))
      ) {
        return false;
      }
      if (!needle) return true;
      return (
        scenario.title.toLowerCase().includes(needle) ||
        scenario.tagline.toLowerCase().includes(needle) ||
        scenario.category.toLowerCase().includes(needle) ||
        scenario.tags.some((tag) => tag.toLowerCase().includes(needle))
      );
    });

    return filteredEntries.sort(CATALOG_SORT_COMPARATORS[searchState.sort]);
  }, [allEntries, searchState]);

  const toggleTag = (tag: string) => {
    const nextTags = searchState.tags.includes(tag)
      ? searchState.tags.filter((entry) => entry !== tag)
      : [...searchState.tags, tag].sort();
    void navigateCatalogSearch(navigate, { ...searchState, tags: nextTags });
  };

  const filtersActive = Boolean(
    searchState.q ||
      searchState.difficulty ||
      searchState.category ||
      searchState.tags.length,
  );

  const clearFilters = () => {
    setSearchText("");
    void navigateCatalogSearch(navigate, {
      q: "",
      difficulty: undefined,
      category: undefined,
      tags: [],
      sort: searchState.sort,
    });
  };

  const renderFilterControls = () => (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-metadata mr-1">Difficulty</span>
        {SCENARIO_DIFFICULTIES.map((level) => (
          <FilterChip
            key={level}
            active={searchState.difficulty === level}
            onClick={() =>
              void navigateCatalogSearch(navigate, {
                ...searchState,
                difficulty:
                  searchState.difficulty === level ? undefined : level,
              })
            }
          >
            {level}
          </FilterChip>
        ))}
      </div>
      {allCategories.length ? (
        <Select
          value={searchState.category ?? "all"}
          onValueChange={(value) =>
            void navigateCatalogSearch(navigate, {
              ...searchState,
              category:
                typeof value === "string" && value !== "all"
                  ? value
                  : undefined,
            })
          }
        >
          <SelectTrigger size="sm" aria-label="Filter by category">
            Category: {searchState.category ?? "All"}
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {allCategories.map((entry) => (
              <SelectItem key={entry} value={entry}>
                {entry}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      {allTags.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label="Filter by tags"
                />
              }
            >
              Tags
              {searchState.tags.length ? ` · ${searchState.tags.length}` : ""}
            </DropdownMenuTrigger>
            <DropdownMenuContent className="max-h-72 min-w-48">
              {allTags.map((tag) => (
                <DropdownMenuCheckboxItem
                  key={tag}
                  checked={searchState.tags.includes(tag)}
                  onCheckedChange={() => toggleTag(tag)}
                >
                  {tag}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {searchState.tags.map((tag) => (
            <FilterChip
              key={tag}
              active
              onClick={() => toggleTag(tag)}
              className="normal-case"
            >
              {tag}
            </FilterChip>
          ))}
        </div>
      ) : null}
    </>
  );

  return (
    <PageShell
      title="Scenarios"
      eyebrow="Learn"
      description="Choose a live system, read the work order, and make the repair."
      width="default"
      density="comfortable"
    >
      {scenarios.error ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load scenarios</AlertTitle>
          <AlertDescription>
            {scenarios.error instanceof Error
              ? scenarios.error.message
              : "Failed to load scenarios"}
          </AlertDescription>
        </Alert>
      ) : null}

      {activeRuns.length ? (
        <section className="space-y-4" aria-labelledby="active-work-heading">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <p className="text-eyebrow">Continue</p>
              <h2 id="active-work-heading" className="mt-2 text-section-title">
                Active work
              </h2>
            </div>
            <Link
              to="/runs"
              className="inline-flex min-h-11 items-center text-sm font-semibold text-brand-text underline-offset-4 hover:underline"
            >
              View all runs
            </Link>
          </div>
          <div className="divide-y rounded-xl border bg-card">
            {activeRuns.map((run) => (
              <Link
                key={run.runId}
                to="/runs/$runId"
                params={{ runId: run.runId }}
                className="group flex min-h-20 items-center gap-4 px-4 py-3 transition-colors hover:bg-brand-subtle sm:px-6"
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-subtle text-brand-text">
                  <CircleDot className="size-4 motion-safe:animate-pulse" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-card-title text-balance">
                    {run.title}
                  </span>
                  <span className="text-metadata">
                    Repair in progress · resume the live shell
                  </span>
                </span>
                <span className="hidden text-sm font-semibold text-brand-text sm:inline">
                  Resume
                </span>
                <ArrowRight className="size-4 text-brand-text transition-transform group-hover:translate-x-0.5" />
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {assignments.length ? (
        <section className="space-y-4" aria-labelledby="assignments-heading">
          <div>
            <p className="text-eyebrow">From your teams</p>
            <h2 id="assignments-heading" className="mt-2 text-section-title">
              Assignments
            </h2>
          </div>
          <div className="divide-y border-y">
            {assignments.map((assignment) => (
              <Link
                key={assignment.assignmentId}
                to="/scenarios/$scenarioId"
                params={{ scenarioId: assignment.scenarioId }}
                className="group flex min-h-16 items-center gap-4 px-1 py-3 transition-colors hover:bg-muted/60 sm:px-3"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
                  <Users className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-balance">
                    {assignment.scenarioTitle ?? assignment.scenarioId}
                  </span>
                  <span className="text-metadata">
                    Assigned by {assignment.teamName}
                  </span>
                </span>
                <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {allEntries.length ? (
        <section className="space-y-4" aria-labelledby="catalog-heading">
          <div>
            <p className="text-eyebrow">Workshop catalog</p>
            <h2 id="catalog-heading" className="mt-2 text-section-title">
              Choose the next system
            </h2>
          </div>
          <FilterBar
            search={searchText}
            onSearchChange={setSearchText}
            searchPlaceholder="Search scenarios…"
            searchLabel="Search scenarios"
            filtersActive={filtersActive}
            onClear={clearFilters}
            end={
              <>
                <span className="text-metadata tabular-nums">
                  {filtered.length} of {allEntries.length}
                </span>
                <SortSelect
                  value={searchState.sort}
                  onChange={(sort) =>
                    void navigateCatalogSearch(navigate, {
                      ...searchState,
                      sort,
                    })
                  }
                />
              </>
            }
          >
            <div className="hidden flex-wrap items-center gap-3 md:flex">
              {renderFilterControls()}
            </div>
          </FilterBar>
          <details className="rounded-lg border bg-card md:hidden">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 py-2 text-sm font-semibold marker:hidden">
              <SlidersHorizontal className="size-4" />
              Refine results
              {filtersActive ? (
                <span className="ml-auto text-brand-text">Filters active</span>
              ) : null}
            </summary>
            <div className="flex flex-col items-start gap-4 border-t p-4">
              {renderFilterControls()}
            </div>
          </details>
        </section>
      ) : null}

      {scenarios.error ? null : scenarios.isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-52 rounded-xl" />
          ))}
        </div>
      ) : !allEntries.length ? (
        <EmptyState
          icon={<ShieldCheck />}
          title="No scenarios are enabled yet"
          description="This list will fill once an admin enables a scenario with a briefing and at least one probe."
        />
      ) : !filtered.length ? (
        <EmptyState
          icon={<Search />}
          title="No scenarios match your filters"
          description="Try a different search term, or clear the filters to see everything."
          action={
            <Button variant="outline" onClick={clearFilters}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((scenario) => (
            <ScenarioCard key={scenario.scenarioId} scenario={scenario} />
          ))}
        </div>
      )}
    </PageShell>
  );
}

function SortSelect({
  value,
  onChange,
}: {
  value: CatalogSort;
  onChange: (value: CatalogSort) => void;
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as CatalogSort)}>
      <SelectTrigger size="sm" aria-label="Sort scenarios">
        Sort: {CATALOG_SORT_OPTIONS.find((option) => option.value === value)?.label}
      </SelectTrigger>
      <SelectContent align="end">
        {CATALOG_SORT_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function navigateCatalogSearch(
  navigate: ReturnType<typeof useNavigate>,
  next: NormalizedCatalogSearch,
) {
  return navigate({
    to: ".",
    replace: true,
    search: compactCatalogSearch(next),
  });
}
