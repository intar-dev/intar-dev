import { cn } from "@/lib/utils";
import {
  formatCpuMillis,
  formatHostState,
  formatLocation,
  formatMemoryMib,
} from "./format";
import { providerMark } from "./providers";
import type { FleetMapHost } from "./types";

/**
 * Every placed host in list form, aligned so two hosts compare at a glance.
 *
 * The map is a picture of where the fleet runs. This list is how a reader
 * reaches each host when pins crowd on a small screen, and it is the surface a
 * screen reader can walk through. A row selects the same host as its pin.
 */
export function FleetHostList({
  hosts,
  indices,
  selectedIndex,
  onSelect,
  emptyMessage,
}: {
  hosts: readonly FleetMapHost[];
  /** Snapshot indices to show, in snapshot order. */
  indices: readonly number[];
  selectedIndex: number | null;
  /** Selects a host; the origin lets a clear return focus to its row. */
  onSelect: (index: number | null, origin?: HTMLElement | null) => void;
  emptyMessage: string;
}) {
  if (!indices.length) {
    return <p className="text-metadata">{emptyMessage}</p>;
  }

  return (
    <ul className="divide-y overflow-hidden rounded-xl border bg-card">
      {indices.map((index) => {
        const host = hosts[index];
        if (!host) return null;
        const mark = providerMark(host.provider);
        const selected = index === selectedIndex;
        return (
          <li key={`${host.latitude}:${host.longitude}:${index}`}>
            <button
              type="button"
              aria-current={selected ? "true" : undefined}
              onClick={(event) => onSelect(index, event.currentTarget)}
              onKeyDown={(event) => {
                // A row clears the selection with Escape, like its pin.
                if (event.key === "Escape") onSelect(null);
              }}
              className={cn(
                "flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left transition-colors",
                "hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none",
                selected && "bg-brand-subtle",
              )}
            >
              <span className="min-w-0 flex-1 basis-40 truncate text-support font-semibold">
                {formatLocation(host.city, host.country)}
              </span>
              <span className="text-caption sm:w-32">
                {formatHostState(host.state)}
              </span>
              {host.cpuMillis === null && host.memoryMib === null ? (
                // Two bare "Not reported" cells read as one broken value.
                <span className="text-caption sm:w-44 sm:text-right">
                  Capacity not reported
                </span>
              ) : (
                <>
                  <span className="text-support tabular-nums sm:w-20 sm:text-right">
                    {formatCpuMillis(host.cpuMillis)}
                  </span>
                  <span className="text-support tabular-nums text-muted-foreground sm:w-24 sm:text-right">
                    {formatMemoryMib(host.memoryMib)}
                  </span>
                </>
              )}
              {mark ? (
                <img
                  src={mark.src}
                  width={mark.width}
                  height={mark.height}
                  alt={mark.label}
                  className={cn(mark.className, "sm:ml-auto")}
                />
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
