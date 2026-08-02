import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  AppWindow,
  CheckCircle2,
  CircleAlert,
  Clock3,
  ExternalLink,
  Hand,
  MonitorUp,
  Presentation,
  Radio,
  RotateCcw,
  TerminalSquare,
  Users,
} from "lucide-react";
import { Markdown } from "@/components/app/Markdown";
import { FacilitatorControlRoom } from "@/components/app/workshops/FacilitatorControlRoom";
import {
  WorkshopAgendaRail,
  WorkshopModuleManual,
} from "@/components/app/workshops/WorkshopAgenda";
import { WorkshopTimer } from "@/components/app/workshops/WorkshopTimer";
import {
  closeWorkshopHelpRequest,
  createWorkshopHelpRequest,
  mutateWorkshopSession,
  openWorkshopApplication,
} from "@/components/app/workshops/api";
import type {
  WorkshopSessionDetail,
  WorkshopSessionResponse,
  WorkshopSessionState,
  WorkshopSlide,
  WorkshopWorkspace,
} from "@/components/app/workshops/types";
import {
  workshopMemberHasWorkspace,
  workshopSessionStateLabel,
} from "@/components/app/workshops/types";
import {
  useWorkshopSession,
  workshopSessionQueryKey,
} from "@/components/app/workshops/useWorkshopSession";
import { MetaLine } from "@/components/app/patterns/MetaLine";
import { PageShell } from "@/components/app/patterns/PageShell";
import { ErrorState } from "@/components/app/patterns/StateCard";
import { usePageChrome } from "@/components/app/shell/page-chrome";
import { WebSshTerminal } from "@/components/remote-access/WebSshTerminal";
import { NativeSshDialogButton } from "@/components/remote-access/NativeSshDialogButton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

export function WorkshopRoom() {
  const { sessionId } = useParams({ from: "/app/workshops/$sessionId" });
  const queryClient = useQueryClient();
  const workshop = useWorkshopSession(sessionId);
  const session = workshop.data?.session;
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [assistTerminal, setAssistTerminal] = useState<{
    workspaceId: string;
    learnerName: string;
  } | null>(null);

  const chromeStatus = useMemo(
    () => (session ? <SessionStateBadge state={session.state} /> : undefined),
    [session],
  );
  const chromeAction = useMemo(
    () =>
      session?.viewer.canPresent ? (
        <Button
          size="sm"
          render={
            <Link
              to="/workshops/$sessionId/present"
              params={{ sessionId: session.id }}
            />
          }
        >
          <Presentation />
          <span className="hidden sm:inline">Present</span>
        </Button>
      ) : undefined,
    [session],
  );
  usePageChrome({
    title: session?.title,
    status: chromeStatus,
    action: chromeAction,
  });

  const commitResponse = (response: WorkshopSessionResponse) => {
    queryClient.setQueryData(workshopSessionQueryKey(sessionId), response);
  };

  const performAction = async (
    action: string,
    payload: Record<string, unknown> = {},
  ) => {
    if (!session) return;
    setBusyAction(action);
    setActionError(null);
    try {
      const response = await mutateWorkshopSession(
        session.id,
        action,
        session.version,
        payload,
      );
      commitResponse(response);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Workshop action failed",
      );
      await workshop.refetch();
    } finally {
      setBusyAction(null);
    }
  };

  const openApplication = async (applicationId: string) => {
    if (!session?.workspace) return;
    const openedWindow = window.open("about:blank", "_blank");
    if (openedWindow) openedWindow.opener = null;
    setBusyAction(`open_application:${applicationId}`);
    setActionError(null);
    try {
      const application = await openWorkshopApplication(
        session.id,
        session.workspace.id,
        applicationId,
      );
      if (openedWindow) openedWindow.location.replace(application.url);
      else window.location.assign(application.url);
    } catch (error) {
      openedWindow?.close();
      setActionError(
        error instanceof Error
          ? error.message
          : "Could not open workspace application",
      );
    } finally {
      setBusyAction(null);
    }
  };

  if (workshop.error) {
    return (
      <PageShell width="content">
        <ErrorState
          title="Could not enter the workshop"
          description={
            workshop.error instanceof Error
              ? workshop.error.message
              : "The live room is unavailable."
          }
          onRetry={() => void workshop.refetch()}
        />
      </PageShell>
    );
  }

  if (!session) return <WorkshopRoomLoading />;

  const focusedModule =
    session.modules.find((module) => module.id === session.currentModuleId) ??
    null;
  const currentModule =
    focusedModule ?? session.modules.find((module) => module.released) ?? null;
  const currentSlide = session.currentSlideId
    ? (session.slides.find(
        (slide) => slide.id === session.currentSlideId && slide.released,
      ) ?? null)
    : null;
  const currentAgenda = session.agenda.find((item) => item.active) ?? null;
  const viewerHasWorkspace = workshopMemberHasWorkspace(session.viewer);
  const activeAssistTerminal = assistTerminal
    ? session.roster.find(
        (member) =>
          member.assistGrant?.workspaceId === assistTerminal.workspaceId,
      ) ?? null
    : null;

  return (
    <PageShell width="workspace" density="comfortable">
      <WorkshopRoomHeader session={session} />

      {session.announcement ? (
        <Alert className="border-brand-border bg-brand-subtle">
          <Radio className="text-brand-text" />
          <AlertTitle>From the facilitator</AlertTitle>
          <AlertDescription className="text-foreground">
            {session.announcement}
          </AlertDescription>
        </Alert>
      ) : null}

      {actionError && viewerHasWorkspace ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>That action did not complete</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}

      <WorkshopNow
        session={session}
        currentModule={focusedModule}
        currentAgenda={currentAgenda}
        busy={busyAction != null}
        onAction={performAction}
      />

      {viewerHasWorkspace && currentSlide ? (
        <WorkshopParticipantSlide
          slide={currentSlide}
          totalSlides={session.slides.length}
        />
      ) : null}

      {viewerHasWorkspace ? (
        <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_21rem]">
          <div className="min-w-0 space-y-6">
            {currentModule && currentModule.released ? (
              <WorkshopModuleManual
                module={currentModule}
                busy={busyAction != null}
                onRevealHint={(hintId) =>
                  void performAction("reveal_hint", {
                    moduleId: currentModule.id,
                    hintId,
                  })
                }
                onCompleteExplainBack={() =>
                  void performAction("complete_explain_back", {
                    moduleId: currentModule.id,
                  })
                }
              />
            ) : (
              <WaitingForRelease state={session.state} />
            )}
            {session.workspace ? (
              <WorkshopWorkspacePanel
                sessionId={session.id}
                workspace={session.workspace}
                currentModuleId={currentModule?.id ?? null}
                busy={busyAction != null}
                onOpenTerminal={() => setTerminalOpen(true)}
                onOpenApplication={(applicationId) =>
                  void openApplication(applicationId)
                }
                onRestore={(checkpointId) =>
                  void performAction("restore_checkpoint", {
                    checkpointId,
                    confirmed: true,
                  })
                }
              />
            ) : null}
          </div>
          <div className="space-y-6">
            <WorkshopHelpPanel
              session={session}
              busy={busyAction != null}
              onRequest={async (message) => {
                setBusyAction("request_help");
                setActionError(null);
                try {
                  commitResponse(
                    await createWorkshopHelpRequest(
                      session.id,
                      message,
                      currentModule?.id ?? null,
                    ),
                  );
                } catch (error) {
                  setActionError(
                    error instanceof Error
                      ? error.message
                      : "Could not request help",
                  );
                } finally {
                  setBusyAction(null);
                }
              }}
              onClose={async () => {
                if (!session.helpRequest) return;
                setBusyAction("close_help");
                try {
                  commitResponse(
                    await closeWorkshopHelpRequest(
                      session.id,
                      session.helpRequest.id,
                    ),
                  );
                } finally {
                  setBusyAction(null);
                }
              }}
              onGrant={() => void performAction("grant_assist")}
              onExtend={(grantId) =>
                void performAction("extend_assist", { grantId })
              }
              onRevoke={() => void performAction("revoke_assist")}
            />
            <WorkshopAgendaRail
              agenda={session.agenda}
              modules={session.modules}
            />
          </div>
        </div>
      ) : null}

      {session.viewer.canFacilitate || session.viewer.canAssist ? (
        <FacilitatorControlRoom
          session={session}
          busyAction={busyAction}
          error={actionError}
          onAction={performAction}
          onOpenAssistTerminal={(member) => {
            if (!member.assistGrant) return;
            setAssistTerminal({
              workspaceId: member.assistGrant.workspaceId,
              learnerName: member.name,
            });
          }}
        />
      ) : null}

      {terminalOpen && session.workspace ? (
        <WebSshTerminal
          vmName={session.workspace.vmName}
          title={`${session.title} · ${session.workspace.vmName}`}
          sessionRequest={{
            url: `/api/workshops/${encodeURIComponent(session.id)}/terminal`,
            body: { workspaceId: session.workspace.id },
          }}
          onClose={() => setTerminalOpen(false)}
        />
      ) : null}

      {assistTerminal && activeAssistTerminal ? (
        <WebSshTerminal
          vmName="workshop"
          title={`${session.title} · assisting ${assistTerminal.learnerName}`}
          sessionRequest={{
            url: `/api/workshops/${encodeURIComponent(session.id)}/terminal`,
            body: { workspaceId: assistTerminal.workspaceId },
          }}
          onClose={() => setAssistTerminal(null)}
        />
      ) : null}
    </PageShell>
  );
}

function WorkshopParticipantSlide({
  slide,
  totalSlides,
}: {
  slide: WorkshopSlide;
  totalSlides: number;
}) {
  return (
    <section
      aria-labelledby="workshop-shared-slide-heading"
      className="overflow-hidden rounded-xl border bg-card"
    >
      <div className="flex items-center justify-between gap-3 border-b bg-muted/25 px-4 py-2.5 sm:px-6">
        <p className="text-eyebrow">Shared slide</p>
        <Badge variant="outline">
          {slide.ordinal + 1} / {totalSlides}
        </Badge>
      </div>
      <div className="grid gap-3 px-4 py-4 sm:px-6 sm:py-5 lg:grid-cols-[minmax(12rem,0.38fr)_minmax(0,1fr)] lg:gap-8">
        <h2
          id="workshop-shared-slide-heading"
          className="font-heading text-xl font-semibold tracking-[-0.025em] text-balance sm:text-2xl"
        >
          {slide.title ?? "Workshop update"}
        </h2>
        {slide.bodyMarkdown ? (
          <div className="min-w-0 text-sm leading-6">
            <Markdown>{slide.bodyMarkdown}</Markdown>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function WorkshopRoomHeader({ session }: { session: WorkshopSessionDetail }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0 space-y-1">
        <p className="text-eyebrow">{session.organizationName}</p>
        <p className="font-heading text-xl font-semibold tracking-[-0.025em] text-balance">
          {session.title}
        </p>
        <MetaLine
          items={[
            formatWorkshopDate(session.startsAt),
            `${session.modules.length} modules`,
            session.viewer.role,
          ]}
        />
      </div>
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
        Room screen
      </Button>
    </header>
  );
}

function WorkshopNow({
  session,
  currentModule,
  currentAgenda,
  busy,
  onAction,
}: {
  session: WorkshopSessionDetail;
  currentModule: WorkshopSessionDetail["modules"][number] | null;
  currentAgenda: WorkshopSessionDetail["agenda"][number] | null;
  busy: boolean;
  onAction: (
    action: string,
    payload?: Record<string, unknown>,
  ) => Promise<void>;
}) {
  if (session.state === "draft") {
    return (
      <section className="grid gap-5 rounded-xl border border-dashed px-5 py-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-8">
        <div>
          <p className="text-eyebrow">Next</p>
          <h2 className="mt-2 font-heading text-2xl font-semibold tracking-[-0.025em]">
            {formatLobbyOpening(session)}
          </h2>
          <p className="mt-2 max-w-[68ch] text-sm text-muted-foreground">
            Return here to check your access and prepare your dedicated
            workspace.
          </p>
        </div>
        <Clock3 className="size-10 text-muted-foreground" aria-hidden="true" />
      </section>
    );
  }

  if (session.state === "lobby") {
    return (
      <section className="grid gap-5 rounded-xl border border-brand-border bg-brand-subtle px-5 py-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-8">
        <div>
          <p className="text-eyebrow text-brand-text">Lobby open</p>
          <h2 className="mt-2 font-heading text-2xl font-semibold tracking-[-0.025em]">
            {session.viewer.checkedIn
              ? "You’re checked in."
              : "Let the room know you’re here."}
          </h2>
          <p className="mt-2 max-w-[68ch] text-sm text-muted-foreground">
            The facilitator provisions checked-in workspaces before the first
            lab.
          </p>
        </div>
        {workshopMemberHasWorkspace(session.viewer) ? (
          session.viewer.checkedIn ? (
            <Badge variant="success" className="h-9 px-3">
              <CheckCircle2 /> Ready for preflight
            </Badge>
          ) : (
            <Button disabled={busy} onClick={() => void onAction("check_in")}>
              <Users /> Check in
            </Button>
          )
        ) : (
          <WorkshopTimer timer={session.timer} size="large" />
        )}
      </section>
    );
  }

  if (session.state === "ended" || session.state === "cancelled") {
    return (
      <section className="flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-muted/35 px-5 py-5 sm:px-8">
        <div>
          <p className="text-eyebrow">Session record</p>
          <h2 className="mt-1 text-section-title">
            {session.state === "ended"
              ? "Workshop ended"
              : "Workshop cancelled"}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Your progress remains available below; live workspaces are closed.
          </p>
        </div>
        <Badge variant="outline">Archived</Badge>
      </section>
    );
  }

  return (
    <section className="relative overflow-hidden rounded-xl border border-brand-border bg-card px-5 py-6 sm:px-8 sm:py-8">
      <div
        className="absolute inset-x-0 top-0 h-px bg-primary"
        aria-hidden="true"
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div className="min-w-0">
          <p className="text-eyebrow text-brand-text">Now</p>
          <h2 className="mt-2 max-w-3xl font-heading text-2xl font-semibold tracking-[-0.035em] text-balance sm:text-3xl">
            {currentAgenda?.title ??
              currentModule?.title ??
              "Waiting for the next activity"}
          </h2>
          <p className="mt-3 max-w-[68ch] text-base leading-7 text-muted-foreground text-pretty">
            {currentModule?.outcome ??
              (currentAgenda
                ? `${workshopAgendaKindLabel(currentAgenda.kind)} · ${currentAgenda.durationMinutes} minutes`
                : "The facilitator will focus the room when the next activity is ready.")}
          </p>
        </div>
        <WorkshopTimer timer={session.timer} size="large" />
      </div>
    </section>
  );
}

function WorkshopWorkspacePanel({
  sessionId,
  workspace,
  currentModuleId,
  busy,
  onOpenTerminal,
  onOpenApplication,
  onRestore,
}: {
  sessionId: string;
  workspace: WorkshopWorkspace;
  currentModuleId: string | null;
  busy: boolean;
  onOpenTerminal: () => void;
  onOpenApplication: (applicationId: string) => void;
  onRestore: (checkpointId: string) => void;
}) {
  return (
    <section
      aria-labelledby="workshop-workspace-heading"
      className="overflow-hidden rounded-xl border bg-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:px-6">
        <div>
          <p className="text-eyebrow">Persistent workspace</p>
          <h2
            id="workshop-workspace-heading"
            className="mt-1 text-section-title"
          >
            {workspace.vmName}
          </h2>
        </div>
        <Badge variant={workspaceBadge(workspace.state)}>
          {workspace.state.replace("_", " ")}
        </Badge>
      </div>
      {workspace.recoveryMessage ? (
        <div className="flex items-start gap-3 border-b bg-warning-subtle px-4 py-3 text-sm sm:px-6">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>{workspace.recoveryMessage}</span>
        </div>
      ) : null}
      <div className="flex flex-col gap-5 px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={!workspace.terminalAvailable}
            onClick={onOpenTerminal}
          >
            <TerminalSquare /> Open terminal
          </Button>
          <NativeSshDialogButton
            vmName={workspace.vmName}
            disabled={!workspace.terminalAvailable}
            sessionRequest={{
              url: `/api/workshops/${encodeURIComponent(sessionId)}/terminal`,
              body: { workspaceId: workspace.id },
            }}
          />
          <Dialog>
            <DialogTrigger
              render={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !currentModuleId}
                />
              }
            >
              <RotateCcw /> Catch up
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Restore the canonical checkpoint?</DialogTitle>
                <DialogDescription>
                  This replaces the current VM. Work made after the checkpoint
                  will be lost, while your workshop progress history remains.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose render={<Button variant="outline" />}>
                  Keep workspace
                </DialogClose>
                <DialogClose
                  render={
                    <Button
                      variant="destructive"
                      onClick={() =>
                        currentModuleId && onRestore(currentModuleId)
                      }
                    />
                  }
                >
                  Restore checkpoint
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        <div>
          <p className="mb-2 text-eyebrow">Workspace applications</p>
          {workspace.applications.length ? (
            <div className="divide-y rounded-lg border">
              {workspace.applications.map((application) => (
                <div
                  key={application.id}
                  className="flex min-h-12 items-center gap-3 px-3 py-2"
                >
                  <AppWindow className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 text-sm font-medium">
                    {application.label}
                  </span>
                  {application.available ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => onOpenApplication(application.id)}
                    >
                      Open <ExternalLink />
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      Not released
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Applications appear as modules release them.
            </p>
          )}
        </div>
        <MetaLine
          items={[
            `generation ${workspace.generation}`,
            `checkpoint ${workspace.checkpointId}`,
            sessionId,
          ]}
        />
      </div>
    </section>
  );
}

function WorkshopHelpPanel({
  session,
  busy,
  onRequest,
  onClose,
  onGrant,
  onExtend,
  onRevoke,
}: {
  session: WorkshopSessionDetail;
  busy: boolean;
  onRequest: (message: string) => Promise<void>;
  onClose: () => Promise<void>;
  onGrant: () => void;
  onExtend: (grantId: string) => void;
  onRevoke: () => void;
}) {
  const [message, setMessage] = useState("");
  const help = session.helpRequest;
  const grant = session.assistGrant;

  return (
    <section
      aria-labelledby="help-heading"
      className="rounded-xl border bg-card p-4"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-warning-subtle text-warning">
          <Hand className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="help-heading" className="text-sm font-semibold">
            Need help?
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Raise your hand without sharing your terminal. You control any
            assist access separately.
          </p>
        </div>
      </div>
      {grant ? (
        <div className="mt-3 space-y-2 rounded-lg border border-warning-border bg-warning-subtle p-3 text-xs text-muted-foreground">
          <p>
            {grant.helperName} has browser-terminal access until{" "}
            {formatClockTime(grant.expiresAt)}.
          </p>
          {grant.canExtend ? (
            <Button
              size="xs"
              variant="outline"
              className="w-full"
              disabled={busy}
              onClick={() => onExtend(grant.id)}
            >
              Extend access to 30 minutes
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="destructive"
            className="w-full"
            disabled={busy}
            onClick={onRevoke}
          >
            Revoke access now
          </Button>
        </div>
      ) : null}
      {!help && !grant ? (
        <form
          className="mt-3 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void onRequest(message.trim()).then(() => setMessage(""));
          }}
        >
          <label htmlFor="help-message" className="sr-only">
            What are you stuck on?
          </label>
          <Textarea
            id="help-message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="What are you stuck on?"
            className="min-h-20 text-sm"
            maxLength={500}
          />
          <Button type="submit" size="sm" className="w-full" disabled={busy}>
            Raise hand
          </Button>
        </form>
      ) : help ? (
        <div className="mt-3 space-y-3 rounded-lg border bg-muted/25 p-3">
          <div className="flex items-center justify-between gap-2">
            <Badge variant={help.state === "claimed" ? "warning" : "secondary"}>
              {help.state === "claimed" ? "Helper on the way" : "In the queue"}
            </Badge>
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => void onClose()}
            >
              Lower hand
            </Button>
          </div>
          {help.message ? <p className="text-sm">{help.message}</p> : null}
          {help.state === "claimed" && !grant ? (
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              disabled={busy}
              onClick={onGrant}
            >
              Grant 15-minute terminal assist
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function WaitingForRelease({ state }: { state: WorkshopSessionState }) {
  return (
    <section className="flex min-h-40 flex-col items-center justify-center rounded-xl border border-dashed px-6 py-10 text-center">
      <Clock3 className="size-5 text-muted-foreground" />
      <h2 className="mt-3 text-section-title">
        {state === "lobby" ? "Preflight first" : "Waiting for the next release"}
      </h2>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        The facilitator will release participant instructions when the room is
        ready.
      </p>
    </section>
  );
}

function SessionStateBadge({ state }: { state: WorkshopSessionState }) {
  return (
    <Badge
      variant={
        state === "live"
          ? "default"
          : state === "lobby"
            ? "warning"
            : state === "ended"
              ? "success"
              : "outline"
      }
    >
      {workshopSessionStateLabel(state)}
    </Badge>
  );
}

function workspaceBadge(state: WorkshopWorkspace["state"]) {
  if (state === "ready") return "success" as const;
  if (state === "failed") return "destructive" as const;
  if (state === "recovering" || state === "provisioning")
    return "warning" as const;
  return "outline" as const;
}

function formatWorkshopDate(at: number) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(at));
}

function formatLobbyOpening(session: WorkshopSessionDetail) {
  const leadTime = session.startsAt - session.lobbyOpensAt;
  const minute = 60 * 1_000;
  if (leadTime >= 0 && leadTime % minute === 0) {
    const minutes = leadTime / minute;
    if (minutes === 0) return "The lobby opens when the session starts.";
    return `The lobby opens ${minutes} ${minutes === 1 ? "minute" : "minutes"} before start.`;
  }
  return `The lobby opens ${formatWorkshopDate(session.lobbyOpensAt)}.`;
}

function formatClockTime(at: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(at));
}

function workshopAgendaKindLabel(
  kind: WorkshopSessionDetail["agenda"][number]["kind"],
) {
  return kind.replace("_", " ").replace(/^./, (value) => value.toUpperCase());
}

function WorkshopRoomLoading() {
  return (
    <PageShell width="workspace">
      <div role="status" className="space-y-6">
        <span className="sr-only">Loading workshop room…</span>
        <div className="space-y-2">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-7 w-72 max-w-full" />
        </div>
        <Skeleton className="h-48 w-full rounded-xl" />
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_21rem]">
          <Skeleton className="h-96 w-full rounded-xl" />
          <Skeleton className="h-72 w-full rounded-xl" />
        </div>
      </div>
    </PageShell>
  );
}
