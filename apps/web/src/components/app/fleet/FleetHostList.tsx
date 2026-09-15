import {
  formatCpuMillis,
  formatHostState,
  formatLocation,
  formatMemoryMib,
} from "./format";
import { providerMark } from "./providers";
import type { FleetMapHost } from "./types";

/**
 * Every placed host, in list form. The map is a picture of where the fleet
 * runs; this list is how a reader reaches each host when pins crowd on a small
 * screen, and it is the surface a screen reader can walk through.
 */
export function FleetHostList({ hosts }: { hosts: readonly FleetMapHost[] }) {
  return (
    <section className="space-y-2">
      <h2 className="text-label">Every placed agent host</h2>
      <ul className="divide-y overflow-hidden rounded-xl border bg-card">
        {hosts.map((host, index) => {
          const mark = providerMark(host.provider);
          return (
            <li
              key={`${host.latitude}:${host.longitude}:${index}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3"
            >
              <span className="text-support font-semibold">
                {formatLocation(host.city, host.country)}
              </span>
              <span className="text-caption">{formatHostState(host.state)}</span>
              {host.cpuMillis === null && host.memoryMib === null ? (
                // Two bare "Not reported" cells read as one broken value.
                <span className="ml-auto text-caption">
                  Capacity not reported
                </span>
              ) : (
                <span className="ml-auto flex items-center gap-3 text-support tabular-nums">
                  <span>{formatCpuMillis(host.cpuMillis)}</span>
                  <span className="text-muted-foreground">
                    {formatMemoryMib(host.memoryMib)}
                  </span>
                </span>
              )}
              {mark ? (
                <img
                  src={mark.src}
                  width={mark.width}
                  height={mark.height}
                  alt={mark.label}
                  className={mark.className}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
