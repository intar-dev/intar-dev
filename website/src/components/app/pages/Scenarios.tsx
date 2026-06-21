import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ChevronRight,
  FolderKanban,
  HardDriveDownload,
  Radar,
} from "lucide-react";
import { AuthenticatedShell } from "@/components/app/AuthenticatedShell";
import { EmptyStateCard } from "@/components/app/PagePatterns";
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

interface ScenarioSummary {
  scenarioId: string;
  description: string;
  probeCount: number;
  vmCount: number;
  enabled: boolean;
  enabledAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface ScenarioListResponse {
  scenarios: ScenarioSummary[];
}

export function Scenarios() {
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

      return (await response.json()) as ScenarioListResponse;
    },
    staleTime: 10_000,
  });

  const scenarioList = scenarios.data?.scenarios ?? [];
  const enabledCount = scenarioList.filter((scenario) => scenario.enabled).length;

  return (
    <AuthenticatedShell
      title="Scenarios"
      description="Read-only registry of uploaded scenarios. The web UI no longer edits scenario content; it only lets you inspect the current stored scenario and enable or disable it for learners."
    >
      <Card className="overflow-hidden">
        <CardHeader className="border-b border-border/70 bg-muted/30">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-2">
              <CardTitle className="text-lg">Scenario registry</CardTitle>
              <CardDescription className="max-w-3xl leading-6">
                Each uploaded scenario is keyed by its stable scenario ID. New
                uploads replace the current stored scenario for that scenario
                ID, while scenario runs keep their own launch-time state.
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">{scenarioList.length} total</Badge>
              <Badge variant="secondary">{enabledCount} enabled</Badge>
              <Badge variant="outline">
                {scenarioList.length - enabledCount} disabled
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 pt-6">
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

          {!scenarios.isLoading && !scenarioList.length ? (
            <EmptyStateCard
              icon={<HardDriveDownload className="size-10" />}
              title="No scenarios uploaded"
              description="Upload a valid scenario through the external scenario pipeline. Once it lands, it appears here with its current description, VM inventory, probes, and enabled state."
            />
          ) : (
            <div className="space-y-3">
              {scenarioList.map((scenario) => (
                <article
                  key={scenario.scenarioId}
                  className="grid gap-4 rounded-2xl border border-border/70 bg-card/70 p-4 transition-colors hover:border-foreground/20 lg:grid-cols-[minmax(0,1fr)_auto]"
                >
                  <div className="min-w-0 space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-base font-semibold tracking-tight">
                        {scenario.scenarioId}
                      </p>
                      <Badge
                        variant={scenario.enabled ? "secondary" : "outline"}
                      >
                        {scenario.enabled ? "Enabled" : "Disabled"}
                      </Badge>
                      <Badge variant="outline">
                        {scenario.vmCount} VM
                        {scenario.vmCount === 1 ? "" : "s"}
                      </Badge>
                    </div>

                    <p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                      {scenario.description}
                    </p>

                    <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground">
                      <span className="inline-flex items-center gap-2">
                        <HardDriveDownload className="size-4" />
                        {scenario.vmCount} VM
                        {scenario.vmCount === 1 ? "" : "s"}
                      </span>
                      <span className="inline-flex items-center gap-2">
                        <Radar className="size-4" />
                        {scenario.probeCount} probe
                        {scenario.probeCount === 1 ? "" : "s"}
                      </span>
                      <span>
                        Updated {formatDateTime(scenario.updatedAt)}
                      </span>
                      <span>
                        {scenario.enabledAt
                          ? `Enabled ${formatDateTime(scenario.enabledAt)}`
                          : "Not enabled for learners"}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center">
                    <Button asChild variant="outline">
                      <Link
                        to="/admin/scenarios/$scenarioId"
                        params={{ scenarioId: scenario.scenarioId }}
                      >
                        Inspect
                        <ChevronRight className="size-4" />
                      </Link>
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {!scenarioList.length && !scenarios.isLoading ? (
        <Card className="border-dashed">
          <CardContent className="flex min-h-[20rem] flex-col items-center justify-center gap-3 px-6 py-10 text-center">
            <FolderKanban className="size-10 text-muted-foreground" />
            <div className="space-y-2">
              <p className="text-lg font-semibold">Upload-driven workflow</p>
              <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                Scenario authoring lives outside the web UI now. This surface is
                intentionally narrow: inspect the current stored scenario and
                decide whether it should be live for learners.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </AuthenticatedShell>
  );
}

function formatDateTime(value: number | null | undefined) {
  if (!value) {
    return "Unknown";
  }

  return new Date(value).toLocaleString();
}
