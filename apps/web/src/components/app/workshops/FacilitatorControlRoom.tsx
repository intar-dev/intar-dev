import { useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  Activity,
  CircleAlert,
  MonitorUp,
  Play,
  Presentation,
  Radio,
  RotateCcw,
  Square,
  TerminalSquare,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  isVerificationPassed,
  verificationStatusLabel,
} from "@/lib/verification-copy";
import { ModuleStateGlyph } from "./WorkshopAgenda";
import type {
  WorkshopCheckpoint,
  WorkshopCostScenario,
  WorkshopExplainBackStatus,
  WorkshopModule,
  WorkshopProbe,
  WorkshopRosterMember,
  WorkshopRosterProgress,
  WorkshopSessionDetail,
  WorkshopPresenceState,
} from "./types";
import { workshopMemberHasWorkspace, workshopModuleStateLabel } from "./types";

interface FacilitatorControlRoomProps {
  session: WorkshopSessionDetail;
  busyAction: string | null;
  error: string | null;
  onAction: (
    action: string,
    payload?: Record<string, unknown>,
  ) => Promise<void>;
  onOpenAssistTerminal: (member: WorkshopRosterMember) => void;
}

export function FacilitatorControlRoom({
  session,
  busyAction,
  error,
  onAction,
  onOpenAssistTerminal,
}: FacilitatorControlRoomProps) {
  const [announcement, setAnnouncement] = useState(session.announcement ?? "");
  const canManage = session.viewer.canFacilitate;
  const canStart = session.state === "lobby";
  const activeAgenda = session.agenda.find((item) => item.active) ?? null;
  const checkedIn = session.roster.filter(
    (member) => member.checkedInAt,
  ).length;
  const ready = session.roster.filter(
    (member) => member.workspaceState === "ready",
  ).length;
  const helpQueue = session.roster.filter(
    (member) => member.helpState !== "none",
  );

  return (
    <section aria-labelledby="control-room-heading" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-eyebrow">
            {canManage ? "Facilitator station" : "Helper station"}
          </p>
          <h2 id="control-room-heading" className="mt-1 text-section-title">
            Control room
          </h2>
        </div>
        {canManage ? (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              render={
                <Link
                  to="/workshops/$sessionId/projector"
                  params={{ sessionId: session.id }}
                />
              }
            >
              <MonitorUp />
              Projector
            </Button>
            <Button
              size="sm"
              variant="outline"
              render={
                <Link
                  to="/workshops/$sessionId/present"
                  params={{ sessionId: session.id }}
                />
              }
            >
              <Presentation />
              Present
            </Button>
          </div>
        ) : null}
      </div>

      {error ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive-border bg-destructive-subtle px-3 py-2 text-sm text-destructive"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          {error}
        </div>
      ) : null}

      <div
        className={
          canManage
            ? "grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]"
            : "grid gap-4"
        }
      >
        <div className="min-w-0 overflow-hidden rounded-xl border bg-card">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
              <Metric
                icon={<Users />}
                value={`${checkedIn}/${session.roster.length}`}
                label="checked in"
              />
              <Metric
                icon={<Activity />}
                value={String(ready)}
                label="workspaces ready"
              />
              <Metric
                icon={<Radio />}
                value={String(helpQueue.length)}
                label="need help"
              />
            </div>
            {canManage ? (
              <SessionPrimaryControl
                session={session}
                busyAction={busyAction}
                canStart={canStart}
                onAction={onAction}
              />
            ) : null}
          </div>
          <RosterMatrix
            session={session}
            busy={busyAction != null}
            onAction={onAction}
          />
        </div>

        {canManage ? (
          <aside className="space-y-4" aria-label="Facilitator controls">
            <div className="rounded-xl border bg-card p-4">
              <p className="text-eyebrow">Capacity</p>
              {session.capacity ? (
                <>
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                    <CapacityFact
                      label="Seats ready"
                      value={`${session.capacity.seatsAvailable}/${session.capacity.seatsTotal}`}
                    />
                    <CapacityFact
                      label="Runners"
                      value={String(session.capacity.healthyRunners)}
                    />
                    <CapacityFact
                      label="Provisioned"
                      value={String(session.capacity.provisioned)}
                    />
                    <CapacityFact
                      label="Images"
                      value={session.capacity.imagesReady ? "Ready" : "Warming"}
                    />
                  </dl>
                  <p className="mt-3 border-t pt-3 text-xs text-muted-foreground">
                    Per seat: {session.capacity.seatResources.cpuMillis}m CPU ·{" "}
                    {formatWorkshopMib(
                      session.capacity.seatResources.memoryMib,
                    )}{" "}
                    RAM ·{" "}
                    {formatWorkshopMib(
                      session.capacity.seatResources.worstCaseDiskMib,
                    )}{" "}
                    disk
                  </p>
                  {session.capacity.allocationFailures.length ? (
                    <ul
                      className="mt-3 space-y-2 border-t pt-3 text-xs"
                      aria-label="Allocation blockers"
                    >
                      {session.capacity.allocationFailures.map((failure) => (
                        <li
                          key={`${failure.hostId}:${failure.reason}`}
                          className="flex items-start gap-2 text-muted-foreground"
                        >
                          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
                          <span>
                            <span className="font-mono text-foreground">
                              {failure.hostId}
                            </span>{" "}
                            — {failure.detail}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              ) : session.runtimeProvider &&
                session.runtimeProvider.kind !== "agent_kvm" ? (
                <>
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                    <CapacityFact
                      label="Provider"
                      value={`${providerLabel(session.runtimeProvider.kind)} ${session.runtimeProvider.machineType ?? "VM"}`}
                    />
                    <CapacityFact
                      label="VM limit"
                      value={String(
                        session.runtimeProvider.maxConcurrentAllocations ?? "—",
                      )}
                    />
                  </dl>
                  <p className="mt-3 border-t pt-3 text-xs text-muted-foreground">
                    One direct server per learner · locations{" "}
                    {session.runtimeProvider.permittedLocations.join(" → ")}
                  </p>
                </>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">
                  Capacity appears when the lobby opens.
                </p>
              )}
              {session.state === "lobby" ? (
                <Button
                  className="mt-4 w-full"
                  size="sm"
                  variant="secondary"
                  disabled={busyAction != null || checkedIn === 0}
                  onClick={() => void onAction("provision_checked_in")}
                >
                  Provision checked-in learners
                </Button>
              ) : null}
            </div>

            <WorkshopRuntimeCostCard session={session} />

            <form
              className="rounded-xl border bg-card p-4"
              onSubmit={(event) => {
                event.preventDefault();
                void onAction("announce", { message: announcement.trim() });
              }}
            >
              <label htmlFor="workshop-announcement" className="text-eyebrow">
                Room announcement
              </label>
              <Input
                id="workshop-announcement"
                value={announcement}
                onChange={(event) => setAnnouncement(event.target.value)}
                className="mt-2"
                placeholder="Return at 10:40"
                maxLength={240}
              />
              <Button
                type="submit"
                size="sm"
                variant="outline"
                className="mt-2 w-full"
                disabled={busyAction != null}
              >
                Publish announcement
              </Button>
            </form>
          </aside>
        ) : null}
      </div>

      <div
        className={
          canManage
            ? "grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]"
            : "grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem] xl:justify-end"
        }
      >
        {canManage ? (
          <div className="space-y-4">
            <AgendaControlLedger
              session={session}
              busy={busyAction != null}
              onAction={onAction}
            />
            <ModuleControlLedger
              modules={session.modules}
              activeModuleId={session.currentModuleId}
              busy={busyAction != null}
              onAction={onAction}
            />
          </div>
        ) : (
          <div className="hidden xl:block" aria-hidden="true" />
        )}
        <HelpQueue
          members={helpQueue}
          busy={busyAction != null}
          canAssist={session.viewer.canAssist}
          onAction={onAction}
          onOpenAssistTerminal={onOpenAssistTerminal}
        />
      </div>

      {activeAgenda ? (
        <p className="sr-only" role="status">
          Current agenda item: {activeAgenda.title}
        </p>
      ) : null}
    </section>
  );
}

function WorkshopRuntimeCostCard({
  session,
}: {
  session: WorkshopSessionDetail;
}) {
  if (
    !session.runtimeProvider ||
    session.runtimeProvider.kind === "agent_kvm" ||
    !session.runtimeProvider.connection ||
    !session.cost
  ) {
    return null;
  }
  const provider = session.runtimeProvider;
  const connection = provider.connection;
  if (!connection) return null;
  const forecast = session.cost.latestForecast;
  const live = session.cost.live;
  const final = session.cost.final;
  const currency =
    final?.currency ??
    live?.currency ??
    forecast?.currency ??
    connection.currency;
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-eyebrow">
          {session.cost.label ?? "Estimated cloud cost"}
        </p>
        <Badge
          variant={
            connection.state === "active" ? "success" : "warning"
          }
        >
          {connection.state.replaceAll("_", " ")}
        </Badge>
      </div>
      <p className="mt-2 text-sm font-semibold">
        {provider.machineType ?? "VM"} · {connection.displayName}
      </p>
      {final ? (
        <>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <CapacityFact
              label="Final estimate"
              value={formatNativeCost(final.costNanos, currency)}
            />
            <CapacityFact
              label="Forecast variance"
              value={formatNativeCost(final.varianceNanos, currency)}
            />
            <CapacityFact
              label="Generations / restores"
              value={`${final.generationCount} / ${final.restoreCount}`}
            />
          </dl>
          {final.manualCleanupUnverified ? (
            <p className="mt-3 flex items-start gap-2 text-xs text-warning">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
              This estimate includes an owner acknowledgement of manual cleanup
              that Intar could not independently verify.
            </p>
          ) : null}
        </>
      ) : forecast ? (
        <>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <CapacityFact
              label="Expected"
              value={formatScenarioCost(forecast.expected, currency)}
            />
            <CapacityFact
              label="Lease ceiling"
              value={formatScenarioCost(forecast.leaseCeiling, currency)}
            />
            <CapacityFact
              label="One restore"
              value={formatScenarioCost(forecast.oneRestore, currency)}
            />
            <CapacityFact
              label="Per learner"
              value={formatNativeCost(
                forecast.expected.perLearnerCostNanos,
                currency,
              )}
            />
          </dl>
          {forecast.trigger === "price_changed" ? (
            <p className="mt-3 flex items-start gap-2 text-xs text-warning">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
              Provider pricing changed in forecast v{forecast.version}. Review
              the refreshed totals before provisioning.
            </p>
          ) : null}
          {live ? (
            <div className="mt-3 border-t pt-3">
              <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Live estimate
              </p>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <CapacityFact
                  label="Accrued"
                  value={formatNativeCost(live.accruedCostNanos, currency)}
                />
                <CapacityFact
                  label="Scheduled end"
                  value={formatNativeCost(live.scheduledEndCostNanos, currency)}
                />
                <CapacityFact
                  label="Lease ceiling"
                  value={formatNativeCost(live.leaseCeilingCostNanos, currency)}
                />
                <CapacityFact
                  label="Forecast variance"
                  value={formatNativeCost(
                    live.forecastVarianceNanos,
                    currency,
                  )}
                />
                <CapacityFact
                  label="Accumulating / cleanup pending"
                  value={`${live.accumulatingResources} / ${live.cleanupPendingResources}`}
                />
                <CapacityFact
                  label="Cost ceiling usage"
                  value={
                    live.budgetCeilingNanos === null
                      ? "No ceiling"
                      : `${formatNativeCost(live.budgetUsageNanos, currency)} / ${formatNativeCost(live.budgetCeilingNanos, currency)}`
                  }
                />
              </dl>
            </div>
          ) : null}
          {forecast.exceedsBudgetCeiling || live?.overBudgetCeiling ? (
            <p className="mt-2 flex items-start gap-2 text-xs text-warning">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
              {provider.grossCeilingOverrideAt === null
                ? "Estimated cost is above the organization ceiling; new provisioning and restores require an owner override."
                : `Estimated cost is above the organization ceiling; an owner override was recorded ${formatWorkshopTimestamp(provider.grossCeilingOverrideAt)}.`}
            </p>
          ) : null}
        </>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          The provider price forecast is pending.
        </p>
      )}
      <p className="mt-3 text-[0.6875rem] text-muted-foreground">
        Native {currency}. This is an estimate, not an invoice. Traffic,
        credits, promotions, taxes not supplied by the provider, and billing
        adjustments are excluded.
      </p>
      {forecast ? (
        <>
          <p className="mt-1 text-[0.6875rem] text-muted-foreground">
            Price observed {formatWorkshopTimestamp(forecast.observedAt)} ·
            forecast expires {formatWorkshopTimestamp(forecast.expiresAt)}.
          </p>
          <details className="mt-3 text-xs text-muted-foreground">
            <summary className="w-fit cursor-pointer font-medium text-foreground">
              Forecast assumptions and exclusions
            </summary>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <div>
                <p className="font-medium text-foreground">Assumptions</p>
                <ul className="mt-1 list-disc space-y-1 pl-4">
                  {forecast.assumptions.map((assumption) => (
                    <li key={assumption}>{assumption}</li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="font-medium text-foreground">Excluded</p>
                <ul className="mt-1 list-disc space-y-1 pl-4">
                  {forecast.exclusions.map((exclusion) => (
                    <li key={exclusion}>{exclusion}</li>
                  ))}
                </ul>
              </div>
            </div>
          </details>
        </>
      ) : null}
    </div>
  );
}

function formatWorkshopMib(value: number): string {
  return value >= 1024 && value % 1024 === 0
    ? `${value / 1024} GiB`
    : `${value} MiB`;
}

function formatScenarioCost(
  scenario: WorkshopCostScenario,
  currency: string,
): string {
  if (
    scenario.providerGrossCostNanos !== null &&
    scenario.providerNetCostNanos !== null
  ) {
    return `${formatNativeCost(scenario.providerGrossCostNanos, currency)} gross / ${formatNativeCost(scenario.providerNetCostNanos, currency)} net`;
  }
  return formatNativeCost(scenario.totalCostNanos, currency);
}

function providerLabel(kind: "hetzner_cloud" | "gcp_compute") {
  return kind === "hetzner_cloud" ? "Hetzner Cloud" : "GCP Compute";
}

function formatNativeCost(nanos: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(nanos / 1_000_000_000);
}

function formatWorkshopTimestamp(at: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(at));
}

function RosterMatrix({
  session,
  busy,
  onAction,
}: {
  session: WorkshopSessionDetail;
  busy: boolean;
  onAction: FacilitatorControlRoomProps["onAction"];
}) {
  const { roster, modules } = session;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <caption className="sr-only">
          Participant presence, workspace state, module progress, named probe
          results, and explain-back status
        </caption>
        <thead>
          <tr className="border-b bg-muted/35">
            <th
              scope="col"
              className="sticky left-0 z-10 min-w-44 bg-card px-3 py-2 text-left font-semibold"
            >
              Participant
            </th>
            <th
              scope="col"
              className="min-w-24 px-2 py-2 text-left font-semibold"
            >
              Workspace
            </th>
            {modules.map((module) => (
              <th
                key={module.id}
                scope="col"
                title={module.title}
                className="min-w-40 px-2 py-2 text-left font-mono font-medium"
              >
                {module.id}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {roster.map((member) => (
            <tr
              key={member.userId}
              className="border-b last:border-b-0 hover:bg-muted/30"
            >
              <th
                scope="row"
                className="sticky left-0 z-10 bg-card px-3 py-2 text-left font-medium"
              >
                <span className="block truncate">{member.name}</span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-normal text-muted-foreground">
                  <span className="capitalize">{member.role}</span>
                  <PresenceIndicator member={member} />
                  {workshopMemberHasWorkspace(member) && member.checkedInAt ? (
                    <span>checked in</span>
                  ) : null}
                </span>
              </th>
              <td className="px-2 py-2 text-muted-foreground">
                <span className="block capitalize">
                  {member.workspaceState?.replace("_", " ") ?? "not started"}
                </span>
                {session.viewer.canFacilitate &&
                workshopMemberHasWorkspace(member) &&
                (session.state === "lobby" || session.state === "live") ? (
                  <ParticipantCatchUpControl
                    member={member}
                    checkpoints={session.checkpoints}
                    busy={busy}
                    onAction={onAction}
                  />
                ) : null}
                {member.provisionError ? (
                  <span
                    className="mt-1 block max-w-40 truncate text-[10px] text-destructive"
                    title={member.provisionError}
                  >
                    {member.provisionError}
                  </span>
                ) : null}
              </td>
              {modules.map((module) => {
                const progress = member.progress.find(
                  (candidate) => candidate.moduleId === module.id,
                );
                return (
                  <td key={module.id} className="px-2 py-2 align-top">
                    {progress ? (
                      <RosterModuleCell
                        memberName={member.name}
                        module={module}
                        progress={progress}
                      />
                    ) : (
                      <span
                        className="text-muted-foreground"
                        aria-label={`${member.name}, ${module.title}: no progress`}
                      >
                        —
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PresenceIndicator({ member }: { member: WorkshopRosterMember }) {
  const label = workshopPresenceLabel(member.presenceState);
  const color =
    member.presenceState === "present"
      ? "bg-success"
      : member.presenceState === "stale"
        ? "bg-warning"
        : "bg-muted-foreground/45";
  return (
    <span
      className="inline-flex items-center gap-1.5"
      aria-label={`${member.name} presence: ${label}`}
      title={
        member.lastSeenAt
          ? `${label}; last seen ${new Intl.DateTimeFormat(undefined, {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            }).format(new Date(member.lastSeenAt))}`
          : `${label}; no heartbeat received`
      }
    >
      <span className={`size-2 rounded-full ${color}`} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

function workshopPresenceLabel(state: WorkshopPresenceState): string {
  if (state === "present") return "Present";
  if (state === "stale") return "Stale";
  return "Absent";
}

function ParticipantCatchUpControl({
  member,
  checkpoints,
  busy,
  onAction,
}: {
  member: WorkshopRosterMember;
  checkpoints: WorkshopCheckpoint[];
  busy: boolean;
  onAction: FacilitatorControlRoomProps["onAction"];
}) {
  const available = checkpoints.filter((checkpoint) => checkpoint.released);
  const [checkpointId, setCheckpointId] = useState(available.at(-1)?.id ?? "");
  const retry =
    member.provisionState === "failed" || member.workspaceState === "failed";
  const actionLabel = retry
    ? "Retry"
    : member.workspaceState
      ? "Catch up"
      : "Provision";

  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button
            className="mt-1 h-6 px-1.5 text-[10px]"
            size="xs"
            variant={retry ? "destructive" : "ghost"}
            disabled={busy || available.length === 0}
          />
        }
      >
        <RotateCcw /> {actionLabel}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {actionLabel} {member.name}?
          </DialogTitle>
          <DialogDescription>
            Choose a released canonical checkpoint. Existing work after that
            checkpoint will be archived and replaced; covered modules are
            recorded as caught up, not verified.
          </DialogDescription>
        </DialogHeader>
        <label
          className="space-y-2 text-sm"
          htmlFor={`checkpoint-${member.userId}`}
        >
          <span className="font-medium">Starting checkpoint</span>
          <select
            id={`checkpoint-${member.userId}`}
            value={checkpointId}
            onChange={(event) => setCheckpointId(event.target.value)}
            className="h-10 w-full rounded-lg border border-input bg-card px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
          >
            {available.map((checkpoint) => (
              <option key={checkpoint.id} value={checkpoint.id}>
                {checkpoint.label}
                {checkpoint.coveredModuleIds.length
                  ? ` · covers ${checkpoint.coveredModuleIds.length} modules`
                  : " · clean start"}
              </option>
            ))}
          </select>
        </label>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            Cancel
          </DialogClose>
          <DialogClose
            render={
              <Button
                variant={member.workspaceState ? "destructive" : "default"}
                disabled={busy || !checkpointId}
                onClick={() =>
                  void onAction("catch_up_participant", {
                    participantUserId: member.userId,
                    checkpointId,
                  })
                }
              />
            }
          >
            {actionLabel} learner
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RosterModuleCell({
  memberName,
  module,
  progress,
}: {
  memberName: string;
  module: WorkshopModule;
  progress: WorkshopRosterProgress;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span
          title={`${module.title}: ${workshopModuleStateLabel(progress.state)}`}
          className="inline-flex min-w-0 items-center gap-1.5"
        >
          <ModuleStateGlyph state={progress.state} health={progress.health} />
          <span className="truncate text-[11px] font-medium text-muted-foreground">
            {workshopModuleStateLabel(progress.state)}
          </span>
        </span>
        <ExplainBackStatusBadge status={progress.explainBackStatus} />
      </div>
      {progress.probes.length ? (
        <ul className="space-y-0.5" aria-label={`${module.title} probe status`}>
          {progress.probes.map((probe, probeIndex) => (
            <li
              key={probe.id}
              title={`Verification objective ${probeIndex + 1}: ${verificationStatusLabel(probe.status)}`}
              className="flex min-w-0 items-center justify-between gap-2 font-mono text-[10px] leading-4"
            >
              <span className="truncate text-muted-foreground">
                Verification objective {probeIndex + 1}
              </span>
              <ProbeStatusText probe={probe} />
            </li>
          ))}
        </ul>
      ) : (
        <span className="block text-[10px] text-muted-foreground">
          No probes
        </span>
      )}
      {progress.verificationUnavailable ? (
        <span
          role="status"
          className="block text-[10px] font-semibold text-destructive"
        >
          Verification unavailable
        </span>
      ) : null}
      <span className="sr-only">
        {memberName}, {module.title}: {workshopModuleStateLabel(progress.state)}
        ; explain-back {explainBackStatusLabel(progress.explainBackStatus)}.
      </span>
    </div>
  );
}

function ProbeStatusText({ probe }: { probe: WorkshopProbe }) {
  const passed = isVerificationPassed(probe.status);
  return (
    <span
      className={`shrink-0 font-sans font-semibold ${
        passed ? "text-success" : "text-destructive"
      }`}
    >
      {verificationStatusLabel(probe.status)}
    </span>
  );
}

function ExplainBackStatusBadge({
  status,
}: {
  status: WorkshopExplainBackStatus;
}) {
  const classes =
    status === "completed"
      ? "border-success-border bg-success-subtle text-success"
      : status === "pending"
        ? "border-warning-border bg-warning-subtle text-warning"
        : "border-border bg-muted/50 text-muted-foreground";
  return (
    <span
      title={`Explain-back: ${explainBackStatusLabel(status)}`}
      className={`shrink-0 rounded border px-1 py-0.5 text-[9px] font-semibold tracking-wide uppercase ${classes}`}
    >
      {status === "completed"
        ? "EB done"
        : status === "pending"
          ? "EB due"
          : "EB n/a"}
    </span>
  );
}

function explainBackStatusLabel(status: WorkshopExplainBackStatus): string {
  if (status === "completed") return "completed";
  if (status === "pending") return "pending";
  return "not required";
}

function AgendaControlLedger({
  session,
  busy,
  onAction,
}: {
  session: WorkshopSessionDetail;
  busy: boolean;
  onAction: FacilitatorControlRoomProps["onAction"];
}) {
  return (
    <section
      aria-labelledby="agenda-control-heading"
      className="overflow-hidden rounded-xl border bg-card"
    >
      <div className="border-b px-4 py-3">
        <h3 id="agenda-control-heading" className="text-sm font-semibold">
          Run of show
        </h3>
        <p className="text-xs text-muted-foreground">
          Focus any activity to update Now, its first slide, and its timer.
        </p>
      </div>
      <div className="divide-y">
        {session.agenda.map((item) => {
          const module = item.moduleId
            ? session.modules.find((entry) => entry.id === item.moduleId)
            : null;
          return (
            <div
              key={item.id}
              className="flex flex-wrap items-center gap-3 px-4 py-3"
            >
              <span className="w-8 shrink-0 font-mono text-xs text-muted-foreground">
                {String(item.ordinal + 1).padStart(2, "0")}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">
                  {item.title}
                </span>
                <span className="text-xs text-muted-foreground">
                  {item.kind.replace("_", " ")} · {item.durationMinutes} min
                </span>
              </span>
              {item.active ? (
                <Badge variant="secondary">Now</Badge>
              ) : (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy || Boolean(module && !module.released)}
                  onClick={() =>
                    void onAction("focus_agenda", { agendaItemId: item.id })
                  }
                >
                  Focus
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ModuleControlLedger({
  modules,
  activeModuleId,
  busy,
  onAction,
}: {
  modules: WorkshopModule[];
  activeModuleId: string | null;
  busy: boolean;
  onAction: FacilitatorControlRoomProps["onAction"];
}) {
  return (
    <section
      aria-labelledby="module-control-heading"
      className="overflow-hidden rounded-xl border bg-card"
    >
      <div className="border-b px-4 py-3">
        <h3 id="module-control-heading" className="text-sm font-semibold">
          Module controls
        </h3>
        <p className="text-xs text-muted-foreground">
          Release changes learner access. Focus changes the room’s “Now”
          surface.
        </p>
      </div>
      <div className="divide-y">
        {modules.map((module) => (
          <div
            key={module.id}
            className="flex flex-wrap items-center gap-3 px-4 py-3"
          >
            <ModuleStateGlyph state={module.state} health={module.health} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">
                {module.title}
              </span>
              <span className="text-xs text-muted-foreground">
                {module.tier} · {module.durationMinutes} min
              </span>
            </span>
            <div className="flex flex-wrap gap-1.5">
              {!module.released ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void onAction("release_module", { moduleId: module.id })
                  }
                >
                  Release
                </Button>
              ) : null}
              {activeModuleId !== module.id ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy || !module.released}
                  onClick={() =>
                    void onAction("focus_module", { moduleId: module.id })
                  }
                >
                  Focus
                </Button>
              ) : (
                <Badge variant="secondary">Focused</Badge>
              )}
              {module.solutionMarkdown && !module.solutionRevealed ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void onAction("reveal_solution", { moduleId: module.id })
                  }
                >
                  Reveal solution
                </Button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function HelpQueue({
  members,
  busy,
  canAssist,
  onAction,
  onOpenAssistTerminal,
}: {
  members: WorkshopRosterMember[];
  busy: boolean;
  canAssist: boolean;
  onAction: FacilitatorControlRoomProps["onAction"];
  onOpenAssistTerminal: FacilitatorControlRoomProps["onOpenAssistTerminal"];
}) {
  return (
    <section
      aria-labelledby="help-queue-heading"
      className="overflow-hidden rounded-xl border bg-card"
    >
      <div className="border-b px-4 py-3">
        <h3 id="help-queue-heading" className="text-sm font-semibold">
          Help queue
        </h3>
        <p className="text-xs text-muted-foreground">
          Claiming a request does not grant terminal access.
        </p>
      </div>
      {members.length ? (
        <div className="divide-y">
          {members.map((member) => (
            <div
              key={member.userId}
              className="flex items-center gap-3 px-4 py-3"
            >
              <Radio
                className="size-4 shrink-0 text-warning"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">
                  {member.name}
                </span>
                <span className="text-xs text-muted-foreground capitalize">
                  {member.helpState}
                </span>
              </span>
              {!canAssist ? (
                <Badge variant="outline">Helper required</Badge>
              ) : member.helpState === "open" ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void onAction("claim_help", { userId: member.userId })
                  }
                >
                  Claim
                </Button>
              ) : member.helpAssignedToViewer ? (
                <div className="flex flex-wrap justify-end gap-1.5">
                  {member.assistGrant ? (
                    <Button
                      size="xs"
                      disabled={busy}
                      onClick={() => onOpenAssistTerminal(member)}
                    >
                      <TerminalSquare /> Open terminal
                    </Button>
                  ) : (
                    <Badge variant="outline">Awaiting consent</Badge>
                  )}
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void onAction("resolve_help", { userId: member.userId })
                    }
                  >
                    Resolve
                  </Button>
                </div>
              ) : (
                <Badge variant="warning">Claimed</Badge>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">
          No one is waiting for help.
        </p>
      )}
    </section>
  );
}

function SessionPrimaryControl({
  session,
  busyAction,
  canStart,
  onAction,
}: {
  session: WorkshopSessionDetail;
  busyAction: string | null;
  canStart: boolean;
  onAction: FacilitatorControlRoomProps["onAction"];
}) {
  if (session.state === "draft") {
    return (
      <Button
        size="sm"
        disabled={busyAction != null}
        onClick={() => void onAction("open_lobby")}
      >
        Open lobby
      </Button>
    );
  }
  if (canStart) {
    return (
      <Button
        size="sm"
        disabled={busyAction != null}
        onClick={() => void onAction("go_live")}
      >
        <Play />
        Start workshop
      </Button>
    );
  }
  if (session.state === "live") {
    return (
      <div className="flex gap-2">
        {session.timer ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busyAction != null}
            onClick={() =>
              void onAction(
                session.timer?.pausedAt ? "resume_timer" : "pause_timer",
              )
            }
          >
            {session.timer.pausedAt ? "Resume timer" : "Pause timer"}
          </Button>
        ) : null}
        <Dialog>
          <DialogTrigger render={<Button size="sm" variant="destructive" />}>
            <Square />
            End
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>End this workshop?</DialogTitle>
              <DialogDescription>
                Learner workspaces and app routes will close. Progress and
                recordings remain archived.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose render={<Button variant="outline" />}>
                Keep live
              </DialogClose>
              <DialogClose
                render={
                  <Button
                    variant="destructive"
                    disabled={busyAction != null}
                    onClick={() => void onAction("end_session")}
                  />
                }
              >
                End workshop
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }
  return <Badge variant="outline">Session closed</Badge>;
}

function Metric({
  icon,
  value,
  label,
}: {
  icon: React.ReactNode;
  value: string;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>
      <strong className="font-mono tabular-nums">{value}</strong>
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}

function CapacityFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-mono font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
