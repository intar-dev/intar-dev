import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, CircleDot, Search, ShieldCheck, Users } from "lucide-react";
import { PageShell } from "@/components/app/patterns/PageShell";
import { EmptyState } from "@/components/app/patterns/StateCard";
import { FilterBar, FilterChip } from "@/components/app/patterns/FilterBar";
import {
  ScenarioCard,
  type ScenarioCardData,
} from "@/components/app/patterns/ScenarioCard";
import type { ScenarioDifficulty } from "@/components/app/patterns/MetaChip";
import { useMyRuns } from "@/components/app/hooks/useMyRuns";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

interface ScenarioCatalogEntry extends ScenarioCardData {
  slug: string;
  category: string;
  scenarioName: string;
  enabledAt: number;
}

interface ScenarioCatalogResponse {
  scenarios: ScenarioCatalogEntry[];
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

const DIFFICULTIES: ScenarioDifficulty[] = ["easy", "medium", "hard"];

export function ScenarioCatalog() {
  const [search, setSearch] = useState("");
  const [difficulty, setDifficulty] = useState<ScenarioDifficulty | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

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

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return allEntries.filter((scenario) => {
      if (difficulty && scenario.difficulty !== difficulty) return false;
      if (category && scenario.category !== category) return false;
      if (
        selectedTags.length &&
        !selectedTags.every((tag) => scenario.tags.includes(tag))
      ) {
        return false;
      }
      if (!needle) return true;
      return (
        scenario.title.toLowerCase().includes(needle) ||
        scenario.tagline.toLowerCase().includes(needle) ||
        scenario.tags.some((tag) => tag.toLowerCase().includes(needle))
      );
    });
  }, [allEntries, category, difficulty, search, selectedTags]);

  const toggleTag = (tag: string) => {
    setSelectedTags((current) =>
      current.includes(tag)
        ? current.filter((entry) => entry !== tag)
        : [...current, tag],
    );
  };

  const filtersActive = Boolean(
    search.trim() || difficulty || category || selectedTags.length,
  );

  const clearFilters = () => {
    setSearch("");
    setDifficulty(null);
    setCategory(null);
    setSelectedTags([]);
  };

  return (
    <PageShell
      title="Scenarios"
      description="Real broken systems. Pick one and go fix it."
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

      {activeRuns.length || assignments.length ? (
        <section className="space-y-3">
          <h2 className="text-eyebrow">Continue</h2>
          <div className="grid gap-3 lg:grid-cols-2">
            {activeRuns.map((run) => (
              <Link
                key={run.runId}
                to="/runs/$runId"
                params={{ runId: run.runId }}
                className="group flex items-center gap-4 rounded-2xl border border-primary/30 bg-primary/5 p-4 shadow-xs transition-colors hover:border-primary/50"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
                  <CircleDot className="size-4.5 motion-safe:animate-pulse" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">
                    {run.title}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Run in progress — jump back in
                  </span>
                </span>
                <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </Link>
            ))}
            {assignments.map((assignment) => (
              <Link
                key={assignment.assignmentId}
                to="/scenarios/$scenarioId"
                params={{ scenarioId: assignment.scenarioId }}
                className="group flex items-center gap-4 rounded-2xl border bg-card p-4 shadow-xs transition-colors hover:border-primary/40"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-secondary text-secondary-foreground">
                  <Users className="size-4.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">
                    {assignment.scenarioTitle ?? assignment.scenarioId}
                  </span>
                  <span className="text-xs text-muted-foreground">
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
        <div className="space-y-3">
          <FilterBar
            search={search}
            onSearchChange={setSearch}
            searchPlaceholder="Search scenarios…"
            searchLabel="Search scenarios"
            filtersActive={filtersActive}
            onClear={clearFilters}
          >
            <div className="flex items-center gap-1.5">
              {DIFFICULTIES.map((level) => (
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
            {allCategories.length ? (
              <div className="flex items-center gap-1.5">
                {allCategories.map((entry) => (
                  <FilterChip
                    key={entry}
                    active={category === entry}
                    onClick={() =>
                      setCategory((current) =>
                        current === entry ? null : entry,
                      )
                    }
                  >
                    {entry}
                  </FilterChip>
                ))}
              </div>
            ) : null}
          </FilterBar>
          {allTags.length > 1 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {allTags.map((tag) => (
                <FilterChip
                  key={tag}
                  active={selectedTags.includes(tag)}
                  onClick={() => toggleTag(tag)}
                >
                  {tag}
                </FilterChip>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {scenarios.error ? null : scenarios.isLoading ? (
        <div className="grid gap-6 lg:grid-cols-2 2xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-52 rounded-2xl" />
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
        <div className="grid gap-6 lg:grid-cols-2 2xl:grid-cols-3">
          {filtered.map((scenario) => (
            <ScenarioCard key={scenario.scenarioId} scenario={scenario} />
          ))}
        </div>
      )}

      {filtersActive && filtered.length ? (
        <p className="text-caption">
          Showing {filtered.length} of {allEntries.length} scenarios.
        </p>
      ) : null}
    </PageShell>
  );
}
