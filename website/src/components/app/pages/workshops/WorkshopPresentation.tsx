import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowRight,
  Expand,
  MonitorUp,
  NotebookPen,
  Presentation,
} from "lucide-react";
import { Markdown } from "@/components/app/Markdown";
import { PageShell } from "@/components/app/patterns/PageShell";
import { ErrorState, EmptyState } from "@/components/app/patterns/StateCard";
import { usePageChrome } from "@/components/app/shell/page-chrome";
import { WorkshopSlideFrame } from "@/components/app/workshops/WorkshopSlide";
import { WorkshopTimer } from "@/components/app/workshops/WorkshopTimer";
import { mutateWorkshopSession } from "@/components/app/workshops/api";
import type { WorkshopSessionDetail } from "@/components/app/workshops/types";
import {
  useWorkshopSession,
  workshopSessionQueryKey,
} from "@/components/app/workshops/useWorkshopSession";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export function WorkshopPresentation() {
  const { sessionId } = useParams({
    from: "/app/workshops/$sessionId/present",
  });
  return <WorkshopDeckRoute sessionId={sessionId} mode="presenter" />;
}

export function WorkshopProjector() {
  const { sessionId } = useParams({
    from: "/app/workshops/$sessionId/projector",
  });
  return <WorkshopDeckRoute sessionId={sessionId} mode="projector" />;
}

function WorkshopDeckRoute({
  sessionId,
  mode,
}: {
  sessionId: string;
  mode: "presenter" | "projector";
}) {
  const workshop = useWorkshopSession(
    sessionId,
    mode === "projector" ? "projector" : "room",
  );
  const session = workshop.data?.session;
  const title = session
    ? `${session.title} · ${mode === "presenter" ? "Presenter" : "Projector"}`
    : mode === "presenter"
      ? "Workshop presenter"
      : "Workshop projector";
  usePageChrome({ title });

  if (workshop.error) {
    return (
      <PageShell width="content">
        <ErrorState
          title="Could not load the presentation"
          description={
            workshop.error instanceof Error
              ? workshop.error.message
              : "The workshop deck is unavailable."
          }
          onRetry={() => void workshop.refetch()}
        />
      </PageShell>
    );
  }
  if (!session) return <DeckLoading />;
  return mode === "presenter" ? (
    <PresenterDeck session={session} />
  ) : (
    <ProjectorDeck session={session} />
  );
}

function PresenterDeck({ session }: { session: WorkshopSessionDetail }) {
  const queryClient = useQueryClient();
  const [ordinal, setOrdinal] = useState(session.currentSlideOrdinal);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fullscreenRef = useRef<HTMLDivElement | null>(null);
  const slides = session.slides;

  useEffect(
    () => setOrdinal(session.currentSlideOrdinal),
    [session.currentSlideOrdinal],
  );
  const boundedOrdinal = Math.min(
    Math.max(ordinal, 0),
    Math.max(slides.length - 1, 0),
  );
  const slide = slides[boundedOrdinal];

  const showSlide = useCallback(
    async (next: number) => {
      if (busy || !slides.length || !session.viewer.canPresent) return;
      const bounded = Math.min(Math.max(next, 0), slides.length - 1);
      const requestedSlide = slides[bounded];
      if (!requestedSlide || requestedSlide.id === session.currentSlideId) {
        return;
      }
      setOrdinal(bounded);
      setBusy(true);
      setError(null);
      try {
        const response = await mutateWorkshopSession(
          session.id,
          "set_slide",
          session.version,
          { slideOrdinal: bounded },
        );
        queryClient.setQueryData(workshopSessionQueryKey(session.id), response);
      } catch (actionError) {
        setOrdinal(session.currentSlideOrdinal);
        setError(
          actionError instanceof Error
            ? actionError.message
            : "Could not change the room slide",
        );
      } finally {
        setBusy(false);
      }
    },
    [
      boundedOrdinal,
      busy,
      queryClient,
      session.currentSlideOrdinal,
      session.currentSlideId,
      session.id,
      session.version,
      session.viewer.canPresent,
      slides.length,
    ],
  );
  const runControlAction = useCallback(
    async (action: string, payload: Record<string, unknown> = {}) => {
      if (busy || !session.viewer.canPresent) return;
      setBusy(true);
      setError(null);
      try {
        const response = await mutateWorkshopSession(
          session.id,
          action,
          session.version,
          payload,
        );
        queryClient.setQueryData(workshopSessionQueryKey(session.id), response);
      } catch (actionError) {
        setError(
          actionError instanceof Error
            ? actionError.message
            : "Could not update the presentation",
        );
      } finally {
        setBusy(false);
      }
    }, [
      busy,
      queryClient,
      session.id,
      session.version,
      session.viewer.canPresent,
    ],
  );

  useDeckKeyboard({
    enabled: true,
    current: boundedOrdinal,
    last: Math.max(slides.length - 1, 0),
    onNavigate: showSlide,
    onFullscreen: () => void fullscreenRef.current?.requestFullscreen(),
  });

  if (!slides.length) {
    return (
      <PageShell width="content">
        <EmptyState
          icon={<Presentation />}
          title="This revision has no slides"
          description="Publish a presentation in the workshop bundle before opening presenter mode."
        />
      </PageShell>
    );
  }
  if (!slide) return null;

  return (
    <PageShell width="workspace" density="compact">
      <div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div
          ref={fullscreenRef}
          className="min-w-0 space-y-3 bg-background fullscreen:flex fullscreen:flex-col fullscreen:justify-center fullscreen:p-8"
        >
          <WorkshopSlideFrame slide={slide} />
          <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-card px-3 py-2">
            <Button
              size="sm"
              variant="outline"
              aria-label="Previous slide"
              disabled={busy || boundedOrdinal === 0}
              onClick={() => void showSlide(boundedOrdinal - 1)}
            >
              <ArrowLeft />
            </Button>
            <span className="min-w-20 text-center font-mono text-xs text-muted-foreground tabular-nums">
              {boundedOrdinal + 1} / {slides.length}
            </span>
            <Button
              size="sm"
              variant="outline"
              aria-label="Next slide"
              disabled={busy || boundedOrdinal === slides.length - 1}
              onClick={() => void showSlide(boundedOrdinal + 1)}
            >
              <ArrowRight />
            </Button>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <WorkshopTimer timer={session.timer} />
              {slide.id !== session.currentSlideId ? (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void showSlide(boundedOrdinal)}
                >
                  <MonitorUp /> Show slide
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                aria-label="Enter fullscreen"
                onClick={() => void fullscreenRef.current?.requestFullscreen()}
              >
                <Expand />
              </Button>
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
                <MonitorUp /> Projector
              </Button>
            </div>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}.
            </p>
          ) : null}
        </div>

        <aside
          aria-labelledby="presenter-notes-heading"
          className="min-h-0 overflow-hidden rounded-xl border bg-card"
        >
          <div className="flex items-center gap-2 border-b px-4 py-3">
            <NotebookPen className="size-4 text-muted-foreground" />
            <h2 id="presenter-notes-heading" className="text-sm font-semibold">
              Presenter notes
            </h2>
          </div>
          <div className="max-h-[calc(100dvh-10rem)] overflow-auto px-4 py-4">
            {slide.notesMarkdown ? (
              <Markdown>{slide.notesMarkdown}</Markdown>
            ) : (
              <p className="text-sm text-muted-foreground">
                No notes for this slide.
              </p>
            )}
          </div>
          <PresenterControls
            session={session}
            slideId={slide.id}
            slideModuleId={slide.moduleId}
            busy={busy}
            onAction={runControlAction}
          />
          <div className="border-t bg-muted/35 px-4 py-3 text-xs text-muted-foreground">
            <p>
              <kbd className="font-mono">←</kbd>{" "}
              <kbd className="font-mono">→</kbd> navigate ·{" "}
              <kbd className="font-mono">F</kbd> fullscreen
            </p>
          </div>
        </aside>
      </div>
    </PageShell>
  );
}

function PresenterControls({
  session,
  slideId,
  slideModuleId,
  busy,
  onAction,
}: {
  session: WorkshopSessionDetail;
  slideId: string;
  slideModuleId: string | null;
  busy: boolean;
  onAction: (
    action: string,
    payload?: Record<string, unknown>,
  ) => Promise<void>;
}) {
  const module = slideModuleId
    ? (session.modules.find((entry) => entry.id === slideModuleId) ?? null)
    : null;
  const agendaItem =
    session.agenda.find(
      (item) => item.active && item.slideIds.includes(slideId),
    ) ??
    session.agenda.find(
      (item) => item.scheduled && item.slideIds.includes(slideId),
    ) ??
    session.agenda.find((item) => item.slideIds.includes(slideId)) ??
    null;
  return (
    <div className="space-y-3 border-t px-4 py-3">
      <div>
        <p className="text-eyebrow">Live controls</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {agendaItem?.title ?? module?.title ?? "This slide has no activity."}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {module && !module.released ? (
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void onAction("release_module", { moduleId: module.id })
            }
          >
            Release module
          </Button>
        ) : null}
        {agendaItem &&
        !agendaItem.active &&
        (!module || module.released) ? (
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void onAction("focus_agenda", { agendaItemId: agendaItem.id })
            }
          >
            Focus activity
          </Button>
        ) : null}
        {module?.released &&
        module.solutionMarkdown &&
        !module.solutionRevealed ? (
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
        {session.state === "live" && session.timer ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void onAction(
                session.timer?.pausedAt ? "resume_timer" : "pause_timer",
              )
            }
          >
            {session.timer.pausedAt ? "Resume timer" : "Pause timer"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ProjectorDeck({ session }: { session: WorkshopSessionDetail }) {
  const fullscreenRef = useRef<HTMLDivElement | null>(null);
  const current = session.currentSlideId
    ? session.slides.find((candidate) => candidate.id === session.currentSlideId)
    : null;
  const slide = current?.released ? current : null;
  const releasedModules = session.modules.filter((module) => module.released);
  const focusedModule = session.currentModuleId
    ? session.modules.find(
        (module) =>
          module.id === session.currentModuleId && module.released,
      )
    : null;
  const outcomeModule =
    focusedModule ?? releasedModules[releasedModules.length - 1] ?? null;

  useDeckKeyboard({
    enabled: true,
    current: 0,
    last: 0,
    onNavigate: async () => {},
    onFullscreen: () => void fullscreenRef.current?.requestFullscreen(),
    fullscreenOnly: true,
  });

  return (
    <div
      ref={fullscreenRef}
      data-workshop-projector
      className="flex min-h-svh w-full flex-1 flex-col justify-center gap-3 bg-background p-3 sm:p-4 fullscreen:p-8"
    >
      <h1 className="sr-only">{session.title} projector</h1>
      {slide ? (
        <WorkshopSlideFrame slide={slide} projector />
      ) : (
        <div className="flex aspect-video items-center justify-center rounded-xl border border-terminal-border bg-terminal-background px-8 text-center text-terminal-foreground">
          <div>
            <p className="font-mono text-xs tracking-[0.15em] text-terminal-brand uppercase">
              intar workshop
            </p>
            <h2 className="mt-4 font-heading text-3xl font-semibold sm:text-5xl">
              Waiting for the facilitator
            </h2>
          </div>
        </div>
      )}
      {outcomeModule ? (
        <div className="rounded-xl border border-primary/25 bg-primary/5 px-4 py-3 sm:px-6 sm:py-4">
          <p className="text-xs font-semibold tracking-[0.14em] text-primary uppercase">
            Now · {outcomeModule.title}
          </p>
          <p className="mt-1 font-heading text-xl font-semibold text-balance sm:text-3xl">
            {outcomeModule.outcome}
          </p>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-4 rounded-xl border bg-card px-4 py-3 sm:px-6">
        <WorkshopTimer timer={session.timer} size="large" />
        {session.announcement ? (
          <p className="min-w-0 flex-1 text-sm font-medium sm:text-base">
            {session.announcement}
          </p>
        ) : (
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">
            {session.organizationName}
          </p>
        )}
        <Badge variant={session.state === "live" ? "default" : "outline"}>
          {session.state === "live" ? "Live" : session.state}
        </Badge>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Enter fullscreen"
          onClick={() => void fullscreenRef.current?.requestFullscreen()}
        >
          <Expand />
        </Button>
      </div>
    </div>
  );
}

function useDeckKeyboard(input: {
  enabled: boolean;
  current: number;
  last: number;
  onNavigate: (ordinal: number) => Promise<void>;
  onFullscreen: () => void;
  fullscreenOnly?: boolean;
}) {
  const { enabled, current, last, onNavigate, onFullscreen, fullscreenOnly } =
    input;
  useEffect(() => {
    if (!enabled) return;
    const listener = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        onFullscreen();
        return;
      }
      if (fullscreenOnly) return;
      if (["ArrowRight", "PageDown", " "].includes(event.key)) {
        event.preventDefault();
        void onNavigate(Math.min(last, current + 1));
      } else if (["ArrowLeft", "PageUp"].includes(event.key)) {
        event.preventDefault();
        void onNavigate(Math.max(0, current - 1));
      } else if (event.key === "Home") {
        event.preventDefault();
        void onNavigate(0);
      } else if (event.key === "End") {
        event.preventDefault();
        void onNavigate(last);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [current, enabled, fullscreenOnly, last, onFullscreen, onNavigate]);
}

function DeckLoading() {
  return (
    <PageShell width="workspace">
      <div role="status" className="space-y-4">
        <span className="sr-only">Loading workshop presentation…</span>
        <Skeleton className="aspect-video w-full rounded-xl" />
        <Skeleton className="h-14 w-full rounded-xl" />
      </div>
    </PageShell>
  );
}
