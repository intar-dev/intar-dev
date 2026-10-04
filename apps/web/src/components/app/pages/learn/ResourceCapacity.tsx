import { useEffect, useId, useRef, useState } from "react";
import type { ResourceCapacity as Capacity } from "@/lib/resource-capacity";
import { MetaLine } from "@/components/app/patterns/MetaLine";
import { RollingNumber } from "@/components/app/patterns/RollingNumber";
import { useJustReached } from "@/components/app/patterns/use-just-reached";
import { cn } from "@/lib/utils";

const amount = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });
const round3 = (value: number) => Math.round(value * 1000) / 1000;

export function ResourceCapacity({
  capacity,
  updateFailed = false,
  animateArrival = true,
}: {
  capacity: Capacity | null;
  updateFailed?: boolean;
  /** False when cached data is already on screen: the fills mount still. */
  animateArrival?: boolean;
}) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={titleId} className="text-card-title">Available for new runs</h2>
        {/* Always mounted: only its text changes, so screen readers announce it. */}
        <p role="status" className="text-caption text-muted-foreground">
          <MetaLine
            as="span"
            items={
              updateFailed
                ? ["Update failed", capacity ? "Showing last values" : null]
                : []
            }
          />
        </p>
      </div>
      {capacity ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <CapacityMeter label="CPU" available={capacity.cpu.availableMillis} total={capacity.cpu.totalMillis} divisor={1000} unit="vCPUs" animateArrival={animateArrival} />
          <CapacityMeter label="Memory" available={capacity.memory.availableMib} total={capacity.memory.totalMib} divisor={1024} unit="GiB" animateArrival={animateArrival} />
        </div>
      ) : (
        <p className="text-support text-muted-foreground">Capacity unavailable</p>
      )}
    </section>
  );
}

function CapacityMeter({ label, available, total, divisor, unit, animateArrival }: {
  label: string;
  available: number;
  total: number;
  divisor: number;
  unit: string;
  animateArrival: boolean;
}) {
  const labelId = useId();
  const value = total > 0 ? Math.max(0, Math.min(available, total)) : 0;
  const fraction = total > 0 ? value / total : 0;
  const pct = Math.round(fraction * 1000) / 10;
  const low = total > 0 && pct < 20;
  const shown = round3(value / divisor);
  const shownTotal = round3(total / divisor);
  const valueText = `${amount.format(shown)} / ${amount.format(shownTotal)} ${unit}`;
  // The arrival fill plays once; later changes glide as a transition, which a
  // finished `fill: both` animation would otherwise block.
  const [arriving, setArriving] = useState(animateArrival);
  const firstFraction = useRef(true);
  useEffect(() => {
    if (firstFraction.current) {
      firstFraction.current = false;
      return;
    }
    setArriving(false);
  }, [fraction]);
  const justLow = useJustReached([[label, low ? "low" : "ok"]], "low").has(label);
  return (
    <div className="min-w-0 space-y-3 rounded-xl border bg-card p-4 shadow-[var(--highlight),var(--shadow-raised)]">
      <div className="flex items-baseline justify-between gap-3 text-support">
        <span id={labelId} className="font-medium">{label}</span>
        <span
          className={cn(
            "font-medium tabular-nums transition-colors duration-(--duration-reveal) ease-standard",
            low ? "text-warning" : "text-success",
          )}
        >
          <RollingNumber value={pct} />% available
          {low ? (
            <span className={cn("inline-block whitespace-pre", justLow && "catalog-swap")}>{" · Low"}</span>
          ) : null}
        </span>
      </div>
      <div
        role="meter"
        aria-labelledby={labelId}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={fraction * 100}
        aria-valuetext={`${pct}% available${low ? ", low" : ""}, ${valueText}`}
        className="h-1.5 overflow-hidden rounded-full bg-muted dark:bg-accent"
      >
        <span
          aria-hidden="true"
          className={cn(
            "block h-full origin-left rounded-full transition-[transform,background-color] duration-(--duration-reveal) ease-enter motion-reduce:transition-[background-color]",
            low ? "bg-warning" : "bg-success",
            arriving && "motion-safe:animate-meter",
          )}
          onAnimationEnd={() => setArriving(false)}
          style={{ transform: `scaleX(${Math.max(0, Math.min(1, fraction))})` }}
        />
      </div>
      <p className="text-caption tabular-nums">
        <RollingNumber value={shown} /> / <RollingNumber value={shownTotal} /> {unit}
      </p>
    </div>
  );
}
