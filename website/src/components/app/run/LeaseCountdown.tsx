import { useEffect, useState } from "react";
import { Clock3 } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCountdown, leaseInfo, type LeaseState } from "@/lib/run-lease";

const TONE: Record<LeaseState, string> = {
  ok: "text-muted-foreground",
  warning: "text-amber-600 dark:text-amber-400",
  critical: "text-destructive motion-safe:animate-pulse",
  expired: "text-destructive",
};

// A live 1s-ticking lease countdown. `deadlineMs` is null when the run has no
// lease info (e.g. finished runs) — in that case the component renders nothing.
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
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [deadlineMs]);

  if (deadlineMs === null) return null;
  const info = leaseInfo(deadlineMs, now);

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-sm tabular-nums",
        TONE[info.state],
        className,
      )}
      title="Time remaining before this sandbox is torn down"
    >
      <Clock3 className="size-3.5" />
      {info.state === "expired" ? (
        <span>Lease expired</span>
      ) : (
        <span>{formatCountdown(info.remainingMs)}</span>
      )}
    </span>
  );
}
