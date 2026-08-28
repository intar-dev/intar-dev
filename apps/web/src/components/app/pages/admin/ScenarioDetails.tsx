import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { CircleCheckBig, CircleOff, ExternalLink } from "lucide-react";
import { Markdown } from "@/components/app/Markdown";
import type { AdminScenarioSummary } from "@/components/app/admin/hosts/types";
import { formatBytes, formatTimestamp } from "@/components/app/lib/format";
import { ContentHeader } from "@/components/app/patterns/ContentHeader";
import { DisclosureRow } from "@/components/app/patterns/DisclosureRow";
import { PageShell } from "@/components/app/patterns/PageShell";
import { Section } from "@/components/app/patterns/Section";
import { MetaDifficulty, MetaLine } from "@/components/app/patterns/MetaLine";
import { ErrorState } from "@/components/app/patterns/StateCard";
import { usePageChrome } from "@/components/app/shell/page-chrome";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { ScenarioHintManifestV3 } from "@/generated/catalog";
import type {
  ScenarioProbeRecord,
  ScenarioVmRecord,
} from "@/lib/scenario-model";
import type { CourseLocation } from "@/lib/scenario-runs";
import { courseRouteId } from "@/lib/course-location";

export interface ScenarioRecord extends AdminScenarioSummary {
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
        ScenarioDetailResponse | { error?: string } | null;

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
        ScenarioDetailResponse | { error?: string } | null;

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
        ScenarioDetailResponse | { error?: string } | null;

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
                  <MetaDifficulty
                    key="difficulty"
                    difficulty={scenarioRecord.difficulty}
                  />,
                  scenarioVerificationSummary(scenarioRecord.probes, enabled),
                ]}
              />
            }
            actions={
              enabled && learnerCourseLocation ? (
                <LearnerCourseAction
                  scenarioId={scenarioRecord.scenarioId}
                  courseLocation={learnerCourseLocation}
                />
              ) : undefined
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

          <div className="space-y-5">
            <ScenarioLearnerPreview
              briefingMarkdown={scenarioRecord.briefingMarkdown}
              hints={scenarioRecord.hints}
              solutionMarkdown={scenarioRecord.solutionMarkdown}
            />
            <ScenarioVerificationContract probes={scenarioRecord.probes} />
            <ScenarioOperationalRecord
              scenario={scenarioRecord}
              enabled={enabled}
            />
          </div>
        </>
      )}
    </PageShell>
  );
}

function LearnerCourseAction({
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
      <Button
        size="sm"
        variant="outline"
        render={
          <Link
            to="/courses/$courseId/$scenarioId"
            params={{ courseId, scenarioId }}
          />
        }
      >
        <ExternalLink className="size-3.5" />
        View as learner
      </Button>
    );
  }
  if (!location.organizationId) return null;
  if (location.scope === "organization-public") {
    return (
      <Button
        size="sm"
        variant="outline"
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
        <ExternalLink className="size-3.5" />
        View as learner
      </Button>
    );
  }
  if (location.scope === "organization-private") {
    return (
      <Button
        size="sm"
        variant="outline"
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
        <ExternalLink className="size-3.5" />
        View as learner
      </Button>
    );
  }
  return (
    <Button
      size="sm"
      variant="outline"
      render={
        <Link
          to="/organizations/$orgId/courses/general-practice/$scenarioId"
          params={{ orgId: location.organizationId, scenarioId }}
        />
      }
    >
      <ExternalLink className="size-3.5" />
      View as learner
    </Button>
  );
}

export function scenarioVerificationSummary(
  probes: readonly ScenarioProbeRecord[],
  enabled: boolean,
): string {
  const bootChecks = probes.filter((probe) => probe.phase === "boot").length;
  const repairObjectives = probes.filter(
    (probe) => probe.phase === "scenario",
  ).length;
  return `${bootChecks} boot checks · ${repairObjectives} repair objectives · ${enabled ? "enabled" : "disabled"}`;
}

export function ScenarioLearnerPreview({
  briefingMarkdown,
  hints,
  solutionMarkdown,
}: Pick<ScenarioRecord, "briefingMarkdown" | "hints" | "solutionMarkdown">) {
  return (
    <Section
      density="compact"
      title="Learner preview"
      description="The briefing learners read before they start."
    >
      <Markdown className="prose-measure text-sm leading-7">
        {briefingMarkdown}
      </Markdown>
      <div className="mt-4 divide-y border-t">
        {hints.length ? (
          <DisclosureRow
            title="Hints"
            meta={`${hints.length} available`}
            density="compact"
            contentClassName="space-y-3"
          >
            {hints.map((hint, index) => (
              <HintTile
                key={hint.id}
                hint={hint}
                fallbackTitle={`Hint ${index + 1}`}
              />
            ))}
          </DisclosureRow>
        ) : null}
        <DisclosureRow title="Solution" meta="Learner-gated" density="compact">
          {solutionMarkdown.trim() ? (
            <Markdown className="prose-measure text-sm leading-7">
              {solutionMarkdown}
            </Markdown>
          ) : (
            <p className="text-sm text-muted-foreground">
              No solution is configured.
            </p>
          )}
        </DisclosureRow>
      </div>
    </Section>
  );
}

export function ScenarioVerificationContract({
  probes,
}: {
  probes: readonly ScenarioProbeRecord[];
}) {
  const bootChecks = probes.filter((probe) => probe.phase === "boot");
  const repairObjectives = probes.filter((probe) => probe.phase === "scenario");

  return (
    <Section
      density="compact"
      title="Verification contract"
      description="The startup gates and repair objectives a learner must satisfy."
    >
      {probes.length ? (
        <>
          <div className="grid gap-5 lg:grid-cols-2">
            <VerificationObjectiveGroup
              title="Boot checks"
              emptyCopy="No startup checks are configured."
              probes={bootChecks}
            />
            <VerificationObjectiveGroup
              title="Repair objectives"
              emptyCopy="No repair objectives are configured."
              probes={repairObjectives}
            />
          </div>
          <div className="mt-4 border-t">
            <DisclosureRow
              title="Probe implementation"
              meta={`${probes.length} probes`}
              density="compact"
              contentClassName="divide-y"
            >
              {probes.map((probe, index) => (
                <TechnicalProbeRecord
                  key={`${probe.scenarioVmId}-${probe.ordinal}`}
                  probe={probe}
                  index={index}
                />
              ))}
            </DisclosureRow>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          No probes are defined on this scenario.
        </p>
      )}
    </Section>
  );
}

function VerificationObjectiveGroup({
  title,
  probes,
  emptyCopy,
}: {
  title: string;
  probes: readonly ScenarioProbeRecord[];
  emptyCopy: string;
}) {
  return (
    <div className="space-y-2">
      <p className="text-label">{title}</p>
      {probes.length ? (
        <ol className="divide-y border-y">
          {probes.map((probe, index) => (
            <VerificationObjective
              key={`${probe.scenarioVmId}-${probe.ordinal}`}
              probe={probe}
              index={index}
            />
          ))}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground">{emptyCopy}</p>
      )}
    </div>
  );
}

function VerificationObjective({
  probe,
  index,
}: {
  probe: ScenarioProbeRecord;
  index: number;
}) {
  const title = probeObjectiveTitle(probe, index);
  const description =
    probe.title?.trim() && probe.description.trim() !== title
      ? probe.description.trim()
      : null;

  return (
    <li className="flex gap-3 py-3 first:pt-0 last:pb-0">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums">
        {index + 1}
      </span>
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
        {probe.bodyMarkdown?.trim() ? (
          <Markdown className="prose-measure text-sm leading-7 text-muted-foreground">
            {probe.bodyMarkdown}
          </Markdown>
        ) : null}
      </div>
    </li>
  );
}

function TechnicalProbeRecord({
  probe,
  index,
}: {
  probe: ScenarioProbeRecord;
  index: number;
}) {
  return (
    <div className="space-y-3 py-3 first:pt-0 last:pb-0">
      <p className="text-sm font-medium">Probe {index + 1}</p>
      <dl className="grid gap-3 sm:grid-cols-2">
        <MetaRow label="Probe ID" value={probe.name} mono />
        <MetaRow label="Kind" value={probe.kind} mono />
        <MetaRow
          label="Phase"
          value={probe.phase === "boot" ? "Boot" : "Repair"}
        />
        <MetaRow label="Scenario VM" value={probe.scenarioVmName} mono />
      </dl>
      {probe.hints.length ? (
        <div className="border-t pt-2">
          <DisclosureRow
            title="Probe hints"
            meta={`${probe.hints.length} available`}
            density="compact"
            contentClassName="space-y-3"
          >
            {probe.hints.map((hint, hintIndex) => (
              <HintTile
                key={hint.id}
                hint={hint}
                fallbackTitle={`Hint ${hintIndex + 1}`}
              />
            ))}
          </DisclosureRow>
        </div>
      ) : null}
    </div>
  );
}

export function ScenarioOperationalRecord({
  scenario,
  enabled,
}: {
  scenario: Pick<
    ScenarioRecord,
    | "scenarioId"
    | "category"
    | "difficulty"
    | "estimatedMinutes"
    | "tags"
    | "scenarioHintCount"
    | "probeCount"
    | "vmCount"
    | "enabledAt"
    | "createdAt"
    | "updatedAt"
    | "vms"
  >;
  enabled: boolean;
}) {
  return (
    <Section
      density="compact"
      title="Operations record"
      description="Publication state, deployment provenance, and stored metadata."
    >
      <MetaLine
        items={[
          `${scenario.vmCount} VM${scenario.vmCount === 1 ? "" : "s"}`,
          `${scenario.probeCount} verification ${scenario.probeCount === 1 ? "check" : "checks"}`,
          enabled ? "Enabled for learners" : "Disabled",
        ]}
      />
      <div className="mt-3 divide-y border-t">
        <DisclosureRow
          title="Image provenance"
          meta={`${scenario.vms.length} VM${scenario.vms.length === 1 ? "" : "s"}`}
          density="compact"
          contentClassName="divide-y"
        >
          {scenario.vms.length ? (
            scenario.vms.map((vm) => <VmRecord key={vm.id} vm={vm} />)
          ) : (
            <p className="py-2 text-sm text-muted-foreground">
              No VMs are defined on this scenario.
            </p>
          )}
        </DisclosureRow>
        <DisclosureRow title="Record metadata" density="compact">
          <dl className="grid gap-3 sm:grid-cols-2">
            <MetaRow label="Scenario ID" value={scenario.scenarioId} mono />
            <MetaRow
              label="Availability"
              value={enabled ? "Enabled for learners" : "Unavailable"}
            />
            <MetaRow label="Category" value={scenario.category} />
            <MetaRow label="Difficulty" value={scenario.difficulty} />
            <MetaRow
              label="Estimated time"
              value={`~${scenario.estimatedMinutes} min`}
            />
            <MetaRow
              label="Inventory"
              value={`${scenario.vmCount} VM · ${scenario.probeCount} probes · ${scenario.scenarioHintCount} hints`}
            />
            <MetaRow
              label="Tags"
              value={scenario.tags.length ? scenario.tags.join(", ") : "—"}
            />
            <MetaRow
              label="Enabled at"
              value={
                scenario.enabledAt
                  ? formatTimestamp(scenario.enabledAt)
                  : "Not enabled"
              }
            />
            <MetaRow
              label="Created"
              value={formatTimestamp(scenario.createdAt)}
            />
            <MetaRow
              label="Updated"
              value={formatTimestamp(scenario.updatedAt)}
            />
          </dl>
        </DisclosureRow>
      </div>
    </Section>
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
    <div className="rounded-lg bg-muted/50 px-3 py-2.5">
      <p className="text-sm font-medium">
        {hint.title?.trim() || fallbackTitle}
      </p>
      <Markdown className="mt-2 text-sm leading-7">
        {hint.body_markdown}
      </Markdown>
    </div>
  );
}

function VmRecord({ vm }: { vm: ScenarioVmRecord }) {
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

function probeObjectiveTitle(
  probe: ScenarioProbeRecord,
  index: number,
): string {
  return (
    probe.title?.trim() ||
    probe.description.trim() ||
    `Verification objective ${index + 1}`
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
      <p className="text-label">{label}</p>
      <p className="font-mono text-xs break-all">{value}</p>
    </div>
  );
}

function MetaRow(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-label">{props.label}</dt>
      <dd
        className={
          props.mono
            ? "mt-1 font-mono text-xs break-all"
            : "mt-1 text-sm font-medium break-words"
        }
      >
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
