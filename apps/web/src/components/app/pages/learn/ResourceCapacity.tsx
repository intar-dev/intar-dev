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
    <section aria-labelledby={titleId} className="space-y-3 border-b pb-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={titleId} className="text-sm font-semibold">Available for new runs</h2>
        {updateFailed ? (
          <p role="status" className="text-caption text-muted-foreground">
            Update failed · {capacity ? "Showing last values" : "Try again shortly"}
          </p>
        ) : null}
      </div>
      {capacity ? (
        <div className="grid gap-4 sm:grid-cols-2 sm:gap-8">
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
    <div className="min-w-0 space-y-2">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span id={labelId} className="font-medium">{label}</span>
        <span className="tabular-nums text-brand-text">{percent.format(fraction * 100)}% available</span>
      </div>
      <div
        role="meter"
        aria-labelledby={labelId}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={fraction * 100}
        aria-valuetext={`${percent.format(fraction * 100)}% available, ${valueText}`}
        className="grid h-2 grid-cols-20 gap-1"
      >
        {Array.from({ length: 20 }, (_, index) => (
          <span key={index} aria-hidden="true" className="overflow-hidden rounded-xs bg-border">
            <span
              className="block h-full origin-left bg-brand-text transition-transform duration-250 ease-out motion-reduce:transition-none"
              style={{ transform: `scaleX(${Math.max(0, Math.min(1, fraction * 20 - index))})` }}
            />
          </span>
        ))}
      </div>
      <p className="text-caption tabular-nums text-muted-foreground">{valueText}</p>
    </div>
  );
}
