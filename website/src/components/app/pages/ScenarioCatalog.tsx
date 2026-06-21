import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Clock3, ShieldCheck } from "lucide-react";
import { EmptyStateCard } from "@/components/app/PagePatterns";
import { SignedInShell } from "@/components/app/SignedInShell";
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

interface ScenarioCatalogEntry {
  scenarioId: string;
  slug: string;
  title: string;
  tagline: string;
  difficulty: "easy" | "medium" | "hard";
  estimatedMinutes: number;
  scenarioName: string;
  enabledAt: number;
  vmCount: number;
}

interface ScenarioCatalogResponse {
  scenarios: ScenarioCatalogEntry[];
}

export function ScenarioCatalog() {
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

  return (
    <SignedInShell title="Scenarios" description="" showHeader={false}>
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

      {!scenarios.isLoading && !(scenarios.data?.scenarios.length ?? 0) ? (
        <EmptyStateCard
          icon={<ShieldCheck className="size-10" />}
          title="No scenarios are enabled yet"
          description="This list will fill once an admin enables a scenario with a scenario briefing and at least one scenario probe."
          className="min-h-[20rem]"
          contentClassName="min-h-[20rem]"
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {(scenarios.data?.scenarios ?? []).map((scenario) => (
            <Card key={scenario.scenarioId}>
              <CardHeader className="gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <DifficultyBadge difficulty={scenario.difficulty} />
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
                  <Button asChild>
                    <Link
                      to="/scenarios/$scenarioId"
                      params={{ scenarioId: scenario.scenarioId }}
                    >
                      Open briefing
                      <ArrowRight className="size-4" />
                    </Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </SignedInShell>
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
