import { useMemo } from "react";
import { useParams } from "@tanstack/react-router";
import { Markdown } from "@/components/app/Markdown";
import {
  REVISION_STATES,
  type AdministeredScenario,
  type RevisionAction,
  type ScenarioRevisionSummary,
  shortRev,
  useAdministeredScenario,
  useRevisionAction,
} from "@/components/app/admin/scenario-revisions";
import type { AdminScenarioSummary } from "@/components/app/admin/hosts/types";
import { apiErrorMessage } from "@/components/app/lib/api-errors";
import { formatBytes, formatRelativeTime, formatTimestamp } from "@/components/app/lib/format";
import { DisclosureRow } from "@/components/app/patterns/DisclosureRow";
import { InlineFeedback } from "@/components/app/patterns/InlineFeedback";
import { MetaLine } from "@/components/app/patterns/MetaLine";
import { PageShell } from "@/components/app/patterns/PageShell";
import { Section } from "@/components/app/patterns/Section";
import { TableSkeleton } from "@/components/app/patterns/Skeletons";
import { ErrorState } from "@/components/app/patterns/StateCard";
import { StatusToken } from "@/components/app/patterns/StatusToken";
import { usePageChrome } from "@/components/app/shell/page-chrome";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ScenarioHintManifestV3 } from "@/generated/catalog";
import type { ScenarioProbeRecord, ScenarioVmRecord } from "@/lib/scenario-model";
import type { CourseLocation } from "@/lib/scenario-runs";

export interface ScenarioRecord extends AdminScenarioSummary {
  briefingMarkdown: string;
  solutionMarkdown: string;
  hints: ScenarioHintManifestV3[];
  probes: ScenarioProbeRecord[];
  vms: ScenarioVmRecord[];
  courseLocation: CourseLocation | null;
}

export function ScenarioDetails() {
  const { namespace, slug } = useParams({ from: "/app/admin/scenarios/$namespace/$slug" });
  const scenarioId = `${namespace}/${slug}`;
  const scenario = useAdministeredScenario(scenarioId);
  const action = useRevisionAction(scenarioId);
  const record = scenario.data ?? null;

  usePageChrome({
    title: record?.title ?? scenarioId,
    status: useMemo(
      () => (record && !record.enabled ? <Badge variant="outline" className="hidden sm:inline-flex">Disabled</Badge> : undefined),
      [record],
    ),
  });

  if (scenario.error) {
    return (
      <PageShell variant="workspace" density="compact">
        <ErrorState
          title="Could not load the scenario"
          description={scenario.error instanceof Error ? scenario.error.message : "Failed to load the scenario"}
          onRetry={() => void scenario.refetch()}
        />
      </PageShell>
    );
  }
  if (!record) {
    return (
      <PageShell variant="workspace" density="compact">
        <TableSkeleton />
      </PageShell>
    );
  }

  const failed = action.error ? apiErrorMessage(action.error, "Try again.") ?? "Try again." : null;
  return (
    <PageShell variant="workspace" density="compact">
      <Section density="compact" title="Revisions" description={pointerSummary(record)} bodyClassName="divide-y">
        {record.revisions.length ? (
          record.revisions.map((revision) => (
            <RevisionRow
              key={revision.rev}
              scenario={record}
              revision={revision}
              busy={action.isPending}
              pending={action.isPending && action.variables?.rev === revision.rev ? action.variables.action : null}
              error={action.variables?.rev === revision.rev ? failed : null}
              onAction={(request) => action.mutate(request)}
            />
          ))
        ) : (
          <p className="py-3 text-sm text-muted-foreground">No revisions yet.</p>
        )}
      </Section>
    </PageShell>
  );
}

function pointerSummary(scenario: AdministeredScenario): string {
  const live = scenario.liveRev ? `Learners start ${shortRev(scenario.liveRev)}` : "No revision is live, so learners cannot start this scenario";
  return scenario.candidateRev && scenario.candidateRev !== scenario.liveRev
    ? `${live}; ${shortRev(scenario.candidateRev)} is the candidate.`
    : `${live}.`;
}

const PENDING_WORDS: Record<RevisionAction["action"], string> = {
  verify: "Starting…",
  promote: "Promoting…",
  rollback: "Rolling back…",
};

function RevisionRow({
  scenario,
  revision,
  busy,
  pending,
  error,
  onAction,
}: {
  scenario: AdministeredScenario;
  revision: ScenarioRevisionSummary;
  busy: boolean;
  pending: RevisionAction["action"] | null;
  error: string | null;
  onAction: (request: RevisionAction) => void;
}) {
  const live = revision.rev === scenario.liveRev;
  const candidate = revision.rev === scenario.candidateRev;
  const verifying = Boolean(scenario.verifyRuns[revision.rev]);
  const state = REVISION_STATES[revision.state];
  const move = (kind: "promote" | "rollback") => onAction({ action: kind, rev: revision.rev, liveRev: scenario.liveRev });
  const actions = !scenario.canManage || live
    ? null
    : candidate && revision.state === "ready" && !verifying
      ? <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction({ action: "verify", rev: revision.rev })}>{pending ?? "Verify"}</Button>
      : candidate && revision.canGoLive
        ? <Button size="sm" disabled={busy} onClick={() => move("promote")}>{pending ? PENDING_WORDS[pending] : "Promote"}</Button>
        : revision.canGoLive && revision.liveAt !== null
          ? <Button size="sm" variant="outline" disabled={busy} onClick={() => move("rollback")}>{pending ? PENDING_WORDS[pending] : "Roll back"}</Button>
          : null;
  return (
    <div className="space-y-2 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            <code title={revision.rev}>{shortRev(revision.rev)}</code>
            {live ? <Badge variant="success">Live</Badge> : null}
            {candidate && !live ? <Badge variant="outline">Candidate</Badge> : null}
          </h3>
          <MetaLine
            items={[
              `Guest contract ${revision.guestContract}`,
              `Built ${formatRelativeTime(revision.createdAt)}`,
              revision.liveAt ? `First live ${formatTimestamp(revision.liveAt)}` : null,
            ]}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {verifying ? <StatusToken tone="live" word="Verifying" pulse /> : <StatusToken tone={state.tone} word={state.word} />}
          {actions}
        </div>
      </div>
      {revision.failureReason ? <InlineFeedback tone="error" announce={false}>{revision.failureReason}</InlineFeedback> : null}
      {revision.verifyReport ? <VerifyReportRow report={revision.verifyReport} /> : null}
      {error ? <InlineFeedback tone="error">{error}</InlineFeedback> : null}
    </div>
  );
}

const OUTCOME_WORDS = { passed: "Passed", failed: "Failed", verify_timeout: "Timed out" } as const;

function VerifyReportRow({ report }: { report: NonNullable<ScenarioRevisionSummary["verifyReport"]> }) {
  return (
    <DisclosureRow
      density="compact"
      title={`Last verify run: ${OUTCOME_WORDS[report.outcome]}`}
      meta={formatRelativeTime(report.at)}
    >
      <div className="space-y-3 text-sm">
        {report.machines.map((machine) => {
          const steps = machine.verify?.steps ?? [];
          return (
            <div key={machine.name} className="space-y-1">
              <p className="font-medium">{machine.name}</p>
              {machine.failure ? <InlineFeedback tone="error" announce={false}>{machine.failure}</InlineFeedback> : null}
              {steps.map((step) => (
                <div key={step.task_id} className="space-y-1">
                  <MetaLine
                    items={[
                      <code key="task">{step.task_id}</code>,
                      `Before ${step.pre}`,
                      `Solve exit ${step.solve_exit}`,
                      `After ${step.post}`,
                    ]}
                  />
                  {step.tail ? <pre className="overflow-x-auto rounded-md bg-terminal-background p-2 font-mono text-xs text-terminal-foreground">{step.tail}</pre> : null}
                </div>
              ))}
              {!machine.failure && !steps.length ? <p className="text-muted-foreground">No verify steps reported.</p> : null}
            </div>
          );
        })}
      </div>
    </DisclosureRow>
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
  return `${bootChecks} boot ${bootChecks === 1 ? "check" : "checks"} · ${repairObjectives} repair ${repairObjectives === 1 ? "objective" : "objectives"} · ${enabled ? "enabled" : "disabled"}`;
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
      <Markdown className="text-sm leading-7">
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
            <Markdown className="text-sm leading-7">
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
          <div className="grid gap-4 lg:grid-cols-2">
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
              meta={`${probes.length} ${probes.length === 1 ? "probe" : "probes"}`}
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
    <div className="space-y-3">
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
    <li className="flex gap-3 py-3">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums">
        {index + 1}
      </span>
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
        {probe.bodyMarkdown?.trim() ? (
          <Markdown className="text-sm leading-7 text-muted-foreground">
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
            label={`Probe hints for probe ${index + 1}`}
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
      <div className="mt-4 divide-y border-t">
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
    <div className="rounded-lg bg-muted/50 p-3">
      <p className="text-sm font-medium">
        {hint.title?.trim() || fallbackTitle}
      </p>
      <Markdown className="mt-1 text-sm leading-7">
        {hint.body_markdown}
      </Markdown>
    </div>
  );
}

function VmRecord({ vm }: { vm: ScenarioVmRecord }) {
  return (
    <div className="space-y-3 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="font-mono text-sm font-medium">{vm.name}</p>
        <Badge variant="outline">{vm.image}</Badge>
        <div className="flex flex-wrap gap-x-3 text-sm text-muted-foreground">
          <span>{formatCpu(vm.cpuMillis)} CPU</span>
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
