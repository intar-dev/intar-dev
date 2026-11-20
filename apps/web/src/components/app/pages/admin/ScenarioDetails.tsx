import { useMemo } from "react";
import { useParams } from "@tanstack/react-router";
import {
  REVISION_STATES,
  type AdministeredScenario,
  type RevisionAction,
  type ScenarioRevisionSummary,
  shortRev,
  useAdministeredScenario,
  useRevisionAction,
} from "@/components/app/admin/scenario-revisions";
import { apiErrorMessage } from "@/components/app/lib/api-errors";
import { formatRelativeTime, formatTimestamp } from "@/components/app/lib/format";
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
  verify_restore: "Starting…",
  clear_restore_verified: "Withdrawing…",
  lift_hold: "Lifting…",
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
  // A rollback left this behaviour on hold: nothing that behaves the same
  // is verified or promoted until an administrator lifts it. Going back to
  // such a revision stays possible.
  const liftHold = <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction({ action: "lift_hold", rev: revision.rev })}>{pending === "lift_hold" ? PENDING_WORDS[pending] : "Lift hold"}</Button>;
  const actions = !scenario.canManage || live
    ? null
    : candidate && revision.held
      ? liftHold
      : candidate && revision.state === "ready" && !verifying
        ? <Button size="sm" variant="outline" disabled={busy || !revision.imagesReady} onClick={() => onAction({ action: "verify", rev: revision.rev })}>{pending ? PENDING_WORDS[pending] : revision.imagesReady ? "Verify" : "Preparing"}</Button>
        : candidate && revision.canGoLive
          ? <Button size="sm" disabled={busy} onClick={() => move("promote")}>{pending ? PENDING_WORDS[pending] : "Promote"}</Button>
          : (
            <>
              {revision.canGoLive && revision.liveAt !== null
                ? <Button size="sm" variant="outline" disabled={busy} onClick={() => move("rollback")}>{pending === "rollback" ? PENDING_WORDS[pending] : "Roll back"}</Button>
                : null}
              {revision.held ? liftHold : null}
            </>
          );
  // A restore check is for any verified revision, the live one included: it
  // decides whether labs of the revision may start from a host snapshot.
  const restoreAction = !scenario.canManage || verifying
    ? null
    : revision.canVerifyRestore
      ? <Button size="sm" variant="outline" disabled={busy || !revision.imagesReady} onClick={() => onAction({ action: "verify_restore", rev: revision.rev })}>{pending === "verify_restore" ? PENDING_WORDS[pending] : "Check snapshot start"}</Button>
      : revision.restoreVerifiedAt !== null
        ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAction({ action: "clear_restore_verified", rev: revision.rev })}>{pending === "clear_restore_verified" ? PENDING_WORDS[pending] : "Withdraw snapshot start"}</Button>
        : null;
  return (
    <div className="space-y-2 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            <code title={revision.rev}>{shortRev(revision.rev)}</code>
            {live ? <Badge variant="success">Live</Badge> : null}
            {candidate && !live ? <Badge variant="outline">Candidate</Badge> : null}
            {revision.held ? <Badge variant="outline" title="A rollback left this revision's behaviour on hold. It is not promoted until the hold is lifted.">Held</Badge> : null}
          </h3>
          <MetaLine
            items={[
              `Guest contract ${revision.guestContract}`,
              `Built ${formatRelativeTime(revision.createdAt)}`,
              revision.liveAt ? `First live ${formatTimestamp(revision.liveAt)}` : null,
              revision.restoreVerifiedAt ? `Starts from a snapshot since ${formatTimestamp(revision.restoreVerifiedAt)}` : null,
            ]}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {verifying ? <StatusToken tone="live" word="Verifying" pulse /> : <StatusToken tone={state.tone} word={state.word} />}
          {actions}
          {restoreAction}
        </div>
      </div>
      {revision.failureReason ? <InlineFeedback tone="error" announce={false}>{revision.failureReason}</InlineFeedback> : null}
      {revision.verifyReport ? <VerifyReportRow report={revision.verifyReport} /> : null}
      {revision.restoreVerifyReport ? (
        <VerifyReportRow
          report={revision.restoreVerifyReport}
          title={`Last snapshot check: ${restoreCheckWords(revision.restoreVerifyReport)}`}
        />
      ) : null}
      {error ? <InlineFeedback tone="error">{error}</InlineFeedback> : null}
    </div>
  );
}

const OUTCOME_WORDS = { passed: "Passed", failed: "Failed", verify_timeout: "Timed out" } as const;

/** What a restore check showed; a lab that started cold showed nothing about a restore. */
function restoreCheckWords(report: NonNullable<ScenarioRevisionSummary["restoreVerifyReport"]>): string {
  if (!report.restored) return "the lab started cold, so nothing was checked; run it again";
  return report.outcome === "passed" ? "Passed" : `${OUTCOME_WORDS[report.outcome]} after a snapshot start`;
}

function VerifyReportRow({ report, title }: { report: NonNullable<ScenarioRevisionSummary["verifyReport"]>; title?: string }) {
  return (
    <DisclosureRow
      density="compact"
      title={title ?? `Last verify run: ${OUTCOME_WORDS[report.outcome]}`}
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
