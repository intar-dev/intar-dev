import { useEffect, useState } from "react";
import { Clock3 } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCountdown, leaseInfo, type LeaseState } from "@/lib/run-lease";

const TONE: Record<LeaseState, string> = {
  ok: "text-muted-foreground",
  warning: "text-warning",
  critical: "text-destructive motion-safe:animate-pulse",
  expired: "text-destructive",
};

// Keep the lease clock isolated so its one-second tick does not re-render the
// scenario page or replace the page chrome registration.
export function LeaseCountdown({
  deadlineMs,
  className,
}: {
  deadlineMs: number | null;
  className?: string;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (deadlineMs === null) return;
    return startLeaseCountdown(deadlineMs, setNow);
  }, [deadlineMs]);

  if (deadlineMs === null) return null;
  const info = leaseInfo(deadlineMs, now);
  const countdown = formatCountdown(info.remainingMs);

  return (
    <span
      aria-label={
        info.state === "expired"
          ? "Sandbox lease expired"
          : `Time remaining: ${countdown}`
      }
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap text-xs tabular-nums",
        TONE[info.state],
        className,
      )}
      data-run-lease-countdown
      role="timer"
      title="Time remaining before this sandbox is torn down"
    >
      <Clock3 className="size-3.5" aria-hidden="true" />
      {info.state === "expired" ? (
        <span data-run-lease-countdown-text>Lease expired</span>
      ) : (
        <span data-run-lease-countdown-text>
          {countdown}
          <span className="hidden sm:inline"> left</span>
        </span>
      )}
    </span>
  );
}

export function startLeaseCountdown(
  deadlineMs: number,
  onTick: (now: number) => void,
) {
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  let stopped = false;

  const tick = () => {
    const current = Date.now();
    onTick(current);
    const remaining = deadlineMs - current;
    if (!stopped && remaining > 0) {
      timeout = globalThis.setTimeout(tick, Math.min(1_000, remaining));
    }
  };

  tick();
  return () => {
    stopped = true;
    if (timeout !== undefined) globalThis.clearTimeout(timeout);
  };
}
