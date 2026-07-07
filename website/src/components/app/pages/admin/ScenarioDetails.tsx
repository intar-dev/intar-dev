import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import {
  CircleCheckBig,
  CircleOff,
  HardDriveDownload,
  Radar,
} from "lucide-react";
import { PageShell } from "@/components/app/patterns/PageShell";
import { PageHeader } from "@/components/app/patterns/PageHeader";
import { Section } from "@/components/app/patterns/Section";
import { MetaChip } from "@/components/app/patterns/MetaChip";
import {
  ErrorState,
  LoadingState,
} from "@/components/app/patterns/StateCard";
import { useBreadcrumbLabel } from "@/components/app/shell/breadcrumbs";
import { formatTimestamp } from "@/components/app/lib/format";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  const { scenarioId } = useParams({
    from: "/app/admin/scenarios/$scenarioId",
  });
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

  useBreadcrumbLabel(scenarioRecord?.scenarioId);

  return (
    <PageShell admin title="Scenario details" showHeader={false}>
      {scenario.error ? (
        <ErrorState
          title="Could not load scenario"
          description={
            scenario.error instanceof Error
              ? scenario.error.message
              : "Failed to load scenario"
          }
          onRetry={() => void scenario.refetch()}
        />
      ) : !scenarioRecord ? (
        <LoadingState title="Loading scenario" />
      ) : (
        <>
          <PageHeader
            eyebrow="Admin"
            badge="Admin"
            backLink={{ to: "/admin/scenarios", label: "Registry" }}
            title={scenarioRecord.scenarioId}
            description="Read-only scenario record. The web UI reflects the current stored scenario and only controls whether it is enabled for learners."
            meta={
              <>
                <Badge variant={enabled ? "success" : "outline"}>
                  {enabled ? "Enabled" : "Disabled"}
                </Badge>
                <MetaChip icon={<HardDriveDownload />}>
                  {scenarioRecord.vmCount} VM
                  {scenarioRecord.vmCount === 1 ? "" : "s"}
                </MetaChip>
                <MetaChip icon={<Radar />}>
                  {scenarioRecord.probeCount} probe
                  {scenarioRecord.probeCount === 1 ? "" : "s"}
                </MetaChip>
              </>
            }
            actions={
              enabled ? (
                <Button
                  variant="outline"
                  onClick={() => disableScenario.mutate()}
                  disabled={
                    disableScenario.isPending || enableScenario.isPending
                  }
                >
                  <CircleOff className="size-4" />
                  {disableScenario.isPending
                    ? "Disabling…"
                    : "Disable scenario"}
                </Button>
              ) : (
                <Button
                  onClick={() => enableScenario.mutate()}
                  disabled={
                    enableScenario.isPending || disableScenario.isPending
                  }
                >
                  <CircleCheckBig className="size-4" />
                  {enableScenario.isPending ? "Enabling…" : "Enable scenario"}
                </Button>
              )
            }
          />

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

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(18rem,0.9fr)]">
            <div className="space-y-6">
              <Section
                title="Briefing preview"
                description="How the scenario description reads to learners."
              >
                <p className="text-sm leading-6 whitespace-pre-wrap">
                  {scenarioRecord.description}
                </p>
              </Section>

              <Section
                title="VM inventory"
                description="Machines provisioned for every run of this scenario."
              >
                {scenarioRecord.vms.length ? (
                  <div className="divide-y">
                    {scenarioRecord.vms.map((vm) => (
                      <div
                        key={vm.id}
                        className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0"
                      >
                        <p className="font-mono text-sm font-medium">
                          {vm.name}
                        </p>
                        <Badge variant="outline">{vm.image}</Badge>
                        <div className="flex flex-wrap gap-x-4 text-sm text-muted-foreground">
                          <span>{vm.cpu} vCPU</span>
                          <span>{formatMemory(vm.memoryMib)}</span>
                          <span>{formatDisk(vm.diskMib)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No VMs are defined on this scenario.
                  </p>
                )}
              </Section>

              <Section
                title="Probes"
                description="Checks that grade a run, in order."
              >
                {scenarioRecord.probes.length ? (
                  <div className="divide-y">
                    {scenarioRecord.probes.map((probe, index) => (
                      <div
                        key={`${scenarioRecord.scenarioId}-probe-${probe.ordinal}`}
                        className="space-y-1.5 py-3 first:pt-0 last:pb-0"
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
                        <p className="text-sm leading-6 whitespace-pre-wrap text-muted-foreground">
                          {probe.description}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No probes are defined on this scenario.
                  </p>
                )}
              </Section>
            </div>

            <Section
              title="Record"
              description="Always reflects the current stored scenario for this scenario ID."
              className="h-fit"
              bodyClassName="space-y-4"
            >
              <MetaRow label="Scenario ID" value={scenarioRecord.scenarioId} />
              <MetaRow label="State" value={enabled ? "Enabled" : "Disabled"} />
              <MetaRow label="VM count" value={String(scenarioRecord.vmCount)} />
              <MetaRow
                label="Probe count"
                value={String(scenarioRecord.probeCount)}
              />
              <MetaRow
                label="Enabled at"
                value={
                  scenarioRecord.enabledAt
                    ? formatTimestamp(scenarioRecord.enabledAt)
                    : "Not enabled"
                }
              />
              <MetaRow
                label="Updated"
                value={formatTimestamp(scenarioRecord.updatedAt)}
              />
            </Section>
          </div>
        </>
      )}
    </PageShell>
  );
}

function MetaRow(props: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-eyebrow">{props.label}</p>
      <p className="text-sm font-medium break-all">{props.value}</p>
    </div>
  );
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
