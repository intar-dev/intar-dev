import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  CircleCheckBig,
  CircleOff,
  Server,
} from "lucide-react";
import { Markdown } from "@/components/app/Markdown";
import type { AdminScenarioSummary } from "@/components/app/admin/hosts/types";
import { formatBytes, formatTimestamp } from "@/components/app/lib/format";
import { ContentHeader } from "@/components/app/patterns/ContentHeader";
import { PageShell } from "@/components/app/patterns/PageShell";
import { Section } from "@/components/app/patterns/Section";
import {
  MetaDifficulty,
  MetaLine,
} from "@/components/app/patterns/MetaLine";
import { ErrorState } from "@/components/app/patterns/StateCard";
import { usePageChrome } from "@/components/app/shell/page-chrome";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { ScenarioHintManifestV3 } from "@/generated/catalog";
import type {
  ScenarioProbeRecord,
  ScenarioVmRecord,
} from "@/lib/scenario-model";
import type { CourseLocation } from "@/lib/scenario-runs";
import { courseRouteId } from "@/lib/course-location";

interface ScenarioRecord extends AdminScenarioSummary {
  briefingMarkdown: string;
  solutionMarkdown: string;
  hints: ScenarioHintManifestV3[];
  probes: ScenarioProbeRecord[];
  vms: ScenarioVmRecord[];
  courseLocation: CourseLocation | null;
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
  const learnerCourseLocation = scenarioRecord?.courseLocation ?? null;

  usePageChrome({
    title: scenarioRecord?.title,
    status: useMemo(
      () =>
        scenarioRecord ? (
          <Badge variant={enabled ? "success" : "outline"}>
            {enabled ? "Enabled" : "Disabled"}
          </Badge>
        ) : undefined,
      [scenarioRecord, enabled],
    ),
    action: useMemo(
      () =>
        scenarioRecord ? (
          enabled ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => disableScenario.mutate()}
              disabled={disableScenario.isPending || enableScenario.isPending}
            >
              <CircleOff className="size-3.5" />
              {disableScenario.isPending ? "Disabling…" : "Disable scenario"}
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => enableScenario.mutate()}
              disabled={enableScenario.isPending || disableScenario.isPending}
            >
              <CircleCheckBig className="size-3.5" />
              {enableScenario.isPending ? "Enabling…" : "Enable scenario"}
            </Button>
          )
        ) : undefined,
      [
        scenarioRecord,
        enabled,
        enableScenario.isPending,
        enableScenario.mutate,
        disableScenario.isPending,
        disableScenario.mutate,
      ],
    ),
    menu: useMemo(
      () =>
        scenarioRecord && enabled && learnerCourseLocation ? (
          <LearnerCourseMenuItem
            scenarioId={scenarioRecord.scenarioId}
            courseLocation={learnerCourseLocation}
          />
        ) : undefined,
      [scenarioRecord, enabled],
    ),
  });

  return (
    <PageShell width="workspace" density="compact">
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
        <div role="status" className="space-y-6">
          <span className="sr-only">Loading…</span>
          <div className="space-y-2">
            <Skeleton className="h-7 w-72 max-w-full" />
            <Skeleton className="h-4 w-80 max-w-full" />
            <Skeleton className="h-3 w-56" />
          </div>
          <Skeleton className="h-48 rounded-xl" />
          <Skeleton className="h-48 rounded-xl" />
        </div>
      ) : (
        <>
          <ContentHeader
            title={scenarioRecord.title}
            summary={scenarioRecord.description}
            meta={
              <MetaLine
                items={[
                  scenarioRecord.scenarioId,
                  <MetaDifficulty
                    key="difficulty"
                    difficulty={scenarioRecord.difficulty}
                  />,
                ]}
              />
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
                density="compact"
                title="Briefing"
                description="How the scenario briefing reads to learners."
              >
                <Markdown>{scenarioRecord.briefingMarkdown}</Markdown>
              </Section>

              <Section
                density="compact"
                title="Probes"
                description="Checks that grade a run, in order."
              >
                {scenarioRecord.probes.length ? (
                  <div className="divide-y">
                    {scenarioRecord.probes.map((probe, index) => (
                      <ProbeRecord
                        key={`${scenarioRecord.scenarioId}-probe-${probe.ordinal}`}
                        probe={probe}
                        index={index}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No probes are defined on this scenario.
                  </p>
                )}
              </Section>

              {scenarioRecord.hints.length ? (
                <Section density="compact" title="Scenario hints">
                  <div className="space-y-3">
                    {scenarioRecord.hints.map((hint, index) => (
                      <HintTile
                        key={hint.id}
                        hint={hint}
                        fallbackTitle={`Hint ${index + 1}`}
                      />
                    ))}
                  </div>
                </Section>
              ) : null}

              <Section
                density="compact"
                title="Solution"
                description="Learner-gated content — visible to admins for inspection."
              >
                <Collapsible>
                  <CollapsibleTrigger
                    render={<Button type="button" variant="outline" />}
                  >
                    Show solution
                  </CollapsibleTrigger>
                  <CollapsibleContent className="mt-4">
                    <Markdown>{scenarioRecord.solutionMarkdown}</Markdown>
                  </CollapsibleContent>
                </Collapsible>
              </Section>

              <Section
                density="compact"
                title="VM inventory"
                description="Machines provisioned for every run of this scenario."
              >
                {scenarioRecord.vms.length ? (
                  <div className="divide-y">
                    {scenarioRecord.vms.map((vm) => (
                      <VmRecord key={vm.id} vm={vm} />
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No VMs are defined on this scenario.
                  </p>
                )}
              </Section>
            </div>

            <Section
              density="compact"
              title="Record"
              description="Always reflects the current stored scenario for this scenario ID."
              className="h-fit lg:sticky lg:top-24"
            >
              <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
                <MetaRow label="Scenario ID" value={scenarioRecord.scenarioId} mono />
                <MetaRow label="Availability" value={enabled ? "Enabled for learners" : "Unavailable"} />
                <MetaRow label="Category" value={scenarioRecord.category} />
                <MetaRow label="Difficulty" value={scenarioRecord.difficulty} />
                <MetaRow label="Estimated time" value={`~${scenarioRecord.estimatedMinutes} min`} />
                <MetaRow label="Inventory" value={`${scenarioRecord.vmCount} VM · ${scenarioRecord.probeCount} probes · ${scenarioRecord.scenarioHintCount} hints`} />
                <MetaRow label="Tags" value={scenarioRecord.tags.length ? scenarioRecord.tags.join(", ") : "—"} />
                <MetaRow label="Enabled at" value={scenarioRecord.enabledAt ? formatTimestamp(scenarioRecord.enabledAt) : "Not enabled"} />
                <MetaRow label="Created" value={formatTimestamp(scenarioRecord.createdAt)} />
                <MetaRow label="Updated" value={formatTimestamp(scenarioRecord.updatedAt)} />
              </dl>
            </Section>
          </div>
        </>
      )}
    </PageShell>
  );
}

function LearnerCourseMenuItem({
  scenarioId,
  courseLocation,
}: {
  scenarioId: string;
  courseLocation: NonNullable<ScenarioRecord["courseLocation"]>;
}) {
  const location = courseLocation;

  const courseId = courseRouteId(location);
  if (location.scope === "public") {
    return (
      <DropdownMenuItem
        render={
          <Link
            to="/courses/$courseId/$scenarioId"
            params={{ courseId, scenarioId }}
          />
        }
      >
        View as learner
      </DropdownMenuItem>
    );
  }
  if (!location.organizationId) return null;
  if (location.scope === "organization-public") {
    return (
      <DropdownMenuItem
        render={
          <Link
            to="/organizations/$orgId/courses/public/$courseId/$scenarioId"
            params={{
              orgId: location.organizationId,
              courseId,
              scenarioId,
            }}
          />
        }
      >
        View as learner
      </DropdownMenuItem>
    );
  }
  if (location.scope === "organization-private") {
    return (
      <DropdownMenuItem
        render={
          <Link
            to="/organizations/$orgId/courses/private/$courseId/$scenarioId"
            params={{
              orgId: location.organizationId,
              courseId,
              scenarioId,
            }}
          />
        }
      >
        View as learner
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuItem
      render={
        <Link
          to="/organizations/$orgId/courses/general-practice/$scenarioId"
          params={{ orgId: location.organizationId, scenarioId }}
        />
      }
    >
      View as learner
    </DropdownMenuItem>
  );
}

function ProbeRecord({
  probe,
  index,
}: {
  probe: ScenarioProbeRecord;
  index: number;
}) {
  return (
    <div className="space-y-3 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-mono text-sm font-medium">
          {index + 1}. {probe.name}
        </p>
        <Badge variant={probe.phase === "boot" ? "secondary" : "outline"}>
          {probe.phase === "boot" ? "Boot" : "Scenario"}
        </Badge>
        <Badge variant="outline" className="font-mono">
          {probe.kind}
        </Badge>
        <Badge variant="outline" className="font-mono">
          <Server className="size-3" />
          {probe.scenarioVmName}
        </Badge>
      </div>
      {probe.title ? <p className="text-sm font-medium">{probe.title}</p> : null}
      {probe.bodyMarkdown ? <Markdown>{probe.bodyMarkdown}</Markdown> : null}
      {probe.description ? (
        <p className="text-caption">{probe.description}</p>
      ) : null}
      {probe.hints.length ? (
        <Collapsible>
          <CollapsibleTrigger
            render={<Button type="button" variant="outline" size="sm" />}
          >
            Hints ({probe.hints.length})
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3 space-y-3">
            {probe.hints.map((hint, hintIndex) => (
              <HintTile
                key={hint.id}
                hint={hint}
                fallbackTitle={`Hint ${hintIndex + 1}`}
              />
            ))}
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}

function HintTile({
  hint,
  fallbackTitle,
}: {
  hint: ScenarioHintManifestV3;
  fallbackTitle: string;
}) {
  return (
    <div className="rounded-xl bg-muted/50 px-4 py-3">
      <p className="text-sm font-medium">{hint.title?.trim() || fallbackTitle}</p>
      <Markdown className="mt-2">{hint.body_markdown}</Markdown>
    </div>
  );
}

function VmRecord({
  vm,
}: {
  vm: ScenarioVmRecord;
}) {
  return (
    <div className="space-y-4 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="font-mono text-sm font-medium">{vm.name}</p>
        <Badge variant="outline">{vm.image}</Badge>
        <div className="flex flex-wrap gap-x-4 text-sm text-muted-foreground">
          <span>{formatCpu(vm.cpuMillis)} CPU</span>
          <span>{vm.vcpuCount} vCPU</span>
          <span>{formatMemory(vm.memoryMib)}</span>
          <span>{formatDisk(vm.diskMib)}</span>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <BootMeta label="Image SHA-256" value={vm.imageSha256 ?? "-"} />
        <BootMeta label="Kernel SHA-256" value={vm.kernelSha256} />
        <BootMeta label="Initrd SHA-256" value={vm.initrdSha256} />
        <BootMeta
          label="Virtual size"
          value={formatBytes(vm.imageVirtualSizeBytes)}
        />
        <BootMeta label="Format" value={vm.imageFormat} />
        <BootMeta label="Image key" value={formatImageKey(vm)} />
      </div>
      <div className="terminal-surface rounded-md border p-3 font-mono text-xs break-all">
        {vm.bootCmdline}
      </div>
    </div>
  );
}

function formatCpu(cpuMillis: number): string {
  return (cpuMillis / 1000).toLocaleString(undefined, {
    maximumFractionDigits: 3,
  });
}

function BootMeta({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-eyebrow">{label}</p>
      <p className="font-mono text-xs break-all">{value}</p>
    </div>
  );
}

function MetaRow(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-eyebrow">{props.label}</dt>
      <dd className={props.mono ? "mt-1 font-mono text-xs break-all" : "mt-1 text-sm font-medium break-words"}>
        {props.value}
      </dd>
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

function formatImageKey(vm: ScenarioVmRecord) {
  if (!vm.imageKey) return "-";
  return `${vm.imageKey.scenario}/${vm.imageKey.vm} (${vm.imageKey.arch})`;
}
