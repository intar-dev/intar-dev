import "asciinema-player/dist/bundle/asciinema-player.css";

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { RotateCcw } from "lucide-react";
import { Slider } from "@base-ui/react/slider";
import type {
  AsciinemaPlayerInstance,
  AsciinemaPlayerMetadata,
} from "asciinema-player";
import { RollingNumber } from "@/components/app/patterns/RollingNumber";
import { Button } from "@/components/ui/button";
import {
  REPLAY_IDLE_TIME_LIMIT_SECONDS,
  REPLAY_TERMINAL_FONT_FAMILY,
  REPLAY_TERMINAL_LINE_HEIGHT,
  REPLAY_TERMINAL_THEME,
  loadReplayTerminalFont,
} from "@/lib/replay/config";
import { cn } from "@/lib/utils";
import {
  castAspectRatio,
  castGeometry,
  castHeaderGeometry,
  formatReplayClock,
  nextReplaySpeed,
  REPLAY_SCRUB_STEP,
  replayCheckMarkers,
  replayKeyTarget,
  replayMarkerAnnouncement,
  replayMarkerEdge,
  replayMarkersPassed,
  replayMarkerTip,
  replayValueText,
  replayMarkerAt,
  replayMarkersAnnouncement,
  snapReplayScrub,
  type ReplayCheck,
  type ReplayCheckMarker,
  type ReplaySpeed,
} from "./RunArtifactViewerModel";

/** bp-md: below it a replay keeps 13px cells and scrolls sideways. */
const WIDE_QUERY = "(min-width: 48rem)";

function subscribeWide(onChange: () => void) {
  const query = window.matchMedia(WIDE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function useIsWide() {
  return useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE_QUERY).matches,
    () => true,
  );
}

type PlayerEventName =
  | "ended"
  | "metadata"
  | "pause"
  | "play"
  | "playing"
  | "ready"
  | "seeked";

const PLAYER_EVENTS: readonly PlayerEventName[] = [
  "ready",
  "metadata",
  "play",
  "playing",
  "pause",
  "ended",
  "seeked",
];

interface PlayerEventPayload {
  /** Ready only: the player was re-created and its position restored. */
  restored?: boolean;
}

interface RestorePoint {
  time: number;
  playing: boolean;
}

export function replayPlayerErrorCopy(error: string, minimal: boolean) {
  const lead = "Replay could not be loaded.";
  return minimal ? { lead, detail: null } : { lead, detail: error };
}

/**
 * One terminal frame for every replay state (loading, empty, error, playing),
 * so the box never changes shape between them: it fits inside replay-max from
 * the first paint. The learner replay has its own controls; the operations
 * viewer keeps the player's own bar.
 */
export function AsciicastReplaySurface({
  contentId,
  content,
  loading,
  minimal = false,
  label = "Terminal replay",
  checks,
  checksScope = "machine",
  fontSize,
}: {
  /** Stable identity of the cast (e.g. artifact id); resets error state. */
  contentId: string;
  content: string;
  loading: boolean;
  minimal?: boolean;
  /** Names the replay for assistive technology. */
  label?: string;
  /** The replayed machine's checks; the cast marks when each first passed. */
  checks?: readonly ReplayCheck[] | undefined;
  /**
   * "part": the cast is one of several sessions of the machine, so it holds
   * only the checks that first passed in it and no total can be claimed.
   */
  checksScope?: "machine" | "part" | undefined;
  /**
   * A text size in pixels the screen keeps at every width: the cast no longer
   * fits its box, and a wider one scrolls sideways inside it.
   */
  fontSize?: number | undefined;
}) {
  const [playerError, setPlayerError] = useState<string | null>(null);
  // Try again re-mounts the player (a new key) with the same cast.
  const [attempt, setAttempt] = useState(0);
  const wide = useIsWide();
  // While streaming, only the header is cheap to read; the full scan for
  // later resizes runs once, when the cast is complete.
  const geometry = useMemo(
    () => (loading ? castHeaderGeometry(content) : castGeometry(content)),
    [loading, content],
  );

  const handlePlayerReady = useCallback(() => {
    setPlayerError(null);
  }, []);
  const handlePlayerError = useCallback((message: string) => {
    setPlayerError(message);
  }, []);

  useEffect(() => {
    setPlayerError(null);
    setAttempt(0);
  }, [contentId]);

  const retry = useCallback(() => {
    setPlayerError(null);
    setAttempt((count) => count + 1);
  }, []);

  const empty = !loading && !content.trim();
  // A fixed text size never fits an aspect box, so the placeholders keep a
  // plain one.
  const sized = minimal && wide && fontSize === undefined;
  // A sized box carries the screen's inset outside its content box, which
  // keeps the cast's aspect ratio for the player's fit (see .replay-inset).
  const boxClass = minimal
    ? sized
      ? "replay-inset max-h-[calc(70dvh-1.75rem)]"
      : "min-h-48 w-full"
    : "aspect-video w-full";
  const boxStyle: CSSProperties | undefined = sized
    ? { aspectRatio: String(castAspectRatio(geometry)) }
    : undefined;

  let body: ReactNode;
  if (playerError) {
    const copy = replayPlayerErrorCopy(playerError, minimal);
    body = (
      <div className={cn("flex items-center justify-center", boxClass)} style={boxStyle}>
        <div
          role="alert"
          className="flex flex-col items-center gap-3 px-5 text-center"
        >
          <div>
            <p className="text-support text-terminal-destructive">
              {copy.lead}
            </p>
            {copy.detail ? (
              <p className="mt-1 text-code break-words text-terminal-muted">
                {copy.detail}
              </p>
            ) : null}
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="border-terminal-border bg-terminal-surface text-terminal-foreground hover:border-terminal-muted hover:bg-terminal-surface dark:hover:bg-terminal-surface"
            onClick={retry}
          >
            Try again
          </Button>
        </div>
      </div>
    );
  } else if (loading) {
    body = (
      <div className={cn("flex items-center justify-center", boxClass)} style={boxStyle}>
        <div role="status" className="space-y-2 px-5 text-center">
          <p className="text-support text-terminal-muted">Preparing replay…</p>
          {!minimal ? (
            <p className="text-support text-terminal-muted">
              Cast playback waits for the complete{" "}
              <code className="text-code">.cast</code> stream so timing and
              frame boundaries stay correct. The Raw tab remains available
              while bytes are arriving.
            </p>
          ) : null}
        </div>
      </div>
    );
  } else if (empty) {
    body = (
      <div className={cn("flex items-center justify-center", boxClass)} style={boxStyle}>
        <p role="status" className="px-5 text-center text-support text-terminal-muted">
          This replay is empty.
        </p>
      </div>
    );
  } else {
    body = (
      <ReplayPlayer
        key={`${contentId}:${attempt}`}
        content={content}
        custom={minimal}
        wide={wide}
        boxStyle={boxStyle}
        label={label}
        checks={checks}
        checksScope={checksScope}
        fontSize={fontSize}
        onReady={handlePlayerReady}
        onError={handlePlayerError}
      />
    );
  }

  return (
    <div className={minimal ? "p-0" : "p-4"}>
      <div
        className="replay-frame"
        role="group"
        aria-label={label}
        aria-busy={loading}
      >
        {body}
      </div>
    </div>
  );
}

/**
 * Owns the playback state of one cast. The player has no time event, so a
 * frame loop reads its clock while it plays. The slider drives it through the
 * player API: a drag pauses, follows the pointer and resumes; keys and clicks
 * glide.
 */
function ReplayPlayer({
  content,
  custom,
  wide,
  boxStyle,
  label,
  checks,
  checksScope,
  fontSize,
  onReady,
  onError,
}: {
  content: string;
  /** The learner replay: own controls instead of the player's bar. */
  custom: boolean;
  wide: boolean;
  boxStyle: CSSProperties | undefined;
  label: string;
  checks: readonly ReplayCheck[] | undefined;
  checksScope: "machine" | "part";
  fontSize: number | undefined;
  onReady: () => void;
  onError: (message: string) => void;
}) {
  const [player, setPlayer] = useState<AsciinemaPlayerInstance | null>(null);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [jump, setJump] = useState(false);
  const [speed, setSpeed] = useState<ReplaySpeed>(1);
  const timeRef = useRef(0);
  const restoreRef = useRef<RestorePoint | null>(null);
  const jumpTimer = useRef<number | null>(null);
  // The player answers a seek later than it is asked, and its clock keeps
  // reporting the old position until then. While a seek or a drag is under
  // way, the frame loop must not write that stale time over the position
  // the learner just chose.
  const drag = useRef<{ wasPlaying: boolean } | null>(null);
  const seeks = useRef({ inFlight: 0, epoch: 0 });
  const trackSeek = useCallback((request: Promise<void> | void) => {
    seeks.current.inFlight += 1;
    seeks.current.epoch += 1;
    void Promise.resolve(request)
      .catch(() => undefined)
      .finally(() => {
        seeks.current.inFlight -= 1;
        seeks.current.epoch += 1;
      });
  }, []);

  const commitTime = useCallback((next: number) => {
    timeRef.current = next;
    setTime(next);
  }, []);

  // Check markers come from the cast itself; only the learner replay has a
  // track to show them on.
  const markers = useMemo(
    () => (custom && checks?.length ? replayCheckMarkers(content, checks) : []),
    [custom, checks, content],
  );
  const markersRef = useRef<readonly ReplayCheckMarker[]>(markers);
  useEffect(() => {
    markersRef.current = markers;
  }, [markers]);
  // Each announcement is a new status node (the key), so one that repeats the
  // last (a replayed check) is still spoken.
  const [announcement, setAnnouncement] = useState({ id: 0, text: "" });
  const announce = useCallback(
    (text: string) => setAnnouncement((last) => ({ id: last.id + 1, text })),
    [],
  );
  // Playback moving forward: each check it passes is announced. Seeks and
  // drags commit their time directly and stay quiet.
  const playTo = useCallback(
    (next: number) => {
      const passed = replayMarkersPassed(
        markersRef.current,
        timeRef.current,
        next,
      );
      if (passed.length) announce(replayMarkersAnnouncement(passed));
      commitTime(next);
    },
    [announce, commitTime],
  );

  // Whatever re-creates the player (a speed change, or the viewport crossing
  // bp-md, which changes how the cast fits) must not cost the learner their
  // place: the player saves its position as it is torn down.
  const playingRef = useRef(false);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);
  const saveRestore = useCallback(() => {
    restoreRef.current = { time: timeRef.current, playing: playingRef.current };
  }, []);
  // The new player's "ready": put it where the old one was. The seek counts as
  // one under way, so the new player's clock (still at 0) is not read meanwhile.
  const restoreInto = useCallback(
    (next: AsciinemaPlayerInstance) => {
      const point = restoreRef.current;
      restoreRef.current = null;
      if (!point) return false;
      trackSeek(
        (async () => {
          try {
            await next.seek(point.time);
            if (point.playing) await next.play();
          } catch {
            // A position the new player rejects stays at the start.
          }
        })(),
      );
      return true;
    },
    [trackSeek],
  );

  const handleEvent = useCallback(
    (
      source: AsciinemaPlayerInstance,
      name: PlayerEventName,
      payload: PlayerEventPayload & AsciinemaPlayerMetadata,
    ) => {
      switch (name) {
        case "metadata":
          if (typeof payload.duration === "number") {
            setDuration(payload.duration);
          }
          break;
        case "ready":
          void Promise.resolve(source.getDuration()).then((value) => {
            if (typeof value === "number") setDuration(value);
          });
          if (!payload.restored) {
            commitTime(0);
            setPlaying(false);
            setEnded(false);
          }
          break;
        case "play":
        case "playing":
          setPlaying(true);
          setEnded(false);
          break;
        case "pause":
          setPlaying(false);
          break;
        case "seeked":
          setEnded(false);
          break;
        case "ended":
          setPlaying(false);
          setEnded(true);
          void Promise.resolve(source.getDuration()).then((value) => {
            if (typeof value === "number") playTo(value);
          });
          break;
      }
    },
    [commitTime, playTo],
  );

  // The player has no time event: read its clock every frame while it plays.
  useEffect(() => {
    if (!player || !playing) return;
    let frame = 0;
    let stopped = false;
    let reading = false;
    const tick = () => {
      if (stopped) return;
      if (!reading) {
        reading = true;
        const { epoch } = seeks.current;
        void Promise.resolve(player.getCurrentTime())
          .then((value) => {
            const moving =
              seeks.current.inFlight > 0 ||
              seeks.current.epoch !== epoch ||
              drag.current !== null;
            if (!stopped && !moving && typeof value === "number") {
              playTo(value);
            }
          })
          .catch(() => undefined)
          .finally(() => {
            reading = false;
          });
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
    };
  }, [player, playing, playTo]);

  useEffect(
    () => () => {
      if (jumpTimer.current !== null) window.clearTimeout(jumpTimer.current);
    },
    [],
  );

  const glide = useCallback((on: boolean) => {
    if (jumpTimer.current !== null) window.clearTimeout(jumpTimer.current);
    jumpTimer.current = null;
    setJump(on);
    // A jump glides for duration-moderate; playback then follows exactly.
    if (on) {
      jumpTimer.current = window.setTimeout(() => setJump(false), 250);
    }
  }, []);

  const seekTo = useCallback(
    (target: number, withGlide: boolean) => {
      if (!player || duration <= 0) return;
      const next = Math.min(Math.max(target, 0), duration);
      glide(withGlide);
      commitTime(next);
      if (next < duration) setEnded(false);
      trackSeek(player.seek(next));
    },
    [player, duration, glide, commitTime, trackSeek],
  );

  const ready = Boolean(player) && duration > 0;
  const thumbRef = useRef<HTMLDivElement | null>(null);

  const togglePlayback = async () => {
    if (!player || duration <= 0) return;
    try {
      if (ended) {
        glide(true);
        commitTime(0);
        setEnded(false);
        await player.seek(0);
        await player.play();
      } else if (playing) {
        await player.pause();
      } else {
        await player.play();
      }
    } catch {
      // The player rejects a command it cannot run in its current state.
    }
  };

  const cycleSpeed = () => {
    if (!player) return;
    setSpeed(nextReplaySpeed(speed));
  };

  // Scrubbing: a drag pauses, follows the pointer (one seek per frame, since
  // the player re-renders from the nearest keyframe) and resumes if it was
  // playing.
  const pendingSeek = useRef<number | null>(null);
  const seekFrame = useRef(0);

  const flushSeek = useCallback(() => {
    if (seekFrame.current) cancelAnimationFrame(seekFrame.current);
    seekFrame.current = 0;
    const target = pendingSeek.current;
    pendingSeek.current = null;
    if (target !== null && player) trackSeek(player.seek(target));
  }, [player, trackSeek]);

  const scheduleSeek = (target: number) => {
    pendingSeek.current = target;
    if (!seekFrame.current) {
      seekFrame.current = requestAnimationFrame(flushSeek);
    }
  };

  useEffect(
    () => () => {
      if (seekFrame.current) cancelAnimationFrame(seekFrame.current);
    },
    [],
  );

  const beginDrag = (event: ReactPointerEvent) => {
    if (event.button !== 0 || !player || duration <= 0) return;
    drag.current = { wasPlaying: playing };
    if (playing) void Promise.resolve(player.pause()).catch(() => undefined);
    const finish = () => {
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      flushSeek();
      const wasPlaying = drag.current?.wasPlaying ?? false;
      drag.current = null;
      if (wasPlaying && timeRef.current < duration) {
        void Promise.resolve(player.play()).catch(() => undefined);
      }
    };
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  // A set text size is never fitted: the screen keeps it and scrolls sideways.
  const fixedSize = fontSize !== undefined;
  const scroll = custom && (!wide || fixedSize);
  const mounted = (
    <MountedAsciicastPlayer
      content={content}
      fit={
        fixedSize ? "none" : custom && wide ? "both" : custom ? "none" : "width"
      }
      fontSize={fontSize}
      speed={speed}
      custom={custom}
      onPlayer={setPlayer}
      onEvent={handleEvent}
      saveRestore={saveRestore}
      restoreInto={restoreInto}
      onReady={onReady}
      onError={onError}
    />
  );

  if (!custom) {
    return (
      <div className={fixedSize ? "overflow-x-auto" : "overflow-hidden"}>
        {mounted}
      </div>
    );
  }

  const max = duration > 0 ? duration : 1;
  const progress = duration > 0 ? Math.min(Math.max(time / duration, 0), 1) : 0;
  const showAgain = ended && !playing;
  const markerTimes = markers.map((marker) => marker.time);
  // A cast recorded before check markers existed says nothing about checks.
  const checkCount = !markers.length
    ? 0
    : checksScope === "part"
      ? null
      : (checks?.length ?? 0);
  const passedCount = (at: number) =>
    markers.filter((marker) => marker.time <= at).length;
  const toggleLabel = playing
    ? "Pause replay"
    : ended
      ? "Replay from the start"
      : "Play replay";

  return (
    <>
      <div
        // The player's own shortcuts (space, f, ?, digits) listen on the
        // document; keys pressed on the screen stay here, so the controls
        // below are the only keyboard model.
        onKeyDown={(event) => event.stopPropagation()}
        className={cn(
          "replay-screen relative",
          scroll
            ? "w-full overflow-x-auto"
            : "replay-inset max-h-[calc(70dvh-1.75rem)]",
        )}
        style={scroll ? undefined : boxStyle}
        // Sideways scrolling needs a keyboard stop, or the cut-off columns
        // are out of reach.
        tabIndex={scroll ? 0 : undefined}
        role={scroll ? "region" : undefined}
        aria-label={scroll ? `${label}, screen` : undefined}
      >
        {mounted}
      </div>
      <div className="replay-bar" data-playing={playing ? "" : undefined}>
        <button
          type="button"
          className="replay-tbtn"
          aria-label={toggleLabel}
          disabled={!ready}
          onClick={() => void togglePlayback()}
        >
          <span className="replay-swap replay-swap--turn" aria-hidden="true">
            <span data-on={showAgain ? undefined : ""}>
              <span className="replay-play">
                <i />
                <i />
              </span>
            </span>
            <span data-on={showAgain ? "" : undefined}>
              <RotateCcw className="size-3.5" />
            </span>
          </span>
        </button>
        <Slider.Root
          className="replay-scrub"
          value={Math.min(time, max)}
          min={0}
          max={max}
          step={REPLAY_SCRUB_STEP}
          disabled={!ready}
          data-jump={jump ? "" : undefined}
          style={{ "--p": progress } as CSSProperties}
          onPointerDown={beginDrag}
          onValueChange={(raw, details) => {
            const next = snapReplayScrub(raw, duration);
            if (details.reason === "drag") glide(false);
            else glide(true);
            commitTime(next);
            if (next < duration) setEnded(false);
            scheduleSeek(next);
          }}
        >
          <Slider.Control className="replay-scrub__control">
            <Slider.Track className="replay-scrub__rail">
              <span className="replay-scrub__fill" />
            </Slider.Track>
            {duration > 0
              ? markers.map((marker) => {
                  const at = Math.min(marker.time / duration, 1);
                  return (
                    <span
                      key={marker.number}
                      className="replay-scrub__mark"
                      style={{ "--at": at } as CSSProperties}
                      data-edge={replayMarkerEdge(at)}
                      data-passed={time >= marker.time ? "" : undefined}
                      data-current={
                        replayMarkerAt(markers, time) === marker ? "" : undefined
                      }
                      data-tip={replayMarkerTip(marker)}
                      aria-hidden="true"
                      // A marker is a jump target: it goes exactly to the
                      // check instead of starting a drag.
                      onPointerDown={(event) => {
                        if (event.button !== 0 || !ready) return;
                        event.preventDefault();
                        event.stopPropagation();
                        thumbRef.current
                          ?.querySelector<HTMLElement>("input")
                          ?.focus({ preventScroll: true });
                        seekTo(marker.time, true);
                        announce(replayMarkerAnnouncement(marker));
                      }}
                    />
                  );
                })
              : null}
            <Slider.Thumb
              ref={thumbRef}
              className="replay-scrub__thumb"
              aria-label="Replay position"
              getAriaValueText={(_formatted, value) =>
                replayValueText(
                  value,
                  duration,
                  checkCount === 0
                    ? undefined
                    : { passed: passedCount(value), total: checkCount },
                )
              }
              onKeyDown={(event) => {
                if (event.altKey || event.ctrlKey || event.metaKey) return;
                const target = replayKeyTarget(
                  event.key,
                  timeRef.current,
                  duration,
                  markerTimes,
                );
                if (target === null) return;
                event.preventDefault();
                // A jump that lands on a check says which one.
                const landed = replayMarkerAt(markersRef.current, target);
                if (landed) announce(replayMarkerAnnouncement(landed));
                seekTo(target, true);
              }}
            />
          </Slider.Control>
        </Slider.Root>
        <span className="replay-time" aria-hidden="true">
          {formatReplayClock(time)} / {formatReplayClock(duration)}
        </span>
        <button
          type="button"
          className="replay-tbtn"
          aria-label={`Playback speed: ${speed}×`}
          disabled={!ready}
          onClick={cycleSpeed}
        >
          <RollingNumber value={speed} />×
        </button>
      </div>
      {markers.length ? (
        <p className="sr-only" role="status" aria-live="polite">
          <span key={announcement.id}>{announcement.text}</span>
        </p>
      ) : null}
    </>
  );
}

const MountedAsciicastPlayer = memo(function MountedAsciicastPlayer({
  content,
  fit,
  fontSize,
  speed,
  custom,
  onPlayer,
  onEvent,
  saveRestore,
  restoreInto,
  onReady,
  onError,
}: {
  content: string;
  fit: "both" | "none" | "width";
  /** Pixels; with fit "none" only. The phone cell (13px) when not set. */
  fontSize: number | undefined;
  speed: ReplaySpeed;
  custom: boolean;
  onPlayer: (player: AsciinemaPlayerInstance | null) => void;
  onEvent: (
    player: AsciinemaPlayerInstance,
    name: PlayerEventName,
    payload: PlayerEventPayload & AsciinemaPlayerMetadata,
  ) => void;
  /** Called as the player is torn down; the next one's "ready" restores it. */
  saveRestore: () => void;
  /** Moves a new player to the saved point; false when there is none. */
  restoreInto: (player: AsciinemaPlayerInstance) => boolean;
  onReady: () => void;
  onError: (message: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<AsciinemaPlayerInstance | null>(null);

  useEffect(() => {
    if (!content.trim() || !containerRef.current) {
      return;
    }

    let cancelled = false;

    const mountPlayer = async () => {
      try {
        // Cell metrics are measured once, at mount: wait for Plex Mono (the
        // load never rejects, so a missing font cannot block the replay).
        const [mod] = await Promise.all([
          import("asciinema-player"),
          loadReplayTerminalFont(),
        ]);
        if (cancelled || !containerRef.current) {
          return;
        }

        // The cursor blink is a script timer, so the CSS reduced-motion
        // model cannot stop it.
        const reducedMotion = window.matchMedia(
          "(prefers-reduced-motion: reduce)",
        ).matches;
        const player = mod.create({ data: content }, containerRef.current, {
          autoPlay: false,
          preload: true,
          controls: !custom,
          // Learner replay: fit both ways inside the screen box, or on phones
          // a 13px cell that scrolls sideways. The operations viewer fills
          // the container width.
          fit,
          ...(fit === "none"
            ? { terminalFontSize: `${fontSize ?? 13}px` }
            : {}),
          speed,
          cursorMode: reducedMotion ? "steady" : "blinking",
          terminalLineHeight: REPLAY_TERMINAL_LINE_HEIGHT,
          idleTimeLimit: REPLAY_IDLE_TIME_LIMIT_SECONDS,
          terminalFontFamily: REPLAY_TERMINAL_FONT_FAMILY,
          theme: REPLAY_TERMINAL_THEME,
        });
        playerRef.current = player;
        const live = () => !cancelled && playerRef.current === player;
        // The player's text layer is a tab stop with its own shortcuts; the
        // custom controls replace both.
        const dropTabStop = () => {
          if (custom) {
            player.el
              .querySelector(".ap-term-text")
              ?.setAttribute("tabindex", "-1");
          }
        };
        dropTabStop();

        for (const name of PLAYER_EVENTS) {
          player.addEventListener(name, (payload) => {
            if (!live()) return;
            if (name !== "ready") {
              onEvent(player, name, (payload ?? {}) as AsciinemaPlayerMetadata);
              return;
            }
            dropTabStop();
            const restored = restoreInto(player);
            onEvent(player, name, { restored });
            onReady();
          });
        }
        // The player throws from addEventListener for unknown event names,
        // and its error event is named "error" (not "errored").
        player.addEventListener("error", () => {
          if (live()) {
            onError("asciinema player failed to initialize this recording");
          }
        });
        onPlayer(player);
      } catch (error) {
        if (cancelled) {
          return;
        }
        onError(
          error instanceof Error
            ? error.message
            : "failed to initialize cast replay",
        );
      }
    };

    void mountPlayer();

    return () => {
      cancelled = true;
      const player = playerRef.current;
      playerRef.current = null;
      if (player) saveRestore();
      player?.dispose?.();
      onPlayer(null);
    };
  }, [
    content,
    fit,
    fontSize,
    speed,
    custom,
    onPlayer,
    onEvent,
    saveRestore,
    restoreInto,
    onReady,
    onError,
  ]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "run-artifact-player w-full",
        custom
          ? "replay-custom h-full"
          : "overflow-hidden [&_.ap-player]:w-full",
        fit === "none" && "replay-scroll",
      )}
    />
  );
});
