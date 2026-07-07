import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  ArrowLeft,
  CircleCheckBig,
  CircleOff,
  FileText,
  HardDriveDownload,
  Microchip,
  Radar,
} from "lucide-react";
import { AuthenticatedShell } from "@/components/app/AuthenticatedShell";
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
import type { ScenarioProbeRecord } from "@/lib/scenario-model";

interface ScenarioRecord {
  scenarioId: string;
  description: string;
  probeCount: number;
  vmCount: number;
  enabled: boolean;
  enabledAt: number | null;
  createdAt: number;
  updatedAt: number;
  probes: ScenarioProbeRecord[];
  vms: Array<{
    id: string;
    ordinal: number;
    name: string;
    image: string;
    cpu: number;
    memoryMib: number;
    diskMib: number;
  }>;
}

interface ScenarioDetailResponse {
  scenario: ScenarioRecord;
}

export function ScenarioDetails() {
  const { scenarioId } = useParams({ from: "/admin/scenarios/$scenarioId" });
  const queryClient = useQueryClient();

  const scenario = useQuery({
    queryKey: ["admin-scenarios", "detail", scenarioId],
    queryFn: async () => {
      const response = await fetch(
        `/api/admin/scenarios/${encodeURIComponent(scenarioId)}`,
        {
          method: "GET",
          credentials: "include",
        },
      );

      const body = (await response.json().catch(() => null)) as
        | ScenarioDetailResponse
        | { error?: string }
        | null;

      if (!response.ok || !body || !("scenario" in body)) {
        throw new Error(
          body && "error" in body && typeof body.error === "string"
            ? body.error
            : `Failed to load scenario (${response.status})`,
        );
      }

      return body.scenario;
    },
    staleTime: 5_000,
  });

  const enableScenario = useMutation({
    mutationFn: async () => {
      const response = await fetch(
        `/api/admin/scenarios/${encodeURIComponent(scenarioId)}/enabled`,
        {
          method: "POST",
          credentials: "include",
        },
      );

      const body = (await response.json().catch(() => null)) as
        | ScenarioDetailResponse
        | { error?: string }
        | null;

      if (!response.ok || !body || !("scenario" in body)) {
        throw new Error(
          body && "error" in body && typeof body.error === "string"
            ? body.error
            : "Failed to enable scenario",
        );
      }

      return body.scenario;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin-scenarios"] }),
        queryClient.invalidateQueries({
          queryKey: ["admin-scenarios", "detail", scenarioId],
        }),
        queryClient.invalidateQueries({ queryKey: ["scenarios"] }),
      ]);
    },
  });

  const disableScenario = useMutation({
    mutationFn: async () => {
      const response = await fetch(
        `/api/admin/scenarios/${encodeURIComponent(scenarioId)}/enabled`,
        {
          method: "DELETE",
          credentials: "include",
        },
      );

      const body = (await response.json().catch(() => null)) as
        | ScenarioDetailResponse
        | { error?: string }
        | null;

      if (!response.ok || !body || !("scenario" in body)) {
        throw new Error(
          body && "error" in body && typeof body.error === "string"
            ? body.error
            : "Failed to disable scenario",
        );
      }

      return body.scenario;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin-scenarios"] }),
        queryClient.invalidateQueries({
          queryKey: ["admin-scenarios", "detail", scenarioId],
        }),
        queryClient.invalidateQueries({ queryKey: ["scenarios"] }),
      ]);
    },
  });

  const scenarioRecord = scenario.data ?? null;
  const enabled = scenarioRecord?.enabled ?? false;

  return (
    <AuthenticatedShell
      title={scenarioRecord?.scenarioId ?? "Scenario details"}
      description="Read-only scenario record. The web UI reflects the current stored scenario and only controls whether it is enabled for learners."
    >
      <div className="flex items-center justify-between gap-3">
        <Button
          variant="ghost"
          className="w-fit"
          render={<Link to="/admin/scenarios" />}
        >
          <ArrowLeft className="size-4" />
          Back to scenarios
        </Button>

        {enabled ? (
          <Button
            variant="outline"
            onClick={() => disableScenario.mutate()}
            disabled={disableScenario.isPending || enableScenario.isPending}
          >
            <CircleOff className="size-4" />
            {disableScenario.isPending ? "Disabling..." : "Disable scenario"}
          </Button>
        ) : (
          <Button
            onClick={() => enableScenario.mutate()}
            disabled={enableScenario.isPending || disableScenario.isPending}
          >
            <CircleCheckBig className="size-4" />
            {enableScenario.isPending ? "Enabling..." : "Enable scenario"}
          </Button>
        )}
      </div>

      {scenario.error ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load scenario</AlertTitle>
          <AlertDescription>
            {scenario.error instanceof Error
              ? scenario.error.message
              : "Failed to load scenario"}
          </AlertDescription>
        </Alert>
      ) : null}

      {enableScenario.error ? (
        <Alert variant="destructive">
          <AlertTitle>Enable failed</AlertTitle>
          <AlertDescription>
            {enableScenario.error instanceof Error
              ? enableScenario.error.message
              : "Failed to enable scenario"}
          </AlertDescription>
        </Alert>
      ) : null}

      {disableScenario.error ? (
        <Alert variant="destructive">
          <AlertTitle>Disable failed</AlertTitle>
          <AlertDescription>
            {disableScenario.error instanceof Error
              ? disableScenario.error.message
              : "Failed to disable scenario"}
          </AlertDescription>
        </Alert>
      ) : null}

      {scenarioRecord ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(18rem,0.9fr)]">
          <Card className="overflow-hidden">
            <CardHeader className="space-y-5 border-b border-border/70 bg-muted/30">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={enabled ? "default" : "outline"}>
                  {enabled ? "Enabled" : "Disabled"}
                </Badge>
                <Badge variant="outline">
                  <HardDriveDownload className="size-3" />
                  {scenarioRecord.vmCount} VM
                  {scenarioRecord.vmCount === 1 ? "" : "s"}
                </Badge>
                <Badge variant="outline">
                  <Radar className="size-3" />
                  {scenarioRecord.probeCount} probe
                  {scenarioRecord.probeCount === 1 ? "" : "s"}
                </Badge>
              </div>

              <div className="space-y-2">
                <CardTitle className="text-2xl tracking-tight">
                  {scenarioRecord.scenarioId}
                </CardTitle>
                <CardDescription className="text-sm leading-6 text-muted-foreground">
                  Current stored scenario
                </CardDescription>
              </div>
            </CardHeader>

            <CardContent className="space-y-6 pt-6">
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <FileText className="size-4 text-muted-foreground" />
                  <h2 className="text-base font-semibold tracking-tight">
                    Scenario description
                  </h2>
                </div>
                <div className="rounded-xl border bg-background px-4 py-4">
                  <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">
                    {scenarioRecord.description}
                  </p>
                </div>
              </section>

              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <Microchip className="size-4 text-muted-foreground" />
                  <h2 className="text-base font-semibold tracking-tight">
                    Scenario VMs
                  </h2>
                </div>

                {scenarioRecord.vms.length ? (
                  <div className="space-y-3">
                    {scenarioRecord.vms.map((vm) => (
                      <div
                        key={vm.id}
                        className="rounded-xl border bg-background px-4 py-4"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-medium">{vm.name}</p>
                          <Badge variant="outline">{vm.image}</Badge>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground">
                          <span>{vm.cpu} vCPU</span>
                          <span>{formatMemory(vm.memoryMib)}</span>
                          <span>{formatDisk(vm.diskMib)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed px-4 py-6 text-sm text-muted-foreground">
                    No VMs are defined on this scenario.
                  </div>
                )}
              </section>

              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <Radar className="size-4 text-muted-foreground" />
                  <h2 className="text-base font-semibold tracking-tight">
                    Probe checklist
                  </h2>
                </div>

                {scenarioRecord.probes.length ? (
                  <div className="space-y-3">
                    {scenarioRecord.probes.map((probe, index) => (
                      <div
                        key={`${scenarioRecord.scenarioId}-probe-${probe.ordinal}`}
                        className="rounded-xl border bg-background px-4 py-4"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-medium">
                            {index + 1}. {probe.name}
                          </p>
                          <Badge
                            variant={
                              probe.phase === "boot" ? "secondary" : "outline"
                            }
                          >
                            {probe.phase === "boot"
                              ? "Boot probe"
                              : "Scenario probe"}
                          </Badge>
                        </div>
                        <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                          {probe.description}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed px-4 py-6 text-sm text-muted-foreground">
                    No probes are defined on this scenario.
                  </div>
                )}
              </section>
            </CardContent>
          </Card>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Record</CardTitle>
                <CardDescription>
                  This page always reflects the current stored scenario for this
                  scenario ID.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                <MetaRow label="Scenario ID" value={scenarioRecord.scenarioId} />
                <MetaRow
                  label="State"
                  value={enabled ? "Enabled" : "Disabled"}
                />
                <MetaRow
                  label="VM count"
                  value={String(scenarioRecord.vmCount)}
                />
                <MetaRow
                  label="Probe count"
                  value={String(scenarioRecord.probeCount)}
                />
                <MetaRow
                  label="Enabled at"
                  value={
                    scenarioRecord.enabledAt
                      ? formatDateTime(scenarioRecord.enabledAt)
                      : "Not enabled"
                  }
                />
                <MetaRow
                  label="Updated"
                  value={formatDateTime(scenarioRecord.updatedAt)}
                />
              </CardContent>
            </Card>
          </div>
        </div>
      ) : null}
    </AuthenticatedShell>
  );
}

function MetaRow(props: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground/80">
        {props.label}
      </p>
      <p className="break-all text-sm font-medium">{props.value}</p>
    </div>
  );
}

function formatDateTime(value: number | null | undefined) {
  if (!value) {
    return "Unknown";
  }

  return new Date(value).toLocaleString();
}

function formatMemory(value: number) {
  const gib = value / 1024;
  return Number.isInteger(gib) ? `${gib} GiB RAM` : `${gib.toFixed(1)} GiB RAM`;
}

function formatDisk(value: number) {
  const gib = value / 1024;
  return Number.isInteger(gib)
    ? `${gib} GiB disk`
    : `${gib.toFixed(1)} GiB disk`;
}
