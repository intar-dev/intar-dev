import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { formatClockSeconds } from "../lib/format";

export type StatusTone = "pending" | "live" | "success" | "danger" | "muted";

const DOT_TONES: Record<StatusTone, string> = {
  pending: "bg-warning",
  live: "bg-primary",
  success: "bg-success",
  danger: "bg-destructive",
  muted: "bg-muted-foreground",
};

interface StatusTokenProps {
  tone: StatusTone;
  /** Always visible — state is never conveyed by the dot color alone. */
  word: string;
  /** Short visible label below 640px; assistive technology still gets one word. */
  compactWord?: string;
  /** Preformatted static elapsed/duration text. */
  elapsed?: string | null;
  /** Self-ticking clock; freezes at frozenMs when set. Overrides `elapsed`. */
  clock?: { startedAt: number; frozenMs?: number | null } | undefined;
  /** Amber "becoming" states only — at most one pulsing element per view. */
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
  elapsed,
  clock,
  pulse = false,
  live = false,
  className,
}: StatusTokenProps) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <span
        aria-hidden="true"
        className={cn(
          "size-2 shrink-0 rounded-full",
          DOT_TONES[tone],
          pulse && "motion-safe:animate-pulse",
        )}
      />
      <span
        role={live ? "status" : undefined}
        className="truncate text-sm font-medium"
      >
        {compactWord ? (
          <>
            <span className="sm:hidden">{compactWord}</span>
            <span className="hidden sm:inline">{word}</span>
          </>
        ) : (
          word
        )}
      </span>
      {clock ? (
        <TickingClock startedAt={clock.startedAt} frozenMs={clock.frozenMs} />
      ) : elapsed ? (
        <span
          aria-hidden="true"
          className="font-mono text-xs text-muted-foreground tabular-nums"
        >
          {elapsed}
        </span>
      ) : null}
    </span>
  );
}

// Isolated so the 1s interval re-renders only this span, not the caller.
function TickingClock(props: {
  startedAt: number;
  frozenMs?: number | null | undefined;
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
    <span
      aria-hidden="true"
      className="font-mono text-xs text-muted-foreground tabular-nums"
    >
      {formatClockSeconds(seconds)}
    </span>
  );
}
