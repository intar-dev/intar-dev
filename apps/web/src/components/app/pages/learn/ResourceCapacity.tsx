import { useId } from "react";
import type { ResourceCapacity as Capacity } from "@/lib/resource-capacity";

const amount = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });
const percent = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

export function ResourceCapacity({
  capacity,
  updateFailed = false,
}: {
  capacity: Capacity | null;
  updateFailed?: boolean;
}) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={titleId} className="text-card-title">Available for new runs</h2>
        {updateFailed ? (
          <p role="status" className="text-caption text-muted-foreground">
            Update failed · {capacity ? "Showing last values" : "Try again shortly"}
          </p>
        ) : null}
      </div>
      {capacity ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <CapacityMeter label="CPU" available={capacity.cpu.availableMillis} total={capacity.cpu.totalMillis} divisor={1000} unit="vCPUs" />
          <CapacityMeter label="Memory" available={capacity.memory.availableMib} total={capacity.memory.totalMib} divisor={1024} unit="GiB" />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Capacity unavailable</p>
      )}
    </section>
  );
}

function CapacityMeter({ label, available, total, divisor, unit }: {
  label: string;
  available: number;
  total: number;
  divisor: number;
  unit: string;
}) {
  const labelId = useId();
  const value = total > 0 ? Math.max(0, Math.min(available, total)) : 0;
  const fraction = total > 0 ? value / total : 0;
  const valueText = `${amount.format(value / divisor)} / ${amount.format(total / divisor)} ${unit}`;
  return (
    <div className="min-w-0 space-y-3 rounded-xl border bg-card p-4 shadow-[var(--highlight),var(--shadow-raised)]">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span id={labelId} className="font-medium">{label}</span>
        <span className="font-medium tabular-nums text-success">{percent.format(fraction * 100)}% available</span>
      </div>
      <div
        role="meter"
        aria-labelledby={labelId}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={fraction * 100}
        aria-valuetext={`${percent.format(fraction * 100)}% available, ${valueText}`}
        className="h-1.5 overflow-hidden rounded-full bg-muted dark:bg-accent"
      >
        <span
          aria-hidden="true"
          className="block h-full origin-left rounded-full bg-success transition-transform duration-500 ease-enter motion-safe:animate-meter motion-reduce:transition-none"
          style={{ transform: `scaleX(${Math.max(0, Math.min(1, fraction))})` }}
        />
      </div>
      <p className="text-caption tabular-nums">{valueText}</p>
    </div>
  );
}
