import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface StatProps {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  /** `lg` = page-level KPI tile; `sm` = flat inline tile inside a card. */
  size?: "lg" | "sm";
  className?: string;
}

// The one stat tile. `lg` carries page KPIs on the card idiom; `sm` is the
// flat tier for metric strips nested inside cards.
export function Stat({ label, value, detail, size = "lg", className }: StatProps) {
  if (size === "sm") {
    return (
      <div className={cn("rounded-xl bg-muted/50 px-4 py-3", className)}>
        <p className="text-caption">{label}</p>
        <p className="mt-1 text-sm font-semibold">{value}</p>
        {detail ? <p className="text-caption mt-0.5">{detail}</p> : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-2xl border bg-card px-4 py-4 shadow-xs",
        className,
      )}
    >
      <p className="text-eyebrow">{label}</p>
      <p className="mt-2 font-heading text-2xl font-bold tracking-tight">
        {value}
      </p>
      {detail ? (
        <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
      ) : null}
    </div>
  );
}
