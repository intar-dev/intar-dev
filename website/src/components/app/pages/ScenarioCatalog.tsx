import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Clock3, Search, ShieldCheck } from "lucide-react";
import { EmptyStateCard } from "@/components/app/PagePatterns";
import { PageShell } from "@/components/app/patterns/PageShell";
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
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type ScenarioDifficulty = "easy" | "medium" | "hard";

interface ScenarioCatalogEntry {
  scenarioId: string;
  slug: string;
  title: string;
  tagline: string;
  difficulty: ScenarioDifficulty;
  estimatedMinutes: number;
  tags: string[];
  scenarioName: string;
  enabledAt: number;
  vmCount: number;
}

interface ScenarioCatalogResponse {
  scenarios: ScenarioCatalogEntry[];
}

const DIFFICULTIES: ScenarioDifficulty[] = ["easy", "medium", "hard"];

export function ScenarioCatalog() {
  const [search, setSearch] = useState("");
  const [difficulty, setDifficulty] = useState<ScenarioDifficulty | null>(null);
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

  const allEntries = scenarios.data?.scenarios ?? [];

  const allTags = useMemo(
    () =>
      [...new Set(allEntries.flatMap((scenario) => scenario.tags))].sort(),
    [allEntries],
  );

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return allEntries.filter((scenario) => {
      if (difficulty && scenario.difficulty !== difficulty) return false;
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
  }, [allEntries, difficulty, search, selectedTags]);

  const toggleTag = (tag: string) => {
    setSelectedTags((current) =>
      current.includes(tag)
        ? current.filter((entry) => entry !== tag)
        : [...current, tag],
    );
  };

  const filtersActive = Boolean(search.trim() || difficulty || selectedTags.length);

  return (
    <PageShell title="Scenarios" description="" showHeader={false}>
      <h1 className="text-3xl font-semibold tracking-tight">Scenarios</h1>

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

      {allEntries.length ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-56 flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search scenarios…"
                className="pl-8"
                aria-label="Search scenarios"
              />
            </div>
            <div className="flex items-center gap-1">
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
          </div>
          {allTags.length ? (
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

      {!scenarios.isLoading && !allEntries.length ? (
        <EmptyStateCard
          icon={<ShieldCheck className="size-10" />}
          title="No scenarios are enabled yet"
          description="This list will fill once an admin enables a scenario with a scenario briefing and at least one scenario probe."
          className="min-h-[20rem]"
          contentClassName="min-h-[20rem]"
        />
      ) : !scenarios.isLoading && !filtered.length ? (
        <EmptyStateCard
          icon={<Search className="size-10" />}
          title="No scenarios match your filters"
          description="Try a different search term or clear the difficulty/tag filters."
          className="min-h-[16rem]"
          contentClassName="min-h-[16rem]"
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {filtered.map((scenario) => (
            <Card key={scenario.scenarioId}>
              <CardHeader className="gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <DifficultyBadge difficulty={scenario.difficulty} />
                  {scenario.tags.map((tag) => (
                    <Badge key={tag} variant="outline">
                      {tag}
                    </Badge>
                  ))}
                </div>
                <div className="space-y-2">
                  <CardTitle className="text-xl">{scenario.title}</CardTitle>
                  <CardDescription className="leading-6">
                    {scenario.tagline}
                  </CardDescription>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <dl className="grid gap-4 sm:grid-cols-2">
                  <ScenarioMeta
                    icon={<Clock3 className="size-4" />}
                    label="Estimate"
                    value={`${scenario.estimatedMinutes} min`}
                  />
                  <ScenarioMeta
                    icon={<ShieldCheck className="size-4" />}
                    label="Machines"
                    value={`${scenario.vmCount}`}
                  />
                </dl>

                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm text-muted-foreground">
                    Enabled {formatRelativeDate(scenario.enabledAt)}
                  </p>
                  <Button
                    render={
                      <Link
                        to="/scenarios/$scenarioId"
                        params={{ scenarioId: scenario.scenarioId }}
                      />
                    }
                  >
                    Open briefing
                    <ArrowRight className="size-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {filtersActive && filtered.length ? (
        <p className="text-xs text-muted-foreground">
          Showing {filtered.length} of {allEntries.length} scenarios.
        </p>
      ) : null}
    </PageShell>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full border px-2.5 py-1 text-xs font-medium capitalize transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "bg-background text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function ScenarioMeta(props: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="space-y-1">
      <dt className="flex items-center gap-2 text-sm text-muted-foreground">
        {props.icon}
        {props.label}
      </dt>
      <dd className="text-base font-medium">{props.value}</dd>
    </div>
  );
}

function DifficultyBadge(props: {
  difficulty: ScenarioCatalogEntry["difficulty"];
}) {
  if (props.difficulty === "hard") {
    return <Badge variant="destructive">Hard</Badge>;
  }

  if (props.difficulty === "easy") {
    return <Badge variant="secondary">Easy</Badge>;
  }

  return <Badge variant="outline">Medium</Badge>;
}

function formatRelativeDate(value: number) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(value);
}
