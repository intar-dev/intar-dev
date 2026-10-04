import { useRef, useState, useEffect, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface StatProps {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  /** `lg` = page-level KPI tile; `sm` = flat inline tile inside a card. */
  size?: "lg" | "sm";
  /** Announce a changed detail politely. Not for polled tiles. */
  announce?: boolean;
  className?: string;
}

// The detail's words rise into place when they change after mount, inside a
// <p> that stays mounted (so it can be a live region). First render is still.
function StatDetail({
  detail,
  announce,
  className,
}: {
  detail: ReactNode;
  announce: boolean;
  className: string;
}) {
  const key = typeof detail === "string" ? detail : null;
  const previous = useRef(key);
  const [swaps, setSwaps] = useState(0);
  useEffect(() => {
    if (key === null || previous.current === key) return;
    previous.current = key;
    setSwaps((count) => count + 1);
  }, [key]);
  return (
    <p className={className} aria-live={announce ? "polite" : undefined}>
      <span key={swaps} className={cn(swaps > 0 && "roll-in inline-block")}>
        {detail}
      </span>
    </p>
  );
}

// The one stat tile. `lg` carries page KPIs on the card idiom; `sm` is the
// flat tier for metric strips nested inside cards.
export function Stat({
  label,
  value,
  detail,
  size = "lg",
  announce = false,
  className,
}: StatProps) {
  if (size === "sm") {
    return (
      <div className={cn("rounded-xl bg-muted/50 px-4 py-3", className)}>
        <p className="text-caption">{label}</p>
        <p className="mt-1 text-metadata font-semibold text-foreground">{value}</p>
        {detail ? (
          <StatDetail
            detail={detail}
            announce={announce}
            className="text-caption mt-0.5"
          />
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-xl border bg-card p-5 shadow-xs",
        className,
      )}
    >
      <p className="text-label">{label}</p>
      <p className="mt-1 text-page-title">
        {value}
      </p>
      {detail ? (
        <StatDetail
          detail={detail}
          announce={announce}
          className="mt-1 text-sm text-muted-foreground"
        />
      ) : null}
    </div>
  );
}
