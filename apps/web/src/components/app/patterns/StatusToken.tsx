import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { formatClockSeconds } from "../lib/format";

export type StatusTone = "pending" | "live" | "success" | "danger" | "muted";

// The fill and the live ring both follow currentColor, so a tone change fades
// them together.
const DOT_TONES: Record<StatusTone, string> = {
  pending: "text-warning",
  live: "text-primary",
  success: "text-success",
  danger: "text-destructive",
  muted: "text-faint-foreground",
};

interface StatusTokenProps {
  tone: StatusTone;
  /** Always visible — state is never conveyed by the dot color alone. */
  word: string;
  /** Short visible label below 640px; assistive technology still gets one word. */
  compactWord?: string;
  /**
   * Every word this token can show. They stack in one box sized for the
   * longest, so a change swaps in place and the clock beside it never moves.
   */
  words?: readonly string[];
  /** Preformatted static elapsed/duration text. */
  elapsed?: string | null;
  /** Self-ticking clock; freezes at frozenMs when set. Overrides `elapsed`. */
  clock?: { startedAt: number; frozenMs?: number | null } | undefined;
  /** The one live or becoming state in a view — a soft ring, never a blink. */
  pulse?: boolean;
  /**
   * Announce word changes to screen readers. Reserve for THE one live status
   * per view (the app bar token) — list rows stay silent.
   */
  live?: boolean;
  className?: string;
}

// The one live-status primitive: dot + word (+ optional clock). Used in the
// app bar, run rows, and scenario cards so status always reads the same way.
export function StatusToken({
  tone,
  word,
  compactWord,
  words,
  elapsed,
  clock,
  pulse = false,
  live = false,
  className,
}: StatusTokenProps) {
  // The Moment Rule: a clock that is there when the token mounts (a page load,
  // a list row) stays still; one that appears after, as a run starts, fades in.
  const [arrivedWithTime] = useState(() => Boolean(clock) || Boolean(elapsed));
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <span
        aria-hidden="true"
        data-pulse={pulse ? "live" : undefined}
        className={cn(
          "size-2 shrink-0 rounded-full bg-current transition-colors duration-(--duration-reveal) ease-standard",
          DOT_TONES[tone],
          pulse && "motion-safe:animate-live",
        )}
      />
      {/* One announcer for the app bar token. The visible word may be a stack
          of hidden layers, so it is not the live region itself. */}
      {live ? (
        <span role="status" className="sr-only">
          {word}
        </span>
      ) : null}
      <span
        aria-hidden={live || undefined}
        className="min-w-0 truncate text-[0.8125rem] font-medium text-foreground"
      >
        {words && words.length > 1 ? (
          <span data-swap style={{ justifyItems: "start" }}>
            {(words.includes(word) ? words : [...words, word]).map((w) => (
              <span
                key={w}
                data-on={w === word ? "" : undefined}
                className="whitespace-nowrap"
              >
                {w}
              </span>
            ))}
          </span>
        ) : compactWord ? (
          <>
            <span className="sm:hidden">{compactWord}</span>
            <span className="hidden sm:inline">{word}</span>
          </>
        ) : (
          word
        )}
      </span>
      {clock ? (
        <TickingClock
          startedAt={clock.startedAt}
          frozenMs={clock.frozenMs}
          fadeIn={!arrivedWithTime}
        />
      ) : elapsed ? (
        <span className={cn(TIME_CLASS, !arrivedWithTime && FADE_IN)}>
          {elapsed}
        </span>
      ) : null}
    </span>
  );
}

const TIME_CLASS = "font-mono text-xs text-faint-foreground tabular-nums";
const FADE_IN = "animate-in fade-in-0 duration-(--duration-moderate) ease-enter";

// Isolated so the 1s interval re-renders only this span, not the caller.
function TickingClock(props: {
  startedAt: number;
  frozenMs?: number | null | undefined;
  fadeIn: boolean;
}) {
  const frozen = props.frozenMs != null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (frozen) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [frozen]);

  const seconds = frozen
    ? Math.max(0, Math.floor((props.frozenMs ?? 0) / 1000))
    : Math.max(0, Math.floor((now - props.startedAt) / 1000));

  return (
    // Read on demand, never announced: it sits outside the status region.
    <span className={cn(TIME_CLASS, props.fadeIn && FADE_IN)}>
      {formatClockSeconds(seconds)}
    </span>
  );
}
