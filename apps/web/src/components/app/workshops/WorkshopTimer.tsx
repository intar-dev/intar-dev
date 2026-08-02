import { useEffect, useMemo, useState } from "react";
import { Timer } from "lucide-react";
import type { WorkshopTimer as WorkshopTimerState } from "./types";
import { cn } from "@/lib/utils";

export function WorkshopTimer({
  timer,
  size = "default",
}: {
  timer: WorkshopTimerState | null;
  size?: "default" | "large" | "projector";
}) {
  const paused = timer?.pausedAt != null;
  const [now, setNow] = useState(() => Date.now());
  const clientClockOffsetMs = useMemo(
    () => workshopTimerClientClockOffsetMs(timer, Date.now()),
    [timer?.observedAt],
  );

  useEffect(() => {
    setNow(Date.now());
    if (!timer || paused) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [paused, timer?.observedAt]);

  const remainingMs = workshopTimerRemainingMs(
    timer,
    now - clientClockOffsetMs,
  );

  if (remainingMs == null) {
    return (
      <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
        <Timer className="size-4" aria-hidden="true" />
        Timer not started
      </span>
    );
  }

  const totalSeconds = Math.ceil(remainingMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const label = `${minutes}:${String(seconds).padStart(2, "0")}`;

  return (
    <span
      role="timer"
      aria-label={`${label} remaining${paused ? ", paused" : ""}`}
      className={cn(
        "inline-flex items-center gap-2 font-mono font-semibold tabular-nums",
        remainingMs === 0 ? "text-destructive" : "text-foreground",
        size === "default" && "text-base",
        size === "large" && "text-2xl sm:text-3xl",
        size === "projector" && "text-4xl sm:text-6xl",
      )}
    >
      <Timer
        className={cn(size === "projector" ? "size-8 sm:size-11" : "size-5")}
        aria-hidden="true"
      />
      {label}
      {paused ? (
        <span className="font-sans text-xs font-medium tracking-normal text-muted-foreground">
          paused
        </span>
      ) : null}
    </span>
  );
}

export function workshopTimerClientClockOffsetMs(
  timer: WorkshopTimerState | null,
  clientObservedAt: number,
): number {
  return timer ? clientObservedAt - timer.observedAt : 0;
}

export function workshopTimerRemainingMs(
  timer: WorkshopTimerState | null,
  serverNow: number,
): number | null {
  if (!timer) return null;
  if (
    timer.remainingMs != null &&
    (timer.pausedAt != null || !timer.endsAt)
  ) {
    return Math.max(0, timer.remainingMs);
  }
  if (timer.endsAt != null) return Math.max(0, timer.endsAt - serverNow);
  return timer.remainingMs == null ? null : Math.max(0, timer.remainingMs);
}
