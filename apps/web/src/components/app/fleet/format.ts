// Display helpers for the fleet map. Every value has a word, so a reader never
// depends on a color or an icon alone.

import type { HostHealth } from "@/lib/host-health";

export const HOST_STATE_LABELS: Record<HostHealth, string> = {
  healthy: "Healthy",
  degraded: "Report out of date",
  unknown: "No report",
};

export function formatHostState(state: HostHealth): string {
  return HOST_STATE_LABELS[state];
}

export function formatLocation(
  city: string | null,
  country: string | null,
): string {
  const parts = [city, country].filter(
    (part): part is string => part !== null && part.trim().length > 0,
  );
  return parts.length ? parts.join(", ") : "Unknown location";
}

export function formatCpuMillis(cpuMillis: number | null): string {
  if (cpuMillis === null) return "Not reported";
  return `${formatNumber(cpuMillis / 1000)} vCPU`;
}

export function formatMemoryMib(memoryMib: number | null): string {
  if (memoryMib === null) return "Not reported";
  return `${formatNumber(memoryMib / 1024)} GiB`;
}

export function formatHostNameCount(count: number): string {
  return count === 1 ? "1 agent host" : `${count} agent hosts`;
}

export function formatPlaceCount(count: number): string {
  return count === 1 ? "1 place" : `${count} places`;
}

export function formatUnlocatedNote(count: number): string {
  return count === 1
    ? "1 agent host has no location yet."
    : `${count} agent hosts have no location yet.`;
}

export function formatPendingNote(count: number): string {
  return count === 1
    ? "1 agent host is still being placed."
    : `${count} agent hosts are still being placed.`;
}

export function formatTruncatedNote(count: number): string {
  return count === 1
    ? "1 agent host is beyond the map read limit and is not shown."
    : `${count} agent hosts are beyond the map read limit and are not shown.`;
}

export function formatStalledNote(count: number): string {
  const hosts = count === 1 ? "1 agent host is" : `${count} agent hosts are`;
  return `${hosts} still being placed. Reload the page for the rest.`;
}

/** One decimal, and no trailing zero: 64 vCPU reads better than 64.0 vCPU. */
function formatNumber(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
