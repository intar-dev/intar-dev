import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ChevronRight,
  CircleCheckBig,
  CircleOff,
  HardDriveDownload,
  Radar,
} from "lucide-react";
import { PageShell } from "@/components/app/patterns/PageShell";
import { Section } from "@/components/app/patterns/Section";
import { MetaChip } from "@/components/app/patterns/MetaChip";
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from "@/components/app/patterns/StateCard";
import { formatRelativeTime } from "@/components/app/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

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

export function ScenarioRegistry() {
  const queryClient = useQueryClient();

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
          {scenarioList.map((scenario) => {
            const togglePending =
              setEnabled.isPending &&
              setEnabled.variables?.scenarioId === scenario.scenarioId;
            return (
              <div
                key={scenario.scenarioId}
                className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-mono text-sm font-medium">
                      {scenario.scenarioId}
                    </p>
                    <Badge variant={scenario.enabled ? "success" : "outline"}>
                      {scenario.enabled ? "Enabled" : "Disabled"}
                    </Badge>
                    <MetaChip icon={<HardDriveDownload />}>
                      {scenario.vmCount} VM{scenario.vmCount === 1 ? "" : "s"}
                    </MetaChip>
                    <MetaChip icon={<Radar />}>
                      {scenario.probeCount} probe
                      {scenario.probeCount === 1 ? "" : "s"}
                    </MetaChip>
                  </div>
                  <p className="truncate text-sm text-muted-foreground">
                    {scenario.description}
                  </p>
                  <p className="text-caption">
                    Updated {formatRelativeTime(scenario.updatedAt)}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={setEnabled.isPending}
                    onClick={() =>
                      setEnabled.mutate({
                        scenarioId: scenario.scenarioId,
                        enabled: !scenario.enabled,
                      })
                    }
                  >
                    {scenario.enabled ? (
                      <CircleOff className="size-4" />
                    ) : (
                      <CircleCheckBig className="size-4" />
                    )}
                    {togglePending
                      ? "Updating…"
                      : scenario.enabled
                        ? "Disable"
                        : "Enable"}
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
                    <ChevronRight className="size-4" />
                  </Button>
                </div>
              </div>
            );
          })}
        </Section>
      )}
    </PageShell>
  );
}
