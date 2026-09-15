// The fleet map: one SVG world background and one HTML button for each placed
// agent host. Pins are buttons so a keyboard user reaches every host, and the
// card is decoration: its facts also live in the button label.

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { HostHealth } from "@/lib/host-health";
import {
  formatCpuMillis,
  formatHostState,
  formatLocation,
  formatMemoryMib,
  formatPendingNote,
  formatStalledNote,
  formatTruncatedNote,
  formatUnlocatedNote,
} from "./format";
import { layoutMapPins } from "./projection";
import { providerMark } from "./providers";
import type { FleetMapHost } from "./types";
import { WORLD_MAP_LAND_PATH, WORLD_MAP_VIEWBOX } from "./world-map-path";
import { useMapMetrics } from "./useMapMetrics";

/** Half of the card width (`w-60`), used to keep the card inside the box. */
const CARD_HALF_WIDTH_REM = 7.5;

const PIN_STATE_CLASS_NAME: Record<HostHealth, string> = {
  healthy: "bg-primary",
  degraded: "bg-warning",
  unknown: "bg-muted-foreground",
};

const LEGEND: ReadonlyArray<{ state: HostHealth; detail: string }> = [
  { state: "healthy", detail: "A report arrived in the last minute" },
  { state: "degraded", detail: "The newest report is older than one minute" },
];

export function FleetMap({
  hosts,
  unlocatedHostCount,
  pendingHostCount,
  pendingStalled,
  truncatedHostCount,
}: {
  hosts: readonly FleetMapHost[];
  unlocatedHostCount: number;
  pendingHostCount: number;
  pendingStalled: boolean;
  truncatedHostCount: number;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [mapRef, metrics] = useMapMetrics();
  // A follow-up load can insert a host that sorts before the open pin, and
  // the selection is an index. Close the card instead of showing another
  // host's facts under the reader's cursor.
  useEffect(() => setActiveIndex(null), [hosts]);
  const pins = layoutMapPins(hosts, metrics);
  const active = activeIndex === null ? null : (hosts[activeIndex] ?? null);
  const activePin = activeIndex === null ? null : (pins[activeIndex] ?? null);

  return (
    <figure className="space-y-3">
      <div
        ref={mapRef}
        className="relative w-full rounded-xl border bg-card"
        style={{ aspectRatio: "360 / 150" }}
        onClick={() => setActiveIndex(null)}
        onMouseLeave={() => setActiveIndex(null)}
      >
        <div className="absolute inset-0 overflow-hidden rounded-[inherit]">
          <svg
            aria-hidden="true"
            focusable="false"
            className="size-full"
            viewBox={WORLD_MAP_VIEWBOX}
          >
            <path
              d={WORLD_MAP_LAND_PATH}
              className="fill-muted stroke-border"
              strokeWidth={0.6}
            />
          </svg>
        </div>

        {/* The fleet arrives once per page load, so the list index names
            the pin and the card that belongs to it. */}
        {hosts.map((host, index) => {
          const pin = pins[index];
          if (!pin) return null;
          return (
            <div
              key={`${host.latitude}:${host.longitude}:${index}`}
              className="absolute"
              style={{
                left: `${pin.leftPercent}%`,
                top: `${pin.topPercent}%`,
              }}
            >
              {host.state === "healthy" ? (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/40 motion-safe:animate-ping"
                />
              ) : null}
              <button
                type="button"
                aria-label={pinLabel(host)}
                className={cn(
                  // The hit area is 24px while the pin stays small, so a
                  // finger reaches it without a heavy mark on the map.
                  "group absolute size-6 -translate-x-1/2 -translate-y-1/2 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  // Activation only opens the card. A tap also focuses the
                  // button first, so a toggle here would close it again and
                  // leave a touch user with nothing.
                  setActiveIndex(index);
                }}
                onMouseEnter={() => setActiveIndex(index)}
                onFocus={() => setActiveIndex(index)}
                onBlur={() =>
                  setActiveIndex((current) =>
                    current === index ? null : current,
                  )
                }
                onKeyDown={(event) => {
                  if (event.key === "Escape") setActiveIndex(null);
                }}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute inset-0 m-auto size-3.5 rounded-full border-2 border-background transition-transform group-hover:scale-125 group-focus-visible:scale-125",
                    PIN_STATE_CLASS_NAME[host.state],
                  )}
                />
              </button>
            </div>
          );
        })}

        {active && activePin ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute z-10"
            style={{
              left: `clamp(${CARD_HALF_WIDTH_REM}rem, ${activePin.leftPercent}%, calc(100% - ${CARD_HALF_WIDTH_REM}rem))`,
              top: `${activePin.topPercent}%`,
            }}
          >
            <FleetMapCard
              host={active}
              placement={activePin.topPercent > 60 ? "above" : "below"}
            />
          </div>
        ) : null}
      </div>

      <figcaption className="flex flex-wrap items-center gap-x-5 gap-y-2">
        {LEGEND.map((item) => (
          <span
            key={item.state}
            className="flex items-center gap-2 text-caption"
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-2.5 rounded-full border border-background",
                PIN_STATE_CLASS_NAME[item.state],
              )}
            />
            <span className="font-semibold text-foreground">
              {formatHostState(item.state)}
            </span>
            {item.detail}
          </span>
        ))}
        {unlocatedHostCount > 0 ? (
          <span className="text-caption">
            {formatUnlocatedNote(unlocatedHostCount)}
          </span>
        ) : null}
        {pendingHostCount > 0 ? (
          <span className="text-caption">
            {pendingStalled
              ? formatStalledNote(pendingHostCount)
              : formatPendingNote(pendingHostCount)}
          </span>
        ) : null}
        {truncatedHostCount > 0 ? (
          <span className="text-caption">
            {formatTruncatedNote(truncatedHostCount)}
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}

export function FleetMapCard({
  host,
  placement,
}: {
  host: FleetMapHost;
  placement: "above" | "below";
}) {
  const mark = providerMark(host.provider);
  return (
    <div
      className={cn(
        "w-60 -translate-x-1/2",
        placement === "above" ? "-translate-y-full pb-2" : "pt-2",
      )}
    >
      <div className="space-y-2 rounded-lg border bg-popover p-3 shadow-lg shadow-black/10">
        <div className="space-y-0.5">
          <p className="text-card-title">
            {formatLocation(host.city, host.country)}
          </p>
          <p className="text-caption">{formatHostState(host.state)}</p>
        </div>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-support">
          <dt className="text-caption">CPU</dt>
          <dd className="text-right tabular-nums">
            {formatCpuMillis(host.cpuMillis)}
          </dd>
          <dt className="text-caption">Memory</dt>
          <dd className="text-right tabular-nums">
            {formatMemoryMib(host.memoryMib)}
          </dd>
        </dl>
        {mark ? (
          <div className="flex items-center gap-2 border-t pt-2">
            <span className="text-caption">Infrastructure by</span>
            <img
              src={mark.src}
              width={mark.width}
              height={mark.height}
              alt={mark.label}
              className={mark.className}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function pinLabel(host: FleetMapHost): string {
  const mark = providerMark(host.provider);
  const facts = [
    formatLocation(host.city, host.country),
    formatHostState(host.state),
    `CPU ${formatCpuMillis(host.cpuMillis)}`,
    `memory ${formatMemoryMib(host.memoryMib)}`,
    mark ? `sponsored by ${mark.label}` : null,
  ].filter((fact): fact is string => fact !== null);
  return facts.join(". ");
}
