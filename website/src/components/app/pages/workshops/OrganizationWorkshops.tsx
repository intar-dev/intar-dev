import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  ArrowRight,
  CalendarPlus,
  CheckCircle2,
  CircleAlert,
  Clock3,
  HardDriveDownload,
  Presentation,
  Server,
  Users,
} from "lucide-react";
import { MetaLine } from "@/components/app/patterns/MetaLine";
import { PageShell } from "@/components/app/patterns/PageShell";
import { ErrorState, EmptyState } from "@/components/app/patterns/StateCard";
import { usePageChrome } from "@/components/app/shell/page-chrome";
import {
  createWorkshopSession,
  getOrganizationWorkshops,
  mutateWorkshopSession,
} from "@/components/app/workshops/api";
import type {
  OrganizationWorkshopTemplate,
  OrganizationWorkshopsResponse,
  WorkshopMemberRole,
  WorkshopSessionSummary,
} from "@/components/app/workshops/types";
import { workshopSessionStateLabel } from "@/components/app/workshops/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

type RosterChoice = WorkshopMemberRole | "excluded";

export function OrganizationWorkshops() {
  const { orgId } = useParams({ from: "/app/organizations/$orgId/workshops" });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const workshops = useQuery({
    queryKey: ["organizations", orgId, "workshops"],
    queryFn: () => getOrganizationWorkshops(orgId),
    retry: 1,
    staleTime: 5_000,
    refetchInterval: (query) =>
      query.state.data?.sessions.some(
        (session) => session.state === "live" || session.state === "lobby",
      )
        ? 2_000
        : false,
  });
  const data = workshops.data;

  const chromeAction = useMemo(
    () =>
      data?.organization.role !== "member" ? (
        <Button size="sm" onClick={() => setScheduleOpen(true)}>
          <CalendarPlus />
          <span className="hidden sm:inline">Schedule</span>
        </Button>
      ) : undefined,
    [data?.organization.role],
  );
  usePageChrome({
    title: data
      ? `${data.organization.name} workshops`
      : "Organization workshops",
    action: chromeAction,
  });

  if (workshops.error) {
    return (
      <PageShell width="content">
        <ErrorState
          title="Could not load organization workshops"
          description={
            workshops.error instanceof Error
              ? workshops.error.message
              : "The workshop control plane is unavailable."
          }
          onRetry={() => void workshops.refetch()}
        />
      </PageShell>
    );
  }
  if (!data) return <OrganizationWorkshopsLoading />;

  return (
    <PageShell width="workspace" density="comfortable">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <p className="text-eyebrow">Organization control plane</p>
          <p className="font-heading text-xl font-semibold tracking-[-0.025em]">
            {data.organization.name}
          </p>
          <p className="max-w-[68ch] text-sm text-muted-foreground">
            Private templates, fixed rosters, runner capacity, and live session
            controls.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          render={<Link to="/organizations/$orgId" params={{ orgId }} />}
        >
          Organization overview
        </Button>
      </header>

      <CapacityLedger data={data} />

      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(22rem,0.72fr)]">
        <TemplateLedger templates={data.templates} />
        <SessionLedger
          sessions={data.sessions}
          members={data.members}
          viewerUserId={data.viewer.userId}
          onRosterUpdated={() =>
            queryClient.invalidateQueries({
              queryKey: ["organizations", orgId, "workshops"],
            })
          }
        />
      </div>

      <ScheduleWorkshopDialog
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        data={data}
        onCreated={async (sessionId) => {
          await Promise.all([
            queryClient.invalidateQueries({
              queryKey: ["organizations", orgId, "workshops"],
            }),
            queryClient.invalidateQueries({ queryKey: ["workshops", "list"] }),
          ]);
          void navigate({
            to: "/workshops/$sessionId",
            params: { sessionId },
          });
        }}
      />
    </PageShell>
  );
}

function CapacityLedger({ data }: { data: OrganizationWorkshopsResponse }) {
  return (
    <section
      aria-labelledby="workshop-capacity-heading"
      className="overflow-hidden rounded-xl border bg-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:px-6">
        <div>
          <p className="text-eyebrow">Preflight</p>
          <h2
            id="workshop-capacity-heading"
            className="mt-1 text-section-title"
          >
            Runner capacity
          </h2>
        </div>
        {data.capacity ? (
          <Badge
            variant={
              data.capacity.imagesReady &&
              data.capacity.seatsAvailable >= data.capacity.seatsRequired
                ? "success"
                : "warning"
            }
          >
            {data.capacity.imagesReady ? "Images ready" : "Images warming"}
          </Badge>
        ) : (
          <Badge variant="outline">No live preflight</Badge>
        )}
      </div>
      <div className="grid divide-y sm:grid-cols-4 sm:divide-x sm:divide-y-0">
        <CapacityMetric
          icon={<Users />}
          label="Available seats"
          value={
            data.capacity
              ? `${data.capacity.seatsAvailable}/${data.capacity.seatsTotal}`
              : "—"
          }
        />
        <CapacityMetric
          icon={<Server />}
          label="Healthy runners"
          value={data.capacity ? String(data.capacity.healthyRunners) : "—"}
        />
        <CapacityMetric
          icon={<HardDriveDownload />}
          label="Checked in"
          value={data.capacity ? String(data.capacity.checkedIn) : "—"}
        />
        <CapacityMetric
          icon={<CheckCircle2 />}
          label="Provisioned"
          value={data.capacity ? String(data.capacity.provisioned) : "—"}
        />
      </div>
      {data.capacity ? (
        <div className="space-y-4 border-t px-4 py-4 sm:px-6">
          <p className="text-xs text-muted-foreground">
            Each learner reserves {data.capacity.seatResources.cpuMillis}m CPU,{
              " "
            }
            {formatWorkshopMib(data.capacity.seatResources.memoryMib)} memory,
            and {formatWorkshopMib(data.capacity.seatResources.worstCaseDiskMib)}{
              " "
            }
            worst-case disk.
          </p>
          {data.capacity.runners.length ? (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[42rem] text-left text-xs">
                <thead className="border-b bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Runner</th>
                    <th className="px-3 py-2 font-medium">Seats</th>
                    <th className="px-3 py-2 font-medium">Images</th>
                    <th className="px-3 py-2 font-medium">Free CPU</th>
                    <th className="px-3 py-2 font-medium">Free memory</th>
                    <th className="px-3 py-2 font-medium">Free disk</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {data.capacity.runners.map((runner) => (
                    <tr key={runner.hostId}>
                      <td className="px-3 py-2 font-mono">{runner.hostId}</td>
                      <td className="px-3 py-2 tabular-nums">
                        {runner.seatsAvailable}/{runner.seatsTotal}
                      </td>
                      <td className="px-3 py-2">
                        {runner.imagesReady
                          ? "Ready"
                          : `Missing ${runner.missingImageVmIds.join(", ")}`}
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        {runner.available.cpuMillis}m
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        {formatWorkshopMib(runner.available.memoryMib)}
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        {formatWorkshopMib(runner.available.worstCaseDiskMib)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {data.capacity.allocationFailures.length ? (
            <div
              className="space-y-2 rounded-lg border border-warning-border bg-warning-subtle p-3"
              role="status"
            >
              <p className="flex items-center gap-2 text-xs font-semibold">
                <CircleAlert className="size-4 text-warning" />
                Allocation blockers
              </p>
              <ul className="space-y-1 text-xs text-muted-foreground">
                {data.capacity.allocationFailures.map((failure) => (
                  <li key={`${failure.hostId}:${failure.reason}`}>
                    <span className="font-mono text-foreground">
                      {failure.hostId}
                    </span>{" "}
                    — {failure.detail}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function formatWorkshopMib(value: number): string {
  return value >= 1024 && value % 1024 === 0
    ? `${value / 1024} GiB`
    : `${value} MiB`;
}

function shortRevision(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}

function TemplateLedger({
  templates,
}: {
  templates: OrganizationWorkshopTemplate[];
}) {
  return (
    <section aria-labelledby="workshop-templates-heading" className="space-y-3">
      <div>
        <p className="text-eyebrow">Private catalog</p>
        <h2 id="workshop-templates-heading" className="mt-1 text-section-title">
          Workshop templates
        </h2>
      </div>
      {templates.length ? (
        <div className="divide-y overflow-hidden rounded-xl border bg-card">
          {templates.map((template) => (
            <div
              key={template.id}
              className="flex items-start gap-4 px-4 py-4 sm:px-6"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <Presentation className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-card-title">{template.title}</h3>
                  <TemplateStatusBadge status={template.status} />
                </div>
                <p className="mt-1 max-w-[68ch] text-sm text-muted-foreground">
                  {template.summary}
                </p>
                <MetaLine
                  className="mt-2"
                  items={[
                    `revision ${template.latestRevision}`,
                    `${template.moduleCount} modules`,
                    `${template.durationMinutes} min`,
                    template.slug,
                  ]}
                />
                <details className="mt-3 text-xs">
                  <summary className="w-fit cursor-pointer font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    Revision history ({template.revisionCount})
                  </summary>
                  <ul
                    className="mt-2 divide-y rounded-lg border"
                    aria-label={`${template.title} revisions`}
                  >
                    {template.revisions.map((revision) => (
                      <li
                        key={revision.id}
                        className="grid gap-1 px-3 py-2 sm:grid-cols-[5rem_minmax(0,1fr)_auto] sm:items-center"
                      >
                        <span className="flex items-center gap-2 font-mono font-semibold">
                          r{revision.revision}
                          {revision.current ? (
                            <Badge variant="success">Current</Badge>
                          ) : null}
                        </span>
                        <span className="truncate text-muted-foreground">
                          source {shortRevision(revision.sourceRevision)} · bundle{" "}
                          {revision.contentHash.slice(0, 10)}
                        </span>
                        <span className="text-muted-foreground">
                          {revision.moduleCount} modules · {revision.durationMinutes} min
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<Presentation />}
          title="No private templates"
          description="Publish a validated bundle with intar-workshop-cli before scheduling a session."
          className="shadow-none"
        />
      )}
    </section>
  );
}

function SessionLedger({
  sessions,
  members,
  viewerUserId,
  onRosterUpdated,
}: {
  sessions: WorkshopSessionSummary[];
  members: OrganizationWorkshopsResponse["members"];
  viewerUserId: string;
  onRosterUpdated: () => Promise<unknown>;
}) {
  const ordered = [...sessions].sort((a, b) => b.startsAt - a.startsAt);
  const [editing, setEditing] = useState<WorkshopSessionSummary | null>(null);
  return (
    <section
      aria-labelledby="organization-sessions-heading"
      className="space-y-3"
    >
      <div>
        <p className="text-eyebrow">Run of record</p>
        <h2
          id="organization-sessions-heading"
          className="mt-1 text-section-title"
        >
          Sessions
        </h2>
      </div>
      {ordered.length ? (
        <div className="divide-y overflow-hidden rounded-xl border bg-card">
          {ordered.map((session) => (
            <div
              key={session.id}
              className="flex items-center gap-3 px-4 py-4 transition-colors hover:bg-muted/45"
            >
              <Link
                to="/workshops/$sessionId"
                params={{ sessionId: session.id }}
                className="group min-w-0 flex-1"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-semibold group-hover:underline">
                    {session.title}
                  </span>
                  <Badge
                    variant={session.state === "live" ? "default" : "outline"}
                  >
                    {workshopSessionStateLabel(session.state)}
                  </Badge>
                </span>
                <MetaLine
                  className="mt-1"
                  items={[
                    formatSessionDate(session.startsAt),
                    `${session.participantCount} learners`,
                    session.currentModuleTitle,
                  ]}
                />
              </Link>
              {session.state === "draft" && session.draftRoster ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setEditing(session)}
                >
                  Edit roster
                </Button>
              ) : null}
              <ArrowRight className="size-4 text-muted-foreground" />
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<Clock3 />}
          title="No sessions scheduled"
          description="Choose a ready template and assign an explicit organization roster."
          className="shadow-none"
        />
      )}
      {editing ? (
        <EditRosterDialog
          session={editing}
          members={members}
          viewerUserId={viewerUserId}
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          onSaved={async () => {
            setEditing(null);
            await onRosterUpdated();
          }}
        />
      ) : null}
    </section>
  );
}

function ScheduleWorkshopDialog({
  open,
  onOpenChange,
  data,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: OrganizationWorkshopsResponse;
  onCreated: (sessionId: string) => Promise<void>;
}) {
  const readyTemplates = data.templates.filter(
    (template) => template.status === "ready",
  );
  const revisionOptions = readyTemplates.flatMap((template) =>
    template.revisions.map((revision) => ({ template, revision })),
  );
  const [templateRevisionId, setTemplateRevisionId] = useState(
    readyTemplates[0]?.currentRevisionId ?? revisionOptions[0]?.revision.id ?? "",
  );
  const [title, setTitle] = useState(readyTemplates[0]?.title ?? "");
  const [startsAt, setStartsAt] = useState(defaultScheduleValue);
  const [roster, setRoster] = useState<Record<string, RosterChoice>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setRoster((current) => {
      if (Object.keys(current).length) return current;
      return Object.fromEntries(
        data.members.map((member) => [
          member.userId,
          member.userId === data.viewer.userId
            ? ("facilitator" as const)
            : ("excluded" as const),
        ]),
      );
    });
  }, [data.members, data.viewer.userId, open]);

  const selectedMembers = Object.entries(roster).flatMap(([userId, role]) =>
    role === "excluded" ? [] : [{ userId, role }],
  );
  const participantCount = selectedMembers.filter(
    (member) => member.role === "participant",
  ).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Schedule a workshop</DialogTitle>
          <DialogDescription>
            Pin a ready template revision and choose every person who may enter
            the room.
          </DialogDescription>
        </DialogHeader>
        {readyTemplates.length ? (
          <form
            id="schedule-workshop-form"
            className="space-y-5"
            onSubmit={async (event) => {
              event.preventDefault();
              setError(null);
              const timestamp = new Date(startsAt).getTime();
              if (!Number.isFinite(timestamp)) {
                setError("Choose a valid start time.");
                return;
              }
              if (!participantCount) {
                setError("Choose at least one participant.");
                return;
              }
              setBusy(true);
              try {
                const response = await createWorkshopSession(
                  data.organization.id,
                  {
                    templateRevisionId,
                    title: title.trim(),
                    startsAt: timestamp,
                    members: selectedMembers,
                  },
                );
                onOpenChange(false);
                await onCreated(response.session.id);
              } catch (scheduleError) {
                setError(
                  scheduleError instanceof Error
                    ? scheduleError.message
                    : "Could not schedule the workshop",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-1.5 text-sm font-medium">
                Template revision
                <select
                  value={templateRevisionId}
                  onChange={(event) => {
                    const id = event.target.value;
                    setTemplateRevisionId(id);
                    const selected = revisionOptions.find(
                      (candidate) => candidate.revision.id === id,
                    );
                    if (selected) setTitle(selected.template.title);
                  }}
                  className="h-11 w-full rounded-lg border border-input bg-card px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
                >
                  {readyTemplates.map((template) => (
                    <optgroup key={template.id} label={template.title}>
                      {template.revisions.map((revision) => (
                        <option key={revision.id} value={revision.id}>
                          r{revision.revision}
                          {revision.current ? " · current" : ""} ·{" "}
                          {revision.moduleCount} modules · {revision.durationMinutes} min
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                Start time
                <Input
                  type="datetime-local"
                  value={startsAt}
                  onChange={(event) => setStartsAt(event.target.value)}
                  required
                />
              </label>
            </div>
            <label className="block space-y-1.5 text-sm font-medium">
              Session title
              <Input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                required
                maxLength={120}
              />
            </label>

            <RosterEditor
              members={data.members}
              viewerUserId={data.viewer.userId}
              roster={roster}
              participantCount={participantCount}
              onChange={setRoster}
            />
            {error ? (
              <p
                role="alert"
                className="flex items-start gap-2 text-sm text-destructive"
              >
                <CircleAlert className="mt-0.5 size-4 shrink-0" /> {error}
              </p>
            ) : null}
          </form>
        ) : (
          <div className="rounded-lg border border-dashed px-4 py-8 text-center">
            <p className="text-sm font-semibold">No template is ready</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Wait for the checkpoint build to finish before scheduling.
            </p>
          </div>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            type="button"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          {readyTemplates.length ? (
            <Button
              type="submit"
              form="schedule-workshop-form"
              disabled={
                busy ||
                !title.trim() ||
                !templateRevisionId ||
                participantCount === 0
              }
            >
              {busy ? "Scheduling…" : "Schedule workshop"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditRosterDialog({
  session,
  members,
  viewerUserId,
  open,
  onOpenChange,
  onSaved,
}: {
  session: WorkshopSessionSummary;
  members: OrganizationWorkshopsResponse["members"];
  viewerUserId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const [roster, setRoster] = useState<Record<string, RosterChoice>>(() => {
    const selected = new Map(
      (session.draftRoster ?? []).map((entry) => [entry.userId, entry.role]),
    );
    if (!selected.has(viewerUserId)) {
      selected.set(viewerUserId, "facilitator");
    }
    return Object.fromEntries(
      members.map((member) => [
        member.userId,
        selected.get(member.userId) ?? "excluded",
      ]),
    );
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedMembers = Object.entries(roster).flatMap(([userId, role]) =>
    role === "excluded" ? [] : [{ userId, role }],
  );
  const participantCount = selectedMembers.filter(
    (member) => member.role === "participant",
  ).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit the draft roster</DialogTitle>
          <DialogDescription>
            Changes are version-checked and lock as soon as the lobby opens or
            workspace provisioning begins.
          </DialogDescription>
        </DialogHeader>
        <form
          id="edit-workshop-roster-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!participantCount) {
              setError("Choose at least one participant.");
              return;
            }
            setBusy(true);
            setError(null);
            try {
              await mutateWorkshopSession(
                session.id,
                "replace_roster",
                session.version,
                { members: selectedMembers },
              );
              await onSaved();
            } catch (updateError) {
              setError(
                updateError instanceof Error
                  ? updateError.message
                  : "Could not update the roster",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <RosterEditor
            members={members}
            viewerUserId={viewerUserId}
            roster={roster}
            participantCount={participantCount}
            onChange={setRoster}
          />
          {error ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </form>
        <DialogFooter>
          <Button
            variant="outline"
            type="button"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form="edit-workshop-roster-form"
            disabled={busy || participantCount === 0}
          >
            {busy ? "Saving…" : "Save roster"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RosterEditor({
  members,
  viewerUserId,
  roster,
  participantCount,
  onChange,
}: {
  members: OrganizationWorkshopsResponse["members"];
  viewerUserId: string;
  roster: Record<string, RosterChoice>;
  participantCount: number;
  onChange: (roster: Record<string, RosterChoice>) => void;
}) {
  return (
    <fieldset>
      <legend className="text-sm font-semibold">Session roster</legend>
      <p className="mt-1 text-xs text-muted-foreground">
        {participantCount} participant{participantCount === 1 ? "" : "s"} ·
        helpers need learner consent before terminal access.
      </p>
      <div className="mt-2 divide-y overflow-hidden rounded-lg border">
        {members.map((member) => {
          const viewer = member.userId === viewerUserId;
          return (
            <div
              key={member.userId}
              className="grid grid-cols-[minmax(0,1fr)_9rem] items-center gap-3 px-3 py-2"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {member.name}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {member.email}
                </span>
              </span>
              <label>
                <span className="sr-only">Role for {member.name}</span>
                <select
                  value={roster[member.userId] ?? "excluded"}
                  onChange={(event) =>
                    onChange({
                      ...roster,
                      [member.userId]: event.target.value as RosterChoice,
                    })
                  }
                  className="h-9 w-full rounded-lg border border-input bg-card px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  <option value="participant">Participant</option>
                  <option value="helper">Helper</option>
                  <option value="facilitator">Facilitator</option>
                  <option value="excluded" disabled={viewer}>
                    Not enrolled
                  </option>
                </select>
              </label>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

function CapacityMetric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-4 sm:px-5">
      <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>
      <span>
        <span className="block font-mono text-lg font-semibold tabular-nums">
          {value}
        </span>
        <span className="block text-xs text-muted-foreground">{label}</span>
      </span>
    </div>
  );
}

function TemplateStatusBadge({
  status,
}: {
  status: OrganizationWorkshopTemplate["status"];
}) {
  if (status === "ready") return <Badge variant="success">Ready</Badge>;
  if (status === "failed")
    return <Badge variant="destructive">Build failed</Badge>;
  return <Badge variant="warning">Building</Badge>;
}

function defaultScheduleValue() {
  const value = new Date();
  value.setDate(value.getDate() + 1);
  value.setHours(9, 0, 0, 0);
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function formatSessionDate(at: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(at));
}

function OrganizationWorkshopsLoading() {
  return (
    <PageShell width="workspace">
      <div role="status" className="space-y-6">
        <span className="sr-only">Loading organization workshops…</span>
        <Skeleton className="h-20 w-full max-w-2xl" />
        <Skeleton className="h-36 w-full rounded-xl" />
        <div className="grid gap-6 xl:grid-cols-2">
          <Skeleton className="h-80 w-full rounded-xl" />
          <Skeleton className="h-80 w-full rounded-xl" />
        </div>
      </div>
    </PageShell>
  );
}
