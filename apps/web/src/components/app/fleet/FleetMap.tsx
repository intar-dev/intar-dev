// The fleet map: one SVG world background and one HTML button for each placed
// agent host. Pins are buttons so a keyboard user reaches every host, and every
// fact on a pin also lives in the host list, so the map never hides a host.

import { cn } from "@/lib/utils";
import type { HostHealth } from "@/lib/host-health";
import {
  HOST_STATE_DETAILS,
  HOST_STATES,
  formatCpuMillis,
  formatHostState,
  formatLocation,
  formatMemoryMib,
  formatPendingNote,
  formatPlaceLabel,
  formatStalledNote,
  formatTruncatedNote,
  formatUnlocatedNote,
} from "./format";
import { providerMark } from "./providers";
import { layoutMapPins } from "./projection";
import type { FleetMapHost } from "./types";
import { useMapMetrics } from "./useMapMetrics";
import { WORLD_MAP_LAND_PATH, WORLD_MAP_VIEWBOX } from "./world-map-path";

/**
 * A quiet map: normal operation stays neutral, and the rust action color is
 * reserved for the selected host, so selection is never confused with state.
 */
const PIN_STATE_CLASS_NAME: Record<HostHealth, string> = {
  healthy: "bg-success",
  degraded: "bg-warning",
  unknown: "bg-muted-foreground",
};

/** Matches the hover preview's `max-w-44`, so the edge math and the style agree. */
const LABEL_MAX_WIDTH_PX = 176;

export function FleetMap({
  hosts,
  selectedIndex,
  onSelect,
  unlocatedHostCount,
  pendingHostCount,
  pendingStalled,
  truncatedHostCount,
}: {
  hosts: readonly FleetMapHost[];
  /** Snapshot index of the selected host, or null. */
  selectedIndex: number | null;
  /**
   * Selects a host, or clears the selection with null. The origin is the
   * control the reader selected from, so a clear can return focus to it.
   */
  onSelect: (index: number | null, origin?: HTMLElement | null) => void;
  unlocatedHostCount: number;
  pendingHostCount: number;
  pendingStalled: boolean;
  truncatedHostCount: number;
}) {
  const [mapRef, metrics] = useMapMetrics();
  const pins = layoutMapPins(hosts, metrics);

  return (
    <figure className="min-w-0 space-y-3">
      <div
        ref={mapRef}
        className="relative w-full rounded-xl border bg-card"
        style={{ aspectRatio: "360 / 150" }}
        onClick={() => onSelect(null)}
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

        {/* The fleet arrives once per page load, so the list index names the
            pin and the details that belong to it. */}
        {hosts.map((host, index) => {
          const pin = pins[index];
          if (!pin) return null;
          const selected = index === selectedIndex;
          // A label above a pin in the top band would leave the map box.
          const labelBelow = pin.topPercent < 20;
          // A centered preview would leave the map box at either edge, so
          // near an edge it aligns to its pin instead of centering.
          const leftPx = (pin.leftPercent / 100) * metrics.widthPx;
          const labelAtStart =
            metrics.widthPx > 0 && leftPx < LABEL_MAX_WIDTH_PX / 2;
          const labelAtEnd =
            metrics.widthPx > 0 &&
            metrics.widthPx - leftPx < LABEL_MAX_WIDTH_PX / 2;
          return (
            <div
              key={`${host.latitude}:${host.longitude}:${index}`}
              className="absolute"
              style={{
                left: `${pin.leftPercent}%`,
                top: `${pin.topPercent}%`,
              }}
            >
              {selected ? (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary"
                />
              ) : null}
              <button
                type="button"
                aria-label={pinLabel(host)}
                aria-current={selected ? "true" : undefined}
                // The page returns focus to this pin when the control that
                // made the selection has left the page, as a filter can do.
                data-fleet-pin-index={index}
                className="group absolute size-6 -translate-x-1/2 -translate-y-1/2 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                onClick={(event) => {
                  // The map box itself clears the selection.
                  event.stopPropagation();
                  onSelect(index, event.currentTarget);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") onSelect(null);
                }}
              >
                {/* A pointer preview only: the place name, not the whole card.
                    The card belongs to the selection, which persists. */}
                <span
                  aria-hidden="true"
                  className={cn(
                    // The preview is pointer-transparent: it must never take
                    // a click that belongs to the pin it happens to cover.
                    "pointer-events-none absolute hidden max-w-44 truncate rounded-md border bg-popover px-1.5 py-0.5 text-caption font-semibold text-popover-foreground shadow-xs group-hover:block",
                    labelBelow ? "top-full mt-1" : "bottom-full mb-1",
                    labelAtStart
                      ? "left-0"
                      : labelAtEnd
                        ? "right-0"
                        : "left-1/2 -translate-x-1/2",
                  )}
                >
                  {formatPlaceLabel(host.city, host.country)}
                </span>
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute inset-0 m-auto size-3.5 rounded-full border-2 border-background transition-transform group-hover:scale-125",
                    PIN_STATE_CLASS_NAME[host.state],
                  )}
                />
              </button>
            </div>
          );
        })}
      </div>

      <figcaption className="space-y-2">
        <ul className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {HOST_STATES.map((state) => (
            <li key={state} className="flex items-center gap-2 text-caption">
              <span
                aria-hidden="true"
                className={cn(
                  "size-2.5 shrink-0 rounded-full border border-background",
                  PIN_STATE_CLASS_NAME[state],
                )}
              />
              <span className="font-semibold text-foreground">
                {formatHostState(state)}
              </span>
              {HOST_STATE_DETAILS[state]}
            </li>
          ))}
        </ul>
        {unlocatedHostCount > 0 ||
        pendingHostCount > 0 ||
        truncatedHostCount > 0 ? (
          <ul className="flex flex-wrap items-center gap-x-5 gap-y-1">
            {unlocatedHostCount > 0 ? (
              <li className="text-caption">
                {formatUnlocatedNote(unlocatedHostCount)}
              </li>
            ) : null}
            {pendingHostCount > 0 ? (
              <li className="text-caption">
                {pendingStalled
                  ? formatStalledNote(pendingHostCount)
                  : formatPendingNote(pendingHostCount)}
              </li>
            ) : null}
            {truncatedHostCount > 0 ? (
              <li className="text-caption">
                {formatTruncatedNote(truncatedHostCount)}
              </li>
            ) : null}
          </ul>
        ) : null}
      </figcaption>
    </figure>
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
