import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouterState } from "@tanstack/react-router";
import {
  History,
  Info,
  Link2Off,
  Pause,
  Play,
  TriangleAlert,
  Unplug,
} from "lucide-react";
import { BrandMark } from "@/components/app/patterns/BrandMark";
import { useScrollCue } from "@/components/app/patterns/CodeBlock";
import { Markdown } from "@/components/app/Markdown";
import {
  StatusToken,
  type StatusTone,
} from "@/components/app/patterns/StatusToken";
import { ThemeToggle } from "@/components/app/theme";
import { SharedLiveTerminal } from "@/components/app/share/SharedLiveTerminal";
import { useSharedRun } from "@/components/app/share/use-shared-run";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  SHARE_VIEWER_FONT_SIZE_PX,
  type SharedRunMission,
} from "@/lib/run-share/protocol";
import { buildShareCast } from "@/lib/run-share/shared-run-cast";
import {
  followedSession,
  parseShareId,
  shareSessionPhase,
  shareTabs,
  type ShareSession,
  type ShareSessionPhase,
  type ShareStatus,
  type ShareTab,
} from "@/lib/run-share/shared-run-model";
import { cn } from "@/lib/utils";

// Viewers who only watch never load the player.
const LazyReplaySurface = lazy(() =>
  import("@/components/app/RunArtifactViewerReplay").then(
    ({ AsciicastReplaySurface }) => ({ default: AsciicastReplaySurface }),
  ),
);

/** The public page of one shared run: the mission and the learner's terminals. */
export function SharedRun() {
  // The share id rides in the fragment, which no request ever carries.
  const fragment = useRouterState({ select: (state) => state.location.hash });
  const shareId = parseShareId(fragment);
  if (!shareId) {
    // Nothing is asked of the server for a link that cannot be a share's.
    return (
      <Unavailable
        title="This link isn't shared (anymore)"
        description="The learner may have stopped sharing, or the link is incomplete. Ask them for a new one."
      />
    );
  }
  return <Viewer key={shareId} shareId={shareId} />;
}

const STATUS_TOKENS: Record<
  Exclude<ShareStatus, "unavailable">,
  { tone: StatusTone; word: string; pulse: boolean }
> = {
  connecting: { tone: "pending", word: "Connecting…", pulse: true },
  live: { tone: "live", word: "Live", pulse: true },
  reconnecting: { tone: "pending", word: "Reconnecting…", pulse: true },
  stopped: { tone: "muted", word: "Sharing stopped", pulse: false },
};

function Viewer({ shareId }: { shareId: string }) {
  const { model, status, retry } = useSharedRun(shareId);
  const { mission } = model;
  const tabs = useMemo(() => shareTabs(model), [model.sessions, model.mission]);

  // The tab carries the run's name for someone who has several open.
  const title = mission?.title ?? null;
  useEffect(() => {
    if (!title) return;
    const previous = document.title;
    const next = `${title} · Live run · intar.dev`;
    document.title = next;
    return () => {
      if (document.title === next) document.title = previous;
    };
  }, [title]);

  // The handshake kept failing, and a browser cannot tell a share that is gone
  // from one that is busy (a rate limit, a full house), so the end state says
  // both and offers another go.
  if (status === "unavailable") {
    return (
      <Unavailable
        title="This share isn't available"
        description="It may have been stopped, or it's busy right now. Try again in a moment, and if it keeps failing, ask the learner for a new link."
        onRetry={retry}
      />
    );
  }

  const token = STATUS_TOKENS[status];
  return (
    <Frame
      trailing={
        <StatusToken
          tone={token.tone}
          word={token.word}
          pulse={token.pulse}
          live
        />
      }
    >
      <main className="mx-auto flex w-full max-w-(--app-max) flex-1 flex-col gap-4 px-(--page-inset) pt-2 pb-8 sm:gap-5">
        <div className="space-y-1">
          {mission?.lecture_title ? (
            <p className="text-label">{mission.lecture_title}</p>
          ) : null}
          <h1 className="text-page-title text-balance">
            {mission?.title ?? "Live run"}
          </h1>
          {mission?.tagline ? (
            <p className="text-support text-muted-foreground">
              {mission.tagline}
            </p>
          ) : null}
        </div>

        {status === "stopped" ? (
          <Alert>
            <AlertTitle>This share has ended</AlertTitle>
            <AlertDescription>
              The learner stopped sharing. What was captured stays on this page
              until you leave it.
            </AlertDescription>
          </Alert>
        ) : null}
        {model.truncated ? (
          <Alert>
            <AlertTitle>Replay truncated</AlertTitle>
            <AlertDescription>
              The recording of earlier output stops early. Live output keeps
              arriving.
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)] lg:gap-5">
          <section aria-labelledby="share-terminals" className="min-w-0">
            <h2 id="share-terminals" className="sr-only">
              Terminals
            </h2>
            {tabs.length > 0 ? (
              <Terminals tabs={tabs} link={status} />
            ) : (
              <EmptyTerminals status={status} />
            )}
          </section>
          {mission ? <MissionPanel mission={mission} /> : null}
        </div>
      </main>
    </Frame>
  );
}

function Frame({
  trailing,
  children,
}: {
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas text-foreground pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]">
      <header className="mx-auto flex w-full max-w-(--app-max) shrink-0 items-center justify-between gap-3 px-(--page-inset) py-1">
        <BrandMark />
        <div className="flex min-w-0 items-center gap-3">
          {trailing}
          <ThemeToggle />
        </div>
      </header>
      {children}
    </div>
  );
}

function Unavailable({
  title,
  description,
  onRetry,
}: {
  title: string;
  description: string;
  onRetry?: () => void;
}) {
  return (
    <Frame>
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-6 px-(--page-inset) py-16 text-center">
        <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <Link2Off className="size-6" aria-hidden="true" />
        </span>
        <div className="space-y-1">
          <h1 className="text-page-title">{title}</h1>
          <p className="text-body text-muted-foreground">{description}</p>
        </div>
        {onRetry ? (
          <Button variant="outline" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </main>
    </Frame>
  );
}

function EmptyTerminals({ status }: { status: ShareStatus }) {
  const words =
    status === "live"
      ? "Waiting for the learner to open a terminal. It appears here as soon as they do."
      : status === "stopped"
        ? "No terminal was shared."
        : status === "reconnecting"
          ? "Reconnecting to the live run…"
          : "Connecting to the live run…";
  return (
    <div
      role="status"
      className="flex min-h-48 items-center justify-center rounded-xl border border-terminal-border bg-terminal-background px-5 text-center text-support text-terminal-muted"
    >
      {words}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Mission                                                                    */
/* -------------------------------------------------------------------------- */

const MissionPanel = memo(function MissionPanel({
  mission,
}: {
  mission: SharedRunMission;
}) {
  const workOrderId = useId();
  const briefingId = useId();
  const manyMachines = new Set(mission.objectives.map((o) => o.vm_name)).size > 1;
  // Beside the terminals a long mission scrolls in place, and then it has to
  // be reachable from the keyboard; stacked, it is only part of the page.
  const ref = useRef<HTMLElement | null>(null);
  const scrolls = useScrollCue(ref);
  return (
    <aside
      ref={ref}
      aria-label="Mission"
      {...(scrolls ? { tabIndex: 0 } : {})}
      className="min-w-0 space-y-5 rounded-xl border border-border bg-card p-4 text-card-foreground shadow-[var(--highlight),var(--shadow-raised)] sm:p-5 lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] lg:overflow-y-auto"
    >
      {mission.objectives.length > 0 ? (
        <section aria-labelledby={workOrderId}>
          <p id={workOrderId} className="text-label">
            Work order
          </p>
          <ol className="mt-3 divide-y border-y">
            {mission.objectives.map((objective, index) => (
              <li
                key={`${objective.vm_name}:${objective.label}:${index}`}
                className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-3 py-3"
              >
                <span className="text-sm font-semibold text-faint-foreground tabular-nums">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="text-sm leading-6 font-medium">
                  {objective.title ?? objective.label}
                  {manyMachines ? (
                    <span className="block text-metadata">
                      {objective.vm_name}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {mission.markdown.trim() ? (
        <section aria-labelledby={briefingId}>
          <h2 id={briefingId} className="text-card-title">
            {mission.lecture_title ?? "Briefing"}
          </h2>
          <Markdown headingOffset={1} className="mt-3 space-y-3 text-support">
            {mission.markdown}
          </Markdown>
        </section>
      ) : null}
    </aside>
  );
});

/* -------------------------------------------------------------------------- */
/* Terminals                                                                  */
/* -------------------------------------------------------------------------- */

type PanelMode = "live" | "replay";

/** What a viewer has done to one tab; it survives switching away and back. */
interface PanelState {
  mode: PanelMode;
  /** The screen is held at this many events, or follows the log. */
  pausedAt: number | null;
  /** The log as it was when the replay was opened; a replay does not grow. */
  replay: { id: number; content: string } | null;
}

function Terminals({ tabs, link }: { tabs: ShareTab[]; link: ShareStatus }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panels, setPanels] = useState<Record<string, PanelState>>({});
  const [announcement, setAnnouncement] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);
  // A viewer who has not left the newest tab keeps following the newest one.
  const following = useRef(true);
  const known = useRef(0);

  const sessions = useMemo(() => tabs.map((tab) => tab.session), [tabs]);
  const followed = followedSession(sessions);
  const activeId = tabs.some((tab) => tab.session.id === selectedId)
    ? selectedId
    : (followed?.id ?? tabs[0]?.session.id ?? null);

  useEffect(() => {
    const before = known.current;
    known.current = tabs.length;
    if (tabs.length <= before) return;
    const newest = tabs[tabs.length - 1];
    if (before > 0 && newest) {
      setAnnouncement(`New terminal session: ${newest.label}`);
    }
    if (!following.current) return;
    const next = before === 0 ? followed : newest?.session;
    if (next) setSelectedId(next.id);
  }, [tabs.length]);

  // A tab that took the viewer's place in the strip comes into view.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>("[data-active]")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  const change = useCallback((id: string, patch: Partial<PanelState>) => {
    setPanels((current) => ({
      ...current,
      [id]: { ...(current[id] ?? DEFAULT_PANEL), ...patch },
    }));
  }, []);
  // A tab keeps the view it first opened in: a terminal being watched stays
  // on its live screen when it ends, instead of jumping to a replay.
  const pin = useCallback((id: string, mode: PanelMode) => {
    setPanels((current) =>
      current[id] ? current : { ...current, [id]: { ...DEFAULT_PANEL, mode } },
    );
  }, []);

  return (
    <Tabs
      value={activeId}
      onValueChange={(value) => {
        const id = String(value);
        following.current = id === tabs[tabs.length - 1]?.session.id;
        setSelectedId(id);
      }}
      className="min-w-0 gap-3"
    >
      <div ref={listRef} className="min-w-0">
        <TabsList variant="line" aria-label="Terminal sessions">
          {tabs.map((tab) => (
            <SessionTab key={tab.session.id} tab={tab} link={link} />
          ))}
        </TabsList>
      </div>
      {tabs.map((tab) => (
        <TabsContent
          key={tab.session.id}
          value={tab.session.id}
          className="flex min-w-0 flex-col gap-3"
        >
          <SessionPanel
            tab={tab}
            link={link}
            panel={panels[tab.session.id]}
            onChange={change}
            onPin={pin}
          />
        </TabsContent>
      ))}
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </Tabs>
  );
}

const DEFAULT_PANEL: PanelState = { mode: "live", pausedAt: null, replay: null };

const PHASE_WORDS: Record<ShareSessionPhase, string> = {
  live: "Live",
  reconnecting: "Reconnecting…",
  interrupted: "Interrupted",
  stopped: "Stopped",
  ended: "Ended",
};

// Only a live session is filled with the oxide; one that is over is a quiet
// dot, and one that is waiting on a connection is an empty ring.
const PHASE_DOTS: Record<ShareSessionPhase, string> = {
  live: "bg-primary",
  reconnecting: "ring-1 ring-faint-foreground ring-inset",
  interrupted: "ring-1 ring-faint-foreground ring-inset",
  stopped: "bg-faint-foreground/40",
  ended: "bg-faint-foreground/40",
};

function SessionTab({ tab, link }: { tab: ShareTab; link: ShareStatus }) {
  const { session } = tab;
  const phase = shareSessionPhase(session, link);
  return (
    <TabsTrigger value={session.id} className="flex-none gap-2">
      <span
        aria-hidden="true"
        data-share-dot={phase}
        className={cn("size-1.5 shrink-0 rounded-full", PHASE_DOTS[phase])}
      />
      <span>{tab.label}</span>
      <span className="text-caption">
        {session.mode === "native" ? "SSH" : "Web"}
      </span>
      <span className="sr-only">{PHASE_WORDS[phase]}</span>
    </TabsTrigger>
  );
}

function SessionPanel({
  tab,
  link,
  panel,
  onChange,
  onPin,
}: {
  tab: ShareTab;
  link: ShareStatus;
  panel: PanelState | undefined;
  onChange: (id: string, patch: Partial<PanelState>) => void;
  onPin: (id: string, mode: PanelMode) => void;
}) {
  const { session, label } = tab;
  const phase = shareSessionPhase(session, link);
  // Nothing more will arrive on a screen that has ended or been stopped.
  const finished = phase === "ended" || phase === "stopped";
  // Ended sessions open as a replay; the rest as the live screen.
  const [firstMode] = useState<PanelMode>(
    session.status === "ended" ? "replay" : "live",
  );
  useEffect(() => {
    onPin(session.id, firstMode);
  }, [onPin, session.id, firstMode]);

  const mode = panel?.mode ?? firstMode;
  const pausedAt = panel?.pausedAt ?? null;
  const opened = panel?.replay ?? null;
  // A replay is a recording of the log up to now, so it holds still while the
  // session goes on; "Replay from start" again takes a fresh one.
  const replay = useMemo(
    () =>
      mode === "replay"
        ? (opened ?? { id: 0, content: buildShareCast(session) })
        : null,
    [mode, opened],
  );

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <SessionStatusLine
          phase={phase}
          mode={mode}
          paused={pausedAt !== null}
        />
        <div className="flex flex-wrap items-center gap-2">
          {mode === "live" ? (
            <>
              {/* Held still when it finished: it can still be resumed. */}
              {finished && pausedAt === null ? null : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-pressed={pausedAt !== null}
                  onClick={() =>
                    onChange(session.id, {
                      pausedAt: pausedAt === null ? session.events.length : null,
                    })
                  }
                >
                  {pausedAt === null ? (
                    <>
                      <Pause aria-hidden="true" />
                      Pause
                    </>
                  ) : (
                    <>
                      <Play aria-hidden="true" />
                      Resume
                    </>
                  )}
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  onChange(session.id, {
                    mode: "replay",
                    replay: {
                      id: (opened?.id ?? 0) + 1,
                      content: buildShareCast(session),
                    },
                  })
                }
              >
                <History aria-hidden="true" />
                Replay from start
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                onChange(session.id, {
                  mode: "live",
                  pausedAt: null,
                  replay: null,
                })
              }
            >
              {finished ? "Show final screen" : "Back to live"}
            </Button>
          )}
        </div>
      </div>

      <SessionNotes session={session} phase={phase} />

      {mode === "live" ? (
        <div className="overflow-hidden rounded-xl border border-terminal-border bg-terminal-background">
          <SharedLiveTerminal
            session={session}
            pausedAt={pausedAt}
            label={`${label} terminal, live view`}
          />
        </div>
      ) : replay ? (
        <Suspense
          fallback={
            <div
              role="status"
              className="rounded-xl border border-terminal-border bg-terminal-background px-4 py-6 text-support text-terminal-muted"
            >
              Preparing replay…
            </div>
          }
        >
          <LazyReplaySurface
            contentId={`${session.id}:${replay.id}`}
            content={replay.content}
            loading={false}
            minimal
            label={`${label} replay`}
            fontSize={SHARE_VIEWER_FONT_SIZE_PX}
          />
        </Suspense>
      ) : null}
    </>
  );
}

function SessionStatusLine({
  phase,
  mode,
  paused,
}: {
  phase: ShareSessionPhase;
  mode: PanelMode;
  paused: boolean;
}) {
  const running = phase === "live";
  const word =
    mode === "replay" ? "Replay" : paused ? "Paused" : PHASE_WORDS[phase];
  return (
    <p role="status" className="inline-flex items-center gap-2 text-support">
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          mode === "live" && !paused && running
            ? "bg-primary"
            : "ring-1 ring-faint-foreground ring-inset",
        )}
      />
      <span className="font-medium">{word}</span>
      {mode === "live" && paused ? (
        <span className="text-muted-foreground">
          New output is held until you resume.
        </span>
      ) : null}
    </p>
  );
}

function SessionNotes({
  session,
  phase,
}: {
  session: ShareSession;
  phase: ShareSessionPhase;
}) {
  const notes: { key: string; icon: ReactNode; text: string }[] = [];
  if (session.midSession) {
    notes.push({
      key: "mid-session",
      icon: <Info aria-hidden="true" />,
      text: "Joined mid-session — the screen fills in as it redraws",
    });
  }
  if (session.gapBytes > 0) {
    notes.push({
      key: "gap",
      icon: <TriangleAlert aria-hidden="true" />,
      text: "Some output was dropped",
    });
  }
  // A stopped share's writers will not resume, so there is nothing to wait for.
  if (phase === "interrupted") {
    notes.push({
      key: "detached",
      icon: <Unplug aria-hidden="true" />,
      text: "The connection to this terminal dropped — waiting for it to resume",
    });
  }
  if (notes.length === 0) return null;
  return (
    <ul className="space-y-1 text-support text-muted-foreground">
      {notes.map((note) => (
        <li key={note.key} className="flex items-start gap-2">
          <span className="mt-0.5 shrink-0 [&_svg]:size-4">{note.icon}</span>
          {note.text}
        </li>
      ))}
    </ul>
  );
}
