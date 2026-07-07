import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { isScenarioLaunchHost } from "@/lib/scenario-hosts";
import type {
  AdminScenarioDetailResponse,
  AdminScenarioSummary,
  AgentHostApi,
} from "./types";

export function HostScenarioLaunchPanel(props: {
  host: AgentHostApi;
  selectedScenarioId: string;
  selectedScenario: AdminScenarioSummary | null;
  scenarios: AdminScenarioSummary[];
  onScenarioChange: (scenarioId: string) => void;
  onLaunch: () => void;
  isLaunching: boolean;
}) {
  const scenarioDetail = useQuery({
    queryKey: ["admin-scenarios", "detail", props.selectedScenarioId],
    enabled: Boolean(props.selectedScenarioId),
    queryFn: async () => {
      const response = await fetch(
        `/api/admin/scenarios/${encodeURIComponent(props.selectedScenarioId)}`,
        {
          method: "GET",
          credentials: "include",
        },
      );

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          body?.error ?? `Failed to load scenario (${response.status})`,
        );
      }

      return (await response.json()) as AdminScenarioDetailResponse;
    },
    staleTime: 10_000,
  });

  const launchVm = scenarioDetail.data?.scenario.vms[0] ?? null;
  const isHostOnline = Boolean(props.host.status?.connected);
  const canLaunchScenarios = isScenarioLaunchHost(props.host);
  const launchDisabled =
    props.host.disabled ||
    !canLaunchScenarios ||
    !isHostOnline ||
    !props.selectedScenarioId ||
    props.isLaunching ||
    !props.scenarios.length;

  return (
    <div className="space-y-4">
      {props.scenarios.length ? (
        <div className="space-y-4">
          <Select
            value={props.selectedScenarioId}
            onValueChange={(value) => {
              if (value) props.onScenarioChange(value);
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select scenario" />
            </SelectTrigger>
            <SelectContent>
              {props.scenarios.map((scenario) => (
                <SelectItem
                  key={scenario.scenarioId}
                  value={scenario.scenarioId}
                >
                  {scenario.scenarioId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {props.selectedScenario ? (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <Badge
                  variant={
                    props.selectedScenario.enabled ? "secondary" : "outline"
                  }
                >
                  {props.selectedScenario.enabled ? "Enabled" : "Draft"}
                </Badge>
                <Badge variant="outline">
                  {props.selectedScenario.vmCount} VM
                  {props.selectedScenario.vmCount === 1 ? "" : "s"}
                </Badge>
                <Badge variant="outline">
                  {props.selectedScenario.probeCount} probe
                  {props.selectedScenario.probeCount === 1 ? "" : "s"}
                </Badge>
              </div>

              <p className="text-sm leading-6 text-muted-foreground">
                {props.selectedScenario.description}
              </p>

              {launchVm ? (
                <div className="rounded-xl bg-muted/40 px-4 py-3">
                  <p className="text-eyebrow">Launch target</p>
                  <p className="mt-2 text-sm font-medium">{launchVm.name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {launchVm.cpu} vCPU · {launchVm.memoryMib} MiB ·{" "}
                    {launchVm.diskMib} MiB
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}

          {scenarioDetail.error ? (
            <div className="rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              {scenarioDetail.error instanceof Error
                ? scenarioDetail.error.message
                : "Failed to load scenario detail"}
            </div>
          ) : null}

          {!isHostOnline ? (
            <div className="rounded-xl bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
              Host must be online to queue a scenario.
            </div>
          ) : null}

          {!canLaunchScenarios ? (
            <div className="rounded-xl bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
              This host is reserved for image builds.
            </div>
          ) : null}

          <Button
            type="button"
            onClick={props.onLaunch}
            disabled={launchDisabled}
            className="w-full"
          >
            {props.isLaunching ? "Queueing..." : "Run scenario"}
          </Button>
        </div>
      ) : (
        <div className="rounded-xl bg-muted/40 px-4 py-8 text-center text-sm text-muted-foreground">
          No scenarios available.
        </div>
      )}
    </div>
  );
}
